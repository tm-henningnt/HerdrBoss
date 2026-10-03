import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The data dir, home, and port are set before the modules load. No test touches ~/.herdr-boss or ~/.herdr-factories.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-host-guide-'));
const dataDir = path.join(root, 'data');
const homeDir = path.join(root, 'home');
const factoriesDir = path.join(root, 'factories');
for (const dir of [dataDir, homeDir, factoriesDir]) fs.mkdirSync(dir, { recursive: true });
process.env.HOME = homeDir;
process.env.HERDR_BOSS_DIR = dataDir;
process.env.HERDR_FACTORIES_DIR = factoriesDir;
process.env.HERDR_BOSS_PORT = '0';
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const guide = await import('../src/host-guide.js');
const { STEPS } = await import('../public/host-guide-data.js');
const { serve } = await import('../src/server.js');
const { loadConfig } = await import('../src/config.js');

// Invented host record. Nothing here belongs to a real host.
const ADDRESS = 'build-box.example-tailnet.ts.net';
const FINGERPRINT = `SHA256:${'B'.repeat(43)}`;
const GiB = 1024 ** 3;
const registryHost = { transport: 'ssh', address: ADDRESS, user: 'factory', keyFile: path.join(root, 'keys', 'build-box-key'), dockerContext: 'hf-build-box', runtime: 'docker-engine-wsl2' };
const writeRegistry = (hosts) => fs.writeFileSync(path.join(factoriesDir, 'registry.json'), JSON.stringify({ version: 1, hosts }));
const env = { ...process.env, HERDR_FACTORIES_DIR: factoriesDir };

function makeSpawn(handler) {
  const calls = [];
  const spawn = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    const remote = cmd === 'ssh' ? args.slice(args.indexOf('--') + 2).join(' ') : args.filter((arg) => arg !== '--context').slice(1).join(' ');
    setImmediate(async () => {
      const result = await handler({ cmd, args, remote });
      child.stdout.write(result.stdout || '');
      child.stderr.write(result.stderr || '');
      child.stdout.end();
      child.stderr.end();
      setTimeout(() => child.emit('close', result.code ?? 0), 5);
    });
    return child;
  };
  return { spawn, calls };
}

const HEALTHY = ({ cmd, remote }) => {
  if (cmd === 'ssh') {
    if (remote === 'uname -m') return { stdout: 'x86_64\n' };
    if (remote.startsWith('systemctl is-system-running')) return { stdout: 'running\n' };
    if (remote === 'sudo -n sshd -T') return { stdout: 'port 22\npasswordauthentication no\npubkeyauthentication yes\n' };
    if (remote === 'cat /proc/uptime') return { stdout: '300.25 280.10\n' };
  }
  if (cmd === 'docker') {
    if (remote.startsWith('ps')) return { stdout: 'abc123 Up 2 hours\n' };
    if (remote.startsWith('info')) return { stdout: `${47 * GiB}\n` };
  }
  return { code: 1, stderr: `unexpected ${cmd} ${remote}` };
};

let counter = 0;
const newLabel = () => `host-${(counter += 1)}`;
const clock = (start = Date.parse('2026-10-04T10:00:00Z')) => { const c = { t: start, now: () => c.t, advance: (ms) => { c.t += ms; } }; return c; };

function windowsGuide(label, now) {
  guide.updateGuide(dataDir, label, { type: 'windows-wsl2', values: { memoryGb: '48', tailnetName: ADDRESS, user: 'factory' } }, { now });
}
const run = (label, options = {}) => guide.runGuideChecks(dataDir, label, { env, ...options });

