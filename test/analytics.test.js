// Aggregate figures for the Analytics page: notices per pane per day and the machine timeline.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { noticeCounts, machineTimeline, readEventTail, analyticsSummary, NOTICE_PANE_LIMIT } from '../src/analytics.js';

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-analytics-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const NOW = new Date(2026, 8, 30, 12, 0, 0).getTime();
const HOUR = 3600000;
const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

test('noticeCounts counts each notice for its pane and local day, and a digest counts its titles', () => {
  const events = [
    { at: new Date(NOW - HOUR).toISOString(), type: 'notify', pane: 'w1:p1', text: 'secret-client quota' },
    { at: new Date(NOW - 2 * HOUR).toISOString(), type: 'push', pane: 'w1:p1', titles: ['a', 'b', 'c'], text: 'Sent 3 notice(s) to w1:p1 (Secret Client)' },
    { at: new Date(NOW - 26 * HOUR).toISOString(), type: 'notify', pane: 'w2:p4' },
    { at: new Date(NOW - HOUR).toISOString(), type: 'notify', text: 'no pane' },
    { at: new Date(NOW - HOUR).toISOString(), type: 'error', pane: 'w1:p1' },
    { at: new Date(NOW - 9 * 24 * HOUR).toISOString(), type: 'notify', pane: 'w1:p1' },
  ];
  const r = noticeCounts(events, { days: 7, now: NOW });
  assert.equal(r.days.length, 7);
  assert.equal(r.days.at(-1), localDay(NOW));
  const p1 = r.panes.find((p) => p.pane === 'w1:p1');
  assert.equal(p1.total, 4);
  assert.equal(p1.counts.at(-1), 4);
  assert.equal(r.panes.find((p) => p.pane === 'w2:p4').total, 1);
  assert.equal(r.total, 5);
  // Counts and pane IDs only: no notice text, workspace name, or title.
  assert.doesNotMatch(JSON.stringify(r), /secret|Secret|client/);
});

test('noticeCounts folds the panes after the limit into other and rejects an odd pane ID', () => {
  const events = [];
  for (let i = 0; i < NOTICE_PANE_LIMIT + 2; i++) for (let n = 0; n <= i; n++) events.push({ at: new Date(NOW - HOUR).toISOString(), type: 'notify', pane: `w${i}:p1` });
  events.push({ at: new Date(NOW - HOUR).toISOString(), type: 'notify', pane: '/Users/x/private path' });
  const r = noticeCounts(events, { days: 7, now: NOW });
  assert.equal(r.panes.length, NOTICE_PANE_LIMIT + 1);
  assert.equal(r.panes.at(-1).pane, 'other');
  assert.equal(r.panes[0].pane, `w${NOTICE_PANE_LIMIT + 1}:p1`);
  assert.doesNotMatch(JSON.stringify(r), /Users|private/);
});

test('machineTimeline buckets the samples, marks held and waiting time, and skips old samples', () => {
  const start = NOW - 2 * HOUR;
  const samples = [];
  for (let m = 0; m < 120; m++) samples.push({
    at: new Date(start + m * 60000).toISOString(), l5: 24, cpus: 12, memFree: 25, swapMB: 2048, swapTotalMB: 8192,
    holders: m < 30 ? ['suite'] : [], waiters: m < 10 ? 2 : 0,
  });
  samples.push({ at: new Date(NOW - 30 * HOUR).toISOString(), l5: 99, cpus: 1, holders: [], waiters: 0 });
  const r = machineTimeline(samples, { hours: 24, bucketMin: 30, now: NOW });
  assert.equal(r.bucketMin, 30);
  assert.equal(r.points.length, 48);
  const filled = r.points.filter((p) => p.samples);
  assert.equal(filled.length, 4);
  assert.deepEqual({ load: filled[0].load, mem: filled[0].mem, swap: filled[0].swap }, { load: 200, mem: 75, swap: 25 });
  assert.equal(filled[0].heldMin, 30);
  assert.deepEqual(filled[0].holderKinds, { suite: 30 });
  assert.equal(filled[0].waitMin, 10);
  assert.equal(filled[0].waitersMax, 2);
  assert.equal(filled[1].heldMin, 0);
  assert.equal(r.points[0].samples, 0);
  assert.equal(r.points[0].load, null);
});

test('readEventTail reads only the end of a large log and skips a broken line', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'events.jsonl');
  const line = JSON.stringify({ at: new Date(NOW).toISOString(), type: 'notify', pane: 'w1:p1', text: 'x'.repeat(200) });
  fs.writeFileSync(file, `${Array(50).fill(line).join('\n')}\nbroken\n${line}\n`);
  const rows = readEventTail(file, { maxBytes: 2000 });
  assert.ok(rows.length > 0 && rows.length < 10);
  assert.ok(rows.every((r) => r.type === 'notify'));
  assert.deepEqual(readEventTail(path.join(dir, 'missing.jsonl')), []);
});

test('analyticsSummary reads the data folder and holds numbers, kinds, and pane IDs only', (t) => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ at: new Date(NOW - HOUR).toISOString(), type: 'notify', pane: 'w1:p1', text: 'Client Name' })}\n`);
  fs.writeFileSync(path.join(dir, 'machine-samples.jsonl'), `${JSON.stringify({ at: new Date(NOW - HOUR).toISOString(), l5: 6, cpus: 12, memFree: 50, swapMB: 0, swapTotalMB: 0, holders: [], waiters: 0 })}\n`);
  const r = analyticsSummary({ dataDir: dir, now: NOW });
  assert.equal(r.notices.total, 1);
  assert.equal(r.timeline.points.filter((p) => p.samples).length, 1);
  assert.doesNotMatch(JSON.stringify(r), /Client|\/Users|\/tmp|herdr-analytics/);
});
