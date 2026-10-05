import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';

const root = process.env.HERDR_BOSS_DIR;
process.env.HERDR_FACTORIES_DIR = path.join(root, 'factories');
// A read-only preview needs a data directory that the service does not use.
process.env.HERDR_BOSS_LIVE_DIR = path.join(process.env.HERDR_BOSS_DIR, 'separate-live-fixture');
const [{ serve }, { loadConfig }, { createFleetReadAccess, createFleetGuideAccess }, { appendMessage }] = await Promise.all([
  import('../src/server.js'), import('../src/config.js'), import('../src/fleet-access.js'), import('../src/messages.js'),
]);

export function request(port, route, { method = 'GET', token, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(host ? { host } : {}), ...(body ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let text = ''; res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: (() => { try { return JSON.parse(text); } catch { return text; } })() }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}

function registryFactory(id, url) {
  return { factoryId: id, name: id, hostId: 'example-host', kind: 'native', profile: 'personal', dashboardUrl: url, version: '0.1.0', kitRevision: 'abcdef012345' };
}

function writeRegistry(file, factories) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema: 1, contractVersion: '1.0.0', minimumFactoryVersion: '0.1.0',
    hosts: [{ hostId: 'example-host', runtime: 'orbstack', personalOnly: true, codexSandbox: 'user-namespaces', transport: 'local' }], factories }));
}

const remoteUrl = 'http://192.0.2.1';
const REMOTE_READ_TOKEN = `hf_read_${'a'.repeat(64)}`;
// One invented remote factory and one invented valid read credential. The fetch counts prove whether a remote read happens.
function remoteFixture() {
  const calls = { total: 0, summary: 0 };
  const base = JSON.parse(fs.readFileSync(new URL('../docs/contracts/examples/fleet-summary.valid.personal.json', import.meta.url)));
  return {
    calls,
    credentials: () => ({ win1: REMOTE_READ_TOKEN }),
    fetchImpl: async (url) => {
      calls.total += 1;
      if (!String(url).endsWith('/api/fleet/summary')) throw new Error('No remote request is expected for this URL.');
      calls.summary += 1;
      return new Response(JSON.stringify({ ...base, factoryId: 'win1', name: 'win1', dashboardUrl: remoteUrl, generatedAt: new Date().toISOString() }), { headers: { 'content-type': 'application/json' } });
    },
  };
}

function writeSettings({ headOffice = true, shareItemTitles = true } = {}) {
  fs.writeFileSync(path.join(root, 'fleet-settings.json'), JSON.stringify({ name: 'factory-zero', dashboardUrl: 'http://localhost:4477', headOffice, shareItemTitles }));
}

function engineFixture() {
  const engine = new EventEmitter();
  engine.state = { updatedAt: new Date().toISOString(), errors: [], kit: { current: 'abcdef012345' },
    control: { runningWorkers: 5, maxWorkers: 12 },
    machine: { load: [1, 2, 3], cpus: 4, memTotalGB: 8, memFreePercent: 55, swapUsedMB: 3, diskFreePercent: 50, diskFreeBytes: 100 * 2 ** 20 },
    herdr: { panes: [{ label: 'boss', agent: 'claude' }] },
    projects: [], quotas: [], alerts: [] };
  engine.tick = async () => engine.state;
  engine.log = () => {};
  return engine;
}

const health = async () => ({ schema: 1, contractVersion: '1.0.0', version: '0.1.0', kitRevision: 'abcdef012345',
  tickAgeSeconds: 1, herdrReachable: true, clockOffsetSeconds: null });

async function start(t, { fleet = {}, registry = null, settings = {}, preview = false } = {}) {
  writeSettings(settings);
  const registryFile = path.join(root, `registry-${Math.random().toString(36).slice(2)}.json`);
  writeRegistry(registryFile, registry || []);
  const privateDir = path.join(root, `private-${Math.random().toString(36).slice(2)}`);
  // Drop the poll cache of an earlier case, so a saved remote summary cannot reach a later case.
  fs.rmSync(path.join(root, 'fleet-cache.json'), { force: true });
  const cfg = { ...loadConfig(), host: '127.0.0.1', port: 0, tickSeconds: 3600, allowedHosts: ['*.localhost'] };
  const engine = engineFixture();
  const app = serve(cfg, { readOnlyPreview: preview, liveDataDir: root, createEngine: () => engine, health,
    fleet: { privateDir, registryFile, ...fleet } });
  t.after(() => app.close());
  if (!app.server.listening) await once(app.server, 'listening');
  return { app, cfg, engine, privateDir, registryFile, port: app.server.address().port };
}

