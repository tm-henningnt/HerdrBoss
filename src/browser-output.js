import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export function parseScreenshotOptions(args) {
  let tab = null;
  let out = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tab' && args[i + 1] && tab === null) tab = args[++i];
    else if (args[i] === '--out' && args[i + 1] && out === null) out = args[++i];
    else throw new Error('Use --tab ID and --out DIR to select a page and screenshot directory.');
  }
  return { tab, out };
}

export function saveBrowserScreenshot(image, { out = null, env = process.env } = {}) {
  const dir = out || env.TMPDIR || fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-boss-browser-'));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `screenshot-${randomBytes(8).toString('hex')}.jpg`);
  fs.writeFileSync(file, image, { flag: 'wx', mode: 0o600 });
  return file;
}
