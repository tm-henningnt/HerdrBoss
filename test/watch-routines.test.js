import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildWatchRecord, writeNight, readNightRecord } from '../src/night.js';
import { nightNoticeText } from '../src/engine.js';
import { kitRevision } from '../src/kit/agents-check.js';
import {
  armRoutines, cleanAdhoc, effectiveRoutines, loadKitRoutines, parseRoutineText, rememberChoice, resetRoutine, routinePromptText, saveRoutine,
} from '../src/watch-routines.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KIT_WATCH = path.join(repo, 'kit', 'watch');
const MIN = 60000;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-watch-routines-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the kit holds the three default routines with a schedule and a model hint', () => {
  const routines = loadKitRoutines(repo);
  assert.deepEqual(routines.map((r) => r.id), ['hourly-check', 'morning-retro', 'morning-summary']);
  assert.deepEqual(routines.map((r) => r.title), ['Hourly check', 'Morning retrospective', 'Morning summary and report']);
  assert.equal(routines[0].every, 60);
  assert.equal(routines[1].beforeEnd, '01:00');
  assert.equal(routines[2].beforeEnd, '00:10');
  for (const routine of routines) {
    assert.ok(routine.model, `${routine.id} has a model hint`);
    assert.ok(routine.prompt.length > 100, `${routine.id} has a prompt`);
  }
});

