const express = require('express');
const simpleGit = require('simple-git');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { ensureRepoDir, getRepoPath } = require('./storage');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

let oidcClient;
let oidcReady = false;
let oidcError;

async function initializeOidc() {
  if (!process.env.OIDC_ISSUER || !process.env.OIDC_CLIENT_ID || !process.env.OIDC_CLIENT_SECRET) {
    return;
  }
  try {
    const { Issuer } = require('openid-client');
    const issuer = await Issuer.discover(process.env.OIDC_ISSUER);
    oidcClient = new issuer.Client({
      client_id: process.env.OIDC_CLIENT_ID,
      client_secret: process.env.OIDC_CLIENT_SECRET,
    });
    oidcReady = true;
  } catch (error) {
    oidcError = error;
  }
}
initializeOidc();

async function requireAuthentication(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!oidcReady) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const token = header.slice(7).trim();
    const claims = await oidcClient.introspect(token);
    if (!claims.active) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.user = claims;
    return next();
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

const pathParameters = [
  { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
  { name: 'repo', in: 'path', required: true, schema: { type: 'string' } },
];
const jsonBody = (properties, required = []) => ({
  required: required.length > 0,
  content: { 'application/json': { schema: { type: 'object', properties, required } } },
});
const operation = (summary, responses, body, parameters = pathParameters) => ({
  summary,
  parameters,
  ...(body ? { requestBody: body } : {}),
  responses,
});
const unauthorized = { description: 'Unauthorized' };
const notFound = { description: 'Repository not found' };
const apiSpec = {
  openapi: '3.0.3',
  info: { title: 'Git Store API', version: '1.0.0' },
  servers: [{ url: `http://localhost:${PORT}` }],
  paths: {
    '/health': { get: operation('Health check', { 200: { description: 'Healthy' } }, null, []) },
    '/api': { get: operation('Get this OpenAPI document', { 200: { description: 'OpenAPI document' } }, null, []) },
    '/repos/{owner}/{repo}': {
      post: operation('Create or initialize a repository', { 201: { description: 'Created' }, 500: { description: 'Git error' } }),
    },
    '/repos/{owner}/{repo}/log': {
      get: operation('Fetch the repository log', { 200: { description: 'Commit array' }, 404: notFound }),
    },
    '/repos/{owner}/{repo}/stage': {
      post: operation('Stage files', { 200: { description: 'Staged' }, 401: unauthorized, 404: notFound }, jsonBody({ files: { type: 'array', items: { type: 'string' } } }, ['files'])),
    },
    '/repos/{owner}/{repo}/unstage': {
      post: operation('Unstage files', { 200: { description: 'Unstaged' }, 401: unauthorized, 404: notFound }, jsonBody({ files: { type: 'array', items: { type: 'string' } } }, ['files'])),
    },
    '/repos/{owner}/{repo}/commit': {
      post: operation('Commit staged changes', { 200: { description: 'Committed or no changes' }, 401: unauthorized, 404: notFound }, jsonBody({ message: { type: 'string' } })),
    },
    '/repos/{owner}/{repo}/tags': {
      post: operation('Add a tag', { 200: { description: 'Tag added' }, 401: unauthorized, 404: notFound }, jsonBody({ name: { type: 'string' } }, ['name'])),
    },
    '/repos/{owner}/{repo}/tags/{name}': {
      delete: operation('Remove a tag', { 200: { description: 'Tag removed' }, 401: unauthorized, 404: notFound }, null, [...pathParameters, { name: 'name', in: 'path', required: true, schema: { type: 'string' } }]),
    },
    '/repos/{owner}/{repo}/branches': {
      post: operation('Create a branch', { 200: { description: 'Branch created' }, 400: { description: 'Missing branch name' }, 401: unauthorized, 404: notFound }, jsonBody({ name: { type: 'string' }, startPoint: { type: 'string' } }, ['name'])),
    },
    '/repos/{owner}/{repo}/branches/{name}': {
      delete: operation('Remove a branch', { 200: { description: 'Branch removed' }, 401: unauthorized, 404: notFound }, null, [...pathParameters, { name: 'name', in: 'path', required: true, schema: { type: 'string' } }]),
    },
  },
};

const getGit = (repoPath) => simpleGit.simpleGit(repoPath);
const repoExists = (repoPath) => fs.existsSync(repoPath) && fs.existsSync(path.join(repoPath, '.git'));

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api', (req, res) => res.json(apiSpec));

app.post('/repos/:owner/:repo', async (req, res) => {
  try {
    const repoPath = ensureRepoDir(req.params.owner, req.params.repo);
    const git = getGit(repoPath);
    if (!fs.existsSync(path.join(repoPath, '.git'))) {
      await git.init();
    }
    return res.status(201).json({ message: `Repository ${req.params.owner}/${req.params.repo} is ready`, path: repoPath });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/repos/:owner/:repo/log', async (req, res) => {
  const repoPath = getRepoPath(req.params.owner, req.params.repo);
  if (!repoExists(repoPath)) {
    return res.status(404).json({ error: 'Repository not found' });
  }
  try {
    const log = await getGit(repoPath).log();
    return res.json(log.all);
  } catch (error) {
    if (error.message.includes('does not have any commits yet')) {
      return res.json([]);
    }
    return res.status(500).json({ error: error.message });
  }
});

app.post('/repos/:owner/:repo/stage', requireAuthentication, async (req, res) => {
  const repoPath = getRepoPath(req.params.owner, req.params.repo);
  if (!repoExists(repoPath)) return res.status(404).json({ error: 'Repo not found' });
  try {
    await getGit(repoPath).add(req.body.files);
    return res.json({ message: 'Files staged successfully' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/repos/:owner/:repo/unstage', requireAuthentication, async (req, res) => {
  const repoPath = getRepoPath(req.params.owner, req.params.repo);
  if (!repoExists(repoPath)) return res.status(404).json({ error: 'Repo not found' });
  try {
    await getGit(repoPath).reset(['--mixed', ...(req.body.files || [])]);
    return res.json({ message: 'Files unstaged successfully' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/repos/:owner/:repo/commit', requireAuthentication, async (req, res) => {
  const repoPath = getRepoPath(req.params.owner, req.params.repo);
  if (!repoExists(repoPath)) return res.status(404).json({ error: 'Repo not found' });
  try {
    const status = await getGit(repoPath).status();
    if (status.staged.length === 0) return res.json({ message: 'No changes to commit' });
    const message = req.body.message || 'autocommit';
    await getGit(repoPath).commit(message);
    return res.json({ message: 'Changes committed successfully', commit: message });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/repos/:owner/:repo/tags', requireAuthentication, async (req, res) => {
  const repoPath = getRepoPath(req.params.owner, req.params.repo);
  if (!repoExists(repoPath)) return res.status(404).json({ error: 'Repo not found' });
  try {
    await getGit(repoPath).addTag(req.body.name);
    return res.json({ message: `Tag ${req.body.name} added` });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.delete('/repos/:owner/:repo/tags/:name', requireAuthentication, async (req, res) => {
  const repoPath = getRepoPath(req.params.owner, req.params.repo);
  if (!repoExists(repoPath)) return res.status(404).json({ error: 'Repo not found' });
  try {
    await getGit(repoPath).tag(['-d', req.params.name]);
    return res.json({ message: `Tag ${req.params.name} removed` });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/repos/:owner/:repo/branches', requireAuthentication, async (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'Branch name is required' });
  const repoPath = getRepoPath(req.params.owner, req.params.repo);
  if (!repoExists(repoPath)) return res.status(404).json({ error: 'Repo not found' });
  try {
    const args = req.body.startPoint ? ['--create', req.body.name, req.body.startPoint] : ['--create', req.body.name];
    await getGit(repoPath).branch(args);
    return res.json({ message: `Branch ${req.body.name} created` });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.delete('/repos/:owner/:repo/branches/:name', requireAuthentication, async (req, res) => {
  const repoPath = getRepoPath(req.params.owner, req.params.repo);
  if (!repoExists(repoPath)) return res.status(404).json({ error: 'Repo not found' });
  try {
    await getGit(repoPath).branch(['-D', req.params.name]);
    return res.json({ message: `Branch ${req.params.name} removed` });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
}

module.exports = app;
