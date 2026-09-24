import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function roamgateAvailable(cfg) {
  if (!fs.existsSync(cfg.roamgate.tokenFile)) return false;
  try {
    const searchPath = [path.join(os.homedir(), '.local/bin'), process.env.PATH || ''].join(path.delimiter);
    const { stdout } = await execFileAsync('roamgate', ['service', 'status'], { timeout: 3000, maxBuffer: 128 * 1024, env: { ...process.env, PATH: searchPath } });
    return /\bstate\s*=\s*running\b|\bActive:\s*active\s*\(running\)|\bstatus:\s*running\b/i.test(stdout);
  } catch { return false; }
}

export function roamgateUrl(requestHost, cfg) {
  const token = fs.readFileSync(cfg.roamgate.tokenFile, 'utf8').trim();
  if (!token || /\s/.test(token)) throw new Error('Roamgate token file is empty or invalid.');
  const hostname = new URL(`http://${requestHost}`).hostname;
  return `http://${hostname}:${cfg.roamgate.port}/?token=${encodeURIComponent(token)}`;
}
