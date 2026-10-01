import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-boss-test-'));
const homeDir = path.join(tempDir, 'home');
const dataDir = path.join(tempDir, 'data');
fs.mkdirSync(homeDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const env = {
  ...process.env,
  HOME: homeDir,
  HERDR_BOSS_DIR: dataDir,
  HERDR_BOSS_LIVE_DIR: dataDir,
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

  if (spawnError) {
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
