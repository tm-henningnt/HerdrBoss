import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createFleetRole } from '../src/fleet-role.js';
import { createFleetGuidance } from '../src/fleet-guidance.js';
import { createFleetShares } from '../src/fleet-shares.js';
import { readFleetFile, writeFleetFile } from '../src/fleet-store.js';

const root = process.env.HERDR_BOSS_DIR;
const clock = () => Date.parse('2026-10-03T12:00:00Z');
const guideToken = (letter) => `hf_guide_${letter.repeat(64)}`;
const host = { hostId: 'example-host', runtime: 'orbstack', personalOnly: true, codexSandbox: 'user-namespaces', transport: 'local' };
const factory = (id) => ({ factoryId: id, name: id, hostId: 'example-host', kind: 'native', profile: 'personal', dashboardUrl: `https://${id}.example.invalid`, version: '0.1.0', kitRevision: 'abcdef012345' });
const role = (holder, epoch) => ({ schema: 1, contractVersion: '1.0.0', headOfficeFactoryId: holder, epoch, updatedAt: '2026-10-03T12:00:00Z' });
let counter = 0;
function fixture({ self = 'factory-b', headOffice = false, peers = {}, registered = ['factory-a', 'factory-b', 'factory-c'], tokens = registered.filter((id) => id !== self) } = {}) {
  const base = path.join(root, `role-${++counter}`);
  const dir = path.join(base, 'data'), privateDir = path.join(base, 'private'), registryFile = path.join(base, 'fleet.json');
  fs.mkdirSync(path.dirname(registryFile), { recursive: true });
  fs.writeFileSync(registryFile, JSON.stringify({ schema: 1, contractVersion: '1.0.0', minimumFactoryVersion: '0.1.0', hosts: [host], factories: registered.map(factory) }));
  writeFleetFile(path.join(privateDir, 'fleet-guide-remotes.json'), Object.fromEntries(tokens.map((id) => [id, guideToken(id.at(-1))])));
  const state = { headOffice };
  const calls = [];
  // A peer handler gets the request and returns a status and a body. Throwing simulates a network failure.
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(url);
    const id = registered.find((name) => `${name}.example.invalid` === target.hostname);
    const entry = { id, method: init.method || 'GET', path: target.pathname, authorization: init.headers?.authorization, body: init.body ? JSON.parse(init.body) : null };
    calls.push(entry);
    const handler = peers[id];
    if (!handler) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const { status = 200, body = { ok: true } } = await handler(entry);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  const api = createFleetRole({ dir, privateDir, registryFile, fetchImpl, now: clock,
    settings: () => ({ factoryId: self, headOffice: state.headOffice, accounts: [] }),
    enableHeadOffice: () => { state.headOffice = true; } });
  return { api, dir, privateDir, registryFile, calls, state, roleFile: path.join(dir, 'head-office-role.json') };
}
const reachable = (holder, epoch) => ({ handler: ({ method }) => ({ body: method === 'GET' ? { ...role(holder, epoch), holds: false } : { ok: true } }) });
const peerSet = (holder = 'factory-a', epoch = 1) => ({ 'factory-a': (entry) => entry.path.endsWith('/handover') ? { body: { schema: 1, contractVersion: '1.0.0', epoch, registry: null, shares: null } } : reachable(holder, epoch).handler(entry), 'factory-c': reachable(holder, epoch).handler });

