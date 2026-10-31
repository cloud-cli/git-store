export function createMachineDatabase({ legacySchema = false } = {}) {
  const records = new Map();
  const migrations = new Set();
  const statements = [];
  const oldColumns = ["id", "token_hash", "org_slug", "repo", "scopes", "label", "created_at", "expires_at"];
  let columns = new Set(legacySchema ? oldColumns : []);
  let credentialsTableCreated = legacySchema;
  async function execute(statement, bindings = []) {
    if (statement.startsWith("SELECT name FROM machine_git_credential_migrations")) {
      return migrations.has(bindings[0]) ? { name: bindings[0] } : null;
    }
    if (statement.startsWith("INSERT INTO machine_git_credentials") && statement.includes("SELECT ?, ?")) {
      if (!migrations.has(bindings[8]) && !records.has(bindings[0])) {
        records.set(bindings[0], {
          id: bindings[0],
          token_hash: bindings[1],
          org_slug: bindings[2],
          repo: bindings[3],
          scopes: bindings[4],
          label: bindings[5],
          created_at: bindings[6],
          expires_at: bindings[7],
          revoked_at: null,
          deleted_at: null,
        });
      }
      return { changes: 1 };
    }
    if (statement.startsWith("INSERT OR IGNORE INTO machine_git_credential_migrations")) {
      migrations.add(bindings[0]);
      return { changes: 1 };
    }
    if (statement.startsWith("INSERT INTO machine_git_credentials")) {
      if ([...records.values()].some((record) => record.token_hash === bindings[1])) {
        throw new Error("unique token hash");
      }
      records.set(bindings[0], {
        id: bindings[0],
        token_hash: bindings[1],
        org_slug: bindings[2],
        repo: bindings[3],
        scopes: bindings[4],
        label: bindings[5],
        created_at: bindings[6],
        expires_at: bindings[7],
        revoked_at: null,
        deleted_at: null,
      });
      return { changes: 1 };
    }
    if (statement.startsWith("UPDATE machine_git_credentials SET revoked_at")) {
      const record = records.get(bindings[2]);
      if (record?.org_slug !== bindings[1]) {
        return { changes: 0 };
      }
      record.revoked_at ||= bindings[0];
      return { changes: 1 };
    }
    if (statement.startsWith("UPDATE machine_git_credentials SET deleted_at")) {
      const record = records.get(bindings[2]);
      if (record?.org_slug !== bindings[1] || !record.revoked_at || record.deleted_at) {
        return { changes: 0 };
      }
      record.deleted_at = bindings[0];
      return { changes: 1 };
    }
    if (statement.includes("WHERE token_hash = ?")) {
      return [...records.values()].find((record) => record.token_hash === bindings[0]) || null;
    }
    if (statement.includes("WHERE org_slug = ? AND id = ?")) {
      const record = records.get(bindings[1]);
      return { changes: record?.org_slug === bindings[0] ? 1 : 0 };
    }
    if (statement.includes("WHERE org_slug = ?")) {
      return [...records.values()].filter((record) => record.org_slug === bindings[0] && !record.deleted_at);
    }
    return { changes: 0 };
  }
  return {
    records,
    migrations,
    statements,
    columns,
    async query(mode, statement, bindings) {
      statements.push({ mode, statement, bindings });
      if (mode === "t") {
        let result;
        for (const entry of statement) {
          result = await execute(entry.s, entry.d);
        }
        return result;
      }
      if (statement.startsWith("CREATE TABLE IF NOT EXISTS machine_git_credentials")) {
        if (!credentialsTableCreated) {
          for (const column of [...oldColumns, "revoked_at", "deleted_at"]) {
            columns.add(column);
          }
          credentialsTableCreated = true;
        }
        return { changes: 0 };
      }
      if (statement === "PRAGMA table_info(machine_git_credentials)") {
        return [...columns].map((name) => ({ name }));
      }
      if (statement.startsWith("ALTER TABLE machine_git_credentials ADD COLUMN ")) {
        const column = statement.split(" ADD COLUMN ")[1].split(/\s+/)[0];
        if (columns.has(column)) {
          throw new Error(`duplicate column name: ${column}`);
        }
        columns.add(column);
        return { changes: 0 };
      }
      if (statement.startsWith("CREATE ")) {
        return { changes: 0 };
      }
      return execute(statement, bindings);
    },
  };
}
