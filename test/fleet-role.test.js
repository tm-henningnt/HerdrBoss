import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createFleetRole } from '../src/fleet-role.js';
import { createFleetGuidance } from '../src/fleet-guidance.js';
import { createFleetShares } from '../src/fleet-shares.js';
import { readFleetFile, writeFleetFile } from '../src/fleet-store.js';
import { createFleetGuideAccess } from '../src/fleet-access.js';
import { assertPollerRegistry } from './helpers/factory-registry.js';

const root = process.env.HERDR_BOSS_DIR;
const clock = () => Date.parse('2026-10-03T12:00:00Z');
const guideToken = (letter) => `hf_guide_${letter.repeat(64)}`;
const host = { hostId: 'example-host', runtime: 'orbstack', personalOnly: true, codexSandbox: 'user-namespaces', transport: 'local' };
const factory = (id) => ({ factoryId: id, name: id, hostId: 'example-host', kind: 'native', profile: 'personal', dashboardUrl: `https://${id}.example.invalid`, version: '0.1.0', kitRevision: 'abcdef012345' });
const role = (holder, epoch) => ({ schema: 1, contractVersion: '1.0.0', headOfficeFactoryId: holder, epoch, updatedAt: '2026-10-03T12:00:00Z' });
let counter = 0;
function fixture({ self = 'factory-b', headOffice = false, peers = {}, registered = ['factory-a', 'factory-b', 'factory-c'], tokens = registered.filter((id) => id !== self), time = clock } = {}) {
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
  const api = createFleetRole({ dir, privateDir, registryFile, fetchImpl, now: time,
    settings: () => ({ factoryId: self, headOffice: state.headOffice, accounts: [] }),
    enableHeadOffice: () => { state.headOffice = true; } });
  return { api, dir, privateDir, registryFile, calls, state, roleFile: path.join(dir, 'head-office-role.json') };
}
const reachable = (holder, epoch) => ({ handler: ({ method }) => ({ body: method === 'GET' ? { ...role(holder, epoch), holds: false } : { ok: true } }) });
const peerSet = (holder = 'factory-a', epoch = 1) => ({ 'factory-a': (entry) => entry.path.endsWith('/handover') ? { body: { schema: 1, contractVersion: '1.0.0', epoch, factories: null, shares: null } } : reachable(holder, epoch).handler(entry), 'factory-c': reachable(holder, epoch).handler });

test('the role record holds the holder and the epoch in one owner-only file', () => {
  const { api, roleFile, dir } = fixture({ headOffice: true });
  assert.deepEqual({ ...api.view(), updatedAt: null }, { factoryId: 'factory-b', headOfficeFactoryId: 'factory-b', epoch: 1, updatedAt: null, holds: true, neverTold: [] });
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
  assert.deepEqual(readFleetFile(note).pending, [{ factoryId: 'factory-c', attempts: 1 }]);
  const count = calls.length;
  await api.retry({ factoryId: 'factory-a' });
  assert.equal(calls.length, count, 'a factory with no pending note is not contacted');
  await api.retry({ factoryId: 'factory-c', dashboardUrl: 'https://factory-c.example.invalid' });
  assert.deepEqual(readFleetFile(note).pending, [{ factoryId: 'factory-c', attempts: 2 }], 'a failed retry keeps the note');
  up = true;
  await api.retry({ factoryId: 'factory-c', dashboardUrl: 'https://factory-c.example.invalid' });
  assert.equal(fs.existsSync(note), false);
});

