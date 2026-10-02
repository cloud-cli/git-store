const express = require("express");
const simpleGit = require("simple-git");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getRepoPath, ensureRepoDir, validateRepoName, getHashedSubjectDir } = require("./storage");

const getGit = (repoPath) => simpleGit.simpleGit(repoPath);

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));
const PORT = process.env.PORT || 3000;

// OpenID Discovery and Authentication Setup
let oidcClient;
let oidcReady = false;
const browserSessions = new Map();
const sessionCookieName = "git_store_session";

// Tests may install an in-process token verifier on app.locals before serving.
// This is not an HTTP feature: production requests always use OIDC validation.

async function initializeOidc() {
  if (!process.env.OIDC_ISSUER || !process.env.OIDC_CLIENT_ID || !process.env.OIDC_CLIENT_SECRET) {
    return;
  }
  try {
    const { Issuer } = require("openid-client");
    const issuer = await Issuer.discover(process.env.OIDC_ISSUER);
    if (process.env.OIDC_JWKS_URI) {
      const issuerOrigin = new URL(process.env.OIDC_ISSUER).origin;
      const jwksUrl = new URL(process.env.OIDC_JWKS_URI);
      if (jwksUrl.origin !== issuerOrigin) {
        throw new Error("OIDC JWKS endpoint must share the issuer origin");
      }
      issuer.metadata.jwks_uri = jwksUrl.toString();
    }
    oidcClient = new issuer.Client({
      client_id: process.env.OIDC_CLIENT_ID,
      client_secret: process.env.OIDC_CLIENT_SECRET,
      token_endpoint_auth_method: "client_secret_post",
    });
    oidcReady = true;
  } catch {
    oidcReady = false;
  }
}
initializeOidc();

function getOidcClient() {
  return app.locals.oidcClientOverride || (oidcReady ? oidcClient : null);
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header.split(";").map((part) => {
      const separator = part.indexOf("=");
      if (separator < 0) {
        return [part.trim(), ""];
      }
      return [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
    }),
  );
}

function signSessionId(id) {
  return crypto.createHmac("sha256", process.env.OIDC_CLIENT_SECRET).update(id).digest("base64url");
}

function getBrowserSession(req) {
  if (!process.env.OIDC_CLIENT_SECRET) {
    return null;
  }
  const cookieValue = parseCookies(req.headers.cookie)[sessionCookieName];
  if (!cookieValue) {
    return null;
  }
  const separator = cookieValue.lastIndexOf(".");
  if (separator < 1) {
    return null;
  }
  const id = cookieValue.slice(0, separator);
  const signature = cookieValue.slice(separator + 1);
  const expected = signSessionId(id);
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
    return null;
  }
  const session = browserSessions.get(id);
  if (!session || session.expiresAt <= Date.now()) {
    browserSessions.delete(id);
    return null;
  }
  return { id, ...session };
}

async function introspectAccessToken(token) {
  if (app.locals.verifyToken) {
    return app.locals.verifyToken(token);
  }
  if (!process.env.OIDC_ISSUER || !process.env.OIDC_CLIENT_ID || !process.env.OIDC_CLIENT_SECRET) {
    return null;
  }
  const credentials = Buffer.from(`${process.env.OIDC_CLIENT_ID}:${process.env.OIDC_CLIENT_SECRET}`).toString("base64");
  const response = await fetch(new URL("/oauth/introspect", process.env.OIDC_ISSUER), {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token, token_type_hint: "access_token" }),
  });
  if (!response.ok) {
    throw new Error(`OIDC token introspection failed: ${response.status}`);
  }
  return response.json();
}

function isSameOriginRequest(req) {
  const origin = req.get("origin");
  if (origin) {
    try {
      return new URL(origin).host.toLowerCase() === req.get("host").toLowerCase();
    } catch {
      return false;
    }
  }
  return req.get("sec-fetch-site") === "same-origin";
}

function getOidcRedirectUri(req) {
  if (process.env.OIDC_REDIRECT_URI) {
    return new URL(process.env.OIDC_REDIRECT_URI).toString();
  }
  const baseUrl = process.env.PUBLIC_URL;
  if (baseUrl) {
    return new URL("/auth/callback", baseUrl).toString();
  }
  const protocol = (req.get("x-forwarded-proto") || req.protocol || "http").split(",")[0].trim();
  const host = (req.get("x-forwarded-host") || req.get("host") || "").split(",")[0].trim();
  if (!host || !["http", "https"].includes(protocol)) {
    throw new Error("OIDC redirect URL is not configured");
  }
  return new URL("/auth/callback", `${protocol}://${host}`).toString();
}

