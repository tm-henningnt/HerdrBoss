// The command line of `herdr-boss project scan`: it lists the Git repositories under a folder
// and proposes register records. The command reads only. It has no caller check and writes nothing.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { DATA_DIR } from './config.js';
import { stripRemoteCredentials } from './harness.js';
import { SLUG, readRegister, parseFlags, remoteProblem } from './project-register.js';

export const SCAN_USAGE = 'Usage: project scan DIR [--depth N]';
const DEFAULT_DEPTH = 2;
const MAX_DEPTH = 10;

// A folder is a repository when it holds a .git entry. A bare folder gives false.
function isRepository(dir) {
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

// Collects the repository folders in pre-order over byte-sorted names.
// Hidden names and symlinks are skipped. The walk stops at the depth limit.
function walk(dir, depth, maxDepth, found) {
  if (isRepository(dir)) found.push(dir);
  if (depth >= maxDepth) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isDirectory()) continue;
    walk(path.join(dir, entry.name), depth + 1, maxDepth, found);
  }
}

// The origin remote without its credentials, or "-" when the repository has none.
function remoteOf(dir) {
  let url;
  try {
    url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return '-';
  }
  if (!url) return '-';
  const clean = stripRemoteCredentials(url);
  return remoteProblem(clean) === null ? clean : '-';
}

// Runs `project scan`. Returns the exit code. A bad argument throws with the usage line.
export function projectScanCommand(args, { dataDir = DATA_DIR, cwd = process.cwd(), log = console.log } = {}) {
  const { flags, positional } = parseFlags(args, { values: ['--depth'], usage: SCAN_USAGE });
  if (positional.length !== 1) throw new Error(SCAN_USAGE);
  let maxDepth = DEFAULT_DEPTH;
  if (flags['--depth'] !== undefined) {
    if (!/^\d+$/.test(flags['--depth']) || Number(flags['--depth']) > MAX_DEPTH) {
      throw new Error(`--depth must be a whole number from 0 to ${MAX_DEPTH}.`);
    }
    maxDepth = Number(flags['--depth']);
  }
  const raw = positional[0];
  const root = path.resolve(cwd, raw);
  let rootStat;
  try {
    rootStat = fs.statSync(root);
  } catch {
    rootStat = null;
  }
  if (!rootStat || !rootStat.isDirectory()) throw new Error(`${raw} is not a directory.`);

  const found = [];
  walk(root, 0, maxDepth, found);
  if (found.length === 0) {
    log(`No Git repositories found under ${root}.`);
    return 0;
  }

  const known = new Set(readRegister(dataDir).projects.map((entry) => entry.slug));
  let proposed = 0;
  let registered = 0;
  let invalid = 0;
  for (const dir of found) {
    const name = path.basename(dir);
    if (!SLUG.test(name)) {
      log(`skip ${name}: the folder name is not a project slug.`);
      invalid += 1;
      continue;
    }
    if (known.has(name)) {
      log(`registered ${name}`);
      registered += 1;
      continue;
    }
    log(`propose ${name} ${dir} ${remoteOf(dir)}`);
    proposed += 1;
  }
  log(`${proposed} proposed, ${registered} registered, ${invalid} without a valid slug.`);
  if (proposed > 0) log('Next: run herdr-boss project register add SLUG --repo PATH --title TEXT.');
  return 0;
}
