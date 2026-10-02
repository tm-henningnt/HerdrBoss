import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { serviceSettingsView, validateServiceSettings, writeServiceSettings, loadConfig, hostAllowedByList } from '../src/config.js';
import { createRotatingLog } from '../src/server-log.js';
import { serve } from '../src/server.js';

const tmp = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// Inline check of the required fields, types, and patterns of factory-health.v1.schema.json (contract 1.0.0).
function assertHealthBody(body) {
  const required = ['schema', 'contractVersion', 'version', 'kitRevision', 'tickAgeSeconds', 'herdrReachable', 'clockOffsetSeconds'];
  assert.deepEqual(Object.keys(body).sort(), [...required].sort(), 'the body holds exactly the schema fields');
  assert.equal(body.schema, 1);
  assert.match(body.contractVersion, /^1\.[0-9]+\.[0-9]+$/);
  assert.match(body.version, /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/);
  assert.ok(body.version.length <= 64);
  assert.match(body.kitRevision, /^[a-f0-9]{12,64}$/);
  assert.ok(body.tickAgeSeconds === null || (Number.isInteger(body.tickAgeSeconds) && body.tickAgeSeconds >= 0 && body.tickAgeSeconds <= Number.MAX_SAFE_INTEGER));
  assert.ok(body.herdrReachable === null || typeof body.herdrReachable === 'boolean');
  assert.ok(body.clockOffsetSeconds === null || (typeof body.clockOffsetSeconds === 'number' && Number.isFinite(body.clockOffsetSeconds)));
}

async function start(t, { state, config = {}, health } = {}) {
  const cfg = loadConfig();
  Object.assign(cfg, { host: '127.0.0.1', port: 0, tickSeconds: 3600, ...config });
  const engine = new EventEmitter();
  engine.state = state;
  engine.tick = async () => engine.state;
  engine.log = () => {};
  const app = serve(cfg, { liveDataDir: process.env.HERDR_BOSS_DIR, createEngine: () => engine, ...(health ? { health } : {}) });
  t.after(() => app.close());
  if (!app.server.listening) await once(app.server, 'listening');
  return { app, cfg, port: app.server.address().port };
}