function cookieOptions(redirectUri, maxAge) {
  return { httpOnly: true, secure: new URL(redirectUri).protocol === "https:", sameSite: "lax", path: "/", maxAge };
}

function safeReturnPath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return "/";
  }
  return value;
}

function clearLoginCookies(res, options) {
  const clearOptions = { ...options };
  delete clearOptions.maxAge;
  res.clearCookie("git_oidc_state", clearOptions);
  res.clearCookie("git_oidc_verifier", clearOptions);
  res.clearCookie("git_oidc_nonce", clearOptions);
  res.clearCookie("git_oidc_return", clearOptions);
}

/**
 * Require bearer token authentication with OIDC introspection.
 * Checks that the token is active and has a non-empty 'sub' claim.
 * Also supports same-origin browser sessions backed by a server-side OIDC access token.
 *
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @param {function} next - Express next middleware function
 */
async function requireAuthentication(req, res, next) {
  // Check for Bearer token in Authorization header
  const header = req.headers.authorization || "";
  if (/^Bearer\s+/i.test(header)) {
    const token = header.slice(7).trim();
    try {
      const claims = await introspectAccessToken(token);
      if (!claims || !claims.active) {
        return res.status(401).json({ error: "Unauthorized: inactive token" });
      }
      if (typeof claims.sub !== "string" || !claims.sub.trim()) {
        return res.status(401).json({ error: "Unauthorized: missing subject claim" });
      }
      req.user = claims;
      req.authType = "bearer";
      return next();
    } catch {
      return res.status(401).json({ error: "Unauthorized: invalid token" });
    }
  }

  // Browser sessions are represented by an opaque, signed local cookie. Tokens stay
  // server-side and are introspected on each request; cookie auth is same-origin only.
  const session = getBrowserSession(req);
  if (session && isSameOriginRequest(req)) {
    try {
      const claims = await introspectAccessToken(session.accessToken);
      if (claims?.active && typeof claims.sub === "string" && claims.sub === session.sub) {
        req.user = claims;
        req.authType = "session";
        return next();
      }
    } catch {
      browserSessions.delete(session.id);
    }
  }

  return res.status(401).json({ error: "Unauthorized" });
}

function getTokenScopes(claims) {
  const rawScopes = claims.scope ?? claims.scp ?? claims.scopes ?? [];
  if (Array.isArray(rawScopes)) {
    return new Set(rawScopes.filter((scope) => typeof scope === "string"));
  }
  if (typeof rawScopes === "string") {
    return new Set(rawScopes.split(/\s+/).filter(Boolean));
  }
  return new Set();
}

function requireScope(scope) {
  return (req, res, next) => {
    const scopes = getTokenScopes(req.user);
    const allowed =
      scope === "repo:read" ? scopes.has("repo:read") || scopes.has("repo:write") : scopes.has("repo:write");
    if (!allowed) {
      return res.status(403).json({ error: `Forbidden: requires ${scope} scope` });
    }
    return next();
  };
}

/**
 * Safely get the repo path using the authenticated subject's hashed directory.
 * Validates the repo short name. Rejects if the repo name is invalid or if
 * there's an attempt to access a repo outside the authenticated subject's directory.
 *
 * @param {string} repo - The repository short name from the route
 * @param {object} req - Express request object (must have req.user with sub)
 * @returns {string|false} The repo path if valid, or false if invalid
 */
function getSafeRepoPath(repo, req) {
  if (!validateRepoName(repo)) {
    return false;
  }
  const hashedSub = getHashedSubjectDir(req);
  return getRepoPath(hashedSub, repo);
}

/** Resolve a repository-relative path and reject lexical or symlink escapes. */
function safeRepoFile(repoPath, relativePath) {
  if (typeof relativePath !== "string") {
    return null;
  }

  const root = path.resolve(repoPath);
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    return null;
  }

  try {
    const realRoot = fs.realpathSync(root);
    let existingPath = target;
    while (true) {
      try {
        fs.lstatSync(existingPath);
        break;
      } catch (error) {
        if (error.code !== "ENOENT") {
          return null;
        }
        const parent = path.dirname(existingPath);
        if (parent === existingPath) {
          return null;
        }
        existingPath = parent;
      }
    }

    const realExistingPath = fs.realpathSync(existingPath);
    if (realExistingPath !== realRoot && !realExistingPath.startsWith(`${realRoot}${path.sep}`)) {
      return null;
    }
    return target;
  } catch {
    return null;
  }
}

