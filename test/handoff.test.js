import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function writeExecutable(file, source) {
  fs.writeFileSync(file, source);
  fs.chmodSync(file, 0o755);
}

function handoffFixture(t, { shell = '% ', delayShell = false, paneListFails = false, sourceKind = 'codex', sourceLabel = 'orch', sessionId = null, busyAttempts = 0, existingPane = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-boss-handoff-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, '.local', 'bin');
  const project = path.join(root, 'project');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  const callsFile = path.join(root, 'herdr-calls.jsonl');
  const processInfoFile = path.join(root, 'process-info-count');
  fs.writeFileSync(processInfoFile, '0');
  const agentStartFile = path.join(root, 'agent-start-count');
  fs.writeFileSync(agentStartFile, '0');
  writeExecutable(path.join(bin, 'herdr.cjs'), `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify(args) + '\\n');
let result = {};
if (args[0] === 'pane' && args[1] === 'get' && args[2] === 'ws:p1') result = { pane: {
  pane_id: 'ws:p1', workspace_id: 'ws', label: process.env.TEST_SOURCE_LABEL, agent: process.env.TEST_SOURCE_KIND,
  cwd: process.env.TEST_CWD, ...(process.env.TEST_SESSION_ID ? { agent_session: { kind: 'id', value: process.env.TEST_SESSION_ID } } : {}),
} };
if (args[0] === 'pane' && args[1] === 'get' && args[2] !== 'ws:p1') result = { pane: {
  pane_id: args[2], workspace_id: 'ws', foreground_cwd: process.env.TEST_CWD,
} };
if (args[0] === 'pane' && args[1] === 'list') {
  if (process.env.TEST_PANE_LIST_FAIL === '1') process.exit(1);
  result = { panes: [{ pane_id: 'ws:p1', workspace_id: 'ws' }, ...(process.env.TEST_EXISTING_PANE ? [{ pane_id: process.env.TEST_EXISTING_PANE, workspace_id: 'ws' }] : [])] };
}
if (args[0] === 'tab' && args[1] === 'create') result = { root_pane: { pane_id: 'ws:p2' } };
if (args[0] === 'agent' && args[1] === 'list') result = { agents: [] };
if (args[0] === 'agent' && args[1] === 'start') {
  const count = Number(fs.readFileSync(process.env.TEST_AGENT_START_FILE, 'utf8') || 0) + 1;
  fs.writeFileSync(process.env.TEST_AGENT_START_FILE, String(count));
  if (count <= Number(process.env.TEST_AGENT_BUSY_ATTEMPTS || 0)) {
    console.log(JSON.stringify({ error: { code: 'agent_pane_busy', message: 'Pane is busy.' } }));
    process.exit(0);
  }
}
if (args[0] === 'pane' && args[1] === 'process-info') {
  const count = Number(fs.readFileSync(process.env.TEST_PROCESS_INFO_FILE, 'utf8') || 0) + 1;
  fs.writeFileSync(process.env.TEST_PROCESS_INFO_FILE, String(count));
  const foregroundPid = process.env.TEST_DELAY_SHELL === '1' && count === 1 ? 11 : 10;
  result = { process_info: { shell_pid: 10, foreground_processes: [{ pid: foregroundPid, name: foregroundPid === 10 ? 'zsh' : 'login' }] } };
}
// Real herdr prints pane read --format text as plain text, not JSON.
if (args[0] === 'pane' && args[1] === 'read') {
  if (args[2] === 'ws:p1') {
    if (args.includes('recent') && process.env.TEST_RECENT_FAIL === '1') process.exit(1);
    if (args.includes('visible') && process.env.TEST_VISIBLE_FAIL === '1') process.exit(1);
    process.stdout.write(process.env.TEST_SOURCE_TEXT || '');
  } else process.stdout.write(process.env.TEST_SHELL || '');
  process.exit(0);
}
console.log(JSON.stringify({ result }));
`);
  writeExecutable(path.join(bin, 'herdr'), `#!/bin/sh
exec node "$(dirname "$0")/herdr.cjs" "$@"
`);
  writeExecutable(path.join(bin, 'session-migrate.cjs'), `
if (process.env.TEST_MIGRATION_CYCLE === '1' || (process.env.TEST_TRANSFER_FAIL === '1' && !process.argv.includes('--dry-run'))) {
  process.stderr.write(process.env.TEST_DRY_RUN_SECRET && process.argv.includes('--dry-run') ? 'Migration failed: api_key=fixture_dry_secret\\n' : 'Claude active graph contains an ancestry cycle\\n');
  process.exit(1);
}
console.log(JSON.stringify({ session_id: process.env.TEST_NO_TARGET_ID === '1' && !process.argv.includes('--dry-run') ? null : 'migrated-session', records: 1, dropped_events: 0, warnings: [] }));
`);
  writeExecutable(path.join(bin, 'session-migrate'), `#!/bin/sh
exec node "$(dirname "$0")/session-migrate.cjs" "$@"
`);
  fs.writeFileSync(path.join(root, 'policy.json'), JSON.stringify({ projects: {} }));
  fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({ control: { projects: {}, risks: {} } }));
  return {
    root,
    project,
    callsFile,
    processInfoFile,
    agentStartFile,
    env: {
      ...process.env,
      HOME: root,
      HERDR_BOSS_DIR: root,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      TEST_CWD: project,
      TEST_CALLS: callsFile,
      TEST_PROCESS_INFO_FILE: processInfoFile,
      TEST_AGENT_START_FILE: agentStartFile,
      TEST_AGENT_BUSY_ATTEMPTS: String(busyAttempts),
      TEST_SHELL: shell,
      TEST_DELAY_SHELL: delayShell ? '1' : '0',
      TEST_PANE_LIST_FAIL: paneListFails ? '1' : '0',
      TEST_SOURCE_LABEL: sourceLabel,
      ...(existingPane ? { TEST_EXISTING_PANE: existingPane } : {}),
      TEST_SOURCE_KIND: sourceKind,
      ...(sessionId ? { TEST_SESSION_ID: sessionId } : {}),
    },
  };
}

