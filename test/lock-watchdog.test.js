import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { POLICY_DEFAULTS, validatePolicy } from '../src/control.js';
import { Engine } from '../src/engine.js';
import { inspectLockWatchdog } from '../src/lock-watchdog.js';
import { acquireProjectLock, clearLockWatchdogNotice, queueLockWatchdogNotice, readLockTakeoverNotices, releaseProjectLock } from '../src/kit/locks.js';
import { loadModels, loadProjectConfig } from '../src/kit/config.js';
import { loadConfig } from '../src/config.js';
import { temporaryRepo } from './helpers/kit-fixture.js';

const START = Date.parse('2026-10-08T08:00:00.000Z');
const MINUTE = 60_000;

function fixture(t) {
  const root = temporaryRepo('herdr-lock-watchdog-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  const locks = structuredClone(POLICY_DEFAULTS.locks);
  locks.guard.enabled = false;
  fs.writeFileSync(path.join(dataDir, 'policy.json'), JSON.stringify({ locks }));
  const config = loadProjectConfig({ cwd: root });
  let now = START;
  const herdr = (args) => {
    if (args[1] === 'get') return { pane: { pane_id: args[2], workspace_id: 'ws', label: 'orch' } };
    if (args[1] === 'list') return { panes: [{ pane_id: 'ws:holder' }] };
    if (args[1] === 'process-info') return { process_info: { shell_pid: 601 } };
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const options = (pane = 'ws:holder') => ({
    config, dataDir, herdr, now: () => now, pidAlive: () => true,
    processInfo: () => ({ alive: true, start: 'invented-start' }),
    env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: pane }, output: () => {},
  });
  const record = acquireProjectLock('full-suite', { ...options(), kind: 'suite' });
  const ledger = Array.from({ length: 5 }, (_, index) => ({
    event: 'release', name: 'full-suite', kind: 'suite', holdMs: 10 * MINUTE,
    at: new Date(START - (index + 1) * MINUTE).toISOString(),
  }));
  const processTable = (cpuTimeMs = 0, cpu = 0.2) => new Map([
    [record.pid, { pid: record.pid, ppid: 1, cpuTimeMs, start: record.pidStart, cpu, cmd: 'node --sample-argument' }],
    [701, { pid: 701, ppid: record.pid, cpuTimeMs, start: 'Mon Sep 28 10:00:00 2026', cpu, cmd: 'node /tmp/child.js --sample-argument' }],
  ]);
  return {
    dataDir, record, ledger, options, processTable,
    watchdog: ({ ageMinutes = 31, cpuTimeMs = 0, cpu = 0.2, cpuLimit = 1, ledger: lines = ledger, previousProcesses = processTable(), previousSampleAt = START + ageMinutes * MINUTE - 30_000, processReader = () => processTable(cpuTimeMs, cpu) } = {}) => inspectLockWatchdog({
      holders: [record],
      settings: { watchdogMultiplier: 3, watchdogCpuPercent: cpuLimit },
      clock: () => START + ageMinutes * MINUTE,
      ledgerReader: () => lines,
      processReader,
      previousProcesses,
      previousSampleAt,
    }),
    release: () => releaseProjectLock('full-suite', options()),
  };
}

test('lock watchdog policy defaults and bounds are available', () => {
  assert.equal(POLICY_DEFAULTS.locks.watchdogMultiplier, 3);
  assert.equal(POLICY_DEFAULTS.locks.watchdogCpuPercent, 1);

  const invalid = structuredClone(POLICY_DEFAULTS);
  invalid.locks.watchdogMultiplier = 0;
  assert.ok(validatePolicy(invalid, loadModels()).some((error) => error.includes('locks.watchdogMultiplier')));
});

test('a hung full-suite holder queues one notice with names and an action', (t) => {
  const f = fixture(t);
  const { candidates } = f.watchdog();
  assert.equal(candidates.length, 1);
  const candidate = candidates[0];
  assert.equal(candidate.predictedMs, 10 * MINUTE);
  assert.equal(candidate.ageMs, 31 * MINUTE);

  queueLockWatchdogNotice(candidate, { dataDir: f.dataDir, now: () => START + 31 * MINUTE });
  const notices = readLockTakeoverNotices({ dataDir: f.dataDir }).filter((notice) => notice.type === 'lock-watchdog');
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /full-suite.*suite.*project .* ws:holder.*PID/);
  assert.match(notices[0].text, /age 31m.*predicted hold 10m/);
  assert.match(notices[0].text, /node \(PID 701\)/);
  assert.match(notices[0].text, /Look at pane ws:holder.*herdr-boss lock release/);
  assert.doesNotMatch(notices[0].text, /--sample-argument|child\.js/);
});

