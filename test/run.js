const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "git-store-test-"));
process.env.DATA_PATH = dataPath;
process.env.OIDC_ISSUER = "";
process.env.OIDC_CLIENT_ID = "";
process.env.OIDC_CLIENT_SECRET = "test-client-secret";

const app = require("../index");
const { encodeSubjectDir } = require("../storage");
const readWriteScopes = ["repo:read", "repo:write"];
const tokenSubjects = new Map([
  ["token-a", { active: true, sub: "oidc-subject-a", preferred_username: "same-nickname", scope: "repo:write" }],
  [
    "token-b",
    { active: true, sub: "oidc-subject-b", preferred_username: "same-nickname", scope: readWriteScopes.join(" ") },
  ],
  ["read-only", { active: true, sub: "read-only-subject", scope: "repo:read" }],
  ["unscoped", { active: true, sub: "unscoped-subject" }],
  ["browser-session-token", { active: true, sub: "browser-subject", scope: "repo:read repo:write" }],
]);

// This injects verification inside this test process only. No fake token is
// accepted by production HTTP requests unless a test explicitly installs it.
app.locals.verifyToken = async (token) => tokenSubjects.get(token) || null;

function request(port, method, requestPath, body, token, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { ...extraHeaders };
    if (payload !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const req = http.request({ hostname: "127.0.0.1", port, method, path: requestPath, headers }, (res) => {
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        responseBody += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: responseBody }));
    });
    req.on("error", reject);
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

