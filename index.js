import express from "express";
import * as simpleGit from "simple-git";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as oidc from "openid-client";
import { createOidcConfigurations } from "./oidc-client.js";
import { validateRepoName, getSubjectHash } from "./storage.js";
import * as organizations from "./organizations.js";
import { createDatabaseClient, createAuditStore, createTokenFingerprint } from "./audit.js";
import { PersonalAccessTokenStore, normalizeTokenExpiry } from "./personal-access-tokens.js";
import {
  createWebhookStore,
  deliver as deliverWebhook,
  events as webhookEvents,
  validateTarget,
  getEncryptionKey,
  MAX_SUBSCRIPTIONS,
} from "./webhooks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const getGit = (repoPath) => simpleGit.simpleGit(repoPath);

const app = express();
app.locals.auditStore = createAuditStore(createDatabaseClient(process.env.DATABASE_URL, process.env.DB_AUTH_TOKEN));
app.locals.webhookStore = createWebhookStore(
  createDatabaseClient(process.env.DATABASE_URL, process.env.DB_AUTH_TOKEN),
  getEncryptionKey(process.env.WEBHOOK_ENCRYPTION_KEY),
);
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.set("X-Request-Id", req.requestId);
  res.once("finish", () => {
    if (res.statusCode >= 400 && !req.auditFailureRecorded) {
      auditSecurityFailure(req, "security.request.denied", {
        status: res.statusCode,
      });
    }
  });
  next();
});
app.use(express.json({ limit: "20mb" }));
app.get("/", (req, res) => {
  const query = req.url.slice(1);
  return res.redirect(302, `/ui/${query}`);
});
const PORT = process.env.PORT || 3000;

// OpenID Discovery and Authentication Setup
let oidcClient;
let oidcIntrospectionClient;
let oidcReady = false;
const browserSessions = new Map();
const browserSessionRefreshes = new Map();
const sessionCookieName = "git_store_session";
const browserSessionStorePath = process.env.DATA_PATH ? path.join(process.env.DATA_PATH, ".browser-sessions") : null;
const personalAccessTokens = new PersonalAccessTokenStore(
  path.join(process.env.DATA_PATH, "personal-access-tokens.json"),
);
const browserSessionMaxAge = 30 * 24 * 60 * 60 * 1000;
const accessTokenRefreshSkew = 60 * 1000;

// Tests may install an in-process token verifier on app.locals before serving.
// This is not an HTTP feature: production requests always use OIDC validation.

async function initializeOidc() {
  if (!process.env.OIDC_ISSUER || !process.env.OIDC_CLIENT_ID || !process.env.OIDC_CLIENT_SECRET) {
    return;
  }
  try {
    const discovered = await oidc.discovery(
      new URL(process.env.OIDC_ISSUER),
      process.env.OIDC_CLIENT_ID,
      process.env.OIDC_CLIENT_SECRET,
      oidc.ClientSecretPost(process.env.OIDC_CLIENT_SECRET),
    );
    const configurations = createOidcConfigurations(discovered.serverMetadata(), {
      clientId: process.env.OIDC_CLIENT_ID,
      clientSecret: process.env.OIDC_CLIENT_SECRET,
      jwksUri: process.env.OIDC_JWKS_URI,
    });
    oidcClient = configurations.oidc;
    oidcIntrospectionClient = configurations.introspection;
    oidcReady = true;
  } catch {
    oidcReady = false;
  }
}
initializeOidc();

function auditOrgFromRequest(req) {
  const slug = req.organization?.slug || req.organizationSlug || req.params?.org;
  return typeof slug === "string" && organizations.get(slug) ? organizations.get(slug).slug : null;
}

async function recordAuditEvent(req, event, object = "", details = {}, org = auditOrgFromRequest(req)) {
  const store = app.locals.auditStore;
  if (!store || !org) {
    return;
  }
  const personalToken =
    req.authType === "personal-access-token"
      ? personalAccessTokens.listForOwner(req.user.ownerHash).find((token) => token.id === req.user.tokenId)
      : null;
  const actorName =
    personalToken?.label ||
    [req.user?.name, req.user?.preferred_username, req.user?.profile?.name].find(
      (value) => typeof value === "string" && value.trim(),
    );
  try {
    await store.append({
      org,
      issuer: process.env.OIDC_ISSUER || null,
      subject: typeof req.user?.sub === "string" ? req.user.sub : null,
      actorName: actorName?.trim().slice(0, 200) || null,
      event,
      object,
      origin: req.authType || (req.auditToken ? "token" : "unknown"),
      tokenFingerprint: createTokenFingerprint(req.auditToken, process.env.OIDC_CLIENT_SECRET),
      requestId: req.requestId,
      ipAddress: req.socket?.remoteAddress || null,
      userAgent: req.get?.("user-agent") || null,
      details,
    });
  } catch (error) {
    process.stderr.write(`[audit] event persistence failed: ${error.message}\n`);
  }
  if (webhookEvents.has(event) && app.locals.webhookStore) {
    void deliverWebhook(app.locals.webhookStore, {
      id: crypto.randomUUID(),
      org,
      event,
      occurredAt: new Date().toISOString(),
      object,
      details,
    }).catch((error) => process.stderr.write(`[webhooks] delivery failed: ${error.message}\n`));
  }
}

function auditSecurityFailure(req, event, details = {}) {
  req.auditFailureRecorded = true;
  void recordAuditEvent(req, event, req.path, {
    method: req.method,
    ...details,
  });
}

function getOidcClient() {
  return app.locals.oidcClientOverride || (oidcReady ? oidcClient : null);
}

function callOidcOperation(client, operation, ...args) {
  if (client === app.locals.oidcClientOverride) {
    if (typeof client?.[operation] !== "function") {
      throw new Error(`OIDC test client does not implement ${operation}`);
    }
    return client[operation](...args);
  }
  return oidc[operation](client, ...args);
}

