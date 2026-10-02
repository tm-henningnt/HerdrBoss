import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { alertPromptDue } from '../src/engine.js';
import { boardDigestAlerts, DIVERGE_AFTER_MS, DIVERGE_EVERY_MS, DIVERGE_BOSS_AFTER_MS } from '../src/board-digest.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN = 60000;
const NOW = Date.parse('2026-10-02T10:00:00.000Z');
const project = (extra = {}) => ({ slug: 'alpha', workspace: 'wA', boardDiverged: 2, boardDivergedIds: ['A1', 'A2'], ...extra });

test('the digest waits until a divergence is older than 30 minutes', () => {
  const tracker = {};
  const args = (now, projects = [project()]) => ({ projects, tracker, now });
  assert.deepEqual(boardDigestAlerts(args(NOW)), []);
  assert.deepEqual(tracker.alpha, { since: NOW });
  assert.deepEqual(boardDigestAlerts(args(NOW + DIVERGE_AFTER_MS)), [], 'exactly 30 minutes is not more than 30 minutes');
  const alerts = boardDigestAlerts(args(NOW + DIVERGE_AFTER_MS + 1));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].text, '2 cards differ from git: A1, A2. Publish the status with --sync.');
  assert.equal(alerts[0].key, 'board:diverge:alpha');
  assert.equal(alerts[0].scope, 'wA');
  assert.equal(alerts[0].repeatMs, DIVERGE_EVERY_MS);
  assert.equal(alerts[0].noDesktop, true);
});

test('the digest uses the singular for one card and cuts a long id list', () => {
  const tracker = { alpha: { since: NOW - 40 * MIN } };
  const one = boardDigestAlerts({ projects: [project({ boardDiverged: 1, boardDivergedIds: ['A1'] })], tracker, now: NOW });
  assert.equal(one[0].text, '1 card differs from git: A1. Publish the status with --sync.');
  const ids = Array.from({ length: 14 }, (_, i) => `T${i}`);
  const many = boardDigestAlerts({ projects: [project({ boardDiverged: 14, boardDivergedIds: ids })], tracker, now: NOW });
  assert.equal(many[0].text, '14 cards differ from git: T0, T1, T2, T3, T4, T5, T6, T7, T8, T9 and 4 more. Publish the status with --sync.');
});

test('the digest is due once each hour for a pane', () => {
  const [alert] = boardDigestAlerts({ projects: [project()], tracker: { alpha: { since: NOW - 40 * MIN } }, now: NOW });
  assert.equal(alertPromptDue(alert, null, NOW, 0), true);
  assert.equal(alertPromptDue(alert, { at: NOW, severity: 'warn' }, NOW + DIVERGE_EVERY_MS - 1, 0), false);
  assert.equal(alertPromptDue(alert, { at: NOW, severity: 'warn' }, NOW + DIVERGE_EVERY_MS, 0), true);
});

test('the clock restarts when the divergence ends', () => {
  const tracker = { alpha: { since: NOW - 5 * 3600000 } };
  assert.deepEqual(boardDigestAlerts({ projects: [project({ boardDiverged: 0, boardDivergedIds: [] })], tracker, now: NOW }), []);
  assert.equal(tracker.alpha, undefined);
  assert.deepEqual(boardDigestAlerts({ projects: [project()], tracker, now: NOW + 1 }), []);
  assert.deepEqual(tracker.alpha, { since: NOW + 1 });
});

test('the digest skips a held project and restarts its clock', () => {
  const tracker = { alpha: { since: NOW - 5 * 3600000 } };
  const held = (slug) => slug === 'alpha';
  assert.deepEqual(boardDigestAlerts({ projects: [project()], tracker, now: NOW, held }), []);
  assert.equal(tracker.alpha, undefined);
});

test('a project without a workspace gets no digest to a pane but still reaches the Boss notice', () => {
  const tracker = { alpha: { since: NOW - DIVERGE_BOSS_AFTER_MS } };
  const alerts = boardDigestAlerts({ projects: [project({ workspace: undefined })], tracker, now: NOW });
  assert.deepEqual(alerts.map((alert) => alert.scope), ['boss']);
});

test('the Boss gets one notice when the divergence lasts 3 hours', () => {
  const since = NOW - DIVERGE_BOSS_AFTER_MS + 1;
  const tracker = { alpha: { since } };
  assert.deepEqual(boardDigestAlerts({ projects: [project()], tracker, now: NOW }).map((alert) => alert.scope), ['wA']);
  const alerts = boardDigestAlerts({ projects: [project()], tracker, now: NOW + 1 });
  assert.deepEqual(alerts.map((alert) => alert.scope), ['wA', 'boss']);
  const boss = alerts[1];
  assert.equal(boss.key, `board:diverge-boss:alpha:${since}`);
  assert.equal(boss.once, true);
  assert.equal(boss.noDesktop, true);
  assert.match(boss.text, /^alpha: 2 cards differ from git for 3 hours: A1, A2\./);
  assert.equal(alertPromptDue(boss, null, NOW, 0), true);
  assert.equal(alertPromptDue(boss, { at: NOW, severity: 'warn' }, NOW + 24 * 3600000, 0), false);
});

