# GitMini

GitMini is a single-container HTTP service for managing Git repositories.
Organization/repository pairs are the primary namespace; OIDC usernames do not
participate in organization or repository naming.

## Current status

- Docker deployment uses `ghcr.io/cloud-cli/image-node:latest` and `/home/app`.
- `GET /api` serves an OpenAPI 3.0.3 document for the versioned API
  and Git Smart HTTP endpoints; UI-only routes are excluded.
- Organizations and their repositories are scoped to the authenticated OIDC subject.
  Organization slugs are globally unique, lowercase, and case-insensitive on input.
- API and Git credentials require both active OIDC introspection and a local authorization
  record. Introspection scopes are authentication-only and never authorize operations.
  Local capabilities are `repo:read`, `repo:write` (also reads), `org:create`, and
  `org:manage` (delete empty organizations and manage webhook settings). Every local
  credential has explicit organization slug grants; no API/Git token gets owner-wide access.
  Browser sessions retain owner-wide same-origin UI access.
- Git Smart HTTP is available at `/git/<org>/<repo>.git`. Git clients use HTTP Basic auth
  with any username and an active OIDC access token with a local GitMini authorization
  record as the password; fetch needs locally granted `repo:read` (or `repo:write`) and
  push needs locally granted `repo:write`. Git transport never
  falls back to browser sessions. Use HTTPS in deployment; plain HTTP is suitable
  only for local testing.
- Active OIDC access tokens can be bound from an authenticated same-origin browser session with
  `POST /api/v1/token-authorizations` (`token`, `label`, `scopes`, and explicit `orgs`).
  GitMini verifies the active subject matches the caller and stores only SHA-256 of the
  opaque token. Token records can later be edited or revoked without resubmitting it.
  Legacy token records are migrated fail-closed: repository-bound PATs retain only their
  prior organization grant, while formerly owner-wide PATs receive no organization grants
  and must be explicitly edited before use. Unrecognized/malformed records stop startup.
- Browser sign-in identifies an account by the stable OIDC `sub` claim. Username
  claims have no authentication or naming role and are omitted from the UI profile.
  Organization slugs are chosen in GitMini and repositories are routed as
  `/api/v1/orgs/<org>/repos/<repo>` and `/git/<org>/<repo>.git`.
- Organization and repository names are short path-only identifiers. The
  authenticated subject's stable hashed `sub` claim is used for organization ownership
  metadata. Organization metadata lives in `DATA_PATH/orgs/<slug>/.organization.json`;
  repositories live alongside it under `DATA_PATH/orgs/<slug>/<repo>`.
- `npm test` runs a Node-built-in integration suite covering subject isolation,
  unauthorized access, route inventory, traversal rejection, and UI wiring.

### Storage note

The organization and repository directory structure is authoritative. At startup the
service walks `DATA_PATH/orgs` and indexes valid `DATA_PATH/orgs/<slug>/.organization.json`
files; repositories remain at `DATA_PATH/orgs/<slug>/<repo>`. Ownership metadata is the
SHA-256 hash of the OIDC `sub` claim. Existing `organizations.json` registries are migrated
and archived after successful migration.

## Run

```bash
docker build -t gitmini .
docker run --rm -p 3000:3000 \
  -e DATA_PATH=/home/app/data \
  -e OIDC_ISSUER="$OIDC_ISSUER" \
  -e OIDC_CLIENT_ID="$OIDC_CLIENT_ID" \
  -e OIDC_CLIENT_SECRET="$OIDC_CLIENT_SECRET" \
  gitmini
```

For local development:

```bash
npm install
DATA_PATH="$PWD/data" npm start
```

## Endpoints

