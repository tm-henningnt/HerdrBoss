import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { DATA_DIR } from '../config.js';
import { quietHoursActive, readNight } from '../night.js';
import { DEFAULT_RULES_FILE, loadProjectConfig } from './config.js';
import { SWAP_FORCE_ENV, swapGuardFor } from './swap-guard.js';
import { createHerdrRunner, verifyCallerPane } from './workers.js';

const LOCK_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const COMMAND = (name) => `herdr-boss lock acquire ${name}`;
// A machine lock is shared by all repositories on this machine. Other lock names are per repository.
const MACHINE_LOCKS = new Set(['full-suite']);
export const FULL_SUITE_LOCK = 'full-suite';
const PUSH_LOCK_WAIT_SECONDS = 1800;
export const MUTATION_GUARD_WAIT_MS = 5000;
const MANUAL_LOCK_TTL_MS = 60 * 60 * 1000;
const LOCK_WAIT_NOTICE_INTERVAL_MS = 60 * 1000;
const LOCK_KINDS = new Set(['manual', 'suite', 'push']);
const LOCK_NOTICE_TEXT = 'Your full-suite lock expired after 60 minutes and was released. Use herdr-boss suite -- <command> next time.';
export const LOCK_LEDGER_FILE = 'lock-ledger.jsonl';
const LEDGER_EVENTS = new Set(['acquire', 'release', 'busy', 'timeout']);
const LEDGER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const scopeFor = (name) => (MACHINE_LOCKS.has(name) ? 'machine' : 'repository');

function validateName(name) {
  if (typeof name !== 'string' || !LOCK_NAME.test(name)) {
    throw new Error('Lock name must be one path-safe token of 1 to 64 letters, numbers, dots, underscores, or hyphens.');
  }
}

function gitCommonDir(root) {
  const value = execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
  if (!value) throw new Error(`Could not find the Git common directory for ${root}.`);
  return fs.realpathSync(value);
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  return directory;
}

function lockDirectory(commonDir, dataDir, scope = 'repository') {
  const locksRoot = privateDirectory(path.join(dataDir, 'locks'));
  if (scope === 'machine') return privateDirectory(path.join(locksRoot, 'machine'));
  const key = crypto.createHash('sha256').update(commonDir).digest('hex');
  return privateDirectory(path.join(locksRoot, key));
}