function getTokenExpiresIn(tokenSet) {
  const value = typeof tokenSet?.expiresIn === "function" ? tokenSet.expiresIn() : Number(tokenSet?.expires_in);
  return Number(value);
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

function browserSessionStoreKey() {
  const secret = process.env.OIDC_CLIENT_SECRET;
  return secret ? crypto.createHash("sha256").update("git-store-browser-sessions\0").update(secret).digest() : null;
}

function isValidBrowserSession(session) {
  return (
    session &&
    typeof session.sub === "string" &&
    typeof session.scope === "string" &&
    (session.accessTokenExpiresAt === undefined ||
      (Number.isFinite(session.accessTokenExpiresAt) && session.accessTokenExpiresAt > 0)) &&
    (session.refreshToken === undefined ||
      (typeof session.refreshToken === "string" && session.refreshToken.length > 0)) &&
    Number.isFinite(session.expiresAt) &&
    session.expiresAt > Date.now() &&
    session.profile &&
    typeof session.profile === "object"
  );
}

function loadBrowserSessions() {
  browserSessions.clear();
  const key = browserSessionStoreKey();
  if (!browserSessionStorePath || !key) {
    return;
  }

  try {
    const stored = JSON.parse(fs.readFileSync(browserSessionStorePath, "utf8"));
    if (stored.version !== 1 || typeof stored.iv !== "string" || typeof stored.tag !== "string") {
      return;
    }
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(stored.iv, "base64url"));
    decipher.setAuthTag(Buffer.from(stored.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(stored.data, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const sessions = JSON.parse(plaintext);
    if (!Array.isArray(sessions)) {
      return;
    }
    for (const [id, session] of sessions) {
      if (typeof id === "string" && isValidBrowserSession(session)) {
        browserSessions.set(id, session);
      }
    }
  } catch {
    // A missing or invalid store fails closed; a successful OIDC callback will replace it.
  }
}

function persistBrowserSessions() {
  const key = browserSessionStoreKey();
  if (!browserSessionStorePath || !key) {
    return;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const sessions = [...browserSessions.entries()].filter(([, session]) => isValidBrowserSession(session));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(sessions), "utf8"), cipher.final()]);
  const stored = JSON.stringify({
    version: 1,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    data: encrypted.toString("base64url"),
  });
  fs.mkdirSync(path.dirname(browserSessionStorePath), {
    recursive: true,
    mode: 0o700,
  });
  const temporaryPath = `${browserSessionStorePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temporaryPath, stored, { mode: 0o600 });
  fs.renameSync(temporaryPath, browserSessionStorePath);
}

async function refreshBrowserSession(id, session) {
  const existingRefresh = browserSessionRefreshes.get(id);
  if (existingRefresh) {
    return existingRefresh;
  }
  const client = getOidcClient();
  if (!client || !session.refreshToken) {
    return null;
  }

  const refresh = Promise.resolve().then(async () => {
    const tokenSet = await callOidcOperation(client, "refreshTokenGrant", session.refreshToken);
    const accessToken = tokenSet.access_token;
    const idClaims = typeof tokenSet.claims === "function" ? tokenSet.claims() : null;
    const expiresIn = getTokenExpiresIn(tokenSet);
    if (
      typeof accessToken !== "string" ||
      !accessToken ||
      typeof idClaims?.sub !== "string" ||
      idClaims.sub !== session.sub ||
      !Number.isFinite(expiresIn) ||
      expiresIn <= 0
    ) {
      throw new Error("OIDC refresh response did not match the browser session");
    }

    const now = Date.now();
    const refreshedSession = {
      ...session,
      accessTokenExpiresAt: now + expiresIn * 1000,
      expiresAt: now + browserSessionMaxAge,
      refreshToken:
        typeof tokenSet.refresh_token === "string" && tokenSet.refresh_token
          ? tokenSet.refresh_token
          : session.refreshToken,
    };
    browserSessions.set(id, refreshedSession);
    persistBrowserSessions();
    return { id, ...refreshedSession };
  });
  browserSessionRefreshes.set(id, refresh);
  try {
    return await refresh;
  } finally {
    if (browserSessionRefreshes.get(id) === refresh) {
      browserSessionRefreshes.delete(id);
    }
  }
}

function renewBrowserSessionCookie(req, res, session) {
  if (!res) {
    return;
  }
  try {
    const redirectUri = getOidcRedirectUri(req);
    const maxAge = Math.max(0, session.expiresAt - Date.now());
    res.cookie(sessionCookieName, `${session.id}.${signSessionId(session.id)}`, cookieOptions(redirectUri, maxAge));
    res.set("Cache-Control", "no-store");
  } catch {
    // A refreshed in-memory session remains usable even if this request cannot renew its cookie.
  }
}

async function getBrowserSession(req, res, { refresh = true } = {}) {
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
  let session = browserSessions.get(id);
  if (!session || session.expiresAt <= Date.now()) {
    browserSessions.delete(id);
    try {
      persistBrowserSessions();
    } catch {
      // The expired session is removed from memory even if the encrypted store cannot be updated.
    }
    return null;
  }

  const accessTokenExpiresAt = Number.isFinite(session.accessTokenExpiresAt)
    ? session.accessTokenExpiresAt
    : session.expiresAt;
  if (refresh && session.refreshToken && accessTokenExpiresAt <= Date.now() + accessTokenRefreshSkew) {
    try {
      const refreshedSession = await refreshBrowserSession(id, session);
      if (refreshedSession) {
        session = refreshedSession;
        renewBrowserSessionCookie(req, res, session);
      }
    } catch {
      // Keep a still-valid access session during transient refresh failures; expired sessions fail closed below.
      const updatedSession = browserSessions.get(id);
      if (updatedSession && updatedSession !== session) {
        session = updatedSession;
        renewBrowserSessionCookie(req, res, { id, ...session });
      }
    }
  }
  const currentAccessTokenExpiresAt = Number.isFinite(session.accessTokenExpiresAt)
    ? session.accessTokenExpiresAt
    : session.expiresAt;
  if (currentAccessTokenExpiresAt <= Date.now()) {
    browserSessions.delete(id);
    try {
      persistBrowserSessions();
    } catch {
      // The expired session is removed from memory even if the encrypted store cannot be updated.
    }
    return null;
  }
  return { id, ...session };
}

loadBrowserSessions();
app.locals.reloadBrowserSessions = loadBrowserSessions;

app.get(["/ui/", "/ui/index.html"], async (req, res, next) => {
  let html;
  try {
    html = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
  } catch (error) {
    return next(error);
  }
  const session = await getBrowserSession(req, res);
  // Keep the ternary object's indentation aligned with the project's ESLint rule.
  // prettier-ignore
  const bootstrap = session
    ? {
      checked: true,
      authenticated: true,
      profile: session.profile,
      canRead: session.scope.split(/\s+/).includes("repo:read") || session.scope.split(/\s+/).includes("repo:write"),
      canWrite: session.scope.split(/\s+/).includes("repo:write"),
    }
    : { checked: true, authenticated: false, profile: null, canRead: false, canWrite: false };
  const serialized = JSON.stringify({ serverSession: bootstrap }).replace(/[<>&\u2028\u2029]/g, (character) => {
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
  const bootstrapScript = `<script state>${serialized}</script>`;
  res.set("Cache-Control", "no-store");
  return res.type("html").send(html.replace('<script state>{"serverSession": null}</script>', bootstrapScript));
});
app.use("/ui", express.static(path.join(__dirname, "public")));

async function introspectAccessToken(token) {
  if (app.locals.verifyToken) {
    return app.locals.verifyToken(token);
  }
  if (!process.env.OIDC_ISSUER || !process.env.OIDC_CLIENT_ID || !process.env.OIDC_CLIENT_SECRET) {
    return null;
  }
  const client = app.locals.oidcClientOverride || (oidcReady ? oidcIntrospectionClient : null);
  if (!client) {
    return null;
  }
  return callOidcOperation(client, "tokenIntrospection", token, {
    token_type_hint: "access_token",
  });
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
  // Check for Bearer token in Authorization header
  const header = req.headers.authorization || "";
  if (/^Bearer\s+/i.test(header)) {
    const token = header.slice(7).trim();
    req.auditToken = token;
    try {
      const personalToken = personalAccessTokens.authenticate(token);
      const claims = personalToken.recognized ? personalToken.claims : await introspectAccessToken(token);
      if (!claims || !claims.active) {
        auditSecurityFailure(req, "security.auth.denied", {
          reason: "inactive_token",
        });
        return res.status(401).json({ error: "Unauthorized: inactive token" });
      }
      if (typeof claims.sub !== "string" || !claims.sub.trim()) {
        auditSecurityFailure(req, "security.auth.denied", {
          reason: "missing_subject",
        });
        return res.status(401).json({ error: "Unauthorized: missing subject claim" });
      }
      req.user = claims;
      req.authType = personalToken.recognized ? "personal-access-token" : "bearer";
      return next();
    } catch {
      auditSecurityFailure(req, "security.auth.denied", {
        reason: "invalid_token",
      });
      return res.status(401).json({ error: "Unauthorized: invalid token" });
    }
  }

  // Browser sessions use a signed cookie backed by an encrypted subject/scope snapshot and
  // optional rotating refresh token. Access tokens are never retained after sign-in.
  const session = isSameOriginRequest(req) ? await getBrowserSession(req, res) : null;
  if (session && isSameOriginRequest(req)) {
    req.user = {
      sub: session.sub,
      scope: session.scope,
      active: true,
      profile: session.profile,
    };
    req.authType = "session";
    return next();
  }

  auditSecurityFailure(req, "security.auth.denied", {
    reason: "missing_or_invalid_credentials",
  });
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

function getAuthenticatedSubjectHash(req) {
  return req.authType === "personal-access-token" ? req.user.ownerHash : getSubjectHash(req);
}

function tokenResourceAllowsRequest(req) {
  if (req.authType !== "personal-access-token" || !req.user.tokenResource?.repo) {
    return true;
  }
  const org = req.organizationSlug || req.organization?.slug || req.params?.org;
  return org === req.user.tokenResource.org && req.params?.repo === req.user.tokenResource.repo;
}

function sanitizeUserProfile(profile, subject) {
  const safeProfile = { sub: subject };
  for (const key of ["id", "name", "email", "picture", "avatar", "avatar_url", "image", "photo"]) {
    if (typeof profile?.[key] === "string") {
      safeProfile[key] = profile[key];
    }
  }
  return safeProfile;
}

function requireScope(scope) {
  return (req, res, next) => {
    const scopes = getTokenScopes(req.user);
    const allowed =
      scope === "repo:read" ? scopes.has("repo:read") || scopes.has("repo:write") : scopes.has("repo:write");
    if (!tokenResourceAllowsRequest(req)) {
      auditSecurityFailure(req, "security.access.denied", {
        reason: "token_resource_mismatch",
      });
      return res.status(403).json({
        error: "Forbidden: token is restricted to a different repository",
      });
    }
    if (!allowed) {
      auditSecurityFailure(req, "security.access.denied", {
        reason: "insufficient_scope",
        requiredScope: scope,
      });
      return res.status(403).json({ error: `Forbidden: requires ${scope} scope` });
    }
    return next();
  };
}

function requireGitBasicAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const match = /^Basic\s+([A-Za-z0-9+/]+=*)$/i.exec(header);
  if (!match) {
    auditSecurityFailure(req, "security.auth.denied", {
      reason: "missing_git_credentials",
    });
    res.set("WWW-Authenticate", 'Basic realm="GitMini", charset="UTF-8"');
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
    auditSecurityFailure(req, "security.auth.denied", {
      reason: "missing_git_token",
    });
    res.set("WWW-Authenticate", 'Basic realm="GitMini", charset="UTF-8"');
    return res.status(401).send("Git HTTP authentication required");
  }
  req.auditToken = token;
  const personalToken = personalAccessTokens.authenticate(token);
  Promise.resolve(personalToken.recognized ? personalToken.claims : introspectAccessToken(token))
    .then((claims) => {
      if (!claims?.active || typeof claims.sub !== "string" || !claims.sub.trim()) {
        auditSecurityFailure(req, "security.auth.denied", {
          reason: claims?.active ? "missing_subject" : "inactive_token",
        });
        res.set("WWW-Authenticate", 'Basic realm="GitMini", charset="UTF-8"');
        return res.status(401).send("Invalid Git credentials");
      }
      req.user = claims;
      req.authType = personalToken.recognized ? "personal-access-token" : "git-token";
      return next();
    })
    .catch(() => {
      auditSecurityFailure(req, "security.auth.denied", {
        reason: "invalid_token",
      });
      res.set("WWW-Authenticate", 'Basic realm="GitMini", charset="UTF-8"');
      return res.status(401).send("Invalid Git credentials");
    });
}

async function readRepositoryRefs(repoPath) {
  const stdout = await getGit(repoPath).raw(["for-each-ref", "--format=%(refname)%00%(objectname)"]);
  return new Map(
    stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("\0");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

async function gitSmartHttp(req, res) {
  const match =
    /^\/git\/([A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?)\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(
      req.path,
    );
  if (!match || !validateRepoName(match[2]) || Object.keys(req.query).some((key) => key !== "service")) {
    return res.status(400).send("Malformed Git request");
  }
  const orgSlug = match[1];
  const repo = match[2];
  const operation = match[3];
  const subjectHash = getAuthenticatedSubjectHash(req);
  const organization = organizations.get(orgSlug);
  if (!organization || organization.ownerHash !== subjectHash) {
    auditSecurityFailure(req, "security.access.denied", {
      reason: "organization_not_accessible",
    });
    return res.status(404).send("Repository not found");
  }
  req.organization = organization;
  req.organizationSlug = organization.slug;
  if (
    req.authType === "personal-access-token" &&
    req.user.tokenResource?.repo &&
    (req.user.tokenResource.org !== organization.slug || req.user.tokenResource.repo !== repo)
  ) {
    auditSecurityFailure(req, "security.access.denied", {
      reason: "token_resource_mismatch",
    });
    return res.status(403).send("Token is restricted to a different repository");
  }
  const repoRoot = path.join(process.env.DATA_PATH, "orgs", organization.slug);
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
    if (write) {
      auditSecurityFailure(req, "security.access.denied", {
        reason: "insufficient_scope",
        requiredScope: "repo:write",
      });
    }
    return res.status(403).send("Insufficient scope");
  }
  const repoPath = path.join(repoRoot, repo);
  if (!repoPath || !fs.existsSync(path.join(repoPath, ".git"))) {
    return res.status(404).send("Repository not found");
  }
  const isPush = operation === "git-receive-pack" && req.method === "POST";
  let refsBefore = new Map();
  if (isPush) {
    try {
      refsBefore = await readRepositoryRefs(repoPath);
    } catch (error) {
      process.stderr.write(`[audit] unable to inspect refs before push: ${error.message}\n`);
      return res.status(500).send("Unable to inspect repository refs");
    }
  }
  const queryService = operation === "info/refs" ? service : undefined;
  const env = {
    ...process.env,
    GIT_PROJECT_ROOT: path.resolve(repoRoot),
    GIT_HTTP_EXPORT_ALL: "1",
    GIT_PROTOCOL: req.get("git-protocol") || "",
    PATH_INFO: `/${repo}/.git/${operation}`,
    REQUEST_METHOD: req.method,
    QUERY_STRING: queryService ? `service=${queryService}` : "",
    CONTENT_TYPE: req.get("content-type") || "",
    CONTENT_LENGTH: req.get("content-length") || "0",
    REMOTE_USER: req.user.sub,
  };
  let requestBodyPath;
  if (req.method === "POST" && !req.get("content-length")) {
    requestBodyPath = path.join(os.tmpdir(), `gitmini-http-${crypto.randomUUID()}`);
    try {
      await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(requestBodyPath, { flags: "wx", mode: 0o600 });
        req.once("aborted", () => reject(new Error("Git request aborted")));
        file.once("error", reject);
        file.once("finish", resolve);
        req.pipe(file);
      });
      env.CONTENT_LENGTH = String(fs.statSync(requestBodyPath).size);
    } catch {
      try {
        fs.unlinkSync(requestBodyPath);
      } catch {
        // The request body file may not have been created.
      }
      return res.status(400).send("Unable to read Git request body");
    }
  }
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
  if (requestBodyPath) {
    const requestBody = fs.createReadStream(requestBodyPath);
    requestBody.on("error", () => child.kill());
    requestBody.pipe(child.stdin);
    child.once("close", () => {
      try {
        fs.unlinkSync(requestBodyPath);
      } catch {
        // The request body file may already have been removed.
      }
    });
  } else {
    req.pipe(child.stdin);
  }
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
    const finish = async () => {
      if (isPush && code === 0) {
        try {
          const refsAfter = await readRepositoryRefs(repoPath);
          const changedRefs = new Set([...refsBefore.keys(), ...refsAfter.keys()]);
          for (const ref of changedRefs) {
            const before = refsBefore.get(ref) || null;
            const after = refsAfter.get(ref) || null;
            if (before === after) {
              continue;
            }
            const refType = ref.startsWith("refs/heads/") ? "branch" : ref.startsWith("refs/tags/") ? "tag" : "ref";
            const action = !before ? "created" : !after ? "deleted" : "updated";
            await recordAuditEvent(req, `git.${refType}.${action}`, `${organization.slug}/${repo}@${ref}`, {
              ref,
              before,
              after,
            });
          }
        } catch (error) {
          process.stderr.write(`[audit] unable to inspect push refs: ${error.message}\n`);
        }
      }
      res.end();
    };
    void finish();
  });
}

app.all("/git/:org/:repo.git/*path", requireGitBasicAuth, gitSmartHttp);

/**
 * Safely get the repository path within the authenticated organization.
 * Validates the repo short name and requires an organization-resolved request.
 *
 * @param {string} repo - The repository short name from the route
 * @param {object} req - Express request object (must have req.user with sub)
 * @returns {string|false} The repo path if valid, or false if invalid
 */
function getSafeRepoPath(repo, req) {
  if (!validateRepoName(repo) || !req.organizationPath) {
    return false;
  }
  return path.join(req.organizationPath, repo);
}

function repositoryExists(org, repo) {
  if (!organizations.normalizeSlug(org) || !validateRepoName(repo)) {
    return false;
  }
  const repoPath = path.join(process.env.DATA_PATH, "orgs", org, repo);
  try {
    const repoStat = fs.lstatSync(repoPath);
    const gitStat = fs.lstatSync(path.join(repoPath, ".git"));
    return repoStat.isDirectory() && !repoStat.isSymbolicLink() && gitStat.isDirectory() && !gitStat.isSymbolicLink();
  } catch {
    return false;
  }
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
 * Create a repository inside an authenticated organization.
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
    if (!req.organizationPath) {
      return res.status(404).json({ error: "Organization not found" });
    }
    fs.mkdirSync(req.organizationPath, { recursive: true });
    const repoPath = path.join(req.organizationPath, repo);
    fs.mkdirSync(repoPath, { recursive: true });
    const git = getGit(repoPath);

    if (!fs.existsSync(path.join(repoPath, ".git"))) {
      await git.init(false, ["--initial-branch=main"]);
      await git.addConfig("user.name", "GitMini");
      await git.addConfig("user.email", "gitmini@local");
    }

    // Also repair repositories created before this setting was applied.
    // GitMini serves a working tree, so pushes to its checked-out branch must
    // update that tree rather than being rejected by denyCurrentBranch.
    await git.addConfig("receive.denyCurrentBranch", "updateInstead");

    await recordAuditEvent(req, "repository.created", `${req.organization.slug}/${repo}`);
    return res.status(201).json({ message: `Repository ${repo} is ready`, repo });
  } catch (error) {
    const code = typeof error.code === "string" ? error.code : "REPO_INITIALIZATION_FAILED";
    process.stderr.write(`[repo-create] ${code}\n`);
    return res.status(500).json({ error: "Repository creation failed", code });
  }
}

async function deleteRepo(req, res) {
  const repo = req.params.repo;
  if (!validateRepoName(repo)) {
    return res.status(400).json({ error: "Invalid repository name" });
  }
  const repoPath = getSafeRepoPath(repo, req);
  if (!repoPath || !repositoryExists(req.organization.slug, repo)) {
    return res.status(404).json({ error: "Repository not found" });
  }
  try {
    const organizationRoot = fs.realpathSync(req.organizationPath);
    const realRepoPath = fs.realpathSync(repoPath);
    if (path.dirname(realRepoPath) !== organizationRoot) {
      return res.status(404).json({ error: "Repository not found" });
    }
    fs.rmSync(realRepoPath, { recursive: true, force: false });
    await recordAuditEvent(req, "repository.deleted", `${req.organization.slug}/${repo}`);
    return res.status(204).end();
  } catch {
    return res.status(500).json({ error: "Repository deletion failed" });
  }
}

/**
 * Get repository log.
 * Resolves the repo path from the authenticated organization's directory.
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

  const limit = req.query.limit;
  let logOptions;
  if (limit !== undefined) {
    if (typeof limit !== "string" || !/^[1-9]\d*$/.test(limit) || Number(limit) > 1000) {
      return res.status(400).json({ error: "Limit must be an integer between 1 and 1000." });
    }
    logOptions = { maxCount: Number(limit) };
  }

  // Check that the repo belongs to the authenticated subject
  // (the path already ensures this since we use the hashed sub)

  try {
    const log = await getGit(repoPath).log(logOptions);
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
 * Resolves the repo path from the authenticated organization's directory.
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
 * Resolves the repo path from the authenticated organization's directory.
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
    const imageTypes = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".avif": "image/avif",
      ".bmp": "image/bmp",
    };
    const detected = imageTypes[path.extname(filePath).toLowerCase()];
    if (detected) {
      res.set("X-Content-Type-Options", "nosniff");
      return res.type(detected).send(fs.readFileSync(filePath));
    }
    res.set("X-Content-Type-Options", "nosniff");
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
async function uploadRepoFile(req, res) {
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
    await recordAuditEvent(req, "repository.file.uploaded", `${req.organization.slug}/${repo}/${req.body.path}`);
    return res.status(201).json({ path: req.body.path, staged: false });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

/** Delete exactly one existing, regular repository working-tree file without staging it. */
async function deleteRepoFile(req, res) {
  const repoPath = getSafeRepoPath(req.params.repo, req);
  if (!repoPath) {
    return res.status(400).json({ error: "Invalid repository name" });
  }
  if (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, ".git"))) {
    return res.status(404).json({ error: "Repo not found" });
  }
  const relativePath = req.query.path;
  if (typeof relativePath !== "string" || !relativePath.trim()) {
    return res.status(400).json({ error: "A non-empty path is required" });
  }
  const segments = relativePath.replace(/\\/g, "/").split("/");
  if (segments.includes(".git")) {
    return res.status(400).json({ error: "Invalid path" });
  }
  const filePath = safeRepoFile(repoPath, relativePath);
  if (!filePath) {
    return res.status(400).json({ error: "Invalid path" });
  }
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      return res.status(400).json({ error: "Invalid path" });
    }
    if (!stat.isFile()) {
      return res.status(400).json({ error: "Path is not a regular file" });
    }
    fs.unlinkSync(filePath);
    await recordAuditEvent(
      req,
      "repository.file.deleted",
      `${req.organization.slug}/${req.params.repo}/${relativePath}`,
    );
    return res.json({ path: relativePath, deleted: true, staged: false });
  } catch (error) {
    if (error.code === "ENOENT") {
      return res.status(404).json({ error: "File not found" });
    }
    return res.status(500).json({ error: "File deletion failed" });
  }
}

/**
 * List repository branches.
 * Resolves the repo path from the authenticated organization's directory.
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
 * Resolves the repo path from the authenticated organization's directory.
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
 * Resolves the repo path from the authenticated organization's directory.
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

// Internal repository handlers use :repo after the organization middleware resolves ownership.

app.get("/api/v1/health", (req, res) => res.json({ status: "ok" }));
app.get("/api", (req, res) => res.json(makeApiSpec()));
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
    const browserSession = isSameOriginRequest(req) ? await getBrowserSession(req, res) : null;
    if (browserSession && isSameOriginRequest(req)) {
      res.set("Cache-Control", "no-store");
      return res.json({
        authenticated: true,
        profile: browserSession.profile,
        canRead:
          browserSession.scope.split(/\s+/).includes("repo:read") ||
          browserSession.scope.split(/\s+/).includes("repo:write"),
        canWrite: browserSession.scope.split(/\s+/).includes("repo:write"),
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
    };
    try {
      const userInfo = await callOidcOperation(getOidcClient(), "fetchUserInfo", token, claims.sub);
      if (userInfo && typeof userInfo === "object") {
        if (userInfo.sub === claims.sub) {
          profile = { ...profile, ...userInfo, sub: claims.sub };
        }
      }
    } catch {
      // Validated introspection claims still identify the authenticated session.
    }
    return res.json({
      authenticated: true,
      profile: sanitizeUserProfile(profile, claims.sub),
    });
  } catch {
    return res.json({ authenticated: false, profile: null });
  }
});

app.get("/ui/auth/login", async (req, res) => {
  const client = getOidcClient();
  if (!client) {
    return res.status(503).send("OIDC sign-in is not configured.");
  }
  try {
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const redirectUri = getOidcRedirectUri(req);
    const options = cookieOptions(redirectUri, 10 * 60 * 1000);
    res.cookie("git_oidc_state", state, options);
    res.cookie("git_oidc_verifier", codeVerifier, options);
    res.cookie("git_oidc_nonce", nonce, options);
    res.cookie("git_oidc_return", safeReturnPath(req.query.returnTo), options);
    const authorizationUrl = callOidcOperation(client, "buildAuthorizationUrl", {
      response_type: "code",
      redirect_uri: redirectUri,
      scope: "openid profile email offline_access",
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    res.set("Cache-Control", "no-store");
    return res.redirect(302, authorizationUrl.href);
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
  const nonce = cookies.git_oidc_nonce;
  const returnTo = safeReturnPath(cookies.git_oidc_return);
  clearLoginCookies(res, options);
  if (!state || !codeVerifier || !nonce || req.query.state !== state) {
    return res.status(400).send("OIDC sign-in response was invalid. Please try again.");
  }
  if (typeof req.query.error === "string") {
    return res.status(401).send("OIDC sign-in was cancelled or could not be completed. Please try again.");
  }
  if (typeof req.query.code !== "string") {
    return res.status(400).send("OIDC sign-in response was invalid. Please try again.");
  }

  let callbackStage = "authorization-code exchange and ID-token validation";
  try {
    const callbackUrl = new URL(redirectUri);
    callbackUrl.search = new URL(req.originalUrl, "http://gitmini.invalid").search;
    const tokenSet = await callOidcOperation(client, "authorizationCodeGrant", callbackUrl, {
      expectedState: state,
      pkceCodeVerifier: codeVerifier,
      expectedNonce: nonce,
    });
    const accessToken = tokenSet.access_token;
    const idClaims = typeof tokenSet.claims === "function" ? tokenSet.claims() : null;
    if (!accessToken || typeof idClaims?.sub !== "string" || !idClaims.sub.trim()) {
      return res.status(401).send("OIDC sign-in did not return a valid repository identity.");
    }

    callbackStage = "userinfo validation";
    const userInfo = await callOidcOperation(client, "fetchUserInfo", accessToken, idClaims.sub);
    if (!userInfo || typeof userInfo !== "object") {
      return res.status(401).send("OIDC sign-in could not verify the access-token profile.");
    }
    if (userInfo.sub !== idClaims.sub) {
      return res.status(401).send("OIDC sign-in subject did not match the access-token profile.");
    }
    const profile = sanitizeUserProfile(userInfo, idClaims.sub);

    const id = crypto.randomBytes(32).toString("base64url");
    const now = Date.now();
    const expiresInSeconds = getTokenExpiresIn(tokenSet);
    const accessTokenExpiresIn =
      Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
        ? expiresInSeconds * 1000
        : Number.isFinite(idClaims.exp) && idClaims.exp * 1000 > now
          ? idClaims.exp * 1000 - now
          : 3600_000;
    const refreshToken =
      typeof tokenSet.refresh_token === "string" && tokenSet.refresh_token ? tokenSet.refresh_token : null;
    const maxAge = refreshToken
      ? browserSessionMaxAge
      : Math.max(60_000, Math.min(accessTokenExpiresIn, 24 * 60 * 60 * 1000));
    const browserScopes = (process.env.OIDC_BROWSER_SCOPES || "")
      .split(/[\s,]+/)
      .filter((scope) => scope === "repo:read" || scope === "repo:write");
    browserSessions.set(id, {
      sub: idClaims.sub,
      profile,
      scope: browserScopes.join(" "),
      expiresAt: now + maxAge,
      accessTokenExpiresAt: now + accessTokenExpiresIn,
      ...(refreshToken ? { refreshToken } : {}),
    });
    try {
      persistBrowserSessions();
    } catch (error) {
      browserSessions.delete(id);
      throw error;
    }
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

app.post("/ui/auth/logout", async (req, res) => {
  const session = await getBrowserSession(req, res, { refresh: false });
  if (session) {
    browserSessions.delete(session.id);
    try {
      persistBrowserSessions();
    } catch {
      const { id, ...storedSession } = session;
      browserSessions.set(id, storedSession);
      return res.status(500).send("Unable to end the session. Please try again.");
    }
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

function requireNonPersonalAccessToken(req, res, next) {
  if (req.authType === "personal-access-token") {
    return res.status(403).json({
      error: "Personal access tokens cannot manage other personal access tokens",
    });
  }
  return next();
}

app.get("/api/v1/personal-access-tokens", requireAuthentication, requireNonPersonalAccessToken, (req, res) => {
  res.set("Cache-Control", "no-store");
  return res.json({
    tokens: personalAccessTokens.listForOwner(getAuthenticatedSubjectHash(req)),
  });
});
app.post("/api/v1/personal-access-tokens", requireAuthentication, requireNonPersonalAccessToken, async (req, res) => {
  const body = req.body || {};
  const label = typeof body.label === "string" ? body.label.trim() : "";
  const scopes = body.scopes;
  if (!label || label.length > 100 || !Array.isArray(scopes) || scopes.length !== 1) {
    return res.status(400).json({ error: "Provide a label and exactly one supported scope" });
  }
  const scope = scopes[0];
  if (scope !== "repo:read" && scope !== "repo:write") {
    return res.status(400).json({ error: "Unsupported token scope" });
  }
  const callerScopes = getTokenScopes(req.user);
  if (
    scope === "repo:write"
      ? !callerScopes.has("repo:write")
      : !callerScopes.has("repo:read") && !callerScopes.has("repo:write")
  ) {
    return res.status(403).json({ error: `Forbidden: cannot grant ${scope}` });
  }
  const expiry = normalizeTokenExpiry(body.expiresAt);
  if (!expiry.valid) {
    return res.status(400).json({ error: "Expiry must be a future calendar date or left blank" });
  }

  const hasOrg = typeof body.org === "string" && body.org.length > 0;
  const hasRepo = typeof body.repo === "string" && body.repo.length > 0;
  if (hasOrg !== hasRepo) {
    return res.status(400).json({
      error: "Repository tokens require both organization and repository",
    });
  }
  let org = null;
  let repo = null;
  const ownerHash = getAuthenticatedSubjectHash(req);
  if (hasOrg) {
    org = organizations.normalizeSlug(body.org);
    repo = body.repo;
    if (!org || !validateRepoName(repo)) {
      return res.status(400).json({ error: "Invalid organization or repository" });
    }
    const organization = organizations.get(org);
    if (!organization || organization.ownerHash !== ownerHash) {
      return res.status(404).json({ error: "Organization not found" });
    }
    if (!repositoryExists(org, repo)) {
      return res.status(404).json({ error: "Repository not found" });
    }
  }

  const created = personalAccessTokens.create({
    ownerHash,
    label,
    scopes: [scope],
    org,
    repo,
    expiresAt: expiry.expiresAt,
  });
  res.set("Cache-Control", "no-store");
  if (org) {
    await recordAuditEvent(
      req,
      "personal_access_token.created",
      `${org}/${repo}`,
      {
        tokenId: created.record.id,
        label: created.record.label,
        scopes: created.record.scopes,
        expiresAt: created.record.expiresAt,
      },
      org,
    );
  }
  return res.status(201).json(created);
});
app.delete(
  "/api/v1/personal-access-tokens/:id",
  requireAuthentication,
  requireNonPersonalAccessToken,
  async (req, res) => {
    const ownerHash = getAuthenticatedSubjectHash(req);
    const record = personalAccessTokens.listForOwner(ownerHash).find((item) => item.id === req.params.id);
    if (!record) {
      return res.status(404).json({ error: "Personal access token not found" });
    }
    if (!personalAccessTokens.revoke(req.params.id, ownerHash)) {
      return res.status(404).json({ error: "Personal access token not found" });
    }
    if (record.org && record.repo) {
      await recordAuditEvent(
        req,
        "personal_access_token.revoked",
        `${record.org}/${record.repo}`,
        {
          tokenId: record.id,
          label: record.label,
        },
        record.org,
      );
    }
    return res.status(204).end();
  },
);

// List, create, and remove organizations for the authenticated subject.
app.get("/api/v1/orgs", requireAuthentication, requireScope("repo:read"), (req, res) =>
  res.json({
    orgs: organizations.listForOwnerHash(getAuthenticatedSubjectHash(req)),
  }),
);
app.post("/api/v1/orgs", requireAuthentication, requireScope("repo:write"), async (req, res) => {
  const result = organizations.createForOwnerHash(getAuthenticatedSubjectHash(req), req.body?.slug);
  if (result === null) {
    return res.status(400).json({ error: "Invalid organization slug" });
  }
  if (result === false) {
    return res.status(409).json({ error: "Organization already exists" });
  }
  await recordAuditEvent(req, "organization.created", result.slug, {}, result.slug);
  return res.status(201).json({ org: result });
});
app.delete("/api/v1/orgs/:org", requireAuthentication, requireScope("repo:write"), async (req, res) => {
  const result = organizations.deleteEmptyForOwnerHash(getAuthenticatedSubjectHash(req), req.params.org);
  if (result === null) {
    return res.status(400).json({ error: "Invalid organization slug" });
  }
  if (result === false) {
    return res.status(404).json({ error: "Organization not found" });
  }
  if (!result.deleted) {
    return res.status(409).json({
      error: "Remove this organization's repositories before deleting it",
    });
  }
  await recordAuditEvent(req, "organization.deleted", result.slug, {}, result.slug);
  return res.status(204).end();
});
function accessibleWebhookOrg(req, res) {
  if (!organizations.normalizeSlug(req.params.org)) {
    res.status(400).json({ error: "Invalid organization slug" });
    return null;
  }
  const org = organizations.get(req.params.org);
  if (!org || org.ownerHash !== getAuthenticatedSubjectHash(req)) {
    auditSecurityFailure(req, "security.access.denied", { reason: "organization_not_accessible" });
    res.status(404).json({ error: "Organization not found" });
    return null;
  }
  return org;
}
app.get("/api/v1/orgs/:org/webhooks", requireAuthentication, requireScope("repo:read"), async (req, res) => {
  const org = accessibleWebhookOrg(req, res);
  if (!org) {
    return;
  }
  if (!app.locals.webhookStore) {
    return res.status(503).json({ error: "Webhook storage is not configured" });
  }
  try {
    return res.json({ webhooks: await app.locals.webhookStore.list(org.slug) });
  } catch {
    return res.status(503).json({ error: "Webhook storage is temporarily unavailable" });
  }
});
app.post("/api/v1/orgs/:org/webhooks", requireAuthentication, requireScope("repo:write"), async (req, res) => {
  const org = accessibleWebhookOrg(req, res);
  if (!org) {
    return;
  }
  if (!app.locals.webhookStore) {
    return res.status(503).json({ error: "Webhook storage is not configured" });
  }
  const { url, events } = req.body || {};
  if (
    typeof url !== "string" ||
    !Array.isArray(events) ||
    !events.length ||
    events.some((event) => !webhookEvents.has(event)) ||
    new Set(events).size !== events.length ||
    !(await validateTarget(url))
  ) {
    return res
      .status(400)
      .json({ error: "Provide an HTTPS public endpoint and an allowlisted, unique event subscription" });
  }
  if ((await app.locals.webhookStore.list(org.slug)).length >= MAX_SUBSCRIPTIONS) {
    return res.status(409).json({ error: `Organization webhook limit is ${MAX_SUBSCRIPTIONS}` });
  }
  const webhook = {
    id: crypto.randomUUID(),
    org: org.slug,
    url,
    events,
    createdAt: new Date().toISOString(),
    secret: `whsec_${crypto.randomBytes(32).toString("hex")}`,
  };
  try {
    await app.locals.webhookStore.create(webhook);
    return res.status(201).json({
      webhook: { id: webhook.id, org: webhook.org, url, events, createdAt: webhook.createdAt },
      secret: webhook.secret,
    });
  } catch {
    return res.status(503).json({ error: "Webhook storage is temporarily unavailable" });
  }
});
app.delete("/api/v1/orgs/:org/webhooks/:id", requireAuthentication, requireScope("repo:write"), async (req, res) => {
  const org = accessibleWebhookOrg(req, res);
  if (!org) {
    return;
  }
  if (!app.locals.webhookStore) {
    return res.status(503).json({ error: "Webhook storage is not configured" });
  }
  try {
    if (!(await app.locals.webhookStore.remove(org.slug, req.params.id))) {
      return res.status(404).json({ error: "Webhook not found" });
    }
    return res.status(204).end();
  } catch {
    return res.status(503).json({ error: "Webhook storage is temporarily unavailable" });
  }
});
app.get("/api/v1/orgs/:org/events", requireAuthentication, requireScope("repo:read"), async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!organizations.normalizeSlug(req.params.org)) {
    return res.status(400).json({ error: "Invalid organization slug" });
  }
  const organization = organizations.get(req.params.org);
  if (!organization || organization.ownerHash !== getAuthenticatedSubjectHash(req)) {
    auditSecurityFailure(req, "security.access.denied", {
      reason: "organization_not_accessible",
    });
    return res.status(404).json({ error: "Organization not found" });
  }
  const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
  const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) {
    return res.status(400).json({
      error: "Limit must be 1–100 and offset must be a non-negative integer.",
    });
  }
  const store = app.locals.auditStore;
  if (!store) {
    return res.status(503).json({ error: "Audit event storage is not configured" });
  }
  try {
    const rows = await store.list(organization.slug, limit + 1, offset);
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit).map((event) => {
      try {
        return { ...event, details: JSON.parse(event.details || "{}") };
      } catch {
        return { ...event, details: {} };
      }
    });
    return res.json({ events, hasMore });
  } catch {
    return res.status(503).json({ error: "Audit events are temporarily unavailable" });
  }
});
app.get("/api/v1/recent", requireAuthentication, async (req, res) => {
  const ownedOrganizations = organizations.listForOwnerHash(getAuthenticatedSubjectHash(req));
  const allCommits = [];
  for (const org of ownedOrganizations) {
    const orgReposPath = path.join(process.env.DATA_PATH, "orgs", org.slug);
    if (!fs.existsSync(orgReposPath)) {
      continue;
    }
    const repoDirs = fs
      .readdirSync(orgReposPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
    for (const repoDir of repoDirs) {
      const repoPath = path.join(orgReposPath, repoDir.name);
      const gitPath = path.join(repoPath, ".git");
      if (!fs.existsSync(gitPath)) {
        continue;
      }
      try {
        const git = simpleGit.simpleGit(repoPath);
        const log = await git.log({ n: 10, strictDate: false });
        for (const commit of log.all) {
          const message = commit.message?.split(/\r?\n/, 1)[0] || "";
          allCommits.push({
            org: org.slug,
            repo: repoDir.name,
            message,
            date: commit.date || "",
          });
        }
      } catch {
        // Skip repos that can't be read
      }
    }
  }
  // Sort by date descending, take top 10
  allCommits.sort((a, b) => {
    const ad = new Date(a.date).getTime() || 0;
    const bd = new Date(b.date).getTime() || 0;
    return bd - ad;
  });
  const top10 = allCommits.slice(0, 10);
  return res.json({ recent: top10 });
});
app.use("/api/v1/orgs/:org/repos", requireAuthentication, (req, res, next) => {
  if (!organizations.normalizeSlug(req.params.org)) {
    return res.status(400).json({ error: "Invalid organization slug" });
  }
  const organization = organizations.get(req.params.org);
  if (!organization || organization.ownerHash !== getAuthenticatedSubjectHash(req)) {
    auditSecurityFailure(req, "security.access.denied", {
      reason: "organization_not_accessible",
    });
    return res.status(404).json({ error: "Organization not found" });
  }
  req.organization = organization;
  req.organizationSlug = organization.slug;
  req.organizationPath = path.join(process.env.DATA_PATH, "orgs", organization.slug);
  if (req.path === "/" || req.path === "") {
    if (req.method !== "GET") {
      return next();
    }
    if (!getTokenScopes(req.user).has("repo:read") && !getTokenScopes(req.user).has("repo:write")) {
      return res.status(403).json({ error: "Forbidden: requires repo:read scope" });
    }
    const reposPath = req.organizationPath;
    let repos = [];
    if (fs.existsSync(reposPath)) {
      repos = fs
        .readdirSync(reposPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
          repo: entry.name,
        }));
    }
    return res.json({ repos });
  }
  const match = /^\/([^/]+)(\/.*)?$/.exec(req.path);
  if (!match) {
    return next();
  }
  const queryIndex = req.url.indexOf("?");
  const query = queryIndex >= 0 ? req.url.slice(queryIndex) : "";
  req.url = `/api/v1/repos/${match[1]}${match[2] || ""}${query}`;
  return app.handle(req, res);
});
app.use("/api/v1/repos", (req, res, next) => {
  if (!req.organizationPath) {
    return res.status(404).json({ error: "Organization-scoped repository path required" });
  }
  return next();
});
app.post("/api/v1/repos/:repo", requireAuthentication, requireScope("repo:write"), createRepo);
app.delete("/api/v1/repos/:repo", requireAuthentication, requireScope("repo:write"), deleteRepo);

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
app.delete("/api/v1/repos/:repo/files", requireAuthentication, requireScope("repo:write"), deleteRepoFile);
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
    await recordAuditEvent(req, "repository.files.staged", `${req.organization.slug}/${repo}`);
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
    await recordAuditEvent(req, "repository.files.unstaged", `${req.organization.slug}/${repo}`);
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
    const result = await getGit(repoPath).commit(message);
    await recordAuditEvent(
      req,
      "repository.commit.created",
      `${req.organization.slug}/${repo}@${result.commit || "HEAD"}`,
      {
        message,
      },
    );
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
    await recordAuditEvent(
      req,
      "repository.tag.created",
      `${req.organization.slug}/${repo}@refs/tags/${req.body.name}`,
    );
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
    await recordAuditEvent(
      req,
      "repository.tag.deleted",
      `${req.organization.slug}/${repo}@refs/tags/${req.params.name}`,
    );
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
    await recordAuditEvent(
      req,
      "repository.branch.created",
      `${req.organization.slug}/${repo}@refs/heads/${req.body.name}`,
    );
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
      await recordAuditEvent(
        req,
        "repository.branch.deleted",
        `${req.organization.slug}/${repo}@refs/heads/${req.params.name}`,
      );
      return res.json({ message: `Branch ${req.params.name} removed` });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  },
);

/**
 * Generate the OpenAPI specification for organization-scoped API and Git routes.
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
      parameters.some(({ name }) => name === "repo" || name === "org") || summary.includes("authenticated subject");
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
    info: { title: "GitMini API", version: "1.0.0" },
    servers: [{ url: "/", description: "This GitMini server" }],
    paths: {
      "/api/v1/health": {
        get: operation("Health check", { 200: { description: "Healthy" } }, null, []),
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
            jsonBody(
              {
                slug: {
                  type: "string",
                  pattern: "^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$",
                },
              },
              ["slug"],
            ),
            [],
          ),
          security: [{ bearerAuth: [] }],
          "x-required-scope": "repo:write",
        },
      },
      "/api/v1/orgs/{org}": {
        delete: {
          summary: "Delete an empty organization owned by the authenticated subject",
          parameters: [
            {
              name: "org",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          security: [{ bearerAuth: [] }],
          "x-required-scope": "repo:write",
          responses: {
            204: { description: "Organization deleted" },
            400: { description: "Invalid organization slug" },
            401: unauthorized,
            403: { description: "Insufficient scope" },
            404: { description: "Organization not found" },
            409: {
              description: "Remove the organization's repositories first",
            },
          },
        },
      },
      "/api/v1/personal-access-tokens": {
        get: {
          summary: "List personal access token metadata for the authenticated subject",
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: "Token metadata without token values" },
            401: unauthorized,
            403: {
              description: "Personal access tokens cannot manage other tokens",
            },
          },
        },
        post: {
          summary: "Create a scoped personal access token, returned once",
          security: [{ bearerAuth: [] }],
          requestBody: jsonBody(
            {
              label: { type: "string", minLength: 1, maxLength: 100 },
              scopes: {
                type: "array",
                items: { type: "string", enum: ["repo:read", "repo:write"] },
                minItems: 1,
                maxItems: 1,
              },
              expiresAt: { type: "string", format: "date", nullable: true },
              org: { type: "string" },
              repo: { type: "string" },
            },
            ["label", "scopes"],
          ),
          responses: {
            201: {
              description: "Personal access token and metadata; token value is shown once",
            },
            400: { description: "Invalid label, scope, repository, or expiry" },
            401: unauthorized,
            403: {
              description: "Insufficient scope to grant the requested permissions",
            },
            404: { description: "Organization or repository not found" },
          },
        },
      },
      "/api/v1/personal-access-tokens/{id}": {
        delete: {
          summary: "Revoke a personal access token owned by the authenticated subject",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          security: [{ bearerAuth: [] }],
          responses: {
            204: { description: "Token revoked" },
            401: unauthorized,
            403: {
              description: "Personal access tokens cannot manage other tokens",
            },
            404: { description: "Personal access token not found" },
          },
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
            [
              {
                name: "org",
                in: "path",
                required: true,
                schema: { type: "string" },
              },
            ],
          ),
          security: [{ bearerAuth: [] }],
          "x-required-scope": "repo:read or repo:write",
        },
      },
      "/api/v1/orgs/{org}/events": {
        get: {
          ...operation(
            "List audit events in an owned organization",
            {
              200: { description: "Audit event stream" },
              400: { description: "Invalid pagination parameters" },
              401: unauthorized,
              403: { description: "Insufficient scope" },
              404: { description: "Organization not found" },
              503: { description: "Audit storage unavailable" },
            },
            null,
            [
              {
                name: "org",
                in: "path",
                required: true,
                schema: { type: "string" },
              },
              {
                name: "limit",
                in: "query",
                required: false,
                schema: { type: "integer", minimum: 1, maximum: 100 },
              },
              {
                name: "offset",
                in: "query",
                required: false,
                schema: { type: "integer", minimum: 0 },
              },
            ],
          ),
          security: [{ bearerAuth: [] }],
          "x-required-scope": "repo:read or repo:write",
        },
      },
      "/api/v1/orgs/{org}/webhooks": {
        get: {
          summary: "List webhook subscriptions for an owned organization",
          parameters: [{ name: "org", in: "path", required: true, schema: { type: "string" } }],
          security: [{ bearerAuth: [] }],
          "x-required-scope": "repo:read",
          responses: {
            200: { description: "Webhook subscriptions (secrets omitted)" },
            401: unauthorized,
            403: { description: "Insufficient scope" },
            404: { description: "Organization not found" },
          },
        },
        post: {
          summary: "Create a webhook subscription; secret is returned once",
          parameters: [{ name: "org", in: "path", required: true, schema: { type: "string" } }],
          security: [{ bearerAuth: [] }],
          "x-required-scope": "repo:write",
          requestBody: jsonBody(
            {
              url: { type: "string", format: "uri", description: "Public HTTPS endpoint" },
              events: {
                type: "array",
                minItems: 1,
                uniqueItems: true,
                items: { type: "string", enum: [...webhookEvents] },
              },
            },
            ["url", "events"],
          ),
          responses: {
            201: { description: "Created subscription and one-time signing secret" },
            400: { description: "Invalid URL or event subscription" },
            401: unauthorized,
            403: { description: "Insufficient scope" },
            404: { description: "Organization not found" },
          },
        },
      },
      "/api/v1/orgs/{org}/webhooks/{id}": {
        delete: {
          summary: "Delete a webhook subscription",
          parameters: [
            { name: "org", in: "path", required: true, schema: { type: "string" } },
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          security: [{ bearerAuth: [] }],
          "x-required-scope": "repo:write",
          responses: {
            204: { description: "Deleted" },
            401: unauthorized,
            403: { description: "Insufficient scope" },
            404: { description: "Organization or webhook not found" },
          },
        },
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
        delete: operation(
          "Delete a repository and its history",
          {
            204: { description: "Repository deleted" },
            400: { description: "Invalid repository name" },
            404: notFound,
          },
          null,
          pathParametersRepo,
        ),
      },
      "/api/v1/repos/{repo}/log": {
        get: operation("Fetch the repository log", { 200: { description: "Commit array" }, 404: notFound }, null, [
          ...pathParametersRepo,
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 1000 },
          },
        ]),
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
            200: {
              description:
                "UTF-8 text, or original bytes with a safe raster-image MIME type for supported image extensions",
            },
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
        delete: operation(
          "Delete an unstaged working-tree file",
          {
            200: { description: "File deleted" },
            400: { description: "Invalid path or path is not a regular file" },
            401: unauthorized,
            404: notFound,
          },
          null,
          [
            ...pathParametersRepo,
            {
              name: "path",
              in: "query",
              required: true,
              schema: { type: "string", minLength: 1 },
            },
          ],
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
          bearerFormat: "OIDC access token or GitMini personal access token",
          description: "Active OIDC access token or GitMini PAT. repo:write also grants repository reads.",
        },
        basicGitToken: {
          type: "http",
          scheme: "basic",
          description:
            "Arbitrary username; an active OIDC access token or GitMini PAT as the password. repo:read fetches, repo:write pushes.",
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
              {
                name: "org",
                in: "path",
                required: true,
                schema: { type: "string" },
              },
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

  const orgParameter = {
    name: "org",
    in: "path",
    required: true,
    schema: { type: "string" },
  };
  for (const [route, methods] of Object.entries(apiSpec.paths)) {
    const gitRoutePrefix = "/git/{repo}.git";
    if (route.startsWith(`${gitRoutePrefix}/`)) {
      const orgRoute = route.replace(gitRoutePrefix, "/git/{org}/{repo}.git");
      apiSpec.paths[orgRoute] = Object.fromEntries(
        Object.entries(methods).map(([method, definition]) => [
          method,
          {
            ...definition,
            parameters: [orgParameter, ...(definition.parameters || [])],
          },
        ]),
      );
    }
  }

  for (const route of Object.keys(apiSpec.paths)) {
    if (route.startsWith("/api/v1/repos") || route.startsWith("/git/{repo}.git/")) {
      delete apiSpec.paths[route];
    }
  }

  return apiSpec;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
}

export default app;
