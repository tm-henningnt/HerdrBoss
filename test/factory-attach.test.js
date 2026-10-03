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
  const state = { authorized, machines: [], failStatus: false, failRemote: false, failAdd: false, nextId: 1, remoteTimeout: false, changedKey: false, catError: '', listFail: false, listGarbage: false, hideAfterAdd: false, keygenFail: false, failApi: false, nested: false };
  const calls = [], output = [];
  const docker = { async run(args, options) {
    calls.push({ type: 'docker', args, options });
    if (args[0] === 'container') return { code: 0, stdout: JSON.stringify([{ Config: { Labels: { 'herdr-factory': args[2].slice(3) } }, State: { Running: true } }]), stderr: '' };
    if (args.includes('cat')) return state.catError ? { code: 1, stdout: '', stderr: state.catError } : { code: 0, stdout: state.authorized, stderr: '' };
    if (args.includes('sh') && args.some((arg) => arg.includes('grep -vxF'))) { state.authorized = state.authorized.split('\n').filter((l) => l !== args.at(-1)).join('\n'); return { code: 0, stdout: '', stderr: '' }; }
    if (args.includes('sh')) { state.authorized += `${args.at(-1)}\n`; return { code: 0, stdout: '', stderr: '' }; }
    throw new Error('Unexpected fake Docker call.');
  } };
  const run = async (command, args, options = {}) => {
    calls.push({ type: 'run', command, args, options });
    if (command === 'ssh-keygen') return state.keygenFail ? { code: 1, stdout: '', stderr: 'incorrect passphrase' } : { code: 0, stdout: `${PUBLIC_KEY}\n`, stderr: '' };
    if (command === 'ssh') return state.changedKey ? { code: 255, stdout: '', stderr: '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@' } : state.sshFail ? { code: 255, stdout: '', stderr: 'wsluser@example.invalid: Permission denied' } : { code: 0, stdout: '', stderr: '' };
    if (command !== 'herdr') throw new Error('Unexpected fake command.');
    const [group, action] = args;
    if (group === '--machine') return state.failApi ? { code: 1, stdout: '', stderr: 'refused example.invalid api refused' } : { code: 0, stdout: '{"workspaces":[]}', stderr: '' };
    if (group === '--remote' && state.nested) return { code: 1, stdout: '', stderr: 'nested herdr is disabled by default' };
    if (group === '--remote') return state.failRemote ? { code: 1, stdout: '', stderr: 'refused example.invalid refused' } : { code: 0, stdout: '', stderr: '', timedOut: state.remoteTimeout };
    if (action === 'list') return state.listFail ? { code: 1, stdout: '', stderr: 'list broke' } : state.listGarbage ? { code: 0, stdout: 'not json', stderr: '' } : { code: 0, stdout: JSON.stringify(state.hideAfterAdd && state.addedOnce ? [] : state.machines), stderr: '' };
    if (state.changedKey && (action === 'add' || action === 'status' || group === '--machine')) return { code: 1, stdout: '', stderr: '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nOffending key in /Users/x/.ssh/known_hosts:3\nHost key for [127.0.0.1]:2222 has changed (example.invalid)' };
    if (action === 'add') {
      if (state.failAdd) return { code: 1, stdout: '', stderr: state.addText || 'refused example.invalid add failed' };
      state.addedOnce = true;
      state.machines.push({ id: `m${state.nextId++}`, label: args[args.indexOf('--label') + 1], target: args.at(-1), enabled: true });
      return { code: 0, stdout: '', stderr: '' };
    }
    if (action === 'status') return state.failStatus ? { code: 1, stdout: 'refused example.invalid down', stderr: '' } : { code: 0, stdout: '[]', stderr: '' };
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
  assert.match(config, /ProxyJump hfj-win1/);
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
});