function isValidGitRef(ref) {
  return (
    typeof ref === "string" &&
    ref.length > 0 &&
    ref.length <= 255 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) &&
    !ref.includes("..") &&
    !ref.includes("//") &&
    !ref.includes("@{") &&
    !ref.endsWith(".") &&
    !ref.endsWith("/") &&
    !ref.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))
  );
}

/**
 * List repository entries (files and directories) for the given directory.
 * Includes git status-based uncommitted indicators.
 *
 * @param {string} directory - The directory to list
 * @param {string} relative - Relative path within the directory
 * @returns {Array} Array of entry objects
 */
async function treeEntries(directory, relative = "") {
  const git = getGit(path.resolve(directory));
  const status = await git.status();
  const dirty = new Set([...status.not_added, ...status.modified, ...status.created, ...status.deleted]);
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .map((entry) => ({
      name: entry.name,
      path: path.join(relative, entry.name),
      type: entry.isDirectory() ? "directory" : "file",
      uncommitted: dirty.has(path.join(relative, entry.name)),
    }))
    .filter((entry) => !entry.path.split(path.sep).includes(".git"));
}

/**
 * List repositories belonging to the authenticated subject only.
 * Unauthenticated access is rejected.
 *
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @returns {void}
 */
function listOwnRepos(req, res) {
  const hashedSub = getHashedSubjectDir(req);
  const subPath = path.join(process.env.DATA_PATH, hashedSub);

  const repositories = [];
  if (fs.existsSync(subPath)) {
    for (const repo of fs.readdirSync(subPath, { withFileTypes: true })) {
      if (repo.isDirectory()) {
        repositories.push({ repo: repo.name });
      }
    }
  }
  return res.json(repositories);
}

/**
 * Create a new repository for the authenticated subject.
 * The repo name comes from the route parameter. The owner directory is
 * derived from the authenticated subject's hashed sub claim.
 *
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @returns {void}
 */
async function createRepo(req, res) {
  const repo = req.params.repo;

  if (!validateRepoName(repo)) {
    return res.status(400).json({ error: "Invalid repository name" });
  }

  const repoPath = ensureRepoDir(getHashedSubjectDir(req), repo);
  const git = getGit(repoPath);

  if (!fs.existsSync(path.join(repoPath, ".git"))) {
    await git.init();
    await git.addConfig("user.name", "git-store");
    await git.addConfig("user.email", "git-store@local");
  }

  return res.status(201).json({
    message: `Repository ${repo} is ready`,
    repo,
  });
}

/**
 * Get repository log.
 * Resolves the repo path from the authenticated subject's hashed directory.
 *
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @returns {void}
 */
async function getRepoLog(req, res) {
  const repo = req.params.repo;
  const repoPath = getSafeRepoPath(repo, req);

  if (!repoPath) {
    return res.status(400).json({ error: "Invalid repository name" });
  }

  if (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, ".git"))) {
    return res.status(404).json({ error: "Repository not found" });
  }

  // Check that the repo belongs to the authenticated subject
  // (the path already ensures this since we use the hashed sub)

  try {
    const log = await getGit(repoPath).log();
    return res.json(log.all);
  } catch (error) {
    if (error.message.includes("does not have any commits yet")) {
      return res.json([]);
    }
    return res.status(500).json({ error: error.message });
  }
}

/**
 * List repository files/tree.
 * Resolves the repo path from the authenticated subject's hashed directory.
 *
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @returns {void}
 */
async function getRepoTree(req, res) {
  const repo = req.params.repo;
  const repoPath = getSafeRepoPath(repo, req);

  if (!repoPath) {
    return res.status(400).json({ error: "Invalid repository name" });
  }

  if (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, ".git"))) {
    return res.status(404).json({ error: "Repo not found" });
  }

  const directory = safeRepoFile(repoPath, req.query.path || "");
  if (!directory || !fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    return res.status(404).json({ error: "Directory not found" });
  }

  try {
    return res.json(await treeEntries(directory, path.relative(repoPath, directory)));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

/**
 * Read a repository file.
 * Resolves the repo path from the authenticated subject's hashed directory.
 *
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @returns {void}
 */
function getRepoFile(req, res) {
  const repo = req.params.repo;
  const repoPath = getSafeRepoPath(repo, req);

  if (!repoPath) {
    return res.status(400).json({ error: "Invalid repository name" });
  }

  if (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, ".git"))) {
    return res.status(404).json({ error: "Repo not found" });
  }

  const filePath = safeRepoFile(repoPath, req.query.path || "");
  if (!filePath) {
    return res.status(400).json({ error: "Invalid path" });
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return res.status(404).json({ error: "File not found" });
  }

  try {
    return res.type("text/plain").send(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

/**
 * Upload a file to a repository.
 * Requires authentication. Resolves repo path from authenticated subject.
 *
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @returns {void}
 */
function uploadRepoFile(req, res) {
  const repo = req.params.repo;
  const repoPath = getSafeRepoPath(repo, req);

  if (!repoPath) {
    return res.status(400).json({ error: "Invalid repository name" });
  }

  if (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, ".git"))) {
    return res.status(404).json({ error: "Repo not found" });
  }

  if (!req.body || typeof req.body.path !== "string" || !req.body.path.trim() || typeof req.body.content !== "string") {
    return res.status(400).json({ error: "Invalid file" });
  }

  const filePath = safeRepoFile(repoPath, req.body.path);
  if (!filePath) {
    return res.status(400).json({ error: "Invalid path" });
  }

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(req.body.content, "base64"));
    return res.status(201).json({ path: req.body.path, staged: false });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

