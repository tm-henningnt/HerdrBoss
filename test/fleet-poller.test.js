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

test('a guidance retry failure cannot turn a successful read-only summary poll into an outage', async (t) => {
  const { createFleetPoller } = await import('../src/fleet-poller.js');
  const registryFile = path.join(root, 'guidance-retry-registry.json');
  registry(registryFile, [factory('factory-b', 'https://example.invalid')]);
  const poller = createFleetPoller({ dir: path.join(root, 'guidance-retry-cache'), registryFile,
    localSummary: async () => ({ ...fixture, name: 'factory-zero', factoryId: 'factory-zero' }),
    credentials: () => ({ 'factory-b': 'hf_read_' + 'a'.repeat(64) }), now: () => Date.parse(fixture.generatedAt),
    fetchImpl: async () => new Response(JSON.stringify({ ...fixture, name: 'factory-b', factoryId: 'factory-b', dashboardUrl: 'https://example.invalid' }), { headers: { 'content-type': 'application/json' } }),
    onSummary: async () => { throw new Error('PRIVATE guidance transport detail'); } });
  t.after(() => poller.stop());
  await poller.poll();
  const row = poller.view().factories.find((item) => item.remote);
  assert.equal(row.status, 'healthy');
  assert.equal(row.error, null);
  assert.equal(row.summary.factoryId, 'factory-b');
});

test('the poller carries registry kind and preserves optional fields from a newer 1.x summary', async (t) => {
  const { createFleetPoller } = await import('../src/fleet-poller.js');
  const registryFile = path.join(root, 'newer-summary-registry.json');
  registry(registryFile, [{ ...factory('factory-b', 'https://example.invalid'), kind: 'container', containerName: 'hf-factory-b',
    hostname: 'factory-b.example.invalid', ports: { dashboard: 4477, ssh: 22 }, image: { builtAt: '2026-10-01T00:00:00Z', pinsHash: 'a'.repeat(64) } }]);
  const newer = { ...fixture, factoryId: 'factory-b', name: 'factory-b', dashboardUrl: 'https://example.invalid', contractVersion: '1.2.0',
    kind: 'container', workers: { running: 2, max: 8 }, harnesses: [{ harness: 'claude', login: 'expired', checkedAt: '2026-10-02T09:59:30Z' }],
    boss: { running: true, harness: 'claude' }, pending: [{ step: 'login-claude', since: '2026-10-02T09:00:00Z' }], backup: { lastAt: null },
    machine: { ...fixture.machine, diskFreePercent: 34, diskFreeMb: 51200, utcOffsetMinutes: 120 } };
  const poller = createFleetPoller({ dir: path.join(root, 'newer-summary-cache'), registryFile,
    localSummary: async () => ({ ...fixture, name: 'factory-zero', factoryId: 'factory-zero' }),
    credentials: () => ({ 'factory-b': 'hf_read_' + 'b'.repeat(64) }), now: () => Date.parse(fixture.generatedAt),
    fetchImpl: async () => new Response(JSON.stringify(newer), { headers: { 'content-type': 'application/json' } }) });
  t.after(() => poller.stop());
  await poller.poll();
  const row = poller.view().factories.find((item) => item.remote);
  assert.ok(row, JSON.stringify(poller.view()));
  assert.equal(row.kind, 'container');
  assert.equal(row.summary.contractVersion, '1.2.0');
  assert.deepEqual(row.summary.workers, { running: 2, max: 8 });
  assert.deepEqual(row.summary.pending, [{ step: 'login-claude', since: '2026-10-02T09:00:00Z' }]);
  assert.equal(row.summary.machine.utcOffsetMinutes, 120);
});

