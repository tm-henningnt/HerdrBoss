import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { factoryCommand } from '../src/factory-host.js';
import { configSafetyError } from '../src/factory-core.js';
import { updateFleet } from '../src/factory-store.js';
import { createDockerTransport } from '../src/factory-transport.js';
import { validateFile } from './factory/schema-check.js';

const health = { schema: 1, contractVersion: '1.0.0', version: '0.1.0', kitRevision: 'abcdef012345', herdrReachable: true, tickAgeSeconds: 1, clockOffsetSeconds: null };
const labels = { 'herdr-factory': 'demo', 'herdr-factory-spike': 'fa1' };
const mounts = ['home', 'data', 'work', 'code'].map((kind) => ({ Type: 'volume', Name: `hf-demo-${kind}`, Destination: {
  home: '/home/factory', data: '/home/factory/.herdr-boss', work: '/home/factory/work', code: '/home/factory/herdr-boss',
}[kind] }));

function fixture(name = 'demo') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-core-'));
  const calls = [];
  const output = [];
  const volumes = new Map();
  const factoryLabels = { ...labels, 'herdr-factory': name };
  const factoryMounts = mounts.map((mount) => ({ ...mount, Name: mount.Name.replace('hf-demo-', `hf-${name}-`) }));
  let container;
  let imageAvailable = true;
  let buildSnapshot;
  const docker = { async run(args, options) {
    calls.push({ args, options });
    const json = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
    const missing = (kind) => ({ code: 1, stdout: '', stderr: `Error: No such ${kind}` });
    if (args[0] === 'image' && args[1] === 'inspect') return imageAvailable ? json([{ Config: { Labels: {
      'org.opencontainers.image.created': '2026-10-03T00:00:00Z', 'org.herdr-boss.pins-sha256': 'a'.repeat(64),
    } } }]) : missing('image');
    if (args[0] === 'buildx' && args[1] === 'inspect') return args.includes('--format') ? { code: 125, stdout: '', stderr: 'unknown flag: --format' } : { code: 1, stdout: '', stderr: 'failed to find instance: no such file or directory' };
    if (args[0] === 'buildx' && args[1] === 'build') {
      const context = args.at(-1);
      buildSnapshot = { checksums: fs.readFileSync(path.join(context, 'checksums.txt'), 'utf8'), seedGit: fs.existsSync(path.join(context, 'seed', '.git')), context };
      imageAvailable = true;
      return json({});
    }
    if (args[0] === 'volume' && args[1] === 'inspect') return volumes.has(args[2]) ? json([volumes.get(args[2])]) : missing('volume');
    if (args[0] === 'volume' && args[1] === 'create') { const volumeName = args.at(-1); volumes.set(volumeName, { Name: volumeName, Labels: factoryLabels }); return json(volumeName); }
    if (args[0] === 'container' && args[1] === 'inspect') return args[2].startsWith('herdr-factory-buildkit-') ? missing('container') : container ? json([container]) : missing('container');
    if (args[0] === 'container' && args[1] === 'create') {
      const securityOpt = [];
      for (let index = 0; index < args.length; index += 1) if (args[index] === '--security-opt') securityOpt.push(args[index + 1]);
      container = { Config: { Labels: factoryLabels }, HostConfig: { Privileged: false, CapAdd: null, SecurityOpt: securityOpt }, Mounts: factoryMounts, State: { Status: 'created', Running: false } };
      return json('example-container-id');
    }
    if (args[0] === 'start') { container.State = { Status: 'running', Running: true, Health: { Status: 'healthy' } }; return json('hf-demo'); }
    if (args[0] === 'stop') { container.State = { Status: 'exited', Running: false }; return json('hf-demo'); }
    if (args[0] === 'exec' && args.includes('curl')) return args.includes('%{http_code}') ? { code: 0, stdout: '200', stderr: '' } : json(health);
    if (args[0] === 'exec' && args.includes('herdr')) return json({ result: { panes: [] } });
    if (args[0] === 'exec' && args.includes('node') && args.some((word) => word.includes('allowedKinds'))) return json({ codexWasAllowed: true });
    if (args[0] === 'exec' && args.includes('node')) return json({ workers: 0 });
    if (args[0] === 'exec' && args.includes('df')) return { code: 0, stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\nvolume 10000 1000 9000 10% /home/factory\n', stderr: '' };
    return json({});
  } };
  const io = { env: { HOME: root, HERDR_BOSS_DIR: path.join(root, 'data'), HERDR_FACTORIES_DIR: path.join(root, 'factories'), TMPDIR: root },
    isContainer: () => false, transportFactory: () => docker,
    stdout: { write: (value) => output.push(value) }, stderr: { write: (value) => output.push(value) } };
  return { root, calls, io, docker, volumes, output, get container() { return container; }, set imageAvailable(value) { imageAvailable = value; }, get buildSnapshot() { return buildSnapshot; }, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('new starts a factory with four labeled volumes, loopback ports and bounded resources', async () => {
  const f = fixture();
  try {
    assert.equal(await factoryCommand(['new', 'demo', '--image', 'example-factory:test'], f.io), 0);
    assert.equal(f.volumes.size, 4);
    const create = f.calls.find(({ args }) => args[0] === 'container' && args[1] === 'create').args;
    for (const value of ['herdr-factory=demo', 'herdr-factory-spike=fa1', '127.0.0.1:4478:4477', '127.0.0.1:2222:22', '4', '4g', '1g', '512', 'max-size=10m', 'max-file=3']) assert.ok(create.includes(value), value);
    assert.equal(create.includes('--privileged'), false);
    assert.equal(create.includes('--cap-add'), false);
    assert.equal(create.join(' ').includes('/var/run/docker.sock'), false);
    assert.equal(f.container.State.Running, true);
    const fleetFile = path.join(f.io.env.HERDR_FACTORIES_DIR, 'fleet.json');
    const fleet = JSON.parse(fs.readFileSync(fleetFile, 'utf8'));
    assert.deepEqual(validateFile(fleet, new URL('../docs/contracts/schema/factory-registry.v1.schema.json', import.meta.url).pathname), []);
    assert.equal(fleet.factories[0].name, 'demo');
    assert.equal(fleet.factories[0].hostname, 'demo.localhost');
    assert.equal(fs.statSync(fleetFile).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(fleet).includes('keyFile'), false);
    const flow = JSON.parse(fs.readFileSync(path.join(f.io.env.HERDR_FACTORIES_DIR, 'demo', 'flow.json'), 'utf8'));
    assert.equal(flow.state, 'service-ready');
    assert.ok(f.calls.some(({ args }) => args.includes('Host: demo.localhost')));
  } finally { f.cleanup(); }
});

test('status, list, stop and start control only the labeled factory and report measured state', async () => {
  const f = fixture();
  try {
    await factoryCommand(['new', 'demo', '--image', 'example-factory:test'], f.io);
    f.output.length = 0;
    assert.equal(await factoryCommand(['status', 'demo', '--json'], f.io), 0);
    const status = JSON.parse(f.output.join(''));
    assert.equal(status.state, 'running');
    assert.equal(status.health, 'healthy');
    assert.equal(status.schema, 1);
    assert.equal(status.kitRevision, 'abcdef012345');
    assert.equal(status.version, '0.1.0');
    assert.equal(status.imageBuildDate, '2026-10-03T00:00:00Z');
    assert.equal(status.pinsHash, 'a'.repeat(64));
    assert.equal(status.workers, 0);
    assert.deepEqual(status.disk, { totalKiB: 10000, usedKiB: 1000, availableKiB: 9000 });
    f.output.length = 0;
    assert.equal(await factoryCommand(['list'], f.io), 0);
    assert.match(f.output.join(''), /demo/);
    assert.equal(await factoryCommand(['stop', 'demo'], f.io), 0);
    assert.equal(f.container.State.Running, false);
    assert.equal(await factoryCommand(['start', 'demo'], f.io), 0);
    assert.equal(f.container.State.Running, true);
    f.container.Config.Labels = {};
    const before = f.calls.length;
    await assert.rejects(factoryCommand(['stop', 'demo', '--now'], f.io), /label/);
    assert.equal(f.calls.slice(before).some(({ args }) => args[0] === 'stop'), false);
  } finally { f.cleanup(); }
});

test('new builds a missing image with pins and a dedicated builder without changing the checkout', async () => {
  const f = fixture();
  try {
    f.imageAvailable = false;
    assert.equal(await factoryCommand(['new', 'demo'], f.io), 0);
    const create = f.calls.find(({ args }) => args[0] === 'buildx' && args[1] === 'create').args;
    assert.ok(create.includes('herdr-factory-local'));
    assert.ok(create.includes('remote'));
    assert.ok(create.includes('docker-container://herdr-factory-buildkit-local'));
    const builderContainer = f.calls.find(({ args }) => args[0] === 'run').args;
    assert.ok(builderContainer.includes('herdr-factory-spike=fa1'));
    assert.ok(builderContainer.includes('herdr-factory-builder=local'));
    assert.equal(create.includes('--use'), false);
    const build = f.calls.find(({ args }) => args[0] === 'buildx' && args[1] === 'build').args;
    for (const value of ['--load', 'herdr-factory-local', 'herdr-factory-spike=fa1', 'herdr-factory=demo']) assert.ok(build.includes(value), value);
    assert.ok(build.some((value) => value.startsWith('BASE_IMAGE=debian:trixie-slim@sha256:')));
    assert.ok(build.some((value) => value === 'NODE_VERSION=26.10.0'));
    assert.ok(f.buildSnapshot.seedGit);
    assert.match(f.buildSnapshot.checksums, /herdr-linux-x86_64/);
    assert.equal(fs.existsSync(f.buildSnapshot.context), false);
    const connections = JSON.parse(fs.readFileSync(path.join(f.io.env.HERDR_FACTORIES_DIR, 'registry.json'), 'utf8'));
    assert.equal(connections.hosts.local.builderName, 'herdr-factory-local');
  } finally { f.cleanup(); }
});

test('a remote factory uses a private context through a public connection reference', async () => {
  const f = fixture();
  try {
    await factoryCommand(['host', 'add', 'host-a', '--docker-context', 'example-context'], f.io);
    let selected;
    f.io.transportFactory = (host) => { selected = host; return f.docker; };
    await factoryCommand(['new', 'demo', '--host', 'host-a', '--image', 'example-factory:test'], f.io);
    assert.equal(selected.dockerContext, 'example-context');
    assert.equal(selected.transport, 'docker-context');
    const fleet = JSON.parse(fs.readFileSync(path.join(f.io.env.HERDR_FACTORIES_DIR, 'fleet.json'), 'utf8'));
    assert.deepEqual(validateFile(fleet, new URL('../docs/contracts/schema/factory-registry.v1.schema.json', import.meta.url).pathname), []);
    assert.equal(fleet.hosts[0].connectionRef, 'host-a');
    assert.equal(fleet.hosts[0].runtime, 'docker-engine-wsl2');
    assert.equal(fleet.hosts[0].personalOnly, false);
    assert.equal(fleet.hosts[0].codexSandbox, 'unavailable');
    assert.equal(JSON.stringify(fleet).includes('example-context'), false);
    assert.equal(JSON.stringify(fleet).includes('address'), false);
    assert.equal(f.output.join('').includes('example-context'), false);
  } finally { f.cleanup(); }
});

test('factory new uses the host Codex setting and prints the tailnet policy for a personal-use factory', async () => {
  const f = fixture();
  try {
    await factoryCommand(['host', 'add', 'host-a', '--docker-context', 'example-context', '--runtime', 'docker-engine-wsl2', '--personal-only', 'true', '--codex-sandbox', 'unavailable'], f.io);
    assert.equal(await factoryCommand(['new', 'demo', '--host', 'host-a', '--image', 'example-factory:test'], f.io), 0);
    const create = f.calls.find(({ args }) => args[0] === 'container' && args[1] === 'create').args;
    assert.equal(create.includes('--security-opt'), false);
    const fleet = JSON.parse(fs.readFileSync(path.join(f.io.env.HERDR_FACTORIES_DIR, 'fleet.json'), 'utf8'));
    assert.equal(fleet.hosts[0].runtime, 'docker-engine-wsl2');
    assert.equal(fleet.hosts[0].personalOnly, true);
    assert.equal(fleet.hosts[0].codexSandbox, 'unavailable');
    const flow = JSON.parse(fs.readFileSync(path.join(f.io.env.HERDR_FACTORIES_DIR, 'demo', 'flow.json'), 'utf8'));
    assert.equal(flow.codexEnabled, false);
    assert.equal(flow.codexDisabledByWizard, true);
    const output = f.output.join('');
    assert.match(output, /Tag: tag:hf-demo/);
    assert.match(output, /Paste these lines into the tailnet policy file\. Then approve the tag when the factory joins\./);
    assert.match(output, /"tagOwners": \{/);
    assert.match(output, /"tag:hf-demo": \["autogroup:admin"\]/);
    assert.match(output, /\{"src": \["autogroup:member"\], "dst": \["tag:hf-demo"\], "ip": \["tcp:443"\]\}/);
    assert.match(output, /\{"src": \["tag:hf-head-office"\], "dst": \["tag:hf-demo"\], "ip": \["tcp:443"\]\}/);
    assert.equal(output.includes('{"src": ["tag:hf-demo"], "dst": ["tag:hf-head-office"], "ip": ["tcp:443"]}'), false);
    assert.match(output, /tailscale up --advertise-tags=tag:hf-demo/);
    assert.equal(output.includes('example-context'), false);
    assert.equal(f.calls.some(({ args }) => args[0] === 'tailscale'), false);
    const policyBlock = output.slice(output.indexOf('Tag: '), output.indexOf('Created factory'));
    assert.equal(policyBlock, [
      'Tag: tag:hf-demo',
      'Head office tag: tag:hf-head-office',
      'Host tag: tag:hf-host',
      '// Paste these lines into the tailnet policy file. Then approve the tag when the factory joins.',
      '// tag:hf-head-office and tag:hf-host need existing tagOwners entries in the policy.',
      '"tagOwners": {',
      '  "tag:hf-demo": ["autogroup:admin"]',
      '},',
      '"grants": [',
      '  {"src": ["autogroup:member"], "dst": ["tag:hf-demo"], "ip": ["tcp:443"]},',
      '  {"src": ["tag:hf-head-office"], "dst": ["tag:hf-demo"], "ip": ["tcp:443"]}',
      ']',
      'tailscale up --advertise-tags=tag:hf-demo',
      '',
    ].join('\n'));
  } finally { f.cleanup(); }
});

test('factory new applies the tested Codex sandbox and prints the client grant for a non-personal-use host', async () => {
  const f = fixture();
  try {
    await factoryCommand(['host', 'add', 'host-a', '--docker-context', 'example-context', '--runtime', 'docker-engine-wsl2', '--codex-sandbox', 'user-namespaces'], f.io);
    assert.equal(await factoryCommand(['new', 'demo', '--host', 'host-a', '--image', 'example-factory:test'], f.io), 0);
    const create = f.calls.find(({ args }) => args[0] === 'container' && args[1] === 'create').args;
    assert.deepEqual(create.slice(create.indexOf('--security-opt'), create.indexOf('--security-opt') + 4), [
      '--security-opt', 'seccomp=' + path.join(path.dirname(new URL('../factory/seccomp-codex.json', import.meta.url).pathname), 'seccomp-codex.json'),
      '--security-opt', 'systempaths=unconfined',
    ]);
    const output = f.output.join('');
    assert.match(output, /\{"src": \["tag:hf-demo"\], "dst": \["tag:hf-head-office"\], "ip": \["tcp:443"\]\}/);
    const policyBlock = output.slice(output.indexOf('Tag: '), output.indexOf('Created factory'));
    assert.equal(policyBlock.includes('  {"src": ["tag:hf-demo"], "dst": ["tag:hf-head-office"], "ip": ["tcp:443"]}'), true);
    const fleet = JSON.parse(fs.readFileSync(path.join(f.io.env.HERDR_FACTORIES_DIR, 'fleet.json'), 'utf8'));
    assert.equal(fleet.hosts[0].personalOnly, false);
    assert.equal(fleet.hosts[0].codexSandbox, 'user-namespaces');
  } finally { f.cleanup(); }
});

test('configure disables Codex and rejects a relaxed container after its host becomes unavailable', async () => {
  const f = fixture();
  try {
    await factoryCommand(['host', 'add', 'host-a', '--docker-context', 'example-context', '--codex-sandbox', 'user-namespaces'], f.io);
    await factoryCommand(['new', 'demo', '--host', 'host-a', '--image', 'example-factory:test'], f.io);
    await factoryCommand(['host', 'add', 'host-a', '--codex-sandbox', 'unavailable'], f.io);
    f.output.length = 0;
    assert.equal(await factoryCommand(['configure', 'demo', '--step', 'container'], f.io), 1);
    const flow = JSON.parse(fs.readFileSync(path.join(f.io.env.HERDR_FACTORIES_DIR, 'demo', 'flow.json'), 'utf8'));
    assert.equal(flow.codexEnabled, false);
    assert.equal(flow.codexDisabledByWizard, true);
    assert.match(f.output.join(''), /no approved Codex security profile/);
    const gate = f.calls.filter(({ args }) => args.some((word) => word.includes('allowedKinds'))).at(-1);
    assert.ok(gate.args.find((word) => word.includes('allowedKinds')).includes('p.allowedKinds.filter(k=>k!=="codex")'));
    await factoryCommand(['list', '--json'], f.io);
    assert.equal(JSON.parse(f.output.at(-1)).hosts[0].codexSandbox, 'unavailable');
  } finally { f.cleanup(); }
});

test('configure records checked steps, resumes a failed service and waits once for Owner logins', async () => {
  const f = fixture();
  try {
    await factoryCommand(['new', 'demo', '--image', 'example-factory:test'], f.io);
    const run = f.docker.run.bind(f.docker);
    let failService = true;
    f.docker.run = async (args, options) => {
      if (args[0] === 'exec' && args.includes('curl') && failService) return { code: 22, stdout: '', stderr: 'service is not ready' };
      return run(args, options);
    };
    assert.equal(await factoryCommand(['configure', 'demo'], f.io), 1);
    const file = path.join(f.io.env.HERDR_FACTORIES_DIR, 'demo', 'flow.json');
    let flow = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(flow.steps.find((step) => step.name === 'container').status, 'done');
    assert.equal(flow.steps.find((step) => step.name === 'service').status, 'failed');
    assert.equal(flow.codexEnabled, true);
    failService = false;
    assert.equal(await factoryCommand(['configure', 'demo', '--resume'], f.io), 3);
    flow = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(flow.steps.slice(0, 4).map((step) => step.name), ['container', 'volumes', 'herdr', 'service']);
    assert.ok(flow.steps.slice(0, 4).every((step) => step.status === 'done'));
    assert.equal(flow.steps[4].name, 'harness-claude');
    assert.equal(flow.steps[4].status, 'waiting');
    const instruction = fs.readFileSync(path.join(f.io.env.HERDR_FACTORIES_DIR, 'demo', 'owner-instructions.md'), 'utf8');
    assert.match(instruction, /Owner terminal/);
    assert.match(instruction, /herdr-boss factory login demo claude/);
    assert.match(instruction, /herdr-boss factory login demo codex/);
    assert.match(instruction, /check login with a harmless command/);
    assert.doesNotMatch(instruction, /example-context|token=/);
    assert.equal(await factoryCommand(['configure', 'demo', '--resume'], f.io), 3);
    assert.equal(fs.readFileSync(path.join(f.io.env.HERDR_FACTORIES_DIR, 'demo', 'owner-instructions.md'), 'utf8'), instruction);
    f.container.HostConfig.Privileged = true;
    assert.equal(await factoryCommand(['configure', 'demo', '--resume'], f.io), 1);
    flow = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(flow.codexEnabled, false);
    assert.equal(flow.steps[0].status, 'failed');
    assert.ok(f.calls.some(({ args }) => args.includes('node') && args.some((value) => value.includes('allowedKinds'))));
  } finally { f.cleanup(); }
});

test('a remote timeout is host unreachable, separate from a stopped or unhealthy container', async () => {
  const f = fixture();
  try {
    await factoryCommand(['host', 'add', 'host-a', '--docker-context', 'example-context'], f.io);
    await factoryCommand(['new', 'demo', '--host', 'host-a', '--image', 'example-factory:test'], f.io);
    f.docker.run = async () => { const error = new Error('private endpoint example.invalid'); error.code = 'ETIMEDOUT'; throw error; };
    f.output.length = 0;
    assert.equal(await factoryCommand(['status', 'demo', '--json'], f.io), 0);
    const status = JSON.parse(f.output.join(''));
    assert.equal(status.state, 'host-unreachable');
    assert.equal(status.health, 'host-unreachable');
    assert.equal(status.workers, null);
    assert.equal(status.version, null);
    assert.equal(f.output.join('').includes('example.invalid'), false);
    assert.equal(await factoryCommand(['configure', 'demo', '--step', 'service'], f.io), 1);
    const flow = JSON.parse(fs.readFileSync(path.join(f.io.env.HERDR_FACTORIES_DIR, 'demo', 'flow.json'), 'utf8'));
    assert.equal(flow.state, 'host-unreachable');
    assert.equal(flow.steps[0].detail, 'The factory host is unreachable.');
  } finally { f.cleanup(); }
});

test('a wizard failure of an unreachable host names the host setup guide', async () => {
  const f = fixture();
  try {
    await factoryCommand(['host', 'add', 'host-a', '--docker-context', 'example-context'], f.io);
    await factoryCommand(['new', 'demo', '--host', 'host-a', '--image', 'example-factory:test'], f.io);
    f.docker.run = async () => { const error = new Error('private endpoint example.invalid'); error.code = 'ETIMEDOUT'; throw error; };
    f.output.length = 0;
    assert.equal(await factoryCommand(['configure', 'demo', '--step', 'service'], f.io), 1);
    const text = f.output.join('');
    assert.match(text, /Factory demo: container failed\. The factory host is unreachable\./);
    assert.match(text, /Host setup guide: open \/fleet\/add-host\?host=host-a in the dashboard/);
    assert.equal(text.includes('example.invalid'), false);
  } finally { f.cleanup(); }
});

test('a health timeout after container inspection still reports host unreachable', async () => {
  const f = fixture();
  try {
    await factoryCommand(['new', 'demo', '--image', 'example-factory:test'], f.io);
    const run = f.docker.run.bind(f.docker);
    f.docker.run = async (args, options) => {
      if (args[0] === 'exec' && args.includes('curl')) { const error = new Error('private endpoint'); error.code = 'ETIMEDOUT'; throw error; }
      return run(args, options);
    };
    f.output.length = 0;
    await factoryCommand(['status', 'demo', '--json'], f.io);
    assert.equal(JSON.parse(f.output.join('')).state, 'host-unreachable');
  } finally { f.cleanup(); }
});

test('creation refuses client profiles, invalid ports, containers and foreign volumes before mutation', async () => {
  for (const args of [['new', 'demo', '--profile', 'client'], ['new', 'demo', '--dashboard-port', '2222', '--ssh-port', '2222'], ['new', '../demo'], ['new', 'demo-']]) {
    const f = fixture();
    try { await assert.rejects(factoryCommand(args, f.io)); assert.equal(f.calls.length, 0); }
    finally { f.cleanup(); }
  }
  const f = fixture();
  try {
    await assert.rejects(factoryCommand(['new', 'demo'], { ...f.io, isContainer: () => true }), /inside a container/);
    f.volumes.set('hf-demo-home', { Name: 'hf-demo-home', Labels: { 'herdr-factory': 'another-factory' } });
    await assert.rejects(factoryCommand(['new', 'demo', '--image', 'example-factory:test'], f.io), /label/);
    assert.equal(f.calls.some(({ args }) => args[0] === 'start' || args[0] === 'volume' && args[1] === 'create'), false);
  } finally { f.cleanup(); }
});

test('minimum versions use numeric comparison and a corrupt fleet file stays unchanged', async () => {
  const f = fixture();
  try {
    await factoryCommand(['new', 'demo', '--image', 'example-factory:test'], f.io);
    const file = path.join(f.io.env.HERDR_FACTORIES_DIR, 'fleet.json');
    const fleet = JSON.parse(fs.readFileSync(file, 'utf8'));
    fleet.minimumFactoryVersion = '0.10.0';
    fleet.factories[0].version = '0.9.0';
    fs.writeFileSync(file, JSON.stringify(fleet));
    const before = f.calls.length;
    await assert.rejects(factoryCommand(['stop', 'demo'], f.io), /minimum version 0.10.0/);
    assert.equal(f.calls.slice(before).some(({ args }) => args[0] === 'stop'), false);
    fs.writeFileSync(file, '{broken');
    await assert.rejects(factoryCommand(['list'], f.io), /cannot be read/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  } finally { f.cleanup(); }
});

test('the wizard accepts Docker effective systempaths fields when the option is normalized away', async () => {
  const f = fixture();
  try {
    await factoryCommand(['new', 'demo', '--image', 'example-factory:test'], f.io);
    f.container.HostConfig.SecurityOpt = ['seccomp=example-profile'];
    f.container.HostConfig.MaskedPaths = [];
    f.container.HostConfig.ReadonlyPaths = [];
    assert.equal(await factoryCommand(['configure', 'demo', '--step', 'service'], f.io), 0);
    f.container.HostConfig.MaskedPaths = ['/proc/kcore'];
    assert.equal(await factoryCommand(['configure', 'demo', '--step', 'container'], f.io), 1);
  } finally { f.cleanup(); }
});

test('an unavailable Codex sandbox accepts Docker defaults and rejects relaxed security options', () => {
  const container = { HostConfig: { Privileged: false, SecurityOpt: null }, Mounts: mounts };
  assert.equal(configSafetyError(container, 'demo', 'unavailable'), null);
  const error = 'The factory container has no approved Codex security profile.';
  const results = [
    ['systempaths=unconfined'],
    ['seccomp=example-profile'],
    ['seccomp=example-profile', 'systempaths=unconfined'],
  ].map((SecurityOpt) => {
    container.HostConfig.SecurityOpt = SecurityOpt;
    return configSafetyError(container, 'demo', 'unavailable');
  });
  assert.deepEqual(results, [error, error, error]);
  container.HostConfig.SecurityOpt = 'invalid';
  assert.equal(configSafetyError(container, 'demo', 'unavailable'), error);
});

test('resume reloads stored host settings when the live service still rejects the factory hostname', async () => {
  const f = fixture();
  try {
    await factoryCommand(['new', 'demo', '--image', 'example-factory:test'], f.io);
    const run = f.docker.run.bind(f.docker);
    let restarted = false;
    f.docker.run = async (args, options) => {
      if (args.includes('s6-svc')) return { code: 127, stdout: '', stderr: 'executable file not found' };
      if (args.includes('/command/s6-svc')) restarted = true;
      if (args.includes('Host: demo.localhost') && !restarted) return { code: 0, stdout: '403', stderr: '' };
      return run(args, options);
    };
    assert.equal(await factoryCommand(['configure', 'demo', '--resume', '--step', 'service'], f.io), 0);
    assert.equal(restarted, true);
  } finally { f.cleanup(); }
});

test('the service check preserves hostname authentication and measures health over container loopback', async () => {
  const f = fixture();
  try {
    const run = f.docker.run.bind(f.docker);
    f.docker.run = async (args, options) => {
      if (args.includes('node') && args.some((value) => value.includes('allowedHosts'))) return { code: 0, stdout: '{"changed":false}', stderr: '' };
      if (args.includes('Host: demo.localhost')) return { code: args.includes('-fsS') ? 22 : 0, stdout: '401', stderr: '' };
      return run(args, options);
    };
    assert.equal(await factoryCommand(['new', 'demo', '--image', 'example-factory:test'], f.io), 0);
    assert.equal(f.calls.some(({ args }) => args.includes('/command/s6-svc')), false);
    const flow = JSON.parse(fs.readFileSync(path.join(f.io.env.HERDR_FACTORIES_DIR, 'demo', 'flow.json'), 'utf8'));
    assert.equal(flow.steps[3].health.status, 200);
    assert.equal(flow.steps[3].hostname.status, 401);
  } finally { f.cleanup(); }
});

test('the service configuration script writes valid JSON and preserves other settings', async () => {
  const f = fixture();
  try {
    const config = path.join(f.root, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ chromePath: '/usr/bin/chromium', allowedHosts: [] }));
    const run = f.docker.run.bind(f.docker);
    f.docker.run = async (args, options) => {
      if (args.includes('node') && args.some((value) => value.includes('allowedHosts'))) {
        const script = args[args.indexOf('-e') + 1].replace('/home/factory/.herdr-boss/config.json', config);
        return { code: 0, stdout: execFileSync(process.execPath, ['-e', script, 'demo.localhost'], { encoding: 'utf8' }), stderr: '' };
      }
      return run(args, options);
    };
    assert.equal(await factoryCommand(['new', 'demo', '--image', 'example-factory:test'], f.io), 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(config, 'utf8')), { chromePath: '/usr/bin/chromium', allowedHosts: ['demo.localhost'] });
  } finally { f.cleanup(); }
});

test('list retains the legacy fleet forms and rejects missing identifiers', async () => {
  const f = fixture();
  try {
    const original = JSON.parse(fs.readFileSync(new URL('../docs/contracts/examples/factory-registry.valid.local-and-ssh.json', import.meta.url), 'utf8'));
    const file = path.join(f.io.env.HERDR_FACTORIES_DIR, 'fleet.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(original));
    assert.equal(await factoryCommand(['list', '--json'], f.io), 0);
    const expected = structuredClone(original);
    for (const host of expected.hosts) { delete host.address; delete host.dockerContext; }
    assert.deepEqual(JSON.parse(f.output.join('')), expected);
    for (const word of ['address', 'dockerContext', 'keyFile', 'host-b-context', 'host-b.example']) assert.equal(f.output.join('').includes(word), false, word);
    const invalid = structuredClone(original);
    delete invalid.factories[0].factoryId;
    fs.writeFileSync(file, JSON.stringify(invalid));
    await assert.rejects(factoryCommand(['list'], f.io), /invalid/);
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(invalid));
  } finally { f.cleanup(); }
});

test('parallel creation on different hosts retains both factories in the fleet registry', async () => {
  const first = fixture('alpha');
  const second = fixture('bravo');
  try {
    second.io.env = first.io.env;
    await factoryCommand(['host', 'add', 'host-a', '--docker-context', 'example-a'], first.io);
    await factoryCommand(['host', 'add', 'host-b', '--docker-context', 'example-b'], first.io);
    let signalStarted;
    const started = new Promise((resolve) => { signalStarted = resolve; });
    let releaseStart;
    const released = new Promise((resolve) => { releaseStart = resolve; });
    const run = first.docker.run.bind(first.docker);
    first.docker.run = async (args, options) => {
      if (args[0] === 'start') { signalStarted(); await released; }
      return run(args, options);
    };
    const alpha = factoryCommand(['new', 'alpha', '--host', 'host-a', '--image', 'example-factory:test'], first.io);
    await started;
    try { assert.equal(await factoryCommand(['new', 'bravo', '--host', 'host-b', '--image', 'example-factory:test'], second.io), 0); }
    finally { releaseStart(); }
    assert.equal(await alpha, 0);
    const fleet = JSON.parse(fs.readFileSync(path.join(first.io.env.HERDR_FACTORIES_DIR, 'fleet.json'), 'utf8'));
    assert.deepEqual(fleet.factories.map((record) => record.name).sort(), ['alpha', 'bravo']);
    assert.deepEqual(fleet.hosts.map((record) => record.hostId).sort(), ['host-a', 'host-b']);
  } finally { first.cleanup(); second.cleanup(); }
});

test('the host identifier can differ from its private connection reference', async () => {
  const f = fixture();
  try {
    await factoryCommand(['host', 'add', 'host-a', '--docker-context', 'example-context'], f.io);
    await factoryCommand(['new', 'demo', '--host', 'host-a', '--image', 'example-factory:test'], f.io);
    const file = path.join(f.io.env.HERDR_FACTORIES_DIR, 'fleet.json');
    const fleet = JSON.parse(fs.readFileSync(file, 'utf8'));
    fleet.hosts[0].hostId = 'fleet-host';
    fleet.factories[0].hostId = 'fleet-host';
    fs.writeFileSync(file, JSON.stringify(fleet));
    const recordFile = path.join(f.io.env.HERDR_FACTORIES_DIR, 'demo', 'factory.json');
    const local = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    local.hostId = 'fleet-host';
    fs.writeFileSync(recordFile, JSON.stringify(local));
    let selected;
    f.io.transportFactory = (host) => { selected = host; return f.docker; };
    assert.equal(await factoryCommand(['status', 'demo', '--json'], f.io), 0);
    assert.equal(selected.dockerContext, 'example-context');
  } finally { f.cleanup(); }
});

const FOREIGN_IMAGE = [{ Config: { Labels: {} } }];

async function created(f, extra = []) {
  assert.equal(await factoryCommand(['new', 'demo', '--image', 'example-factory:test', ...extra], f.io), 0);
  f.output.length = 0;
}

test('the fleet minimum version is a floor that a lower fleet value cannot reduce', async () => {
  const f = fixture();
  try {
    const run = f.docker.run.bind(f.docker);
    f.docker.run = async (args, options) => {
      if (args[0] === 'exec' && args.includes('curl') && !args.includes('%{http_code}')) return { code: 0, stdout: JSON.stringify({ ...health, version: '0.0.5' }), stderr: '' };
      return run(args, options);
    };
    const file = path.join(f.io.env.HERDR_FACTORIES_DIR, 'fleet.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schema: 1, contractVersion: '1.0.0', minimumFactoryVersion: '0.0.1', hosts: [], factories: [] }));
    await assert.rejects(factoryCommand(['new', 'demo', '--image', 'example-factory:test'], f.io), /minimum version 0\.1\.0/);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).factories.length, 0);
  } finally { f.cleanup(); }
  const g = fixture();
  try {
    await created(g);
    const file = path.join(g.io.env.HERDR_FACTORIES_DIR, 'fleet.json');
    const fleet = JSON.parse(fs.readFileSync(file, 'utf8'));
    fleet.minimumFactoryVersion = '0.0.1';
    fleet.factories[0].version = '0.0.5';
    fs.writeFileSync(file, JSON.stringify(fleet));
    const before = g.calls.length;
    await assert.rejects(factoryCommand(['stop', 'demo'], g.io), /minimum version 0\.1\.0/);
    assert.equal(g.calls.slice(before).some(({ args }) => args[0] === 'stop'), false);
    assert.equal(await factoryCommand(['status', 'demo', '--json'], g.io), 0);
    assert.equal(JSON.parse(g.output.join('').split('\n')[0]).minimumFactoryVersion, '0.1.0');
  } finally { g.cleanup(); }
});

