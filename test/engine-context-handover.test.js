import './helpers/test-env.js';
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

// SYNTHETIC Claude screen. All words and values are invented.
const successorScreen = [
  '❯ ',
  '※ recap: The state is read. The next step waits for activation.',
  '✻ Churned for 15s · done 12:20 PM',
  '➜  Project git:(main)  Sonnet 5.5 ctx:6% | Est. usage: $0.23',
  '⏵⏵ auto mode on (shift+tab to cycle)',
].join('\n');

// Each step sets the pane list and the published files for one tick.
const probe = `
import fs from 'node:fs';
import path from 'node:path';
import { Engine } from './src/engine.js';
import { loadConfig } from './src/config.js';
const input = JSON.parse(process.env.E1_SCENARIO);
let now = Date.parse('2026-09-29T12:00:00.000Z');
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
};
const calls = [];
const herdrCalls = [];
const gitCalls = [];
const snapshots = [];
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
    collectQuotas: async () => input.quotas || [],
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
    if (input.steps[calls.step].failClose && args[0] === 'pane' && args[1] === 'close') throw new Error('fake close failure');
    if (args[0] === 'agent' && args[1] === 'prompt' && args[2] === 'w-boss:p1' && input.steps[calls.step].failBossPrompt) {
      return JSON.stringify({ error: { message: 'fake Boss prompt failure' } });
    }
    if (args[0] === 'pane' && args[1] === 'read') return { text: input.steps[calls.step].screen ?? input.successorScreen };
    return '{}';
  },
  handoffRunner: async (command, args) => {
    calls.push({ step: calls.step, args });
    if (args[2] === 'prepare') {
      const newPane = input.createPreparedRecord ? 'w-alpha:p9' : 'fake-successor';
      if (input.createPreparedRecord) {
        const records = JSON.parse(fs.readFileSync(path.join(process.env.HERDR_BOSS_DIR, 'handoffs.json'), 'utf8'));
        records.push({ id: 'fake-handoff', project: 'alpha', workspace: 'w-alpha', label: 'orch', sourcePane: args[3], newPane,
          displayLabel: 'Alpha', fromKind: 'claude', toKind: 'claude', model: 'claude-sonnet-5-5', status: 'prepared', automatic: true,
          readyAt: new Date().toISOString(), preparedAt: new Date().toISOString() });
        fs.writeFileSync(path.join(process.env.HERDR_BOSS_DIR, 'handoffs.json'), JSON.stringify(records));
      }
      return JSON.stringify({ id: 'fake-handoff', newPane });
    }
    return JSON.stringify({ ok: true });
  },
  gitRunner: async (args) => {
    gitCalls.push({ step: calls.step, args });
    if (args.includes('rev-parse')) return 'a'.repeat(40);
    if (args.includes('docs/orchestration/memory.md')) return input.steps[calls.step].memoryCommit || '';
    if (args.includes('--format=%cI')) return '2026-09-29T12:00:00.000Z';
    return '';
  },
});
const logs = [];
const originalLog = engine.log.bind(engine);
engine.log = (level, message, ...args) => { logs.push({ level, message }); return originalLog(level, message, ...args); };
let mailboxFailuresLeft = input.mailboxFailures || 0;
const mailboxAttempts = [];
const appendMessage = engine.messageStore.append.bind(engine.messageStore);
engine.messageStore.append = (message, ...args) => {
  if (message.handoffExpiryId) {
    mailboxAttempts.push({ id: message.handoffExpiryId, step: calls.step });
    if (mailboxFailuresLeft > 0) { mailboxFailuresLeft -= 1; throw new Error('fake append failure'); }
  }
  return appendMessage(message, ...args);
};
engine.deliver = async () => {};
if (input.quotas) { engine.readQuotas(); await engine.quotaRead; }
for (const [index, step] of input.steps.entries()) {
  now = Date.parse(step.at);
  herdr = step.herdr;
  calls.step = index;
  for (const [slug, body] of Object.entries(step.published || {})) {
    fs.writeFileSync(path.join(process.env.HERDR_BOSS_DIR, 'projects', slug + '.json'), JSON.stringify(body));
  }
  await engine.tick();
  snapshots.push({ handoffs: JSON.parse(fs.readFileSync(path.join(process.env.HERDR_BOSS_DIR, 'handoffs.json'), 'utf8')), alerts: engine.state?.alerts || [], memory: structuredClone(engine.memory) });
}
console.log(JSON.stringify({ calls, herdrCalls, gitCalls, events: engine.events, memory: engine.memory, handoverWaits: engine.state?.handoverWaits, snapshots, messages: engine.messageStore.all(), logs, mailboxAttempts }));
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
  fs.writeFileSync(path.join(dir, 'project-repos.json'), JSON.stringify([{ slug: 'alpha', repo: '/work/alpha' }]));
  if (scenario.legacyPolicy) {
    fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(scenario.legacyPolicy));
  } else {
    const policy = structuredClone(POLICY_DEFAULTS);
    policy.autoHandover = scenario.autoHandover ?? true;
    Object.assign(policy, scenario.policy || {});
    fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(policy));
  }
  fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify({ paneSince: {}, pushes: {}, notified: {}, ...(scenario.memory || {}) }));
  fs.writeFileSync(path.join(dir, 'handoffs.json'), JSON.stringify(scenario.handoffs || []));
  if (scenario.tokens !== undefined) {
    transcript(dir, '/work/alpha', 'sess-1', [
      { type: 'user', message: { content: 'hello' } },
      assistant({ input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 5, output_tokens: 9 }),
      assistant({ input_tokens: 20, cache_read_input_tokens: scenario.tokens - 30, cache_creation_input_tokens: 10, output_tokens: 300 }, scenario.model),
    ]);
  }
  if (scenario.successorTokens !== undefined) {
    transcript(dir, '/work/alpha', 'sess-2', [assistant({ input_tokens: scenario.successorTokens })]);
  }
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env, HOME: dir, HERDR_BOSS_DIR: dir, HERDR_BOSS_LIVE_DIR: dir, HERDR_BOSS_ALLOW_ACTIONS: '1',
      NODE_TEST_CONTEXT: '', E1_SCENARIO: JSON.stringify({ steps: scenario.steps, mutateOnClose: scenario.mutateOnClose, mailboxFailures: scenario.mailboxFailures, successorScreen, quotas: scenario.quotas, createPreparedRecord: scenario.createPreparedRecord }),
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

test('claude context usage caches by session and file signature for 30 seconds', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-e1-cache-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  transcript(home, '/work/alpha', 'cache-session', [assistant({ input_tokens: 12 })]);
  const counts = { openSync: 0, readSync: 0, statSync: 0, existsSync: 0, readdirSync: 0 };
  const filesystem = new Proxy(fs, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (Object.hasOwn(counts, key)) counts[key] += 1;
        return value.apply(target, args);
      };
    },
  });
  let now = 1_000_000;
  const read = () => claudeContextUsage({ sessionId: 'cache-session', cwd: '/elsewhere', home, clock: () => now, filesystem });
  assert.equal(read().tokens, 12);
  const firstReads = counts.readSync;
  const firstOpens = counts.openSync;
  const firstStats = counts.statSync;
  const firstScans = counts.readdirSync;
  assert.ok(firstScans > 0, 'the first lookup scans for the transcript when cwd does not identify its folder');
  now += 29_999;
  assert.equal(read().tokens, 12);
  assert.equal(counts.readSync, firstReads);
  assert.equal(counts.openSync, firstOpens);
  assert.equal(counts.statSync, firstStats, 'a fresh result needs no file-system read');
  assert.equal(counts.readdirSync, firstScans, 'a fresh result needs no directory scan');

  now += 1;
  assert.equal(read().tokens, 12);
  assert.equal(counts.statSync, firstStats + 1, 'the reader checks the cached file signature at 30 seconds');
  assert.equal(counts.readSync, firstReads, 'an unchanged file does not need a new tail read');

  const file = path.join(home, '.claude', 'projects', '-work-alpha', 'cache-session.jsonl');
  fs.writeFileSync(file, `${JSON.stringify(assistant({ input_tokens: 1200 }))}\n`);
  now += 30_001;
  assert.equal(read().tokens, 1200);
  assert.ok(counts.readSync > firstReads, 'a changed size or mtime refreshes the usage value');
  assert.equal(counts.readdirSync, firstScans, 'the cached transcript path avoids another directory scan');
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

test('the forced context threshold defaults to 400000 and stays above the normal threshold', () => {
  assert.equal(POLICY_DEFAULTS.autoHandoverForceContextTokens, 400000);
  assert.ok(validatePolicy({ ...structuredClone(POLICY_DEFAULTS), autoHandoverForceContextTokens: 400000 }, loadModels()).length === 0);
  assert.ok(validatePolicy({ ...structuredClone(POLICY_DEFAULTS), autoHandoverForceContextTokens: 300000 }, loadModels())
    .some((error) => /autoHandoverForceContextTokens must be greater than autoHandoverContextTokens/.test(error)));
});

test('legacy normal thresholds do not start forced memory handover below their migrated limit', { timeout: 30000 }, (t) => {
  for (const [normal, tokens] of [[400000, 405000], [500000, 425000], [2000000, 425000]]) {
    const out = run(t, {
      tokens,
      legacyPolicy: { autoHandover: true, autoHandoverContextTokens: normal },
      steps: [{ at: at(0), herdr: herdrOf(pane('working'), worker), published: { alpha: status(0) } }],
    });
    assert.equal(out.herdrCalls.some(({ args }) => args[0] === 'agent' && args[1] === 'prompt' && args[2] === 'w-alpha:p1'), false, `normal threshold ${normal}`);
    assert.deepEqual(prepares(out), [], `normal threshold ${normal}`);
  }
});

test('an invalid legacy threshold pair does not run the forced context path', { timeout: 30000 }, (t) => {
  const out = run(t, {
    tokens: 600000,
    legacyPolicy: { autoHandover: true, autoHandoverContextTokens: 500000, autoHandoverForceContextTokens: 400000 },
    steps: [{ at: at(0), herdr: herdrOf(pane('working'), worker), published: { alpha: status(0) } }],
  });
  assert.equal(out.herdrCalls.some(({ args }) => args[0] === 'agent' && args[1] === 'prompt' && args[2] === 'w-alpha:p1'), false);
  assert.deepEqual(prepares(out), []);
});

test('a forced context handover waits for the memory commit before preparation and activates only when idle', { timeout: 30000 }, (t) => {
  const out = run(t, {
    tokens: 425000,
    createPreparedRecord: true,
    steps: [
      { at: at(0), herdr: herdrOf(pane('working'), worker), published: { alpha: status(0) } },
      { at: at(1), herdr: herdrOf(pane('working'), worker), published: { alpha: status(0) } },
      { at: at(2), herdr: herdrOf(pane('working'), worker), published: { alpha: status(0) }, memoryCommit: 'b'.repeat(40) },
      { at: at(3), herdr: herdrOf(pane('working'), worker, successor), published: { alpha: status(1) } },
      { at: at(4), herdr: herdrOf(pane('idle'), worker, successor), published: { alpha: status(1) } },
    ],
  });
  const memoryPrompts = out.herdrCalls.filter(({ args }) => args[0] === 'agent' && args[1] === 'prompt' && args[2] === 'w-alpha:p1');
  assert.equal(memoryPrompts.length, 1);
  assert.equal(memoryPrompts[0].args[3], 'Write docs/orchestration/memory.md with every release since the last entry, commit it, and push; then reply done.');
  assert.equal(memoryPrompts[0].step, 0);
  assert.deepEqual(prepares(out).map(({ step }) => step), [2], 'prepare only after a commit touches memory.md');
  assert.equal(activates(out)[0]?.step, 4, 'the prepared successor waits until the source pane is idle');
  assert.equal(out.records.find(({ id }) => id === 'fake-handoff')?.memoryUpdateCommit, 'b'.repeat(40));
});

test('a forced context handover waits for a late memory commit after the 20-minute preparation timeout', { timeout: 30000 }, (t) => {
  const out = run(t, {
    tokens: 425000,
    createPreparedRecord: true,
    steps: [
      { at: at(0), herdr: herdrOf(pane('working'), worker), published: { alpha: status(0) } },
      { at: at(19), herdr: herdrOf(pane('working'), worker), published: { alpha: status(0) } },
      { at: at(20), herdr: herdrOf(pane('working'), worker), published: { alpha: status(0) } },
      { at: at(21), herdr: herdrOf(pane('idle'), worker, successor), published: { alpha: status(0) } },
      { at: at(22), herdr: herdrOf(pane('idle'), worker, successor), published: { alpha: status(0) }, memoryCommit: 'b'.repeat(40) },
    ],
  });
  assert.equal(out.herdrCalls.filter(({ args }) => args[0] === 'agent' && args[1] === 'prompt' && args[2] === 'w-alpha:p1').length, 1);
  assert.deepEqual(prepares(out).map(({ step }) => step), [2]);
  assert.equal(out.snapshots[2].handoffs.find(({ id }) => id === 'fake-handoff')?.memoryUpdateStatus, 'not-updated');
  assert.deepEqual(activates(out).map(({ step }) => step), [4], 'no activation occurs before the late memory commit is verified');
  assert.equal(out.records.find(({ id }) => id === 'fake-handoff')?.memoryUpdateStatus, 'committed');
  assert.equal(out.records.find(({ id }) => id === 'fake-handoff')?.memoryUpdateCommit, 'b'.repeat(40));
});

test('the context threshold counts tokens, not a share of a model window', { timeout: 30000 }, (t) => {
  // 280K tokens is 28% of a 1M window and 140% of a 200K window. The policy value of 300K tokens decides in both cases.
  for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5[1m]']) {
    const below = run(t, { tokens: 280000, model, steps: boundary() });
    assert.deepEqual(prepares(below), [], `280K tokens stays below the 300K limit for ${model}`);
  }
  const edge = run(t, { tokens: 300000, steps: boundary() });
  assert.deepEqual(prepares(edge), [], 'exactly 300K tokens does not exceed the limit');
  const above = run(t, { tokens: 300001, steps: boundary() });
  assert.equal(prepares(above).length, 1);
  assert.match(above.logs.find(({ message }) => /^Prepared a fresh/.test(message)).message, /300001 tokens, above the limit of 300000 tokens/);
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
  const out = run(t, { tokens: 425000, autoHandover: false, steps: boundary() });
  assert.deepEqual(prepares(out), []);
  assert.equal(out.herdrCalls.some(({ args }) => args[0] === 'agent' && args[1] === 'prompt'), false);
});

test('a forced context handover keeps the held, inactive, and Boss guards', { timeout: 30000 }, (t) => {
  const paused = run(t, { tokens: 425000, steps: [{ at: at(0), herdr: herdrOf(pane('working'), worker), published: { alpha: status(0, { status: 'paused' }) } }] });
  const stoodDown = run(t, { tokens: 425000, steps: [{ at: at(0), herdr: herdrOf(pane('working'), worker), published: { alpha: status(0, { status: 'stood down' }) } }] });
  const inactive = run(t, { tokens: 425000, steps: [{ at: at(0), herdr: herdrOf(pane('idle')), published: { alpha: status(0) } }] });
  const boss = run(t, { tokens: 425000, steps: [{ at: at(0), herdr: herdrOf(pane('working', { label: 'boss' }), worker), published: { alpha: status(0) } }] });
  for (const out of [paused, stoodDown, inactive, boss]) {
    assert.deepEqual(prepares(out), []);
    assert.equal(out.herdrCalls.some(({ args }) => args[0] === 'agent' && args[1] === 'prompt'), false);
  }
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
  displayLabel: 'Alpha', fromKind: 'claude', toKind: 'claude', model: 'claude-sonnet-5-5', status: 'prepared', automatic: true,
  readyAt: '2026-09-29T11:59:00.000Z', preparedAt: '2026-09-29T11:58:00.000Z', ...extra,
});
const successor = { id: 'w-alpha:p9', workspace: 'w-alpha', label: null, orch: false, agent: 'claude', status: 'idle', sessionId: 'sess-2', cwd: '/work/alpha' };

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

test('quota readiness cannot activate a forced context successor while its source works', { timeout: 30000 }, (t) => {
  const out = run(t, {
    tokens: 425000,
    memory: { contextHandovers: { 'ctx-1': { pane: 'w-alpha:p1', at: 1, tokens: 425000, sourceModel: 'claude-sonnet-5-5' } } },
    handoffs: [readyRecord({ memoryUpdateStatus: 'committed' })],
    quotas: [{ provider: 'claude', windows: [{ key: 'primary', label: 'Weekly', usedPercent: 99, expectedPercent: 60, resetsAt: '2026-10-01T12:00:00.000Z' }] }],
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
const expiredRecord = (extra = {}) => unreadyRecord({ status: 'expired', expiredAt: at(0), expiredReason: 'successor not ready after 30 minutes', ...extra });
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

test('a successor outside the context trigger becomes ready, while a prompt error blocks readiness', { timeout: 30000 }, (t) => {
  const untracked = run(t, { tokens: 400000, handoffs: [unreadyRecord()], steps: autoStep(successor) });
  assert.ok(untracked.records[0].readyAt);
  assert.deepEqual(activates(untracked), []);
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

test('an idle successor with Claude context evidence becomes ready at 120 seconds, but not before', { timeout: 30000 }, (t) => {
  const record = unreadyRecord({ seenWorkingAt: undefined, promptAt: '2026-09-29T11:59:00.000Z' });
  const out = run(t, {
    tokens: 400000, successorTokens: 12000, memory: tracked, handoffs: [record],
    steps: [
      { at: '2026-09-29T12:00:59.000Z', herdr: herdrOf(pane('idle'), worker, successor), published: { alpha: status(1) } },
      { at: '2026-09-29T12:01:00.000Z', herdr: herdrOf(pane('idle'), worker, successor), published: { alpha: status(1) } },
    ],
  });
  assert.equal(out.snapshots[0].handoffs[0].readyAt, undefined);
  assert.ok(out.snapshots[1].handoffs[0].readyAt);
});

test('a non-Claude successor becomes ready by the idle rule without context evidence', { timeout: 30000 }, (t) => {
  const out = run(t, {
    tokens: 400000, memory: tracked,
    handoffs: [unreadyRecord({ toKind: 'codex', model: 'gpt-5', seenWorkingAt: undefined })],
    steps: autoStep({ ...successor, agent: 'codex' }),
  });
  assert.equal(out.records[0].readyNote, 'auto: successor idle');
});

// K26: a record left in `preparing` by an interrupted prepare keeps a live successor. The engine
// applies the same guarded transition that `handoff ready` and `handoff repair` use.
test('the engine promotes a preparing context successor with an idle matching pane', { timeout: 30000 }, (t) => {
  const record = { ...unreadyRecord({ promptAt: '2026-09-29T11:59:00.000Z' }), status: 'preparing' };
  const out = run(t, { tokens: 400000, memory: tracked, handoffs: [record], steps: autoStep(successor) });
  assert.equal(out.records[0].status, 'prepared');
  assert.equal(out.records[0].preparedFrom, 'preparing');
  assert.equal(out.records[0].readyNote, 'auto: successor idle');
  assert.ok(out.logs.some((entry) => /Promoted handoff ctx-1/.test(entry.message)));
  assert.equal(activates(out).length, 1);
});

// K27: the preparing guard accepts a settled pane, so a successor whose turn finished and whose input
// is ready promotes like an idle pane. Every other K26 rule stays: no automatic activation here,
// the prompt-evidence hold, no resend, and no Owner-goal or context regression.
test('the engine promotes a preparing successor whose pane is done and holds the record without prompt evidence', { timeout: 30000 }, (t) => {
  const record = { ...unreadyRecord({ promptDelivery: undefined, promptAt: undefined }), status: 'preparing' };
  const out = run(t, { tokens: 400000, memory: tracked, handoffs: [record], steps: autoStep({ ...successor, status: 'done' }) });
  assert.equal(out.records[0].status, 'prepared');
  assert.equal(out.records[0].preparedFrom, 'preparing');
  assert.equal(out.records[0].preparedNote, 'engine: successor idle or done');
  assert.ok(out.logs.some((entry) => /Promoted handoff ctx-1/.test(entry.message)));
  assert.equal(out.records[0].readyAt, undefined, 'the prompt-evidence hold keeps the record unready');
  assert.deepEqual(activates(out), [], 'the promoter never activates');
  assert.equal(out.herdrCalls.filter(({ args }) => args[0] === 'agent' && args[1] === 'prompt' && /proposed successor/.test(String(args[3]))).length, 0, 'the promoter never resends the bootstrap prompt');
});

test('a done preparing successor with prompt evidence still becomes ready and activates', { timeout: 30000 }, (t) => {
  const record = { ...unreadyRecord({ promptAt: '2026-09-29T11:59:00.000Z' }), status: 'preparing' };
  const out = run(t, { tokens: 400000, memory: tracked, handoffs: [record], steps: autoStep({ ...successor, status: 'done' }) });
  assert.equal(out.records[0].status, 'prepared');
  assert.ok(out.records[0].readyAt);
  assert.equal(activates(out).length, 1);
});

test('the engine does not promote a preparing successor whose pane works', { timeout: 30000 }, (t) => {
  const record = { ...unreadyRecord(), status: 'preparing' };
  const out = run(t, { tokens: 400000, memory: tracked, handoffs: [record], steps: autoStep({ ...successor, status: 'working' }) });
  assert.equal(out.records[0].status, 'preparing');
  assert.ok(out.logs.some((entry) => /stays preparing: it works/.test(entry.message)));
});

// F5: a recovered record without a proven bootstrap prompt must not auto-ready or activate.
test('the engine holds a promoted prompt-less successor and does not auto-ready or activate it', { timeout: 30000 }, (t) => {
  const record = { ...unreadyRecord({ promptDelivery: undefined, promptAt: undefined }), status: 'preparing' };
  const steps = [1, 11].map((minute) => ({ at: at(minute), herdr: herdrOf(pane('idle'), worker, successor), published: { alpha: status(1) } }));
  const out = run(t, { tokens: 400000, memory: tracked, handoffs: [record], steps });
  assert.equal(out.records[0].status, 'prepared');
  assert.equal(out.records[0].readyAt, undefined);
  assert.deepEqual(activates(out), []);
  assert.equal(out.logs.filter((entry) => /no bootstrap prompt evidence/.test(entry.message)).length, 1, 'one bounded hold reason');
  const held = out.logs.filter((entry) => /no bootstrap prompt evidence/.test(entry.message));
  assert.equal(held.length, 1);
  assert.match(held[0].message, /stays unready/, 'the log names the record as unready, not as unprepared');
  assert.equal(out.logs.some((entry) => /stays unprepared/.test(entry.message)), false);
});

test('a promoted successor with recorded prompt evidence still becomes ready and activates', { timeout: 30000 }, (t) => {
  const record = { ...unreadyRecord({ promptAt: '2026-09-29T11:59:00.000Z' }), status: 'preparing' };
  const out = run(t, { tokens: 400000, memory: tracked, handoffs: [record], steps: autoStep(successor) });
  assert.equal(out.records[0].status, 'prepared');
  assert.ok(out.records[0].readyAt);
  assert.equal(activates(out).length, 1);
});

test('the engine logs one reason while a preparing successor stays stuck and notices the Boss after 10 minutes', { timeout: 30000 }, (t) => {
  const record = { ...unreadyRecord(), status: 'preparing', preparedAt: at(0) };
  const workingSuccessor = { ...successor, status: 'working' };
  const steps = [1, 2, 11, 12].map((minute) => ({ at: at(minute), herdr: herdrOf(pane('idle'), workingSuccessor, bossPane), published: { alpha: status(1) } }));
  const out = run(t, { tokens: 400000, memory: tracked, handoffs: [record], steps });
  assert.equal(out.records[0].status, 'preparing');
  assert.equal(out.logs.filter((entry) => /stays preparing/.test(entry.message)).length, 1, 'one reason log for the stuck episode');
  const notices = bossNotes(out);
  assert.equal(notices.length, 1);
  assert.match(notices[0].args[3], /handoff repair ctx-1/);
});

// K26 copy closure: the notice names the accurate reason first. It never offers a read of an absent
// pane and never offers a repair that the shared guard refuses in the state where the notice fires.
const preparingNoticeSteps = (successorPane, broken = false) => [1, 11].map((minute) => ({ at: at(minute), herdr: herdrOf(pane('idle'), worker, bossPane, ...(broken ? [{ workspace: 'w-alpha', label: 'broken' }] : [successorPane])), published: { alpha: status(1) } }));

test('the preparing notice names an absent successor pane and does not tell the Boss to read it', { timeout: 30000 }, (t) => {
  const record = { ...unreadyRecord(), status: 'preparing', preparedAt: at(0) };
  const out = run(t, { tokens: 400000, memory: tracked, handoffs: [record], steps: preparingNoticeSteps(null, true) });
  assert.equal(out.records[0].status, 'preparing');
  const notices = out.herdrCalls.filter(({ args }) => args[0] === 'agent' && args[1] === 'prompt' && /still preparing/.test(String(args[3])));
  assert.equal(notices.length, 1);
  const text = notices[0].args[3];
  assert.match(text, /the successor pane is absent/);
  assert.equal(/does not run the target agent/.test(text), false, 'an absent pane is not a wrong agent');
  assert.equal(/herdr agent read/.test(text), false, 'the notice never names a read of a pane that is absent');
  assert.match(text, /handoff repair ctx-1 --dry-run/);
});

test('the preparing notice names a successor pane that runs another agent', { timeout: 30000 }, (t) => {
  const record = { ...unreadyRecord(), status: 'preparing', preparedAt: at(0) };
  const other = { ...successor, agent: 'codex' };
  const out = run(t, { tokens: 400000, memory: tracked, handoffs: [record], steps: preparingNoticeSteps(other) });
  const notices = out.herdrCalls.filter(({ args }) => args[0] === 'agent' && args[1] === 'prompt' && /still preparing/.test(String(args[3])));
  assert.equal(notices.length, 1);
  const text = notices[0].args[3];
  assert.match(text, /the successor pane does not run the target agent/);
  assert.match(text, /herdr agent read w-alpha:p9/, 'an existing pane can be read');
});

test('the preparing notice does not promise a repair that the guard refuses', { timeout: 30000 }, (t) => {
  const record = { ...unreadyRecord(), status: 'preparing', preparedAt: at(0) };
  const working = { ...successor, status: 'working' };
  const out = run(t, { tokens: 400000, memory: tracked, handoffs: [record], steps: preparingNoticeSteps(working) });
  const notices = out.herdrCalls.filter(({ args }) => args[0] === 'agent' && args[1] === 'prompt' && /still preparing/.test(String(args[3])));
  assert.equal(notices.length, 1);
  const text = notices[0].args[3];
  assert.match(text, /the successor pane is not idle or done yet/, 'the notice does not guess a busy or settled state');
  assert.match(text, /herdr agent read w-alpha:p9/);
  assert.equal(/to promote it/.test(text), false, 'the notice never advertises an immediate repair');
  assert.match(text, /promotes the record/);
  assert.match(text, /handoff repair ctx-1 --dry-run/);
});

test('a ghost suggestion in an idle successor input does not block readiness', { timeout: 30000 }, (t) => {
  const out = run(t, {
    tokens: 400000, successorTokens: 12000, memory: tracked,
    handoffs: [unreadyRecord({ seenWorkingAt: undefined })],
    steps: [{ at: at(1), herdr: herdrOf(pane('idle'), worker, successor), published: { alpha: status(1) }, screen: successorScreen.replace('❯ ', '❯\x1b[0m\x1b[2m wait for a report\x1b[0m') }],
  });
  assert.ok(out.records[0].readyAt);
  assert.equal(out.herdrCalls.filter(({ args }) => args[0] === 'agent' && args[1] === 'send-keys').length, 0);
});

test('real unsent successor input gets verified Enter retries after the delay and one Boss notice after the last', { timeout: 30000 }, (t) => {
  const typed = '❯ run the prepared handover';
  const out = run(t, {
    tokens: 400000, memory: tracked,
    handoffs: [unreadyRecord({ seenWorkingAt: undefined })],
    steps: [1, 2, 3, 4, 5, 6].map((minute) => ({ at: at(minute), herdr: herdrOf(pane('idle'), worker, successor, bossPane), published: { alpha: status(1) }, screen: typed })),
  });
  const enters = out.herdrCalls.filter(({ args }) => args[0] === 'agent' && args[1] === 'send-keys');
  assert.deepEqual(enters.map(({ args }) => args), Array(4).fill(['agent', 'send-keys', 'w-alpha:p9', 'enter']), 'the engine sends the first Enter and at most 3 retries');
  assert.ok(out.records[0].inputEnterSentAt);
  assert.ok(out.records[0].inputEnterRetryAt);
  assert.equal(out.records[0].inputEnterRetries, 3);
  assert.ok(out.records[0].inputNoticeAt);
  assert.equal(out.records[0].readyAt, undefined);
  assert.deepEqual(bossNotes(out).map(({ step }) => step), [4], 'the notice goes out one tick after the last retry, not with it');
  assert.match(bossNotes(out)[0].args[3], /ctx-1.*w-alpha:p9/);
  assert.match(bossNotes(out)[0].args[3], /herdr agent read w-alpha:p9/);
});

test('a successor input that stays typed after a wrapped-prompt screen scrolled its marker off still gets Enter', { timeout: 30000 }, (t) => {
  const tall = [...Array.from({ length: 14 }, (_, i) => `  line ${i} of a bootstrap prompt that wraps`), '➜  Project git:(main)  Sonnet 5.5 ctx:6%', '⏵⏵ auto mode on (shift+tab to cycle)'].join('\n');
  const out = run(t, {
    tokens: 400000, memory: tracked,
    handoffs: [unreadyRecord({ seenWorkingAt: undefined })],
    steps: [{ at: at(1), herdr: herdrOf(pane('idle'), worker, successor, bossPane), published: { alpha: status(1) }, screen: tall }],
  });
  assert.deepEqual(out.herdrCalls.filter(({ args }) => args[1] === 'send-keys').map(({ args }) => args), [['agent', 'send-keys', 'w-alpha:p9', 'enter']]);
});

test('a dim paste placeholder in the successor input gets Enter', { timeout: 30000 }, (t) => {
  const out = run(t, {
    tokens: 400000, memory: tracked,
    handoffs: [unreadyRecord({ seenWorkingAt: undefined })],
    steps: [{ at: at(1), herdr: herdrOf(pane('idle'), worker, successor, bossPane), published: { alpha: status(1) }, screen: successorScreen.replace('❯ ', '❯ \x1b[2m[Pasted text #1 +30 lines]\x1b[0m') }],
  });
  assert.equal(out.herdrCalls.filter(({ args }) => args[1] === 'send-keys').length, 1);
});

test('a successor input that is cleared before the second wait gets the retry and no Boss notice', { timeout: 30000 }, (t) => {
  const out = run(t, {
    tokens: 400000, memory: tracked,
    handoffs: [unreadyRecord({ seenWorkingAt: undefined })],
    steps: [
      { at: at(1), herdr: herdrOf(pane('idle'), worker, successor, bossPane), published: { alpha: status(1) }, screen: '❯ run the prepared handover' },
      { at: at(2), herdr: herdrOf(pane('idle'), worker, successor, bossPane), published: { alpha: status(1) }, screen: '❯ run the prepared handover' },
      { at: at(3), herdr: herdrOf(pane('idle'), worker, successor, bossPane), published: { alpha: status(1) } },
    ],
  });
  const enters = out.herdrCalls.filter(({ args }) => args[0] === 'agent' && args[1] === 'send-keys');
  assert.deepEqual(enters.map(({ args }) => args), [
    ['agent', 'send-keys', 'w-alpha:p9', 'enter'],
    ['agent', 'send-keys', 'w-alpha:p9', 'enter'],
  ], 'the retry still goes out after the first wait');
  assert.deepEqual(bossNotes(out), [], 'a cleared input sends no notice');
});

test('a cleared successor input gets no second Enter and becomes ready', { timeout: 30000 }, (t) => {
  const out = run(t, {
    tokens: 400000, memory: tracked,
    handoffs: [unreadyRecord({ seenWorkingAt: undefined })],
    steps: [
      { at: at(1), herdr: herdrOf(pane('idle'), worker, successor, bossPane), published: { alpha: status(1) }, screen: '❯ run the prepared handover' },
      { at: '2026-09-29T12:02:00.000Z', herdr: herdrOf(pane('idle'), worker, { ...successor, status: 'working' }), published: { alpha: status(1) } },
      { at: at(3), herdr: herdrOf(pane('idle'), worker, successor, bossPane), published: { alpha: status(1) } },
    ],
  });
  const enters = out.herdrCalls.filter(({ args }) => args[0] === 'agent' && args[1] === 'send-keys');
  assert.deepEqual(enters.map(({ args }) => args), [['agent', 'send-keys', 'w-alpha:p9', 'enter']]);
  assert.deepEqual(bossNotes(out), []);
  assert.ok(out.records[0].readyAt);
  assert.equal(out.records[0].inputEnterRetryAt, undefined);
});

test('the successor input Enter retry ignores a pane of another agent kind', { timeout: 30000 }, (t) => {
  const out = run(t, {
    tokens: 400000, memory: tracked,
    handoffs: [unreadyRecord({ seenWorkingAt: undefined })],
    steps: [
      { at: at(1), herdr: herdrOf(pane('idle'), worker, { ...successor, agent: 'codex' }, bossPane), published: { alpha: status(1) }, screen: '❯ run the prepared handover' },
      { at: at(2), herdr: herdrOf(pane('idle'), worker, { ...successor, agent: 'codex' }, bossPane), published: { alpha: status(1) }, screen: '❯ run the prepared handover' },
    ],
  });
  assert.deepEqual(out.herdrCalls.filter(({ args }) => args[1] === 'send-keys'), []);
  assert.deepEqual(bossNotes(out), []);
  assert.equal(out.records[0].inputEnterSentAt, undefined);
});

test('the successor input screen is read at most once every 15 seconds', { timeout: 30000 }, (t) => {
  const out = run(t, {
    tokens: 400000, memory: tracked,
    handoffs: [unreadyRecord({ seenWorkingAt: undefined })],
    steps: [
      { at: '2026-09-29T12:01:00.000Z', herdr: herdrOf(pane('idle'), worker, successor), published: { alpha: status(1) }, screen: '❯ run the prepared handover' },
      { at: '2026-09-29T12:01:05.000Z', herdr: herdrOf(pane('idle'), worker, successor), published: { alpha: status(1) }, screen: '' },
      { at: '2026-09-29T12:01:14.000Z', herdr: herdrOf(pane('idle'), worker, successor), published: { alpha: status(1) }, screen: '' },
      { at: '2026-09-29T12:01:15.000Z', herdr: herdrOf(pane('idle'), worker, successor), published: { alpha: status(1) }, screen: '' },
    ],
  });
  const reads = out.herdrCalls.filter(({ args }) => args[0] === 'pane' && args[1] === 'read' && args.includes(successor.id));
  // The Agents view reads the pane of a working worker for its Doing now line. That read is not a successor read.
  assert.deepEqual(reads.map(({ step }) => step), [0, 3]);
  assert.equal(out.herdrCalls.filter(({ args }) => args[0] === 'agent' && args[1] === 'send-keys').length, 1);
  assert.equal(out.records[0].readyAt, undefined);
});

test('input submitted with Enter needs new start evidence and a delay before readiness', { timeout: 30000 }, (t) => {
  const record = unreadyRecord({ seenWorkingAt: '2026-09-29T12:00:00.000Z' });
  const out = run(t, {
    tokens: 400000, memory: tracked, handoffs: [record],
    steps: [
      { at: '2026-09-29T12:01:00.000Z', herdr: herdrOf(pane('idle'), worker, successor), published: { alpha: status(1) }, screen: '❯ run the prepared handover' },
      { at: '2026-09-29T12:01:15.000Z', herdr: herdrOf(pane('idle'), worker, successor), published: { alpha: status(1) } },
      { at: '2026-09-29T12:01:20.000Z', herdr: herdrOf(pane('idle'), worker, { ...successor, status: 'working' }), published: { alpha: status(1) }, screen: '' },
      { at: '2026-09-29T12:01:21.000Z', herdr: herdrOf(pane('idle'), worker, successor), published: { alpha: status(1) } },
    ],
  });
  assert.ok(out.records[0].inputEnterSentAt);
  assert.equal(out.snapshots[1].handoffs[0].readyAt, undefined, 'an idle tick after Enter cannot use the earlier seen-working evidence');
  assert.equal(out.snapshots[2].handoffs[0].readyAt, undefined, 'the evidence tick is still working');
  assert.ok(out.snapshots[3].handoffs[0].readyAt, 'new evidence and the post-Enter delay allow readiness');
});

test('expired handover expiry keys are pruned when their records are removed', { timeout: 30000 }, (t) => {
  const out = run(t, {
    memory: {
      handoverExpiryBoss: { removed: 1, 'ctx-1': 2 },
      handoverExpiryHandled: { removed: 3, 'ctx-1': 4 },
      handoverUnreadyNotices: { removed: 5, 'other-live': 6 },
    },
    handoffs: [expiredRecord(), { id: 'other-live', status: 'prepared', automatic: true }],
    steps: [{ at: at(1), herdr: { workspaces: [{ id: 'w-alpha', label: 'Alpha' }] }, published: { alpha: status(1) } }],
  });
  assert.deepEqual(Object.keys(out.memory.handoverExpiryBoss), ['ctx-1']);
  assert.deepEqual(Object.keys(out.memory.handoverExpiryHandled), ['ctx-1']);
  assert.deepEqual(Object.keys(out.memory.handoverUnreadyNotices), ['other-live']);
});

test('expired handover does not close its source, a different agent, or a pane used by another handover', { timeout: 30000 }, (t) => {
  const source = run(t, {
    handoffs: [expiredRecord({ sourcePane: successor.id })],
    steps: [{ at: at(1), herdr: herdrOf(pane('idle'), worker, successor), published: { alpha: status(1) } }],
  });
  assert.equal(source.herdrCalls.some(({ args }) => args[0] === 'pane' && args[1] === 'close'), false);

  const otherAgent = run(t, {
    handoffs: [expiredRecord()],
    steps: [{ at: at(1), herdr: herdrOf(pane('idle'), worker, { ...successor, agent: 'codex' }), published: { alpha: status(1) } }],
  });
  assert.equal(otherAgent.herdrCalls.some(({ args }) => args[0] === 'pane' && args[1] === 'close'), false);

  const inUse = run(t, {
    handoffs: [expiredRecord(), { id: 'other-live', status: 'active', sourcePane: successor.id, newPane: 'w-alpha:p10' }],
    steps: [{ at: at(1), herdr: herdrOf(pane('idle'), worker, successor), published: { alpha: status(1) } }],
  });
  assert.equal(inUse.herdrCalls.some(({ args }) => args[0] === 'pane' && args[1] === 'close'), false);
});

test('expired handover retries Boss prompt and close failures every five minutes and logs once at give-up', { timeout: 30000 }, (t) => {
  const boss = run(t, {
    handoffs: [expiredRecord()],
    steps: ['12:01:00', '12:05:00', '12:06:00', '12:11:00', '12:16:00'].map((time) => ({ at: `2026-09-29T${time}.000Z`, herdr: herdrOf(pane('idle'), worker, successor, bossPane), published: { alpha: status(1) }, failBossPrompt: true })),
  });
  assert.deepEqual(bossNotes(boss).map(({ step }) => step), [0, 2, 3]);
  assert.equal(boss.messages.filter((message) => message.handoffExpiryId === 'ctx-1').length, 0);
  const bossErrors = boss.logs.filter(({ level, message }) => level === 'error' && /handover ctx-1/i.test(message));
  assert.equal(bossErrors.length, 1);
  assert.match(bossErrors[0].message, /giving up the Boss notice/i);

  const close = run(t, {
    handoffs: [expiredRecord()],
    steps: ['12:01:00', '12:05:00', '12:06:00', '12:11:00', '12:16:00'].map((time) => ({ at: `2026-09-29T${time}.000Z`, herdr: herdrOf(pane('idle'), worker, successor, bossPane), published: { alpha: status(1) }, failClose: true })),
  });
  const closeAttempts = close.herdrCalls.filter(({ args }) => args[0] === 'pane' && args[1] === 'close');
  assert.deepEqual(closeAttempts.map(({ step }) => step), [0, 2, 3]);
  const closeErrors = close.logs.filter(({ level, message }) => level === 'error' && /handover ctx-1/i.test(message));
  assert.equal(closeErrors.length, 1);
  assert.match(closeErrors[0].message, /giving up close of pane/i);
});

test('an unready automatic handover expires after 30 minutes, prompts the Boss once, closes only an idle successor, and cools down', { timeout: 30000 }, (t) => {
  const handoff = unreadyRecord({ preparedAt: '2026-09-29T11:29:59.000Z', promptAt: '2026-09-29T11:29:59.000Z', seenWorkingAt: undefined });
  const out = run(t, {
    tokens: 400000,
    memory: { ...tracked, contextBoundary: { 'w-alpha:p1': { done: ['T1'], status: 'idle', workUpdated: null, armed: true } } },
    handoffs: [handoff],
    steps: [
      { at: '2026-09-29T12:00:00.000Z', herdr: herdrOf(pane('idle'), worker, successor, bossPane), published: { alpha: status(1) } },
      { at: '2026-09-29T12:10:00.000Z', herdr: herdrOf(pane('idle'), worker, successor, bossPane), published: { alpha: status(1) } },
      { at: '2026-09-29T12:31:00.000Z', herdr: herdrOf(pane('idle'), worker, successor, bossPane), published: { alpha: status(1) } },
    ],
  });
  assert.equal(out.records[0].status, 'expired');
  assert.equal(out.records[0].expiredReason, 'successor not ready after 30 minutes');
  assert.equal(out.messages.filter((message) => message.handoffExpiryId === 'ctx-1').length, 0);
  assert.equal(bossNotes(out).length, 1);
  assert.match(bossNotes(out)[0].args[3], /ctx-1.*w-alpha:p9.*alpha.*expired after 30 minutes unready/);
  assert.deepEqual(out.herdrCalls.filter(({ args }) => args[0] === 'pane' && args[1] === 'close').map(({ args }) => args), [['pane', 'close', 'w-alpha:p9']]);
  assert.equal(out.snapshots[0].memory.handoverCooldowns.alpha, Date.parse('2026-09-29T12:00:00.000Z'));
  assert.equal(out.snapshots[1].memory.handoverCooldowns.alpha, Date.parse('2026-09-29T12:00:00.000Z'));
  assert.equal(out.snapshots[2].memory.handoverCooldowns.alpha, undefined);
  assert.equal(prepares(out).length, 1);
  assert.equal(prepares(out)[0].step, 2, 'the project can prepare again after the 30-minute cooldown');
});

test('an expired handover never closes a working successor pane', { timeout: 30000 }, (t) => {
  const out = run(t, {
    memory: tracked,
    handoffs: [unreadyRecord({ preparedAt: '2026-09-29T11:29:59.000Z', promptAt: '2026-09-29T11:29:59.000Z', seenWorkingAt: undefined })],
    steps: [{ at: '2026-09-29T12:00:00.000Z', herdr: herdrOf(pane('idle'), worker, { ...successor, status: 'working' }), published: { alpha: status(1) } }],
  });
  assert.equal(out.records[0].status, 'expired');
  assert.deepEqual(out.herdrCalls.filter(({ args }) => args[0] === 'pane' && args[1] === 'close'), []);
});

test('a 400K context warning stays active and clears below the threshold or when a successor is ready', { timeout: 30000 }, (t) => {
  const out = run(t, {
    tokens: 400000,
    steps: [
      { at: '2026-09-29T12:00:00.000Z', herdr: herdrOf(pane('idle'), worker), published: { alpha: status(1) } },
      { at: '2026-09-29T12:30:00.000Z', herdr: herdrOf(pane('idle'), worker), published: { alpha: status(1) } },
      { at: '2026-09-29T13:00:00.000Z', herdr: herdrOf(pane('idle'), worker), published: { alpha: status(1) } },
    ],
  });
  const warnings = out.snapshots.map(({ alerts }) => alerts.find((alert) => alert.key === 'context:alpha'));
  assert.ok(warnings.every(Boolean));
  assert.equal(warnings[0].severity, 'warn');
  assert.equal(warnings[0].title, 'Context at 400K tokens: handover not ready');
  const cleared = run(t, { tokens: 399999, steps: [{ at: at(1), herdr: herdrOf(pane('idle'), worker), published: { alpha: status(1) } }] });
  assert.equal(cleared.snapshots[0].alerts.some((alert) => alert.key === 'context:alpha'), false);
  const ready = run(t, {
    tokens: 400000, handoffs: [readyRecord()],
    steps: [{ at: at(1), herdr: herdrOf(pane('idle'), worker, successor), published: { alpha: status(1) } }],
  });
  assert.equal(ready.snapshots[0].alerts.some((alert) => alert.key === 'context:alpha'), false);
});

test('a context warning clears after activation and can return after 60 minutes', { timeout: 30000 }, (t) => {
  const out = run(t, {
    tokens: 400000, successorTokens: 400000,
    handoffs: [activeRecord({ activatedAt: '2026-09-29T11:59:30.000Z' })],
    steps: [
      { at: '2026-09-29T12:00:00.000Z', herdr: herdrOf(oldPane('idle'), newPane('idle'), idleWorker) },
      { at: '2026-09-29T13:01:00.000Z', herdr: herdrOf(oldPane('idle'), newPane('idle'), idleWorker) },
    ],
  });
  assert.equal(out.snapshots[0].alerts.some((alert) => alert.key === 'context:alpha'), false);
  assert.ok(out.snapshots[1].alerts.some((alert) => alert.key === 'context:alpha'));
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

// ---- HO2: all prepared successors use the readiness check; manual activation stays manual.
test('HO2: a manual Claude successor reads its state and becomes ready at 120 seconds with automatic handover off', { timeout: 30000 }, (t) => {
  for (const settled of ['idle', 'done']) {
    const out = run(t, {
      autoHandover: false,
      handoffs: [unreadyRecord({ automatic: undefined, seenWorkingAt: undefined, promptAt: at(0) })],
      steps: [
        { at: at(0), herdr: herdrOf(pane('idle'), worker, { ...successor, status: 'working' }) },
        { at: '2026-09-29T12:01:59.000Z', herdr: herdrOf(pane('idle'), worker, { ...successor, status: settled }) },
        { at: at(2), herdr: herdrOf(pane('idle'), worker, { ...successor, status: settled }) },
      ],
    });
    assert.equal(out.snapshots[0].handoffs[0].seenWorkingAt, at(0));
    assert.equal(out.snapshots[1].handoffs[0].readyAt, undefined);
    assert.equal(out.records[0].readyAt, at(2));
    assert.equal(out.records[0].status, 'prepared');
    assert.equal(Object.hasOwn(out.records[0], 'automatic'), false);
    assert.deepEqual(activates(out), []);
    assert.equal(out.herdrCalls.some(({ args }) => args[1] === 'send-keys'), false, 'the empty input needs no Enter');
  }
});

test('HO2: a ready manual record cannot activate through the context or quota loop', { timeout: 30000 }, (t) => {
  const out = run(t, {
    tokens: 400000, memory: tracked,
    quotas: [{ provider: 'claude', windows: [{ key: 'primary', label: 'Weekly', usedPercent: 99, resetsAt: '2026-10-01T12:00:00.000Z' }] }],
    handoffs: [unreadyRecord({ automatic: false })],
    steps: autoStep(successor),
  });
  assert.ok(out.records[0].readyAt);
  assert.equal(out.records[0].automatic, false);
  assert.equal(out.records[0].status, 'prepared');
  assert.deepEqual(activates(out), []);
});

test('HO2: quota-safe expiry applies only to automatic records', { timeout: 30000 }, (t) => {
  for (const automatic of [undefined, true]) {
    const out = run(t, {
      handoffs: [readyRecord({ automatic, preparedAt: '2026-09-29T09:00:00.000Z' })],
      steps: autoStep(successor),
    });
    assert.equal(out.records[0].status, automatic ? 'expired' : 'prepared');
    if (automatic) assert.equal(out.records[0].expiredReason, 'claude is no longer near its limit');
    else assert.equal(out.records[0].expiredReason, undefined);
    assert.deepEqual(activates(out), []);
  }
});

test('HO2: a blank pane and a trust dialog cannot become ready or receive Enter', { timeout: 30000 }, (t) => {
  for (const screen of ['', 'Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit']) {
    for (const seenWorkingAt of [undefined, '2026-09-29T11:59:00.000Z']) {
      const out = run(t, {
        handoffs: [unreadyRecord({ seenWorkingAt })], memory: tracked,
        steps: [{ ...autoStep(successor, 5)[0], screen }],
      });
      assert.equal(out.records[0].readyAt, undefined);
      assert.deepEqual(activates(out), []);
      assert.equal(out.herdrCalls.some(({ args }) => args[1] === 'send-keys'), false);
    }
  }
});

test('HO2: manual typed unsent input gets the Enter retry and requires fresh work before readiness', { timeout: 30000 }, (t) => {
  const typed = successorScreen.replace('❯ ', '❯ Read the state again');
  const out = run(t, {
    autoHandover: false,
    handoffs: [unreadyRecord({ automatic: undefined })],
    steps: [
      { at: at(1), herdr: herdrOf(pane('idle'), successor), screen: typed },
      { at: '2026-09-29T12:01:30.000Z', herdr: herdrOf(pane('idle'), successor), screen: typed },
      { at: at(2), herdr: herdrOf(pane('idle'), successor) },
      { at: at(3), herdr: herdrOf(pane('idle'), { ...successor, status: 'working' }) },
      { at: at(4), herdr: herdrOf(pane('idle'), successor) },
    ],
  });
  assert.deepEqual(out.herdrCalls.filter(({ args }) => args[1] === 'send-keys').map(({ args }) => args), [
    ['agent', 'send-keys', successor.id, 'enter'],
    ['agent', 'send-keys', successor.id, 'enter'],
  ]);
  assert.ok(out.snapshots.slice(0, 4).every(({ handoffs }) => !handoffs[0].readyAt));
  assert.equal(out.records[0].readyAt, at(4));
  assert.equal(out.records[0].seenWorkingAt, at(3));
  assert.deepEqual(activates(out), []);
});

test('HO2: an idle unready successor tells the Boss once at 10 minutes after its prompt', { timeout: 30000 }, (t) => {
  for (const automatic of [undefined, true]) {
    const out = run(t, {
      autoHandover: false,
      handoffs: [unreadyRecord({ automatic, seenWorkingAt: undefined, promptAt: at(0) })],
      steps: ['12:09:59', '12:10:00', '12:11:00'].map((time) => ({
        at: `2026-09-29T${time}.000Z`, herdr: herdrOf(pane('idle'), { ...successor, status: 'done' }, bossPane), screen: '',
      })),
    });
    assert.deepEqual(bossNotes(out).map(({ step }) => step), [1]);
    const text = bossNotes(out)[0].args[3];
    assert.match(text, /ctx-1.*w-alpha:p9/);
    assert.match(text, /inspect it: herdr agent read w-alpha:p9/);
    assert.match(text, /herdr-boss handoff activate ctx-1 --confirmed/);
    assert.equal(out.records[0].readyAt, undefined);
    assert.equal(out.messages.filter(message => message.kind !== 'agent').length, 0, 'the notice creates no Owner message');
    assert.equal(out.messages.length, 1);
    assert.equal(out.messages[0].from.role, 'service');
    assert.equal(out.messages[0].agentKind, 'reminder');
    assert.equal(out.messages[0].to.role, 'boss');
    const restarted = run(t, {
      autoHandover: false, handoffs: out.records, memory: out.memory,
      steps: [{ at: at(12), herdr: herdrOf(pane('idle'), successor, bossPane), screen: '' }],
    });
    assert.deepEqual(bossNotes(restarted), [], 'a service restart retains the once-per-record mark');
  }
});

test('HO2: ready, working, blocked and other-agent successors send no idle unready notice', { timeout: 30000 }, (t) => {
  for (const [record, target] of [
    [readyRecord({ automatic: false }), successor],
    [unreadyRecord({ automatic: false }), successor],
    [unreadyRecord({ automatic: false }), { ...successor, status: 'working' }],
    [unreadyRecord({ automatic: false }), { ...successor, status: 'blocked' }],
    [unreadyRecord({ automatic: false }), { ...successor, agent: 'codex' }],
  ]) {
    const out = run(t, {
      autoHandover: false, handoffs: [record],
      steps: [{ at: at(10), herdr: herdrOf(pane('idle'), target, bossPane) }],
    });
    assert.deepEqual(bossNotes(out), []);
  }
});

test('HO2 review: a failed idle unready notice retries after five minutes and sends only once after success', { timeout: 30000 }, (t) => {
  const out = run(t, {
    autoHandover: false, handoffs: [unreadyRecord({ automatic: false, seenWorkingAt: undefined, promptAt: at(0) })],
    steps: [10, 11, 15, 16].map((minute) => ({ at: at(minute), herdr: herdrOf(pane('idle'), successor, bossPane), screen: '', failBossPrompt: minute === 10 })),
  });
  assert.deepEqual(bossNotes(out).map(({ step }) => step), [0, 2]);
  assert.equal(Object.keys(out.snapshots[0].memory.handoverUnreadyNotices || {}).length, 0);
  assert.equal(Object.keys(out.memory.handoverUnreadyNotices).length, 1);
});

test('HO2: a manual unready successor expires at 30 minutes and tells only the Boss', { timeout: 30000 }, (t) => {
  const out = run(t, {
    autoHandover: false,
    handoffs: [unreadyRecord({ automatic: undefined, seenWorkingAt: undefined, preparedAt: at(0), promptAt: at(0) })],
    steps: ['12:29:59', '12:30:00', '12:31:00'].map((time) => ({ at: `2026-09-29T${time}.000Z`, herdr: herdrOf(pane('idle'), successor, bossPane), screen: '' })),
  });
  assert.equal(out.snapshots[0].handoffs[0].status, 'prepared');
  assert.equal(out.snapshots[1].handoffs[0].status, 'expired');
  const expired = bossNotes(out).filter(({ args }) => args[3].includes('expired after 30 minutes unready'));
  assert.equal(expired.length, 1);
  assert.match(expired[0].args[3], /ctx-1.*w-alpha:p9.*alpha/);
  assert.deepEqual(closes(out).map(({ args }) => args), [['pane', 'close', successor.id]]);
  assert.equal(out.messages.filter(message => message.kind !== 'agent').length, 0, 'expiry creates no Owner message');
  assert.equal(out.messages.length, 2, 'the unready and expiry notices each have one service row');
  assert.ok(out.messages.every(message => message.from.role === 'service' && message.agentKind === 'reminder' && message.to.role === 'boss'));
  assert.deepEqual(out.mailboxAttempts, []);
});

test('HO2 review: no Boss pane causes three five-minute unready notice attempts and one give-up error', { timeout: 30000 }, (t) => {
  const out = run(t, {
    autoHandover: false,
    handoffs: [unreadyRecord({ automatic: false, seenWorkingAt: undefined, preparedAt: at(0), promptAt: at(0) })],
    steps: [10, 11, 15, 16, 20, 25].map((minute) => ({ at: at(minute), herdr: herdrOf(pane('idle'), successor), screen: '' })),
  });
  const retries = out.snapshots.map(({ memory }) => memory.handoverExpiryRetries['ctx-1']?.unready);
  assert.deepEqual(retries.map((retry) => retry?.failures), [1, 1, 2, 2, 3, 3]);
  assert.equal(retries[0].nextAt, Date.parse(at(15)));
  assert.equal(retries[2].nextAt, Date.parse(at(20)));
  assert.equal(retries[4].givenUp, true);
  const errors = out.logs.filter(({ level, message }) => level === 'error' && /handoff ctx-1|handover ctx-1/.test(message));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Giving up the unready Boss notice.*after 3 failures.*No Boss pane/);
  assert.deepEqual(bossNotes(out), []);
  const restarted = run(t, {
    autoHandover: false, handoffs: out.records, memory: out.memory,
    steps: [{ at: at(26), herdr: herdrOf(pane('idle'), successor, bossPane), screen: '' }],
  });
  assert.deepEqual(bossNotes(restarted), [], 'a service restart retains the retry give-up mark');
});

test('HO2 review: failed Boss prompts also stop the unready notice after three attempts', { timeout: 30000 }, (t) => {
  const out = run(t, {
    autoHandover: false,
    handoffs: [unreadyRecord({ automatic: false, seenWorkingAt: undefined, preparedAt: at(0), promptAt: at(0) })],
    steps: [10, 11, 15, 16, 20, 25].map((minute) => ({ at: at(minute), herdr: herdrOf(pane('idle'), successor, bossPane), screen: '', failBossPrompt: true })),
  });
  assert.deepEqual(bossNotes(out).map(({ step }) => step), [0, 2, 4]);
  const errors = out.logs.filter(({ level, message }) => level === 'error' && /handoff ctx-1|handover ctx-1/.test(message));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Giving up the unready Boss notice.*after 3 failures/);
});

test('HO2 review: Boss records and prompt errors send no idle unready notice or retries', { timeout: 30000 }, (t) => {
  for (const extra of [{ boss: true }, { label: 'boss' }, { promptError: 'synthetic prompt failure' }]) {
    const out = run(t, {
      autoHandover: false,
      handoffs: [unreadyRecord({ automatic: false, seenWorkingAt: undefined, preparedAt: at(0), promptAt: at(0), ...extra })],
      steps: [10, 15, 20].map((minute) => ({ at: at(minute), herdr: herdrOf(pane('idle'), successor, bossPane), screen: '' })),
    });
    assert.deepEqual(bossNotes(out), []);
    assert.deepEqual(out.memory.handoverExpiryRetries, {});
    assert.equal(out.records[0].readyAt, undefined);
    assert.equal(out.records[0].status, 'prepared');
  }
});

test('HO2 review: an old unready expiry sends no historical Boss prompt and keeps safe pane cleanup', { timeout: 30000 }, (t) => {
  const out = run(t, {
    autoHandover: false,
    handoffs: [expiredRecord({ expiredAt: '2026-09-29T10:00:00.000Z' })],
    steps: [1, 2].map((minute) => ({ at: at(minute), herdr: herdrOf(pane('idle'), successor, bossPane) })),
  });
  assert.deepEqual(bossNotes(out), []);
  assert.deepEqual(closes(out).map(({ args }) => args), [['pane', 'close', successor.id]]);
  assert.ok(out.memory.handoverExpiryBoss['ctx-1']);
  assert.deepEqual(out.messages, []);
});

test('HO2 review: a legacy Mailbox expiry mark suppresses a duplicate Boss prompt', { timeout: 30000 }, (t) => {
  const markedAt = Date.parse(at(0));
  const out = run(t, {
    autoHandover: false,
    memory: { handoverExpiryMailbox: { 'ctx-1': markedAt, removed: markedAt } },
    handoffs: [expiredRecord()],
    steps: [{ at: at(1), herdr: herdrOf(pane('idle'), successor, bossPane) }],
  });
  assert.deepEqual(bossNotes(out), []);
  assert.deepEqual(out.memory.handoverExpiryBoss, { 'ctx-1': markedAt });
  assert.equal(out.memory.handoverExpiryMailbox, undefined);
  assert.deepEqual(closes(out).map(({ args }) => args), [['pane', 'close', successor.id]]);
});

test('HO2: expiry waits for a missing Boss and retries a failed prompt before marking it sent', { timeout: 30000 }, (t) => {
  const out = run(t, {
    autoHandover: false, handoffs: [expiredRecord({ automatic: false })],
    steps: [
      { at: at(1), herdr: herdrOf(pane('idle'), successor) },
      { at: at(5), herdr: herdrOf(pane('idle'), successor, bossPane) },
      { at: at(6), herdr: herdrOf(pane('idle'), successor, bossPane), failBossPrompt: true },
      { at: at(10), herdr: herdrOf(pane('idle'), successor, bossPane) },
      { at: at(11), herdr: herdrOf(pane('idle'), successor, bossPane) },
      { at: at(16), herdr: herdrOf(pane('idle'), successor, bossPane) },
    ],
  });
  assert.deepEqual(bossNotes(out).map(({ step }) => step), [2, 4]);
  assert.equal(Object.keys(out.snapshots[2].memory.handoverExpiryBoss || {}).length, 0);
  assert.equal(Object.keys(out.memory.handoverExpiryBoss).length, 1);
  assert.deepEqual(out.mailboxAttempts, []);
});
