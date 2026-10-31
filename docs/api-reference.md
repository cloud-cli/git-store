# API Reference

All URLs are relative to the server base URL (`http://localhost:3000` by default).

## Path parameters

- `{org}` – string, the organization slug (e.g. `my-org`).
- `{repo}` – string, the repository name (e.g. `myproject`).
- `{name}` – string, the tag or branch name.

## Organization access tokens

An authorized organization owner can manage Org Access Tokens in organization settings. Tokens are bound to the organization and optional repository, not to the user or agent that created them; removing that identity from the identity provider does not invalidate the automation token as long as the organization and token remain active. Creation, listing, revocation, and hiding require an interactive browser session from the current organization owner. These tokens use HTTP Basic authentication only on `/git/{org}/{repo}.git/...`; they are not bearer tokens and never authorize REST API requests. Secrets are returned only once and only their SHA-256 hashes are persisted. Scopes are `repo:read` and/or `repo:write`; tokens are constrained to exactly one organization and can optionally name one repository. Fetch requires read or write; push requires write. `expiresAt` is an optional future calendar date (`YYYY-MM-DD`).

Org Access Tokens require the configured d0 SQLite database and are unavailable when `DATABASE_URL` is not set. Existing `machine-git-credentials.json` records are imported transactionally once; the source file is retained.

- `GET /api/v1/orgs/{org}/machine-git-credentials` – list non-secret metadata, including revoked credentials with `revokedAt`; hidden credentials are omitted.
- `POST /api/v1/orgs/{org}/machine-git-credentials` – create with `{ "label": "build agent", "scopes": ["repo:read"], "repo": "optional-repo", "expiresAt": "optional-date" }`; response includes the one-time `token` and public `record`.
- `DELETE /api/v1/orgs/{org}/machine-git-credentials/{id}` – revoke (backward-compatible); revoked records remain listed for audit history.
- `DELETE /api/v1/orgs/{org}/machine-git-credentials/{id}/deleted` – hide an already-revoked credential from lists. The database record/hash remain for audit, and active credentials cannot be hidden.

Use the token as the Basic-auth password (the username is ignored), for example `https://USER:TOKEN@git.example/git/acme/widgets.git`. Avoid embedding secrets in shell history or repository remotes; use a credential helper or CI secret store.

## Authentication and authorization

API and Git bearer credentials must be active OIDC tokens validated through the configured
issuer's introspection endpoint and registered in GitMini's local token authorization store.
Introspection authenticates the token and supplies its `sub`; its scope claim does not grant
GitMini permissions. GitMini stores only a SHA-256 token fingerprint, the subject hash, local
capabilities, and explicit organization grants. Unregistered active bearer tokens are denied.
The local capabilities are:

- `repo:read` – read repositories; `repo:write` – mutate repositories and also read them.
- `org:create` – create organizations; a token is granted only the organization it creates.
- `org:manage` – delete empty granted organizations and manage their webhook settings.
- Every bearer token is limited to the organizations explicitly listed in its local grants;
  organizations the subject owns are not implicitly visible.
- Listing, creating, binding, editing, or revoking token authorization records requires an
  authenticated same-origin browser session. Bearer tokens cannot manage token grants.
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

The browser UI signs in through `/ui/auth/login` using authorization code + PKCE and requests
`offline_access`. `openid-client` validates the callback state and PKCE exchange and the
ID-token claims; the Auth Node client verifies that the UserInfo subject matches before
GitMini issues a signed HttpOnly same-origin cookie. When the provider grants a refresh token,
GitMini stores it in the encrypted `DATA_PATH` session store and rotates it
server-side as access tokens approach expiry, and renews the cookie for an active session.
Neither access nor refresh tokens are sent to the browser. Browser-session scopes come from
`OIDC_BROWSER_SCOPES`; cookie-authenticated repository writes require same-origin requests.
Profile nicknames and display names never determine repository ownership.

Git Smart HTTP uses HTTP Basic authentication at `/git/{org}/{repo}.git`. The username is
ignored; the password must be an active, locally authorized OIDC access token. Git fetch
(`git-upload-pack`) requires locally granted `repo:read` or `repo:write`; Git push
(`git-receive-pack`) requires locally granted `repo:write`. Git transport does not accept
browser session cookies. Use HTTPS so the Basic credential is encrypted in transit. GitMini
also issues local personal access tokens; both credential kinds use the same local grants.

