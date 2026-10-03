import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'src', 'cli.js');

function temporaryDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `herdr-preview-bind-${tag}-`));
}

// The probe starts serve() with a stub Engine and prints the bind address, then makes one request with a remote Host header.
const probe = `
  const { EventEmitter } = await import('node:events');
  const http = await import('node:http');
  const { serve } = await import('./src/server.js');
  const { loadConfig } = await import('./src/config.js');
  const options = JSON.parse(process.env.PROBE_OPTIONS);
  const cfg = loadConfig();
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  if (options.cfgHost !== undefined) cfg.host = options.cfgHost;
  const engine = new EventEmitter();
  engine.act = false;
  engine.push = false;
  engine.state = { ok: true };
  engine.tick = async () => engine.state;
  engine.log = () => {};
  const { server, close } = serve(cfg, { readOnlyPreview: options.preview, previewHost: options.previewHost, liveDataDir: process.env.HERDR_BOSS_DIR, createEngine: () => engine });
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const { address, port } = server.address();
  const status = await new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: '/api/state', headers: { host: 'mac.tail0000.ts.net' } }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
    request.end();
  });
  await close();
  console.log('RESULT ' + JSON.stringify({ address, remoteStatus: status }));
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A zombie stays in its group until its parent reaps it. It runs no code, so it does not count as alive.
function groupStates(pid) {
  const listing = spawnSync('ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8' }).stdout || '';
  return listing.split('\n').map((line) => line.trim().split(/\s+/)).filter(([group]) => Number(group) === pid).map(([, state]) => state);
}

function groupAlive(pid) {
  return groupStates(pid).some((state) => !state.startsWith('Z'));
}

// The child can leave a process behind, for example a tool check that writes into HOME after the child exits.
// Wait until the whole process group is gone. Escalate to SIGTERM, then SIGKILL, when the group stays alive.
async function settleGroup(pid, { termAfterMs = 3000, killAfterMs = 6000, limitMs = 15000 } = {}) {
  const start = Date.now();
  let termSent = false;
  let killSent = false;
  while (groupAlive(pid)) {
    const waited = Date.now() - start;
    if (waited > limitMs) throw new Error(`process group ${pid} still alive after ${limitMs} ms, states ${groupStates(pid).join(',')}`);
    if (!termSent && waited >= termAfterMs) { termSent = true; try { process.kill(-pid, 'SIGTERM'); } catch {} }
    if (!killSent && waited >= killAfterMs) { killSent = true; try { process.kill(-pid, 'SIGKILL'); } catch {} }
    await sleep(20);
  }
}

// Run a command in its own process group. Resolve after the child and every process of its group have exited.
async function runGrouped(command, args, options) {
  const child = spawn(command, args, { ...options, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, options.timeout ?? 20000);
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  clearTimeout(timer);
  await settleGroup(child.pid);
  return { status, stdout, stderr };
}

function runProbe(t, options) {
  const home = temporaryDir('home');
  const dataDir = temporaryDir('data');
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 20000,
    env: { PATH: process.env.PATH, HOME: home, HERDR_BOSS_DIR: dataDir, PROBE_OPTIONS: JSON.stringify(options) },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1).slice('RESULT '.length));
}

function runCli(t, args) {
  const home = temporaryDir('cli-home');
  const dataDir = temporaryDir('cli-data');
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return spawnSync(process.execPath, [cli, 'serve', ...args], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 10000,
    env: { PATH: process.env.PATH, HOME: home, HERDR_BOSS_DIR: dataDir, HERDR_BOSS_PORT: '0' },
  });
}

test('a read-only preview binds 127.0.0.1 although the configured host is all interfaces', { timeout: 30000 }, (t) => {
  const { address } = runProbe(t, { preview: true, cfgHost: '0.0.0.0' });
  assert.equal(address, '127.0.0.1');
});

test('a read-only preview binds the address in previewHost', { timeout: 30000 }, (t) => {
  const { address } = runProbe(t, { preview: true, cfgHost: '127.0.0.1', previewHost: '0.0.0.0' });
  assert.equal(address, '0.0.0.0');
});

test('serve refuses previewHost without a read-only preview, and refuses an empty or malformed previewHost', { timeout: 30000 }, (t) => {
  for (const options of [
    { preview: false, cfgHost: '127.0.0.1', previewHost: '127.0.0.1' },
    { preview: true, previewHost: '' },
    { preview: true, previewHost: 'bad host' },
  ]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 20000,
      env: { PATH: process.env.PATH, HOME: temporaryDir('refuse'), HERDR_BOSS_DIR: temporaryDir('refuse-data'), PROBE_OPTIONS: JSON.stringify(options) },
    });
    assert.notEqual(result.status, 0, JSON.stringify(options));
    assert.match(result.stderr, /--host|previewHost/, JSON.stringify(options));
  }
  t.diagnostic('refusals checked');
});

test('the main service still binds the configured host and answers 401 to a remote request without a token', { timeout: 30000 }, (t) => {
  const all = runProbe(t, { preview: false, cfgHost: '0.0.0.0' });
  assert.equal(all.address, '0.0.0.0');
  assert.equal(all.remoteStatus, 401);
  const loopback = runProbe(t, { preview: false, cfgHost: '127.0.0.1' });
  assert.equal(loopback.address, '127.0.0.1');
  assert.equal(loopback.remoteStatus, 401);
});

test('the helper waits for a process that outlives its parent', { timeout: 30000 }, async (t) => {
  const dir = temporaryDir('orphan');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = `
    const { spawn } = require('node:child_process');
    const orphan = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { stdio: 'ignore' });
    require('node:fs').writeFileSync(${JSON.stringify(path.join(dir, 'pid'))}, String(orphan.pid));
    orphan.unref();
  `;
  const result = await runGrouped(process.execPath, ['-e', script], { timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const orphanPid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8'));
  assert.throws(() => process.kill(orphanPid, 0), { code: 'ESRCH' });
});

test('the CLI prints the actual bind address of a read-only preview', { timeout: 60000 }, async (t) => {
  for (const [args, expected] of [[['--read-only-preview'], '127.0.0.1'], [['--read-only-preview', '--host', '0.0.0.0'], '0.0.0.0']]) {
    const home = temporaryDir('line-home');
    const dataDir = temporaryDir('line-data');
    t.after(() => {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(dataDir, { recursive: true, force: true });
    });
    const child = await runGrouped(process.execPath, ['--input-type=module', '-e', `
      process.argv = [process.argv[0], ${JSON.stringify(cli)}, 'serve', ...${JSON.stringify(args)}];
      const lines = [];
      const log = console.log;
      console.log = (...items) => { lines.push(items.join(' ')); if (lines.some((l) => l.startsWith('herdr-boss: http://'))) { log(lines.find((l) => l.startsWith('herdr-boss: http://'))); process.exit(0); } };
      await import(${JSON.stringify(cli)});
    `], {
      cwd: repo, timeout: 20000,
      env: { PATH: process.env.PATH, HOME: home, HERDR_BOSS_DIR: dataDir, HERDR_BOSS_PORT: '0', HERDR_BOSS_PUSH: '0' },
    });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, new RegExp(`herdr-boss: http://${expected.replaceAll('.', '\\.')}:\\d+`));
  }
});

test('--host without --read-only-preview is a usage error', { timeout: 30000 }, (t) => {
  for (const args of [['--host', '127.0.0.1'], ['--host']]) {
    const result = runCli(t, args);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Usage: serve/);
  }
});

test('--host with an empty or malformed value is a usage error', { timeout: 30000 }, (t) => {
  for (const args of [['--read-only-preview', '--host'], ['--read-only-preview', '--host', ''], ['--read-only-preview', '--host', 'bad host'], ['--read-only-preview', '--host', 'a', '--host', 'b']]) {
    const result = runCli(t, args);
    assert.equal(result.status, 1, `${JSON.stringify(args)}: ${result.stderr}`);
    assert.match(result.stderr, /--host|Usage: serve/);
  }
});
