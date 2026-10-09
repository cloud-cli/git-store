# API Reference

All URLs are relative to the server base URL (`http://localhost:3000` by default).

## Path parameters

- `{org}` – string, the organization slug (e.g. `my-org`).
- `{repo}` – string, the repository name (e.g. `myproject`).
- `{name}` – string, the tag or branch name.

## Authentication and authorization

API clients send an active OIDC bearer token. The server validates it through the
configured issuer's introspection endpoint and derives ownership only from its `sub`
claim. Tokens need scopes as follows:

- Reads (`GET /api/v1/orgs/{org}/repos` and repository `GET` operations): `repo:read` or `repo:write`.
- Organization creation, repository creation, and all mutations (`POST`, `DELETE`): `repo:write`.
- `repo:write` includes read access. `repo:read` never grants write access.
- A valid token without the required scope returns **403 Forbidden**. Missing or
  invalid authentication returns **401 Unauthorized**.

## Organization/repository namespace

The authenticated account is identified by the validated OIDC `sub` claim. Username
claims do not participate in authentication or naming and are omitted from the UI profile.
Organizations use globally unique, case-insensitive lowercase slugs. Each organization is
owned by the subject that created it; ownership metadata is the SHA-256 hash of that
subject. All repository API operations use `/api/v1/orgs/{org}/repos/{repo}/...`, and Git
Smart HTTP uses `/git/{org}/{repo}.git`. Subject-scoped `/api/v1/repos` routes, alias
endpoints, and short Git paths are not supported.
Organization slugs cannot be renamed, and repositories cannot be moved between
organizations in this MVP.

The browser UI signs in through `/ui/auth/login` using authorization code + PKCE. The callback
validates state, ID-token claims, and the token's userinfo subject before issuing a signed
HttpOnly same-origin cookie. Access tokens stay server-side. Browser-session scopes come
from `OIDC_BROWSER_SCOPES`; cookie-authenticated repository writes require same-origin
requests. Profile nicknames and display names never determine repository ownership. Other
applications can use scoped opaque bearer tokens validated through OIDC introspection.

Git Smart HTTP uses HTTP Basic authentication at `/git/{org}/{repo}.git`. The username is
ignored; the password must be an active OIDC access token with a non-empty subject.
Git fetch (`git-upload-pack`) requires `repo:read` or `repo:write`; Git push
(`git-receive-pack`) requires `repo:write`. Git transport does not accept browser
session cookies. Use HTTPS so the Basic credential is encrypted in transit. This
version accepts OIDC access tokens as the Basic password; it does not yet issue PATs.

Public endpoints (`/api`, `/api/v1/health`, `/ui/config`, `/ui/session`) do not require authentication.

## Endpoints

### GET /api/v1/health

Return the service health status.

```http
GET /api/v1/health
```

**Response (200)**

```json
{ "status": "ok" }
```

### GET /api

Return the OpenAPI 3.0.3 specification for `/api/v1/*` application APIs and Git Smart HTTP.
UI-only routes under `/ui/*` are intentionally excluded.

```http
GET /api
```

**Response (200)** – JSON body is the spec.

### GET /ui/config

Return public browser configuration, including the profile URL and the local sign-in URL
when OIDC is configured.

```http
GET /ui/config
```

**Response (200)** – JSON body includes `oidcUserUrl` and `oidcLoginUrl`.

### GET /ui/session

Return `{ "authenticated": true, "profile": { ... } }` when the current OIDC session
cookie is valid, otherwise `{ "authenticated": false, "profile": null }`.

```http
GET /ui/session
```

The endpoint can also identify an active bearer token passed in the `Authorization` header.

### GET /ui/auth/login

Start the OIDC authorization-code flow with PKCE. The service saves short-lived state
and verifier cookies and redirects to the configured issuer. An optional same-origin
`returnTo` path is restored after sign-in.

### GET /ui/auth/callback

