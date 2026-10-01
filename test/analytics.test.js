import './helpers/test-env.js';
// Aggregate figures for the Analytics page: notices per pane per day and the machine timeline.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { noticeCounts, machineTimeline, memoryByClass, readEventTail, analyticsSummary, lockDaily, NOTICE_PANE_LIMIT } from '../src/analytics.js';
import * as analytics from '../src/analytics.js';

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-analytics-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const NOW = new Date(2026, 8, 30, 12, 0, 0).getTime();
const HOUR = 3600000;
const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

test('agent communication counts projects, kinds, task nudges and response percentiles', () => {
  const at = new Date(NOW - HOUR).toISOString();
  const rows = Array.from({ length: 10 }, (_, i) => ({
    id: `a${i}`, at, project: 'orchard', kind: i < 2 ? 'nudge' : i < 5 ? 'reminder' : 'task', taskId: 'T1',
    to: { role: 'worker', kind: 'codex', model: 'sample-model' },
    respondedAt: new Date(NOW - HOUR + (i + 1) * 1000).toISOString(),
  }));
  rows.push({ id: 'b', at, project: 'lantern', kind: 'reply', to: { role: 'orch', project: 'lantern', pane: 'wB:p1' }, respondedAt: null });
  rows.push({ id: 'old', at: new Date(NOW - 10 * 24 * HOUR).toISOString(), project: 'orchard', kind: 'reminder' });
  rows.push({ id: 'future', at: new Date(NOW + HOUR).toISOString(), project: 'orchard', kind: 'task' });
  rows.push({ id: 'failed', at, project: 'orchard', kind: 'nudge', status: 'failed' });
  const result = analytics.agentCommunication(rows, { now: NOW });
  assert.equal(result.total, 11);
  assert.equal(result.reminders, 3);
  assert.equal(result.reminderShare, 3 / 11);
  assert.equal(result.projects.find(p => p.project === 'orchard').counts.nudge.at(-1), 2);
  assert.deepEqual(result.nudgesPerTask, [{ project: 'orchard', taskId: 'T1', nudges: 2 }]);
  assert.deepEqual(result.workers, [{ kind: 'codex', model: 'sample-model', messages: 10, responses: 10, medianMs: 5500, p90Ms: 9000 }]);
  assert.equal(result.orchestrators[0].responses, 0);
  assert.equal(result.orchestrators[0].medianMs, null);
  const empty = analytics.agentCommunication([], { now: NOW });
  assert.equal(empty.total, 0);
  assert.equal(empty.reminderShare, null);
  assert.deepEqual(empty.workers, []);
});

