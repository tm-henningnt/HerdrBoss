import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';

const fixture = JSON.parse(fs.readFileSync(new URL('../docs/contracts/examples/fleet-summary.valid.personal.json', import.meta.url)));
const root = process.env.HERDR_BOSS_DIR;
process.env.HERDR_FACTORIES_DIR = path.join(root, 'factories');
const factory = (id, url) => ({ factoryId: id, name: id, hostId: 'example-host', kind: 'native', profile: 'personal', dashboardUrl: url, version: '0.1.0', kitRevision: 'abcdef012345' });
function registry(file, factories) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ schema: 1, contractVersion: '1.0.0', minimumFactoryVersion: '0.1.0', hosts: [{ hostId: 'example-host', runtime: 'orbstack', personalOnly: true, codexSandbox: 'user-namespaces', transport: 'local' }], factories })); }

test('the poller sends only the read credential, keeps last good data, and refuses a cloned identity', async (t) => {
  const { createFleetPoller } = await import('../src/fleet-poller.js');
  let now = Date.parse(fixture.generatedAt), outage = false, clone = false;
  const received = [];
  const remote = http.createServer((req, res) => {
    received.push({ method: req.method, path: req.url, token: req.headers.authorization });
    if (outage) { res.writeHead(503); return res.end('PRIVATE failure /private/fixture'); }
    const name = req.headers.host.startsWith('127.0.0.1') ? 'factory-a' : 'factory-b';
    const body = { ...fixture, factoryId: clone ? 'factory-zero' : name, name, dashboardUrl: `http://${req.headers.host}`, generatedAt: new Date(now).toISOString().replace('.000Z', 'Z'), future: { token: 'PRIVATE future' }, machine: { ...fixture.machine, futurePath: '/private/fixture' } };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body));
  });
  remote.listen(0, '127.0.0.1'); await once(remote, 'listening'); t.after(() => new Promise((resolve) => remote.close(resolve)));
  const url = `http://127.0.0.1:${remote.address().port}`;
  const registryFile = path.join(process.env.HERDR_FACTORIES_DIR, 'fleet.json');
  registry(registryFile, [factory('factory-a', url)]);
  fs.writeFileSync(path.join(process.env.HERDR_FACTORIES_DIR, 'registry.json'), '{broken private connection store');
  const local = { ...fixture, factoryId: 'factory-zero', name: 'factory-zero', dashboardUrl: 'http://localhost:4477' };
  const poller = createFleetPoller({ dir: root, registryFile, localSummary: async () => local, credentials: () => ({ 'factory-a': 'hf_read_' + 'a'.repeat(64) }), now: () => now });
  t.after(() => poller.stop());
  await poller.poll();
  let view = poller.view();
  assert.equal(view.factories.length, 2);
  assert.equal(view.factories[1].status, 'healthy');
  assert.deepEqual(received[0], { method: 'GET', path: '/api/fleet/summary', token: 'Bearer hf_read_' + 'a'.repeat(64) });
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE|futurePath|future|keyFile/);
  outage = true; now += 90000; await poller.poll();
  view = poller.view();
  assert.equal(view.factories[1].status, 'offline');
  assert.equal(view.factories[1].ageSeconds, 90000 / 1000);
  assert.equal(view.factories[1].summary.factoryId, 'factory-a');
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE|fixture/);
  outage = false; clone = true; await poller.poll();
  assert.equal(poller.view().factories[1].error, 'duplicate-factory-id');
  assert.equal(poller.view().factories[1].summary.factoryId, 'factory-a');
  await poller.stop();
  const restarted = createFleetPoller({ dir: root, registryFile, localSummary: async () => local, now: () => now });
  assert.equal(restarted.view().factories[0].summary.factoryId, 'factory-a', 'the sanitized last good summary survives a restart');
  await restarted.stop();
});

test('polling schedules every 30 seconds, does not overlap, and stops its timer', async () => {
  const { createFleetPoller, FLEET_POLL_MS } = await import('../src/fleet-poller.js');
  const registryFile = path.join(process.env.HERDR_FACTORIES_DIR, 'empty-fleet.json');
  registry(registryFile, []);
  let finish, calls = 0, scheduled, cancelled;
  const poller = createFleetPoller({ dir: root, registryFile, localSummary: () => { calls++; return new Promise((resolve) => { finish = resolve; }); }, schedule: (fn, ms) => { scheduled = { fn, ms }; return 42; }, cancel: (id) => { cancelled = id; }, now: () => 123456 });
  poller.start();
  const pending = poller.poll();
  assert.equal(calls, 1);
  assert.equal(poller.poll(), pending);
  finish(fixture); await pending;
  assert.equal(scheduled.ms, FLEET_POLL_MS);
  await poller.stop();
  assert.equal(cancelled, 42);
  await scheduled.fn();
  assert.equal(calls, 1);
});