test('expireMissingHandoffs records absent successors from an explicit pane snapshot only', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-boss-handoff-expire-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const recordsFile = path.join(root, 'handoffs.json');
  fs.writeFileSync(recordsFile, JSON.stringify([
    { id: 'stale-preparing', newPane: 'ws:p2', status: 'preparing' },
    { id: 'stale-inspection', newPane: 'ws:p4', status: 'needs-inspection' },
    { id: 'live', newPane: 'ws:p3', status: 'preparing' },
    { id: 'prepared', newPane: 'ws:p5', status: 'prepared' },
  ]));
  const handoffUrl = new URL('../src/handoff.js', import.meta.url).href;
  const script = `import { expireMissingHandoffs, listHandoffs } from ${JSON.stringify(handoffUrl)};
  const expired = expireMissingHandoffs(JSON.parse(process.env.TEST_PANES));
  const invalidSnapshotExpired = expireMissingHandoffs(null);
  console.log(JSON.stringify({ expired: expired.map((item) => item.id), invalidSnapshotExpired, records: listHandoffs() }));`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    env: { ...process.env, HOME: root, HERDR_BOSS_DIR: root, TEST_PANES: JSON.stringify([{ id: 'ws:p1' }, { pane_id: 'ws:p3' }]) },
    encoding: 'utf8',
  }));
  assert.deepEqual(result.expired, ['stale-preparing', 'stale-inspection']);
  assert.deepEqual(result.invalidSnapshotExpired, []);
  for (const item of result.records.slice(0, 2)) {
    assert.equal(item.status, 'expired');
    assert.ok(Number.isFinite(Date.parse(item.expiredAt)));
    assert.match(item.expiredReason, new RegExp(`${item.newPane}.*current Herdr pane list`));
  }
  assert.equal(result.records[2].status, 'preparing');
  assert.equal(result.records[3].status, 'prepared');
});

