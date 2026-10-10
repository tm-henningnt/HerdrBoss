import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadModels } from '../src/kit/config.js';
import { collectWorker } from '../src/kit/workers.js';
import { DATA_DIR } from '../src/config.js';
import { readRegister, writeRegister } from '../src/project-register.js';
import { startWorker } from './helpers/start-worker.js';
import { git, setupFixture } from './helpers/kit-fixture.js';

const FAKE_SECRET = 'sk-FAKESECRET1234567890abcdef';

test('worker start stores the title and a masked brief copy, and collect stores the report summary', () => {
  const f = setupFixture(null);
  const model = 'gpt-6-luna';
  fs.writeFileSync(f.rulesFile, JSON.stringify({ policy: { allowedKinds: ['codex'], excludedModels: [], modelProviders: { [model]: null } } }));
  git(f.root, 'add', '-A');
  git(f.root, 'commit', '--allow-empty', '-m', 'fixture configuration');
  const name = 'view-record';
  const run = startWorker(name, { kind: 'codex', model, task: `AV1 readable workers\nUse key ${FAKE_SECRET} for the check.`, allow: ['.orchestration/runs/'], noWorktree: true }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  const stored = JSON.parse(fs.readFileSync(run.recordFile, 'utf8'));
  assert.equal(stored.title, 'AV1 readable workers');
  assert.match(stored.briefCopy.hash, /^[0-9a-f]{64}$/);
  assert.match(stored.briefCopy.text, /AV1 readable workers/);
  assert.doesNotMatch(fs.readFileSync(run.recordFile, 'utf8'), /FAKESECRET/);
  assert.ok(Date.parse(stored.briefCopy.savedAt) > 0);

  const reportDir = path.join(run.worktree, run.workerDir);
  fs.writeFileSync(path.join(reportDir, 'report.md'), `# Report\n\nBuilt the Agents table. Key ${FAKE_SECRET} stayed out.\n\n## Commands\n`);
  fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({
    issue: null, branch: run.branch, worktree: run.worktree, changedPaths: [`.orchestration/runs/${name}.json`], commands: ['focused check'],
    evidenceTier: ['unit'], unverified: [], stoppedEarly: false,
  }));
  writeRegister({ version: 1, projects: [{
    slug: f.config.slug, title: f.config.slug, group: '', clientTag: '', repo: f.root, remote: '', factory: 'factory-zero',
    state: 'open', pinned: false, priority: 'normal', issueSource: null, autoOpen: 'off', lastOpenedAt: '',
    lastActivityAt: '', nextAction: '', notes: '', createdAt: '2026-10-01T00:00:00.000Z',
  }] }, DATA_DIR);
  collectWorker(name, { record: true, outcome: 'done', gatePassed: true }, {
    config: f.config, now: Date.parse('2026-09-25T17:00:00Z'), output: () => {}, listWorktreeProcesses: () => [],
    recordUsageFn: () => ({ errors: [], duplicate: false }),
  });
  const collected = JSON.parse(fs.readFileSync(run.recordFile, 'utf8'));
  assert.equal(collected.reportSummary, 'Built the Agents table. Key [REDACTED] stayed out.');
  assert.equal(collected.briefCopy.hash, stored.briefCopy.hash);
  assert.equal(readRegister(DATA_DIR).projects[0].lastActivityAt, '2026-09-25T17:00:00.000Z');
});
