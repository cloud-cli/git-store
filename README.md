# Git Store

Git Store is a single-container HTTP service for managing Git repositories.
Organization/repository pairs are the primary namespace; OIDC usernames do not
participate in organization or repository naming.

## Current status

- Docker deployment uses `ghcr.io/cloud-cli/image-node:latest` and `/home/app`.
- `GET /api` serves an OpenAPI 3.0.3 document for the versioned API
  and Git Smart HTTP endpoints; UI-only routes are excluded.
- Repository listing and creation are scoped to the authenticated OIDC subject.
- All repository operations require an authenticated OIDC subject. API bearer tokens
  need `repo:read` for reads and `repo:write` for creation/mutations; `repo:write` also
  grants read access. The browser UI may use a provider-validated same-origin session.
- Git Smart HTTP is available at `/git/<repo>.git`. Git clients use HTTP Basic auth
  with any username and an active OIDC access token as the password; fetch needs
  `repo:read` (or `repo:write`) and push needs `repo:write`. Git transport never
  falls back to browser sessions. Use HTTPS in deployment; plain HTTP is suitable
  only for local testing. PATs are not issued by this version; use an OIDC access
  token until PAT management is added.
- Browser sign-in identifies an account by the stable OIDC `sub` claim; a provider
  username is optional and does not determine organization or repository names.
  Organization and repository slugs are chosen in Git Store and routed as
  `/api/v1/orgs/<org>/repos/<repo>` and `/git/<org>/<repo>.git`. Organization
  ownership is still enforced against the authenticated subject, not its OIDC
  username. Legacy subject-owned repositories and alias-qualified routes remain
  available for compatibility.
- Organization and repository names are short path-only identifiers. The
  authenticated subject's stable hashed `sub` claim is used for ownership metadata,
  independently of the names shown in organization/repository paths.
- `npm test` runs a Node-built-in integration suite covering subject isolation,
  unauthorized access, route inventory, traversal rejection, and UI wiring.

### Migration note

This version replaces the old `owner/repo` directory structure with a one-way
hashed subject directory. Old repositories stored under `DATA_PATH/<nickname>/repo`
cannot be automatically migrated because the nickname cannot be safely attributed
to an OIDC subject. If migrating from an old installation, back up the `DATA_PATH`
directory before upgrading. Repositories created with this version are stored under
`DATA_PATH/<sha256(sub)>/<repo>`, where `sub` is the OIDC subject claim.

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
| GET    | `/api/v1/repos`                                          | OIDC        |
| GET    | `/api/v1/profile/alias`                                  | OIDC        |
| PUT    | `/api/v1/profile/alias`                                  | OIDC        |
| GET    | `/api/v1/repos/:alias`                                   | OIDC        |
| POST   | `/api/v1/repos/:alias/:repo`                             | OIDC        |
| GET    | `/api/v1/repos/:alias/:repo/log`                         | OIDC        |
| POST   | `/api/v1/repos/:repo`                                    | OIDC        |
| GET    | `/api/v1/repos/:repo/log`                                | OIDC        |
| GET    | `/api/v1/repos/:repo/tree`                               | OIDC        |
| GET    | `/api/v1/repos/:repo/file`                               | OIDC        |
| GET    | `/api/v1/repos/:repo/branches`                           | OIDC        |
| GET    | `/api/v1/repos/:repo/tags`                               | OIDC        |
| GET    | `/git/:repo.git/info/refs?service=git-upload-pack`       | Basic token |
| POST   | `/git/:repo.git/git-upload-pack`                         | Basic token |
| GET    | `/git/:repo.git/info/refs?service=git-receive-pack`      | Basic token |
| POST   | `/git/:repo.git/git-receive-pack`                        | Basic token |

Subject-owned short-repository and alias-qualified routes listed below are retained
for compatibility; organization/repository pairs are the primary namespace.
| GET | `/git/:alias/:repo.git/info/refs?service=git-upload-pack` | Basic token |
| POST | `/git/:alias/:repo.git/git-upload-pack` | Basic token |
| GET | `/git/:alias/:repo.git/info/refs?service=git-receive-pack` | Basic token |
| POST | `/git/:alias/:repo.git/git-receive-pack` | Basic token |
| GET | `/api/v1/repos/:repo/history` | OIDC |
| POST | `/api/v1/repos/:repo/stage` | OIDC |
| POST | `/api/v1/repos/:repo/unstage` | OIDC |
| POST | `/api/v1/repos/:repo/commit` | OIDC |
| POST | `/api/v1/repos/:repo/tags` | OIDC |
| DELETE | `/api/v1/repos/:repo/tags/:name` | OIDC |
| POST | `/api/v1/repos/:repo/branches` | OIDC |
| DELETE | `/api/v1/repos/:repo/branches/:name` | OIDC |

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
The topbar reads the current session profile from `/ui/session`, displaying the authenticated
OIDC name, email, and picture when available, or a signed-out state otherwise.

The service reads configuration only from process environment variables; it does not load
`.env` files. Browser sign-in uses `/ui/auth/login` and requires the OIDC client callback URI
to be registered as `/ui/auth/callback`. The former `/auth/callback` path remains as a
compatibility endpoint for deployments whose OIDC client still has that URI registered.

## Configuration

| Variable              | Default              | Purpose                                                    |
| --------------------- | -------------------- | ---------------------------------------------------------- |
| `DATA_PATH`           | `/data` in the image | Repository storage root                                    |
| `PORT`                | `3000`               | HTTP listen port                                           |
| `OIDC_ISSUER`         | unset                | OIDC discovery issuer                                      |
| `OIDC_CLIENT_ID`      | unset                | OIDC client identifier                                     |
| `OIDC_CLIENT_SECRET`  | unset                | OIDC introspection credential                              |
| `OIDC_REDIRECT_URI`   | derived              | Registered `/ui/auth/callback` URL (recommended)           |
| `PUBLIC_URL`          | derived              | Public origin used to derive the callback URL              |
| `OIDC_JWKS_URI`       | issuer metadata      | Same-issuer JWKS override for incorrect discovery metadata |
| `OIDC_BROWSER_SCOPES` | unset                | Scopes granted to validated browser sessions               |

When OIDC variables are absent, repository requests fail closed with `401`.

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
