import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { serve } from '../src/server.js';
import { Engine } from '../src/engine.js';
import { DATA_DIR, loadConfig } from '../src/config.js';
import { browserNavigate, browserNavigationState, browserHistoryAction } from '../src/browser-preview.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const callback = 'https://tenant1.example.test/login/callback?code=AAAAfakecode&state=eyJfake.eyJfake.fakesig&session_state=AAAAfakesession#access_token=AAAAfakeaccess';
const title = `Login ${callback}`;
const error = `Failed ${callback} Bearer xyz token=AAAAfaketoken`;
function assertSafe(output) {
  for (const secret of ['AAAAfakecode', 'eyJfake', 'fakesig', 'AAAAfakesession', 'AAAAfakeaccess', 'xyz', 'AAAAfaketoken']) {
    assert.ok(!output.includes(secret), 'Browser boundary disclosed a fake secret');
  }
  assert.ok(!output.includes('tenant1.example.test'), 'Browser boundary disclosed an outside host');
}

test('browser navigation helpers remove callback data and redact CDP error text', async () => {
  const adapters = {
    verifySession: async () => ({ port: 9223 }),
    listTargets: async () => [{ id: 'tab-1', url: callback, webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/tab-1' }],
    listViewports: () => ({}),
    commands: async () => [{ currentIndex: 1, entries: [{ id: 0, url: callback }, { id: 1, url: callback }] }],
  };
  assert.equal((await browserNavigationState('alpha', 'tab-1', adapters)).url, 'https://tenant1.example.test/login/callback');
  assert.equal((await browserHistoryAction('alpha', 'tab-1', 'back', adapters)).url, 'https://tenant1.example.test/login/callback');
  adapters.commands = async () => [{ errorText: error }];
  await assert.rejects(browserNavigate('alpha', 'tab-1', callback, adapters), (caught) => {
    for (const secret of ['AAAAfakecode', 'eyJfake', 'xyz', 'AAAAfaketoken']) assert.ok(!caught.message.includes(secret), 'Navigation error disclosed a fake secret');
    assert.match(caught.message, /Bearer <redacted>/);
    return true;
  });
});

test('browser APIs filter sessions, tabs, navigation, bookmarks, state, and errors', async (t) => {
  const session = { project: 'alpha', port: 9299, profile: path.join(DATA_DIR, 'browser-profiles', 'alpha'), bookmarks: [{ name: 'token=AAAAfaketoken', url: callback }], startPage: callback };
  fs.writeFileSync(path.join(DATA_DIR, 'browser-sessions.json'), JSON.stringify({ alpha: session }));
  const cfg = loadConfig();
  Object.assign(cfg, { host: '127.0.0.1', port: 0, tickSeconds: 3600 });
  const engine = new EventEmitter();
  engine.state = { control: { projects: { alpha: {} } }, managedBrowsers: [session] };
  engine.tick = async () => engine.state;
  engine.log = () => {};
  const app = serve(cfg, {
    liveDataDir: process.env.HERDR_BOSS_DIR,
    createEngine: () => engine,
    browserActions: {
      // Keep the saved URL fields intact; production browserStatus adds probe metadata to this session.
      browserStatus: async (value) => value,
      listBrowserTabs: async () => [{ id: 'tab-1', title, url: callback }],
      browserNavigationState: async () => ({ url: callback, canGoBack: true, canGoForward: false }),
      browserNavigate: async () => { throw new Error(error); },
      browserScreenshot: async (_project, tab) => { if (tab === 'fail') throw new Error(error); return Buffer.from('jpeg'); },
      tabAttached: async () => false,
    },
    closeTab: async () => { throw new Error(error); },
  });
  t.after(() => app.close());
  if (!app.server.listening) await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  for (const route of ['/api/browser-sessions/bookmarks?project=alpha', '/api/state', '/api/browser-sessions', '/api/browser-sessions/tabs?project=alpha', '/api/browser-sessions/navigation?project=alpha']) {
    const response = await fetch(`${base}${route}`);
    assert.equal(response.status, 200);
    const output = await response.text();
    assertSafe(output);
    assert.doesNotThrow(() => JSON.parse(output));
  }
  for (const [route, body] of [['navigate', { project: 'alpha', tab: 'tab-1', url: callback }], ['tab-close', { project: 'alpha', tabId: 'tab-1' }]]) {
    const response = await fetch(`${base}/api/browser-sessions/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 409);
    const output = await response.text();
    assertSafe(output);
    assert.match(output, /Bearer <redacted>/);
  }
  const image = await fetch(`${base}/api/browser-sessions/screenshot?project=alpha&tab=tab-1`);
  assert.equal(image.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from('jpeg'));
  const failedImage = await fetch(`${base}/api/browser-sessions/screenshot?project=alpha&tab=fail`);
  assert.equal(failedImage.status, 409);
  assertSafe(await failedImage.text());
  const abort = new AbortController();
  const stream = await fetch(`${base}/api/events`, { signal: abort.signal });
  const reader = stream.body.getReader();
  try {
    assertSafe(new TextDecoder().decode((await reader.read()).value));
    engine.emit('state', engine.state);
    const update = new TextDecoder().decode((await reader.read()).value);
    assert.match(update, /event: state/);
    assertSafe(update);
  } finally {
    await reader.cancel();
    abort.abort();
  }
});

test('dashboard tenant host display needs an Owner page marker and a same-origin browser signal', async (t) => {
  const host = 'tenant-display.example.test';
  const pageUrl = `https://${host}/workspace?discard=this`;
  const session = {
    project: 'alpha', port: 9299, profile: path.join(DATA_DIR, 'browser-profiles', 'alpha'),
    bookmarks: [{ name: 'Fixture page', url: pageUrl }], startPage: pageUrl,
  };
  fs.writeFileSync(path.join(DATA_DIR, 'browser-sessions.json'), JSON.stringify({ alpha: session }));
  const cfg = loadConfig();
  Object.assign(cfg, { host: '127.0.0.1', port: 0, tickSeconds: 3600, browser: { ...cfg.browser, showTenantHosts: true } });
  const engine = new EventEmitter();
  engine.state = { control: { projects: { alpha: {} } }, managedBrowsers: [session], events: [{ pageUrl }] };
  engine.tick = async () => engine.state;
  engine.log = () => {};
  const app = serve(cfg, {
    liveDataDir: process.env.HERDR_BOSS_DIR,
    createEngine: () => engine,
    browserActions: {
      browserStatus: async (value) => value,
      listBrowserTabs: async () => [{ id: 'tab-1', title: 'Fixture page', url: pageUrl }],
    },
  });
  t.after(() => app.close());
  if (!app.server.listening) await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const page = { 'x-herdr-boss-caller': 'page' };
  const sameOrigin = { ...page, 'sec-fetch-site': 'same-origin' };
  const originSignal = { ...page, origin: new URL(base).origin };
  const text = async (route, headers = {}) => (await fetch(`${base}${route}`, { headers })).text();
  const maskedState = await text('/api/state', page);
  const noSignalRoutes = [
    ['/api/state', page],
    ['/api/state?caller=page', page],
    ['/api/browser-sessions', page],
    ['/api/browser-sessions/bookmarks?project=alpha', page],
    ['/api/browser-sessions/tabs?project=alpha', page],
  ];
  for (const [route, headers] of noSignalRoutes) assert.equal((await text(route, headers)).includes(host), false, `${route} must mask a page marker without a browser signal`);
  for (const route of ['/api/state', '/api/browser-sessions', '/api/browser-sessions/bookmarks?project=alpha', '/api/browser-sessions/tabs?project=alpha']) {
    const output = await text(route, sameOrigin);
    assert.equal(output.includes(host), true, `${route} should reveal the host to a same-origin Owner page`);
    assert.equal(output.includes('discard=this'), false, `${route} should still remove callback data`);
  }
  const originState = await text('/api/state', originSignal);
  assert.equal(originState.includes(host), true, 'an Origin header for the dashboard origin is a browser signal');
  assert.equal((await text('/api/state', { ...page, origin: 'http://elsewhere.example.test' })).includes(host), false, 'a different Origin must stay masked');

  const readInitialEvent = async (query, headers = {}) => {
    const abort = new AbortController();
    const response = await fetch(`${base}/api/events${query}`, { signal: abort.signal, headers });
    const reader = response.body.getReader();
    try {
      let text = '';
      while (!text.includes('event: state')) text += new TextDecoder().decode((await reader.read()).value);
      return text;
    } finally {
      await reader.cancel();
      abort.abort();
    }
  };
  const eventAttempts = [
    ['', page],
    ['?caller=page', {}],
  ];
  for (const [query, headers] of eventAttempts) assert.equal((await readInitialEvent(query, headers)).includes(host), false, '/api/events must mask either caller marker without a browser signal');
  for (const headers of [{ 'sec-fetch-site': 'same-origin' }, { origin: new URL(base).origin }]) {
    const output = await readInitialEvent('?caller=page', headers);
    assert.equal(output.includes(host), true, '/api/events should reveal the host only with a browser signal');
    assert.equal(output.includes('discard=this'), false);
  }

  // A worker can pass a masked dashboard-derived URL through its normal message and publish paths.
  // The local reveal setting must not add the full host to those independent outputs.
  const maskedBrowserUrl = JSON.parse(maskedState).managedBrowsers[0].bookmarks[0].url;
  assert.ok(maskedBrowserUrl.includes('<tenant>'));
  const outputRoot = fs.mkdtempSync(path.join(DATA_DIR, 'dashboard-output-'));
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
  const home = path.join(outputRoot, 'home');
  const dataDir = path.join(outputRoot, 'boss');
  const bin = path.join(outputRoot, 'bin');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ browser: { showTenantHosts: true } }));
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ control: { projects: {} } }));
  fs.writeFileSync(path.join(bin, 'herdr'), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'pane' && args[1] === 'get') console.log(JSON.stringify({ result: { pane: { pane_id: args[2], workspace_id: 'wB', label: 'boss' } } }));
