import fs from 'node:fs';
import path from 'node:path';
import { acquireLock, factoriesDir } from './factory-host.js';

export const MINIMUM_FACTORY_VERSION = '0.1.0';
export const FACTORY_NAME = /^(?=.{1,31}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$(?![\s\S])/;
export const VOLUMES = Object.freeze({ home: '/home/factory', data: '/home/factory/.herdr-boss', work: '/home/factory/work', code: '/home/factory/herdr-boss' });

export function assertName(name) {
  if (typeof name !== 'string' || !FACTORY_NAME.test(name)) throw new Error('Use a factory name with lower case letters, digits, and hyphens.');
}

export function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

export function readPrivate(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw new Error('The factory record cannot be read.');
  }
}

export function factoryFile(env, name, file = 'factory.json') {
  assertName(name);
  return path.join(factoriesDir(env), name, file);
}

export function attachState(env, name) {
  try { return readPrivate(factoryFile(env, name, 'attach.json'), null)?.state === 'attached' ? 'attached' : 'not-attached'; } catch { return 'not-attached'; }
}

const fieldsOnly = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => fields.includes(key));
const validName = (value) => typeof value === 'string' && value.length <= 64 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$(?![\s\S])/.test(value);
const validAddress = (value) => typeof value === 'string' && value.length <= 253 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(value);

export function validateFleet(fleet) {
  if (!fieldsOnly(fleet, ['schema', 'contractVersion', 'minimumFactoryVersion', 'hosts', 'factories']) || fleet.schema !== 1 || fleet.contractVersion !== '1.0.0' || !/^\d+\.\d+\.\d+$/.test(fleet.minimumFactoryVersion) || !Array.isArray(fleet.hosts) || !Array.isArray(fleet.factories)) throw new Error('The fleet registry is invalid.');
  const hostIds = new Set();
  for (const host of fleet.hosts) {
    const base = ['hostId', 'runtime', 'personalOnly', 'codexSandbox', 'transport'];
    const local = host?.transport === 'local' && fieldsOnly(host, base);
    const reference = host?.transport === 'ssh' && fieldsOnly(host, [...base, 'connectionRef']) && validName(host.connectionRef);
    const inline = host?.transport === 'ssh' && fieldsOnly(host, [...base, 'address', 'dockerContext']) && validAddress(host.address) && validName(host.dockerContext);
    if (!(local || reference || inline) || !validName(host.hostId) || hostIds.has(host.hostId) || !['orbstack', 'colima', 'docker-engine', 'docker-engine-wsl2'].includes(host.runtime) || typeof host.personalOnly !== 'boolean' || !['user-namespaces', 'unconfined', 'unavailable'].includes(host.codexSandbox)) throw new Error('The fleet host record is invalid.');
    hostIds.add(host.hostId);
  }
  const names = new Set();
  const ids = new Set();
  const ports = new Set();
  for (const factory of fleet.factories) {
    if (!fieldsOnly(factory, ['factoryId', 'name', 'hostId', 'profile', 'dashboardUrl', 'version', 'kitRevision', 'kind', 'containerName', 'hostname', 'ports', 'image']) || !validName(factory.name) || !validName(factory.factoryId) || names.has(factory.name) || ids.has(factory.factoryId) || !hostIds.has(factory.hostId) || !['personal', 'client'].includes(factory.profile) || !/^\d+\.\d+\.\d+$/.test(factory.version) || !/^[a-f0-9]{12,64}$/.test(factory.kitRevision)) throw new Error('The fleet factory record is invalid.');
    let url;
    try { url = new URL(factory.dashboardUrl); } catch { throw new Error('The dashboard URL is invalid.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('The dashboard URL is invalid.');
    if (factory.kind === 'container') {
      if (factory.containerName !== `hf-${factory.name}` || !fieldsOnly(factory.ports, ['dashboard', 'ssh']) || !fieldsOnly(factory.image, ['builtAt', 'pinsHash']) || !Number.isFinite(Date.parse(factory.image.builtAt)) || !/^[a-f0-9]{64}$/.test(factory.image.pinsHash) || (factory.hostname !== undefined && factory.hostname !== `${factory.name}.localhost`)) throw new Error('The container factory record is invalid.');
      for (const port of [factory.ports.dashboard, factory.ports.ssh]) {
        const key = `${factory.hostId}:${port}`;
        if (!Number.isInteger(port) || port < 1 || port > 65535 || ports.has(key)) throw new Error('The factory ports collide or are invalid.');
        ports.add(key);
      }
    } else if (factory.kind !== 'native') throw new Error('The factory kind is invalid.');
    names.add(factory.name);
    ids.add(factory.factoryId);
  }
  return fleet;
}

export function readFleet(env) {
  return validateFleet(readPrivate(path.join(factoriesDir(env), 'fleet.json'), {
    schema: 1, contractVersion: '1.0.0', minimumFactoryVersion: MINIMUM_FACTORY_VERSION, hosts: [], factories: [],
  }));
}

export function writeFleet(env, fleet) {
  writePrivate(path.join(factoriesDir(env), 'fleet.json'), validateFleet(fleet));
}

// Keep the lock only for a synchronous read-modify-write. Never hold it during Docker work.
export function updateFleet(env, change) {
  const directory = factoriesDir(env);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const release = acquireLock(path.join(directory, 'fleet.lock'), 'The fleet registry is busy. Retry the command.');
  try {
    const fleet = readFleet(env);
    change(fleet);
    writeFleet(env, fleet);
    return fleet;
  } finally { release(); }
}

// The release constant is the floor. A lower fleet value cannot reduce it.
export function effectiveMinimum(fleet) {
  const fleetMinimum = fleet?.minimumFactoryVersion;
  if (!/^\d+\.\d+\.\d+$/.test(fleetMinimum)) return MINIMUM_FACTORY_VERSION;
  const a = fleetMinimum.split('.').map(Number);
  const b = MINIMUM_FACTORY_VERSION.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] > b[index] ? fleetMinimum : MINIMUM_FACTORY_VERSION;
  return fleetMinimum;
}

export function assertVersion(version, minimum = MINIMUM_FACTORY_VERSION) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^\d+\.\d+\.\d+$/.test(minimum)) throw new Error('The factory version is unknown.');
  const actual = version.split('.').map(Number);
  const required = minimum.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] > required[index]) return;
    if (actual[index] < required[index]) throw new Error(`The factory is older than the minimum version ${minimum}. Update the factory first.`);
  }
}
