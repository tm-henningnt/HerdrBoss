import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadModels } from '../src/kit/config.js';
import { collectWorker } from '../src/kit/workers.js';
import { startWorker } from './helpers/start-worker.js';
import { git, setupFixture } from './helpers/kit-fixture.js';

// A worker that changed the listed paths. Paths under the allowed entries are inside the scope.
// The other paths are outside it.
function setup(t, name, { changed = [], allow = ['src/'] } = {}) {
  const f = setupFixture(null);
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  git(f.root, 'add', '-A');
  git(f.root, 'commit', '--allow-empty', '-m', 'fixture configuration');
  const run = startWorker(name, { kind: 'codex', task: 'x', allow: [...allow, '.orchestration/runs/'], noWorktree: true }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  for (const relative of changed) {
    const file = path.join(run.worktree, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'changed\n');
    git(run.worktree, 'add', relative);
  }
  if (changed.length) git(run.worktree, 'commit', '-m', 'worker change');
  const reportDir = path.join(run.worktree, run.workerDir);
  fs.writeFileSync(path.join(reportDir, 'report.md'), 'Done.\n');
  fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({
    issue: null, branch: run.branch, worktree: run.worktree, changedPaths: changed, commands: ['focused check'],
    evidenceTier: ['unit'], unverified: [], stoppedEarly: false,
  }));
  const collect = (options = {}) => {
    const output = [];
    const summary = collectWorker(name, { noRecord: true, ...options }, {
      config: f.config, now: Date.parse('2026-10-03T10:00:00Z'), output: (line) => output.push(line),
      listWorktreeProcesses: () => [], recordUsageFn: () => ({ errors: [], duplicate: false }),
    });
    return { summary, output };
  };
  const refusal = (options = {}) => {
    try {
      collect(options);
    } catch (error) {
      return error.message;
    }
    throw new Error('collect did not refuse');
  };
  return { f, run, collect, refusal };
}

const insideSegment = (message) => {
  const match = message.match(/Inside the allowed scope: (.*?)\. Nearest allowed/);
  assert.ok(match, `no inside-scope list in: ${message}`);
  return match[1];
};

test('the refusal lists the changed paths that are inside the allowed scope', (t) => {
  const { refusal } = setup(t, 'hints-inside', { changed: ['src/a.js', 'src/kit/b.js', 'docs/extra.md'] });
  const message = refusal();
  assert.match(message, /changed paths outside its allowed scope: docs\/extra\.md\./);
  const inside = insideSegment(message).split(', ');
  assert.ok(inside.includes('src/a.js'), `missing src/a.js in: ${message}`);
  assert.ok(inside.includes('src/kit/b.js'), `missing src/kit/b.js in: ${message}`);
  assert.ok(!inside.includes('docs/extra.md'), `outside path listed as inside: ${message}`);
});

test('the inside list caps at 20 paths and ends with and N more', (t) => {
  const changed = [];
  for (let index = 0; index < 23; index += 1) changed.push(`src/file-${String(index).padStart(2, '0')}.js`);
  changed.push('docs/extra.md');
  const { refusal } = setup(t, 'hints-cap', { changed });
  const inside = insideSegment(refusal());
  const parts = inside.split(', ');
  assert.equal(parts.length, 20);
  // 23 changed source files plus the kit run record inside the scope; the first 20 show.
  assert.match(parts[19], / and 4 more$/);
});

test('each rejected path names the nearest allowed path in a sibling directory', (t) => {
  const { refusal } = setup(t, 'hints-sibling', { changed: ['src/other/a.js'], allow: ['docs/', 'src/kit/'] });
  assert.match(refusal(), /src\/other\/a\.js \(nearest allowed: src\/kit\/\)/);
});

test('a rejected path with no shared directory names the first allowed entry', (t) => {
  const { refusal } = setup(t, 'hints-noshare', { changed: ['public/app.js'], allow: ['src/'] });
  assert.match(refusal(), /public\/app\.js \(nearest allowed: src\/\)/);
});

test('the existing refusal text parts stay present', (t) => {
  const { refusal } = setup(t, 'hints-existing', { changed: ['docs/extra.md'], allow: ['src/'] });
  const message = refusal();
  assert.match(message, /changed paths outside its allowed scope: docs\/extra\.md\./);
  assert.match(message, /The allowed command form is: herdr-boss worker collect hints-existing --accept-scope FILE\[,FILE\] --reason TEXT\./);
  assert.match(message, /Example: herdr-boss worker collect hints-existing --accept-scope 'docs\/extra\.md' --reason "approved by the orchestrator"\./);
});

test('the Impeccable refusal keeps the dedicated rule and shows no scope hints', (t) => {
  const { refusal } = setup(t, 'hints-impeccable', { changed: ['.impeccable/config.json'], allow: ['.'] });
  const message = refusal();
  assert.match(message, /\.impeccable\/config\.json/);
  assert.match(message, /Workers never run impeccable ignores or edit \.impeccable\/config\.json\./);
  assert.doesNotMatch(message, /Inside the allowed scope:/);
  assert.doesNotMatch(message, /nearest allowed/);
});