const deliverProbe = `
import { Engine } from './src/engine.js';
import { loadConfig } from './src/config.js';
import { boardDigestAlerts } from './src/board-digest.js';
const input = JSON.parse(process.env.DIGEST_SCENARIO);
const prompts = [];
const cfg = loadConfig();
cfg.push = false;
const engine = new Engine(cfg, { push: false, act: false, gitRunner: async () => '', kitRoot: '/kit-root', herdrRunner: async (cmd, args) => { prompts.push(args); return ''; } });
engine.push = true;
const tracker = { alpha: { since: input.since } };
const held = new Set(input.held || []);
for (const [i, panes] of input.rounds.entries()) {
  const now = input.now + (input.offsets?.[i] ?? i * 60000);
  const alerts = boardDigestAlerts({ projects: input.projects, tracker, now, held: (slug) => held.has(slug) });
  await engine.deliver(alerts, { panes }, now, null, new Set(input.heldWorkspaces || []));
}
console.log(JSON.stringify({ prompts: prompts.filter((a) => a[0] === 'agent' && a[1] === 'prompt').map((a) => ({ pane: a[2], text: a[3] })) }));
`;

function run(t, scenario) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-board-digest-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', deliverProbe], {
    cwd: repo, encoding: 'utf8',
    env: { ...process.env, HOME: dir, HERDR_BOSS_DIR: dir, HERDR_BOSS_LIVE_DIR: dir, DIGEST_SCENARIO: JSON.stringify({ now: NOW, since: NOW - 40 * MIN, projects: [project()], ...scenario }) },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim()).prompts;
}

const pane = (id, workspace, status, label = 'orch') => ({ id, workspace, workspaceLabel: workspace, label, orch: true, agent: 'claude', status });

test('the digest reaches only an idle orchestrator of the project, once each hour', (t) => {
  const idle = [pane('wA:p1', 'wA', 'idle'), pane('wB:p1', 'wB', 'idle'), pane('wA:p9', 'wA', 'idle', 'boss')];
  const working = [pane('wA:p1', 'wA', 'working'), pane('wB:p1', 'wB', 'idle')];
  const prompts = run(t, {
    rounds: [working, idle, idle, idle, idle],
    offsets: [0, MIN, 30 * MIN, DIVERGE_EVERY_MS, DIVERGE_EVERY_MS + MIN],
  });
  assert.deepEqual(prompts.map((p) => p.pane), ['wA:p1', 'wA:p1'], 'a working pane waits; an idle pane gets one line in the first hour and one in the next');
  assert.match(prompts[0].text, /- 2 cards differ from git: A1, A2\. Publish the status with --sync\./);
});

test('the digest finds the orchestrator by the live pane list after a pane id change', (t) => {
  const prompts = run(t, { rounds: [[pane('wA:p1', 'wA', 'idle')], [pane('wA:p7', 'wA', 'idle')]], offsets: [0, 5 * MIN] });
  assert.deepEqual(prompts.map((p) => p.pane), ['wA:p1']);
  const later = run(t, { rounds: [[pane('wA:p1', 'wA', 'idle')], [pane('wA:p7', 'wA', 'idle')]], offsets: [0, DIVERGE_EVERY_MS] });
  assert.deepEqual(later.map((p) => p.pane), ['wA:p1', 'wA:p7']);
});

test('the digest skips the orchestrator of a held project', (t) => {
  const prompts = run(t, { rounds: [[pane('wA:p1', 'wA', 'idle')]], held: ['alpha'], heldWorkspaces: ['wA'] });
  assert.deepEqual(prompts, []);
});

test('the Boss gets one notice after 3 hours of divergence and no second notice', (t) => {
  const prompts = run(t, {
    since: NOW - DIVERGE_BOSS_AFTER_MS - MIN,
    rounds: [[pane('wA:p1', 'wA', 'working'), pane('wZ:p1', 'wZ', 'idle', 'boss')], [pane('wA:p1', 'wA', 'working'), pane('wZ:p1', 'wZ', 'idle', 'boss')]],
    offsets: [0, 10 * MIN],
  });
  const boss = prompts.filter((p) => p.pane === 'wZ:p1');
  assert.equal(boss.length, 1);
  assert.match(boss[0].text, /alpha: 2 cards differ from git for 3 hours/);
});