test('analyticsSummary reads all communication metadata without the API page limit or writes', (t) => {
  const dataDir = tmp(t);
  const file = path.join(dataDir, 'agent-message-meta.jsonl');
  const rows = Array.from({ length: 501 }, (_, i) => ({ id: `a${i}`, at: new Date(NOW - HOUR).toISOString(), project: 'orchard', kind: 'reminder', to: { role: 'orch', pane: 'wA:p1' } }));
  const text = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(file, text);
  const result = analyticsSummary({ dataDir, now: NOW });
  assert.equal(result.agentCommunication.total, 501);
  assert.deepEqual(result.actionsMinutes, { available: false, weeks: [], repos: [], updatedAt: null });
  assert.equal(result.agentCommunication.reminderShare, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.equal(fs.existsSync(`${file}.lock`), false);
  assert.doesNotMatch(JSON.stringify(result.agentCommunication), /respondedAt|"text"/);
  assert.deepEqual(analyticsSummary({ dataDir, now: NOW, actionsMinutesEnabled: false }).actionsMinutes, { available: false, weeks: [], repos: [], updatedAt: null });
});

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

test('memoryByClass averages each class per bucket, keeps every class, and finds the peak', () => {
  const at = (ms) => new Date(ms).toISOString();
  const line = (ms, mb) => ({ at: at(ms), mb });
  const samples = [
    line(NOW - 20 * 60000, { claude: 3000, codex: 1000, browsers: 4000, mcp: 500, vitest: 200, other: 900 }),
    line(NOW - 10 * 60000, { claude: 3200, codex: 1000, browsers: 2000, mcp: 500, vitest: 0, other: 900 }),
    line(NOW - 2 * 3600000, { claude: 1000, codex: 0, browsers: 9000, mcp: 0, vitest: 0, other: 100 }),
    line(NOW - 40 * 3600000, { claude: 99999, codex: 0, browsers: 0, mcp: 0, vitest: 0, other: 0 }),
    line(NOW + 3600000, { claude: 99999, codex: 0, browsers: 0, mcp: 0, vitest: 0, other: 0 }),
  ];
  const r = memoryByClass(samples, { hours: 24, bucketMin: 60, now: NOW });
  assert.equal(r.bucketMin, 60);
  assert.equal(r.hours, 24);
  assert.equal(r.points.length, 24);
  assert.equal(r.classes.join(), 'claude,codex,browsers,mcp,vitest,other');
  const last = r.points.at(-1);
  assert.equal(last.samples, 2);
  // A bucket holds the mean of its samples, so a column reads the memory of all classes at one time.
  // The samples add up to 6200 MB of Claude, and the mean of the bucket is 3100 MB.
  assert.deepEqual(last.mb, { claude: 3100, codex: 1000, browsers: 3000, mcp: 500, vitest: 100, other: 900 });
  assert.equal(last.total, 8600);
  const empty = r.points[0];
  assert.equal(empty.samples, 0);
  assert.deepEqual(empty.mb, { claude: 0, codex: 0, browsers: 0, mcp: 0, vitest: 0, other: 0 });
  assert.equal(empty.total, 0);
  // The peak per class is the higher of the highest bucket mean and the highest single sample.
  assert.deepEqual(r.peak, { claude: 3200, codex: 1000, browsers: 9000, mcp: 500, vitest: 200, other: 900 });
  assert.equal(r.latest.at, at(NOW - 10 * 60000));
  assert.equal(r.latest.mb.claude, 3200);
  assert.equal(r.latest.total, 7600);
});

test('memoryByClass rounds the mean to whole MB and holds the peak of a class with one sample in the window', () => {
  const at = (ms) => new Date(ms).toISOString();
  const r = memoryByClass([
    { at: at(NOW - 30 * 60000), mb: { claude: 1000, browsers: 3000 } },
    { at: at(NOW - 25 * 60000), mb: { claude: 1001, browsers: 0 } },
    { at: at(NOW - 3 * 3600000), mb: { codex: 777 } },
  ], { hours: 24, bucketMin: 60, now: NOW });
  const last = r.points.at(-1);
  assert.deepEqual(last.mb, { claude: 1001, codex: 0, browsers: 1500, mcp: 0, vitest: 0, other: 0 }, 'the mean of 1000 and 1001 rounds to 1001');
  assert.equal(r.points.at(-3).mb.codex, 777, 'one sample in the bucket is its own mean');
  assert.deepEqual(r.peak, { claude: 1001, codex: 777, browsers: 3000, mcp: 0, vitest: 0, other: 0 });
});

test('memoryByClass on no samples gives 24 empty buckets, a zero peak, and no latest sample', () => {
  const r = memoryByClass([], { hours: 24, bucketMin: 60, now: NOW });
  assert.equal(r.points.length, 24);
  assert.equal(r.points.filter((p) => p.samples).length, 0);
  assert.equal(r.peak.claude, 0);
  assert.equal(r.latest, null);
  assert.equal(memoryByClass(undefined, { now: NOW }).points.length, 24);
  assert.equal(memoryByClass([{ at: 'nope', mb: { claude: 1 } }], { now: NOW }).points.filter((p) => p.samples).length, 0);
  assert.equal(memoryByClass([{ at: new Date(NOW - 60000).toISOString(), mb: { private: 5 } }], { now: NOW }).points.filter((p) => p.samples).length, 1, 'an unknown class counts as a sample but adds no MB');
  assert.equal(memoryByClass([{ at: new Date(NOW - 60000).toISOString(), mb: { private: 5 } }], { now: NOW }).latest.mb.claude, 0);
});

test('analyticsSummary adds memoryByClass from the memory samples', (t) => {
  const dir = tmp(t);
  const mb = { claude: 4000, codex: 2000, browsers: 6000, mcp: 500, vitest: 100, other: 3000 };
  fs.writeFileSync(path.join(dir, 'memory-samples.jsonl'), `${JSON.stringify({ at: new Date(NOW - 300000).toISOString(), mb })}\n`);
  fs.writeFileSync(path.join(dir, 'memory-samples.1.jsonl'), `${JSON.stringify({ at: new Date(NOW - 40 * 3600000).toISOString(), mb: { claude: 1, codex: 0, browsers: 0, mcp: 0, vitest: 0, other: 0 } })}\n`);
  const r = analyticsSummary({ dataDir: dir, now: NOW });
  assert.equal(r.memoryByClass.points.filter((p) => p.samples).length, 1, 'the rotated line is outside the 24-hour window');
  assert.equal(r.memoryByClass.points.at(-1).mb.claude, 4000);
  assert.deepEqual(r.memoryByClass.peak, mb);
  assert.doesNotMatch(JSON.stringify(r), /private|herdr-analytics/);
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

test('lockDaily sums the wait and the hold of each project for each local day', () => {
  const at = (ms) => new Date(ms).toISOString();
  const rows = [
    { at: at(NOW - HOUR), event: 'acquire', kind: 'suite', project: 'alpha', waitMs: 60000 },
    { at: at(NOW - HOUR), event: 'release', kind: 'suite', project: 'alpha', holdMs: 300000 },
    { at: at(NOW - 2 * HOUR), event: 'acquire', kind: 'suite', project: 'alpha', reentrant: true, waitMs: 0 },
    { at: at(NOW - 2 * HOUR), event: 'release', kind: 'suite', project: 'alpha', reentrant: true, holdMs: 999999 },
    { at: at(NOW - 2 * HOUR), event: 'release', kind: 'suite', project: 'alpha', takeover: true, holdMs: 888888 },
    { at: at(NOW - 2 * HOUR), event: 'acquire', kind: 'push', project: 'alpha', reused: true, waitMs: 0 },
    { at: at(NOW - 26 * HOUR), event: 'acquire', kind: 'push', project: 'beta', waitMs: 120000 },
    { at: at(NOW - 26 * HOUR), event: 'timeout', kind: 'push', project: 'beta', waitMs: 1800000 },
    { at: at(NOW - 9 * 24 * HOUR), event: 'acquire', kind: 'suite', project: 'beta', waitMs: 5000 },
    { at: at(NOW - HOUR), event: 'acquire', kind: 'suite', project: '/Users/x/private path', waitMs: 1000 },
  ];
  const r = lockDaily(rows, { days: 7, now: NOW });
  assert.equal(r.days.length, 7);
  assert.equal(r.days.at(-1), localDay(NOW));
  const alpha = r.projects.find((p) => p.project === 'alpha');
  assert.deepEqual({ wait: alpha.wait.at(-1), hold: alpha.hold.at(-1), runs: alpha.runs.at(-1) }, { wait: 60000, hold: 300000, runs: 1 });
  const beta = r.projects.find((p) => p.project === 'beta');
  assert.deepEqual({ wait: beta.wait.at(-2), timeouts: beta.timeouts.at(-2), total: beta.waitTotal }, { wait: 120000, timeouts: 1, total: 120000 });
  assert.equal(r.projects[0].project, 'alpha', 'sorted by wait and hold');
  assert.ok(r.projects.some((p) => p.project === 'other'));
  assert.equal(r.totals.wait.at(-1), 61000);
  assert.doesNotMatch(JSON.stringify(r), /Users|private/);
  assert.deepEqual(lockDaily([], { days: 7, now: NOW }).projects, []);
});

test('lockDaily separates lane waits and reports the short wait median', () => {
  const at = new Date(NOW - HOUR).toISOString();
  const rows = [
    { at, event: 'acquire', project: 'alpha', lane: 'short', waitMs: 4000 },
    { at, event: 'acquire', project: 'alpha', lane: 'short', waitMs: 8000 },
    { at, event: 'acquire', project: 'alpha', lane: 'long', waitMs: 1000 },
    { at, event: 'acquire', project: 'alpha', waitMs: 9000 },
  ];
  const result = lockDaily(rows, { days: 7, now: NOW });
  const alpha = result.projects.find((project) => project.project === 'alpha');
  assert.equal(alpha.waitByLane.short.at(-1), 12000);
  assert.equal(alpha.waitByLane.long.at(-1), 10000, 'a record without a lane counts as long');
  assert.equal(alpha.medianWaitMsByLane.short, 6000);
  assert.equal(result.byLane.short.medianWaitMs, 6000);
  assert.equal(result.byLane.long.medianWaitMs, 5000);
});

test('analyticsSummary reads the lock ledger from the last 2 MB only', (t) => {
  const dir = tmp(t);
  const line = (n) => JSON.stringify({ at: new Date(NOW - HOUR).toISOString(), event: 'acquire', name: 'full-suite', project: 'alpha', kind: 'suite', waitMs: n });
  const old = JSON.stringify({ at: new Date(NOW - HOUR).toISOString(), event: 'acquire', project: 'old', kind: 'suite', waitMs: 7, pad: 'x'.repeat(200) });
  fs.writeFileSync(path.join(dir, 'lock-ledger.jsonl'), `${Array(12000).fill(old).join('\n')}\n${line(60000)}\n`);
  const r = analyticsSummary({ dataDir: dir, now: NOW });
  assert.equal(r.locks.projects.find((p) => p.project === 'alpha').waitTotal, 60000);
  assert.ok(r.locks.projects.find((p) => p.project === 'old').waitTotal < 12000 * 7, 'the head of the file is not read');
});


test('LK3 R6 Analytics supplies sampled slot use and predictions for each project and kind', (t) => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify({ locks: { slots: 3, shortLimitMinutes: 2 } }));
  const release = (project, kind, holdMs, index) => ({ at: new Date(NOW - (8 + index) * 86400000).toISOString(),
    event: 'release', name: 'full-suite', project, kind, holdMs });
  const rows = [0, 1, 2].flatMap((i) => [release('alpha', 'suite', 60000 + i * 60000, i), release('alpha', 'push', 900000, i)]);
  rows.push(release('beta', 'manual', 30000, 0));
  rows.push(release('alpha', 'suite', 999999, 0), release('/private/path', 'suite', 1, 0));
  rows.at(-2).takeover = true;
  fs.writeFileSync(path.join(dir, 'lock-ledger.1.jsonl'), rows.map(JSON.stringify).join('\n'));
  fs.writeFileSync(path.join(dir, 'machine-samples.jsonl'), [
    { at: new Date(NOW - 60000).toISOString(), holders: ['suite', 'push'] },
    { at: new Date(NOW + 60000).toISOString(), holders: [] },
  ].map(JSON.stringify).join('\n'));
  const admission = analyticsSummary({ dataDir: dir, now: NOW }).locks.admission;
  assert.ok(admission, 'Analytics must include admission data even without 7-day history');
  assert.equal(admission.slotLimit, 3);
  assert.equal(admission.slotsInUse, 2);
  assert.equal(admission.sampledAt, new Date(NOW - 60000).toISOString());
  const suite = admission.predictions.find((p) => p.project === 'alpha' && p.kind === 'suite');
  assert.deepEqual(suite, { project: 'alpha', kind: 'suite', name: 'full-suite', lane: 'short', predictedMs: 120000, samples: 3 });
  assert.equal(admission.predictions.find((p) => p.kind === 'push').lane, 'long');
  assert.equal(admission.predictions.find((p) => p.project === 'beta').predictedMs, null);
  assert.doesNotMatch(JSON.stringify(admission), /private|path/);
  fs.writeFileSync(path.join(dir, 'machine-samples.jsonl'), JSON.stringify({ at: new Date(NOW - 180001).toISOString(), holders: ['suite'] }));
  assert.equal(analyticsSummary({ dataDir: dir, now: NOW }).locks.admission.slotsInUse, null, 'stale use is unknown, not zero');
});
