import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every folder below is in a temporary directory. The real Chrome clone folder is never read or changed.
process.env.HERDR_BOSS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-clone-engine-'));
process.on('exit', () => fs.rmSync(process.env.HERDR_BOSS_DIR, { recursive: true, force: true }));
const { Engine } = await import('../src/engine.js');
const { sweepCodeSignClones, parseProcessList, codeSignCloneDir } = await import('../src/clone-sweep.js');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HOUR = 3600 * 1000;

function cloneRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-clone-sweep-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'com.google.Chrome.code_sign_clone');
  fs.mkdirSync(dir);
  return { root, dir };
}

function makeClone(dir, name) {
  const folder = path.join(dir, name);
  fs.mkdirSync(path.join(folder, 'Google Chrome.app', 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'Google Chrome.app', 'Contents', 'Info.plist'), 'x');
  return { folder, birthtimeMs: fs.statSync(folder).birthtimeMs };
}

// A running process list that holds no Chrome.
const otherProcesses = async () => [{ pid: 1, startedAt: 0, comm: '/sbin/launchd' }];

test('an old orphan clone is deleted', async (t) => {
  const { dir } = cloneRoot(t);
  const clone = makeClone(dir, 'code_sign_clone.abc123');
  const result = await sweepCodeSignClones({ dir, now: clone.birthtimeMs + 2 * HOUR, processes: otherProcesses, freeBytes: async () => 0 });
  assert.deepEqual(result.removed, ['code_sign_clone.abc123']);
  assert.equal(fs.existsSync(clone.folder), false);
});

test('a clone younger than 1 hour is kept', async (t) => {
  const { dir } = cloneRoot(t);
  const clone = makeClone(dir, 'code_sign_clone.young1');
  const result = await sweepCodeSignClones({ dir, now: clone.birthtimeMs + 30 * 60 * 1000, processes: otherProcesses, freeBytes: async () => 0 });
  assert.deepEqual(result.removed, []);
  assert.equal(fs.existsSync(clone.folder), true);
});

test('a clone created within 5 seconds of a running Chrome start is kept', async (t) => {
  const { dir } = cloneRoot(t);
  const owned = makeClone(dir, 'code_sign_clone.port9222');
  // The Chrome started 3 seconds before its clone appeared.
  const processes = async () => [{ pid: 900, startedAt: owned.birthtimeMs - 3000, comm: CHROME }];
  const result = await sweepCodeSignClones({ dir, now: owned.birthtimeMs + 3 * HOUR, processes, freeBytes: async () => 0 });
  assert.deepEqual(result.removed, []);
  assert.equal(fs.existsSync(owned.folder), true);
});

test('a Chrome helper or a Chrome started more than 5 seconds away does not protect a clone', async (t) => {
  const { dir } = cloneRoot(t);
  const orphan = makeClone(dir, 'code_sign_clone.orphan1');
  const processes = async () => [
    { pid: 901, startedAt: orphan.birthtimeMs, comm: '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)' },
    { pid: 902, startedAt: orphan.birthtimeMs - 60000, comm: CHROME },
  ];
  const result = await sweepCodeSignClones({ dir, now: orphan.birthtimeMs + 3 * HOUR, processes, freeBytes: async () => 0 });
  assert.deepEqual(result.removed, ['code_sign_clone.orphan1']);
  assert.equal(fs.existsSync(orphan.folder), false);
});

test('a failed process read deletes nothing', async (t) => {
  const { dir } = cloneRoot(t);
  const clone = makeClone(dir, 'code_sign_clone.readfail');
  const result = await sweepCodeSignClones({ dir, now: clone.birthtimeMs + 2 * HOUR, processes: async () => { throw new Error('ps failed'); }, freeBytes: async () => 0 });
  assert.deepEqual(result.removed, []);
  assert.match(result.error, /process list/);
  assert.equal(fs.existsSync(clone.folder), true);
});

test('an empty process list deletes nothing', async (t) => {
  const { dir } = cloneRoot(t);
  const clone = makeClone(dir, 'code_sign_clone.noprocs');
  const result = await sweepCodeSignClones({ dir, now: clone.birthtimeMs + 2 * HOUR, processes: async () => [], freeBytes: async () => 0 });
  assert.deepEqual(result.removed, []);
  assert.equal(fs.existsSync(clone.folder), true);
});

test('a symbolic link or an unexpected name is kept', async (t) => {
  const { root, dir } = cloneRoot(t);
  const target = path.join(root, 'outside');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep'), 'x');
  fs.symlinkSync(target, path.join(dir, 'code_sign_clone.link01'));
  const odd = makeClone(dir, 'other_folder.abc');
  const dotted = makeClone(dir, 'code_sign_clone.ab-c');
  fs.writeFileSync(path.join(dir, 'code_sign_clone.file01'), 'not a folder');
  const result = await sweepCodeSignClones({ dir, now: Date.now() + 2 * HOUR, processes: otherProcesses, freeBytes: async () => 0 });
  assert.deepEqual(result.removed, []);
  assert.equal(fs.existsSync(path.join(target, 'keep')), true);
  assert.equal(fs.lstatSync(path.join(dir, 'code_sign_clone.link01')).isSymbolicLink(), true);
  assert.equal(fs.existsSync(odd.folder), true);
  assert.equal(fs.existsSync(dotted.folder), true);
  assert.equal(fs.existsSync(path.join(dir, 'code_sign_clone.file01')), true);
});

