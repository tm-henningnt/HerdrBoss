import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { activeLaunchRecords, clearModelFailure, MODEL_FAILURE_COOLDOWN_MS, MODEL_FAILURE_THRESHOLD, MODEL_FAILURE_WINDOW_MS, MODEL_UNAVAILABLE_LABEL, modelFailureMark, recordModelFailure } from '../src/kit/model-unavailable.js';
import { loadModels } from '../src/kit/config.js';
import { startWorker } from '../src/kit/workers.js';
import { git, setupFixture } from './helpers/kit-fixture.js';

const PI_MODEL = 'opencode-go/space-bunny-free';
const START = Date.parse('2026-10-09T10:00:00Z');

const tempDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-model-failure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const readFailures = (dir) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'unavailable-models.json'), 'utf8')).modelFailures || {}; }
  catch { return {}; }
};

test('two "Model is unavailable" failures do not mark the model', (t) => {
  const dir = tempDir(t);
  assert.deepEqual(recordModelFailure(dir, { kind: 'pi', model: PI_MODEL, now: START }), { count: 1, marked: false, retryAt: null });
  assert.deepEqual(recordModelFailure(dir, { kind: 'pi', model: PI_MODEL, now: START + 60_000 }), { count: 2, marked: false, retryAt: null });
  assert.deepEqual(activeLaunchRecords(dir, START + 120_000), []);
  assert.equal(modelFailureMark(activeLaunchRecords(dir, START + 120_000), 'pi', PI_MODEL, START + 120_000), null);
});

test('three failures within 24 hours mark the model for 6 hours and name the count', (t) => {
  const dir = tempDir(t);
  recordModelFailure(dir, { kind: 'pi', model: PI_MODEL, now: START });
  recordModelFailure(dir, { kind: 'pi', model: PI_MODEL, now: START + 60_000 });
  assert.deepEqual(recordModelFailure(dir, { kind: 'pi', model: PI_MODEL, now: START + 120_000 }), {
    count: MODEL_FAILURE_THRESHOLD, marked: true, retryAt: START + 120_000 + MODEL_FAILURE_COOLDOWN_MS,
  });
  const records = activeLaunchRecords(dir, START + 120_001);
  assert.equal(records.length, 1);
  assert.equal(records[0].model, PI_MODEL);
  assert.equal(records[0].count, 3);
  assert.equal(records[0].label, MODEL_UNAVAILABLE_LABEL);
  assert.equal(modelFailureMark(records, 'pi', PI_MODEL, START + 120_001).retryAt, START + 120_000 + MODEL_FAILURE_COOLDOWN_MS);
});

test('a failure older than 24 hours does not count toward the mark', (t) => {
  const dir = tempDir(t);
  recordModelFailure(dir, { kind: 'pi', model: PI_MODEL, now: START });
  recordModelFailure(dir, { kind: 'pi', model: PI_MODEL, now: START + MODEL_FAILURE_WINDOW_MS + 1 });
  assert.deepEqual(recordModelFailure(dir, { kind: 'pi', model: PI_MODEL, now: START + MODEL_FAILURE_WINDOW_MS + 2 }),
    { count: 2, marked: false, retryAt: null });
});

test('a repeated failure at the same instant counts once', (t) => {
  const dir = tempDir(t);
  recordModelFailure(dir, { kind: 'pi', model: PI_MODEL, now: START });
  assert.deepEqual(recordModelFailure(dir, { kind: 'pi', model: PI_MODEL, now: START }), { count: 1, marked: false, retryAt: null });
});

test('a successful run clears the count and a recorded mark', (t) => {
  const dir = tempDir(t);
  recordModelFailure(dir, { kind: 'pi', model: PI_MODEL, now: START });
  assert.equal(clearModelFailure(dir, { kind: 'pi', model: PI_MODEL }), true);
  assert.deepEqual(readFailures(dir), {});
  assert.deepEqual(recordModelFailure(dir, { kind: 'pi', model: PI_MODEL, now: START + 60_000 }), { count: 1, marked: false, retryAt: null });
  recordModelFailure(dir, { kind: 'pi', model: PI_MODEL, now: START + 120_000 });
  recordModelFailure(dir, { kind: 'pi', model: PI_MODEL, now: START + 180_000 });
  assert.equal(activeLaunchRecords(dir, START + 180_001).length, 1);
  assert.equal(clearModelFailure(dir, { kind: 'pi', model: PI_MODEL }), true);
  assert.deepEqual(activeLaunchRecords(dir, START + 180_001), []);
  assert.equal(clearModelFailure(dir, { kind: 'pi', model: PI_MODEL }), false);
});

