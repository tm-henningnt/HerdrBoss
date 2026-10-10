import './helpers/test-env.js';
import './helpers/isolated-test-data.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

process.env.HERDR_BOSS_LIVE_DIR = path.join(process.env.HERDR_BOSS_DIR, 'separate-live');
const { serve } = await import('../src/server.js');
const { loadConfig, DATA_DIR } = await import('../src/config.js');
const headers = { 'x-herdr-env': '1', 'x-herdr-pane-id': 'ws:orch', 'x-herdr-workspace-id': 'ws' };
const table = ' 1 0 S Sat Oct 10 09:00:00 2026 /sbin/launchd\n 500 1 S Sat Oct 10 09:01:00 2026 /bin/zsh\n 501 500 S Sat Oct 10 10:00:00 2026 /usr/bin/node\n';

async function start(t, options = {}) {
  const cfg = loadConfig();
  cfg.host = '127.0.0.1'; cfg.port = 0; cfg.tickSeconds = 3600;
  const calls = [];
  const app = serve(cfg, {
    liveDataDir: DATA_DIR,
    processFacts: { roots: () => [DATA_DIR],
      herdr: (args) => { calls.push(args); return { pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } }; },
      runner: (command, args, probeOptions) => {
        assert.ok(probeOptions.timeout > 0 && probeOptions.timeout <= 2000);
        assert.doesNotMatch(args.join(' '), /command=|args=/);
        return { status: 0, stdout: command === 'ps' ? table : `p501\ncnode\nn${DATA_DIR}\n`,
          stderr: 'PRIVATE_SENTINEL' };
      },
    },
    createEngine: () => {
      const engine = new EventEmitter();
      engine.state = { control: { projects: {} }, herdr: { panes: [] } };
      engine.tick = async () => engine.state; engine.log = () => {};
      return engine;
    }, ...options,
  });
  t.after(app.close);
  if (!app.server.listening) await once(app.server, 'listening');
  return { port: app.server.address().port, base: `http://127.0.0.1:${app.server.address().port}`, calls };
}

test('HTTP process facts routes are read-only, caller checked and names only', async (t) => {
  const { base, calls } = await start(t);
  for (const route of ['info?pid=501', 'port?port=9223', `cwd?path=${encodeURIComponent(DATA_DIR)}`]) {
    const response = await fetch(`${base}/api/process-facts/${route}`, { headers });
    assert.equal(response.status, 200);
    const facts = await response.json();
    assert.equal(facts.known, true);
    assert.doesNotMatch(JSON.stringify(facts), /PRIVATE_SENTINEL|\/usr\/bin|environment|args|cmd/);
  }
  assert.deepEqual(calls[0], ['pane', 'get', 'ws:orch']);
  assert.equal((await fetch(`${base}/api/process-facts/info?pid=501`)).status, 403);
  assert.equal((await fetch(`${base}/api/process-facts/info?pid=501`, { headers: { ...headers, 'x-herdr-pane-id': 'ws:foreign' } })).status, 403);
  assert.equal((await fetch(`${base}/api/process-facts/cwd?path=${encodeURIComponent(path.dirname(DATA_DIR))}`, { headers })).status, 403);
  assert.equal((await fetch(`${base}/api/process-facts/info?pid=501`, { method: 'POST', headers })).status, 405);
  assert.equal((await fetch(`${base}/api/process-facts/info?pid=501`, { headers: { ...headers, origin: 'https://example.test' } })).status, 403);
});

test('the synchronous client reaches the real HTTP service from a separate CLI process', async (t) => {
  const { port } = await start(t);
  const source = `import { getProcessInfo, getPortClients, getCwdProcesses } from ${JSON.stringify(new URL('../src/process-facts.js', import.meta.url).href)};
    process.stdout.write(JSON.stringify([getProcessInfo(501), getPortClients(9223), getCwdProcesses(process.env.TEST_CWD)]));`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], {
    timeout: 10000, env: { ...process.env, HERDR_ENV: '1', HERDR_PANE_ID: 'ws:orch', HERDR_WORKSPACE_ID: 'ws',
      HERDR_BOSS_PORT: String(port), TEST_CWD: DATA_DIR, PATH: '' },
  });
  const results = JSON.parse(stdout);
  assert.ok(results.every((result) => result.known));
  assert.equal(results[0].start, 'Sat Oct 10 10:00:00 2026');
  assert.doesNotMatch(stdout, /PRIVATE_SENTINEL/);
});

test('read-only previews refuse process facts even for a verified caller', async (t) => {
  const { base } = await start(t, { readOnlyPreview: true });
  const response = await fetch(`${base}/api/process-facts/info?pid=501`, { headers });
  assert.equal(response.status, 403);
});

test('review: a connected HTTP service timeout never starts local probes', async (t) => {
  let requested;
  const received = new Promise((resolve) => { requested = resolve; });
  const server = http.createServer(() => requested());
  t.after(() => new Promise((resolve) => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const source = `import { createProcessFactsClient } from ${JSON.stringify(new URL('../src/process-facts.js', import.meta.url).href)};
    let localCalled = false;
    const client = createProcessFactsClient({runner: () => {localCalled = true; throw new Error('Local probe');}});
    process.stdout.write(JSON.stringify({result: client.processInfo(501), localCalled}));`;
  const call = promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], {
    timeout: 10000, env: { PATH: '', HERDR_BOSS_PORT: String(server.address().port) },
  });
  await received;
  const { stdout } = await call;
  const { result, localCalled } = JSON.parse(stdout);
  assert.equal(localCalled, false);
  assert.equal(result.known, false);
  assert.match(result.reason, /timed out/i);
});
