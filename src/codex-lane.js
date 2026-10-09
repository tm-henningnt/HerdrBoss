import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const CODEX_HOOK_BLOCK_REASON = 'blocked: Codex hook needs Owner review';
export const CODEX_HOOK_REVIEW_INSTRUCTION = 'Run codex once in a terminal and review the changed hook.';
export const CODEX_LANE_BLOCK_TTL_MS = 6 * 60 * 60 * 1000;
const FILE_NAME = 'codex-lane.json';
const MAX_FILE_BYTES = 4096;

export function hasCodexHookReviewDialog(text) {
  return String(text ?? '').split(/\r?\n/).some((line) => /\bhook needs review\b|\bhooks need review\b/i.test(line));
}

export function writeCodexLaneBlock({ dir, now = Date.now() }) {
  const file = path.join(dir, FILE_NAME);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = path.join(dir, `${FILE_NAME}.${randomUUID()}.tmp`);
  const value = {
    schema: 1,
    kind: 'codex',
    reason: CODEX_HOOK_BLOCK_REASON,
    blockedAt: new Date(now).toISOString(),
  };
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return value;
}

export function readCodexLaneBlock({ dir, now = Date.now() }) {
  try {
    const file = path.join(dir, FILE_NAME);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const blockedAt = Date.parse(value?.blockedAt ?? '');
    if (value?.schema !== 1 || value?.kind !== 'codex' || value?.reason !== CODEX_HOOK_BLOCK_REASON || !Number.isFinite(blockedAt)) return null;
    if (now - blockedAt >= CODEX_LANE_BLOCK_TTL_MS) return null;
    return { kind: 'codex', reason: CODEX_HOOK_BLOCK_REASON, blockedAt };
  } catch { return null; }
}

export function clearCodexLaneBlock({ dir }) {
  fs.rmSync(path.join(dir, FILE_NAME), { force: true });
}

export function waitForCodexHookReview({ readSnapshot, isPromptReady = () => false, matchesDialog = hasCodexHookReviewDialog, clock = Date.now, wait, timeoutMs = 20_000, intervalMs = 250, emptyLimit = 8 }) {
  const startedAt = clock();
  let elapsedMs = 0;
  let emptyReads = 0;
  for (;;) {
    const snapshot = readSnapshot();
    if (matchesDialog(snapshot)) return true;
    // A pane that shows no text at all cannot show the dialog. A real Codex pane draws within a second or two.
    emptyReads = String(snapshot ?? '').trim() ? 0 : emptyReads + 1;
    if (emptyReads >= emptyLimit) return false;
    if (isPromptReady(snapshot)) return false;
    const elapsed = Math.max(elapsedMs, clock() - startedAt);
    if (elapsed >= timeoutMs) return false;
    const delay = Math.min(intervalMs, timeoutMs - elapsed);
    const waitStarted = clock();
    wait(delay);
    elapsedMs = Math.max(elapsedMs + delay, clock() - startedAt, elapsedMs + Math.max(0, clock() - waitStarted));
  }
}