test('the role record holds the holder and the epoch in one owner-only file', () => {
  const { api, roleFile, dir } = fixture({ headOffice: true });
  assert.deepEqual({ ...api.view(), updatedAt: null }, { factoryId: 'factory-b', headOfficeFactoryId: 'factory-b', epoch: 1, updatedAt: null, holds: true });
  api.accept(role('factory-c', 2));
  assert.deepEqual(readFleetFile(roleFile), role('factory-c', 2));
  assert.equal(fs.statSync(roleFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')).length, 0);
});

test('accept follows the epoch rules: higher wins, an exact repeat is accepted, a lower or conflicting record is refused', () => {
  const { api, roleFile } = fixture({ headOffice: true });
  api.accept(role('factory-a', 3));
  const before = fs.readFileSync(roleFile, 'utf8');
  assert.equal(api.accept(role('factory-a', 3)).changed, false);
  for (const [body, status] of [[role('factory-c', 3), 409], [role('factory-c', 2), 409], [role('factory-c', 1004), 409], [{ ...role('factory-c', 4), extra: 1 }, 400], [{ ...role('factory-c', 4), epoch: 0 }, 400], [{ ...role('factory-c', 4), epoch: 1.5 }, 400]]) {
    assert.throws(() => api.accept(body), (error) => error.status === status, JSON.stringify(body));
  }
  assert.equal(fs.readFileSync(roleFile, 'utf8'), before);
  assert.equal(api.accept(role('factory-c', 4)).changed, true);
});

test('a holder that sees a higher epoch stops holding the role and stops sending guidance', async () => {
  const { api, dir, privateDir, registryFile } = fixture({ self: 'factory-a', headOffice: true });
  assert.equal(api.holds(), true);
  const receiver = createFleetGuidance({ dir, settings: () => ({ factoryId: 'factory-a', accounts: [] }) });
  const shares = createFleetShares({ dir, privateDir, registryFile, receiver, settings: () => ({ factoryId: 'factory-a', headOffice: true, accounts: [] }) });
  api.accept(role('factory-b', 2));
  assert.equal(api.holds(), false);
  assert.equal(api.view().headOfficeFactoryId, 'factory-b');
  await assert.rejects(() => shares.nudge({ factoryId: 'factory-a', nudgeId: 'one', text: 'hello' }), (error) => error.status === 409);
});

test('guidance from a newer head office also updates the role record', async () => {
  const { dir, roleFile } = fixture({ self: 'factory-c' });
  const key = 'a'.repeat(64);
  const receiver = createFleetGuidance({ dir, settings: () => ({ factoryId: 'factory-c', accounts: [{ harness: 'codex', accountKey: key, scope: ['factory-c'] }] }) });
  await receiver.accept({ schema: 1, contractVersion: '1.0.0', headOfficeFactoryId: 'factory-b', senderEpoch: 5, sentAt: '2026-10-03T12:00:00Z', shares: [{ accountKey: key, share: 10 }], nudges: [] });
  const stored = readFleetFile(roleFile);
  assert.equal(stored.epoch, 5); assert.equal(stored.headOfficeFactoryId, 'factory-b');
});

test('promote takes the role with the epoch plus one and tells every registered factory with its guide credential', async () => {
  const { api, calls, roleFile, state } = fixture({ peers: peerSet('factory-a', 1) });
  const result = await api.promote();
  assert.equal(result.status, 'promoted');
  assert.equal(result.epoch, 2);
  assert.deepEqual(result.told.sort(), ['factory-a', 'factory-c']);
  assert.deepEqual(readFleetFile(roleFile), { ...role('factory-b', 2), updatedAt: '2026-10-03T12:00:00Z' });
  assert.equal(state.headOffice, true);
  const posts = calls.filter((call) => call.method === 'POST');
  assert.deepEqual(posts.map((call) => call.id).sort(), ['factory-a', 'factory-c']);
  for (const call of posts) {
    assert.equal(call.path, '/api/fleet/role');
    assert.equal(call.authorization, `Bearer ${guideToken(call.id.at(-1))}`);
    assert.deepEqual(call.body, { ...role('factory-b', 2), updatedAt: '2026-10-03T12:00:00Z' });
  }
  assert.doesNotMatch(JSON.stringify(result), /hf_guide_/);
});

test('promote uses the highest epoch that a factory reports, plus one', async () => {
  const { api } = fixture({ peers: peerSet('factory-c', 7) });
  assert.equal((await api.promote()).epoch, 8);
});

test('promote refuses when a factory is unreachable and changes nothing; --force names the factory and continues', async () => {
  const peers = { 'factory-a': peerSet()['factory-a'] };
  const refused = fixture({ peers });
  await assert.rejects(() => refused.api.promote(), (error) => {
    assert.match(error.message, /factory-c/); assert.match(error.message, /--force/);
    assert.doesNotMatch(error.message, /hf_guide_/);
    return true;
  });
  assert.equal(fs.existsSync(refused.roleFile), false);
  assert.equal(refused.state.headOffice, false);
  assert.equal(refused.calls.some((call) => call.method === 'POST'), false, 'no factory is told before the check passes');
  const forced = fixture({ peers });
  const result = await forced.api.promote({ force: true });
  assert.equal(result.status, 'promoted');
  assert.deepEqual(result.told, ['factory-a']);
  assert.deepEqual(result.pending.map((row) => row.factoryId), ['factory-c']);
  assert.equal(readFleetFile(forced.roleFile).epoch, 2);
});

test('a missing guide credential counts as an unreachable factory and never prints a credential', async () => {
  const { api } = fixture({ peers: peerSet(), tokens: ['factory-a'] });
  await assert.rejects(() => api.promote(), (error) => /factory-c/.test(error.message) && !/hf_guide_/.test(error.message));
});

test('a factory that already holds the role says so and changes nothing', async () => {
  const { api, calls, roleFile } = fixture({ peers: peerSet('factory-b', 2) });
  writeFleetFile(roleFile, role('factory-b', 2));
  const before = fs.readFileSync(roleFile, 'utf8');
  const result = await api.promote();
  assert.equal(result.status, 'already-holder');
  assert.equal(result.epoch, 2);
  assert.equal(calls.length, 0);
  assert.equal(fs.readFileSync(roleFile, 'utf8'), before);
});

test('a pending factory receives the role at the next successful poll and then the pending note is cleared', async () => {
  let up = false;
  const peers = { 'factory-a': peerSet()['factory-a'], 'factory-c': (entry) => { if (!up) throw new Error('down'); return reachable('factory-b', 2).handler(entry); } };
  const { api, calls, dir } = fixture({ peers });
  await api.promote({ force: true });
  const note = path.join(dir, 'head-office-handover.json');
  assert.deepEqual(readFleetFile(note).pending, ['factory-c']);
  const count = calls.length;
  await api.retry({ factoryId: 'factory-a' });
  assert.equal(calls.length, count, 'a factory with no pending note is not contacted');
  await api.retry({ factoryId: 'factory-c', dashboardUrl: 'https://factory-c.example.invalid' });
  assert.deepEqual(readFleetFile(note).pending, ['factory-c'], 'a failed retry keeps the note');
  up = true;
  await api.retry({ factoryId: 'factory-c', dashboardUrl: 'https://factory-c.example.invalid' });
  assert.equal(fs.existsSync(note), false);
});

test('the registry and the factory shares move from a reachable old holder; an unreachable old holder leaves the own copy', async () => {
  const oldRegistry = { schema: 1, contractVersion: '1.0.0', minimumFactoryVersion: '0.1.0', hosts: [host, { ...host, hostId: 'second-host' }], factories: [{ ...factory('factory-a'), hostId: 'second-host' }, factory('factory-c'), factory('factory-d')] };
  const shares = { accounts: [{ accountKey: 'a'.repeat(64), shares: [{ factoryId: 'factory-a', share: 30 }, { factoryId: 'factory-b', share: 70 }] }] };
  const peers = { ...peerSet('factory-a', 1), 'factory-a': (entry) => entry.path.endsWith('/handover') ? { body: { schema: 1, contractVersion: '1.0.0', epoch: 1, registry: oldRegistry, shares } } : reachable('factory-a', 1).handler(entry) };
  const moved = fixture({ peers });
  const result = await moved.api.promote();
  assert.equal(result.handover, 'received');
  assert.deepEqual(readFleetFile(path.join(moved.dir, 'fleet-shares.json')), shares);
  const merged = readFleetFile(moved.registryFile);
  assert.deepEqual(merged.factories.map((row) => row.factoryId).sort(), ['factory-a', 'factory-b', 'factory-c', 'factory-d']);
  assert.equal(merged.factories.find((row) => row.factoryId === 'factory-a').hostId, 'example-host', 'the own record wins');
  assert.ok(merged.hosts.some((row) => row.hostId === 'second-host'));
  const kept = fixture({ peers: { 'factory-c': reachable('factory-a', 1).handler } });
  writeFleetFile(path.join(kept.dir, 'fleet-shares.json'), { accounts: [] });
  const own = fs.readFileSync(kept.registryFile, 'utf8');
  const second = await kept.api.promote({ force: true });
  assert.equal(second.handover, 'kept-own-copy');
  assert.equal(fs.readFileSync(kept.registryFile, 'utf8'), own);
  assert.deepEqual(readFleetFile(path.join(kept.dir, 'fleet-shares.json')), { accounts: [] });
});

test('an invalid handover body leaves the own registry and shares unchanged', async () => {
  const peers = { ...peerSet('factory-a', 1), 'factory-a': (entry) => entry.path.endsWith('/handover') ? { body: { schema: 1, contractVersion: '1.0.0', epoch: 1, registry: { factories: 'bad' }, shares: { accounts: 'bad' } } } : reachable('factory-a', 1).handler(entry) };
  const { api, registryFile, dir } = fixture({ peers });
  const own = fs.readFileSync(registryFile, 'utf8');
  assert.equal((await api.promote()).handover, 'kept-own-copy');
  assert.equal(fs.readFileSync(registryFile, 'utf8'), own);
  assert.equal(fs.existsSync(path.join(dir, 'fleet-shares.json')), false);
});

test('the handover body comes only from the holder and holds the registry and the shares', () => {
  const holder = fixture({ self: 'factory-a', headOffice: true });
  writeFleetFile(path.join(holder.dir, 'fleet-shares.json'), { accounts: [] });
  const body = holder.api.handover();
  assert.equal(body.epoch, 1); assert.deepEqual(body.shares, { accounts: [] }); assert.equal(body.registry.factories.length, 3);
  holder.api.accept(role('factory-b', 2));
  assert.throws(() => holder.api.handover(), (error) => error.status === 409);
});
