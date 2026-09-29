import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { clearNight, defaultNightUntil, nightFile, nightUntil, parseNightUntil, readNight, writeNight } from '../src/night.js';
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
  const label = new Date(UNTIL).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const off = bulletin({ night: { active: true, since: new Date(NOW).toISOString(), until: UNTIL, by: 'owner', quietHours: false } });
  assert.ok(off.includes(`- Night watch until ${label} (Owner away). Work as normal; the Boss handles judgment calls.`), off);
  assert.ok(!off.includes('Quiet hours: on.'), off);
  const on = bulletin({ night: { active: true, since: new Date(NOW).toISOString(), until: UNTIL, by: 'owner', quietHours: true } });
  assert.ok(on.includes(`- Night watch until ${label} (Owner away). Work as normal; the Boss handles judgment calls.`), on);
  assert.ok(on.includes('- Quiet hours: on.'), on);
  assert.ok(!bulletin({ night: { active: false } }).includes('Night watch'), 'an inactive state adds no line');
  assert.ok(!bulletin({}).includes('Night watch'), 'a snapshot without a state adds no line');
  // The line comes before the quota and lane lines, so an orchestrator reads it first.
  assert.ok(off.indexOf('Night watch until') < off.indexOf('## Quotas'), 'the line stays near the top');
});

