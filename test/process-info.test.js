import './helpers/test-env.js';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { processInfo } from '../src/kit/process-info.js';

test('processInfo treats a zombie as dead although the PID probe succeeds', (t) => {
  t.mock.method(childProcess, 'spawnSync', (command, args) => {
    assert.equal(command, 'ps');
    assert.ok(args.includes('stat='), 'read process state without its command or environment');
    return { status: 0, stdout: 'Z Mon Sep 28 10:00:00 2026\n' };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.deepEqual(processInfo(process.pid), { alive: false, start: null });
  assert.deepEqual(processInfo(process.pid, { wantStart: false, wantState: true }), { alive: false, start: null });
});

test('processInfo reads a live start and keeps unreadable state conservative', (t) => {
  let response = { status: 0, stdout: 'S+ Mon Sep 28 10:00:00 2026\n' };
  const probe = t.mock.method(childProcess, 'spawnSync', () => response);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.deepEqual(processInfo(process.pid), { alive: true, start: 'Mon Sep 28 10:00:00 2026' });
  assert.deepEqual(processInfo(process.pid, { wantStart: false }), { alive: true, start: null });
  assert.equal(probe.mock.callCount(), 1, 'a PID-only lease probe still needs no process-table call');
  response = { status: 1, stdout: '' };
  assert.deepEqual(processInfo(process.pid), { alive: true, start: null });
});