test('the factories and the factory shares move from a reachable old holder; an unreachable old holder leaves the own copy', async () => {
  const projection = (id, hostId = 'example-host') => ({ factoryId: id, name: id, hostId, profile: 'personal', dashboardUrl: `https://${id}.example.invalid`, version: '0.1.0', kitRevision: 'abcdef012345' });
  const shares = { accounts: [{ accountKey: 'a'.repeat(64), shares: [{ factoryId: 'factory-a', share: 30 }, { factoryId: 'factory-b', share: 70 }] }] };
  const give = (body) => ({ ...peerSet('factory-a', 1), 'factory-a': (entry) => entry.path.endsWith('/handover') ? { body: { schema: 1, contractVersion: '1.0.0', epoch: 1, ...body } } : reachable('factory-a', 1).handler(entry) });
  const moved = fixture({ peers: give({ factories: [projection('factory-a', 'second-host'), projection('factory-c'), projection('factory-d', 'second-host'), projection('factory-e')], shares }) });
  const own = readFleetFile(moved.registryFile);
  own.factories.push({ factoryId: 'factory-local-container', name: 'factory-local-container', hostId: 'example-host', profile: 'personal', dashboardUrl: 'http://factory-local-container.example.invalid:4490', version: '0.1.0', kitRevision: 'abcdef012345', kind: 'container', containerName: 'hf-factory-local-container', hostname: 'factory-local-container.localhost', ports: { dashboard: 4490, ssh: 4491 }, image: { builtAt: '2026-10-07T10:59:22.928Z', pinsHash: 'b'.repeat(64) } });
  writeFleetFile(moved.registryFile, own);
  const result = await moved.api.promote();
  assert.equal(result.handover, 'received');
  assert.deepEqual(result.missingHosts, ['second-host'], 'a missing host stays missing');
  assert.deepEqual(readFleetFile(path.join(moved.dir, 'fleet-shares.json')), shares);
  const merged = readFleetFile(moved.registryFile);
  assertPollerRegistry({ HERDR_FACTORIES_DIR: path.dirname(moved.registryFile) });
  assert.equal(merged.factories.find((row) => row.factoryId === 'factory-local-container').image.builtAt, '2026-10-07T10:59:22Z');
  assert.deepEqual(merged.factories.map((row) => row.factoryId).sort(), ['factory-a', 'factory-b', 'factory-c', 'factory-e', 'factory-local-container']);
  assert.equal(merged.factories.find((row) => row.factoryId === 'factory-e').kind, 'native');
  assert.equal(merged.hosts.length, 1, 'no host is copied');
  const kept = fixture({ peers: { 'factory-c': reachable('factory-a', 1).handler } });
  writeFleetFile(path.join(kept.dir, 'fleet-shares.json'), { accounts: [] });
  const keptOwn = fs.readFileSync(kept.registryFile, 'utf8');
  const second = await kept.api.promote({ force: true });
  assert.equal(second.handover, 'kept-own-copy'); assert.equal(second.handoverReason, 'unreachable');
  assert.equal(fs.readFileSync(kept.registryFile, 'utf8'), keptOwn);
  assert.deepEqual(readFleetFile(path.join(kept.dir, 'fleet-shares.json')), { accounts: [] });
});

test('a registry conflict reports registry-rejected and writes neither the registry nor the shares', async () => {
  const clash = { factoryId: 'factory-x', name: 'factory-c', hostId: 'example-host', profile: 'personal', dashboardUrl: 'https://factory-x.example.invalid', version: '0.1.0', kitRevision: 'abcdef012345' };
  const shares = { accounts: [{ accountKey: 'a'.repeat(64), shares: [{ factoryId: 'factory-b', share: 10 }] }] };
  const peers = { ...peerSet('factory-a', 1), 'factory-a': (entry) => entry.path.endsWith('/handover') ? { body: { schema: 1, contractVersion: '1.0.0', epoch: 1, factories: [clash], shares } } : reachable('factory-a', 1).handler(entry) };
  const { api, registryFile, dir } = fixture({ peers });
  const own = fs.readFileSync(registryFile, 'utf8');
  const result = await api.promote();
  assert.equal(result.handover, 'kept-own-copy'); assert.equal(result.handoverReason, 'registry-rejected');
  assert.equal(fs.readFileSync(registryFile, 'utf8'), own);
  assert.equal(fs.existsSync(path.join(dir, 'fleet-shares.json')), false);
});

test('an invalid handover body leaves the own registry and shares unchanged', async () => {
  const peers = { ...peerSet('factory-a', 1), 'factory-a': (entry) => entry.path.endsWith('/handover') ? { body: { schema: 1, contractVersion: '1.0.0', epoch: 1, factories: 'bad', shares: { accounts: 'bad' } } } : reachable('factory-a', 1).handler(entry) };
  const { api, registryFile, dir } = fixture({ peers });
  const own = fs.readFileSync(registryFile, 'utf8');
  const result = await api.promote();
  assert.equal(result.handover, 'kept-own-copy'); assert.equal(result.handoverReason, 'invalid-body');
  assert.equal(fs.readFileSync(registryFile, 'utf8'), own);
  assert.equal(fs.existsSync(path.join(dir, 'fleet-shares.json')), false);
});

