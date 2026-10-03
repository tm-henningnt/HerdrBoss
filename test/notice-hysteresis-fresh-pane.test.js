import './helpers/test-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { POLICY_DEFAULTS, loadPolicy, validatePolicy } from '../src/control.js';
import { loadModels } from '../src/kit/config.js';
import { evaluate } from '../src/rules.js';
import { unsentKitChanges } from '../src/kit-notice.js';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const NOW = Date.parse('2026-10-03T09:00:00Z');
const MIN = 60000;
const HOUR = 60 * MIN;
const GB = 2 ** 30;
const models = loadModels();

// ----- Disk hysteresis -----

const cfg = { quota: { warnPercent: 90, criticalPercent: 98 }, machine: { memFreeWarnPercent: 15, loadWarnFactor: 2 }, providerKinds: {} };
const diskAlerts = (freeGB, state) => {
  const snap = {
    projects: [], herdr: { workspaces: [{ id: 'w1', label: 'A' }], panes: [] }, quotas: [],
    machine: { cpus: 4, load: [0, 0, 0], memFreePercent: 50, diskFreeBytes: freeGB * GB, diskFreePercent: 10 },
    worktreeCounts: { w1: { linked: 2, prunable: 0 } },
  };
  const policy = structuredClone(POLICY_DEFAULTS);
  policy.machine.guardEnabled = false;
  return evaluate(snap, cfg, {}, NOW, policy, state).alerts.filter((alert) => alert.key.startsWith('machine:disk:'));
};

test('the disk defaults are 20 GB to raise and 24 GB to clear', () => {
  assert.equal(POLICY_DEFAULTS.machine.diskWarnFreeGB, 20);
  assert.equal(POLICY_DEFAULTS.machine.diskClearFreeGB, 24);
});

test('a disk warning raises at 20 GB free and clears only at 24 GB free', () => {
  const state = {};
  assert.equal(diskAlerts(30, state).length, 0, 'above the clear value there is no warning');
  assert.equal(diskAlerts(22, state).length, 0, 'between the values a clear state stays clear');
  assert.equal(diskAlerts(20, state).length, 1, 'the warning raises at exactly 20 GB free');
  assert.equal(diskAlerts(19.5, state).length, 1);
  assert.equal(diskAlerts(20.5, state).length, 1, 'the warning stays above the raise value');
  assert.equal(diskAlerts(23.9, state).length, 1, 'the warning stays below the clear value');
  assert.equal(diskAlerts(24, state).length, 0, 'the warning clears at exactly 24 GB free');
  assert.equal(diskAlerts(21, state).length, 0, 'a cleared warning stays clear between the values');
  assert.equal(diskAlerts(19.9, state).length, 1, 'the warning raises again');
});

test('a flapping disk reading near 20 GB gives one warning key throughout', () => {
  const state = {};
  const readings = [19.5, 20.4, 19.6, 20.2, 19.8, 21, 19.9];
  const keys = readings.map((gb) => diskAlerts(gb, state).map((alert) => alert.key).join());
  assert.deepEqual(new Set(keys), new Set(['machine:disk:w1:warn']));
});

test('a critical disk keeps the warning active after it recovers to warning level', () => {
  const state = {};
  assert.equal(diskAlerts(4, state)[0].severity, 'critical');
  assert.equal(diskAlerts(22, state)[0].severity, 'warn');
  assert.equal(diskAlerts(25, state).length, 0);
});

test('the policy validates the clear value against the raise value', () => {
  const policy = structuredClone(POLICY_DEFAULTS);
  assert.deepEqual(validatePolicy(policy, models), []);
  policy.machine.diskClearFreeGB = 10;
  assert.ok(validatePolicy(policy, models).some((error) => /diskClearFreeGB/.test(error)));
  policy.machine.diskClearFreeGB = 'x';
  assert.ok(validatePolicy(policy, models).some((error) => /diskClearFreeGB/.test(error)));
});

