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
    { id: 'two', url: 'https://sample.example.com/a?choice=1#fake-fragment' }, { id: 'three', url: 'about:blank' }];
  const f = fixture('restore-all', { tabs });
  const result = await pool.restartBrowser('restore-all', true, { ...f.options, tabId: 'one' });
  assert.equal(result.restoredPage, true);
  assert.equal(result.restoredTabs, 3);
  assert.deepEqual(f.restored, ['https://sample.example.com/a', 'https://sample.example.com/a', 'about:blank']);
  assert.deepEqual(f.startupClosed, ['startup'], 'the launch tab does not add a duplicate page');
  assert.doesNotMatch(JSON.stringify(result), /sample\.example\.com|choice=1/);
  const saved = pool.listBrowserSessions()['restore-all'].restoreTabs;
  assert.deepEqual(saved.map((tab) => tab.url), f.restored);
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
  assert.deepEqual(f.restored, ['https://sample.example.com/saved']);
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

const authUrls = [
  ...['authorize', 'connect/authorize', 'signin-oidc', 'sso', 'saml', 'oauth2/callback', 'login.html',
    'sign-in', 'logon', 'authenticate', 'log-in', 'log-on', 'sign-on', 'signon', 'oidc', 'openid',
    'connect', 'consent', 'token', 'nested/LOGIN.HTML', 'login;jsessionid=FAKE',
    '%256cogin', '%25256cogin', '%252561uthorize', '%252Flogin', 'docs%255Cauthorize',
    'docs/%ZZ', 'docs/%E0%A4%A', 'docs/%25ZZ', 'docs/%2525ZZ', '%25252561uthorize',
  ].map((part) => `https://sample.example.com/${part}?code=FAKE_CODE#FAKE_FRAGMENT`),
  ...['login', 'accounts', 'sso', 'auth', 'id', 'idp', 'signin', 'adfs'].map((label) =>
    `https://${label}.sample.example.com/page?code=FAKE_CODE#FAKE_FRAGMENT`),
  'https://login.microsoftonline.com/page?code=FAKE_CODE#FAKE_FRAGMENT',
  'https://LOGIN.sample.example.com/page?code=FAKE_CODE#FAKE_FRAGMENT',
];

const unsafeTabs = [
  { id: 'safe', url: 'https://sample.example.com/page?code=FAKE_CODE#FAKE_FRAGMENT' },
  ...['callback', 'oauth', 'login', 'auth', 'signin', 'nested/Callback', '%61uth'].map((part, index) => ({
    id: `login-${index}`, url: `https://sample.example.com/${part}?code=FAKE_CODE#FAKE_FRAGMENT`,
  })),
];
const safeTabs = [{ id: 'safe', url: 'https://sample.example.com/page' }];
unsafeTabs.push(...authUrls.map((url, index) => ({ id: `auth-case-${index}`, url })));

test('saved snapshots and individual updates drop query strings, fragments, and login or callback pages', () => {
  fixture('safe-snapshot');
  pool.rememberBrowserTabs('safe-snapshot', unsafeTabs);
  assert.deepEqual(pool.listBrowserSessions()['safe-snapshot'].restoreTabs, safeTabs);
  pool.rememberBrowserTab('safe-snapshot', 'safe', 'https://sample.example.com/callback?code=FAKE_CODE');
  assert.deepEqual(pool.listBrowserSessions()['safe-snapshot'].restoreTabs, [], 'navigation to a callback removes the prior saved address');
  pool.rememberBrowserTab('safe-snapshot', 'ordinary', 'https://sample.example.com/article?choice=1#fake');
  assert.deepEqual(pool.listBrowserSessions()['safe-snapshot'].restoreTabs, [{ id: 'ordinary', url: 'https://sample.example.com/article' }]);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'browser-sessions.json'), 'utf8'), /FAKE_CODE|FAKE_FRAGMENT|choice=/);
});

test('a hung browser sanitizes a legacy snapshot again before restore and replaces unsafe storage', async () => {
  const f = fixture('legacy-snapshot', { hung: true });
  const sessions = pool.listBrowserSessions();
  sessions['legacy-snapshot'].restoreTabs = unsafeTabs;
  fs.writeFileSync(path.join(dir, 'browser-sessions.json'), JSON.stringify(sessions));
  await pool.restartBrowser('legacy-snapshot', true, f.options);
  assert.deepEqual(f.restored, [safeTabs[0].url]);
  assert.deepEqual(pool.listBrowserSessions()['legacy-snapshot'].restoreTabs, [{ id: 'new-1', url: safeTabs[0].url }]);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'browser-sessions.json'), 'utf8'), /FAKE_CODE|FAKE_FRAGMENT/);
});