test('attach exits 1, names the failed step, and shows the masked stderr of the failing command', async (t) => {
  for (const [flag, pattern] of [['failAdd', /add step failed/], ['failStatus', /status step failed/], ['failApi', /api check step failed/]]) {
    const f = fixture(t);
    f.state[flag] = true;
    assert.equal(await factoryCommand(['attach', 'win1'], f.io), 1, flag);
    assert.match(text(f), pattern);
    assert.match(text(f), /<host>/);
    assert.doesNotMatch(text(f), /example\.invalid|example-key|wsluser|PRIVATE/);
  }
});

test('the required check is herdr --machine LABEL workspace list', async (t) => {
  const f = fixture(t);
  assert.equal(await factoryCommand(['attach', 'win1'], f.io), 0);
  assert.ok(f.calls.some((call) => call.type === 'run' && call.args.join(' ') === '--machine m1 workspace list'));
});

test('herdr --remote is an optional extra: it runs outside a Herdr pane and never fails attach', async (t) => {
  const f = fixture(t);
  assert.equal(await factoryCommand(['attach', 'win1'], f.io), 0);
  const remote = f.calls.find((call) => call.type === 'run' && call.args[0] === '--remote');
  assert.deepEqual(remote.args, ['--remote', 'hf-win1']);
  assert.equal(remote.options.env.TERM, 'xterm-256color');
  assert.ok(remote.options.timeout > 0);
  const g = fixture(t);
  g.state.failRemote = true;
  assert.equal(await factoryCommand(['attach', 'win1'], g.io), 0);
  assert.match(text(g), /optional/i);
  const h = fixture(t);
  h.io.env.HERDR_ENV = '1'; h.state.nested = true;
  assert.equal(await factoryCommand(['attach', 'win1'], h.io), 0);
  assert.equal(h.calls.some((call) => call.type === 'run' && call.args[0] === '--remote'), false);
  assert.match(text(h), /skipped/i);
  const i = fixture(t);
  i.state.nested = true;
  assert.equal(await factoryCommand(['attach', 'win1'], i.io), 0);
  assert.match(text(i), /skipped/i);
});

test('attach reuses a machine that already has the same target, and refuses a label with another target', async (t) => {
  const f = fixture(t);
  f.state.machines.push({ id: 'manual', label: 'win1', target: 'hf-win1', enabled: true });
  assert.equal(await factoryCommand(['attach', 'win1'], f.io), 0);
  assert.equal(f.calls.some((call) => call.type === 'run' && call.args[1] === 'add'), false);
  assert.equal(f.state.machines.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(factoryFile(f.env, 'win1', 'attach.json'), 'utf8')).machineId, 'manual');
  const g = fixture(t);
  g.state.machines.push({ id: 'x', label: 'win1', target: 'other-target' });
  assert.equal(await factoryCommand(['attach', 'win1'], g.io), 1);
  assert.equal(g.state.machines.length, 1);
  const h = fixture(t);
  h.state.machines.push({ id: 'y', label: 'renamed', target: 'hf-win1' });
  assert.equal(await factoryCommand(['attach', 'win1'], h.io), 0);
  assert.equal(h.state.machines.length, 1);
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
  assert.equal(fs.existsSync(path.join(f.ssh, 'config')), false);
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

test('the factory Host block has a unique HostKeyAlias, the jump block keeps the real host key', async (t) => {
  const f = fixture(t);
  await factoryCommand(['attach', 'win1'], f.io);
  await factoryCommand(['attach', 'win2'], f.io);
  const block = (name) => fs.readFileSync(path.join(f.ssh, 'herdr-boss.d', `hf-${name}.conf`), 'utf8').split(/\n\n/);
  const [jump1, host1] = block('win1');
  const [, host2] = block('win2');
  assert.match(host1, /HostKeyAlias hf-win1/);
  assert.match(host2, /HostKeyAlias hf-win2/);
  assert.match(host1, /StrictHostKeyChecking accept-new/);
  assert.doesNotMatch(jump1, /HostKeyAlias/);
  assert.doesNotMatch(block('win1').join(''), /StrictHostKeyChecking no|UserKnownHostsFile/);
});

test('attach rewrites an include file of the old form on the next run', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.ssh, 'herdr-boss.d'), { recursive: true });
  fs.writeFileSync(path.join(f.ssh, 'herdr-boss.d', 'hf-win1.conf'), 'Host hf-win1\n  HostName 127.0.0.1\n');
  assert.equal(await factoryCommand(['attach', 'win1'], f.io), 0);
  assert.match(fs.readFileSync(path.join(f.ssh, 'herdr-boss.d', 'hf-win1.conf'), 'utf8'), /HostKeyAlias hf-win1/);
});

