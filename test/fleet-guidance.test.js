import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { isTempDir } from './helpers/test-env.js';

// The test runner shares one data directory between the test files that run at the same time. This file writes the
// fleet files, the share plans, and the guidance state, so it owns a temporary data directory. Other test files that
// run at the same time write their own fleet-accounts.json and fleet-settings.json in the shared directory, and a
// shared fleet-accounts.json changes the answer of every fleet route here. Give this file its directory before the
// source modules read process.env.HERDR_BOSS_DIR, so the imports below stay dynamic.
const inheritedDataDir = process.env.HERDR_BOSS_DIR;
// Keep the path that mkdtemp gives. A sandbox can set TMPDIR to a symlink such as /tmp, and realpathSync() would
// return /private/tmp, which isTempDir() does not accept as a temporary directory.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-fleet-guidance-'));
process.env.HERDR_BOSS_DIR = root;
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
// Keep the directory that the runner shares for the other test files, and keep this one temporary.
if (!isTempDir(root)) throw new Error(`This test file needs a temporary data directory, not ${root}.`);
if (inheritedDataDir && path.resolve(inheritedDataDir) === root) throw new Error('This test file cannot share the data directory of the runner.');

const [{ serve }, { loadConfig }, { writeFleetFile }, { Engine }, { readAgentMessages },
  { loadPolicy, pacingGoal, laneStatus, POLICY_DEFAULTS }, { providerGate }] = await Promise.all([
  import('../src/server.js'), import('../src/config.js'), import('../src/fleet-store.js'), import('../src/engine.js'),
  import('../src/agent-messages.js'), import('../src/control.js'), import('../src/kit/workers.js'),
]);
const key = 'a'.repeat(64);
const account = { harness: 'codex', accountKey: key, scope: ['factory-a', 'factory-b'] };
const clock = () => Date.parse('2026-10-03T12:00:00Z');
const guidance = (extra = {}) => ({ schema: 1, contractVersion: '1.0.0', headOfficeFactoryId: 'factory-a', senderEpoch: 1,
  sentAt: '2026-10-03T12:00:00Z', shares: [{ accountKey: key, share: 40 }], nudges: [], ...extra });
function request(port, route, { method = 'GET', token, body, cookie, host, rawBody } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method, agent: false, headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}), ...(host ? { host } : {}),
      'content-type': rawBody ? 'application/x-www-form-urlencoded' : 'application/json',
    } }, (res) => {
      let text = ''; res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: (() => { try { return JSON.parse(text); } catch { return text; } })() }));
    });
    req.on('error', reject); req.end(rawBody || (body ? JSON.stringify(body) : undefined));
  });
}
async function start(t, { fetchImpl, preview = false, herdrRunner } = {}) {
  for (const name of ['fleet-guidance.json', 'fleet-shares.json', 'head-office-role.json']) fs.rmSync(path.join(root, name), { force: true });
  writeFleetFile(path.join(root, 'factory-identity.json'), { factoryId: 'factory-a' });
  writeFleetFile(path.join(root, 'fleet-accounts.json'), [account]);
  writeFleetFile(path.join(root, 'fleet-settings.json'), { name: 'factory-a', dashboardUrl: 'http://localhost:4477', headOffice: true, shareItemTitles: true });
  const cfg = { ...loadConfig(), host: '127.0.0.1', port: 0, tickSeconds: 3600, allowedHosts: ['*.localhost'] };
  const engine = new EventEmitter();
  engine.state = { updatedAt: new Date(clock()).toISOString(), herdr: { panes: [{ id: 'wA:pA', workspace: 'Boss', label: 'boss', agent: 'codex', status: 'idle' }] }, kit: { current: 'abcdef012345' }, quotas: [], projects: [], machine: {} };
  let firstTick;
  const ready = new Promise((resolve) => { firstTick = resolve; });
  engine.tick = async () => { firstTick(); return engine.state; }; engine.log = () => {};
  const delivered = [];
  engine.herdrRunner = herdrRunner || (async (binary, args) => {
    if (args[0] === 'agent' && args[1] === 'prompt') delivered.push({ binary, args });
    return '{}';
  });
  engine.promptService = Engine.prototype.promptService;
  const privateDir = path.join(root, 'private-guidance');
  const app = serve(cfg, { liveDataDir: root, readOnlyPreview: preview, createEngine: () => engine,
    health: async () => ({ schema: 1, contractVersion: '1.0.0', version: '0.1.0', kitRevision: 'abcdef012345', tickAgeSeconds: 0, herdrReachable: true, clockOffsetSeconds: null }),
    fleet: { privateDir, now: clock, registryFile: path.join(root, 'empty-registry.json'), ...(fetchImpl ? { fetchImpl } : {}) } });
  t.after(async () => { await app.close(); });
  if (!app.server.listening) await once(app.server, 'listening');
  await ready;
  return { app, cfg, port: app.server.address().port, privateDir, delivered };
}
async function credentials(privateDir) {
  const { createFleetGuideAccess, createFleetReadAccess } = await import('../src/fleet-access.js');
  return { guide: createFleetGuideAccess({ privateDir, now: clock }).rotate(), read: createFleetReadAccess({ privateDir, now: clock }).rotate() };
}

