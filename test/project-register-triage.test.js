import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Engine } from '../src/engine.js';
import { createProjectRegisterTriage, decideProjectRegisterTriage } from '../src/project-register-triage.js';
import { readMessages, updateMessage } from '../src/messages.js';

const NOW = Date.parse('2026-10-09T10:00:00.000Z');

function project(slug, overrides = {}) {
  return {
    slug, title: slug, group: 'platform', clientTag: 'Example', repo: `/tmp/${slug}`,
    remote: `example/${slug}`, factory: 'factory-zero', state: 'parked', pinned: false,
    priority: 'normal', issueSource: { repo: `example/${slug}`, label: 'ready-for-agent' },
    autoOpen: 'off', lastOpenedAt: '', lastActivityAt: '2026-10-08T10:00:00.000Z',
    nextAction: '', notes: '', createdAt: '2026-10-01T00:00:00.000Z', ...overrides,
  };
}

function fixture(t, projects = [project('pine-api')]) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-project-triage-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, 'project-register.json'), `${JSON.stringify({ version: 1, projects })}\n`, { mode: 0o600 });
  return { dataDir };
}

const settings = { enabled: true, label: 'ready-for-agent', pollMinutes: 30 };

test('triage reads only parked local projects and proposes the oldest highest-priority ready work', async (t) => {
  const { dataDir } = fixture(t, [
    project('open-api', { state: 'open', priority: 'high' }),
    project('pine-api', { priority: 'normal' }),
    project('maple-ui', { priority: 'high', issueSource: { repo: 'example/maple-ui', label: 'ready-for-agent' } }),
  ]);
  const calls = [];
  const watcher = createProjectRegisterTriage({
    dataDir,
    now: () => NOW,
    runGh: async (args) => {
      calls.push(args);
      return { status: 0, stdout: JSON.stringify(args[3] === 'example/maple-ui'
        ? [{ number: 8, title: 'Oldest sample issue', createdAt: '2026-10-01T00:00:00Z' }]
        : [{ number: 9, title: 'Newer sample issue', createdAt: '2026-10-02T00:00:00Z' }]), stderr: '' };
    },
  });

  const result = await watcher.poll({ settings, cap: 3, capCountsPinned: false, factory: 'factory-zero' });

  assert.equal(result.created, 1);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((args) => args.includes('--state') && args.includes('open') && args.includes('--label') && args.includes('ready-for-agent')));
  assert.ok(calls.every((args) => !args.includes('--json') || args[args.indexOf('--json') + 1] === 'number,title,createdAt'));
  const item = readMessages({ dir: dataDir }).find((record) => record.triage?.type === 'project-open');
  assert.equal(item.triage.slug, 'maple-ui');
  assert.equal(item.triage.readyCount, 1);
  assert.equal(item.action, 'approve');
  assert.match(item.text, /1 ready issue/);
});

test('triage uses a project issue label when it overrides the factory label', async (t) => {
  const { dataDir } = fixture(t, [
    project('pine-api', { issueSource: { repo: 'example/pine-api', label: 'security-review' } }),
    project('maple-ui', { issueSource: { repo: 'example/maple-ui', label: 'ready-for-agent' } }),
    project('cedar-tool', { issueSource: { repo: 'example/cedar-tool', label: '' } }),
  ]);
  const calls = [];
  const watcher = createProjectRegisterTriage({
    dataDir,
    runGh: async (args) => {
      calls.push(args);
      return { status: 0, stdout: '[]', stderr: '' };
    },
  });

  await watcher.poll({ settings, cap: 3, factory: 'factory-zero' });

  assert.deepEqual(calls.map((args) => [args[3], args[5]]), [
    ['example/pine-api', 'security-review'],
    ['example/maple-ui', 'ready-for-agent'],
    ['example/cedar-tool', 'ready-for-agent'],
  ]);
});

test('triage is off by default at the call boundary and prevents duplicate unanswered proposals', async (t) => {
  const { dataDir } = fixture(t);
  let ghCalls = 0;
  const watcher = createProjectRegisterTriage({ dataDir, now: () => NOW, runGh: async () => {
    ghCalls += 1;
    return { status: 0, stdout: '[{"number":1,"title":"Sample","createdAt":"2026-10-01T00:00:00Z"}]', stderr: '' };
  } });

  assert.equal((await watcher.poll({ settings: { enabled: false } })).created, 0);
  await watcher.poll({ settings, cap: 3, factory: 'factory-zero' });
  await watcher.poll({ settings, cap: 3, factory: 'factory-zero' });

  assert.equal(ghCalls, 1);
  assert.equal(readMessages({ dir: dataDir }).filter((record) => record.triage?.type === 'project-open').length, 1);
});

