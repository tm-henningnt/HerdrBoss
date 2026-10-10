// The host tool imports no engine code. Docker is the only runtime boundary.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadRegistry } from './factory-host.js';
import { createDockerTransport, isHostUnreachable, hostUnreachable } from './factory-transport.js';
import { assertName, assertNoRejectedRowConflict, assertVersion, effectiveMinimum, factoryFile, readFleet, readPrivate, updateFleet, writePrivate, VOLUMES } from './factory-store.js';

export const FACTORY_ROOT = fileURLToPath(new URL('../factory/', import.meta.url));
export const FACTORY_LABEL = 'herdr-factory';
const SPIKE_LABEL = 'herdr-factory-spike=fa1';
export const defaultFactoryImage = () => `herdr-boss-factory:${createHash('sha256').update(fs.readFileSync(path.join(FACTORY_ROOT, 'pins.json'))).digest('hex')}`;

export function isInsideContainer() {
  if (fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv')) return true;
  try { return /docker|kubepods|containerd|libpod/.test(fs.readFileSync('/proc/1/cgroup', 'utf8')); } catch { return false; }
}

function parse(args, options, switches = []) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    if (!word.startsWith('--')) { positional.push(word); continue; }
    if (!options.includes(word) && !switches.includes(word)) throw new Error('Unknown factory option.');
    if (Object.hasOwn(flags, word)) throw new Error('Use each factory option once.');
    if (switches.includes(word)) flags[word] = true;
    else {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('The factory option needs a value.');
      flags[word] = value;
    }
  }
  return { positional, flags };
}

export function hostFor(env, name, explicit) {
  const registry = loadRegistry(env);
  const hostId = explicit || (Object.hasOwn(registry.hosts, name) ? name : 'local');
  if (hostId === 'local') return { ...registry.hosts.local, hostId, transport: 'local', runtime: 'orbstack', personalOnly: true, codexSandbox: 'user-namespaces' };
  assertName(hostId);
  const connection = registry.hosts[hostId];
  if (!connection) throw new Error('The host is not in the private connection store.');
  if (!connection.dockerContext) throw new Error('Add a Docker context to the private host record first.');
  return { ...connection, hostId, transport: 'docker-context', runtime: connection.runtime || 'docker-engine-wsl2', personalOnly: connection.personalOnly ?? false, codexSandbox: connection.codexSandbox || 'unavailable' };
}

export function transportFor(host, io) {
  const transport = io.transportFactory ? io.transportFactory(host) : createDockerTransport(host, io);
  return { async run(args, options) {
    try { return await transport.run(args, options); }
    catch (error) {
      if (isHostUnreachable(error)) throw hostUnreachable();
      // A transport error can contain its private endpoint or credentials.
      throw new Error('The Docker transport failed.');
    }
  } };
}

export async function dockerCall(docker, args, options) {
  const result = await docker.run(args, options);
  if (result.code !== 0) throw new Error('The Docker operation failed. Check the host runtime and the factory state.');
  return result.stdout;
}

export async function inspect(docker, kind, name) {
  const result = await docker.run([kind, 'inspect', name]);
  if (result.code !== 0) {
    if (/No such (container|volume|image|object)|not found/i.test(result.stderr || '')) return null;
    throw new Error('Docker cannot inspect the factory resource.');
  }
  try {
    const values = JSON.parse(result.stdout);
    if (!Array.isArray(values) || !values[0]) throw new Error();
    return values[0];
  } catch { throw new Error('Docker returned an invalid resource record.'); }
}

