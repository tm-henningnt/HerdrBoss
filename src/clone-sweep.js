import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';

// Branded Google Chrome on macOS copies its app bundle to a code-sign clone at each launch.
// Chrome deletes the clone only at a clean shutdown, so a signal or a crash leaves it.
export const CLONE_NAME = /^code_sign_clone\.[A-Za-z0-9]+$/;
const CHROME_MAIN = '/Google Chrome.app/Contents/MacOS/Google Chrome';
const MIN_AGE_MS = 3600 * 1000;
const START_WINDOW_MS = 5000;

// The clone folder is a sibling of the user temporary folder: <DARWIN_USER_TEMP_DIR minus T/>/X/com.google.Chrome.code_sign_clone.
// A process with a temporary HOME, such as a test, gets null, so it never reaches the account's real clone folder.
export function codeSignCloneDir({
  platform = process.platform,
  getconf = () => execFileSync('getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8', timeout: 5000 }),
  homeCheck = true,
} = {}) {
  if (platform !== 'darwin') return null;
  if (homeCheck && !accountHome()) return null;
  try {
    const temp = String(getconf()).trim().replace(/\/+$/, '');
    if (!temp || path.basename(temp) !== 'T') return null;
    const dir = path.join(path.dirname(temp), 'X', 'com.google.Chrome.code_sign_clone');
    return fs.statSync(dir).isDirectory() ? dir : null;
  } catch { return null; }
}

function accountHome() {
  try { return fs.realpathSync(os.homedir()) === fs.realpathSync(os.userInfo().homedir); } catch { return false; }
}

// ps prints lstart as five fields, for example "Sun Sep 27 10:12:33 2026". On macOS, comm is the executable path.
export function parseProcessList(text) {
  const list = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(line);
    if (!m) continue;
    const startedAt = new Date(m[2]).getTime();
    if (Number.isFinite(startedAt)) list.push({ pid: Number(m[1]), startedAt, comm: m[3].trim() });
  }
  return list;
}

// Only pid, start time, and executable path are read. Command lines and environments are never read.
export function readProcesses() {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-axo', 'pid=,lstart=,comm='], { encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout) => (error ? reject(new Error('ps failed')) : resolve(parseProcessList(stdout))));
  });
}

async function loadProcesses(processes) {
  const list = typeof processes === 'function' ? await processes() : processes;
  if (!Array.isArray(list) || !list.length) throw new Error('empty');
  return list;
}

function ownedByRunningChrome(birthtimeMs, processes) {
  return processes.some((p) => typeof p.comm === 'string' && p.comm.endsWith(CHROME_MAIN) && Math.abs(p.startedAt - birthtimeMs) <= START_WINDOW_MS);
}

// A clone is a direct child folder with the expected name. A symbolic link or a file is never a clone.
function inspectClone(dir, name) {
  if (!CLONE_NAME.test(name)) return null;
  const folder = path.join(dir, name);
  let stats;
  try { stats = fs.lstatSync(folder); } catch { return null; }
  if (stats.isSymbolicLink() || !stats.isDirectory()) return null;
  try {
    const realDir = fs.realpathSync(dir);
    if (path.dirname(fs.realpathSync(folder)) !== realDir) return null;
  } catch { return null; }
  return { name, folder, birthtimeMs: stats.birthtimeMs };
}

export function listCloneNames(dir) {
  if (!dir) return null;
  try { return fs.readdirSync(dir).filter((name) => CLONE_NAME.test(name)); } catch { return null; }
}

async function statfsFree(dir) {
  const s = await fs.promises.statfs(dir);
  return s.bavail * s.bsize;
}

const removeFolder = (folder) => fs.promises.rm(folder, { recursive: true, force: true });

// Deletes one recorded clone after its Chrome exited. The age rule does not apply, but every other sweep rule does.
export async function removeCodeSignClone({ dir, name, processes = readProcesses, remove = removeFolder }) {
  if (!dir || !name) return false;
  const clone = inspectClone(dir, name);
  if (!clone) return false;
  let list;
  try { list = await loadProcesses(processes); } catch { return false; }
  if (ownedByRunningChrome(clone.birthtimeMs, list)) return false;
  await remove(clone.folder);
  return true;
}

// The sweep never signals a process. A clone whose birthtime is within 5 seconds of a running Chrome main process start is kept.
export async function sweepCodeSignClones({ dir, now = Date.now(), processes = readProcesses, remove = removeFolder, freeBytes = statfsFree, dryRun = false } = {}) {
  const result = { dir, candidates: [], removed: [], freedBytes: 0 };
  const names = listCloneNames(dir);
  if (!names) return result;
  let list;
  try { list = await loadProcesses(processes); } catch {
    result.error = 'Could not read the process list. Nothing was deleted.';
    return result;
  }
  for (const name of names.sort()) {
    const clone = inspectClone(dir, name);
    if (!clone || !(now - clone.birthtimeMs > MIN_AGE_MS) || ownedByRunningChrome(clone.birthtimeMs, list)) continue;
    result.candidates.push({ name, ageMs: now - clone.birthtimeMs, folder: clone.folder });
  }
  if (dryRun || !result.candidates.length) return result;
  const before = await freeBytes(dir);
  for (const candidate of result.candidates) {
    try { await remove(candidate.folder); result.removed.push(candidate.name); } catch {}
  }
  const after = await freeBytes(dir);
  result.freedBytes = Math.max(0, after - before);
  return result;
}
