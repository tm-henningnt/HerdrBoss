// `herdr-boss factory attach NAME [--undo]`: connect Herdr on this Mac to a factory over SSH.
// Attach writes an SSH include file, authorizes the Mac key in the factory, and saves a Herdr machine.
// Every message is fixed text. No address, host name, key path, or key content reaches the output.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { managedFactory, transportFor, inspect, assertOwned } from './factory-core.js';
import { attachState, factoryFile, readPrivate, writePrivate, readFleet, assertName } from './factory-store.js';
import { isHostUnreachable } from './factory-transport.js';
import { maskLine } from './factory-host.js';

const ATTACH_FILE = 'attach.json';
const INCLUDE_LINE = 'Include ~/.ssh/herdr-boss.d/*.conf';
const MARKER = '.include-added';
const REMOTE_LIMIT_MS = 8000;
const AUTHORIZED = '/home/factory/.ssh/authorized_keys';
const APPEND_KEY = 'umask 077; mkdir -p "$HOME/.ssh"; f="$HOME/.ssh/authorized_keys"; if [ -s "$f" ] && [ -n "$(tail -c1 "$f")" ]; then echo >> "$f"; fi; printf \'%s\\n\' "$1" >> "$f"';
const alias = (name) => `hf-${name}`;
const sshDir = (env) => path.join(env.HOME || os.homedir(), '.ssh');
const includeDir = (env) => path.join(sshDir(env), 'herdr-boss.d');
const conffile = (env, name) => path.join(includeDir(env), `${alias(name)}.conf`);
const failure = (message) => Object.assign(new Error(message), { attach: true });
// A failed step names itself and shows the masked output of its command.
const stepFailure = (step, result, host, name) => {
  if (/host identification has changed|host key verification failed/i.test(`${result.stderr || ''}${result.stdout || ''}`)) return failure(`The host key of ${alias(name)} changed. If you rebuilt the factory, remove the old line with: ssh-keygen -R ${alias(name)}`);
  const detail = maskLine(`${result.stderr || ''}${result.stdout || ''}`.trim(), { ...host, name: host.hostId }).slice(0, 400);
  return failure(`${step} step failed.${detail ? ` ${detail}` : ''}`);
};

export { attachState };

// Run a local command with an args array and no shell. A timeout stops the child and sets `timedOut`.
function defaultRun(command, args, { env = process.env, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = nodeSpawn(command, args, { env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); } catch { resolve({ code: 127, stdout: '', stderr: '', timedOut: false }); return; }
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 1000).unref(); }, timeout);
    child.stdout.on('data', (chunk) => { if (stdout.length < 65536) stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length < 65536) stderr += chunk; });
    child.once('error', () => { clearTimeout(timer); resolve({ code: 127, stdout, stderr, timedOut }); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr, timedOut }); });
  });
}

const quote = (value) => `"${String(value).replace(/["\\]/g, '\\$&')}"`;
const configText = (name, record, host) => [
  '# Written by herdr-boss factory attach. Do not edit. Run factory attach NAME --undo to remove it.',
  `Host ${alias(name)}-jump`,
  `  HostName ${host.address}`,
  `  User ${host.user}`,
  `  IdentityFile ${quote(host.keyFile)}`,
  '  IdentitiesOnly yes',
  '  StrictHostKeyChecking accept-new',
  '',
  `Host ${alias(name)}`,
  '  HostName 127.0.0.1',
  `  Port ${record.ports.ssh}`,
  '  User factory',
  `  IdentityFile ${quote(host.keyFile)}`,
  '  IdentitiesOnly yes',
  `  HostKeyAlias ${alias(name)}`,
  `  ProxyJump ${alias(name)}-jump`,
  '  StrictHostKeyChecking accept-new',
  '',
].join('\n');

function writeFile600(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); } finally { fs.rmSync(temporary, { force: true }); }
  fs.chmodSync(file, 0o600);
}

