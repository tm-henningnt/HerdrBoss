import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildWatchRecord, clearNight, defaultNightUntil, nextDailyTime, nightFile, nightNoticeSent, nightUntil, parseNightUntil, readNight, readNightRecord, watchHours, watchLabel, watchLengthWarning, withNoticeMark, writeNight } from '../src/night.js';
import { serviceSettingsView, validateServiceSettings } from '../src/config.js';
import { renderBulletin } from '../src/rules.js';

const NOW = Date.parse('2026-09-28T22:00:00Z');
const UNTIL = '2026-09-29T05:30:00.000Z';

let counter = 0;
// Every test uses its own data directory. The service data directory is never written.
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `herdr-night-${counter += 1}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function bulletin(snap) {
  return renderBulletin({ updatedAt: new Date(NOW).toISOString(), quotas: [], ...snap }, { alerts: [], advice: [] }, { host: '127.0.0.1', port: 4477 });
}

test('quiet hours are active only during an active night with quiet hours enabled', async () => {
  const { quietHoursActive } = await import('../src/night.js');
  assert.equal(quietHoursActive({ active: true, quietHours: true }), true);
  assert.equal(quietHoursActive({ active: true, quietHours: false }), false);
  assert.equal(quietHoursActive({ active: false, quietHours: true }), false);
  assert.equal(quietHoursActive(null), false);
});

test('night quiet hours is a settable service setting with a false default', () => {
  assert.equal(serviceSettingsView({}).find(({ setting }) => setting === 'watch.quietHours')?.value, false);
  assert.deepEqual(validateServiceSettings({ 'watch.quietHours': true }), { 'watch.quietHours': true });
  assert.throws(() => validateServiceSettings({ 'watch.quietHours': 'yes' }), /watch\.quietHours must be true or false/);
});

test('quiet hours queues desktop notifications and shows each once after the night ends', (t) => {
  const temp = tempDir(t);
  const home = path.join(temp, 'home');
  const dataDir = path.join(temp, 'data');
  const binDir = path.join(home, '.local', 'bin');
  const callsFile = path.join(temp, 'notifications.txt');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const herdr = path.join(binDir, 'herdr');
  fs.writeFileSync(herdr, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$HERDR_TEST_CALLS"\n');
  fs.chmodSync(herdr, 0o700);
  const script = `