test('a bad version or dashboard URL never replaces the accepted summary', async (t) => {
  const { createFleetPoller } = await import('../src/fleet-poller.js');
  let body = { ...fixture, dashboardUrl: 'http://192.0.2.1' };
  const registryFile = path.join(process.env.HERDR_FACTORIES_DIR, 'refusal-fleet.json');
  registry(registryFile, [factory('factory-a', 'http://192.0.2.1')]);
  const poller = createFleetPoller({ dir: path.join(root, 'refusal-cache'), registryFile,
    localSummary: async () => ({ ...fixture, factoryId: 'factory-zero', name: 'factory-zero', dashboardUrl: 'http://localhost:4477' }),
    credentials: () => ({ 'factory-a': 'hf_read_' + 'a'.repeat(64) }),
    fetchImpl: async () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }), now: () => Date.parse(fixture.generatedAt) });
  t.after(() => poller.stop());
  await poller.poll();
  const good = poller.view().factories.find((row) => row.remote).summary;
  for (const bad of [{ ...body, schema: 2 }, { ...body, dashboardUrl: 'https://example.invalid' }, { ...body, machine: { ...body.machine, cpus: 0 } }, { ...body, shareItemTitles: false }]) {
    body = bad; await poller.poll();
    const row = poller.view().factories.find((row) => row.remote);
    assert.equal(row.status, 'offline'); assert.deepEqual(row.summary, good);
  }
});

test('stopping the poller aborts its active request and leaves no new timer', async () => {
  const { createFleetPoller } = await import('../src/fleet-poller.js');
  const registryFile = path.join(process.env.HERDR_FACTORIES_DIR, 'abort-fleet.json');
  registry(registryFile, [factory('factory-a', 'http://192.0.2.1')]);
  let arrived, signal;
  const started = new Promise((resolve) => { arrived = resolve; });
  const poller = createFleetPoller({ dir: path.join(root, 'abort-cache'), registryFile,
    localSummary: async () => ({ ...fixture, factoryId: 'factory-zero', name: 'factory-zero', dashboardUrl: 'http://localhost:4477' }),
    credentials: () => ({ 'factory-a': 'hf_read_' + 'a'.repeat(64) }), now: () => Date.parse(fixture.generatedAt),
    fetchImpl: async (_url, options) => { signal = options.signal; arrived(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })); } });
  const pending = poller.poll(); await started; await poller.stop(); await pending;
  assert.equal(signal.aborted, true);
});

test('a registered factory cannot replace factory zero by reusing its display name', async () => {
  const { createFleetPoller } = await import('../src/fleet-poller.js');
  const registryFile = path.join(process.env.HERDR_FACTORIES_DIR, 'name-collision-fleet.json');
  registry(registryFile, [{ ...factory('factory-b', 'http://192.0.2.1'), name: 'factory-zero' }]);
  const poller = createFleetPoller({ dir: path.join(root, 'name-cache'), registryFile,
    localSummary: async () => ({ ...fixture, factoryId: 'factory-zero', name: 'factory-zero', dashboardUrl: 'http://localhost:4477' }),
    credentials: () => ({ 'factory-b': 'hf_read_' + 'b'.repeat(64) }),
    fetchImpl: async () => new Response(JSON.stringify({ ...fixture, factoryId: 'factory-b', name: 'factory-zero', dashboardUrl: 'http://192.0.2.1' }), { headers: { 'content-type': 'application/json' } }), now: () => Date.parse(fixture.generatedAt) });
  await poller.poll();
  assert.equal(poller.view().registryError, 'duplicate-factory-name');
  assert.equal(poller.view().factories[0].summary.factoryId, 'factory-zero');
  await poller.stop();
});

test('renaming factory zero keeps one local row', async () => {
  const { createFleetPoller } = await import('../src/fleet-poller.js');
  const registryFile = path.join(process.env.HERDR_FACTORIES_DIR, 'rename-fleet.json'); registry(registryFile, []);
  let name = 'factory-zero';
  const poller = createFleetPoller({ dir: path.join(root, 'rename-cache'), registryFile, localSummary: async () => ({ ...fixture, factoryId: 'factory-zero', name }), now: () => Date.parse(fixture.generatedAt) });
  await poller.poll(); name = 'renamed-zero'; await poller.poll();
  assert.equal(poller.view().factories.length, 1);
  assert.equal(poller.view().factories[0].name, 'renamed-zero');
  await poller.stop();
});
