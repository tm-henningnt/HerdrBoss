// Linux quota readers for a factory container. CodexBar does not exist on Linux, so each reader asks the harness itself.
// A reader prints readings only. It reads no login file and passes no credential in argv or in the child environment.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { claudeRateLimitsDir } from './claude-statusline.js';
import { readOpenCodeGoQuota } from './opencode-estimate.js';

const KILL_GRACE_MS = 3000;
const MISSING_LOGIN_REASON = 'no login for this harness in this factory';
const LOGIN_TEXT = /not logged in|not authenticated|no (?:credentials|login)\b|login (?:required|expired|is missing)|sign in\b|log in\b/i;

// Map one window to the reading window shape. `resetsAtSeconds` is Unix seconds. A percent outside 0 to 100 becomes null.
export function buildWindow({ key, label, usedPercent, resetsAtSeconds, windowMinutes, extra = false }) {
  const percent = typeof usedPercent === 'number' && Number.isFinite(usedPercent) && usedPercent >= 0 && usedPercent <= 100 ? usedPercent : null;
  const resetDate = typeof resetsAtSeconds === 'number' && Number.isFinite(resetsAtSeconds) ? new Date(resetsAtSeconds * 1000) : null;
  return {
    key,
    label: label || key,
    usedPercent: percent,
    resetsAt: resetDate && Number.isFinite(resetDate.getTime()) ? resetDate.toISOString() : null,
    windowMinutes: Number.isFinite(windowMinutes) ? windowMinutes : null,
    ...(extra ? { extra: true } : {}),
  };
}

// An unavailable row is an unknown reading: no reader, no login, or no limit to read. It is not a probe failure.
const unavailable = (provider, reason) => ({ provider, unavailable: true, reason, error: reason });
// A failed row is a probe failure: a rate limit, a backend error, a timeout, or a changed protocol. keepStaleRows keeps the last good reading as stale.
const failed = (provider, error) => ({ provider, error });

// Start a child with JSON-RPC lines on stdio. The child gets the environment of this process and no extra value.
export function spawnJsonRpc({ command, args = [] }) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] });
  let buffer = '';
  const handlers = { line: () => {}, close: () => {}, error: () => {} };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) handlers.line(line);
    }
  });
  child.stdin.on('error', () => {});
  child.on('error', (error) => handlers.error(error));
  child.on('close', (code, signal) => handlers.close(code, signal));
  return {
    onLine: (fn) => { handlers.line = fn; },
    onClose: (fn) => { handlers.close = fn; },
    onError: (fn) => { handlers.error = fn; },
    send: (message) => { child.stdin.write(`${JSON.stringify(message)}\n`); },
    closeInput: () => { try { child.stdin.end(); } catch {} },
    kill: (signal) => { try { child.kill(signal); } catch {} },
  };
}

function oneLine(value) {
  return String(value || '').split(/\r?\n/)[0].trim().slice(0, 120);
}

function codexRow(result, observedAt) {
  const snapshot = result?.rateLimits;
  if (!snapshot || typeof snapshot !== 'object') return failed('codex', 'Codex usage read returned no rate limits');
  const windows = [];
  for (const key of ['primary', 'secondary']) {
    const w = snapshot[key];
    if (!w || typeof w !== 'object') continue;
    windows.push(buildWindow({ key, usedPercent: w.usedPercent, resetsAtSeconds: w.resetsAt, windowMinutes: w.windowDurationMins }));
  }
  const defaultId = snapshot.limitId ?? 'codex';
  for (const [id, other] of Object.entries(result.rateLimitsByLimitId || {})) {
    if (id === defaultId || !other || typeof other !== 'object') continue;
    for (const key of ['primary', 'secondary']) {
      const w = other[key];
      if (!w || typeof w !== 'object') continue;
      windows.push(buildWindow({ key: key === 'primary' ? id : `${id}-${key}`, label: other.limitName || id, usedPercent: w.usedPercent, resetsAtSeconds: w.resetsAt, windowMinutes: w.windowDurationMins, extra: true }));
    }
  }
  if (!windows.length) return unavailable('codex', 'Codex reports no usage limit for this login (an API key login has none)');
  const credits = snapshot.credits && typeof snapshot.credits === 'object' ? snapshot.credits : null;
  return {
    provider: 'codex',
    plan: typeof snapshot.planType === 'string' ? snapshot.planType : null,
    windows,
    credits: credits && credits.balance != null ? { remaining: credits.balance } : null,
    resetCredits: null,
    updatedAt: null,
    observedAt,
  };
}

