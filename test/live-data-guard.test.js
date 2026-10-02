import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { describeLiveChanges, isInsideLiveDir, liveDataDir, snapshotLiveFiles } from '../scripts/live-data-guard.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(here, '..', 'scripts', 'live-write-guard.js');
const RUNNER = path.join(here, '..', 'scripts', 'test.js');

function tempDir(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `herdr-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the live data dir follows HERDR_BOSS_LIVE_DIR and otherwise the account home', () => {
  assert.equal(liveDataDir({ HERDR_BOSS_LIVE_DIR: '/tmp/example-live' }), '/tmp/example-live');
  assert.match(liveDataDir({}), /[\\/]\.herdr-boss$/);
  assert.notEqual(liveDataDir({}), path.join(os.tmpdir(), '.herdr-boss'));
});

test('a snapshot reports a created, a changed, and an unchanged live file', (t) => {
  const live = tempDir(t, 'live-guard-snapshot');
  const before = snapshotLiveFiles(live);
  assert.deepEqual(describeLiveChanges(before, before), []);
  fs.writeFileSync(path.join(live, 'events.jsonl'), 'one\n');
  const after = snapshotLiveFiles(live);
  assert.deepEqual(describeLiveChanges(before, after), ['events.jsonl: created']);
  fs.appendFileSync(path.join(live, 'events.jsonl'), 'two\n');
  assert.deepEqual(describeLiveChanges(after, snapshotLiveFiles(live)), ['events.jsonl: size 4 -> 8']);
});

test('the live path test compares real paths and keeps siblings outside', (t) => {
  const live = tempDir(t, 'live-guard-path');
  assert.equal(isInsideLiveDir(live, live), true);
  assert.equal(isInsideLiveDir(path.join(live, 'state.json'), live), true);
  assert.equal(isInsideLiveDir(`${live}-other`, live), false);
  assert.equal(isInsideLiveDir(path.join(os.tmpdir(), 'elsewhere'), live), false);
});

test('the preload refuses a live write and a Chrome launch, and allows a safe write', (t) => {
  const live = tempDir(t, 'live-guard-preload');
  const safe = tempDir(t, 'live-guard-safe');
  const report = path.join(safe, 'report.jsonl');
  const script = path.join(safe, 'attempts.mjs');
  fs.writeFileSync(path.join(live, 'read-me.txt'), 'ok');
  fs.writeFileSync(script, `
import fs from 'node:fs';
import { writeFileSync } from 'node:fs';
import { writeFile, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const live = process.env.GUARD_LIVE;
const safe = process.env.GUARD_SAFE;
const results = [];
const attempt = async (name, fn) => { try { await fn(); results.push([name, 'allowed']); } catch (error) { results.push([name, error.code ?? 'error']); } };
await attempt('default-write', () => fs.writeFileSync(live + '/events.jsonl', 'x'));
await attempt('named-write', () => writeFileSync(live + '/state.json', 'x'));
await attempt('promise-write', () => writeFile(live + '/events.jsonl', 'x'));
await attempt('rename-into-live', () => fs.renameSync(safe + '/src', live + '/state.json'));
await attempt('safe-write', () => fs.writeFileSync(safe + '/ok.txt', 'x'));
await attempt('open-sync-read', () => { const fd = fs.openSync(live + '/read-me.txt'); fs.closeSync(fd); });
await attempt('open-promise-read', async () => { const handle = await open(live + '/read-me.txt'); await handle.close(); });
await attempt('open-callback-read', () => new Promise((resolve, reject) => { fs.open(live + '/read-me.txt', (error, fd) => { if (error) reject(error); else fs.close(fd, (closeError) => closeError ? reject(closeError) : resolve()); }); }));
await attempt('chrome-launch', () => spawn('/tmp/fake/Google Chrome', []));
console.log(JSON.stringify(results));
`);
  const env = {
    ...process.env,
    GUARD_LIVE: live,
    GUARD_SAFE: safe,
    HERDR_BOSS_TEST_GUARD_DIR: live,
    HERDR_BOSS_TEST_GUARD_REPORT: report,
  };
  delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, ['--import', GUARD, script], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  const results = Object.fromEntries(JSON.parse(result.stdout.trim()));
  assert.equal(results['default-write'], 'HERDR_LIVE_DATA_WRITE');
  assert.equal(results['named-write'], 'HERDR_LIVE_DATA_WRITE');
  assert.equal(results['promise-write'], 'HERDR_LIVE_DATA_WRITE');
  assert.equal(results['rename-into-live'], 'HERDR_LIVE_DATA_WRITE');
  assert.equal(results['chrome-launch'], 'HERDR_LIVE_DATA_WRITE');
  assert.equal(results['safe-write'], 'allowed');
  assert.equal(results['open-sync-read'], 'allowed');
  assert.equal(results['open-promise-read'], 'allowed');
  assert.equal(results['open-callback-read'], 'allowed');
  const lines = fs.readFileSync(report, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual([...new Set(lines.map((line) => line.kind))].sort(), ['launch Chrome', 'rename', 'write']);
  assert.equal(fs.existsSync(path.join(live, 'events.jsonl')), false, 'the refused write must not create a live file');
});

test('the runner fails the run when a test file writes the live data dir', (t) => {
  const live = tempDir(t, 'live-guard-runner-live');
  const fixture = tempDir(t, 'live-guard-runner-fixture');
  const testFile = path.join(fixture, 'writes-live.test.js');
  fs.writeFileSync(testFile, `
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
test('writes the live data dir', () => {
  fs.appendFileSync(path.join(process.env.HERDR_BOSS_TEST_GUARD_DIR, 'events.jsonl'), 'x\\n');
});
`);
  const env = { ...process.env, HERDR_BOSS_LIVE_DIR: live };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, [RUNNER, '--', testFile], { cwd: path.join(here, '..'), encoding: 'utf8', env });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Live data guard: 1 test write/);
  assert.equal(fs.existsSync(path.join(live, 'events.jsonl')), false, 'the guard must prevent the live write');
});

test('the runner passes a test file that writes only a temporary directory', (t) => {
  const live = tempDir(t, 'live-guard-runner-clean-live');
  const fixture = tempDir(t, 'live-guard-runner-clean-fixture');
  const testFile = path.join(fixture, 'writes-temp.test.js');
  fs.writeFileSync(testFile, `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
test('writes a temporary directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-safe-'));
  fs.writeFileSync(path.join(dir, 'ok.txt'), 'x');
  fs.rmSync(dir, { recursive: true, force: true });
});
`);
  const env = { ...process.env, HERDR_BOSS_LIVE_DIR: live };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, [RUNNER, '--', testFile], { cwd: path.join(here, '..'), encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stderr, /Live data guard:/);
});