async function run() {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;

  try {
    const createA = await request(port, "POST", "/repos/shared-repo", undefined, "token-a");
    const createB = await request(port, "POST", "/repos/shared-repo", undefined, "token-b");
    assert.strictEqual(createA.status, 201);
    assert.strictEqual(createB.status, 201);

    const repoA = path.join(dataPath, encodeSubjectDir("oidc-subject-a"), "shared-repo");
    const repoB = path.join(dataPath, encodeSubjectDir("oidc-subject-b"), "shared-repo");
    assert.ok(fs.existsSync(path.join(repoA, ".git")));
    assert.ok(fs.existsSync(path.join(repoB, ".git")));
    assert.notStrictEqual(repoA, repoB);
    assert.ok(!repoA.includes("same-nickname"), "nickname must not appear in ownership path");

    const listA = await request(port, "GET", "/repos", undefined, "token-a");
    const listB = await request(port, "GET", "/repos", undefined, "token-b");
    assert.deepStrictEqual(JSON.parse(listA.body), [{ repo: "shared-repo" }]);
    assert.deepStrictEqual(JSON.parse(listB.body), [{ repo: "shared-repo" }]);

    const readOnlyList = await request(port, "GET", "/repos", undefined, "read-only");
    assert.strictEqual(readOnlyList.status, 200, "repo:read permits repository listing");
    const readOnlyRepo = path.join(dataPath, encodeSubjectDir("read-only-subject"), "read-only-repo");
    fs.mkdirSync(readOnlyRepo, { recursive: true });
    await require("simple-git").simpleGit(readOnlyRepo).init();
    fs.writeFileSync(path.join(readOnlyRepo, "readme.txt"), "read only");
    const readOnlyTree = await request(port, "GET", "/repos/read-only-repo/tree", undefined, "read-only");
    assert.strictEqual(readOnlyTree.status, 200, "repo:read permits repository file listing");
    assert.deepStrictEqual(
      JSON.parse(readOnlyTree.body).map((entry) => entry.path),
      ["readme.txt"],
    );
    assert.strictEqual((await request(port, "GET", "/repos/read-only-repo/log", undefined, "read-only")).status, 200);
    assert.deepStrictEqual(
      JSON.parse((await request(port, "GET", "/repos/read-only-repo/branches", undefined, "read-only")).body),
      [],
      "empty repositories have an empty branch list",
    );
    assert.deepStrictEqual(
      JSON.parse((await request(port, "GET", "/repos/read-only-repo/tags", undefined, "read-only")).body),
      [],
    );
    assert.strictEqual(
      (await request(port, "GET", "/repos/read-only-repo/file?path=readme.txt", undefined, "read-only")).status,
      200,
    );
    assert.deepStrictEqual(
      JSON.parse(
        (await request(port, "GET", "/repos/read-only-repo/history?path=readme.txt", undefined, "read-only")).body,
      ),
      [],
    );
    const crossSubjectTree = await request(port, "GET", "/repos/shared-repo/tree", undefined, "read-only");
    assert.strictEqual(crossSubjectTree.status, 404, "repo:read identity cannot access another subject repository");
    const readOnlyCreate = await request(port, "POST", "/repos/not-allowed", undefined, "read-only");
    assert.strictEqual(readOnlyCreate.status, 403, "repo:read cannot create repositories");
    const readOnlyUpload = await request(
      port,
      "POST",
      "/repos/shared-repo/files",
      { path: "forbidden.txt", content: "eA==" },
      "read-only",
    );
    assert.strictEqual(readOnlyUpload.status, 403, "repo:read cannot write repository files");
    const unscopedList = await request(port, "GET", "/repos", undefined, "unscoped");
    assert.strictEqual(unscopedList.status, 403, "authenticated API token without repo scope is forbidden");
    const unscopedCreate = await request(port, "POST", "/repos/not-allowed", undefined, "unscoped");
    assert.strictEqual(unscopedCreate.status, 403, "unscoped API token cannot create repositories");
    const readOnlyMutations = [
      ["POST", "/repos/shared-repo/stage", { files: ["private.txt"] }],
      ["POST", "/repos/shared-repo/unstage", { files: ["private.txt"] }],
      ["POST", "/repos/shared-repo/commit", { message: "forbidden" }],
      ["POST", "/repos/shared-repo/tags", { name: "forbidden" }],
      ["DELETE", "/repos/shared-repo/tags/v1"],
      ["POST", "/repos/shared-repo/branches", { name: "forbidden" }],
      ["DELETE", "/repos/shared-repo/branches/feature"],
    ];
    for (const [method, requestPath, body] of readOnlyMutations) {
      const response = await request(port, method, requestPath, body, "read-only");
      assert.strictEqual(response.status, 403, `${method} ${requestPath} requires repo:write`);
    }

    const forgedSession = await request(port, "POST", "/repos/cookie-repo", undefined, undefined, {
      Cookie: "connect.sid=provider-cookie",
      Origin: `http://127.0.0.1:${port}`,
    });
    assert.strictEqual(forgedSession.status, 401, "provider cookies alone cannot authenticate the app");
    const crossOrigin = await request(port, "POST", "/repos/cross-origin-repo", undefined, undefined, {
      Cookie: "git_store_session=forged",
      Origin: "https://attacker.example",
    });
    assert.strictEqual(crossOrigin.status, 401, "cross-origin cookie requests are rejected");

    const upload = await request(
      port,
      "POST",
      "/repos/shared-repo/files",
      { path: "private.txt", content: Buffer.from("subject A").toString("base64") },
      "token-a",
    );
    assert.strictEqual(upload.status, 201);
    const fileA = await request(port, "GET", "/repos/shared-repo/file?path=private.txt", undefined, "token-a");
    const fileB = await request(port, "GET", "/repos/shared-repo/file?path=private.txt", undefined, "token-b");
    assert.strictEqual(fileA.status, 200);
    assert.strictEqual(fileA.body, "subject A");
    assert.strictEqual(fileB.status, 404, "another subject must not read repository files");

    const largerPayload = Buffer.alloc(128 * 1024, "x");
    const largeUpload = await request(
      port,
      "POST",
      "/repos/shared-repo/files",
      { path: "large.bin", content: largerPayload.toString("base64") },
      "token-a",
    );
    assert.strictEqual(largeUpload.status, 201, "uploads larger than Express default JSON limit must work");
    assert.strictEqual(
      fs.readFileSync(path.join(repoA, "large.bin")).length,
      largerPayload.length,
      "uploaded binary content should be decoded without loss",
    );

    const emptyLog = await request(port, "GET", "/repos/shared-repo/log", undefined, "token-a");
    assert.strictEqual(emptyLog.status, 200);
    assert.deepStrictEqual(JSON.parse(emptyLog.body), []);
    const emptyFile = await request(
      port,
      "POST",
      "/repos/shared-repo/files",
      { path: "nested/empty.txt", content: "" },
      "token-a",
    );
    assert.strictEqual(emptyFile.status, 201, "full-path empty files can be created");
    assert.strictEqual(fs.readFileSync(path.join(repoA, "nested/empty.txt")).length, 0);
    const stage = await request(
      port,
      "POST",
      "/repos/shared-repo/stage",
      { files: ["private.txt", "nested/empty.txt"] },
      "token-a",
    );
    assert.strictEqual(stage.status, 200);
    const commit = await request(port, "POST", "/repos/shared-repo/commit", { message: "identity test" }, "token-a");
    assert.strictEqual(commit.status, 200);
    const log = await request(port, "GET", "/repos/shared-repo/log", undefined, "token-a");
    assert.strictEqual(JSON.parse(log.body).length, 1);
    const history = await request(port, "GET", "/repos/shared-repo/history?path=private.txt", undefined, "token-a");
    assert.strictEqual(JSON.parse(history.body).length, 1);

    const addTag = await request(port, "POST", "/repos/shared-repo/tags", { name: "v1" }, "token-a");
    assert.strictEqual(addTag.status, 200);
    const tags = await request(port, "GET", "/repos/shared-repo/tags", undefined, "token-a");
    assert.ok(JSON.parse(tags.body).includes("v1"));
    assert.strictEqual((await request(port, "DELETE", "/repos/shared-repo/tags/v1", undefined, "token-a")).status, 200);

    const addBranch = await request(port, "POST", "/repos/shared-repo/branches", { name: "feature" }, "token-a");
    assert.strictEqual(addBranch.status, 200, addBranch.body);
    const branches = await request(port, "GET", "/repos/shared-repo/branches", undefined, "token-a");
    assert.ok(JSON.parse(branches.body).includes("feature"));
    assert.strictEqual(
      (await request(port, "DELETE", "/repos/shared-repo/branches/feature", undefined, "token-a")).status,
      200,
    );

    const unstageUpload = await request(
      port,
      "POST",
      "/repos/shared-repo/files",
      { path: "unstaged.txt", content: Buffer.from("unstaged").toString("base64") },
      "token-a",
    );
    assert.strictEqual(unstageUpload.status, 201);
    assert.strictEqual(
      (await request(port, "POST", "/repos/shared-repo/stage", { files: ["unstaged.txt"] }, "token-a")).status,
      200,
    );
    assert.strictEqual(
      (await request(port, "POST", "/repos/shared-repo/unstage", { files: ["unstaged.txt"] }, "token-a")).status,
      200,
    );

    const traversal = await request(port, "GET", "/repos/shared-repo/file?path=..%2Foutside", undefined, "token-a");
    assert.strictEqual(traversal.status, 400, "path traversal must be rejected");
    fs.writeFileSync(path.join(dataPath, "outside-secret.txt"), "outside");
    fs.symlinkSync(dataPath, path.join(repoA, "escape"), "dir");
    const symlinkTraversal = await request(
      port,
      "GET",
      "/repos/shared-repo/file?path=escape%2Foutside-secret.txt",
      undefined,
      "token-a",
    );
    assert.strictEqual(symlinkTraversal.status, 400, "symlink traversal must be rejected");
    assert.strictEqual((await request(port, "POST", "/repos/%2E%2E", undefined, "token-a")).status, 400);
    const oldOwnerRoute = await request(port, "GET", "/repos/same-nickname/shared-repo/log", undefined, "token-a");
    assert.strictEqual(oldOwnerRoute.status, 404, "old owner-selected route must not be supported");

    const protectedRequests = [
      ["GET", "/repos"],
      ["POST", "/repos/new-repo"],
      ["GET", "/repos/shared-repo/log"],
      ["GET", "/repos/shared-repo/tree"],
      ["GET", "/repos/shared-repo/file?path=private.txt"],
      ["GET", "/repos/shared-repo/history?path=private.txt"],
      ["GET", "/repos/shared-repo/branches"],
      ["GET", "/repos/shared-repo/tags"],
      ["POST", "/repos/shared-repo/files", { path: "no.txt", content: "eA==" }],
      ["POST", "/repos/shared-repo/stage", { files: ["private.txt"] }],
      ["POST", "/repos/shared-repo/unstage", { files: ["private.txt"] }],
      ["POST", "/repos/shared-repo/commit", { message: "test" }],
      ["POST", "/repos/shared-repo/tags", { name: "v1" }],
      ["DELETE", "/repos/shared-repo/tags/v1"],
      ["POST", "/repos/shared-repo/branches", { name: "feature" }],
      ["DELETE", "/repos/shared-repo/branches/feature"],
    ];
    for (const [method, requestPath, body] of protectedRequests) {
      const response = await request(port, method, requestPath, body);
      assert.strictEqual(response.status, 401, `${method} ${requestPath} should require authentication`);
    }

    const specResponse = await request(port, "GET", "/api");
    assert.strictEqual(specResponse.status, 200);
    const spec = JSON.parse(specResponse.body);
    const expectedMethods = {
      "/health": ["get"],
      "/api": ["get"],
      "/config": ["get"],
      "/session": ["get"],
      "/auth/login": ["get"],
      "/auth/callback": ["get"],
      "/auth/logout": ["post"],
      "/repos": ["get"],
      "/repos/{repo}": ["post"],
      "/repos/{repo}/log": ["get"],
      "/repos/{repo}/tree": ["get"],
      "/repos/{repo}/file": ["get"],
      "/repos/{repo}/history": ["get"],
      "/repos/{repo}/branches": ["get", "post"],
      "/repos/{repo}/tags": ["get", "post"],
      "/repos/{repo}/files": ["post"],
      "/repos/{repo}/stage": ["post"],
      "/repos/{repo}/unstage": ["post"],
      "/repos/{repo}/commit": ["post"],
      "/repos/{repo}/tags/{name}": ["delete"],
      "/repos/{repo}/branches/{name}": ["delete"],
    };
    assert.deepStrictEqual(Object.keys(spec.paths).sort(), Object.keys(expectedMethods).sort());
    for (const [specPath, methods] of Object.entries(expectedMethods)) {
      assert.deepStrictEqual(Object.keys(spec.paths[specPath]).sort(), methods.sort(), `methods for ${specPath}`);
      if (specPath.startsWith("/repos")) {
        for (const method of methods) {
          assert.ok(spec.paths[specPath][method].security, `${method} ${specPath} must be authenticated`);
        }
      }
    }
    assert.strictEqual(spec.paths["/repos"]["get"]["x-required-scope"], "repo:read or repo:write");
    assert.strictEqual(spec.paths["/repos/{repo}"].post["x-required-scope"], "repo:write");
    assert.strictEqual(spec.paths["/repos/{repo}/tags"].post["x-required-scope"], "repo:write");

    const configResponse = await request(port, "GET", "/config");
    assert.strictEqual(configResponse.status, 200);
    assert.strictEqual(
      JSON.parse(configResponse.body).oidcLoginUrl,
      null,
      "login URL stays disabled without OIDC config",
    );
    const guestSession = await request(port, "GET", "/session");
    assert.deepStrictEqual(JSON.parse(guestSession.body), { authenticated: false, profile: null });
    const unavailableLogin = await request(port, "GET", "/auth/login");
    assert.strictEqual(unavailableLogin.status, 503, "login must fail clearly when OIDC is not configured");

    let authorizationOptions;
    app.locals.oidcClientOverride = {
      authorizationUrl(options) {
        authorizationOptions = options;
        const authorizationUrl = new URL("/authorize", "https://issuer.example.test");
        for (const [key, value] of Object.entries(options)) {
          authorizationUrl.searchParams.set(key, value);
        }
        return authorizationUrl.toString();
      },
      async callback(redirectUri, callbackParams, checks) {
        assert.strictEqual(callbackParams.code, "mock-code");
        assert.strictEqual(callbackParams.state, checks.state);
        assert.ok(checks.code_verifier);
        assert.strictEqual(checks.nonce, undefined, "the issuer's supported PKCE flow does not issue a nonce claim");
        assert.ok(redirectUri.endsWith("/auth/callback"));
        return {
          access_token: "browser-session-token",
          expires_in: 3600,
          claims: () => ({ sub: "browser-subject" }),
        };
      },
    };
    process.env.OIDC_ISSUER = "https://issuer.example.test";
    process.env.OIDC_CLIENT_ID = "mock-git-store-client";
    process.env.OIDC_BROWSER_SCOPES = "repo:read repo:write";
    const nativeFetch = global.fetch;
    global.fetch = async (url, options) => {
      assert.strictEqual(String(url), "https://issuer.example.test/userinfo");
      assert.strictEqual(options.headers.Authorization, "Bearer browser-session-token");
      return { ok: true, json: async () => ({ id: "browser-subject", name: "Signed In" }) };
    };
    const login = await request(port, "GET", "/auth/login?returnTo=%2F%3Frepo%3Dresume");
    assert.strictEqual(login.status, 302);
    assert.ok(authorizationOptions.scope.includes("repo:read repo:write"));
    const authorizationUrl = new URL(login.headers.location);
    const loginCookies = login.headers["set-cookie"].map((cookie) => cookie.split(";")[0]).join("; ");
    const callback = await request(
      port,
      "GET",
      `/auth/callback?code=mock-code&state=${encodeURIComponent(authorizationUrl.searchParams.get("state"))}`,
      undefined,
      undefined,
      { Cookie: loginCookies },
    );
    assert.strictEqual(callback.status, 303);
    assert.strictEqual(callback.headers.location, "/?repo=resume");
    const sessionCookie = callback.headers["set-cookie"]
      .find((cookie) => cookie.startsWith("git_store_session="))
      .split(";")[0];
    assert.ok(
      !sessionCookie.includes("browser-session-token"),
      "the access token must not be stored in the browser cookie",
    );
    const sessionCreatedRepo = await request(port, "POST", "/repos/session-repo", undefined, undefined, {
      Cookie: sessionCookie,
      Origin: `http://127.0.0.1:${port}`,
    });
    assert.strictEqual(sessionCreatedRepo.status, 201, "OIDC browser sessions with repo:write can create repositories");
    const browserProfile = await request(port, "GET", "/session", undefined, undefined, {
      Cookie: sessionCookie,
      Origin: `http://127.0.0.1:${port}`,
    });
    assert.deepStrictEqual(JSON.parse(browserProfile.body), {
      authenticated: true,
      profile: { id: "browser-subject", sub: "browser-subject", name: "Signed In" },
    });
    const tokenVerifier = app.locals.verifyToken;
    process.env.OIDC_CLIENT_ID = "mock-git-store-client";
    app.locals.verifyToken = null;
    global.fetch = async (url, options) => {
      assert.strictEqual(String(url), "https://issuer.example.test/oauth/introspect");
      assert.strictEqual(
        options.headers.Authorization,
        `Basic ${Buffer.from("mock-git-store-client:test-client-secret").toString("base64")}`,
      );
      assert.ok(String(options.body).includes("token=opaque-api-token"));
      return {
        ok: true,
        json: async () => ({ active: true, sub: "introspected-subject", scope: "repo:read repo:write" }),
      };
    };
    const introspectedList = await request(port, "GET", "/repos", undefined, "opaque-api-token");
    assert.strictEqual(introspectedList.status, 200, "opaque repo:read/write API token should introspect successfully");
    const introspectedWrite = await request(
      port,
      "POST",
      "/repos/not-created/tags",
      { name: "v1" },
      "opaque-api-token",
    );
    assert.strictEqual(
      introspectedWrite.status,
      404,
      "repo:write scope passes authorization before missing repo lookup",
    );
    app.locals.verifyToken = tokenVerifier;
    process.env.OIDC_CLIENT_ID = "";
    const logout = await request(port, "POST", "/auth/logout", undefined, undefined, {
      Cookie: sessionCookie,
      Origin: `http://127.0.0.1:${port}`,
    });
    assert.strictEqual(logout.status, 303);
    const loggedOutList = await request(port, "GET", "/repos", undefined, undefined, { Cookie: sessionCookie });
    assert.strictEqual(loggedOutList.status, 401, "logout invalidates the browser session");
    global.fetch = nativeFetch;
    process.env.OIDC_ISSUER = "";
    process.env.OIDC_CLIENT_ID = "";
    process.env.OIDC_BROWSER_SCOPES = "";
    app.locals.oidcClientOverride = null;

    const uiResponse = await request(port, "GET", "/");
    assert.strictEqual(uiResponse.status, 200);
    assert.ok(uiResponse.body.includes("{{ repo.repo }}"));
    assert.ok(uiResponse.body.includes("repo=${encodeURIComponent(repo.repo)}"));
    assert.ok(!uiResponse.body.includes("{{ repo.owner }}"));
    assert.ok(uiResponse.body.includes("fixed inset-0 z-30 bg-black/40 md:hidden"));
    assert.ok(uiResponse.body.includes('on-click="closeMenu()"'));
    assert.ok(uiResponse.body.includes('popover="auto"'));
    assert.ok(uiResponse.body.includes('popovertargetaction="hide"'));
    assert.ok(uiResponse.body.includes('type="file"'));
    assert.ok(uiResponse.body.includes('on-change="handleFileSelect($event.target.files)"'));
    assert.ok(uiResponse.body.includes('on-drop.prevent="upload($event)"'));
    assert.ok(
      uiResponse.body.includes('<template if="dragging"'),
      "drag/drop helper should only appear while dragging",
    );
    assert.ok(
      !uiResponse.body.includes("document.getElementById"),
      "UI should use Li³ bindings rather than direct DOM lookups",
    );
    assert.ok(uiResponse.body.includes("No branches."));
    assert.ok(uiResponse.body.includes("No tags."));
    const mainStart = uiResponse.body.indexOf("<main ");
    const viewerSetupStart = uiResponse.body.indexOf("<script setup>", mainStart);
    const viewerSetupEnd = uiResponse.body.indexOf("</script>", viewerSetupStart);
    const viewerSetup = uiResponse.body.slice(viewerSetupStart, viewerSetupEnd);
    assert.ok(viewerSetup.includes("const setAddFilePath"), "add-file input handler must be in the viewer app island");
    assert.ok(viewerSetup.includes("setAddFilePath,"), "viewer app island must expose the add-file input handler");
    const sidebarComponent = fs.readFileSync(path.join(__dirname, "../public/components/repo-sidebar.html"), "utf8");
    const repoPanelComponent = fs.readFileSync(path.join(__dirname, "../public/components/repo-panel.html"), "utf8");
    const repoViewerComponent = fs.readFileSync(path.join(__dirname, "../public/components/repo-viewer.html"), "utf8");
    assert.ok(!sidebarComponent.includes("item.owner"));
    assert.ok(sidebarComponent.includes('popover="auto"'));
    assert.ok(!sidebarComponent.includes("dialogOpen"));
    assert.ok(!repoPanelComponent.includes("owner="));
    assert.ok(repoPanelComponent.includes("No branches."));
    assert.ok(repoPanelComponent.includes("No tags."));
    assert.ok(!repoViewerComponent.includes("No commits yet"));
    assert.ok(repoViewerComponent.includes('id="repo-file-input"'));

    const health = await request(port, "GET", "/health");
    assert.strictEqual(health.status, 200);
    console.log("All integration tests passed.");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
