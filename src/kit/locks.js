import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { DATA_DIR } from '../config.js';
import { POLICY_DEFAULTS } from '../control.js';
import { quietHoursActive, readNight } from '../night.js';
import { readMachineSamples } from '../machine-samples.js';
import { DEFAULT_RULES_FILE, loadProjectConfig } from './config.js';
import { SWAP_FORCE_ENV, swapGuardFor } from './swap-guard.js';
import { createHerdrRunner, verifyCallerPane } from './workers.js';
import { DEFAULT_SUITE_UNTESTED, hookFileHash, hookRunsOnlySuites, reusablePushPass, writePushHookCommands } from './suite-passes.js';
import { chooseLockSlot, classifyLockLane, isLegacyLockEntry, lockAdmissionCapacity, machineGuardReason, readLockDurationPrediction, readLockLaneDurationPredictions } from './lock-lanes.js';
import { workflowPushesBranch } from '../ci-lint.js';
import { readWorkflowFiles } from '../ci-workflows.js';
import { processInfo as defaultProcessInfo } from './process-info.js';

const LOCK_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const COMMAND = (name) => `herdr-boss lock acquire ${name}`;
// A machine lock is shared by all repositories on this machine. Other lock names are per repository.
const MACHINE_LOCKS = new Set(['full-suite']);
export const FULL_SUITE_LOCK = 'full-suite';
const PUSH_LOCK_WAIT_SECONDS = 1800;
export const MUTATION_GUARD_WAIT_MS = 5000;
const MANUAL_LOCK_TTL_MS = 60 * 60 * 1000;
export const LEGACY_TICKET_TTL_MS = 30 * 60 * 1000;
const LOCK_WAIT_NOTICE_INTERVAL_MS = 60 * 1000;
const LOCK_KINDS = new Set(['manual', 'suite', 'push']);
const LOCK_NOTICE_TEXT = 'Your full-suite lock expired after 60 minutes and was released. Use herdr-boss suite -- <command> next time.';
export const LOCK_LEDGER_FILE = 'lock-ledger.jsonl';
const LEDGER_EVENTS = new Set(['acquire', 'release', 'busy', 'timeout']);
const LEDGER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const scopeFor = (name) => (MACHINE_LOCKS.has(name) ? 'machine' : 'repository');
const CI_DOCS_REMINDER = 'ci: this push changes only docs and the CI runs on a main push; use [skip ci] or batch the push.';

function validateName(name) {
  if (typeof name !== 'string' || !LOCK_NAME.test(name)) {
    throw new Error('Lock name must be one path-safe token of 1 to 64 letters, numbers, dots, underscores, or hyphens.');
  }
}

function readGit(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return !result.error && result.status === 0 ? result.stdout.trim() : null;
}

function branchName(ref) {
  if (typeof ref !== 'string' || !ref) return null;
  const value = ref.replace(/^\+/, '').replace(/^refs\/heads\//, '');
  if (value === 'HEAD') return value;
  return value.includes('*') || value.startsWith('-') ? null : value;
}

function pushArguments(args) {
  const values = [];
  const optionsWithValue = new Set(['-o', '--push-option', '--receive-pack', '--exec', '--repo']);
  let options = true;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (options && value === '--') { options = false; continue; }
    if (options && value.startsWith('-')) {
      if (optionsWithValue.has(value)) index += 1;
      continue;
    }
    values.push(value);
  }
  return values;
}

function pushChanges(args, root) {
  if (args.some((value) => ['--all', '--mirror', '--tags', '--delete', '-d', '--prune'].includes(value))) return [];
  const values = pushArguments(args);
  const remote = values[0] ?? null;
  const refspecs = values.slice(1);
  let currentBranch = null;
  let upstream = null;
  const plans = [];
  if (refspecs.length) {
    for (const spec of refspecs) {
      if (spec.startsWith(':')) continue;
      const colon = spec.lastIndexOf(':');
      const source = colon < 0 ? spec : spec.slice(0, colon);
      const destination = colon < 0 ? source : spec.slice(colon + 1);
      const target = branchName(destination || source);
      if (!target || !['main', 'master'].includes(target)) continue;
      let sourceRef = source || 'HEAD';
      if (sourceRef !== 'HEAD' && !sourceRef.startsWith('refs/')) sourceRef = `refs/heads/${sourceRef.replace(/^\+/, '')}`;
      plans.push({ branch: target, sourceRef });
    }
  } else {
    currentBranch = readGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (!currentBranch) return [];
    if (!remote) upstream = readGit(root, ['rev-parse', '--symbolic-full-name', '--verify', '@{u}']);
    const upstreamMatch = upstream && /^refs\/remotes\/[^/]+\/(main|master)$/u.exec(upstream);
    const upstreamBranch = upstreamMatch?.[1] ?? null;
    const target = upstreamBranch || currentBranch;
    if (target && ['main', 'master'].includes(target)) plans.push({ branch: target, sourceRef: 'HEAD' });
  }
  if (!plans.length) return [];

  return plans.flatMap((plan) => {
    let trackingRef = null;
    if (remote && !/[:/]/u.test(remote)) {
      const candidate = `refs/remotes/${remote}/${plan.branch}`;
      if (readGit(root, ['rev-parse', '--verify', '--quiet', candidate])) trackingRef = candidate;
    }
    const upstreamMatch = upstream && /^refs\/remotes\/([^/]+)\/(main|master)$/u.exec(upstream);
    if (!trackingRef && upstreamMatch?.[2] === plan.branch) {
      const upstreamRemote = upstreamMatch[1];
      if (!remote || remote === upstreamRemote) trackingRef = upstream;
    }
    if (!trackingRef) return [];
    const result = spawnSync('git', ['diff', '--name-only', '-z', `${trackingRef}..${plan.sourceRef}`], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.error || result.status !== 0) return [];
    return [{ branch: plan.branch, files: result.stdout.split('\0').filter(Boolean) }];
  });
}

function docsPath(file) {
  return file.endsWith('.md') || file === 'LICENSE' || file.startsWith('docs/') || file.startsWith('.orchestration/');
}

