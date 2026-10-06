// OpenCode Go has no usage source that a factory can read. OpenCode lists the local usage of its sessions with
// `opencode stats --models --days N`. This module keeps only the numbers and the model names of the OpenCode Go rows
// and shows them as an estimate of the use in this factory. It is never a percent and never a quota.
// It runs no login command, scrapes no web console, and stores no cookie.
import { execFile } from 'node:child_process';
import { ISO_TIME } from './config.js';
import { readerChildEnv } from './child-env.js';

export const ESTIMATE_LABEL = 'used in this factory (local estimate)';
export const DEFAULT_STATS_DAYS = 7;
const MAX_OUTPUT_BYTES = 256 * 1024;
const UNIT = { k: 1e3, m: 1e6, b: 1e9 };
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const ROW = /^(\S+)\s+(\d[\d.,]*)([kmb]?)\s+\d[\d.,]*[kmb]?\s+\$(\d[\d.,]*)\s*$/i;
const OMITTED = /^\+\s*(\d+)\s+more models?\b/i;

const number = (text) => Number(text.replace(/,/g, ''));
const round = (value, places) => Math.round(value * 10 ** places) / 10 ** places;

// Read the model table of `opencode stats --models`. Returns null when the output has no table.
export function parseOpenCodeStats(output, days) {
  const lines = String(output || '').replace(ANSI, '').split(/\r?\n/).map((line) => line.trim());
  if (lines.some((line) => /^no sessions found\b/i.test(line))) return { days, tokens: 0, costUsd: 0, omittedModels: 0, models: [] };
  const start = lines.findIndex((line) => /^model\s+tokens\s+steps\s+cost$/i.test(line));
  if (start < 0) return null;
  const models = [];
  let omittedModels = 0;
  for (const line of lines.slice(start + 1)) {
    const omitted = OMITTED.exec(line);
    if (omitted) { omittedModels = Number(omitted[1]); continue; }
    const match = ROW.exec(line);
    if (!match) continue;
    // The table cuts a long name with an ellipsis and appends the variant after a hash. Keep the part before both.
    const model = match[1].split('#')[0].replace(/…$/, '');
    if (!model.startsWith('opencode-go/')) continue;
    const tokens = Math.round(number(match[2]) * (UNIT[match[3].toLowerCase()] || 1));
    const costUsd = number(match[4]);
    if (!Number.isFinite(tokens) || !Number.isFinite(costUsd)) continue;
    models.push({ model, tokens, costUsd });
  }
  return {
    days,
    tokens: models.reduce((sum, row) => sum + row.tokens, 0),
    costUsd: round(models.reduce((sum, row) => sum + row.costUsd, 0), 4),
    omittedModels,
    models,
  };
}

function runCommand(command, args, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, env: readerChildEnv({ NO_COLOR: '1' }) },
      (error, stdout) => error ? reject(error) : resolve(String(stdout)));
  });
}

// Run `opencode stats --models --days N`. Returns null when opencode is missing, fails, or prints no table.
export async function readOpenCodeEstimate({ days = DEFAULT_STATS_DAYS, run = runCommand, timeoutMs } = {}) {
  try { return parseOpenCodeStats(await run('opencode', ['stats', '--models', '--days', String(days)], { timeoutMs }), days); }
  catch { return null; }
}

const isoTime = (value) => {
  if (typeof value !== 'string' || !ISO_TIME.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

// The Linux reader of OpenCode Go. The reading stays unknown. The row carries the manual reset time and the local estimate.
export async function readOpenCodeGoQuota({ opencode = {}, run, timeoutMs } = {}) {
  const days = Number.isSafeInteger(opencode.days) && opencode.days >= 1 ? opencode.days : DEFAULT_STATS_DAYS;
  const reason = 'no usage reader in this factory';
  const estimate = await readOpenCodeEstimate({ days, run, timeoutMs });
  return { provider: 'opencodego', unavailable: true, reason, error: reason, resetAt: isoTime(opencode.resetAt), estimate };
}