test('a busy or young holder does not queue a watchdog notice', (t) => {
  const busy = fixture(t);
  assert.equal(busy.watchdog({ cpu: 40, cpuTimeMs: 6_000 }).candidates.length, 0);
  assert.equal(readLockTakeoverNotices({ dataDir: busy.dataDir }).filter((notice) => notice.type === 'lock-watchdog').length, 0);

  const young = fixture(t);
  assert.equal(young.watchdog({ ageMinutes: 29 }).candidates.length, 0);
  assert.equal(readLockTakeoverNotices({ dataDir: young.dataDir }).filter((notice) => notice.type === 'lock-watchdog').length, 0);
});

test('a first watchdog sample and process reader failure do not create a notice', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.watchdog({ previousProcesses: null }).candidates, []);
  assert.deepEqual(f.watchdog({ processReader: () => { throw new Error('ps failed'); } }).candidates, []);
  assert.equal(readLockTakeoverNotices({ dataDir: f.dataDir }).length, 0);
});

test('watchdog CPU uses the cputime delta instead of average pcpu', (t) => {
  const f = fixture(t);
  const { candidates } = f.watchdog({ cpu: 40, cpuTimeMs: 0 });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].cpuPercent, 0);
  const busy = f.watchdog({ cpu: 0.2, cpuTimeMs: 6_000, cpuLimit: 50 });
  assert.equal(busy.candidates[0].cpuPercent, 40);
});

test('a failed ledger read does not create a notice or throw', (t) => {
  const f = fixture(t);
  assert.doesNotThrow(() => {
    const result = inspectLockWatchdog({
      holders: [f.record], settings: { watchdogMultiplier: 3, watchdogCpuPercent: 1 },
      clock: () => START + 31 * MINUTE, ledgerReader: () => { throw new Error('ledger failed'); },
      processReader: () => f.processTable(), previousProcesses: f.processTable(),
      previousSampleAt: START + 31 * MINUTE - 30_000,
    });
    assert.deepEqual(result.candidates, []);
  });
  assert.equal(readLockTakeoverNotices({ dataDir: f.dataDir }).length, 0);
});

test('the engine watchdog reuses its ledger sample for 60 seconds', (t) => {
  const f = fixture(t);
  const cache = { at: null, lines: null };
  let ledgerReads = 0;
  const checkAt = (now) => inspectLockWatchdog({
    holders: [f.record], settings: { watchdogMultiplier: 3, watchdogCpuPercent: 1 },
    clock: () => now, ledgerReader: () => { ledgerReads += 1; return f.ledger; },
    processReader: () => f.processTable(), previousProcesses: f.processTable(),
    previousSampleAt: now - 30_000, ledgerCache: cache,
  });
  assert.equal(checkAt(START + 31 * MINUTE).candidates.length, 1);
  assert.equal(checkAt(START + 31 * MINUTE + 30_000).candidates.length, 1);
  assert.equal(ledgerReads, 1);
  assert.equal(checkAt(START + 31 * MINUTE + 60_001).candidates.length, 1);
  assert.equal(ledgerReads, 2);
});

test('the process start identity must match the lock record', (t) => {
  const f = fixture(t);
  const processes = f.processTable();
  processes.get(f.record.pid).start = 'Tue Sep 29 10:00:00 2026';
  const result = inspectLockWatchdog({
    holders: [f.record], settings: { watchdogMultiplier: 3, watchdogCpuPercent: 1 },
    clock: () => START + 31 * MINUTE, ledgerReader: () => f.ledger,
    processReader: () => processes, previousProcesses: processes,
    previousSampleAt: START + 31 * MINUTE - 30_000,
  });
  assert.deepEqual(result.candidates, []);
});

test('the engine skips its injected ledger reader when no holder is old', (t) => {
  const f = fixture(t);
  let ledgerReads = 0;
  const cfg = loadConfig();
  const engine = new Engine(cfg, {
    push: false, act: false, clock: () => START + MINUTE, lockDataDir: f.dataDir,
    lockLedgerReader: () => { ledgerReads += 1; return []; },
  });
  const processes = f.processTable();
  engine.lockWatchdogProcesses = { at: START, processes };
  const result = engine.inspectLockWatchdog({
    holders: [f.record], settings: { watchdogMultiplier: 3, watchdogCpuPercent: 1 },
    processReader: () => processes, now: START + MINUTE,
  });
  assert.deepEqual(result.candidates, []);
  assert.equal(ledgerReads, 0);
});

