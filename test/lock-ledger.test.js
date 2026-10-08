import './helpers/test-env.js';
import { pinProject } from '../src/git-pins.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { loadProjectConfig } from '../src/kit/config.js';
import { acquireProjectLock, releaseProjectLock, readLockLedger, lockLedgerStats, lockLedgerSummary, LOCK_LEDGER_FILE, LOCK_LEDGER_MAX_BYTES, LOCK_LEDGER_ROTATED_FILE } from '../src/kit/locks.js';
import { runSuite } from '../src/kit/suite.js';

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-lock-ledger-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const dataDir = path.join(base, 'data');
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore' });
  git(root, 'config', 'user.name', 'Test User');
  git(root, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(root, 'README.md'), 'seed\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-m', 'seed');
  const config = loadProjectConfig({ cwd: root });
  const herdr = (args) => {
    if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: args[2], workspace_id: 'ws', label: 'orch' } };
    if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: { shell_pid: 601 } };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [{ pane_id: 'ws:orch' }] };
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const env = { PATH: process.env.PATH, HOME: base, TMPDIR: base, HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch' };
  pinProject({ slug: config.slug, repo: root }, { env });
  let clock = Date.parse('2026-09-29T10:00:00Z');
  const options = { config, env, herdr, dataDir, output: () => {}, pidAlive: () => true, now: () => clock };
  return { root, dataDir, options, advance: (ms) => { clock += ms; }, tree: git(root, 'rev-parse', 'HEAD^{tree}') };
}

test('a manual lock writes one acquire line and one release line with the hold time', (t) => {
  const f = fixture(t);
  acquireProjectLock('deploy', f.options);
  f.advance(90_000);
  releaseProjectLock('deploy', f.options);
  const lines = fs.readFileSync(path.join(f.dataDir, LOCK_LEDGER_FILE), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].event, 'acquire');
  assert.equal(lines[0].name, 'deploy');
  assert.equal(lines[0].kind, 'manual');
  assert.equal(lines[0].project, f.options.config.slug);
  assert.equal(lines[0].waitMs, 0);
  assert.equal(lines[0].tree, f.tree);
  assert.equal(lines[1].event, 'release');
  assert.equal(lines[1].holdMs, 90_000);
  assert.equal(lines[1].tree, f.tree);
});

test('a suite run records suite lines, and a re-entrant suite under a push records reentrant lines', (t) => {
  const f = fixture(t);
  const suiteOptions = { ...f.options, stdio: 'ignore', cwd: f.root };
  runSuite([process.execPath, '-e', ''], suiteOptions);
  const token = 'push-reentry-token-0001';
  acquireProjectLock('full-suite', { ...f.options, kind: 'push', reentryToken: token, pidAlive: (pid) => pid === process.pid });
  f.advance(5_000);
  runSuite([process.execPath, '-e', ''], { ...suiteOptions, env: { ...f.options.env, HERDR_BOSS_LOCK_TOKEN: token }, pidAlive: (pid) => pid === process.pid });
  f.advance(1_000);
  releaseProjectLock('full-suite', { ...f.options, pidAlive: (pid) => pid === process.pid });
  const lines = readLockLedger({ dataDir: f.dataDir });
  assert.deepEqual(lines.map((line) => `${line.event}:${line.kind}${line.reentrant ? ':reentrant' : ''}`), [
    'acquire:suite', 'release:suite',
    'acquire:push', 'acquire:suite:reentrant', 'release:suite:reentrant', 'release:push',
  ]);
  assert.equal(lines[5].holdMs, 6_000);
  assert.equal(lines[4].holdMs, 0);
});