function readRecord(file, commonDir, scope = 'repository') {
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot read lock record ${path.basename(file)}: ${error.message}`);
  }
  const machine = scope === 'machine';
  if (!value || (machine ? value.scope !== 'machine' || typeof value.gitCommonDir !== 'string' : value.gitCommonDir !== commonDir)
    || (machine && !MACHINE_LOCKS.has(value.name)) || typeof value.ownerPane !== 'string'
    || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.name !== 'string'
    || !LOCK_NAME.test(value.name) || value.name !== path.basename(file, '.json')
    || value.command !== COMMAND(value.name) || typeof value.acquiredAt !== 'string'
    || (value.reentryToken !== undefined && (typeof value.reentryToken !== 'string' || value.reentryToken.length < 16 || value.reentryToken.length > 256))
    || !Number.isFinite(Date.parse(value.acquiredAt))) {
    throw new Error(`Lock record ${path.basename(file)} is invalid. Refusing to change it.`);
  }
  const kind = value.kind ?? 'manual';
  if (!LOCK_KINDS.has(kind) || (kind !== 'manual' && value.name !== FULL_SUITE_LOCK)) {
    throw new Error(`Lock record ${path.basename(file)} is invalid. Refusing to change it.`);
  }
  const expiresAt = value.expiresAt ?? (scope === 'machine' && value.name === FULL_SUITE_LOCK && kind === 'manual'
    ? new Date(Date.parse(value.acquiredAt) + MANUAL_LOCK_TTL_MS).toISOString()
    : undefined);
  if (expiresAt !== undefined && (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)))) {
    throw new Error(`Lock record ${path.basename(file)} is invalid. Refusing to change it.`);
  }
  return { ...value, kind, ...(expiresAt ? { expiresAt } : {}), scope };
}

function paneIds(herdr) {
  const response = herdr(['pane', 'list']);
  const panes = Array.isArray(response) ? response : response?.panes;
  if (!Array.isArray(panes)) throw new Error('Cannot confirm Herdr pane state. Refusing to change a lock.');
  return new Set(panes.map((pane) => pane?.pane_id ?? pane?.paneId ?? pane?.id).filter((id) => typeof id === 'string'));
}

function pidIsAlive(pid, probe = process.kill) {
  try { probe(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw new Error(`Cannot check lock owner PID ${pid}: ${error.message}`);
  }
}

function lockIsLive(record, { herdr, livePanes = null, pidAlive = pidIsAlive, now = Date.now, quietHours = false }) {
  if (record.name === FULL_SUITE_LOCK && record.kind === 'manual' && record.expiresAt
    && Date.parse(record.expiresAt) <= timeValue(now) && !quietHours) return false;
  let alive;
  try { alive = pidAlive(record.pid); }
  catch (error) {
    if (error.code === 'EPERM') alive = true;
    else throw error;
  }
  if (!alive) return false;
  return (livePanes ?? paneIds(herdr)).has(record.ownerPane);
}

function reentryTokenMatches(record, env, pidAlive) {
  return record?.name === FULL_SUITE_LOCK
    && record.kind === 'push'
    && typeof record.reentryToken === 'string'
    && env.HERDR_BOSS_LOCK_TOKEN === record.reentryToken
    && pidAlive(record.pid);
}

function lockQueueDirectory(directory, name = FULL_SUITE_LOCK) {
  return privateDirectory(path.join(privateDirectory(path.join(directory, 'queue')), name));
}

function readQueueTickets(directory, name = FULL_SUITE_LOCK) {
  const queue = path.join(directory, 'queue', name);
  let files;
  try { files = fs.readdirSync(queue).filter((file) => file.endsWith('.json')).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  // A broken ticket (a writer killed in the middle of a write) must never block the queue. Skip it with one warning.
  const tickets = [];
  for (const file of files) {
    let ticket = null;
    try { ticket = JSON.parse(fs.readFileSync(path.join(queue, file), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; ticket = null; }
    const valid = ticket && ticket.id === path.basename(file, '.json') && /^[0-9a-f-]{36}$/i.test(ticket.id)
      && Number.isSafeInteger(ticket.seq) && ticket.seq >= 1 && typeof ticket.pane === 'string' && ticket.pane
      && typeof ticket.project === 'string' && ticket.project && Number.isSafeInteger(ticket.pid) && ticket.pid >= 1
      && LOCK_KINDS.has(ticket.kind) && ticket.command === COMMAND(name)
      && typeof ticket.createdAt === 'string' && Number.isFinite(Date.parse(ticket.createdAt));
    if (!valid) {
      process.stderr.write(`Warning: skipped the unreadable or invalid lock queue ticket ${path.basename(file)}.\n`);
      continue;
    }
    tickets.push(ticket);
  }
  // Equal sequence numbers keep a stable order by id.
  tickets.sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
  return tickets;
}

function ticketIsLive(ticket, { livePanes, pidAlive = pidIsAlive, now = Date.now }) {
  return lockIsLive({ name: FULL_SUITE_LOCK, ownerPane: ticket.pane, pid: ticket.pid, kind: ticket.kind }, {
    livePanes, pidAlive, now,
  });
}

function removeQueueTicket(directory, ticket) {
  if (!ticket) return;
  try { fs.unlinkSync(path.join(directory, 'queue', FULL_SUITE_LOCK, `${ticket.id}.json`)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function nextQueueSequence(queue, tickets) {
  const file = path.join(queue, '.sequence');
  let previous = 0;
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    previous = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(previous) || previous < 0) throw new Error('sequence is invalid');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot read lock queue sequence: ${error.message}`);
  }
  const next = Math.max(previous, ...tickets.map((ticket) => ticket.seq)) + 1;
  if (!Number.isSafeInteger(next)) throw new Error('Lock queue sequence is exhausted.');
  fs.writeFileSync(file, `${next}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return next;
}

function createQueueTicket(directory, name, { config, caller, pid, kind, now }, tickets) {
  const queue = lockQueueDirectory(directory, name);
  const ticket = {
    id: crypto.randomUUID(),
    seq: nextQueueSequence(queue, tickets),
    pane: caller.paneId,
    project: config.slug,
    pid,
    kind,
    command: COMMAND(name),
    createdAt: new Date(timeValue(now)).toISOString(),
  };
  writeNewRecord(path.join(queue, `${ticket.id}.json`), ticket);
  return ticket;
}

function waitBusyError(name, { activeRecord, tickets, ticket, startedAt, now }) {
  const ticketIndex = ticket ? tickets.findIndex((item) => item.id === ticket.id) : -1;
  const position = ticketIndex >= 0 ? ticketIndex + 1 : tickets.length + 1;
  const total = Math.max(1, tickets.length + (ticketIndex >= 0 ? 0 : 1));
  const head = tickets[0];
  const holder = activeRecord
    ? `${activeRecord.ownerPane} (${activeRecord.kind})`
    : head ? `${head.pane} (${head.kind})` : 'no active holder';
  const waited = Math.max(0, Math.floor((timeValue(now) - startedAt) / 1000));
  const error = new Error(`lock busy: ${name} is held by ${holder}; queue position ${position} of ${total}; waited ${waited} seconds.`);
  error.code = 'ELOCKBUSY';
  error.exitCode = 75;
  error.ledgerEvent = 'timeout';
  return error;
}

function noWaitBusyError(name, activeRecord, tickets) {
  const queueLength = tickets.length;
  if (activeRecord) {
    return Object.assign(new Error(`Lock ${name} is held by active pane ${activeRecord.ownerPane} (PID ${activeRecord.pid}, since ${activeRecord.acquiredAt}); queue length ${queueLength}.`), { ledgerEvent: 'busy' });
  }
  const first = tickets[0];
  return Object.assign(new Error(`Lock ${name} is waiting for pane ${first.pane} (${first.kind}); queue length ${queueLength}.`), { ledgerEvent: 'busy' });
}

function writeNewRecord(file, record) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`);
    fs.fchmodSync(fd, 0o600);
  } catch (error) {
    try { fs.unlinkSync(file); } catch {}
    throw error;
  } finally {
    fs.closeSync(fd);
  }
}

function sleep(milliseconds) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); }

const MUTATION_OWNER_FILE = 'owner.json';
const MUTATION_OWNERLESS_STALE_MS = 10_000;
const MUTATION_MAX_AGE_MS = 60_000;

function readMutationOwner(guard) {
  try { return fs.readFileSync(path.join(guard, MUTATION_OWNER_FILE), 'utf8'); }
  catch { return null; }
}

