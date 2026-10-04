import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { harnessLoginVerifierArgs } from './factory-wizard.js';

const LOGIN_STATE_FILES = Object.freeze({
  claude: '.claude.json',
  codex: '.codex/config.toml',
});
const LOGIN_CHECKS = Object.freeze(['claude', 'codex']);
const LOGIN_TIMEOUT_MS = 10000;

function runVerifier(command, args, { env, timeout = LOGIN_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { env, timeout, maxBuffer: 1024 }, (error) => resolve({ code: error ? 1 : 0 }));
  });
}

// Inspect only path metadata. Refuse every symlink in the HOME-relative path.
export function loginStateFileStatus(home, harness) {
  const relative = LOGIN_STATE_FILES[harness];
  if (!relative) return { status: 'unknown', reason: 'no recorded login state file' };
  const root = path.resolve(home);
  const target = path.resolve(root, relative);
  const inside = path.relative(root, target);
  if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
    return { status: 'unknown', reason: 'login state path is outside HOME' };
  }
  let current = root;
  const parts = inside.split(path.sep);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { status: 'missing' };
      return { status: 'unknown', reason: 'login state file cannot be checked' };
    }
    if (stat.isSymbolicLink()) return { status: 'unknown', reason: 'login state path contains a symlink' };
    if (index < parts.length - 1 && !stat.isDirectory()) return { status: 'unknown', reason: 'login state path is not a directory' };
    if (index === parts.length - 1) return stat.isFile()
      ? { status: 'present' }
      : { status: 'unknown', reason: 'login state path is not a regular file' };
  }
  return { status: 'unknown', reason: 'login state file cannot be checked' };
}

function checkedAt(now) {
  const value = new Date(now());
  return Number.isFinite(value.getTime()) ? `${value.toISOString().slice(0, 19)}Z` : null;
}

// Return login facts only. The verifier output is discarded and state files are never opened.
export async function readFleetLogins({ home = process.env.HOME || os.homedir(), run = runVerifier, now = Date.now } = {}) {
  const rows = [];
  for (const harness of LOGIN_CHECKS) {
    const at = checkedAt(now);
    let passed = false;
    try {
      const result = await run(harness, harnessLoginVerifierArgs(harness), {
        env: { ...process.env, HOME: home }, timeout: LOGIN_TIMEOUT_MS,
      });
      passed = result?.code === 0;
    } catch {}
    if (passed) {
      rows.push({ harness, login: 'logged-in', checkedAt: at });
      continue;
    }
    const state = loginStateFileStatus(home, harness);
    if (state.status === 'present') rows.push({ harness, login: 'expired', checkedAt: at });
    else if (state.status === 'missing') rows.push({ harness, login: 'none', checkedAt: at });
    else rows.push({ harness, login: 'unknown', checkedAt: at, reason: state.reason });
  }
  rows.push({ harness: 'opencode', login: 'unknown', checkedAt: null, reason: 'no recorded login state file' });
  return rows;
}