test('the Fleet route adds the rollup over the accepted summaries and keeps the old fields', async (t) => {
  const { port } = await start(t, { registry: [registryFactory('win1', 'http://192.0.2.1')] });
  const result = await request(port, '/api/fleet');
  assert.equal(result.status, 200, JSON.stringify(result.body));

  // The old response fields stay.
  assert.equal(result.body.pollSeconds, 30);
  assert.equal(result.body.registryError, null);
  assert.ok(result.body.role && typeof result.body.role === 'object', 'the role stays in the response');
  assert.deepEqual(result.body.factories.map((row) => row.name), ['factory-zero', 'win1']);
  assert.equal(result.body.factories[1].attach, 'not-attached', 'a remote row keeps its attach state');
  assert.equal(result.body.factories[0].attach, undefined, 'the local row has no attach state');
  assert.equal(result.body.factories[0].summary.factoryId, (await request(port, '/api/fleet/settings')).body.factoryId);

  // The rollup is the hand-computed rollup of the two-factory fixture.
  assert.ok(result.body.rollup && typeof result.body.rollup === 'object', 'the route returns the rollup');
  assert.equal(result.body.rollup.factories.length, 2);
  assert.equal(result.body.rollup.factories[0].freshness, 'fresh');
  assert.equal(result.body.rollup.factories[1].freshness, 'never seen');

  assert.equal(result.body.rollup.totals.workers.value, 5, 'the fresh worker count only');
  assert.match(result.body.rollup.totals.workers.coverage, /1 of 2 factories reporting/);
  assert.match(result.body.rollup.totals.workers.coverage, /win1 \(never seen\)/);
  assert.equal(typeof result.body.rollup.totals.workers.asOf, 'number');

  assert.equal(result.body.rollup.totals.spend.value, 'unknown');
  assert.match(result.body.rollup.totals.spend.coverage, /factory-zero \(no spend rows\)/);
  assert.equal(result.body.rollup.totals.quota.value, 'unknown');
  assert.match(result.body.rollup.totals.quota.coverage, /factory-zero \(quota unknown\)/);

  assert.doesNotMatch(JSON.stringify(result.body), /hf_read_|invented-secret|PRIVATE MESSAGE/);
});

test('a private factory adds no owner item title to the rollup', async (t) => {
  appendMessage({ thread: 'boss', from: 'boss', to: 'owner', kind: 'reply', action: 'decide',
    title: 'Invented private title', text: 'Invented private text', status: 'new' }, { dir: root });
  const { port } = await start(t, { settings: { shareItemTitles: false } });
  const result = await request(port, '/api/fleet');
  assert.equal(result.status, 200);
  const rows = result.body.factories[0].summary.ownerItems.rows;
  assert.ok(rows.length >= 1, 'the owner item enters the summary');
  assert.equal(rows[0].title, undefined, 'the private summary carries no title');
  assert.doesNotMatch(JSON.stringify(result.body.rollup), /Invented private title/);
  assert.doesNotMatch(JSON.stringify(result.body.rollup), /Invented private text/);
});

test('the rollup carries an owner item title when the sharing setting allows it', async (t) => {
  appendMessage({ thread: 'boss', from: 'boss', to: 'owner', kind: 'reply', action: 'decide',
    title: 'Invented shared title', text: 'Invented shared text', status: 'new' }, { dir: root });
  const { port } = await start(t, { settings: { shareItemTitles: true } });
  const result = await request(port, '/api/fleet');
  assert.equal(result.status, 200);
  assert.match(JSON.stringify(result.body.rollup), /Invented shared title/);
});

test('a rollup failure returns a null rollup and a short error without a stack or a path', async (t) => {
  const { port } = await start(t, { settings: { headOffice: false }, fleet: { now: () => Number.NaN, schedule: () => 0 } });
  const result = await request(port, '/api/fleet');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.rollup, null);
  assert.equal(typeof result.body.rollupError, 'string');
  assert.ok(result.body.rollupError.length > 0 && result.body.rollupError.length < 200);
  assert.doesNotMatch(result.body.rollupError, /\/|at |Error|\.js|\n/);
});

test('the fleetRead credential is refused on the Fleet route and the loopback rule holds', async (t) => {
  const { port, privateDir } = await start(t);
  const read = createFleetReadAccess({ privateDir }).rotate();
  const guide = createFleetGuideAccess({ privateDir }).rotate();
  assert.equal((await request(port, '/api/fleet', { token: read })).status, 403, 'the read credential cannot read the Fleet route');
  assert.equal((await request(port, '/api/fleet/summary', { token: read })).status, 200, 'the read credential still reads the summary');
  assert.equal((await request(port, '/api/fleet', { token: guide })).status, 403, 'the guide credential cannot read the Fleet route');
  assert.equal((await request(port, '/api/fleet', { host: 'factory.localhost' })).status, 401, 'a request with no session is refused');
});

test('a live head office reads the remote factory and adds it to the rollup (positive control)', async (t) => {
  const remote = remoteFixture();
  const { port } = await start(t, { registry: [registryFactory('win1', remoteUrl)],
    fleet: { credentials: remote.credentials, fetchImpl: remote.fetchImpl } });
  const result = await request(port, '/api/fleet');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.ok(remote.calls.summary > 0, 'the head office reads the remote summary');
  assert.deepEqual(result.body.factories.map((row) => row.name), ['factory-zero', 'win1']);
  assert.deepEqual(result.body.rollup.factories.map((row) => row.name), ['factory-zero', 'win1']);
});

test('a read-only preview keeps the local rollup, sends no remote request, and refuses a non-local or write request', async (t) => {
  const remote = remoteFixture();
  const { port } = await start(t, { preview: true, registry: [registryFactory('win1', remoteUrl)],
    fleet: { credentials: remote.credentials, fetchImpl: remote.fetchImpl } });
  const local = await request(port, '/api/fleet');
  assert.equal(local.status, 200, JSON.stringify(local.body));
  assert.ok(local.body.rollup && local.body.rollup.factories.some((row) => row.name === 'factory-zero'), 'the preview returns the local rollup');
  assert.equal(remote.calls.total, 0, 'the preview sends no remote request');

  const nonLocal = await request(port, '/api/fleet', { host: 'preview.tail0000.ts.net' });
  assert.equal(nonLocal.status, 403);
  assert.equal(nonLocal.body.error, 'The read-only preview accepts only local requests.');
  assert.equal((await request(port, '/api/fleet', { method: 'PUT', body: {} })).status, 403);
  assert.equal(remote.calls.total, 0, 'a refused request sends no remote request');
});
