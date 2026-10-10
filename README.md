# Git Store

Git Store is a single-container HTTP service for managing Git repositories.
Organization/repository pairs are the primary namespace; OIDC usernames do not
participate in organization or repository naming.

## Current status

- Docker deployment uses `ghcr.io/cloud-cli/image-node:latest` and `/home/app`.
- `GET /api` serves an OpenAPI 3.0.3 document for the versioned API
  and Git Smart HTTP endpoints; UI-only routes are excluded.
- Organizations and their repositories are scoped to the authenticated OIDC subject.
  Organization slugs are globally unique, lowercase, and case-insensitive on input.
- All repository operations require an authenticated OIDC subject. API bearer tokens
  need `repo:read` for reads and `repo:write` for creation/mutations; `repo:write` also
  grants read access. The browser UI may use a provider-validated same-origin session.
- Git Smart HTTP is available at `/git/<org>/<repo>.git`. Git clients use HTTP Basic auth
  with any username and an active OIDC access token as the password; fetch needs
  `repo:read` (or `repo:write`) and push needs `repo:write`. Git transport never
  falls back to browser sessions. Use HTTPS in deployment; plain HTTP is suitable
  only for local testing. PATs are not issued by this version; use an OIDC access
  token until PAT management is added.
- Browser sign-in identifies an account by the stable OIDC `sub` claim. Username
  claims have no authentication or naming role and are omitted from the UI profile.
  Organization slugs are chosen in Git Store and repositories are routed as
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
docker build -t git-store .
docker run --rm -p 3000:3000 \
  -e DATA_PATH=/home/app/data \
  -e OIDC_ISSUER="$OIDC_ISSUER" \
  -e OIDC_CLIENT_ID="$OIDC_CLIENT_ID" \
  -e OIDC_CLIENT_SECRET="$OIDC_CLIENT_SECRET" \
  git-store
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
The UI is a Li³ application split into independent `<template app>` islands for the
session topbar, repository navigation, selected repository viewer, and refs panel.
Its initial theme follows the operating system's color-scheme preference; a manual
toggle is remembered in local storage.
Each island hydrates JSON state and independently fetches its own API data; URL query
parameters synchronize repository/file navigation across reloads. The UI uses refs,
computed values, lifecycle hooks, and event bindings. Framework reference:
https://li3.static.apphor.de/docs.html.
The signed-out user card starts OIDC authorization-code + PKCE sign-in; signed-in users
can open `${OIDC_ISSUER}/me`. Access tokens stay server-side in an opaque signed session.
The topbar presents an explicit Sign in button for guests; the light/dark control synchronizes
reactive theme state across all four page islands using Tailwind v4's class-based variant.
The repository plus button opens an anchored HTML popover. Empty repositories offer a file upload that creates the initial commit;
files dropped into or selected for an existing repository remain unstaged and are marked
with `*`. Branch and tag empty states provide matching create popovers.
The topbar reads the current session profile from `/ui/session`; username claims are omitted from the profile UI.

The service reads configuration only from process environment variables; it does not load
`.env` files. Browser sign-in uses `/ui/auth/login` and requires the OIDC client callback URI
to be registered as `/ui/auth/callback`. The former `/auth/callback` path remains as a
compatibility endpoint for deployments whose OIDC client still has that URI registered.

## Configuration

| Variable              | Default                          | Purpose                                                         |
| --------------------- | -------------------------------- | --------------------------------------------------------------- |
| `DATA_PATH`           | `/data` in the image             | Repository storage root                                         |
| `PORT`                | `3000`                           | HTTP listen port                                                |
| `OIDC_ISSUER`         | unset                            | OIDC discovery issuer                                           |
| `OIDC_CLIENT_ID`      | unset                            | OIDC client identifier                                          |
| `OIDC_CLIENT_SECRET`  | unset                            | OIDC introspection credential                                   |
| `OIDC_REDIRECT_URI`   | derived                          | Registered `/ui/auth/callback` URL (recommended)                |
| `PUBLIC_URL`          | derived                          | Public origin used to derive the callback URL                   |
| `OIDC_JWKS_URI`       | issuer metadata                  | Same-issuer JWKS override for incorrect discovery metadata      |
| `OIDC_BROWSER_SCOPES` | `repo:read repo:write` in Docker | Scopes granted to validated browser sessions; can be overridden |

When OIDC variables are absent, repository requests fail closed with `401`.
The Docker image defaults browser sessions to `repo:read repo:write` so signed-in users
can manage their own organizations and repositories. Override `OIDC_BROWSER_SCOPES` to
`repo:read` for read-only browser sessions; non-Docker runs default to no browser scopes.

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
