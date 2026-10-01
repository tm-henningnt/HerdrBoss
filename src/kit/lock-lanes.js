import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const LOCK_LEDGER_FILES = ['lock-ledger.1.jsonl', 'lock-ledger.jsonl'];
const WAIT_LEDGER_MAX_BYTES = 512 * 1024;

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

// Predict a lock duration from completed, non-reentrant release lines for one key.
export function predictLockDuration(lines, { project, kind, name, now = Date.now() } = {}) {
  const current = typeof now === 'function' ? now() : now;
  const nowMs = current instanceof Date ? current.getTime() : Number(current);
  const cutoff = nowMs - 14 * DAY_MS;
  const samples = (lines || []).filter((line) => {
    const at = Date.parse(line?.at);
    return line?.event === 'release'
      && line.project === project && line.kind === kind && line.name === name
      && Number.isFinite(line.holdMs) && line.holdMs >= 0
      && !line.takeover && !line.reentrant && !line.reused
      && Number.isFinite(at) && at >= cutoff && at <= nowMs;
  }).sort((left, right) => Date.parse(left.at) - Date.parse(right.at)).slice(-10);
  return { ms: samples.length < 3 ? null : median(samples.map((line) => line.holdMs)), samples: samples.length };
}

function readLedgerTail(file, maxBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return '';
    const start = Math.max(0, stat.size - maxBytes);
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = fs.readSync(fd, buffer, bytesRead, buffer.length - bytesRead, start + bytesRead);
      if (!count) break;
      bytesRead += count;
    }
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    // The byte boundary can split a JSON line or UTF-8 character. Use only complete lines after it.
    if (start === 0) return text;
    const newline = text.indexOf('\n');
    return newline < 0 ? '' : text.slice(newline + 1);
  } finally { fs.closeSync(fd); }
}

function readLedgerLines(dataDir, cutoff, maxBytes = null) {
  const lines = [];
  for (const fileName of LOCK_LEDGER_FILES) {
    let text;
    try {
      const file = path.join(dataDir, fileName);
      text = maxBytes === null ? fs.readFileSync(file, 'utf8') : readLedgerTail(file, maxBytes);
    }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'EISDIR') continue; throw error; }
    for (const raw of text.split('\n')) {
      if (!raw) continue;
      let line;
      try { line = JSON.parse(raw); } catch { continue; }
      if (line?.event !== 'release' || Date.parse(line.at) < cutoff) continue;
      lines.push(line);
    }
  }
  return lines;
}

// File access stays separate from the predictor so tests can supply ledger lines directly.
export function readLockDurationPrediction({
  dataDir = DATA_DIR, project, kind, name, now = Date.now(),
} = {}) {
  const current = typeof now === 'function' ? now() : now;
  const nowMs = current instanceof Date ? current.getTime() : Number(current);
  const lines = readLedgerLines(dataDir, nowMs - 14 * DAY_MS);
  return predictLockDuration(lines, { project, kind, name, now: nowMs });
}

// Wait estimates use the last ten completed holds of the lock and lane, across projects and kinds.
// Keep this separate from admission: a wait estimate must not change a ticket's lane.
export function readLockLaneDurationPredictions({ dataDir = DATA_DIR, name, now = Date.now() } = {}) {
  const current = typeof now === 'function' ? now() : now;
  const nowMs = current instanceof Date ? current.getTime() : Number(current);
  const lines = readLedgerLines(dataDir, -Infinity, WAIT_LEDGER_MAX_BYTES);
  return Object.fromEntries(['long', 'short'].map((lane) => {
    const samples = lines.filter((line) => line.name === name && (line.lane ?? 'long') === lane
      && Number.isFinite(line.holdMs) && line.holdMs >= 0
      && !line.takeover && !line.reentrant && !line.reused
      && Number.isFinite(Date.parse(line.at)) && Date.parse(line.at) <= nowMs)
      .sort((left, right) => Date.parse(left.at) - Date.parse(right.at)).slice(-10);
    return [lane, { ms: median(samples.map((line) => line.holdMs)), samples: samples.length }];
  }));
}

