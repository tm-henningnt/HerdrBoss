import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-goal-blocker-'));
fs.mkdirSync(path.join(root, 'home'), { recursive: true });
process.env.HOME = path.join(root, 'home');
process.env.HERDR_BOSS_DIR = path.join(root, 'data');
process.env.HERDR_BOSS_PORT = '0';
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const [{ setGoal, screenBlocker, paneBlocker, hasTypedText, blockerText }, { goalCommand }, { createGoalApi }, { readMessages }, { POLICY_DEFAULTS }] = await Promise.all([
  import('../src/goal-set.js'),
  import('../src/goal-cli.js'),
  import('../src/goal-api.js'),
  import('../src/messages.js'),
  import('../src/control.js'),
]);

const GOAL = 'Keep the build moving end to end. Work through the published plan.';
const DRAFT = 'zebra-marmalade draft words';
const GHOST = 'ghost suggestion text';
const ESC = '\x1b';
const RULE = '──────────────';
const FOOT = '  ? for shortcuts';
const screen = (inputLine) => [RULE, inputLine, RULE, FOOT].join('\n');
const READY = screen('❯');
const TYPED_PLAIN = screen(`❯ ${DRAFT}`);
const TYPED_ANSI = screen(`❯ ${ESC}[0m${DRAFT}`);
const GHOST_ANSI = screen(`❯ ${ESC}[0m${ESC}[2m${GHOST}${ESC}[0m`);
const GHOST_GRAY = screen(`❯ ${ESC}[90m${GHOST}${ESC}[39m`);
const GHOST_256 = screen(`❯ ${ESC}[38;5;244m${GHOST}${ESC}[39m`);
const GHOST_RGB = screen(`❯ ${ESC}[38;2;136;136;136m${GHOST}${ESC}[0m`);
const MIXED = screen(`❯ ${ESC}[0m${DRAFT} ${ESC}[2m${GHOST}${ESC}[0m`);
const BOLD_DIM = screen(`❯ ${ESC}[1m${ESC}[2m${GHOST}${ESC}[0m`);
const UNKNOWN = screen(`❯ ${ESC}[38;5;99m${GHOST}${ESC}[0m`);
const DIALOG = ['Do you want to proceed?', '❯ 1. Yes', '  2. No', 'Esc to cancel'].join('\n');
const SHOWN = ['  ◎ /goal active', `  Goal: ${GOAL}`, READY].join('\n');
const T0 = Date.now();

function fakePane({ status = 'idle', text = READY, label = 'orch', agent = 'claude' } = {}) {
  const pane = { status, text, label, agent, prompts: [], calls: [], clock: 0 };
  pane.now = () => pane.clock;
  pane.sleep = async (ms) => { pane.clock += ms; pane.tick?.(); };
  const handle = (args) => {
    pane.calls.push(args.join(' '));
    if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: 'w1:p2', label: pane.label, workspace_id: 'w1', agent: pane.agent, agent_status: pane.status } };
    if (args[0] === 'pane' && args[1] === 'read') return { text: pane.text };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [{ pane_id: 'w1:p2', label: pane.label, workspace_id: 'w1', agent: pane.agent, agent_status: pane.status }] };
    if (args[0] === 'agent' && args[1] === 'prompt') { pane.prompts.push(args); pane.onPrompt?.(pane, args[3]); return {}; }
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  pane.run = async (args) => handle(args);
  pane.sync = handle;
  return pane;
}
const control = { projects: { alpha: { slug: 'alpha', workspace: 'w1' } } };
const mailDir = () => fs.mkdtempSync(path.join(root, 'mail-'));
const cli = (args, pane, dir, extra = {}) => {
  const out = [];
  return goalCommand(args, { env: {}, herdr: pane.sync, control, policy: { defaultOrchestratorGoal: GOAL }, log: (line) => out.push(line), now: pane.now, sleep: pane.sleep, dataDir: dir, mailNow: () => T0 + pane.clock, ...extra })
    .then((code) => ({ code, out: out.join('\n') }));
};
const items = (dir) => readMessages({ dir });

