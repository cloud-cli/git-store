import assert from "node:assert/strict";
import {
  createWebhookStore,
  events,
  validateTarget,
  getEncryptionKey,
  encryptedSecret,
  decryptSecret,
  isPublicAddress,
  MAX_SUBSCRIPTIONS,
  MAX_QUEUE,
} from "../webhooks.js";

const key = getEncryptionKey("a".repeat(64));
assert.ok(key);
assert.equal(getEncryptionKey("bad"), null);
const encrypted = encryptedSecret("secret", key);
assert.notEqual(encrypted, "secret");
assert.equal(decryptSecret(encrypted, key), "secret");
assert.throws(() => decryptSecret(encrypted, getEncryptionKey("b".repeat(64))));
assert.equal(isPublicAddress("::ffff:127.0.0.1"), false);
assert.equal(isPublicAddress("::ffff:8.8.8.8"), true);
assert.equal(isPublicAddress("fc00::1"), false);
assert.equal(MAX_SUBSCRIPTIONS, 20);
assert.equal(MAX_QUEUE, 100);

assert.equal(events.has("security.request.denied"), false);
assert.equal(events.has("personal_access_token.created"), false);
assert.equal(events.has("repository.files.staged"), false);
assert.equal(await validateTarget("http://example.com"), false);
assert.equal(await validateTarget("https://user:pass@example.com"), false);
assert.equal(await validateTarget("https://127.0.0.1"), false);
assert.equal(await validateTarget("https://[::1]"), false);
assert.equal(await validateTarget("https://[::ffff:127.0.0.1]"), false);

const rows = [];
const client = {
  async query(mode, sql, bindings = []) {
    if (sql.startsWith("INSERT")) {
      rows.push({
        id: bindings[0],
        org: bindings[1],
        url: bindings[2],
        secret: bindings[3],
        events: bindings[4],
        createdAt: bindings[5],
      });
      return { changes: 1 };
    }
    if (sql.startsWith("SELECT")) {
      return rows
        .filter((row) => row.org === bindings[0])
        .map(({ id, org, url, secret, events: selectedEvents, createdAt }) => ({
          id,
          org,
          url,
          secret,
          events: selectedEvents,
          createdAt,
        }));
    }
    if (sql.startsWith("DELETE")) {
      const index = rows.findIndex((row) => row.org === bindings[0] && row.id === bindings[1]);
      if (index === -1) {
        return { changes: 0 };
      }
      rows.splice(index, 1);
      return { changes: 1 };
    }
    return { changes: 0 };
  },
};
const store = createWebhookStore(client, key);
await store.create({
  id: "id",
  org: "owned",
  url: "https://example.com/hook",
  secret: "secret",
  events: ["repository.created"],
  createdAt: "now",
});
assert.notEqual(rows[0].secret, "secret");
assert.deepEqual((await store.list("owned"))[0].events, ["repository.created"]);
assert.equal((await store.matching("owned", "repository.created"))[0].secret, "secret");
assert.equal((await store.list("other")).length, 0);
assert.equal(await store.remove("other", "id"), false);
assert.equal(await store.remove("owned", "id"), true);
for (let i = 0; i < MAX_SUBSCRIPTIONS; i += 1) {
  await store.create({
    id: `cap-${i}`,
    org: "capped",
    url: "https://example.com/hook",
    secret: "secret",
    events: ["repository.created"],
    createdAt: "now",
  });
}
await assert.rejects(
  store.create({
    id: "over-cap",
    org: "capped",
    url: "https://example.com/hook",
    secret: "secret",
    events: ["repository.created"],
    createdAt: "now",
  }),
  /limit reached/,
);
