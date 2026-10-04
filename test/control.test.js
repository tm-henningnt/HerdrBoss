import './helpers/test-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { deriveControl, loadPolicy, machineLimits, POLICY_DEFAULTS, providerFor, selectModel, validatePolicy } from '../src/control.js';
import * as controlModule from '../src/control.js';
import { validateUsage, usageProvider, usageSummary } from '../src/usage.js';
import { loadModels } from '../src/kit/config.js';
import { broadcastTargets, evaluate, renderBulletin } from '../src/rules.js';
import { alertPromptDue, Engine, orchestratorCanReceiveNotice, pruneInactiveDiskPromptRecords } from '../src/engine.js';
import { collectMissingWorktreeProcesses } from '../src/collect.js';

const models = loadModels();
// Fixtures for the goal and ordering rules use the old pace rule: no tolerance and no minimum use.
const legacyPace = { paceTolerancePoints: 0, paceMinUsePercent: 0 };
const policy = (patch = {}) => ({ ...structuredClone(POLICY_DEFAULTS), ...patch });
// Fixture unmetered Pi models. The kit Pi allow-list holds only metered opencode-go/ models.
const fixturePiModels = ['fixturezen/free-a', 'fixturezen/free-b'];
const fixtureModels = structuredClone(models);
fixtureModels.kinds.pi.allowedModels.push(...fixturePiModels);
const snapshot = () => ({
  projects: [{ slug: 'a', workspace: 'w1' }, { slug: 'b', workspace: 'w2' }],
  herdr: {
    workspaces: [{ id: 'w1', label: 'A' }, { id: 'w2', label: 'B' }],
    panes: [
      { id: 'w1:p1', workspace: 'w1', orch: true, agent: 'claude', status: 'idle', sessionId: 's1' },
      { id: 'w2:p1', workspace: 'w2', orch: true, agent: 'codex', status: 'working', sessionId: 's2' },
      { id: 'w2:p2', workspace: 'w2', orch: false, agent: 'pi', status: 'working' },
    ],
  },
  quotas: [{ provider: 'claude', windows: [{ key: 'secondary', label: 'Weekly', usedPercent: 88, willLast: false, etaSeconds: 3000, resetsAt: '2026-09-25T00:00:00Z' }] }],
});

test('engine state includes configured quota thresholds', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-engine-quota-thresholds-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const engineUrl = new URL('../src/engine.js', import.meta.url).href;
  const configUrl = new URL('../src/config.js', import.meta.url).href;
  const script = `
import { Engine } from ${JSON.stringify(engineUrl)};
import { loadConfig } from ${JSON.stringify(configUrl)};
const cfg = loadConfig();
cfg.quota = { warnPercent: 83, criticalPercent: 96 };
const engine = new Engine(cfg, { push: false, act: false, collectors: {
  collectHerdr: async () => ({ panes: [], workspaces: [] }),
  collectMachine: async () => null,
  collectProcesses: async () => new Map(),
  collectQuotas: async () => [],
  collectWorktreeCounts: async () => ({}),
  collectCwdProcesses: async () => [],
  collectMissingWorktreeProcesses: async () => [],
} });
const state = await engine.tick();
console.log(JSON.stringify(state.quotaThresholds));
`;
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HOME: temp, HERDR_BOSS_DIR: path.join(temp, 'data'), HERDR_BOSS_LIVE_DIR: path.join(temp, 'live'), NODE_TEST_CONTEXT: '1' },
    encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(result), { warnPercent: 83, criticalPercent: 96 });
});

test('Engine applies the configured night worker cap to global control and preserves project shares', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-engine-night-cap-'));
  const data = path.join(temp, 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
    watch: { maxWorkers: 3, maxWorkersByLane: { unmetered: 2, codex: 1, claude: null, opencodego: null } },
  }));
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify({ maxWorkers: 8, projects: {
    alpha: { share: 60, mode: 'active' }, beta: { share: 40, mode: 'paused' },
  } }));
  fs.writeFileSync(path.join(data, 'night.json'), JSON.stringify({ active: true, since: '2026-09-26T20:00:00.000Z', until: '2099-09-27T05:30:00.000Z' }));
  const repo = path.join(temp, 'project');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, '.herdr-boss.json'), JSON.stringify({ slug: 'alpha' }));
  const runs = path.join(repo, '.orchestration', 'runs');
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, 'free-worker.json'), JSON.stringify({ pane: 'w1:p2', kind: 'opencode', model: 'opencode/free', provider: null }));
  fs.writeFileSync(path.join(runs, 'metered-worker.json'), JSON.stringify({ pane: 'w2:p2', kind: 'pi', model: 'opencode-go/model', provider: 'opencodego' }));
  fs.writeFileSync(path.join(data, 'project-repos.json'), JSON.stringify([{ slug: 'alpha', repo }]));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const engineUrl = new URL('../src/engine.js', import.meta.url).href;
  const configUrl = new URL('../src/config.js', import.meta.url).href;
  const script = `
import fs from 'node:fs';
import path from 'node:path';
import { Engine } from ${JSON.stringify(engineUrl)};
import { loadConfig } from ${JSON.stringify(configUrl)};
let now = Date.parse('2026-09-26T22:00:00.000Z');
Date.now = () => now;
const data = process.env.HERDR_BOSS_DIR;
const engine = new Engine(loadConfig(), { push: false, act: false, collectors: {
  collectHerdr: async () => ({
    workspaces: [{ id: 'w1', label: 'Alpha' }, { id: 'w2', label: 'Beta' }],
    panes: [
      { id: 'w1:p1', workspace: 'w1', agent: 'codex', status: 'working' },
      { id: 'w1:p2', workspace: 'w1', agent: 'opencode', name: 'free-worker', status: 'working' },
      { id: 'w2:p2', workspace: 'w2', agent: 'pi', name: 'metered-worker', status: 'working' },
    ],
  }),
  collectMachine: async () => null,
  collectProcesses: async () => new Map(),
  collectQuotas: async () => [],
  collectWorktreeCounts: async () => ({}),
  collectCwdProcesses: async () => [],
  collectMissingWorktreeProcesses: async () => [],
  collectPiModels: async () => ({ models: [] }),
} });
const active = await engine.tick();
const activeRules = JSON.parse(fs.readFileSync(path.join(data, 'rules.json'), 'utf8'));
fs.writeFileSync(path.join(data, 'night.json'), JSON.stringify({ active: false }));
now += 1000;
const day = await engine.tick();
process.stdout.write(JSON.stringify({
  activeCap: active.control.maxWorkers,
  activeSlots: Object.values(active.control.projects).reduce((sum, project) => sum + project.baseSlots, 0),
  borrowedSlots: active.control.projects.alpha.borrowed,
  effectiveSlots: Object.values(active.control.projects).reduce((sum, project) => sum + project.slots, 0),
  activeLaneCounts: activeRules.control.runningByLane,
  activeNight: activeRules.night,
  dayCap: day.control.maxWorkers,
  daySlots: Object.values(day.control.projects).reduce((sum, project) => sum + project.baseSlots, 0),
}));
`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HOME: temp, HERDR_BOSS_DIR: data, HERDR_BOSS_LIVE_DIR: path.join(temp, 'live'), NODE_TEST_CONTEXT: '1' },
    encoding: 'utf8',
  }));
  assert.equal(result.activeCap, 3);
  assert.equal(result.activeSlots, 3, 'project shares distribute the night global cap');
  assert.equal(result.borrowedSlots, 1, 'night cap preserves idle project slot lending');
  assert.equal(result.effectiveSlots, 3);
  assert.deepEqual(result.activeLaneCounts, { codex: 1, unmetered: 1, opencodego: 1 });
  assert.deepEqual(result.activeNight, {
    active: true, maxWorkersByLane: { unmetered: 2, codex: 1, claude: null, opencodego: null },
  });
  assert.equal(result.dayCap, 8, 'the day worker cap applies when the watch is inactive');
  assert.equal(result.daySlots, 8);
});

test('engine caches orphaned worktree scans until the worktree scan interval and keeps the last success on error', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-engine-scan-cache-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const engineUrl = new URL('../src/engine.js', import.meta.url).href;
  const configUrl = new URL('../src/config.js', import.meta.url).href;
  const script = `
import { Engine } from ${JSON.stringify(engineUrl)};
import { loadConfig } from ${JSON.stringify(configUrl)};
let now = Date.parse('2026-09-26T12:00:00.000Z');
Date.now = () => now;
const calls = { herdr: 0, counts: 0, cwd: 0, missing: 0 };
const engine = new Engine(loadConfig(), { push: false, act: false, collectors: {
  collectHerdr: async () => {
    calls.herdr += 1;
    if (calls.herdr === 6) throw new Error('snapshot unavailable');
    return { panes: [], workspaces: [] };
  },
  collectMachine: async () => null,
  collectProcesses: async () => new Map(),
  collectQuotas: async () => null,
  collectWorktreeCounts: async () => ({ scan: ++calls.counts }),
  collectCwdProcesses: async () => { calls.cwd += 1; return []; },
  collectMissingWorktreeProcesses: async () => {
    calls.missing += 1;
    if (calls.missing === 2) throw new Error('scheduled scan failed');
    return [{ pid: 100 + calls.missing, ppid: 1, cwd: '/tmp/missing/file', worktree: '/tmp/missing', workspace: 'w1' }];
  },
} });
const scans = [];
scans.push(await engine.tick());
now += 1000;
scans.push(await engine.tick());
now += 5 * 60 * 1000;
scans.push(await engine.tick());
now += 1000;
scans.push(await engine.tick());
now += 5 * 60 * 1000;
scans.push(await engine.tick());
now += 5 * 60 * 1000;
scans.push(await engine.tick());
console.log(JSON.stringify({ calls, scans: scans.map(({ worktreeCounts, orphanedWorktreeProcesses, errors }) => ({ worktreeCounts, orphanedWorktreeProcesses, errors })) }));
`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HOME: temp, HERDR_BOSS_DIR: path.join(temp, 'data'), NODE_TEST_CONTEXT: '1' },
    encoding: 'utf8',
  }));

  assert.deepEqual(result.calls, { herdr: 6, counts: 3, cwd: 3, missing: 3 });
  assert.deepEqual(result.scans[0].worktreeCounts, { scan: 1 });
  assert.deepEqual(result.scans[1].worktreeCounts, { scan: 1 });
  assert.deepEqual(result.scans[1].orphanedWorktreeProcesses, result.scans[0].orphanedWorktreeProcesses);
  assert.deepEqual(result.scans[2].worktreeCounts, { scan: 2 });
  assert.deepEqual(result.scans[2].orphanedWorktreeProcesses, result.scans[1].orphanedWorktreeProcesses);
  assert.ok(result.scans[2].errors.some((error) => /missing worktree process check: scheduled scan failed/.test(error)));
  assert.deepEqual(result.scans[3].worktreeCounts, { scan: 2 });
  assert.deepEqual(result.scans[3].orphanedWorktreeProcesses, result.scans[1].orphanedWorktreeProcesses);
  assert.deepEqual(result.scans[4].worktreeCounts, { scan: 3 });
  assert.equal(result.scans[4].orphanedWorktreeProcesses[0].pid, 103);
  assert.deepEqual(result.scans[5].worktreeCounts, { scan: 3 });
  assert.deepEqual(result.scans[5].orphanedWorktreeProcesses, result.scans[4].orphanedWorktreeProcesses);
  assert.ok(result.scans[5].errors.some((error) => /herdr: snapshot unavailable/.test(error)));
});

test('Engine exhausts only the free model from its orchestrator run record until retry', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-engine-free-exhaustion-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const engineUrl = new URL('../src/engine.js', import.meta.url).href;
  const configUrl = new URL('../src/config.js', import.meta.url).href;
  const script = `
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Engine } from ${JSON.stringify(engineUrl)};
import { loadConfig } from ${JSON.stringify(configUrl)};
const data = process.env.HERDR_BOSS_DIR;
const checkout = path.join(data, 'checkout');
const worker = path.join(data, 'worker');
fs.mkdirSync(checkout, { recursive: true });
execFileSync('git', ['init', '-b', 'main', checkout], { stdio: 'ignore' });
fs.writeFileSync(path.join(checkout, '.herdr-boss.json'), JSON.stringify({ slug: 'sample', runsDir: '.orchestration/runs' }));
fs.writeFileSync(path.join(checkout, 'tracked.txt'), 'tracked');
execFileSync('git', ['-C', checkout, 'add', '.herdr-boss.json', 'tracked.txt'], { stdio: 'ignore' });
execFileSync('git', ['-C', checkout, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'], { stdio: 'ignore' });
execFileSync('git', ['-C', checkout, 'worktree', 'add', '-b', 'worker-a', worker], { stdio: 'ignore' });
fs.mkdirSync(path.join(checkout, '.orchestration/runs'), { recursive: true });
const retryAt = Date.parse('2026-09-26T15:48:00.000Z');
fs.writeFileSync(path.join(checkout, '.orchestration/runs/worker-a.json'), JSON.stringify({
  name: 'worker-a', kind: 'opencode', model: 'opencode/big-pickle', worktree: worker, pane: 'w1:p2', startedAt: '2026-09-26T09:00:00.000Z',
}));
fs.mkdirSync(path.join(data, 'projects'), { recursive: true });
fs.writeFileSync(path.join(data, 'projects/sample.json'), JSON.stringify({ project: 'Sample', workspace: 'w1' }));
let now = Date.parse('2026-09-26T10:00:00.000Z');
Date.now = () => now;
const panes = [
  { id: 'w1:p1', workspace: 'w1', workspaceLabel: 'Sample', label: 'orch', orch: true, agent: 'codex', status: 'working', cwd: checkout },
  { id: 'w1:p2', workspace: 'w1', workspaceLabel: 'Sample', orch: false, agent: 'opencode', name: 'worker-a', status: 'idle', cwd: worker },
];
const engine = new Engine(loadConfig(), { push: false, act: false, collectors: {
  collectHerdr: async () => ({ workspaces: [{ id: 'w1', label: 'Sample' }], panes }),
  readWorkerScreen: async () => 'Free usage exceeded. Retry in 5h 48m. raw-token=do-not-save',
  collectMachine: async () => null,
  collectProcesses: async () => new Map(),
  collectQuotas: async () => [],
  collectWorktreeCounts: async () => ({}),
  collectCwdProcesses: async () => [],
  collectMissingWorktreeProcesses: async () => [],
} });
const first = await engine.tick();
const firstMemory = JSON.parse(fs.readFileSync(path.join(data, 'memory.json'), 'utf8'));
now = retryAt;
const second = await engine.tick();
console.log(JSON.stringify({
  failed: first.herdr.panes.find((pane) => pane.id === 'w1:p2').status,
  exhausted: first.lanes.unmetered.exhausted,
  availableBeforeRetry: first.lanes.unmetered.byProject.sample.opencode,
  rememberedModels: firstMemory.exhaustedFreeModels,
  availableAtRetry: second.lanes.unmetered.byProject.sample.opencode,
  exhaustedAtRetry: second.lanes.unmetered.exhausted,
}));
`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HOME: temp, HERDR_BOSS_DIR: path.join(temp, 'data'), HERDR_BOSS_LIVE_DIR: path.join(temp, 'live'), NODE_TEST_CONTEXT: '1' },
    encoding: 'utf8',
  }));
  assert.equal(result.failed, 'failed');
  assert.deepEqual(result.exhausted, [{
    model: 'opencode/big-pickle', retryAt: Date.parse('2026-09-26T15:48:00.000Z'), projects: ['sample'], kinds: ['opencode'],
  }]);
  assert.ok(result.availableBeforeRetry.length > 0, 'other OpenCode models remain available');
  assert.equal(result.availableBeforeRetry.includes('opencode/big-pickle'), false);
  assert.equal(result.rememberedModels['opencode/big-pickle'].retryAt, Date.parse('2026-09-26T15:48:00.000Z'));
  assert.ok(result.availableAtRetry.includes('opencode/big-pickle'));
  assert.deepEqual(result.exhaustedAtRetry, []);
});

test('policy only permits project exclusions from global availability', () => {
  const p = policy({ projects: { a: { share: 100, mode: 'auto', excludedKinds: ['codex'], excludedModels: [] } } });
  assert.deepEqual(validatePolicy(p, models), []);
  p.allowedKinds = ['claude'];
  assert.match(validatePolicy(p, models).join(' '), /globally available kinds/);
});

test('workspace exclusion policy validates unique non-empty workspace labels', () => {
  assert.deepEqual(validatePolicy(policy({ excludedWorkspaces: ['Build', 'Research'] }), models), []);
  assert.match(validatePolicy(policy({ excludedWorkspaces: ['Build', 'Build'] }), models).join(' '), /excludedWorkspaces/);
  assert.match(validatePolicy(policy({ excludedWorkspaces: ['  '] }), models).join(' '), /excludedWorkspaces/);
  assert.match(validatePolicy(policy({ excludedWorkspaces: [4] }), models).join(' '), /excludedWorkspaces/);
});

test('old policies load with an empty workspace exclusion list', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-policy-workspaces-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'policy.json');
  fs.writeFileSync(file, JSON.stringify({ projects: {} }));
  assert.deepEqual(loadPolicy({ file, models, warn: () => {} }).excludedWorkspaces, []);
});

test('excluded workspaces do not receive project control or slots by label or Herdr ID', () => {
  const snap = snapshot();
  const byLabel = deriveControl(snap, policy({ maxWorkers: 6, excludedWorkspaces: ['B'] }), models);
  assert.equal(Object.hasOwn(byLabel.projects, 'b'), false);
  assert.equal(byLabel.runningWorkers, 1, 'the live worker still counts against global capacity');
  const byId = deriveControl(snap, policy({ maxWorkers: 6, excludedWorkspaces: ['w2'] }), models);
  assert.equal(Object.hasOwn(byId.projects, 'b'), false);
  assert.equal(byId.projects.a.slots, 6);
});

test('Boss workspace migrates by pane label and preserves remaining project share proportions', (t) => {
  assert.equal(typeof controlModule.migrateWorkspacePolicy, 'function');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-boss-policy-migration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'policy.json');
  const snap = snapshot();
  snap.herdr.workspaces.push({ id: 'w-boss', label: 'Boss' });
  snap.herdr.panes.push({ id: 'w-boss:p1', workspace: 'w-boss', label: 'boss', agent: 'codex', status: 'working' });
  const oldPolicy = policy({ projects: {
    boss: { share: 20, mode: 'auto', excludedKinds: [], excludedModels: [] },
    a: { share: 50, mode: 'auto', excludedKinds: [], excludedModels: [] },
    b: { share: 30, mode: 'auto', excludedKinds: [], excludedModels: [] },
  }, excludedWorkspaces: ['w1'] });
  fs.writeFileSync(file, JSON.stringify(oldPolicy));
  const migrated = controlModule.migrateWorkspacePolicy(oldPolicy, snap, { file });
  assert.ok(migrated.excludedWorkspaces.includes('Boss'));
  assert.ok(migrated.excludedWorkspaces.includes('A'), 'a saved Herdr ID becomes its current label');
  assert.equal(Object.hasOwn(migrated.projects, 'boss'), false);
  assert.deepEqual([migrated.projects.a.share, migrated.projects.b.share], [63, 37]);
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(persisted.excludedWorkspaces.includes('Boss'));
  assert.equal(Object.hasOwn(persisted.projects, 'boss'), false);
});

