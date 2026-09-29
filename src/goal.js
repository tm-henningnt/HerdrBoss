// The Owner's /goal of an orchestrator: capture it for a handover and check that a pane shows it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transcriptFile } from './context-handover.js';

export const GOAL_MAX_LENGTH = 4000;
const TAIL_BYTES = 1024 * 1024;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
// C0 and C1 control characters, including tab and newline.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

// One line of text without control characters, at most GOAL_MAX_LENGTH characters. Null when nothing is left.
// The text "clear" is the /goal command that removes a goal.
export function cleanGoal(text) {
  if (typeof text !== 'string') return null;
  const clean = text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, GOAL_MAX_LENGTH).trim();
  return clean && clean.toLowerCase() !== 'clear' ? clean : null;
}

// The policy field accepts a string of at most GOAL_MAX_LENGTH characters without control characters. An empty string is allowed.
export function goalTextError(value) {
  if (typeof value !== 'string') return 'must be a string.';
  if (value.length > GOAL_MAX_LENGTH) return `must be at most ${GOAL_MAX_LENGTH} characters.`;
  if (CONTROL.test(value)) { CONTROL.lastIndex = 0; return 'must not contain control characters or line breaks.'; }
  return null;
}

function readTail(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    // A tail that starts inside a line has a partial first line.
    if (length < size) lines.shift();
    return lines;
  } finally { fs.closeSync(fd); }
}

function codexTranscriptFile(sessionId, home) {
  const root = path.join(home, '.codex', 'sessions');
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) { const found = walk(file, depth + 1); if (found) return found; }
      else if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(sessionId)) return file;
    }
    return null;
  };
  return walk(root, 0);
}

function userTexts(row) {
  if (!row || typeof row !== 'object') return [];
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : null;
  const user = row.type === 'user' || payload?.type === 'user_message' || payload?.role === 'user';
  if (!user) return [];
  const out = [];
  const add = (value) => {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) for (const part of value) if (typeof part?.text === 'string') out.push(part.text);
  };
  add(row.message?.content);
  if (payload) { add(payload.message); add(payload.content); add(payload.text); }
  return out;
}

// A Claude command entry is a user message that starts with the command tags. Pasted text inside a message body does not match.
const CLAUDE_COMMAND = /^\s*(?:<command-message>[^<]*<\/command-message>\s*)?<command-name>\s*\/goal\s*<\/command-name>\s*(?:<command-message>[^<]*<\/command-message>\s*)?(?:<command-args>([\s\S]*?)<\/command-args>)?\s*$/;
const PLAIN_COMMAND = /^\s*\/goal(?:\s+([\s\S]*))?$/;

// The last /goal command in the tail of the session transcript. Returns { goal } or null when there is none.
// A bare /goal shows the goal and changes nothing, so the scan goes on. /goal clear ends the scan with no goal.
function lastGoalCommand(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].trim()) continue;
    let row;
    try { row = JSON.parse(lines[i]); } catch { continue; }
    const texts = userTexts(row);
    for (let j = texts.length - 1; j >= 0; j -= 1) {
      const match = CLAUDE_COMMAND.exec(texts[j]) || PLAIN_COMMAND.exec(texts[j]);
      if (!match) continue;
      const args = (match[1] ?? '').trim();
      if (!args) continue;
      return { goal: cleanGoal(args) };
    }
  }
  return null;
}

export function goalFromTranscript({ kind, sessionId, cwd = null, home = os.homedir() } = {}) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return null;
  try {
    const file = kind === 'codex' ? codexTranscriptFile(sessionId, home) : kind === 'claude' ? transcriptFile(sessionId, cwd, home) : null;
    if (!file) return null;
    return lastGoalCommand(readTail(file))?.goal ?? null;
  } catch { return null; }
}

// The pane text wraps long lines, so compare without whitespace. The first 60 characters identify the goal.
export function goalShown(paneText, goal) {
  const squash = (value) => String(value ?? '').replace(/\s+/g, '');
  const needle = squash(goal).slice(0, 60);
  return needle.length > 0 && squash(paneText).includes(needle);
}
