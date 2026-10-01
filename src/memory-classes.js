import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const MEMORY_CLASSES = ['claude', 'codex', 'browsers', 'mcp', 'vitest', 'other'];
export const MEMORY_SAMPLES_FILE = 'memory-samples.jsonl';
export const MEMORY_SAMPLES_ROTATED_FILE = 'memory-samples.1.jsonl';
export const MEMORY_SAMPLES_MAX_BYTES = 3 * 1024 * 1024;
export const MEMORY_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
export const MEMORY_PS_TIMEOUT_MS = 10000;

// A class matches the program that runs. An argument and a folder name never make a match on their own.
const BROWSERS = /Google Chrome|Chromium|Chrome for Testing|chrome-headless-shell|chrome_crashpad/i;
const CLAUDE_NAMES = new Set(['claude', 'claude-code']);
const CODEX_NAMES = new Set(['codex']);
// The name of a model context protocol server. A file or an option with the word mcp is no server name.
const MCP_NAME = /^(chrome-devtools-mcp|computer-use-mcp|node_repl|cua_repl|mcp|mcp-server-[a-z0-9._-]+|[a-z0-9._-]+-mcp)$/i;
const VITEST_NAMES = new Set(['vitest', 'vitest.mjs', 'vitest.js']);
const NODE_PROGRAMS = new Set(['node', 'nodejs', 'deno', 'bun', 'npx', 'npm', 'pnpm', 'yarn']);

const lastSegment = (token) => {
  const parts = String(token ?? '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
};

// The program of the command: the executable, and the script when an interpreter runs it.
function programs(command) {
  const tokens = String(command ?? '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { list: [], onNode: false, onVitest: false };
  const executable = lastSegment(tokens[0]);
  const onNode = NODE_PROGRAMS.has(executable.toLowerCase());
  const list = [executable];
  if (onNode) {
    const script = tokens.slice(1).find((token) => !token.startsWith('-'));
    if (script) list.push(lastSegment(script));
  }
  const names = new Set(list.map((name) => name.toLowerCase()));
  return { list, onNode, onVitest: [...names].some((name) => name.startsWith('vitest')) };
}

// The segment names of the command. A match needs the whole segment, so a folder called claude-x is no match.
function segments(command) {
  const names = new Set();
  for (const token of String(command ?? '').split(/\s+/)) {
    if (!token || token.startsWith('-')) continue;
    for (const part of token.split('/')) {
      const name = part.toLowerCase();
      if (!name || name === '.' || name === '..') continue;
      names.add(name);
      // A package can carry a version tag, so chrome-devtools-mcp@2.1.0 adds chrome-devtools-mcp too.
      if (!name.startsWith('@')) names.add(name.replace(/@[^@]*$/, ''));
    }
  }
  return names;
}

// The command stays in memory. The class and its resident memory are all the sample keeps.
export function classifyCommand(command) {
  const text = typeof command === 'string' ? command : '';
  if (!text.trim()) return 'other';
  const { onNode, onVitest } = programs(text);
  const names = segments(text);
  if (BROWSERS.test(text)) return 'browsers';
  if ([...names].some((name) => MCP_NAME.test(name))) return 'mcp';
  if ([...names].some((name) => CLAUDE_NAMES.has(name))) return 'claude';
  if ([...names].some((name) => CODEX_NAMES.has(name))) return 'codex';
  // Vitest runs on node, so it counts only when node runs a vitest program or the program is vitest.
  if ((onNode || onVitest) && [...names].some((name) => VITEST_NAMES.has(name))) return 'vitest';
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