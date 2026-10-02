import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { kitRevision } from './kit/agents-check.js';

export const HEALTH_SCHEMA = 1;
export const HEALTH_CONTRACT_VERSION = '1.0.0';
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const OFFSET_CACHE_MS = 60_000;

// The clock offset of this machine in seconds, from a local time daemon. Positive means the clock is ahead.
// chrony is the only source that needs no network call. Any other machine reports null.
export function readClockOffset(run = execFile) {
  return new Promise((resolve) => {
    run('chronyc', ['tracking'], { timeout: 2000 }, (error, stdout) => {
      const match = !error && /System time\s*:\s*([0-9.]+) seconds (fast|slow)/.exec(String(stdout));
      if (!match) return resolve(null);
      const seconds = Number(match[1]) * (match[2] === 'slow' ? -1 : 1);
      resolve(Number.isFinite(seconds) ? seconds : null);
    });
  });
}

// The body of GET /api/health. It follows factory-health.v1.schema.json: no path, no host name, no secret.
// An unavailable reading is null, never zero. An unknown kit revision gives { error }, which the route sends as 503.
export function createHealth({ readOffset = readClockOffset, readKit = kitRevision, now = () => Date.now() } = {}) {
  let offset = { at: 0, value: null };
  return async (engine) => {
    const state = engine.state;
    const updated = Date.parse(state?.updatedAt);
    const herdrFailed = (state?.errors || []).some((message) => String(message).startsWith('herdr:'));
    if (now() - offset.at > OFFSET_CACHE_MS) offset = { at: now(), value: await readOffset().catch(() => null) };
    const revision = state?.kit?.current ?? readKit();
    if (typeof revision !== 'string' || !/^[a-f0-9]{12,64}$/.test(revision)) return { error: 'kit revision unknown' };
    return {
      schema: HEALTH_SCHEMA,
      contractVersion: HEALTH_CONTRACT_VERSION,
      version: VERSION,
      kitRevision: revision,
      tickAgeSeconds: Number.isFinite(updated) ? Math.max(0, Math.floor((now() - updated) / 1000)) : null,
      herdrReachable: !state ? null : Array.isArray(state.herdr?.panes) && !herdrFailed,
      clockOffsetSeconds: offset.value,
    };
  };
}
