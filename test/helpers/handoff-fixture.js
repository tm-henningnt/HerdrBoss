import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function writeExecutable(file, source) {
  fs.writeFileSync(file, source);
  fs.chmodSync(file, 0o755);
}

export function handoffFixture(t, { shell = '% ', delayShell = false, paneListFails = false, sourceKind = 'codex', sourceLabel = 'orch', sessionId = null, busyAttempts = 0, existingPane = null } = {}) {
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
  ...(process.env.TEST_SUCCESSOR_STATUS ? { agent: 'claude', agent_status: process.env.TEST_SUCCESSOR_STATUS } : {}),
} };
if (args[0] === 'pane' && args[1] === 'list') {
  if (process.env.TEST_PANE_LIST_FAIL === '1') process.exit(1);
  result = { panes: [{ pane_id: 'ws:p1', workspace_id: 'ws' }, ...(process.env.TEST_EXISTING_PANE ? [{ pane_id: process.env.TEST_EXISTING_PANE, workspace_id: 'ws' }] : []), ...(process.env.TEST_BOSS_PANE ? [{ pane_id: process.env.TEST_BOSS_PANE, label: 'boss' }] : [])] };
}
if (args[0] === 'tab' && args[1] === 'create') result = process.env.TEST_NO_TAB_ID === '1' ? { root_pane: { pane_id: 'ws:p2' } }
  : { tab: { tab_id: 'ws:t2' }, root_pane: { pane_id: 'ws:p2', tab_id: 'ws:t2' } };
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
const fs = require('node:fs');
const path = require('node:path');
if (process.env.TEST_MIGRATE_CALLS) fs.appendFileSync(process.env.TEST_MIGRATE_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
const homeIndex = process.argv.indexOf('--home');
if (homeIndex !== -1 && process.env.TEST_MIGRATE_HOMES) {
  const home = process.argv[homeIndex + 1];
  fs.appendFileSync(process.env.TEST_MIGRATE_HOMES, home + '\\n');
  const failures = Number(process.env.TEST_MEASURE_FAILURES || 0);
  const count = fs.readFileSync(process.env.TEST_MIGRATE_HOMES, 'utf8').trim().split('\\n').length;
  if (count <= failures) {
    process.stderr.write('source session changed while it was being read; retry\\n');
    process.exit(2);
  }
  const dir = path.join(home, '.codex', 'sessions', '2026', '09', '27');
  fs.mkdirSync(dir, { recursive: true });
  const bytes = Number(process.env.TEST_CONVERTED_BYTES || 1000);
  fs.writeFileSync(path.join(dir, 'rollout-a.jsonl'), 'x'.repeat(Math.floor(bytes / 2)));
  fs.writeFileSync(path.join(dir, 'rollout-b.jsonl'), 'x'.repeat(bytes - Math.floor(bytes / 2)));
  fs.writeFileSync(path.join(dir, 'index.json'), 'y'.repeat(5000000));
  console.log(JSON.stringify({ session_id: 'measured-session', records: 244, output: path.join(dir, 'rollout-a.jsonl') }));
  process.exit(0);
}
if (process.env.TEST_MIGRATION_CYCLE === '1' || (process.env.TEST_TRANSFER_FAIL === '1' && !process.argv.includes('--dry-run'))) {
  process.stderr.write(process.env.TEST_MIGRATION_ERROR || (process.env.TEST_DRY_RUN_SECRET && process.argv.includes('--dry-run') ? 'Migration failed: api_key=fixture_dry_secret\\n' : 'Claude active graph contains an ancestry cycle\\n'));
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
    migrateHomesFile: path.join(root, 'migrate-homes.txt'),
    migrateCallsFile: path.join(root, 'migrate-calls.jsonl'),
    env: {
      ...process.env,
      TEST_MIGRATE_CALLS: path.join(root, 'migrate-calls.jsonl'),
      TEST_MIGRATE_HOMES: path.join(root, 'migrate-homes.txt'),
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

export function runHandoffCli(root, args, env) {
  const cliPath = new URL('../../src/cli.js', import.meta.url).pathname;
  return execFileSync(process.execPath, [cliPath, ...args], {
    cwd: path.join(root, 'project'), env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function runHandoffModule(root, source, env) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: path.join(root, 'project'), env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function handoffPromptCalls(root) {
  return fs.readFileSync(path.join(root, 'herdr-calls.jsonl'), 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line))
    .filter((args) => args[0] === 'agent' && args[1] === 'prompt')
    .map((args) => args[3]);
}

// A fake Herdr CLI for activation. It prints the installed CLI's JSON envelope with raw pane fields. On an error it writes the envelope to stderr and exits 1, like the installed CLI.
export function activationFixture(t, { boss = false, failPrompts = [], paneListFails = false, record = {}, priorRecords = [], extraPanes = [], paneErrors = {}, failRenames = [], agentNames = null, failAgentRenames = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-boss-activate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, '.local', 'bin');
  fs.mkdirSync(path.join(root, 'project'), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const callsFile = path.join(root, 'herdr-calls.jsonl');
  const ws = boss ? 'wb' : 'ws';
  const agents = agentNames ?? [{ pane_id: `${ws}:p1`, name: 'source-agent' }];
  const panes = [
    { pane_id: `${ws}:p1`, workspace_id: ws, label: boss ? 'boss' : 'orch', agent: 'claude', agent_status: 'working' },
    { pane_id: `${ws}:p2`, workspace_id: ws, label: null, agent: 'codex', agent_status: 'idle' },
    { pane_id: `${ws}:p3`, workspace_id: ws, label: null, agent: 'pi', agent_status: 'working' },
    { pane_id: `${ws}:p4`, workspace_id: ws, label: null, agent: null, agent_status: null },
    { pane_id: 'other:p1', workspace_id: 'other', label: boss ? 'orch' : 'boss', agent: 'claude', agent_status: 'idle' },
    ...extraPanes,
  ];
  writeExecutable(path.join(bin, 'herdr.cjs'), `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify(args) + '\\n');
const panes = JSON.parse(process.env.TEST_PANES);
const paneErrors = JSON.parse(process.env.TEST_PANE_ERRORS);
if (args[0] === 'pane' && paneErrors[args[2]]) {
  console.error(JSON.stringify({ id: 'cli:' + args.slice(0, 2).join(':'), error: { code: paneErrors[args[2]], message: 'Pane error ' + paneErrors[args[2]] + '.' } }));
  process.exit(1);
}
if (args[0] === 'agent' && args[1] === 'prompt' && paneErrors[args[2]]) {
  console.error(JSON.stringify({ id: 'cli:agent:prompt', error: { code: paneErrors[args[2]], message: 'Pane error ' + paneErrors[args[2]] + '.' } }));
  process.exit(1);
}
if (args[0] === 'pane' && args[1] === 'rename' && JSON.parse(process.env.TEST_FAIL_RENAMES).includes(args[2])) {
  console.error(JSON.stringify({ id: 'cli:pane:rename', error: { code: 'rename_failed', message: 'Pane error rename_failed.' } }));
  process.exit(1);
}
if (args[0] === 'agent' && args[1] === 'rename' && JSON.parse(process.env.TEST_FAIL_AGENT_RENAMES).includes(args[2])) {
  console.error(JSON.stringify({ id: 'cli:agent:rename', error: { code: 'rename_failed', message: 'Agent error rename_failed.' } }));
  process.exit(1);
}
let result = {};
if (args[0] === 'pane' && args[1] === 'get') result = { pane: panes.find((pane) => pane.pane_id === args[2]) || null };
if (args[0] === 'pane' && args[1] === 'list') {
  if (process.env.TEST_PANE_LIST_FAIL === '1') process.exit(1);
  result = { panes };
}
if (args[0] === 'agent' && args[1] === 'list') result = { agents: JSON.parse(process.env.TEST_AGENTS) };
if (args[0] === 'agent' && args[1] === 'prompt' && JSON.parse(process.env.TEST_FAIL_PROMPTS).includes(args[2])) {
  console.error(JSON.stringify({ id: 'cli:agent:prompt', error: { code: 'pane_not_found', message: 'Pane not found.' } }));
  process.exit(1);
}
console.log(JSON.stringify({ id: 'cli:' + args.slice(0, 2).join(':'), result }));
`);
  writeExecutable(path.join(bin, 'herdr'), `#!/bin/sh
exec node "$(dirname "$0")/herdr.cjs" "$@"
`);
  fs.writeFileSync(path.join(root, 'handoffs.json'), JSON.stringify([...priorRecords, {
    id: 'handoff-activate', sourcePane: `${ws}:p1`, workspace: ws, cwd: path.join(root, 'project'),
    project: boss ? 'Boss' : 'alpha', label: boss ? 'boss' : 'orch', displayLabel: boss ? 'Boss' : 'Alpha', boss,
    fromKind: 'claude', sessionId: 'source-session', toKind: 'codex', model: 'gpt-6-luna', effort: 'xhigh',
    mode: 'fresh', requestedMode: 'migrate', migrationFallbackReason: 'Session migration unavailable: test',
    provider: 'openai', migratedId: null, newPane: `${ws}:p2`, status: 'prepared', automatic: false,
    preparedAt: '2026-09-27T10:00:00.000Z',
    ...(boss ? {} : { ownerGoal: 'Ship the release safely.', sourceContext: 'Earlier safe context' }),
    ...record,
  }]));
  const env = {
    ...process.env, HOME: root, HERDR_BOSS_DIR: root, PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    TEST_CALLS: callsFile, TEST_PANES: JSON.stringify(panes), TEST_FAIL_PROMPTS: JSON.stringify(failPrompts),
    TEST_PANE_LIST_FAIL: paneListFails ? '1' : '0', TEST_PANE_ERRORS: JSON.stringify(paneErrors), TEST_FAIL_RENAMES: JSON.stringify(failRenames),
    TEST_AGENTS: JSON.stringify(agents), TEST_FAIL_AGENT_RENAMES: JSON.stringify(failAgentRenames),
  };
  const handoffUrl = new URL('../../src/handoff.js', import.meta.url).href;
  const activate = () => JSON.parse(runHandoffModule(root, `import { activateHandoff } from ${JSON.stringify(handoffUrl)};
console.log(JSON.stringify(activateHandoff('handoff-activate', { confirmed: true })));`, env));
  const activateWithWarnings = () => JSON.parse(runHandoffModule(root, `import { activateHandoff } from ${JSON.stringify(handoffUrl)};
const warnings = [];
console.warn = (...args) => warnings.push(args.join(' '));
const item = activateHandoff('handoff-activate', { confirmed: true });
console.log(JSON.stringify({ item, warnings }));`, env));
  const calls = () => fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse);
  const prompts = () => Object.fromEntries(calls().filter((args) => args[0] === 'agent' && args[1] === 'prompt').map((args) => [args[2], args[3]]));
  return { root, ws, env, activate, activateWithWarnings, calls, prompts };
}

// Run records of workers under the project runs folder. A record without finishedAt is a running worker.
export function writeRuns(f, runs) {
  execFileSync('git', ['init', '-q'], { cwd: path.join(f.root, 'project') });
  const dir = path.join(f.root, 'project', '.orchestration', 'runs');
  fs.mkdirSync(dir, { recursive: true });
  for (const run of runs) fs.writeFileSync(path.join(dir, `${run.name}.json`), JSON.stringify(run));
}
export const WORKER_LINE = 'Your orchestrator is now alpha-orch (pane ws:p2). Send WORKER REPORT and WORKER QUESTION there.';
