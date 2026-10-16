import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { atomicCommit } from "../git.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmini-atomic-test-"));
const repo = path.join(dir, "repo");
fs.mkdirSync(repo);
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
try {
  git("init", "-b", "main");
  git("config", "user.name", "Existing");
  git("config", "user.email", "existing@local");
  fs.writeFileSync(path.join(repo, "old.txt"), "old\n");
  git("add", "old.txt");
  git("commit", "-m", "initial");
  const expected = git("rev-parse", "refs/heads/main");
  fs.writeFileSync(path.join(repo, "staged.txt"), "keep staged");
  git("add", "staged.txt");
  const indexBefore = fs.readFileSync(path.join(repo, ".git", "index"));
  const result = await atomicCommit(repo, expected, "atomic changes", [
    { path: "new.txt", content: Buffer.from("new\n").toString("base64") },
    { path: "old.txt", content: Buffer.from("updated\n").toString("base64") },
    { path: "staged.txt", delete: true },
    { path: "absent.txt", delete: true },
  ]);
  assert.equal(result.stale, undefined);
  assert.equal(git("rev-list", "--count", `${expected}..${result.commit}`), "1");
  assert.equal(git("show", `${result.commit}:new.txt`), "new");
  assert.equal(git("show", `${result.commit}:old.txt`), "updated");
  assert.equal(git("ls-tree", "--name-only", result.commit).includes("staged.txt"), false);
  assert.deepEqual(fs.readFileSync(path.join(repo, ".git", "index")), indexBefore);
  git("branch", "feature");
  const featureRef = git("rev-parse", "refs/heads/feature");
  const featureResult = await atomicCommit(
    repo,
    featureRef,
    "feature change",
    [{ path: "feature.txt", content: "ZmVhdHVyZQ==" }],
    "feature",
  );
  assert.equal(git("rev-parse", "refs/heads/feature"), featureResult.commit);
  assert.equal(git("rev-parse", "refs/heads/main"), result.commit);
  assert.equal(
    (await atomicCommit(repo, featureRef, "stale feature", [{ path: "x", content: "eA==" }], "feature")).stale,
    true,
  );
  assert.equal(fs.readFileSync(path.join(repo, "old.txt"), "utf8"), "old\n");
  assert.equal((await atomicCommit(repo, expected, "stale", [{ path: "x", content: "eA==" }])).stale, true);
  const sha256Repo = path.join(dir, "sha256-repo");
  fs.mkdirSync(sha256Repo);
  execFileSync("git", ["init", "--object-format=sha256", "-b", "main"], { cwd: sha256Repo });
  const sha256Commit = await atomicCommit(sha256Repo, null, "first commit", [
    { path: "first.txt", content: Buffer.from("sha256\n").toString("base64") },
  ]);
  assert.equal(sha256Commit.commit.length, 64);
  assert.equal(
    execFileSync("git", ["rev-parse", "refs/heads/main"], { cwd: sha256Repo, encoding: "utf8" }).trim(),
    sha256Commit.commit,
  );
  console.log("Atomic commit tests passed.");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
