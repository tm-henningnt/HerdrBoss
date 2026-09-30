import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { POLICY_DEFAULTS, validatePolicy } from '../src/control.js';
import { loadModels } from '../src/kit/config.js';
import { claudeContextUsage, normalizeModelId } from '../src/context-handover.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Each step sets the pane list and the published files for one tick.
const probe = `
import fs from 'node:fs';
import path from 'node:path';
import { Engine } from './src/engine.js';
import { loadConfig } from './src/config.js';
const input = JSON.parse(process.env.E1_SCENARIO);
let now = Date.parse('2026-09-29T12:00:00.000Z');
Date.now = () => now;
const calls = [];
const herdrCalls = [];
const cfg = loadConfig();
cfg.push = false;
cfg.quotaSeconds = 300;
cfg.tickSeconds = 30;
cfg.browsers.reapOrphanDaemons = false;
let herdr = input.steps[0].herdr;
const engine = new Engine(cfg, {
  push: false,
  act: true,
  collectors: {
    collectHerdr: async () => herdr,
    collectMachine: async () => null,
    collectProcesses: async () => new Map(),
    collectQuotas: async () => [],
    collectWorktreeCounts: async () => ({}),
    collectCwdProcesses: async () => [],
    collectMissingWorktreeProcesses: async () => [],
    readWorkerScreen: async () => '',
    collectPiModels: async () => null,
  },
  herdrRunner: async (command, args) => {
    herdrCalls.push({ step: calls.step, args });
    // A concurrent CLI write between the read and the write of the engine.
    if (input.mutateOnClose && args[1] === 'close') {
      const file = path.join(process.env.HERDR_BOSS_DIR, 'handoffs.json');
      const records = JSON.parse(fs.readFileSync(file, 'utf8'));
      records[0].concurrent = true;
      records.push({ id: 'late', status: 'prepared', sourcePane: 'x', newPane: 'y' });
      fs.writeFileSync(file, JSON.stringify(records));
    }
    return '{}';
  },
  handoffRunner: async (command, args) => {
    calls.push({ step: calls.step, args });
    if (args[2] === 'prepare') return JSON.stringify({ id: 'fake-handoff', newPane: 'fake-successor' });
    return JSON.stringify({ ok: true });
  },
});
engine.deliver = async () => {};
for (const [index, step] of input.steps.entries()) {
  now = Date.parse(step.at);
  herdr = step.herdr;
  calls.step = index;
  for (const [slug, body] of Object.entries(step.published || {})) {
    fs.writeFileSync(path.join(process.env.HERDR_BOSS_DIR, 'projects', slug + '.json'), JSON.stringify(body));
  }
  await engine.tick();
}
console.log(JSON.stringify({ calls, herdrCalls, events: engine.events, memory: engine.memory, handoverWaits: engine.state?.handoverWaits }));
`;

