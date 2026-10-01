import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const MEMORY_CLASSES = ['claude', 'codex', 'browsers', 'mcp', 'vitest', 'other'];
export const MEMORY_SAMPLES_FILE = 'memory-samples.jsonl';
export const MEMORY_SAMPLES_ROTATED_FILE = 'memory-samples.1.jsonl';
export const MEMORY_SAMPLES_MAX_BYTES = 3 * 1024 * 1024;
export const MEMORY_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
export const MEMORY_PS_TIMEOUT_MS = 10000;

// A tool name wins over a directory name in the same path, so the most specific pattern is first.
const PATTERNS = [
  ['vitest', /vitest/i],
  ['mcp', /chrome-devtools-mcp|node_repl|cua_repl|@modelcontextprotocol|mcp[-_/]|playwright-mcp|node[_-]repl/i],
  ['browsers', /Google Chrome|Chromium|Chrome for Testing|chrome-headless-shell|chrome_crashpad/i],
  ['claude', /claude/i],
  ['codex', /codex/i],
];

// The command stays in memory. The class and its resident memory are all the sample keeps.
export function classifyCommand(command) {
  const text = typeof command === 'string' ? command : '';
  for (const [name, pattern] of PATTERNS) if (pattern.test(text)) return name;
  return 'other';
}

// One line for one 5-minute window. Each line of ps output holds the resident size in KB and the command.
export function sampleMemory(psText, now = Date.now()) {
  const mb = {};
  for (const name of MEMORY_CLASSES) mb[name] = 0;
  for (const raw of String(psText ?? '').split('\n')) {
    const match = raw.match(/^\s*(\d+)\s*(.*)$/);
    if (!match) continue;
    const name = classifyCommand(match[2]);
    mb[name] += +(Number(match[1]) / 1024).toFixed(1);
  }
  for (const name of MEMORY_CLASSES) mb[name] = +mb[name].toFixed(1);
  return { at: new Date(Math.floor(now / MEMORY_SAMPLE_INTERVAL_MS) * MEMORY_SAMPLE_INTERVAL_MS).toISOString(), mb };
}

// Append only. A failure is swallowed, so a write never stops or slows a tick.
export function appendMemorySample(line, { dataDir = DATA_DIR, maxBytes = MEMORY_SAMPLES_MAX_BYTES } = {}) {
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(dataDir, MEMORY_SAMPLES_FILE);
    try {
      if (fs.statSync(file).size > maxBytes) fs.renameSync(file, path.join(dataDir, MEMORY_SAMPLES_ROTATED_FILE));
    } catch {}
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    return true;
  } catch { return false; }
}

// Reads the rotated file and the current file, oldest first. A line that does not parse, or that holds no known class, is skipped.
export function readMemorySamples({ dataDir = DATA_DIR, sinceMs = null } = {}) {
  const lines = [];
  for (const name of [MEMORY_SAMPLES_ROTATED_FILE, MEMORY_SAMPLES_FILE]) {
    let text;
    try { text = fs.readFileSync(path.join(dataDir, name), 'utf8'); } catch { continue; }
    for (const raw of text.split('\n')) {
      if (!raw) continue;
      let line;
      try { line = JSON.parse(raw); } catch { continue; }
      const at = Date.parse(line?.at);
      if (!Number.isFinite(at) || (sinceMs !== null && at < sinceMs)) continue;
      const mb = {};
      for (const key of MEMORY_CLASSES) {
        if (Number.isFinite(line?.mb?.[key])) mb[key] = line.mb[key];
      }
      if (!Object.keys(mb).length) continue;
      lines.push({ at: line.at, mb });
    }
  }
  return lines;
}