test('a changed host key gives a plain message with the alias and the ssh-keygen command, and no address', async (t) => {
  const f = fixture(t);
  f.state.changedKey = true;
  assert.equal(await factoryCommand(['attach', 'win1'], f.io), 1);
  assert.match(text(f), /The host key of hf-win1 changed\. If you rebuilt the factory, remove the old line with: ssh-keygen -R hf-win1/);
  assert.doesNotMatch(text(f), /example\.invalid|127\.0\.0\.1|known_hosts|2222/);
});

const attachJson = (f, name = 'win1') => JSON.parse(fs.readFileSync(factoryFile(f.env, name, 'attach.json'), 'utf8'));
const config = (f) => path.join(f.ssh, 'config');

test('a symlinked ~/.ssh/config is edited through the link and the link stays', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.ssh, { recursive: true });
  const real = path.join(f.root, 'dotfiles-ssh-config');
  fs.writeFileSync(real, 'Host other\n');
  fs.symlinkSync(real, config(f));
  assert.equal(await factoryCommand(['attach', 'win1'], f.io), 0);
  assert.equal(fs.lstatSync(config(f)).isSymbolicLink(), true);
  assert.match(fs.readFileSync(real, 'utf8'), /^Include ~\/\.ssh\/herdr-boss\.d\/\*\.conf\n/);
  assert.equal(await factoryCommand(['attach', 'win1', '--undo'], f.io), 0);
  assert.equal(fs.lstatSync(config(f)).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(real, 'utf8'), 'Host other\n');
});

test('an indented or non-top-level Include line is not ours: attach adds a top line, undo removes only that line', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.ssh, { recursive: true });
  const original = 'Host x\n  Include ~/.ssh/herdr-boss.d/*.conf\nHost y\nInclude ~/.ssh/herdr-boss.d/*.conf\n';
  fs.writeFileSync(config(f), original);
  assert.equal(await factoryCommand(['attach', 'win1'], f.io), 0);
  const added = fs.readFileSync(config(f), 'utf8');
  assert.ok(added.startsWith('Include ~/.ssh/herdr-boss.d/*.conf\n'));
  assert.equal(added.split('Include ~/.ssh/herdr-boss.d/*.conf').length - 1, 3);
  assert.equal(await factoryCommand(['attach', 'win1', '--undo'], f.io), 0);
  assert.equal(fs.readFileSync(config(f), 'utf8'), original);
});

test('an existing backup is never overwritten', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.ssh, { recursive: true });
  fs.writeFileSync(path.join(f.ssh, 'config.herdr-boss.bak'), 'older backup\n');
  fs.writeFileSync(config(f), 'Host other\n');
  assert.equal(await factoryCommand(['attach', 'win1'], f.io), 0);
  assert.equal(fs.readFileSync(path.join(f.ssh, 'config.herdr-boss.bak'), 'utf8'), 'older backup\n');
  assert.equal(fs.readFileSync(path.join(f.ssh, 'config.herdr-boss.bak.1'), 'utf8'), 'Host other\n');
});

