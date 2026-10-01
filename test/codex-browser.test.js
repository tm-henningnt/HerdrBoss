import './helpers/test-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { codexBrowserArgs } from '../src/harness.js';

test('Codex requests a stopped project browser and uses the returned lease port', async () => {
  const { resolveCodexBrowser } = await import('../src/codex-browser.js');
  const calls = [];
  const session = { project: 'example-app', port: 9241 };
  const browser = await resolveCodexBrowser('example-app', {
    listSessions: () => ({ 'example-app': session }),
    status: async (record) => { assert.equal(record, session); calls.push('status'); return { ...record, profileVerified: false, responsive: false }; },
    request: async (project) => { calls.push(project); return { port: 9247, profileVerified: true, responsive: true }; },
  });
  assert.deepEqual(calls, ['status', 'example-app']);
  assert.deepEqual(codexBrowserArgs('codex', 'example-app', { lookup: () => browser }), [
    '-c', 'mcp_servers.chrome-devtools.args=["chrome-devtools-mcp@latest","--browserUrl=http://127.0.0.1:9247"]',
  ]);
});

test('Codex uses a verified running browser without a second request', async () => {
  const { resolveCodexBrowser } = await import('../src/codex-browser.js');
  const browser = await resolveCodexBrowser('example-app', {
    listSessions: () => ({ 'example-app': { port: 9247 } }),
    status: async (session) => ({ ...session, profileVerified: true, responsive: true }),
    request: () => { assert.fail('a running browser needs no request'); },
  });
  assert.deepEqual(browser, { port: 9247 });
});

test('a failed project browser request disables DevTools with one fixed line', async () => {
  const { resolveCodexBrowser } = await import('../src/codex-browser.js');
  let failure;
  try {
    await resolveCodexBrowser('example-app', {
      listSessions: () => ({ 'example-app': { port: 9241 } }),
      status: async () => ({ profileVerified: false, responsive: false }),
      request: () => { throw new Error('private fixture error'); },
    });
  } catch (error) { failure = error; }
  assert.equal(failure?.message, 'private fixture error');
  const lines = [];
  assert.deepEqual(codexBrowserArgs('codex', 'example-app', { lookup: () => { throw failure; }, output: (line) => lines.push(line) }),
    ['-c', 'mcp_servers.chrome-devtools.enabled=false']);
  assert.deepEqual(lines, ['Codex: no project browser is available. Chrome DevTools MCP is disabled for this launch.']);
});

test('a project with no browser entry gets no browser request and disables DevTools', async () => {
  const { resolveCodexBrowser } = await import('../src/codex-browser.js');
  const browser = await resolveCodexBrowser('example-app', {
    listSessions: () => ({ other: { port: 9247 } }),
    status: () => { assert.fail('no entry needs no status check'); },
    request: () => { assert.fail('no entry must not allocate a browser'); },
  });
  const lines = [];
  assert.equal(browser, null);
  assert.deepEqual(codexBrowserArgs('codex', 'example-app', { lookup: () => browser, output: (line) => lines.push(line) }),
    ['-c', 'mcp_servers.chrome-devtools.enabled=false']);
  assert.equal(lines.length, 1);
});

test('a browser that is not verified or responsive cannot supply a DevTools address', async () => {
  const { resolveCodexBrowser } = await import('../src/codex-browser.js');
  for (const state of [{ profileVerified: false, responsive: true }, { profileVerified: true, responsive: false }]) {
    assert.equal(await resolveCodexBrowser('example-app', {
      listSessions: () => ({ 'example-app': { port: 9241 } }),
      status: async () => ({ port: 9241, ...state }),
      request: async () => ({ port: 9247, ...state }),
    }), null);
  }
});

test('a dry run checks the recorded browser without requesting a stopped browser', async () => {
  const { resolveCodexBrowser } = await import('../src/codex-browser.js');
  assert.equal(await resolveCodexBrowser('example-app', {
    listSessions: () => ({ 'example-app': { port: 9241 } }),
    status: async () => ({ profileVerified: false, responsive: false }),
    request: () => { assert.fail('a dry run must not start a browser'); },
    launch: false,
  }), null);
});

test('non-Codex kinds do not look up a browser or override any MCP server', () => {
  for (const kind of ['claude', 'opencode', 'pi']) {
    assert.deepEqual(codexBrowserArgs(kind, 'example-app', {
      lookup: () => { assert.fail('only Codex looks up a browser'); },
      output: () => { assert.fail('only Codex prints a fallback line'); },
    }), []);
  }
});

test('an invalid browser port disables DevTools', () => {
  for (const port of [undefined, 0, -1, 65536, 9247.5, '9247', '9247"unsafe']) {
    assert.deepEqual(codexBrowserArgs('codex', 'example-app', { lookup: () => ({ port }), output: () => {} }),
      ['-c', 'mcp_servers.chrome-devtools.enabled=false']);
  }
});

test('a Codex successor uses the same project browser override and other kinds get none', async () => {
  const { successorAgentArgs } = await import('../src/handoff.js');
  const calls = [];
  const item = { toKind: 'codex', project: 'example-app', newPane: 'ws:p2', newTab: 'ws:t1', workspace: 'ws' };
  const options = { browserLookup: (project) => { calls.push(project); return { port: 9247 }; } };
  const args = successorAgentArgs(item, ['-s', 'workspace-write'], {}, options);
  assert.ok(args.includes('mcp_servers.chrome-devtools.args=["chrome-devtools-mcp@latest","--browserUrl=http://127.0.0.1:9247"]'));
  assert.deepEqual(calls, ['example-app']);
  for (const toKind of ['claude', 'opencode', 'pi']) {
    assert.deepEqual(successorAgentArgs({ ...item, toKind }, ['native'], {}, options), ['native']);
  }
  assert.deepEqual(calls, ['example-app']);
});
