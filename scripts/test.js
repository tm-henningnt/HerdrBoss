import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describeLiveChanges, liveDataDir, snapshotLiveFiles } from './live-data-guard.js';

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

const env = {
  ...process.env,
  HOME: homeDir,
  HERDR_BOSS_DIR: dataDir,
  HERDR_BOSS_LIVE_DIR: dataDir,
  NODE_OPTIONS: nodeOptions,
  HERDR_BOSS_TEST_GUARD_DIR: liveDir,
  HERDR_BOSS_TEST_GUARD_REPORT: guardReport,
};
const extraArgs = process.argv.slice(2);
const separator = extraArgs.indexOf('--');
const testArgs = separator >= 0 ? extraArgs.slice(separator + 1) : extraArgs;
const files = testArgs.length ? testArgs : ['test/'];
let child;
let pendingSignal;

function forwardSignal(signal) {
  pendingSignal = signal;
  if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
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
  child = spawn(process.execPath, ['--test', '--test-concurrency=2', ...files], {
    env,
    stdio: 'inherit',
  });
  if (pendingSignal) child.kill(pendingSignal);

  let spawnError;
  const result = await new Promise((resolve) => {
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  const writes = readGuardWrites(guardReport);
  if (writes.length) {
    process.stderr.write(`\nLive data guard: ${writes.length} test write(s) or Chrome launch(es) touched the live data directory ${liveDir}:\n`);
    for (const write of writes) process.stderr.write(`  - ${write.kind}: ${write.target}\n`);
    process.stderr.write('A test must use a temporary HERDR_BOSS_DIR and a fake probe.\n');
  }
  const changes = describeLiveChanges(before, snapshotLiveFiles(liveDir));
  if (changes.length) process.stderr.write(`Live data snapshot (the service writes these too): ${changes.join('; ')}\n`);

  if (writes.length) {
    process.exitCode = 1;
  } else if (spawnError) {
    process.stderr.write(`Cannot start the Node test runner: ${spawnError.message}\n`);
    process.exitCode = 1;
  } else if (result.code !== null) {
    process.exitCode = result.code;
  } else if (result.signal) {
    process.exitCode = 128 + (os.constants.signals[result.signal] ?? 1);
  } else {
    process.exitCode = 1;
  }
} finally {
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
  fs.rmSync(tempDir, { recursive: true, force: true });
}