test('Boss policy migration does not run without a live boss-labeled pane', () => {
  assert.equal(typeof controlModule.migrateWorkspacePolicy, 'function');
  const snap = snapshot();
  snap.herdr.workspaces.push({ id: 'w-boss', label: 'Boss' });
  const oldPolicy = policy({ projects: {
    boss: { share: 20, mode: 'auto', excludedKinds: [], excludedModels: [] },
    a: { share: 50, mode: 'auto', excludedKinds: [], excludedModels: [] },
    b: { share: 30, mode: 'auto', excludedKinds: [], excludedModels: [] },
  } });
  const migrated = controlModule.migrateWorkspacePolicy(oldPolicy, snap);
  assert.equal(migrated.excludedWorkspaces.includes('Boss'), false);
  assert.equal(migrated.projects.boss.share, 20);
  assert.deepEqual([migrated.projects.a.share, migrated.projects.b.share], [50, 30]);
});

test('workspace migration keeps derived ignored routes and does not rewrite an unchanged policy', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-policy-migration-routes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'policy.json');
  const snap = snapshot();
  snap.herdr.workspaces.push({ id: 'w-boss', label: 'Boss' });
  snap.herdr.panes.push({ id: 'w-boss:p1', workspace: 'w-boss', label: 'boss', agent: 'codex', status: 'working' });
  fs.writeFileSync(file, JSON.stringify(policy({
    preferredModels: { codex: 'gpt-6-astra' },
    modelProviders: { 'gpt-6-astra': 'claude' },
    projects: {
      boss: { share: 20, mode: 'auto', excludedKinds: [], excludedModels: [] },
      a: { share: 50, mode: 'auto', excludedKinds: [], excludedModels: [] },
      b: { share: 30, mode: 'auto', excludedKinds: [], excludedModels: [] },
    },
  })));
  const loaded = loadPolicy({ file, models, warn: () => {} });
  assert.deepEqual(loaded.ignoredRoutes, { codex: ['gpt-6-astra'] });

  const migrated = controlModule.migrateWorkspacePolicy(loaded, snap, { file });
  assert.deepEqual(migrated.ignoredRoutes, loaded.ignoredRoutes);
  assert.equal(providerFor('codex', 'gpt-6-astra', migrated), null);
  const result = deriveControl(snap, migrated, models, {}, Date.parse('2026-09-24T17:00:00Z'));
  assert.equal(result.handoffs.some((item) => item.pane === 'w2:p1'), false, 'the ignored route must not restore a Claude quota handover for Codex');
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(Object.hasOwn(persisted, 'ignoredRoutes'), false, 'derived routes stay out of the policy file');

  const inode = fs.statSync(file).ino;
  const reloaded = loadPolicy({ file, models, warn: () => {} });
  const repeated = controlModule.migrateWorkspacePolicy(reloaded, snap, { file });
  assert.deepEqual(repeated.ignoredRoutes, reloaded.ignoredRoutes);
  assert.equal(fs.statSync(file).ino, inode, 'an unchanged migration does not rewrite the policy file');
});

test('Boss handover candidate survives without a Boss project entry', () => {
  const snap = {
    projects: [],
    herdr: {
      workspaces: [{ id: 'w-boss', label: 'Boss' }],
      panes: [{ id: 'w-boss:p1', workspace: 'w-boss', label: 'boss', agent: 'codex', status: 'working', sessionId: 'boss-session' }],
    },
    quotas: [{ provider: 'codex', windows: [{ key: 'primary', label: 'Weekly', usedPercent: 94, willLast: false, etaSeconds: 3000, resetsAt: '2026-09-27T00:00:00Z' }] }],
  };
  const p = policy({ excludedWorkspaces: ['Boss'], projects: {} });
  const result = deriveControl(snap, p, models);
  assert.deepEqual(Object.keys(result.projects), []);
  assert.equal(result.bossHandoff?.pane, 'w-boss:p1');
  assert.equal(result.bossHandoff?.label, 'Boss');
  assert.equal(result.bossHandoff?.sessionId, 'boss-session');
});

test('Boss manual handover remains available in fresh mode when its pane has no agent', () => {
  const snap = {
    projects: [],
    herdr: {
      workspaces: [{ id: 'w-boss', label: 'Boss' }],
      panes: [{ id: 'w-boss:p1', workspace: 'w-boss', label: 'boss', agent: null, status: 'done' }],
    },
    quotas: [],
  };
  const result = deriveControl(snap, policy({ excludedWorkspaces: ['Boss'], projects: {} }), models);
  assert.equal(result.bossHandoff?.pane, 'w-boss:p1');
  assert.equal(result.bossHandoff?.boss, true);
  assert.equal(result.bossHandoff?.fromKind, null);
  assert.equal(result.bossHandoff?.sessionId, null);
  assert.equal(result.bossHandoff?.defaultMode, 'fresh');
});

// A child process gives every call fresh module state, so the data directory and the private paths follow the
// temporary HOME.
function loadAccess(home, data, { migrate = false } = {}) {
  const configUrl = new URL('../src/config.js', import.meta.url).href;
  const script = `import { ${migrate ? 'loadConfig, migrateAccessFiles' : 'loadConfig'} } from ${JSON.stringify(configUrl)};
const cfg = loadConfig();
${migrate ? 'migrateAccessFiles(cfg);' : ''}
console.log(JSON.stringify(cfg.access));`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HOME: home, HERDR_BOSS_DIR: data }, encoding: 'utf8',
  }));
}

const legacySessionState = JSON.stringify({ token: 'f'.repeat(64), sessions: { ['e'.repeat(64)]: 1234567890123 } });

test('loadConfig leaves legacy credential files and the stored config alone', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-loadconfig-home-'));
  const data = path.join(home, 'shared-data');
  const privateDir = path.join(home, '.config', 'herdr-boss');
  const legacyToken = path.join(data, 'access-token');
  const legacySessions = path.join(data, 'sessions.json');
  const configFile = path.join(data, 'config.json');
  const storedConfig = `${JSON.stringify({ push: false, access: { tokenFile: legacyToken, sessionDays: 11 } }, null, 2)}\n`;
  fs.mkdirSync(data);
  fs.writeFileSync(legacyToken, `${'a'.repeat(64)}\n`, { mode: 0o644 });
  fs.writeFileSync(legacySessions, legacySessionState, { mode: 0o644 });
  fs.writeFileSync(configFile, storedConfig, { mode: 0o644 });
  for (const file of [legacyToken, legacySessions, configFile]) fs.chmodSync(file, 0o644);
  const access = loadAccess(home, data);
  assert.equal(access.tokenFile, path.join(privateDir, 'access-token'), 'the private default is the effective token path');
  assert.equal(access.sessionDays, 11);
  assert.equal(fs.existsSync(path.join(data, 'projects')), true, 'loadConfig still creates the projects directory');
  assert.equal(fs.existsSync(privateDir), false, 'loadConfig does not create the private access directory');
  assert.equal(fs.readFileSync(legacyToken, 'utf8'), `${'a'.repeat(64)}\n`, 'loadConfig does not move the legacy token');
  assert.equal(fs.readFileSync(legacySessions, 'utf8'), legacySessionState, 'loadConfig does not move the legacy sessions');
  assert.equal(fs.statSync(legacyToken).mode & 0o777, 0o644, 'loadConfig does not chmod the legacy token');
  assert.equal(fs.statSync(legacySessions).mode & 0o777, 0o644, 'loadConfig does not chmod the legacy sessions');
  assert.equal(fs.readFileSync(configFile, 'utf8'), storedConfig, 'loadConfig does not rewrite the stored config');
  fs.rmSync(home, { recursive: true, force: true });
});

test('loadConfig leaves existing private credential files alone', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-loadconfig-home-'));
  const data = path.join(home, 'shared-data');
  const privateDir = path.join(home, '.config', 'herdr-boss');
  const tokenFile = path.join(privateDir, 'access-token');
  const sessionFile = path.join(privateDir, 'sessions.json');
  fs.mkdirSync(data);
  fs.mkdirSync(privateDir, { recursive: true });
  fs.writeFileSync(tokenFile, `${'a'.repeat(64)}\n`, { mode: 0o644 });
  fs.writeFileSync(sessionFile, legacySessionState, { mode: 0o644 });
  fs.chmodSync(tokenFile, 0o644);
  fs.chmodSync(sessionFile, 0o644);
  loadAccess(home, data);
  loadAccess(home, data);
  assert.equal(fs.readFileSync(tokenFile, 'utf8'), `${'a'.repeat(64)}\n`, 'loadConfig does not rewrite the token');
  assert.equal(fs.readFileSync(sessionFile, 'utf8'), legacySessionState, 'loadConfig does not rewrite the sessions');
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o644, 'loadConfig does not chmod the token');
  assert.equal(fs.statSync(sessionFile).mode & 0o777, 0o644, 'loadConfig does not chmod the sessions');
  assert.equal(fs.statSync(privateDir).mode & 0o777, 0o755, 'loadConfig does not chmod the private access directory');
  fs.rmSync(home, { recursive: true, force: true });
});

test('access credentials use private defaults and migrate legacy files once', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-credentials-home-'));
  const data = path.join(home, 'shared-data');
  const privateDir = path.join(home, '.config', 'herdr-boss');
  const legacyToken = path.join(data, 'access-token');
  const legacySessions = path.join(data, 'sessions.json');
  fs.mkdirSync(data);
  fs.writeFileSync(legacyToken, `${'a'.repeat(64)}\n`, { mode: 0o600 });
  fs.writeFileSync(legacySessions, JSON.stringify({ token: 'f'.repeat(64), sessions: { ['e'.repeat(64)]: 1234567890123 } }), { mode: 0o600 });
  const run = () => loadAccess(home, data, { migrate: true });
  const config = run();
  assert.equal(config.tokenFile, path.join(privateDir, 'access-token'));
  assert.equal(fs.readFileSync(config.tokenFile, 'utf8'), `${'a'.repeat(64)}\n`);
  assert.equal(fs.existsSync(path.join(privateDir, 'sessions.json')), true);
  assert.equal(path.join(path.dirname(config.tokenFile), 'sessions.json'), path.join(privateDir, 'sessions.json'));
  assert.equal(fs.existsSync(legacyToken), false);
  assert.equal(fs.existsSync(legacySessions), false);
  assert.equal(fs.statSync(privateDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(config.tokenFile).mode & 0o777, 0o600);
  run();
  assert.equal(fs.readFileSync(config.tokenFile, 'utf8'), `${'a'.repeat(64)}\n`);
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ push: false, access: { tokenFile: legacyToken, sessionDays: 11 } }));
  fs.writeFileSync(legacyToken, `${'b'.repeat(64)}\n`, { mode: 0o600 });
  const migratedConfig = run();
  assert.equal(migratedConfig.tokenFile, config.tokenFile);
  assert.equal(migratedConfig.sessionDays, 11);
  assert.equal(fs.readFileSync(config.tokenFile, 'utf8'), `${'a'.repeat(64)}\n`);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')), {
    push: false, access: { tokenFile: config.tokenFile, sessionDays: 11 },
  });
  const custom = path.join(home, 'custom-token');
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ access: { tokenFile: custom } }));
  assert.equal(run().tokenFile, custom);
  fs.rmSync(home, { recursive: true, force: true });
});

test('machine policy defaults and validates owner and CPU limits', () => {
  assert.equal(POLICY_DEFAULTS.machine.guardEnabled, true);
  assert.equal(POLICY_DEFAULTS.machine.guardPausedUntil, null);
  assert.equal(POLICY_DEFAULTS.machine.ownerAwayMinutes, 10);
  assert.equal(POLICY_DEFAULTS.machine.presentCpuPercent, 70);
  assert.equal(POLICY_DEFAULTS.machine.awayCpuPercent, 95);
  assert.equal(POLICY_DEFAULTS.machine.alertCooldownSeconds, 21600);
  assert.equal('diskWarnFreePercent' in POLICY_DEFAULTS.machine, false);
  assert.equal(POLICY_DEFAULTS.machine.diskWarnFreeGB, 20);
  assert.equal(POLICY_DEFAULTS.machine.diskCriticalFreeGB, 5);
  assert.deepEqual(validatePolicy(policy(), models), []);
  assert.match(validatePolicy(policy({ machine: { ...POLICY_DEFAULTS.machine, presentCpuPercent: 101 } }), models).join(' '), /presentCpuPercent/);
  assert.deepEqual(validatePolicy(policy({ machine: { ...POLICY_DEFAULTS.machine, awayCpuPercent: null, awayLoadFactor: null } }), models), []);
  assert.match(validatePolicy(policy({ machine: { ...POLICY_DEFAULTS.machine, alertCooldownSeconds: -1 } }), models).join(' '), /machine.alertCooldownSeconds/);
  assert.match(validatePolicy(policy({ machine: { ...POLICY_DEFAULTS.machine, guardEnabled: 'yes' } }), models).join(' '), /machine.guardEnabled/);
  assert.match(validatePolicy(policy({ machine: { ...POLICY_DEFAULTS.machine, guardPausedUntil: 'later' } }), models).join(' '), /machine.guardPausedUntil/);
  assert.deepEqual(validatePolicy(policy({ machine: { ...POLICY_DEFAULTS.machine, diskWarnFreePercent: 101 } }), models), []);
});

test('saved legacy off tuple migrates to guard off and restores Owner thresholds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-policy-migration-'));
  const file = path.join(dir, 'policy.json');
  fs.writeFileSync(file, JSON.stringify({ machine: {
    presentCpuPercent: 100, awayCpuPercent: null, presentLoadFactor: null, awayLoadFactor: null,
    ownerAwayMinutes: 5, alertCooldownSeconds: 21600,
  } }));
  const migrated = loadPolicy({ file, models }).machine;
  assert.equal(migrated.guardEnabled, false);
  assert.equal(migrated.presentCpuPercent, 95);
  assert.equal(migrated.awayCpuPercent, 95);
  assert.equal(migrated.presentLoadFactor, 3);
  assert.equal(migrated.awayLoadFactor, 8);
  assert.equal(migrated.ownerAwayMinutes, 5);
  assert.equal(migrated.alertCooldownSeconds, 21600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saved policy outside the exact legacy off tuple migrates on and keeps thresholds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-policy-migration-'));
  const file = path.join(dir, 'policy.json');
  const machine = { presentCpuPercent: 100, awayCpuPercent: null, presentLoadFactor: 3, awayLoadFactor: null, ownerAwayMinutes: 7, alertCooldownSeconds: 20 };
  fs.writeFileSync(file, JSON.stringify({ machine }));
  const migrated = loadPolicy({ file, models }).machine;
  assert.equal(migrated.guardEnabled, true);
  for (const [key, value] of Object.entries(machine)) assert.equal(migrated[key], value, `${key} stays unchanged`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saved guard fields and thresholds stay unchanged when guardEnabled is present', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-policy-migration-'));
  const file = path.join(dir, 'policy.json');
  const machine = { guardEnabled: false, guardPausedUntil: '2026-09-26T13:00:00.000Z', presentCpuPercent: 99, awayCpuPercent: null, presentLoadFactor: 2, awayLoadFactor: null, ownerAwayMinutes: 5, alertCooldownSeconds: 21600 };
  fs.writeFileSync(file, JSON.stringify({ machine }));
  assert.deepEqual(loadPolicy({ file, models }).machine, { ...POLICY_DEFAULTS.machine, ...machine });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('policy defaults override legacy machine and cooldown config values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-policy-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ machine: { loadWarnFactor: 0 }, alertCooldownSeconds: 1 }));
  const controlUrl = new URL('../src/control.js', import.meta.url).href;
  const script = `import { loadPolicy } from ${JSON.stringify(controlUrl)}; console.log(JSON.stringify(loadPolicy().machine));`;
  const machine = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HERDR_BOSS_DIR: dir }, encoding: 'utf8',
  }));
  assert.equal(machine.presentLoadFactor, 3);
  assert.equal(machine.alertCooldownSeconds, 21600);
});

test('machine load guard reports active CPU and load limits', async () => {
  const { machineLimits } = await import('../src/control.js');
  const now = Date.parse('2026-09-26T12:00:00Z');
  assert.deepEqual(machineLimits({ cpus: 8, load: [1, 4, 5], ownerIdleMinutes: 11, cpuUse: { a: { cpu: 400 } } }, policy(), now), {
    owner: 'away', cpuPercent: 50, cpuLimit: 95, fiveMinute: 4, loadLimit: 64,
    guardEnabled: true, guardPausedUntil: null, guardState: 'active', guardActive: true,
    swapPercent: null, swapUsedGB: null, swapWarnPercent: 80, swapRefusePercent: 95, swapMinUsedGB: 2, swapRefuseEnabled: false,
  });
  assert.equal(machineLimits({ cpus: 8, load: [1, 4, 5], ownerIdleMinutes: null, cpuUse: { a: { cpu: 560 } } }, policy()).owner, 'present');
  assert.equal(machineLimits({ cpus: 8, load: [1, 4, 5], ownerIdleMinutes: 0, cpuUse: {} }, policy()).loadLimit, 24);
  const disabled = machineLimits({ cpus: 8, load: [1, 4, 5], ownerIdleMinutes: 11, cpuUse: {}, }, policy({ machine: { ...POLICY_DEFAULTS.machine, awayCpuPercent: null, awayLoadFactor: null } }));
  assert.equal(disabled.cpuLimit, null);
  assert.equal(disabled.loadLimit, null);
  assert.equal(disabled.cpuPercent, 0);
  const high = { cpus: 8, load: [1, 100, 5], ownerIdleMinutes: 0, cpuTotalSample: 800 };
  const off = machineLimits(high, policy({ machine: { ...POLICY_DEFAULTS.machine, guardEnabled: false } }), now);
  assert.equal(off.guardState, 'off');
  assert.equal(off.guardActive, false);
  assert.equal(off.cpuLimit, 70);
  assert.equal(off.loadLimit, 24);
  const pause = new Date(now + 3600000).toISOString();
  const paused = machineLimits(high, policy({ machine: { ...POLICY_DEFAULTS.machine, guardPausedUntil: pause } }), now);
  assert.equal(paused.guardState, 'paused');
  assert.equal(paused.guardActive, false);
  assert.equal(paused.guardPausedUntil, pause);
  assert.equal(machineLimits(high, policy({ machine: { ...POLICY_DEFAULTS.machine, guardPausedUntil: pause } }), now + 3600001).guardState, 'active');
});

