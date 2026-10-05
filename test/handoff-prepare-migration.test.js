import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { activationFixture, handoffFixture, runHandoffCli, runHandoffModule, WORKER_LINE, writeRuns } from './helpers/handoff-fixture.js';

test('migration planning reports the Claude ancestry cycle with a fresh-mode recovery path', (t) => {
  const f = handoffFixture(t, { sourceKind: 'claude', sessionId: 'claude-session' });
  const plan = JSON.parse(runHandoffCli(f.root, ['handoff', 'plan', 'ws:p1', '--to', 'codex', '--mode', 'migrate'], {
    ...f.env, TEST_MIGRATION_CYCLE: '1',
  }));
  assert.equal(plan.migration.available, false);
  assert.match(plan.migration.error, /Claude active graph contains an ancestry cycle/);
  assert.match(plan.migration.next, /Owner.*--mode fresh/);
});

test('fresh handoff carries only the published Owner goal and redacted recent context into an automatic prompt', (t) => {
  const f = handoffFixture(t);
  fs.mkdirSync(path.join(f.root, 'projects'));
  fs.writeFileSync(path.join(f.root, 'projects', 'project.json'), JSON.stringify({ goal: 'Finish the release safely.', tasks: [{ title: 'Ignore this as a goal' }] }));
  const source = 'Bearer abcDEF1234567890\nOPENAI_API_KEY=sk-verysecret123456789\npassword: hunter2\nghp_abcdef1234567890\n{"password":"fixture_secret","api_key":"fixture_key"}\nContinue from the failing test.';
  const result = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'fresh', '--auto'], { ...f.env, TEST_SOURCE_TEXT: source }));
  assert.equal(result.ownerGoal, 'Finish the release safely.');
  assert.equal(result.mode, 'fresh');
  assert.match(result.sourceContext, /\[REDACTED\]/);
  assert.doesNotMatch(result.sourceContext, /abcDEF|verysecret|hunter2|abcdef1234567890|fixture_secret|fixture_key/);
  assert.doesNotMatch(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'), /fixture_secret|fixture_key/);
  const calls = fs.readFileSync(f.callsFile, 'utf8').trim().split('\n').map(JSON.parse);
  const prompt = calls.find((args) => args[0] === 'agent' && args[1] === 'prompt')[3];
  assert.match(prompt, /Finish the release safely/);
  assert.match(prompt, /\n\[herdr-boss\] The current Owner goal is: Finish the release safely\./);
  assert.doesNotMatch(prompt, /^\/goal/m, 'the prepared prompt never contains a goal command line');
  assert.match(prompt, /historical context/i);
  assert.match(prompt, /Continue from the failing test/);
  assert.match(prompt, /handoff ready /);
  assert.doesNotMatch(prompt, /abcDEF|verysecret|hunter2|abcdef1234567890|fixture_secret|fixture_key/);
  assert.ok(calls.some((args) => args[0] === 'pane' && args[1] === 'read' && args[2] === 'ws:p1' && args.includes('recent')));
});

test('project standby prompt names the project memory file and says it is present', (t) => {
  const f = handoffFixture(t);
  const memory = path.join(f.project, 'docs', 'orchestration', 'memory.md');
  fs.mkdirSync(path.dirname(memory), { recursive: true });
  fs.writeFileSync(memory, '## Owner decisions in force\n');

  runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'fresh'], f.env);

  const calls = fs.readFileSync(f.callsFile, 'utf8').trim().split('\n').map(JSON.parse);
  const prompt = calls.find((args) => args[0] === 'agent' && args[1] === 'prompt')[3];
  assert.match(prompt, /docs\/orchestration\/memory\.md/);
  assert.match(prompt, /Read docs\/orchestration\/memory\.md first\./);
  // K27: the bootstrap read is capped to the memory file, the published status, and the open items.
  assert.ok(prompt.indexOf('docs/orchestration/memory.md') < prompt.indexOf('published project status'), 'the successor reads project memory first');
  assert.match(prompt, /memory file is present/i);
});

test('project standby prompt says to report when the project memory file is missing', (t) => {
  const f = handoffFixture(t);

  runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'fresh'], f.env);

  const calls = fs.readFileSync(f.callsFile, 'utf8').trim().split('\n').map(JSON.parse);
  const prompt = calls.find((args) => args[0] === 'agent' && args[1] === 'prompt')[3];
  assert.match(prompt, /docs\/orchestration\/memory\.md/);
  assert.match(prompt, /memory file is missing/i);
  assert.match(prompt, /report that it is missing/i);
});

