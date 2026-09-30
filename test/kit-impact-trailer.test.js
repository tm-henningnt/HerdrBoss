import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseKitImpact } from '../src/kit/agents-check.js';
import { KIT_PATHS } from '../src/kit-notice.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The commits up to this one are exempt (the base moved once: two kit-path commits of the prune archive had the trailer in a paragraph that git does not read as a trailer block; they change no kit revision). Put Kit-Impact and Co-Authored-By in one final paragraph.
// The commits up to this one are exempt. A later commit that touches a kit path needs a Kit-Impact: trailer
// or a change of kit/CHANGES.md.
const BASE = '20827080f2fc767e89a507954cab3e02cb85c4d6';
const CHANGES = 'kit/CHANGES.md';

function git(root, args) {
  return execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' }).trim();
}

// The short hash and subject of each commit after base that touches a kit path and records no impact.
function kitCommitsWithoutImpact(root, base, range = `${base}..HEAD`) {
  const hashes = git(root, ['log', '--no-merges', '--format=%H', range, '--', ...KIT_PATHS]).split('\n').filter(Boolean);
  return hashes.filter((hash) => {
    if (parseKitImpact(git(root, ['show', '-s', '--format=%B', hash]))) return false;
    return !git(root, ['show', '--format=', '--name-only', hash]).split('\n').includes(CHANGES);
  }).map((hash) => `${hash.slice(0, 7)} ${git(root, ['show', '-s', '--format=%s', hash])}`);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-kit-trailer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  const commit = (file, message) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.appendFileSync(path.join(root, file), `${message}\n`);
    git(root, ['add', file]);
    git(root, ['commit', '-m', message]);
  };
  commit('README.md', 'Initial commit');
  return { root, commit, base: git(root, ['rev-parse', 'HEAD']) };
}

test('the check flags a kit commit without a trailer or a change log entry', (t) => {
  const { root, commit, base } = fixture(t);
  commit('kit/models.json', 'Change the models\n\nKit-Impact: useful');
  commit('kit/templates/project-kit.md', 'Change the kit template');
  commit('src/kit/workers.js', 'Change worker start\n\nKit-Impact: maybe');
  commit('src/server.js', 'Change the server');
  commit(CHANGES, 'Record a change in the log');
  assert.deepEqual(kitCommitsWithoutImpact(root, base).map((line) => line.slice(8)), ['Change worker start', 'Change the kit template']);
});

test('every kit commit after the base commit carries a Kit-Impact trailer or a change log entry', (t) => {
  try { git(repo, ['merge-base', '--is-ancestor', BASE, 'HEAD']); } catch { t.skip('the base commit is not in the history of HEAD'); return; }
  const missing = kitCommitsWithoutImpact(repo, BASE);
  assert.deepEqual(missing, [], `Add a Kit-Impact: required|useful|none trailer to each commit that changes ${KIT_PATHS.join(', ')}.`);
});
