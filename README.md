# Git Store

Git Store is a single-container HTTP service for managing Git repositories grouped
as `owner/repo` beneath `DATA_PATH`.

## Current status

- Docker deployment uses `ghcr.io/cloud-cli/image-node:latest` and `/home/app`.
- `GET /api` serves an OpenAPI 3.0.3 document containing every route.
- Repository creation and log reads are public.
- All stage, unstage, commit, tag, and branch mutations require an OIDC bearer token
  when OIDC variables are configured.
- `npm test` runs a Node-built-in integration suite covering every route's public and
  unauthorized behavior.

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

| Method | Path                                   | Auth   |
| ------ | -------------------------------------- | ------ |
| GET    | `/health`                              | public |
| GET    | `/api`                                 | public |
| POST   | `/repos/:owner/:repo`                  | public |
| GET    | `/repos/:owner/:repo/log`              | public |
| GET    | `/repos/:owner/:repo/tree`             | public |
| GET    | `/repos/:owner/:repo/file?path=...`    | public |
| GET    | `/repos/:owner/:repo/history?path=...` | public |
| GET    | `/repos/:owner/:repo/branches`         | public |
| GET    | `/repos/:owner/:repo/tags`             | public |
| POST   | `/repos/:owner/:repo/stage`            | OIDC   |
| POST   | `/repos/:owner/:repo/unstage`          | OIDC   |
| POST   | `/repos/:owner/:repo/commit`           | OIDC   |
| POST   | `/repos/:owner/:repo/tags`             | OIDC   |
| DELETE | `/repos/:owner/:repo/tags/:name`       | OIDC   |
| POST   | `/repos/:owner/:repo/branches`         | OIDC   |
| DELETE | `/repos/:owner/:repo/branches/:name`   | OIDC   |

The canonical request and response documentation is in [`docs/api-reference.md`](docs/api-reference.md).

The browser UI is served at `/`. Repository and file-preview state is stored in the
URL query string (`owner`, `repo`, `ref`, and `path`), so navigation survives refreshes.
The UI is a Li³ application split into independent `<template app>` islands for the
session topbar, repository navigation, selected repository viewer, and refs panel.
Each island hydrates JSON state and independently fetches its own API data; URL query
parameters synchronize repository/file navigation across reloads. The UI uses refs,
computed values, lifecycle hooks, and event bindings. Framework reference:
https://li3.static.apphor.de/docs.html.
The user card links to `${OIDC_USSUER}/me` (falling back to `OIDC_ISSUER`), the repository
plus button opens the create dialog, and the first-run page provides the same create flow.
Files can be dropped into the browser file list; uploads remain unstaged and are marked with `*`.
The topbar reads the current session profile from `/session`, displaying the authenticated
OIDC name, email, and picture when available, or a signed-out state otherwise.

## Configuration

| Variable             | Default              | Purpose                       |
| -------------------- | -------------------- | ----------------------------- |
| `DATA_PATH`          | `/data` in the image | Repository storage root       |
| `PORT`               | `3000`               | HTTP listen port              |
| `OIDC_ISSUER`        | unset                | OIDC discovery issuer         |
| `OIDC_CLIENT_ID`     | unset                | OIDC client identifier        |
| `OIDC_CLIENT_SECRET` | unset                | OIDC introspection credential |

When OIDC variables are absent, mutation requests fail closed with `401`.

## Tests and quality checks

```bash
npm test
npx eslint . --fix
npx eslint .
```

The integration suite uses Node's `http`, `assert`, and `child_process` modules only.
It creates a temporary repository, checks the complete OpenAPI path inventory, verifies
public behavior, and verifies that each mutation rejects unauthenticated requests.

## Diátaxis documentation

- [Tutorial](docs/tutorial.md): complete repository workflow.
- [How to get started](docs/getting-started.md): local, Docker, and environment setup.
- [API reference](docs/api-reference.md): endpoint contracts and examples.
- [TODO](TODO.md): remaining implementation and verification work.
