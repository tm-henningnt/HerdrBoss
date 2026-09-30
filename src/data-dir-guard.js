import os from 'node:os';
import path from 'node:path';
import { resolveAlias } from './config.js';

export const LIVE_DATA_DIR_MESSAGE = 'Refusing to write test data into the live data dir. Use a temporary one: HERDR_BOSS_DIR=$(mktemp -d) HOME=$(mktemp -d)';

// Every directory that can hold live data: the default under the current HOME, the default under the account home
// folder, and the directory that HERDR_BOSS_LIVE_DIR names. Read at call time, so a test can change HOME.
function liveDirs() {
  const dirs = [path.join(process.env.HOME || os.homedir(), '.herdr-boss'), path.join(os.userInfo().homedir, '.herdr-boss')];
  if (process.env.HERDR_BOSS_LIVE_DIR) dirs.push(process.env.HERDR_BOSS_LIVE_DIR);
  return dirs.map(resolveAlias);
}

// Throw when a seed, fixture, or preview helper would write into the live data directory or into a directory inside it.
// Compare real paths, so a symlink cannot hide the live directory. Return the real path of a safe directory.
export function assertTempDataDir(dir) {
  if (typeof dir !== 'string' || !dir) throw new TypeError('assertTempDataDir needs a directory path.');
  const target = resolveAlias(dir);
  for (const live of liveDirs()) {
    const relative = path.relative(live, target);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) throw new Error(LIVE_DATA_DIR_MESSAGE);
  }
  return target;
}
