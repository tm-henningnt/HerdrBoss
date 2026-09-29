import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { DATA_DIR } from '../config.js';
import { createHerdrRunner } from './workers.js';
import { FULL_SUITE_LOCK, acquireProjectLock, releaseProjectLock } from './locks.js';

export const SUITE_WAIT_SECONDS = 1800;
export const SUITE_PASSES_FILE = 'suite-passes.json';
const MAX_SUITE_PASSES = 200;
// Claude Code sets the messaging names in every tool shell. A test does not need them or any credential.
const ALWAYS_REMOVED = new Set(['CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_MESSAGING_SOCKET']);
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|API_KEY|_KEY)$/i;

export function cleanSuiteEnvironment(env, keep = []) {
  const kept = new Set(keep);
  const clean = {};
  let removed = 0;
  for (const [name, value] of Object.entries(env)) {
    if (!kept.has(name) && (ALWAYS_REMOVED.has(name) || SECRET_NAME.test(name))) removed += 1;
    else clean[name] = value;
  }
  return { env: clean, removed };
}

function gitText(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function cleanTreeKey(root) {
  try {
    if (gitText(root, 'status', '--porcelain')) return null;
    const commonDir = gitText(root, 'rev-parse', '--git-common-dir');
    const repo = fs.realpathSync(path.resolve(root, commonDir));
    const tree = gitText(root, 'write-tree');
    const headTree = gitText(root, 'rev-parse', 'HEAD^{tree}');
    if (!repo || tree !== headTree || !/^[0-9a-f]{40,64}$/i.test(tree)) return null;
    return { repo, tree };
  } catch {
    return null;
  }
}

function samePassKey(record, key, command) {
  return record?.repo === key.repo
    && record?.tree === key.tree
    && record?.node === process.version
    && Array.isArray(record?.command)
    && JSON.stringify(record.command) === JSON.stringify(command);
}

function readSuitePasses(dataDir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dataDir, SUITE_PASSES_FILE), 'utf8'));
    return Array.isArray(value) ? value.filter((record) => record && typeof record === 'object' && !Array.isArray(record)) : [];
  } catch {
    return [];
  }
}

function writeSuitePasses(dataDir, records) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, SUITE_PASSES_FILE);
  const temporary = path.join(dataDir, `.${SUITE_PASSES_FILE}.${process.pid}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(records.slice(-MAX_SUITE_PASSES), null, 2)}\n`);
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

export function listSuitePasses({ dataDir = DATA_DIR, output = console.log } = {}) {
  const records = readSuitePasses(dataDir).slice(-10);
  for (const record of records) {
    const commonDirName = path.basename(record.repo ?? '');
    const repoName = commonDirName === '.git' ? path.basename(path.dirname(record.repo)) : commonDirName;
    const tree = typeof record.tree === 'string' ? record.tree.slice(0, 12) : 'unknown';
    const command = Array.isArray(record.command) ? JSON.stringify(record.command) : '[]';
    output(`suite: ${record.time ?? 'unknown time'} ${repoName || 'unknown repo'} ${tree} ${command}`);
  }
  return records;
}

export function runSuite(command, {
  config,
  env = process.env,
  herdr = createHerdrRunner(),
  dataDir = DATA_DIR,
  waitSeconds = SUITE_WAIT_SECONDS,
  keep = [],
  reuse = false,
  output = console.log,
  now = Date.now,
  pause,
  pidAlive,
  stdio = 'inherit',
  cwd = process.cwd(),
} = {}) {
  if (!Array.isArray(command) || !command.length) throw new Error('suite needs a command after --.');
  const repoRoot = config?.root ?? cwd;
  const commandArray = [...command];
  const initialKey = cleanTreeKey(repoRoot);
  if ((reuse || env.HERDR_BOSS_SUITE_REUSE === '1') && initialKey) {
    const pass = readSuitePasses(dataDir).slice().reverse().find((record) => samePassKey(record, initialKey, commandArray));
    if (pass) {
      output(`suite: reused the pass of ${pass.time} for tree ${pass.tree.slice(0, 12)}`);
      return { exitCode: 0, removed: 0, reused: true, pass };
    }
  }

  acquireProjectLock(FULL_SUITE_LOCK, { config, env, herdr, dataDir, waitSeconds, output, now, pause, pidAlive, kind: 'suite' });
  let exitCode;
  let removed;
  try {
    const clean = cleanSuiteEnvironment(env, keep);
    removed = clean.removed;
    output(`suite: removed ${removed} environment names from the test environment.`);
    const result = spawnSync(command[0], command.slice(1), { cwd, env: clean.env, stdio });
    if (result.error) {
      output(`suite: cannot run the command: ${result.error.code ?? 'error'}.`);
      exitCode = 127;
    } else {
      exitCode = result.status ?? 1;
    }
    const finalKey = initialKey && cleanTreeKey(repoRoot);
    if (exitCode === 0 && initialKey && finalKey?.repo === initialKey.repo && finalKey.tree === initialKey.tree) {
      const records = readSuitePasses(dataDir);
      const pass = { ...initialKey, command: commandArray, node: process.version, time: new Date(now()).toISOString() };
      records.push(pass);
      try {
        writeSuitePasses(dataDir, records);
      } catch (error) {
        output(`Warning: could not record the suite pass (${error.code ?? 'error'}).`);
      }
    }
  } finally {
    try { releaseProjectLock(FULL_SUITE_LOCK, { config, env, herdr, dataDir, output, pidAlive }); }
    catch (error) {
      const reason = String(error?.message ?? error).replace(/\s+/g, ' ').replace(/[. ]+$/, '');
      output(`Warning: could not release lock ${FULL_SUITE_LOCK}: ${reason}. The lock is stale when this process ends.`);
      if (exitCode === 0) exitCode = 1;
    }
  }
  return { exitCode, removed };
}
