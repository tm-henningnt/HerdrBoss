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
  assert.deepEqual(result.body.machine, { load1: 1, load5: 2, load15: 3, cpus: 4, memoryTotalMb: 8192, memoryFreePercent: 55,
    swapUsedMb: 3, diskFreePercent: null, diskFreeMb: null, utcOffsetMinutes: null });
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
  for (const target of [[], ['health'], ['machine'], ['workers'], ['harnesses', 0], ['boss'], ['pending', 0], ['backup'], ['projects', 0], ['projects', 0, 'board'], ['quotas', 0], ['spend', 0], ['alerts', 0], ['ownerItems'], ['ownerItems', 'rows', 0], ['reviewPacks', 0]]) {
    const body = structuredClone(fixture);
    body.workers = { running: null, max: null };
    body.harnesses = [{ harness: 'claude', login: 'unknown', checkedAt: null }];
    body.boss = { running: null, harness: null };
    body.pending = [{ step: 'login-claude', since: null }];
    body.backup = { lastAt: null };
    target.reduce((row, key) => row[key], body).messageText = 'PRIVATE MESSAGE';
    assert.throws(() => assertFleetSummary(body), /supported contract/);
  }
});

test('the fleet summary emits sourced optional fields and keeps unknown readings null', async () => {
  const { buildFleetSummary } = await import('../src/fleet-summary.js');
  const settings = { factoryId: 'factory-zero', name: 'factory-zero', dashboardUrl: 'http://localhost:4477', shareItemTitles: true, accounts: [] };
  const health = { schema: 1, contractVersion: '1.0.0', version: '0.1.0', kitRevision: 'abcdef012345', tickAgeSeconds: 1,
    herdrReachable: true, clockOffsetSeconds: -42 };
  const now = Date.parse('2026-10-02T10:00:00Z');
  const mailbox = [
    { id: 'owner-decision', from: 'boss', to: 'owner', thread: 'sample-project', kind: 'reply', action: 'decide', at: '2026-10-02T09:50:00Z', text: 'Choose the sample colour' },
    { id: 'factory-question', from: 'boss', to: 'owner', thread: 'boss', kind: 'reply', action: 'answer', at: '2026-10-02T09:45:00Z', text: 'Choose the factory setting' },
    { id: 'login-wait', from: 'boss', to: 'owner', thread: 'boss', kind: 'reply', action: 'answer', at: '2026-10-02T09:00:00Z', closedAt: '2026-10-02T09:30:00Z',
      text: 'The claude login is not ready. Run `herdr-boss factory login factory-zero claude` at an Owner terminal, then run `herdr-boss factory boss start factory-zero --resume`.' },
    { id: 'codex-wait', from: 'boss', to: 'owner', thread: 'boss', kind: 'reply', action: 'answer', at: '2026-10-02T09:10:00Z', closedAt: '2026-10-02T09:31:00Z',
      text: 'The codex login is not ready. Run `herdr-boss factory login factory-zero codex` at an Owner terminal, then run `herdr-boss factory boss start factory-zero --resume`.' },
    { id: 'closed-item', from: 'boss', to: 'owner', thread: 'sample-project', kind: 'report', action: 'decide', closedAt: '2026-10-02T09:55:00Z', at: '2026-10-02T08:00:00Z' },
    { id: 'info-item', from: 'boss', to: 'owner', thread: 'boss', kind: 'reply', action: 'read', at: '2026-10-02T09:30:00Z' },
    { id: 'review-pack', from: 'boss', to: 'owner', thread: 'sample-project', kind: 'review', action: 'approve', at: '2026-10-02T09:40:00Z' },
  ];
  const state = { control: { runningWorkers: 5, maxWorkers: 12 },
    machine: { diskFreePercent: 34, diskFreeBytes: 51200 * 2 ** 20 },
    herdr: { panes: [{ label: 'boss', agent: 'claude' }] },
    projects: [{ slug: 'sample-project', tasks: [] }], quotas: [] };
  const summary = buildFleetSummary({ settings, state, health, now, kind: 'container', machineSample: { utcOffsetMinutes: 120 },
    logins: [{ harness: 'claude', login: 'expired', checkedAt: '2026-10-02T09:59:30Z' }, { harness: 'codex', login: 'logged-in', checkedAt: '2026-10-02T09:59:31Z' }],
    ownerItems: mailbox });
  assert.deepEqual(summary.workers, { running: 5, max: 12 });
  assert.equal(summary.machine.diskFreePercent, 34);
  assert.equal(summary.machine.diskFreeMb, 51200);
  assert.equal(summary.machine.utcOffsetMinutes, 120);
  assert.equal(summary.health.clockOffsetSeconds, -42);
  assert.equal(summary.kind, 'container');
  assert.deepEqual(summary.harnesses, [
    { harness: 'claude', login: 'expired', checkedAt: '2026-10-02T09:59:30Z' },
    { harness: 'codex', login: 'ok', checkedAt: '2026-10-02T09:59:31Z' },
  ]);
  assert.deepEqual(summary.boss, { running: true, harness: 'claude' });
  assert.deepEqual(summary.pending, [{ step: 'login-claude', since: '2026-10-02T09:00:00Z' }]);
  assert.deepEqual(summary.backup, { lastAt: null });
  assert.ok(summary.alerts.some((alert) => alert.code === 'login-expired' && alert.severity === 'warning'));
  assert.equal(summary.ownerItems.total, 2);
  assert.equal(summary.ownerItems.needsOwner, 2);
  assert.equal(summary.ownerItems.rows.find((row) => row.id === 'owner-decision').projectSlug, 'sample-project');
  assert.equal(summary.ownerItems.rows.find((row) => row.id === 'factory-question').projectSlug, undefined);
  assert.equal(summary.ownerItems.rows.some((row) => row.id === 'review-pack' || row.id === 'closed-item' || row.id === 'info-item'), false);
  assert.deepEqual(validateFile(summary, schemaFile), []);

  const unknown = buildFleetSummary({ settings, state: {}, health: { ...health, clockOffsetSeconds: null }, now });
  assert.deepEqual(unknown.workers, { running: null, max: null });
  assert.equal(unknown.machine.diskFreePercent, null);
  assert.equal(unknown.machine.diskFreeMb, null);
  assert.equal(unknown.machine.utcOffsetMinutes, null);
  assert.equal(unknown.health.clockOffsetSeconds, null);
  assert.equal(unknown.kind, null);
  assert.deepEqual(unknown.boss, { running: null, harness: null });
  assert.deepEqual(unknown.pending, []);
  assert.deepEqual(unknown.backup, { lastAt: null });
  assert.deepEqual(validateFile(unknown, schemaFile), []);

  const withoutWaitMail = buildFleetSummary({ settings, state: {}, health, now,
    logins: [{ harness: 'codex', login: 'none', checkedAt: '2026-10-02T09:59:31Z' }] });
  assert.deepEqual(withoutWaitMail.pending, [{ step: 'login-codex', since: null }]);

  const activeLoginWait = { ...mailbox.find((item) => item.id === 'login-wait') };
  delete activeLoginWait.closedAt;
  const unknownWithWait = buildFleetSummary({ settings, state: {}, health, now,
    logins: [{ harness: 'claude', login: 'unknown', checkedAt: '2026-10-02T09:59:31Z' }], ownerItems: [activeLoginWait] });
  assert.deepEqual(unknownWithWait.pending, [{ step: 'login-claude', since: '2026-10-02T09:00:00Z' }]);

  const unknownWithoutWait = buildFleetSummary({ settings, state: {}, health, now,
    logins: [{ harness: 'codex', login: 'unknown', checkedAt: '2026-10-02T09:59:31Z' }] });
  assert.deepEqual(unknownWithoutWait.pending, []);

  const closedLoginWait = mailbox.find((item) => item.id === 'login-wait');
  const unknownWithClosedWait = buildFleetSummary({ settings, state: {}, health, now,
    logins: [{ harness: 'claude', login: 'unknown', checkedAt: '2026-10-02T09:59:31Z' }], ownerItems: [closedLoginWait] });
  assert.deepEqual(unknownWithClosedWait.pending, [{ step: 'login-claude', since: '2026-10-02T09:00:00Z' }]);

  const passedWithClosedWait = buildFleetSummary({ settings, state: {}, health, now,
    logins: [{ harness: 'claude', login: 'logged-in', checkedAt: '2026-10-02T10:00:00Z' }], ownerItems: [closedLoginWait] });
  assert.deepEqual(passedWithClosedWait.pending, []);

  const repeatedExpiry = buildFleetSummary({ settings, state: {}, health, now,
    logins: [{ harness: 'claude', login: 'expired', checkedAt: '2026-10-02T09:59:31Z' }], ownerItems: [
      { ...mailbox.find((item) => item.id === 'login-wait'), at: '2026-09-28T09:00:00Z' },
      { ...activeLoginWait, id: 'login-wait-current', at: '2026-10-02T09:58:00Z' },
    ] });
  assert.deepEqual(repeatedExpiry.pending, [{ step: 'login-claude', since: '2026-10-02T09:58:00Z' }]);

  const lowDisk = buildFleetSummary({ settings, state: { machine: { diskFreePercent: 4 } }, health, now });
  assert.ok(lowDisk.alerts.some((alert) => alert.code === 'machine-disk' && alert.severity === 'error'));
});