test('the handover sends a minimal projection and never a connection field', () => {
  const holder = fixture({ self: 'factory-a', headOffice: true });
  const ssh = { hostId: 'ssh-host', runtime: 'docker-engine-wsl2', personalOnly: true, codexSandbox: 'unconfined', transport: 'ssh', address: 'win.example.invalid', dockerContext: 'win-context' };
  const container = { ...factory('factory-d'), hostId: 'ssh-host', kind: 'container', containerName: 'hf-factory-d', hostname: 'factory-d.localhost', ports: { dashboard: 4600, ssh: 2222 }, image: { builtAt: '2026-10-01T00:00:00Z', pinsHash: 'a'.repeat(64) } };
  const registry = readFleetFile(holder.registryFile);
  writeFleetFile(holder.registryFile, { ...registry, hosts: [...registry.hosts, ssh, { ...ssh, hostId: 'ref-host', address: undefined, dockerContext: undefined, connectionRef: 'win-ref' }], factories: [...registry.factories, container] });
  writeFleetFile(path.join(holder.dir, 'fleet-shares.json'), { accounts: [] });
  const body = holder.api.handover();
  assert.equal(body.epoch, 1); assert.deepEqual(body.shares, { accounts: [] }); assert.equal(body.factories.length, 4);
  assert.deepEqual(Object.keys(body.factories.at(-1)).sort(), ['dashboardUrl', 'factoryId', 'hostId', 'kitRevision', 'name', 'profile', 'version']);
  assert.doesNotMatch(JSON.stringify(body), /address|dockerContext|connectionRef|win-context|win-ref|ports|containerName|hostname|image|pinsHash|"hosts"/);
  holder.api.accept(role('factory-b', 2));
  assert.throws(() => holder.api.handover(), (error) => error.status === 409);
});

test('accept takes a registered holder, refuses an unregistered holder when the registry has factories, and takes any valid holder when the registry is empty', () => {
  const { api, roleFile } = fixture({ headOffice: true });
  assert.throws(() => api.accept(role('factory-z', 5)), (error) => error.status === 409 && /registered/.test(error.message));
  assert.equal(fs.existsSync(roleFile), false);
  assert.equal(api.accept(role('factory-a', 5)).changed, true, 'a registered holder');
  assert.equal(api.accept(role('factory-b', 6)).changed, true, 'this factory is always a valid holder');
  assert.throws(() => api.accept(role('Bad Id', 7)), (error) => error.status === 400);
  const empty = fixture({ registered: [], tokens: [] });
  assert.equal(empty.api.accept(role('factory-z', 2)).changed, true);
  assert.equal(readFleetFile(empty.roleFile).headOfficeFactoryId, 'factory-z');
  assert.throws(() => empty.api.accept(role('factory-y', 2000)), (error) => error.status === 409, 'the jump limit stays');
});

test('a 409 answer is a hard error: another holder exists, the role goes back, the output does not say Not told', async () => {
  const peers = { 'factory-a': peerSet()['factory-a'], 'factory-c': ({ method }) => method === 'POST' ? { status: 409, body: { error: 'stale' } } : { body: { ...role('factory-a', 1), holds: false } } };
  const { api, calls, roleFile, state } = fixture({ peers });
  await assert.rejects(() => api.promote(), (error) => /another head office holder exists at epoch 2/.test(error.message) && /factory-c/.test(error.message) && !/Not told/.test(error.message));
  assert.equal(fs.existsSync(roleFile), false);
  assert.equal(state.headOffice, false);
  const afterPost = calls.slice(calls.findIndex((call) => call.method === 'POST' && call.id === 'factory-c') + 1);
  assert.ok(afterPost.some((call) => call.method === 'GET' && call.path === '/api/fleet/role'), 'the command probes again before it ends');
});

test('two promotes on one factory never run together', async () => {
  const { api, roleFile } = fixture({ peers: peerSet() });
  const results = await Promise.allSettled([api.promote(), api.promote()]);
  assert.deepEqual(results.map((row) => row.status).sort(), ['fulfilled', 'rejected']);
  assert.match(results.find((row) => row.status === 'rejected').reason.message, /Another promotion is running/);
  assert.equal(readFleetFile(roleFile).epoch, 2);
  assert.equal((await api.promote()).status, 'already-holder', 'the lock is released');
});