function get(port, route, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: route, method: 'GET', headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('allowedHosts defaults to an empty list and keeps the current host rule', () => {
  const view = serviceSettingsView({}).find(({ setting }) => setting === 'allowedHosts');
  assert.deepEqual(view, { group: 'Service', setting: 'allowedHosts', value: [], source: 'default' });
  assert.equal(hostAllowedByList('factory.localhost', []), false);
  assert.equal(hostAllowedByList('factory', []), false);
});

test('allowedHosts matches *.localhost and named hosts and nothing else', () => {
  const list = ['*.localhost', 'factory-two', 'Box.Example.Test'];
  assert.equal(hostAllowedByList('a.localhost', list), true);
  assert.equal(hostAllowedByList('a.b.localhost', list), true);
  assert.equal(hostAllowedByList('localhost', ['*.localhost']), false);
  assert.equal(hostAllowedByList('evil-localhost', list), false);
  assert.equal(hostAllowedByList('a.localhost.evil.test', list), false);
  assert.equal(hostAllowedByList('factory-two', list), true);
  assert.equal(hostAllowedByList('FACTORY-TWO', list), true);
  assert.equal(hostAllowedByList('factory-twox', list), false);
  assert.equal(hostAllowedByList('box.example.test', list), true);
  assert.equal(hostAllowedByList('', list), false);
});

test('allowedHosts validation accepts host names and refuses addresses, ports, paths, and a bare wildcard', (t) => {
  assert.deepEqual(validateServiceSettings({ allowedHosts: ['*.localhost', 'factory-two'] }), { allowedHosts: ['*.localhost', 'factory-two'] });
  assert.deepEqual(validateServiceSettings({ allowedHosts: [] }), { allowedHosts: [] });
  for (const bad of ['*', '*.', '**.localhost', 'a*.localhost', 'host:4477', 'http://host', 'host/path', 'user@host', '', ' ', 'under_score', '-lead', 'a..b', 'x'.repeat(254), '*.*.localhost']) {
    assert.throws(() => validateServiceSettings({ allowedHosts: [bad] }), /allowedHosts/, `refuses ${JSON.stringify(bad)}`);
  }
  for (const bad of ['factory', null, 5, {}]) assert.throws(() => validateServiceSettings({ allowedHosts: bad }), /allowedHosts/);
  assert.throws(() => validateServiceSettings({ allowedHosts: Array.from({ length: 51 }, (_, i) => `h${i}`) }), /allowedHosts/);
  assert.throws(() => validateServiceSettings({ allowedHosts: ['a', 'A'] }), /duplicate/);
  const dataDir = tmp(t, 'herdr-hosts-config-');
  writeServiceSettings({ allowedHosts: ['factory-two'] }, { dataDir });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')), { allowedHosts: ['factory-two'] });
});

test('the log settings are visible and bounded', (t) => {
  const view = serviceSettingsView({});
  assert.deepEqual(view.find(({ setting }) => setting === 'log.maxMegabytes'), { group: 'Service', setting: 'log.maxMegabytes', value: 10, source: 'default' });
  assert.deepEqual(view.find(({ setting }) => setting === 'log.keepFiles'), { group: 'Service', setting: 'log.keepFiles', value: 2, source: 'default' });
  assert.deepEqual(validateServiceSettings({ 'log.maxMegabytes': 1, 'log.keepFiles': 1 }), { 'log.maxMegabytes': 1, 'log.keepFiles': 1 });
  assert.deepEqual(validateServiceSettings({ 'log.maxMegabytes': 1000, 'log.keepFiles': 2 }), { 'log.maxMegabytes': 1000, 'log.keepFiles': 2 });
  for (const [key, value] of [['log.maxMegabytes', 0], ['log.maxMegabytes', 1001], ['log.maxMegabytes', 1.5], ['log.keepFiles', 0], ['log.keepFiles', 3], ['log.keepFiles', null]]) {
    assert.throws(() => validateServiceSettings({ [key]: value }), new RegExp(key.replace('.', '\\.')), `${key} refuses ${value}`);
  }
});

test('the server accepts a listed host and still refuses an unlisted one', async (t) => {
  const { port, cfg } = await start(t, { state: { updatedAt: new Date().toISOString(), herdr: { panes: [] }, errors: [] } });
  const unlisted = await get(port, '/api/health', { host: 'factory-two.localhost' });
  assert.equal(unlisted.status, 403);
  cfg.allowedHosts = ['*.localhost'];
  const listed = await get(port, '/api/health', { host: 'factory-two.localhost' });
  assert.notEqual(listed.status, 403, 'the host check passes for a listed host');
  const other = await get(port, '/api/health', { host: 'example.test' });
  assert.equal(other.status, 403);
});

test('GET /api/health returns the contract body from loopback without a login', async (t) => {
  const { port } = await start(t, { state: { updatedAt: new Date(Date.now() - 12_000).toISOString(), herdr: { panes: [] }, errors: [] } });
  const response = await get(port, '/api/health');
  assert.equal(response.status, 200);
  const body = JSON.parse(response.text);
  assertHealthBody(body);
  assert.equal(body.herdrReachable, true);
  assert.ok(body.tickAgeSeconds >= 12 && body.tickAgeSeconds < 60);
  assert.equal(body.version, JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  assert.ok(!response.text.includes(os.homedir()) && !response.text.includes(process.env.HERDR_BOSS_DIR), 'no path in the body');
});

test('GET /api/health reports null readings before the first tick and false when Herdr failed', async (t) => {
  const first = await start(t, { state: undefined });
  const empty = JSON.parse((await get(first.port, '/api/health')).text);
  assertHealthBody(empty);
  assert.equal(empty.tickAgeSeconds, null);
  assert.equal(empty.herdrReachable, null);
  const failed = await start(t, { state: { updatedAt: new Date().toISOString(), herdr: null, errors: ['herdr: connection refused'] } });
  const body = JSON.parse((await get(failed.port, '/api/health')).text);
  assertHealthBody(body);
  assert.equal(body.herdrReachable, false);
});

test('GET /api/health needs the access token from a non-loopback host', async (t) => {
  const { port } = await start(t, { state: undefined, config: { allowedHosts: ['factory-two'] } });
  const response = await get(port, '/api/health', { host: 'factory-two' });
  assert.equal(response.status, 401);
});

test('the rotating log rotates at the size limit and keeps the set number of old files', (t) => {
  const dir = tmp(t, 'herdr-rotating-log-');
  const file = path.join(dir, 'service.log');
  const log = createRotatingLog({ file, maxBytes: () => 100, keepFiles: () => 2 });
  const line = (n) => `line ${String(n).padStart(2, '0')} ${'x'.repeat(20)}`;
  for (let n = 0; n < 12; n += 1) log.write(line(n));
  const names = fs.readdirSync(dir).sort();
  assert.deepEqual(names, ['service.log', 'service.log.1', 'service.log.2']);
  for (const name of names) assert.ok(fs.statSync(path.join(dir, name)).size <= 100, `${name} stays within the limit`);
  const all = names.map((name) => fs.readFileSync(path.join(dir, name), 'utf8')).join('');
  assert.ok(all.includes(line(11)), 'the newest line is kept');
  assert.ok(!all.includes(line(0)), 'the oldest line is gone');
  assert.match(fs.readFileSync(`${file}.1`, 'utf8'), /line/);
});

test('the rotating log keeps one old file when keepFiles is 1 and reads the limit on each write', (t) => {
  const dir = tmp(t, 'herdr-rotating-log-');
  const file = path.join(dir, 'service.log');
  let limit = 1000;
  const log = createRotatingLog({ file, maxBytes: () => limit, keepFiles: () => 1 });
  for (let n = 0; n < 5; n += 1) log.write(`line ${n}`);
  assert.deepEqual(fs.readdirSync(dir), ['service.log']);
  limit = 20;
  for (let n = 0; n < 10; n += 1) log.write(`line number ${n}`);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['service.log', 'service.log.1']);
});

test('the rotating log keeps a line longer than the limit and never throws on a bad path', (t) => {
  const dir = tmp(t, 'herdr-rotating-log-');
  const log = createRotatingLog({ file: path.join(dir, 'a.log'), maxBytes: () => 10, keepFiles: () => 2 });
  assert.doesNotThrow(() => log.write('y'.repeat(50)));
  assert.match(fs.readFileSync(path.join(dir, 'a.log'), 'utf8'), /y{50}/);
  const broken = createRotatingLog({ file: path.join(dir, 'missing', 'deep', 'a.log'), maxBytes: () => 10, keepFiles: () => 2 });
  assert.doesNotThrow(() => broken.write('hello'));
});

test('GET /api/health answers 503 with no path when the kit revision is unknown', async (t) => {
  const { createHealth } = await import('../src/health.js');
  const { port } = await start(t, { state: { updatedAt: new Date().toISOString(), herdr: { panes: [] }, errors: [] }, health: createHealth({ readKit: () => null }) });
  const response = await get(port, '/api/health');
  assert.equal(response.status, 503);
  assert.deepEqual(JSON.parse(response.text), { error: 'kit revision unknown' });
});

test('the rotating log removes surplus old files when keepFiles is lowered', (t) => {
  const dir = tmp(t, 'herdr-rotating-log-');
  const file = path.join(dir, 'service.log');
  fs.writeFileSync(`${file}.2`, 'old\n');
  const log = createRotatingLog({ file, maxBytes: () => 20, keepFiles: () => 1 });
  for (let n = 0; n < 6; n += 1) log.write(`line number ${n}`);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['service.log', 'service.log.1']);
});

