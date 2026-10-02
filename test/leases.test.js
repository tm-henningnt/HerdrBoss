import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateResourcePools } from '../src/config.js';
import { acquireLease, listLeases, ownerReleaseLease, processCwd, processLabel, readLeases, reclaimLeases, releaseLease, reownLeases, tcpListening } from '../src/leases.js';
import { writeNight } from '../src/night.js';
import { renderBulletin } from '../src/rules.js';
import { loadModels, loadProjectConfig } from '../src/kit/config.js';
import { collectWorker, startWorker } from '../src/kit/workers.js';
import { readyAgent } from './helpers/ready-agent.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
// Tests use high ports that no project serves. They never bind 8000 to 8004.
const POOL = { name: 'serve-ports', range: '47100-47104', split: { alpha: ['47100', '47101'], beta: ['47102'] }, env: 'HERDR_SERVE_PORT', ttlMinutes: 240, check: null, graceMinutes: 10 };
const NOW = Date.parse('2026-09-27T12:00:00Z');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tempDir(prefix) { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); }

test('process probes cache successes for five seconds and failures for one second', (t) => {
  const bin = tempDir('herdr-lease-probe-');
  const ps = path.join(bin, 'ps');
  const lsof = path.join(bin, 'lsof');
  const psCalls = path.join(bin, 'ps-calls');
  const lsofCalls = path.join(bin, 'lsof-calls');
  const pid = process.pid + 1000000;
  const secondPid = pid + 1;
  const failedPid = pid + 2;
  fs.writeFileSync(ps, `#!/bin/sh\nprintf "call\\n" >> "\${0%/*}/ps-calls"\nif [ "$4" = "${failedPid}" ]; then exit 1; fi\nprintf "fake-process\\n"\n`);
  fs.chmodSync(ps, 0o700);
  fs.writeFileSync(lsof, '#!/bin/sh\nprintf "call\\n" >> "${0%/*}/lsof-calls"\nprintf "n/tmp/fake-process-cwd\\n"\n');
  fs.chmodSync(lsof, 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(bin, { recursive: true, force: true });
  });

  let now = 1000;
  const clock = () => now;
  assert.equal(processLabel(pid, { now: clock }), 'fake-process');
  now += 4999;
  assert.equal(processLabel(pid, { now: clock }), 'fake-process');
  assert.equal(fs.readFileSync(psCalls, 'utf8').trim().split('\n').length, 1);
  assert.equal(processLabel(secondPid, { now: clock }), 'fake-process');
  assert.equal(fs.readFileSync(psCalls, 'utf8').trim().split('\n').length, 2, 'the cache key includes command arguments');

  now += 2;
  assert.equal(processLabel(pid, { now: clock }), 'fake-process');
  assert.equal(fs.readFileSync(psCalls, 'utf8').trim().split('\n').length, 3);
  assert.equal(processLabel(failedPid, { now: clock }), null);
  now += 999;
  assert.equal(processLabel(failedPid, { now: clock }), null);
  assert.equal(fs.readFileSync(psCalls, 'utf8').trim().split('\n').length, 4);
  now += 2;
  assert.equal(processLabel(failedPid, { now: clock }), null);
  assert.equal(fs.readFileSync(psCalls, 'utf8').trim().split('\n').length, 5);

  assert.equal(processCwd(pid, { hasLsof: true, now: clock }), path.resolve('/tmp/fake-process-cwd'));
  now += 4999;
  assert.equal(processCwd(pid, { hasLsof: true, now: clock }), path.resolve('/tmp/fake-process-cwd'));
  assert.equal(fs.readFileSync(lsofCalls, 'utf8').trim().split('\n').length, 1);
  now += 2;
  assert.equal(processCwd(pid, { hasLsof: true, now: clock }), path.resolve('/tmp/fake-process-cwd'));
  assert.equal(fs.readFileSync(lsofCalls, 'utf8').trim().split('\n').length, 2);
});

// Worker worktrees default to ~/Projects/.herdr-wt. Keep them out of the real home folder.
const TEST_HOME = tempDir('herdr-lease-home-');
process.env.HOME = TEST_HOME;
process.on('exit', () => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

function temporaryRepo(slug = 'alpha', extra = {}) {
  const root = tempDir('herdr-lease-');
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Test User');
  git(root, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(root, 'README.md'), 'seed\n');
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ slug, ...extra }));
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'seed');
  return root;
}

function pools(pool = POOL) {
  const result = validateResourcePools([pool]);
  assert.deepEqual(result.errors, []);
  return result.pools;
}

// A fake Herdr that knows an orch pane, a boss pane, and worker panes.
function fakeHerdr({ panes = ['ws:orch', 'wb:boss', 'ws:p2'] } = {}) {
  return (args) => {
    if (args[0] === 'pane' && args[1] === 'get') {
      if (args[2] === 'ws:orch') return { pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } };
      if (args[2] === 'wb:boss') return { pane: { pane_id: 'wb:boss', workspace_id: 'wb', label: 'boss' } };
      if (args[2] === 'wo:orch') return { pane: { pane_id: 'wo:orch', workspace_id: 'wo', label: 'orch' } };
      return { pane: { pane_id: args[2], workspace_id: 'ws', label: null } };
    }
    if (args[0] === 'pane' && args[1] === 'list') return { panes: panes.map((id) => ({ pane_id: id })) };
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
}