Configured OIDC redirect URI. Validates state and the PKCE exchange, exchanges the authorization code,
confirms the access token and subject, then establishes the local HttpOnly browser session.
The legacy `/auth/callback` path remains available for OIDC clients that have not yet
migrated their registered callback URI to `/ui/auth/callback`.

### POST /ui/auth/logout

Clear the local browser session and redirect to `/`.

### Git Smart HTTP

Use the HTTPS clone URL `https://<host>/git/{org}/{repo}.git`. When Git prompts for Basic
credentials, the username is arbitrary and the password is an active OIDC access token
with the required repository scope. Do not put tokens in clone URLs, where they may be
saved in shell history or Git configuration. For example:

```sh
git clone https://git.example.com/git/my-org/myproject.git
git -C myproject push origin HEAD
```

The Git client uses `GET /git/{org}/{repo}.git/info/refs?service=git-upload-pack`
followed by `POST /git/{org}/{repo}.git/git-upload-pack` to fetch. Push uses the
corresponding `git-receive-pack` GET and POST endpoints. The service streams these
requests through Git's `http-backend`; organization ownership is checked against the
token's validated OIDC `sub`. Git Smart HTTP is also listed in the OpenAPI document at
`/api`.

### GET /api/v1/orgs

List organizations owned by the authenticated subject.

```http
GET /api/v1/orgs
```

**Response (200)**

```json
{ "orgs": [{ "slug": "my-org" }] }
```

### POST /api/v1/orgs

Create an organization. Slugs are normalized to lowercase and must be globally unique.

```http
POST /api/v1/orgs
Content-Type: application/json

{ "slug": "my-org" }
```

**Response (201)**

```json
{ "org": { "slug": "my-org" } }
```

Invalid slugs return **400**; an existing slug returns **409**.

### GET /api/v1/orgs/{org}/repos

List repositories in an organization owned by the authenticated subject.

```http
GET /api/v1/orgs/my-org/repos
```

**Response (200)**

```json
{ "repos": [{ "repo": "my-repo" }] }
```

An organization with no repositories returns `{ "repos": [] }`. An organization not
owned by the authenticated subject returns **404**.

### POST /api/v1/orgs/{org}/repos/{repo}

Create or initialize a repository for the authenticated subject. The endpoint returns
`201 Created` whether the Git directory was newly initialized or was already present.
Repository names contain only letters, numbers, dots, underscores, and hyphens. The
request cannot select an owner: storage ownership is derived from the authenticated
OIDC `sub` claim and hashed directories under `DATA_PATH`.

If the repository name is invalid, returns `400 Bad Request`. A token requires
`repo:write`; an unauthenticated guest receives `401`, and a read-only token receives
`403`.

```http
POST /api/v1/orgs/{org}/repos/{repo}
```

**Response (201)** – Repository is ready.
**Response (400)** – Invalid repository name format or empty name.

```json
{ "message": "Repository {repo} is ready", "repo": "{repo}" }
```

### GET /api/v1/orgs/{org}/repos/{repo}/log

Fetch the repository log.

```http
GET /api/v1/orgs/{org}/repos/{repo}/log
```

**Response (200)** – JSON array of commit objects (may be empty).

**Response (404)** – repository not found.

### GET /api/v1/orgs/{org}/repos/{repo}/tree

List repository files/tree.

```http
GET /api/v1/orgs/{org}/repos/{repo}/tree
```

**Response (200)** – JSON array of file/directory entries.

**Response (404)** – repository not found.

**Query parameters**

- `path` – optional relative path within the repository to list entries from.

### GET /api/v1/orgs/{org}/repos/{repo}/file

Read a repository file.

```http
GET /api/v1/orgs/{org}/repos/{repo}/file
```

**Query parameters**

- `path` – relative path to the file within the repository.

**Response (200)** – `text/plain` file contents.

**Response (400)** – invalid path or path traversal detected.

**Response (404)** – file not found.

### POST /api/v1/orgs/{org}/repos/{repo}/files