import fs from 'node:fs';
const { Engine } = await import(process.env.ENGINE_URL);
const { loadConfig } = await import(process.env.CONFIG_URL);
const engine = new Engine(loadConfig(), { push: false, act: false });
const alert = { key: 'machine:disk:main', severity: 'warn', title: 'Disk low', text: 'Disk space is low.' };
await engine.deliver([alert], { panes: [] }, 1000, { active: true, quietHours: true });
const queued = structuredClone(engine.memory.quietNotifications || []);
const held = engine.events.filter((event) => event.text === 'quiet hours held desktop notification');
await engine.deliver([], { panes: [] }, 2000, { active: false });
await engine.deliver([], { panes: [] }, 3000, { active: false });
const deadline = Date.now() + 3000;
while ((!fs.existsSync(process.env.HERDR_TEST_CALLS) || fs.readFileSync(process.env.HERDR_TEST_CALLS, 'utf8').trim().split('\\n').length < 1) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
console.log(JSON.stringify({ queued, held, after: engine.memory.quietNotifications, events: engine.events }));
`;
  const env = {
    ...process.env,
    HOME: home,
    HERDR_BOSS_DIR: dataDir,
    HERDR_BOSS_LIVE_DIR: path.join(temp, 'live'),
    HERDR_TEST_CALLS: callsFile,
    ENGINE_URL: new URL('../src/engine.js', import.meta.url).href,
    CONFIG_URL: new URL('../src/config.js', import.meta.url).href,
  };
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' }));
  assert.equal(result.queued.length, 1, 'the notification waits in the queue');
  assert.equal(result.held.length, 1, 'the hold is recorded once');
  assert.equal(result.held[0].title, 'Disk low');
  assert.equal(result.held[0].alertText, 'Disk space is low.', 'the held alert stays in events.jsonl');
  assert.deepEqual(result.after, [], 'the queue clears after delivery');
  assert.equal(fs.readFileSync(callsFile, 'utf8').trim().split('\n').length, 1, 'the notification is shown once');
  assert.ok(result.events.some((event) => event.text === 'Disk low'), 'the notification is logged when it is shown');
});

test('desktop notifications are not held when quiet hours are off or the night is inactive', (t) => {
  const temp = tempDir(t);
  const home = path.join(temp, 'home');
  const dataDir = path.join(temp, 'data');
  const binDir = path.join(home, '.local', 'bin');
  const callsFile = path.join(temp, 'notifications.txt');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const herdr = path.join(binDir, 'herdr');
  fs.writeFileSync(herdr, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$HERDR_TEST_CALLS"\n');
  fs.chmodSync(herdr, 0o700);
  const script = `
import fs from 'node:fs';
const { Engine } = await import(process.env.ENGINE_URL);
const { loadConfig } = await import(process.env.CONFIG_URL);
const engine = new Engine(loadConfig(), { push: false, act: false });
await engine.deliver([{ key: 'a', severity: 'warn', title: 'A', text: 'A' }], { panes: [] }, 1000, { active: true, quietHours: false });
await engine.deliver([{ key: 'b', severity: 'warn', title: 'B', text: 'B' }], { panes: [] }, 2000, { active: false, quietHours: true });
const deadline = Date.now() + 3000;
while ((!fs.existsSync(process.env.HERDR_TEST_CALLS) || fs.readFileSync(process.env.HERDR_TEST_CALLS, 'utf8').trim().split('\\n').length < 2) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
console.log(JSON.stringify({ queue: engine.memory.quietNotifications || [], events: engine.events }));
`;
  const env = {
    ...process.env,
    HOME: home,
    HERDR_BOSS_DIR: dataDir,
    HERDR_BOSS_LIVE_DIR: path.join(temp, 'live'),
    HERDR_TEST_CALLS: callsFile,
    ENGINE_URL: new URL('../src/engine.js', import.meta.url).href,
    CONFIG_URL: new URL('../src/config.js', import.meta.url).href,
  };
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' }));
  assert.deepEqual(result.queue, []);
  assert.equal(fs.readFileSync(callsFile, 'utf8').trim().split('\n').length, 2);
  assert.ok(!result.events.some((event) => event.text === 'quiet hours held desktop notification'));
});

test('night state round trips through the data directory', (t) => {
  const dataDir = tempDir(t);
  assert.deepEqual(readNight({ dataDir, now: NOW }), { active: false });
  writeNight({ active: true, since: new Date(NOW).toISOString(), until: UNTIL, by: 'owner', quietHours: false }, { dataDir });
  const state = readNight({ dataDir, now: NOW });
  assert.equal(state.active, true);
  assert.equal(state.since, new Date(NOW).toISOString());
  assert.equal(Date.parse(state.until), Date.parse(UNTIL));
  assert.equal(state.by, 'owner');
  assert.equal(state.quietHours, false);
  assert.equal(state.active, true);
});

test('a cleared night state reads as not active', (t) => {
  const dataDir = tempDir(t);
  writeNight({ active: true, since: new Date(NOW).toISOString(), until: UNTIL, by: 'owner', quietHours: true }, { dataDir });
  clearNight({ dataDir });
  assert.deepEqual(readNight({ dataDir, now: NOW }), { active: false });
  // A clear on a directory without a state file does nothing.
  clearNight({ dataDir });
  assert.deepEqual(readNight({ dataDir, now: NOW }), { active: false });
});

test('the night state file holds only the owner', (t) => {
  const dataDir = tempDir(t);
  writeNight({ active: true, since: new Date(NOW).toISOString(), until: UNTIL, by: 'owner', quietHours: true }, { dataDir });
  assert.equal(fs.statSync(nightFile(dataDir)).mode & 0o777, 0o600);
  // A second write keeps the mode, because the temporary file is renamed over the old one.
  writeNight({ active: true, since: new Date(NOW).toISOString(), until: UNTIL, by: 'owner', quietHours: true }, { dataDir });
  assert.equal(fs.statSync(nightFile(dataDir)).mode & 0o777, 0o600);
});

test('a night state that passed its end time reads as not active', (t) => {
  const dataDir = tempDir(t);
  writeNight({ active: true, since: new Date(NOW).toISOString(), until: UNTIL, by: 'owner', quietHours: false }, { dataDir });
  assert.equal(readNight({ dataDir, now: Date.parse(UNTIL) - 1 }).active, true);
  assert.deepEqual(readNight({ dataDir, now: Date.parse(UNTIL) }), { active: false });
  assert.deepEqual(readNight({ dataDir, now: Date.parse(UNTIL) + 3600000 }), { active: false });
  // The file stays, so a later task can read the notice marks from it.
  assert.ok(fs.existsSync(nightFile(dataDir)));
});

test('the bulletin names the night end time and the quiet hours', (t) => {
  const dir = tempDir(t);
  assert.ok(dir);
  const label = watchLabel(UNTIL, NOW);
  const off = bulletin({ night: { active: true, since: new Date(NOW).toISOString(), until: UNTIL, by: 'owner', quietHours: false } });
  assert.ok(off.includes(`- Watch until ${label} (Owner away). Work as normal; the Boss handles judgment calls.`), off);
  assert.ok(!off.includes('Quiet hours: on.'), off);
  const on = bulletin({ night: { active: true, since: new Date(NOW).toISOString(), until: UNTIL, by: 'owner', quietHours: true } });
  assert.ok(on.includes(`- Watch until ${label} (Owner away). Work as normal; the Boss handles judgment calls.`), on);
  assert.ok(on.includes('- Quiet hours: on.'), on);
  assert.ok(!bulletin({ night: { active: false } }).includes('Watch until'), 'an inactive state adds no line');
  assert.ok(!bulletin({}).includes('Watch until'), 'a snapshot without a state adds no line');
  // The line comes before the quota and lane lines, so an orchestrator reads it first.
  assert.ok(off.indexOf('Watch until') < off.indexOf('## Quotas'), 'the line stays near the top');
});

test('the engine state carries the stored night state', (t) => {
  const temp = tempDir(t);
  const dataDir = path.join(temp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  // The engine ticks with the real clock, so the end time must be ahead of the real time, not a fixed date.
  writeNight({ active: true, since: new Date(Date.now() - 60000).toISOString(), until: new Date(Date.now() + 3600000).toISOString(), by: 'owner', quietHours: true }, { dataDir });
  const engineUrl = new URL('../src/engine.js', import.meta.url).href;
  const configUrl = new URL('../src/config.js', import.meta.url).href;
  const script = `
import { Engine } from ${JSON.stringify(engineUrl)};
import { loadConfig } from ${JSON.stringify(configUrl)};
const engine = new Engine(loadConfig(), { push: false, act: false, collectors: {
  collectHerdr: async () => ({ panes: [], workspaces: [] }),
  collectMachine: async () => null,
  collectProcesses: async () => new Map(),
  collectQuotas: async () => [],
  collectWorktreeCounts: async () => ({}),
  collectCwdProcesses: async () => [],
  collectMissingWorktreeProcesses: async () => [],
} });
console.log(JSON.stringify((await engine.tick()).night));
`;
  const env = { ...process.env, HOME: temp, HERDR_BOSS_DIR: dataDir, HERDR_BOSS_LIVE_DIR: path.join(temp, 'live'), NODE_TEST_CONTEXT: '1' };
  const state = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' }));
  assert.equal(state.active, true);
  assert.equal(state.quietHours, true);
  assert.equal(state.by, 'owner');
  assert.equal(fs.statSync(nightFile(dataDir)).mode & 0o777, 0o600);
  clearNight({ dataDir });
  const off = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' }));
  assert.deepEqual(off, { active: false });
});

test('the engine and the bulletin pass the night state to machineLimits', () => {
  const engine = fs.readFileSync(new URL('../src/engine.js', import.meta.url), 'utf8');
  const rules = fs.readFileSync(new URL('../src/rules.js', import.meta.url), 'utf8');
  const calls = [...engine.matchAll(/machineLimits\(([^)]*)\)/g), ...rules.matchAll(/machineLimits\(([^)]*\))[^)]*\)/g)].map((m) => m[0]);
  assert.ok(calls.length >= 3, calls.join('\n'));
  for (const call of calls) assert.match(call, /snap\.night/, call);
});

// The night command (V97). The CLI runs as a subprocess with its own data directory.
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

// The same one-line label the CLI prints: the local weekday and time, for example "Tue 07:30".
function nightLabel(iso) {
  return watchLabel(iso);
}

function runNightCli(args, env) {
  return execFileSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function nightCliError(args, env) {
  try {
    runNightCli(args, env);
    return null;
  } catch (error) {
    return { status: error.status, stderr: String(error.stderr) };
  }
}

// A plain terminal: no Herdr pane variables. The Owner runs the command.
function plainNightEnv(dataDir) {
  const env = { ...process.env, HOME: dataDir, HERDR_BOSS_DIR: dataDir };
  delete env.HERDR_ENV;
  delete env.HERDR_PANE_ID;
  delete env.HERDR_WORKSPACE_ID;
  delete env.HERDR_TAB_ID;
  return env;
}

// A stub herdr binary that answers `pane get` with the given label. The CLI finds it on PATH.
function stubHerdr(t, { label, workspaceId }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-night-herdr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const herdr = path.join(dir, 'herdr');
  fs.writeFileSync(herdr, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'pane' && args[1] === 'get') {
  console.log(JSON.stringify({ pane: { pane_id: args[2], workspace_id: ${JSON.stringify(workspaceId)}, label: ${JSON.stringify(label)} } }));
  process.exit(0);
}
process.exit(1);
`);
  fs.chmodSync(herdr, 0o755);
  return dir;
}

