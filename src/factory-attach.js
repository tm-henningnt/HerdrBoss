// `herdr-boss factory attach NAME [--undo]`: connect Herdr on this Mac to a factory over SSH.
// Attach writes an SSH include file, authorizes the Mac key in the factory, and saves a Herdr machine.
// Every message is fixed text or masked command output. No address, host name, user, port, key path, or key content reaches the output.
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
const INCLUDE_PATTERN = /^Include[ \t]+~\/\.ssh\/herdr-boss\.d\/\*\.conf[ \t]*$/;
const MARKER = '.include-added';
const REMOTE_LIMIT_MS = 8000;
const AUTHORIZED = '/home/factory/.ssh/authorized_keys';
const APPEND_KEY = 'umask 077; mkdir -p "$HOME/.ssh"; f="$HOME/.ssh/authorized_keys"; if [ -s "$f" ] && [ -n "$(tail -c1 "$f")" ]; then echo >> "$f"; fi; printf \'%s\\n\' "$1" >> "$f"';
const REMOVE_KEY = 'f="$HOME/.ssh/authorized_keys"; [ -f "$f" ] || exit 0; grep -vxF -- "$1" "$f" > "$f.herdr-boss.new"; cat "$f.herdr-boss.new" > "$f"; rm -f "$f.herdr-boss.new"';
const ADDRESS = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/;
const USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;
const MACHINE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const alias = (name) => `hf-${name}`;
// `hfj-` does not start with `hf-`, so no factory alias can equal a jump alias.
const jumpAlias = (name) => `hfj-${name}`;
const sshDir = (env) => path.join(env.HOME || os.homedir(), '.ssh');
const includeDir = (env) => path.join(sshDir(env), 'herdr-boss.d');
const conffile = (env, name) => path.join(includeDir(env), `${alias(name)}.conf`);
const failure = (message) => Object.assign(new Error(message), { attach: true });
const maskHost = (host, record) => ({ ...host, name: host.hostId, sshPort: record?.ports?.ssh });
// A failed step names itself and shows the masked output of its command.
const stepFailure = (step, result, host, name, record) => {
  if (/host identification has changed/i.test(`${result.stderr || ''}${result.stdout || ''}`)) return failure(`The host key of ${alias(name)} changed. If you rebuilt the factory, remove the old line with: ssh-keygen -R ${alias(name)}`);
  const detail = maskLine(`${result.stderr || ''}${result.stdout || ''}`.trim(), maskHost(host, record)).slice(0, 400);
  return failure(`${step} step failed.${detail ? ` ${detail}` : ''}`);
};

export { attachState };

// Run a local command with an args array and no shell, in its own process group. A timeout stops the group and sets `timedOut`.
function defaultRun(command, args, { env = process.env, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = nodeSpawn(command, args, { env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch { resolve({ code: 127, stdout: '', stderr: '', timedOut: false }); return; }
    let stdout = '', stderr = '', timedOut = false;
    const signal = (name) => { try { process.kill(-child.pid, name); } catch { try { child.kill(name); } catch { /* The process is gone. */ } } };
    const timer = setTimeout(() => { timedOut = true; signal('SIGTERM'); setTimeout(() => signal('SIGKILL'), 1000).unref(); }, timeout);
    child.stdout.on('data', (chunk) => { if (stdout.length < 65536) stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length < 65536) stderr += chunk; });
    child.once('error', () => { clearTimeout(timer); resolve({ code: 127, stdout, stderr, timedOut }); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr, timedOut }); });
  });
}

