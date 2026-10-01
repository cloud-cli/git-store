const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_PATH = process.env.DATA_PATH;

if (!DATA_PATH) {
  throw new Error("DATA_PATH environment variable is not set");
}

if (!fs.existsSync(DATA_PATH)) {
  fs.mkdirSync(DATA_PATH, { recursive: true });
}

/**
 * Derives a stable, safe filesystem directory name from an OIDC subject claim.
 * Uses SHA-256 hashing to produce a deterministic, one-way encoded directory name.
 * This ensures the original subject value is never exposed or stored in the path.
 *
 * @param {string} sub The OIDC subject claim value
 * @returns {string} A filesystem-safe hashed directory name (hex-encoded, lowercase)
 */
function encodeSubjectDir(sub) {
  const hash = crypto.createHash("sha256").update(sub).digest("hex");
  return hash;
}

/**
 * Gets the absolute path to a repository using the hashed subject directory.
 * @param {string} hashedSub The hashed OIDC subject value
 * @param {string} repo The repository short name
 * @returns {string} The directory path
 */
function getRepoPath(hashedSub, repo) {
  return path.join(DATA_PATH, hashedSub, repo);
}

/**
 * Ensures the repository directory exists for the authenticated subject.
 * Creates the hashed subject directory if it doesn't exist.
 * Does NOT create directories for raw nickname/owner values.
 *
 * @param {string} hashedSub The hashed OIDC subject value
 * @param {string} repo The repository short name
 * @returns {string} The directory path
 */
function ensureRepoDir(hashedSub, repo) {
  const repoPath = getRepoPath(hashedSub, repo);
  const subPath = path.join(DATA_PATH, hashedSub);

  if (!fs.existsSync(subPath)) {
    fs.mkdirSync(subPath, { recursive: true });
  }

  if (!fs.existsSync(repoPath)) {
    fs.mkdirSync(repoPath, { recursive: true });
  }

  return repoPath;
}

/**
 * Validates a repository short name.
 * Only alphanumeric characters, dash, and underscore are allowed.
 * Must not be empty and must not start or end with a dash or underscore.
 *
 * @param {string} repo The repository name to validate
 * @returns {boolean} True if the repo name is valid
 */
function validateRepoName(repo) {
  if (!repo || typeof repo !== "string") {
    return false;
  }
  if (repo.length > 100) {
    return false;
  }
  if (repo.length === 0) {
    return false;
  }
  // Allow alphanumeric, dash, underscore, and dot for scoped packages-like names
  // but require at least one character that's not a special char at start/end
  const trimmed = repo.trim();
  if (trimmed.length === 0) {
    return false;
  }
  // Repo name must be alphanumeric with possible internal dashes/underscores/dots
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/.test(repo)) {
    return false;
  }
  return true;
}

/**
 * Gets the hashed subject directory for the current request.
 * This replaces the old owner-based directory lookup.
 * @param {object} req The Express request object (must have req.user with sub)
 * @returns {string} The hashed subject directory name
 */
function getHashedSubjectDir(req) {
  // req.user.sub should be the OIDC subject claim, already validated by auth middleware
  return encodeSubjectDir(req.user.sub);
}

module.exports = {
  encodeSubjectDir,
  getRepoPath,
  ensureRepoDir,
  validateRepoName,
  getHashedSubjectDir,
  DATA_PATH,
};
