import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { factoryCommand, updateRegistry } from '../src/factory-host.js';
import { writeFleet, writePrivate, factoryFile, updateFleet } from '../src/factory-store.js';
import { fleetCommand } from '../src/fleet-cli.js';

const fixtureSummary = JSON.parse(fs.readFileSync(new URL('../docs/contracts/examples/fleet-summary.valid.personal.json', import.meta.url)));
const token = `hf_read_${'a'.repeat(64)}`;
function fixture(t, hostUser = 'factory') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-connect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { HOME: root, HERDR_BOSS_DIR: path.join(root, 'data'), HERDR_FACTORIES_DIR: path.join(root, 'factories'), TMPDIR: root };
  updateRegistry(env, (registry) => { registry.hosts['example-host'] = { address: 'example.invalid', user: hostUser, keyFile: path.join(root, 'example-key'), dockerContext: 'example-context' }; });
  writeFleet(env, { schema: 1, contractVersion: '1.0.0', minimumFactoryVersion: '0.1.0', hosts: [{ hostId: 'example-host', transport: 'ssh', connectionRef: 'example-host', runtime: 'docker-engine-wsl2', personalOnly: true, codexSandbox: 'user-namespaces' }], factories: [{ factoryId: 'win1', name: 'win1', hostId: 'example-host', kind: 'container', containerName: 'hf-win1', hostname: 'win1.localhost', ports: { dashboard: 4478, ssh: 2222 }, profile: 'personal', dashboardUrl: 'http://win1.localhost:4478', version: '0.1.0', kitRevision: 'abcdef012345', image: { builtAt: '2026-10-03T00:00:00Z', pinsHash: 'a'.repeat(64) } }] });
  writePrivate(factoryFile(env, 'win1'), { name: 'win1', hostId: 'example-host', ports: { dashboard: 4478, ssh: 2222 } });
  const calls = [], output = [];
  let url = 'http://win1.localhost:4478', failImport = false, blocked = false, serveConflict = false, serveUnavailable = false, serveReady = false, openDashboard = false, serveFailure = null, serveStatusFailure = null, allowedChanged = false, headOffice = false;
  const json = (body) => ({ code: 0, stdout: JSON.stringify(body), stderr: '' });
  const settings = () => ({ factoryId: 'factory-win1', name: 'win1', dashboardUrl: url, headOffice: false, shareItemTitles: true, accounts: [] });
  const docker = { async run(args, options) {
    calls.push({ type: 'docker', args, options });
    if (args[0] === 'container') return json([{ Config: { Labels: { 'herdr-factory': 'win1' } }, State: { Running: true }, HostConfig: { PortBindings: { '4477/tcp': [{ HostIp: '127.0.0.1', HostPort: '4478' }] } } }]);
    if (args.includes('settings')) return json(settings());
    if (args.includes('init')) { url = JSON.parse(options.input).dashboardUrl; return json({}); }
    if (args.some((arg) => arg.includes('fleet-connect-token.json'))) return json(token);
    if (args.some((arg) => arg.includes('connect-undo'))) return json({ removed: allowedChanged });
    if (args.some((arg) => arg.includes('allowedHosts'))) return json({ changed: allowedChanged });
    if (args.includes('/command/s6-svc')) return json({});
    if (args.includes('curl')) return json({ schema: 1, contractVersion: '1.0.0', version: '0.1.0', kitRevision: 'abcdef012345' });
    throw new Error('Unexpected fake Docker call.');
  } };
  const host = { async run(args) {
    calls.push({ type: 'host', args });
    if (serveStatusFailure && args.includes('serve') && args.includes('status')) return { code: 1, stdout: '', stderr: serveStatusFailure };
    if (args.includes('status') && !args.includes('serve')) return json({ BackendState: 'Running', Self: { DNSName: 'example.invalid.', TailscaleIPs: ['192.0.2.1'] } });
    if (args.includes('status')) return json(serveReady ? { TCP: { [serveReady === 'https' ? 443 : 4478]: { [serveReady === 'https' ? 'HTTPS' : 'HTTP']: true } }, Web: { [`example.invalid:${serveReady === 'https' ? 443 : 4478}`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:4478' } } } } } : serveConflict ? { Web: { 'example.invalid:4478': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } } : {});
    if (args.includes('serve') && args.includes('off')) return json({});
    if (serveFailure && args.includes('serve')) return { code: 1, stdout: '', stderr: serveFailure };
    if (args.includes('serve')) return serveUnavailable ? { code: 1, stdout: '', stderr: 'sending serve config: Access denied: serve config denied\nUse sudo tailscale serve --bg --http=4478 http://192.0.2.1:4478\n' } : json({});
    throw new Error('Unexpected fake host call.');
  } };
  const io = { env, isContainer: () => false, transportFactory: () => docker, hostTransportFactory: () => host,
    stdout: { write: (line) => output.push(line) }, stderr: { write: (line) => output.push(line) }, now: () => Date.parse(fixtureSummary.generatedAt),
    importCredential: async (id, value) => {
      if (failImport) { failImport = false; throw new Error('PRIVATE import failed'); }
      await fleetCommand(['read-token', 'set', id, '--from-file', '-'], { privateDir: path.join(root, '.config', 'herdr-boss'), stdin: Readable.from([JSON.stringify(value)]), stdout: { write() {} } });
    },
    fetchImpl: async (endpoint, options) => {
      calls.push({ type: 'http', endpoint, method: options?.method || 'GET' });
      if (endpoint.startsWith('http://127.0.0.1:4477')) {
        if (options?.method === 'PUT') headOffice = JSON.parse(options.body).headOffice;
        return new Response(JSON.stringify({ ...settings(), headOffice }), { headers: { 'content-type': 'application/json' } });
      }
      if (blocked) throw Object.assign(new Error('PRIVATE route blocked'), { code: 'EHOSTUNREACH' });
      if (!options.headers?.authorization) return new Response('', { status: openDashboard ? 200 : 401 });
      assert.equal(options.headers.authorization, `Bearer ${token}`);
      return new Response(JSON.stringify({ ...fixtureSummary, factoryId: 'factory-win1', name: 'win1', dashboardUrl: url }), { headers: { 'content-type': 'application/json' } });
    } };
  return { root, env, calls, output, io, set failImport(value) { failImport = value; }, set blocked(value) { blocked = value; }, set serveConflict(value) { serveConflict = value; }, set serveUnavailable(value) { serveUnavailable = value; }, set serveReady(value) { serveReady = value; }, set openDashboard(value) { openDashboard = value; }, set serveFailure(value) { serveFailure = value; }, set serveStatusFailure(value) { serveStatusFailure = value; }, set allowedChanged(value) { allowedChanged = value; } };
}

test('connect uses private provisioning and a tailnet proxy, and repeated calls keep one registration', async (t) => {
  const f = fixture(t);
  delete f.io.importCredential;
  assert.equal(await factoryCommand(['connect', 'win1'], f.io), 0);
  assert.equal(await factoryCommand(['connect', 'win1'], f.io), 0);
  const fleet = JSON.parse(fs.readFileSync(path.join(f.env.HERDR_FACTORIES_DIR, 'fleet.json')));
  assert.equal(fleet.factories.length, 1);
  assert.equal(fleet.factories[0].factoryId, 'factory-win1');
  assert.equal(fleet.factories[0].dashboardUrl, 'http://example.invalid:4478');
  assert.equal(fs.statSync(path.join(f.root, '.config', 'herdr-boss', 'fleet-remotes.json')).mode & 0o777, 0o600);
  assert.doesNotMatch(f.output.join(''), /hf_read_|example.invalid|192\.0\.2\.1|example-key|example-context|PRIVATE/);
  assert.ok(f.calls.some((call) => call.type === 'host' && call.args.includes('--http=4478') && call.args.includes('http://127.0.0.1:4478')));
  assert.equal(f.calls.some((call) => call.type === 'docker' && ['rm', 'stop', 'create'].includes(call.args[0])), false);
  assert.doesNotMatch(JSON.stringify(f.calls), /0\.0\.0\.0|"::"|funnel/);
});

test('connect resumes a failed private import without a second factory record', async (t) => {
  const f = fixture(t); f.failImport = true;
  assert.equal(await factoryCommand(['connect', 'win1'], f.io), 1);
  assert.equal(await factoryCommand(['connect', 'win1'], f.io), 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.env.HERDR_FACTORIES_DIR, 'fleet.json'))).factories.length, 1);
  assert.doesNotMatch(f.output.join(''), /PRIVATE|hf_read_/);
});

