import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repo, 'scripts', 'docs-gate.js');

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function write(root, file, text) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}

// A fixture repository with a main branch and a feature branch that starts at main.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-docs-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '-q', '-b', 'main']);
  write(root, 'src/engine.js', 'export const a = 1;\n');
  write(root, 'docs/guide.md', '# Guide\n');
  write(root, 'test/engine.test.js', '// test\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'Start']);
  git(root, ['checkout', '-q', '-b', 'feature']);
  return root;
}

function commit(root, message) {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', message]);
}

function gate(root, args = []) {
  const result = spawnSync(process.execPath, [script, '--root', root, '--base', 'main', ...args], { encoding: 'utf8' });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

test('the gate passes when main has no branch diff', (t) => {
  const root = fixture(t);
  git(root, ['checkout', '-q', 'main']);
  const result = gate(root);
  assert.equal(result.code, 0, result.out);
});

test('the gate passes when the branch has no change', (t) => {
  const result = gate(fixture(t));
  assert.equal(result.code, 0, result.out);
});

test('the gate fails when a behavior path changes without a docs change', (t) => {
  const root = fixture(t);
  write(root, 'src/engine.js', 'export const a = 2;\n');
  commit(root, 'Change the engine');
  const result = gate(root);
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /src\/engine\.js/);
  assert.match(result.out, /Docs-Exempt/);
});

test('the gate passes when a behavior change comes with a docs change', (t) => {
  const root = fixture(t);
  write(root, 'src/engine.js', 'export const a = 2;\n');
  write(root, 'docs/guide.md', '# Guide\n\nThe engine returns 2.\n');
  commit(root, 'Change the engine and the guide');
  const result = gate(root);
  assert.equal(result.code, 0, result.out);
});

test('the gate passes when a behavior change comes with a page help change', (t) => {
  const root = fixture(t);
  write(root, 'public/app.js', 'const x = 1;\n');
  write(root, 'docs/help/board.md', '# Board help\n');
  commit(root, 'Change the page and its help');
  const result = gate(root);
  assert.equal(result.code, 0, result.out);
});

test('the gate passes for a branch with only docs changes', (t) => {
  const root = fixture(t);
  write(root, 'docs/guide.md', '# Guide\n\nMore text.\n');
  commit(root, 'Improve the guide');
  const result = gate(root);
  assert.equal(result.code, 0, result.out);
});

test('the gate passes for a branch with only test changes', (t) => {
  const root = fixture(t);
  write(root, 'test/engine.test.js', '// changed test\n');
  commit(root, 'Change a test');
  const result = gate(root);
  assert.equal(result.code, 0, result.out);
});

test('a change under docs/orchestration does not count as a docs change', (t) => {
  const root = fixture(t);
  write(root, 'src/engine.js', 'export const a = 3;\n');
  write(root, 'docs/orchestration/memory.md', '# Memory\n');
  commit(root, 'Change the engine and the memory');
  const result = gate(root);
  assert.equal(result.code, 1, result.out);
});

test('a Docs-Exempt trailer with a reason exempts the branch', (t) => {
  const root = fixture(t);
  write(root, 'src/engine.js', 'export const a = 4;\n');
  commit(root, 'Rename a variable\n\nDocs-Exempt: refactor with no change of behavior');
  const result = gate(root);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /refactor with no change of behavior/);
});

test('a Docs-Exempt trailer with no reason does not exempt the branch', (t) => {
  const root = fixture(t);
  write(root, 'src/engine.js', 'export const a = 5;\n');
  commit(root, 'Change the engine\n\nDocs-Exempt:');
  const result = gate(root);
  assert.equal(result.code, 1, result.out);
});

test('an entry added to docs/gate-exemptions exempts the matching path', (t) => {
  const root = fixture(t);
  write(root, 'src/engine.js', 'export const a = 6;\n');
  write(root, 'docs/gate-exemptions', 'src/engine.js | typo fix in a string\n');
  commit(root, 'Fix a typo');
  const result = gate(root);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /typo fix in a string/);
});

test('an entry in docs/gate-exemptions needs a reason', (t) => {
  const root = fixture(t);
  write(root, 'src/engine.js', 'export const a = 7;\n');
  write(root, 'docs/gate-exemptions', 'src/engine.js |\n');
  commit(root, 'Change the engine');
  const result = gate(root);
  assert.equal(result.code, 1, result.out);
});

test('an old entry in docs/gate-exemptions does not exempt a later branch', (t) => {
  const root = fixture(t);
  write(root, 'docs/gate-exemptions', 'src/engine.js | typo fix in a string\n');
  git(root, ['checkout', '-q', 'main']);
  write(root, 'docs/gate-exemptions', 'src/engine.js | typo fix in a string\n');
  commit(root, 'Record an exemption on main');
  git(root, ['checkout', '-q', '-b', 'later']);
  write(root, 'src/engine.js', 'export const a = 8;\n');
  commit(root, 'Change the engine');
  const result = gate(root);
  assert.equal(result.code, 1, result.out);
});

test('the gate compares with the merge base, not the tip of main', (t) => {
  const root = fixture(t);
  git(root, ['checkout', '-q', 'main']);
  write(root, 'src/other.js', 'export const b = 1;\n');
  commit(root, 'Change main after the branch point');
  git(root, ['checkout', '-q', 'feature']);
  write(root, 'docs/guide.md', '# Guide\n\nText.\n');
  commit(root, 'Change the guide');
  const result = gate(root);
  assert.equal(result.code, 0, result.out);
});

test('the gate exits with code 2 when the base does not exist', (t) => {
  const root = fixture(t);
  const result = spawnSync(process.execPath, [script, '--root', root, '--base', 'missing'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
});

test('the gate rules in the repository cover the behavior paths', async () => {
  const { loadRules, classify } = await import('../scripts/docs-gate.js');
  const rules = loadRules();
  assert.equal(classify('src/engine.js', rules), 'behavior');
  assert.equal(classify('public/app.js', rules), 'behavior');
  assert.equal(classify('kit/templates/worker-brief.md', rules), 'behavior');
  assert.equal(classify('kit/CHANGES.md', rules), 'other');
  assert.equal(classify('docs/help/board.md', rules), 'docs');
  assert.equal(classify('README.md', rules), 'docs');
  assert.equal(classify('docs/orchestration/memory.md', rules), 'other');
  assert.equal(classify('test/engine.test.js', rules), 'other');
});
