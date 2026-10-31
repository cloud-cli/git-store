import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MachineGitCredentialStore } from "../machine-git-credentials.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-store-machine-creds-"));
try {
  const file = path.join(root, "credentials.json");
  const store = new MachineGitCredentialStore(file);
  const created = store.create({
    org: "acme",
    repo: "repo-a",
    label: "deploy",
    scopes: ["repo:read", "repo:write"],
  });
  assert.match(created.token, /^gmc_/);
  assert.equal(fs.readFileSync(file, "utf8").includes(created.token), false);
  assert.equal(fs.statSync(file).mode.toString(8).slice(-3), "600");
  assert.deepEqual(store.authenticate(created.token).claims.credentialOrg, "acme");
  assert.equal(store.list("other").length, 0);
  assert.equal(store.revoke("other", created.record.id), false);
  assert.equal(store.revoke("acme", created.record.id), true);
  assert.deepEqual(store.authenticate(created.token), {
    recognized: true,
    claims: null,
  });
  assert.throws(
    () =>
      store.create({
        org: "acme",
        label: "expired",
        scopes: ["repo:read"],
        expiresAt: new Date(Date.now() - 10).toISOString(),
      }),
    TypeError,
  );
  const expiresSoon = store.create({
    org: "acme",
    label: "short-lived",
    scopes: ["repo:read"],
    expiresAt: new Date(Date.now() + 500).toISOString(),
  });
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  const shortLived = saved.find((record) => record.id === expiresSoon.record.id);
  shortLived.expiresAt = new Date(Date.now() - 1).toISOString();
  fs.writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
  const reloaded = new MachineGitCredentialStore(file);
  assert.equal(reloaded.authenticate(expiresSoon.token).recognized, true);
  assert.equal(reloaded.authenticate(expiresSoon.token).claims, null, "expired secrets do not authenticate");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