test('connect --check polls once, prints name state and age only, and keeps the last good age on a blocked route', async (t) => {
  const f = fixture(t);
  await factoryCommand(['connect', 'win1'], f.io);
  f.calls.length = 0; f.output.length = 0;
  assert.equal(await factoryCommand(['connect', '--check', 'win1'], f.io), 0);
  assert.equal(f.output.join(''), 'win1 healthy 0s\n');
  assert.equal(f.calls.filter((call) => call.type === 'http').length, 1);
  assert.equal(f.calls.some((call) => call.type !== 'http'), false);
  f.blocked = true; f.output.length = 0;
  f.io.now = () => Date.parse(fixtureSummary.generatedAt) + 90000;
  assert.equal(await factoryCommand(['connect', '--check', 'win1'], f.io), 1);
  assert.equal(f.output.join(''), 'win1 offline 90s\n');
});

test('connect refuses a conflicting serve route without replacing it or publishing a wildcard port', async (t) => {
  const f = fixture(t); f.serveConflict = true;
  assert.equal(await factoryCommand(['connect', 'win1'], f.io), 1);
  assert.equal(f.calls.some((call) => call.type === 'host' && call.args.includes('--bg')), false);
  assert.doesNotMatch(f.output.join(''), /example.invalid|PRIVATE|hf_read_/);
});

