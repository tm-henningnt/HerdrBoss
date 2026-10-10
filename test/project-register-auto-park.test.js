import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendMessage } from '../src/messages.js';
import { appendAudit, readRegister, writeRegister } from '../src/project-register.js';

const now = Date.parse('2026-10-10T12:00:00.000Z');
const oldActivity = '2026-10-08T11:00:00.000Z';

function record(slug, overrides = {}) {
  return {
    slug, title: slug, group: '', clientTag: '', repo: '', remote: '', factory: 'factory-zero',
    state: 'open', pinned: false, priority: 'normal', issueSource: null, autoOpen: 'off',
    lastOpenedAt: '', lastActivityAt: oldActivity, nextAction: '', notes: '', createdAt: oldActivity,
    ...overrides,
  };
}

function fixture(t, projects) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-register-auto-park-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeRegister({ version: 1, projects }, root);
  return root;
}

function audit(dataDir) {
  return fs.readFileSync(path.join(dataDir, 'project-audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

test('auto-park dry-runs park checks and audits each successful automatic park', async (t) => {
  const autoPark = await import('../src/project-register-auto-park.js');
  const dataDir = fixture(t, [record('sample-project')]);
  const calls = [];
  const output = [];

  await autoPark.runProjectRegisterAutoPark({
    dataDir, hours: 24, now,
    runLifecycle: async (action, args, { log }) => {
      calls.push([action, args]);
      if (args.includes('--dry-run')) {
        log('  workers  ok: no project worker or lead is working.');
        log('All park checks pass.');
        log('Dry run: project sample-project stays open. No prompt, lock, browser release, workspace close, register change, or audit line was written.');
      }
      return 0;
    },
    log: (line) => output.push(line),
  });

  assert.deepEqual(calls, [['park', ['sample-project', '--dry-run']], ['park', ['sample-project']]]);
  assert.ok(output.some((line) => line.includes('Dry run: project sample-project stays open.')));
  assert.deepEqual(audit(dataDir).map(({ action, by, result }) => [action, by, result]), [['auto-park', 'engine', 'done']]);
});

test('auto-park skips live, review, finished-uncollected workers and pending Mailbox items, but ignores failed and abandoned runs', async (t) => {
  const autoPark = await import('../src/project-register-auto-park.js');
  const dataDir = fixture(t, [
    record('running-project'), record('review-project'), record('finished-project'),
    record('failed-project'), record('abandoned-project'), record('mail-project'),
  ]);
  appendMessage({ thread: 'mail-project', from: 'orch', to: 'owner', kind: 'reply', action: 'approve', text: 'Approve this item?' }, { dir: dataDir, now });
  const calls = [];

  await autoPark.runProjectRegisterAutoPark({
    dataDir, hours: 24, now,
    workersByProject: {
      'running-project': [{ phase: 'live', active: true }],
      'review-project': [{ phase: 'review', branch: 'worker/review' }],
      'finished-project': [{ phase: 'finished', branch: 'worker/finished' }],
      'failed-project': [{ phase: 'failed', branch: 'worker/failed' }],
      'abandoned-project': [{ phase: 'abandoned', branch: 'worker/abandoned' }],
    },
    runLifecycle: async (_action, args) => { calls.push(args); return 0; },
  });

  assert.deepEqual(calls, [
    ['failed-project', '--dry-run'], ['failed-project'],
    ['abandoned-project', '--dry-run'], ['abandoned-project'],
  ]);
  assert.deepEqual(audit(dataDir).map(({ slug, result, failedCheck, reason }) => [slug, result, failedCheck, reason]), [
    ['running-project', 'skipped', 'workers', 'A project worker is still running.'],
    ['review-project', 'skipped', 'worker-branch', 'A worker branch is not merged.'],
    ['finished-project', 'skipped', 'worker-branch', 'A worker branch is not merged.'],
    ['failed-project', 'done', null, 'No activity for 24 hours.'],
    ['abandoned-project', 'done', null, 'No activity for 24 hours.'],
    ['mail-project', 'skipped', 'mailbox', 'A project Mailbox item is waiting for the Owner.'],
  ]);
});

test('auto-park ignores pinned and recent projects, stops when disabled, and records park-check refusal', async (t) => {
  const autoPark = await import('../src/project-register-auto-park.js');
  const dataDir = fixture(t, [
    record('pinned-project', { pinned: true }),
    record('recent-project', { lastActivityAt: '2026-10-10T11:00:00.000Z' }),
    record('blocked-project'),
  ]);
  const calls = [];
  await autoPark.runProjectRegisterAutoPark({
    dataDir, hours: 24, now,
    runLifecycle: async (_action, args, { log }) => {
      calls.push(args);
      log('  git      blocked: the main checkout has uncommitted changes.');
      return 1;
    },
  });
  assert.deepEqual(calls, [['blocked-project', '--dry-run']]);
  assert.deepEqual(audit(dataDir).map(({ slug, result, failedCheck, reason }) => [slug, result, failedCheck, reason]), [
    ['blocked-project', 'skipped', 'git', 'the main checkout has uncommitted changes.'],
  ]);

  await autoPark.runProjectRegisterAutoPark({ dataDir, hours: 0, now, runLifecycle: async () => { throw new Error('must stay disabled'); } });
  assert.equal(audit(dataDir).length, 1);
});

test('auto-park audits and skips a project that is already parking', async (t) => {
  const autoPark = await import('../src/project-register-auto-park.js');
  const dataDir = fixture(t, [record('parking-project', { state: 'parking' })]);
  const calls = [];

  const result = await autoPark.runProjectRegisterAutoPark({
    dataDir, hours: 24, now,
    runLifecycle: async (_action, args) => { calls.push(args); return 0; },
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(result, { considered: 1, parked: 0, skipped: 1, intervalMs: 10 * 60 * 1000 });
  assert.deepEqual(audit(dataDir).map(({ slug, action, result: outcome, failedCheck, reason }) => [slug, action, outcome, failedCheck, reason]), [
    ['parking-project', 'auto-park', 'skipped', 'state', 'Project is already parking.'],
  ]);
});

test('auto-park records one failure audit line and uses the failed lifecycle step as its reason', async (t) => {
  const autoPark = await import('../src/project-register-auto-park.js');
  const dataDir = fixture(t, [record('failed-park-project')]);
  const calls = [];

  await autoPark.runProjectRegisterAutoPark({
    dataDir, hours: 24, now,
    runLifecycle: async (_action, args, { log, suppressAudit }) => {
      calls.push({ args, suppressAudit });
      if (args.includes('--dry-run')) {
        log('All park checks pass.');
        return 0;
      }
      if (!suppressAudit) appendAudit('failed-park-project', 'park', dataDir, { by: 'auto-park', result: 'failed', failedCheck: 'workspace' });
      log('Park stopped at workspace. Project failed-park-project stays in state open. Fixture close failed.');
      return 1;
    },
  });

  assert.deepEqual(calls, [
    { args: ['failed-park-project', '--dry-run'], suppressAudit: true },
    { args: ['failed-park-project'], suppressAudit: true },
  ]);
  assert.deepEqual(audit(dataDir).map(({ action, result, failedCheck, reason }) => [action, result, failedCheck, reason]), [
    ['auto-park', 'skipped', 'workspace', 'workspace'],
  ]);
});
