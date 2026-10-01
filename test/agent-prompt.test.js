import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function fixture(t, mode, kind = 'codex', text = 'Read the task.\nRun its checks.', target = 'demo') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-prompt-'));
  let watchdogExpired = false;
  t.after(() => {
    const pid = JSON.parse(fs.readFileSync(state, 'utf8')).promptPid;
    if (pid && watchdogExpired) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const bin = path.join(root, 'bin');
  const dir = path.join(root, 'data');
  const home = path.join(root, 'home');
  for (const folder of [bin, dir, home]) fs.mkdirSync(folder);
  const state = path.join(root, 'pane.json');
  const log = path.join(root, 'calls.jsonl');
  fs.writeFileSync(state, JSON.stringify({ input: '', status: 'idle' }));
  fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify({ agentMessages: { promptTimeoutSeconds: 3 } }));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ control: { projects: { demo: { slug: 'demo', workspace: 'wA', orch: { pane: 'wA:p1' } } } } }));
  fs.writeFileSync(path.join(bin, 'herdr'), `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
const file = process.env.FAKE_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const mode = process.env.FAKE_MODE;
const kind = process.env.FAKE_KIND;
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\\n');
const save = () => fs.writeFileSync(file, JSON.stringify(state));
let result = {};
if (args[0] === 'pane' && args[1] === 'get') {
  const id = args[2];
  result = { pane: { pane_id: id, workspace_id: id === 'wB:p1' ? 'wB' : 'wA', label: id === 'wB:p1' ? 'boss' : mode === 'submitted-worker' ? null : state.label || 'orch', name: id === 'wB:p1' ? 'boss' : 'demo-orch', agent: kind, agent_status: state.status } };
} else if (args[0] === 'agent' && args[1] === 'get') {
  if (mode === 'label-key' && state.reads) { state.label = 'orch previous'; save(); }
  result = { agent: { name: mode === 'wrong-name' ? 'other-agent' : 'demo-orch', pane_id: mode === 'moved' ? 'wA:p9' : 'wA:p1', agent_status: state.status } };
} else if (args[0] === 'agent' && args[1] === 'prompt') {
  if (mode === 'delivered') { state.status = 'working'; save(); result = { ok: true }; }
  else if (mode === 'busy') { process.stderr.write(JSON.stringify({ error: { code: 'agent_prompt_stalled', message: 'The pane is busy.' } })); process.exit(1); }
  else {
    state.promptPid = process.pid;
    if (mode.startsWith('busy-clear-')) state.status = mode.slice('busy-clear-'.length);
    state.input = mode === 'other' ? 'An Owner draft.' : args[3];
    if (mode.startsWith('submitted-')) { state.input = ''; state.status = mode.slice('submitted-'.length); }
    if (mode === 'submitted-worker') state.status = 'working';
    if (mode === 'label-read') state.label = 'orch previous';
    if (mode === 'prefix-rule') state.input += '\\n────────\\nAn Owner draft.';
    if (mode === 'prefix-footer') state.input += '\\n? for shortcuts\\nAn Owner draft.';
    if (mode === 'embedded-marker') state.input = 'An Owner draft.\\n› ' + args[3];
    save();
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
} else if (args[0] === 'pane' && args[1] === 'read') {
  if (mode === 'unreadable') process.exit(1);
  state.reads = (state.reads || 0) + 1;
  if (mode === 'label-during-read') state.label = 'orch previous';
  if (mode === 'changed-before-clear' && state.reads === 3) state.input = 'A new Owner draft.';
  save();
  const marker = kind === 'claude' ? '❯ ' : '› ';
  const input = state.input.split('\\n').join('\\n  ');
  let shown = mode === 'ghost' ? '\\x1b[2m' + input + '\\x1b[0m' : input;
  if (mode === 'wrapped') shown = input.replace('task.', 'ta\\n  sk.');
  if (mode === 'cropped') shown = input.slice(5);
  process.stdout.write('────────\\n' + marker + shown + '\\n────────\\n? for shortcuts\\n');
  process.exit(0);
} else if (args[0] === 'agent' && args[1] === 'send-keys') {
  if (args[3] === 'enter') {
    if (mode === 'retry') { state.input = ''; state.status = 'working'; }
    if (mode === 'retry-fast') { state.input = ''; state.status = 'idle'; }
    if (mode === 'changed') state.input = 'A new Owner draft.';
  } else if (mode !== 'clear-failed') {
    for (const key of args.slice(3)) {
      if (key === 'esc' || key === 'ctrl+c') state.input = '';
      if (key === 'ctrl+u') {
        if (mode === 'fallback' || mode === 'fallback-busy') { /* The single Ctrl+C fallback clears this fixture. */ }
        else state.input = state.input.includes('\\n') ? state.input.slice(0, state.input.lastIndexOf('\\n')) : '';
      }
    }
    if (mode === 'changed-after-clear') state.input = 'A new Owner draft.';
    if (mode === 'fallback-busy') state.status = 'working';
  }
  save();
}
process.stdout.write(JSON.stringify(result));
`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, HERDR_BOSS_DIR: dir, HERDR_ENV: '1', HERDR_PANE_ID: 'wB:p1', HERDR_WORKSPACE_ID: 'wB', FAKE_MODE: mode, FAKE_KIND: kind, FAKE_STATE: state, FAKE_LOG: log };
  return {
    send: () => {
      const sent = spawnSync(process.execPath, [new URL('../src/cli.js', import.meta.url).pathname, 'tell', target, text], { encoding: 'utf8', env, timeout: 30000, killSignal: 'SIGKILL' });
      watchdogExpired = !!sent.error;
      return sent;
    },
    state: () => JSON.parse(fs.readFileSync(state, 'utf8')),
    calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse),
    keys: () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).filter((args) => args[1] === 'send-keys').map((args) => args.slice(3)),
    dir,
  };
}