test('an active night state makes the Owner away', async () => {
  const { machineLimits } = await import('../src/control.js');
  const now = Date.parse('2026-09-26T12:00:00Z');
  const present = { cpus: 8, load: [1, 4, 5], ownerIdleMinutes: 0, cpuUse: {} };
  const night = { active: true, since: '2026-09-26T20:00:00.000Z', until: '2026-09-27T05:30:00.000Z', by: 'owner', quietHours: false };
  assert.equal(machineLimits(present, policy(), now).owner, 'present');
  assert.deepEqual(machineLimits(present, policy(), now, night), machineLimits({ ...present, ownerIdleMinutes: 11 }, policy(), now));
  // The same machine limits apply as for an idle Owner.
  assert.equal(machineLimits(present, policy(), now, night).cpuLimit, 95);
  assert.equal(machineLimits(present, policy(), now, night).loadLimit, 64);
  // An inactive state keeps the idle rule only.
  assert.equal(machineLimits(present, policy(), now, { ...night, active: false }).owner, 'present');
  assert.equal(machineLimits(present, policy(), now, null).owner, 'present');
});

test('machine CPU and load alerts follow guard state while memory alerts stay independent', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  const cfg = { quota: { warnPercent: 90, criticalPercent: 98 }, machine: { memFreeWarnPercent: 15, loadWarnFactor: 2 }, providerKinds: {} };
  const snap = { ...snapshot(), machine: { cpus: 4, load: [12, 20, 8], memFreePercent: 4, memTotalGB: 16, swapUsedMB: 0, cpuTotalSample: 400, ownerIdleMinutes: 0 }, cpuUse: {} };
  const active = evaluate(snap, cfg, {}, now, policy()).alerts;
  assert.ok(active.some((alert) => alert.key === 'machine:load'));
  const off = evaluate(snap, cfg, {}, now, policy({ machine: { ...POLICY_DEFAULTS.machine, guardEnabled: false } })).alerts;
  assert.ok(!off.some((alert) => alert.key.startsWith('machine:load')));
  assert.ok(off.some((alert) => alert.key === 'machine:mem'));
  const paused = evaluate(snap, cfg, {}, now, policy({ machine: { ...POLICY_DEFAULTS.machine, guardPausedUntil: new Date(now + 60000).toISOString() } })).alerts;
  assert.ok(!paused.some((alert) => alert.key.startsWith('machine:load')));
  assert.ok(paused.some((alert) => alert.key === 'machine:mem'));
});

test('disk warnings use disk thresholds with guard off and target worktree projects', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  const cfg = { quota: { warnPercent: 90, criticalPercent: 98 }, machine: { memFreeWarnPercent: 15, loadWarnFactor: 2 }, providerKinds: {} };
  const snap = { ...snapshot(), machine: { cpus: 4, load: [0, 0, 0], memFreePercent: 50, diskFreeBytes: 12 * 2 ** 30, diskFreePercent: 30 }, worktreeCounts: { w1: { linked: 3, prunable: 1 } } };
  const alerts = evaluate(snap, cfg, {}, now, policy({ machine: { ...POLICY_DEFAULTS.machine, guardEnabled: false } })).alerts;
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].scope, 'w1');
  assert.match(alerts[0].text, /3 linked worker worktree/);
  assert.match(alerts[0].text, /1 missing\/prunable/);
  assert.match(alerts[0].text, /herdr-boss worktree prune --apply/);
  assert.equal(alerts[0].severity, 'warn');
  snap.machine.diskFreeBytes = 50 * 2 ** 30;
  snap.machine.diskFreePercent = 9.9;
  const percentOnly = evaluate(snap, cfg, {}, now, policy({ machine: { ...POLICY_DEFAULTS.machine, guardEnabled: false } })).alerts;
  assert.equal(percentOnly.some((alert) => alert.key.startsWith('machine:disk:')), false, 'percent alone does not trigger a warning');
  snap.machine.diskFreeBytes = 18 * 2 ** 30;
  snap.machine.diskFreePercent = 9.9;
  const percentText = evaluate(snap, cfg, {}, now, policy()).alerts.find((alert) => alert.key.startsWith('machine:disk:'));
  assert.match(percentText.title, /\(9\.9%\)/);
  assert.match(percentText.text, /\(9\.9%\)/);
  snap.machine.diskFreeBytes = 4 * 2 ** 30;
  snap.machine.diskFreePercent = 2;
  const critical = evaluate(snap, cfg, {}, now, policy()).alerts.find((alert) => alert.key.startsWith('machine:disk:'));
  assert.equal(critical.severity, 'critical');
  assert.notEqual(critical.key, percentText.key, 'level transitions use a distinct alert key');
  snap.machine.diskFreeBytes = 30 * 2 ** 30;
  assert.equal(evaluate(snap, cfg, {}, now, policy()).alerts.some((alert) => alert.key.startsWith('machine:disk:')), false, 'recovery clears the disk alert');
  snap.machine.diskFreeBytes = 18 * 2 ** 30;
  const warningAgain = evaluate(snap, cfg, {}, now, policy()).alerts.find((alert) => alert.key.startsWith('machine:disk:'));
  assert.equal(warningAgain.severity, 'warn');
  assert.equal(warningAgain.key, percentText.key, 'a later recovery transition returns to the warning level');
});

test('orphaned processes in removed worktrees notify only their project orchestrator once', () => {
  const snap = snapshot();
  snap.herdr.workspaces.push({ id: 'w-boss', label: 'Boss' });
  snap.herdr.panes.push({ id: 'w-boss:p1', workspace: 'w-boss', label: 'boss', orch: true, agent: 'codex', status: 'working' });
  snap.orphanedWorktreeProcesses = [
    { pid: 801, ppid: 1, command: '/usr/bin/node --token secret-value', cwd: '/projects/a-wt-old/src', worktree: '/projects/a-wt-old', workspace: 'w1' },
    { pid: 801, ppid: 1, command: '/usr/bin/node --token secret-value', cwd: '/projects/a-wt-old/src', worktree: '/projects/a-wt-old', workspace: 'w1' },
    { pid: 802, ppid: 1, command: 'zsh', cwd: '/projects/boss-wt-old', worktree: '/projects/boss-wt-old', workspace: 'w-boss' },
  ];
  const cfg = { quota: { warnPercent: 90, criticalPercent: 98 }, machine: { memFreeWarnPercent: 15, loadWarnFactor: 2 }, providerKinds: {}, browsers: {}, workers: {} };
  const alerts = evaluate(snap, cfg, {}, Date.parse('2026-09-26T12:00:00Z'), policy()).alerts;
  const orphanAlerts = alerts.filter((alert) => alert.key.startsWith('worktree:orphan:'));
  assert.equal(orphanAlerts.length, 1);
  assert.equal(orphanAlerts[0].scope, 'w1');
  assert.equal(orphanAlerts[0].severity, 'warn');
  assert.equal(orphanAlerts[0].once, true);
  assert.match(orphanAlerts[0].text, /node.*pid 801.*ppid 1/);
  assert.match(orphanAlerts[0].text, /cwd \/projects\/a-wt-old\/src/);
  assert.ok(!orphanAlerts[0].text.includes('secret-value'));
  assert.ok(!['all', 'user', 'w-boss'].includes(orphanAlerts[0].scope));
});

test('missing worktree process collection uses exact paths and ignores non-orphans', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-orphan-worktree-')));
  const missing = path.join(path.dirname(root), `${path.basename(root)}-wt-removed`);
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Test User');
  git(root, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(root, 'README.md'), 'seed\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-m', 'seed');
  git(root, 'worktree', 'add', '-b', 'removed', missing, 'main');
  fs.rmSync(missing, { recursive: true, force: true });
  t.after(() => {
    try { git(root, 'worktree', 'prune'); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(missing, { recursive: true, force: true });
  });
  const panes = [
    { orch: true, label: 'orch', workspaceLabel: 'Project A', workspace: 'w1', cwd: root },
    { orch: true, label: 'orch', workspaceLabel: 'Project A', workspace: 'w1', cwd: root },
    { orch: true, label: 'orch', workspaceLabel: 'Boss', workspace: 'w-boss', cwd: root },
  ];
  const processes = [
    { pid: 811, ppid: 1, command: 'node', cwd: path.join(missing, 'src') },
    { pid: 812, ppid: 1, command: 'zsh', cwd: `${missing}-neighbor` },
    { pid: 813, ppid: 8, command: 'node', cwd: path.join(missing, 'worker') },
  ];
  const calls = [];
  const runner = async (command, args) => {
    calls.push(args.join(' '));
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  };
  const result = await collectMissingWorktreeProcesses(panes, processes, { runner });
  assert.deepEqual(result, [{ pid: 811, ppid: 1, command: 'node', cwd: path.join(missing, 'src'), worktree: missing, workspace: 'w1' }]);
  assert.equal(calls.filter((call) => call.includes('rev-parse')).length, 1, 'the same repository is checked once');
});

test('disk prompts send on level transitions and recovery, but not after same-level cooldown', () => {
  const warning = { key: 'machine:disk:w1:warn', severity: 'warn' };
  const critical = { key: 'machine:disk:w1:critical', severity: 'critical' };
  const sent = { at: 1000, severity: 'warn' };
  assert.equal(alertPromptDue(warning, sent, 1000 + 7 * 60 * 60 * 1000, 6 * 60 * 60 * 1000), false);
  assert.equal(alertPromptDue(critical, null, 2000, 6 * 60 * 60 * 1000), true);
  const warningKey = `${warning.key}@w1:p1`;
  const criticalKey = `${critical.key}@w1:p1`;
  const records = { [warningKey]: sent, 'quota:claude@w1:p1': { at: 1000, severity: 'warn' } };
  const afterLevelChange = pruneInactiveDiskPromptRecords(records, new Set([critical.key]));
  assert.equal(warningKey in afterLevelChange, false, 'the warning record is removed at the critical transition');
  assert.equal('quota:claude@w1:p1' in afterLevelChange, true, 'unrelated prompt records stay intact');
  assert.equal(alertPromptDue(critical, null, 2000, 6 * 60 * 60 * 1000), true);
  assert.equal(alertPromptDue(warning, afterLevelChange[warningKey], 3000, 6 * 60 * 60 * 1000), true, 'a warning crossing is due after a level transition');
  const afterRecovery = pruneInactiveDiskPromptRecords({ [warningKey]: sent, [criticalKey]: { at: 2000, severity: 'critical' } }, new Set());
  assert.deepEqual(afterRecovery, {});
  assert.equal(alertPromptDue(warning, afterRecovery[warningKey], 3000, 6 * 60 * 60 * 1000), true, 'a warning crossing is due after recovery');
});

test('worker failure notices can reach a working orchestrator immediately', () => {
  assert.equal(orchestratorCanReceiveNotice({ status: 'working' }, [{ immediate: true, severity: 'warn' }]), true);
  assert.equal(orchestratorCanReceiveNotice({ status: 'working' }, [{ immediate: true, severity: 'info' }]), false);
  assert.equal(orchestratorCanReceiveNotice({ status: 'working' }, [{ immediate: false, severity: 'warn' }]), false);
  assert.equal(alertPromptDue({ immediate: true }, null, 1000, 6000), true);
});

test('bulletin states the machine guard mode and retains measured machine limits', () => {
  const cfg = { dashboardPort: 4477 };
  // One healthy quota row: without quota data the bulletin says the data is unavailable instead of no restrictions.
  const snap = { ...snapshot(), updatedAt: '2026-09-26T12:00:00Z', quotas: [{ provider: 'codex', windows: [] }], lanes: {},
    machine: { load: [9, 10, 8], cpus: 4, memFreePercent: 40, memTotalGB: 16, swapUsedMB: 0, diskFreeBytes: 18 * 2 ** 30, diskFreePercent: 18.4,
      limits: { owner: 'present', cpuPercent: 65, cpuLimit: 70, fiveMinute: 10, loadLimit: 12, guardEnabled: true, guardPausedUntil: null, guardState: 'active', guardActive: true } } };
  const bulletin = renderBulletin(snap, { alerts: [], advice: [] }, cfg);
  assert.match(bulletin, /Disk free: 18.0 GB \(18.4%\) free on the data volume/);
  assert.match(bulletin, /Guard: active/);
  assert.match(bulletin, /Owner: present; machine CPU 65% \/ active limit 70%; 5-minute load 10 \/ active backstop 12/);
  snap.machine.load = [9, 13, 8];
  snap.machine.limits = { ...snap.machine.limits, cpuPercent: 75, fiveMinute: 13 };
  snap.machine.limits = { ...snap.machine.limits, guardState: 'off', guardActive: false, guardEnabled: false };
  const offBulletin = renderBulletin(snap, { alerts: [], advice: [] }, cfg);
  assert.match(offBulletin, /Guard: off/);
  assert.match(offBulletin, /No quota or active machine restrictions/);
  assert.doesNotMatch(offBulletin, /machine resources are within limits/i);
  snap.machine.limits = { ...snap.machine.limits, guardState: 'paused', guardActive: false, guardEnabled: true, guardPausedUntil: '2026-09-26T13:00:00Z' };
  const pausedBulletin = renderBulletin(snap, { alerts: [], advice: [] }, cfg);
  assert.match(pausedBulletin, /Guard: paused until 2026-09-26T13:00:00Z/);
  assert.match(pausedBulletin, /No quota or active machine restrictions/);
  assert.doesNotMatch(pausedBulletin, /machine resources are within limits/i);
  assert.match(pausedBulletin, /configured limit 70%/);
  assert.doesNotMatch(pausedBulletin, /Machine limit exceeded/);
});

test('active night bulletin shows the global and configured unmetered worker caps', () => {
  const snap = {
    ...snapshot(), updatedAt: '2026-09-26T12:00:00Z', night: { active: true }, lanes: {},
    control: { runningWorkers: 2, maxWorkers: 16, projects: {} },
  };
  const bulletin = renderBulletin(snap, { alerts: [], advice: [] }, {
    dashboardPort: 4477,
    watch: { maxWorkers: 16, maxWorkersByLane: { unmetered: 12, codex: null, claude: null, opencodego: null } },
  });
  assert.match(bulletin, /Watch cap 16 \(unmetered 12\)/);
});

test('Owner idle time parses HIDIdleTime nanoseconds and rejects missing or invalid readings', async () => {
  const { parseOwnerIdleMinutes } = await import('../src/collect.js');
  assert.equal(parseOwnerIdleMinutes('"HIDIdleTime" = 600000000000'), 10);
  assert.equal(parseOwnerIdleMinutes('no reading'), null);
  assert.equal(parseOwnerIdleMinutes('"HIDIdleTime" = -1'), null);
});

test('idle borrowing reallocates slots and quota risk offers a different harness', () => {
  const p = policy({ maxWorkers: 6, idleMinutes: 10, projects: {
    a: { share: 40, mode: 'auto', excludedKinds: [], excludedModels: [] },
    b: { share: 60, mode: 'active', excludedKinds: [], excludedModels: [] },
  } });
  const now = Date.parse('2026-09-24T17:00:00Z');
  // Project b uses all 4 of its base slots, so it borrows.
  const snap = snapshot();
  snap.herdr.panes.push(...[3, 4, 5].map((n) => ({ id: `w2:p${n}`, workspace: 'w2', orch: false, agent: 'pi', status: 'working' })));
  const result = deriveControl(snap, p, models, { 'w1:p1': { status: 'idle', since: now - 11 * 60000 } }, now);
  assert.equal(result.projects.a.idle, true);
  assert.equal(result.projects.a.slots, 0);
  assert.equal(result.projects.a.lent, 2);
  assert.equal(result.projects.b.slots, 6);
  assert.equal(result.projects.b.borrowed, 2);
  assert.equal(result.runningWorkers, 4);
  assert.equal(result.handoffs[0].target.kind, 'codex');
  assert.equal(result.handoffs[0].sessionId, 's1');
});

test('ignore quota keeps handover risk while leaving the provider lane open', () => {
  const p = policy({ providerModes: { ...POLICY_DEFAULTS.providerModes, claude: 'ignore' } });
  const now = Date.parse('2026-09-24T17:00:00Z');
  const snap = snapshot();
  const result = deriveControl(snap, p, models, {}, now);
  const lane = controlModule.laneStatus(snap.quotas, p, now).claude;
  assert.equal(result.risks.claude?.usedPercent, 88);
  assert.equal(result.handoffs.some((item) => item.pane === 'w1:p1'), true);
  assert.equal(lane.state, 'open');
  assert.equal(lane.ignored, true);
});

test('handoff target checks use the configured model route', () => {
  const routed = policy({ modelProviders: { 'gpt-6-luna': 'claude' } });
  const result = deriveControl(snapshot(), routed, models, {}, Date.parse('2026-09-24T17:00:00Z'));
  assert.equal(result.handoffs[0].target.kind, 'pi');
  assert.equal(result.handoffs[0].target.provider, 'opencodego');
});

const ladderSnapshot = () => {
  const snap = snapshot();
  snap.herdr.workspaces.push({ id: 'w3', label: 'Boss' });
  snap.herdr.panes.push({ id: 'w3:p1', workspace: 'w3', label: 'boss', orch: false, agent: 'claude', status: 'working', sessionId: 's3' });
  return snap;
};
const ladderTargets = (result) => [result.handoffs.find((item) => item.pane === 'w1:p1').target, result.bossHandoff.target]
  .map((target) => target && `${target.kind}:${target.model}`);

