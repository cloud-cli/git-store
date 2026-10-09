# Tutorial – Managing a Git repository through the API

This step‑by‑step guide assumes the server is running at `http://localhost:3000`
and that you have an OIDC access token (obtained from your configured OIDC issuer).
Replace `<TOKEN>` with that token throughout. The token must carry `repo:read` for
listing repositories and `repo:write` for mutations—the latter includes read access.

The browser UI uses a same-origin session cookie only after the configured issuer's
`/profile` endpoint confirms a non-empty `sub`. API clients without the required scope
receive 403; unauthenticated requests receive 401.

## 1. Create an organization

Organization slugs are globally unique, lowercase, and case-insensitive on input.

```bash
curl -X POST http://localhost:3000/api/v1/orgs \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"slug":"my-org"}'
```

Response (201):

```json
{ "org": { "slug": "my-org" } }
```

## 2. Create a repository (empty onboarding)

```bash
curl -X POST http://localhost:3000/api/v1/orgs/my-org/repos/myproject \
  -H "Authorization: Bearer <TOKEN>"
```

Response (201):

```json
{ "message": "Repository myproject is ready", "repo": "myproject" }
```

The new repository starts empty. The UI presents a welcome screen with a file input;
uploading the first file stages and commits it. API clients can add content with the JSON
upload endpoint and then stage and commit it.

## 3. Verify the repo is empty

```bash
curl -H "Authorization: Bearer <TOKEN>" http://localhost:3000/api/v1/orgs/my-org/repos/myproject/log
```

Response (empty array for new repository):

```json
[]
```

### Uploading a file through the API

The API accepts base64-encoded bytes in a JSON body:

```bash
# Encode a file and send the required JSON body
curl -X POST http://localhost:3000/api/v1/orgs/my-org/repos/myproject/files \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d "{\"path\":\"README.md\",\"content\":\"$(base64 -w0 myfile.txt)\"}"
```

The endpoint writes the file unstaged and returns **201 Created**. Use an empty
`"content"` string to create an empty file.

## 4. Add a file and stage it

Stage the existing README.md (or any file you added earlier):

```bash
curl -X POST http://localhost:3000/api/v1/orgs/my-org/repos/myproject/stage \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"files":["README.md"]}'
```

Response:

```json
{ "message": "Files staged successfully" }
```

### Add-file form behavior (UI)

The repository viewer's **Add file** popover creates a file at the supplied full relative
path, stages it, and commits it. The file may be empty. In an empty repository, the
welcome screen's file input instead uploads and commits the selected file.

For existing repositories, dropping files on the file list or selecting files from the
upload button writes them unstaged. Use the commit form to stage and commit changes.

## 5. Autocommit the staged changes

```bash
curl -X POST http://localhost:3000/api/v1/orgs/my-org/repos/myproject/commit \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"message":"initial commit"}'
```

Response:

```json
{ "message": "Changes committed successfully", "commit": "initial commit" }
```

## 6. Add a tag

```bash
curl -X POST http://localhost:3000/api/v1/orgs/my-org/repos/myproject/tags \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"v1.0"}'
```

Response:

```json
{ "message": "Tag v1.0 added" }
```

## 7. Create a branch (after an initial commit)

```bash
curl -X POST http://localhost:3000/api/v1/orgs/my-org/repos/myproject/branches \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"dev"}'
```

Response (200):

```json
{ "message": "Branch dev created" }
```

An empty repository has no branches or tags until it has a commit. The UI still displays
“No branches. Create one” and “No tags. Create one” actions, with a popover form for each.

## 8. Delete the branch (cleanup)

```bash
curl -X DELETE http://localhost:3000/api/v1/orgs/my-org/repos/myproject/branches/dev \
  -H "Authorization: Bearer <TOKEN>"
```

Response:

```json
{ "message": "Branch dev removed" }
```

## 9. Remove the tag (optional)

```bash
curl -X DELETE http://localhost:3000/api/v1/orgs/my-org/repos/myproject/tags/v1.0 \
  -H "Authorization: Bearer <TOKEN>"
```

Response:

```json
{ "message": "Tag v1.0 removed" }
```

## 10. (Optional) View the full log after commits

```bash
curl -H "Authorization: Bearer <TOKEN>" http://localhost:3000/api/v1/orgs/my-org/repos/myproject/log
```

You should now see at least one commit object containing `oid`, `message`, `author`, `date`, etc.

## Summary of flow

1. `POST /api/v1/orgs` – create an organization owned by the authenticated subject
2. `POST /api/v1/orgs/{org}/repos/{repo}` – create a repository in that organization (empty by default)
3. **(Optional) JSON upload** to add initial content, or use the browser's empty-repository file input
4. `POST /api/v1/orgs/{org}/repos/{repo}/stage` – tell Git to stage selected files
5. `POST /api/v1/orgs/{org}/repos/{repo}/commit` – create a commit with a message
6. `POST /api/v1/orgs/{org}/repos/{repo}/tags` / `DELETE /api/v1/orgs/{org}/repos/{repo}/tags/{name}` – version marking (release/tag model)
7. `POST /api/v1/orgs/{org}/repos/{repo}/branches` / `DELETE /api/v1/orgs/{org}/repos/{repo}/branches/{name}` – line‑of‑development isolation

**Form and UI behavior notes:**

- **Add-file popover**: accepts a full relative path; creates, stages, and commits an empty file.
- **HTML popovers**: anchored forms create repositories, branches, and tags.
- **Drag-drop/file-input upload**: sends base64-encoded file bytes as JSON; existing-repository uploads remain unstaged.
- **Empty repo onboarding**: the first UI file upload is staged and committed automatically.

All repository endpoints require authentication. `/api`, `/api/v1/health`, `/ui/config`, and `/ui/session` are public. Tags/branches empty states use HTML popovers only—no additional routes required.
