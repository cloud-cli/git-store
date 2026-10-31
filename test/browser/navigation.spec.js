/* global window */
import { test, expect } from "playwright/test";
let currentEntries;
let currentBranches;
let currentTags;
let currentCommits;
let currentRepositories;
let currentEvents;
let currentPersonalAccessTokens;
let currentOrgWebhooks;
let testWebhookRequests;
let currentMachineCredentials;
let machineCredentialRequests;
let createdOrgWebhookRequest;
let webhookApiDisabled;
let expectedWebhookHttpErrors;
let createdPersonalAccessTokenRequest;
let createdTokenAuthorizationRequest;
let bootstrapSession;
let runtimeErrors;
let imageBytes;
let tailwindSource;
let lucideComponentSource;
let codeBlockComponentSource;
let highlightSource;
let lightHighlightTheme;
let darkHighlightTheme;
const lucideModuleCache = new Map();

test.beforeAll(async () => {
  const [
    tailwindResponse,
    lucideResponse,
    codeBlockResponse,
    highlightResponse,
    lightThemeResponse,
    darkThemeResponse,
  ] = await Promise.all([
    fetch("https://unpkg.com/@tailwindcss/browser@4"),
    fetch("https://sodium.static.apphor.de/lucide-icon.html"),
    fetch("https://sodium.static.apphor.de/code-block.html"),
    fetch("https://unpkg.com/@highlightjs/cdn-assets@11.11.1/es/highlight.min.js"),
    fetch("https://unpkg.com/@highlightjs/cdn-assets@11.11.1/styles/github.min.css"),
    fetch("https://unpkg.com/@highlightjs/cdn-assets@11.11.1/styles/atom-one-dark.min.css"),
  ]);
  if (
    !tailwindResponse.ok ||
    !lucideResponse.ok ||
    !codeBlockResponse.ok ||
    !highlightResponse.ok ||
    !lightThemeResponse.ok ||
    !darkThemeResponse.ok
  ) {
    throw new Error(
      `Failed to fetch browser UI assets (Tailwind ${tailwindResponse.status}, Lucide ${lucideResponse.status}, code-block ${codeBlockResponse.status}, Highlight.js ${highlightResponse.status})`,
    );
  }
  tailwindSource = await tailwindResponse.text();
  lucideComponentSource = await lucideResponse.text();
  codeBlockComponentSource = await codeBlockResponse.text();
  highlightSource = await highlightResponse.text();
  lightHighlightTheme = await lightThemeResponse.text();
  darkHighlightTheme = await darkThemeResponse.text();
});