test('a failed rotation keeps the line, keeps the log open, and warns at most once per minute', (t) => {
  const dir = tmp(t, 'herdr-rotating-log-');
  const file = path.join(dir, 'service.log');
  fs.mkdirSync(`${file}.1`);
  fs.writeFileSync(path.join(`${file}.1`, 'block'), 'x');
  const warnings = [];
  let clock = 1_000_000;
  const log = createRotatingLog({ file, maxBytes: () => 20, keepFiles: () => 1, warn: (message) => warnings.push(message), now: () => clock });
  for (let n = 0; n < 4; n += 1) log.write(`line number ${n}`);
  const text = fs.readFileSync(file, 'utf8');
  for (let n = 0; n < 4; n += 1) assert.ok(text.includes(`line number ${n}`), `line ${n} is kept`);
  assert.equal(warnings.length, 1);
  clock += 61_000;
  log.write('line number 4');
  assert.equal(warnings.length, 2);
  assert.ok(!warnings.join('').includes(dir), 'the warning holds no path');
});

test('loadConfig validates hand-edited allowedHosts and log values like the API', (t) => {
  const file = path.join(process.env.HERDR_BOSS_DIR, 'config.json');
  const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
  t.after(() => { if (before === null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, before); });
  const stderr = [];
  const original = process.stderr.write;
  const load = (config) => {
    fs.writeFileSync(file, JSON.stringify(config));
    stderr.length = 0;
    process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
    try { return loadConfig(); } finally { process.stderr.write = original; }
  };
  for (const bad of [['*.'], ['*.com'], ['host:4477'], ['*'], 'factory']) {
    const cfg = load({ allowedHosts: bad });
    assert.deepEqual(cfg.allowedHosts, [], `falls back for ${JSON.stringify(bad)}`);
    assert.equal(stderr.length, 1);
    assert.match(stderr[0], /allowedHosts/);
    assert.ok(!stderr[0].includes('4477'), 'the warning does not print the value');
  }
  assert.deepEqual(load({ allowedHosts: ['*.localhost', '*.example.test', 'Factory-Two'] }).allowedHosts, ['*.localhost', '*.example.test', 'factory-two']);
  assert.equal(stderr.length, 0);
  const bad = load({ log: { maxMegabytes: 'ten', keepFiles: 5 } });
  assert.deepEqual(bad.log, { maxMegabytes: 10, keepFiles: 2 });
  assert.equal(stderr.length, 2);
  assert.match(stderr.join(''), /log\.maxMegabytes/);
  assert.match(stderr.join(''), /log\.keepFiles/);
  assert.ok(!stderr.join('').includes('ten'));
  assert.deepEqual(load({ log: { maxMegabytes: 50, keepFiles: 1 } }).log, { maxMegabytes: 50, keepFiles: 1 });
});

test('allowedHosts wildcards need two labels after *. except *.localhost', () => {
  for (const bad of ['*.com', '*.test']) assert.throws(() => validateServiceSettings({ allowedHosts: [bad] }), /allowedHosts/, bad);
  for (const good of ['*.localhost', '*.example.test', '*.a.b.c']) assert.deepEqual(validateServiceSettings({ allowedHosts: [good] }), { allowedHosts: [good] });
});