test('build refuses an existing image tag that this tool did not build', async () => {
  const f = fixture();
  try {
    const run = f.docker.run.bind(f.docker);
    f.docker.run = async (args, options) => (args[0] === 'image' && args[1] === 'inspect' ? { code: 0, stdout: JSON.stringify(FOREIGN_IMAGE), stderr: '' } : run(args, options));
    await assert.rejects(factoryCommand(['build', 'demo', '--image', 'postgres:16'], f.io), /build metadata/);
    assert.equal(f.calls.some(({ args }) => args[0] === 'buildx' && args[1] === 'build'), false);
  } finally { f.cleanup(); }
  const g = fixture();
  try {
    assert.equal(await factoryCommand(['build', 'demo', '--image', 'example-factory:test'], g.io), 0);
    assert.ok(g.calls.some(({ args }) => args[0] === 'buildx' && args[1] === 'build'));
  } finally { g.cleanup(); }
});

test('the BuildKit container is bounded and its image comes from the pins file', async () => {
  const f = fixture();
  try {
    f.imageAvailable = false;
    await factoryCommand(['new', 'demo'], f.io);
    const args = f.calls.find((call) => call.args[0] === 'run').args;
    for (const flag of ['--cpus', '--memory', '--memory-swap', '--pids-limit']) assert.ok(args.includes(flag), flag);
    const pins = JSON.parse(fs.readFileSync(new URL('../factory/pins.json', import.meta.url), 'utf8'));
    const image = `${pins.buildkit.image}:${pins.buildkit.tag}${pins.buildkit.digest ? `@${pins.buildkit.digest}` : ''}`;
    assert.equal(args.at(-1), image);
    assert.match(fs.readFileSync(new URL('../docs/factory-host-runbook.md', import.meta.url), 'utf8'), /privileged/i);
  } finally { f.cleanup(); }
});