const ORCH = { HERDR_ENV: '1', HERDR_PANE_ID: 'ws:orch', HERDR_WORKSPACE_ID: 'ws' };
const BOSS = { HERDR_ENV: '1', HERDR_PANE_ID: 'wb:boss', HERDR_WORKSPACE_ID: 'wb' };
const OTHER_ORCH = { HERDR_ENV: '1', HERDR_PANE_ID: 'wo:orch', HERDR_WORKSPACE_ID: 'wo' };

function context({ slug = 'alpha', pool = POOL } = {}) {
  const root = temporaryRepo(slug);
  const dataDir = tempDir('herdr-lease-data-');
  return { root, dataDir, config: loadProjectConfig({ cwd: root }), pools: pools(pool) };
}

function acquire(ctx, env, options = {}) {
  const output = [];
  const lease = acquireLease('serve-ports', {
    pools: ctx.pools, dataDir: ctx.dataDir, config: ctx.config, env, herdr: fakeHerdr(), now: NOW, output: (line) => output.push(line), ...options,
  });
  return { lease, output };
}

async function holdMutationGuardUntilReleased(t, dataDir) {
  const guard = path.join(dataDir, 'locks', 'machine', '.mutation');
  fs.mkdirSync(guard, { recursive: true, mode: 0o700 });
  const script = `const fs = require('node:fs'); const guard = ${JSON.stringify(guard)}; process.stdout.write('ready\\n'); setTimeout(() => fs.rmdirSync(guard), 200);`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', resolve);
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
    fs.rmSync(guard, { recursive: true, force: true });
  });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  return { done };
}

test('pool validation accepts items, range, and split and names each error', () => {
  const ok = validateResourcePools([
    { name: 'serve-ports', range: '8000-8004', split: { alpha: ['8000', '8001'] }, env: 'HERDR_SERVE_PORT', ttlMinutes: 240, check: 'tcp', graceMinutes: 10 },
    { name: 'gpu', items: ['a', 'b'], env: 'HERDR_GPU' },
  ]);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.pools[0].items, ['8000', '8001', '8002', '8003', '8004']);
  assert.deepEqual(ok.pools[0].split, { alpha: ['8000', '8001'] });
  assert.equal(ok.pools[1].ttlMinutes, 240);
  assert.equal(ok.pools[1].check, null);
  assert.equal(ok.pools[1].graceMinutes, 10);
  assert.deepEqual(ok.pools[1].split, {});

  const cases = [
    [{ items: ['1'], env: 'X' }, /resourcePools\[0\]\.name must be a slug/],
    [{ name: 'Bad Name', items: ['1'], env: 'X' }, /name must be a slug/],
    [{ name: 'p', env: 'X' }, /exactly one of items or range/],
    [{ name: 'p', items: ['1'], range: '1-2', env: 'X' }, /exactly one of items or range/],
    [{ name: 'p', items: [], env: 'X' }, /items must be a non-empty array/],
    [{ name: 'p', items: [8000], env: 'X' }, /items\[0\] must be a string/],
    [{ name: 'p', items: ['a b'], env: 'X' }, /items\[0\] must be one token/],
    [{ name: 'p', items: ['a', 'a'], env: 'X' }, /items has a duplicate: a/],
    [{ name: 'p', range: '8004-8000', env: 'X' }, /range must be "LOW-HIGH"/],
    [{ name: 'p', range: '80x-8004', env: 'X' }, /range must be "LOW-HIGH"/],
    [{ name: 'p', items: ['a'], split: { alpha: ['b'] }, env: 'X' }, /split\.alpha item b is not in the pool/],
    [{ name: 'p', items: ['a'], split: { 'Bad Slug': ['a'] }, env: 'X' }, /split key Bad Slug must be a project slug/],
    [{ name: 'p', items: ['a', 'b'], split: { alpha: ['a'], beta: ['a'] }, env: 'X' }, /item a is in more than one split/],
    [{ name: 'p', items: ['a'] }, /env must be an environment variable name/],
    [{ name: 'p', items: ['a'], env: 'lower' }, /env must be an environment variable name/],
    [{ name: 'p', items: ['a'], env: 'X', ttlMinutes: 0 }, /ttlMinutes must be a positive integer/],
    [{ name: 'p', items: ['a'], env: 'X', graceMinutes: -1 }, /graceMinutes must be a non-negative integer/],
    [{ name: 'p', items: ['a'], env: 'X', check: 'http' }, /check must be "tcp" or null/],
    [{ name: 'p', items: ['a'], env: 'X', check: 'tcp' }, /check "tcp" needs port items; a is not a port/],
    [{ name: 'p', items: ['a'], env: 'X', token: 'secret' }, /unknown key token/],
  ];
  for (const [pool, message] of cases) {
    const result = validateResourcePools([pool]);
    assert.ok(result.errors.some((error) => message.test(error)), `${JSON.stringify(pool)}: ${result.errors.join('; ')}`);
  }
  assert.match(validateResourcePools([{ name: 'p', items: ['a'], env: 'X' }, { name: 'p', items: ['b'], env: 'Y' }]).errors.join('\n'), /resourcePools\[1\]\.name p is a duplicate/);
  assert.match(validateResourcePools({}).errors.join('\n'), /resourcePools must be an array/);
});

