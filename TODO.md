# TODO

## Completed

- [x] Store repositories under a hashed stable OIDC `sub` directory and short repo name.
- [x] Provide repository creation, log, stage, unstage, commit, tag, and branch routes.
- [x] Serve an OpenAPI document from `GET /api/v1/openapi.json` covering all routes.
- [x] Require authenticated OIDC identity for repository listing, creation, reads, and mutations.
- [x] Use `/home/app` as the Docker application directory.
- [x] Add Node-only integration checks for subject isolation and unauthorized behavior.
- [x] Add Diátaxis tutorial, how-to/getting-started, and reference documentation.
- [x] Migrate repository storage to hashed subject directories (`sub` hashed).
- [x] Keep subject-scoped short repository routes and add immutable alias-qualified API/Git paths.
- [x] Add repository name validation.
- [x] Implement identity isolation across two injected subjects.
- [x] Prevent spoofed alias-qualified routes from crossing OIDC subject ownership.
- [x] Path traversal rejected.
- [x] Require `repo:read` for reads and `repo:write` for repository creation and mutations; write scope includes read access.
- [x] Verify read-only and unscoped API tokens cannot create or mutate repositories.
- [x] Add native anchored popovers, empty branch/tag states, empty-repository onboarding, file input, and existing-repo drag/drop.
- [x] Keep repository authority keyed by OIDC subject; expose a one-time immutable URL alias for integrators.
- [x] Default the UI theme to the system preference and improve dark-mode text contrast.
- [x] Preserve repo query state when redirecting `/` to `/ui/`.
- [x] Start browser login through OIDC authorization code + PKCE, validate state and ID-token claims, and keep access tokens server-side.
- [x] Remove dotenv and `.env` file loading; configure the service through process environment variables.
- [x] Test mocked browser login, callback, scoped session use, logout, and sign-in redirect.
- [x] Verify the deployed guest sign-in link redirects to the configured OIDC `/authorize` endpoint.

## Next iteration

- [x] Build and smoke-test the Docker image locally, including `/api/v1/health` and `/api/v1/openapi.json`.
- [x] Verify CI Docker build status and inspect the failed NPM publish logs.
- [x] Add static UI checks for repo-only navigation and outside-click backdrop wiring.
- [x] Verify mobile sidebar outside-click behavior in Playwright.
- [x] Verify native upload input and drag/drop feedback in Playwright.
- [x] Create a disposable Auth Lab OIDC client and configure Git Store to use its issuer/client.
- [x] Mint and revoke Auth Lab `repo:read`/`repo:write` API tokens and verify scope enforcement against an isolated local Git Store process.
- [x] Configure JWT signing in disposable Auth Lab and verify its JWKS endpoint.
- [x] Sign in through Auth Lab's test key, complete the live Git Store OIDC callback, and verify the browser session and scopes.
- [x] Verify live `repo:read` and `repo:write` API token behavior; revoke temporary test tokens after use.
- [ ] Fix CI NPM publishing provenance once the runner provides a supported provenance identity; latest failure is `EUSAGE: Automatic provenance generation not supported for provider: null`.
