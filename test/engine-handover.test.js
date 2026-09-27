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
    collectPiModels: async () => null,
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
    exhaustedFreeLanes: scenario.exhaustedFreeLanes || {},
    ...(scenario.piModels ? { piModels: scenario.piModels } : {}),
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

const handoverShapes = {
  stoppedProject: {
    lastOrchestrators: { 'w-alpha': { pane: 'w-alpha:p1', kind: 'claude', project: 'alpha' } },
    herdr: {
      workspaces: [{ id: 'w-alpha', label: 'Alpha' }],
      panes: [{ id: 'w-alpha:p1', workspace: 'w-alpha', label: 'orch', orch: true, agent: null, status: null }],
    },
  },
  stoppedBoss: {
    lastOrchestrators: { 'w-boss': { pane: 'w-boss:p1', kind: 'claude', project: 'Boss', boss: true } },
    herdr: {
      workspaces: [{ id: 'w-boss', label: 'Boss' }],
      panes: [{ id: 'w-boss:p1', workspace: 'w-boss', label: 'boss', orch: false, agent: null, status: null }],
    },
  },
  proactiveProject: {
    herdr: {
      workspaces: [{ id: 'w-alpha', label: 'Alpha' }],
      panes: [{ id: 'w-alpha:p1', workspace: 'w-alpha', label: 'orch', orch: true, agent: 'claude', status: 'working', sessionId: 'source-session' }],
    },
  },
  proactiveBoss: {
    herdr: {
      workspaces: [{ id: 'w-boss', label: 'Boss' }],
      panes: [{ id: 'w-boss:p1', workspace: 'w-boss', label: 'boss', orch: false, agent: 'claude', status: 'working', sessionId: 'boss-session' }],
    },
  },
};

function assertCodexSuccessor(t, common) {
  for (const [shape, scenario] of Object.entries(handoverShapes)) {
    const result = runScenario(t, { ...common, ...scenario });
    const plan = result.calls.find(({ args }) => args[2] === 'plan');
    assert.ok(plan, shape);
    assert.equal(plan.args[plan.args.indexOf('--to') + 1], 'codex', shape);
    assert.equal(plan.args[plan.args.indexOf('--model') + 1], 'gpt-6-luna', shape);
    const recommended = [...result.control.handoffs, result.control.bossHandoff].filter((item) => item?.target);
    assert.equal(recommended.some((item) => item.target.kind !== 'codex'), false, shape);
  }
}

test('automatic project and Boss handovers skip unmetered rungs of an exhausted free lane', { timeout: 60000 }, (t) => {
  assertCodexSuccessor(t, {
    usedPercent: 98,
    ladder: [
      { kind: 'opencode', model: 'opencode/big-pickle' },
      { kind: 'codex', model: 'gpt-6-luna', effort: 'xhigh' },
    ],
    exhaustedFreeLanes: {
      opencode: { kind: 'opencode', retryAt: Date.parse('2026-09-26T12:01:00.000Z'), retryKnown: true, at: Date.parse('2026-09-26T11:59:00.000Z') },
    },
  });
});

