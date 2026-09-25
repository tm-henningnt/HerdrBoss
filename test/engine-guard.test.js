import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const probe = `
  const { Engine } = await import('./src/engine.js');
  const engine = new Engine({ push: true, quotaSeconds: 300, tickSeconds: 30 });
  console.log(JSON.stringify({ act: engine.act, push: engine.push, guard: engine.events.find((event) => event.type === 'guard')?.text ?? null }));
`;

function inspectEngine(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-engine-guard-'));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, HERDR_BOSS_DIR: dataDir, ...overrides },
  });
  fs.rmSync(dataDir, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test('Engine disables actions and push in the Node test context and logs the reason', { timeout: 10000 }, () => {
  const result = inspectEngine({ NODE_TEST_CONTEXT: 'child-v8' });
  assert.equal(result.act, false);
  assert.equal(result.push, false);
  assert.match(result.guard, /NODE_TEST_CONTEXT/);
});

test('Engine disables actions and push for a non-live data directory', { timeout: 10000 }, () => {
  const result = inspectEngine({ NODE_TEST_CONTEXT: '' });
  assert.equal(result.act, false);
  assert.equal(result.push, false);
  assert.match(result.guard, /data directory/);
});

test('HERDR_BOSS_ALLOW_ACTIONS=1 overrides both guards', { timeout: 10000 }, () => {
  const result = inspectEngine({ NODE_TEST_CONTEXT: 'child-v8', HERDR_BOSS_ALLOW_ACTIONS: '1' });
  assert.equal(result.act, true);
  assert.equal(result.push, true);
  assert.equal(result.guard, null);
});