test('the engine state carries the stored night state', (t) => {
  const temp = tempDir(t);
  const dataDir = path.join(temp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  writeNight({ active: true, since: new Date(NOW).toISOString(), until: UNTIL, by: 'owner', quietHours: true }, { dataDir });
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
  const date = new Date(iso);
  const day = new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(date);
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(date);
  return `${day} ${time}`;
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

test('a past or far end time is refused', () => {
  const now = new Date();
  const past = new Date(now.getTime() - 3600e3);
  assert.throws(() => nightUntil(past.toISOString(), { now }), /in the past/);
  const far = new Date(now.getTime() + 25 * 3600e3);
  assert.throws(() => nightUntil(far.toISOString(), { now }), /24 hours/);
  // An HH:MM that already passed today becomes tomorrow, so it stays within 24 hours.
  const earlier = new Date(now.getTime() - 3600e3);
  const hh = String(earlier.getHours()).padStart(2, '0');
  const mm = String(earlier.getMinutes()).padStart(2, '0');
  const end = parseNightUntil(`${hh}:${mm}`, { now });
  assert.ok(end.getTime() > now.getTime());
  assert.ok(end.getTime() <= now.getTime() + 24 * 3600e3);
  // An unparsable value is refused.
  assert.throws(() => parseNightUntil('noon', { now }), /HH:MM or an ISO time/);
  assert.throws(() => parseNightUntil('25:00', { now }), /HH:MM or an ISO time/);
});

test('night start writes the state and prints the default end time', (t) => {
  const dataDir = tempDir(t);
  const out = runNightCli(['night', 'start'], plainNightEnv(dataDir));
  assert.match(out, /^Night watch until [A-Z][a-z]{2} 07:30\.\n$/);
  const state = JSON.parse(fs.readFileSync(nightFile(dataDir), 'utf8'));
  assert.equal(state.active, true);
  assert.equal(state.by, 'owner');
  assert.equal(state.quietHours, false);
  assert.ok(Number.isFinite(Date.parse(state.since)));
  const until = new Date(state.until);
  assert.equal(until.getHours(), 7);
  assert.equal(until.getMinutes(), 30);
  assert.ok(until.getTime() > Date.now() - 60000, 'the end time is in the future');
  assert.ok(until.getTime() <= Date.now() + 24 * 3600e3, 'the end time is within 24 hours');
});

test('night start --until HH:MM writes the next such local time', (t) => {
  const dataDir = tempDir(t);
  const out = runNightCli(['night', 'start', '--until', '07:30'], plainNightEnv(dataDir));
  assert.match(out, /^Night watch until [A-Z][a-z]{2} 07:30\.\n$/);
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
  const out = runNightCli(['night', 'start', '--until', until.toISOString()], plainNightEnv(dataDir));
  assert.match(out, /^Night watch until [A-Z][a-z]{2} \d{2}:\d{2}\.\n$/);
  const state = JSON.parse(fs.readFileSync(nightFile(dataDir), 'utf8'));
  assert.equal(state.until, until.toISOString());
});

test('night start --until ISO with an offset writes the same instant', (t) => {
  const dataDir = tempDir(t);
  const until = new Date(Date.now() + 6 * 3600e3);
  // Express the same instant at a +02:00 offset.
  const text = new Date(until.getTime() + 2 * 3600e3).toISOString().replace('Z', '+02:00');
  const out = runNightCli(['night', 'start', '--until', text], plainNightEnv(dataDir));
  assert.match(out, /^Night watch until /);
  const state = JSON.parse(fs.readFileSync(nightFile(dataDir), 'utf8'));
  assert.equal(state.until, until.toISOString());
});

test('night start --quiet-hours stores quiet hours', (t) => {
  const dataDir = tempDir(t);
  const out = runNightCli(['night', 'start', '--quiet-hours'], plainNightEnv(dataDir));
  assert.match(out, /^Night watch until [A-Z][a-z]{2} 07:30\.\n$/);
  const state = JSON.parse(fs.readFileSync(nightFile(dataDir), 'utf8'));
  assert.equal(state.quietHours, true);
});

test('night start refuses a past end time', (t) => {
  const dataDir = tempDir(t);
  const past = new Date(Date.now() - 3600e3).toISOString();
  const error = nightCliError(['night', 'start', '--until', past], plainNightEnv(dataDir));
  assert.ok(error, 'the command fails');
  assert.equal(error.status, 1);
  assert.match(error.stderr, /in the past/);
  assert.ok(!fs.existsSync(nightFile(dataDir)), 'no state file is written');
});

test('night start refuses an end time more than 24 hours ahead', (t) => {
  const dataDir = tempDir(t);
  const far = new Date(Date.now() + 25 * 3600e3).toISOString();
  const error = nightCliError(['night', 'start', '--until', far], plainNightEnv(dataDir));
  assert.ok(error, 'the command fails');
  assert.equal(error.status, 1);
  assert.match(error.stderr, /24 hours/);
  assert.ok(!fs.existsSync(nightFile(dataDir)), 'no state file is written');
});

test('night start refuses an unknown option', (t) => {
  const dataDir = tempDir(t);
  const error = nightCliError(['night', 'start', '--bogus'], plainNightEnv(dataDir));
  assert.ok(error, 'the command fails');
  assert.match(error.stderr, /Unknown option/);
  assert.ok(!fs.existsSync(nightFile(dataDir)), 'no state file is written');
});

test('night refuses an unknown action', (t) => {
  const dataDir = tempDir(t);
  const error = nightCliError(['night', 'bogus'], plainNightEnv(dataDir));
  assert.ok(error, 'the command fails');
  assert.match(error.stderr, /Usage: night/);
});

test('night start refuses an orchestrator caller', (t) => {
  const dataDir = tempDir(t);
  const env = paneNightEnv(t, dataDir, { paneId: 'ws-proj:p1', workspaceId: 'ws-proj', label: 'orch' });
  const error = nightCliError(['night', 'start'], env);
  assert.ok(error, 'the command fails');
  assert.equal(error.status, 1);
  assert.match(error.stderr, /pane labeled boss/);
  assert.match(error.stderr, /orch/);
  assert.ok(!fs.existsSync(nightFile(dataDir)), 'no state file is written');
});

test('night stop refuses an orchestrator caller', (t) => {
  const dataDir = tempDir(t);
  const env = paneNightEnv(t, dataDir, { paneId: 'ws-proj:p1', workspaceId: 'ws-proj', label: 'orch' });
  const error = nightCliError(['night', 'stop'], env);
  assert.ok(error, 'the command fails');
  assert.match(error.stderr, /pane labeled boss/);
});

test('night start refuses a worker caller', (t) => {
  const dataDir = tempDir(t);
  const env = paneNightEnv(t, dataDir, { paneId: 'ws-proj:p9', workspaceId: 'ws-proj', label: 'worker' });
  const error = nightCliError(['night', 'start'], env);
  assert.ok(error, 'the command fails');
  assert.match(error.stderr, /pane labeled boss/);
  assert.ok(!fs.existsSync(nightFile(dataDir)), 'no state file is written');
});

test('the Boss pane may start night watch', (t) => {
  const dataDir = tempDir(t);
  const env = paneNightEnv(t, dataDir, { paneId: 'ws-boss:p1', workspaceId: 'ws-boss', label: 'boss' });
  const out = runNightCli(['night', 'start'], env);
  assert.match(out, /^Night watch until [A-Z][a-z]{2} 07:30\.\n$/);
  const state = JSON.parse(fs.readFileSync(nightFile(dataDir), 'utf8'));
  assert.equal(state.by, 'boss');
});

test('night stop clears the state and prints one line', (t) => {
  const dataDir = tempDir(t);
  runNightCli(['night', 'start'], plainNightEnv(dataDir));
  assert.ok(fs.existsSync(nightFile(dataDir)));
  const out = runNightCli(['night', 'stop'], plainNightEnv(dataDir));
  assert.equal(out, 'Night watch stopped.\n');
  assert.ok(!fs.existsSync(nightFile(dataDir)));
});

test('night prints the current state in one line', (t) => {
  const dataDir = tempDir(t);
  assert.equal(runNightCli(['night'], plainNightEnv(dataDir)), 'No night watch.\n');
  const until = new Date(Date.now() + 6 * 3600e3);
  writeNight({ active: true, since: new Date().toISOString(), until: until.toISOString(), by: 'owner', quietHours: false }, { dataDir });
  const out = runNightCli(['night'], plainNightEnv(dataDir));
  assert.equal(out, `Night watch until ${nightLabel(until.toISOString())} (by owner).\n`);
});

test('a pane without HERDR_ENV but with its pane ID is not treated as the Owner', (t) => {
  const dataDir = tempDir(t);
  const env = { ...plainNightEnv(dataDir), HERDR_PANE_ID: 'ws:worker', PATH: path.join(dataDir, 'no-herdr-bin') };
  const error = nightCliError(['night', 'start', '--until', '07:30'], env);
  assert.ok(error, 'the command fails');
  assert.ok(!fs.existsSync(nightFile(dataDir)), 'no state file is written');
});
