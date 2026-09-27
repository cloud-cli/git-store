const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');

const DATA_PATH = process.env.DATA_PATH || './data';

const owner = 'demo';
const repo = 'demo';

// helper to make requests
function request(method, path, data) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 3000,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
}

(async () => {
  // Start server
  const server = spawn(process.execPath, ['index.js']);
  server.stdout.on('data', (data) => console.log(String(data)));
  server.stderr.on('data', (data) => console.error(String(data)));

  // Wait a bit for server to start
  await new Promise(r => setTimeout(r, 1000));

  // Create repo
  const res1 = await request('POST', `/repos/${owner}/${repo}`);
  assert.strictEqual(res1.status, 201, 'create repo should return 201');

  // Get log
  const res2 = await request('GET', `/repos/${owner}/${repo}/log`);
  assert.strictEqual(res2.status, 200, 'log should return 200');

  console.log('All tests passed');
  server.kill();
})();