test('connect waits for the Owner without a root fallback when the operator right is missing', async (t) => {
  const f = fixture(t); f.serveUnavailable = true;
  assert.equal(await factoryCommand(['connect', 'win1'], f.io), 3);
  assert.match(f.output.join(''), /sending serve config: Access denied: serve config denied/);
  assert.match(f.output.join(''), /sudo tailscale set --operator=factory/);
  assert.match(f.output.join(''), /sudo tailscale serve --bg 4478/);
  assert.doesNotMatch(f.output.join(''), /192\.0\.2\.1|example.invalid|example-key|hf_read_/);
  assert.equal(f.calls.some((call) => call.type === 'host' && call.args.includes('sudo')), false);
  assert.equal(fs.existsSync(path.join(f.root, '.config', 'herdr-boss', 'fleet-remotes.json')), false);
  f.serveUnavailable = false;
  assert.equal(await factoryCommand(['connect', 'win1'], f.io), 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.env.HERDR_FACTORIES_DIR, 'fleet.json'))).factories.length, 1);
});

test('connect reuses an Owner-provisioned HTTP or HTTPS Serve route without an operator right', async (t) => {
  for (const mode of ['http', 'https']) {
    const f = fixture(t); f.serveUnavailable = true; f.serveReady = mode;
    assert.equal(await factoryCommand(['connect', 'win1'], f.io), 0);
    assert.equal(f.calls.some((call) => call.type === 'host' && call.args.includes('--bg')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.env.HERDR_FACTORIES_DIR, 'fleet.json'))).factories[0].dashboardUrl, mode === 'https' ? 'https://example.invalid' : 'http://example.invalid:4478');
  }
});

test('connect refuses a dashboard proxy that bypasses Owner access', async (t) => {
  const f = fixture(t); f.openDashboard = true;
  assert.equal(await factoryCommand(['connect', 'win1'], f.io), 1);
  assert.match(f.output.join(''), /dashboard-auth-required/);
  assert.equal(fs.existsSync(path.join(f.root, '.config', 'herdr-boss', 'fleet-remotes.json')), false);
});