test('promote refuses an inflated epoch: above the local epoch, above the median, 1e300, and 2^53-1', async () => {
  for (const reported of [5000, 1e300, 2 ** 53 - 1]) {
    const { api, calls, roleFile } = fixture({ peers: peerSet('factory-a', reported) });
    await assert.rejects(() => api.promote({ force: true }), (error) => /more than 1000 above/.test(error.message) && !/hf_guide_/.test(error.message), String(reported));
    assert.equal(fs.existsSync(roleFile), false); assert.equal(calls.some((call) => call.method === 'POST'), false);
  }
  const median = fixture({ registered: ['factory-a', 'factory-b', 'factory-c', 'factory-d'], peers: { 'factory-a': reachable('factory-a', 1).handler, 'factory-c': reachable('factory-a', 1).handler, 'factory-d': reachable('factory-a', 2500).handler } });
  writeFleetFile(median.roleFile, role('factory-a', 3000));
  await assert.rejects(() => median.api.promote(), /factory-d reports an epoch more than 1000/);
  assert.equal(readFleetFile(median.roleFile).epoch, 3000);
});

test('promote refuses when the next epoch would pass the largest allowed epoch', async () => {
  const max = 2 ** 53 - 1;
  const { api, roleFile } = fixture({ peers: peerSet('factory-a', max) });
  writeFleetFile(roleFile, role('factory-a', max));
  await assert.rejects(() => api.promote(), /largest allowed epoch 9007199254740991/);
  assert.equal(readFleetFile(roleFile).epoch, max);
});

test('a factory that has head office polling on and no record already holds the role', async () => {
  const { api, calls } = fixture({ headOffice: true, peers: peerSet() });
  assert.equal((await api.promote()).status, 'already-holder');
  assert.equal(calls.length, 0);
});

test('the pending note is owner-only, retries stop after 20 attempts or 24 hours, and the view lists the factory as never told', async () => {
  let now = clock();
  const down = () => { throw new Error('down'); };
  const peers = { 'factory-a': peerSet()['factory-a'], 'factory-c': down };
  const first = fixture({ peers, time: () => now });
  await first.api.promote({ force: true });
  const note = path.join(first.dir, 'head-office-handover.json');
  assert.equal(fs.statSync(note).mode & 0o777, 0o600);
  const record = { factoryId: 'factory-c', dashboardUrl: 'https://factory-c.example.invalid' };
  for (let attempt = 2; attempt < 20; attempt += 1) await first.api.retry(record);
  assert.deepEqual(first.api.view().neverTold, []);
  await first.api.retry(record);
  assert.deepEqual(first.api.view().neverTold, ['factory-c']);
  assert.deepEqual(readFleetFile(note).pending, []);
  const calls = first.calls.length;
  await first.api.retry(record);
  assert.equal(first.calls.length, calls, 'an abandoned factory is not contacted again');
  const timed = fixture({ peers, time: () => now });
  await timed.api.promote({ force: true });
  now += 24 * 60 * 60 * 1000;
  assert.deepEqual(timed.api.view().neverTold, ['factory-c']);
  await timed.api.retry(record);
  assert.deepEqual(readFleetFile(path.join(timed.dir, 'head-office-handover.json')).neverTold, ['factory-c']);
});

test('guide credential rotation keeps the role of the holder and resets a factory that does not hold it', () => {
  const rotate = (dir, privateDir) => createFleetGuideAccess({ privateDir, dir, now: clock }).rotate();
  const holder = fixture({ self: 'factory-a' });
  writeFleetFile(path.join(holder.dir, 'factory-identity.json'), { factoryId: 'factory-a' });
  writeFleetFile(holder.roleFile, role('factory-a', 3));
  writeFleetFile(path.join(holder.dir, 'fleet-guidance.json'), { senderEpoch: 3, headOfficeFactoryId: 'factory-a', shares: [], nudges: [] });
  rotate(holder.dir, holder.privateDir);
  assert.equal(readFleetFile(holder.roleFile).epoch, 3);
  assert.equal(readFleetFile(path.join(holder.dir, 'fleet-guidance.json')).senderEpoch, 3);
  const other = fixture({ self: 'factory-c' });
  writeFleetFile(path.join(other.dir, 'factory-identity.json'), { factoryId: 'factory-c' });
  writeFleetFile(other.roleFile, role('factory-a', 3));
  writeFleetFile(path.join(other.dir, 'fleet-guidance.json'), { senderEpoch: 3, headOfficeFactoryId: 'factory-a', shares: [], nudges: [] });
  rotate(other.dir, other.privateDir);
  assert.equal(fs.existsSync(other.roleFile), false);
  assert.equal(readFleetFile(path.join(other.dir, 'fleet-guidance.json')).senderEpoch, 0);
});
