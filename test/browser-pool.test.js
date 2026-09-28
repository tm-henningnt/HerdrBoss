import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';

// All network and process access below uses ephemeral local ports and injected functions. No real Chrome is touched.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-browser-pool-'));
process.env.HERDR_BOSS_DIR = dataDir;
const pool = await import('../src/browser-pool.js');
const browserPreview = await import('../src/browser-preview.js');

// A listener that accepts TCP connections and never answers, like a hung Chrome.
async function hungServer() {
  const sockets = new Set();
  const server = net.createServer((socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
  };
}

async function versionServer(port = 0) {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/x` }));
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

// A launch picks a port from 9223 to 9299. The tests never connect to those ports: a fake network answers for them.
// Each other port, for example an ephemeral test server, uses the real network.
const inBrowserRange = (port) => port >= 9222 && port <= 9299;
function realPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}
function fakeLaunchNet() {
  const launched = new Set();
  return {
    launched,
    portOpen: async (port) => inBrowserRange(Number(port)) ? launched.has(Number(port)) : realPortOpen(Number(port)),
    fetch: async (url, options) => {
      const port = Number(new URL(url).port);
      if (!inBrowserRange(port)) return fetch(url, options);
      if (!launched.has(port)) throw new Error('connection refused');
      return new Response(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/x` }), { status: 200 });
    },
  };
}

function register(project, port) {
  const profile = path.join(dataDir, 'browser-profiles', project);
  const sessions = pool.listBrowserSessions();
  sessions[project] = { project, port, profile, headless: true, windowSize: { width: 1280, height: 800 }, pid: null };
  fs.writeFileSync(path.join(dataDir, 'browser-sessions.json'), JSON.stringify(sessions));
  return sessions[project];
}

function browserViewportFixture({ includeTab = true } = {}) {
  const session = { port: 45678 };
  register('viewport-fixture', session.port);
  const calls = [];
  return {
    calls,
    adapters: {
      verifySession: async (project) => {
        assert.equal(project, 'viewport-fixture');
        return session;
      },
      listTargets: async (actualSession) => {
        assert.strictEqual(actualSession, session);
        return includeTab ? [{ id: 'tab-viewport', webSocketDebuggerUrl: `ws://localhost:${session.port}/devtools/page/1` }] : [];
      },
      command: async (...call) => { calls.push(call); return {}; },
    },
  };
}

test('browserViewport sends device metrics to the selected tab and clears them on reset', async () => {
  const fixture = browserViewportFixture();
  await browserPreview.browserViewport('viewport-fixture', 'tab-viewport', { width: 473, height: 291, scale: 1.5, mobile: true }, fixture.adapters);
  await browserPreview.browserViewport('viewport-fixture', 'tab-viewport', { reset: true }, fixture.adapters);
  assert.deepEqual(pool.listBrowserTabViewports('viewport-fixture', ['tab-viewport']), {});
  assert.deepEqual(fixture.calls, [
    ['ws://127.0.0.1:45678/devtools/page/1', 'Emulation.setDeviceMetricsOverride', { width: 473, height: 291, deviceScaleFactor: 1.5, mobile: true }],
    ['ws://127.0.0.1:45678/devtools/page/1', 'Emulation.clearDeviceMetricsOverride', {}],
  ]);
});

test('browserViewport rejects dimensions and scale outside the supported range', async () => {
  const invalid = [
    { width: 199, height: 291 }, { width: 3841, height: 291 },
    { width: 473, height: 149 }, { width: 473, height: 2161 },
    { width: 473, height: 291, scale: 0.49 }, { width: 473, height: 291, scale: 4.01 },
  ];
  for (const viewport of invalid) {
    await assert.rejects(browserPreview.browserViewport('viewport-fixture', 'tab-viewport', viewport), /Viewport width must be 200–3840, height 150–2160, and scale 0.5–4/);
  }
});

test('browserViewport checks that the selected tab is still open', async () => {
  const fixture = browserViewportFixture({ includeTab: false });
  await assert.rejects(browserPreview.browserViewport('viewport-fixture', 'tab-viewport', { width: 473, height: 291 }, fixture.adapters), /selected tab is no longer open/);
  assert.deepEqual(fixture.calls, []);
});