test('the kit routine texts hold no private name, path, figure, or model code name', () => {
  const banned = [/\/Users\//, /~\//, /\.herdr-boss/, /https?:\/\//, /\d+\s?%/, /tenant/i, /tallmaker/i, /qlik/i, /\bAstra\b/, /\bFable\b/, /\bLuna\b/, /\bSol\b/, /\bE\d\b/, /@[a-z]+\./i];
  const files = fs.readdirSync(KIT_WATCH).filter((name) => name.endsWith('.md'));
  assert.equal(files.length, 3);
  for (const file of files) {
    const text = fs.readFileSync(path.join(KIT_WATCH, file), 'utf8');
    for (const pattern of banned) assert.ok(!pattern.test(text), `${file} matches ${pattern}`);
  }
});

test('a routine file needs a title and exactly one schedule', () => {
  assert.throws(() => parseRoutineText('---\ntitle: A\n---\nText.', 'a'), /schedule/);
  assert.throws(() => parseRoutineText('---\ntitle: A\nevery: 30\nbeforeEnd: 01:00\n---\nText.', 'a'), /one schedule/);
  assert.throws(() => parseRoutineText('---\nevery: 30\n---\nText.', 'a'), /title/);
  assert.throws(() => parseRoutineText('---\ntitle: A\nevery: 0\n---\nText.', 'a'), /every/);
  assert.throws(() => parseRoutineText('---\ntitle: A\nbeforeEnd: 00:01\n---\nText.', 'a'), /beforeEnd/);
  assert.throws(() => parseRoutineText('No front matter.', 'a'), /front matter/);
  const ok = parseRoutineText('---\ntitle: A\nevery: 15\nmodel: cheap\n---\nDo the work.\n', 'a');
  assert.deepEqual({ id: ok.id, every: ok.every, model: ok.model, prompt: ok.prompt }, { id: 'a', every: 15, model: 'cheap', prompt: 'Do the work.' });
});

test('an Owner override replaces the kit text and a reset restores it', (t) => {
  const dataDir = tempDir(t);
  const kit = loadKitRoutines(repo).find((r) => r.id === 'hourly-check');
  saveRoutine('hourly-check', { prompt: 'Own text.', every: 30 }, { dataDir, kitRoot: repo });
  const changed = effectiveRoutines({ dataDir, kitRoot: repo }).find((r) => r.id === 'hourly-check');
  assert.equal(changed.prompt, 'Own text.');
  assert.equal(changed.every, 30);
  assert.equal(changed.source, 'override');
  assert.equal(changed.title, kit.title);
  // The kit file stays as it is.
  assert.equal(loadKitRoutines(repo).find((r) => r.id === 'hourly-check').prompt, kit.prompt);
  resetRoutine('hourly-check', { dataDir });
  const back = effectiveRoutines({ dataDir, kitRoot: repo }).find((r) => r.id === 'hourly-check');
  assert.equal(back.prompt, kit.prompt);
  assert.equal(back.source, 'kit');
  const mode = fs.statSync(path.join(dataDir, 'watch-routines.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('an Owner routine that has no kit file needs a prompt and a schedule', (t) => {
  const dataDir = tempDir(t);
  assert.throws(() => saveRoutine('own-check', { title: 'Own check', prompt: 'Text.' }, { dataDir, kitRoot: repo }), /schedule/);
  assert.throws(() => saveRoutine('Bad Id', { title: 'X', prompt: 'Text.', every: 10 }, { dataDir, kitRoot: repo }), /id/);
  saveRoutine('own-check', { title: 'Own check', prompt: 'Text.', every: 10 }, { dataDir, kitRoot: repo });
  const own = effectiveRoutines({ dataDir, kitRoot: repo }).find((r) => r.id === 'own-check');
  assert.equal(own.source, 'custom');
});

test('a watch arms the enabled routines with their next run', (t) => {
  const dataDir = tempDir(t);
  const now = new Date('2026-09-30T22:00:00Z');
  const { record } = buildWatchRecord({ until: '2026-10-01T06:00:00Z', now, dataDir, kitRoot: repo });
  const byId = Object.fromEntries(record.routines.map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(byId), ['hourly-check', 'morning-retro', 'morning-summary']);
  assert.equal(byId['hourly-check'].nextAt, new Date(now.getTime() + 60 * MIN).toISOString());
  assert.equal(byId['morning-retro'].nextAt, '2026-10-01T05:00:00.000Z');
  assert.equal(byId['morning-summary'].nextAt, '2026-10-01T05:50:00.000Z');
  assert.equal(byId['hourly-check'].lastAt, null);
  assert.equal(record.routines.every((r) => !('prompt' in r)), true, 'the record holds no prompt text');
});

test('the choice of a watch turns routines off, sets a schedule, and stores the ad-hoc text', (t) => {
  const dataDir = tempDir(t);
  const now = new Date('2026-09-30T22:00:00Z');
  const { record } = buildWatchRecord({
    until: '2026-10-01T06:00:00Z', now, dataDir, kitRoot: repo,
    routines: { 'hourly-check': { enabled: true, every: 20 }, 'morning-retro': { enabled: false }, 'morning-summary': { beforeEnd: '00:30' } },
    adhoc: 'Skip the kit checks.\nTonight only.',
  });
  assert.deepEqual(record.routines.map((r) => r.id), ['hourly-check', 'morning-summary']);
  assert.equal(record.routines[0].every, 20);
  assert.equal(record.routines[0].nextAt, new Date(now.getTime() + 20 * MIN).toISOString());
  assert.equal(record.routines[1].nextAt, '2026-10-01T05:30:00.000Z');
  assert.equal(record.adhoc, 'Skip the kit checks.\nTonight only.');
  assert.throws(() => buildWatchRecord({ until: '2026-10-01T06:00:00Z', now, dataDir, kitRoot: repo, routines: { 'hourly-check': { every: 0 } } }), /every/);
  assert.throws(() => buildWatchRecord({ until: '2026-10-01T06:00:00Z', now, dataDir, kitRoot: repo, routines: { nope: { enabled: true } } }), /unknown routine/i);
  assert.throws(() => buildWatchRecord({ until: '2026-10-01T06:00:00Z', now, dataDir, kitRoot: repo, adhoc: 'x'.repeat(2001) }), /2000/);
});

test('the last choice is the default of the next watch', (t) => {
  const dataDir = tempDir(t);
  const now = new Date('2026-09-30T22:00:00Z');
  rememberChoice({ 'hourly-check': { enabled: false }, 'morning-retro': { enabled: true, beforeEnd: '02:00' } }, { dataDir, kitRoot: repo });
  const { record } = buildWatchRecord({ until: '2026-10-01T06:00:00Z', now, dataDir, kitRoot: repo });
  assert.deepEqual(record.routines.map((r) => r.id), ['morning-retro', 'morning-summary']);
  assert.equal(record.routines[0].nextAt, '2026-10-01T04:00:00.000Z');
  const view = effectiveRoutines({ dataDir, kitRoot: repo });
  assert.equal(view.find((r) => r.id === 'hourly-check').enabled, false);
  assert.equal(view.find((r) => r.id === 'morning-retro').beforeEnd, '02:00');
});

test('a routine that is relative to the end has no run in a watch until cancelled or past the start', (t) => {
  const dataDir = tempDir(t);
  const now = new Date('2026-09-30T22:00:00Z');
  const forever = buildWatchRecord({ untilCancelled: true, now, dataDir, kitRoot: repo }).record;
  assert.equal(forever.routines.find((r) => r.id === 'morning-retro').nextAt, null);
  assert.ok(forever.routines.find((r) => r.id === 'hourly-check').nextAt);
  const short = buildWatchRecord({ until: '2026-09-30T22:30:00Z', now, dataDir, kitRoot: repo }).record;
  assert.equal(short.routines.find((r) => r.id === 'morning-retro').nextAt, null);
  assert.equal(short.routines.find((r) => r.id === 'morning-summary').nextAt, '2026-09-30T22:20:00.000Z');
});

test('the prompt joins the routine text and the ad-hoc text', () => {
  const routine = { id: 'hourly-check', title: 'Hourly check', model: 'cheap', prompt: 'Step one.' };
  const text = routinePromptText(routine, 'Watch the build.');
  assert.match(text, /^\[herdr-boss\] Watch routine: Hourly check \(model hint: cheap\)\./);
  assert.match(text, /Step one\./);
  assert.match(text, /Instructions for this watch: Watch the build\./);
  assert.ok(!routinePromptText(routine, '').includes('Instructions for this watch'));
});

test('the start notice carries the ad-hoc text in one line', () => {
  const record = { until: '2026-10-01T06:00:00Z', adhoc: 'Skip the kit checks.\n  Tonight   only.' };
  const text = nightNoticeText('start', record);
  assert.ok(!text.includes('\n'));
  assert.match(text, /Instructions for this watch: Skip the kit checks\. Tonight only\.$/);
  assert.ok(!nightNoticeText('start', { until: record.until }).includes('Instructions'));
  assert.ok(!nightNoticeText('end', record).includes('Instructions'));
});

test('a new file in kit/watch changes the kit revision', (t) => {
  const root = tempDir(t);
  for (const file of ['kit/templates/project-kit.md', 'kit/skills/herdr-orchestrator/SKILL.md', 'kit/models.json']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'x');
  }
  const before = kitRevision(root);
  fs.mkdirSync(path.join(root, 'kit/watch'));
  fs.writeFileSync(path.join(root, 'kit/watch/a.md'), '---\ntitle: A\nevery: 5\n---\nText.\n');
  assert.notEqual(kitRevision(root), before);
});

// The engine probe runs deliverWatchRoutines in a child process with a temporary data directory and a recorded runner.
// Each round is { at, panes, restart, fail }. The runner records each pane prompt.
const engineProbe = `
import { Engine } from './src/engine.js';
import { loadConfig } from './src/config.js';
import { readNightRecord } from './src/night.js';
const input = JSON.parse(process.env.ROUTINE_SCENARIO);
const prompts = [];
let current = 0;
let fail = false;
const make = () => {
  const engine = new Engine(loadConfig(), {
    push: false, act: false, kitRoot: process.env.KIT_ROOT_FOR_TEST,
    herdrRunner: async (cmd, args) => { if (fail) throw new Error('refused'); prompts.push({ round: current, pane: args[2], text: args[3] }); return ''; },
  });
  // The data directory guard turns push off for a temporary directory. The probe turns it on.
  engine.push = true;
  return engine;
};
let engine = make();
const rounds = [];
for (const [i, round] of input.rounds.entries()) {
  current = i;
  fail = round.fail === true;
  if (round.restart) engine = make();
  await engine.deliverWatchRoutines({ panes: round.panes }, round.at);
  const record = readNightRecord();
  rounds.push(Object.fromEntries((record?.routines || []).map((r) => [r.id, { nextAt: r.nextAt, lastAt: r.lastAt, missedAt: r.missedAt ?? null }])));
}
console.log(JSON.stringify({ prompts, rounds, events: engine.events.map((e) => ({ type: e.type, text: e.text })) }));
`;

function runRoutines(t, { record, rounds }) {
  const dir = tempDir(t);
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(path.join(dataDir, 'projects'), { recursive: true });
  writeNight(record, { dataDir });
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', engineProbe], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, HOME: dir, HERDR_BOSS_DIR: dataDir, NODE_TEST_CONTEXT: '1', KIT_ROOT_FOR_TEST: repo, ROUTINE_SCENARIO: JSON.stringify({ rounds }) },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

const T0 = Date.parse('2026-09-30T22:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const boss = (status = 'idle') => ({ id: 'wB:p1', workspace: 'wB', label: 'boss', agent: 'claude', status });
const orch = { id: 'w1:p1', workspace: 'w1', orch: true, label: 'orch', agent: 'claude', status: 'idle' };
const armed = (patch = {}) => ({
  active: true, since: iso(T0), until: iso(T0 + 8 * 60 * MIN), by: 'owner', quietHours: false, adhoc: 'Tonight only.',
  routines: [{ id: 'hourly-check', title: 'Hourly check', model: 'cheap', every: 60, nextAt: iso(T0 + 60 * MIN), lastAt: null }],
  ...patch,
});

test('the service prompts the Boss pane once per slot, with the routine text and the ad-hoc text', (t) => {
  const out = runRoutines(t, {
    record: armed(),
    rounds: [
      { at: T0 + 30 * MIN, panes: [boss(), orch] },
      { at: T0 + 61 * MIN, panes: [boss(), orch] },
      { at: T0 + 62 * MIN, panes: [boss(), orch] },
    ],
  });
  assert.equal(out.prompts.length, 1, 'one prompt in total');
  assert.equal(out.prompts[0].pane, 'wB:p1');
  assert.equal(out.prompts[0].round, 1);
  assert.match(out.prompts[0].text, /Watch routine: Hourly check/);
  assert.match(out.prompts[0].text, /Run `herdr-boss check kit`/);
  assert.match(out.prompts[0].text, /Instructions for this watch: Tonight only\./);
  assert.equal(out.rounds[0]['hourly-check'].lastAt, null);
  assert.equal(out.rounds[1]['hourly-check'].lastAt, iso(T0 + 61 * MIN));
  assert.equal(out.rounds[1]['hourly-check'].nextAt, iso(T0 + 120 * MIN));
  assert.ok(out.events.some((e) => /Hourly check/.test(e.text) && /next/i.test(e.text)), 'the log names the routine and the next run');
});

test('a restart does not repeat a routine that already fired', (t) => {
  const out = runRoutines(t, {
    record: armed(),
    rounds: [
      { at: T0 + 61 * MIN, panes: [boss()] },
      { at: T0 + 62 * MIN, panes: [boss()], restart: true },
      { at: T0 + 63 * MIN, panes: [boss()], restart: true },
    ],
  });
  assert.equal(out.prompts.length, 1);
});

test('a busy Boss gets the prompt at the next tick where it is idle, inside the same slot', (t) => {
  const out = runRoutines(t, {
    record: armed(),
    rounds: [
      { at: T0 + 61 * MIN, panes: [boss('working')] },
      { at: T0 + 65 * MIN, panes: [boss('working')] },
      { at: T0 + 70 * MIN, panes: [boss('idle')] },
      { at: T0 + 71 * MIN, panes: [boss('idle')] },
    ],
  });
  assert.deepEqual(out.prompts.map((p) => p.round), [2]);
  assert.equal(out.rounds[0]['hourly-check'].lastAt, null);
  assert.equal(out.rounds[2]['hourly-check'].lastAt, iso(T0 + 70 * MIN));
});

test('a routine that could not run before the next slot is skipped and logged', (t) => {
  const out = runRoutines(t, {
    record: armed(),
    rounds: [
      { at: T0 + 61 * MIN, panes: [boss('working')] },
      { at: T0 + 125 * MIN, panes: [boss('idle')] },
    ],
  });
  assert.equal(out.prompts.length, 0, 'the missed slot does not fire late');
  assert.equal(out.rounds[1]['hourly-check'].missedAt, iso(T0 + 125 * MIN));
  assert.equal(out.rounds[1]['hourly-check'].nextAt, iso(T0 + 180 * MIN));
  assert.ok(out.events.some((e) => /skipped/i.test(e.text)));
});

test('a refused prompt or a missing Boss pane keeps the routine armed', (t) => {
  const out = runRoutines(t, {
    record: armed(),
    rounds: [
      { at: T0 + 61 * MIN, panes: [orch] },
      { at: T0 + 62 * MIN, panes: [boss()], fail: true },
      { at: T0 + 63 * MIN, panes: [boss()] },
    ],
  });
  assert.deepEqual(out.prompts.map((p) => p.round), [2]);
  assert.equal(out.rounds[1]['hourly-check'].lastAt, null);
});

test('one routine fires per tick, oldest slot first', (t) => {
  const until = T0 + 8 * 60 * MIN;
  const out = runRoutines(t, {
    record: armed({
      until: iso(until),
      routines: [
        { id: 'morning-retro', title: 'Morning retrospective', model: 'cheap', beforeEnd: '01:00', nextAt: iso(until - 60 * MIN), lastAt: null },
        { id: 'morning-summary', title: 'Morning summary and report', model: 'default', beforeEnd: '00:10', nextAt: iso(until - 10 * MIN), lastAt: null },
      ],
    }),
    rounds: [
      { at: until - 61 * MIN, panes: [boss()] },
      { at: until - 9 * MIN, panes: [boss()] },
      { at: until - 8 * MIN, panes: [boss()] },
      { at: until - 7 * MIN, panes: [boss()] },
    ],
  });
  assert.deepEqual(out.prompts.map((p) => [p.round, /Morning retrospective|Morning summary/.exec(p.text)[0]]), [[1, 'Morning retrospective'], [2, 'Morning summary']]);
  assert.equal(out.rounds[0]['morning-retro'].lastAt, null);
  assert.equal(out.rounds[1]['morning-retro'].nextAt, null, 'a routine relative to the end has no second run');
});

test('a routine relative to the end that is still armed at the end is skipped', (t) => {
  const until = T0 + 8 * 60 * MIN;
  const out = runRoutines(t, {
    record: armed({
      until: iso(until),
      routines: [{ id: 'morning-retro', title: 'Morning retrospective', model: 'cheap', beforeEnd: '01:00', nextAt: iso(until - 60 * MIN), lastAt: null }],
    }),
    rounds: [{ at: until - 30 * MIN, panes: [boss('working')] }, { at: until + MIN, panes: [boss()] }],
  });
  assert.equal(out.prompts.length, 0);
  assert.equal(out.rounds[1]['morning-retro'].missedAt, iso(until + MIN));
  assert.equal(out.rounds[1]['morning-retro'].nextAt, null);
});

test('the service arms nothing when the watch is not active', (t) => {
  const out = runRoutines(t, { record: armed({ active: false }), rounds: [{ at: T0 + 61 * MIN, panes: [boss()] }] });
  assert.equal(out.prompts.length, 0);
});

test('POST /api/watch/start arms the choice, and the routine routes save and reset an override', (t) => {
  const dir = tempDir(t);
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ port: 0, host: '127.0.0.1' }));
  const script = `
const { serve } = await import(process.env.SERVER_URL);
const { loadConfig } = await import(process.env.CONFIG_URL);
const { Engine } = await import(process.env.ENGINE_URL);
console.log = () => {};
const collectors = {
  collectHerdr: async () => ({ panes: [], workspaces: [] }), collectMachine: async () => null,
  collectProcesses: async () => new Map(), collectQuotas: async () => [], collectWorktreeCounts: async () => ({}),
  collectCwdProcesses: async () => [], collectMissingWorktreeProcesses: async () => [], collectPiModels: async () => ({ models: [] }),
};
const app = serve(loadConfig(), { createEngine: (config, options) => new Engine(config, { ...options, collectors }) });
try {
  if (!app.server.listening) await new Promise((resolve, reject) => { app.server.once('listening', resolve); app.server.once('error', reject); });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const call = async (method, path, body) => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const out = {};
  out.list = await call('GET', '/api/watch/routines');
  out.badId = await call('PUT', '/api/watch/routines/%E0%A4%A', { every: 5 });
  out.badSave = await call('PUT', '/api/watch/routines/hourly-check', { every: 0 });
  out.save = await call('PUT', '/api/watch/routines/hourly-check', { prompt: 'Own text.', every: 45 });
  out.start = await call('POST', '/api/watch/start', { until: new Date(Date.now() + 8 * 3600e3).toISOString(), routines: { 'morning-retro': { enabled: false } }, adhoc: 'Tonight only.' });
  out.reset = await call('DELETE', '/api/watch/routines/hourly-check');
  out.after = await call('GET', '/api/watch/routines');
  process.stdout.write(JSON.stringify(out));
} finally { await app.close(); }
`;
  const env = {
    ...process.env, HOME: dir, HERDR_BOSS_DIR: dataDir, HERDR_BOSS_LIVE_DIR: path.join(dir, 'live'), NODE_TEST_CONTEXT: '1',
    SERVER_URL: new URL('../src/server.js', import.meta.url).href,
    CONFIG_URL: new URL('../src/config.js', import.meta.url).href,
    ENGINE_URL: new URL('../src/engine.js', import.meta.url).href,
  };
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.list.status, 200);
  assert.deepEqual(out.list.body.routines.map((r) => r.id), ['hourly-check', 'morning-retro', 'morning-summary']);
  assert.equal(out.badId.status, 400);
  assert.equal(out.badSave.status, 400);
  assert.equal(out.save.status, 200);
  assert.equal(out.save.body.routine.prompt, 'Own text.');
  assert.equal(out.start.status, 200);
  assert.equal(out.start.body.night.adhoc, 'Tonight only.');
  assert.deepEqual(out.start.body.night.routines.map((r) => r.id), ['hourly-check', 'morning-summary']);
  assert.equal(out.start.body.night.routines[0].every, 45);
  assert.equal(out.reset.status, 200);
  assert.equal(out.after.body.routines.find((r) => r.id === 'hourly-check').source, 'kit');
  assert.equal(out.after.body.routines.find((r) => r.id === 'morning-retro').enabled, false, 'the last choice is the default');
  assert.equal(readNightRecord({ dataDir }).adhoc, 'Tonight only.');
});

