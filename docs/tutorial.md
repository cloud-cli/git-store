# Tutorial – Managing a Git repository through the API

This step‑by‑step guide assumes the server is running at `http://localhost:3000`
and that you have an OIDC access token (obtained from `https://auth.api.apphor.de`
or any OIDC‑compatible provider).  Replace `<TOKEN>` with that token throughout.

## 1. Create a repository

```bash
curl -X POST http://localhost:3000/repos/myorg/myproject
```

Response:

```json
{ "message": "Repository myorg/myproject is ready", "path": "/data/myorg/myproject" }
```

## 2. Verify the repo is empty

```bash
curl http://localhost:3000/repos/myorg/myproject/log
```

Response (empty array):

```json
[]
```

## 3. Add a file and stage it

```bash
# Create a dummy file inside the repo (the container has the data volume at /data)
echo "Hello Git Store" > ./data/myorg/myproject/README.md
```

Stage the file:

```bash
curl -X POST http://localhost:3000/repos/myorg/myproject/stage \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"files":["README.md"]}'
```

Response:

```json
{ "message": "Files staged successfully" }
```

## 4. Autocommit the staged changes

```bash
curl -X POST http://localhost:3000/repos/myorg/myproject/commit \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"message":"initial commit"}'
```

Response:

```json
{ "message": "Changes committed successfully", "commit": "initial commit" }
```

## 5. Add a tag

```bash
curl -X POST http://localhost:3000/repos/myorg/myproject/tags \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"v1.0"}'
```

Response:

```json
{ "message": "Tag v1.0 added" }
```

## 6. Create a branch

```bash
curl -X POST http://localhost:3000/repos/myorg/myproject/branches \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"dev"}'
```

Response:

```json
{ "message": "Branch dev created" }
```

## 7. Delete the branch (cleanup)

```bash
curl -X DELETE http://localhost:3000/repos/myorg/myproject/branches/dev \
  -H "Authorization: Bearer <TOKEN>"
```

Response:

```json
{ "message": "Branch dev removed" }
```

## 8. Remove the tag (optional)

```bash
curl -X DELETE http://localhost:3000/repos/myorg/myproject/tags/v1.0 \
  -H "Authorization: Bearer <TOKEN>"
```

Response:

```json
{ "message": "Tag v1.0 removed" }
```

## 9. (Optional) View the full log after commits

```bash
curl http://localhost:3000/repos/myorg/myproject/log
```

You should now see at least one commit object containing `oid`, `message`, `author`, `date`, etc.

## Summary of flow

1. `POST /repos` – create the directory.
2. (Optional) edit files on disk – the server does not provide a fetch/write API; you edit files in the `DATA_PATH` directory directly.
3. `POST /repos/{owner}/{repo}/stage` – tell Git to stage selected files.
4. `POST /repos/{owner}/{repo}/commit` – create a commit with a message.
5. `POST /repos/{owner}/{repo}/tags` / `DELETE /repos/{owner}/{repo}/tags/{name}` – version marking.
6. `POST /repos/{owner}/{repo}/branches` / `DELETE /repos/{owner}/{repo}/branches/{name}` – line‑of‑development isolation.

All mutating endpoints require a valid OIDC bearer token; `GET /health` and `GET /api` are public.
