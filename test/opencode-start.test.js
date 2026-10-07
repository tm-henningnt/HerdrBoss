import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { retryOpenCodeStart, withOpenCodeStartLock } from '../src/kit/opencode-start.js';

const CURRENT_START = 'Mon Sep 28 10:00:00 2026';
const STALE_START = 'Thu Jan 1 00:00:00 1970';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-opencode-lock-'));
  const folder = path.join(dir, 'opencode-start');
  fs.mkdirSync(folder);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, folder, owner: path.join(folder, 'owner.json') };
}

test('OpenCode start lock keeps a live owner even when its start is older than a minute', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.owner, JSON.stringify({ pid: process.pid, pidStart: CURRENT_START, token: 'live-start' }));
  fs.utimesSync(f.owner, new Date(0), new Date(0));
  assert.throws(() => withOpenCodeStartLock(f.dir, () => assert.fail('must not launch'), {
    timeoutMs: 0, output: () => {}, wait: () => assert.fail('no wait after the timeout'),
    readProcessStart: () => CURRENT_START,
  }), /start lock is still busy/);
  assert.equal(JSON.parse(fs.readFileSync(f.owner, 'utf8')).token, 'live-start');
});

test('OpenCode start lock refuses when the fake reader cannot verify a live owner', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.owner, JSON.stringify({ pid: process.pid, pidStart: CURRENT_START, token: 'live-start' }));
  assert.throws(() => withOpenCodeStartLock(f.dir, () => assert.fail('must not launch'), {
    timeoutMs: 0, output: () => {}, readProcessStart: () => null,
  }), /Cannot verify process start identity for the OpenCode start lock owner/);
  assert.equal(JSON.parse(fs.readFileSync(f.owner, 'utf8')).token, 'live-start');
});

test('OpenCode start lock records a valid fake process identity and recovers a stale PID', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.owner, JSON.stringify({ pid: process.pid, pidStart: STALE_START, token: 'old-process' }));
  assert.equal(withOpenCodeStartLock(f.dir, () => {
    const owner = JSON.parse(fs.readFileSync(f.owner, 'utf8'));
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.pidStart, CURRENT_START);
    assert.notEqual(owner.token, 'old-process');
    return 'recovered';
  }, { timeoutMs: 0, output: () => {}, readProcessStart: () => CURRENT_START }), 'recovered');
});

test('OpenCode start lock replaces corrupt and invalid owner records', (t) => {
  const f = fixture(t);
  for (const owner of ['{broken', 'null', '[]', '{}', JSON.stringify({ pid: process.pid, token: 'no-start' }),
    JSON.stringify({ pid: process.pid, pidStart: 7, token: 'invalid-start' })]) {
    fs.writeFileSync(f.owner, owner);
    assert.equal(withOpenCodeStartLock(f.dir, () => 'recovered', {
      timeoutMs: 0, output: () => {}, readProcessStart: () => CURRENT_START,
    }), 'recovered');
  }
});

test('OpenCode start wait counts mutation-guard time against its monotonic deadline', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.owner, JSON.stringify({ pid: process.pid, pidStart: CURRENT_START, token: 'live-start' }));
  let clock = 0;
  const guardBudgets = [];
  assert.throws(() => withOpenCodeStartLock(f.dir, () => assert.fail('must not launch after the deadline'), {
    timeoutMs: 300, now: () => clock, output: () => {},
    wait: () => assert.fail('the mutation guard already used the remaining wait'),
    mutationLock: (_dir, operation, options) => {
      guardBudgets.push(options.waitMs);
      clock += 350;
      return operation();
    },
    readProcessStart: () => CURRENT_START,
  }), /OpenCode start lock is still busy/);
  assert.deepEqual(guardBudgets, [300]);
});

test('OpenCode start lock replaces an unreadable owner record', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.owner, 'unreadable record', { mode: 0o000 });
  assert.throws(() => fs.readFileSync(f.owner, 'utf8'), { code: 'EACCES' });
  assert.equal(withOpenCodeStartLock(f.dir, () => {
    assert.equal(JSON.parse(fs.readFileSync(f.owner, 'utf8')).pidStart, CURRENT_START);
    return 'recovered';
  }, { timeoutMs: 0, output: () => {}, readProcessStart: () => CURRENT_START }), 'recovered');
});

test('OpenCode start lock releases after failure so the next start can run', (t) => {
  const f = fixture(t);
  const options = { readProcessStart: () => CURRENT_START };
  assert.throws(() => withOpenCodeStartLock(f.dir, () => { throw new Error('fake start failure'); }, options), /fake start failure/);
  assert.equal(withOpenCodeStartLock(f.dir, () => 'next start', options), 'next start');
  assert.equal(fs.existsSync(f.owner), false);
});

test('OpenCode start lock recovers an owner whose CLI process was killed', { timeout: 10000 }, async (t) => {
  const f = fixture(t);
  const source = `
    import fs from 'node:fs';
    import { withOpenCodeStartLock } from ${JSON.stringify(new URL('../src/kit/opencode-start.js', import.meta.url).href)};
    withOpenCodeStartLock(process.env.TEST_START_DIR, () => {
      process.send('locked');
      fs.readSync(0, Buffer.alloc(1), 0, 1);
    }, { readProcessStart: () => 'Mon Sep 28 10:00:00 2026' });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, TEST_START_DIR: f.dir }, stdio: ['pipe', 'ignore', 'pipe', 'ipc'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  assert.equal((await once(child, 'message'))[0], 'locked');
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  assert.equal(withOpenCodeStartLock(f.dir, () => 'recovered', {
    readProcessStart: () => CURRENT_START,
  }), 'recovered');
  assert.equal(fs.existsSync(f.owner), false);
});

test('OpenCode start lock keeps refusing when the real process identity reader is unavailable', (t) => {
  const f = fixture(t);
  const source = `
    import { withOpenCodeStartLock } from ${JSON.stringify(new URL('../src/kit/opencode-start.js', import.meta.url).href)};
    try {
      withOpenCodeStartLock(process.env.TEST_START_DIR, () => process.exit(3));
    } catch (error) {
      if (/Cannot read process start identity for the OpenCode start lock owner/.test(error.message)) process.exit(0);
      process.exit(2);
    }
    process.exit(4);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, TEST_START_DIR: f.dir, PATH: '' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, 'the default reader refuses when ps is unavailable');
});

test('OpenCode recovery stops when the agent lookup is invalid or unavailable', () => {
  for (const response of [null, {}, { agent: null }, new Error('fake transport failure')]) {
    let starts = 0;
    assert.throws(() => retryOpenCodeStart('demo', 'ws:p2', () => {
      starts++;
      throw new Error('fake launch failure');
    }, {
      herdr: (args) => {
        assert.deepEqual(args, ['agent', 'get', 'demo']);
        if (response instanceof Error) throw response;
        return response;
      }, output: () => {},
    }), /Relaunch stopped|Cannot verify the TUI/);
    assert.equal(starts, 1, 'an invalid lookup is not proof that the agent exited');
  }
});