| Method | Path                                                     | Auth        |
| ------ | -------------------------------------------------------- | ----------- |
| GET    | `/api`                                                   | public      |
| GET    | `/api/v1/health`                                         | public      |
| GET    | `/ui/config`                                             | public      |
| GET    | `/ui/session`                                            | public      |
| GET    | `/ui/auth/login`                                         | public      |
| GET    | `/ui/auth/callback`                                      | OIDC        |
| POST   | `/ui/auth/logout`                                        | OIDC        |
| GET    | `/api/v1/orgs`                                           | OIDC        |
| POST   | `/api/v1/orgs`                                           | OIDC        |
| GET    | `/api/v1/orgs/:org/repos`                                | OIDC        |
| POST   | `/api/v1/orgs/:org/repos/:repo`                          | OIDC        |
| GET    | `/git/:org/:repo.git/info/refs?service=git-upload-pack`  | Basic token |
| POST   | `/git/:org/:repo.git/git-upload-pack`                    | Basic token |
| GET    | `/git/:org/:repo.git/info/refs?service=git-receive-pack` | Basic token |
| POST   | `/git/:org/:repo.git/git-receive-pack`                   | Basic token |

The canonical request and response documentation is in [`docs/api-reference.md`](docs/api-reference.md).

The browser UI is served at `/ui/` (`/` redirects there); UI-only configuration,
session, and OIDC endpoints use `/ui/*`, and static assets are served under `/ui/`.
The OpenAPI document lists the `/api/v1/*` application API and Git Smart HTTP routes,
not UI-only endpoints. Repository and file-preview state is stored in the
URL query string (`repo`, `ref`, and `path`), so navigation survives refreshes.
The UI uses a single Li³ `<template app>` root to own session, route, organization,
repository, theme, and repository-ref state. Reusable sign-in, organization landing,
and organization settings pages are separate Li³ components, with shared state passed
through props and user actions emitted back to the root. URL query parameters preserve
repository/file navigation across reloads. The UI uses refs, computed values, lifecycle
hooks, and event bindings. Framework reference:
https://li3.static.apphor.de/docs.html.
The signed-out user card starts OIDC authorization-code + PKCE sign-in; signed-in users
can open `${OIDC_ISSUER}/me`. GitMini requests `offline_access` and uses `openid-client`
for the validated authorization callback and rotating refresh flow. Auth's Node client
handles UserInfo and token introspection. GitMini keeps a validated identity and scope
snapshot in an opaque signed session. When the provider grants a refresh token, it is stored
only in the encrypted session store under `DATA_PATH` and rotated server-side as access
tokens approach expiry; the browser never receives either token. These sessions use a
renewable 30-day cookie. If the provider does not grant refresh tokens, the session remains
limited to the access-token lifetime. Keep `OIDC_CLIENT_SECRET` stable across restarts and
persist `DATA_PATH` to retain both repositories and browser sessions.
The topbar presents an explicit Sign in button for guests; its light/dark control updates
the root theme state using Tailwind v4's class-based variant.
The repository plus button opens an anchored HTML popover. Empty repositories offer a file upload that creates the initial commit;
files dropped into or selected for an existing repository remain unstaged and are marked
with `*`. Branch and tag empty states provide matching create popovers.
The server validates the session cookie before serving `/ui/` and embeds the session profile
in that uncached page response, avoiding a signed-out loading flash. Username claims are
omitted from the profile UI. `/ui/session` remains available to clients that need a session check.

The service reads configuration only from process environment variables; it does not load
`.env` files. Browser sign-in uses `/ui/auth/login` and requires the OIDC client callback URI
to be registered as `/ui/auth/callback`. The former `/auth/callback` path remains as a
compatibility endpoint for deployments whose OIDC client still has that URI registered.

## Configuration

