# TODO

## Completed

- [x] Store repositories under a hashed stable OIDC `sub` directory and short repo name.
- [x] Provide repository creation, log, stage, unstage, commit, tag, and branch routes.
- [x] Serve an OpenAPI document from `GET /api` covering all routes.
- [x] Require authenticated OIDC identity for repository listing, creation, reads, and mutations.
- [x] Use `/home/app` as the Docker application directory.
- [x] Add Node-only integration checks for subject isolation and unauthorized behavior.
- [x] Add Diátaxis tutorial, how-to/getting-started, and reference documentation.
- [x] Migrate repository storage to hashed subject directories (`sub` hashed).
- [x] Remove `owner` from API routes (now `:repo` only).
- [x] Add repository name validation.
- [x] Implement identity isolation across two injected subjects.
- [x] Spoofed old owner route rejected.
- [x] Path traversal rejected.
- [x] Require `repo:read` for reads and `repo:write` for repository creation and mutations; write scope includes read access.
- [x] Verify read-only and unscoped API tokens cannot create or mutate repositories.
- [x] Add native anchored popovers, empty branch/tag states, empty-repository onboarding, file input, and existing-repo drag/drop.
- [x] Keep repository ownership and display keyed by stable OIDC subject / repo name rather than nickname.

## Next iteration

- [ ] Run authenticated end-to-end mutation tests with provisioned OIDC credentials.
- [x] Build and smoke-test the Docker image locally, including `/health` and `/api`.
- [x] Verify CI Docker build status and inspect the failed NPM publish logs.
- [x] Add static UI checks for repo-only navigation and outside-click backdrop wiring.
- [x] Verify mobile sidebar outside-click behavior in Playwright.
- [x] Verify native upload input and drag/drop feedback in Playwright.
- [ ] Run authenticated end-to-end mutation checks with provisioned OIDC credentials.
- [ ] Fix CI NPM publishing provenance once the runner provides a supported provenance identity; latest failure is `EUSAGE: Automatic provenance generation not supported for provider: null`.
