import './helpers/test-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureClaudeHelper } from '../src/factory-claude-install.js';

const io = () => { const out = []; return { out, stdout: { write: (text) => out.push(text) } }; };
const transport = (reply) => { const calls = []; return { calls, run: async (args) => { calls.push(args); return typeof reply === 'function' ? reply(args) : reply; } }; };
const word = (value) => ({ code: 0, stdout: `${value}\n`, stderr: '' });

test('the host step runs the helper as the factory user in the container and prints one line', async () => {
  const docker = transport(word('installed'));
  const output = io();
  assert.equal(await ensureClaudeHelper(docker, 'demo', output), 'installed');
  assert.equal(docker.calls.length, 1);
  const args = docker.calls[0];
  assert.deepEqual(args.slice(0, 3), ['exec', '--user', 'factory']);
  assert.ok(args.includes('hf-demo'));
  assert.deepEqual(args.slice(-2), ['claude-helper', '--apply']);
  assert.deepEqual(output.out, ['Claude usage helper: installed.\n']);
});

test('each state word has a fixed line and the second run says unchanged', async () => {
  const lines = { installed: 'installed', unchanged: 'installed, no change', removed: 'removed, the setting is off', off: 'not installed, the setting is off',
    foreign: 'not installed, a statusLine from the Owner exists', unreadable: 'not installed, the settings file is unreadable' };
  for (const [value, text] of Object.entries(lines)) {
    const output = io();
    assert.equal(await ensureClaudeHelper(transport(word(value)), 'demo', output), value);
    assert.equal(output.out.join(''), `Claude usage helper: ${text}.\n`);
  }
});

test('a failing step prints the reason, never throws, and prints no output of the container', async () => {
  for (const docker of [transport({ code: 1, stdout: 'SECRET-LINE', stderr: 'boom\nsecond' }), transport(() => { throw new Error('The factory host is unreachable.'); }), transport(word('surprise'))]) {
    const output = io();
    assert.equal(await ensureClaudeHelper(docker, 'demo', output), 'failed');
    assert.match(output.out.join(''), /^Claude usage helper: not applied, /);
    assert.doesNotMatch(output.out.join(''), /SECRET|second|surprise/);
  }
});