Public endpoints (`/api`, `/api/v1/health`, `/ui/config`, `/ui/session`) do not require authentication.

## Team roles and invitations

Team membership applies to same-origin browser sessions only. It does not grant access to Git Smart HTTP,
organization access tokens, bearer tokens, or personal access tokens; those credentials retain their own explicit
scope and organization grants. A team owner invites an OIDC subject (`sub`) directly, and the invited account
must sign in and accept the matching invitation. Invitations expire after 30 days. The stored subject values
are SHA-256 hashes.

The roles apply to all current and future organizations owned by the inviter:

- `viewer`: read repositories (`repo:read`).
- `contributor`: read and write repositories (`repo:read`, `repo:write`).
- `admin`: read/write repositories and manage owned organizations (`repo:read`, `repo:write`, `org:manage`).
  Organization creation and team-roster administration remain owner-only.

Team endpoints require an authenticated same-origin browser session. `GET /api/v1/team` returns the current
user's team roster, outgoing and incoming invitations, and memberships. `POST /api/v1/team/invitations`
accepts `{ "sub": "<invitee-sub>", "role": "viewer|contributor|admin" }`; owners can cancel with
`DELETE /api/v1/team/invitations/{id}`. The target account accepts with
`POST /api/v1/team/invitations/{id}/accept`. Owners change a member's role with
`PATCH /api/v1/team/members/{memberId}` using `{ "role": "viewer|contributor|admin" }` and remove a member
with `DELETE /api/v1/team/members/{memberId}`. The member ID is an opaque per-team identifier returned by
the team endpoint.

## Endpoints

### Token authorization management

Token metadata and grants are managed only from an authenticated same-origin browser session.
`GET /api/v1/personal-access-tokens` lists records; `POST` creates a GitMini token from
`{ "label": "Notes app", "scopes": ["repo:read"], "orgs": ["notes"] }` and returns the
generated secret once. `PATCH /api/v1/personal-access-tokens/{id}` edits its label, local
capabilities and organization grants; `DELETE` revokes it. A valid external OIDC token can be
bound with `POST /api/v1/token-authorizations` using `{ "token": "<opaque-token>", "label":
"Notes app", "scopes": ["repo:read"], "orgs": ["notes"] }`. GitMini verifies the token is
active, was issued for GitMini's configured OIDC client, and belongs to the signed-in subject,
then stores only its hash. The raw external token is not returned or stored. Auth introspection
is client-bound, so tokens issued for a different OIDC client cannot be bound by this service.
Both credential types use the same local grant enforcement.

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
cookie is valid, otherwise `{ "authenticated": false, "profile": null }`. If the provider
granted a refresh token and the access token is near expiry, this server-side request can
refresh the token grant and renew the session cookie without an interactive sign-in.

```http
GET /ui/session
```

The endpoint can also identify an active bearer token passed in the `Authorization` header.

### GET /ui/auth/login

Start the OIDC authorization-code flow with PKCE and the `offline_access` scope. The
service saves short-lived state and verifier cookies and redirects to the configured
issuer. An optional same-origin `returnTo` path is restored after sign-in.

### GET /ui/auth/callback

Configured OIDC redirect URI. Validates state and the PKCE exchange, exchanges the authorization code,
confirms the access token and subject, then establishes the local HttpOnly browser session. If the provider
grants a refresh token, GitMini retains it only in the encrypted server-side session store.
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

List organizations owned by the authenticated subject and, for bearer tokens, explicitly
granted to that token. Browser sessions list all organizations owned by the user.

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

