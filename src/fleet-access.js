import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DATA_DIR } from './config.js';
import { readFleetFile, writeFleetFile } from './fleet-store.js';

export const FLEET_READ_TOKEN = /^hf_read_[a-f0-9]{64}$/;
export const FLEET_GUIDE_TOKEN = /^hf_guide_[a-f0-9]{64}$/;
// A factory holds the role when the role record names it, or when it polls as head office and has no record.
function holdsRole(dir) {
  const factoryId = readFleetFile(path.join(dir, 'factory-identity.json'), {}).factoryId;
  const role = readFleetFile(path.join(dir, 'head-office-role.json'), null);
  if (role) return !!factoryId && role.headOfficeFactoryId === factoryId;
  return readFleetFile(path.join(dir, 'fleet-settings.json'), {}).headOffice === true;
}
const digest = (value) => createHash('sha256').update(value).digest('hex');
function createFleetAccess({ privateDir, dir = DATA_DIR, now = () => Date.now() }, kind, pattern) {
  const file = path.join(privateDir, `fleet-${kind}.json`);
  const read = () => readFleetFile(file, {});
  return {
    rotate() {
      // The holder of the head office role keeps its term. Only another factory resets the stored epoch and holder.
      if (kind === 'guide' && !holdsRole(dir)) {
        const guidanceFile = path.join(dir, 'fleet-guidance.json');
        const guidance = readFleetFile(guidanceFile, null);
        if (guidance) writeFleetFile(guidanceFile, { senderEpoch: 0, headOfficeFactoryId: null, shares: guidance.shares, nudges: [] });
        fs.rmSync(path.join(dir, 'head-office-role.json'), { force: true });
      }
      const token = `hf_${kind}_${randomBytes(32).toString('hex')}`;
      const current = read().current;
      writeFleetFile(file, { current: digest(token), ...(current ? { previous: current, previousValidUntil: now() + 600000 } : {}) });
      return token;
    },
    check(req) {
      const header = String(req.headers.authorization || '');
      const prefix = new RegExp(`^Bearer\\s+hf_${kind}_`, 'i');
      const presented = new RegExp(`^Bearer\\s+(hf_${kind}_\\S*)\\s*$`, 'i').exec(header)?.[1];
      if (!presented) return { present: prefix.test(header), authorized: false };
      if (!pattern.test(presented)) return { present: true, authorized: false };
      const hashes = read();
      const candidate = Buffer.from(digest(presented), 'hex');
      const equal = (hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash) && timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
      return { present: true, authorized: equal(hashes.current) || (now() < hashes.previousValidUntil && equal(hashes.previous)) };
    },
  };
}
export const createFleetReadAccess = (options) => createFleetAccess(options, 'read', FLEET_READ_TOKEN);
export const createFleetGuideAccess = (options) => createFleetAccess(options, 'guide', FLEET_GUIDE_TOKEN);