test('a new guide needs a valid host type and label, and the first save creates a private file', () => {
  const c = clock();
  assert.throws(() => guide.updateGuide(dataDir, 'host-x', { values: { role: 'factory' } }, { now: c.now }), /host type/i);
  assert.throws(() => guide.updateGuide(dataDir, 'host-x', { type: 'amiga' }, { now: c.now }), /host type/i);
  for (const bad of ['../x', 'A', 'a b', 'local', '', 'x'.repeat(40)]) assert.throws(() => guide.updateGuide(dataDir, bad, { type: 'linux' }, { now: c.now }), /label/i, bad);
  assert.equal(guide.readGuide(dataDir, 'host-x'), null);
  const state = guide.updateGuide(dataDir, 'host-x', { type: 'linux', values: { role: 'factory' } }, { now: c.now });
  assert.equal(state.label, 'host-x');
  assert.equal(state.type, 'linux');
  assert.equal(state.values.label, 'host-x');
  assert.equal(state.values.role, 'factory');
  const file = path.join(dataDir, 'host-guide', 'host-x.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(guide.readGuide(dataDir, 'host-x'), state);
});

test('saving the same patch again changes nothing, also not the file or the time', () => {
  const c = clock();
  const label = newLabel();
  const first = guide.updateGuide(dataDir, label, { type: 'windows-wsl2', values: { user: 'factory' }, done: { bios: true } }, { now: c.now });
  const file = path.join(dataDir, 'host-guide', `${label}.json`);
  const before = fs.readFileSync(file, 'utf8');
  const mtime = fs.statSync(file).mtimeMs;
  c.advance(60000);
  const second = guide.updateGuide(dataDir, label, { type: 'windows-wsl2', values: { user: 'factory' }, done: { bios: true } }, { now: c.now });
  assert.deepEqual(second, first);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
});

test('a value is checked on the server too, and an invalid or unknown value is refused with no change', () => {
  const c = clock();
  const label = newLabel();
  guide.updateGuide(dataDir, label, { type: 'windows-wsl2' }, { now: c.now });
  const file = path.join(dataDir, 'host-guide', `${label}.json`);
  const before = fs.readFileSync(file, 'utf8');
  for (const values of [{ tailnetName: 'x.example.com' }, { memoryGb: '0' }, { fingerprint: 'abc' }, { user: 'a;b' }, { keyName: '-----BEGIN OPENSSH PRIVATE KEY-----' }, { password: 'x' }, { label: 'other' }, { cpuCount: 12 }]) {
    assert.throws(() => guide.updateGuide(dataDir, label, { values }, { now: c.now }), guide.GuideError, JSON.stringify(Object.keys(values)));
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const saved = guide.updateGuide(dataDir, label, { values: { fingerprint: `256 ${FINGERPRINT} herdr-factory-x (ED25519)`, role: 'factory' } }, { now: c.now });
  assert.equal(saved.values.fingerprint, FINGERPRINT, 'the line is reduced to the fingerprint');
  const cleared = guide.updateGuide(dataDir, label, { values: { role: '' } }, { now: c.now });
  assert.equal('role' in cleared.values, false, 'an empty value removes the field');
});

test('a field of another host type is refused', () => {
  const c = clock();
  const label = newLabel();
  guide.updateGuide(dataDir, label, { type: 'mac-orbstack' }, { now: c.now });
  assert.throws(() => guide.updateGuide(dataDir, label, { values: { wslVersion: '2.4.8.0' } }, { now: c.now }), /host type/i);
});

test('a step is done only after the steps before it, and a step is not undone while a later step is done', () => {
  const c = clock();
  const label = newLabel();
  guide.updateGuide(dataDir, label, { type: 'windows-wsl2' }, { now: c.now });
  assert.throws(() => guide.updateGuide(dataDir, label, { done: { 'update-windows': true } }, { now: c.now }), (e) => e.status === 409 && /BIOS/.test(e.message));
  assert.throws(() => guide.updateGuide(dataDir, label, { done: { nonsense: true } }, { now: c.now }), (e) => e.status === 400);
  guide.updateGuide(dataDir, label, { done: { bios: true } }, { now: c.now });
  const two = guide.updateGuide(dataDir, label, { done: { 'update-windows': true } }, { now: c.now });
  assert.deepEqual(Object.keys(two.done), ['bios', 'update-windows']);
  assert.throws(() => guide.updateGuide(dataDir, label, { done: { bios: false } }, { now: c.now }), (e) => e.status === 409 && /Update Windows/.test(e.message));
  const undone = guide.updateGuide(dataDir, label, { done: { 'update-windows': false } }, { now: c.now });
  assert.deepEqual(Object.keys(undone.done), ['bios']);
  assert.deepEqual(guide.progress(undone), { done: 1, total: 25, next: 'update-windows' });
  // One patch may mark several steps in order.
  const many = guide.updateGuide(dataDir, label, { done: { 'update-windows': true, 'never-sleep': true } }, { now: c.now });
  assert.equal(guide.progress(many).done, 3);
});

test('the host type is fixed after the first step is done', () => {
  const c = clock();
  const label = newLabel();
  guide.updateGuide(dataDir, label, { type: 'windows-wsl2' }, { now: c.now });
  assert.equal(guide.updateGuide(dataDir, label, { type: 'linux' }, { now: c.now }).type, 'linux', 'a type change is free before a step is done');
  guide.updateGuide(dataDir, label, { done: { 'linux-update': true } }, { now: c.now });
  assert.throws(() => guide.updateGuide(dataDir, label, { type: 'windows-wsl2' }, { now: c.now }), (e) => e.status === 409);
  assert.equal(guide.updateGuide(dataDir, label, { type: 'linux' }, { now: c.now }).type, 'linux');
});

test('list shows the progress of each saved guide and skips a broken file', () => {
  const c = clock();
  const label = newLabel();
  guide.updateGuide(dataDir, label, { type: 'windows-wsl2', done: { bios: true } }, { now: c.now });
  fs.writeFileSync(path.join(dataDir, 'host-guide', 'broken.json'), '{not json');
  fs.writeFileSync(path.join(dataDir, 'host-guide', 'Bad Name.json'), '{}');
  const row = guide.listGuides(dataDir).find((item) => item.label === label);
  assert.deepEqual(row, { label, type: 'windows-wsl2', done: 1, total: 25, updatedAt: new Date(c.now()).toISOString() });
  assert.equal(guide.listGuides(dataDir).some((item) => item.label === 'broken'), false);
  assert.deepEqual(guide.listGuides(path.join(root, 'nowhere')), []);
});

test('evaluateSystemd accepts running, and degraded with systemd-binfmt.service as the only failed unit', () => {
  const binfmt = 'systemd-binfmt.service loaded failed failed Set Up Additional Binary Formats';
  assert.equal(guide.evaluateSystemd('running', '').ok, true);
  assert.equal(guide.evaluateSystemd('degraded', binfmt).ok, true);
  assert.match(guide.evaluateSystemd('degraded', binfmt).detail, /systemd-binfmt\.service/);
  const other = guide.evaluateSystemd('degraded', `${binfmt}\ndocker.service loaded failed failed Docker`);
  assert.equal(other.ok, false);
  assert.match(other.detail, /docker\.service/);
  assert.equal(guide.evaluateSystemd('degraded', '● systemd-binfmt.service loaded failed failed Set Up').ok, true, 'a bullet marker is ignored');
  assert.equal(guide.evaluateSystemd('degraded', '').ok, false);
  for (const state of ['offline', 'starting', 'maintenance', 'stopping', '']) assert.equal(guide.evaluateSystemd(state, '').ok, false, state);
  assert.equal(guide.evaluateSystemd('running', binfmt).ok, true);
});

test('memoryMatches compares the Docker memory with the limit of WSL', () => {
  assert.equal(guide.memoryMatches(47.2 * GiB, 48), true);
  assert.equal(guide.memoryMatches(48 * GiB, 48), true);
  assert.equal(guide.memoryMatches(62 * GiB, 48), false);
  assert.equal(guide.memoryMatches(20 * GiB, 48), false);
  assert.equal(guide.memoryMatches(Number.NaN, 48), false);
});

test('without a registry entry every check fails with the command that registers the host', async () => {
  const label = newLabel();
  const c = clock();
  windowsGuide(label, c.now);
  writeRegistry({});
  const { spawn, calls } = makeSpawn(HEALTHY);
  const state = await run(label, { spawn, now: c.now });
  assert.equal(calls.length, 0, 'no process starts');
  assert.equal(state.checks.registered.status, 'fail');
  assert.match(state.checks.registered.next, new RegExp(`herdr-boss factory host add ${label} --from-file -`));
  assert.equal(state.checks.answers.status, 'skipped');
});

test('a healthy Windows host passes every check through the ssh and Docker code of the host tool', async () => {
  const label = newLabel();
  const c = clock();
  windowsGuide(label, c.now);
  writeRegistry({ [label]: registryHost });
  const { spawn, calls } = makeSpawn(HEALTHY);
  const state = await run(label, { spawn, now: c.now });
  const status = Object.fromEntries(Object.entries(state.checks).map(([id, check]) => [id, check.status]));
  assert.deepEqual(status, { registered: 'pass', answers: 'pass', 'key-login': 'pass', architecture: 'pass', docker: 'pass', systemd: 'pass', 'docker-memory': 'pass', 'sshd-password': 'pass' });
  const ssh = calls.filter((call) => call.cmd === 'ssh');
  for (const call of ssh) {
    assert.ok(call.args.includes('BatchMode=yes'), 'ssh runs in batch mode');
    assert.ok(call.args.includes(`factory@${ADDRESS}`));
    assert.equal(call.options.shell, false);
  }
  assert.ok(ssh.some((call) => call.args.at(-1) === 'uname -m'));
  const docker = calls.filter((call) => call.cmd === 'docker');
  assert.deepEqual(docker.map((call) => call.args.slice(0, 2)), [['--context', 'hf-build-box'], ['--context', 'hf-build-box']]);
  assert.equal(state.checks.docker.command, "herdr-boss factory docker " + label + " -- ps --format '{{.ID}} {{.Status}}'");
  assert.equal(state.checks.systemd.command, `herdr-boss factory ssh ${label} -- 'systemctl is-system-running; systemctl --failed --no-legend'`);
  const saved = JSON.stringify(guide.readGuide(dataDir, label));
  assert.equal(saved.includes(ADDRESS.replace('.ts.net', '')) && saved.includes('hf-build-box'), false, 'a result holds no address and no context name');
});

test('a host that does not answer fails the first check with a masked message and skips the rest', async () => {
  const label = newLabel();
  const c = clock();
  windowsGuide(label, c.now);
  writeRegistry({ [label]: registryHost });
  const { spawn } = makeSpawn(({ cmd }) => (cmd === 'ssh' ? { code: 255, stderr: `ssh: connect to host ${ADDRESS} port 22: Connection refused\nkey ${registryHost.keyFile}\n` } : { code: 1 }));
  const state = await run(label, { spawn, now: c.now });
  assert.equal(state.checks.answers.status, 'fail');
  assert.match(state.checks.answers.output, /Connection refused/);
  assert.doesNotMatch(JSON.stringify(state.checks), new RegExp(`${ADDRESS}|build-box-key|keys/`), 'address and key path are masked');
  assert.match(state.checks.answers.output, /<host>/);
  assert.match(state.checks.answers.next, /Tailscale|boot task|access policy/);
  for (const id of ['key-login', 'architecture', 'docker', 'systemd', 'docker-memory', 'sshd-password']) assert.equal(state.checks[id].status, 'skipped', id);
});

test('a refused key shows as a host that answers and a key that fails', async () => {
  const label = newLabel();
  const c = clock();
  windowsGuide(label, c.now);
  writeRegistry({ [label]: registryHost });
  const { spawn } = makeSpawn(({ cmd }) => (cmd === 'ssh' ? { code: 255, stderr: 'factory@x: Permission denied (publickey).\n' } : { code: 1 }));
  const state = await run(label, { spawn, now: c.now });
  assert.equal(state.checks.answers.status, 'pass');
  assert.equal(state.checks['key-login'].status, 'fail');
  assert.match(state.checks['key-login'].next, /authorized_keys/);
  assert.equal(state.checks.docker.status, 'skipped');
});

test('each failed check has a red mark, the failing command, masked output, and a next step', async () => {
  const label = newLabel();
  const c = clock();
  windowsGuide(label, c.now);
  writeRegistry({ [label]: registryHost });
  const { spawn } = makeSpawn((call) => {
    if (call.cmd === 'ssh' && call.remote.startsWith('systemctl')) return { stdout: 'degraded\ndocker.service loaded failed failed Docker\n' };
    if (call.cmd === 'ssh' && call.remote === 'sudo -n sshd -T') return { stdout: 'passwordauthentication yes\n' };
    if (call.cmd === 'docker' && call.remote.startsWith('ps')) return { code: 1, stderr: `error during connect: ssh://factory@${ADDRESS}: hf-build-box failed\n` };
    if (call.cmd === 'docker' && call.remote.startsWith('info')) return { stdout: `${62 * GiB}\n` };
    return HEALTHY(call);
  });
  const state = await run(label, { spawn, now: c.now });
  for (const id of ['docker', 'systemd', 'sshd-password', 'docker-memory']) {
    const check = state.checks[id];
    assert.equal(check.status, 'fail', id);
    assert.ok(check.command.startsWith('herdr-boss factory '), `${id} command`);
    assert.ok(check.next.length > 10, `${id} next`);
    assert.ok(check.at, `${id} time`);
  }
  assert.match(state.checks.systemd.output, /docker\.service/);
  assert.match(state.checks['docker-memory'].next, /wsl --shutdown/);
  assert.match(state.checks['sshd-password'].next, /PasswordAuthentication no/);
  assert.doesNotMatch(JSON.stringify(state.checks), new RegExp(`${ADDRESS}|hf-build-box`));
  assert.ok(state.checks.docker.output.length <= 1000);
});

test('a Docker context that is not registered fails the Docker check with the command that adds it', async () => {
  const label = newLabel();
  const c = clock();
  windowsGuide(label, c.now);
  writeRegistry({ [label]: { ...registryHost, dockerContext: undefined } });
  const { spawn } = makeSpawn(HEALTHY);
  const state = await run(label, { spawn, now: c.now });
  assert.equal(state.checks.docker.status, 'fail');
  assert.match(state.checks.docker.next, new RegExp(`factory host add ${label} --docker-context`));
  assert.equal(state.checks['docker-memory'].status, 'skipped');
});

test('a Windows host with another architecture fails the architecture check', async () => {
  const label = newLabel();
  const c = clock();
  windowsGuide(label, c.now);
  writeRegistry({ [label]: registryHost });
  const { spawn } = makeSpawn((call) => (call.cmd === 'ssh' && call.remote === 'uname -m' ? { stdout: 'aarch64\n' } : HEALTHY(call)));
  const state = await run(label, { spawn, now: c.now });
  assert.equal(state.checks.architecture.status, 'fail');
  assert.equal(state.checks['key-login'].status, 'pass');
});

test('the Docker memory check needs the limit that the user typed', async () => {
  const label = newLabel();
  const c = clock();
  guide.updateGuide(dataDir, label, { type: 'windows-wsl2' }, { now: c.now });
  writeRegistry({ [label]: registryHost });
  const { spawn } = makeSpawn(HEALTHY);
  const state = await run(label, { spawn, now: c.now });
  assert.equal(state.checks['docker-memory'].status, 'fail');
  assert.match(state.checks['docker-memory'].next, /memory limit/i);
});

test('a Linux host skips the architecture check and a Mac host skips systemd', async () => {
  const c = clock();
  const linux = newLabel();
  guide.updateGuide(dataDir, linux, { type: 'linux' }, { now: c.now });
  const mac = newLabel();
  guide.updateGuide(dataDir, mac, { type: 'mac-orbstack', values: { memoryGb: '4' } }, { now: c.now });
  writeRegistry({ [linux]: registryHost, [mac]: registryHost });
  const { spawn } = makeSpawn((call) => {
    if (call.cmd === 'ssh' && call.remote.startsWith('grep')) return { stdout: 'PasswordAuthentication no\n' };
    if (call.cmd === 'docker' && call.remote.startsWith('info')) return { stdout: `${3.8 * GiB}\n` };
    return call.cmd === 'ssh' && call.remote === 'uname -m' ? { stdout: 'arm64\n' } : HEALTHY(call);
  });
  const l = await run(linux, { spawn, now: c.now });
  assert.equal(l.checks.architecture, undefined);
  assert.equal(l.checks['docker-memory'].status, 'skipped');
  assert.equal(l.checks.systemd.status, 'pass');
  const m = await run(mac, { spawn, now: c.now });
  assert.equal(m.checks.systemd.status, 'skipped');
  assert.equal(m.checks['sshd-password'].status, 'pass');
  assert.equal(m.checks['docker-memory'].status, 'pass');
});

test('terminate and wait: the host goes down, comes back, and the time is recorded', async () => {
  const label = newLabel();
  const c = clock();
  windowsGuide(label, c.now);
  writeRegistry({ [label]: registryHost });
  assert.throws(() => guide.guideAction(dataDir, 'host-x', 'terminate-start', { now: c.now }), guide.GuideError);
  const started = guide.guideAction(dataDir, label, 'terminate-start', { now: c.now });
  assert.deepEqual(started.terminate, { status: 'waiting', startedAt: new Date(c.now()).toISOString() });
  assert.deepEqual(guide.guideAction(dataDir, label, 'terminate-start', { now: c.now }), started, 'a second start changes nothing');
  let up = false;
  const { spawn } = makeSpawn((call) => (call.cmd === 'ssh' && !up ? { code: 255, stderr: 'Connection refused' } : HEALTHY(call)));
  c.advance(20000);
  let state = await run(label, { spawn, now: c.now, ids: ['terminate'] });
  assert.equal(state.terminate.status, 'waiting');
  assert.equal(state.terminate.downAt, new Date(c.now()).toISOString());
  c.advance(4 * 60000);
  state = await run(label, { spawn, now: c.now, ids: ['terminate'] });
  assert.equal(state.terminate.status, 'waiting');
  up = true;
  c.advance(60000);
  state = await run(label, { spawn, now: c.now, ids: ['terminate'] });
  assert.equal(state.terminate.status, 'passed');
  assert.equal(state.terminate.seconds, 5 * 60 + 20);
  assert.equal(state.checks.terminate.status, 'pass');
  assert.match(state.checks.terminate.output, /5 minutes/);
  assert.equal(guide.guideAction(dataDir, label, 'terminate-reset', { now: c.now }).terminate, null);
});

test('terminate and wait fails when the host does not come back in 7 minutes, or never goes down', async () => {
  const label = newLabel();
  const c = clock();
  windowsGuide(label, c.now);
  writeRegistry({ [label]: registryHost });
  const down = makeSpawn((call) => (call.cmd === 'ssh' ? { code: 255, stderr: 'Connection timed out' } : { code: 1 }));
  guide.guideAction(dataDir, label, 'terminate-start', { now: c.now });
  c.advance(30000);
  await run(label, { spawn: down.spawn, now: c.now, ids: ['terminate'] });
  c.advance(7 * 60000);
  let state = await run(label, { spawn: down.spawn, now: c.now, ids: ['terminate'] });
  assert.equal(state.terminate.status, 'failed');
  assert.match(state.checks.terminate.next, /repeating trigger|Task Scheduler/);
  guide.guideAction(dataDir, label, 'terminate-reset', { now: c.now });
  guide.guideAction(dataDir, label, 'terminate-start', { now: c.now });
  const alive = makeSpawn(HEALTHY);
  c.advance(30000);
  state = await run(label, { spawn: alive.spawn, now: c.now, ids: ['terminate'] });
  assert.equal(state.terminate.status, 'waiting');
  assert.match(state.checks.terminate.output, /still answers/i);
  c.advance(8 * 60000);
  state = await run(label, { spawn: alive.spawn, now: c.now, ids: ['terminate'] });
  assert.equal(state.terminate.status, 'failed');
  assert.match(state.checks.terminate.next, /wsl --terminate/);
});

test('the terminate test is for a Windows host only', () => {
  const c = clock();
  const label = newLabel();
  guide.updateGuide(dataDir, label, { type: 'linux' }, { now: c.now });
  assert.throws(() => guide.guideAction(dataDir, label, 'terminate-start', { now: c.now }), (e) => e.status === 409 && /Windows/.test(e.message));
  assert.throws(() => guide.guideAction(dataDir, label, 'no-such-action', { now: c.now }), (e) => e.status === 400);
});

test('reboot test: it passes only when the host started after the click and Docker answers', async () => {
  const label = newLabel();
  const c = clock();
  windowsGuide(label, c.now);
  writeRegistry({ [label]: registryHost });
  guide.guideAction(dataDir, label, 'reboot-start', { now: c.now });
  c.advance(10 * 60000);
  let uptime = '99999.00 88888.00';
  const { spawn } = makeSpawn((call) => (call.cmd === 'ssh' && call.remote === 'cat /proc/uptime' ? { stdout: `${uptime}\n` } : HEALTHY(call)));
  let state = await run(label, { spawn, now: c.now, ids: ['reboot'] });
  assert.equal(state.reboot.status, 'waiting', 'an uptime from before the click is no restart');
  assert.match(state.checks.reboot.output, /not restarted/i);
  uptime = '240.50 200.00';
  state = await run(label, { spawn, now: c.now, ids: ['reboot'] });
  assert.equal(state.reboot.status, 'passed');
  assert.equal(state.reboot.recoverySeconds, 600);
  assert.equal(state.checks.reboot.status, 'pass');
  const docker = makeSpawn((call) => (call.cmd === 'docker' ? { code: 1, stderr: 'Cannot connect' } : { ...HEALTHY(call), stdout: call.remote === 'cat /proc/uptime' ? '10.00 9.00\n' : HEALTHY(call).stdout }));
  guide.guideAction(dataDir, label, 'reboot-reset', { now: c.now });
  guide.guideAction(dataDir, label, 'reboot-start', { now: c.now });
  c.advance(120000);
  state = await run(label, { spawn: docker.spawn, now: c.now, ids: ['reboot'] });
  assert.equal(state.reboot.status, 'waiting');
  assert.match(state.checks.reboot.output, /Docker/);
  c.advance(31 * 60000);
  state = await run(label, { spawn: docker.spawn, now: c.now, ids: ['reboot'] });
  assert.equal(state.reboot.status, 'failed');
  assert.match(state.checks.reboot.next, /Task Scheduler|boot task/);
});

test('a second check on the same host waits for the first one', async () => {
  const label = newLabel();
  const c = clock();
  windowsGuide(label, c.now);
  writeRegistry({ [label]: registryHost });
  const slow = makeSpawn(HEALTHY);
  const first = run(label, { spawn: slow.spawn, now: c.now });
  await assert.rejects(run(label, { spawn: slow.spawn, now: c.now }), (e) => e.status === 409 && /already/.test(e.message));
  await first;
});

test('the service routes: owner only for a change, none in the preview, and the bodies are checked', async (t) => {
  writeRegistry({ 'route-box': registryHost });
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  const engineStub = () => Object.assign(new EventEmitter(), { state: {}, tick: async () => ({}), log() {} });
  const { spawn } = makeSpawn(HEALTHY);
  const open = async (options) => {
    const app = serve(cfg, { liveDataDir: dataDir, createEngine: engineStub, hostGuide: { spawn, env }, ...options });
    t.after(async () => { await app.close(); });
    await new Promise((resolve, reject) => { app.server.once('listening', resolve); app.server.once('error', reject); });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    return async (method, url, body, headers = {}) => {
      const response = await fetch(`${base}${url}`, { method, headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: response.status, json, text };
    };
  };
  const call = await open({});
  const owner = { 'x-herdr-boss-caller': 'page' };
  // A read without the page header is not the owner either: the saved values hold the tailnet and account names.
  for (const url of ['/api/host-guide', '/api/host-guide/route-box']) {
    const denied = await call('GET', url);
    assert.equal(denied.status, 403, url);
    assert.match(denied.json.error, /Owner session/);
  }
  assert.equal((await call('GET', '/api/host-guide', undefined, owner)).status, 200);
  assert.deepEqual((await call('GET', '/api/host-guide', undefined, owner)).json.hosts, ['route-box']);
  // A change without the page header is not the owner.
  for (const [method, url, body] of [['PUT', '/api/host-guide/route-box', { type: 'linux' }], ['POST', '/api/host-guide/route-box/check', {}], ['POST', '/api/host-guide/route-box/action', { action: 'reboot-start' }], ['DELETE', '/api/host-guide/route-box']]) {
    const response = await call(method, url, body);
    assert.equal(response.status, 403, `${method} ${url}`);
    assert.match(response.json.error, /owner/i);
  }
  assert.equal(fs.existsSync(path.join(dataDir, 'host-guide', 'route-box.json')), false);
  assert.equal((await call('GET', '/api/host-guide/route-box', undefined, owner)).status, 404);
  const saved = await call('PUT', '/api/host-guide/route-box', { type: 'windows-wsl2', values: { memoryGb: '48' }, done: { bios: true } }, owner);
  assert.equal(saved.status, 200);
  assert.equal(saved.json.state.values.memoryGb, '48');
  assert.deepEqual(saved.json.progress, { done: 1, total: 25, next: 'update-windows' });
  assert.equal((await call('GET', '/api/host-guide/route-box', undefined, owner)).json.state.done.bios, true);
  assert.equal((await call('PUT', '/api/host-guide/route-box', { values: { tailnetName: 'nope' } }, owner)).status, 400);
  assert.equal((await call('PUT', '/api/host-guide/route-box', { unknown: 1 }, owner)).status, 400);
  assert.equal((await call('PUT', '/api/host-guide/route-box', '[1]', owner)).status, 400);
  assert.equal((await call('PUT', '/api/host-guide/..%2Fx', { type: 'linux' }, owner)).status, 404);
  assert.equal((await call('PUT', '/api/host-guide/Route', { type: 'linux' }, owner)).status, 404);
  assert.equal((await call('PUT', '/api/host-guide/route-box', { values: { role: 'x'.repeat(40000) } }, owner)).status, 413);
  const checked = await call('POST', '/api/host-guide/route-box/check', {}, owner);
  assert.equal(checked.status, 200);
  assert.equal(checked.json.state.checks.answers.status, 'pass');
  assert.equal((await call('POST', '/api/host-guide/route-box/check', { check: 'nonsense' }, owner)).status, 400);
  assert.equal((await call('POST', '/api/host-guide/route-box/action', { action: 'reboot-start' }, owner)).json.state.reboot.status, 'waiting');
  assert.equal((await call('DELETE', '/api/host-guide/route-box', undefined, owner)).status, 200);
  assert.equal(fs.existsSync(path.join(dataDir, 'host-guide', 'route-box.json')), false);
  assert.equal((await call('DELETE', '/api/host-guide/route-box', undefined, owner)).status, 404);
});

test('the read-only preview refuses every host-guide route and writes nothing', async (t) => {
  const before = fs.readdirSync(dataDir).sort();
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  const engineStub = () => Object.assign(new EventEmitter(), { state: {}, tick: async () => ({}), log() {}, act: null, push: null });
  const { spawn, calls } = makeSpawn(HEALTHY);
  const app = serve(cfg, { liveDataDir: process.env.HERDR_BOSS_DIR, readOnlyPreview: true, createEngine: engineStub, hostGuide: { spawn, env } });
  t.after(async () => { await app.close(); });
  await new Promise((resolve, reject) => { app.server.once('listening', resolve); app.server.once('error', reject); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  for (const [method, url, body] of [['GET', '/api/host-guide'], ['GET', '/api/host-guide/route-box'], ['PUT', '/api/host-guide/route-box', { type: 'linux' }], ['POST', '/api/host-guide/route-box/check', {}], ['POST', '/api/host-guide/route-box/action', { action: 'reboot-start' }], ['DELETE', '/api/host-guide/route-box']]) {
    const response = await fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', 'x-herdr-boss-caller': 'page' }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(response.status, 403, `${method} ${url}`);
    assert.equal((await response.json()).error, 'This read-only preview does not allow changes.');
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(fs.readdirSync(dataDir).sort(), before);
});

test('the step ids that the state machine knows are the step ids of the data file', () => {
  for (const [type, steps] of Object.entries(STEPS)) assert.deepEqual(guide.stepIds(type), steps.map((step) => step.id));
});

test('a factory command that fails on a host record names the guide, and an unrelated failure does not', () => {
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [cli, 'factory', ...args], { env: { ...process.env, HOME: homeDir, HERDR_BOSS_DIR: dataDir, HERDR_FACTORIES_DIR: path.join(root, 'empty-factories') }, encoding: 'utf8' });
  const missing = run('ssh', 'no-such-host', '--', 'true');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /The host is not in the registry\./);
  assert.match(missing.stderr, /Host setup guide: open \/fleet\/add-host in the dashboard/);
  const unrelated = run('host', 'remove');
  assert.equal(unrelated.status, 1);
  assert.doesNotMatch(unrelated.stderr, /Host setup guide/);
});

test('a value, a step, or a delete during a check is not lost or undone', async () => {
  const label = newLabel();
  const c = clock();
  windowsGuide(label, c.now);
  writeRegistry({ [label]: registryHost });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { spawn } = makeSpawn(async (call) => { await gate; return HEALTHY(call); });
  const first = run(label, { spawn, now: c.now });
  guide.updateGuide(dataDir, label, { values: { role: 'builder' }, done: { bios: true } }, { now: c.now });
  guide.guideAction(dataDir, label, 'reboot-start', { now: c.now });
  release();
  const state = await first;
  assert.equal(state.values.role, 'builder');
  assert.equal(state.done.bios, true);
  assert.equal(state.reboot.status, 'waiting');
  assert.equal(guide.readGuide(dataDir, label).values.role, 'builder');
  assert.equal(guide.readGuide(dataDir, label).checks.answers.status, 'pass');
  // A delete during a check stays a delete.
  const other = newLabel();
  windowsGuide(other, c.now);
  writeRegistry({ [other]: registryHost });
  let open;
  const hold = new Promise((resolve) => { open = resolve; });
  const slow = makeSpawn(async (call) => { await hold; return HEALTHY(call); });
  const second = run(other, { spawn: slow.spawn, now: c.now });
  guide.deleteGuide(dataDir, other);
  open();
  await assert.rejects(second, (e) => e.status === 404 && /deleted/i.test(e.message));
  assert.equal(guide.readGuide(dataDir, other), null);
});

test('the copied command is one quoted argument, so zsh does not expand a glob or split at a semicolon', async () => {
  const c = clock();
  const mac = newLabel();
  guide.updateGuide(dataDir, mac, { type: 'mac-orbstack', values: { memoryGb: '4' } }, { now: c.now });
  writeRegistry({ [mac]: registryHost });
  const { spawn } = makeSpawn((call) => (call.cmd === 'ssh' && call.remote.startsWith('grep') ? { stdout: 'PasswordAuthentication yes\n' } : HEALTHY(call)));
  const state = await run(mac, { spawn, now: c.now });
  assert.equal(state.checks['sshd-password'].command, `herdr-boss factory ssh ${mac} -- 'grep -ihs '\\''^[[:space:]]*PasswordAuthentication'\\'' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*'`);
  assert.equal(state.checks.systemd.status, 'skipped');
  const win = newLabel();
  windowsGuide(win, c.now);
  writeRegistry({ [win]: registryHost });
  const healthy = await run(win, { spawn: makeSpawn(HEALTHY).spawn, now: c.now });
  assert.equal(healthy.checks['sshd-password'].command, `herdr-boss factory ssh ${win} -- 'sudo -n sshd -T'`);
});

test('a hung ssh gets SIGTERM, then SIGKILL, in its own process group, and its output is capped', async () => {
  const label = newLabel();
  const c = clock();
  windowsGuide(label, c.now);
  writeRegistry({ [label]: registryHost });
  const kills = [];
  const options = [];
  const spawn = (cmd, args, opts) => {
    options.push(opts);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => { kills.push(signal); if (signal === 'SIGKILL') setImmediate(() => child.emit('close', null)); };
    return child;
  };
  const state = await run(label, { spawn, now: c.now, sshTimeout: 20, killGrace: 20 });
  assert.equal(state.checks.answers.status, 'fail');
  assert.match(state.checks.answers.output, /timed out/i);
  assert.equal(options[0].detached, true);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(kills, ['SIGTERM', 'SIGKILL']);
  const big = [];
  const flood = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => { big.push(signal); setImmediate(() => child.emit('close', null)); };
    setImmediate(() => child.stdout.write('x'.repeat(200 * 1024)));
    return child;
  };
  await run(label, { spawn: flood, now: c.now, sshTimeout: 2000, killGrace: 20 });
  assert.ok(big.includes('SIGTERM'), 'an output over the cap stops the process');
});

test('a file system failure gives a fixed message with no path', async () => {
  const broken = path.join(root, 'broken-data');
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, 'host-guide'), 'not a folder');
  const api = guide.createHostGuideApi({ dataDir: broken, env, spawn: makeSpawn(HEALTHY).spawn });
  const result = await api.handle('GET', '/api/host-guide/some-box', async () => ({}), { owner: true });
  assert.equal(result.status, 500);
  assert.equal(result.body.error, 'The host guide could not read or write its saved file.');
  const put = await api.handle('PUT', '/api/host-guide/some-box', async () => ({ type: 'linux' }), { owner: true });
  assert.equal(put.status, 500);
  assert.doesNotMatch(JSON.stringify([result, put]), /broken-data|ENOTDIR|ENOENT|\//);
});

test('an unregistered host keeps the rows of a started terminate and reboot test', async () => {
  const label = newLabel();
  const c = clock();
  windowsGuide(label, c.now);
  writeRegistry({});
  guide.guideAction(dataDir, label, 'terminate-start', { now: c.now });
  guide.guideAction(dataDir, label, 'reboot-start', { now: c.now });
  const state = await run(label, { spawn: makeSpawn(HEALTHY).spawn, now: c.now });
  for (const id of ['terminate', 'reboot']) {
    assert.equal(state.checks[id].status, 'skipped', id);
    assert.match(state.checks[id].output, /not registered/i);
  }
});
