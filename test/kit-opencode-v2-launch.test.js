import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { loadModels } from '../src/kit/config.js';
import { startWorker } from './helpers/start-worker.js';
import { openCodeConfigText, opencodeTuiAcceptsModelFlags, resetOpenCodeTuiFlagsCache, unsupportedOpenCodeFlag } from '../src/kit/opencode-cli.js';
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

test('unsupportedOpenCodeFlag names the refused flag and ignores other text', () => {
  assert.equal(unsupportedOpenCodeFlag('ERROR\n  Unrecognized flag: -m in command opencode'), '-m');
  assert.equal(unsupportedOpenCodeFlag('Unrecognized flag: --agent in command opencode'), '--agent');
  assert.equal(unsupportedOpenCodeFlag('Did you mean this?'), null);
  assert.equal(unsupportedOpenCodeFlag(undefined), null);
});

test('openCodeConfigText selects the model and the worker agent', () => {
  assert.deepEqual(JSON.parse(openCodeConfigText(MODEL)), {
    $schema: 'https://opencode.ai/config.json', model: MODEL, default_agent: 'worker',
  });
});

// A worker start fixture with an injectable capability answer and a fake pane.
function startFixture(t, name, { tuiModelFlags = false, flagError = null } = {}) {
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
    wait: () => {}, output: () => {}, tuiSupportsModelFlags: () => tuiModelFlags,
    readProcessStart: () => 'Mon Sep 28 10:00:00 2026',
  });
  return { f, commands, herdr, start, excludeFile };
}

test('a v2 launch sets the model and agent in opencode.json and passes no -m or --agent', (t) => {
  const fx = startFixture(t, 'oc-v2-config', { tuiModelFlags: false });
  const run = fx.start();
  assert.equal(run.model, MODEL);
  const startArgs = fx.commands.find((args) => args[0] === 'agent' && args[1] === 'start');
  const afterDash = startArgs.slice(startArgs.indexOf('--') + 1);
  assert.deepEqual(afterDash, [], 'the v2 TUI gets no launch flags');
  const config = JSON.parse(fs.readFileSync(path.join(run.worktree, 'opencode.json'), 'utf8'));
  assert.equal(config.model, MODEL);
  assert.equal(config.default_agent, 'worker');
  assert.match(fs.readFileSync(fx.excludeFile, 'utf8'), /^\/opencode\.json$/m);
});

test('a TUI that accepts the flags keeps the old launch path and writes no config file', (t) => {
  const fx = startFixture(t, 'oc-v1-flags', { tuiModelFlags: true });
  const run = fx.start();
  const startArgs = fx.commands.find((args) => args[0] === 'agent' && args[1] === 'start');
  const afterDash = startArgs.slice(startArgs.indexOf('--') + 1);
  assert.deepEqual(afterDash, ['-m', MODEL, '--agent', 'worker']);
  assert.equal(fs.existsSync(path.join(run.worktree, 'opencode.json')), false);
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
