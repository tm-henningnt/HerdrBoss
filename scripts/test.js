import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { describeKitChanges, describeLiveChanges, KIT_FILES, liveDataDir, snapshotKitFiles, snapshotLiveFiles } from './live-data-guard.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-boss-test-'));
const homeDir = path.join(tempDir, 'home');
const dataDir = path.join(tempDir, 'data');
fs.mkdirSync(homeDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

// The live service writes its own events.jsonl and state.json on every tick, so the snapshot is report evidence, not
// a pass or fail signal. The write guard in every test process names the test that wrote the live data directory.
const liveDir = liveDataDir();
const guardReport = path.join(tempDir, 'live-write-guard.jsonl');
const guardModule = new URL('./live-write-guard.js', import.meta.url).href;
const nodeOptions = [process.env.NODE_OPTIONS, `--import=${guardModule}`].filter(Boolean).join(' ');
const before = snapshotLiveFiles(liveDir);
// The tracked kit files of this checkout must stay as they are. The write guard refuses a write to them, and the
// content hash after the run catches a write that bypasses the guard.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const kitBefore = snapshotKitFiles(repoRoot);

const env = {
  ...process.env,
  HOME: homeDir,
  HERDR_BOSS_DIR: dataDir,
  HERDR_BOSS_LIVE_DIR: dataDir,
  NODE_OPTIONS: nodeOptions,
  HERDR_BOSS_TEST_GUARD_DIR: liveDir,
  HERDR_BOSS_TEST_GUARD_REPORT: guardReport,
  HERDR_BOSS_TEST_GUARD_FILES: KIT_FILES.map((name) => path.join(repoRoot, name)).join(path.delimiter),
};
const extraArgs = process.argv.slice(2);
const separator = extraArgs.indexOf('--');
const testArgs = separator >= 0 ? extraArgs.slice(separator + 1) : extraArgs;
const TEST_CONCURRENCY = 2;
const CHILD_KILL_GRACE_MS = 1000;
const TEST_EXTENSIONS = new Set(['.cjs', '.js', '.mjs']);
const TEST_FILE_NAME = /^(?:test(?:-.+)?|.+(?:\.test|-test|_test))\.(?:cjs|js|mjs)$/;
const OPTIONS_WITH_VALUES = new Set([
  '--test-coverage-branches', '--test-coverage-exclude', '--test-coverage-functions', '--test-coverage-include',
  '--test-coverage-lines', '--test-name-pattern', '--test-random-seed', '--test-reporter',
  '--test-reporter-destination', '--test-rerun-failures', '--test-shard', '--test-skip-pattern', '--test-timeout',
]);
const runningChildren = new Set();
let pendingSignal;

function splitTestArgs(args) {
  const files = [];
  const options = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('-')) {
      files.push(arg);
      continue;
    }
    options.push(arg);
    if (OPTIONS_WITH_VALUES.has(arg) && args[index + 1] !== undefined) options.push(args[++index]);
  }
  return { files: files.length ? files : ['test/'], options };
}

function isTestFile(file) {
  return TEST_EXTENSIONS.has(path.extname(file)) && TEST_FILE_NAME.test(path.basename(file));
}

function expandTestInput(input) {
  const matches = input.includes('*') || input.includes('?') || input.includes('[')
    ? (typeof fs.globSync === 'function' ? fs.globSync(input) : [])
    : [input];
  const files = [];
  for (const match of matches) {
    const absolute = path.resolve(repoRoot, match);
    let stat;
    try { stat = fs.statSync(absolute); } catch { files.push(absolute); continue; }
    if (stat.isFile()) {
      files.push(absolute);
      continue;
    }
    if (!stat.isDirectory()) continue;
    const visit = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(full);
        else if (entry.isFile() && isTestFile(entry.name)) files.push(full);
      }
    };
    visit(absolute);
  }
  return files;
}

function timeoutMs() {
  const raw = process.env.HERDR_BOSS_TEST_TIMEOUT_MS;
  if (raw === undefined) return 300_000;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    process.stderr.write('HERDR_BOSS_TEST_TIMEOUT_MS must be a positive whole number of milliseconds.\n');
    return null;
  }
  return value;
}

function displayPath(file) {
  const relative = path.relative(repoRoot, file);
  return relative && !relative.startsWith(`..${path.sep}`) ? relative : file;
}

function killChild(child, signal) {
  if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
}

