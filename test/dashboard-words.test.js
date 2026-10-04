import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { literalSegments, readableText } from './helpers/user-visible-text.js';

// The Vocabulary section of docs/plans/docs-and-onboarding.md. The dashboard text uses the plain word.
// The Reference, the commands, and the API keep the retired word. Code spans and HTML tags can hold it.
const RETIRED = [
  [/orchestrators?/i, 'project lead'],
  [/quotas?/i, 'usage limit'],
  [/harness(?:es)?/i, 'agent app'],
  [/planner sessions?/i, 'planning session'],
];

// Keys that the service sends. The page maps each one to a plain label.
const KEYS = new Set(['Quota', 'Quota plan']);

const FILES = ['public/app.js', 'public/setting-help.js'];

function retiredWordsIn(file) {
  const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const found = [];
  for (const { line, text } of literalSegments(source)) {
    const plain = readableText(text);
    // A literal without a space or a capital is a key, a class name, or a route.
    if (KEYS.has(plain.trim())) continue;
    if (!/\s/.test(plain.trim()) && !/^[A-Z]/.test(plain.trim())) continue;
    for (const [pattern, word] of RETIRED) {
      const match = plain.match(pattern);
      if (match) found.push(`${file}:${line} "${match[0]}" should be "${word}": ${plain.trim().slice(0, 80)}`);
    }
  }
  return found;
}

for (const file of FILES) {
  test(`${file} shows no retired word in user-visible text`, () => {
    assert.deepEqual(retiredWordsIn(file), []);
  });
}

test('the scanner reads literals and skips code spans, tags, and code', () => {
  const source = "const a = 'The orchestrator works';\nconst b = `Run <code>quota</code> and `${x}` the harness`;\nconst c = '<div class=\"quota-row\">ok</div>';\nconst d = /quota/.test(y); // orchestrator\nconst e = 'Use `harness` here';";
  const words = literalSegments(source).map((s) => readableText(s.text).replace(/\s+/g, ' ').trim()).filter(Boolean);
  assert.deepEqual(words, ['The orchestrator works', 'Run and', 'the harness', 'ok', 'Use here']);
});
