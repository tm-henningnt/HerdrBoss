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

function register(project, port) {
  const profile = path.join(dataDir, 'browser-profiles', project);
  const sessions = pool.listBrowserSessions();
  sessions[project] = { project, port, profile, headless: true, windowSize: { width: 1280, height: 800 }, pid: null };
  fs.writeFileSync(path.join(dataDir, 'browser-sessions.json'), JSON.stringify(sessions));
  return sessions[project];
}

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
  let relaunched = null;
  const kill = (pid, signal) => { machine.kills.push([pid, signal]); machine.procs.delete(4101); machine.procs.delete(4102); hung.close(); };
  const spawn = (chrome, args) => {
    const port = Number(args.find((a) => a.startsWith('--remote-debugging-port=')).split('=')[1]);
    const profile = args.find((a) => a.startsWith('--user-data-dir=')).split('=')[1];
    machine.procs.set(4201, { pid: 4201, cmd: chromeCmd(port, profile) });
    relaunched = versionServer(port);
    return { pid: 4201, on() {}, unref() {} };
  };
  try {
    const result = await pool.restartBrowser('hung-restart', true, {
      collectProcesses: machine.collectProcesses, kill, spawn, chromePath: process.execPath,
    });
    assert.deepEqual(machine.kills, [[4101, 'SIGTERM']]);
    assert.equal(result.restoredPage, false);
    assert.equal(result.restoreError, undefined);
    assert.equal(result.profileVerified, true);
    assert.equal(result.responsive, true);
    assert.equal(result.pid, 4201);
  } finally {
    await hung.close().catch(() => {});
    if (relaunched) await (await relaunched).close();
  }
});