test('Boss standby prompt uses only the private Boss memory file', (t) => {
  const f = handoffFixture(t, { sourceLabel: 'boss' });
  const memory = path.join(f.root, '.herdr-boss', 'boss-memory.md');
  fs.mkdirSync(path.dirname(memory), { recursive: true });
  fs.writeFileSync(memory, '## Roles and panes\n');

  runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'fresh'], f.env);

  const calls = fs.readFileSync(f.callsFile, 'utf8').trim().split('\n').map(JSON.parse);
  const prompt = calls.find((args) => args[0] === 'agent' && args[1] === 'prompt')[3];
  assert.match(prompt, /~\/\.herdr-boss\/boss-memory\.md/);
  assert.match(prompt, /memory file is present/i);
  assert.doesNotMatch(prompt, /docs\/orchestration\/memory\.md/);
});

test('migration success retains its session and does not capture the source pane', (t) => {
  const f = handoffFixture(t, { sessionId: 'old-session' });
  const result = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'codex', '--mode', 'migrate'], f.env));
  assert.equal(result.mode, 'migrate');
  assert.equal(result.migratedId, 'migrated-session');
  const calls = fs.readFileSync(f.callsFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.some((args) => args[0] === 'pane' && args[1] === 'read' && args[2] === 'ws:p1'), false);
});

for (const [reason, env] of [
  ['unavailable', { TEST_MIGRATION_CYCLE: '1' }],
  ['failed', { TEST_TRANSFER_FAIL: '1' }],
  ['no target ID', { TEST_NO_TARGET_ID: '1' }],
]) test(`migration ${reason} falls back to fresh with source context`, (t) => {
  const f = handoffFixture(t, { sessionId: 'old-session' });
  const result = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'codex', '--mode', 'migrate'], { ...f.env, ...env, TEST_SOURCE_TEXT: 'Useful prior work' }));
  assert.equal(result.mode, 'fresh');
  assert.equal(result.migratedId, null);
  assert.match(result.migrationFallbackReason, /.+/);
  assert.match(result.sourceContext, /Useful prior work/);
});

function codexEnvFixture(t, options = {}) {
  const f = handoffFixture(t, options);
  const tmp = path.join(f.root, 'caller-tmp');
  fs.mkdirSync(tmp);
  f.env = { ...f.env, HERDR_SOCKET_PATH: path.join(f.root, 'herdr.sock'), HERDR_BIN_PATH: path.join(f.root, '.local', 'bin', 'herdr'), TMPDIR: tmp };
  return f;
}

function successorStartArgs(f) {
  const calls = fs.readFileSync(f.callsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const start = calls.find((args) => args[0] === 'agent' && args[1] === 'start');
  return start.slice(start.indexOf('--') + 1);
}

function shellEnvSettings(args) {
  const settings = {};
  args.forEach((arg, index) => {
    const match = /^shell_environment_policy\.set\.([A-Z_]+)="(.*)"$/.exec(arg);
    if (match) {
      assert.equal(args[index - 1], '-c', `${match[1]} must follow -c`);
      settings[match[1]] = match[2];
    }
  });
  return settings;
}

test('a codex fresh successor gets the Herdr variables of its new pane as shell environment settings', (t) => {
  const f = codexEnvFixture(t);
  const result = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'codex', '--mode', 'fresh'], f.env));
  assert.equal(result.status, 'prepared');
  assert.equal(result.newPane, 'ws:p2');
  assert.deepEqual(shellEnvSettings(successorStartArgs(f)), {
    HERDR_ENV: '1', HERDR_PANE_ID: 'ws:p2', HERDR_TAB_ID: 'ws:t2', HERDR_WORKSPACE_ID: 'ws',
    HERDR_SOCKET_PATH: f.env.HERDR_SOCKET_PATH, HERDR_BIN_PATH: f.env.HERDR_BIN_PATH, TMPDIR: f.env.TMPDIR,
  });
});

test('a codex migrated successor gets the same shell environment settings after its resume arguments', (t) => {
  const f = codexEnvFixture(t, { sessionId: 'old-session' });
  const result = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'codex', '--mode', 'migrate'], f.env));
  assert.equal(result.mode, 'migrate');
  const args = successorStartArgs(f);
  assert.deepEqual(args.slice(0, 2), ['resume', 'migrated-session']);
  assert.deepEqual(shellEnvSettings(args), {
    HERDR_ENV: '1', HERDR_PANE_ID: 'ws:p2', HERDR_TAB_ID: 'ws:t2', HERDR_WORKSPACE_ID: 'ws',
    HERDR_SOCKET_PATH: f.env.HERDR_SOCKET_PATH, HERDR_BIN_PATH: f.env.HERDR_BIN_PATH, TMPDIR: f.env.TMPDIR,
  });
});

