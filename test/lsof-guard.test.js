import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { listCwdProcesses } from '../src/kit/workers.js';

test('listCwdProcesses returns an empty list when lsof is not on the PATH', (t) => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-no-lsof-'));
  const savedPath = process.env.PATH;
  t.after(() => { process.env.PATH = savedPath; fs.rmSync(empty, { recursive: true, force: true }); });
  process.env.PATH = empty;
  assert.deepEqual(listCwdProcesses(), []);
});

test('listCwdProcesses keeps a failure of an installed lsof', (t) => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-bad-lsof-'));
  const savedPath = process.env.PATH;
  t.after(() => { process.env.PATH = savedPath; fs.rmSync(bin, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(bin, 'lsof'), '#!/bin/sh\necho denied >&2\nexit 2\n', { mode: 0o755 });
  process.env.PATH = bin;
  assert.throws(() => listCwdProcesses());
});
