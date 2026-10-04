// Shared helpers for the test-runner live-data guard. The guard keeps tests away from the real service data
// directory. It reads that directory only, and it never changes it. The real account home decides the path, so the
// temporary HOME of a test run cannot hide the live directory.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LIVE_FILES = ['events.jsonl', 'state.json'];

// The home of the account, not the HOME of a test run. os.userInfo() ignores the HOME variable.
export function realHome() {
  try { return os.userInfo().homedir; } catch { return os.homedir(); }
}

// The live service data directory. An explicit HERDR_BOSS_LIVE_DIR names it, as in src/config.js. The real account
// home is the default, so the temporary HOME of a test run cannot hide the live directory.
export function liveDataDir(env = process.env) {
  return env.HERDR_BOSS_LIVE_DIR ? path.resolve(env.HERDR_BOSS_LIVE_DIR) : path.join(realHome(), '.herdr-boss');
}

// Resolve the deepest existing ancestor, so a path whose final part does not exist still compares by its real path.
export function realPath(target) {
  const missing = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return missing.length ? path.join(real, ...[...missing].reverse()) : real;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

// True when `target` is the live data directory or a path inside it.
export function isInsideLiveDir(target, liveDir) {
  const live = realPath(liveDir);
  const candidate = realPath(target);
  const relative = path.relative(live, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function statEntry(file) {
  try {
    const stat = fs.statSync(file);
    return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return { exists: false, size: null, mtimeMs: null };
  }
}

// Record the size and the mtime of each live file, so the runner can report a change after the run.
export function snapshotLiveFiles(liveDir = liveDataDir()) {
  const snapshot = {};
  for (const name of LIVE_FILES) snapshot[name] = statEntry(path.join(liveDir, name));
  return snapshot;
}

// Describe the difference between two snapshots. An empty array means no change.
export function describeLiveChanges(before, after) {
  const changes = [];
  for (const name of LIVE_FILES) {
    const a = before?.[name] ?? { exists: false, size: null, mtimeMs: null };
    const b = after?.[name] ?? { exists: false, size: null, mtimeMs: null };
    if (a.exists !== b.exists) changes.push(`${name}: ${a.exists ? 'removed' : 'created'}`);
    else if (a.size !== b.size || a.mtimeMs !== b.mtimeMs) changes.push(`${name}: size ${a.size} -> ${b.size}`);
  }
  return changes;
}

// Tracked files that the kit installer writes into a project checkout. A test must never change them in this repository.
export const KIT_FILES = ['docs/orchestration/herdr-boss.md', 'AGENTS.md', '.claude/settings.json'];

// Record the content hash of each kit file under `root`. A missing file has the hash null.
export function snapshotKitFiles(root) {
  const snapshot = {};
  for (const name of KIT_FILES) {
    try {
      snapshot[name] = createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex');
    } catch {
      snapshot[name] = null;
    }
  }
  return snapshot;
}

// Name each kit file whose content differs between two snapshots. An empty array means no change.
export function describeKitChanges(before, after) {
  return KIT_FILES.filter((name) => (before?.[name] ?? null) !== (after?.[name] ?? null));
}
