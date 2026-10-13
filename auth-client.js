// Vendored from https://auth.api.apphor.de/node.mjs; refresh this file when updating the Auth client.
/**
 * Node.js client for the Auth service's OIDC and authenticated API endpoints.
 * OIDC and client-bound API operations require `OIDC_CLIENT_ID`; `OIDC_ISSUER`
 * (defaults to this service's issuer), `OIDC_CLIENT_SECRET`, and `AUTH_API_TOKEN`
 * are optional for applicable operations. Named utilities and session helpers can
 * be imported without configuring a client ID.
 *
 * @example
 * import client from './node.mjs';
 * const profile = await client.getProfile(request);
 */
import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
} from "node:crypto";

const defaultIssuer = "https://auth.api.apphor.de";
const decodeBase64Url = (value) => Buffer.from(value, "base64url");

function safeStringEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

/** Decode a compact JWT into its header, payload, signature, and signed bytes. @param {string} token @returns {{header: object, payload: object, signature: Buffer, signed: Buffer}} */
function parseToken(token) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWT");
  }
  try {
    return {
      header: JSON.parse(decodeBase64Url(parts[0]).toString("utf8")),
      payload: JSON.parse(decodeBase64Url(parts[1]).toString("utf8")),
      signature: decodeBase64Url(parts[2]),
      signed: Buffer.from(`${parts[0]}.${parts[1]}`),
    };
  } catch {
    throw new Error("Invalid JWT");
  }
}

class AuthApiError extends Error {
  /** Create an error for a non-successful Auth API response. @param {string} method @param {string} path @param {number} status @param {string} detail @returns {void} */
  constructor(method, path, status, detail) {
    super(`Auth request ${method} ${path} failed: ${status} ${detail}`);
    this.name = "AuthApiError";
    this.status = status;
  }
}

/** Read and decode cookies from a Fetch or Node-style request. @param {Request|object} request @returns {Record<string, string>} */
export function getCookies(request) {
  const header = request?.headers?.get
    ? request.headers.get("cookie")
    : request?.headers?.cookie;
  if (!header) {
    return {};
  }
  return Object.fromEntries(
    header.split(";").map((part) => {
      const separator = part.indexOf("=");
      if (separator === -1) {
        return [part.trim(), ""];
      }
      const value = part.slice(separator + 1).trim();
      try {
        return [part.slice(0, separator).trim(), decodeURIComponent(value)];
      } catch {
        return [part.slice(0, separator).trim(), value];
      }
    }),
  );
}

/** Format one incoming session cookie for an outbound Cookie header; authorization and admin roles are still enforced by Auth. @param {Request|object} request @param {string} [cookieName='connect.sid'] @returns {string} */
export function getSessionCookie(request, cookieName = "connect.sid") {
  const value = getCookies(request)[cookieName];
  return value ? `${cookieName}=${encodeURIComponent(value)}` : "";
}

/** Client for OIDC, user-session, API-token, and administrator endpoints. The default export is an environment-configured instance. */
export class AuthClient {
  /** Configure the OIDC client and API credentials. `clientSecret` is the OIDC client secret; `authApiToken` is a separate Auth API bearer token. `jwksUri` overrides the discovery JWKS endpoint but must use the issuer origin. @param {{issuer?: string, clientId?: string, clientSecret?: string, authApiToken?: string, sessionCookieName?: string, jwksUri?: string}} [options] @returns {void} */
  constructor({
    issuer = process.env.OIDC_ISSUER || defaultIssuer,
    clientId = process.env.OIDC_CLIENT_ID,
    clientSecret = process.env.OIDC_CLIENT_SECRET,
    authApiToken = process.env.AUTH_API_TOKEN,
    sessionCookieName = "connect.sid",
    jwksUri = process.env.OIDC_JWKS_URI,
  } = {}) {
    let normalizedIssuer;
    try {
      normalizedIssuer = new URL(issuer).toString().replace(/\/$/, "");
    } catch {
      throw new Error("OIDC_ISSUER must be an absolute URL");
    }
    if (!/^https?:\/\//.test(normalizedIssuer)) {
      throw new Error("OIDC_ISSUER must use HTTP or HTTPS");
    }
    this.issuer = normalizedIssuer;
    this.issuerOrigin = new URL(normalizedIssuer).origin;
    const normalizedJwksUri = jwksUri
      ? new URL(jwksUri)
      : new URL("/.well-known/jwks.json", normalizedIssuer);
    if (normalizedJwksUri.origin !== this.issuerOrigin) {
      throw new Error("OIDC_JWKS_URI must share the issuer origin");
    }
    this.jwksUri = normalizedJwksUri.toString();
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.authApiToken = authApiToken;
    this.sessionCookieName = sessionCookieName;
    this.removeProperty = this.deleteProperty;
    this.jwks = null;
    this.jwksExpiresAt = 0;
    this.jwksLastRefreshAt = 0;
    this.jwksRequest = null;
    this.refreshRequests = new Map();
  }

