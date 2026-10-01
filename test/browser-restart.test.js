import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-browser-restart-'));
process.env.HERDR_BOSS_DIR = dir;
const pool = await import('../src/browser-pool.js');
const activity = await import('../src/browser-activity.js');
const preview = await import('../src/browser-preview.js');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function fixture(project, { hung = false, tabs = [] } = {}) {
  const profile = path.join(dir, 'browser-profiles', project);
  const sessions = pool.listBrowserSessions();
  sessions[project] = { project, port: 9223, profile, headless: true, launchedAt: '2026-09-30T10:00:00.000Z' };
  fs.writeFileSync(path.join(dir, 'browser-sessions.json'), JSON.stringify(sessions));
  let running = true;
  let relaunched = false;
  let port = 9223;
  const restored = [];
  const startupClosed = [];
  const options = {
    cloneDir: null, chromePath: process.execPath,
    collectBrowserClients: async () => 0,
    collectProcesses: async () => new Map(running ? [[4101, { pid: 4101, cmd: `Chrome --remote-debugging-port=${port} --user-data-dir=${profile} --headless` }]] : []),
    portOpen: async (actual) => running && Number(actual) === port,
    fetch: async () => {
      if (hung && !relaunched) throw new Error('version failed');
      return new Response('{}', { status: 200 });
    },
    closeViaCdp: async () => { running = false; },
    kill: () => { running = false; },
    spawn: (_chrome, args) => { port = Number(args.find((arg) => arg.startsWith('--remote-debugging-port=')).split('=')[1]); running = true; relaunched = true; return { pid: 4101, on() {}, unref() {} }; },
    preview: {
      listBrowserTabs: async () => { if (hung && !relaunched) throw new Error('list failed'); return relaunched ? [{ id: 'startup', url: 'about:blank' }] : tabs; },
      browserNewTab: async (_project, url) => { restored.push(url); return { id: `new-${restored.length}` }; },
      browserCloseTab: async (_project, id) => { startupClosed.push(id); },
    },
  };
  return { options, restored, startupClosed, running: () => running, relaunched: () => relaunched };
}

test('restart restores every open tab, including duplicate URLs, rather than only the selected page', async () => {
  const tabs = [{ id: 'one', url: 'https://sample.example.com/a?choice=1' },
    { id: 'two', url: 'https://sample.example.com/a?choice=1' }, { id: 'three', url: 'about:blank' }];
  const f = fixture('restore-all', { tabs });
  const result = await pool.restartBrowser('restore-all', true, { ...f.options, tabId: 'one' });
  assert.equal(result.restoredPage, true);
  assert.equal(result.restoredTabs, 3);
  assert.deepEqual(f.restored, tabs.map((tab) => tab.url));
  assert.deepEqual(f.startupClosed, ['startup'], 'the launch tab does not add a duplicate page');
  assert.doesNotMatch(JSON.stringify(result), /sample\.example\.com|choice=1/);
  const saved = pool.listBrowserSessions()['restore-all'].restoreTabs;
  assert.deepEqual(saved.map((tab) => tab.url), tabs.map((tab) => tab.url));
  assert.equal(fs.statSync(path.join(dir, 'browser-sessions.json')).mode & 0o777, 0o600);
});

test('a failed restore keeps its saved URL, restores the other tabs, and hides CDP errors', async () => {
  const tabs = [{ id: 'one', url: 'https://sample.example.com/one' }, { id: 'two', url: 'https://sample.example.com/two' }];
  const f = fixture('restore-partial', { tabs });
  f.options.preview.browserNewTab = async (_project, url) => {
    if (url.endsWith('/one')) throw new Error('Could not open https://sample.example.com/one with title Sample');
    return { id: 'new-two' };
  };
  const result = await pool.restartBrowser('restore-partial', true, f.options);
  assert.equal(result.restoredPage, false);
  assert.equal(result.restoredTabs, 1);
  assert.doesNotMatch(JSON.stringify(result), /sample\.example\.com|Sample/);
  assert.deepEqual(pool.listBrowserSessions()['restore-partial'].restoreTabs, [tabs[0], { id: 'new-two', url: tabs[1].url }]);
});

