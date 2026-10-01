# API Reference

All URLs are relative to the server base URL (`http://localhost:3000` by default).

## Path parameters

- `{repo}` – string, the repository name (e.g. `myproject`).
- `{name}` – string, the tag or branch name.

## Authentication and authorization

API clients send an active OIDC bearer token. The server validates it through the
configured issuer's introspection endpoint and derives ownership only from its `sub`
claim. Tokens need scopes as follows:

- Reads (`GET /repos` and repository `GET` operations): `repo:read` or `repo:write`.
- Repository creation and all mutations (`POST`, `DELETE`): `repo:write`.
- `repo:write` includes read access. `repo:read` never grants write access.
- A valid token without the required scope returns **403 Forbidden**. Missing or
  invalid authentication returns **401 Unauthorized**.

The browser UI signs in through `/auth/login` using authorization code + PKCE. The callback
validates state, nonce, ID-token claims, and active-token introspection before issuing a
signed HttpOnly same-origin cookie. Access tokens stay server-side. Cookie-authenticated
repository writes require same-origin requests. Profile nicknames and display names never
determine repository ownership. Other applications can use scoped bearer tokens.

Public endpoints (`/health`, `/api`, `/config`, `/session`) do not require authentication.

## Endpoints

### GET /health

Return the service health status.

```http
GET /health
```

**Response (200)**

```json
{ "status": "ok" }
```

### GET /api

Return the full [OpenAPI 3.0.3][] specification describing every other endpoint.

```http
GET /api
```

**Response (200)** – JSON body is the spec.

### GET /config

Return public browser configuration, including the profile URL and the local sign-in URL
when OIDC is configured.

```http
GET /config
```

**Response (200)** – JSON body includes `oidcUserUrl` and `oidcLoginUrl`.

### GET /session

Return `{ "authenticated": true, "profile": { ... } }` when the current OIDC session
cookie is valid, otherwise `{ "authenticated": false, "profile": null }`.

```http
GET /session
```

The endpoint can also identify an active bearer token passed in the `Authorization` header.

### GET /auth/login

Start the OIDC authorization-code flow with PKCE. The service saves short-lived state,
nonce, and verifier cookies and redirects to the configured issuer. An optional same-origin
`returnTo` path is restored after sign-in.

### GET /auth/callback

Configured OIDC redirect URI. Validates the response, exchanges the authorization code,
confirms the access token and subject, then establishes the local HttpOnly browser session.

### POST /auth/logout

Clear the local browser session and redirect to `/`.

### GET /repos

List only repositories belonging to the authenticated subject. The response contains
repository names and does not expose an owner or nickname. If no repositories exist,
returns an empty array `[ ]`.

```http
GET /repos
```

**Response (200)** – JSON array of objects containing only the repository name, for
example `[{ "repo": "my-repo" }]`. Returns `[]` when the authenticated subject has
no repositories. Guest identity returns `401`.

### POST /repos/{repo}

Create or initialize a repository for the authenticated subject. The endpoint returns
`201 Created` whether the Git directory was newly initialized or was already present.
Repository names contain only letters, numbers, dots, underscores, and hyphens. The
request cannot select an owner: storage ownership is derived from the authenticated
OIDC `sub` claim and hashed directories under `DATA_PATH`.

If the repository name is invalid, returns `400 Bad Request`. A token requires
`repo:write`; an unauthenticated guest receives `401`, and a read-only token receives
`403`.

```http
POST /repos/{repo}
```

**Response (201)** – Repository is ready.
**Response (400)** – Invalid repository name format or empty name.

```json
{ "message": "Repository {repo} is ready", "repo": "{repo}" }
```

### GET /repos/{repo}/log

Fetch the repository log.

```http
GET /repos/{repo}/log
```

**Response (200)** – JSON array of commit objects (may be empty).

**Response (404)** – repository not found.

### GET /repos/{repo}/tree

List repository files/tree.

```http
GET /repos/{repo}/tree
```

**Response (200)** – JSON array of file/directory entries.

