import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-allocation-state-'));
process.env.HOME = path.join(root, 'home');
process.env.HERDR_BOSS_DIR = path.join(root, 'data');
process.env.HERDR_BOSS_PORT = '0';
fs.mkdirSync(process.env.HOME);
fs.mkdirSync(process.env.HERDR_BOSS_DIR);
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

const [{ serve }, { loadConfig }, { POLICY_DEFAULTS }, { createProjectTransferLock, releaseProjectTransferLock }] = await Promise.all([
  import('../src/server.js'), import('../src/config.js'), import('../src/control.js'), import('../src/project-transfer-locks.js'),
]);

test('the dashboard exposes transfer direction and factory for closed policy projects without private lock fields', async (t) => {
  const dataDir = process.env.HERDR_BOSS_DIR;
  const policy = structuredClone(POLICY_DEFAULTS);
  policy.projects = Object.fromEntries(['source', 'target', 'invalid', 'open'].map((slug) => [slug, {
    share: 25, mode: 'auto', excludedKinds: [], excludedModels: [],
  }]));
  fs.writeFileSync(path.join(dataDir, 'policy.json'), JSON.stringify(policy));
  const sourceId = randomUUID();
  createProjectTransferLock('source', { dataDir, transferId: sourceId, side: 'source', peerFactoryId: 'factory-b' });
  createProjectTransferLock('target', { dataDir, transferId: randomUUID(), side: 'target', peerFactoryId: 'factory-a' });
  fs.writeFileSync(path.join(dataDir, 'project-transfer-locks', 'invalid.json'), JSON.stringify({ broken: true }));

  const engine = new EventEmitter();
  engine.state = { control: { projects: { open: { slug: 'open' } } }, herdr: { panes: [], workspaces: [] } };
  engine.log = () => {};
  engine.tick = async () => engine.state;
  const cfg = loadConfig();
  Object.assign(cfg, { host: '127.0.0.1', port: 0, tickSeconds: 3600 });
  const { server, close } = serve(cfg, { readOnlyPreview: true, createEngine: () => engine });
  t.after(async () => { await close(); fs.rmSync(root, { recursive: true, force: true }); });
  if (!server.listening) await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const read = async () => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/state`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const state = await read();
  assert.deepEqual(state.projectTransfers, [
    { slug: 'source', side: 'source', factory: 'factory-b' },
    { slug: 'target', side: 'target', factory: 'factory-a' },
    { slug: 'invalid', side: null, factory: null },
  ]);
  assert.ok(state.projectTransfers.every((item) => Object.keys(item).length === 3));
  releaseProjectTransferLock('source', sourceId, { dataDir });
  assert.equal((await read()).projectTransfers.some((item) => item.slug === 'source'), false);
});
