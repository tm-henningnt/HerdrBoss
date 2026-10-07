// The command line of `herdr-boss project scan`: it lists Git repositories and proposes records.
// The scan is read-only unless --add uses the checked project register command.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { DATA_DIR } from './config.js';
import { stripRemoteCredentials } from './harness.js';
import { SLUG, readRegister, parseFlags, remoteProblem } from './project-register.js';
import { projectRegisterCommand } from './project-register-cli.js';

export const SCAN_USAGE = 'Usage: project scan DIR [--depth N] [--add] [--dry-run]';
const DEFAULT_DEPTH = 2;
const MAX_DEPTH = 10;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

function displayText(value) {
  return String(value).replace(CONTROL_CHARACTERS, '');
}

// A folder is a repository when it holds a .git entry. A bare folder gives false.
function isRepository(dir) {
  try {
    const stat = fs.lstatSync(path.join(dir, '.git'));
    return stat.isDirectory() || stat.isFile();
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
export function projectScanCommand(args, { dataDir = DATA_DIR, cwd = process.cwd(), log = console.log, env = process.env, herdr } = {}) {
  const { flags, positional } = parseFlags(args, { values: ['--depth'], booleans: ['--add', '--dry-run'], usage: SCAN_USAGE });
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
  if (!rootStat || !rootStat.isDirectory()) throw new Error(`${displayText(raw)} is not a directory.`);

  const found = [];
  walk(root, 0, maxDepth, found);
  if (found.length === 0) {
    log(`No Git repositories found under ${displayText(root)}.`);
    return 0;
  }

  const known = new Set(readRegister(dataDir).projects.map((entry) => entry.slug));
  let proposed = 0;
  let registered = 0;
  let invalid = 0;
  let added = 0;
  let wouldAdd = 0;
  for (const dir of found) {
    const name = path.basename(dir);
    if (!SLUG.test(name)) {
      log(`skip ${displayText(name)}: the folder name is not a project slug.`);
      invalid += 1;
      continue;
    }
    if (known.has(name)) {
      log(`registered ${displayText(name)}`);
      registered += 1;
      continue;
    }
    const remote = remoteOf(dir);
    if (flags['--add']) {
      const addArgs = ['add', name, '--repo', dir];
      if (remote !== '-') addArgs.push('--remote', remote);
      if (flags['--dry-run']) addArgs.push('--dry-run');
      projectRegisterCommand(addArgs, { env, herdr, dataDir, log: () => {} });
      if (flags['--dry-run']) {
        log(`would add ${displayText(name)}`);
        wouldAdd += 1;
      } else {
        log(`added ${displayText(name)}`);
        added += 1;
        known.add(name);
      }
    } else {
      log(`propose ${displayText(name)} ${displayText(dir)} ${remote}`);
    }
    proposed += 1;
  }
  if (flags['--add']) {
    log(flags['--dry-run']
      ? `${wouldAdd} would be added, ${registered} registered, ${invalid} without a valid slug.`
      : `${added} added, ${registered} registered, ${invalid} without a valid slug.`);
  } else {
    log(`${proposed} proposed, ${registered} registered, ${invalid} without a valid slug.`);
    if (proposed > 0) log('Next: run herdr-boss project register add SLUG --repo PATH --title TEXT.');
  }
  return 0;
}
