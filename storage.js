const fs = require('fs');
const path = require('path');

const DATA_PATH = process.env.DATA_PATH;

if (!DATA_PATH) {
  throw new Error('DATA_PATH environment variable is not set');
}

if (!fs.existsSync(DATA_PATH)) {
  fs.mkdirSync(DATA_PATH, { recursive: true });
}

/**
 * Gets the absolute path to a repository.
 * @param {string} owner 
 * @param {string} repo 
 * @returns {string}
 */
function getRepoPath(owner, repo) {
  return path.join(DATA_PATH, owner, repo);
}

/**
 * Ensures the owner and repository directory exists.
 * @param {string} owner 
 * @param {string} repo 
 * @returns {string} The directory path
 */
function ensureRepoDir(owner, repo) {
  const repoPath = getRepoPath(owner, repo);
  const ownerPath = path.join(DATA_PATH, owner);
  
  if (!fs.existsSync(ownerPath)) {
    fs.mkdirSync(ownerPath, { recursive: true });
  }
  
  if (!fs.existsSync(repoPath)) {
    fs.mkdirSync(repoPath, { recursive: true });
  }
  
  return repoPath;
}

module.exports = {
  getRepoPath,
  ensureRepoDir,
  DATA_PATH
};