test('watch start takes --routines and --adhoc, and watch routines lists the next and last run', (t) => {
  const dataDir = tempDir(t);
  const env = { ...process.env, HOME: dataDir, HERDR_BOSS_DIR: dataDir };
  for (const name of ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID']) delete env[name];
  const cli = path.join(repo, 'src', 'cli.js');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
  const started = run('watch', 'start', '--until-cancelled', '--routines', 'hourly-check', '--adhoc', 'Tonight only.');
  assert.equal(started.status, 0, started.stderr);
  const record = readNightRecord({ dataDir });
  assert.deepEqual(record.routines.map((r) => r.id), ['hourly-check']);
  assert.equal(record.adhoc, 'Tonight only.');
  assert.match(run('watch', 'routines').stdout, /^hourly-check: next \d{4}-\d{2}-\d{2}T[\d:.]+Z, last never\n$/);
  // The next watch without --routines uses the last choice.
  assert.equal(run('watch', 'start', '--until-cancelled').status, 0);
  assert.deepEqual(readNightRecord({ dataDir }).routines.map((r) => r.id), ['hourly-check']);
  const unknown = run('watch', 'start', '--until-cancelled', '--routines', 'nope');
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /Unknown routine nope/);
  const none = run('watch', 'start', '--until-cancelled', '--routines', 'none');
  assert.equal(none.status, 0, none.stderr);
  assert.deepEqual(readNightRecord({ dataDir }).routines, []);
});

