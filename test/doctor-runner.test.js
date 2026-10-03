import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDoctorRunner } from '../src/doctor.js';

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
  await assert.rejects(runner({ kind: 'read', file }, options()), /settings link/);
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

test('the settings runner refuses a canonical path to a linked private data folder', async (t) => {
  const home = fixture(t);
  const storage = path.join(home, 'private-storage');
  write(path.join(storage, 'opencode', 'opencode.json'), '{"inventedSecret":"do-not-read"}');
  fs.symlinkSync(storage, path.join(home, '.herdr-boss'));
  const runner = createDoctorRunner({ home, env: { HOME: home, XDG_CONFIG_HOME: storage } });
  await assert.rejects(runner({ kind: 'opencode-settings' }, options()), /private Herdr Boss data/);
});