test('browser tab viewport records persist and drops entries for tabs that have closed', () => {
  register('viewport-persistence', 45679);
  const viewport = { width: 473, height: 291, scale: 1, mobile: false };
  pool.setBrowserTabViewport('viewport-persistence', 'tab-live', viewport);
  pool.setBrowserTabViewport('viewport-persistence', 'tab-closed', viewport);
  assert.deepEqual(pool.listBrowserTabViewports('viewport-persistence', ['tab-live']), { 'tab-live': viewport });
  assert.deepEqual(pool.listBrowserSessions()['viewport-persistence'].viewports, { 'tab-live': viewport });
});

// The fake command resolves request functions exactly as src/browser-preview.js does, so the tests read the
// real request list. No real Chrome is touched.
function browserDragFixture({ width = 1000, height = 500, viewport = null } = {}) {
  const project = 'drag-fixture';
  const session = { port: 45681 };
  register(project, session.port);
  if (viewport) pool.setBrowserTabViewport(project, 'tab-drag', viewport);
  const sent = [];
  const adapters = {
    verifySession: async (name) => { assert.equal(name, project); return session; },
    listTargets: async () => [{ id: 'tab-drag', webSocketDebuggerUrl: `ws://localhost:${session.port}/devtools/page/1` }],
    commands: async (_endpoint, sessionRequests) => {
      const results = [];
      for (const entry of sessionRequests) {
        const request = typeof entry === 'function' ? entry(results.at(-1), results) : entry;
        sent.push(request);
        results.push(request.method === 'Page.getLayoutMetrics'
          ? { cssVisualViewport: { clientWidth: width, clientHeight: height } } : {});
      }
      return results;
    },
  };
  return { sent, adapters, project, clearViewport: () => pool.setBrowserTabViewport(project, 'tab-drag', null) };
}

test('browserDrag sends a press, three moves, and a release for --steps 3', async () => {
  const fixture = browserDragFixture();
  const result = await browserPreview.browserDrag(fixture.project, 'tab-drag', { x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }, { steps: 3, adapters: fixture.adapters });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(fixture.sent.map((request) => request.method), [
    'Page.getLayoutMetrics',
    'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent',
    'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent',
  ]);
  assert.deepEqual(fixture.sent.slice(1).map((request) => request.params.type), [
    'mouseMoved', 'mousePressed', 'mouseMoved', 'mouseMoved', 'mouseMoved', 'mouseReleased',
  ]);
  assert.deepEqual(fixture.sent[2].params, { type: 'mousePressed', x: 200, y: 250, button: 'left', clickCount: 1 });
  assert.deepEqual(fixture.sent.slice(3, 6).map((request) => request.params), [
    { type: 'mouseMoved', button: 'left', buttons: 1, x: 400, y: 250 },
    { type: 'mouseMoved', button: 'left', buttons: 1, x: 600, y: 250 },
    { type: 'mouseMoved', button: 'left', buttons: 1, x: 800, y: 250 },
  ]);
  assert.deepEqual(fixture.sent[6].params, { type: 'mouseReleased', x: 800, y: 250, button: 'left', clickCount: 1 });
  fixture.clearViewport();
});

test('browserDrag reads the page size and reapplies a stored viewport', async () => {
  const fixture = browserDragFixture({ width: 400, height: 200, viewport: { width: 400, height: 200, scale: 2, mobile: false } });
  await browserPreview.browserDrag(fixture.project, 'tab-drag', { x: 0.25, y: 0.75 }, { x: 0.5, y: 0.25 }, { adapters: fixture.adapters });
  assert.deepEqual(fixture.sent[0], { method: 'Emulation.setDeviceMetricsOverride', params: { width: 400, height: 200, deviceScaleFactor: 2, mobile: false } });
  assert.deepEqual(fixture.sent.at(-1).params, { type: 'mouseReleased', x: 200, y: 50, button: 'left', clickCount: 1 });
  fixture.clearViewport();
});

