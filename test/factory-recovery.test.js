import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { factoryCommand } from '../src/factory-host.js';
import { writeFleet, writePrivate, VOLUMES } from '../src/factory-store.js';

const health = { schema: 1, contractVersion: '1.0.0', version: '0.1.0', kitRevision: 'abcdef012345', herdrReachable: true };
const labels = { 'herdr-factory': 'demo', 'herdr-factory-spike': 'ft14' };
const image = { Config: { Labels: { 'org.opencontainers.image.created': '2026-10-03T00:00:00Z', 'org.herdr-boss.pins-sha256': 'a'.repeat(64) } } };
function fixture(remote = false) {
  // A backup cannot live in the worker's repository-local TMPDIR.
  const root = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'factory-recovery-'));
  const env = { HOME: path.join(root, 'home'), HERDR_BOSS_DIR: path.join(root, 'boss'), HERDR_FACTORIES_DIR: path.join(root, 'factories'), TMPDIR: root };
  fs.mkdirSync(env.HOME);
  const volumePaths = Object.fromEntries(Object.keys(VOLUMES).map((kind) => [kind, path.join(root, `volume-${kind}`)]));
  const volumes = new Map();
  const helpers = new Map();
  for (const [kind, dir] of Object.entries(volumePaths)) {
    fs.mkdirSync(dir);
    volumes.set(`hf-demo-${kind}`, { Name: `hf-demo-${kind}`, Labels: { ...labels } });
  }
  fs.writeFileSync(path.join(volumePaths.data, 'config.json'), '{"invented":true}');
  fs.writeFileSync(path.join(volumePaths.work, 'binary.bin'), Buffer.from([0, 255, 128, 10]));
  fs.writeFileSync(path.join(volumePaths.home, 'login.fixture'), 'invented-private-value');
  const db = new DatabaseSync(path.join(volumePaths.data, 'herdr-boss.db'));
  db.exec('CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES (\'kept\')');
  db.close();
  const hostId = remote ? 'host-a' : 'local';
  if (remote) writePrivate(path.join(env.HERDR_FACTORIES_DIR, 'registry.json'), { version: 1, hosts: { 'host-a': { dockerContext: 'example-context', address: '192.0.2.1', user: 'example', keyFile: '/example.invalid/key', codexSandbox: 'user-namespaces' } } });
  writeFleet(env, { schema: 1, contractVersion: '1.0.0', minimumFactoryVersion: '0.1.0', hosts: [{ hostId, runtime: remote ? 'docker-engine-wsl2' : 'orbstack', personalOnly: true, codexSandbox: 'user-namespaces', transport: remote ? 'ssh' : 'local', ...(remote ? { connectionRef: hostId } : {}) }], factories: [{ factoryId: 'demo', name: 'demo', hostId, profile: 'personal', dashboardUrl: 'http://demo.localhost:4478', version: health.version, kitRevision: health.kitRevision, kind: 'container', containerName: 'hf-demo', hostname: 'demo.localhost', ports: { dashboard: 4478, ssh: 2222 }, image: { builtAt: image.Config.Labels['org.opencontainers.image.created'], pinsHash: 'a'.repeat(64) } }] });
  writePrivate(path.join(env.HERDR_FACTORIES_DIR, 'demo', 'factory.json'), { schema: 1, name: 'demo', hostId, profile: 'personal', imageTag: 'example-factory:test', ports: { dashboard: 4478, ssh: 2222 }, stage: 'ready' });
  let container = makeContainer();
  function makeContainer() { return { Id: 'demo-id', Config: { Labels: { ...labels } }, HostConfig: { Privileged: false, CapAdd: null, SecurityOpt: ['seccomp=example-profile', 'systempaths=unconfined'] }, Mounts: Object.entries(VOLUMES).map(([kind, target]) => ({ Type: 'volume', Name: `hf-demo-${kind}`, Destination: target })), State: { Running: true, Status: 'running' } }; }
  const calls = [], output = [];
  const ok = (value = '') => ({ code: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
  const missing = () => ({ code: 1, stdout: '', stderr: 'No such object' });
  const docker = { async run(args, options = {}) {
    calls.push({ args, options });
    if (args[0] === 'container' && args[1] === 'inspect') {
      const found = args[2] === 'hf-demo' ? container : helpers.get(args[2]);
      return found ? ok([found]) : missing();
    }
    if (args[0] === 'volume' && args[1] === 'inspect') return volumes.has(args[2]) ? ok([volumes.get(args[2])]) : missing();
    if (args[0] === 'image' && args[1] === 'inspect') return ok([image]);
    if (args[0] === 'stop') { container.State.Running = false; container.State.Status = 'exited'; return ok(); }
    if (args[0] === 'start') { container.State.Running = true; container.State.Status = 'running'; return ok(); }
    if (args[0] === 'pause' || args[0] === 'unpause') { container.State.Paused = args[0] === 'pause'; return ok(); }
    if (args[0] === 'container' && args[1] === 'rm') {
      if (args.at(-1) === 'hf-demo') container = null;
      else helpers.delete(args.at(-1));
      return ok();
    }
    if (args[0] === 'volume' && args[1] === 'rm') { volumes.delete(args[2]); fs.rmSync(volumePaths[args[2].split('-').at(-1)], { recursive: true, force: true }); return ok(); }
    if (args[0] === 'volume' && args[1] === 'create') { const name = args.at(-1); volumes.set(name, { Name: name, Labels: { ...labels } }); fs.mkdirSync(volumePaths[name.split('-').at(-1)]); return ok(); }
    if (args[0] === 'container' && args[1] === 'create') { container = makeContainer(); container.State.Running = false; return ok(); }
    if (args[0] === 'run') {
      const nodeIndex = args.indexOf('--input-type=module');
      const nodeArgs = args.slice(nodeIndex).map((word) => {
        let value = word;
        for (const [kind, dir] of Object.entries(volumePaths)) value = value.replaceAll(`/volumes/${kind}`, dir);
        return value;
      });
      const out = options.outputFile ? fs.openSync(options.outputFile, 'w', 0o600) : 'pipe';
      const input = options.inputFile ? fs.openSync(options.inputFile, 'r') : 'pipe';
      try {
        const result = spawnSync(process.execPath, nodeArgs, { env: { ...process.env, ...env }, stdio: [input, out, 'pipe'], encoding: options.outputFile ? undefined : 'utf8' });
        return { code: result.status, stdout: options.outputFile ? '' : result.stdout, stderr: result.stderr?.toString() || '' };
      } finally { if (typeof out === 'number') fs.closeSync(out); if (typeof input === 'number') fs.closeSync(input); }
    }
    if (args[0] === 'exec' && args.includes('curl')) return ok(args.includes('%{http_code}') ? '200' : health);
    if (args[0] === 'exec' && args.includes('herdr')) return ok({ result: { panes: [] } });
    if (args[0] === 'exec' && args.includes('node')) return ok({});
    if (args[0] === 'exec') return ok('repair output\n');
    if (args[0] === 'logs') return ok('service stopped\naccess_token=invented-private-value\n192.0.2.1\n');
    throw new Error('Unexpected fake Docker operation');
  } };
  const io = { env, isContainer: () => false, transportFactory: () => docker, stdin: Object.assign(Readable.from(['demo\n']), { isTTY: true }), stdout: { isTTY: true, write: (value) => output.push(value) }, stderr: { write: (value) => output.push(value) } };
  return { root, env, io, calls, output, volumes, helpers, volumePaths, docker, get container() { return container; }, file: path.join(root, 'backups', 'demo.hfb'), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

for (const remote of [false, true]) test(`backup and restore preserve SQLite, data and binary work on ${remote ? 'context' : 'local'} transport`, async () => {
  const f = fixture(remote);
  try {
    assert.equal(await factoryCommand(['backup', 'demo', '--file', f.file, '--include-home'], f.io), 0);
    assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(f.file)).mode & 0o777, 0o700);
    assert.equal(f.container.State.Running, true);
    assert.equal(await factoryCommand(['destroy', 'demo'], f.io), 0);
    f.io.stdin = Object.assign(Readable.from(['demo\n']), { isTTY: true });
    assert.equal(await factoryCommand(['restore', f.file, ...(remote ? ['--host', 'host-a'] : [])], f.io), 0);
    assert.equal(fs.readFileSync(path.join(f.volumePaths.data, 'config.json'), 'utf8'), '{"invented":true}');
    assert.deepEqual(fs.readFileSync(path.join(f.volumePaths.work, 'binary.bin')), Buffer.from([0, 255, 128, 10]));
    assert.equal(fs.readFileSync(path.join(f.volumePaths.home, 'login.fixture'), 'utf8'), 'invented-private-value');
    const restored = new DatabaseSync(path.join(f.volumePaths.data, 'herdr-boss.db'), { readOnly: true });
    assert.equal(restored.prepare('SELECT value FROM sample').get().value, 'kept'); restored.close();
    assert.equal(f.container.State.Running, true);
    assert.ok(f.calls.filter(({ args }) => args[0] === 'run').every(({ args }) => args.includes('herdr-factory=demo') && args.includes('herdr-factory-spike=ft14')));
    for (const secret of ['invented-private-value', '192.0.2.1', 'example-context', '/example.invalid/key']) assert.equal(f.output.join('').includes(secret), false);
    const removals = f.calls.filter(({ args }) => args[1] === 'rm').map(({ args }) => args);
    assert.deepEqual(removals, [['container', 'rm', 'hf-demo'], ...Object.keys(VOLUMES).map((kind) => ['volume', 'rm', `hf-demo-${kind}`])]);
  } finally { f.cleanup(); }
});

test('destroy refuses missing, old, corrupted or wrong-factory backups before any mutation', async () => {
  const f = fixture();
  try {
    await assert.rejects(factoryCommand(['destroy', 'demo'], f.io), /backup/i);
    await factoryCommand(['backup', 'demo', '--file', f.file, '--include-home'], f.io);
    const receiptFile = path.join(f.env.HERDR_FACTORIES_DIR, 'demo', 'backup.json');
    const receipt = JSON.parse(fs.readFileSync(receiptFile));
    fs.writeFileSync(receiptFile, JSON.stringify({ ...receipt, createdAt: new Date(Date.now() - 25 * 3600_000).toISOString() }));
    const before = f.calls.length;
    await assert.rejects(factoryCommand(['destroy', 'demo'], f.io), /24 hours|fresh/i);
    fs.writeFileSync(receiptFile, JSON.stringify(receipt));
    fs.appendFileSync(f.file, 'corrupt');
    await assert.rejects(factoryCommand(['destroy', 'demo'], f.io), /backup/i);
    assert.equal(f.calls.slice(before).some(({ args }) => ['stop', 'rm'].includes(args[0]) || args[1] === 'rm'), false);
  } finally { f.cleanup(); }
});

test('restore and destroy require exact typed confirmation from a terminal', async () => {
  const f = fixture();
  try {
    await factoryCommand(['backup', 'demo', '--file', f.file, '--include-home'], f.io);
    const before = f.calls.length;
    f.io.stdin = Object.assign(Readable.from(['wrong\n']), { isTTY: true });
    await assert.rejects(factoryCommand(['destroy', 'demo'], f.io), /confirmation/i);
    f.io.stdin = Readable.from(['demo\n']);
    await assert.rejects(factoryCommand(['destroy', 'demo'], f.io), /terminal/i);
    await assert.rejects(factoryCommand(['restore', f.file], f.io), /terminal/i);
    assert.equal(f.calls.slice(before).some(({ args }) => args[0] === 'stop' || args[1] === 'rm' || args[1] === 'create'), false);
  } finally { f.cleanup(); }
});

test('ownership checks cover all volumes before deleting a container', async () => {
  const f = fixture();
  try {
    await factoryCommand(['backup', 'demo', '--file', f.file, '--include-home'], f.io);
    delete f.volumes.get('hf-demo-code').Labels['herdr-factory-spike'];
    const before = f.calls.length;
    await assert.rejects(factoryCommand(['destroy', 'demo'], f.io), /label|owner/i);
    assert.equal(f.calls.slice(before).some(({ args }) => args[0] === 'stop' || args[1] === 'rm'), false);
  } finally { f.cleanup(); }
});

test('backup refuses repositories, cloud folders and symlink aliases without Docker work', async () => {
  const f = fixture();
  try {
    const repository = path.join(f.root, 'repo'); fs.mkdirSync(repository); fs.writeFileSync(path.join(repository, '.git'), 'fixture');
    const cloud = path.join(f.env.HOME, 'Library', 'CloudStorage', 'example'); fs.mkdirSync(cloud, { recursive: true });
    const alias = path.join(f.root, 'alias'); fs.symlinkSync(repository, alias);
    for (const dir of [repository, cloud, alias]) await assert.rejects(factoryCommand(['backup', 'demo', '--file', path.join(dir, 'backup.hfb'), '--include-home'], f.io), /repository|cloud/i);
    assert.equal(f.calls.length, 0);
  } finally { f.cleanup(); }
});

test('shell, logs, stop now and freeze use Docker only with a dead service and an old version', async () => {
  const f = fixture();
  try {
    const fleetFile = path.join(f.env.HERDR_FACTORIES_DIR, 'fleet.json');
    const fleet = JSON.parse(fs.readFileSync(fleetFile)); fleet.minimumFactoryVersion = '9.0.0'; fs.writeFileSync(fleetFile, JSON.stringify(fleet));
    assert.equal(await factoryCommand(['shell', 'demo', '--', 'printf', 'repair'], f.io), 0);
    assert.equal(await factoryCommand(['logs', 'demo'], f.io), 0);
    assert.equal(await factoryCommand(['freeze', 'demo'], f.io), 0);
    assert.equal(f.container.State.Paused, true);
    assert.equal(await factoryCommand(['freeze', 'demo', '--off'], f.io), 0);
    assert.equal(await factoryCommand(['stop', 'demo', '--now'], f.io), 0);
    assert.equal(f.container.State.Running, false);
    assert.equal(f.calls.some(({ args }) => args.includes('curl')), false);
    assert.equal(f.output.join('').includes('invented-private-value'), false);
    assert.equal(f.output.join('').includes('192.0.2.1'), false);
  } finally { f.cleanup(); }
});

test('backup metadata accepts a stable 44-character identity and carries no host connection fields', async () => {
  const f = fixture(true);
  try {
    const file = path.join(f.env.HERDR_FACTORIES_DIR, 'fleet.json');
    const fleet = JSON.parse(fs.readFileSync(file));
    fleet.factories[0].factoryId = 'factory-00000000-0000-4000-8000-000000000000';
    fs.writeFileSync(file, JSON.stringify(fleet));
    await factoryCommand(['backup', 'demo', '--file', f.file], f.io);
    const { readBackup } = await import('../src/factory-archive.js');
    const manifest = await readBackup(f.file);
    const { validateFile } = await import('./factory/schema-check.js');
    assert.deepEqual(validateFile(manifest, new URL('../docs/contracts/schema/factory-backup.v1.schema.json', import.meta.url).pathname), []);
    assert.equal(manifest.factoryId, fleet.factories[0].factoryId);
    for (const key of ['address', 'keyFile', 'hostId', 'dockerContext', 'connectionRef']) assert.equal(Object.hasOwn(manifest, key), false);
    assert.deepEqual(manifest.volumes, ['data', 'work']);
  } finally { f.cleanup(); }
});

test('restore refuses a port conflict and an existing volume before creating resources', async () => {
  const f = fixture();
  try {
    await factoryCommand(['backup', 'demo', '--file', f.file, '--include-home'], f.io);
    await factoryCommand(['destroy', 'demo'], f.io);
    const fleetFile = path.join(f.env.HERDR_FACTORIES_DIR, 'fleet.json');
    const fleet = JSON.parse(fs.readFileSync(fleetFile));
    fleet.factories.push({ factoryId: 'other', name: 'other', hostId: 'local', profile: 'personal', dashboardUrl: 'http://other.localhost:4478', version: health.version, kitRevision: health.kitRevision, kind: 'container', containerName: 'hf-other', ports: { dashboard: 4478, ssh: 3333 }, image: { builtAt: '2026-10-03T00:00:00Z', pinsHash: 'a'.repeat(64) } });
    fs.writeFileSync(fleetFile, JSON.stringify(fleet));
    f.io.stdin = Object.assign(Readable.from(['demo\n']), { isTTY: true });
    const before = f.calls.length;
    await assert.rejects(factoryCommand(['restore', f.file], f.io), /port/i);
    assert.equal(f.calls.slice(before).some(({ args }) => args[1] === 'create'), false);
    assert.equal(fs.existsSync(path.join(f.env.HERDR_FACTORIES_DIR, 'demo', 'factory.json')), false);
    fleet.factories = []; fs.writeFileSync(fleetFile, JSON.stringify(fleet));
    f.volumes.set('hf-demo-work', { Name: 'hf-demo-work', Labels: {} });
    f.io.stdin = Object.assign(Readable.from(['demo\n']), { isTTY: true });
    await assert.rejects(factoryCommand(['restore', f.file], f.io), /volume/i);
  } finally { f.cleanup(); }
});

test('a failed backup resumes the running factory and retains no successful receipt or partial file', async () => {
  const f = fixture();
  try {
    const run = f.docker.run.bind(f.docker);
    f.docker.run = async (args, options) => args[0] === 'run' ? { code: 1, stdout: '', stderr: 'access_token=invented-private-value 192.0.2.1' } : run(args, options);
    await assert.rejects(factoryCommand(['backup', 'demo', '--file', f.file, '--include-home'], f.io), /Docker operation failed/);
    assert.equal(f.container.State.Running, true);
    assert.equal(fs.existsSync(path.join(f.env.HERDR_FACTORIES_DIR, 'demo', 'backup.json')), false);
    assert.equal(fs.existsSync(f.file), false);
    assert.deepEqual(fs.readdirSync(path.dirname(f.file)), []);
    assert.equal(f.output.join('').includes('invented-private-value'), false);
  } finally { f.cleanup(); }
});

test('backup refuses a shared destination folder without changing its permissions', async () => {
  const f = fixture();
  try {
    const shared = path.join(f.root, 'shared'); fs.mkdirSync(shared, { mode: 0o755 });
    await assert.rejects(factoryCommand(['backup', 'demo', '--file', path.join(shared, 'backup.hfb')], f.io), /private|700/i);
    assert.equal(fs.statSync(shared).mode & 0o777, 0o755);
    assert.equal(f.calls.length, 0);
  } finally { f.cleanup(); }
});

test('archive validation refuses traversal, link parents, duplicates and truncated payloads before restore mutates Docker', async () => {
  const f = fixture();
  try {
    await factoryCommand(['backup', 'demo', '--file', f.file, '--include-home'], f.io);
    const { gunzipSync, gzipSync } = await import('node:zlib');
    const raw = gunzipSync(fs.readFileSync(f.file));
    const firstCut = raw.indexOf(10) + 1;
    const manifestLine = raw.subarray(0, firstCut).toString();
    const header = (entry) => JSON.stringify(entry) + '\n';
    for (const entries of [
      [{ type: 'directory', path: 'data', mode: 448 }, { type: 'file', path: 'data/../escape', mode: 384, size: 0 }],
      [{ type: 'directory', path: 'data', mode: 448 }, { type: 'link', path: 'data/link', mode: 511, target: '/example.invalid' }, { type: 'file', path: 'data/link/escape', mode: 384, size: 0 }],
      [{ type: 'directory', path: 'data', mode: 448 }, { type: 'directory', path: 'data', mode: 448 }],
      [{ type: 'directory', path: 'data', mode: 448 }, { type: 'file', path: 'data/file', mode: 384, size: 1000 }],
    ]) {
      const malformed = path.join(path.dirname(f.file), 'bad.hfb');
      fs.writeFileSync(malformed, gzipSync(manifestLine + entries.map(header).join('') + header({ type: 'end' })), { mode: 0o600 });
      const before = f.calls.length;
      await assert.rejects(factoryCommand(['restore', malformed], f.io), /backup/i);
      assert.equal(f.calls.length, before);
    }
  } finally { f.cleanup(); }
});

test('the Docker transport streams binary backup files in both directions without text capture', async () => {
  const f = fixture();
  try {
    const { createDockerTransport } = await import('../src/factory-transport.js');
    const { spawn } = await import('node:child_process');
    const input = path.join(f.root, 'input.bin'), output = path.join(f.root, 'output.bin');
    const bytes = Buffer.from([0, 255, 128, 10, 0]); fs.writeFileSync(input, bytes);
    let selected;
    const transport = createDockerTransport({ transport: 'docker-context', dockerContext: 'example-context' }, { env: f.env, spawn: (program, args, options) => {
      assert.equal(program, 'docker'); selected = args;
      return spawn(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], options);
    } });
    const result = await transport.run(['run', '--interactive', 'example-factory:test'], { inputFile: input, outputFile: output });
    assert.equal(result.code, 0); assert.equal(result.stdout, '');
    assert.deepEqual(fs.readFileSync(output), bytes);
    assert.deepEqual(selected.slice(0, 2), ['--context', 'example-context']);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  } finally { f.cleanup(); }
});

