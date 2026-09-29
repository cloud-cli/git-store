const express = require('express');
const simpleGit = require('simple-git');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { ensureRepoDir, getRepoPath } = require('./storage');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const PORT = process.env.PORT || 3000;

let oidcClient;
let oidcReady = false;

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
  } catch {
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
  } catch {
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
  servers: [{ url: '/', description: 'This git store server' }],
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

apiSpec.paths['/repos/{owner}/{repo}/tree'] = {
  get: operation('List repository files', { 200: { description: 'Repository tree' }, 404: notFound }, null, pathParameters),
};
apiSpec.paths['/repos'] = {
  get: operation('List repositories', { 200: { description: 'Repository list' } }, null, []),
};
apiSpec.paths['/repos/{owner}/{repo}/file'] = {
  get: operation('Read a repository file', { 200: { description: 'File contents' }, 400: { description: 'Invalid path' }, 404: notFound }, null, [...pathParameters, { name: 'path', in: 'query', required: true, schema: { type: 'string' } }]),
};
apiSpec.paths['/repos/{owner}/{repo}/branches'].get = operation('List branches', { 200: { description: 'Branches' }, 404: notFound });
apiSpec.paths['/repos/{owner}/{repo}/tags'].get = operation('List tags', { 200: { description: 'Tags' }, 404: notFound });
apiSpec.paths['/repos/{owner}/{repo}/history'] = {
  get: operation('List file history', { 200: { description: 'Commit history' }, 400: { description: 'Invalid path' }, 404: notFound }, null, [...pathParameters, { name: 'path', in: 'query', required: true, schema: { type: 'string' } }]),
};
apiSpec.paths['/config'] = { get: operation('Get browser configuration', { 200: { description: 'Public configuration' } }, null, []) };
apiSpec.paths['/session'] = { get: operation('Get the current OIDC session profile', { 200: { description: 'Session profile or unauthenticated state' } }, null, []) };
apiSpec.paths['/repos/{owner}/{repo}/files'] = {
  post: operation('Upload an unstaged file', { 201: { description: 'File written' }, 400: { description: 'Invalid file' }, 401: unauthorized, 404: notFound }, jsonBody({ path: { type: 'string' }, content: { type: 'string', description: 'Base64-encoded bytes' } }, ['path', 'content'])),
};

function safeRepoFile(owner, repo, relativePath) {
  const repoPath = path.resolve(getRepoPath(owner, repo));
  const target = path.resolve(repoPath, relativePath || '');
  if (target !== repoPath && !target.startsWith(`${repoPath}${path.sep}`)) {
    return null;
  }
  return target;
}

async function treeEntries(directory, relative = '') {
  const status = await getGit(path.resolve(directory)).status();
  const dirty = new Set([...status.not_added, ...status.modified, ...status.created, ...status.deleted]);
  return fs.readdirSync(directory, { withFileTypes: true })
    .map((entry) => ({
      name: entry.name,
      path: path.join(relative, entry.name),
      type: entry.isDirectory() ? 'directory' : 'file',
      uncommitted: dirty.has(path.join(relative, entry.name)),
    }))
    .filter((entry) => !entry.path.split(path.sep).includes('.git'));
}

const getGit = (repoPath) => simpleGit.simpleGit(repoPath);
const repoExists = (repoPath) => fs.existsSync(repoPath) && fs.existsSync(path.join(repoPath, '.git'));

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api', (req, res) => res.json(apiSpec));
app.get('/config', (req, res) => {
  const issuer = process.env.OIDC_USSUER || process.env.OIDC_ISSUER;
  return res.json({ oidcUserUrl: issuer ? `${issuer.replace(/\/$/, '')}/me` : null });
});
app.get('/session', async (req, res) => {
  const issuer = process.env.OIDC_ISSUER || process.env.OIDC_USSUER;
  const cookie = req.headers.cookie;
  if (!issuer || !cookie) return res.json({ authenticated: false, profile: null });
  try {
    const response = await fetch(new URL('/profile', issuer), { headers: { cookie } });
    if (!response.ok) return res.json({ authenticated: false, profile: null });
    return res.json({ authenticated: true, profile: await response.json() });
  } catch (error) {
    return res.json({ authenticated: false, profile: null });
  }
});

app.get('/repos', (req, res) => {
  const repositories = [];
  if (fs.existsSync(process.env.DATA_PATH)) {
    for (const owner of fs.readdirSync(process.env.DATA_PATH, { withFileTypes: true })) {
      if (!owner.isDirectory()) continue;
      for (const repo of fs.readdirSync(path.join(process.env.DATA_PATH, owner.name), { withFileTypes: true })) {
        if (repo.isDirectory()) repositories.push({ owner: owner.name, repo: repo.name });
      }
    }
  }
  return res.json(repositories);
});

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

app.get('/repos/:owner/:repo/tree', async (req, res) => {
  const repoPath = getRepoPath(req.params.owner, req.params.repo);
  if (!repoExists(repoPath)) return res.status(404).json({ error: 'Repo not found' });
  const directory = safeRepoFile(req.params.owner, req.params.repo, req.query.path || '');
  if (!directory || !fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    return res.status(404).json({ error: 'Directory not found' });
  }
  try {
    return res.json(await treeEntries(directory, req.query.path || ''));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/repos/:owner/:repo/file', (req, res) => {
  const repoPath = getRepoPath(req.params.owner, req.params.repo);
  const filePath = safeRepoFile(req.params.owner, req.params.repo, req.query.path);
  if (!filePath) return res.status(400).json({ error: 'Invalid path' });
  if (!repoExists(repoPath) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return res.status(404).json({ error: 'File not found' });
  }
  try {
    return res.type('text/plain').send(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/repos/:owner/:repo/files', requireAuthentication, (req, res) => {
  const repoPath = getRepoPath(req.params.owner, req.params.repo);
  const filePath = safeRepoFile(req.params.owner, req.params.repo, req.body.path);
  if (!filePath || typeof req.body.content !== 'string') return res.status(400).json({ error: 'Invalid file' });
  if (!repoExists(repoPath)) return res.status(404).json({ error: 'Repo not found' });
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(req.body.content, 'base64'));
    return res.status(201).json({ path: req.body.path, staged: false });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/repos/:owner/:repo/branches', async (req, res) => {
  const repoPath = getRepoPath(req.params.owner, req.params.repo);
  if (!repoExists(repoPath)) return res.status(404).json({ error: 'Repo not found' });
  try {
    const branches = await getGit(repoPath).branchLocal();
    return res.json(branches.all);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/repos/:owner/:repo/tags', async (req, res) => {
  const repoPath = getRepoPath(req.params.owner, req.params.repo);
  if (!repoExists(repoPath)) return res.status(404).json({ error: 'Repo not found' });
  try {
    const tags = await getGit(repoPath).tags();
    return res.json(tags.all);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/repos/:owner/:repo/history', async (req, res) => {
  const repoPath = getRepoPath(req.params.owner, req.params.repo);
  const filePath = safeRepoFile(req.params.owner, req.params.repo, req.query.path);
  if (!filePath) return res.status(400).json({ error: 'Invalid path' });
  if (!repoExists(repoPath) || !fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  try {
    const history = await getGit(repoPath).log({ file: req.query.path, strictDate: false });
    return res.json(history.all);
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