test('browserDrag clamps the start and end points inside the page', async () => {
  const fixture = browserDragFixture();
  await browserPreview.browserDrag(fixture.project, 'tab-drag', { x: 1, y: 1 }, { x: 1, y: 1 }, { steps: 1, adapters: fixture.adapters });
  assert.deepEqual(fixture.sent[1].params, { type: 'mouseMoved', x: 999, y: 499 });
  assert.deepEqual(fixture.sent.at(-1).params, { type: 'mouseReleased', x: 999, y: 499, button: 'left', clickCount: 1 });
  fixture.clearViewport();
});

test('browserDrag refuses a position outside 0% to 100% and a step count outside 1 to 60', async () => {
  const fixture = browserDragFixture();
  for (const from of [{ x: -0.01, y: 0.5 }, { x: 0.5, y: 1.01 }, { x: 0.5 }]) {
    await assert.rejects(browserPreview.browserDrag(fixture.project, 'tab-drag', from, { x: 0.5, y: 0.5 }, { adapters: fixture.adapters }), /Drag position must be inside the screenshot/);
  }
  await assert.rejects(browserPreview.browserDrag(fixture.project, 'tab-drag', { x: 0.5, y: 0.5 }, { x: 0.5, y: 1.5 }, { adapters: fixture.adapters }), /Drag position must be inside the screenshot/);
  for (const steps of [0, 61, 2.5, 'ten']) {
    await assert.rejects(browserPreview.browserDrag(fixture.project, 'tab-drag', { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, { steps, adapters: fixture.adapters }), /Drag steps must be from 1 to 60/);
  }
  assert.deepEqual(fixture.sent, []);
  fixture.clearViewport();
});

test('browserScreenshot reapplies stored device metrics in its new CDP session', async () => {
  const project = 'viewport-reapply';
  const session = register(project, 45680);
  const tabId = 'tab-reapply';
  const viewport = { width: 473, height: 291, scale: 1.5, mobile: true };
  pool.setBrowserTabViewport(project, tabId, viewport);
  const requests = [];
  const screenshot = await browserPreview.browserScreenshot(project, tabId, {
    verifySession: async () => session,
    listTargets: async () => [{ id: tabId, webSocketDebuggerUrl: `ws://localhost:${session.port}/devtools/page/2` }],
    commands: async (_endpoint, sessionRequests) => {
      requests.push(...sessionRequests);
      return sessionRequests.map((request) => request.method === 'Page.captureScreenshot' ? { data: Buffer.from('jpeg').toString('base64') } : {});
    },
  });
  assert.deepEqual(requests.map((request) => request.method), [
    'Emulation.setDeviceMetricsOverride', 'Page.captureScreenshot',
  ]);
  assert.deepEqual(requests[0].params, { width: 473, height: 291, deviceScaleFactor: 1.5, mobile: true });
  assert.deepEqual(screenshot, Buffer.from('jpeg'));
  pool.setBrowserTabViewport(project, tabId, null);
});

function chromeCmd(port, profile, extra = '') {
  return `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=${port} --user-data-dir=${profile} --headless${extra}`;
}

// A fake process table with a Chrome owner, its renderer, and an unrelated process on the same port.
function fakeMachine(session, { withOwner = true } = {}) {
  const procs = new Map();
  if (withOwner) {
    procs.set(4101, { pid: 4101, cmd: chromeCmd(session.port, session.profile) });
    procs.set(4102, { pid: 4102, cmd: chromeCmd(session.port, session.profile, ' --type=renderer') });
  }
  procs.set(4103, { pid: 4103, cmd: chromeCmd(session.port, '/tmp/other-profile') });
  const kills = [];
  return { procs, kills, collectProcesses: async () => new Map(procs) };
}

test('a TCP listener that never answers HTTP is verified but not responsive', async () => {
  const hung = await hungServer();
  try {
    const session = register('hung-status', hung.port);
    const machine = fakeMachine(session);
    const status = await pool.browserStatus(session, { collectProcesses: machine.collectProcesses });
    assert.equal(status.reachable, true);
    assert.equal(status.processPresent, true);
    assert.equal(status.profileVerified, true);
    assert.equal(status.responsive, false);
    assert.equal(status.pid, 4101);
  } finally { await hung.close(); }
});

test('a verified browser that answers /json/version is responsive', async () => {
  const server = await versionServer();
  try {
    const session = register('ok-status', server.port);
    const status = await pool.browserStatus(session, { collectProcesses: fakeMachine(session).collectProcesses });
    assert.equal(status.profileVerified, true);
    assert.equal(status.responsive, true);
  } finally { await server.close(); }
});

test('responsive is false without a verified profile, and no request is sent', async () => {
  const server = await versionServer();
  try {
    const session = register('unverified-status', server.port);
    let fetched = 0;
    const status = await pool.browserStatus(session, {
      collectProcesses: fakeMachine(session, { withOwner: false }).collectProcesses,
      fetch: async (...args) => { fetched++; return fetch(...args); },
    });
    assert.equal(status.profileVerified, false);
    assert.equal(status.responsive, false);
    assert.equal(fetched, 0);
  } finally { await server.close(); }
});

test('closeBrowser sends SIGTERM only to the matched owner of a hung browser', async () => {
  const hung = await hungServer();
  const session = register('hung-close', hung.port);
  const machine = fakeMachine(session);
  const kill = (pid, signal) => {
    machine.kills.push([pid, signal]);
    machine.procs.delete(4101);
    machine.procs.delete(4102);
    hung.close();
  };
  try {
    const result = await pool.closeBrowser('hung-close', { collectProcesses: machine.collectProcesses, kill });
    assert.equal(result.closed, true);
    assert.deepEqual(machine.kills, [[4101, 'SIGTERM']]);
  } finally { await hung.close().catch(() => {}); }
});

test('closeBrowser falls back to SIGTERM when Browser.close fails on a responsive browser', async () => {
  // The fake endpoint answers /json/version, but its WebSocket URL does not accept connections.
  const server = await versionServer();
  const session = register('close-fails', server.port);
  const machine = fakeMachine(session);
  const kill = (pid, signal) => { machine.kills.push([pid, signal]); machine.procs.delete(4101); machine.procs.delete(4102); server.close(); };
  try {
    const result = await pool.closeBrowser('close-fails', { collectProcesses: machine.collectProcesses, kill });
    assert.equal(result.closed, true);
    assert.deepEqual(machine.kills, [[4101, 'SIGTERM']]);
  } finally { await server.close().catch(() => {}); }
});

test('closeBrowser throws the did-not-exit error when the owner ignores SIGTERM, and sends no SIGKILL', async () => {
  const hung = await hungServer();
  const session = register('hung-stuck', hung.port);
  const machine = fakeMachine(session);
  const kill = (pid, signal) => machine.kills.push([pid, signal]);
  try {
    await assert.rejects(pool.closeBrowser('hung-stuck', { collectProcesses: machine.collectProcesses, kill, fetch: async () => { throw new Error('timeout'); } }), /did not exit/);
    assert.deepEqual(machine.kills, [[4101, 'SIGTERM']]);
  } finally { await hung.close(); }
});

test('closeBrowser never signals an unmatched process on the port', async () => {
  const hung = await hungServer();
  const session = register('foreign-port', hung.port);
  const machine = fakeMachine(session, { withOwner: false });
  const kill = (pid, signal) => machine.kills.push([pid, signal]);
  try {
    await assert.rejects(pool.closeBrowser('foreign-port', { collectProcesses: machine.collectProcesses, kill }), /belongs to another process/);
    assert.deepEqual(machine.kills, []);
  } finally { await hung.close(); }
});

test('requestBrowser returns the status of a verified hung browser and launches nothing', async () => {
  const hung = await hungServer();
  const session = register('hung-request', hung.port);
  const machine = fakeMachine(session);
  let spawned = 0;
  try {
    const status = await pool.requestBrowser('hung-request', { headless: true, collectProcesses: machine.collectProcesses, spawn: () => { spawned++; } });
    assert.equal(status.profileVerified, true);
    assert.equal(status.responsive, false);
    assert.equal(spawned, 0);
  } finally { await hung.close(); }
});

test('restartBrowser skips the page restore for a hung browser, closes it, and launches again', async () => {
  const hung = await hungServer();
  const session = register('hung-restart', hung.port);
  const machine = fakeMachine(session);
  const launchNet = fakeLaunchNet();
  const kill = (pid, signal) => { machine.kills.push([pid, signal]); machine.procs.delete(4101); machine.procs.delete(4102); hung.close(); };
  const spawn = (chrome, args) => {
    const port = Number(args.find((a) => a.startsWith('--remote-debugging-port=')).split('=')[1]);
    const profile = args.find((a) => a.startsWith('--user-data-dir=')).split('=')[1];
    machine.procs.set(4201, { pid: 4201, cmd: chromeCmd(port, profile) });
    launchNet.launched.add(port);
    return { pid: 4201, on() {}, unref() {} };
  };
  try {
    const result = await pool.restartBrowser('hung-restart', true, {
      collectProcesses: machine.collectProcesses, kill, spawn, chromePath: process.execPath, cloneDir: null, portOpen: launchNet.portOpen, fetch: launchNet.fetch,
    });
    assert.deepEqual(machine.kills, [[4101, 'SIGTERM']]);
    assert.equal(result.restoredPage, false);
    assert.equal(result.restoreError, undefined);
    assert.equal(result.profileVerified, true);
    assert.equal(result.responsive, true);
    assert.equal(result.pid, 4201);
  } finally {
    await hung.close().catch(() => {});
  }
});

// A temporary clone folder and a process list without a Chrome main process. The real clone folder is never used.
function cloneFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-clone-dir-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const make = (name) => { fs.mkdirSync(path.join(dir, name, 'Google Chrome.app'), { recursive: true }); return path.join(dir, name); };
  return { dir, make, readProcesses: async () => [{ pid: 1, startedAt: 0, comm: '/sbin/launchd' }] };
}

