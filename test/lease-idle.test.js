import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { validateResourcePools } from '../src/config.js';
import { acquireLeaseFor, acquireLease, bindLease, listLeases, publicPool, readLeases, reclaimLeases, reclaimNoticeText, releaseLease, tcpListening, tcpListeningAsync, unleasedKey } from '../src/leases.js';

// Ports in these tests are high and never bound by a project. The real listener test binds an ephemeral port.
const POOL = { name: 'serve-ports', range: '47300-47304', env: 'HERDR_SERVE_PORT', ttlMinutes: 240, check: 'tcp' };
const NOW = Date.parse('2026-09-30T12:00:00Z');
const MINUTE = 60000;
const START_A = 'Wed Sep 30 10:00:00 2026';
const START_B = 'Wed Sep 30 11:30:00 2026';

const tempDir = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const poolsOf = (pool = POOL) => {
  const result = validateResourcePools([pool]);
  assert.deepEqual(result.errors, []);
  return result.pools;
};
const seed = (dataDir, leases, extra = {}) => fs.writeFileSync(path.join(dataDir, 'leases.json'), JSON.stringify({ leases, ...extra }), { mode: 0o600 });
const lease = (item, extra = {}) => ({ pool: 'serve-ports', item, project: 'worker-a-project', worker: 'worker-a', pane: 'ws:p2', at: new Date(NOW - MINUTE).toISOString(), expiresAt: new Date(NOW + 240 * MINUTE).toISOString(), borrowed: false, ...extra });
const table = (entries) => (pid) => entries[pid] ?? { alive: false, start: null };

function tick(ctx, now, { listening = [], processes = {}, panes = new Set(['ws:p2']) } = {}) {
  const events = [];
  reclaimLeases({
    pools: ctx.pools, dataDir: ctx.dataDir, now, panes, log: (event) => events.push(event),
    probeTcp: (port) => listening.includes(String(port)), pidInfo: table(processes),
  });
  return events;
}

const context = (pool = POOL) => ({ dataDir: tempDir('herdr-lease-idle-'), pools: poolsOf(pool) });

test('a bound lease whose pid is gone is released in one tick', () => {
  const ctx = context();
  seed(ctx.dataDir, [lease('47300', { pid: 4242, pidStart: START_A }), lease('47301', { pid: 4243, pidStart: START_A })]);
  const events = tick(ctx, NOW, { listening: ['47300', '47301'], processes: { 4243: { alive: true, start: START_A } } });
  assert.deepEqual(events.map((event) => [event.item, event.reason]), [['47300', 'server process 4242 is gone']]);
  assert.equal(events[0].pane, 'ws:p2');
  assert.deepEqual(readLeases(ctx.dataDir).leases.map((item) => item.item), ['47301']);
});

test('a pid that another process reuses is gone: the start time differs', () => {
  const ctx = context();
  seed(ctx.dataDir, [lease('47300', { pid: 4242, pidStart: START_A })]);
  const events = tick(ctx, NOW, { listening: ['47300'], processes: { 4242: { alive: true, start: START_B } } });
  assert.deepEqual(events.map((event) => event.reason), ['process 4242 started at a different time than the bound server']);
  assert.deepEqual(readLeases(ctx.dataDir).leases, []);
});

test('a pid without a known start time stays alive while the process lives', () => {
  const ctx = context();
  seed(ctx.dataDir, [lease('47300', { pid: 4242 })]);
  assert.deepEqual(tick(ctx, NOW, { listening: ['47300'], processes: { 4242: { alive: true, start: START_B } } }), []);
  assert.deepEqual(tick(ctx, NOW, { listening: ['47300'], processes: { 4242: { alive: true, start: null } } }), []);
});

