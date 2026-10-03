import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { acceptFleetSummary } from './fleet-contract.js';
import { validate } from './fleet-schema.js';
import { readFleetFile, writeFleetFile } from './fleet-store.js';
import { FLEET_READ_TOKEN } from './fleet-access.js';

export const FLEET_POLL_MS = 30000;
const MAX_SUMMARY_BYTES = 128 * 1024;
const schemaFile = fileURLToPath(new URL('../docs/contracts/schema/factory-registry.v1.schema.json', import.meta.url));
const registrySchema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
function factoryRecords(file) {
  const body = readFleetFile(file, { schema: 1, contractVersion: '1.0.0', factories: [] });
  if (body.schema !== 1 || body.contractVersion !== '1.0.0' || validate(body.factories, registrySchema.properties.factories, { schemaFile }).length) throw new Error('registry-invalid');
  if (new Set(body.factories.map((row) => row.name)).size !== body.factories.length) throw new Error('registry-invalid');
  // The poller needs no host connection record. Never read registry.json.
  return body.factories.map(({ factoryId, name, dashboardUrl }) => ({ factoryId, name, dashboardUrl: new URL(dashboardUrl).origin }));
}
async function fetchSummary(url, token, signal, fetchImpl) {
  const response = await fetchImpl(`${url}/api/fleet/summary`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, redirect: 'error', signal });
  if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json')) throw new Error('poll-failed');
  const reader = response.body.getReader();
  const chunks = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_SUMMARY_BYTES) throw new Error('summary-too-large');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