test('Mailbox Accept opens with --start and closes the typed proposal', async (t) => {
  const { dataDir } = fixture(t);
  const watcher = createProjectRegisterTriage({ dataDir, now: () => NOW, runGh: async () => ({
    status: 0, stdout: '[{"number":1,"title":"Sample","createdAt":"2026-10-01T00:00:00Z"}]', stderr: '',
  }) });
  await watcher.poll({ settings, cap: 3, factory: 'factory-zero' });
  const item = readMessages({ dir: dataDir }).find((record) => record.triage?.type === 'project-open');
  const calls = [];

  const result = await decideProjectRegisterTriage({
    dataDir, itemId: item.id, decision: 'accept', now: () => NOW,
    runLifecycle: async (...args) => { calls.push(args); return 0; },
  });

  assert.equal(result.status, 200);
  assert.deepEqual(calls, [['open', ['pine-api', '--start']]]);
  const closed = readMessages({ dir: dataDir }).find((record) => record.id === item.id);
  assert.equal(closed.closedBy, 'owner');
  assert.equal(closed.triage.decision, 'accept');
});

test('Mailbox Deny suppresses the project for 24 hours and rejects stale or forged items', async (t) => {
  const { dataDir } = fixture(t);
  const watcher = createProjectRegisterTriage({ dataDir, now: () => NOW, runGh: async () => ({
    status: 0, stdout: '[{"number":1,"title":"Sample","createdAt":"2026-10-01T00:00:00Z"}]', stderr: '',
  }) });
  await watcher.poll({ settings, cap: 3, factory: 'factory-zero' });
  const item = readMessages({ dir: dataDir }).find((record) => record.triage?.type === 'project-open');
  const denied = await decideProjectRegisterTriage({ dataDir, itemId: item.id, decision: 'deny', now: () => NOW });
  assert.equal(denied.status, 200);
  const closed = readMessages({ dir: dataDir }).find((record) => record.id === item.id);
  assert.equal(Date.parse(closed.triage.suppressedUntil), NOW + 24 * 60 * 60 * 1000);
  assert.equal((await decideProjectRegisterTriage({ dataDir, itemId: item.id, decision: 'accept', now: () => NOW })).status, 409);
});

test('per-project auto-open still uses project lifecycle with --start', async (t) => {
  const { dataDir } = fixture(t, [project('pine-api', { autoOpen: 'on' })]);
  const calls = [];
  const watcher = createProjectRegisterTriage({
    dataDir,
    now: () => NOW,
    runGh: async () => ({ status: 0, stdout: '[{"number":1,"title":"Sample","createdAt":"2026-10-01T00:00:00Z"}]', stderr: '' }),
    runLifecycle: async (...args) => { calls.push(args); return 0; },
  });

  const result = await watcher.poll({ settings, cap: 3, factory: 'factory-zero' });

  assert.equal(result.opened, 'pine-api');
  assert.deepEqual(calls, [['open', ['pine-api', '--start']]]);
  assert.equal(readMessages({ dir: dataDir }).filter((record) => record.triage?.type === 'project-open').length, 0);
});

test('GitHub sign-in failure creates one Mailbox item and waits for its answer before retrying', async (t) => {
  const { dataDir } = fixture(t);
  let ghCalls = 0;
  const watcher = createProjectRegisterTriage({ dataDir, now: () => NOW, runGh: async () => {
    ghCalls += 1;
    return { status: 1, stdout: '', stderr: 'Please run gh auth login.' };
  } });

  assert.equal((await watcher.poll({ settings, cap: 3, factory: 'factory-zero' })).skipped, 'auth-required');
  assert.equal((await watcher.poll({ settings, cap: 3, factory: 'factory-zero' })).skipped, 'auth-waiting');
  const item = readMessages({ dir: dataDir }).find((record) => record.triage?.type === 'github-auth');
  assert.match(item.text, /gh auth login/);
  assert.equal(ghCalls, 1);

  const closedAt = new Date(NOW).toISOString();
  updateMessage(item.id, { closedAt, readAt: closedAt, closedBy: 'owner' }, { dir: dataDir, now: NOW });
  await watcher.poll({ settings, cap: 3, factory: 'factory-zero' });
  assert.equal(ghCalls, 2);
});

test('Engine schedules enabled triage at its configured interval on acting ticks only', async () => {
  const calls = [];
  const engine = Object.assign(Object.create(Engine.prototype), {
    act: true,
    cfg: { register: { cap: 3, capCountsPinned: false, triage: settings } },
    projectRegisterTriageAt: null,
    projectRegisterTriageRunning: false,
    projectRegisterTriage: { poll: async (options) => { calls.push(options); } },
    log() {},
  });

  await engine.scheduleProjectRegisterTriage(NOW);
  assert.equal(engine.scheduleProjectRegisterTriage(NOW + 60_000), null);
  await engine.scheduleProjectRegisterTriage(NOW + 30 * 60 * 1000);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].cap, 3);
  assert.equal(calls[0].capCountsPinned, false);

  engine.act = false;
  engine.cfg.register.triage = { ...settings, enabled: false };
  assert.equal(engine.scheduleProjectRegisterTriage(NOW + 31 * 60 * 1000), null);
  assert.equal(calls.length, 2);
});
