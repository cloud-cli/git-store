export function createMachineDatabase() {
  const records = new Map();
  const migrations = new Set();
  const statements = [];
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
      });
      return { changes: 1 };
    }
    if (statement.includes("WHERE token_hash = ?")) {
      return [...records.values()].find((record) => record.token_hash === bindings[0]) || null;
    }
    if (statement.includes("WHERE org_slug = ? AND id = ?")) {
      const record = records.get(bindings[1]);
      if (record?.org_slug === bindings[0]) {
        records.delete(bindings[1]);
        return { changes: 1 };
      }
      return { changes: 0 };
    }
    if (statement.includes("WHERE org_slug = ?")) {
      return [...records.values()].filter((record) => record.org_slug === bindings[0]);
    }
    return { changes: 0 };
  }
  return {
    records,
    migrations,
    statements,
    async query(mode, statement, bindings) {
      statements.push({ mode, statement, bindings });
      if (mode === "t") {
        let result;
        for (const entry of statement) {
          result = await execute(entry.s, entry.d);
        }
        return result;
      }
      if (statement.startsWith("CREATE ")) {
        return { changes: 0 };
      }
      return execute(statement, bindings);
    },
  };
}
