import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A preview tick writes these files into its data directory.
const PREVIEW_FILES = ['state.json', 'rules.json', 'bulletin.md', 'quota-history.jsonl'];
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-preview-home-'));
process.env.HOME = homeDir;
delete process.env.HERDR_BOSS_DIR;
delete process.env.HERDR_BOSS_LIVE_DIR;

const [{ serve }, { loadConfig }] = await Promise.all([
  import('../src/server.js'),
  import('../src/config.js'),
]);

function writtenFiles(...dirs) {
  return dirs.flatMap((dir) => PREVIEW_FILES.filter((name) => fs.existsSync(path.join(dir, name))));
}

function temporaryDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `herdr-preview-${tag}-`));
}

function runCli(home, env) {
  return spawnSync(process.execPath, [path.join(repo, 'src', 'cli.js'), 'serve', '--read-only-preview'], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 10000,
    env: { PATH: process.env.PATH, HOME: home, HERDR_BOSS_PORT: '0', ...env },
  });
}

test('serve refuses a read-only preview that points at the live service data directory', { timeout: 20000 }, async (t) => {
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  assert.throws(
    () => serve(cfg, { readOnlyPreview: true, createEngine: () => { throw new Error('a refused preview must not create an Engine'); } }),
    /HERDR_BOSS_DIR/,
  );
  assert.deepEqual(writtenFiles(path.join(homeDir, '.herdr-boss')), [], 'a refused preview writes no preview file');
});

test('the CLI refuses a read-only preview before it creates the default data directory', { timeout: 30000 }, async (t) => {
  const home = temporaryDir('home');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = runCli(home, { HERDR_BOSS_DIR: '', HERDR_BOSS_LIVE_DIR: '' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /HERDR_BOSS_DIR/);
  assert.equal(fs.existsSync(path.join(home, '.herdr-boss')), false, 'the refusal runs before loadConfig creates the data directory');
});

test('the CLI refuses a read-only preview that points at the configured live directory', { timeout: 30000 }, async (t) => {
  const home = temporaryDir('home');
  const liveDir = temporaryDir('live');
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(liveDir, { recursive: true, force: true });
  });
  const result = runCli(home, { HERDR_BOSS_DIR: liveDir, HERDR_BOSS_LIVE_DIR: liveDir });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /HERDR_BOSS_DIR/);
  assert.deepEqual(writtenFiles(liveDir), [], 'a refused preview writes no preview file');
});

test('the CLI refuses a read-only preview that points at the default directory of another live directory', { timeout: 30000 }, async (t) => {
  const home = temporaryDir('home');
  const liveDir = temporaryDir('live');
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(liveDir, { recursive: true, force: true });
  });
  const result = runCli(home, { HERDR_BOSS_DIR: path.join(home, '.herdr-boss'), HERDR_BOSS_LIVE_DIR: liveDir });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /HERDR_BOSS_DIR/);
  assert.deepEqual(writtenFiles(path.join(home, '.herdr-boss')), [], 'a refused preview writes no preview file');
});

const probe = `
  const { EventEmitter } = await import('node:events');
  const { serve } = await import('./src/server.js');
  const { loadConfig } = await import('./src/config.js');
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  const engine = new EventEmitter();
  engine.act = false;
  engine.push = false;
  engine.state = { ok: true };
  engine.tick = async () => engine.state;
  engine.log = () => {};
  const { server, close } = serve(cfg, { readOnlyPreview: true, createEngine: () => engine });
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const read = await fetch(base + '/api/state');
  const write = await fetch(base + '/api/projects/demo', { method: 'DELETE' });
  await close();
  console.log('RESULT ' + JSON.stringify({ read: read.status, write: write.status, listening: server.listening }));
`;

function runProbe(home, env, source = probe) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 20000,
    env: { PATH: process.env.PATH, HOME: home, ...env },
  });
}

function resultOf(probe) {
  assert.equal(probe.status, 0, probe.stderr);
  return JSON.parse(probe.stdout.trim().split('\n').at(-1).slice('RESULT '.length));
}

test('an isolated data directory still starts a read-only preview and serves reads', { timeout: 40000 }, async (t) => {
  const home = temporaryDir('home');
  const dataDir = temporaryDir('data');
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const { read, write, listening } = resultOf(runProbe(home, { HERDR_BOSS_DIR: dataDir }));
  assert.equal(read, 200, 'the preview serves a read');
  assert.equal(write, 403, 'the preview refuses an API change');
  assert.equal(listening, false, 'the probe closes the server');
  assert.equal(fs.existsSync(path.join(home, '.herdr-boss')), false, 'an isolated preview keeps the default directory unused');
});

