import './helpers/test-env.js';
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
  const env = { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch', HERDR_BOSS_DIR: path.join(root, 'data') };
  const start = (name, options) => startWorker(name, { task: 'x', allow: ['src/'], ...options }, {
    config, models: kitModels, herdr, env, rulesFile, output: (line) => out.push(line), browserLookup: () => null,
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
  assert.equal(plan.modelSource, 'flag');
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

const withPolicy = (patch) => ({ policy: { ...structuredClone(POLICY_DEFAULTS), ...patch } });

test('a policy with Opus preferred and no flag starts the kit default Sonnet', (t) => {
  const f = fixture(t, { rules: withPolicy({ preferredModels: { claude: 'claude-opus-5-5' } }) });
  const plan = f.start('wmpolicy', { kind: 'claude', dryRun: true });
  assert.equal(plan.model, 'claude-sonnet-5-5');
  assert.equal(plan.modelSource, 'default');
  assert.equal(plan.force, false);
});

test('a policy that disables the default falls back to the preferred non-Opus model', (t) => {
  const kitModels = structuredClone(models);
  kitModels.kinds.claude.allowedModels.push('claude-sonnet-x');
  const f = fixture(t, { kitModels, rules: withPolicy({ disabledModels: { claude: ['claude-sonnet-5-5'] }, preferredModels: { claude: 'claude-sonnet-x' } }) });
  const plan = f.start('wmfall', { kind: 'claude', dryRun: true });
  assert.equal(plan.model, 'claude-sonnet-x');
  assert.equal(plan.modelSource, 'policy');
});

test('a fallback that would pick Opus fails with the force message and starts with --force', (t) => {
  const f = fixture(t, { rules: withPolicy({ disabledModels: { claude: ['claude-sonnet-5-5'] }, preferredModels: { claude: 'Opus' } }) });
  assert.throws(() => f.start('wmfopus', { kind: 'claude' }), OPUS_REFUSAL);
  assert.deepEqual(f.sideEffects(), { worktrees: [], panes: [], records: [], branch: '' });
  const plan = f.start('wmfopus', { kind: 'claude', force: true, dryRun: true });
  assert.equal(plan.model, 'claude-opus-5-5');
  assert.equal(plan.modelSource, 'policy');
  assert.equal(plan.force, true);
});

test('a default that cannot start and no usable preferred model fail with a clear error', (t) => {
  const f = fixture(t, { rules: withPolicy({ disabledModels: { claude: ['claude-sonnet-5-5'] } }) });
  assert.throws(() => f.start('wmnone', { kind: 'claude' }), /default model claude-sonnet-5-5 of claude cannot start/);
});

test('each Opus spelling needs --force and starts the canonical model with it', (t) => {
  const f = fixture(t);
  for (const variant of ['opus', 'Opus', 'OPUS', 'claude-opus', 'opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5[1m]', 'opus[1m]', ' Claude-Opus-5-5 ']) {
    assert.throws(() => f.start('wmvar', { kind: 'claude', model: variant }), OPUS_REFUSAL, variant);
    const plan = f.start('wmvar', { kind: 'claude', model: variant, force: true, dryRun: true });
    assert.equal(plan.model, 'claude-opus-5-5', variant);
    assert.equal(modelOf(plan.launchArgs), 'claude-opus-5-5', variant);
    assert.equal(plan.force, true);
  }
  assert.deepEqual(f.sideEffects(), { worktrees: [], panes: [], records: [], branch: '' });
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

const READY = '────\n❯\n────\nauto mode';

test('a real start saves the model, its source and force in the run record; a refused start saves none', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-worker-dispatch-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test User');
  git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(root, 'README.md'), 'seed\n');
  git('add', 'README.md');
  git('commit', '-m', 'seed');
  const template = path.join(root, 'brief-template.md');
  fs.writeFileSync(template, 'Worker {{name}}: {{task}} Inputs: {{copyPaths}}');
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ slug: 'herdrboss', briefTemplate: template, worktreeRoot: path.join(root, 'wt') }));
  const config = loadProjectConfig({ cwd: root });
  const rulesFile = path.join(root, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({ updatedAt: new Date().toISOString(), avoidKinds: [] }));
  const calls = [];
  let paneCwd = root;
  const herdr = (args) => {
    calls.push(args.slice(0, 2).join(' '));
    if (args[0] === 'pane' && args[1] === 'get') return args[2] === 'ws:orch'
      ? { pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } }
      : { pane: { pane_id: args[2], workspace_id: 'ws', foreground_cwd: paneCwd } };
    if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: { shell_pid: 10, foreground_process_group_id: 10 } };
    if (args[0] === 'pane' && args[1] === 'read') return { text: '% ' };
    if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
    if (args[0] === 'tab' && args[1] === 'list') return { tabs: [{ tab_id: 'ws:t1', workspace_id: 'ws', label: 'Workers' }] };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [{ pane_id: 'ws:p1', workspace_id: 'ws', tab_id: 'ws:t1', width: 160, height: 45 }] };
    if (args[0] === 'pane' && args[1] === 'split') { paneCwd = args[args.indexOf('--cwd') + 1]; return { pane: { pane_id: 'ws:p2' } }; }
    if (args[0] === 'pane' && args[1] === 'close') return {};
    if (args[0] === 'agent' && args[1] === 'get') return { agent: { agent_status: 'idle' } };
    if (args[0] === 'agent' && args[1] === 'read') return { text: READY };
    if (args[0] === 'agent' && (args[1] === 'start' || args[1] === 'prompt')) return {};
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const env = { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch', HERDR_BOSS_DIR: path.join(root, 'data') };
  const run = (name, options) => startWorker(name, { task: 'x', allow: ['src/'], kind: 'claude', ...options }, { config, models, herdr, env, rulesFile, output: () => {}, browserLookup: () => null });

  assert.throws(() => run('wmrefused', { model: 'opus' }), OPUS_REFUSAL);
  assert.deepEqual(calls.filter((call) => call === 'pane split' || call === 'agent start'), []);
  assert.equal(fs.existsSync(path.join(config.runsPath, 'wmrefused.json')), false);

  const forced = run('wmforced', { model: 'opus', force: true });
  const forcedRecord = JSON.parse(fs.readFileSync(forced.recordFile, 'utf8'));
  assert.equal(forcedRecord.model, 'claude-opus-5-5');
  assert.equal(forcedRecord.modelSource, 'flag');
  assert.equal(forcedRecord.force, true);

  const plain = run('wmplain', {});
  const plainRecord = JSON.parse(fs.readFileSync(plain.recordFile, 'utf8'));
  assert.equal(plainRecord.model, 'claude-sonnet-5-5');
  assert.equal(plainRecord.modelSource, 'default');
  assert.equal('force' in plainRecord, false);
});
