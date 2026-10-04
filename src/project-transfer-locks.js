import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { SLUG } from './projects.js';

const TRANSFER_ID = /^[0-9a-f-]{36}$/i;
const lockFile = (slug, dataDir) => path.join(dataDir, 'project-transfer-locks', `${slug}.json`);

export function readProjectTransferLock(slug, { dataDir = DATA_DIR } = {}) {
  if (!SLUG.test(slug)) throw new Error('The project slug is invalid.');
  let record;
  try { record = JSON.parse(fs.readFileSync(lockFile(slug, dataDir), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`The transfer lock for ${slug} cannot be read. Refusing to start work.`);
  }
  if (record?.schema !== 1 || record.slug !== slug || !TRANSFER_ID.test(record.transferId)
    || !['source', 'target'].includes(record.side) || typeof record.peerFactoryId !== 'string'
    || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) {
    throw new Error(`The transfer lock for ${slug} is invalid. Refusing to start work.`);
  }
  return record;
}

export function createProjectTransferLock(slug, { transferId, side, peerFactoryId, dataDir = DATA_DIR, now = Date.now } = {}) {
  if (!SLUG.test(slug) || !TRANSFER_ID.test(transferId || '') || !['source', 'target'].includes(side)
    || typeof peerFactoryId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(peerFactoryId)) {
    throw new Error('The project transfer lock is invalid.');
  }
  const directory = path.dirname(lockFile(slug, dataDir));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const record = { schema: 1, slug, transferId, side, peerFactoryId, createdAt: new Date(now()).toISOString() };
  try { fs.writeFileSync(lockFile(slug, dataDir), `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`A project transfer is already open for ${slug}.`);
    throw error;
  }
  return record;
}

export function releaseProjectTransferLock(slug, transferId, { dataDir = DATA_DIR } = {}) {
  const current = readProjectTransferLock(slug, { dataDir });
  if (!current) return false;
  if (current.transferId !== transferId) throw new Error(`The transfer lock for ${slug} belongs to another transfer.`);
  fs.unlinkSync(lockFile(slug, dataDir));
  return true;
}

export function projectTransferRefusal(slug, { dataDir = DATA_DIR } = {}) {
  const lock = readProjectTransferLock(slug, { dataDir });
  if (lock) return `Project ${slug} has an open transfer. Worker start is refused until it is switched or cancelled.`;
  let project;
  try { project = JSON.parse(fs.readFileSync(path.join(dataDir, 'projects', `${slug}.json`), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`The transfer status for ${slug} cannot be read. Refusing to start work.`); }
  if (project?.transfer?.status === 'transferred') return `Project ${slug} was transferred to ${project.transfer.toFactory}. Worker start is refused.`;
  return null;
}

export function assertProjectTransferAllowsWorker(slug, options = {}) {
  const refusal = projectTransferRefusal(slug, options);
  if (refusal) throw new Error(refusal);
}