test('an unbound lease with no listener is reclaimed after idleMinutes, and not before', () => {
  const ctx = context();
  seed(ctx.dataDir, [lease('47300', { pane: 'ws:p2' })]);
  assert.deepEqual(tick(ctx, NOW), [], 'the first tick starts the idle window');
  assert.ok(readLeases(ctx.dataDir).leases[0].idleSince, 'the lease records when the idle window began');
  assert.deepEqual(tick(ctx, NOW + 19 * MINUTE), []);
  const events = tick(ctx, NOW + 20 * MINUTE);
  assert.deepEqual(events.map((event) => [event.item, event.idleMinutes]), [['47300', 20]]);
  assert.match(events[0].reason, /no listener on port 47300 for 20 minutes/);
  assert.deepEqual(readLeases(ctx.dataDir).leases, []);
});

test('idleMinutes comes from the pool', () => {
  const ctx = context({ ...POOL, idleMinutes: 5 });
  seed(ctx.dataDir, [lease('47300')]);
  tick(ctx, NOW);
  assert.deepEqual(tick(ctx, NOW + 4 * MINUTE), []);
  assert.equal(tick(ctx, NOW + 5 * MINUTE).length, 1);
});

test('a listener keeps the lease, and a listener that goes away starts a new idle window', () => {
  const ctx = context();
  seed(ctx.dataDir, [lease('47300', { at: new Date(NOW - 3 * 60 * MINUTE).toISOString() })]);
  assert.deepEqual(tick(ctx, NOW, { listening: ['47300'] }), []);
  assert.deepEqual(tick(ctx, NOW + 60 * MINUTE, { listening: ['47300'] }), []);
  assert.equal(readLeases(ctx.dataDir).leases[0].idleSince, undefined);
  assert.deepEqual(tick(ctx, NOW + 61 * MINUTE), [], 'the listener left one minute ago');
  assert.deepEqual(tick(ctx, NOW + 80 * MINUTE), []);
  assert.equal(tick(ctx, NOW + 81 * MINUTE).length, 1);
});

test('a bound pid that lives without a listener is reclaimed too: a hung server', () => {
  const ctx = context();
  seed(ctx.dataDir, [lease('47300', { pid: 4242, pidStart: START_A })]);
  const processes = { 4242: { alive: true, start: START_A } };
  assert.deepEqual(tick(ctx, NOW, { processes }), []);
  assert.deepEqual(tick(ctx, NOW + 19 * MINUTE, { processes }), []);
  assert.equal(tick(ctx, NOW + 20 * MINUTE, { processes }).length, 1);
});

test('a real listener on a local port keeps the lease and a closed port does not', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  assert.equal(tcpListening(String(port)), true);
  const ctx = context({ ...POOL, range: `${port}-${port}` });
  seed(ctx.dataDir, [lease(String(port))]);
  const real = (now) => reclaimLeases({ pools: ctx.pools, dataDir: ctx.dataDir, now, panes: new Set(['ws:p2']), probeTcp: tcpListening, log: () => {} });
  try {
    real(NOW);
    real(NOW + 60 * MINUTE);
    assert.equal(readLeases(ctx.dataDir).leases.length, 1, 'the listener keeps the lease past idleMinutes');
  } finally { await new Promise((resolve) => server.close(resolve)); }
  real(NOW + 61 * MINUTE);
  assert.equal(readLeases(ctx.dataDir).leases.length, 1);
  assert.equal(real(NOW + 81 * MINUTE).reclaimed.length, 1);
  assert.equal(readLeases(ctx.dataDir).leases.length, 0);
});

test('the holder gets one notice text with the port and the idle time', () => {
  const ctx = context();
  seed(ctx.dataDir, [lease('47300')]);
  tick(ctx, NOW);
  const [event] = tick(ctx, NOW + 20 * MINUTE);
  assert.equal(reclaimNoticeText(event), 'Your lease of port 47300 in pool serve-ports was reclaimed after 20 minutes without a listener. Start serve-live again to take a port.');
  assert.deepEqual(tick(ctx, NOW + 21 * MINUTE), [], 'a later tick reports nothing for the same lease');
  assert.deepEqual(tick(ctx, NOW + 40 * MINUTE), []);
  const dead = { pool: 'serve-ports', item: '47301', reason: 'server process 4242 is gone' };
  assert.match(reclaimNoticeText(dead), /^Your lease serve-ports 47301 was reclaimed: server process 4242 is gone\./);
});