test('tell returns 75 when Herdr cannot take a prompt', (t) => {
  const f = fixture(t, 'busy');
  const sent = f.send();
  assert.equal(sent.status, 75, sent.stderr);
  assert.deepEqual(f.keys(), []);
});

test('tell bounds the prompt, retries submit once and clears its own multiline Codex input', (t) => {
  const f = fixture(t, 'timeout');
  const sent = f.send();
  assert.equal(sent.status, 76, sent.stderr || String(sent.error));
  assert.equal(f.state().input, '');
  assert.deepEqual(f.keys(), [['enter'], ['ctrl+u', 'ctrl+u']]);
});

test('tell records delivered text and exits 0', async (t) => {
  const f = fixture(t, 'delivered');
  assert.equal(f.send().status, 0);
  assert.deepEqual(f.keys(), []);
  const { readAgentMessages } = await import('../src/agent-messages.js');
  assert.equal(readAgentMessages({ dir: f.dir })[0].status, 'delivered');
});

test('tell verifies delivery after its single submit retry', (t) => {
  const f = fixture(t, 'retry');
  assert.equal(f.send().status, 0);
  assert.equal(f.state().status, 'working');
  assert.deepEqual(f.keys(), [['enter']]);
});

test('tell treats empty input after the submit retry as delivered for a fast idle reply', async (t) => {
  const f = fixture(t, 'retry-fast');
  const sent = f.send();
  assert.equal(sent.status, 0, sent.stderr);
  assert.equal(f.state().status, 'idle');
  assert.deepEqual(f.keys(), [['enter']]);
  const { readAgentMessages } = await import('../src/agent-messages.js');
  assert.equal(readAgentMessages({ dir: f.dir })[0].status, 'delivered');
});

for (const status of ['working', 'blocked']) {
  test(`tell treats empty input and ${status} as delivered after a prompt timeout`, async (t) => {
    const f = fixture(t, `submitted-${status}`);
    const sent = f.send();
    assert.equal(sent.status, 0, sent.stderr);
    assert.deepEqual(f.keys(), []);
    const { readAgentMessages } = await import('../src/agent-messages.js');
    assert.equal(readAgentMessages({ dir: f.dir })[0].status, 'delivered');
  });
}

test('tell recognizes submission to an unlabelled agent addressed by pane', (t) => {
  const f = fixture(t, 'submitted-worker', 'codex', 'Read the task.', 'wA:p1');
  const sent = f.send();
  assert.equal(sent.status, 0, sent.stderr);
  assert.deepEqual(f.keys(), []);
});

test('tell leaves other text alone after a timeout', (t) => {
  const f = fixture(t, 'other');
  assert.equal(f.send().status, 75);
  assert.equal(f.state().input, 'An Owner draft.');
  assert.deepEqual(f.keys(), []);
});

for (const mode of ['prefix-rule', 'prefix-footer', 'embedded-marker', 'ghost']) {
  test(`tell does not mistake ${mode} in another draft for its whole input`, (t) => {
    const f = fixture(t, mode, 'codex', 'Read the task.');
    assert.equal(f.send().status, 75);
    if (mode === 'ghost') assert.equal(f.state().input, 'Read the task.');
    else assert.ok(f.state().input.includes('An Owner draft.'));
    assert.deepEqual(f.keys(), []);
  });
}

test('tell clears matching Claude input with two Escape keys and verifies it', (t) => {
  const f = fixture(t, 'timeout', 'claude');
  assert.equal(f.send().status, 76);
  assert.equal(f.state().input, '');
  assert.deepEqual(f.keys(), [['enter'], ['esc', 'esc']]);
});

for (const status of ['working', 'blocked', 'unknown']) {
  test(`tell does not clear a matching Claude draft while the agent is ${status}`, (t) => {
    const f = fixture(t, `busy-clear-${status}`, 'claude');
    const sent = f.send();
    assert.equal(sent.status, 76, sent.stderr);
    assert.equal(f.state().input, 'Read the task.\nRun its checks.');
    assert.deepEqual(f.keys(), [['enter']]);
  });
}

