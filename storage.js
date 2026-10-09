const fs = require("fs");
const crypto = require("crypto");

const DATA_PATH = process.env.DATA_PATH;

if (!DATA_PATH) {
  throw new Error("DATA_PATH environment variable is not set");
}

if (!fs.existsSync(DATA_PATH)) {
  fs.mkdirSync(DATA_PATH, { recursive: true });
}

/**
 * Derives a stable SHA-256 ownership fingerprint from an OIDC subject claim.
 * The original subject value is not exposed or stored in organization metadata.
 *
 * @param {string} sub The OIDC subject claim value
 * @returns {string} A lowercase hexadecimal SHA-256 hash
 */
function hashSubject(sub) {
  const hash = crypto.createHash("sha256").update(sub).digest("hex");
  return hash;
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
 * Gets the ownership hash for the current request.
 * Organizations store this hash as their owner identifier.
 * @param {object} req The Express request object (must have req.user with sub)
 * @returns {string} The lowercase hexadecimal SHA-256 hash
 */
function getSubjectHash(req) {
  // req.user.sub should be the OIDC subject claim, already validated by auth middleware
  return hashSubject(req.user.sub);
}

module.exports = {
  hashSubject,
  validateRepoName,
  getSubjectHash,
  DATA_PATH,
};