test('the poller classifies private failures and retains the last successful sighting across an outage', async (t) => {
  const { createFleetPoller } = await import('../src/fleet-poller.js');
  const registryFile = path.join(process.env.HERDR_FACTORIES_DIR, 'failure-codes.json');
  registry(registryFile, [factory('win1', 'http://192.0.2.1')]);
  let now = Date.parse(fixture.generatedAt), failure = null;
  const poller = createFleetPoller({ dir: path.join(root, 'failure-codes'), registryFile, now: () => now,
    localSummary: async () => ({ ...fixture, name: 'factory-zero', factoryId: 'factory-zero' }),
    credentials: () => ({ win1: 'hf_read_' + 'a'.repeat(64) }),
    fetchImpl: async () => {
      if (failure instanceof Error) throw failure;
      return failure || new Response(JSON.stringify({ ...fixture, name: 'win1', factoryId: 'win1', dashboardUrl: 'http://192.0.2.1' }), { headers: { 'content-type': 'application/json' } });
    } });
  t.after(() => poller.stop());
  await poller.poll();
  const good = poller.view().factories.find((row) => row.remote);
  assert.equal(good.lastSeenAt, new Date(now).toISOString());
  for (const [error, reason] of [[Object.assign(new Error('PRIVATE endpoint'), { code: 'EHOSTUNREACH' }), 'unreachable'],
    [Object.assign(new Error('PRIVATE timeout'), { name: 'TimeoutError' }), 'timeout'],
    [new Response('PRIVATE token', { status: 403 }), 'auth'],
    [new Response('{}', { headers: { 'content-type': 'application/json' } }), 'contract-mismatch']]) {
    failure = error; now += 30000; await poller.poll();
    const row = poller.view().factories.find((row) => row.remote);
    assert.equal(row.status, 'offline'); assert.equal(row.error, reason);
    assert.equal(row.lastSeenAt, good.lastSeenAt); assert.deepEqual(row.summary, good.summary);
    assert.doesNotMatch(JSON.stringify(row), /PRIVATE/);
  }
});

test('a refused poll cancels its unread body without storing private error content', async (t) => {
  const { createFleetPoller } = await import('../src/fleet-poller.js');
  const registryFile = path.join(process.env.HERDR_FACTORIES_DIR, 'cancel-error-body.json');
  registry(registryFile, [factory('win1', 'http://192.0.2.1')]);
  let cancelled = false;
  const poller = createFleetPoller({ dir: path.join(root, 'cancel-error-body'), registryFile,
    localSummary: async () => ({ ...fixture, name: 'factory-zero', factoryId: 'factory-zero' }),
    credentials: () => ({ win1: 'hf_read_' + 'a'.repeat(64) }), now: () => Date.parse(fixture.generatedAt),
    fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 403 }) });
  t.after(() => poller.stop());
  await poller.poll();
  assert.equal(cancelled, true);
  assert.equal(poller.view().factories.find((row) => row.remote).error, 'auth');
});

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

test('the registry rejects only bad factory rows and reports safe field diagnostics', async () => {
  const { factoryRecords, readFactoryRegistry } = await import('../src/fleet-poller.js');
  const registryFile = path.join(root, 'partial-registry.json');
  const container = { factoryId: 'win1', name: 'win1', hostId: 'example-host', kind: 'container', profile: 'personal',
    dashboardUrl: 'http://win1.localhost:4478', version: '0.1.0', kitRevision: 'abcdef012345', containerName: 'hf-win1',
    hostname: 'win1.localhost', ports: { dashboard: 4478, ssh: 2222 }, image: { builtAt: '2026-10-07T10:59:22.928Z', pinsHash: 'a'.repeat(64) } };
  const badVersion = { ...factory('bad-version', 'http://bad.localhost:4479'), version: 'invalid-value' };
  registry(registryFile, [container, badVersion, factory('factory-good', 'http://good.localhost:4478')]);
  const before = fs.readFileSync(registryFile, 'utf8');
  const result = readFactoryRegistry(registryFile);
  const records = factoryRecords(registryFile);
  assert.deepEqual(records.map((row) => row.name), ['factory-good']);
  assert.deepEqual(records.diagnostics, result.diagnostics);
  assert.deepEqual(result.factories.map((row) => row.name), ['factory-good']);
  assert.deepEqual(result.diagnostics, [
    'registry row win1: image.builtAt must be YYYY-MM-DDTHH:MM:SSZ',
    'registry row bad-version: version must be a version number',
  ]);
  assert.equal(fs.readFileSync(registryFile, 'utf8'), before, 'a read must not rewrite the registry');
});

