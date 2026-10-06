import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { MASTER_KEY_BYTES, createKeychainKeyProvider } from '../src/secret-master-key.js';
import { createSecretStore } from '../src/secret-store.js';

const { secretCommand } = await import('../src/secret-cli.js');
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VALUE = 'invented-value-1';
const EXPIRES = '2026-11-01T00:00:00.000Z';

let counter = 0;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `herdr-secret-cli-${counter += 1}-`));
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  const dir = path.join(home, '.config', 'herdr-boss', 'secrets');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let storedKey = null;
  const keyCalls = [];
  const keyProvider = createKeychainKeyProvider({
    run(command, args, options = {}) {
      keyCalls.push({ command, args: [...args] });
      if (args.length === 1 && args[0] === '-i') {
        const match = String(options.input ?? '').match(/-w ([0-9a-f]{64})\n$/);
        if (!match) return { status: 1, stdout: '', stderr: '' };
        storedKey = match[1];
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'find-generic-password' && storedKey) return { status: 0, stdout: `${storedKey}\n`, stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    },
  });

  const env = { ...process.env, HOME: home, HERDR_BOSS_DIR: data };
  for (const key of ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'HERDR_WORKTREE']) delete env[key];
  const store = (key = Buffer.alloc(MASTER_KEY_BYTES, 0x31)) => createSecretStore({ dir, key });
  return { root, home, data, dir, env, keyProvider, keyCalls, store };
}

function streamInput(text, isTTY = false) {
  const input = Readable.from(text === undefined ? [] : [text]);
  Object.defineProperty(input, 'isTTY', { value: isTTY });
  const rawModes = [];
  if (isTTY) Object.defineProperty(input, 'setRawMode', { value: (enabled) => { rawModes.push(enabled); return input; } });
  return { input, rawModes };
}

function outputStream(isTTY = false) {
  let text = '';
  const stream = new Writable({ write(chunk, _encoding, done) { text += chunk.toString(); done(); } });
  Object.defineProperty(stream, 'isTTY', { value: isTTY });
  return { stream, text: () => text };
}

async function invoke(fx, args, input = '', { isTTY = false, env = fx.env, providerValidators } = {}) {
  const { input: stdin, rawModes } = streamInput(input, isTTY);
  const stdout = outputStream(isTTY);
  const stderr = outputStream();
  const code = await secretCommand(args, {
    env, stdin, stdout: stdout.stream, stderr: stderr.stream,
    keyProvider: fx.keyProvider, dir: fx.dir, providerValidators,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text(), stdin, rawModes };
}

function auditLines(dir) {
  const file = path.join(dir, 'audit.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('secret set reads stdin, stores only metadata in the index, and writes a value-free audit line', async (t) => {
  const fx = fixture(t);
  const result = await invoke(fx, ['set', 'opencode-go-a', '--provider', 'opencode-go', '--label', 'subscription-a', '--expires', EXPIRES], `${VALUE}\n`);
  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes(`stored opencode-go-a in ${fx.dir}.`));
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(VALUE));
  const checked = await invoke(fx, ['check', 'opencode-go-a']);
  assert.equal(checked.code, 0);
  assert.match(checked.stdout, /opencode-go-a ok/);
  assert.doesNotMatch(checked.stdout + checked.stderr, new RegExp(VALUE));
  const index = fs.readFileSync(path.join(fx.dir, 'index.json'), 'utf8');
  assert.doesNotMatch(index, new RegExp(VALUE));
  assert.match(index, /"provider": "opencode-go"/);
  assert.match(index, /"label": "subscription-a"/);
  assert.match(index, new RegExp(EXPIRES));
  const lines = auditLines(fx.dir);
  assert.equal(lines.length, 2);
  assert.deepEqual(Object.keys(lines[0]).sort(), ['action', 'name', 'time']);
  assert.equal(lines[0].name, 'opencode-go-a');
  assert.equal(lines[0].action, 'set');
  assert.equal(lines[1].action, 'check');
  assert.equal(Number.isNaN(Date.parse(lines[0].time)), false);
  assert.doesNotMatch(JSON.stringify(lines), new RegExp(VALUE));
  assert.equal(fs.statSync(path.join(fx.dir, 'audit.jsonl')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(fx.dir).mode & 0o777, 0o700);
  assert.ok(fx.keyCalls.length > 0, 'the fake keychain adapter supplied the store key');
  assert.doesNotMatch(JSON.stringify(fx.keyCalls), new RegExp(VALUE));
});

