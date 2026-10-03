import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function readFleetFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return structuredClone(fallback);
    throw new Error('A fleet file cannot be read.');
  }
}

export function writeFleetFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