test('the five-lease scenario: four leases without a listener are reclaimed after the idle time', () => {
  const ctx = context();
  const items = ['47300', '47301', '47302', '47303', '47304'];
  seed(ctx.dataDir, items.map((item) => lease(item, { worker: `worker-${item}` })));
  const listening = ['47300'];
  const log = [];
  for (let minute = 0; minute <= 25; minute += 1) {
    const events = tick(ctx, NOW + minute * MINUTE, { listening });
    if (events.length) log.push([minute, events.map((event) => event.item)]);
  }
  assert.deepEqual(log, [[20, ['47301', '47302', '47303', '47304']]]);
  assert.deepEqual(readLeases(ctx.dataDir).leases.map((item) => item.item), ['47300']);
});

test('lease acquire hands out a port that nothing listens on before one that has a listener', () => {
  const holder = { project: 'worker-a-project', worker: 'worker-a', pane: null };
  const open = () => { const ctx = context(); seed(ctx.dataDir, []); return ctx; };
  const take = (ctx, extra = {}) => acquireLeaseFor('serve-ports', holder, { pools: ctx.pools, dataDir: ctx.dataDir, now: NOW, probeTcp: () => true, ...extra });
  const listening = new Set([unleasedKey('serve-ports', '47300')]);

  const plain = open();
  assert.equal(take(plain).item, '47300', 'without the list the first free item is given');

  const skipped = open();
  assert.equal(take(skipped, { unleased: listening }).item, '47301', 'an item with a listener is skipped');
  assert.equal(take(skipped, { unleased: listening, prefer: '47300' }).item, '47300', '--prefer wins over the list');

  const every = open();
  const all = new Set(['47300', '47301', '47302', '47303', '47304'].map((item) => unleasedKey('serve-ports', item)));
  assert.equal(take(every, { unleased: all }).item, '47300', 'a listener on every item still gives one out');

  const snapshot = open();
  fs.writeFileSync(path.join(snapshot.dataDir, 'state.json'), JSON.stringify({ resourceLeases: { unleased: [{ pool: 'serve-ports', item: '47300', pid: 4242, name: 'node', firstSeen: new Date(NOW).toISOString(), ageMinutes: 3, owner: 'worker-a-project' }] } }));
  assert.equal(take(snapshot).item, '47301', 'the last state snapshot steers the choice');

  const broken = open();
  fs.writeFileSync(path.join(broken.dataDir, 'state.json'), 'not json');
  assert.equal(take(broken).item, '47300', 'an unreadable snapshot changes nothing');
});

test('bindLease records the pid and its start time, and acquire --pid binds at once', () => {
  const ctx = context();
  seed(ctx.dataDir, [lease('47300')]);
  const bound = bindLease('serve-ports', '47300', 4242, { pools: ctx.pools, dataDir: ctx.dataDir, pidInfo: table({ 4242: { alive: true, start: START_A } }) });
  assert.equal(bound.pid, 4242);
  assert.equal(bound.pidStart, START_A);
  assert.equal(readLeases(ctx.dataDir).leases[0].pid, 4242);
  assert.throws(() => bindLease('serve-ports', '47300', 999999, { pools: ctx.pools, dataDir: ctx.dataDir, pidInfo: table({}) }), /Process 999999 is not running/);
  assert.throws(() => bindLease('serve-ports', '47301', 4242, { pools: ctx.pools, dataDir: ctx.dataDir, pidInfo: table({ 4242: { alive: true, start: START_A } }) }), /No lease of serve-ports item 47301/);
  const fresh = acquireLeaseFor('serve-ports', { project: 'worker-a-project', worker: null, pane: 'ws:p3' }, {
    pools: ctx.pools, dataDir: ctx.dataDir, now: NOW, pid: 4243, pidInfo: table({ 4243: { alive: true, start: START_B } }), probeTcp: () => true,
  });
  assert.equal(fresh.pid, 4243);
  assert.equal(fresh.pidStart, START_B);
  assert.throws(() => acquireLeaseFor('serve-ports', { project: 'worker-a-project', worker: null, pane: 'ws:p3' }, {
    pools: ctx.pools, dataDir: ctx.dataDir, now: NOW, pid: 1, pidInfo: table({}), probeTcp: () => true,
  }), /Process 1 is not running/);
});