test('a preview skips register imports at startup', { timeout: 10000 }, async (t) => {
  const calls = [];
  const policyFile = path.join(root, 'policy.json');
  writeFleetFile(policyFile, { ...POLICY_DEFAULTS, projects: {} });
  t.after(() => fs.rmSync(policyFile, { force: true }));
  await start(t, { preview: true, herdrRunner: async (binary, args) => {
    calls.push({ binary, args });
    return '{}';
  } });
  const registerFile = path.join(root, 'project-register.json');
  assert.equal(calls.length, 0, 'preview startup does not call the register runner');
  assert.equal(fs.existsSync(registerFile), false, 'preview startup does not import records');
  assert.equal(fs.existsSync(path.join(root, 'locks', 'project-register')), false, 'preview startup does not take the register lock');
});

test('service startup imports open projects from asynchronous wrapped Herdr replies', { timeout: 10000 }, async (t) => {
  const slug = 'register-start-sample';
  const replies = {
    workspace: { workspaces: [{ workspace_id: 'wR', label: slug }] },
    pane: { panes: [
      { pane_id: 'wOther:pOther', workspace_id: 'wOther', label: 'orch' },
      { pane_id: 'wR:pR', workspace_id: 'wR', label: 'orch' },
    ] },
    agent: { agents: [{ pane_id: 'wR:pR', name: `${slug}-orch` }] },
  };
  const calls = [];
  const { port } = await start(t, { herdrRunner: async (_binary, args) => {
    calls.push(args);
    return JSON.stringify({ result: replies[args[0]] });
  } });
  t.after(() => {
    for (const name of ['project-register.json', 'project-audit.jsonl']) fs.rmSync(path.join(root, name), { force: true });
  });
  const result = await request(port, '/api/project-register');
  assert.equal(result.status, 200);
  const project = result.body.projects.find((row) => row.slug === slug);
  assert.ok(project, 'startup imports a project with a live project lead');
  assert.equal(project.state, 'open');
  assert.equal(project.onboarding.workspace, true);
  assert.equal(project.onboarding.orchestrator, true);
  assert.deepEqual(calls.slice(0, 3), [['workspace', 'list'], ['pane', 'list'], ['agent', 'list']]);
});

test('service startup catches rejected Herdr lists and keeps saved register states', { timeout: 10000 }, async (t) => {
  const { buildCandidateRecord, writeRegister } = await import('../src/project-register.js');
  const slug = 'register-unavailable-sample';
  const policyFile = path.join(root, 'policy.json');
  writeFleetFile(policyFile, { ...POLICY_DEFAULTS, projects: { [slug]: { share: 100 } } });
  writeRegister({ version: 1, projects: [buildCandidateRecord({ slug, state: 'open' }, root)] }, root);
  t.after(() => {
    for (const name of ['policy.json', 'project-register.json', 'project-audit.jsonl']) fs.rmSync(path.join(root, name), { force: true });
  });
  const { port } = await start(t, { herdrRunner: async () => { throw new Error('Herdr is unavailable.'); } });
  const result = await request(port, '/api/project-register');
  assert.equal(result.status, 200);
  assert.equal(result.body.projects.find((row) => row.slug === slug).state, 'open');
});

