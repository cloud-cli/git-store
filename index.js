const express = require("express");
const simpleGit = require("simple-git");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { getRepoPath, ensureRepoDir, validateRepoName, getHashedSubjectDir } = require("./storage");
const aliases = require("./aliases");
const organizations = require("./organizations");

const getGit = (repoPath) => simpleGit.simpleGit(repoPath);

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use("/ui", express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => {
  const query = req.url.slice(1);
  return res.redirect(302, `/ui/${query}`);
});
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
    let issuer = await Issuer.discover(process.env.OIDC_ISSUER);
    if (process.env.OIDC_JWKS_URI) {
      const issuerOrigin = new URL(process.env.OIDC_ISSUER).origin;
      const jwksUrl = new URL(process.env.OIDC_JWKS_URI);
      if (jwksUrl.origin !== issuerOrigin) {
        throw new Error("OIDC JWKS endpoint must share the issuer origin");
      }
      issuer = new Issuer({ ...issuer.metadata, jwks_uri: jwksUrl.toString() });
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
    return new URL("/ui/auth/callback", baseUrl).toString();
  }
  const protocol = (req.get("x-forwarded-proto") || req.protocol || "http").split(",")[0].trim();
  const host = (req.get("x-forwarded-host") || req.get("host") || "").split(",")[0].trim();
  if (!host || !["http", "https"].includes(protocol)) {
    throw new Error("OIDC redirect URL is not configured");
  }
  return new URL("/ui/auth/callback", `${protocol}://${host}`).toString();
}