test('the actual factory export script keeps its current credential across a retry', async (t) => {
  const f = fixture(t);
  const original = f.io.transportFactory();
  const exports = [];
  const remoteHome = path.join(f.root, 'remote-home');
  f.io.transportFactory = () => ({ async run(args, options) {
    const script = args.find((arg) => arg.includes('fleet-connect-token.json'));
    if (script) {
      const localScript = script.replaceAll('/home/factory/herdr-boss', process.cwd()).replaceAll('/home/factory', remoteHome);
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', localScript], { encoding: 'utf8', env: { ...process.env, HOME: remoteHome, HERDR_BOSS_DIR: path.join(f.root, 'remote-data'), HERDR_FACTORIES_DIR: path.join(f.root, 'remote-factories') } });
      assert.equal(result.status, 0, 'the private export script must finish');
      exports.push(JSON.parse(result.stdout));
    }
    return original.run(args, options);
  } });
  await factoryCommand(['connect', 'win1'], f.io);
  await factoryCommand(['connect', 'win1'], f.io);
  assert.equal(exports.length, 2);
  assert.match(exports[0], /^hf_read_[a-f0-9]{64}$/);
  assert.equal(exports[1], exports[0]);
  const exportFile = path.join(remoteHome, '.config', 'herdr-boss', 'fleet-connect-token.json');
  assert.equal(fs.statSync(exportFile).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(exportFile)), exports[0]);
});

test('a cloned factory ID cannot replace another registered factory read credential', async (t) => {
  const f = fixture(t);
  updateFleet(f.env, (fleet) => {
    fleet.factories.push({ ...fleet.factories[0], name: 'win2', factoryId: 'factory-win1', containerName: 'hf-win2', hostname: 'win2.localhost', ports: { dashboard: 4479, ssh: 2223 } });
  });
  const privateFile = path.join(f.root, '.config', 'herdr-boss', 'fleet-remotes.json');
  const previous = `hf_read_${'b'.repeat(64)}`;
  writePrivate(privateFile, { 'factory-win1': previous });
  assert.equal(await factoryCommand(['connect', 'win1'], f.io), 1);
  assert.equal(JSON.parse(fs.readFileSync(privateFile))['factory-win1'], previous);
  assert.equal(f.calls.some((call) => call.type === 'docker' && call.args.includes('init')), false);
});

