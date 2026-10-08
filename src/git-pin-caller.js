// Caller verification stays outside the low-level guard used by the lock modules.
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { readDataFile } from './data-file-safety.js';
import { verifyMessageCaller } from './messages.js';

export function assertPinCaller(projects, { env = process.env, herdr, dataDir = DATA_DIR, bossOnly = false, stdin = process.stdin, stdout = process.stdout } = {}) {
  const pane = env.HERDR_ENV === '1' || env.HERDR_PANE_ID || env.HERDR_WORKSPACE_ID || env.HERDR_WORKTREE;
  if (!pane) {
    if (bossOnly) throw new Error('Only the Boss can override Git pins.');
    if (!stdin.isTTY || !stdout.isTTY) throw new Error('Owner harness pin needs a TTY on stdin and stdout.');
    return { role: 'owner' };
  }
  const caller = verifyMessageCaller({ ...env, HERDR_ENV: '1' }, herdr, 'harness pin');
  if (caller.role === 'boss') return caller;
  if (bossOnly) throw new Error('Only the Boss can override Git pins.');
  let control;
  try { control = JSON.parse(readDataFile(path.join(dataDir, 'rules.json'), dataDir)).control; } catch { throw new Error('Cannot verify the project orchestrator for harness pin.'); }
  const owner = Object.entries(control?.projects || {}).find(([, project]) => project?.workspace === caller.workspaceId)?.[0]
    ?? control?.workspaces?.find((row) => row.workspace === caller.workspaceId)?.slug;
  if (!owner || projects.some((project) => project.slug !== owner)) throw new Error('Only the project orchestrator or the Boss can refresh these Git pins.');
  return { ...caller, project: owner };
}