test('a preview reads saved register records without calling Herdr for onboarding', { timeout: 10000 }, async (t) => {
  const { buildCandidateRecord, writeRegister } = await import('../src/project-register.js');
  const slug = 'register-preview-sample';
  writeRegister({ version: 1, projects: [buildCandidateRecord({ slug, state: 'open' }, root)] }, root);
  t.after(() => fs.rmSync(path.join(root, 'project-register.json'), { force: true }));
  const calls = [];
  const { port } = await start(t, { preview: true, herdrRunner: async (_binary, args) => { calls.push(args); return '{}'; } });
  const result = await request(port, '/api/project-register');
  assert.equal(result.status, 200);
  assert.equal(result.body.projects.find((row) => row.slug === slug).state, 'open');
  assert.equal(result.body.readOnly, true);
  assert.equal(calls.length, 0);
});

test('guidance needs fleetGuide even on loopback; read, Owner, absent, and wrong credentials cannot submit', async (t) => {
  const { port, privateDir, cfg } = await start(t);
  const host = 'factory.localhost';
  const ownerToken = fs.readFileSync(cfg.access.tokenFile, 'utf8').trim();
  const login = await request(port, '/login', { method: 'POST', host, rawBody: new URLSearchParams({ token: ownerToken }).toString() });
  assert.equal(login.status, 303);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  assert.equal((await request(port, '/api/state', { host })).status, 401);
  assert.equal((await request(port, '/api/state', { host, cookie })).status, 200, 'the Owner cookie grants normal dashboard access');
  assert.equal((await request(port, '/api/fleet/guidance', { method: 'POST', host, cookie, body: guidance() })).status, 401, 'an authenticated Owner cookie cannot submit guidance');
  assert.equal((await request(port, '/api/fleet/guidance', { method: 'POST', body: guidance() })).status, 401);
  const { guide, read } = await credentials(privateDir);
  assert.equal((await request(port, '/api/fleet/guidance', { method: 'POST', token: read, body: guidance() })).status, 403);
  assert.equal((await request(port, '/api/fleet/guidance', { method: 'POST', token: `${guide.slice(0, -1)}z`, body: guidance() })).status, 403);
  assert.equal((await request(port, '/api/fleet/guidance', { method: 'POST', token: guide, body: guidance() })).status, 200);
  const result = await request(port, '/api/fleet/summary', { token: read });
  assert.equal(result.status, 200);
  assert.doesNotMatch(JSON.stringify(result.body), /nudges|nudgeId|fleetGuide|hf_guide_/);
});

test('fleetGuide cannot read text, change policy, start or stop workers, or bypass a route with another method', async (t) => {
  const { port, privateDir } = await start(t);
  const { guide } = await credentials(privateDir);
  for (const [method, route] of [['GET', '/api/messages'], ['GET', '/api/agent-messages'], ['GET', '/api/chat'], ['GET', '/api/state'], ['GET', '/api/fleet/summary'], ['PUT', '/api/policy'], ['POST', '/api/workers/start'], ['POST', '/api/workers/stop'], ['POST', '/api/projects/sample/stand-down'], ['GET', '/api/fleet/guidance'], ['PUT', '/api/fleet/shares'], ['GET', '/review-raw/a/b/c']]) {
    assert.equal((await request(port, route, { method, token: guide, ...(method === 'GET' ? {} : { body: { projects: {} } }) })).status, 403, `${method} ${route}`);
  }
});

