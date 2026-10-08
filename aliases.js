const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const aliasFile = path.join(process.env.DATA_PATH, "aliases.json");
const aliasPattern = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9])?$/;

function validAlias(value) {
  return (
    typeof value === "string" &&
    aliasPattern.test(value) &&
    !["api", "git", "ui", "admin", "www"].includes(value.toLowerCase())
  );
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(aliasFile, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function save(aliases) {
  const temporary = `${aliasFile}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(aliases), {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temporary, aliasFile);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

function get(sub) {
  const hashedSub = crypto.createHash("sha256").update(sub).digest("hex");
  return load()[hashedSub] || null;
}

function assign(sub, alias) {
  const hashedSub = crypto.createHash("sha256").update(sub).digest("hex");
  const aliases = load();
  const existing = aliases[hashedSub];
  if (existing) {
    return existing.toLowerCase() === alias.toLowerCase() ? { alias: existing, unchanged: true } : null;
  }
  if (
    Object.entries(aliases).some(([owner, value]) => owner !== hashedSub && value.toLowerCase() === alias.toLowerCase())
  ) {
    return false;
  }
  aliases[hashedSub] = alias;
  save(aliases);
  return { alias, unchanged: false };
}

function owner(alias) {
  const normalized = alias.toLowerCase();
  return Object.entries(load()).find(([, value]) => value.toLowerCase() === normalized)?.[0] || null;
}

module.exports = { validAlias, get, assign, owner };