test('the dashboard lists the clear value in Settings and in the setting help', () => {
  const help = fs.readFileSync(path.join(repo, 'public/setting-help.js'), 'utf8');
  const app = fs.readFileSync(path.join(repo, 'public/app.js'), 'utf8');
  assert.match(help, /'machine\.diskClearFreeGB'/);
  assert.match(app, /machineNumber\('diskClearFreeGB'/);
});

// ----- Kit notice for a fresh pane -----

test('a pane that started after a kit change does not receive that change', () => {
  const state = { pending: [{ hash: 'aaa1111', subject: 'old change', at: NOW - 3 * HOUR }, { hash: 'bbb2222', subject: 'new change', at: NOW }] };
  assert.deepEqual(unsentKitChanges(state, []).map((change) => change.hash), ['aaa1111', 'bbb2222'], 'no start time: every change is unsent');
  assert.deepEqual(unsentKitChanges(state, [], NOW - 4 * HOUR).map((change) => change.hash), ['aaa1111', 'bbb2222'], 'an old pane gets both');
  assert.deepEqual(unsentKitChanges(state, [], NOW - HOUR).map((change) => change.hash), ['bbb2222'], 'a pane that started between the changes gets the later one');
  assert.deepEqual(unsentKitChanges(state, [], NOW + MIN), [], 'a fresh pane gets none');
});

// ----- Delivery probe -----

// Runs Engine.deliver in a child process with a temporary data directory. Each round is { at, panes, alerts, memory }.
const deliverProbe = `
import { Engine } from './src/engine.js';
import { loadConfig } from './src/config.js';
const input = JSON.parse(process.env.NOISE_SCENARIO);
const prompts = [];
const cfg = loadConfig();
cfg.push = false;
const engine = new Engine(cfg, {
  push: false, act: false,
  herdrRunner: async (cmd, args) => { prompts.push({ round: current, pane: args[2], text: args[3] }); return ''; },
});
engine.push = true;
engine.log = () => {};
let current = 0;
for (const [i, round] of input.rounds.entries()) {
  current = i;
  Object.assign(engine.memory, round.memory || {});
  await engine.deliver(round.alerts, { panes: round.panes }, round.at);
}
console.log(JSON.stringify({ prompts }));
`;

function deliverRounds(t, rounds) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-notice-noise-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(dir, 'data', 'projects'), { recursive: true });
  fs.writeFileSync(path.join(bin, 'herdr'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', deliverProbe], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env, HOME: dir, HERDR_BOSS_DIR: path.join(dir, 'data'), NODE_TEST_CONTEXT: '1',
      PATH: `${bin}${path.delimiter}${process.env.PATH}`, NOISE_SCENARIO: JSON.stringify({ rounds }),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim()).prompts;
}

const orch = (id, workspace, status = 'idle') => ({ id, workspace, orch: true, label: 'orch', agent: 'claude', status });
const worker = (workspace, id = `${workspace}:p9`) => ({ id, workspace, label: 'worker', agent: 'claude', status: 'working' });
const byRound = (prompts, round) => prompts.filter((p) => p.round === round);
const lines = (prompt) => prompt.text.split('\n').filter((line) => line.startsWith('- '));

test('a fresh pane gets no kit notice and an old pane gets it', (t) => {
  const kitAlert = { key: 'kit:abc1234', severity: 'info', scope: 'all', once: true, title: 'Kit updated', text: 'kit text' };
  const kitNotice = { commit: 'abc1234', at: NOW, revision: 'r1', pending: [{ hash: 'h1', subject: 'Change one', at: NOW }], alert: kitAlert };
  const panes = [orch('w1:p1', 'w1'), orch('w2:p1', 'w2'), worker('w1'), worker('w2')];
  const paneSince = { 'w1:p1': { status: 'idle', since: NOW - HOUR, first: NOW - 5 * HOUR }, 'w2:p1': { status: 'idle', since: NOW + MIN, first: NOW + MIN } };
  const prompts = deliverRounds(t, [{ at: NOW + 2 * MIN, panes, alerts: [kitAlert], memory: { kitNotice, paneSince } }]);
  assert.deepEqual(prompts.map((p) => p.pane), ['w1:p1'], 'only the old pane is prompted');
  assert.match(prompts[0].text, /Change one/);
});

// ----- Board digest -----

const board = (workspace = 'w1', slug = 'p1') => ({
  key: `board:diverge:${slug}`, severity: 'warn', scope: workspace, repeatMs: HOUR, noDesktop: true, project: slug,
  title: 'Board differs from git', text: `${slug}: 2 cards differ from git: A1, A2. Publish the status with --sync.`,
});
const swap = { key: 'machine:swap', severity: 'warn', scope: 'all', title: 'Swap high', text: 'Swap is 62% used (4.0 GB).' };

test('the board digest joins the info digest as one line for the project', (t) => {
  const panes = [orch('w1:p1', 'w1'), worker('w1')];
  const prompts = deliverRounds(t, [
    { at: NOW, panes, alerts: [swap, board()] },
    { at: NOW + HOUR + 5 * MIN, panes, alerts: [swap, board()] },
    { at: NOW + 2 * HOUR + 10 * MIN, panes, alerts: [swap, board()] },
  ]);
  const first = byRound(prompts, 0);
  assert.equal(first.length, 1, 'one prompt carries the swap notice and the board line');
  assert.equal(lines(first[0]).filter((line) => /differ from git/.test(line)).length, 1);
  assert.equal(byRound(prompts, 1).length, 0, 'the info interval holds a second digest inside two hours');
});