function paneNightEnv(t, dataDir, { paneId, workspaceId, label }) {
  const bin = stubHerdr(t, { label, workspaceId });
  return { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: dataDir, HERDR_BOSS_DIR: dataDir, HERDR_ENV: '1', HERDR_PANE_ID: paneId, HERDR_WORKSPACE_ID: workspaceId };
}

test('the default night end time is the next 07:30 local time', () => {
  // Before 07:30 local, the end time is today at 07:30.
  const morning = new Date();
  morning.setHours(6, 0, 0, 0);
  const end = defaultNightUntil({ now: morning });
  const today = new Date(morning);
  today.setHours(7, 30, 0, 0);
  assert.equal(end.getTime(), today.getTime());
  // After 07:30 local, the end time is tomorrow at 07:30.
  const evening = new Date();
  evening.setHours(22, 0, 0, 0);
  const end2 = defaultNightUntil({ now: evening });
  const tomorrow = new Date(evening);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(7, 30, 0, 0);
  assert.equal(end2.getTime(), tomorrow.getTime());
});

test('an HH:MM end time means the next such local time', () => {
  // 22:00 local: 07:30 is tomorrow, across midnight.
  const now = new Date();
  now.setHours(22, 0, 0, 0);
  const end = parseNightUntil('07:30', { now });
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(7, 30, 0, 0);
  assert.equal(end.getTime(), tomorrow.getTime());
  // 06:00 local: 07:30 is today.
  const early = new Date();
  early.setHours(6, 0, 0, 0);
  const end2 = parseNightUntil('07:30', { now: early });
  const today = new Date(early);
  today.setHours(7, 30, 0, 0);
  assert.equal(end2.getTime(), today.getTime());
  // An HH:MM on the last day of a month moves to the first day of the next month.
  const late = new Date(2026, 8, 30, 22, 0, 0, 0);
  const end3 = parseNightUntil('07:30', { now: late });
  assert.equal(end3.getFullYear(), 2026);
  assert.equal(end3.getMonth(), 9);
  assert.equal(end3.getDate(), 1);
  assert.equal(end3.getHours(), 7);
  assert.equal(end3.getMinutes(), 30);
});

test('an ISO end time keeps its own instant', () => {
  const now = new Date();
  const iso = new Date(now.getTime() + 6 * 3600e3).toISOString();
  assert.equal(parseNightUntil(iso, { now }).toISOString(), iso);
  // An offset ISO names the same instant as its UTC form.
  const offset = parseNightUntil('2026-09-29T07:30:00+02:00', { now });
  assert.equal(offset.toISOString(), '2026-09-29T05:30:00.000Z');
});

test('a past end time is refused and a far end time is accepted', () => {
  const now = new Date();
  const past = new Date(now.getTime() - 3600e3);
  assert.throws(() => nightUntil(past.toISOString(), { now }), /in the past/);
  assert.throws(() => nightUntil(now.toISOString(), { now }), /in the past/);
  const far = new Date(now.getTime() + 10 * 24 * 3600e3);
  assert.equal(nightUntil(far.toISOString(), { now }).getTime(), far.getTime(), 'a watch has no maximum length');
  // An HH:MM that already passed today becomes tomorrow, so it stays within 24 hours.
  const earlier = new Date(now.getTime() - 3600e3);
  const hh = String(earlier.getHours()).padStart(2, '0');
  const mm = String(earlier.getMinutes()).padStart(2, '0');
  const end = parseNightUntil(`${hh}:${mm}`, { now });
  assert.ok(end.getTime() > now.getTime());
  assert.ok(end.getTime() <= now.getTime() + 24 * 3600e3);
  // An unparsable value is refused.
  assert.throws(() => parseNightUntil('noon', { now }), /HH:MM, YYYY-MM-DD HH:MM, or an ISO time/);
  assert.throws(() => parseNightUntil('25:00', { now }), /HH:MM, YYYY-MM-DD HH:MM, or an ISO time/);
});

test('night start writes the state and prints the default end time', (t) => {
  const dataDir = tempDir(t);
  const out = runNightCli(['watch', 'start'], plainNightEnv(dataDir));
  assert.match(out, /^On watch until [A-Z][a-z]{2} 07:30\.\n$/);
  const state = JSON.parse(fs.readFileSync(nightFile(dataDir), 'utf8'));
  assert.equal(state.active, true);
  assert.equal(state.by, 'owner');
  assert.equal(state.quietHours, false);
  assert.equal(state.retroAt, undefined, 'the retro stays off by default');
  assert.ok(Number.isFinite(Date.parse(state.since)));
  const until = new Date(state.until);
  assert.equal(until.getHours(), 7);
  assert.equal(until.getMinutes(), 30);
  assert.equal(state.reportAt, state.until, 'the default report time is the night end time');
  assert.ok(until.getTime() > Date.now() - 60000, 'the end time is in the future');
  assert.ok(until.getTime() <= Date.now() + 24 * 3600e3, 'the end time is within 24 hours');
});

test('night start stores report and retro times', (t) => {
  const dataDir = tempDir(t);
  const now = new Date();
  const reportDate = new Date(now.getTime() + 3 * 3600e3);
  const retroDate = new Date(now.getTime() + 4 * 3600e3);
  const report = `${String(reportDate.getHours()).padStart(2, '0')}:${String(reportDate.getMinutes()).padStart(2, '0')}`;
  const retro = `${String(retroDate.getHours()).padStart(2, '0')}:${String(retroDate.getMinutes()).padStart(2, '0')}`;
  runNightCli(['watch', 'start', '--until', '07:30', '--report', report, '--retro', retro], plainNightEnv(dataDir));
  const state = JSON.parse(fs.readFileSync(nightFile(dataDir), 'utf8'));
  const parsed = (value) => {
    const date = new Date(now);
    date.setHours(Number(value.slice(0, 2)), Number(value.slice(3)), 0, 0);
    if (date <= now) date.setDate(date.getDate() + 1);
    return date.toISOString();
  };
  assert.equal(state.reportAt, parsed(report));
  assert.equal(state.retroAt, parsed(retro));
});

