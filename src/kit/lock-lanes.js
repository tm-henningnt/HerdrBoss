import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const LOCK_LEDGER_FILES = ['lock-ledger.1.jsonl', 'lock-ledger.jsonl'];

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

function readLedgerLines(dataDir, cutoff) {
  const lines = [];
  for (const fileName of LOCK_LEDGER_FILES) {
    let text;
    try { text = fs.readFileSync(path.join(dataDir, fileName), 'utf8'); }
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

export function classifyLockLane(prediction, shortLimitMinutes) {
  const predictedMs = Number.isFinite(prediction?.ms) ? prediction.ms : null;
  return {
    lane: predictedMs !== null && predictedMs <= shortLimitMinutes * 60_000 ? 'short' : 'long',
    predictedMs,
  };
}

const laneFor = (item, slots) => (slots < 2 || item?.lane !== 'short' ? 'long' : 'short');

// Choose one record slot without changing the order of either lane's queue.
export function chooseLockSlot({ lane, slots, holders = [], tickets = [], ticketId = null } = {}) {
  const capacity = Number.isInteger(slots) && slots >= 1 ? slots : 1;
  const effectiveLane = capacity < 2 ? 'long' : lane === 'short' ? 'short' : 'long';
  const laneTickets = tickets.filter((ticket) => laneFor(ticket, capacity) === effectiveLane);
  if (ticketId === null ? laneTickets.length > 0 : laneTickets[0]?.id !== ticketId) return null;

  const occupied = holders.map((holder) => holder?.slot ?? 'long');
  const longUsed = occupied.includes('long');
  if (capacity < 2) return longUsed ? null : { slot: 'long' };
  if (effectiveLane === 'long') return longUsed ? null : { slot: 'long' };

  const shortUsed = new Set(occupied.filter((slot) => Number.isInteger(slot) && slot > 0));
  for (let slot = 1; slot < capacity; slot++) if (!shortUsed.has(slot)) return { slot };
  const longWaiters = tickets.filter((ticket) => laneFor(ticket, capacity) === 'long');
  if (!longUsed && longWaiters.length === 0) return { slot: 'long' };
  return null;
}
