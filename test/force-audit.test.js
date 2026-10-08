import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ACTION_AUDIT_FILE, appendForcedAction, forceReason } from '../src/force-audit.js';

test('forced action audit redacts the reason and keeps at most 500 JSON lines', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-force-audit-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, ACTION_AUDIT_FILE);
  const oldRows = Array.from({ length: 500 }, (_, index) => JSON.stringify({ time: '2026-10-08T00:00:00.000Z', command: 'old', project: null, workerName: null, refusalKind: 'none', reason: String(index) }));
  fs.writeFileSync(file, `${oldRows.join('\n')}\n`);

  appendForcedAction({
    dataDir, time: '2026-10-08T12:00:00.000Z', command: 'worker start', project: 'herdrboss', workerName: 'k5747',
    refusalKind: 'disk-space', reason: 'Owner approved api_key="sample"',
  });

  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 500);
  assert.deepEqual(rows.at(-1), {
    time: '2026-10-08T12:00:00.000Z', command: 'worker start', project: 'herdrboss', workerName: 'k5747',
    refusalKind: 'disk-space', reason: 'Owner approved api_key=[REDACTED]',
  });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('force reasons require 1 to 300 characters and cannot be used without force', () => {
  assert.throws(() => forceReason(true, ''), /1 to 300 characters/);
  assert.throws(() => forceReason(true, 'x'.repeat(301)), /1 to 300 characters/);
  assert.throws(() => forceReason(false, 'reason'), /needs --force/);
  assert.equal(forceReason(true, ' approved '), 'approved');
});