function runHandoffCli(root, args, env) {
  const cliPath = new URL('../src/cli.js', import.meta.url).pathname;
  return execFileSync(process.execPath, [cliPath, ...args], {
    cwd: path.join(root, 'project'), env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runHandoffModule(root, source, env) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: path.join(root, 'project'), env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('Boss handover planning uses the boss pane without a project control entry', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-boss-handoff-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const herdr = path.join(bin, 'herdr');
  fs.writeFileSync(herdr, `#!/usr/bin/env node
const args = process.argv.slice(2);
let result = {};
if (args[0] === 'pane' && args[1] === 'get') result = { pane: {
  pane_id: args[2], workspace_id: 'ws-boss', label: 'boss', agent: 'codex',
  cwd: process.env.TEST_BOSS_CWD, agent_session: { kind: 'id', value: 'boss-session' },
} };
if (args[0] === 'tab' && args[1] === 'create') result = { root_pane: { pane_id: 'ws-boss:p2' } };
if (args[0] === 'agent' && args[1] === 'get') result = { agent_status: 'working' };
console.log(JSON.stringify({ result }));
`);
  fs.chmodSync(herdr, 0o755);
  fs.mkdirSync(path.join(root, 'project'), { recursive: true });
  fs.writeFileSync(path.join(root, 'policy.json'), JSON.stringify({ projects: {} }));
  fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({ control: { projects: {}, risks: {} } }));
  const handoffUrl = new URL('../src/handoff.js', import.meta.url).href;
  const script = `import { planHandoff } from ${JSON.stringify(handoffUrl)};
console.log(JSON.stringify(planHandoff('ws-boss:p1', 'pi', { mode: 'fresh' })));`;
  const plan = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.join(root, 'project'),
    env: {
      ...process.env,
      HOME: root,
      HERDR_BOSS_DIR: root,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      TEST_BOSS_CWD: path.join(root, 'project'),
    },
    encoding: 'utf8',
  }));
  assert.equal(plan.boss, true);
  assert.equal(plan.project, 'Boss');
  assert.equal(plan.label, 'boss');
  assert.equal(plan.workspace, 'ws-boss');
  assert.equal(plan.sessionId, 'boss-session');
});

test('handoff prepare expires missing successors only after a successful pane list, then waits for its shell', (t) => {
  const f = handoffFixture(t, { delayShell: true });
  const recordsFile = path.join(f.root, 'handoffs.json');
  fs.writeFileSync(recordsFile, JSON.stringify([
    { id: 'stale-preparing', sourcePane: 'ws:p1', newPane: 'ws:missing-1', status: 'preparing' },
    { id: 'stale-inspection', sourcePane: 'ws:p1', newPane: 'ws:missing-2', status: 'needs-inspection' },
  ]));

  assert.throws(() => runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'fresh'], {
    ...f.env, TEST_PANE_LIST_FAIL: '1',
  }), /A successor already exists/, 'a failed pane list must keep the active record from being replaced');
  assert.deepEqual(JSON.parse(fs.readFileSync(recordsFile, 'utf8')).map((item) => item.status), ['preparing', 'needs-inspection']);

  const prepared = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'fresh'], f.env));
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.newPane, 'ws:p2');
  const saved = JSON.parse(fs.readFileSync(recordsFile, 'utf8'));
  for (const stale of saved.slice(0, 2)) {
    assert.equal(stale.status, 'expired');
    assert.ok(Number.isFinite(Date.parse(stale.expiredAt)));
    assert.match(stale.expiredReason, /ws:missing/);
  }

  const calls = fs.readFileSync(f.callsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const create = calls.find((args) => args[0] === 'tab' && args[1] === 'create');
  assert.ok(create.includes('--env'));
  assert.ok(create.includes('DISABLE_UPDATE_PROMPT=true'));
  assert.ok(create.includes('DISABLE_AUTO_UPDATE=true'));
  const processInfo = calls.findIndex((args) => args[0] === 'pane' && args[1] === 'process-info');
  const shellRead = calls.findIndex((args) => args[0] === 'pane' && args[1] === 'read' && args[2] === 'ws:p2');
  const agentStart = calls.findIndex((args) => args[0] === 'agent' && args[1] === 'start');
  assert.ok(processInfo >= 0 && shellRead > processInfo && agentStart > shellRead, 'the successor shell must be checked before agent start');
  assert.equal(Number(fs.readFileSync(f.processInfoFile, 'utf8')) >= 2, true, 'readiness must wait until the shell is foreground');
});

