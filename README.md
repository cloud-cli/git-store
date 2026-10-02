# Git Store

Git Store is a single-container HTTP service for managing Git repositories.
Repositories are owned by authenticated OIDC subjects and accessible via
short repo names only — no owner segment in the URL.

## Current status

- Docker deployment uses `ghcr.io/cloud-cli/image-node:latest` and `/home/app`.
- `GET /api` serves an OpenAPI 3.0.3 document containing every route.
- Repository listing and creation are scoped to the authenticated OIDC subject.
- All repository operations require an authenticated OIDC subject. API bearer tokens
  need `repo:read` for reads and `repo:write` for creation/mutations; `repo:write` also
  grants read access. The browser UI may use a provider-validated same-origin session.
- Repository names are short paths-only identifiers; the authenticated subject's
  stable hashed `sub` claim derives the filesystem directory.
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

| Method | Path                          | Auth   |
| ------ | ----------------------------- | ------ |
| GET    | `/health`                     | public |
| GET    | `/api`                        | public |
| GET    | `/config`                     | public |
| GET    | `/session`                    | public |
| GET    | `/auth/login`                 | public |
| GET    | `/auth/callback`              | OIDC   |
| POST   | `/auth/logout`                | OIDC   |
| GET    | `/repos`                      | OIDC   |
| POST   | `/repos/:repo`                | OIDC   |
| GET    | `/repos/:repo/log`            | OIDC   |
| GET    | `/repos/:repo/tree`           | OIDC   |
| GET    | `/repos/:repo/file`           | OIDC   |
| GET    | `/repos/:repo/branches`       | OIDC   |
| GET    | `/repos/:repo/tags`           | OIDC   |
| GET    | `/repos/:repo/history`        | OIDC   |
| POST   | `/repos/:repo/stage`          | OIDC   |
| POST   | `/repos/:repo/unstage`        | OIDC   |
| POST   | `/repos/:repo/commit`         | OIDC   |
| POST   | `/repos/:repo/tags`           | OIDC   |
| DELETE | `/repos/:repo/tags/:name`     | OIDC   |
| POST   | `/repos/:repo/branches`       | OIDC   |
| DELETE | `/repos/:repo/branches/:name` | OIDC   |

The canonical request and response documentation is in [`docs/api-reference.md`](docs/api-reference.md).

The browser UI is served at `/`. Repository and file-preview state is stored in the
URL query string (`repo`, `ref`, and `path`), so navigation survives refreshes.
The UI is a Li³ application split into independent `<template app>` islands for the
session topbar, repository navigation, selected repository viewer, and refs panel.
Each island hydrates JSON state and independently fetches its own API data; URL query
parameters synchronize repository/file navigation across reloads. The UI uses refs,
computed values, lifecycle hooks, and event bindings. Framework reference:
https://li3.static.apphor.de/docs.html.
The signed-out user card starts OIDC authorization-code + PKCE sign-in; signed-in users
can open `${OIDC_ISSUER}/me`. Access tokens stay server-side in an opaque signed session.
The repository plus button opens an anchored HTML popover. Empty repositories offer a file upload that creates the initial commit;
files dropped into or selected for an existing repository remain unstaged and are marked
with `*`. Branch and tag empty states provide matching create popovers.
The topbar reads the current session profile from `/session`, displaying the authenticated
OIDC name, email, and picture when available, or a signed-out state otherwise.

The service reads configuration only from process environment variables; it does not load
`.env` files. Browser sign-in uses `/auth/login` and requires the OIDC client callback URI
to be registered as `/auth/callback`.

## Configuration

| Variable              | Default              | Purpose                                                    |
| --------------------- | -------------------- | ---------------------------------------------------------- |
| `DATA_PATH`           | `/data` in the image | Repository storage root                                    |
| `PORT`                | `3000`               | HTTP listen port                                           |
| `OIDC_ISSUER`         | unset                | OIDC discovery issuer                                      |
| `OIDC_CLIENT_ID`      | unset                | OIDC client identifier                                     |
| `OIDC_CLIENT_SECRET`  | unset                | OIDC introspection credential                              |
| `OIDC_REDIRECT_URI`   | derived              | Registered `/auth/callback` URL (recommended)              |
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