test('successor ladder skips only the exhausted free model, not its whole harness', () => {
  const now = Date.parse('2026-09-24T17:00:00Z');
  const p = policy({ orchestratorLadder: [
    { kind: 'opencode', model: 'opencode/big-pickle', effort: null },
    { kind: 'codex', model: 'gpt-6-luna', effort: 'xhigh' },
  ] });
  const exhaustedModels = { 'opencode/big-pickle': { model: 'opencode/big-pickle', retryAt: now + 60000 } };
  const closed = deriveControl(ladderSnapshot(), p, models, {}, now, exhaustedModels);
  assert.deepEqual(ladderTargets(closed), ['codex:gpt-6-luna', 'codex:gpt-6-luna']);
  const reopened = deriveControl(ladderSnapshot(), p, models, {}, now + 60000, exhaustedModels);
  assert.deepEqual(ladderTargets(reopened), ['opencode:opencode/big-pickle', 'opencode:opencode/big-pickle']);
  // A separate metered model in the same harness remains eligible.
  const metered = policy({ orchestratorLadder: [
    { kind: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', effort: null },
    { kind: 'codex', model: 'gpt-6-luna', effort: 'xhigh' },
  ] });
  const stillOpen = deriveControl(ladderSnapshot(), metered, models, {}, now, exhaustedModels);
  assert.deepEqual(ladderTargets(stillOpen), ['opencode:opencode-go/deepseek-v4.1-flash', 'opencode:opencode-go/deepseek-v4.1-flash']);
});

test('successor ladder skips a Pi rung that the last good Pi model result does not list', () => {
  const now = Date.parse('2026-09-24T17:00:00Z');
  const p = policy({ orchestratorLadder: [
    { kind: 'pi', model: 'fixturezen/free-a', effort: null },
    { kind: 'codex', model: 'gpt-6-luna', effort: 'xhigh' },
  ] });
  const result = deriveControl(ladderSnapshot(), p, fixtureModels, {}, now, {}, { piModels: { at: now, models: ['fixturezen/free-b'] } });
  assert.deepEqual(ladderTargets(result), ['codex:gpt-6-luna', 'codex:gpt-6-luna']);
  const listed = deriveControl(ladderSnapshot(), p, fixtureModels, {}, now, {}, { piModels: { at: now, models: ['fixturezen/free-a'] } });
  assert.deepEqual(ladderTargets(listed), ['pi:fixturezen/free-a', 'pi:fixturezen/free-a']);
});

test('successor ladder skips no Pi rung while the Pi model result is unknown', () => {
  const now = Date.parse('2026-09-24T17:00:00Z');
  const p = policy({ orchestratorLadder: [
    { kind: 'pi', model: 'fixturezen/free-a', effort: null },
    { kind: 'codex', model: 'gpt-6-luna', effort: 'xhigh' },
  ] });
  for (const piModels of [null, undefined, {}]) {
    const result = deriveControl(ladderSnapshot(), p, fixtureModels, {}, now, {}, { piModels });
    assert.deepEqual(ladderTargets(result), ['pi:fixturezen/free-a', 'pi:fixturezen/free-a']);
  }
  assert.deepEqual(ladderTargets(deriveControl(ladderSnapshot(), p, fixtureModels, {}, now)), ['pi:fixturezen/free-a', 'pi:fixturezen/free-a']);
});

test('current orchestrator provider falls back to its preferred model route', () => {
  const p = policy({ preferredModels: { codex: 'gpt-6.1-sol' }, modelProviders: { 'gpt-6.1-sol': 'claude' } });
  const result = deriveControl(snapshot(), p, models, {}, Date.parse('2026-09-24T17:00:00Z'));
  const handoff = result.handoffs.find((item) => item.fromKind === 'codex');
  assert.equal(handoff.provider, 'claude');
  assert.equal(handoff.target.kind, 'pi');
});

test('provider routing separates free OpenCode from OpenCode Go', () => {
  assert.equal(providerFor('opencode', 'opencode/big-pickle'), null);
  assert.equal(providerFor('pi', 'opencode-go/deepseek-v4.1-flash'), 'opencodego');
  assert.equal(providerFor('codex', 'gpt-6-luna'), 'codex');
});

test('policy validates preferred models and explicit provider routes', () => {
  const p = policy({ preferredModels: { codex: 'gpt-6.1-sol' }, modelProviders: { 'gpt-6.1-sol': null, 'opencode-go/deepseek-v4.1-flash': 'claude' } });
  assert.deepEqual(validatePolicy(p, models), []);
  assert.match(validatePolicy(policy({ preferredModels: { codex: 'claude-sonnet-4-5' } }), models).join(' '), /preferredModels/);
  assert.match(validatePolicy(policy({ modelProviders: { 'unknown-model': 'codex' } }), models).join(' '), /modelProviders/);
  assert.match(validatePolicy(policy({ modelProviders: { 'gpt-6-luna': 'other' } }), models).join(' '), /modelProviders/);
});

test('model provider override applies while legacy policy keeps inferred routing', () => {
  assert.equal(providerFor('codex', 'gpt-6-luna'), 'codex');
  assert.equal(providerFor('codex', 'gpt-6-luna', { modelProviders: { 'gpt-6-luna': 'claude' } }), 'claude');
  assert.equal(providerFor('opencode', 'opencode/big-pickle', { modelProviders: { 'opencode/big-pickle': null } }), null);
});

test('usage attribution prefers an explicit provider over changed policy routes', () => {
  const changedRoute = { modelProviders: { 'gpt-6-luna': 'opencodego' } };
  assert.equal(usageProvider({ kind: 'codex', model: 'gpt-6-luna', provider: 'claude' }, changedRoute), 'claude');
  assert.equal(usageProvider({ kind: 'codex', model: 'gpt-6-luna', provider: null }, changedRoute), 'unmetered-or-unknown');
  assert.equal(usageProvider({ kind: 'codex', model: 'gpt-6-luna' }, { modelProviders: { 'gpt-6-luna': 'claude' } }), 'claude');
  assert.equal(usageProvider({ kind: 'codex', model: 'gpt-6-luna' }, {}), 'codex');
});

test('preferred model selection preserves explicit choices and legacy defaults', () => {
  assert.equal(selectModel('codex', null, models, { preferredModels: { codex: 'gpt-6.1-sol' } }), 'gpt-6.1-sol');
  assert.equal(selectModel('codex', 'gpt-6-astra', models, { preferredModels: { codex: 'gpt-6.1-sol' } }), 'gpt-6-astra');
  assert.equal(selectModel('codex', null, models, {}), models.kinds.codex.defaultModel);
});

test('usage summary distinguishes recorded runs from measured tokens', () => {
  const base = { project: 'a', kind: 'codex', model: 'gpt-6-luna', provider: 'codex', startedAt: '2026-09-24T10:00:00Z', endedAt: '2026-09-24T10:10:00Z', outcome: 'done' };
  assert.deepEqual(validateUsage(base), []);
  const rows = usageSummary([{ ...base, inputTokens: null }, { ...base, inputTokens: 100, outputTokens: 20 }]);
  assert.equal(rows.byProject.a.runs, 2);
  assert.equal(rows.byProject.a.measuredRuns, 1);
  assert.equal(rows.byProject.a.inputTokens, 100);
});

test('broadcast notices skip orchestrators in workspaces without active agents', () => {
  const orchs = [{ id: 'w1:p1', workspace: 'w1' }, { id: 'w2:p1', workspace: 'w2' }, { id: 'w3:p1', workspace: 'w3' }];
  const panes = [
    { id: 'w1:p1', workspace: 'w1', agent: 'claude', orch: true, status: 'working' },
    { id: 'w1:p2', workspace: 'w1', agent: 'pi', orch: false, status: 'idle' },
    { id: 'w2:p2', workspace: 'w2', agent: 'codex', orch: false, status: 'working' },
    { id: 'w3:p2', workspace: 'w3', agent: 'claude', orch: false, status: 'blocked' },
    { id: 'w3:p3', workspace: 'w3', agent: null, orch: false, status: null },
  ];
  assert.deepEqual(broadcastTargets(orchs, panes).map((o) => o.id), ['w2:p1', 'w3:p1']);
});

test('the idle-worker notice skips a prepared handover successor', async () => {
  const { evaluate } = await import('../src/rules.js');
  const cfg = { quota: { warnPercent: 90, criticalPercent: 98 }, machine: { memFreeWarnPercent: 15, loadWarnFactor: 2 }, browsers: { staleOwnedMinutes: 30 }, workers: { staleIdleMinutes: 120 }, sharedBrowsers: [] };
  const now = Date.now();
  const since = now - 3 * 3600000;
  const snap = {
    herdr: { panes: [
      { id: 'w1:p6', workspace: 'w1', agent: 'codex', orch: false, status: 'done' },
      { id: 'w1:p7', workspace: 'w1', agent: 'pi', orch: false, status: 'idle' },
    ] },
    standbyPanes: ['w1:p6'],
  };
  const { alerts } = evaluate(snap, cfg, { 'w1:p6': { since }, 'w1:p7': { since } }, now);
  const stale = alerts.find((a) => a.key.startsWith('workers:stale:'));
  assert.ok(stale);
  assert.match(stale.text, /w1:p7/);
  assert.doesNotMatch(stale.text, /w1:p6/);
});

test('the idle-worker notice skips former orchestrators labeled orch previous and boss previous', async () => {
  const { evaluate } = await import('../src/rules.js');
  const cfg = { quota: { warnPercent: 90, criticalPercent: 98 }, machine: { memFreeWarnPercent: 15, loadWarnFactor: 2 }, browsers: { staleOwnedMinutes: 30 }, workers: { staleIdleMinutes: 120 }, sharedBrowsers: [] };
  const now = Date.now();
  const since = now - 3 * 3600000;
  const snap = { herdr: { panes: [
    { id: 'w1:p1', workspace: 'w1', label: 'orch previous', agent: 'claude', orch: false, status: 'idle' },
    { id: 'w1:p3', workspace: 'w1', label: null, agent: 'pi', orch: false, status: 'idle' },
    { id: 'wb:p1', workspace: 'wb', label: 'boss previous', agent: 'claude', orch: false, status: 'done' },
  ] } };
  const { alerts } = evaluate(snap, cfg, { 'w1:p1': { since }, 'w1:p3': { since }, 'wb:p1': { since } }, now);
  const stale = alerts.filter((a) => a.key.startsWith('workers:stale:'));
  assert.deepEqual(stale.map((a) => a.key), ['workers:stale:w1:w1:p3']);
  assert.doesNotMatch(stale[0].text, /w1:p1\b/);
});

test('blocked-worker rule starts only after five minutes', async () => {
  const { evaluate } = await import('../src/rules.js');
  const cfg = { quota: { warnPercent: 90, criticalPercent: 98 }, machine: { memFreeWarnPercent: 15, loadWarnFactor: 2 }, browsers: { staleOwnedMinutes: 30 }, workers: { staleIdleMinutes: 120 }, sharedBrowsers: [] };
  const now = 1_000_000;
  const snap = { herdr: { panes: [{ id: 'w1:p2', workspace: 'w1', name: 'worker-a', agent: 'codex', status: 'blocked' }] } };
  const before = evaluate(snap, cfg, { 'w1:p2': { since: now - 299_999 } }, now).alerts;
  assert.equal(before.some((alert) => alert.key === 'workers:blocked:w1:p2'), false);
  const after = evaluate(snap, cfg, { 'w1:p2': { since: now - 300_001 } }, now).alerts;
  const alert = after.find((item) => item.key === 'workers:blocked:w1:p2');
  assert.ok(alert);
  assert.match(alert.text, /worker-a.*w1:p2/);
});

test('lane status marks pace and reserve, skips reset windows, and names the least-over provider', async () => {
  const { laneStatus, leastOverProvider } = await import('../src/control.js');
  const now = Date.parse('2026-09-25T10:00:00Z');
  const quotas = [
    { provider: 'codex', windows: [{ label: 'Weekly', usedPercent: 53, expectedPercent: 43, willLast: false, windowMinutes: 10080, resetsAt: '2026-09-29T09:00:00Z' }] },
    { provider: 'opencodego', windows: [{ label: 'Weekly', usedPercent: 69, expectedPercent: 63, willLast: false, windowMinutes: 10080, resetsAt: '2026-09-27T23:00:00Z' }] },
    { provider: 'claude', windows: [{ label: 'Session', usedPercent: 93, expectedPercent: 40, willLast: false, windowMinutes: 300, resetsAt: '2026-09-25T09:59:00Z' }] },
  ];
  const lanes = laneStatus(quotas, policy(), now);
  assert.equal(lanes.codex.state, 'pace');
  assert.equal(lanes.codex.overPercent, 10);
  // 10% over a 7-day window is 16.8 hours of catch-up when unused.
  assert.equal(Date.parse(lanes.codex.backOnPaceAt) - now, 0.1 * 10080 * 60000);
  assert.equal(lanes.claude.state, 'open');
  assert.deepEqual(lanes.claude.resetWindows, ['Session']);
  assert.equal(leastOverProvider(lanes), null);
  lanes.claude = { state: 'reserve', overPercent: 50 };
  assert.equal(leastOverProvider(lanes), 'opencodego');
});

test('worker start gate lets the least-over provider start and refuses the others with numbers', async () => {
  const { providerGate } = await import('../src/kit/workers.js');
  const now = Date.parse('2026-09-25T10:00:00Z');
  const rules = {
    avoidProviders: ['codex', 'opencodego', 'claude'],
    leastOverProvider: 'opencodego',
    lanes: {
      codex: { state: 'pace', window: 'Weekly', usedPercent: 53, expectedPercent: 43, overPercent: 10, backOnPaceAt: '2026-09-26T02:48:00Z' },
      opencodego: { state: 'pace', window: 'Weekly', usedPercent: 69, expectedPercent: 63, overPercent: 6, backOnPaceAt: '2026-09-25T20:00:00Z' },
      claude: { state: 'reserve', window: 'Session', usedPercent: 90, expectedPercent: 60, overPercent: 30, backOnPaceAt: '2026-09-25T15:00:00Z' },
    },
  };
  assert.match(providerGate('opencodego', rules, { now }).warning, /every metered provider is over pace.*least over/);
  const refused = providerGate('codex', rules, { now }).error;
  assert.match(refused, /codex ahead of pace: 53% used against 43% expected in the Weekly window; back on pace in about 17 h if unused/);
  assert.match(refused, /opencodego is the least over/);
  assert.match(providerGate('claude', rules, { now }).error, /claude near exhaustion/);
  assert.match(providerGate('claude', rules, { now, force: true }).warning, /--force overrides the quota guard/);
  assert.deepEqual(providerGate('pi', { avoidProviders: [] }, { now }), {});
});

test('project status validation accepts work structure and rejects unsafe or malformed fields', async () => {
  const { validateProject } = await import('../src/projects.js');
  assert.deepEqual(validateProject({
    project: 'Demo',
    groups: [{ id: '1.0', title: 'Release 1.0', refs: [{ label: 'docs/Plan.md' }] }],
    tasks: [{ id: '1', title: 'Spec', kind: 'spec', status: 'done' }, { id: '2', title: 'Build', parent: '1', blockedBy: ['1'], group: '1.0', url: 'https://example.com/2' }],
    gates: [{ title: 'Owner review' }], risks: ['Quota'], git: { branch: 'main', commit: 'abc', dirty: false },
  }), []);
  const errors = validateProject({
    project: 'Demo',
    tasks: [{ id: '1', title: 'A', blockedBy: '2' }, { id: '1', title: 'B', url: 'javascript:alert(1)' }],
    links: [{ label: 'x', url: 'javascript:alert(1)' }],
  });
  assert.ok(errors.some((e) => /blockedBy must be an array/.test(e)));
  assert.ok(errors.some((e) => /task IDs must be unique/.test(e)));
  assert.ok(errors.some((e) => /tasks\[1\]\.url must start with http/.test(e)));
  assert.ok(errors.some((e) => /links\[0\]\.url must start with http/.test(e)));
});

test('a task can name who it waits on, with a short ask and a Mailbox id', async () => {
  const { validateProject, statusWarnings } = await import('../src/projects.js');
  assert.deepEqual(validateProject({
    project: 'Demo',
    tasks: [
      { id: 'V12', title: 'Decide the paint', status: 'blocked', waitingOn: 'owner', ask: 'Which paint?', mailboxId: 'm1' },
      { id: 'V13', title: 'Vendor check', status: 'todo', waitingOn: 'external', ask: 'Vendor reply' },
      { id: 'V14', title: 'Contract', status: 'todo', waitingOn: 'task', blockedBy: ['V13'] },
      { id: 'V15', title: 'Approve the plan', status: 'blocked', waitingOn: 'boss', ask: 'Approve the plan' },
    ],
  }), []);
  // A bad waitingOn, a missing ask, a long ask, and a done task with waitingOn are errors.
  assert.ok(validateProject({ project: 'x', tasks: [{ id: '1', title: 'A', waitingOn: 'client' }] }).some((e) => /waitingOn must be one of owner\|boss\|task\|external/.test(e)));
  assert.ok(validateProject({ project: 'x', tasks: [{ id: '1', title: 'A', waitingOn: 'owner' }] }).some((e) => /ask/.test(e)));
  assert.ok(validateProject({ project: 'x', tasks: [{ id: '1', title: 'A', waitingOn: 'boss', ask: 'x'.repeat(201) }] }).some((e) => /ask/.test(e)));
  assert.ok(validateProject({ project: 'x', tasks: [{ id: '1', title: 'A', waitingOn: 'owner', ask: 'ok' }] }).some((e) => /ask/.test(e)) === false);
  assert.ok(validateProject({ project: 'x', tasks: [{ id: '1', title: 'A', status: 'done', waitingOn: 'task' }] }).some((e) => /done/.test(e)));
  // The warnings do not block a publish. Each names one missing field.
  assert.deepEqual(statusWarnings({ project: 'x', tasks: [{ id: '1', title: 'A', status: 'blocked' }] }), ['task 1 is blocked but names no blocker. Set blockedBy or waitingOn.']);
  assert.deepEqual(statusWarnings({ project: 'x', tasks: [{ id: '2', title: 'B', status: 'blocked', waitingOn: 'owner', ask: 'x' }] }), ['task 2 waits on the Owner but has no Mailbox item. Post one with herdr-boss mail post and set mailboxId.']);
  assert.deepEqual(statusWarnings({ project: 'x', tasks: [{ id: '3', title: 'C', status: 'blocked', blockedBy: ['2'], waitingOn: 'owner', ask: 'x', mailboxId: 'm' }] }), []);
});

test('CPU use counts pane processes and project browsers per workspace', async () => {
  const { cpuUse } = await import('../src/collect.js');
  const procs = new Map([
    [10, { pid: 10, ppid: 1, cpu: 0, cmd: '/bin/zsh' }],
    [11, { pid: 11, ppid: 10, cpu: 90, cmd: 'node (vitest 1)' }],
    [12, { pid: 12, ppid: 10, cpu: 80, cmd: 'node (vitest 2)' }],
    [20, { pid: 20, ppid: 1, cpu: 70, cmd: '/Applications/Google Chrome.app/Contents/Frameworks/Helper --type=renderer --user-data-dir=/p/viz' }],
    [30, { pid: 30, ppid: 1, cpu: 40, cmd: '/usr/bin/other' }],
  ]);
  const use = cpuUse(procs, [{ id: 'w1:p1', workspace: 'w1', shellPid: 10 }], { '/p/viz': 'w2' });
  assert.deepEqual(use.w1, { cpu: 170, top: [{ label: 'vitest', cpu: 170, count: 2 }] });
  assert.equal(use.w2.top[0].label, 'Chrome');
  assert.equal(use.other.cpu, 40);
});

test('a load alert goes to the projects that cause it and the bulletin groups project rules', async () => {
  const { evaluate, renderBulletin } = await import('../src/rules.js');
  const cfg = { quota: { warnPercent: 90, criticalPercent: 98 }, machine: { memFreeWarnPercent: 15, loadWarnFactor: 2 }, browsers: { staleOwnedMinutes: 30 }, workers: { staleIdleMinutes: 120 }, sharedBrowsers: [] };
  const snap = {
    updatedAt: new Date().toISOString(),
    machine: { load: [40, 35, 30], cpus: 10, memFreePercent: 50 },
    herdr: { workspaces: [{ id: 'w1', label: 'Alpha' }, { id: 'w2', label: 'Beta' }], panes: [] },
    cpuUse: { w1: { cpu: 420, top: [{ label: 'vitest', cpu: 400, count: 9 }] }, w2: { cpu: 30, top: [] } },
  };
  const evaluation = evaluate(snap, cfg, {}, Date.now());
  const load = evaluation.alerts.filter((a) => a.key.startsWith('machine:load'));
  assert.deepEqual(load.map((a) => a.scope).sort(), ['user', 'w1']);
  assert.match(load.find((a) => a.scope === 'w1').text, /Your project uses about 420% CPU now .*vitest ×9 400%/);
  const bulletin = renderBulletin(snap, evaluation, cfg);
  assert.match(bulletin, /## Project rules\n\n### Alpha\n\n- The 5-minute load average/);
});

test('bulletin shows Owner state, normalized CPU limit, load backstop, and stop action', async () => {
  const { evaluate, renderBulletin } = await import('../src/rules.js');
  const cfg = { quota: { warnPercent: 90, criticalPercent: 98 }, machine: { memFreeWarnPercent: 15, loadWarnFactor: 2 }, browsers: { staleOwnedMinutes: 30 }, workers: { staleIdleMinutes: 120 }, sharedBrowsers: [], providerKinds: { claude: ['claude'], codex: ['codex'], opencodego: ['pi'] } };
  const p = policy();
  const snap = { ...snapshot(), updatedAt: '2026-09-25T00:00:00Z', machine: { load: [1, 4, 5], cpus: 8, memFreePercent: 50, memTotalGB: 16, swapUsedMB: 0,
    limits: { owner: 'present', cpuPercent: 75, cpuLimit: 70, fiveMinute: 4, loadLimit: 24 } }, cpuUse: {}, browsers: [], managedBrowsers: [], control: { projects: {}, runningWorkers: 0, maxWorkers: 8 }, policy: p };
  const evaluation = evaluate(snap, cfg, {}, Date.parse(snap.updatedAt), p);
  const bulletin = renderBulletin(snap, evaluation, cfg);
  assert.match(bulletin, /Owner: present; machine CPU 75% \/ active limit 70%; 5-minute load 4 \/ active backstop 24/);
  assert.match(bulletin, /stop new workers and full test suites/);
});

test('a remote session survives a restart, and a new token signs every device out', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createAccessControl } = await import('../src/access.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-access-'));
  fs.chmodSync(dir, 0o755);
  const tokenFile = path.join(dir, 'access-token');
  const first = createAccessControl(tokenFile, { privateDirectory: true });
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const req = (cookie) => ({ socket: { remoteAddress: '10.0.0.2' }, headers: { host: '10.0.0.1:4477', cookie } });
  const res = { setHeader() {} };
  const login = first.login(req(), token);
  assert.equal(login.ok, true);
  assert.match(login.cookie, /SameSite=Lax/);
  assert.match(login.cookie, /Max-Age=2592000/);
  const cookie = login.cookie.split(';')[0];
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8'), new RegExp(cookie.split('=')[1]));
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, 'sessions.json')).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8'))).sort(), ['sessions', 'token']);
  fs.chmodSync(tokenFile, 0o644);
  fs.chmodSync(path.join(dir, 'sessions.json'), 0o644);
  createAccessControl(tokenFile);
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, 'sessions.json')).mode & 0o777, 0o600);
  assert.equal(createAccessControl(tokenFile).authorized(req(cookie), res), true);
  fs.writeFileSync(tokenFile, `${'b'.repeat(64)}\n`);
  assert.equal(createAccessControl(tokenFile).authorized(req(cookie), res), false);
  assert.equal(first.login(req(), 'wrong').ok, false);
});

