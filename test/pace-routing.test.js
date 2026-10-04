import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { loadModels, loadProjectConfig } from '../src/kit/config.js';
import { startWorker } from '../src/kit/workers.js';
import { POLICY_DEFAULTS, laneStatus } from '../src/control.js';

const models = loadModels();

const belowPace = (usedPercent = 33, expectedPercent = 90) => ({
  state: 'open',
  belowPace: { window: 'Weekly', usedPercent, expectedPercent, roomPercent: expectedPercent - usedPercent, tolerancePoints: 5 },
});
const ahead = (usedPercent = 95, expectedPercent = 60) => ({
  state: 'pace', window: 'Weekly', usedPercent, expectedPercent, overPercent: usedPercent - expectedPercent, tolerancePoints: 5,
});
const unmetered = { state: 'open', unmetered: true, byProject: {} };
const withPolicy = (patch = {}) => ({ ...structuredClone(POLICY_DEFAULTS), ...patch });

function fixture(t, { rules = {} } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-pace-routing-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test User');
  git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(root, 'README.md'), 'seed\n');
  git('add', 'README.md');
  git('commit', '-m', 'seed');
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ slug: 'herdrboss', worktreeRoot: path.join(root, 'wt') }));
  const config = loadProjectConfig({ cwd: root });
  const rulesFile = path.join(root, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({ updatedAt: new Date().toISOString(), avoidKinds: [], ...rules }));
  const out = [];
  const herdr = (args) => {
    if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } };
    if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
    if (args[0] === 'tab' && args[1] === 'list') return { tabs: [] };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [] };
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const env = { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch', HERDR_BOSS_DIR: path.join(root, 'data') };
  const start = (name, options) => startWorker(name, { task: 'x', allow: ['src/'], ...options }, {
    config, models, herdr, env, rulesFile, output: (line) => out.push(line), browserLookup: () => null,
  });
  return { root, config, rulesFile, start, out };
}

test('laneStatus marks a lane far below its pace with the numbers', () => {
  const now = Date.parse('2026-09-25T16:00:00Z');
  const quotas = [{ provider: 'opencodego', windows: [{ key: 'primary', label: 'Weekly', usedPercent: 33, expectedPercent: 90, willLast: true, windowMinutes: 10080, resetsAt: '2026-10-10T00:00:00Z' }] }];
  const lanes = laneStatus(quotas, structuredClone(POLICY_DEFAULTS), now);
  assert.equal(lanes.opencodego.state, 'open');
  assert.deepEqual(lanes.opencodego.belowPace, { window: 'Weekly', usedPercent: 33, expectedPercent: 90, roomPercent: 57, tolerancePoints: 5 });
});

test('laneStatus does not mark a lane inside the tolerance', () => {
  const now = Date.parse('2026-09-25T16:00:00Z');
  const quotas = [{ provider: 'opencodego', windows: [{ key: 'primary', label: 'Weekly', usedPercent: 56, expectedPercent: 60, willLast: true, windowMinutes: 10080, resetsAt: '2026-10-10T00:00:00Z' }] }];
  const lanes = laneStatus(quotas, structuredClone(POLICY_DEFAULTS), now);
  assert.equal(lanes.opencodego.state, 'open');
  assert.equal(lanes.opencodego.belowPace, undefined);
});

test('worker start routes to a below-pace lane when no model is given', (t) => {
  const f = fixture(t, { rules: { policy: withPolicy(), lanes: { unmetered, opencodego: belowPace() } } });
  const plan = f.start('prbelow', { kind: 'opencode', dryRun: true });
  assert.equal(plan.model, 'opencode-go/deepseek-v4.1-flash');
  assert.equal(plan.modelSource, 'pace');
  assert.deepEqual(plan.modelRoute, { lane: 'opencodego', usedPercent: 33, expectedPercent: 90, tolerancePoints: 5 });
  assert.ok(f.out.some((line) => line === 'routed to opencodego: 33% used against 90% expected'), f.out.join('\n'));
});

test('worker start keeps the default when the other lane is ahead of pace', (t) => {
  const f = fixture(t, { rules: { policy: withPolicy(), lanes: { unmetered, opencodego: ahead() } } });
  const plan = f.start('prahead', { kind: 'opencode', dryRun: true });
  assert.equal(plan.model, models.kinds.opencode.defaultModel);
  assert.equal(plan.modelSource, 'default');
});

test('an explicit --model wins over the below-pace lane', (t) => {
  const f = fixture(t, { rules: { policy: withPolicy(), lanes: { unmetered, opencodego: belowPace() } } });
  const plan = f.start('prflag', { kind: 'opencode', model: 'opencode/mimo-v2.6-flash-free', dryRun: true });
  assert.equal(plan.model, 'opencode/mimo-v2.6-flash-free');
  assert.equal(plan.modelSource, 'flag');
});

test('a disabled model in the below-pace lane is skipped', (t) => {
  const f = fixture(t, { rules: {
    policy: withPolicy({ disabledModels: { opencode: ['opencode-go/deepseek-v4.1-flash'] } }),
    lanes: { unmetered, opencodego: belowPace() },
  } });
  const plan = f.start('prdisabled', { kind: 'opencode', dryRun: true });
  assert.equal(plan.model, models.kinds.opencode.defaultModel);
  assert.equal(plan.modelSource, 'default');
});

test('the pace routing setting off keeps the default model', (t) => {
  const f = fixture(t, { rules: { policy: withPolicy({ paceRouting: false }), lanes: { unmetered, opencodego: belowPace() } } });
  const plan = f.start('proff', { kind: 'opencode', dryRun: true });
  assert.equal(plan.model, models.kinds.opencode.defaultModel);
  assert.equal(plan.modelSource, 'default');
});
