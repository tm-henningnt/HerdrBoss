import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Run the real CLI entry with a temporary home and data directory.
function runRelease(args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-release-cli-home-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-release-cli-data-'));
  try {
    const env = { ...process.env, HOME: home, HERDR_BOSS_DIR: dataDir };
    delete env.HERDR_ENV;
    return spawnSync(process.execPath, [path.join(repo, 'src', 'cli.js'), 'release', ...args], { encoding: 'utf8', env, timeout: 30000 });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test('release status runs through the real CLI entry and prints no initialization error', () => {
  const result = runRelease(['status']);
  assert.doesNotMatch(`${result.stderr}${result.stdout}`, /before initialization/);
  assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
});

test('release request and release publish reach their own usage refusal through the real CLI entry', () => {
  for (const sub of ['request', 'publish']) {
    const result = runRelease([sub]);
    const text = `${result.stderr}${result.stdout}`;
    assert.doesNotMatch(text, /before initialization/, sub);
    assert.notEqual(result.status, 0, `${sub} without arguments must refuse`);
    assert.match(text, /release/i, sub);
  }
});

test('a release command with an unknown subcommand is refused through the real CLI entry', () => {
  const result = runRelease(['nothing']);
  assert.doesNotMatch(`${result.stderr}${result.stdout}`, /before initialization/);
  assert.notEqual(result.status, 0);
});