test('acquire takes the preferred item, then own split, then unsplit, then borrowed split items', () => {
  const ctx = context();
  const first = acquire(ctx, ORCH, { prefer: '47103' });
  assert.deepEqual(first.output, ['47103']);
  assert.equal(first.lease.item, '47103');
  assert.equal(first.lease.borrowed, false);
  // A preferred item that is taken falls back to the normal order.
  assert.equal(acquire(ctx, ORCH, { prefer: '47103' }).lease.item, '47100');
  assert.equal(acquire(ctx, ORCH).lease.item, '47101');
  assert.equal(acquire(ctx, ORCH).lease.item, '47104');
  const borrowed = acquire(ctx, ORCH);
  assert.equal(borrowed.lease.item, '47102');
  assert.equal(borrowed.lease.borrowed, true);
  assert.equal(borrowed.lease.project, 'alpha');
  assert.equal(borrowed.lease.pane, 'ws:orch');
  assert.equal(borrowed.lease.worker, null);
  assert.equal(borrowed.lease.expiresAt, new Date(NOW + 240 * 60000).toISOString());
  assert.throws(() => acquire(ctx, ORCH, { prefer: '9999' }), /Item 9999 is not in pool serve-ports/);
  const file = path.join(ctx.dataDir, 'leases.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readLeases(ctx.dataDir).leases.map((lease) => lease.item), ['47103', '47100', '47101', '47104', '47102']);
});

test('lease changes wait for the shared mutation guard', async (t) => {
  const ctx = context();
  const { done } = await holdMutationGuardUntilReleased(t, ctx.dataDir);

  const result = acquire(ctx, ORCH);

  await done;
  assert.equal(result.lease.item, '47100');
  assert.equal(readLeases(ctx.dataDir).leases.length, 1);
});

test('lease acquire and release recover a missing-owner mutation guard older than ten seconds', () => {
  const ctx = context();
  const directory = path.join(ctx.dataDir, 'locks', 'machine');
  const guard = path.join(directory, '.mutation');
  const seedOldGuard = () => {
    fs.mkdirSync(guard, { recursive: true, mode: 0o700 });
    const old = new Date(Date.now() - 11_000);
    fs.utimesSync(guard, old, old);
  };

  seedOldGuard();
  const { lease } = acquire(ctx, ORCH);
  assert.equal(lease.item, '47100');
  assert.equal(fs.existsSync(guard), false, 'acquire removes the stale guard');

  seedOldGuard();
  const released = releaseLease('serve-ports', lease.item, {
    pools: ctx.pools,
    dataDir: ctx.dataDir,
    config: ctx.config,
    env: ORCH,
    herdr: fakeHerdr(),
    now: NOW,
    output: () => {},
  });
  assert.equal(released.item, lease.item);
  assert.deepEqual(readLeases(ctx.dataDir).leases, []);
  assert.equal(fs.existsSync(guard), false, 'release removes the stale guard');
});

test('a preferred item of another project is borrowed, and --ttl sets the expiry', () => {
  const ctx = context();
  const { lease } = acquire(ctx, ORCH, { prefer: '47102', ttlMinutes: 30 });
  assert.equal(lease.item, '47102');
  assert.equal(lease.borrowed, true);
  assert.equal(lease.expiresAt, new Date(NOW + 30 * 60000).toISOString());
  assert.throws(() => acquire(ctx, ORCH, { ttlMinutes: 0 }), /--ttl must be a positive whole number of minutes/);
});

test('an empty pool fails with exit code 3 and lists the holders', () => {
  const ctx = context();
  for (let index = 0; index < 5; index += 1) acquire(ctx, ORCH);
  assert.throws(() => acquire(ctx, ORCH), (error) => error.exitCode === 3
    && /No free item in pool serve-ports/.test(error.message)
    && /47100: alpha/.test(error.message) && /47102: alpha \(borrowed\)/.test(error.message));
});

test('the caller must be a verified orch or boss pane or a live worker pane', () => {
  const ctx = context();
  assert.throws(() => acquire(ctx, { HERDR_ENV: '1', HERDR_PANE_ID: 'ws:p7', HERDR_WORKSPACE_ID: 'ws' }), /live worker run record/);
  fs.mkdirSync(ctx.config.runsPath, { recursive: true });
  fs.writeFileSync(path.join(ctx.config.runsPath, 'w1.json'), JSON.stringify({ name: 'w1', pane: 'ws:p2', worktree: ctx.root, startedAt: new Date(NOW).toISOString() }));
  const worker = acquire(ctx, { HERDR_ENV: '1', HERDR_PANE_ID: 'ws:p2', HERDR_WORKSPACE_ID: 'ws' }).lease;
  assert.equal(worker.worker, 'w1');
  assert.equal(worker.pane, 'ws:p2');
  assert.equal(worker.project, 'alpha');
  assert.throws(() => acquire(ctx, { HERDR_ENV: '1', HERDR_PANE_ID: 'ws:p2', HERDR_WORKSPACE_ID: 'ws' }, { forTarget: 'w1' }), /--for/);
  // A finished run record is not live.
  fs.writeFileSync(path.join(ctx.config.runsPath, 'w1.json'), JSON.stringify({ name: 'w1', pane: 'ws:p2', worktree: ctx.root, finishedAt: new Date(NOW).toISOString() }));
  assert.throws(() => acquire(ctx, { HERDR_ENV: '1', HERDR_PANE_ID: 'ws:p2', HERDR_WORKSPACE_ID: 'ws' }), /live worker run record/);
});

test('--for records a worker of the orchestrator project, and --for SLUG is only for the Boss', () => {
  const ctx = context();
  fs.mkdirSync(ctx.config.runsPath, { recursive: true });
  fs.writeFileSync(path.join(ctx.config.runsPath, 'w2.json'), JSON.stringify({ name: 'w2', pane: 'ws:p5', worktree: ctx.root }));
  const forWorker = acquire(ctx, ORCH, { forTarget: 'w2' }).lease;
  assert.equal(forWorker.worker, 'w2');
  assert.equal(forWorker.pane, 'ws:p5');
  assert.equal(forWorker.project, 'alpha');
  assert.throws(() => acquire(ctx, ORCH, { forTarget: 'beta' }), /No live worker run named beta in project alpha\. --for SLUG is allowed only for the Boss pane/);
  const forProject = acquire(ctx, BOSS, { forTarget: 'beta' }).lease;
  assert.equal(forProject.project, 'beta');
  assert.equal(forProject.item, '47102');
  assert.equal(forProject.borrowed, false);
  assert.equal(forProject.worker, null);
});

test('release is allowed for the own project and for the Boss', () => {
  const ctx = context();
  const { lease } = acquire(ctx, ORCH);
  const other = { ...ctx, config: loadProjectConfig({ cwd: temporaryRepo('beta') }) };
  const release = (c, env, item = lease.item) => releaseLease('serve-ports', item, { pools: c.pools, dataDir: c.dataDir, config: c.config, env, herdr: fakeHerdr(), now: NOW, output: () => {} });
  assert.throws(() => release(other, OTHER_ORCH), /held by project alpha/);
  assert.equal(readLeases(ctx.dataDir).leases.length, 1);
  release(ctx, ORCH);
  assert.equal(readLeases(ctx.dataDir).leases.length, 0);
  acquire(ctx, ORCH);
  release(other, BOSS);
  assert.equal(readLeases(ctx.dataDir).leases.length, 0);
  assert.throws(() => release(ctx, ORCH), /No lease of serve-ports item 47100/);
});

test('ownerReleaseLease removes a matching lease and refuses another project', () => {
  const ctx = context();
  acquire(ctx, ORCH);
  const item = readLeases(ctx.dataDir).leases[0].item;
  const conflict = (project) => {
    try { ownerReleaseLease('serve-ports', item, { expectedProject: project, dataDir: ctx.dataDir }); return null; }
    catch (error) { return error; }
  };
  const wrongProject = conflict('beta');
  assert.equal(wrongProject.statusCode, 409);
  assert.equal(wrongProject.message, 'The lease changed. Reload the page.');
  assert.equal(readLeases(ctx.dataDir).leases.length, 1, 'a mismatched project keeps the lease');
  const released = ownerReleaseLease('serve-ports', item, { expectedProject: 'alpha', dataDir: ctx.dataDir });
  assert.equal(released.item, item);
  assert.equal(released.project, 'alpha');
  assert.deepEqual(readLeases(ctx.dataDir).leases, []);
  const gone = conflict('alpha');
  assert.equal(gone.statusCode, 409);
  assert.equal(gone.message, 'The lease changed. Reload the page.');
});

test('list prints each pool item with its lease as JSON', () => {
  const ctx = context();
  acquire(ctx, ORCH);
  const output = [];
  const result = listLeases({ pools: ctx.pools, dataDir: ctx.dataDir, output: (line) => output.push(line) });
  assert.deepEqual(JSON.parse(output.join('\n')), result);
  assert.equal(result[0].pool, 'serve-ports');
  assert.equal(result[0].env, 'HERDR_SERVE_PORT');
  assert.equal(result[0].items[0].item, '47100');
  assert.equal(result[0].items[0].split, 'alpha');
  assert.equal(result[0].items[0].lease.project, 'alpha');
  assert.equal(result[0].items[3].lease, null);
  assert.throws(() => listLeases({ pools: ctx.pools, dataDir: ctx.dataDir, pool: 'nope', output: () => {} }), /Unknown resource pool nope/);
});

function seedLeases(dataDir, leases) {
  fs.writeFileSync(path.join(dataDir, 'leases.json'), JSON.stringify({ leases }), { mode: 0o600 });
}

const lease = (item, extra = {}) => ({ pool: 'serve-ports', item, project: 'alpha', worker: null, pane: 'ws:orch', at: new Date(NOW - 60000).toISOString(), expiresAt: new Date(NOW + 3600000).toISOString(), borrowed: false, ...extra });

test('reclaim removes leases of a gone pane, a finished run, and an expired lease, one event each', () => {
  const ctx = context();
  const runFile = path.join(ctx.dataDir, 'w3.json');
  fs.writeFileSync(runFile, JSON.stringify({ name: 'w3', pane: 'ws:p3', finishedAt: new Date(NOW).toISOString() }));
  seedLeases(ctx.dataDir, [
    lease('47100', { pane: 'ws:gone' }),
    lease('47101', { worker: 'w3', pane: 'ws:p3', runFile }),
    lease('47102', { expiresAt: new Date(NOW - 1).toISOString() }),
    lease('47103'),
  ]);
  const events = [];
  const result = reclaimLeases({ pools: ctx.pools, dataDir: ctx.dataDir, panes: new Set(['ws:orch', 'ws:p3']), now: NOW, log: (event) => events.push(event) });
  assert.deepEqual(events.map((event) => [event.pool, event.item, event.project, event.reason]), [
    ['serve-ports', '47100', 'alpha', 'pane ws:gone is gone'],
    ['serve-ports', '47101', 'alpha', 'worker w3 finished'],
    ['serve-ports', '47102', 'alpha', 'lease expired'],
  ]);
  assert.equal(result.reclaimed.length, 3);
  assert.deepEqual(readLeases(ctx.dataDir).leases.map((item) => item.item), ['47103']);
});

test('reownLeases moves the leases of one pane to its successor in the same project', () => {
  const ctx = context();
  seedLeases(ctx.dataDir, [
    lease('47100', { pane: 'ws:orch' }),
    lease('47101', { pane: 'ws:other' }),
    lease('47102', { pane: 'ws:orch', project: 'beta' }),
  ]);
  const changed = reownLeases({ fromPane: 'ws:orch', toPane: 'ws:new', project: 'alpha', dataDir: ctx.dataDir });
  assert.deepEqual(changed.map((item) => item.item), ['47100']);
  assert.deepEqual(readLeases(ctx.dataDir).leases.map((item) => [item.item, item.pane]), [
    ['47100', 'ws:new'], ['47101', 'ws:other'], ['47102', 'ws:orch'],
  ]);
});

test('quiet hours holds a TTL lease reclaim but still reclaims a gone pane', () => {
  const ctx = context();
  seedLeases(ctx.dataDir, [
    lease('47100', { pane: 'ws:gone' }),
    lease('47101', { expiresAt: new Date(NOW - 1).toISOString() }),
  ]);
  writeNight({ active: true, since: new Date(NOW - 60000).toISOString(), until: new Date(NOW + 3600000).toISOString(), quietHours: true }, { dataDir: ctx.dataDir });
  const events = [];
  const result = reclaimLeases({ pools: ctx.pools, dataDir: ctx.dataDir, panes: new Set(['ws:orch']), now: NOW, log: (event) => events.push(event) });
  assert.deepEqual(result.reclaimed.map((item) => [item.item, item.reason]), [['47100', 'pane ws:gone is gone']]);
  assert.deepEqual(events.map((event) => [event.item, event.reason, event.held]), [
    ['47100', 'pane ws:gone is gone', undefined],
    ['47101', undefined, 'lease TTL expiry'],
  ]);
  assert.deepEqual(readLeases(ctx.dataDir).leases.map((item) => item.item), ['47101']);
});

test('reclaim keeps pane leases when the pane list failed', () => {
  const ctx = context();
  seedLeases(ctx.dataDir, [lease('47100', { pane: 'ws:gone' })]);
  const events = [];
  reclaimLeases({ pools: ctx.pools, dataDir: ctx.dataDir, panes: null, now: NOW, log: (event) => events.push(event) });
  assert.deepEqual(events, []);
  assert.equal(readLeases(ctx.dataDir).leases.length, 1);
});

test('a live holder keeps its tcp lease when nothing listens, until the TTL', () => {
  const ctx = context({ pool: { ...POOL, check: 'tcp', graceMinutes: 10 } });
  const probeTcp = () => false;
  const tick = (now, panes = new Set(['ws:orch'])) => {
    const events = [];
    reclaimLeases({ pools: ctx.pools, dataDir: ctx.dataDir, panes, now, probeTcp, log: (event) => events.push(event) });
    return events;
  };
  // A worker leased the port long ago and does not serve yet. Its pane is alive, so the lease stays.
  seedLeases(ctx.dataDir, [lease('47100', { at: new Date(NOW - 3 * 3600000).toISOString(), expiresAt: new Date(NOW + 3600000).toISOString() })]);
  for (const step of [0, 60000, 120000, 600000]) assert.deepEqual(tick(NOW + step), [], 'no reclaim while the holder lives');
  assert.equal(readLeases(ctx.dataDir).leases.length, 1);
  // After the TTL, the lease goes back to the pool, and the event names the holder pane for the notice.
  const events = tick(NOW + 2 * 3600000);
  assert.deepEqual(events.map((event) => event.reason), ['lease expired']);
  assert.equal(events[0].pane, 'ws:orch');
  assert.equal(readLeases(ctx.dataDir).leases.length, 0);
});

test('a tcp lease of a gone pane is reclaimed at once, whatever listens', () => {
  const ctx = context({ pool: { ...POOL, check: 'tcp', graceMinutes: 10 } });
  seedLeases(ctx.dataDir, [lease('47101', { at: new Date(NOW - 60000).toISOString() })]);
  const events = [];
  reclaimLeases({ pools: ctx.pools, dataDir: ctx.dataDir, panes: new Set(['ws:other']), now: NOW, probeTcp: () => true, log: (event) => events.push(event) });
  assert.deepEqual(events.map((event) => event.reason), ['pane ws:orch is gone']);
});

test('acquire reclaims before it chooses', () => {
  const ctx = context();
  seedLeases(ctx.dataDir, ['47100', '47101', '47102', '47103', '47104'].map((item) => lease(item, item === '47101' ? { expiresAt: new Date(NOW - 1).toISOString() } : {})));
  assert.equal(acquire(ctx, ORCH).lease.item, '47101');
});

test('tcpListening sees a listening ephemeral port and a closed one', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try { assert.equal(tcpListening(String(port)), true); }
  finally { await new Promise((resolve) => server.close(resolve)); }
  assert.equal(tcpListening(String(port)), false);
});

