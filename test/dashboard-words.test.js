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

const FILES = ['public/app.js', 'public/setting-help.js', 'public/fleet.js'];
// The Fleet page is scanned for the retired word "quota" only.
const ONLY = { 'public/fleet.js': /^usage limit$/ };

function retiredWordsIn(file) {
  const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const found = [];
  for (const { line, text } of literalSegments(source)) {
    // A command name keeps the retired word. Reference and commands are outside the plain-word rule.
    const plain = readableText(text).replace(/herdr-boss harness [a-z-]+/g, '');
    // A literal without a space or a capital is a key, a class name, or a route.
    if (KEYS.has(text)) continue;
    // A plain lowercase word without markup is a key, a class name, or a route. The same word between tags is visible text.
    if (!/[<>]/.test(text) && !/\s/.test(plain.trim()) && !/^[A-Z]/.test(plain.trim())) continue;
    const doubled = plain.match(/\b([a-z]+) \1\b/i);
    if (doubled) found.push(`${file}:${line} doubled word "${doubled[0]}": ${plain.trim().slice(0, 80)}`);
    for (const [pattern, word] of RETIRED) {
      if (ONLY[file] && !ONLY[file].test(word)) continue;
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

test('the scanner reads a data-label value as visible text', () => {
  assert.match(readableText('<td data-label="Harness" class="harness-cell">x</td>'), /Harness/);
  assert.doesNotMatch(readableText('<td class="harness-cell">x</td>'), /harness/);
});

test('the scanner reads literals and skips code spans, tags, and code', () => {
  const source = "const a = 'The orchestrator works';\nconst b = `Run <code>quota</code> and `${x}` the harness`;\nconst c = '<div class=\"quota-row\">ok</div>';\nconst d = /quota/.test(y); // orchestrator\nconst e = 'Use `harness` here';";
  const words = literalSegments(source).map((s) => readableText(s.text).replace(/\s+/g, ' ').trim()).filter(Boolean);
  assert.deepEqual(words, ['The orchestrator works', 'Run and', 'the harness', 'ok', 'Use here']);
});