test('a live window that will not last is ahead of pace at any usage level', async () => {
  const { laneStatus, leastOverProvider } = await import('../src/control.js');
  const { describeLane } = await import('../src/kit/workers.js');
  const now = Date.parse('2026-09-25T16:00:00Z');
  const quotas = [
    { provider: 'claude', windows: [
      { label: 'Session', usedPercent: 13, expectedPercent: 15, willLast: true, windowMinutes: 300, resetsAt: '2026-09-25T19:59:00Z' },
      { label: 'Weekly', usedPercent: 42, expectedPercent: 12, willLast: false, windowMinutes: 10080, resetsAt: '2026-10-01T18:59:00Z' },
      { label: 'Fable only', usedPercent: 0, willLast: true, extra: true, resetsAt: '2026-10-01T19:00:00Z' },
    ] },
    { provider: 'codex', windows: [{ label: 'Weekly', usedPercent: 54, expectedPercent: 47, willLast: false, windowMinutes: 10080, resetsAt: '2026-09-29T09:24:00Z' }] },
  ];
  const lanes = laneStatus(quotas, policy(), now);
  assert.equal(lanes.claude.state, 'pace');
  assert.equal(lanes.claude.window, 'Weekly');
  assert.equal(lanes.claude.overPercent, 30);
  assert.match(describeLane('claude', lanes.claude, now), /^claude ahead of pace: 42% used against 12% expected in the Weekly window/);
  // Codex is 7 points over and Claude 30, so the least-over rule still picks Codex.
  assert.equal(leastOverProvider(lanes), 'codex');
  const control = deriveControl({ ...snapshot(), quotas }, policy(), models, {}, now);
  assert.equal(control.pressures.claude.label, 'Weekly');
});

test('the lane names the worst window by pace, not the highest-used window', async () => {
  const { laneStatus } = await import('../src/control.js');
  const { providerGate } = await import('../src/kit/workers.js');
  const now = Date.parse('2026-09-25T16:00:00Z');
  const quotas = [{ provider: 'opencodego', windows: [
    { label: '5-hour', usedPercent: 20, expectedPercent: 5, willLast: false, windowMinutes: 300, resetsAt: '2026-09-25T20:29:00Z' },
    { label: 'Weekly', usedPercent: 76, expectedPercent: 67, willLast: false, windowMinutes: 10080, resetsAt: '2026-09-27T23:59:00Z' },
    { label: 'Monthly', usedPercent: 38, expectedPercent: 6, willLast: false, windowMinutes: 43200, resetsAt: '2026-10-23T16:57:00Z' },
  ] }];
  const lanes = laneStatus(quotas, policy(), now);
  assert.equal(lanes.opencodego.state, 'pace');
  assert.equal(lanes.opencodego.window, 'Monthly');
  assert.equal(lanes.opencodego.overPercent, 32);
  const refused = providerGate('opencodego', { avoidProviders: ['opencodego'], lanes, leastOverProvider: null }, { now }).error;
  assert.match(refused, /^opencodego ahead of pace: 38% used against 6% expected in the Monthly window/);
  // Without expected use, the usage percentage ranks the windows.
  const unexpected = laneStatus([{ provider: 'codex', windows: [
    { label: 'Session', usedPercent: 30, willLast: false, resetsAt: '2026-09-25T20:00:00Z' },
    { label: 'Weekly', usedPercent: 45, willLast: false, resetsAt: '2026-09-29T09:24:00Z' },
  ] }], policy(), now);
  assert.equal(unexpected.codex.window, 'Weekly');
  assert.equal(unexpected.codex.overPercent, null);
});

test('pacing goals default to 100 percent and validate as whole percentages', () => {
  assert.deepEqual(POLICY_DEFAULTS.pacingGoals, {});
  assert.deepEqual(validatePolicy(policy({ pacingGoals: { codex: { primary: 80 }, claude: { secondary: 0 } } }), models), []);
  assert.match(validatePolicy(policy({ pacingGoals: { codex: { weekly: 80 } } }), models).join(' '), /pacingGoals/);
  assert.match(validatePolicy(policy({ pacingGoals: { codex: { primary: 101 } } }), models).join(' '), /pacingGoals/);
  assert.match(validatePolicy(policy({ pacingGoals: { codex: { primary: 80.5 } } }), models).join(' '), /pacingGoals/);
  assert.match(validatePolicy(policy({ pacingGoals: { other: { primary: 80 } } }), models).join(' '), /pacingGoals/);
  assert.match(validatePolicy(policy({ pacingGoals: [] }), models).join(' '), /pacingGoals/);
});

test('a pacing goal makes a willLast window ahead of pace and scales its numbers', async () => {
  const { laneStatus } = await import('../src/control.js');
  const now = Date.parse('2026-09-25T10:00:00Z');
  const quotas = [{ provider: 'codex', windows: [{ key: 'primary', label: 'Weekly', usedPercent: 45, expectedPercent: 50, willLast: true, windowMinutes: 10080, resetsAt: '2026-09-29T09:00:00Z' }] }];
  assert.equal(laneStatus(quotas, policy(legacyPace), now).codex.state, 'open');
  const lane = laneStatus(quotas, policy({ ...legacyPace, pacingGoals: { codex: { primary: 80 } } }), now).codex;
  assert.equal(lane.state, 'pace');
  assert.equal(lane.expectedPercent, 40);
  assert.equal(lane.overPercent, 5);
  assert.equal(Date.parse(lane.backOnPaceAt) - now, 5 / 80 * 10080 * 60000);
});

test('timed pacing goals use the live window start and end for pace and recovery', async () => {
  const { adjustedExpectedPercent, laneStatus } = await import('../src/control.js');
  const now = Date.parse('2026-09-25T12:00:00Z');
  const window = { key: 'primary', label: 'Daily', usedPercent: 40, expectedPercent: 50, willLast: true,
    windowMinutes: 1440, resetsAt: '2026-09-26T00:00:00Z' };
  const timed = policy({ pacingGoals: { codex: { primary: { percent: 80, end: { type: 'at', at: '2026-09-25T18:00:00.000Z' } } } } });
  assert.ok(Math.abs(adjustedExpectedPercent(timed, 'codex', window, now) - 80 * 12 / 18) < 1e-10);
  window.willLast = false;
  assert.equal(laneStatus([{ provider: 'codex', windows: [window] }], timed, now).codex.state, 'open', 'a timed goal uses its line for pace even when the reset forecast is negative');
  window.usedPercent = 60;
  const lane = laneStatus([{ provider: 'codex', windows: [window] }], timed, now).codex;
  assert.equal(lane.state, 'pace');
  assert.ok(Math.abs(lane.overPercent - (60 - 80 * 12 / 18)) < 1e-10);
  assert.equal(lane.backOnPaceAt, '2026-09-25T13:30:00.000Z');
  assert.equal(adjustedExpectedPercent(timed, 'codex', window, Date.parse('2026-09-25T19:00:00Z')), 80);
});

test('long-window trickle allowance counts to a future goal, then falls back to reset', async () => {
  const { laneStatus } = await import('../src/control.js');
  const reset = '2026-10-28T12:00:00.000Z';
  const goalEnd = '2026-10-13T12:00:00.000Z'; // 360 hours before reset.
  const quota = [{ provider: 'codex', windows: [{ key: 'primary', label: 'Monthly', usedPercent: 50,
    expectedPercent: 15, windowMinutes: 43200, willLast: false, resetsAt: reset }] }];
  const timed = (percent = 100) => policy({ ...legacyPace, pacingGoals: { codex: { primary: { percent, end: { type: 'at', at: goalEnd } } } } });

  const beforeGoal = laneStatus(quota, timed(), Date.parse('2026-10-03T12:00:00.000Z')).codex;
  assert.equal(beforeGoal.state, 'trickle');
  assert.equal(beforeGoal.allowancePercent, 5);

  const afterGoal = laneStatus(quota, timed(), Date.parse('2026-10-14T12:00:00.000Z')).codex;
  assert.equal(afterGoal.state, 'trickle');
  assert.ok(Math.abs(afterGoal.allowancePercent - (50 / 14)) < 1e-10);

  const smallerGoal = laneStatus(quota, timed(80), Date.parse('2026-10-03T12:00:00.000Z')).codex;
  assert.equal(smallerGoal.allowancePercent, 3);

  const noGoalEnd = laneStatus(quota, policy(legacyPace), Date.parse('2026-09-28T12:00:00.000Z')).codex;
  assert.ok(Math.abs(noGoalEnd.allowancePercent - (50 / 30)) < 1e-10);
});

test('pacing goal text uses the short weekday date form', () => {
  const goalEnd = Date.parse('2026-10-08T12:00:00.000Z');
  assert.equal(controlModule.pacingGoalText({ percent: 100, end: { type: 'hoursBeforeReset', hours: 360 },
    resolvedEnd: goalEnd }, Date.parse('2026-09-28T12:00:00.000Z')), 'goal: 100% by Thu 8 Oct');
  assert.equal(controlModule.pacingGoalText({ percent: 80, end: { type: 'at', at: '2026-10-08T12:00:00.000Z' },
    resolvedEnd: goalEnd }, goalEnd - 3600000), 'goal: 80% by Thu 8 Oct 14:00');
});

test('runs-out advice uses the goal percent and names a timed goal end', () => {
  const now = Date.parse('2026-09-28T12:00:00.000Z');
  const quotas = [{ provider: 'codex', windows: [{ key: 'primary', label: 'Monthly', usedPercent: 50,
    expectedPercent: 30, willLast: false, etaSeconds: 3 * 86400 + 4 * 3600,
    windowMinutes: 43200, resetsAt: '2026-10-28T12:00:00.000Z' }] }];
  const cfg = { quota: { warnPercent: 90, criticalPercent: 98 }, providerKinds: { codex: ['codex'] },
    machine: { memFreeWarnPercent: 15, loadWarnFactor: 2 }, browsers: {}, workers: {} };
  const timed = policy({ pacingGoals: { codex: { primary: { percent: 100,
    end: { type: 'at', at: '2026-10-08T12:00:00.000Z' } } } } });
  const advice = evaluate({ quotas }, cfg, {}, now, timed).advice.join(' ');

  assert.match(advice, /reaches 100% in 3d 4h, before the goal end Thu 8 Oct 14:00/);
  assert.doesNotMatch(advice, /before the reset/);

  const slowerFullQuota = [{ provider: 'codex', windows: [{ ...quotas[0].windows[0], etaSeconds: 10 * 86400 }] }];
  const smallerGoal = policy({ pacingGoals: { codex: { primary: { percent: 80,
    end: { type: 'at', at: '2026-10-08T12:00:00.000Z' } } } } });
  const scaledAdvice = evaluate({ quotas: slowerFullQuota }, cfg, {}, now, smallerGoal).advice.join(' ');
  assert.match(scaledAdvice, /reaches 80% in 6d 0h, before the goal end Thu 8 Oct 14:00/);

  const canReachGoal = [{ provider: 'codex', windows: [{ ...quotas[0].windows[0], willLast: true, etaSeconds: 40 * 86400 }] }];
  const laterEnd = policy({ pacingGoals: { codex: { primary: { percent: 80,
    end: { type: 'at', at: '2026-10-24T12:00:00.000Z' } } } } });
  const goalAdvice = evaluate({ quotas: canReachGoal }, cfg, {}, now, laterEnd).advice.join(' ');
  assert.match(goalAdvice, /reaches 80% in 24d 0h, before the goal end Sat 24 Oct 14:00/);
});

test('timed goals rank the worst window and the least-over provider', async () => {
  const { deriveControl, laneStatus, leastOverProvider } = await import('../src/control.js');
  const now = Date.parse('2026-09-25T12:00:00Z');
  const quotas = [
    { provider: 'codex', windows: [
      { key: 'primary', label: 'Daily', usedPercent: 60, expectedPercent: 50, willLast: true, windowMinutes: 1440, resetsAt: '2026-09-26T00:00:00Z' },
      { key: 'secondary', label: 'Weekly', usedPercent: 70, expectedPercent: 50, willLast: true, windowMinutes: 10080, resetsAt: '2026-09-29T00:00:00Z' },
    ] },
    { provider: 'claude', windows: [{ key: 'primary', label: 'Daily', usedPercent: 55, expectedPercent: 50, willLast: true, windowMinutes: 1440, resetsAt: '2026-09-26T00:00:00Z' }] },
  ];
  const timed = policy({ ...legacyPace, pacingGoals: { codex: { primary: { percent: 80, end: { type: 'at', at: '2026-09-25T18:00:00.000Z' } } } } });
  assert.equal(deriveControl({ ...snapshot(), quotas }, timed, models, {}, now).pressures.codex.label, 'Weekly');
  assert.equal(leastOverProvider(laneStatus(quotas, timed, now)), 'claude');
});

test('recurring goal resolves against each new reset and keeps its offset', async () => {
  const { adjustedExpectedPercent } = await import('../src/control.js');
  const goal = policy({ pacingGoals: { codex: { primary: { percent: 80, end: { type: 'hoursBeforeReset', hours: 6 } } } } });
  for (const [reset, now] of [['2026-09-26T00:00:00Z', '2026-09-25T12:00:00Z'], ['2026-09-27T00:00:00Z', '2026-09-26T12:00:00Z']]) {
    const window = { key: 'primary', expectedPercent: 50, windowMinutes: 1440, resetsAt: reset };
    assert.ok(Math.abs(adjustedExpectedPercent(goal, 'codex', window, Date.parse(now)) - 80 * 12 / 18) < 1e-10);
  }
});

test('timed goal validation checks end against now, start, and reset', async () => {
  const { validatePacingGoalEnds } = await import('../src/control.js');
  const now = Date.parse('2026-09-25T12:00:00Z');
  const quotas = [{ provider: 'codex', windows: [{ key: 'primary', label: 'Daily', windowMinutes: 1440, resetsAt: '2026-09-26T00:00:00Z' }] }];
  const at = (time) => policy({ pacingGoals: { codex: { primary: { percent: 80, end: { type: 'at', at: time } } } } });
  assert.deepEqual(validatePacingGoalEnds(at('2026-09-25T18:00:00.000Z'), quotas, now), []);
  assert.match(validatePacingGoalEnds(at('2026-09-25T11:00:00.000Z'), quotas, now).join(' '), /after now/);
  assert.match(validatePacingGoalEnds(at('2026-09-26T01:00:00.000Z'), quotas, now).join(' '), /at or before reset/);
  const offset = (hours) => policy({ pacingGoals: { codex: { primary: { percent: 80, end: { type: 'hoursBeforeReset', hours } } } } });
  assert.match(validatePacingGoalEnds(offset(25), quotas, Date.parse('2026-09-24T00:00:00Z')).join(' '), /after the window start/);
  assert.deepEqual(validatePacingGoalEnds(offset(6), quotas, now), []);
  assert.match(validatePolicy(offset(0), models).join(' '), /positive whole number/);
  assert.deepEqual(validatePolicy(at('2026-09-25T18:00:00.000Z'), models), []);
});