function remindForDocsPush(args, root, output) {
  try {
    const changedSets = pushChanges(args, root).filter(({ branch }) => ['main', 'master'].includes(branch));
    if (!changedSets.length) return;
    const workflows = readWorkflowFiles(root);
    if (changedSets.some(({ branch, files }) => files.length && files.every(docsPath) && workflowPushesBranch(workflows, branch))) {
      output(CI_DOCS_REMINDER);
    }
  } catch { /* A failed local read never stops or changes a push. */ }
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
  const fileName = path.basename(file, '.json');
  const shortSlot = machine ? new RegExp(`^${value?.name}\\.short\\.([1-4])$`).exec(fileName) : null;
  const fileSlot = fileName === value?.name ? 'long' : shortSlot ? Number(shortSlot[1]) : null;
  const slot = value?.slot ?? fileSlot ?? 'long';
  const lane = value?.lane ?? 'long';
  const predictedMs = value?.predictedMs ?? null;
  if (!value || (machine ? value.scope !== 'machine' || typeof value.gitCommonDir !== 'string' : value.gitCommonDir !== commonDir)
    || (machine && !MACHINE_LOCKS.has(value.name)) || typeof value.ownerPane !== 'string'
    || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.name !== 'string'
    || !LOCK_NAME.test(value.name) || fileSlot === null
    || (value.pidStart !== undefined && value.pidStart !== null
      && (typeof value.pidStart !== 'string' || !value.pidStart.trim() || value.pidStart.length > 256))
    || (slot !== 'long' && (!Number.isInteger(slot) || slot < 1 || slot > 4)) || slot !== fileSlot
    || !['long', 'short'].includes(lane) || (predictedMs !== null && (!Number.isFinite(predictedMs) || predictedMs < 0))
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
  return { ...value, kind, lane, slot, predictedMs, legacy: value.lane === undefined, ...(expiresAt ? { expiresAt } : {}), scope };
}

function recordFile(directory, name, slot = 'long') {
  return path.join(directory, slot === 'long' ? `${name}.json` : `${name}.short.${slot}.json`);
}

function lockRecordFiles(directory, name, scope) {
  if (scope !== 'machine') return [recordFile(directory, name)];
  let files;
  try { files = fs.readdirSync(directory); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return files.filter((file) => file === `${name}.json` || new RegExp(`^${name}\\.short\\.[1-4]\\.json$`).test(file))
    .sort((left, right) => left.localeCompare(right))
    .map((file) => path.join(directory, file));
}

function readLockRecords(directory, name, commonDir, scope) {
  return lockRecordFiles(directory, name, scope).map((file) => ({ file, record: readRecord(file, commonDir, scope) }))
    .filter(({ record }) => record !== null);
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

function processStart(processReader, pid) {
  try {
    const start = processReader(pid, { wantStart: true })?.start;
    return typeof start === 'string' && start.trim() ? start.trim().replace(/\s+/g, ' ') : null;
  } catch { return null; }
}

function lockIsLive(record, {
  herdr, livePanes = null, pidAlive = pidIsAlive, processInfo = defaultProcessInfo,
  now = Date.now, quietHours = false,
}) {
  if (record.name === FULL_SUITE_LOCK && record.kind === 'manual' && record.expiresAt
    && Date.parse(record.expiresAt) <= timeValue(now) && !quietHours) return false;
  let alive;
  try { alive = pidAlive(record.pid); }
  catch (error) {
    if (error.code === 'EPERM') alive = true;
    else throw error;
  }
  if (!alive) return false;
  if (record.pidStart) {
    let info = null;
    try { info = processInfo(record.pid, { wantStart: true }); } catch {}
    if (info?.alive === false) return false;
    const currentStart = typeof info?.start === 'string' ? info.start.trim().replace(/\s+/g, ' ') : null;
    if (currentStart && currentStart !== record.pidStart) return false;
  }
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
      && (ticket.pidStart === undefined || ticket.pidStart === null
        || (typeof ticket.pidStart === 'string' && ticket.pidStart.trim() && ticket.pidStart.length <= 256))
      && LOCK_KINDS.has(ticket.kind) && ticket.command === COMMAND(name)
      && (ticket.lane === undefined || ['long', 'short'].includes(ticket.lane))
      && (ticket.predictedMs === undefined || ticket.predictedMs === null || (Number.isFinite(ticket.predictedMs) && ticket.predictedMs >= 0))
      && typeof ticket.createdAt === 'string' && Number.isFinite(Date.parse(ticket.createdAt));
    if (!valid) {
      process.stderr.write(`Warning: skipped the unreadable or invalid lock queue ticket ${path.basename(file)}.\n`);
      continue;
    }
    tickets.push({ ...ticket, lane: ticket.lane ?? 'long', predictedMs: ticket.predictedMs ?? null, legacy: ticket.lane === undefined });
  }
  // Equal sequence numbers keep a stable order by id.
  tickets.sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
  return tickets;
}

function ticketIsLive(ticket, { livePanes, pidAlive = pidIsAlive, processInfo = defaultProcessInfo, now = Date.now }) {
  // Old manual waiters stored a persistent shell PID, so cancellation cannot prove they exited.
  if (ticket.legacy && timeValue(now) - Date.parse(ticket.createdAt) >= LEGACY_TICKET_TTL_MS) return false;
  return lockIsLive({ name: FULL_SUITE_LOCK, ownerPane: ticket.pane, pid: ticket.pid, pidStart: ticket.pidStart, kind: ticket.kind }, {
    livePanes, pidAlive, processInfo, now,
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
    const parsed = Number(value);
    // A truncated legacy sequence recovers from the live FIFO tickets below.
    if (/^\d+$/.test(value) && Number.isSafeInteger(parsed) && parsed >= 0) previous = parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot read lock queue sequence: ${error.message}`);
  }
  const next = Math.max(previous, ...tickets.map((ticket) => ticket.seq)) + 1;
  if (!Number.isSafeInteger(next)) throw new Error('Lock queue sequence is exhausted.');
  const temporary = path.join(queue, `.sequence.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${next}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return next;
}

function createQueueTicket(directory, name, { config, caller, pid, kind, lane = 'long', predictedMs = null, now, processInfo }, tickets) {
  const queue = lockQueueDirectory(directory, name);
  const ticket = {
    id: crypto.randomUUID(),
    seq: nextQueueSequence(queue, tickets),
    pane: caller.paneId,
    project: config.slug,
    pid,
    pidStart: processStart(processInfo, pid),
    kind,
    lane,
    predictedMs,
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
  const head = tickets.find((item) => item.id !== ticket?.id);
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
  if (!first) return Object.assign(new Error(`Lock ${name} is busy.`), { ledgerEvent: 'busy' });
  return Object.assign(new Error(`Lock ${name} is waiting for pane ${first.pane} (${first.kind}); queue length ${queueLength}.`), { ledgerEvent: 'busy' });
}

// Write to a temporary file, then link it to the final name. A reader never sees a partial record,
// and the link fails with EEXIST when the final file exists.
function writeNewRecord(file, record) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`);
    fs.fchmodSync(fd, 0o600);
    fs.closeSync(fd);
    fs.linkSync(temporary, file);
  } catch (error) {
    try { fs.closeSync(fd); } catch {}
    throw error;
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function replaceRecord(file, record) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
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
  // The guard folder leaves the guard name in one rename. A reader never sees a guard without its owner record.
  const trash = path.join(path.dirname(guard), `.mutation.releasing-${crypto.randomUUID()}`);
  try { fs.renameSync(guard, trash); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return; }
  fs.rmSync(trash, { recursive: true, force: true });
}

// A claim or a release that was killed before it removed its folder leaves a folder that starts with .mutation. behind.
// None of these folders holds the guard. The next claim removes the ones that are older than MUTATION_MAX_AGE_MS.
function removeMutationGuardLeftovers(guard) {
  const parent = path.dirname(guard);
  const prefix = `${path.basename(guard)}.`;
  let entries;
  try { entries = fs.readdirSync(parent, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const leftover = path.join(parent, entry.name);
    let ageMs;
    try { ageMs = Date.now() - fs.statSync(leftover).mtimeMs; } catch { continue; }
    if (ageMs <= MUTATION_MAX_AGE_MS) continue;
    try { fs.rmSync(leftover, { recursive: true, force: true }); } catch {}
  }
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

const oneLine = (value) => String(value ?? 'unknown').replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim();

function slowHolderId(record) {
  const hash = crypto.createHash('sha256').update(JSON.stringify([
    record.name, record.slot ?? 'long', record.ownerPane, record.pid, record.pidStart ?? null, record.acquiredAt,
  ])).digest('hex').slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
}

function holderWaitDetails(record, prediction, observedAt, processReader) {
  const ageMs = Math.max(0, observedAt - Date.parse(record.acquiredAt));
  const ageSeconds = Math.floor(ageMs / 1000);
  const age = ageSeconds < 60 ? `${ageSeconds}s` : formatDuration(ageSeconds);
  const duration = prediction?.ms ?? null;
  const endMs = duration === null ? null : Date.parse(record.acquiredAt) + duration;
  const end = endMs === null || !Number.isFinite(endMs) || Math.abs(endMs) > 8.64e15 ? 'unknown' : new Date(endMs).toISOString();
  const slow = duration !== null && ageMs > 2 * duration;
  let state = 'unknown';
  if (slow && processReader) {
    try {
      const info = processReader(record.pid, { wantStart: false, wantState: true });
      if (['alive', 'zombie', 'unknown'].includes(info?.state)) state = info.state;
    } catch { /* An unreadable process table leaves the diagnostic state unknown. */ }
  }
  return {
    text: `${oneLine(record.project)} ${oneLine(record.ownerPane)} (${record.kind}); holder lane ${record.lane ?? 'long'}; started ${record.acquiredAt}; age ${age}; predicted end ${end}${slow ? `; holder is slow; PID ${record.pid}, state ${state}` : ''}`,
    slow,
  };
}

function writeSlowHolderNotice(record, detail, dataDir, now) {
  const id = slowHolderId(record);
  const holder = {
    name: record.name, slot: record.slot, lane: record.lane ?? 'long', project: record.project ?? null,
    ownerPane: record.ownerPane, pid: record.pid, pidStart: record.pidStart ?? null, acquiredAt: record.acquiredAt, kind: record.kind,
  };
  const notice = {
    id, type: 'slow-holder', severity: 'warn', ownerPane: record.ownerPane, holder,
    text: `Lock ${record.name}: holder is slow; ${detail.text}.`,
    createdAt: new Date(timeValue(now)).toISOString(),
  };
  const directory = path.join(dataDir, 'locks', 'machine');
  withMutationLock(directory, () => {
    const current = readRecord(recordFile(directory, record.name, record.slot), '', 'machine');
    if (!current || slowHolderId(current) !== id) return;
    try { writeNewRecord(path.join(lockNoticesDirectory(dataDir), `${id}.json`), notice); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  });
}

function removeDeliveredSlowNotice(record, dataDir) {
  const file = path.join(dataDir, 'locks', 'machine', 'notices', `${slowHolderId(record)}.json`);
  try {
    if (JSON.parse(fs.readFileSync(file, 'utf8')).deliveredAt) fs.unlinkSync(file);
  } catch { /* A failed notice cleanup must not block a lock release or takeover. */ }
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
      || typeof notice.ownerPane !== 'string'
      || (notice.type === 'slow-holder'
        ? !notice.holder || notice.holder.name !== FULL_SUITE_LOCK || notice.holder.ownerPane !== notice.ownerPane
          || !['long', 'short'].includes(notice.holder.lane) || !LOCK_KINDS.has(notice.holder.kind)
          || !Number.isSafeInteger(notice.holder.pid) || notice.holder.pid < 1
          || !Number.isFinite(Date.parse(notice.holder.acquiredAt)) || slowHolderId(notice.holder) !== notice.id
          || typeof notice.text !== 'string' || !notice.text.startsWith(`Lock ${FULL_SUITE_LOCK}: holder is slow; `)
          || /[\r\n]/.test(notice.text)
          || (notice.deliveredAt !== undefined && !Number.isFinite(Date.parse(notice.deliveredAt)))
        : notice.text !== LOCK_NOTICE_TEXT)
      || typeof notice.createdAt !== 'string' || !Number.isFinite(Date.parse(notice.createdAt))) {
      throw new Error(`Lock notice ${path.basename(file)} is invalid.`);
    }
    return notice;
  }).filter((notice) => !notice.deliveredAt);
}

export function removeLockTakeoverNotice(id, { dataDir = DATA_DIR, now = Date.now } = {}) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Lock notice ID is invalid.');
  const file = path.join(dataDir, 'locks', 'machine', 'notices', `${id}.json`);
  try {
    const notice = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (notice.type !== 'slow-holder') { fs.unlinkSync(file); return; }
    const directory = path.join(dataDir, 'locks', 'machine');
    // Mark the successful prompt before cleanup. A busy mutation guard must not make it pending again.
    replaceRecord(file, { ...notice, deliveredAt: new Date(timeValue(now)).toISOString() });
    // Keep the marker while this acquisition exists. Another waiter cannot queue it again.
    const holder = readRecord(recordFile(directory, notice.holder.name, notice.holder.slot), '', 'machine');
    if (!holder || slowHolderId(holder) !== id) fs.unlinkSync(file);
  }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

// The claim builds the guard in a staging folder that already holds the owner record, then renames the folder to the guard name.
// A reader therefore never sees a guard without an owner record, and a killed process leaves no ownerless guard.
// The function returns false when another process holds the guard. A rename onto an existing folder fails, so a claim never takes a live guard.
function claimMutationGuard(guard, ownerText) {
  const staging = `${guard}.staging-${crypto.randomUUID()}`;
  try {
    fs.mkdirSync(staging, { mode: 0o700 });
    fs.writeFileSync(path.join(staging, MUTATION_OWNER_FILE), ownerText, { mode: 0o600 });
    if (fs.existsSync(guard)) return false;
    fs.renameSync(staging, guard);
    return true;
  } catch (error) {
    // macOS and Linux name the error of a rename onto an existing folder EEXIST, ENOTEMPTY, or ENOTDIR.
    if (error.code === 'EEXIST' || error.code === 'ENOTEMPTY' || error.code === 'ENOTDIR') return false;
    throw error;
  } finally {
    // The rename already moved the staging folder. This line only removes it after a failure or a killed claim.
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
  }
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
    const claimText = `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`;
    if (claimMutationGuard(guard, claimText)) {
      let claimedStat = null;
      try {
        claimedStat = fs.statSync(guard);
        fs.chmodSync(guard, 0o700);
        ownerStat = fs.statSync(guard);
        ownerText = claimText;
        break;
      } catch (error) {
        if (claimedStat) { try { cleanupOwnedMutationGuard(guard, claimedStat); } catch {} }
        throw error;
      }
    }
    const observed = mutationGuardSnapshot(guard);
    if (removeStaleMutationGuard(guard, observed, onStale)) {
      removeMutationGuardLeftovers(guard);
      continue;
    }
    if (Date.now() >= deadline) {
      const busy = new Error(busyMessage);
      busy.code = 'ELOCKBUSY';
      throw busy;
    }
    removeMutationGuardLeftovers(guard);
    sleep(50);
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
    lane: record.lane ?? 'long',
    predictedMs: record.predictedMs ?? null,
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
// A reused push took no lock. Its lines count in reusedPushes only.
// Hold medians also skip takeover lines. Wait medians skip failed acquires (busy, timeout); they are counted separately.
export function lockLedgerStats(lines) {
  const reused = lines.filter((line) => line.reused);
  lines = lines.filter((line) => !line.reused);
  const own = lines.filter((line) => !line.reentrant);
  const waits = own.filter((line) => line.event === 'acquire' && Number.isFinite(line.waitMs)).map((line) => line.waitMs);
  const holds = own.filter((line) => line.event === 'release' && !line.takeover && Number.isFinite(line.holdMs)).map((line) => line.holdMs);
  const byLane = Object.fromEntries(['long', 'short'].map((lane) => {
    const laneLines = lines.filter((line) => (line.lane ?? 'long') === lane);
    const laneWaits = laneLines.filter((line) => line.event === 'acquire' && !line.reentrant && Number.isFinite(line.waitMs)).map((line) => line.waitMs);
    return [lane, {
      acquires: laneLines.filter((line) => line.event === 'acquire').length,
      timeouts: laneLines.filter((line) => line.event === 'timeout').length,
      medianWaitMs: median(laneWaits),
    }];
  }));
  return {
    acquires: lines.filter((line) => line.event === 'acquire').length,
    reusedPushes: reused.filter((line) => line.event === 'acquire').length,
    busy: lines.filter((line) => line.event === 'busy').length,
    timeouts: lines.filter((line) => line.event === 'timeout').length,
    takeovers: lines.filter((line) => line.event === 'release' && line.takeover).length,
    reentrantAcquires: lines.filter((line) => line.event === 'acquire' && line.reentrant).length,
    releases: holds.length,
    medianWaitMs: median(waits),
    medianHoldMs: median(holds),
    byLane,
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
const ticketLane = (ticket, slots) => (slots < 2 || ticket?.lane !== 'short' ? 'long' : 'short');
export function lockLaneSettings(dataDir, { requireComplete = false } = {}) {
  let policy = {};
  try { policy = JSON.parse(fs.readFileSync(path.join(dataDir, 'policy.json'), 'utf8')); }
  catch (error) {
    if (requireComplete) return null;
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const saved = policy?.locks && typeof policy.locks === 'object' && !Array.isArray(policy.locks) ? policy.locks : {};
  const guard = saved.guard && typeof saved.guard === 'object' && !Array.isArray(saved.guard) ? saved.guard : {};
  const validNumber = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
  if (requireComplete && (!validNumber(saved.slots, 1, 4) || !validNumber(saved.shortLimitMinutes, 1, 60)
    || typeof guard.enabled !== 'boolean' || !validNumber(guard.maxLoadPercent, 0, 1000)
    || !validNumber(guard.maxSwapPercent, 0, 100) || !validNumber(guard.minFreeMemPercent, 0, 100))) return null;
  const defaults = POLICY_DEFAULTS.locks;
  return {
    slots: Number.isInteger(saved.slots) && saved.slots >= 1 && saved.slots <= 4 ? saved.slots : defaults.slots,
    shortLimitMinutes: Number.isInteger(saved.shortLimitMinutes) && saved.shortLimitMinutes >= 1 && saved.shortLimitMinutes <= 60
      ? saved.shortLimitMinutes : defaults.shortLimitMinutes,
    guard: {
      enabled: typeof guard.enabled === 'boolean' ? guard.enabled : defaults.guard.enabled,
      maxLoadPercent: Number.isInteger(guard.maxLoadPercent) && guard.maxLoadPercent >= 0 && guard.maxLoadPercent <= 1000
        ? guard.maxLoadPercent : defaults.guard.maxLoadPercent,
      maxSwapPercent: Number.isInteger(guard.maxSwapPercent) && guard.maxSwapPercent >= 0 && guard.maxSwapPercent <= 100
        ? guard.maxSwapPercent : defaults.guard.maxSwapPercent,
      minFreeMemPercent: Number.isInteger(guard.minFreeMemPercent) && guard.minFreeMemPercent >= 0 && guard.minFreeMemPercent <= 100
        ? guard.minFreeMemPercent : defaults.guard.minFreeMemPercent,
    },
  };
}

function lockPolicyUnavailableReason(dataDir) {
  try { JSON.parse(fs.readFileSync(path.join(dataDir, 'policy.json'), 'utf8')); }
  catch { return 'policy file is unreadable'; }
  return 'lock lane is unknown';
}

function latestMachineSample(dataDir, now) {
  const nowMs = timeValue(now);
  return readMachineSamples({ dataDir }).reduce((latest, sample) => {
    const at = Date.parse(sample.at);
    if (Number.isFinite(at) && at <= nowMs && (!latest || at > Date.parse(latest.at))) return sample;
    return latest;
  }, null);
}

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
  processInfo = defaultProcessInfo,
  kind = 'manual',
  reentryToken = null,
  lockSettings = null,
  readMachineSample = null,
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
  const queued = scope === 'machine';
  let settings = lockSettings ?? lockLaneSettings(dataDir);
  let slots = queued && Number.isInteger(settings?.slots) && settings.slots >= 1 && settings.slots <= 4
    ? settings.slots : queued ? POLICY_DEFAULTS.locks.slots : 1;
  const shortLimitMinutes = Number.isInteger(settings?.shortLimitMinutes) && settings.shortLimitMinutes >= 1 && settings.shortLimitMinutes <= 60
    ? settings.shortLimitMinutes : POLICY_DEFAULTS.locks.shortLimitMinutes;
  const prediction = queued ? readLockDurationPrediction({ dataDir, project: config.slug, kind, name, now }) : { ms: null, samples: 0 };
  // Keep the prediction and classification fixed for this ticket. Capacity can temporarily collapse the lanes.
  const classifiedLane = queued ? classifyLockLane(prediction, shortLimitMinutes).lane : 'long';
  let lane = slots > 1 ? classifiedLane : 'long';
  const predictedMs = queued ? prediction.ms : null;
  const startedAt = timeValue(now);
  const deadline = waitSeconds === null ? null : BigInt(timeValue(now)) + BigInt(waitSeconds) * 1000n;
  let ticket = null;
  let ticketOutstanding = false;
  let lastNoticeAt = null;
  let failure = null;
  let firstAttempt = true;
  try {
    for (;;) {
      let staleRecords = [];
      let outcome;
      let quietHours = false;
      try {
        outcome = withMutationLock(directory, () => {
          staleRecords = [];
          // Startup alone may use legacy defaults. A degraded reload keeps the last policy and waits.
          const reloaded = firstAttempt || lockSettings || !queued ? settings : lockLaneSettings(dataDir, { requireComplete: true });
          firstAttempt = false;
          const policyUnavailable = reloaded === null ? lockPolicyUnavailableReason(dataDir) : null;
          if (reloaded !== null) settings = reloaded;
          const configuredSlots = queued ? settings.slots : 1;
          let tickets = [];
          let livePanes = null;
          if (queued) {
            const queue = lockQueueDirectory(directory, name);
            tickets = readQueueTickets(directory, name);
            livePanes = paneIds(herdr);
            const live = [];
            for (const entry of tickets) {
              if (ticketIsLive(entry, { livePanes, pidAlive, processInfo, now })) live.push(entry);
              else removeQueueTicket(directory, entry);
            }
            tickets = live;
            if (!fs.statSync(queue).isDirectory()) throw new Error('The lock queue is not a directory.');
          }

          quietHours = quietHoursActive(readNight({ dataDir, now: timeValue(now) }));
          const records = readLockRecords(directory, name, commonDir, scope);
          const liveRecords = [];
          for (const entry of records) {
            const record = entry.record;
            if (lockIsLive(record, { herdr, livePanes, pidAlive, processInfo, now, quietHours })) {
              liveRecords.push(record);
              if (quietHours && name === FULL_SUITE_LOCK && record.kind === 'manual' && record.expiresAt
                && Date.parse(record.expiresAt) <= timeValue(now)) {
                logQuietHoursHold(dataDir, now, 'manual full-suite lock expiry', { pane: record.ownerPane });
              }
              continue;
            }
            staleRecords.push(record);
            if (name === FULL_SUITE_LOCK && record.kind === 'manual' && record.expiresAt
              && Date.parse(record.expiresAt) <= timeValue(now)) writeManualExpiryNotice(record, dataDir, now);
            removeDeliveredSlowNotice(record, dataDir);
            fs.unlinkSync(entry.file);
          }
          // Check every live slot before making a ticket. A suite hook re-enters the push's lane.
          const reentrant = liveRecords.find((record) => reentryTokenMatches(record, env, pidAlive));
          if (reentrant) return { reentrant: { ...reentrant, reentrant: true }, tickets };

          if (queued && waitSeconds !== null && !ticket) {
            ticket = createQueueTicket(directory, name, {
              config, caller, pid: process.pid, kind, lane: classifiedLane, predictedMs, now, processInfo,
            }, tickets);
            ticketOutstanding = true;
            tickets.push(ticket);
            tickets.sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
          }

          slots = lockAdmissionCapacity(configuredSlots, liveRecords, tickets);
          lane = slots > 1 ? classifiedLane : 'long';
          const choice = chooseLockSlot({
            lane, slots, holders: liveRecords, tickets, ticketId: ticket?.id ?? null,
          });
          const laneTickets = tickets.filter((entry) => ticketLane(entry, slots) === lane);
          if (!choice || policyUnavailable) {
            const activeRecord = liveRecords.find((record) => record.slot === 'long') ?? liveRecords[0] ?? null;
            return { activeRecord, holders: liveRecords, queueLength: tickets.length, tickets: laneTickets, ...(policyUnavailable ? { policyUnavailable } : {}) };
          }

          const guard = settings?.guard ?? POLICY_DEFAULTS.locks.guard;
          const longHolder = liveRecords.find((record) => record.lane !== 'short');
          if (lane === 'short' && longHolder && guard.enabled !== false) {
            const sample = typeof readMachineSample === 'function' ? readMachineSample() : latestMachineSample(dataDir, now);
            const guardReason = machineGuardReason(sample, guard, { now });
            if (guardReason) return { activeRecord: longHolder, holders: liveRecords, queueLength: tickets.length, tickets: laneTickets, guardReason };
          }

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
            pidStart: processStart(processInfo, pid),
            kind,
            lane,
            slot: choice.slot,
            predictedMs,
            command: COMMAND(name),
            acquiredAt,
            ...(scope === 'machine' && kind === 'manual' ? { expiresAt: new Date(Date.parse(acquiredAt) + MANUAL_LOCK_TTL_MS).toISOString() } : {}),
            ...(reentryToken !== null ? { reentryToken } : {}),
            ...(scope === 'machine' ? { scope } : {}),
            ...(treeHash ? { tree: treeHash } : {}),
          };
          writeNewRecord(recordFile(directory, name, choice.slot), record);
          return { acquired: { ...record, scope, state: 'live' }, tickets: laneTickets };
        });
      } catch (error) {
        if (error.code === 'EEXIST') {
          if (ticket && !ticketOutstanding) ticket = null;
          continue;
        }
        if (error.code !== 'ELOCKBUSY') throw error;
        if (deadline === null || BigInt(timeValue(now)) >= deadline) {
          if (queued && waitSeconds !== null) {
            const tickets = readQueueTickets(directory, name).filter((entry) => ticketLane(entry, slots) === lane);
            let activeRecord = null;
            try {
              const livePanes = paneIds(herdr);
              activeRecord = readLockRecords(directory, name, commonDir, scope).map(({ record }) => record)
                .find((record) => lockIsLive(record, { herdr, livePanes, pidAlive, processInfo, now, quietHours })) ?? null;
            } catch {}
            throw waitBusyError(name, { activeRecord, tickets, ticket, startedAt, now });
          }
          throw error;
        }
        pause(Math.max(1, Math.min(100, Number(deadline - BigInt(timeValue(now))))));
        continue;
      }
      for (const staleRecord of staleRecords) {
        output(`NOTICE: Taking over stale lock ${name} from pane ${staleRecord.ownerPane} (PID ${staleRecord.pid}).`);
        recordLockRelease(staleRecord, { dataDir, now, takeover: true });
      }
      if (outcome.acquired) {
        appendLockLedger(dataDir, 'acquire', outcome.acquired, now, { waitMs: Math.max(0, timeValue(now) - startedAt) });
        const laneDescription = queued ? ` in ${lane} lane (slot ${outcome.acquired.slot})` : '';
        output(`Lock ${name} acquired by pane ${outcome.acquired.ownerPane} (PID ${outcome.acquired.pid})${laneDescription}.`);
        return outcome.acquired;
      }
      if (outcome.reentrant) {
        appendLockLedger(dataDir, 'acquire', { ...outcome.reentrant, project: config.slug, kind, ownerPane: caller.paneId }, now, { waitMs: 0, reentrant: true });
        return outcome.reentrant;
      }
      if (waitSeconds === null) {
        throw noWaitBusyError(name, outcome.activeRecord, outcome.tickets);
      }

      const tickets = outcome.tickets ?? [];
      const ownPosition = ticket ? tickets.findIndex((entry) => entry.id === ticket.id) + 1 : 1;
      const active = outcome.activeRecord;
      const head = tickets.find((entry) => entry.id !== ticket?.id);
      if (queued) {
        const observedAt = timeValue(now);
        if (lastNoticeAt === null || observedAt - lastNoticeAt >= LOCK_WAIT_NOTICE_INTERVAL_MS) {
          let predictions = {};
          try { predictions = readLockLaneDurationPredictions({ dataDir, name, now: observedAt }); }
          catch { /* Unreadable history gives an unknown end, never a guessed time. */ }
          const holders = outcome.holders ?? (active ? [active] : []);
          const details = holders.map((record) => {
            const prediction = predictions[record.lane ?? 'long'];
            const detail = holderWaitDetails(record, prediction, observedAt, processInfo);
            if (detail.slow) {
              try { writeSlowHolderNotice(record, detail, dataDir, now); }
              catch { detail.text += '; Boss notice could not be queued'; }
            }
            return detail.text;
          });
          const held = details.length ? `held by ${details.join(' | ')}` : 'no active holder';
          const behind = !details.length && head ? `; waiting behind ${oneLine(head.project)} ${oneLine(head.pane)}` : '';
          const reason = outcome.guardReason ? `; short lane paused: ${outcome.guardReason}`
            : outcome.policyUnavailable ? `; ${outcome.policyUnavailable}; admission waits for a complete lock policy` : '';
          output(`waiting for ${name}, lane ${lane}, position ${ownPosition} of ${tickets.length}, ${held}; queue length ${outcome.queueLength ?? tickets.length} (${tickets.length} in lane)${behind}${reason}`);
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
      appendLockLedger(dataDir, failedEvent, { name, project: config.slug, kind, ownerPane: caller.paneId, lane, predictedMs }, now, { waitMs: Math.max(0, timeValue(now) - startedAt) });
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
  processInfo = defaultProcessInfo,
  now = Date.now,
  slot = null,
  expectedRecord = null,
} = {}) {
  validateName(name);
  if (slot !== null && slot !== 'long' && (!Number.isInteger(slot) || slot < 1 || slot > 4)) {
    throw new Error('--slot must be long or an integer from 1 to 4.');
  }
  const caller = callerFor(env, herdr, { name, config });
  const { commonDir, directory, scope } = lockContext(config, dataDir, scopeFor(name));
  const quietHours = quietHoursActive(readNight({ dataDir, now: timeValue(now) }));
  return withMutationLock(directory, () => {
    const entries = readLockRecords(directory, name, commonDir, scope);
    if (!entries.length) throw new Error(`Lock ${name} does not exist.`);
    const reentrant = entries.find(({ record }) => (slot === null || record.slot === slot)
      && reentryTokenMatches(record, env, pidAlive)
      && lockIsLive(record, { herdr, pidAlive, processInfo, now, quietHours }));
    if (reentrant && !expectedRecord) {
      const { record } = reentrant;
      recordLockRelease({ ...record, project: config.slug, ownerPane: caller.paneId }, { dataDir, now, holdMs: null, reentrant: true });
      return { ...record, reentrant: true };
    }
    const samePane = entries.filter(({ record }) => record.ownerPane === caller.paneId);
    let owned;
    if (expectedRecord) {
      // Automatic cleanup must never release a replacement record or another job in this pane.
      owned = samePane.find(({ record }) => record.slot === expectedRecord.slot
        && record.pid === expectedRecord.pid && record.acquiredAt === expectedRecord.acquiredAt);
      if (!owned) throw new Error(`The acquired lock ${name} no longer exists. Refusing to release another record.`);
    } else if (slot !== null) {
      owned = samePane.find(({ record }) => record.slot === slot);
      if (!owned) {
        const selected = entries.find(({ record }) => record.slot === slot);
        if (selected && !lockIsLive(selected.record, { herdr, pidAlive, processInfo, now, quietHours })) owned = selected;
        else throw new Error(`Cannot release lock ${name} slot ${slot}: no matching record belongs to this pane.`);
      }
    } else {
      const liveOwned = samePane.filter(({ record }) => lockIsLive(record, { herdr, pidAlive, processInfo, now, quietHours }));
      if (liveOwned.length > 1) throw new Error(`Several live records of lock ${name} belong to this pane. Use --slot long or --slot N.`);
      owned = liveOwned[0] ?? samePane[0];
      if (!owned) {
        const live = entries.find(({ record }) => lockIsLive(record, { herdr, pidAlive, processInfo, now, quietHours }));
        if (live) throw new Error(`Cannot release active lock ${name} owned by another pane (${live.record.ownerPane}, PID ${live.record.pid}).`);
        owned = entries[0];
      }
    }
    fs.unlinkSync(owned.file);
    removeDeliveredSlowNotice(owned.record, dataDir);
    recordLockRelease(owned.record, { dataDir, now });
    output(`Lock ${name} released.`);
    return owned.record;
  });
}

export function listProjectLocks({
  config,
  env = process.env,
  herdr = createHerdrRunner(),
  dataDir = DATA_DIR,
  output = console.log,
  pidAlive = pidIsAlive,
  processInfo = defaultProcessInfo,
  now = Date.now,
} = {}) {
  callerFor(env, herdr);
  const quietHours = quietHoursActive(readNight({ dataDir, now: timeValue(now) }));
  const livePanes = paneIds(herdr);
  const machineQueue = readLockQueue({ dataDir, livePanes, pidAlive, processInfo, now });
  const repository = (() => {
    const { commonDir, directory } = lockContext(config, dataDir, 'repository');
    return fs.readdirSync(directory).filter((file) => file.endsWith('.json')).sort().map((fileName) => {
      const record = readRecord(path.join(directory, fileName), commonDir, 'repository');
      const ageMs = Math.max(0, timeValue(now) - Date.parse(record.acquiredAt));
      const expiresInMs = record.kind === 'manual' && record.expiresAt ? Math.max(0, Date.parse(record.expiresAt) - timeValue(now)) : null;
      return {
        ...record,
        ageMs,
        ageSeconds: Math.floor(ageMs / 1000),
        expiresInMs,
        slotLimit: 1,
        slotsInUse: lockIsLive(record, { herdr, livePanes, pidAlive, processInfo, now, quietHours }) ? 1 : 0,
        state: lockIsLive(record, { herdr, livePanes, pidAlive, processInfo, now, quietHours }) ? 'live' : 'stale',
      };
    });
  })();
  const machine = readMachineLocks({ dataDir, livePanes, pidAlive, processInfo, now, night: readNight({ dataDir, now: timeValue(now) }) })
    .map((record) => ({ ...record, ...(record.name === FULL_SUITE_LOCK ? { queue: machineQueue } : {}) }));
  const locks = [...repository, ...machine];
  if (!locks.length) output('No project locks.');
  for (const lock of locks) {
    const age = formatDuration(lock.ageSeconds);
    const expiry = lock.expiresInMs === null ? '' : `; expires in ${formatDuration(Math.ceil(lock.expiresInMs / 1000))}`;
    const predicted = lock.predictedMs === null ? 'unknown' : formatDuration(Math.ceil(lock.predictedMs / 1000));
    const slot = typeof lock.slot === 'number' ? `short slot ${lock.slot}` : 'long slot';
    output(`${lock.name} (${lock.scope}): held by pane ${lock.ownerPane} (${lock.kind}) for ${age}${expiry}; PID ${lock.pid}, ${lock.state}; lane ${lock.lane}, ${slot}, ${lock.slotsInUse} of ${lock.slotLimit} slots in use, predicted ${predicted}`);
    if (lock.queue?.length) {
      output(`  Queue: ${lock.queue.map((ticket) => `${ticket.position}. ${ticket.project} ${ticket.pane} (${ticket.kind}) ${ticket.lane} lane, predicted ${ticket.predictedMs === null ? 'unknown' : formatDuration(Math.ceil(ticket.predictedMs / 1000))}, ${ticket.slotsInUse} of ${ticket.slotLimit} slots in use, waiting ${formatDuration(ticket.waitSeconds)}`).join(', ')}`);
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

export function readLockQueue({
  dataDir = DATA_DIR, livePanes = null, herdr = createHerdrRunner(), pidAlive = pidIsAlive,
  processInfo = defaultProcessInfo, now = Date.now,
} = {}) {
  const directory = path.join(dataDir, 'locks', 'machine');
  const tickets = readQueueTickets(directory);
  if (!tickets.length) return [];
  const panes = livePanes ?? paneIds(herdr);
  const live = tickets.filter((ticket) => ticketIsLive(ticket, { livePanes: panes, pidAlive, processInfo, now }));
  const settings = lockLaneSettings(dataDir);
  const configuredSlotLimit = settings.slots;
  const holders = readMachineLocks({ dataDir, livePanes: panes, pidAlive, processInfo, now }).filter((record) => record.name === FULL_SUITE_LOCK && record.state === 'live');
  const slots = lockAdmissionCapacity(configuredSlotLimit, holders, live);
  const admissionMode = [...holders, ...live].some(isLegacyLockEntry) ? 'legacy-exclusive' : slots === 1 ? 'exclusive' : 'lanes';
  const lanes = new Map();
  return live.map((ticket) => {
    const lane = ticketLane(ticket, slots);
    const position = (lanes.get(lane) ?? 0) + 1;
    lanes.set(lane, position);
    const waitMs = Math.max(0, timeValue(now) - Date.parse(ticket.createdAt));
    return {
      ...ticket,
      lane,
      position,
      waitMs,
      waitSeconds: Math.floor(waitMs / 1000),
      slotsInUse: holders.length,
      slotLimit: slots,
      configuredSlotLimit,
      admissionMode,
    };
  });
}

export function readMachineLocks({
  dataDir = DATA_DIR, livePanes = new Set(), pidAlive = pidIsAlive,
  processInfo = defaultProcessInfo, now = Date.now, night = null,
} = {}) {
  const quietHours = quietHoursActive(night);
  const directory = path.join(dataDir, 'locks', 'machine');
  let files;
  try { files = fs.readdirSync(directory).filter((file) => file.endsWith('.json')).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const settings = lockLaneSettings(dataDir);
  const configuredSlotLimit = settings.slots;
  const tickets = readQueueTickets(directory).filter((ticket) => ticketIsLive(ticket, { livePanes, pidAlive, processInfo, now }));
  const records = files.map((file) => {
    const record = readRecord(path.join(directory, file), null, 'machine');
    const ageMs = Math.max(0, timeValue(now) - Date.parse(record.acquiredAt));
    const expiresInMs = record.kind === 'manual' && record.expiresAt ? Math.max(0, Date.parse(record.expiresAt) - timeValue(now)) : null;
    return {
      ...record,
      ageMs,
      ageSeconds: Math.floor(ageMs / 1000),
      expiresInMs,
      state: lockIsLive(record, { livePanes, pidAlive, processInfo, now, quietHours }) ? 'live' : 'stale',
    };
  });
  return records.map((record) => {
    const sameLock = records.filter((other) => other.name === record.name && other.state === 'live');
    const slotLimit = lockAdmissionCapacity(configuredSlotLimit, sameLock, tickets);
    return {
      ...record,
      slotsInUse: sameLock.length,
      slotLimit,
      configuredSlotLimit,
      admissionMode: [...sameLock, ...tickets].some(isLegacyLockEntry) ? 'legacy-exclusive' : slotLimit === 1 ? 'exclusive' : 'lanes',
      laneSlotsInUse: {
        long: sameLock.filter((holder) => holder.slot === 'long').length,
        short: sameLock.filter((holder) => holder.slot !== 'long').length,
      },
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

// A push that reuses a suite pass takes no lock. The ledger still gets a push line pair, marked reused, with no wait and no hold.
function recordReusedPush({ config, caller, tree }, { dataDir, now, run }) {
  const record = { name: FULL_SUITE_LOCK, project: config.slug, kind: 'push', ownerPane: caller.paneId, tree };
  appendLockLedger(dataDir, 'acquire', record, now, { waitMs: 0, reused: true });
  const startedAt = timeValue(now);
  let exitCode;
  try { exitCode = run(); }
  finally { appendLockLedger(dataDir, 'release', record, now, { holdMs: 0, reused: true, runMs: Math.max(0, timeValue(now) - startedAt) }); }
  return exitCode;
}

function readHookSuites(file) {
  try {
    const seen = new Map();
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      let command;
      try { command = JSON.parse(line); } catch { continue; }
      if (Array.isArray(command) && command.length && command.every((part) => typeof part === 'string')) seen.set(line, command);
    }
    return [...seen.values()];
  } catch {
    return [];
  }
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
  processInfo = defaultProcessInfo,
  stdio = 'inherit',
  rulesFile = DEFAULT_RULES_FILE,
} = {}) {
  const caller = callerFor(env, herdr);
  const hook = findPrePushHook(config.root);
  const push = (reuseSuitePass = false, lockToken = null, suitesFile = null) => {
    remindForDocsPush(args, config.root, output);
    const childEnv = { ...process.env, ...env };
    if (reuseSuitePass) childEnv.HERDR_BOSS_SUITE_REUSE = '1';
    if (lockToken) childEnv.HERDR_BOSS_LOCK_TOKEN = lockToken;
    if (suitesFile) childEnv.HERDR_BOSS_PUSH_SUITES = suitesFile;
    const result = spawnSync('git', ['push', ...args], { cwd: config.root, env: childEnv, stdio });
    if (result.error) throw new Error(`Cannot run git push: ${result.error.message}`);
    return result.status ?? 1;
  };
  if (!hook) {
    output('push: no pre-push hook found. Pushing without a lock.');
    return { exitCode: push(), locked: false, hook: null };
  }
  const pass = reusablePushPass(config.root, { dataDir, hookFile: hook, untested: config.suiteUntested ?? DEFAULT_SUITE_UNTESTED });
  if (pass) {
    output(`push: a suite pass exists for tree ${pass.key.tree.slice(0, 12)}. Pushing without the full-suite lock.`);
    const exitCode = recordReusedPush({ config, caller, tree: pass.key.tree }, { dataDir, now, run: () => push(true) });
    return { exitCode, locked: false, reused: true, hook };
  }
  const swapText = swapGuardFor(rulesFile, { env, herdr, now, override: `Set ${SWAP_FORCE_ENV}=1 to override.` });
  if (swapText) throw new Error(swapText);
  output(`push: pre-push hook found at ${hook}. Taking lock ${FULL_SUITE_LOCK}.`);
  const reentryToken = crypto.randomBytes(32).toString('hex');
  const lock = acquireProjectLock(FULL_SUITE_LOCK, {
    config, env, herdr, dataDir, waitSeconds: PUSH_LOCK_WAIT_SECONDS, output, now, pause,
    pidAlive, processInfo, kind: 'push', reentryToken,
  });
  const childLockToken = lock.reentrant ? env.HERDR_BOSS_LOCK_TOKEN : reentryToken;
  const suitesFile = path.join(dataDir, `.push-suites.${process.pid}.${crypto.randomUUID()}.jsonl`);
  const heldSince = timeValue(now);
  let exitCode;
  try { exitCode = push(true, childLockToken, suitesFile); }
  finally {
    // The suite commands of this hook run tell the next push which passes to look for.
    try {
      writePushHookCommands(dataDir, gitCommonDir(config.root), hookFileHash(hook), hookRunsOnlySuites(hook) ? readHookSuites(suitesFile) : [], new Date(timeValue(now)).toISOString());
    } catch {}
    try { fs.unlinkSync(suitesFile); } catch {}
    if (lock.reentrant) {
      recordLockRelease({ ...lock, project: config.slug, kind: 'push' }, { dataDir, now, holdMs: Math.max(0, timeValue(now) - heldSince), reentrant: true });
    } else {
      try { releaseProjectLock(FULL_SUITE_LOCK, { config, env, herdr, dataDir, output, pidAlive, processInfo, now, expectedRecord: lock }); }
      catch (error) {
        warnLockReleaseFailure(error, output);
        if (exitCode === 0) exitCode = 1;
      }
    }
  }
  return { exitCode, locked: true, hook };
}