test('an isolated data directory that holds files from an earlier preview still starts', { timeout: 40000 }, async (t) => {
  const home = temporaryDir('home');
  const dataDir = temporaryDir('data');
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  for (const name of PREVIEW_FILES) fs.writeFileSync(path.join(dataDir, name), 'left by an earlier preview\n');
  const { read, write } = resultOf(runProbe(home, { HERDR_BOSS_DIR: dataDir }));
  assert.equal(read, 200, 'the preview serves a read');
  assert.equal(write, 403, 'the preview refuses an API change');
});

// serve() owns the refusal. The probe hands serve() a configuration so that no data directory is created before the check.
// A missing guard would create the access token, so the token path stays inside the temporary HOME of the probe.
const refusalProbe = `
  const { serve } = await import('./src/server.js');
  let engineCreated = false;
  let refused = null;
  try {
    serve({ access: { tokenFile: process.env.HOME + '/unused', sessionDays: 30 } }, {
      readOnlyPreview: true,
      createEngine: () => { engineCreated = true; throw new Error('a refused preview must not create an Engine'); },
    });
  } catch (error) { refused = error.message; }
  console.log('RESULT ' + JSON.stringify({ engineCreated, refused }));
`;

function assertRefused(home, env) {
  const { engineCreated, refused } = resultOf(runProbe(home, env, refusalProbe));
  assert.match(refused || '', /HERDR_BOSS_DIR/, 'the refusal names the data directory variable');
  assert.doesNotMatch(refused || '', /empty/, 'the refusal asks for a separate directory, not an empty one');
  assert.equal(engineCreated, false, 'the refusal runs before the Engine is created');
}

test('serve refuses a data directory that is a symlink to the live service directory', { timeout: 40000 }, async (t) => {
  const home = temporaryDir('home');
  const root = temporaryDir('alias');
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const liveDir = path.join(root, 'live');
  fs.mkdirSync(liveDir);
  fs.symlinkSync(liveDir, path.join(root, 'preview'), 'dir');
  assertRefused(home, { HERDR_BOSS_DIR: path.join(root, 'preview'), HERDR_BOSS_LIVE_DIR: liveDir });
  assert.deepEqual(fs.readdirSync(liveDir), [], 'a refused preview writes nothing into the live service directory');
});

test('serve refuses a data directory that is a symlink to the default service directory', { timeout: 40000 }, async (t) => {
  const home = temporaryDir('home');
  const root = temporaryDir('alias');
  const liveDir = temporaryDir('live');
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(liveDir, { recursive: true, force: true });
  });
  const defaultDir = path.join(home, '.herdr-boss');
  fs.mkdirSync(defaultDir);
  fs.symlinkSync(defaultDir, path.join(root, 'preview'), 'dir');
  assertRefused(home, { HERDR_BOSS_DIR: path.join(root, 'preview'), HERDR_BOSS_LIVE_DIR: liveDir });
  assert.deepEqual(fs.readdirSync(defaultDir), [], 'a refused preview writes nothing into the default service directory');
});

test('serve refuses a missing final directory whose symlinked parent resolves to the live service directory', { timeout: 40000 }, async (t) => {
  const home = temporaryDir('home');
  const root = temporaryDir('alias');
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const realParent = path.join(root, 'real');
  fs.mkdirSync(realParent);
  fs.symlinkSync(realParent, path.join(root, 'link'), 'dir');
  const liveDir = path.join(realParent, 'child');
  assertRefused(home, { HERDR_BOSS_DIR: path.join(root, 'link', 'child'), HERDR_BOSS_LIVE_DIR: liveDir });
  assert.equal(fs.existsSync(liveDir), false, 'a refused preview creates no preview file directory');
});

test('an isolated data directory behind a symlinked parent still starts a read-only preview', { timeout: 40000 }, async (t) => {
  const home = temporaryDir('home');
  const root = temporaryDir('alias');
  const liveDir = temporaryDir('live');
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(liveDir, { recursive: true, force: true });
  });
  const realParent = path.join(root, 'real');
  fs.mkdirSync(realParent);
  fs.symlinkSync(realParent, path.join(root, 'link'), 'dir');
  const { read, write } = resultOf(runProbe(home, { HERDR_BOSS_DIR: path.join(root, 'link', 'child'), HERDR_BOSS_LIVE_DIR: liveDir }));
  assert.equal(read, 200, 'the preview serves a read');
  assert.equal(write, 403, 'the preview refuses an API change');
  assert.equal(fs.existsSync(path.join(realParent, 'child')), true, 'the preview uses the resolved directory');
});
