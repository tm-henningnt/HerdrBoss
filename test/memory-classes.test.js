import './helpers/test-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendMemorySample, classifyCommand, readMemorySamples, sampleMemory,
  MEMORY_CLASSES, MEMORY_SAMPLES_FILE, MEMORY_SAMPLES_MAX_BYTES, MEMORY_SAMPLES_ROTATED_FILE,
  MEMORY_SAMPLE_INTERVAL_MS,
} from '../src/memory-classes.js';

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-memory-classes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('the classes are claude, codex, browsers, mcp, vitest, and other', () => {
  assert.deepEqual(MEMORY_CLASSES, ['claude', 'codex', 'browsers', 'mcp', 'vitest', 'other']);
  assert.equal(MEMORY_SAMPLE_INTERVAL_MS, 300000);
  assert.equal(MEMORY_SAMPLES_MAX_BYTES, 3 * 1024 * 1024);
  assert.equal(MEMORY_SAMPLES_FILE, 'memory-samples.jsonl');
  assert.equal(MEMORY_SAMPLES_ROTATED_FILE, 'memory-samples.1.jsonl');
});

test('classifyCommand puts each invented command in its class', () => {
  const table = {
    '/tmp/herdr-fake/bin/claude --permission-mode acceptEdits': 'claude',
    '/tmp/herdr-fake/bin/claude-code --version': 'claude',
    'node /tmp/herdr-fake/@anthropic-ai/claude-code/cli.js': 'claude',
    '/tmp/herdr-fake/bin/codex exec --sandbox workspace-write': 'codex',
    'node /tmp/herdr-fake/@openai/codex/bin/codex.js': 'codex',
    '/tmp/herdr-fake/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --remote-debugging-port=0': 'browsers',
    '/tmp/herdr-fake/Google Chrome Helper (Renderer) --type=renderer': 'browsers',
    '/usr/bin/chromium --headless=new': 'browsers',
    'chrome-headless-shell --remote-debugging-port=9222': 'browsers',
    'node /tmp/herdr-fake/chrome-devtools-mcp/build/src/index.js': 'mcp',
    '/tmp/herdr-fake/bin/node_repl': 'mcp',
    '/tmp/herdr-fake/bin/cua_repl --headless': 'mcp',
    'node /tmp/herdr-fake/node_modules/mcp-server-postgres/index.js': 'mcp',
    '/tmp/herdr-fake/node_modules/.bin/vitest run': 'vitest',
    'node /tmp/herdr-fake/node_modules/vitest/dist/chunks/worker.js': 'vitest',
    '/usr/libexec/sshd -i': 'other',
    '-zsh': 'other',
    '': 'other',
  };
  for (const [command, expected] of Object.entries(table)) assert.equal(classifyCommand(command), expected, command);
});

test('classifyCommand matches claude and codex on the program, not on an argument or a folder name', () => {
  const table = {
    'claude --mcp-config /tmp/herdr-fake/mcp.json --print': 'claude',
    'claude -p fix the tests': 'claude',
    '/tmp/herdr-fake/bin/codex --config /tmp/herdr-fake/codex-x/config.toml': 'codex',
    'node /tmp/herdr-fake/repos/claude-x/bin/run.js': 'other',
    'node /tmp/herdr-fake/repos/codex-tools/bin/server.js': 'other',
    '/tmp/herdr-fake/repos/claude-x/node_modules/.bin/claude-tidy': 'other',
    'node /tmp/herdr-fake/@anthropic-ai/claude-code/cli.js --mcp-config /tmp/herdr-fake/mcp.json': 'claude',
  };
  for (const [command, expected] of Object.entries(table)) assert.equal(classifyCommand(command), expected, command);
});

test('classifyCommand counts a process as mcp only when the command names a server', () => {
  const table = {
    'claude --mcp-config /tmp/herdr-fake/mcp.json': 'claude',
    '/tmp/herdr-fake/bin/node --mcp-config /tmp/herdr-fake/mcp.json': 'other',
    'node /tmp/herdr-fake/node_modules/@modelcontextprotocol/sdk/dist/server.js': 'other',
    '/tmp/herdr-fake/bin/mcp-server-filesystem /tmp/herdr-fake/socket': 'mcp',
    'npx -y chrome-devtools-mcp@latest': 'mcp',
    '/tmp/herdr-fake/bin/computer-use-mcp --stdio': 'mcp',
  };
  for (const [command, expected] of Object.entries(table)) assert.equal(classifyCommand(command), expected, command);
});