test('a launch records the one new code-sign clone in the session', async (t) => {
  const clones = cloneFixture(t);
  clones.make('code_sign_clone.before1');
  const machine = { procs: new Map() };
  const launchNet = fakeLaunchNet();
  const spawn = (chrome, args) => {
    const port = Number(args.find((a) => a.startsWith('--remote-debugging-port=')).split('=')[1]);
    const profile = args.find((a) => a.startsWith('--user-data-dir=')).split('=')[1];
    machine.procs.set(4301, { pid: 4301, cmd: chromeCmd(port, profile) });
    clones.make('code_sign_clone.launch1');
    launchNet.launched.add(port);
    return { pid: 4301, on() {}, unref() {} };
  };
  const status = await pool.requestBrowser('clone-launch', { headless: true, chromePath: process.execPath, spawn,
    collectProcesses: async () => new Map(machine.procs), cloneDir: clones.dir, portOpen: launchNet.portOpen, fetch: launchNet.fetch });
  assert.equal(status.codeSignClone, 'code_sign_clone.launch1');
  assert.equal(pool.listBrowserSessions()['clone-launch'].codeSignClone, 'code_sign_clone.launch1');
});

test('a launch that sees no new clone or several new clones records null', async (t) => {
  const clones = cloneFixture(t);
  for (const [project, count] of [['clone-none', 0], ['clone-many', 2]]) {
    const machine = { procs: new Map() };
    const launchNet = fakeLaunchNet();
    const spawn = (chrome, args) => {
      const port = Number(args.find((a) => a.startsWith('--remote-debugging-port=')).split('=')[1]);
      const profile = args.find((a) => a.startsWith('--user-data-dir=')).split('=')[1];
      machine.procs.set(4401, { pid: 4401, cmd: chromeCmd(port, profile) });
      for (let i = 0; i < count; i++) clones.make(`code_sign_clone.${project.replace('-', '')}${i}`);
      launchNet.launched.add(port);
      return { pid: 4401, on() {}, unref() {} };
    };
    const status = await pool.requestBrowser(project, { headless: true, chromePath: process.execPath, spawn,
      collectProcesses: async () => new Map(machine.procs), cloneDir: clones.dir, portOpen: launchNet.portOpen, fetch: launchNet.fetch });
    assert.equal(status.codeSignClone, null, project);
  }
});

