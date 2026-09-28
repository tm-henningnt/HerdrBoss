import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

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
  for (const route of ['/', '/login', '/api/state', '/api/models', '/api/policy', '/api/usage', '/api/projects', '/api/handoffs', '/api/mailbox']) {
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
    ['POST', '/api/messages'],
    ['POST', '/api/messages/read'],
    ['POST', '/api/messages/dismiss'],
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
  const loginPage = await fetch(`http://127.0.0.1:${customServer.server.address().port}/login`);
  assert.equal(loginPage.status, 200);
  assert.doesNotMatch(await loginPage.text(), /Unlock dashboard|name="token"/, 'the preview has no login page');
  const privateSessions = path.join(homeDir, '.config', 'herdr-boss', 'sessions.json');
  assert.equal(fs.existsSync(customTokenFile), false, 'the preview does not create the configured custom token');
  assert.equal(fs.existsSync(privateSessions), false, 'the preview does not create a session file');
  assert.equal(fs.existsSync(path.join(path.dirname(customTokenFile), 'sessions.json')), false, 'sessions are not stored beside the custom token');
  assert.equal(fs.existsSync(path.dirname(privateSessions)), false, 'the preview does not create the private access directory');
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
      engine.state = { control: null, quotas: [{ provider: 'codex', windows: [{ key: 'primary', label: 'Daily', windowMinutes: 1440, resetsAt: new Date(Date.now() + 12 * 3600000).toISOString() }] }] };
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
  const resetAt = (await (await fetch(`${base}/api/state`)).json()).quotas[0].windows[0].resetsAt;
  const timed = { ...draft, pacingGoals: { codex: { primary: { percent: 80, end: { type: 'at', at: new Date(Date.now() + 6 * 3600000).toISOString() } } } } };
  const acceptedGoal = await put(timed);
  assert.equal(acceptedGoal.status, 200);
  assert.equal((await acceptedGoal.json()).policy.pacingGoals.codex.primary.end.resetAt, resetAt);
  for (const [bad, reason] of [
    [new Date(Date.now() - 3600000).toISOString(), /after now/],
    [new Date(Date.parse(resetAt) + 3600000).toISOString(), /at or before reset/],
  ]) {
    const rejectedGoal = await put({ ...timed, pacingGoals: { codex: { primary: { percent: 80, end: { type: 'at', at: bad } } } } });
    assert.equal(rejectedGoal.status, 400);
    assert.match((await rejectedGoal.json()).errors.join(' '), reason);
  }
  assert.equal((await (await fetch(`${base}/api/policy`)).json()).pacingGoals.codex.primary.end.resetAt, resetAt, 'a rejected end keeps the saved goal');
  const catalog = await (await fetch(`${base}/api/models`)).json();
  assert.ok(!catalog.pi.allowedModels.includes('opencode-go/glm-5.2'), 'the model catalog endpoint stays the kit catalog');
});

test('the model catalog endpoint lists free opencode/ models only for the opencode harness', { timeout: 20000 }, async (t) => {
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
      engine.state = { control: null, quotas: [] };
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
  const catalog = await (await fetch(`${base}/api/models`)).json();
  assert.deepEqual(catalog.pi.allowedModels.filter((model) => model.startsWith('opencode/')), [], 'Pi lists no free opencode/ model');
  assert.ok(catalog.opencode.allowedModels.includes('opencode/big-pickle'), 'the opencode harness lists its free models');
  assert.equal(catalog.pi.defaultModel, 'opencode-go/muse-spark-1.3-contributor', 'the Pi default is unchanged');
  await close();
});

