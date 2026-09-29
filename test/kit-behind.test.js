import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { kitRevisionState, kitSnapshot } from '../src/kit/agents-check.js';
import { kitReminderAlerts, KIT_REMIND_MS } from '../src/engine.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const A = 'aaaaaaaaaaaa';
const B = 'bbbbbbbbbbbb';
const C = 'cccccccccccc';
const D = 'dddddddddddd';
const NOW = Date.parse('2026-09-29T10:00:00.000Z');

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('kitRevisionState names the four states of a project kit revision', () => {
  const entries = [
    { revision: A, impact: 'required', summary: 'a' },
    { revision: B, impact: 'useful', summary: 'b' },
    { revision: C, impact: 'none', summary: 'c' },
    { revision: D, impact: 'required', summary: 'd' },
  ];
  assert.equal(kitRevisionState(null, D, entries), 'not published');
  assert.equal(kitRevisionState('', D, entries), 'not published');
  assert.equal(kitRevisionState(D, D, entries), 'current');
  assert.equal(kitRevisionState(C, D, entries), 'behind (required)');
  assert.equal(kitRevisionState(B, D, entries), 'behind (required)');
  assert.equal(kitRevisionState(B, C, entries.slice(0, 3)), 'behind (useful only)');
  assert.equal(kitRevisionState(A, C, entries.slice(0, 3)), 'behind (useful only)');
});

test('kitRevisionState treats an unknown revision as behind on a required change', () => {
  const entries = [{ revision: A, impact: 'useful', summary: 'a' }, { revision: B, impact: 'useful', summary: 'b' }];
  assert.equal(kitRevisionState('999999999999', B, entries), 'behind (required)');
  // The current revision has no log entry, so a change that is not recorded may be required.
  assert.equal(kitRevisionState(A, C, entries), 'behind (required)');
  assert.equal(kitRevisionState(A, B, []), 'behind (required)');
});

test('kitSnapshot gives the current revision and the impact of each recorded change', () => {
  const snapshot = kitSnapshot();
  assert.match(snapshot.current, /^[0-9a-f]{12}$/);
  assert.ok(Array.isArray(snapshot.changes));
  for (const change of snapshot.changes) assert.deepEqual(Object.keys(change).sort(), ['impact', 'revision']);
});

const cliProbe = `
import { runKitCommand } from './src/kit/cli.js';
const input = JSON.parse(process.env.KIT_SCENARIO);
const lines = [];
const herdr = () => { throw new Error('no herdr'); };
const result = runKitCommand('check', ['kit'], { output: (line) => lines.push(line), herdr, config: { kitChanges: input.entries, currentKitRevision: input.current } });
console.log(JSON.stringify({ lines, exitCode: result.exitCode, states: result.projects.map((p) => [p.slug, p.state]) }));
`;

function runCheckKit(t, projects, entries, current) {
  const dir = tmpDir(t, 'herdr-kit-behind-');
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  for (const [slug, data] of Object.entries(projects)) fs.writeFileSync(path.join(dir, 'projects', `${slug}.json`), JSON.stringify({ project: slug, ...data }));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', cliProbe], {
    cwd: repo, encoding: 'utf8',
    env: { ...process.env, HOME: dir, HERDR_BOSS_DIR: dir, KIT_SCENARIO: JSON.stringify({ entries, current }) },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test('check kit reports current, behind (useful only), and behind (required); only required fails', (t) => {
  const entries = [
    { revision: A, impact: 'required', summary: 'a' },
    { revision: B, impact: 'useful', summary: 'b' },
    { revision: C, impact: 'none', summary: 'c' },
  ];
  const useful = runCheckKit(t, { alpha: { kitRevision: C }, beta: { kitRevision: B } }, entries, C);
  assert.deepEqual(useful.states, [['alpha', 'current'], ['beta', 'behind (useful only)']]);
  assert.match(useful.lines[1], /^beta: kit revision bbbbbbbbbbbb \(behind \(useful only\)\); agents check not published$/);
  assert.match(useful.lines.at(-1), /^check kit: PASS \(current revision cccccccccccc; 2 projects, 1 behind \(useful only\)\)$/);
  assert.equal(useful.exitCode, 0);

  const usefulOnly = runCheckKit(t, { alpha: { kitRevision: A }, beta: { kitRevision: B } }, entries, C);
  assert.deepEqual(usefulOnly.states, [['alpha', 'behind (useful only)'], ['beta', 'behind (useful only)']]);
  const gone = runCheckKit(t, { alpha: { kitRevision: '999999999999' }, beta: { kitRevision: B } }, entries, C);
  assert.deepEqual(gone.states, [['alpha', 'behind (required)'], ['beta', 'behind (useful only)']]);
  assert.match(gone.lines.at(-1), /^check kit: FAIL \(current revision cccccccccccc; 2 projects, 1 behind \(required\), 1 behind \(useful only\)\)$/);
  assert.equal(gone.exitCode, 1);
});

test('kitReminderAlerts warns once after 2 hours behind on a required change', () => {
  const entries = [{ revision: A, impact: 'required', summary: 'a' }, { revision: B, impact: 'required', summary: 'b' }];
  const projects = [
    { slug: 'alpha', workspace: 'wA', kitRevision: A },
    { slug: 'beta', workspace: 'wB', kitRevision: B },
    { slug: 'gamma', kitRevision: A },
  ];
  const tracker = {};
  const args = (now) => ({ projects, tracker, now, current: B, changes: entries });
  assert.deepEqual(kitReminderAlerts(args(NOW)), []);
  assert.deepEqual(tracker.alpha, { since: NOW });
  assert.equal(tracker.beta, undefined);
  assert.deepEqual(kitReminderAlerts(args(NOW + KIT_REMIND_MS - 1)), []);
  const alerts = kitReminderAlerts(args(NOW + KIT_REMIND_MS));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].key, `kitremind:alpha:${B}`);
  assert.equal(alerts[0].scope, 'wA');
  assert.equal(alerts[0].immediate, true);
  assert.equal(alerts[0].once, true);
  assert.match(alerts[0].text, /^\[herdr-boss\] Your kit is behind on a required change\. Run herdr-boss kit update/);
});

