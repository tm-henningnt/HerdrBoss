import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import test from 'node:test';
import { serve } from '../src/server.js';
import { createAccessControl } from '../src/access.js';
import { DATA_DIR, ROOT_DEFAULTS, loadConfig, readRootSettings, serviceSettingsView, writeServiceSettings } from '../src/config.js';
import { listBrowserSessions, requestBrowser, restartBrowser } from '../src/browser-pool.js';
import { browserInsertText, browserKey } from '../src/browser-preview.js';

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PASSWORD = 'Zx9-fake-Passw0rd-sample';
const ONE_TIME_CODE = 'introspect-482913';

const configDir = (t, config = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-sign-in-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  return dir;
};

// A launch picks a port from 9223 to 9299. A fake network answers for those ports. No real Chrome is touched.
function fakeLaunchNet() {
  const launched = new Set();
  const inRange = (port) => port >= 9222 && port <= 9299;
  return {
    launched,
    portOpen: async (port) => inRange(Number(port)) && launched.has(Number(port)),
    fetch: async (url) => {
      const port = Number(new URL(url).port);
      if (!launched.has(port)) throw new Error('connection refused');
      return new Response(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/x` }), { status: 200 });
    },
  };
}

test('chromePath is a visible path setting with the macOS path as default', (t) => {
  assert.equal(ROOT_DEFAULTS.chromePath, MAC_CHROME);
  assert.deepEqual(serviceSettingsView({}).find((item) => item.setting === 'chromePath'),
    { group: 'Browsers', setting: 'chromePath', value: MAC_CHROME, source: 'default' });
  const dir = configDir(t, { untouched: true });
  writeServiceSettings({ chromePath: '/usr/bin/chromium' }, { dataDir: dir });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')), { untouched: true, chromePath: '/usr/bin/chromium' });
  assert.equal(readRootSettings({ dataDir: dir }).chromePath, '/usr/bin/chromium');
  for (const value of ['', 'relative/chrome', '/usr/../bin/chromium', 1, null, '/usr/bin/chromium\nother']) {
    assert.throws(() => writeServiceSettings({ chromePath: value }, { dataDir: configDir(t) }), undefined, `chromePath refuses ${JSON.stringify(value)}`);
  }
  assert.equal(readRootSettings({ dataDir: configDir(t) }).chromePath, MAC_CHROME);
});

test('requestBrowser launches the configured Chrome path and keeps the profile path across a restart', async (t) => {
  const project = 'signin-profile';
  const net = fakeLaunchNet();
  const spawned = [];
  const machine = new Map();
  const options = {
    cloneDir: null, ...net,
    collectBrowserClients: async () => 0,
    collectProcesses: async () => machine,
    closeViaCdp: async () => { machine.clear(); net.launched.clear(); },
    kill: () => { machine.clear(); net.launched.clear(); },
    spawn: (chrome, args) => {
      const port = Number(args.find((arg) => arg.startsWith('--remote-debugging-port=')).split('=')[1]);
      const profile = args.find((arg) => arg.startsWith('--user-data-dir=')).split('=')[1];
      spawned.push({ chrome, profile });
      net.launched.add(port);
      machine.set(7001, { pid: 7001, cmd: `Chrome --remote-debugging-port=${port} --user-data-dir=${profile} --headless` });
      return { pid: 7001, on() {}, unref() {} };
    },
    preview: { listBrowserTabs: async () => [], browserNewTab: async () => ({ id: 'x' }), browserCloseTab: async () => {} },
  };
  fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify({ chromePath: process.execPath }));
  t.after(() => fs.rmSync(path.join(DATA_DIR, 'config.json'), { force: true }));
  await requestBrowser(project, { ...options, headless: true });
  const profile = listBrowserSessions()[project].profile;
  await restartBrowser(project, true, options);
  assert.equal(spawned.length, 2);
  assert.deepEqual(spawned.map((entry) => entry.chrome), [process.execPath, process.execPath]);
  assert.deepEqual(spawned.map((entry) => entry.profile), [profile, profile]);
  assert.equal(listBrowserSessions()[project].profile, profile);
  assert.equal(profile, path.join(DATA_DIR, 'browser-profiles', project));
});

test('owner(req) accepts a dashboard page on loopback or a session, and refuses the token and a plain loopback call', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-sign-in-access-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokenFile = path.join(dir, 'token');
  const access = createAccessControl(tokenFile);
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const request = (remote, host, headers = {}) => ({ socket: { remoteAddress: remote }, headers: { host, ...headers } });
  const page = { 'x-herdr-boss-caller': 'page' };
  assert.equal(access.owner(request('127.0.0.1', '127.0.0.1:4477', page)), true);
  assert.equal(access.owner(request('127.0.0.1', '127.0.0.1:4477')), false, 'a loopback call without the page header is not the owner');
  assert.equal(access.owner(request('100.64.0.2', 'box.tailnet.example:4477', { ...page, authorization: `Bearer ${token}` })), false, 'the token is not an owner session');
  assert.equal(access.owner(request('100.64.0.2', 'box.tailnet.example:4477', page)), false);
  const login = access.login(request('100.64.0.2', 'box.tailnet.example:4477'), token);
  const cookie = login.cookie.split(';')[0];
  assert.equal(access.owner(request('100.64.0.2', 'box.tailnet.example:4477', { ...page, cookie })), true);
  assert.equal(access.owner(request('100.64.0.2', 'box.tailnet.example:4477', { cookie })), false);
});

async function startServer(t, browserActions) {
  const cfg = loadConfig();
  Object.assign(cfg, { host: '127.0.0.1', port: 0, tickSeconds: 3600 });
  const engine = new EventEmitter();
  engine.state = { control: { projects: { alpha: {} } } };
  engine.tick = async () => engine.state;
  engine.log = () => {};
  const app = serve(cfg, { liveDataDir: process.env.HERDR_BOSS_DIR, createEngine: () => engine, browserActions: { tabAttached: async () => false, ...browserActions } });
  t.after(() => app.close());
  if (!app.server.listening) await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return (route, body, headers = {}) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

test('the sign-in route and sign-in input need the dashboard page as caller', async (t) => {
  const calls = [];
  const post = await startServer(t, {
    requestBrowser: async (project, options) => { calls.push(['request', project, options.headless]); return { project }; },
    browserNewTab: async (project, url) => { calls.push(['tab', project, url]); return { id: 'tab-9' }; },
    browserClick: async () => ({ ok: true }),
    browserInsertText: async (_project, _tab, text) => { calls.push(['text', text.length]); return { ok: true }; },
    browserKey: async (_project, _tab, key, _adapters, modifiers) => { calls.push(['key', key, modifiers]); return { ok: true }; },
  });
  const page = { 'x-herdr-boss-caller': 'page' };
  const signIn = { project: 'alpha', url: 'https://login.example.test/start' };
  assert.equal((await post('/api/browser-sessions/sign-in', signIn)).status, 403);
  assert.equal((await post('/api/browser-sessions/input', { project: 'alpha', tab: 't', type: 'text', text: 'abc', signIn: true })).status, 403);
  assert.deepEqual(calls, []);
  const opened = await post('/api/browser-sessions/sign-in', signIn, page);
  assert.equal(opened.status, 200);
  assert.equal((await opened.json()).tab, 'tab-9');
  assert.deepEqual(calls, [['request', 'alpha', true], ['tab', 'alpha', 'https://login.example.test/start']]);
  assert.equal((await post('/api/browser-sessions/sign-in', { project: 'alpha', url: 'file:///etc/passwd' }, page)).status, 400);
  assert.equal((await post('/api/browser-sessions/input', { project: 'alpha', tab: 't', type: 'key', key: 'a', modifiers: ['Control'], signIn: true }, page)).status, 200);
  assert.deepEqual(calls.at(-1), ['key', 'a', ['Control']]);
});

test('typed sign-in text appears in no log line, response, error, or state file', async (t) => {
  const lines = [];
  const capture = (...args) => lines.push(args.map(String).join(' '));
  for (const name of ['log', 'info', 'warn', 'error']) t.mock.method(console, name, capture);
  const sent = [];
  const fields = { password: false };
  const post = await startServer(t, {
    // The fake CDP helper: it records each protocol request and echoes the typed text in its error on a bad tab.
    browserInsertText: (project, tab, text) => browserInsertText(project, tab, text, {
      verifySession: async () => ({ port: 9299 }),
      listTargets: async () => [{ id: tab, webSocketDebuggerUrl: 'ws://127.0.0.1:9299/devtools/page/1' }],
      listViewports: () => ({}),
      commands: async (_endpoint, requests) => {
        for (const request of requests) sent.push(request);
        if (tab === 'bad') throw new Error(`Input.insertText failed for ${text}`);
        return [{}];
      },
    }),
    browserKey: (project, tab, key, _adapters, modifiers) => browserKey(project, tab, key, {
      verifySession: async () => ({ port: 9299 }),
      listTargets: async () => [{ id: 'tab-1', webSocketDebuggerUrl: 'ws://127.0.0.1:9299/devtools/page/1' }],
      listViewports: () => ({}),
      commands: async (_endpoint, requests) => { for (const request of requests) sent.push(request); return [{}, {}]; },
    }, modifiers),
  });
  const page = { 'x-herdr-boss-caller': 'page' };
  const outputs = [];
  for (const [field, text] of [['password', PASSWORD], ['code', ONE_TIME_CODE]]) {
    fields[field] = true;
    const response = await post('/api/browser-sessions/input', { project: 'alpha', tab: 'tab-1', type: 'text', text, signIn: true }, page);
    assert.equal(response.status, 200);
    outputs.push(await response.text());
    const key = await post('/api/browser-sessions/input', { project: 'alpha', tab: 'tab-1', type: 'key', key: 'Tab', signIn: true }, page);
    outputs.push(await key.text());
  }
  const failed = await post('/api/browser-sessions/input', { project: 'alpha', tab: 'bad', type: 'text', text: PASSWORD, signIn: true }, page);
  assert.equal(failed.status, 409);
  outputs.push(await failed.text());
  assert.deepEqual(sent.filter((request) => request.method === 'Input.insertText').map((request) => request.params.text), [PASSWORD, ONE_TIME_CODE, PASSWORD]);
  const files = [];
  const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else files.push(file); } };
  walk(DATA_DIR);
  const everything = [...lines, ...outputs, ...files.map((file) => `${file}\n${fs.readFileSync(file, 'latin1')}`)].join('\n');
  for (const secret of [PASSWORD, ONE_TIME_CODE]) assert.ok(!everything.includes(secret), 'typed text reached a log line, response, or file');
});

test('key modifiers become the CDP modifier bit mask', async () => {
  const sent = [];
  const adapters = {
    verifySession: async () => ({ port: 9299 }),
    listTargets: async () => [{ id: 'tab-1', webSocketDebuggerUrl: 'ws://127.0.0.1:9299/devtools/page/1' }],
    listViewports: () => ({}),
    commands: async (_endpoint, requests) => { sent.push(...requests); return [{}, {}]; },
  };
  await browserKey('alpha', 'tab-1', 'v', adapters, ['Control', 'Shift']);
  assert.deepEqual(sent.map((request) => request.params.modifiers), [10, 10]);
  assert.equal(sent[0].params.windowsVirtualKeyCode, 86);
  await assert.rejects(browserKey('alpha', 'tab-1', 'Tab', adapters, ['Hyper']), /modifier/i);
});

test('input without signIn stays open to project agents, and the sign-in route refuses credentials in the address', async (t) => {
  const calls = [];
  const post = await startServer(t, {
    requestBrowser: async () => ({}),
    browserNewTab: async (_project, url) => { calls.push(url); return { id: 'tab-1' }; },
    browserInsertText: async () => { calls.push('text'); return { ok: true }; },
    browserKey: async () => { calls.push('key'); return { ok: true }; },
  });
  assert.equal((await post('/api/browser-sessions/input', { project: 'alpha', tab: 't', type: 'text', text: 'abc' })).status, 200);
  assert.equal((await post('/api/browser-sessions/input', { project: 'alpha', tab: 't', type: 'key', key: 'Tab' })).status, 200);
  assert.deepEqual(calls, ['text', 'key']);
  const page = { 'x-herdr-boss-caller': 'page' };
  for (const url of ['https://user:pass@login.example.test/', 'https://user@login.example.test/', 'ftp://login.example.test/', 'not a url']) {
    assert.equal((await post('/api/browser-sessions/sign-in', { project: 'alpha', url }, page)).status, 400, url);
  }
  assert.deepEqual(calls, ['text', 'key'], 'a refused address opens no tab');
  assert.equal((await post('/api/browser-sessions/sign-in', { project: 'alpha', url: 'https://login.example.test/' }, page)).status, 200);
});

test('the read-only preview refuses the sign-in route and input', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-sign-in-preview-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, '..', 'src', 'cli.js'), 'serve', '--read-only-preview'], {
    stdio: 'ignore',
    env: { PATH: process.env.PATH, HOME: home, HERDR_BOSS_DIR: path.join(home, 'data'), HERDR_BOSS_LIVE_DIR: path.join(home, '.herdr-boss'), HERDR_BOSS_PORT: String(port), HERDR_BOSS_PUSH: '0' },
  });
  t.after(() => child.kill());
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  for (;;) {
    try { if ((await fetch(`${base}/api/state`)).ok) break; } catch {}
    if (child.exitCode !== null || Date.now() > deadline) assert.fail('The preview did not start.');
    await new Promise((resolve) => setImmediate(resolve));
  }
  const post = (route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-herdr-boss-caller': 'page' }, body: JSON.stringify(body) });
  assert.equal((await post('/api/browser-sessions/sign-in', { project: 'alpha', url: 'https://login.example.test/' })).status, 403);
  assert.equal((await post('/api/browser-sessions/input', { project: 'alpha', tab: 't', type: 'text', text: 'abc', signIn: true })).status, 403);
});
