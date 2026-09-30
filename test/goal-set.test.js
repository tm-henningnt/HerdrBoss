import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

// The data dir, home, and port are set before the server loads. No test touches ~/.herdr-boss.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-goal-set-'));
fs.mkdirSync(path.join(root, 'data'), { recursive: true });
fs.mkdirSync(path.join(root, 'home'), { recursive: true });
process.env.HOME = path.join(root, 'home');
process.env.HERDR_BOSS_DIR = path.join(root, 'data');
process.env.HERDR_BOSS_PORT = '0';
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const [{ goalSetText, goalShown, goalOccurrences, goalVerdict, GOAL_SET_MAX_LENGTH }, { setGoal, screenBlocker, resolveGoalTarget, GoalError }, { goalCommand, parseGoalArgs }, { createGoalApi }, { serve }, { loadConfig }] = await Promise.all([
  import('../src/goal.js'),
  import('../src/goal-set.js'),
  import('../src/goal-cli.js'),
  import('../src/goal-api.js'),
  import('../src/server.js'),
  import('../src/config.js'),
]);

const GOAL = 'Keep the build moving end to end. Work through the published plan.';
const READY = ['──────────────', '❯', '──────────────', '  ? for shortcuts'].join('\n');
const TYPED = ['──────────────', '❯ half a messa', '──────────────', '  ? for shortcuts'].join('\n');
const DIALOG = ['Do you want to proceed?', '❯ 1. Yes', '  2. No', 'Esc to cancel'].join('\n');
const SHOWN = ['  ◎ /goal active', `  Goal: ${GOAL}`, READY].join('\n');

// A fake Herdr pane. script(step) gives { status, text } for each poll. A prompt changes the pane through onPrompt.
function fakePane({ status = 'idle', text = READY, label = 'orch', agent = 'claude', workspace = 'w1', onPrompt } = {}) {
  const pane = { status, text, label, agent, workspace, prompts: [], calls: [], clock: 0 };
  pane.now = () => pane.clock;
  pane.sleep = async (ms) => { pane.clock += ms; pane.tick?.(); };
  pane.run = async (args) => {
    pane.calls.push(args.join(' '));
    if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: 'w1:p2', label: pane.label, workspace_id: pane.workspace, agent: pane.agent, agent_status: pane.status } };
    if (args[0] === 'pane' && args[1] === 'read') return { text: pane.text };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [{ pane_id: 'w1:p2', label: pane.label, workspace_id: pane.workspace, agent: pane.agent, agent_status: pane.status }, { pane_id: 'w1:p3', label: 'gs1', workspace_id: 'w1', agent: 'claude', agent_status: 'working' }] };
    if (args[0] === 'agent' && args[1] === 'prompt') { pane.prompts.push({ args, at: pane.clock, status: pane.status, text: pane.text }); onPrompt?.(pane, args[3]); return {}; }
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  return pane;
}
const opts = (pane, extra = {}) => ({ pane: 'w1:p2', kind: 'claude', goal: GOAL, run: pane.run, now: pane.now, sleep: pane.sleep, ...extra });

// ---- Text bounds.
test('goalSetText joins line breaks, refuses control characters, and bounds the length', () => {
  assert.deepEqual(goalSetText('Ship it\nnow\r\nplease'), { text: 'Ship it now please' });
  assert.match(goalSetText('bad\u0007text').error, /control characters/);
  assert.match(goalSetText('bad\u001b[31mtext').error, /control characters/);
  assert.match(goalSetText('   ').error, /empty/);
  assert.match(goalSetText('clear').error, /clear/);
  assert.match(goalSetText(42).error, /string/);
  assert.equal(goalSetText('x'.repeat(GOAL_SET_MAX_LENGTH)).text.length, 1000);
  assert.match(goalSetText('x'.repeat(GOAL_SET_MAX_LENGTH + 1)).error, /at most 1000/);
});