/**
 * List repository branches.
 * Resolves the repo path from the authenticated subject's hashed directory.
 *
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @returns {void}
 */
async function getRepoBranches(req, res) {
  const repo = req.params.repo;
  const repoPath = getSafeRepoPath(repo, req);

  if (!repoPath) {
    return res.status(400).json({ error: "Invalid repository name" });
  }

  if (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, ".git"))) {
    return res.status(404).json({ error: "Repo not found" });
  }

  try {
    const branches = await getGit(repoPath).branchLocal();
    return res.json(branches.all);
  } catch (error) {
    if (error.message.includes("does not have any commits yet")) {
      return res.json([]);
    }
    return res.status(500).json({ error: error.message });
  }
}

/**
 * List repository tags.
 * Resolves the repo path from the authenticated subject's hashed directory.
 *
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @returns {void}
 */
async function getRepoTags(req, res) {
  const repo = req.params.repo;
  const repoPath = getSafeRepoPath(repo, req);

  if (!repoPath) {
    return res.status(400).json({ error: "Invalid repository name" });
  }

  if (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, ".git"))) {
    return res.status(404).json({ error: "Repo not found" });
  }

  try {
    const tags = await getGit(repoPath).tags();
    return res.json(tags.all);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

/**
 * Get file history from a repository.
 * Resolves the repo path from the authenticated subject's hashed directory.
 *
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @returns {void}
 */
async function getRepoHistory(req, res) {
  const repo = req.params.repo;
  const repoPath = getSafeRepoPath(repo, req);

  if (!repoPath) {
    return res.status(400).json({ error: "Invalid repository name" });
  }

  if (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, ".git"))) {
    return res.status(404).json({ error: "Repo not found" });
  }

  const filePath = safeRepoFile(repoPath, req.query.path || "");
  if (!filePath) {
    return res.status(400).json({ error: "Invalid path" });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }

  try {
    const history = await getGit(repoPath).log({ file: req.query.path, strictDate: false });
    return res.json(history.all);
  } catch (error) {
    if (error.message.includes("does not have any commits yet")) {
      return res.json([]);
    }
    return res.status(500).json({ error: error.message });
  }
}

// Define API routes with :repo only (no owner parameter)
// Old owner-based routes are intentionally omitted to reject spoofed paths

app.get("/health", (req, res) => res.json({ status: "ok" }));
app.get("/api", (req, res) => res.json(makeApiSpec()));
app.get("/config", (req, res) => {
  const issuer = process.env.OIDC_ISSUER;
  const oidcConfigured = Boolean(
    app.locals.oidcClientOverride || (issuer && process.env.OIDC_CLIENT_ID && process.env.OIDC_CLIENT_SECRET),
  );
  return res.json({
    oidcUserUrl: issuer ? `${issuer.replace(/\/$/, "")}/me` : null,
    oidcLoginUrl: oidcConfigured ? "/auth/login" : null,
  });
});
app.get("/session", async (req, res) => {
  const issuer = process.env.OIDC_ISSUER;
  if (!issuer) {
    return res.json({ authenticated: false, profile: null });
  }
  try {
    const authorization = req.headers.authorization || "";
    const session = getBrowserSession(req);
    const token = /^Bearer\s+/i.test(authorization) ? authorization.slice(7).trim() : session?.accessToken;
    if (!token) {
      return res.json({ authenticated: false, profile: null });
    }
    const claims = await introspectAccessToken(token);
    if (!claims?.active || typeof claims.sub !== "string" || !claims.sub.trim()) {
      return res.json({ authenticated: false, profile: null });
    }
    let profile = { sub: claims.sub, name: claims.name, preferred_username: claims.preferred_username };
    try {
      const response = await fetch(new URL("/userinfo", issuer), {
        headers: { Authorization: `Bearer ${token}`, "X-Auth-Audience": process.env.OIDC_CLIENT_ID },
      });
      if (response.ok) {
        const userInfo = await response.json();
        if (userInfo.sub === claims.sub) {
          profile = userInfo;
        }
      }
    } catch {
      // Validated introspection claims still identify the authenticated session.
    }
    return res.json({ authenticated: true, profile });
  } catch {
    return res.json({ authenticated: false, profile: null });
  }
});

