import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');
const runnerPath = path.join(repoRoot, 'scripts', 'test.js');

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitFor(condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = condition();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return condition();
}

test('the test runner times out one file, reports elapsed time, and continues queued files', { timeout: 10000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-test-runner-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const hangPidFile = path.join(tmp, 'hang.pid');
  const firstDone = path.join(tmp, 'first.done');
  const queuedDone = path.join(tmp, 'queued.done');
  const hangFile = path.join(tmp, 'a-hangs.test.js');
  const firstFile = path.join(tmp, 'b-first.test.js');
  const queuedFile = path.join(tmp, 'c-queued.test.js');
  fs.writeFileSync(hangFile, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(hangPidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`);
  fs.writeFileSync(firstFile, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(firstDone)}, 'done');\n`);
  fs.writeFileSync(queuedFile, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(queuedDone)}, 'done');\n`);

  const env = { ...process.env, HERDR_BOSS_TEST_TIMEOUT_MS: '2500', TMPDIR: tmp };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [runnerPath, '--', hangFile, firstFile, queuedFile], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  const closed = once(child, 'close');
  let fixturePid = null;
  t.after(async () => {
    if (fs.existsSync(hangPidFile)) fixturePid = Number(fs.readFileSync(hangPidFile, 'utf8'));
    if (Number.isInteger(fixturePid) && processExists(fixturePid)) process.kill(fixturePid, 'SIGKILL');
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await closed;
    if (Number.isInteger(fixturePid) && processExists(fixturePid)) process.kill(fixturePid, 'SIGKILL');
  });

  let safetyTimer;
  const result = await Promise.race([
    closed.then(([code, signal]) => ({ code, signal })),
    new Promise((resolve) => { safetyTimer = setTimeout(() => resolve(null), 10000); }),
  ]);
  clearTimeout(safetyTimer);
  if (!result) {
    if (fs.existsSync(hangPidFile)) {
      fixturePid = Number(fs.readFileSync(hangPidFile, 'utf8'));
      if (Number.isInteger(fixturePid) && processExists(fixturePid)) process.kill(fixturePid, 'SIGKILL');
    }
    child.kill('SIGTERM');
    assert.fail(`test runner did not finish after its file timeout; output: ${output}`);
  }
  assert.ok(fs.existsSync(hangPidFile), `the hanging fixture started; output: ${output}`);
  fixturePid = Number(fs.readFileSync(hangPidFile, 'utf8'));

  assert.notEqual(result.code, 0, 'a timed-out test file makes the runner fail');
  assert.match(output, /a-hangs\.test\.js[^\n]*elapsed \d+ ms \(limit 2500 ms\)/i, 'the summary names the timed-out file, elapsed time, and configured limit');
  assert.equal(fs.readFileSync(firstDone, 'utf8'), 'done');
  assert.equal(fs.readFileSync(queuedDone, 'utf8'), 'done', 'the runner starts queued files after a timeout');
  assert.equal(await waitFor(() => !processExists(fixturePid), 1000), true, 'the timed-out file process stops');
});

test('the Settings view tests release their client store refresh timers', { timeout: 10000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-settings-runner-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const env = { ...process.env, HERDR_BOSS_TEST_TIMEOUT_MS: '2500', TMPDIR: tmp };
  delete env.NODE_TEST_CONTEXT;
  let child;
  let closed;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (closed) await closed;
  });
  for (const file of ['test/settings-pools.test.js', 'test/settings-render.test.js']) {
    child = spawn(process.execPath, [runnerPath, '--', file], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    closed = once(child, 'close');
    const [code] = await closed;
    assert.equal(code, 0, `${file}: ${output}`);
    assert.doesNotMatch(output, /Test file timeout summary/, file);
  }
});