test.beforeEach(async ({ page }) => {
  runtimeErrors = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      if (expectedWebhookHttpErrors > 0 && message.text().startsWith("Failed to load resource:")) {
        expectedWebhookHttpErrors -= 1;
        return;
      }
      runtimeErrors.push(message.text());
    }
  });
  page.on("requestfailed", (request) => runtimeErrors.push(`${request.url()}: ${request.failure()?.errorText}`));
  const li3Source = await fetch("https://at-li3.static.apphor.de/web").then((response) => response.text());
  const imageData = await page.evaluate(() => {
    const canvas = window.document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d");
    context.fillStyle = "#4f46e5";
    context.fillRect(0, 0, 1, 1);
    return canvas.toDataURL("image/jpeg").split(",")[1];
  });
  imageBytes = Buffer.from(imageData, "base64");
  currentEntries = [
    { path: "notes.txt", name: "notes.txt", type: "file" },
    { path: "photo.jpg", name: "photo.jpg", type: "file" },
    { path: "app.js", name: "app.js", type: "file" },
    { path: "docs", name: "docs", type: "directory" },
  ];
  currentBranches = ["main"];
  currentTags = [];
  currentCommits = [
    {
      hash: "abcdef123456",
      message: "Initial commit",
      author_name: "Browser Tester",
    },
  ];
  currentRepositories = [{ repo: "demo" }];
  currentPersonalAccessTokens = [
    {
      id: "pat_000000000000000000000001",
      label: "Existing integration",
      scopes: ["repo:read"],
      orgs: ["example"],
      org: null,
      repo: null,
      createdAt: "2026-05-01T12:00:00.000Z",
      expiresAt: null,
    },
  ];
  createdPersonalAccessTokenRequest = null;
  createdTokenAuthorizationRequest = null;
  currentOrgWebhooks = [];
  testWebhookRequests = [];
  currentMachineCredentials = [];
  machineCredentialRequests = [];
  createdOrgWebhookRequest = null;
  webhookApiDisabled = false;
  expectedWebhookHttpErrors = 0;
  currentEvents = [
    {
      id: "event-1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      subject: "oidc-subject",
      actorName: "Browser Tester",
      event: "git.branch.created",
      object: "example/demo@refs/heads/main",
      origin: "git-token",
    },
  ];
  bootstrapSession = {
    checked: true,
    authenticated: true,
    canWrite: true,
    profile: {
      sub: "browser-tester-subject",
      name: "Browser Tester",
      email: "browser@example.test",
      picture: "https://images.example.test/avatar.png",
    },
  };
  await page.addInitScript(() => {
    window.__documentNavigationCount = 0;
    window.addEventListener("beforeunload", () => {
      window.__documentNavigationCount += 1;
    });
  });
  await page.route("https://at-li3.static.apphor.de/web", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      headers: { "access-control-allow-origin": "*" },
      body: li3Source,
    }),
  );
  await page.route("https://unpkg.com/@tailwindcss/browser@4", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: tailwindSource,
    }),
  );
  await page.route("https://sodium.static.apphor.de/lucide-icon.html", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      headers: { "access-control-allow-origin": "*" },
      body: lucideComponentSource,
    }),
  );
  await page.route("https://sodium.static.apphor.de/code-block.html", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      headers: { "access-control-allow-origin": "*" },
      body: codeBlockComponentSource,
    }),
  );
  await page.route("https://unpkg.com/@highlightjs/cdn-assets@11.11.1/es/highlight.min.js", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      headers: { "access-control-allow-origin": "*" },
      body: highlightSource,
    }),
  );
  await page.route("https://unpkg.com/@highlightjs/cdn-assets@11.11.1/styles/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/css",
      headers: { "access-control-allow-origin": "*" },
      body: route.request().url().includes("atom-one-dark") ? darkHighlightTheme : lightHighlightTheme,
    }),
  );
  await page.route("https://unpkg.com/lucide@latest/dist/esm/**", async (route) => {
    const url = route.request().url();
    if (!lucideModuleCache.has(url)) {
      const response = await fetch(url);
      lucideModuleCache.set(url, {
        status: response.status,
        contentType: response.headers.get("content-type") || "application/javascript",
        body: await response.text(),
      });
    }
    const module = lucideModuleCache.get(url);
    await route.fulfill({
      status: module.status,
      contentType: module.contentType,
      headers: { "access-control-allow-origin": "*" },
      body: module.body,
    });
  });
  await page.route("https://cdnjs.cloudflare.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/css", body: "" }),
  );
  await page.route("https://images.example.test/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/rWQAAAAASUVORK5CYII=",
        "base64",
      ),
    }),
  );
  await page.route("**/ui/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname !== "/ui/" && pathname !== "/ui/index.html") {
      return route.continue();
    }
    const response = await route.fetch();
    const html = await response.text();
    const sessionScript = `<script state>${JSON.stringify({ serverSession: bootstrapSession })}</script>`;
    return route.fulfill({
      response,
      body: html.replace(/<script state>[\s\S]*?<\/script>/, sessionScript),
    });
  });
  await page.route("**/ui/session", (route) =>
    route.fulfill({
      json: {
        ...bootstrapSession,
        authenticated: bootstrapSession.authenticated,
      },
    }),
  );
  await page.route("**/ui/auth/logout", (route) => {
    bootstrapSession = { checked: true, authenticated: false, profile: null, canWrite: false };
    return route.fulfill({ status: 204 });
  });
  await page.route("**/ui/config", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/v1/personal-access-tokens**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/v1/personal-access-tokens" && request.method() === "GET") {
      return route.fulfill({ json: { tokens: currentPersonalAccessTokens } });
    }
    if (pathname === "/api/v1/personal-access-tokens" && request.method() === "POST") {
      createdPersonalAccessTokenRequest = JSON.parse(request.postData());
      const record = {
        id: "pat_000000000000000000000002",
        ...createdPersonalAccessTokenRequest,
        org: null,
        repo: null,
        createdAt: "2026-05-02T12:00:00.000Z",
        expiresAt: createdPersonalAccessTokenRequest.expiresAt || null,
      };
      currentPersonalAccessTokens = [record, ...currentPersonalAccessTokens];
      return route.fulfill({
        status: 201,
        json: { token: "gmpat_browser_test_secret", record },
      });
    }
    if (pathname.startsWith("/api/v1/personal-access-tokens/") && request.method() === "PATCH") {
      const tokenId = pathname.split("/").at(-1);
      const update = JSON.parse(request.postData());
      currentPersonalAccessTokens = currentPersonalAccessTokens.map((token) =>
        token.id === tokenId ? { ...token, ...update } : token,
      );
      return route.fulfill({ json: { token: currentPersonalAccessTokens.find((token) => token.id === tokenId) } });
    }
    if (pathname.startsWith("/api/v1/personal-access-tokens/") && request.method() === "DELETE") {
      const tokenId = pathname.split("/").at(-1);
      currentPersonalAccessTokens = currentPersonalAccessTokens.filter((token) => token.id !== tokenId);
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.route("**/api/v1/token-authorizations", async (route) => {
    createdTokenAuthorizationRequest = JSON.parse(route.request().postData());
    return route.fulfill({
      status: 201,
      json: { token: { id: "pat_imported", label: createdTokenAuthorizationRequest.label } },
    });
  });
  await page.route("**/api/v1/orgs", (route) =>
    route.fulfill({ json: { orgs: [{ slug: "example", role: "owner" }] } }),
  );
  await page.route("**/api/v1/recent", (route) =>
    route.fulfill({
      json: {
        recent: [
          {
            org: "example",
            repo: "demo",
            message: "Initial commit",
            date: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    }),
  );
  await page.route("**/api/v1/orgs/example/repos", (route) => route.fulfill({ json: { repos: currentRepositories } }));
  await page.route("**/api/v1/orgs/example/machine-git-credentials**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      return route.fulfill({ json: { credentials: currentMachineCredentials } });
    }
    if (request.method() === "POST") {
      const details = JSON.parse(request.postData());
      machineCredentialRequests.push(details);
      const record = {
        id: "mgc_0123456789abcdef01234567",
        org: "example",
        repo: details.repo,
        label: details.label,
        scopes: details.scopes,
        createdAt: "2026-10-31T00:00:00.000Z",
        expiresAt: details.expiresAt,
      };
      currentMachineCredentials.unshift(record);
      return route.fulfill({ status: 201, json: { token: "gmc_browser_test_secret", record } });
    }
    if (request.method() === "DELETE") {
      currentMachineCredentials = currentMachineCredentials.filter(
        (credential) => !request.url().endsWith(`/${credential.id}`),
      );
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 405, json: { error: "Method not allowed" } });
  });
  await page.route("**/api/v1/orgs/example/webhooks**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      if (webhookApiDisabled) {
        return route.fulfill({ status: 503, json: { error: "Webhook API is disabled" } });
      }
      return route.fulfill({ json: { webhooks: currentOrgWebhooks } });
    }
    if (request.method() === "POST") {
      if (request.url().endsWith("/test")) {
        testWebhookRequests.push(request.url());
        return route.fulfill({ status: 202, json: { status: "accepted", event: "webhook.ping" } });
      }
      createdOrgWebhookRequest = JSON.parse(request.postData());
      if (createdOrgWebhookRequest.events.length === 0) {
        return route.fulfill({ status: 400, json: { error: "At least one event is required" } });
      }
      currentOrgWebhooks.push({
        id: "hook-1",
        url: createdOrgWebhookRequest.url,
        events: createdOrgWebhookRequest.events,
      });
      return route.fulfill({
        status: 201,
        json: { webhook: { id: "hook-1" }, testEvent: { status: "accepted", event: "webhook.ping" } },
      });
    }
    if (request.method() === "DELETE") {
      currentOrgWebhooks = currentOrgWebhooks.filter((hook) => !request.url().endsWith(`/${hook.id}`));
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 405, json: { error: "Method not allowed" } });
  });
  await page.route("**/api/v1/orgs/example/events**", (route) => {
    const url = new URL(route.request().url());
    const limit = Number(url.searchParams.get("limit") || 50);
    const offset = Number(url.searchParams.get("offset") || 0);
    return route.fulfill({
      json: {
        events: currentEvents.slice(offset, offset + limit),
        hasMore: offset + limit < currentEvents.length,
      },
    });
  });
  await page.route("**/api/v1/orgs/example/repos/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/tree")) {
      return route.fulfill({ json: currentEntries });
    }
    if (url.pathname.endsWith("/log")) {
      const commits = url.searchParams.has("limit")
        ? currentCommits.slice(0, Number(url.searchParams.get("limit")))
        : currentCommits;
      return route.fulfill({ json: commits });
    }
    if (url.pathname.endsWith("/branches") && route.request().method() === "POST") {
      currentBranches.push(JSON.parse(route.request().postData()).name);
      return route.fulfill({ json: { message: "Branch created" } });
    }
    if (url.pathname.endsWith("/branches")) {
      return route.fulfill({ json: currentBranches });
    }
    if (url.pathname.endsWith("/tags") && route.request().method() === "POST") {
      currentTags.push(JSON.parse(route.request().postData()).name);
      return route.fulfill({ json: { message: "Tag created" } });
    }
    if (url.pathname.endsWith("/tags")) {
      return route.fulfill({ json: currentTags });
    }
    if (url.pathname.endsWith("/files") && route.request().method() === "POST") {
      const uploaded = JSON.parse(route.request().postData());
      currentEntries.push({
        path: uploaded.path,
        name: uploaded.path.split("/").at(-1),
        type: "file",
        uncommitted: true,
      });
      return route.fulfill({ status: 201, json: { path: uploaded.path } });
    }
    if (url.pathname.endsWith("/stage") || url.pathname.endsWith("/commit")) {
      if (url.pathname.endsWith("/commit")) {
        const body = JSON.parse(route.request().postData());
        currentCommits = [
          {
            hash: "fedcba654321",
            message: body.message,
            author_name: "Browser Tester",
          },
          ...currentCommits,
        ];
        currentEntries = currentEntries.map((entry) => ({
          ...entry,
          uncommitted: false,
        }));
      }
      return route.fulfill({ json: { message: "OK" } });
    }
    if (url.pathname.endsWith("/file") && url.searchParams.get("path") === "photo.jpg") {
      return route.fulfill({
        status: 200,
        contentType: "image/jpeg",
        body: imageBytes,
      });
    }
    if (url.pathname.endsWith("/file")) {
      const content =
        url.searchParams.get("path") === "app.js"
          ? 'const greeting = "hello";\nconsole.log(greeting);'
          : "plain text preview";
      return route.fulfill({
        status: 200,
        contentType: "text/plain",
        body: content,
      });
    }
    return route.fulfill({ json: {} });
  });
});