app.get("/auth/login", (req, res) => {
  const client = getOidcClient();
  if (!client) {
    return res.status(503).send("OIDC sign-in is not configured.");
  }
  try {
    const { generators } = require("openid-client");
    const state = generators.state();
    const nonce = generators.nonce();
    const codeVerifier = generators.codeVerifier();
    const codeChallenge = generators.codeChallenge(codeVerifier);
    const redirectUri = getOidcRedirectUri(req);
    const options = cookieOptions(redirectUri, 10 * 60 * 1000);
    res.cookie("git_oidc_state", state, options);
    res.cookie("git_oidc_nonce", nonce, options);
    res.cookie("git_oidc_verifier", codeVerifier, options);
    res.cookie("git_oidc_return", safeReturnPath(req.query.returnTo), options);
    const authorizationUrl = client.authorizationUrl({
      response_type: "code",
      redirect_uri: redirectUri,
      scope: "openid profile email repo:read repo:write",
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    res.set("Cache-Control", "no-store");
    return res.redirect(302, authorizationUrl);
  } catch {
    return res.status(503).send("OIDC sign-in could not be started.");
  }
});

app.get("/auth/callback", async (req, res) => {
  const client = getOidcClient();
  if (!client) {
    return res.status(503).send("OIDC sign-in is not configured.");
  }
  let redirectUri;
  let options;
  try {
    redirectUri = getOidcRedirectUri(req);
    options = cookieOptions(redirectUri, 10 * 60 * 1000);
  } catch {
    return res.status(500).send("OIDC redirect is misconfigured.");
  }

  const cookies = parseCookies(req.headers.cookie);
  const state = cookies.git_oidc_state;
  const nonce = cookies.git_oidc_nonce;
  const codeVerifier = cookies.git_oidc_verifier;
  const returnTo = safeReturnPath(cookies.git_oidc_return);
  clearLoginCookies(res, options);
  if (!state || !nonce || !codeVerifier || req.query.state !== state || typeof req.query.code !== "string") {
    return res.status(400).send("OIDC sign-in response was invalid. Please try again.");
  }

  let callbackStage = "authorization-code exchange and ID-token validation";
  try {
    const tokenSet = await client.callback(
      redirectUri,
      { code: req.query.code, state: req.query.state },
      { state, nonce, code_verifier: codeVerifier },
    );
    const accessToken = tokenSet.access_token;
    const idClaims = tokenSet.claims();
    callbackStage = "access-token introspection";
    const introspection = accessToken ? await introspectAccessToken(accessToken) : null;
    if (
      !accessToken ||
      !introspection?.active ||
      typeof introspection.sub !== "string" ||
      introspection.sub !== idClaims.sub
    ) {
      return res.status(401).send("OIDC sign-in did not return an active repository identity.");
    }

    const id = crypto.randomBytes(32).toString("base64url");
    const expiresIn =
      Number(introspection.exp ? introspection.exp * 1000 - Date.now() : tokenSet.expires_in * 1000) || 3600_000;
    const maxAge = Math.max(60_000, Math.min(expiresIn, 24 * 60 * 60 * 1000));
    browserSessions.set(id, {
      accessToken,
      sub: introspection.sub,
      expiresAt: Date.now() + maxAge,
    });
    callbackStage = "browser-session cookie creation";
    res.cookie(sessionCookieName, `${id}.${signSessionId(id)}`, {
      ...cookieOptions(redirectUri, maxAge),
    });
    res.set("Cache-Control", "no-store");
    return res.redirect(303, returnTo);
  } catch (error) {
    const oauthError = typeof error.error === "string" && /^[a-z0-9_]+$/i.test(error.error) ? error.error : "none";
    const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : "none";
    const description =
      typeof error.error_description === "string"
        ? error.error_description.replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]").slice(0, 160)
        : "none";
    console.error(
      `OIDC callback failed during ${callbackStage}: ${error.name || "Error"}, oauth=${oauthError}, status=${statusCode}, detail=${description}`,
    );
    return res.status(401).send("OIDC sign-in failed. Please try again.");
  }
});

app.post("/auth/logout", (req, res) => {
  const session = getBrowserSession(req);
  if (session) {
    browserSessions.delete(session.id);
  }
  let redirectUri;
  try {
    redirectUri = getOidcRedirectUri(req);
  } catch {
    redirectUri = "http://localhost/";
  }
  const clearOptions = cookieOptions(redirectUri, 0);
  delete clearOptions.maxAge;
  return res.clearCookie(sessionCookieName, clearOptions).redirect(303, "/");
});

// List/create repositories - scoped to authenticated subject
app.get("/repos", requireAuthentication, requireScope("repo:read"), listOwnRepos);
app.post("/repos/:repo", requireAuthentication, requireScope("repo:write"), createRepo);

// Repository operations - all use :repo only, no owner in route
app.get("/repos/:repo/log", requireAuthentication, requireScope("repo:read"), async (req, res) => {
  getRepoLog(req, res);
});
app.get("/repos/:repo/tree", requireAuthentication, requireScope("repo:read"), async (req, res) => {
  getRepoTree(req, res);
});
app.get("/repos/:repo/file", requireAuthentication, requireScope("repo:read"), async (req, res) => {
  getRepoFile(req, res);
});
app.post("/repos/:repo/files", requireAuthentication, requireScope("repo:write"), uploadRepoFile);
app.get("/repos/:repo/branches", requireAuthentication, requireScope("repo:read"), async (req, res) => {
  getRepoBranches(req, res);
});
app.get("/repos/:repo/tags", requireAuthentication, requireScope("repo:read"), async (req, res) => {
  getRepoTags(req, res);
});
app.get("/repos/:repo/history", requireAuthentication, requireScope("repo:read"), async (req, res) => {
  getRepoHistory(req, res);
});
app.post("/repos/:repo/stage", requireAuthentication, requireScope("repo:write"), async (req, res) => {
  const repo = req.params.repo;
  const repoPath = getSafeRepoPath(repo, req);
  if (!repoPath) {
    return res.status(400).json({ error: "Invalid repository name" });
  }
  if (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, ".git"))) {
    return res.status(404).json({ error: "Repo not found" });
  }
  try {
    await getGit(repoPath).add(req.body.files);
    return res.json({ message: "Files staged successfully" });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});
