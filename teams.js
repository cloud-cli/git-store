import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const roles = ["viewer", "contributor", "admin"];
const hashPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[0-9a-f-]{36}$/;
const lifetime = 30 * 24 * 60 * 60 * 1000;

/** Persistent team roster and invitations; only irreversible subject hashes are stored. */
export class TeamStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = { version: 1, owners: [], members: [], invitations: [] };
    this.load();
  }

  load() {
    if (!this.filePath) {
      return;
    }
    let stat;
    try {
      stat = fs.lstatSync(this.filePath);
    } catch (error) {
      if (error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Team store must be a regular file");
    }
    const value = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    if (
      value?.version !== 1 ||
      !Array.isArray(value.owners || []) ||
      !Array.isArray(value.members) ||
      !Array.isArray(value.invitations)
    ) {
      throw new Error("Invalid team store");
    }
    if (!(value.owners || []).every((ownerHash) => hashPattern.test(ownerHash))) {
      throw new Error("Invalid team owners");
    }
    const validMember = (m) =>
      m &&
      idPattern.test(m.id) &&
      hashPattern.test(m.subjectHash) &&
      hashPattern.test(m.ownerHash) &&
      m.subjectHash !== m.ownerHash &&
      (value.owners || []).includes(m.ownerHash) &&
      roles.includes(m.role) &&
      Number.isFinite(m.joinedAt);
    const validInvite = (i) =>
      i &&
      idPattern.test(i.id) &&
      hashPattern.test(i.subjectHash) &&
      hashPattern.test(i.ownerHash) &&
      i.subjectHash !== i.ownerHash &&
      (value.owners || []).includes(i.ownerHash) &&
      roles.includes(i.role) &&
      Number.isFinite(i.createdAt) &&
      Number.isFinite(i.expiresAt) &&
      i.expiresAt > i.createdAt;
    const memberKeys = value.members.map((m) => `${m?.ownerHash}:${m?.subjectHash}`);
    const memberIds = value.members.map((m) => m?.id);
    const inviteIds = value.invitations.map((i) => i?.id);
    if (
      new Set(value.owners).size !== value.owners.length ||
      !value.members.every(validMember) ||
      !value.invitations.every(validInvite) ||
      new Set(memberKeys).size !== memberKeys.length ||
      new Set(memberIds).size !== memberIds.length ||
      new Set(inviteIds).size !== inviteIds.length
    ) {
      throw new Error("Invalid team store records");
    }
    this.state = value;
    this.state.owners ||= [];
    fs.chmodSync(this.filePath, 0o600);
  }

  persist() {
    if (!this.filePath) {
      return;
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temp = `${this.filePath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600, flag: "wx" });
      fs.renameSync(temp, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
    } finally {
      try {
        fs.unlinkSync(temp);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }

  mutate(update) {
    const previous = this.state;
    this.state = {
      ...previous,
      owners: [...previous.owners],
      members: previous.members.map((entry) => ({ ...entry })),
      invitations: previous.invitations.map((entry) => ({ ...entry })),
    };
    try {
      const result = update();
      this.persist();
      return result;
    } catch (error) {
      this.state = previous;
      throw error;
    }
  }

  registerOwner(ownerHash) {
    if (!hashPattern.test(ownerHash)) {
      throw new Error("Invalid owner");
    }
    if (!this.state.owners.includes(ownerHash)) {
      this.mutate(() => this.state.owners.push(ownerHash));
    }
  }
  isOwner(ownerHash) {
    return this.state.owners.includes(ownerHash);
  }
  members(ownerHash) {
    return this.state.members.filter((entry) => entry.ownerHash === ownerHash).map((entry) => ({ ...entry }));
  }
  invitations(ownerHash, now = Date.now()) {
    return this.state.invitations
      .filter((entry) => entry.ownerHash === ownerHash && entry.expiresAt > now)
      .map((entry) => ({ ...entry }));
  }
  roleFor(subjectHash, ownerHash) {
    return (
      this.state.members.find((m) => m.subjectHash === subjectHash && (!ownerHash || m.ownerHash === ownerHash))
        ?.role || null
    );
  }
  membershipsFor(subjectHash) {
    return this.state.members.filter((m) => m.subjectHash === subjectHash).map((m) => ({ ...m }));
  }
  incoming(subjectHash, now = Date.now()) {
    return this.state.invitations
      .filter((i) => i.subjectHash === subjectHash && i.expiresAt > now)
      .map((i) => ({ ...i }));
  }
  invite(ownerHash, subjectHash, role, now = Date.now()) {
    if (
      !hashPattern.test(ownerHash) ||
      !hashPattern.test(subjectHash) ||
      !this.state.owners.includes(ownerHash) ||
      ownerHash === subjectHash ||
      !roles.includes(role)
    ) {
      throw new Error("Invalid invitation");
    }
    if (
      this.state.members.some((m) => m.subjectHash === subjectHash && m.ownerHash === ownerHash) ||
      this.state.invitations.some(
        (i) => i.ownerHash === ownerHash && i.subjectHash === subjectHash && i.expiresAt > now,
      )
    ) {
      throw new Error("Duplicate invitation");
    }
    const entry = { id: crypto.randomUUID(), ownerHash, subjectHash, role, createdAt: now, expiresAt: now + lifetime };
    return this.mutate(() => {
      this.state.invitations.push(entry);
      return { ...entry };
    });
  }
  revoke(ownerHash, id) {
    if (!this.state.invitations.some((i) => i.ownerHash === ownerHash && i.id === id)) {
      return false;
    }
    return this.mutate(() => {
      this.state.invitations = this.state.invitations.filter((i) => !(i.ownerHash === ownerHash && i.id === id));
      return true;
    });
  }
  accept(id, subjectHash, now = Date.now()) {
    const invite = this.state.invitations.find((i) => i.id === id);
    if (!invite || invite.subjectHash !== subjectHash || invite.expiresAt <= now) {
      return false;
    }
    if (this.state.members.some((m) => m.subjectHash === subjectHash && m.ownerHash === invite.ownerHash)) {
      return false;
    }
    return this.mutate(() => {
      this.state.invitations = this.state.invitations.filter((i) => i.id !== id);
      this.state.members.push({
        id: crypto.randomUUID(),
        ownerHash: invite.ownerHash,
        subjectHash,
        role: invite.role,
        joinedAt: now,
      });
      return true;
    });
  }
  setRole(ownerHash, id, role) {
    if (!roles.includes(role)) {
      return false;
    }
    const member = this.state.members.find((m) => m.ownerHash === ownerHash && m.id === id);
    if (!member) {
      return false;
    }
    return this.mutate(() => {
      const updated = this.state.members.find((m) => m.ownerHash === ownerHash && m.id === id);
      updated.role = role;
      return true;
    });
  }
  remove(ownerHash, id) {
    if (!this.state.members.some((m) => m.ownerHash === ownerHash && m.id === id)) {
      return false;
    }
    return this.mutate(() => {
      this.state.members = this.state.members.filter((m) => !(m.ownerHash === ownerHash && m.id === id));
      return true;
    });
  }
}

export { roles as TEAM_ROLES };
