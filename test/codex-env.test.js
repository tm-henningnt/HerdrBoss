import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { codexShellEnvArgs, liveCodexCheck } from '../src/harness.js';
import { loadModels, loadProjectConfig } from '../src/kit/config.js';
import { startWorker } from './helpers/start-worker.js';
import { readyAgent } from './helpers/ready-agent.js';
import { CODEX_READY_SCREEN } from './helpers/kit-fixture.js';

// Worker worktrees default to ~/Projects/.herdr-wt. Keep them out of the real home folder.
const TEST_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-codexenv-home-')));
process.env.HOME = TEST_HOME;
process.on('exit', () => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const MODELS = fileURLToPath(new URL('../kit/models.json', import.meta.url));
const ORCH = {
  HERDR_ENV: '1', HERDR_PANE_ID: 'ws:orch', HERDR_WORKSPACE_ID: 'ws', HERDR_TAB_ID: 'ws:t0',
  HERDR_SOCKET_PATH: '/fake/herdr.sock', HERDR_BIN_PATH: '/fake/bin/herdr',
};

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tempDir(prefix) { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); }

function temporaryRepo() {
  const root = tempDir('herdr-codexenv-');
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Test User');
  git(root, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(root, 'README.md'), 'seed\n');
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ slug: 'alpha' }));
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'seed');
  return root;
}

// A fake Herdr with one Workers tab. A split returns the new pane ws:p2 in tab ws:t1.
function startFixture({ browserLookup } = {}) {
  const root = temporaryRepo();
  const config = loadProjectConfig({ cwd: root });
  const rulesFile = path.join(root, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({ updatedAt: new Date().toISOString(), avoidKinds: [] }));
  const starts = [];
  let paneCwd = root;
  const herdr = (args) => {
    if (args[0] === 'pane' && args[1] === 'get') return args[2] === 'ws:orch'
      ? { pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } }
      : { pane: { pane_id: args[2], workspace_id: 'ws', foreground_cwd: paneCwd } };
    if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: { shell_pid: 10, foreground_process_group_id: 10 } };
    if (args[0] === 'pane' && args[1] === 'read') return { text: `% \n${CODEX_READY_SCREEN}` };
    if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
    if (args[0] === 'agent' && args[1] === 'get') return readyAgent();
    if (args[0] === 'tab' && args[1] === 'list') return { tabs: [{ tab_id: 'ws:t1', workspace_id: 'ws', label: 'Workers' }] };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [{ pane_id: 'ws:p1', workspace_id: 'ws', tab_id: 'ws:t1', width: 160, height: 45 }] };
    if (args[0] === 'pane' && args[1] === 'split') { paneCwd = args[args.indexOf('--cwd') + 1]; return { pane: { pane_id: 'ws:p2' } }; }
    if (args[0] === 'pane' && args[1] === 'close') return {};
    if (args[0] === 'agent' && args[1] === 'start') { starts.push(args); return {}; }
    if (args[0] === 'agent' && args[1] === 'prompt') return {};
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const lines = [];
  const start = (name, options = {}, env = ORCH) => startWorker(name, { kind: 'codex', task: 'x', allow: ['src/'], ...options }, {
    config, models: loadModels(), herdr, env, rulesFile, wait: () => {}, output: (line) => lines.push(line), browserLookup,
    readProcessStart: () => 'Mon Sep 28 10:00:00 2026',
  });
  return { root, config, starts, lines, start };
}

// Map each -c shell_environment_policy.set.NAME="value" pair to { NAME: value }.
function setArgs(args) {
  const out = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '-c') continue;
    const match = /^shell_environment_policy\.set\.([A-Z_]+)="([^"]*)"$/.exec(args[index + 1] ?? '');
    if (match) out[match[1]] = match[2];
  }
  return out;
}

const launchPart = (args) => args.slice(args.indexOf('--') + 1);