function cookieOptions(redirectUri, maxAge) {
  return {
    httpOnly: true,
    secure: new URL(redirectUri).protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge,
  };
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
  if (req.aliasRouteAuthenticated && req.user) {
    return next();
  }
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
  // server-side and the validated OIDC subject/scopes are held for the short token lifetime.
  const session = getBrowserSession(req);
  if (session && isSameOriginRequest(req)) {
    req.user = {
      sub: session.sub,
      scope: session.scope,
      active: true,
      preferred_username: session.profile.preferred_username,
      username: session.profile.username,
    };
    req.authType = "session";
    return next();
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

function getOidcUsername(claims) {
  for (const claim of [claims?.preferred_username, claims?.username]) {
    if (typeof claim === "string" && claim.length > 0) {
      return claim;
    }
  }
  return null;
}

function getOidcProfileUrl() {
  try {
    return new URL("/me", process.env.OIDC_ISSUER).href;
  } catch {
    return null;
  }
}

function usernameRequiredResponse(res, message) {
  const profileUrl = getOidcProfileUrl();
  const safeProfileUrl = (profileUrl || "#")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  res.set("Cache-Control", "no-store");
  return res
    .status(403)
    .type("html")
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="5;url=${safeProfileUrl}"><title>OIDC username required</title></head><body><main><h1>OIDC username required</h1><p>${message}</p><p>Opening your OIDC profile to set or restore your username. <a href="${safeProfileUrl}">Continue to your OIDC profile</a>.</p></main></body></html>`,
    );
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

function requireGitBasicAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const match = /^Basic\s+([A-Za-z0-9+/]+=*)$/i.exec(header);
  if (!match) {
    res.set("WWW-Authenticate", 'Basic realm="Git Store", charset="UTF-8"');
    return res.status(401).send("Git HTTP authentication required");
  }
  let decoded;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    decoded = "";
  }
  const separator = decoded.indexOf(":");
  const token = separator < 0 ? "" : decoded.slice(separator + 1);
  if (separator < 0 || !token) {
    res.set("WWW-Authenticate", 'Basic realm="Git Store", charset="UTF-8"');
    return res.status(401).send("Git HTTP authentication required");
  }
  Promise.resolve(introspectAccessToken(token))
    .then((claims) => {
      if (!claims?.active || typeof claims.sub !== "string" || !claims.sub.trim()) {
        res.set("WWW-Authenticate", 'Basic realm="Git Store", charset="UTF-8"');
        return res.status(401).send("Invalid Git credentials");
      }
      req.user = claims;
      return next();
    })
    .catch(() => {
      res.set("WWW-Authenticate", 'Basic realm="Git Store", charset="UTF-8"');
      return res.status(401).send("Invalid Git credentials");
    });
}

function gitSmartHttp(req, res) {
  const match =
    /^\/git\/(?:([A-Za-z0-9][A-Za-z0-9_-]{0,62})\/)?([A-Za-z0-9][A-Za-z0-9._-]{0,99})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(
      req.path,
    );
  if (
    !match ||
    (match[1] && !aliases.validAlias(match[1])) ||
    !validateRepoName(match[2]) ||
    Object.keys(req.query).some((key) => key !== "service")
  ) {
    return res.status(400).send("Malformed Git request");
  }
  const alias = match[1];
  const repo = match[2];
  const operation = match[3];
  const owner = alias ? aliases.owner(alias) : null;
  const subjectHash = getHashedSubjectDir(req);
  if (alias && (!owner || owner !== subjectHash)) {
    return res.status(404).send("Repository not found");
  }
  const service = req.query.service;
  let write;
  if (operation === "info/refs" && (service === "git-upload-pack" || service === "git-receive-pack")) {
    write = service === "git-receive-pack";
  } else if (operation === "git-upload-pack" && req.method === "POST") {
    write = false;
  } else if (operation === "git-receive-pack" && req.method === "POST") {
    write = true;
  } else {
    return res.status(400).send("Unsupported Git request");
  }
  if (req.method !== (operation === "info/refs" ? "GET" : "POST")) {
    return res.status(405).send("Method not allowed");
  }
  const scopes = getTokenScopes(req.user);
  if (write ? !scopes.has("repo:write") : !scopes.has("repo:read") && !scopes.has("repo:write")) {
    return res.status(403).send("Insufficient scope");
  }
  const repoPath = getSafeRepoPath(repo, req);
  if (!repoPath || !fs.existsSync(path.join(repoPath, ".git"))) {
    return res.status(404).send("Repository not found");
  }
  const queryService = operation === "info/refs" ? service : undefined;
  const env = {
    ...process.env,
    GIT_PROJECT_ROOT: path.resolve(process.env.DATA_PATH, alias ? owner : subjectHash),
    GIT_HTTP_EXPORT_ALL: "1",
    GIT_PROTOCOL: req.get("git-protocol") || "",
    PATH_INFO: `/${repo}/.git/${operation}`,
    REQUEST_METHOD: req.method,
    QUERY_STRING: queryService ? `service=${queryService}` : "",
    CONTENT_TYPE: req.get("content-type") || "",
    CONTENT_LENGTH: req.get("content-length") || "0",
    REMOTE_USER: req.user.sub,
  };
  const child = spawn("git", ["http-backend"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let headersParsed = false;
  let output = Buffer.alloc(0);
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 500) {
      stderr += chunk.toString().slice(0, 500 - stderr.length);
    }
  });
  const writeBackendOutput = (chunk) => {
    if (!res.write(chunk)) {
      child.stdout.pause();
      res.once("drain", () => child.stdout.resume());
    }
  };
  child.stdout.on("data", (chunk) => {
    if (!headersParsed) {
      output = Buffer.concat([output, chunk]);
      const boundary = output.indexOf("\r\n\r\n");
      const delimiterLength = 4;
      const lfBoundary = boundary < 0 ? output.indexOf("\n\n") : -1;
      const splitAt = boundary >= 0 ? boundary : lfBoundary;
      const splitLength = boundary >= 0 ? delimiterLength : 2;
      if (splitAt < 0) {
        return;
      }
      const headerText = output.subarray(0, splitAt).toString("latin1");
      const body = output.subarray(splitAt + splitLength);
      for (const line of headerText.split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon > 0) {
          const key = line.slice(0, colon).trim();
          const value = line.slice(colon + 1).trim();
          if (key.toLowerCase() === "status") {
            res.status(Number.parseInt(value, 10) || 200);
          } else if (!/^(connection|transfer-encoding)$/i.test(key)) {
            res.set(key, value);
          }
        }
      }
      headersParsed = true;
      if (body.length) {
        writeBackendOutput(body);
      }
      output = Buffer.alloc(0);
    } else {
      writeBackendOutput(chunk);
    }
  });
  req.pipe(child.stdin);
  child.stdin.on("error", (error) => {
    if (error.code !== "EPIPE") {
      child.kill();
    }
  });
  req.on("aborted", () => child.kill());
  res.on("close", () => {
    if (!res.writableEnded) {
      child.kill();
    }
  });
  child.on("error", () => {
    if (!res.headersSent) {
      res.status(500).end("Git backend unavailable");
    } else {
      res.end();
    }
  });
  child.on("close", (code) => {
    if (!headersParsed && !res.headersSent) {
      res.status(code === 0 ? 200 : 500);
    }
    if (code !== 0) {
      process.stderr.write(`[git-http-backend] ${code}: ${stderr.slice(0, 500)}\n`);
    }
    res.end();
  });
}

app.all("/git/:repo.git/*path", requireGitBasicAuth, gitSmartHttp);
app.all("/git/:alias/:repo.git/*path", requireGitBasicAuth, gitSmartHttp);

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
  if (req.organizationPath) {
    return path.join(req.organizationPath, repo);
  }
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

  try {
    let repoPath;
    if (req.organizationPath) {
      fs.mkdirSync(req.organizationPath, { recursive: true });
      repoPath = path.join(req.organizationPath, repo);
      fs.mkdirSync(repoPath, { recursive: true });
    } else {
      repoPath = ensureRepoDir(getHashedSubjectDir(req), repo);
    }
    const git = getGit(repoPath);

    if (!fs.existsSync(path.join(repoPath, ".git"))) {
      await git.init();
      await git.addConfig("user.name", "git-store");
      await git.addConfig("user.email", "git-store@local");
    }

    return res.status(201).json({ message: `Repository ${repo} is ready`, repo });
  } catch (error) {
    const code = typeof error.code === "string" ? error.code : "REPO_INITIALIZATION_FAILED";
    process.stderr.write(`[repo-create] ${code}\n`);
    return res.status(500).json({ error: "Repository creation failed", code });
  }
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
    const history = await getGit(repoPath).log({
      file: req.query.path,
      strictDate: false,
    });
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

app.get("/api/v1/health", (req, res) => res.json({ status: "ok" }));
app.get("/api", (req, res) => res.json(makeApiSpec()));
app.get("/api/v1/openapi.json", (req, res) => res.json(makeApiSpec()));
app.get("/ui/config", (req, res) => {
  const issuer = process.env.OIDC_ISSUER;
  const oidcConfigured = Boolean(
    app.locals.oidcClientOverride || (issuer && process.env.OIDC_CLIENT_ID && process.env.OIDC_CLIENT_SECRET),
  );
  return res.json({
    oidcUserUrl: issuer ? `${issuer.replace(/\/$/, "")}/me` : null,
    oidcLoginUrl: oidcConfigured ? "/ui/auth/login" : null,
  });
});
app.get("/ui/session", async (req, res) => {
  const issuer = process.env.OIDC_ISSUER;
  if (!issuer) {
    return res.json({ authenticated: false, profile: null });
  }
  try {
    const browserSession = getBrowserSession(req);
    if (browserSession && isSameOriginRequest(req)) {
      return res.json({
        authenticated: true,
        profile: { ...browserSession.profile, alias: aliases.get(browserSession.sub) },
      });
    }
    const authorization = req.headers.authorization || "";
    const token = /^Bearer\s+/i.test(authorization) ? authorization.slice(7).trim() : null;
    if (!token) {
      return res.json({ authenticated: false, profile: null });
    }
    const claims = await introspectAccessToken(token);
    if (!claims?.active || typeof claims.sub !== "string" || !claims.sub.trim()) {
      return res.json({ authenticated: false, profile: null });
    }
    let profile = {
      sub: claims.sub,
      name: claims.name,
      preferred_username: claims.preferred_username,
      username: claims.username,
    };
    try {
      const response = await fetch(new URL("/userinfo", issuer), {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Auth-Audience": process.env.OIDC_CLIENT_ID,
        },
      });
      if (response.ok) {
        const userInfo = await response.json();
        const profileSub = userInfo.sub || userInfo.id;
        if (profileSub === claims.sub) {
          profile = { ...profile, ...userInfo, sub: claims.sub };
        }
      }
    } catch {
      // Validated introspection claims still identify the authenticated session.
    }
    return res.json({ authenticated: true, profile: { ...profile, alias: aliases.get(claims.sub) } });
  } catch {
    return res.json({ authenticated: false, profile: null });
  }
});

app.get("/ui/auth/login", (req, res) => {
  const client = getOidcClient();
  if (!client) {
    return res.status(503).send("OIDC sign-in is not configured.");
  }
  try {
    const { generators } = require("openid-client");
    const state = generators.state();
    const codeVerifier = generators.codeVerifier();
    const codeChallenge = generators.codeChallenge(codeVerifier);
    const redirectUri = getOidcRedirectUri(req);
    const options = cookieOptions(redirectUri, 10 * 60 * 1000);
    res.cookie("git_oidc_state", state, options);
    res.cookie("git_oidc_verifier", codeVerifier, options);
    res.cookie("git_oidc_return", safeReturnPath(req.query.returnTo), options);
    const authorizationUrl = client.authorizationUrl({
      response_type: "code",
      redirect_uri: redirectUri,
      scope: "openid profile email repo:read repo:write",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    res.set("Cache-Control", "no-store");
    return res.redirect(302, authorizationUrl);
  } catch {
    return res.status(503).send("OIDC sign-in could not be started.");
  }
});

const handleOidcCallback = async (req, res) => {
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
  const codeVerifier = cookies.git_oidc_verifier;
  const returnTo = safeReturnPath(cookies.git_oidc_return);
  clearLoginCookies(res, options);
  if (!state || !codeVerifier || req.query.state !== state || typeof req.query.code !== "string") {
    return res.status(400).send("OIDC sign-in response was invalid. Please try again.");
  }

  let callbackStage = "authorization-code exchange and ID-token validation";
  try {
    const tokenSet = await client.callback(
      redirectUri,
      { code: req.query.code, state: req.query.state },
      { state, code_verifier: codeVerifier },
    );
    const accessToken = tokenSet.access_token;
    const idClaims = tokenSet.claims();
    if (!accessToken || typeof idClaims.sub !== "string" || !idClaims.sub.trim()) {
      return res.status(401).send("OIDC sign-in did not return a valid repository identity.");
    }

    callbackStage = "userinfo validation";
    const userInfoResponse = await fetch(new URL("/userinfo", process.env.OIDC_ISSUER), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-Auth-Audience": process.env.OIDC_CLIENT_ID,
      },
    });
    if (!userInfoResponse.ok) {
      return res.status(401).send("OIDC sign-in could not verify the access-token profile.");
    }
    const profile = await userInfoResponse.json();
    if ((profile.sub || profile.id) !== idClaims.sub) {
      return res.status(401).send("OIDC sign-in subject did not match the access-token profile.");
    }
    profile.sub = idClaims.sub;
    const profileUsername = getOidcUsername(profile);
    const tokenUsername = getOidcUsername(idClaims);
    const username = profileUsername || tokenUsername;
    if (
      !username ||
      !aliases.validAlias(username) ||
      (profileUsername && tokenUsername && tokenUsername !== profileUsername)
    ) {
      return usernameRequiredResponse(
        res,
        "A valid OIDC username must be present in the sign-in response. The ID token and UserInfo response must agree when both include it.",
      );
    }
    const existingAlias = aliases.get(idClaims.sub);
    if (existingAlias && existingAlias !== username) {
      return usernameRequiredResponse(
        res,
        "Your OIDC username does not match the immutable username already registered for this account. Restore the original username to continue.",
      );
    }
    if (!existingAlias) {
      const aliasAssignment = aliases.assign(idClaims.sub, username);
      if (aliasAssignment === false) {
        return usernameRequiredResponse(
          res,
          "Your OIDC username conflicts with an existing account URL. Set a unique username in your OIDC profile before signing in.",
        );
      }
    }
    profile.preferred_username = username;

    const id = crypto.randomBytes(32).toString("base64url");
    const expiresIn = Number(tokenSet.expires_in * 1000 || idClaims.exp * 1000 - Date.now()) || 3600_000;
    const maxAge = Math.max(60_000, Math.min(expiresIn, 24 * 60 * 60 * 1000));
    const browserScopes = (process.env.OIDC_BROWSER_SCOPES || "")
      .split(/[\s,]+/)
      .filter((scope) => scope === "repo:read" || scope === "repo:write");
    browserSessions.set(id, {
      sub: idClaims.sub,
      profile,
      scope: browserScopes.join(" "),
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
    const endpoint = typeof error.response?.req?.path === "string" ? error.response.req.path : "none";
    const description =
      typeof error.error_description === "string"
        ? error.error_description.replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]").slice(0, 160)
        : "none";
    let message = "none";
    if (typeof error.message === "string") {
      message = error.message
        .replaceAll(process.env.OIDC_CLIENT_SECRET || "\0", "[redacted]")
        .replace(/(code|token|secret|verifier)=\S+/gi, "$1=[redacted]")
        .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]")
        .slice(0, 160);
    }
    console.error(
      `OIDC callback failed during ${callbackStage}: ${error.name || "Error"}, oauth=${oauthError}, status=${statusCode}, endpoint=${endpoint}, detail=${description}, message=${message}`,
    );
    return res.status(401).send("OIDC sign-in failed. Please try again.");
  }
};
app.get("/ui/auth/callback", handleOidcCallback);
// Preserve callbacks already registered with the identity provider until the
// registered redirect URI can be migrated to /ui/auth/callback.
app.get("/auth/callback", handleOidcCallback);

app.post("/ui/auth/logout", (req, res) => {
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
app.get("/api/v1/orgs", requireAuthentication, requireScope("repo:read"), (req, res) =>
  res.json(organizations.listForSubject(req.user.sub)),
);
app.post("/api/v1/orgs", requireAuthentication, requireScope("repo:write"), (req, res) => {
  const result = organizations.create(req.user.sub, req.body?.slug || req.body?.name);
  if (result === null) {
    return res.status(400).json({ error: "Invalid organization slug" });
  }
  if (result === false) {
    return res.status(409).json({ error: "Organization already exists" });
  }
  return res.status(201).json(result);
});
app.use("/api/v1/orgs/:org/repos", requireAuthentication, (req, res, next) => {
  if (!organizations.normalizeSlug(req.params.org)) {
    return res.status(400).json({ error: "Invalid organization slug" });
  }
  const organization = organizations.get(req.params.org);
  if (!organization || organization.ownerHash !== getHashedSubjectDir(req)) {
    return res.status(404).json({ error: "Organization not found" });
  }
  req.organizationPath = path.join(process.env.DATA_PATH, "orgs", organization.slug);
  if (req.path === "/" || req.path === "") {
    if (req.method !== "GET") {
      return next();
    }
    if (!getTokenScopes(req.user).has("repo:read") && !getTokenScopes(req.user).has("repo:write")) {
      return res.status(403).json({ error: "Forbidden: requires repo:read scope" });
    }
    const reposPath = req.organizationPath;
    const repos = fs.existsSync(reposPath)
      ? fs
          .readdirSync(reposPath, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => ({ repo: entry.name }))
      : [];
    return res.json(repos);
  }
  const match = /^\/([^/]+)(\/.*)?$/.exec(req.path);
  if (!match) {
    return next();
  }
  req.url = `/api/v1/repos/${match[1]}${match[2] || ""}`;
  return app.handle(req, res);
});
app.get("/api/v1/repos", requireAuthentication, requireScope("repo:read"), listOwnRepos);
app.post("/api/v1/repos/:repo", requireAuthentication, requireScope("repo:write"), createRepo);

// Repository operations - all use :repo only, no owner in route
app.get("/api/v1/repos/:repo/log", requireAuthentication, requireScope("repo:read"), async (req, res) => {
  getRepoLog(req, res);
});
app.get("/api/v1/repos/:repo/tree", requireAuthentication, requireScope("repo:read"), async (req, res) => {
  getRepoTree(req, res);
});
app.get("/api/v1/repos/:repo/file", requireAuthentication, requireScope("repo:read"), async (req, res) => {
  getRepoFile(req, res);
});
app.post("/api/v1/repos/:repo/files", requireAuthentication, requireScope("repo:write"), uploadRepoFile);
app.get("/api/v1/repos/:repo/branches", requireAuthentication, requireScope("repo:read"), async (req, res) => {
  getRepoBranches(req, res);
});
app.get("/api/v1/repos/:repo/tags", requireAuthentication, requireScope("repo:read"), async (req, res) => {
  getRepoTags(req, res);
});
app.get("/api/v1/repos/:repo/history", requireAuthentication, requireScope("repo:read"), async (req, res) => {
  getRepoHistory(req, res);
});
app.post("/api/v1/repos/:repo/stage", requireAuthentication, requireScope("repo:write"), async (req, res) => {
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
app.post("/api/v1/repos/:repo/unstage", requireAuthentication, requireScope("repo:write"), async (req, res) => {
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
app.post("/api/v1/repos/:repo/commit", requireAuthentication, requireScope("repo:write"), async (req, res) => {
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
    return res.json({
      message: "Changes committed successfully",
      commit: message,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});
app.post("/api/v1/repos/:repo/tags", requireAuthentication, requireScope("repo:write"), async (req, res) => {
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
app.delete("/api/v1/repos/:repo/tags/:name", requireAuthentication, requireScope("repo:write"), async (req, res) => {
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
app.post("/api/v1/repos/:repo/branches", requireAuthentication, requireScope("repo:write"), async (req, res) => {
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
app.delete(
  "/api/v1/repos/:repo/branches/:name",
  requireAuthentication,
  requireScope("repo:write"),
  async (req, res) => {
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
  },
);

app.get("/api/v1/profile/alias", requireAuthentication, (req, res) => res.json({ alias: aliases.get(req.user.sub) }));
app.put("/api/v1/profile/alias", requireAuthentication, (req, res) => {
  const supplied = typeof req.body === "string" ? req.body : req.body?.alias;
  const username = getOidcUsername(req.user);
  if (!username || !aliases.validAlias(username)) {
    return res.status(428).json({
      error: "Set a valid username in your OIDC profile before registering a Git Store URL.",
      profileUrl: getOidcProfileUrl(),
    });
  }
  if (supplied !== undefined && supplied !== username) {
    return res.status(400).json({ error: "The alias must exactly match your immutable OIDC username" });
  }
  const existingAlias = aliases.get(req.user.sub);
  if (existingAlias && existingAlias !== username) {
    return res.status(409).json({ error: "The OIDC username differs from the immutable registered username" });
  }
  const result = aliases.assign(req.user.sub, username);
  if (result === false) {
    return res.status(409).json({ error: "Alias is already assigned" });
  }
  if (result === null) {
    return res.status(409).json({ error: "Alias cannot be changed" });
  }
  return res.json({ alias: result.alias });
});

// Registered after direct routes: alias paths are normalized once and then
// handled by the same scoped handlers, with no recursive alias dispatch.
app.use("/api/v1/repos/:alias", (req, res, next) => {
  if (req.aliasDispatch) {
    return next();
  }
  return requireAuthentication(req, res, () => {
    const owner = aliases.owner(req.params.alias);
    if (!owner || owner !== getHashedSubjectDir(req)) {
      return res.status(404).json({ error: "Repository not found" });
    }
    req.aliasRouteAuthenticated = true;
    req.aliasDispatch = true;
    req.url = `/api/v1/repos${req.url}`;
    return app.handle(req, res);
  });
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
    content: {
      "application/json": { schema: { type: "object", properties, required } },
    },
  });
  const unauthorized = { description: "Unauthorized" };
  const notFound = { description: "Repository not found" };
  const operation = (summary, responses, body, parameters = pathParametersRepo) => {
    const protectedOperation =
      parameters.some(({ name }) => name === "repo" || name === "alias") || summary.includes("authenticated subject");
    const readOperation = /^(Fetch|Get file|List|Read)/.test(summary);
    const result = {
      summary,
      parameters,
      ...(body ? { requestBody: body } : {}),
      responses,
    };
    if (protectedOperation) {
      result.security = [{ bearerAuth: [] }];
      result["x-required-scope"] = readOperation ? "repo:read or repo:write" : "repo:write";
      result.responses = {
        ...responses,
        401: unauthorized,
        403: { description: "Insufficient scope" },
      };
    }
    return result;
  };

  const apiSpec = {
    openapi: "3.0.3",
    info: { title: "Git Store API", version: "1.0.0" },
    servers: [{ url: "/", description: "This git store server" }],
    paths: {
      "/api/v1/health": {
        get: operation("Health check", { 200: { description: "Healthy" } }, null, []),
      },
      "/api/v1/openapi.json": {
        get: operation("Get this OpenAPI document", { 200: { description: "OpenAPI document" } }, null, []),
      },
      "/api/v1/orgs": {
        get: {
          ...operation(
            "List organizations owned by the authenticated subject",
            {
              200: { description: "Organization list" },
              401: unauthorized,
              403: { description: "Insufficient scope" },
            },
            null,
            [],
          ),
          security: [{ bearerAuth: [] }],
          "x-required-scope": "repo:read or repo:write",
        },
        post: {
          ...operation(
            "Create an organization for the authenticated subject",
            {
              201: { description: "Created" },
              400: { description: "Invalid organization slug" },
              409: { description: "Organization already exists" },
              401: unauthorized,
              403: { description: "Insufficient scope" },
            },
            jsonBody({ slug: { type: "string" }, name: { type: "string" } }, []),
            [],
          ),
          security: [{ bearerAuth: [] }],
          "x-required-scope": "repo:write",
        },
      },
      "/api/v1/orgs/{org}/repos": {
        get: {
          ...operation(
            "List repositories in an owned organization",
            {
              200: { description: "Repository list" },
              401: unauthorized,
              403: { description: "Insufficient scope" },
              404: { description: "Organization not found" },
            },
            null,
            [{ name: "org", in: "path", required: true, schema: { type: "string" } }],
          ),
          security: [{ bearerAuth: [] }],
          "x-required-scope": "repo:read or repo:write",
        },
      },
      "/api/v1/repos": {
        get: operation(
          "List repositories owned by the authenticated subject",
          { 200: { description: "Repository list" }, 401: unauthorized },
          null,
          [],
        ),
      },
      "/api/v1/profile/alias": {
        get: {
          ...operation(
            "Get the authenticated user's immutable alias",
            { 200: { description: "Alias or null" }, 401: unauthorized },
            null,
            [],
          ),
          security: [{ bearerAuth: [] }],
        },
        put: {
          ...operation(
            "Set the authenticated user's immutable alias",
            {
              200: { description: "Alias assigned" },
              400: { description: "Submitted alias differs from the OIDC username" },
              409: { description: "Alias is assigned or unavailable" },
              428: { description: "A valid OIDC username must be set first" },
              401: unauthorized,
            },
            jsonBody({ alias: { type: "string" } }, []),
            [],
          ),
          security: [{ bearerAuth: [] }],
        },
      },
      "/api/v1/repos/{alias}": {
        get: operation(
          "List repositories for the authenticated alias owner",
          { 200: { description: "Repository list" }, 404: notFound },
          null,
          [
            {
              name: "alias",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
        ),
      },
      "/api/v1/repos/{alias}/{repo}/log": {
        get: operation(
          "Fetch an alias-qualified repository log",
          { 200: { description: "Commit array" }, 404: notFound },
          null,
          [
            {
              name: "alias",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "repo",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
        ),
      },
      "/git/{repo}.git/info/refs": {
        get: {
          summary: "Advertise Git transport refs",
          parameters: [
            ...pathParametersRepo,
            {
              name: "service",
              in: "query",
              required: true,
              schema: {
                type: "string",
                enum: ["git-upload-pack", "git-receive-pack"],
              },
            },
          ],
          security: [{ basicGitToken: [] }],
          responses: {
            200: { description: "Git Smart HTTP service advertisement" },
            401: { description: "Missing or invalid Basic credentials" },
            403: { description: "Insufficient scope" },
            404: notFound,
          },
        },
      },
      "/git/{repo}.git/git-upload-pack": {
        post: {
          summary: "Fetch Git objects using Smart HTTP",
          parameters: pathParametersRepo,
          security: [{ basicGitToken: [] }],
          requestBody: {
            required: true,
            content: {
              "application/x-git-upload-pack-request": {
                schema: { type: "string", format: "binary" },
              },
            },
          },
          responses: {
            200: { description: "Git pack response" },
            401: { description: "Missing or invalid Basic credentials" },
            403: { description: "Insufficient scope" },
            404: notFound,
          },
        },
      },
      "/git/{repo}.git/git-receive-pack": {
        post: {
          summary: "Push Git objects using Smart HTTP",
          parameters: pathParametersRepo,
          security: [{ basicGitToken: [] }],
          requestBody: {
            required: true,
            content: {
              "application/x-git-receive-pack-request": {
                schema: { type: "string", format: "binary" },
              },
            },
          },
          responses: {
            200: { description: "Git push response" },
            401: { description: "Missing or invalid Basic credentials" },
            403: { description: "Insufficient scope" },
            404: notFound,
          },
        },
      },
      "/api/v1/repos/{repo}": {
        post: operation(
          "Create a repository for the authenticated subject",
          {
            201: { description: "Created" },
            400: { description: "Invalid repository name" },
            401: unauthorized,
          },
          null,
          pathParametersRepo,
        ),
      },
      "/api/v1/repos/{repo}/log": {
        get: operation(
          "Fetch the repository log",
          { 200: { description: "Commit array" }, 404: notFound },
          null,
          pathParametersRepo,
        ),
      },
      "/api/v1/repos/{repo}/stage": {
        post: operation(
          "Stage files",
          { 200: { description: "Staged" }, 401: unauthorized, 404: notFound },
          jsonBody({ files: { type: "array", items: { type: "string" } } }, ["files"]),
        ),
      },
      "/api/v1/repos/{repo}/unstage": {
        post: operation(
          "Unstage files",
          {
            200: { description: "Unstaged" },
            401: unauthorized,
            404: notFound,
          },
          jsonBody({ files: { type: "array", items: { type: "string" } } }, ["files"]),
        ),
      },
      "/api/v1/repos/{repo}/commit": {
        post: operation(
          "Commit staged changes",
          {
            200: { description: "Committed or no changes" },
            401: unauthorized,
            404: notFound,
          },
          jsonBody({ message: { type: "string" } }),
        ),
      },
      "/api/v1/repos/{repo}/tags": {
        get: operation(
          "List repository tags",
          { 200: { description: "Tags" }, 404: notFound },
          null,
          pathParametersRepo,
        ),
        post: operation(
          "Add a tag",
          {
            200: { description: "Tag added" },
            401: unauthorized,
            404: notFound,
          },
          jsonBody({ name: { type: "string" } }, ["name"]),
        ),
      },
      "/api/v1/repos/{repo}/tags/{name}": {
        delete: operation(
          "Remove a tag",
          {
            200: { description: "Tag removed" },
            401: unauthorized,
            404: notFound,
          },
          null,
          [
            ...pathParametersRepo,
            {
              name: "name",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
        ),
      },
      "/api/v1/repos/{repo}/branches": {
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
      "/api/v1/repos/{repo}/branches/{name}": {
        delete: operation(
          "Remove a branch",
          {
            200: { description: "Branch removed" },
            401: unauthorized,
            404: notFound,
          },
          null,
          [
            ...pathParametersRepo,
            {
              name: "name",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
        ),
      },
      "/api/v1/repos/{repo}/tree": {
        get: operation(
          "List repository files",
          { 200: { description: "Repository tree" }, 404: notFound },
          null,
          pathParametersRepo,
        ),
      },
      "/api/v1/repos/{repo}/file": {
        get: operation(
          "Read a repository file",
          {
            200: { description: "File contents" },
            400: { description: "Invalid path" },
            404: notFound,
          },
          null,
          [
            ...pathParametersRepo,
            {
              name: "path",
              in: "query",
              required: true,
              schema: { type: "string" },
            },
          ],
        ),
      },
      "/api/v1/repos/{repo}/files": {
        post: operation(
          "Upload an unstaged file",
          {
            201: { description: "File written" },
            400: { description: "Invalid file" },
            401: unauthorized,
            404: notFound,
          },
          jsonBody(
            {
              path: { type: "string" },
              content: { type: "string", description: "Base64-encoded bytes" },
            },
            ["path", "content"],
          ),
        ),
      },
      "/api/v1/repos/{repo}/history": {
        get: operation(
          "List file history",
          {
            200: { description: "Commit history" },
            400: { description: "Invalid path" },
            404: notFound,
          },
          null,
          [
            ...pathParametersRepo,
            {
              name: "path",
              in: "query",
              required: true,
              schema: { type: "string" },
            },
          ],
        ),
      },
    },
    components: {
      securitySchemes: {
        cookieSession: {
          type: "apiKey",
          in: "cookie",
          name: sessionCookieName,
          description: "HttpOnly OIDC browser session established by /ui/auth/callback",
        },
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "OIDC access token",
          description: "Active OIDC access token. repo:write also grants repository reads.",
        },
        basicGitToken: {
          type: "http",
          scheme: "basic",
          description: "Arbitrary username; OIDC access token as the password. repo:read fetches, repo:write pushes.",
        },
      },
    },
  };

  apiSpec.paths["/api"] = {
    get: operation("Get this OpenAPI document", { 200: { description: "OpenAPI document" } }, null, []),
  };
  const organizationRepoPrefix = "/api/v1/orgs/{org}/repos";
  for (const [route, methods] of Object.entries(apiSpec.paths)) {
    if (route.startsWith("/api/v1/repos/{repo}")) {
      const suffix = route.slice("/api/v1/repos/{repo}".length);
      apiSpec.paths[`${organizationRepoPrefix}/{repo}${suffix}`] = Object.fromEntries(
        Object.entries(methods).map(([method, definition]) => [
          method,
          {
            ...definition,
            parameters: [
              { name: "org", in: "path", required: true, schema: { type: "string" } },
              ...(definition.parameters || []),
            ],
            security: [{ bearerAuth: [] }],
            "x-required-scope": definition["x-required-scope"] || "repo:read or repo:write",
            responses: {
              401: unauthorized,
              403: { description: "Insufficient scope" },
              404: { description: "Organization or repository not found" },
              ...definition.responses,
            },
          },
        ]),
      );
    }
  }

  const aliasParameter = {
    name: "alias",
    in: "path",
    required: true,
    schema: { type: "string" },
  };
  for (const [route, methods] of Object.entries(apiSpec.paths)) {
    const repoRoutePrefix = "/api/v1/repos/{repo}";
    if (route === repoRoutePrefix || route.startsWith(`${repoRoutePrefix}/`)) {
      const aliasRoute = route.replace(repoRoutePrefix, "/api/v1/repos/{alias}/{repo}");
      apiSpec.paths[aliasRoute] = Object.fromEntries(
        Object.entries(methods).map(([method, definition]) => [
          method,
          {
            ...definition,
            parameters: [aliasParameter, ...(definition.parameters || [])],
            responses: {
              404: notFound,
              ...definition.responses,
            },
          },
        ]),
      );
    }
    const gitRoutePrefix = "/git/{repo}.git";
    if (route.startsWith(`${gitRoutePrefix}/`)) {
      const aliasRoute = route.replace(gitRoutePrefix, "/git/{alias}/{repo}.git");
      apiSpec.paths[aliasRoute] = Object.fromEntries(
        Object.entries(methods).map(([method, definition]) => [
          method,
          {
            ...definition,
            parameters: [aliasParameter, ...(definition.parameters || [])],
          },
        ]),
      );
    }
  }

  return apiSpec;
}

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
}

module.exports = app;