test('a failed restore removes only the new labeled resources and permits a retry', async () => {
  const f = fixture();
  try {
    await factoryCommand(['backup', 'demo', '--file', f.file, '--include-home'], f.io);
    await factoryCommand(['destroy', 'demo'], f.io);
    const run = f.docker.run.bind(f.docker);
    let failOnce = true;
    f.docker.run = async (args, options) => {
      if (args[0] === 'run' && args.includes('restore') && failOnce) { failOnce = false; return { code: 1, stdout: '', stderr: 'restore failed' }; }
      return run(args, options);
    };
    f.io.stdin = Object.assign(Readable.from(['demo\n']), { isTTY: true });
    await assert.rejects(factoryCommand(['restore', f.file], f.io), /restore|Docker/i);
    assert.equal(f.volumes.size, 0);
    assert.equal(fs.existsSync(path.join(f.env.HERDR_FACTORIES_DIR, 'demo', 'factory.json')), false);
    f.io.stdin = Object.assign(Readable.from(['demo\n']), { isTTY: true });
    assert.equal(await factoryCommand(['restore', f.file], f.io), 0);
  } finally { f.cleanup(); }
});

test('destroy refuses a wrong factory identity and never removes an unrelated resource', async () => {
  const f = fixture();
  try {
    await factoryCommand(['backup', 'demo', '--file', f.file, '--include-home'], f.io);
    const fleetFile = path.join(f.env.HERDR_FACTORIES_DIR, 'fleet.json');
    const fleet = JSON.parse(fs.readFileSync(fleetFile)); fleet.factories[0].factoryId = 'other'; fs.writeFileSync(fleetFile, JSON.stringify(fleet));
    const before = f.calls.length;
    await assert.rejects(factoryCommand(['destroy', 'demo'], f.io), /another factory/i);
    assert.equal(f.calls.slice(before).some(({ args }) => args[0] === 'stop' || args[1] === 'rm'), false);
  } finally { f.cleanup(); }
});

