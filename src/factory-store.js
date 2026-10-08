import fs from 'node:fs';
import path from 'node:path';
import { acquireLock, factoriesDir } from './factory-host.js';
import { factoryRowLabel, inspectFactoryRows } from './fleet-registry.js';
import { normalizeFleetBuiltAt } from './factory-timestamp.js';

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
const wholeSecondTimestamp = (value) => typeof value === 'string' && /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$/.test(value) && Number.isFinite(Date.parse(value));

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
      if (factory.containerName !== `hf-${factory.name}` || !fieldsOnly(factory.ports, ['dashboard', 'ssh']) || !fieldsOnly(factory.image, ['builtAt', 'pinsHash']) || !wholeSecondTimestamp(factory.image.builtAt) || !/^[a-f0-9]{64}$/.test(factory.image.pinsHash) || (factory.hostname !== undefined && factory.hostname !== `${factory.name}.localhost`)) throw new Error('The container factory record is invalid.');
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
  const fleet = readPrivate(path.join(factoriesDir(env), 'fleet.json'), {
    schema: 1, contractVersion: '1.0.0', minimumFactoryVersion: MINIMUM_FACTORY_VERSION, hosts: [], factories: [],
  });
  if (!fleet || typeof fleet !== 'object' || Array.isArray(fleet) || fleet.schema !== 1 || fleet.contractVersion !== '1.0.0' || !Array.isArray(fleet.factories)) throw new Error('The fleet registry is invalid.');
  const normalized = normalizeFleetBuiltAt(fleet);
  const base = validateFleet({ ...normalized, factories: [] });
  const { factories: schemaValidRows, diagnostics, rejectedRows: schemaRejectedRows, rejectedRowLabels: schemaRejectedLabels } = inspectFactoryRows(normalized.factories);
  const factories = [];
  const rejectedRows = [...schemaRejectedRows];
  const rejectedRowLabels = [...schemaRejectedLabels];
  const ids = new Set();
  const ports = new Set();
  const hostIds = new Set(base.hosts.map((host) => host.hostId));
  for (const row of schemaValidRows) {
    let reason = null;
    if (!hostIds.has(row.hostId)) reason = 'hostId must identify a registered host';
    else if (ids.has(row.factoryId)) reason = 'factoryId must be unique';
    else if (row.kind === 'container' && row.containerName !== `hf-${row.name}`) reason = 'containerName must match the factory name';
    else if (row.hostname !== undefined && row.hostname !== `${row.name}.localhost`) reason = 'hostname must match the factory name';
    else if (row.kind === 'container') {
      for (const field of ['dashboard', 'ssh']) {
        const port = row.ports[field];
        const key = `${row.hostId}:${port}`;
        if (!Number.isInteger(port) || port < 1 || port > 65535 || ports.has(key)) {
          reason = `ports.${field} must be a unique port from 1 to 65535`;
          break;
        }
      }
    }
    if (!reason) {
      try { validateFleet({ ...base, factories: [...factories, row] }); }
      catch { reason = 'factory record does not meet registry rules'; }
    }
    if (reason) {
      diagnostics.push(`registry row ${row.name}: ${reason}`);
      rejectedRows.push(row);
      rejectedRowLabels.push(factoryRowLabel(row, normalized.factories.indexOf(row)));
      continue;
    }
    factories.push(row);
    ids.add(row.factoryId);
    if (row.kind === 'container') for (const port of [row.ports.dashboard, row.ports.ssh]) ports.add(`${row.hostId}:${port}`);
  }
  const result = validateFleet({ ...base, factories });
  Object.defineProperty(result, 'diagnostics', { value: diagnostics, enumerable: false });
  Object.defineProperty(result, 'rejectedRows', { value: rejectedRows, enumerable: false });
  Object.defineProperty(result, 'rejectedRowLabels', { value: rejectedRowLabels, enumerable: false });
  return result;
}

export function writeFleet(env, fleet) {
  writePrivate(path.join(factoriesDir(env), 'fleet.json'), validateFleet(normalizeFleetBuiltAt(fleet)));
}

export function assertNoRejectedRowConflict(fleet, candidate, previous = null) {
  const rows = fleet.rejectedRows || [];
  const labels = fleet.rejectedRowLabels || [];
  const index = rows.findIndex((row) => {
    if (typeof candidate?.name === 'string' && candidate.name === row?.name && (!previous || previous.name !== candidate.name)) return true;
    if (typeof candidate?.factoryId === 'string' && candidate.factoryId === row?.factoryId && (!previous || previous.factoryId !== candidate.factoryId)) return true;
    if (candidate?.hostId !== row?.hostId) return false;
    const rejectedPorts = [row?.ports?.dashboard, row?.ports?.ssh].filter(Number.isInteger);
    return ['dashboard', 'ssh'].some((field) => {
      const port = candidate?.ports?.[field];
      const changed = !previous || previous.hostId !== candidate.hostId || previous.ports?.[field] !== port;
      return changed && Number.isInteger(port) && rejectedPorts.includes(port);
    });
  });
  if (index >= 0) {
    const sourceIndex = fleet.factories?.indexOf(rows[index]) ?? index;
    const label = labels[index] || factoryRowLabel(rows[index], sourceIndex >= 0 ? sourceIndex : index);
    throw new Error(`The change conflicts with registry row ${label}.`);
  }
}

// Keep the lock only for a synchronous read-modify-write. Never hold it during Docker work.
export function updateFleet(env, change) {
  const directory = factoriesDir(env);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const release = acquireLock(path.join(directory, 'fleet.lock'), 'The fleet registry is busy. Retry the command.');
  try {
    const fleet = readFleet(env);
    const rejectedRows = fleet.rejectedRows || [];
    const rejectedRowLabels = fleet.rejectedRowLabels || [];
    const originalRows = new Map(fleet.factories.map((row) => [row, { json: JSON.stringify(row), value: JSON.parse(JSON.stringify(row)) }]));
    change(fleet);
    for (const row of fleet.factories) {
      const original = originalRows.get(row);
      if (!original || original.json !== JSON.stringify(row)) assertNoRejectedRowConflict({ ...fleet, rejectedRows, rejectedRowLabels }, row, original?.value || null);
    }
    const validated = validateFleet(normalizeFleetBuiltAt(fleet));
    const output = rejectedRows.length ? { ...validated, factories: [...validated.factories, ...rejectedRows] } : validated;
    writePrivate(path.join(directory, 'fleet.json'), output);
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
