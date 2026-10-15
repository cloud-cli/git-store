import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PersonalAccessTokenStore } from "../personal-access-tokens.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "git-store-token-test-"));
const file = path.join(directory, "tokens.json");
const ownerHash = crypto.createHash("sha256").update("owner").digest("hex");
const store = new PersonalAccessTokenStore(file);
const generated = store.create({ ownerHash, label: "generated", scopes: ["repo:read"], orgs: ["alpha"] });
assert.deepEqual(generated.record.orgs, ["alpha"]);
assert.equal(store.authenticate(generated.token).claims.scope, "repo:read");
assert.deepEqual(store.authenticate(generated.token).claims.orgs, ["alpha"]);

const external = "opaque-test-token";
const record = store.bindExternal({
  token: external,
  ownerHash,
  label: "imported",
  scopes: ["repo:write", "org:manage"],
  orgs: ["alpha", "beta"],
});
assert.ok(!JSON.stringify(record).includes(external));
const persisted = fs.readFileSync(file, "utf8");
assert.ok(!persisted.includes(external));
assert.ok(persisted.includes(crypto.createHash("sha256").update(external).digest("hex")));
assert.deepEqual(store.findByToken(external).orgs, ["alpha", "beta"]);
assert.deepEqual(store.findByToken(external).scopes, ["repo:write", "org:manage"]);
assert.throws(
  () => store.bindExternal({ token: external, ownerHash, label: "duplicate", scopes: ["repo:read"], orgs: [] }),
  /already has/,
);

assert.equal(
  store.update(record.id, ownerHash, { label: "changed", scopes: ["repo:read"], orgs: ["beta"] }).label,
  "changed",
);
assert.deepEqual(store.findByToken(external).orgs, ["beta"]);
assert.equal(store.grantOrg(record.id, ownerHash, "gamma"), true);
assert.deepEqual(store.findByToken(external).orgs, ["beta", "gamma"]);
assert.equal(store.revoke(record.id, ownerHash), true);
assert.equal(store.findByToken(external), null);
assert.equal(store.authenticate(generated.token).claims.active, true);

assert.throws(() => store.create({ ownerHash, label: "invalid", scopes: [], orgs: [] }), TypeError);
const legacyFile = path.join(directory, "legacy.json");
fs.writeFileSync(
  legacyFile,
  JSON.stringify([
    {
      id: "pat_000000000000000000000001",
      tokenHash: "a".repeat(64),
      ownerHash,
      label: "legacy owner-bound token",
      scopes: ["repo:read"],
      org: null,
      repo: null,
      createdAt: new Date().toISOString(),
      expiresAt: null,
    },
    {
      id: "pat_000000000000000000000002",
      tokenHash: "b".repeat(64),
      ownerHash,
      label: "legacy repository token",
      scopes: ["repo:write"],
      org: "alpha",
      repo: "widget",
      createdAt: new Date().toISOString(),
      expiresAt: null,
    },
  ]),
);
const migrated = new PersonalAccessTokenStore(legacyFile);
const migratedRecords = migrated.listForOwner(ownerHash);
assert.deepEqual(
  migratedRecords.find((record) => record.label === "legacy repository token").orgs,
  ["alpha"],
  "legacy repository-bound PAT retains its organization grant",
);
assert.deepEqual(
  migratedRecords.find((record) => record.label === "legacy owner-bound token").orgs,
  [],
  "legacy owner-wide PAT is migrated with no organization grants",
);
fs.rmSync(directory, { recursive: true, force: true });
console.log("Personal access token store tests passed.");
