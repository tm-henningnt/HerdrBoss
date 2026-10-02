import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import test from 'node:test';
import { serve } from '../src/server.js';
import { Engine } from '../src/engine.js';
import { DATA_DIR, loadConfig } from '../src/config.js';
import { browserNavigate, browserNavigationState, browserHistoryAction } from '../src/browser-preview.js';

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

test('browser events redact text and nested fields before event delivery and events.jsonl', () => {
  const engine = Object.assign(new EventEmitter(), { events: [] });
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