test('SQLite backup uses VACUUM INTO and removes free pages without the WAL sidecars', async () => {
  const f = fixture();
  try {
    const db = new DatabaseSync(path.join(f.volumePaths.data, 'herdr-boss.db'));
    db.exec('CREATE TABLE waste(value BLOB); INSERT INTO waste VALUES(zeroblob(200000)); DELETE FROM waste');
    assert.ok(db.prepare('PRAGMA freelist_count').get().freelist_count > 0); db.close();
    await factoryCommand(['backup', 'demo', '--file', f.file, '--include-home'], f.io);
    await factoryCommand(['destroy', 'demo'], f.io);
    f.io.stdin = Object.assign(Readable.from(['demo\n']), { isTTY: true });
    await factoryCommand(['restore', f.file], f.io);
    const restored = new DatabaseSync(path.join(f.volumePaths.data, 'herdr-boss.db'));
    assert.equal(restored.prepare('PRAGMA freelist_count').get().freelist_count, 0); restored.close();
    assert.equal(fs.existsSync(path.join(f.volumePaths.data, 'herdr-boss.db-wal')), false);
  } finally { f.cleanup(); }
});

test('backup retains ordinary files whose names resemble SQLite journal sidecars', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.volumePaths.data, 'notes'), 'plain data');
    fs.writeFileSync(path.join(f.volumePaths.data, 'notes-journal'), 'keep this journal');
    await factoryCommand(['backup', 'demo', '--file', f.file, '--include-home'], f.io);
    await factoryCommand(['destroy', 'demo'], f.io);
    f.io.stdin = Object.assign(Readable.from(['demo\n']), { isTTY: true });
    await factoryCommand(['restore', f.file], f.io);
    assert.equal(fs.readFileSync(path.join(f.volumePaths.data, 'notes-journal'), 'utf8'), 'keep this journal');
  } finally { f.cleanup(); }
});