test('receiver validates closed guidance, local account scope, monotonic epochs, and the holder at the same epoch', async (t) => {
  const { port, privateDir } = await start(t);
  const { guide } = await credentials(privateDir);
  const send = (body) => request(port, '/api/fleet/guidance', { method: 'POST', token: guide, body });
  for (const body of [guidance({ policy: {} }), guidance({ shares: [{ accountKey: key, share: 101 }] }), guidance({ shares: [{ accountKey: 'b'.repeat(64), share: 50 }] }), guidance({ shares: [guidance().shares[0], guidance().shares[0]] })]) assert.equal((await send(body)).status, 400);
  writeFleetFile(path.join(root, 'fleet-accounts.json'), [{ ...account, scope: ['factory-b'] }]);
  assert.equal((await send(guidance())).status, 400);
  writeFleetFile(path.join(root, 'fleet-accounts.json'), [account]);
  assert.equal((await send(guidance({ senderEpoch: 3 }))).status, 200);
  assert.equal((await send(guidance({ senderEpoch: 2 }))).status, 409);
  assert.equal((await send(guidance({ senderEpoch: 3, headOfficeFactoryId: 'factory-b' }))).status, 409);
  const before = fs.readFileSync(path.join(root, 'fleet-guidance.json'), 'utf8');
  writeFleetFile(path.join(root, 'head-office-role.json'), { schema: 1, contractVersion: '1.0.0', headOfficeFactoryId: 'factory-b', epoch: 4, updatedAt: new Date(clock()).toISOString() });
  assert.equal((await send(guidance({ senderEpoch: 4 }))).status, 409);
  assert.equal(fs.readFileSync(path.join(root, 'fleet-guidance.json'), 'utf8'), before);
});

test('accepted guidance survives restart and sets a pacing ceiling without changing project policy', async (t) => {
  const { app, port, privateDir } = await start(t);
  const { guide } = await credentials(privateDir);
  const policyFile = path.join(root, 'policy.json');
  writeFleetFile(policyFile, { ...POLICY_DEFAULTS, projects: { sample: { share: 60 } }, pacingGoals: { codex: { primary: 80, secondary: 20 } } });
  const before = fs.readFileSync(policyFile, 'utf8');
  assert.equal((await request(port, '/api/fleet/guidance', { method: 'POST', token: guide, body: guidance() })).status, 200);
  await app.close();
  const policy = loadPolicy();
  assert.equal(pacingGoal(policy, 'codex', 'primary'), 40);
  assert.equal(pacingGoal(policy, 'codex', 'secondary'), 20);
  assert.equal(policy.projects.sample.share, 60);
  assert.equal(fs.readFileSync(policyFile, 'utf8'), before);
  const quota = [{ provider: 'codex', windows: [{ key: 'primary', label: 'Daily', usedPercent: 41, expectedPercent: 90, windowMinutes: 1440, resetsAt: '2026-10-04T00:00:00Z' }] }];
  for (const mode of ['pace', 'ignore']) {
    const lanes = laneStatus(quota, { ...policy, providerModes: { codex: mode } }, clock());
    assert.equal(lanes.codex.factoryShare, 40);
    assert.equal(lanes.codex.factoryShareBlocked, true);
    assert.match(providerGate('codex', { lanes, avoidProviders: [], leastOverProvider: 'codex' }, { force: true }).error, /factory share/i);
  }
  const { createFleetGuidance } = await import('../src/fleet-guidance.js');
  const receiver = createFleetGuidance({ dir: root, settings: () => ({ factoryId: 'factory-a', accounts: [account] }), now: clock });
  assert.equal(receiver.view().shares[0].share, 40);
  await assert.rejects(receiver.accept(guidance({ senderEpoch: 0 })), /guidance/i);
});

test('nudges use the existing delivered service message path, are masked, and do not repeat on replay', async (t) => {
  const { port, privateDir, delivered } = await start(t);
  const { guide } = await credentials(privateDir);
  const body = guidance({ nudges: [{ nudgeId: 'sample-nudge', text: 'Slow sample work. password=sample-value' }] });
  for (let i = 0; i < 2; i++) assert.equal((await request(port, '/api/fleet/guidance', { method: 'POST', token: guide, body })).status, 200);
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0].args.slice(0, 3), ['agent', 'prompt', 'wA:pA']);
  assert.doesNotMatch(delivered[0].args[3], /sample-value/);
  const messages = readAgentMessages({ dir: root }).filter((row) => row.agentKind === 'nudge');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].to.role, 'boss');
  assert.equal(messages[0].status, 'delivered');
  assert.doesNotMatch(messages[0].text, /sample-value/);
});