// Check the settings of a factory container. The check does not need a running container.
export function configSafetyError(container, name, codexSandbox = 'user-namespaces') {
  const config = container?.HostConfig;
  if (config?.Privileged !== false) return 'The factory container is privileged or its safety record is missing.';
  if (config.CapAdd?.length) return 'The factory container adds a capability.';
  if (config.Devices?.length) return 'The factory container maps a host device.';
  if ([config.PidMode, config.NetworkMode, config.IpcMode, config.UsernsMode].some((mode) => mode === 'host')) return 'The factory container shares a host namespace.';
  const security = config.SecurityOpt;
  if (security != null && !Array.isArray(security)) return 'The factory container has no approved Codex security profile.';
  const securityOptions = security || [];
  if (securityOptions.some((option) => /^apparmor[=:]unconfined$/.test(option))) return 'The factory container has no AppArmor profile.';
  // Docker translates systempaths=unconfined to these two empty lists.
  const effectiveSystempaths = Array.isArray(config.MaskedPaths) && config.MaskedPaths.length === 0 && Array.isArray(config.ReadonlyPaths) && config.ReadonlyPaths.length === 0;
  const systempaths = securityOptions.some((option) => /^systempaths[=:]unconfined$/.test(option)) || effectiveSystempaths;
  const customSeccomp = securityOptions.some((option) => /^seccomp[=:]/.test(option) && !/^seccomp[=:]unconfined$/.test(option));
  if (securityOptions.some((option) => /^seccomp[=:]unconfined$/.test(option))) return 'The factory container has no approved Codex security profile.';
  if (codexSandbox === 'user-namespaces' && (!systempaths || !customSeccomp)) return 'The factory container has no approved Codex security profile.';
  if (codexSandbox !== 'user-namespaces' && (systempaths || customSeccomp)) return 'The factory container has no approved Codex security profile.';
  if (!Array.isArray(container.Mounts) || container.Mounts.length !== 4) return 'The factory container must have four named volumes only.';
  for (const [kind, target] of Object.entries(VOLUMES)) {
    if (!container.Mounts.some((mount) => mount.Type === 'volume' && mount.Name === `hf-${name}-${kind}` && mount.Destination === target)) return 'The factory container has a host mount or an unexpected volume.';
  }
  return null;
}

export function assertOwned(resource, name) {
  const labels = resource?.Config?.Labels || resource?.Labels;
  if (labels?.[FACTORY_LABEL] !== name) throw new Error('The resource does not carry this factory label.');
}

export async function readHealth(docker, name, verifyHostname = false) {
  const raw = await dockerCall(docker, ['exec', `hf-${name}`, 'curl', '-fsS', '--retry', '15', '--retry-connrefused', '--retry-all-errors', '--retry-max-time', '30', ...(verifyHostname ? ['--header', `Host: ${name}.localhost`] : []), 'http://127.0.0.1:4477/api/health'], { timeout: 40_000 });
  let health;
  try { health = JSON.parse(raw); } catch { throw new Error('The service health route did not return a health record.'); }
  if (health.schema !== 1 || health.contractVersion !== '1.0.0' || !/^\d+\.\d+\.\d+$/.test(health.version) || !/^[a-f0-9]{12,64}$/.test(health.kitRevision)) throw new Error('The service health record is invalid.');
  return health;
}

async function readRunningCommit(docker, name) {
  const script = "fetch('http://127.0.0.1:4477/api/state').then(async r => { if (!r.ok) process.exitCode = 1; else { const s = await r.json(); process.stdout.write(JSON.stringify(s.version || {})); } }).catch(() => { process.exitCode = 1; });";
  try {
    const value = JSON.parse(await dockerCall(docker, ['exec', '--user', 'factory', `hf-${name}`, 'node', '-e', script], { timeout: 5000 }));
    return typeof value.commit === 'string' && /^[a-f0-9]{7,40}$/i.test(value.commit) ? value.commit.toLowerCase() : null;
  } catch { return null; }
}

async function readCheckoutHead(docker, name) {
  try {
    const value = (await dockerCall(docker, ['exec', '--user', 'factory', '-e', 'HOME=/home/factory', `hf-${name}`, 'git', '-C', '/home/factory/herdr-boss', 'rev-parse', '--short=7', 'HEAD'])).trim();
    return /^[a-f0-9]{7,40}$/i.test(value) ? value.slice(0, 7).toLowerCase() : null;
  } catch { return null; }
}

export function managedFactory(env, name) {
  assertName(name);
  const fleet = readFleet(env);
  const record = fleet.factories.find((item) => item.name === name && item.kind === 'container');
  if (!record) throw new Error('The container factory is not in the fleet registry.');
  const local = readPrivate(factoryFile(env, name));
  if (local.name !== name || local.hostId !== record.hostId) throw new Error('The factory records do not agree.');
  const fleetHost = fleet.hosts.find((item) => item.hostId === record.hostId);
  const connectionName = fleetHost.transport === 'local' ? 'local' : fleetHost.connectionRef || fleetHost.hostId;
  const registered = loadRegistry(env).hosts[connectionName] || {};
  const host = {
    ...hostFor(env, name, connectionName),
    runtime: registered.runtime ?? fleetHost.runtime,
    personalOnly: registered.personalOnly ?? fleetHost.personalOnly,
    codexSandbox: registered.codexSandbox ?? fleetHost.codexSandbox,
  };
  return { fleet, record, local, host };
}

