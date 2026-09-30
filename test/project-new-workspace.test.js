import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertTempDataDir } from '../src/data-dir-guard.js';
import { runProjectNew } from '../src/project-new.js';
import { projectCommand } from '../src/project-new-cli.js';
import { goalDelivery } from '../src/goal.js';
import { POLICY_DEFAULTS } from '../src/control.js';

// Git reads its identity from a temporary global file, never from the machine.
const GIT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-project-new-ws-git-'));
const WITH_IDENTITY = path.join(GIT_HOME, 'with');
fs.writeFileSync(WITH_IDENTITY, '[user]\n\tname = Test User\n\temail = test@example.invalid\n');
process.env.GIT_CONFIG_GLOBAL = WITH_IDENTITY;
process.env.GIT_CONFIG_NOSYSTEM = '1';
for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete process.env[key];
test.after(() => fs.rmSync(GIT_HOME, { recursive: true, force: true }));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-project-new-ws-'));
  const dataDir = assertTempDataDir(path.join(root, 'data'));
  fs.mkdirSync(dataDir, { recursive: true });
  const group = path.join(root, 'group');
  fs.mkdirSync(group);
  const repoRoot = path.join(root, 'boss-repo');
  fs.mkdirSync(repoRoot);
  return { root, dataDir, group, repoRoot, ceiling: root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const GOAL = 'Ship the first version of the demo project.';

// A fake Herdr. It keeps workspaces and panes, records each call, and answers the commands that the step uses.
function fakeHerdr({ workspaces = [], panes = [], failOn = null } = {}) {
  const calls = [];
  const state = { workspaces: [...workspaces], panes: [...panes], text: '', prompts: [], goalVisible: true };
  const pane = (id) => state.panes.find((p) => p.pane_id === id);
  const run = (args) => {
    calls.push(args);
    const line = args.join(' ');
    if (failOn && failOn.test(line)) throw new Error(`fake failure: ${args[0]} ${args[1]}`);
    const [a, b] = args;
    if (a === 'workspace' && b === 'list') return { workspaces: state.workspaces };
    if (a === 'workspace' && b === 'create') {
      const label = args[args.indexOf('--label') + 1];
      const cwd = args[args.indexOf('--cwd') + 1];
      const id = `w${state.workspaces.length + 1}`;
      state.workspaces.push({ workspace_id: id, label });
      state.panes.push({ pane_id: `${id}:p1`, tab_id: `${id}:t1`, workspace_id: id, label: null, agent: null, foreground_cwd: cwd });
      return { workspace: { workspace_id: id, label }, root_pane: { pane_id: `${id}:p1`, tab_id: `${id}:t1`, workspace_id: id } };
    }
    if (a === 'pane' && b === 'list') {
      const w = args.includes('--workspace') ? args[args.indexOf('--workspace') + 1] : null;
      return { panes: state.panes.filter((p) => !w || p.workspace_id === w) };
    }
    if (a === 'pane' && b === 'get') {
      const found = pane(args[2]);
      if (!found) { const error = new Error('pane not found'); error.code = 'pane_not_found'; throw error; }
      return { pane: found };
    }
    if (a === 'pane' && b === 'rename') { pane(args[2]).label = args[3]; return {}; }
    if (a === 'pane' && b === 'read') return { text: state.goalVisible ? state.text : '' };
    if (a === 'agent' && b === 'start') {
      const target = pane(args[args.indexOf('--pane') + 1]);
      target.agent = args[args.indexOf('--kind') + 1];
      target.agent_name = args[2];
      target.agent_status = 'idle';
      return { agent: { name: args[2] } };
    }
    if (a === 'agent' && b === 'prompt') { state.prompts.push({ target: args[2], text: args[3] }); state.text += `\n${args[3]}`; return {}; }
    if (a === 'agent' && b === 'get') return { agent: { agent_status: 'idle' } };
    if (a === 'agent' && b === 'list') return { agents: state.panes.filter((p) => p.agent).map((p) => ({ name: p.agent_name, pane_id: p.pane_id })) };
    throw new Error(`unexpected herdr call: ${line}`);
  };
  run.calls = calls;
  run.state = state;
  run.lines = () => calls.map((c) => c.join(' '));
  return run;
}

const hooks = (herdr) => ({ waitForPane: () => {}, waitForReady: () => true, readText: () => herdr.state.text, wait: () => {} });

function start(f, herdr, extra = {}) {
  return runProjectNew({ slug: 'demo', group: f.group, goal: GOAL, dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling, start: true, herdr, hooks: hooks(herdr), env: { HERDR_SOCKET_PATH: '/tmp/herdr.sock' }, ...extra });
}
const step = (result, name) => result.steps.find((s) => s.name === name);
const index = (lines, pattern) => lines.findIndex((l) => pattern.test(l));

function writePolicy(f, patch) {
  const policy = { ...structuredClone(POLICY_DEFAULTS), ...patch };
  fs.writeFileSync(path.join(f.dataDir, 'policy.json'), JSON.stringify(policy));
}

test('goalDelivery gives command for Claude, prompt for other kinds, and nothing without a goal or for the Boss', () => {
  assert.equal(goalDelivery({ goal: GOAL, kind: 'claude' }), 'command');
  assert.equal(goalDelivery({ goal: GOAL, kind: 'codex' }), 'prompt');
  assert.equal(goalDelivery({ goal: GOAL, kind: 'pi' }), 'prompt');
  assert.equal(goalDelivery({ goal: '', kind: 'claude' }), undefined);
  assert.equal(goalDelivery({ goal: GOAL, kind: 'claude', boss: true }), undefined);
});

test('without --start the step is skipped and Herdr gets no call', () => {
  const f = fixture();
  try {
    const herdr = fakeHerdr();
    const result = start(f, herdr, { start: false });
    assert.equal(result.ok, true);
    assert.equal(step(result, 'workspace').status, 'skipped');
    assert.match(step(result, 'workspace').detail, /no --start/);
    assert.deepEqual(herdr.calls, []);
    // A later run with --start does the step.
    const later = start(f, herdr, { resume: true });
    assert.equal(step(later, 'workspace').status, 'done');
    assert.ok(herdr.calls.length > 0);
  } finally { f.cleanup(); }
});

test('a dry run says what it would create and calls nothing', () => {
  const f = fixture();
  try {
    const herdr = fakeHerdr();
    const result = start(f, herdr, { dryRun: true });
    assert.match(step(result, 'workspace').detail, /would create .*workspace/i);
    assert.match(step(result, 'workspace').detail, /demo-orch/);
    assert.deepEqual(herdr.calls, []);
    const plain = start(f, herdr, { dryRun: true, start: false });
    assert.match(step(plain, 'workspace').detail, /no --start/);
    assert.deepEqual(herdr.calls, []);
  } finally { f.cleanup(); }
});

test('creates the workspace, labels the pane orch, starts <slug>-orch, and sends the prompt, in that order', () => {
  const f = fixture();
  try {
    const herdr = fakeHerdr();
    const result = start(f, herdr);
    assert.equal(result.ok, true, result.error);
    assert.equal(step(result, 'workspace').status, 'done');
    const lines = herdr.lines();
    const create = index(lines, /^workspace create /);
    const rename = index(lines, /^pane rename w1:p1 orch$/);
    const agentStart = index(lines, /^agent start demo-orch --kind /);
    const firstPrompt = index(lines, /^agent prompt demo-orch \[herdr-boss\]/);
    assert.ok(create >= 0 && rename > create && agentStart > rename && firstPrompt > agentStart, lines.join('\n'));
    const createLine = herdr.calls[create];
    assert.equal(createLine[createLine.indexOf('--label') + 1], 'demo');
    assert.equal(createLine[createLine.indexOf('--cwd') + 1], fs.realpathSync(path.join(f.group, 'demo')));
    assert.ok(createLine.includes('--no-focus'));
    const prompt = herdr.state.prompts.at(-1).text;
    assert.match(prompt, /AGENTS\.md/);
    assert.match(prompt, /docs\/orchestration\/memory\.md/);
    assert.match(prompt, /docs\/orchestration\/herdr-boss\.md/);
    assert.match(prompt, /Set up the project/);
    const saved = JSON.parse(fs.readFileSync(result.stateFile, 'utf8'));
    assert.equal(saved.ids.workspaceId, 'w1');
    assert.equal(saved.ids.paneId, 'w1:p1');
  } finally { f.cleanup(); }
});

test('the default ladder starts Codex and puts the goal in the first prompt, not in /goal', () => {
  const f = fixture();
  try {
    const herdr = fakeHerdr();
    const result = start(f, herdr);
    assert.equal(result.ok, true, result.error);
    const startCall = herdr.calls.find((c) => c[0] === 'agent' && c[1] === 'start');
    assert.equal(startCall[startCall.indexOf('--kind') + 1], 'codex');
    assert.ok(startCall.includes('gpt-6-luna'));
    assert.ok(startCall.some((a) => String(a).includes('shell_environment_policy.set.HERDR_SOCKET_PATH')));
    assert.equal(herdr.state.prompts.length, 1);
    assert.doesNotMatch(herdr.state.prompts[0].text, /^\/goal/);
    assert.ok(herdr.state.prompts[0].text.includes(GOAL));
  } finally { f.cleanup(); }
});

test('a Claude orchestrator gets /goal as its own prompt before the first prompt, and the pane shows it', () => {
  const f = fixture();
  try {
    const herdr = fakeHerdr();
    const result = start(f, herdr, { kind: 'claude' });
    assert.equal(result.ok, true, result.error);
    const startCall = herdr.calls.find((c) => c[0] === 'agent' && c[1] === 'start');
    assert.equal(startCall[startCall.indexOf('--kind') + 1], 'claude');
    const texts = herdr.state.prompts.map((p) => p.text);
    assert.equal(texts[0], `/goal ${GOAL}`);
    assert.equal(texts.length, 2);
    assert.doesNotMatch(texts[1], new RegExp(GOAL));
    const lines = herdr.lines();
    assert.ok(index(lines, /^pane read w1:p1 /) > index(lines, /^agent prompt demo-orch \/goal/));
    assert.ok(index(lines, /^agent prompt demo-orch \/goal/) < index(lines, /^agent prompt demo-orch \[herdr-boss\]/));
  } finally { f.cleanup(); }
});

test('a Claude /goal that the pane does not show fails the step, and --resume does not send it again', () => {
  const f = fixture();
  try {
    const herdr = fakeHerdr();
    herdr.state.goalVisible = false;
    const failed = start(f, herdr, { kind: 'claude' });
    assert.equal(failed.ok, false);
    assert.equal(step(failed, 'workspace').status, 'failed');
    assert.match(failed.error, /goal/i);
    const sent = herdr.state.prompts.length;
    herdr.state.goalVisible = true;
    const resumed = start(f, herdr, { kind: 'claude', resume: true });
    assert.equal(resumed.ok, true, resumed.error);
    assert.equal(herdr.state.prompts.filter((p) => p.text.startsWith('/goal')).length, 1);
    assert.equal(herdr.state.prompts.length, sent + 1);
    assert.equal(herdr.calls.filter((c) => c[0] === 'workspace' && c[1] === 'create').length, 1);
  } finally { f.cleanup(); }
});

test('the goal is the --goal text, else the Settings default goal', () => {
  const f = fixture();
  try {
    const herdr = fakeHerdr();
    const result = runProjectNew({ slug: 'demo', group: f.group, dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling, start: true, herdr, hooks: hooks(herdr), env: {}, kind: 'claude' });
    assert.equal(result.ok, true, result.error);
    assert.ok(herdr.state.prompts[0].text.startsWith('/goal '));
    assert.ok(herdr.state.prompts[0].text.includes(POLICY_DEFAULTS.defaultOrchestratorGoal.slice(0, 40)));
  } finally { f.cleanup(); }
});

test('the ladder takes the first usable entry and skips a disabled kind', () => {
  const f = fixture();
  try {
    writePolicy(f, { allowedKinds: ['claude', 'pi', 'opencode'] });
    const herdr = fakeHerdr();
    const result = start(f, herdr);
    assert.equal(result.ok, true, result.error);
    const startCall = herdr.calls.find((c) => c[0] === 'agent' && c[1] === 'start');
    assert.equal(startCall[startCall.indexOf('--kind') + 1], 'claude');
    assert.ok(startCall.includes('claude-opus-5-5'));
  } finally { f.cleanup(); }
});

test('--kind overrides the ladder and uses the model of the policy for that kind', () => {
  const f = fixture();
  try {
    writePolicy(f, { preferredModels: { claude: 'claude-sonnet-5-5' } });
    const herdr = fakeHerdr();
    const result = start(f, herdr, { kind: 'claude' });
    assert.equal(result.ok, true, result.error);
    const startCall = herdr.calls.find((c) => c[0] === 'agent' && c[1] === 'start');
    assert.equal(startCall[startCall.indexOf('--kind') + 1], 'claude');
    assert.ok(startCall.includes('claude-sonnet-5-5'));
  } finally { f.cleanup(); }
});

test('a --kind that the policy disables fails the step before Herdr creates anything', () => {
  const f = fixture();
  try {
    writePolicy(f, { allowedKinds: ['claude'] });
    const herdr = fakeHerdr();
    const result = start(f, herdr, { kind: 'codex' });
    assert.equal(result.ok, false);
    assert.match(result.error, /disabled|not allowed|codex/i);
    assert.deepEqual(herdr.calls.filter((c) => c[0] === 'workspace' && c[1] === 'create'), []);
  } finally { f.cleanup(); }
});

test('a rerun creates no second workspace and sends nothing again', () => {
  const f = fixture();
  try {
    const herdr = fakeHerdr();
    assert.equal(start(f, herdr).ok, true);
    const before = herdr.calls.length;
    const prompts = herdr.state.prompts.length;
    const again = start(f, herdr, { resume: true });
    assert.equal(again.ok, true);
    assert.equal(step(again, 'workspace').status, 'done');
    assert.equal(herdr.calls.length, before);
    assert.equal(herdr.state.prompts.length, prompts);
  } finally { f.cleanup(); }
});

test('a failure after the workspace exists records the ids, and --resume continues in that pane', () => {
  const f = fixture();
  try {
    const herdr = fakeHerdr({ failOn: /^agent start / });
    const failed = start(f, herdr);
    assert.equal(failed.ok, false);
    assert.equal(step(failed, 'workspace').status, 'failed');
    const saved = JSON.parse(fs.readFileSync(failed.stateFile, 'utf8'));
    assert.equal(saved.ids.workspaceId, 'w1');
    assert.equal(saved.ids.paneId, 'w1:p1');
    const working = fakeHerdr();
    working.state.workspaces = herdr.state.workspaces;
    working.state.panes = herdr.state.panes;
    const resumed = start(f, working, { resume: true });
    assert.equal(resumed.ok, true, resumed.error);
    assert.equal(working.calls.filter((c) => c[0] === 'workspace' && c[1] === 'create').length, 0);
    assert.equal(working.calls.filter((c) => c[0] === 'agent' && c[1] === 'start').length, 1);
  } finally { f.cleanup(); }
});

test('when the recorded workspace id is gone, a workspace with the label is reused', () => {
  const f = fixture();
  try {
    const herdr = fakeHerdr({ failOn: /^agent start / });
    assert.equal(start(f, herdr).ok, false);
    const saved = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'flows', 'demo.json'), 'utf8'));
    saved.ids.workspaceId = 'w-gone';
    saved.ids.paneId = 'w-gone:p1';
    fs.writeFileSync(path.join(f.dataDir, 'flows', 'demo.json'), JSON.stringify(saved));
    const working = fakeHerdr({ workspaces: herdr.state.workspaces, panes: herdr.state.panes });
    const resumed = start(f, working, { resume: true });
    assert.equal(resumed.ok, true, resumed.error);
    assert.equal(working.calls.filter((c) => c[0] === 'workspace' && c[1] === 'create').length, 0);
    assert.equal(JSON.parse(fs.readFileSync(resumed.stateFile, 'utf8')).ids.workspaceId, 'w1');
  } finally { f.cleanup(); }
});

