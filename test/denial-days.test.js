import './helpers/test-env.js';
// Denials per day: the outcome of each cause, the daily series for 3, 7, and 30 days, and the aggregate of /api/analytics.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { denialOutcome, denialDaily, denialSummary, saveDenials, RETAIN_DAYS } from '../src/denials.js';
import { analyticsSummary } from '../src/analytics.js';
import { appendHarnessChange } from '../src/harness-changes.js';

const NOW = Date.parse('2026-03-20T12:00:00Z');
const DAY = 86400000;
const dayOf = (offset) => new Date(NOW - offset * DAY).toISOString().slice(0, 10);
const rec = (offset, harness, cause, count) => ({ day: dayOf(offset), harness, cause, project: 'p', model: 'unknown', count });

test('denialOutcome marks an approved escalation and every block, refusal, and sandbox error', () => {
  assert.deepEqual(denialOutcome('escalation:request'), { outcome: 'approved', classified: true });
  for (const cause of ['classifier:Irreversible Local Destruction', 'sandbox:eperm', 'sandbox:mach-port', 'guard:rm-rf', 'permission:bash', 'permission:unanswered:edit']) {
    assert.deepEqual(denialOutcome(cause), { outcome: 'refused', classified: true }, cause);
  }
});

test('denialOutcome counts a cause with no known outcome as refused and unclassified', () => {
  for (const cause of ['permission:asked:bash', 'something:new', '', undefined]) {
    assert.deepEqual(denialOutcome(cause), { outcome: 'refused', classified: false }, String(cause));
  }
});

test('denialDaily gives one count for each day and outcome, oldest day first, for 30 days', () => {
  const records = [
    rec(0, 'codex', 'escalation:request', 4),
    rec(0, 'codex', 'sandbox:eperm', 2),
    rec(1, 'claude', 'classifier:Other', 3),
    rec(1, 'codex', 'permission:asked:bash', 5),
    rec(29, 'codex', 'escalation:request', 100),
    rec(31, 'codex', 'sandbox:eperm', 999),
  ];
  const d = denialDaily(records, { now: NOW });
  assert.equal(d.days.length, 30);
  assert.equal(d.days[0], dayOf(29));
  assert.equal(d.days.at(-1), dayOf(0));
  assert.equal(RETAIN_DAYS, 30);
  const all = d.harnesses.all;
  assert.equal(all.refused.length, 30);
  assert.equal(all.refused.at(-1), 2);
  assert.equal(all.approved.at(-1), 4);
  assert.equal(all.refused.at(-2), 3 + 5);
  assert.equal(all.unclassified.at(-2), 5);
  assert.equal(all.approved[0], 100);
  assert.equal(all.refused.reduce((a, b) => a + b, 0), 2 + 3 + 5);
  assert.equal(d.harnesses.codex.approved.at(-1), 4);
  assert.equal(d.harnesses.claude.refused.at(-2), 3);
  assert.equal(d.harnesses.claude.approved.at(-2), 0);
  assert.deepEqual(Object.keys(d.harnesses).sort(), ['all', 'claude', 'codex', 'opencode', 'pi']);
});

test('denialDaily honors a shorter window: 3, 7, and 30 days', () => {
  const records = [rec(0, 'codex', 'escalation:request', 1), rec(2, 'codex', 'escalation:request', 2), rec(6, 'codex', 'escalation:request', 4), rec(20, 'codex', 'escalation:request', 8)];
  for (const [days, expected] of [[3, 3], [7, 7], [30, 15]]) {
    const d = denialDaily(records, { now: NOW, days });
    assert.equal(d.days.length, days);
    assert.equal(d.harnesses.all.approved.length, days);
    assert.equal(d.harnesses.all.approved.reduce((a, b) => a + b, 0), expected, `${days} days`);
  }
});

test('denialDaily ignores a bad record, an unknown harness for the harness series, and never throws', () => {
  const d = denialDaily([null, 5, { day: 'x', harness: 'codex', cause: 'sandbox:eperm', count: 1 }, { day: dayOf(0), harness: 'codex', cause: 'sandbox:eperm', count: -3 }, { day: dayOf(0), harness: 'other-tool', cause: 'sandbox:eperm', count: 2 }], { now: NOW });
  assert.equal(d.harnesses.all.refused.at(-1), 2);
  assert.equal(d.harnesses.codex.refused.at(-1), 0);
  assert.equal(Object.hasOwn(d.harnesses, 'other-tool'), false);
});

test('a row of denialSummary carries its outcome', () => {
  const s = denialSummary([rec(0, 'codex', 'escalation:request', 4), rec(0, 'codex', 'sandbox:eperm', 1), rec(0, 'opencode', 'permission:asked:bash', 1)], NOW);
  const by = Object.fromEntries(s.rows.map((r) => [r.cause, r.outcome]));
  assert.deepEqual(by, { 'escalation:request': 'approved', 'sandbox:eperm': 'refused', 'permission:asked:bash': 'refused' });
  assert.equal(s.rows.find((r) => r.cause === 'permission:asked:bash').classified, false);
});

test('analyticsSummary serves the 30-day denial series and the markers of the window', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-denial-days-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  saveDenials(dir, [rec(1, 'codex', 'escalation:request', 7), rec(1, 'codex', 'sandbox:eperm', 1)]);
  appendHarnessChange(dir, { harness: 'codex', label: 'Rule added', date: dayOf(2) });
  appendHarnessChange(dir, { harness: 'pi', label: 'Too old', date: dayOf(60) });
  appendHarnessChange(dir, { harness: 'pi', label: 'In the future', date: dayOf(-5) });
  const s = analyticsSummary({ dataDir: dir, now: NOW });
  assert.equal(s.denials.days.length, 30);
  assert.equal(s.denials.harnesses.all.approved.at(-2), 7);
  assert.equal(s.denials.harnesses.all.refused.at(-2), 1);
  assert.deepEqual(s.harnessChanges, [{ date: dayOf(2), harness: 'codex', label: 'Rule added' }]);
});

test('analyticsSummary serves empty denials and markers when the data dir has no files', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-denial-days-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = analyticsSummary({ dataDir: dir, now: NOW });
  assert.equal(s.denials.days.length, 30);
  assert.equal(s.denials.harnesses.all.refused.every((n) => n === 0), true);
  assert.deepEqual(s.harnessChanges, []);
});
