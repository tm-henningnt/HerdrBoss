import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { handoffFixture, runHandoffCli, runHandoffModule, writeExecutable } from './helpers/handoff-fixture.js';

// The fake OpenCode CLI from test/kit-opencode-v2-launch.test.js. A v2 TUI accepts no --model and no --agent flag.
function fakeOpenCode(root, { acceptFlags = false } = {}) {
  const file = path.join(root, '.local', 'bin', 'opencode');
  const flags = acceptFlags
    ? '  --model string          Model to use in the format provider/model#variant\n  --agent string          Agent to use\n'
    : '  --prompt string         Prompt to use\n';
  writeExecutable(file, `#!/bin/sh
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
`);
  return file;
}

function startArgs(f) {
  const calls = fs.readFileSync(f.callsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const start = calls.find((args) => args[0] === 'agent' && args[1] === 'start');
  assert.ok(start, 'the handoff starts a successor agent');
  return start.slice(start.indexOf('--') + 1);
}

test('a v2 opencode successor writes a project config and passes no launch flags', (t) => {
  const f = handoffFixture(t);
  execFileSync('git', ['init', '-q'], { cwd: f.project });
  fakeOpenCode(f.root, { acceptFlags: false });
  const result = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'opencode', '--mode', 'fresh'], f.env));
  assert.equal(result.status, 'prepared');
  assert.equal(result.toKind, 'opencode');
  assert.deepEqual(startArgs(f), [], 'the v2 TUI gets no launch flags');
  const config = JSON.parse(fs.readFileSync(path.join(f.project, 'opencode.json'), 'utf8'));
  assert.equal(config.model, result.model);
  assert.equal(config.default_agent, 'worker');
  const exclude = fs.readFileSync(path.join(f.project, '.git', 'info', 'exclude'), 'utf8');
  assert.match(exclude, /^\/opencode\.json$/m, 'the config stays out of the commit');
});

test('an opencode TUI that accepts the flags keeps the old launch path and writes no config', (t) => {
  const f = handoffFixture(t);
  fakeOpenCode(f.root, { acceptFlags: true });
  const result = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'opencode', '--mode', 'fresh'], f.env));
  assert.equal(result.status, 'prepared');
  assert.deepEqual(startArgs(f), ['-m', result.model, '--agent', 'worker']);
  assert.equal(fs.existsSync(path.join(f.project, 'opencode.json')), false);
});

test('an Unrecognized flag on the successor pane fails loudly and marks the record for inspection', (t) => {
  const f = handoffFixture(t);
  fakeOpenCode(f.root, { acceptFlags: true });
  const env = { ...f.env, TEST_SHELL_AFTER_START: 'ERROR\n  Unrecognized flag: -m in command opencode\n  Did you mean this?\n' };
  const handoffUrl = new URL('../src/handoff.js', import.meta.url).href;
  const result = JSON.parse(runHandoffModule(f.root, `import { prepareHandoff } from ${JSON.stringify(handoffUrl)};
try { prepareHandoff('ws:p1', 'opencode', { mode: 'fresh' }); console.log(JSON.stringify({ ok: true })); }
catch (error) { console.log(JSON.stringify({ ok: false, code: error.code, message: error.message })); }`, env));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'opencode_unsupported_flag');
  assert.match(result.message, /Unrecognized flag: -m/);
  const records = JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'));
  assert.equal(records[0].status, 'needs-inspection');
  assert.match(records[0].promptError, /Unrecognized flag: -m/);
  assert.equal(fs.existsSync(path.join(f.root, 'unavailable-models.json')), false, 'a refused flag marks no model');
});
