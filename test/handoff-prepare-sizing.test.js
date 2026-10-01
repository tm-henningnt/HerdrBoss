import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { activationFixture, handoffFixture, handoffPromptCalls, runHandoffCli, runHandoffModule, WORKER_LINE, writeRuns } from './helpers/handoff-fixture.js';

test('expireMissingHandoffs records absent successors from an explicit pane snapshot only', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-boss-handoff-expire-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const recordsFile = path.join(root, 'handoffs.json');
  fs.writeFileSync(recordsFile, JSON.stringify([
    { id: 'stale-preparing', newPane: 'ws:p2', status: 'preparing' },
    { id: 'stale-inspection', newPane: 'ws:p4', status: 'needs-inspection' },
    { id: 'live', newPane: 'ws:p3', status: 'preparing' },
    { id: 'stale-prepared', newPane: 'ws:p5', status: 'prepared' },
    { id: 'live-prepared', newPane: 'ws:p1', status: 'prepared' },
    { id: 'active', newPane: 'ws:p6', status: 'active' },
    { id: 'activated', newPane: 'ws:p7', status: 'activated' },
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
  assert.deepEqual(result.expired, ['stale-preparing', 'stale-inspection', 'stale-prepared']);
  assert.deepEqual(result.invalidSnapshotExpired, []);
  for (const item of [...result.records.slice(0, 2), result.records[3]]) {
    assert.equal(item.status, 'expired');
    assert.ok(Number.isFinite(Date.parse(item.expiredAt)));
    assert.match(item.expiredReason, new RegExp(`${item.newPane}.*current Herdr pane list`));
  }
  assert.equal(result.records[2].status, 'preparing');
  assert.equal(result.records[4].status, 'prepared');
  assert.equal(result.records[5].status, 'active');
  assert.equal(result.records[6].status, 'activated');
});

test('Boss handover planning uses the boss pane without a project control entry', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-boss-handoff-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const herdr = path.join(bin, 'herdr');
  fs.writeFileSync(herdr, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'pane' && args[1] === 'rename' && JSON.parse(process.env.TEST_FAIL_RENAMES).includes(args[2])) {
  console.log(JSON.stringify({ id: 'cli:pane:rename', error: { code: 'rename_failed', message: 'Pane error rename_failed.' } }));
  process.exit(0);
}
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

function measuredHomes(f) {
  if (!fs.existsSync(f.migrateHomesFile)) return [];
  return fs.readFileSync(f.migrateHomesFile, 'utf8').trim().split('\n').filter(Boolean);
}

function assertHomesDeleted(f, count) {
  const homes = measuredHomes(f);
  assert.equal(homes.length, count);
  for (const home of homes) {
    assert.ok(path.isAbsolute(home));
    assert.equal(fs.existsSync(home), false, `temporary home ${home} must be deleted`);
  }
}

test('a small converted session fits the target window and keeps migrate mode', (t) => {
  const f = handoffFixture(t, { sourceKind: 'claude', sessionId: 'old-session' });
  const env = { ...f.env, TEST_CONVERTED_BYTES: '480000' };
  const plan = JSON.parse(runHandoffCli(f.root, ['handoff', 'plan', 'ws:p1', '--to', 'codex', '--mode', 'migrate'], env));
  assert.equal(plan.migration.available, true);
  assert.deepEqual(plan.migration.fit, { bytes: 480000, estimatedTokens: 120000, contextTokens: 200000, limitTokens: 120000, fits: true, sizeKnown: true });
  assert.equal(plan.migration.next, undefined);
  for (const home of measuredHomes(f)) assert.ok(home.startsWith(os.tmpdir()), `${home} must be under the temporary directory`);
  const record = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'codex', '--mode', 'migrate'], env));
  assert.equal(record.mode, 'migrate');
  assert.equal(record.migratedId, 'migrated-session');
  assert.equal(Object.hasOwn(record, 'migrationFallbackReason'), false);
  assertHomesDeleted(f, 2);
});

test('a converted session over 60 percent of the window gives fresh mode with the size error', (t) => {
  const f = handoffFixture(t, { sourceKind: 'claude', sessionId: 'old-session' });
  const env = { ...f.env, TEST_CONVERTED_BYTES: '480001', TEST_SOURCE_TEXT: 'Useful prior work' };
  const sizeError = 'Migrated session is too large for the target window: about 120001 tokens against a limit of 120000.';
  const plan = JSON.parse(runHandoffCli(f.root, ['handoff', 'plan', 'ws:p1', '--to', 'codex', '--mode', 'migrate'], env));
  assert.equal(plan.migration.available, false);
  assert.equal(plan.migration.error, sizeError);
  assert.equal(plan.migration.fit.fits, false);
  assert.match(plan.migration.next, /Prepare will use fresh mode automatically/);
  const record = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'codex', '--mode', 'migrate'], env));
  assert.equal(record.mode, 'fresh');
  assert.equal(record.requestedMode, 'migrate');
  assert.equal(record.migratedId, null);
  assert.equal(record.migrationFallbackReason, sizeError);
  assert.equal(record.migration.error, sizeError);
  assert.equal(record.migration.fit.fits, false);
  assert.match(record.sourceContext, /Useful prior work/);
  const transfers = handoffMigrateCalls(f).filter((args) => !args.includes('--dry-run') && !args.includes('--home'));
  assert.equal(transfers.length, 0, 'prepare must not run the real transfer for a session that does not fit');
  assertHomesDeleted(f, 2);
});

