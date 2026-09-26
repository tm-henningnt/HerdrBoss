import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DATA_DIR } from '../config.js';
import { createHerdrRunner, verifyCallerPane } from './workers.js';

const LOCK_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const COMMAND = (name) => `herdr-boss lock acquire ${name}`;

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

function lockDirectory(commonDir, dataDir) {
  const locksRoot = path.join(dataDir, 'locks');
  fs.mkdirSync(locksRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(locksRoot, 0o700);
  const key = crypto.createHash('sha256').update(commonDir).digest('hex');
  const directory = path.join(locksRoot, key);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  return directory;
}

function readRecord(file, commonDir) {
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot read lock record ${path.basename(file)}: ${error.message}`);
  }
  if (!value || value.gitCommonDir !== commonDir || typeof value.ownerPane !== 'string'
    || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.name !== 'string'
    || !LOCK_NAME.test(value.name) || value.name !== path.basename(file, '.json')
    || value.command !== COMMAND(value.name) || typeof value.acquiredAt !== 'string'
    || !Number.isFinite(Date.parse(value.acquiredAt))) {
    throw new Error(`Lock record ${path.basename(file)} is invalid. Refusing to change it.`);
  }
  return value;
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

function lockIsLive(record, { herdr, pidAlive = pidIsAlive }) {
  let alive;
  try { alive = pidAlive(record.pid); }
  catch (error) {
    if (error.code === 'EPERM') alive = true;
    else throw error;
  }
  if (!alive) return false;
  return paneIds(herdr).has(record.ownerPane);
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

function withMutationLock(directory, operation) {
  const guard = path.join(directory, '.mutation');
  let created = false;
  try {
    fs.mkdirSync(guard, { mode: 0o700 });
    created = true;
    fs.chmodSync(guard, 0o700);
  } catch (error) {
    if (created) {
      try { fs.rmdirSync(guard); } catch {}
    }
    if (error.code === 'EEXIST') {
      const busy = new Error('A project lock operation is already in progress. Retry when it finishes.');
      busy.code = 'ELOCKBUSY';
      throw busy;
    }
    throw error;
  }
  try { return operation(); }
  finally { fs.rmdirSync(guard); }
}

function lockContext(config, dataDir) {
  const commonDir = gitCommonDir(config.root);
  const directory = lockDirectory(commonDir, dataDir);
  return { commonDir, directory };
}

function callerFor(env, herdr) {
  return verifyCallerPane(env, herdr, null);
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

function defaultPause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
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
} = {}) {
  validateName(name);
  if (waitSeconds !== null && (!Number.isSafeInteger(waitSeconds) || waitSeconds < 0)) {
    throw new Error('--wait must be a whole non-negative number of seconds.');
  }
  const caller = callerFor(env, herdr);
  const pid = shellPidFor(caller.paneId, herdr);
  const { commonDir, directory } = lockContext(config, dataDir);
  const file = path.join(directory, `${name}.json`);
  const deadline = waitSeconds === null ? null : BigInt(timeValue(now)) + BigInt(waitSeconds) * 1000n;

  for (;;) {
    let activeRecord = null;
    let staleRecord = null;
    try {
      const acquired = withMutationLock(directory, () => {
        const previous = readRecord(file, commonDir);
        if (previous && lockIsLive(previous, { herdr, pidAlive })) {
          activeRecord = previous;
          return null;
        }
        if (previous) {
          staleRecord = previous;
          fs.unlinkSync(file);
        }
        const record = {
          name,
          project: config.slug,
          gitCommonDir: commonDir,
          ownerPane: caller.paneId,
          pid,
          command: COMMAND(name),
          acquiredAt: new Date(timeValue(now)).toISOString(),
        };
        writeNewRecord(file, record);
        return { ...record, state: 'live' };
      });
      if (acquired) {
        if (staleRecord) output(`NOTICE: Taking over stale lock ${name} from pane ${staleRecord.ownerPane} (PID ${staleRecord.pid}).`);
        output(`Lock ${name} acquired by pane ${acquired.ownerPane} (PID ${acquired.pid}).`);
        return acquired;
      }
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      if (error.code !== 'ELOCKBUSY') throw error;
      if (deadline === null || BigInt(timeValue(now)) >= deadline) throw error;
      pause(Math.max(1, Math.min(100, Number(deadline - BigInt(timeValue(now))))));
      continue;
    }
    if (activeRecord) {
      if (deadline === null || BigInt(timeValue(now)) >= deadline) {
        throw new Error(`Lock ${name} is held by active pane ${activeRecord.ownerPane} (PID ${activeRecord.pid}, since ${activeRecord.acquiredAt}).`);
      }
      pause(Math.max(1, Math.min(100, Number(deadline - BigInt(timeValue(now))))));
      continue;
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
} = {}) {
  validateName(name);
  const caller = callerFor(env, herdr);
  const { commonDir, directory } = lockContext(config, dataDir);
  const file = path.join(directory, `${name}.json`);
  return withMutationLock(directory, () => {
    const record = readRecord(file, commonDir);
    if (!record) throw new Error(`Lock ${name} does not exist.`);
    if (record.ownerPane !== caller.paneId && lockIsLive(record, { herdr, pidAlive })) {
      throw new Error(`Cannot release active lock ${name} owned by another pane (${record.ownerPane}, PID ${record.pid}).`);
    }
    fs.unlinkSync(file);
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
} = {}) {
  callerFor(env, herdr);
  const { commonDir, directory } = lockContext(config, dataDir);
  const locks = fs.readdirSync(directory).filter((file) => file.endsWith('.json')).sort().map((fileName) => {
    const record = readRecord(path.join(directory, fileName), commonDir);
    return { ...record, state: lockIsLive(record, { herdr, pidAlive }) ? 'live' : 'stale' };
  });
  if (!locks.length) output('No project locks.');
  for (const lock of locks) {
    output(`${lock.name}: pane ${lock.ownerPane}, PID ${lock.pid}, ${lock.command}, ${lock.acquiredAt}, ${lock.state}`);
  }
  return locks;
}