test('a SIGTERM close deletes the recorded clone and clears it from the session', async (t) => {
  const clones = cloneFixture(t);
  const hung = await hungServer();
  const session = register('clone-sigterm', hung.port);
  const folder = clones.make('code_sign_clone.sigterm');
  const other = clones.make('code_sign_clone.others');
  const sessions = pool.listBrowserSessions();
  sessions['clone-sigterm'].codeSignClone = 'code_sign_clone.sigterm';
  fs.writeFileSync(path.join(dataDir, 'browser-sessions.json'), JSON.stringify(sessions));
  const machine = fakeMachine(session);
  const kill = (pid, signal) => { machine.kills.push([pid, signal]); machine.procs.delete(4101); machine.procs.delete(4102); hung.close(); };
  try {
    const result = await pool.closeBrowser('clone-sigterm', { collectProcesses: machine.collectProcesses, kill, cloneDir: clones.dir, readProcesses: clones.readProcesses });
    assert.equal(result.closed, true);
    assert.deepEqual(machine.kills, [[4101, 'SIGTERM']]);
    assert.equal(fs.existsSync(folder), false);
    assert.equal(fs.existsSync(other), true);
    assert.equal(pool.listBrowserSessions()['clone-sigterm'].codeSignClone, null);
  } finally { await hung.close().catch(() => {}); }
});

