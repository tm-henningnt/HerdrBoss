import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { loadModels, loadProjectConfig } from '../src/kit/config.js';
import { startWorker } from '../src/kit/workers.js';
import { POLICY_DEFAULTS } from '../src/control.js';

const models = loadModels();
const OPUS_REFUSAL = { message: "claude-opus-5-5 needs the Owner's approval. Ask the Owner, then start with --force." };

function fixture(t, { rules = {}, kitModels = models } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-worker-model-')));
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
  const calls = [];
  const out = [];
  const herdr = (args) => {
    calls.push(args);
    if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } };
    if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
    if (args[0] === 'tab' && args[1] === 'list') return { tabs: [] };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [] };
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const env = { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch' };
  const start = (name, options) => startWorker(name, { task: 'x', allow: ['src/'], ...options }, {
    config, models: kitModels, herdr, env, rulesFile, output: (line) => out.push(line),
  });
  const sideEffects = () => ({
    worktrees: fs.existsSync(path.join(root, 'wt')) ? fs.readdirSync(path.join(root, 'wt')) : [],
    panes: calls.filter((args) => ['split', 'create', 'start', 'prompt'].includes(args[1])),
    records: fs.existsSync(config.runsPath) ? fs.readdirSync(config.runsPath) : [],
    branch: execFileSync('git', ['-C', root, 'branch', '--list', 'wm*'], { encoding: 'utf8' }).trim(),
  });
  return { start, sideEffects, out };
}

const modelOf = (launchArgs) => launchArgs[launchArgs.indexOf('--model') + 1];

test('a claude start without --model passes the kit default model and records its source', (t) => {
  const f = fixture(t);
  const plan = f.start('wmone', { kind: 'claude', dryRun: true });
  assert.equal(plan.model, 'claude-sonnet-5-5');
  assert.equal(plan.modelSource, 'default');
  assert.equal(modelOf(plan.launchArgs), 'claude-sonnet-5-5');
  assert.ok(plan.agentArgs.includes('--model'));
  assert.equal(plan.force, false);
});

test('an explicit sonnet model passes and its source is --model', (t) => {
  const f = fixture(t);
  const plan = f.start('wmtwo', { kind: 'claude', model: 'claude-sonnet-5-5', dryRun: true });
  assert.equal(plan.modelSource, '--model');
  assert.equal(modelOf(plan.launchArgs), 'claude-sonnet-5-5');
});

test('opus without --force fails before any side effect', (t) => {
  const f = fixture(t);
  assert.throws(() => f.start('wmopus', { kind: 'claude', model: 'claude-opus-5-5' }), OPUS_REFUSAL);
  assert.deepEqual(f.sideEffects(), { worktrees: [], panes: [], records: [], branch: '' });
});

test('an alias that maps to opus fails without --force', (t) => {
  const f = fixture(t);
  for (const alias of ['opus', 'claude-opus', 'Opus', 'claude-opus-5-5']) {
    assert.throws(() => f.start('wmalias', { kind: 'claude', model: alias }), OPUS_REFUSAL, alias);
  }
  assert.deepEqual(f.sideEffects(), { worktrees: [], panes: [], records: [], branch: '' });
});

test('opus with --force starts and the plan notes force: true', (t) => {
  const f = fixture(t);
  const plan = f.start('wmforce', { kind: 'claude', model: 'opus', force: true, dryRun: true });
  assert.equal(plan.model, 'claude-opus-5-5');
  assert.equal(plan.force, true);
  assert.equal(modelOf(plan.launchArgs), 'claude-opus-5-5');
});

test('an opus model from the policy preferredModels fails without --force', (t) => {
  const policy = { ...structuredClone(POLICY_DEFAULTS), preferredModels: { claude: 'claude-opus-5-5' } };
  const f = fixture(t, { rules: { policy } });
  assert.throws(() => f.start('wmpolicy', { kind: 'claude' }), OPUS_REFUSAL);
  assert.deepEqual(f.sideEffects(), { worktrees: [], panes: [], records: [], branch: '' });
  const forced = f.start('wmpolicy', { kind: 'claude', force: true, dryRun: true });
  assert.equal(forced.modelSource, 'policy');
  assert.equal(forced.force, true);
});

test('a preferred sonnet model from the policy is reported with the source policy', (t) => {
  const policy = { ...structuredClone(POLICY_DEFAULTS), preferredModels: { claude: 'claude-sonnet-5-5' } };
  const f = fixture(t, { rules: { policy } });
  assert.equal(f.start('wmpref', { kind: 'claude', dryRun: true }).modelSource, 'policy');
});

test('a missing kit default fails with a clear error and does not use the CLI default', (t) => {
  const kitModels = structuredClone(models);
  delete kitModels.kinds.claude.defaultModel;
  const f = fixture(t, { kitModels });
  assert.throws(() => f.start('wmnodef', { kind: 'claude' }), /claude has no default model in kit\/models\.json\. Pass --model\./);
  assert.deepEqual(f.sideEffects(), { worktrees: [], panes: [], records: [], branch: '' });
});

test('codex, opencode and pi keep passing their resolved model', (t) => {
  const f = fixture(t);
  const codex = f.start('wmcodex', { kind: 'codex', dryRun: true });
  assert.equal(codex.launchArgs[codex.launchArgs.indexOf('-m') + 1], models.kinds.codex.defaultModel);
  assert.equal(codex.modelSource, 'default');
  const opencode = f.start('wmopen', { kind: 'opencode', dryRun: true });
  assert.equal(opencode.launchArgs[opencode.launchArgs.indexOf('-m') + 1], models.kinds.opencode.defaultModel);
  const pi = f.start('wmpi', { kind: 'pi', dryRun: true });
  assert.equal(modelOf(pi.launchArgs), models.kinds.pi.defaultModel);
});

test('the dry-run text shows the model source', (t) => {
  const f = fixture(t);
  f.start('wmtext', { kind: 'claude', dryRun: true });
  assert.ok(f.out.some((line) => line.includes('claude / claude-sonnet-5-5 / (none) (model source: default)')), f.out.join('\n'));
});