test('the dry run lists candidates and deletes nothing', async (t) => {
  const { dir } = cloneRoot(t);
  const clone = makeClone(dir, 'code_sign_clone.dry001');
  let removals = 0;
  const result = await sweepCodeSignClones({ dir, now: clone.birthtimeMs + 2 * HOUR, processes: otherProcesses, dryRun: true,
    remove: async () => { removals++; }, freeBytes: async () => 0 });
  assert.deepEqual(result.candidates.map((c) => c.name), ['code_sign_clone.dry001']);
  assert.ok(result.candidates[0].ageMs >= 2 * HOUR - 1000);
  assert.deepEqual(result.removed, []);
  assert.equal(removals, 0);
  assert.equal(fs.existsSync(clone.folder), true);
});

test('the freed bytes are the free disk space after the sweep minus the space before', async (t) => {
  const { dir } = cloneRoot(t);
  const clone = makeClone(dir, 'code_sign_clone.bytes1');
  const free = [1000, 1000 + 720 * 1024 * 1024];
  const result = await sweepCodeSignClones({ dir, now: clone.birthtimeMs + 2 * HOUR, processes: otherProcesses, freeBytes: async () => free.shift() });
  assert.equal(result.freedBytes, 720 * 1024 * 1024);
});

test('a missing clone folder deletes nothing and reports no error', async (t) => {
  const { root } = cloneRoot(t);
  const result = await sweepCodeSignClones({ dir: path.join(root, 'missing'), now: Date.now(), processes: otherProcesses, freeBytes: async () => 0 });
  assert.deepEqual(result.removed, []);
  assert.equal(result.error, undefined);
});

test('parseProcessList reads pid, start time, and executable path with spaces', () => {
  const list = parseProcessList([
    '  512 Sun Sep 27 10:12:33 2026     /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '    1 Fri Sep 25 17:05:57 2026     /sbin/launchd',
    'garbage',
  ].join('\n'));
  assert.equal(list.length, 2);
  assert.equal(list[0].pid, 512);
  assert.equal(list[0].comm, CHROME);
  assert.equal(list[0].startedAt, new Date('Sun Sep 27 10:12:33 2026').getTime());
});

test('codeSignCloneDir resolves the folder beside the user temporary folder only on macOS', (t) => {
  const { root } = cloneRoot(t);
  const temp = path.join(root, 'var', 'T');
  fs.mkdirSync(temp, { recursive: true });
  const expected = path.join(root, 'var', 'X', 'com.google.Chrome.code_sign_clone');
  const getconf = () => `${temp}/\n`;
  assert.equal(codeSignCloneDir({ homeCheck: false, platform: 'darwin', getconf }), null, 'a missing folder resolves to null');
  fs.mkdirSync(expected, { recursive: true });
  assert.equal(codeSignCloneDir({ homeCheck: false, platform: 'darwin', getconf }), expected);
  assert.equal(codeSignCloneDir({ homeCheck: false, platform: 'linux', getconf }), null);
  assert.equal(codeSignCloneDir({ homeCheck: false, platform: 'darwin', getconf: () => { throw new Error('no getconf'); } }), null);
});

test('codeSignCloneDir resolves nothing when HOME is a temporary folder', (t) => {
  const { root } = cloneRoot(t);
  const temp = path.join(root, 'var', 'T');
  fs.mkdirSync(path.join(root, 'var', 'X', 'com.google.Chrome.code_sign_clone'), { recursive: true });
  const home = process.env.HOME;
  process.env.HOME = root;
  try { assert.equal(codeSignCloneDir({ platform: 'darwin', getconf: () => `${temp}/` }), null); }
  finally { process.env.HOME = home; }
});

test('the engine sweeps at most once every 10 minutes, records one event per deleting run, and obeys the switch', async () => {
  const calls = [];
  const collectors = {
    codeSignCloneDir: () => '/nonexistent/clone-dir',
    sweepCodeSignClones: async (options) => { calls.push(options); return { removed: ['code_sign_clone.a', 'code_sign_clone.b'], freedBytes: 1.5 * 1024 ** 3 }; },
  };
  const engine = new Engine({ push: false, browsers: {} }, { push: false, act: false, collectors });
  engine.log = (type, text, extra) => engine.events.push({ type, text, ...extra });
  engine.events = [];
  const t0 = 10 * 60 * 1000 * 100;
  await engine.sweepClones(t0);
  assert.equal(engine.sweepClones(t0 + 9 * 60 * 1000), null);
  await engine.sweepClones(t0 + 10 * 60 * 1000);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { dir: '/nonexistent/clone-dir', now: t0 });
  assert.equal(engine.events.length, 2);
  assert.equal(engine.events[0].type, 'clone-sweep');
  assert.equal(engine.events[0].count, 2);
  assert.equal(engine.events[0].freedBytes, 1.5 * 1024 ** 3);
  assert.match(engine.events[0].text, /2 orphaned Chrome code-sign clone\(s\).*1\.5 GiB/);

  const off = new Engine({ push: false, browsers: { sweepCodeSignClones: false } }, { push: false, act: false, collectors });
  assert.equal(off.sweepClones(t0), null);
  assert.equal(calls.length, 2);
});

test('the engine records no event when the sweep deletes nothing', async () => {
  const collectors = { codeSignCloneDir: () => '/nonexistent/clone-dir', sweepCodeSignClones: async () => ({ removed: [], freedBytes: 0 }) };
  const engine = new Engine({ push: false, browsers: {} }, { push: false, act: false, collectors });
  engine.events = [];
  engine.log = (type, text) => engine.events.push({ type, text });
  await engine.sweepClones(Date.now());
  assert.deepEqual(engine.events, []);
});