test('stop now releases a frozen container before its immediate stop without a health request', async () => {
  const f = fixture();
  try {
    f.container.State.Paused = true;
    const run = f.docker.run.bind(f.docker);
    f.docker.run = async (args, options) => args[0] === 'stop' && f.container.State.Paused ? { code: 1, stdout: '', stderr: 'container is paused' } : run(args, options);
    assert.equal(await factoryCommand(['stop', 'demo', '--now'], f.io), 0);
    assert.equal(f.container.State.Running, false);
    assert.deepEqual(f.calls.filter(({ args }) => ['unpause', 'stop'].includes(args[0])).map(({ args }) => args), [['unpause', 'hf-demo'], ['stop', '--time', '0', 'hf-demo']]);
    assert.equal(f.calls.some(({ args }) => args.includes('curl')), false);
  } finally { f.cleanup(); }
});

test('backup includes committed WAL rows and preserves work links and executable modes', async () => {
  const f = fixture();
  let db;
  try {
    db = new DatabaseSync(path.join(f.volumePaths.data, 'herdr-boss.db'));
    db.exec('PRAGMA journal_mode=WAL; INSERT INTO sample VALUES (\'wal-kept\')');
    fs.writeFileSync(path.join(f.volumePaths.work, 'run.sh'), 'echo fixture\n', { mode: 0o750 });
    fs.symlinkSync('run.sh', path.join(f.volumePaths.work, 'run-link'));
    await factoryCommand(['backup', 'demo', '--file', f.file, '--include-home'], f.io);
    db.close(); db = null;
    await factoryCommand(['destroy', 'demo'], f.io);
    f.io.stdin = Object.assign(Readable.from(['demo\n']), { isTTY: true });
    await factoryCommand(['restore', f.file], f.io);
    const restored = new DatabaseSync(path.join(f.volumePaths.data, 'herdr-boss.db'));
    assert.deepEqual(restored.prepare('SELECT value FROM sample ORDER BY rowid').all().map((row) => row.value), ['kept', 'wal-kept']); restored.close();
    assert.equal(fs.readlinkSync(path.join(f.volumePaths.work, 'run-link')), 'run.sh');
    assert.equal(fs.statSync(path.join(f.volumePaths.work, 'run.sh')).mode & 0o777, 0o750);
    assert.equal(fs.existsSync(path.join(f.volumePaths.data, 'herdr-boss.db-wal')), false);
  } finally { db?.close(); f.cleanup(); }
});

