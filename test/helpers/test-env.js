import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before } from 'node:test';

export const TEST_GIT_IDENTITY = Object.freeze({
  GIT_AUTHOR_NAME: 'Test User',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test User',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
});

Object.assign(process.env, TEST_GIT_IDENTITY);

export function withTestGitIdentity(env) {
  return { ...env, ...TEST_GIT_IDENTITY };
}

const realHome = path.resolve(os.userInfo().homedir || os.homedir());
const realDataDir = path.resolve(path.join(realHome, '.herdr-boss'));

export function isTempDir(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  const tempRoot = path.resolve(os.tmpdir());
  const relative = path.relative(tempRoot, path.resolve(value));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

const home = process.env.HOME || os.homedir();
const dataDir = process.env.HERDR_BOSS_DIR;
const liveDataDir = process.env.HERDR_BOSS_LIVE_DIR;
const allPathsAreTemporary = isTempDir(home) && isTempDir(dataDir) && isTempDir(liveDataDir);
const pointsAtRealDataDir = (value) => typeof value === 'string' && path.resolve(value) === realDataDir;

if (!allPathsAreTemporary || !dataDir || pointsAtRealDataDir(dataDir) || pointsAtRealDataDir(liveDataDir) || path.resolve(home) === realHome) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-boss-test-'));
  const temporaryHome = path.join(root, 'home');
  const temporaryDataDir = path.join(root, 'data');
  fs.mkdirSync(temporaryHome, { recursive: true });
  fs.mkdirSync(temporaryDataDir, { recursive: true });
  process.env.HOME = temporaryHome;
  process.env.HERDR_BOSS_DIR = temporaryDataDir;
  process.env.HERDR_BOSS_LIVE_DIR = temporaryDataDir;
  process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
}

before(async () => {
  const { initializeLifecyclePort } = await import('../../src/kit/lifecycle.js');
  initializeLifecyclePort();
});