test('kitReminderAlerts stops and resets the clock when the project catches up or the change is useful only', () => {
  const entries = [{ revision: A, impact: 'required', summary: 'a' }, { revision: B, impact: 'useful', summary: 'b' }];
  const tracker = { alpha: { since: NOW - 5 * KIT_REMIND_MS } };
  const project = (kitRevision) => [{ slug: 'alpha', workspace: 'wA', kitRevision }];
  assert.deepEqual(kitReminderAlerts({ projects: project(A), tracker, now: NOW, current: B, changes: entries }), []);
  assert.equal(tracker.alpha, undefined);
  tracker.alpha = { since: NOW - 5 * KIT_REMIND_MS };
  assert.deepEqual(kitReminderAlerts({ projects: project(B), tracker, now: NOW, current: B, changes: entries }), []);
  assert.equal(tracker.alpha, undefined);
});

const deliverProbe = `
import { Engine } from './src/engine.js';
import { loadConfig } from './src/config.js';
const input = JSON.parse(process.env.KIT_SCENARIO);
const prompts = [];
const cfg = loadConfig();
cfg.push = false;
const engine = new Engine(cfg, { push: false, act: false, gitRunner: async () => '', kitRoot: '/kit-root', herdrRunner: async (cmd, args) => { prompts.push(args); return ''; } });
engine.push = true;
const alert = { key: 'kitremind:alpha:bbbbbbbbbbbb', severity: 'warn', scope: 'wA', immediate: true, once: true, noDesktop: true, title: 'Kit behind', text: '[herdr-boss] Your kit is behind on a required change. Run herdr-boss kit update.' };
const now = Date.parse('2026-09-29T10:00:00.000Z');
for (const [i, panes] of input.rounds.entries()) await engine.deliver([alert], { panes }, now + i * 60000);
console.log(JSON.stringify({ prompts: prompts.filter((a) => a[0] === 'agent' && a[1] === 'prompt').map((a) => a[2]) }));
`;

test('the kit reminder reaches a working project orchestrator once and no other pane', (t) => {
  const dir = tmpDir(t, 'herdr-kit-remind-');
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  const orch = (id, workspace, status, label = 'orch') => ({ id, workspace, workspaceLabel: workspace, label, orch: true, agent: 'claude', status });
  const rounds = [
    [orch('wA:p1', 'wA', 'idle'), orch('wB:p1', 'wB', 'working'), orch('wA:p9', 'wA', 'working', 'boss')],
    [orch('wA:p1', 'wA', 'working'), orch('wB:p1', 'wB', 'working')],
    [orch('wA:p1', 'wA', 'working'), orch('wB:p1', 'wB', 'working')],
  ];
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', deliverProbe], {
    cwd: repo, encoding: 'utf8',
    env: { ...process.env, HOME: dir, HERDR_BOSS_DIR: dir, HERDR_BOSS_LIVE_DIR: dir, KIT_SCENARIO: JSON.stringify({ rounds }) },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()).prompts, ['wA:p1']);
});