test('the Owner hint names the registered host user', async (t) => {
  const f = fixture(t, 'opuser'); f.serveUnavailable = true;
  assert.equal(await factoryCommand(['connect', 'win1'], f.io), 3);
  assert.match(f.output.join(''), /sudo tailscale set --operator=opuser\n/);
  assert.doesNotMatch(f.output.join(''), /--operator=factory/);
  const stored = fs.readdirSync(f.root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8')).join('');
  assert.doesNotMatch(stored, /--operator|sudo tailscale/);
});

test('only an access denied message waits for the Owner; other Serve failures fail without a wait', async (t) => {
  for (const [key, message] of [['serveFailure', 'Failed to connect to local tailscaled; it doesn\'t appear to be running'], ['serveFailure', 'not logged in: run tailscale up'], ['serveStatusFailure', 'Failed to connect to local tailscaled']]) {
    const f = fixture(t); f[key] = message;
    assert.equal(await factoryCommand(['connect', 'win1'], f.io), 1);
    const text = f.output.join('');
    assert.match(text, /serve-failed/);
    assert.doesNotMatch(text, /waiting for the Owner|serve-owner-required|sudo tailscale|example.invalid/);
    assert.equal(JSON.parse(fs.readFileSync(factoryFile(f.env, 'win1', 'connect.json'))).state, 'failed');
  }
  const f = fixture(t); f.serveStatusFailure = 'Access denied: serve config denied';
  assert.equal(await factoryCommand(['connect', 'win1'], f.io), 3);
});

test('the runbook states only the current Serve rule', () => {
  const text = fs.readFileSync(new URL('../docs/factory-host-runbook.md', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /did not permit Serve|password is required|diagnostic root status/i);
  assert.match(text, /operator right or an existing Serve forward/);
});

test('connect --undo removes only what connect created and a second undo finds nothing left', async (t) => {
  const f = fixture(t); f.allowedChanged = true;
  assert.equal(await factoryCommand(['connect', 'win1'], f.io), 0);
  const remotes = path.join(f.root, '.config', 'herdr-boss', 'fleet-remotes.json');
  writePrivate(remotes, { ...JSON.parse(fs.readFileSync(remotes)), 'other-factory': `hf_read_${'c'.repeat(64)}` });
  f.calls.length = 0; f.output.length = 0;
  assert.equal(await factoryCommand(['connect', '--undo', 'win1'], f.io), 0);
  const hostCalls = f.calls.filter((call) => call.type === 'host').map((call) => call.args.join(' '));
  assert.deepEqual(hostCalls, ['tailscale serve --http=4478 off']);
  assert.ok(f.calls.some((call) => call.type === 'docker' && call.args.some((arg) => arg.includes('connect-undo') && arg.includes('allowedHosts'))));
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(remotes))), ['other-factory']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.env.HERDR_FACTORIES_DIR, 'fleet.json'))).factories.length, 0);
  assert.equal(f.calls.some((call) => call.type === 'docker' && (['rm', 'stop'].includes(call.args[0]) || call.args.includes('fleet-connect-token.json'))), false);
  assert.doesNotMatch(f.output.join(''), /hf_read_|example.invalid|192\.0\.2\.1|PRIVATE/);
  assert.doesNotMatch(JSON.stringify(f.calls), /reset/);
  f.calls.length = 0; f.output.length = 0;
  assert.equal(await factoryCommand(['connect', '--undo', 'win1'], f.io), 0);
  assert.match(f.output.join(''), /nothing is left/);
  assert.equal(f.calls.length, 0);
});

test('connect --undo keeps an Owner-provisioned forward and an existing allowed host', async (t) => {
  const f = fixture(t); f.serveReady = 'http';
  assert.equal(await factoryCommand(['connect', 'win1'], f.io), 0);
  f.calls.length = 0;
  assert.equal(await factoryCommand(['connect', '--undo', 'win1'], f.io), 0);
  assert.equal(f.calls.some((call) => call.type === 'host'), false);
  assert.equal(f.calls.some((call) => call.type === 'docker' && call.args.some((arg) => arg.includes('connect-undo'))), false);
});

test('connect --undo turns head office off only when no other factory stays registered', async (t) => {
  for (const others of [false, true]) {
    const f = fixture(t);
    assert.equal(await factoryCommand(['connect', 'win1'], f.io), 0);
    if (others) updateFleet(f.env, (fleet) => { fleet.factories.push({ ...fleet.factories[0], name: 'win2', factoryId: 'factory-win2', containerName: 'hf-win2', hostname: 'win2.localhost', ports: { dashboard: 4479, ssh: 2223 } }); });
    f.calls.length = 0;
    assert.equal(await factoryCommand(['connect', '--undo', 'win1'], f.io), 0);
    assert.equal(f.calls.some((call) => call.type === 'http' && call.method === 'PUT'), !others);
  }
});

test('connect --undo keeps the registration when a step fails so that a retry finishes', async (t) => {
  const f = fixture(t);
  assert.equal(await factoryCommand(['connect', 'win1'], f.io), 0);
  const fleetFile = path.join(f.env.HERDR_FACTORIES_DIR, 'fleet.json');
  const original = f.io.hostTransportFactory;
  f.io.hostTransportFactory = () => ({ async run() { return { code: 1, stdout: '', stderr: 'Failed to connect to local tailscaled' }; } });
  assert.equal(await factoryCommand(['connect', '--undo', 'win1'], f.io), 1);
  assert.equal(JSON.parse(fs.readFileSync(fleetFile)).factories.length, 1);
  f.io.hostTransportFactory = original;
  assert.equal(await factoryCommand(['connect', '--undo', 'win1'], f.io), 0);
  assert.equal(JSON.parse(fs.readFileSync(fleetFile)).factories.length, 0);
});