function forwardSignal(signal) {
  pendingSignal = signal;
  for (const child of runningChildren) {
    killChild(child, signal);
    const escalation = setTimeout(() => killChild(child, 'SIGKILL'), CHILD_KILL_GRACE_MS);
    escalation.unref();
  }
}

function runFile(file, options, limitMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, ['--test', `--test-concurrency=${TEST_CONCURRENCY}`, ...options, file], {
      cwd: repoRoot,
      env,
      stdio: 'inherit',
    });
    runningChildren.add(child);
    let timedOut = false;
    let spawnError;
    let killTimer;
    const timeout = setTimeout(() => {
      timedOut = true;
      killChild(child, 'SIGTERM');
      killTimer = setTimeout(() => killChild(child, 'SIGKILL'), CHILD_KILL_GRACE_MS);
      killTimer.unref();
    }, limitMs);
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      runningChildren.delete(child);
      resolve({ file, code, signal, spawnError, timedOut, elapsedMs: Date.now() - startedAt });
    });
  });
}

async function runFiles(inputs, options, limitMs) {
  const files = [...new Set(inputs.flatMap(expandTestInput))];
  if (!files.length) {
    process.stderr.write('No test files matched the requested paths.\n');
    return [{ file: inputs.join(', '), code: 1, signal: null, spawnError: null, timedOut: false, elapsedMs: 0 }];
  }
  const results = [];
  let next = 0;
  const runNext = async () => {
    while (!pendingSignal && next < files.length) {
      const file = files[next++];
      results.push(await runFile(file, options, limitMs));
    }
  };
  await Promise.all(Array.from({ length: Math.min(TEST_CONCURRENCY, files.length) }, runNext));
  return results;
}

function readTimeoutSummary(results, limitMs) {
  const timedOut = results.filter((result) => result.timedOut);
  if (!timedOut.length) return;
  process.stderr.write('\nTest file timeout summary:\n');
  for (const result of timedOut) {
    process.stderr.write(`  ${displayPath(result.file)} timed out; elapsed ${result.elapsedMs} ms (limit ${limitMs} ms).\n`);
  }
}

// Read the guard report of every test process. Each line names a refused write or a refused Chrome launch.
function readGuardWrites(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

const onSigint = () => forwardSignal('SIGINT');
const onSigterm = () => forwardSignal('SIGTERM');
process.on('SIGINT', onSigint);
process.on('SIGTERM', onSigterm);

try {
  const limitMs = timeoutMs();
  if (limitMs === null) {
    process.exitCode = 2;
  } else {
    const { files, options } = splitTestArgs(testArgs);
    const results = await runFiles(files, options, limitMs);

    const writes = readGuardWrites(guardReport);
    if (writes.length) {
      process.stderr.write(`\nLive data guard: ${writes.length} test write(s) or Chrome launch(es) touched the live data directory ${liveDir}:\n`);
      for (const write of writes) process.stderr.write(`  - ${write.kind}: ${write.target}\n`);
      process.stderr.write('A test must use a temporary HERDR_BOSS_DIR and a fake probe.\n');
    }
    const changes = describeLiveChanges(before, snapshotLiveFiles(liveDir));
    if (changes.length) process.stderr.write(`Live data snapshot (the service writes these too): ${changes.join('; ')}\n`);

    const kitChanges = describeKitChanges(kitBefore, snapshotKitFiles(repoRoot));
    if (kitChanges.length) {
      process.stderr.write(`\nKit file guard: the run changed tracked kit file(s) in ${repoRoot}: ${kitChanges.join(', ')}\n`);
      process.stderr.write('A test must install or update a kit in a temporary project root. Restore each file with git checkout -- <file>.\n');
    }
    for (const result of results) {
      if (result.spawnError) process.stderr.write(`Cannot start the Node test runner for ${displayPath(result.file)}: ${result.spawnError.message}\n`);
    }
    readTimeoutSummary(results, limitMs);

    if (pendingSignal) {
      process.exitCode = 128 + (os.constants.signals[pendingSignal] ?? 1);
    } else {
      const failed = results.find((result) => result.timedOut || result.spawnError || result.code !== 0 || result.signal);
      process.exitCode = writes.length || kitChanges.length || failed ? Math.max(1, failed?.code || 0) : 0;
    }
  }
} finally {
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
  fs.rmSync(tempDir, { recursive: true, force: true });
}
