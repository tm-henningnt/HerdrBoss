import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { validateFile } from './fleet-schema.js';
import { readFleetFile, writeFleetFile } from './fleet-store.js';
import { FLEET_GUIDE_TOKEN } from './fleet-access.js';
import { factoryRecords, fleetPollError } from './fleet-poller.js';
import { validateFleet } from './factory-store.js';
import { acquireLock } from './factory-host.js';

const ROLE_SCHEMA_FILE = fileURLToPath(new URL('../docs/contracts/schema/head-office-role.v1.schema.json', import.meta.url));
const MAX_BODY_BYTES = 256 * 1024;
const MAX_EPOCH = Number.MAX_SAFE_INTEGER;
const EPOCH_WINDOW = 1000;
const MAX_ATTEMPTS = 20;
const MAX_PENDING_MS = 24 * 60 * 60 * 1000;
const PEER_CODES = ['unreachable', 'timeout', 'auth', 'contract-mismatch', 'no-credential', 'unsafe-transport', 'refused'];
const EMPTY_REGISTRY = { schema: 1, contractVersion: '1.0.0', minimumFactoryVersion: '0.1.0', hosts: [], factories: [] };
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FACTORY_FIELDS = ['factoryId', 'name', 'hostId', 'profile', 'dashboardUrl', 'version', 'kitRevision'];
const handoverError = (reason) => Object.assign(new Error(reason), { reason });
const roleError = (message, status = 400) => Object.assign(new Error(message), { status });
const peerError = (code) => Object.assign(new Error(code), { code });
export const defaultRegistryFile = () => path.join(process.env.HERDR_FACTORIES_DIR || path.join(process.env.HOME || os.homedir(), '.herdr-factories'), 'fleet.json');

function validShares(value) {
  return value === null || (value && Array.isArray(value.accounts) && value.accounts.every((account) => /^[a-f0-9]{64}$/.test(account?.accountKey)
    && Array.isArray(account.shares) && account.shares.every((row) => SLUG.test(row?.factoryId) && Number.isInteger(row.share) && row.share >= 0 && row.share <= 100)));
}

// Return the stored head office holder and epoch. The guidance record and the role record are one term record: the higher epoch wins.
export function storedRole(dir) {
  const guidance = readFleetFile(path.join(dir, 'fleet-guidance.json'), { senderEpoch: 0, headOfficeFactoryId: null });
  const stored = readFleetFile(path.join(dir, 'head-office-role.json'), null);
  const recorded = stored && !validateFile(stored, ROLE_SCHEMA_FILE).length ? stored : null;
  const guidanceEpoch = guidance.senderEpoch || 0;
  return { epoch: Math.max(guidanceEpoch, recorded?.epoch || 0),
    headOfficeFactoryId: recorded && recorded.epoch >= guidanceEpoch ? recorded.headOfficeFactoryId : guidance.headOfficeFactoryId ?? null,
    updatedAt: recorded?.updatedAt ?? null };
}