test('secret set refuses a positional value with a fixed stdin message and no secret side effect', async (t) => {
  const fx = fixture(t);
  const result = await invoke(fx, ['set', 'alpha', VALUE]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /stdin/i);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(VALUE));
  assert.deepEqual(fx.keyCalls, [], 'refusal must not call the keychain adapter');
  assert.doesNotMatch(process.argv.join(' '), new RegExp(VALUE), 'the value is not in the test process argument list');
  assert.equal(fs.existsSync(path.join(fx.dir, 'index.json')), false);
  const lines = auditLines(fx.dir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].name, 'alpha');
  assert.equal(lines[0].action, 'set');
  assert.doesNotMatch(fs.readFileSync(path.join(fx.dir, 'audit.jsonl'), 'utf8'), new RegExp(VALUE));
  const flagged = await invoke(fx, ['set', 'alpha', '--token', VALUE]);
  assert.equal(flagged.code, 1);
  assert.match(flagged.stderr, /stdin/i);
  assert.doesNotMatch(flagged.stdout + flagged.stderr, new RegExp(VALUE));
  const invalidNameWithValue = await invoke(fx, ['set', 'BadName', VALUE]);
  assert.equal(invalidNameWithValue.code, 1);
  assert.match(invalidNameWithValue.stderr, /stdin/i);
  assert.doesNotMatch(invalidNameWithValue.stdout + invalidNameWithValue.stderr, new RegExp(VALUE));
  assert.doesNotMatch(fs.readFileSync(path.join(fx.dir, 'audit.jsonl'), 'utf8'), new RegExp(VALUE));
});

test('secret set prompts on a TTY without echoing the value', async (t) => {
  const fx = fixture(t);
  const result = await invoke(fx, ['set', 'alpha'], Buffer.from('abc\x08d\x7fe\n'), { isTTY: true });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /secret value/i);
  assert.equal(fx.store(fx.keyProvider.read()).getSecretValue('alpha').toString('utf8'), 'abe');
  assert.doesNotMatch(result.stdout + result.stderr, /abc|abe/);
  assert.deepEqual(result.rawModes, [true, false], 'the TTY input echo is disabled and restored');
});

test('secret set stops a TTY value at Ctrl-D', async (t) => {
  const fx = fixture(t);
  const result = await invoke(fx, ['set', 'alpha'], Buffer.from('terminal-value\x04ignored\n'), { isTTY: true });
  assert.equal(result.code, 0);
  assert.equal(fx.store(fx.keyProvider.read()).getSecretValue('alpha').toString('utf8'), 'terminal-value');
  assert.deepEqual(result.rawModes, [true, false]);
});

test('Ctrl-C cancels secret set with exit 130 and writes no store or audit files', async (t) => {
  const fx = fixture(t);
  const result = await invoke(fx, ['set', 'alpha'], Buffer.from('partial-value\x03'), { isTTY: true });
  assert.equal(result.code, 130);
  assert.deepEqual(result.rawModes, [true, false]);
  assert.deepEqual(fx.keyCalls, []);
  assert.equal(fs.existsSync(fx.dir), false);
  assert.deepEqual(auditLines(fx.dir), []);
});

test('secret set rejects empty or oversized input and any whitespace except one final LF', async (t) => {
  const fx = fixture(t);
  const cases = [
    { name: 'empty', value: Buffer.alloc(0) },
    { name: 'double-newline', value: Buffer.from('value\n\n') },
    { name: 'space', value: Buffer.from('value with space') },
    { name: 'tab', value: Buffer.from('value\twith-tab') },
    { name: 'too-long', value: Buffer.alloc(4097, 0x61) },
    { name: 'over-cap', value: Buffer.alloc(4098, 0x61) },
  ];
  for (const entry of cases) {
    const result = await invoke(fx, ['set', entry.name], entry.value);
    assert.equal(result.code, 1, `${entry.name} is refused`);
    assert.match(result.stderr, /secret value/i);
    assert.equal(fs.existsSync(path.join(fx.dir, `${entry.name}.sealed`)), false);
  }
  const emptyTTY = await invoke(fx, ['set', 'empty-tty'], Buffer.from('\r'), { isTTY: true });
  assert.equal(emptyTTY.code, 1);
  assert.match(emptyTTY.stderr, /secret value/i);
  const tooLongTTY = await invoke(fx, ['set', 'too-long-tty'], Buffer.alloc(4097, 0x61), { isTTY: true });
  assert.equal(tooLongTTY.code, 1);
  assert.deepEqual(tooLongTTY.rawModes, [true, false]);
  assert.deepEqual(fx.keyCalls, [], 'invalid values do not create or read a master key');
  assert.equal(fs.existsSync(path.join(fx.dir, 'index.json')), false);
});

