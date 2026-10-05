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
// A fixture child has a lifetime of its own, so a fixture run that ends by itself is not a fixture bug. The doctor
// fixture command also stops at its own 2000 ms command timeout, and the quota fixture probe stops at its own 1000 ms
// probe timeout. A loaded machine can spend that time before this test reads the pids of the run. The test therefore
// retries the whole run in a fresh folder when it could not catch the pids in time.
const maxAttempts = 3;
// Debug hook. Set HERDR_BOSS_FIXTURE_READ_DELAY_MS to stall the pid read of the first attempt by that many
// milliseconds. The stall shows the race on an idle machine. Only the first attempt stalls, so a retry still catches
// the fixture processes and the run ends with the real result.
const firstAttemptDelayMs = Number(process.env.HERDR_BOSS_FIXTURE_READ_DELAY_MS || 0);
const delay = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

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

// Reads the whole process table in one call. The call is one snapshot, so a pid that leaves the table cannot make two
// reads of the same pid disagree. The table maps each pid to the pid of its parent.
function readProcessTable() {
  let output;
  try {
    output = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  } catch (error) {
    // ps exits with 1 when the command runs but the selection is empty. That cannot happen for the whole table.
    if (error.status === 1) return new Map();
    throw error;
  }
  const table = new Map();
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (match) table.set(Number(match[1]), Number(match[2]));
  }
  return table;
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

// Runs one fixture attempt and reads its pids from one process table snapshot. The attempt owns only pids that it read
// from its own fixture files and that the snapshot holds. Its cleanup hook stops exactly those pids and removes its
// own folder, so a failed attempt leaves no child and no pipe behind.
async function fixtureAttempt(t, spec, attemptNumber) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), spec.prefix));
  const owned = new Set();
  t.after(() => {
    for (const pid of owned) kill(pid);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const runner = startFixtureRun(t, spec.testFile, tmp);
  owned.add(runner.pid);
  const readyFile = await waitFor(() => findFile(tmp, spec.readyName), 30000);
  if (!readyFile) return { reason: `the fixture run never wrote ${spec.readyName}` };
  let pids;
  try {
    pids = spec.roots(fs.readFileSync(readyFile, 'utf8'));
  } catch (error) {
    return { reason: `the fixture run removed ${spec.readyName} before the interrupt: ${error.message}` };
  }
  if (attemptNumber === 1) await delay(firstAttemptDelayMs);
  // One read of the process table. Every pid that the test uses comes from this snapshot, so a slow machine cannot
  // make the test read a parent of a pid that already left the table.
  const table = readProcessTable();
  for (const [name, parentName] of spec.links) {
    const parent = table.get(pids[parentName]);
    if (!Number.isInteger(parent) || parent <= 1) return { reason: `the ${parentName} process left the table before the interrupt` };
    pids[name] = parent;
  }
  if (Object.values(pids).some((pid) => pid === process.pid)) return { reason: 'the fixture run reported this test process as a fixture pid' };
  if (Object.values(pids).some((pid) => !table.has(pid))) return { reason: 'a fixture pid left the process table before the interrupt' };
  // Only a pid that the snapshot holds is a pid that this attempt read from its own fixture run. This test process never
  // enters the owned set, so the cleanup hook cannot kill it.
  for (const pid of Object.values(pids)) owned.add(pid);
  return { pids, owned };
}

// Runs a fixture run until one attempt catches its processes alive, and then hands the pids to the interrupt check.
// A retry starts a fresh run in a fresh folder. The run fails only when no attempt catches the processes.
async function withFixtureRun(t, spec, interrupt) {
  const reasons = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await fixtureAttempt(t, spec, attempt);
    if (result.reason) {
      reasons.push(`attempt ${attempt}: ${result.reason}`);
      continue;
    }
    await interrupt(result.pids);
    return;
  }
  assert.fail(`no attempt of ${maxAttempts} caught the ${spec.testFile} processes alive. ${reasons.join(' ')}`);
}

const doctorRun = {
  prefix: 'herdr-fixture-cleanup-doctor-',
  testFile: 'test/doctor-process.test.js',
  readyName: 'ready.json',
  // The fixture shim names itself and its helper. Each following entry reads the parent of the entry before it.
  roots: (text) => {
    const { parent: command, helper } = JSON.parse(text);
    return { command, helper };
  },
  links: [['driver', 'command'], ['file', 'driver']],
};

const quotaRun = {
  prefix: 'herdr-fixture-cleanup-quota-',
  testFile: 'test/quota-timeout.test.js',
  readyName: 'probe.pid',
  // The quota probe writes its own pid. The test file process of the child runner is its parent.
  roots: (text) => ({ probe: Number(text) }),
  links: [['file', 'probe']],
};

test('an interrupted doctor command run leaves no fixture helper behind', { timeout: 300000 }, async (t) => {
  await withFixtureRun(t, doctorRun, async ({ command, helper, driver, file }) => {
    assert.equal(isAlive(command), true, 'the fixture command is alive at the interrupt');
    assert.equal(isAlive(helper), true, 'the fixture helper is alive at the interrupt');
    // The interrupt kills the test file process, so its cleanup hook cannot run, and the driver, so no group kill
    // reaches the fixture helper. Only the deadline inside the fixture can still stop it.
    kill(file);
    kill(driver);
    assert.equal(await gone(helper), true, 'the fixture helper stops on its own deadline after the interrupt');
    assert.equal(await gone(command), true, 'the fixture command stops on its own deadline after the interrupt');
  });
});

test('an interrupted quota timeout run leaves no fixture probe behind', { timeout: 300000 }, async (t) => {
  await withFixtureRun(t, quotaRun, async ({ probe, file }) => {
    assert.equal(Number.isInteger(probe) && probe > 1, true, 'the quota fixture probe wrote a valid pid');
    assert.equal(isAlive(probe), true, 'the quota fixture probe is alive at the interrupt');
    kill(file);
    assert.equal(await gone(probe), true, 'the quota fixture probe stops on its own deadline after the interrupt');
  });
});