// ---- Ghost suggestion and typed text.
test('a dim or gray suggestion counts as an empty input box; typed, mixed, bold, and unknown styles count as typed', () => {
  assert.equal(screenBlocker('claude', GHOST_ANSI), null);
  assert.equal(screenBlocker('claude', screen(`❯ ${ESC}[2m${GHOST}${ESC}[22m`)), null);
  for (const typed of [TYPED_PLAIN, TYPED_ANSI, MIXED, BOLD_DIM, UNKNOWN, GHOST_GRAY, GHOST_256, GHOST_RGB]) assert.equal(screenBlocker('claude', typed), 'input');
  assert.equal(screenBlocker('claude', READY), null);
  assert.equal(hasTypedText(`❯ ${ESC}[2m${GHOST}${ESC}[0m`), false);
  assert.equal(hasTypedText(`❯ ${DRAFT}`), true);
});

test('an old prompt line in the history does not block an empty input box, and a draft below it does', () => {
  const history = ['❯ an earlier message', '● done', READY].join('\n');
  assert.equal(screenBlocker('claude', history), null);
  const draft = ['❯ an earlier message', '● done', TYPED_PLAIN].join('\n');
  assert.equal(screenBlocker('claude', draft), 'input');
});

test('setGoal sends the goal over a ghost suggestion and still needs the goal text new on the screen', async () => {
  const pane = fakePane({ text: GHOST_ANSI });
  pane.onPrompt = (p) => { p.text = SHOWN; };
  const result = await setGoal({ pane: 'w1:p2', kind: 'claude', goal: GOAL, run: pane.run, now: pane.now, sleep: pane.sleep });
  assert.equal(result.outcome, 'active');
  assert.deepEqual(pane.prompts, [['agent', 'prompt', 'w1:p2', `/goal ${GOAL}`]]);
  const silent = fakePane({ text: GHOST_ANSI });
  const none = await setGoal({ pane: 'w1:p2', kind: 'claude', goal: GOAL, run: silent.run, now: silent.now, sleep: silent.sleep });
  assert.equal(none.outcome, 'unverified');
  assert.equal(silent.prompts.length, 3);
});

test('the pane read asks for the styled format', async () => {
  const pane = fakePane();
  await paneBlocker({ run: pane.run, pane: 'w1:p2', kind: 'claude' });
  assert.ok(pane.calls.some((call) => call.startsWith('pane read w1:p2') && call.endsWith('--format ansi')));
});

test('goal set --dry-run says the pane can take the command over a ghost suggestion', async () => {
  const pane = fakePane({ text: GHOST_ANSI });
  const result = await cli(['set', 'alpha', '--dry-run'], pane, mailDir());
  assert.match(result.out, /Dry run: the pane can take the command now\. Nothing was sent\./);
  assert.doesNotMatch(result.out, new RegExp(GHOST));
});

test('fail safe: a style before the marker, another gray, colon forms, reverse, and extended color parameters count as typed', () => {
  const typed = (line) => assert.equal(screenBlocker('claude', screen(line)), 'input', JSON.stringify(line));
  typed(`${ESC}[2m❯ ${ESC}[37m${DRAFT}${ESC}[0m`);
  typed(`${ESC}[2m❯ ${DRAFT}`);
  typed(`❯ ${ESC}[2m${ESC}[38;5;250m${DRAFT}${ESC}[0m`);
  typed(`❯ ${ESC}[2:1m${DRAFT}${ESC}[0m`);
  typed(`❯ ${ESC}[38:2::136:136:136m${DRAFT}${ESC}[0m`);
  typed(`❯ ${ESC}[7m${DRAFT.slice(0, 1)}${ESC}[0m${ESC}[2m${DRAFT.slice(1)}${ESC}[0m`);
  typed(`❯ ${ESC}[2m${GHOST}${ESC}[0m${DRAFT}`);
  typed(`❯ ${ESC}[2m${ESC}[38;9m${DRAFT}${ESC}[0m`);
  // The parameters 2 and 5 of an extended color do not set dim.
  typed(`❯ ${ESC}[58;2;1;2;3m${DRAFT}${ESC}[0m`);
  typed(`❯ ${ESC}[48;5;2m${DRAFT}${ESC}[0m`);
  typed(`❯ ${ESC}[38;2;2;2;2m${DRAFT}${ESC}[0m`);
  // A dim ghost with a background color is still a ghost.
  assert.equal(screenBlocker('claude', screen(`❯ ${ESC}[2m${ESC}[48;5;2m${GHOST}${ESC}[0m`)), null);
});