// ---- The pane screen.
test('screenBlocker accepts an empty prompt and names a dialog and typed input', () => {
  assert.equal(screenBlocker('claude', READY), null);
  assert.equal(screenBlocker('claude', DIALOG), 'dialog');
  assert.equal(screenBlocker('claude', TYPED), 'input');
  assert.equal(screenBlocker('claude', ''), 'dialog');
  assert.equal(screenBlocker('codex', '› \n  ? for shortcuts'), null);
  assert.equal(screenBlocker('codex', '› fix the tests please\n  ? for shortcuts'), 'input');
  assert.equal(screenBlocker('opencode', 'anything'), null);
});

// ---- setGoal with a fixture pane and a fake clock.
test('setGoal waits while the pane works and sends when it is idle', async () => {
  const pane = fakePane({ status: 'working', onPrompt: (p) => { p.text = SHOWN; } });
  pane.tick = () => { if (pane.clock >= 15000) pane.status = 'idle'; };
  const states = [];
  const result = await setGoal(opts(pane, { onState: (state) => states.push(state) }));
  assert.equal(result.outcome, 'active');
  assert.equal(result.message, 'goal set and active');
  assert.equal(pane.prompts.length, 1);
  assert.deepEqual(pane.prompts[0].args, ['agent', 'prompt', 'w1:p2', `/goal ${GOAL}`]);
  assert.equal(pane.prompts[0].status, 'idle');
  assert.ok(pane.prompts[0].at >= 15000, 'the prompt comes after the pane settled');
  assert.ok(!pane.calls.some((call) => call.includes('--wait')), 'the prompt has no --wait');
  assert.ok(states.includes('waiting') && states.includes('sending') && states.includes('verifying'));
});

test('setGoal treats a done pane as idle', async () => {
  const pane = fakePane({ status: 'done', onPrompt: (p) => { p.text = SHOWN; } });
  assert.equal((await setGoal(opts(pane))).outcome, 'active');
});

test('setGoal never sends while a dialog is on the screen, and stops after 10 minutes', async () => {
  const pane = fakePane({ text: DIALOG });
  const result = await setGoal(opts(pane));
  assert.equal(result.outcome, 'busy');
  assert.equal(result.message, 'the pane stayed busy');
  assert.equal(pane.prompts.length, 0);
  assert.ok(pane.clock >= 10 * 60 * 1000 && pane.clock < 11 * 60 * 1000, `waited ${pane.clock} ms`);
});

test('setGoal never sends while the input line holds text', async () => {
  const pane = fakePane({ text: TYPED });
  const result = await setGoal(opts(pane, { waitMs: 30000 }));
  assert.equal(result.outcome, 'busy');
  assert.match(result.reason, /input line/);
  assert.equal(pane.prompts.length, 0);
});

test('setGoal never sends into a pane that works for the whole wait', async () => {
  const pane = fakePane({ status: 'working' });
  const result = await setGoal(opts(pane, { waitMs: 60000 }));
  assert.equal(result.outcome, 'busy');
  assert.equal(pane.prompts.length, 0);
});

test('setGoal reports a pane that is gone as busy without a prompt', async () => {
  const pane = fakePane();
  pane.run = async () => { throw new Error('pane_not_found'); };
  const result = await setGoal(opts(pane));
  assert.equal(result.outcome, 'busy');
  assert.match(result.reason, /does not exist/);
});

test('setGoal verifies with the goal text on the screen and sends once', async () => {
  const pane = fakePane({ onPrompt: (p) => { p.text = SHOWN; } });
  const result = await setGoal(opts(pane));
  assert.equal(result.outcome, 'active');
  assert.equal(result.attempts, 1);
  assert.equal(goalShown(SHOWN, GOAL), true);
});

test('setGoal retries up to 3 times, waits for idle before each try, and reports sent but not shown', async () => {
  const pane = fakePane({ onPrompt: (p) => { p.status = 'working'; p.busyUntil = p.clock + 20000; } });
  pane.tick = () => { if (pane.busyUntil && pane.clock >= pane.busyUntil) { pane.status = 'idle'; pane.busyUntil = 0; } };
  const result = await setGoal(opts(pane));
  assert.equal(result.outcome, 'unverified');
  assert.equal(result.message, 'sent but not shown');
  assert.equal(pane.prompts.length, 3);
  assert.ok(pane.prompts.every((prompt) => prompt.status === 'idle'), 'each try starts on an idle pane');
});