test('lock ledger stats give the median hold and the median wait, and skip reentrant lines', () => {
  const lines = [
    { event: 'acquire', name: 'full-suite', kind: 'suite', waitMs: 1000 },
    { event: 'acquire', name: 'full-suite', kind: 'push', waitMs: 5000 },
    { event: 'acquire', name: 'full-suite', kind: 'suite', waitMs: 3000 },
    { event: 'acquire', name: 'full-suite', kind: 'suite', waitMs: 0, reentrant: true },
    { event: 'release', name: 'full-suite', kind: 'suite', holdMs: 60_000 },
    { event: 'release', name: 'full-suite', kind: 'push', holdMs: 120_000 },
    { event: 'release', name: 'full-suite', kind: 'suite', holdMs: 0, reentrant: true },
  ];
  const stats = lockLedgerStats(lines);
  assert.equal(stats.acquires, 4);
  assert.equal(stats.medianWaitMs, 3000);
  assert.equal(stats.medianHoldMs, 90_000);
  assert.equal(stats.reentrantAcquires, 1);
  assert.equal(lockLedgerStats([]).medianHoldMs, null);
});

test('lock ledger stats and summaries report counts and median waits by lane', (t) => {
  const f = fixture(t);
  const at = new Date(f.options.now()).toISOString();
  const lines = [
    { at, event: 'acquire', name: 'full-suite', kind: 'suite', lane: 'long', waitMs: 1000 },
    { at, event: 'acquire', name: 'full-suite', kind: 'suite', lane: 'short', waitMs: 3000 },
    { at, event: 'acquire', name: 'full-suite', kind: 'push', lane: 'short', waitMs: 9000 },
    { at, event: 'timeout', name: 'full-suite', kind: 'suite', lane: 'short', waitMs: 10000 },
    { at, event: 'acquire', name: 'full-suite', kind: 'suite', waitMs: 7000 },
  ];
  fs.mkdirSync(f.dataDir, { recursive: true });
  fs.writeFileSync(path.join(f.dataDir, LOCK_LEDGER_FILE), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  const stats = lockLedgerStats(lines);
  assert.deepEqual(stats.byLane, {
    long: { acquires: 2, timeouts: 0, medianWaitMs: 4000 },
    short: { acquires: 2, timeouts: 1, medianWaitMs: 6000 },
  });
  const summary = lockLedgerSummary({ dataDir: f.dataDir, now: f.options.now });
  assert.deepEqual(summary.byName['full-suite'].byLane, stats.byLane);
});

test('a no-wait busy acquire writes a busy line and a timed-out wait writes a timeout line', (t) => {
  const f = fixture(t);
  acquireProjectLock('deploy', f.options);
  f.advance(2_000);
  assert.throws(() => acquireProjectLock('deploy', f.options), /held by active pane/);
  acquireProjectLock('full-suite', f.options);
  f.advance(1_000);
  assert.throws(() => acquireProjectLock('full-suite', { ...f.options, waitSeconds: 0, kind: 'suite' }), (error) => error.exitCode === 75);
  const lines = readLockLedger({ dataDir: f.dataDir });
  const busy = lines.find((line) => line.event === 'busy');
  const timeout = lines.find((line) => line.event === 'timeout');
  assert.equal(busy.name, 'deploy');
  assert.equal(busy.waitMs, 0);
  assert.equal(timeout.name, 'full-suite');
  assert.equal(timeout.kind, 'suite');
  assert.equal(timeout.waitMs, 0);
  const stats = lockLedgerStats(lines);
  assert.equal(stats.busy, 1);
  assert.equal(stats.timeouts, 1);
  assert.equal(stats.medianWaitMs, 0);
  assert.equal(lockLedgerStats([{ event: 'acquire', waitMs: 4000 }, { event: 'timeout', waitMs: 1800000 }, { event: 'busy', waitMs: 0 }]).medianWaitMs, 4000);
});

test('a stale takeover writes a takeover release line that the hold median skips', (t) => {
  const f = fixture(t);
  acquireProjectLock('deploy', f.options);
  f.advance(3_600_000);
  acquireProjectLock('deploy', { ...f.options, pidAlive: () => false });
  const lines = readLockLedger({ dataDir: f.dataDir });
  const takeover = lines.find((line) => line.event === 'release' && line.takeover);
  assert.equal(takeover.holdMs, 3_600_000);
  const stats = lockLedgerStats(lines);
  assert.equal(stats.takeovers, 1);
  assert.equal(stats.medianHoldMs, null);
});

test('the ledger rotates above 5 MB and the summary reads only the current file', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.dataDir, { recursive: true });
  const file = path.join(f.dataDir, LOCK_LEDGER_FILE);
  const rotated = path.join(f.dataDir, LOCK_LEDGER_ROTATED_FILE);
  fs.writeFileSync(rotated, 'old rotated file\n');
  const at = new Date(f.options.now()).toISOString();
  const big = JSON.stringify({ at, event: 'release', name: 'deploy', kind: 'manual', holdMs: 7000, pad: 'x'.repeat(1000) });
  fs.writeFileSync(file, `${`${big}\n`.repeat(Math.ceil(LOCK_LEDGER_MAX_BYTES / (big.length + 1)) + 1)}`);
  assert.ok(fs.statSync(file).size > LOCK_LEDGER_MAX_BYTES);
  acquireProjectLock('deploy', f.options);
  assert.ok(fs.statSync(rotated).size > LOCK_LEDGER_MAX_BYTES, 'the full file replaced the old rotated file');
  assert.ok(!fs.readFileSync(rotated, 'utf8').startsWith('old'));
  const current = readLockLedger({ dataDir: f.dataDir });
  assert.deepEqual(current.map((line) => line.event), ['acquire']);
  const summary = lockLedgerSummary({ dataDir: f.dataDir, now: f.options.now });
  assert.equal(summary.acquires, 1);
  assert.equal(summary.medianHoldMs, null);
});

