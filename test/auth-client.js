import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createAuthClient } from "../auth-client.js";

const issuer = "https://issuer.example.test";
const clientId = "git-store-test";
const client = createAuthClient({
  issuer,
  clientId,
  clientSecret: "test-client-secret",
  authApiToken: "test-api-token",
});
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const signedContent = `${encode({ alg: "RS256", kid: jwk.kid })}.${encode({
  iss: issuer,
  aud: clientId,
  sub: "test-subject",
  exp: Math.floor(Date.now() / 1000) + 300,
})}`;
const token = `${signedContent}.${sign("RSA-SHA256", Buffer.from(signedContent), privateKey).toString("base64url")}`;
const fetchCalls = [];
const nativeFetch = globalThis.fetch;

try {
  globalThis.fetch = async (url, options = {}) => {
    const parsedUrl = new URL(url);
    fetchCalls.push({ url: parsedUrl, options });
    if (["/.well-known/jwks.json", "/custom/jwks.json"].includes(parsedUrl.pathname)) {
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
    throw new Error(`Unexpected Auth API request: ${parsedUrl.pathname}`);
  };

  const profile = await client.getUserInfo(token);
  assert.deepStrictEqual(profile, { sub: "test-subject", name: "Test User" });
  assert.deepStrictEqual(await client.introspectToken("opaque-api-token"), { active: true, sub: "test-subject" });
  const introspection = fetchCalls.find(({ url }) => url.pathname === "/oauth/introspect");
  assert.match(introspection.options.headers.Authorization, /^Basic /);
  assert.ok(String(introspection.options.body).includes("token=opaque-api-token"));

  const callsBeforeRejectedRequest = fetchCalls.length;
  await assert.rejects(client.request("//attacker.invalid/capture", { auth: "api" }), /configured issuer origin/);
  assert.strictEqual(fetchCalls.length, callsBeforeRejectedRequest, "cross-origin calls are rejected before fetch");

  const customJwksClient = createAuthClient({ issuer, clientId, jwksUri: `${issuer}/custom/jwks.json` });
  assert.deepStrictEqual(await customJwksClient.getUserInfo(token), { sub: "test-subject", name: "Test User" });
  assert.ok(fetchCalls.some(({ url }) => url.pathname === "/custom/jwks.json"));
  assert.throws(
    () => createAuthClient({ issuer, clientId, jwksUri: "https://attacker.invalid/jwks.json" }),
    /share the issuer origin/,
  );

  globalThis.fetch = async () => new Response("upstream outage", { status: 503 });
  await assert.rejects(
    client.getProfile({ headers: { cookie: "connect.sid=dummy-session" } }),
    (error) => error.status === 503,
  );

  globalThis.fetch = async () => new Response("unauthenticated", { status: 401 });
  assert.strictEqual(await client.getProfile({ headers: { cookie: "connect.sid=dummy-session" } }), null);
} finally {
  globalThis.fetch = nativeFetch;
}