List repositories in an organization owned by the authenticated subject and explicitly granted
to the bearer token, if applicable.

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
GET /api/v1/orgs/{org}/repos/{repo}/log?limit=1
```

The optional `limit` query parameter must be between 1 and 1000. When omitted, the full
repository log is returned.

**Response (200)** – JSON array of commit objects (may be empty).

**Response (404)** – repository not found.

**Response (400)** – invalid `limit` value.

### GET /api/v1/orgs/{org}/repos/{repo}/tree

List repository files/tree.

```http
GET /api/v1/orgs/{org}/repos/{repo}/tree
```

**Response (200)** – JSON array of file/directory entries.

**Response (404)** – repository not found.

**Query parameters**

- `path` – optional relative path within the repository to list entries from.
- `worktreeId` – optional managed worktree ID; omitted selects the primary working tree.
- `ref` – optional branch, tag, or commit SHA. When supplied, returns a recursive committed-tree
  response equivalent to `git ls-tree -r` rather than the working-tree directory array:

```json
{
  "ref": "wds-artifacts",
  "commit": "<resolved-commit-sha>",
  "files": [{ "path": "latest/component.html", "mode": "100644", "type": "blob", "sha": "<blob-sha>" }]
}
```

When `ref` and `worktreeId` are both supplied, the ref is resolved using the selected
worktree's shared object store. File paths, modes, object types, and blob/gitlink SHAs are
returned; file contents are not.

### GET /api/v1/orgs/{org}/repos/{repo}/file

Read a repository file.

```http
GET /api/v1/orgs/{org}/repos/{repo}/file
```

**Query parameters**

- `path` – relative path to the file within the repository.
- `ref` (optional) – branch, tag, or commit to read committed content. When omitted, the
  current working-tree file is read.

**Response (200)** – text files are returned as UTF-8 `text/plain`. Supported raster image
extensions (`.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.avif`, `.bmp`) are returned as their
image MIME type with original bytes so browsers can preview them. Other file types are returned
as UTF-8 `text/plain`; SVG and other active formats are not served as inline images.
When `ref` is supplied, the response includes `X-Git-Commit` with the resolved commit SHA.
`HEAD` is supported and returns the same headers and status as `GET` without a response body.

**Response (400)** – invalid path or path traversal detected.

**Response (404)** – file not found.

**Response (413)** – committed Git object exceeds 10 MiB. Ref reads reject `.git` paths,
symlinks, and submodules.

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

### DELETE /api/v1/orgs/{org}/repos/{repo}/files

Delete one existing regular file from the repository working tree. The operation does
not stage or commit the deletion. The required `path` query parameter is repository-relative.
Directories, `.git` paths, traversal, and paths that escape through symlinks are rejected.

```http
DELETE /api/v1/orgs/my-org/repos/my-repo/files?path=README.md
```

**Response (200)** – `{ "path": "README.md", "deleted": true, "staged": false }`.

**Response (400)** – missing/blank/invalid path or path is not a regular file.

**Response (401)** – no or invalid OIDC token.

**Response (403)** – token lacks `repo:write`.

**Response (404)** – organization, repository, or file not found.

### Managed worktrees

Worktrees provide isolated working directories for API-driven automation without requiring a
clone. Create one from a branch, tag, or commit SHA with `POST
/api/v1/orgs/{org}/repos/{repo}/worktrees` and `{ "ref": "<ref-or-sha>" }`. GitMini resolves
the input to a commit SHA and creates a detached worktree. To create a new branch at that
commit, use the existing branch API with `startPoint` set to the ref or SHA. Worktrees are
intentionally detached so branch-target atomic commits do not leave a checked-out worktree's
index stale. The response contains a server-generated `worktreeId`, resolved `ref` SHA, and
`branch: null`. Clients never provide a filesystem path.

`GET .../worktrees` lists managed worktrees; `DELETE .../worktrees/{id}` removes a clean
worktree. Dirty worktrees return **409** and are not forcibly removed. Repository deletion is
also rejected while linked worktrees remain. Worktrees and their IDs survive service restarts.

Pass `worktreeId` as a query parameter to working-tree `GET /tree`, `GET /file`, `POST /files`,
`DELETE /files`, and `GET /history` operations to select that worktree. Omitting it preserves
the primary-working-tree behavior. File writes remain unstaged; use the atomic commits API to
create commits on a target branch. When `ref` is supplied to `GET /tree`, it returns the
recursive committed tree (equivalent to `git ls-tree -r`) with `path`, `mode`, `type`, and blob
or gitlink `sha` fields. A `worktreeId` may also be supplied; refs resolve in that worktree's
shared repository object store. The `ref` response field echoes the requested ref, while
`commit` is its resolved commit SHA.

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

# Organization webhooks

Owned, token-granted organizations can manage webhook subscriptions at `/api/v1/orgs/{org}/webhooks`. Listing requires `repo:read`; creation, deletion, and test-event requests require `org:manage`. Create requests require a user-defined `secret` (1–1024 UTF-8 bytes), used as the HMAC-SHA-256 key and never returned by the API. Secrets are stored encrypted using `WEBHOOK_ENCRYPTION_KEY`, configured as exactly 32 random bytes encoded in 64 hexadecimal characters; without this distinct key, webhook storage and create/list/delete/test APIs are disabled. Changing the encryption key makes existing encrypted secrets undecryptable. `allowedIpRanges` is an optional newline-separated string of up to 64 IPv4 or IPv6 CIDRs (maximum 4096 bytes); listed ranges explicitly permit otherwise non-public endpoint addresses. Every resolved endpoint address must be either public or within an allowed range. Resolved addresses are pinned to the HTTPS connection, and redirects are not followed. Verify `X-GitMini-Signature` (`sha256=<hex>`) as HMAC-SHA-256 of the exact JSON request body. Delivery uses `X-GitMini-Event` and `X-GitMini-Delivery` headers. Each organization is limited to 20 subscriptions. Delivery is best effort: at most four deliveries run concurrently, up to 100 wait in the in-memory queue (excess deliveries are dropped), with up to three attempts and a five-second request timeout. Pending deliveries are lost on process restart. Security-denial, PAT and staging events are not subscribed by default.

Creating a webhook queues a signed `webhook.ping` event to that endpoint; the creation response's `testEvent.status` is `accepted` or `dropped`. Retrigger it with `POST /api/v1/orgs/{org}/webhooks/{id}/test`; the event is targeted to that subscription and does not require any event subscription to be selected.

```http
POST /api/v1/orgs/{org}/webhooks/{id}/test
```

The endpoint returns `202` when queued, not delivered. The payload uses `action: "ping"`, `object: "{org}"`, and `details: { "message": "Hello from GitMini" }`. A full queue returns `503` with `Retry-After: 1` for explicit test requests; webhook creation still succeeds and reports the test event as dropped if it cannot be queued.

Subscriptions accept exactly `git`, `repo`, and `thread`. `repo` delivers only repository creation and deletion. `git` delivers one `git.push` after each successful push, with top-level `action: "pushed"` and `details.changes[]` entries containing `ref`, `before`, `after`, and `action`; it also delivers `git.branch` and `git.tag` for each changed branch/tag ref, including refs changed by a push and API branch/tag operations. These ref events use top-level `action` (`created`, `updated`, or `deleted`); ref is a payload detail and is not selectable. The audit stream retains detailed per-ref events. Legacy stored subscriptions are retained where feasible. `thread` can be selected but currently has no source and does not deliver events. Its planned future payload anchors a thread to an immutable commit SHA and includes repository, ref, path, line ranges, selected lines, and immutable comments with comment IDs and bodies; no thread storage or API is implemented. Payload details can contain repository-controlled values, so configure only trusted receivers. Event IDs support consumer-side deduplication. Organization lifecycle, working-tree file, API commit, staging/unstaging, PAT, and security events are not delivered.

# Atomic commits

`POST /api/v1/orgs/{org}/repos/{repo}/commits` creates one commit on a local branch and returns `{ "commit": "<sha>", "ref": "refs/heads/<branch>" }`. It requires `repo:write` and an explicit organization grant. `targetBranch` selects the branch and defaults to `main`.

Send `{ "expectedRef": "<branch-head-sha>", "targetBranch": "automation/change-123", "message": "...", "changes": [{ "path": "file.txt", "content": "<base64>" }, { "path": "old.txt", "delete": true }] }`. For an unborn target branch, `expectedRef` may be `null`; otherwise it must match the current target branch SHA. A mismatch or concurrent ref update returns 409. All members are validated before Git objects are written. Paths must be relative and unique, cannot contain comma or NUL, cannot conflict as file/directory paths, and may not contain a `.git` component; each content is strict base64, at most 10 MiB total, 200 changes maximum, and messages are limited to 10,000 characters. Deleting a nonexistent path is a no-op. Changes are based on the selected branch's committed tree (not staged or working-tree content); all shared working trees and indexes are left unchanged.

When creating a tag with `POST /api/v1/orgs/{org}/repos/{repo}/tags`, optional `target` may name a branch, tag, or commit SHA. GitMini resolves it to a commit before creating the tag. Omitting `target` preserves the existing `HEAD` default.
