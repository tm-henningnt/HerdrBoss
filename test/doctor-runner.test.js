import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDoctorRunner, runDoctor } from '../src/doctor.js';

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-runner-')));
  t.after(() => fs.rmSync(home, { force: true, recursive: true }));
  return home;
}
const options = () => ({ signal: new AbortController().signal, timeout: 1000 });
function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

test('the settings runner reads JSONC and the configured XDG OpenCode folder', async (t) => {
  const home = fixture(t);
  const xdg = path.join(home, 'xdg');
  const content = '// comment\n{"agent":{"worker":{}}}';
  write(path.join(xdg, 'opencode', 'opencode.jsonc'), content);
  const runner = createDoctorRunner({ home, env: { HOME: home, XDG_CONFIG_HOME: xdg } });
  assert.equal(await runner({ kind: 'opencode-settings' }, options()), content);
  const missing = createDoctorRunner({ home, env: { HOME: home } });
  await assert.rejects(missing({ kind: 'opencode-settings' }, options()), /No OpenCode settings file/);
});

test('the settings runner refuses unknown files and links to private data', async (t) => {
  const home = fixture(t);
  const privateFile = path.join(home, '.config', 'herdr-boss', 'access-token');
  write(privateFile, 'invented-secret');
  const file = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file));
  fs.symlinkSync(privateFile, file);
  const runner = createDoctorRunner({ home, env: { HOME: home } });
  await assert.rejects(runner({ kind: 'read', file: privateFile }, options()), /outside the doctor scope/);
  await assert.rejects(runner({ kind: 'read', file }, options()), /private Herdr Boss data/);
});

test('the settings runner refuses an XDG folder that points into private data', async (t) => {
  const home = fixture(t);
  const privateDir = path.join(home, '.herdr-boss');
  write(path.join(privateDir, 'opencode', 'opencode.json'), '{"inventedSecret":"do-not-read"}');
  const xdg = path.join(home, 'xdg');
  fs.symlinkSync(privateDir, xdg);
  const runner = createDoctorRunner({ home, env: { HOME: home, XDG_CONFIG_HOME: xdg } });
  await assert.rejects(runner({ kind: 'opencode-settings' }, options()), /private Herdr Boss data/);
});

test('the directory check uses metadata and leaves a missing data folder absent', async (t) => {
  const home = fixture(t);
  const runner = createDoctorRunner({ home, env: { HOME: home } });
  assert.equal(await runner({ kind: 'directory', file: home }, options()), true);
  const absent = path.join(home, 'missing-data');
  await assert.rejects(runner({ kind: 'directory', file: absent }, options()), { code: 'ENOENT' });
  assert.equal(fs.existsSync(absent), false);
});

test('the disk runner uses an injected free-space reader for the worktree file system', async (t) => {
  const home = fixture(t);
  let requestedPath;
  const runner = createDoctorRunner({
    home,
    env: { HOME: home },
    diskSpaceReader: async (file) => {
      requestedPath = file;
      return { bavail: 12, bsize: 1024 };
    },
  });
  const result = await runner({ kind: 'disk', file: path.join(home, 'worktrees') }, options());
  assert.deepEqual(result, { bavail: 12, bsize: 1024 });
  assert.equal(requestedPath, path.join(home, 'worktrees'));
});

test('doctor checks free space at the data folder and configured worktree root', async (t) => {
  const home = fixture(t);
  const dataDir = path.join(home, 'boss-data');
  const worktreeRoot = path.join(home, 'worker-trees');
  write(path.join(dataDir, 'config.json'), JSON.stringify({ worktreeRoot }));
  const requests = [];
  await runDoctor({
    home,
    env: { HOME: home, HERDR_BOSS_DIR: dataDir },
    runner: async (request) => {
      requests.push(request);
      if (request.id === 'os') return 'darwin';
      if (request.id === 'disk') return request.files.map(() => ({ bavail: 20_000_000_000, bsize: 1 }));
      return '';
    },
  });
  const disk = requests.find((request) => request.id === 'disk');
  assert.deepEqual(disk.files, [dataDir, worktreeRoot]);
});

test('the settings runner refuses a canonical path to a linked private data folder', async (t) => {
  const home = fixture(t);
  const storage = path.join(home, 'private-storage');
  write(path.join(storage, 'opencode', 'opencode.json'), '{"inventedSecret":"do-not-read"}');
  fs.symlinkSync(storage, path.join(home, '.herdr-boss'));
  const runner = createDoctorRunner({ home, env: { HOME: home, XDG_CONFIG_HOME: storage } });
  await assert.rejects(runner({ kind: 'opencode-settings' }, options()), /private Herdr Boss data/);
});

test('doctor accepts settings and data-folder links into a dotfiles folder', async (t) => {
  const home = fixture(t);
  const settings = path.join(home, 'dotfiles', 'claude-settings.json');
  const data = path.join(home, 'dotfiles', 'boss-data');
  write(settings, '{"autoMode":{}}');
  fs.mkdirSync(data);
  const file = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file));
  fs.symlinkSync(settings, file);
  fs.symlinkSync(data, path.join(home, '.herdr-boss'));
  const runner = createDoctorRunner({ home, env: { HOME: home } });
  assert.equal(await runner({ kind: 'read', file }, options()), '{"autoMode":{}}');
  assert.equal(await runner({ kind: 'directory', file: path.join(home, '.herdr-boss') }, options()), true);
});

test('doctor refuses a settings link into another tool credential folder', async (t) => {
  const home = fixture(t);
  const credentials = path.join(home, '.pi', 'agent', 'auth.json');
  write(credentials, '{"inventedSecret":"do-not-read"}');
  const file = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file));
  fs.symlinkSync(credentials, file);
  const runner = createDoctorRunner({ home, env: { HOME: home } });
  await assert.rejects(runner({ kind: 'read', file }, options()), /private tool data/);
  const data = path.join(home, '.herdr-boss');
  fs.symlinkSync(path.dirname(credentials), data);
  assert.equal(await runner({ kind: 'directory', file: data }, options()), false);
});