test('handoff readiness gets a 90-second budget', (t) => {
  const f = handoffFixture(t);
  const handoffUrl = new URL('../src/handoff.js', import.meta.url).href;
  const workersUrl = new URL('../src/kit/workers.js', import.meta.url).href;
  const source = `import { prepareHandoff } from ${JSON.stringify(handoffUrl)};
import { waitForWorkerPane } from ${JSON.stringify(workersUrl)};
const timeouts = [];
const waitForPane = (...args) => {
  timeouts.push(args[5].timeoutMs);
  return waitForWorkerPane(args[0], args[1], args[2], args[3], () => {}, args[5]);
};
const item = prepareHandoff('ws:p1', 'pi', { mode: 'fresh' }, { waitForPane });
console.log(JSON.stringify({ status: item.status, timeouts }));`;
  const result = JSON.parse(runHandoffModule(f.root, source, f.env));
  assert.equal(result.status, 'prepared');
  assert.deepEqual(result.timeouts, [90_000]);
});

test('handoff prepare resumes the same needs-inspection record and pane', (t) => {
  const existingPane = 'wA:pB';
  const f = handoffFixture(t, { existingPane });
  const recordsFile = path.join(f.root, 'handoffs.json');
  fs.writeFileSync(recordsFile, JSON.stringify([{
    id: 'handoff-Boss-it7e5m', sourcePane: 'ws:p1', workspace: 'ws', cwd: f.project,
    project: 'project', toKind: 'pi', model: 'opencode-go/muse-spark-1.3-contributor', effort: null,
    mode: 'fresh', provider: 'claude', migratedId: null, newPane: existingPane,
    status: 'needs-inspection', automatic: false, promptError: 'shell was still starting',
  }]));
  const result = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'fresh'], f.env));
  assert.equal(result.status, 'prepared');
  assert.equal(result.id, 'handoff-Boss-it7e5m');
  assert.equal(result.newPane, existingPane);
  const records = JSON.parse(fs.readFileSync(recordsFile, 'utf8'));
  assert.equal(records.length, 1);
  assert.equal(records[0].id, 'handoff-Boss-it7e5m');
  assert.equal(records[0].newPane, existingPane);
  assert.equal(records[0].status, 'prepared');
  const calls = fs.readFileSync(f.callsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(calls.some((args) => args[0] === 'tab' && args[1] === 'create'), false);
  const [start] = calls.filter((args) => args[0] === 'agent' && args[1] === 'start');
  assert.equal(start[start.indexOf('--pane') + 1], existingPane);
  assert.equal(start[2], 'handoff-boss-it7e5m');
  const [prompt] = calls.filter((args) => args[0] === 'agent' && args[1] === 'prompt');
  assert.equal(prompt[2], 'handoff-boss-it7e5m');
  assert.match(prompt[3], /proposed successor orchestrator/);
  assert.doesNotMatch(prompt[3], /handoff ready handoff-boss-it7e5m/);
  assert.equal(records[0].promptDelivery, 'sent');
});

test('handoff prepare derives a safe agent name for a new record and keeps the record ID in ready instructions', (t) => {
  const f = handoffFixture(t, { sourceLabel: 'boss' });
  const result = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'fresh', '--auto'], f.env));
  assert.equal(result.project, 'Boss');
  assert.match(result.id, /^handoff-Boss-/);
  assert.equal(result.status, 'prepared');
  const calls = fs.readFileSync(f.callsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const [start] = calls.filter((args) => args[0] === 'agent' && args[1] === 'start');
  const [prompt] = calls.filter((args) => args[0] === 'agent' && args[1] === 'prompt');
  assert.equal(start[2], result.id.toLowerCase());
  assert.notEqual(start[2], result.id);
  assert.match(start[2], /^[a-z][a-z0-9_-]{0,31}$/);
  assert.equal(prompt[2], start[2]);
  assert.match(prompt[3], new RegExp(`handoff ready ${result.id}`));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'))[0].id, result.id);
});

