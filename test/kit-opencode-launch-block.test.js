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
const FLAG_TEXT = 'ERROR\n  Unrecognized flag: --agent in command opencode\n  Did you mean this?\n% ';

// A fake Herdr and pane. The pane shows the refused-flag text after the first launch.
function flagFixture(t, name) {
  const f = setupFixture(null);
  f.env.HERDR_BOSS_DIR = path.join(f.root, 'boss-data');
  const lockFile = path.join(f.env.HERDR_BOSS_DIR, 'opencode-start', 'owner.json');
  const state = { launches: 0, waits: [], closedAgents: 0, screen: '% ' };
  let registered = false;
  const herdr = (args) => {
    if (args[0] === 'agent' && args[1] === 'get') {
      if (!registered) throw Object.assign(new Error('agent_not_found: fake TUI exited'), { code: 'agent_not_found' });
      return { agent: { name, pane_id: 'ws:p2', agent: 'opencode', agent_status: 'idle', interactive_ready: true } };
    }
    if (args[0] === 'agent' && args[1] === 'start') { state.launches++; registered = true; state.screen = FLAG_TEXT; return {}; }
    if (args[0] === 'agent' && args[1] === 'close') { registered = false; state.closedAgents++; return {}; }
    if (args[0] === 'pane' && args[1] === 'close') { registered = false; return f.herdr(args); }
    if (args[0] === 'pane' && args[1] === 'read') return { text: state.screen };
    return f.herdr(args);
  };
  t.after(() => {
    try { git(f.root, 'worktree', 'remove', '--force', f.config.worktreePath(name)); } catch {}
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  const start = () => startWorker(name, { kind: 'opencode', task: 'x', allow: ['src/'], model: MODEL }, {
    config: f.config, models: loadModels(), herdr, env: f.env, rulesFile: f.rulesFile,
    wait: (ms) => { state.waits.push(ms); }, output: () => {}, tuiSupportsModelFlags: () => true,
    readProcessStart: () => 'Mon Sep 28 10:00:00 2026',
  });
  const records = () => {
    try { return Object.values(JSON.parse(fs.readFileSync(path.join(f.env.HERDR_BOSS_DIR, 'unavailable-models.json'), 'utf8'))); }
    catch { return []; }
  };
  return { f, state, start, records, lockFile, dataDir: f.env.HERDR_BOSS_DIR };
}

test('an Unrecognized flag fails on the first launch with no relaunch, no pause, and no model record', (t) => {
  const fx = flagFixture(t, 'oc-block-flag');
  assert.throws(() => fx.start(), (error) => {
    assert.equal(error.code, 'opencode_unsupported_flag');
    assert.match(error.message, /--agent/);
    return true;
  });
  assert.equal(fx.state.launches, 1, 'the old pane relaunch does not run');
  assert.deepEqual(fx.state.waits, [], 'the removed relaunch makes no 15 s pause');
  assert.deepEqual(fx.records(), [], 'no model is marked unavailable');
  assert.equal(fs.existsSync(fx.lockFile), false, 'the lane lock is released');
  assert.equal(withOpenCodeStartLock(fx.dataDir, () => 'free', {
    timeoutMs: 50, wait: () => {}, output: () => {}, readProcessStart: () => 'Mon Sep 28 10:00:00 2026',
  }), 'free');
});