test('a night report lists project work, lane use, notices, and alerts within 60 lines', async () => {
  const { renderNightReport } = await import('../src/night-report.js');
  const since = '2026-09-28T18:00:00.000Z';
  const startedAt = '2026-09-28T19:00:00.000Z';
  const workerStartedAt = '2026-09-28T19:20:00.000Z';
  const report = renderNightReport({
    night: { since }, kind: 'report', now: Date.parse('2026-09-28T20:00:00.000Z'),
    projects: [{ slug: 'alpha', project: 'Alpha', workspace: 'w1', tasks: [
      { id: 'T1', title: 'Ship the change', status: 'done', updated: '2026-09-28T19:30:00.000Z' },
      { id: 'T2', title: 'Review the change', status: 'doing', startedAt },
      { id: 'T4', title: 'Check the worker start', status: 'doing', worker: 'w1:p2' },
      { id: 'T3', title: 'Wait for input', status: 'blocked', waitingOn: 'owner' },
      { id: 'T0', title: 'Old work', status: 'done', updated: '2026-09-28T17:59:00.000Z' },
    ] }],
    control: { projects: { alpha: { running: 2 } } },
    herdr: { panes: [{ id: 'w1:p2', workspace: 'w1', agent: 'codex', status: 'working' }] },
    paneSince: { 'w1:p2': { status: 'working', since: Date.parse(workerStartedAt) } },
    usage: [
      { project: 'alpha', provider: 'codex', startedAt, endedAt: '2026-09-28T19:45:00.000Z' },
      { project: 'alpha', provider: 'claude', startedAt, endedAt: '2026-09-28T19:15:00.000Z' },
      { project: 'alpha', provider: 'unmetered', startedAt, endedAt: '2026-09-28T20:00:00.000Z' },
    ],
    events: [
      { type: 'notify', at: '2026-09-28T19:50:00.000Z', project: 'alpha', text: 'Night notice.' },
      { type: 'alert', at: '2026-09-28T19:55:00.000Z', project: 'alpha', text: 'Night alert.' },
      { type: 'notify', at: '2026-09-28T17:00:00.000Z', project: 'alpha', text: 'Earlier notice.' },
    ],
  });
  assert.match(report, /T1 Ship the change: done/);
  const localStart = new Date(startedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  assert.ok(report.includes(`T2 Review the change: in progress, started ${localStart}`));
  const localWorkerStart = new Date(workerStartedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  assert.ok(report.includes(`T4 Check the worker start: in progress, started ${localWorkerStart}`));
  assert.match(report, /T3 Wait for input: blocked, waiting on owner/);
  assert.match(report, /Workers: 2/);
  assert.match(report, /codex 75%/i);
  assert.match(report, /claude 25%/i);
  assert.match(report, /Night notice\./);
  assert.match(report, /Night alert\./);
  assert.doesNotMatch(report, /Old work|Earlier notice|unmetered/);
  assert.ok(report.split('\n').length <= 60, 'the report stays within the line limit');
  const longReport = renderNightReport({
    night: { since }, kind: 'report', now: Date.parse('2026-09-28T20:00:00.000Z'),
    projects: Array.from({ length: 12 }, (_, index) => ({ slug: `project-${index}`, project: `Project ${index}`, tasks: [] })),
  });
  assert.equal(longReport.split('\n').length, 60);
  assert.match(longReport, /Report truncated to 60 lines\.$/);
  const missingStart = renderNightReport({
    night: { since }, now: Date.parse('2026-09-28T20:00:00.000Z'),
    projects: [{ slug: 'alpha', tasks: [{ id: 'T5', title: 'No recorded start', status: 'doing', worker: 'missing' }] }],
  });
  assert.match(missingStart, /T5 No recorded start: in progress, started unknown time/);
});

test('the engine posts each due night report once across a restart', (t) => {
  const temp = tempDir(t);
  const dataDir = path.join(temp, 'data');
  const now = Date.now();
  const since = new Date(now - 60 * 60e3).toISOString();
  const deadline = now + 60 * 1000;
  fs.mkdirSync(dataDir, { recursive: true });
  writeNight({ active: true, since, until: new Date(deadline + 60 * 1000).toISOString(), reportAt: new Date(deadline).toISOString(), retroAt: new Date(deadline).toISOString() }, { dataDir });
  const engineUrl = new URL('../src/engine.js', import.meta.url).href;
  const configUrl = new URL('../src/config.js', import.meta.url).href;
  const nightUrl = new URL('../src/night.js', import.meta.url).href;
  const script = `
import { Engine } from ${JSON.stringify(engineUrl)};
import { loadConfig } from ${JSON.stringify(configUrl)};
import { readNightRecord } from ${JSON.stringify(nightUrl)};
let clockNow = ${now};
Date.now = () => clockNow;
const collectors = {
  collectHerdr: async () => ({ panes: [], workspaces: [] }), collectMachine: async () => null,
  collectProcesses: async () => new Map(), collectQuotas: async () => [], collectWorktreeCounts: async () => ({}),
  collectCwdProcesses: async () => [], collectMissingWorktreeProcesses: async () => [],
  runDenialScan: async ({ state }) => ({ state }), codeSignCloneDir: () => null,
};
const engine = new Engine(loadConfig(), { push: false, act: false, collectors });
await engine.tick();
const before = engine.messageStore.all().filter((item) => item.kind === 'report').length;
clockNow = ${deadline};
await engine.tick();
const atDeadline = engine.messageStore.all().filter((item) => item.kind === 'report');
const restarted = new Engine(loadConfig(), { push: false, act: false, collectors });
await restarted.tick();
const check = new Engine(loadConfig(), { push: false, act: false, collectors });
console.log(JSON.stringify({ before, at: atDeadline, records: check.messageStore.all().filter((item) => item.kind === 'report'), night: readNightRecord() }));
`;
  const env = { ...process.env, HOME: temp, HERDR_BOSS_DIR: dataDir, HERDR_BOSS_LIVE_DIR: path.join(temp, 'live'), NODE_TEST_CONTEXT: '1' };
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' }));
  assert.equal(result.before, 0, 'the service waits for the report time');
  assert.equal(result.records.length, 2);
  assert.deepEqual(result.records.map((item) => item.title).sort(), ['Watch report', 'Watch retro']);
  assert.ok(result.records.every((item) => item.thread === 'boss' && item.to === 'owner'));
  assert.ok(result.records.every((item) => item.at === new Date(deadline).toISOString()));
  assert.ok(result.night.reportSentAt);
  assert.ok(result.night.retroSentAt);
});

test('a daily report of a watch until cancelled posts once a day and arms the next day', (t) => {
  const temp = tempDir(t);
  const dataDir = path.join(temp, 'data');
  const now = Date.now();
  const since = new Date(now - 60 * 60e3).toISOString();
  const deadline = now + 60 * 1000;
  fs.mkdirSync(dataDir, { recursive: true });
  writeNight({ active: true, since, until: null, untilCancelled: true, reportDaily: '07:30', reportAt: new Date(deadline).toISOString() }, { dataDir });
  const engineUrl = new URL('../src/engine.js', import.meta.url).href;
  const configUrl = new URL('../src/config.js', import.meta.url).href;
  const nightUrl = new URL('../src/night.js', import.meta.url).href;
  const script = `
import { Engine } from ${JSON.stringify(engineUrl)};
import { loadConfig } from ${JSON.stringify(configUrl)};
import { readNight, readNightRecord } from ${JSON.stringify(nightUrl)};
let clockNow = ${now};
Date.now = () => clockNow;
const collectors = {
  collectHerdr: async () => ({ panes: [], workspaces: [] }), collectMachine: async () => null,
  collectProcesses: async () => new Map(), collectQuotas: async () => [], collectWorktreeCounts: async () => ({}),
  collectCwdProcesses: async () => [], collectMissingWorktreeProcesses: async () => [],
  runDenialScan: async ({ state }) => ({ state }), codeSignCloneDir: () => null,
};
const reports = (engine) => engine.messageStore.all().filter((item) => item.kind === 'report').length;
const engine = new Engine(loadConfig(), { push: false, act: false, collectors });
const state = await engine.tick();
const before = reports(engine);
const activeBefore = state.night;
clockNow = ${deadline};
await engine.tick();
const first = reports(engine);
const armed = readNightRecord();
await engine.tick();
const again = reports(engine);
clockNow = Date.parse(armed.reportAt);
await engine.tick();
const nextDay = reports(engine);
console.log(JSON.stringify({ before, first, again, nextDay, armed, activeBefore, active: readNight({ now: clockNow }), rearmed: readNightRecord() }));
`;
  const env = { ...process.env, HOME: temp, HERDR_BOSS_DIR: dataDir, HERDR_BOSS_LIVE_DIR: path.join(temp, 'live'), NODE_TEST_CONTEXT: '1' };
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' }));
  assert.equal(result.activeBefore.active, true, 'a watch until cancelled is active');
  assert.equal(result.activeBefore.untilCancelled, true);
  assert.equal(result.before, 0, 'the service waits for the report time');
  assert.equal(result.first, 1, 'the report posts at its time');
  assert.equal(result.again, 1, 'the same report does not post twice');
  assert.equal(result.armed.reportSentAt, undefined, 'the next daily report has no sent mark');
  const nextAt = new Date(result.armed.reportAt);
  assert.ok(nextAt.getTime() > deadline, 'the next report is later');
  assert.equal(nextAt.getHours(), 7);
  assert.equal(nextAt.getMinutes(), 30);
  assert.equal(result.nextDay, 2, 'the report of the next day posts');
  assert.equal(result.active.active, true, 'the watch stays active');
  assert.ok(Date.parse(result.rearmed.reportAt) > Date.parse(result.armed.reportAt));
});

test('a watch that ends at the report time posts the report at the end time', () => {
  const now = new Date(2026, 8, 29, 22, 0, 0);
  const { record } = buildWatchRecord({ until: '07:30', now });
  assert.equal(record.reportAt, record.until, 'the default report time is the end time');
  const set = buildWatchRecord({ until: '07:30', report: '07:00', retro: '06:45', now }).record;
  assert.equal(new Date(set.reportAt).getHours(), 7);
  assert.equal(new Date(set.reportAt).getMinutes(), 0);
  assert.equal(new Date(set.retroAt).getMinutes(), 45);
  assert.equal(set.reportDaily, undefined, 'a fixed watch has one report');
});

test('the default end time is 07:30 today before 07:30 and 07:30 tomorrow from 07:30 on', () => {
  const at = (h, m, s = 0) => new Date(2026, 8, 29, h, m, s);
  const sameDay = defaultNightUntil({ now: at(7, 29, 59) });
  assert.equal(sameDay.getDate(), 29);
  assert.equal(sameDay.getHours() * 60 + sameDay.getMinutes(), 7 * 60 + 30);
  for (const now of [at(7, 30), at(12, 0), at(23, 59)]) {
    const next = defaultNightUntil({ now });
    assert.equal(next.getDate(), 30, `from ${now.toTimeString().slice(0, 5)} the default is tomorrow`);
    assert.equal(next.getHours() * 60 + next.getMinutes(), 7 * 60 + 30);
  }
  assert.equal(defaultNightUntil({ now: at(0, 5) }).getDate(), 29);
});

test('a local date and time is an accepted end time and an impossible date is refused', () => {
  const now = new Date(2026, 8, 29, 12, 0, 0);
  for (const text of ['2026-10-06 08:00', '2026-10-06T08:00']) {
    const end = parseNightUntil(text, { now });
    assert.deepEqual([end.getFullYear(), end.getMonth(), end.getDate(), end.getHours(), end.getMinutes()], [2026, 9, 6, 8, 0]);
  }
  assert.throws(() => parseNightUntil('2026-02-31 08:00', { now }), /not a valid date/);
  assert.throws(() => nightUntil('2026-09-29 11:59', { now }), /in the past/);
  assert.throws(() => nightUntil('2026-09-29 12:00', { now }), /in the past/, 'the present instant is not in the future');
  assert.equal(nightUntil('2026-09-29 12:01', { now }).getMinutes(), 1);
});

test('the watch length is in hours and warns above 48 hours', () => {
  const now = new Date(2026, 8, 29, 12, 0, 0);
  assert.equal(watchHours(new Date(2026, 8, 29, 19, 30), { now }), 7.5);
  assert.equal(watchLengthWarning(new Date(2026, 8, 31, 12, 0), { now }), null, '48 hours has no warning');
  assert.match(watchLengthWarning(new Date(2026, 8, 31, 13, 0), { now }), /lasts 49 hours/);
});

test('a watch until cancelled has no end time and takes only a daily HH:MM report', () => {
  const now = new Date(2026, 8, 29, 12, 0, 0);
  const plain = buildWatchRecord({ untilCancelled: true, now }).record;
  assert.equal(plain.until, null);
  assert.equal(plain.untilCancelled, true);
  assert.equal(plain.reportAt, undefined, 'no report time unless set');
  const daily = buildWatchRecord({ untilCancelled: true, report: '07:30', now }).record;
  assert.equal(daily.reportDaily, '07:30');
  assert.equal(new Date(daily.reportAt).getDate(), 30);
  assert.throws(() => buildWatchRecord({ untilCancelled: true, report: '2026-10-01 07:30', now }), /HH:MM/);
  assert.throws(() => buildWatchRecord({ untilCancelled: true, until: '07:30', now }), /not both/);
  assert.equal(nextDailyTime('07:30', new Date(2026, 8, 30, 7, 30)).getDate(), 1, 'the next daily time is after the given instant');
});

test('watch state files: watch.json replaces an old night.json', (t) => {
  const dataDir = tempDir(t);
  fs.writeFileSync(path.join(dataDir, 'night.json'), JSON.stringify({ active: true, since: new Date(NOW).toISOString(), until: UNTIL, by: 'owner' }));
  assert.equal(readNight({ dataDir, now: NOW }).active, true, 'the old file is read');
  assert.equal(readNightRecord({ dataDir }).by, 'owner');
  writeNight({ active: true, since: new Date(NOW).toISOString(), until: null, untilCancelled: true }, { dataDir });
  assert.ok(fs.existsSync(path.join(dataDir, 'watch.json')));
  assert.ok(!fs.existsSync(path.join(dataDir, 'night.json')), 'the write removes the old file');
  assert.equal(readNight({ dataDir, now: NOW }).untilCancelled, true);
  fs.writeFileSync(path.join(dataDir, 'night.json'), JSON.stringify({ active: true, until: UNTIL }));
  assert.equal(clearNight({ dataDir }), true);
  assert.deepEqual(readNight({ dataDir, now: NOW }), { active: false }, 'a clear removes both files');
});

test('old night config keys still work', async (t) => {
  const { migrateLegacyWatchKeys, validateServiceSettings, serviceSettingsView, writeServiceSettings } = await import('../src/config.js');
  const moved = migrateLegacyWatchKeys({ port: 1, night: { quietHours: true, maxWorkers: 5 }, watch: { maxWorkers: 9 } });
  assert.deepEqual(moved, { port: 1, watch: { quietHours: true, maxWorkers: 9 } }, 'a watch key wins over a night key');
  assert.deepEqual(validateServiceSettings({ 'night.maxWorkers': 7 }), { 'watch.maxWorkers': 7 });
  const view = serviceSettingsView({ night: { maxWorkers: 6 } });
  assert.equal(view.find(({ setting }) => setting === 'watch.maxWorkers').value, 6);
  assert.equal(view.find(({ setting }) => setting === 'watch.maxWorkers').source, 'default', 'a raw cfg carries no source map');
  const dataDir = tempDir(t);
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ night: { quietHours: true } }));
  writeServiceSettings({ 'watch.maxWorkers': 4 }, { dataDir });
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  assert.deepEqual(saved, { watch: { quietHours: true, maxWorkers: 4 } }, 'a save moves the old keys');
});