test('head office validates totals and scopes before any send, persists plans, and uses only the guide credential', async (t) => {
  const calls = [];
  const { port, privateDir } = await start(t, { fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } }); } });
  const { guide } = await credentials(privateDir);
  writeFleetFile(path.join(privateDir, 'fleet-guide-remotes.json'), { 'factory-b': guide });
  const fixture = JSON.parse(fs.readFileSync(new URL('../docs/contracts/examples/factory-registry.valid.connection-ref.json', import.meta.url)));
  fixture.factories = [{ factoryId: 'factory-b', name: 'factory-b', hostId: 'host-a', kind: 'native', profile: 'personal', dashboardUrl: 'https://example.invalid', version: '0.1.0', kitRevision: 'abcdef012345' }];
  writeFleetFile(path.join(root, 'empty-registry.json'), fixture);
  const shares = (a, b, extra = []) => ({ accounts: [{ accountKey: key, shares: [{ factoryId: 'factory-a', share: a }, { factoryId: 'factory-b', share: b }, ...extra] }] });
  for (const body of [shares(60, 60), shares(40, 40, [{ factoryId: 'factory-c', share: 10 }]), shares(40.5, 40)]) assert.equal((await request(port, '/api/fleet/shares', { method: 'PUT', body })).status, 400);
  assert.equal(calls.length, 0);
  const saved = await request(port, '/api/fleet/shares', { method: 'PUT', body: shares(40, 60) });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.authorization, `Bearer ${guide}`);
  const sent = JSON.parse(calls[0].options.body);
  assert.deepEqual(sent.shares, [{ accountKey: key, share: 60 }]);
  assert.equal(sent.senderEpoch, 1);
  assert.deepEqual(sent.nudges, []);
  const view = await request(port, '/api/fleet/shares');
  assert.deepEqual(view.body.accounts[0].shares, shares(40, 60).accounts[0].shares);
  assert.doesNotMatch(JSON.stringify(view.body), /hf_guide_/);
  assert.equal(loadPolicy().factoryShares.codex, 40, 'local head office share uses the receiver too');
});

test('a zero factory share blocks a start without quota data and outside the account scope', async (t) => {
  const { port, privateDir } = await start(t);
  const { guide } = await credentials(privateDir);
  assert.equal((await request(port, '/api/fleet/guidance', { method: 'POST', token: guide, body: guidance({ shares: [{ accountKey: key, share: 0 }] }) })).status, 200);
  const lanes = laneStatus([], loadPolicy(), clock());
  assert.match(providerGate('codex', { lanes }, { force: true }).error, /factory share/i);
  writeFleetFile(path.join(root, 'fleet-accounts.json'), [{ ...account, scope: ['factory-b'] }]);
  assert.equal(loadPolicy().factoryShares.codex, 0);
});

test('a missing Boss keeps its masked nudge pending and the next guidance retries it once', async (t) => {
  const { app, port, privateDir, delivered } = await start(t);
  const { guide } = await credentials(privateDir);
  const panes = app.engine.state.herdr.panes;
  app.engine.state.herdr.panes = [];
  const first = await request(port, '/api/fleet/guidance', { method: 'POST', token: guide, body: guidance({ nudges: [{ nudgeId: 'sample-retry', text: 'Please slow sample work.' }] }) });
  assert.equal(first.body.nudges[0].status, 'pending');
  assert.equal(delivered.length, 0);
  app.engine.state.herdr.panes = panes;
  const retry = await request(port, '/api/fleet/guidance', { method: 'POST', token: guide, body: guidance({ shares: [], nudges: [] }) });
  assert.equal(retry.body.nudges[0].status, 'delivered');
  assert.equal(delivered.length, 1);
  assert.equal((await request(port, '/api/fleet/guidance', { method: 'POST', token: guide, body: guidance({ shares: [], nudges: [] }) })).status, 200);
  assert.equal(delivered.length, 1);
});

