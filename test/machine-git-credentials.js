import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MachineGitCredentialStore } from "../machine-git-credentials.js";
import { createMachineDatabase } from "./fake-machine-db.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "git-store-machine-creds-"));
try {
  const file = path.join(root, "credentials.json");
  const db = createMachineDatabase();
  const store = new MachineGitCredentialStore(db, file);
  const created = await store.create({
    org: "acme",
    repo: "repo-a",
    label: "deploy",
    scopes: ["repo:read", "repo:write"],
  });
  assert.ok(db.statements.some(({ statement }) => statement.includes("token_hash TEXT NOT NULL UNIQUE")));
  assert.ok(db.statements.some(({ statement }) => statement.includes("machine_git_credentials_org_created")));
  assert.ok(
    db.statements.some(
      ({ mode, statement }) => mode === "run" && statement.startsWith("INSERT INTO machine_git_credentials"),
    ),
    "credential creation uses a single atomic SQL insert",
  );
  assert.match(created.token, /^gmc_/);
  assert.equal(
    JSON.stringify(created).includes(crypto.createHash("sha256").update(created.token).digest("hex")),
    false,
  );
  assert.deepEqual((await store.authenticate(created.token)).claims.credentialOrg, "acme");
  assert.equal((await store.list("other")).length, 0);
  assert.equal(await store.revoke("other", created.record.id), false);
  assert.equal(await store.revoke("acme", created.record.id), true);
  assert.deepEqual(await store.authenticate(created.token), {
    recognized: true,
    claims: null,
  });

  const expiresSoon = await store.create({
    org: "acme",
    label: "short-lived",
    scopes: ["repo:read"],
    expiresAt: new Date(Date.now() + 50).toISOString(),
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal((await store.authenticate(expiresSoon.token)).claims, null);
  assert.equal(
    (await store.list("acme")).some((record) => record.id === expiresSoon.record.id),
    true,
  );
  await assert.rejects(
    store.create({
      org: "acme",
      label: "expired",
      scopes: ["repo:read"],
      expiresAt: new Date(Date.now() - 10).toISOString(),
    }),
    TypeError,
  );

  const legacyToken = "gmc_" + Buffer.alloc(32, 3).toString("base64url");
  const legacy = {
    id: "mgc_0123456789abcdef01234567",
    tokenHash: crypto.createHash("sha256").update(legacyToken).digest("hex"),
    org: "legacy",
    repo: null,
    label: "old credential",
    scopes: ["repo:read"],
    createdAt: new Date().toISOString(),
    expiresAt: null,
  };
  await fs.writeFile(file, JSON.stringify([legacy]), { mode: 0o600 });
  const legacyDb = createMachineDatabase();
  const migrated = new MachineGitCredentialStore(legacyDb, file);
  assert.equal((await migrated.authenticate(legacyToken)).claims.credentialOrg, "legacy");
  assert.ok(
    legacyDb.statements.some(({ mode }) => mode === "t"),
    "legacy migration is transactional",
  );
  assert.equal(await migrated.revoke("legacy", legacy.id), true);
  const restarted = new MachineGitCredentialStore(legacyDb, file);
  assert.equal(
    (await restarted.authenticate(legacyToken)).claims,
    null,
    "migration marker prevents revoked credentials returning",
  );
  assert.equal(await fs.readFile(file, "utf8").then((contents) => contents.includes(legacyToken)), false);
  assert.equal(legacyDb.migrations.has("machine-git-credentials-json-v1"), true);
  await assert.rejects(new MachineGitCredentialStore(null).authenticate(legacyToken), /unavailable/);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