async function reachableStatus(name, io) {
  const { fleet, record, local, host } = managedFactory(io.env, name);
  const docker = transportFor(host, io);
  const container = await inspect(docker, 'container', record.containerName);
  if (container) assertOwned(container, name);
  const state = container?.State?.Status || 'missing';
  let health = null;
  let workers = null;
  let bossPane = null;
  let disk = null;
  let commit = null;
  let checkoutHead = null;
  if (container?.State?.Running) {
    try { health = await readHealth(docker, name); } catch (error) { if (isHostUnreachable(error)) throw error; }
    commit = await readRunningCommit(docker, name);
    checkoutHead = await readCheckoutHead(docker, name);
    try {
      const script = 'const fs=require("fs");const s=JSON.parse(fs.readFileSync("/home/factory/.herdr-boss/state.json","utf8"));console.log(JSON.stringify({workers:s.control?.runningWorkers??null,bossPane:Boolean(s.control?.bossHandoff?.pane)}));';
      const result = JSON.parse(await dockerCall(docker, ['exec', '--user', 'factory', record.containerName, 'node', '-e', script]));
      if (Number.isInteger(result.workers) && result.workers >= 0) workers = result.workers;
      if (typeof result.bossPane === 'boolean') bossPane = result.bossPane;
    } catch (error) { if (isHostUnreachable(error)) throw error; }
    try {
      const lines = (await dockerCall(docker, ['exec', record.containerName, 'df', '-Pk', '/home/factory'])).trim().split('\n');
      const parts = lines.at(-1).trim().split(/\s+/);
      const values = parts.slice(1, 4).map(Number);
      if (values.length === 3 && values.every((value) => Number.isFinite(value) && value >= 0)) disk = { totalKiB: values[0], usedKiB: values[1], availableKiB: values[2] };
    } catch (error) { if (isHostUnreachable(error)) throw error; }
  }
  const image = await inspect(docker, 'image', local.imageTag);
  const labels = image?.Config?.Labels || {};
  let compatible = true;
  try { assertVersion(health?.version || record.version, effectiveMinimum(fleet)); } catch { compatible = false; }
  return { name, state, health: container?.State?.Health?.Status || null, schema: health?.schema ?? null, kitRevision: health?.kitRevision ?? null,
    commit, checkoutHead,
    version: health?.version ?? null, imageBuildDate: labels['org.opencontainers.image.created'] || null, pinsHash: labels['org.herdr-boss.pins-sha256'] || null,
    containerImageId: container?.Image || null, tagImageId: image?.Id || null, bossPane, workers, disk, minimumFactoryVersion: effectiveMinimum(fleet), compatible };
}

async function statusFactory(name, io) {
  try { return await reachableStatus(name, io); }
  catch (error) {
    if (!isHostUnreachable(error)) throw error;
    const { fleet } = managedFactory(io.env, name);
    return { name, state: 'host-unreachable', health: 'host-unreachable', schema: null, kitRevision: null, commit: null, checkoutHead: null, version: null, imageBuildDate: null, pinsHash: null,
      containerImageId: null, tagImageId: null, bossPane: null, workers: null, disk: null, minimumFactoryVersion: effectiveMinimum(fleet), compatible: null };
  }
}