test('no-restore retains the saved addresses and creates no replacement tabs', async () => {
  const f = fixture('restore-disabled', { tabs: [{ id: 'one', url: 'https://sample.example.com/one' }] });
  pool.rememberBrowserTabs('restore-disabled', [{ id: 'saved', url: 'https://sample.example.com/saved' }]);
  const result = await pool.restartBrowser('restore-disabled', true, { ...f.options, restorePage: false });
  assert.equal(result.restoredPage, false);
  assert.deepEqual(f.restored, []);
  assert.deepEqual(f.startupClosed, []);
});

test('a hung browser restores the locally saved tab URLs', async () => {
  const f = fixture('restore-hung', { hung: true });
  pool.rememberBrowserTabs('restore-hung', [{ id: 'old', url: 'https://sample.example.com/saved?choice=2' }]);
  const result = await pool.restartBrowser('restore-hung', false, f.options);
  assert.equal(result.restoredPage, true);
  assert.equal(result.restoredTabs, 1);
  assert.deepEqual(f.restored, ['https://sample.example.com/saved?choice=2']);
});

test('restart refuses without closing or spawning while a command stays in flight', async () => {
  const f = fixture('restore-busy');
  let now = 1000;
  const opts = { dir, now: () => now };
  const command = activity.beginBrowserCommand('restore-busy', opts);
  try {
    await assert.rejects(pool.restartBrowser('restore-busy', true, { ...f.options,
      activity: { ...opts, wait: async (ms) => { now += ms; } },
    }), (error) => error.exitCode === 3 && /command.*in flight/.test(error.message));
    assert.equal(f.running(), true);
    assert.equal(f.relaunched(), false);
  } finally { activity.endBrowserCommand('restore-busy', command, opts); }
});

test('restart also refuses while a separate CDP client is connected', async () => {
  const f = fixture('external-client');
  let now = 1000;
  f.options.collectBrowserClients = async () => 1;
  await assert.rejects(pool.restartBrowser('external-client', true, { ...f.options,
    activity: { dir, now: () => now, wait: async (ms) => { now += ms; } },
  }), (error) => error.exitCode === 3 && /CDP client/.test(error.message));
  assert.equal(f.running(), true);
  assert.equal(f.relaunched(), false);
});

test('restart waits for a separate CDP client to disconnect', async () => {
  const f = fixture('external-finish');
  let now = 1000;
  let clients = 1;
  f.options.collectBrowserClients = async () => clients;
  const result = await pool.restartBrowser('external-finish', true, { ...f.options,
    activity: { now: () => now, wait: async (ms) => { now += ms; clients = 0; } },
  });
  assert.equal(f.relaunched(), true);
  assert.equal(result.responsive, true);
  assert.equal(now, 1100);
});

test('restart rechecks clients immediately before the close', async () => {
  const f = fixture('external-race');
  let calls = 0;
  f.options.collectBrowserClients = async () => calls++ ? 1 : 0;
  await assert.rejects(pool.restartBrowser('external-race', true, f.options), (error) => error.exitCode === 3 && /before the close/.test(error.message));
  assert.equal(f.running(), true);
  assert.equal(f.relaunched(), false);
});

test('the restored-tab path creates a separate background window', async () => {
  const f = fixture('own-window');
  const calls = [];
  const result = await preview.browserNewTab('own-window', 'https://sample.example.com/page', {
    verifySession: async () => ({ port: 9223 }),
    browserEndpoint: async () => 'ws://127.0.0.1:9223/devtools/browser/fake',
    command: async (...call) => { calls.push(call); return { targetId: 'own-tab' }; },
  });
  assert.equal(result.id, 'own-tab');
  assert.deepEqual(calls[0], ['ws://127.0.0.1:9223/devtools/browser/fake', 'Target.createTarget', {
    url: 'https://sample.example.com/page', newWindow: true, background: true,
  }]);
  assert.deepEqual(pool.listBrowserSessions()['own-window'].restoreTabs, [{ id: 'own-tab', url: 'https://sample.example.com/page' }]);
});