test('an invalid clock or an unwritable ledger never throws', (t) => {
  const f = fixture(t);
  acquireProjectLock('deploy', f.options);
  assert.doesNotThrow(() => releaseProjectLock('deploy', { ...f.options, now: () => NaN }));
  assert.equal(fs.existsSync(path.join(f.dataDir, 'locks', 'machine', 'deploy.json')), false);
  // A folder in place of the ledger file makes each append fail.
  const g = fixture(t);
  fs.mkdirSync(path.join(g.dataDir, LOCK_LEDGER_FILE), { recursive: true });
  assert.doesNotThrow(() => acquireProjectLock('deploy', g.options));
  assert.doesNotThrow(() => releaseProjectLock('deploy', g.options));
  assert.ok(fs.statSync(path.join(g.dataDir, LOCK_LEDGER_FILE)).isDirectory());
});

test('the reader skips a partial JSONL line and a line of another shape', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.dataDir, { recursive: true });
  const good = { at: new Date(f.options.now()).toISOString(), event: 'release', name: 'deploy', kind: 'manual', holdMs: 5000 };
  fs.writeFileSync(path.join(f.dataDir, LOCK_LEDGER_FILE), `${JSON.stringify(good)}\n{"at":"2026-09-29T10:00:00.000Z","event":"acq\n[1]\n${JSON.stringify(good)}\n{"event":"acquire","name":"x","waitM`);
  const lines = readLockLedger({ dataDir: f.dataDir });
  assert.equal(lines.length, 2);
  assert.equal(lockLedgerStats(lines).medianHoldMs, 5000);
});

test('lock ledger stats count a reused push apart and skip it in the acquires and medians', () => {
  const lines = [
    { event: 'acquire', kind: 'push', reused: true, waitMs: 0 },
    { event: 'release', kind: 'push', reused: true, holdMs: 0 },
    { event: 'acquire', kind: 'suite', waitMs: 4000 },
    { event: 'release', kind: 'suite', holdMs: 60000 },
  ];
  const stats = lockLedgerStats(lines);
  assert.equal(stats.reusedPushes, 1);
  assert.equal(stats.acquires, 1);
  assert.equal(stats.medianWaitMs, 4000);
  assert.equal(stats.medianHoldMs, 60000);
});
