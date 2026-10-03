import './helpers/test-env.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import test, { mock } from 'node:test';
import { factoryCommand, maskLine, shellQuote } from '../src/factory-host.js';

const ADDRESS = '192.0.2.1';
const KEY = 'id_example';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-factory-host-'));
  const dir = path.join(root, 'factories');
  const keyFile = path.join(root, KEY);
  fs.writeFileSync(keyFile, 'KEY-CONTENT-MARKER-0001\n', { mode: 0o600 });
  const out = [];
  const err = [];
  const calls = [];
  const io = (spawn, stdin = Readable.from([])) => ({
    env: { HERDR_FACTORIES_DIR: dir, HOME: root },
    spawn,
    stdin,
    stdout: { write: (text) => { out.push(text); } },
    stderr: { write: (text) => { err.push(text); } },
  });
  return { root, dir, keyFile, out, err, calls, io, text: () => out.join(''), errText: () => err.join(''), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// A fake ssh process: it writes the scripted chunks and closes with the exit code.
function fakeSpawn(calls, { stdout = [], stderr = [], code = 0, error } = {}) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      if (error) { child.emit('error', error); return; }
      for (const chunk of stdout) child.stdout.write(chunk);
      for (const chunk of stderr) child.stderr.write(chunk);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', code, null));
    });
    return child;
  };
}

async function addHost(f, name = 'box') {
  const code = await factoryCommand(['host', 'add', name, '--address', ADDRESS, '--user', 'builder', '--key-file', f.keyFile], f.io(fakeSpawn(f.calls)));
  assert.equal(code, 0);
  f.out.length = 0;
}

test('host add writes the registry with file mode 600 and directory mode 700', async () => {
  const f = fixture();
  try {
    await addHost(f);
    const file = path.join(f.dir, 'registry.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(f.dir).mode & 0o777, 0o700);
    const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(registry.hosts.box, { address: ADDRESS, user: 'builder', keyFile: f.keyFile, transport: 'ssh' });
    assert.equal(f.text().includes(ADDRESS), false);
  } finally { f.cleanup(); }
});

test('the registry holds no key content and the tool never reads the key file', async () => {
  const f = fixture();
  try {
    await addHost(f);
    const raw = fs.readFileSync(path.join(f.dir, 'registry.json'), 'utf8');
    assert.equal(raw.includes('KEY-CONTENT-MARKER'), false);
    assert.deepEqual(Object.keys(JSON.parse(raw).hosts.box).sort(), ['address', 'keyFile', 'transport', 'user']);
  } finally { f.cleanup(); }
});

test('host add reads JSON from --from-file - and from stdin without an address flag', async () => {
  const f = fixture();
  try {
    const json = JSON.stringify({ address: ADDRESS, user: 'builder', keyFile: f.keyFile });
    assert.equal(await factoryCommand(['host', 'add', 'one', '--from-file', '-'], f.io(fakeSpawn(f.calls), Readable.from([json]))), 0);
    assert.equal(await factoryCommand(['host', 'add', 'two'], f.io(fakeSpawn(f.calls), Readable.from([json]))), 0);
    const file = path.join(f.root, 'host.json');
    fs.writeFileSync(file, json);
    assert.equal(await factoryCommand(['host', 'add', 'three', '--from-file', file], f.io(fakeSpawn(f.calls))), 0);
    const registry = JSON.parse(fs.readFileSync(path.join(f.dir, 'registry.json'), 'utf8'));
    assert.deepEqual(Object.keys(registry.hosts).sort(), ['one', 'three', 'two']);
    assert.equal(registry.hosts.two.address, ADDRESS);
  } finally { f.cleanup(); }
});

test('host add refuses bad input without echoing the values', async () => {
  const f = fixture();
  try {
    const bad = [
      ['host', 'add', 'Bad Name', '--address', ADDRESS, '--user', 'u', '--key-file', f.keyFile],
      ['host', 'add', 'box', '--address', '-oProxyCommand=x', '--user', 'u', '--key-file', f.keyFile],
      ['host', 'add', 'box', '--address', ADDRESS, '--user', 'u', '--key-file', 'relative/key'],
      ['host', 'add', 'box', '--address', ADDRESS, '--user', 'u'],
    ];
    for (const args of bad) await assert.rejects(factoryCommand(args, f.io(fakeSpawn(f.calls))), (error) => {
      assert.equal(error.message.includes(ADDRESS), false);
      assert.equal(error.message.includes(f.keyFile), false);
      return true;
    });
    await addHost(f);
    await assert.rejects(factoryCommand(['host', 'add', 'box', '--address', ADDRESS, '--user', 'u', '--key-file', f.keyFile], f.io(fakeSpawn(f.calls))), /already/i);
  } finally { f.cleanup(); }
});

test('host list prints the name and the user only', async () => {
  const f = fixture();
  try {
    await addHost(f);
    assert.equal(await factoryCommand(['host', 'list'], f.io(fakeSpawn(f.calls))), 0);
    const text = f.text();
    assert.match(text, /box\s+builder/);
    assert.equal(text.includes(ADDRESS), false);
    assert.equal(text.includes(f.keyFile), false);
    assert.equal(text.includes(KEY), false);
  } finally { f.cleanup(); }
});

test('host remove deletes a host and refuses an unknown name', async () => {
  const f = fixture();
  try {
    await addHost(f);
    assert.equal(await factoryCommand(['host', 'remove', 'box'], f.io(fakeSpawn(f.calls))), 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, 'registry.json'), 'utf8')).hosts, {});
    await assert.rejects(factoryCommand(['host', 'remove', 'box'], f.io(fakeSpawn(f.calls))), /not in the registry/);
  } finally { f.cleanup(); }
});

