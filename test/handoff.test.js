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

function handoffFixture(t, { shell = '% ', delayShell = false, paneListFails = false, sourceKind = 'codex', sessionId = null, busyAttempts = 0, existingPane = null } = {}) {
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
  pane_id: 'ws:p1', workspace_id: 'ws', label: 'orch', agent: process.env.TEST_SOURCE_KIND,
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
if (args[0] === 'pane' && args[1] === 'read') result = { text: process.env.TEST_SHELL };
console.log(JSON.stringify({ result }));
`);
  writeExecutable(path.join(bin, 'herdr'), `#!/bin/sh
exec node "$(dirname "$0")/herdr.cjs" "$@"
`);
  writeExecutable(path.join(bin, 'session-migrate.cjs'), `
if (process.env.TEST_MIGRATION_CYCLE === '1') {
  process.stderr.write('Claude active graph contains an ancestry cycle\\n');
  process.exit(1);
}
console.log(JSON.stringify({ session_id: 'migrated-session', records: 1, dropped_events: 0, warnings: [] }));
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
  const shellRead = calls.findIndex((args) => args[0] === 'pane' && args[1] === 'read');
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
  const existingPane = 'ws:p9';
  const f = handoffFixture(t, { existingPane });
  const recordsFile = path.join(f.root, 'handoffs.json');
  fs.writeFileSync(recordsFile, JSON.stringify([{
    id: 'handoff-existing', sourcePane: 'ws:p1', workspace: 'ws', cwd: f.project,
    project: 'project', toKind: 'pi', model: 'opencode-go/muse-spark-1.3-contributor', effort: null,
    mode: 'fresh', provider: 'claude', migratedId: null, newPane: existingPane,
    status: 'needs-inspection', automatic: false, promptError: 'shell was still starting',
  }]));
  const result = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'fresh'], f.env));
  assert.equal(result.status, 'prepared');
  assert.equal(result.id, 'handoff-existing');
  assert.equal(result.newPane, existingPane);
  const records = JSON.parse(fs.readFileSync(recordsFile, 'utf8'));
  assert.equal(records.length, 1);
  assert.equal(records[0].id, 'handoff-existing');
  assert.equal(records[0].newPane, existingPane);
  assert.equal(records[0].status, 'prepared');
  const calls = fs.readFileSync(f.callsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(calls.some((args) => args[0] === 'tab' && args[1] === 'create'), false);
  const [start] = calls.filter((args) => args[0] === 'agent' && args[1] === 'start');
  assert.equal(start[start.indexOf('--pane') + 1], existingPane);
  assert.equal(start[2], 'handoff-existing');
  const [prompt] = calls.filter((args) => args[0] === 'agent' && args[1] === 'prompt');
  assert.equal(prompt[2], 'handoff-existing');
  assert.match(prompt[3], /proposed successor orchestrator/);
  assert.equal(records[0].promptDelivery, 'sent');
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