for (const state of ['stopped', 'paused']) test(`backup retains the source ${state} state`, async () => {
  const f = fixture();
  try {
    f.container.State.Running = state !== 'stopped';
    f.container.State.Paused = state === 'paused';
    await factoryCommand(['backup', 'demo', '--file', f.file, '--include-home'], f.io);
    assert.equal(f.container.State.Running, state !== 'stopped');
    assert.equal(f.container.State.Paused, state === 'paused');
    if (state === 'stopped') assert.equal(f.calls.some(({ args }) => args[0] === 'start' || args[0] === 'stop'), false);
  } finally { f.cleanup(); }
});

test('destroy resumes after a volume removal failure and checks all remaining labels first', async () => {
  const f = fixture();
  try {
    await factoryCommand(['backup', 'demo', '--file', f.file, '--include-home'], f.io);
    const run = f.docker.run.bind(f.docker);
    let failOnce = true;
    f.docker.run = async (args, options) => {
      if (args[0] === 'volume' && args[1] === 'rm' && args[2] === 'hf-demo-data' && failOnce) { failOnce = false; return { code: 1, stdout: '', stderr: 'temporary failure' }; }
      return run(args, options);
    };
    await assert.rejects(factoryCommand(['destroy', 'demo'], f.io), /Docker/);
    assert.equal(f.container, null);
    f.io.stdin = Object.assign(Readable.from(['demo\n']), { isTTY: true });
    assert.equal(await factoryCommand(['destroy', 'demo'], f.io), 0);
    assert.equal(f.volumes.size, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.env.HERDR_FACTORIES_DIR, 'fleet.json'))).factories, []);
  } finally { f.cleanup(); }
});

