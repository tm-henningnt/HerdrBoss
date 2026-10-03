import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';

process.env.HERDR_BOSS_LIVE_DIR = path.join(process.env.HERDR_BOSS_DIR, 'separate-live-fixture');
const [{ serve }, { loadConfig }, { createFleetGuideAccess }] = await Promise.all([
  import('../src/server.js'), import('../src/config.js'), import('../src/fleet-access.js'),
]);
test('a read-only preview refuses guidance, share writes, and nudges and sends no remote request', async (t) => {
  const cfg = { ...loadConfig(), host: '127.0.0.1', port: 0, tickSeconds: 3600 };
  const engine = new EventEmitter(); engine.state = { herdr: { panes: [] } }; engine.log = () => {}; engine.tick = async () => engine.state;
  const privateDir = path.join(process.env.HERDR_BOSS_DIR, 'private');
  const guide = createFleetGuideAccess({ privateDir }).rotate();
  let calls = 0;
  const app = serve(cfg, { readOnlyPreview: true, createEngine: () => engine, fleet: { privateDir, fetchImpl: async () => { calls++; throw new Error('No remote requests in a preview.'); } } });
  t.after(() => app.close());
  if (!app.server.listening) await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  for (const [method, route, token] of [['POST', '/api/fleet/guidance', guide], ['PUT', '/api/fleet/shares', null], ['POST', '/api/fleet/nudge', null]]) {
    const response = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: '{}' });
    assert.equal(response.status, 403);
    await response.text();
  }
  assert.equal(calls, 0);
});