test('setGoal succeeds on the second try', async () => {
  let sends = 0;
  const pane = fakePane({ onPrompt: (p) => { sends += 1; if (sends === 2) p.text = SHOWN; } });
  const result = await setGoal(opts(pane));
  assert.equal(result.outcome, 'active');
  assert.equal(result.attempts, 2);
});

test('setGoal gives a Codex pane the goal as plain text', async () => {
  const pane = fakePane({ agent: 'codex', text: '› \n  ? for shortcuts', onPrompt: (p, text) => { p.text = `${text}\n› \n  ? for shortcuts`; } });
  const result = await setGoal(opts(pane, { kind: 'codex' }));
  assert.equal(result.outcome, 'active');
  assert.match(pane.prompts[0].args[3], /^\[herdr-boss\] The current Owner goal is: Keep the build/);
  assert.doesNotMatch(pane.prompts[0].args[3], /^\/goal/);
});

test('setGoal refuses a bad text before any call', async () => {
  const pane = fakePane();
  await assert.rejects(setGoal(opts(pane, { goal: 'x'.repeat(1001) })), /at most 1000/);
  assert.deepEqual(pane.calls, []);
});

// ---- The target.
const control = { projects: { alpha: { slug: 'alpha', workspace: 'w1', orch: { pane: 'w1:p2' } } } };

test('a project slug resolves to the orch pane of its workspace', async () => {
  const pane = fakePane();
  assert.deepEqual(await resolveGoalTarget('alpha', { run: pane.run, control }), { pane: 'w1:p2', workspace: 'w1', kind: 'claude', slug: 'alpha' });
  await assert.rejects(resolveGoalTarget('nope', { run: pane.run, control }), /No project nope/);
});

test('a pane id is accepted only for an orchestrator pane', async () => {
  const orch = fakePane();
  assert.equal((await resolveGoalTarget('w1:p2', { run: orch.run, control })).slug, 'alpha');
  for (const label of ['gs1', 'boss', null]) {
    const other = fakePane({ label });
    await assert.rejects(resolveGoalTarget('w1:p2', { run: other.run, control }), (error) => error instanceof GoalError && error.code === 2, String(label));
  }
  const worker = fakePane({ label: 'gs1' });
  await assert.rejects(resolveGoalTarget('w1:p2', { run: worker.run, control }), /worker pane does not take a goal/);
  const boss = fakePane({ label: 'boss' });
  await assert.rejects(resolveGoalTarget('w1:p2', { run: boss.run, control }), /Boss pane/);
});

// ---- The command line.
const paneEnv = { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p9', HERDR_WORKSPACE_ID: 'w1' };
const cli = (args, { pane, env = {}, callerLabel, callerWorkspace, policy = { defaultOrchestratorGoal: GOAL }, extra = {} } = {}) => {
  const out = [];
  const sync = (command) => {
    if (command[0] === 'pane' && command[1] === 'get' && command[2] === 'w1:p9') return { pane: { pane_id: 'w1:p9', label: callerLabel ?? 'orch', workspace_id: callerWorkspace ?? 'w1' } };
    return pane.sync(command);
  };
  return goalCommand(args, { env, herdr: sync, control, policy, log: (line) => out.push(line), now: pane.now, sleep: pane.sleep, ...extra }).then((code) => ({ code, out: out.join('\n') }), (error) => ({ error }));
};
// A synchronous view of the fake pane for the CLI.
const syncPane = (pane) => {
  pane.sync = (args) => {
    pane.calls.push(args.join(' '));
    if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: 'w1:p2', label: pane.label, workspace_id: pane.workspace, agent: pane.agent, agent_status: pane.status } };
    if (args[0] === 'pane' && args[1] === 'read') return { text: pane.text };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [{ pane_id: 'w1:p2', label: pane.label, workspace_id: pane.workspace, agent: pane.agent, agent_status: pane.status }] };
    if (args[0] === 'agent' && args[1] === 'prompt') { pane.prompts.push({ args, at: pane.clock, status: pane.status }); pane.onPromptSync?.(pane, args[3]); return {}; }
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  return pane;
};