test('an unreadable ~/.ssh/config fails attach and keeps the ownership marker on undo', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(config(f), { recursive: true });
  assert.equal(await factoryCommand(['attach', 'win1'], f.io), 1);
  assert.match(text(f), /SSH config cannot be read/);
  const g = fixture(t);
  fs.mkdirSync(path.join(g.ssh, 'herdr-boss.d'), { recursive: true });
  fs.writeFileSync(path.join(g.ssh, 'herdr-boss.d', '.include-added'), '{}');
  fs.mkdirSync(config(g));
  fs.writeFileSync(conf(g, 'win1'), 'x');
  assert.equal(await factoryCommand(['attach', 'win1', '--undo'], g.io), 1);
  assert.equal(fs.existsSync(path.join(g.ssh, 'herdr-boss.d', '.include-added')), true);
});
const conf = (f, name) => path.join(f.ssh, 'herdr-boss.d', `hf-${name}.conf`);

test('a marker without an Include line (a crash state) is cleaned by undo', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.ssh, { recursive: true });
  fs.writeFileSync(config(f), 'Host other\n');
  await factoryCommand(['attach', 'win1'], f.io);
  fs.writeFileSync(config(f), 'Host other\n');
  assert.equal(await factoryCommand(['attach', 'win1', '--undo'], f.io), 0);
  assert.equal(fs.readFileSync(config(f), 'utf8'), 'Host other\n');
  assert.equal(fs.existsSync(path.join(f.ssh, 'herdr-boss.d')), false);
});

test('undo removes an empty ~/.ssh/config only when attach created it', async (t) => {
  const f = fixture(t);
  await factoryCommand(['attach', 'win1'], f.io);
  assert.equal(fs.existsSync(config(f)), true);
  await factoryCommand(['attach', 'win1', '--undo'], f.io);
  assert.equal(fs.existsSync(config(f)), false);
  const g = fixture(t);
  fs.mkdirSync(g.ssh, { recursive: true });
  fs.writeFileSync(config(g), '');
  await factoryCommand(['attach', 'win1'], g.io);
  await factoryCommand(['attach', 'win1', '--undo'], g.io);
  assert.equal(fs.existsSync(config(g)), true);
});

test('unsafe host values are rejected before any file is written, and % is escaped in IdentityFile', async (t) => {
  for (const [field, value] of [['keyFile', '/tmp/a b'], ['keyFile', '/tmp/a\nProxyCommand x'], ['keyFile', '/tmp/a"b'], ['keyFile', "/tmp/a'b"], ['address', 'a.invalid\nHost *'], ['user', 'a b'], ['user', 'a\0b']]) {
    const f = fixture(t);
    const file = path.join(f.env.HERDR_FACTORIES_DIR, 'registry.json');
    const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
    registry.hosts['example-host'][field] = value;
    fs.writeFileSync(file, JSON.stringify(registry));
    assert.equal(await factoryCommand(['attach', 'win1'], f.io), 1, `${field} ${JSON.stringify(value)}`);
    assert.match(text(f), /unsafe character/i);
    assert.equal(fs.existsSync(path.join(f.ssh, 'herdr-boss.d')), false);
  }
  const g = fixture(t);
  const file = path.join(g.env.HERDR_FACTORIES_DIR, 'registry.json');
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  registry.hosts['example-host'].keyFile = '/tmp/k%h';
  fs.writeFileSync(file, JSON.stringify(registry));
  assert.equal(await factoryCommand(['attach', 'win1'], g.io), 0);
  assert.match(fs.readFileSync(conf(g, 'win1'), 'utf8'), /IdentityFile "\/tmp\/k%%h"/);
});

test('the jump alias cannot be a factory alias, and an old-form file is migrated', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.ssh, 'herdr-boss.d'), { recursive: true });
  fs.writeFileSync(conf(f, 'win1'), 'Host hf-win1-jump\n  HostName x\nHost hf-win1\n  ProxyJump hf-win1-jump\n');
  assert.equal(await factoryCommand(['attach', 'win1'], f.io), 0);
  const body = fs.readFileSync(conf(f, 'win1'), 'utf8');
  assert.match(body, /^Host hfj-win1$/m);
  assert.match(body, /ProxyJump hfj-win1/);
  assert.doesNotMatch(body, /-jump/);
});

