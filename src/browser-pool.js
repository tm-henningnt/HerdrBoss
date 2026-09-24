import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { DATA_DIR } from './config.js';
import { collectProcesses } from './collect.js';

const FILE = path.join(DATA_DIR, 'browser-sessions.json');
const PROFILE_ROOT = path.join(DATA_DIR, 'browser-profiles');
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function listBrowserSessions() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}

function save(sessions) {
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(sessions, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}

export async function browserStatus(session) {
  const reachable = await portOpen(session.port);
  const processes = reachable ? await collectProcesses() : new Map();
  const owner = [...processes.values()].find((p) => p.cmd.includes(`--remote-debugging-port=${session.port}`) && p.cmd.includes(`--user-data-dir=${session.profile}`));
  return { ...session, reachable, profileVerified: !!owner, pid: owner?.pid ?? session.pid };
}

export async function requestBrowser(project, { launch = true, chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } = {}) {
  if (!SLUG.test(project)) throw new Error('project must be a slug.');
  const sessions = listBrowserSessions();
  const existing = sessions[project];
  if (existing) {
    const status = await browserStatus(existing);
    if (status.reachable && !status.profileVerified) throw new Error(`Port ${existing.port} belongs to a different process. Inspect it before reuse.`);
    if (status.reachable || !launch) return status;
  }
  const claimed = new Set(Object.values(sessions).map((s) => s.port));
  let port;
  if (existing && !(await portOpen(existing.port))) port = existing.port;
  else for (let candidate = 9223; candidate <= 9299; candidate++) {
    if (!claimed.has(candidate) && !(await portOpen(candidate))) { port = candidate; break; }
  }
  if (!port) throw new Error('No free browser debugging port from 9223 to 9299.');
  const profile = path.join(PROFILE_ROOT, project);
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  const session = { project, port, profile, pid: null, createdAt: existing?.createdAt || new Date().toISOString(), launchedAt: null };
  sessions[project] = session;
  save(sessions);
  if (launch) {
    if (!fs.existsSync(chromePath)) throw new Error(`Chrome executable not found: ${chromePath}`);
    const child = spawn(chromePath, [
      `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profile}`, '--no-first-run', 'about:blank',
    ], { detached: true, stdio: 'ignore' });
    child.on('error', () => {}); // An executable error is reflected by the failed port probe below.
    child.unref();
    session.pid = child.pid;
    session.launchedAt = new Date().toISOString();
    save(sessions);
  }
  for (let attempt = 0; attempt < 12 && !(await portOpen(port)); attempt++) await new Promise((resolve) => setTimeout(resolve, 250));
  return browserStatus(session);
}