test('the bulletin lists each pool with holders, ages, borrowed items, and free items', () => {
  const [pool] = pools();
  const snap = {
    updatedAt: new Date(NOW).toISOString(),
    resourceLeases: {
      pools: [pool],
      errors: [],
      leases: [
        lease('47100', { worker: 'w1', at: new Date(NOW - 12 * 60000).toISOString() }),
        lease('47102', { at: new Date(NOW - 2 * 3600000).toISOString(), borrowed: true }),
      ],
    },
  };
  const text = renderBulletin(snap, { alerts: [], advice: [] }, { host: '127.0.0.1', port: 4477 });
  const section = text.slice(text.indexOf('## Resource leases'));
  assert.ok(text.includes('## Resource leases'));
  assert.match(section, /^- serve-ports \(HERDR_SERVE_PORT\): 47100 alpha\/w1 12m; 47101 free; 47102 alpha 2h 0m borrowed; 47103 free; 47104 free$/m);
  assert.equal(text.match(/## Resource leases/g).length, 1);
  const invalid = renderBulletin({ updatedAt: snap.updatedAt, resourceLeases: { pools: [], leases: [], errors: ['resourcePools[0].env must be an environment variable name.'] } }, { alerts: [], advice: [] }, { host: '127.0.0.1', port: 4477 });
  assert.match(invalid, /## Resource leases\n\n- Resource pool config is invalid: resourcePools\[0\]\.env must be an environment variable name\./);
  const none = renderBulletin({ updatedAt: snap.updatedAt }, { alerts: [], advice: [] }, { host: '127.0.0.1', port: 4477 });
  assert.doesNotMatch(none, /## Resource leases/);
});

function startFixture() {
  const root = temporaryRepo('alpha');
  const config = loadProjectConfig({ cwd: root });
  const rulesFile = path.join(root, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({ updatedAt: new Date().toISOString(), avoidKinds: [] }));
  const dataDir = tempDir('herdr-lease-data-');
  const calls = [];
  const creates = [];
  let paneCwd = root;
  const herdr = (args) => {
    calls.push(args.slice(0, 2).join(' '));
    if (args[0] === 'pane' && args[1] === 'get') return args[2] === 'ws:orch'
      ? { pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } }
      : { pane: { pane_id: args[2], workspace_id: 'ws', foreground_cwd: paneCwd } };
    if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: { shell_pid: 10, foreground_process_group_id: 10 } };
    if (args[0] === 'pane' && args[1] === 'read') return { text: '% ' };
    if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
    if (args[0] === 'agent' && args[1] === 'get') return readyAgent();
    if (args[0] === 'tab' && args[1] === 'list') return { tabs: [{ tab_id: 'ws:t1', workspace_id: 'ws', label: 'Workers' }] };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [{ pane_id: 'ws:p1', workspace_id: 'ws', tab_id: 'ws:t1', width: 160, height: 45 }] };
    if (args[0] === 'pane' && args[1] === 'split') { creates.push(args); paneCwd = args[args.indexOf('--cwd') + 1]; return { pane: { pane_id: 'ws:p2' } }; }
    if (args[0] === 'pane' && args[1] === 'close') return {};
    if (args[0] === 'agent' && (args[1] === 'start' || args[1] === 'prompt')) return {};
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const leaseOptions = { dataDir, pools: pools() };
  const start = (name, options = {}, extra = {}) => startWorker(name, { kind: 'opencode', task: 'x', allow: ['src/'], lease: ['serve-ports'], ...options }, {
    config, models: loadModels(), herdr, env: ORCH, rulesFile, wait: () => {}, output: () => {}, leaseOptions, ...extra,
  });
  return { root, config, dataDir, calls, creates, start, leaseOptions, herdr };
}

const envValues = (args) => Object.fromEntries(args.flatMap((arg, index) => (args[index - 1] === '--env' ? [arg.split(/=(.*)/s).slice(0, 2)] : [])));

test('worker start --lease injects the item, records it, writes the brief line, and collect releases it', () => {
  const f = startFixture();
  const run = f.start('leased');
  assert.equal(envValues(f.creates.at(-1)).HERDR_SERVE_PORT, '47100');
  assert.deepEqual(run.leases, [{ pool: 'serve-ports', item: '47100', env: 'HERDR_SERVE_PORT' }]);
  const saved = JSON.parse(fs.readFileSync(run.recordFile, 'utf8'));
  assert.deepEqual(saved.leases, run.leases);
  const [stored] = readLeases(f.dataDir).leases;
  assert.equal(stored.worker, 'leased');
  assert.equal(stored.project, 'alpha');
  assert.equal(stored.pane, 'ws:p2');
  const brief = fs.readFileSync(path.join(run.worktree, '.worker', 'brief.md'), 'utf8');
  assert.match(brief, /Leased resources: `HERDR_SERVE_PORT=47100` \(pool `serve-ports`\)\. Use only these\./);

  fs.writeFileSync(path.join(run.worktree, '.worker', 'report.md'), 'Done.\n');
  fs.writeFileSync(path.join(run.worktree, '.worker', 'report.json'), JSON.stringify({
    issue: null, branch: run.branch, worktree: run.worktree, changedPaths: [], commands: ['check'], evidenceTier: ['unit'], unverified: [], stoppedEarly: false,
  }));
  const output = [];
  collectWorker('leased', { record: true, outcome: 'done', gatePassed: true }, {
    config: f.config, output: (line) => output.push(line), listWorktreeProcesses: () => [], recordUsageFn: () => ({ errors: [] }), leaseDataDir: f.dataDir,
  });
  assert.deepEqual(readLeases(f.dataDir).leases, []);
  assert.ok(output.includes('Released lease serve-ports 47100.'));
});

test('worker start with an empty pool fails before it creates a worktree or a pane', () => {
  const f = startFixture();
  seedLeases(f.dataDir, ['47100', '47101', '47102', '47103', '47104'].map((item) => lease(item, { project: 'beta', at: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() })));
  assert.throws(() => f.start('noport'), (error) => error.exitCode === 3 && /No free item in pool serve-ports/.test(error.message));
  assert.equal(fs.existsSync(f.config.worktreePath('noport')), false);
  assert.equal(fs.existsSync(path.join(f.config.runsPath, 'noport.json')), false);
  assert.equal(git(f.root, 'branch', '--list', 'noport'), '');
  assert.ok(!f.calls.some((call) => ['pane split', 'tab create', 'agent start'].includes(call)));
  assert.equal(readLeases(f.dataDir).leases.length, 5);
});

test('a failed worker start releases the leases it took', () => {
  const f = startFixture();
  assert.throws(() => f.start('bad-lease', { lease: ['nope'] }), /Unknown resource pool nope/);
  assert.throws(() => f.start('dup-lease', { lease: ['serve-ports', 'serve-ports'] }), /--lease serve-ports may be used only once/);
  assert.deepEqual(readLeases(f.dataDir).leases, []);
  assert.equal(fs.existsSync(f.config.worktreePath('bad-lease')), false);
});

test('the lease CLI prints JSON, exits 3 on an empty pool, and names config errors', () => {
  const root = temporaryRepo('alpha');
  const home = tempDir('herdr-lease-home-');
  const dataDir = tempDir('herdr-lease-data-');
  const bin = tempDir('herdr-lease-bin-');
  fs.writeFileSync(path.join(bin, 'herdr'), `#!${process.execPath}\nconst a = process.argv.slice(2);\nif (a[0] === 'pane' && a[1] === 'get') console.log(JSON.stringify({ result: { pane: { pane_id: a[2], workspace_id: 'ws', label: a[2] === 'ws:orch' ? 'orch' : null } } }));\nelse if (a[0] === 'pane' && a[1] === 'list') console.log(JSON.stringify({ result: { panes: [{ pane_id: 'ws:orch' }] } }));\nelse { console.error('unexpected'); process.exit(1); }\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ resourcePools: [POOL] }));
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, HERDR_BOSS_DIR: dataDir, ...ORCH };
  const run = (...args) => spawnSync(process.execPath, [CLI, 'lease', ...args], { cwd: root, env, encoding: 'utf8' });
  const first = run('acquire', 'serve-ports');
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, '47100\n');
  const list = run('list');
  assert.equal(list.status, 0, list.stderr);
  assert.equal(JSON.parse(list.stdout)[0].items[0].lease.item, '47100');
  for (let index = 0; index < 4; index += 1) assert.equal(run('acquire', 'serve-ports').status, 0);
  const empty = run('acquire', 'serve-ports');
  assert.equal(empty.status, 3);
  assert.equal(empty.stdout, '');
  assert.match(empty.stderr, /No free item in pool serve-ports/);
  const released = run('release', 'serve-ports', '47100');
  assert.equal(released.status, 0, released.stderr);
  assert.equal(readLeases(dataDir).leases.length, 4);
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ resourcePools: [{ ...POOL, env: 'lower' }] }));
  const bad = run('list');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /resourcePools\[0\]\.env must be an environment variable name/);
});

test('worker start exports the client id for the leased port and shows it nowhere else', () => {
  const value = `test-client-${randomBytes(8).toString('hex')}`;
  const other = `test-client-${randomBytes(8).toString('hex')}`;
  const f = startFixture();
  f.leaseOptions.pools = pools({ ...POOL, portEnv: { TM_SERVE_LIVE_CLIENT_ID: { '47100-47101': value, '47102-47104': other } } });
  const output = [];
  const run = f.start('with-id', {}, { output: (line) => output.push(line) });
  const env = envValues(f.creates.at(-1));
  assert.equal(env.HERDR_SERVE_PORT, '47100');
  assert.equal(env.TM_SERVE_LIVE_CLIENT_ID, value, 'the pane gets the value that matches its port');
  assert.ok(output.includes('Leased serve-ports 47100 as HERDR_SERVE_PORT.'));
  assert.ok(output.includes('TM_SERVE_LIVE_CLIENT_ID for port 47100: set'));
  const brief = fs.readFileSync(path.join(run.worktree, '.worker', 'brief.md'), 'utf8');
  const record = fs.readFileSync(run.recordFile, 'utf8');
  for (const [label, text] of [['output', output.join('\n')], ['brief', brief], ['run record', record], ['lease store', fs.readFileSync(path.join(f.dataDir, 'leases.json'), 'utf8')], ['returned run', JSON.stringify(run)]]) {
    assert.equal(text.includes(value) || text.includes(other), false, `${label} holds no client id`);
  }
  assert.ok(!fs.readFileSync(path.join(run.worktree, '.worker', 'port'), 'utf8').includes(value));
});

test('worker start exports no client id variable for a port without an entry', () => {
  const value = `test-client-${randomBytes(8).toString('hex')}`;
  const f = startFixture();
  f.leaseOptions.pools = pools({ ...POOL, portEnv: { TM_SERVE_LIVE_CLIENT_ID: { '47103-47104': value } } });
  const output = [];
  f.start('without-id', {}, { output: (line) => output.push(line) });
  assert.equal('TM_SERVE_LIVE_CLIENT_ID' in envValues(f.creates.at(-1)), false);
  assert.ok(output.includes('TM_SERVE_LIVE_CLIENT_ID for port 47100: not set'));
});

test('a failed worker start does not print the client id from the Herdr error', () => {
  const value = `test-client-${randomBytes(8).toString('hex')}`;
  const f = startFixture();
  f.leaseOptions.pools = pools({ ...POOL, portEnv: { TM_SERVE_LIVE_CLIENT_ID: { '47100-47104': value } } });
  const failing = (args) => {
    if (args[0] === 'agent' && args[1] === 'start') throw new Error(`Command failed: herdr agent start x --env TM_SERVE_LIVE_CLIENT_ID=${value}`);
    return f.herdr(args);
  };
  assert.throws(() => f.start('leaky', {}, { herdr: failing }), (error) => !error.message.includes(value) && /Command failed/.test(error.message));
});

test('lease acquire --env-file writes the port variables with owner-only mode and prints no value', () => {
  const value = `test-client-${randomBytes(8).toString('hex')}`;
  const ctx = context({ pool: { ...POOL, portEnv: { TM_SERVE_LIVE_CLIENT_ID: { '47100-47104': value } } } });
  const file = path.join(tempDir('herdr-lease-env-'), 'serve.env');
  const output = [];
  const notes = [];
  acquire(ctx, ORCH, { envFile: file, output: (line) => output.push(line), notify: (line) => notes.push(line) });
  assert.equal(output.join('\n').includes(value) || notes.join('\n').includes(value), false);
  assert.ok(notes.includes('TM_SERVE_LIVE_CLIENT_ID for port 47100: set'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^export HERDR_SERVE_PORT='47100'$/m);
  assert.match(text, new RegExp(`^export TM_SERVE_LIVE_CLIENT_ID='${value}'$`, 'm'));
});

test('project files hold no real client id', (t) => {
  const source = fileURLToPath(new URL('..', import.meta.url));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-lease-client-id-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test User',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test User',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const runGit = (...args) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  runGit('init', '-q', '-b', 'main');
  const files = execFileSync('git', ['-C', source, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const relative of files) {
    const from = path.join(source, relative);
    if (!fs.lstatSync(from).isFile()) continue;
    const to = path.join(repo, relative);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  runGit('add', '--all');
  runGit('commit', '-q', '-m', 'Project snapshot');
  assert.equal(runGit('rev-list', '--count', 'HEAD'), '1');
  const tracked = runGit('ls-files', '-z').split('\0').filter(Boolean);
  const needle = ['01a0f3', 'fb'].join('');
  for (const file of tracked) {
    const full = path.join(repo, file);
    assert.equal(fs.readFileSync(full, 'utf8').includes(needle), false, `${file} must not hold the client id`);
  }
});
