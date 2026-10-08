import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertProjectGitPins } from '../git-pins.js';
import { DATA_DIR } from '../config.js';
import { agentPromptTimeoutMs } from '../agent-prompt.js';
import { createHerdrRunner } from './workers.js';
import { DEFAULT_RULES_FILE } from './config.js';
import { SWAP_FORCE_ENV, swapGuardFor } from './swap-guard.js';
import { FULL_SUITE_LOCK, acquireProjectLock, printLockRecords, readLockQueue, readMachineLocks, recordLockRelease, releaseProjectLock } from './locks.js';
import { DEFAULT_SUITE_UNTESTED, SUITE_PASSES_FILE, cleanTreeKey, findDocsOnlyBase, readSuitePasses, samePassKey, sameTreeKey, writeSuitePasses } from './suite-passes.js';

export { SUITE_PASSES_FILE };

export const SUITE_WAIT_SECONDS = 1800;
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

export function listSuitePasses({
  dataDir = DATA_DIR, output = console.log, herdr = null, pidAlive, processInfo, now = Date.now,
} = {}) {
  const records = readSuitePasses(dataDir).slice(-10);
  for (const record of records) {
    const commonDirName = path.basename(record.repo ?? '');
    const repoName = commonDirName === '.git' ? path.basename(path.dirname(record.repo)) : commonDirName;
    const tree = typeof record.tree === 'string' ? record.tree.slice(0, 12) : 'unknown';
    const command = Array.isArray(record.command) ? JSON.stringify(record.command) : '[]';
    output(`suite: ${record.time ?? 'unknown time'} ${repoName || 'unknown repo'} ${tree} ${command}${record.skipped ? ' (skipped, only docs changed)' : ''}`);
  }
  // Show the full-suite holder and queue, in the same text that `lock list` uses. A failed pane list prints nothing.
  try {
    const locks = readMachineLocks({ dataDir, ...(herdr ? { herdr } : {}), pidAlive, processInfo, now })
      .filter((record) => record.name === FULL_SUITE_LOCK);
    if (locks.length) {
      const queue = readLockQueue({ dataDir, ...(herdr ? { herdr } : { livePanes: new Set() }), pidAlive, processInfo, now });
      printLockRecords(locks.map((lock) => ({ ...lock, queue })), output);
    }
  } catch { /* A missing pane list or a broken record never stops the pass list. */ }
  return records;
}

// A push sets HERDR_BOSS_PUSH_SUITES to a file. Each suite run of its pre-push hook adds its command to the file.
// The push stores the commands, so the next push can look for a pass of each command before it takes the lock.
function noteHookSuite(env, command) {
  const file = env.HERDR_BOSS_PUSH_SUITES;
  if (!file) return;
  try { fs.appendFileSync(file, `${JSON.stringify(command)}\n`, { mode: 0o600 }); } catch {}
}