export function createFleetPoller({ dir, registryFile = path.join(process.env.HERDR_FACTORIES_DIR || path.join(process.env.HOME || os.homedir(), '.herdr-factories'), 'fleet.json'), localSummary, enabled = () => true, credentials = () => ({}), now = () => Date.now(), fetchImpl = fetch, schedule = setTimeout, cancel = clearTimeout, timeoutMs = 5000 } = {}) {
  const cacheFile = path.join(dir, 'fleet-cache.json');
  const dailyFile = path.join(dir, 'fleet-daily.json');
  const cache = new Map();
  let records = [], registryError = null, timer, pending, stopped = false;
  const controller = new AbortController();
  // Validate cached data before it reaches the dashboard. Never restore error bodies.
  try {
    records = factoryRecords(registryFile);
    const saved = readFleetFile(cacheFile, []);
    for (const record of records) {
      const row = Array.isArray(saved) && saved.find((item) => item.name === record.name);
      if (!row) continue;
      const { summary, drift } = acceptFleetSummary(row.summary, record.dashboardUrl);
      if (summary.factoryId === record.factoryId) cache.set(record.name, { ...record, summary, drift, status: 'offline', error: 'not-polled', remote: true });
    }
  } catch { registryError = 'registry-invalid'; }

  const snapshot = () => [...cache.values()].sort((a, b) => Number(!!a.remote) - Number(!!b.remote) || a.name.localeCompare(b.name)).map((row) => ({ ...row, ageSeconds: row.summary ? Math.max(0, Math.floor((now() - Date.parse(row.summary.generatedAt)) / 1000)) : null }));
  const save = () => {
    writeFleetFile(cacheFile, [...cache.values()].filter((row) => row.summary && row.remote).map(({ name, summary }) => ({ name, summary })));
    const day = new Date(now()).toISOString().slice(0, 10);
    const daily = readFleetFile(dailyFile, {});
    daily[day] = snapshot().filter((row) => row.summary).map((row) => ({ factoryId: row.summary.factoryId, projects: row.summary.projects.length, needsOwner: row.summary.ownerItems.needsOwner }));
    const days = Object.keys(daily).sort().slice(-30);
    writeFleetFile(dailyFile, Object.fromEntries(days.map((key) => [key, daily[key]])));
  };
  const run = async () => {
    let local, localFailed = false;
    try {
      local = await localSummary();
      acceptFleetSummary(local, local.dashboardUrl);
      for (const [name, row] of cache) if (!row.remote) cache.delete(name);
      cache.set(local.name, { name: local.name, factoryId: local.factoryId, dashboardUrl: local.dashboardUrl, summary: local, status: local.health.status, remote: false, error: null, drift: null });
      if (registryError === 'local-summary-unavailable') registryError = null;
    } catch { registryError = 'local-summary-unavailable'; localFailed = true; }
    // A failed local summary leaves the previous local row in the cache. Keep its identity as factory zero.
    const self = local || [...cache.values()].find((row) => !row.remote);
    let headOffice = false;
    try { headOffice = enabled(); } catch { registryError = 'fleet-settings-invalid'; }
    if (!headOffice) {
      for (const row of cache.values()) if (row.remote) { row.status = 'offline'; row.error = 'head-office-disabled'; }
      return;
    }
    try { records = factoryRecords(registryFile); registryError = localFailed ? 'local-summary-unavailable' : null; }
    catch { registryError = 'registry-invalid'; return; }
    if (self && records.some((record) => record.name === self.name && (record.factoryId !== self.factoryId || record.dashboardUrl !== new URL(self.dashboardUrl).origin))) {
      registryError = 'duplicate-factory-name'; return;
    }
    const kept = new Set(records.map((record) => record.name));
    for (const [name, row] of cache) if (row.remote && !kept.has(name)) cache.delete(name);
    const identities = new Map(self ? [[self.factoryId, self.name]] : []);
    // Keep each accepted remote identity reserved through an outage.
    for (const [name, row] of cache) if (row.remote && row.summary) identities.set(row.summary.factoryId, name);
    let tokens = {};
    try { tokens = credentials(); } catch { /* Missing private credentials give a public failure code. */ }
    for (const record of records) {
      if (stopped) break;
      if (self && record.factoryId === self.factoryId && new URL(record.dashboardUrl).origin === new URL(self.dashboardUrl).origin) continue;
      const old = cache.get(record.name);
      const previous = old?.remote && old.dashboardUrl === record.dashboardUrl ? old : null;
      const base = { ...record, ...(previous || {}), remote: true };
      try {
        if (identities.has(record.factoryId) && identities.get(record.factoryId) !== record.name) throw new Error('duplicate-factory-id');
        const token = tokens[record.factoryId];
        if (!FLEET_READ_TOKEN.test(token)) throw new Error('read-credential-missing');
        const body = await fetchSummary(record.dashboardUrl, token, AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]), fetchImpl);
        const { summary, drift } = acceptFleetSummary(body, record.dashboardUrl);
        if (identities.has(summary.factoryId) && identities.get(summary.factoryId) !== record.name) throw new Error('duplicate-factory-id');
        if (summary.factoryId !== record.factoryId) throw new Error('factory-id-mismatch');
        if (Date.parse(summary.generatedAt) > now() + 60000) throw new Error('summary-time-invalid');
        identities.set(summary.factoryId, record.name);
        cache.set(record.name, { ...record, summary, drift, remote: true, status: summary.health.status, error: null });
      } catch (error) {
        const allowed = ['duplicate-factory-id', 'factory-id-mismatch', 'read-credential-missing', 'summary-too-large', 'summary-time-invalid'];
        cache.set(record.name, { ...base, status: 'offline', error: allowed.includes(error.message) ? error.message : 'poll-failed' });
      }
    }
    if (!stopped) save();
  };
  const poll = () => {
    if (stopped) return Promise.resolve();
    if (!pending) pending = run().finally(() => { pending = null; });
    return pending;
  };
  const loop = async () => {
    const started = now();
    try { await poll(); } catch { registryError = 'cache-write-failed'; }
    if (!stopped) { timer = schedule(loop, Math.max(0, FLEET_POLL_MS - (now() - started))); timer?.unref?.(); }
  };
  return { poll, view: () => ({ pollSeconds: 30, registryError, factories: snapshot() }),
    start() { if (!stopped && !timer && !pending) void loop(); },
    async stop() { stopped = true; cancel(timer); controller.abort(); if (pending) await pending.catch(() => {}); },
  };
}
