/* global window */
import { test, expect } from "playwright/test";
let currentEntries;
let currentBranches;
let currentTags;
let currentCommits;
let currentRepositories;
let currentEvents;
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
    fetch(
      "https://unpkg.com/@highlightjs/cdn-assets@11.11.1/es/highlight.min.js",
    ),
    fetch(
      "https://unpkg.com/@highlightjs/cdn-assets@11.11.1/styles/github.min.css",
    ),
    fetch(
      "https://unpkg.com/@highlightjs/cdn-assets@11.11.1/styles/atom-one-dark.min.css",
    ),
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
      runtimeErrors.push(message.text());
    }
  });
  page.on("requestfailed", (request) =>
    runtimeErrors.push(`${request.url()}: ${request.failure()?.errorText}`),
  );
  const li3Source = await fetch("https://cdn.li3.dev/@li3/web").then(
    (response) => response.text(),
  );
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
    profile: { name: "Browser Tester" },
  };
  await page.addInitScript(() => {
    window.__documentNavigationCount = 0;
    window.addEventListener("beforeunload", () => {
      window.__documentNavigationCount += 1;
    });
  });
  await page.route("https://cdn.li3.dev/@li3/web", (route) =>
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
  await page.route(
    "https://sodium.static.apphor.de/lucide-icon.html",
    (route) =>
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
  await page.route(
    "https://unpkg.com/@highlightjs/cdn-assets@11.11.1/es/highlight.min.js",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/javascript",
        headers: { "access-control-allow-origin": "*" },
        body: highlightSource,
      }),
  );
  await page.route(
    "https://unpkg.com/@highlightjs/cdn-assets@11.11.1/styles/**",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/css",
        headers: { "access-control-allow-origin": "*" },
        body: route.request().url().includes("atom-one-dark")
          ? darkHighlightTheme
          : lightHighlightTheme,
      }),
  );
  await page.route(
    "https://unpkg.com/lucide@latest/dist/esm/**",
    async (route) => {
      const url = route.request().url();
      if (!lucideModuleCache.has(url)) {
        const response = await fetch(url);
        lucideModuleCache.set(url, {
          status: response.status,
          contentType:
            response.headers.get("content-type") || "application/javascript",
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
    },
  );
  await page.route("https://cdnjs.cloudflare.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/css", body: "" }),
  );
  await page.route("**/ui/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname !== "/ui/" && pathname !== "/ui/index.html") {
      return route.continue();
    }
    const response = await route.fetch();
    const html = await response.text();
    const sessionScript = `<script>window.__gitStoreSession=${JSON.stringify(bootstrapSession)};</script>`;
    return route.fulfill({
      response,
      body: html.replace(
        /<script>window\.__gitStoreSession=[\s\S]*?;<\/script>/,
        sessionScript,
      ),
    });
  });
  await page.route("**/ui/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        canWrite: true,
        profile: { name: "Browser Tester" },
      },
    }),
  );
  await page.route("**/ui/config", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/v1/orgs", (route) =>
    route.fulfill({ json: [{ slug: "example" }] }),
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
  await page.route("**/api/v1/orgs/example/repos", (route) =>
    route.fulfill({ json: { repos: currentRepositories } }),
  );
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
    if (
      url.pathname.endsWith("/branches") &&
      route.request().method() === "POST"
    ) {
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
    if (
      url.pathname.endsWith("/files") &&
      route.request().method() === "POST"
    ) {
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
    if (
      url.pathname.endsWith("/file") &&
      url.searchParams.get("path") === "photo.jpg"
    ) {
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

test.afterEach(() => {
  expect(runtimeErrors).toEqual([]);
});

test("organization landing renders organizations and recent changes", async ({
  page,
}) => {
  await page.goto("/ui/");

  await expect(
    page.getByRole("heading", { name: "Organizations" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Organizations" })
      .getByRole("link", { name: "example", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Recent changes" }),
  ).toBeVisible();
  await expect(page.getByText("Initial commit", { exact: true })).toBeVisible();
  const dashboard = await page.getByTestId("landing-dashboard").boundingBox();
  expect(dashboard.width).toBeGreaterThan(page.viewportSize().width * 0.9);
  expect(dashboard.height).toBeGreaterThan(page.viewportSize().height * 0.75);
});

test("organization breadcrumb does not retain a repository crumb", async ({
  page,
}) => {
  await page.goto("/ui/?org=example&repo=demo");
  await expect(
    page
      .getByTestId("repository-sidebar-list")
      .getByRole("link", { name: "demo", exact: true }),
  ).toBeVisible();

  await page.getByRole("banner").getByRole("link", { name: "example" }).click();

  await expect(page).toHaveURL(/\?org=example$/);
  await expect(
    page.getByRole("banner").getByRole("link", { name: "example", exact: true }),
  ).toHaveCount(1);
});

test("uploads and branch, tag, and commit mutations update without document reload", async ({
  page,
}) => {
  await page.goto("/ui/?org=example&repo=demo");
  const sidebar = page.getByTestId("repository-sidebar");
  if (page.viewportSize().width < 768) {
    await page.getByRole("button", { name: "Toggle repositories" }).click();
    await expect
      .poll(() =>
        sidebar.evaluate((element) =>
          element.classList.contains("translate-x-0"),
        ),
      )
      .toBe(true);
  }
  const initialCount = await page.evaluate(
    () => window.__documentNavigationCount,
  );

  await expect(
    page.getByText("click here to upload", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("upload-dropzone")).toHaveCSS(
    "min-height",
    page.viewportSize().width < 768 ? "56px" : "120px",
  );
  await expect(page.getByText("Choose files", { exact: true })).toHaveCount(0);
  await expect(page.getByText("No file chosen", { exact: true })).toHaveCount(
    0,
  );
  const uploadInputIsBelowFileList = await page.evaluate(() => {
    const list = document.querySelector('[data-testid="repository-file-list"]');
    const input = document.querySelector("#repo-upload-input");
    return Boolean(
      list &&
      input &&
      list.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
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
  await expect(
    sidebar.locator("details").nth(1).getByText("feature/ui", { exact: true }),
  ).toHaveCount(1);
  await sidebar.locator("details").nth(1).locator("summary").click();
  await expect(page.getByRole("link", { name: "feature/ui" })).toBeVisible();

  await page.getByRole("button", { name: "Create tag" }).click();
  await page.locator("#tag-popover input").fill("v1.0");
  await page.locator("#tag-popover button[type=submit]").click();
  await expect(
    sidebar.locator("details").nth(2).getByText("v1.0", { exact: true }),
  ).toHaveCount(1);
  await sidebar.locator("details").nth(2).locator("summary").click();
  await expect(page.getByRole("link", { name: "v1.0" })).toBeVisible();

  if (page.viewportSize().width < 768) {
    await page.getByRole("button", { name: "Toggle repositories" }).click();
    await expect
      .poll(() =>
        sidebar.evaluate((element) =>
          element.classList.contains("translate-x-0"),
        ),
      )
      .toBe(false);
  }
  await page.getByRole("link", { name: /uploaded\.txt/ }).click();
  await expect(page.getByTestId("file-page")).toBeVisible();
  await page.getByRole("button", { name: "Back to files" }).click();
  await page.getByPlaceholder("Commit message").fill("Save uploaded file");
  await page.getByRole("button", { name: "Commit", exact: true }).click();
  await expect(
    page
      .getByTestId("latest-commit-header")
      .getByText("Save uploaded file", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("file-page")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has("path")).toBe(false);

  await page.getByRole("button", { name: "Add file" }).click();
  await page.locator("#add-file-popover input").fill("src/created.md");
  await page.locator("#add-file-popover button[type=submit]").click();
  await expect(page.getByRole("link", { name: /created\.md/ })).toBeVisible();
  expect(await page.evaluate(() => window.__documentNavigationCount)).toBe(
    initialCount,
  );
});

test("repository sidebar keeps branches and tags compact and collapsed by default", async ({
  page,
}) => {
  await page.goto("/ui/?org=example&repo=demo");

  const sidebar = page.getByTestId("repository-sidebar");
  const sections = sidebar.locator("details");
  await expect(sections).toHaveCount(3);
  await expect(sections.nth(0)).toHaveAttribute("open", "");
  await expect(sections.nth(1)).not.toHaveAttribute("open", "");
  await expect(sections.nth(2)).not.toHaveAttribute("open", "");
  await expect(sidebar.getByTestId("sidebar-section-heading")).toHaveCount(3);
  await expect(page.locator("repo-panel")).toHaveCount(0);
});

test("organization event stream displays actors, actions, and objects", async ({
  page,
}) => {
  currentEvents = Array.from({ length: 55 }, (_, index) => ({
    id: `event-${index + 1}`,
    occurredAt: "2026-01-01T00:00:00.000Z",
    subject: `subject-${index + 1}`,
    actorName: `Actor ${index + 1}`,
    event: "git.branch.created",
    object: `example/project-${index + 1}@refs/heads/main`,
    origin: "git-token",
  }));

  await page.goto("/ui/?org=example");

  const eventStream = page.getByTestId("organization-event-stream");
  await expect(eventStream.getByText("Actor 1", { exact: true })).toBeVisible();
  await expect(
    eventStream.getByText("git.branch.created", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    eventStream.getByText("example/project-1@refs/heads/main", { exact: true }),
  ).toBeVisible();
  await expect(eventStream.locator("li")).toHaveCount(50);
  await page.getByRole("button", { name: "Load more events" }).click();
  await expect(eventStream.locator("li")).toHaveCount(55);
  if (page.viewportSize().width >= 768) {
    await expect
      .poll(() =>
        eventStream.evaluate((list) => list.scrollHeight > list.clientHeight),
      )
      .toBe(true);
    await expect(eventStream).toHaveCSS("overflow-y", "auto");
  } else {
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollHeight > innerHeight,
        ),
      )
      .toBe(true);
  }

  const sidebarList = page.getByTestId("repository-sidebar-list");
  await expect(
    sidebarList.getByRole("link", { name: "demo", exact: true }),
  ).toBeVisible();
  await expect(sidebarList.locator("commit-hash")).toHaveCount(0);
});

test("commit hashes copy the full hash and folder path segments navigate", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/ui/?org=example&repo=demo&dir=docs%2Fnested");

  const latestCommit = page.getByTestId("latest-commit-header");
  await expect(
    latestCommit.getByText("Browser Tester", { exact: true }),
  ).toHaveCount(0);
  await latestCommit.getByRole("button", { name: "Copy commit hash" }).click();
  await expect(latestCommit.getByRole("status")).toHaveText(
    "Commit hash copied",
  );
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("abcdef123456");

  const folderPath = page.getByRole("navigation", { name: "Folder path" });
  await expect(
    folderPath.getByRole("link", { name: "Root" }).locator("lucide-icon"),
  ).toHaveAttribute("icon", "house");
  await expect(folderPath.getByRole("link", { name: "docs" })).toBeVisible();
  await expect(folderPath.getByRole("link", { name: "nested" })).toBeVisible();
  await expect(page.getByTestId("folder-path-toolbar")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
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
  await expect(homeLink.getByTestId("home-indicator")).toHaveAttribute(
    "width",
    "32",
  );
  await expect(page.locator(".flow-logo-mark, .flow-logo-dot")).toHaveCount(0);
});

test("anonymous landing welcomes returning users", async ({ page }) => {
  bootstrapSession = {
    checked: true,
    authenticated: false,
    profile: null,
    canWrite: false,
  };
  await page.route("**/ui/session", (route) =>
    route.fulfill({ json: { authenticated: false } }),
  );
  await page.goto("/ui/");

  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  await expect(
    page.getByText("Sign in to access your organizations and repositories."),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Continue to GitMini" }),
  ).toBeVisible();
});

test("SPA navigation, file pages, history, and read-only controls", async ({
  page,
}) => {
  await page.goto("/ui/?org=example&repo=demo");
  await expect(
    page.getByText("notes.txt", { exact: true }).first(),
  ).toBeVisible();
  const repositoryPanel = page.getByTestId("repository-content-panel");
  await expect(repositoryPanel.getByTestId("latest-commit-header")).toHaveCount(
    1,
  );
  await expect(repositoryPanel.getByTestId("folder-path-toolbar")).toHaveCount(
    1,
  );
  await expect(repositoryPanel.getByTestId("repository-file-list")).toHaveCount(
    1,
  );
  await expect(
    page.locator(
      'lucide-icon[data-testid="repository-entry-icon"][icon="folder"]',
    ),
  ).toHaveCount(1);
  await expect(
    page.locator(
      'lucide-icon[data-testid="repository-entry-icon"][icon="file-text"]',
    ),
  ).toHaveCount(1);
  await expect(
    page.locator(
      'lucide-icon[data-testid="repository-entry-icon"][icon="file-image"]',
    ),
  ).toHaveCount(1);
  await expect(
    page.locator(
      'lucide-icon[data-testid="repository-entry-icon"][icon="file-code"]',
    ),
  ).toHaveCount(1);
  await expect(
    page.locator(
      'lucide-icon[data-testid="repository-entry-icon"][icon="folder"] svg',
    ),
  ).toBeVisible();
  await expect(
    page.locator(
      'lucide-icon[data-testid="repository-entry-icon"][icon="file-text"] svg',
    ),
  ).toBeVisible();
  await expect(
    page.locator(
      'lucide-icon[data-testid="repository-entry-icon"][icon="file-image"] svg',
    ),
  ).toBeVisible();
  await expect(
    page.locator(
      'lucide-icon[data-testid="repository-entry-icon"][icon="file-code"] svg',
    ),
  ).toBeVisible();
  const initialCount = await page.evaluate(
    () => window.__documentNavigationCount,
  );
  await page.getByText("notes.txt", { exact: true }).first().click();
  await expect(page.getByTestId("file-page")).toBeVisible();
  await expect(page.getByTestId("file-code-block")).toContainText(
    "plain text preview",
  );
  await page.goBack();
  await expect(page.getByTestId("file-page")).toHaveCount(0);
  await page.goForward();
  await expect(page.getByTestId("file-code-block")).toContainText(
    "plain text preview",
  );
  await page.getByRole("button", { name: "Back to files" }).click();
  await page.getByText("app.js", { exact: true }).first().click();
  await expect(page.getByTestId("file-page-icon")).toHaveAttribute(
    "icon",
    "file-code",
  );
  await expect(page.getByTestId("file-page-icon").locator("svg")).toBeVisible();
  await expect(page.getByTestId("file-language")).toHaveText("javascript");
  await expect(
    page.getByTestId("file-code-block").locator(".hljs-keyword"),
  ).toContainText("const");
  await page.getByRole("button", { name: "Back to files" }).click();
  await page.getByText("photo.jpg", { exact: true }).first().click();
  const imagePreview = page.getByRole("img", { name: "photo.jpg" });
  await expect(imagePreview).toBeVisible();
  await expect
    .poll(() => imagePreview.evaluate((image) => image.naturalWidth))
    .toBe(1);
  await page.goBack();
  await expect(page.getByTestId("file-page")).toHaveCount(0);
  await page.goForward();
  await expect(page.getByRole("img", { name: "photo.jpg" })).toBeVisible();
  expect(await page.evaluate(() => window.__documentNavigationCount)).toBe(
    initialCount,
  );
});

test("organization and repository navigation replaces the displayed page", async ({
  page,
}) => {
  await page.goto("/ui/?org=example&repo=demo");
  await expect(
    page.getByText("notes.txt", { exact: true }).first(),
  ).toBeVisible();

  await page.getByRole("banner").getByRole("link", { name: "example" }).click();
  await expect(
    page.getByRole("navigation", { name: "Folder path" }),
  ).toHaveCount(0);
  await expect(page.locator("[data-repository-view]")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Event stream" })).toHaveCount(
    1,
  );
  await expect(page.getByTestId("organization-event-stream")).toBeVisible();

  if (page.viewportSize().width < 768) {
    await page.getByRole("button", { name: "Toggle repositories" }).click();
  }
  await page
    .getByTestId("repository-sidebar-list")
    .getByRole("link", { name: "demo" })
    .click();
  await expect(
    page
      .getByRole("navigation", { name: "Folder path" })
      .getByRole("link", { name: "Root" }),
  ).toHaveCount(1);
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
  await expect(
    page.getByText("notes.txt", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByLabel("Select files to upload")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create branch" })).toHaveCount(
    0,
  );
});