test('a SIGTERM close keeps the recorded clone when a running Chrome started with it', async (t) => {
  const clones = cloneFixture(t);
  const hung = await hungServer();
  const session = register('clone-owned', hung.port);
  const folder = clones.make('code_sign_clone.owned1');
  const sessions = pool.listBrowserSessions();
  sessions['clone-owned'].codeSignClone = 'code_sign_clone.owned1';
  fs.writeFileSync(path.join(dataDir, 'browser-sessions.json'), JSON.stringify(sessions));
  const machine = fakeMachine(session);
  const kill = (pid, signal) => { machine.kills.push([pid, signal]); machine.procs.delete(4101); machine.procs.delete(4102); hung.close(); };
  const readProcesses = async () => [{ pid: 7, startedAt: fs.statSync(folder).birthtimeMs + 1000, comm: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }];
  try {
    await pool.closeBrowser('clone-owned', { collectProcesses: machine.collectProcesses, kill, cloneDir: clones.dir, readProcesses });
    assert.equal(fs.existsSync(folder), true);
    assert.equal(pool.listBrowserSessions()['clone-owned'].codeSignClone, null);
  } finally { await hung.close().catch(() => {}); }
});

test('a CDP close does not delete the recorded clone', async (t) => {
  const clones = cloneFixture(t);
  const server = await versionServer();
  const session = register('clone-cdp', server.port);
  const folder = clones.make('code_sign_clone.cdpclose');
  const sessions = pool.listBrowserSessions();
  sessions['clone-cdp'].codeSignClone = 'code_sign_clone.cdpclose';
  fs.writeFileSync(path.join(dataDir, 'browser-sessions.json'), JSON.stringify(sessions));
  const machine = fakeMachine(session);
  let cdpCloses = 0;
  const closeViaCdp = async () => { cdpCloses++; machine.procs.delete(4101); machine.procs.delete(4102); await server.close(); };
  const kill = (pid, signal) => machine.kills.push([pid, signal]);
  try {
    const result = await pool.closeBrowser('clone-cdp', { collectProcesses: machine.collectProcesses, kill, closeViaCdp, cloneDir: clones.dir, readProcesses: clones.readProcesses });
    assert.equal(result.closed, true);
    assert.equal(cdpCloses, 1);
    assert.deepEqual(machine.kills, []);
    assert.equal(fs.existsSync(folder), true);
    assert.equal(pool.listBrowserSessions()['clone-cdp'].codeSignClone, null);
  } finally { await server.close().catch(() => {}); }
});

