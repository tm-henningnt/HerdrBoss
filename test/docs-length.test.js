import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXED_LIMITS = [
  ['README.md', 120],
  ['docs/start-here.md', 150],
  ['docs/concepts.md', 150],
];

function lineCount(source) {
  return source.split(/\r?\n/).length - (source.endsWith('\n') ? 1 : 0);
}

function guideTaskErrors(relative, source, limit) {
  const lines = source.split(/\r?\n/);
  const taskStarts = [];
  const errors = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) taskStarts.push(index);
  }

  if (!taskStarts.length) return [`${relative}:1: no guide tasks found`];

  for (let task = 0; task < taskStarts.length; task += 1) {
    const start = taskStarts[task];
    const nextTask = taskStarts[task + 1];
    const end = nextTask === undefined
      ? lines.length - (source.endsWith('\n') ? 1 : 0)
      : nextTask;
    const count = end - start;
    if (count > limit) {
      errors.push(`${relative}:${start + limit + 1}: task "${lines[start].slice(3)}" has ${count} lines; D12 allows ${limit}`);
    }
  }

  return errors;
}

function glossaryErrors(file, source) {
  const lines = source.split(/\r?\n/);
  const errors = [];
  const terms = new Set();
  let inEntry = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const bullet = /^-\s+\*\*([^*]+)\*\*/.exec(line);
    if (bullet) {
      const term = bullet[1].toLocaleLowerCase('en');
      if (terms.has(term)) errors.push(`${file}:${index + 1}: duplicate glossary entry`);
      terms.add(term);
      inEntry = true;
      continue;
    }
    if (/^-\s+/.test(line)) {
      errors.push(`${file}:${index + 1}: glossary entry must name its word in bold`);
      inEntry = true;
      continue;
    }
    if (inEntry && /^\s+\S/.test(line)) errors.push(`${file}:${index + 1}: glossary entry continues on another line`);
    if (line.trim() && !/^\s+/.test(line)) inEntry = false;
  }

  if (!terms.size) errors.push(`${file}:1: no glossary entries found`);
  return errors;
}

test('D12 length limits hold for the user documentation pages', () => {
  const errors = [];
  for (const [relative, limit] of FIXED_LIMITS) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) {
      errors.push(`${relative}:1: required page is missing`);
      continue;
    }
    const count = lineCount(fs.readFileSync(file, 'utf8'));
    if (count > limit) errors.push(`${relative}:${limit + 1}: ${count} lines; D12 allows ${limit}`);
  }

  const guideDir = path.join(root, 'docs/guide');
  const guides = fs.readdirSync(guideDir).filter((name) => name.endsWith('.md')).sort();
  if (!guides.length) errors.push('docs/guide:1: no guide tasks found');
  for (const name of guides) {
    const relative = `docs/guide/${name}`;
    errors.push(...guideTaskErrors(relative, fs.readFileSync(path.join(guideDir, name), 'utf8'), 60));
  }

  const glossaryPath = 'docs/glossary.md';
  const glossaryFile = path.join(root, glossaryPath);
  if (!fs.existsSync(glossaryFile)) errors.push(`${glossaryPath}:1: required page is missing`);
  else errors.push(...glossaryErrors(glossaryPath, fs.readFileSync(glossaryFile, 'utf8')));

  // D12 gives Reference pages no line limit.
  assert.deepEqual(errors, [], `D12 violations:\n${errors.join('\n')}`);
});
