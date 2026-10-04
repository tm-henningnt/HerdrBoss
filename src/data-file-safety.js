// Local data files: validate paths before content I/O, then open without following links.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { resolveAlias } from './config.js';

export function assertDataFile(file, dir) {
  const relative = path.relative(resolveAlias(dir), resolveAlias(file));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('The data file is outside its data folder.');
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('The data file must be a regular file with no links.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export function readDataFile(file, dir) {
  assertDataFile(file, dir);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('The data file must be a regular file.');
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}

export function writeDataFile(file, value, dir) {
  assertDataFile(file, dir);
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, value); } finally { fs.closeSync(fd); }
    assertDataFile(file, dir);
    // Rename replaces a final directory entry. It never follows that entry's symlink.
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function assertSetupFiles(dir) {
  for (const name of ['setup.json', 'policy.json', 'policy-changes.jsonl', 'policy-changes.jsonl.lock']) assertDataFile(path.join(dir, name), dir);
}