// Add the Include line at the top of ~/.ssh/config. Show the line and back up the file first.
function ensureInclude(env, out) {
  const file = path.join(sshDir(env), 'config');
  let current = null;
  try { current = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw failure('The SSH config cannot be read.'); }
  if (current?.split('\n').some((line) => line.trim() === INCLUDE_LINE)) return;
  out.write(`Adding this line at the top of ~/.ssh/config:\n  ${INCLUDE_LINE}\n`);
  if (current !== null) {
    const backup = path.join(sshDir(env), 'config.herdr-boss.bak');
    writeFile600(backup, current);
    out.write('Backup of the old file: ~/.ssh/config.herdr-boss.bak\n');
  }
  writeFile600(file, `${INCLUDE_LINE}\n${current === null ? '' : `\n${current}`}`);
  writeFile600(path.join(includeDir(env), MARKER), '');
}

function removeInclude(env) {
  const dir = includeDir(env);
  if (!fs.existsSync(path.join(dir, MARKER))) return false;
  if (fs.readdirSync(dir).some((entry) => entry.endsWith('.conf'))) return false;
  const file = path.join(sshDir(env), 'config');
  let current;
  try { current = fs.readFileSync(file, 'utf8'); } catch { current = null; }
  if (current !== null) {
    const lines = current.split('\n');
    const index = lines.findIndex((line) => line.trim() === INCLUDE_LINE);
    if (index >= 0) {
      lines.splice(index, lines[index + 1] === '' ? 2 : 1);
      writeFile600(file, lines.join('\n'));
    }
  }
  fs.rmSync(path.join(dir, MARKER), { force: true });
  try { fs.rmdirSync(dir); } catch { /* Another file stays in the folder. */ }
  return true;
}

const keyId = (line) => line.trim().split(/\s+/).slice(0, 2).join(' ');
const parseList = (stdout) => { try { const value = JSON.parse(stdout); return Array.isArray(value) ? value : []; } catch { return []; } };
const machineId = (entry) => entry?.id ?? entry?.profile_id ?? entry?.profileId;

async function listMachines(run, env, host, name) {
  const result = await run('herdr', ['machine', 'list', '--json'], { env });
  if (result.code !== 0) throw stepFailure('machine list', result, host, name);
  return parseList(result.stdout);
}