test('handoff prepare sanitizes punctuation and caps the derived agent name at 32 characters', (t) => {
  const existingPane = 'ws:p9';
  const id = `9 Handoff!${'x'.repeat(40)}`;
  const f = handoffFixture(t, { existingPane });
  fs.writeFileSync(path.join(f.root, 'handoffs.json'), JSON.stringify([{
    id, sourcePane: 'ws:p1', workspace: 'ws', cwd: f.project,
    project: 'project', toKind: 'pi', model: 'opencode-go/muse-spark-1.3-contributor', effort: null,
    mode: 'fresh', provider: 'claude', migratedId: null, newPane: existingPane,
    status: 'needs-inspection', automatic: false,
  }]));

  const result = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'fresh'], f.env));
  const calls = fs.readFileSync(f.callsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const [start] = calls.filter((args) => args[0] === 'agent' && args[1] === 'start');
  const [prompt] = calls.filter((args) => args[0] === 'agent' && args[1] === 'prompt');
  assert.equal(result.id, id);
  assert.match(start[2], /^h-9-handoff-x+$/);
  assert.equal(start[2].length, 32);
  assert.equal(prompt[2], start[2]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'))[0].id, id);
});

test('handoff prepare keeps a resumable record after its existing pane fails readiness', (t) => {
  const existingPane = 'ws:p9';
  const f = handoffFixture(t, { existingPane });
  const recordsFile = path.join(f.root, 'handoffs.json');
  fs.writeFileSync(recordsFile, JSON.stringify([{
    id: 'handoff-existing', sourcePane: 'ws:p1', workspace: 'ws', cwd: f.project,
    project: 'project', toKind: 'pi', model: 'opencode-go/muse-spark-1.3-contributor', effort: null,
    mode: 'fresh', provider: 'opencodego', migratedId: null, newPane: existingPane,
    status: 'needs-inspection', automatic: false,
  }]));
  const handoffUrl = new URL('../src/handoff.js', import.meta.url).href;
  const source = `import { listHandoffs, prepareHandoff } from ${JSON.stringify(handoffUrl)};
let error = null;
try {
  prepareHandoff('ws:p1', 'pi', { mode: 'fresh' }, { waitForPane: () => { throw new Error('readiness timed out'); } });
} catch (failure) { error = failure.message; }
console.log(JSON.stringify({ error, records: listHandoffs() }));`;
  const result = JSON.parse(runHandoffModule(f.root, source, f.env));
  assert.match(result.error, /Existing successor pane ws:p9 could not become ready/);
  assert.match(result.error, /needs-inspection record is preserved/);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].id, 'handoff-existing');
  assert.equal(result.records[0].newPane, existingPane);
  assert.equal(result.records[0].status, 'needs-inspection');
  assert.match(result.records[0].promptError, /readiness timed out/);
  const calls = fs.readFileSync(f.callsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(calls.some((args) => args[0] === 'tab' && args[1] === 'create'), false);
  assert.equal(calls.some((args) => args[0] === 'agent' && args[1] === 'start'), false);
});

test('handoff prepare retries agent_pane_busy once after checking shell readiness again', (t) => {
  const f = handoffFixture(t, { busyAttempts: 1 });
  const prepared = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'fresh'], f.env));
  assert.equal(prepared.status, 'prepared');
  assert.equal(Number(fs.readFileSync(f.agentStartFile, 'utf8')), 2);
  assert.equal(Number(fs.readFileSync(f.processInfoFile, 'utf8')), 2, 'the shell readiness check must pass again before the one retry');
  const calls = fs.readFileSync(f.callsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(calls.filter((args) => args[0] === 'agent' && args[1] === 'start').length, 2);
});