test('fix round 1: destroy refuses a backup without home and names --include-home before Docker work', async () => {
  const f = fixture();
  try {
    await factoryCommand(['backup', 'demo', '--file', f.file], f.io);
    const before = f.calls.length;
    await assert.rejects(factoryCommand(['destroy', 'demo'], f.io), /back up.*--include-home/i);
    assert.equal(f.calls.length, before);
    assert.equal(f.container.State.Running, true);
    assert.equal(f.volumes.size, 4);
    assert.equal(fs.readFileSync(path.join(f.volumePaths.home, 'login.fixture'), 'utf8'), 'invented-private-value');
  } finally { f.cleanup(); }
});

for (const kind of ['volume', 'container']) for (const cause of ['throw', 'timeout']) test(`fix round 2: rollback finds ${kind} created before a ${cause} reply`, async () => {
  const f = fixture();
  try {
    await factoryCommand(['backup', 'demo', '--file', f.file, '--include-home'], f.io);
    await factoryCommand(['destroy', 'demo'], f.io);
    const unrelated = { Name: 'hf-other-data', Labels: { 'herdr-factory': 'other', 'herdr-factory-spike': 'ft14' } };
    f.volumes.set(unrelated.Name, unrelated);
    const run = f.docker.run.bind(f.docker);
    let fault = true;
    f.docker.run = async (args, options) => {
      const result = await run(args, options);
      if (fault && args[0] === kind && args[1] === 'create') {
        fault = false;
        const error = new Error('lost create reply at example.invalid');
        if (cause === 'timeout') error.code = 'ETIMEDOUT';
        throw error;
      }
      return result;
    };
    const before = f.calls.length;
    f.io.stdin = Object.assign(Readable.from(['demo\n']), { isTTY: true });
    await assert.rejects(factoryCommand(['restore', f.file], f.io), /Docker transport failed|host is unreachable/);
    assert.equal(f.container, null);
    assert.deepEqual([...f.volumes.keys()], [unrelated.Name]);
    assert.equal(fs.existsSync(path.join(f.env.HERDR_FACTORIES_DIR, 'demo', 'factory.json')), false);
    const after = f.calls.slice(before);
    const failureIndex = after.findIndex(({ args }) => args[0] === kind && args[1] === 'create');
    const rollback = after.slice(failureIndex + 1);
    for (const volumeKind of Object.keys(VOLUMES)) assert.ok(rollback.some(({ args }) => args[0] === 'volume' && args[1] === 'inspect' && args[2] === `hf-demo-${volumeKind}`));
    assert.ok(rollback.some(({ args }) => args[0] === 'container' && args[1] === 'inspect' && args[2] === 'hf-demo'));
    assert.equal(after.some(({ args }) => args[1] === 'rm' && args.includes(unrelated.Name)), false);
  } finally { f.cleanup(); }
});

