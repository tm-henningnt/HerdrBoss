import './helpers/test-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { successorPrompt } from '../src/handoff.js';
import { POLICY_DEFAULTS, validatePolicy } from '../src/control.js';
import { loadModels } from '../src/kit/config.js';
import { cleanGoal, goalFromTranscript, goalShown, goalTextError, GOAL_MAX_LENGTH } from '../src/goal.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;

const claudeGoal = (args) => ({ type: 'user', message: { role: 'user', content: `<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>${args}</command-args>` } });

function claudeTranscript(home, cwd, sessionId, rows) {
  const dir = path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), typeof rows === 'string' ? rows : jsonl(rows));
}

test('cleanGoal strips control characters, joins lines, and caps the length', () => {
  assert.equal(cleanGoal('  Keep the\tbuild\r\nmoving\u0007 now  '), 'Keep the build moving now');
  assert.equal(cleanGoal('x'.repeat(GOAL_MAX_LENGTH + 500)).length, GOAL_MAX_LENGTH);
  assert.equal(cleanGoal('   '), null);
  assert.equal(cleanGoal('clear'), null);
  assert.equal(cleanGoal(42), null);
});

test('goalFromTranscript returns the last /goal command of a Claude session', (t) => {
  const home = tmp(t, 'herdr-h2-claude-');
  claudeTranscript(home, '/work/alpha', 'sess-1', [
    claudeGoal('first goal'),
    { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
    claudeGoal('second goal\u0001 with control'),
    { type: 'user', message: { content: 'plain question' } },
  ]);
  assert.equal(goalFromTranscript({ kind: 'claude', sessionId: 'sess-1', cwd: '/work/alpha', home }), 'second goal with control');
});

test('goalFromTranscript returns null after /goal clear and for a missing session', (t) => {
  const home = tmp(t, 'herdr-h2-clear-');
  claudeTranscript(home, '/work/alpha', 'sess-1', [claudeGoal('old goal'), claudeGoal('clear')]);
  assert.equal(goalFromTranscript({ kind: 'claude', sessionId: 'sess-1', cwd: '/work/alpha', home }), null);
  assert.equal(goalFromTranscript({ kind: 'claude', sessionId: 'nope', cwd: '/work/alpha', home }), null);
  assert.equal(goalFromTranscript({ kind: 'claude', sessionId: null, home }), null);
});

test('goalFromTranscript reads only the tail of a long transcript and caps the text', (t) => {
  const home = tmp(t, 'herdr-h2-tail-');
  const filler = { type: 'assistant', message: { content: [{ type: 'text', text: 'y'.repeat(1000) }] } };
  const early = claudeGoal('early goal');
  const rows = [early, ...Array.from({ length: 1500 }, () => filler)];
  claudeTranscript(home, '/work/alpha', 'sess-1', rows);
  assert.equal(goalFromTranscript({ kind: 'claude', sessionId: 'sess-1', cwd: '/work/alpha', home }), null, 'a goal beyond the tail is not read');
  claudeTranscript(home, '/work/alpha', 'sess-2', [...rows, claudeGoal('z'.repeat(GOAL_MAX_LENGTH + 100))]);
  assert.equal(goalFromTranscript({ kind: 'claude', sessionId: 'sess-2', cwd: '/work/alpha', home }).length, GOAL_MAX_LENGTH);
});

test('goalFromTranscript reads a /goal command from a Codex session', (t) => {
  const home = tmp(t, 'herdr-h2-codex-');
  const dir = path.join(home, '.codex', 'sessions', '2026', '09', '29');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rollout-2026-09-29T10-00-00-sess-c1.jsonl'), jsonl([
    { type: 'event_msg', payload: { type: 'user_message', message: '/goal old codex goal' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'working' }] } },
    { type: 'event_msg', payload: { type: 'user_message', message: '/goal Ship the codex goal' } },
  ]));
  assert.equal(goalFromTranscript({ kind: 'codex', sessionId: 'sess-c1', home }), 'Ship the codex goal');
});

test('goalShown compares the start of the goal without whitespace', () => {
  const goal = 'Keep the build moving end to end and start the next ready task as soon as a slot is free.';
  assert.equal(goalShown('> /goal Keep the build moving end to\n  end and start the next ready task as soon as a slot', goal), true);
  assert.equal(goalShown('nothing here', goal), false);
  assert.equal(goalShown('', goal), false);
  assert.equal(goalShown('anything', ''), false);
});

test('the default orchestrator goal is the Boss default text', () => {
  assert.equal(typeof POLICY_DEFAULTS.defaultOrchestratorGoal, 'string');
  assert.match(POLICY_DEFAULTS.defaultOrchestratorGoal, /^Keep the build moving end to end\./);
  assert.equal(goalTextError(POLICY_DEFAULTS.defaultOrchestratorGoal), null);
});

