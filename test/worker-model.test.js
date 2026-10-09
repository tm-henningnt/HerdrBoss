import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { loadModels, loadProjectConfig } from '../src/kit/config.js';
import { startWorker } from '../src/kit/workers.js';
import { runKitCommand } from '../src/kit/cli.js';
import { POLICY_DEFAULTS } from '../src/control.js';
import { writeDiskDiagnosis } from '../src/disk-diagnosis.js';

const models = loadModels();
const OPUS_REFUSAL = { message: "claude-opus-5-5 needs the Owner's approval. Ask the Owner to turn on the setting opus.allowWithoutForce." };

function fixture(t, { rules = {}, kitModels = models, freeSpaceReader = () => ({ bsize: 1, bavail: 8 * 1024 ** 3 }), serviceConfig = { worktrees: { minFreeGb: 8 } }, diagnosticScan, diagnosisWrite } = {}) {
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
    freeSpaceReader, serviceConfig, diagnosticScan, diagnosisWrite,
  });
  const sideEffects = () => ({
    worktrees: fs.existsSync(path.join(root, 'wt')) ? fs.readdirSync(path.join(root, 'wt')) : [],
    panes: calls.filter((args) => ['split', 'create', 'start', 'prompt'].includes(args[1])),
    records: fs.existsSync(config.runsPath) ? fs.readdirSync(config.runsPath) : [],
    branch: execFileSync('git', ['-C', root, 'branch', '--list', 'wm*'], { encoding: 'utf8' }).trim(),
  });
  return { root, config, rulesFile, start, sideEffects, out };
}

const modelOf = (launchArgs) => launchArgs[launchArgs.indexOf(launchArgs.includes('--model') ? '--model' : '-m') + 1];

