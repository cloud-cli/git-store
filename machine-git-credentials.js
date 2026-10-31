import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const idPattern = /^mgc_[a-f0-9]{24}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const secretPattern = /^gmc_[A-Za-z0-9_-]{43}$/;
const orgPattern = /^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/;
const repoPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const digest = (token) => crypto.createHash("sha256").update(token).digest("hex");

function publicRecord({ tokenHash: _tokenHash, ...record }) {
  return { ...record, scopes: [...record.scopes] };
}

export class MachineGitCredentialStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.records = new Map();
    this.hashes = new Map();
    this.load();
  }

  load() {
    this.records = new Map();
    this.hashes = new Map();
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
      throw new Error("Machine credential store must be a regular file");
    }
    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    if (!Array.isArray(parsed)) {
      throw new Error("Machine credential store contains invalid data");
    }
    for (const record of parsed) {
      if (
        !record ||
        !idPattern.test(record.id) ||
        !hashPattern.test(record.tokenHash) ||
        typeof record.org !== "string" ||
        !orgPattern.test(record.org) ||
        !(record.repo === null || (typeof record.repo === "string" && repoPattern.test(record.repo))) ||
        typeof record.label !== "string" ||
        !record.label ||
        record.label.length > 100 ||
        !Array.isArray(record.scopes) ||
        !record.scopes.length ||
        record.scopes.some((scope) => !["repo:read", "repo:write"].includes(scope)) ||
        new Set(record.scopes).size !== record.scopes.length ||
        typeof record.createdAt !== "string" ||
        !Number.isFinite(Date.parse(record.createdAt)) ||
        !(
          record.expiresAt === null ||
          (typeof record.expiresAt === "string" && Number.isFinite(Date.parse(record.expiresAt)))
        ) ||
        this.records.has(record.id) ||
        this.hashes.has(record.tokenHash)
      ) {
        throw new Error("Machine credential store contains invalid data");
      }
      this.records.set(record.id, { ...record, scopes: [...record.scopes] });
      this.hashes.set(record.tokenHash, record.id);
    }
    fs.chmodSync(this.filePath, 0o600);
  }

  persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify([...this.records.values()]), {
        flag: "wx",
        mode: 0o600,
      });
      fs.renameSync(temporary, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
    } catch (error) {
      try {
        fs.unlinkSync(temporary);
      } catch {}
      throw error;
    }
  }

  create({ org, repo = null, label, scopes, expiresAt = null }) {
    this.load();
    if (
      typeof org !== "string" ||
      !orgPattern.test(org) ||
      !(repo === null || (typeof repo === "string" && repoPattern.test(repo))) ||
      typeof label !== "string" ||
      !label.trim() ||
      label.trim().length > 100 ||
      !Array.isArray(scopes) ||
      !scopes.length ||
      scopes.some((scope) => !["repo:read", "repo:write"].includes(scope)) ||
      new Set(scopes).size !== scopes.length ||
      !(expiresAt === null || (typeof expiresAt === "string" && Number.isFinite(Date.parse(expiresAt)))) ||
      (expiresAt !== null && Date.parse(expiresAt) <= Date.now())
    ) {
      throw new TypeError("Invalid machine Git credential details");
    }
    const token = `gmc_${crypto.randomBytes(32).toString("base64url")}`;
    const record = {
      id: `mgc_${crypto.randomBytes(12).toString("hex")}`,
      tokenHash: digest(token),
      org,
      repo,
      label: label.trim(),
      scopes: [...scopes],
      createdAt: new Date().toISOString(),
      expiresAt,
    };
    this.records.set(record.id, record);
    this.hashes.set(record.tokenHash, record.id);
    try {
      this.persist();
    } catch (error) {
      this.records.delete(record.id);
      this.hashes.delete(record.tokenHash);
      throw error;
    }
    return { token, record: publicRecord(record) };
  }

  authenticate(token) {
    this.load();
    if (typeof token !== "string" || !token.startsWith("gmc_")) {
      return { recognized: false, claims: null };
    }
    if (!secretPattern.test(token)) {
      return { recognized: true, claims: null };
    }
    const record = this.records.get(this.hashes.get(digest(token)));
    if (!record) {
      return { recognized: true, claims: null };
    }
    if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) {
      return { recognized: true, claims: null };
    }
    return {
      recognized: true,
      claims: {
        active: true,
        sub: `machine-git:${record.id}`,
        scope: record.scopes.join(" "),
        machineGitCredential: true,
        credentialId: record.id,
        credentialOrg: record.org,
        credentialRepo: record.repo,
      },
    };
  }

  list(org) {
    this.load();
    return [...this.records.values()].filter((record) => record.org === org).map(publicRecord);
  }

  revoke(org, id) {
    this.load();
    const record = this.records.get(id);
    if (!record || record.org !== org) {
      return false;
    }
    this.records.delete(id);
    this.hashes.delete(record.tokenHash);
    try {
      this.persist();
    } catch (error) {
      this.records.set(id, record);
      this.hashes.set(record.tokenHash, id);
      throw error;
    }
    return true;
  }
}