test('the prediction uses the same kind median and a 10-minute floor before five samples', (t) => {
  const f = fixture(t);
  const at = new Date(START - MINUTE).toISOString();
  const shortSuiteHolds = Array.from({ length: 4 }, () => ({ event: 'release', name: 'full-suite', kind: 'suite', holdMs: 2 * MINUTE, at }));
  const otherKindHolds = Array.from({ length: 6 }, () => ({ event: 'release', name: 'full-suite', kind: 'push', holdMs: 90 * MINUTE, at }));
  assert.equal(f.watchdog({ ledger: [...shortSuiteHolds, ...otherKindHolds] }).candidates[0].predictedMs, 10 * MINUTE);
  assert.equal(f.watchdog({ ledger: [...shortSuiteHolds, shortSuiteHolds[0], ...otherKindHolds] }).candidates[0].predictedMs, 2 * MINUTE);
});

test('the notice lists no more than 10 child process names and PIDs', (t) => {
  const f = fixture(t);
  const processes = f.processTable();
  for (let pid = 702; pid <= 715; pid += 1) processes.set(pid, {
    pid, ppid: f.record.pid, cpu: 0.01, cpuTimeMs: 0,
    start: `Mon Sep 28 10:00:${String(pid % 60).padStart(2, '0')} 2026`, cmd: `worker${pid} --private-arg`,
  });
  const { candidates } = inspectLockWatchdog({
    holders: [f.record], settings: { watchdogMultiplier: 3, watchdogCpuPercent: 1 },
    clock: () => START + 31 * MINUTE, ledgerReader: () => f.ledger,
    processReader: () => processes, previousProcesses: processes,
    previousSampleAt: START + 31 * MINUTE - 30_000,
  });
  queueLockWatchdogNotice(candidates[0], { dataDir: f.dataDir, now: () => START + 31 * MINUTE });
  const notice = readLockTakeoverNotices({ dataDir: f.dataDir }).find((item) => item.type === 'lock-watchdog');
  assert.equal(notice.text.match(/worker\d+ \(PID \d+\)/g).length, 9);
  assert.doesNotMatch(notice.text, /--private-arg/);
});

test('the same holder is deduplicated, and release clears its watchdog notice', (t) => {
  const f = fixture(t);
  const candidate = f.watchdog().candidates[0];
  queueLockWatchdogNotice(candidate, { dataDir: f.dataDir, now: () => START + 31 * MINUTE });
  queueLockWatchdogNotice(candidate, { dataDir: f.dataDir, now: () => START + 32 * MINUTE });
  assert.equal(readLockTakeoverNotices({ dataDir: f.dataDir }).filter((notice) => notice.type === 'lock-watchdog').length, 1);

  clearLockWatchdogNotice({ ...f.record, state: 'stale' }, { dataDir: f.dataDir });
  assert.equal(readLockTakeoverNotices({ dataDir: f.dataDir }).filter((notice) => notice.type === 'lock-watchdog').length, 0);
  queueLockWatchdogNotice(candidate, { dataDir: f.dataDir, now: () => START + 33 * MINUTE });
  f.release();
  assert.equal(readLockTakeoverNotices({ dataDir: f.dataDir }).filter((notice) => notice.type === 'lock-watchdog').length, 0);
});

test('watchdog notices reach the holder and Boss once, with partial delivery saved', async (t) => {
  const f = fixture(t);
  const candidate = f.watchdog().candidates[0];
  queueLockWatchdogNotice(candidate, { dataDir: f.dataDir, now: () => START + 31 * MINUTE });
  const calls = [];
  const engine = Object.create(Engine.prototype);
  engine.lockDataDir = f.dataDir;
  engine.push = true;
  engine.log = () => {};
  engine.promptService = async (pane, text) => calls.push({ pane, text });

  await engine.deliverLockTakeoverNotices({ panes: [{ id: 'ws:holder', agent: { name: 'worker' } }] });
  assert.deepEqual(calls.map((call) => call.pane), ['ws:holder']);
  assert.deepEqual(readLockTakeoverNotices({ dataDir: f.dataDir })[0].deliveredTo, ['project']);

  await engine.deliverLockTakeoverNotices({ panes: [
    { id: 'ws:holder', agent: { name: 'worker' } },
    { id: 'ws:boss', label: 'boss', agent: { name: 'boss' } },
  ] });
  assert.deepEqual(calls.map((call) => call.pane), ['ws:holder', 'ws:boss']);
  assert.deepEqual(readLockTakeoverNotices({ dataDir: f.dataDir }).filter((notice) => notice.type === 'lock-watchdog'), []);
  await engine.deliverLockTakeoverNotices({ panes: [
    { id: 'ws:holder', agent: { name: 'worker' } },
    { id: 'ws:boss', label: 'boss', agent: { name: 'boss' } },
  ] });
  assert.equal(calls.length, 2);
});
