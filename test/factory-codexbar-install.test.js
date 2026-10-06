import './helpers/test-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureCodexbar, pinnedVersion } from '../src/factory-codexbar-install.js';

const io = () => { const out = []; return { out, stdout: { write: (text) => out.push(text) } }; };
const transport = (reply) => { const calls = []; return { calls, run: async (args) => { calls.push(args); return typeof reply === 'function' ? reply(args) : reply; } }; };
const word = (value) => ({ code: 0, stdout: `${value}\n`, stderr: '' });

test('the host step runs the container command as the factory user and prints one line', async () => {
  const docker = transport(word('installed'));
  const output = io();
  assert.equal(await ensureCodexbar(docker, 'demo', output), 'installed');
  assert.equal(docker.calls.length, 1);
  const args = docker.calls[0];
  assert.deepEqual(args.slice(0, 3), ['exec', '--user', 'factory']);
  assert.ok(args.includes('hf-demo'));
  assert.deepEqual(args.slice(-2), ['codexbar-install', '--apply']);
  assert.deepEqual(output.out, ['CodexBar: installed 0.72.0.\n']);
});

test('a current install and each fixed reason print their line', async () => {
  const lines = {
    installed: 'CodexBar: installed 0.72.0.',
    unchanged: 'CodexBar: installed 0.72.0.',
    'download-failed': 'CodexBar: not installed, download failed.',
    'hash-mismatch': 'CodexBar: not installed, hash mismatch.',
    'unsupported-architecture': 'CodexBar: not installed, unsupported architecture.',
    'no-network': 'CodexBar: not installed, no network.',
  };
  for (const [value, text] of Object.entries(lines)) {
    const output = io();
    assert.equal(await ensureCodexbar(transport(word(value)), 'demo', output), value);
    assert.equal(output.out.join(''), `${text}\n`);
  }
});

test('a config word adds a fixed second line and no file content is echoed', async () => {
  const output = io();
  assert.equal(await ensureCodexbar(transport({ code: 0, stdout: 'installed\nconfig-invalid\n', stderr: '' }), 'demo', output), 'installed');
  assert.deepEqual(output.out, ['CodexBar: installed 0.72.0.\n', 'CodexBar config: invalid.\n']);
});

test('pinnedVersion reads the pins file that the caller passes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbar-pins-'));
  try {
    const file = path.join(dir, 'pins.json');
    fs.writeFileSync(file, JSON.stringify({ codexbar: '1.2.3' }));
    assert.equal(pinnedVersion(file), '1.2.3');
    fs.writeFileSync(file, JSON.stringify({ codexbar: 'nope' }));
    assert.equal(pinnedVersion(file), null);
    fs.writeFileSync(file, JSON.stringify({}));
    assert.equal(pinnedVersion(file), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a failing step prints the fixed line, never throws, and prints no container output', async () => {
  const invented = 'herdr-boss: allow-test-token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature';
  for (const docker of [transport({ code: 1, stdout: invented, stderr: 'boom\nsecond' }), transport(() => { throw new Error('The factory host is unreachable.'); }), transport(word('surprise'))]) {
    const output = io();
    assert.equal(await ensureCodexbar(docker, 'demo', output), 'failed');
    assert.match(output.out.join(''), /^CodexBar: not installed, /);
    assert.doesNotMatch(output.out.join(''), /eyJhbGci|boom|second|surprise/);
  }
});