test('classifyCommand counts a process as vitest only when node or vitest runs vitest', () => {
  const table = {
    'node /tmp/herdr-fake/node_modules/vitest/vitest.mjs run': 'vitest',
    '/tmp/herdr-fake/node_modules/vitest/vitest.mjs watch': 'vitest',
    'node /tmp/herdr-fake/node_modules/vitest/dist/chunks/worker.js': 'vitest',
    '/opt/herdr-fake/vitest/daemon': 'other',
    'node /tmp/herdr-fake/repos/vitest-tools/bench.js': 'other',
    '/tmp/herdr-fake/bin/vitest-lint /tmp/herdr-fake/repo': 'other',
  };
  for (const [command, expected] of Object.entries(table)) assert.equal(classifyCommand(command), expected, command);
});

test('classifyCommand takes the tool over the parent directory in the path', () => {
  assert.equal(classifyCommand('node /tmp/herdr-fake/vitest/node_modules/mcp-server-x/index.js'), 'mcp');
  assert.equal(classifyCommand('node /tmp/herdr-fake/codex-mcp/node_modules/mcp-server-x/index.js'), 'mcp');
  assert.equal(classifyCommand('node /tmp/herdr-fake/claude/node_modules/mcp-server-x/index.js'), 'mcp');
});

test('classifyCommand is safe for a missing or non-string command', () => {
  for (const bad of [null, undefined, 42, {}]) assert.equal(classifyCommand(bad), 'other', String(bad));
});

test('sampleMemory sums RSS per class in MB and holds every class', () => {
  const now = Date.parse('2026-09-29T14:07:31.000Z');
  const ps = [
    '  1024 /tmp/herdr-fake/bin/claude --print',
    ' 2048 /tmp/herdr-fake/@anthropic-ai/claude-code/cli.js',
    ' 4096 /tmp/herdr-fake/chrome-devtools-mcp/build/src/index.js',
    ' 8192 /usr/libexec/sshd -i',
    '  512 node /tmp/herdr-fake/node_modules/vitest/dist/worker.js',
    'a line without a size',
    '  not-a-number /tmp/herdr-fake/bin/claude',
    '',
  ].join('\n');
  const line = sampleMemory(ps, now);
  assert.deepEqual(line, {
    at: '2026-09-29T14:05:00.000Z',
    mb: { claude: 3, codex: 0, browsers: 0, mcp: 4, vitest: 0.5, other: 8 },
  });
});

test('sampleMemory counts a process with a size and no command as other', () => {
  assert.deepEqual(sampleMemory('2048', Date.parse('2026-09-29T14:05:00Z')).mb.other, 2);
});

test('sampleMemory on no lines and on empty text holds only classes and the whole 5 minutes', () => {
  const line = sampleMemory('', Date.parse('2026-09-29T14:00:00.000Z'));
  assert.deepEqual(line.mb, { claude: 0, codex: 0, browsers: 0, mcp: 0, vitest: 0, other: 0 });
  assert.deepEqual(Object.keys(line), ['at', 'mb']);
  assert.equal(sampleMemory('1024 /tmp/herdr-fake/bin/codex', Date.parse('2026-09-29T14:09:59.999Z')).at, '2026-09-29T14:05:00.000Z');
});

test('the stored line holds numbers and class names only', () => {
  const ps = [
    '  1024 /tmp/herdr-fake/priv-acme/bin/claude --resume w:pAB',
    '  2048 /tmp/herdr-fake/priv-acme/node_modules/vitest/dist/worker.js',
    '  4096 /Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --user-data-dir=/tmp/herdr-fake/priv-acme',
  ].join('\n');
  const line = sampleMemory(ps, Date.parse('2026-09-29T14:05:00Z'));
  assert.doesNotMatch(JSON.stringify(line), /herdr-fake|priv-acme|resume|w:pAB|Applications|user-data/);
  assert.deepEqual(Object.keys(line.mb), MEMORY_CLASSES);
  assert.ok(Object.values(line.mb).every((v) => typeof v === 'number'));
});

