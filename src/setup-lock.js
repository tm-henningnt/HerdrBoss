// One non-waiting lock for one canonical setup data folder.
import fs from 'node:fs';
import path from 'node:path';
import { assertDataFile } from './data-file-safety.js';

export const SETUP_LOCKED_MESSAGE = 'Setup is already running for this data folder.';

export function takeSetupLock(dir) {
  const file = path.join(dir, 'setup.lock');
  assertDataFile(file, dir);
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (error.code === 'EEXIST') return null; throw error; }
  const held = fs.fstatSync(fd);
  fs.closeSync(fd);
  return () => {
    try {
      const current = fs.lstatSync(file);
      if (current.dev === held.dev && current.ino === held.ino) fs.unlinkSync(file);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
}