function mutationGuardSnapshot(guard) {
  let stat;
  try { stat = fs.statSync(guard); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }

  const ownerText = readMutationOwner(guard);
  let ownerPid = null;
  if (ownerText !== null) {
    try {
      const owner = JSON.parse(ownerText);
      if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) ownerPid = owner.pid;
    } catch {}
  }
  const ageMs = Math.max(0, Date.now() - stat.mtimeMs);
  const stale = ageMs > MUTATION_MAX_AGE_MS
    || (ownerPid === null && ageMs > MUTATION_OWNERLESS_STALE_MS)
    || (ownerPid !== null && !pidIsAlive(ownerPid));
  return { stat, ownerText, ownerPid, ageMs, ageSeconds: Math.floor(ageMs / 1000), stale };
}

function sameMutationGuard(left, right) {
  return left.stat.dev === right.stat.dev
    && left.stat.ino === right.stat.ino
    && left.stat.mtimeMs === right.stat.mtimeMs
    && left.ownerText === right.ownerText;
}

function cleanupOwnedMutationGuard(guard, identity, ownerText = null) {
  let current;
  try { current = fs.statSync(guard); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (current.dev !== identity.dev || current.ino !== identity.ino) return;
  if (ownerText !== null && readMutationOwner(guard) !== ownerText) return;

  try { fs.unlinkSync(path.join(guard, MUTATION_OWNER_FILE)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { fs.rmdirSync(guard); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function removeStaleMutationGuard(guard, observed, onStale) {
  if (!observed?.stale) return false;
  const current = mutationGuardSnapshot(guard);
  if (!current?.stale || !sameMutationGuard(observed, current)) return false;

  const stalePath = path.join(path.dirname(guard), `.mutation.stale-${crypto.randomUUID()}`);
  try { fs.renameSync(guard, stalePath); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  fs.rmSync(stalePath, { recursive: true, force: true });
  const pid = current.ownerPid ?? 'unknown';
  onStale(`Removed a stale lock guard (PID ${pid}, age ${current.ageSeconds}s).`);
  return true;
}

function lockNoticesDirectory(dataDir) {
  return privateDirectory(path.join(lockDirectory('', dataDir, 'machine'), 'notices'));
}

function writeManualExpiryNotice(record, dataDir, now) {
  const directory = lockNoticesDirectory(dataDir);
  const notice = {
    id: crypto.randomUUID(),
    severity: 'warn',
    ownerPane: record.ownerPane,
    text: LOCK_NOTICE_TEXT,
    createdAt: new Date(timeValue(now)).toISOString(),
  };
  writeNewRecord(path.join(directory, `${notice.id}.json`), notice);
  return notice;
}

export function readLockTakeoverNotices({ dataDir = DATA_DIR } = {}) {
  const directory = path.join(dataDir, 'locks', 'machine', 'notices');
  let files;
  try { files = fs.readdirSync(directory).filter((file) => /^[0-9a-f-]{36}\.json$/i.test(file)).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return files.map((file) => {
    let notice;
    try { notice = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')); }
    catch (error) { throw new Error(`Cannot read lock notice ${path.basename(file)}: ${error.message}`); }
    if (!notice || notice.id !== path.basename(file, '.json') || notice.severity !== 'warn'
      || typeof notice.ownerPane !== 'string' || notice.text !== LOCK_NOTICE_TEXT
      || typeof notice.createdAt !== 'string' || !Number.isFinite(Date.parse(notice.createdAt))) {
      throw new Error(`Lock notice ${path.basename(file)} is invalid.`);
    }
    return notice;
  });
}

export function removeLockTakeoverNotice(id, { dataDir = DATA_DIR } = {}) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Lock notice ID is invalid.');
  try { fs.unlinkSync(path.join(dataDir, 'locks', 'machine', 'notices', `${id}.json`)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

// The .mutation guard folder in directory makes one lock or lease change at a time. A busy guard throws ELOCKBUSY
// with busyMessage, after waitMs of retries. src/leases.js uses the guard of the machine-scope locks.
export function withMutationLock(directory, operation, {
  waitMs = MUTATION_GUARD_WAIT_MS,
  busyMessage = 'A project lock operation is already in progress. Retry when it finishes.',
  onStale = (message) => process.stderr.write(`${message}\n`),
} = {}) {
  const guard = path.join(directory, '.mutation');
  const deadline = Date.now() + waitMs;
  let ownerText;
  let ownerStat;
  for (;;) {
    let created = false;
    let createdStat = null;
    try {
      fs.mkdirSync(guard, { mode: 0o700 });
      created = true;
      createdStat = fs.statSync(guard);
      fs.chmodSync(guard, 0o700);
      ownerText = `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`;
      fs.writeFileSync(path.join(guard, MUTATION_OWNER_FILE), ownerText, { mode: 0o600, flag: 'wx' });
      ownerStat = fs.statSync(guard);
      break;
    } catch (error) {
      if (created) {
        try { cleanupOwnedMutationGuard(guard, createdStat); } catch {}
        throw error;
      }
      if (error.code !== 'EEXIST') throw error;
      const observed = mutationGuardSnapshot(guard);
      if (removeStaleMutationGuard(guard, observed, onStale)) continue;
      if (Date.now() >= deadline) {
        const busy = new Error(busyMessage);
        busy.code = 'ELOCKBUSY';
        throw busy;
      }
      sleep(50);
    }
  }
  try { return operation(); }
  finally { cleanupOwnedMutationGuard(guard, ownerStat, ownerText); }
}

function lockContext(config, dataDir, scope = 'repository') {
  const commonDir = gitCommonDir(config.root);
  const directory = lockDirectory(commonDir, dataDir, scope);
  return { commonDir, directory, scope };
}

function realpathOrNull(file) {
  try { return fs.realpathSync(file); } catch { return null; }
}

function checkoutRoots(root) {
  let listing = '';
  try { listing = execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }); } catch {}
  const roots = listing.split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length));
  return [...new Set([root, ...roots])];
}

// A worker run record is live when it names this pane and this worktree and has no finishedAt.
// The records are in the runs folder of any checkout of the repository, usually the orchestrator checkout.
// Return { name, file } for the live run, or null.
export function hasLiveWorkerRun(paneId, root) {
  const worktree = realpathOrNull(root);
  if (!worktree) return null;
  for (const checkout of checkoutRoots(root)) {
    let runsPath;
    try { runsPath = realpathOrNull(loadProjectConfig({ cwd: checkout }).runsPath); } catch { continue; }
    if (!runsPath) continue;
    for (const file of fs.readdirSync(runsPath).filter((entry) => entry.endsWith('.json'))) {
      const name = path.basename(file, '.json');
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) continue;
      const actual = realpathOrNull(path.join(runsPath, file));
      if (!actual || !actual.startsWith(`${runsPath}${path.sep}`)) continue;
      let run;
      try { run = JSON.parse(fs.readFileSync(actual, 'utf8')); } catch { continue; }
      if (run?.name === name && run.pane === paneId && !run.finishedAt && typeof run.worktree === 'string'
        && realpathOrNull(run.worktree) === worktree) return { name, file: actual };
    }
  }
  return null;
}

function workerCallerFor(env, herdr, config) {
  const paneId = env.HERDR_PANE_ID;
  const workspaceId = env.HERDR_WORKSPACE_ID;
  if (!paneId || !workspaceId) return null;
  let response;
  try { response = herdr(['pane', 'get', paneId]); } catch { return null; }
  const pane = response?.pane ?? response;
  if ((pane?.pane_id ?? pane?.paneId ?? pane?.id) !== paneId) return null;
  if ((pane.workspace_id ?? pane.workspaceId ?? pane.workspace) !== workspaceId) return null;
  if (!hasLiveWorkerRun(paneId, config.root)) return null;
  return { paneId, workspaceId };
}

// The full-suite lock also accepts a worker pane with a live run record. Other locks accept only orch or boss.
function callerFor(env, herdr, { name = null, config = null } = {}) {
  try { return verifyCallerPane(env, herdr, null); }
  catch (error) {
    if (name !== FULL_SUITE_LOCK || !config) throw error;
    const worker = workerCallerFor(env, herdr, config);
    if (worker) return worker;
    throw new Error(`${error.message} A worker pane can take the ${FULL_SUITE_LOCK} lock only with a live worker run record for this pane and worktree.`);
  }
}

function shellPidFor(paneId, herdr) {
  const response = herdr(['pane', 'process-info', '--pane', paneId]);
  const info = response?.process_info ?? response;
  const pid = Number(info?.shell_pid ?? info?.shellPid);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Herdr did not return a valid shell PID for pane ${paneId}.`);
  return pid;
}

function timeValue(now) {
  const value = typeof now === 'function' ? now() : now;
  return value instanceof Date ? value.getTime() : Number(value);
}

function warnLockReleaseFailure(error, output) {
  const reason = String(error?.message ?? error).replace(/\s+/g, ' ').replace(/[. ]+$/, '');
  output(`Warning: could not release lock ${FULL_SUITE_LOCK}: ${reason}. The lock is stale when this process ends.`);
}

function logQuietHoursHold(dataDir, now, action, extra = {}) {
  const event = { at: new Date(timeValue(now)).toISOString(), type: 'quiet-hours', text: `quiet hours held ${action}`, ...extra };
  fs.appendFileSync(path.join(dataDir, 'events.jsonl'), `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

// The lock ledger is an append-only JSONL file in the data directory. Each acquire and each release adds one line.
// A ledger failure never blocks a lock change.
function cleanTreeHash(root) {
  try {
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (git('status', '--porcelain')) return null;
    const tree = git('rev-parse', 'HEAD^{tree}');
    return /^[0-9a-f]{40,64}$/i.test(tree) ? tree : null;
  } catch {
    return null;
  }
}

export const LOCK_LEDGER_MAX_BYTES = 5 * 1024 * 1024;
export const LOCK_LEDGER_ROTATED_FILE = 'lock-ledger.1.jsonl';

function ledgerLine(event, record, now, extra) {
  return {
    at: new Date(timeValue(now)).toISOString(),
    event,
    name: record.name,
    project: record.project ?? null,
    kind: record.kind ?? 'manual',
    pane: record.ownerPane ?? null,
    tree: record.tree ?? null,
    ...extra,
  };
}

// Builds the line inside the try, so an invalid clock or an unwritable folder never throws.
// A file above 5 MB moves to lock-ledger.1.jsonl and replaces the older rotated file.
function appendLockLedger(dataDir, event, record, now, extra = {}) {
  try {
    const line = ledgerLine(event, record, now, extra);
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(dataDir, LOCK_LEDGER_FILE);
    try {
      if (fs.statSync(file).size > LOCK_LEDGER_MAX_BYTES) fs.renameSync(file, path.join(dataDir, LOCK_LEDGER_ROTATED_FILE));
    } catch {}
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch {}
}

// Records one release line. holdMs defaults to the time since the record was acquired.
export function recordLockRelease(record, { dataDir = DATA_DIR, now = Date.now, holdMs, reentrant = false, takeover = false } = {}) {
  const hold = holdMs === undefined ? Math.max(0, timeValue(now) - Date.parse(record.acquiredAt)) : holdMs;
  appendLockLedger(dataDir, 'release', record, now, { holdMs: hold, ...(reentrant ? { reentrant: true } : {}), ...(takeover ? { takeover: true } : {}) });
}

export function readLockLedger({ dataDir = DATA_DIR, sinceMs = null } = {}) {
  let text;
  try { text = fs.readFileSync(path.join(dataDir, LOCK_LEDGER_FILE), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'EISDIR') return []; throw error; }
  const lines = [];
  for (const raw of text.split('\n')) {
    if (!raw) continue;
    let line;
    try { line = JSON.parse(raw); } catch { continue; }
    if (!line || typeof line !== 'object' || !LEDGER_EVENTS.has(line.event)) continue;
    if (sinceMs !== null && !(Date.parse(line.at) >= sinceMs)) continue;
    lines.push(line);
  }
  return lines;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// Medians skip re-entrant lines: a re-entrant hold runs inside the hold of its push.
// Hold medians also skip takeover lines. Wait medians skip failed acquires (busy, timeout); they are counted separately.
export function lockLedgerStats(lines) {
  const own = lines.filter((line) => !line.reentrant);
  const waits = own.filter((line) => line.event === 'acquire' && Number.isFinite(line.waitMs)).map((line) => line.waitMs);
  const holds = own.filter((line) => line.event === 'release' && !line.takeover && Number.isFinite(line.holdMs)).map((line) => line.holdMs);
  return {
    acquires: lines.filter((line) => line.event === 'acquire').length,
    busy: lines.filter((line) => line.event === 'busy').length,
    timeouts: lines.filter((line) => line.event === 'timeout').length,
    takeovers: lines.filter((line) => line.event === 'release' && line.takeover).length,
    reentrantAcquires: lines.filter((line) => line.event === 'acquire' && line.reentrant).length,
    releases: holds.length,
    medianWaitMs: median(waits),
    medianHoldMs: median(holds),
  };
}

let ledgerCache = null;

// Summary of the last 7 days for the dashboard: all locks, and each lock name. Cached until the file changes.
export function lockLedgerSummary({ dataDir = DATA_DIR, now = Date.now } = {}) {
  const file = path.join(dataDir, LOCK_LEDGER_FILE);
  let stat;
  try { stat = fs.statSync(file); } catch { return { windowDays: 7, ...lockLedgerStats([]), byName: {} }; }
  const day = Math.floor(timeValue(now) / 3600000);
  const key = `${file}:${stat.size}:${stat.mtimeMs}:${day}`;
  if (ledgerCache?.key === key) return ledgerCache.value;
  const lines = readLockLedger({ dataDir, sinceMs: timeValue(now) - LEDGER_WINDOW_MS });
  const byName = {};
  for (const name of [...new Set(lines.map((line) => line.name))].sort()) {
    byName[name] = lockLedgerStats(lines.filter((line) => line.name === name));
  }
  const value = { windowDays: 7, ...lockLedgerStats(lines), byName };
  ledgerCache = { key, value };
  return value;
}

const defaultPause = sleep;

export function acquireProjectLock(name, {
  config,
  env = process.env,
  herdr = createHerdrRunner(),
  dataDir = DATA_DIR,
  waitSeconds = null,
  output = console.log,
  now = Date.now,
  pause = defaultPause,
  pidAlive = pidIsAlive,
  kind = 'manual',
  reentryToken = null,
} = {}) {
  validateName(name);
  if (!LOCK_KINDS.has(kind) || (kind !== 'manual' && name !== FULL_SUITE_LOCK)) {
    throw new Error('Lock kind must be manual, suite, or push. Only full-suite accepts suite and push kinds.');
  }
  if (reentryToken !== null && (kind !== 'push' || name !== FULL_SUITE_LOCK
    || typeof reentryToken !== 'string' || reentryToken.length < 16 || reentryToken.length > 256)) {
    throw new Error('A lock re-entry token requires a push lock and must be 16 to 256 characters.');
  }
  if (waitSeconds !== null && (!Number.isSafeInteger(waitSeconds) || waitSeconds < 0)) {
    throw new Error('--wait must be a whole non-negative number of seconds.');
  }
  const caller = callerFor(env, herdr, { name, config });
  const pid = kind === 'manual' ? shellPidFor(caller.paneId, herdr) : process.pid;
  const { commonDir, directory, scope } = lockContext(config, dataDir, scopeFor(name));
  const file = path.join(directory, `${name}.json`);
  const queued = scope === 'machine';
  const startedAt = timeValue(now);
  const deadline = waitSeconds === null ? null : BigInt(timeValue(now)) + BigInt(waitSeconds) * 1000n;
  let ticket = null;
  let ticketOutstanding = false;
  let lastNotice = null;
  let lastNoticeAt = null;
  let failure = null;
  try {
    for (;;) {
      let staleRecord = null;
      let outcome;
      let quietHours = false;
      try {
        outcome = withMutationLock(directory, () => {
          let tickets = [];
          let livePanes = null;
          if (queued) {
            const queue = lockQueueDirectory(directory, name);
            tickets = readQueueTickets(directory, name);
            livePanes = paneIds(herdr);
            const live = [];
            for (const entry of tickets) {
              if (ticketIsLive(entry, { livePanes, pidAlive, now })) live.push(entry);
              else removeQueueTicket(directory, entry);
            }
            tickets = live;
            if (!fs.statSync(queue).isDirectory()) throw new Error('The lock queue is not a directory.');
          }

          quietHours = quietHoursActive(readNight({ dataDir, now: timeValue(now) }));
          const previous = readRecord(file, commonDir, scope);
          const previousIsLive = previous && lockIsLive(previous, { herdr, livePanes, pidAlive, now, quietHours });
          if (previousIsLive) {
            if (quietHours && name === FULL_SUITE_LOCK && previous.kind === 'manual' && previous.expiresAt
              && Date.parse(previous.expiresAt) <= timeValue(now)) {
              logQuietHoursHold(dataDir, now, 'manual full-suite lock expiry', { pane: previous.ownerPane });
            }
            // Check before creating a ticket so a hook does not queue behind its live push.
            if (reentryTokenMatches(previous, env, pidAlive)) {
              return { reentrant: { ...previous, reentrant: true }, tickets };
            }
            if (queued && waitSeconds !== null && !ticket) {
              ticket = createQueueTicket(directory, name, { config, caller, pid, kind, now }, tickets);
              ticketOutstanding = true;
              tickets.push(ticket);
              tickets.sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
            }
            if (waitSeconds === null) return { activeRecord: previous, tickets };
            return { activeRecord: previous, tickets };
          }
          if (previous) {
            staleRecord = previous;
            if (name === FULL_SUITE_LOCK && previous.kind === 'manual' && previous.expiresAt
              && Date.parse(previous.expiresAt) <= timeValue(now)) writeManualExpiryNotice(previous, dataDir, now);
            fs.unlinkSync(file);
          }
          if (queued && waitSeconds !== null && !ticket) {
            ticket = createQueueTicket(directory, name, { config, caller, pid, kind, now }, tickets);
            ticketOutstanding = true;
            tickets.push(ticket);
            tickets.sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
          }
          if (queued && waitSeconds === null && tickets.length) return { queueBlocked: true, tickets };
          if (queued && waitSeconds !== null && tickets[0]?.id !== ticket.id) return { queueBlocked: true, tickets };

          if (ticketOutstanding) {
            removeQueueTicket(directory, ticket);
            ticketOutstanding = false;
          }
          const acquiredAt = new Date(timeValue(now)).toISOString();
          const treeHash = cleanTreeHash(config.root);
          const record = {
            name,
            project: config.slug,
            gitCommonDir: commonDir,
            ownerPane: caller.paneId,
            pid,
            kind,
            command: COMMAND(name),
            acquiredAt,
            ...(scope === 'machine' && kind === 'manual' ? { expiresAt: new Date(Date.parse(acquiredAt) + MANUAL_LOCK_TTL_MS).toISOString() } : {}),
            ...(reentryToken !== null ? { reentryToken } : {}),
            ...(scope === 'machine' ? { scope } : {}),
            ...(treeHash ? { tree: treeHash } : {}),
          };
          writeNewRecord(file, record);
          return { acquired: { ...record, scope, state: 'live' }, tickets };
        });
      } catch (error) {
        if (error.code === 'EEXIST') continue;
        if (error.code !== 'ELOCKBUSY') throw error;
        if (deadline === null || BigInt(timeValue(now)) >= deadline) {
          if (queued && waitSeconds !== null) {
            const tickets = readQueueTickets(directory, name);
            let activeRecord = null;
            try {
              const current = readRecord(file, commonDir, scope);
              if (current && lockIsLive(current, { herdr, pidAlive, now, quietHours })) activeRecord = current;
            } catch {}
            throw waitBusyError(name, { activeRecord, tickets, ticket, startedAt, now });
          }
          throw error;
        }
        pause(Math.max(1, Math.min(100, Number(deadline - BigInt(timeValue(now))))));
        continue;
      }
      if (outcome.acquired) {
        if (staleRecord) {
          output(`NOTICE: Taking over stale lock ${name} from pane ${staleRecord.ownerPane} (PID ${staleRecord.pid}).`);
          recordLockRelease(staleRecord, { dataDir, now, takeover: true });
        }
        appendLockLedger(dataDir, 'acquire', outcome.acquired, now, { waitMs: Math.max(0, timeValue(now) - startedAt) });
        output(`Lock ${name} acquired by pane ${outcome.acquired.ownerPane} (PID ${outcome.acquired.pid}).`);
        return outcome.acquired;
      }
      if (outcome.reentrant) {
        appendLockLedger(dataDir, 'acquire', { ...outcome.reentrant, project: config.slug, kind, ownerPane: caller.paneId }, now, { waitMs: 0, reentrant: true });
        return outcome.reentrant;
      }
      if (waitSeconds === null) {
        if (outcome.queueBlocked) throw noWaitBusyError(name, null, outcome.tickets);
        throw noWaitBusyError(name, outcome.activeRecord, outcome.tickets);
      }

      const tickets = outcome.tickets ?? [];
      const ownPosition = ticket ? tickets.findIndex((entry) => entry.id === ticket.id) + 1 : 1;
      const active = outcome.activeRecord;
      const head = tickets[0];
      const holderPane = active?.ownerPane ?? head?.pane ?? 'unknown';
      const holderKind = active?.kind ?? head?.kind ?? 'unknown';
      if (queued) {
        const signature = `${ownPosition}/${tickets.length}`;
        const observedAt = timeValue(now);
        if (signature !== lastNotice && (lastNoticeAt === null || observedAt - lastNoticeAt >= LOCK_WAIT_NOTICE_INTERVAL_MS)) {
          output(`waiting for ${name}, position ${ownPosition} of ${tickets.length}, held by ${holderPane} (${holderKind})`);
          lastNotice = signature;
          lastNoticeAt = observedAt;
        }
      }
      if (deadline !== null && BigInt(timeValue(now)) >= deadline) {
        throw waitBusyError(name, { activeRecord: active, tickets, ticket, startedAt, now });
      }
      pause(Math.max(1, Math.min(100, Number(deadline - BigInt(timeValue(now))))));
    }
  } catch (error) {
    failure = error;
    const failedEvent = error.ledgerEvent ?? (error.code === 'ELOCKBUSY' ? (waitSeconds === null ? 'busy' : 'timeout') : null);
    if (failedEvent) {
      appendLockLedger(dataDir, failedEvent, { name, project: config.slug, kind, ownerPane: caller.paneId }, now, { waitMs: Math.max(0, timeValue(now) - startedAt) });
    }
    throw error;
  } finally {
    if (ticketOutstanding) {
      try {
        withMutationLock(directory, () => removeQueueTicket(directory, ticket));
      } catch (error) {
        if (!failure) throw error;
        output(`Warning: could not remove lock queue ticket ${ticket.id}: ${String(error.message ?? error).replace(/\s+/g, ' ')}.`);
      }
    }
  }
}

export function releaseProjectLock(name, {
  config,
  env = process.env,
  herdr = createHerdrRunner(),
  dataDir = DATA_DIR,
  output = console.log,
  pidAlive = pidIsAlive,
  now = Date.now,
} = {}) {
  validateName(name);
  const caller = callerFor(env, herdr, { name, config });
  const { commonDir, directory, scope } = lockContext(config, dataDir, scopeFor(name));
  const file = path.join(directory, `${name}.json`);
  const quietHours = quietHoursActive(readNight({ dataDir, now: timeValue(now) }));
  return withMutationLock(directory, () => {
    const record = readRecord(file, commonDir, scope);
    if (!record) throw new Error(`Lock ${name} does not exist.`);
    if (reentryTokenMatches(record, env, pidAlive) && lockIsLive(record, { herdr, pidAlive, now, quietHours })) {
      recordLockRelease({ ...record, project: config.slug, ownerPane: caller.paneId }, { dataDir, now, holdMs: null, reentrant: true });
      return { ...record, reentrant: true };
    }
    if (record.ownerPane !== caller.paneId && lockIsLive(record, { herdr, pidAlive, now, quietHours })) {
      throw new Error(`Cannot release active lock ${name} owned by another pane (${record.ownerPane}, PID ${record.pid}).`);
    }
    fs.unlinkSync(file);
    recordLockRelease(record, { dataDir, now });
    output(`Lock ${name} released.`);
    return record;
  });
}

export function listProjectLocks({
  config,
  env = process.env,
  herdr = createHerdrRunner(),
  dataDir = DATA_DIR,
  output = console.log,
  pidAlive = pidIsAlive,
  now = Date.now,
} = {}) {
  callerFor(env, herdr);
  const quietHours = quietHoursActive(readNight({ dataDir, now: timeValue(now) }));
  const machineQueue = readLockQueue({ dataDir, herdr, pidAlive, now });
  const locks = ['repository', 'machine'].flatMap((scope) => {
    const { commonDir, directory } = lockContext(config, dataDir, scope);
    return fs.readdirSync(directory).filter((file) => file.endsWith('.json')).sort().map((fileName) => {
      const record = readRecord(path.join(directory, fileName), commonDir, scope);
      const ageMs = Math.max(0, timeValue(now) - Date.parse(record.acquiredAt));
      const expiresInMs = record.kind === 'manual' && record.expiresAt ? Math.max(0, Date.parse(record.expiresAt) - timeValue(now)) : null;
      return {
        ...record,
        ageMs,
        ageSeconds: Math.floor(ageMs / 1000),
        expiresInMs,
        ...(scope === 'machine' && record.name === FULL_SUITE_LOCK ? { queue: machineQueue } : {}),
        state: lockIsLive(record, { herdr, pidAlive, now, quietHours }) ? 'live' : 'stale',
      };
    });
  });
  if (!locks.length) output('No project locks.');
  for (const lock of locks) {
    const age = formatDuration(lock.ageSeconds);
    const expiry = lock.expiresInMs === null ? '' : `; expires in ${formatDuration(Math.ceil(lock.expiresInMs / 1000))}`;
    output(`${lock.name} (${lock.scope}): held by pane ${lock.ownerPane} (${lock.kind}) for ${age}${expiry}; PID ${lock.pid}, ${lock.state}`);
    if (lock.queue?.length) {
      output(`  Queue: ${lock.queue.map((ticket) => `${ticket.position}. ${ticket.project} ${ticket.pane} (${ticket.kind}) ${formatDuration(ticket.waitSeconds)}`).join(', ')}`);
    }
  }
  return locks;
}

function formatDuration(seconds) {
  const totalMinutes = Math.max(0, Math.floor(seconds / 60));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function readLockQueue({ dataDir = DATA_DIR, livePanes = null, herdr = createHerdrRunner(), pidAlive = pidIsAlive, now = Date.now } = {}) {
  const directory = path.join(dataDir, 'locks', 'machine');
  const tickets = readQueueTickets(directory);
  if (!tickets.length) return [];
  const panes = livePanes ?? paneIds(herdr);
  const live = tickets.filter((ticket) => ticketIsLive(ticket, { livePanes: panes, pidAlive, now }));
  return live.map((ticket, index) => {
    const waitMs = Math.max(0, timeValue(now) - Date.parse(ticket.createdAt));
    return {
      ...ticket,
      position: index + 1,
      waitMs,
      waitSeconds: Math.floor(waitMs / 1000),
    };
  });
}

export function readMachineLocks({ dataDir = DATA_DIR, livePanes = new Set(), pidAlive = pidIsAlive, now = Date.now, night = null } = {}) {
  const quietHours = quietHoursActive(night);
  const directory = path.join(dataDir, 'locks', 'machine');
  let files;
  try { files = fs.readdirSync(directory).filter((file) => file.endsWith('.json')).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return files.map((file) => {
    const record = readRecord(path.join(directory, file), null, 'machine');
    const ageMs = Math.max(0, timeValue(now) - Date.parse(record.acquiredAt));
    return {
      ...record,
      ageMs,
      ageSeconds: Math.floor(ageMs / 1000),
      state: lockIsLive(record, { livePanes, pidAlive, now, quietHours }) ? 'live' : 'stale',
    };
  });
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') return null;
    throw error;
  }
}

// A push runs the full suite when a pre-push hook exists in the effective hooks path, or when a husky or lefthook config names pre-push.
export function findPrePushHook(root) {
  const hookPath = execFileSync('git', ['-C', root, 'rev-parse', '--git-path', 'hooks/pre-push'], { encoding: 'utf8' }).trim();
  const hook = path.resolve(root, hookPath);
  if (fs.existsSync(hook) && fs.statSync(hook).isFile()) return hook;
  const huskyHook = path.join(root, '.husky', 'pre-push');
  if (fs.existsSync(huskyHook) && fs.statSync(huskyHook).isFile()) return huskyHook;
  const packageText = readText(path.join(root, 'package.json'));
  if (packageText) {
    let manifest = null;
    try { manifest = JSON.parse(packageText); } catch {}
    if (manifest?.husky?.hooks?.['pre-push']) return path.join(root, 'package.json');
  }
  for (const name of ['.huskyrc', '.huskyrc.json', '.huskyrc.js', 'husky.config.js',
    'lefthook.yml', 'lefthook.yaml', 'lefthook.json', 'lefthook.toml', '.lefthook.yml', '.lefthook.yaml', '.lefthook.json', '.lefthook.toml',
    'lefthook-local.yml', '.lefthook-local.yml']) {
    const text = readText(path.join(root, name));
    if (text && /(^|[^\w-])pre-push([^\w-]|$)/.test(text)) return path.join(root, name);
  }
  return null;
}

export function pushWithLock(args, {
  config,
  env = process.env,
  herdr = createHerdrRunner(),
  dataDir = DATA_DIR,
  output = console.log,
  now = Date.now,
  pause = defaultPause,
  pidAlive = pidIsAlive,
  stdio = 'inherit',
  rulesFile = DEFAULT_RULES_FILE,
} = {}) {
  callerFor(env, herdr);
  const hook = findPrePushHook(config.root);
  const push = (reuseSuitePass = false, lockToken = null) => {
    const childEnv = { ...process.env, ...env };
    if (reuseSuitePass) childEnv.HERDR_BOSS_SUITE_REUSE = '1';
    if (lockToken) childEnv.HERDR_BOSS_LOCK_TOKEN = lockToken;
    const result = spawnSync('git', ['push', ...args], { cwd: config.root, env: childEnv, stdio });
    if (result.error) throw new Error(`Cannot run git push: ${result.error.message}`);
    return result.status ?? 1;
  };
  if (!hook) {
    output('push: no pre-push hook found. Pushing without a lock.');
    return { exitCode: push(), locked: false, hook: null };
  }
  const swapText = swapGuardFor(rulesFile, { env, herdr, now, override: `Set ${SWAP_FORCE_ENV}=1 to override.` });
  if (swapText) throw new Error(swapText);
  output(`push: pre-push hook found at ${hook}. Taking lock ${FULL_SUITE_LOCK}.`);
  const reentryToken = crypto.randomBytes(32).toString('hex');
  const lock = acquireProjectLock(FULL_SUITE_LOCK, { config, env, herdr, dataDir, waitSeconds: PUSH_LOCK_WAIT_SECONDS, output, now, pause, pidAlive, kind: 'push', reentryToken });
  const childLockToken = lock.reentrant ? env.HERDR_BOSS_LOCK_TOKEN : reentryToken;
  const heldSince = timeValue(now);
  let exitCode;
  try { exitCode = push(true, childLockToken); }
  finally {
    if (lock.reentrant) {
      recordLockRelease({ ...lock, project: config.slug, kind: 'push' }, { dataDir, now, holdMs: Math.max(0, timeValue(now) - heldSince), reentrant: true });
    } else {
      try { releaseProjectLock(FULL_SUITE_LOCK, { config, env, herdr, dataDir, output, pidAlive, now }); }
      catch (error) {
        warnLockReleaseFailure(error, output);
        if (exitCode === 0) exitCode = 1;
      }
    }
  }
  return { exitCode, locked: true, hook };
}