test('offline share delivery keeps the plan, reports no remote text, and retries after recovery', async (t) => {
  let offline = true, calls = 0;
  const { port, privateDir } = await start(t, { fetchImpl: async () => { calls++; if (offline) throw new Error('PRIVATE transport details'); return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }); } });
  const { guide } = await credentials(privateDir);
  writeFleetFile(path.join(privateDir, 'fleet-guide-remotes.json'), { 'factory-b': guide });
  writeFleetFile(path.join(root, 'empty-registry.json'), { schema: 1, contractVersion: '1.0.0', factories: [{ factoryId: 'factory-b', name: 'factory-b', hostId: 'host-a', kind: 'native', profile: 'personal', dashboardUrl: 'https://example.invalid', version: '0.1.0', kitRevision: 'abcdef012345' }] });
  const body = { accounts: [{ accountKey: key, shares: [{ factoryId: 'factory-a', share: 30 }, { factoryId: 'factory-b', share: 70 }] }] };
  const saved = await request(port, '/api/fleet/shares', { method: 'PUT', body });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.deliveries.find((row) => row.factoryId === 'factory-b').status, 'pending');
  assert.doesNotMatch(JSON.stringify(saved.body), /PRIVATE|hf_guide_/);
  assert.equal((await request(port, '/api/fleet/shares')).body.accounts[0].shares[1].share, 70);
  offline = false;
  const recovered = await request(port, '/api/fleet/shares', { method: 'PUT', body });
  assert.equal(recovered.body.deliveries.find((row) => row.factoryId === 'factory-b').status, 'delivered');
  assert.equal(calls, 2);
});

test('guide credential rotation keeps the old credential for exactly ten minutes', async () => {
  const { createFleetGuideAccess } = await import('../src/fleet-access.js');
  let now = clock();
  const access = createFleetGuideAccess({ privateDir: path.join(root, 'rotation-fixture'), now: () => now });
  const old = access.rotate(), next = access.rotate();
  const check = (token) => access.check({ headers: { authorization: `Bearer ${token}` } });
  assert.equal(check(old).authorized, true);
  now += 600000;
  assert.equal(check(old).authorized, false);
  assert.equal(check(next).authorized, true);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'rotation-fixture', 'fleet-guide.json'), 'utf8'), /hf_guide_/);
});

test('an Owner nudge without a saved share plan preserves the local profile ceiling', async (t) => {
  const { port, delivered } = await start(t);
  const result = await request(port, '/api/fleet/nudge', { method: 'POST', body: { factoryId: 'factory-a', nudgeId: 'owner-sample', text: 'Please finish sample work.' } });
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'delivered');
  assert.equal(delivered.length, 1);
  assert.equal(loadPolicy().factoryShares.codex, 100);
});


test('receiver refuses an epoch jump above 1000 without locking out the current head office', async (t) => {
  const { port, privateDir } = await start(t);
  const { guide } = await credentials(privateDir);
  const send = (senderEpoch) => request(port, '/api/fleet/guidance', { method: 'POST', token: guide, body: guidance({ senderEpoch }) });
  for (const epoch of [1001, Number.MAX_SAFE_INTEGER]) {
    assert.equal((await send(epoch)).status, 409);
    assert.equal(fs.existsSync(path.join(root, 'fleet-guidance.json')), false);
  }
  assert.equal((await send(17)).status, 200);
  const before = fs.readFileSync(path.join(root, 'fleet-guidance.json'), 'utf8');
  assert.equal((await send(1018)).status, 409);
  assert.equal(fs.readFileSync(path.join(root, 'fleet-guidance.json'), 'utf8'), before);
  assert.equal((await send(1017)).status, 200, 'a jump of exactly 1000 is accepted');
  assert.equal((await send(1017)).status, 200, 'the holder can still send at its stored epoch');
});