function transcript(home, cwd, sessionId, lines) {
  const dir = path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${lines.map((x) => JSON.stringify(x)).join('\n')}\n`);
}

const assistant = (usage, model = 'claude-sonnet-5-5', extra = {}) => ({ type: 'assistant', message: { model, usage }, ...extra });

function run(t, scenario) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-e1-context-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  const policy = structuredClone(POLICY_DEFAULTS);
  policy.autoHandover = scenario.autoHandover ?? true;
  Object.assign(policy, scenario.policy || {});
  fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(policy));
  fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify({ paneSince: {}, pushes: {}, notified: {}, ...(scenario.memory || {}) }));
  fs.writeFileSync(path.join(dir, 'handoffs.json'), JSON.stringify(scenario.handoffs || []));
  if (scenario.tokens !== undefined) {
    transcript(dir, '/work/alpha', 'sess-1', [
      { type: 'user', message: { content: 'hello' } },
      assistant({ input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 5, output_tokens: 9 }),
      assistant({ input_tokens: 20, cache_read_input_tokens: scenario.tokens - 30, cache_creation_input_tokens: 10, output_tokens: 300 }, scenario.model),
    ]);
  }
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env, HOME: dir, HERDR_BOSS_DIR: dir, HERDR_BOSS_LIVE_DIR: dir, HERDR_BOSS_ALLOW_ACTIONS: '1',
      NODE_TEST_CONTEXT: '', E1_SCENARIO: JSON.stringify({ steps: scenario.steps, mutateOnClose: scenario.mutateOnClose }),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout.trim());
  out.records = JSON.parse(fs.readFileSync(path.join(dir, 'handoffs.json'), 'utf8'));
  return out;
}

const pane = (status, extra = {}) => ({ id: 'w-alpha:p1', workspace: 'w-alpha', label: 'orch', orch: true, agent: 'claude', status, sessionId: 'sess-1', cwd: '/work/alpha', ...extra });
const worker = { id: 'w-alpha:p3', workspace: 'w-alpha', label: 'worker', orch: false, agent: 'codex', status: 'working' };
const herdrOf = (...panes) => ({ workspaces: [{ id: 'w-alpha', label: 'Alpha' }], panes });
const status = (done, extra = {}) => ({
  project: 'Alpha', updated: `2026-09-29T12:0${done}:00.000Z`, ...extra,
  tasks: [{ id: 'T1', title: 'One', status: done >= 1 ? 'done' : 'doing' }, { id: 'T2', title: 'Two', status: 'todo' }],
});
const at = (minute) => `2026-09-29T12:${String(minute).padStart(2, '0')}:00.000Z`;
const prepares = (out) => out.calls.filter(({ args }) => args[1] === 'handoff' && args[2] === 'prepare');
const activates = (out) => out.calls.filter(({ args }) => args[1] === 'handoff' && args[2] === 'activate');

// A boundary: T1 goes to done in the published status while the pane is idle.
const boundary = (extra = {}) => [
  { at: at(0), herdr: herdrOf(pane('working'), worker), published: { alpha: status(0) } },
  { at: at(1), herdr: herdrOf(pane('idle'), worker), published: { alpha: status(1) }, ...extra },
];

test('claudeContextUsage sums the input, cache read, and cache creation tokens of the last assistant message', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-e1-usage-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  transcript(home, '/work/alpha', 'sess-1', [
    assistant({ input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 }),
    assistant({ input_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 30, output_tokens: 7 }, 'claude-opus-5-5'),
    assistant({ input_tokens: 5000 }, 'claude-sonnet-5-5', { isSidechain: true }),
  ]);
  fs.appendFileSync(path.join(home, '.claude', 'projects', '-work-alpha', 'sess-1.jsonl'), '{"type":"assistant","message":\n');
  assert.deepEqual(claudeContextUsage({ sessionId: 'sess-1', cwd: '/work/alpha', home }), { available: true, tokens: 2130, model: 'claude-opus-5-5' });
  // The reader finds the transcript in another project folder when the cwd differs.
  assert.equal(claudeContextUsage({ sessionId: 'sess-1', cwd: '/elsewhere', home }).tokens, 2130);
});

test('claudeContextUsage reports unavailable when the data is missing', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-e1-usage-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.equal(claudeContextUsage({ sessionId: 'nope', cwd: '/work/alpha', home }).available, false);
  assert.equal(claudeContextUsage({ sessionId: null, cwd: '/work/alpha', home }).available, false);
  transcript(home, '/work/alpha', 'empty', [{ type: 'user', message: { content: 'x' } }]);
  assert.equal(claudeContextUsage({ sessionId: 'empty', cwd: '/work/alpha', home }).available, false);
});

test('policy validates autoHandoverContextTokens', () => {
  assert.equal(POLICY_DEFAULTS.autoHandoverContextTokens, 300000);
  const models = loadModels();
  assert.deepEqual(validatePolicy({ ...structuredClone(POLICY_DEFAULTS), autoHandoverContextTokens: 250000 }, models), []);
  for (const bad of [0, 999, 3000000, 1.5, '300000', null]) {
    assert.match(validatePolicy({ ...structuredClone(POLICY_DEFAULTS), autoHandoverContextTokens: bad }, models).join(' '), /autoHandoverContextTokens/, String(bad));
  }
});

test('a done task with the context above the threshold prepares a fresh successor with the source model', { timeout: 30000 }, (t) => {
  const out = run(t, { tokens: 350000, model: 'claude-sonnet-5-5', steps: boundary() });
  const calls = prepares(out);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(3), ['w-alpha:p1', '--to', 'claude', '--model', 'claude-sonnet-5-5', '--mode', 'fresh', '--auto']);
  assert.equal(calls[0].step, 1);
  assert.equal(out.memory.contextHandovers['fake-handoff'].pane, 'w-alpha:p1');
});

test('the context threshold is a policy value', { timeout: 30000 }, (t) => {
  const below = run(t, { tokens: 350000, policy: { autoHandoverContextTokens: 400000 }, steps: boundary() });
  assert.deepEqual(prepares(below), []);
  const above = run(t, { tokens: 350000, policy: { autoHandoverContextTokens: 340000 }, steps: boundary() });
  assert.equal(prepares(above).length, 1);
});

test('a pane that goes from working to idle after a new publish is a boundary', { timeout: 30000 }, (t) => {
  const out = run(t, {
    tokens: 400000,
    steps: [
      { at: at(0), herdr: herdrOf(pane('working'), worker), published: { alpha: status(0) } },
      { at: at(1), herdr: herdrOf(pane('idle'), worker), published: { alpha: status(0, { updated: '2026-09-29T12:01:00.000Z' }) } },
    ],
  });
  assert.equal(prepares(out).length, 1);
});

test('a pane that goes idle with no new publish is not a boundary', { timeout: 30000 }, (t) => {
  const out = run(t, {
    tokens: 400000,
    steps: [
      { at: at(0), herdr: herdrOf(pane('working'), worker), published: { alpha: status(0) } },
      { at: at(1), herdr: herdrOf(pane('idle'), worker) },
      { at: at(2), herdr: herdrOf(pane('idle'), worker) },
    ],
  });
  assert.deepEqual(prepares(out), []);
});

test('a boundary waits while the orchestrator pane works', { timeout: 30000 }, (t) => {
  const out = run(t, {
    tokens: 400000,
    steps: [
      { at: at(0), herdr: herdrOf(pane('working'), worker), published: { alpha: status(0) } },
      { at: at(1), herdr: herdrOf(pane('working'), worker), published: { alpha: status(1) } },
      { at: at(2), herdr: herdrOf(pane('idle'), worker) },
    ],
  });
  const calls = prepares(out);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].step, 2);
});

test('one boundary prepares one successor', { timeout: 30000 }, (t) => {
  const out = run(t, { tokens: 400000, steps: [...boundary(), { at: at(2), herdr: herdrOf(pane('idle'), worker) }, { at: at(3), herdr: herdrOf(pane('idle'), worker) }] });
  assert.equal(prepares(out).length, 1);
});

test('context handover is off when automatic handover is off', { timeout: 30000 }, (t) => {
  assert.deepEqual(prepares(run(t, { tokens: 400000, autoHandover: false, steps: boundary() })), []);
});

test('context handover skips held, inactive, and Boss orchestrators', { timeout: 30000 }, (t) => {
  const held = run(t, {
    tokens: 400000,
    steps: [
      { at: at(0), herdr: herdrOf(pane('working'), worker), published: { alpha: status(0, { status: 'paused' }) } },
      { at: at(1), herdr: herdrOf(pane('idle'), worker), published: { alpha: status(1, { status: 'paused' }) } },
    ],
  });
  assert.deepEqual(prepares(held), [], 'held');
  const inactive = run(t, {
    tokens: 400000,
    steps: [
      { at: at(0), herdr: herdrOf(pane('working')), published: { alpha: status(0) } },
      { at: at(1), herdr: herdrOf(pane('idle')), published: { alpha: status(1) } },
    ],
  });
  assert.deepEqual(prepares(inactive), [], 'inactive');
  const bossPane = { id: 'w-boss:p1', workspace: 'w-boss', label: 'boss', orch: true, agent: 'claude', status: 'idle', sessionId: 'sess-1', cwd: '/work/alpha' };
  const boss = run(t, {
    tokens: 400000,
    steps: [
      { at: at(0), herdr: { workspaces: [{ id: 'w-boss', label: 'Boss' }], panes: [{ ...bossPane, status: 'working' }, { ...worker, workspace: 'w-boss' }] }, published: { boss: status(0) } },
      { at: at(1), herdr: { workspaces: [{ id: 'w-boss', label: 'Boss' }], panes: [bossPane, { ...worker, workspace: 'w-boss' }] }, published: { boss: status(1) } },
    ],
  });
  assert.deepEqual(prepares(boss), [], 'boss');
});

test('context handover skips an orchestrator whose model tier is unranked', { timeout: 30000 }, (t) => {
  const unranked = { id: 'w-alpha:p1', model: 'claude-unranked-9' };
  const steps = [
    { at: at(0), herdr: herdrOf(pane('working', unranked), worker), published: { alpha: status(0) } },
    { at: at(1), herdr: herdrOf(pane('idle', unranked), worker), published: { alpha: status(1) } },
  ];
  assert.deepEqual(prepares(run(t, { tokens: 400000, model: 'claude-unranked-9', steps })), []);
});

test('context handover skips a harness without context data', { timeout: 30000 }, (t) => {
  const out = run(t, {
    steps: [
      { at: at(0), herdr: herdrOf(pane('working', { agent: 'codex' }), worker), published: { alpha: status(0) } },
      { at: at(1), herdr: herdrOf(pane('idle', { agent: 'codex' }), worker), published: { alpha: status(1) } },
    ],
  });
  assert.deepEqual(prepares(out), []);
  assert.ok(out.events.some((e) => /context/i.test(e.text || e.message || '') && /unavailable/i.test(e.text || e.message || '')));
});

test('an existing open record for the pane blocks a second preparation', { timeout: 30000 }, (t) => {
  const out = run(t, {
    tokens: 400000,
    handoffs: [{ id: 'open', project: 'alpha', workspace: 'w-alpha', label: 'orch', sourcePane: 'w-alpha:p1', newPane: 'w-alpha:p9', fromKind: 'claude', toKind: 'claude', model: 'claude-sonnet-5-5', status: 'preparing', automatic: true }],
    steps: [
      { at: at(0), herdr: herdrOf(pane('working'), worker, { id: 'w-alpha:p9', workspace: 'w-alpha', label: null, orch: false, agent: 'claude', status: 'idle' }), published: { alpha: status(0) } },
      { at: at(1), herdr: herdrOf(pane('idle'), worker, { id: 'w-alpha:p9', workspace: 'w-alpha', label: null, orch: false, agent: 'claude', status: 'idle' }), published: { alpha: status(1) } },
    ],
  });
  assert.deepEqual(prepares(out), []);
});

const readyRecord = (extra = {}) => ({
  id: 'ctx-1', project: 'alpha', workspace: 'w-alpha', label: 'orch', sourcePane: 'w-alpha:p1', newPane: 'w-alpha:p9',
  fromKind: 'claude', toKind: 'claude', model: 'claude-sonnet-5-5', status: 'prepared', automatic: true,
  readyAt: '2026-09-29T11:59:00.000Z', preparedAt: '2026-09-29T11:58:00.000Z', ...extra,
});
const successor = { id: 'w-alpha:p9', workspace: 'w-alpha', label: null, orch: false, agent: 'claude', status: 'idle' };

test('a ready context successor activates when the source pane is idle', { timeout: 30000 }, (t) => {
  const out = run(t, {
    tokens: 400000, memory: { contextHandovers: { 'ctx-1': { pane: 'w-alpha:p1', at: 1 } } }, handoffs: [readyRecord()],
    steps: [{ at: at(1), herdr: herdrOf(pane('idle'), worker, successor), published: { alpha: status(1) } }],
  });
  assert.equal(activates(out).length, 1);
  assert.deepEqual(activates(out)[0].args.slice(3), ['ctx-1', '--confirmed']);
});

test('a ready context successor waits while the source pane works', { timeout: 30000 }, (t) => {
  const out = run(t, {
    tokens: 400000, memory: { contextHandovers: { 'ctx-1': { pane: 'w-alpha:p1', at: 1 } } }, handoffs: [readyRecord()],
    steps: [{ at: at(1), herdr: herdrOf(pane('working'), worker, successor), published: { alpha: status(1) } }],
  });
  assert.deepEqual(activates(out), []);
});

test('a ready context successor is not activated for a held project or a weaker model', { timeout: 30000 }, (t) => {
  const memory = { contextHandovers: { 'ctx-1': { pane: 'w-alpha:p1', at: 1 } } };
  const held = run(t, { tokens: 400000, memory, handoffs: [readyRecord()], steps: [{ at: at(1), herdr: herdrOf(pane('idle'), worker, successor), published: { alpha: status(1, { status: 'paused' }) } }] });
  assert.deepEqual(activates(held), [], 'held');
  const weaker = run(t, { tokens: 400000, model: 'claude-opus-5-5', memory, handoffs: [readyRecord()], steps: [{ at: at(1), herdr: herdrOf(pane('idle'), worker, successor), published: { alpha: status(1) } }] });
  assert.deepEqual(activates(weaker), [], 'weaker');
});

// The source orchestrator finished its turn and waits at a gate for hours while a worker runs.
const gateSteps = (sourceStatus, published = status(1)) => [
  { at: at(1), herdr: herdrOf(pane(sourceStatus), worker, successor), published: { alpha: published } },
  { at: '2026-09-29T15:30:00.000Z', herdr: herdrOf(pane(sourceStatus), worker, successor), published: { alpha: published } },
];
const oldRecord = () => readyRecord({ preparedAt: '2026-09-29T11:00:00.000Z' });

test('a ready context successor activates when the source pane is done and waits at a gate', { timeout: 30000 }, (t) => {
  const out = run(t, {
    tokens: 400000, memory: { contextHandovers: { 'ctx-1': { pane: 'w-alpha:p1', at: 1 } } }, handoffs: [oldRecord()],
    steps: gateSteps('done', status(1, { summary: 'Waiting on the Owner for a decision.', tasks: [{ id: 'T2', title: 'Two', status: 'blocked', waitingOn: 'owner', ask: 'Approve the plan' }] })),
  });
  assert.equal(activates(out)[0]?.step, 0);
});

test('a context successor does not expire after two hours while the source waits', { timeout: 30000 }, (t) => {
  const out = run(t, {
    tokens: 400000, memory: { contextHandovers: { 'ctx-1': { pane: 'w-alpha:p1', at: 1 } } },
    handoffs: [oldRecord()],
    steps: [{ at: '2026-09-29T15:30:00.000Z', herdr: herdrOf(pane('working'), worker, successor), published: { alpha: status(1) } }],
  });
  assert.equal(out.records[0].status, 'prepared');
});

test('a tracked context successor expires after 24 hours, an untracked one after 2 hours', { timeout: 30000 }, (t) => {
  const memory = { contextHandovers: { 'ctx-1': { pane: 'w-alpha:p1', at: 1 } } };
  const stepAt = (time) => [{ at: time, herdr: herdrOf(pane('working'), worker, successor), published: { alpha: status(1) } }];
  assert.equal(run(t, { tokens: 400000, memory, handoffs: [oldRecord()], steps: stepAt('2026-09-30T10:00:00.000Z') }).records[0].status, 'prepared', '23 hours');
  assert.equal(run(t, { tokens: 400000, memory, handoffs: [oldRecord()], steps: stepAt('2026-09-30T12:00:00.000Z') }).records[0].status, 'expired', '25 hours');
  assert.equal(run(t, { tokens: 400000, handoffs: [oldRecord()], steps: stepAt('2026-09-29T15:30:00.000Z') }).records[0].status, 'expired', 'lost memory');
});

test('the Boss pane and a stood-down project never activate and show the reason', { timeout: 30000 }, (t) => {
  const memory = { contextHandovers: { 'ctx-1': { pane: 'w-alpha:p1', at: 1 } } };
  const stood = run(t, { tokens: 400000, memory, handoffs: [readyRecord()], steps: [{ at: at(1), herdr: herdrOf(pane('idle'), worker, successor), published: { alpha: status(1, { status: 'stood down' }) } }] });
  assert.deepEqual(activates(stood), []);
  assert.equal(stood.handoverWaits['ctx-1'], 'the project is held');
  const bossPane = pane('idle', { id: 'w-boss:p1', workspace: 'w-boss', label: 'boss' });
  const bossSuccessor = { ...successor, id: 'w-boss:p9', workspace: 'w-boss' };
  const boss = run(t, { tokens: 400000, memory, handoffs: [readyRecord({ project: 'boss', workspace: 'w-boss', label: 'boss', sourcePane: 'w-boss:p1', newPane: 'w-boss:p9', boss: true })],
    steps: [{ at: at(1), herdr: { workspaces: [{ id: 'w-boss', label: 'Boss' }], panes: [bossPane, { ...worker, workspace: 'w-boss' }, bossSuccessor] }, published: { boss: status(1) } }] });
  assert.deepEqual(activates(boss), []);
  assert.equal(boss.handoverWaits['ctx-1'], 'the Boss pane is never handed over');
});

test('the engine state names why a prepared successor waits', { timeout: 30000 }, (t) => {
  const memory = { contextHandovers: { 'ctx-1': { pane: 'w-alpha:p1', at: 1 } } };
  const step = (herdr, published = status(1)) => [{ at: at(1), herdr, published: { alpha: published } }];
  const reason = (steps, extra = {}) => run(t, { tokens: 400000, memory, handoffs: [readyRecord()], steps, ...extra }).handoverWaits?.['ctx-1'];
  assert.equal(reason(step(herdrOf(pane('working'), worker, successor))), 'the source orchestrator works');
  assert.equal(reason(step(herdrOf(pane('idle'), worker, { ...successor, status: 'working' }))), 'the successor works');
  assert.equal(reason(step(herdrOf(pane('idle'), worker, successor), status(1, { status: 'paused' }))), 'the project is held');
  assert.equal(reason(step(herdrOf(pane('idle'), successor))), 'the project has no running worker');
  assert.equal(reason(step(herdrOf(pane('idle'), worker, successor)), { model: 'claude-opus-5-5' }), 'claude-sonnet-5-5 is weaker than the source model claude-opus-5-5');
  assert.equal(reason(step(herdrOf(pane('idle'), worker, successor))), undefined);
});

test('a prepared record that did not come from the context trigger is not activated by it', { timeout: 30000 }, (t) => {
  const out = run(t, {
    tokens: 400000, handoffs: [readyRecord()],
    steps: [{ at: at(1), herdr: herdrOf(pane('idle'), worker, successor), published: { alpha: status(1) } }],
  });
  assert.deepEqual(activates(out), []);
});

test('normalizeModelId strips a date suffix and a bracket suffix', () => {
  assert.equal(normalizeModelId('claude-sonnet-5-5'), 'claude-sonnet-5-5');
  assert.equal(normalizeModelId('claude-sonnet-5-5-20260101'), 'claude-sonnet-5-5');
  assert.equal(normalizeModelId('claude-opus-5-5[1m]'), 'claude-opus-5-5');
  assert.equal(normalizeModelId('claude-opus-5-5-20260101[1m]'), 'claude-opus-5-5');
  assert.equal(normalizeModelId(null), null);
});

test('a dated or suffixed transcript model id is normalized before the tier check and the prepare call', { timeout: 30000 }, (t) => {
  const out = run(t, { tokens: 400000, model: 'claude-sonnet-5-5-20260101[1m]', steps: boundary() });
  const calls = prepares(out);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[calls[0].args.indexOf('--model') + 1], 'claude-sonnet-5-5');
});

test('an unranked transcript model falls back to the pane model or the default model', { timeout: 30000 }, (t) => {
  const out = run(t, {
    tokens: 400000, model: 'claude-mystery-9',
    steps: [
      { at: at(0), herdr: herdrOf(pane('working', { model: 'claude-opus-5-5' }), worker), published: { alpha: status(0) } },
      { at: at(1), herdr: herdrOf(pane('idle', { model: 'claude-opus-5-5' }), worker), published: { alpha: status(1) } },
    ],
  });
  const calls = prepares(out);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[calls[0].args.indexOf('--model') + 1], 'claude-opus-5-5');
});

test('the prepare call carries no effort for a harness without effort levels', { timeout: 30000 }, (t) => {
  const out = run(t, {
    tokens: 400000,
    steps: [
      { at: at(0), herdr: herdrOf(pane('working', { effort: 'high' }), worker), published: { alpha: status(0) } },
      { at: at(1), herdr: herdrOf(pane('idle', { effort: 'high' }), worker), published: { alpha: status(1) } },
    ],
  });
  assert.equal(prepares(out)[0].args.includes('--effort'), false);
});

test('a first-seen pane is unarmed: no boundary without an earlier tick', { timeout: 30000 }, (t) => {
  const out = run(t, { tokens: 400000, steps: [{ at: at(1), herdr: herdrOf(pane('idle'), worker), published: { alpha: status(1) } }] });
  assert.deepEqual(prepares(out), []);
});

// ---- Finish the activation: close the old pane, rename the tab, clean up unused successors.
const idleWorker = { ...worker, status: 'idle' };
const activeRecord = (extra = {}) => ({
  id: 'act-1', project: 'alpha', workspace: 'w-alpha', label: 'orch', sourcePane: 'w-alpha:p1', newPane: 'w-alpha:p9', newTab: 'w-alpha:t9',
  fromKind: 'claude', toKind: 'claude', model: 'claude-sonnet-5-5', status: 'active', automatic: true,
  activatedAt: '2026-09-29T11:40:00.000Z', previousPromptAt: '2026-09-29T11:40:01.000Z',
  activation: { at: '2026-09-29T11:40:00.000Z', sourcePane: 'w-alpha:p1', successorPane: 'w-alpha:p9', sourceLabel: 'orch previous', successorLabel: 'orch' },
  finish: {},
  ...extra,
});
const oldPane = (status) => pane(status, { label: 'orch previous', orch: false });
const newPane = (status) => ({ id: 'w-alpha:p9', workspace: 'w-alpha', tab: 'w-alpha:t9', label: 'orch', orch: true, agent: 'claude', status, sessionId: 'sess-2', cwd: '/work/alpha' });
const bossPane = { id: 'w-boss:p1', workspace: 'w-boss', label: 'boss', orch: true, agent: 'claude', status: 'idle' };
const closes = (out) => out.herdrCalls.filter(({ args }) => args[0] === 'pane' && args[1] === 'close');
const renames = (out) => out.herdrCalls.filter(({ args }) => args[0] === 'tab' && args[1] === 'rename');
const bossNotes = (out) => out.herdrCalls.filter(({ args }) => args[0] === 'agent' && args[1] === 'prompt' && args[2] === 'w-boss:p1');

test('the old pane closes and the successor tab is renamed after the successor answers', { timeout: 30000 }, (t) => {
  const out = run(t, {
    handoffs: [activeRecord({ activatedAt: '2026-09-29T11:59:30.000Z' })],
    steps: [
      { at: at(1), herdr: herdrOf(oldPane('working'), newPane('working'), idleWorker) },
      { at: at(2), herdr: herdrOf(oldPane('idle'), newPane('idle'), idleWorker) },
      { at: at(3), herdr: herdrOf(oldPane('idle'), newPane('idle'), idleWorker) },
    ],
  });
  assert.equal(closes(out).length, 1);
  assert.deepEqual(closes(out)[0].args, ['pane', 'close', 'w-alpha:p1']);
  assert.equal(closes(out)[0].step, 2);
  assert.deepEqual(renames(out).map(({ args }) => args.slice(2)), [['w-alpha:t9', 'Orchestrator']]);
  assert.ok(out.records[0].finish.closedAt);
  assert.equal(out.records[0].finish.confirmedBy, 'answered');
});

test('the old pane closes after 15 minutes with the old pane idle when the successor never answered', { timeout: 30000 }, (t) => {
  const out = run(t, {
    handoffs: [activeRecord()],
    steps: [
      { at: at(0), herdr: herdrOf(oldPane('idle'), newPane('idle'), idleWorker) },
      { at: at(2), herdr: herdrOf(oldPane('idle'), newPane('idle'), idleWorker) },
    ],
  });
  assert.equal(closes(out).length, 1);
  assert.equal(out.records[0].finish.confirmedBy, 'timeout');
});

test('the old pane stays open before confirmation and shows the planned close time', { timeout: 30000 }, (t) => {
  const out = run(t, {
    handoffs: [activeRecord({ activatedAt: '2026-09-29T11:59:30.000Z' })],
    steps: [
      { at: at(0), herdr: herdrOf(oldPane('idle'), newPane('idle'), idleWorker) },
      { at: at(2), herdr: herdrOf(oldPane('idle'), newPane('idle'), idleWorker) },
    ],
  });
  assert.deepEqual(closes(out), []);
  assert.equal(out.records[0].finish.plannedAt, '2026-09-29T12:14:30.000Z');
});

test('the old pane never closes while it works, and the Boss gets one note after 60 minutes', { timeout: 30000 }, (t) => {
  const out = run(t, {
    handoffs: [activeRecord({ activatedAt: '2026-09-29T10:50:00.000Z' })],
    steps: [
      { at: at(0), herdr: { workspaces: [{ id: 'w-alpha', label: 'Alpha' }, { id: 'w-boss', label: 'Boss' }], panes: [oldPane('working'), newPane('idle'), idleWorker, bossPane] } },
      { at: at(2), herdr: { workspaces: [{ id: 'w-alpha', label: 'Alpha' }, { id: 'w-boss', label: 'Boss' }], panes: [oldPane('working'), newPane('idle'), idleWorker, bossPane] } },
    ],
  });
  assert.deepEqual(closes(out), []);
  assert.equal(bossNotes(out).length, 1);
  assert.match(bossNotes(out)[0].args[3], /w-alpha:p1/);
  assert.equal(bossNotes(out)[0].args[3].includes('\n'), false);
});

test('a blocked old pane is not closed', { timeout: 30000 }, (t) => {
  const out = run(t, {
    handoffs: [activeRecord()],
    steps: [{ at: at(0), herdr: herdrOf(oldPane('blocked'), newPane('idle'), idleWorker) }, { at: at(2), herdr: herdrOf(oldPane('blocked'), newPane('idle'), idleWorker) }],
  });
  assert.deepEqual(closes(out), []);
});

test('the tab of an expired successor that was never activated is closed once', { timeout: 30000 }, (t) => {
  const unused = { id: 'old-1', project: 'alpha', workspace: 'w-alpha', label: 'orch', sourcePane: 'w-alpha:p1', newPane: 'w-alpha:p8', newTab: 'w-alpha:t8', fromKind: 'claude', toKind: 'claude', status: 'expired', automatic: true, expiredAt: '2026-09-29T11:00:00.000Z', expiredReason: 'test' };
  const spare = { id: 'w-alpha:p8', workspace: 'w-alpha', tab: 'w-alpha:t8', label: null, orch: false, agent: 'claude', status: 'idle' };
  const out = run(t, {
    handoffs: [unused],
    steps: [{ at: at(0), herdr: herdrOf(pane('idle'), spare, idleWorker) }, { at: at(1), herdr: herdrOf(pane('idle'), spare, idleWorker) }],
  });
  const tabClose = out.herdrCalls.filter(({ args }) => args[0] === 'tab' && args[1] === 'close');
  assert.deepEqual(tabClose.map(({ args }) => args[2]), ['w-alpha:t8']);
  assert.ok(out.records[0].cleanedAt);
});

test('a role pane is never closed as an unused successor', { timeout: 30000 }, (t) => {
  const unused = { id: 'old-2', project: 'alpha', workspace: 'w-alpha', label: 'orch', sourcePane: 'w-alpha:p1', newPane: 'w-alpha:p9', newTab: 'w-alpha:t9', fromKind: 'claude', toKind: 'claude', status: 'expired', automatic: true, expiredAt: '2026-09-29T11:00:00.000Z' };
  const out = run(t, { handoffs: [unused], steps: [{ at: at(0), herdr: herdrOf(pane('idle'), newPane('idle'), idleWorker) }] });
  assert.deepEqual(out.herdrCalls.filter(({ args }) => args[1] === 'close'), []);
});

test('the tab rename uses the live pane tab, not a stale recorded tab', { timeout: 30000 }, (t) => {
  const out = run(t, {
    handoffs: [activeRecord({ newTab: 'w-alpha:stale', activatedAt: '2026-09-29T11:59:30.000Z' })],
    steps: [
      { at: at(1), herdr: herdrOf(oldPane('working'), newPane('working'), idleWorker) },
      { at: at(2), herdr: herdrOf(oldPane('idle'), newPane('idle'), idleWorker) },
      { at: at(3), herdr: herdrOf(oldPane('idle'), newPane('idle'), idleWorker) },
    ],
  });
  assert.deepEqual(renames(out).map(({ args }) => args.slice(2)), [['w-alpha:t9', 'Orchestrator']]);
});

test('the unused successor cleanup uses the live pane tab, not a stale recorded tab', { timeout: 30000 }, (t) => {
  const unused = { id: 'old-3', project: 'alpha', workspace: 'w-alpha', label: 'orch', sourcePane: 'w-alpha:p1', newPane: 'w-alpha:p8', newTab: 'w-alpha:t9', fromKind: 'claude', toKind: 'claude', status: 'expired', automatic: true, expiredAt: '2026-09-29T11:00:00.000Z' };
  const spare = { id: 'w-alpha:p8', workspace: 'w-alpha', tab: 'w-alpha:t8', label: null, orch: false, agent: 'claude', status: 'idle' };
  const out = run(t, { handoffs: [unused], steps: [{ at: at(0), herdr: herdrOf(pane('idle'), spare, idleWorker) }] });
  assert.deepEqual(out.herdrCalls.filter(({ args }) => args[1] === 'close').map(({ args }) => args), [['tab', 'close', 'w-alpha:t8']]);
});

test('the old pane closes while the project has a running worker', { timeout: 30000 }, (t) => {
  const out = run(t, {
    handoffs: [activeRecord()],
    steps: [{ at: at(0), herdr: herdrOf(oldPane('idle'), newPane('idle'), worker) }, { at: at(2), herdr: herdrOf(oldPane('idle'), newPane('idle'), worker) }],
  });
  assert.deepEqual(closes(out).map(({ args }) => args), [['pane', 'close', 'w-alpha:p1']]);
  assert.ok(out.records[0].finish.closedAt);
});

test('a Boss record gets no automatic close, rename, or cleanup', { timeout: 30000 }, (t) => {
  const bossActive = { ...activeRecord(), id: 'boss-act', boss: true, label: 'boss', project: 'Boss', workspace: 'w-boss', sourcePane: 'w-boss:p1', newPane: 'w-boss:p2' };
  const bossOld = { id: 'w-boss:p1', workspace: 'w-boss', tab: 'w-boss:t1', label: 'boss previous', orch: false, agent: 'claude', status: 'idle' };
  const bossNew = { id: 'w-boss:p2', workspace: 'w-boss', tab: 'w-boss:t2', label: 'boss', orch: true, agent: 'claude', status: 'idle' };
  const unused = { id: 'boss-old', boss: true, label: 'boss', project: 'Boss', workspace: 'w-boss', sourcePane: 'w-boss:p1', newPane: 'w-boss:p3', status: 'expired', expiredAt: '2026-09-29T11:00:00.000Z' };
  const spare = { id: 'w-boss:p3', workspace: 'w-boss', tab: 'w-boss:t3', label: null, orch: false, agent: 'claude', status: 'idle' };
  const h = { workspaces: [{ id: 'w-boss', label: 'Boss' }], panes: [bossOld, bossNew, spare] };
  const out = run(t, { handoffs: [bossActive, unused], steps: [{ at: at(0), herdr: h }, { at: at(2), herdr: h }] });
  assert.deepEqual(out.herdrCalls.filter(({ args }) => ['close', 'rename'].includes(args[1])), []);
});

test('a concurrent write to handoffs.json survives the finish step', { timeout: 30000 }, (t) => {
  const out = run(t, {
    mutateOnClose: true,
    handoffs: [activeRecord()],
    steps: [{ at: at(0), herdr: herdrOf(oldPane('idle'), newPane('idle'), idleWorker) }, { at: at(2), herdr: herdrOf(oldPane('idle'), newPane('idle'), idleWorker) }],
  });
  assert.equal(closes(out).length, 1);
  assert.equal(out.records[0].concurrent, true);
  assert.ok(out.records[0].finish.closedAt);
  assert.ok(out.records.some((x) => x.id === 'late'));
});

// ---- An old pane with status done has finished its turn. It counts as idle for the cleanup.
test('a done old pane closes and the tab is renamed', { timeout: 30000 }, (t) => {
  const out = run(t, {
    handoffs: [activeRecord({ activatedAt: '2026-09-29T11:59:30.000Z' })],
    steps: [
      { at: at(1), herdr: herdrOf(oldPane('working'), newPane('working'), idleWorker) },
      { at: at(2), herdr: herdrOf(oldPane('done'), newPane('done'), idleWorker) },
      { at: at(3), herdr: herdrOf(oldPane('done'), newPane('done'), idleWorker) },
    ],
  });
  assert.deepEqual(closes(out).map(({ args }) => args), [['pane', 'close', 'w-alpha:p1']]);
  assert.deepEqual(renames(out).map(({ args }) => args.slice(2)), [['w-alpha:t9', 'Orchestrator']]);
  assert.ok(out.herdrCalls.indexOf(renames(out)[0]) < out.herdrCalls.indexOf(closes(out)[0]), 'the rename does not wait for the close');
  assert.ok(out.records[0].finish.closedAt);
  assert.ok(out.records[0].finish.tabRenamedAt);
  assert.ok(out.records[0].finish.doneAt);
});

test('a done old pane closes after the 15-minute wait when the successor never answered', { timeout: 30000 }, (t) => {
  const out = run(t, {
    handoffs: [activeRecord()],
    steps: [
      { at: at(0), herdr: herdrOf(oldPane('done'), newPane('idle'), idleWorker) },
      { at: at(2), herdr: herdrOf(oldPane('done'), newPane('idle'), idleWorker) },
    ],
  });
  assert.equal(closes(out).length, 1);
  assert.equal(out.records[0].finish.confirmedBy, 'timeout');
  assert.equal(renames(out).length, 1);
});

test('a working or blocked old pane is not closed and the tab is not renamed', { timeout: 30000 }, (t) => {
  for (const status of ['working', 'blocked']) {
    const out = run(t, {
      handoffs: [activeRecord()],
      steps: [{ at: at(0), herdr: herdrOf(oldPane(status), newPane('idle'), idleWorker) }, { at: at(2), herdr: herdrOf(oldPane(status), newPane('idle'), idleWorker) }],
    });
    assert.deepEqual(closes(out), [], status);
    assert.deepEqual(renames(out), [], status);
  }
});

test('the tab is renamed when the old pane closed earlier and the tab still has the Next name', { timeout: 30000 }, (t) => {
  const out = run(t, {
    handoffs: [activeRecord()],
    steps: [{ at: at(0), herdr: herdrOf(newPane('idle'), idleWorker) }, { at: at(2), herdr: herdrOf(newPane('idle'), idleWorker) }],
  });
  assert.deepEqual(closes(out), []);
  assert.equal(renames(out).length, 1);
  assert.equal(out.records[0].finish.outcome, 'source-absent');
});

test('the 60-minute note names the reason when a done old pane stays open', { timeout: 30000 }, (t) => {
  const boss = { workspaces: [{ id: 'w-alpha', label: 'Alpha' }, { id: 'w-boss', label: 'Boss' }] };
  const scenario = (panes) => run(t, {
    handoffs: [activeRecord({ activatedAt: '2026-09-29T11:00:30.000Z' })],
    steps: [{ at: at(0), herdr: { ...boss, panes } }, { at: at(2), herdr: { ...boss, panes } }],
  });
  const running = scenario([oldPane('done'), newPane('idle'), worker, bossPane]);
  assert.equal(closes(running).length, 1);
  assert.deepEqual(bossNotes(running), []);
  const relabeled = scenario([{ ...oldPane('done'), label: 'orch old' }, newPane('idle'), idleWorker, bossPane]);
  assert.deepEqual(closes(relabeled), []);
  assert.match(bossNotes(relabeled)[0].args[3], /label is orch old, not orch previous/);
  const busy = scenario([oldPane('working'), newPane('idle'), idleWorker, bossPane]);
  assert.match(bossNotes(busy)[0].args[3], /the pane works/);
});

// ---- R2: a context successor that never runs `handoff ready` becomes ready by itself.
const unreadyRecord = (extra = {}) => {
  const { readyAt, ...rest } = readyRecord({ promptDelivery: 'sent', seenWorkingAt: '2026-09-29T11:59:00.000Z', ...extra });
  return rest;
};
const tracked = { contextHandovers: { 'ctx-1': { pane: 'w-alpha:p1', at: 1 } } };
const autoStep = (successorPane, minute = 1, sourceStatus = 'idle') => [{ at: at(minute), herdr: herdrOf(pane(sourceStatus), worker, successorPane), published: { alpha: status(1) } }];

test('an idle context successor without readyAt becomes ready and activates', { timeout: 30000 }, (t) => {
  const out = run(t, { tokens: 400000, memory: tracked, handoffs: [unreadyRecord()], steps: autoStep(successor) });
  assert.ok(out.records[0].readyAt);
  assert.equal(out.records[0].readyNote, 'auto: successor idle');
  assert.equal(activates(out).length, 1);
});

test('a done context successor without readyAt becomes ready', { timeout: 30000 }, (t) => {
  const out = run(t, { tokens: 400000, memory: tracked, handoffs: [unreadyRecord()], steps: autoStep({ ...successor, status: 'done' }, 1, 'working') });
  assert.equal(out.records[0].readyNote, 'auto: successor idle');
});

test('a working context successor does not become ready and the wait names it', { timeout: 30000 }, (t) => {
  const out = run(t, { tokens: 400000, memory: tracked, handoffs: [unreadyRecord()], steps: autoStep({ ...successor, status: 'working' }) });
  assert.equal(out.records[0].readyAt, undefined);
  assert.equal(out.handoverWaits['ctx-1'], 'successor not ready: it works');
  assert.deepEqual(activates(out), []);
});

test('a context successor is not ready within 120 seconds of the prompt', { timeout: 30000 }, (t) => {
  const out = run(t, { tokens: 400000, memory: tracked, handoffs: [unreadyRecord({ preparedAt: '2026-09-29T11:59:30.000Z' })], steps: autoStep(successor) });
  assert.equal(out.records[0].readyAt, undefined);
  assert.match(out.handoverWaits['ctx-1'], /^successor not ready: /);
});

test('a successor pane with another agent or no pane does not become ready', { timeout: 30000 }, (t) => {
  const other = run(t, { tokens: 400000, memory: tracked, handoffs: [unreadyRecord()], steps: autoStep({ ...successor, agent: 'codex' }) });
  assert.equal(other.records[0].readyAt, undefined);
  assert.equal(other.handoverWaits['ctx-1'], 'successor not ready: the successor pane runs another agent');
  const gone = run(t, { tokens: 400000, memory: tracked, handoffs: [unreadyRecord()], steps: [{ at: at(1), herdr: herdrOf(pane('idle'), worker), published: { alpha: status(1) } }] });
  assert.equal(gone.records[0].readyAt, undefined);
  assert.equal(gone.records[0].status, 'expired');
  assert.deepEqual(activates(gone), []);
});

test('a successor that is not from the context trigger, or has a prompt error, does not become ready', { timeout: 30000 }, (t) => {
  const untracked = run(t, { tokens: 400000, handoffs: [unreadyRecord()], steps: autoStep(successor) });
  assert.equal(untracked.records[0].readyAt, undefined);
  const failed = run(t, { tokens: 400000, memory: tracked, handoffs: [unreadyRecord({ promptError: 'stalled' })], steps: autoStep(successor) });
  assert.equal(failed.records[0].readyAt, undefined);
  assert.equal(failed.handoverWaits['ctx-1'], 'successor not ready: the prepare prompt failed');
});

// ---- R2: the tab rename does not wait for the close of the old pane.
test('the tab is renamed after the successor answered while the old pane still works', { timeout: 30000 }, (t) => {
  const out = run(t, {
    handoffs: [activeRecord({ activatedAt: '2026-09-29T11:59:30.000Z' })],
    steps: [
      { at: at(1), herdr: herdrOf(oldPane('working'), newPane('working'), worker) },
      { at: at(2), herdr: herdrOf(oldPane('working'), newPane('idle'), worker) },
    ],
  });
  assert.deepEqual(closes(out), []);
  assert.deepEqual(renames(out).map(({ args }) => args.slice(2)), [['w-alpha:t9', 'Orchestrator']]);
  assert.ok(out.records[0].finish.tabRenamedAt);
});

test('an idle successor that never worked stays not ready after 120 seconds', { timeout: 30000 }, (t) => {
  const out = run(t, { tokens: 400000, memory: tracked, handoffs: [unreadyRecord({ seenWorkingAt: undefined })], steps: autoStep(successor, 5) });
  assert.equal(out.records[0].readyAt, undefined);
  assert.equal(out.handoverWaits['ctx-1'], 'successor not ready: it has not started its state read');
  assert.deepEqual(activates(out), []);
});

test('a successor becomes ready after it was seen working and is idle again', { timeout: 30000 }, (t) => {
  const out = run(t, {
    tokens: 400000, memory: tracked, handoffs: [unreadyRecord({ seenWorkingAt: undefined })],
    steps: [
      { at: at(1), herdr: herdrOf(pane('working'), worker, { ...successor, status: 'working' }), published: { alpha: status(1) } },
      { at: at(4), herdr: herdrOf(pane('working'), worker, successor), published: { alpha: status(1) } },
    ],
  });
  assert.ok(out.records[0].seenWorkingAt);
  assert.equal(out.records[0].readyNote, 'auto: successor idle');
});

test('a stalled-retry prompt delivery blocks the automatic ready signal', { timeout: 30000 }, (t) => {
  const out = run(t, { tokens: 400000, memory: tracked, handoffs: [unreadyRecord({ promptDelivery: 'stalled-retry' })], steps: autoStep(successor, 5) });
  assert.equal(out.records[0].readyAt, undefined);
  assert.equal(out.handoverWaits['ctx-1'], 'successor not ready: the prepare prompt stalled');
});
