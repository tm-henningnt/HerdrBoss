import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { serve } from '../src/server.js';
import { DATA_DIR, loadConfig } from '../src/config.js';
import { createQuotaPlanService } from '../src/quota-plan-service.js';

const NOW = Date.now();
const at = (hours) => new Date(NOW + hours * 3600000).toISOString();
const quotas = [{ provider: 'codex', observedAt: at(0), windows: [{ key: 'primary', usedPercent: 10, resetsAt: at(168), windowMinutes: 10080 }], codexResetCredits: [] }];

test('quota plan routes expose the current plan and refuse workers on the Owner write route', { timeout: 20000 }, async (t) => {
  const cfg = loadConfig();
  cfg.port = 0;
  cfg.host = '127.0.0.1';
  const tokenFile = cfg.access.tokenFile;
  const engine = new EventEmitter();
  engine.cfg = cfg;
  engine.push = false;
  engine.state = { quotas, quotaPlanSummary: { nextCreditAt: null, state: 'on-track', plannedUsageNow: 10 }, control: { projects: {} } };
  engine.memory = {};
  engine.kitRoot = process.cwd();
  engine.log = () => {};
  engine.tick = async () => engine.state;
  engine.herdrRunner = async () => '';
  engine.quotaPlanService = createQuotaPlanService({ dataDir: DATA_DIR });
  engine.quotaPlanService.replan({ provider: 'codex', quotas, now: NOW });
  const app = serve(cfg, { liveDataDir: DATA_DIR, createEngine: () => engine });
  t.after(async () => {
    await app.close();
    fs.rmSync(tokenFile, { force: true });
  });
  if (!app.server.listening) await new Promise((resolve, reject) => {
    app.server.once('listening', resolve);
    app.server.once('error', reject);
  });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const get = await fetch(`${url}/api/quota-plan/codex`);
  assert.equal(get.status, 200);
  const body = await get.json();
  assert.equal(body.provider, 'codex');
  assert.ok(body.plan.fast);
  assert.deepEqual(body.announcements, []);

  const announceUrl = `${url}/api/quota-plan/codex/announce`;
  const payload = { at: at(72), kind: 'partial', refundPercent: 12 };
  const worker = await fetch(announceUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-herdr-boss-caller': 'worker' }, body: JSON.stringify(payload) });
  assert.equal(worker.status, 403);
  const owner = await fetch(announceUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-herdr-boss-caller': 'page' }, body: JSON.stringify(payload) });
  assert.equal(owner.status, 200, await owner.text());
  assert.equal(engine.quotaPlanService.read().announcements.length, 1);
});
