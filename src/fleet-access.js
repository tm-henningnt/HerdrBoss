import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFleetFile, writeFleetFile } from './fleet-store.js';

export const FLEET_READ_TOKEN = /^hf_read_[a-f0-9]{64}$/;
const digest = (value) => createHash('sha256').update(value).digest('hex');
export function createFleetReadAccess({ privateDir, now = () => Date.now() }) {
  const file = path.join(privateDir, 'fleet-read.json');
  const read = () => readFleetFile(file, {});
  return {
    rotate() {
      const token = `hf_read_${randomBytes(32).toString('hex')}`;
      const current = read().current;
      writeFleetFile(file, { current: digest(token), ...(current ? { previous: current, previousValidUntil: now() + 600000 } : {}) });
      return token;
    },
    check(req) {
      const header = String(req.headers.authorization || '');
      const presented = /^Bearer\s+(hf_read_\S*)\s*$/i.exec(header)?.[1];
      if (!presented) return { present: /^Bearer\s+hf_read_/i.test(header), authorized: false };
      if (!FLEET_READ_TOKEN.test(presented)) return { present: true, authorized: false };
      const hashes = read();
      const candidate = Buffer.from(digest(presented), 'hex');
      const equal = (hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash) && timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
      return { present: true, authorized: equal(hashes.current) || (now() < hashes.previousValidUntil && equal(hashes.previous)) };
    },
  };
}