async function lifecycle(action, args, io) {
  const { positional, flags } = parse(args, [], action === 'status' ? ['--json'] : action === 'stop' ? ['--now'] : []);
  if (positional.length !== 1) throw new Error('Give exactly one factory name.');
  const name = positional[0];
  if (action === 'status') {
    const status = await statusFactory(name, io);
    io.stdout.write(`${JSON.stringify(status, null, flags['--json'] ? 0 : 2)}\n`);
    if (status.compatible === false) io.stderr.write(`The factory is older than the minimum version ${status.minimumFactoryVersion}.\n`);
    return 0;
  }
  const { fleet, record, host } = managedFactory(io.env, name);
  const docker = transportFor(host, io);
  const container = await inspect(docker, 'container', record.containerName);
  if (!container) throw new Error('The factory container is missing.');
  assertOwned(container, name);
  if (!flags['--now']) assertVersion(record.version, effectiveMinimum(fleet));
  if (action === 'start') {
    await dockerCall(docker, ['start', record.containerName]);
    const health = await readHealth(docker, name);
    assertVersion(health.version, effectiveMinimum(fleet));
    record.version = health.version;
    record.kitRevision = health.kitRevision;
    updateFleet(io.env, (current) => {
      const factory = current.factories.find((item) => item.name === name);
      if (!factory) throw new Error('The factory registration is missing.');
      factory.version = health.version;
      factory.kitRevision = health.kitRevision;
    });
  } else {
    if (container.State?.Paused) await dockerCall(docker, ['unpause', record.containerName]);
    await dockerCall(docker, ['stop', '--time', flags['--now'] ? '0' : '30', record.containerName]);
  }
  io.stdout.write(`${action === 'start' ? 'Started' : 'Stopped'} factory ${name}.\n`);
  return 0;
}

function allocatePorts(fleet, hostId, flags) {
  const used = new Set(fleet.factories.filter((record) => record.hostId === hostId).flatMap((record) => record.ports ? Object.values(record.ports) : []));
  const next = (base) => { while (used.has(base)) base += 1; return base; };
  const dashboard = Number(flags['--dashboard-port'] ?? next(4478));
  used.add(dashboard);
  const ssh = Number(flags['--ssh-port'] ?? next(2222));
  for (const port of [dashboard, ssh]) if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('The factory port is invalid.');
  const existing = fleet.factories.filter((record) => record.hostId === hostId).flatMap((record) => record.ports ? Object.values(record.ports) : []);
  if (dashboard === ssh || existing.includes(dashboard) || existing.includes(ssh)) throw new Error('The factory ports collide.');
  return { dashboard, ssh };
}

export function imageBuildMeta(image) {
  const labels = image.Config?.Labels || {};
  const meta = { builtAt: labels['org.opencontainers.image.created'], pinsHash: labels['org.herdr-boss.pins-sha256'] };
  if (!Number.isFinite(Date.parse(meta.builtAt)) || !/^[a-f0-9]{64}$/.test(meta.pinsHash)) throw new Error('The image has no valid factory build metadata.');
  return meta;
}

