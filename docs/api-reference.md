# API Reference

All URLs are relative to the server base URL (`http://localhost:3000` by default).

## Common path parameters

- `{owner}` – string, the owner name (e.g. `myorg`).
- `{repo}` – string, the repository name (e.g. `myproject`).
- `{name}` – string, the tag or branch name.

## Endpoints

### GET /health

Return the service health status.

*No authentication required.*

```http
GET /health
```

**Response (200)**

```json
{ "status": "ok" }
```

### GET /api

Return the full [OpenAPI 3.0.0][] specification describing every other endpoint.

*No authentication required.*

```http
GET /api
```

**Response (200)** – JSON body is the spec.

### POST /repos/{owner}/{repo}

Create a new repository directory and initialise a Git repo if one does not exist yet.

```http
POST /repos/{owner}/{repo}
```

**Request Body:** none (empty JSON payload acceptable).

**Response (201)**

```json
{ "message": "Repository {owner}/{repo} is ready", "path": "/data/{owner}/{repo}" }
```

**Response (500)** – if the directory cannot be created.

### GET /repos/{owner}/{repo}/log

Stream the full commit log as JSON.

```http
GET /repos/{owner}/{repo}/log
```

**Response (200)** – JSON array of commit objects (may be empty).

**Response (404)** – repository directory or `.git` folder not found.

### GET /repos/{owner}/{repo}/tree

List the immediate files and directories in the repository or in the optional `path` query directory.

**Response (200)**

```json
[{ "name": "README.md", "path": "README.md", "type": "file" }]
```

### GET /repos/{owner}/{repo}/file?path=README.md

Read a text file for the browser preview. Paths are restricted to the repository root.

**Response (200)** – `text/plain` file contents.

**Response (400)** – path traversal or invalid path.

### GET /repos/{owner}/{repo}/history?path=README.md

Return commits affecting a file. A file with no history returns an empty array.

### GET /repos/{owner}/{repo}/branches

Return local branch names as a JSON array.

### GET /repos/{owner}/{repo}/tags

Return tag names as a JSON array.

### POST /repos/{owner}/{repo}/stage

Stage one or more files.

#### Authentication required (OIDC)

```http
POST /repos/{owner}/{repo}/stage
```

**Request Body**

```json
{ "files": ["path/to/file1", "path/to/file2"] }
```

**Response (200)**

```json
{ "message": "Files staged successfully" }
```

**Response (401)** – no or invalid OIDC token.

**Response (404)** – repository not found.

**Response (500)** – Git error.

### POST /repos/{owner}/{repo}/unstage

Unstage (reset) one or more files.

#### Authentication required (OIDC)

Same shape as `/stage`.

**Response (200)** – `{ "message": "Files unstaged successfully" }`.

### POST /repos/{owner}/{repo}/commit

Commit staged changes with an optional message (default `"autocommit"`).

#### Authentication required (OIDC)

```http
POST /repos/{owner}/{repo}/commit
```

**Request Body (optional)**

```json
{ "message": "my custom commit message" }
```

**Response (200)**

```json
{ "message": "Changes committed successfully", "commit": "my custom commit message" }
```

**Response (200)** – if no staged changes, `{ "message": "No changes to commit" }`.

### POST /repos/{owner}/{repo}/tags

Add an annotated tag to the current HEAD.

#### Authentication required (OIDC)

```http
POST /repos/{owner}/{repo}/tags
```

**Request Body**

```json
{ "name": "v1.0.0" }
```

**Response (200)** – `{ "message": "Tag v1.0.0 added" }`.

### DELETE /repos/{owner}/{repo}/tags/{name}

Delete a tag.

#### Authentication required (OIDC)

```http
DELETE /repos/{owner}/{repo}/tags/{name}
```

**Response (200)** – `{ "message": "Tag {name} removed" }`.

### POST /repos/{owner}/{repo}/branches

Create a new branch.

#### Authentication required (OIDC)

```http
POST /repos/{owner}/{repo}/branches
```

**Request Body**

```json
{ "name": "new-feature", "startPoint": "main" }   // startPoint optional
```

**Response (200)** – `{ "message": "Branch new-feature created" }`.

**Response (400)** – if `name` is missing.

### DELETE /repos/{owner}/{repo}/branches/{name}

Delete a branch.

#### Authentication required (OIDC)

```http
DELETE /repos/{owner}/{repo}/branches/{name}
```

**Response (200)** – `{ "message": "Branch {name} removed" }`.

[OpenAPI 3.0.0]: https://swagger.io/specification/v3.0.0/
