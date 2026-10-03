import path from 'node:path';
import os from 'node:os';
import { factoryRecords, fleetPollError } from './fleet-poller.js';
import { FLEET_GUIDE_TOKEN } from './fleet-access.js';
import { readFleetFile, writeFleetFile } from './fleet-store.js';
import { guidanceError } from './fleet-guidance.js';
import { redactSecrets } from './redact.js';
import { readFactoryShares } from './fleet-pacing.js';

export function createFleetShares({ dir, privateDir, settings, receiver, registryFile = path.join(process.env.HERDR_FACTORIES_DIR || path.join(process.env.HOME || os.homedir(), '.herdr-factories'), 'fleet.json'), fetchImpl = fetch, now = Date.now }) {
  const file = path.join(dir, 'fleet-shares.json');
  const read = () => readFleetFile(file, { accounts: [] });
  const deliveries = new Map();
  let pending = Promise.resolve();
  const serial = (fn) => { const result = pending.then(fn); pending = result.catch(() => {}); return result; };
  const accounts = () => {
    const saved = read();
    return settings().accounts.map((account) => {
      const previous = saved.accounts.find((row) => row.accountKey === account.accountKey);
      const scope = [...account.scope].sort();
      return { ...account, shares: scope.map((factoryId, index) => ({ factoryId,
        share: previous ? previous.shares.find((row) => row.factoryId === factoryId)?.share ?? 0
          : Math.floor(100 / scope.length) + (index < 100 % scope.length ? 1 : 0) })) };
    });
  };
  const role = () => {
    const local = settings();
    if (!local.headOffice) throw guidanceError('Enable head office polling before sending guidance.', 403);
    const current = readFleetFile(path.join(dir, 'head-office-role.json'), null);
    const accepted = receiver.view();
    const epoch = Math.max(1, current?.epoch || 0, accepted.senderEpoch);
    const holder = current?.epoch >= accepted.senderEpoch ? current?.headOfficeFactoryId : accepted.headOfficeFactoryId;
    if (holder && holder !== local.factoryId) throw guidanceError('This factory does not hold the head office role.', 409);
    return { headOfficeFactoryId: local.factoryId, senderEpoch: epoch };
  };
  const send = async (factoryId, nudges = []) => {
    const local = settings();
    const savedKeys = new Set(read().accounts.map((account) => account.accountKey));
    const body = { schema: 1, contractVersion: '1.0.0', ...role(), sentAt: new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      shares: accounts().filter((account) => savedKeys.has(account.accountKey) && account.scope.includes(factoryId)).map((account) => ({ accountKey: account.accountKey, share: account.shares.find((row) => row.factoryId === factoryId).share })), nudges };
    if (factoryId === local.factoryId) {
      const result = await receiver.accept(body);
      return { factoryId, status: result.nudges.some((row) => row.status === 'pending') ? 'pending' : 'delivered' };
    }
    let result;
    try {
      const matches = factoryRecords(registryFile).filter((record) => record.factoryId === factoryId);
      if (matches.length !== 1) throw guidanceError('factory-not-registered');
      const target = new URL(matches[0].dashboardUrl);
      const loopback = target.hostname === 'localhost' || target.hostname === '[::1]'
        || /^127(?:\.\d{1,3}){3}$/.test(target.hostname);
      if (target.protocol !== 'https:' && !(target.protocol === 'http:' && loopback)) {
        throw Object.assign(guidanceError('Guidance requires HTTPS or HTTP on a loopback address.'), { code: 'unsafe-transport' });
      }
      const token = readFleetFile(path.join(privateDir, 'fleet-guide-remotes.json'), {})[factoryId];
      if (!FLEET_GUIDE_TOKEN.test(token)) throw Object.assign(new Error('auth'), { code: 'auth' });
      const response = await fetchImpl(`${matches[0].dashboardUrl}/api/fleet/guidance`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw Object.assign(new Error('refused'), { code: [401, 403].includes(response.status) ? 'auth' : response.status === 409 ? 'contract-mismatch' : 'unreachable' });
      }
      // Read a bounded response. Never export a remote error body or nudge text.
      const reader = response.body?.getReader();
      if (!reader || !response.headers.get('content-type')?.startsWith('application/json')) throw Object.assign(new Error('invalid-response'), { code: 'contract-mismatch' });
      const chunks = []; let bytes = 0;
      try {
        for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 16384) throw new Error('too-large'); chunks.push(Buffer.from(value)); }
        const ack = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (ack.ok !== true) throw new Error('invalid-response');
        result = { factoryId, status: ack.nudges?.some((row) => row.status === 'pending') ? 'pending' : 'delivered' };
      } catch { throw Object.assign(new Error('invalid-response'), { code: 'contract-mismatch' }); }
      finally { await reader.cancel().catch(() => {}); }
    } catch (error) {
      if (error.code === 'unsafe-transport') throw error;
      result = { factoryId, status: 'pending', error: fleetPollError(error) };
    }
    deliveries.set(factoryId, result);
    return result;
  };
  return {
    view: () => {
      const local = settings(), ceilings = readFactoryShares(dir);
      return { accounts: accounts(), deliveries: [...deliveries.values()], local: { factoryId: local.factoryId,
        shares: local.accounts.map((account) => ({ harness: account.harness, accountKey: account.accountKey, share: ceilings[account.harness === 'opencode' ? 'opencodego' : account.harness] })) } };
    },
    save(body) {
      return serial(async () => {
        role();
        const configured = settings().accounts;
        if (!body || Object.keys(body).some((key) => key !== 'accounts') || !Array.isArray(body.accounts)
          || body.accounts.length !== configured.length || new Set(body.accounts.map((row) => row?.accountKey)).size !== body.accounts.length) throw guidanceError('Give one factory share list for each account.');
        for (const row of body.accounts) {
          const account = configured.find((account) => account.accountKey === row?.accountKey);
          if (!account || Object.keys(row).some((key) => !['accountKey', 'shares'].includes(key)) || !Array.isArray(row.shares)
            || row.shares.length !== account.scope.length || new Set(row.shares.map((share) => share?.factoryId)).size !== row.shares.length
            || row.shares.some((share) => !share || Object.keys(share).some((key) => !['factoryId', 'share'].includes(key))
              || !account.scope.includes(share.factoryId) || !Number.isInteger(share.share) || share.share < 0 || share.share > 100)
            || row.shares.reduce((sum, share) => sum + share.share, 0) > 100) throw guidanceError('Account shares must use their scope and total at most 100.');
        }
        writeFleetFile(file, body);
        const targets = new Set(body.accounts.flatMap((account) => account.shares.map((row) => row.factoryId)));
        const results = [];
        for (const factoryId of targets) results.push(await send(factoryId));
        return { ...this.view(), deliveries: results };
      });
    },
    nudge(body) {
      return serial(async () => {
        role();
        if (!body || Object.keys(body).some((key) => !['factoryId', 'nudgeId', 'text'].includes(key))
          || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(body.nudgeId) || body.nudgeId.length > 64
          || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 500
          || !settings().accounts.some((account) => account.scope.includes(body.factoryId))) throw guidanceError('Give a scoped factory, a nudge ID, and text of 1 to 500 characters.');
        return send(body.factoryId, [{ nudgeId: body.nudgeId, text: redactSecrets(body.text) }]);
      });
    },
    retry: (record) => serial(async () => { if (read().accounts.length && settings().headOffice) await send(record.factoryId); }),
  };
}
