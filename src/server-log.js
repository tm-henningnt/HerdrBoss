import fs from 'node:fs';

// An append-only log file that rotates by size: file, file.1, file.2. maxBytes and keepFiles are functions, so a
// saved setting applies at the next write. A write never throws. A failed rotation keeps the line and warns on stderr once per minute. A line larger than the limit is kept whole.
export function createRotatingLog({ file, maxBytes, keepFiles, warn = (message) => process.stderr.write(`${message}\n`), now = () => Date.now() }) {
  let size = null;
  let warnedAt = -Infinity;
  const rotate = () => {
    const keep = Math.max(1, Math.min(2, Number(keepFiles()) || 2));
    for (let index = keep + 1; index <= 2; index += 1) {
      try { fs.unlinkSync(`${file}.${index}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
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
        if (size > 0 && size + bytes > Math.max(1, Number(maxBytes()) || 1)) {
          try { rotate(); } catch (error) {
            // Keep the line and the log. Append to the current file and warn at most once per minute.
            if (now() - warnedAt >= 60_000) {
              warnedAt = now();
              try { warn(`herdr-boss: service.log rotation failed (${error.code || 'error'}). The log keeps growing until rotation works.`); } catch {}
            }
          }
        }
        fs.appendFileSync(file, line, { mode: 0o600 });
        size += bytes;
      } catch { size = null; }
    },
  };
}