test('explicit tab navigation keeps its URL but saves only a safe restore address', async () => {
  fixture('safe-new-tab');
  const opened = [];
  const adapters = {
    verifySession: async () => ({ port: 9223 }),
    browserEndpoint: async () => 'ws://127.0.0.1:9223/devtools/browser/fake',
    command: async (_endpoint, _method, params) => { opened.push(params.url); return { targetId: `new-${opened.length}` }; },
  };
  for (const tab of unsafeTabs.slice(0, 2)) await preview.browserNewTab('safe-new-tab', tab.url, adapters);
  assert.deepEqual(opened, unsafeTabs.slice(0, 2).map((tab) => tab.url));
  assert.deepEqual(pool.listBrowserSessions()['safe-new-tab'].restoreTabs, [{ id: 'new-1', url: safeTabs[0].url }]);
});

test('the Engine onTabs callback saves sanitized addresses', async () => {
  const { Engine } = await import('../src/engine.js');
  const { loadConfig } = await import('../src/config.js');
  fixture('engine-snapshot');
  const session = pool.listBrowserSessions()['engine-snapshot'];
  const engine = new Engine(loadConfig(), { push: false, act: false, collectors: {
    probeBrowser: async (_port, options) => { options.onTabs(unsafeTabs); return { ok: true }; },
  } });
  engine.browserProbes.tick({ key: `${session.project}:${session.port}:${session.launchedAt}`, project: session.project, port: session.port, active: true });
  await engine.browserProbes.idle();
  assert.deepEqual(pool.listBrowserSessions()['engine-snapshot'].restoreTabs, safeTabs);
});

