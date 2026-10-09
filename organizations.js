const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { encodeSubjectDir } = require("./storage");

const registryFile = path.join(process.env.DATA_PATH, "organizations.json");
const slugPattern = /^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/;

function normalizeSlug(value) {
  if (typeof value !== "string") {
    return null;
  }
  const slug = value.toLowerCase();
  return slugPattern.test(slug) ? slug : null;
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    if (!Array.isArray(parsed)) {
      throw new Error("Invalid organization registry");
    }
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function save(organizations) {
  const temporary = `${registryFile}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let saveError;
  try {
    fs.writeFileSync(temporary, JSON.stringify(organizations), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, registryFile);
  } catch (error) {
    saveError = error;
  }
  try {
    fs.unlinkSync(temporary);
  } catch (error) {
    if (error.code !== "ENOENT" && !saveError) {
      saveError = error;
    }
  }
  if (saveError) {
    throw saveError;
  }
}

function listForSubject(sub) {
  const ownerHash = encodeSubjectDir(sub);
  return load()
    .filter((organization) => organization.ownerHash === ownerHash)
    .map(({ slug }) => ({ slug }));
}

function get(slug) {
  const normalized = normalizeSlug(slug);
  if (!normalized) {
    return null;
  }
  return load().find((organization) => organization.slug === normalized) || null;
}

function create(sub, value) {
  const slug = normalizeSlug(value);
  if (!slug) {
    return null;
  }
  const organizations = load();
  if (organizations.some((organization) => organization.slug === slug)) {
    return false;
  }
  const organization = {
    id: crypto.randomBytes(16).toString("hex"),
    slug,
    ownerHash: encodeSubjectDir(sub),
  };
  organizations.push(organization);
  save(organizations);
  return { slug: organization.slug };
}

module.exports = { normalizeSlug, listForSubject, get, create };