test('lease list shows the pid, the listener, and the idle state without changing anything', () => {
  const ctx = context();
  seed(ctx.dataDir, [lease('47300', { pid: 4242, pidStart: START_A }), lease('47301')]);
  const before = fs.readFileSync(path.join(ctx.dataDir, 'leases.json'), 'utf8');
  const output = [];
  const result = listLeases({ pools: ctx.pools, dataDir: ctx.dataDir, now: NOW, probeTcp: (port) => port === '47300', pidInfo: table({ 4242: { alive: true, start: START_A } }), output: (line) => output.push(line) });
  assert.equal(fs.readFileSync(path.join(ctx.dataDir, 'leases.json'), 'utf8'), before);
  const [bound, unbound] = result[0].items;
  assert.deepEqual([bound.lease.bound, bound.lease.listener, bound.lease.pidAlive], [true, true, true]);
  assert.deepEqual([unbound.lease.bound, unbound.lease.listener], [false, false]);
  assert.equal(result[0].idleMinutes, 20);
  assert.deepEqual(JSON.parse(output.join('\n')), result);
});

// ----- wait for a free item -----

function fakeHerdr() {
  return (args) => {
    if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: args[2], workspace_id: 'ws', label: 'orch' } };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [{ pane_id: 'ws:orch' }] };
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
}

function waitContext() {
  const ctx = context();
  const config = { slug: 'worker-a-project', root: tempDir('herdr-lease-root-'), runsPath: tempDir('herdr-lease-runs-') };
  seed(ctx.dataDir, ['47300', '47301', '47302', '47303', '47304'].map((item) => lease(item, { project: 'other-project', pane: 'ws:orch', worker: null })));
  return { ...ctx, config };
}

const ORCH = { HERDR_ENV: '1', HERDR_PANE_ID: 'ws:orch', HERDR_WORKSPACE_ID: 'ws' };

function waitingAcquire(ctx, { waitSeconds, sleep, clock, notes = [], processes = { [process.pid]: { alive: true, start: null } } }) {
  return acquireLease('serve-ports', {
    pools: ctx.pools, dataDir: ctx.dataDir, config: ctx.config, env: ORCH, herdr: fakeHerdr(), now: NOW, waitSeconds, sleep, clock,
    probeTcp: () => true, pidInfo: table(processes), notify: (line) => notes.push(line), output: () => {},
  });
}

test('--wait prints the queue position, takes the next free item, and keeps FIFO order', () => {
  const ctx = waitContext();
  seed(ctx.dataDir, readLeases(ctx.dataDir).leases, { queue: [{ pool: 'serve-ports', id: 'ahead', pid: process.pid, project: 'first-project', at: new Date(NOW).toISOString() }] });
  let time = NOW;
  const notes = [];
  let step = 0;
  const sleep = (ms) => {
    time += ms;
    step += 1;
    const store = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'leases.json'), 'utf8'));
    if (step === 1) { store.leases = store.leases.filter((item) => item.item !== '47301'); }
    if (step === 2) { store.queue = store.queue.filter((entry) => entry.id !== 'ahead'); }
    fs.writeFileSync(path.join(ctx.dataDir, 'leases.json'), JSON.stringify(store));
  };
  const taken = waitingAcquire(ctx, { waitSeconds: 60, sleep, clock: () => time, notes });
  assert.equal(taken.item, '47301');
  assert.ok(step >= 2, 'the free item went to the waiter ahead in the queue first');
  assert.equal(notes[0], 'waiting for a free port in pool serve-ports, position 2');
  assert.ok(notes.every((line) => /^waiting for a free port in pool serve-ports, position \d+$/.test(line)));
  assert.deepEqual((readLeases(ctx.dataDir).queue ?? []), [], 'the waiter leaves the queue');
});

