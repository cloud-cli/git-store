# Git Store

A minimal HTTP API for managing multiple Git repositories on disk.

## Features
- Create a repository: `POST /repos/:owner/:repo`
- View commit log: `GET /repos/:owner/:repo/log`
- Stage files: `POST /repos/:owner/:repo/stage`
- Unstage files: `POST /repos/:owner/:repo/unstage`
- Commit staged changes: `POST /repos/:owner/:repo/commit`
- Tag management: `POST /repos/:owner/:repo/tags` and `DELETE /repos/:owner/:repo/tags/:name`
- Branch management: `POST /repos/:owner/:repo/branches` and `DELETE /repos/:owner/:repo/branches/:name`

## Setup
```bash
# Build Docker image
docker build -t git-store .

# Run container
docker run -d -p 3000:3000 -v \\$PWD/data:/data git-store
```

The data is stored under the environment variable `DATA_PATH`, defaulting to `/data`.

## Development
```bash
# Install dependencies
npm install

# Run tests
npm test
```

## API Reference
[Documentation can be expanded here]