test('bookmarks add, rename, move, and remove in the project record', () => {
  register('bookmark-crud', 9223);
  pool.addBookmark('bookmark-crud', { name: 'Alpha', url: 'https://alpha.example/' });
  pool.addBookmark('bookmark-crud', { name: 'Beta', url: 'https://beta.example/page' });
  assert.deepEqual(pool.listBookmarks('bookmark-crud').bookmarks, [
    { name: 'Alpha', url: 'https://alpha.example/' },
    { name: 'Beta', url: 'https://beta.example/page' },
  ]);
  pool.renameBookmark('bookmark-crud', 0, '  Alpha two  ');
  assert.equal(pool.listBookmarks('bookmark-crud').bookmarks[0].name, 'Alpha two', 'the name is trimmed');
  pool.moveBookmark('bookmark-crud', 0, 1);
  assert.deepEqual(pool.listBookmarks('bookmark-crud').bookmarks.map((b) => b.name), ['Beta', 'Alpha two']);
  pool.removeBookmark('bookmark-crud', 0);
  assert.deepEqual(pool.listBookmarks('bookmark-crud').bookmarks.map((b) => b.name), ['Alpha two']);
  assert.throws(() => pool.renameBookmark('bookmark-crud', 9, 'Gone'), /out of range/);
  assert.throws(() => pool.removeBookmark('bookmark-crud', -1), /out of range/);
  // A project with no record has no bookmarks and no start page.
  assert.deepEqual(pool.listBookmarks('bookmark-crud-absent'), { bookmarks: [], startPage: null });
  assert.throws(() => pool.addBookmark('bookmark-crud-absent', { name: 'X', url: 'https://x.example/' }), /Request a project browser first/);
});

test('a project keeps at most 30 bookmarks', () => {
  register('bookmark-limit', 9223);
  for (let i = 0; i < 30; i++) pool.addBookmark('bookmark-limit', { name: `B${i}`, url: `https://b${i}.example/` });
  assert.throws(() => pool.addBookmark('bookmark-limit', { name: 'Over', url: 'https://over.example/' }), /at most 30/);
  assert.equal(pool.listBookmarks('bookmark-limit').bookmarks.length, 30);
});

test('bookmarks refuse credentials, non-http URLs, and long names', () => {
  register('bookmark-urls', 9223);
  assert.throws(() => pool.addBookmark('bookmark-urls', { name: 'Cred', url: 'https://user:secret@example.com/' }), /must not hold credentials/);
  assert.throws(() => pool.addBookmark('bookmark-urls', { name: 'File', url: 'file:///etc/passwd' }), /http or https/);
  assert.throws(() => pool.addBookmark('bookmark-urls', { name: 'Ftp', url: 'ftp://example.com/' }), /http or https/);
  assert.throws(() => pool.addBookmark('bookmark-urls', { name: 'N'.repeat(61), url: 'https://ok.example/' }), /at most 60 characters/);
  assert.throws(() => pool.addBookmark('bookmark-urls', { name: '  ', url: 'https://ok.example/' }), /name is required/);
  assert.throws(() => pool.setStartPage('bookmark-urls', 'https://user:secret@example.com/'), /must not hold credentials/);
  assert.throws(() => pool.setStartPage('bookmark-urls', 'file:///etc/passwd'), /http or https/);
  assert.equal(pool.listBookmarks('bookmark-urls').bookmarks.length, 0);
  assert.equal(pool.listBookmarks('bookmark-urls').startPage, null);
});