test('automatic project and Boss handovers skip a Pi rung that the last good Pi result does not list', { timeout: 60000 }, (t) => {
  assertCodexSuccessor(t, {
    usedPercent: 98,
    ladder: [
      { kind: 'pi', model: 'opencode-go/deepseek-v4.1-flash' },
      { kind: 'codex', model: 'gpt-6-luna', effort: 'xhigh' },
    ],
    piModels: { at: Date.parse('2026-09-26T11:55:00.000Z'), models: ['opencode-go/mimo-v2.6-flash'] },
  });
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

// The notice probe runs several engine ticks against fake Herdr snapshots and a fake Herdr runner.
const noticeProbe = `
import { Engine } from './src/engine.js';
import { loadConfig } from './src/config.js';
const input = JSON.parse(process.env.H26_SCENARIO);
let now = Date.parse(input.ticks[0].at);
Date.now = () => now;
let tick = input.ticks[0];
const calls = [];
const cfg = loadConfig();
cfg.push = true;
cfg.browsers.reapOrphanDaemons = false;
const engine = new Engine(cfg, {
  push: true,
  act: true,
  collectors: {
    collectHerdr: async () => tick.herdr,
    collectMachine: async () => null,
    collectProcesses: async () => new Map(),
    collectQuotas: async () => [],
    collectWorktreeCounts: async () => ({}),
    collectCwdProcesses: async () => [],
    collectMissingWorktreeProcesses: async () => [],
    readWorkerScreen: async () => '',
  },
  handoffRunner: async () => { throw new Error('unexpected handoff command'); },
  herdrRunner: async (command, args) => {
    calls.push({ tick: tick.at, command, args });
    const recipient = args[0] === 'notification' ? 'owner' : args[2];
    const id = 'cli:' + args[0] + ':' + args[1];
    if ((tick.fail || []).includes(recipient)) throw Object.assign(new Error('fake failure'), { stderr: 'Pane not found.' });
    // The installed CLI can print an error envelope and exit with status 0.
    if ((tick.errorEnvelope || []).includes(recipient)) return JSON.stringify({ id, error: { code: 'pane_not_found', message: 'Pane not found.' } }) + '\\n';
    if (Object.hasOwn(tick.stdout || {}, recipient)) return tick.stdout[recipient];
    return JSON.stringify({ id, result: {} }) + '\\n';
  },
});
engine.deliver = async () => {};
for (const next of input.ticks) {
  tick = next;
  now = Date.parse(next.at);
  await engine.tick();
}
console.log(JSON.stringify({ calls, notices: engine.memory.handoffPeerNotices, events: engine.events }));
`;

function runNoticeScenario(t, { handoffs, ticks, notices = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-notice-handover-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  // A stray Herdr call fails and is recorded instead of reaching a real pane.
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'herdr'), `#!/bin/sh\necho "$@" >> "${path.join(dir, 'stray-herdr')}"\nexit 1\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(structuredClone(POLICY_DEFAULTS)));
  fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify({ paneSince: {}, pushes: {}, notified: {}, handoffPeerNotices: notices }));
  fs.writeFileSync(path.join(dir, 'handoffs.json'), JSON.stringify(handoffs));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', noticeProbe], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: dir,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      HERDR_BOSS_DIR: dir,
      HERDR_BOSS_LIVE_DIR: dir,
      HERDR_BOSS_ALLOW_ACTIONS: '1',
      NODE_TEST_CONTEXT: '',
      H26_SCENARIO: JSON.stringify({ ticks }),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  output.records = JSON.parse(fs.readFileSync(path.join(dir, 'handoffs.json'), 'utf8'));
  assert.equal(fs.existsSync(path.join(dir, 'stray-herdr')), false, 'the engine called a Herdr binary outside the fake runner');
  return output;
}

// Normalized collectHerdr panes, as the engine sees them.
const pane = (id, workspace, { label = null, agent = 'codex', status = 'idle' } = {}) => ({ id, workspace, label, orch: label === 'orch' || label === 'boss', agent, status });

const projectRecord = {
  id: 'handoff-alpha', project: 'alpha', displayLabel: 'Alpha', workspace: 'w-alpha', label: 'orch', boss: false,
  sourcePane: 'w-alpha:p1', newPane: 'w-alpha:p2', fromKind: 'claude', toKind: 'codex', status: 'active',
  activatedAt: '2026-09-27T12:00:00.000Z', peerPanes: ['w-alpha:p3', 'w-alpha:p4'],
  ownerGoal: 'Ship the release safely.', sourceContext: 'Earlier safe context',
};
const projectPanes = [
  pane('w-alpha:p1', 'w-alpha', { label: 'orch previous', agent: 'claude' }),
  pane('w-alpha:p2', 'w-alpha', { label: 'orch' }),
  pane('w-alpha:p3', 'w-alpha'),
  pane('w-alpha:p4', 'w-alpha', { agent: 'pi' }),
  pane('w-boss:p1', 'w-boss', { label: 'boss', agent: 'claude' }),
  pane('w-other:p1', 'w-other', { label: 'orch', agent: 'claude' }),
];
const herdrSnapshot = (panes) => ({ workspaces: [...new Set(panes.map((p) => p.workspace))].map((id) => ({ id, label: id })), panes });

const retirementProbe = `
import { Engine } from './src/engine.js';
import { loadConfig } from './src/config.js';
const input = JSON.parse(process.env.H26_RETIREMENT_SCENARIO);
let now = Date.parse(input.ticks[0].at);
Date.now = () => now;
let tick = input.ticks[0];
const calls = [];
const cfg = loadConfig(); cfg.push = true; cfg.browsers.reapOrphanDaemons = false;
const engine = new Engine(cfg, {
  push: true, act: input.act !== false,
  collectors: {
    collectHerdr: async () => { const current = input.ticks.find((item) => Date.parse(item.at) === now); if (current.unavailable) throw new Error('pane list unavailable'); if (current.snapshotValue === 'undefined') return undefined; if (current.snapshotValue === 'null') return null; return current.herdr; },
    collectMachine: async () => null, collectProcesses: async () => new Map(), collectQuotas: async () => [],
    collectWorktreeCounts: async () => ({}), collectCwdProcesses: async () => [], collectMissingWorktreeProcesses: async () => [], readWorkerScreen: async () => '',
  },
  handoffRunner: async () => { throw new Error('unexpected handoff runner call'); },
  herdrRunner: async (command, args) => {
    calls.push({ at: tick.at, command, args });
    if (tick.failClose && args[0] === 'pane' && args[1] === 'close') throw new Error('fake close failed');
    return '{}';
  },
});
engine.deliver = async () => {};
for (const next of input.ticks) { tick = next; now = Date.parse(next.at); await engine.tick(); }
console.log(JSON.stringify({ calls, retirements: engine.memory.handoffRetirements || {} }));
`;

function runRetirementScenario(t, { record, records, panes, ticks, act = true }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-retirement-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(structuredClone(POLICY_DEFAULTS)));
  fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify({ paneSince: {}, pushes: {}, notified: {} }));
  fs.writeFileSync(path.join(dir, 'handoffs.json'), JSON.stringify(records || [record]));
  const tickData = ticks.map((x) => ({ ...x,
    herdr: x.unavailable || x.snapshotValue === 'undefined' ? null : x.snapshotValue === 'missing-panes' ? { workspaces: [] } : herdrSnapshot(x.panes || panes),
  }));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', retirementProbe], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, HOME: dir, HERDR_BOSS_DIR: dir, HERDR_BOSS_LIVE_DIR: dir,
      HERDR_BOSS_ALLOW_ACTIONS: '1', NODE_TEST_CONTEXT: '', H26_RETIREMENT_SCENARIO: JSON.stringify({ ticks: tickData, act }),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  output.records = JSON.parse(fs.readFileSync(path.join(dir, 'handoffs.json'), 'utf8'));
  return output;
}

for (const [kind, workspace] of [['orch', 'w-alpha'], ['boss', 'w-boss']]) {
  test(`${kind} previous pane retires only after 120 minutes with a one-time successor notice`, { timeout: 30000 }, (t) => {
    const sourcePane = `${workspace}:p1`, newPane = `${workspace}:p2`;
    const record = { id: `retire-${kind}`, project: kind === 'boss' ? 'Boss' : 'alpha', workspace, label: kind,
      boss: kind === 'boss', sourcePane, newPane, status: 'active', activatedAt: '2026-09-27T12:00:00.000Z' };
    const panes = [pane(sourcePane, workspace, { label: `${kind} previous` }), pane(newPane, workspace, { label: kind })];
    const result = runRetirementScenario(t, { record, panes, ticks: [
      { at: '2026-09-27T13:59:59.999Z' }, { at: '2026-09-27T14:00:00.000Z' }, { at: '2026-09-27T14:01:00.000Z' },
    ] });
    const closes = result.calls.filter(({ args }) => args[0] === 'pane' && args[1] === 'close');
    assert.deepEqual(closes.map(({ args }) => args[2]), [sourcePane]);
    assert.equal(result.calls.filter(({ args }) => args[0] === 'agent' && args[1] === 'prompt' && args[2] === newPane).length, 1);
    assert.equal(result.records[0].retirement.outcome, 'closed');
  });
}

test('retirement defers for absent source, unsafe pane labels, missing successor, unavailable snapshot, and act:false', { timeout: 30000 }, (t) => {
  const record = { ...projectRecord, activatedAt: '2026-09-27T12:00:00.000Z' };
  const due = '2026-09-27T14:00:00.000Z';
  const current = projectPanes;
  const cases = [
    { panes: current.filter((p) => p.id !== record.sourcePane), expect: 0 },
    { panes: current.map((p) => p.id === record.sourcePane ? { ...p, label: 'orch' } : p), expect: 0 },
    { panes: current.filter((p) => p.id !== record.newPane), expect: 0 },
    { unavailable: true, panes: [], expect: 0 },
  ];
  for (const scenario of cases) {
    const result = runRetirementScenario(t, { record, panes: current, ticks: [{ at: due, ...scenario }] });
    assert.equal(result.calls.some(({ args }) => args[0] === 'pane' && args[1] === 'close'), false);
  }
  const absent = runRetirementScenario(t, { record, panes: current, ticks: [{ at: due, panes: current.filter((p) => p.id !== record.sourcePane) }] });
  assert.equal(absent.records[0].retirement.outcome, 'source-absent');
  const disabled = runRetirementScenario(t, { record, panes: current, act: false, ticks: [{ at: due }] });
  assert.equal(disabled.calls.some(({ args }) => args[0] === 'pane' && args[1] === 'close'), false);
});

test('resolved null, undefined, or missing-panes snapshots do not complete due retirement', { timeout: 30000 }, (t) => {
  const record = { ...projectRecord, activatedAt: '2026-09-27T12:00:00.000Z' };
  for (const snapshotValue of ['null', 'undefined', 'missing-panes']) {
    const result = runRetirementScenario(t, { record, panes: projectPanes, ticks: [{ at: '2026-09-27T14:00:00.000Z', snapshotValue }] });
    assert.equal(result.calls.some(({ args }) => args[0] === 'pane' && args[1] === 'close'), false, snapshotValue);
    assert.equal(result.records[0].retirement, undefined, snapshotValue);
  }
});

test('failed retirement close retries and records only one successful successor notice', { timeout: 30000 }, (t) => {
  const record = { ...projectRecord, activatedAt: '2026-09-27T12:00:00.000Z' };
  const result = runRetirementScenario(t, { record, panes: projectPanes, ticks: [
    { at: '2026-09-27T14:00:00.000Z', failClose: true }, { at: '2026-09-27T14:01:00.000Z' }, { at: '2026-09-27T14:02:00.000Z' },
  ] });
  assert.equal(result.calls.filter(({ args }) => args[0] === 'pane' && args[1] === 'close').length, 2);
  assert.equal(result.calls.filter(({ args }) => args[0] === 'agent' && args[1] === 'prompt' && args[2] === record.newPane).length, 1);
  assert.equal(result.records[0].retirement.outcome, 'closed');
});

test('retirement notice waits for the confirmed successor to become idle or done', { timeout: 30000 }, (t) => {
  const record = { ...projectRecord, activatedAt: '2026-09-27T12:00:00.000Z' };
  const working = projectPanes.map((p) => p.id === record.newPane ? { ...p, agent: 'codex', status: 'working' } : p);
  const idle = projectPanes.map((p) => p.id === record.newPane ? { ...p, agent: 'codex', status: 'idle' } : p);
  const result = runRetirementScenario(t, { record, panes: projectPanes, ticks: [
    { at: '2026-09-27T14:00:00.000Z', panes: working },
    { at: '2026-09-27T14:01:00.000Z', panes: idle.filter((p) => p.id !== record.sourcePane) },
    { at: '2026-09-27T14:02:00.000Z', panes: idle.filter((p) => p.id !== record.sourcePane) },
  ] });
  assert.equal(result.calls.filter(({ args }) => args[0] === 'pane' && args[1] === 'close').length, 1);
  const notices = result.calls.filter(({ args }) => args[0] === 'agent' && args[1] === 'prompt' && args[2] === record.newPane);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].at, '2026-09-27T14:01:00.000Z');
  assert.equal(result.records[0].retirement.outcome, 'closed');
});

test('a due older handoff closes only its own verified source pane', { timeout: 30000 }, (t) => {
  const older = { ...projectRecord, id: 'older-handoff', activatedAt: '2026-09-27T12:00:00.000Z',
    sourcePane: 'w-alpha:p1', newPane: 'w-alpha:p2' };
  const newer = { ...projectRecord, id: 'newer-handoff', activatedAt: '2026-09-27T13:00:00.000Z',
    sourcePane: 'w-alpha:p2', newPane: 'w-alpha:p5' };
  const panes = [pane('w-alpha:p1', 'w-alpha', { label: 'orch previous' }), pane('w-alpha:p2', 'w-alpha', { label: 'orch' }),
    pane('w-alpha:p5', 'w-alpha', { label: 'orch' })];
  const result = runRetirementScenario(t, { record: older, records: [older, newer], panes, ticks: [{ at: '2026-09-27T14:00:00.000Z' }] });
  assert.deepEqual(result.calls.filter(({ args }) => args[0] === 'pane' && args[1] === 'close').map(({ args }) => args[2]), ['w-alpha:p1']);
  assert.equal(result.records[0].retirement.outcome, 'closed');
  assert.equal(result.records[1].retirement, undefined);
  assert.equal(result.records[1].status, 'active');
});

test('retirement follows a verified active successor chain and notifies only its current pane', { timeout: 30000 }, (t) => {
  const first = { ...projectRecord, id: 'chain-one', activatedAt: '2026-09-27T12:00:00.000Z',
    sourcePane: 'w-alpha:p1', newPane: 'w-alpha:p2', activation: { at: '2026-09-27T12:00:00.000Z',
      sourcePane: 'w-alpha:p1', successorPane: 'w-alpha:p2', sourceLabel: 'orch previous', successorLabel: 'orch' } };
  const second = { ...projectRecord, id: 'chain-two', activatedAt: '2026-09-27T13:00:00.000Z',
    sourcePane: 'w-alpha:p2', newPane: 'w-alpha:p5', activation: { at: '2026-09-27T13:00:00.000Z',
      sourcePane: 'w-alpha:p2', successorPane: 'w-alpha:p5', sourceLabel: 'orch previous', successorLabel: 'orch' } };
  const panes = [pane('w-alpha:p1', 'w-alpha', { label: 'orch previous' }),
    pane('w-alpha:p2', 'w-alpha', { label: 'orch previous' }), pane('w-alpha:p5', 'w-alpha', { label: 'orch', agent: 'codex', status: 'idle' })];
  const result = runRetirementScenario(t, { record: first, records: [first, second], panes, ticks: [{ at: '2026-09-27T14:00:00.000Z' }] });
  assert.deepEqual(result.calls.filter(({ args }) => args[0] === 'pane' && args[1] === 'close').map(({ args }) => args[2]), ['w-alpha:p1']);
  const notices = result.calls.filter(({ args }) => args[0] === 'agent' && args[1] === 'prompt');
  assert.deepEqual(notices.map(({ args }) => args[2]), ['w-alpha:p5']);
  assert.equal(result.records[0].retirement.outcome, 'closed');
  assert.equal(result.records[1].retirement, undefined);
});

test('retirement closes a superseded pane and resolves through it to the active successor', { timeout: 30000 }, (t) => {
  const first = { ...projectRecord, id: 'chain-superseded', activatedAt: '2026-09-27T10:00:00.000Z',
    sourcePane: 'w-alpha:p1', newPane: 'w-alpha:p2', status: 'superseded', supersededBy: 'chain-current',
    activation: { at: '2026-09-27T10:00:00.000Z', sourcePane: 'w-alpha:p1', successorPane: 'w-alpha:p2', sourceLabel: 'orch previous', successorLabel: 'orch' } };
  const current = { ...projectRecord, id: 'chain-current', activatedAt: '2026-09-27T12:30:00.000Z',
    sourcePane: 'w-alpha:p2', newPane: 'w-alpha:p5',
    activation: { at: '2026-09-27T12:30:00.000Z', sourcePane: 'w-alpha:p2', successorPane: 'w-alpha:p5', sourceLabel: 'orch previous', successorLabel: 'orch' } };
  const panes = [pane('w-alpha:p1', 'w-alpha', { label: 'orch previous' }),
    pane('w-alpha:p2', 'w-alpha', { label: 'orch previous' }), pane('w-alpha:p5', 'w-alpha', { label: 'orch', agent: 'codex', status: 'idle' })];
  const result = runRetirementScenario(t, { record: first, records: [first, current], panes, ticks: [{ at: '2026-09-27T13:00:00.000Z' }] });
  assert.deepEqual(result.calls.filter(({ args }) => args[0] === 'pane' && args[1] === 'close').map(({ args }) => args[2]), ['w-alpha:p1']);
  assert.deepEqual(result.calls.filter(({ args }) => args[0] === 'agent' && args[1] === 'prompt').map(({ args }) => args[2]), ['w-alpha:p5']);
  assert.equal(result.records[0].retirement.outcome, 'closed');
  assert.equal(result.records[1].retirement, undefined);
});

test('the engine supersedes older active handoffs once and keeps the result on later ticks', { timeout: 30000 }, (t) => {
  const older = { ...projectRecord, id: 'engine-old', activatedAt: '2026-09-27T12:00:00.000Z',
    sourcePane: 'w-alpha:p1', newPane: 'w-alpha:p2', peerPanes: [] };
  const newer = { ...projectRecord, id: 'engine-current', activatedAt: '2026-09-27T12:00:30.000Z',
    sourcePane: 'w-alpha:p2', newPane: 'w-alpha:p5', peerPanes: [] };
  const panes = [pane('w-alpha:p1', 'w-alpha', { label: 'orch previous' }),
    pane('w-alpha:p2', 'w-alpha', { label: 'orch previous' }), pane('w-alpha:p5', 'w-alpha', { label: 'orch' })];
  const result = runNoticeScenario(t, { handoffs: [older, newer], ticks: [
    { at: '2026-09-27T12:01:00.000Z', herdr: herdrSnapshot(panes) },
    { at: '2026-09-27T12:03:00.000Z', herdr: herdrSnapshot(panes) },
  ] });
  const updated = result.records.find(({ id }) => id === older.id);
  assert.equal(updated.status, 'superseded');
  assert.equal(updated.supersededBy, newer.id);
  assert.equal(updated.supersededAt, '2026-09-27T12:01:00.000Z');
  assert.equal(result.events.filter(({ text }) => text?.includes(`Superseded handoff ${older.id}`)).length, 1);
});

test('a superseded handoff sends no notice', { timeout: 30000 }, (t) => {
  const superseded = { ...projectRecord, status: 'superseded', supersededBy: 'handoff-alpha-next',
    peerPanes: ['w-alpha:p3', 'w-alpha:p4'] };
  const result = runNoticeScenario(t, { handoffs: [superseded], ticks: [
    { at: '2026-09-27T12:01:00.000Z', herdr: herdrSnapshot(projectPanes) },
  ] });
  assert.deepEqual(result.calls, []);
  assert.deepEqual(result.notices, {});
});

test('a Boss pane change preserves a delivered canonical or legacy Boss notice', { timeout: 30000 }, (t) => {
  const panes = projectPanes.map((entry) => entry.id === 'w-boss:p1'
    ? { ...entry, label: 'boss previous' }
    : entry).concat(pane('w-boss:p2', 'w-boss', { label: 'boss', agent: 'claude' }));
  const ticks = [{ at: '2026-09-27T12:01:00.000Z', herdr: herdrSnapshot(panes) }];
  const canonical = runNoticeScenario(t, { handoffs: [projectRecord], ticks,
    notices: { 'handoff-alpha@boss': Date.parse('2026-09-27T12:00:00.000Z') } });
  assert.equal(canonical.calls.some(({ args }) => args[0] === 'agent' && args[1] === 'prompt' && args[2] === 'w-boss:p2'), false);

  const legacy = runNoticeScenario(t, { handoffs: [projectRecord], ticks,
    notices: { 'handoff-alpha@w-boss:p1': Date.parse('2026-09-27T12:00:00.000Z') } });
  assert.equal(legacy.calls.some(({ args }) => args[0] === 'agent' && args[1] === 'prompt' && args[2] === 'w-boss:p2'), false);
  assert.equal(legacy.notices['handoff-alpha@boss'], Date.parse('2026-09-27T12:00:00.000Z'));
});

test('project handover notifies its workspace workers and the Boss in another workspace once', { timeout: 30000 }, (t) => {
  const result = runNoticeScenario(t, {
    handoffs: [projectRecord],
    ticks: [
      { at: '2026-09-27T12:01:00.000Z', herdr: herdrSnapshot(projectPanes) },
      { at: '2026-09-27T12:03:00.000Z', herdr: herdrSnapshot(projectPanes) },
    ],
  });
  const prompts = result.calls.filter(({ args }) => args[0] === 'agent' && args[1] === 'prompt');
  assert.deepEqual(prompts.map(({ args }) => args[2]).sort(), ['w-alpha:p3', 'w-alpha:p4', 'w-boss:p1']);
  assert.ok(prompts.every(({ tick }) => tick === '2026-09-27T12:01:00.000Z'));
  const text = Object.fromEntries(prompts.map(({ args }) => [args[2], args[3]]));
  assert.match(text['w-alpha:p3'], /new orchestrator in pane w-alpha:p2/);
  assert.match(text['w-alpha:p3'], /WORKER REPORT and WORKER QUESTION messages to w-alpha:p2, not to w-alpha:p1/);
  assert.match(text['w-boss:p1'], /Alpha has a new orchestrator in pane w-alpha:p2/);
  assert.match(text['w-boss:p1'], /orch previous/);
  assert.equal(result.calls.some(({ args }) => args[0] === 'notification'), false);
  assert.deepEqual(Object.keys(result.notices).sort(), ['handoff-alpha@boss', 'handoff-alpha@w-alpha:p3', 'handoff-alpha@w-alpha:p4']);
  // The H26 B2 goal and source context stay in the record.
  assert.equal(result.records[0].ownerGoal, 'Ship the release safely.');
  assert.equal(result.records[0].sourceContext, 'Earlier safe context');
});

test('Boss handover notifies its workspace peers and the Owner, not project orchestrators', { timeout: 30000 }, (t) => {
  const record = {
    id: 'handoff-boss', project: 'Boss', displayLabel: 'Boss', workspace: 'w-boss', label: 'boss', boss: true,
    sourcePane: 'w-boss:p1', newPane: 'w-boss:p2', fromKind: 'claude', toKind: 'codex', status: 'active',
    activatedAt: '2026-09-27T12:00:00.000Z', peerPanes: ['w-boss:p3'],
  };
  const panes = [
    pane('w-boss:p1', 'w-boss', { label: 'boss previous', agent: 'claude' }),
    pane('w-boss:p2', 'w-boss', { label: 'boss' }),
    pane('w-boss:p3', 'w-boss'),
    pane('w-alpha:p1', 'w-alpha', { label: 'orch', agent: 'claude' }),
  ];
  const result = runNoticeScenario(t, {
    handoffs: [record],
    ticks: [
      { at: '2026-09-27T12:01:00.000Z', herdr: herdrSnapshot(panes) },
      { at: '2026-09-27T12:03:00.000Z', herdr: herdrSnapshot(panes) },
    ],
  });
  const prompts = result.calls.filter(({ args }) => args[0] === 'agent' && args[1] === 'prompt');
  assert.deepEqual(prompts.map(({ args }) => args[2]), ['w-boss:p3']);
  assert.match(prompts[0].args[3], /Herdr Boss is now pane w-boss:p2/);
  const owner = result.calls.filter(({ args }) => args[0] === 'notification');
  assert.equal(owner.length, 1);
  assert.deepEqual(owner[0].args.slice(0, 2), ['notification', 'show']);
  assert.match(owner[0].args[2], /Boss handover/);
  assert.match(owner[0].args[owner[0].args.indexOf('--body') + 1], /The Boss is now pane w-boss:p2/);
  assert.deepEqual(Object.keys(result.notices).sort(), ['handoff-boss@owner', 'handoff-boss@w-boss:p3']);
});

test('handover notices retry an unavailable or failed recipient and never repeat a delivered one', { timeout: 30000 }, (t) => {
  const busyBoss = projectPanes.map((p) => (p.id === 'w-boss:p1' ? { ...p, status: 'working' } : p));
  const withoutWorker = projectPanes.filter((p) => p.id !== 'w-alpha:p4');
  const result = runNoticeScenario(t, {
    handoffs: [{ ...projectRecord, previousPromptError: 'Pane not found.' }],
    ticks: [
      // The Boss is working, p4 is absent, and the prompt to p3 fails.
      { at: '2026-09-27T12:01:00.000Z', herdr: herdrSnapshot(withoutWorker.map((p) => (p.id === 'w-boss:p1' ? { ...p, status: 'working' } : p))), fail: ['w-alpha:p3'] },
      // Inside the one-minute retry wait, p3 is not tried again.
      { at: '2026-09-27T12:01:30.000Z', herdr: herdrSnapshot(busyBoss) },
      { at: '2026-09-27T12:03:00.000Z', herdr: herdrSnapshot(projectPanes) },
      { at: '2026-09-27T12:05:00.000Z', herdr: herdrSnapshot(projectPanes) },
    ],
  });
  const prompts = result.calls.filter(({ args }) => args[0] === 'agent' && args[1] === 'prompt');
  const byPane = (id) => prompts.filter(({ args }) => args[2] === id).map(({ tick }) => tick);
  assert.deepEqual(byPane('w-alpha:p3'), ['2026-09-27T12:01:00.000Z', '2026-09-27T12:03:00.000Z']);
  assert.deepEqual(byPane('w-alpha:p4'), ['2026-09-27T12:01:30.000Z']);
  assert.deepEqual(byPane('w-boss:p1'), ['2026-09-27T12:03:00.000Z']);
  // The previous-agent prompt failed at activation, so the engine delivers it once.
  assert.deepEqual(byPane('w-alpha:p1'), ['2026-09-27T12:01:00.000Z']);
  assert.match(prompts.find(({ args }) => args[2] === 'w-alpha:p1').args[3], /no longer own orchestration of alpha/);
  assert.deepEqual(Object.keys(result.notices).sort(), ['handoff-alpha@boss', 'handoff-alpha@w-alpha:p1', 'handoff-alpha@w-alpha:p3', 'handoff-alpha@w-alpha:p4']);
});

test('an error envelope with exit status 0 is a failed notice that stays eligible for retry', { timeout: 30000 }, (t) => {
  const project = runNoticeScenario(t, {
    handoffs: [projectRecord],
    ticks: [
      { at: '2026-09-27T12:01:00.000Z', herdr: herdrSnapshot(projectPanes), errorEnvelope: ['w-alpha:p3', 'w-boss:p1'] },
      { at: '2026-09-27T12:03:00.000Z', herdr: herdrSnapshot(projectPanes) },
      { at: '2026-09-27T12:05:00.000Z', herdr: herdrSnapshot(projectPanes) },
    ],
  });
  const prompts = project.calls.filter(({ args }) => args[0] === 'agent' && args[1] === 'prompt');
  const byPane = (id) => prompts.filter(({ args }) => args[2] === id).map(({ tick }) => tick);
  assert.deepEqual(byPane('w-alpha:p3'), ['2026-09-27T12:01:00.000Z', '2026-09-27T12:03:00.000Z']);
  assert.deepEqual(byPane('w-boss:p1'), ['2026-09-27T12:01:00.000Z', '2026-09-27T12:03:00.000Z']);
  assert.deepEqual(byPane('w-alpha:p4'), ['2026-09-27T12:01:00.000Z']);
  assert.equal(project.notices['handoff-alpha@w-alpha:p3'], Date.parse('2026-09-27T12:03:00.000Z'));
  assert.equal(project.notices['handoff-alpha@boss'], Date.parse('2026-09-27T12:03:00.000Z'));
  assert.equal(project.notices['handoff-alpha@w-alpha:p4'], Date.parse('2026-09-27T12:01:00.000Z'));

  const record = {
    id: 'handoff-boss', project: 'Boss', displayLabel: 'Boss', workspace: 'w-boss', label: 'boss', boss: true,
    sourcePane: 'w-boss:p1', newPane: 'w-boss:p2', fromKind: 'claude', toKind: 'codex', status: 'active',
    activatedAt: '2026-09-27T12:00:00.000Z', peerPanes: [],
  };
  const panes = [pane('w-boss:p1', 'w-boss', { label: 'boss previous', agent: 'claude' }), pane('w-boss:p2', 'w-boss', { label: 'boss' })];
  const boss = runNoticeScenario(t, {
    handoffs: [record],
    ticks: [
      { at: '2026-09-27T12:01:00.000Z', herdr: herdrSnapshot(panes), errorEnvelope: ['owner'] },
      { at: '2026-09-27T12:01:30.000Z', herdr: herdrSnapshot(panes) },
      { at: '2026-09-27T12:03:00.000Z', herdr: herdrSnapshot(panes) },
      { at: '2026-09-27T12:05:00.000Z', herdr: herdrSnapshot(panes) },
    ],
  });
  const owner = boss.calls.filter(({ args }) => args[0] === 'notification').map(({ tick }) => tick);
  assert.deepEqual(owner, ['2026-09-27T12:01:00.000Z', '2026-09-27T12:03:00.000Z']);
  assert.deepEqual(boss.notices, { 'handoff-boss@owner': Date.parse('2026-09-27T12:03:00.000Z') });
});

test('a successive handover sends no worker notice to earlier previous-role panes', { timeout: 30000 }, (t) => {
  // The second handover moved orch from p2 to p5. p1 is the first handover's orch previous pane.
  const panes = [
    pane('w-alpha:p1', 'w-alpha', { label: 'orch previous', agent: 'claude' }),
    pane('w-alpha:p2', 'w-alpha', { label: 'orch previous' }),
    pane('w-alpha:p3', 'w-alpha'),
    pane('w-alpha:p5', 'w-alpha', { label: 'orch', agent: 'pi' }),
    pane('w-other:p1', 'w-other', { label: 'boss previous', agent: 'claude' }),
    pane('w-boss:p1', 'w-boss', { label: 'boss', agent: 'claude' }),
  ];
  const second = { ...projectRecord, id: 'handoff-alpha-2', sourcePane: 'w-alpha:p2', newPane: 'w-alpha:p5', toKind: 'pi' };
  const result = runNoticeScenario(t, {
    handoffs: [
      { ...second, peerPanes: null },
      // An older record may still list a pane that is now a previous-role pane.
      { ...second, id: 'handoff-alpha-legacy', peerPanes: ['w-alpha:p1', 'w-alpha:p3'] },
    ],
    ticks: [{ at: '2026-09-27T12:01:00.000Z', herdr: herdrSnapshot(panes) }],
  });
  const prompts = result.calls.filter(({ args }) => args[0] === 'agent' && args[1] === 'prompt').map(({ args }) => args[2]);
  assert.equal(prompts.includes('w-alpha:p1'), false);
  assert.equal(prompts.includes('w-other:p1'), false);
  assert.deepEqual(prompts.filter((id) => id === 'w-alpha:p3').length, 2);
  assert.deepEqual(Object.keys(result.notices).sort(), [
    'handoff-alpha-2@boss', 'handoff-alpha-2@w-alpha:p3', 'handoff-alpha-legacy@boss', 'handoff-alpha-legacy@w-alpha:p3',
  ]);
});

test('an exit-zero plain, empty, or result-free success is recorded once', { timeout: 30000 }, (t) => {
  const record = {
    id: 'handoff-boss', project: 'Boss', displayLabel: 'Boss', workspace: 'w-boss', label: 'boss', boss: true,
    sourcePane: 'w-boss:p1', newPane: 'w-boss:p2', fromKind: 'claude', toKind: 'codex', status: 'active',
    activatedAt: '2026-09-27T12:00:00.000Z', peerPanes: ['w-boss:p3', 'w-boss:p4'],
  };
  const panes = [
    pane('w-boss:p1', 'w-boss', { label: 'boss previous', agent: 'claude' }),
    pane('w-boss:p2', 'w-boss', { label: 'boss' }),
    pane('w-boss:p3', 'w-boss'),
    pane('w-boss:p4', 'w-boss', { agent: 'pi' }),
  ];
  const stdout = { owner: '', 'w-boss:p3': 'Notification sent.\n', 'w-boss:p4': '{"id":"cli:agent:prompt"}\n' };
  const result = runNoticeScenario(t, {
    handoffs: [record],
    ticks: [
      { at: '2026-09-27T12:01:00.000Z', herdr: herdrSnapshot(panes), stdout },
      { at: '2026-09-27T12:03:00.000Z', herdr: herdrSnapshot(panes), stdout },
    ],
  });
  const sent = result.calls.map(({ tick, args }) => [tick, args[0] === 'notification' ? 'owner' : args[2]]);
  assert.deepEqual(sent.sort(), [
    ['2026-09-27T12:01:00.000Z', 'owner'], ['2026-09-27T12:01:00.000Z', 'w-boss:p3'], ['2026-09-27T12:01:00.000Z', 'w-boss:p4'],
  ]);
  const at = Date.parse('2026-09-27T12:01:00.000Z');
  assert.deepEqual(result.notices, { 'handoff-boss@owner': at, 'handoff-boss@w-boss:p3': at, 'handoff-boss@w-boss:p4': at });
});
