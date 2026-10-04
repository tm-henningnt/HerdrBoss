// One non-waiting lock for one canonical setup data folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertDataFile } from './data-file-safety.js';

export const SETUP_LOCKED_MESSAGE = 'Setup is already running for this data folder.';

function startMarker(pid) { return `${pid}@${os.hostname()}`; }

function removeHeldFile(file, held) {
  try {
    const current = fs.lstatSync(file);
    if (current.dev !== held.dev || current.ino !== held.ino) return false;
    fs.unlinkSync(file);
    return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function createLock(file) {
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (error.code === 'EEXIST') return null; throw error; }
  const held = fs.fstatSync(fd);
  try { fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startMarker: startMarker(process.pid) })}\n`); }
  catch (error) {
    try { removeHeldFile(file, held); } finally { fs.closeSync(fd); }
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { removeHeldFile(file, held); } finally { fs.closeSync(fd); }
  };
}

function staleOwner(owner) {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.startMarker !== 'string' || !owner.startMarker) return false;
  try { process.kill(owner.pid, 0); }
  catch (error) { return error.code === 'ESRCH'; }
  return owner.startMarker !== startMarker(owner.pid);
}

export function takeSetupLock(dir) {
  const file = path.join(dir, 'setup.lock');
  assertDataFile(file, dir);
  const release = createLock(file);
  if (release) return release;
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) {
    if (error.code === 'ENOENT') return createLock(file);
    if (error.code === 'ELOOP') return null;
    throw error;
  }
  try {
    const held = fs.fstatSync(fd);
    if (!held.isFile() || held.nlink !== 1) return null;
    let owner;
    try { owner = JSON.parse(fs.readFileSync(fd, 'utf8')); }
    catch (error) { if (error instanceof SyntaxError) return null; throw error; }
    if (!staleOwner(owner) || !removeHeldFile(file, held)) return null;
    // A competing reclaimer can win here. Never replace or follow its lock.
    return createLock(file);
  } finally { fs.closeSync(fd); }
}
