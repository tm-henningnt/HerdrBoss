import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const sharedDataDir = process.env.HERDR_BOSS_DIR;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-boss-test-file-'));
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
process.env.HERDR_BOSS_DIR = dataDir;
process.env.HERDR_BOSS_LIVE_DIR = dataDir;
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
