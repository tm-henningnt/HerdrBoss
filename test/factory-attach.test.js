import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { factoryCommand, updateRegistry } from '../src/factory-host.js';
import { writeFleet, writePrivate, factoryFile } from '../src/factory-store.js';

const PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaExampleKeyOnly mac-user';
function fixture(t, { authorized = '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-attach-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { HOME: root, HERDR_BOSS_DIR: path.join(root, 'data'), HERDR_FACTORIES_DIR: path.join(root, 'factories'), TMPDIR: root };
  updateRegistry(env, (registry) => { registry.hosts['example-host'] = { address: 'example.invalid', user: 'wsluser', keyFile: path.join(root, 'example-key'), dockerContext: 'example-context' }; });
  const record = (name, port) => ({ factoryId: name, name, hostId: 'example-host', kind: 'container', containerName: `hf-${name}`, hostname: `${name}.localhost`, ports: { dashboard: port, ssh: port - 2256 }, profile: 'personal', dashboardUrl: `http://${name}.localhost:${port}`, version: '0.1.0', kitRevision: 'abcdef012345', image: { builtAt: '2026-10-03T00:00:00Z', pinsHash: 'a'.repeat(64) } });
  writeFleet(env, { schema: 1, contractVersion: '1.0.0', minimumFactoryVersion: '0.1.0', hosts: [{ hostId: 'example-host', transport: 'ssh', connectionRef: 'example-host', runtime: 'docker-engine-wsl2', personalOnly: true, codexSandbox: 'user-namespaces' }], factories: [record('win1', 4478), record('win2', 4479)] });
  for (const name of ['win1', 'win2']) writePrivate(factoryFile(env, name), { name, hostId: 'example-host', ports: { dashboard: 4478, ssh: 2222 } });
  const state = { authorized, machines: [], failStatus: false, failRemote: false, failAdd: false, nextId: 1, remoteTimeout: false };
  const calls = [], output = [];
  const docker = { async run(args, options) {
    calls.push({ type: 'docker', args, options });
    if (args[0] === 'container') return { code: 0, stdout: JSON.stringify([{ Config: { Labels: { 'herdr-factory': args[2].slice(3) } }, State: { Running: true } }]), stderr: '' };
    if (args.includes('cat')) return { code: 0, stdout: state.authorized, stderr: '' };
    if (args.includes('sh')) { state.authorized += `${args.at(-1)}\n`; return { code: 0, stdout: '', stderr: '' }; }
    throw new Error('Unexpected fake Docker call.');
  } };
  const run = async (command, args, options = {}) => {
    calls.push({ type: 'run', command, args, options });
    if (command === 'ssh-keygen') return { code: 0, stdout: `${PUBLIC_KEY}\n`, stderr: '' };
    if (command !== 'herdr') throw new Error('Unexpected fake command.');
    const [group, action] = args;
    if (group === '--remote') return state.failRemote ? { code: 1, stdout: '', stderr: 'PRIVATE example.invalid refused' } : { code: 0, stdout: '', stderr: '', timedOut: state.remoteTimeout };
    if (action === 'list') return { code: 0, stdout: JSON.stringify(state.machines), stderr: '' };
    if (action === 'add') {
      if (state.failAdd) return { code: 1, stdout: '', stderr: 'PRIVATE example.invalid add failed' };
      state.machines.push({ id: `m${state.nextId++}`, label: args[args.indexOf('--label') + 1], target: args.at(-1) });
      return { code: 0, stdout: '', stderr: '' };
    }
    if (action === 'status') return state.failStatus ? { code: 1, stdout: 'PRIVATE example.invalid down', stderr: '' } : { code: 0, stdout: '[]', stderr: '' };
    if (action === 'remove') { state.machines = state.machines.filter((machine) => machine.id !== args[2]); return { code: 0, stdout: '', stderr: '' }; }
    throw new Error('Unexpected fake herdr call.');
  };
  const io = { env, isContainer: () => false, transportFactory: () => docker, run, stdout: { write: (line) => output.push(line) }, stderr: { write: (line) => output.push(line) } };
  return { root, env, io, calls, output, state, ssh: path.join(root, '.ssh') };
}
const text = (f) => f.output.join('');

test('attach writes a mode 600 include file with the jump and the factory host, and prints no private value', async (t) => {
  const f = fixture(t);
  assert.equal(await factoryCommand(['attach', 'win1'], f.io), 0);
  const file = path.join(f.ssh, 'herdr-boss.d', 'hf-win1.conf');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const config = fs.readFileSync(file, 'utf8');
  assert.match(config, /^Host hf-win1$/m);
  assert.match(config, /ProxyJump hf-win1-jump/);
  assert.match(config, /Port 2222/);
  assert.match(config, /User factory/);
  assert.doesNotMatch(text(f), /example\.invalid|example-key|wsluser|example-context|PRIVATE|AAAAC3/);
  assert.match(text(f), /hf-win1/);
  assert.match(text(f), /factory attach win1 --undo/);
});

test('attach shows the Include line, backs up ~/.ssh/config, and adds the line once for two factories', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.ssh, { recursive: true });
  fs.writeFileSync(path.join(f.ssh, 'config'), 'Host other\n  HostName other.invalid\n', { mode: 0o600 });
  assert.equal(await factoryCommand(['attach', 'win1'], f.io), 0);
  assert.equal(await factoryCommand(['attach', 'win2'], f.io), 0);
  const config = fs.readFileSync(path.join(f.ssh, 'config'), 'utf8');
  assert.equal(config.split('Include ~/.ssh/herdr-boss.d/*.conf').length - 1, 1);
  assert.ok(config.startsWith('Include ~/.ssh/herdr-boss.d/*.conf\n'));
  assert.match(config, /Host other\n  HostName other.invalid\n/);
  assert.equal(fs.readFileSync(path.join(f.ssh, 'config.herdr-boss.bak'), 'utf8'), 'Host other\n  HostName other.invalid\n');
  assert.equal(fs.statSync(path.join(f.ssh, 'config')).mode & 0o777, 0o600);
  assert.match(text(f), /Include ~\/\.ssh\/herdr-boss\.d\/\*\.conf/);
});

