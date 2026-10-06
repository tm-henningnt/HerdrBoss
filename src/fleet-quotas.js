// Provision an account digest once. The identity and HMAC key never enter a stored record.
import { createHmac } from 'node:crypto';
import { readFleetFile, writeFleetFile } from './fleet-store.js';

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HARNESS = /^[a-z][a-z0-9-]{0,31}$/;
export function validateAccounts(accounts) {
  if (!Array.isArray(accounts) || accounts.length > 100) throw new Error('accounts must be a list of at most 100 accounts.');
  const seen = new Set();
  for (const account of accounts) {
    if (!account || Object.keys(account).some((key) => !['harness', 'accountKey', 'scope'].includes(key))
      || typeof account.harness !== 'string' || !HARNESS.test(account.harness) || !/^[a-f0-9]{64}$/.test(account.accountKey)
      || !Array.isArray(account.scope) || !account.scope.length || account.scope.some((id) => typeof id !== 'string' || !SLUG.test(id))
      || new Set(account.scope).size !== account.scope.length || seen.has(account.harness)) throw new Error('An account record is invalid or repeated.');
    seen.add(account.harness);
  }
  return structuredClone(accounts);
}

export function provisionAccount(body, { file }) {
  if (!body || Object.keys(body).some((key) => !['harness', 'identity', 'hmacKey', 'scope'].includes(key))
    || typeof body.identity !== 'string' || !body.identity || body.identity.length > 500
    || typeof body.hmacKey !== 'string' || Buffer.byteLength(body.hmacKey) < 32) throw new Error('Give an account identity and an HMAC key of at least 32 bytes through private input.');
  const accountKey = createHmac('sha256', body.hmacKey).update(`${body.harness}\0${body.identity}`).digest('hex');
  const record = { harness: body.harness, accountKey, scope: body.scope };
  validateAccounts([record]);
  const accounts = validateAccounts(readFleetFile(file, []));
  writeFleetFile(file, [...accounts.filter((row) => row.harness !== record.harness), record]);
  return record;
}

const percent = (value) => Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const amount = (value) => Number.isFinite(value) && value >= 0 ? value : null;
// The local usage estimate of a harness without a usage source. It has no percent. Keep only the closed fields.
function fleetEstimate(value) {
  if (!value || typeof value !== 'object') return null;
  const days = count(value.days), tokens = count(value.tokens), costUsd = amount(value.costUsd), omittedModels = count(value.omittedModels);
  return days && tokens !== null && costUsd !== null ? { days, tokens, costUsd, omittedModels: omittedModels ?? 0 } : null;
}
export function fleetQuotas(readings, accounts, factoryId) {
  return validateAccounts(accounts).filter((account) => account.scope.includes(factoryId)).flatMap((account) => {
    const provider = account.harness === 'opencode' ? 'opencodego' : account.harness;
    const reading = (readings || []).find((row) => row.provider === provider);
    // A reading without windows has no percent. The manual reset time and the local estimate of OpenCode Go ride on that row.
    const windows = reading?.windows?.length ? reading.windows : [{ key: 'unknown', resetsAt: reading?.resetAt }];
    const estimate = reading?.windows?.length ? null : fleetEstimate(reading?.estimate);
    return windows.map((window) => {
      const usedPercent = percent(window.usedPercent);
      return { harness: account.harness, accountKey: account.accountKey,
        lane: typeof window.key === 'string' && SLUG.test(window.key) ? window.key : 'unknown',
        usedPercent, resetAt: timestamp(window.resetsAt),
        status: reading?.error || reading?.stale || usedPercent === null ? 'unknown' : usedPercent >= 100 ? 'exhausted' : window.willLast === false ? 'ahead' : 'ok',
        ...(estimate ? { estimate } : {}) };
    });
  });
}