test('no board digest while the orchestrator waits for a worker report with no turn since the last digest', (t) => {
  const panes = [orch('w1:p1', 'w1'), worker('w1')];
  const idleSince = (since) => ({ paneSince: { 'w1:p1': { status: 'idle', since, first: NOW - 9 * HOUR } } });
  const prompts = deliverRounds(t, [
    { at: NOW, panes, alerts: [board()], memory: idleSince(NOW - 30 * MIN) },
    { at: NOW + 3 * HOUR, panes, alerts: [board()], memory: idleSince(NOW - 30 * MIN) },
    { at: NOW + 6 * HOUR, panes, alerts: [board()], memory: idleSince(NOW + 5 * HOUR) },
  ]);
  assert.equal(byRound(prompts, 0).length, 1, 'the first digest goes out');
  assert.equal(byRound(prompts, 1).length, 0, 'no turn since the digest and a worker runs: no digest');
  assert.equal(byRound(prompts, 2).length, 1, 'a turn after the last digest allows the next digest');
});

test('the board digest goes out without a turn when no worker runs', (t) => {
  const panes = [orch('w1:p1', 'w1')];
  const memory = { paneSince: { 'w1:p1': { status: 'idle', since: NOW - 30 * MIN, first: NOW - 9 * HOUR } } };
  const prompts = deliverRounds(t, [
    { at: NOW, panes, alerts: [board()], memory },
    { at: NOW + 3 * HOUR, panes, alerts: [board()], memory },
  ]);
  assert.equal(byRound(prompts, 1).length, 1, 'no worker waits, so the digest repeats');
});

// ----- Fix round -----

test('a stored warning value above 24 loads with a clear value that keeps the policy valid', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-policy-clear-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'policy.json');
  fs.writeFileSync(file, JSON.stringify({ machine: { diskWarnFreeGB: 30 } }));
  const loaded = loadPolicy({ file, models });
  assert.equal(loaded.machine.diskClearFreeGB, 30);
  assert.deepEqual(validatePolicy(loaded, models), []);
  fs.writeFileSync(file, JSON.stringify({ machine: { diskWarnFreeGB: 10 } }));
  assert.equal(loadPolicy({ file, models }).machine.diskClearFreeGB, 24);
  fs.writeFileSync(file, JSON.stringify({ machine: { diskWarnFreeGB: 30, diskClearFreeGB: 40 } }));
  assert.equal(loadPolicy({ file, models }).machine.diskClearFreeGB, 40);
});

test('a changed divergence reaches an orchestrator that waits for a worker with no turn', (t) => {
  const panes = [orch('w1:p1', 'w1'), worker('w1')];
  const memory = { paneSince: { 'w1:p1': { status: 'idle', since: NOW - 30 * MIN, first: NOW - 9 * HOUR } } };
  const changed = { ...board(), text: 'p1: 5 cards differ from git: A1, A2, A3, A4, A5. Publish the status with --sync.' };
  const prompts = deliverRounds(t, [
    { at: NOW, panes, alerts: [board()], memory },
    { at: NOW + 3 * HOUR, panes, alerts: [board()], memory },
    { at: NOW + 6 * HOUR, panes, alerts: [changed], memory },
  ]);
  assert.equal(byRound(prompts, 1).length, 0, 'the same text is skipped');
  const third = byRound(prompts, 2);
  assert.equal(third.length, 1, 'the changed text is sent');
  assert.match(third[0].text, /5 cards differ/);
});

const trackProbe = `
import { Engine } from './src/engine.js';
import { loadConfig } from './src/config.js';
const cfg = loadConfig(); cfg.push = false;
const engine = new Engine(cfg, { push: false, act: false });
const input = JSON.parse(process.env.TRACK_SCENARIO);
const out = [];
for (const step of input) { engine.trackPaneStatus({ panes: step.panes }, step.at); out.push(engine.memory.paneSince['w1:p1']?.first ?? null); }
console.log(JSON.stringify(out));
`;

test('a pane absent from one pane list keeps its first-seen time for 10 minutes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-pane-grace-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'data', 'projects'), { recursive: true });
  const pane = [{ id: 'w1:p1', workspace: 'w1', agent: 'claude', status: 'idle' }];
  const steps = [
    { at: NOW, panes: pane }, { at: NOW + MIN, panes: [] }, { at: NOW + 5 * MIN, panes: pane },
    { at: NOW + 6 * MIN, panes: [] }, { at: NOW + 20 * MIN, panes: [] }, { at: NOW + 21 * MIN, panes: pane },
  ];
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', trackProbe], {
    cwd: repo, encoding: 'utf8',
    env: { ...process.env, HOME: dir, HERDR_BOSS_DIR: path.join(dir, 'data'), NODE_TEST_CONTEXT: '1', TRACK_SCENARIO: JSON.stringify(steps) },
  });
  assert.equal(result.status, 0, result.stderr);
  const [a, gap, back, , , late] = JSON.parse(result.stdout.trim());
  assert.equal(a, NOW);
  assert.equal(gap, null);
  assert.equal(back, NOW, 'a pane back inside 10 minutes keeps its first-seen time');
  assert.equal(late, NOW + 21 * MIN, 'a pane back after the grace period is new');
});
