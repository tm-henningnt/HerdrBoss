import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import { serve } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { validateFile } from './factory/schema-check.js';

const root = process.env.HERDR_BOSS_DIR;
process.env.HERDR_FACTORIES_DIR = path.join(root, 'factories');
const schemaFile = new URL('../docs/contracts/schema/fleet-summary.v1.schema.json', import.meta.url).pathname;
export function request(port, route, { method = 'GET', token, body, host, cookie, rawBody } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(host ? { host } : {}), ...(cookie ? { cookie } : {}), ...(rawBody ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(body ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let text = ''; res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: (() => { try { return JSON.parse(text); } catch { return text; } })() }));
    });
    req.on('error', reject); req.end(rawBody || (body ? JSON.stringify(body) : undefined));
  });
}
async function start(t, fleet = {}) {
  const cfg = { ...loadConfig(), host: '127.0.0.1', port: 0, tickSeconds: 3600, allowedHosts: ['*.localhost'] };
  const engine = new EventEmitter();
  engine.state = { updatedAt: new Date().toISOString(), herdr: { panes: [] }, errors: [], kit: { current: 'abcdef012345' },
    machine: { load: [1, 2, 3], cpus: 4, memTotalGB: 8, memFreePercent: 55, swapUsedMB: 3, path: '/private/fixture' },
    projects: [], quotas: [], token: 'invented-secret', messages: [{ text: 'PRIVATE MESSAGE' }] };
  engine.tick = async () => engine.state; engine.log = () => {};
  const app = serve(cfg, { liveDataDir: root, createEngine: () => engine, health: async () => ({ schema: 1, contractVersion: '1.0.0', version: '0.1.0', kitRevision: 'abcdef012345', tickAgeSeconds: 1, herdrReachable: true, clockOffsetSeconds: null }), fleet });
  t.after(() => app.close());
  if (!app.server.listening) await once(app.server, 'listening');
  return { app, cfg, port: app.server.address().port };
}

test('the real fleet summary route emits the closed contract without private state', async (t) => {
  const { port } = await start(t);
  const result = await request(port, '/api/fleet/summary');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(validateFile(result.body, schemaFile), []);
  assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE MESSAGE|invented-secret|private\/fixture|token|messages|path/);
  assert.deepEqual(result.body.machine, { load1: 1, load5: 2, load15: 3, cpus: 4, memoryTotalMb: 8192, memoryFreePercent: 55, swapUsedMb: 3 });
  const again = await request(port, '/api/fleet/summary');
  assert.equal(again.body.factoryId, result.body.factoryId);
});

test('fleetRead stays read-only on loopback and during rotation', async (t) => {
  const { createFleetReadAccess } = await import('../src/fleet-access.js');
  let now = Date.parse('2026-10-03T03:00:00Z');
  const privateDir = path.join(root, 'private-fleet');
  const credentials = createFleetReadAccess({ privateDir, now: () => now });
  const old = credentials.rotate();
  const { port, cfg } = await start(t, { privateDir, now: () => now });
  const ownerToken = fs.readFileSync(cfg.access.tokenFile, 'utf8').trim();
  const login = await request(port, '/login', { host: 'factory.localhost', method: 'POST', rawBody: new URLSearchParams({ token: ownerToken }).toString() });
  assert.equal(login.status, 303);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  assert.equal((await request(port, '/api/state', { host: 'factory.localhost', cookie })).status, 200);
  assert.equal((await request(port, '/api/state', { host: 'factory.localhost', cookie, token: old })).status, 403);
  assert.equal((await request(port, '/api/fleet/summary', { host: 'factory.localhost', token: old })).status, 200);
  assert.equal((await request(port, '/api/fleet/summary', { host: 'factory.localhost' })).status, 401);
  assert.equal((await request(port, '/api/fleet/summary', { token: old })).status, 200);
  assert.equal((await request(port, '/api/health', { token: old })).status, 200);
  for (const [method, route] of [['GET', '/api/state'], ['GET', '/api/policy'], ['PUT', '/api/policy'], ['GET', '/api/messages'], ['GET', '/api/fleet'], ['GET', '/api/fleet/settings'], ['GET', '/review-raw/a/b/c'], ['POST', '/login'], ['POST', '/api/fleet/summary'], ['HEAD', '/api/health']]) {
    assert.equal((await request(port, route, { method, token: old })).status, 403, `${method} ${route}`);
  }
  const next = credentials.rotate();
  assert.equal((await request(port, '/api/health', { token: old })).status, 200);
  now += 600000;
  assert.equal((await request(port, '/api/health', { token: old })).status, 403);
  assert.equal((await request(port, '/api/health', { token: next })).status, 200);
  assert.doesNotMatch(fs.readFileSync(path.join(privateDir, 'fleet-read.json'), 'utf8'), new RegExp(next));
});

