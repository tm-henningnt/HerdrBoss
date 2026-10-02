import fs from 'node:fs';

// An append-only log file that rotates by size: file, file.1, file.2. maxBytes and keepFiles are functions, so a
// saved setting applies at the next write. A write never throws. A line larger than the limit is kept whole.
export function createRotatingLog({ file, maxBytes, keepFiles }) {
  let size = null;
  const rotate = () => {
    const keep = Math.max(1, Math.min(2, Number(keepFiles()) || 2));
    for (let index = keep; index >= 1; index -= 1) {
      const from = index === 1 ? file : `${file}.${index - 1}`;
      try { fs.renameSync(from, `${file}.${index}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    size = 0;
  };
  return {
    write(text) {
      const line = `${text}\n`;
      const bytes = Buffer.byteLength(line);
      try {
        if (size === null) size = fs.existsSync(file) ? fs.statSync(file).size : 0;
        if (size > 0 && size + bytes > Math.max(1, Number(maxBytes()) || 1)) rotate();
        fs.appendFileSync(file, line, { mode: 0o600 });
        size += bytes;
      } catch { size = null; }
    },
  };
}