test('the night command is an alias of watch', (t) => {
  const dataDir = tempDir(t);
  const out = runNightCli(['night', 'start', '--until-cancelled'], plainNightEnv(dataDir));
  assert.equal(out, 'On watch until cancelled.\n');
  const state = JSON.parse(fs.readFileSync(nightFile(dataDir), 'utf8'));
  assert.equal(state.until, null);
  assert.equal(state.reportAt, undefined);
  assert.equal(runNightCli(['night'], plainNightEnv(dataDir)), 'On watch until cancelled (by owner).\n');
  assert.equal(runNightCli(['watch'], plainNightEnv(dataDir)), 'On watch until cancelled (by owner).\n');
  assert.equal(runNightCli(['night', 'stop'], plainNightEnv(dataDir)), 'Watch stopped.\n');
});

test('watch start validates its options', (t) => {
  const dataDir = tempDir(t);
  const cases = [
    [['--until', '2020-01-01 07:30'], /in the past/],
    [['--until', '2026-02-31 07:30'], /not a valid date/],
    [['--until', '07:30', '--until-cancelled'], /not both/],
    [['--until-cancelled', '--report', '2099-01-01 07:30'], /HH:MM/],
  ];
  for (const [args, pattern] of cases) {
    const error = nightCliError(['watch', 'start', ...args], plainNightEnv(dataDir));
    assert.ok(error, `${args.join(' ')} fails`);
    assert.match(error.stderr, pattern);
    assert.ok(!fs.existsSync(nightFile(dataDir)), 'no state file is written');
  }
  const out = runNightCli(['watch', 'start', '--until-cancelled', '--report', '07:30'], plainNightEnv(dataDir));
  assert.equal(out, 'On watch until cancelled.\n');
  assert.equal(JSON.parse(fs.readFileSync(nightFile(dataDir), 'utf8')).reportDaily, '07:30');
});

