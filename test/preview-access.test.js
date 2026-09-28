import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'src', 'cli.js');

function temporaryDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `herdr-preview-access-${tag}-`));
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function startPreview(home, dataDir, port) {
  return spawn(process.execPath, [cli, 'serve', '--read-only-preview'], {
    cwd: repo,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      HOME: home,
      HERDR_BOSS_DIR: dataDir,
      HERDR_BOSS_LIVE_DIR: path.join(home, '.herdr-boss'),
      HERDR_BOSS_PORT: String(port),
      HERDR_BOSS_PUSH: '0',
    },
  });
}

async function waitForPreview(child, port) {
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Preview exited before it served a response: ${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(500) });
      if (response.status === 200) return response;
      lastError = new Error(`Preview returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Preview did not become ready: ${lastError?.message || 'no response'}\n${output}`);
}

async function stopPreview(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await once(child, 'exit');
}

function requestWithHost(port, host, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: pathname, headers: { host } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('a read-only preview leaves an existing access token unchanged and creates no session file', { timeout: 30000 }, async (t) => {
  const home = temporaryDir('existing-home');
  const dataDir = temporaryDir('existing-data');
  const accessDir = path.join(home, '.config', 'herdr-boss');
  const tokenFile = path.join(accessDir, 'access-token');
  const token = 'preview-fixture-token-that-must-not-change-0123456789';
  fs.mkdirSync(accessDir, { recursive: true });
  fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o644 });
  const port = await unusedPort();
  const child = startPreview(home, dataDir, port);
  t.after(async () => {
    await stopPreview(child);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  await waitForPreview(child, port);
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o644, 'the preview keeps the token mode');
  assert.equal(fs.readFileSync(tokenFile, 'utf8'), `${token}\n`, 'the preview keeps the token content');
  assert.equal(fs.existsSync(path.join(accessDir, 'sessions.json')), false, 'the preview creates no session file');

  const login = await fetch(`http://127.0.0.1:${port}/login`);
  assert.equal(login.status, 200);
  assert.doesNotMatch(await login.text(), /Unlock dashboard|name="token"/, 'the preview has no login page');
  const remote = await requestWithHost(port, 'preview.tail0000.ts.net', '/api/state');
  assert.equal(remote.status, 403);
  assert.deepEqual(JSON.parse(remote.body), { error: 'The read-only preview accepts only local requests.' });
});

test('a read-only preview does not create the private access directory', { timeout: 30000 }, async (t) => {
  const home = temporaryDir('empty-home');
  const dataDir = temporaryDir('empty-data');
  const accessDir = path.join(home, '.config', 'herdr-boss');
  const port = await unusedPort();
  const child = startPreview(home, dataDir, port);
  t.after(async () => {
    await stopPreview(child);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  await waitForPreview(child, port);
  assert.equal(fs.existsSync(accessDir), false, 'the preview leaves the private access directory absent');
});