test('guidance transport refuses non-loopback HTTP before sending a bearer credential', async (t) => {
  const calls = [];
  const { port, privateDir } = await start(t, { fetchImpl: async (...args) => { calls.push(args); return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }); } });
  const { guide } = await credentials(privateDir);
  writeFleetFile(path.join(privateDir, 'fleet-guide-remotes.json'), { 'factory-b': guide });
  const record = { factoryId: 'factory-b', name: 'factory-b', hostId: 'host-a', kind: 'native', profile: 'personal', version: '0.1.0', kitRevision: 'abcdef012345' };
  for (const dashboardUrl of ['http://example.invalid', 'http://localhost.example.invalid', 'http://192.0.2.1']) {
    writeFleetFile(path.join(root, 'empty-registry.json'), { schema: 1, contractVersion: '1.0.0', factories: [{ ...record, dashboardUrl }] });
    for (const [route, method, body] of [
      ['/api/fleet/nudge', 'POST', { factoryId: 'factory-b', nudgeId: 'safe-transport', text: 'Sample nudge.' }],
      ['/api/fleet/shares', 'PUT', { accounts: [{ accountKey: key, shares: [{ factoryId: 'factory-a', share: 40 }, { factoryId: 'factory-b', share: 60 }] }] }],
    ]) {
      const result = await request(port, route, { method, body });
      assert.equal(result.status, 400);
      assert.match(result.body.error, /HTTPS.*HTTP.*loopback/i);
      assert.doesNotMatch(JSON.stringify(result.body), /hf_guide_|example.invalid|192\.0\.2/);
      assert.equal(calls.length, 0);
    }
  }
});

test('guidance transport sends bearer credentials only to HTTPS or HTTP loopback targets', async (t) => {
  const calls = [];
  const { port, privateDir } = await start(t, { fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }); } });
  const { guide } = await credentials(privateDir);
  writeFleetFile(path.join(privateDir, 'fleet-guide-remotes.json'), { 'factory-b': guide });
  const record = { factoryId: 'factory-b', name: 'factory-b', hostId: 'host-a', kind: 'native', profile: 'personal', version: '0.1.0', kitRevision: 'abcdef012345' };
  for (const [index, dashboardUrl] of ['https://example.invalid', 'http://localhost:4477', 'http://127.0.0.1:4477', 'http://127.0.0.2:4477'].entries()) {
    writeFleetFile(path.join(root, 'empty-registry.json'), { schema: 1, contractVersion: '1.0.0', factories: [{ ...record, dashboardUrl }] });
    const result = await request(port, '/api/fleet/nudge', { method: 'POST', body: { factoryId: 'factory-b', nudgeId: `transport-${index}`, text: 'Sample nudge.' } });
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'delivered');
    assert.equal(calls[index].url, `${dashboardUrl}/api/fleet/guidance`);
    assert.equal(calls[index].options.headers.authorization, `Bearer ${guide}`);
    assert.equal(calls[index].options.redirect, 'error');
  }
});


for (const [name, extra] of [
  ['a bad nudgeId', { nudgeId: 'Bad_ID' }],
  ['empty text', { text: '' }],
  ['blank text', { text: '   ' }],
  ['text over 500 characters', { text: 'a'.repeat(501) }],
  ['an unscoped factory', { factoryId: 'factory-c' }],
]) {
  test(`POST nudge refuses ${name} before delivery`, async (t) => {
    const { port, delivered } = await start(t);
    const result = await request(port, '/api/fleet/nudge', { method: 'POST', body: { factoryId: 'factory-a', nudgeId: 'sample-refusal', text: 'Sample text.', ...extra } });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /scoped factory.*nudge ID.*1 to 500/);
    assert.equal(delivered.length, 0);
    assert.equal(fs.existsSync(path.join(root, 'fleet-guidance.json')), false);
  });
}

test('POST nudge refuses a repeated nudgeId with different text with 409', async (t) => {
  const { port, delivered } = await start(t);
  const body = { factoryId: 'factory-a', nudgeId: 'same-nudge', text: 'First sample text.' };
  assert.equal((await request(port, '/api/fleet/nudge', { method: 'POST', body })).status, 200);
  const before = fs.readFileSync(path.join(root, 'fleet-guidance.json'), 'utf8');
  const refused = await request(port, '/api/fleet/nudge', { method: 'POST', body: { ...body, text: 'Different sample text.' } });
  assert.equal(refused.status, 409);
  assert.equal(delivered.length, 1);
  assert.equal(fs.readFileSync(path.join(root, 'fleet-guidance.json'), 'utf8'), before);
});