test('machine readings expose current disk data and derive the calendar offset from an existing sample', async (t) => {
  const { appendMachineSample, fleetMachineReadings, latestMachineSample, sampleLine } = await import('../src/machine-samples.js');
  const now = Date.parse('2026-10-02T10:00:00Z');
  const dataDir = fs.mkdtempSync(path.join(root, 'fleet-machine-sample-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  appendMachineSample(sampleLine({ machine: {}, now }), { dataDir });
  const sample = latestMachineSample({ dataDir });
  assert.deepEqual(fleetMachineReadings({ diskFreePercent: 34, diskFreeBytes: 51200 * 2 ** 20 }, sample), {
    diskFreePercent: 34, diskFreeMb: 51200, utcOffsetMinutes: -new Date(now).getTimezoneOffset(),
  });
  assert.deepEqual(fleetMachineReadings({}, null), { diskFreePercent: null, diskFreeMb: null, utcOffsetMinutes: null });
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
  assert.deepEqual(result.body.alerts, [{ code: 'machine-pressure', severity: 'error' }, { code: 'login-expired', severity: 'warning' }]);
  assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE alert|private\/fixture|invented-secret/);
});

test('rows that the contract refuses are dropped and the summary still builds', async () => {
  const { buildFleetSummary } = await import('../src/fleet-summary.js');
  const settings = { factoryId: 'factory-zero', name: 'factory-zero', dashboardUrl: 'http://localhost:4477', headOffice: false, shareItemTitles: true, accounts: [] };
  const health = { schema: 1, contractVersion: '1.0.0', version: '0.1.0', kitRevision: 'abcdef012345', tickAgeSeconds: 1, herdrReachable: true, clockOffsetSeconds: null };
  const slugs = ['2fa-app', 'ends-', 'a--b', 'good-app'];
  const body = buildFleetSummary({ settings, health, now: Date.parse('2026-10-03T03:00:00Z'),
    state: { kit: { current: 'abcdef012345' }, machine: {}, quotas: [], alerts: [{ key: 'x', severity: 'info', projectSlug: '2fa-app' }],
      projects: [...slugs.map((slug) => ({ slug, tasks: [] })), { slug: 'phase-app', phase: '2 build', tasks: [] }, { slug: 'age-app', statusAgeSeconds: 1.5, tasks: [] }] },
    ownerItems: slugs.map((id) => ({ id, from: 'boss', to: 'owner', thread: id, kind: 'reply', action: 'decide' })),
    reviewPacks: [...slugs, `${'a'.repeat(63)}-`].map((id) => ({ id, waitingItems: 1 })) });
  assert.deepEqual(validateFile(body, schemaFile), []);
  assert.deepEqual(body.projects.map((project) => project.slug), ['good-app', 'phase-app', 'age-app']);
  assert.equal(body.projects[1].phase, 'unknown');
  assert.equal(body.projects[2].statusAgeSeconds, 1);
  assert.deepEqual(body.ownerItems.rows.map((row) => row.id), ['good-app']);
  assert.deepEqual(body.reviewPacks.map((pack) => pack.id), ['good-app']);
});

async function withFleetFile(name, text, body) {
  const file = path.join(root, name);
  const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
  fs.writeFileSync(file, text);
  try { await body(); } finally { if (before === null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, before); }
}

test('a corrupt factory identity does not stop the dashboard', async (t) => {
  await withFleetFile('factory-identity.json', '{"factoryId":"Bad"}', async () => {
    const { port } = await start(t);
    const settings = await request(port, '/api/fleet/settings');
    assert.equal(settings.status, 200);
    assert.equal(typeof settings.body.error, 'string');
    assert.equal(settings.body.factoryId, null);
    assert.equal(settings.body.headOffice, false);
    assert.equal((await request(port, '/api/fleet')).body.registryError, 'fleet-settings-invalid');
  });
});

test('an invalid fleet setting gives the defaults and an error field', async (t) => {
  for (const [name, text] of [['fleet-settings.json', '{"name":"factory-zero","dashboardUrl":"http://Factory.local","headOffice":false,"shareItemTitles":true}'], ['fleet-settings.json', '{broken']]) {
    await withFleetFile(name, text, async () => {
      const { port } = await start(t);
      const settings = await request(port, '/api/fleet/settings');
      assert.equal(settings.status, 200, JSON.stringify(settings.body));
      assert.equal(typeof settings.body.error, 'string');
      assert.equal(typeof settings.body.name, 'string');
      assert.equal(typeof settings.body.dashboardUrl, 'string');
      assert.deepEqual(settings.body.accounts, []);
    });
  }
});

test('the Fleet route starts no more than one poll in 30 seconds when no factory row exists', async (t) => {
  let now = Date.parse('2026-10-03T03:00:00Z'), calls = 0;
  await withFleetFile('fleet-settings.json', '{"name":"factory-zero","dashboardUrl":"http://Factory.local","headOffice":false,"shareItemTitles":true}', async () => {
    const cfg = { ...loadConfig(), host: '127.0.0.1', port: 0, tickSeconds: 3600, allowedHosts: ['*.localhost'] };
    const engine = new EventEmitter();
    engine.state = { updatedAt: new Date(now).toISOString(), herdr: { panes: [] }, errors: [], kit: { current: 'abcdef012345' }, machine: {}, projects: [], quotas: [] };
    engine.tick = async () => engine.state; engine.log = () => {};
    const app = serve(cfg, { liveDataDir: root, createEngine: () => engine, fleet: { now: () => now }, health: async () => { calls += 1; return { schema: 1, contractVersion: '1.0.0', version: '0.1.0', kitRevision: 'abcdef012345', tickAgeSeconds: 1, herdrReachable: true, clockOffsetSeconds: null }; } });
    t.after(() => app.close());
    if (!app.server.listening) await once(app.server, 'listening');
    const port = app.server.address().port;
    await request(port, '/api/fleet');
    const first = calls;
    await request(port, '/api/fleet'); await request(port, '/api/fleet');
    assert.equal(calls, first);
    now += 31000;
    await request(port, '/api/fleet');
    assert.equal(calls, first + 1);
  });
});

test('the summary builder carries the Claude usage helper state and omits it when none is given', async () => {
  const { buildFleetSummary } = await import('../src/fleet-summary.js');
  const base = { settings: { factoryId: 'win1', name: 'win1', dashboardUrl: 'https://win1.example', shareItemTitles: false, accounts: [] },
    state: {}, health: { version: '0.1.0', kitRevision: 'abcdef012345', tickAgeSeconds: 1, herdrReachable: true }, now: Date.parse('2026-10-06T12:00:00Z') };
  assert.equal('claudeUsageHelper' in buildFleetSummary(base), false);
  assert.deepEqual(buildFleetSummary({ ...base, claudeHelper: { state: 'installed', lastReadingSeconds: 7, extra: 'x' } }).claudeUsageHelper, { state: 'installed', lastReadingSeconds: 7 });
  assert.deepEqual(buildFleetSummary({ ...base, claudeHelper: { state: 'not-installed', reason: 'setting-off' } }).claudeUsageHelper, { state: 'not-installed', reason: 'setting-off' });
  assert.equal('claudeUsageHelper' in buildFleetSummary({ ...base, claudeHelper: { state: 'bogus' } }), false);
});