test('handoff API accepts a live boss-labeled pane without a project control entry', { timeout: 30000 }, async (t) => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  const bin = path.join(homeDir, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const herdr = path.join(bin, 'herdr');
  fs.writeFileSync(herdr, `#!/usr/bin/env node
const args = process.argv.slice(2);
let result = {};
if (args[0] === 'pane' && args[1] === 'get') result = { pane: {
  pane_id: args[2], workspace_id: 'ws-boss', label: 'boss', agent: 'codex',
  cwd: process.cwd(), foreground_cwd: process.cwd(), agent_session: { kind: 'id', value: 'boss-session' },
} };
if (args[0] === 'pane' && args[1] === 'process-info') result = { process_info: {
  shell_pid: 10, foreground_process_group_id: 10, foreground_processes: [{ pid: 10, name: 'zsh' }],
} };
if (args[0] === 'pane' && args[1] === 'read') result = { text: '% ' };
if (args[0] === 'agent' && args[1] === 'list') result = { agents: [] };
if (args[0] === 'tab' && args[1] === 'create') result = { root_pane: { pane_id: 'ws-boss:p2' } };
if (args[0] === 'agent' && args[1] === 'get') result = { agent_status: 'working' };
console.log(JSON.stringify({ result }));
`);
  fs.chmodSync(herdr, 0o755);
  fs.writeFileSync(path.join(dataDir, 'policy.json'), JSON.stringify({ projects: {} }));
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ control: { projects: {}, risks: {} } }));
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  const bossHandoff = { pane: 'ws-boss:p1', workspace: 'ws-boss', label: 'Boss' };
  let engine;
  const { server, close } = serve(cfg, {
    createEngine: () => {
      engine = new EventEmitter();
      engine.state = {
        control: { projects: {}, bossHandoff },
        herdr: { panes: [{ id: bossHandoff.pane, workspace: bossHandoff.workspace, label: 'boss' }] },
        quotas: [],
      };
      engine.tick = async () => engine.state;
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
  const body = { project: 'Boss', pane: bossHandoff.pane, to: 'pi', model: 'opencode-go/deepseek-v4.1-flash', mode: 'fresh' };
  const request = (route, requestBody = body) => fetch(`${base}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(requestBody),
  });
  const planResponse = await request('/api/handoffs/plan');
  const planText = await planResponse.text();
  assert.equal(planResponse.status, 200, planText);
  const plan = JSON.parse(planText);
  assert.equal(plan.boss, true);
  assert.equal(plan.project, 'Boss');
  const wrongPane = await request('/api/handoffs/plan', { ...body, pane: 'ws-boss:p9' });
  assert.equal(wrongPane.status, 400, 'the Boss path still requires the current boss pane');
  assert.match((await wrongPane.json()).error, /Unknown current orchestrator pane/);
  engine.state.herdr.panes[0].label = 'orch';
  const wrongLabel = await request('/api/handoffs/plan');
  assert.equal(wrongLabel.status, 400, 'the Boss path requires the exact boss label');
  assert.match((await wrongLabel.json()).error, /Unknown current orchestrator pane/);
  engine.state.herdr.panes[0].label = 'boss';
  const prepareResponse = await request('/api/handoffs/prepare');
  const prepareText = await prepareResponse.text();
  assert.equal(prepareResponse.status, 200, prepareText);
  const prepared = JSON.parse(prepareText);
  assert.equal(prepared.boss, true);
  assert.equal(prepared.sourcePane, bossHandoff.pane);
  assert.equal(prepared.status, 'prepared');
  await close();
  assert.equal(server.listening, false, 'the API integration stops its server');
});

function rawRequest(base, method, route, { headers = {}, body } = {}) {
  const url = new URL(route, base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test('the messages API validates Owner sends, refuses cross-origin and unauthenticated remote requests, and limits the rate', { timeout: 20000 }, async (t) => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  const { readMessages, STATUS_REQUEST_TEXT, NUDGES } = await import('../src/messages.js');
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  let engine;
  const { server, close } = serve(cfg, {
    createEngine: () => {
      engine = new EventEmitter();
      engine.state = { control: { projects: { alpha: { slug: 'alpha', workspace: 'wA', orch: { pane: 'wA:p1' } } } }, herdr: { panes: [] } };
      engine.tick = async () => engine.state;
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
  const post = (body, headers = {}) => fetch(`${base}/api/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });

  const invalid = [
    [{ thread: 'alpha', kind: 'message', text: '' }, 400],
    [{ thread: 'alpha', kind: 'message', text: '   ' }, 400],
    [{ thread: 'alpha', kind: 'message', text: 'x'.repeat(2001) }, 400],
    [{ thread: 'alpha', kind: 'message' }, 400],
    [{ thread: 'alpha', kind: 'nudge', text: 'Delete everything.' }, 400],
    [{ thread: 'alpha', kind: 'reply', text: 'Hi.' }, 400],
    [{ thread: 'Not A Slug', kind: 'message', text: 'Hi.' }, 400],
    [{ thread: 'gamma', kind: 'message', text: 'Hi.' }, 404],
  ];
  for (const [body, status] of invalid) {
    const response = await post(body);
    assert.equal(response.status, status, JSON.stringify(body));
    assert.ok((await response.json()).error);
  }
  const wrongType = await fetch(`${base}/api/messages`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(wrongType.status, 400);

  const crossOrigin = await rawRequest(base, 'POST', '/api/messages', {
    headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: JSON.stringify({ thread: 'boss', kind: 'message', text: 'Hi.' }),
  });
  assert.equal(crossOrigin.status, 403, 'a cross-origin send is refused');
  const crossSite = await rawRequest(base, 'POST', '/api/messages', {
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ thread: 'boss', kind: 'message', text: 'Hi.' }),
  });
  assert.equal(crossSite.status, 403, 'a cross-site send is refused');
  const remote = await rawRequest(base, 'POST', '/api/messages', {
    headers: { host: 'mac.tail0000.ts.net', 'content-type': 'application/json' }, body: JSON.stringify({ thread: 'boss', kind: 'message', text: 'Hi.' }),
  });
  assert.equal(remote.status, 401, 'a remote send without a session is refused');
  const remoteRead = await rawRequest(base, 'GET', '/api/messages?thread=boss', { headers: { host: 'mac.tail0000.ts.net' } });
  assert.equal(remoteRead.status, 401, 'a remote read without a session is refused');
  assert.deepEqual(readMessages(), [], 'no refused request reaches the store');

  const token = fs.readFileSync(cfg.access.tokenFile, 'utf8').trim();
  const login = await rawRequest(base, 'POST', '/login', {
    headers: { host: 'mac.tail0000.ts.net', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString(),
  });
  assert.equal(login.status, 303);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const remoteSend = await rawRequest(base, 'POST', '/api/messages', {
    headers: { host: 'mac.tail0000.ts.net', cookie, 'content-type': 'application/json', origin: 'http://mac.tail0000.ts.net' },
    body: JSON.stringify({ thread: 'boss', kind: 'message', text: 'From the phone.' }),
  });
  assert.equal(remoteSend.status, 200, remoteSend.text);

  const sent = await post({ thread: 'alpha', kind: 'message', text: '  Please continue.  ' });
  assert.equal(sent.status, 200);
  const record = (await sent.json()).message;
  assert.equal(record.thread, 'alpha');
  assert.equal(record.from, 'owner');
  assert.equal(record.to, 'orch');
  assert.equal(record.status, 'queued');
  assert.equal(record.text, 'Please continue.');
  const nudge = await post({ thread: 'alpha', kind: 'nudge', text: NUDGES[1] });
  assert.equal((await nudge.json()).message.text, 'Use your free worker slots.');
  const statusRequest = await post({ thread: 'boss', kind: 'status-request' });
  const statusRecord = (await statusRequest.json()).message;
  assert.equal(statusRecord.text, STATUS_REQUEST_TEXT);
  assert.equal(STATUS_REQUEST_TEXT, 'Send a short status report with herdr-boss say, and publish your status file.');
  assert.equal(statusRecord.to, 'boss');

  const thread = await fetch(`${base}/api/messages?thread=alpha`);
  assert.equal(thread.status, 200);
  assert.deepEqual((await thread.json()).map((m) => m.text), ['Please continue.', 'Use your free worker slots.'], 'newest last');
  assert.equal((await fetch(`${base}/api/messages?thread=Bad Thread`)).status, 400);
  assert.equal((await fetch(`${base}/api/messages`)).status, 400);

  // Four sends so far. The rate limit allows 10 in a minute across all threads.
  for (let i = 0; i < 6; i += 1) assert.equal((await post({ thread: i % 2 ? 'boss' : 'alpha', kind: 'message', text: `Send ${i}.` })).status, 200);
  const limited = await post({ thread: 'boss', kind: 'message', text: 'One too many.' });
  assert.equal(limited.status, 429);
  assert.match((await limited.json()).error, /10/);
  assert.equal(readMessages().length, 10);
});

