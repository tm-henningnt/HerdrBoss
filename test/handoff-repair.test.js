import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { activationFixture, runHandoffCli, runHandoffModule, writeExecutable } from './helpers/handoff-fixture.js';

const handoffUrl = new URL('../src/handoff.js', import.meta.url).href;

function repairModule(f, source) {
  return JSON.parse(runHandoffModule(f.root, source, f.env));
}

function moduleError(f, source) {
  try { runHandoffModule(f.root, source, f.env); }
  catch (error) { return String(error.stderr || error.message); }
  return '';
}

// The exit status of the command, so a test can separate a refusal from a no-op.
function repairCli(f, args) {
  const cliPath = new URL('../src/cli.js', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: path.join(f.root, 'project'), env: f.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// A concurrent writer that expires the record between the read and the guarded write of a repair.
function concurrentExpiry(f) {
  const bin = path.join(f.root, '.local', 'bin');
  writeExecutable(path.join(bin, 'race.cjs'), `
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(process.env.HERDR_BOSS_DIR, 'handoffs.json');
const records = JSON.parse(fs.readFileSync(file, 'utf8'));
records[0].status = 'expired';
records[0].expiredReason = 'concurrent update';
fs.writeFileSync(file, JSON.stringify(records));
`);
  writeExecutable(path.join(bin, 'herdr'), `#!/bin/sh
if [ "$1" = "pane" ] && [ "$2" = "get" ]; then node "$(dirname "$0")/race.cjs"; fi
exec node "$(dirname "$0")/herdr.cjs" "$@"
`);
}

// The activation fixture successor pane is idle. K27 also accepts a pane whose agent state is done.
function setSuccessorStatus(f, status, paneId = 'ws:p2') {
  const file = path.join(f.root, 'panes.json');
  const panes = JSON.parse(fs.readFileSync(file, 'utf8')).map((pane) => (pane.pane_id === paneId ? { ...pane, agent_status: status } : pane));
  fs.writeFileSync(file, JSON.stringify(panes));
}

const repairSource = (options = '') => `import { repairHandoff } from ${JSON.stringify(handoffUrl)};
console.log(JSON.stringify(repairHandoff('handoff-activate'${options})));`;

test('handoff repair promotes a preparing record with an idle matching successor and never activates it', (t) => {
  const f = activationFixture(t, { record: { status: 'preparing' } });
  const result = repairModule(f, repairSource());
  assert.equal(result.repaired, true);
  assert.equal(result.status, 'prepared');
  assert.equal(result.previousStatus, 'preparing');
  assert.equal(result.dryRun, false);
  const stored = JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'))[0];
  assert.equal(stored.status, 'prepared');
  assert.equal(stored.preparedFrom, 'preparing');
  assert.equal(stored.readyAt, undefined, 'repair promotes the status only; it never invents a ready signal');
  const calls = f.calls();
  assert.equal(calls.some((args) => args[0] === 'pane' && args[1] === 'rename'), false, 'repair must not activate');
  assert.equal(calls.some((args) => args[0] === 'agent' && args[1] === 'prompt'), false, 'repair must prompt nobody');
});

// K27: a successor pane whose agent state is done is ready for the preparing guard, like idle.
test('handoff repair promotes a preparing record whose successor pane is done', (t) => {
  const f = activationFixture(t, { record: { status: 'preparing' } });
  setSuccessorStatus(f, 'done');
  const result = repairModule(f, repairSource());
  assert.equal(result.repaired, true);
  assert.equal(result.status, 'prepared');
  assert.match(result.reason, /the successor pane is done/);
  const stored = JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'))[0];
  assert.equal(stored.status, 'prepared');
  assert.equal(stored.readyAt, undefined, 'a done successor does not invent a ready signal');
  const calls = f.calls();
  assert.equal(calls.some((args) => args[0] === 'pane' && args[1] === 'rename'), false, 'repair must not activate');
  assert.equal(calls.some((args) => args[0] === 'agent' && args[1] === 'prompt'), false, 'repair must prompt nobody');
});

test('handoff repair still refuses a successor that works or runs another agent', (t) => {
  for (const [status, record] of [['working', { status: 'preparing' }], ['idle', { status: 'preparing', toKind: 'pi' }]]) {
    const f = activationFixture(t, { record });
    setSuccessorStatus(f, status);
    const result = repairModule(f, repairSource());
    assert.equal(result.repaired, false, `${status} ${record.toKind || 'codex'}`);
    assert.equal(result.reason, status === 'working' ? 'it works' : 'the successor pane runs another agent');
  }
});

test('handoff repair --dry-run states exactly what it would do for a done successor', (t) => {
  const f = activationFixture(t, { record: { status: 'preparing' } });
  setSuccessorStatus(f, 'done');
  const file = path.join(f.root, 'handoffs.json');
  const before = fs.readFileSync(file);
  const result = repairModule(f, repairSource(', { dryRun: true }'));
  assert.equal(result.wouldRepair, true);
  assert.equal(result.status, 'prepared');
  assert.equal(result.previousStatus, 'preparing');
  assert.match(result.reason, /the successor pane is done/);
  assert.match(result.reason, /would set the record to prepared/, 'the dry run names the transition it would make');
  assert.match(result.reason, /would not activate/, 'the dry run names what it would not do');
  assert.deepEqual(fs.readFileSync(file), before);
});

test('handoff repair --dry-run inspects the guarded transition and writes nothing', (t) => {
  const f = activationFixture(t, { record: { status: 'preparing' } });
  const file = path.join(f.root, 'handoffs.json');
  const before = fs.readFileSync(file);
  const result = repairModule(f, repairSource(', { dryRun: true }'));
  assert.equal(result.repaired, false);
  assert.equal(result.dryRun, true);
  assert.equal(result.previousStatus, 'preparing');
  assert.equal(result.status, 'prepared', 'the dry run reports the transition it would make');
  assert.deepEqual(fs.readFileSync(file), before, 'a dry run must not write the record file');
  const calls = f.calls();
  assert.equal(calls.some((args) => args[0] === 'agent' && args[1] === 'prompt'), false, 'a dry run must prompt nobody');
  assert.equal(calls.some((args) => args[0] === 'pane' && args[1] === 'rename'), false, 'a dry run must activate nobody');
});

test('handoff repair refuses a successor that works, is absent, or runs another kind', (t) => {
  const cases = [
    { record: { status: 'preparing', newPane: 'ws:p3', toKind: 'pi' }, reason: /works/i },
    { record: { status: 'preparing', newPane: 'ws:p9' }, reason: /absent/i },
    { record: { status: 'preparing', newPane: 'ws:p3', toKind: 'codex' }, reason: /another agent/i },
  ];
  for (const item of cases) {
    const f = activationFixture(t, { record: item.record });
    const result = repairModule(f, repairSource());
    assert.equal(result.repaired, false, item.record.newPane);
    assert.match(result.reason, item.reason);
    const stored = JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'))[0];
    assert.equal(stored.status, 'preparing', 'a refused repair leaves the record untouched');
    assert.equal(f.calls().some((args) => args[0] === 'agent' && args[1] === 'prompt'), false);
  }
});

test('handoff repair refuses a record that is not preparing or prepared', (t) => {
  const f = activationFixture(t, { record: { status: 'active' } });
  const result = repairModule(f, repairSource());
  assert.equal(result.repaired, false);
  assert.equal(result.reason, 'the record is active, not preparing or prepared');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'))[0].status, 'active');
});

// K26: an already prepared record needs no repair. The check runs before the successor pane read,
// so an absent or busy pane cannot report a pane fault for a record that is already prepared.
test('handoff repair reports an already prepared record as a successful no-op before it reads the pane', (t) => {
  const f = activationFixture(t, { record: { status: 'prepared', newPane: 'ws:p9' } });
  const result = repairModule(f, repairSource());
  assert.equal(result.repaired, false);
  assert.equal(result.noop, true);
  assert.equal(result.refused, undefined);
  assert.equal(result.status, 'prepared');
  assert.match(result.reason, /already prepared; nothing to repair/);
  assert.equal(fs.existsSync(path.join(f.root, 'herdr-calls.jsonl')), false, 'a prepared record needs no successor pane read');
  const stored = JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'))[0];
  assert.equal(stored.status, 'prepared');
  assert.equal(stored.repairedAt, undefined, 'a no-op writes no repair field');
});

test('handoff repair --dry-run on an already prepared record is a no-op and writes nothing', (t) => {
  const f = activationFixture(t, { record: { status: 'prepared', newPane: 'ws:p9' } });
  const file = path.join(f.root, 'handoffs.json');
  const before = fs.readFileSync(file);
  const result = repairModule(f, repairSource(', { dryRun: true }'));
  assert.equal(result.noop, true);
  assert.equal(result.wouldRepair, undefined);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('a refused repair returns structured refusal metadata for every refused state', (t) => {
  const refused = [
    { record: { status: 'expired' }, reason: /the record is expired/ },
    { record: { status: 'preparing', newPane: 'ws:p9' }, reason: /absent/ },
    { record: { status: 'preparing', newPane: 'ws:p3', toKind: 'pi' }, reason: /works/ },
    { record: { status: 'preparing', newPane: 'ws:p3', toKind: 'codex' }, reason: /another agent/ },
  ];
  for (const item of refused) {
    const f = activationFixture(t, { record: item.record });
    const result = repairModule(f, repairSource());
    assert.equal(result.refused, true, item.record.status);
    assert.equal(result.noop, undefined, item.record.status);
    assert.match(result.reason, item.reason);
  }
});

test('a repair that loses a concurrent change is refused, not repaired', (t) => {
  const f = activationFixture(t, { record: { status: 'preparing' } });
  concurrentExpiry(f);
  const result = repairModule(f, repairSource());
  assert.equal(result.repaired, false);
  assert.equal(result.refused, true);
  assert.match(result.reason, /changed during the repair/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'))[0].repairedAt, undefined);
});

test('the handoff repair CLI exits 0 for a repair, an eligible dry run, and a prepared no-op', (t) => {
  const repaired = activationFixture(t, { record: { status: 'preparing' } });
  const done = repairCli(repaired, ['handoff', 'repair', 'handoff-activate']);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /Repaired handoff handoff-activate/);

  const eligible = activationFixture(t, { record: { status: 'preparing' } });
  const dry = repairCli(eligible, ['handoff', 'repair', 'handoff-activate', '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /would repair/);

  const noop = activationFixture(t, { record: { status: 'prepared', newPane: 'ws:p9' } });
  const nothing = repairCli(noop, ['handoff', 'repair', 'handoff-activate']);
  assert.equal(nothing.status, 0, nothing.stderr);
  assert.match(nothing.stdout, /already prepared/);
});

test('the handoff repair CLI exits 1 for every refused state and a refused dry run writes nothing', (t) => {
  const expired = activationFixture(t, { record: { status: 'expired' } });
  assert.equal(repairCli(expired, ['handoff', 'repair', 'handoff-activate']).status, 1);

  const working = activationFixture(t, { record: { status: 'preparing', newPane: 'ws:p3', toKind: 'pi' } });
  assert.equal(repairCli(working, ['handoff', 'repair', 'handoff-activate']).status, 1);

  const file = path.join(working.root, 'handoffs.json');
  const before = fs.readFileSync(file);
  const dry = repairCli(working, ['handoff', 'repair', 'handoff-activate', '--dry-run']);
  assert.equal(dry.status, 1, dry.stderr);
  assert.deepEqual(fs.readFileSync(file), before, 'a refused dry run writes nothing');

  const raced = activationFixture(t, { record: { status: 'preparing' } });
  concurrentExpiry(raced);
  assert.equal(repairCli(raced, ['handoff', 'repair', 'handoff-activate']).status, 1);
});

test('the handoff repair CLI prints the guard result and the dry run', (t) => {
  const f = activationFixture(t, { record: { status: 'preparing' } });
  const printed = runHandoffCli(f.root, ['handoff', 'repair', 'handoff-activate'], f.env);
  assert.match(printed, /handoff-activate/);
  assert.match(printed, /preparing/);
  const inspect = activationFixture(t, { record: { status: 'preparing' } });
  const dry = runHandoffCli(inspect.root, ['handoff', 'repair', 'handoff-activate', '--dry-run'], { ...inspect.env, HERDR_BOSS_DIR: inspect.root });
  assert.match(dry, /dry/i);
});

test('handoff ready accepts a preparing automatic record with an idle matching successor', (t) => {
  const f = activationFixture(t, { record: { status: 'preparing', automatic: true } });
  const result = JSON.parse(runHandoffModule(f.root, `import { markHandoffReady } from ${JSON.stringify(handoffUrl)};
console.log(JSON.stringify(markHandoffReady('handoff-activate')));`, f.env));
  assert.equal(result.status, 'prepared');
  assert.ok(result.readyAt);
  assert.equal(result.preparedFrom, 'preparing');
});

test('handoff ready refuses a preparing record whose successor works, is absent, or runs another kind', (t) => {
  const cases = [
    { record: { status: 'preparing', automatic: true, newPane: 'ws:p3', toKind: 'pi' }, reason: /works/i },
    { record: { status: 'preparing', automatic: true, newPane: 'ws:p9' }, reason: /absent/i },
    { record: { status: 'preparing', automatic: true, newPane: 'ws:p3', toKind: 'codex' }, reason: /another agent/i },
  ];
  for (const item of cases) {
    const f = activationFixture(t, { record: item.record });
    const error = moduleError(f, `import { markHandoffReady } from ${JSON.stringify(handoffUrl)}; markHandoffReady('handoff-activate');`);
    assert.match(error, item.reason);
    const stored = JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'))[0];
    assert.equal(stored.status, 'preparing');
    assert.equal(stored.readyAt, undefined);
  }
});

// K27: a done successor is a settled pane, so `handoff ready` accepts it for a preparing record.
const donePane = [{ pane_id: 'ws:p8', workspace_id: 'ws', label: null, agent: 'codex', agent_status: 'done' }];

test('handoff ready accepts a done successor for a preparing automatic record', (t) => {
  const ready = activationFixture(t, { extraPanes: donePane, record: { status: 'preparing', automatic: true, newPane: 'ws:p8' } });
  const result = JSON.parse(runHandoffModule(ready.root, `import { markHandoffReady } from ${JSON.stringify(handoffUrl)};
console.log(JSON.stringify(markHandoffReady('handoff-activate')));`, ready.env));
  assert.equal(result.status, 'prepared');
  assert.equal(result.preparedFrom, 'preparing');
  assert.ok(result.readyAt, 'the successor reported ready, so the record carries the ready signal');
  assert.equal(JSON.parse(fs.readFileSync(path.join(ready.root, 'handoffs.json'), 'utf8'))[0].status, 'prepared');
});

// F3: only a real `pane_not_found` becomes an absent pane; other Herdr errors propagate.
test('handoff ready and activate normalize a real pane_not_found through the shared guard', (t) => {
  const ready = activationFixture(t, { paneErrors: { 'ws:p2': 'pane_not_found' }, record: { status: 'preparing', automatic: true } });
  const readyError = moduleError(ready, `import { markHandoffReady } from ${JSON.stringify(handoffUrl)}; markHandoffReady('handoff-activate');`);
  assert.match(readyError, /still preparing: the successor pane is absent/);

  const activate = activationFixture(t, { paneErrors: { 'ws:p2': 'pane_not_found' }, record: { status: 'preparing' } });
  assert.throws(() => activate.activate(), /not settled and ready: the successor pane is absent/);
});

test('handoff ready propagates a Herdr error that is not pane_not_found', (t) => {
  const f = activationFixture(t, { paneErrors: { 'ws:p2': 'pane_error' }, record: { status: 'preparing', automatic: true } });
  const error = moduleError(f, `import { markHandoffReady } from ${JSON.stringify(handoffUrl)}; markHandoffReady('handoff-activate');`);
  assert.match(error, /Pane error pane_error/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'))[0].status, 'preparing');
});

// F6: the repair command validates its shape before the writable-data probe and any Herdr call.
test('the handoff repair CLI rejects a flag as ID, an unknown flag, and extra arguments', (t) => {
  const f = activationFixture(t, { record: { status: 'preparing' } });
  for (const args of [['repair', '--dry-run'], ['repair', 'handoff-activate', '--bad'], ['repair', 'handoff-activate', 'extra']]) {
    assert.throws(() => runHandoffCli(f.root, ['handoff', ...args], f.env), (error) => {
      assert.match(String(error.stderr), /Usage: handoff repair ID/);
      return true;
    }, args.join(' '));
  }
  assert.equal(fs.existsSync(path.join(f.root, 'herdr-calls.jsonl')), false, 'no Herdr call is needed for a usage error');
});

test('handoff repair --dry-run performs no writable-data probe and leaves the store byte-identical', (t) => {
  const f = activationFixture(t, { record: { status: 'preparing' } });
  const file = path.join(f.root, 'handoffs.json');
  const before = fs.readFileSync(file);
  fs.mkdirSync(path.join(f.root, 'projects'), { recursive: true });
  // The fake herdr writes its call log outside the read-only data directory.
  const writable = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-boss-repair-calls-'));
  t.after(() => fs.rmSync(writable, { recursive: true, force: true }));
  const env = { ...f.env, TEST_CALLS: path.join(writable, 'calls.jsonl') };
  fs.chmodSync(f.root, 0o555);
  t.after(() => { try { fs.chmodSync(f.root, 0o755); } catch { /* the fixture cleanup may have removed the directory */ } });
  const printed = runHandoffCli(f.root, ['handoff', 'repair', 'handoff-activate', '--dry-run'], env);
  assert.match(printed, /dry run/i);
  assert.deepEqual(fs.readFileSync(file), before);
  // A real repair still probes the writable data directory and fails in this sandbox.
  assert.throws(() => runHandoffCli(f.root, ['handoff', 'repair', 'handoff-activate'], env), (error) => {
    assert.match(String(error.stderr), /cannot write|sandbox blocks/i);
    return true;
  });
  fs.chmodSync(f.root, 0o755);
  assert.deepEqual(fs.readFileSync(file), before);
});
