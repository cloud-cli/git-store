const assert = require("node:assert/strict");
const { createAuditStore, createTokenFingerprint } = require("../audit");

async function run() {
  const calls = [];
  const client = {
    async query(mode, statement, bindings) {
      calls.push({ mode, statement, bindings });
      return mode === "all" ? [{ id: "event-1" }] : { changes: 1 };
    },
  };
  const store = createAuditStore(client);
  await store.append({
    id: "event-1",
    occurredAt: "2026-01-01T00:00:00.000Z",
    org: "example",
    subject: "subject-1",
    actorName: "Example User",
    event: "git.branch.created",
    object: "example/repo@refs/heads/main",
    origin: "git-token",
    tokenFingerprint: "fingerprint",
    details: { before: null, after: "abc123" },
  });

  assert.match(calls[0].statement, /CREATE TABLE IF NOT EXISTS audit_events/);
  assert.match(calls[1].statement, /CREATE INDEX IF NOT EXISTS audit_events_org_time/);
  const insert = calls[2];
  assert.strictEqual(insert.mode, "run");
  assert.strictEqual(insert.bindings[4], "subject-1");
  assert.strictEqual(insert.bindings[5], "Example User");
  assert.ok(!insert.bindings.includes("raw-token"));

  const rows = await store.list("example", 25, 50);
  assert.deepStrictEqual(rows, [{ id: "event-1" }]);
  const query = calls[3];
  assert.strictEqual(query.mode, "all");
  assert.match(query.statement, /WHERE org_slug = \?/);
  assert.deepStrictEqual(query.bindings, ["example", 25, 50]);

  const fingerprint = createTokenFingerprint("raw-token", "test-key");
  assert.strictEqual(fingerprint, createTokenFingerprint("raw-token", "test-key"));
  assert.notStrictEqual(fingerprint, createTokenFingerprint("raw-token", "other-key"));
  assert.notStrictEqual(fingerprint, "raw-token");
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
