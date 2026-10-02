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
- [x] Start browser login through OIDC authorization code + PKCE, validate state/nonce, and keep access tokens server-side.
- [x] Remove dotenv and `.env` file loading; configure the service through process environment variables.
- [x] Test mocked browser login, callback, scoped session use, logout, and sign-in redirect.
- [x] Verify the deployed guest sign-in link redirects to the configured OIDC `/authorize` endpoint.

## Next iteration

- [x] Build and smoke-test the Docker image locally, including `/health` and `/api`.
- [x] Verify CI Docker build status and inspect the failed NPM publish logs.
- [x] Add static UI checks for repo-only navigation and outside-click backdrop wiring.
- [x] Verify mobile sidebar outside-click behavior in Playwright.
- [x] Verify native upload input and drag/drop feedback in Playwright.
- [x] Create a disposable Auth Lab OIDC client and configure Git Store to use its issuer/client.
- [x] Mint and revoke Auth Lab `repo:read`/`repo:write` API tokens and verify scope enforcement against an isolated local Git Store process.
- [ ] Run authenticated end-to-end provider mutation checks with provisioned production OIDC credentials.
- [ ] Enable JWT signing in Auth Lab (`/.well-known/jwks.json` currently returns 503) before completing the browser OIDC callback.
- [ ] Fix CI NPM publishing provenance once the runner provides a supported provenance identity; latest failure is `EUSAGE: Automatic provenance generation not supported for provider: null`.
