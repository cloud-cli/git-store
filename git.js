const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);

function execGit(args, options = {}) {
  return execFileAsync("git", args, {
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
}

async function initRepo(repoPath) {
  try {
    await execGit(["init", repoPath]);
  } catch (err) {
    // If -b flag supported or already initialized
    await execGit(["init", repoPath]);
  }
  // Ensure default author identity is configured inside repository
  try {
    await execGit(["config", "user.name", "git-store"], { cwd: repoPath });
    await execGit(["config", "user.email", "git-store@local"], { cwd: repoPath });
  } catch (err) {
    // ignore config errors if any
  }
}

async function hasCommits(repoPath) {
  try {
    await execGit(["rev-parse", "--verify", "HEAD"], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

async function stageFiles(repoPath, files) {
  const fileList = Array.isArray(files) && files.length > 0 ? files : ["."];
  await execGit(["add", "--", ...fileList], { cwd: repoPath });
}

async function unstageFiles(repoPath, files) {
  const commitExists = await hasCommits(repoPath);
  const fileList = Array.isArray(files) && files.length > 0 ? files : ["."];
  if (commitExists) {
    await execGit(["reset", "HEAD", "--", ...fileList], { cwd: repoPath });
  } else {
    // If no commits yet, rm --cached
    await execGit(["rm", "--cached", "-r", "--ignore-unmatch", "--", ...fileList], { cwd: repoPath });
  }
}

async function commit(repoPath, message = "autocommit") {
  // Check if there are staged changes
  try {
    await execGit(["diff", "--cached", "--quiet"], { cwd: repoPath });
    // Exit code 0 means no changes staged
    return { committed: false, message: "No changes to commit" };
  } catch (err) {
    // Exit code 1 means changes exist, proceed to commit
  }

  const { stdout } = await execGit(["commit", "-m", message], { cwd: repoPath });
  return { committed: true, message: "Changes committed successfully", commit: message, output: stdout.trim() };
}

function streamLog(repoPath, res) {
  return new Promise(async (resolve, reject) => {
    const exists = await hasCommits(repoPath);
    if (!exists) {
      res.setHeader("Content-Type", "application/json");
      res.end("[]");
      return resolve();
    }

    res.setHeader("Content-Type", "application/json");
    res.write("[\n");

    // delimiter format: %H%x00%an%x00%ae%x00%aI%x00%s%x01
    const git = spawn("git", ["log", "--pretty=format:%H%x00%an%x00%ae%x00%aI%x00%s%x01"], {
      cwd: repoPath,
    });

    let buffer = "";
    let isFirst = true;

    git.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const parts = buffer.split("\x01");
      buffer = parts.pop(); // keep remainder

      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) {
          continue;
        }
        const [hash, author_name, author_email, date, message] = trimmed.split("\x00");
        const entry = JSON.stringify({
          hash,
          author_name,
          author_email,
          date,
          message,
        });

        if (!isFirst) {
          res.write(",\n");
        } else {
          isFirst = false;
        }
        res.write(entry);
      }
    });

    git.stderr.on("data", (err) => {
      console.error("git log stderr:", err.toString());
    });

    git.on("error", (err) => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err.message }));
      } else {
        res.end();
      }
      reject(err);
    });

    git.on("close", (code) => {
      if (buffer.trim()) {
        const [hash, author_name, author_email, date, message] = buffer.trim().split("\x00");
        const entry = JSON.stringify({
          hash,
          author_name,
          author_email,
          date,
          message,
        });
        if (!isFirst) {
          res.write(",\n");
        }
        res.write(entry);
      }
      res.write("\n]");
      res.end();
      resolve();
    });
  });
}

async function addTag(repoPath, name) {
  if (!name) {
    throw new Error("Tag name is required");
  }
  await execGit(["tag", name], { cwd: repoPath });
}

async function removeTag(repoPath, name) {
  if (!name) {
    throw new Error("Tag name is required");
  }
  await execGit(["tag", "-d", name], { cwd: repoPath });
}

async function listTags(repoPath) {
  const { stdout } = await execGit(["tag", "-l"], { cwd: repoPath });
  return stdout
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean);
}

async function addBranch(repoPath, name, startPoint) {
  if (!name) {
    throw new Error("Branch name is required");
  }
  const args = ["branch", name];
  if (startPoint) {
    args.push(startPoint);
  }
  await execGit(args, { cwd: repoPath });
}

async function removeBranch(repoPath, name) {
  if (!name) {
    throw new Error("Branch name is required");
  }
  await execGit(["branch", "-D", name], { cwd: repoPath });
}

async function listBranches(repoPath) {
  const { stdout } = await execGit(["branch", "--format=%(refname:short)"], { cwd: repoPath });
  return stdout
    .split("\n")
    .map((b) => b.trim())
    .filter(Boolean);
}

module.exports = {
  execGit,
  initRepo,
  hasCommits,
  stageFiles,
  unstageFiles,
  commit,
  streamLog,
  addTag,
  removeTag,
  listTags,
  addBranch,
  removeBranch,
  listBranches,
};