export function classifyLockLane(prediction, shortLimitMinutes) {
  const predictedMs = Number.isFinite(prediction?.ms) ? prediction.ms : null;
  return {
    lane: predictedMs !== null && predictedMs <= shortLimitMinutes * 60_000 ? 'short' : 'long',
    predictedMs,
  };
}

export const isLegacyLockEntry = (item) => item?.legacy === true || item?.lane === undefined;

export function lockAdmissionCapacity(slots, holders = [], tickets = []) {
  if (holders.some(isLegacyLockEntry) || tickets.some(isLegacyLockEntry)) return 1;
  return Number.isInteger(slots) && slots >= 1 ? slots : 1;
}

const laneFor = (item, slots) => (slots < 2 || item?.lane !== 'short' ? 'long' : 'short');

// Choose one record slot without changing the order of either lane's queue.
export function chooseLockSlot({ lane, slots, holders = [], tickets = [], ticketId = null } = {}) {
  const capacity = lockAdmissionCapacity(slots, holders, tickets);
  // Retiring slots still consume capacity until their holders finish.
  if (holders.length >= capacity) return null;
  const effectiveLane = capacity < 2 ? 'long' : lane === 'short' ? 'short' : 'long';
  const laneTickets = tickets.filter((ticket) => laneFor(ticket, capacity) === effectiveLane);
  if (ticketId === null ? laneTickets.length > 0 : laneTickets[0]?.id !== ticketId) return null;

  const occupied = holders.map((holder) => holder?.slot ?? 'long');
  const longUsed = occupied.includes('long');
  if (capacity < 2) return longUsed ? null : { slot: 'long' };
  if (effectiveLane === 'long') return longUsed ? null : { slot: 'long' };

  const shortUsed = new Set(occupied.filter((slot) => Number.isInteger(slot) && slot > 0));
  if (shortUsed.size < capacity - 1) {
    for (let slot = 1; slot < capacity; slot++) if (!shortUsed.has(slot)) return { slot };
  }
  const longWaiters = tickets.filter((ticket) => laneFor(ticket, capacity) === 'long');
  if (!longUsed && longWaiters.length === 0) return { slot: 'long' };
  return null;
}

const finiteNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const percentText = (value) => `${Number(value.toFixed(1))}%`;

// Return a pause reason only when a fresh machine sample crosses a configured limit.
export function machineGuardReason(sample, guard = {}, { now = Date.now(), maxAgeMs = 3 * 60_000 } = {}) {
  if (!sample || guard.enabled === false) return null;
  const current = typeof now === 'function' ? now() : now;
  const nowMs = current instanceof Date ? current.getTime() : Number(current);
  const at = Date.parse(sample.at);
  if (!Number.isFinite(nowMs) || !Number.isFinite(at) || at > nowMs || nowMs - at > maxAgeMs) return null;

  const load = finiteNumber(sample.l5);
  const cpus = finiteNumber(sample.cpus);
  const maxLoadPercent = finiteNumber(guard.maxLoadPercent);
  if (load !== null && cpus !== null && cpus > 0 && maxLoadPercent !== null) {
    const loadPercent = load / cpus * 100;
    if (loadPercent > maxLoadPercent) return `load ${percentText(loadPercent)} exceeds ${percentText(maxLoadPercent)}`;
  }

  const swap = finiteNumber(sample.swapMB);
  const swapTotal = finiteNumber(sample.swapTotalMB);
  const maxSwapPercent = finiteNumber(guard.maxSwapPercent);
  if (swap !== null && swapTotal !== null && swapTotal > 0 && maxSwapPercent !== null) {
    const swapPercent = swap / swapTotal * 100;
    if (swapPercent > maxSwapPercent) return `swap ${percentText(swapPercent)} exceeds ${percentText(maxSwapPercent)}`;
  }

  const freeMem = finiteNumber(sample.memFree);
  const minFreeMemPercent = finiteNumber(guard.minFreeMemPercent);
  if (freeMem !== null && minFreeMemPercent !== null && freeMem < minFreeMemPercent) {
    return `memory free ${percentText(freeMem)} below ${percentText(minFreeMemPercent)}`;
  }
  return null;
}
