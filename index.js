const express = require('express');
const simpleGit = require('simple-git');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { ensureRepoDir, getRepoPath } = require('./storage');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Helper to get git instance
const getGit = (repoPath) => simpleGit.simpleGit(repoPath);

// Create a new repo
app.post('/repos/:owner/:repo', async (req, res) => {
  const { owner, repo } = req.params;
  try {
    const repoPath = ensureRepoDir(owner, repo);
    const git = getGit(repoPath);
    
    // Initialize git repo if it doesn't exist
    if (!fs.existsSync(path.join(repoPath, '.git'))) {
      await git.init();
    }
    
    res.status(201).json({ message: `Repository ${owner}/${repo} is ready`, path: repoPath });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch git log as a stream
app.get('/repos/:owner/:repo/log', async (req, res) => {
  const { owner, repo } = req.params;
  const repoPath = getRepoPath(owner, repo);

  if (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, '.git'))) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  try {
    const git = getGit(repoPath);
    try {
      const log = await git.log();
      res.setHeader('Content-Type', 'application/json');
      res.write(JSON.stringify(log.all));
      res.end();
    } catch (e) {
      // If git not available or other issue, return empty array
      res.status(200).json([]);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Stage files
app.post('/repos/:owner/:repo/stage', async (req, res) => {
  const { owner, repo } = req.params;
  const { files } = req.body; // Array of file paths relative to repo root

  const repoPath = getRepoPath(owner, repo);
  if (!fs.existsSync(repoPath)) return res.status(404).json({ error: 'Repo not found' });

  try {
    const git = getGit(repoPath);
    await git.add(files);
    res.json({ message: 'Files staged successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Unstage files
app.post('/repos/:owner/:repo/unstage', async (req, res) => {
  const { owner, repo } = req.params;
  const { files } = req.body;

  const repoPath = getRepoPath(owner, repo);
  if (!fs.existsSync(repoPath)) return res.status(404).json({ error: 'Repo not found' });

  try {
    const git = getGit(repoPath);
    await git.reset(['--mixed', ...files]);
    res.json({ message: 'Files unstaged successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Autocommit staged changes
app.post('/repos/:owner/:repo/commit', async (req, res) => {
  const { owner, repo } = req.params;
  const { message = 'autocommit' } = req.body;

  const repoPath = getRepoPath(owner, repo);
  if (!fs.existsSync(repoPath)) return res.status(404).json({ error: 'Repo not found' });

  try {
    const git = getGit(repoPath);
    const status = await git.status();
    
    if (status.staged.length === 0) {
      return res.json({ message: 'No changes to commit' });
    }

    await git.commit(message);
    res.json({ message: 'Changes committed successfully', commit: message });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add Tag
app.post('/repos/:owner/:repo/tags', async (req, res) => {
  const { owner, repo } = req.params;
  const { name } = req.body;

  const repoPath = getRepoPath(owner, repo);
  if (!fs.existsSync(repoPath)) return res.status(404).json({ error: 'Repo not found' });

  try {
    const git = getGit(repoPath);
    await git.addTag(name);
    res.json({ message: `Tag ${name} added` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Remove Tag
app.delete('/repos/:owner/:repo/tags/:name', async (req, res) => {
  const { owner, repo, name } = req.params;

  const repoPath = getRepoPath(owner, repo);
  if (!fs.existsSync(repoPath)) return res.status(404).json({ error: 'Repo not found' });

  try {
    const git = getGit(repoPath);
    await git.tag(['-d', name]);
    res.json({ message: `Tag ${name} removed` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add Branch
app.post('/repos/:owner/:repo/branches', async (req, res) => {
  const { owner, repo } = req.params;
  const { name, startPoint } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Branch name is required' });
  }

  const repoPath = getRepoPath(owner, repo);
  if (!fs.existsSync(repoPath)) return res.status(404).json({ error: 'Repo not found' });

  try {
    const git = getGit(repoPath);
    const options = { name };
    if (startPoint) {
      options.startPoint = startPoint;
    }
    await git.branch(options);
    res.json({ message: `Branch ${name} created` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Remove Branch
app.delete('/repos/:owner/:repo/branches/:name', async (req, res) => {
  const { owner, repo, name } = req.params;

  const repoPath = getRepoPath(owner, repo);
  if (!fs.existsSync(repoPath)) return res.status(404).json({ error: 'Repo not found' });

  try {
    const git = getGit(repoPath);
    await git.branch(['-D', name]);
    res.json({ message: `Branch ${name} removed` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}
module.exports = app;