test('a failed or unparsable machine list is an error, never a skipped step', async (t) => {
  for (const flag of ['listFail', 'listGarbage']) {
    const f = fixture(t);
    f.state[flag] = true;
    assert.equal(await factoryCommand(['attach', 'win1'], f.io), 1, flag);
    assert.match(text(f), /machine list/);
  }
  const g = fixture(t);
  await factoryCommand(['attach', 'win1'], g.io);
  g.state.listFail = true; g.output.length = 0;
  assert.equal(await factoryCommand(['attach', 'win1', '--undo'], g.io), 1);
  assert.equal(fs.existsSync(factoryFile(g.env, 'win1', 'attach.json')), true);
  assert.equal(fs.existsSync(conf(g, 'win1')), true);
});

test('when the machine id cannot be found after add, attach fails and saves no null id', async (t) => {
  const f = fixture(t);
  f.state.hideAfterAdd = true;
  assert.equal(await factoryCommand(['attach', 'win1'], f.io), 1);
  assert.match(text(f), /machine id/i);
  const file = factoryFile(f.env, 'win1', 'attach.json');
  if (fs.existsSync(file)) assert.notEqual(attachJson(f).state, 'attached');
});

test('undo removes only a machine that attach created', async (t) => {
  const f = fixture(t);
  f.state.machines.push({ id: 'manual', label: 'hand', target: 'hf-win1', enabled: true });
  await factoryCommand(['attach', 'win1'], f.io);
  assert.equal(attachJson(f).machineCreated, false);
  await factoryCommand(['attach', 'win1', '--undo'], f.io);
  assert.deepEqual(f.state.machines.map((m) => m.id), ['manual']);
  const g = fixture(t);
  await factoryCommand(['attach', 'win1'], g.io);
  assert.equal(attachJson(g).machineCreated, true);
  await factoryCommand(['attach', 'win1'], g.io);
  assert.equal(attachJson(g).machineCreated, true);
  await factoryCommand(['attach', 'win1', '--undo'], g.io);
  assert.equal(g.state.machines.length, 0);
});

test('two machines with the same label stop the verification', async (t) => {
  const f = fixture(t);
  f.state.machines.push({ id: 'a', label: 'win1', target: 'hf-win1' }, { id: 'b', label: 'win1', target: 'elsewhere' });
  assert.equal(await factoryCommand(['attach', 'win1'], f.io), 1);
  assert.match(text(f), /share the label/);
  assert.equal(f.calls.some((call) => call.type === 'run' && call.args[0] === '--machine'), false);
});

test('undo works when the factory is no longer in the fleet registry', async (t) => {
  const f = fixture(t);
  await factoryCommand(['attach', 'win1'], f.io);
  const { updateFleet } = await import('../src/factory-store.js');
  updateFleet(f.env, (fleet) => { fleet.factories = fleet.factories.filter((item) => item.name !== 'win1'); });
  f.output.length = 0;
  assert.equal(await factoryCommand(['attach', 'win1', '--undo'], f.io), 0);
  assert.equal(f.state.machines.length, 0);
  assert.equal(fs.existsSync(conf(f, 'win1')), false);
  assert.match(text(f), /key stays/i);
  f.output.length = 0;
  assert.equal(await factoryCommand(['attach', 'win1', '--undo'], f.io), 0);
  assert.match(text(f), /nothing is left/);
});

test('undo removes the authorized_keys line that attach added and keeps a line that was there before', async (t) => {
  const f = fixture(t);
  await factoryCommand(['attach', 'win1'], f.io);
  assert.equal(attachJson(f).keyAdded, true);
  assert.equal(await factoryCommand(['attach', 'win1', '--undo'], f.io), 0);
  assert.equal(f.state.authorized.includes('AAAAC3NzaExampleKeyOnly'), false);
  const g = fixture(t, { authorized: `${PUBLIC_KEY}\n` });
  await factoryCommand(['attach', 'win1'], g.io);
  assert.equal(attachJson(g).keyAdded, false);
  await factoryCommand(['attach', 'win1', '--undo'], g.io);
  assert.equal(g.state.authorized.includes('AAAAC3NzaExampleKeyOnly'), true);
  assert.match(text(g), /key stays/i);
});

