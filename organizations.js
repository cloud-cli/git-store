const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { hashSubject, DATA_PATH } = require("./storage");

const organizationsPath = path.join(DATA_PATH, "orgs");
const registryPath = path.join(DATA_PATH, "organizations.json");
const metadataName = ".organization.json";
const slugPattern = /^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/;
const ownerPattern = /^[a-f0-9]{64}$/;
let index = new Map();

function normalizeSlug(value) {
  if (typeof value !== "string") {
    return null;
  }
  const slug = value.toLowerCase();
  return slugPattern.test(slug) ? slug : null;
}

function isCanonicalSlug(value) {
  return typeof value === "string" && normalizeSlug(value) === value;
}

function lstatIfExists(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function parseMetadata(file, expectedSlug) {
  const stat = lstatIfExists(file);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Invalid organization metadata file");
  }
  const metadata = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    !metadata ||
    metadata.slug !== expectedSlug ||
    typeof metadata.ownerHash !== "string" ||
    !ownerPattern.test(metadata.ownerHash)
  ) {
    throw new Error("Invalid organization metadata");
  }
  return { slug: expectedSlug, ownerHash: metadata.ownerHash };
}

function migrate() {
  const registryStat = lstatIfExists(registryPath);
  if (!registryStat) {
    return;
  }
  if (!registryStat.isFile() || registryStat.isSymbolicLink()) {
    throw new Error("Organization migration deferred: organizations.json is not a regular file");
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  } catch (error) {
    throw new Error(`Organization migration deferred: unable to parse organizations.json (${error.message})`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Organization migration deferred: organizations.json must contain an array");
  }
  const entries = [];
  let invalidEntries = false;
  for (const item of parsed) {
    if (
      !item ||
      !isCanonicalSlug(item.slug) ||
      typeof item.ownerHash !== "string" ||
      !ownerPattern.test(item.ownerHash)
    ) {
      invalidEntries = true;
      continue;
    }
    entries.push({ slug: item.slug, ownerHash: item.ownerHash });
  }
  const seen = new Set();
  const duplicates = new Set();
  const uniqueEntries = [];
  for (const entry of entries) {
    if (seen.has(entry.slug)) {
      invalidEntries = true;
      duplicates.add(entry.slug);
      continue;
    }
    seen.add(entry.slug);
    uniqueEntries.push(entry);
  }
  const migrationEntries = uniqueEntries.filter((entry) => !duplicates.has(entry.slug));
  if (duplicates.size > 0) {
    invalidEntries = true;
  }
  const safeEntries = [];
  for (const entry of migrationEntries) {
    try {
      const dir = path.join(organizationsPath, entry.slug);
      const directoryStat = lstatIfExists(dir);
      if (directoryStat && !directoryStat.isDirectory()) {
        invalidEntries = true;
        continue;
      }
      const metadata = path.join(dir, metadataName);
      const metadataStat = lstatIfExists(metadata);
      if (metadataStat) {
        if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) {
          invalidEntries = true;
          continue;
        }
        const existing = parseMetadata(metadata, entry.slug);
        if (existing.ownerHash !== entry.ownerHash) {
          invalidEntries = true;
          continue;
        }
      }
      safeEntries.push(entry);
    } catch {
      invalidEntries = true;
    }
  }
  const archive = `${registryPath}.migrated`;
  if (lstatIfExists(archive)) {
    throw new Error("Organization migration failed: organizations.json.migrated already exists");
  }
  fs.mkdirSync(organizationsPath, { recursive: true });
  for (const entry of safeEntries) {
    let temporary;
    try {
      const directory = path.join(organizationsPath, entry.slug);
      fs.mkdirSync(directory, { recursive: true });
      const metadata = path.join(directory, metadataName);
      if (lstatIfExists(metadata)) {
        continue;
      }
      temporary = path.join(directory, `${metadataName}.${crypto.randomBytes(8).toString("hex")}.tmp`);
      fs.writeFileSync(temporary, JSON.stringify(entry), {
        flag: "wx",
        mode: 0o600,
      });
      fs.renameSync(temporary, metadata);
    } catch (error) {
      try {
        if (temporary) {
          fs.unlinkSync(temporary);
        }
      } catch {}
      invalidEntries = true;
      process.stderr.write(`[organizations] migration skipped ${entry.slug}: ${error.message}\n`);
    }
  }
  if (invalidEntries) {
    throw new Error("Organization migration deferred: malformed legacy records were skipped");
  }
  // Hard-link publication is exclusive: concurrent startups cannot overwrite an archive.
  fs.linkSync(registryPath, archive);
  fs.unlinkSync(registryPath);
}

function reload() {
  try {
    migrate();
  } catch (error) {
    process.stderr.write(`[organizations] ${error.message}\n`);
  }
  const next = new Map();
  let dirs;
  try {
    dirs = fs.readdirSync(organizationsPath, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      index = next;
      return;
    }
    throw error;
  }
  for (const entry of dirs) {
    if (!entry.isDirectory() || !isCanonicalSlug(entry.name)) {
      continue;
    }
    try {
      next.set(entry.name, parseMetadata(path.join(organizationsPath, entry.name, metadataName), entry.name));
    } catch (error) {
      process.stderr.write(`[organizations] skipped ${entry.name}: ${error.message}\n`);
    }
  }
  index = next;
}

function listForSubject(sub) {
  const ownerHash = hashSubject(sub);
  return [...index.values()]
    .filter((org) => org.ownerHash === ownerHash)
    .map(({ slug }) => ({ slug }))
    .sort((left, right) => left.slug.localeCompare(right.slug));
}

function get(slug) {
  const normalized = normalizeSlug(slug);
  if (!normalized) {
    return null;
  }
  return index.get(normalized) || null;
}

function create(sub, value) {
  const slug = normalizeSlug(value);
  if (!slug) {
    return null;
  }
  reload();
  if (index.has(slug)) {
    return false;
  }
  fs.mkdirSync(organizationsPath, { recursive: true });
  const dir = path.join(organizationsPath, slug);
  let createdDirectory = false;
  let temporary;
  try {
    fs.mkdirSync(dir);
    createdDirectory = true;
    const organization = { slug, ownerHash: hashSubject(sub) };
    const metadata = path.join(dir, metadataName);
    temporary = path.join(dir, `${metadataName}.${crypto.randomBytes(8).toString("hex")}.tmp`);
    fs.writeFileSync(temporary, JSON.stringify(organization), {
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporary, metadata);
    index.set(slug, organization);
    return { slug };
  } catch (error) {
    try {
      if (temporary) {
        fs.unlinkSync(temporary);
      }
    } catch {}
    try {
      if (createdDirectory) {
        fs.rmdirSync(dir);
      }
    } catch {}
    if (error.code === "EEXIST" || error.code === "ENOTEMPTY") {
      return false;
    }
    throw error;
  }
}

reload();
module.exports = {
  normalizeSlug,
  isCanonicalSlug,
  listForSubject,
  get,
  create,
  reload,
};
