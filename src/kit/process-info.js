import { spawnSync } from 'node:child_process';
import { getProcessInfo } from '../process-facts.js';

// Return the process start time that `ps` prints, or null when the system cannot read it.
export function processStartIdentity(pid, { readFacts = getProcessInfo } = {}) {
  const result = readFacts(pid);
  return result.known && result.alive ? result.start : null;
}

// Return { alive, start } and an optional diagnostic state. ESRCH means gone. EPERM means alive.
export function processInfo(pid, { wantStart = true, wantState = false } = {}) {
  const info = (alive, start, state = 'unknown') => ({ alive, start, ...(wantState ? { state } : {}) });
  try { process.kill(pid, 0); }
  catch (error) {
    if (error.code === 'ESRCH') return info(false, null);
    if (error.code !== 'EPERM') return null;
  }
  if (!wantStart && !wantState) return { alive: true, start: null };
  // A zombie has a PID but cannot run. Read state and start in one call without a command line or environment.
  try {
    const fields = wantStart ? ['-o', 'stat=', '-o', 'lstart='] : ['-o', 'stat='];
    const result = spawnSync('ps', [...fields, '-p', String(pid)], {
      encoding: 'utf8', timeout: 2000,
      env: { PATH: process.env.PATH ?? '', LC_ALL: 'C' },
    });
    if (result.status === 0) {
      const [state, ...start] = result.stdout.trim().split(/\s+/);
      if (state.startsWith('Z')) return info(false, null, 'zombie');
      if (/^[A-Z]/.test(state)) return info(true, wantStart ? start.join(' ') || null : null, 'alive');
    }
  } catch { /* An unavailable process table does not prove that the PID is dead. */ }
  return info(true, null);
}
