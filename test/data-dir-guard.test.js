import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-guard-test-')));
const homeDir = path.join(root, 'home');
const dataDir = path.join(root, 'data');
fs.mkdirSync(homeDir);
fs.mkdirSync(dataDir);
process.env.HOME = homeDir;
process.env.HERDR_BOSS_DIR = dataDir;
delete process.env.HERDR_BOSS_LIVE_DIR;

const { assertTempDataDir, LIVE_DATA_DIR_MESSAGE } = await import('../src/data-dir-guard.js');
const { openMessageStore } = await import('../src/message-store.js');

const liveDir = path.join(homeDir, '.herdr-boss');
fs.mkdirSync(liveDir);

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('the guard message names the temporary fixture', () => {
  assert.equal(LIVE_DATA_DIR_MESSAGE, 'Refusing to write test data into the live data dir. Use a temporary one: HERDR_BOSS_DIR=$(mktemp -d) HOME=$(mktemp -d)');
});

test('the guard refuses the live data dir', () => {
  assert.throws(() => assertTempDataDir(liveDir), { message: LIVE_DATA_DIR_MESSAGE });
});

test('the guard refuses the live data dir when it does not exist yet', () => {
  const other = path.join(root, 'other-home', '.herdr-boss');
  fs.mkdirSync(path.dirname(other));
  process.env.HOME = path.dirname(other);
  try {
    assert.throws(() => assertTempDataDir(other), { message: LIVE_DATA_DIR_MESSAGE });
  } finally {
    process.env.HOME = homeDir;
  }
});

test('the guard refuses a path inside the live data dir', () => {
  const inside = path.join(liveDir, 'projects', 'demo');
  assert.throws(() => assertTempDataDir(inside), { message: LIVE_DATA_DIR_MESSAGE });
});

test('the guard refuses a symlink to the live data dir', () => {
  const link = path.join(root, 'link');
  fs.symlinkSync(liveDir, link);
  assert.throws(() => assertTempDataDir(link), { message: LIVE_DATA_DIR_MESSAGE });
  assert.throws(() => assertTempDataDir(path.join(link, 'sub')), { message: LIVE_DATA_DIR_MESSAGE });
});

test('the guard refuses the dir named by HERDR_BOSS_LIVE_DIR', () => {
  const custom = path.join(root, 'custom-live');
  fs.mkdirSync(custom);
  process.env.HERDR_BOSS_LIVE_DIR = custom;
  try {
    assert.throws(() => assertTempDataDir(custom), { message: LIVE_DATA_DIR_MESSAGE });
  } finally {
    delete process.env.HERDR_BOSS_LIVE_DIR;
  }
});

test('the guard accepts a temporary dir and returns its real path', () => {
  assert.equal(assertTempDataDir(dataDir), dataDir);
  assert.equal(assertTempDataDir(path.join(dataDir, 'not-yet')), path.join(dataDir, 'not-yet'));
});

test('openMessageStore throws a TypeError for a string argument', () => {
  assert.throws(() => openMessageStore('x'), (error) => error instanceof TypeError && /options object/.test(error.message) && /\{ dir \}/.test(error.message));
});

test('openMessageStore still accepts no argument and an options object', () => {
  assert.equal(typeof openMessageStore({ dir: dataDir }).all, 'function');
});

test('seed-preview refuses the live data dir and writes nothing', async () => {
  const { seedPreview } = await import('../scripts/seed-preview.js');
  assert.throws(() => seedPreview(liveDir), { message: LIVE_DATA_DIR_MESSAGE });
  assert.deepEqual(fs.readdirSync(liveDir), []);
});

test('seed-preview seeds Mailbox and Chat records into a temporary dir', async () => {
  const { seedPreview } = await import('../scripts/seed-preview.js');
  const dir = path.join(dataDir, 'seeded');
  const count = seedPreview(dir);
  const records = openMessageStore({ dir }).all();
  assert.equal(records.length, count);
  assert.ok(records.some((record) => record.kind === 'report'));
  assert.ok(records.some((record) => record.thread === 'boss'));
});
