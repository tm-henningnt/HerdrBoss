import './helpers/test-env.js';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import test from 'node:test';
import { factoryCommand } from '../src/factory-host.js';
import { waitForTokenDashboard } from '../src/factory-token.js';
import { writeFleet, writePrivate, VOLUMES } from '../src/factory-store.js';

const service = '/run/service/herdr-boss-serve';
function fixture({ boss = false, custom = false, remote = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-token-'));
  const home = path.join(root, 'home');
  const data = path.join(home, '.herdr-boss');
  const privateDir = path.join(home, '.config', 'herdr-boss');
  const code = path.join(home, 'herdr-boss');
  for (const dir of [data, privateDir, code]) fs.mkdirSync(dir, { recursive: true });
  const tokenFile = path.join(custom ? path.join(home, 'custom') : privateDir, 'access-token');
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  const original = randomBytes(32).toString('hex');
  fs.writeFileSync(tokenFile, `${original}\n`, { mode: 0o600 });
  const sessions = path.join(privateDir, 'sessions.json');
  fs.writeFileSync(sessions, JSON.stringify({ sessions: {} }));
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(custom ? { access: { tokenFile } } : {}));
  const env = { HOME: home, HERDR_BOSS_DIR: data, HERDR_FACTORIES_DIR: path.join(root, 'factories') };
  if (boss) Object.assign(env, { HERDR_ENV: '1', HERDR_PANE_ID: 'boss-pane', HERDR_WORKSPACE_ID: 'boss-space' });
  const hostId = remote ? 'example-host' : 'local';
  const host = { hostId, runtime: remote ? 'docker-engine-wsl2' : 'orbstack', personalOnly: true, codexSandbox: 'user-namespaces', transport: remote ? 'ssh' : 'local', ...(remote ? { connectionRef: hostId } : {}) };
  if (remote) writePrivate(path.join(env.HERDR_FACTORIES_DIR, 'registry.json'), { version: 1, hosts: { [hostId]: { dockerContext: 'example-context' } } });
  writeFleet(env, { schema: 1, contractVersion: '1.0.0', minimumFactoryVersion: '0.1.0', hosts: [host], factories: [{ factoryId: 'demo', name: 'demo', hostId, kind: 'container', profile: 'personal', containerName: 'hf-demo', hostname: 'demo.localhost', dashboardUrl: 'http://demo.localhost:4478', ports: { dashboard: 4478, ssh: 2222 }, version: '0.1.0', kitRevision: 'abcdef012345', image: { builtAt: '2026-10-08T00:00:00Z', pinsHash: 'a'.repeat(64) } }] });
  writePrivate(path.join(env.HERDR_FACTORIES_DIR, 'demo', 'factory.json'), { name: 'demo', hostId });
  const calls = [], out = [], err = [], logs = [];
  const bossTransportOutput = [];
  const state = { restartFails: false, healthFails: false, transportFails: false, pid: 101 };
  const container = { Config: { Labels: { 'herdr-factory': 'demo' } }, HostConfig: { Privileged: false, CapAdd: null, SecurityOpt: ['seccomp=example-profile', 'systempaths=unconfined'] }, Mounts: Object.entries(VOLUMES).map(([kind, target]) => ({ Type: 'volume', Name: `hf-demo-${kind}`, Destination: target })), State: { Running: true, Paused: false } };
  const ok = (value = '') => ({ code: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
  const docker = { async run(args, options = {}) {
    calls.push({ args, options });
    if (args[0] === 'container' && args[1] === 'inspect') return ok([container]);
    assert.equal(args[0], 'exec');
    assert.ok(args.includes('hf-demo'));
    if (args.includes('/command/s6-svstat')) return ok(String(state.pid));
    if (args.includes('/command/s6-svc')) {
      assert.deepEqual(args, ['exec', 'hf-demo', '/command/s6-svc', '-r', service]);
      if (state.restartFails) return { code: 1, stdout: fs.readFileSync(tokenFile, 'utf8'), stderr: original };
      state.pid += 1;
      return ok();
    }
    if (options.input?.includes('waitForTokenDashboard')) {
      return ok({ ok: !state.healthFails });
    }
    assert.ok(args.includes('--user') && args.includes('factory'));
    assert.equal(options.interactive, undefined);
    const nodeArgs = args.slice(args.indexOf('--input-type=module'));
    const script = options.input.replaceAll('/home/factory', home);
    const result = spawnSync(process.execPath, nodeArgs, { input: script, encoding: 'utf8', cwd: code, env: { ...process.env, HOME: home, HERDR_BOSS_DIR: data } });
    if (boss) bossTransportOutput.push(result.stdout, result.stderr);
    if (state.transportFails && args.includes('prepare')) throw new Error(fs.readFileSync(tokenFile, 'utf8'));
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  } };
  const io = { env, stdin: Object.assign(Readable.from(['demo\n']), { isTTY: true }), stdout: { isTTY: true, write: (value) => out.push(value) }, stderr: { write: (value) => err.push(value) }, log: (value) => logs.push(value), herdr: () => ({ pane: { id: 'boss-pane', workspace: 'boss-space', label: 'boss' } }), transportFactory: (selected) => { assert.equal(selected.hostId, hostId); return docker; }, isContainer: () => false };
  const auditFile = path.join(privateDir, 'factory-token-audit.jsonl');
  return { root, home, data, tokenFile, sessions, original, calls, out, err, logs, bossTransportOutput, state, io, container, auditFile, text: () => out.join(''), audit: () => fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8') : '', cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function assertPrivate(f, token, allowedOutput = false) {
  const captured = [allowedOutput ? '' : f.text(), f.err.join(''), f.audit(), JSON.stringify(f.calls), f.logs.join(''), f.bossTransportOutput.join('')].join('\n');
  assert.equal(captured.includes(token), false, 'token must stay out of diagnostic output');
  assert.equal(f.audit().includes(createHash('sha256').update(token).digest('hex')), false);
}

test('Owner reads one token line after typing the factory name without rotating', async () => {
  const f = fixture();
  try {
    assert.equal(await factoryCommand(['token', 'demo'], f.io), 0);
    assert.equal(f.text(), `${f.original}\n`);
    assert.equal(fs.readFileSync(f.tokenFile, 'utf8').trim(), f.original);
    assert.equal(fs.existsSync(f.sessions), true);
    assert.equal(f.calls.some(({ args }) => args.includes('/command/s6-svc')), false);
    assertPrivate(f, f.original, true);
  } finally { f.cleanup(); }
});

test('health waits for a replacement process and a 200 response with a bounded timeout', async () => {
  for (const scenario of ['ready', 'same-pid', 'bad-health', 'unreachable']) {
    let clock = 0;
    let checks = 0;
    const calls = [];
    const result = await waitForTokenDashboard('100', {
      timeoutMs: 1000,
      now: () => clock,
      delay: async (ms) => { clock += ms; },
      run: async (file, args) => {
        calls.push({ file, args });
        if (scenario === 'unreachable') throw new Error('invented diagnostic');
        if (file === '/command/s6-svstat') { checks += 1; return scenario === 'same-pid' || checks === 1 ? '100\n' : '101\n'; }
        assert.equal(file, 'curl');
        assert.ok(args.includes('http://127.0.0.1:4477/api/health'));
        return scenario === 'bad-health' ? '503' : '200';
      },
    });
    assert.equal(result.ok, scenario === 'ready');
    if (scenario === 'same-pid') assert.equal(calls.some(({ file }) => file === 'curl'), false);
    if (scenario !== 'ready') assert.equal(clock, 1000);
  }
});

for (const remote of [false, true]) test(`Owner rotates the configured token atomically through ${remote ? 'remote' : 'local'} factory exec`, async () => {
  const f = fixture({ custom: true, remote });
  const previousInode = fs.statSync(f.tokenFile).ino;
  try {
    assert.equal(await factoryCommand(['token', 'demo', '--rotate'], f.io), 0);
    const token = fs.readFileSync(f.tokenFile, 'utf8').trim();
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.notEqual(token, f.original);
    assert.notEqual(fs.statSync(f.tokenFile).ino, previousInode);
    assert.equal(fs.statSync(f.tokenFile).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(f.tokenFile)), ['access-token']);
    assert.equal(fs.existsSync(f.sessions), false);
    assert.equal(f.text(), `${token}\n`);
    assert.equal(f.calls.filter(({ args }) => args.includes('/command/s6-svc')).length, 1);
    assert.ok(f.calls.some(({ options }) => options.input?.includes('/api/health')));
    assert.equal(fs.statSync(f.auditFile).mode & 0o777, 0o600);
    const audit = f.audit().trim().split('\n').map(JSON.parse);
    assert.deepEqual(audit.map((line) => line.result), ['attempt', 'ok']);
    for (const line of audit) assert.deepEqual(Object.keys(line).sort(), ['action', 'caller', 'factory', 'result', 'time']);
    assertPrivate(f, token, true);
    assertPrivate(f, f.original);
  } finally { f.cleanup(); }
});

test('Boss rotation returns no token through stdout, stderr, audit, logs or transport', async () => {
  const f = fixture({ boss: true });
  try {
    assert.equal(await factoryCommand(['token', 'demo', '--rotate'], f.io), 0);
    const token = fs.readFileSync(f.tokenFile, 'utf8').trim();
    assert.match(f.text(), /^demo \d{4}-\d{2}-\d{2}T\S+ signed out all devices\n$/);
    assertPrivate(f, token);
    assertPrivate(f, f.original);
    assert.equal(f.audit().includes('"caller":"boss"'), true);
  } finally { f.cleanup(); }
});

test('unknown factory, invalid confirmation and unsafe containers stop before token access', async () => {
  for (const kind of ['unknown', 'confirmation', 'eof', 'unsafe', 'stopped', 'paused']) {
    const f = fixture();
    try {
      if (kind === 'confirmation') f.io.stdin = Object.assign(Readable.from(['Demo\n']), { isTTY: true });
      if (kind === 'eof') f.io.stdin = Object.assign(Readable.from([]), { isTTY: true });
      if (kind === 'unsafe') f.container.Config.Labels['herdr-factory'] = 'other';
      if (kind === 'stopped') f.container.State.Running = false;
      if (kind === 'paused') f.container.State.Paused = true;
      await assert.rejects(factoryCommand(['token', kind === 'unknown' ? 'missing' : 'demo', '--rotate'], f.io), /registry|confirmation|label|running|paused/i);
      assert.equal(f.calls.some(({ args }) => args[0] === 'exec'), false);
      assert.equal(f.audit(), '');
      assert.equal(fs.readFileSync(f.tokenFile, 'utf8').trim(), f.original);
    } finally { f.cleanup(); }
  }
});

test('CLI entry point refuses captured output without loading private access files', () => {
  const f = fixture();
  try {
    const env = { ...process.env, ...f.io.env };
    for (const name of ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'HERDR_WORKTREE']) delete env[name];
    const result = spawnSync(process.execPath, ['src/cli.js', 'factory', 'token', 'demo', '--rotate'], { env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /TTYs/);
    assert.equal(fs.readFileSync(f.tokenFile, 'utf8').trim(), f.original);
    assert.equal(f.audit(), '');
    assert.equal(result.stderr.includes(f.original), false);
  } finally { f.cleanup(); }
});

test('a stopped dashboard service refuses rotation before file access', async () => {
  const f = fixture();
  try {
    f.state.pid = 0;
    await assert.rejects(factoryCommand(['token', 'demo', '--rotate'], f.io), /running PID/);
    assert.equal(f.audit(), '');
    assert.equal(fs.readFileSync(f.tokenFile, 'utf8').trim(), f.original);
    assert.equal(f.calls.some(({ args }) => args.includes('prepare')), false);
  } finally { f.cleanup(); }
});

test('rotation refuses an unwritable attempt audit before changing the token or sessions', async () => {
  const f = fixture();
  try {
    fs.mkdirSync(f.auditFile);
    await assert.rejects(factoryCommand(['token', 'demo', '--rotate'], f.io), /audit/i);
    assert.equal(fs.readFileSync(f.tokenFile, 'utf8').trim(), f.original);
    assert.equal(fs.existsSync(f.sessions), true);
    assert.equal(f.calls.some(({ args }) => args.includes('/command/s6-svc')), false);
  } finally { f.cleanup(); }
});

test('a result audit failure after health suppresses the token and gives recovery steps', async () => {
  const f = fixture({ boss: true });
  const factory = f.io.transportFactory;
  f.io.transportFactory = (host) => {
    const runner = factory(host);
    return { async run(args, options) {
      if (args.includes('finish')) { fs.unlinkSync(f.auditFile); fs.mkdirSync(f.auditFile); }
      return runner.run(args, options);
    } };
  };
  try {
    await assert.rejects(factoryCommand(['token', 'demo', '--rotate'], f.io), /result audit failed.*\nThe token file changed/);
    assert.equal(f.text(), '');
    assert.equal(f.bossTransportOutput.join('').includes(fs.readFileSync(f.tokenFile, 'utf8').trim()), false);
  } finally { f.cleanup(); }
});

for (const failure of ['restartFails', 'healthFails', 'transportFails']) test(`${failure} with a changed token prints recovery steps and no token`, async () => {
  const f = fixture({ boss: true });
  try {
    f.state[failure] = true;
    let error;
    try { await factoryCommand(['token', 'demo', '--rotate'], f.io); } catch (caught) { error = caught; }
    assert.ok(error);
    assert.match(error.message, /token file may have changed|token file changed/i);
    assert.match(error.message, /factory shell demo/);
    assert.match(error.message, /s6-svc -r \/run\/service\/herdr-boss-serve/);
    assert.match(error.message, /api\/health/);
    assert.match(error.message, /factory token demo/);
    const token = fs.readFileSync(f.tokenFile, 'utf8').trim();
    assert.notEqual(token, f.original);
    assert.equal(error.message.includes(token), false);
    assert.equal(error.message.includes(f.original), false);
    assertPrivate(f, token);
    assertPrivate(f, f.original);
    assert.equal(f.audit().includes('"result":"failed"'), true);
  } finally { f.cleanup(); }
});

test('invalid config, failed atomic write and failed session removal return safe stage errors', async () => {
  for (const failure of ['config', 'write', 'sessions']) {
    const f = fixture();
    try {
      if (failure === 'config') fs.writeFileSync(path.join(f.data, 'config.json'), '{bad');
      if (failure === 'write') { fs.unlinkSync(f.tokenFile); fs.mkdirSync(f.tokenFile); }
      if (failure === 'sessions') { fs.unlinkSync(f.sessions); fs.mkdirSync(f.sessions); }
      let error;
      try { await factoryCommand(['token', 'demo', '--rotate'], f.io); } catch (caught) { error = caught; }
      assert.ok(error);
      assert.equal(error.message.includes(f.original), false);
      assert.equal(error.message.includes(f.root), false);
      assert.equal(f.calls.some(({ args }) => args.includes('/command/s6-svc')), false);
      if (failure === 'sessions') assert.match(error.message, /token file changed/);
    } finally { f.cleanup(); }
  }
});