app.post("/repos/:repo/unstage", requireAuthentication, requireScope("repo:write"), async (req, res) => {
  const repo = req.params.repo;
  const repoPath = getSafeRepoPath(repo, req);
  if (!repoPath) {
    return res.status(400).json({ error: "Invalid repository name" });
  }
  if (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, ".git"))) {
    return res.status(404).json({ error: "Repo not found" });
  }
  try {
    await getGit(repoPath).reset(["--mixed", ...(req.body.files || [])]);
    return res.json({ message: "Files unstaged successfully" });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});
app.post("/repos/:repo/commit", requireAuthentication, requireScope("repo:write"), async (req, res) => {
  const repo = req.params.repo;
  const repoPath = getSafeRepoPath(repo, req);
  if (!repoPath) {
    return res.status(400).json({ error: "Invalid repository name" });
  }
  if (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, ".git"))) {
    return res.status(404).json({ error: "Repo not found" });
  }
  try {
    const status = await getGit(repoPath).status();
    if (status.staged.length === 0) {
      return res.json({ message: "No changes to commit" });
    }
    const message = req.body.message || "autocommit";
    await getGit(repoPath).commit(message);
    return res.json({ message: "Changes committed successfully", commit: message });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});
app.post("/repos/:repo/tags", requireAuthentication, requireScope("repo:write"), async (req, res) => {
  if (!isValidGitRef(req.body?.name)) {
    return res.status(400).json({ error: "Invalid tag name" });
  }
  const repo = req.params.repo;
  const repoPath = getSafeRepoPath(repo, req);
  if (!repoPath) {
    return res.status(400).json({ error: "Invalid repository name" });
  }
  if (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, ".git"))) {
    return res.status(404).json({ error: "Repo not found" });
  }
  try {
    await getGit(repoPath).addTag(req.body.name);
    return res.json({ message: `Tag ${req.body.name} added` });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});
