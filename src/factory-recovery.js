// Recovery goes directly to Docker. It never needs the service or the engine.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { FACTORY_LABEL, managedFactory, transportFor, inspect, dockerCall, configSafetyError, imageBuildMeta, hostFor, factoryCoreCommand } from './factory-core.js';
import { assertName, factoryFile, readPrivate, writePrivate, readFleet, updateFleet, VOLUMES, assertVersion, effectiveMinimum } from './factory-store.js';
import { factoriesDir, maskLine } from './factory-host.js';
import { archiveScript, readBackup } from './factory-archive.js';
import { redactSecrets } from './redact.js';

const OWNER_LABEL = 'herdr-factory-spike';
const DAY = 24 * 3600_000;
// A login command needs a terminal. `factory shell` has no terminal, so it refuses an interactive login command.
export function isInteractiveLoginCommand(command = []) {
  return /(?:^|\s)auth\s+login(?:\s|$)/.test(command.join(' ')) || command.some((token) => token === 'login' || token === '/login');
}
const wholeSeconds = (value) => new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
function parse(args, options = [], switches = []) {
  const positional = [], flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    if (!word.startsWith('--')) { positional.push(word); continue; }
    if ((!options.includes(word) && !switches.includes(word)) || Object.hasOwn(flags, word)) throw new Error('Invalid recovery option.');
    if (switches.includes(word)) flags[word] = true;
    else { const value = args[++index]; if (!value || value.startsWith('--')) throw new Error('The recovery option needs a value.'); flags[word] = value; }
  }
  return { positional, flags };
}
function ownerOf(resource, name, expected) {
  const labels = resource?.Config?.Labels || resource?.Labels;
  if (labels?.[FACTORY_LABEL] !== name || !/^(?=.{1,31}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$(?![\s\S])/.test(labels?.[OWNER_LABEL] || '') || (expected && labels[OWNER_LABEL] !== expected)) throw new Error('The resource has no matching factory and worker labels.');
  return labels[OWNER_LABEL];
}
async function resources(name, io, allVolumes = false, destroyOwner = null) {
  const factory = managedFactory(io.env, name);
  const docker = transportFor(factory.host, io);
  const container = await inspect(docker, 'container', factory.record.containerName);
  if (!container && !destroyOwner) throw new Error('The factory container is missing.');
  const owner = container ? ownerOf(container, name, destroyOwner) : destroyOwner;
  const unsafe = container ? configSafetyError(container, name) : null;
  if (unsafe) throw new Error(unsafe);
  if (allVolumes) for (const kind of Object.keys(VOLUMES)) {
    const volume = await inspect(docker, 'volume', `hf-${name}-${kind}`);
    if (!volume) { if (destroyOwner) continue; throw new Error('A factory volume is missing.'); }
    ownerOf(volume, name, owner);
  }
  return { ...factory, docker, container, owner };
}

// Resolve existing ancestors before checking. A symlink must not hide a repository or cloud folder.
export function privateBackupPath(file, env) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) throw new Error('Use an absolute private backup file path.');
  let existing = path.resolve(file);
  const tail = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error('The backup folder cannot be resolved.');
    // Refuse dangling links rather than treating them as new paths.
    try { if (fs.lstatSync(existing).isSymbolicLink()) throw new Error('The backup path has an invalid symlink.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    tail.unshift(path.basename(existing)); existing = parent;
  }
  const resolved = path.join(fs.realpathSync(existing), ...tail);
  const home = path.resolve(env.HOME || '');
  const cloudRoots = ['Library/CloudStorage', 'Library/Mobile Documents', 'Dropbox', 'OneDrive', 'Google Drive', 'iCloud Drive'].map((part) => path.join(home, part));
  const inside = (root) => { const relative = path.relative(root, resolved); return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); };
  if (cloudRoots.some(inside) || resolved.split(path.sep).some((part) => /^(?:Dropbox|OneDrive(?: - .*)?|Google Drive|iCloud Drive|CloudStorage|Mobile Documents)$/i.test(part))) throw new Error('Store the backup outside cloud folders.');
  for (let directory = path.dirname(resolved); ; directory = path.dirname(directory)) {
    if (fs.existsSync(path.join(directory, '.git')) || fs.existsSync(path.join(directory, 'HEAD')) && fs.existsSync(path.join(directory, 'objects')) && fs.existsSync(path.join(directory, 'refs'))) throw new Error('Store the backup outside every repository.');
    if (path.dirname(directory) === directory) break;
  }
  return resolved;
}
async function hashFile(file) {
  const hash = createHash('sha256');
  try { for await (const chunk of fs.createReadStream(file)) hash.update(chunk); }
  catch { throw new Error('The factory backup cannot be read.'); }
  return hash.digest('hex');
}
function helperArgs(name, imageTag, owner, kinds, action, manifest) {
  const roots = Object.fromEntries(kinds.map((kind) => [kind, `/volumes/${kind}`]));
  const args = ['run', '--rm', '--name', `hf-${name}-${action}-${randomBytes(6).toString('hex')}`, '--label', `${FACTORY_LABEL}=${name}`, '--label', `${OWNER_LABEL}=${owner}`, '--user', '0:0', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=2g', ...(['restore', 'replace'].includes(action) ? ['--interactive'] : [])];
  // Run as root only to read and restore volume ownership. No host path is mounted.
  args.push('--cap-add', 'DAC_OVERRIDE');
  if (action === 'restore' || action === 'replace') args.push('--cap-add', 'CHOWN', '--cap-add', 'FOWNER');
  for (const kind of kinds) args.push('--mount', `type=volume,source=hf-${name}-${kind},target=/volumes/${kind}${action === 'backup' ? ',readonly' : ''}`);
  args.push('--entrypoint', 'node', imageTag, '--input-type=module', '-e', archiveScript, action, JSON.stringify(roots), ...(manifest ? [JSON.stringify(manifest)] : []));
  return args;
}
async function runArchiveHelper(docker, args, options, name, owner, cleaned) {
  const helperName = args[args.indexOf('--name') + 1];
  try { return await dockerCall(docker, args, options); }
  finally {
    try {
      const helper = await inspect(docker, 'container', helperName);
      if (helper) {
        ownerOf(helper, name, owner);
        const result = await docker.run(['container', 'rm', '--force', helperName]);
        // Docker's --rm can remove the helper between inspect and this command.
        if (result.code !== 0 && await inspect(docker, 'container', helperName)) throw new Error('The helper is still present.');
      }
      cleaned();
    } catch { throw new Error('The factory archive helper cleanup failed. Recovery stopped before source restart or volume rollback.'); }
  }
}
async function confirmation(name, io) {
  if (!io.stdin?.isTTY) throw new Error('Use an Owner terminal for typed confirmation.');
  io.stdout.write(`Type the factory name ${name} to confirm: `);
  const lines = createInterface({ input: io.stdin, crlfDelay: Infinity });
  let answer;
  try { for await (const line of lines) { answer = line; break; } } finally { lines.close(); }
  if (answer !== name) throw new Error('The typed factory confirmation does not match.');
}
async function backup(args, io) {
  const { positional, flags } = parse(args, ['--file'], ['--include-home']);
  if (positional.length !== 1) throw new Error('Give exactly one factory name.');
  const name = positional[0]; assertName(name);
  const file = privateBackupPath(flags['--file'] || path.join(factoriesDir(io.env), 'backups', `${name}-${Date.now()}.hfb`), io.env);
  if (fs.existsSync(file)) throw new Error('The backup file already exists.');
  const parent = path.dirname(file);
  if (fs.existsSync(parent) && (fs.statSync(parent).mode & 0o777) !== 0o700) throw new Error('Use a private backup folder with mode 700.');
  const { record, local, docker, container, owner } = await resources(name, io, true);
  const manifest = { schema: 1, contractVersion: '1.0.0', format: 'herdr-boss.factory-backup/1', name, factoryId: record.factoryId, createdAt: wholeSeconds(Date.now()), profile: record.profile, version: record.version, kitRevision: record.kitRevision, imageTag: local.imageTag, image: { ...record.image, builtAt: wholeSeconds(record.image.builtAt) }, ports: record.ports, volumes: ['data', 'work', ...(flags['--include-home'] ? ['home'] : [])], resourceOwner: owner };
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const partial = `${file}.${randomBytes(6).toString('hex')}.partial`;
  const paused = container.State?.Paused === true;
  const running = container.State?.Running === true;
  const updateQuiesced = io.updateQuiescedBackup === true;
  let stopped = false;
  let helperCleaned = true;
  try {
    if (updateQuiesced) {
      if (!running || !paused) throw new Error('The factory must be paused before its update backup.');
    } else {
      if (paused) await dockerCall(docker, ['unpause', record.containerName]);
      if (running) { await dockerCall(docker, ['stop', '--time', '30', record.containerName], { timeout: 45_000 }); stopped = true; }
    }
    helperCleaned = false;
    await runArchiveHelper(docker, helperArgs(name, local.imageTag, owner, manifest.volumes, 'backup', manifest), { outputFile: partial, timeout: 3600_000 }, name, owner, () => { helperCleaned = true; });
    const verified = await readBackup(partial);
    if (JSON.stringify(verified) !== JSON.stringify(manifest)) throw new Error('The backup identity does not match.');
    fs.chmodSync(partial, 0o600);
    // An exclusive link prevents a concurrent backup from overwriting a file.
    fs.linkSync(partial, file);
    writePrivate(factoryFile(io.env, name, 'backup.json'), { schema: 1, name, file, createdAt: manifest.createdAt, sha256: await hashFile(file) });
  } finally {
    fs.rmSync(partial, { force: true });
    if (!updateQuiesced && stopped && helperCleaned) await dockerCall(docker, ['start', record.containerName]);
    if (!updateQuiesced && paused && helperCleaned) await dockerCall(docker, ['pause', record.containerName]);
  }
  io.stdout.write(`Backed up factory ${name}.\n`);
  return 0;
}

// Restore the factory volumes from the private update backup after a failed migration.
// The caller must stop the service and pause the container before it calls this function.
export async function restoreBackupInPlace(name, file, io) {
  const manifest = await readBackup(file);
  if (manifest.name !== name || !manifest.volumes.includes('home')) throw new Error('The update backup does not include this factory and its home volume.');
  const receipt = readPrivate(factoryFile(io.env, name, 'backup.json'), null);
  if (!receipt || receipt.name !== name || receipt.file !== file || receipt.createdAt !== manifest.createdAt || await hashFile(file) !== receipt.sha256) throw new Error('The update backup identity or checksum does not match.');
  const fleet = readFleet(io.env);
  const record = fleet.factories.find((item) => item.name === name);
  const { local, docker, owner } = await resources(name, io, true, manifest.resourceOwner);
  if (local.name !== name || manifest.factoryId !== record?.factoryId || owner !== manifest.resourceOwner) throw new Error('The update backup is for another factory.');
  await runArchiveHelper(docker, helperArgs(name, local.imageTag, owner, manifest.volumes, 'replace', manifest), { inputFile: file, timeout: 3600_000 }, name, owner, () => {});
}

async function destroy(args, io) {
  const { positional } = parse(args);
  if (positional.length !== 1) throw new Error('Give exactly one factory name.');
  const name = positional[0]; assertName(name);
  const receipt = readPrivate(factoryFile(io.env, name, 'backup.json'), null);
  const age = Date.now() - Date.parse(receipt?.createdAt);
  if (!receipt || receipt.name !== name || !Number.isFinite(age) || age < 0 || age > DAY) throw new Error('Destroy needs a fresh backup from the last 24 hours.');
  const file = privateBackupPath(receipt.file, io.env);
  if ((fs.statSync(file).mode & 0o777) !== 0o600) throw new Error('The backup file must have mode 600.');
  const manifest = await readBackup(file);
  if (manifest.name !== name || manifest.createdAt !== receipt.createdAt || await hashFile(file) !== receipt.sha256) throw new Error('The factory backup identity or checksum does not match.');
  if (!manifest.volumes.includes('home')) throw new Error('Destroy needs a backup that includes home. Back up with --include-home.');
  await confirmation(name, io);
  const { record, docker, container, owner } = await resources(name, io, true, manifest.resourceOwner);
  if (manifest.resourceOwner !== owner || manifest.factoryId !== record.factoryId) throw new Error('The backup is for another factory.');
  if (container) {
    if (container.State?.Paused) await dockerCall(docker, ['unpause', record.containerName]);
    if (container.State?.Running) await dockerCall(docker, ['stop', '--time', '30', record.containerName], { timeout: 45_000 });
    const current = await inspect(docker, 'container', record.containerName);
    ownerOf(current, name, owner);
    if (current.Id !== container.Id) throw new Error('The factory container changed. Retry the command.');
    await dockerCall(docker, ['container', 'rm', record.containerName]);
  }
  for (const kind of Object.keys(VOLUMES)) {
    const volumeName = `hf-${name}-${kind}`;
    const volume = await inspect(docker, 'volume', volumeName);
    if (!volume) continue;
    ownerOf(volume, name, owner);
    await dockerCall(docker, ['volume', 'rm', volumeName]);
  }
  updateFleet(io.env, (fleet) => { fleet.factories = fleet.factories.filter((item) => item.name !== name); });
  // Keep the backup receipt. Remove only this factory's creation and flow records.
  for (const fileName of ['factory.json', 'flow.json']) fs.rmSync(factoryFile(io.env, name, fileName), { force: true });
  io.stdout.write(`Destroyed factory ${name}. The backup is retained.\n`);
  return 0;
}
async function restore(args, io) {
  const { positional, flags } = parse(args, ['--host']);
  if (positional.length !== 1) throw new Error('Give exactly one backup file.');
  const file = privateBackupPath(path.resolve(positional[0]), io.env);
  if ((fs.statSync(file).mode & 0o777) !== 0o600) throw new Error('The backup file must have mode 600.');
  const manifest = await readBackup(file);
  const { name } = manifest;
  await confirmation(name, io);
  const fleet = readFleet(io.env);
  assertVersion(manifest.version, effectiveMinimum(fleet));
  if (fleet.factories.some((item) => item.name === name || item.factoryId === manifest.factoryId)) throw new Error('The restore factory already exists.');
  const host = hostFor(io.env, name, flags['--host']);
  const usedPorts = new Set(fleet.factories.filter((item) => item.hostId === host.hostId && item.ports).flatMap((item) => Object.values(item.ports)));
  if (Object.values(manifest.ports).some((port) => usedPorts.has(port))) throw new Error('The restore factory ports collide.');
  const docker = transportFor(host, io);
  if (await inspect(docker, 'container', `hf-${name}`)) throw new Error('Restore refuses an existing container for the factory name stored in the backup.');
  for (const kind of Object.keys(VOLUMES)) if (await inspect(docker, 'volume', `hf-${name}-${kind}`)) throw new Error('Restore refuses an existing factory volume.');
  const image = await inspect(docker, 'image', manifest.imageTag);
  if (!image) throw new Error('Restore needs the matching factory image. Build or load it first.');
  const imageMeta = imageBuildMeta(image);
  if (imageMeta.pinsHash !== manifest.image.pinsHash || wholeSeconds(imageMeta.builtAt) !== manifest.image.builtAt) throw new Error('Restore needs the matching factory image. Build or load it first.');
  const pending = factoryFile(io.env, name);
  if (readPrivate(pending, null)) throw new Error('A pending factory already uses this name.');
  writePrivate(pending, { schema: 1, name, hostId: host.hostId, profile: 'personal', imageTag: manifest.imageTag, ports: manifest.ports, stage: 'restoring', resourceOwner: manifest.resourceOwner });
  const created = [];
  let transportFailed = false;
  let helperCleaned = true;
  const tracked = { async run(args, options) {
    try {
      const result = await docker.run(args, options);
      const creation = args[1] === 'create' && ['volume', 'container'].includes(args[0]);
      if (creation && result.code === 0) created.push({ kind: args[0], name: args[0] === 'volume' ? args.at(-1) : args[args.indexOf('--name') + 1] });
      if (creation && result.code !== 0) transportFailed = true;
      return result;
    } catch (error) { transportFailed = true; throw error; }
  } };
  try {
    const result = await factoryCoreCommand(['new', name, '--host', host.hostId, '--image', manifest.imageTag], { ...io, transportFactory: () => tracked, prepareFactoryVolumes: async () => {
      helperCleaned = false;
      await runArchiveHelper(docker, helperArgs(name, manifest.imageTag, manifest.resourceOwner, manifest.volumes, 'restore'), { inputFile: file, timeout: 3600_000 }, name, manifest.resourceOwner, () => { helperCleaned = true; });
    } });
    if (result !== 0) throw new Error('The restored factory did not pass its service checks.');
    updateFleet(io.env, (current) => { current.factories.find((item) => item.name === name).factoryId = manifest.factoryId; });
  } catch (error) {
    // A lost reply does not establish that Docker created no resource.
    // Inspect the fixed target names and remove only matching owned resources.
    if (!helperCleaned) throw error;
    const candidates = transportFailed ? [
      { kind: 'container', name: `hf-${name}` },
      ...Object.keys(VOLUMES).reverse().map((kind) => ({ kind: 'volume', name: `hf-${name}-${kind}` })),
    ] : created.reverse();
    try {
      let changedLabel = false;
      for (const resource of candidates) {
        const current = await inspect(docker, resource.kind, resource.name);
        if (!current) continue;
        try { ownerOf(current, name, manifest.resourceOwner); }
        catch { changedLabel = true; continue; }
        if (resource.kind === 'container' && current.State?.Running) await dockerCall(docker, ['stop', '--time', '0', resource.name]);
        await dockerCall(docker, [resource.kind, 'rm', resource.name]);
      }
      if (changedLabel) throw new Error('A target resource has different labels.');
      updateFleet(io.env, (current) => { current.factories = current.factories.filter((item) => item.name !== name); });
      for (const fileName of ['factory.json', 'flow.json']) fs.rmSync(factoryFile(io.env, name, fileName), { force: true });
    } catch { throw new Error('Restore failed. Cleanup stopped at an unavailable or changed resource. The pending factory is retained.'); }
    throw error;
  }
  io.stdout.write(`Restored factory ${name}.\n`);
  return 0;
}
async function repair(action, args, io) {
  let positional, flags, command;
  if (action === 'shell') {
    const cut = args.indexOf('--');
    positional = cut < 0 ? args : args.slice(0, cut);
    command = cut < 0 ? null : args.slice(cut + 1);
    if (command?.length === 0) throw new Error('Give a shell command after --.');
    flags = {};
  } else ({ positional, flags } = parse(args, action === 'logs' ? ['--tail'] : [], action === 'freeze' ? ['--off'] : []));
  if (positional.length !== 1) throw new Error('Give exactly one factory name.');
  const name = positional[0]; assertName(name);
  if (action === 'shell' && !command && !io.stdin?.isTTY) throw new Error('Use an Owner terminal for the factory shell.');
  if (action === 'shell' && command && isInteractiveLoginCommand(command)) {
    // Refuse before any transport call. The Owner runs the login through `factory login`, which keeps the terminal attached.
    const error = new Error(`No terminal here. Use "herdr-boss factory shell ${name}" for an interactive command.`);
    error.exitCode = 2;
    throw error;
  }
  if (action === 'logs' && flags['--tail'] && !/^(?:[1-9][0-9]{0,3}|10000)$/.test(flags['--tail'])) throw new Error('Use a log tail from 1 to 10000.');
  const { record, host, docker, container } = await resources(name, io);
  if (action === 'freeze') {
    if (flags['--off']) { if (container.State?.Paused) await dockerCall(docker, ['unpause', record.containerName]); }
    else if (container.State?.Running && !container.State?.Paused) await dockerCall(docker, ['pause', record.containerName]);
    io.stdout.write(`${flags['--off'] ? 'Unfroze' : 'Froze'} factory ${name}.\n`);
  } else {
    const result = await docker.run(action === 'logs' ? ['logs', '--tail', flags['--tail'] || '200', record.containerName] : ['exec', ...(command ? [] : ['--interactive', '--tty']), '--user', 'factory', record.containerName, ...(command || ['bash', '--login'])], { interactive: action === 'shell' && !command, timeout: action === 'shell' ? 24 * 3600_000 : 30_000 });
    io.stdout.write(redactSecrets(maskLine(result.stdout, host, true)));
    io.stderr.write(redactSecrets(maskLine(result.stderr, host, true)));
    return result.code;
  }
  return 0;
}
export async function factoryRecoveryCommand(args, io) {
  const [action, ...rest] = args;
  try {
    if (action === 'backup') return await backup(rest, io);
    if (action === 'restore') return await restore(rest, io);
    if (action === 'destroy') return await destroy(rest, io);
    return await repair(action, rest, io);
  } catch (error) {
    if (['EACCES', 'EPERM', 'ENOENT', 'EEXIST', 'EISDIR', 'ENOTDIR', 'ENOSPC', 'ELOOP'].includes(error.code)) throw new Error('The factory recovery file operation failed.');
    throw error;
  }
}
