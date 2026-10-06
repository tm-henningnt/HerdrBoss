// The Claude status line helper of a factory. Claude Code runs `herdr-boss claude-statusline` and sends the status line JSON on stdin.
// The helper keeps only the two usage windows and the time. It writes them to a private file for the quota reader.
// It never copies another field of the input: no path, no cost, no token.
import fs from 'node:fs';
import path from 'node:path';

export const MAX_STATUSLINE_INPUT_BYTES = 256 * 1024;
const READING_MAX_AGE_MS = 7 * 24 * 3600_000;
const WINDOW_KEYS = ['five_hour', 'seven_day'];

export const claudeRateLimitsDir = (dataDir) => path.join(dataDir, 'claude-rate-limits');

function safeName(value) {
  const name = typeof value === 'string' ? value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) : '';
  return name.replace(/^_+$/, '') || 'session';
}

function pickWindow(value) {
  if (!value || typeof value !== 'object') return null;
  const { used_percentage: used, resets_at: resets } = value;
  if (typeof used !== 'number' || !Number.isFinite(used) || typeof resets !== 'number' || !Number.isFinite(resets)) return null;
  return { used_percentage: used, resets_at: resets };
}

function removeOldReadings(dir, now) {
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const file = path.join(dir, name);
      if (now - fs.statSync(file).mtimeMs > READING_MAX_AGE_MS) fs.unlinkSync(file);
    } catch {}
  }
}

// Write the reading file of one session. Returns true when a file was written. Input without usable windows writes nothing.
export function recordClaudeStatusline({ input, dir, now = Date.now() }) {
  if (typeof input !== 'string' || Buffer.byteLength(input) > MAX_STATUSLINE_INPUT_BYTES) return false;
  let body;
  try { body = JSON.parse(input); } catch { return false; }
  if (!body || typeof body !== 'object') return false;
  const rateLimits = {};
  for (const key of WINDOW_KEYS) {
    const picked = pickWindow(body.rate_limits?.[key]);
    if (picked) rateLimits[key] = picked;
  }
  if (!Object.keys(rateLimits).length) return false;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, `${safeName(body.session_id)}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ observedAt: new Date(now).toISOString(), rate_limits: rateLimits })}\n`, { mode: 0o600 });
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
  try { removeOldReadings(dir, now); } catch {}
  return true;
}

async function readBounded(stdin) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_STATUSLINE_INPUT_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// `herdr-boss claude-statusline`. Print an empty status line. Always exit 0, so a failure never breaks the Claude session.
export async function claudeStatuslineCommand({ stdin = process.stdin, dir, now = () => Date.now(), write = (text) => process.stdout.write(text) }) {
  try {
    const input = await readBounded(stdin);
    if (input !== null) recordClaudeStatusline({ input, dir, now: now() });
  } catch {}
  write('\n');
  return 0;
}