test('handoff prepare keeps needs-inspection after its one busy retry fails', (t) => {
  const f = handoffFixture(t, { busyAttempts: 2 });
  assert.throws(() => runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'fresh'], f.env), /Successor may be in ws:p2/);
  assert.equal(Number(fs.readFileSync(f.agentStartFile, 'utf8')), 2, 'prepare must not make a third start attempt');
  assert.equal(Number(fs.readFileSync(f.processInfoFile, 'utf8')), 2);
  const [record] = JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'));
  assert.equal(record.status, 'needs-inspection');
  assert.match(record.promptError, /Pane is busy/);
});

test('handoff prepare stops at an interactive shell question', (t) => {
  const f = handoffFixture(t, { shell: 'Would you like to update? [Y/n]\n' });
  assert.throws(() => runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'fresh'], f.env), (error) => {
    assert.match(error.stderr.toString(), /interactive question/);
    assert.match(error.stderr.toString(), /Answer it in a shell once, then retry handoff prepare/);
    return true;
  });
  const calls = fs.readFileSync(f.callsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(calls.some((args) => args[0] === 'agent' && args[1] === 'start'), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'))[0].status, 'needs-inspection');
});

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
  assert.match(prompt, /historical context/i);
  assert.match(prompt, /Continue from the failing test/);
  assert.match(prompt, /handoff ready /);
  assert.doesNotMatch(prompt, /abcDEF|verysecret|hunter2|abcdef1234567890|fixture_secret|fixture_key/);
  assert.ok(calls.some((args) => args[0] === 'pane' && args[1] === 'read' && args[2] === 'ws:p1' && args.includes('recent')));
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

test('a credential-bearing migration dry-run error is redacted in plan, record, and prompt', (t) => {
  const f = handoffFixture(t, { sessionId: 'old-session' });
  const env = { ...f.env, TEST_MIGRATION_CYCLE: '1', TEST_DRY_RUN_SECRET: '1' };
  const plan = JSON.parse(runHandoffCli(f.root, ['handoff', 'plan', 'ws:p1', '--to', 'codex', '--mode', 'migrate'], env));
  assert.doesNotMatch(plan.migration.error, /fixture_dry_secret/);
  const record = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'codex', '--mode', 'migrate'], env));
  assert.equal(record.mode, 'fresh');
  assert.match(record.migrationFallbackReason, /\[REDACTED\]/);
  assert.doesNotMatch(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'), /fixture_dry_secret/);
  const calls = fs.readFileSync(f.callsFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.doesNotMatch(calls.find((args) => args[0] === 'agent' && args[1] === 'prompt')[3], /fixture_dry_secret/);
});

test('fresh capture bounds recent lines and falls back to visible or an unavailable marker', (t) => {
  const longText = Array.from({ length: 250 }, (_, i) => `line ${i} ${'x'.repeat(120)}`).join('\n');
  const f = handoffFixture(t);
  const first = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'fresh'], { ...f.env, TEST_SOURCE_TEXT: longText, TEST_RECENT_FAIL: '1' }));
  assert.match(first.sourceContext, /line 249/);
  assert.doesNotMatch(first.sourceContext, /line 0 /);
  assert.ok(first.sourceContext.length <= 20000);
  assert.match(first.sourceContext, /truncated/i);
  const calls = fs.readFileSync(f.callsFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.some((args) => args[0] === 'pane' && args[1] === 'read' && args[2] === 'ws:p1' && args.includes('visible')));

  const g = handoffFixture(t);
  const second = JSON.parse(runHandoffCli(g.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'fresh'], { ...g.env, TEST_RECENT_FAIL: '1', TEST_VISIBLE_FAIL: '1' }));
  assert.match(second.sourceContext, /context unavailable/i);
  const secondCalls = fs.readFileSync(g.callsFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.match(secondCalls.find((args) => args[0] === 'agent' && args[1] === 'prompt')[3], /context unavailable/i);
});

