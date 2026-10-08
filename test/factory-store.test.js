import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readFleet, updateFleet, writeFleet } from '../src/factory-store.js';
import { assertPollerRegistry } from './helpers/factory-registry.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { HOME: path.join(root, 'home'), HERDR_BOSS_DIR: path.join(root, 'boss'), HERDR_FACTORIES_DIR: path.join(root, 'factories') };
  for (const directory of [env.HOME, env.HERDR_BOSS_DIR, env.HERDR_FACTORIES_DIR]) fs.mkdirSync(directory, { recursive: true });
  const host = { hostId: 'example-host', runtime: 'orbstack', personalOnly: true, codexSandbox: 'user-namespaces', transport: 'local' };
  const container = { factoryId: 'win1', name: 'win1', hostId: 'example-host', profile: 'personal', dashboardUrl: 'http://win1.localhost:4478',
    version: '0.1.0', kitRevision: 'abcdef012345', kind: 'container', containerName: 'hf-win1', hostname: 'win1.localhost',
    ports: { dashboard: 4478, ssh: 2222 }, image: { builtAt: '2026-10-07T10:59:22Z', pinsHash: 'a'.repeat(64) } };
  const native = { factoryId: 'factory-good', name: 'factory-good', hostId: 'example-host', profile: 'personal', dashboardUrl: 'http://good.localhost:4479',
    version: '0.1.0', kitRevision: 'abcdef012345', kind: 'native' };
  return { env, host, container, native, registry: { schema: 1, contractVersion: '1.0.0', minimumFactoryVersion: '0.1.0', hosts: [host], factories: [container, native] } };
}

test('readFleet keeps valid rows when one row fails the poller schema and leaves the file unchanged', (t) => {
  const f = fixture(t);
  const invalid = { ...f.container, version: 'invalid-value' };
  const registry = { ...f.registry, factories: [invalid, f.native] };
  const file = path.join(f.env.HERDR_FACTORIES_DIR, 'fleet.json');
  fs.writeFileSync(file, JSON.stringify(registry));
  const before = fs.readFileSync(file, 'utf8');
  assert.deepEqual(readFleet(f.env).factories.map((row) => row.name), ['factory-good']);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('readFleet normalizes a legacy image timestamp before inspecting the row', (t) => {
  const f = fixture(t);
  const legacy = { ...f.container, image: { ...f.container.image, builtAt: '2026-10-07T10:59:22.928Z' } };
  const file = path.join(f.env.HERDR_FACTORIES_DIR, 'fleet.json');
  fs.writeFileSync(file, JSON.stringify({ ...f.registry, factories: [legacy] }));
  const result = readFleet(f.env);
  assert.equal(result.factories.length, 1);
  assert.equal(result.factories[0].image.builtAt, '2026-10-07T10:59:22Z');
});

test('updateFleet keeps rejected rows intact while it writes valid changes', (t) => {
  const f = fixture(t);
  const rejected = { ...f.container, name: 'bad-row', factoryId: 'bad-row', version: 'invalid-value', image: { ...f.container.image } };
  const legacy = { ...f.container, name: 'legacy-row', factoryId: 'legacy-row', ports: { dashboard: 4480, ssh: 2223 },
    image: { ...f.container.image, builtAt: '2026-10-07T10:59:22.928Z' } };
  const file = path.join(f.env.HERDR_FACTORIES_DIR, 'fleet.json');
  fs.writeFileSync(file, JSON.stringify({ ...f.registry, factories: [f.container, rejected, legacy, f.native] }));
  updateFleet(f.env, (fleet) => { fleet.factories.find((row) => row.name === 'factory-good').version = '0.1.1'; });
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(written.factories.find((row) => row.name === 'bad-row'), rejected);
  assert.equal(written.factories.find((row) => row.name === 'legacy-row').image.builtAt, '2026-10-07T10:59:22Z');
  assert.equal(written.factories.find((row) => row.name === 'factory-good').version, '0.1.1');
});

for (const collision of [
  { field: 'name', candidate: { name: 'blocked-row' } },
  { field: 'factoryId', candidate: { factoryId: 'blocked-id' } },
  { field: 'dashboard port', candidate: { ports: { dashboard: 4490, ssh: 2224 } } },
  { field: 'ssh port', candidate: { ports: { dashboard: 4482, ssh: 2230 } } },
]) {
  test(`updateFleet refuses a changed row that collides with a rejected row by ${collision.field}`, (t) => {
    const f = fixture(t);
    const rejected = { ...f.container, name: 'blocked-row', factoryId: 'blocked-id', containerName: 'hf-blocked-row', hostname: 'blocked-row.localhost',
      dashboardUrl: 'http://blocked-row.localhost:4490', ports: { dashboard: 4490, ssh: 2230 }, version: 'invalid-value' };
    const file = path.join(f.env.HERDR_FACTORIES_DIR, 'fleet.json');
    fs.writeFileSync(file, JSON.stringify({ ...f.registry, factories: [rejected, f.native] }));
    const before = fs.readFileSync(file, 'utf8');
    const name = collision.candidate.name || 'candidate-row';
    const factoryId = collision.candidate.factoryId || 'candidate-id';
    const ports = collision.candidate.ports || { dashboard: 4482, ssh: 2224 };
    const candidate = { ...f.container, name, factoryId, containerName: `hf-${name}`, hostname: `${name}.localhost`,
      dashboardUrl: `http://${name}.localhost:${ports.dashboard}`, ports };

    let error;
    try { updateFleet(f.env, (fleet) => { fleet.factories.push(candidate); }); } catch (caught) { error = caught; }
    assert.ok(error, 'a conflicting change must be refused');
    assert.equal(error.message, 'The change conflicts with registry row blocked-row.');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });
}

test('writeFleet removes milliseconds and writes a poller-schema registry', (t) => {
  const f = fixture(t);
  f.registry.factories[0].image.builtAt = '2026-10-07T10:59:22.928Z';
  writeFleet(f.env, f.registry);
  const registry = assertPollerRegistry(f.env);
  assert.equal(registry.factories[0].image.builtAt, '2026-10-07T10:59:22Z');
});
