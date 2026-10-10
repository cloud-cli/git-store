# Getting Started

## Purpose

Git Store is a minimal HTTP API for managing multiple Git repositories on disk.
Repositories are stored under the required `DATA_PATH` environment variable (the
Docker image defaults it to `/home/app/data`). Organization metadata is stored in
`DATA_PATH/orgs/<slug>/.organization.json`; repositories live beside it under
`DATA_PATH/orgs/<slug>/<repo>`. The service walks organization folders at startup.
Ownership metadata is the SHA-256 hash of the OIDC `sub`.

## Quick start (Docker)

```bash
# Build the image (uses the already‑committed Dockerfile)
docker build -t git-store .

# Create a persistent Docker volume and start the service
docker volume create git-store-data
docker run -d \
  -p 3000:3000 \
  -v git-store-data:/home/app/data \
  -e DATA_PATH=/home/app/data \
  git-store
```

## Local development

```bash
# Install dependencies
npm install

# Configure storage, then start the server (port 3000 by default)
export DATA_PATH="$PWD/data"
npm start

# The server will be available at http://localhost:3000
```

## Environment variables

| Variable              | Required?                  | Default                          | Description                                                                             |
| --------------------- | -------------------------- | -------------------------------- | --------------------------------------------------------------------------------------- |
| `DATA_PATH`           | yes                        | none                             | Absolute path where all repositories are created.                                       |
| `PORT`                | no                         | `3000`                           | TCP port on which the HTTP server listens.                                              |
| `OIDC_ISSUER`         | yes (when OIDC is enabled) | unset                            | OpenID Connect issuer URL (used for discovery).                                         |
| `OIDC_CLIENT_ID`      | yes (when OIDC is enabled) | –                                | Client identifier registered with the OIDC provider.                                    |
| `OIDC_CLIENT_SECRET`  | yes (when OIDC is enabled) | –                                | secret for the client.                                                                  |
| `OIDC_REDIRECT_URI`   | recommended                | derived                          | Exact registered callback URL ending in `/ui/auth/callback`.                            |
| `PUBLIC_URL`          | no                         | derived                          | Public service origin used to build the callback URL when `OIDC_REDIRECT_URI` is unset. |
| `OIDC_JWKS_URI`       | no                         | issuer metadata                  | Same-issuer JWKS override when discovery advertises an incorrect endpoint.              |
| `OIDC_BROWSER_SCOPES` | recommended                | `repo:read repo:write` in Docker | Scopes granted to browser sessions; override for read-only access.                      |

The Docker image supplies browser scopes by default. When running directly with Node.js,
set `OIDC_BROWSER_SCOPES` explicitly if browser users should be able to access repositories.

## Register an OIDC client

Create a client/application in your identity provider (for example, Auth Lab or Keycloak)
with the authorization-code flow enabled. Configure its exact redirect URI as
`https://<git-store-host>/ui/auth/callback` (or set `OIDC_REDIRECT_URI` to that URL), and
use the provider's issuer URL for `OIDC_ISSUER`. The client must support PKCE with `S256`;
Git Store requests the standard OIDC scopes `openid profile email` and uses the client ID
and secret from `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`.

For the browser UI, **do not configure `repo:read` or `repo:write` as identity-provider
scopes**. Git Store grants these application permissions to its cookie-backed browser
session from `OIDC_BROWSER_SCOPES`; the Docker image defaults this to
`repo:read repo:write`. Override it to `repo:read` for read-only browser access. These
permissions are enforced within the signed-in subject's own organizations.

This is separate from API clients that send OIDC bearer tokens. For those clients,
`repo:read` and `repo:write` are Git Store-defined OAuth scopes: configure the provider to
issue the required value in the introspected token's `scope`, `scp`, or `scopes` claim, and
Git Store enforces it on each API operation. Provider-specific role claims are not
automatically interpreted as these scope values.

## Basic API calls (using `curl`)

