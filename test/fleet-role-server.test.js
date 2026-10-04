import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { serve } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { writeFleetFile, readFleetFile } from '../src/fleet-store.js';
import { createFleetGuideAccess, createFleetReadAccess } from '../src/fleet-access.js';

const root = process.env.HERDR_BOSS_DIR;
const clock = () => Date.parse('2026-10-03T12:00:00Z');
const role = (holder, epoch) => ({ schema: 1, contractVersion: '1.0.0', headOfficeFactoryId: holder, epoch, updatedAt: '2026-10-03T12:00:00Z' });
function request(port, route, { method = 'GET', token, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method, agent: false, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' } }, (res) => {
      let text = ''; res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: (() => { try { return JSON.parse(text); } catch { return text; } })() }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}
async function start(t, { holder = 'factory-a', headOffice = true } = {}) {
  for (const name of ['fleet-guidance.json', 'fleet-shares.json', 'head-office-role.json']) fs.rmSync(path.join(root, name), { force: true });
  writeFleetFile(path.join(root, 'factory-identity.json'), { factoryId: holder });
  writeFleetFile(path.join(root, 'fleet-accounts.json'), []);
  writeFleetFile(path.join(root, 'fleet-settings.json'), { name: holder, dashboardUrl: 'http://localhost:4477', headOffice, shareItemTitles: true });
  const cfg = { ...loadConfig(), host: '127.0.0.1', port: 0, tickSeconds: 3600, allowedHosts: ['*.localhost'] };
  const engine = new EventEmitter();
  engine.state = { updatedAt: new Date(clock()).toISOString(), herdr: { panes: [] }, kit: { current: 'abcdef012345' }, quotas: [], projects: [], machine: {} };
  engine.tick = async () => engine.state; engine.log = () => {};
  const privateDir = path.join(root, 'private-role');
  const app = serve(cfg, { liveDataDir: root, createEngine: () => engine,
    health: async () => ({ schema: 1, contractVersion: '1.0.0', version: '0.1.0', kitRevision: 'abcdef012345', tickAgeSeconds: 0, herdrReachable: true, clockOffsetSeconds: null }),
    fleet: { privateDir, now: clock, registryFile: path.join(root, 'empty-registry.json') } });
  t.after(async () => { await app.close(); });
  if (!app.server.listening) await once(app.server, 'listening');
  return { port: app.server.address().port, guide: createFleetGuideAccess({ privateDir, dir: root, now: clock }).rotate(), read: createFleetReadAccess({ privateDir, now: clock }).rotate() };
}

test('the role routes accept only the guide credential and move the role on a higher epoch', async (t) => {
  const { port, guide, read } = await start(t);
  assert.equal((await request(port, '/api/fleet/role', { method: 'POST', body: role('factory-b', 2) })).status, 401);
  assert.equal((await request(port, '/api/fleet/role', { method: 'POST', token: read, body: role('factory-b', 2) })).status, 403);
  assert.equal((await request(port, '/api/fleet/handover', { token: read })).status, 403);
  assert.equal((await request(port, '/api/fleet/handover')).status, 401);
  const before = await request(port, '/api/fleet/role', { token: guide });
  assert.deepEqual(before.body, { factoryId: 'factory-a', headOfficeFactoryId: 'factory-a', epoch: 1, updatedAt: null, holds: true });
  assert.equal((await request(port, '/api/fleet/handover', { token: guide })).status, 200);
  assert.equal((await request(port, '/api/fleet/role', { method: 'POST', token: guide, body: role('factory-b', 2) })).status, 200);
  assert.equal((await request(port, '/api/fleet/role', { method: 'POST', token: guide, body: role('factory-c', 2) })).status, 409);
  assert.equal((await request(port, '/api/fleet/role', { method: 'POST', token: guide, body: role('factory-c', 1) })).status, 409);
  assert.equal((await request(port, '/api/fleet/role', { method: 'POST', token: guide, body: { ...role('factory-c', 3), extra: 1 } })).status, 400);
  const after = await request(port, '/api/fleet/role', { token: guide });
  assert.equal(after.body.headOfficeFactoryId, 'factory-b'); assert.equal(after.body.holds, false); assert.equal(after.body.epoch, 2);
  assert.equal((await request(port, '/api/fleet/handover', { token: guide })).status, 409, 'the former holder gives no handover');
  assert.equal(fs.statSync(path.join(root, 'head-office-role.json')).mode & 0o777, 0o600);
  assert.equal((await request(port, '/api/fleet/role', { method: 'PUT', token: guide, body: role('factory-b', 5) })).status, 403);
});