test('the start notice names the end time or says until cancelled', async () => {
  const { nightNoticeText } = await import('../src/engine.js');
  assert.equal(nightNoticeText('start', { until: UNTIL }), `[herdr-boss] Watch until ${watchLabel(UNTIL)}. The Owner is away; the Boss acts for the Owner. Work as normal. Escalate to the Boss.`);
  assert.equal(nightNoticeText('start', { until: null, untilCancelled: true }), '[herdr-boss] Watch until cancelled. The Owner is away; the Boss acts for the Owner. Work as normal. Escalate to the Boss.');
  assert.equal(nightNoticeText('end', {}), '[herdr-boss] Watch ended. The Owner rules apply again.');
});

test('watch labels show the weekday, and the date when the time is far away', () => {
  const now = new Date(2026, 8, 29, 12, 0, 0).getTime();
  assert.match(watchLabel(new Date(2026, 8, 30, 7, 30).toISOString(), now), /^Wed 07:30$/);
  assert.match(watchLabel(new Date(2026, 9, 20, 7, 30).toISOString(), now), /^Tue 20 Oct 07:30$/);
});

test('night start --until HH:MM writes the next such local time', (t) => {
  const dataDir = tempDir(t);
  const out = runNightCli(['watch', 'start', '--until', '07:30'], plainNightEnv(dataDir));
  assert.match(out, /^On watch until [A-Z][a-z]{2} 07:30\.\n$/);
  const state = JSON.parse(fs.readFileSync(nightFile(dataDir), 'utf8'));
  const until = new Date(state.until);
  assert.equal(until.getHours(), 7);
  assert.equal(until.getMinutes(), 30);
  assert.ok(until.getTime() > Date.now() - 60000, 'the end time is in the future');
  assert.ok(until.getTime() <= Date.now() + 24 * 3600e3, 'the end time is within 24 hours');
});