test('a claude start without --model passes the kit default model and records its source', (t) => {
  const f = fixture(t);
  const plan = f.start('wmone', { kind: 'claude', dryRun: true });
  assert.equal(plan.model, 'claude-sonnet-5-5');
  assert.equal(plan.effort, null);
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

test('Haiku accepts each supported effort and passes it to Claude', (t) => {
  const f = fixture(t);
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const plan = f.start(`wmhaiku-${effort}`, { kind: 'claude', model: 'claude-haiku-5-5', effort, dryRun: true });
    assert.equal(plan.model, 'claude-haiku-5-5');
    assert.equal(plan.effort, effort);
    assert.ok(plan.launchArgs.includes('--effort'));
    assert.equal(plan.launchArgs[plan.launchArgs.indexOf('--effort') + 1], effort);
  }
});

test('Haiku defaults to medium effort', (t) => {
  const f = fixture(t);
  const plan = f.start('wmhaiku-default', { kind: 'claude', model: 'claude-haiku-5-5', dryRun: true });
  assert.equal(plan.effort, 'medium');
  assert.equal(plan.effortSource, 'default');
  assert.deepEqual(plan.launchArgs.slice(-2), ['--effort', 'medium']);
});

test('Haiku refuses an unknown effort before any side effect', (t) => {
  const f = fixture(t);
  assert.throws(() => f.start('wmhaiku-unknown', { kind: 'claude', model: 'claude-haiku-5-5', effort: 'ultra' }), /Effort ultra is not allowed for claude/);
  assert.deepEqual(f.sideEffects(), { worktrees: [], panes: [], records: [], branch: '' });
});

test('Claude models without an effort setting keep refusing --effort', (t) => {
  const f = fixture(t);
  assert.throws(() => f.start('wmsonnet-effort', { kind: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' }), /Effort medium is not allowed for claude/);
  assert.deepEqual(f.sideEffects(), { worktrees: [], panes: [], records: [], branch: '' });
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
  const plan = f.start('wmforce', { kind: 'claude', model: 'opus', force: true, reason: 'owner approved Opus', dryRun: true });
  assert.equal(plan.model, 'claude-opus-5-5');
  assert.equal(plan.force, true);
  assert.equal(modelOf(plan.launchArgs), 'claude-opus-5-5');
});

test('worker start refuses when the worktree volume is below its configured free-space floor', (t) => {
  const diagnosis = {
    largestDiskUsers: [{ path: '/fixture/Projects/cache', sizeBytes: 2048 }],
    newestLargeTempDirectories: [{ path: '/fixture/tmp/new', sizeBytes: 4096 }],
    scanComplete: true,
  };
  let scans = 0;
  let writes = 0;
  const f = fixture(t, {
    freeSpaceReader: () => ({ bsize: 1, bavail: Math.floor(4.7 * 1024 ** 3) }),
    diagnosticScan: () => { scans += 1; return diagnosis; },
    diagnosisWrite: (value, options) => {
      writes += 1;
      assert.deepEqual(value.largestDiskUsers, diagnosis.largestDiskUsers);
      assert.deepEqual(value.newestLargeTempDirectories, diagnosis.newestLargeTempDirectories);
      assert.equal(value.minFreeGb, 8);
      assert.equal(typeof value.recordedAt, 'string');
      writeDiskDiagnosis(value, options);
    },
  });
  assert.throws(() => f.start('wmdisk', { kind: 'codex' }), (error) => {
    assert.match(error.message, /4\.7 GB/);
    assert.match(error.message, /8 GB/);
    assert.match(error.message, /worker worktree volume/);
    assert.match(error.message, /Herdr Boss data-directory volume/);
    assert.match(error.message, /worktrees\.minFreeGb/);
    assert.match(error.message, /herdr-boss worktree prune --apply/);
    assert.match(error.message, /herdr-boss worktree disk/);
    return true;
  });
  assert.equal(scans, 1);
  assert.equal(writes, 1);
  const audit = JSON.parse(fs.readFileSync(path.join(f.root, 'data', 'action-audit.jsonl'), 'utf8').trim());
  assert.deepEqual(audit.diagnosis.largestDiskUsers, diagnosis.largestDiskUsers);
  assert.deepEqual(audit.diagnosis.newestLargeTempDirectories, diagnosis.newestLargeTempDirectories);
  assert.equal(typeof audit.diagnosis.recordedAt, 'string');
  assert.match(fs.readFileSync(path.join(f.root, 'data', 'bulletin.md'), 'utf8'), /fixture\/Projects\/cache/);
  assert.deepEqual(f.sideEffects(), { worktrees: [], panes: [], records: [], branch: '' });
});

test('the disk guard reads the resolved worktree parent for a relative configured root', (t) => {
  const measuredPaths = [];
  const f = fixture(t, { freeSpaceReader: (directory) => { measuredPaths.push(directory); return { bsize: 1, bavail: 1024 ** 3 }; } });
  f.config.worktreeRoot = 'relative-worktrees';
  fs.mkdirSync(f.config.worktreeParent, { recursive: true });
  fs.mkdirSync(path.join(f.root, 'data'), { recursive: true });
  assert.throws(() => f.start('wmvolume', { kind: 'codex' }), /at least 8 GB free/);
  assert.deepEqual(measuredPaths, [f.config.worktreeParent, path.join(f.root, 'data')]);
});

test('the disk guard refuses when the data-directory volume is below the floor', (t) => {
  const calls = [];
  let f;
  f = fixture(t, {
    freeSpaceReader: (directory) => {
      calls.push(directory);
      return { bsize: 1, bavail: directory === path.join(f.root, 'data') ? Math.floor(4.7 * 1024 ** 3) : 12 * 1024 ** 3 };
    },
    diagnosticScan: () => ({ largestDiskUsers: [], newestLargeTempDirectories: [], scanComplete: true }),
    diagnosisWrite: () => {},
  });
  fs.mkdirSync(path.join(f.root, 'data'));
  fs.mkdirSync(f.config.worktreeParent, { recursive: true });

  assert.throws(() => f.start('wmdatadisk', { kind: 'codex' }), (error) => {
    assert.match(error.message, /worktree volume/);
    assert.match(error.message, /Herdr Boss data-directory volume/);
    assert.match(error.message, /4\.7 GB/);
    return true;
  });
  assert.deepEqual(calls, [f.config.worktreeParent, path.join(f.root, 'data')]);
  assert.deepEqual(f.sideEffects(), { worktrees: [], panes: [], records: [], branch: '' });
});

test('a disk diagnosis scan failure keeps the low-space refusal', (t) => {
  const f = fixture(t, {
    freeSpaceReader: () => ({ bsize: 1, bavail: 1024 ** 3 }),
    diagnosticScan: () => { throw new Error('fixture scan failure'); },
  });
  assert.throws(() => f.start('wmdiskfail', { kind: 'codex' }), /at least 8 GB free/);
});

test('a low-space dry run refuses without writing a diagnosis or audit row', (t) => {
  let scans = 0;
  let writes = 0;
  const f = fixture(t, {
    freeSpaceReader: () => ({ bsize: 1, bavail: 1024 ** 3 }),
    diagnosticScan: () => { scans += 1; return { largestDiskUsers: [], newestLargeTempDirectories: [], scanComplete: true }; },
    diagnosisWrite: () => { writes += 1; },
  });
  assert.throws(() => f.start('wmdiskdry', { kind: 'codex', dryRun: true }), /at least 8 GB free/);
  assert.equal(scans, 0);
  assert.equal(writes, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'data', 'action-audit.jsonl')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'data', 'bulletin.md')), false);
});

test('worker start requires a reason whenever --force is present', (t) => {
  const f = fixture(t);
  assert.throws(() => f.start('wmreason', { kind: 'codex', force: true, dryRun: true }), /--force needs --reason TEXT/);
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

test('an unavailable default falls back to the next available model on the same lane only without --model', (t) => {
  const unavailable = {
    model: 'gpt-6-luna', lane: 'codex', provider: 'codex', kind: 'codex',
    retryAt: Date.now() + 30 * 60 * 1000, reason: '503 service_overloaded', label: 'overloaded',
  };
  const f = fixture(t, { rules: { unavailableModels: { [unavailable.model]: unavailable } } });
  const fallback = f.start('wmnext', { kind: 'codex', dryRun: true });
  assert.equal(fallback.model, 'gpt-6.1-sol');
  assert.equal(fallback.modelSource, 'fallback');
  assert.deepEqual(fallback.modelFallback, {
    from: 'gpt-6-luna', retryAt: unavailable.retryAt, reason: '503 service_overloaded',
  });
  assert.equal(modelOf(fallback.launchArgs), 'gpt-6.1-sol');

  const explicit = f.start('wmexplicit', { kind: 'codex', model: 'gpt-6-luna', dryRun: true });
  assert.equal(explicit.model, 'gpt-6-luna');
  assert.equal(explicit.modelSource, 'flag');
  assert.equal(explicit.modelFallback, undefined);
});

test('engine-shaped unavailable model records make the default fall back', (t) => {
  const unavailable = {
    model: 'gpt-6-luna', kind: 'codex', provider: 'codex', lane: 'codex',
    retryAt: Date.now() + 30 * 60 * 1000, reason: 'overloaded', label: 'overloaded',
  };
  // Engine writes snap.unavailableModels as this array before serializing rules.json.
  const engineSnapshot = { unavailableModels: [unavailable] };
  const f = fixture(t, { rules: { unavailableModels: engineSnapshot.unavailableModels } });
  const fallback = f.start('wmengine-shape', { kind: 'codex', dryRun: true });
  assert.equal(fallback.model, 'gpt-6.1-sol');
  assert.equal(fallback.modelSource, 'fallback');
  assert.deepEqual(fallback.modelFallback, {
    from: 'gpt-6-luna', retryAt: unavailable.retryAt, reason: 'overloaded',
  });
});

test('a cooldown for a shared model name does not apply to another kind', (t) => {
  const shared = 'shared-fixture-model';
  const kitModels = structuredClone(models);
  for (const kind of ['opencode', 'pi']) {
    kitModels.kinds[kind].allowedModels.push(shared);
    kitModels.kinds[kind].defaultModel = shared;
  }
  const unavailable = {
    model: shared, kind: 'opencode', provider: null, lane: 'unmetered',
    retryAt: Date.now() + 30 * 60 * 1000, reason: 'Free usage exceeded', label: 'Free usage exceeded',
  };
  const f = fixture(t, { kitModels, rules: { unavailableModels: { [shared]: unavailable } } });
  const plan = f.start('wmshared-kind', { kind: 'pi', dryRun: true });
  assert.equal(plan.model, shared);
  assert.equal(plan.modelSource, 'default');
});

test('the models command shows active model cooldowns', (t) => {
  const retryAt = Date.now() + 60 * 60 * 1000;
  const f = fixture(t, { rules: { unavailableModels: {
    'gpt-6-luna': { model: 'gpt-6-luna', kind: 'codex', provider: 'codex', lane: 'codex', retryAt, reason: 'Free usage exceeded', label: 'Free usage exceeded' },
  } } });
  const output = [];
  const result = runKitCommand('models', [], { rulesFile: path.join(f.root, 'rules.json'), output: (line) => output.push(line) });
  assert.deepEqual(result.codex.unavailableModels, [
    { model: 'gpt-6-luna', kind: 'codex', provider: 'codex', lane: 'codex', retryAt, reason: 'Free usage exceeded', label: 'Free usage exceeded' },
  ]);
  assert.match(output[0], /"unavailableModels"/);
});

test('the models command scopes a shared model cooldown to its recorded kind', (t) => {
  const shared = 'opencode-go/deepseek-v4.1-flash';
  const retryAt = Date.now() + 30 * 60 * 1000;
  const f = fixture(t, { rules: { unavailableModels: {
    [shared]: { model: shared, kind: 'opencode', provider: 'opencodego', lane: 'opencodego', retryAt, reason: 'overloaded', label: 'overloaded' },
  } } });
  const result = runKitCommand('models', [], { rulesFile: path.join(f.root, 'rules.json'), output: () => {} });
  assert.equal(result.opencode.unavailableModels[0].model, shared);
  assert.equal(result.pi.unavailableModels, undefined, 'the same model string under Pi stays available');
});

test('a fallback that would pick Opus fails with the force message and starts with --force', (t) => {
  const f = fixture(t, { rules: withPolicy({ disabledModels: { claude: ['claude-sonnet-5-5'] }, preferredModels: { claude: 'Opus' } }) });
  assert.throws(() => f.start('wmfopus', { kind: 'claude' }), OPUS_REFUSAL);
  assert.deepEqual(f.sideEffects(), { worktrees: [], panes: [], records: [], branch: '' });
  const plan = f.start('wmfopus', { kind: 'claude', force: true, reason: 'owner approved Opus', dryRun: true });
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
    const plan = f.start('wmvar', { kind: 'claude', model: variant, force: true, reason: 'owner approved Opus', dryRun: true });
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
    if (args[0] === 'agent' && args[1] === 'read') return { text: `${READY}\n› code\n? for shortcuts` };
    if (args[0] === 'agent' && (args[1] === 'start' || args[1] === 'prompt')) return {};
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const env = { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch', HERDR_BOSS_DIR: path.join(root, 'data') };
  const run = (name, options) => startWorker(name, { task: 'x', allow: ['src/'], kind: 'claude', ...options }, { config, models, herdr, env, rulesFile, output: () => {}, browserLookup: () => null });

  assert.throws(() => run('wmrefused', { model: 'opus' }), OPUS_REFUSAL);
  assert.deepEqual(calls.filter((call) => call === 'pane split' || call === 'agent start'), []);
  assert.equal(fs.existsSync(path.join(config.runsPath, 'wmrefused.json')), false);

  const forced = run('wmforced', { model: 'opus', force: true, reason: 'owner approved Opus api_key="sample"' });
  const forcedRecord = JSON.parse(fs.readFileSync(forced.recordFile, 'utf8'));
  assert.equal(forcedRecord.model, 'claude-opus-5-5');
  assert.equal(forcedRecord.modelSource, 'flag');
  assert.equal(forcedRecord.force, true);
  const forcedAction = JSON.parse(fs.readFileSync(path.join(root, 'data', 'action-audit.jsonl'), 'utf8').trim());
  assert.deepEqual([forcedAction.command, forcedAction.project, forcedAction.workerName, forcedAction.refusalKind], ['worker start', 'herdrboss', 'wmforced', 'opus-approval']);
  assert.equal(forcedAction.reason, 'owner approved Opus api_key=[REDACTED]');

  const plain = run('wmplain', {});
  const plainRecord = JSON.parse(fs.readFileSync(plain.recordFile, 'utf8'));
  assert.equal(plainRecord.model, 'claude-sonnet-5-5');
  assert.equal(plainRecord.modelSource, 'default');
  assert.equal('force' in plainRecord, false);

  fs.writeFileSync(rulesFile, JSON.stringify({ updatedAt: new Date().toISOString(), avoidKinds: [], unavailableModels: {
    'gpt-6-luna': { model: 'gpt-6-luna', kind: 'codex', provider: 'codex', lane: 'codex', retryAt: Date.now() + 1800000, reason: 'overloaded', label: 'overloaded' },
  } }));
  const fallback = run('wmrecord', { kind: 'codex' });
  const fallbackRecord = JSON.parse(fs.readFileSync(fallback.recordFile, 'utf8'));
  assert.equal(fallbackRecord.model, 'gpt-6.1-sol');
  assert.equal(fallbackRecord.modelSource, 'fallback');
  assert.deepEqual(fallbackRecord.modelFallback, {
    from: 'gpt-6-luna', retryAt: JSON.parse(fs.readFileSync(rulesFile, 'utf8')).unavailableModels['gpt-6-luna'].retryAt, reason: 'overloaded',
  });
});

test('models disable and enable keep a launch record that the models command shows', (t) => {
  const f = fixture(t);
  const env = { HERDR_BOSS_DIR: path.join(f.root, 'data') };
  const run = (args) => runKitCommand('models', args, { rulesFile: f.rulesFile, env, output: () => {} });
  const disabled = run(['disable', 'opencode/opencode/fledge-alpha-free', '--reason', 'not available in your country']);
  assert.equal(disabled.untilReenabled, true);
  assert.equal(disabled.provider, null);
  const listed = run([]).opencode.unavailableModels;
  assert.deepEqual(listed.map((item) => item.model), ['opencode/fledge-alpha-free']);
  assert.equal(run(['enable', 'opencode/opencode/fledge-alpha-free']).enabled, true);
  assert.equal(run([]).opencode.unavailableModels, undefined);
  assert.equal(run(['enable', 'opencode/opencode/fledge-alpha-free']).enabled, false);
  assert.throws(() => run(['enable', 'opencode/not-a-model']), /not allowed for opencode/);
  assert.throws(() => run(['enable']), /Usage: models enable/);
});

test('the kit lists both trial models for the opencode harness only', () => {
  const trial = ['opencode/ling-3.1-flash-free', 'opencode/fledge-alpha-free', 'opencode/exo-free', 'opencode/step-5-preview-free'];
  assert.deepEqual(models.kinds.opencode.trialModels, trial);
  for (const model of trial) {
    assert.ok(models.kinds.opencode.allowedModels.includes(model));
    assert.equal(models.kinds.pi.allowedModels.includes(model), false);
  }
});

test('opus.allowWithoutForce lets an Opus start pass without --force', (t) => {
  const f = fixture(t, { rules: withPolicy({ opus: { allowWithoutForce: true, maxConcurrent: 2 } }) });
  const plan = f.start('wmallow', { kind: 'claude', model: 'claude-opus-5-5', dryRun: true });
  assert.equal(plan.model, 'claude-opus-5-5');
  assert.equal(plan.force, true);
});

test('opus.allowWithoutForce false keeps the refusal and names the setting', (t) => {
  const f = fixture(t, { rules: withPolicy({ opus: { allowWithoutForce: false, maxConcurrent: 2 } }) });
  assert.throws(() => f.start('wmdeny', { kind: 'claude', model: 'claude-opus-5-5' }), (error) => {
    assert.match(error.message, /opus\.allowWithoutForce/);
    assert.doesNotMatch(error.message, /--force/);
    return true;
  });
  assert.deepEqual(f.sideEffects(), { worktrees: [], panes: [], records: [], branch: '' });
});

test('opus.maxConcurrent refuses an allowed Opus start at the limit and names the setting', (t) => {
  const f = fixture(t, { rules: { ...withPolicy({ opus: { allowWithoutForce: true, maxConcurrent: 2 } }), control: { runningOpus: 2 } } });
  assert.throws(() => f.start('wmcap', { kind: 'claude', model: 'claude-opus-5-5' }), (error) => {
    assert.match(error.message, /limit of 2 running Opus workers \(setting opus\.maxConcurrent\)/);
    assert.doesNotMatch(error.message, /--force/);
    return true;
  });
  assert.deepEqual(f.sideEffects(), { worktrees: [], panes: [], records: [], branch: '' });
  const below = fixture(t, { rules: { ...withPolicy({ opus: { allowWithoutForce: true, maxConcurrent: 2 } }), control: { runningOpus: 1 } } });
  assert.equal(below.start('wmcap', { kind: 'claude', model: 'claude-opus-5-5', dryRun: true }).model, 'claude-opus-5-5');
});

test('--force still starts Opus at the opus.maxConcurrent limit', (t) => {
  const f = fixture(t, { rules: { ...withPolicy({ opus: { allowWithoutForce: true, maxConcurrent: 1 } }), control: { runningOpus: 3 } } });
  assert.equal(f.start('wmforce', { kind: 'claude', model: 'claude-opus-5-5', force: true, reason: 'owner approved Opus', dryRun: true }).force, true);
});

test('the kit lists the pi trial model step-5-preview-free for the pi harness only', () => {
  assert.deepEqual(models.kinds.pi.trialModels, ['opencode-go/step-5-preview-free']);
  assert.ok(models.kinds.pi.allowedModels.includes('opencode-go/step-5-preview-free'));
  assert.equal(models.kinds.opencode.allowedModels.includes('opencode-go/step-5-preview-free'), false);
});