test('secret set accepts a 4096-byte value and removes one final LF', async (t) => {
  const fx = fixture(t);
  const value = Buffer.alloc(4096, 0x61);
  const result = await invoke(fx, ['set', 'maximum'], Buffer.concat([value, Buffer.from('\n')]));
  assert.equal(result.code, 0);
  assert.deepEqual(fx.store(fx.keyProvider.read()).getSecretValue('maximum'), value);
  const crlf = await invoke(fx, ['set', 'crlf'], Buffer.from('invented-crlf-value\r\n'));
  assert.equal(crlf.code, 0);
  assert.equal(fx.store(fx.keyProvider.read()).getSecretValue('crlf').toString('utf8'), 'invented-crlf-value');
});

test('secret list prints metadata only and remains available in an agent pane', async (t) => {
  const fx = fixture(t);
  const store = fx.store();
  store.putSecret('alpha', VALUE, { provider: 'opencode-go', label: 'subscription-a', expires: EXPIRES });
  const result = await invoke(fx, ['list'], '', { env: { ...fx.env, HERDR_ENV: '1' } });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /alpha/);
  assert.match(result.stdout, /opencode-go/);
  assert.match(result.stdout, /subscription-a/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(VALUE));
  assert.equal(auditLines(fx.dir).at(-1).action, 'list');
});

test('secret remove asks for the name again and removes both sealed files', async (t) => {
  const fx = fixture(t);
  const store = fx.store();
  store.putSecret('alpha', 'invented-value-1');
  store.putSecret('alpha', 'invented-value-2');
  const result = await invoke(fx, ['remove', 'alpha'], 'alpha\n', { isTTY: true });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /name/i);
  assert.equal(fs.existsSync(path.join(fx.dir, 'alpha.sealed')), false);
  assert.equal(fs.existsSync(path.join(fx.dir, 'alpha.sealed.prev')), false);
  assert.deepEqual(store.listSecrets(), []);
  assert.equal(auditLines(fx.dir).at(-1).action, 'remove');
  assert.doesNotMatch(result.stdout + result.stderr + fs.readFileSync(path.join(fx.dir, 'audit.jsonl'), 'utf8'), /invented-value-[12]/);
});

test('secret remove refuses a confirmation that does not match', async (t) => {
  const fx = fixture(t);
  fx.store().putSecret('alpha', VALUE);
  const result = await invoke(fx, ['remove', 'alpha'], 'beta\n');
  assert.equal(result.code, 1);
  assert.equal(fs.existsSync(path.join(fx.dir, 'alpha.sealed')), true);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(VALUE));
  assert.equal(auditLines(fx.dir).at(-1).action, 'remove');
});

test('secret check reports only status and refuses an unknown name', async (t) => {
  const fx = fixture(t);
  const key = Buffer.alloc(MASTER_KEY_BYTES, 0x31);
  fx.keyProvider.write(key);
  fx.store(key).putSecret('alpha', VALUE);
  const checked = await invoke(fx, ['check', 'alpha']);
  assert.equal(checked.code, 0);
  assert.match(checked.stdout, /alpha.*ok/i);
  assert.doesNotMatch(checked.stdout + checked.stderr, new RegExp(VALUE));
  const unknown = await invoke(fx, ['check', 'missing']);
  assert.equal(unknown.code, 1);
  assert.doesNotMatch(unknown.stdout + unknown.stderr, new RegExp(VALUE));
  assert.equal(auditLines(fx.dir).at(-1).name, 'missing');
  assert.equal(auditLines(fx.dir).at(-1).action, 'check');
});

