import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DATA_DIR } from './config.js';
import { verifyCallerPane } from './caller-pane.js';
import { canonicalProcessPath, localProcessFacts, publicProcessFacts } from './process-facts.js';
import { readProjectRepos } from './harness.js';
import { expandHome, sharedWorktreeRoot } from './kit/config.js';

export function registeredProcessRoots(dataDir = DATA_DIR, { home = os.homedir() } = {}) {
  const roots = [dataDir, sharedWorktreeRoot(home, dataDir)];
  for (const { repo } of readProjectRepos(dataDir)) {
    roots.push(repo);
    try {
      const config = JSON.parse(fs.readFileSync(path.join(repo, '.herdr-boss.json'), 'utf8'));
      if (typeof config.worktreeRoot === 'string') {
        const expanded = expandHome(config.worktreeRoot, home);
        if (!path.isAbsolute(expanded) || /[\x00-\x1f]/.test(expanded)) continue;
        const root = canonicalProcessPath(expanded);
        const relative = path.relative(canonicalProcessPath(home), root);
        if (root !== path.parse(root).root && relative !== '' && relative !== '..'
          && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) roots.push(root);
      }
    } catch { /* The shared root still applies when a project has no override. */ }
  }
  return roots;
}

export function createProcessFactsApi({ herdr, roots = registeredProcessRoots, runner, readOnly = false } = {}) {
  const answer = (status, reason) => ({ status, body: { known: false, reason } });
  return { handle(req, url) {
    const match = /^\/api\/process-facts\/(info|port|cwd)$/.exec(url.pathname);
    if (!match) return answer(404, 'The process facts route does not exist.');
    const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    if (readOnly || !['127.0.0.1', 'localhost', '[::1]'].includes(host)
      || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) {
      return answer(403, 'Process facts require a loopback CLI request to the live service.');
    }
    if (req.method !== 'GET') return answer(405, 'Process facts accept GET only.');
    if (req.headers['x-herdr-env'] !== '1') return answer(403, 'The process facts caller must be a Herdr pane.');
    try {
      verifyCallerPane({ HERDR_PANE_ID: req.headers['x-herdr-pane-id'], HERDR_WORKSPACE_ID: req.headers['x-herdr-workspace-id'] }, herdr);
    } catch { return answer(403, 'The process facts caller pane could not be verified.'); }
    const kind = match[1], key = kind === 'cwd' ? 'path' : kind === 'port' ? 'port' : 'pid';
    const values = url.searchParams.getAll(key);
    if (values.length !== 1 || [...url.searchParams.keys()].some((item) => item !== key)) return answer(400, 'The process facts query is invalid.');
    let value = values[0];
    if (kind === 'cwd') {
      if (!path.isAbsolute(value) || /[\x00-\x1f]/.test(value) || value.length > 4096) return answer(400, 'The cwd path must be absolute.');
      try {
        value = canonicalProcessPath(value);
        if (!roots().some((root) => {
          const relative = path.relative(canonicalProcessPath(root), value);
          return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
        })) return answer(403, 'The cwd path is outside registered project roots, worktree roots, and the data directory.');
      } catch { return answer(403, 'The allowed cwd roots could not be checked.'); }
    } else {
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || (kind === 'port' && Number(value) > 65535)) return answer(400, 'The PID or port is invalid.');
      value = Number(value);
    }
    const facts = localProcessFacts(kind, value, { runner });
    const body = publicProcessFacts(kind, { ...facts, ...(kind === 'port' ? { servicePid: process.pid } : {}) });
    return { status: 200, body };
  } };
}