test('--wait fails with a clear message after the timeout and leaves the queue', () => {
  const ctx = waitContext();
  let time = NOW;
  assert.throws(
    () => waitingAcquire(ctx, { waitSeconds: 10, sleep: (ms) => { time += ms; }, clock: () => time }),
    (error) => error.exitCode === 3 && /No free item in pool serve-ports after waiting 10 seconds\./.test(error.message) && /Holders:/.test(error.message),
  );
  assert.deepEqual((readLeases(ctx.dataDir).queue ?? []), []);
});

test('a queue entry of a dead process does not block the queue', () => {
  const ctx = waitContext();
  seed(ctx.dataDir, readLeases(ctx.dataDir).leases.filter((item) => item.item !== '47300'), { queue: [{ pool: 'serve-ports', id: 'gone', pid: 999999, project: 'first-project', at: new Date(NOW).toISOString() }] });
  const taken = waitingAcquire(ctx, { waitSeconds: 5, sleep: () => {}, clock: () => NOW });
  assert.equal(taken.item, '47300');
});

test('an acquire without --wait does not take an item that a waiter is queued for', () => {
  const ctx = waitContext();
  seed(ctx.dataDir, readLeases(ctx.dataDir).leases.filter((item) => item.item !== '47300'), { queue: [{ pool: 'serve-ports', id: 'ahead', pid: process.pid, project: 'first-project', at: new Date(NOW).toISOString() }] });
  assert.throws(() => waitingAcquire(ctx, { waitSeconds: undefined }), (error) => error.exitCode === 3 && /waiting/.test(error.message));
});

// ----- pool setting and masking -----

test('publicPool masks the port values and keeps the flags', () => {
  const value = `test-client-${Math.random().toString(16).slice(2)}`;
  const [pool] = poolsOf({ ...POOL, portEnv: { TM_SERVE_LIVE_CLIENT_ID: { '47300-47301': value } } });
  const shown = publicPool(pool);
  assert.equal(JSON.stringify(shown).includes(value), false);
  assert.deepEqual(shown.portEnv, { TM_SERVE_LIVE_CLIENT_ID: { '47300-47301': 'set' } });
});

test('lease list names the client id variable as set or not set and never prints the value', () => {
  const value = `test-client-${Math.random().toString(16).slice(2)}`;
  const ctx = context({ ...POOL, portEnv: { TM_SERVE_LIVE_CLIENT_ID: { '47300-47301': value } } });
  seed(ctx.dataDir, [lease('47300')]);
  const output = [];
  listLeases({ pools: ctx.pools, dataDir: ctx.dataDir, now: NOW, probeTcp: () => true, pidInfo: table({}), output: (line) => output.push(line) });
  const text = output.join('\n');
  assert.equal(text.includes(value), false);
  const items = JSON.parse(text)[0].items;
  assert.deepEqual(items[0].portEnv, { TM_SERVE_LIVE_CLIENT_ID: 'set' });
  assert.deepEqual(items[2].portEnv, { TM_SERVE_LIVE_CLIENT_ID: 'not set' });
});

// ----- review fixes: unknown listener, live server, locked paths -----

test('a listener probe that times out or fails is unknown and never starts or keeps the idle clock', () => {
  const ctx = context();
  seed(ctx.dataDir, [lease('47300'), lease('47301', { idleSince: new Date(NOW - 30 * MINUTE).toISOString() })]);
  const events = [];
  reclaimLeases({ pools: ctx.pools, dataDir: ctx.dataDir, now: NOW, panes: new Set(['ws:p2']), probeTcp: () => null, pidInfo: table({}), log: (event) => events.push(event) });
  assert.deepEqual(events, [], 'unknown keeps the lease, also past the idle time');
  const [first, second] = readLeases(ctx.dataDir).leases;
  assert.equal(first.idleSince, undefined, 'unknown starts no idle clock');
  assert.equal(second.idleSince, new Date(NOW - 30 * MINUTE).toISOString(), 'unknown leaves the idle clock as it was');
});