async function attach(name, io, run) {
  const { record, host } = managedFactory(io.env, name);
  if (!host.address || !host.user || !host.keyFile) throw failure('Attach needs a factory on an SSH host.');
  const out = io.stdout;
  const docker = transportFor(host, io);
  const container = await inspect(docker, 'container', record.containerName);
  if (!container) throw failure('The factory container does not exist.');
  assertOwned(container, name);
  if (!container.State?.Running) throw failure('The factory container is stopped. Start it first.');

  const file = conffile(io.env, name);
  writeFile600(file, configText(name, record, host));
  ensureInclude(io.env, out);
  out.write(`SSH alias ${alias(name)} is ready.\n`);

  const keygen = await run('ssh-keygen', ['-y', '-f', host.keyFile], { env: io.env });
  const line = keygen.code === 0 ? (keygen.stdout.split('\n')[0] || '').trim() : '';
  const wanted = line ? keyId(line) : '';
  if (!wanted) throw failure('The Mac SSH key cannot be read. Check the key of the host record.');
  const current = await docker.run(['exec', '--user', 'factory', record.containerName, 'cat', AUTHORIZED]);
  const present = current.code === 0 && current.stdout.split('\n').some((line) => line.trim() && keyId(line) === wanted);
  if (present) out.write('The Mac key is already authorized in the factory.\n');
  else {
    const added = await docker.run(['exec', '--user', 'factory', '-e', 'HOME=/home/factory', record.containerName, 'sh', '-c', APPEND_KEY, 'sh', line.split(/\s+/).length > 2 ? line : `${line} herdr-boss-attach`]);
    if (added.code !== 0) throw failure('The Mac key could not be added to the factory.');
    out.write('Added the Mac key to the factory.\n');
  }

  const previous = readPrivate(factoryFile(io.env, name, ATTACH_FILE), null);
  let machines = await listMachines(run, io.env, host, name);
  // Reuse a machine by its recorded ID or by the same target. Never add a second one.
  let entry = machines.find((item) => previous?.machineId && machineId(item) === previous.machineId) || machines.find((item) => item?.target === alias(name));
  if (!entry) {
    if (machines.some((item) => item?.label === name)) throw failure(`A saved Herdr machine already uses the label ${name} for another target. Rename or remove it first.`);
    const added = await run('herdr', ['machine', 'add', '--label', name, alias(name)], { env: io.env, timeout: 60000 });
    if (added.code !== 0) throw stepFailure('add', added, host, name);
    machines = await listMachines(run, io.env, host, name);
    entry = machines.find((item) => item?.target === alias(name));
  } else out.write('The Herdr machine exists. Attach reuses it.\n');
  const label = entry?.label || name;
  const save = (state) => writePrivate(factoryFile(io.env, name, ATTACH_FILE), { schema: 1, state, alias: alias(name), machineId: machineId(entry) ?? null });
  save('pending');

  const status = await run('herdr', ['machine', 'status', label, '--json'], { env: io.env, timeout: 30000 });
  if (status.code !== 0 || /"(?:status|state)"\s*:\s*"(?:fail|error|offline|unreach|auth)/i.test(status.stdout)) throw stepFailure('status', status, host, name);
  // The API path works inside a Herdr pane. `herdr --remote` does not, because a nested Herdr is off by default.
  const api = await run('herdr', ['--machine', label, 'workspace', 'list'], { env: io.env, timeout: 30000 });
  if (api.code !== 0) throw stepFailure('api check', api, host, name);
  save('attached');
  if (io.env.HERDR_ENV) out.write('The optional remote attach check is skipped inside a Herdr pane.\n');
  else {
    const remote = await run('herdr', ['--remote', alias(name)], { env: { ...io.env, TERM: 'xterm-256color' }, timeout: REMOTE_LIMIT_MS });
    if (remote.code === 0 || remote.timedOut) out.write('The optional remote attach check passed.\n');
    else if (/nested herdr is disabled/i.test(`${remote.stderr}${remote.stdout}`)) out.write('The optional remote attach check is skipped: nested Herdr is disabled.\n');
    else out.write('The optional remote attach check failed. The machine works through the API check.\n');
  }
  out.write(`Attached. Alias: ${alias(name)}. Sidebar label: ${label}.\nDetach with: herdr-boss factory attach ${name} --undo\n`);
  return 0;
}

async function undo(name, io, run) {
  const out = io.stdout;
  const file = conffile(io.env, name);
  const stateFile = factoryFile(io.env, name, ATTACH_FILE);
  const record = readPrivate(stateFile, null);
  if (!record && !fs.existsSync(file)) { out.write(`${name} nothing is left to undo.\n`); return 0; }
  const { host } = managedFactory(io.env, name);
  const removed = [];
  if (record?.machineId) {
    const machines = await listMachines(run, io.env, host, name);
    if (machines.some((item) => machineId(item) === record.machineId)) {
      const result = await run('herdr', ['machine', 'remove', record.machineId], { env: io.env });
      if (result.code !== 0) throw stepFailure('remove', result, host, name);
      removed.push('Herdr machine');
    }
  }
  if (fs.existsSync(file)) { fs.rmSync(file); removed.push('SSH include file'); }
  if (removeInclude(io.env)) removed.push('Include line');
  fs.rmSync(stateFile, { force: true });
  out.write(`${name} detached: removed ${removed.length ? removed.join(', ') : 'the attach record'}.\n`);
  return 0;
}

export async function factoryAttachCommand(args, io) {
  const undoOnly = args.includes('--undo');
  const names = args.filter((arg) => arg !== '--undo');
  if (names.length !== 1 || args.length !== (undoOnly ? 2 : 1)) throw new Error('Use factory attach NAME [--undo].');
  assertName(names[0]);
  if (!readFleet(io.env).factories.some((item) => item.name === names[0] && item.kind === 'container')) throw new Error('The container factory is not in the fleet registry.');
  const run = io.run || defaultRun;
  try { return await (undoOnly ? undo : attach)(names[0], io, run); }
  catch (error) {
    if (error.attach) { io.stderr.write(`${names[0]} attach failed: ${error.message}\n`); return 1; }
    if (isHostUnreachable(error)) { io.stderr.write(`${names[0]} attach failed: the factory host is unreachable.\n`); return 1; }
    io.stderr.write(`${names[0]} attach failed: ${error.message}\n`);
    return 1;
  }
}