test('parseGoalArgs reads the target, --text, and --dry-run, and refuses the rest', () => {
  assert.deepEqual(parseGoalArgs(['alpha']), { target: 'alpha', text: undefined, dryRun: false });
  assert.deepEqual(parseGoalArgs(['w1:p2', '--text', 'Ship it', '--dry-run']), { target: 'w1:p2', text: 'Ship it', dryRun: true });
  for (const bad of [[], ['a', 'b'], ['a', '--text'], ['a', '--text', 'x', '--text', 'y'], ['a', '--nope'], ['a', '--dry-run', '--dry-run']]) assert.throws(() => parseGoalArgs(bad), /Usage: goal set/, bad.join(' '));
});

test('goal set exits 0 when the goal is active and uses the Settings default text', async () => {
  const pane = syncPane(fakePane());
  pane.onPromptSync = (p) => { p.text = SHOWN; };
  const result = await cli(['set', 'alpha'], { pane });
  assert.equal(result.error, undefined);
  assert.equal(result.code, 0);
  assert.match(result.out, /goal set and active/);
  assert.equal(pane.prompts[0].args[3], `/goal ${GOAL}`);
});

test('goal set --text sends the given text with line breaks as spaces', async () => {
  const pane = syncPane(fakePane());
  pane.onPromptSync = (p, text) => { p.text = `${text}\n${SHOWN}`; };
  const result = await cli(['set', 'alpha', '--text', 'First line\nSecond line'], { pane });
  assert.equal(result.code, 0);
  assert.equal(pane.prompts[0].args[3], '/goal First line Second line');
});

test('goal set --dry-run sends nothing and reports the pane state', async () => {
  const pane = syncPane(fakePane({ status: 'working' }));
  const result = await cli(['set', 'alpha', '--dry-run'], { pane });
  assert.equal(result.code, 0);
  assert.match(result.out, /Dry run: the pane cannot take the command now \(working\)\. Nothing was sent\./);
  assert.equal(pane.prompts.length, 0);
});

test('goal set exits 2 when the pane stays busy and 3 when the goal does not show', async () => {
  const busy = syncPane(fakePane({ text: DIALOG }));
  const one = await cli(['set', 'alpha'], { pane: busy, extra: { waitMs: 20000 } });
  assert.equal(one.code, 2);
  assert.match(one.out, /the pane stayed busy/);
  assert.equal(busy.prompts.length, 0);
  const silent = syncPane(fakePane());
  const two = await cli(['set', 'alpha'], { pane: silent });
  assert.equal(two.code, 3);
  assert.match(two.out, /sent but not shown/);
  assert.equal(silent.prompts.length, 3);
});

test('goal set exits 2 for a worker pane and for the Boss pane, and sends nothing', async () => {
  for (const label of ['gs1', 'boss']) {
    const pane = syncPane(fakePane({ label }));
    const result = await cli(['set', 'w1:p2'], { pane });
    assert.equal(result.code, 2, label);
    assert.equal(pane.prompts.length, 0);
  }
});

test('goal set: a plain terminal, the Boss, and the orchestrator of the project may run it; a worker and another project may not', async () => {
  const run = async (extra) => {
    const pane = syncPane(fakePane());
    pane.onPromptSync = (p) => { p.text = SHOWN; };
    return { pane, result: await cli(['set', 'alpha'], { pane, ...extra }) };
  };
  assert.equal((await run({ env: {} })).result.code, 0);
  assert.equal((await run({ env: paneEnv, callerLabel: 'boss' })).result.code, 0);
  assert.equal((await run({ env: paneEnv, callerLabel: 'orch' })).result.code, 0);
  const worker = await run({ env: paneEnv, callerLabel: 'gs1' });
  assert.match(worker.result.error.message, /Only the pane labeled boss or a pane labeled orch/);
  assert.equal(worker.pane.prompts.length, 0);
  const other = await run({ env: { ...paneEnv, HERDR_WORKSPACE_ID: 'w7' }, callerLabel: 'orch', callerWorkspace: 'w7' });
  assert.match(other.result.error.message, /only the goal of its own project/);
  assert.equal(other.pane.prompts.length, 0);
});