test('the async probe returns false only for ECONNREFUSED and null for a timeout or another error', async (t) => {
  const answer = async (emit) => {
    const socket = new EventEmitter();
    socket.setTimeout = () => {};
    socket.destroy = () => {};
    t.mock.method(net, 'connect', () => { setImmediate(() => emit(socket)); return socket; });
    return tcpListeningAsync(47300);
  };
  const error = (code) => (socket) => socket.emit('error', Object.assign(new Error(code), { code }));
  assert.equal(await answer(error('ECONNREFUSED')), false);
  assert.equal(await answer(error('EPERM')), null);
  assert.equal(await answer(error('ENETUNREACH')), null);
  assert.equal(await answer((socket) => socket.emit('timeout')), null);
  assert.equal(await answer((socket) => socket.emit('connect')), true);
});

test('the sync probe returns false for a closed port and true for an open one', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  assert.equal(tcpListening(String(port)), true);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(tcpListening(String(port)), false);
});

const ALIVE = { 4242: { alive: true, start: START_A } };
const reasons = {
  'pane gone': { lease: {}, panes: new Set(['ws:other']) },
  'worker finished': { lease: { worker: 'worker-a', runFile: 'RUN' }, panes: new Set(['ws:p2']) },
  'TTL expiry': { lease: { expiresAt: new Date(NOW - 1).toISOString() }, panes: new Set(['ws:p2']) },
};

for (const [name, setup] of Object.entries(reasons)) {
  test(`a live bound pid with a listener keeps its lease after ${name}; without a listener the lease ends; a dead pid ends it at once`, () => {
    const run = (extra, options) => {
      const ctx = context();
      const runFile = path.join(ctx.dataDir, 'run.json');
      fs.writeFileSync(runFile, JSON.stringify({ name: 'worker-a', finishedAt: new Date(NOW).toISOString() }));
      const patch = { ...setup.lease, ...(setup.lease.runFile ? { runFile } : {}), pid: 4242, pidStart: START_A, ...extra };
      seed(ctx.dataDir, [lease('47300', patch)]);
      const events = [];
      reclaimLeases({ pools: ctx.pools, dataDir: ctx.dataDir, now: NOW, panes: setup.panes, pidInfo: table(options.processes), probeTcp: () => options.listening, log: (event) => events.push(event) });
      return events;
    };
    assert.deepEqual(run({}, { processes: ALIVE, listening: true }), [], 'live pid and listener: stays');
    assert.deepEqual(run({}, { processes: ALIVE, listening: null }), [], 'live pid and unknown listener: stays');
    assert.equal(run({}, { processes: ALIVE, listening: false }).length, 1, 'live pid, no listener: the reason applies');
    assert.match(run({}, { processes: {}, listening: true })[0].reason, /server process 4242 is gone/);
  });
}

test('acquire and release run no probe and no start-time lookup while they hold the lock', () => {
  const ctx = waitContext();
  const calls = [];
  const spy = (pid, options) => { calls.push(options?.wantStart); return { alive: true, start: START_A }; };
  seed(ctx.dataDir, ['47300', '47301'].map((item) => lease(item, { project: 'other-project', pane: 'ws:orch', worker: null, pid: 4242, pidStart: START_A, idleSince: new Date(NOW - 60 * MINUTE).toISOString() })));
  const lease2 = acquireLease('serve-ports', {
    pools: ctx.pools, dataDir: ctx.dataDir, config: ctx.config, env: ORCH, herdr: fakeHerdr(), now: NOW, pidInfo: spy, output: () => {},
  });
  assert.ok(['47302', '47303', '47304'].includes(lease2.item));
  assert.equal(readLeases(ctx.dataDir).leases.filter((item) => item.pid === 4242).length, 2, 'no probe ran, so the idle rule did not reclaim');
  assert.ok(calls.length > 0 && calls.every((value) => value === false), 'reclaim under the lock never asks for a start time');
  releaseLease('serve-ports', lease2.item, { pools: ctx.pools, dataDir: ctx.dataDir, config: ctx.config, env: ORCH, herdr: fakeHerdr(), now: NOW, pidInfo: spy, output: () => {} });
  assert.equal(readLeases(ctx.dataDir).leases.filter((item) => item.pid === 4242).length, 2);
  assert.ok(calls.every((value) => value === false));
});