// Ask `codex app-server` for the account rate limits. Every failure gives an unavailable row with a plain reason.
export function readCodexQuota({ spawnJsonRpc: spawnRpc = spawnJsonRpc, timeoutMs = 20_000, now = () => Date.now(), killGraceMs = KILL_GRACE_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false, child = null, timer = null, graceTimer = null;
    const finish = (row) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child) {
        child.closeInput();
        child.kill('SIGTERM');
        graceTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
        graceTimer.unref?.();
      }
      resolve(row);
    };
    const pending = new Map();
    const request = (id, method, params) => child.send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    try {
      child = spawnRpc({ command: 'codex', args: ['app-server', '--listen', 'stdio://'] });
    } catch (error) {
      finish(error?.code === 'ENOENT' ? unavailable('codex', 'codex is not installed in this factory') : failed('codex', `Codex usage read failed: ${oneLine(error?.message)}`));
      return;
    }
    timer = setTimeout(() => finish(failed('codex', `Codex usage read timed out after ${Math.max(1, Math.round(timeoutMs / 1000))} s`)), Math.max(1, timeoutMs));
    child.onError((error) => finish(error?.code === 'ENOENT' ? unavailable('codex', 'codex is not installed in this factory') : failed('codex', `Codex usage read failed: ${oneLine(error?.message)}`)));
    child.onClose(() => finish(failed('codex', 'Codex usage read ended: the app server exited before it answered')));
    child.onLine((line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (!message || typeof message !== 'object' || message.id === undefined || !pending.has(message.id)) return;
      const method = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        const text = oneLine(message.error.message);
        if (LOGIN_TEXT.test(text)) finish(unavailable('codex', MISSING_LOGIN_REASON));
        else finish(failed('codex', /method not found/i.test(text) ? 'codex app-server protocol changed' : `Codex usage read failed: ${text || 'JSON-RPC error'}`));
        return;
      }
      if (method === 'initialize') {
        child.send({ jsonrpc: '2.0', method: 'initialized' });
        pending.set(2, 'account/rateLimits/read');
        request(2, 'account/rateLimits/read');
      } else finish(codexRow(message.result, new Date(now()).toISOString()));
    });
    pending.set(1, 'initialize');
    request(1, 'initialize', { clientInfo: { name: 'herdr-boss', title: null, version: '1' } });
  });
}

const CLAUDE_STALE_HOURS = 3;
const CLAUDE_WINDOWS = [['primary', 'five_hour', 300], ['secondary', 'seven_day', 10080]];

function newestClaudeReport(dir) {
  let names;
  try { names = fs.readdirSync(dir).filter((name) => name.endsWith('.json')); } catch { return null; }
  let best = null;
  for (const name of names) {
    let report;
    try { report = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
    const observed = Date.parse(report?.observedAt);
    if (!Number.isFinite(observed) || !report.rate_limits || typeof report.rate_limits !== 'object') continue;
    if (!best || observed > best.observed) best = { observed, report };
  }
  return best;
}

// Read the files that `herdr-boss claude-statusline` wrote. The reader runs no Claude command and reads no login file.
export async function readClaudeQuota({ dir = claudeRateLimitsDir(DATA_DIR), now = () => Date.now() } = {}) {
  const current = typeof now === 'function' ? now() : now;
  const best = newestClaudeReport(dir);
  if (!best) return unavailable('claude', 'no Claude session has reported usage yet');
  const windows = [];
  for (const [key, source, windowMinutes] of CLAUDE_WINDOWS) {
    const w = best.report.rate_limits[source];
    if (!w || typeof w !== 'object' || !(w.resets_at * 1000 > current)) continue;
    windows.push(buildWindow({ key, usedPercent: w.used_percentage, resetsAtSeconds: w.resets_at, windowMinutes }));
  }
  if (!windows.length) {
    const old = current - best.observed >= CLAUDE_STALE_HOURS * 3600_000;
    return unavailable('claude', `the last Claude usage report is ${old ? `older than ${CLAUDE_STALE_HOURS} hours and ` : ''}past its reset`);
  }
  return { provider: 'claude', plan: null, windows, credits: null, resetCredits: null, updatedAt: new Date(best.observed).toISOString(), observedAt: new Date(current).toISOString() };
}

// The Linux readers by provider. A provider without an entry keeps the unknown reading.
export const LINUX_READERS = Object.freeze({ codex: readCodexQuota, claude: readClaudeQuota, opencodego: readOpenCodeGoQuota });

// Run the Linux reader of a provider. Returns null when the provider has no reader.
export async function readQuota(provider, { readers = LINUX_READERS, ...options } = {}) {
  const reader = readers[provider];
  return reader ? reader(options) : null;
}