test('one-off goals clear at their end or window reset, persist, and log once', async () => {
  const { clearExpiredOneOffGoals, savePolicy } = await import('../src/control.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-goal-end-'));
  const file = path.join(dir, 'policy.json');
  try {
    const saved = policy({ pacingGoals: {
      codex: { primary: { percent: 70, end: { type: 'at', at: '2026-09-25T12:00:00.000Z', resetAt: '2026-09-26T00:00:00.000Z' } } },
      claude: { primary: { percent: 80, end: { type: 'at', at: '2026-09-25T18:00:00.000Z', resetAt: '2026-09-26T00:00:00.000Z' } }, secondary: { percent: 50, end: { type: 'hoursBeforeReset', hours: 6 } } },
    } });
    assert.deepEqual(savePolicy(saved, models, { file }), []);
    const quotas = [
      { provider: 'codex', windows: [{ key: 'primary', resetsAt: '2026-09-26T00:00:00Z' }] },
      { provider: 'claude', windows: [{ key: 'primary', resetsAt: '2026-09-27T00:00:00.000Z' }] },
    ];
    const logs = [];
    assert.deepEqual(clearExpiredOneOffGoals(saved, quotas, Date.parse('2026-09-25T13:00:00Z'), { file, log: (line) => logs.push(line) }), ['codex/primary', 'claude/primary']);
    assert.deepEqual(clearExpiredOneOffGoals(loadPolicy({ file }), quotas, Date.parse('2026-09-25T13:00:00Z'), { file, log: (line) => logs.push(line) }), []);
    assert.equal(logs.length, 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).pacingGoals, { claude: { secondary: { percent: 50, end: { type: 'hoursBeforeReset', hours: 6 } } } });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('configured goals appear in lanes and bulletin while providers are open', async () => {
  const { laneStatus } = await import('../src/control.js');
  const { describeLane } = await import('../src/kit/workers.js');
  const now = Date.parse('2026-09-25T12:00:00Z');
  const quotas = [{ provider: 'claude', windows: [{ key: 'primary', label: 'Weekly', usedPercent: 10, expectedPercent: 50, windowMinutes: 10080, resetsAt: '2026-09-29T00:00:00Z' }] }];
  const goals = policy({ pacingGoals: { claude: { primary: { percent: 80, end: { type: 'hoursBeforeReset', hours: 6 } } } } });
  const lanes = laneStatus(quotas, goals, now);
  assert.equal(lanes.claude.state, 'open');
  assert.match(describeLane('claude', lanes.claude, now), /weekly: goal: 80% by Mon 28 Sep/);
  const bulletin = renderBulletin({ ...snapshot(), updatedAt: new Date(now).toISOString(), quotas, lanes }, { alerts: [], advice: [] }, {});
  assert.match(bulletin, /weekly: goal: 80% by Mon 28 Sep/);
});

test('least-over ordering uses the goal-adjusted pace score', async () => {
  const { laneStatus, leastOverProvider, deriveControl } = await import('../src/control.js');
  const now = Date.parse('2026-09-25T10:00:00Z');
  const quotas = [
    { provider: 'codex', windows: [{ key: 'primary', label: 'Weekly', usedPercent: 45, expectedPercent: 43, willLast: false, windowMinutes: 10080, resetsAt: '2026-09-29T09:00:00Z' }] },
    { provider: 'claude', windows: [{ key: 'secondary', label: 'Weekly', usedPercent: 63, expectedPercent: 58, willLast: false, windowMinutes: 10080, resetsAt: '2026-10-01T18:00:00Z' }] },
  ];
  assert.equal(leastOverProvider(laneStatus(quotas, policy(legacyPace), now)), 'codex');
  const goal = policy({ ...legacyPace, pacingGoals: { codex: { primary: 40 } } });
  assert.equal(leastOverProvider(laneStatus(quotas, goal, now)), 'claude');
  // The worst window of a provider also ranks by the adjusted pace, not the raw pace.
  const windows = [{ provider: 'codex', windows: [
    { key: 'primary', label: 'Weekly', usedPercent: 45, expectedPercent: 43, willLast: false, windowMinutes: 10080, resetsAt: '2026-09-29T09:00:00Z' },
    { key: 'secondary', label: 'Monthly', usedPercent: 60, expectedPercent: 50, willLast: false, windowMinutes: 43200, resetsAt: '2026-10-23T09:00:00Z' },
  ] }];
  assert.equal(deriveControl({ ...snapshot(), quotas: windows }, policy(legacyPace), models, {}, now).pressures.codex.label, 'Monthly');
  assert.equal(deriveControl({ ...snapshot(), quotas: windows }, policy({ ...legacyPace, pacingGoals: { codex: { primary: 10 } } }), models, {}, now).pressures.codex.label, 'Weekly');
});

test('a pacing goal stays inert for an ignored provider and after a reset', async () => {
  const { laneStatus, deriveControl } = await import('../src/control.js');
  const now = Date.parse('2026-09-25T10:00:00Z');
  const live = [{ provider: 'codex', windows: [{ key: 'primary', label: 'Weekly', usedPercent: 45, expectedPercent: 30, willLast: true, windowMinutes: 10080, resetsAt: '2026-09-29T09:00:00Z' }] }];
  const ignored = policy({ providerModes: { ...POLICY_DEFAULTS.providerModes, codex: 'ignore' }, pacingGoals: { codex: { primary: 50 } } });
  const ignoredLane = laneStatus(live, ignored, now).codex;
  assert.equal(ignoredLane.state, 'open');
  assert.equal(ignoredLane.ignored, true);
  const expired = [{ provider: 'codex', windows: [{ key: 'primary', label: 'Weekly', usedPercent: 95, expectedPercent: 50, willLast: false, windowMinutes: 10080, resetsAt: '2026-09-25T09:00:00Z' }] }];
  const goal = policy({ pacingGoals: { codex: { primary: 50 } } });
  const lane = laneStatus(expired, goal, now).codex;
  assert.equal(lane.state, 'open');
  assert.deepEqual(lane.resetWindows, ['Weekly']);
  const control = deriveControl({ ...snapshot(), quotas: expired }, goal, models, {}, now);
  assert.equal(control.risks.codex, null);
  assert.equal(control.pressures.codex, null);
});

test('ignored quota exhaustion closes the lane and excludes it from dispatch and succession until the latest reset', async () => {
  const { laneStatus, leastOverProvider, pickSuccessor, deriveControl } = await import('../src/control.js');
  const { providerGate, describeLane } = await import('../src/kit/workers.js');
  const now = Date.parse('2026-09-25T10:00:00Z');
  const resetAt = '2026-09-29T09:00:00Z';
  const quotas = [{ provider: 'opencodego', windows: [
    { key: 'primary', label: 'Weekly', usedPercent: 100, expectedPercent: 40, resetsAt: '2026-09-27T09:00:00Z' },
    { key: 'secondary', label: 'Monthly', usedPercent: 100, expectedPercent: 50, resetsAt: resetAt },
    { key: 'tertiary', label: 'Extra', usedPercent: 100, extra: true, resetsAt: '2026-10-01T00:00:00Z' },
  ] }];
  const ignored = policy({ providerModes: { ...POLICY_DEFAULTS.providerModes, opencodego: 'ignore' } });
  const lanes = laneStatus(quotas, ignored, now);
  assert.equal(lanes.opencodego.state, 'exhausted');
  assert.equal(lanes.opencodego.window, 'Monthly');
  assert.equal(lanes.opencodego.resetAt, resetAt);
  assert.equal(leastOverProvider({ ...lanes, codex: { state: 'pace', overPercent: 1 } }), 'codex');
  assert.match(describeLane('opencodego', lanes.opencodego, now), /exhausted until 2026-09-29T09:00:00Z/);
  const bulletin = renderBulletin({ ...snapshot(), updatedAt: new Date(now).toISOString(), lanes }, { alerts: [], advice: [] }, { dashboardPort: 4477 });
  assert.match(bulletin, /exhausted until 2026-09-29T09:00:00Z/);
  const refusal = providerGate('opencodego', { avoidProviders: ['opencodego'], leastOverProvider: null, lanes }, { now }).error;
  assert.match(refusal, /exhausted until 2026-09-29T09:00:00Z/);
  assert.match(providerGate('opencodego', { avoidProviders: ['opencodego'], lanes }, { now, force: true }).warning, /--force overrides/);

  const targetPolicy = policy({ orchestratorLadder: [
    { kind: 'pi', model: 'opencode-go/deepseek-v4.1-flash' },
    { kind: 'codex', model: 'gpt-6-luna' },
  ] });
  const project = { excludedKinds: [], excludedModels: [] };
  const successor = pickSuccessor(project, 'claude', 'claude', targetPolicy, {
    globalAllowed: { pi: ['opencode-go/deepseek-v4.1-flash'], codex: ['gpt-6-luna'] },
    risks: {}, exhausted: { opencodego: { resetAt } },
  });
  assert.equal(successor.kind, 'codex');

  const expired = [{ provider: 'opencodego', windows: [{ label: 'Weekly', usedPercent: 100, resetsAt: '2026-09-25T09:00:00Z' }] }];
  assert.equal(laneStatus(expired, ignored, now).opencodego.state, 'open');
  assert.equal(laneStatus([{ provider: 'opencodego', windows: [{ label: 'Weekly', usedPercent: 99, resetsAt: resetAt }] }], ignored, now).opencodego.state, 'open');
  assert.equal(deriveControl({ ...snapshot(), quotas }, ignored, models, {}, now).risks.opencodego.usedPercent, 100, 'ignore mode keeps live handover risk');
});

test('successor selection skips an actively exhausted free model and keeps available or expired rungs eligible', async () => {
  const { pickSuccessor } = await import('../src/control.js');
  const policy = structuredClone(POLICY_DEFAULTS);
  policy.orchestratorLadder = [
    { kind: 'pi', model: 'opencode-go/deepseek-v4.1-flash' },
    { kind: 'codex', model: 'gpt-6-luna' },
  ];
  policy.harnessRoutes = { pi: { 'opencode-go/deepseek-v4.1-flash': null } };
  const project = { excludedKinds: [], excludedModels: [] };
  const control = {
    globalAllowed: { pi: ['opencode-go/deepseek-v4.1-flash'], codex: ['gpt-6-luna'] },
    risks: {}, exhausted: {},
  };
  const now = Date.parse('2026-09-26T12:00:00.000Z');
  const exhausted = { 'opencode-go/deepseek-v4.1-flash': { model: 'opencode-go/deepseek-v4.1-flash', retryAt: now + 60000 } };

  assert.equal(pickSuccessor(project, 'claude', 'claude', policy, { ...control, exhaustedFreeModels: exhausted }, now).kind, 'codex');
  assert.equal(pickSuccessor(project, 'claude', 'claude', policy, control, now).kind, 'pi');
  assert.equal(pickSuccessor(project, 'claude', 'claude', policy, { ...control, exhaustedFreeModels: exhausted }, now + 60000).kind, 'pi');
});

test('a near-exhaustion window keeps its reserve state under a goal', async () => {
  const { laneStatus } = await import('../src/control.js');
  const now = Date.parse('2026-09-25T10:00:00Z');
  const quotas = [{ provider: 'codex', windows: [{ key: 'primary', label: 'Weekly', usedPercent: 90, expectedPercent: 10, willLast: false, windowMinutes: 10080, resetsAt: '2026-09-29T09:00:00Z' }] }];
  const lane = laneStatus(quotas, policy({ pacingGoals: { codex: { primary: 50 } } }), now).codex;
  assert.equal(lane.state, 'reserve');
});

test('the unmetered lane lists permitted models after global and project exclusions', async () => {
  const { unmeteredLane } = await import('../src/control.js');
  const projects = { a: { excludedKinds: [], excludedModels: [] }, b: { excludedKinds: ['opencode'], excludedModels: [] } };
  const lane = unmeteredLane(fixtureModels, policy({ excludedModels: ['opencode/big-pickle', 'fixturezen/free-a'] }), projects);
  assert.equal(lane.state, 'open');
  assert.equal(lane.unmetered, true);
  assert.ok(lane.byProject.a.opencode.includes('opencode/space-bunny-free'));
  assert.ok(!lane.byProject.a.opencode.includes('opencode/big-pickle'));
  assert.deepEqual(lane.byProject.a.pi, ['fixturezen/free-b']);
  assert.equal(lane.byProject.b.opencode, undefined, 'an excluded kind drops that harness from the lane');
  assert.deepEqual(lane.byProject.b.pi, ['fixturezen/free-b']);
  const paused = unmeteredLane(models, policy(), { stopped: { mode: 'paused', excludedKinds: [], excludedModels: [] } });
  assert.equal(paused.byProject.stopped, undefined, 'paused projects do not enter the unmetered lane');
  const projectModel = unmeteredLane(models, policy(), { a: { excludedKinds: [], excludedModels: ['opencode/space-bunny-free'] } });
  assert.ok(!projectModel.byProject.a.opencode.includes('opencode/space-bunny-free'));
  const routed = unmeteredLane(models, policy({ modelProviders: { 'opencode/space-bunny-free': 'codex' } }), projects);
  assert.ok(!routed.byProject.a.opencode.includes('opencode/space-bunny-free'));
  const kindsOff = unmeteredLane(fixtureModels, policy({ allowedKinds: ['pi'] }), projects);
  assert.equal(kindsOff.byProject.a.opencode, undefined);
  assert.deepEqual([...(kindsOff.byProject.a.pi || [])].sort(), [...fixturePiModels].sort());
});

test('the unmetered lane filters active exhausted models and restores them at retry time', async () => {
  const { unmeteredLane } = await import('../src/control.js');
  const projects = { a: { excludedKinds: [], excludedModels: [] }, b: { excludedKinds: [], excludedModels: [] } };
  const model = 'opencode/space-bunny-free';
  const sharedModels = structuredClone(models);
  sharedModels.kinds.pi.allowedModels.push(model);
  const active = unmeteredLane(sharedModels, policy(), projects, { [model]: { model, retryAt: 5000 } });
  assert.ok(!active.byProject.a.opencode.includes('opencode/space-bunny-free'));
  assert.ok(!active.byProject.b.opencode.includes('opencode/space-bunny-free'));
  assert.ok(!(active.byProject.a.pi || []).includes('opencode/space-bunny-free'));
  assert.ok(!(active.byProject.b.pi || []).includes('opencode/space-bunny-free'));
  assert.ok(active.byProject.a.opencode.includes('opencode/big-pickle'));
  assert.deepEqual(active.exhausted.map(({ model, retryAt, projects: affected, kinds }) => [model, retryAt, affected, kinds]), [[model, 5000, ['a', 'b'], ['opencode', 'pi']]]);
  const recovered = unmeteredLane(models, policy(), projects, {});
  assert.ok(recovered.byProject.a.opencode.includes('opencode/space-bunny-free'));
});

test('free opencode/ models run only in the opencode harness', async () => {
  const { unmeteredLane, providerFor } = await import('../src/control.js');
  const { handoffTarget } = await import('../src/handoff.js');
  const zen = models.kinds.opencode.allowedModels.filter((model) => model.startsWith('opencode/'));
  assert.ok(zen.includes('opencode/mimo-v2.6-flash-free'));
  for (const model of zen) assert.ok(!models.kinds.pi.allowedModels.includes(model), `${model} is not in the Pi allow-list`);
  assert.ok(models.kinds.pi.allowedModels.every((model) => model.startsWith('opencode-go/')), 'Pi holds only opencode-go/ models');
  for (const model of models.kinds.pi.allowedModels) assert.equal(providerFor('pi', model, policy()), 'opencodego', `${model} uses the opencode-go credential`);
  assert.equal(models.kinds.pi.defaultModel, 'opencode-go/muse-spark-1.3-contributor', 'the Pi default is unchanged');
  const lane = unmeteredLane(models, policy(), { a: { excludedKinds: [], excludedModels: [] } });
  assert.equal(lane.byProject.a.pi, undefined, 'the unmetered lane lists no Pi model');
  assert.ok(lane.byProject.a.opencode.includes('opencode/mimo-v2.6-flash-free'));
  assert.throws(() => handoffTarget('pi', { model: 'opencode/mimo-v2.6-flash-free' }, policy(), models), /allow-list/);
  const target = handoffTarget('opencode', { model: 'opencode/mimo-v2.6-flash-free' }, policy(), models);
  assert.equal(target.model, 'opencode/mimo-v2.6-flash-free');
  assert.equal(target.provider, null, 'handoff keeps the model unmetered');
});

test('unmetered summary prints common models once and differing active projects as exceptions', async () => {
  const { unmeteredSummary } = await import('../src/control.js');
  const lane = { byProject: {
    alpha: { opencode: ['opencode/a', 'opencode/b'], pi: ['pi:a'] },
    beta: { opencode: ['opencode/a', 'opencode/b'], pi: ['pi:a'] },
    gamma: { opencode: ['opencode/a'] },
    paused: { opencode: ['opencode/a', 'opencode/b'], pi: ['pi:a'] },
  }, projectModes: { alpha: 'active', beta: 'auto', gamma: 'active', paused: 'paused' } };
  assert.equal(unmeteredSummary(lane), 'opencode: a, b; pi: pi:a; exceptions: gamma (opencode: -b; pi: none)');
  assert.equal(unmeteredSummary(lane, 'gamma'), 'opencode: a');
  assert.equal(unmeteredSummary({ byProject: {
    alpha: { opencode: ['opencode/big-pickle', 'opencode/space-bunny-free'] },
    beta: { opencode: ['opencode/big-pickle', 'opencode/space-bunny-free'] },
    gamma: { opencode: ['opencode/big-pickle'] },
  } }), 'opencode: big-pickle, space-bunny-free; exceptions: gamma (opencode: -space-bunny-free)');
  assert.equal(unmeteredSummary({ byProject: { alpha: { opencode: ['opencode/a'] }, empty: {} }, projectModes: { alpha: 'active', empty: 'active' } }), 'opencode: a; exceptions: empty (opencode: none)');
});

test('least-over selection skips the unmetered lane', async () => {
  const { laneStatus, leastOverProvider, unmeteredLane } = await import('../src/control.js');
  const now = Date.parse('2026-09-25T10:00:00Z');
  const quotas = [
    { provider: 'codex', windows: [{ key: 'primary', label: 'Weekly', usedPercent: 45, expectedPercent: 43, willLast: false, windowMinutes: 10080, resetsAt: '2026-09-29T09:00:00Z' }] },
    { provider: 'claude', windows: [{ key: 'secondary', label: 'Weekly', usedPercent: 63, expectedPercent: 58, willLast: false, windowMinutes: 10080, resetsAt: '2026-10-01T18:00:00Z' }] },
  ];
  const lanes = laneStatus(quotas, policy(legacyPace), now);
  lanes.unmetered = unmeteredLane(models, policy(legacyPace), { a: { excludedKinds: [], excludedModels: [] } });
  assert.equal(leastOverProvider(lanes), 'codex');
});

test('the bulletin shows the unmetered lane in Provider lanes', async () => {
  const { renderBulletin } = await import('../src/rules.js');
  const cfg = { quota: { warnPercent: 90, criticalPercent: 98 }, machine: { memFreeWarnPercent: 15, loadWarnFactor: 2 }, browsers: { staleOwnedMinutes: 30 }, workers: { staleIdleMinutes: 120 }, sharedBrowsers: [] };
  const snap = { ...snapshot(), updatedAt: '2026-09-25T00:00:00Z', lanes: { codex: { state: 'open' }, unmetered: { state: 'open', unmetered: true, byProject: { a: { opencode: ['opencode/space-bunny-free'] } }, exhausted: [{ model: 'opencode/big-pickle', projects: ['a'], retryAt: Date.parse('2026-09-26T05:48:00Z') }] } }, policy: policy() };
  const bulletin = renderBulletin(snap, { alerts: [], advice: [] }, cfg);
  assert.match(bulletin, /- Unmetered: open: opencode: space-bunny-free\. Exhausted models: opencode\/big-pickle until /);
  const exceptionSnap = { ...snap, lanes: { unmetered: { state: 'open', unmetered: true, byProject: { alpha: { opencode: ['opencode/a'] }, beta: { opencode: ['opencode/a'] }, gamma: { opencode: [] } } } } };
  const exceptionBulletin = renderBulletin(exceptionSnap, { alerts: [], advice: [] }, cfg);
  assert.ok(exceptionBulletin.includes('- Unmetered: open: opencode: a; exceptions: gamma (opencode: none).'));
});

test('extra models join only their harness allow-list and keep that harness launch rules', async () => {
  const { mergeModels } = await import('../src/control.js');
  const base = structuredClone(models.kinds.pi.allowedModels);
  const p = policy({ extraModels: { pi: ['opencode-go/glm-5.2'] }, preferredModels: { pi: 'opencode-go/glm-5.2' } });
  const merged = mergeModels(models, p);
  assert.deepEqual(merged.kinds.pi.allowedModels, [...base, 'opencode-go/glm-5.2']);
  assert.ok(!merged.kinds.opencode.allowedModels.includes('opencode-go/glm-5.2'));
  assert.deepEqual(merged.kinds.pi.launchArgs, models.kinds.pi.launchArgs);
  assert.deepEqual(merged.kinds.pi.allowedEfforts, models.kinds.pi.allowedEfforts);
  assert.deepEqual(models.kinds.pi.allowedModels, base, 'the base catalog is not changed');
  assert.deepEqual(mergeModels(merged, p).kinds.pi.allowedModels, merged.kinds.pi.allowedModels, 'merging twice adds nothing');
  assert.deepEqual(validatePolicy(p, models), []);
  assert.deepEqual(validatePolicy(policy({ orchestratorLadder: [{ kind: 'pi', model: 'opencode-go/glm-5.2', effort: null }], extraModels: { pi: ['opencode-go/glm-5.2'] } }), models), []);
});

test('extra model strings reject whitespace, shell syntax, duplicates, and unknown harnesses', () => {
  for (const bad of ['has space', 'a;rm', '$(id)', '`id`', 'a\nb', 'a\tb', '', '-rf', '.hidden', 'a|b', 'a&b', 'a>b', "a'b", 'a"b', 'a\\b', 'x'.repeat(129), 42, null]) {
    assert.match(validatePolicy(policy({ extraModels: { pi: [bad] } }), models).join(' '), /extraModels/, `rejects ${JSON.stringify(bad)}`);
  }
  for (const good of ['opencode-go/glm-5.2', 'vendor/Model_2.1-mini', 'gpt-7']) assert.deepEqual(validatePolicy(policy({ extraModels: { codex: [good] } }), models), [], `accepts ${good}`);
  assert.match(validatePolicy(policy({ extraModels: { pi: ['x/a', 'x/a'] } }), models).join(' '), /extraModels/);
  assert.match(validatePolicy(policy({ extraModels: { pi: [models.kinds.pi.allowedModels[0]] } }), models).join(' '), /extraModels/);
  assert.match(validatePolicy(policy({ extraModels: { unknown: ['x/a'] } }), models).join(' '), /extraModels/);
  assert.match(validatePolicy(policy({ extraModels: ['x/a'] }), models).join(' '), /extraModels/);
  assert.match(validatePolicy(policy({ preferredModels: { opencode: 'x/only-pi' }, extraModels: { pi: ['x/only-pi'] } }), models).join(' '), /preferredModels/);
});

test('a model under two harnesses has an independent enabled state and provider route in each', async () => {
  const { modelEnabled, unmeteredLane } = await import('../src/control.js');
  const shared = 'opencode-go/deepseek-v4.1-flash';
  assert.ok(models.kinds.opencode.allowedModels.includes(shared) && models.kinds.pi.allowedModels.includes(shared));
  const p = policy({ disabledModels: { opencode: [shared] }, harnessRoutes: { pi: { [shared]: null } } });
  assert.deepEqual(validatePolicy(p, models), []);
  assert.equal(modelEnabled('opencode', shared, p), false);
  assert.equal(modelEnabled('pi', shared, p), true);
  assert.equal(providerFor('pi', shared, p), null);
  assert.equal(providerFor('opencode', shared, p), 'opencodego');
  const control = deriveControl(snapshot(), p, models, {}, Date.parse('2026-09-24T17:00:00Z'));
  assert.ok(!control.globalAllowed.opencode.includes(shared));
  assert.ok(control.globalAllowed.pi.includes(shared));
  const lane = unmeteredLane(models, p, { a: { excludedKinds: [], excludedModels: [] } });
  assert.ok(lane.byProject.a.pi.includes(shared));
  assert.ok(!lane.byProject.a.opencode.includes(shared));

  const extra = 'vendor/shared-extra';
  const q = policy({ extraModels: { pi: [extra], opencode: [extra] }, harnessRoutes: { opencode: { [extra]: 'opencodego' } }, disabledModels: { pi: [extra] } });
  assert.deepEqual(validatePolicy(q, models), []);
  assert.equal(providerFor('opencode', extra, q), 'opencodego');
  assert.equal(providerFor('pi', extra, q), null, 'a new model starts unmetered');
  const extraControl = deriveControl(snapshot(), q, models, {}, Date.parse('2026-09-24T17:00:00Z'));
  assert.ok(extraControl.globalAllowed.opencode.includes(extra));
  assert.ok(!extraControl.globalAllowed.pi.includes(extra));
});

test('per-harness assignments validate the harness, the model, and the provider', () => {
  assert.match(validatePolicy(policy({ harnessRoutes: { codex: { 'gpt-6-luna': 'other' } } }), models).join(' '), /harnessRoutes/);
  assert.match(validatePolicy(policy({ harnessRoutes: { claude: { 'gpt-6-luna': 'codex' } } }), models).join(' '), /harnessRoutes/);
  assert.match(validatePolicy(policy({ harnessRoutes: { nope: { 'gpt-6-luna': 'codex' } } }), models).join(' '), /harnessRoutes/);
  assert.match(validatePolicy(policy({ harnessRoutes: { codex: [] } }), models).join(' '), /harnessRoutes/);
  assert.match(validatePolicy(policy({ disabledModels: { claude: ['gpt-6-luna'] } }), models).join(' '), /disabledModels/);
  assert.match(validatePolicy(policy({ disabledModels: { codex: ['gpt-6-luna', 'gpt-6-luna'] } }), models).join(' '), /disabledModels/);
  assert.match(validatePolicy(policy({ disabledModels: { codex: 'gpt-6-luna' } }), models).join(' '), /disabledModels/);
  assert.deepEqual(validatePolicy(policy({ harnessRoutes: { codex: { 'gpt-6-luna': null } }, disabledModels: { codex: ['gpt-6.1-sol'] } }), models), []);
});

test('legacy global exclusions and routes keep working beside per-harness assignments', async () => {
  const { modelEnabled } = await import('../src/control.js');
  const shared = 'opencode-go/deepseek-v4.1-flash';
  const legacy = { ...structuredClone(POLICY_DEFAULTS), excludedModels: [shared], modelProviders: { [shared]: null } };
  delete legacy.extraModels; delete legacy.disabledModels; delete legacy.harnessRoutes;
  assert.deepEqual(validatePolicy(legacy, models), []);
  assert.equal(modelEnabled('pi', shared, legacy), false);
  assert.equal(modelEnabled('opencode', shared, legacy), false);
  assert.equal(providerFor('pi', shared, legacy), null);
  const mixed = policy({ modelProviders: { [shared]: null }, harnessRoutes: { opencode: { [shared]: 'opencodego' } } });
  assert.equal(providerFor('opencode', shared, mixed), 'opencodego', 'a harness route takes precedence');
  assert.equal(providerFor('pi', shared, mixed), null, 'the legacy route stays for the other harness');
  assert.equal(usageProvider({ kind: 'opencode', model: shared }, mixed), 'opencodego');
  assert.equal(usageProvider({ kind: 'pi', model: shared }, mixed), 'unmetered-or-unknown');
});

test('a project may exclude a model that at least one available harness enables', () => {
  const shared = 'opencode-go/deepseek-v4.1-flash';
  const project = { share: 100, mode: 'auto', excludedKinds: [], excludedModels: [shared] };
  assert.deepEqual(validatePolicy(policy({ disabledModels: { opencode: [shared] }, projects: { a: project } }), models), []);
  assert.match(validatePolicy(policy({ disabledModels: { opencode: [shared], pi: [shared] }, projects: { a: project } }), models).join(' '), /a\.excludedModels/);
  assert.deepEqual(validatePolicy(policy({ extraModels: { pi: ['vendor/x'] }, projects: { a: { ...project, excludedModels: ['vendor/x'] } } }), models), []);
});

test('handoff targets use the merged allow-list and the per-harness enabled state', async () => {
  const { handoffTarget } = await import('../src/handoff.js');
  const extra = 'vendor/pi-extra';
  const p = policy({ extraModels: { pi: [extra] }, disabledModels: { codex: ['gpt-6.1-sol'] }, harnessRoutes: { pi: { [extra]: 'opencodego' } } });
  const target = handoffTarget('pi', { model: extra }, p, models);
  assert.equal(target.model, extra);
  assert.equal(target.provider, 'opencodego');
  assert.deepEqual(target.launchArgs.slice(0, 4), ['--model', extra, '--models', extra]);
  assert.throws(() => handoffTarget('opencode', { model: extra }, p, models), /allow-list/);
  assert.throws(() => handoffTarget('codex', { model: 'gpt-6.1-sol' }, p, models), /disabled for codex/);
  assert.equal(handoffTarget('codex', { model: 'gpt-6-astra', effort: 'high' }, p, models).launchArgs.join(' '), '-m gpt-6-astra -c model_reasoning_effort=high -s workspace-write');
  assert.throws(() => handoffTarget('codex', { model: 'gpt-6-luna' }, policy({ excludedModels: ['gpt-6-luna'] }), models), /global policy/);
  assert.throws(() => handoffTarget('pi', { model: 'bad model' }, policy({ extraModels: { pi: ['bad model'] } }), models), /allow-list/);
});

test('harness routes permit only the compatible provider or unmetered for Codex and Claude', async () => {
  const { harnessProviders } = await import('../src/control.js');
  assert.deepEqual(harnessProviders('codex'), ['codex', null]);
  assert.deepEqual(harnessProviders('claude'), ['claude', null]);
  assert.deepEqual(harnessProviders('opencode'), ['claude', 'codex', 'opencodego', null]);
  assert.deepEqual(harnessProviders('pi'), ['claude', 'codex', 'opencodego', null]);
  for (const [kind, model, provider] of [['codex', 'gpt-6-luna', 'claude'], ['codex', 'gpt-6-luna', 'opencodego'], ['claude', 'claude-opus-5-5', 'codex'], ['claude', 'claude-opus-5-5', 'opencodego']]) {
    const errors = validatePolicy(policy({ harnessRoutes: { [kind]: { [model]: provider } } }), models).join(' ');
    assert.match(errors, new RegExp(`harnessRoutes: ${kind}/${model} cannot use ${provider}`), `${kind} refuses ${provider}`);
    assert.match(errors, new RegExp(`Choose ${kind} or null \\(unmetered\\)`));
  }
  assert.deepEqual(validatePolicy(policy({
    extraModels: { codex: ['gpt-7'], claude: ['claude-next'], pi: ['vendor/x'] },
    harnessRoutes: { codex: { 'gpt-6-luna': 'codex', 'gpt-7': null }, claude: { 'claude-sonnet-5-5': 'claude', 'claude-next': null }, pi: { 'vendor/x': 'claude' }, opencode: { 'opencode/big-pickle': 'codex' } },
  }), models), [], 'compatible, unmetered, and open-harness routes are accepted');
  assert.deepEqual(validatePolicy(policy({ modelProviders: { 'opencode-go/deepseek-v4.1-flash': 'codex' } }), models), [], 'open harnesses accept any legacy route');
});

test('saving rejects an incompatible effective legacy route unless the harness has a compatible override', () => {
  const errors = validatePolicy(policy({ modelProviders: { 'gpt-6.1-sol': 'claude' } }), models).join(' ');
  assert.match(errors, /modelProviders: codex\/gpt-6.1-sol inherits claude\. Choose codex or null \(unmetered\) in harnessRoutes\.codex\./);
  assert.match(validatePolicy(policy({ modelProviders: { 'claude-sonnet-5-5': 'opencodego' } }), models).join(' '), /claude\/claude-sonnet-5-5 inherits opencodego\. Choose claude or null/);
  assert.deepEqual(validatePolicy(policy({ modelProviders: { 'gpt-6.1-sol': 'claude' }, harnessRoutes: { codex: { 'gpt-6.1-sol': 'codex' } } }), models), []);
  assert.deepEqual(validatePolicy(policy({ modelProviders: { 'gpt-6.1-sol': 'claude' }, harnessRoutes: { codex: { 'gpt-6.1-sol': null } } }), models), []);
  assert.deepEqual(validatePolicy(policy({ modelProviders: { 'gpt-6.1-sol': 'claude' }, allowedKinds: ['claude', 'pi'] }), models), [], 'a disabled harness does not block a save');
  assert.deepEqual(validatePolicy(policy({ modelProviders: { 'claude-opus-5-5': 'claude' } }), models), [], 'the compatible live route stays valid');
});

test('loading treats an incompatible legacy route as unmetered, keeps the raw value, and warns once', async (t) => {
  const { loadPolicy } = await import('../src/control.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'policy.json');
  const warnings = [];
  const warn = (text) => warnings.push(text);
  fs.writeFileSync(file, JSON.stringify({ modelProviders: { 'gpt-6-astra': 'claude', 'claude-opus-5-5': 'claude', 'opencode-go/mimo-v2.6-flash': 'codex' } }));
  const loaded = loadPolicy({ file, models, warn });
  assert.equal(loaded.modelProviders['gpt-6-astra'], 'claude', 'the raw value stays');
  assert.deepEqual(loaded.ignoredRoutes, { codex: ['gpt-6-astra'] });
  assert.equal(providerFor('codex', 'gpt-6-astra', loaded), null);
  assert.equal(providerFor('claude', 'claude-opus-5-5', loaded), 'claude');
  assert.equal(providerFor('pi', 'opencode-go/mimo-v2.6-flash', loaded), 'codex');
  assert.equal(usageProvider({ kind: 'codex', model: 'gpt-6-astra' }, loaded), 'unmetered-or-unknown');
  const control = deriveControl(snapshot(), loaded, models, {}, Date.parse('2026-09-24T17:00:00Z'));
  assert.ok(control.globalAllowed.codex.includes('gpt-6-astra'), 'the policy still loads and runs');
  loadPolicy({ file, models, warn });
  loadPolicy({ file, models, warn });
  assert.equal(warnings.length, 1, 'the warning appears once');
  assert.match(warnings[0], /codex\/gpt-6-astra.*claude.*Unmetered/);

  fs.writeFileSync(file, JSON.stringify({ modelProviders: { 'claude-opus-5-5': 'claude' } }));
  const quiet = [];
  const compatible = loadPolicy({ file, models, warn: (text) => quiet.push(text) });
  assert.deepEqual(compatible.ignoredRoutes, {});
  assert.deepEqual(quiet, []);
  assert.equal(providerFor('claude', 'claude-opus-5-5', compatible), 'claude');

  fs.writeFileSync(file, JSON.stringify({ modelProviders: { 'gpt-6-astra': 'claude' }, harnessRoutes: { codex: { 'gpt-6-astra': 'codex' } } }));
  const overridden = loadPolicy({ file, models, warn: (text) => quiet.push(text) });
  assert.deepEqual(overridden.ignoredRoutes, {});
  assert.equal(providerFor('codex', 'gpt-6-astra', overridden), 'codex');
  assert.deepEqual(quiet, []);
});

// ----- Idle orchestrator nudges -----

const NUDGE_NOW = Date.parse('2026-09-27T12:00:00Z');
const NUDGE_CFG = { quota: { warnPercent: 90, criticalPercent: 98 }, machine: { memFreeWarnPercent: 15, loadWarnFactor: 2 }, providerKinds: {}, browsers: { staleOwnedMinutes: 30 }, workers: { staleIdleMinutes: 120 }, sharedBrowsers: [] };

function nudgeFixture({ tasks = [], mode = 'auto', effectiveMode = mode, orchStatus = 'idle', workers = [], workspace = 'w1', workspaceLabel = 'HerdrBoss', slug = 'herdrboss' } = {}) {
  return {
    projects: [{ slug, workspace, project: 'HerdrBoss', tasks }],
    control: { projects: { [slug]: { slug, workspace, label: 'HerdrBoss', mode, effectiveMode, orch: { pane: `${workspace}:p1`, status: orchStatus } } } },
    herdr: {
      workspaces: [{ id: workspace, label: workspaceLabel }],
      panes: [
        { id: `${workspace}:p1`, workspace, orch: true, label: 'orch', agent: 'claude', status: orchStatus, sessionId: 's1' },
        ...workers,
      ],
    },
    quotas: [],
    browsers: [],
  };
}

const nudgeAlerts = (snap, paneSince, now = NUDGE_NOW) =>
  evaluate(snap, NUDGE_CFG, paneSince, now, policy({ idleMinutes: 15 })).alerts.filter((a) => a.key.startsWith('nudge:'));

test('the idle-orchestrator nudge starts at the idle threshold and names the ready task', () => {
  const snap = nudgeFixture({ tasks: [{ id: '74', title: 'Parse event log', status: 'todo' }] });
  assert.deepEqual(nudgeAlerts(snap, { 'w1:p1': { since: NUDGE_NOW - 15 * 60000 + 1 } }), [], 'no nudge just before the threshold');
  const [alert] = nudgeAlerts(snap, { 'w1:p1': { since: NUDGE_NOW - 15 * 60000 - 1 } });
  assert.ok(alert, 'a nudge just after the threshold');
  assert.equal(alert.severity, 'info');
  assert.equal(alert.scope, 'w1');
  assert.equal(alert.immediate, undefined, 'the nudge waits for the normal cooldown');
  assert.equal(alert.once, undefined);
  assert.match(alert.text, /idle for 15 minutes/);
  assert.match(alert.text, /task 74 "Parse event log"/);
  assert.match(alert.text, /Start suitable work/);
  assert.doesNotMatch(JSON.stringify(alert), /herdr-boss publish/, 'the notice does not quote project notes');
});

test('the idle-orchestrator nudge names the first use-now harness when a slot is free', () => {
  const snap = nudgeFixture({ tasks: [{ id: '74', title: 'Parse event log', status: 'todo' }] });
  snap.control.projects.herdrboss.slots = 2;
  snap.control.projects.herdrboss.running = 1;
  snap.lanes = {
    codex: { state: 'open', roomPercent: 8 },
    opencodego: { state: 'trickle', allowancePercent: 5, usedTodayPercent: 1.1 },
  };
  const since = { 'w1:p1': { since: NUDGE_NOW - 20 * 60000 } };
  const [alert] = nudgeAlerts(snap, since);

  assert.match(alert.text, /Start ready work on codex now\./);
  snap.control.projects.herdrboss.running = 2;
  const full = nudgeAlerts(snap, since)[0];
  assert.doesNotMatch(full.text, /Start ready work on/);
});

test('the nudge key stays stable per project and task while a new next task prompts again', () => {
  const first = nudgeAlerts(nudgeFixture({ tasks: [{ id: '74', title: 'Parse event log', status: 'todo' }] }), { 'w1:p1': { since: NUDGE_NOW - 20 * 60000 } })[0];
  const again = nudgeAlerts(nudgeFixture({ tasks: [{ id: '74', title: 'Parse event log', status: 'todo' }] }), { 'w1:p1': { since: NUDGE_NOW - 25 * 60000 } });
  assert.equal(again.length, 1);
  assert.equal(again[0].key, first.key, 'the same project and task keep one key');
  const other = nudgeAlerts(nudgeFixture({ tasks: [{ id: '75', title: 'Render graph', status: 'todo' }] }), { 'w1:p1': { since: NUDGE_NOW - 20 * 60000 } })[0];
  assert.notEqual(other.key, first.key, 'a changed next task gets a new key');
  const cooldown = 6 * 3600 * 1000;
  const records = { [`${first.key}@w1:p1`]: { at: NUDGE_NOW, severity: 'info' } };
  assert.equal(alertPromptDue(first, null, NUDGE_NOW, cooldown), true, 'the first nudge is due');
  assert.equal(alertPromptDue(first, records[`${first.key}@w1:p1`], NUDGE_NOW + 3600 * 1000, cooldown), false, 'a repeated key waits for the cooldown');
  assert.equal(alertPromptDue(first, records[`${first.key}@w1:p1`], NUDGE_NOW + 7 * 3600 * 1000, cooldown), true, 'the cooldown expires');
  assert.equal(alertPromptDue(other, records[`${other.key}@w1:p1`] || null, NUDGE_NOW + 3600 * 1000, cooldown), true, 'the new next task prompts before the cooldown ends');
});

test('the nudge ranks actionable tasks by frontier and keeps status-file order inside a rank', () => {
  const ranked = nudgeFixture({ tasks: [
    { id: 'next1', title: 'Later work', status: 'todo', frontier: 'next' },
    { id: 'plain1', title: 'Plain one', status: 'todo' },
    { id: 'cur1', title: 'Now work', status: 'doing', frontier: 'current' },
    { id: 'cur2', title: 'Second current', status: 'todo', frontier: 'current' },
    { id: 'plain2', title: 'Plain two', status: 'todo' },
  ] });
  assert.match(nudgeAlerts(ranked, { 'w1:p1': { since: NUDGE_NOW - 20 * 60000 } })[0].key, /:cur1$/, 'the current frontier wins');
  const withoutCurrent = nudgeFixture({ tasks: [
    { id: 'next1', title: 'Later work', status: 'todo', frontier: 'next' },
    { id: 'plain2', title: 'Plain two', status: 'todo' },
    { id: 'plain1', title: 'Plain one', status: 'todo' },
  ] });
  assert.match(nudgeAlerts(withoutCurrent, { 'w1:p1': { since: NUDGE_NOW - 20 * 60000 } })[0].key, /:plain2$/, 'a task without a frontier ranks before next and keeps file order');
  const onlyNext = nudgeFixture({ tasks: [{ id: 'plain1', title: 'Plain one', status: 'done' }, { id: 'next1', title: 'Later work', status: 'todo', frontier: 'next' }] });
  assert.match(nudgeAlerts(onlyNext, { 'w1:p1': { since: NUDGE_NOW - 20 * 60000 } })[0].key, /:next1$/, 'next work is the last rank');
});

test('a task is actionable only when every blocker is done in the same project', () => {
  const tasks = [
    { id: '70', title: 'Event log spec', status: 'done' },
    { id: '74', title: 'Parse event log', status: 'todo', blockedBy: ['70'] },
    { id: '75', title: 'Render graph', status: 'todo', blockedBy: ['74'] },
    { id: '76', title: 'Export to PNG', status: 'todo', blockedBy: ['99'] },
    { id: '77', title: 'Wait for review', status: 'blocked' },
  ];
  assert.match(nudgeAlerts(nudgeFixture({ tasks }), { 'w1:p1': { since: NUDGE_NOW - 20 * 60000 } })[0].key, /:74$/, 'a done blocker releases its task');
  const finished = tasks.map((t) => t.id === '74' ? { ...t, status: 'done' } : t);
  assert.match(nudgeAlerts(nudgeFixture({ tasks: finished }), { 'w1:p1': { since: NUDGE_NOW - 20 * 60000 } })[0].key, /:75$/, 'the next dependent task becomes actionable');
  const unresolved = tasks.filter((t) => t.id === '70');
  assert.deepEqual(nudgeAlerts(nudgeFixture({ tasks: unresolved }), { 'w1:p1': { since: NUDGE_NOW - 20 * 60000 } }), [], 'an unknown blocker is unresolved');
  const explicitly = tasks.filter((t) => t.id === '77');
  assert.deepEqual(nudgeAlerts(nudgeFixture({ tasks: explicitly }), { 'w1:p1': { since: NUDGE_NOW - 20 * 60000 } }), [], 'a blocked task is not actionable');
});

test('the nudge skips an epic card and a task that waits on the Owner', () => {
  const since = { 'w1:p1': { since: NUDGE_NOW - 20 * 60000 } };
  const epic = nudgeFixture({ tasks: [
    { id: '80', title: 'Release 1.0', status: 'todo', kind: 'epic' },
    { id: '74', title: 'Parse event log', status: 'todo', kind: 'impl' },
  ] });
  assert.match(nudgeAlerts(epic, since)[0].key, /:74$/, 'an epic card is skipped and the next task is named');
  const epicOnly = nudgeFixture({ tasks: [{ id: '80', title: 'Release 1.0', status: 'todo', kind: 'epic' }] });
  assert.deepEqual(nudgeAlerts(epicOnly, since), [], 'an epic card alone sends no notice');

  const owner = nudgeFixture({ tasks: [
    { id: '76', title: 'Choose the export format', status: 'todo', waitingOn: 'owner', ask: 'PNG or SVG?', mailboxId: 'm1727' },
    { id: '74', title: 'Parse event log', status: 'todo' },
  ] });
  assert.match(nudgeAlerts(owner, since)[0].key, /:74$/, 'an Owner wait is skipped and the next task is named');
  const ownerOnly = nudgeFixture({ tasks: [{ id: '76', title: 'Choose the export format', status: 'todo', waitingOn: 'owner', ask: 'PNG or SVG?', mailboxId: 'm1727' }] });
  assert.deepEqual(nudgeAlerts(ownerOnly, since), [], 'an Owner wait alone sends no notice');

  const normal = nudgeAlerts(nudgeFixture({ tasks: [{ id: '74', title: 'Parse event log', status: 'todo' }] }), since);
  assert.equal(normal.length, 1, 'a normal ready task still notifies');
  assert.match(normal[0].key, /:74$/);
});

test('the nudge skips paused and idle projects and the Boss workspace', () => {
  const tasks = [{ id: '74', title: 'Parse event log', status: 'todo' }];
  const since = { 'w1:p1': { since: NUDGE_NOW - 20 * 60000 } };
  assert.equal(nudgeAlerts(nudgeFixture({ tasks, mode: 'paused' }), since).length, 0, 'a paused project is skipped');
  assert.equal(nudgeAlerts(nudgeFixture({ tasks, mode: 'idle' }), since).length, 0, 'an idle project is skipped');
  assert.equal(nudgeAlerts(nudgeFixture({ tasks, mode: 'auto', effectiveMode: 'paused' }), since).length, 0, 'a published paused status is skipped');
  assert.equal(nudgeAlerts(nudgeFixture({ tasks, mode: 'auto', workspace: 'w-boss', workspaceLabel: 'Boss', slug: 'boss' }), { 'w-boss:p1': { since: NUDGE_NOW - 20 * 60000 } }).length, 0, 'the Boss workspace is skipped');
  assert.equal(nudgeAlerts(nudgeFixture({ tasks, mode: 'active' }), since).length, 1, 'an active project is nudged');
});

test('the nudge waits for a quiet workspace and an idle or done orchestrator', () => {
  const tasks = [{ id: '74', title: 'Parse event log', status: 'todo' }];
  const since = { 'w1:p1': { since: NUDGE_NOW - 20 * 60000 } };
  for (const status of ['working', 'blocked', 'failed']) {
    const workers = [{ id: 'w1:p2', workspace: 'w1', orch: false, agent: 'codex', name: `worker-${status}`, status }];
    assert.equal(nudgeAlerts(nudgeFixture({ tasks, workers }), since).length, 0, `a ${status} worker stops the nudge`);
  }
  assert.equal(nudgeAlerts(nudgeFixture({ tasks, orchStatus: 'working' }), since).length, 0, 'a working orchestrator is not nudged');
  const idleWorker = { id: 'w1:p2', workspace: 'w1', orch: false, agent: 'codex', name: 'h27nudges', status: 'idle' };
  const [alert] = nudgeAlerts(nudgeFixture({ tasks, orchStatus: 'done', workers: [idleWorker] }), since);
  assert.ok(alert, 'a done orchestrator with an idle worker is nudged');
  assert.match(alert.text, /Resume an idle or done worker \(h27nudges\)/);
  const finishedWorker = { ...idleWorker, status: 'done' };
  const doneOnly = nudgeAlerts(nudgeFixture({ tasks, workers: [finishedWorker] }), since);
  assert.equal(doneOnly.length, 1, 'a done-only worker does not stop the nudge');
  assert.match(doneOnly[0].text, /Resume an idle or done worker \(h27nudges\)/, 'a done worker is named as resumable');
});

test('a task without an ID gets a stable safe key derived from its title', () => {
  const tasks = [
    { title: 'Export to PNG / SVG (v2)!', status: 'todo' },
    { title: 'Render graph', status: 'todo' },
  ];
  const [alert] = nudgeAlerts(nudgeFixture({ tasks }), { 'w1:p1': { since: NUDGE_NOW - 20 * 60000 } });
  assert.equal(alert.key, 'nudge:idle:herdrboss:export-to-png-svg-v2', 'punctuation collapses to safe key characters');
  assert.doesNotMatch(alert.key, /[^a-z0-9:._-]/, 'the key holds only safe characters');
  assert.match(alert.text, /task "Export to PNG \/ SVG \(v2\)!"/, 'the notice still shows the full title');
  const again = nudgeAlerts(nudgeFixture({ tasks }), { 'w1:p1': { since: NUDGE_NOW - 25 * 60000 } });
  assert.equal(again[0].key, alert.key, 'the derived key stays stable across evaluations');
  const otherTitle = nudgeAlerts(nudgeFixture({ tasks: [{ title: 'Render graph', status: 'todo' }] }), { 'w1:p1': { since: NUDGE_NOW - 20 * 60000 } });
  assert.equal(otherTitle[0].key, 'nudge:idle:herdrboss:render-graph', 'a different title gets its own key');
});

test('no nudge goes out when the published status has no actionable work', () => {
  const since = { 'w1:p1': { since: NUDGE_NOW - 20 * 60000 } };
  assert.deepEqual(nudgeAlerts(nudgeFixture({ tasks: [] }), since), [], 'an empty task list');
  assert.deepEqual(nudgeAlerts(nudgeFixture({ tasks: [{ id: '74', title: 'Parse event log', status: 'done' }] }), since), [], 'only finished tasks');
  assert.deepEqual(nudgeAlerts(nudgeFixture({ tasks: [{ title: 'Untitled work' }] }), since), [], 'a task without a status');
  const snap = nudgeFixture({ tasks: [{ id: '74', title: 'Parse event log', status: 'todo' }] });
  delete snap.projects;
  assert.deepEqual(nudgeAlerts(snap, since), [], 'no published status file');
});

test('savePolicy prunes stale and duplicate model references and returns a note', async () => {
  const { savePolicy } = await import('../src/control.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-prune-'));
  const file = path.join(dir, 'policy.json');
  try {
    const notes = [];
    const draft = policy({
      modelProviders: { 'claude-opus-5': 'claude', 'claude-opus-5-5': 'claude' },
      extraModels: { claude: ['claude-opus-5-5', 'claude-local-x', 'claude-local-x'] },
      disabledModels: { claude: ['claude-opus-5', 'claude-local-x', 'claude-local-x'] },
      harnessRoutes: { claude: { 'claude-opus-5': 'claude', 'claude-local-x': null } },
      excludedModels: ['claude-opus-5'],
      preferredModels: { claude: 'claude-opus-5' },
    });
    assert.deepEqual(savePolicy(draft, models, { file, notes }), []);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(stored.extraModels, { claude: ['claude-local-x'] });
    assert.deepEqual(stored.disabledModels, { claude: ['claude-local-x'] });
    assert.deepEqual(stored.modelProviders, { 'claude-opus-5-5': 'claude' });
    assert.deepEqual(stored.harnessRoutes, { claude: { 'claude-local-x': null } });
    assert.deepEqual(stored.excludedModels, []);
    assert.deepEqual(stored.preferredModels, {});
    assert.equal(notes.length, 1);
    assert.match(notes[0], /^Removed .*claude-opus-5\b/);
    assert.ok(notes[0].length < 300);
    assert.deepEqual(draft.disabledModels.claude, ['claude-opus-5', 'claude-local-x', 'claude-local-x'], 'the input stays unchanged');
    const clean = [];
    assert.deepEqual(savePolicy(policy(), models, { file, notes: clean }), []);
    assert.deepEqual(clean, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('savePolicy keeps strict errors for unrelated malformed fields while it prunes', async () => {
  const { savePolicy } = await import('../src/control.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-prune-strict-'));
  const file = path.join(dir, 'policy.json');
  try {
    const notes = [];
    const errors = savePolicy(policy({
      maxWorkers: 0,
      disabledModels: { claude: ['claude-opus-5'] },
      extraModels: { pi: ['glm; rm -rf ~'] },
      modelProviders: { 'claude-opus-5-5': 'nowhere' },
    }), models, { file, notes });
    const text = errors.join(' ');
    assert.match(text, /maxWorkers/);
    assert.match(text, /Invalid extraModels string for pi/);
    assert.match(text, /Invalid modelProviders route for claude-opus-5-5/);
    assert.doesNotMatch(text, /disabledModels/);
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(notes, []);
    assert.match(savePolicy(policy({ disabledModels: { claude: 'claude-opus-5' } }), models, { file }).join(' '), /disabledModels\.claude must be a list/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('swap policy settings have defaults and range checks', () => {
  assert.deepEqual([POLICY_DEFAULTS.machine.swapWarnPercent, POLICY_DEFAULTS.machine.swapRefusePercent, POLICY_DEFAULTS.machine.swapMinUsedGB], [80, 95, 2]);
  const errors = (patch) => validatePolicy({ ...policy(), machine: { ...POLICY_DEFAULTS.machine, ...patch } }, models).filter((e) => /swap/.test(e));
  assert.deepEqual(errors({}), []);
  assert.deepEqual(errors({ swapWarnPercent: null, swapRefusePercent: null, swapMinUsedGB: 0 }), []);
  assert.deepEqual(errors({ swapWarnPercent: 1, swapRefusePercent: 100, swapMinUsedGB: 1024 }), []);
  for (const key of ['swapWarnPercent', 'swapRefusePercent']) {
    for (const bad of [0, 101, 50.5, '80', NaN]) assert.match(errors({ [key]: bad }).join(' '), new RegExp(`machine.${key}`), `${key} ${bad}`);
  }
  for (const bad of [-1, 1025, null, '2', NaN]) assert.match(errors({ swapMinUsedGB: bad }).join(' '), /machine.swapMinUsedGB/, `GB ${bad}`);
});

test('an older policy without swap settings loads the defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-policy-swap-'));
  try {
    const file = path.join(dir, 'policy.json');
    fs.writeFileSync(file, JSON.stringify({ machine: { guardEnabled: false } }));
    const loaded = loadPolicy({ file, models, warn: () => {} });
    assert.deepEqual([loaded.machine.swapWarnPercent, loaded.machine.swapRefusePercent, loaded.machine.swapMinUsedGB], [80, 95, 2]);
    assert.equal(loaded.machine.guardEnabled, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the kit digest interval has a default and a range check', () => {
  assert.equal(POLICY_DEFAULTS.machine.kitDigestMinutes, 120);
  const errors = (patch) => validatePolicy({ ...policy(), machine: { ...POLICY_DEFAULTS.machine, ...patch } }, models).filter((e) => /kitDigestMinutes/.test(e));
  assert.deepEqual(errors({}), []);
  assert.deepEqual(errors({ kitDigestMinutes: 10 }), []);
  assert.deepEqual(errors({ kitDigestMinutes: 1440 }), []);
  for (const bad of [9, 1441, 60.5, '120', null, NaN]) assert.match(errors({ kitDigestMinutes: bad }).join(' '), /machine.kitDigestMinutes/, `minutes ${bad}`);
});
