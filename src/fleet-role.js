import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { validateFile } from './fleet-schema.js';
import { readFleetFile, writeFleetFile } from './fleet-store.js';
import { FLEET_GUIDE_TOKEN } from './fleet-access.js';
import { factoryRecords, fleetPollError } from './fleet-poller.js';
import { validateFleet } from './factory-store.js';

const ROLE_SCHEMA_FILE = fileURLToPath(new URL('../docs/contracts/schema/head-office-role.v1.schema.json', import.meta.url));
const MAX_BODY_BYTES = 256 * 1024;
const PEER_CODES = ['unreachable', 'timeout', 'auth', 'contract-mismatch', 'no-credential', 'unsafe-transport', 'refused'];
const EMPTY_REGISTRY = { schema: 1, contractVersion: '1.0.0', minimumFactoryVersion: '0.1.0', hosts: [], factories: [] };
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
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
    return { factoryId: local.factoryId, headOfficeFactoryId: holder, epoch: Math.max(1, stored.epoch), updatedAt: stored.updatedAt, holds: holder === local.factoryId };
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
  const writeNote = (epoch, pending) => { if (pending.length) writeFleetFile(noteFile, { epoch, pending }); else fs.rmSync(noteFile, { force: true }); };

  // Merge the registry of the old holder into the own registry. The own record wins. Check every part before a write.
  function applyHandover(body, local) {
    if (!body || body.schema !== 1 || (body.registry !== null && !(body.registry && Array.isArray(body.registry.hosts) && Array.isArray(body.registry.factories))) || !validShares(body.shares ?? null)) throw new Error('handover-invalid');
    let merged = null;
    if (body.registry) {
      const mine = readFleetFile(registryFile, EMPTY_REGISTRY);
      const hostIds = new Set(mine.hosts.map((host) => host.hostId)), ids = new Set(mine.factories.map((factory) => factory.factoryId));
      merged = { ...mine, hosts: [...mine.hosts, ...body.registry.hosts.filter((host) => !hostIds.has(host.hostId))],
        factories: [...mine.factories, ...body.registry.factories.filter((factory) => !ids.has(factory.factoryId) && factory.factoryId !== local.factoryId)] };
      validateFleet(merged);
    }
    if (merged) writeFleetFile(registryFile, merged);
    if (body.shares) writeFleetFile(sharesFile, body.shares);
  }

  const api = {
    view,
    holds: () => view().holds,
    // Accept a role record from a registered factory.
    accept(body) {
      if (!body || validateFile(body, ROLE_SCHEMA_FILE).length || body.contractVersion !== '1.0.0') throw roleError('The role record is invalid.');
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
      return { schema: 1, contractVersion: '1.0.0', epoch: current.epoch, registry: readFleetFile(registryFile, null), shares: readFleetFile(sharesFile, null) };
    },
    async promote({ force = false } = {}) {
      const local = settings();
      const current = view();
      if (current.holds) return { status: 'already-holder', epoch: current.epoch };
      let records;
      try { records = factoryRecords(registryFile).filter((record) => record.factoryId !== local.factoryId); }
      catch { throw new Error('The factory registry cannot be read. Repair it and run the command again.'); }
      const probes = await Promise.all(records.map(async (record) => {
        try {
          const reported = await peer(record, 'GET', '/api/fleet/role');
          if (!Number.isInteger(reported?.epoch) || (reported.headOfficeFactoryId !== null && !SLUG.test(reported?.headOfficeFactoryId))) throw peerError('contract-mismatch');
          return { record, reported };
        } catch (error) { return { record, error: code(error) }; }
      }));
      const down = probes.filter((probe) => probe.error);
      if (down.length && !force) {
        throw new Error(`Refused: ${down.length} registered factories cannot be reached: ${down.map((probe) => `${probe.record.name} (${probe.error})`).join(', ')}. Make them reachable and run the command again, or add --force to continue without them.`);
      }
      const reports = probes.filter((probe) => !probe.error).map((probe) => probe.reported);
      const epoch = Math.max(current.epoch, ...reports.map((report) => report.epoch)) + 1;
      // The old holder is the holder at the highest epoch that any reachable factory reports.
      const highest = reports.reduce((best, report) => report.headOfficeFactoryId && (report.epoch > best.epoch || (report.epoch === best.epoch && !best.headOfficeFactoryId)) ? report : best,
        { epoch: current.epoch, headOfficeFactoryId: current.headOfficeFactoryId });
      let handover = 'none';
      const from = probes.find((probe) => !probe.error && probe.record.factoryId === highest.headOfficeFactoryId);
      if (highest.headOfficeFactoryId && highest.headOfficeFactoryId !== local.factoryId) {
        handover = 'kept-own-copy';
        if (from) { try { applyHandover(await peer(from.record, 'GET', '/api/fleet/handover'), local); handover = 'received'; } catch { /* Keep the own copy. */ } }
      }
      const record = { schema: 1, contractVersion: '1.0.0', headOfficeFactoryId: local.factoryId, epoch, updatedAt: timestamp() };
      writeFleetFile(roleFile, record);
      if (!local.headOffice) enableHeadOffice();
      const told = [], pending = down.map((probe) => ({ factoryId: probe.record.factoryId, name: probe.record.name, error: probe.error }));
      for (const probe of probes.filter((item) => !item.error)) {
        try { await peer(probe.record, 'POST', '/api/fleet/role', record); told.push(probe.record.name); }
        catch (error) { pending.push({ factoryId: probe.record.factoryId, name: probe.record.name, error: code(error) }); }
      }
      writeNote(epoch, pending.map((row) => row.factoryId));
      return { status: 'promoted', epoch, told, pending, handover };
    },
    // Tell a factory that missed the promotion after its next good poll. A refusal ends the retry.
    async retry(record) {
      const note = readFleetFile(noteFile, null);
      if (!note?.pending?.includes(record.factoryId)) return;
      const current = view();
      const left = note.pending.filter((id) => id !== record.factoryId);
      if (!current.holds || current.epoch !== note.epoch) { writeNote(note.epoch, []); return; }
      try { await peer(record, 'POST', '/api/fleet/role', readFleetFile(roleFile, null)); writeNote(note.epoch, left); }
      catch (error) { if (error.code === 'refused') writeNote(note.epoch, left); }
    },
  };
  return api;
}
