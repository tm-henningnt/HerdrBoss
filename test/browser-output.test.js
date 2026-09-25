import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseScreenshotOptions, saveBrowserScreenshot } from '../src/browser-output.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-browser-output-'));
}

test('browser screenshot saves under TMPDIR when set', () => {
  const dir = tempDir();
  const file = saveBrowserScreenshot(Buffer.from('jpeg'), { env: { TMPDIR: dir } });
  assert.equal(path.dirname(file), dir);
  assert.deepEqual(fs.readFileSync(file), Buffer.from('jpeg'));
});

test('browser screenshot --out overrides TMPDIR and accepts --tab with it', () => {
  const tmp = tempDir();
  const out = path.join(tempDir(), 'captures');
  const options = parseScreenshotOptions(['--tab', 'tab-1', '--out', out]);
  assert.deepEqual(options, { tab: 'tab-1', out });
  const file = saveBrowserScreenshot(Buffer.from('jpeg'), { out: options.out, env: { TMPDIR: tmp } });
  assert.equal(path.dirname(file), out);
  assert.deepEqual(fs.readFileSync(file), Buffer.from('jpeg'));
});