test('hostile row keys never appear in poller diagnostics', async () => {
  const { createFleetPoller, factoryRecords, readFactoryRegistry } = await import('../src/fleet-poller.js');
  const registryFile = path.join(root, 'hostile-key-registry.json');
  const hostile = 'SECRET-KEY-xyz';
  const bad = { ...factory('win1', 'http://win1.localhost:4478'), [hostile]: 'private row value' };
  bad.kind = 'container';
  bad.containerName = 'hf-win1';
  bad.hostname = 'win1.localhost';
  bad.ports = { dashboard: 4478, ssh: 2222 };
  bad.image = { builtAt: '2026-10-07T10:59:22Z', pinsHash: 'a'.repeat(64), [hostile]: 'private nested value' };
  registry(registryFile, [bad]);
  const expected = [
    'registry row win1: <unknown field> is not allowed',
    'registry row win1: image.<unknown field> is not allowed',
  ];
  assert.deepEqual(readFactoryRegistry(registryFile).diagnostics, expected);
  assert.deepEqual(factoryRecords(registryFile).diagnostics, expected);
  const poller = createFleetPoller({ dir: path.join(root, 'hostile-key-cache'), registryFile,
    localSummary: async () => ({ ...fixture, factoryId: 'factory-zero', name: 'factory-zero' }) });
  try {
    assert.equal(poller.view().registryError, expected.join('; '));
    assert.doesNotMatch(poller.view().registryError, /SECRET-KEY-xyz|private row value|private nested value/);
  } finally { await poller.stop(); }
});

test('file-level registry errors still reject the whole file', async () => {
  const { factoryRecords, readFactoryRegistry } = await import('../src/fleet-poller.js');
  assert.deepEqual(factoryRecords(path.join(root, 'missing-registry.json')), []);
  const registryFile = path.join(root, 'invalid-registry.json');
  registry(registryFile, [factory('duplicate', 'http://one.localhost'), factory('duplicate', 'http://two.localhost')]);
  assert.throws(() => readFactoryRegistry(registryFile), /registry-invalid/);
  const body = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  body.factories = [];
  body.schema = 2;
  fs.writeFileSync(registryFile, JSON.stringify(body));
  assert.throws(() => readFactoryRegistry(registryFile), /registry-invalid/);
  body.schema = 1;
  body.contractVersion = '2.0.0';
  fs.writeFileSync(registryFile, JSON.stringify(body));
  assert.throws(() => readFactoryRegistry(registryFile), /registry-invalid/);
  body.contractVersion = '1.0.0';
  body.factories = {};
  fs.writeFileSync(registryFile, JSON.stringify(body));
  assert.throws(() => readFactoryRegistry(registryFile), /registry-invalid/);
  body.factories = [];
  fs.writeFileSync(registryFile, '{broken json');
  assert.throws(() => readFactoryRegistry(registryFile), /registry-invalid/);
});

test('the poller limits file-level errors to the registry envelope and duplicate names', async () => {
  const { factoryRecords, readFactoryRegistry } = await import('../src/fleet-poller.js');
  const registryFile = path.join(root, 'legacy-envelope-registry.json');
  const body = { schema: 1, contractVersion: '1.0.0', hosts: [], extraMetadata: 'ignored', factories: [] };
  registry(registryFile, []);
  fs.writeFileSync(registryFile, JSON.stringify(body));
  assert.deepEqual(readFactoryRegistry(registryFile).factories, []);
  assert.deepEqual(factoryRecords(registryFile), []);
  body.hosts = [{ hostId: 'INVALID HOST' }];
  fs.writeFileSync(registryFile, JSON.stringify(body));
  assert.deepEqual(readFactoryRegistry(registryFile).factories, []);
  delete body.extraMetadata;
  delete body.hosts;
  delete body.minimumFactoryVersion;
  fs.writeFileSync(registryFile, JSON.stringify(body));
  assert.deepEqual(readFactoryRegistry(registryFile).factories, []);
  assert.deepEqual(factoryRecords(registryFile), []);
});

