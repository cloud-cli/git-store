import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { simpleGit } from "simple-git";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "git-store-test-"));
process.env.DATA_PATH = dataPath;
process.env.OIDC_ISSUER = "";
process.env.OIDC_CLIENT_ID = "";
process.env.OIDC_CLIENT_SECRET = "test-client-secret";

const app = (await import("../index.js")).default;
const organizations = await import("../organizations.js");
const { hashSubject } = await import("../storage.js");
organizations.create("introspected-subject", "introspected-org");
const auditEvents = [];
app.locals.auditStore = {
  async append(event) {
    auditEvents.push({
      id: `event-${auditEvents.length + 1}`,
      occurredAt: new Date().toISOString(),
      ...event,
    });
  },
  async list(org, limit, offset) {
    return auditEvents.filter((event) => event.org === org).slice(offset, offset + limit);
  },
};
const readWriteScopes = ["repo:read", "repo:write"];
const tokenSubjects = new Map([
  [
    "token-a",
    {
      active: true,
      sub: "oidc-subject-a",
      preferred_username: "same-nickname",
      scope: "repo:write",
    },
  ],
  [
    "token-b",
    {
      active: true,
      sub: "oidc-subject-b",
      preferred_username: "same-nickname",
      scope: readWriteScopes.join(" "),
    },
  ],
  ["read-only", { active: true, sub: "read-only-subject", scope: "repo:read" }],
  ["unscoped", { active: true, sub: "unscoped-subject" }],
  ["browser-session-token", { active: true, sub: "browser-subject", scope: "repo:read repo:write" }],
  ["opaque-api-token", { active: true, sub: "oidc-subject-a", scope: "repo:read repo:write" }],
  ["foreign-subject-token", { active: true, sub: "oidc-subject-b", scope: "repo:write org:create" }],
  ["unregistered-active", { active: true, sub: "oidc-subject-a", scope: "repo:write" }],
]);

const organizationsByToken = {
  "token-a": "team-one",
  "token-b": "team-two",
  "read-only": "reader-org",
  unscoped: "unscoped-org",
  "browser-session-token": "browser-org",
  "opaque-api-token": "introspected-org",
};

// This injects verification inside this test process only. No fake token is
// accepted by production HTTP requests unless a test explicitly installs it.
app.locals.verifyToken = async (token) => tokenSubjects.get(token) || null;
for (const [token, claims] of tokenSubjects) {
  if (
    claims.active &&
    claims.sub !== "introspected-subject" &&
    !["unscoped", "opaque-api-token", "foreign-subject-token", "unregistered-active"].includes(token)
  ) {
    app.locals.tokenAuthorizations.bindExternal({
      token,
      ownerHash: hashSubject(claims.sub),
      label: `test ${token}`,
      scopes: token === "read-only" ? ["repo:read"] : ["repo:read", "repo:write", "org:create", "org:manage"],
      orgs: [],
    });
  }
}
const readOnlyOwner = hashSubject("read-only-subject");
organizations.createForOwnerHash(readOnlyOwner, "reader-org");
const readOnlyAuthorization = app.locals.tokenAuthorizations.findByToken("read-only");
app.locals.tokenAuthorizations.grantOrg(readOnlyAuthorization.id, readOnlyOwner, "reader-org");

// Legacy-shaped test paths are shorthand for the actor's organization; rawPath
// bypasses this test-only mapping to assert removed public routes stay absent.
function request(port, method, requestPath, body, token, extraHeaders = {}, rawPath = false) {
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

    let actualPath = requestPath;
    if (!rawPath && /^\/api\/v1\/repos(?:\/|$)/.test(actualPath)) {
      const browserToken = headers.Cookie?.includes("git_store_session=") ? "browser-session-token" : null;
      const organization = organizationsByToken[token || browserToken] || "team-one";
      actualPath = actualPath.replace(/^\/api\/v1\/repos(?=\/|$)/, `/api/v1/orgs/${organization}/repos`);
    }
    if (!rawPath && /^\/git\/[^/]+\.git\//.test(actualPath)) {
      const basic = /^Basic\s+([A-Za-z0-9+/]+=*)$/i.exec(headers.Authorization || "");
      const password = basic ? Buffer.from(basic[1], "base64").toString("utf8").split(":").slice(1).join(":") : "";
      const organization = organizationsByToken[password] || "team-one";
      actualPath = actualPath.replace(/^\/git\//, `/git/${organization}/`);
    }

    const req = http.request({ hostname: "127.0.0.1", port, method, path: actualPath, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => {
        chunks.push(Buffer.from(chunk));
      });
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
          rawBody: Buffer.concat(chunks),
        }),
      );
    });
    req.on("error", reject);
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