**Response (404)** – repository not found.

**Query parameters**

- `path` – optional relative path within the repository to list entries from.

### GET /repos/{repo}/file

Read a repository file.

```http
GET /repos/{repo}/file
```

**Query parameters**

- `path` – relative path to the file within the repository.

**Response (200)** – `text/plain` file contents.

**Response (400)** – invalid path or path traversal detected.

**Response (404)** – file not found.

### POST /repos/{repo}/files

Upload one file without staging it. The browser uses the JSON API and encodes the file
bytes as base64. Send an empty string as `content` to create an empty file.

```http
POST /repos/{repo}/files
Content-Type: application/json

{"path":"README.md","content":"IyBIZWxsbyBXb3JsZAo="}
```

**Response (201)** – file written.

**Response (400)** – invalid file path.

**Response (401)** – no or invalid OIDC token.

**Response (403)** – token lacks `repo:write`.

**Response (404)** – repository not found.

### POST /repos/{repo}/stage

Stage one or more files.

```http
POST /repos/{repo}/stage
```

**Request Body:**

```json
{ "files": ["path/to/file1", "path/to/file2"] }
```

**Response (200)** – `{ "message": "Files staged successfully" }`.

**Response (401)** – no or invalid OIDC token.

**Response (404)** – repository not found.

**Response (500)** – Git error.

### POST /repos/{repo}/unstage

Unstage (reset) one or more files.

```http
POST /repos/{repo}/unstage
```

**Request Body:**

```json
{ "files": ["path/to/file1", "path/to/file2"] }
```

**Response (200)** – `{ "message": "Files unstaged successfully" }`.

**Response (401)** – no or invalid OIDC token.

**Response (404)** – repository not found.

**Response (500)** – Git error.

### POST /repos/{repo}/commit

Commit staged changes with an optional message (default `"autocommit"`).

```http
POST /repos/{repo}/commit
```

**Request Body (optional):**

```json
{ "message": "my custom commit message" }
```

**Response (200)** – `{ "message": "Changes committed successfully", "commit": "my custom commit message" }`.

**Response (200)** – if no staged changes, `{ "message": "No changes to commit" }`.

**Response (401)** – no or invalid OIDC token.

**Response (500)** – Git error.

### POST /repos/{repo}/tags

Add a lightweight Git tag referencing the current HEAD at commit `HEAD`. Tag endpoints
are the existing release/version marker model; the API does not define a separate release
resource. Git returns an error if no commit exists yet.

```http
POST /repos/{repo}/tags
```

**Request Body:**

```json
{ "name": "v1.0.0" }
```

**Response (200)** – `{ "message": "Tag v1.0.0 added" }`.

**Response (401)** – no or invalid OIDC token.

**Response (404)** – repository not found.

### DELETE /repos/{repo}/tags/{name}

Delete a tag.

```http
DELETE /repos/{repo}/tags/{name}
```

**Response (200)** – `{ "message": "Tag {name} removed" }`.

**Response (401)** – no or invalid OIDC token.

**Response (404)** – repository not found.

### POST /repos/{repo}/branches

Create a new branch.

```http
POST /repos/{repo}/branches
```

**Request Body:**

```json
{ "name": "new-feature", "startPoint": "main" } // startPoint optional
```

**Response (200)** – `{ "message": "Branch new-feature created" }`.

**Response (400)** – if `name` is missing.

**Response (401)** – no or invalid OIDC token.

**Response (404)** – repository not found.

### DELETE /repos/{repo}/branches/{name}

Delete a branch. Git returns an error when the branch does not exist or cannot be deleted.
Branch/tag empty states in the UI show create actions that open HTML popover forms.

```http
DELETE /repos/{repo}/branches/{name}
```

**Response (200)** – `{ "message": "Branch {name} removed" }`.

**Response (401)** – no or invalid OIDC token.

**Response (404)** – repository not found.

---

[OpenAPI 3.0.3]: https://swagger.io/specification/v3.0.3/
