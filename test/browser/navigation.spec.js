/* global window */
const { test, expect } = require("playwright/test");
let currentEntries;
let currentBranches;
let currentTags;
let currentCommits;
let runtimeErrors;
let imageBytes;

test.beforeEach(async ({ page }) => {
  runtimeErrors = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      runtimeErrors.push(message.text());
    }
  });
  page.on("requestfailed", (request) => runtimeErrors.push(`${request.url()}: ${request.failure()?.errorText}`));
  const li3Source = await fetch("https://cdn.li3.dev/@li3/web").then((response) => response.text());
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
    { path: "docs", name: "docs", type: "directory" },
  ];
  currentBranches = ["main"];
  currentTags = [];
  currentCommits = [{ hash: "abcdef123456", message: "Initial commit", author_name: "Browser Tester" }];
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
    route.fulfill({ status: 200, contentType: "application/javascript", body: "" }),
  );
  await page.route("https://cdnjs.cloudflare.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/css", body: "" }),
  );
  await page.route("**/ui/session", (route) =>
    route.fulfill({ json: { authenticated: true, canWrite: true, profile: { name: "Browser Tester" } } }),
  );
  await page.route("**/ui/config", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/v1/orgs", (route) => route.fulfill({ json: [{ slug: "example" }] }));
  await page.route("**/api/v1/orgs/example/repos", (route) => route.fulfill({ json: { repos: [{ repo: "demo" }] } }));
  await page.route("**/api/v1/orgs/example/repos/demo/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/tree")) {
      return route.fulfill({ json: currentEntries });
    }
    if (url.pathname.endsWith("/log")) {
      return route.fulfill({ json: currentCommits });
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
          { hash: "fedcba654321", message: body.message, author_name: "Browser Tester" },
          ...currentCommits,
        ];
        currentEntries = currentEntries.map((entry) => ({ ...entry, uncommitted: false }));
      }
      return route.fulfill({ json: { message: "OK" } });
    }
    if (url.pathname.endsWith("/file") && url.searchParams.get("path") === "photo.jpg") {
      return route.fulfill({ status: 200, contentType: "image/jpeg", body: imageBytes });
    }
    if (url.pathname.endsWith("/file")) {
      return route.fulfill({ status: 200, contentType: "text/plain", body: "plain text preview" });
    }
    return route.fulfill({ json: {} });
  });
});

test.afterEach(() => {
  expect(runtimeErrors).toEqual([]);
});

test("uploads and branch, tag, and commit mutations update without document reload", async ({ page }) => {
  await page.goto("/ui/?org=example&repo=demo");
  const initialCount = await page.evaluate(() => window.__documentNavigationCount);

  await page.locator("#repo-upload-input").setInputFiles({
    name: "uploaded.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("uploaded content"),
  });
  await expect(page.getByRole("link", { name: /uploaded\.txt/ })).toBeVisible();

  await page.getByRole("button", { name: "Create branch" }).click();
  await page.locator("#branch-popover input").fill("feature/ui");
  await page.locator("#branch-popover button[type=submit]").click();
  await expect(page.getByRole("link", { name: "feature/ui" })).toBeVisible();

  await page.getByRole("button", { name: "Create tag" }).click();
  await page.locator("#tag-popover input").fill("v1.0");
  await page.locator("#tag-popover button[type=submit]").click();
  await expect(page.getByRole("link", { name: "v1.0" })).toBeVisible();

  await page.getByRole("link", { name: /uploaded\.txt/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByPlaceholder("Commit message").fill("Save uploaded file");
  await page.getByRole("button", { name: "Commit" }).click();
  await expect(page.getByText("Save uploaded file", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has("path")).toBe(false);

  await page.getByRole("button", { name: "+ Add file" }).click();
  await page.locator("#add-file-popover input").fill("src/created.md");
  await page.locator("#add-file-popover button[type=submit]").click();
  await expect(page.getByRole("link", { name: /created\.md/ })).toBeVisible();
  expect(await page.evaluate(() => window.__documentNavigationCount)).toBe(initialCount);
});

test("SPA navigation, previews, history, and read-only controls", async ({ page }) => {
  await page.goto("/ui/?org=example&repo=demo");
  await expect(page.getByText("notes.txt", { exact: true }).first()).toBeVisible();
  const initialCount = await page.evaluate(() => window.__documentNavigationCount);
  await page.getByText("notes.txt", { exact: true }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator("pre")).toContainText("plain text preview");
  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goForward();
  await expect(page.locator("pre")).toContainText("plain text preview");
  await page.getByRole("button", { name: "Close preview" }).click();
  await page.getByText("photo.jpg", { exact: true }).first().click();
  const imagePreview = page.getByRole("img", { name: "Image preview" });
  await expect(imagePreview).toBeVisible();
  await expect.poll(() => imagePreview.evaluate((image) => image.naturalWidth)).toBe(1);
  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goForward();
  await expect(page.getByRole("img", { name: "Image preview" })).toBeVisible();
  expect(await page.evaluate(() => window.__documentNavigationCount)).toBe(initialCount);
});

test("read-only UI hides write controls", async ({ page }) => {
  await page.route("**/ui/session", (route) =>
    route.fulfill({ json: { authenticated: true, canWrite: false, profile: { name: "Reader" } } }),
  );
  await page.goto("/ui/?org=example&repo=demo");
  await expect(page.getByText("notes.txt", { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel("Select files to upload")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create branch" })).toHaveCount(0);
});