test('night start --until ISO writes that instant', (t) => {
  const dataDir = tempDir(t);
  const until = new Date(Date.now() + 6 * 3600e3);
  const out = runNightCli(['watch', 'start', '--until', until.toISOString()], plainNightEnv(dataDir));
  assert.match(out, /^On watch until [A-Z][a-z]{2} \d{2}:\d{2}\.\n$/);
  const state = JSON.parse(fs.readFileSync(nightFile(dataDir), 'utf8'));
  assert.equal(state.until, until.toISOString());
});

test('night start --until ISO with an offset writes the same instant', (t) => {
  const dataDir = tempDir(t);
  const until = new Date(Date.now() + 6 * 3600e3);
  // Express the same instant at a +02:00 offset.
  const text = new Date(until.getTime() + 2 * 3600e3).toISOString().replace('Z', '+02:00');
  const out = runNightCli(['watch', 'start', '--until', text], plainNightEnv(dataDir));
  assert.match(out, /^On watch until /);
  const state = JSON.parse(fs.readFileSync(nightFile(dataDir), 'utf8'));
  assert.equal(state.until, until.toISOString());
});

test('night start --quiet-hours stores quiet hours', (t) => {
  const dataDir = tempDir(t);
  const out = runNightCli(['watch', 'start', '--quiet-hours'], plainNightEnv(dataDir));
  assert.match(out, /^On watch until [A-Z][a-z]{2} 07:30\.\n$/);
  const state = JSON.parse(fs.readFileSync(nightFile(dataDir), 'utf8'));
  assert.equal(state.quietHours, true);
});

test('night start uses the config quiet-hours default and explicit CLI flags take precedence', (t) => {
  for (const defaultValue of [true, false]) {
    const dataDir = tempDir(t);
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ night: { quietHours: defaultValue } }));
    const env = plainNightEnv(dataDir);
    runNightCli(['watch', 'start'], env);
    assert.equal(JSON.parse(fs.readFileSync(nightFile(dataDir), 'utf8')).quietHours, defaultValue, `default ${defaultValue}`);
    clearNight({ dataDir });

    const override = defaultValue ? '--no-quiet-hours' : '--quiet-hours';
    runNightCli(['watch', 'start', override], env);
    assert.equal(JSON.parse(fs.readFileSync(nightFile(dataDir), 'utf8')).quietHours, !defaultValue, `${override} overrides ${defaultValue}`);
  }
});

test('POST /api/watch/start uses the config quiet-hours default and an explicit body value takes precedence', (t) => {
  for (const defaultValue of [true, false]) {
    const temp = tempDir(t);
    const home = path.join(temp, 'home');
    const dataDir = path.join(temp, 'data');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ port: 0, host: '127.0.0.1', night: { quietHours: defaultValue } }));
    const script = `
const { serve } = await import(process.env.SERVER_URL);
const { loadConfig } = await import(process.env.CONFIG_URL);
const { Engine } = await import(process.env.ENGINE_URL);
console.log = () => {};
const collectors = {
  collectHerdr: async () => ({ panes: [], workspaces: [] }),
  collectMachine: async () => null,
  collectProcesses: async () => new Map(),
  collectQuotas: async () => [],
  collectWorktreeCounts: async () => ({}),
  collectCwdProcesses: async () => [],
  collectMissingWorktreeProcesses: async () => [],
  collectPiModels: async () => ({ models: [] }),
};
const cfg = loadConfig();
const app = serve(cfg, { createEngine: (config, options) => new Engine(config, { ...options, collectors }) });
try {
  if (!app.server.listening) await new Promise((resolve, reject) => {
    app.server.once('listening', resolve);
    app.server.once('error', reject);
  });
  const address = app.server.address();
  const values = [];
  for (const body of [{}, { quietHours: !cfg.watch.quietHours }, { quietHours: cfg.watch.quietHours }]) {
    const response = await fetch('http://127.0.0.1:' + address.port + '/api/watch/start', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const result = await response.json();
    values.push({ status: response.status, quietHours: result.night?.quietHours });
  }
  process.stdout.write(JSON.stringify(values));
} finally {
  await app.close();
}
`;
    const env = {
      ...process.env,
      HOME: home,
      HERDR_BOSS_DIR: dataDir,
      HERDR_BOSS_LIVE_DIR: path.join(temp, 'live'),
      NODE_TEST_CONTEXT: '1',
      SERVER_URL: new URL('../src/server.js', import.meta.url).href,
      CONFIG_URL: new URL('../src/config.js', import.meta.url).href,
      ENGINE_URL: new URL('../src/engine.js', import.meta.url).href,
    };
    const results = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 20000 }));
    assert.deepEqual(results, [
      { status: 200, quietHours: defaultValue },
      { status: 200, quietHours: !defaultValue },
      { status: 200, quietHours: defaultValue },
    ], `config default ${defaultValue}`);
  }
});

test('night start refuses a past end time', (t) => {
  const dataDir = tempDir(t);
  const past = new Date(Date.now() - 3600e3).toISOString();
  const error = nightCliError(['watch', 'start', '--until', past], plainNightEnv(dataDir));
  assert.ok(error, 'the command fails');
  assert.equal(error.status, 1);
  assert.match(error.stderr, /in the past/);
  assert.ok(!fs.existsSync(nightFile(dataDir)), 'no state file is written');
});

test('watch start accepts an end time more than 24 hours ahead and warns above 48 hours', (t) => {
  const dataDir = tempDir(t);
  const soon = new Date(Date.now() + 30 * 3600e3).toISOString();
  const out = runNightCli(['watch', 'start', '--until', soon], plainNightEnv(dataDir));
  assert.match(out, /^On watch until [A-Z][a-z]{2} \d{2}:\d{2}\.\n$/, 'no warning at 30 hours');
  assert.equal(JSON.parse(fs.readFileSync(nightFile(dataDir), 'utf8')).until, soon);
  const far = new Date(Date.now() + 72 * 3600e3).toISOString();
  const long = runNightCli(['watch', 'start', '--until', far], plainNightEnv(dataDir));
  assert.match(long, /Warning: This watch lasts 7\d(\.\d)? hours\./);
});

test('night start refuses an unknown option', (t) => {
  const dataDir = tempDir(t);
  const error = nightCliError(['watch', 'start', '--bogus'], plainNightEnv(dataDir));
  assert.ok(error, 'the command fails');
  assert.match(error.stderr, /Unknown option/);
  assert.ok(!fs.existsSync(nightFile(dataDir)), 'no state file is written');
});

test('night refuses an unknown action', (t) => {
  const dataDir = tempDir(t);
  const error = nightCliError(['watch', 'bogus'], plainNightEnv(dataDir));
  assert.ok(error, 'the command fails');
  assert.match(error.stderr, /Usage: watch/);
});