test('the Fleet poller keeps good rows and shows each rejected row in its error line', async (t) => {
  const { createFleetPoller } = await import('../src/fleet-poller.js');
  const registryFile = path.join(root, 'partial-poller-registry.json');
  const bad = { factoryId: 'win1', name: 'win1', hostId: 'example-host', kind: 'container', profile: 'personal',
    dashboardUrl: 'http://win1.localhost:4478', version: '0.1.0', kitRevision: 'abcdef012345', containerName: 'hf-win1',
    hostname: 'win1.localhost', ports: { dashboard: 4478, ssh: 2222 }, image: { builtAt: '2026-10-07T10:59:22.928Z', pinsHash: 'a'.repeat(64) } };
  const badVersion = { ...factory('bad-version', 'http://bad.localhost:4479'), version: 'invalid-value' };
  registry(registryFile, [bad, badVersion, factory('factory-good', 'http://good.localhost:4478')]);
  const poller = createFleetPoller({ dir: path.join(root, 'partial-poller-cache'), registryFile,
    localSummary: async () => ({ ...fixture, factoryId: 'factory-zero', name: 'factory-zero', dashboardUrl: 'http://localhost:4477' }) });
  t.after(() => poller.stop());
  assert.equal(poller.view().registryError, 'registry row win1: image.builtAt must be YYYY-MM-DDTHH:MM:SSZ; registry row bad-version: version must be a version number');
  await poller.poll();
  assert.equal(poller.view().registryError, 'registry row win1: image.builtAt must be YYYY-MM-DDTHH:MM:SSZ; registry row bad-version: version must be a version number');
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

test('a local summary failure stays visible when head office is on and keeps the local identity reserved', async () => {
  const { createFleetPoller } = await import('../src/fleet-poller.js');
  const registryFile = path.join(process.env.HERDR_FACTORIES_DIR, 'local-fail-fleet.json');
  registry(registryFile, [factory('factory-b', 'http://192.0.2.1')]);
  let fail = false;
  const poller = createFleetPoller({ dir: path.join(root, 'local-fail-cache'), registryFile, enabled: () => true,
    localSummary: async () => { if (fail) throw new Error('down'); return { ...fixture, factoryId: 'factory-zero', name: 'factory-zero', dashboardUrl: 'http://localhost:4477' }; },
    credentials: () => ({ 'factory-b': 'hf_read_' + 'b'.repeat(64) }),
    fetchImpl: async () => new Response(JSON.stringify({ ...fixture, factoryId: 'factory-zero', name: 'factory-b', dashboardUrl: 'http://192.0.2.1' }), { headers: { 'content-type': 'application/json' } }), now: () => Date.parse(fixture.generatedAt) });
  fail = true;
  await poller.poll();
  assert.equal(poller.view().registryError, 'local-summary-unavailable');
  assert.equal(poller.view().factories.length, 1);
  fail = false; await poller.poll();
  assert.equal(poller.view().registryError, null);
  fail = true; await poller.poll();
  assert.equal(poller.view().registryError, 'local-summary-unavailable');
  const remote = poller.view().factories.find((row) => row.name === 'factory-b');
  assert.equal(remote.error, 'duplicate-factory-id');
  await poller.stop();
});

test('a throwing enabled check reports a settings error code and not a cache write failure', async () => {
  const { createFleetPoller } = await import('../src/fleet-poller.js');
  const registryFile = path.join(process.env.HERDR_FACTORIES_DIR, 'enabled-fleet.json'); registry(registryFile, []);
  const poller = createFleetPoller({ dir: path.join(root, 'enabled-cache'), registryFile, enabled: () => { throw new Error('bad settings'); },
    localSummary: async () => ({ ...fixture, factoryId: 'factory-zero', name: 'factory-zero', dashboardUrl: 'http://localhost:4477' }), now: () => Date.parse(fixture.generatedAt) });
  await poller.poll();
  assert.equal(poller.view().registryError, 'fleet-settings-invalid');
  await poller.stop();
});