test('title sharing and account scopes change through the dashboard API', async (t) => {
  const { appendMessage } = await import('../src/messages.js');
  appendMessage({ thread: 'boss', from: 'boss', to: 'owner', kind: 'report', action: 'decide', title: 'Choose the sample colour', text: 'PRIVATE MESSAGE', status: 'new' }, { dir: root });
  const { port } = await start(t);
  const initial = await request(port, '/api/fleet/settings');
  assert.equal(initial.status, 200);
  const { factoryId, ...settings } = initial.body;
  assert.equal(settings.shareItemTitles, true, 'the personal profile shares titles');
  const before = await request(port, '/api/fleet/summary');
  assert.equal(before.body.ownerItems.rows[0].title, 'Choose the sample colour');
  const changed = { ...settings, shareItemTitles: false, accounts: [{ harness: 'codex', accountKey: 'a'.repeat(64), scope: [factoryId] }] };
  assert.equal((await request(port, '/api/fleet/settings', { method: 'PUT', body: changed })).status, 200);
  const after = await request(port, '/api/fleet/summary');
  assert.equal(after.body.shareItemTitles, false);
  assert.equal(after.body.ownerItems.rows[0].title, undefined);
  assert.equal(after.body.quotas[0].usedPercent, null);
  assert.equal(after.body.quotas[0].accountKey, 'a'.repeat(64));
  assert.deepEqual(validateFile(after.body, schemaFile), []);
  assert.equal((await request(port, '/api/fleet/settings', { method: 'PUT', body: { ...changed, factoryId: 'replacement' } })).status, 400);
  assert.equal((await request(port, '/api/fleet/summary')).body.factoryId, factoryId);
});

test('the producer allow-list rejects an extra key at every object level', async () => {
  const { assertFleetSummary } = await import('../src/fleet-contract.js');
  const fixture = JSON.parse(fs.readFileSync(new URL('../docs/contracts/examples/fleet-summary.valid.personal.json', import.meta.url)));
  for (const target of [[], ['health'], ['machine'], ['projects', 0], ['projects', 0, 'board'], ['quotas', 0], ['spend', 0], ['alerts', 0], ['ownerItems'], ['ownerItems', 'rows', 0], ['reviewPacks', 0]]) {
    const body = structuredClone(fixture);
    target.reduce((row, key) => row[key], body).messageText = 'PRIVATE MESSAGE';
    assert.throws(() => assertFleetSummary(body), /supported contract/);
  }
});

test('the Fleet API includes factory zero and the summary link without exposing credentials', async (t) => {
  const { port } = await start(t);
  const result = await request(port, '/api/fleet');
  assert.equal(result.status, 200);
  assert.equal(result.body.pollSeconds, 30);
  assert.equal(result.body.factories.length, 1);
  assert.equal(result.body.factories[0].summary.factoryId, (await request(port, '/api/fleet/settings')).body.factoryId);
  assert.doesNotMatch(JSON.stringify(result.body), /hf_read_|invented-secret|PRIVATE MESSAGE/);
});

test('summary board counts use the published task status and completion time', async (t) => {
  const { app, port } = await start(t);
  app.engine.state.projects = [{ slug: 'sample-project', phase: 'build', computedState: 'doing', kitRevision: 'abcdef012345', updatedAt: new Date().toISOString(), repo: '/private/fixture', tasks: [
    { id: 'one', status: 'doing', title: 'PRIVATE task text' }, { id: 'two', status: 'review' }, { id: 'three', status: 'blocked' },
    { id: 'four', status: 'done', updated: new Date().toISOString() }, { id: 'old', status: 'done', updated: '2020-01-01T00:00:00Z' },
  ] }];
  const result = await request(port, '/api/fleet/summary');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.projects[0].board, { doing: 1, review: 1, blocked: 1, done7d: 1 });
  assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE task|private\/fixture/);
});

test('published project fields and public alert codes reach the summary without alert text', async (t) => {
  const { app, port } = await start(t);
  app.engine.state.projects = [{ slug: 'sample-project', phase: 'Build', publishedAt: new Date(Date.now() - 120000).toISOString(), tasks: [{ status: 'doing' }] }];
  app.engine.state.alerts = [{ key: 'machine:load', severity: 'critical', title: 'PRIVATE alert', text: '/private/fixture invented-secret' }];
  const result = await request(port, '/api/fleet/summary');
  assert.equal(result.status, 200);
  assert.equal(result.body.projects[0].phase, 'build');
  assert.equal(result.body.projects[0].status, 'doing');
  assert.ok(result.body.projects[0].statusAgeSeconds >= 120);
  assert.deepEqual(result.body.alerts, [{ code: 'machine-pressure', severity: 'error' }]);
  assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE alert|private\/fixture|invented-secret/);
});
