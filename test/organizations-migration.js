const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "org-migration-"));
const script = `
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
process.env.DATA_PATH = ${JSON.stringify(root)};
const orgs = path.join(process.env.DATA_PATH, "orgs");
const registry = path.join(process.env.DATA_PATH, "organizations.json");
const hash = crypto.createHash("sha256").update("private-subject").digest("hex");
const run = require(${JSON.stringify(path.join(__dirname, "..", "organizations.js"))});
const repo = path.join(orgs, "with-repo", "project");
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "data"), "preserve");
fs.writeFileSync(registry, JSON.stringify([
  { slug: "with-repo", ownerHash: hash },
  { slug: "empty-org", ownerHash: hash },
]));
run.reload();
if (!fs.existsSync(path.join(orgs, "empty-org", ".organization.json"))) throw Error("empty org not migrated");
if (fs.readFileSync(path.join(repo, "data"), "utf8") !== "preserve") throw Error("repo data lost");
const metadata = JSON.parse(fs.readFileSync(path.join(orgs, "with-repo", ".organization.json")));
if (metadata.ownerHash !== hash || Object.values(metadata).includes("private-subject")) throw Error("owner metadata incorrect");
if (!fs.existsSync(registry + ".migrated")) throw Error("legacy registry not archived");
run.reload();
if (run.get("with-repo").ownerHash !== hash) throw Error("reload was not idempotent");
if (run.get("WITH-REPO").slug !== "with-repo") throw Error("case-insensitive lookup failed");
fs.mkdirSync(path.join(orgs, "broken"), { recursive: true });
fs.writeFileSync(path.join(orgs, "broken", ".organization.json"), "{");
fs.mkdirSync(path.join(orgs, "BAD"), { recursive: true });
fs.writeFileSync(path.join(orgs, "BAD", ".organization.json"), JSON.stringify({ slug: "bad", ownerHash: hash }));
run.reload();
if (!run.get("empty-org") || run.get("broken") || run.get("BAD")) throw Error("corrupt org isolation failed");
`;
try {
  const valid = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.strictEqual(valid.status, 0, valid.stderr);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

const malformedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "org-malformed-"));
try {
  const hash = require("crypto").createHash("sha256").update("healthy-subject").digest("hex");
  const healthyDir = path.join(malformedRoot, "orgs", "healthy");
  fs.mkdirSync(healthyDir, { recursive: true });
  fs.writeFileSync(path.join(healthyDir, ".organization.json"), JSON.stringify({ slug: "healthy", ownerHash: hash }));
  fs.writeFileSync(path.join(malformedRoot, "organizations.json"), "not-json");
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `process.env.DATA_PATH=${JSON.stringify(malformedRoot)}; const orgs=require(${JSON.stringify(path.join(__dirname, "..", "organizations.js"))}); if(orgs.get("healthy").ownerHash!==${JSON.stringify(hash)}) process.exit(2);`,
    ],
    { encoding: "utf8" },
  );
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(fs.readFileSync(path.join(malformedRoot, "organizations.json"), "utf8"), "not-json");
  assert.strictEqual(fs.existsSync(path.join(malformedRoot, "organizations.json.migrated")), false);

  const mixedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "org-mixed-"));
  try {
    const mixedScript = `
      const fs=require("fs"),path=require("path"),crypto=require("crypto");
      process.env.DATA_PATH=${JSON.stringify(mixedRoot)};
      const hash=crypto.createHash("sha256").update("safe-subject").digest("hex");
      const source=path.join(process.env.DATA_PATH,"organizations.json");
      const unknown=path.join(process.env.DATA_PATH,"orgs","unrecognized");
      const corrupt=path.join(process.env.DATA_PATH,"orgs","corrupt-entry");
      fs.mkdirSync(unknown,{recursive:true});
      fs.mkdirSync(corrupt,{recursive:true});
      fs.writeFileSync(path.join(corrupt,".organization.json"),"not-json");
      fs.writeFileSync(source,JSON.stringify([{slug:"import-me",ownerHash:hash},{slug:"corrupt-entry",ownerHash:hash},{slug:"../escape",ownerHash:hash},{slug:"no-owner",ownerHash:""}]));
      const orgs=require(${JSON.stringify(path.join(__dirname, "..", "organizations.js"))});
      if(orgs.get("import-me").ownerHash!==hash) throw Error("valid entry not imported");
      if(orgs.get("corrupt-entry")) throw Error("corrupt disk metadata was overwritten");
      if(orgs.get("escape") || orgs.get("no-owner")) throw Error("malformed record acquired ownership");
      if(!fs.existsSync(source) || fs.existsSync(source+".migrated")) throw Error("partial source was archived");
      const before=fs.readdirSync(unknown).join();
      if(orgs.create("another-subject","unrecognized")!==false) throw Error("existing directory was overwritten");
      if(fs.readdirSync(unknown).join()!==before) throw Error("existing directory was modified");
    `;
    const mixed = spawnSync(process.execPath, ["-e", mixedScript], { encoding: "utf8" });
    assert.strictEqual(mixed.status, 0, mixed.stderr);
    const source = fs.readFileSync(path.join(mixedRoot, "organizations.json"), "utf8");
    assert.ok(source.includes("../escape"), "original mixed legacy source remains available for recovery");
  } finally {
    fs.rmSync(mixedRoot, { recursive: true, force: true });
  }
} finally {
  fs.rmSync(malformedRoot, { recursive: true, force: true });
}