test('the fleet view reports the role and the former holder stops polling', async (t) => {
  const { port, guide } = await start(t);
  assert.equal((await request(port, '/api/fleet')).body.role.holds, true);
  await request(port, '/api/fleet/role', { method: 'POST', token: guide, body: role('factory-b', 2) });
  const view = (await request(port, '/api/fleet')).body;
  assert.equal(view.role.headOfficeFactoryId, 'factory-b'); assert.equal(view.role.holds, false);
  assert.ok(view.factories.every((row) => !row.remote || row.error === 'head-office-disabled'));
});

function peerServer(t, handler) {
  const server = http.createServer((req, res) => {
    const reply = handler(req);
    res.writeHead(reply.status || 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply.body));
  });
  t.after(() => server.close());
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
async function runHub(base, args) {
  const child = spawn(process.execPath, ['src/cli.js', 'hub', ...args], { env: { ...process.env, HOME: path.join(base, 'home'), HERDR_BOSS_DIR: path.join(base, 'data'), HERDR_FACTORIES_DIR: path.join(base, 'factories') } });
  let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
  const [status] = await once(child, 'close');
  return { status, output };
}
function hubFixture(ports, tokens) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cli-'));
  const data = path.join(base, 'data'), privateDir = path.join(base, 'home', '.config', 'herdr-boss');
  writeFleetFile(path.join(data, 'factory-identity.json'), { factoryId: 'factory-b' });
  writeFleetFile(path.join(data, 'fleet-settings.json'), { name: 'factory-b', dashboardUrl: 'http://localhost:4477', headOffice: false, shareItemTitles: true });
  writeFleetFile(path.join(privateDir, 'fleet-guide-remotes.json'), tokens);
  const host = { hostId: 'example-host', runtime: 'orbstack', personalOnly: true, codexSandbox: 'user-namespaces', transport: 'local' };
  const factory = (id, port) => ({ factoryId: id, name: id, hostId: 'example-host', kind: 'native', profile: 'personal', dashboardUrl: `http://127.0.0.1:${port}`, version: '0.1.0', kitRevision: 'abcdef012345' });
  writeFleetFile(path.join(base, 'factories', 'fleet.json'), { schema: 1, contractVersion: '1.0.0', minimumFactoryVersion: '0.1.0', hosts: [host], factories: Object.entries(ports).map(([id, port]) => factory(id, port)) });
  return { base, data };
}

test('hub promote through the CLI moves the role, prints no credential, and refuses an unreachable factory unless --force', async (t) => {
  const tokenA = `hf_guide_${'a'.repeat(64)}`, tokenC = `hf_guide_${'c'.repeat(64)}`;
  const seen = [];
  const live = (holder) => peerServer(t, (req) => { seen.push(`${req.method} ${req.url} ${req.headers.authorization === `Bearer ${holder}`}`); return { body: req.url === '/api/fleet/handover' ? { schema: 1, epoch: 1, registry: null, shares: null } : { ...role('factory-a', 1), ok: true, holds: false } }; });
  const portA = await live(tokenA);
  const dead = http.createServer(); await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve)); const portC = dead.address().port; await new Promise((resolve) => dead.close(resolve));
  const refused = hubFixture({ 'factory-a': portA, 'factory-c': portC }, { 'factory-a': tokenA, 'factory-c': tokenC });
  const first = await runHub(refused.base, ['promote']);
  assert.equal(first.status, 1);
  assert.match(first.output, /factory-c/); assert.match(first.output, /--force/);
  assert.equal(fs.existsSync(path.join(refused.data, 'head-office-role.json')), false);
  const forced = await runHub(refused.base, ['promote', '--force']);
  assert.equal(forced.status, 0, forced.output);
  assert.match(forced.output, /epoch 2/); assert.match(forced.output, /Told: factory-a/); assert.match(forced.output, /Not told: factory-c/);
  assert.equal(readFleetFile(path.join(refused.data, 'head-office-role.json')).epoch, 2);
  assert.equal(readFleetFile(path.join(refused.data, 'fleet-settings.json')).headOffice, true);
  for (const result of [first, forced]) assert.doesNotMatch(result.output, /hf_guide_/);
  assert.ok(seen.some((line) => line === 'POST /api/fleet/role true'));
  const again = await runHub(refused.base, ['promote']);
  assert.equal(again.status, 0); assert.match(again.output, /already holds the head office role at epoch 2/);
  assert.equal((await runHub(refused.base, ['demote'])).status, 1);
});
