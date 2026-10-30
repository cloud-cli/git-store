import assert from "node:assert/strict";
import {
  createWebhookStore,
  events,
  isWebhookEvent,
  normalizeAuditEvent,
  createPushWebhookEvent,
  serializeWebhookPayload,
  validateTarget,
  getEncryptionKey,
  encryptedSecret,
  decryptSecret,
  isPublicAddress,
  parseAllowedIpRanges,
  isAddressInAllowedRanges,
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
assert.deepEqual(parseAllowedIpRanges("\n 192.168.1.20/32 \r\n10.0.0.0/24\n"), ["192.168.1.20/32", "10.0.0.0/24"]);
assert.deepEqual(parseAllowedIpRanges(["192.168.1.20/32", "192.168.1.20/32"]), ["192.168.1.20/32"]);
assert.equal(parseAllowedIpRanges("192.168.1.20"), null);
assert.equal(parseAllowedIpRanges("192.168.1.20/33"), null);
assert.equal(isAddressInAllowedRanges("192.168.1.20", ["192.168.1.20/32"]), true);
assert.equal(isAddressInAllowedRanges("192.168.1.21", ["192.168.1.20/32"]), false);
assert.equal(isAddressInAllowedRanges("10.0.0.18", ["10.0.0.0/24"]), true);
assert.equal(isAddressInAllowedRanges("2001:db8::1", ["2001:db8::/32"]), true);
assert.equal(MAX_SUBSCRIPTIONS, 20);
assert.equal(MAX_QUEUE, 100);

assert.equal(events.has("security.request.denied"), false);
assert.equal(events.has("personal_access_token.created"), false);
assert.equal(events.has("repository.files.staged"), false);
assert.deepEqual([...events], ["git", "repo", "thread"]);
assert.equal(events.has("git.pull_request"), false);
assert.equal(isWebhookEvent("git.branch"), true);
assert.equal(isWebhookEvent("git.push"), true);
assert.equal(isWebhookEvent("repository.file"), false);
assert.equal(isWebhookEvent("repo"), true);
assert.equal(isWebhookEvent("thread"), true);
assert.deepEqual(normalizeAuditEvent("repository.branch.created"), {
  event: "git.branch",
  action: "created",
});
assert.deepEqual(normalizeAuditEvent("git.tag.updated"), {
  event: "git.tag",
  action: "updated",
});
assert.deepEqual(normalizeAuditEvent("repository.created"), {
  event: "repo",
  action: "created",
});
assert.deepEqual(normalizeAuditEvent("thread.updated"), {
  event: "thread",
  action: "updated",
});
assert.equal(normalizeAuditEvent("repository.file.deleted"), null);
assert.equal(normalizeAuditEvent("repository.commit.created"), null);
assert.equal(normalizeAuditEvent("git.ref.updated"), null);
assert.equal(normalizeAuditEvent("repository.files.staged"), null);
const pushEvent = createPushWebhookEvent({
  id: "push-1",
  org: "owned",
  occurredAt: "now",
  object: "owned/repo",
  changes: [
    { ref: "refs/heads/main", before: "a", after: "b", action: "updated" },
    { ref: "refs/tags/v1", before: null, after: "b", action: "created" },
  ],
});
assert.equal(pushEvent.event, "git.push");
assert.equal(pushEvent.action, "pushed");
assert.deepEqual(pushEvent, {
  id: "push-1",
  org: "owned",
  event: "git.push",
  action: "pushed",
  occurredAt: "now",
  object: "owned/repo",
  details: {
    changes: [
      { ref: "refs/heads/main", before: "a", after: "b", action: "updated" },
      { ref: "refs/tags/v1", before: null, after: "b", action: "created" },
    ],
  },
});
assert.deepEqual(JSON.parse(serializeWebhookPayload(pushEvent)), pushEvent);
assert.equal(await validateTarget("http://example.com"), false);
assert.equal(await validateTarget("https://user:pass@example.com"), false);
assert.equal(await validateTarget("https://127.0.0.1"), false);
assert.equal(await validateTarget("https://[::1]"), false);
assert.equal(await validateTarget("https://[::ffff:127.0.0.1]"), false);
assert.equal(await validateTarget("https://127.0.0.1", ["127.0.0.1/32"]), true);

const rows = [];
for (const hasAllowedIpRanges of [true, false]) {
  const schemaClient = {
    hasAllowedIpRanges,
    alterations: 0,
    async query(mode, sql) {
      if (sql.startsWith("CREATE TABLE")) {
        return { changes: 0 };
      }
      if (sql.startsWith("PRAGMA table_info")) {
        return this.hasAllowedIpRanges ? [{ name: "id" }, { name: "allowed_ip_ranges" }] : [{ name: "id" }];
      }
      if (sql.startsWith("ALTER TABLE")) {
        this.alterations += 1;
        this.hasAllowedIpRanges = true;
        return { changes: 0 };
      }
      if (mode === "all") {
        return [];
      }
      return { changes: 0 };
    },
  };
  await createWebhookStore(schemaClient, key).list("org");
  assert.equal(schemaClient.alterations, hasAllowedIpRanges ? 0 : 1);
}

const client = {
  async query(mode, sql, bindings = []) {
    if (sql.startsWith("PRAGMA table_info")) {
      return [{ name: "allowed_ip_ranges" }];
    }
    if (sql.startsWith("INSERT")) {
      rows.push({
        id: bindings[0],
        org: bindings[1],
        url: bindings[2],
        secret: bindings[3],
        events: bindings[4],
        allowedIpRanges: bindings[5],
        createdAt: bindings[6],
      });
      return { changes: 1 };
    }
    if (sql.startsWith("SELECT")) {
      return rows
        .filter((row) => row.org === bindings[0])
        .map(({ id, org, url, secret, events: selectedEvents, allowedIpRanges, createdAt }) => ({
          id,
          org,
          url,
          secret,
          events: selectedEvents,
          allowedIpRanges,
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
  events: ["repo"],
  allowedIpRanges: ["192.168.1.20/32"],
  createdAt: "now",
});
assert.notEqual(rows[0].secret, "secret");
assert.deepEqual((await store.list("owned"))[0].events, ["repo"]);
assert.deepEqual((await store.list("owned"))[0].allowedIpRanges, ["192.168.1.20/32"]);
assert.equal((await store.matching("owned", "repo"))[0].secret, "secret");
assert.deepEqual((await store.matching("owned", "repo"))[0].allowedIpRanges, ["192.168.1.20/32"]);
await store.create({
  id: "family",
  org: "owned",
  url: "https://example.com/hook",
  secret: "secret",
  events: ["git"],
  createdAt: "now",
});
assert.equal((await store.matching("owned", "git.push"))[0].id, "family");
assert.equal(
  (await store.matching("owned", "repo")).some((hook) => hook.id === "family"),
  false,
);
assert.equal(
  (await store.matching("owned", "git.branch")).some((hook) => hook.id === "family"),
  true,
);
await store.create({
  id: "legacy-branch",
  org: "owned",
  url: "https://example.com/hook",
  secret: "secret",
  events: ["repository.branch.created"],
  createdAt: "now",
});
assert.ok((await store.matching("owned", "git.branch")).some((hook) => hook.id === "legacy-branch"));
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
