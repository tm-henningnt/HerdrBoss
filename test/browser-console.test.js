import './helpers/test-env.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseConsoleOptions } from '../src/browser-console.js';
import { browserConsole } from '../src/browser-preview.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function logEntry({ level = 'log', text = 'message', url = 'https://tenant.example.test/app.js', lineNumber = 1, timestamp = 1_700_000_000 } = {}) {
  return {
    method: 'Log.entryAdded',
    params: { entry: { source: 'console-api', level, text, url, lineNumber, timestamp } },
  };
}

function fakeConnection(events = [], { fail = null } = {}) {
  const requests = [];
  class FakeWebSocket {
    constructor() {
      if (fail) throw new Error(fail);
      this.listeners = new Map();
      queueMicrotask(() => this.emit('open'));
    }

    addEventListener(name, listener) {
      const listeners = this.listeners.get(name) || [];
      listeners.push(listener);
      this.listeners.set(name, listeners);
    }

    emit(name, value = {}) {
      for (const listener of this.listeners.get(name) || []) listener(value);
    }

    send(value) {
      const request = JSON.parse(value);
      requests.push(request);
      queueMicrotask(() => {
        const eventMethod = request.method === 'Runtime.enable' ? 'Runtime.consoleAPICalled' : 'Log.entryAdded';
        for (const event of events) if (event.method === eventMethod) this.emit('message', { data: JSON.stringify(event) });
        this.emit('message', { data: JSON.stringify({ id: request.id, result: {} }) });
      });
    }

    close() {}
  }
  return { WebSocket: FakeWebSocket, requests };
}

