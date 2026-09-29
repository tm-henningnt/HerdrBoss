import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { POLICY_DEFAULTS } from '../src/control.js';
import { evaluate, renderBulletin } from '../src/rules.js';
import { inspectWorkerNoReports } from '../src/engine.js';
import * as engineModule from '../src/engine.js';
import { inspectWorkerReports } from '../src/worker-failures.js';
import { validateProject } from '../src/projects.js';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const NOW = Date.parse('2026-09-27T12:00:00Z');
const MIN = 60000;
const CFG = { quota: { warnPercent: 90, criticalPercent: 98 }, machine: { memFreeWarnPercent: 15, loadWarnFactor: 2 }, providerKinds: {}, browsers: { staleOwnedMinutes: 30 }, workers: { staleIdleMinutes: 120 }, sharedBrowsers: [] };
const policy = (patch = {}) => ({ ...structuredClone(POLICY_DEFAULTS), ...patch });

// Runs Engine.deliver in a child process with a temporary data directory and a fake herdr on PATH.
// Each round is { alerts, panes, at }. The injected herdr runner records each pane prompt.
const deliverProbe = `
import { Engine } from './src/engine.js';
import { loadConfig } from './src/config.js';
const input = JSON.parse(process.env.NOTICE_SCENARIO);
const prompts = [];
const cfg = loadConfig();
cfg.push = false;
const engine = new Engine(cfg, {
  push: false, act: false,
  herdrRunner: async (cmd, args) => { prompts.push({ round: current, pane: args[2], text: args[3] }); return ''; },
});
engine.push = true;
let current = 0;
for (const [i, round] of input.rounds.entries()) {
  current = i;
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
  // The Owner notification uses the herdr binary directly. This fake one does nothing.
  fs.writeFileSync(path.join(bin, 'herdr'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', deliverProbe], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env, HOME: dir, HERDR_BOSS_DIR: path.join(dir, 'data'), NODE_TEST_CONTEXT: '1',
      PATH: `${bin}${path.delimiter}${process.env.PATH}`, NOTICE_SCENARIO: JSON.stringify({ rounds }),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim()).prompts;
}

const orch = (status = 'idle') => ({ id: 'w1:p1', workspace: 'w1', orch: true, label: 'orch', agent: 'claude', status });
const info = (n, extra = {}) => ({ key: `test:info:${n}`, severity: 'info', scope: 'w1', title: `Info ${n}`, text: `Info notice ${n}.`, ...extra });
const warn = (n, extra = {}) => ({ key: `test:warn:${n}`, severity: 'warn', scope: 'w1', title: `Warn ${n}`, text: `Warn notice ${n}.`, ...extra });

// Runs Engine.deliverNightNotices in a child process with a temporary data directory and a recorded herdr runner.
// Each round is { at, night, clear, panes, fail, restart }. A round with a night state stores it, and a round with
// clear removes it, as `night stop` does. A round without both keeps the file as the engine left it. The probe
// reads the state the way the service reads it, before the engine runs. A restart builds a new engine, which
// reloads the engine memory from its file. A pane that a round lists in fail refuses the prompt in that round.
const nightNoticeProbe = `
import { Engine } from './src/engine.js';
import { loadConfig } from './src/config.js';
import { clearNight, readNight, readNightRecord, writeNight } from './src/night.js';
const input = JSON.parse(process.env.NIGHT_SCENARIO);
const dataDir = process.env.HERDR_BOSS_DIR;
const prompts = [];
let current = 0;
let broken = new Set();
const cfg = loadConfig();
cfg.push = false;
const make = () => {
  const engine = new Engine(cfg, {
    push: false, act: false,
    herdrRunner: async (cmd, args) => {
      if (broken.has(args[2])) throw new Error('herdr refused the prompt');
      prompts.push({ round: current, pane: args[2], text: args[3] });
      return '';
    },
  });
  engine.push = true;
  return engine;
};
let engine = make();
for (const [i, round] of input.rounds.entries()) {
  current = i;
  if (round.night) writeNight(round.night, { dataDir });
  if (round.clear) clearNight({ dataDir });
  if (round.restart) engine = make();
  broken = new Set(round.fail || []);
  await engine.deliverNightNotices(readNight({ dataDir, now: round.at }), { panes: round.panes }, round.at);
}
console.log(JSON.stringify({ prompts, record: readNightRecord({ dataDir }) }));
`;

function nightNoticeRounds(t, rounds) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-night-notice-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'herdr'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', nightNoticeProbe], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env, HOME: dir, HERDR_BOSS_DIR: path.join(dir, 'data'), NODE_TEST_CONTEXT: '1',
      PATH: `${bin}${path.delimiter}${process.env.PATH}`, NIGHT_SCENARIO: JSON.stringify({ rounds }),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

const NIGHT_UNTIL = '2026-09-29T05:30:00.000Z';
const NIGHT_LABEL = new Date(NIGHT_UNTIL).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const START_TEXT = `[herdr-boss] Night watch until ${NIGHT_LABEL}. The Owner is away; the Boss acts for the Owner. Work as normal. Escalate to the Boss.`;
const STOP_TEXT = '[herdr-boss] Night watch ended. The Owner rules apply again.';
// A working pane, because a night notice is a direct prompt. It must not wait for an idle orchestrator.
const nightPanes = [
  { id: 'w1:p1', workspace: 'w1', orch: true, label: 'orch', agent: 'claude', status: 'working' },
  { id: 'w2:p1', workspace: 'w2', orch: true, label: 'orch', agent: 'claude', status: 'working' },
  { id: 'boss:p1', workspace: 'boss', orch: true, label: 'boss', agent: 'claude', status: 'working' },
];
const nightPanesWith = (extra) => [...nightPanes, ...extra];
const nightRecord = (patch = {}) => ({ active: true, since: new Date(NOW).toISOString(), until: NIGHT_UNTIL, by: 'owner', quietHours: false, ...patch });
const isStart = (prompt) => /Night watch until/.test(prompt.text);
const isStop = (prompt) => prompt.text === STOP_TEXT;

test('the night start notice reaches each orchestrator pane and the Boss pane once', (t) => {
  const { prompts, record } = nightNoticeRounds(t, [
    { at: NOW, night: nightRecord(), panes: nightPanes },
    { at: NOW + 10 * MIN, panes: nightPanes },
  ]);
  assert.deepEqual(prompts.map((p) => p.pane).sort(), ['boss:p1', 'w1:p1', 'w2:p1'], 'each pane gets the notice');
  assert.equal(prompts.filter((p) => p.round === 0).length, 3, 'the first tick sends the notice');
  assert.equal(prompts.filter((p) => p.round === 1).length, 0, 'a later tick sends nothing');
  for (const prompt of prompts) {
    assert.equal(prompt.text, START_TEXT);
    assert.doesNotMatch(prompt.text, /Current rules/, 'a night notice is a plain prompt, not a resource notice');
  }
  assert.deepEqual(Object.keys(record.noticeStartAt).sort(), ['boss:p1', 'w1:p1', 'w2:p1'], 'the marks name each pane');
  assert.equal(record.noticeStopAt, undefined, 'the end notice is not due yet');
});

test('a restart does not send the night start notice again', (t) => {
  const { prompts } = nightNoticeRounds(t, [
    { at: NOW, night: nightRecord(), panes: nightPanes },
    { at: NOW + 10 * MIN, panes: nightPanes, restart: true },
    { at: NOW + 20 * MIN, panes: nightPanes, restart: true },
  ]);
  assert.equal(prompts.length, 3, 'the stored marks survive a restart');
});

test('a pane that joins during the night gets the start notice once', (t) => {
  const late = { id: 'w3:p1', workspace: 'w3', orch: true, label: 'orch', agent: 'claude', status: 'working' };
  const { prompts } = nightNoticeRounds(t, [
    { at: NOW, night: nightRecord(), panes: nightPanes },
    { at: NOW + MIN, panes: nightPanesWith([late]), restart: true },
    { at: NOW + 2 * MIN, panes: nightPanesWith([late]) },
  ]);
  assert.deepEqual(prompts.map((p) => p.pane).sort(), ['boss:p1', 'w1:p1', 'w2:p1', 'w3:p1']);
  const later = prompts.filter((p) => p.round === 1);
  assert.deepEqual(later.map((p) => p.pane), ['w3:p1'], 'only the new pane gets a notice');
  assert.equal(prompts.filter((p) => p.round === 2).length, 0, 'the new pane gets one notice');
});

test('the end notice reaches each pane that got the start notice, when the end time passes', (t) => {
  const after = Date.parse(NIGHT_UNTIL) + MIN;
  const { prompts, record } = nightNoticeRounds(t, [
    { at: NOW, night: nightRecord(), panes: nightPanes },
    { at: after, panes: nightPanes, restart: true },
    { at: after + MIN, panes: nightPanes },
  ]);
  assert.equal(prompts.filter(isStart).length, 3, 'the start notice goes out once per pane');
  const stops = prompts.filter(isStop);
  assert.deepEqual(stops.map((p) => p.pane).sort(), ['boss:p1', 'w1:p1', 'w2:p1'], 'each pane gets the end notice');
  assert.equal(prompts.filter((p) => p.round === 2).length, 0, 'the end notice goes out once per pane');
  assert.deepEqual(Object.keys(record.noticeStopAt).sort(), ['boss:p1', 'w1:p1', 'w2:p1']);
  assert.equal(record.active, true, 'the stored record is not rewritten, the read state is not active');
});

test('a stop that clears the state still sends the end notice once', (t) => {
  const { prompts } = nightNoticeRounds(t, [
    { at: NOW, night: nightRecord(), panes: nightPanes },
    { at: NOW + MIN, clear: true, panes: nightPanes, restart: true },
    { at: NOW + 2 * MIN, clear: true, panes: nightPanes },
  ]);
  assert.equal(prompts.filter(isStart).length, 3);
  assert.equal(prompts.filter(isStop).length, 3, 'the end notice reaches every pane that started the night');
});

test('a failed night notice is sent again at the next tick', (t) => {
  const { prompts } = nightNoticeRounds(t, [
    { at: NOW, night: nightRecord(), panes: nightPanes, fail: ['w2:p1', 'boss:p1'] },
    { at: NOW + MIN, panes: nightPanes },
    { at: NOW + 2 * MIN, panes: nightPanes, restart: true },
  ]);
  assert.deepEqual(prompts.filter((p) => p.round === 0).map((p) => p.pane), ['w1:p1'], 'the failed panes get nothing');
  assert.deepEqual(prompts.filter((p) => p.round === 1).map((p) => p.pane).sort(), ['boss:p1', 'w2:p1'],
    'the next tick sends the two failed notices');
  assert.equal(prompts.filter((p) => p.round === 2).length, 0, 'a stored mark keeps the notice sent');
});

test('a mark from an earlier night does not keep the start notice from going out', (t) => {
  const stale = { noticeStartAt: { 'w1:p1': new Date(NOW - 24 * 3600 * 1000).toISOString(), 'w2:p1': new Date(NOW).toISOString() } };
  const { prompts } = nightNoticeRounds(t, [
    { at: NOW, night: nightRecord(stale), panes: nightPanes, restart: true },
  ]);
  assert.deepEqual(prompts.map((p) => p.pane).sort(), ['boss:p1', 'w1:p1'],
    'the pane with a mark from the earlier night gets the notice of this night');
  assert.equal(prompts.every(isStart), true);
});

test('a worker report notice has one key per report path across mtime changes', () => {
  const panes = [{ id: 'w1:p2', workspace: 'w1', agent: 'claude', name: 'alpha', cwd: '/tmp/wt-alpha', status: 'done' }];
  const observed = { 'w1:p2': { agent: 'claude', name: 'alpha', sessionId: null, firstSeen: NOW - 10 * MIN } };
  const at = (mtimeMs) => (file) => (file === '/tmp/wt-alpha/.worker/report.json' ? { isFile: true, mtimeMs } : null);
  const first = inspectWorkerReports(panes, observed, NOW, at(NOW - 5 * MIN)).notices;
  const second = inspectWorkerReports(panes, observed, NOW + MIN, at(NOW - 2 * MIN)).notices;
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(second[0].key, first[0].key, 'a rewrite of the same report keeps the key');
  assert.doesNotMatch(first[0].key, /:\d{10,}/, 'the key holds no mtime');
  const otherRun = inspectWorkerReports([{ ...panes[0], cwd: '/tmp/wt-beta' }], observed, NOW,
    (file) => (file === '/tmp/wt-beta/.worker/report.json' ? { isFile: true, mtimeMs: NOW - MIN } : null)).notices;
  assert.notEqual(otherRun[0].key, first[0].key, 'a new report path gets a new key');
});

test('a rewritten report reaches the orchestrator once', (t) => {
  const panes = [orch('idle'), { id: 'w1:p2', workspace: 'w1', agent: 'claude', name: 'alpha', cwd: '/tmp/wt-alpha', status: 'done' }];
  const observed = { 'w1:p2': { agent: 'claude', name: 'alpha', sessionId: null, firstSeen: NOW - 10 * MIN } };
  const rounds = [0, 1, 2].map((i) => ({
    at: NOW + i * 2 * 3600 * 1000,
    panes,
    alerts: inspectWorkerReports(panes, observed, NOW, () => ({ isFile: true, mtimeMs: NOW + i * MIN })).notices,
  }));
  const prompts = deliverRounds(t, rounds);
  assert.equal(prompts.filter((p) => /wrote its report/.test(p.text)).length, 1);
});

test('an idle worker without report.json reaches its orchestrator once per idle period after 10 minutes', (t) => {
  const worker = { id: 'w1:p2', workspace: 'w1', agent: 'claude', name: 'alpha', cwd: '/tmp/wt-alpha', status: 'idle' };
  const run = { name: 'alpha', pane: worker.id, worktree: worker.cwd, startedAt: '2026-09-27T11:00:00.000Z' };
  let observed = {};
  const rounds = [];
  const observe = (pane, at) => {
    const result = inspectWorkerNoReports([pane], [run], observed, at, () => false);
    observed = result.observed;
    rounds.push({ at, panes: [orch('idle'), pane], alerts: result.notices });
  };
  observe(worker, NOW);
  observe(worker, NOW + 10 * MIN - 1);
  observe(worker, NOW + 10 * MIN);
  observe(worker, NOW + 11 * MIN);
  observe({ ...worker, status: 'working' }, NOW + 12 * MIN);
  observe(worker, NOW + 13 * MIN);
  observe(worker, NOW + 23 * MIN);

  assert.equal(rounds[0].alerts.length, 0, 'the idle period starts on first observation');
  assert.equal(rounds[1].alerts.length, 0, 'the watchdog waits for the full 10 minutes');
  assert.equal(rounds[2].alerts.length, 1, 'the notice becomes due at 10 minutes');
  assert.equal(rounds[3].alerts.length, 1, 'the same notice stays active until the worker works');
  assert.equal(rounds[4].alerts.length, 0, 'a working pane never triggers the notice');
  assert.equal(rounds[5].alerts.length, 0, 'work resets the idle period');
  assert.equal(rounds[6].alerts.length, 1, 'a new idle period can trigger a new notice');

  const prompts = deliverRounds(t, rounds);
  assert.equal(prompts.length, 2, 'delivery sends one notice for each idle period');
  assert.deepEqual(prompts.map((prompt) => prompt.pane), ['w1:p1', 'w1:p1']);
  assert.ok(prompts.every((prompt) => prompt.text.includes('Worker alpha in w1:p2 is idle for 10 min with no report.json. Check it, then resume or collect it.')));
});

test('the no-report watchdog stays quiet when report.json exists', () => {
  const worker = { id: 'w1:p2', workspace: 'w1', agent: 'claude', name: 'alpha', cwd: '/tmp/wt-alpha', status: 'done' };
  const run = { name: 'alpha', pane: worker.id, worktree: worker.cwd, startedAt: '2026-09-27T11:00:00.000Z' };
  let observed = {};
  observed = inspectWorkerNoReports([worker], [run], observed, NOW, () => true).observed;
  const result = inspectWorkerNoReports([worker], [run], observed, NOW + 10 * MIN, () => true);
  assert.equal(result.notices.length, 0);
});

test('an info immediate notice waits for an idle orchestrator and a warn immediate notice does not', (t) => {
  assert.equal(engineModule.orchestratorCanReceiveNotice({ status: 'working' }, [{ immediate: true, severity: 'info' }]), false);
  assert.equal(engineModule.orchestratorCanReceiveNotice({ status: 'working' }, [{ immediate: true, severity: 'warn' }]), true);
  const report = info('report', { immediate: true });
  const failed = warn('failed', { immediate: true });
  const prompts = deliverRounds(t, [
    { at: NOW, panes: [orch('working')], alerts: [report] },
    { at: NOW + MIN, panes: [orch('working')], alerts: [report, failed] },
    { at: NOW + 2 * MIN, panes: [orch('idle')], alerts: [report, failed] },
  ]);
  assert.equal(prompts.some((p) => p.round === 0), false, 'the info notice does not reach a working orchestrator');
  const second = prompts.filter((p) => p.round === 1);
  assert.equal(second.length, 1, 'the warn notice reaches a working orchestrator');
  assert.match(second[0].text, /Warn notice failed/);
  assert.doesNotMatch(second[0].text, /Info notice report/, 'the info notice does not ride on the warn prompt of a working pane');
  const third = prompts.filter((p) => p.round === 2);
  assert.equal(third.length, 1);
  assert.match(third[0].text, /Info notice report/, 'the info notice goes out at idle');
});

test('quota, quota recovery, and browser-ready alerts are in the bulletin but produce no prompt', (t) => {
  const snap = {
    updatedAt: new Date(NOW).toISOString(),
    herdr: { workspaces: [{ id: 'w1', label: 'HerdrBoss' }], panes: [orch('idle'), { id: 'w1:p2', workspace: 'w1', agent: 'pi', status: 'working' }] },
    quotas: [
      { provider: 'opencodego', windows: [{ key: 'weekly', label: 'Weekly', usedPercent: 100, resetsAt: '2026-09-30T00:00:00Z' }] },
      { provider: 'claude', windows: [{ key: 'session', label: 'Session', usedPercent: 92, resetsAt: '2026-09-27T15:00:00Z' }] },
    ],
    browsers: [],
  };
  const evaluation = evaluate(snap, CFG, {}, NOW, policy());
  const quota = evaluation.alerts.filter((a) => a.key.startsWith('quota:'));
  assert.equal(quota.length, 2);
  for (const alert of quota) assert.equal(alert.prompt, false, `${alert.key} is bulletin only`);
  assert.equal(typeof engineModule.quotaRecoveredAlert, 'function', 'engine exports the quota recovery alert source');
  assert.equal(typeof engineModule.browserReadyAlert, 'function', 'engine exports the browser-ready alert source');
  const recovered = engineModule.quotaRecoveredAlert('claude:session', { resetsAt: '2026-09-27T15:00:00Z', text: 'Claude session quota has reset to 3%.' });
  const ready = engineModule.browserReadyAlert({ project: 'herdrboss', port: 9333, headless: true }, 'w1');
  assert.equal(recovered.prompt, false);
  assert.equal(ready.prompt, false);
  evaluation.alerts.push(recovered, ready);
  const bulletin = renderBulletin(snap, evaluation, { port: 4477 });
  assert.match(bulletin, /OpenCode Go weekly quota is at 100%/);
  assert.match(bulletin, /Claude session quota is at 92%/);
  assert.match(bulletin, /Claude session quota has reset to 3%/);
  assert.match(bulletin, /Browser for herdrboss is ready/);
  const kept = warn('failed', { immediate: true, text: 'Worker alpha (w1:p2) failed: rate limit.' });
  const prompts = deliverRounds(t, [{ at: NOW, panes: snap.herdr.panes, alerts: [...evaluation.alerts, kept] }]);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].text, /Worker alpha \(w1:p2\) failed/, 'a worker failure stays a prompt');
  // Check only the notice lines: the prompt footer names the bulletin path, which can contain any word.
  const noticeLines = prompts[0].text.split('\n').filter((line) => line.startsWith('- '));
  assert.ok(noticeLines.length >= 1);
  assert.doesNotMatch(noticeLines.join('\n'), /quota|browser/i);
});

test('the hourly budget batches info notices with an 8-line cap and warn notices bypass it', (t) => {
  const panes = [orch('idle')];
  const pending = Array.from({ length: 11 }, (_, i) => info(`b${i + 1}`));
  const prompts = deliverRounds(t, [
    { at: NOW, panes, alerts: [info('a')] },
    { at: NOW + 10 * MIN, panes, alerts: [info('a'), ...pending] },
    { at: NOW + 20 * MIN, panes, alerts: [info('a'), ...pending, warn('w')] },
    { at: NOW + 61 * MIN, panes, alerts: [info('a'), ...pending, warn('w')] },
    { at: NOW + 70 * MIN, panes, alerts: [info('a'), ...pending, warn('w'), info('late')] },
  ]);
  const byRound = (round) => prompts.filter((p) => p.round === round);
  assert.equal(byRound(0).length, 1, 'the first info notice goes out');
  assert.equal(byRound(1).length, 0, 'info notices wait inside the hour');
  assert.equal(byRound(2).length, 1, 'a warn notice bypasses the budget');
  assert.match(byRound(2)[0].text, /Warn notice w/);
  assert.doesNotMatch(byRound(2)[0].text, /Info notice b/, 'pending info notices stay pending');
  assert.equal(byRound(3).length, 1, 'the pending info notices go out after the hour');
  const lines = byRound(3)[0].text.split('\n').filter((line) => /^- Info notice b/.test(line));
  assert.equal(lines.length, 8, 'the prompt holds at most 8 info lines');
  assert.match(byRound(3)[0].text, /and 3 more/);
  assert.equal(byRound(4).length, 0, 'a new info notice waits for the next hour');
});

test('a held group suppresses the idle-orchestrator nudge', () => {
  const fixture = (held) => ({
    projects: [{ slug: 'herdrboss', workspace: 'w1', project: 'HerdrBoss', groups: [{ id: 'g1', title: 'Held work', ...(held == null ? {} : { held }) }],
      tasks: [{ id: '74', title: 'Parse event log', status: 'todo', group: 'g1' }] }],
    control: { projects: { herdrboss: { slug: 'herdrboss', workspace: 'w1', label: 'HerdrBoss', mode: 'auto', effectiveMode: 'auto' } } },
    herdr: { workspaces: [{ id: 'w1', label: 'HerdrBoss' }], panes: [orch('idle')] },
    quotas: [],
    browsers: [],
  });
  const nudges = (snap) => evaluate(snap, CFG, { 'w1:p1': { since: NOW - 30 * MIN } }, NOW, policy({ idleMinutes: 15 })).alerts.filter((a) => a.key.startsWith('nudge:'));
  assert.equal(nudges(fixture()).length, 1, 'a group without held gets the nudge');
  assert.equal(nudges(fixture(false)).length, 1);
  assert.deepEqual(nudges(fixture(true)), [], 'a held group gets no nudge');
  const mixed = fixture(true);
  mixed.projects[0].tasks.push({ id: '75', title: 'Render graph', status: 'todo' });
  const [next] = nudges(mixed);
  assert.match(next.text, /task 75 "Render graph"/, 'the nudge names the next task outside the held group');
  assert.deepEqual(validateProject({ project: 'x', groups: [{ id: 'g1', title: 'G', held: true }] }), []);
  assert.deepEqual(validateProject({ project: 'x', groups: [{ id: 'g1', title: 'G', held: 'yes' }] }), ['groups[0].held must be true or false']);
});
