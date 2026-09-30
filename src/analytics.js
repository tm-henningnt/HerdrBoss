import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { readMachineSamples } from './machine-samples.js';
import { readDenials, denialDaily, RETAIN_DAYS } from './denials.js';
import { readHarnessChanges } from './harness-changes.js';
import { readPolicyChanges } from './policy-log.js';

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

// The harness change markers that fall on a day of the denial window.
function markersIn(days, dataDir) {
  const first = days[0], last = days.at(-1);
  return readHarnessChanges(dataDir).filter((m) => m.date >= first && m.date <= last);
}

export function analyticsSummary({ dataDir = DATA_DIR, now = Date.now() } = {}) {
  const events = readEventTail(path.join(dataDir, 'events.jsonl'));
  const samples = readMachineSamples({ dataDir, sinceMs: now - 25 * 3600000 });
  const denials = denialDaily(readDenials(dataDir), { now, days: RETAIN_DAYS });
  return {
    notices: noticeCounts(events, { days: 7, now }),
    timeline: machineTimeline(samples, { hours: 24, bucketMin: 10, now }),
    denials,
    harnessChanges: markersIn(denials.days, dataDir),
    policyChanges: readPolicyChanges(dataDir),
  };
}
