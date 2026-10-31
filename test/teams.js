import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { TeamStore } from "../teams.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-store-team-"));
const store = new TeamStore(path.join(dir, "teams.json"));
const owner = "a".repeat(64),
  member = "b".repeat(64),
  stranger = "c".repeat(64);
const otherOwner = "e".repeat(64);
store.registerOwner(owner);
store.registerOwner(otherOwner);
const invite = store.invite(owner, member, "contributor", 1000);
const crossTeamInvite = store.invite(otherOwner, stranger, "viewer", 1000);
assert.equal(store.accept(invite.id, stranger, 1001), false);
assert.equal(store.accept(invite.id, member, 1001), true);
assert.equal(store.accept(invite.id, member, 1002), false);
assert.equal(store.roleFor(member, owner), "contributor");
assert.equal(store.roleFor(member, stranger), null);
assert.equal(store.members(owner).length, 1);
assert.equal(store.members(otherOwner).length, 0);
const memberId = store.members(owner)[0].id;
assert.equal(store.setRole(owner, memberId, "admin"), true);
assert.equal(store.roleFor(member, owner), "admin");
assert.equal(store.setRole(otherOwner, memberId, "viewer"), false);
assert.equal(store.roleFor(member, owner), "admin");
assert.equal(
  store.invitations(owner).some((entry) => entry.id === crossTeamInvite.id),
  false,
);
assert.equal(store.accept(crossTeamInvite.id, stranger, 1001), true);
const otherMember = store.members(otherOwner)[0];
assert.equal(store.setRole(owner, otherMember.id, "admin"), false);
assert.equal(store.remove(owner, otherMember.id), false);
assert.throws(() => store.invite(owner, member, "viewer", 1002));
const expiring = store.invite(owner, stranger, "viewer", 2000);
assert.equal(store.accept(expiring.id, stranger, expiring.expiresAt), false);
const revoked = store.invite(owner, "d".repeat(64), "viewer", 3000);
assert.equal(store.revoke(owner, revoked.id), true);
assert.equal(store.accept(revoked.id, "d".repeat(64), 3001), false);
const reloaded = new TeamStore(path.join(dir, "teams.json"));
assert.equal(reloaded.roleFor(member, owner), "admin");
assert.equal(reloaded.members(otherOwner).length, 1);
assert.equal(reloaded.members(owner).length, 1);
assert.equal(fs.readFileSync(path.join(dir, "teams.json"), "utf8").includes(member), true);
const blockedParent = path.join(dir, "not-a-directory");
const failingStore = new TeamStore(path.join(blockedParent, "teams.json"));
fs.writeFileSync(blockedParent, "file");
assert.throws(() => failingStore.registerOwner("f".repeat(64)));
assert.equal(failingStore.isOwner("f".repeat(64)), false, "failed writes roll back in-memory owner state");
fs.rmSync(dir, { recursive: true, force: true });
console.log("Team store tests passed.");