test('a codex worker attaches DevTools to its project browser without changing user config', () => {
  const calls = [];
  const f = startFixture({ browserLookup: (project) => { calls.push(project); return { port: 9247 }; } });
  const configFile = path.join(TEST_HOME, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  const before = '[mcp_servers.chrome-devtools]\ncommand = "npx"\nargs = ["chrome-devtools-mcp@latest"]\n';
  fs.writeFileSync(configFile, before);
  f.start('cxbrowser');
  const args = launchPart(f.starts.at(-1));
  const override = 'mcp_servers.chrome-devtools.args=["chrome-devtools-mcp@latest","--browserUrl=http://127.0.0.1:9247"]';
  assert.ok(args.some((arg, index) => arg === '-c' && args[index + 1] === override));
  assert.deepEqual(calls, ['alpha']);
  assert.equal(fs.readFileSync(configFile, 'utf8'), before);
  assert.equal(args.some((arg) => /mcp_servers\.(?:node_repl|cua_repl)\./.test(arg)), false);
});

test('a failed browser lookup still launches the Codex worker with DevTools disabled', () => {
  const f = startFixture({ browserLookup: () => { throw new Error('private fixture error'); } });
  f.start('cxfallback');
  const args = launchPart(f.starts.at(-1));
  assert.ok(args.some((arg, index) => arg === '-c' && args[index + 1] === 'mcp_servers.chrome-devtools.enabled=false'));
  assert.equal(f.lines.filter((line) => line.startsWith('Codex:')).length, 1);
  assert.doesNotMatch(f.lines.join('\n'), /private fixture error/);
});

test('a non-Codex worker does not look up or override DevTools', () => {
  for (const kind of ['claude', 'opencode']) {
    const f = startFixture({ browserLookup: () => { assert.fail('only Codex looks up a browser'); } });
    f.start(`browser-${kind}`, { kind });
    assert.equal(launchPart(f.starts.at(-1)).some((arg) => arg.startsWith('mcp_servers.')), false);
  }
});

test('the standard worker brief gives each browser task private tab and capture rules', () => {
  const f = startFixture();
  const run = f.start('browserbrief', { kind: 'claude' });
  const brief = fs.readFileSync(path.join(run.worktree, '.worker', 'brief.md'), 'utf8');
  assert.match(brief, /Use only the tab that you create with `herdr-boss browser tab new`\./);
  assert.match(brief, /Record its tab ID\. Never use or change another tab\./);
  assert.match(brief, /Close your tab when the task ends\./);
  assert.match(brief, /Never print cookies, storage, or tokens\./);
  assert.match(brief, /Never run an evaluate command that reads `document\.cookie` or `localStorage`\./);
  assert.match(brief, /Use `herdr-boss browser screenshot` for each screenshot\./);
});

test('a codex worker start passes the pane Herdr variables, TMPDIR, and HERDR_WORKTREE to the agent', () => {
  const f = startFixture();
  const run = f.start('cx');
  const args = launchPart(f.starts.at(-1));
  const set = setArgs(args);
  assert.deepEqual(Object.keys(set).sort(), ['HERDR_BIN_PATH', 'HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_SOCKET_PATH', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'HERDR_WORKTREE', 'TMPDIR']);
  assert.equal(set.HERDR_ENV, '1');
  assert.equal(set.HERDR_PANE_ID, 'ws:p2');
  assert.equal(set.HERDR_TAB_ID, 'ws:t1');
  assert.equal(set.HERDR_WORKSPACE_ID, 'ws');
  assert.equal(set.HERDR_SOCKET_PATH, ORCH.HERDR_SOCKET_PATH);
  assert.equal(set.HERDR_BIN_PATH, ORCH.HERDR_BIN_PATH);
  assert.equal(set.HERDR_WORKTREE, path.resolve(run.worktree));
  assert.equal(set.TMPDIR, path.join(path.resolve(run.worktree), '.worker', 'tmp'));
  // The model launch arguments stay first and unchanged.
  assert.deepEqual(args.slice(0, 6), ['-m', 'gpt-6-luna', '-c', 'model_reasoning_effort=xhigh', '-s', 'workspace-write']);
});

test('a codex worker start leaves out a variable whose value is unknown', () => {
  const f = startFixture();
  const { HERDR_SOCKET_PATH, HERDR_BIN_PATH, ...rest } = ORCH;
  f.start('cx', {}, rest);
  const set = setArgs(launchPart(f.starts.at(-1)));
  assert.equal('HERDR_SOCKET_PATH' in set, false);
  assert.equal('HERDR_BIN_PATH' in set, false);
  assert.equal(set.HERDR_PANE_ID, 'ws:p2');
});

test('the worker brief report and question commands carry caller Herdr settings inline', () => {
  const f = startFixture();
  const run = f.start('cxreport');
  const brief = fs.readFileSync(path.join(run.worktree, '.worker', 'brief.md'), 'utf8');
  assert.match(brief, /HERDR_ENV=1 HERDR_SOCKET_PATH=\/fake\/herdr\.sock \/fake\/bin\/herdr agent prompt alpha-orch "WORKER QUESTION/);
  assert.match(brief, /HERDR_ENV=1 HERDR_SOCKET_PATH=\/fake\/herdr\.sock \/fake\/bin\/herdr agent prompt alpha-orch "WORKER REPORT/);
  assert.match(brief, /Use this command as written\. It works also when your shell lost the Herdr variables\./);

  const missing = startFixture();
  const { HERDR_SOCKET_PATH, ...caller } = ORCH;
  const missingRun = missing.start('cxnosocket', {}, caller);
  const missingBrief = fs.readFileSync(path.join(missingRun.worktree, '.worker', 'brief.md'), 'utf8');
  assert.match(missingBrief, /HERDR_ENV=1 \/fake\/bin\/herdr agent prompt alpha-orch "WORKER QUESTION/);
  assert.match(missingBrief, /HERDR_ENV=1 \/fake\/bin\/herdr agent prompt alpha-orch "WORKER REPORT/);
  assert.doesNotMatch(missingBrief, /HERDR_SOCKET_PATH/);
});

test('other kinds get no shell_environment_policy arguments', () => {
  for (const kind of ['claude', 'opencode']) {
    const f = startFixture();
    f.start(`w-${kind}`, { kind });
    const args = launchPart(f.starts.at(-1));
    assert.equal(args.some((arg) => String(arg).includes('shell_environment_policy')), false, kind);
  }
});

test('codexShellEnvArgs quotes each value as a TOML string and refuses a newline or a quote', () => {
  assert.deepEqual(codexShellEnvArgs({ HERDR_PANE_ID: 'wB:p12', HERDR_TAB_ID: null, HERDR_BIN_PATH: '', TMPDIR: undefined }),
    ['-c', 'shell_environment_policy.set.HERDR_PANE_ID="wB:p12"']);
  assert.deepEqual(codexShellEnvArgs({ HERDR_WORKTREE: '/a b/c' }), ['-c', 'shell_environment_policy.set.HERDR_WORKTREE="/a b/c"']);
  for (const bad of ['a\nb', 'a\rb', 'a"b', "a'b", 'a\\b']) {
    assert.throws(() => codexShellEnvArgs({ HERDR_SOCKET_PATH: bad }), /HERDR_SOCKET_PATH/);
  }
  // The error names the variable and never prints its value.
  assert.throws(() => codexShellEnvArgs({ HERDR_SOCKET_PATH: 'secret"x' }), (error) => !error.message.includes('secret'));
});

test('a codex worker start with a quote in a caller value fails before it creates a worktree or a pane', () => {
  const f = startFixture();
  assert.throws(() => f.start('cxbad', {}, { ...ORCH, HERDR_SOCKET_PATH: '/bad"path' }), /HERDR_SOCKET_PATH/);
  assert.equal(fs.existsSync(f.config.worktreePath('cxbad')), false);
  assert.equal(f.starts.length, 0);
});

test('the dry-run plan shows the codex variables with pane placeholders', () => {
  const f = startFixture();
  const plan = f.start('cxdry', { dryRun: true });
  const text = f.lines.join('\n');
  assert.equal(plan.dryRun, true);
  assert.match(text, /shell_environment_policy\.set\.HERDR_PANE_ID="<pane-id>"/);
  assert.match(text, /shell_environment_policy\.set\.HERDR_ENV="1"/);
  assert.match(text, /shell_environment_policy\.set\.HERDR_WORKSPACE_ID="ws"/);
  assert.match(text, /shell_environment_policy\.set\.HERDR_WORKTREE=/);
  assert.equal(f.starts.length, 0);
  const other = startFixture();
  other.start('ocdry', { kind: 'opencode', dryRun: true });
  assert.doesNotMatch(other.lines.join('\n'), /shell_environment_policy/);
});

// A fake codex prints the result line that the prompt asks for. It reports "set" for each -c value it receives.
function fakeCodexBin({ mode = 'echo' } = {}) {
  const bin = tempDir('herdr-codexenv-bin-');
  const log = path.join(bin, 'calls.json');
  const script = `#!${process.execPath}
const fs = process.getBuiltinModule('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(args));
const has = (name) => args.some((arg) => arg.startsWith('shell_environment_policy.set.' + name + '='));
const mode = ${JSON.stringify(mode)};
if (mode === 'fail') { console.error('boom'); process.exit(2); }
if (mode === 'hang') setTimeout(() => {}, 60000);
else {
  console.log('Ran the command. Output:');
  console.log('HERDR_ENV=' + (has('HERDR_ENV') ? 'set' : '') + ' PANE=' + (has('HERDR_PANE_ID') ? 'set' : ''));
}
`;
  fs.writeFileSync(path.join(bin, 'codex'), script, { mode: 0o755 });
  return { bin, log };
}

test('liveCodexCheck runs codex exec with the shell variables and parses set and missing', () => {
  const { bin, log } = fakeCodexBin();
  const env = { ...ORCH, PATH: `${bin}:${process.env.PATH}` };
  const good = liveCodexCheck({ env, modelsFile: MODELS });
  assert.equal(good.status, 'ok');
  assert.deepEqual(good.values, { HERDR_ENV: 'set', HERDR_PANE_ID: 'set' });
  assert.match(good.text, /HERDR_ENV set, HERDR_PANE_ID set/);
  const args = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.equal(args[0], 'exec');
  for (const flags of [['-m', 'gpt-6-luna'], ['-c', 'model_reasoning_effort=low'], ['-s', 'workspace-write']]) {
    assert.ok(args.some((arg, index) => arg === flags[0] && args[index + 1] === flags[1]), flags.join(' '));
  }
  assert.ok(args.includes('--skip-git-repo-check'));
  assert.equal(setArgs(args).HERDR_PANE_ID, 'ws:orch');
  assert.match(args.at(-1), /\$\{HERDR_ENV:\+set\}/);

  const { HERDR_PANE_ID, ...noPane } = ORCH;
  const missing = liveCodexCheck({ env: { ...noPane, PATH: env.PATH }, modelsFile: MODELS });
  assert.equal(missing.status, 'missing');
  assert.deepEqual(missing.values, { HERDR_ENV: 'set', HERDR_PANE_ID: 'missing' });
  assert.doesNotMatch(missing.text, /ws:orch|fake/);
});

test('liveCodexCheck reports a failed or timed-out codex without a value', () => {
  const failed = fakeCodexBin({ mode: 'fail' });
  const bad = liveCodexCheck({ env: { ...ORCH, PATH: `${failed.bin}:${process.env.PATH}` }, modelsFile: MODELS });
  assert.equal(bad.status, 'bad');
  assert.deepEqual(bad.values, { HERDR_ENV: 'missing', HERDR_PANE_ID: 'missing' });
  const hung = fakeCodexBin({ mode: 'hang' });
  const late = liveCodexCheck({ env: { ...ORCH, PATH: `${hung.bin}:${process.env.PATH}` }, modelsFile: MODELS, timeoutMs: 500 });
  assert.equal(late.status, 'bad');
  assert.match(late.text, /timed out/);
});

test('harness check runs codex only with --live-codex', () => {
  const { bin, log } = fakeCodexBin();
  const home = tempDir('herdr-codexenv-home-');
  const dataDir = tempDir('herdr-codexenv-data-');
  const env = { ...ORCH, PATH: `${bin}:${process.env.PATH}`, HOME: home, HERDR_BOSS_DIR: dataDir };
  const plain = spawnSync(process.execPath, [CLI, 'harness', 'check'], { env, encoding: 'utf8' });
  assert.match(plain.stdout, /harness check: /);
  assert.equal(fs.existsSync(log), false);
  const live = spawnSync(process.execPath, [CLI, 'harness', 'check', '--live-codex'], { env, encoding: 'utf8' });
  assert.match(live.stdout, /^ok\s+codex live: HERDR_ENV set, HERDR_PANE_ID set$/m);
  assert.equal(fs.existsSync(log), true);
  assert.doesNotMatch(live.stdout, /ws:orch|\/fake\//);
  const wrong = spawnSync(process.execPath, [CLI, 'harness', 'check', '--nope'], { env, encoding: 'utf8' });
  assert.notEqual(wrong.status, 0);
});
