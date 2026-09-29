# TODO

## Completed

- [x] Store repositories under `DATA_PATH/owner/repo`.
- [x] Provide repository creation, log, stage, unstage, commit, tag, and branch routes.
- [x] Serve an OpenAPI document from `GET /api` covering all routes.
- [x] Protect mutation routes with bearer-token authentication and OIDC introspection.
- [x] Use `/home/app` as the Docker application directory.
- [x] Add Node-only integration checks for every endpoint's public/unauthorized behavior.
- [x] Add Diátaxis tutorial, how-to/getting-started, and reference documentation.

## Next iteration

- [ ] Run authenticated end-to-end mutation tests with provisioned OIDC credentials.
- [x] Build and smoke-test the Docker image locally, including `/health` and `/api`.
- [ ] Add validation for request bodies and repository-name/path safety.
- [ ] Verify CI workflow status and build logs after the next pushed commit.
- [ ] Decide whether repository creation should also require authentication.