test('the state file keeps at most 50 model counters', (t) => {
  const dir = tempDir(t);
  for (let index = 0; index < 60; index++) recordModelFailure(dir, { kind: 'pi', model: `opencode-go/model-${index}`, now: START + index });
  const failures = readFailures(dir);
  assert.equal(Object.keys(failures).length, 50);
  assert.equal(Object.hasOwn(failures, 'pi\nopencode-go/model-59'), true);
  assert.equal(Object.hasOwn(failures, 'pi\nopencode-go/model-0'), false);
});

// ---- worker start gate ----

function piFixture(t, name) {
  const f = setupFixture(null);
  f.env.HERDR_BOSS_DIR = path.join(f.root, 'boss-data');
  t.after(() => {
    try { git(f.root, 'worktree', 'remove', '--force', f.config.worktreePath(name)); } catch {}
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  const start = (deps = {}, options = {}) => startWorker(name, {
    kind: 'pi', model: PI_MODEL, task: 'x', allow: ['src/'], dryRun: true, ...options,
  }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile,
    output: () => {}, ...deps,
  });
  return { f, start, dir: f.env.HERDR_BOSS_DIR };
}

test('a marked model is refused with a message that names the model, the count, and the return time', (t) => {
  const { start, dir } = piFixture(t, 'pi-marked');
  recordModelFailure(dir, { kind: 'pi', model: PI_MODEL, now: START });
  recordModelFailure(dir, { kind: 'pi', model: PI_MODEL, now: START + 1000 });
  recordModelFailure(dir, { kind: 'pi', model: PI_MODEL, now: START + 2000 });
  assert.throws(() => start({ now: START + 3000 }), (error) => {
    assert.match(error.message, /opencode-go\/space-bunny-free/);
    assert.match(error.message, /3 (?:times|runs)/);
    assert.match(error.message, /2026-10-09T16:00:02.000Z/);
    return true;
  });
});

test('the model starts again after the 6 hour cooldown (injected clock)', (t) => {
  const { start, dir } = piFixture(t, 'pi-after-cooldown');
  recordModelFailure(dir, { kind: 'pi', model: PI_MODEL, now: START });
  recordModelFailure(dir, { kind: 'pi', model: PI_MODEL, now: START + 1000 });
  recordModelFailure(dir, { kind: 'pi', model: PI_MODEL, now: START + 2000 });
  const plan = start({ now: START + 2002 + MODEL_FAILURE_COOLDOWN_MS });
  assert.equal(plan.model, PI_MODEL);
});

// ---- override ----

function openCodeFixture(t, name) {
  const f = setupFixture(null);
  f.env.HERDR_BOSS_DIR = path.join(f.root, 'boss-data');
  let registered = false;
  const herdr = (args) => {
    if (args[0] === 'agent' && args[1] === 'get') {
      if (!registered) throw Object.assign(new Error('agent_not_found: fake TUI exited'), { code: 'agent_not_found' });
      return { agent: { name, pane_id: 'ws:p2', agent: 'opencode', agent_status: 'idle', interactive_ready: true } };
    }
    if (args[0] === 'agent' && args[1] === 'start') { registered = true; return {}; }
    if (args[0] === 'agent' && args[1] === 'close') { registered = false; return {}; }
    if (args[0] === 'pane' && args[1] === 'close') { registered = false; return f.herdr(args); }
    return f.herdr(args);
  };
  t.after(() => {
    try { git(f.root, 'worktree', 'remove', '--force', f.config.worktreePath(name)); } catch {}
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  const model = 'opencode/mimo-v2.6-flash-free';
  const start = (deps = {}) => startWorker(name, { kind: 'opencode', model, task: 'x', allow: ['src/'], force: true, reason: 'override the marked model for a test' }, {
    config: f.config, models: loadModels(), herdr, env: f.env, rulesFile: f.rulesFile,
    wait: () => {}, output: () => {}, tuiSupportsModelFlags: () => true,
    readProcessStart: () => 'Mon Sep 28 10:00:00 2026', ...deps,
  });
  return { f, start, model, dir: f.env.HERDR_BOSS_DIR };
}

test('--force --reason overrides the refusal and writes the audit line', (t) => {
  const { start, model, dir } = openCodeFixture(t, 'model-failure-override');
  recordModelFailure(dir, { kind: 'opencode', model, now: START });
  recordModelFailure(dir, { kind: 'opencode', model, now: START + 1000 });
  recordModelFailure(dir, { kind: 'opencode', model, now: START + 2000 });
  const run = start({ now: START + 3000 });
  assert.equal(run.model, model);
  const audit = fs.readFileSync(path.join(dir, 'action-audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const row = audit.find((item) => item.command === 'worker start');
  assert.ok(row, 'the override writes one worker start audit line');
  assert.match(row.refusalKind, /model-unavailable/);
  assert.equal(row.reason, 'override the marked model for a test');
});