// ---- A draft blocks, with one reason everywhere.
test('an idle agent with a draft gives the same reason in the wait message and the dry run, then fails after 2 minutes with one Mailbox item', async () => {
  const dir = mailDir();
  const pane = fakePane({ text: TYPED_ANSI });
  const dry = await cli(['set', 'alpha', '--dry-run'], pane, dir);
  assert.match(dry.out, /cannot take the command now: the input box holds unsent text\./);
  const before = pane.text;
  const wait = await cli(['set', 'alpha'], pane, dir);
  assert.equal(wait.code, 2);
  assert.match(wait.out, /Waiting for an idle pane: the input box holds unsent text/);
  assert.match(wait.out, /the pane stayed busy \(the input box holds unsent text\)/);
  assert.ok(pane.clock >= 2 * 60 * 1000 && pane.clock < 2.5 * 60 * 1000, `waited ${pane.clock} ms`);
  assert.equal(pane.prompts.length, 0);
  assert.ok(pane.calls.every((call) => /^pane (get|read|list)/.test(call)), 'the command only reads the pane');
  assert.equal(pane.text, before);
  const mail = items(dir);
  assert.equal(mail.length, 1);
  assert.equal(mail[0].action, 'answer');
  assert.equal(mail[0].thread, 'alpha');
  assert.equal(mail[0].text, 'Goal not set on alpha: the input box of pane w1:p2 holds unsent text. Send or clear it, then press Set goal again.');
  for (const output of [dry.out, wait.out, JSON.stringify(mail)]) assert.doesNotMatch(output, new RegExp(DRAFT));
});

test('the Mailbox item is not repeated within an hour and is posted again after it', async () => {
  const dir = mailDir();
  const pane = fakePane({ text: TYPED_ANSI });
  await cli(['set', 'alpha'], pane, dir);
  await cli(['set', 'alpha'], pane, dir);
  assert.equal(items(dir).length, 1);
  pane.clock += 61 * 60 * 1000;
  await cli(['set', 'alpha'], pane, dir);
  assert.equal(items(dir).length, 2);
});

test('a dialog fails after 2 minutes with one item, and another reason gets its own item', async () => {
  const dir = mailDir();
  const pane = fakePane({ text: DIALOG });
  const result = await cli(['set', 'alpha'], pane, dir);
  assert.equal(result.code, 2);
  assert.match(result.out, /a dialog is on screen/);
  assert.ok(pane.clock >= 2 * 60 * 1000 && pane.clock < 2.5 * 60 * 1000);
  assert.equal(pane.prompts.length, 0);
  assert.equal(items(dir).length, 1);
  assert.match(items(dir)[0].text, /^Goal not set on alpha: a dialog is on screen in pane w1:p2\./);
  pane.text = TYPED_ANSI;
  await cli(['set', 'alpha'], pane, dir);
  assert.equal(items(dir).length, 2);
});

