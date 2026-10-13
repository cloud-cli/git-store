import crypto from "node:crypto";

const schemaStatements = [
  "CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, org_slug TEXT NOT NULL, issuer TEXT, subject TEXT, actor_name TEXT, event TEXT NOT NULL, object TEXT NOT NULL, origin TEXT NOT NULL, token_fingerprint TEXT, request_id TEXT, ip_address TEXT, user_agent TEXT, details TEXT NOT NULL DEFAULT '{}')",
  "CREATE INDEX IF NOT EXISTS audit_events_org_time ON audit_events (org_slug, occurred_at DESC, id DESC)",
];

function createDatabaseClient(databaseUrl, token = "") {
  if (!databaseUrl) {
    return null;
  }
  const baseUrl = new URL(databaseUrl);
  if (!/^https?:$/.test(baseUrl.protocol)) {
    throw new Error("DATABASE_URL must use HTTP or HTTPS");
  }
  if (baseUrl.pathname.endsWith("/index.mjs")) {
    baseUrl.pathname = baseUrl.pathname.slice(0, -"index.mjs".length);
  }
  if (!baseUrl.pathname.endsWith("/")) {
    baseUrl.pathname += "/";
  }
  const headers = { "content-type": "application/json" };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return {
    async query(mode, statement, bindings) {
      const response = await fetch(new URL("query", baseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify({ s: statement, d: bindings, m: mode }),
      });
      if (!response.ok) {
        throw new Error(`Audit database request failed (${response.status})`);
      }
      return response.json();
    },
  };
}

function createAuditStore(client) {
  if (!client) {
    return null;
  }
  let initialized;
  const ensureSchema = () => {
    if (!initialized) {
      initialized = (async () => {
        for (const statement of schemaStatements) {
          await client.query("run", statement);
        }
      })().catch((error) => {
        initialized = null;
        throw error;
      });
    }
    return initialized;
  };
  return {
    async append(event) {
      await ensureSchema();
      return client.query(
        "run",
        "INSERT INTO audit_events (id, occurred_at, org_slug, issuer, subject, actor_name, event, object, origin, token_fingerprint, request_id, ip_address, user_agent, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          event.id || crypto.randomUUID(),
          event.occurredAt || new Date().toISOString(),
          event.org,
          event.issuer || null,
          event.subject || null,
          event.actorName || null,
          event.event,
          event.object || "",
          event.origin || "unknown",
          event.tokenFingerprint || null,
          event.requestId || null,
          event.ipAddress || null,
          event.userAgent || null,
          JSON.stringify(event.details || {}),
        ],
      );
    },
    async list(org, limit = 50, offset = 0) {
      await ensureSchema();
      return client.query(
        "all",
        "SELECT id, occurred_at AS occurredAt, org_slug AS org, issuer, subject, actor_name AS actorName, event, object, origin, request_id AS requestId, ip_address AS ipAddress, user_agent AS userAgent, details FROM audit_events WHERE org_slug = ? ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?",
        [org, limit, offset],
      );
    },
  };
}

function createTokenFingerprint(token, secret) {
  if (!token || !secret) {
    return null;
  }
  return crypto.createHmac("sha256", secret).update(token).digest("hex");
}

export { createDatabaseClient, createAuditStore, createTokenFingerprint };
