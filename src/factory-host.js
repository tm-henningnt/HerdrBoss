// The command line of `herdr-boss factory host add|list|remove`, `factory ssh`, and `factory docker`.
// The registry of hosts is `registry.json` in ~/.herdr-factories (HERDR_FACTORIES_DIR overrides the folder).
// It holds connection fields and host settings. It never holds key content.
// Output from ssh passes through maskLine, so the address, the host name, an IP, and the key path never reach a terminal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export const FACTORY_HOST_USAGE = [
  'Usage: factory host add NAME --address ADDR --user USER --key-file PATH [--from-file FILE|-] [--runtime RUNTIME] [--personal-only true|false] [--codex-sandbox user-namespaces|unavailable]',
  '       factory host add NAME --docker-context CONTEXT [--runtime RUNTIME] [--personal-only true|false] [--codex-sandbox user-namespaces|unavailable]',
  '       factory host add NAME [--runtime RUNTIME] [--personal-only true|false] [--codex-sandbox user-namespaces|unavailable]  (update an existing host)',
  '       factory host list',
  '       factory host remove NAME',
  '       factory ssh HOST -- COMMAND...',
  '       factory docker HOST -- ARGS...',
  '       factory connect [--check|--undo] NAME',
  '       factory update NAME --tier service|image [--dry-run] [--accept-data-loss] [--allow-boss-restart]',
  '       factory backup NAME [--file FILE] [--include-home]',
  '       factory restore FILE [--host HOST]',
  '       factory destroy NAME',
  '       factory shell NAME [-- COMMAND...]',
  '       factory logs NAME [--tail COUNT]',
  '       factory freeze NAME [--off]',
].join('\n');