test('Settings save validation: the goal text has a length cap and no control characters', () => {
  const models = loadModels();
  const check = (text) => validatePolicy({ ...structuredClone(POLICY_DEFAULTS), defaultOrchestratorGoal: text }, models);
  const errorsOf = (result) => (Array.isArray(result) ? result : result?.errors || []).filter((message) => /defaultOrchestratorGoal/.test(message));
  assert.deepEqual(errorsOf(check('A short goal.')), []);
  assert.deepEqual(errorsOf(check('')), []);
  assert.equal(errorsOf(check('x'.repeat(GOAL_MAX_LENGTH))).length, 0);
  assert.equal(errorsOf(check('x'.repeat(GOAL_MAX_LENGTH + 1))).length, 1);
  assert.equal(errorsOf(check('line one\nline two')).length, 1);
  assert.equal(errorsOf(check('bell\u0007')).length, 1);
  assert.equal(errorsOf(check(7)).length, 1);
});

// The capture runs in a child process, so that HOME and HERDR_BOSS_DIR point at temporary folders.
function capture(t, { home = tmp(t, 'herdr-h2-capture-'), item, statusGoal, policy }) {
  const script = `import { captureGoal } from './src/handoff.js';
const input = JSON.parse(process.env.H2_INPUT);
console.log(JSON.stringify(captureGoal(input.item, input.statusGoal, input.policy)));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repo, encoding: 'utf8',
    env: { ...process.env, HOME: home, HERDR_BOSS_DIR: home, H2_INPUT: JSON.stringify({ item, statusGoal, policy }) },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('capture prefers the published status goal', (t) => {
  const home = tmp(t, 'herdr-h2-status-');
  claudeTranscript(home, '/work/alpha', 'sess-1', [claudeGoal('transcript goal')]);
  const item = { fromKind: 'claude', sessionId: 'sess-1', cwd: '/work/alpha', label: 'orch' };
  assert.deepEqual(capture(t, { home, item, statusGoal: 'Status goal', policy: { defaultOrchestratorGoal: 'Default goal' } }), { goal: 'Status goal', goalSource: 'status' });
});

test('capture falls back to the source transcript when the status has no goal', (t) => {
  const home = tmp(t, 'herdr-h2-fallback-');
  claudeTranscript(home, '/work/alpha', 'sess-1', [claudeGoal('transcript goal')]);
  const item = { fromKind: 'claude', sessionId: 'sess-1', cwd: '/work/alpha', label: 'orch' };
  assert.deepEqual(capture(t, { home, item, policy: { defaultOrchestratorGoal: 'Default goal' } }), { goal: 'transcript goal', goalSource: 'transcript' });
});

test('capture uses the default goal for an orchestrator with no goal, and none for the Boss', (t) => {
  const item = { fromKind: 'codex', sessionId: null, cwd: '/work/alpha', label: 'orch' };
  const policy = { defaultOrchestratorGoal: 'Default goal' };
  assert.deepEqual(capture(t, { item, policy }), { goal: 'Default goal', goalSource: 'default' });
  assert.deepEqual(capture(t, { item: { ...item, label: 'boss' }, policy }), {});
  assert.deepEqual(capture(t, { item, policy: { defaultOrchestratorGoal: '' } }), {});
});

// ---- Send /goal once after the successor confirms it works.
const probe = `
import { Engine } from './src/engine.js';
import { loadConfig } from './src/config.js';
const input = JSON.parse(process.env.H2_SCENARIO);
let now = Date.parse('2026-09-29T12:00:00.000Z');
Date.now = () => now;
const herdrCalls = [];
let reads = 0;
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
    herdrCalls.push({ args });
    if (args[0] === 'pane' && args[1] === 'read') { const texts = input.paneTexts || ['']; return texts[Math.min(reads++, texts.length - 1)]; }
    if (args[0] === 'agent' && args[1] === 'prompt' && input.promptFails) { process.stdout.write(''); throw new Error('prompt failed'); }
    return '{}';
  },
  handoffRunner: async () => JSON.stringify({ ok: true }),
});
engine.deliver = async () => {};
for (const step of input.steps) { now = Date.parse(step.at); herdr = step.herdr; await engine.tick(); }
console.log(JSON.stringify({ herdrCalls, events: engine.events }));
`;

const GOAL = 'Keep the build moving end to end. Work through the published plan in priority order.';
const at = (minute) => `2026-09-29T12:${String(minute).padStart(2, '0')}:00.000Z`;
const oldPane = (status) => ({ id: 'w-alpha:p1', workspace: 'w-alpha', label: 'orch previous', orch: false, agent: 'claude', status, sessionId: 'sess-1', cwd: '/work/alpha' });
const newPane = (status) => ({ id: 'w-alpha:p9', workspace: 'w-alpha', tab: 'w-alpha:t9', label: 'orch', orch: true, agent: 'claude', status, sessionId: 'sess-2', cwd: '/work/alpha' });
const herdrOf = (...panes) => ({ workspaces: [{ id: 'w-alpha', label: 'Alpha' }], panes });
const activeRecord = (extra = {}) => ({
  id: 'act-1', project: 'alpha', workspace: 'w-alpha', label: 'orch', sourcePane: 'w-alpha:p1', newPane: 'w-alpha:p9', newTab: 'w-alpha:t9',
  fromKind: 'claude', toKind: 'claude', model: 'claude-sonnet-5-5', status: 'active', automatic: true,
  activatedAt: '2026-09-29T11:59:30.000Z', previousPromptAt: '2026-09-29T11:59:31.000Z',
  activation: { at: '2026-09-29T11:59:30.000Z', sourcePane: 'w-alpha:p1', successorPane: 'w-alpha:p9', sourceLabel: 'orch previous', successorLabel: 'orch' },
  finish: {}, goal: GOAL, goalSource: 'status', goalDelivery: 'command',
  ...extra,
});

function run(t, scenario) {
  const dir = tmp(t, 'herdr-h2-engine-');
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(structuredClone(POLICY_DEFAULTS)));
  fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify({ paneSince: {}, pushes: {}, notified: {} }));
  fs.writeFileSync(path.join(dir, 'handoffs.json'), JSON.stringify(scenario.handoffs));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: repo, encoding: 'utf8',
    env: { ...process.env, HOME: dir, HERDR_BOSS_DIR: dir, HERDR_BOSS_LIVE_DIR: dir, HERDR_BOSS_ALLOW_ACTIONS: '1', NODE_TEST_CONTEXT: '',
      H2_SCENARIO: JSON.stringify({ steps: scenario.steps, paneTexts: scenario.paneTexts, promptFails: scenario.promptFails }) },
  });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout.trim());
  out.records = JSON.parse(fs.readFileSync(path.join(dir, 'handoffs.json'), 'utf8'));
  return out;
}

const goalPrompts = (out) => out.herdrCalls.filter(({ args }) => args[0] === 'agent' && args[1] === 'prompt' && String(args[3]).startsWith('/goal'));
const paneReads = (out) => out.herdrCalls.filter(({ args }) => args[0] === 'pane' && args[1] === 'read');
const answered = [
  { at: at(0), herdr: herdrOf(oldPane('idle'), newPane('idle')) },
  { at: at(1), herdr: herdrOf(oldPane('idle'), newPane('working')) },
  { at: at(2), herdr: herdrOf(oldPane('idle'), newPane('idle')) },
  { at: at(3), herdr: herdrOf(oldPane('idle'), newPane('idle')) },
  { at: at(4), herdr: herdrOf(oldPane('idle'), newPane('idle')) },
];

test('the engine sends /goal to the successor once, after the successor confirms it works', { timeout: 30000 }, (t) => {
  const out = run(t, { handoffs: [activeRecord()], paneTexts: [`> /goal ${GOAL}`], steps: answered });
  const prompts = goalPrompts(out);
  assert.equal(prompts.length, 1);
  assert.deepEqual(prompts[0].args, ['agent', 'prompt', 'w-alpha:p9', `/goal ${GOAL}`]);
  const promptIndex = out.herdrCalls.indexOf(prompts[0]);
  assert.ok(out.herdrCalls.slice(0, promptIndex).every(({ args }) => args[1] !== 'close'), 'the old pane is still open when the goal is sent');
  assert.ok(out.records[0].goalSentAt);
  assert.ok(out.records[0].goalVerifiedAt);
  assert.equal(out.records[0].finish.confirmedBy, 'answered');
});

test('the engine sends nothing before the successor answers', { timeout: 30000 }, (t) => {
  const out = run(t, { handoffs: [activeRecord()], paneTexts: [GOAL], steps: answered.slice(0, 1) });
  assert.deepEqual(goalPrompts(out), []);
  assert.equal(out.records[0].goalSentAt, undefined);
});

test('the engine does not send /goal again when goalSentAt is set', { timeout: 30000 }, (t) => {
  const out = run(t, { handoffs: [activeRecord({ goalSentAt: '2026-09-29T11:59:50.000Z', goalVerifiedAt: '2026-09-29T11:59:51.000Z' })], steps: answered });
  assert.deepEqual(goalPrompts(out), []);
});

test('the engine reads the pane again when the goal does not show, then logs and never sends twice', { timeout: 30000 }, (t) => {
  const retried = run(t, { handoffs: [activeRecord()], paneTexts: ['a prompt with no goal', `> /goal ${GOAL}`], steps: answered });
  assert.equal(goalPrompts(retried).length, 1);
  assert.equal(paneReads(retried).length, 2);
  assert.ok(retried.records[0].goalVerifiedAt);

  const failed = run(t, { handoffs: [activeRecord()], paneTexts: ['a prompt with no goal'], steps: answered });
  assert.equal(goalPrompts(failed).length, 1);
  assert.equal(paneReads(failed).length, 3);
  assert.ok(failed.events.some((event) => event.type === 'handoff' && /not confirmed yet/.test(event.text)));
  assert.equal(failed.records[0].goalVerifiedAt, undefined);
  assert.ok(failed.records[0].goalVerifyFailedAt);
  assert.ok(failed.events.some((event) => event.type === 'error' && /Goal for handoff act-1/.test(event.text)));
});

test('the engine sends no /goal command for a record without a goal or with prompt delivery', { timeout: 30000 }, (t) => {
  const none = run(t, { handoffs: [activeRecord({ goal: undefined, goalSource: undefined, goalDelivery: undefined })], steps: answered });
  assert.deepEqual(goalPrompts(none), []);
  const inPrompt = run(t, { handoffs: [activeRecord({ toKind: 'codex', goalDelivery: 'prompt', goalSentAt: '2026-09-29T11:59:31.000Z' })], steps: answered });
  assert.deepEqual(goalPrompts(inPrompt), []);
});

// ---- The activation prompt and the dashboard.
const activated = (extra = {}) => ({ project: 'alpha', newPane: 'w:p9', sourcePane: 'w:p1', fromKind: 'claude', toKind: 'claude', model: 'm',
  activation: { successorLabel: 'orch', sourceLabel: 'orch previous' }, goal: GOAL, goalSource: 'status', ...extra });

test('the activation prompt carries the goal only when the harness gets no /goal command', () => {
  assert.doesNotMatch(successorPrompt(activated({ goalDelivery: 'command' })), /Owner goal/);
  assert.match(successorPrompt(activated({ toKind: 'codex', goalDelivery: 'prompt' })), new RegExp(`The current Owner goal is: ${GOAL}`));
  assert.doesNotMatch(successorPrompt(activated({ goal: undefined })), /Owner goal/);
});

test('the dashboard shows a goal as one collapsed line and escapes it', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function goalField(');
  const context = { esc: (value) => String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]) };
  vm.runInNewContext(`${source.slice(start, source.indexOf('\n}\n', start) + 2)}\nthis.fn = goalField;`, context);
  const html = context.fn('Goal', 'Ship <b>it</b>', 'published status');
  assert.match(html, /^<details class="goal-field"><summary><b>Goal<\/b><span class="goal-line">Ship &lt;b&gt;it&lt;\/b&gt;<\/span><\/summary>/);
  assert.match(html, /Source: published status/);
  assert.equal(context.fn('Goal', '  '), '');
  assert.equal(context.fn('Goal', undefined), '');
});

test('a bare /goal is skipped and /goal clear still ends the scan', (t) => {
  const home = tmp(t, 'herdr-h2-bare-');
  claudeTranscript(home, '/work/alpha', 'sess-1', [claudeGoal('real goal'), claudeGoal(''), { type: 'user', message: { content: '/goal' } }]);
  assert.equal(goalFromTranscript({ kind: 'claude', sessionId: 'sess-1', cwd: '/work/alpha', home }), 'real goal');
  claudeTranscript(home, '/work/alpha', 'sess-2', [claudeGoal('real goal'), claudeGoal('clear'), claudeGoal('')]);
  assert.equal(goalFromTranscript({ kind: 'claude', sessionId: 'sess-2', cwd: '/work/alpha', home }), null);
});

test('pasted command text inside a message body is not a /goal command', (t) => {
  const home = tmp(t, 'herdr-h2-pasted-');
  claudeTranscript(home, '/work/alpha', 'sess-1', [
    claudeGoal('real goal'),
    { type: 'user', message: { content: 'Look at this log:\n<command-name>/goal</command-name><command-args>pasted goal</command-args>' } },
    { type: 'user', message: { content: 'Please run /goal pasted plain' } },
  ]);
  assert.equal(goalFromTranscript({ kind: 'claude', sessionId: 'sess-1', cwd: '/work/alpha', home }), 'real goal');
});

test('a Boss record captures no goal and its activation prompt carries none', (t) => {
  const home = tmp(t, 'herdr-h2-boss-');
  claudeTranscript(home, '/work/alpha', 'sess-1', [claudeGoal('transcript goal')]);
  const item = { fromKind: 'claude', sessionId: 'sess-1', cwd: '/work/alpha', label: 'boss', boss: true };
  assert.deepEqual(capture(t, { home, item, statusGoal: 'Status goal', policy: { defaultOrchestratorGoal: 'Default goal' } }), {});
  assert.doesNotMatch(successorPrompt(activated({ label: 'boss', boss: true, toKind: 'codex', goalDelivery: 'prompt' })), /Owner goal/);
});
