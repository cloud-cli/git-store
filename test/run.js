const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "git-store-test-"));
process.env.DATA_PATH = dataPath;
process.env.OIDC_ISSUER = "";
process.env.OIDC_CLIENT_ID = "";
process.env.OIDC_CLIENT_SECRET = "test-client-secret";

const app = require("../index");
require("../organizations").create("introspected-subject", "introspected-org");
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
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        responseBody += chunk;
      });
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: responseBody,
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
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;

  try {
    assert.strictEqual((await request(port, "GET", "/api/v1/orgs", undefined, "unscoped")).status, 403);
    assert.strictEqual((await request(port, "POST", "/api/v1/orgs", { slug: "blocked" }, "unscoped")).status, 403);
    assert.strictEqual((await request(port, "POST", "/api/v1/orgs", { slug: "bad slug" }, "token-a")).status, 400);
    const orgCreated = await request(port, "POST", "/api/v1/orgs", { slug: "Team-One" }, "token-a");
    assert.strictEqual(orgCreated.status, 201);
    assert.deepStrictEqual(JSON.parse(orgCreated.body), { org: { slug: "team-one" } });
    assert.strictEqual((await request(port, "POST", "/api/v1/orgs", { slug: "team-one" }, "token-b")).status, 409);
    for (const [token, slug] of [
      ["token-a", "team-extra"],
      ["token-b", "team-two"],
      ["read-only", "reader-org"],
      ["unscoped", "unscoped-org"],
      ["browser-session-token", "browser-org"],
    ]) {
      const oldClaims = tokenSubjects.get(token);
      tokenSubjects.set(token, { ...oldClaims, scope: "repo:write" });
      const created = await request(port, "POST", "/api/v1/orgs", { slug }, token);
      assert.strictEqual(created.status, 201);
      tokenSubjects.set(token, oldClaims);
    }
    assert.deepStrictEqual(JSON.parse((await request(port, "GET", "/api/v1/orgs", undefined, "token-a")).body), {
      orgs: [{ slug: "team-one" }, { slug: "team-extra" }],
    });
    assert.deepStrictEqual(JSON.parse((await request(port, "GET", "/api/v1/orgs", undefined, "token-b")).body), {
      orgs: [{ slug: "team-two" }],
    });
    const organizationRegistry = fs.readFileSync(path.join(dataPath, "organizations.json"), "utf8");
    assert.ok(!organizationRegistry.includes("oidc-subject-a"), "organization registry must not persist raw subjects");
    const organizationsModulePath = require.resolve("../organizations");
    delete require.cache[organizationsModulePath];
    assert.deepStrictEqual(require("../organizations").listForSubject("oidc-subject-a"), [
      { slug: "team-one" },
      { slug: "team-extra" },
    ]);
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
      `http.extraheader=${orgAuthHeader}`,
      "-C",
      orgClonePath,
      "push",
      "origin",
      "HEAD:refs/heads/from-org-http",
    ]);
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
      { Authorization: `Basic ${Buffer.from("user:token-b").toString("base64")}` },
    );
    assert.strictEqual(foreignOrgGit.status, 404, "organization Git transport is limited to its owning subject");
    const canonicalizedOrgGit = await request(
      port,
      "GET",
      "/git/TEAM-ONE/inside.git/info/refs?service=git-upload-pack",
      undefined,
      undefined,
      { Authorization: `Basic ${Buffer.from("user:token-a").toString("base64")}` },
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
    await git(["-C", gitRepoPath, "config", "receive.denyCurrentBranch", "updateInstead"]);
    fs.writeFileSync(path.join(gitRepoPath, "initial.txt"), "initial\n");
    await git(["-C", gitRepoPath, "add", "initial.txt"]);
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
    ]);
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
    assert.deepStrictEqual(JSON.parse(listB.body), { repos: [{ repo: "shared-repo" }] });

    const readOnlyList = await request(port, "GET", "/api/v1/repos", undefined, "read-only");
    assert.strictEqual(readOnlyList.status, 200, "repo:read permits repository listing");
    const readOnlyRepo = path.join(dataPath, "orgs", "reader-org", "read-only-repo");
    fs.mkdirSync(readOnlyRepo, { recursive: true });
    await require("simple-git").simpleGit(readOnlyRepo).init();
    fs.writeFileSync(path.join(readOnlyRepo, "readme.txt"), "read only");
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
    assert.strictEqual(fileB.status, 404, "another subject must not read repository files");

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
    const history = await request(
      port,
      "GET",
      "/api/v1/repos/shared-repo/history?path=private.txt",
      undefined,
      "token-a",
    );
    assert.strictEqual(JSON.parse(history.body).length, 1);

    const addTag = await request(port, "POST", "/api/v1/repos/shared-repo/tags", { name: "v1" }, "token-a");
    assert.strictEqual(addTag.status, 200);
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
          { Authorization: `Basic ${Buffer.from("user:token-a").toString("base64")}` },
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
      "/api/v1/orgs/{org}/repos": ["get"],
      "/api/v1/orgs/{org}/repos/{repo}": ["post"],
      "/api/v1/orgs/{org}/repos/{repo}/log": ["get"],
      "/api/v1/orgs/{org}/repos/{repo}/tree": ["get"],
      "/api/v1/orgs/{org}/repos/{repo}/file": ["get"],
      "/api/v1/orgs/{org}/repos/{repo}/history": ["get"],
      "/api/v1/orgs/{org}/repos/{repo}/branches": ["get", "post"],
      "/api/v1/orgs/{org}/repos/{repo}/tags": ["get", "post"],
      "/api/v1/orgs/{org}/repos/{repo}/files": ["post"],
      "/api/v1/orgs/{org}/repos/{repo}/stage": ["post"],
      "/api/v1/orgs/{org}/repos/{repo}/unstage": ["post"],
      "/api/v1/orgs/{org}/repos/{repo}/commit": ["post"],
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
      "/api/v1/repos/{repo}/files": ["post"],
      "/api/v1/repos/{repo}/stage": ["post"],
      "/api/v1/repos/{repo}/unstage": ["post"],
      "/api/v1/repos/{repo}/commit": ["post"],
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
      Object.keys(spec.paths).every(
        (specPath) => specPath === "/api" || specPath.startsWith("/api/v1/") || specPath.startsWith("/git/"),
      ),
    );
    for (const [specPath, methods] of Object.entries(expectedMethods)) {
      assert.deepStrictEqual(Object.keys(spec.paths[specPath]).sort(), methods.sort(), `methods for ${specPath}`);
      if (specPath.startsWith("/api/v1/orgs/{org}/repos")) {
        for (const method of methods) {
          assert.ok(spec.paths[specPath][method].security, `${method} ${specPath} must be authenticated`);
        }
      }
    }
    assert.strictEqual(spec.paths["/api/v1/orgs"]["get"]["x-required-scope"], "repo:read or repo:write");
    assert.strictEqual(spec.paths["/api/v1/orgs/{org}/repos/{repo}"].post["x-required-scope"], "repo:write");
    assert.strictEqual(spec.paths["/api/v1/orgs/{org}/repos/{repo}/tags"].post["x-required-scope"], "repo:write");
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
        assert.ok(redirectUri.endsWith(expectedCallbackPath));
        return {
          access_token: "browser-session-token",
          expires_in: 3600,
          claims: () => oidcIdClaims,
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
      return {
        ok: true,
        json: async () => oidcUserInfo,
      };
    };
    const login = await request(port, "GET", "/ui/auth/login?returnTo=%2F%3Frepo%3Dresume");
    assert.strictEqual(login.status, 302);
    assert.strictEqual(authorizationOptions.scope, "openid profile email");
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
    oidcUserInfo = { id: "browser-subject", name: "Signed In", preferred_username: "browser-user" };
    oidcIdClaims = { sub: "browser-subject", preferred_username: "different-username" };
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
    oidcUserInfo = { id: "browser-subject", name: "Signed In", preferred_username: "changed-provider-user" };
    oidcIdClaims = { sub: "browser-subject", preferred_username: "changed-provider-user" };
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
    oidcIdClaims = { sub: "id-only-subject", preferred_username: "id-only-user" };
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

    oidcUserInfo = { id: "browser-subject", name: "Signed In", preferred_username: "browser-user" };
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
        json: async () => ({
          active: true,
          sub: "introspected-subject",
          scope: "repo:read repo:write",
        }),
      };
    };
    const introspectedList = await request(port, "GET", "/api/v1/repos", undefined, "opaque-api-token");
    assert.strictEqual(introspectedList.status, 200, "opaque repo:read/write API token should introspect successfully");
    const introspectedWrite = await request(
      port,
      "POST",
      "/api/v1/repos/not-created/tags",
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
    const logout = await request(port, "POST", "/ui/auth/logout", undefined, undefined, {
      Cookie: sessionCookie,
      Origin: `http://127.0.0.1:${port}`,
    });
    assert.strictEqual(logout.status, 303);
    const loggedOutList = await request(port, "GET", "/api/v1/repos", undefined, undefined, { Cookie: sessionCookie });
    assert.strictEqual(loggedOutList.status, 401, "logout invalidates the browser session");
    global.fetch = nativeFetch;
    process.env.OIDC_ISSUER = "";
    process.env.OIDC_CLIENT_ID = "";
    process.env.OIDC_BROWSER_SCOPES = "";
    app.locals.oidcClientOverride = null;

    const uiResponse = await request(port, "GET", "/ui/");
    assert.strictEqual(uiResponse.status, 200);
    const repoPanelResponse = await request(port, "GET", "/ui/components/repo-panel.html");
    assert.strictEqual(repoPanelResponse.status, 200);
    const welcomeResponse = await request(port, "GET", "/ui/welcome.svg");
    assert.strictEqual(welcomeResponse.status, 200);
    assert.ok(welcomeResponse.body.includes("Build your workspace"));
    assert.strictEqual((await request(port, "GET", "/welcome.svg")).status, 404);
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
    assert.ok(uiResponse.body.includes('<style type="text/tailwindcss">'));
    assert.ok(uiResponse.body.includes("@custom-variant dark (&:where(.dark, .dark *));"));
    assert.ok(uiResponse.body.includes("<span>Sign in</span>"));
    assert.ok(uiResponse.body.includes("Sign in to get started"));
    assert.ok(uiResponse.body.includes("authStatus === 'anonymous'"));
    assert.ok(uiResponse.body.includes('<template if="showWorkspace">'));
    assert.ok(uiResponse.body.includes("Create an organization"));
    assert.ok(uiResponse.body.includes("Step 2 of 2"));
    assert.ok(uiResponse.body.includes("window.location.assign(`/ui/?org=${encodeURIComponent(result.org.slug)}`)"));
    assert.ok(uiResponse.body.includes('searchParams.has("org")'));
    assert.ok(uiResponse.body.includes('<template if="authenticated">'));
    assert.ok(uiResponse.body.includes('fetch("/ui/session", { credentials: "same-origin" })'));
    assert.ok(!uiResponse.body.includes("access_token"), "UI auth must not depend on locally stored access tokens");
    assert.ok(
      !repoPanelResponse.body.includes("access_token"),
      "branch and tag actions must use the browser session instead of locally stored access tokens",
    );
    assert.ok(uiResponse.body.includes('document.documentElement.classList.toggle("dark", darkMode.value)'));
    assert.ok(uiResponse.body.includes('themeMedia.addEventListener("change"'));
    assert.ok(!uiResponse.body.includes('localStorage.getItem("theme")'));
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
    assert.strictEqual(
      (uiResponse.body.match(/window\.matchMedia\("\(prefers-color-scheme: dark\)"\)/g) || []).length,
      2,
      "the page should initialize its theme from the system preference",
    );
    assert.ok(
      uiResponse.body.includes('profile.value?.alias || "Signed in"'),
      "legacy aliases are optional and not required for the signed-in UI",
    );
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