test('fix round 2: ambiguous cleanup preserves differently labeled resources with the target prefix', async () => {
  const f = fixture();
  try {
    await factoryCommand(['backup', 'demo', '--file', f.file, '--include-home'], f.io);
    await factoryCommand(['destroy', 'demo'], f.io);
    const run = f.docker.run.bind(f.docker);
    let fault = true;
    f.docker.run = async (args, options) => {
      const result = await run(args, options);
      if (fault && args[0] === 'volume' && args[1] === 'create') {
        fault = false;
        f.volumes.set('hf-demo-code', { Name: 'hf-demo-code', Labels: { 'herdr-factory': 'other', 'herdr-factory-spike': 'ft14' } });
        f.volumes.set('hf-demo-data', { Name: 'hf-demo-data', Labels: { 'herdr-factory': 'demo', 'herdr-factory-spike': 'other-worker' } });
        throw new Error('lost volume create reply');
      }
      return result;
    };
    const before = f.calls.length;
    f.io.stdin = Object.assign(Readable.from(['demo\n']), { isTTY: true });
    await assert.rejects(factoryCommand(['restore', f.file], f.io), /cleanup|Docker/i);
    assert.equal(f.volumes.has('hf-demo-home'), false);
    assert.equal(f.volumes.has('hf-demo-code'), true);
    assert.equal(f.volumes.has('hf-demo-data'), true);
    assert.equal(f.calls.slice(before).some(({ args }) => args[1] === 'rm' && ['hf-demo-code', 'hf-demo-data'].includes(args.at(-1))), false);
    assert.equal(fs.existsSync(path.join(f.env.HERDR_FACTORIES_DIR, 'demo', 'factory.json')), true);
  } finally { f.cleanup(); }
});

for (const action of ['backup', 'restore']) test(`fix round 3: remove only the timed-out ${action} helper before source restart or volume rollback`, async () => {
  const f = fixture();
  try {
    if (action === 'restore') {
      await factoryCommand(['backup', 'demo', '--file', f.file, '--include-home'], f.io);
      await factoryCommand(['destroy', 'demo'], f.io);
      f.io.stdin = Object.assign(Readable.from(['demo\n']), { isTTY: true });
    }
    const sibling = `hf-demo-${action}-other-helper`;
    f.helpers.set(sibling, { Config: { Labels: { ...labels } }, State: { Running: true } });
    const run = f.docker.run.bind(f.docker);
    let helperName;
    f.docker.run = async (args, options) => {
      const result = await run(args, options);
      if (args[0] === 'run' && args.includes(action)) {
        helperName = args[args.indexOf('--name') + 1];
        f.helpers.set(helperName, { Config: { Labels: { ...labels } }, State: { Running: true } });
        throw Object.assign(new Error('Docker timeout'), { code: 'ETIMEDOUT' });
      }
      return result;
    };
    const before = f.calls.length;
    await assert.rejects(factoryCommand(action === 'backup' ? ['backup', 'demo', '--file', f.file, '--include-home'] : ['restore', f.file], f.io), /Docker transport failed|host is unreachable/);
    assert.equal(f.helpers.has(helperName), false);
    assert.equal(f.helpers.has(sibling), true);
    const after = f.calls.slice(before);
    const helperRemoval = after.findIndex(({ args }) => args[0] === 'container' && args[1] === 'rm' && args.at(-1) === helperName);
    assert.ok(helperRemoval >= 0);
    assert.ok(after.slice(0, helperRemoval).some(({ args }) => args[0] === 'container' && args[1] === 'inspect' && args[2] === helperName));
    if (action === 'backup') {
      assert.equal(f.container.State.Running, true);
      assert.ok(after.findIndex(({ args }) => args[0] === 'start') > helperRemoval);
    } else {
      assert.equal(f.volumes.size, 0);
      assert.ok(after.filter(({ args }) => args[0] === 'volume' && args[1] === 'rm').length === 4);
      assert.ok(after.findIndex(({ args }) => args[0] === 'volume' && args[1] === 'rm') > helperRemoval);
    }
    assert.equal(after.some(({ args }) => args[1] === 'rm' && args.at(-1) === sibling), false);
  } finally { f.cleanup(); }
});