export function runSuite(command, {
  config,
  gitPinOverride = false,
  env = process.env,
  herdr = createHerdrRunner(),
  dataDir = DATA_DIR,
  waitSeconds = SUITE_WAIT_SECONDS,
  keep = [],
  reuse = false,
  skipDocs = false,
  notify = true,
  output = console.log,
  now = Date.now,
  pause,
  pidAlive,
  stdio = 'inherit',
  cwd = process.cwd(),
  rulesFile = DEFAULT_RULES_FILE,
} = {}) {
  if (!Array.isArray(command) || !command.length) throw new Error('suite needs a command after --.');
  assertProjectGitPins({ config: config ?? { root: cwd }, env, dataDir, output, now, gitPinOverride });
  const repoRoot = config?.root ?? cwd;
  const commandArray = [...command];
  const untested = config?.suiteUntested ?? DEFAULT_SUITE_UNTESTED;
  const initialKey = cleanTreeKey(repoRoot, untested);
  noteHookSuite(env, commandArray);
  if (initialKey) {
    // A run without --reuse asks for a fresh run of the same tree. It skips the suite only when a pass has another tree
    // and the same tested hash: the trees differ by untested files only.
    const explicit = reuse || env.HERDR_BOSS_SUITE_REUSE === '1';
    const pass = readSuitePasses(dataDir).slice().reverse().find((record) => samePassKey(record, initialKey, commandArray) && (explicit || record.tree !== initialKey.tree));
    if (pass) {
      output(`suite: reused the pass of ${pass.time} for tree ${pass.tree.slice(0, 12)}`);
      return { exitCode: 0, removed: 0, reused: true, pass };
    }
  }

  // --skip-docs: a clean tree whose changes since the last pass are docs that no test reads needs no run. The skip is a pass record.
  if (initialKey && skipDocs) {
    const base = findDocsOnlyBase(dataDir, initialKey, commandArray, repoRoot);
    if (base) {
      output('suite: skipped, only docs changed');
      try {
        const records = readSuitePasses(dataDir);
        records.push({ ...initialKey, command: commandArray, node: process.version, time: new Date(now()).toISOString(), skipped: 'docs', from: base.pass.tree });
        writeSuitePasses(dataDir, records);
      } catch (error) {
        output(`Warning: could not record the suite skip (${error.code ?? 'error'}).`);
      }
      return { exitCode: 0, removed: 0, skipped: true, from: base.pass };
    }
  }

  const swapText = swapGuardFor(rulesFile, { env, herdr, now, override: `Set ${SWAP_FORCE_ENV}=1 to override.` });
  if (swapText) throw new Error(swapText);

  const lock = acquireProjectLock(FULL_SUITE_LOCK, { config, env, herdr, dataDir, waitSeconds, output, now, pause, pidAlive, kind: 'suite' });
  const heldSince = now();
  if (lock.reentrant) output('suite: reusing the full-suite lock of herdr-boss push');
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
    const finalKey = initialKey && cleanTreeKey(repoRoot, untested);
    if (exitCode === 0 && initialKey && finalKey?.tree === initialKey.tree && sameTreeKey(finalKey, initialKey)) {
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
    if (lock.reentrant) {
      recordLockRelease({ ...lock, project: config?.slug ?? null, kind: 'suite' }, { dataDir, now, holdMs: Math.max(0, now() - heldSince), reentrant: true });
    } else {
      try { releaseProjectLock(FULL_SUITE_LOCK, { config, env, herdr, dataDir, output, pidAlive, now, expectedRecord: lock }); }
      catch (error) {
        const reason = String(error?.message ?? error).replace(/\s+/g, ' ').replace(/[. ]+$/, '');
        output(`Warning: could not release lock ${FULL_SUITE_LOCK}: ${reason}. The lock is stale when this process ends.`);
        // A pass is a pass. A failed lock release never changes the exit code of a passing suite.
      }
    }
  }
  if (notify) {
    try { notifySuiteFinished(exitCode, { env, herdr }); } catch { /* A failed notice never changes the suite result. */ }
  }
  return { exitCode, removed };
}

// The one line that a finished suite sends to its caller pane. The text does not hold a passed or failed count:
// a suite is one command, so such a count would be invented.
export function suiteFinishedText(exitCode) {
  return `suite finished: exit ${exitCode}`;
}

// Tell the caller pane that a suite run ended. The pane comes from HERDR_PANE_ID. The notice goes out only
// inside Herdr, and only when the pane is idle or done: a working, blocked, or unknown pane gets no prompt.
// The pane get and the prompt carry a bounded timeout, so a hanging Herdr cannot block the suite exit. A
// failed notice never changes the suite exit code, so a detached suite always ends on its own.
export function notifySuiteFinished(exitCode, { env = process.env, herdr = createHerdrRunner(), timeoutMs = agentPromptTimeoutMs() } = {}) {
  if (env.HERDR_ENV !== '1') return { sent: false, reason: 'not a Herdr pane' };
  const paneId = env.HERDR_PANE_ID;
  if (!paneId) return { sent: false, reason: 'no caller pane' };
  const options = { timeout: Math.min(timeoutMs, 2500), killSignal: 'SIGKILL' };
  let pane;
  try {
    const response = herdr(['pane', 'get', paneId], options);
    pane = response?.pane ?? response;
  } catch { return { sent: false, reason: 'the caller pane is gone' }; }
  const returnedId = pane?.pane_id ?? pane?.paneId ?? pane?.id ?? null;
  if (returnedId !== paneId) return { sent: false, reason: 'the caller pane changed' };
  const status = pane.agent_status ?? pane.status ?? null;
  if (!['idle', 'done'].includes(status)) return { sent: false, reason: 'the caller pane is busy' };
  try {
    herdr(['agent', 'prompt', paneId, suiteFinishedText(exitCode)], options);
    return { sent: true };
  } catch { return { sent: false, reason: 'the notice was not delivered' }; }
}