test('fresh and migrated Codex handovers pass the project browser override to agent start', (t) => {
  for (const mode of ['fresh', 'migrate']) {
    const f = codexEnvFixture(t, { sessionId: mode === 'migrate' ? 'old-session' : null });
    const handoffUrl = new URL('../src/handoff.js', import.meta.url).href;
    const source = `import { prepareHandoff } from ${JSON.stringify(handoffUrl)};
const projects = [];
const result = prepareHandoff('ws:p1', 'codex', { mode: ${JSON.stringify(mode)} }, {
  browserLookup: (project) => { projects.push(project); return { port: 9247 }; },
});
console.log(JSON.stringify({ result, projects }));`;
    const { result, projects } = JSON.parse(runHandoffModule(f.root, source, f.env));
    assert.equal(result.status, 'prepared');
    assert.deepEqual(projects, ['project']);
    const args = successorStartArgs(f);
    const override = 'mcp_servers.chrome-devtools.args=["chrome-devtools-mcp@latest","--browserUrl=http://127.0.0.1:9247"]';
    assert.ok(args.some((arg, index) => arg === '-c' && args[index + 1] === override));
    if (mode === 'migrate') assert.deepEqual(args.slice(0, 2), ['resume', 'migrated-session']);
  }
});

test('a claude successor gets no shell environment settings', (t) => {
  const f = codexEnvFixture(t);
  const result = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'claude', '--mode', 'fresh'], f.env));
  assert.equal(result.status, 'prepared');
  const args = successorStartArgs(f);
  assert.equal(args.some((arg) => arg.includes('shell_environment_policy')), false);
  assert.equal(args[args.indexOf('--disallowedTools') + 1], 'AskUserQuestion');
});

test('a codex successor leaves out the shell environment settings with unknown values', (t) => {
  const f = handoffFixture(t);
  const env = { ...f.env, TEST_NO_TAB_ID: '1' };
  for (const name of ['HERDR_SOCKET_PATH', 'HERDR_BIN_PATH', 'TMPDIR', 'HERDR_WORKTREE']) delete env[name];
  const result = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'codex', '--mode', 'fresh'], env));
  assert.equal(result.status, 'prepared');
  assert.deepEqual(shellEnvSettings(successorStartArgs(f)), { HERDR_ENV: '1', HERDR_PANE_ID: 'ws:p2', HERDR_WORKSPACE_ID: 'ws' });
});

test('a codex successor refuses a caller value with a quote before it creates a tab', (t) => {
  const f = codexEnvFixture(t);
  assert.throws(() => runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'codex', '--mode', 'fresh'], {
    ...f.env, HERDR_BIN_PATH: `${f.root}/bad"path`,
  }), (error) => /HERDR_BIN_PATH has a quote/.test(String(error.stderr)) && !String(error.stderr).includes('bad"path'));
  assert.equal(fs.existsSync(path.join(f.root, 'handoffs.json')), false);
  const calls = fs.existsSync(f.callsFile) ? fs.readFileSync(f.callsFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  assert.equal(calls.some((args) => args[0] === 'tab' && args[1] === 'create'), false);
});

test('a resumed codex successor uses the recorded tab of its existing pane', (t) => {
  const existingPane = 'wA:pB';
  const f = codexEnvFixture(t, { existingPane });
  fs.writeFileSync(path.join(f.root, 'handoffs.json'), JSON.stringify([{
    id: 'handoff-project-abc123', sourcePane: 'ws:p1', workspace: 'ws', cwd: f.project, project: 'project',
    toKind: 'codex', model: null, effort: null, mode: 'fresh', migratedId: null, newPane: existingPane, newTab: 'wA:tC',
    status: 'needs-inspection', automatic: false, promptError: 'shell was still starting',
  }]));
  const result = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'codex', '--mode', 'fresh'], f.env));
  assert.equal(result.status, 'prepared');
  const settings = shellEnvSettings(successorStartArgs(f));
  assert.equal(settings.HERDR_PANE_ID, existingPane);
  assert.equal(settings.HERDR_TAB_ID, 'wA:tC');
  assert.equal(settings.HERDR_WORKSPACE_ID, 'ws');
});