test('control characters are removed from the ad-hoc text, the title, and the prompt', (t) => {
  const dataDir = tempDir(t);
  assert.equal(cleanAdhoc('Keep\x1b[31m this\x00\x07\x7f.\r\nNext\tline'), 'Keep[31m this.\nNext\tline');
  const saved = saveRoutine('own-check', { title: 'Own\x1b check', prompt: 'Line one.\x00\nLine\x1b two.', every: 10 }, { dataDir, kitRoot: repo });
  assert.equal(saved.title, 'Own check');
  assert.equal(saved.prompt, 'Line one.\nLine two.');
  assert.throws(() => saveRoutine('own-check', { prompt: '\x00\x1b' }, { dataDir, kitRoot: repo }), /needs text/);
});

test('the skip log names the real reason', (t) => {
  const busy = runRoutines(t, { record: armed(), rounds: [{ at: T0 + 61 * MIN, panes: [boss('working')] }, { at: T0 + 125 * MIN, panes: [boss('working')] }] });
  assert.ok(busy.events.some((e) => /skipped/.test(e.text) && /the Boss was working/.test(e.text)), JSON.stringify(busy.events));
  const none = runRoutines(t, { record: armed(), rounds: [{ at: T0 + 61 * MIN, panes: [orch] }, { at: T0 + 125 * MIN, panes: [orch] }] });
  assert.ok(none.events.some((e) => /skipped/.test(e.text) && /no Boss pane was found/.test(e.text)), JSON.stringify(none.events));
  const failed = runRoutines(t, { record: armed(), rounds: [{ at: T0 + 61 * MIN, panes: [boss()], fail: true }, { at: T0 + 125 * MIN, panes: [boss()], fail: true }] });
  assert.ok(failed.events.some((e) => /skipped/.test(e.text) && /the prompt failed \(refused\)/.test(e.text)), JSON.stringify(failed.events));
});
