import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validate } from './fleet-schema.js';
import { readFleetFile, writeFleetFile } from './fleet-store.js';
import { redactSecrets } from './redact.js';

const schemaFile = fileURLToPath(new URL('../docs/contracts/schema/fleet-guidance.v1.schema.json', import.meta.url));
const schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
export const guidanceError = (message, status = 400) => Object.assign(new Error(message), { status });

export function createFleetGuidance({ dir, settings, deliver, now = Date.now }) {
  const file = path.join(dir, 'fleet-guidance.json');
  const roleFile = path.join(dir, 'head-office-role.json');
  const read = () => readFleetFile(file, { senderEpoch: 0, headOfficeFactoryId: null, shares: [], nudges: [] });
  let pending = Promise.resolve();
  const accept = async (body) => {
    if (validate(body, schema, { schemaFile }).length || body.contractVersion !== '1.0.0'
      || body.shares.length > 100 || body.nudges.length > 100) throw guidanceError('The guidance body is invalid.');
    const local = settings();
    const keys = new Set(local.accounts.filter((account) => account.scope.includes(local.factoryId)).map((account) => account.accountKey));
    if (new Set(body.shares.map((row) => row.accountKey)).size !== body.shares.length
      || body.shares.some((row) => !keys.has(row.accountKey))
      || new Set(body.nudges.map((row) => row.nudgeId)).size !== body.nudges.length) throw guidanceError('The guidance account scope or repeated key is invalid.');
    const previous = read();
    const role = readFleetFile(roleFile, null);
    const epoch = Math.max(previous.senderEpoch, role?.epoch || 0);
    const holder = role?.epoch >= previous.senderEpoch ? role.headOfficeFactoryId : previous.headOfficeFactoryId;
    if (body.senderEpoch - epoch > 1000) throw guidanceError('The guidance epoch is more than 1000 above the stored epoch.', 409);
    if (body.senderEpoch < epoch || (body.senderEpoch === epoch && holder && body.headOfficeFactoryId !== holder)) throw guidanceError('The guidance epoch or head office holder is stale.', 409);
    const nudges = body.senderEpoch === previous.senderEpoch ? previous.nudges : [];
    const incoming = body.nudges.map((nudge) => {
      const text = redactSecrets(nudge.text);
      const hash = createHash('sha256').update(text).digest('hex');
      const old = nudges.find((row) => row.nudgeId === nudge.nudgeId);
      if (old && old.hash !== hash) throw guidanceError('A nudge ID already has different text.', 409);
      return old || { nudgeId: nudge.nudgeId, hash, text, delivered: false };
    });
    const shares = new Map(previous.shares.map((row) => [row.accountKey, row]));
    for (const row of body.shares) shares.set(row.accountKey, row);
    const saved = { senderEpoch: body.senderEpoch, headOfficeFactoryId: body.headOfficeFactoryId,
      acceptedAt: new Date(now()).toISOString(), shares: [...shares.values()],
      nudges: [...nudges.filter((row) => !incoming.some((next) => next.nudgeId === row.nudgeId)), ...incoming] };
    if (saved.nudges.length > 2000) throw guidanceError('This head office term has reached its limit of 2000 nudge IDs.');
    writeFleetFile(file, saved);
    // A newer head office term also updates the role record, which holds the term for the whole factory.
    if (!role || body.senderEpoch > role.epoch) writeFleetFile(roleFile, { schema: 1, contractVersion: '1.0.0', headOfficeFactoryId: body.headOfficeFactoryId, epoch: body.senderEpoch, updatedAt: body.sentAt });
    const delivery = [];
    for (const nudge of saved.nudges.filter((row) => !row.delivered || incoming.includes(row))) {
      if (!nudge.delivered) {
        try {
          if (!deliver) throw new Error('boss-unavailable');
          await deliver(`[herdr-boss] Fleet guidance: ${nudge.text}`);
          nudge.delivered = true; delete nudge.text;
          writeFleetFile(file, saved);
        } catch { delivery.push({ nudgeId: nudge.nudgeId, status: 'pending' }); continue; }
      }
      delivery.push({ nudgeId: nudge.nudgeId, status: 'delivered' });
    }
    return { ok: true, senderEpoch: saved.senderEpoch, shares: saved.shares, nudges: delivery };
  };
  return {
    view: () => { const { nudges, ...view } = read(); return view; },
    accept(body) {
      const result = pending.then(() => accept(body));
      pending = result.catch(() => {});
      return result;
    },
  };
}
