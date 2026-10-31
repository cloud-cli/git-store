import crypto from "node:crypto";
import fs from "node:fs/promises";

const idPattern = /^mgc_[a-f0-9]{24}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const secretPattern = /^gmc_[A-Za-z0-9_-]{43}$/;
const orgPattern = /^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/;
const repoPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const digest = (token) => crypto.createHash("sha256").update(token).digest("hex");
const schema = [
  "CREATE TABLE IF NOT EXISTS machine_git_credentials (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, org_slug TEXT NOT NULL, repo TEXT, scopes TEXT NOT NULL, label TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT, revoked_at TEXT, deleted_at TEXT)",
  "CREATE INDEX IF NOT EXISTS machine_git_credentials_org_created ON machine_git_credentials (org_slug, created_at DESC, id DESC)",
  "CREATE TABLE IF NOT EXISTS machine_git_credential_migrations (name TEXT PRIMARY KEY, completed_at TEXT NOT NULL)",
];

function publicRecord(row) {
  return {
    id: row.id,
    org: row.org_slug,
    repo: row.repo,
    scopes: Array.isArray(row.scopes) ? row.scopes : JSON.parse(row.scopes),
    label: row.label,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at || null,
  };
}

function validRecord(record) {
  return (
    record &&
    idPattern.test(record.id) &&
    hashPattern.test(record.tokenHash) &&
    typeof record.org === "string" &&
    orgPattern.test(record.org) &&
    (record.repo === null || (typeof record.repo === "string" && repoPattern.test(record.repo))) &&
    typeof record.label === "string" &&
    record.label &&
    record.label.length <= 100 &&
    Array.isArray(record.scopes) &&
    record.scopes.length &&
    record.scopes.every((scope) => ["repo:read", "repo:write"].includes(scope)) &&
    new Set(record.scopes).size === record.scopes.length &&
    typeof record.createdAt === "string" &&
    Number.isFinite(Date.parse(record.createdAt)) &&
    (record.expiresAt === null ||
      (typeof record.expiresAt === "string" && Number.isFinite(Date.parse(record.expiresAt))))
  );
}

export class MachineGitCredentialStore {
  constructor(client, legacyFilePath = null) {
    this.client = client;
    this.legacyFilePath = legacyFilePath;
    this.initialized = null;
  }

  ensureSchema() {
    if (!this.client) {
      throw new Error("Machine Git credential database is unavailable");
    }
    if (!this.initialized) {
      this.initialized = (async () => {
        for (const statement of schema) {
          await this.client.query("run", statement);
        }
        const columns = await this.client.query("all", "PRAGMA table_info(machine_git_credentials)");
        if (!columns.some((column) => column.name === "revoked_at")) {
          await this.client.query("run", "ALTER TABLE machine_git_credentials ADD COLUMN revoked_at TEXT");
        }
        if (!columns.some((column) => column.name === "deleted_at")) {
          await this.client.query("run", "ALTER TABLE machine_git_credentials ADD COLUMN deleted_at TEXT");
        }
        await this.importLegacy();
      })().catch((error) => {
        this.initialized = null;
        throw error;
      });
    }
    return this.initialized;
  }