app.delete("/repos/:repo/tags/:name", requireAuthentication, requireScope("repo:write"), async (req, res) => {
  if (!isValidGitRef(req.params.name)) {
    return res.status(400).json({ error: "Invalid tag name" });
  }
  const repo = req.params.repo;
  const repoPath = getSafeRepoPath(repo, req);
  if (!repoPath) {
    return res.status(400).json({ error: "Invalid repository name" });
  }
  if (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, ".git"))) {
    return res.status(404).json({ error: "Repo not found" });
  }
  try {
    await getGit(repoPath).tag(["-d", req.params.name]);
    return res.json({ message: `Tag ${req.params.name} removed` });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});
app.post("/repos/:repo/branches", requireAuthentication, requireScope("repo:write"), async (req, res) => {
  if (!isValidGitRef(req.body?.name) || (req.body.startPoint && !isValidGitRef(req.body.startPoint))) {
    return res.status(400).json({ error: "Invalid branch name or start point" });
  }
  const repo = req.params.repo;
  const repoPath = getSafeRepoPath(repo, req);
  if (!repoPath) {
    return res.status(400).json({ error: "Invalid repository name" });
  }
  if (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, ".git"))) {
    return res.status(404).json({ error: "Repo not found" });
  }
  try {
    const args = req.body.startPoint ? [req.body.name, req.body.startPoint] : [req.body.name];
    await getGit(repoPath).branch(args);
    return res.json({ message: `Branch ${req.body.name} created` });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});
