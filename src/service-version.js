import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kitRevision } from './kit/agents-check.js';

const CHECKOUT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMIT_DATE = /^([a-f0-9]{40,64})\n(\d{4}-\d{2}-\d{2})$/i;
const KIT_REVISION = /^[a-f0-9]{12,64}$/i;

// Read these values once when the service starts. A missing Git checkout has no commit or date.
export function readServiceVersion({ root = CHECKOUT_ROOT, now = Date.now, runGit = execFileSync, readKit = kitRevision } = {}) {
  let commit = null;
  let commitDate = null;
  try {
    const output = String(runGit('git', ['log', '-1', '--format=%H%n%cs'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })).trim();
    const match = COMMIT_DATE.exec(output);
    if (match) {
      commit = match[1].slice(0, 7).toLowerCase();
      commitDate = match[2];
    }
  } catch { /* A checkout without Git has no commit metadata. */ }
  let revision = null;
  try {
    const value = readKit();
    if (typeof value === 'string' && KIT_REVISION.test(value)) revision = value.toLowerCase();
  } catch { /* The service can still report the other version fields. */ }
  return { commit, commitDate, kitRevision: revision, startedAt: new Date(now()).toISOString() };
}