test('goal set refuses a bad text and an unusable default before any pane call', async () => {
  const pane = syncPane(fakePane());
  const bad = await cli(['set', 'alpha', '--text', 'x'.repeat(1001)], { pane });
  assert.match(bad.error.message, /at most 1000/);
  const none = await cli(['set', 'alpha'], { pane, policy: { defaultOrchestratorGoal: '' } });
  assert.match(none.error.message, /No --text given/);
  assert.deepEqual(pane.calls.filter((call) => !call.startsWith('pane get w1:p9')), []);
});

// ---- The handover uses the same steps.
test('the handover goal step sends and checks the goal with the shared functions of goal.js', () => {
  const engine = fs.readFileSync(new URL('../src/engine.js', import.meta.url), 'utf8');
  assert.match(engine, /import \{ goalOnScreen, sendGoalPrompt \} from '\.\/goal\.js'/);
  assert.match(engine, /sendGoalPrompt\(\{ run: herdr/);
  assert.match(engine, /goalOnScreen\(\{ run: herdr/);
  assert.doesNotMatch(engine, /`\/goal \$\{item\.goal\}`/);
});

// ---- The routes.
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(condition, what) {
  for (let i = 0; i < 500; i += 1) { if (await condition()) return; await tick(); }
  throw new Error(`Timed out: ${what}`);
}

test('the goal API returns 202 and walks through the job states', async () => {
  const pane = fakePane({ status: 'working', onPrompt: (p) => { p.text = SHOWN; } });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  pane.sleep = async () => { await gate; pane.status = 'idle'; };
  const api = createGoalApi({ run: pane.run, control: () => control, policy: () => ({ defaultOrchestratorGoal: GOAL }), now: pane.now, sleep: pane.sleep });
  const started = await api.handle('POST', '/api/goal/set', async () => ({ project: 'alpha' }));
  assert.equal(started.status, 202);
  assert.equal(started.body.url, '/api/goal/status/alpha');
  await until(async () => (await api.handle('GET', '/api/goal/status/alpha')).body.state === 'waiting', 'waiting');
  const waiting = await api.handle('GET', '/api/goal/status/alpha');
  assert.equal(waiting.status, 200);
  assert.match(waiting.body.reason, /agent works/);
  assert.equal(waiting.body.text, GOAL);
  release();
  await until(async () => (await api.handle('GET', '/api/goal/status/alpha')).body.state === 'active', 'active');
  const active = (await api.handle('GET', '/api/goal/status/alpha')).body;
  assert.ok(active.verifiedAt);
  assert.equal(pane.prompts.length, 1);
});

test('the goal API reports a failed job with the reason', async () => {
  const pane = fakePane({ text: DIALOG });
  const api = createGoalApi({ run: pane.run, control: () => control, policy: () => ({ defaultOrchestratorGoal: GOAL }), now: pane.now, sleep: pane.sleep, waitMs: 20000 });
  await api.handle('POST', '/api/goal/set', async () => ({ project: 'alpha', text: 'Ship it' }));
  await until(async () => (await api.handle('GET', '/api/goal/status/alpha')).body.state === 'failed', 'failed');
  const failed = (await api.handle('GET', '/api/goal/status/alpha')).body;
  assert.equal(failed.message, 'the pane stayed busy');
  assert.match(failed.reason, /dialog/);
  assert.equal(pane.prompts.length, 0);
});

test('the goal API refuses a bad body, an unknown project, a second job, and a third job', async () => {
  const pane = fakePane({ status: 'working' });
  const held = new Promise(() => {});
  const two = { projects: { ...control.projects, beta: { slug: 'beta', workspace: 'w1' }, gamma: { slug: 'gamma', workspace: 'w1' } } };
  const api = createGoalApi({ run: pane.run, control: () => two, policy: () => ({ defaultOrchestratorGoal: GOAL }), now: pane.now, sleep: () => held });
  const post = (body) => api.handle('POST', '/api/goal/set', async () => body);
  assert.equal((await post(null)).status, 400);
  assert.equal((await post({ project: 'Alpha Bad' })).status, 400);
  assert.equal((await post({ project: 'alpha', text: 5 })).status, 400);
  assert.equal((await post({ project: 'alpha', extra: 1 })).status, 400);
  assert.equal((await post({ project: 'alpha', text: 'bad\u0007' })).status, 400);
  assert.equal((await post({ project: 'nope' })).status, 404);
  assert.equal((await post({ project: 'alpha' })).status, 202);
  assert.equal((await post({ project: 'alpha' })).status, 409);
  assert.equal((await post({ project: 'beta' })).status, 202);
  assert.equal((await post({ project: 'gamma' })).status, 429);
  assert.equal((await api.handle('GET', '/api/goal/status/nope')).status, 404);
  assert.equal((await api.handle('PUT', '/api/goal/set', async () => ({}))).status, 405);
});

async function startServer(t, { readOnlyPreview = false, run } = {}) {
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  const createEngine = () => { const engine = new EventEmitter(); engine.state = { control }; engine.tick = async () => engine.state; engine.log = () => {}; return engine; };
  const pane = fakePane({ onPrompt: (p) => { p.text = SHOWN; } });
  const app = serve(cfg, { readOnlyPreview, createEngine, goalSet: { run: run ?? pane.run, now: pane.now, sleep: pane.sleep } });
  t.after(async () => { await app.close(); });
  await new Promise((resolve, reject) => { app.server.once('listening', resolve); app.server.once('error', reject); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const response = await fetch(`${base}${url}`, { method, headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: response.status, json, text };
  };
  return { call, pane };
}

test('the server route returns 202, gives the status url, and sends to the fixture pane only', async (t) => {
  const { call, pane } = await startServer(t);
  const response = await call('POST', '/api/goal/set', { project: 'alpha', text: GOAL });
  assert.equal(response.status, 202);
  assert.equal(response.json.url, '/api/goal/status/alpha');
  for (let i = 0; i < 200; i += 1) { const status = await call('GET', '/api/goal/status/alpha'); if (status.json?.state === 'active') break; await tick(); }
  const last = (await call('GET', '/api/goal/status/alpha')).json;
  assert.equal(last.state, 'active', JSON.stringify(last));
  assert.equal(pane.prompts.length, 1);
});

test('the server route refuses a cross-site request and a foreign origin with 403', async (t) => {
  const { call, pane } = await startServer(t);
  const cross = await call('POST', '/api/goal/set', { project: 'alpha' }, { 'sec-fetch-site': 'cross-site' });
  assert.equal(cross.status, 403);
  const origin = await call('POST', '/api/goal/set', { project: 'alpha' }, { origin: 'https://evil.example' });
  assert.equal(origin.status, 403);
  assert.equal(pane.prompts.length, 0);
});

test('the read-only preview refuses the goal routes', async (t) => {
  const { call, pane } = await startServer(t, { readOnlyPreview: true });
  assert.equal((await call('POST', '/api/goal/set', { project: 'alpha' })).status, 403);
  // The status route only reads. The preview has no job, so the page shows the button and no error.
  assert.equal((await call('GET', '/api/goal/status/never-ran')).status, 404);
  assert.equal(pane.prompts.length, 0);
});

// ---- Verification against the screen before the send.
const OLD_SCROLLBACK = `> /goal ${GOAL}\n  ◎ /goal active\n${READY}`;

test('goalVerdict: an old identical goal in the scrollback is not new', () => {
  const snapshot = { status: 'idle', blocker: null, text: OLD_SCROLLBACK };
  assert.equal(goalOccurrences(OLD_SCROLLBACK, GOAL), 1);
  assert.equal(goalVerdict({ before: OLD_SCROLLBACK, snapshot, goal: GOAL }), 'absent');
  assert.equal(goalVerdict({ before: READY, snapshot, goal: GOAL }), 'active');
});

test('setGoal does not count a stale /goal in the scrollback as active', async () => {
  const pane = fakePane({ text: OLD_SCROLLBACK });
  const result = await setGoal(opts(pane));
  assert.equal(result.outcome, 'unverified');
  assert.equal(pane.prompts.length, 3);
});

test('setGoal counts a second copy with a confirmation as active even with a stale /goal in the scrollback', async () => {
  const pane = fakePane({ text: OLD_SCROLLBACK, onPrompt: (p) => { p.text = `${OLD_SCROLLBACK}\n> /goal ${GOAL}\n  ◎ /goal active\n${READY}`; } });
  const result = await setGoal(opts(pane));
  assert.equal(result.outcome, 'active');
  assert.equal(pane.prompts.length, 1);
});

test('setGoal does not count a goal that is only typed or queued in the input line', async () => {
  const typedGoal = ['──────────────', `❯ /goal ${GOAL}`, '──────────────', '  ? for shortcuts'].join('\n');
  const busy = fakePane({ onPrompt: (p) => { p.status = 'working'; p.text = typedGoal; } });
  const a = await setGoal(opts(busy, { waitMs: 60000 }));
  assert.notEqual(a.outcome, 'active');
  assert.equal(busy.prompts.length, 1, 'no second send while the pane works and the input holds text');
  const idle = fakePane({ onPrompt: (p) => { p.text = typedGoal; } });
  const b = await setGoal(opts(idle, { waitMs: 60000 }));
  assert.notEqual(b.outcome, 'active');
  assert.equal(idle.prompts.length, 1, 'no second send into an input line that holds text');
});

test('setGoal does not call a working pane without a confirmation active', async () => {
  const pane = fakePane({ onPrompt: (p) => { p.status = 'working'; p.text = `> /goal ${GOAL}\n${READY}`; } });
  const result = await setGoal(opts(pane, { waitMs: 60000 }));
  assert.notEqual(result.outcome, 'active');
});

test('setGoal checks for a late render before each retry and never sends twice', async () => {
  const pane = fakePane({ onPrompt: (p) => { p.sentAt = p.clock; p.status = 'working'; } });
  pane.tick = () => {
    if (pane.sentAt !== undefined && pane.clock >= pane.sentAt + 11000) pane.text = SHOWN;
    if (pane.sentAt !== undefined && pane.clock >= pane.sentAt + 20000) pane.status = 'idle';
  };
  const result = await setGoal(opts(pane));
  assert.equal(result.outcome, 'active');
  assert.equal(pane.prompts.length, 1);
});

test('one deadline covers the wait and all retries', async () => {
  const pane = fakePane({ onPrompt: (p) => { p.status = 'working'; p.busyUntil = p.clock + 700000; } });
  pane.tick = () => { if (pane.busyUntil && pane.clock >= pane.busyUntil) { pane.status = 'idle'; pane.busyUntil = 0; } };
  const result = await setGoal(opts(pane, { waitMs: 10 * 60 * 1000 }));
  assert.equal(result.outcome, 'unverified');
  assert.equal(pane.prompts.length, 1);
  assert.ok(pane.clock < 10 * 60 * 1000 + 6000, `stopped at ${pane.clock} ms`);
});

// ---- Cancel.
test('an abort signal stops the wait without a send', async () => {
  const pane = fakePane({ status: 'working' });
  const controller = new AbortController();
  pane.tick = () => { if (pane.clock >= 10000) controller.abort(); };
  const result = await setGoal(opts(pane, { signal: controller.signal }));
  assert.equal(result.outcome, 'cancelled');
  assert.equal(pane.prompts.length, 0);
});

test('goal set exits with 130 when SIGINT cancels the wait', async () => {
  const pane = syncPane(fakePane({ status: 'working' }));
  const controller = new AbortController();
  pane.tick = () => { if (pane.clock >= 10000) controller.abort(); };
  const result = await cli(['set', 'alpha'], { pane, extra: { signal: controller.signal } });
  assert.equal(result.code, 130);
  assert.match(result.out, /cancelled/);
  assert.equal(pane.prompts.length, 0);
});

// ---- The API: slots, cancel, persistence, scrub.
const goalApi = (pane, extra = {}) => createGoalApi({ run: pane.run, control: () => control, policy: () => ({ defaultOrchestratorGoal: GOAL }), now: pane.now, sleep: pane.sleep, ...extra });

test('two POSTs in the same tick start one job', async () => {
  const pane = fakePane({ status: 'working' });
  const slow = pane.run;
  pane.run = async (args) => { await tick(); return slow(args); };
  const api = goalApi(pane, { sleep: () => new Promise(() => {}) });
  const post = () => api.handle('POST', '/api/goal/set', async () => ({ project: 'alpha' }));
  const [a, b] = await Promise.all([post(), post()]);
  assert.deepEqual([a.status, b.status].sort(), [202, 409]);
  assert.equal(api.stats().running, 1);
});

test('a refused target gives the slot back', async () => {
  const pane = fakePane({ label: 'gs1' });
  const api = goalApi(pane);
  const tooMany = await api.handle('POST', '/api/goal/set', async () => ({ project: 'alpha' }));
  assert.equal(tooMany.status, 409);
  assert.equal(api.stats().running, 0);
});

test('the cancel route stops a waiting job and refuses when none runs', async () => {
  const pane = fakePane({ status: 'working' });
  const api = goalApi(pane, { sleep: async (ms, signal) => { await new Promise((resolve) => { const timer = setTimeout(resolve, 5); signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }); }); } });
  assert.equal((await api.handle('POST', '/api/goal/cancel', async () => ({ project: 'alpha' }))).status, 409);
  assert.equal((await api.handle('POST', '/api/goal/cancel', async () => ({ project: 'Bad Slug' }))).status, 400);
  assert.equal((await api.handle('POST', '/api/goal/set', async () => ({ project: 'alpha' }))).status, 202);
  assert.equal((await api.handle('POST', '/api/goal/cancel', async () => ({ project: 'alpha' }))).status, 200);
  await until(async () => (await api.handle('GET', '/api/goal/status/alpha')).body.state === 'cancelled', 'cancelled');
  assert.equal(pane.prompts.length, 0);
  assert.equal((await api.handle('GET', '/api/goal/cancel', async () => ({}))).status, 405);
});

test('the server refuses cancel in the preview and a cross-site cancel', async (t) => {
  const preview = await startServer(t, { readOnlyPreview: true });
  assert.equal((await preview.call('POST', '/api/goal/cancel', { project: 'alpha' })).status, 403);
  const live = await startServer(t);
  assert.equal((await live.call('POST', '/api/goal/cancel', { project: 'alpha' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
});

test('a job file says running after a restart: the status is interrupted; the file is private and holds no pane text', async () => {
  const dir = fs.mkdtempSync(path.join(root, 'jobs-'));
  const pane = fakePane({ status: 'working', text: 'SECRET PANE TEXT' });
  const first = goalApi(pane, { dataDir: dir, sleep: () => new Promise(() => {}) });
  assert.equal((await first.handle('POST', '/api/goal/set', async () => ({ project: 'alpha', text: 'Ship it' }))).status, 202);
  await until(async () => fs.existsSync(path.join(dir, 'goal-jobs', 'alpha.json')), 'job file');
  const file = path.join(dir, 'goal-jobs', 'alpha.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /SECRET PANE TEXT/);
  const second = goalApi(fakePane(), { dataDir: dir });
  const status = await second.handle('GET', '/api/goal/status/alpha');
  assert.equal(status.status, 200);
  assert.equal(status.body.state, 'interrupted');
  assert.equal((await second.handle('GET', '/api/goal/status/beta')).status, 404);
});

test('a reason and a route error have no absolute path and at most 200 characters', async () => {
  const pane = fakePane();
  const base = pane.run;
  pane.run = async (args) => {
    if (args[1] === 'prompt') throw Object.assign(new Error('x'), { stderr: `failed at /Users/someone/private/dir/file.txt ${'y'.repeat(400)}` });
    return base(args);
  };
  const api = goalApi(pane);
  await api.handle('POST', '/api/goal/set', async () => ({ project: 'alpha' }));
  await until(async () => (await api.handle('GET', '/api/goal/status/alpha')).body.state === 'failed', 'failed');
  const failed = (await api.handle('GET', '/api/goal/status/alpha')).body;
  assert.doesNotMatch(failed.reason, /\/Users\/someone/);
  assert.ok(failed.reason.length <= 200);
  const bad = await api.handle('POST', '/api/goal/set', async () => { throw Object.assign(new Error('bad at /Users/someone/private/x'), { statusCode: 400 }); });
  assert.doesNotMatch(bad.body.error, /\/Users\/someone/);
});