// Refuse a value that could add an SSH option or end the value early. The registry is revalidated here.
function assertSafeHost(host, record) {
  const unsafe = (value) => typeof value !== 'string' || /[\s"'\\\0]/.test(value);
  if (!ADDRESS.test(host.address) || !USER.test(host.user) || unsafe(host.keyFile) || host.keyFile.startsWith('-') || !path.isAbsolute(host.keyFile) || !Number.isInteger(record.ports?.ssh)) {
    throw failure('The host record has an unsafe character or a missing value. Check the address, the user, and the key file path in the private host record.');
  }
}

const configText = (name, record, host) => [
  '# Written by herdr-boss factory attach. Do not edit. Run factory attach NAME --undo to remove it.',
  `Host ${jumpAlias(name)}`,
  `  HostName ${host.address}`,
  `  User ${host.user}`,
  `  IdentityFile "${host.keyFile.replace(/%/g, '%%')}"`,
  '  IdentitiesOnly yes',
  '  StrictHostKeyChecking accept-new',
  '',
  `Host ${alias(name)}`,
  '  HostName 127.0.0.1',
  `  Port ${record.ports.ssh}`,
  '  User factory',
  `  IdentityFile "${host.keyFile.replace(/%/g, '%%')}"`,
  '  IdentitiesOnly yes',
  `  HostKeyAlias ${alias(name)}`,
  `  ProxyJump ${jumpAlias(name)}`,
  '  StrictHostKeyChecking accept-new',
  '',
].join('\n');

// Write a file through a symlink and keep the link. A new file gets mode 600. An existing file keeps its mode.
function writeThrough(file, content, mode = 0o600) {
  let target = file;
  try { target = fs.realpathSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  try { fs.writeFileSync(temporary, content, { mode, flag: 'wx' }); fs.chmodSync(temporary, mode); fs.renameSync(temporary, target); } finally { fs.rmSync(temporary, { force: true }); }
}

// Read the SSH config through any symlink. Return null when it does not exist.
function readConfig(env) {
  const file = path.join(sshDir(env), 'config');
  try { return { text: fs.readFileSync(file, 'utf8'), mode: fs.statSync(file).mode & 0o777 }; }
  catch (error) { if (error.code === 'ENOENT') return null; throw failure('The SSH config cannot be read.'); }
}

// The index of the top-level Include line: an unindented line before the first Host or Match line.
function topInclude(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    if (/^[ \t]*(Host|Match)[ \t=]/i.test(lines[index])) return -1;
    if (INCLUDE_PATTERN.test(lines[index])) return index;
  }
  return -1;
}

function backupName(env) {
  for (let number = 0; ; number += 1) {
    const file = path.join(sshDir(env), number === 0 ? 'config.herdr-boss.bak' : `config.herdr-boss.bak.${number}`);
    if (!fs.existsSync(file)) return file;
  }
}

// Add the Include line at the top of ~/.ssh/config. Show the line and back up the file first.
// The ownership marker comes before the rewrite, so a crash cannot leave an Include line that undo does not own.
function ensureInclude(env, out) {
  const current = readConfig(env);
  if (current && topInclude(current.text.split('\n')) >= 0) return;
  out.write(`Adding this line at the top of ~/.ssh/config:\n  ${INCLUDE_LINE}\n`);
  const marker = path.join(includeDir(env), MARKER);
  if (!fs.existsSync(marker)) writeThrough(marker, `${JSON.stringify({ configCreated: current === null })}\n`);
  if (current) {
    const backup = backupName(env);
    writeThrough(backup, current.text);
    out.write(`Backup of the old file: ~/.ssh/${path.basename(backup)}\n`);
  }
  writeThrough(path.join(sshDir(env), 'config'), `${INCLUDE_LINE}\n${current ? `\n${current.text}` : ''}`, current?.mode ?? 0o600);
}

function removeInclude(env) {
  const dir = includeDir(env);
  const marker = path.join(dir, MARKER);
  if (!fs.existsSync(marker)) return false;
  if (fs.readdirSync(dir).some((entry) => entry.endsWith('.conf'))) return false;
  const current = readConfig(env);
  let configCreated = false;
  try { configCreated = JSON.parse(fs.readFileSync(marker, 'utf8')).configCreated === true; } catch { /* An old marker has no record. */ }
  let removed = false;
  if (current) {
    const lines = current.text.split('\n');
    const index = topInclude(lines);
    if (index >= 0) {
      lines.splice(index, lines[index + 1] === '' ? 2 : 1);
      const rest = lines.join('\n');
      if (configCreated && rest.trim() === '') fs.rmSync(path.join(sshDir(env), 'config'), { force: true });
      else writeThrough(path.join(sshDir(env), 'config'), rest, current.mode);
      removed = true;
    }
  }
  fs.rmSync(marker, { force: true });
  try { fs.rmdirSync(dir); } catch { /* Another file stays in the folder. */ }
  return removed;
}

const blobOf = (line) => line.trim().split(/\s+/)[1];
const machineId = (entry) => entry?.id ?? entry?.profile_id ?? entry?.profileId;

async function listMachines(run, env, host, name, record) {
  const result = await run('herdr', ['machine', 'list', '--json'], { env });
  if (result.code !== 0) throw stepFailure('machine list', result, host, name, record);
  let value;
  try { value = JSON.parse(result.stdout); } catch { value = null; }
  if (!Array.isArray(value)) throw failure('machine list step failed. The output is not a JSON list.');
  return value;
}

async function attach(name, io, run) {
  const { record, host } = managedFactory(io.env, name);
  if (!host.address || !host.user || !host.keyFile) throw failure('Attach needs a factory on an SSH host.');
  assertSafeHost(host, record);
  const out = io.stdout;
  const docker = transportFor(host, io);
  const container = await inspect(docker, 'container', record.containerName);
  if (!container) throw failure('The factory container does not exist.');
  assertOwned(container, name);
  if (!container.State?.Running) throw failure('The factory container is stopped. Start it first.');

  const stateFile = factoryFile(io.env, name, ATTACH_FILE);
  const previous = readPrivate(stateFile, null);
  const state = { schema: 2, state: 'pending', alias: alias(name), machineId: previous?.machineId ?? null, machineCreated: previous ? previous.machineCreated ?? true : false, keyAdded: previous?.keyAdded ?? false, keyLine: previous?.keyLine ?? null };
  const save = (value) => { state.state = value; writePrivate(stateFile, state); };

  const keygen = await run('ssh-keygen', ['-y', '-P', '', '-f', host.keyFile], { env: io.env });
  const line = keygen.code === 0 ? (keygen.stdout.split('\n')[0] || '').trim() : '';
  const blob = line ? blobOf(line) : undefined;
  if (!blob) throw failure('The Mac SSH key cannot be read. Use a key without a passphrase in the host record.');

  writeThrough(conffile(io.env, name), configText(name, record, host));
  ensureInclude(io.env, out);
  out.write(`SSH alias ${alias(name)} is ready.\n`);

  const current = await docker.run(['exec', '--user', 'factory', record.containerName, 'cat', AUTHORIZED]);
  if (current.code !== 0 && !/no such file/i.test(current.stderr || '')) throw failure('The authorized_keys file of the factory cannot be read.');
  const present = current.code === 0 && current.stdout.split('\n').some((entry) => entry.trim() && entry.trim().split(/\s+/).includes(blob));
  if (present) out.write('The Mac key is already authorized in the factory.\n');
  else {
    const keyLine = line.split(/\s+/).length > 2 ? line : `${line} herdr-boss-attach`;
    state.keyAdded = true; state.keyLine = keyLine;
    save('pending');
    const added = await docker.run(['exec', '--user', 'factory', '-e', 'HOME=/home/factory', record.containerName, 'sh', '-c', APPEND_KEY, 'sh', keyLine]);
    if (added.code !== 0) throw failure('The Mac key could not be added to the factory.');
    out.write('Added the Mac key to the factory.\n');
  }

  // The first contact records the host key line of this alias through ssh itself. Herdr connects with no prompt.
  const contact = await run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new', alias(name), 'true'], { env: io.env, timeout: 30000 });
  if (contact.code !== 0) throw stepFailure('ssh check', contact, host, name, record);

  let machines = await listMachines(run, io.env, host, name, record);
  // Reuse a machine by its recorded ID or by the same target. Never add a second one.
  let entry = machines.find((item) => previous?.machineId && machineId(item) === previous.machineId) || machines.find((item) => item?.target === alias(name));
  if (!entry) {
    if (machines.some((item) => item?.label === name)) throw failure(`A saved Herdr machine already uses the label ${name} for another target. Rename or remove it first.`);
    const added = await run('herdr', ['machine', 'add', '--label', name, alias(name)], { env: io.env, timeout: 60000 });
    if (added.code !== 0) throw stepFailure('add', added, host, name, record);
    machines = await listMachines(run, io.env, host, name, record);
    entry = machines.find((item) => item?.target === alias(name));
    if (!machineId(entry)) throw failure('The machine was added, but its machine id was not found in the machine list. Run the command again.');
    state.machineCreated = true;
  } else {
    if (!machineId(entry)) throw failure('The saved machine has no machine id in the machine list.');
    if (machineId(entry) !== previous?.machineId) state.machineCreated = false;
    out.write('The Herdr machine exists. Attach reuses it.\n');
  }
  const id = String(machineId(entry));
  if (!MACHINE_ID.test(id)) throw failure('The machine id has an unexpected form.');
  if (entry.label && machines.filter((item) => item?.label === entry.label).length > 1) throw failure('Two saved Herdr machines share the label of this machine. Rename one of them first.');
  state.machineId = id;
  save('pending');

  const status = await run('herdr', ['machine', 'status', id, '--json'], { env: io.env, timeout: 30000 });
  if (status.code !== 0 || /"(?:status|state)"\s*:\s*"(?:fail|error|offline|unreach|auth)/i.test(status.stdout)) throw stepFailure('status', status, host, name, record);
  // The API path works inside a Herdr pane. `herdr --remote` does not, because a nested Herdr is off by default.
  const api = await run('herdr', ['--machine', id, 'workspace', 'list'], { env: io.env, timeout: 30000 });
  if (api.code !== 0) throw stepFailure('api check', api, host, name, record);
  save('attached');
  if (io.env.HERDR_ENV) out.write('The optional remote attach check is skipped inside a Herdr pane.\n');
  else {
    const remote = await run('herdr', ['--remote', alias(name)], { env: { ...io.env, TERM: 'xterm-256color' }, timeout: REMOTE_LIMIT_MS });
    if (remote.timedOut) out.write('The optional remote attach check was inconclusive: Herdr still ran at the time limit.\n');
    else if (remote.code === 0) out.write('The optional remote attach check passed.\n');
    else if (/nested herdr is disabled/i.test(`${remote.stderr}${remote.stdout}`)) out.write('The optional remote attach check is skipped: nested Herdr is disabled.\n');
    else out.write('The optional remote attach check failed. The machine works through the API check.\n');
  }
  // A label that came from an existing machine stays out of the output.
  out.write(`Attached. Alias: ${alias(name)}. Sidebar label: ${entry.label === name ? name : 'the label of the saved machine'}.\nDetach with: herdr-boss factory attach ${name} --undo\n`);
  return 0;
}

async function undo(name, io, run) {
  const out = io.stdout;
  const file = conffile(io.env, name);
  const stateFile = factoryFile(io.env, name, ATTACH_FILE);
  const record = readPrivate(stateFile, null);
  if (!record && !fs.existsSync(file)) { out.write(`${name} nothing is left to undo.\n`); return 0; }
  // The attach record is enough to undo. The factory can be gone from the fleet registry.
  let managed = null;
  try { managed = managedFactory(io.env, name); } catch { /* Undo continues with the attach record. */ }
  const host = managed?.host || {};
  const removed = [];
  let keyNote = '';
  if (record?.keyAdded && record.keyLine) {
    try {
      const docker = transportFor(host, io);
      const container = managed ? await inspect(docker, 'container', managed.record.containerName) : null;
      if (!container?.State?.Running) throw new Error();
      assertOwned(container, name);
      const result = await docker.run(['exec', '--user', 'factory', '-e', 'HOME=/home/factory', managed.record.containerName, 'sh', '-c', REMOVE_KEY, 'sh', record.keyLine]);
      if (result.code !== 0) throw new Error();
      removed.push('Mac key in the factory');
    } catch { keyNote = ' The Mac key stays in the factory (the factory is not reachable). Remove it by hand.'; }
  } else keyNote = ' The Mac key stays in the factory: attach did not add it.';
  // Remove a machine only when attach created it. A machine that attach reused stays.
  if (record?.machineId && (record.schema === 1 || record.machineCreated === true)) {
    const machines = await listMachines(run, io.env, host, name, managed?.record);
    if (machines.some((item) => String(machineId(item)) === record.machineId)) {
      const result = await run('herdr', ['machine', 'remove', record.machineId], { env: io.env });
      if (result.code !== 0) throw stepFailure('remove', result, host, name, managed?.record);
      removed.push('Herdr machine');
    }
  }
  if (fs.existsSync(file)) { fs.rmSync(file); removed.push('SSH include file'); }
  if (removeInclude(io.env)) removed.push('Include line');
  fs.rmSync(stateFile, { force: true });
  out.write(`${name} detached: removed ${removed.length ? removed.join(', ') : 'the attach record'}.${keyNote}\n`);
  return 0;
}

export async function factoryAttachCommand(args, io) {
  const undoOnly = args.includes('--undo');
  const names = args.filter((arg) => arg !== '--undo');
  if (names.length !== 1 || args.length !== (undoOnly ? 2 : 1)) throw new Error('Use factory attach NAME [--undo].');
  assertName(names[0]);
  if (!undoOnly && !readFleet(io.env).factories.some((item) => item.name === names[0] && item.kind === 'container')) throw new Error('The container factory is not in the fleet registry.');
  const run = io.run || defaultRun;
  try { return await (undoOnly ? undo : attach)(names[0], io, run); }
  catch (error) {
    if (error.attach) { io.stderr.write(`${names[0]} attach failed: ${error.message}\n`); return 1; }
    if (isHostUnreachable(error)) { io.stderr.write(`${names[0]} attach failed: the factory host is unreachable.\n`); return 1; }
    io.stderr.write(`${names[0]} attach failed: ${error.message}\n`);
    return 1;
  }
}