test('post-launch tab reads and partial restores never overwrite the saved snapshot in progress', async () => {
  const tabs = [{ id: 'old-one', url: 'https://sample.example.com/one' }, { id: 'old-two', url: 'https://sample.example.com/two' }];
  const f = fixture('snapshot-in-progress', { tabs });
  const originalFetch = globalThis.fetch;
  const originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = class { constructor() { throw new Error('fake page endpoint unavailable'); } };
  globalThis.fetch = async () => new Response(JSON.stringify([{ id: 'startup', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/startup' }]), { status: 200 });
  let snapshotAfterListing;
  const snapshotsAtCreate = [];
  let snapshotAtClose;
  try {
    f.options.preview.listBrowserTabs = async (project, adapters) => {
      if (!f.relaunched()) return tabs;
      const listed = await preview.listBrowserTabs(project, { ...adapters,
        verifySession: async () => ({ port: 9223 }),
        attachedTargets: async () => new Set(), pageVisibility: async () => 'visible',
      });
      snapshotAfterListing = pool.listBrowserSessions()[project].restoreTabs;
      return listed;
    };
    f.options.preview.browserNewTab = (project, url, adapters) => preview.browserNewTab(project, url, { ...adapters,
      verifySession: async () => ({ port: 9223 }), browserEndpoint: async () => 'ws://127.0.0.1:9223/devtools/browser/fake',
      command: async () => {
        snapshotsAtCreate.push(pool.listBrowserSessions()[project].restoreTabs);
        if (url.endsWith('/two')) throw new Error('fake partial failure');
        return { targetId: 'new-one' };
      },
    });
    f.options.preview.browserCloseTab = async (project, id, adapters) => {
      await preview.browserCloseTab(project, id, { ...adapters,
        verifySession: async () => ({ port: 9223 }), listTargets: async () => [{ id: 'startup' }],
        attachedTargets: async () => new Set(), browserEndpoint: async () => 'ws://127.0.0.1:9223/devtools/browser/fake',
        command: async () => ({ success: true }),
      });
      snapshotAtClose = pool.listBrowserSessions()[project].restoreTabs;
    };
    const result = await pool.restartBrowser('snapshot-in-progress', true, f.options);
    assert.equal(result.restoredTabs, 1);
    assert.deepEqual(snapshotAfterListing, tabs);
    assert.deepEqual(snapshotsAtCreate, [tabs, tabs]);
    assert.deepEqual(snapshotAtClose, tabs);
    assert.deepEqual(pool.listBrowserSessions()['snapshot-in-progress'].restoreTabs, [{ id: 'new-one', url: tabs[0].url }, tabs[1]]);
  } finally { globalThis.fetch = originalFetch; globalThis.WebSocket = originalSocket; }
});

test('a failed post-launch listing still closes the startup blank tab after a successful restore', async () => {
  const f = fixture('startup-list-failure', { tabs: [{ id: 'old', url: 'https://sample.example.com/page' }] });
  const list = f.options.preview.listBrowserTabs;
  f.options.preview.listBrowserTabs = (...args) => { if (f.relaunched()) throw new Error('fake listing failure'); return list(...args); };
  const excluded = [];
  f.options.preview.browserCloseBlankTabs = async (_project, ids) => { excluded.push(...ids); f.startupClosed.push('startup'); };
  const result = await pool.restartBrowser('startup-list-failure', true, f.options);
  assert.equal(result.restoredTabs, 1);
  assert.deepEqual(f.startupClosed, ['startup']);
  assert.deepEqual(excluded, ['new-1'], 'newly restored blank tabs must survive fallback cleanup');
});

test('blank-tab cleanup uses browser CDP and preserves restored, attached, and nonblank tabs', async () => {
  fixture('blank-cleanup');
  const calls = [];
  await preview.browserCloseBlankTabs('blank-cleanup', ['restored-blank'], {
    verifySession: async () => ({ port: 9223 }),
    browserEndpoint: async () => 'ws://127.0.0.1:9223/devtools/browser/fake',
    command: async (_endpoint, method, params) => {
      calls.push([method, params]);
      return method === 'Target.getTargets' ? { targetInfos: [
        { targetId: 'startup', type: 'page', url: 'about:blank', attached: false },
        { targetId: 'restored-blank', type: 'page', url: 'about:blank', attached: false },
        { targetId: 'attached', type: 'page', url: 'about:blank', attached: true },
        { targetId: 'page', type: 'page', url: 'https://sample.example.com/page', attached: false },
      ] } : { success: true };
    },
  });
  assert.deepEqual(calls, [['Target.getTargets', undefined], ['Target.closeTarget', { targetId: 'startup' }]]);
});


test('each auth URL is excluded from bulk saves and individual tab updates', async (t) => {
  for (const [index, url] of authUrls.entries()) {
    await t.test(`auth URL ${index + 1}: ${new URL(url).hostname}${new URL(url).pathname}`, () => {
      const project = `auth-url-${index}`;
      fixture(project);
      pool.rememberBrowserTabs(project, [{ id: 'unsafe', url }]);
      assert.deepEqual(pool.listBrowserSessions()[project].restoreTabs, []);
      pool.rememberBrowserTabs(project, safeTabs);
      pool.rememberBrowserTab(project, 'safe', url);
      assert.deepEqual(pool.listBrowserSessions()[project].restoreTabs, [], 'individual navigation removes the prior saved address');
    });
  }
});

test('path parameters are removed from every segment before saving and again before legacy restore', async () => {
  const tabs = [
    { id: 'raw', url: 'https://sample.example.com/docs;jsessionid=FAKE/page.html;session=FAKE?choice=1#FAKE_FRAGMENT' },
    { id: 'encoded', url: 'https://sample.example.com/docs%3Bsid%3DFAKE/page%253Bsid%253DFAKE' },
    { id: 'triple', url: 'https://sample.example.com/docs%25253Bsid%25253DFAKE/page%25253Bsid%25253DFAKE' },
  ];
  const expected = ['https://sample.example.com/docs/page.html', 'https://sample.example.com/docs/page', 'https://sample.example.com/docs/page'];
  const f = fixture('safe-path-params', { hung: true });
  pool.rememberBrowserTabs('safe-path-params', tabs);
  assert.deepEqual(pool.listBrowserSessions()['safe-path-params'].restoreTabs.map((tab) => tab.url), expected);
  const sessions = pool.listBrowserSessions();
  sessions['safe-path-params'].restoreTabs = tabs;
  fs.writeFileSync(path.join(dir, 'browser-sessions.json'), JSON.stringify(sessions));
  await pool.restartBrowser('safe-path-params', true, f.options);
  assert.deepEqual(f.restored, expected);
  assert.deepEqual(pool.listBrowserSessions()['safe-path-params'].restoreTabs.map((tab) => tab.url), expected);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'browser-sessions.json'), 'utf8'), /FAKE|jsessionid|sid%|;session/);
});
