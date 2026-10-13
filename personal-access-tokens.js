import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const idPattern = /^pat_[a-f0-9]{24}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const slugPattern = /^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/;
const repoPattern = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const secretPattern = /^gmpat_[A-Za-z0-9_-]{43}$/;
const allowedScopes = new Set(["repo:read", "repo:write"]);

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function publicRecord({ tokenHash, ownerHash, ...record }) {
  return { ...record, scopes: [...record.scopes] };
}

function validRecord(record) {
  return Boolean(
    record &&
    idPattern.test(record.id) &&
    hashPattern.test(record.tokenHash) &&
    hashPattern.test(record.ownerHash) &&
    typeof record.label === "string" &&
    record.label.length > 0 &&
    record.label.length <= 100 &&
    Array.isArray(record.scopes) &&
    record.scopes.length === 1 &&
    allowedScopes.has(record.scopes[0]) &&
    typeof record.createdAt === "string" &&
    Number.isFinite(Date.parse(record.createdAt)) &&
    (record.expiresAt === null ||
      (typeof record.expiresAt === "string" &&
        Number.isFinite(Date.parse(record.expiresAt)))) &&
    ((record.org === null && record.repo === null) ||
      (typeof record.org === "string" &&
        slugPattern.test(record.org) &&
        typeof record.repo === "string" &&
        repoPattern.test(record.repo))),
  );
}

/** Persistent store for one-time personal access tokens. Only token hashes and owner hashes are written to disk. */
export class PersonalAccessTokenStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.records = new Map();
    this.hashes = new Map();
    this.load();
  }

  load() {
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
      throw new Error("Personal access token store must be a regular file");
    }
    const records = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    if (
      !Array.isArray(records) ||
      records.some((record) => !validRecord(record))
    ) {
      throw new Error("Personal access token store contains invalid data");
    }
    const next = new Map();
    const hashes = new Set();
    for (const record of records) {
      if (next.has(record.id) || hashes.has(record.tokenHash)) {
        throw new Error(
          "Personal access token store contains duplicate records",
        );
      }
      next.set(record.id, { ...record, scopes: [...record.scopes] });
      hashes.add(record.tokenHash);
    }
    this.records = next;
    this.hashes = new Map(
      [...next.values()].map((record) => [record.tokenHash, record.id]),
    );
    fs.chmodSync(this.filePath, 0o600);
  }

  persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(
        temporaryPath,
        JSON.stringify([...this.records.values()]),
        { flag: "wx", mode: 0o600 },
      );
      fs.renameSync(temporaryPath, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
    } catch (error) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {}
      throw error;
    }
  }

  create({
    ownerHash,
    label,
    scopes,
    org = null,
    repo = null,
    expiresAt = null,
  }) {
    if (
      !hashPattern.test(ownerHash) ||
      typeof label !== "string" ||
      !label.trim() ||
      label.trim().length > 100 ||
      !Array.isArray(scopes) ||
      scopes.length !== 1 ||
      !allowedScopes.has(scopes[0]) ||
      (org === null) !== (repo === null) ||
      (org !== null && (typeof org !== "string" || !slugPattern.test(org))) ||
      (repo !== null &&
        (typeof repo !== "string" || !repoPattern.test(repo))) ||
      (expiresAt !== null &&
        (typeof expiresAt !== "string" ||
          !Number.isFinite(Date.parse(expiresAt))))
    ) {
      throw new TypeError("Invalid personal access token details");
    }
    const token = `gmpat_${crypto.randomBytes(32).toString("base64url")}`;
    const record = {
      id: `pat_${crypto.randomBytes(12).toString("hex")}`,
      tokenHash: hashToken(token),
      ownerHash,
      label: label.trim(),
      scopes: [...scopes],
      org,
      repo,
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
    if (typeof token !== "string" || !secretPattern.test(token)) {
      return { recognized: false, claims: null };
    }
    const tokenHash = hashToken(token);
    const record = this.records.get(this.hashes.get(tokenHash));
    if (
      !record ||
      (record.expiresAt && Date.parse(record.expiresAt) <= Date.now())
    ) {
      return { recognized: true, claims: null };
    }
    return {
      recognized: true,
      claims: {
        active: true,
        sub: `pat:${record.ownerHash}`,
        ownerHash: record.ownerHash,
        scope: record.scopes.join(" "),
        personalAccessToken: true,
        tokenId: record.id,
        tokenResource: { org: record.org, repo: record.repo },
      },
    };
  }

  listForOwner(ownerHash) {
    return [...this.records.values()]
      .filter((record) => record.ownerHash === ownerHash)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(publicRecord);
  }

  revoke(id, ownerHash) {
    const record = this.records.get(id);
    if (!record || record.ownerHash !== ownerHash) {
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

export function normalizeTokenExpiry(value, now = Date.now()) {
  if (value === undefined || value === null || value === "") {
    return { valid: true, expiresAt: null };
  }
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { valid: false, expiresAt: null };
  }
  const midnight = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(midnight.getTime()) ||
    midnight.toISOString().slice(0, 10) !== value
  ) {
    return { valid: false, expiresAt: null };
  }
  const expiresAt = new Date(`${value}T23:59:59.999Z`);
  if (expiresAt.getTime() <= now) {
    return { valid: false, expiresAt: null };
  }
  return { valid: true, expiresAt: expiresAt.toISOString() };
}