test('guidance accepts 100 shares and refuses 101 before storing or delivering', async (t) => {
  const { port, privateDir, delivered } = await start(t);
  const { guide } = await credentials(privateDir);
  const accounts = Array.from({ length: 100 }, (_, index) => ({ harness: `sample-${index}`, accountKey: index.toString(16).padStart(64, '0'), scope: ['factory-a'] }));
  writeFleetFile(path.join(root, 'fleet-accounts.json'), accounts);
  const shares = accounts.map(({ accountKey }) => ({ accountKey, share: 40 }));
  const send = (shares) => request(port, '/api/fleet/guidance', { method: 'POST', token: guide, body: guidance({ shares }) });
  assert.equal((await send(shares)).status, 200);
  const before = fs.readFileSync(path.join(root, 'fleet-guidance.json'), 'utf8');
  const refused = await send([...shares, shares[0]]);
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, 'The guidance body is invalid.');
  assert.equal(fs.readFileSync(path.join(root, 'fleet-guidance.json'), 'utf8'), before);
  assert.equal(delivered.length, 0);
});

test('guidance accepts 100 nudges and refuses 101 before storing or delivering', async (t) => {
  const { port, privateDir, delivered } = await start(t);
  const { guide } = await credentials(privateDir);
  const nudges = Array.from({ length: 100 }, (_, index) => ({ nudgeId: `sample-${index}`, text: 'Sample nudge.' }));
  const send = (nudges) => request(port, '/api/fleet/guidance', { method: 'POST', token: guide, body: guidance({ nudges }) });
  assert.equal((await send(nudges)).status, 200);
  assert.equal(delivered.length, 100);
  const before = fs.readFileSync(path.join(root, 'fleet-guidance.json'), 'utf8');
  const refused = await send([...nudges, { nudgeId: 'one-more', text: 'Sample nudge.' }]);
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, 'The guidance body is invalid.');
  assert.equal(fs.readFileSync(path.join(root, 'fleet-guidance.json'), 'utf8'), before);
  assert.equal(delivered.length, 100);
});

test('a head office term accepts 2000 nudge IDs, refuses 2001, and still accepts replay', async (t) => {
  const { port, privateDir, delivered } = await start(t);
  const { guide } = await credentials(privateDir);
  writeFleetFile(path.join(root, 'fleet-guidance.json'), { senderEpoch: 1, headOfficeFactoryId: 'factory-a', shares: [],
    nudges: Array.from({ length: 1999 }, (_, index) => ({ nudgeId: `sample-${index}`, hash: 'a'.repeat(64), delivered: true })) });
  const nudge = { nudgeId: 'term-last', text: 'Last sample nudge.' };
  const send = (nudges) => request(port, '/api/fleet/guidance', { method: 'POST', token: guide, body: guidance({ nudges }) });
  assert.equal((await send([nudge])).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'fleet-guidance.json'))).nudges.length, 2000);
  const before = fs.readFileSync(path.join(root, 'fleet-guidance.json'), 'utf8');
  const refused = await send([{ nudgeId: 'term-extra', text: 'Extra sample nudge.' }]);
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /2000 nudge IDs/);
  assert.equal(fs.readFileSync(path.join(root, 'fleet-guidance.json'), 'utf8'), before);
  assert.equal((await send([nudge])).status, 200);
  assert.equal(delivered.length, 1);
});

for (const action of ['shares', 'nudge']) {
  test(`a non-holder factory cannot send ${action} and receives 409`, async (t) => {
    const { port, delivered } = await start(t);
    writeFleetFile(path.join(root, 'head-office-role.json'), { epoch: 4, headOfficeFactoryId: 'factory-b' });
    const body = action === 'shares'
      ? { accounts: [{ accountKey: key, shares: [{ factoryId: 'factory-a', share: 40 }, { factoryId: 'factory-b', share: 60 }] }] }
      : { factoryId: 'factory-a', nudgeId: 'non-holder', text: 'Sample nudge.' };
    const result = await request(port, `/api/fleet/${action}`, { method: action === 'shares' ? 'PUT' : 'POST', body });
    assert.equal(result.status, 409);
    assert.match(result.body.error, /does not hold the head office role/);
    assert.equal(fs.existsSync(path.join(root, 'fleet-guidance.json')), false);
    assert.equal(fs.existsSync(path.join(root, 'fleet-shares.json')), false);
    assert.equal(delivered.length, 0);
  });
}