const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;
const ADDRESS = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/;
const USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;
const HOST_FIELDS = ['address', 'user', 'keyFile', 'dockerContext', 'runtime', 'personalOnly', 'codexSandbox'];
const HOST_RUNTIMES = ['orbstack', 'colima', 'docker-engine', 'docker-engine-wsl2'];
const CODEX_SANDBOXES = ['user-namespaces', 'unavailable'];
const SSH_FAILED = 255;
const DOCKER_PASSTHROUGH_TIMEOUT_MS = 1_800_000;
const MASK_HOST = '<host>';
const MASK_KEY = '<key>';
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6 = /(?<![0-9A-Za-z:])(?=[0-9A-Fa-f:]*:[0-9A-Fa-f:]*:)(?:[0-9A-Fa-f]{0,4}:){2,}[0-9A-Fa-f]{0,4}(?![0-9A-Za-z:])/g;
const TAILNET = /(?<![^\s'"`])[^\s'"`]+\.ts\.net\b/gi;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const usageError = (message) => new Error(`${message}\n${FACTORY_HOST_USAGE}`);

export function factoriesDir(env = process.env) {
  return env.HERDR_FACTORIES_DIR || path.join(env.HOME || os.homedir(), '.herdr-factories');
}

function registryFile(env) { return path.join(factoriesDir(env), 'registry.json'); }

export function loadRegistry(env = process.env) {
  let raw;
  try { raw = fs.readFileSync(registryFile(env), 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, hosts: {} };
    throw new Error('The host registry cannot be read.');
  }
  let registry;
  try { registry = JSON.parse(raw); } catch { throw new Error('The host registry is not valid JSON.'); }
  if (!registry || typeof registry !== 'object' || !registry.hosts || typeof registry.hosts !== 'object') throw new Error('The host registry has no hosts object.');
  return registry;
}

const LOCK_STALE_MS = 60_000;

function lockIsStale(lock) {
  let stat;
  try { stat = fs.statSync(lock); } catch { return false; }
  if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) return true;
  let pid;
  try { pid = Number.parseInt(fs.readFileSync(lock, 'utf8'), 10); } catch { return false; }
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
}

// Take an exclusive lock file for a synchronous read-modify-write. A lock is stale when its owner process is gone or it is older than 60 seconds.
export function acquireLock(lock, busyMessage) {
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  let descriptor;
  for (let attempt = 0; descriptor === undefined; attempt += 1) {
    try { descriptor = fs.openSync(lock, 'wx', 0o600); } catch (error) {
      if (error.code !== 'EEXIST' || attempt > 0 || !lockIsStale(lock)) throw new Error(busyMessage);
      fs.rmSync(lock, { force: true });
    }
  }
  try { fs.writeSync(descriptor, `${process.pid}\n`); } catch { /* The age check covers an unwritten owner. */ }
  return () => { fs.closeSync(descriptor); fs.rmSync(lock, { force: true }); };
}

// Change the registry under its lock. Keep the change function synchronous.
export function updateRegistry(env, change) {
  const release = acquireLock(path.join(factoriesDir(env), 'registry.lock'), 'The host registry is busy. Retry the command.');
  try {
    const registry = loadRegistry(env);
    change(registry);
    saveRegistry(env, registry);
    return registry;
  } finally { release(); }
}

function saveRegistry(env, registry) {
  const dir = factoriesDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = registryFile(env);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

function findHost(env, name) {
  const hosts = loadRegistry(env).hosts;
  if (typeof name !== 'string' || !Object.hasOwn(hosts, name)) throw new Error('The host is not in the registry. Run `herdr-boss factory host list`.');
  return { name, ...hosts[name] };
}

// Mask the address, the host name, the key path, and any IP address in one line of ssh output.
const ENDPOINT = /\b(?:ssh|tcp|unix|npipe|http|https):\/\/\S+/gi;
const NAME_LINE = /^(\s*Name:[ \t]*).*$/gm;

// `docker` output also masks tailnet names, endpoints, and the `Name:` line that a remote Docker prints.
export function maskLine(line, host, docker = false) {
  const maskHosts = (value) => {
    let text = value;
    if (host.address) text = text.replace(new RegExp(escapeRegExp(host.address), 'gi'), MASK_HOST);
    if (host.name) text = text.replace(new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(host.name)}(?![A-Za-z0-9_-])`, 'gi'), MASK_HOST);
    return text;
  };
  let text = maskHosts(line);
  if (docker) text = text.replace(NAME_LINE, '$1<host>').replace(ENDPOINT, '<endpoint>').replace(TAILNET, MASK_HOST);
  const replace = (value, mask) => {
    if (typeof value === 'string' && value) text = text.split(value).join(mask);
  };
  // A host name can also occur in the key path. Match the path after the same host masking.
  if (host.keyFile) replace(maskHosts(host.keyFile), MASK_KEY);
  replace(host.dockerContext, '<context>');
  if (host.keyFile) replace(path.basename(host.keyFile), MASK_KEY);
  return text.replace(TAILNET, MASK_HOST).replace(IPV4, MASK_HOST).replace(IPV6, (value) => (
    value.includes('::') || value.split(':').length === 8 ? MASK_HOST : value
  ));
}

// Quote one argument for the remote shell. ssh joins the arguments with spaces and the remote shell splits them again.
export function shellQuote(value) {
  if (value === '') return "''";
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function parseFlags(args, known, name) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) { positional.push(token); continue; }
    if (!known.includes(token)) throw usageError(`Unknown option: ${token}.`);
    if (token in flags) throw usageError(`${token} may be used only once.`);
    const value = args[++index];
    if (value === undefined || (value.startsWith('--') && value !== '--')) throw usageError(`${token} needs a value.`);
    flags[token] = value;
  }
  if (positional.length !== 1) throw usageError(`Give exactly one ${name}.`);
  return { flags, name: positional[0] };
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function expandHome(file, env) {
  if (file === '~') return env.HOME || os.homedir();
  return file.startsWith('~/') ? path.join(env.HOME || os.homedir(), file.slice(2)) : file;
}

async function hostFields(flags, io) {
  const fromFile = flags['--from-file'];
  const given = ['--address', '--user', '--key-file', '--docker-context', '--runtime', '--personal-only', '--codex-sandbox'].some((flag) => flag in flags);
  let json = {};
  if (fromFile !== undefined || !given) {
    if (fromFile === undefined && io.stdin.isTTY) throw usageError('Give --address, --user, and --key-file, or JSON on stdin.');
    let raw;
    try { raw = fromFile !== undefined && fromFile !== '-' ? fs.readFileSync(fromFile, 'utf8') : await readAll(io.stdin); } catch { throw new Error('The host JSON cannot be read.'); }
    try { json = JSON.parse(raw); } catch { throw new Error('The host JSON is not valid.'); }
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('The host JSON must be an object.');
    const extra = Object.keys(json).filter((key) => !HOST_FIELDS.includes(key));
    if (extra.length) throw new Error(`The host JSON has unknown fields: ${extra.join(', ')}. Use address, user, keyFile, runtime, personalOnly, codexSandbox.`);
  }
  return {
    address: flags['--address'] ?? json.address,
    user: flags['--user'] ?? json.user,
    keyFile: flags['--key-file'] ?? json.keyFile,
    dockerContext: flags['--docker-context'] ?? json.dockerContext,
    runtime: flags['--runtime'] ?? json.runtime,
    personalOnly: flags['--personal-only'] ?? json.personalOnly,
    codexSandbox: flags['--codex-sandbox'] ?? json.codexSandbox,
  };
}

// Messages never repeat a value: an address or a key path can be secret.
function validateHost(fields, env) {
  const { address, user, keyFile, dockerContext, runtime, personalOnly, codexSandbox } = fields;
  const settings = {};
  if (runtime !== undefined) {
    if (!HOST_RUNTIMES.includes(runtime)) throw usageError('The host runtime is invalid.');
    settings.runtime = runtime;
  }
  if (personalOnly !== undefined) {
    if (typeof personalOnly === 'boolean') settings.personalOnly = personalOnly;
    else if (personalOnly === 'true' || personalOnly === 'false') settings.personalOnly = personalOnly === 'true';
    else throw usageError('The personal-only setting must be true or false.');
  }
  if (codexSandbox !== undefined) {
    if (!CODEX_SANDBOXES.includes(codexSandbox)) throw usageError('The Codex sandbox setting must be user-namespaces or unavailable.');
    settings.codexSandbox = codexSandbox;
  }
  if (dockerContext !== undefined) {
    if (typeof dockerContext !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(dockerContext)) throw usageError('The Docker context name is invalid.');
    if (address === undefined && user === undefined && keyFile === undefined) return { transport: 'docker-context', dockerContext, ...settings };
  }
  if (address === undefined && user === undefined && keyFile === undefined) return settings;
  if (typeof address !== 'string' || !ADDRESS.test(address)) throw usageError('The address is missing or has characters that a host address cannot have.');
  if (typeof user !== 'string' || !USER.test(user)) throw usageError('The user is missing or has characters that a user name cannot have.');
  if (typeof keyFile !== 'string' || !keyFile) throw usageError('The key file path is missing.');
  const expanded = expandHome(keyFile, env);
  if (!path.isAbsolute(expanded) || expanded.includes('\0')) throw usageError('The key file path must be absolute.');
  return { address, user, keyFile: path.normalize(expanded), transport: 'ssh', ...(dockerContext ? { dockerContext } : {}), ...settings };
}

async function hostCommand(args, io) {
  const [action, ...rest] = args;
  if (action === 'add') {
    const { flags, name } = parseFlags(rest, ['--address', '--user', '--key-file', '--from-file', '--docker-context', '--runtime', '--personal-only', '--codex-sandbox'], 'host name');
    if (!NAME.test(name)) throw usageError('The host name must use lower case letters, digits, and hyphens, up to 31 characters.');
    if (name === 'local') throw usageError('The host name local is reserved.');
    const host = validateHost(await hostFields(flags, io), io.env);
    const privateConnectionFlags = ['--address', '--user', '--key-file', '--from-file'].some((flag) => flag in flags);
    let updated = false;
    updateRegistry(io.env, (registry) => {
      if (Object.hasOwn(registry.hosts, name)) {
        if (privateConnectionFlags) throw new Error('The host is already in the registry. Remove it first.');
        const hasSetting = ['runtime', 'personalOnly', 'codexSandbox'].some((field) => field in host);
        if (!host.dockerContext && !hasSetting) throw new Error('The host is already in the registry. Remove it first.');
        registry.hosts[name] = { ...registry.hosts[name], ...(host.dockerContext ? { dockerContext: host.dockerContext } : {}), ...Object.fromEntries(['runtime', 'personalOnly', 'codexSandbox'].filter((field) => field in host).map((field) => [field, host[field]])) };
        updated = true;
        return;
      }
      if (!host.transport) throw usageError('A new host needs SSH fields or a Docker context.');
      registry.version = 1;
      registry.hosts[name] = host;
    });
    io.stdout.write(`${updated ? 'Updated' : 'Added'} host ${name}.\n`);
    return 0;
  }
  if (action === 'list') {
    if (rest.length) throw usageError('`factory host list` takes no argument.');
    const entries = Object.entries(loadRegistry(io.env).hosts).filter(([name]) => name !== 'local');
    io.stdout.write(entries.length ? `${entries.map(([name, host]) => `${name}  ${host.user || 'docker-context'}`).join('\n')}\n` : 'No hosts.\n');
    return 0;
  }
  if (action === 'remove') {
    if (rest.length !== 1) throw usageError('Give exactly one host name.');
    findHost(io.env, rest[0]);
    updateRegistry(io.env, (registry) => { delete registry.hosts[rest[0]]; });
    io.stdout.write(`Removed host ${rest[0]}.\n`);
    return 0;
  }
  throw usageError('Unknown host command.');
}

// Write each complete line through the mask. The decoder and the buffer keep a value that a chunk boundary splits.
function maskedPipe(stream, sink, host, docker = false) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  return new Promise((resolve) => {
    stream.on('data', (chunk) => {
      pending += decoder.write(chunk);
      const cut = pending.lastIndexOf('\n');
      if (cut < 0) return;
      sink.write(maskLine(pending.slice(0, cut + 1), host, docker));
      pending = pending.slice(cut + 1);
    });
    stream.on('end', () => {
      pending += decoder.end();
      if (pending) sink.write(maskLine(pending, host, docker));
      resolve();
    });
  });
}

export function sshArguments(host, command) {
  // ssh keeps parsing options after the destination, so a command word that starts with `-` would run as a local ssh option.
  if (command[0]?.startsWith('-')) throw usageError('The remote command must not start with "-".');
  return ['-i', host.keyFile, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new', '--', `${host.user}@${host.address}`, ...command];
}

// Run ssh with an args array and no shell. The exit code of the remote command is the result; ssh failure is 255.
async function runSsh(host, command, io, docker = false) {
  let child;
  try { child = io.spawn('ssh', sshArguments(host, command), { stdio: ['inherit', 'pipe', 'pipe'], shell: false }); } catch (error) {
    throw new Error(maskLine(`ssh could not start: ${error.message}`, host));
  }
  const piped = Promise.all([maskedPipe(child.stdout, io.stdout, host, docker), maskedPipe(child.stderr, io.stderr, host, docker)]);
  let failedToStart = false;
  const exit = await new Promise((resolve) => {
    child.once('error', (error) => {
      failedToStart = true;
      io.stderr.write(`${maskLine(`ssh could not start: ${error.message}`, host)}\n`);
      resolve(SSH_FAILED);
    });
    child.once('close', (code) => resolve(code ?? SSH_FAILED));
  });
  if (!failedToStart) await piped;
  return exit;
}

function splitCommand(args, name) {
  const cut = args.indexOf('--');
  if (cut < 0 || cut !== 1 || cut === args.length - 1) throw usageError(`Give ${name} HOST -- COMMAND.`);
  return { hostName: args[0], command: args.slice(cut + 1) };
}

// `args` are the words after `factory`. `io` holds env, spawn, stdin, stdout, and stderr, so a test injects a fake transport.
export async function factoryCommand(args, io = {}) {
  const context = { env: process.env, spawn: nodeSpawn, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, ...io };
  const { isInsideContainer } = await import('./factory-core.js');
  if ((context.isContainer || isInsideContainer)()) throw new Error('The factory host tool cannot run inside a container.');
  const [sub, ...rest] = args;
  if (['backup', 'restore', 'destroy', 'shell', 'logs', 'freeze'].includes(sub)) {
    const { factoryRecoveryCommand } = await import('./factory-recovery.js');
    return factoryRecoveryCommand(args, context);
  }
  if (sub === 'connect') {
    const { factoryConnectCommand } = await import('./factory-connect.js');
    return factoryConnectCommand(rest, context);
  }
  if (sub === 'update') {
    const { factoryUpdateCommand } = await import('./factory-update.js');
    return factoryUpdateCommand(rest, context);
  }
  if (['new', 'build', 'start', 'stop', 'status', 'list', 'configure', 'login'].includes(sub)) {
    const { factoryCoreCommand } = await import('./factory-core.js');
    return factoryCoreCommand(args, context);
  }
  if (sub === 'host') return hostCommand(rest, context);
  if (sub === 'ssh') {
    const { hostName, command } = splitCommand(rest, 'factory ssh');
    const host = findHost(context.env, hostName);
    if (!host.address || !host.user || !host.keyFile) throw new Error('The host has no SSH connection record.');
    return runSsh(host, command, context);
  }
  if (sub === 'docker') {
    const { hostName, command } = splitCommand(rest, 'factory docker');
    const host = findHost(context.env, hostName);
    // A leading option such as `--context other` would select another Docker daemon.
    if (command[0].startsWith('-')) throw usageError('The Docker command must not start with "-".');
    if (host.dockerContext) {
      const { createDockerTransport } = await import('./factory-transport.js');
      const result = await createDockerTransport(host, context).run(command, { timeout: DOCKER_PASSTHROUGH_TIMEOUT_MS });
      context.stdout.write(maskLine(result.stdout, host, true));
      context.stderr.write(maskLine(result.stderr, host, true));
      return result.code;
    }
    return runSsh(host, ['docker', ...command.map(shellQuote)], context, true);
  }
  throw usageError('Unknown or missing factory command.');
}
