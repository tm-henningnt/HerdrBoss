import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-sandbox-home-'));
process.env.HOME = homeDir;
process.env.HERDR_BOSS_DIR = path.join(homeDir, 'unused-data');
delete process.env.HERDR_BOSS_LIVE_DIR;

const { assertDataWritable } = await import('../src/config.js');

const MESSAGE = /^Herdr Boss cannot write to .+ \(EACCES\)\. A sandbox blocks this write\. Run the same command again outside the sandbox \(an escalated run\)\.$/m;

// Simulate a sandbox: the data directory exists but refuses writes. Restore the mode so cleanup can delete it.
function readOnlyDir(t, tag, prepare = () => {}) {
  const dir = fs.mkdtempSync(path.join(homeDir, `${tag}-`));
  prepare(dir);
  fs.chmodSync(dir, 0o500);
  t.after(() => fs.chmodSync(dir, 0o700));
  return dir;
}

test.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

test('assertDataWritable passes for a writable directory and leaves no probe file', () => {
  const dir = fs.mkdtempSync(path.join(homeDir, 'writable-'));
  assert.equal(assertDataWritable(dir), undefined);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('assertDataWritable throws DATA_NOT_WRITABLE for a read-only directory', (t) => {
  const dir = readOnlyDir(t, 'readonly');
  assert.throws(() => assertDataWritable(dir), (error) => {
    assert.equal(error.code, 'DATA_NOT_WRITABLE');
    assert.equal(error.exitCode, 77);
    assert.equal(error.message, `Herdr Boss cannot write to ${dir} (EACCES). A sandbox blocks this write. Run the same command again outside the sandbox (an escalated run).`);
    return true;
  });
});

test('assertDataWritable passes other errors through unchanged', () => {
  const file = path.join(homeDir, 'not-a-dir');
  fs.writeFileSync(file, '');
  assert.throws(() => assertDataWritable(file), (error) => error.code === 'ENOTDIR');
});

test('handoff ready in a sandbox exits 77 before any Herdr call', (t) => {
  const bin = fs.mkdtempSync(path.join(homeDir, 'bin-'));
  const marker = path.join(homeDir, `herdr-called-${process.pid}`);
  fs.writeFileSync(path.join(bin, 'herdr'), `#!/bin/sh\necho called > '${marker}'\necho '{"pane":{"agent":"claude"}}'\n`, { mode: 0o755 });
  // A prepared automatic record makes the current code reach its Herdr call and its save().
  const dataDir = readOnlyDir(t, 'data', (dir) => {
    fs.mkdirSync(path.join(dir, 'projects'));
    fs.writeFileSync(path.join(dir, 'handoffs.json'), JSON.stringify([{ id: 'some-id', status: 'prepared', automatic: true, newPane: 'w1:p1', toKind: 'claude' }]));
  });
  const result = spawnSync(process.execPath, [path.join(repo, 'src', 'cli.js'), 'handoff', 'ready', 'some-id'], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 10000,
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: homeDir, HERDR_BOSS_DIR: dataDir, TMPDIR: os.tmpdir() },
  });
  assert.equal(result.status, 77, result.stderr);
  assert.match(result.stderr, MESSAGE);
  assert.ok(result.stderr.includes(dataDir));
  assert.equal(fs.existsSync(marker), false, 'the command called herdr');
});

test('a data-directory write error in any command maps to the sandbox message', (t) => {
  // No projects directory: loadConfig() fails with EACCES on mkdir inside the data directory.
  const dataDir = readOnlyDir(t, 'bare');
  const result = spawnSync(process.execPath, [path.join(repo, 'src', 'cli.js'), 'handoff', 'list'], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 10000,
    env: { PATH: process.env.PATH, HOME: homeDir, HERDR_BOSS_DIR: dataDir, TMPDIR: os.tmpdir() },
  });
  assert.equal(result.status, 77, result.stderr);
  assert.match(result.stderr, MESSAGE);
});
