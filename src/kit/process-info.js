import { spawnSync } from 'node:child_process';

// Return the process start time that `ps` prints, or null when the system cannot read it.
export function processStartIdentity(pid) {
  try {
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 2000,
      env: { PATH: process.env.PATH ?? '', LC_ALL: 'C' },
    });
    if (result.status !== 0) return null;
    return result.stdout.trim().replace(/\s+/g, ' ') || null;
  } catch {
    return null;
  }
}

// Return { alive, start } for a process, or null when the platform cannot tell. ESRCH means gone. EPERM means alive.
export function processInfo(pid, { wantStart = true, wantState = false } = {}) {
  try { process.kill(pid, 0); }
  catch (error) {
    if (error.code === 'ESRCH') return { alive: false, start: null };
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
      if (state.startsWith('Z')) return { alive: false, start: null };
      return { alive: true, start: wantStart ? start.join(' ') || null : null };
    }
  } catch { /* An unavailable process table does not prove that the PID is dead. */ }
  return { alive: true, start: null };
}