test('the start page is stored, cleared with null, and opens on a new launch', async (t) => {
  register('start-page-launch', 9299);
  const saved = pool.setStartPage('start-page-launch', 'https://start.example/home');
  assert.equal(saved.startPage, 'https://start.example/home');
  assert.equal(pool.listBookmarks('start-page-launch').startPage, 'https://start.example/home');
  // Add a second record without overwriting the first one.
  const sessions = pool.listBrowserSessions();
  sessions['no-start-page'] = { project: 'no-start-page', port: 9298, profile: path.join(dataDir, 'browser-profiles', 'no-start-page'), headless: true, windowSize: { width: 1280, height: 800 }, pid: null };
  fs.writeFileSync(path.join(dataDir, 'browser-sessions.json'), JSON.stringify(sessions));
  const clones = cloneFixture(t);
  const launchFixtures = () => {
    const machine = { procs: new Map() };
    const launchNet = fakeLaunchNet();
    const capture = { args: null };
    const spawn = (chrome, args) => {
      capture.args = args;
      const port = Number(args.find((a) => a.startsWith('--remote-debugging-port=')).split('=')[1]);
      const profile = args.find((a) => a.startsWith('--user-data-dir=')).split('=')[1];
      machine.procs.set(4600 + machine.procs.size, { pid: 4600 + machine.procs.size, cmd: chromeCmd(port, profile) });
      launchNet.launched.add(port);
      return { pid: 4601, on() {}, unref() {} };
    };
    return { machine, launchNet, capture, spawn };
  };
  const withStart = launchFixtures();
  await pool.requestBrowser('start-page-launch', { headless: true, chromePath: process.execPath, spawn: withStart.spawn,
    collectProcesses: async () => new Map(withStart.machine.procs), cloneDir: clones.dir, portOpen: withStart.launchNet.portOpen, fetch: withStart.launchNet.fetch });
  assert.equal(withStart.capture.args.at(-1), 'https://start.example/home', 'the first tab opens the start page');
  assert.ok(!withStart.capture.args.includes('about:blank'), 'the launch does not also open about:blank');
  assert.equal(pool.listBookmarks('start-page-launch').startPage, 'https://start.example/home', 'a launch keeps the start page');
  // A launch without a start page opens about:blank.
  const plain = launchFixtures();
  await pool.requestBrowser('no-start-page', { headless: true, chromePath: process.execPath, spawn: plain.spawn,
    collectProcesses: async () => new Map(plain.machine.procs), cloneDir: clones.dir, portOpen: plain.launchNet.portOpen, fetch: plain.launchNet.fetch });
  assert.equal(plain.capture.args.at(-1), 'about:blank');
  // Clearing the start page removes it.
  assert.equal(pool.setStartPage('start-page-launch', null).startPage, null);
  assert.equal(pool.listBookmarks('start-page-launch').startPage, null);
});

test('a launch keeps existing bookmarks, and an add on a record without them starts an empty list', () => {
  register('bookmark-keep', 9223);
  pool.addBookmark('bookmark-keep', { name: 'Keep', url: 'https://keep.example/' });
  assert.deepEqual(pool.listBrowserSessions()['bookmark-keep'].bookmarks, [{ name: 'Keep', url: 'https://keep.example/' }]);
  assert.equal(pool.listBrowserSessions()['bookmark-keep'].startPage, null);
  // A record written before bookmarks existed gains the fields on the first change, and keeps its other fields.
  const sessions = pool.listBrowserSessions();
  delete sessions['bookmark-keep'].bookmarks;
  delete sessions['bookmark-keep'].startPage;
  fs.writeFileSync(path.join(dataDir, 'browser-sessions.json'), JSON.stringify(sessions));
  pool.addBookmark('bookmark-keep', { name: 'Second', url: 'https://second.example/' });
  const record = pool.listBrowserSessions()['bookmark-keep'];
  assert.deepEqual(record.bookmarks.map((b) => b.name), ['Second']);
  assert.equal(record.startPage, null);
  assert.equal(record.port, 9223, 'the other record fields stay');
  assert.equal(record.profile, path.join(dataDir, 'browser-profiles', 'bookmark-keep'));
});

test('a browser launch starts Chrome in its profile folder, not in the caller folder', async (t) => {
  const clones = cloneFixture(t);
  const machine = { procs: new Map() };
  const launchNet = fakeLaunchNet();
  let spawnOptions = null;
  const spawn = (chrome, args, options) => {
    spawnOptions = options;
    const port = Number(args.find((a) => a.startsWith('--remote-debugging-port=')).split('=')[1]);
    const profile = args.find((a) => a.startsWith('--user-data-dir=')).split('=')[1];
    machine.procs.set(4302, { pid: 4302, cmd: chromeCmd(port, profile) });
    launchNet.launched.add(port);
    return { pid: 4302, on() {}, unref() {} };
  };
  const status = await pool.requestBrowser('cwd-launch', { headless: true, chromePath: process.execPath, spawn,
    collectProcesses: async () => new Map(machine.procs), cloneDir: clones.dir, portOpen: launchNet.portOpen, fetch: launchNet.fetch });
  assert.equal(spawnOptions.cwd, status.profile);
  assert.notEqual(spawnOptions.cwd, process.cwd());
});