test('a failed measuring transfer retries once, then keeps migration available with a warning', (t) => {
  const f = handoffFixture(t, { sourceKind: 'claude', sessionId: 'old-session' });
  const env = { ...f.env, TEST_MEASURE_FAILURES: '2' };
  const plan = JSON.parse(runHandoffCli(f.root, ['handoff', 'plan', 'ws:p1', '--to', 'codex', '--mode', 'migrate'], env));
  assert.equal(plan.migration.available, true);
  assert.deepEqual(plan.migration.fit, { bytes: null, estimatedTokens: null, contextTokens: 200000, limitTokens: 120000, fits: null, sizeKnown: false });
  assert.match(plan.migration.warning, /size.*unknown/i);
  assertHomesDeleted(f, 2);
});

test('a measuring transfer that fails once succeeds on its retry', (t) => {
  const f = handoffFixture(t, { sourceKind: 'claude', sessionId: 'old-session' });
  const env = { ...f.env, TEST_MEASURE_FAILURES: '1', TEST_CONVERTED_BYTES: '4000' };
  const plan = JSON.parse(runHandoffCli(f.root, ['handoff', 'plan', 'ws:p1', '--to', 'codex', '--mode', 'migrate'], env));
  assert.equal(plan.migration.available, true);
  assert.equal(plan.migration.fit.sizeKnown, true);
  assert.equal(plan.migration.fit.estimatedTokens, 1000);
  assertHomesDeleted(f, 2);
});

test('a size fallback tells the successor the reason at activation', (t) => {
  const reason = 'Migrated session is too large for the target window: about 130000 tokens against a limit of 120000.';
  const f = activationFixture(t, { record: { migrationFallbackReason: reason, migration: { available: false, error: reason, fit: { bytes: 520000, estimatedTokens: 130000, contextTokens: 200000, limitTokens: 120000, fits: false, sizeKnown: true } } } });
  f.activate();
  const successor = f.prompts()['ws:p2'];
  assert.match(successor, /started your session fresh as codex \(gpt-6-luna, xhigh\) because session migration was unavailable/);
  assert.ok(successor.includes(reason), 'the successor prompt must carry the size reason');
});

test('a non-size fallback keeps its activation wording without a size reason', (t) => {
  const f = activationFixture(t);
  f.activate();
  assert.doesNotMatch(f.prompts()['ws:p2'], /too large for the target window/);
});

test('migrationFit keeps an unknown window or size open and applies the 60 percent limit', async () => {
  const { migrationFit } = await import('../src/handoff.js');
  assert.deepEqual(migrationFit(4000, null), { bytes: 4000, estimatedTokens: 1000, contextTokens: null, limitTokens: null, fits: null, sizeKnown: true });
  assert.deepEqual(migrationFit(null, 200000), { bytes: null, estimatedTokens: null, contextTokens: 200000, limitTokens: 120000, fits: null, sizeKnown: false });
  assert.equal(migrationFit(480000, 200000).fits, true);
  assert.equal(migrationFit(480001, 200000).fits, false);
  assert.equal(migrationFit(3, 200000).estimatedTokens, 1);
});

function handoffMigrateCalls(f) {
  return fs.existsSync(f.migrateCallsFile) ? fs.readFileSync(f.migrateCallsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}

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

test('a quoted credential past the 500-character limit is redacted before the dry-run error is bounded', (t) => {
  const secret = 'S'.repeat(600);
  const failure = `Migration dry-run failed. Credential "access_token": "${secret}" was rejected by the transfer endpoint.`;
  const f = handoffFixture(t, { sessionId: 'old-session' });
  const env = { ...f.env, TEST_MIGRATION_CYCLE: '1', TEST_MIGRATION_ERROR: failure };
  const plan = JSON.parse(runHandoffCli(f.root, ['handoff', 'plan', 'ws:p1', '--to', 'codex', '--mode', 'migrate'], env));
  assert.equal(plan.migration.available, false);
  assert.ok(plan.migration.error.length <= 500, `plan error must stay bounded, got ${plan.migration.error.length}`);
  assert.doesNotMatch(plan.migration.error, /S{20}/, 'the credential must be redacted before the length limit');
  const record = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'codex', '--mode', 'migrate'], env));
  assert.equal(record.mode, 'fresh');
  assert.ok(record.migrationFallbackReason.length < 600, `fallback reason must stay bounded, got ${record.migrationFallbackReason.length}`);
  assert.doesNotMatch(record.migrationFallbackReason, /S{20}/);
  const saved = fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8');
  assert.doesNotMatch(saved, /S{20}/);
  assert.doesNotMatch(handoffPromptCalls(f.root).join('\n'), /S{20}/);
});