test('a pane that already runs the agent and got the prompt receives nothing', () => {
  const f = fixture();
  try {
    const herdr = fakeHerdr();
    assert.equal(start(f, herdr).ok, true);
    const file = path.join(f.dataDir, 'flows', 'demo.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    saved.steps.workspace = { status: 'failed', at: new Date().toISOString(), detail: 'x' };
    fs.writeFileSync(file, JSON.stringify(saved));
    const before = herdr.calls.filter((c) => c[0] === 'agent' && ['start', 'prompt'].includes(c[1])).length;
    const again = start(f, herdr, { resume: true });
    assert.equal(again.ok, true, again.error);
    assert.equal(herdr.calls.filter((c) => c[0] === 'agent' && ['start', 'prompt'].includes(c[1])).length, before);
  } finally { f.cleanup(); }
});

test('the status gets the workspace id', () => {
  const f = fixture();
  try {
    const herdr = fakeHerdr();
    assert.equal(start(f, herdr).ok, true);
    const status = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'projects', 'demo.json'), 'utf8'));
    assert.equal(status.workspace, 'w1');
  } finally { f.cleanup(); }
});

test('the error and the state file never hold a token', () => {
  const f = fixture();
  try {
    const herdr = fakeHerdr({ failOn: /^agent start / });
    const result = start(f, herdr, { env: { HERDR_SOCKET_PATH: '/tmp/herdr.sock', GITHUB_TOKEN: 'ghp_abcdefghijklmnop' } });
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /ghp_/);
    assert.doesNotMatch(fs.readFileSync(result.stateFile, 'utf8'), /ghp_/);
  } finally { f.cleanup(); }
});

test('the command passes --start and the Herdr runner to the flow', () => {
  const f = fixture();
  try {
    const herdr = fakeHerdr();
    const out = [];
    const code = projectCommand(['new', 'demo', '--group', f.group, '--start', '--kind', 'claude', '--goal', GOAL], { env: {}, herdr, dataDir: f.dataDir, log: (l) => out.push(l), hooks: hooks(herdr), flowOptions: { repoRoot: f.repoRoot, ceiling: f.ceiling } });
    assert.equal(code, 0, out.join('\n'));
    assert.ok(herdr.calls.some((c) => c[0] === 'workspace' && c[1] === 'create'));
    assert.ok(out.some((l) => /workspace\s+done/.test(l)), out.join('\n'));
  } finally { f.cleanup(); }
});
