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

test('read-only preview allows reads and rejects all API methods that can change state', { timeout: 20000 }, async (t) => {
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

test('the policy API saves per-harness model assignments and rejects unsafe model strings', { timeout: 20000 }, async (t) => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  const { server, close } = serve(cfg, {
    createEngine: () => {
      const engine = new EventEmitter();
      engine.state = { control: null };
      engine.tick = async () => engine.state;
      engine.log = () => {};
      return engine;
    },
  });
  t.after(async () => { await close(); });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const shared = 'opencode-go/deepseek-v4.1-flash';
  const current = await (await fetch(`${base}/api/policy`)).json();
  assert.deepEqual([current.extraModels, current.disabledModels, current.harnessRoutes], [{}, {}, {}], 'a policy without the new fields reads as empty assignments');
  assert.equal(current.machine.guardEnabled, true, 'the fresh policy enables the guard explicitly');
  assert.equal(current.machine.guardPausedUntil, null);
  const draft = {
    ...current,
    machine: { ...current.machine, guardEnabled: false, guardPausedUntil: '2026-09-26T13:00:00.000Z' },
    modelProviders: { [shared]: null },
    extraModels: { pi: ['opencode-go/glm-5.2'] },
    disabledModels: { opencode: [shared] },
    harnessRoutes: { pi: { 'opencode-go/glm-5.2': 'opencodego' } },
  };
  const put = (body) => fetch(`${base}/api/policy`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const saved = await put(draft);
  assert.equal(saved.status, 200);
  const stored = (await saved.json()).policy;
  assert.deepEqual(stored.extraModels, draft.extraModels);
  assert.deepEqual(stored.disabledModels, draft.disabledModels);
  assert.deepEqual(stored.harnessRoutes, draft.harnessRoutes);
  assert.deepEqual(stored.modelProviders, draft.modelProviders, 'the legacy route stays');
  assert.equal(stored.machine.guardEnabled, false);
  assert.equal(stored.machine.guardPausedUntil, draft.machine.guardPausedUntil);
  const invalidGuard = await put({ ...draft, machine: { ...draft.machine, guardEnabled: 'off' } });
  assert.equal(invalidGuard.status, 400);
  assert.match((await invalidGuard.json()).errors.join(' '), /machine.guardEnabled/);
  const invalidPause = await put({ ...draft, machine: { ...draft.machine, guardPausedUntil: 'tomorrow' } });
  assert.equal(invalidPause.status, 400);
  assert.match((await invalidPause.json()).errors.join(' '), /machine.guardPausedUntil/);
  const rejected = await put({ ...draft, extraModels: { pi: ['glm; rm -rf ~'] } });
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).errors.join(' '), /extraModels/);
  assert.deepEqual((await (await fetch(`${base}/api/policy`)).json()).extraModels, draft.extraModels, 'a rejected save keeps the stored policy');
  const crossed = await put({ ...draft, harnessRoutes: { ...draft.harnessRoutes, codex: { 'gpt-6-luna': 'claude' } } });
  assert.equal(crossed.status, 400);
  assert.match((await crossed.json()).errors.join(' '), /harnessRoutes: codex\/gpt-6-luna cannot use claude\. Choose codex or null \(unmetered\)\./);
  const compatible = await put({ ...draft, harnessRoutes: { ...draft.harnessRoutes, codex: { 'gpt-6-luna': null }, claude: { 'claude-opus-5-5': 'claude' } } });
  assert.equal(compatible.status, 200);
  assert.deepEqual((await compatible.json()).policy.harnessRoutes.codex, { 'gpt-6-luna': null });
  const inherited = await put({ ...draft, modelProviders: { ...draft.modelProviders, 'gpt-6-sol': 'claude' } });
  assert.equal(inherited.status, 400);
  assert.match((await inherited.json()).errors.join(' '), /modelProviders: codex\/gpt-6-sol inherits claude\. Choose codex or null \(unmetered\) in harnessRoutes\.codex\./);
  const overridden = await put({ ...draft, modelProviders: { ...draft.modelProviders, 'gpt-6-sol': 'claude', 'claude-opus-5-5': 'claude' }, harnessRoutes: { ...draft.harnessRoutes, codex: { 'gpt-6-sol': 'codex' } }, ignoredRoutes: { codex: ['gpt-6-sol'] } });
  assert.equal(overridden.status, 200);
  const overriddenPolicy = (await overridden.json()).policy;
  assert.equal(overriddenPolicy.modelProviders['gpt-6-sol'], 'claude', 'the raw legacy route is kept');
  assert.deepEqual(overriddenPolicy.ignoredRoutes, {}, 'the override makes the legacy route compatible');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'policy.json'), 'utf8')).ignoredRoutes, undefined, 'the derived field is not stored');
  const catalog = await (await fetch(`${base}/api/models`)).json();
  assert.ok(!catalog.pi.allowedModels.includes('opencode-go/glm-5.2'), 'the model catalog endpoint stays the kit catalog');
});