test('the wizard refuses host namespaces, devices and an unconfined AppArmor profile', async () => {
  const cases = [['Devices', [{ PathOnHost: '/dev/fuse' }]], ['PidMode', 'host'], ['NetworkMode', 'host'], ['IpcMode', 'host'], ['UsernsMode', 'host'], ['SecurityOpt', ['seccomp=example-profile', 'systempaths=unconfined', 'apparmor=unconfined']]];
  for (const [field, value] of cases) {
    const f = fixture();
    try {
      await created(f);
      f.container.HostConfig[field] = value;
      assert.equal(await factoryCommand(['configure', 'demo', '--step', 'container'], f.io), 1, field);
      assert.ok(f.calls.some(({ args }) => args.includes('node') && args.some((word) => word.includes('allowedKinds'))), field);
    } finally { f.cleanup(); }
  }
  const f = fixture();
  try {
    await created(f);
    Object.assign(f.container.HostConfig, { Devices: [], PidMode: '', NetworkMode: 'bridge', IpcMode: 'private', UsernsMode: '' });
    assert.equal(await factoryCommand(['configure', 'demo', '--step', 'container'], f.io), 0);
  } finally { f.cleanup(); }
});

test('a resumed unsafe container is not started', async () => {
  const f = fixture();
  try {
    const run = f.docker.run.bind(f.docker);
    let failStart = true;
    f.docker.run = async (args, options) => (args[0] === 'start' && failStart ? { code: 1, stdout: '', stderr: 'start failed' } : run(args, options));
    await assert.rejects(factoryCommand(['new', 'demo', '--image', 'example-factory:test'], f.io), /Docker operation failed/);
    failStart = false;
    f.container.HostConfig.PidMode = 'host';
    const before = f.calls.length;
    await assert.rejects(factoryCommand(['new', 'demo', '--image', 'example-factory:test'], f.io), /host namespace|safety|profile/i);
    assert.equal(f.calls.slice(before).some(({ args }) => args[0] === 'start'), false);
    assert.equal(f.container.State.Running, false);
  } finally { f.cleanup(); }
});

