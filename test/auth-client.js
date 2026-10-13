import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createAuthClient } from "../auth-client.js";

const issuer = "https://issuer.example.test";
const clientId = "gitmini-test";
const client = createAuthClient({
  issuer,
  clientId,
  clientSecret: "test-client-secret",
  authApiToken: "test-api-token",
});
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "test-key",
  alg: "RS256",
  use: "sig",
};
const encode = (value) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const signToken = (claims) => {
  const signedContent = `${encode({ alg: "RS256", kid: jwk.kid })}.${encode(claims)}`;
  return `${signedContent}.${sign("RSA-SHA256", Buffer.from(signedContent), privateKey).toString("base64url")}`;
};
const now = Math.floor(Date.now() / 1000);
const token = signToken({
  iss: issuer,
  aud: clientId,
  sub: "test-subject",
  exp: now + 300,
  iat: now,
});
const fetchCalls = [];
let authorizationNonce;
let refreshCallCount = 0;
const nativeFetch = globalThis.fetch;

try {
  globalThis.fetch = async (url, options = {}) => {
    const parsedUrl = new URL(url);
    fetchCalls.push({ url: parsedUrl, options });
    if (
      ["/.well-known/jwks.json", "/custom/jwks.json"].includes(
        parsedUrl.pathname,
      )
    ) {
      return Response.json({ keys: [jwk] });
    }
    if (parsedUrl.pathname === "/userinfo") {
      assert.strictEqual(options.headers.Authorization, `Bearer ${token}`);
      assert.strictEqual(options.headers["X-Auth-Audience"], clientId);
      return Response.json({ sub: "test-subject", name: "Test User" });
    }
    if (parsedUrl.pathname === "/oauth/introspect") {
      return Response.json({ active: true, sub: "test-subject" });
    }
    if (parsedUrl.pathname === "/token") {
      const form = new URLSearchParams(options.body);
      if (form.get("grant_type") === "authorization_code") {
        const idToken = signToken({
          iss: issuer,
          aud: clientId,
          sub: "test-subject",
          exp: Math.floor(Date.now() / 1000) + 300,
          iat: Math.floor(Date.now() / 1000),
          nonce: authorizationNonce,
        });
        return Response.json({
          access_token: token,
          id_token: idToken,
          refresh_token: "test-refresh-token",
          expires_in: 300,
        });
      }
      if (form.get("grant_type") === "refresh_token") {
        refreshCallCount += 1;
        return Response.json({
          access_token: token,
          refresh_token: "rotated-refresh-token",
          expires_in: 300,
        });
      }
    }
    throw new Error(`Unexpected Auth API request: ${parsedUrl.pathname}`);
  };

  const profile = await client.getUserInfo(token);
  assert.deepStrictEqual(profile, { sub: "test-subject", name: "Test User" });
  assert.deepStrictEqual(await client.introspectToken("opaque-api-token"), {
    active: true,
    sub: "test-subject",
  });
  const introspection = fetchCalls.find(
    ({ url }) => url.pathname === "/oauth/introspect",
  );
  assert.match(introspection.options.headers.Authorization, /^Basic /);
  assert.ok(
    String(introspection.options.body).includes("token=opaque-api-token"),
  );

  const transaction = client.createAuthorizationRequest({
    redirectUri: "https://gitmini.example.test/ui/auth/callback",
    scope: "openid profile email offline_access",
  });
  authorizationNonce = transaction.nonce;
  const callbackUrl = new URL(transaction.redirectUri);
  callbackUrl.searchParams.set("code", "authorization-code");
  callbackUrl.searchParams.set("state", transaction.state);
  const completed = await client.completeAuthorization({
    callbackUrl,
    transaction,
  });
  assert.strictEqual(completed.claims.sub, "test-subject");
  assert.strictEqual(completed.tokens.refresh_token, "test-refresh-token");

  const invalidNonceTransaction = {
    ...transaction,
    nonce: "not-the-expected-nonce",
  };
  await assert.rejects(
    client.completeAuthorization({
      callbackUrl,
      transaction: invalidNonceTransaction,
    }),
    /Invalid OIDC ID token claims/,
  );
  const invalidStateUrl = new URL(callbackUrl);
  invalidStateUrl.searchParams.set("state", "wrong-state");
  await assert.rejects(
    client.completeAuthorization({ callbackUrl: invalidStateUrl, transaction }),
    /Invalid OIDC callback state/,
  );

  const callsBeforeRejectedRequest = fetchCalls.length;
  await assert.rejects(
    client.request("//attacker.invalid/capture", { auth: "api" }),
    /configured issuer origin/,
  );
  assert.strictEqual(
    fetchCalls.length,
    callsBeforeRejectedRequest,
    "cross-origin calls are rejected before fetch",
  );

  const customJwksClient = createAuthClient({
    issuer,
    clientId,
    jwksUri: `${issuer}/custom/jwks.json`,
  });
  assert.deepStrictEqual(await customJwksClient.getUserInfo(token), {
    sub: "test-subject",
    name: "Test User",
  });
  assert.ok(fetchCalls.some(({ url }) => url.pathname === "/custom/jwks.json"));
  assert.throws(
    () =>
      createAuthClient({
        issuer,
        clientId,
        jwksUri: "https://attacker.invalid/jwks.json",
      }),
    /share the issuer origin/,
  );

  const refreshResults = await Promise.all([
    client.refreshToken({ refreshToken: "test-refresh-token" }),
    client.refreshToken({ refreshToken: "test-refresh-token" }),
  ]);
  assert.strictEqual(
    refreshCallCount,
    1,
    "refresh calls coalesce within an AuthClient instance",
  );
  assert.deepStrictEqual(refreshResults[0], refreshResults[1]);

  globalThis.fetch = async () =>
    new Response("upstream outage", { status: 503 });
  await assert.rejects(
    client.getProfile({ headers: { cookie: "connect.sid=dummy-session" } }),
    (error) => error.status === 503,
  );

  globalThis.fetch = async () =>
    new Response("unauthenticated", { status: 401 });
  assert.strictEqual(
    await client.getProfile({
      headers: { cookie: "connect.sid=dummy-session" },
    }),
    null,
  );
} finally {
  globalThis.fetch = nativeFetch;
}