test('secret check enforces the generic format and calls the per-provider validator hook', async (t) => {
  const fx = fixture(t);
  const key = Buffer.alloc(MASTER_KEY_BYTES, 0x31);
  fx.keyProvider.write(key);
  const store = fx.store(key);
  store.putSecret('valid', Buffer.from('valid-value'), { provider: 'opencode-go' });
  store.putSecret('empty', Buffer.alloc(0), { provider: 'opencode-go' });
  store.putSecret('oversize', Buffer.alloc(4097, 0x61), { provider: 'opencode-go' });
  store.putSecret('invalid-utf8', Buffer.from([0xc3, 0x28]), { provider: 'opencode-go' });
  store.putSecret('control', Buffer.from('has\ttab'), { provider: 'opencode-go' });
  store.putSecret('leading-space', Buffer.from(' leading'), { provider: 'opencode-go' });
  store.putSecret('trailing-space', Buffer.from('trailing '), { provider: 'opencode-go' });
  let hookCalls = 0;
  const result = await invoke(fx, ['check'], '', {
    providerValidators: {
      'opencode-go': ({ name, value, metadata }) => {
        hookCalls += 1;
        assert.equal(name, 'valid');
        assert.equal(value.toString('utf8'), 'valid-value');
        assert.equal(metadata.provider, 'opencode-go');
        return true;
      },
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /valid ok/);
  for (const name of ['empty', 'oversize', 'invalid-utf8', 'control', 'leading-space', 'trailing-space']) {
    assert.match(result.stdout, new RegExp(`${name} failed`));
  }
  assert.equal(hookCalls, 1);
  assert.equal(auditLines(fx.dir).at(-1).name, '*');
  assert.equal(auditLines(fx.dir).at(-1).action, 'check');
  assert.doesNotMatch(result.stdout + result.stderr, /has\ttab|valid-value| leading|trailing /);
});

test('set, remove, and check refuse in an agent pane with exit 3; list still works', async (t) => {
  const fx = fixture(t);
  fx.store().putSecret('alpha', VALUE);
  const paneEnv = { ...fx.env, HERDR_PANE_ID: 'invented-pane' };
  for (const [args, input] of [[['set', 'beta'], `${VALUE}\n`], [['remove', 'alpha'], 'alpha\n'], [['check', 'alpha'], '']]) {
    const result = await invoke(fx, args, input, { env: paneEnv });
    assert.equal(result.code, 3);
    assert.equal(result.stderr.trim(), 'Run this command at a terminal. It is not available in an agent pane.');
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(VALUE));
  }
  assert.equal(auditLines(fx.dir).length, 0, 'a refused command does not append an audit line');
  const listed = await invoke(fx, ['list'], '', { env: paneEnv });
  assert.equal(listed.code, 0);
  assert.match(listed.stdout, /alpha/);
  assert.doesNotMatch(listed.stdout, new RegExp(VALUE));
});

test('an agent-pane refusal creates no secrets directory and reads no key', async (t) => {
  const fx = fixture(t);
  const result = await invoke(fx, ['set', 'alpha'], `${VALUE}\n`, { env: { ...fx.env, HERDR_ENV: '1' } });
  assert.equal(result.code, 3);
  assert.equal(fs.existsSync(fx.dir), false);
  assert.deepEqual(fx.keyCalls, []);
  assert.deepEqual(auditLines(fx.dir), []);
});

test('metadata flags reject invalid provider slugs and non-ISO expiry values', async (t) => {
  const fx = fixture(t);
  const badProvider = await invoke(fx, ['set', 'alpha', '--provider', 'OpenCode Go'], `${VALUE}\n`);
  assert.equal(badProvider.code, 1);
  assert.doesNotMatch(badProvider.stdout + badProvider.stderr, new RegExp(VALUE));
  const badExpiry = await invoke(fx, ['set', 'beta', '--expires', 'soon'], `${VALUE}\n`);
  assert.equal(badExpiry.code, 1);
  assert.doesNotMatch(badExpiry.stdout + badExpiry.stderr, new RegExp(VALUE));
  const invalidDate = await invoke(fx, ['set', 'gamma', '--expires', '2026-02-30T00:00:00.000Z'], `${VALUE}\n`);
  assert.equal(invalidDate.code, 1);
  assert.doesNotMatch(invalidDate.stdout + invalidDate.stderr, new RegExp(VALUE));
  assert.equal(fs.existsSync(path.join(fx.dir, 'index.json')), false);
});

test('the CLI dispatches the secret command before loading the general service config', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'cli.js'), 'utf8');
  assert.match(source, /if \(cmd === 'secret'\)[\s\S]{0,260}secretCommand/);
});
