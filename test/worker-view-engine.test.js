import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-worker-view-engine-'));
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));
for (const [name, dir] of [['HOME', 'home'], ['HERDR_BOSS_DIR', 'data'], ['HERDR_BOSS_LIVE_DIR', 'live']]) {
  process.env[name] = path.join(ROOT, dir);
  fs.mkdirSync(process.env[name], { recursive: true });
}
process.env.HERDR_BOSS_ALLOW_ACTIONS = '1';
await import('./helpers/test-env.js');
const { temporaryRepo } = await import('./helpers/kit-fixture.js');
const { loadProjectConfig } = await import('../src/kit/config.js');
const { Engine } = await import('../src/engine.js');
const { loadConfig } = await import('../src/config.js');
const { serve } = await import('../src/server.js');
const { briefCopy } = await import('../src/worker-view.js');

const FAKE_SECRET = 'sk-FAKESECRET1234567890abcdef';

function setup() {
  const repo = temporaryRepo('herdr-wv-engine-');
  fs.writeFileSync(path.join(process.env.HERDR_BOSS_DIR, 'project-repos.json'), JSON.stringify([{ slug: 'alpha', repo, remote: '' }]));
  const config = loadProjectConfig({ cwd: repo });
  fs.mkdirSync(config.runsPath, { recursive: true });
  const worktree = path.join(repo, 'wt');
  fs.mkdirSync(path.join(worktree, '.worker'), { recursive: true });
  fs.writeFileSync(path.join(worktree, '.worker', 'brief.md'), `# Live\nSecret ${FAKE_SECRET}\n`);
  const now = Date.now();
  fs.writeFileSync(path.join(config.runsPath, 'wk1.json'), JSON.stringify({
    name: 'wk1', kind: 'claude', model: 'm', pane: 'w1:p2', taskId: 'T1', worktree, branch: 'wk1', workerDir: '.worker',
    allowedPaths: ['src'], startedAt: new Date(now - 600000).toISOString(), title: 'T1 Build the table',
    briefCopy: briefCopy('# T1 Build the table\nScope: src\n', now - 600000),
  }));
  return { repo, config, now };
}

const herdrSnapshot = {
  workspaces: [{ id: 'w1', label: 'alpha' }],
  panes: [
    { id: 'w1:p1', workspace: 'w1', agent: 'claude', orch: true, label: 'orch', status: 'idle' },
    { id: 'w1:p2', workspace: 'w1', agent: 'claude', name: 'wk1', orch: false, label: null, status: 'working' },
  ],
};

function makeEngine(reads) {
  const engine = new Engine(loadConfig(), {
    push: false, act: true,
    herdrRunner: async (_cmd, args) => { reads.push(args); return `● Bash(curl -H "Authorization: Bearer ${FAKE_SECRET}" http://127.0.0.1/x)\n`; },
  });
  engine.log = () => {};
  engine.memory = { paneSince: {}, pushes: {}, notified: {} };
  return engine;
}

test('the engine reads each working worker pane in the background at most every 30 seconds', async () => {
  const { now } = setup();
  const reads = [];
  const engine = makeEngine(reads);
  engine.refreshPaneActions(now, herdrSnapshot);
  await engine.paneActionRead;
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0].slice(0, 3), ['pane', 'read', 'w1:p2']);
  engine.refreshPaneActions(now + 10000, herdrSnapshot);
  await engine.paneActionRead;
  assert.equal(reads.length, 1, 'no second read inside 30 seconds');
  engine.refreshPaneActions(now + 31000, herdrSnapshot);
  await engine.paneActionRead;
  assert.equal(reads.length, 2);
  engine.refreshPaneActions(now + 62000, { ...herdrSnapshot, panes: [] });
  assert.equal(engine.paneActions.size, 0, 'a closed pane leaves the cache');
});

test('the worker view holds the title and the action line, never the secret or the brief text', async () => {
  const { now } = setup();
  const engine = makeEngine([]);
  engine.refreshPaneActions(now, herdrSnapshot);
  await engine.paneActionRead;
  const view = engine.readWorkerView(now, herdrSnapshot);
  assert.equal(view.rows.length, 1);
  const [row] = view.rows;
  assert.equal(row.title, 'T1 Build the table');
  assert.equal(row.state, 'working');
  assert.match(row.now, /^Running curl/);
  const text = JSON.stringify(view);
  assert.doesNotMatch(text, /FAKESECRET/);
  assert.doesNotMatch(text, /Scope: src/);
});

test('readWorkerBrief and GET /api/worker-brief serve the masked brief and refuse bad names', async (t) => {
  const { config } = setup();
  const engine = makeEngine([]);
  assert.equal(engine.readWorkerBrief('alpha', '../etc/passwd'), null);
  assert.equal(engine.readWorkerBrief('missing', 'wk1'), null);
  const brief = engine.readWorkerBrief('alpha', 'wk1');
  assert.equal(brief.source, 'copy');
  assert.match(brief.text, /Scope: src/);
  assert.deepEqual(brief.scope, ['src']);
  assert.equal(brief.reportPath, '.worker/report.md');
  // A record without a copy reads the worktree file and masks it.
  const file = path.join(config.runsPath, 'wk1.json');
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete record.briefCopy;
  fs.writeFileSync(file, JSON.stringify(record));
  const live = engine.readWorkerBrief('alpha', 'wk1');
  assert.equal(live.source, 'worktree');
  assert.doesNotMatch(JSON.stringify(live), /FAKESECRET/);

  const cfg = loadConfig();
  cfg.host = '127.0.0.1'; cfg.port = 0; cfg.tickSeconds = 3600;
  engine.tick = async () => engine.state;
  const { server, close } = serve(cfg, { readOnlyPreview: true, createEngine: () => engine });
  t.after(() => close());
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const ok = await fetch(`${base}/api/worker-brief?project=alpha&name=wk1`);
  assert.equal(ok.status, 200);
  assert.doesNotMatch(await ok.text(), /FAKESECRET/);
  assert.equal((await fetch(`${base}/api/worker-brief?project=alpha&name=nope`)).status, 404);
  assert.equal((await fetch(`${base}/api/worker-brief?project=alpha&name=..%2Fx`)).status, 404);
});
