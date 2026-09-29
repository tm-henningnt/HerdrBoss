import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const MACHINE_SAMPLES_FILE = 'machine-samples.jsonl';
export const MACHINE_SAMPLES_ROTATED_FILE = 'machine-samples.1.jsonl';
export const MACHINE_SAMPLES_MAX_BYTES = 3 * 1024 * 1024;

const num = (value, digits = null) => {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return null;
  return digits === null ? Number(value) : +Number(value).toFixed(digits);
};
const kinds = (entries) => (entries || []).map((entry) => (typeof entry?.kind === 'string' && entry.kind ? entry.kind : 'unknown'));

// One line for one minute. The line holds numbers, kinds, and counts only: no project name, pane id, path, or command.
export function sampleLine({ machine, holders = [], waiters = [], now = Date.now() } = {}) {
  const load = machine?.load || [];
  const cpus = num(machine?.cpus);
  const cpuTotal = num(machine?.cpuTotalSample);
  return {
    at: new Date(Math.floor(now / 60000) * 60000).toISOString(),
    l1: num(load[0]), l5: num(load[1]), l15: num(load[2]),
    cpus,
    cpu: cpuTotal !== null && cpus ? num(cpuTotal / cpus, 1) : null,
    memFree: num(machine?.memFreePercent),
    memGB: num(machine?.memTotalGB),
    swapMB: num(machine?.swapUsedMB),
    swapTotalMB: num(machine?.swapTotalMB),
    holders: kinds(holders),
    waiters: (waiters || []).length,
    waiterKinds: kinds(waiters),
  };
}

// Append only. A failure is swallowed, so a write never stops or slows a tick.
export function appendMachineSample(line, { dataDir = DATA_DIR, maxBytes = MACHINE_SAMPLES_MAX_BYTES } = {}) {
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(dataDir, MACHINE_SAMPLES_FILE);
    try {
      if (fs.statSync(file).size > maxBytes) fs.renameSync(file, path.join(dataDir, MACHINE_SAMPLES_ROTATED_FILE));
    } catch {}
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    return true;
  } catch { return false; }
}

// Reads the rotated file and the current file, oldest first. A line that does not parse is skipped.
export function readMachineSamples({ dataDir = DATA_DIR, sinceMs = null } = {}) {
  const lines = [];
  for (const name of [MACHINE_SAMPLES_ROTATED_FILE, MACHINE_SAMPLES_FILE]) {
    let text;
    try { text = fs.readFileSync(path.join(dataDir, name), 'utf8'); } catch { continue; }
    for (const raw of text.split('\n')) {
      if (!raw) continue;
      let line;
      try { line = JSON.parse(raw); } catch { continue; }
      const at = Date.parse(line?.at);
      if (!Number.isFinite(at) || (sinceMs !== null && at < sinceMs)) continue;
      lines.push(line);
    }
  }
  return lines;
}