test("profile settings show profile, photo, and sign out", async ({ page }) => {
  let logoutRequest;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/ui/auth/logout") {
      logoutRequest = request;
    }
  });
  await page.goto("/ui/?settings=profile");
  await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible();
  const profileSection = page.getByRole("region");
  await expect(profileSection.getByText("Browser Tester", { exact: true })).toBeVisible();
  await expect(profileSection.getByText("browser@example.test", { exact: true })).toBeVisible();
  await expect(profileSection.getByText("browser-tester-subject", { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "Profile photo" })).toHaveAttribute(
    "src",
    "https://images.example.test/avatar.png",
  );

  await page.getByRole("link", { name: "Personal access tokens" }).click();
  await expect(page).toHaveURL(/settings=tokens/);
  await page.goBack();
  await expect(page).toHaveURL(/settings=profile/);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  expect(logoutRequest?.method()).toBe("POST");
  expect(runtimeErrors).toEqual([]);
});

test("profile settings show an initials fallback when no photo is available", async ({ page }) => {
  bootstrapSession.profile.picture = "";
  await page.goto("/ui/?settings=profile");
  const profileSection = page.getByRole("region");
  await expect(profileSection.getByRole("img", { name: "Profile photo" })).toHaveCount(0);
  await expect(profileSection.getByText("B", { exact: true })).toBeVisible();

  bootstrapSession.profile.picture = "javascript:alert(1)";
  await page.goto("/ui/?settings=profile");
  await expect(page.getByRole("img", { name: "Profile photo" })).toHaveCount(0);
  await expect(page.getByRole("region").getByText("B", { exact: true })).toBeVisible();
});