test('appendMemorySample appends one line with mode 0600 and readMemorySamples reads it back', (t) => {
  const dataDir = tmp(t);
  const first = sampleMemory('1024 /tmp/herdr-fake/bin/claude', Date.parse('2026-09-29T14:03:00Z'));
  const second = sampleMemory('2048 /tmp/herdr-fake/bin/codex', Date.parse('2026-09-29T14:08:00Z'));
  assert.equal(appendMemorySample(first, { dataDir }), true);
  assert.equal(appendMemorySample(second, { dataDir }), true);
  const file = path.join(dataDir, MEMORY_SAMPLES_FILE);
  assert.equal(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 2);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readMemorySamples({ dataDir }).map((row) => row.at), [first.at, second.at]);
  assert.equal(readMemorySamples({ dataDir, sinceMs: Date.parse('2026-09-29T14:05:00Z') }).length, 1);
});

test('appendMemorySample rotates above the size limit and replaces an older rotated file', (t) => {
  const dataDir = tmp(t);
  const rotated = path.join(dataDir, MEMORY_SAMPLES_ROTATED_FILE);
  fs.writeFileSync(rotated, '{"at":"2020-01-01T00:00:00.000Z"}\n');
  fs.writeFileSync(path.join(dataDir, MEMORY_SAMPLES_FILE), `${'x'.repeat(200)}\n`);
  appendMemorySample(sampleMemory('1024 /tmp/herdr-fake/bin/claude', Date.parse('2026-09-29T14:03:00Z')), { dataDir, maxBytes: 100 });
  assert.match(fs.readFileSync(rotated, 'utf8'), /^x{200}\n$/);
  const current = fs.readFileSync(path.join(dataDir, MEMORY_SAMPLES_FILE), 'utf8');
  assert.equal(current.split('\n').filter(Boolean).length, 1);
  assert.match(current, /2026-09-29T14:00:00/);
});

test('appendMemorySample does not rotate below the size limit', (t) => {
  const dataDir = tmp(t);
  appendMemorySample(sampleMemory('1024 /tmp/herdr-fake/bin/claude', Date.parse('2026-09-29T14:00:00Z')), { dataDir });
  appendMemorySample(sampleMemory('1024 /tmp/herdr-fake/bin/claude', Date.parse('2026-09-29T14:05:00Z')), { dataDir });
  assert.equal(fs.existsSync(path.join(dataDir, MEMORY_SAMPLES_ROTATED_FILE)), false);
});

test('appendMemorySample swallows a write error', (t) => {
  const dataDir = tmp(t);
  fs.mkdirSync(path.join(dataDir, MEMORY_SAMPLES_FILE));
  const line = sampleMemory('1024 /tmp/herdr-fake/bin/claude', Date.parse('2026-09-29T14:00:00Z'));
  assert.doesNotThrow(() => assert.equal(appendMemorySample(line, { dataDir }), false));
  const blocker = path.join(dataDir, 'file');
  fs.writeFileSync(blocker, '');
  assert.doesNotThrow(() => assert.equal(appendMemorySample(line, { dataDir: path.join(blocker, 'sub') }), false));
});

test('readMemorySamples skips a broken line, a line without a valid time, and an unusable class map', (t) => {
  const dataDir = tmp(t);
  assert.deepEqual(readMemorySamples({ dataDir }), []);
  const good = sampleMemory('1024 /tmp/herdr-fake/bin/claude', Date.parse('2026-09-29T14:03:00Z'));
  const later = sampleMemory('2048 /tmp/herdr-fake/bin/codex', Date.parse('2026-09-29T14:08:00Z'));
  fs.writeFileSync(path.join(dataDir, MEMORY_SAMPLES_FILE), [
    JSON.stringify(good), 'not json', JSON.stringify({ mb: good.mb }), '{"at":"nope"}', 'null',
    '{"at":"2026-09-29T14:04:00.000Z"}', '{"at":"2026-09-29T14:05:00.000Z","mb":{"claude":"many"}}',
    '{"at":"2026-09-29T14:06:00.000Z","mb":{"private-client":5}}', JSON.stringify(later), '',
  ].join('\n'));
  const all = readMemorySamples({ dataDir });
  assert.deepEqual(all.map((row) => row.at), [good.at, later.at]);
  assert.equal(all[0].mb.claude, 1);
  assert.deepEqual(all[1].mb, later.mb);
});