  async importLegacy() {
    if (!this.legacyFilePath) {
      return;
    }
    let contents;
    try {
      const stat = await fs.lstat(this.legacyFilePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("Machine credential store must be a regular file");
      }
      contents = await fs.readFile(this.legacyFilePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    const records = JSON.parse(contents);
    if (!Array.isArray(records) || records.some((record) => !validRecord(record))) {
      throw new Error("Machine credential store contains invalid data");
    }
    const ids = new Set(records.map((record) => record.id));
    const hashes = new Set(records.map((record) => record.tokenHash));
    if (ids.size !== records.length || hashes.size !== records.length) {
      throw new Error("Machine credential store contains invalid data");
    }
    const migration = "machine-git-credentials-json-v1";
    const already = await this.client.query(
      "get",
      "SELECT name FROM machine_git_credential_migrations WHERE name = ?",
      [migration],
    );
    if (already) {
      return;
    }
    const statements = records.map((record) => ({
      s: "INSERT INTO machine_git_credentials (id, token_hash, org_slug, repo, scopes, label, created_at, expires_at) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM machine_git_credential_migrations WHERE name = ?)",
      d: [
        record.id,
        record.tokenHash,
        record.org,
        record.repo,
        JSON.stringify(record.scopes),
        record.label,
        record.createdAt,
        record.expiresAt,
        migration,
      ],
      m: "run",
    }));
    statements.push({
      s: "INSERT OR IGNORE INTO machine_git_credential_migrations (name, completed_at) VALUES (?, ?)",
      d: [migration, new Date().toISOString()],
      m: "run",
    });
    await this.client.query("t", statements);
  }

  async create({ org, repo = null, label, scopes, expiresAt = null }) {
    await this.ensureSchema();
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
      !(
        expiresAt === null ||
        (typeof expiresAt === "string" && Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) > Date.now())
      )
    ) {
      throw new TypeError("Invalid machine Git credential details");
    }
    const token = `gmc_${crypto.randomBytes(32).toString("base64url")}`;
    const row = {
      id: `mgc_${crypto.randomBytes(12).toString("hex")}`,
      tokenHash: digest(token),
      org,
      repo,
      label: label.trim(),
      scopes: [...scopes],
      createdAt: new Date().toISOString(),
      expiresAt,
    };
    await this.client.query(
      "run",
      "INSERT INTO machine_git_credentials (id, token_hash, org_slug, repo, scopes, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [row.id, row.tokenHash, row.org, row.repo, JSON.stringify(row.scopes), row.label, row.createdAt, row.expiresAt],
    );
    return {
      token,
      record: {
        id: row.id,
        org: row.org,
        repo: row.repo,
        scopes: [...row.scopes],
        label: row.label,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      },
    };
  }

  async authenticate(token) {
    if (typeof token !== "string" || !token.startsWith("gmc_")) {
      return { recognized: false, claims: null };
    }
    if (!secretPattern.test(token)) {
      return { recognized: true, claims: null };
    }
    await this.ensureSchema();
    const row = await this.client.query(
      "get",
      "SELECT id, org_slug, repo, scopes, expires_at, revoked_at, deleted_at FROM machine_git_credentials WHERE token_hash = ?",
      [digest(token)],
    );
    if (!row || row.revoked_at || row.deleted_at || (row.expires_at && Date.parse(row.expires_at) <= Date.now())) {
      return { recognized: true, claims: null };
    }
    const scopes = Array.isArray(row.scopes) ? row.scopes : JSON.parse(row.scopes);
    return {
      recognized: true,
      claims: {
        active: true,
        sub: `machine-git:${row.id}`,
        scope: scopes.join(" "),
        machineGitCredential: true,
        credentialId: row.id,
        credentialOrg: row.org_slug,
        credentialRepo: row.repo,
      },
    };
  }

  async list(org) {
    await this.ensureSchema();
    const rows = await this.client.query(
      "all",
      "SELECT id, org_slug, repo, scopes, label, created_at, expires_at, revoked_at FROM machine_git_credentials WHERE org_slug = ? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC",
      [org],
    );
    return rows.map(publicRecord);
  }

  async revoke(org, id) {
    await this.ensureSchema();
    const result = await this.client.query(
      "run",
      "UPDATE machine_git_credentials SET revoked_at = COALESCE(revoked_at, ?) WHERE org_slug = ? AND id = ?",
      [new Date().toISOString(), org, id],
    );
    return result.changes > 0;
  }

  async hideRevoked(org, id) {
    await this.ensureSchema();
    const result = await this.client.query(
      "run",
      "UPDATE machine_git_credentials SET deleted_at = COALESCE(deleted_at, ?) WHERE org_slug = ? AND id = ? AND revoked_at IS NOT NULL AND deleted_at IS NULL",
      [new Date().toISOString(), org, id],
    );
    return result.changes > 0;
  }
}
