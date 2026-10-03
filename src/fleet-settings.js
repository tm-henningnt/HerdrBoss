import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFleetFile, writeFleetFile } from './fleet-store.js';
import { validateAccounts } from './fleet-quotas.js';
import { validate } from './fleet-schema.js';
import { SUMMARY_SCHEMA_FILE } from './fleet-contract.js';

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Check the dashboard URL against the same base-URL contract as the exchange.
export function validateDashboardUrl(value) {
  const schema = { $ref: 'common.v1.schema.json#/$defs/dashboardUrl' };
  if (validate(value, schema, { schemaFile: SUMMARY_SCHEMA_FILE }).length) throw new Error('The dashboard base URL is invalid.');
  const url = new URL(value);
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || value.length > 300) throw new Error('Give an HTTP dashboard base URL with no path, query, fragment, or login.');
  return url.origin;
}
export function validateFleetSettings(body) {
    if (!body || Object.keys(body).some((key) => !['name', 'dashboardUrl', 'headOffice', 'shareItemTitles'].includes(key))
      || typeof body.name !== 'string' || !SLUG.test(body.name) || typeof body.headOffice !== 'boolean' || typeof body.shareItemTitles !== 'boolean') throw new Error('The fleet settings are invalid.');
    return { ...body, dashboardUrl: validateDashboardUrl(body.dashboardUrl) };
}
export function createFleetSettings({ dir, cfg = {} }) {
  const file = path.join(dir, 'fleet-settings.json');
  const identityFile = path.join(dir, 'factory-identity.json');
  const accountsFile = path.join(dir, 'fleet-accounts.json');
  const defaults = { name: cfg.fleet?.name || 'factory-zero', dashboardUrl: cfg.fleet?.dashboardUrl || `http://localhost:${cfg.port || 4477}`, headOffice: cfg.fleet?.headOffice === true, shareItemTitles: cfg.fleet?.profile !== 'client' };
  // A bad identity file never throws here. The first read reports it.
  let identity = null, identityError = null;
  try {
    identity = readFleetFile(identityFile, null);
    if (!identity) {
      identity = { factoryId: `factory-${randomUUID()}` };
      writeFleetFile(identityFile, identity);
    }
    if (typeof identity.factoryId !== 'string' || !SLUG.test(identity.factoryId)) throw new Error('The factory identity is invalid.');
  } catch (error) { identityError = error; identity = null; }
  const read = () => {
    if (identityError) throw identityError;
    return { factoryId: identity.factoryId, ...validateFleetSettings({ ...defaults, ...readFleetFile(file, {}) }), accounts: validateAccounts(readFleetFile(accountsFile, [])) };
  };
  return { accountsFile, read,
    // Return the settings, or the defaults with an error text when a file or a setting is invalid.
    view: () => {
      try { return read(); }
      catch (error) { return { factoryId: identity?.factoryId ?? null, ...defaults, accounts: [], error: error.message }; }
    },
    write: (body) => { if (identityError) throw identityError; const { accounts, ...settings } = body || {}; const valid = validateFleetSettings(settings); if (accounts !== undefined) validateAccounts(accounts); writeFleetFile(file, valid); if (accounts !== undefined) writeFleetFile(accountsFile, accounts); },
  };
}