test('missing project goal stays absent and Boss never borrows a project goal', (t) => {
  const f = handoffFixture(t);
  fs.mkdirSync(path.join(f.root, 'projects'));
  fs.writeFileSync(path.join(f.root, 'projects', 'project.json'), JSON.stringify({ tasks: [{ title: 'A goal-like task' }], notes: ['goal in a note'] }));
  const noGoal = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'fresh'], f.env));
  assert.equal(Object.hasOwn(noGoal, 'ownerGoal'), false);
  const g = handoffFixture(t, { sourceLabel: 'boss' });
  fs.mkdirSync(path.join(g.root, 'projects'));
  fs.writeFileSync(path.join(g.root, 'projects', 'Boss.json'), JSON.stringify({ goal: 'Not a Boss goal' }));
  const boss = JSON.parse(runHandoffCli(g.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'fresh'], g.env));
  assert.equal(Object.hasOwn(boss, 'ownerGoal'), false);
});

test('resuming a record preserves its captured Owner goal', (t) => {
  const f = handoffFixture(t, { existingPane: 'ws:p9' });
  fs.mkdirSync(path.join(f.root, 'projects'));
  fs.writeFileSync(path.join(f.root, 'projects', 'project.json'), JSON.stringify({ goal: 'Changed later' }));
  fs.writeFileSync(path.join(f.root, 'handoffs.json'), JSON.stringify([{
    id: 'handoff-preserved', sourcePane: 'ws:p1', workspace: 'ws', cwd: f.project,
    project: 'project', toKind: 'pi', model: 'opencode-go/muse-spark-1.3-contributor', effort: null,
    mode: 'fresh', provider: 'claude', migratedId: null, newPane: 'ws:p9',
    status: 'needs-inspection', automatic: false, ownerGoal: 'Original Owner goal', sourceContext: 'Earlier safe context',
  }]));
  const result = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'fresh'], f.env));
  assert.equal(result.ownerGoal, 'Original Owner goal');
  const calls = fs.readFileSync(f.callsFile, 'utf8').trim().split('\n').map(JSON.parse);
  const prompt = calls.find((args) => args[0] === 'agent' && args[1] === 'prompt')[3];
  assert.match(prompt, /Original Owner goal/);
  assert.doesNotMatch(prompt, /Changed later/);
  assert.match(prompt, /Earlier safe context/);
  assert.equal(calls.some((args) => args[0] === 'pane' && args[1] === 'read' && args[2] === 'ws:p1'), false);
});

test('resuming an older fresh fallback record fills missing goal and source context', (t) => {
  const f = handoffFixture(t, { existingPane: 'ws:p9' });
  fs.mkdirSync(path.join(f.root, 'projects'));
  fs.writeFileSync(path.join(f.root, 'projects', 'project.json'), JSON.stringify({ goal: 'Continue the Owner objective.' }));
  fs.writeFileSync(path.join(f.root, 'handoffs.json'), JSON.stringify([{
    id: 'handoff-legacy', sourcePane: 'ws:p1', workspace: 'ws', cwd: f.project,
    project: 'project', toKind: 'pi', model: 'opencode-go/muse-spark-1.3-contributor', effort: null,
    mode: 'fresh', requestedMode: 'migrate', provider: 'claude', migratedId: null, newPane: 'ws:p9',
    status: 'needs-inspection', automatic: false,
  }]));
  const record = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'migrate'], { ...f.env, TEST_SOURCE_TEXT: 'Old pane summary' }));
  assert.equal(record.ownerGoal, 'Continue the Owner objective.');
  assert.match(record.sourceContext, /Old pane summary/);
  const calls = fs.readFileSync(f.callsFile, 'utf8').trim().split('\n').map(JSON.parse);
  const prompt = calls.find((args) => args[0] === 'agent' && args[1] === 'prompt')[3];
  assert.match(prompt, /Continue the Owner objective/);
  assert.match(prompt, /Old pane summary/);
  assert.ok(calls.some((args) => args[0] === 'pane' && args[1] === 'read' && args[2] === 'ws:p1'));
});

test('dashboard offers Prepare after an unavailable migration plan', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /\$\{plan\s*\?\s*`<button type="button" data-handoff-prepare=/);
  assert.match(source, /Migration unavailable:[^`]*Prepare will use fresh mode/);
});