test('the local transport selects the orbstack context by argument and clears Docker environment overrides', async () => {
  const seen = [];
  const spawn = (command, args, options) => {
    seen.push({ args, env: options.env });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => { child.stdout.end(); child.stderr.end(); child.emit('close', 0); });
    return child;
  };
  const env = { PATH: '/usr/bin', DOCKER_HOST: 'tcp://other.example:2375', DOCKER_CONTEXT: 'other' };
  await createDockerTransport({ transport: 'local', runtime: 'orbstack' }, { spawn, env }).run(['ps']);
  await createDockerTransport({ transport: 'docker-context', dockerContext: 'example-context' }, { spawn, env }).run(['ps']);
  assert.deepEqual(seen[0].args, ['--context', 'orbstack', 'ps']);
  assert.deepEqual(seen[1].args, ['--context', 'example-context', 'ps']);
  for (const { env: childEnv } of seen) {
    assert.equal('DOCKER_HOST' in childEnv, false);
    assert.equal('DOCKER_CONTEXT' in childEnv, false);
    assert.equal(childEnv.PATH, '/usr/bin');
  }
});

test('list --json prints contract fields only, also for an old inline host record', async () => {
  const f = fixture();
  try {
    await factoryCommand(['host', 'add', 'host-a', '--docker-context', 'example-context'], f.io);
    await created(f, ['--host', 'host-a']);
    const file = path.join(f.io.env.HERDR_FACTORIES_DIR, 'fleet.json');
    const fleet = JSON.parse(fs.readFileSync(file, 'utf8'));
    Object.assign(fleet.hosts[0], { address: 'host-a.example', dockerContext: 'example-context' });
    delete fleet.hosts[0].connectionRef;
    fs.writeFileSync(file, JSON.stringify(fleet));
    assert.equal(await factoryCommand(['list', '--json'], f.io), 0);
    const text = f.output.join('');
    for (const word of ['address', 'dockerContext', 'keyFile', 'example-context', 'host-a.example']) assert.equal(text.includes(word), false, word);
    assert.deepEqual(Object.keys(JSON.parse(text).hosts[0]).sort(), ['codexSandbox', 'hostId', 'personalOnly', 'runtime', 'transport']);
  } finally { f.cleanup(); }
});