app.delete("/repos/:repo/branches/:name", requireAuthentication, requireScope("repo:write"), async (req, res) => {
  if (!isValidGitRef(req.params.name)) {
    return res.status(400).json({ error: "Invalid branch name" });
  }
  const repo = req.params.repo;
  const repoPath = getSafeRepoPath(repo, req);
  if (!repoPath) {
    return res.status(400).json({ error: "Invalid repository name" });
  }
  if (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, ".git"))) {
    return res.status(404).json({ error: "Repo not found" });
  }
  try {
    await getGit(repoPath).branch(["-D", req.params.name]);
    return res.json({ message: `Branch ${req.params.name} removed` });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * Generate the OpenAPI specification with updated routes (no owner parameter).
 * Rebuilds the apiSpec dynamically to reflect the new route structure.
 *
 * @returns {object} The OpenAPI specification object
 */
function makeApiSpec() {
  const pathParametersRepo = [{ name: "repo", in: "path", required: true, schema: { type: "string" } }];

  const jsonBody = (properties, required = []) => ({
    required: required.length > 0,
    content: { "application/json": { schema: { type: "object", properties, required } } },
  });
  const unauthorized = { description: "Unauthorized" };
  const notFound = { description: "Repository not found" };
  const operation = (summary, responses, body, parameters = pathParametersRepo) => {
    const protectedOperation =
      parameters.some(({ name }) => name === "repo") || summary.includes("authenticated subject");
    const readOperation = /^(Fetch|Get file|List|Read)/.test(summary);
    return {
      summary,
      parameters,
      ...(body ? { requestBody: body } : {}),
      ...(protectedOperation ? { security: [{ bearerAuth: [] }] } : {}),
      ...(protectedOperation ? { "x-required-scope": readOperation ? "repo:read or repo:write" : "repo:write" } : {}),
      responses: protectedOperation
        ? { ...responses, 401: unauthorized, 403: { description: "Insufficient scope" } }
        : responses,
    };
  };

  const apiSpec = {
    openapi: "3.0.3",
    info: { title: "Git Store API", version: "1.0.0" },
    servers: [{ url: "/", description: "This git store server" }],
    paths: {
      "/health": { get: operation("Health check", { 200: { description: "Healthy" } }, null, []) },
      "/api": { get: operation("Get this OpenAPI document", { 200: { description: "OpenAPI document" } }, null, []) },
      "/config": {
        get: operation("Get browser configuration", { 200: { description: "Public configuration" } }, null, []),
      },
      "/session": {
        get: operation(
          "Get the current OIDC session profile",
          { 200: { description: "Session profile or unauthenticated state" } },
          null,
          [],
        ),
      },
      "/auth/login": {
        get: operation(
          "Start OIDC sign-in with authorization code and PKCE",
          {
            302: { description: "Redirect to the configured OIDC provider" },
            503: { description: "OIDC sign-in is not configured" },
          },
          null,
          [],
        ),
      },
      "/auth/callback": {
        get: operation(
          "Complete OIDC sign-in and establish a browser session",
          {
            303: { description: "Redirect back to the application" },
            400: { description: "Invalid authorization response" },
            401: unauthorized,
          },
          null,
          [],
        ),
      },
      "/auth/logout": {
        post: {
          ...operation("End the current browser session", { 303: { description: "Session cleared" } }, null, []),
          security: [{ cookieSession: [] }],
        },
      },
      "/repos": {
        get: operation(
          "List repositories owned by the authenticated subject",
          { 200: { description: "Repository list" }, 401: unauthorized },
          null,
          [],
        ),
      },
      "/repos/{repo}": {
        post: operation(
          "Create a repository for the authenticated subject",
          { 201: { description: "Created" }, 400: { description: "Invalid repository name" }, 401: unauthorized },
          null,
          pathParametersRepo,
        ),
      },
      "/repos/{repo}/log": {
        get: operation(
          "Fetch the repository log",
          { 200: { description: "Commit array" }, 404: notFound },
          null,
          pathParametersRepo,
        ),
      },
      "/repos/{repo}/stage": {
        post: operation(
          "Stage files",
          { 200: { description: "Staged" }, 401: unauthorized, 404: notFound },
          jsonBody({ files: { type: "array", items: { type: "string" } } }, ["files"]),
        ),
      },
      "/repos/{repo}/unstage": {
        post: operation(
          "Unstage files",
          { 200: { description: "Unstaged" }, 401: unauthorized, 404: notFound },
          jsonBody({ files: { type: "array", items: { type: "string" } } }, ["files"]),
        ),
      },
      "/repos/{repo}/commit": {
        post: operation(
          "Commit staged changes",
          { 200: { description: "Committed or no changes" }, 401: unauthorized, 404: notFound },
          jsonBody({ message: { type: "string" } }),
        ),
      },
      "/repos/{repo}/tags": {
        get: operation(
          "List repository tags",
          { 200: { description: "Tags" }, 404: notFound },
          null,
          pathParametersRepo,
        ),
        post: operation(
          "Add a tag",
          { 200: { description: "Tag added" }, 401: unauthorized, 404: notFound },
          jsonBody({ name: { type: "string" } }, ["name"]),
        ),
      },
      "/repos/{repo}/tags/{name}": {
        delete: operation(
          "Remove a tag",
          { 200: { description: "Tag removed" }, 401: unauthorized, 404: notFound },
          null,
          [...pathParametersRepo, { name: "name", in: "path", required: true, schema: { type: "string" } }],
        ),
      },
      "/repos/{repo}/branches": {
        get: operation(
          "List repository branches",
          { 200: { description: "Branches" }, 404: notFound },
          null,
          pathParametersRepo,
        ),
        post: operation(
          "Create a branch",
          {
            200: { description: "Branch created" },
            400: { description: "Missing branch name" },
            401: unauthorized,
            404: notFound,
          },
          jsonBody({ name: { type: "string" }, startPoint: { type: "string" } }, ["name"]),
        ),
      },
      "/repos/{repo}/branches/{name}": {
        delete: operation(
          "Remove a branch",
          { 200: { description: "Branch removed" }, 401: unauthorized, 404: notFound },
          null,
          [...pathParametersRepo, { name: "name", in: "path", required: true, schema: { type: "string" } }],
        ),
      },
      "/repos/{repo}/tree": {
        get: operation(
          "List repository files",
          { 200: { description: "Repository tree" }, 404: notFound },
          null,
          pathParametersRepo,
        ),
      },
      "/repos/{repo}/file": {
        get: operation(
          "Read a repository file",
          { 200: { description: "File contents" }, 400: { description: "Invalid path" }, 404: notFound },
          null,
          [...pathParametersRepo, { name: "path", in: "query", required: true, schema: { type: "string" } }],
        ),
      },
      "/repos/{repo}/files": {
        post: operation(
          "Upload an unstaged file",
          {
            201: { description: "File written" },
            400: { description: "Invalid file" },
            401: unauthorized,
            404: notFound,
          },
          jsonBody({ path: { type: "string" }, content: { type: "string", description: "Base64-encoded bytes" } }, [
            "path",
            "content",
          ]),
        ),
      },
      "/repos/{repo}/history": {
        get: operation(
          "List file history",
          { 200: { description: "Commit history" }, 400: { description: "Invalid path" }, 404: notFound },
          null,
          [...pathParametersRepo, { name: "path", in: "query", required: true, schema: { type: "string" } }],
        ),
      },
    },
    components: {
      securitySchemes: {
        cookieSession: {
          type: "apiKey",
          in: "cookie",
          name: sessionCookieName,
          description: "HttpOnly OIDC browser session established by /auth/callback",
        },
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "OIDC access token",
          description: "Active OIDC access token. repo:write also grants repository reads.",
        },
      },
    },
  };

  return apiSpec;
}

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
}

module.exports = app;