test('organization page offers the Plain and Cards styles, motion with a reduced-motion fallback, and a phone worker count', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  // The switch stores the choice in localStorage behind try/catch, and Plain is the default.
  assert.match(app, /\['plain', 'cards'\]\.map\(\(style\) => `<button type="button" data-org-style="\$\{style\}" aria-pressed=/);
  assert.match(app, /const ORG_STYLE_KEY = 'herdr-boss\.orgStyle'/);
  assert.match(app, /try \{ return localStorage\.getItem\(ORG_STYLE_KEY\) === 'cards' \? 'cards' : 'plain'; \} catch \{ return 'plain'; \}/);
  assert.match(app, /try \{ localStorage\.setItem\(ORG_STYLE_KEY, orgStyle\); \} catch \{\}/);
  // Cards show an inline-SVG mark for each harness and a quota bar for Codex and Claude.
  for (const kind of ['claude', 'codex', 'opencode', 'pi', 'unknown']) assert.match(app, new RegExp(`\\b${kind}: '<svg`), `harness mark for ${kind}`);
  assert.match(app, /<div class="org-quota\$\{quota\.stale \? ' stale' : ''\}" role="img"/);
  assert.match(css, /\.org-cards \.org-state-working\b[^{]*\{[^}]*animation: org-pulse/);
  assert.match(css, /\.org-cards \.org-state-blocked\b/);
  assert.match(css, /\.org-cards \.org-state-failed\b/);
  // Motion reads the loaded events and falls back to a highlight when the viewer asks for reduced motion.
  assert.match(app, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)/);
  assert.match(app, /function orgEventLinks\(/);
  assert.match(app, /wrote its report/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[^}]*\.org-cards \.org-state-working/);
  assert.match(css, /\.org-flash\b/);
  // On a phone, a project shows a worker count that expands, with buttons of at least 44 px.
  assert.match(app, /data-org-workers="/);
  assert.match(css, /\.org-worker-count\b/);
  assert.match(css, /@media \(max-width: 760px\) \{[^@]*\.org-style-switch button[^}]*min-height: 44px/);
  assert.match(app, /Plain<\/b> and <b>Cards/);
});

test('quota cards show the shared pacing goal text in each window and the trickle footer', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /lane\?\.goals\?\.find\(\(goal\) => goal\.key === w\.key\)\?\.text/);
  assert.match(app, /const goalLabel = windowGoalText \? ` <span class="muted">· \$\{esc\(windowGoalText\)\}<\/span>`/);
  assert.match(app, /<div class="win-row"><span>\$\{esc\(w\.label\)\}\$\{goalLabel\}/);
  assert.match(app, /Trickle allowance: about \$\{lane\.allowancePercent\.toFixed\(1\)\}%\/day.*?\$\{esc\(trickleGoalText\)\}/s);
});

