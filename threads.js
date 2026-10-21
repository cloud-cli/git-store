import crypto from "node:crypto";

const schema = [
  "CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, org_slug TEXT NOT NULL, repo TEXT NOT NULL, commit_sha TEXT NOT NULL, path TEXT NOT NULL, selection TEXT NOT NULL, comment TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS threads_repo_commit ON threads (org_slug, repo, commit_sha)",
];

function createThreadStore(client) {
  if (!client) {
    return null;
  }
  let init;
  async function ready() {
    if (!init) {
      init = Promise.all(schema.map((sql) => client.query("run", sql))).catch((error) => {
        init = null;
        throw error;
      });
    }
    return init;
  }
  return {
    async create(thread) {
      await ready();
      const record = { id: crypto.randomUUID(), ...thread, createdAt: new Date().toISOString() };
      await client.query(
        "run",
        "INSERT INTO threads (id, org_slug, repo, commit_sha, path, selection, comment, author, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          record.id,
          record.org,
          record.repo,
          record.commit,
          record.path,
          JSON.stringify(record.selection),
          record.comment,
          record.author,
          record.createdAt,
        ],
      );
      return record;
    },
  };
}

export { createThreadStore };