async function newFactory(args, io) {
  const { positional, flags } = parse(args, ['--host', '--profile', '--image', '--dashboard-port', '--ssh-port']);
  if (positional.length !== 1) throw new Error('Give exactly one factory name.');
  const name = positional[0];
  assertName(name);
  const host = hostFor(io.env, name, flags['--host']);
  if ((flags['--profile'] || 'personal') !== 'personal') throw new Error(host.personalOnly ? 'This runtime permits personal factories only.' : 'Client factory creation is not available.');
  const fleet = readFleet(io.env);
  if (fleet.factories.some((record) => record.name === name)) throw new Error('The factory already exists. Use factory start or factory configure.');
  assertNoRejectedRowConflict(fleet, { name, factoryId: name, hostId: host.hostId });
  const file = factoryFile(io.env, name);
  const previous = readPrivate(file, null);
  const record = previous || { schema: 1, name, hostId: host.hostId, profile: 'personal', ports: allocatePorts(fleet, host.hostId, flags), imageTag: flags['--image'] || defaultFactoryImage(), stage: 'creating' };
  assertNoRejectedRowConflict(fleet, { name, factoryId: name, hostId: host.hostId, ports: record.ports });
  const spikeLabel = record.resourceOwner ? `herdr-factory-spike=${record.resourceOwner}` : SPIKE_LABEL;
  if (record.resourceOwner) assertName(record.resourceOwner);
  if (record.name !== name || record.hostId !== host.hostId || (flags['--image'] && flags['--image'] !== record.imageTag)) throw new Error('The pending factory has different creation settings.');
  if (typeof record.imageTag !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(record.imageTag)) throw new Error('The factory image tag is invalid.');
  const docker = transportFor(host, io);
  const existing = await inspect(docker, 'container', `hf-${name}`);
  if (existing) { assertOwned(existing, name); if (!previous) throw new Error('A container with this factory name already exists.'); }
  writePrivate(file, record);
  let image = await inspect(docker, 'image', record.imageTag);
  if (!image) {
    const { buildFactoryImage } = await import('./factory-build.js');
    await buildFactoryImage(name, record.imageTag, host, docker, io);
    image = await inspect(docker, 'image', record.imageTag);
    if (!image) throw new Error('The factory build produced no image.');
  }
  const imageMeta = imageBuildMeta(image);
  for (const kind of Object.keys(VOLUMES)) {
    const volumeName = `hf-${name}-${kind}`;
    const volume = await inspect(docker, 'volume', volumeName);
    if (volume) { assertOwned(volume, name); if (!previous) throw new Error('A volume with this factory name already exists.'); }
    else await dockerCall(docker, ['volume', 'create', '--label', `${FACTORY_LABEL}=${name}`, '--label', spikeLabel, volumeName]);
  }
  if (io.prepareFactoryVolumes) await io.prepareFactoryVolumes();
  if (!existing) {
    const create = ['container', 'create', '--name', `hf-${name}`, '--hostname', `${name}.localhost`, '--label', `${FACTORY_LABEL}=${name}`, '--label', spikeLabel,
      '--restart', 'unless-stopped', '--cpus', '4', '--memory', host.transport === 'local' ? '4g' : '8g', '--memory-swap', host.transport === 'local' ? '4g' : '8g', '--pids-limit', '512', '--shm-size', '1g',
      '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3', '-p', `127.0.0.1:${record.ports.dashboard}:4477`, '-p', `127.0.0.1:${record.ports.ssh}:22`];
    if (host.codexSandbox === 'user-namespaces') create.push('--security-opt', `seccomp=${path.join(FACTORY_ROOT, 'seccomp-codex.json')}`, '--security-opt', 'systempaths=unconfined');
    for (const [kind, target] of Object.entries(VOLUMES)) create.push('--mount', `type=volume,source=hf-${name}-${kind},target=${target}`);
    create.push(record.imageTag);
    await dockerCall(docker, create);
  }
  // Check the container settings before the first start and before each resumed start.
  const unsafe = configSafetyError(existing || await inspect(docker, 'container', `hf-${name}`), name, host.codexSandbox);
  if (unsafe) throw new Error(unsafe);
  await dockerCall(docker, ['start', `hf-${name}`]);
  const health = await readHealth(docker, name);
  assertVersion(health.version, effectiveMinimum(fleet));
  const hostRecord = { hostId: host.hostId, runtime: host.runtime, personalOnly: host.personalOnly, codexSandbox: host.codexSandbox, transport: host.transport === 'local' ? 'local' : 'ssh', ...(host.transport === 'local' ? {} : { connectionRef: host.hostId }) };
  updateFleet(io.env, (current) => {
    assertVersion(health.version, effectiveMinimum(current));
    if (current.factories.some((item) => item.name === name)) throw new Error('The factory is already registered.');
    const registeredHost = current.hosts.find((item) => item.hostId === host.hostId);
    if (registeredHost) Object.assign(registeredHost, hostRecord);
    else current.hosts.push(hostRecord);
    current.factories.push({ factoryId: name, name, hostId: host.hostId, profile: 'personal', dashboardUrl: `http://${name}.localhost:${record.ports.dashboard}`, version: health.version, kitRevision: health.kitRevision, kind: 'container', containerName: `hf-${name}`, hostname: `${name}.localhost`, ports: record.ports, image: imageMeta });
  });
  writePrivate(file, { ...record, stage: 'ready' });
  const { configureFactory } = await import('./factory-wizard.js');
  const configured = await configureFactory([name, '--step', 'service'], io);
  io.stdout.write(tailnetPolicyText(name, host.personalOnly));
  if (configured !== 0) return configured;
  io.stdout.write(`Created factory ${name}. Health /api/health: 200.\n`);
  return 0;
}

// Print the contract fields of a host only. An old inline record also holds an address and a Docker context.
const HOST_CONTRACT_FIELDS = ['hostId', 'runtime', 'personalOnly', 'codexSandbox', 'transport', 'connectionRef'];
const publicFleet = (fleet, env) => {
  const connections = loadRegistry(env).hosts;
  return {
    ...fleet,
    hosts: fleet.hosts.map((host) => {
      const connection = connections[host.connectionRef || host.hostId] || {};
      const current = { ...host, ...Object.fromEntries(['runtime', 'personalOnly', 'codexSandbox'].filter((key) => key in connection).map((key) => [key, connection[key]])) };
      return Object.fromEntries(HOST_CONTRACT_FIELDS.filter((key) => key in current).map((key) => [key, current[key]]));
    }),
  };
};