```bash
# Health check (no authentication required)
curl http://localhost:3000/api/v1/health

# Get the OpenAPI JSON description
curl http://localhost:3000/api

# Create an organization (requires authentication)
curl -X POST http://localhost:3000/api/v1/orgs \
  -H "Authorization: Bearer <access-token>" \
  -H "Content-Type: application/json" \
  -d '{"slug":"my-org"}'

# List organizations and repositories
curl -H "Authorization: Bearer <access-token>" http://localhost:3000/api/v1/orgs
curl -H "Authorization: Bearer <access-token>" http://localhost:3000/api/v1/orgs/my-org/repos

# Create a new repository (requires authentication)
curl -X POST http://localhost:3000/api/v1/orgs/my-org/repos/myproject \
  -H "Authorization: Bearer <access-token>"

# View the commit log (requires authentication)
curl -H "Authorization: Bearer <access-token>" http://localhost:3000/api/v1/orgs/my-org/repos/myproject/log

# Stage files (protected – requires a valid OIDC access token)
curl -X POST http://localhost:3000/api/v1/orgs/my-org/repos/myproject/stage \
  -H "Authorization: Bearer <access-token>" \
  -H "Content-Type: application/json" \
  -d '{"files":["README.md"]}'

# Commit staged changes (protected)
curl -X POST http://localhost:3000/api/v1/orgs/my-org/repos/myproject/commit \
  -H "Authorization: Bearer <access-token>" \
  -H "Content-Type: application/json" \
  -d '{"message":"initial commit"}'

# Add a tag (protected)
curl -X POST http://localhost:3000/api/v1/orgs/my-org/repos/myproject/tags \
  -H "Authorization: Bearer <access-token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"v1.0"}'

# Create a branch (protected)
curl -X POST http://localhost:3000/api/v1/orgs/my-org/repos/myproject/branches \
  -H "Authorization: Bearer <access-token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"dev"}'
```

## OIDC authentication and file uploads

The server introspects OIDC bearer tokens for API clients. Read operations require
`repo:read` or `repo:write`; repository creation and mutations require `repo:write`.
`repo:write` includes read access. A valid token missing a required scope returns **403
Forbidden**; unauthenticated requests return **401 Unauthorized**. Browser UI requests
instead use the cookie-backed session and its `OIDC_BROWSER_SCOPES` configuration.

The topbar's **Sign in** action starts an OIDC authorization-code flow with PKCE. The
callback validates state, PKCE, and the ID token, confirms the access token is active,
then establishes an HttpOnly, SameSite=Lax application session. The access token is kept
server-side. Register the exact callback URL (preferably configured with
`OIDC_REDIRECT_URI`) with the OIDC client. If that variable is unset, the service derives
the callback from `PUBLIC_URL` or reverse-proxy forwarded host/protocol headers.

Bearer requests are accepted only after:

1. The configured OIDC issuer introspects the token as active and confirms a non-empty `sub`.
2. Each repository route checks the token's `repo:read` or `repo:write` scope.

Cookie-authenticated browser writes must be same-origin. The `/ui/session` endpoint allows
the UI to verify the current authentication state.

### File upload methods

The API's file upload endpoint accepts JSON:

```json
{ "path": "src/readme.md", "content": "base64-encoded-bytes" }
```

The browser encodes drag-and-drop or selected-file bytes as base64 and submits JSON to
`POST /api/v1/orgs/{org}/repos/{repo}/files`. The endpoint returns **201 Created** on success, **400 Bad
Request** for invalid paths (including traversal), **403** for insufficient scope, or
**404** if the repository is not found. Empty content creates an empty file.

### Empty repository onboarding

When creating a new repository in an organization via
`POST /api/v1/orgs/{org}/repos/{repo}`, the initial state is empty. Use either:

- Select a file in the empty-repository welcome screen; the UI uploads, stages, and
  commits the first file.
- Call the JSON upload endpoint, then stage and commit through the API.
- Write files directly under the repository directory, then stage/commit through the API.

The system will not fail on uploading empty content—the file is created with no payload.

## Storage

Organization folders and their `.organization.json` metadata are authoritative; the
service rebuilds its index at startup. Repository data remains in
`DATA_PATH/orgs/<slug>/<repo>`. Existing `organizations.json` registries are migrated
and archived after successful migration.

## Web UI

Open `/` after starting the service. The UI mirrors the repository viewer design,
loads repositories from the API, and opens a file preview when a file is selected.
The selected repository, ref, and file path are kept in the query string;
for example, `/?repo=myproject&ref=main&path=README.md` can be refreshed
without losing the preview.
Internal navigation and repository mutations update the page in place. Text files open as text;
supported raster images such as JPEG and PNG open as images.

### Empty states and HTML popovers

When no repositories exist for a subject or tags/branches lists are empty:

- **Repository creation**: The repository plus button opens an anchored HTML popover.
- **Empty repository**: A welcome view offers file selection; the first selected file is committed.
- **Empty tag/branch lists**: Show “No tags/branches. Create one” actions and anchored popovers.
- **Existing repository**: Files can be uploaded through a file input or by dropping them on the file list; uploads remain unstaged.

The UI is built with Li³ `@li3/web`: a single `<template app>` root owns shared session,
route, organization, repository, theme, and branch/tag state. Sign-in, organization
landing, and organization settings pages are reusable components whose state is passed
from the root through props and whose actions are emitted back to it. The root uses
refs, computed values, lifecycle hooks, and `on-*` bindings. The URL query string
preserves navigation state on refresh.
The UI selects an organization and repository; repository API and Git paths always include both slugs.