Upload one file without staging it. The browser uses the JSON API and encodes the file
bytes as base64. Send an empty string as `content` to create an empty file.

```http
POST /api/v1/orgs/{org}/repos/{repo}/files
Content-Type: application/json

{"path":"README.md","content":"IyBIZWxsbyBXb3JsZAo="}
```

**Response (201)** – file written.

**Response (400)** – invalid file path.

**Response (401)** – no or invalid OIDC token.

**Response (403)** – token lacks `repo:write`.

**Response (404)** – repository not found.

### POST /api/v1/orgs/{org}/repos/{repo}/stage

Stage one or more files.

```http
POST /api/v1/orgs/{org}/repos/{repo}/stage
```

**Request Body:**

```json
{ "files": ["path/to/file1", "path/to/file2"] }
```

**Response (200)** – `{ "message": "Files staged successfully" }`.

**Response (401)** – no or invalid OIDC token.

**Response (404)** – repository not found.

**Response (500)** – Git error.

### POST /api/v1/orgs/{org}/repos/{repo}/unstage

Unstage (reset) one or more files.

```http
POST /api/v1/orgs/{org}/repos/{repo}/unstage
```

**Request Body:**

```json
{ "files": ["path/to/file1", "path/to/file2"] }
```

**Response (200)** – `{ "message": "Files unstaged successfully" }`.

**Response (401)** – no or invalid OIDC token.

**Response (404)** – repository not found.

**Response (500)** – Git error.

### POST /api/v1/orgs/{org}/repos/{repo}/commit

Commit staged changes with an optional message (default `"autocommit"`).

```http
POST /api/v1/orgs/{org}/repos/{repo}/commit
```

**Request Body (optional):**

```json
{ "message": "my custom commit message" }
```

**Response (200)** – `{ "message": "Changes committed successfully", "commit": "my custom commit message" }`.

**Response (200)** – if no staged changes, `{ "message": "No changes to commit" }`.

**Response (401)** – no or invalid OIDC token.

**Response (500)** – Git error.

### POST /api/v1/orgs/{org}/repos/{repo}/tags

Add a lightweight Git tag referencing the current HEAD at commit `HEAD`. Tag endpoints
are the existing release/version marker model; the API does not define a separate release
resource. Git returns an error if no commit exists yet.

```http
POST /api/v1/orgs/{org}/repos/{repo}/tags
```

**Request Body:**

```json
{ "name": "v1.0.0" }
```

**Response (200)** – `{ "message": "Tag v1.0.0 added" }`.

**Response (401)** – no or invalid OIDC token.

**Response (404)** – repository not found.

### DELETE /api/v1/orgs/{org}/repos/{repo}/tags/{name}

Delete a tag.

```http
DELETE /api/v1/orgs/{org}/repos/{repo}/tags/{name}
```

**Response (200)** – `{ "message": "Tag {name} removed" }`.

**Response (401)** – no or invalid OIDC token.

**Response (404)** – repository not found.

### POST /api/v1/orgs/{org}/repos/{repo}/branches

Create a new branch.

```http
POST /api/v1/orgs/{org}/repos/{repo}/branches
```

**Request Body:**

```json
{ "name": "new-feature", "startPoint": "main" } // startPoint optional
```

**Response (200)** – `{ "message": "Branch new-feature created" }`.

**Response (400)** – if `name` is missing.

**Response (401)** – no or invalid OIDC token.

**Response (404)** – repository not found.

### DELETE /api/v1/orgs/{org}/repos/{repo}/branches/{name}

Delete a branch. Git returns an error when the branch does not exist or cannot be deleted.
Branch/tag empty states in the UI show create actions that open HTML popover forms.

```http
DELETE /api/v1/orgs/{org}/repos/{repo}/branches/{name}
```

**Response (200)** – `{ "message": "Branch {name} removed" }`.

**Response (401)** – no or invalid OIDC token.

**Response (404)** – repository not found.

---

[OpenAPI 3.0.3]: https://swagger.io/specification/v3.0.3/