test('night start refuses an orchestrator caller', (t) => {
  const dataDir = tempDir(t);
  const env = paneNightEnv(t, dataDir, { paneId: 'ws-proj:p1', workspaceId: 'ws-proj', label: 'orch' });
  const error = nightCliError(['watch', 'start'], env);
  assert.ok(error, 'the command fails');
  assert.equal(error.status, 1);
  assert.match(error.stderr, /pane labeled boss/);
  assert.match(error.stderr, /orch/);
  assert.ok(!fs.existsSync(nightFile(dataDir)), 'no state file is written');
});

test('night stop refuses an orchestrator caller', (t) => {
  const dataDir = tempDir(t);
  const env = paneNightEnv(t, dataDir, { paneId: 'ws-proj:p1', workspaceId: 'ws-proj', label: 'orch' });
  const error = nightCliError(['watch', 'stop'], env);
  assert.ok(error, 'the command fails');
  assert.match(error.stderr, /pane labeled boss/);
});

test('night start refuses a worker caller', (t) => {
  const dataDir = tempDir(t);
  const env = paneNightEnv(t, dataDir, { paneId: 'ws-proj:p9', workspaceId: 'ws-proj', label: 'worker' });
  const error = nightCliError(['watch', 'start'], env);
  assert.ok(error, 'the command fails');
  assert.match(error.stderr, /pane labeled boss/);
  assert.ok(!fs.existsSync(nightFile(dataDir)), 'no state file is written');
});

test('the Boss pane may start night watch', (t) => {
  const dataDir = tempDir(t);
  const env = paneNightEnv(t, dataDir, { paneId: 'ws-boss:p1', workspaceId: 'ws-boss', label: 'boss' });
  const out = runNightCli(['watch', 'start'], env);
  assert.match(out, /^On watch until [A-Z][a-z]{2} 07:30\.\n$/);
  const state = JSON.parse(fs.readFileSync(nightFile(dataDir), 'utf8'));
  assert.equal(state.by, 'boss');
});

test('night stop clears the state and prints one line', (t) => {
  const dataDir = tempDir(t);
  runNightCli(['watch', 'start'], plainNightEnv(dataDir));
  assert.ok(fs.existsSync(nightFile(dataDir)));
  const out = runNightCli(['watch', 'stop'], plainNightEnv(dataDir));
  assert.equal(out, 'Watch stopped.\n');
  assert.ok(!fs.existsSync(nightFile(dataDir)));
});

test('night prints the current state in one line', (t) => {
  const dataDir = tempDir(t);
  assert.equal(runNightCli(['watch'], plainNightEnv(dataDir)), 'No watch.\n');
  const until = new Date(Date.now() + 6 * 3600e3);
  writeNight({ active: true, since: new Date().toISOString(), until: until.toISOString(), by: 'owner', quietHours: false }, { dataDir });
  const out = runNightCli(['watch'], plainNightEnv(dataDir));
  assert.equal(out, `On watch until ${nightLabel(until.toISOString())} (by owner).\n`);
});

test('a pane without HERDR_ENV but with its pane ID is not treated as the Owner', (t) => {
  const dataDir = tempDir(t);
  const env = { ...plainNightEnv(dataDir), HERDR_PANE_ID: 'ws:worker', PATH: path.join(dataDir, 'no-herdr-bin') };
  const error = nightCliError(['watch', 'start', '--until', '07:30'], env);
  assert.ok(error, 'the command fails');
  assert.ok(!fs.existsSync(nightFile(dataDir)), 'no state file is written');
});

test('a notice mark is stored per pane and keeps the other keys', () => {
  const base = { active: true, since: new Date(NOW).toISOString(), until: UNTIL, by: 'owner', quietHours: true };
  const marked = withNoticeMark(base, 'start', 'w1:p1', new Date(NOW).toISOString());
  assert.deepEqual(marked.noticeStartAt, { 'w1:p1': new Date(NOW).toISOString() });
  assert.equal(marked.until, UNTIL, 'the end time stays as it is');
  assert.equal(marked.quietHours, true, 'the quiet hours stay as they are');
  assert.equal(base.noticeStartAt, undefined, 'the stored record is not changed');
  const two = withNoticeMark(marked, 'start', 'w2:p1', new Date(NOW + 1).toISOString());
  assert.deepEqual(Object.keys(two.noticeStartAt), ['w1:p1', 'w2:p1'], 'a second pane adds a mark');
  const stopped = withNoticeMark(two, 'end', 'w1:p1', new Date(NOW + 2).toISOString());
  assert.equal(Object.keys(stopped.noticeStopAt).length, 1, 'the end marks are a separate key');
  assert.deepEqual([...nightNoticeSent(stopped, 'start')], ['w1:p1', 'w2:p1'], 'the start marks name both panes');
  assert.deepEqual([...nightNoticeSent(stopped, 'end')], ['w1:p1'], 'the end marks name the pane that got the notice');
  assert.throws(() => nightNoticeSent(stopped, 'middle'), TypeError, 'an unknown phase is a caller error');
  assert.throws(() => withNoticeMark(base, 'middle', 'w1:p1', new Date(NOW).toISOString()), TypeError);
});

test('a mark from before the night started does not count', () => {
  const record = { active: true, since: new Date(NOW).toISOString(), until: UNTIL,
    noticeStartAt: { 'w1:p1': new Date(NOW - 1).toISOString(), 'w2:p1': new Date(NOW).toISOString() } };
  assert.deepEqual([...nightNoticeSent(record, 'start')], ['w2:p1'], 'the earlier mark belongs to an earlier night');
  assert.deepEqual([...nightNoticeSent({ active: true, startedAt: record.since, noticeStopAt: { 'w9:p9': record.noticeStartAt['w1:p1'] } }, 'end')], [],
    'a record without a start time takes every mark');
  assert.deepEqual([...nightNoticeSent(null, 'start')], [], 'a missing record has no marks');
  assert.deepEqual([...nightNoticeSent({ active: true, noticeStartAt: [] }, 'start')], [], 'a broken mark key has no marks');
});

test('the stored record reads back with its notice marks', (t) => {
  const dataDir = tempDir(t);
  assert.equal(readNightRecord({ dataDir }), null, 'a directory without a state file has no record');
  writeNight(withNoticeMark({ active: true, since: new Date(NOW).toISOString(), until: UNTIL, by: 'owner', quietHours: false },
    'start', 'w1:p1', new Date(NOW).toISOString()), { dataDir });
  const record = readNightRecord({ dataDir });
  assert.equal(record.noticeStartAt['w1:p1'], new Date(NOW).toISOString());
  assert.equal(readNight({ dataDir, now: NOW }).until, new Date(UNTIL).toISOString(), 'the read state still works');
  clearNight({ dataDir });
  assert.equal(readNightRecord({ dataDir }), null, 'a cleared state file has no record');
});
