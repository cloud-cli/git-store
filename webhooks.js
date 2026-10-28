import crypto from "node:crypto";
import dns from "node:dns/promises";
import https from "node:https";
import net from "node:net";

const MAX_SUBSCRIPTIONS = 20;
const MAX_QUEUE = 100;
const CONCURRENCY = 4;
const events = new Set(["git", "repo", "thread"]);
function isWebhookEvent(event) {
  return events.has(event) || (event.startsWith("git.") && events.has("git"));
}
function normalizeAuditEvent(event) {
  const match = /^(?:repository\.(?:branch|tag)|git\.(?:branch|tag))\.(created|updated|deleted)$/.exec(event);
  if (match) {
    const [, action] = match;
    return { event: `git.${event.split(".")[1]}`, action };
  }
  const repoEvent = /^repository\.(created|deleted)$/.exec(event);
  if (repoEvent) {
    return { event: "repo", action: repoEvent[1] };
  }
  const threadEvent = /^thread\.(created|updated|deleted)$/.exec(event);
  if (threadEvent) {
    return { event: "thread", action: threadEvent[1] };
  }
  return null;
}
function createPushWebhookEvent({ id, org, occurredAt, object, changes }) {
  return {
    id,
    org,
    event: "git.push",
    action: "pushed",
    occurredAt,
    object,
    details: { changes },
  };
}
function serializeWebhookPayload(record) {
  return JSON.stringify({
    id: record.id,
    org: record.org,
    event: record.event,
    ...(record.action ? { action: record.action } : {}),
    occurredAt: record.occurredAt,
    object: record.object,
    details: record.details,
  });
}
const statements = [
  "CREATE TABLE IF NOT EXISTS org_webhooks (id TEXT PRIMARY KEY, org_slug TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL, events TEXT NOT NULL, created_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS org_webhooks_org ON org_webhooks (org_slug)",
];
const encryptedSecret = (secret, key) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${data.toString("base64url")}`;
};
const decryptSecret = (value, key) => {
  const [version, iv, tag, data] = value.split(":");
  if (version !== "v1" || !iv || !tag || !data) {
    throw new Error("Invalid encrypted webhook secret");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
};
function getEncryptionKey(hex) {
  return typeof hex === "string" && /^[0-9a-fA-F]{64}$/.test(hex) ? Buffer.from(hex, "hex") : null;
}
function createWebhookStore(client, key) {
  if (!client || !key) {
    return null;
  }
  let init;
  async function ready() {
    if (!init) {
      init = (async () => {
        await client.query("run", statements[0]);
        try {
          await client.query("run", "ALTER TABLE org_webhooks ADD COLUMN allowed_ip_ranges TEXT NOT NULL DEFAULT '[]'");
        } catch (error) {
          if (!/duplicate column|already exists/i.test(error.message || "")) {
            throw error;
          }
        }
        await client.query("run", statements[1]);
      })().catch((error) => {
        init = null;
        throw error;
      });
    }
    return init;
  }
  return {
    async list(org) {
      await ready();
      const rows = await client.query(
        "all",
        "SELECT id, org_slug AS org, url, events, allowed_ip_ranges AS allowedIpRanges, created_at AS createdAt FROM org_webhooks WHERE org_slug = ?",
        [org],
      );
      return rows.map((row) => ({
        ...row,
        events: JSON.parse(row.events),
        allowedIpRanges: JSON.parse(row.allowedIpRanges || "[]"),
      }));
    },
    async create(record) {
      await ready();
      const count = await client.query("all", "SELECT id FROM org_webhooks WHERE org_slug = ?", [record.org]);
      if (count.length >= MAX_SUBSCRIPTIONS) {
        throw new Error("Webhook subscription limit reached");
      }
      await client.query(
        "run",
        "INSERT INTO org_webhooks (id, org_slug, url, secret, events, allowed_ip_ranges, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          record.id,
          record.org,
          record.url,
          encryptedSecret(record.secret, key),
          JSON.stringify(record.events),
          JSON.stringify(record.allowedIpRanges || []),
          record.createdAt,
        ],
      );
    },
    async remove(org, id) {
      await ready();
      const result = await client.query("run", "DELETE FROM org_webhooks WHERE org_slug = ? AND id = ?", [org, id]);
      return result?.changes !== 0;
    },
    async matching(org, event) {
      await ready();
      const rows = await client.query(
        "all",
        "SELECT id, url, secret, events, allowed_ip_ranges AS allowedIpRanges FROM org_webhooks WHERE org_slug = ?",
        [org],
      );
      return rows
        .filter((row) => {
          const subscriptions = JSON.parse(row.events);
          const legacy = {
            repo: ["repository.created", "repository.deleted", "repository"],
            "repository.commit": ["repository.commit.created"],
            "repository.branch": ["repository.branch.created", "repository.branch.deleted"],
            "repository.tag": ["repository.tag.created", "repository.tag.deleted"],
            "repository.file": ["repository.file.uploaded", "repository.file.deleted"],
            "git.branch": [
              "git.branch.created",
              "git.branch.deleted",
              "git.branch.updated",
              "repository.branch.created",
              "repository.branch.deleted",
            ],
            "git.tag": [
              "git.tag.created",
              "git.tag.deleted",
              "git.tag.updated",
              "repository.tag.created",
              "repository.tag.deleted",
            ],
            git: [
              "git.push",
              "git.branch.created",
              "git.branch.deleted",
              "git.branch.updated",
              "git.tag.created",
              "git.tag.deleted",
              "git.tag.updated",
              "repository.branch.created",
              "repository.branch.deleted",
              "repository.branch.updated",
              "repository.tag.created",
              "repository.tag.deleted",
              "repository.tag.updated",
            ],
            thread: ["thread.created", "thread.updated", "thread.deleted"],
          };
          return (
            subscriptions.includes(event) ||
            (event.startsWith("git.") && subscriptions.includes("git")) ||
            (event === "repo" && subscriptions.includes("repo")) ||
            (legacy[event] || []).some((name) => subscriptions.includes(name))
          );
        })
        .map((row) => ({
          id: row.id,
          url: row.url,
          secret: decryptSecret(row.secret, key),
          allowedIpRanges: JSON.parse(row.allowedIpRanges || "[]"),
        }));
    },
  };
}

function ipv4Public(address) {
  const p = address.split(".").map(Number);
  if (p.length !== 4) {
    return false;
  }
  const [a, b] = p;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 192 && b === 88)
  );
}
function ipv6Bytes(address) {
  let input = address.toLowerCase();
  const mapped = /(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(input);
  if (mapped) {
    return { mapped: mapped[1] };
  }
  if (input.includes(".")) {
    return null;
  }
  const halves = input.split("::");
  if (halves.length > 2) {
    return null;
  }
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const groups = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[\da-f]{1,4}$/.test(group))) {
    return null;
  }
  return Buffer.from(
    groups.flatMap((group) => {
      const n = Number.parseInt(group, 16);
      return [n >> 8, n & 255];
    }),
  );
}
function isPublicAddress(address) {
  const version = net.isIP(address);
  if (version === 4) {
    return ipv4Public(address);
  }
  if (version !== 6) {
    return false;
  }
  const bytes = ipv6Bytes(address);
  if (!bytes) {
    return false;
  }
  if (bytes.mapped) {
    return ipv4Public(bytes.mapped);
  }
  const first = bytes[0];
  // Globally routable unicast is 2000::/3. Exclude special-use allocations within it.
  return (first & 0xe0) === 0x20 && !(bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8);
}
function parseAllowedIpRanges(input) {
  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > 4096) {
      return null;
    }
    input = input
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (!Array.isArray(input) || input.length > 64) {
    return null;
  }
  const output = [];
  for (const entry of input) {
    if (typeof entry !== "string" || entry.length > 64) {
      return null;
    }
    const value = entry.trim();
    const match = /^(.+)\/(\d{1,3})$/.exec(value);
    if (!match) {
      return null;
    }
    const [, address, prefixText] = match;
    const family = net.isIP(address);
    const prefix = Number(prefixText);
    const bits = family === 4 ? 32 : family === 6 ? 128 : 0;
    if (!bits || prefix > bits || (prefixText.length > 1 && prefixText.startsWith("0"))) {
      return null;
    }
    output.push(`${address.toLowerCase()}/${prefix}`);
  }
  return [...new Set(output)];
}
function ipNumber(address) {
  const family = net.isIP(address);
  if (family === 4) {
    return { family, value: address.split(".").reduce((result, part) => (result << 8n) | BigInt(part), 0n) };
  }
  const bytes = ipv6Bytes(address);
  if (!bytes) {
    return null;
  }
  if (bytes.mapped) {
    return ipNumber(bytes.mapped);
  }
  return {
    family,
    value: bytes.reduce((result, byte) => (result << 8n) | BigInt(byte), 0n),
  };
}
function isAddressInAllowedRanges(address, ranges = []) {
  const ip = ipNumber(address);
  if (!ip) {
    return false;
  }
  return ranges.some((range) => {
    const [network, prefixText] = range.split("/");
    const cidrIp = ipNumber(network);
    const prefix = Number(prefixText);
    if (!cidrIp || cidrIp.family !== ip.family) {
      return false;
    }
    const bits = ip.family === 4 ? 32 : 128;
    const shift = BigInt(bits - prefix);
    return ip.value >> shift === cidrIp.value >> shift;
  });
}
async function resolveTarget(raw, allowedIpRanges = []) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    return null;
  }
  try {
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = net.isIP(hostname)
      ? [{ address: hostname, family: net.isIP(hostname) }]
      : await dns.lookup(hostname, { all: true, verbatim: true });
    if (
      !addresses.length ||
      addresses.some(({ address }) => !isPublicAddress(address) && !isAddressInAllowedRanges(address, allowedIpRanges))
    ) {
      return null;
    }
    return {
      url,
      hostname,
      address: addresses[0].address,
      family: addresses[0].family,
    };
  } catch {
    return null;
  }
}
async function validateTarget(raw, allowedIpRanges = []) {
  return Boolean(await resolveTarget(raw, allowedIpRanges));
}
function requestPinned(target, body, headers, signal) {
  return new Promise((resolve, reject) => {
    const { url, hostname, address, family } = target;
    const request = https.request(
      url,
      {
        method: "POST",
        headers,
        signal,
        ...(net.isIP(hostname) ? {} : { servername: hostname }),
        lookup: (_host, _options, callback) => callback(null, address, family),
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}
let active = 0;
const queue = [];
async function runQueue(task) {
  if (queue.length >= MAX_QUEUE) {
    return;
  }
  queue.push(task);
  pumpQueue();
}
function pumpQueue() {
  while (active < CONCURRENCY && queue.length) {
    const next = queue.shift();
    active += 1;
    void next()
      .catch(() => {})
      .finally(() => {
        active -= 1;
        pumpQueue();
      });
  }
}
async function deliver(store, record) {
  const targets = await store.matching(record.org, record.event);
  for (const target of targets) {
    await runQueue(async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const pinned = await resolveTarget(target.url, target.allowedIpRanges);
        if (!pinned) {
          return;
        }
        const body = serializeWebhookPayload(record);
        const signature = crypto.createHmac("sha256", target.secret).update(body).digest("hex");
        const controller = new globalThis.AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        try {
          const status = await requestPinned(
            pinned,
            body,
            {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
              "x-gitmini-signature": `sha256=${signature}`,
              "x-gitmini-event": record.event,
              "x-gitmini-delivery": record.id,
            },
            controller.signal,
          );
          if (status >= 200 && status < 300) {
            return;
          }
        } catch {
          /* bounded best-effort retries */
        } finally {
          globalThis.clearTimeout(timer);
        }
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        }
      }
    });
  }
}
export {
  createWebhookStore,
  deliver,
  events,
  isWebhookEvent,
  normalizeAuditEvent,
  createPushWebhookEvent,
  serializeWebhookPayload,
  validateTarget,
  parseAllowedIpRanges,
  isAddressInAllowedRanges,
  getEncryptionKey,
  encryptedSecret,
  decryptSecret,
  isPublicAddress,
  MAX_SUBSCRIPTIONS,
  MAX_QUEUE,
  CONCURRENCY,
};
