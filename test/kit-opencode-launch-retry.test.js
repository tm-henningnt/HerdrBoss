import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadModels } from '../src/kit/config.js';
import { startWorker } from '../src/kit/workers.js';
import { withOpenCodeStartLock } from '../src/kit/opencode-start.js';
import { git, setupFixture } from './helpers/kit-fixture.js';

const MODEL = 'opencode/mimo-v2.6-flash-free';
const PHRASE = 'Did you mean this?';

// A fake Herdr and pane. The pane text gains `paneText` after each launch whose number is in `failing`.
// Every fake is injected: no real OpenCode, no real wait, no real probe.
function retryFixture(t, name, { failing = [], paneText = PHRASE, probe = () => true } = {}) {
  const f = setupFixture(null);
  f.env.HERDR_BOSS_DIR = path.join(f.root, 'boss-data');
  const lockFile = path.join(f.env.HERDR_BOSS_DIR, 'opencode-start', 'owner.json');
  const state = { launches: 0, screen: '', waits: [], probes: [], closedAgents: 0, lockHeldAt: [], output: [] };
  let registered = false;
  const herdr = (args) => {
    if (args[0] === 'agent' && args[1] === 'get') {
      if (!registered) throw Object.assign(new Error('agent_not_found: fake TUI exited'), { code: 'agent_not_found' });
      return { agent: { name, pane_id: 'ws:p2', agent: 'opencode', agent_status: 'idle', interactive_ready: true } };
    }
    if (args[0] === 'agent' && args[1] === 'start') {
      state.launches++;
      state.lockHeldAt.push(fs.existsSync(lockFile));
      registered = true;
      if (failing.includes(state.launches)) state.screen += `opencode\n${paneText}\n`;
      state.onLaunch?.(state.launches);
      return {};
    }
    if (args[0] === 'agent' && args[1] === 'close') { registered = false; state.closedAgents++; return {}; }
    if (args[0] === 'pane' && args[1] === 'close') { registered = false; return f.herdr(args); }
    if (args[0] === 'pane' && args[1] === 'read') return { text: `${state.screen}% ` };
    return f.herdr(args);
  };
  t.after(() => {
    try { git(f.root, 'worktree', 'remove', '--force', f.config.worktreePath(name)); } catch {}
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  const dataDir = f.env.HERDR_BOSS_DIR;
  const records = () => {
    try { return Object.values(JSON.parse(fs.readFileSync(path.join(dataDir, 'unavailable-models.json'), 'utf8'))); }
    catch { return []; }
  };
  const start = (options = {}) => startWorker(name, { kind: 'opencode', task: 'x', allow: ['src/'], model: MODEL, ...options }, {
    config: f.config, models: loadModels(), herdr, env: f.env, rulesFile: f.rulesFile,
    wait: (ms) => { state.waits.push(ms); }, output: (line) => state.output.push(line),
    probeModel: (model, probeOptions) => {
      state.lockHeldAt.push(fs.existsSync(lockFile));
      state.probes.push({ model, ...probeOptions });
      return probe(model);
    },
  });
  return { f, state, start, records, lockFile, dataDir };
}

const delays = (state) => state.waits.filter((ms) => ms === 15_000);

test('a relaunch after the pane shows "Did you mean this?" succeeds and marks no model', (t) => {
  const fx = retryFixture(t, 'oc-retry-ok', { failing: [1] });
  const run = fx.start();
  assert.equal(run.model, MODEL);
  assert.equal(fx.state.launches, 2);
  assert.equal(delays(fx.state).length, 1, 'one 15 s pause before the relaunch');
  assert.equal(fx.state.probes.length, 0, 'no probe after a relaunch that works');
  assert.deepEqual(fx.records(), []);
  assert.equal(fs.existsSync(fx.lockFile), false, 'the lane lock is released');
});

test('three failed launches with an answering probe fail the start and mark no model', (t) => {
  const fx = retryFixture(t, 'oc-retry-probe-ok', { failing: [1, 2, 3], probe: () => true });
  assert.throws(() => fx.start(), (error) => {
    assert.match(error.message, /pane startup/i);
    assert.match(error.message, /3 launch attempts/);
    assert.notEqual(error.code, 'model_launch_blocked');
    return true;
  });
  assert.equal(fx.state.launches, 3);
  assert.equal(delays(fx.state).length, 2, 'two pauses of 15 s between three launches');
  assert.equal(fx.state.probes.length, 1);
  assert.equal(fx.state.probes[0].model, MODEL);
  assert.equal(fx.state.probes[0].timeoutMs, 60_000);
  assert.deepEqual(fx.records(), []);
  assert.equal(fs.existsSync(path.join(fx.dataDir, 'unavailable-models.json')), false);
});

test('three failed launches with a failing probe mark the model until it is re-enabled', (t) => {
  const fx = retryFixture(t, 'oc-retry-probe-fail', { failing: [1, 2, 3], probe: () => false });
  assert.throws(() => fx.start(), (error) => {
    assert.equal(error.code, 'model_launch_blocked');
    assert.match(error.message, /Did you mean this\?/);
    return true;
  });
  assert.equal(fx.state.launches, 3);
  assert.equal(fx.state.probes.length, 1);
  const [record] = fx.records();
  assert.equal(record.model, MODEL);
  assert.equal(record.kind, 'opencode');
  assert.equal(record.untilReenabled, true);
});

test('a probe that throws counts as a failed probe', (t) => {
  const fx = retryFixture(t, 'oc-retry-probe-throws', { failing: [1, 2, 3], probe: () => { throw new Error('opencode: command not found'); } });
  assert.throws(() => fx.start(), (error) => error.code === 'model_launch_blocked');
  assert.equal(fx.records().length, 1);
});

test('the lane lock is held across every launch and the probe, blocks a second start, and is released after a failure', (t) => {
  const fx = retryFixture(t, 'oc-retry-lock', { failing: [1, 2, 3], probe: () => true });
  let secondStart = null;
  fx.state.onLaunch = (launch) => {
    if (launch !== 2) return;
    // A second start on the same machine must wait for the lane lock while the first start relaunches.
    try {
      withOpenCodeStartLock(fx.dataDir, () => { secondStart = 'ran'; }, { timeoutMs: 50, wait: () => {}, output: () => {} });
    } catch (error) { secondStart = error.message; }
  };
  assert.throws(() => fx.start(), /pane startup/i);
  assert.deepEqual(fx.state.lockHeldAt, [true, true, true, true], 'three launches and the probe run under the lock');
  assert.match(secondStart, /still busy/);
  assert.equal(fs.existsSync(fx.lockFile), false, 'the lock is released after the failed start');
  assert.equal(withOpenCodeStartLock(fx.dataDir, () => 'free', { timeoutMs: 50, wait: () => {}, output: () => {} }), 'free');
});

test('the lane lock is released when the probe fails and the model is marked', (t) => {
  const fx = retryFixture(t, 'oc-retry-lock-mark', { failing: [1, 2, 3], probe: () => false });
  assert.throws(() => fx.start(), (error) => error.code === 'model_launch_blocked');
  assert.equal(fs.existsSync(fx.lockFile), false);
});

for (const [phrase, paneText] of [['not available in your country', 'This model is not available in your country'], ['Rate limit exceeded', 'Error: rate limit exceeded']]) {
  test(`"${phrase}" is not relaunched and is not probed`, (t) => {
    const fx = retryFixture(t, `oc-retry-other-${phrase.length}`, { failing: [1, 2, 3], paneText });
    assert.throws(() => fx.start(), (error) => error.code === 'model_launch_blocked');
    assert.equal(fx.state.launches, 1);
    assert.equal(delays(fx.state).length, 0);
    assert.equal(fx.state.probes.length, 0);
    assert.equal(fx.records().length, 1);
  });
}
