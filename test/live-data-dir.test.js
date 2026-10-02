import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-live-start-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home };
}

function run(home, env, source) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, HOME: home, HERDR_BOSS_DIR: '', HERDR_BOSS_LIVE_DIR: '', HERDR_BOSS_PORT: '0', ...env },
  });
}

const refusalProbe = `
  import { serve } from './src/server.js';
  let created = false;
  let message = '';
  try {
    serve({ access: { tokenFile: process.env.HOME + '/unused-token', sessionDays: 30 } }, {
      createEngine: () => { created = true; throw new Error('unexpected Engine creation'); },
    });
  } catch (error) { message = error.message; }
  console.log(JSON.stringify({ created, message }));
`;

test('direct service startup refuses a different data directory before any write or Engine creation', (t) => {
  const { root, home } = fixture(t);
  const data = path.join(root, 'other');
  const live = path.join(root, 'live');
  const result = run(home, { HERDR_BOSS_DIR: data, HERDR_BOSS_LIVE_DIR: live }, refusalProbe);
  assert.equal(result.status, 0, result.stderr);
  const answer = JSON.parse(result.stdout);
  assert.equal(answer.created, false, answer.message);
  assert.match(answer.message, /data directory.*live data directory/);
  assert.ok(answer.message.includes(data));
  assert.ok(answer.message.includes(live));
  assert.equal(fs.existsSync(data), false);
  assert.equal(fs.existsSync(path.join(home, 'unused-token')), false);
});

test('CLI serve refuses a mismatched data directory before loadConfig creates it', (t) => {
  const { root, home } = fixture(t);
  const data = path.join(root, 'other');
  const result = spawnSync(process.execPath, ['src/cli.js', 'serve'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 10000,
    env: { ...process.env, HOME: home, HERDR_BOSS_DIR: data, HERDR_BOSS_LIVE_DIR: path.join(root, 'live'), HERDR_BOSS_PORT: '0' },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /data directory.*live data directory/);
  assert.equal(fs.existsSync(data), false);
  assert.equal(fs.existsSync(path.join(home, '.config', 'herdr-boss')), false);
});

const serviceProbe = `
  import { EventEmitter } from 'node:events';
  import { serve } from './src/server.js';
  import { loadConfig, DATA_DIR, LIVE_DATA_DIR } from './src/config.js';
  const cfg = loadConfig();
  cfg.host = '127.0.0.1'; cfg.port = 0; cfg.tickSeconds = 3600;
  const engine = new EventEmitter();
  engine.cfg = cfg; engine.state = { ok: true }; engine.tick = async () => engine.state; engine.log = () => {};
  const app = serve(cfg, { createEngine: () => engine });
  await new Promise((resolve, reject) => { app.server.once('listening', resolve); app.server.once('error', reject); });
  try {
    const response = await fetch('http://127.0.0.1:' + app.server.address().port + '/api/state');
    console.log('RESULT ' + JSON.stringify({ status: response.status, data: DATA_DIR, live: LIVE_DATA_DIR }));
  } finally { await app.close(); }
`;

test('the default paths in a temporary HOME start the live service', (t) => {
  const { home } = fixture(t);
  const result = run(home, {}, serviceProbe);
  assert.equal(result.status, 0, result.stderr);
  const answer = JSON.parse(result.stdout.trim().split('\n').at(-1).slice(7));
  assert.deepEqual(answer, { status: 200, data: path.join(home, '.herdr-boss'), live: path.join(home, '.herdr-boss') });
});

test('service startup refuses different configured paths even when their parents are aliases', (t) => {
  const { root, home } = fixture(t);
  const parent = path.join(root, 'parent');
  fs.mkdirSync(parent);
  const alias = path.join(root, 'alias');
  fs.symlinkSync(parent, alias, 'dir');
  const result = run(home, { HERDR_BOSS_DIR: path.join(alias, 'data'), HERDR_BOSS_LIVE_DIR: path.join(parent, 'data') }, refusalProbe);
  assert.equal(result.status, 0, result.stderr);
  const answer = JSON.parse(result.stdout);
  assert.equal(answer.created, false);
  assert.match(answer.message, /data directory.*live data directory/);
  assert.equal(fs.existsSync(path.join(parent, 'data')), false);
});

test('a direct fixture call can name its live directory without changing CLI defaults', (t) => {
  const { root, home } = fixture(t);
  const data = path.join(root, 'fixture');
  const source = serviceProbe.replace('createEngine: () => engine', 'liveDataDir: process.env.HERDR_BOSS_DIR, createEngine: () => engine');
  const result = run(home, { HERDR_BOSS_DIR: data, HERDR_BOSS_LIVE_DIR: path.join(root, 'live') }, source);
  assert.equal(result.status, 0, result.stderr);
});

test('argv and a serve-option environment variable cannot bypass the CLI live directory check', (t) => {
  const { root, home } = fixture(t);
  const data = path.join(root, 'other');
  for (const args of [[], ['--live-data-dir', data]]) {
    const result = spawnSync(process.execPath, ['src/cli.js', 'serve', ...args], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 10000,
      env: { ...process.env, HOME: home, HERDR_BOSS_DIR: data, HERDR_BOSS_LIVE_DIR: path.join(root, 'live'), HERDR_BOSS_SERVE_LIVE_DATA_DIR: data, liveDataDir: data },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /data directory.*live data directory/);
    assert.equal(fs.existsSync(data), false);
  }
});