test('organization cards show an unavailable or stale quota bar, and the header keeps the brand and the updated text on one line', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  // A Claude or Codex card without quota data shows a muted empty bar with a label.
  assert.match(app, /function orgQuotaMeter\(s, kind\)/);
  assert.match(app, /aria-label="\$\{esc\(`\$\{PROVIDERS\[agent\]\} quota unavailable`\)\}"/);
  assert.match(app, /class="org-quota-note" aria-hidden="true">quota unavailable</);
  assert.match(app, /quota from \$\{clock\(quota\.staleSince\)\}, the last probe failed/);
  assert.match(css, /\.org-quota\.unavailable\b/);
  assert.match(css, /\.org-quota\.stale > i\b[^{]*\{/);
  assert.match(css, /\.org-quota-note\b[^{]*\{[^}]*color: var\(--muted\)/);
  // The brand and the updated text never break inside themselves.
  assert.match(css, /\.brand \{[^}]*white-space: nowrap/);
  assert.match(css, /\.live \{[^}]*white-space: nowrap/);
});

test('the dependency graph draws every task, with fit, zoom, pan, and a full-size overlay', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const guide = fs.readFileSync(new URL('../docs/user-guide.md', import.meta.url), 'utf8');
  // Every task is a node, including tasks without links. The 90-task cut and the empty-edge bail-out are gone.
  assert.doesNotMatch(app, /if \(!edges\.length\) return ''/);
  assert.doesNotMatch(app, /first 90/);
  assert.doesNotMatch(app, /nodes\.length > 90/);
  assert.match(app, /let nodes = m\.tasks\.slice\(\)/);
  // A task without links sits in column 0, after the linked tasks of that column.
  assert.match(app, /linked\.has\(keyOf\.get\(a\)\) \? 0 : 1/);
  // The toolbar has Fit, out, in, 100%, and Full size. Each button has an aria-label.
  for (const action of ['fit', 'out', 'in', '100', 'full']) assert.match(app, new RegExp(`data-dep-action="${action}"`), `${action} button`);
  assert.match(app, /aria-label="Fit the whole graph/);
  assert.match(app, /aria-label="Zoom out"/);
  assert.match(app, /aria-label="Zoom in"/);
  assert.match(app, /aria-label="Zoom to 100 percent"/);
  assert.match(app, /aria-label="Show the graph at full size"/);
  assert.match(app, /aria-label="Close full size"/);
  // The buttons are at least 32 px high on a desktop and 44 px on a phone.
  assert.match(css, /\.dep-btn\b[^{]*\{[^}]*min-height: 32px/);
  assert.match(css, /\.dep-btn, \.dep-close \{ min-height: 44px/);
  // The dark-theme global button color must not hide the toolbar labels.
  assert.match(css, /:root:not\(\[data-theme="light"\]\) \.dep-btn[^{]*\{[^}]*color: var\(--text\)/);
  // Zoom and pan change the viewBox only. The page is never scaled.
  assert.match(app, /const DEP_MIN_ZOOM = 0\.25/);
  assert.match(app, /DEP_MAX_ZOOM = 4/);
  assert.match(app, /svg\.setAttribute\('viewBox'/);
  assert.doesNotMatch(app, /\.dep-graph[^;]*transform: scale/);
  // Ctrl or Cmd with the wheel zooms around the pointer. A plain wheel scrolls the page.
  assert.match(app, /addEventListener\('wheel'/);
  assert.match(app, /if \(!\(e\.ctrlKey \|\| e\.metaKey\)\) return;/);
  assert.match(app, /\{ passive: false \}/);
  // Drag the background with pointer capture. A drag that starts on a task box does not pan.
  assert.match(app, /stage\.setPointerCapture\(e\.pointerId\)/);
  assert.match(app, /closest\?\.\('button, a, \.dep-node-group'\)/);
  // Full size is a fixed overlay with a close button. Escape and the button close it.
  assert.match(app, /function setDepFull\(slug, on\)/);
  assert.match(app, /body\.classList\.toggle\('dep-full-open', on\)/);
  assert.match(css, /\.dep-stage\.full\b[^{]*\{[^}]*position: fixed[^}]*inset: 0/);
  assert.match(app, /if \(e\.key !== 'Escape'\) return;[\s\S]{0,200}setDepFull/);
  // The help panel and the user guide describe the toolbar and the gestures.
  assert.match(app, /<b>Fit<\/b> to show the whole graph/);
  assert.match(app, /Drag the background to pan/);
  assert.match(guide, /Graph view/);
  assert.match(guide, /Ctrl or Cmd/);
});
