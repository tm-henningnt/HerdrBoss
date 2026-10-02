import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-tools-home-'));
process.env.HERDR_BOSS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-tools-data-'));
process.env.HERDR_BOSS_PORT = '0';

const [{ serve }, { loadConfig }] = await Promise.all([import('../src/server.js'), import('../src/config.js')]);

test('the read-only preview skips the Linux tool check', async (t) => {
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  const calls = [];
  const engine = new EventEmitter();
  engine.state = { control: { projects: {} }, herdr: { panes: [] } };
  engine.log = () => {};
  const ticked = new Promise((resolve) => { engine.tick = async () => { resolve(); return engine.state; }; });
  const { server, close } = serve(cfg, { readOnlyPreview: true, createEngine: () => engine,
    machineTools: { platform: 'linux', runner: async (cmd) => { calls.push(cmd); return ''; } } });
  t.after(close);
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  await ticked;
  assert.deepEqual(calls, []);
});