async function git(args, options = {}) {
  return execFileAsync("git", args, {
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
}

async function run() {
  const ui = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  const organizationLanding = fs.readFileSync(
    path.join(__dirname, "../public/components/organization-landing.html"),
    "utf8",
  );
  const organizationSettings = fs.readFileSync(
    path.join(__dirname, "../public/components/organization-settings.html"),
    "utf8",
  );
  const signInLanding = fs.readFileSync(path.join(__dirname, "../public/components/sign-in-landing.html"), "utf8");
  assert.strictEqual((ui.match(/<template app>/g) || []).length, 1, "the page has a single shared Li³ app root");
  assert.strictEqual((ui.match(/<script setup>/g) || []).length, 1, "all page state has one setup context");
  assert.ok(ui.includes("showWorkspace && orgRepositories.length > 0"), "repository sidebar waits for repositories");
  assert.ok(ui.includes('on-click="openSettings()"'), "user card opens in-app settings");
  assert.ok(
    ui.includes('data-testid="workspace-breadcrumbs"') && ui.includes('for="breadcrumb of breadcrumbs"'),
    "workspace breadcrumbs use one route-derived list",
  );
  assert.ok(
    ui.includes("const breadcrumbs = computed(() =>"),
    "workspace breadcrumbs are derived from current route state",
  );
  assert.ok(ui.includes('bind-repositories="orgRepositories"'), "landing pages receive root-owned repository state");
  assert.ok(ui.includes('on-createrepo="createFirstRepository($event.detail)"'), "landing actions update root state");
  assert.ok(!/{{\s*repo\.repo\s*}}\s*<\/h1>/.test(ui), "repository name is not repeated below the breadcrumb");
  assert.ok(ui.includes("Welcome to your Git server"), "empty repository welcome uses the Git server wording");
  assert.ok(organizationLanding.includes("Organizations"), "organization home is a dedicated Li³ component");
  assert.ok(
    organizationLanding.includes("No repositories found in {{ org }}"),
    "empty organization state does not claim the user has no repository elsewhere",
  );
  assert.ok(organizationLanding.includes('defineEvent("createrepo")'), "landing emits repository creation to the root");
  assert.ok(organizationSettings.includes('href="/?settings=organizations"'), "settings is a dedicated Li³ component");
  assert.ok(organizationSettings.includes('defineEvent("createorg")'), "settings emits org creation to the root");
  assert.ok(signInLanding.includes("Welcome back"), "anonymous landing welcomes returning users");
  const publicMarkup = [ui, organizationLanding, organizationSettings, signInLanding];
  for (const componentName of ["file-preview", "repo-sidebar", "repo-panel", "repo-viewer"]) {
    publicMarkup.push(fs.readFileSync(path.join(__dirname, `../public/components/${componentName}.html`), "utf8"));
  }
  assert.ok(
    publicMarkup.every((markup) => !/\sstyle=/.test(markup)),
    "public UI has no inline custom styles",
  );
  assert.ok(
    publicMarkup.every((markup) => !/<i\b/.test(markup)),
    "public UI uses component-based icons",
  );
  assert.ok(
    publicMarkup.every((markup) => !/\bflow-[a-z]/.test(markup)),
    "public UI uses Tailwind utilities over custom classes",
  );
  assert.ok(ui.includes("Your account does not have repository write access (repo:write)."));
  assert.ok(ui.includes("session.canWrite === true"), "write capability comes from the browser-session response");
  assert.ok(ui.includes('result.error || "Upload failed."'), "upload errors preserve backend diagnostics");
  assert.ok(ui.includes("authStatus === 'authenticated' && repoLoadError && !settings"));
  assert.ok(ui.includes('template if="addFileError"'), "add-file errors stay within the add-file dialog");
  for (const popoverId of ["create-repo-popover", "add-file-popover", "branch-popover", "tag-popover"]) {
    const popoverStart = ui.indexOf(`id="${popoverId}"`);
    const popoverMarkup = ui.slice(popoverStart, ui.indexOf(">", popoverStart));
    assert.ok(popoverMarkup.includes("dark:text-gray-100"), `${popoverId} has readable dark-mode text`);
  }
  assert.ok(
    ui.includes('currentUrl.searchParams.delete("repo")'),
    "changing organizations clears dependent repo state",
  );
  assert.ok(ui.includes("initialSettingsTab"), "settings route is selected in-app via initialSettingsTab");
  assert.ok(
    ui.includes(
      'if (!session.authenticated) {\n                  profile.value = null;\n                  authStatus.value = "anonymous";\n                  return;',
    ),
    "anonymous visitors do not load private organization/repository state",
  );
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;

  try {
    assert.strictEqual((await request(port, "GET", "/api/v1/orgs", undefined, "unscoped")).status, 403);
    assert.strictEqual((await request(port, "POST", "/api/v1/orgs", { slug: "blocked" }, "unscoped")).status, 403);
    const badSlugResult = await request(port, "POST", "/api/v1/orgs", { slug: "bad slug" }, "token-a");
    assert.strictEqual(badSlugResult.status, 400, badSlugResult.body);
    const orgCreated = await request(port, "POST", "/api/v1/orgs", { slug: "Team-One" }, "token-a");
    assert.strictEqual(orgCreated.status, 201);
    assert.deepStrictEqual(JSON.parse(orgCreated.body), {
      org: { slug: "team-one" },
    });
    assert.strictEqual(
      (await request(port, "GET", "/api/v1/orgs", undefined, "unregistered-active")).status,
      403,
      "active but unregistered bearer is denied",
    );
    assert.strictEqual((await request(port, "POST", "/api/v1/orgs", { slug: "team-one" }, "token-b")).status, 409);
    for (const [token, slug] of [
      ["token-a", "team-extra"],
      ["token-b", "team-two"],
      ["browser-session-token", "browser-org"],
    ]) {
      const oldClaims = tokenSubjects.get(token);
      tokenSubjects.set(token, { ...oldClaims, scope: "repo:write" });
      const created = await request(port, "POST", "/api/v1/orgs", { slug }, token);
      assert.strictEqual(created.status, 201);
      tokenSubjects.set(token, oldClaims);
    }
    assert.strictEqual((await request(port, "POST", "/api/v1/orgs", { slug: "reader-org" }, "read-only")).status, 403);
    assert.deepStrictEqual(JSON.parse((await request(port, "GET", "/api/v1/orgs", undefined, "token-a")).body), {
      orgs: [{ slug: "team-extra" }, { slug: "team-one" }],
    });
    assert.deepStrictEqual(JSON.parse((await request(port, "GET", "/api/v1/orgs", undefined, "token-b")).body), {
      orgs: [{ slug: "team-two" }],
    });
    const ownEvents = await request(port, "GET", "/api/v1/orgs/team-one/events", undefined, "token-a");
    assert.strictEqual(ownEvents.status, 200, "organization owners can read their event stream");
    assert.strictEqual(ownEvents.headers["cache-control"], "no-store", "audit events are not cached by browsers");
    assert.strictEqual(
      (await request(port, "GET", "/api/v1/orgs/team-one/events?limit=101", undefined, "token-a")).status,
      400,
      "audit event page size is bounded",
    );
    assert.strictEqual(
      (await request(port, "GET", "/api/v1/orgs/team-one/events", undefined, "token-b")).status,
      403,
      "users cannot read another organization's event stream",
    );
    const organizationMetadata = fs.readFileSync(path.join(dataPath, "orgs", "team-one", ".organization.json"), "utf8");
    assert.ok(!organizationMetadata.includes("oidc-subject-a"), "organization metadata must not persist raw subjects");
    assert.match(JSON.parse(organizationMetadata).ownerHash, /^[a-f0-9]{64}$/);
    organizations.reload();
    assert.deepStrictEqual(organizations.listForSubject("oidc-subject-a"), [
      { slug: "team-extra" },
      { slug: "team-one" },
    ]);
    fs.mkdirSync(path.join(dataPath, "orgs", "broken"), { recursive: true });
    fs.writeFileSync(path.join(dataPath, "orgs", "broken", ".organization.json"), "not json");
    fs.mkdirSync(path.join(dataPath, "orgs", "../escape"), { recursive: true });
    organizations.reload();
    assert.strictEqual(organizations.get("broken"), null);
    assert.strictEqual(organizations.get("../escape"), null);
    assert.strictEqual(
      (await request(port, "POST", "/api/v1/orgs/team-one/repos/inside", undefined, "token-a")).status,
      201,
    );
    assert.strictEqual((await request(port, "GET", "/api/v1/orgs/team-one/repos", undefined, "token-a")).status, 200);
    assert.strictEqual(
      (await request(port, "GET", "/api/v1/orgs/team-one/repos/inside/tree", undefined, "token-a")).status,
      200,
    );
    assert.strictEqual(
      (await request(port, "GET", "/api/v1/orgs/team-one/repos/inside/tree", undefined, "token-b")).status,
      404,
    );
    assert.strictEqual(
      (await request(port, "POST", "/api/v1/orgs/team-one/repos/outside", undefined, "token-b")).status,
      404,
    );
    const orgRepoPath = path.join(dataPath, "orgs", "team-one", "inside");
    fs.writeFileSync(path.join(orgRepoPath, "org.txt"), "organization repository\n");
    await git(["-C", orgRepoPath, "add", "org.txt"]);
    await git([
      "-C",
      orgRepoPath,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-m",
      "initial organization commit",
    ]);
    const scopedFile = await request(
      port,
      "POST",
      "/api/v1/orgs/team-one/repos/inside/files",
      {
        path: "from-ui.txt",
        content: Buffer.from("org-scoped write").toString("base64"),
      },
      "token-a",
    );
    assert.strictEqual(scopedFile.status, 201, `org-scoped upload works: ${scopedFile.body}`);
    const scopedStage = await request(
      port,
      "POST",
      "/api/v1/orgs/team-one/repos/inside/stage",
      { files: ["from-ui.txt"] },
      "token-a",
    );
    assert.strictEqual(scopedStage.status, 200, `org-scoped stage works: ${scopedStage.body}`);
    const scopedCommit = await request(
      port,
      "POST",
      "/api/v1/orgs/team-one/repos/inside/commit",
      { message: "org scoped write" },
      "token-a",
    );
    assert.strictEqual(scopedCommit.status, 200, `org-scoped commit works: ${scopedCommit.body}`);
    const scopedRepos = await request(port, "GET", "/api/v1/orgs/team-one/repos", undefined, "token-a");
    assert.deepStrictEqual(JSON.parse(scopedRepos.body).repos, [{ repo: "inside" }]);
    const readOnlyScopedWrite = await request(
      port,
      "POST",
      "/api/v1/orgs/reader-org/repos/readonly-repo/files",
      { path: "denied.txt", content: "" },
      "read-only",
    );
    assert.strictEqual(readOnlyScopedWrite.status, 403, "repo:read grants no repository write access");
    const orgClonePath = path.join(dataPath, "clone-org");
    const orgAuthHeader = `Authorization: Basic ${Buffer.from("arbitrary-user:token-a").toString("base64")}`;
    const orgGitUrl = `http://127.0.0.1:${port}/git/team-one/inside.git`;
    await git(["-c", `http.extraheader=${orgAuthHeader}`, "clone", orgGitUrl, orgClonePath]);
    assert.strictEqual(fs.readFileSync(path.join(orgClonePath, "org.txt"), "utf8"), "organization repository\n");
    fs.writeFileSync(path.join(orgClonePath, "pushed.txt"), "organization push\n");
    await git(["-C", orgClonePath, "add", "pushed.txt"]);
    await git([
      "-C",
      orgClonePath,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-m",
      "organization push",
    ]);
    await git([
      "-c",
      "http.postBuffer=1",
      "-c",
      `http.extraheader=${orgAuthHeader}`,
      "-C",
      orgClonePath,
      "push",
      "origin",
      "HEAD:refs/heads/from-org-http",
    ]);
    assert.ok(
      auditEvents.some(
        (event) =>
          event.org === "team-one" &&
          event.event === "git.branch.created" &&
          event.object.endsWith("@refs/heads/from-org-http"),
      ),
      "Git pushes create per-ref audit entries",
    );
    assert.strictEqual(
      (await git(["--git-dir", path.join(orgRepoPath, ".git"), "show", "from-org-http:pushed.txt"])).stdout,
      "organization push\n",
    );
    const foreignOrgGit = await request(
      port,
      "GET",
      "/git/team-one/inside.git/info/refs?service=git-upload-pack",
      undefined,
      undefined,
      {
        Authorization: `Basic ${Buffer.from("user:token-b").toString("base64")}`,
      },
    );
    assert.strictEqual(foreignOrgGit.status, 404, "organization Git transport is limited to its owning subject");
    const canonicalizedOrgGit = await request(
      port,
      "GET",
      "/git/TEAM-ONE/inside.git/info/refs?service=git-upload-pack",
      undefined,
      undefined,
      {
        Authorization: `Basic ${Buffer.from("user:token-a").toString("base64")}`,
      },
    );
    assert.strictEqual(canonicalizedOrgGit.status, 200, "Git transport canonicalizes case-insensitive org slugs");
    const createA = await request(port, "POST", "/api/v1/repos/shared-repo", undefined, "token-a");
    const createB = await request(port, "POST", "/api/v1/repos/shared-repo", undefined, "token-b");
    assert.strictEqual(createA.status, 201);
    assert.strictEqual(createB.status, 201);

    const repoA = path.join(dataPath, "orgs", "team-one", "shared-repo");
    const repoB = path.join(dataPath, "orgs", "team-two", "shared-repo");
    assert.ok(fs.existsSync(path.join(repoA, ".git")));
    assert.ok(fs.existsSync(path.join(repoB, ".git")));
    assert.notStrictEqual(repoA, repoB);
    assert.ok(!repoA.includes("same-nickname"), "nickname must not appear in ownership path");

    assert.strictEqual((await request(port, "POST", "/api/v1/repos/git-http", undefined, "token-a")).status, 201);
    const gitRepoPath = path.join(dataPath, "orgs", "team-one", "git-http");
    fs.writeFileSync(path.join(gitRepoPath, "initial.txt"), "initial\n");
    fs.writeFileSync(path.join(gitRepoPath, "old-atomic.txt"), "remove from committed tree\n");
    await git(["-C", gitRepoPath, "add", "initial.txt", "old-atomic.txt"]);
    await git([
      "-C",
      gitRepoPath,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-m",
      "initial",
    ]);
    fs.writeFileSync(path.join(gitRepoPath, "initial.txt"), "working tree version\n");
    const committedFile = await request(
      port,
      "GET",
      "/api/v1/orgs/team-one/repos/git-http/file?path=initial.txt&ref=HEAD",
      undefined,
      "token-a",
    );
    assert.strictEqual(committedFile.status, 200);
    assert.strictEqual(committedFile.body, "initial\n", "ref reads committed content instead of the worktree");
    const { stdout: commitSha } = await git(["-C", gitRepoPath, "rev-parse", "HEAD"]);
    assert.strictEqual(committedFile.headers["x-git-commit"], commitSha.trim());
    const headFile = await request(
      port,
      "HEAD",
      "/api/v1/orgs/team-one/repos/git-http/file?path=initial.txt&ref=HEAD",
      undefined,
      "token-a",
    );
    assert.strictEqual(headFile.status, 200);
    assert.strictEqual(headFile.body, "", "HEAD returns headers without a response body");
    assert.strictEqual(headFile.headers["x-git-commit"], commitSha.trim());
    const missingRefFile = await request(
      port,
      "GET",
      "/api/v1/orgs/team-one/repos/git-http/file?path=initial.txt&ref=missing-branch",
      undefined,
      "token-a",
    );
    assert.strictEqual(missingRefFile.status, 404);
    const invalidRefFile = await request(
      port,
      "GET",
      "/api/v1/orgs/team-one/repos/git-http/file?path=initial.txt&ref=--upload-pack=evil",
      undefined,
      "token-a",
    );
    assert.strictEqual(invalidRefFile.status, 400);
    await git(["-C", gitRepoPath, "tag", "fixture-tag", commitSha.trim()]);
    const createDetachedWorktree = await request(
      port,
      "POST",
      "/api/v1/orgs/team-one/repos/git-http/worktrees",
      { ref: commitSha.trim() },
      "token-a",
    );
    assert.strictEqual(createDetachedWorktree.status, 201, createDetachedWorktree.body);
    const detachedWorktree = JSON.parse(createDetachedWorktree.body);
    assert.strictEqual(detachedWorktree.ref, commitSha.trim());
    assert.strictEqual(detachedWorktree.branch, null);
    assert.strictEqual(
      (
        await git([
          "-C",
          path.join(dataPath, "worktrees", "team-one", "git-http", detachedWorktree.worktreeId),
          "rev-parse",
          "HEAD",
        ])
      ).stdout.trim(),
      commitSha.trim(),
    );
    const createSecondWorktree = await request(
      port,
      "POST",
      "/api/v1/orgs/team-one/repos/git-http/worktrees",
      { ref: "fixture-tag" },
      "token-a",
    );
    assert.strictEqual(createSecondWorktree.status, 201, createSecondWorktree.body);
    const secondWorktree = JSON.parse(createSecondWorktree.body);
    assert.notStrictEqual(secondWorktree.worktreeId, detachedWorktree.worktreeId);
    assert.strictEqual(secondWorktree.ref, commitSha.trim());
    const committedTree = await request(
      port,
      "GET",
      `/api/v1/orgs/team-one/repos/git-http/tree?ref=${commitSha.trim()}&worktreeId=${detachedWorktree.worktreeId}`,
      undefined,
      "token-a",
    );
    assert.strictEqual(committedTree.status, 200, committedTree.body);
    assert.deepStrictEqual(JSON.parse(committedTree.body), {
      ref: commitSha.trim(),
      commit: commitSha.trim(),
      files: [
        {
          path: "initial.txt",
          mode: "100644",
          type: "blob",
          sha: (await git(["-C", gitRepoPath, "rev-parse", `${commitSha.trim()}:initial.txt`])).stdout.trim(),
        },
        {
          path: "old-atomic.txt",
          mode: "100644",
          type: "blob",
          sha: (await git(["-C", gitRepoPath, "rev-parse", `${commitSha.trim()}:old-atomic.txt`])).stdout.trim(),
        },
      ],
    });
    assert.strictEqual(
      (
        await request(
          port,
          "GET",
          "/api/v1/orgs/team-one/repos/git-http/tree?ref=missing-tree-ref",
          undefined,
          "token-a",
        )
      ).status,
      404,
    );
    assert.strictEqual(
      (
        await request(
          port,
          "GET",
          "/api/v1/orgs/team-one/repos/git-http/tree?ref=--upload-pack=evil",
          undefined,
          "token-a",
        )
      ).status,
      400,
    );
    const worktreeList = await request(
      port,
      "GET",
      "/api/v1/orgs/team-one/repos/git-http/worktrees",
      undefined,
      "token-a",
    );
    assert.deepStrictEqual(
      JSON.parse(worktreeList.body)
        .worktrees.map(({ worktreeId }) => worktreeId)
        .sort(),
      [detachedWorktree.worktreeId, secondWorktree.worktreeId].sort(),
    );
    assert.strictEqual(
      (await request(port, "DELETE", "/api/v1/orgs/team-one/repos/git-http", undefined, "token-a")).status,
      409,
      "repository deletion is blocked while linked worktrees exist",
    );
    assert.strictEqual(
      (
        await request(
          port,
          "POST",
          "/api/v1/orgs/team-one/repos/git-http/files?worktreeId=missing",
          { path: "x", content: "eA==" },
          "token-a",
        )
      ).status,
      404,
    );
    assert.strictEqual(
      (
        await request(
          port,
          "GET",
          `/api/v1/orgs/team-one/repos/git-http/file?path=initial.txt&ref=${commitSha.trim()}&worktreeId=missing`,
          undefined,
          "token-a",
        )
      ).status,
      404,
      "an explicitly selected unknown worktree is never silently ignored",
    );
    assert.strictEqual(
      (
        await request(
          port,
          "POST",
          "/api/v1/orgs/team-one/repos/git-http/files?worktreeId=invalid!",
          { path: "x", content: "eA==" },
          "token-a",
        )
      ).status,
      404,
    );
    const worktreeUpload = await request(
      port,
      "POST",
      `/api/v1/orgs/team-one/repos/git-http/files?worktreeId=${detachedWorktree.worktreeId}`,
      { path: "worktree-only.txt", content: Buffer.from("worktree content\n").toString("base64") },
      "token-a",
    );
    assert.strictEqual(worktreeUpload.status, 201, worktreeUpload.body);
    const worktreeRead = await request(
      port,
      "GET",
      `/api/v1/orgs/team-one/repos/git-http/file?path=worktree-only.txt&worktreeId=${detachedWorktree.worktreeId}`,
      undefined,
      "token-a",
    );
    assert.strictEqual(worktreeRead.body, "worktree content\n");
    const worktreeUpdate = await request(
      port,
      "POST",
      `/api/v1/orgs/team-one/repos/git-http/files?worktreeId=${detachedWorktree.worktreeId}`,
      { path: "worktree-only.txt", content: Buffer.from("updated worktree content\n").toString("base64") },
      "token-a",
    );
    assert.strictEqual(worktreeUpdate.status, 201);
    assert.strictEqual(
      (
        await request(
          port,
          "GET",
          `/api/v1/orgs/team-one/repos/git-http/file?path=worktree-only.txt&worktreeId=${detachedWorktree.worktreeId}`,
          undefined,
          "token-a",
        )
      ).body,
      "updated worktree content\n",
    );
    assert.strictEqual(
      (
        await request(
          port,
          "POST",
          `/api/v1/orgs/team-one/repos/git-http/files?worktreeId=${detachedWorktree.worktreeId}`,
          { path: ".git", content: Buffer.from("corrupt").toString("base64") },
          "token-a",
        )
      ).status,
      400,
      "file writes cannot replace linked-worktree Git metadata",
    );
    assert.strictEqual(fs.readFileSync(path.join(gitRepoPath, "initial.txt"), "utf8"), "working tree version\n");
    const dirtyWorktreeRemove = await request(
      port,
      "DELETE",
      `/api/v1/orgs/team-one/repos/git-http/worktrees/${detachedWorktree.worktreeId}`,
      undefined,
      "token-a",
    );
    assert.strictEqual(dirtyWorktreeRemove.status, 409);
    const worktreeDelete = await request(
      port,
      "DELETE",
      `/api/v1/orgs/team-one/repos/git-http/files?path=worktree-only.txt&worktreeId=${detachedWorktree.worktreeId}`,
      undefined,
      "token-a",
    );
    assert.strictEqual(worktreeDelete.status, 200, worktreeDelete.body);
    for (const { worktreeId } of [detachedWorktree, secondWorktree]) {
      const remove = await request(
        port,
        "DELETE",
        `/api/v1/orgs/team-one/repos/git-http/worktrees/${worktreeId}`,
        undefined,
        "token-a",
      );
      assert.strictEqual(remove.status, 200, remove.body);
    }
    assert.strictEqual(
      (await request(port, "GET", "/api/v1/orgs/team-one/repos/git-http/worktrees", undefined, "token-a")).body,
      '{"worktrees":[]}',
    );
    assert.strictEqual(
      (await request(port, "DELETE", "/api/v1/orgs/team-one/repos/git-http/worktrees/not-a-uuid", undefined, "token-a"))
        .status,
      404,
    );
    const atomicRepo = gitRepoPath;
    const atomicDraftPath = path.join(atomicRepo, "atomic-draft.txt");
    fs.writeFileSync(atomicDraftPath, "draft state must remain staged\n");
    await git(["-C", atomicRepo, "add", "atomic-draft.txt"]);
    const indexBeforeAtomic = fs.readFileSync(path.join(atomicRepo, ".git", "index"));
    const stagedEntriesBeforeAtomic = await git(["-C", atomicRepo, "ls-files", "--stage"]);
    const worktreeBeforeAtomic = fs.readFileSync(path.join(atomicRepo, "initial.txt"));
    const atomicCommitResponse = await request(
      port,
      "POST",
      "/api/v1/orgs/team-one/repos/git-http/commits",
      {
        expectedRef: commitSha.trim(),
        message: "Atomic API change",
        changes: [
          { path: "atomic.txt", content: Buffer.from("atomic content\n").toString("base64") },
          { path: "old-atomic.txt", delete: true },
        ],
      },
      "token-a",
    );
    assert.strictEqual(atomicCommitResponse.status, 201, atomicCommitResponse.body);
    const atomicResult = JSON.parse(atomicCommitResponse.body);
    assert.strictEqual(atomicResult.ref, "refs/heads/main");
    assert.strictEqual(
      (
        await git(["-C", atomicRepo, "rev-list", "--count", `${commitSha.trim()}..${atomicResult.commit}`])
      ).stdout.trim(),
      "1",
      "atomic changes create exactly one commit",
    );
    assert.strictEqual((await git(["-C", atomicRepo, "show", "main:atomic.txt"])).stdout, "atomic content\n");
    const createTargetBranch = await request(
      port,
      "POST",
      "/api/v1/orgs/team-one/repos/git-http/branches",
      { name: "feature-api", startPoint: atomicResult.commit },
      "token-a",
    );
    assert.strictEqual(createTargetBranch.status, 200, createTargetBranch.body);
    const targetBranchCommit = await request(
      port,
      "POST",
      "/api/v1/orgs/team-one/repos/git-http/commits",
      {
        expectedRef: atomicResult.commit,
        targetBranch: "feature-api",
        message: "Atomic non-main target",
        changes: [{ path: "feature-api.txt", content: Buffer.from("feature branch\n").toString("base64") }],
      },
      "token-a",
    );
    assert.strictEqual(targetBranchCommit.status, 201, targetBranchCommit.body);
    const targetBranchResult = JSON.parse(targetBranchCommit.body);
    assert.strictEqual(targetBranchResult.ref, "refs/heads/feature-api");
    assert.strictEqual(
      (await git(["-C", atomicRepo, "show", "feature-api:feature-api.txt"])).stdout,
      "feature branch\n",
    );
    const staleTargetCommit = await request(
      port,
      "POST",
      "/api/v1/orgs/team-one/repos/git-http/commits",
      {
        expectedRef: commitSha.trim(),
        targetBranch: "feature-api",
        message: "Stale non-main target",
        changes: [{ path: "stale-feature.txt", content: Buffer.from("stale").toString("base64") }],
      },
      "token-a",
    );
    assert.strictEqual(staleTargetCommit.status, 409);
    assert.strictEqual(
      (await git(["-C", atomicRepo, "rev-parse", "refs/heads/feature-api"])).stdout.trim(),
      targetBranchResult.commit,
    );
    assert.strictEqual(fs.existsSync(path.join(atomicRepo, ".git", "index")), true);
    assert.deepStrictEqual(fs.readFileSync(path.join(atomicRepo, ".git", "index")), indexBeforeAtomic);
    assert.deepStrictEqual(fs.readFileSync(path.join(atomicRepo, "initial.txt")), worktreeBeforeAtomic);
    assert.strictEqual(
      (await git(["-C", atomicRepo, "ls-files", "--stage"])).stdout,
      stagedEntriesBeforeAtomic.stdout,
      "atomic commit leaves the shared staged state untouched",
    );
    const staleAtomic = await request(
      port,
      "POST",
      "/api/v1/orgs/team-one/repos/git-http/commits",
      {
        expectedRef: commitSha.trim(),
        message: "Must not commit stale data",
        changes: [{ path: "stale.txt", content: Buffer.from("stale").toString("base64") }],
      },
      "token-a",
    );
    assert.strictEqual(staleAtomic.status, 409);
    const invalidAtomic = await request(
      port,
      "POST",
      "/api/v1/orgs/team-one/repos/git-http/commits",
      {
        expectedRef: atomicResult.commit,
        message: "Invalid change set",
        changes: [
          { path: "would-not-appear.txt", content: Buffer.from("nope").toString("base64") },
          { path: "nested/.GIT/config", content: Buffer.from("bad").toString("base64") },
        ],
      },
      "token-a",
    );
    assert.strictEqual(invalidAtomic.status, 400);
    assert.strictEqual(
      (await git(["-C", atomicRepo, "rev-parse", "refs/heads/main"])).stdout.trim(),
      atomicResult.commit,
      "invalid changes do not partially move main",
    );
    const gitClonePath = path.join(dataPath, "clone-a");
    const authHeader = `Authorization: Basic ${Buffer.from("arbitrary-user:token-a").toString("base64")}`;
    const gitUrl = `http://127.0.0.1:${port}/git/team-one/git-http.git`;
    await git(["-c", `http.extraheader=${authHeader}`, "clone", gitUrl, gitClonePath]);
    assert.strictEqual(fs.readFileSync(path.join(gitClonePath, "initial.txt"), "utf8"), "initial\n");
    fs.writeFileSync(path.join(gitClonePath, "pushed.txt"), "push works\n");
    await git(["-C", gitClonePath, "add", "pushed.txt"]);
    await git([
      "-C",
      gitClonePath,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-m",
      "push",
    ]);
    await git([
      "-c",
      `http.extraheader=${authHeader}`,
      "-C",
      gitClonePath,
      "push",
      "origin",
      "HEAD:refs/heads/from-http",
      "HEAD:refs/tags/push-tag",
    ]);
    assert.ok(
      auditEvents.some(
        (event) => event.event === "git.branch.created" && event.object.endsWith("@refs/heads/from-http"),
      ),
      "push events include the changed ref",
    );
    assert.ok(
      auditEvents.some((event) => event.event === "git.tag.created" && event.object.endsWith("@refs/tags/push-tag")),
      "one push can produce a distinct tag event alongside branch changes",
    );
    assert.ok(
      auditEvents.every((event) => event.tokenFingerprint !== "token-a"),
      "raw bearer tokens are never stored",
    );
    const pushedFile = await git(["--git-dir", path.join(gitRepoPath, ".git"), "show", "from-http:pushed.txt"]);
    assert.strictEqual(pushedFile.stdout, "push works\n");
    const missingGitAuth = await request(port, "GET", "/git/git-http.git/info/refs?service=git-upload-pack");
    assert.strictEqual(missingGitAuth.status, 401);
    assert.match(missingGitAuth.headers["www-authenticate"], /^Basic /);
    const invalidGitAuth = await request(
      port,
      "GET",
      "/git/git-http.git/info/refs?service=git-upload-pack",
      undefined,
      undefined,
      {
        Authorization: `Basic ${Buffer.from("user:missing").toString("base64")}`,
      },
    );
    assert.strictEqual(invalidGitAuth.status, 401);
    const readOnlyAuth = `Basic ${Buffer.from("user:read-only").toString("base64")}`;
    const deniedGitPush = await request(
      port,
      "GET",
      "/git/git-http.git/info/refs?service=git-receive-pack",
      undefined,
      undefined,
      {
        Authorization: readOnlyAuth,
      },
    );
    assert.strictEqual(deniedGitPush.status, 403);
    const foreignGitRepo = await request(
      port,
      "GET",
      "/git/git-http.git/info/refs?service=git-upload-pack",
      undefined,
      undefined,
      {
        Authorization: `Basic ${Buffer.from("user:read-only").toString("base64")}`,
      },
    );
    assert.strictEqual(foreignGitRepo.status, 404);

    const listA = await request(port, "GET", "/api/v1/repos", undefined, "token-a");
    const listB = await request(port, "GET", "/api/v1/repos", undefined, "token-b");
    assert.deepStrictEqual(JSON.parse(listA.body), {
      repos: [{ repo: "git-http" }, { repo: "inside" }, { repo: "shared-repo" }],
    });
    assert.deepStrictEqual(JSON.parse(listB.body), {
      repos: [{ repo: "shared-repo" }],
    });

    const readOnlyList = await request(port, "GET", "/api/v1/repos", undefined, "read-only");
    assert.strictEqual(readOnlyList.status, 200, "repo:read permits repository listing");
    const readOnlyRepo = path.join(dataPath, "orgs", "reader-org", "read-only-repo");
    fs.mkdirSync(readOnlyRepo, { recursive: true });
    await simpleGit(readOnlyRepo).init();
    fs.writeFileSync(path.join(readOnlyRepo, "readme.txt"), "read only");
    assert.strictEqual(
      (await request(port, "DELETE", "/api/v1/repos/read-only-repo/files?path=readme.txt", undefined, "read-only"))
        .status,
      403,
    );
    const readOnlyTree = await request(port, "GET", "/api/v1/repos/read-only-repo/tree", undefined, "read-only");
    assert.strictEqual(readOnlyTree.status, 200, "repo:read permits repository file listing");
    assert.deepStrictEqual(
      JSON.parse(readOnlyTree.body).map((entry) => entry.path),
      ["readme.txt"],
    );
    assert.strictEqual(
      (await request(port, "GET", "/api/v1/repos/read-only-repo/log", undefined, "read-only")).status,
      200,
    );
    assert.deepStrictEqual(
      JSON.parse((await request(port, "GET", "/api/v1/repos/read-only-repo/branches", undefined, "read-only")).body),
      [],
      "empty repositories have an empty branch list",
    );
    assert.deepStrictEqual(
      JSON.parse((await request(port, "GET", "/api/v1/repos/read-only-repo/tags", undefined, "read-only")).body),
      [],
    );
    assert.strictEqual(
      (await request(port, "GET", "/api/v1/repos/read-only-repo/file?path=readme.txt", undefined, "read-only")).status,
      200,
    );
    assert.deepStrictEqual(
      JSON.parse(
        (await request(port, "GET", "/api/v1/repos/read-only-repo/history?path=readme.txt", undefined, "read-only"))
          .body,
      ),
      [],
    );
    const crossSubjectTree = await request(port, "GET", "/api/v1/repos/shared-repo/tree", undefined, "read-only");
    assert.strictEqual(crossSubjectTree.status, 404, "repo:read identity cannot access another subject repository");
    const readOnlyCreate = await request(port, "POST", "/api/v1/repos/not-allowed", undefined, "read-only");
    assert.strictEqual(readOnlyCreate.status, 403, "repo:read cannot create repositories");
    const readOnlyUpload = await request(
      port,
      "POST",
      "/api/v1/repos/shared-repo/files",
      { path: "forbidden.txt", content: "eA==" },
      "read-only",
    );
    assert.strictEqual(readOnlyUpload.status, 403, "repo:read cannot write repository files");
    const unscopedList = await request(port, "GET", "/api/v1/repos", undefined, "unscoped");
    assert.strictEqual(unscopedList.status, 403, "authenticated API token without repo scope is forbidden");
    const unscopedCreate = await request(port, "POST", "/api/v1/repos/not-allowed", undefined, "unscoped");
    assert.strictEqual(unscopedCreate.status, 403, "unscoped API token cannot create repositories");
    const readOnlyMutations = [
      ["POST", "/api/v1/repos/shared-repo/stage", { files: ["private.txt"] }],
      ["POST", "/api/v1/repos/shared-repo/unstage", { files: ["private.txt"] }],
      ["POST", "/api/v1/repos/shared-repo/commit", { message: "forbidden" }],
      ["POST", "/api/v1/repos/shared-repo/tags", { name: "forbidden" }],
      ["DELETE", "/api/v1/repos/shared-repo/tags/v1"],
      ["POST", "/api/v1/repos/shared-repo/branches", { name: "forbidden" }],
      ["DELETE", "/api/v1/repos/shared-repo/branches/feature"],
    ];
    for (const [method, requestPath, body] of readOnlyMutations) {
      const response = await request(port, method, requestPath, body, "read-only");
      assert.strictEqual(response.status, 403, `${method} ${requestPath} requires repo:write`);
    }

    const forgedSession = await request(port, "POST", "/api/v1/repos/cookie-repo", undefined, undefined, {
      Cookie: "connect.sid=provider-cookie",
      Origin: `http://127.0.0.1:${port}`,
    });
    assert.strictEqual(forgedSession.status, 401, "provider cookies alone cannot authenticate the app");
    const crossOrigin = await request(port, "POST", "/api/v1/repos/cross-origin-repo", undefined, undefined, {
      Cookie: "git_store_session=forged",
      Origin: "https://attacker.example",
    });
    assert.strictEqual(crossOrigin.status, 401, "cross-origin cookie requests are rejected");

    const upload = await request(
      port,
      "POST",
      "/api/v1/repos/shared-repo/files",
      {
        path: "private.txt",
        content: Buffer.from("subject A").toString("base64"),
      },
      "token-a",
    );
    assert.strictEqual(upload.status, 201);
    const fileA = await request(port, "GET", "/api/v1/repos/shared-repo/file?path=private.txt", undefined, "token-a");
    const fileB = await request(port, "GET", "/api/v1/repos/shared-repo/file?path=private.txt", undefined, "token-b");
    assert.strictEqual(fileA.status, 200);
    assert.strictEqual(fileA.body, "subject A");
    const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x41, 0x42, 0xff, 0xd9]);
    fs.writeFileSync(path.join(dataPath, "orgs", "team-one", "inside", "preview.jpg"), imageBytes);
    const imageResponse = await request(
      port,
      "GET",
      "/api/v1/orgs/team-one/repos/inside/file?path=preview.jpg",
      undefined,
      "token-a",
    );
    assert.strictEqual(imageResponse.headers["content-type"], "image/jpeg");
    assert.strictEqual(imageResponse.headers["x-content-type-options"], "nosniff");
    assert.deepStrictEqual(imageResponse.rawBody, imageBytes, "image response preserves bytes");
    assert.strictEqual(fileB.status, 404, "another subject must not read repository files");

    assert.strictEqual(
      (await request(port, "DELETE", "/api/v1/repos/shared-repo/files", undefined, "token-a")).status,
      400,
    );
    assert.strictEqual(
      (await request(port, "DELETE", "/api/v1/repos/shared-repo/files?path=%20%20", undefined, "token-a")).status,
      400,
    );
    assert.strictEqual(
      (await request(port, "DELETE", "/api/v1/repos/shared-repo/files?path=.", undefined, "token-a")).status,
      400,
    );
    assert.strictEqual(
      (await request(port, "DELETE", "/api/v1/repos/shared-repo/files?path=.git%2FHEAD", undefined, "token-a")).status,
      400,
    );
    assert.strictEqual(
      (
        await request(
          port,
          "DELETE",
          "/api/v1/repos/shared-repo/files?path=..%2Foutside-secret.txt",
          undefined,
          "token-a",
        )
      ).status,
      400,
    );
    assert.strictEqual(
      (await request(port, "DELETE", "/api/v1/repos/shared-repo/files?path=missing.txt", undefined, "token-a")).status,
      404,
    );
    assert.strictEqual(
      (await request(port, "DELETE", "/api/v1/repos/shared-repo/files?path=private.txt", undefined, "read-only"))
        .status,
      403,
    );
    assert.strictEqual(
      (await request(port, "DELETE", "/api/v1/repos/shared-repo/files?path=private.txt", undefined, "token-b")).status,
      404,
    );

    const largerPayload = Buffer.alloc(128 * 1024, "x");
    const largeUpload = await request(
      port,
      "POST",
      "/api/v1/repos/shared-repo/files",
      { path: "large.bin", content: largerPayload.toString("base64") },
      "token-a",
    );
    assert.strictEqual(largeUpload.status, 201, "uploads larger than Express default JSON limit must work");
    assert.strictEqual(
      fs.readFileSync(path.join(repoA, "large.bin")).length,
      largerPayload.length,
      "uploaded binary content should be decoded without loss",
    );

    const emptyLog = await request(port, "GET", "/api/v1/repos/shared-repo/log", undefined, "token-a");
    assert.strictEqual(emptyLog.status, 200);
    assert.deepStrictEqual(JSON.parse(emptyLog.body), []);
    const emptyFile = await request(
      port,
      "POST",
      "/api/v1/repos/shared-repo/files",
      { path: "nested/empty.txt", content: "" },
      "token-a",
    );
    assert.strictEqual(emptyFile.status, 201, "full-path empty files can be created");
    assert.strictEqual(fs.readFileSync(path.join(repoA, "nested/empty.txt")).length, 0);
    assert.strictEqual(
      (await request(port, "DELETE", "/api/v1/repos/shared-repo/files?path=nested", undefined, "token-a")).status,
      400,
    );
    const stage = await request(
      port,
      "POST",
      "/api/v1/repos/shared-repo/stage",
      { files: ["private.txt", "nested/empty.txt"] },
      "token-a",
    );
    assert.strictEqual(stage.status, 200);
    const commit = await request(
      port,
      "POST",
      "/api/v1/repos/shared-repo/commit",
      { message: "identity test" },
      "token-a",
    );
    assert.strictEqual(commit.status, 200);
    const log = await request(port, "GET", "/api/v1/repos/shared-repo/log", undefined, "token-a");
    assert.strictEqual(JSON.parse(log.body).length, 1);
    fs.writeFileSync(path.join(repoA, "history-check.txt"), "second commit\n");
    await git(["-C", repoA, "-c", "user.name=Test", "-c", "user.email=test@example.test", "add", "history-check.txt"]);
    await git([
      "-C",
      repoA,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-m",
      "second commit",
    ]);
    const limitedLog = await request(port, "GET", "/api/v1/repos/shared-repo/log?limit=1", undefined, "token-a");
    assert.strictEqual(JSON.parse(limitedLog.body).length, 1, "the log endpoint honors its commit limit");
    assert.strictEqual(JSON.parse(limitedLog.body)[0].message, "second commit");
    const completeLog = await request(port, "GET", "/api/v1/repos/shared-repo/log", undefined, "token-a");
    assert.strictEqual(JSON.parse(completeLog.body).length, 2, "omitting the limit preserves the full log");
    const invalidLogLimit = await request(port, "GET", "/api/v1/repos/shared-repo/log?limit=0", undefined, "token-a");
    assert.strictEqual(invalidLogLimit.status, 400, "invalid log limits are rejected");
    const history = await request(
      port,
      "GET",
      "/api/v1/repos/shared-repo/history?path=private.txt",
      undefined,
      "token-a",
    );
    assert.strictEqual(JSON.parse(history.body).length, 1);
    const deleteFile = await request(
      port,
      "DELETE",
      "/api/v1/repos/shared-repo/files?path=private.txt",
      undefined,
      "token-a",
    );
    assert.strictEqual(deleteFile.status, 200, deleteFile.body);
    assert.deepStrictEqual(JSON.parse(deleteFile.body), {
      path: "private.txt",
      deleted: true,
      staged: false,
    });
    assert.strictEqual(
      fs.existsSync(path.join(repoA, "private.txt")),
      false,
      "deleted working-tree file must be absent",
    );
    assert.strictEqual(
      (await request(port, "GET", "/api/v1/repos/shared-repo/file?path=private.txt", undefined, "token-a")).status,
      404,
    );

    const sharedHead = (
      await git(["-C", path.join(dataPath, "orgs", "team-one", "shared-repo"), "rev-parse", "HEAD"])
    ).stdout.trim();
    const addTag = await request(
      port,
      "POST",
      "/api/v1/repos/shared-repo/tags",
      { name: "v1", target: sharedHead },
      "token-a",
    );
    assert.strictEqual(addTag.status, 200);
    assert.strictEqual(
      (
        await git(["-C", path.join(dataPath, "orgs", "team-one", "shared-repo"), "rev-parse", "refs/tags/v1^{commit}"])
      ).stdout.trim(),
      sharedHead,
      "an explicit tag target resolves to the requested commit SHA",
    );
    const tags = await request(port, "GET", "/api/v1/repos/shared-repo/tags", undefined, "token-a");
    assert.ok(JSON.parse(tags.body).includes("v1"));
    assert.strictEqual(
      (await request(port, "DELETE", "/api/v1/repos/shared-repo/tags/v1", undefined, "token-a")).status,
      200,
    );

    const addBranch = await request(port, "POST", "/api/v1/repos/shared-repo/branches", { name: "feature" }, "token-a");
    assert.strictEqual(addBranch.status, 200, addBranch.body);
    const branches = await request(port, "GET", "/api/v1/repos/shared-repo/branches", undefined, "token-a");
    assert.ok(JSON.parse(branches.body).includes("feature"));
    assert.strictEqual(
      (await request(port, "DELETE", "/api/v1/repos/shared-repo/branches/feature", undefined, "token-a")).status,
      200,
    );

    const unstageUpload = await request(
      port,
      "POST",
      "/api/v1/repos/shared-repo/files",
      {
        path: "unstaged.txt",
        content: Buffer.from("unstaged").toString("base64"),
      },
      "token-a",
    );
    assert.strictEqual(unstageUpload.status, 201);
    assert.strictEqual(
      (await request(port, "POST", "/api/v1/repos/shared-repo/stage", { files: ["unstaged.txt"] }, "token-a")).status,
      200,
    );
    assert.strictEqual(
      (await request(port, "POST", "/api/v1/repos/shared-repo/unstage", { files: ["unstaged.txt"] }, "token-a")).status,
      200,
    );

    const traversal = await request(
      port,
      "GET",
      "/api/v1/repos/shared-repo/file?path=..%2Foutside",
      undefined,
      "token-a",
    );
    assert.strictEqual(traversal.status, 400, "path traversal must be rejected");
    fs.writeFileSync(path.join(dataPath, "outside-secret.txt"), "outside");
    fs.symlinkSync(dataPath, path.join(repoA, "escape"), "dir");
    assert.strictEqual(
      (
        await request(
          port,
          "DELETE",
          "/api/v1/repos/shared-repo/files?path=escape%2Foutside-secret.txt",
          undefined,
          "token-a",
        )
      ).status,
      400,
    );
    const symlinkTraversal = await request(
      port,
      "GET",
      "/api/v1/repos/shared-repo/file?path=escape%2Foutside-secret.txt",
      undefined,
      "token-a",
    );
    assert.strictEqual(symlinkTraversal.status, 400, "symlink traversal must be rejected");
    assert.strictEqual((await request(port, "POST", "/api/v1/repos/%2E%2E", undefined, "token-a")).status, 400);
    const oldOwnerRoute = await request(
      port,
      "GET",
      "/api/v1/repos/same-nickname/shared-repo/log",
      undefined,
      "token-a",
    );
    assert.strictEqual(oldOwnerRoute.status, 404, "old owner-selected route must not be supported");

    const protectedRequests = [
      ["GET", "/api/v1/repos"],
      ["POST", "/api/v1/repos/new-repo"],
      ["GET", "/api/v1/repos/shared-repo/log"],
      ["GET", "/api/v1/repos/shared-repo/tree"],
      ["GET", "/api/v1/repos/shared-repo/file?path=private.txt"],
      ["GET", "/api/v1/repos/shared-repo/history?path=private.txt"],
      ["GET", "/api/v1/repos/shared-repo/branches"],
      ["GET", "/api/v1/repos/shared-repo/tags"],
      ["POST", "/api/v1/repos/shared-repo/files", { path: "no.txt", content: "eA==" }],
      ["DELETE", "/api/v1/repos/shared-repo/files?path=private.txt"],
      ["POST", "/api/v1/repos/shared-repo/stage", { files: ["private.txt"] }],
      ["POST", "/api/v1/repos/shared-repo/unstage", { files: ["private.txt"] }],
      ["POST", "/api/v1/repos/shared-repo/commit", { message: "test" }],
      ["POST", "/api/v1/repos/shared-repo/tags", { name: "v1" }],
      ["DELETE", "/api/v1/repos/shared-repo/tags/v1"],
      ["POST", "/api/v1/repos/shared-repo/branches", { name: "feature" }],
      ["DELETE", "/api/v1/repos/shared-repo/branches/feature"],
    ];
    for (const [method, requestPath, body] of protectedRequests) {
      const response = await request(port, method, requestPath, body);
      assert.strictEqual(response.status, 401, `${method} ${requestPath} should require authentication`);
    }

    const rootRedirect = await request(port, "GET", "/?repo=shared-repo&file=private.txt");
    assert.strictEqual(rootRedirect.status, 302);
    assert.strictEqual(rootRedirect.headers.location, "/ui/?repo=shared-repo&file=private.txt");
    assert.strictEqual((await request(port, "GET", "/api/v1/profile/alias", undefined, "token-a")).status, 404);
    assert.strictEqual(
      (await request(port, "PUT", "/api/v1/profile/alias", { alias: "ignored" }, "token-a")).status,
      404,
    );
    assert.strictEqual((await request(port, "GET", "/api/v1/repos", undefined, "token-a", {}, true)).status, 404);
    assert.strictEqual(
      (
        await request(
          port,
          "GET",
          "/git/git-http.git/info/refs?service=git-upload-pack",
          undefined,
          undefined,
          {
            Authorization: `Basic ${Buffer.from("user:token-a").toString("base64")}`,
          },
          true,
        )
      ).status,
      404,
    );
    for (const oldPath of ["/health", "/repos", "/config", "/session", "/auth/login"]) {
      const oldRoute = await request(port, "GET", oldPath);
      assert.strictEqual(oldRoute.status, 404, `${oldPath} must not remain as an alias`);
    }

    const discoveryResponse = await request(port, "GET", "/api");
    assert.strictEqual(discoveryResponse.status, 200);
    assert.match(discoveryResponse.headers["content-type"], /application\/json/);
    const discoverySpec = JSON.parse(discoveryResponse.body);
    assert.strictEqual(discoverySpec.openapi, "3.0.3");
    assert.ok(discoverySpec.paths["/api/v1/orgs"]);
    assert.ok(discoverySpec.paths["/api/v1/orgs/{org}/repos/{repo}/tree"]);
    assert.ok(discoverySpec.paths["/git/{org}/{repo}.git/git-upload-pack"]);
    assert.ok(!Object.keys(discoverySpec.paths).some((route) => route.startsWith("/ui/") || route.includes("static")));
    assert.strictEqual((await request(port, "GET", "/api/v1/openapi.json")).status, 404);
    const spec = discoverySpec;
    const expectedMethods = {
      "/api/v1/health": ["get"],
      "/api": ["get"],
      "/api/v1/orgs": ["get", "post"],
      "/api/v1/personal-access-tokens": ["get", "post"],
      "/api/v1/personal-access-tokens/{id}": ["delete", "patch"],
      "/api/v1/token-authorizations": ["post"],
      "/api/v1/orgs/{org}": ["delete"],
      "/api/v1/orgs/{org}/events": ["get"],
      "/api/v1/orgs/{org}/webhooks": ["get", "post"],
      "/api/v1/orgs/{org}/webhooks/{id}": ["delete"],
      "/api/v1/orgs/{org}/repos": ["get"],
      "/api/v1/orgs/{org}/repos/{repo}": ["post", "delete"],
      "/api/v1/orgs/{org}/repos/{repo}/log": ["get"],
      "/api/v1/orgs/{org}/repos/{repo}/tree": ["get"],
      "/api/v1/orgs/{org}/repos/{repo}/file": ["get", "head"],
      "/api/v1/orgs/{org}/repos/{repo}/history": ["get"],
      "/api/v1/orgs/{org}/repos/{repo}/branches": ["get", "post"],
      "/api/v1/orgs/{org}/repos/{repo}/tags": ["get", "post"],
      "/api/v1/orgs/{org}/repos/{repo}/files": ["post", "delete"],
      "/api/v1/orgs/{org}/repos/{repo}/stage": ["post"],
      "/api/v1/orgs/{org}/repos/{repo}/unstage": ["post"],
      "/api/v1/orgs/{org}/repos/{repo}/commit": ["post"],
      "/api/v1/orgs/{org}/repos/{repo}/commits": ["post"],
      "/api/v1/orgs/{org}/repos/{repo}/worktrees": ["get", "post"],
      "/api/v1/orgs/{org}/repos/{repo}/worktrees/{id}": ["delete"],
      "/api/v1/orgs/{org}/repos/{repo}/tags/{name}": ["delete"],
      "/api/v1/orgs/{org}/repos/{repo}/branches/{name}": ["delete"],
      "/api/v1/repos": ["get"],
      "/api/v1/profile/alias": ["get", "put"],
      "/api/v1/repos/{alias}": ["get"],
      "/api/v1/repos/{alias}/{repo}/log": ["get"],
      "/git/{repo}.git/info/refs": ["get"],
      "/git/{repo}.git/git-upload-pack": ["post"],
      "/git/{repo}.git/git-receive-pack": ["post"],
      "/api/v1/repos/{repo}": ["post"],
      "/api/v1/repos/{repo}/log": ["get"],
      "/api/v1/repos/{repo}/tree": ["get"],
      "/api/v1/repos/{repo}/file": ["get"],
      "/api/v1/repos/{repo}/history": ["get"],
      "/api/v1/repos/{repo}/branches": ["get", "post"],
      "/api/v1/repos/{repo}/tags": ["get", "post"],
      "/api/v1/repos/{repo}/files": ["post", "delete"],
      "/api/v1/repos/{repo}/stage": ["post"],
      "/api/v1/repos/{repo}/unstage": ["post"],
      "/api/v1/repos/{repo}/commit": ["post"],
      "/api/v1/repos/{repo}/commits": ["post"],
      "/api/v1/repos/{repo}/worktrees": ["get", "post"],
      "/api/v1/repos/{repo}/worktrees/{id}": ["delete"],
      "/api/v1/repos/{repo}/tags/{name}": ["delete"],
      "/api/v1/repos/{repo}/branches/{name}": ["delete"],
    };
    for (const [route, methods] of Object.entries(expectedMethods)) {
      if (route.startsWith("/api/v1/repos/{repo}")) {
        expectedMethods[route.replace("/api/v1/repos/{repo}", "/api/v1/repos/{alias}/{repo}")] = [...methods];
      } else if (route.startsWith("/git/{repo}.git/")) {
        expectedMethods[route.replace("/git/{repo}.git", "/git/{org}/{repo}.git")] = [...methods];
      }
    }
    for (const route of Object.keys(expectedMethods)) {
      if (
        route.startsWith("/api/v1/repos") ||
        route === "/api/v1/profile/alias" ||
        route.startsWith("/git/{repo}.git/")
      ) {
        delete expectedMethods[route];
      }
    }
    assert.deepStrictEqual(Object.keys(spec.paths).sort(), Object.keys(expectedMethods).sort());
    assert.ok(
      spec.paths["/api/v1/orgs/{org}/repos/{repo}/log"].get.parameters.some(
        (parameter) => parameter.name === "limit" && parameter.in === "query",
      ),
      "the repository log limit is documented in OpenAPI",
    );
    assert.ok(
      Object.keys(spec.paths).every(
        (specPath) => specPath === "/api" || specPath.startsWith("/api/v1/") || specPath.startsWith("/git/"),
      ),
    );
    for (const [specPath, methods] of Object.entries(expectedMethods)) {
      assert.deepStrictEqual(Object.keys(spec.paths[specPath]).sort(), methods.sort(), `methods for ${specPath}`);
      if (specPath.startsWith("/api/v1/orgs/{org}/")) {
        for (const method of methods) {
          assert.ok(spec.paths[specPath][method].security, `${method} ${specPath} must be authenticated`);
        }
      }
    }
    assert.strictEqual(spec.paths["/api/v1/orgs"]["get"]["x-required-scope"], "repo:read or repo:write");
    assert.strictEqual(spec.paths["/api/v1/orgs/{org}/repos/{repo}"].post["x-required-scope"], "repo:write");
    assert.strictEqual(spec.paths["/api/v1/orgs/{org}/repos/{repo}/tags"].post["x-required-scope"], "repo:write");
    const worktreeCreateOperation = spec.paths["/api/v1/orgs/{org}/repos/{repo}/worktrees"].post;
    assert.strictEqual(worktreeCreateOperation["x-required-scope"], "repo:write");
    assert.ok(
      spec.paths["/api/v1/orgs/{org}/repos/{repo}/files"].post.parameters.some(
        (parameter) => parameter.name === "worktreeId" && parameter.in === "query",
      ),
      "OpenAPI documents the optional worktree target on file writes",
    );
    assert.ok(
      spec.paths["/api/v1/orgs/{org}/repos/{repo}/commits"].post.requestBody.content["application/json"].schema
        .properties.targetBranch,
      "OpenAPI documents atomic commit targetBranch",
    );
    assert.ok(
      spec.paths["/api/v1/orgs/{org}/repos/{repo}/tags"].post.requestBody.content["application/json"].schema.properties
        .target,
      "OpenAPI documents explicit tag targets",
    );
    const deleteFileOperation = spec.paths["/api/v1/orgs/{org}/repos/{repo}/files"].delete;
    assert.strictEqual(deleteFileOperation["x-required-scope"], "repo:write");
    assert.ok(deleteFileOperation.responses["403"], "file deletion documents insufficient scope");
    assert.ok(!spec.paths["/api/v1/profile/alias"]);
    assert.ok(!spec.paths["/api/v1/repos"]);

    const configResponse = await request(port, "GET", "/ui/config");
    assert.strictEqual(configResponse.status, 200);
    assert.strictEqual(
      JSON.parse(configResponse.body).oidcLoginUrl,
      null,
      "login URL stays disabled without OIDC config",
    );
    const guestSession = await request(port, "GET", "/ui/session");
    assert.deepStrictEqual(JSON.parse(guestSession.body), {
      authenticated: false,
      profile: null,
    });
    const unavailableLogin = await request(port, "GET", "/ui/auth/login");
    assert.strictEqual(unavailableLogin.status, 503, "login must fail clearly when OIDC is not configured");

    let authorizationOptions;
    let expectedCallbackPath = "/ui/auth/callback";
    let oidcUserInfo = {
      id: "browser-subject",
      name: "Signed In",
      preferred_username: "browser-user",
    };
    let oidcIdClaims = { sub: "browser-subject" };
    let oidcAccessToken = "browser-session-token";
    let oidcRefreshToken = "browser-refresh-token";
    let oidcExpiresIn = 3600;
    let oidcNextRefreshExpiresIn = 3600;
    let oidcRefreshCount = 0;
    app.locals.oidcClientOverride = {
      buildAuthorizationUrl(options) {
        authorizationOptions = options;
        const authorizationUrl = new URL("/authorize", "https://issuer.example.test");
        for (const [key, value] of Object.entries(options)) {
          authorizationUrl.searchParams.set(key, value);
        }
        return authorizationUrl;
      },
      async authorizationCodeGrant(callbackUrl, checks) {
        assert.strictEqual(callbackUrl.searchParams.get("code"), "mock-code");
        assert.strictEqual(callbackUrl.searchParams.get("state"), checks.expectedState);
        assert.ok(checks.pkceCodeVerifier);
        assert.ok(callbackUrl.pathname.endsWith(expectedCallbackPath));
        return {
          access_token: oidcAccessToken,
          refresh_token: oidcRefreshToken,
          expires_in: oidcExpiresIn,
          claims: () => oidcIdClaims,
        };
      },
      async refreshTokenGrant(refreshToken) {
        assert.strictEqual(refreshToken, oidcRefreshToken, "refresh uses the latest rotated token");
        oidcRefreshCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        oidcAccessToken = "browser-refreshed-token";
        oidcRefreshToken = `rotated-browser-refresh-token-${oidcRefreshCount}`;
        const expiresIn = oidcNextRefreshExpiresIn;
        oidcNextRefreshExpiresIn = 3600;
        return {
          access_token: oidcAccessToken,
          refresh_token: oidcRefreshToken,
          expires_in: expiresIn,
          claims: () => oidcIdClaims,
        };
      },
      async tokenIntrospection(token, options) {
        assert.strictEqual(token, "opaque-api-token");
        assert.deepStrictEqual(options, { token_type_hint: "access_token" });
        return {
          active: true,
          sub: "introspected-subject",
          scope: "repo:read repo:write",
        };
      },
      async fetchUserInfo(accessToken, subject) {
        assert.strictEqual(accessToken, oidcAccessToken);
        return { ...oidcUserInfo, sub: subject };
      },
    };
    process.env.OIDC_ISSUER = "https://issuer.example.test";
    process.env.OIDC_CLIENT_ID = "mock-git-store-client";
    process.env.OIDC_BROWSER_SCOPES = "repo:read repo:write";
    app.locals.authApiClientOverride = {
      async getUserInfo(accessToken) {
        assert.strictEqual(accessToken, oidcAccessToken);
        return oidcUserInfo;
      },
    };
    const login = await request(port, "GET", "/ui/auth/login?returnTo=%2F%3Frepo%3Dresume");
    assert.strictEqual(login.status, 302);
    assert.strictEqual(authorizationOptions.scope, "openid profile email offline_access");
    const authorizationUrl = new URL(login.headers.location);
    const loginCookies = login.headers["set-cookie"].map((cookie) => cookie.split(";")[0]).join("; ");
    const callback = await request(
      port,
      "GET",
      `/ui/auth/callback?code=mock-code&state=${encodeURIComponent(authorizationUrl.searchParams.get("state"))}`,
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
    const sessionStorePath = path.join(dataPath, ".browser-sessions");
    const encryptedSessionStore = fs.readFileSync(sessionStorePath, "utf8");
    assert.ok(!encryptedSessionStore.includes("browser-subject"), "persisted session identities are encrypted at rest");
    assert.ok(!encryptedSessionStore.includes("browser-session-token"), "access tokens are never persisted");
    assert.ok(!encryptedSessionStore.includes("browser-refresh-token"), "refresh tokens are encrypted at rest");
    app.locals.reloadBrowserSessions();
    const restoredPage = await request(port, "GET", "/ui/?org=team-one&repo=shared-repo", undefined, undefined, {
      Cookie: sessionCookie,
    });
    assert.strictEqual(restoredPage.status, 200);
    assert.strictEqual(restoredPage.headers["cache-control"], "no-store");
    const sessionBootstrap = restoredPage.body.match(/<script state>([\s\S]*?)<\/script>/);
    assert.ok(sessionBootstrap, "the page embeds the server-validated session before rendering");
    assert.deepStrictEqual(JSON.parse(sessionBootstrap[1]), {
      serverSession: {
        checked: true,
        authenticated: true,
        profile: {
          sub: "browser-subject",
          id: "browser-subject",
          name: "Signed In",
        },
        canRead: true,
        canWrite: true,
      },
    });

    const sessionHeaders = {
      Cookie: sessionCookie,
      Origin: `http://127.0.0.1:${port}`,
    };
    const privateOrg = await request(
      port,
      "POST",
      "/api/v1/orgs",
      { slug: "browser-private-org" },
      undefined,
      sessionHeaders,
    );
    assert.strictEqual(privateOrg.status, 201);
    assert.strictEqual(
      (await request(port, "GET", "/api/v1/personal-access-tokens", undefined, "browser-session-token")).status,
      403,
      "bearer tokens cannot inspect or manage token grants",
    );
    const importedToken = "browser-bound-token";
    tokenSubjects.set(importedToken, {
      active: true,
      sub: "browser-subject",
      scope: "repo:read repo:write org:create",
    });
    const bound = await request(
      port,
      "POST",
      "/api/v1/token-authorizations",
      {
        token: importedToken,
        label: "Browser-bound read token",
        scopes: ["repo:read"],
        orgs: ["browser-org"],
      },
      undefined,
      sessionHeaders,
    );
    assert.strictEqual(bound.status, 201, bound.body);
    const boundId = JSON.parse(bound.body).token.id;
    assert.ok(!bound.body.includes(importedToken));
    assert.deepStrictEqual(
      JSON.parse((await request(port, "GET", "/api/v1/orgs", undefined, importedToken)).body),
      { orgs: [{ slug: "browser-org" }] },
      "a local authorization record does not grant every owned organization",
    );
    assert.strictEqual(
      (
        await request(
          port,
          "PATCH",
          `/api/v1/personal-access-tokens/${boundId}`,
          { label: "Escalated", scopes: ["repo:write"], orgs: ["team-one"] },
          importedToken,
        )
      ).status,
      403,
      "a bearer cannot expand its own scopes or organization grants",
    );
    assert.strictEqual(
      (await request(port, "POST", "/api/v1/orgs", { slug: "introspection-scope-must-not-authorize" }, importedToken))
        .status,
      403,
      "introspection scopes do not authorize GitMini operations",
    );
    assert.strictEqual(
      (
        await request(
          port,
          "POST",
          "/api/v1/token-authorizations",
          {
            token: "foreign-subject-token",
            label: "Wrong subject",
            scopes: ["repo:read"],
            orgs: ["browser-org"],
          },
          undefined,
          sessionHeaders,
        )
      ).status,
      403,
      "cannot bind a different subject's active token",
    );
    const generatedPat = await request(
      port,
      "POST",
      "/api/v1/personal-access-tokens",
      {
        label: "scoped generated",
        scopes: ["repo:read"],
        orgs: ["browser-org"],
      },
      undefined,
      sessionHeaders,
    );
    assert.strictEqual(generatedPat.status, 201, generatedPat.body);
    const generatedPatBody = JSON.parse(generatedPat.body);
    assert.match(generatedPatBody.token, /^gmpat_/);
    assert.ok(
      !fs.readFileSync(path.join(dataPath, "personal-access-tokens.json"), "utf8").includes(generatedPatBody.token),
    );
    assert.strictEqual(
      (await request(port, "GET", "/api/v1/orgs", undefined, generatedPatBody.token)).status,
      200,
      "generated PAT uses its local scope and explicit organization grant",
    );
    for (const repo of ["repo-bound-one", "repo-bound-two"]) {
      const createdRepo = await request(
        port,
        "POST",
        `/api/v1/orgs/browser-org/repos/${repo}`,
        undefined,
        undefined,
        sessionHeaders,
      );
      assert.strictEqual(createdRepo.status, 201, createdRepo.body);
    }
    const repositoryBoundPat = await request(
      port,
      "POST",
      "/api/v1/personal-access-tokens",
      {
        label: "single repository",
        scopes: ["repo:read"],
        orgs: ["browser-org"],
        org: "browser-org",
        repo: "repo-bound-one",
      },
      undefined,
      sessionHeaders,
    );
    assert.strictEqual(repositoryBoundPat.status, 201, repositoryBoundPat.body);
    const repositoryBoundSecret = JSON.parse(repositoryBoundPat.body).token;
    assert.strictEqual(
      (
        await request(
          port,
          "GET",
          "/api/v1/orgs/browser-org/repos/repo-bound-one/tree",
          undefined,
          repositoryBoundSecret,
        )
      ).status,
      200,
    );
    assert.strictEqual(
      (
        await request(
          port,
          "GET",
          "/api/v1/orgs/browser-org/repos/repo-bound-two/tree",
          undefined,
          repositoryBoundSecret,
        )
      ).status,
      403,
      "repository-scoped PAT is denied other repositories in its granted org",
    );
    assert.strictEqual(
      (
        await request(
          port,
          "DELETE",
          `/api/v1/personal-access-tokens/${generatedPatBody.record.id}`,
          undefined,
          undefined,
          sessionHeaders,
        )
      ).status,
      204,
    );
    assert.strictEqual(
      (await request(port, "GET", "/api/v1/orgs", undefined, generatedPatBody.token)).status,
      401,
      "revoked generated PAT is denied",
    );
    const orgCreator = "browser-org-creator-token";
    tokenSubjects.set(orgCreator, {
      active: true,
      sub: "browser-subject",
      scope: "repo:read repo:write org:create",
    });
    const orgCreatorBind = await request(
      port,
      "POST",
      "/api/v1/token-authorizations",
      {
        token: orgCreator,
        label: "Scoped org creator",
        scopes: ["org:create", "repo:read"],
        orgs: ["browser-org"],
      },
      undefined,
      sessionHeaders,
    );
    assert.strictEqual(orgCreatorBind.status, 201, orgCreatorBind.body);
    const upstreamExpired = { ...tokenSubjects.get(orgCreator), active: false };
    tokenSubjects.set(orgCreator, upstreamExpired);
    assert.strictEqual(
      (await request(port, "GET", "/api/v1/orgs", undefined, orgCreator)).status,
      401,
      "local grants do not keep an inactive upstream token alive",
    );
    tokenSubjects.set(orgCreator, { ...upstreamExpired, active: true });
    const createdOnlyByToken = await request(
      port,
      "POST",
      "/api/v1/orgs",
      { slug: "created-by-limited-token" },
      orgCreator,
    );
    assert.strictEqual(createdOnlyByToken.status, 201);
    assert.deepStrictEqual(
      JSON.parse((await request(port, "GET", "/api/v1/orgs", undefined, orgCreator)).body),
      {
        orgs: [{ slug: "browser-org" }, { slug: "created-by-limited-token" }],
      },
      "org:create grants the creator access only to the newly created org",
    );
    assert.deepStrictEqual(JSON.parse((await request(port, "GET", "/api/v1/orgs", undefined, "token-a")).body), {
      orgs: [{ slug: "team-extra" }, { slug: "team-one" }],
    });
    assert.strictEqual(
      (await request(port, "DELETE", `/api/v1/personal-access-tokens/${boundId}`, undefined, undefined, sessionHeaders))
        .status,
      204,
    );
    assert.strictEqual(
      (await request(port, "GET", "/api/v1/orgs", undefined, importedToken)).status,
      403,
      "revoking an external binding immediately denies the token",
    );

    oidcAccessToken = "short-lived-browser-token";
    oidcRefreshToken = "short-lived-browser-refresh-token";
    oidcExpiresIn = 0.001;
    oidcNextRefreshExpiresIn = 60;
    const refreshLogin = await request(port, "GET", "/ui/auth/login");
    const refreshAuthorization = new URL(refreshLogin.headers.location);
    const refreshLoginCookies = refreshLogin.headers["set-cookie"].map((cookie) => cookie.split(";")[0]).join("; ");
    const refreshCallback = await request(
      port,
      "GET",
      `/ui/auth/callback?code=mock-code&state=${encodeURIComponent(refreshAuthorization.searchParams.get("state"))}`,
      undefined,
      undefined,
      { Cookie: refreshLoginCookies },
    );
    assert.strictEqual(refreshCallback.status, 303);
    const refreshSessionCookie = refreshCallback.headers["set-cookie"]
      .find((cookie) => cookie.startsWith("git_store_session="))
      .split(";")[0];
    assert.ok(
      refreshCallback.headers["set-cookie"].some((cookie) => cookie.includes("Max-Age=2592000")),
      "sessions with a refresh token receive a renewable 30-day cookie",
    );
    const refreshedResponses = await Promise.all(
      [1, 2].map(() =>
        request(port, "GET", "/ui/session", undefined, undefined, {
          Cookie: refreshSessionCookie,
          Origin: `http://127.0.0.1:${port}`,
        }),
      ),
    );
    for (const response of refreshedResponses) {
      assert.strictEqual(response.status, 200);
      assert.strictEqual(JSON.parse(response.body).authenticated, true);
      assert.ok(
        response.headers["set-cookie"]?.some((cookie) => cookie.startsWith("git_store_session=")),
        "a successful refresh renews the browser cookie",
      );
    }
    assert.strictEqual(oidcRefreshCount, 1, "parallel requests share a single refresh-token exchange");
    const rotatedStore = fs.readFileSync(sessionStorePath, "utf8");
    assert.ok(!rotatedStore.includes("short-lived-browser-refresh-token"));
    assert.ok(!rotatedStore.includes("rotated-browser-refresh-token-1"));
    app.locals.reloadBrowserSessions();
    const restoredRefreshSession = await request(port, "GET", "/ui/session", undefined, undefined, {
      Cookie: refreshSessionCookie,
      Origin: `http://127.0.0.1:${port}`,
    });
    assert.strictEqual(JSON.parse(restoredRefreshSession.body).authenticated, true);
    assert.strictEqual(oidcRefreshCount, 2, "the rotated refresh token survives encrypted-store restoration");

    const cancelledLogin = await request(port, "GET", "/ui/auth/login");
    const cancelledAuthorization = new URL(cancelledLogin.headers.location);
    const cancelledCookies = cancelledLogin.headers["set-cookie"].map((cookie) => cookie.split(";")[0]).join("; ");
    const cancelledCallback = await request(
      port,
      "GET",
      `/ui/auth/callback?error=invalid_scope&state=${encodeURIComponent(cancelledAuthorization.searchParams.get("state"))}`,
      undefined,
      undefined,
      { Cookie: cancelledCookies },
    );
    assert.strictEqual(cancelledCallback.status, 401);
    assert.ok(cancelledCallback.body.includes("could not be completed"));
    oidcUserInfo = { id: "browser-subject", name: "Signed In" };
    const missingUsernameLogin = await request(port, "GET", "/ui/auth/login");
    const missingUsernameAuthorization = new URL(missingUsernameLogin.headers.location);
    const missingUsernameCookies = missingUsernameLogin.headers["set-cookie"]
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
    const missingUsernameCallback = await request(
      port,
      "GET",
      `/ui/auth/callback?code=mock-code&state=${encodeURIComponent(missingUsernameAuthorization.searchParams.get("state"))}`,
      undefined,
      undefined,
      { Cookie: missingUsernameCookies },
    );
    assert.strictEqual(missingUsernameCallback.status, 303, "sign-in does not require an OIDC username");
    assert.ok(
      missingUsernameCallback.headers["set-cookie"]?.some((cookie) => cookie.startsWith("git_store_session=")),
      "accounts without a provider username receive a normal application session",
    );
    const usernameFreeSessionCookie = missingUsernameCallback.headers["set-cookie"]
      .find((cookie) => cookie.startsWith("git_store_session="))
      .split(";")[0];
    const usernameFreeOrg = await request(port, "POST", "/api/v1/orgs", { slug: "username-free-org" }, undefined, {
      Cookie: usernameFreeSessionCookie,
      Origin: `http://127.0.0.1:${port}`,
    });
    assert.strictEqual(usernameFreeOrg.status, 201, "a username-free OIDC subject can create an organization");
    const usernameFreeRepo = await request(
      port,
      "POST",
      "/api/v1/orgs/username-free-org/repos/project",
      undefined,
      undefined,
      { Cookie: usernameFreeSessionCookie, Origin: `http://127.0.0.1:${port}` },
    );
    assert.strictEqual(usernameFreeRepo.status, 201, "organization/repository creation does not depend on username");
    const usernameFreeRepoBranch = await git([
      "-C",
      path.join(dataPath, "orgs", "username-free-org", "project"),
      "symbolic-ref",
      "--short",
      "HEAD",
    ]);
    assert.strictEqual(
      usernameFreeRepoBranch.stdout.trim(),
      "main",
      "new repositories use main as their initial branch",
    );
    oidcUserInfo = {
      id: "browser-subject",
      name: "Signed In",
      preferred_username: "browser-user",
    };
    oidcIdClaims = {
      sub: "browser-subject",
      preferred_username: "different-username",
    };
    const inconsistentUsernameLogin = await request(port, "GET", "/ui/auth/login");
    const inconsistentUsernameAuthorization = new URL(inconsistentUsernameLogin.headers.location);
    const inconsistentUsernameCookies = inconsistentUsernameLogin.headers["set-cookie"]
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
    const inconsistentUsernameCallback = await request(
      port,
      "GET",
      `/ui/auth/callback?code=mock-code&state=${encodeURIComponent(inconsistentUsernameAuthorization.searchParams.get("state"))}`,
      undefined,
      undefined,
      { Cookie: inconsistentUsernameCookies },
    );
    assert.strictEqual(inconsistentUsernameCallback.status, 303, "OIDC usernames do not determine repository identity");
    oidcUserInfo = {
      id: "browser-subject",
      name: "Signed In",
      preferred_username: "changed-provider-user",
    };
    oidcIdClaims = {
      sub: "browser-subject",
      preferred_username: "changed-provider-user",
    };
    const changedUsernameLogin = await request(port, "GET", "/ui/auth/login");
    const changedUsernameAuthorization = new URL(changedUsernameLogin.headers.location);
    const changedUsernameCookies = changedUsernameLogin.headers["set-cookie"]
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
    const changedUsernameCallback = await request(
      port,
      "GET",
      `/ui/auth/callback?code=mock-code&state=${encodeURIComponent(changedUsernameAuthorization.searchParams.get("state"))}`,
      undefined,
      undefined,
      { Cookie: changedUsernameCookies },
    );
    assert.strictEqual(changedUsernameCallback.status, 303, "provider username changes do not block sign-in");

    oidcUserInfo = { id: "id-only-subject", name: "Signed In" };
    oidcIdClaims = {
      sub: "id-only-subject",
      preferred_username: "id-only-user",
    };
    const idTokenUsernameLogin = await request(port, "GET", "/ui/auth/login");
    const idTokenUsernameAuthorization = new URL(idTokenUsernameLogin.headers.location);
    const idTokenUsernameCookies = idTokenUsernameLogin.headers["set-cookie"]
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
    const idTokenUsernameCallback = await request(
      port,
      "GET",
      `/ui/auth/callback?code=mock-code&state=${encodeURIComponent(idTokenUsernameAuthorization.searchParams.get("state"))}`,
      undefined,
      undefined,
      { Cookie: idTokenUsernameCookies },
    );
    assert.strictEqual(
      idTokenUsernameCallback.status,
      303,
      "sign-in succeeds using the subject without username coupling",
    );

    oidcUserInfo = {
      id: "browser-subject",
      name: "Signed In",
      preferred_username: "browser-user",
    };
    oidcIdClaims = { sub: "browser-subject" };
    process.env.OIDC_REDIRECT_URI = `http://127.0.0.1:${port}/auth/callback`;
    expectedCallbackPath = "/auth/callback";
    const legacyLogin = await request(port, "GET", "/ui/auth/login");
    assert.strictEqual(legacyLogin.status, 302);
    const legacyAuthorization = new URL(legacyLogin.headers.location);
    const legacyCookies = legacyLogin.headers["set-cookie"].map((cookie) => cookie.split(";")[0]).join("; ");
    const legacyCallback = await request(
      port,
      "GET",
      `/auth/callback?code=mock-code&state=${encodeURIComponent(legacyAuthorization.searchParams.get("state"))}`,
      undefined,
      undefined,
      { Cookie: legacyCookies },
    );
    assert.strictEqual(legacyCallback.status, 303, "registered legacy OIDC callbacks remain functional");
    process.env.OIDC_REDIRECT_URI = "";
    expectedCallbackPath = "/ui/auth/callback";
    const sessionCreatedRepo = await request(port, "POST", "/api/v1/repos/session-repo", undefined, undefined, {
      Cookie: sessionCookie,
      Origin: `http://127.0.0.1:${port}`,
    });
    assert.strictEqual(sessionCreatedRepo.status, 201, "OIDC browser sessions with repo:write can create repositories");
    const browserProfile = await request(port, "GET", "/ui/session", undefined, undefined, {
      Cookie: sessionCookie,
      Origin: `http://127.0.0.1:${port}`,
    });
    assert.deepStrictEqual(JSON.parse(browserProfile.body), {
      authenticated: true,
      profile: {
        id: "browser-subject",
        sub: "browser-subject",
        name: "Signed In",
      },
      canRead: true,
      canWrite: true,
    });
    process.env.OIDC_BROWSER_SCOPES = "repo:read";
    const readOnlyLogin = await request(port, "GET", "/ui/auth/login");
    const readOnlyAuthorization = new URL(readOnlyLogin.headers.location);
    const readOnlyCookies = readOnlyLogin.headers["set-cookie"].map((cookie) => cookie.split(";")[0]).join("; ");
    const readOnlyCallback = await request(
      port,
      "GET",
      `/ui/auth/callback?code=mock-code&state=${encodeURIComponent(readOnlyAuthorization.searchParams.get("state"))}`,
      undefined,
      undefined,
      { Cookie: readOnlyCookies },
    );
    assert.strictEqual(readOnlyCallback.status, 303);
    const readOnlySessionCookie = readOnlyCallback.headers["set-cookie"]
      .map((cookie) => cookie.split(";")[0])
      .find((cookie) => cookie.startsWith("git_store_session="));
    const readOnlyBrowserSession = await request(port, "GET", "/ui/session", undefined, undefined, {
      Cookie: readOnlySessionCookie,
      Origin: `http://127.0.0.1:${port}`,
    });
    assert.strictEqual(JSON.parse(readOnlyBrowserSession.body).canWrite, false);
    process.env.OIDC_BROWSER_SCOPES = "repo:read repo:write";
    const tokenVerifier = app.locals.verifyToken;
    process.env.OIDC_CLIENT_ID = "mock-git-store-client";
    app.locals.verifyToken = null;
    app.locals.authApiClientOverride = null;
    const introspectedList = await request(port, "GET", "/api/v1/repos", undefined, "opaque-api-token");
    assert.strictEqual(introspectedList.status, 403, "active opaque token without local grants is denied");
    const introspectedWrite = await request(
      port,
      "POST",
      "/api/v1/repos/not-created/tags",
      { name: "v1" },
      "opaque-api-token",
    );
    assert.strictEqual(introspectedWrite.status, 403, "introspection scope does not grant repo:write");
    app.locals.verifyToken = tokenVerifier;
    process.env.OIDC_CLIENT_ID = "";
    const logout = await request(port, "POST", "/ui/auth/logout", undefined, undefined, {
      Cookie: sessionCookie,
      Origin: `http://127.0.0.1:${port}`,
    });
    assert.strictEqual(logout.status, 303);
    const loggedOutList = await request(port, "GET", "/api/v1/repos", undefined, undefined, { Cookie: sessionCookie });
    assert.strictEqual(loggedOutList.status, 401, "logout invalidates the browser session");
    process.env.OIDC_ISSUER = "";
    process.env.OIDC_CLIENT_ID = "";
    process.env.OIDC_BROWSER_SCOPES = "";
    app.locals.oidcClientOverride = null;
    app.locals.authApiClientOverride = null;

    app.locals.oidcClientOverride = {};
    const unauthenticatedUi = await request(port, "GET", "/ui/?org=team-one&repo=shared-repo");
    assert.strictEqual(
      unauthenticatedUi.status,
      302,
      "unauthenticated browser requests redirect before serving the UI",
    );
    assert.strictEqual(
      unauthenticatedUi.headers.location,
      "/ui/auth/login?returnTo=%2Fui%2F%3Forg%3Dteam-one%26repo%3Dshared-repo",
    );
    app.locals.oidcClientOverride = null;

    const uiResponse = await request(port, "GET", "/ui/");
    assert.strictEqual(uiResponse.status, 200);
    assert.strictEqual((uiResponse.body.match(/<template app>/g) || []).length, 1);
    assert.strictEqual((uiResponse.body.match(/<script setup>/g) || []).length, 1);
    for (const componentPath of [
      "/ui/components/commit-hash.html",
      "/ui/components/file-preview.html",
      "/ui/components/organization-landing.html",
      "/ui/components/organization-settings.html",
      "/ui/components/sign-in-landing.html",
    ]) {
      assert.strictEqual((await request(port, "GET", componentPath)).status, 200, `${componentPath} is served`);
    }
    const repoPanelResponse = await request(port, "GET", "/ui/components/repo-panel.html");
    assert.strictEqual(repoPanelResponse.status, 200);
    const welcomeResponse = await request(port, "GET", "/ui/welcome.svg");
    assert.strictEqual(welcomeResponse.status, 200);
    assert.ok(welcomeResponse.body.includes("Build your workspace"));
    assert.strictEqual((await request(port, "GET", "/welcome.svg")).status, 404);
    assert.ok(/{{\s*repo\.repo\s*}}/.test(uiResponse.body));
    assert.ok(uiResponse.body.includes("repo=${encodeURIComponent(item.repo)}"));
    assert.ok(!uiResponse.body.includes("{{ repo.owner }}"));
    assert.ok(uiResponse.body.includes("fixed inset-x-0 bottom-0 top-[72px] z-30 bg-black/40 md:hidden"));
    assert.ok(uiResponse.body.includes('on-click="closeMenu()"'));
    assert.ok(uiResponse.body.includes('popover="auto"'));
    assert.ok(uiResponse.body.includes('popovertargetaction="hide"'));
    assert.ok(uiResponse.body.includes('type="file"'));
    assert.ok(uiResponse.body.includes('on-change="handleFileSelect($event.target.files)"'));
    assert.ok(uiResponse.body.includes('on-drop.prevent="upload($event)"'));
    assert.ok(uiResponse.body.includes('<style type="text/tailwindcss">'));
    assert.ok(uiResponse.body.includes("@custom-variant dark (&:where(.dark, .dark *));"));
    assert.ok(uiResponse.body.includes("<span>Sign in</span>"));
    assert.ok(uiResponse.body.includes("authStatus === 'anonymous'"));
    assert.ok(!uiResponse.body.includes("Checking sign-in status"));
    assert.ok(uiResponse.body.includes('<template if="showWorkspace && orgRepositories.length > 0 && !settings">'));
    assert.ok(uiResponse.body.includes("organization-landing"));
    assert.ok(uiResponse.body.includes("organization-settings"));
    assert.ok(uiResponse.body.includes("sign-in-landing"));
    assert.ok(uiResponse.body.includes("Welcome to your Git server"));
    assert.ok(!/{{\s*repo\.repo\s*}}\s*<\/h1>/.test(uiResponse.body));
    assert.ok(uiResponse.body.includes("await refreshOrganizations()"));
    assert.ok(uiResponse.body.includes('data-testid="workspace-breadcrumbs"'));
    assert.strictEqual((uiResponse.body.match(/fetch\("\/ui\/session"/g) || []).length, 1);
    assert.ok(!uiResponse.body.includes("access_token"), "UI auth must not depend on locally stored access tokens");
    assert.ok(
      !repoPanelResponse.body.includes("access_token"),
      "branch and tag actions must use the browser session instead of locally stored access tokens",
    );
    assert.ok(
      uiResponse.body.includes("document.documentElement.classList.toggle(") &&
        uiResponse.body.includes("darkMode.value"),
    );
    assert.ok(uiResponse.body.includes('themeMedia.addEventListener("change"'));
    assert.ok(!uiResponse.body.includes('localStorage.getItem("theme")'));
    assert.ok(
      uiResponse.body.includes('<template if="dragging"'),
      "drag/drop helper should only appear while dragging",
    );
    assert.strictEqual(
      (uiResponse.body.match(/document\.getElementById\(/g) || []).length,
      2,
      "direct DOM lookups are limited to native popover controls",
    );
    assert.ok(uiResponse.body.includes("No branches."));
    assert.ok(uiResponse.body.includes("No tags."));
    assert.ok(uiResponse.body.includes('window.matchMedia("(prefers-color-scheme: dark)")'));
    assert.ok(
      uiResponse.body.includes("profile.value?.name") &&
        uiResponse.body.includes('profile.value?.email?.split("@")[0]'),
      "the signed-in user card uses available name/email fields",
    );
    const rootSetupStart = uiResponse.body.indexOf("<script setup>");
    const rootSetupEnd = uiResponse.body.indexOf("</script>", rootSetupStart);
    const rootSetup = uiResponse.body.slice(rootSetupStart, rootSetupEnd);
    assert.ok(rootSetup.includes('searchParams.get("org")'), "the shared app state initializes organization from URL");
    assert.ok(rootSetup.includes("const setAddFilePath"), "the shared app owns the add-file handler");
    assert.ok(rootSetup.includes("setAddFilePath,"), "the shared app exposes the add-file handler");
    const sidebarComponent = fs.readFileSync(path.join(__dirname, "../public/components/repo-sidebar.html"), "utf8");
    const repoPanelComponent = fs.readFileSync(path.join(__dirname, "../public/components/repo-panel.html"), "utf8");
    const repoViewerComponent = fs.readFileSync(path.join(__dirname, "../public/components/repo-viewer.html"), "utf8");
    assert.ok(!sidebarComponent.includes("item.owner"));
    assert.ok(sidebarComponent.includes('popover="auto"'));
    assert.ok(sidebarComponent.includes("dark:text-gray-100"));
    assert.ok(!sidebarComponent.includes("dialogOpen"));
    assert.ok(!repoPanelComponent.includes("owner="));
    assert.ok(repoPanelComponent.includes("No branches."));
    assert.ok(repoPanelComponent.includes("No tags."));
    assert.ok(repoPanelComponent.includes("dark:text-gray-100"));
    assert.ok(!repoViewerComponent.includes("No commits yet"));
    assert.ok(repoViewerComponent.includes('id="repo-file-input"'));

    const health = await request(port, "GET", "/api/v1/health");
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