function adaptersFor(tabId, connection) {
  return {
    verifySession: async () => ({ port: 9222 }),
    listTargets: async () => [{ id: tabId, type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${tabId}` }],
    listViewports: () => ({}),
    WebSocket: connection.WebSocket,
  };
}

test('parseConsoleOptions applies defaults and accepts repeated levels', () => {
  assert.deepEqual(parseConsoleOptions([]), {
    tab: null,
    levels: ['error', 'warn', 'info', 'log', 'debug'],
    last: 20,
    waitMs: 1000,
    json: false,
  });
  assert.deepEqual(parseConsoleOptions(['--level', 'error', '--level', 'warn', '--last', '3', '--wait-ms', '0', '--json']), {
    tab: null,
    levels: ['error', 'warn'],
    last: 3,
    waitMs: 0,
    json: true,
  });
  assert.deepEqual(parseConsoleOptions(['--last', '100', '--wait-ms', '10000']), {
    tab: null,
    levels: ['error', 'warn', 'info', 'log', 'debug'],
    last: 100,
    waitMs: 10000,
    json: false,
  });
});

test('parseConsoleOptions enforces level, last, and wait bounds', () => {
  assert.throws(() => parseConsoleOptions(['--level', 'trace']), /Use --level error\|warn\|info\|log\|debug/);
  assert.throws(() => parseConsoleOptions(['--last', '0']), /--last must be from 1 to 100/);
  assert.throws(() => parseConsoleOptions(['--last', '101']), /--last must be from 1 to 100/);
  assert.throws(() => parseConsoleOptions(['--wait-ms', '-1']), /--wait-ms must be from 0 to 10000/);
  assert.throws(() => parseConsoleOptions(['--wait-ms', '10001']), /--wait-ms must be from 0 to 10000/);
});

test('browserConsole enables Runtime and Log, filters levels, and returns the last N messages', async () => {
  const connection = fakeConnection([
    logEntry({ level: 'warning', text: 'first warning' }),
    logEntry({ level: 'error', text: 'first error' }),
    logEntry({ level: 'log', text: 'plain log' }),
    logEntry({ level: 'error', text: 'last error', lineNumber: 7 }),
  ]);
  const result = await browserConsole('alpha', 'tab-1', { levels: ['error'], last: 1, waitMs: 0 }, adaptersFor('tab-1', connection));

  assert.deepEqual(connection.requests.map(({ method }) => method).sort(), ['Log.enable', 'Runtime.enable']);
  assert.deepEqual(result.map(({ level, timestamp, text, source }) => ({ level, timestamp, text, source })), [
    { level: 'error', timestamp: '2023-11-14T22:13:20.000Z', text: 'last error', source: '/app.js:8' },
  ]);
});

test('browserConsole masks bearer values and URL queries and caps message text', async () => {
  const longText = `Bearer fake-bearer-value https://tenant.example.test/page?access_token=fake-query-value ${'x'.repeat(700)}`;
  const connection = fakeConnection([logEntry({ level: 'error', text: longText, url: 'https://tenant.example.test/assets/app.js?key=fake-source-value', lineNumber: 7 })]);
  const result = await browserConsole('alpha', 'tab-1', { levels: ['error'], last: 20, waitMs: 0 }, adaptersFor('tab-1', connection));

  assert.equal(result.length, 1);
  assert.match(result[0].text, /Bearer <redacted>/);
  assert.match(result[0].text, /https:\/\/<tenant>\.example\.test\/page/);
  assert.ok(result[0].text.length <= 500);
  assert.equal(result[0].source, '/assets/app.js:8');
  assert.ok(!result[0].text.includes('fake-bearer-value'));
  assert.ok(!result[0].text.includes('fake-query-value'));
  assert.ok(!result[0].source.includes('fake-source-value'));
});

test('browserConsole masks credentials and long opaque strings in text and source paths', async () => {
  const hex = '0123456789abcdef'.repeat(3);
  const base64 = 'AbC123_-'.repeat(7);
  const text = [
    'Cookie: sid=abc123def456; theme=dark',
    'Set-Cookie: session=one; HttpOnly',
    'Authorization: Basic dXNlcjpwYXNz',
    'password=hunter2 secret: foo',
    '{"credential": "private"}',
    hex,
    base64,
    'plain words 42',
  ].join('\n');
  const connection = fakeConnection([logEntry({ text, url: '/tok_ABCDEFGH0123456789ABCDEFGH0123/f.js' })]);
  const result = await browserConsole('alpha', 'tab-1', { levels: ['log'], last: 20, waitMs: 0 }, adaptersFor('tab-1', connection));

  assert.equal(result.length, 1);
  assert.equal(/Cookie: \[masked\]/.test(result[0].text), true);
  assert.equal(/Set-Cookie: \[masked\]/.test(result[0].text), true);
  assert.equal(/Authorization: \[masked\]/.test(result[0].text), true);
  assert.equal(/password=\[masked\] secret: \[masked\]/.test(result[0].text), true);
  assert.equal(/"credential": \[masked\]/.test(result[0].text), true);
  assert.equal(/plain words 42/.test(result[0].text), true);
  for (const sensitiveValue of ['abc123def456', 'one', 'dXNlcjpwYXNz', 'hunter2', 'foo', 'private', hex, base64]) {
    assert.equal(result[0].text.includes(sensitiveValue), false);
  }
  assert.ok(result[0].source === '/[masked]/f.js:2', 'source path should mask opaque text and keep the file name and line number');
});

test('browserConsole prints primitive arguments and only the first stack frame', async () => {
  const connection = fakeConnection([{
    method: 'Runtime.consoleAPICalled',
    params: {
      type: 'error',
      args: [
        { type: 'string', value: 'request failed' },
        { type: 'object', description: 'Object with a hidden value' },
      ],
      timestamp: 1_700_000_000,
      stackTrace: { callFrames: [
        { url: 'https://tenant.example.test/assets/app.js?key=hidden', lineNumber: 3 },
        { url: 'https://other.example.test/private.js', lineNumber: 99 },
      ] },
    },
  }]);
  const result = await browserConsole('alpha', 'tab-1', { levels: ['error'], last: 20, waitMs: 0 }, adaptersFor('tab-1', connection));

  assert.equal(result[0].text, 'request failed [object]');
  assert.equal(result[0].source, '/assets/app.js:4');
  assert.ok(!result[0].source.includes('other.example.test'));
  assert.ok(!result[0].source.includes('hidden'));
});

test('browserConsole removes cross-domain duplicates but keeps repeated messages', async () => {
  const runtimeMessage = {
    method: 'Runtime.consoleAPICalled',
    params: { type: 'log', args: [{ type: 'string', value: 'same message' }], timestamp: 1_700_000_000,
      stackTrace: { callFrames: [{ url: 'https://tenant.example.test/app.js', lineNumber: 1 }] } },
  };
  const connection = fakeConnection([
    runtimeMessage,
    runtimeMessage,
    logEntry({ text: 'same message', timestamp: 1_700_000_000, lineNumber: 1 }),
    logEntry({ text: 'same message', timestamp: 1_700_000_000, lineNumber: 1 }),
  ]);
  const result = await browserConsole('alpha', 'tab-1', { levels: ['log'], last: 20, waitMs: 0 }, adaptersFor('tab-1', connection));

  assert.equal(result.length, 2);
  assert.deepEqual(result.map(({ text }) => text), ['same message', 'same message']);
});

test('CLI usage lists the browser console form', () => {
  const result = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /browser console SLUG \[--tab ID\] \[--level error\|warn\|info\|log\|debug \.\.\.\] \[--last N\] \[--wait-ms N\] \[--json\]/);
});

test('browserConsole returns an empty list when no messages are buffered', async () => {
  const connection = fakeConnection();
  assert.deepEqual(await browserConsole('alpha', 'tab-1', { levels: ['error'], last: 20, waitMs: 0 }, adaptersFor('tab-1', connection)), []);
});

test('browserConsole refuses a tab that is not in the project session', async () => {
  const connection = fakeConnection();
  await assert.rejects(browserConsole('alpha', 'foreign-tab', { levels: ['error'], last: 20, waitMs: 0 }, adaptersFor('tab-1', connection)), /selected tab is no longer open/);
  assert.deepEqual(connection.requests, []);
});

test('browserConsole hides raw connection failure text', async () => {
  const connection = fakeConnection([], { fail: 'https://private.example/path?access_token=do-not-print' });
  await assert.rejects(browserConsole('alpha', 'tab-1', { levels: ['error'], last: 20, waitMs: 0 }, adaptersFor('tab-1', connection)), (error) => {
    assert.equal(error.message, 'Could not connect to the browser page.');
    assert.ok(!error.message.includes('private.example'));
    assert.ok(!error.message.includes('do-not-print'));
    return true;
  });
});

test('browserConsole hides target-list failures after one ownership check', async () => {
  let ownershipChecks = 0;
  const adapters = {
    ...adaptersFor('tab-1', fakeConnection()),
    verifySession: async () => {
      ownershipChecks += 1;
      return { port: 9222 };
    },
    listTargets: async () => { throw new Error('target fetch failed'); },
  };

  await assert.rejects(
    browserConsole('alpha', 'tab-1', { levels: ['error'], last: 20, waitMs: 0 }, adapters),
    { message: 'Could not connect to the browser page.' },
  );
  assert.equal(ownershipChecks, 1);
});
