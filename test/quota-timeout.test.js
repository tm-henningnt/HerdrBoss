import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectQuotas, runQuotaCommand } from '../src/collect.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-quota-timeout-'));
  const pidFile = path.join(dir, 'probe.pid');
  const signalFile = path.join(dir, 'signal');
  t.after(() => {
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, pidFile, signalFile };
}

test('a hung quota probe receives SIGTERM and exits before the timeout rejection', { timeout: 10000 }, async (t) => {
  const { pidFile, signalFile } = fixture(t);
  const script = `
    const fs = require('node:fs');
    process.on('SIGTERM', () => {
      fs.writeFileSync(process.argv[2], 'SIGTERM');
      process.exit(0);
    });
    fs.writeFileSync(process.argv[1], String(process.pid));
    setInterval(() => {}, 60000);
  `;
  let failure;
  await assert.rejects(runQuotaCommand(process.execPath, ['-e', script, pidFile, signalFile], { timeout: 1000 }), (error) => {
    failure = error;
    return /timed out/.test(error.message);
  });
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(fs.readFileSync(signalFile, 'utf8'), 'SIGTERM', 'the probe gets a graceful termination before SIGKILL');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the owned probe PID is gone before rejection');
  assert.equal(failure.killedPid, pid);
  assert.equal(failure.killedPidState, 'exited');
  assert.equal(failure.signal, 'SIGTERM');
});

test('a Claude timeout kills its hung child before one 90-second retry and records both attempts', { timeout: 15000 }, async (t) => {
  const { dir, pidFile, signalFile } = fixture(t);
  const historyFile = path.join(dir, 'quota-probe-history.jsonl');
  const script = `
    const fs = require('node:fs');
    process.on('SIGTERM', () => fs.writeFileSync(process.argv[2], String(Date.now())));
    fs.writeFileSync(process.argv[1], String(process.pid));
    setInterval(() => {}, 60000);
  `;
  const calls = [];
  let failure;
  const runner = async (_cmd, args, options) => {
    const provider = args.at(-1);
    calls.push({ provider, timeout: options.timeout });
    if (provider === 'claude' && calls.filter((call) => call.provider === provider).length === 1) {
      try { return await runQuotaCommand(process.execPath, ['-e', script, pidFile, signalFile], options); }
      catch (error) { failure = error; throw error; }
    }
    if (provider === 'claude') {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'retry starts only after the first owned child has exited');
    }
    return JSON.stringify([{ provider, usage: { primary: { usedPercent: 12 } } }]);
  };
  const quotas = await collectQuotas({ runner, timeouts: { claude: 1000 }, historyFile });
  assert.deepEqual(calls.filter((call) => call.provider === 'claude'), [
    { provider: 'claude', timeout: 1000 }, { provider: 'claude', timeout: 90000 },
  ]);
  assert.equal(quotas.find((row) => row.provider === 'claude').windows[0].usedPercent, 12);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.ok(Date.now() - Number(fs.readFileSync(signalFile, 'utf8')) >= 2900, 'SIGKILL follows the three-second grace period');
  assert.equal(failure.signal, 'SIGKILL');
  const attempts = fs.readFileSync(historyFile, 'utf8').trim().split('\n').map(JSON.parse).filter((row) => row.provider === 'claude');
  assert.deepEqual(attempts.map(({ timeoutMs, outcome, killedPid, killedPidState, killSignal, retry }) => ({ timeoutMs, outcome, killedPid, killedPidState, killSignal, retry })), [
    { timeoutMs: 1000, outcome: 'timeout', killedPid: pid, killedPidState: 'exited', killSignal: 'SIGKILL', retry: false },
    { timeoutMs: 90000, outcome: 'success', killedPid: null, killedPidState: null, killSignal: null, retry: true },
  ]);
});

test('a Claude timeout with an unconfirmed child exit records the PID state and prevents an overlapping retry', async (t) => {
  const { dir } = fixture(t);
  for (const killedPidState of ['alive', 'unknown']) {
    const calls = [];
    const historyFile = path.join(dir, `${killedPidState}.jsonl`);
    const runner = async (_cmd, args) => {
      const provider = args.at(-1);
      calls.push(provider);
      if (provider === 'claude') throw Object.assign(new Error('private raw probe output'), {
        killed: true, signal: 'SIGKILL', killedPid: 12345, killedPidState,
      });
      return JSON.stringify([{ provider, usage: { primary: { usedPercent: 12 } } }]);
    };
    const quotas = await collectQuotas({ runner, historyFile });
    assert.deepEqual(calls, ['codex', 'claude', 'opencodego']);
    assert.match(quotas.find((row) => row.provider === 'claude').error, /timed out after 60 s/);
    const history = fs.readFileSync(historyFile, 'utf8');
    assert.doesNotMatch(history, /private raw probe output/);
    const attempt = history.trim().split('\n').map(JSON.parse).find((row) => row.provider === 'claude');
    assert.equal(attempt.killedPid, 12345);
    assert.equal(attempt.killedPidState, killedPidState);
    assert.equal(attempt.retry, false);
  }
});

test('a Claude probe error without a timeout waits for the next quota interval', async (t) => {
  const { dir } = fixture(t);
  const calls = [];
  const runner = async (_cmd, args) => {
    const provider = args.at(-1);
    calls.push(provider);
    if (provider === 'claude') throw Object.assign(new Error('probe failed'), { code: 2, stderr: 'login expired' });
    return JSON.stringify([{ provider, usage: { primary: { usedPercent: 12 } } }]);
  };
  const quotas = await collectQuotas({ runner, historyFile: path.join(dir, 'quota-probe-history.jsonl') });
  assert.deepEqual(calls, ['codex', 'claude', 'opencodego']);
  assert.match(quotas.find((row) => row.provider === 'claude').error, /exited with code 2: login expired/);
});
