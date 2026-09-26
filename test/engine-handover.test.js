import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { POLICY_DEFAULTS } from '../src/control.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const probe = `
import { Engine } from './src/engine.js';
import { loadConfig } from './src/config.js';
const input = JSON.parse(process.env.H24_SCENARIO);
const now = Date.parse('2026-09-26T12:00:00.000Z');
Date.now = () => now;
const calls = [];
const collectorCalls = { herdr: 0, processes: 0, quotas: 0 };
const cfg = loadConfig();
cfg.push = false;
cfg.quotaSeconds = 300;
cfg.tickSeconds = 30;
cfg.browsers.reapOrphanDaemons = false;
const engine = new Engine(cfg, {
  push: false,
  act: true,
  collectors: {
    collectHerdr: async () => { collectorCalls.herdr += 1; return input.herdr; },
    collectMachine: async () => null,
    collectProcesses: async () => { collectorCalls.processes += 1; return new Map(); },
    collectQuotas: async () => { collectorCalls.quotas += 1; return input.quotas; },
    collectWorktreeCounts: async () => ({}),
    collectCwdProcesses: async () => [],
    collectMissingWorktreeProcesses: async () => [],
    readWorkerScreen: async () => '',
  },
  handoffRunner: async (command, args) => {
    calls.push({ command, args });
    if (args[2] === 'plan') return JSON.stringify({ migration: { available: true } });
    if (args[2] === 'prepare') return JSON.stringify({ id: 'fake-handoff', newPane: 'fake-successor' });
    return JSON.stringify({ ok: true });
  },
});
engine.deliver = async () => {};
await engine.tick();
console.log(JSON.stringify({ calls, collectorCalls, control: engine.state.control, lanes: engine.state.lanes }));
`;

const liveQuota = (usedPercent) => [{ provider: 'claude', windows: [{
  key: 'primary', label: 'Weekly', usedPercent, expectedPercent: 60,
  resetsAt: '2026-10-01T12:00:00.000Z',
}] }];

function runScenario(t, scenario) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-ignore-handover-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  const policy = structuredClone(POLICY_DEFAULTS);
  policy.autoHandover = true;
  policy.providerModes.claude = 'ignore';
  if (scenario.ladder) {
    policy.orchestratorLadder = scenario.ladder;
    policy.harnessRoutes = { pi: { 'opencode-go/deepseek-v4.1-flash': null } };
  }
  fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(policy));
  fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify({
    paneSince: {}, pushes: {}, notified: {}, lastOrchestrators: scenario.lastOrchestrators,
    exhaustedFreeModels: scenario.exhaustedFreeModels || {},
  }));
  fs.writeFileSync(path.join(dir, 'handoffs.json'), JSON.stringify(scenario.handoffs || []));

  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: dir,
      HERDR_BOSS_DIR: dir,
      HERDR_BOSS_LIVE_DIR: dir,
      HERDR_BOSS_ALLOW_ACTIONS: '1',
      NODE_TEST_CONTEXT: '',
      H24_SCENARIO: JSON.stringify({ herdr: scenario.herdr, quotas: liveQuota(scenario.usedPercent ?? 98) }),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test('Ignore quota still prepares successors for stopped project orchestrators and the stopped Boss', { timeout: 30000 }, (t) => {
  const project = runScenario(t, {
    usedPercent: 98,
    lastOrchestrators: { 'w-alpha': { pane: 'w-alpha:p1', kind: 'claude', project: 'alpha' } },
    herdr: {
      workspaces: [{ id: 'w-alpha', label: 'Alpha' }],
      panes: [{ id: 'w-alpha:p1', workspace: 'w-alpha', label: 'orch', orch: true, agent: null, status: null }],
    },
  });
  assert.deepEqual(project.collectorCalls, { herdr: 1, processes: 1, quotas: 1 });
  assert.deepEqual(project.calls.map(({ args }) => args.slice(1, 3)), [['handoff', 'plan'], ['handoff', 'prepare']]);
  assert.equal(project.calls[0].args[3], 'w-alpha:p1');
  assert.equal(project.calls[1].args[3], 'w-alpha:p1');

  const boss = runScenario(t, {
    usedPercent: 98,
    lastOrchestrators: { 'w-boss': { pane: 'w-boss:p1', kind: 'claude', project: 'Boss', boss: true } },
    herdr: {
      workspaces: [{ id: 'w-boss', label: 'Boss' }],
      panes: [{ id: 'w-boss:p1', workspace: 'w-boss', label: 'boss', orch: false, agent: null, status: null }],
    },
  });
  assert.deepEqual(boss.collectorCalls, { herdr: 1, processes: 1, quotas: 1 });
  assert.deepEqual(boss.calls.map(({ args }) => args.slice(1, 3)), [['handoff', 'plan'], ['handoff', 'prepare']]);
  assert.equal(boss.calls[0].args[3], 'w-boss:p1');
  assert.equal(boss.calls[1].args[3], 'w-boss:p1');
});

test('automatic stopped project and Boss handovers skip actively exhausted free successor models', { timeout: 30000 }, (t) => {
  const common = {
    usedPercent: 98,
    ladder: [
      { kind: 'pi', model: 'opencode-go/deepseek-v4.1-flash' },
      { kind: 'codex', model: 'gpt-6-luna', effort: 'xhigh' },
    ],
    exhaustedFreeModels: {
      'opencode-go/deepseek-v4.1-flash': { model: 'opencode-go/deepseek-v4.1-flash', retryAt: Date.parse('2026-09-26T12:01:00.000Z') },
    },
  };
  const project = runScenario(t, {
    ...common,
    lastOrchestrators: { 'w-alpha': { pane: 'w-alpha:p1', kind: 'claude', project: 'alpha' } },
    herdr: {
      workspaces: [{ id: 'w-alpha', label: 'Alpha' }],
      panes: [{ id: 'w-alpha:p1', workspace: 'w-alpha', label: 'orch', orch: true, agent: null, status: null }],
    },
  });
  const boss = runScenario(t, {
    ...common,
    lastOrchestrators: { 'w-boss': { pane: 'w-boss:p1', kind: 'claude', project: 'Boss', boss: true } },
    herdr: {
      workspaces: [{ id: 'w-boss', label: 'Boss' }],
      panes: [{ id: 'w-boss:p1', workspace: 'w-boss', label: 'boss', orch: false, agent: null, status: null }],
    },
  });

  for (const result of [project, boss]) {
    const plan = result.calls.find(({ args }) => args[2] === 'plan');
    assert.ok(plan);
    assert.equal(plan.args[plan.args.indexOf('--to') + 1], 'codex');
    assert.equal(plan.args[plan.args.indexOf('--model') + 1], 'gpt-6-luna');
  }
});

test('automatic proactive project and Boss handovers skip actively exhausted free successor models', { timeout: 30000 }, (t) => {
  const common = {
    usedPercent: 98,
    ladder: [
      { kind: 'pi', model: 'opencode-go/deepseek-v4.1-flash' },
      { kind: 'codex', model: 'gpt-6-luna', effort: 'xhigh' },
    ],
    exhaustedFreeModels: {
      'opencode-go/deepseek-v4.1-flash': { model: 'opencode-go/deepseek-v4.1-flash', retryAt: Date.parse('2026-09-26T12:01:00.000Z') },
    },
  };
  const project = runScenario(t, {
    ...common,
    herdr: {
      workspaces: [{ id: 'w-alpha', label: 'Alpha' }],
      panes: [{ id: 'w-alpha:p1', workspace: 'w-alpha', label: 'orch', orch: true, agent: 'claude', status: 'working', sessionId: 'source-session' }],
    },
  });
  const boss = runScenario(t, {
    ...common,
    herdr: {
      workspaces: [{ id: 'w-boss', label: 'Boss' }],
      panes: [{ id: 'w-boss:p1', workspace: 'w-boss', label: 'boss', orch: false, agent: 'claude', status: 'working', sessionId: 'boss-session' }],
    },
  });

  for (const result of [project, boss]) {
    const plan = result.calls.find(({ args }) => args[2] === 'plan');
    assert.ok(plan);
    assert.equal(plan.args[plan.args.indexOf('--to') + 1], 'codex');
    assert.equal(plan.args[plan.args.indexOf('--model') + 1], 'gpt-6-luna');
  }
});

test('Ignore quota activates a prepared successor at the configured live quota threshold', { timeout: 30000 }, (t) => {
  const scenario = {
    usedPercent: 98,
    lastOrchestrators: { 'w-alpha': { pane: 'w-alpha:p1', kind: 'claude', project: 'alpha' } },
    herdr: {
      workspaces: [{ id: 'w-alpha', label: 'Alpha' }],
      panes: [
        { id: 'w-alpha:p1', workspace: 'w-alpha', label: 'orch', orch: true, agent: 'claude', status: 'working' },
        { id: 'w-alpha:p2', workspace: 'w-alpha', label: null, orch: false, agent: 'codex', status: 'idle' },
      ],
    },
    handoffs: [{
      id: 'prepared-1', project: 'alpha', workspace: 'w-alpha', label: 'orch', sourcePane: 'w-alpha:p1',
      newPane: 'w-alpha:p2', fromKind: 'claude', toKind: 'codex', status: 'prepared', automatic: true,
      readyAt: '2026-09-26T11:00:00.000Z', preparedAt: '2026-09-26T11:00:00.000Z',
    }],
  };

  const belowThreshold = runScenario(t, { ...scenario, usedPercent: 97 });
  assert.deepEqual(belowThreshold.collectorCalls, { herdr: 1, processes: 1, quotas: 1 });
  assert.equal(belowThreshold.calls.some(({ args }) => args[2] === 'activate'), false);

  const atThreshold = runScenario(t, scenario);
  assert.deepEqual(atThreshold.collectorCalls, { herdr: 1, processes: 1, quotas: 1 });
  assert.equal(atThreshold.calls.some(({ args }) => args[2] === 'activate' && args[3] === 'prepared-1'), true);
});