  /** Require a configured OIDC client ID for client-bound operations. @returns {string} */
  requireClientId() {
    if (!this.clientId) {
      throw new Error("OIDC_CLIENT_ID is required for this operation");
    }
    return this.clientId;
  }

  /** Build an Auth issuer URL with optional query parameters. @param {string} path @param {Record<string, string>} [query] @returns {URL} */
  url(path, query) {
    const url = new URL(path, this.issuer);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, value);
      }
    }
    return url;
  }

  /** Send a request to the issuer; `session` forwards the user's session cookie, `admin` forwards an admin session cookie, and `api` uses the configured Auth API bearer token. `form` is URL-encoded, `body` is JSON, and extra options are passed to fetch. @param {string} path @param {{method?: string, request?: Request|object, auth?: 'none'|'session'|'admin'|'api', body?: unknown, form?: Record<string, string>, headers?: Record<string, string>, allowEmpty?: boolean, [fetchOption: string]: unknown}} [options] @returns {Promise<unknown>} */
  async request(
    path,
    {
      method = "GET",
      request,
      auth = "none",
      body,
      form,
      headers = {},
      allowEmpty = false,
      ...options
    } = {},
  ) {
    const url = this.url(path);
    if (url.origin !== this.issuerOrigin) {
      throw new Error("Auth request URL must use the configured issuer origin");
    }
    const outgoing = { ...headers };
    if (auth === "session" || auth === "admin") {
      const cookie = getSessionCookie(request, this.sessionCookieName);
      if (!cookie) {
        throw new Error("Authentication required: pass the incoming request");
      }
      outgoing.Cookie = cookie;
    } else if (auth === "api") {
      if (!this.authApiToken) {
        throw new Error("An Auth API token is required");
      }
      outgoing.Authorization = `Bearer ${this.authApiToken}`;
    }
    if (form) {
      outgoing["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(form);
    }
    if (body !== undefined && !form) {
      outgoing["content-type"] = "application/json";
      body = JSON.stringify(body);
    }
    const response = await fetch(url, {
      method,
      headers: outgoing,
      body,
      ...options,
      redirect: "manual",
    });
    if (!response.ok) {
      throw new AuthApiError(
        method,
        path,
        response.status,
        await response.text(),
      );
    }
    if (allowEmpty || response.status === 204) {
      return undefined;
    }
    const text = await response.text();
    if (!text) {
      return undefined;
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /** Fetch OIDC discovery metadata from `/.well-known/openid-configuration`. @returns {Promise<object>} */
  getDiscovery() {
    return this.request("/.well-known/openid-configuration");
  }
  /** Fetch keys from `/.well-known/jwks.json` and cache them for token verification for one hour. @returns {Promise<object>} */
  getJwks() {
    if (!this.jwksRequest) {
      this.jwksLastRefreshAt = Date.now();
      this.jwksRequest = this.request(this.jwksUri)
        .then((keys) => {
          this.jwks = keys;
          this.jwksExpiresAt = Date.now() + 3600000;
          this.jwksLastRefreshAt = Date.now();
          return keys;
        })
        .finally(() => {
          this.jwksRequest = null;
        });
    }
    return this.jwksRequest;
  }
  /** Verify an RS256 JWT signature and issuer, audience, subject, and time claims. @param {string} token @returns {Promise<object>} Verified JWT payload. */
  async verifyToken(token) {
    const { header, payload, signature, signed } = parseToken(token);
    if (header.alg !== "RS256" || typeof header.kid !== "string") {
      throw new Error("Unsupported JWT");
    }
    this.requireClientId();
    let keys =
      this.jwks && Date.now() < this.jwksExpiresAt
        ? this.jwks
        : await this.getJwks();
    let jwk = keys.keys?.find(
      (key) => key.kid === header.kid && key.kty === "RSA",
    );
    if (!jwk && Date.now() - this.jwksLastRefreshAt >= 5000) {
      keys = await this.getJwks();
      jwk = keys.keys?.find(
        (key) => key.kid === header.kid && key.kty === "RSA",
      );
    }
    if (
      !jwk ||
      !verify(
        "RSA-SHA256",
        signed,
        createPublicKey({ key: jwk, format: "jwk" }),
        signature,
      )
    ) {
      throw new Error("Invalid JWT signature");
    }
    const now = Math.floor(Date.now() / 1000),
      audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (
      payload.iss !== this.issuer ||
      !audiences.includes(this.clientId) ||
      typeof payload.sub !== "string"
    ) {
      throw new Error("Invalid JWT claims");
    }
    if (typeof payload.exp !== "number" || payload.exp <= now) {
      throw new Error("Expired JWT");
    }
    if (
      payload.nbf !== undefined &&
      (typeof payload.nbf !== "number" || !Number.isFinite(payload.nbf))
    ) {
      throw new Error("Invalid JWT not-before claim");
    }
    if (typeof payload.nbf === "number" && payload.nbf > now) {
      throw new Error("JWT is not active");
    }
    return payload;
  }
  /** Verify an access token, then fetch `/userinfo` using that token as a bearer credential. @param {string} token @returns {Promise<object|string>} */
  async getUserInfo(token) {
    this.requireClientId();
    await this.verifyToken(token);
    return this.request("/userinfo", {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Auth-Audience": this.clientId,
      },
    });
  }
  /** Introspect an access token at `/oauth/introspect` using client Basic authentication (OIDC client secret). @param {string} token @returns {Promise<unknown>} */
  introspectToken(token) {
    this.requireClientId();
    return this.request("/oauth/introspect", {
      method: "POST",
      form: { token, token_type_hint: "access_token" },
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret || ""}`).toString("base64")}`,
      },
    });
  }
  /** Revoke a token at `/api/v1/revoke` using client Basic authentication (OIDC client secret). @param {string} token @returns {Promise<void>} */
  revokeApiToken(token) {
    this.requireClientId();
    return this.request("/api/v1/revoke", {
      method: "POST",
      form: { token, token_type_hint: "access_token" },
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret || ""}`).toString("base64")}`,
      },
      allowEmpty: true,
    });
  }
  /** Revoke a refresh token at `/revoke`; submits the OIDC client ID and secret. @param {string} token @returns {Promise<void>} */
  revokeRefreshToken(token) {
    this.requireClientId();
    return this.request("/revoke", {
      method: "POST",
      form: {
        client_id: this.clientId,
        client_secret: this.clientSecret || "",
        token,
        token_type_hint: "refresh_token",
      },
      allowEmpty: true,
    });
  }
  /** Build a browser authorization redirect URL plus its state, PKCE verifier, nonce, and exact redirect URI; persist the returned transaction server-side until the callback. Include `offline_access` in `scope` to request a refresh token. @param {{redirectUri: string, scope?: string, nonce?: string}} options @returns {{url: string, state: string, codeVerifier: string, nonce: string, redirectUri: string}} */
  createAuthorizationRequest({
    redirectUri,
    scope = "openid profile email",
    nonce = randomBytes(32).toString("base64url"),
  }) {
    this.requireClientId();
    if (!redirectUri) {
      throw new Error("A redirect URI is required");
    }
    const state = randomBytes(32).toString("base64url"),
      codeVerifier = randomBytes(32).toString("base64url");
    const url = this.url("/authorize", {
      response_type: "code",
      client_id: this.clientId,
      redirect_uri: redirectUri,
      state,
      scope,
      nonce,
      code_challenge: createHash("sha256")
        .update(codeVerifier)
        .digest("base64url"),
      code_challenge_method: "S256",
    });
    return { url: String(url), state, codeVerifier, nonce, redirectUri };
  }
  /** Build only a browser authorization redirect URL; state and PKCE values are not returned, so use createAuthorizationRequest() for a callback flow. @deprecated @param {object} options @returns {string} */
  authorizationUrl(options) {
    return this.createAuthorizationRequest(options).url;
  }
  /** Exchange an authorization code at `/token`, optionally authenticating with the OIDC client secret. @param {{code: string, codeVerifier: string, redirectUri: string, clientSecret?: string}} options @returns {Promise<object>} Token response; includes `refresh_token` when `offline_access` was granted. */
  exchangeCode({
    code,
    codeVerifier,
    redirectUri,
    clientSecret = this.clientSecret,
  }) {
    this.requireClientId();
    return this.request("/token", {
      method: "POST",
      form: {
        grant_type: "authorization_code",
        code,
        client_id: this.clientId,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
      },
    });
  }
  /** Complete an authorization-code callback using its saved transaction: validate callback location/state, exchange with PKCE, and verify the ID token and nonce. The caller must load and consume the transaction from a short-lived browser-bound store. @param {{callbackUrl: string|URL, transaction: {state: string, nonce: string, codeVerifier: string, redirectUri: string}, clientSecret?: string}} options @returns {Promise<{tokens: object, claims: object}>} */
  async completeAuthorization({
    callbackUrl,
    transaction,
    clientSecret = this.clientSecret,
  }) {
    this.requireClientId();
    if (
      !transaction ||
      typeof transaction.state !== "string" ||
      !transaction.state ||
      transaction.state.length > 512 ||
      typeof transaction.nonce !== "string" ||
      !transaction.nonce ||
      transaction.nonce.length > 512 ||
      typeof transaction.codeVerifier !== "string" ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(transaction.codeVerifier) ||
      typeof transaction.redirectUri !== "string"
    ) {
      throw new Error("Invalid or incomplete OIDC login transaction");
    }
    let callback;
    let redirectUri;
    try {
      callback = new URL(callbackUrl);
      redirectUri = new URL(transaction.redirectUri);
    } catch {
      throw new Error("Invalid OIDC callback URL");
    }
    if (
      callback.protocol !== redirectUri.protocol ||
      callback.host !== redirectUri.host ||
      callback.pathname !== redirectUri.pathname ||
      callback.username ||
      callback.password ||
      redirectUri.username ||
      redirectUri.password ||
      callback.hash
    ) {
      throw new Error(
        "OIDC callback URL does not match the login redirect URI",
      );
    }
    for (const name of new Set(redirectUri.searchParams.keys())) {
      if (
        ["code", "state", "error", "error_description", "error_uri"].includes(
          name,
        )
      ) {
        throw new Error("OIDC redirect URI uses a reserved callback parameter");
      }
      const expectedValues = redirectUri.searchParams.getAll(name);
      const actualValues = callback.searchParams.getAll(name);
      if (
        expectedValues.length !== actualValues.length ||
        expectedValues.some((value, index) => value !== actualValues[index])
      ) {
        throw new Error(
          "OIDC callback URL does not match the login redirect URI",
        );
      }
    }
    const states = callback.searchParams.getAll("state");
    if (states.length !== 1 || !safeStringEqual(states[0], transaction.state)) {
      throw new Error("Invalid OIDC callback state");
    }
    if (callback.searchParams.getAll("error").length > 1) {
      throw new Error("OIDC callback contains duplicate error parameters");
    }
    if (callback.searchParams.has("error")) {
      throw new Error(
        `OIDC authorization failed: ${callback.searchParams.get("error") || "unknown_error"}`,
      );
    }
    const codes = callback.searchParams.getAll("code");
    if (codes.length !== 1 || !codes[0]) {
      throw new Error(
        "OIDC callback must contain exactly one authorization code",
      );
    }
    const tokens = await this.exchangeCode({
      code: codes[0],
      codeVerifier: transaction.codeVerifier,
      redirectUri: transaction.redirectUri,
      clientSecret,
    });
    if (
      !tokens ||
      typeof tokens !== "object" ||
      typeof tokens.id_token !== "string" ||
      !tokens.id_token ||
      typeof tokens.access_token !== "string" ||
      !tokens.access_token
    ) {
      throw new Error(
        "OIDC token response is missing a required ID or access token",
      );
    }
    const claims = await this.verifyToken(tokens.id_token);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const now = Math.floor(Date.now() / 1000);
    if (
      !safeStringEqual(claims.nonce, transaction.nonce) ||
      typeof claims.iat !== "number" ||
      claims.iat > now + 60 ||
      !claims.sub ||
      (audiences.length > 1 && claims.azp !== this.clientId) ||
      (claims.azp !== undefined && claims.azp !== this.clientId)
    ) {
      throw new Error("Invalid OIDC ID token claims");
    }
    if (claims.at_hash !== undefined) {
      if (typeof tokens.access_token !== "string") {
        throw new Error(
          "OIDC token response is missing the access token required to validate at_hash",
        );
      }
      const expectedAtHash = createHash("sha256")
        .update(tokens.access_token)
        .digest()
        .subarray(0, 16)
        .toString("base64url");
      if (!safeStringEqual(claims.at_hash, expectedAtHash)) {
        throw new Error("Invalid OIDC ID token at_hash");
      }
    }
    return { tokens, claims };
  }
  /** Exchange a rotating refresh token at `/token`. Concurrent calls with the same token/options coalesce within this client instance. Callers using multiple client instances, processes, or replicas must still serialize per RP session and persist the replacement atomically. @param {{refreshToken: string, scope?: string, clientSecret?: string}} options @returns {Promise<object>} Token response containing the replacement `refresh_token` when offline access continues. */
  refreshToken({ refreshToken, scope, clientSecret = this.clientSecret }) {
    this.requireClientId();
    if (!refreshToken) {
      throw new Error("A refresh token is required");
    }
    const key = createHash("sha256").update(refreshToken).digest("base64url");
    const existing = this.refreshRequests.get(key);
    if (existing) {
      if (existing.scope !== scope || existing.clientSecret !== clientSecret) {
        throw new Error(
          "A refresh with this token is already in progress with different options",
        );
      }
      return existing.promise;
    }
    const promise = this.request("/token", {
      method: "POST",
      form: {
        grant_type: "refresh_token",
        client_id: this.clientId,
        refresh_token: refreshToken,
        ...(scope !== undefined ? { scope } : {}),
        ...(clientSecret ? { client_secret: clientSecret } : {}),
      },
    });
    const entry = { scope, clientSecret, promise };
    this.refreshRequests.set(key, entry);
    return promise.finally(() => {
      if (this.refreshRequests.get(key) === entry) {
        this.refreshRequests.delete(key);
      }
    });
  }
  /** Get the profile via `/api/v1/profile` using the user's session cookie; returns null when unauthenticated or denied. @param {Request|object} request @returns {Promise<unknown|null>} */
  getProfile(request) {
    if (!getSessionCookie(request, this.sessionCookieName)) {
      return Promise.resolve(null);
    }
    return this.request("/api/v1/profile", { request, auth: "session" }).catch(
      (error) => {
        if (
          error instanceof AuthApiError &&
          [401, 403, 404].includes(error.status)
        ) {
          return null;
        }
        throw error;
      },
    );
  }
  /** Check the user's session with `HEAD /api/v1/profile`. @param {Request|object} request @returns {Promise<void>} */
  checkSession(request) {
    return this.request("/api/v1/profile", {
      method: "HEAD",
      request,
      auth: "session",
      allowEmpty: true,
    });
  }
  /** Alias for getProfile; uses the user's session cookie. @param {Request|object} request @returns {Promise<unknown|null>} */
  getSessionProfile(request) {
    return this.getProfile(request);
  }
  /** Resolve whether the user's session is authenticated. @param {Request|object} request @returns {Promise<boolean>} */
  isSessionAuthenticated(request) {
    return this.getProfile(request).then(Boolean);
  }
  /** Return the profile or write an HTTP 401 response when the session is absent/invalid. @param {Request|object} request @param {object} response @returns {Promise<unknown|null>} */
  async requireSession(request, response) {
    const profile = await this.getProfile(request);
    if (profile) {
      return profile;
    }
    response.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
    response.end("Authentication required");
    return null;
  }
  /** Sign out the current user via `DELETE /api/v1/profile` using their session cookie. @param {Request|object} request @returns {Promise<void>} */
  signOut(request) {
    return this.request("/api/v1/profile", {
      method: "DELETE",
      request,
      auth: "session",
      allowEmpty: true,
    });
  }
  /** Update the current user's preferred username via the session-authenticated profile endpoint. @param {Request|object} request @param {string} preferred_username @returns {Promise<unknown>} */
  setPreferredUsername(request, preferred_username) {
    return this.request("/api/v1/profile/preferred-username", {
      method: "PUT",
      request,
      auth: "session",
      body: { preferred_username },
    });
  }
  /** List the current user's properties using their session cookie. @param {Request|object} request @returns {Promise<unknown>} */
  getProperties(request) {
    return this.request("/api/v1/properties", { request, auth: "session" });
  }
  /** Get one session-authenticated property; returns null when absent or denied. @param {Request|object} request @param {string} key @returns {Promise<unknown|null>} */
  getProperty(request, key) {
    if (!getSessionCookie(request, this.sessionCookieName)) {
      return Promise.resolve(null);
    }
    return this.request(`/api/v1/properties/${encodeURIComponent(key)}`, {
      request,
      auth: "session",
    }).catch((error) => {
      if (
        error instanceof AuthApiError &&
        [401, 403, 404].includes(error.status)
      ) {
        return null;
      }
      throw error;
    });
  }
  /** Set a property for the current user via `PUT /api/v1/properties`. @param {Request|object} request @param {string} key @param {unknown} value @returns {Promise<unknown>} */
  setProperty(request, key, value) {
    return this.request("/api/v1/properties", {
      method: "PUT",
      request,
      auth: "session",
      body: { key, value },
    });
  }
  /** Delete a current-user property via `DELETE /api/v1/properties/{key}`. @param {Request|object} request @param {string} key @returns {Promise<void>} */
  deleteProperty(request, key) {
    return this.request(`/api/v1/properties/${encodeURIComponent(key)}`, {
      method: "DELETE",
      request,
      auth: "session",
      allowEmpty: true,
    });
  }
  /** Alias for deleteProperty. @param {Request|object} request @param {string} key @returns {Promise<void>} */
  removeProperty(request, key) {
    return this.deleteProperty(request, key);
  }
  /** Issue a session-bound token for an audience using the user's session and request Origin. @param {Request|object} request @param {string} audience @returns {Promise<unknown>} */
  issueSessionToken(request, audience) {
    const origin = request?.headers?.get
      ? request.headers.get("origin")
      : request?.headers?.origin;
    if (!origin) {
      throw new Error("Origin header required to issue a session token");
    }
    return this.request("/api/v1/session/token", {
      method: "POST",
      request,
      auth: "session",
      headers: { Origin: origin },
      body: { audience },
    });
  }
  /** List the current user's API tokens, optionally filtered by client ID; uses their session cookie. @param {Request|object} request @param {string} [clientId] @returns {Promise<unknown>} */
  listUserApiTokens(request, clientId) {
    const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
    return this.request(`/api/v1/api-tokens/me${query}`, {
      request,
      auth: "session",
    });
  }
  /** Admin-session list of API tokens for a client. @param {Request|object} request @param {string} clientId @returns {Promise<unknown>} */
  listApiTokensForClient(request, clientId) {
    return this.request(`/api/v1/api-tokens/${encodeURIComponent(clientId)}`, {
      request,
      auth: "admin",
    });
  }
  /** Create a client API token using the admin session. @param {Request|object} request @param {string} clientId @param {object} data @returns {Promise<unknown>} */
  createApiToken(request, clientId, data) {
    return this.request(`/api/v1/api-tokens/${encodeURIComponent(clientId)}`, {
      method: "POST",
      request,
      auth: "admin",
      body: data,
    });
  }
  /** Delete a client API token using the admin session. @param {Request|object} request @param {string} clientId @param {string} tokenId @returns {Promise<void>} */
  deleteApiToken(request, clientId, tokenId) {
    return this.request(
      `/api/v1/api-tokens/${encodeURIComponent(clientId)}/${encodeURIComponent(tokenId)}`,
      {
        method: "DELETE",
        request,
        auth: "admin",
        allowEmpty: true,
      },
    );
  }
  /** Alias for listApiTokensForClient; requires an admin session. @param {Request|object} request @param {string} clientId @returns {Promise<unknown>} */
  listUserApiTokensForClient(request, clientId) {
    return this.listApiTokensForClient(request, clientId);
  }
  /** Alias for createApiToken; requires an admin session. @param {Request|object} request @param {string} clientId @param {object} data @returns {Promise<unknown>} */
  createUserApiToken(request, clientId, data) {
    return this.createApiToken(request, clientId, data);
  }
  /** Alias for deleteApiToken; requires an admin session. @param {Request|object} request @param {string} clientId @param {string} tokenId @returns {Promise<void>} */
  deleteUserApiToken(request, clientId, tokenId) {
    return this.deleteApiToken(request, clientId, tokenId);
  }
  /** Mint a downstream API token via `/api/v1/api-tokens/{clientId}/issue` using the configured Auth API bearer token, not OIDC client credentials. @param {{label: string, scopes: string[]}} options @returns {Promise<unknown>} */
  mintApiToken({ label, scopes }) {
    this.requireClientId();
    return this.request(
      `/api/v1/api-tokens/${encodeURIComponent(this.clientId)}/issue`,
      {
        method: "POST",
        auth: "api",
        body: { label, scopes },
      },
    );
  }
  /** Append downstream scopes to this client's scope list with the configured Auth API bearer token. Existing scopes cannot be removed through this operation. @param {string[]} scopes @returns {Promise<{scopes: string[]}>} */
  addApiTokenScopes(scopes) {
    this.requireClientId();
    return this.request(
      `/api/v1/api-tokens/${encodeURIComponent(this.clientId)}/scopes`,
      {
        method: "POST",
        auth: "api",
        body: { scopes },
      },
    );
  }
  /** List OIDC clients using the admin session cookie. @param {Request|object} request @returns {Promise<unknown>} */
  listOidcClients(request) {
    return this.request("/api/v1/oidc/clients", { request, auth: "admin" });
  }
  /** Create an OIDC client using the admin session; response may include its one-time client secret. @param {Request|object} request @param {{id: string, redirectUris: string[], postLogoutRedirectUris?: string[], scopes?: string[], isPublic?: boolean}} data @returns {Promise<unknown>} */
  createOidcClient(request, data) {
    return this.request("/api/v1/oidc/clients", {
      method: "POST",
      request,
      auth: "admin",
      body: data,
    });
  }
  /** Delete an OIDC client using the admin session. @param {Request|object} request @param {string} id @returns {Promise<void>} */
  deleteOidcClient(request, id) {
    return this.request(`/api/v1/oidc/clients/${encodeURIComponent(id)}`, {
      method: "DELETE",
      request,
      auth: "admin",
      allowEmpty: true,
    });
  }
  /** Replace a client's registered post-logout redirect URLs using the admin session. @param {Request|object} request @param {string} id @param {string[]} postLogoutRedirectUris @returns {Promise<unknown>} */
  setClientLogoutRedirects(request, id, postLogoutRedirectUris) {
    return this.request(
      `/api/v1/oidc/clients/${encodeURIComponent(id)}/logout-redirects`,
      {
        method: "PUT",
        request,
        auth: "admin",
        body: { postLogoutRedirectUris },
      },
    );
  }
  /** Regenerate an OIDC client's secret using the admin session; the new secret may be returned once. @param {Request|object} request @param {string} id @returns {Promise<unknown>} */
  regenerateOidcClientSecret(request, id) {
    return this.request(
      `/api/v1/oidc/clients/${encodeURIComponent(id)}/secret`,
      {
        method: "PUT",
        request,
        auth: "admin",
      },
    );
  }
  /** Replace an OIDC client's scopes using the admin session. @param {Request|object} request @param {string} id @param {string[]} scopes @returns {Promise<unknown>} */
  setOidcClientScopes(request, id, scopes) {
    return this.request(
      `/api/v1/oidc/clients/${encodeURIComponent(id)}/scopes`,
      {
        method: "PUT",
        request,
        auth: "admin",
        body: { scopes },
      },
    );
  }
  /** List a client's Auth API tokens using the admin session. @param {Request|object} request @param {string} clientId @returns {Promise<unknown>} */
  listAuthApiTokens(request, clientId) {
    return this.request(
      `/api/v1/auth-api-tokens/${encodeURIComponent(clientId)}`,
      { request, auth: "admin" },
    );
  }
  /** Create a client's fixed-purpose Auth API token using the admin session; its bearer value is returned only once. @param {Request|object} request @param {string} clientId @param {string} label @returns {Promise<unknown>} */
  createAuthApiToken(request, clientId, label) {
    return this.request(
      `/api/v1/auth-api-tokens/${encodeURIComponent(clientId)}`,
      {
        method: "POST",
        request,
        auth: "admin",
        body: { label },
      },
    );
  }
  /** Delete a client's Auth API token using the admin session. @param {Request|object} request @param {string} clientId @param {string} tokenId @returns {Promise<void>} */
  deleteAuthApiToken(request, clientId, tokenId) {
    return this.request(
      `/api/v1/auth-api-tokens/${encodeURIComponent(clientId)}/${encodeURIComponent(tokenId)}`,
      {
        method: "DELETE",
        request,
        auth: "admin",
        allowEmpty: true,
      },
    );
  }
  /** Retrieve signing keys using the admin session. @param {Request|object} request @returns {Promise<unknown>} */
  getKeys(request) {
    return this.request("/api/v1/keys", { request, auth: "admin" });
  }
  /** Rotate signing keys using the admin session; affects issued-token signing keys. @param {Request|object} request @returns {Promise<unknown>} */
  rotateKeys(request) {
    return this.request("/api/v1/keys/rotate", {
      method: "POST",
      request,
      auth: "admin",
    });
  }
  /** Query audit records using the user's session cookie. @param {Request|object} request @param {Record<string, string>} [query] @returns {Promise<unknown>} */
  getAudit(request, query = {}) {
    const url = this.url("/api/v1/audit", query);
    return this.request(url.pathname + url.search, {
      request,
      auth: "session",
    });
  }
  /** Fetch audit filter options using the user's session cookie. @param {Request|object} request @returns {Promise<unknown>} */
  getAuditOptions(request) {
    return this.request("/api/v1/audit/options", { request, auth: "session" });
  }
  /** List administrator accounts using the admin session cookie. @param {Request|object} request @returns {Promise<unknown>} */
  listAdminUsers(request) {
    return this.request("/api/v1/admin/users", { request, auth: "admin" });
  }
  /** Update a user account using the admin session. @param {Request|object} request @param {string} id @param {object} data @returns {Promise<unknown>} */
  updateAdminUser(request, id, data) {
    return this.request(`/api/v1/admin/users/${encodeURIComponent(id)}`, {
      method: "PATCH",
      request,
      auth: "admin",
      body: data,
    });
  }
  /** Delete a user account using the admin session. @param {Request|object} request @param {string} id @returns {Promise<unknown>} */
  deleteAdminUser(request, id) {
    return this.request(`/api/v1/admin/users/${encodeURIComponent(id)}`, {
      method: "DELETE",
      request,
      auth: "admin",
    });
  }
  /** Build the browser's RP-initiated logout URL; it does not call or follow the logout endpoint. @param {{idTokenHint?: string, postLogoutRedirectUri?: string, state?: string}} [options] @returns {string} */
  getLogoutUrl({ idTokenHint, postLogoutRedirectUri, state } = {}) {
    this.requireClientId();
    return String(
      this.url("/logout", {
        client_id: this.clientId,
        id_token_hint: idTokenHint,
        post_logout_redirect_uri: postLogoutRedirectUri,
        state,
      }),
    );
  }
  /** Read cookies from an incoming request. @param {Request|object} request @returns {Record<string, string>} */
  getCookies(request) {
    return getCookies(request);
  }
}

/** Create another AuthClient from explicit options or environment defaults. @param {object} [options] @returns {AuthClient} */
export function createAuthClient(options = {}) {
  return new AuthClient(options);
}

const authClient = new AuthClient();
export default authClient;