test('a working agent fails after 10 minutes with the working reason', async () => {
  const dir = mailDir();
  const pane = fakePane({ status: 'working' });
  const result = await cli(['set', 'alpha'], pane, dir);
  assert.equal(result.code, 2);
  assert.match(result.out, /the pane stayed busy \(the agent works\)/);
  assert.ok(pane.clock >= 10 * 60 * 1000 && pane.clock < 10.5 * 60 * 1000, `waited ${pane.clock} ms`);
  assert.equal(pane.prompts.length, 0);
  assert.equal(items(dir).length, 1);
  assert.match(items(dir)[0].text, /the agent of pane w1:p2 kept working/);
});

test('a pane that is gone or not an orchestrator fails at once without an item', async () => {
  const gone = fakePane();
  gone.run = async () => { throw new Error('pane_not_found'); };
  const one = await setGoal({ pane: 'w1:p2', kind: 'claude', goal: GOAL, run: gone.run, now: gone.now, sleep: gone.sleep, notify: () => assert.fail('no item') });
  assert.equal(one.outcome, 'busy');
  assert.equal(one.reason, 'the pane is gone');
  const other = fakePane({ label: 'gs1' });
  const two = await setGoal({ pane: 'w1:p2', kind: 'claude', goal: GOAL, run: other.run, now: other.now, sleep: other.sleep, notify: () => assert.fail('no item') });
  assert.equal(two.reason, 'the pane is not an orchestrator');
  assert.equal(other.clock, 0);
  assert.equal(blockerText('input'), 'the input box holds unsent text');
});

test('the page status shows the current reason live, never the draft', async () => {
  const dir = mailDir();
  const pane = fakePane({ status: 'working' });
  pane.tick = () => { if (pane.clock === 15000) { pane.status = 'idle'; pane.text = TYPED_ANSI; } };
  const original = pane.sleep;
  let api2;
  pane.sleep = async (ms, signal) => { const job = await api2.handle('GET', '/api/goal/status/alpha'); seen.push(job.body?.reason); await original(ms, signal); };
  const seen = [];
  api2 = createGoalApi({ run: pane.run, control: () => control, policy: () => ({ defaultOrchestratorGoal: GOAL }), now: pane.now, sleep: pane.sleep, dataDir: dir, mailNow: () => T0 + pane.clock });
  await api2.handle('POST', '/api/goal/set', async () => ({ project: 'alpha' }));
  for (let i = 0; i < 2000; i += 1) { const body = (await api2.handle('GET', '/api/goal/status/alpha')).body; if (body.state === 'failed') break; await new Promise((resolve) => setImmediate(resolve)); }
  const failed = (await api2.handle('GET', '/api/goal/status/alpha')).body;
  assert.equal(failed.state, 'failed');
  assert.ok(seen.includes('the agent works') && seen.includes('the input box holds unsent text'), `reasons ${seen}`);
  assert.match(failed.reason, /input box holds unsent text/);
  assert.equal(pane.prompts.length, 0);
  assert.equal(items(dir).length, 1);
  const saved = fs.readdirSync(path.join(dir, 'goal-jobs')).map((name) => fs.readFileSync(path.join(dir, 'goal-jobs', name), 'utf8')).join('');
  for (const output of [JSON.stringify(failed), saved, JSON.stringify(items(dir))]) assert.doesNotMatch(output, new RegExp(DRAFT));
});

// ---- The default goal text.
const SENTENCE = 'A running worker, a gate, a push or a lock wait is progress: dispatch, end the turn, wait for the report, and treat the goal as met for that turn.';

test('the default goal ends with the progress sentence and goal set accepts it', async () => {
  assert.ok(POLICY_DEFAULTS.defaultOrchestratorGoal.endsWith(SENTENCE));
  const pane = fakePane();
  pane.onPrompt = (p, text) => { p.text = `${text}\n${READY}`; };
  const result = await cli(['set', 'alpha'], pane, mailDir(), { policy: { defaultOrchestratorGoal: POLICY_DEFAULTS.defaultOrchestratorGoal } });
  assert.equal(result.code, 0);
  assert.equal(pane.prompts[0][3], `/goal ${POLICY_DEFAULTS.defaultOrchestratorGoal}`);
});
