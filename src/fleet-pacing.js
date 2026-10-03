import path from 'node:path';
import { readFleetFile } from './fleet-store.js';
import { validateAccounts } from './fleet-quotas.js';

export const FACTORY_SHARE_ERROR = 'Factory shares could not be read. Repair fleet-guidance.json or fleet-accounts.json before starting metered workers.';

// Shares are separate from policy. A policy write cannot raise this ceiling.
export function readFactoryShares(dir) {
  const accounts = validateAccounts(readFleetFile(path.join(dir, 'fleet-accounts.json'), []));
  const accepted = readFleetFile(path.join(dir, 'fleet-guidance.json'), { shares: [] });
  if (!accepted || !Array.isArray(accepted.shares) || accepted.shares.length > 100
    || (accepted.senderEpoch !== undefined && (!Number.isSafeInteger(accepted.senderEpoch) || accepted.senderEpoch < 0))
    || new Set(accepted.shares.map((row) => row?.accountKey)).size !== accepted.shares.length
    || accepted.shares.some((row) => !row || Object.keys(row).some((key) => !['accountKey', 'share'].includes(key))
      || !/^[a-f0-9]{64}$/.test(row.accountKey) || !Number.isInteger(row.share) || row.share < 0 || row.share > 100)) {
    throw new Error('The saved factory shares are invalid.');
  }
  if (!accounts.length) return {};
  const identity = readFleetFile(path.join(dir, 'factory-identity.json'), {});
  const result = {};
  for (const account of accounts) {
    const provider = account.harness === 'opencode' ? 'opencodego' : account.harness;
    const saved = accepted.shares?.find((row) => row.accountKey === account.accountKey)?.share;
    result[provider] = account.scope.includes(identity.factoryId) ? saved ?? 100 : 0;
  }
  return result;
}
