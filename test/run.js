const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');

const DATA_PATH = process.env.DATA_PATH || './data';

const owner = 'testuser';
const repo = 'testrepo';

function request(method, apiPath, data, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 3000,
      path: apiPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    if (data !== undefined) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
}

(async () => {
  const server = spawn(process.execPath, ['index.js'], { env: { ...process.env, DATA_PATH } });
  server.stdout.on('data', (data) => console.log('SERVER:', String(data)));
  server.stderr.on('data', (data) => console.error('SERVER ERR:', String(data)));

  await new Promise(r => setTimeout(r, 1500));

  const base = `/repos/${owner}/${repo}`;

  // 1. Create repo
  const resCreate = await request('POST', base);
  assert.strictEqual(resCreate.status, 201, 'create repo should return 201');
  console.log('✅ POST', base, '=> 201');

  // 2. Get log
  const resLog = await request('GET', `${base}/log`);
  assert.ok([200].includes(resLog.status), `log should return 200, got ${resLog.status}`);
  console.log('✅ GET', base, '/log =>', resLog.status);

  // 3. GET /api – OpenAPI spec
  const resApi = await request('GET', '/api');
  assert.strictEqual(resApi.status, 200, '/api should return 200');
  const spec = JSON.parse(resApi.body);
  assert.ok(spec.openapi, 'spec must have openapi version');
  assert.ok(spec.paths, 'spec must have paths');
  const expectedPaths = ['/health', '/api', '/repos/{owner}/{repo}', '/repos/{owner}/{repo}/log',
    '/repos/{owner}/{repo}/stage', '/repos/{owner}/{repo}/unstage',
    '/repos/{owner}/{repo}/commit', '/repos/{owner}/{repo}/tags',
    '/repos/{owner}/{repo}/tags/{name}', '/repos/{owner}/{repo}/branches',
    '/repos/{owner}/{repo}/branches/{name}'];
  for (const p of expectedPaths) {
    assert.ok(spec.paths[p], `spec must contain path ${p}`);
  }
  const expectedOperations = {
    '/health': ['get'],
    '/api': ['get'],
    '/repos/{owner}/{repo}': ['post'],
    '/repos/{owner}/{repo}/log': ['get'],
    '/repos/{owner}/{repo}/stage': ['post'],
    '/repos/{owner}/{repo}/unstage': ['post'],
    '/repos/{owner}/{repo}/commit': ['post'],
    '/repos/{owner}/{repo}/tags': ['post'],
    '/repos/{owner}/{repo}/tags/{name}': ['delete'],
    '/repos/{owner}/{repo}/branches': ['post'],
    '/repos/{owner}/{repo}/branches/{name}': ['delete'],
  };
  for (const [pathName, methods] of Object.entries(expectedOperations)) {
    for (const method of methods) {
      assert.ok(spec.paths[pathName][method], `spec must contain ${method.toUpperCase()} ${pathName}`);
    }
  }
  console.log('✅ GET /api => spec with', expectedPaths.length, 'paths');

  // 4. Protected endpoints should return 401 without auth
  const protectedEndpoints = [
    { method: 'POST', path: `${base}/stage`, body: { files: [] } },
    { method: 'POST', path: `${base}/unstage`, body: { files: [] } },
    { method: 'POST', path: `${base}/commit`, body: { message: 'test' } },
    { method: 'POST', path: `${base}/tags`, body: { name: 'v1' } },
    { method: 'DELETE', path: `${base}/tags/v1` },
    { method: 'POST', path: `${base}/branches`, body: { name: 'main' } },
    { method: 'DELETE', path: `${base}/branches/main` },
  ];

  for (const ep of protectedEndpoints) {
    const extra = {};
    if (ep.body) extra['Content-Type'] = 'application/json';
    const res = await request(ep.method, ep.path, ep.body, extra);
    assert.strictEqual(res.status, 401, `${ep.method} ${ep.path} should return 401 without auth, got ${res.status}`);
    console.log(`✅ ${ep.method} ${ep.path} => 401`);
  }

  // 5. Health endpoint unauthenticated should work
  const resHealth = await request('GET', '/health');
  assert.strictEqual(resHealth.status, 200, '/health should return 200 without auth');
  console.log('✅ GET /health => 200', JSON.parse(resHealth.body));

  const missingLog = await request('GET', '/repos/missing/missing/log');
  assert.strictEqual(missingLog.status, 404, 'missing repositories should return 404');
  console.log('✅ GET missing log => 404');

  if (process.env.TEST_OIDC_TOKEN) {
    const auth = { Authorization: `Bearer ${process.env.TEST_OIDC_TOKEN}` };
    const filePath = `${DATA_PATH}/${owner}/${repo}/README.md`;
    require('fs').writeFileSync(filePath, 'integration test\n');
    const stage = await request('POST', `${base}/stage`, { files: ['README.md'] }, auth);
    assert.strictEqual(stage.status, 200, 'authenticated stage should return 200');
    const commit = await request('POST', `${base}/commit`, { message: 'integration test' }, auth);
    assert.strictEqual(commit.status, 200, 'authenticated commit should return 200');
    const tag = await request('POST', `${base}/tags`, { name: 'v1' }, auth);
    assert.strictEqual(tag.status, 200, 'authenticated tag creation should return 200');
    const branch = await request('POST', `${base}/branches`, { name: 'integration' }, auth);
    assert.strictEqual(branch.status, 200, 'authenticated branch creation should return 200');
    assert.strictEqual((await request('DELETE', `${base}/tags/v1`, undefined, auth)).status, 200);
    assert.strictEqual((await request('DELETE', `${base}/branches/integration`, undefined, auth)).status, 200);
    console.log('✅ authenticated mutation flow');
  }

  console.log('\n🎉 All tests passed!');
  server.kill();
})();
