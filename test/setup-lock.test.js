import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { takeSetupLock } from '../src/setup-lock.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'setup.lock') };
}

function owner(startMarker = `${process.pid}@${os.hostname()}`) {
  return JSON.stringify({ pid: process.pid, startMarker });
}

test('F5 lock records its owner and refuses a live holder', (t) => {
  const { dir, file } = fixture(t);
  const release = takeSetupLock(dir);
  try {
    const text = fs.readFileSync(file, 'utf8');
    assert.deepEqual(JSON.parse(text), JSON.parse(owner()));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(takeSetupLock(dir), null);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  } finally { release(); }
  assert.equal(fs.existsSync(file), false);
});

test('F5 lock reclaims a different start marker for the same live pid', (t) => {
  const { dir, file } = fixture(t);
  fs.writeFileSync(file, owner('previous-process-instance'));
  const release = takeSetupLock(dir);
  assert.equal(typeof release, 'function');
  try { assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), JSON.parse(owner())); }
  finally { release(); }
});

test('F5 lock refuses malformed ownership and an unprobeable holder', (t) => {
  const { dir, file } = fixture(t);
  for (const text of ['', '{invalid', '{}', '{"pid":-1,"startMarker":"invalid"}']) {
    fs.writeFileSync(file, text);
    assert.equal(takeSetupLock(dir), null);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
  fs.writeFileSync(file, owner());
  const originalKill = process.kill;
  let probed = false;
  process.kill = (pid, signal) => {
    assert.equal(pid, process.pid);
    assert.equal(signal, 0);
    probed = true;
    throw Object.assign(new Error('Fixture permission denied'), { code: 'EPERM' });
  };
  try { assert.equal(takeSetupLock(dir), null); }
  finally { process.kill = originalKill; }
  assert.equal(probed, true);
  assert.equal(fs.readFileSync(file, 'utf8'), owner());
});

test('F5 reclaim refuses a competitor that wins the exclusive open', async (t) => {
  for (const kind of ['regular', 'symlink']) {
    await t.test(kind, (t) => {
      const { dir, file } = fixture(t);
      fs.writeFileSync(file, owner('previous-process-instance'));
      const sentinel = path.join(dir, 'sentinel');
      fs.writeFileSync(sentinel, 'fixture sentinel\n', { mode: 0o644 });
      const originalUnlink = fs.unlinkSync;
      const originalOpen = fs.openSync;
      let competed = false;
      let exclusive = false;
      fs.unlinkSync = (target) => {
        const result = originalUnlink(target);
        if (target === file) {
          competed = true;
          if (kind === 'regular') fs.writeFileSync(file, owner());
          else fs.symlinkSync(sentinel, file);
        }
        return result;
      };
      fs.openSync = (target, flags, ...args) => {
        if (target === file && competed) {
          exclusive = Boolean((flags & fs.constants.O_EXCL) && (flags & fs.constants.O_NOFOLLOW));
        }
        return originalOpen(target, flags, ...args);
      };
      try { assert.equal(takeSetupLock(dir), null); }
      finally { fs.unlinkSync = originalUnlink; fs.openSync = originalOpen; }
      assert.equal(competed, true);
      assert.equal(exclusive, true);
      if (kind === 'regular') assert.equal(fs.readFileSync(file, 'utf8'), owner());
      else assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'fixture sentinel\n');
      assert.equal(fs.statSync(sentinel).mode & 0o777, 0o644);
    });
  }
});