test("team settings route history, owner management, invite acceptance, and responsive bounds", async ({ page }) => {
  let team = {
    isOwner: true,
    role: "admin",
    members: [{ id: "member-hash", memberId: "member-subject-hash", role: "viewer" }],
    invitations: [],
    incomingInvitations: [],
    memberships: [],
  };
  const calls = [];
  await page.route("**/api/v1/orgs", (route) => route.fulfill({ json: { orgs: [] } }));
  await page.route("**/api/v1/team**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postData() ? JSON.parse(request.postData()) : null;
    calls.push({ method: request.method(), path, body });
    if (request.method() === "GET") {
      return route.fulfill({ json: team });
    }
    if (path === "/api/v1/team/invitations" && request.method() === "POST") {
      team.invitations.push({
        id: "invite-1",
        memberId: body.sub,
        role: body.role,
      });
      return route.fulfill({ status: 201, json: {} });
    }
    if (path.endsWith("/accept")) {
      const invitationId = path.split("/").at(-2);
      team.incomingInvitations = team.incomingInvitations.filter((invitation) => invitation.id !== invitationId);
      return route.fulfill({ json: {} });
    }
    if (path.includes("/members/") && request.method() === "PATCH") {
      team.members[0].role = body.role;
      return route.fulfill({ json: {} });
    }
    if (path.includes("/members/") && request.method() === "DELETE") {
      team.members = [];
      return route.fulfill({ status: 204 });
    }
    if (path.includes("/invitations/") && request.method() === "DELETE") {
      team.invitations = [];
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.goto("/ui/?settings=team");
  const panel = page.getByRole("region", { name: "Team" });
  await expect(page.getByRole("heading", { name: "Team", exact: true })).toBeVisible();
  await expect(panel).toContainText("current and future organizations");
  const navigation = page.getByRole("navigation", {
    name: "Settings navigation",
  });
  await navigation.getByRole("link", { name: "Profile" }).click();
  await page.goBack();
  await expect(page).toHaveURL(/settings=team/);
  await page.getByLabel("Invitee OIDC subject").fill("invitee-sub");
  await page.getByLabel("Invitation role").selectOption("contributor");
  await page.getByRole("button", { name: "Send invitation" }).click();
  expect(calls.find((call) => call.path === "/api/v1/team/invitations" && call.method === "POST").body).toEqual({
    sub: "invitee-sub",
    role: "contributor",
  });
  const member = page.getByRole("listitem").filter({ hasText: "member-subject-hash" });
  await member.getByRole("combobox").selectOption("admin");
  await expect(member.getByRole("combobox")).toHaveValue("admin");
  await member.getByRole("button", { name: "Save role" }).click();
  await expect
    .poll(() =>
      calls.some(
        (call) => call.method === "PATCH" && call.path.endsWith("/members/member-hash") && call.body.role === "admin",
      ),
    )
    .toBe(true);
  await member.getByRole("button", { name: "Remove" }).click();
  await expect(member).toHaveCount(0);
  const invite = page.getByRole("listitem").filter({ hasText: "invitee-sub" });
  await invite.getByRole("button", { name: "Cancel invitation" }).click();
  await expect(invite).toHaveCount(0);
  team = {
    isOwner: false,
    role: "viewer",
    members: [],
    invitations: [],
    incomingInvitations: [
      {
        id: "incoming-1",
        ownerId: "owner-sub",
        ownerName: "Team owner",
        role: "viewer",
        createdAt: "2026-10-30",
        expiresAt: "2026-11-06",
      },
    ],
    memberships: [{ ownerId: "owner-sub", role: "viewer" }],
  };
  await page.reload();
  await expect(page.getByRole("region", { name: "Team" })).toContainText("owner-sub");
  await expect(page.getByText("Invited by Team owner (owner-sub)")).toBeVisible();
  await page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(page.getByText("Invitation accepted.")).toBeVisible();
  expect(
    calls.some((call) => call.path === "/api/v1/team/invitations/incoming-1/accept" && call.method === "POST"),
  ).toBe(true);
  team = {
    isOwner: true,
    role: null,
    members: [],
    invitations: [],
    incomingInvitations: [
      {
        id: "incoming-owner",
        ownerId: "another-owner",
        ownerName: "Another team",
        role: "viewer",
      },
    ],
    memberships: [],
  };
  await page.reload();
  await expect(page.getByText("Invited by Another team (another-owner)")).toBeVisible();
  await page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(page.getByText("Invitation accepted.")).toBeVisible();
  expect(await panel.evaluate((element) => element.getBoundingClientRect().right)).toBeLessThanOrEqual(
    page.viewportSize().width,
  );
});
test.afterEach(() => {
  expect(runtimeErrors).toEqual([]);
});

test("organization landing renders organizations and recent changes", async ({ page }) => {
  await page.goto("/ui/");

  await expect(page.getByRole("heading", { name: "Organizations" })).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Organizations" }).getByRole("link", { name: "example", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent changes" })).toBeVisible();
  await expect(page.getByText("Initial commit", { exact: true })).toBeVisible();
  const dashboard = await page.getByTestId("landing-dashboard").boundingBox();
  expect(dashboard.width).toBeGreaterThan(page.viewportSize().width * 0.9);
  expect(dashboard.height).toBeGreaterThan(page.viewportSize().height * 0.75);
  await page.getByRole("button", { name: "Add organization" }).click();
  await expect(page.getByLabel("Organization name")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByLabel("Organization name")).toHaveCount(0);
});

test("token settings lists tokens and creates a scoped PAT", async ({ page }) => {
  await page.goto("/ui/?settings=tokens");

  await expect(page.getByRole("heading", { name: "Personal access tokens" })).toBeVisible();
  await expect(page.getByText("Existing integration", { exact: true })).toBeVisible();
  await expect(page.getByText(/Organizations: example/).first()).toBeVisible();

  const tokenGrantsForm = page.locator("#token-grants-form");
  await page.getByPlaceholder("e.g. Laptop").fill("Automation client");
  await tokenGrantsForm.getByLabel("repo:write", { exact: true }).check();
  await tokenGrantsForm.getByLabel("example", { exact: true }).check();
  await page.getByRole("button", { name: "Create token" }).click();

  await expect(page.getByRole("heading", { name: "Copy your token now" })).toBeVisible();
  await expect(page.getByText("gmpat_browser_test_secret", { exact: true })).toBeVisible();
  await expect
    .poll(() => createdPersonalAccessTokenRequest)
    .toEqual({ label: "Automation client", scopes: ["repo:write"], orgs: ["example"] });

  const bindForm = page.locator("form").filter({ hasText: "External token" });
  await bindForm.getByLabel("External token").fill("opaque-imported-secret");
  await bindForm.getByLabel("Label", { exact: true }).fill("Imported access");
  await bindForm.getByLabel("repo:write", { exact: true }).check();
  await bindForm.getByLabel("example", { exact: true }).check();
  await expect(bindForm.getByLabel("External token")).toHaveAttribute("type", "password");
  await bindForm.getByRole("button", { name: "Bind token" }).click();
  await expect
    .poll(() => createdTokenAuthorizationRequest)
    .toEqual({
      token: "opaque-imported-secret",
      label: "Imported access",
      scopes: ["repo:read", "repo:write"],
      orgs: ["example"],
    });
  await expect(bindForm.getByLabel("External token")).toHaveValue("");
  expect(await page.evaluate(() => JSON.stringify(Object.values(window.localStorage)))).not.toContain(
    "opaque-imported-secret",
  );

  const existingToken = page.getByRole("listitem").filter({ hasText: "Existing integration" });
  await existingToken.getByRole("button", { name: "Edit grants" }).click();
  await tokenGrantsForm.getByLabel("repo:read", { exact: true }).check();
  await page.getByRole("button", { name: "Save grants" }).click();
  await expect(page.getByText("Existing integration", { exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await existingToken.getByRole("button", { name: "Revoke" }).click();
  await expect(existingToken).toHaveCount(0);
});

test("token settings show all scopes and disable grants the user lacks", async ({ page }) => {
  await page.route("**/ui/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        canRead: true,
        canWrite: false,
        profile: { name: "Read-only Browser Tester" },
      },
    }),
  );
  await page.goto("/ui/?settings=tokens");

  const tokenForm = page.locator("#token-grants-form");
  for (const scope of ["repo:read", "repo:write", "org:create", "org:manage"]) {
    await expect(tokenForm.getByLabel(scope, { exact: false })).toBeVisible();
  }
  await expect(tokenForm.getByLabel("repo:read", { exact: true })).toBeEnabled();
  for (const scope of ["repo:write", "org:create", "org:manage"]) {
    await expect(tokenForm.getByLabel(new RegExp(`^${scope}`))).toBeDisabled();
  }

  const bindingForm = page.locator("form").filter({ hasText: "External token" });
  for (const scope of ["repo:read", "repo:write", "org:create", "org:manage"]) {
    await expect(bindingForm.getByLabel(new RegExp(`^${scope}`))).toBeVisible();
  }
  for (const scope of ["repo:write", "org:create", "org:manage"]) {
    await expect(bindingForm.getByLabel(new RegExp(`^${scope}`))).toBeDisabled();
  }
});

