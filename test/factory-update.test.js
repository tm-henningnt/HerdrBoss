import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { factoryCommand } from '../src/factory-host.js';
import { readFleet, writeFleet, writePrivate, VOLUMES } from '../src/factory-store.js';
import { assertPollerRegistry } from './helpers/factory-registry.js';

const labels = { 'herdr-factory': 'demo', 'herdr-factory-spike': 'ft15' };
const image = { Id: 'sha256:tag-image', Config: { Labels: {
  'org.opencontainers.image.created': '2026-10-03T00:00:00Z',
  'org.herdr-boss.pins-sha256': 'b'.repeat(64),
} } };

function fixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'factory-update-'));
  const env = {
    HOME: path.join(root, 'home'),
    HERDR_BOSS_DIR: path.join(root, 'boss'),
    HERDR_FACTORIES_DIR: path.join(root, 'factories'),
    TMPDIR: root,
  };
  fs.mkdirSync(env.HOME);
  const volumes = new Map(Object.keys(VOLUMES).map((kind) => [`hf-demo-${kind}`, { Name: `hf-demo-${kind}`, Labels: { ...labels } }]));
  const container = {
    Id: 'demo-id', Image: 'sha256:running-image', Config: { Labels: { ...labels } },
    HostConfig: { Privileged: false, CapAdd: null, SecurityOpt: ['seccomp=example-profile', 'systempaths=unconfined'] },
    Mounts: Object.entries(VOLUMES).map(([kind, target]) => ({ Type: 'volume', Name: `hf-demo-${kind}`, Destination: target })),
    State: { Running: true, Status: 'running' },
  };
  writeFleet(env, {
    schema: 1, contractVersion: '1.0.0', minimumFactoryVersion: '0.1.0',
    hosts: [{ hostId: 'local', runtime: 'orbstack', personalOnly: true, codexSandbox: 'user-namespaces', transport: 'local' }],
    factories: [{ factoryId: 'demo', name: 'demo', hostId: 'local', profile: 'personal', dashboardUrl: 'http://demo.localhost:4478', version: '0.1.0', kitRevision: 'abcdef012345', kind: 'container', containerName: 'hf-demo', hostname: 'demo.localhost', ports: { dashboard: 4478, ssh: 2222 }, image: { builtAt: image.Config.Labels['org.opencontainers.image.created'], pinsHash: 'a'.repeat(64) } }],
  });
  writePrivate(path.join(env.HERDR_FACTORIES_DIR, 'demo', 'factory.json'), { schema: 1, name: 'demo', hostId: 'local', profile: 'personal', imageTag: 'example-factory:test', ports: { dashboard: 4478, ssh: 2222 }, stage: 'ready' });
  const calls = [];
  const output = [];
  let factoryState = { updatedAt: new Date().toISOString(), workers: 0, locks: [], handoffs: [], errors: [], orchestrators: [], bossPane: false };
  const ok = (value = '') => ({ code: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
  const missing = () => ({ code: 1, stdout: '', stderr: 'No such object' });
  const docker = { async run(args, options = {}) {
    calls.push({ args, options });
    if (args[0] === 'container' && args[1] === 'inspect') return args[2] === 'hf-demo' ? ok([container]) : missing();
    if (args[0] === 'volume' && args[1] === 'inspect') return volumes.has(args[2]) ? ok([volumes.get(args[2])]) : missing();
    if (args[0] === 'image' && args[1] === 'inspect') return ok([image]);
    if (args[0] === 'exec' && args.includes('herdr') && args.includes('get')) return ok({ result: { pane: { pane_id: 'pane:1', workspace_id: 'workspace:1', label: 'orch', cwd: '/home/factory/work/project' } } });
    if (args[0] === 'exec' && args.includes('node') && String(args.at(-1)).includes('/api/state')) return ok({ commit: 'ccccccc' });
    if (args[0] === 'exec' && args.includes('git') && args.includes('rev-parse')) return ok('a'.repeat(40));
    if (args[0] === 'exec' && args.includes('node')) return ok(factoryState);
    return ok();
  } };
  const io = { env, isContainer: () => false, transportFactory: () => docker,
    stdout: { write: (value) => output.push(value) }, stderr: { write: (value) => output.push(value) } };
  return { root, env, io, calls, output, container, volumes, get state() { return factoryState; }, set state(value) { factoryState = value; }, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function updateFixture() {
  const f = fixture();
  const supervisorBin = path.join(f.root, 'supervisor-bin');
  const supervisorLog = path.join(f.root, 's6.jsonl');
  fs.mkdirSync(supervisorBin);
  for (const command of ['s6-svc', 's6-svstat']) {
    const body = command === 's6-svc'
      ? '#!/bin/sh\nprintf \'s6-svc\\t%s\\n\' \"$*\" >> \"$S6_LOG\"\nif [ \"$S6_FAIL_START\" = 1 ] && [ \"$1\" = -u ]; then exit 1; fi\n'
      : '#!/bin/sh\nprintf \'s6-svstat\\t%s\\n\' \"$*\" >> \"$S6_LOG\"\nprintf \'%s\' \"$S6_UP\"\n';
    const file = path.join(supervisorBin, command);
    fs.writeFileSync(file, body, { mode: 0o755 });
    fs.chmodSync(file, 0o755);
  }
  const volumePaths = Object.fromEntries(Object.keys(VOLUMES).map((kind) => [kind, path.join(f.root, `volume-${kind}`)]));
  for (const dir of Object.values(volumePaths)) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(volumePaths.home, 'login.fixture'), 'invented-login');
  fs.writeFileSync(path.join(volumePaths.work, 'work.fixture'), 'invented-work');
  const db = new DatabaseSync(path.join(volumePaths.data, 'herdr-boss.db'));
  db.exec('CREATE TABLE schema_version(version INTEGER); INSERT INTO schema_version VALUES (1);'); db.close();
  const helpers = new Map();
  const originalId = f.container.Id;
  let container = f.container;
  container.Config.Image = 'example-factory:test';
  let serviceUp = true;
  let tickAt = Date.now() - 10_000;
  let imagePresent = true;
  const oldCommit = 'a'.repeat(40), newCommit = 'b'.repeat(40);
  let currentCommit = oldCommit, schema = 1, failUpdated = false, migrateOnUpdate = false, failNewImageCreate = false, failNewImageStart = false, failSchemaReadAfterStart = false, schemaUnreadableAfterStart = false;
  const expectedOrigin = 'https://example.invalid/org/herdr-boss.git';
  let remoteUrl = expectedOrigin, failFetch = false, failMerge = false, failGitReset = false, failServiceStart = false, failPause = false, failBackupRun = false, failHelperRemove = false, failHealth = false;
  let transportFault = () => false;
  let helperReply = null;
  const dirty = new Set();
  const git = {};
  let snapshotCount = 0, mutateSnapshotNumber = 0, snapshotMutation = null, failNextSnapshots = 0, failSnapshotAfterMerge = 0;
  const ok = (value = '') => ({ code: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
  const missing = () => ({ code: 1, stdout: '', stderr: 'No such object' });
  const docker = { async run(args, options = {}) {
    f.calls.push({ args, options });
    if (transportFault(args)) throw Object.assign(new Error('The factory host is unreachable.'), { code: 'FACTORY_HOST_UNREACHABLE' });
    if (args[0] === 'container' && args[1] === 'inspect') {
      const found = args[2] === 'hf-demo' ? container : helpers.get(args[2]);
      return found ? ok([found]) : missing();
    }
    if (args[0] === 'volume' && args[1] === 'inspect') return f.volumes.has(args[2]) ? ok([f.volumes.get(args[2])]) : missing();
    if (args[0] === 'image' && args[1] === 'inspect') return imagePresent ? ok([image]) : missing();
    if (args[0] === 'exec' && args.includes('claude-helper')) { if (helperReply instanceof Error) throw helperReply; return helperReply || ok('installed\n'); }
    if (args[0] === 'exec' && args.includes('herdr') && args.includes('get')) return ok({ result: { pane: { pane_id: 'pane:1', workspace_id: 'workspace:1', label: 'orch', cwd: '/home/factory/work/project' } } });
    if (args[0] === 'exec' && args.includes('node')) {
      if (String(args.at(-1)).includes('/api/state')) return ok({ commit: 'ccccccc', commitDate: '2026-10-10', kitRevision: 'abcdef012345', startedAt: new Date(tickAt).toISOString() });
      if (String(args.at(-1)).includes('schema_version')) {
        if (!container) return missing();
        if (container.Config.Image !== 'example-factory:test' && !container.State.Running) return missing();
        if (schemaUnreadableAfterStart && container.Config.Image !== 'example-factory:test') return { code: 1, stdout: '', stderr: 'simulated schema read failure' };
        return ok(`${schema}\n`);
      }
      snapshotCount += 1;
      if (snapshotCount === mutateSnapshotNumber && snapshotMutation) f.state = { ...f.state, ...snapshotMutation, updatedAt: new Date().toISOString() };
      if (failNextSnapshots > 0) { failNextSnapshots -= 1; return { code: 1, stdout: '', stderr: 'simulated snapshot read failure' }; }
      return ok({ updatedAt: f.state?.updatedAt ?? new Date(tickAt).toISOString(), workers: f.state?.workers ?? 0, locks: f.state?.locks ?? [], handoffs: f.state?.handoffs ?? [], errors: f.state?.errors ?? [], orchestrators: f.state?.orchestrators ?? [], bossPane: f.state?.bossPane ?? false });
    }
    if (args[0] === 'exec' && args.includes('/command/s6-svc')) {
      const commandIndex = args.indexOf('/command/s6-svc');
      const fakeS6 = spawnSync('s6-svc', args.slice(commandIndex + 1), { env: {
        PATH: `${supervisorBin}${path.delimiter}${path.dirname(process.execPath)}:/usr/bin:/bin`,
        S6_LOG: supervisorLog,
        S6_FAIL_START: failServiceStart && args.includes('-u') ? '1' : '0',
      }, encoding: 'utf8' });
      if (fakeS6.status !== 0) return { code: fakeS6.status || 1, stdout: '', stderr: 'simulated s6 service start failure' };
      serviceUp = args.includes('-u');
      if (serviceUp) { tickAt = Date.now(); f.state = { ...f.state, updatedAt: new Date(tickAt).toISOString() }; }
      return ok();
    }
    if (args[0] === 'exec' && args.includes('/command/s6-svstat')) {
      const commandIndex = args.indexOf('/command/s6-svstat');
      const fakeS6 = spawnSync('s6-svstat', args.slice(commandIndex + 1), { env: {
        PATH: `${supervisorBin}${path.delimiter}${path.dirname(process.execPath)}:/usr/bin:/bin`,
        S6_LOG: supervisorLog,
        S6_UP: serviceUp ? 'true' : 'false',
      }, encoding: 'utf8' });
      return { code: fakeS6.status || 0, stdout: fakeS6.stdout || '', stderr: fakeS6.stderr || '' };
    }
    if (args[0] === 'exec' && args.includes('git')) {
      if (args.includes('config') && args.includes('--global')) {
        const key = args.includes('--get') ? args.at(-1) : args.at(-2);
        if (args.includes('--get')) return key in git ? ok(`${git[key]}\n`) : { code: 1, stdout: '', stderr: '' };
        git[key] = args.at(-1); return ok();
      }
      if (args.includes('rev-parse')) return ok(currentCommit);
      if (args.includes('remote') && args.includes('get-url')) return remoteUrl ? ok(`${remoteUrl}\n`) : { code: 2, stdout: '', stderr: 'error: No such remote' };
      if (args.includes('remote') && args.includes('add')) { remoteUrl = args.at(-1); return ok(); }
      if (args.includes('fetch')) return failFetch ? { code: 128, stdout: '', stderr: 'fatal: unable to access https://user:secret@example.invalid/' } : ok();
      if (args.includes('merge-base')) return ok();
      if (args.includes('status')) return ok([...dirty].map((file) => ` M ${file}\n`).join(''));
      if (args.includes('checkout')) { for (const file of args.slice(args.indexOf('--') + 1)) dirty.delete(file); return ok(); }
      if (args.includes('merge') && dirty.size) return { code: 128, stdout: '', stderr: `error: Your local changes would be overwritten by merge: ${[...dirty].join(' ')}` };
      if (args.includes('merge') && failMerge) return { code: 128, stdout: '', stderr: 'fatal' };
      if (args.includes('merge')) { currentCommit = newCommit; if (migrateOnUpdate) schema = 2; if (failSnapshotAfterMerge > 0) failNextSnapshots = failSnapshotAfterMerge; return ok(); }
      if (args.includes('reset')) { if (failGitReset) return { code: 128, stdout: '', stderr: 'fatal: could not reset' }; currentCommit = oldCommit; return ok(); }
      return ok();
    }
    if (args[0] === 'exec' && args.includes('curl')) {
      const failed = failUpdated && (currentCommit === newCommit || container.Config.Image !== 'example-factory:test');
      if (String(args.at(-1)).endsWith('/api/state')) return ok(failed ? '503' : '200');
      if (failHealth) return { code: 22, stdout: '', stderr: 'simulated health failure' };
      return ok({ schema: 1, contractVersion: '1.0.0', version: '0.1.0', kitRevision: 'abcdef012345', herdrReachable: true, tickAgeSeconds: 1 });
    }
    if (args[0] === 'run' && failBackupRun && args.includes('backup')) return { code: 1, stdout: '', stderr: 'simulated backup failure' };
    if (args[0] === 'run') {
      const helperName = args[args.indexOf('--name') + 1];
      helpers.set(helperName, { Config: { Labels: { 'herdr-factory': 'demo', 'herdr-factory-spike': 'ft15' } } });
      const nodeIndex = args.indexOf('--input-type=module');
      const nodeArgs = args.slice(nodeIndex).map((word) => {
        let value = word;
        for (const [kind, dir] of Object.entries(volumePaths)) value = value.replaceAll(`/volumes/${kind}`, dir);
        return value;
      });
      const outputFd = options.outputFile ? fs.openSync(options.outputFile, 'wx', 0o600) : 'pipe';
      const inputFd = options.inputFile ? fs.openSync(options.inputFile, 'r') : 'pipe';
      try {
        if (args.includes('replace')) schema = 1;
        const result = spawnSync(process.execPath, nodeArgs, { env: { ...process.env, ...f.env }, stdio: [inputFd, outputFd, 'pipe'], encoding: options.outputFile ? undefined : 'utf8' });
        return { code: result.status, stdout: options.outputFile ? '' : result.stdout, stderr: result.stderr?.toString() || '' };
      } finally { if (typeof outputFd === 'number') fs.closeSync(outputFd); if (typeof inputFd === 'number') fs.closeSync(inputFd); }
    }
    if (args[0] === 'pause' && failPause) return { code: 1, stdout: '', stderr: 'simulated pause failure' };
    if (args[0] === 'container' && args[1] === 'rm' && args.includes('--force') && failHelperRemove) return { code: 1, stdout: '', stderr: 'simulated helper removal failure' };
    if (args[0] === 'pause' || args[0] === 'unpause') { container.State.Paused = args[0] === 'pause'; return ok(); }
    if (args[0] === 'stop') { container.State.Running = false; container.State.Status = 'exited'; return ok(); }
    if (args[0] === 'start') {
      if (container.Config.Image !== 'example-factory:test' && failNewImageStart) return { code: 1, stdout: '', stderr: 'simulated container start failure' };
      container.State.Running = true; container.State.Status = 'running'; container.State.StartedAt = new Date().toISOString(); serviceUp = true; tickAt = Date.now(); f.state = { ...f.state, updatedAt: new Date(tickAt).toISOString() }; if (failSchemaReadAfterStart && container.Config.Image !== 'example-factory:test') schemaUnreadableAfterStart = true; return ok();
    }
    if (args[0] === 'container' && args[1] === 'rm') { helpers.delete(args.at(-1)); if (args.at(-1) === 'hf-demo') container = null; return ok(); }
    if (args[0] === 'container' && args[1] === 'create') {
      const tag = args.at(-1);
      if (tag !== 'example-factory:test' && failNewImageCreate) return { code: 1, stdout: '', stderr: 'simulated image start failure' };
      if (tag !== 'example-factory:test' && migrateOnUpdate) schema = 2;
      container = { Id: `new-${tag}`, Config: { Image: tag, Labels: { ...labels } }, HostConfig: { Privileged: false, CapAdd: null, SecurityOpt: ['seccomp=example-profile', 'systempaths=unconfined'] }, Mounts: Object.entries(VOLUMES).map(([kind, target]) => ({ Type: 'volume', Name: `hf-demo-${kind}`, Destination: target })), State: { Running: false, Status: 'created' } };
      return ok();
    }
    return ok();
  } };
  f.io.transportFactory = () => docker;
  f.io.updateTimeoutMs = 500;
  f.io.originUrl = expectedOrigin;
  return { ...f, docker, expectedOrigin, s6Log: supervisorLog, set helperReply(value) { helperReply = value; }, get remoteUrl() { return remoteUrl; }, set remoteUrl(value) { remoteUrl = value; }, set failFetch(value) { failFetch = value; }, set failMerge(value) { failMerge = value; }, set failGitReset(value) { failGitReset = value; },
    set failServiceStart(value) { failServiceStart = value; }, set failPause(value) { failPause = value; }, set failBackupRun(value) { failBackupRun = value; }, set failHelperRemove(value) { failHelperRemove = value; }, set failHealth(value) { failHealth = value; }, set transportFault(value) { transportFault = value; }, volumePaths, dirty, git, originalId, oldCommit, newCommit, get state() { return f.state; }, set state(value) { f.state = value; }, set container(value) { container = value; }, get container() { return container; }, get serviceUp() { return serviceUp; }, set imagePresent(value) { imagePresent = value; }, set failUpdated(value) { failUpdated = value; }, set migrateOnUpdate(value) { migrateOnUpdate = value; }, set failNewImageCreate(value) { failNewImageCreate = value; }, set failNewImageStart(value) { failNewImageStart = value; }, set failSchemaReadAfterStart(value) { failSchemaReadAfterStart = value; }, set mutateSnapshotNumber(value) { mutateSnapshotNumber = value; }, set snapshotMutation(value) { snapshotMutation = value; }, set failSnapshotAfterMerge(value) { failSnapshotAfterMerge = value; }, cleanup: () => f.cleanup() };
}

test('factory status reports the running image ID, its tag image ID, and the Boss pane state', async () => {
  const f = fixture();
  try {
    assert.equal(await factoryCommand(['status', 'demo', '--json'], f.io), 0);
    let status = JSON.parse(f.output.join(''));
    assert.equal(status.containerImageId, 'sha256:running-image');
    assert.equal(status.tagImageId, 'sha256:tag-image');
    assert.equal(status.bossPane, false);
    assert.equal(status.commit, 'ccccccc');
    assert.equal(status.checkoutHead, 'aaaaaaa');

    f.output.length = 0;
    f.state = { ...f.state, bossPane: true };
    assert.equal(await factoryCommand(['status', 'demo', '--json'], f.io), 0);
    status = JSON.parse(f.output.join(''));
    assert.equal(status.bossPane, true);
  } finally { f.cleanup(); }
});

test('update dry run checks the factory and prints the selected tier without Docker writes', async () => {
  const f = fixture();
  try {
    assert.equal(await factoryCommand(['update', 'demo', '--tier', 'service', '--dry-run'], f.io), 0);
    assert.match(f.output.join(''), /would update factory demo.*service/i);
    assert.equal(f.calls.some(({ args }) => ['stop', 'pause', 'unpause', 'start'].includes(args[0]) || args[1] === 'rm' || args[1] === 'create'), false);
  } finally { f.cleanup(); }
});

for (const [label, state, message] of [
  ['working agents', { workers: 1 }, /worker is working/i],
  ['suite lock', { locks: [{ name: 'full-suite', kind: 'suite', state: 'live' }] }, /suite or push/i],
  ['push lock', { locks: [{ name: 'full-suite', kind: 'push', state: 'live' }] }, /suite or push/i],
  ['prepared handover', { handoffs: ['prepared'] }, /handover/i],
]) test(`update refuses ${label} before it changes Docker resources`, async () => {
  const f = fixture();
  try {
    f.state = { updatedAt: new Date().toISOString(), workers: 0, locks: [], handoffs: [], errors: [], orchestrators: [], bossPane: false, ...state };
    await assert.rejects(factoryCommand(['update', 'demo', '--tier', 'service'], f.io), message);
    assert.equal(f.calls.some(({ args }) => ['stop', 'pause', 'unpause', 'start'].includes(args[0]) || args[1] === 'rm' || args[1] === 'create'), false);
  } finally { f.cleanup(); }
});

test('update refuses unknown and stale work state before changing Docker resources', async () => {
  const f = fixture();
  try {
    f.state = { updatedAt: new Date(Date.now() - 180_000).toISOString(), workers: 0, locks: [], handoffs: [], errors: [], orchestrators: [], bossPane: false };
    await assert.rejects(factoryCommand(['update', 'demo', '--tier', 'service'], f.io), /cannot prove.*idle/i);
    f.state = { updatedAt: new Date().toISOString(), workers: null, locks: [], handoffs: [], errors: [], orchestrators: [], bossPane: false };
    await assert.rejects(factoryCommand(['update', 'demo', '--tier', 'service'], f.io), /cannot prove.*idle/i);
    assert.equal(f.calls.some(({ args }) => ['stop', 'pause', 'unpause', 'start'].includes(args[0]) || args[1] === 'rm' || args[1] === 'create'), false);
  } finally { f.cleanup(); }
});

test('update accepts a work snapshot up to one minute old and rejects an older one', async () => {
  const fresh = updateFixture();
  try {
    fresh.state = { ...fresh.state, updatedAt: new Date(Date.now() - 40_000).toISOString() };
    assert.equal(await factoryCommand(['update', 'demo', '--tier', 'service'], fresh.io), 0);
  } finally { fresh.cleanup(); }
  const f = updateFixture();
  try {
    f.state = { ...f.state, updatedAt: new Date(Date.now() - 61_000).toISOString() };
    await assert.rejects(factoryCommand(['update', 'demo', '--tier', 'service'], f.io), /cannot prove.*idle/i);
    assert.equal(f.calls.some(({ args }) => ['stop', 'pause', 'unpause', 'start'].includes(args[0]) || args[1] === 'rm' || args[1] === 'create'), false);
  } finally { f.cleanup(); }
});

test('service update rechecks work after backup and resumes without merging when a worker starts', async () => {
  const f = updateFixture();
  try {
    f.mutateSnapshotNumber = 2;
    f.snapshotMutation = { workers: 1 };
    await assert.rejects(factoryCommand(['update', 'demo', '--tier', 'service'], f.io), /worker is working.*factory configure demo --resume/i);
    assert.equal(f.calls.some(({ args }) => args.includes('merge')), false);
    assert.equal(f.serviceUp, true);
    assert.equal(fs.existsSync(path.join(f.env.HERDR_FACTORIES_DIR, 'demo', 'update-pending.json')), false);
  } finally { f.cleanup(); }
});

test('image update rechecks work after backup and resumes without replacing the container', async () => {
  const f = updateFixture();
  try {
    f.mutateSnapshotNumber = 2;
    f.snapshotMutation = { workers: 1 };
    await assert.rejects(factoryCommand(['update', 'demo', '--tier', 'image'], f.io), /worker is working.*factory configure demo --resume/i);
    assert.equal(f.calls.some(({ args }) => args[0] === 'container' && args[1] === 'rm' && args[2] === 'hf-demo'), false);
    assert.equal(f.container.Id, f.originalId);
    assert.equal(f.serviceUp, true);
  } finally { f.cleanup(); }
});

test('image update rechecks the Boss pane after backup before replacing the container', async () => {
  const f = updateFixture();
  try {
    f.mutateSnapshotNumber = 2;
    f.snapshotMutation = { bossPane: true };
    await assert.rejects(factoryCommand(['update', 'demo', '--tier', 'image'], f.io), /Boss pane is live.*factory configure demo --resume/i);
    assert.equal(f.calls.some(({ args }) => args[0] === 'container' && args[1] === 'rm' && args[2] === 'hf-demo'), false);
    assert.equal(f.container.Id, f.originalId);
    assert.equal(f.serviceUp, true);
  } finally { f.cleanup(); }
});

test('update accepts only the service or image tier and documents the rollback flag', async () => {
  const f = fixture();
  try {
    await assert.rejects(factoryCommand(['update', 'demo'], f.io), /choose --tier/i);
    await assert.rejects(factoryCommand(['update', 'demo', '--tier', 'everything'], f.io), /choose --tier/i);
    await assert.rejects(factoryCommand(['update', 'demo', '--tier', 'service', '--accept-data-loss', '--accept-data-loss'], f.io), /invalid.*option/i);
    await assert.rejects(factoryCommand(['update', 'demo', '--tier', 'service', '--allow-boss-restart'], f.io), /only valid.*image/i);
  } finally { f.cleanup(); }
});

test('image update refuses a live Boss pane unless the Owner allows its loss', async () => {
  const f = updateFixture();
  try {
    f.state = { updatedAt: new Date().toISOString(), workers: 0, locks: [], handoffs: [], errors: [], orchestrators: [], bossPane: true };
    await assert.rejects(factoryCommand(['update', 'demo', '--tier', 'image'], f.io), /Boss pane is live.*allow-boss-restart/i);
    assert.equal(f.calls.some(({ args }) => ['stop', 'pause', 'unpause', 'start'].includes(args[0]) || args[1] === 'rm' || args[1] === 'create'), false);
  } finally { f.cleanup(); }
});

test('service update backs up, fast-forwards the code volume, restarts only the service, and keeps the container', async () => {
  const f = updateFixture();
  try {
    f.state = { ...f.state, bossPane: true };
    let result;
    try { result = await factoryCommand(['update', 'demo', '--tier', 'service'], f.io); }
    catch (error) { throw new Error(`${error.message}\n${f.calls.map(({ args }) => args.slice(0, 6).join(' ')).join('\n')}`); }
    assert.equal(result, 0);
    assertPollerRegistry(f.env);
    assert.equal(f.container.Id, f.originalId);
    assert.equal(f.container.State.Running, true);
    assert.equal(f.serviceUp, true);
    const supervisorCalls = fs.readFileSync(f.s6Log, 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(supervisorCalls.some((call) => call.startsWith('s6-svc\t-d ')));
    assert.ok(supervisorCalls.some((call) => call.startsWith('s6-svc\t-u ')));
    assert.ok(supervisorCalls.some((call) => call.startsWith('s6-svstat\t-o ')));
    assert.ok(f.calls.some(({ args }) => args.includes('merge') && args.includes('--ff-only')));
    assert.equal(f.calls.some(({ args }) => args[0] === 'container' && args[1] === 'rm' && args[2] === 'hf-demo'), false);
    assert.ok(f.calls.some(({ args }) => args[0] === 'run' && args.includes('herdr-factory=demo') && args.includes('herdr-factory-spike=ft15')));
    assert.match(f.output.join(''), /updated factory demo service/i);
    assert.match(f.output.join(''), /Commit: aaaaaaa -> bbbbbbb\./);
    assert.doesNotMatch(f.output.join(''), /Boss pane is gone/i);
    assert.equal(fs.existsSync(path.join(f.env.HERDR_FACTORIES_DIR, 'demo', 'update-pending.json')), false);
  } finally { f.cleanup(); }
});

test('service update keeps a rejected registry row intact', async () => {
  const f = updateFixture();
  try {
    const file = path.join(f.env.HERDR_FACTORIES_DIR, 'fleet.json');
    const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rejected = { ...registry.factories[0], name: 'bad-row', factoryId: 'bad-row', version: 'invalid-value' };
    registry.factories.push(rejected);
    fs.writeFileSync(file, JSON.stringify(registry));
    assert.equal(await factoryCommand(['update', 'demo', '--tier', 'service'], f.io), 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).factories.find((row) => row.name === 'bad-row'), rejected);
  } finally { f.cleanup(); }
});

test('service update restores a locally changed generated kit file and regenerates it after the merge', async () => {
  const f = updateFixture();
  try {
    f.dirty.add('docs/orchestration/herdr-boss.md');
    assert.equal(await factoryCommand(['update', 'demo', '--tier', 'service'], f.io), 0);
    const names = f.calls.map(({ args }) => args).filter((args) => args[0] === 'exec');
    const checkout = names.findIndex((args) => args.includes('checkout'));
    const merge = names.findIndex((args) => args.includes('merge') && args.includes('--ff-only'));
    const install = names.findIndex((args) => args.includes('kit') && args.includes('install'));
    assert.ok(checkout >= 0 && checkout < merge && merge < install, `order ${checkout} ${merge} ${install}`);
    assert.deepEqual(names[checkout].slice(names[checkout].indexOf('--') + 1), ['docs/orchestration/herdr-boss.md']);
  } finally { f.cleanup(); }
});

test('service update still stops on a local change in another file and names the file', async () => {
  const f = updateFixture();
  try {
    f.dirty.add('docs/orchestration/herdr-boss.md');
    f.dirty.add('src/local-edit.js');
    await assert.rejects(factoryCommand(['update', 'demo', '--tier', 'service'], f.io), /git merge step.*src\/local-edit\.js/s);
    assert.equal(f.calls.some(({ args }) => args.includes('checkout') && args.includes('src/local-edit.js')), false);
  } finally { f.cleanup(); }
});

test('service update still stops on a local change in docs/orchestration/memory.md and names the file', async () => {
  const f = updateFixture();
  try {
    f.dirty.add('docs/orchestration/memory.md');
    await assert.rejects(factoryCommand(['update', 'demo', '--tier', 'service'], f.io), /git merge step.*docs\/orchestration\/memory\.md/s);
    assert.equal(f.calls.some(({ args }) => args.includes('checkout')), false);
  } finally { f.cleanup(); }
});

function gitIdentityCalls(f) {
  return f.calls.map(({ args }) => args).filter((args) => args[0] === 'exec' && args.includes('config') && args.includes('--global'));
}

test('service update sets a missing Git identity for the factory user', async () => {
  const f = updateFixture();
  try {
    assert.equal(await factoryCommand(['update', 'demo', '--tier', 'service'], f.io), 0);
    const writes = gitIdentityCalls(f).filter((args) => !args.includes('--get'));
    assert.deepEqual(writes.map((args) => args.slice(-2)), [['user.name', 'Herdr Factory'], ['user.email', 'factory@localhost.invalid']]);
    for (const args of writes) assert.deepEqual(args.slice(0, 5), ['exec', '--user', 'factory', '--env', 'HOME=/home/factory']);
  } finally { f.cleanup(); }
});

test('service update keeps a Git identity that exists', async () => {
  const f = updateFixture();
  try {
    f.git['user.name'] = 'Existing Name';
    f.git['user.email'] = 'existing@example.invalid';
    assert.equal(await factoryCommand(['update', 'demo', '--tier', 'service'], f.io), 0);
    assert.equal(gitIdentityCalls(f).some((args) => !args.includes('--get')), false);
  } finally { f.cleanup(); }
});

test('image update replaces only the labeled container and keeps all four labeled volumes', async () => {
  const f = updateFixture();
  try {
    f.state = { updatedAt: new Date().toISOString(), workers: 0, locks: [], handoffs: [], errors: [], bossPane: true, orchestrators: [
      { slug: 'project', workspace: 'workspace:1', pane: 'pane:1', kind: 'codex', mode: 'auto', role: 'project' },
    ] };
    assert.equal(await factoryCommand(['update', 'demo', '--tier', 'image', '--allow-boss-restart'], f.io), 0);
    assertPollerRegistry(f.env);
    assert.notEqual(f.container.Id, f.originalId);
    assert.equal(f.container.Config.Labels['herdr-factory'], 'demo');
    assert.equal(f.container.Config.Labels['herdr-factory-spike'], 'ft15');
    assert.equal(f.container.State.Running, true);
    assert.equal(f.volumes.size, 4);
    for (const volume of f.volumes.values()) assert.deepEqual(volume.Labels, labels);
    const create = f.calls.find(({ args }) => args[0] === 'container' && args[1] === 'create').args;
    for (const kind of Object.keys(VOLUMES)) assert.ok(create.includes(`type=volume,source=hf-demo-${kind},target=${VOLUMES[kind]}`));
    assert.match(f.output.join(''), /updated factory demo image and started 1 fresh orchestrator/i);
    const freshStart = f.calls.find(({ args }) => args[0] === 'exec' && args.includes('-e') && args.at(-2).includes('deliverPrompt'));
    assert.ok(freshStart, 'the image update creates and prompts fresh project orchestrators');
    assert.ok(freshStart.args.at(-2).includes("['tab', 'create'"));
    assert.match(freshStart.args.at(-2), /fresh project orchestrator/);
    assert.doesNotMatch(freshStart.args.at(-2), /fresh Herdr Boss/);
    assert.match(f.output.join(''), /The Boss pane is gone\. Run 'herdr-boss factory boss start demo' to start the Boss in the factory\./);
  } finally { f.cleanup(); }
});

test('image update writes image timestamps without milliseconds', async () => {
  const createdAt = image.Config.Labels['org.opencontainers.image.created'];
  image.Config.Labels['org.opencontainers.image.created'] = '2026-10-07T10:59:22.928Z';
  const f = updateFixture();
  try {
    assert.equal(await factoryCommand(['update', 'demo', '--tier', 'image', '--allow-boss-restart'], f.io), 0);
    const registry = assertPollerRegistry(f.env);
    assert.equal(registry.factories[0].image.builtAt, '2026-10-07T10:59:22Z');
  } finally {
    image.Config.Labels['org.opencontainers.image.created'] = createdAt;
    f.cleanup();
  }
});

test('image update requires the newly built pinned image and makes no Docker changes when it is missing', async () => {
  const f = updateFixture();
  try {
    f.imagePresent = false;
    await assert.rejects(factoryCommand(['update', 'demo', '--tier', 'image'], f.io), /factory image is missing.*factory build/i);
    assert.equal(f.calls.some(({ args }) => ['stop', 'pause', 'unpause', 'start'].includes(args[0]) || args[1] === 'rm' || args[1] === 'create'), false);
  } finally { f.cleanup(); }
});

test('service update rolls back a failed health check without a data migration', async () => {
  const f = updateFixture();
  try {
    f.failUpdated = true;
    await assert.rejects(factoryCommand(['update', 'demo', '--tier', 'service'], f.io), /rolled back/i);
    assert.equal(f.container.Id, f.originalId);
    assert.equal(f.container.State.Running, true);
    assert.equal(f.serviceUp, true);
    assert.equal(fs.existsSync(path.join(f.env.HERDR_FACTORIES_DIR, 'demo', 'update-pending.json')), false);
    const reset = f.calls.find(({ args }) => args.includes('reset'))?.args || [];
    assert.ok(reset.includes('--keep'), 'rollback must keep local changes in the code volume');
    assert.equal(reset.includes('--hard'), false);
  } finally { f.cleanup(); }
});

test('service update retries a transient snapshot read failure while waiting for a clean tick', async () => {
  const f = updateFixture();
  try {
    f.failSnapshotAfterMerge = 1;
    assert.equal(await factoryCommand(['update', 'demo', '--tier', 'service'], f.io), 0);
    assert.equal(f.serviceUp, true);
    assert.match(f.output.join(''), /updated factory demo service/i);
  } finally { f.cleanup(); }
});

test('service rollback after a migration waits for --accept-data-loss and restores the private backup', async () => {
  const f = updateFixture();
  try {
    f.failUpdated = true;
    f.migrateOnUpdate = true;
    await assert.rejects(factoryCommand(['update', 'demo', '--tier', 'service'], f.io), /--accept-data-loss/i);
    const pending = path.join(f.env.HERDR_FACTORIES_DIR, 'demo', 'update-pending.json');
    assert.equal(fs.existsSync(pending), true);
    assert.equal(f.serviceUp, true);
    await assert.rejects(factoryCommand(['update', 'demo', '--tier', 'image', '--accept-data-loss'], f.io), /service rollback is pending/i);
    await factoryCommand(['update', 'demo', '--tier', 'service', '--accept-data-loss'], f.io);
    assert.equal(fs.existsSync(pending), false);
    assert.equal(f.container.State.Running, true);
    assert.equal(f.serviceUp, true);
    assert.equal(fs.readFileSync(path.join(f.volumePaths.home, 'login.fixture'), 'utf8'), 'invented-login');
  } finally { f.cleanup(); }
});

test('image update restores the old image and volumes after a failed health check', async () => {
  const f = updateFixture();
  try {
    f.failUpdated = true;
    await assert.rejects(factoryCommand(['update', 'demo', '--tier', 'image'], f.io), /image was rolled back/i);
    assert.equal(f.container.Config.Image, 'example-factory:test');
    assert.equal(f.container.State.Running, true);
    assert.equal(f.volumes.size, 4);
    assert.equal(fs.existsSync(path.join(f.env.HERDR_FACTORIES_DIR, 'demo', 'update-pending.json')), false);
  } finally { f.cleanup(); }
});

test('image migration rollback restores its backup when the replacement container is missing', async () => {
  const f = updateFixture();
  try {
    f.state = { ...f.state, bossPane: true };
    f.failUpdated = true;
    f.migrateOnUpdate = true;
    await assert.rejects(factoryCommand(['update', 'demo', '--tier', 'image', '--allow-boss-restart'], f.io), /--accept-data-loss/i);
    f.container = null;
    const pending = path.join(f.env.HERDR_FACTORIES_DIR, 'demo', 'update-pending.json');
    assert.equal(fs.existsSync(pending), true);
    assert.equal(await factoryCommand(['update', 'demo', '--tier', 'image', '--dry-run'], f.io), 0);
    assert.match(f.output.join(''), /rollback is pending.*no factory resources changed/i);
    await factoryCommand(['update', 'demo', '--tier', 'image', '--accept-data-loss'], f.io);
    assert.equal(f.container.Config.Image, 'example-factory:test');
    assert.equal(f.container.State.Running, true);
    assert.equal(fs.existsSync(pending), false);
    assert.equal(fs.readFileSync(path.join(f.volumePaths.home, 'login.fixture'), 'utf8'), 'invented-login');
    const replace = f.calls.find(({ args }) => args[0] === 'run' && args.includes('replace'));
    assert.ok(replace?.args.includes('--interactive'), 'the in-place recovery helper must receive the backup stream');
    assert.equal((f.output.join('').match(/The Boss pane is gone\./g) || []).length, 2);
  } finally { f.cleanup(); }
});

test('image update restores its backup when new container creation fails with data loss accepted', async () => {
  const f = updateFixture();
  try {
    f.failNewImageCreate = true;
    await assert.rejects(factoryCommand(['update', 'demo', '--tier', 'image', '--accept-data-loss'], f.io), /image was rolled back/i);
    assert.equal(f.container.Config.Image, 'example-factory:test');
    assert.equal(f.container.State.Running, true);
    assert.equal(fs.readFileSync(path.join(f.volumePaths.home, 'login.fixture'), 'utf8'), 'invented-login');
    assert.equal(f.calls.some(({ args }) => args[0] === 'run' && args.includes('replace')), false);
    assert.equal(fs.existsSync(path.join(f.env.HERDR_FACTORIES_DIR, 'demo', 'update-pending.json')), false);
  } finally { f.cleanup(); }
});

test('image update rolls back a replacement that fails to start without data restore or acceptance', async () => {
  const f = updateFixture();
  try {
    f.failNewImageStart = true;
    await assert.rejects(factoryCommand(['update', 'demo', '--tier', 'image'], f.io), /image was rolled back/i);
    assert.equal(f.container.Config.Image, 'example-factory:test');
    assert.equal(f.container.State.Running, true);
    assert.equal(f.calls.some(({ args }) => args[0] === 'run' && args.includes('replace')), false);
    assert.equal(fs.existsSync(path.join(f.env.HERDR_FACTORIES_DIR, 'demo', 'update-pending.json')), false);
  } finally { f.cleanup(); }
});

test('image update rolls back a container that never started without restoring data or requiring acceptance', async () => {
  const f = updateFixture();
  try {
    f.failNewImageCreate = true;
    await assert.rejects(factoryCommand(['update', 'demo', '--tier', 'image'], f.io), /image was rolled back/i);
    assert.equal(f.container.Config.Image, 'example-factory:test');
    assert.equal(f.container.State.Running, true);
    assert.equal(fs.readFileSync(path.join(f.volumePaths.home, 'login.fixture'), 'utf8'), 'invented-login');
    assert.equal(f.calls.some(({ args }) => args[0] === 'run' && args.includes('replace')), false);
    assert.equal(fs.existsSync(path.join(f.env.HERDR_FACTORIES_DIR, 'demo', 'update-pending.json')), false);
  } finally { f.cleanup(); }
});

test('image update distinguishes an unreadable schema from a schema increase', async () => {
  const f = updateFixture();
  try {
    f.failUpdated = true;
    f.failSchemaReadAfterStart = true;
    await assert.rejects(factoryCommand(['update', 'demo', '--tier', 'image'], f.io), /schema.*unreadable.*--accept-data-loss/i);
    const pending = JSON.parse(fs.readFileSync(path.join(f.env.HERDR_FACTORIES_DIR, 'demo', 'update-pending.json'), 'utf8'));
    assert.equal(pending.schemaState, 'unreadable');
  } finally { f.cleanup(); }
});

function gitCalls(f) { return f.calls.filter(({ args }) => args[0] === 'exec' && args.includes('git') && !args.includes('--global')); }

test('service update runs every git call as the factory user with its home', async () => {
  const f = updateFixture();
  try {
    assert.equal(await factoryCommand(['update', 'demo', '--tier', 'service'], f.io), 0);
    const calls = gitCalls(f);
    assert.ok(calls.length >= 4);
    for (const { args } of calls) {
      const user = args.indexOf('--user');
      assert.equal(args[user + 1], 'factory');
      assert.equal(args[args.indexOf('-e') + 1], 'HOME=/home/factory');
      assert.ok(user > 0 && user < args.indexOf('hf-demo'));
      assert.ok(args.indexOf('-e') < args.indexOf('hf-demo'));
    }
    assert.equal(calls.some(({ args }) => args.includes('safe.directory')), false);
  } finally { f.cleanup(); }
});

test('service update sets origin to the public repository when the factory repo has none', async () => {
  const f = updateFixture();
  try {
    f.remoteUrl = null;
    assert.equal(await factoryCommand(['update', 'demo', '--tier', 'service'], f.io), 0);
    assert.equal(f.remoteUrl, f.expectedOrigin);
    const names = gitCalls(f).map(({ args }) => args.slice(args.indexOf('git') + 3).join(' '));
    assert.ok(names.indexOf(`remote add origin ${f.expectedOrigin}`) < names.indexOf('fetch origin main'));
    assert.ok(f.calls.some(({ args }) => args.includes('merge') && args.includes('--ff-only') && args.includes('FETCH_HEAD')));
  } finally { f.cleanup(); }
});

test('service update strips credentials from the origin URL it sets', async () => {
  const f = updateFixture();
  try {
    f.remoteUrl = null;
    f.io.originUrl = 'https://user:secret@example.invalid/org/herdr-boss.git';
    assert.equal(await factoryCommand(['update', 'demo', '--tier', 'service'], f.io), 0);
    assert.equal(f.remoteUrl, 'https://example.invalid/org/herdr-boss.git');
    assert.equal(JSON.stringify(f.calls).includes('secret'), false);
    assert.equal(f.output.join('').includes('secret'), false);
  } finally { f.cleanup(); }
});

test('service update refuses a host repository URL that is not HTTPS', async () => {
  const f = updateFixture();
  try {
    f.remoteUrl = null;
    f.io.originUrl = 'git@example.invalid:org/herdr-boss.git';
    await assert.rejects(factoryCommand(['update', 'demo', '--tier', 'service'], f.io), /not an HTTPS URL/i);
    assert.equal(f.calls.some(({ args }) => ['pause', 'stop'].includes(args[0])), false);
    assert.equal(f.remoteUrl, null);
  } finally { f.cleanup(); }
});

test('service update refuses an origin that differs from the expected URL and hides credentials', async () => {
  const f = updateFixture();
  try {
    f.remoteUrl = 'https://user:secret@example.invalid/other/fork.git';
    await assert.rejects(factoryCommand(['update', 'demo', '--tier', 'service'], f.io), (error) => {
      assert.match(error.message, /origin.*differs/i);
      assert.match(error.message, /example\.invalid\/other\/fork\.git/);
      assert.match(error.message, /example\.invalid\/org\/herdr-boss\.git/);
      assert.equal(error.message.includes('secret'), false);
      return true;
    });
    assert.equal(gitCalls(f).some(({ args }) => args.includes('fetch')), false);
    assert.equal(f.calls.some(({ args }) => ['pause', 'stop'].includes(args[0])), false);
  } finally { f.cleanup(); }
});

test('service update accepts an origin that matches except for credentials and the .git suffix', async () => {
  const f = updateFixture();
  try {
    f.remoteUrl = 'https://user:secret@example.invalid/org/herdr-boss';
    assert.equal(await factoryCommand(['update', 'demo', '--tier', 'service'], f.io), 0);
  } finally { f.cleanup(); }
});

test('service update names the fetch step and the remote when the fetch fails', async () => {
  const f = updateFixture();
  try {
    f.failFetch = true;
    await assert.rejects(factoryCommand(['update', 'demo', '--tier', 'service'], f.io), (error) => {
      assert.match(error.message, /git fetch/i);
      assert.match(error.message, /cannot reach the remote/i);
      assert.equal(error.message.includes('secret'), false);
      return true;
    });
  } finally { f.cleanup(); }
});

test('service update names the merge step when the merge fails', async () => {
  const f = updateFixture();
  try {
    f.failMerge = true;
    await assert.rejects(factoryCommand(['update', 'demo', '--tier', 'service'], f.io), /git merge/i);
  } finally { f.cleanup(); }
});

const START = '/command/s6-svc -u /run/service/herdr-boss-serve';
const RECOVERY = `docker --context orbstack exec hf-demo ${START}`;
const re = (text) => new RegExp(text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));

// Register the factory on the host `winbox`, so that the host label differs from the factory name.
function useRemoteHost(f) {
  const fleet = readFleet(f.env);
  fleet.hosts = [{ hostId: 'box', runtime: 'docker-engine-wsl2', personalOnly: false, codexSandbox: 'unavailable', transport: 'ssh', connectionRef: 'winbox' }];
  fleet.factories[0].hostId = 'box';
  writeFleet(f.env, fleet);
  const file = path.join(f.env.HERDR_FACTORIES_DIR, 'demo', 'factory.json');
  writePrivate(file, { ...JSON.parse(fs.readFileSync(file, 'utf8')), hostId: 'box' });
  writePrivate(path.join(f.env.HERDR_FACTORIES_DIR, 'registry.json'), { version: 1, hosts: { winbox: { dockerContext: 'ctx-winbox', runtime: 'docker-engine-wsl2', personalOnly: false, codexSandbox: 'unavailable' } } });
}

const update = (f, tier = 'service') => factoryCommand(['update', 'demo', '--tier', tier], f.io);

test('service update prints a plain docker command for a local factory when the service cannot start', async () => {
  const f = updateFixture();
  try {
    f.failServiceStart = true;
    await assert.rejects(update(f), (error) => {
      assert.match(error.message, re(RECOVERY));
      assert.match(error.message, /herdr-boss factory status demo/);
      assert.doesNotMatch(error.message, /factory docker demo/);
      assert.equal(error.message.split(START).length - 1, 1, 'the hint appears once');
      const supervisorCalls = fs.readFileSync(f.s6Log, 'utf8').trim().split('\n').filter(Boolean);
      assert.ok(supervisorCalls.some((call) => call.startsWith('s6-svc\t-u ')));
      return true;
    });
  } finally { f.cleanup(); }
});

test('service update prints the registered host name, not the factory name, for a factory on a remote host', async () => {
  const f = updateFixture();
  try {
    useRemoteHost(f);
    f.failServiceStart = true;
    await assert.rejects(update(f), (error) => {
      assert.match(error.message, re(`herdr-boss factory docker winbox -- exec hf-demo ${START}`));
      assert.match(error.message, /herdr-boss factory status demo/);
      assert.doesNotMatch(error.message, /factory docker demo/);
      return true;
    });
  } finally { f.cleanup(); }
});

test('service update starts the service again when the rollback fails after the stop and prints no hint when the service answers', async () => {
  const f = updateFixture();
  try {
    f.transportFault = (args) => args.includes('merge');
    f.failGitReset = true;
    await assert.rejects(update(f), (error) => {
      assert.doesNotMatch(error.message, /factory status|s6-svc/);
      return true;
    });
    assert.equal(f.serviceUp, true, 'the factory service must be up after a failed update');
    const mergeAt = f.calls.findIndex(({ args }) => args.includes('merge'));
    const healthAfter = f.calls.slice(mergeAt).some(({ args }) => args[0] === 'exec' && args.includes('curl') && String(args.at(-1)).endsWith('/api/health'));
    assert.equal(healthAfter, true, 'the restarted service must answer /api/health');
  } finally { f.cleanup(); }
});

test('service update prints no hint after a rollback that restores a healthy service', async () => {
  const f = updateFixture();
  try {
    f.failUpdated = true;
    await assert.rejects(update(f), (error) => {
      assert.match(error.message, /rolled back/i);
      assert.doesNotMatch(error.message, /factory status|s6-svc/);
      return true;
    });
    assert.equal(f.serviceUp, true);
  } finally { f.cleanup(); }
});

test('service update starts the service again when the pause fails after the stop', async () => {
  const f = updateFixture();
  try {
    f.failPause = true;
    await assert.rejects(update(f), /Docker operation failed/);
    assert.equal(f.serviceUp, true, 'the factory service must be up again');
    assert.equal(f.calls.some(({ args }) => args[0] === 'exec' && args.includes('curl') && String(args.at(-1)).endsWith('/api/health')), true);
  } finally { f.cleanup(); }
});

test('image update starts the service again when the pause fails after the stop', async () => {
  const f = updateFixture();
  try {
    f.failPause = true;
    await assert.rejects(update(f, 'image'), /Docker operation failed/);
    assert.equal(f.serviceUp, true);
  } finally { f.cleanup(); }
});

test('service update names the recovery command when a backup error and a resume error follow the stop', async () => {
  const f = updateFixture();
  try {
    f.failBackupRun = true;
    f.failServiceStart = true;
    await assert.rejects(update(f), (error) => {
      assert.match(error.message, re(RECOVERY));
      return true;
    });
  } finally { f.cleanup(); }
});

test('service update restarts the service after a backup error', async () => {
  const f = updateFixture();
  try {
    f.failBackupRun = true;
    await assert.rejects(update(f));
    assert.equal(f.serviceUp, true);
    assert.notEqual(f.container.State.Paused, true);
  } finally { f.cleanup(); }
});

test('service update keeps the container paused and names the unpause and start commands after a helper cleanup failure', async () => {
  const f = updateFixture();
  try {
    f.failHelperRemove = true;
    await assert.rejects(update(f), (error) => {
      assert.match(error.message, /helper cleanup failed/i);
      assert.match(error.message, re('docker --context orbstack unpause hf-demo'));
      assert.match(error.message, re(RECOVERY));
      return true;
    });
    assert.equal(f.container.State.Paused, true, 'the container stays paused by design');
    assert.equal(f.calls.some(({ args }) => args[0] === 'unpause'), false);
  } finally { f.cleanup(); }
});

test('service update verifies /api/health after the pre-merge resume', async () => {
  const f = updateFixture();
  try {
    f.mutateSnapshotNumber = 2;
    f.snapshotMutation = { workers: 1 };
    f.failHealth = true;
    await assert.rejects(update(f), (error) => {
      assert.match(error.message, /did not answer \/api\/health/);
      assert.match(error.message, re(RECOVERY));
      return true;
    });
  } finally { f.cleanup(); }
});

test('service update prints no hint after a pre-merge resume when the service answers', async () => {
  const f = updateFixture();
  try {
    f.mutateSnapshotNumber = 2;
    f.snapshotMutation = { workers: 1 };
    await assert.rejects(update(f), (error) => {
      assert.match(error.message, /factory configure demo --resume/);
      assert.doesNotMatch(error.message, /s6-svc/);
      return true;
    });
    assert.equal(f.calls.some(({ args }) => args[0] === 'exec' && args.includes('curl') && String(args.at(-1)).endsWith('/api/health')), true);
  } finally { f.cleanup(); }
});

test('service update verifies /api/health after the data-loss-pending resume', async () => {
  const f = updateFixture();
  try {
    f.failUpdated = true;
    f.migrateOnUpdate = true;
    f.failHealth = true;
    await assert.rejects(update(f), (error) => {
      assert.match(error.message, /--accept-data-loss/);
      assert.match(error.message, /did not answer \/api\/health/);
      assert.match(error.message, re(RECOVERY));
      return true;
    });
  } finally { f.cleanup(); }
});

test('image update starts the stopped service and prints no hint when a rollback needs the Owner and the service answers', async () => {
  const f = updateFixture();
  try {
    f.failUpdated = true;
    f.migrateOnUpdate = true;
    await assert.rejects(update(f, 'image'), (error) => {
      assert.match(error.message, /--accept-data-loss/);
      assert.doesNotMatch(error.message, /s6-svc|factory status/);
      return true;
    });
    assert.equal(f.serviceUp, true);
    assert.notEqual(f.container.State.Paused, true);
  } finally { f.cleanup(); }
});

test('a stop time from an earlier update does not relax the stale state check of the next update', async () => {
  const realNow = Date.now;
  const first = updateFixture();
  try { assert.equal(await update(first), 0); } finally { first.cleanup(); }
  Date.now = () => realNow() + 5_000;
  const f = updateFixture();
  try {
    f.state = { ...f.state, updatedAt: new Date(Date.now() - 61_000).toISOString() };
    await assert.rejects(factoryCommand(['update', 'demo', '--tier', 'service', '--dry-run'], f.io), /cannot prove.*idle/i);
  } finally { Date.now = realNow; f.cleanup(); }
});

test('service update repairs the Claude usage helper after the restart and prints one line', async () => {
  const f = updateFixture();
  try {
    assert.equal(await factoryCommand(['update', 'demo', '--tier', 'service'], f.io), 0);
    const names = f.calls.map(({ args }) => args);
    const restart = names.findIndex((args) => args.includes('/command/s6-svc') && args.includes('-u'));
    const helper = names.findIndex((args) => args.includes('claude-helper'));
    assert.ok(restart >= 0 && helper > restart);
    assert.deepEqual(names[helper].slice(-2), ['claude-helper', '--apply']);
    assert.match(f.output.join(''), /Claude usage helper: installed\.\n/);
    f.output.length = 0;
    f.helperReply = { code: 0, stdout: 'unchanged\n', stderr: '' };
    assert.equal(await factoryCommand(['update', 'demo', '--tier', 'service'], f.io), 0);
    assert.match(f.output.join(''), /Claude usage helper: installed, no change\.\n/);
  } finally { f.cleanup(); }
});

test('a failing Claude usage helper step never fails the service update', async () => {
  for (const reply of [{ code: 1, stdout: '', stderr: 'boom' }, new Error('The factory host is unreachable.')]) {
    const f = updateFixture();
    try {
      f.helperReply = reply;
      assert.equal(await factoryCommand(['update', 'demo', '--tier', 'service'], f.io), 0);
      assert.match(f.output.join(''), /Claude usage helper: not applied, /);
      assert.match(f.output.join(''), /Updated factory demo service/);
    } finally { f.cleanup(); }
  }
});
