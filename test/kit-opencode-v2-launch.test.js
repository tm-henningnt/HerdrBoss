import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { loadModels } from '../src/kit/config.js';
import { startWorker } from './helpers/start-worker.js';
import { detectOpenCodeCli, openCodeConfigText, opencodeTuiAcceptsModelFlags, resetOpenCodeTuiFlagsCache, unsupportedOpenCodeFlag } from '../src/kit/opencode-cli.js';
import { git, setupFixture } from './helpers/kit-fixture.js';

const MODEL = 'opencode/mimo-v2.6-flash-free';

// A fake OpenCode v2 CLI. The bare TUI accepts no --model and no --agent flag.
function fakeOpenCode(t, { acceptFlags = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-fake-opencode-'));
  const file = path.join(dir, 'opencode');
  const flags = acceptFlags
    ? '  --model string          Model to use in the format provider/model#variant\n  --agent string          Agent to use\n'
    : '  --prompt string         Prompt to use\n';
  fs.writeFileSync(file, `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    --help|-h)
      printf '%s\\n' 'DESCRIPTION' '  OpenCode command line interface' '' 'FLAGS' '  --standalone            Run with a private server' '${flags}'
      exit 0
      ;;
    -m|--model|--agent)
      printf '%s\\n' 'ERROR' "  Unrecognized flag: $arg in command opencode" '' '  Did you mean this?' '-' >&2
      exit 1
      ;;
  esac
done
printf '%s\\n' 'tui'
`, { mode: 0o755 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return file;
}

// Run the fake CLI through the detection helper with an explicit executable path.
function runFake(file) {
  return (command, args, options) => execFileSync(file, args, options);
}

test('the capability check tells a v2 TUI from a TUI that accepts the flags and caches the answer', (t) => {
  const v2 = fakeOpenCode(t);
  const v1 = fakeOpenCode(t, { acceptFlags: true });
  try {
    resetOpenCodeTuiFlagsCache();
    assert.equal(opencodeTuiAcceptsModelFlags({ run: runFake(v2) }), false);
    // The cached answer holds for the process, also for another reader.
    assert.equal(opencodeTuiAcceptsModelFlags({ run: runFake(v1) }), false, 'the first answer is cached');
    assert.equal(opencodeTuiAcceptsModelFlags({ run: runFake(v1), refresh: true }), true);
    assert.equal(opencodeTuiAcceptsModelFlags({ run: runFake(v2), refresh: true }), false);
  } finally { resetOpenCodeTuiFlagsCache(); }
});

test('OpenCode 1.18 help selects the unchanged TUI flags', () => {
  const profile = detectOpenCodeCli({ refresh: true, run: stubHelp({
    version: 'opencode v1.18.2',
    top: 'USAGE\n  opencode [flags]\nFLAGS\n  -m, --model string  Model\n  --agent string      Agent\n',
    run: 'USAGE\n  opencode run [flags] [<message...>]\nFLAGS\n  --model string  Model\n',
  }) });
  assert.deepEqual(profile, { version: '1.18.2', mode: 'tui', modelFlag: '-m', agentFlag: '--agent', config: false });
});

test('OpenCode 1.x falls back to legacy TUI flags when help cannot be read', () => {
  const profile = detectOpenCodeCli({ refresh: true, run: (_command, args) => {
    if (args[0] === '--version') return 'opencode v1.18.2';
    throw new Error('help unavailable');
  } });
  assert.deepEqual(profile, { version: '1.18.2', mode: 'tui', modelFlag: '-m', agentFlag: '--agent', config: false });
});

test('unreadable or unversioned OpenCode falls back to cached legacy TUI flags', () => {
  let calls = 0;
  const run = () => { calls++; throw new Error('OpenCode help unavailable'); };
  try {
    resetOpenCodeTuiFlagsCache();
    const first = detectOpenCodeCli({ run });
    const second = detectOpenCodeCli({ run: () => { throw new Error('detection was not cached'); } });
    const expected = { version: null, mode: 'tui', modelFlag: '-m', agentFlag: '--agent', config: false };
    assert.deepEqual(first, expected);
    assert.deepEqual(second, expected);
    assert.equal(calls, 3, 'version and both help commands are checked only once');
  } finally { resetOpenCodeTuiFlagsCache(); }
});

test('OpenCode version comes only from an anchored version output line', () => {
  const profile = detectOpenCodeCli({ refresh: true, run: stubHelp({
    version: 'diagnostic build 9.8.7',
    top: 'OpenCode help version 8.7.6\nFLAGS\n  --model string  Model\n  --agent string  Agent\n',
    run: 'OpenCode run help version 7.6.5\nFLAGS\n  --model string  Model\n  --agent string  Agent\n',
  }) });
  assert.deepEqual(profile, { version: null, mode: 'tui', modelFlag: '-m', agentFlag: '--agent', config: false });

  const valid = detectOpenCodeCli({ refresh: true, run: stubHelp({
    version: 'opencode CLI v3.1.4',
    top: 'USAGE\n  opencode <subcommand> [flags]\n',
    run: 'FLAGS\n  --model string  Model\n',
  }) });
  assert.deepEqual(valid, { version: '3.1.4', mode: 'run', modelFlag: '--model', agentFlag: null, config: true });
});

test('OpenCode 3.x requires run help to accept the long --model flag', () => {
  assert.throws(() => detectOpenCodeCli({ refresh: true, run: stubHelp({
    version: '3.2.0',
    top: 'USAGE\n  opencode <subcommand> [flags]\n',
    run: 'USAGE\n  opencode run [flags] [<message...>]\nFLAGS\n  -m string  Model\n',
  }) }), /opencode run --model/);
});

test('OpenCode 2.0.25 help selects run flags and keeps the brief as its message', () => {
  const profile = detectOpenCodeCli({ refresh: true, run: stubHelp({
    version: 'opencode v2.0.25',
    top: 'USAGE\n  opencode <subcommand> [flags]\nFLAGS\n  --prompt string  Prompt\nSUBCOMMANDS\n  run  Run OpenCode with a message\n',
    run: 'USAGE\n  opencode run [flags] [<message...>]\nFLAGS\n  --model, -m string  Model\n  --agent string      Agent\n',
  }) });
  assert.deepEqual(profile, { version: '2.0.25', mode: 'run', modelFlag: '--model', agentFlag: '--agent', config: false });
});

test('OpenCode run without an agent flag selects the worker and model through config', () => {
  const profile = detectOpenCodeCli({ refresh: true, run: stubHelp({
    version: 'opencode v2.0.25',
    top: 'USAGE\n  opencode <subcommand> [flags]\nSUBCOMMANDS\n  run  Run OpenCode with a message\n',
    run: 'USAGE\n  opencode run [flags] [<message...>]\nFLAGS\n  --model string  Model\n',
  }) });
  assert.deepEqual(profile, { version: '2.0.25', mode: 'run', modelFlag: '--model', agentFlag: null, config: true });
});

test('OpenCode help with no supported launch form names the missing flags', () => {
  assert.throws(() => detectOpenCodeCli({ refresh: true, run: stubHelp({
    version: 'opencode v2.0.25',
    top: 'USAGE\n  opencode <subcommand> [flags]\nSUBCOMMANDS\n  run  Run OpenCode with a message\n',
    run: 'USAGE\n  opencode run [flags] [<message...>]\nFLAGS\n  --standalone  Private server\n',
  }) }), /opencode run --model/);
});

function stubHelp({ version, top, run }) {
  return (_command, args) => {
    if (args[0] === '--version') return version;
    if (args[0] === '--help') return top;
    if (args[0] === 'run' && args[1] === '--help') return run;
    throw new Error(`unexpected opencode args: ${args.join(' ')}`);
  };
}

test('unsupportedOpenCodeFlag names the refused flag and ignores other text', () => {
  assert.equal(unsupportedOpenCodeFlag('ERROR\n  Unrecognized flag: -m in command opencode'), '-m');
  assert.equal(unsupportedOpenCodeFlag('Unrecognized flag: --agent in command opencode'), '--agent');
  assert.equal(unsupportedOpenCodeFlag('Unrecognized flag: --agent in command opencode run'), '--agent');
  assert.equal(unsupportedOpenCodeFlag('Did you mean this?'), null);
  assert.equal(unsupportedOpenCodeFlag(undefined), null);
});

test('openCodeConfigText selects the model and the worker agent', () => {
  assert.deepEqual(JSON.parse(openCodeConfigText(MODEL)), {
    $schema: 'https://opencode.ai/config.json', model: MODEL, default_agent: 'worker',
  });
});

// A worker start fixture with an injectable capability answer and a fake pane.
function startFixture(t, name, { tuiModelFlags = false, openCodeProfile = null, openCodeCliDetector = null, flagError = null } = {}) {
  const f = setupFixture(null);
  f.env.HERDR_BOSS_DIR = path.join(f.root, 'boss-data');
  const commands = [];
  let registered = false;
  let screen = '% ';
  const herdr = (args) => {
    commands.push(args);
    if (args[0] === 'agent' && args[1] === 'get') {
      if (!registered) throw Object.assign(new Error('agent_not_found: fake TUI exited'), { code: 'agent_not_found' });
      return { agent: { name, pane_id: 'ws:p2', agent: 'opencode', agent_status: 'idle', interactive_ready: true } };
    }
    if (args[0] === 'agent' && args[1] === 'start') {
      registered = true;
      if (flagError) screen = `ERROR\n  Unrecognized flag: ${flagError} in command opencode\n  Did you mean this?\n% `;
      return {};
    }
    if (args[0] === 'agent' && args[1] === 'close') { registered = false; return {}; }
    if (args[0] === 'pane' && args[1] === 'read') return { text: screen };
    if (args[0] === 'pane' && args[1] === 'close') { registered = false; return f.herdr(args); }
    return f.herdr(args);
  };
  t.after(() => {
    try { git(f.root, 'worktree', 'remove', '--force', f.config.worktreePath(name)); } catch {}
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  const excludeFile = path.resolve(f.root, git(f.root, 'rev-parse', '--git-path', 'info/exclude'));
  const start = (options = {}) => startWorker(name, { kind: 'opencode', task: 'x', allow: ['src/'], model: MODEL, ...options }, {
    config: f.config, models: loadModels(), herdr, env: f.env, rulesFile: f.rulesFile,
    wait: () => {}, output: () => {},
    ...(openCodeCliDetector ? { openCodeCliDetector } : {}),
    ...(openCodeProfile ? { openCodeCliDetector: () => openCodeProfile } : {}),
    ...(!openCodeCliDetector && !openCodeProfile ? { tuiSupportsModelFlags: () => tuiModelFlags } : {}),
    readProcessStart: () => 'Mon Sep 28 10:00:00 2026',
  });
  return { f, commands, herdr, start, excludeFile };
}

test('a v2 launch runs the brief as a message in the Herdr pane and records the CLI version', (t) => {
  const fx = startFixture(t, 'oc-v2-run', { openCodeProfile: { version: '2.0.25', mode: 'run', modelFlag: '--model', agentFlag: '--agent', config: false } });
  const run = fx.start();
  assert.equal(run.model, MODEL);
  assert.equal(run.opencodeVersion, '2.0.25');
  assert.equal(JSON.parse(fs.readFileSync(run.recordFile, 'utf8')).opencodeVersion, '2.0.25');
  const startArgs = fx.commands.find((args) => args[0] === 'agent' && args[1] === 'start');
  const afterDash = startArgs.slice(startArgs.indexOf('--') + 1);
  assert.deepEqual(afterDash, ['run', '--model', MODEL, '--agent', 'worker', 'Read .worker/brief.md in your working directory and execute it.']);
  assert.equal(fx.commands.some((args) => args[0] === 'agent' && args[1] === 'prompt'), false, 'the run message carries the brief');
  assert.equal(fs.existsSync(path.join(run.worktree, 'opencode.json')), false);
});

test('a v2 run without an agent flag writes worker and model config', (t) => {
  const profile = { version: '2.0.25', mode: 'run', modelFlag: '--model', agentFlag: null, config: true };
  const fx = startFixture(t, 'oc-v2-config', { openCodeProfile: profile });
  const run = fx.start();
  const startArgs = fx.commands.find((args) => args[0] === 'agent' && args[1] === 'start');
  assert.deepEqual(startArgs.slice(startArgs.indexOf('--') + 1), ['run', '--model', MODEL, 'Read .worker/brief.md in your working directory and execute it.']);
  const config = JSON.parse(fs.readFileSync(path.join(run.worktree, 'opencode.json'), 'utf8'));
  assert.equal(config.model, MODEL);
  assert.equal(config.default_agent, 'worker');
  assert.match(fs.readFileSync(fx.excludeFile, 'utf8'), /^\/opencode\.json$/m);
  assert.equal(run.opencodeVersion, '2.0.25');
});

test('an existing opencode.json stays unchanged and the run flag carries the model', (t) => {
  const profile = { version: '2.0.25', mode: 'run', modelFlag: '--model', agentFlag: null, config: true };
  const fx = startFixture(t, 'oc-v2-existing-config', { openCodeProfile: profile });
  const configPath = path.join(fx.f.root, 'opencode.json');
  const original = '{"model":"existing/model","default_agent":"custom"}\n';
  fs.writeFileSync(configPath, original);
  const run = fx.start({ noWorktree: true });
  const startArgs = fx.commands.find((args) => args[0] === 'agent' && args[1] === 'start');
  assert.deepEqual(startArgs.slice(startArgs.indexOf('--') + 1), ['run', '--model', MODEL, 'Read .worker/oc-v2-existing-config/brief.md in your working directory and execute it.']);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.equal(run.worktree, fx.f.root);
});

test('OpenCode rejects model strings that look like flags or contain whitespace or controls', (t) => {
  const fx = startFixture(t, 'oc-v2-invalid-model', { openCodeProfile: { version: '2.0.25', mode: 'run', modelFlag: '--model', agentFlag: '--agent', config: false } });
  for (const model of ['--agent', 'model with space', 'model\tname', 'model\u0000name']) {
    assert.throws(() => fx.start({ model }), /OpenCode model must not start with a dash or contain whitespace or control characters/);
  }
});

test('a TUI that accepts the flags keeps the old launch path and writes no config file', (t) => {
  const fx = startFixture(t, 'oc-v1-flags', { openCodeProfile: { version: '1.18.2', mode: 'tui', modelFlag: '-m', agentFlag: '--agent', config: false } });
  const run = fx.start();
  const startArgs = fx.commands.find((args) => args[0] === 'agent' && args[1] === 'start');
  const afterDash = startArgs.slice(startArgs.indexOf('--') + 1);
  assert.deepEqual(afterDash, ['-m', MODEL, '--agent', 'worker']);
  assert.equal(run.opencodeVersion, '1.18.2');
  assert.equal(fs.existsSync(path.join(run.worktree, 'opencode.json')), false);
});

test('an OpenCode CLI with no accepted launch form fails before it creates a worktree', (t) => {
  const fx = startFixture(t, 'oc-no-launch', { openCodeCliDetector: () => detectOpenCodeCli({ refresh: true, run: stubHelp({
    version: 'opencode v2.0.25',
    top: 'USAGE\n  opencode <subcommand> [flags]\nSUBCOMMANDS\n  run  Run OpenCode with a message\n',
    run: 'USAGE\n  opencode run [flags] [<message...>]\nFLAGS\n  --standalone  Private server\n',
  }) }) });
  const worktree = fx.f.config.worktreePath('oc-no-launch');
  const runFile = path.join(fx.f.config.runsPath, 'oc-no-launch.json');
  assert.throws(() => fx.start(), /opencode run --model/);
  assert.equal(fs.existsSync(worktree), false);
  assert.equal(fs.existsSync(runFile), false);
});

test('an Unrecognized flag pane fails loudly, closes the pane, and removes the worktree and branch', (t) => {
  const fx = startFixture(t, 'oc-v2-flag-error', {
    tuiModelFlags: true,
    flagError: '-m',
  });
  const worktree = fx.f.config.worktreePath('oc-v2-flag-error');
  assert.throws(() => fx.start(), (error) => {
    assert.equal(error.code, 'opencode_unsupported_flag');
    assert.match(error.message, /Unrecognized flag: -m/);
    return true;
  });
  assert.equal(fx.commands.filter((args) => args[0] === 'agent' && args[1] === 'start').length, 1, 'the failure is not retried');
  assert.equal(fx.commands.filter((args) => args[0] === 'pane' && args[1] === 'close').length, 1, 'the pane is closed');
  assert.equal(fs.existsSync(worktree), false, 'the worktree is removed');
  assert.equal(git(fx.f.root, 'branch', '--list', 'oc-v2-flag-error').trim(), '', 'the branch is removed');
  const unavailable = path.join(fx.f.env.HERDR_BOSS_DIR, 'unavailable-models.json');
  assert.equal(fs.existsSync(unavailable), false, 'no model is marked unavailable');
});