export async function factoryCoreCommand(args, io) {
  if ((io.isContainer || isInsideContainer)()) throw new Error('The factory host tool cannot run inside a container.');
  if (args[0] === 'new') return newFactory(args.slice(1), io);
  if (args[0] === 'configure') {
    const { configureFactory } = await import('./factory-wizard.js');
    return configureFactory(args.slice(1), io);
  }
  if (args[0] === 'build') {
    const { positional, flags } = parse(args.slice(1), ['--host', '--image']);
    if (positional.length !== 1) throw new Error('Give exactly one factory name.');
    const name = positional[0];
    assertName(name);
    const host = hostFor(io.env, name, flags['--host']);
    const imageTag = flags['--image'] || readPrivate(factoryFile(io.env, name), {}).imageTag || defaultFactoryImage();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(imageTag)) throw new Error('The factory image tag is invalid.');
    const docker = transportFor(host, io);
    // Refuse a tag that exists and was not built by this tool. A build would re-tag it.
    const present = await inspect(docker, 'image', imageTag);
    if (present) imageBuildMeta(present);
    const { buildFactoryImage } = await import('./factory-build.js');
    await buildFactoryImage(name, imageTag, host, docker, io);
    io.stdout.write(`Built factory image for ${name}.\n`);
    return 0;
  }
  if (['start', 'stop', 'status'].includes(args[0])) return lifecycle(args[0], args.slice(1), io);
  if (args[0] === 'list') {
    const { positional, flags } = parse(args.slice(1), [], ['--json']);
    if (positional.length) throw new Error('Factory list takes no argument.');
    const fleet = readFleet(io.env);
    io.stdout.write(flags['--json'] ? `${JSON.stringify(publicFleet(fleet, io.env))}\n` : `${fleet.factories.map((record) => `${record.name}  ${record.kind}  ${record.profile}  ${record.version}`).join('\n') || 'No factories.'}\n`);
    for (const diagnostic of fleet.diagnostics || []) io.stderr.write(`${diagnostic}\n`);
    return 0;
  }
  throw new Error('Unknown factory command.');
}

function tailnetPolicyText(name, personalOnly) {
  const tag = `tag:hf-${name}`;
  const grants = [
    { src: ['autogroup:member'], dst: [tag], ip: ['tcp:443'] },
    { src: ['tag:hf-head-office'], dst: [tag], ip: ['tcp:443'] },
    ...(!personalOnly ? [{ src: [tag], dst: ['tag:hf-head-office'], ip: ['tcp:443'] }] : []),
  ];
  const grantLine = (grant) => `{"src": ${JSON.stringify(grant.src)}, "dst": ${JSON.stringify(grant.dst)}, "ip": ${JSON.stringify(grant.ip)}}`;
  return [
    `Tag: ${tag}`,
    'Head office tag: tag:hf-head-office',
    'Host tag: tag:hf-host',
    '// Paste these lines into the tailnet policy file. Then approve the tag when the factory joins.',
    '// tag:hf-head-office and tag:hf-host need existing tagOwners entries in the policy.',
    '"tagOwners": {',
    `  "${tag}": ["autogroup:admin"]`,
    '},',
    '"grants": [',
    ...grants.map((grant, index) => `  ${grantLine(grant)}${index < grants.length - 1 ? ',' : ''}`),
    ']',
    `tailscale up --advertise-tags=${tag}`,
    '// Alternative: one shared tag with acls. Use this block instead of the grants above.',
    '// Merge these entries into the existing policy. Keep its other rules.',
    '"tagOwners": {',
    '  "tag:factory": ["autogroup:admin"]',
    '},',
    '"acls": [',
    '  {"action": "accept", "src": ["autogroup:member"], "dst": ["tag:factory:22,443,4477,4478"]}',
    '],',
    '"tests": [',
    '  {"src": "autogroup:member", "accept": ["tag:factory:22,443,4477,4478"]}',
    ']',
    'tailscale up --advertise-tags=tag:factory',
    '',
  ].join('\n');
}