test('attach keeps an existing Include line and does not own it', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.ssh, { recursive: true });
  fs.writeFileSync(path.join(f.ssh, 'config'), 'Include ~/.ssh/herdr-boss.d/*.conf\n');
  assert.equal(await factoryCommand(['attach', 'win1'], f.io), 0);
  assert.equal(await factoryCommand(['attach', 'win1', '--undo'], f.io), 0);
  assert.equal(fs.readFileSync(path.join(f.ssh, 'config'), 'utf8'), 'Include ~/.ssh/herdr-boss.d/*.conf\n');
});

test('attach adds the Mac key to authorized_keys only when it is missing', async (t) => {
  const f = fixture(t);
  assert.equal(await factoryCommand(['attach', 'win1'], f.io), 0);
  assert.equal(f.state.authorized, `${PUBLIC_KEY}\n`);
  assert.match(text(f), /added the Mac key/i);
  const writes = () => f.calls.filter((call) => call.type === 'docker' && call.args.includes('sh')).length;
  assert.equal(writes(), 1);
  f.output.length = 0;
  assert.equal(await factoryCommand(['attach', 'win1'], f.io), 0);
  assert.equal(writes(), 1);
  assert.match(text(f), /already authorized/i);
  const g = fixture(t, { authorized: 'ssh-ed25519 AAAAC3NzaExampleKeyOnly other-comment\n' });
  assert.equal(await factoryCommand(['attach', 'win1'], g.io), 0);
  assert.equal(g.calls.filter((call) => call.type === 'docker' && call.args.includes('sh')).length, 0);
});

test('attach runs herdr machine add with the label and the alias, once', async (t) => {
  const f = fixture(t);
  assert.equal(await factoryCommand(['attach', 'win1'], f.io), 0);
  assert.equal(await factoryCommand(['attach', 'win1'], f.io), 0);
  const adds = f.calls.filter((call) => call.type === 'run' && call.args[1] === 'add');
  assert.equal(adds.length, 1);
  assert.deepEqual(adds[0].args, ['machine', 'add', '--label', 'win1', 'hf-win1']);
  assert.ok(f.calls.some((call) => call.type === 'run' && call.args[0] === 'machine' && call.args[1] === 'status'));
  const remote = f.calls.find((call) => call.type === 'run' && call.args[0] === '--remote');
  assert.deepEqual(remote.args, ['--remote', 'hf-win1']);
  assert.equal(remote.options.env.TERM, 'xterm-256color');
  assert.ok(remote.options.timeout > 0);
});