test("organization settings navigate to repositories and manage webhook subscriptions", async ({ page }) => {
  currentRepositories = [{ repo: "demo" }, { repo: "second" }];
  await page.goto("/ui/");
  await page.locator('button[title="Settings"]').click();
  await expect(page).toHaveURL(/settings=profile/);
  await page.getByRole("link", { name: "Organizations", exact: true }).click();
  const organizationForm = page.locator("form").filter({ has: page.getByLabel("Organization slug") });
  await expect(organizationForm).toBeVisible();
  const deleteButton = page.getByRole("button", { name: "Delete empty organization" });
  const deleteLabel = deleteButton.getByText("Delete", { exact: true });
  if (page.viewportSize().width < 768) {
    await expect(deleteLabel).toBeHidden();
  } else {
    await expect(deleteLabel).toBeVisible();
  }
  await page.getByRole("link", { name: "example", exact: true }).click();
  await expect(page).toHaveURL(/settings=organizations&org=example/);
  await expect(organizationForm).toHaveCount(0);

  const navigation = page.getByRole("navigation", { name: "Organization settings" });
  await expect(navigation.getByRole("link", { name: "General" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "General", exact: true })).toHaveCount(1);
  await expect(page.getByTestId("organization-settings-content")).toHaveCSS("overflow-y", "auto");
  await navigation.getByRole("link", { name: "Repositories" }).click();
  await expect(page.getByRole("heading", { name: "Repositories", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "General", exact: true })).toHaveCount(0);
  const repositoryLink = page.getByRole("link", { name: "demo", exact: true });
  await expect(repositoryLink).toHaveAttribute("href", "/?org=example&repo=demo");
  await navigation.getByRole("link", { name: "General" }).click();
  await expect(page.getByRole("heading", { name: "General", exact: true })).toHaveCount(1);
  await navigation.getByRole("link", { name: "Repositories" }).click();
  await navigation.getByRole("link", { name: "Webhooks" }).click();
  await expect(page).toHaveURL(/section=webhooks/);
  await expect(navigation.getByRole("link", { name: "Webhooks" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Webhooks", exact: true })).toBeVisible();
  const webhookPanel = page.locator("org-webhooks");

  await page.getByLabel("Webhook URL").fill("https://hooks.example.test/events");
  await page.getByLabel("Webhook secret").fill("my-user-defined-secret");
  await page.getByLabel("Allowed IP ranges").fill("192.168.1.20/32");
  await expect(webhookPanel.getByRole("checkbox")).toHaveCount(3);
  await page.getByLabel("git", { exact: true }).check();
  await page.getByLabel("repo", { exact: true }).check();
  await page.getByLabel("thread", { exact: true }).check();
  await page.getByRole("button", { name: "Create webhook" }).click();
  await expect
    .poll(() => createdOrgWebhookRequest)
    .toEqual({
      url: "https://hooks.example.test/events",
      events: ["git", "repo", "thread"],
      secret: "my-user-defined-secret",
      allowedIpRanges: "192.168.1.20/32",
    });
  await expect(page.getByLabel("Webhook secret")).toHaveValue("");
  const subscription = page.getByRole("listitem").filter({ hasText: "https://hooks.example.test/events" });
  await expect(subscription).toContainText("git, repo, thread");
  await expect(page.getByText("Webhook created. Hello event queued for delivery.")).toBeVisible();
  await subscription.getByRole("button", { name: "Send hello event" }).click();
  await expect.poll(() => testWebhookRequests.length).toBe(1);
  expect(new URL(testWebhookRequests[0]).pathname).toBe("/api/v1/orgs/example/webhooks/hook-1/test");
  await expect(page.getByText("Hello event queued for delivery.")).toBeVisible();
  await subscription.getByRole("button", { name: "Delete" }).click();
  await expect(subscription).toHaveCount(0);
  await expect(page).toHaveURL(/settings=organizations&org=example&section=webhooks/);
  expect(await webhookPanel.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(
    page.viewportSize().width,
  );

  await page.getByLabel("Webhook URL").fill("https://hooks.example.test/events");
  await page.getByLabel("Webhook secret").fill("my-user-defined-secret");
  expectedWebhookHttpErrors += 1;
  await page.getByRole("button", { name: "Create webhook" }).click();
  await expect(page.getByRole("alert")).toHaveText("At least one event is required");
  webhookApiDisabled = true;
  expectedWebhookHttpErrors += 1;
  await page.reload();
  await expect(page.getByRole("alert")).toHaveText("Webhook API is disabled");
});

test("organization settings create and revoke an org-scoped machine Git credential", async ({ page }) => {
  await page.goto("/ui/?settings=organizations&org=example");
  await page
    .getByRole("navigation", { name: "Organization settings" })
    .getByRole("link", { name: "Machine Git credentials" })
    .click();

  await page.getByLabel("Credential label").fill("CI deploy");
  await page.getByLabel("Repository restriction").fill("demo");
  await page.getByLabel("repo:write", { exact: true }).check();
  await page.getByRole("button", { name: "Create credential" }).click();

  await expect(page.getByRole("heading", { name: "Copy this credential now" })).toBeVisible();
  await expect(page.getByText("gmc_browser_test_secret", { exact: true })).toBeVisible();
  expect(machineCredentialRequests).toEqual([
    { label: "CI deploy", repo: "demo", scopes: ["repo:read", "repo:write"], expiresAt: null },
  ]);
  const credentialRow = page.getByRole("listitem").filter({ hasText: "CI deploy" });
  await expect(credentialRow).toContainText("demo");
  page.once("dialog", (dialog) => dialog.accept());
  await credentialRow.getByRole("button", { name: "Revoke" }).click();
  await expect(credentialRow).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Credential revoked.");
});

test("organization breadcrumb does not retain a repository crumb", async ({ page }) => {
  await page.goto("/ui/?org=example&repo=demo");
  const breadcrumbs = page.getByTestId("workspace-breadcrumbs");
  await expect(
    page.getByTestId("repository-sidebar-list").getByRole("link", { name: "demo", exact: true }),
  ).toBeVisible();
  await expect(breadcrumbs.getByTestId("workspace-breadcrumb")).toHaveCount(2);
  await expect(breadcrumbs.getByRole("link", { name: "example" })).toHaveCount(1);
  await expect(breadcrumbs.getByRole("link", { name: "demo" })).toHaveCount(1);

  for (let i = 0; i < 3; i++) {
    await breadcrumbs.getByRole("link", { name: "example" }).click();
    await expect(page).toHaveURL(/\?org=example$/);
    await expect(breadcrumbs.getByTestId("workspace-breadcrumb")).toHaveCount(1);
    await expect(breadcrumbs.getByRole("link", { name: "example" })).toHaveCount(1);

    if (page.viewportSize().width < 768) {
      await page.getByRole("button", { name: "Toggle repositories" }).click();
    }
    await page.getByTestId("repository-sidebar-list").getByRole("link", { name: "demo", exact: true }).click();
    await expect(page).toHaveURL(/\?org=example&repo=demo$/);
    await expect(breadcrumbs.getByTestId("workspace-breadcrumb")).toHaveCount(2);
  }
});

test("clone panel is inline on mobile and anchored on desktop", async ({ page }) => {
  await page.goto("/ui/?org=example&repo=demo");
  await page.getByRole("button", { name: "Clone" }).click();

  const panel = page.locator("#clone-repo-popover");
  await expect(panel).toBeVisible();
  if (page.viewportSize().width <= 767) {
    await expect(panel).not.toHaveAttribute("popover");
    await expect(panel).toHaveCSS("position", "static");
    await expect(page.getByText("Clone URL", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close clone dialog" }).click();
    await expect(panel).toBeHidden();
  } else {
    await expect(panel).toHaveAttribute("popover", "auto");
    expect(await panel.evaluate((element) => element.matches(":popover-open"))).toBe(true);
    await page.getByRole("button", { name: "Close clone dialog" }).click();
    await expect(panel).toBeHidden();
  }
});

test("uploads and branch, tag, and commit mutations update without document reload", async ({ page }) => {
  await page.goto("/ui/?org=example&repo=demo");
  const sidebar = page.getByTestId("repository-sidebar");
  if (page.viewportSize().width < 768) {
    await page.getByRole("button", { name: "Toggle repositories" }).click();
    await expect.poll(() => sidebar.evaluate((element) => element.classList.contains("translate-x-0"))).toBe(true);
  }
  const initialCount = await page.evaluate(() => window.__documentNavigationCount);

  await expect(page.getByText("click here to upload", { exact: true })).toBeVisible();
  await expect(page.getByTestId("upload-dropzone")).toHaveCSS(
    "min-height",
    page.viewportSize().width < 768 ? "56px" : "120px",
  );
  await expect(page.getByText("Choose files", { exact: true })).toHaveCount(0);
  await expect(page.getByText("No file chosen", { exact: true })).toHaveCount(0);
  const uploadInputIsBelowFileList = await page.evaluate(() => {
    const list = document.querySelector('[data-testid="repository-file-list"]');
    const input = document.querySelector("#repo-upload-input");
    return Boolean(list && input && list.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(uploadInputIsBelowFileList).toBe(true);

  await page.locator("#repo-upload-input").setInputFiles({
    name: "uploaded.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("uploaded content"),
  });
  await expect(page.getByRole("link", { name: /uploaded\.txt/ })).toBeVisible();

  await page.getByRole("button", { name: "Create branch" }).click();
  await page.locator("#branch-popover input").fill("feature/ui");
  await page.locator("#branch-popover button[type=submit]").click();
  await expect(sidebar.locator("details").nth(0).getByText("feature/ui", { exact: true })).toHaveCount(1);
  await expect
    .poll(() => page.locator("#branch-popover").evaluate((element) => element.matches(":popover-open")))
    .toBe(false);
  await expect(page.locator("#branch-popover input")).toHaveValue("");
  await sidebar.locator("details").nth(0).locator("summary").click();
  await expect(page.getByRole("link", { name: "feature/ui" })).toBeVisible();

  await page.getByRole("button", { name: "Create tag" }).click();
  await page.locator("#tag-popover input").fill("v1.0");
  await page.locator("#tag-popover button[type=submit]").click();
  await expect(sidebar.locator("details").nth(1).getByText("v1.0", { exact: true })).toHaveCount(1);
  await expect
    .poll(() => page.locator("#tag-popover").evaluate((element) => element.matches(":popover-open")))
    .toBe(false);
  await expect(page.locator("#tag-popover input")).toHaveValue("");
  await sidebar.locator("details").nth(1).locator("summary").click();
  await expect(page.getByRole("link", { name: "v1.0" })).toBeVisible();

  if (page.viewportSize().width < 768) {
    await page.getByRole("button", { name: "Toggle repositories" }).click();
    await expect.poll(() => sidebar.evaluate((element) => element.classList.contains("translate-x-0"))).toBe(false);
  }
  await page.getByRole("link", { name: /uploaded\.txt/ }).click();
  await expect(page.getByTestId("file-page")).toBeVisible();
  await page.getByRole("button", { name: "Back to files" }).click();
  await page.getByPlaceholder("Commit message").fill("Save uploaded file");
  await page.getByRole("button", { name: "Commit", exact: true }).click();
  await expect(page.getByTestId("latest-commit-header").getByText("Save uploaded file", { exact: true })).toBeVisible();
  await expect(page.getByTestId("file-page")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has("path")).toBe(false);

  await page.getByRole("button", { name: "Add file" }).click();
  await page.locator("#add-file-popover input").fill("src/created.md");
  await page.locator("#add-file-popover button[type=submit]").click();
  await expect(page.getByRole("link", { name: /created\.md/ })).toBeVisible();
  await expect
    .poll(() => page.locator("#add-file-popover").evaluate((element) => element.matches(":popover-open")))
    .toBe(false);
  await expect(page.locator("#add-file-popover input")).toHaveValue("");
  expect(await page.evaluate(() => window.__documentNavigationCount)).toBe(initialCount);
});

test("repository sidebar keeps branches and tags compact and collapsed by default", async ({ page }) => {
  await page.goto("/ui/?org=example&repo=demo");

  const sidebar = page.getByTestId("repository-sidebar");
  const sections = sidebar.locator("details");
  await expect(sections).toHaveCount(2);
  await expect(sections.nth(0)).not.toHaveAttribute("open", "");
  await expect(sections.nth(1)).not.toHaveAttribute("open", "");
  await expect(sidebar.getByTestId("sidebar-section-heading")).toHaveCount(3);
  await expect(sidebar.getByTestId("repository-sidebar-list")).toBeVisible();
  await expect(page.locator("repo-panel")).toHaveCount(0);
});

test("organization event stream displays actors, actions, and objects", async ({ page }) => {
  currentEvents = Array.from({ length: 55 }, (_, index) => ({
    id: `event-${index + 1}`,
    occurredAt: "2026-01-01T00:00:00.000Z",
    subject: index === 54 ? `pat:${"a".repeat(64)}` : `subject-${index + 1}`,
    actorName: index === 54 ? null : `Actor ${index + 1}`,
    event: "git.branch.created",
    object: `example/project-${index + 1}@refs/heads/main`,
    origin: "git-token",
  }));

  await page.goto("/ui/?org=example");

  const eventStream = page.getByTestId("organization-event-stream");
  await expect(eventStream.getByText("Actor 1", { exact: true })).toBeVisible();
  await expect(eventStream.getByText("git.branch.created", { exact: true }).first()).toBeVisible();
  await expect(eventStream.getByText("example/project-1@refs/heads/main", { exact: true })).toBeVisible();
  await expect(eventStream.locator("li")).toHaveCount(50);
  await page.getByRole("button", { name: "Load more events" }).click();
  await expect(eventStream.locator("li")).toHaveCount(55);
  await expect(eventStream.getByText("Personal access token", { exact: true })).toBeVisible();
  await expect(eventStream.getByText(`pat:${"a".repeat(64)}`, { exact: true })).toHaveCount(0);
  if (page.viewportSize().width >= 768) {
    await expect.poll(() => eventStream.evaluate((list) => list.scrollHeight > list.clientHeight)).toBe(true);
    await expect(eventStream).toHaveCSS("overflow-y", "auto");
  } else {
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight > innerHeight)).toBe(true);
  }

  const sidebarList = page.getByTestId("repository-sidebar-list");
  await expect(sidebarList.getByRole("link", { name: "demo", exact: true })).toBeVisible();
  await expect(sidebarList.locator("commit-hash")).toHaveCount(0);
});

test("commit hashes copy the full hash and folder path segments navigate", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/ui/?org=example&repo=demo&dir=docs%2Fnested");

  const latestCommit = page.getByTestId("latest-commit-header");
  await expect(latestCommit.getByText("Browser Tester", { exact: true })).toHaveCount(0);
  await latestCommit.getByRole("button", { name: "Copy commit hash" }).click();
  await expect(latestCommit.getByRole("status")).toHaveText("Commit hash copied");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("abcdef123456");

  const folderPath = page.getByRole("navigation", { name: "Folder path" });
  await expect(folderPath.getByRole("link", { name: "Root" }).locator("lucide-icon")).toHaveAttribute("icon", "house");
  await expect(folderPath.getByRole("link", { name: "docs" })).toBeVisible();
  await expect(folderPath.getByRole("link", { name: "nested" })).toBeVisible();
  await expect(page.getByTestId("folder-path-toolbar")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await folderPath.getByRole("link", { name: "docs" }).click();
  await expect(page).toHaveURL(/dir=docs(?:&|$)/);
  await expect(folderPath.getByRole("link", { name: "nested" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add file" })).toBeVisible();
  await folderPath.getByRole("link", { name: "Root" }).click();
  await expect(page).not.toHaveURL(/dir=/);
});

test("header uses the GitMini home logo", async ({ page }) => {
  await page.goto("/ui/?org=example&repo=demo");

  const homeLink = page.getByRole("link", { name: "Home" });
  await expect(page).toHaveTitle("GitMini");
  await expect(homeLink).toBeVisible();
  await expect(homeLink).toContainText("gitmini.");
  await expect(homeLink).toHaveCSS("width", page.viewportSize().width < 768 ? "128px" : "256px");
  await expect(homeLink.getByTestId("home-indicator")).toHaveAttribute("width", "32");
  await expect(homeLink.getByTestId("home-indicator").locator("rect")).toHaveAttribute("rx", "4");
  const breadcrumbs = page.getByTestId("workspace-breadcrumbs");
  await expect(breadcrumbs.getByRole("link")).toHaveCount(2);
  await expect(breadcrumbs.locator("span").nth(0)).toHaveCSS("display", "none");
  await expect(breadcrumbs.locator("span").nth(1)).not.toHaveCSS("display", "none");
  expect(
    await breadcrumbs.evaluate((nav) => {
      const home = document.querySelector('a[aria-label="Home"]');
      return nav.compareDocumentPosition(home) & Node.DOCUMENT_POSITION_PRECEDING;
    }),
  ).toBeTruthy();
  await expect(page.getByRole("banner").getByTestId("workspace-breadcrumbs")).toBeVisible();
  expect(
    await breadcrumbs.evaluate(
      (nav) => nav.compareDocumentPosition(document.querySelector("main")) & Node.DOCUMENT_POSITION_FOLLOWING,
    ),
  ).toBeTruthy();
  const userCard = page.locator('button[title="Settings"]');
  await expect(userCard).toHaveClass(/rounded-full/);
  await expect(userCard.locator("span[aria-hidden='true']")).toHaveCSS("width", "32px");
  await expect(page.locator(".flow-logo-mark, .flow-logo-dot")).toHaveCount(0);
});

test("anonymous landing welcomes returning users", async ({ page }) => {
  bootstrapSession = {
    checked: true,
    authenticated: false,
    profile: null,
    canWrite: false,
  };
  await page.route("**/ui/session", (route) => route.fulfill({ json: { authenticated: false } }));
  await page.goto("/ui/");

  await expect(page.getByTestId("workspace-breadcrumbs")).toBeHidden();
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await expect(page.getByText("Sign in to access your organizations and repositories.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue to GitMini" })).toBeVisible();
});

test("SPA navigation, file pages, history, and read-only controls", async ({ page }) => {
  await page.goto("/ui/?org=example&repo=demo");
  await expect(page.getByText("notes.txt", { exact: true }).first()).toBeVisible();
  const repositoryPanel = page.getByTestId("repository-content-panel");
  await expect(repositoryPanel.getByTestId("repository-file-list")).toHaveCSS("margin", "8px");
  await expect(repositoryPanel.getByTestId("latest-commit-header")).toHaveCount(1);
  await expect(repositoryPanel.getByTestId("folder-path-toolbar")).toHaveCount(1);
  await expect(repositoryPanel.getByTestId("repository-file-list")).toHaveCount(1);
  const entryIcons = page.getByTestId("repository-entry-icon");
  await expect(entryIcons).toHaveCount(4);
  for (const [index, icon] of ["file-text", "file-image", "file-code", "folder"].entries()) {
    await expect(entryIcons.nth(index)).toHaveJSProperty("icon", icon);
    await expect(entryIcons.nth(index).locator("svg")).toBeVisible();
  }
  const initialCount = await page.evaluate(() => window.__documentNavigationCount);
  const filePageStartedAt = Date.now();
  await page.getByText("notes.txt", { exact: true }).first().click();
  await expect(page.getByTestId("file-page")).toBeVisible();
  await expect(page.getByTestId("file-code-block")).toContainText("plain text preview");
  const fileBackButton = page.getByTestId("file-back-button");
  await expect(fileBackButton).toHaveAccessibleName("Back to files");
  await expect(fileBackButton.locator("lucide-icon")).toHaveJSProperty("icon", "chevron-left");
  await expect(fileBackButton.locator(".sr-only")).toHaveText("Back to files");
  await expect(fileBackButton).toHaveJSProperty("previousElementSibling", null);
  const filePageDuration = Date.now() - filePageStartedAt;
  test.info().annotations.push({
    type: "file-page-load-ms",
    description: String(filePageDuration),
  });
  process.stdout.write(`[perf] file preview visible in ${filePageDuration} ms\n`);
  await page.goBack();
  await expect(page.getByTestId("file-page")).toHaveCount(0);
  await page.goForward();
  await expect(page.getByTestId("file-code-block")).toContainText("plain text preview");
  await page.getByRole("button", { name: "Back to files" }).click();
  await page.getByText("app.js", { exact: true }).first().click();
  await expect(page.getByTestId("file-page-icon")).toHaveJSProperty("icon", "file-code");
  await expect(page.getByTestId("file-page-icon").locator("svg")).toBeVisible();
  await expect(page.getByTestId("file-language")).toHaveText("javascript");
  await expect(page.getByTestId("file-code-block")).toContainText("const");
  const sourceLines = page.locator("selectable-code [data-line]");
  await expect(sourceLines.first()).toBeVisible();
  await sourceLines.nth(0).click();
  await expect(page.locator("file-preview [role=status]")).toContainText("Selected L1");
  await sourceLines.nth(1).click({ modifiers: ["Shift"] });
  await expect(page.locator("file-preview [role=status]")).toContainText("Selected L1-L2");
  await page.getByRole("button", { name: "Back to files" }).click();
  await page.getByText("photo.jpg", { exact: true }).first().click();
  const imagePreview = page.getByRole("img", { name: "photo.jpg" });
  await expect(imagePreview).toBeVisible();
  await expect.poll(() => imagePreview.evaluate((image) => image.naturalWidth)).toBe(1);
  await page.goBack();
  await expect(page.getByTestId("file-page")).toHaveCount(0);
  await page.goForward();
  await expect(page.getByRole("img", { name: "photo.jpg" })).toBeVisible();
  expect(await page.evaluate(() => window.__documentNavigationCount)).toBe(initialCount);
});

test("organization and repository navigation replaces the displayed page", async ({ page }) => {
  await page.goto("/ui/?org=example&repo=demo");
  await expect(page.getByText("notes.txt", { exact: true }).first()).toBeVisible();

  await page.getByTestId("workspace-breadcrumbs").getByRole("link", { name: "example" }).click();
  await expect(page.getByRole("navigation", { name: "Folder path" })).toHaveCount(0);
  await expect(page.locator("[data-repository-view]")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Event stream" })).toHaveCount(0);
  await expect(page.getByTestId("organization-event-stream")).toBeVisible();

  if (page.viewportSize().width < 768) {
    await page.getByRole("button", { name: "Toggle repositories" }).click();
  }
  await page.getByTestId("repository-sidebar-list").getByRole("link", { name: "demo" }).click();
  await expect(page.getByRole("navigation", { name: "Folder path" }).getByRole("link", { name: "Root" })).toHaveCount(
    1,
  );
  await expect(page.locator("[data-repository-view]")).toHaveCount(1);
  await expect(page.locator("#repo-upload-input")).toHaveCount(1);
  await expect(page.getByText("notes.txt", { exact: true })).toHaveCount(1);
});

test("read-only UI hides write controls", async ({ page }) => {
  bootstrapSession = {
    checked: true,
    authenticated: true,
    canWrite: false,
    profile: { name: "Reader" },
  };
  await page.route("**/ui/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        canWrite: false,
        profile: { name: "Reader" },
      },
    }),
  );
  await page.goto("/ui/?org=example&repo=demo");
  await expect(page.getByText("notes.txt", { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel("Select files to upload")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create branch" })).toHaveCount(0);
});

test("team roles control repository editing and organization administration UI", async ({ page }) => {
  bootstrapSession = {
    checked: true,
    authenticated: true,
    canRead: false,
    canWrite: false,
    profile: { name: "Team Member" },
  };
  let role = "viewer";
  await page.route("**/ui/session", (route) =>
    route.fulfill({ json: { authenticated: true, canRead: false, canWrite: false, profile: { name: "Team Member" } } }),
  );
  await page.route("**/api/v1/orgs", (route) => route.fulfill({ json: { orgs: [{ slug: "example", role }] } }));

  await page.goto("/ui/?org=example&repo=demo");
  await expect(page.getByText("notes.txt", { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel("Select files to upload")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create branch" })).toHaveCount(0);

  role = "contributor";
  await page.reload();
  await expect(page.getByRole("button", { name: "Create branch" })).toBeVisible();

  role = "admin";
  await page.goto("/ui/?settings=organizations&org=example&section=machine-credentials");
  await expect(page.getByRole("link", { name: "Machine Git credentials" })).toBeVisible();
  await page.goto("/ui/?settings=organizations&org=example&section=webhooks");
  await expect(page.getByRole("button", { name: "Create webhook" })).toBeVisible();

  role = "contributor";
  await page.goto("/ui/?settings=organizations&org=example&section=webhooks");
  await expect(page.getByRole("link", { name: "Machine Git credentials" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create webhook" })).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Organization admin access is required");
});