for (const action of ['backup', 'restore']) test(`fix round 3: a changed helper label stops ${action} cleanup and keeps its volumes inactive`, async () => {
  const f = fixture();
  try {
    if (action === 'restore') {
      await factoryCommand(['backup', 'demo', '--file', f.file, '--include-home'], f.io);
      await factoryCommand(['destroy', 'demo'], f.io);
      f.io.stdin = Object.assign(Readable.from(['demo\n']), { isTTY: true });
    }
    const run = f.docker.run.bind(f.docker);
    let helperName;
    f.docker.run = async (args, options) => {
      const result = await run(args, options);
      if (args[0] === 'run' && args.includes(action)) {
        helperName = args[args.indexOf('--name') + 1];
        f.helpers.set(helperName, { Config: { Labels: { 'herdr-factory': 'demo', 'herdr-factory-spike': 'other-worker' } }, State: { Running: true } });
        throw new Error('lost helper reply');
      }
      return result;
    };
    const before = f.calls.length;
    await assert.rejects(factoryCommand(action === 'backup' ? ['backup', 'demo', '--file', f.file, '--include-home'] : ['restore', f.file], f.io), /helper.*cleanup|cleanup.*helper/i);
    assert.equal(f.helpers.has(helperName), true);
    assert.equal(f.volumes.size, 4);
    const after = f.calls.slice(before);
    assert.equal(after.some(({ args }) => args[1] === 'rm' || args[0] === 'start'), false);
    if (action === 'backup') assert.equal(f.container.State.Running, false);
    else assert.equal(fs.existsSync(path.join(f.env.HERDR_FACTORIES_DIR, 'demo', 'factory.json')), true);
  } finally { f.cleanup(); }
});

test('fix round 4: restore explains that the existing container uses the name stored in the backup', async () => {
  const f = fixture();
  try {
    await factoryCommand(['backup', 'demo', '--file', f.file, '--include-home'], f.io);
    await factoryCommand(['destroy', 'demo'], f.io);
    const run = f.docker.run.bind(f.docker);
    f.docker.run = async (args, options) => args[0] === 'container' && args[1] === 'inspect' && args[2] === 'hf-demo' ? { code: 0, stdout: JSON.stringify([{ Config: { Labels: { ...labels } } }]), stderr: '' } : run(args, options);
    f.io.stdin = Object.assign(Readable.from(['demo\n']), { isTTY: true });
    await assert.rejects(factoryCommand(['restore', f.file], f.io), { message: 'Restore refuses an existing container for the factory name stored in the backup.' });
  } finally { f.cleanup(); }
});

test('fix round 5: backup and restore helpers explicitly run as root', async () => {
  const f = fixture();
  try {
    await factoryCommand(['backup', 'demo', '--file', f.file, '--include-home'], f.io);
    await factoryCommand(['destroy', 'demo'], f.io);
    f.io.stdin = Object.assign(Readable.from(['demo\n']), { isTTY: true });
    await factoryCommand(['restore', f.file], f.io);
    const helpers = f.calls.filter(({ args }) => args[0] === 'run');
    assert.equal(helpers.length, 2);
    for (const { args } of helpers) { assert.ok(args.includes('--user')); assert.equal(args[args.indexOf('--user') + 1], '0:0'); }
  } finally { f.cleanup(); }
});

test('fix round 6: factory recovery help presents backup, restore, destroy and repair in separate short paragraphs', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const help = app.slice(app.indexOf('<h3>Factory hosts</h3>'), app.indexOf('<h3>Harness readiness</h3>'));
  const paragraphs = [...help.matchAll(/<p>(.*?)<\/p>/gs)].map((match) => match[1].replace(/<[^>]+>/g, ''));
  assert.ok(paragraphs.length >= 4);
  for (const paragraph of paragraphs) assert.ok(paragraph.trim().split(/\s+/).length <= 95, 'Keep each help paragraph short enough to scan.');
  for (const command of ['factory backup NAME', 'factory restore FILE', 'factory destroy NAME', 'factory shell NAME']) {
    const paragraph = paragraphs.find((value) => value.includes(command));
    assert.ok(paragraph, `Explain ${command}`);
    for (const other of ['factory backup NAME', 'factory restore FILE', 'factory destroy NAME', 'factory shell NAME'].filter((value) => value !== command)) assert.equal(paragraph.includes(other), false);
  }
});