export function createFleetRole({ dir, privateDir, settings, enableHeadOffice = () => {}, registryFile = defaultRegistryFile(), fetchImpl = fetch, now = Date.now }) {
  const roleFile = path.join(dir, 'head-office-role.json');
  const noteFile = path.join(dir, 'head-office-handover.json');
  const sharesFile = path.join(dir, 'fleet-shares.json');
  const timestamp = () => new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  // A factory with head office polling on and no stored term is the first holder at epoch 1.
  const view = () => {
    const local = settings();
    const stored = storedRole(dir);
    const implicit = !stored.headOfficeFactoryId && local.headOffice;
    const holder = implicit ? local.factoryId : stored.headOfficeFactoryId;
    const epoch = Math.max(1, stored.epoch);
    const note = readNote();
    const neverTold = note?.epoch === epoch ? [...note.neverTold, ...note.pending.filter((entry) => abandoned(entry, note)).map((entry) => entry.factoryId)] : [];
    return { factoryId: local.factoryId, headOfficeFactoryId: holder, epoch, updatedAt: stored.updatedAt, holds: holder === local.factoryId, neverTold };
  };

  async function peer(record, method, route, body) {
    const target = new URL(record.dashboardUrl);
    const loopback = target.hostname === 'localhost' || target.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(target.hostname);
    if (target.protocol !== 'https:' && !(target.protocol === 'http:' && loopback)) throw peerError('unsafe-transport');
    const token = readFleetFile(path.join(privateDir, 'fleet-guide-remotes.json'), {})[record.factoryId];
    if (!FLEET_GUIDE_TOKEN.test(token)) throw peerError('no-credential');
    let response;
    try {
      response = await fetchImpl(`${target.origin}${route}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(5000) });
    } catch (error) { throw peerError(fleetPollError(error)); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw peerError([401, 403].includes(response.status) ? 'auth' : response.status === 409 ? 'refused' : 'unreachable');
    }
    const reader = response.body?.getReader();
    if (!reader || !response.headers.get('content-type')?.startsWith('application/json')) throw peerError('contract-mismatch');
    const chunks = []; let bytes = 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > MAX_BODY_BYTES) throw new Error('too-large'); chunks.push(Buffer.from(value)); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw peerError('contract-mismatch'); }
    finally { await reader.cancel().catch(() => {}); }
  }
  const code = (error) => PEER_CODES.includes(error?.code) ? error.code : fleetPollError(error);
  const readNote = () => readFleetFile(noteFile, null);
  const writeNote = (note) => { if (note.pending.length || note.neverTold.length) writeFleetFile(noteFile, note); else fs.rmSync(noteFile, { force: true }); };
  const abandoned = (entry, note) => entry.attempts >= MAX_ATTEMPTS || now() - Date.parse(note.since) >= MAX_PENDING_MS;

  // Add the factories of the old holder to the own registry. The own record and the own hosts win. A factory on a host that this registry lacks stays out.
  // Check every part before a write. Write the shares first and the registry second. The role record is written last by the caller.
  function applyHandover(body, local) {
    const factories = body?.factories ?? null;
    if (!body || body.schema !== 1 || (factories !== null && !(Array.isArray(factories) && factories.every((row) => row && typeof row === 'object'))) || !validShares(body.shares ?? null)) throw handoverError('invalid-body');
    let merged = null, missingHosts = [];
    if (factories) {
      const mine = readFleetFile(registryFile, EMPTY_REGISTRY);
      const hostIds = new Set(mine.hosts.map((host) => host.hostId)), ids = new Set(mine.factories.map((factory) => factory.factoryId));
      const incoming = factories.filter((factory) => !ids.has(factory.factoryId) && factory.factoryId !== local.factoryId);
      missingHosts = [...new Set(incoming.filter((factory) => !hostIds.has(factory.hostId)).map((factory) => factory.hostId))];
      const added = incoming.filter((factory) => hostIds.has(factory.hostId)).map((factory) => ({ ...Object.fromEntries(FACTORY_FIELDS.map((key) => [key, factory[key]])), kind: 'native' }));
      merged = { ...mine, factories: [...mine.factories, ...added] };
      try { validateFleet(merged); } catch { throw handoverError('registry-rejected'); }
      if (!added.length) merged = null;
    }
    if (body.shares) writeFleetFile(sharesFile, body.shares);
    if (merged) writeFleetFile(registryFile, merged);
    return { missingHosts };
  }

  async function promoteLocked(force) {
    const local = settings();
    const current = view();
    if (current.holds) return { status: 'already-holder', epoch: current.epoch };
    let records;
    try { records = factoryRecords(registryFile).filter((record) => record.factoryId !== local.factoryId); }
    catch { throw new Error('The factory registry cannot be read. Repair it and run the command again.'); }
    const probe = async (record) => {
      try {
        const reported = await peer(record, 'GET', '/api/fleet/role');
        if (!Number.isInteger(reported?.epoch) || reported.epoch < 1 || (reported.headOfficeFactoryId !== null && !SLUG.test(reported?.headOfficeFactoryId))) throw peerError('contract-mismatch');
        return { record, reported };
      } catch (error) { return { record, error: code(error) }; }
    };
    const probes = await Promise.all(records.map(probe));
    const down = probes.filter((item) => item.error);
    if (down.length && !force) {
      throw new Error(`Refused: ${down.length} registered factories cannot be reached: ${down.map((item) => `${item.record.name} (${item.error})`).join(', ')}. Make them reachable and run the command again, or add --force to continue without them.`);
    }
    const reachable = probes.filter((item) => !item.error);
    // An inflated epoch is a fault or an attack. Compare each report with the local epoch and with the median of the other reports.
    for (const item of reachable) {
      const others = reachable.filter((other) => other !== item).map((other) => other.reported.epoch).sort((a, b) => a - b);
      const median = others.length ? others[Math.floor((others.length - 1) / 2)] : null;
      if (item.reported.epoch - current.epoch > EPOCH_WINDOW || (median !== null && item.reported.epoch - median > EPOCH_WINDOW)) {
        throw new Error(`Refused: ${item.record.name} reports an epoch more than ${EPOCH_WINDOW} above the other epochs. Check that factory. Nothing changed.`);
      }
    }
    const reports = reachable.map((item) => item.reported);
    const epoch = Math.max(current.epoch, ...reports.map((report) => report.epoch)) + 1;
    if (epoch > MAX_EPOCH) throw new Error(`Refused: the next epoch is above the largest allowed epoch ${MAX_EPOCH}. Nothing changed.`);
    // The old holder is the holder at the highest epoch that any reachable factory reports.
    const highest = reports.reduce((best, report) => report.headOfficeFactoryId && (report.epoch > best.epoch || (report.epoch === best.epoch && !best.headOfficeFactoryId)) ? report : best,
      { epoch: current.epoch, headOfficeFactoryId: current.headOfficeFactoryId });
    let handover = 'none', handoverReason = null, missingHosts = [];
    const from = reachable.find((item) => item.record.factoryId === highest.headOfficeFactoryId);
    if (highest.headOfficeFactoryId && highest.headOfficeFactoryId !== local.factoryId) {
      handover = 'kept-own-copy';
      if (!from) handoverReason = 'unreachable';
      else {
        try { ({ missingHosts } = applyHandover(await peer(from.record, 'GET', '/api/fleet/handover'), local)); handover = 'received'; }
        catch (error) { handoverReason = error.reason || code(error); }
      }
    }
    const before = readFleetFile(roleFile, null);
    const record = { schema: 1, contractVersion: '1.0.0', headOfficeFactoryId: local.factoryId, epoch, updatedAt: timestamp() };
    writeFleetFile(roleFile, record);
    const told = [], refused = [], pending = down.map((item) => ({ factoryId: item.record.factoryId, name: item.record.name, error: item.error }));
    for (const item of reachable) {
      try { await peer(item.record, 'POST', '/api/fleet/role', record); told.push(item.record.name); }
      catch (error) {
        if (error.code === 'refused') refused.push(item.record.name);
        else pending.push({ factoryId: item.record.factoryId, name: item.record.name, error: code(error) });
      }
    }
    if (refused.length) {
      // Another holder exists at this epoch. Give the role back, look again, and refuse.
      if (before) writeFleetFile(roleFile, before); else fs.rmSync(roleFile, { force: true });
      const seen = [];
      for (const item of reachable) { const again = await probe(item.record); if (!again.error) seen.push(`${item.record.name} reports ${again.reported.headOfficeFactoryId ?? 'no holder'} at epoch ${again.reported.epoch}`); }
      throw new Error(`Refused: ${refused.join(', ')} answered that another head office holder exists at epoch ${epoch}. This factory does not hold the role. ${seen.join('; ')}${seen.length ? '. ' : ''}Run the command again to take a higher epoch.`);
    }
    if (!local.headOffice) enableHeadOffice();
    writeNote({ epoch, since: timestamp(), pending: pending.map((row) => ({ factoryId: row.factoryId, attempts: 1 })), neverTold: [] });
    return { status: 'promoted', epoch, told, pending, handover, handoverReason, missingHosts };
  }

  const api = {
    view,
    holds: () => view().holds,
    // Accept a role record from a registered factory.
    accept(body) {
      if (!body || validateFile(body, ROLE_SCHEMA_FILE).length || body.contractVersion !== '1.0.0') throw roleError('The role record is invalid.');
      let registered = false;
      try { registered = factoryRecords(registryFile).some((record) => record.factoryId === body.headOfficeFactoryId); } catch { /* An unreadable registry registers nobody. */ }
      if (!registered && body.headOfficeFactoryId !== settings().factoryId) throw roleError('The head office holder is not a registered factory.', 409);
      const current = view();
      const known = current.headOfficeFactoryId !== null;
      if (body.epoch - current.epoch > 1000) throw roleError('The role epoch is more than 1000 above the stored epoch.', 409);
      if (known && body.epoch === current.epoch) {
        if (body.headOfficeFactoryId !== current.headOfficeFactoryId) throw roleError('The role epoch has another holder.', 409);
        return { ok: true, changed: false, epoch: current.epoch, headOfficeFactoryId: current.headOfficeFactoryId };
      }
      if (body.epoch < current.epoch) throw roleError('The role epoch is stale.', 409);
      writeFleetFile(roleFile, { schema: 1, contractVersion: '1.0.0', headOfficeFactoryId: body.headOfficeFactoryId, epoch: body.epoch, updatedAt: body.updatedAt });
      return { ok: true, changed: true, epoch: body.epoch, headOfficeFactoryId: body.headOfficeFactoryId };
    },
    // Give the registry and the factory shares to the new holder. Only the holder answers.
    handover() {
      const current = view();
      if (!current.holds) throw roleError('This factory does not hold the head office role.', 409);
      // Send factory identities only. Host addresses, Docker contexts, connection references, ports, and container names stay on this factory.
      const registry = readFleetFile(registryFile, null);
      const factories = Array.isArray(registry?.factories) ? registry.factories.map((factory) => Object.fromEntries(FACTORY_FIELDS.map((key) => [key, factory[key]]))) : null;
      return { schema: 1, contractVersion: '1.0.0', epoch: current.epoch, factories, shares: readFleetFile(sharesFile, null) };
    },
    async promote({ force = false } = {}) {
      const release = acquireLock(path.join(dir, 'head-office-promote.lock'), 'Another promotion is running on this factory. Wait for it to end and run the command again.');
      try { return await promoteLocked(force); } finally { release(); }
    },
    // Tell a factory that missed the promotion after its next good poll. Stop after 20 attempts or 24 hours.
    async retry(record) {
      const note = readNote();
      const entry = note?.pending.find((row) => row.factoryId === record.factoryId);
      if (!entry) return;
      const current = view();
      if (!current.holds || current.epoch !== note.epoch) { fs.rmSync(noteFile, { force: true }); return; }
      try { await peer(record, 'POST', '/api/fleet/role', readFleetFile(roleFile, null)); note.pending = note.pending.filter((row) => row !== entry); }
      catch (error) {
        if (error.code === 'refused') note.pending = note.pending.filter((row) => row !== entry);
        else {
          entry.attempts += 1;
          if (abandoned(entry, note)) { note.pending = note.pending.filter((row) => row !== entry); note.neverTold.push(entry.factoryId); }
        }
      }
      writeNote(note);
    },
  };
  return api;
}