| Variable              | Default                          | Purpose                                                           |
| --------------------- | -------------------------------- | ----------------------------------------------------------------- |
| `DATA_PATH`           | `/data` in the image             | Repository storage root                                           |
| `PORT`                | `3000`                           | HTTP listen port                                                  |
| `OIDC_ISSUER`         | unset                            | OIDC discovery issuer                                             |
| `OIDC_CLIENT_ID`      | unset                            | OIDC client identifier                                            |
| `OIDC_CLIENT_SECRET`  | unset                            | OIDC client credential and browser-session signing/encryption key |
| `OIDC_REDIRECT_URI`   | derived                          | Registered `/ui/auth/callback` URL (recommended)                  |
| `PUBLIC_URL`          | derived                          | Public origin used to derive the callback URL                     |
| `OIDC_JWKS_URI`       | issuer metadata                  | Same-issuer JWKS override for incorrect discovery metadata        |
| `OIDC_BROWSER_SCOPES` | `repo:read repo:write` in Docker | Scopes granted to validated browser sessions; can be overridden   |
| `DATABASE_URL`        | unset                            | Base URL for the d0 SQLite database used by the audit stream      |
| `DB_AUTH_TOKEN`       | unset                            | Bearer credential for the database API, when required             |

When OIDC variables are absent, repository requests fail closed with `401`.
The Docker image defaults browser sessions to `repo:read repo:write` so signed-in users
can manage their own organizations and repositories. Override `OIDC_BROWSER_SCOPES` to
`repo:read` for read-only browser sessions; non-Docker runs default to no browser scopes.

When `DATABASE_URL` is configured, the server creates the append-only `audit_events` table
and its organization/time index on first use. Set it to the database service base URL (for
example `https://db.apphor.de/db~<database>/`); configure `DB_AUTH_TOKEN` with the database
API credential when the endpoint requires bearer authentication. Events are retained indefinitely.
`GET /api/v1/orgs/{org}/events`
returns a descending, paginated stream (`limit` up to 100, `offset` non-negative) and applies
the same ownership and `repo:read` checks as other organization resources.

Recorded events include successful repository/API changes, individual Git branch/tag ref
changes from pushes, and authenticated/unauthenticated access denials where an organization
can be identified. Clones and fetches are intentionally omitted. Each event stores the
validated OIDC subject (and issuer), the authentication origin, request metadata, and a
keyed fingerprint of token-authenticated requests; raw bearer tokens are never stored.
The stable subject and an optional name snapshot are stored separately so the UI can
change its actor presentation without rewriting events. The stream currently prefers the
name snapshot, then the current browser profile for the signed-in actor, and otherwise
shows the stable subject identifier.

## Tests and quality checks

```bash
npm test
npx eslint . --fix
npx eslint .
```

The integration suite uses Node built-in modules only. It creates temporary isolated
repositories for two in-process test identities, checks the complete OpenAPI path
inventory, verifies cross-subject reads are isolated, and verifies unauthenticated
requests are rejected. Its test verifier is injected in-process and does not create an
HTTP authentication bypass.

## Diátaxis documentation

- [Tutorial](docs/tutorial.md): complete repository workflow.
- [How to get started](docs/getting-started.md): local, Docker, and environment setup.
- [API reference](docs/api-reference.md): endpoint contracts and examples.
- [TODO](TODO.md): remaining implementation and verification work.

# Managed worktrees

Organization-scoped repository APIs support managed worktrees at
`/api/v1/orgs/{org}/repos/{repo}/worktrees`. Create a detached worktree with `POST` JSON `{ "ref": "<branch|tag|commit>" }`.
Create a branch separately from the same start ref when needed. IDs are server-generated and callers cannot choose paths. `GET` lists IDs;
`DELETE /.../worktrees/{id}` removes only a clean worktree (dirty worktrees are refused). File upload and delete
accept `?worktreeId=<id>`; omission retains the primary worktree. `GET /tree?ref=<ref>&worktreeId=<id>` returns
the recursive committed tree with mode/type/blob SHA metadata for the ref, resolved in that worktree's shared object store.
Atomic commits accept optional `targetBranch` (default `main`) and compare-and-swap `expectedRef` against that branch.
Tag creation accepts optional `target` (default `HEAD`).