test('a stale fleet lock is removed and a live fresh lock still blocks', async () => {
  const f = fixture();
  try {
    const directory = f.io.env.HERDR_FACTORIES_DIR;
    const lock = path.join(directory, 'fleet.lock');
    fs.mkdirSync(directory, { recursive: true });
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    fs.writeFileSync(lock, `${dead.stdout}\n`);
    updateFleet(f.io.env, () => {});
    assert.equal(fs.existsSync(lock), false);
    fs.writeFileSync(lock, `${process.pid}\n`);
    assert.throws(() => updateFleet(f.io.env, () => {}), /busy/);
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lock, old, old);
    updateFleet(f.io.env, () => {});
    assert.equal(fs.existsSync(lock), false);
  } finally { f.cleanup(); }
});

test('the builder registry write waits for the registry lock and the local entry is not listed', async () => {
  const f = fixture();
  try {
    const directory = f.io.env.HERDR_FACTORIES_DIR;
    fs.mkdirSync(directory, { recursive: true });
    const lock = path.join(directory, 'registry.lock');
    fs.writeFileSync(lock, `${process.pid}\n`);
    f.imageAvailable = false;
    await assert.rejects(factoryCommand(['new', 'demo'], f.io), /busy/);
    assert.equal(f.calls.some(({ args }) => args[0] === 'buildx' && args[1] === 'build'), false);
    fs.rmSync(lock);
    assert.equal(await factoryCommand(['new', 'demo'], f.io), 0);
    assert.equal(fs.existsSync(lock), false);
    f.output.length = 0;
    assert.equal(await factoryCommand(['host', 'list'], f.io), 0);
    assert.equal(f.output.join(''), 'No hosts.\n');
  } finally { f.cleanup(); }
});
