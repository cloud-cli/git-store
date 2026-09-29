# Getting Started

## Purpose
Git Store is a minimal HTTP API for managing multiple Git repositories on disk.
Repositories are grouped under an *owner/name* path and stored on the host under the
`DATA_PATH` environment variable (default `/data`).

## Quick start (Docker)

```bash
# Build the image (uses the already‑committed Dockerfile)
docker build -t git-store .

# Run the container, exposing port 3000 and mounting a host directory for data
docker run -d \
  -p 3000:3000 \
  -v "$(pwd)/data:/data" \
  -e DATA_PATH=/data \
  git-store
```

## Local development

```bash
# Install dependencies
npm install

# Start the server (port 3000 by default)
npm start

# The server will be available at http://localhost:3000
```

## Environment variables

| Variable | Required? | Default | Description |
|---|---|---|---|
| `DATA_PATH` | no | `/data` | Absolute path where all `owner/repo` directories are created. |
| `PORT` | no | `3000` | TCP port on which the HTTP server listens. |
| `OIDC_ISSUER` | yes (when OIDC is enabled) | `https://auth.api.apphor.de` | OpenID Connect issuer URL (used for discovery). |
| `OIDC_CLIENT_ID` | yes (when OIDC is enabled) | – | Client identifier registered with the OIDC provider. |
| `OIDC_CLIENT_SECRET` | yes (when OIDC is enabled) | – | secret for the client. |

## Basic API calls (using `curl`)

```bash
# Health check (no authentication required)
curl http://localhost:3000/health

# List OpenAPI description
curl http://localhost:3000/api

# Create a new repository (owner = "myorg", repo = "myproject")
curl -X POST http://localhost:3000/repos/myorg/myproject

# View the commit log (returns an empty array for a brand‑new repo)
curl http://localhost:3000/repos/myorg/myproject/log

# Stage files (protected – requires a valid OIDC access token)
curl -X POST http://localhost:3000/repos/myorg/myproject/stage \
  -H "Authorization: Bearer <access-token>" \
  -H "Content-Type: application/json" \
  -d '{"files":["README.md"]}'

# Commit staged changes (protected)
curl -X POST http://localhost:3000/repos/myorg/myproject/commit \
  -H "Authorization: Bearer <access-token>" \
  -H "Content-Type: application/json" \
  -d '{"message":"initial commit"}'

# Add a tag (protected)
curl -X POST http://localhost:3000/repos/myorg/myproject/tags \
  -H "Authorization: Bearer <access-token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"v1.0"}'

# Create a branch (protected)
curl -X POST http://localhost:3000/repos/myorg/myproject/branches \
  -H "Authorization: Bearer <access-token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"dev"}'
```

## OIDC authentication

The server uses `express-openid-connect` with configuration read from environment
variables (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`).  All
endpoints that mutate data (`/stage`, `/unstage`, `/commit`, `/tags`,
`/tags/{name}`, `/branches`, `/branches/{name}`) check for a valid OIDC
session and return **401** when no token is present or the token is invalid.

The health check (`/health`) and the OpenAPI spec (`/api`) remain unauthenticated
so that tools and monitors can inspect the service without credentials.

## Web UI

Open `/` after starting the service. The UI mirrors the repository viewer design,
loads repositories and branches from the API, and opens a file preview when a file
is selected. The selected repository, ref, and file path are kept in the query string;
for example, `/?owner=myorg&repo=myproject&ref=main&path=README.md` can be refreshed
without losing the preview.

The UI is built with Li³ `@li3/web`: the app state uses `ref` and `computed`, events use
`on-*` bindings, and the page is split into HTML custom-element files loaded with
`<link rel="component">`. The component files live in `public/components/`.