test('tell uses one Codex cancel only when its clear sequence leaves its own text', (t) => {
  const f = fixture(t, 'fallback');
  assert.equal(f.send().status, 76);
  assert.equal(f.state().input, '');
  assert.deepEqual(f.keys(), [['enter'], ['ctrl+u', 'ctrl+u'], ['ctrl+c']]);
});

test('tell does not send a Codex cancel fallback after the agent becomes busy', (t) => {
  const f = fixture(t, 'fallback-busy');
  assert.equal(f.send().status, 76);
  assert.equal(f.state().input, 'Read the task.\nRun its checks.');
  assert.deepEqual(f.keys(), [['enter'], ['ctrl+u', 'ctrl+u']]);
});

for (const mode of ['wrapped', 'cropped']) {
  test(`tell explains an unmatched ${mode} input and the file-path prompt pattern`, (t) => {
    const f = fixture(t, mode, 'codex', 'Read the task.');
    const sent = f.send();
    assert.equal(sent.status, 75);
    assert.equal(f.state().input, 'Read the task.');
    assert.deepEqual(f.keys(), []);
    assert.match(sent.stderr, /wrapped.*cropped/i);
    assert.match(sent.stderr, /file-path prompt/i);
  });
}

for (const [mode, expected, keys] of [
  ['changed', 'A new Owner draft.', [['enter']]],
  ['changed-before-clear', 'A new Owner draft.', [['enter']]],
  ['changed-after-clear', 'A new Owner draft.', [['enter'], ['ctrl+u', 'ctrl+u']]],
  ['clear-failed', 'Read the task.\nRun its checks.', [['enter'], ['ctrl+u', 'ctrl+u'], ['ctrl+c']]],
]) {
  test(`tell leaves text intact when recovery is ${mode}`, (t) => {
    const f = fixture(t, mode);
    const sent = f.send();
    assert.equal(sent.status, 76, sent.stderr);
    assert.equal(f.state().input, expected);
    assert.deepEqual(f.keys(), keys);
    assert.match(sent.stderr, /left alone/);
  });
}

test('tell leaves unreadable input alone', (t) => {
  const f = fixture(t, 'unreadable');
  assert.equal(f.send().status, 75);
  assert.deepEqual(f.keys(), []);
});

test('tell leaves matching input alone for a harness without recovery keys', (t) => {
  const f = fixture(t, 'timeout', 'opencode');
  assert.equal(f.send().status, 76);
  assert.equal(f.state().input, 'Read the task.\nRun its checks.');
  assert.deepEqual(f.keys(), [['enter']]);
});

for (const [mode, exitCode] of [['label-read', 75], ['label-during-read', 75], ['label-key', 76], ['moved', 76], ['wrong-name', 76]]) {
  test(`tell rejects recovery when the target identity has changed: ${mode}`, (t) => {
    const f = fixture(t, mode);
    const sent = f.send();
    assert.equal(sent.status, exitCode, sent.stderr);
    assert.equal(f.state().input, 'Read the task.\nRun its checks.');
    assert.deepEqual(f.keys(), []);
  });
}

test('tell re-resolves the agent by name and checks the pane label before each recovery key command', (t) => {
  const f = fixture(t, 'timeout');
  assert.equal(f.send().status, 76);
  const calls = f.calls();
  let boundary = 0;
  for (let i = 0; i < calls.length; i += 1) {
    if (calls[i][1] !== 'send-keys') continue;
    const guard = calls.slice(boundary, i);
    assert.ok(guard.some((args) => args[0] === 'agent' && args[1] === 'get' && args[2] === 'demo-orch'));
    assert.ok(guard.some((args) => args[0] === 'pane' && args[1] === 'get' && args[2] === 'wA:p1'));
    boundary = i + 1;
  }
  assert.deepEqual(f.keys(), [['enter'], ['ctrl+u', 'ctrl+u']]);
});

test('service prompts pass a 25-second process bound to the Herdr runner', async () => {
  const { Engine } = await import('../src/engine.js');
  const engine = Object.create(Engine.prototype);
  const calls = [];
  engine.herdrRunner = async (command, args, options) => { calls.push({ command, args, options }); return '{}'; };
  await engine.promptService('wA:p1', 'A service notice.', { now: 1000, messages: [] });
  assert.equal(calls[0].options?.timeout, 25000);
  assert.equal(calls[0].options?.killSignal, 'SIGKILL');
});

test('goal prompts carry the same process bound through their runner', async () => {
  const { sendGoalPrompt } = await import('../src/goal.js');
  let options;
  await sendGoalPrompt({ run: async (args, supplied) => { options = supplied; return {}; }, pane: 'wA:p1', goal: 'Run the checks.', kind: 'codex' });
  assert.equal(options?.timeout, 25000);
  assert.equal(options?.killSignal, 'SIGKILL');
});

test('the async process runner honors a hard process bound for a resistant command', async () => {
  const { run } = await import('../src/collect.js');
  await assert.rejects(run(process.execPath, ['-e', 'process.on("SIGTERM", () => process.exit(77)); setInterval(() => {}, 1000);'], { timeout: 2000, killSignal: 'SIGKILL' }), (error) => error.signal === 'SIGKILL');
});
