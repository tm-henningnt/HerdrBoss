import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

// These tests run a real fixture test file in a child test runner. They then interrupt the run without any chance for
// the fixture cleanup hook to run, and they check that the fixture children still stop on their own deadline. The
// child processes are never detached by the runner, so each child gets its own finite lifetime in the fixture itself.
const repoRoot = path.resolve(import.meta.dirname, '..');
// The fixture deadlines are 15 s. The wait below starts after the fixture children reported that they are ready, so a
// margin above the deadline still ends the wait quickly on a loaded machine.
const fixtureDeadlineMs = 15000;
const cleanupWaitMs = fixtureDeadlineMs + 15000;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function kill(pid) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

// Reads the parent of a process. The command prints one number and nothing else.
function parentOf(pid) {
  const value = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
  if (!Number.isInteger(value) || value <= 1) throw new Error(`no parent found for pid ${pid}`);
  return value;
}

async function waitFor(condition, maxMs) {
  const deadline = Date.now() + maxMs;
  for (;;) {
    const value = condition();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const gone = (pid) => waitFor(() => isAlive(pid) === false, cleanupWaitMs);

// Finds a file with the given name in a folder tree of at most two levels.
function findFile(dir, name) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    }
  }
  return null;
}

// Starts a real fixture test file in its own test runner. The runner writes its fixture files into the given temp
// folder, so the test keeps every path inside a folder that it removes.
function startFixtureRun(t, testFile, tmp) {
  // The parent runs under node:test too, so the child must not inherit that context. Without this the child skips its
  // files and exits at once.
  const env = { ...process.env, TMPDIR: tmp };
  delete env.NODE_TEST_CONTEXT;
  const runner = spawn(process.execPath, ['--test', testFile], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  runner.stdout.resume();
  runner.stderr.resume();
  const closed = once(runner, 'close');
  t.after(async () => {
    kill(runner.pid);
    await closed;
  });
  return runner;
}

test('an interrupted doctor command run leaves no fixture helper behind', { timeout: 120000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-fixture-cleanup-doctor-'));
  const owned = [];
  t.after(() => {
    for (const pid of owned) kill(pid);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const runner = startFixtureRun(t, 'test/doctor-process.test.js', tmp);
  owned.push(runner.pid);
  const readyFile = await waitFor(() => findFile(tmp, 'ready.json'), 30000);
  assert.ok(readyFile, 'the fixture command reported its helper before the interrupt');
  const { parent: commandPid, helper: helperPid } = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
  assert.equal(isAlive(commandPid), true, 'the fixture command is alive at the interrupt');
  assert.equal(isAlive(helperPid), true, 'the fixture helper is alive at the interrupt');
  const driverPid = parentOf(commandPid);
  const filePid = parentOf(driverPid);
  assert.notEqual(filePid, process.pid, 'the interrupted fixture run must not be this test process');
  owned.push(commandPid, helperPid, driverPid, filePid);
  // The interrupt kills the test file process, so its cleanup hook cannot run, and the driver, so no group kill
  // reaches the fixture helper. Only the deadline inside the fixture can still stop it.
  kill(filePid);
  kill(driverPid);
  assert.equal(await gone(helperPid), true, 'the fixture helper stops on its own deadline after the interrupt');
  assert.equal(await gone(commandPid), true, 'the fixture command stops on its own deadline after the interrupt');
});

test('an interrupted quota timeout run leaves no fixture probe behind', { timeout: 120000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-fixture-cleanup-quota-'));
  const owned = [];
  t.after(() => {
    for (const pid of owned) kill(pid);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const runner = startFixtureRun(t, 'test/quota-timeout.test.js', tmp);
  owned.push(runner.pid);
  const pidFile = await waitFor(() => findFile(tmp, 'probe.pid'), 30000);
  assert.ok(pidFile, 'the quota fixture probe wrote its pid before the interrupt');
  const probePid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(Number.isInteger(probePid) && probePid > 1, true, 'the quota fixture probe wrote a valid pid');
  const filePid = parentOf(probePid);
  assert.notEqual(filePid, process.pid, 'the interrupted fixture run must not be this test process');
  owned.push(probePid, filePid);
  assert.equal(isAlive(probePid), true, 'the quota fixture probe is alive at the interrupt');
  kill(filePid);
  assert.equal(await gone(probePid), true, 'the quota fixture probe stops on its own deadline after the interrupt');
});