test('authorized_keys: a line with options counts; a failed cat is an error; a missing file is empty', async (t) => {
  const f = fixture(t, { authorized: `command="x",no-pty ${PUBLIC_KEY}\n` });
  assert.equal(await factoryCommand(['attach', 'win1'], f.io), 0);
  assert.equal(f.calls.some((call) => call.type === 'docker' && call.args.includes('sh')), false);
  const g = fixture(t);
  g.state.catError = 'cat: permission denied';
  assert.equal(await factoryCommand(['attach', 'win1'], g.io), 1);
  assert.match(text(g), /authorized_keys/);
  const h = fixture(t);
  h.state.catError = 'cat: /home/factory/.ssh/authorized_keys: No such file or directory';
  assert.equal(await factoryCommand(['attach', 'win1'], h.io), 0);
  assert.equal(h.state.authorized.includes('AAAAC3NzaExampleKeyOnly'), true);
});

test('ssh-keygen runs without a prompt and a protected key fails with a plain message', async (t) => {
  const f = fixture(t);
  await factoryCommand(['attach', 'win1'], f.io);
  const keygen = f.calls.find((call) => call.command === 'ssh-keygen');
  assert.deepEqual(keygen.args.slice(0, 3), ['-y', '-P', '']);
  const g = fixture(t);
  g.state.keygenFail = true;
  assert.equal(await factoryCommand(['attach', 'win1'], g.io), 1);
  assert.match(text(g), /passphrase/);
});

test('a timed-out herdr --remote check is inconclusive, not a pass', async (t) => {
  const f = fixture(t);
  f.state.remoteTimeout = true;
  assert.equal(await factoryCommand(['attach', 'win1'], f.io), 0);
  assert.match(text(f), /inconclusive/);
  assert.doesNotMatch(text(f), /remote attach check passed/);
});

test('the SSH user and the port are masked in a failing command output', async (t) => {
  const f = fixture(t);
  f.state.failAdd = true;
  f.state.addText = 'ssh: wsluser@example.invalid port 2222 refused [127.0.0.1]:2222';
  assert.equal(await factoryCommand(['attach', 'win1'], f.io), 1);
  assert.doesNotMatch(text(f), /wsluser|2222/);
});

test('the label of an existing machine is not printed unless it equals the factory name', async (t) => {
  const f = fixture(t);
  f.state.machines.push({ id: 'manual', label: 'my-private-label', target: 'hf-win1' });
  assert.equal(await factoryCommand(['attach', 'win1'], f.io), 0);
  assert.doesNotMatch(text(f), /my-private-label/);
});

test('attach makes the first SSH contact itself with accept-new, before any herdr command', async (t) => {
  const f = fixture(t);
  assert.equal(await factoryCommand(['attach', 'win1'], f.io), 0);
  const runs = f.calls.filter((call) => call.type === 'run');
  const index = runs.findIndex((call) => call.command === 'ssh');
  assert.ok(index >= 0);
  assert.deepEqual(runs[index].args, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new', 'hf-win1', 'true']);
  assert.equal(runs.slice(0, index).some((call) => call.command === 'herdr'), false);
  const g = fixture(t);
  g.state.sshFail = true;
  assert.equal(await factoryCommand(['attach', 'win1'], g.io), 1);
  assert.match(text(g), /ssh check step failed/);
  assert.doesNotMatch(text(g), /wsluser|example\.invalid/);
  assert.equal(g.calls.some((call) => call.type === 'run' && call.command === 'herdr'), false);
});

test('a plain "host key verification failed" is not reported as a changed key', async (t) => {
  const f = fixture(t);
  f.state.failAdd = true; f.state.addText = 'Host key verification failed.';
  assert.equal(await factoryCommand(['attach', 'win1'], f.io), 1);
  assert.doesNotMatch(text(f), /changed/);
  assert.match(text(f), /add step failed/);
});
