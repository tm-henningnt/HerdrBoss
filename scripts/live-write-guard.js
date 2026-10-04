// A preload module for the test runner. The runner loads it with --import in every test process. It refuses a write
// to the real live data directory and a launch of a Chrome or Chromium binary. It writes each refusal to a report
// file, and it throws, so the test file that caused it fails.
//
// Patch the CommonJS module objects with createRequire. An ESM import of node:fs would create the ESM wrapper
// before the patch, and a later named import would keep the original function.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const childProcess = require('node:child_process');
const nodePath = require('node:path');

const liveDir = process.env.HERDR_BOSS_TEST_GUARD_DIR;
const reportFile = process.env.HERDR_BOSS_TEST_GUARD_REPORT;
// Tracked kit files of the repository checkout. The runner names them, delimited by the path delimiter.
const protectedFiles = (process.env.HERDR_BOSS_TEST_GUARD_FILES ?? '').split(nodePath.delimiter).filter(Boolean);

if (liveDir && reportFile) {
  // Resolve the deepest existing ancestor, so a path whose final part does not exist still compares by its real path.
  const realPath = (target) => {
    const missing = [];
    let current = nodePath.resolve(target);
    for (;;) {
      try {
        const real = fs.realpathSync(current);
        return missing.length ? nodePath.join(real, ...[...missing].reverse()) : real;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const parent = nodePath.dirname(current);
        if (parent === current) return nodePath.resolve(target);
        missing.push(nodePath.basename(current));
        current = parent;
      }
    }
  };
  const live = realPath(liveDir);
  const isInsideLiveDir = (target) => {
    const candidate = realPath(target);
    const relative = nodePath.relative(live, candidate);
    return relative === '' || (!relative.startsWith('..') && !nodePath.isAbsolute(relative));
  };
  const protectedReal = new Set(protectedFiles.map(realPath));
  const isGuarded = (target) => isInsideLiveDir(target) || (protectedReal.size > 0 && protectedReal.has(realPath(target)));

  const appendRaw = fs.appendFileSync.bind(fs);
  const patched = new Set();

  const report = (kind, target) => {
    const line = JSON.stringify({ kind, target: String(target), pid: process.pid });
    try { appendRaw(reportFile, `${line}\n`); } catch { /* The report is best effort. */ }
    const error = new Error(`Refusing to ${kind} the live data directory or a tracked kit file from a test: ${target}. Use a temporary HERDR_BOSS_DIR, a temporary project root, and a fake probe.`);
    error.code = 'HERDR_LIVE_DATA_WRITE';
    throw error;
  };

  const asPath = (value) => {
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value)) return value.toString();
    if (value instanceof URL) return value.pathname;
    return null;
  };
  // An undefined or non-string flag is a read, for example fs.openSync(p) or fs.open(p, cb). Treat it as a read.
  const writeFlags = (flags) => {
    if (typeof flags === 'number') return flags !== fs.constants.O_RDONLY;
    if (typeof flags !== 'string') return false;
    return /[wa+]/.test(flags);
  };

  const guardMethod = (object, name, kind, targetIndex, flagIndex = null) => {
    const original = object[name];
    const key = `${name}:${object === fsPromises}`;
    if (typeof original !== 'function' || patched.has(key)) return;
    patched.add(key);
    object[name] = function (...args) {
      const target = asPath(args[targetIndex]);
      if (target && isGuarded(target) && (flagIndex === null || writeFlags(args[flagIndex]))) report(kind, target);
      return original.apply(this, args);
    };
  };

  const fsWriters = [
    ['writeFileSync', 'write', 0], ['appendFileSync', 'append', 0], ['openSync', 'open', 0, 1], ['createWriteStream', 'write', 0],
    ['renameSync', 'rename', 1], ['copyFileSync', 'copy', 1], ['unlinkSync', 'unlink', 0], ['rmSync', 'remove', 0], ['rmdirSync', 'remove', 0],
    ['mkdirSync', 'mkdir', 0], ['truncateSync', 'truncate', 0], ['symlinkSync', 'symlink', 1], ['linkSync', 'link', 1],
    ['writeFile', 'write', 0], ['appendFile', 'append', 0], ['open', 'open', 0, 1],
    ['rename', 'rename', 1], ['copyFile', 'copy', 1], ['unlink', 'unlink', 0], ['rm', 'remove', 0], ['rmdir', 'remove', 0],
    ['mkdir', 'mkdir', 0], ['truncate', 'truncate', 0], ['symlink', 'symlink', 1], ['link', 'link', 1],
  ];
  for (const [name, kind, targetIndex, flagIndex] of fsWriters) guardMethod(fs, name, kind, targetIndex, flagIndex ?? null);
  for (const [name, kind, targetIndex, flagIndex] of fsWriters) {
    if (name === 'createWriteStream') continue;
    guardMethod(fsPromises, name, kind, targetIndex, flagIndex ?? null);
  }

  const chromeBinary = /^(?:google chrome|chrome|chromium|chromium-browser|chrome-headless-shell)$/i;
  const chromeCommand = (command) => {
    if (typeof command !== 'string') return false;
    return chromeBinary.test(command.split(/[\\/]/).pop() ?? '');
  };
  const chromeShellCommand = (command) => {
    if (typeof command !== 'string') return false;
    const first = command.trim().split(/\s+/)[0]?.replace(/^['"]|['"]$/g, '') ?? '';
    return chromeCommand(first) || /Google Chrome\.app/.test(command);
  };

  const guardSpawn = (name, detect) => {
    const original = childProcess[name];
    if (typeof original !== 'function' || patched.has(`cp:${name}`)) return;
    patched.add(`cp:${name}`);
    childProcess[name] = function (...args) {
      if (detect(args[0])) report('launch Chrome', args[0]);
      return original.apply(this, args);
    };
    // Keep util.promisify.custom (execFile and exec): promisify of the wrapper must still resolve { stdout, stderr }.
    for (const symbol of Object.getOwnPropertySymbols(original)) childProcess[name][symbol] = original[symbol];
  };
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) guardSpawn(name, chromeCommand);
  for (const name of ['exec', 'execSync']) guardSpawn(name, chromeShellCommand);
}
