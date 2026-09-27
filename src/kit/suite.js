import { spawnSync } from 'node:child_process';
import { DATA_DIR } from '../config.js';
import { createHerdrRunner } from './workers.js';
import { FULL_SUITE_LOCK, acquireProjectLock, releaseProjectLock } from './locks.js';

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

export function runSuite(command, {
  config,
  env = process.env,
  herdr = createHerdrRunner(),
  dataDir = DATA_DIR,
  waitSeconds = SUITE_WAIT_SECONDS,
  keep = [],
  output = console.log,
  now = Date.now,
  pause,
  pidAlive,
  stdio = 'inherit',
  cwd = process.cwd(),
} = {}) {
  if (!Array.isArray(command) || !command.length) throw new Error('suite needs a command after --.');
  acquireProjectLock(FULL_SUITE_LOCK, { config, env, herdr, dataDir, waitSeconds, output, now, pause, pidAlive });
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
  } finally {
    releaseProjectLock(FULL_SUITE_LOCK, { config, env, herdr, dataDir, output, pidAlive });
  }
  return { exitCode, removed };
}