test('ssh refuses a host that is not in the registry and starts no process', async () => {
  const f = fixture();
  try {
    await assert.rejects(factoryCommand(['ssh', 'nohost', '--', 'uptime'], f.io(fakeSpawn(f.calls))), /not in the registry/);
    assert.equal(f.calls.length, 0);
  } finally { f.cleanup(); }
});

test('ssh spawns ssh with an args array, no shell, and passes the exit code', async () => {
  const f = fixture();
  try {
    await addHost(f);
    const code = await factoryCommand(['ssh', 'box', '--', 'uptime', '-p'], f.io(fakeSpawn(f.calls, { stdout: ['up 3 days\n'], code: 7 })));
    assert.equal(code, 7);
    assert.equal(f.calls.length, 1);
    const [call] = f.calls;
    assert.equal(call.command, 'ssh');
    assert.deepEqual(call.args, ['-i', f.keyFile, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new', '--', `builder@${ADDRESS}`, 'uptime', '-p']);
    assert.notEqual(call.options?.shell, true);
    assert.equal(f.text(), 'up 3 days\n');
  } finally { f.cleanup(); }
});

test('ssh needs a command after --', async () => {
  const f = fixture();
  try {
    await addHost(f);
    await assert.rejects(factoryCommand(['ssh', 'box'], f.io(fakeSpawn(f.calls))), /Usage/);
    await assert.rejects(factoryCommand(['ssh', 'box', '--'], f.io(fakeSpawn(f.calls))), /Usage/);
  } finally { f.cleanup(); }
});

test('ssh masks the address, the host name, an IP, and the key path in stdout and stderr', async () => {
  const f = fixture();
  try {
    await addHost(f, 'boxname');
    const spawn = fakeSpawn(f.calls, {
      stdout: [`host boxname at ${ADDRESS} uses ${f.keyFile}\n`],
      stderr: [
        `Warning: Permanently added '${ADDRESS}' (ED25519) to the list of known hosts.\n`,
        'ssh: connect to host 192.0.',
        `2.1 port 22: Connection refused\nIdentity file ${f.keyFile} not accessible\nroute to 198.51.100.7 failed\n`,
      ],
      code: 255,
    });
    const code = await factoryCommand(['ssh', 'boxname', '--', 'true'], f.io(spawn));
    assert.equal(code, 255);
    const all = f.text() + f.errText();
    for (const secret of [ADDRESS, '198.51.100.7', 'boxname', f.keyFile, KEY, f.root]) assert.equal(all.includes(secret), false, `leaked ${secret}`);
    assert.match(f.errText(), /Connection refused/);
    assert.match(f.errText(), /Permanently added/);
  } finally { f.cleanup(); }
});

test('ssh masks a domain host name in a resolver error', async () => {
  const f = fixture();
  try {
    await factoryCommand(['host', 'add', 'dom', '--address', 'box.example.invalid', '--user', 'builder', '--key-file', f.keyFile], f.io(fakeSpawn(f.calls)));
    const spawn = fakeSpawn(f.calls, { stderr: ['ssh: Could not resolve hostname box.example.invalid: Name or service not known\n'], code: 255 });
    assert.equal(await factoryCommand(['ssh', 'dom', '--', 'true'], f.io(spawn)), 255);
    assert.equal(f.errText().includes('box.example.invalid'), false);
    assert.match(f.errText(), /Could not resolve hostname/);
  } finally { f.cleanup(); }
});

test('a spawn failure prints a masked message and exits 255', async () => {
  const f = fixture();
  try {
    await addHost(f);
    const error = new Error(`spawn ssh ENOENT for ${ADDRESS} with ${f.keyFile}`);
    const code = await factoryCommand(['ssh', 'box', '--', 'true'], f.io(fakeSpawn(f.calls, { error })));
    assert.equal(code, 255);
    const all = f.text() + f.errText();
    assert.equal(all.includes(ADDRESS), false);
    assert.equal(all.includes(f.keyFile), false);
    assert.match(f.errText(), /ssh/);
    const throwing = () => { throw new Error(`boom ${ADDRESS} ${f.keyFile}`); };
    await assert.rejects(factoryCommand(['ssh', 'box', '--', 'true'], f.io(throwing)), (e) => !e.message.includes(ADDRESS) && !e.message.includes(f.keyFile));
  } finally { f.cleanup(); }
});

test('docker runs docker on the host through the ssh transport with quoted arguments', async () => {
  const f = fixture();
  try {
    await addHost(f);
    const code = await factoryCommand(['docker', 'box', '--', 'ps', '--format', '{{.Names}} x', "it's"], f.io(fakeSpawn(f.calls, { stdout: ['ok\n'] })));
    assert.equal(code, 0);
    const [call] = f.calls;
    assert.equal(call.command, 'ssh');
    assert.deepEqual(call.args.slice(0, 10), ['-i', f.keyFile, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new', '--', `builder@${ADDRESS}`]);
    assert.deepEqual(call.args.slice(10), ['docker', 'ps', '--format', "'{{.Names}} x'", `'it'\\''s'`]);
    await assert.rejects(factoryCommand(['docker', 'nohost', '--', 'ps'], f.io(fakeSpawn(f.calls))), /not in the registry/);
  } finally { f.cleanup(); }
});

test('shellQuote and maskLine are pure', () => {
  assert.equal(shellQuote('abc-1.2/x'), 'abc-1.2/x');
  assert.equal(shellQuote('a b'), "'a b'");
  assert.equal(shellQuote(''), "''");
  assert.equal(maskLine('x 192.0.2.1 y', { address: 'h.example.invalid', name: 'n', keyFile: '/k/id' }), 'x <host> y');
});

test('an unknown subcommand prints usage', async () => {
  const f = fixture();
  try {
    await assert.rejects(factoryCommand(['nope'], f.io(fakeSpawn(f.calls))), /Usage/);
    await assert.rejects(factoryCommand([], f.io(fakeSpawn(f.calls))), /Usage/);
  } finally { f.cleanup(); }
});

test('ssh refuses a remote command that starts with a dash', async () => {
  const f = fixture();
  try {
    await addHost(f);
    await assert.rejects(factoryCommand(['ssh', 'box', '--', '-oProxyCommand=touch /tmp/x', 'id'], f.io(fakeSpawn(f.calls))), /must not start with/);
    assert.equal(f.calls.length, 0);
  } finally { f.cleanup(); }
});

test('maskLine masks compressed IPv6 addresses', () => {
  for (const ip of ['2606:4700::6810:84e5', 'fe80::1', '2001:db8::1']) {
    const out = maskLine(`Connection to ${ip} port 22 timed out`, { address: 'example.invalid', keyFile: '/k' });
    assert.ok(!out.includes(ip), out);
  }
});

test('docker uses the registered Docker context without a shell and masks its private name', async () => {
  const f = fixture();
  try {
    await addHost(f);
    const file = path.join(f.dir, 'registry.json');
    const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
    registry.hosts.box.dockerContext = 'example-context';
    fs.writeFileSync(file, JSON.stringify(registry));
    const code = await factoryCommand(['docker', 'box', '--', 'ps', '--format', '{{.Names}} x'], f.io(fakeSpawn(f.calls, {
      stdout: ['ok\n'], stderr: ['context example-context: host 192.0.2.1\n'], code: 7,
    })));
    assert.equal(code, 7);
    assert.equal(f.calls[0].command, 'docker');
    assert.deepEqual(f.calls[0].args, ['--context', 'example-context', 'ps', '--format', '{{.Names}} x']);
    assert.equal(f.calls[0].options.shell, false);
    assert.equal('DOCKER_CONTEXT' in f.calls[0].options.env, false);
    assert.equal(f.errText().includes('example-context'), false);
    assert.equal(f.errText().includes(ADDRESS), false);
  } finally { f.cleanup(); }
});

test('host add accepts a context name without reading a key or printing the context', async () => {
  const f = fixture();
  try {
    assert.equal(await factoryCommand(['host', 'add', 'box', '--docker-context', 'example-context'], f.io(fakeSpawn(f.calls))), 0);
    const record = JSON.parse(fs.readFileSync(path.join(f.dir, 'registry.json'), 'utf8')).hosts.box;
    assert.deepEqual(record, { transport: 'docker-context', dockerContext: 'example-context' });
    assert.equal(f.text().includes('example-context'), false);
    await assert.rejects(factoryCommand(['host', 'add', 'bad', '--docker-context', '-bad'], f.io(fakeSpawn(f.calls))), /context/i);
    assert.equal(fs.statSync(path.join(f.dir, 'registry.json')).mode & 0o777, 0o600);
  } finally { f.cleanup(); }
});

test('host add updates only the context of an existing SSH record', async () => {
  const f = fixture();
  try {
    await addHost(f);
    assert.equal(await factoryCommand(['host', 'add', 'box', '--docker-context', 'example-context'], f.io(fakeSpawn(f.calls))), 0);
    const host = JSON.parse(fs.readFileSync(path.join(f.dir, 'registry.json'), 'utf8')).hosts.box;
    assert.equal(host.address, ADDRESS);
    assert.equal(host.keyFile, f.keyFile);
    assert.equal(host.dockerContext, 'example-context');
    await assert.rejects(factoryCommand(['host', 'list'], { ...f.io(fakeSpawn(f.calls)), isContainer: () => true }), /inside a container/);
  } finally { f.cleanup(); }
});

async function contextHost(f) {
  if (!fs.existsSync(path.join(f.dir, 'registry.json'))) await addHost(f);
  const file = path.join(f.dir, 'registry.json');
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  registry.hosts.box.dockerContext = 'example-context';
  fs.writeFileSync(file, JSON.stringify(registry));
}

test('docker refuses a first word that starts with a dash on both transports', async () => {
  const f = fixture();
  try {
    await addHost(f);
    await assert.rejects(factoryCommand(['docker', 'box', '--', '--context', 'other', 'rm', '-f', 'db'], f.io(fakeSpawn(f.calls))), /must not start with/);
    await contextHost(f);
    await assert.rejects(factoryCommand(['docker', 'box', '--', '--context', 'other', 'rm', '-f', 'db'], f.io(fakeSpawn(f.calls))), /must not start with/);
    assert.equal(f.calls.length, 0);
  } finally { f.cleanup(); }
});

test('docker masks tailnet names, endpoints and the remote Name line', async () => {
  const f = fixture();
  try {
    await contextHost(f);
    const code = await factoryCommand(['docker', 'box', '--', 'info'], f.io(fakeSpawn(f.calls, {
      stdout: ['Name: winbox.tail1234.ts.net\nEndpoint: ssh://user@winbox.tail1234.ts.net\nServer at other.tail1234.ts.net\n'],
      stderr: ['dial tcp: lookup third.tail1234.ts.net\n'],
    })));
    assert.equal(code, 0);
    for (const text of [f.text(), f.errText()]) {
      assert.equal(text.includes('ts.net'), false);
      assert.equal(text.includes('winbox'), false);
      assert.equal(text.includes('ssh://'), false);
    }
    assert.match(f.text(), /Server at <host>/);
  } finally { f.cleanup(); }
});

test('the docker passthrough allows a command longer than the probe timeout', async () => {
  const f = fixture();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await contextHost(f);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    let spawned = false;
    const pending = factoryCommand(['docker', 'box', '--', 'pull', 'example-image'], f.io(() => { spawned = true; return child; }));
    while (!spawned) await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(20_000);
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0);
    assert.equal(await pending, 0);
  } finally { mock.timers.reset(); f.cleanup(); }
});
