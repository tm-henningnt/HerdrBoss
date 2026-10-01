import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-browser-activity-'));
process.env.HERDR_BOSS_DIR = dir;
const activity = await import('../src/browser-activity.js');
const preview = await import('../src/browser-preview.js');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a screenshot stays in flight through capture and clears after a failure', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const work = preview.browserScreenshot('alpha', 'tab-one', {
    verifySession: async () => ({ port: 45678 }),
    listTargets: async () => [{ id: 'tab-one', webSocketDebuggerUrl: 'ws://127.0.0.1:45678/devtools/page/one' }],
    listViewports: () => ({}),
    commands: async () => { entered(); await gate; throw new Error('capture failed'); },
  });
  await started;
  try { assert.equal(activity.browserCommandActivity('alpha').inFlight, 1); }
  finally { release(); await assert.rejects(work, /capture failed/); }
  const state = activity.browserCommandActivity('alpha');
  assert.equal(state.inFlight, 0);
  assert.ok(state.lastCommandAt > 0);
});

test('overlapping commands keep separate records and use the fake activity clock', async () => {
  let now = 1000;
  const options = { dir, now: () => now };
  const first = activity.beginBrowserCommand('beta', options);
  now = 2000;
  const second = activity.beginBrowserCommand('beta', options);
  assert.equal(activity.browserCommandActivity('beta', options).inFlight, 2);
  now = 3000;
  activity.endBrowserCommand('beta', first, options);
  assert.equal(activity.browserCommandActivity('beta', options).inFlight, 1);
  now = 4000;
  activity.endBrowserCommand('beta', second, options);
  assert.deepEqual(activity.browserCommandActivity('beta', options), { inFlight: 0, lastCommandAt: 4000, restarting: false });
});

test('restart waits for a command, excludes new commands, then releases the reservation', async () => {
  let now = 1000;
  const options = { dir, now: () => now };
  const command = activity.beginBrowserCommand('gamma', options);
  let waits = 0;
  const result = await activity.withBrowserRestart('gamma', async (restartId) => {
    assert.equal(activity.browserCommandActivity('gamma', options).inFlight, 0);
    assert.throws(() => activity.beginBrowserCommand('gamma', options), /restart/);
    const own = activity.beginBrowserCommand('gamma', { ...options, restartId });
    activity.endBrowserCommand('gamma', own, options);
    return 'restarted';
  }, { ...options, wait: async () => { waits++; now += 100; activity.endBrowserCommand('gamma', command, options); } });
  assert.equal(result, 'restarted');
  assert.equal(waits, 1);
  assert.equal(activity.browserCommandActivity('gamma', options).restarting, false);
});

test('restart refuses after 30 seconds and leaves the active command alone', async () => {
  let now = 1000;
  const options = { dir, now: () => now };
  const command = activity.beginBrowserCommand('delta', options);
  let closed = false;
  await assert.rejects(activity.withBrowserRestart('delta', async () => { closed = true; }, {
    ...options, wait: async (ms) => { now += ms; },
  }), (error) => error.exitCode === 3 && /30 seconds.*command.*in flight/i.test(error.message));
  assert.equal(now, 31_000);
  assert.equal(closed, false);
  assert.equal(activity.browserCommandActivity('delta', options).inFlight, 1);
  assert.equal(activity.browserCommandActivity('delta', options).restarting, false);
  activity.endBrowserCommand('delta', command, options);
});

test('a second restart cannot enter, and an error releases the first reservation', async () => {
  await assert.rejects(activity.withBrowserRestart('exclusive', async () => {
    await assert.rejects(activity.withBrowserRestart('exclusive', async () => {}), (error) => error.exitCode === 3);
    throw new Error('launch failed');
  }), /launch failed/);
  assert.equal(activity.browserCommandActivity('exclusive').restarting, false);
});

test('activity reclaims a command only after its process is known to have exited', () => {
  const id = activity.beginBrowserCommand('exited');
  assert.equal(activity.browserCommandActivity('exited', { isAlive: () => true }).inFlight, 1);
  assert.equal(activity.browserCommandActivity('exited', { isAlive: () => false }).inFlight, 0);
  activity.endBrowserCommand('exited', id);
});

test('an unknown external client count refuses the restart', async () => {
  let now = 1000;
  let restarted = false;
  await assert.rejects(activity.withBrowserRestart('unknown-clients', async () => { restarted = true; }, {
    now: () => now, wait: async (ms) => { now += ms; }, externalClients: async () => null,
  }), (error) => error.exitCode === 3);
  assert.equal(restarted, false);
});

test('a command in a separate CLI process is visible until that process finishes', async () => {
  const script = `import { beginBrowserCommand, endBrowserCommand } from ${JSON.stringify(new URL('../src/browser-activity.js', import.meta.url).href)};
    const id = beginBrowserCommand('separate-process');
    process.send('started');
    process.once('message', () => { endBrowserCommand('separate-process', id); process.disconnect(); });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, HOME: dir, HERDR_BOSS_DIR: dir },
  });
  const ended = once(child, 'exit');
  try {
    await once(child, 'message');
    assert.equal(activity.browserCommandActivity('separate-process').inFlight, 1);
  } finally { child.send('finish'); await ended; }
  assert.equal(activity.browserCommandActivity('separate-process').inFlight, 0);
});


test('activity reads create no directories or records for an unknown browser', () => {
  const missing = path.join(dir, 'missing-store');
  assert.deepEqual(activity.browserCommandActivity('unknown', { dir: missing }), { inFlight: 0, lastCommandAt: null, restarting: false });
  assert.equal(fs.existsSync(missing), false);
});

test('activity reads ignore dead owners without locking or rewriting the store', () => {
  const id = activity.beginBrowserCommand('read-only');
  const file = path.join(dir, 'browser-activity.json');
  const before = fs.readFileSync(file, 'utf8');
  const inode = fs.statSync(file).ino;
  assert.equal(activity.browserCommandActivity('read-only', { isAlive: () => false }).inFlight, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.statSync(file).ino, inode);
  activity.endBrowserCommand('read-only', id);
});

test('forgetting the last agent tab deletes an empty project but preserves active commands', () => {
  const file = path.join(dir, 'browser-activity.json');
  activity.recordAgentBrowserTab('empty-tabs', 'last');
  activity.forgetAgentBrowserTab('empty-tabs', 'last');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))['empty-tabs'], undefined);
  activity.forgetAgentBrowserTab('missing-tabs', 'unknown');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))['missing-tabs'], undefined);
  const command = activity.beginBrowserCommand('active-tabs');
  activity.recordAgentBrowserTab('active-tabs', 'last');
  activity.forgetAgentBrowserTab('active-tabs', 'last');
  assert.equal(activity.browserCommandActivity('active-tabs').inFlight, 1);
  activity.endBrowserCommand('active-tabs', command);
});
