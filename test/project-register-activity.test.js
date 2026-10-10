import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Engine } from '../src/engine.js';
import { recordProjectRepo } from '../src/harness.js';
import { readRegister, writeRegister } from '../src/project-register.js';

const activityRecord = (slug, repo) => ({
  slug, title: slug, group: '', clientTag: '', repo, remote: '', factory: 'factory-zero',
  state: 'open', pinned: false, priority: 'normal', issueSource: null, autoOpen: 'off',
  lastOpenedAt: '', lastActivityAt: '', nextAction: '', notes: '', createdAt: '2026-10-01T00:00:00.000Z',
});

test('a project repository commit refreshes register activity from the commit time', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-register-activity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const slug = 'sample-project';
  const committedAt = '2026-10-09T12:00:00.000Z';
  recordProjectRepo(slug, repo, '', { dataDir });
  writeRegister({ version: 1, projects: [activityRecord(slug, repo)] }, dataDir);
  const engine = Object.assign(Object.create(Engine.prototype), {
    lockDataDir: dataDir,
    memory: { statusHeads: {} },
    headReads: new Set(),
    gitRunner: async (args) => args.includes('rev-parse') ? 'head-id\n' : `${committedAt}\n`,
    log() {},
  });

  await engine.readProjectHeads(Date.parse('2026-10-10T12:00:00.000Z'));

  assert.equal(readRegister(dataDir).projects[0].lastActivityAt, committedAt);
});
