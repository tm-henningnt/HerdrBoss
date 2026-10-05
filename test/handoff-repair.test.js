import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activationFixture, runHandoffCli, runHandoffModule } from './helpers/handoff-fixture.js';

const handoffUrl = new URL('../src/handoff.js', import.meta.url).href;

function repairModule(f, source) {
  return JSON.parse(runHandoffModule(f.root, source, f.env));
}

function moduleError(f, source) {
  try { runHandoffModule(f.root, source, f.env); }
  catch (error) { return String(error.stderr || error.message); }
  return '';
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

test('the handoff repair CLI prints the guard result and the dry run', (t) => {
  const f = activationFixture(t, { record: { status: 'preparing' } });
  const printed = runHandoffCli(f.root, ['handoff', 'repair', 'handoff-activate'], f.env);
  assert.match(printed, /handoff-activate/);
  assert.match(printed, /preparing/);
  const dry = runHandoffCli(f.root, ['handoff', 'repair', 'handoff-activate', '--dry-run'], { ...f.env, HERDR_BOSS_DIR: f.root });
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

// F1: a `preparing` transition requires exactly `idle`. A `done` successor is refused.
const donePane = [{ pane_id: 'ws:p8', workspace_id: 'ws', label: null, agent: 'codex', agent_status: 'done' }];

test('handoff ready and repair refuse a done successor for a preparing record', (t) => {
  const ready = activationFixture(t, { extraPanes: donePane, record: { status: 'preparing', automatic: true, newPane: 'ws:p8' } });
  const readyError = moduleError(ready, `import { markHandoffReady } from ${JSON.stringify(handoffUrl)}; markHandoffReady('handoff-activate');`);
  assert.match(readyError, /still preparing: the successor pane is done/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ready.root, 'handoffs.json'), 'utf8'))[0].status, 'preparing');

  const repair = activationFixture(t, { extraPanes: donePane, record: { status: 'preparing', newPane: 'ws:p8' } });
  const result = repairModule(repair, repairSource());
  assert.equal(result.repaired, false);
  assert.equal(result.reason, 'the successor pane is done');
  assert.equal(JSON.parse(fs.readFileSync(path.join(repair.root, 'handoffs.json'), 'utf8'))[0].status, 'preparing');
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
