import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-preview-test-'));
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-preview-home-'));
process.env.HOME = homeDir;
process.env.HERDR_BOSS_DIR = dataDir;
process.env.HERDR_BOSS_PORT = '0';

const [{ serve }, { loadConfig }] = await Promise.all([
  import('../src/server.js'),
  import('../src/config.js'),
]);

test('read-only preview allows reads and rejects all API methods that can change state', async (t) => {
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  let engine;
  let engineOptions;
  const { server, close } = serve(cfg, {
    readOnlyPreview: true,
    createEngine: (_config, actions) => {
      engineOptions = actions;
      engine = new EventEmitter();
      engine.act = actions.act;
      engine.push = actions.push;
      engine.state = {};
      engine.tickCalls = 0;
      engine.tick = async () => { engine.tickCalls += 1; return engine.state; };
      engine.log = () => {};
      return engine;
    },
  });
  t.after(async () => {
    await close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  assert.deepEqual(engineOptions, { push: false, act: false });
  assert.equal(engine.act, false, 'preview disables actions such as reaping and handovers');
  assert.equal(engine.push, false, 'preview disables prompts and notifications');
  for (const route of ['/', '/login', '/api/state', '/api/models', '/api/policy', '/api/usage', '/api/projects', '/api/handoffs']) {
    const response = await fetch(`${base}${route}`);
    assert.equal(response.status, 200, `${route} remains readable`);
  }
  assert.equal((await fetch(`${base}/api/state`, { method: 'HEAD' })).status, 200);

  const writes = [
    ['PUT', '/api/policy'],
    ['POST', '/api/browser-sessions/window-size'],
    ['POST', '/api/browser-sessions/navigate'],
    ['POST', '/api/browser-sessions/history'],
    ['POST', '/api/browser-sessions/input'],
    ['POST', '/api/browser-sessions/new-tab'],
    ['POST', '/api/browser-sessions/close'],
    ['POST', '/api/browser-sessions/request'],
    ['POST', '/api/browser-sessions/restart'],
    ['POST', '/api/handoffs/plan'],
    ['POST', '/api/handoffs/prepare'],
    ['POST', '/api/handoffs/activate'],
    ['PUT', '/api/projects/demo'],
    ['POST', '/api/projects/demo'],
    ['DELETE', '/api/projects/demo'],
    ['POST', '/api/usage'],
    ['POST', '/api/tick'],
    ['PATCH', '/api/unknown'],
    ['OPTIONS', '/api/state'],
  ];
  for (const [method, route] of writes) {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: ['GET', 'HEAD', 'OPTIONS'].includes(method) ? undefined : '{}',
    });
    assert.equal(response.status, 403, `${method} ${route} is refused`);
  }

  assert.equal(engine.tickCalls, 1, 'blocked API writes did not start an extra engine tick');
  await close();
  assert.equal(server.listening, false, 'close stops the HTTP server');
  assert.equal(engine.tickCalls, 1, 'close clears the recurring tick timer');

  const customTokenFile = path.join(dataDir, 'custom-access-token');
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ access: { tokenFile: customTokenFile } }));
  const customCfg = loadConfig();
  customCfg.host = '127.0.0.1';
  customCfg.port = 0;
  customCfg.tickSeconds = 3600;
  const customServer = serve(customCfg, {
    readOnlyPreview: true,
    createEngine: (_config, actions) => {
      const customEngine = new EventEmitter();
      customEngine.act = actions.act;
      customEngine.push = actions.push;
      customEngine.state = {};
      customEngine.tick = async () => customEngine.state;
      customEngine.log = () => {};
      return customEngine;
    },
  });
  t.after(async () => { await customServer.close(); });
  await new Promise((resolve, reject) => {
    customServer.server.once('listening', resolve);
    customServer.server.once('error', reject);
  });
  const token = fs.readFileSync(customTokenFile, 'utf8').trim();
  const login = await fetch(`http://127.0.0.1:${customServer.server.address().port}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
    redirect: 'manual',
  });
  assert.equal(login.status, 303);
  const privateSessions = path.join(homeDir, '.config', 'herdr-boss', 'sessions.json');
  assert.equal(fs.existsSync(customTokenFile), true, 'the configured custom token path stays active');
  assert.equal(fs.existsSync(privateSessions), true, 'sessions use the private config directory');
  assert.equal(fs.existsSync(path.join(path.dirname(customTokenFile), 'sessions.json')), false, 'sessions are not stored beside the custom token');
  assert.equal(fs.statSync(path.dirname(privateSessions)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(privateSessions).mode & 0o777, 0o600);
  await customServer.close();
});