test('attach exits 1 with a plain message and no private value when a check fails', async (t) => {
  for (const [flag, pattern] of [['failAdd', /machine add failed/], ['failStatus', /machine status failed/], ['failRemote', /remote attach failed/]]) {
    const f = fixture(t);
    f.state[flag] = true;
    assert.equal(await factoryCommand(['attach', 'win1'], f.io), 1, flag);
    assert.match(text(f), pattern);
    assert.doesNotMatch(text(f), /example\.invalid|example-key|wsluser|PRIVATE/);
  }
});

test('the remote check passes when herdr still runs at the time limit', async (t) => {
  const f = fixture(t);
  f.state.remoteTimeout = true;
  assert.equal(await factoryCommand(['attach', 'win1'], f.io), 0);
});

test('attach refuses a factory on the local host and an unknown factory', async (t) => {
  const f = fixture(t);
  await assert.rejects(factoryCommand(['attach', 'nope'], f.io), /not in the fleet registry/);
  await assert.rejects(factoryCommand(['attach'], f.io), /Use factory attach/);
  await assert.rejects(factoryCommand(['attach', 'win1', '--bad'], f.io), /Use factory attach/);
});

test('--undo removes the machine, the include file, and the owned Include line, and a second run says nothing is left', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.ssh, { recursive: true });
  fs.writeFileSync(path.join(f.ssh, 'config'), 'Host other\n');
  f.state.machines.push({ id: 'other-id', label: 'other', target: 'other' });
  await factoryCommand(['attach', 'win1'], f.io);
  f.output.length = 0;
  assert.equal(await factoryCommand(['attach', 'win1', '--undo'], f.io), 0);
  assert.deepEqual(f.state.machines.map((machine) => machine.id), ['other-id']);
  assert.equal(fs.existsSync(path.join(f.ssh, 'herdr-boss.d', 'hf-win1.conf')), false);
  assert.equal(fs.readFileSync(path.join(f.ssh, 'config'), 'utf8'), 'Host other\n');
  assert.match(text(f), /removed/);
  f.output.length = 0;
  assert.equal(await factoryCommand(['attach', 'win1', '--undo'], f.io), 0);
  assert.match(text(f), /nothing is left/);
  assert.doesNotMatch(text(f), /example\.invalid|example-key|wsluser|PRIVATE/);
});

test('--undo keeps the Include line while another factory stays attached', async (t) => {
  const f = fixture(t);
  await factoryCommand(['attach', 'win1'], f.io);
  await factoryCommand(['attach', 'win2'], f.io);
  assert.equal(await factoryCommand(['attach', 'win1', '--undo'], f.io), 0);
  assert.match(fs.readFileSync(path.join(f.ssh, 'config'), 'utf8'), /Include ~\/\.ssh\/herdr-boss\.d\/\*\.conf/);
  assert.equal(fs.existsSync(path.join(f.ssh, 'herdr-boss.d', 'hf-win2.conf')), true);
  assert.equal(f.state.machines.length, 1);
  assert.equal(await factoryCommand(['attach', 'win2', '--undo'], f.io), 0);
  assert.doesNotMatch(fs.readFileSync(path.join(f.ssh, 'config'), 'utf8'), /Include/);
});

test('attach records its state in the private factory folder for the Fleet page', async (t) => {
  const f = fixture(t);
  await factoryCommand(['attach', 'win1'], f.io);
  const record = JSON.parse(fs.readFileSync(factoryFile(f.env, 'win1', 'attach.json'), 'utf8'));
  assert.equal(record.state, 'attached');
  const { attachState } = await import('../src/factory-attach.js');
  assert.equal(attachState(f.env, 'win1'), 'attached');
  assert.equal(attachState(f.env, 'win2'), 'not-attached');
  await factoryCommand(['attach', 'win1', '--undo'], f.io);
  assert.equal(attachState(f.env, 'win1'), 'not-attached');
});
