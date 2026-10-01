import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { readMachineSamples } from './machine-samples.js';
import { readMemorySamples, MEMORY_CLASSES } from './memory-classes.js';
import { readDenials, denialDaily, RETAIN_DAYS } from './denials.js';
import { readHarnessChanges } from './harness-changes.js';
import { readPolicyChanges } from './policy-log.js';
import { lockLaneSettings } from './kit/locks.js';
import { classifyLockLane, readLockDurationPrediction } from './kit/lock-lanes.js';

// Aggregate figures for the Analytics page. The result holds numbers, lock kinds, and pane IDs only:
// no notice text, workspace name, path, or command. The policy changes hold policy keys, which name a project, and scalar values.

export const NOTICE_PANE_LIMIT = 5;
export const EVENT_TAIL_BYTES = 2 * 1024 * 1024;
const MINUTE = 60000;
const PANE_ID = /^[A-Za-z0-9_-]{1,24}(:[A-Za-z0-9_-]{1,24})?$/;

const localDay = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const round = (value) => (value === null ? null : Math.round(value));
const finite = (value) => (value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null);
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

// Reads the last maxBytes of a JSONL file. The first line of the tail can be cut, so a line that does not parse is skipped.
export function readEventTail(file, { maxBytes = EVENT_TAIL_BYTES } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const rows = [];
    for (const raw of buffer.toString('utf8').split('\n')) {
      if (!raw) continue;
      try { const row = JSON.parse(raw); if (row && typeof row === 'object') rows.push(row); } catch {}
    }
    return rows;
  } catch { return []; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Notices sent to each pane on each local day. A single notice counts 1; a digest counts each title in it.
// The panes after the first NOTICE_PANE_LIMIT, by total, fold into 'other'.
export function noticeCounts(events, { days = 7, now = Date.now() } = {}) {
  const dayList = Array.from({ length: days }, (_, i) => localDay(now - (days - 1 - i) * 86400000));
  const index = new Map(dayList.map((d, i) => [d, i]));
  const byPane = new Map();
  for (const e of events || []) {
    if (e?.type !== 'notify' && e?.type !== 'push') continue;
    if (typeof e.pane !== 'string' || !e.pane) continue;
    const at = Date.parse(e.at);
    if (!Number.isFinite(at) || at > now) continue;
    const i = index.get(localDay(at));
    if (i === undefined) continue;
    const pane = PANE_ID.test(e.pane) ? e.pane : 'other';
    const counts = byPane.get(pane) || Array(days).fill(0);
    counts[i] += e.type === 'push' && Array.isArray(e.titles) && e.titles.length ? e.titles.length : 1;
    byPane.set(pane, counts);
  }
  const rows = [...byPane].map(([pane, counts]) => ({ pane, counts, total: counts.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => (a.pane === 'other') - (b.pane === 'other') || b.total - a.total || a.pane.localeCompare(b.pane));
  const kept = rows.filter((r) => r.pane !== 'other').slice(0, NOTICE_PANE_LIMIT);
  const rest = rows.filter((r) => !kept.includes(r));
  if (rest.length) {
    const counts = Array(days).fill(0);
    for (const r of rest) r.counts.forEach((n, i) => { counts[i] += n; });
    kept.push({ pane: 'other', counts, total: counts.reduce((a, b) => a + b, 0) });
  }
  return { days: dayList, panes: kept, total: kept.reduce((a, r) => a + r.total, 0) };
}

// Resident memory per process class over the last hours, in buckets of bucketMin minutes, oldest first.
// Each bucket sums the memory of the samples in it, so a column reads the memory of all classes at one time.
// peak holds the highest bucket of each class in the window. latest holds the newest sample in the window.
export function memoryByClass(samples, { hours = 24, bucketMin = 60, now = Date.now() } = {}) {
  const size = bucketMin * MINUTE;
  const end = Math.ceil(now / size) * size;
  const count = Math.round((hours * 60) / bucketMin);
  const start = end - count * size;
  const empty = () => Object.fromEntries(MEMORY_CLASSES.map((key) => [key, 0]));
  const buckets = Array.from({ length: count }, () => ({ samples: 0, mb: empty() }));
  const peak = empty();
  let latest = null;
  for (const s of samples || []) {
    const at = Date.parse(s?.at);
    if (!Number.isFinite(at) || at < start || at >= end) continue;
    const mb = empty();
    for (const key of MEMORY_CLASSES) {
      const value = finite(s.mb?.[key]);
      if (value !== null) mb[key] = value;
    }
    const total = MEMORY_CLASSES.reduce((sum, key) => sum + mb[key], 0);
    const b = buckets[Math.floor((at - start) / size)];
    b.samples++;
    for (const key of MEMORY_CLASSES) {
      b.mb[key] += mb[key];
      peak[key] = Math.max(peak[key], b.mb[key]);
    }
    if (!latest || at >= Date.parse(latest.at)) latest = { at: s.at, mb, total };
  }
  return {
    hours,
    bucketMin,
    classes: MEMORY_CLASSES,
    start: new Date(start).toISOString(),
    points: buckets.map((b, i) => ({ at: new Date(start + i * size).toISOString(), samples: b.samples, mb: b.mb, total: round(MEMORY_CLASSES.reduce((sum, key) => sum + b.mb[key], 0)) })),
    peak,
    latest,
  };
}

// Machine samples of the last hours in buckets of bucketMin minutes, oldest first.
// load is the 5-minute load as a percent of the cores; mem is memory in use and swap is swap in use, both in percent.
// heldMin counts the minutes with a lock holder, waitMin the minutes with a waiter.
export function machineTimeline(samples, { hours = 24, bucketMin = 10, now = Date.now() } = {}) {
  const size = bucketMin * MINUTE;
  const end = Math.ceil(now / size) * size;
  const count = Math.round((hours * 60) / bucketMin);
  const start = end - count * size;
  const buckets = Array.from({ length: count }, () => ({ load: [], mem: [], swap: [], heldMin: 0, waitMin: 0, waitersMax: 0, holderKinds: {}, samples: 0 }));
  for (const s of samples || []) {
    const at = Date.parse(s?.at);
    if (!Number.isFinite(at) || at < start || at >= end) continue;
    const b = buckets[Math.floor((at - start) / size)];
    b.samples++;
    const l5 = finite(s.l5), cpus = finite(s.cpus), memFree = finite(s.memFree), swapMB = finite(s.swapMB), swapTotal = finite(s.swapTotalMB);
    if (l5 !== null && cpus) b.load.push((l5 / cpus) * 100);
    if (memFree !== null) b.mem.push(100 - memFree);
    if (swapMB !== null && swapTotal) b.swap.push((swapMB / swapTotal) * 100);
    const holders = Array.isArray(s.holders) ? s.holders : [];
    if (holders.length) {
      b.heldMin++;
      for (const kind of holders) {
        const k = typeof kind === 'string' && /^[a-z0-9-]{1,32}$/.test(kind) ? kind : 'other';
        b.holderKinds[k] = (b.holderKinds[k] || 0) + 1;
      }
    }
    const waiters = finite(s.waiters) || 0;
    if (waiters > 0) b.waitMin++;
    b.waitersMax = Math.max(b.waitersMax, waiters);
  }
  return {
    hours,
    bucketMin,
    start: new Date(start).toISOString(),
    points: buckets.map((b, i) => ({
      at: new Date(start + i * size).toISOString(),
      samples: b.samples,
      load: round(mean(b.load)),
      mem: round(mean(b.mem)),
      swap: round(mean(b.swap)),
      heldMin: b.heldMin,
      waitMin: b.waitMin,
      waitersMax: b.waitersMax,
      holderKinds: b.holderKinds,
    })),
  };
}

const PROJECT_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

// Lock wait and hold for each project for each local day. The wait comes from acquire lines and the hold from release lines.
// Lines of a re-entrant suite, a reused push, and a takeover add nothing: they hold no lock time of their own.
// A timeout counts in timeouts only. The project is a slug or other.
export function lockDaily(rows, { days = 7, now = Date.now() } = {}) {
  const dayList = Array.from({ length: days }, (_, i) => localDay(now - (days - 1 - i) * 86400000));
  const index = new Map(dayList.map((d, i) => [d, i]));
  const empty = () => Array(days).fill(0);
  const emptyLanes = () => ({ long: empty(), short: empty() });
  const laneWaitSamples = { long: [], short: [] };
  const laneWait = emptyLanes();
  const laneRuns = emptyLanes();
  const laneTimeouts = emptyLanes();
  const byProject = new Map();
  for (const row of rows || []) {
    const at = Date.parse(row?.at);
    if (!Number.isFinite(at) || at > now) continue;
    const i = index.get(localDay(at));
    if (i === undefined) continue;
    const project = typeof row.project === 'string' && PROJECT_SLUG.test(row.project) ? row.project : 'other';
    const entry = byProject.get(project) || {
      project, wait: empty(), hold: empty(), runs: empty(), timeouts: empty(),
      waitByLane: emptyLanes(), laneWaitSamples: { long: [], short: [] },
    };
    byProject.set(project, entry);
    if (row.reentrant || row.reused) continue;
    if (row.event === 'acquire') {
      entry.runs[i] += 1;
      const waitMs = finite(row.waitMs) || 0;
      const lane = row.lane === 'short' ? 'short' : 'long';
      entry.wait[i] += waitMs;
      entry.waitByLane[lane][i] += waitMs;
      entry.laneWaitSamples[lane].push(waitMs);
      laneWait[lane][i] += waitMs;
      laneWaitSamples[lane].push(waitMs);
      laneRuns[lane][i] += 1;
    } else if (row.event === 'release' && !row.takeover) {
      entry.hold[i] += finite(row.holdMs) || 0;
    } else if (row.event === 'timeout') {
      entry.timeouts[i] += 1;
      const lane = row.lane === 'short' ? 'short' : 'long';
      laneTimeouts[lane][i] += 1;
    }
  }
  const sum = (values) => values.reduce((a, b) => a + b, 0);
  const projects = [...byProject.values()].map((p) => {
    const { laneWaitSamples: samples, ...entry } = p;
    return {
      ...entry,
      waitTotal: sum(p.wait), holdTotal: sum(p.hold),
      medianWaitMsByLane: { long: median(samples.long), short: median(samples.short) },
    };
  })
    .filter((p) => p.waitTotal + p.holdTotal + sum(p.runs) + sum(p.timeouts) > 0)
    .sort((a, b) => (a.project === 'other') - (b.project === 'other') || b.waitTotal + b.holdTotal - (a.waitTotal + a.holdTotal) || a.project.localeCompare(b.project));
  const totals = { wait: empty(), hold: empty() };
  for (const p of projects) for (let i = 0; i < days; i++) { totals.wait[i] += p.wait[i]; totals.hold[i] += p.hold[i]; }
  return {
    days: dayList, projects, totals,
    byLane: Object.fromEntries(['long', 'short'].map((lane) => [lane, {
      wait: laneWait[lane], runs: laneRuns[lane], timeouts: laneTimeouts[lane],
      medianWaitMs: median(laneWaitSamples[lane]),
    }])),
  };
}

// The harness change markers that fall on a day of the denial window.
function markersIn(days, dataDir) {
  const first = days[0], last = days.at(-1);
  return readHarnessChanges(dataDir).filter((m) => m.date >= first && m.date <= last);
}

// Capacity is the saved policy. Use is a machine sample snapshot, never a project count.
// Predictions use the same retained 14-day history as lock admission, including the rotated ledger.
function lockAdmissionSummary(samples, { dataDir, now }) {
  const settings = lockLaneSettings(dataDir);
  const sample = samples.filter((row) => Date.parse(row.at) <= now && Array.isArray(row.holders))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  const fresh = sample && now - Date.parse(sample.at) <= 180000;
  const keys = new Map();
  for (const file of ['lock-ledger.1.jsonl', 'lock-ledger.jsonl']) {
    for (const row of readEventTail(path.join(dataDir, file), { maxBytes: 5 * 1024 * 1024 })) {
      const at = Date.parse(row.at);
      if (row.name !== 'full-suite' || !PROJECT_SLUG.test(row.project ?? '')
        || !['suite', 'push', 'manual'].includes(row.kind) || !Number.isFinite(at)
        || at > now || now - at > 14 * 86400000) continue;
      const key = { project: row.project, kind: row.kind, name: row.name };
      keys.set(JSON.stringify(key), key);
    }
  }
  const predictions = [...keys.values()].map((key) => {
    const prediction = readLockDurationPrediction({ ...key, dataDir, now });
    return { ...key, ...classifyLockLane(prediction, settings.shortLimitMinutes), samples: prediction.samples };
  }).sort((a, b) => a.project.localeCompare(b.project) || a.kind.localeCompare(b.kind));
  return { slotLimit: settings.slots, slotsInUse: fresh ? sample.holders.length : null,
    sampledAt: sample?.at ?? null, predictions };
}

export function analyticsSummary({ dataDir = DATA_DIR, now = Date.now() } = {}) {
  const events = readEventTail(path.join(dataDir, 'events.jsonl'));
  const samples = readMachineSamples({ dataDir, sinceMs: now - 25 * 3600000 });
  const memory = readMemorySamples({ dataDir, sinceMs: now - 25 * 3600000 });
  const denials = denialDaily(readDenials(dataDir), { now, days: RETAIN_DAYS });
  return {
    notices: noticeCounts(events, { days: 7, now }),
    locks: { ...lockDaily(readEventTail(path.join(dataDir, 'lock-ledger.jsonl')), { days: 7, now }),
      admission: lockAdmissionSummary(samples, { dataDir, now }) },
    timeline: machineTimeline(samples, { hours: 24, bucketMin: 10, now }),
    memoryByClass: memoryByClass(memory, { hours: 24, bucketMin: 60, now }),
    denials,
    harnessChanges: markersIn(denials.days, dataDir),
    policyChanges: readPolicyChanges(dataDir),
  };
}