else process.exit(3);
`);
  fs.chmodSync(path.join(bin, 'herdr'), 0o755);
  const env = {
    ...process.env,
    HOME: home,
    HERDR_BOSS_DIR: dataDir,
    HERDR_BOSS_LIVE_DIR: dataDir,
    HERDR_ENV: '1',
    HERDR_PANE_ID: 'wB:p1',
    HERDR_WORKSPACE_ID: 'wB',
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  };
  delete env.HERDR_WORKTREE;
  const runCli = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: outputRoot, env, encoding: 'utf8' });
  const said = runCli('say', maskedBrowserUrl);
  assert.equal(said.status, 0, said.stderr);
  const reportFile = path.join(outputRoot, 'report.md');
  fs.writeFileSync(reportFile, maskedBrowserUrl);
  const mailed = runCli('mail', 'post', '--to', 'owner', '--title', 'Browser URL', '--action', 'read', reportFile);
  assert.equal(mailed.status, 0, mailed.stderr);
  const statusFile = path.join(outputRoot, 'status.json');
  fs.writeFileSync(statusFile, JSON.stringify({ project: 'Fixture', tasks: [{ id: 'T1', title: maskedBrowserUrl, status: 'doing' }] }));
  const published = runCli('publish', 'fixture', statusFile);
  assert.equal(published.status, 0, published.stderr);
  const artifacts = [
    said.stdout, said.stderr, mailed.stdout, mailed.stderr, published.stdout, published.stderr,
    fs.readFileSync(reportFile, 'utf8'), fs.readFileSync(statusFile, 'utf8'),
    ...fs.readdirSync(dataDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8')),
  ];
  for (const output of artifacts) assert.equal(output.includes(host), false, 'an agent output artifact received the unmasked dashboard host');
});

test('browser events redact text and nested fields when dashboard host display is enabled', () => {
  const cfg = loadConfig();
  cfg.browser.showTenantHosts = true;
  const engine = Object.assign(new EventEmitter(), { cfg, events: [] });
  let delivered;
  engine.on('event', (event) => { delivered = event; });
  Engine.prototype.log.call(engine, 'browser', error, { tab: { title, pageUrl: callback }, bookmark: { name: 'token=AAAAfaketoken', url: callback } });
  assertSafe(JSON.stringify(delivered));
  assertSafe(JSON.stringify(engine.events));
  assertSafe(fs.readFileSync(path.join(DATA_DIR, 'events.jsonl'), 'utf8'));
});

test('engine snapshots remove page URLs in Chrome command text before state.json', async () => {
  const profile = path.join(DATA_DIR, 'browser-profiles', 'alpha');
  fs.writeFileSync(path.join(DATA_DIR, 'browser-sessions.json'), JSON.stringify({ alpha: { project: 'alpha', port: 9299, profile, bookmarks: [{ name: 'token=AAAAfaketoken', url: callback }], startPage: callback } }));
  const cfg = loadConfig();
  cfg.browser.showTenantHosts = true;
  const engine = new Engine(cfg, { act: false, push: false, collectors: {
    collectHerdr: async () => ({ panes: [], workspaces: [] }),
    collectProcesses: async () => new Map([[1, { pid: 1, ppid: 0, cmd: '/sbin/launchd' }], [2, { pid: 2, ppid: 1, age: 60, cpu: 0, rssMB: 100, cmd: `Google Chrome --remote-debugging-port=9299 --user-data-dir=${profile} ${callback}` }]]),
    collectMachine: async () => null,
    collectQuotas: async () => [],
    collectWorktreeCounts: async () => ({}),
    collectCwdProcesses: async () => [],
    collectMissingWorktreeProcesses: async () => [],
    cdpResponds: async () => true,
    probeTcp: () => false,
    probePort: async () => false,
  } });
  const state = await engine.tick();
  assert.ok(state.browsers.length > 0, 'the fixture must reach the Chrome snapshot boundary');
  assert.equal(JSON.stringify(engine.dashboardManagedBrowsers).includes('tenant1.example.test'), true);
  assertSafe(JSON.stringify(state));
  assertSafe(fs.readFileSync(path.join(DATA_DIR, 'state.json'), 'utf8'));
});

test('dashboard bookmarks open stored URLs and save the current tab without returning raw addresses', async (t) => {
  fs.writeFileSync(path.join(DATA_DIR, 'browser-sessions.json'), JSON.stringify({ alpha: { project: 'alpha', bookmarks: [{ name: 'Callback', url: callback }] } }));
  const cfg = loadConfig();
  Object.assign(cfg, { host: '127.0.0.1', port: 0, tickSeconds: 3600 });
  const engine = new EventEmitter();
  engine.state = { control: { projects: { alpha: {} } } };
  engine.tick = async () => engine.state;
  engine.log = () => {};
  const calls = [];
  let attached = false;
  const app = serve(cfg, { liveDataDir: process.env.HERDR_BOSS_DIR, createEngine: () => engine, browserActions: {
    listBrowserTabs: async () => [{ id: 'tab-1', title: 'Callback', url: callback }],
    tabAttached: async () => attached,
    browserNavigate: async (project, tab, url) => { calls.push({ project, tab, url }); return { url }; },
    browserNewTab: async (project, url) => { calls.push({ project, url }); return { id: 'tab-2' }; },
  } });
  t.after(() => app.close());
  if (!app.server.listening) await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}/api/browser-sessions/bookmarks`;
  const post = (body) => fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'alpha', ...body }) });
  for (const body of [{ action: 'open', index: 0, tab: 'tab-1' }, { action: 'open', index: 0, newTab: true }, { action: 'add-current', tab: 'tab-1' }]) {
    const response = await post(body);
    assert.equal(response.status, 200);
    assertSafe(await response.text());
  }
  assert.deepEqual(calls, [{ project: 'alpha', tab: 'tab-1', url: callback }, { project: 'alpha', url: callback }]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'browser-sessions.json'), 'utf8')).alpha.bookmarks.length, 2);
  assert.equal((await post({ action: 'open', index: 99 })).status, 400);
  assert.equal((await post({ action: 'add-current', tab: 'gone' })).status, 400);
  attached = true;
  assert.equal((await post({ action: 'open', index: 0, tab: 'tab-1' })).status, 409);
  assert.equal(calls.length, 2, 'an attached tab must keep the confirmation guard');
});
