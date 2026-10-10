import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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

test('OpenCode start lock waits for a fresh live owner when its process identity is unreadable', (t) => {
  const f = fixture(t);
  for (const pidStart of [CURRENT_START, null]) {
    const token = randomUUID();
    fs.writeFileSync(f.owner, JSON.stringify({ pid: process.pid, pidStart, token }));
    const mtimeMs = fs.statSync(f.owner).mtimeMs;
    assert.throws(() => withOpenCodeStartLock(f.dir, () => assert.fail('must not launch'), {
      timeoutMs: 0, output: () => {}, wait: () => assert.fail('no wait after the timeout'),
      readProcessStart: () => null,
    }), /start lock is still busy/);
    assert.equal(JSON.parse(fs.readFileSync(f.owner, 'utf8')).token, token);
    assert.equal(fs.statSync(f.owner).mtimeMs, mtimeMs, 'a waiter must not renew the owner record');
  }
});

test('OpenCode start lock keeps unreadable owner proof when signal-0 returns EPERM', (t) => {
  const f = fixture(t);
  const token = randomUUID();
  fs.writeFileSync(f.owner, JSON.stringify({ pid: process.pid, pidStart: null, token }));
  const signal = t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(pid, process.pid);
    assert.equal(signal, 0);
    throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
  });
  assert.throws(() => withOpenCodeStartLock(f.dir, () => assert.fail('must not launch'), {
    timeoutMs: 0, output: () => {}, readProcessStart: () => null,
  }), /start lock is still busy/);
  assert.equal(signal.mock.callCount(), 1);
  assert.equal(JSON.parse(fs.readFileSync(f.owner, 'utf8')).token, token);
});

test('OpenCode start lock keeps unknown owner proof after five minutes', (t) => {
  const f = fixture(t);
  const mtimeMs = Date.parse('2026-10-10T10:00:00Z');
  const token = randomUUID();
  fs.writeFileSync(f.owner, JSON.stringify({ pid: process.pid, pidStart: CURRENT_START, token }));
  fs.utimesSync(f.owner, new Date(mtimeMs), new Date(mtimeMs));
  const options = { timeoutMs: 0, output: () => {}, readProcessStart: () => null };
  assert.throws(() => withOpenCodeStartLock(f.dir, () => assert.fail('must not launch at the limit'), {
    ...options, wallNow: () => mtimeMs + 300_000,
  }), /start lock is still busy/);
  assert.equal(JSON.parse(fs.readFileSync(f.owner, 'utf8')).token, token);
  assert.throws(() => withOpenCodeStartLock(f.dir, () => assert.fail('unknown must remain held'), {
    ...options, wallNow: () => mtimeMs + 300_001,
  }), /start lock is still busy/);
  assert.equal(JSON.parse(fs.readFileSync(f.owner, 'utf8')).token, token);
});

test('OpenCode start lock uses service liveness before sandbox signal probes', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.owner, JSON.stringify({ pid: 501, pidStart: CURRENT_START, token: 'owner' }));
  t.mock.method(process, 'kill', () => assert.fail('Sandbox PID probe must not run'));
  assert.equal(withOpenCodeStartLock(f.dir, () => 'started', {
    timeoutMs: 0, readProcessFacts: () => ({ known: true, alive: false, start: null }),
    readProcessStart: () => CURRENT_START,
  }), 'started');
});

test('service facts keep unknown or matching lock owners and recover a reused PID', (t) => {
  const f = fixture(t);
  t.mock.method(process, 'kill', () => assert.fail('Sandbox PID probe must not run'));
  const owner = { pid: 501, pidStart: CURRENT_START, token: 'owner' };
  for (const facts of [{ known: false, reason: 'unavailable' }, { known: true, alive: true, start: CURRENT_START }]) {
    fs.writeFileSync(f.owner, JSON.stringify(owner));
    fs.utimesSync(f.owner, new Date(0), new Date(0));
    assert.throws(() => withOpenCodeStartLock(f.dir, () => assert.fail('owner must stay held'), {
      timeoutMs: 0, output: () => {}, readProcessFacts: () => facts, readProcessStart: () => CURRENT_START,
    }), /start lock is still busy/);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.owner, 'utf8')), owner);
  }
  assert.equal(withOpenCodeStartLock(f.dir, () => 'recovered', {
    timeoutMs: 0, output: () => {}, readProcessFacts: () => ({ known: true, alive: true, start: STALE_START }),
    readProcessStart: () => CURRENT_START,
  }), 'recovered');
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

test('OpenCode start lock release preserves a foreign token or PID without process identity', (t) => {
  const f = fixture(t);
  for (const changed of ['token', 'pid']) {
    let replacement;
    assert.equal(withOpenCodeStartLock(f.dir, () => {
      replacement = JSON.parse(fs.readFileSync(f.owner, 'utf8'));
      if (changed === 'token') replacement.token = randomUUID();
      else replacement.pid = process.ppid;
      fs.writeFileSync(f.owner, JSON.stringify(replacement));
      return 'started';
    }, { readProcessStart: () => null }), 'started');
    assert.equal(fs.existsSync(f.owner), true, `release must preserve a foreign ${changed}`);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.owner, 'utf8')), replacement);
    fs.unlinkSync(f.owner);
  }
});

test('OpenCode start lock recovers a dead PID without process identity', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.owner, JSON.stringify({ pid: 501, pidStart: null, token: 'dead-owner' }));
  const probe = t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(pid, 501); assert.equal(signal, 0);
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  assert.equal(withOpenCodeStartLock(f.dir, () => 'recovered', {
    readProcessStart: () => null,
  }), 'recovered');
  assert.equal(probe.mock.callCount(), 1);
  assert.equal(fs.existsSync(f.owner), false);
});

test('OpenCode start lock runs and releases when the real process identity reader is unavailable', (t) => {
  const f = fixture(t);
  const source = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import { withOpenCodeStartLock } from ${JSON.stringify(new URL('../src/kit/opencode-start.js', import.meta.url).href)};
    const file = path.join(process.env.TEST_START_DIR, 'opencode-start', 'owner.json');
    assert.equal(withOpenCodeStartLock(process.env.TEST_START_DIR, () => {
      const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(owner.pid, process.pid);
      assert.equal(owner.pidStart, null);
      assert.ok(owner.token);
      return 'started';
    }), 'started');
    assert.equal(fs.existsSync(file), false);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, TEST_START_DIR: f.dir, PATH: '' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, 'the default reader can use the PID and token when ps is unavailable');
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
