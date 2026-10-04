import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PATTERNS = [
  { type: 'secret-like token', regex: /\b(?:access[_ -]?token|api[_ -]?key|client[_ -]?secret|secret|token)\s*[:=]\s*(?:bearer\s+)?["']?[A-Za-z0-9._~-]{16,}/gi },
  { type: 'tenant URL', regex: /\bhttps?:\/\/(?:[a-z0-9-]+\.)+(?:ts\.net|tenant\.invalid)(?::\d+)?(?:\/[^\s<>"']*)?/gi },
  { type: 'home-directory path', regex: /\/Users\/[A-Za-z0-9._-]+(?:\/[^\s`"'<>)]*)?/g },
  { type: 'client name', regex: /\b(?:[A-Z][A-Za-z0-9&'.-]*(?:[ \t]+[A-Z][A-Za-z0-9&'.-]*){0,3})[ \t]+(?:Inc\.?|LLC|Ltd\.?|Limited|Corp\.?|Corporation|GmbH|ASA)\b/g },
];

function userDocFiles() {
  const nav = JSON.parse(fs.readFileSync(path.join(root, 'docs/nav.json'), 'utf8'));
  const files = new Set([path.join(root, 'README.md')]);
  for (const section of nav.sections || []) {
    for (const page of section.pages || []) {
      if (page.endsWith('/*')) {
        const dir = path.join(root, 'docs', page.slice(0, -2));
        if (!fs.existsSync(dir)) continue;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith('.md')) files.add(path.join(dir, entry.name));
        }
        continue;
      }
      if (!page) continue;
      const base = path.join(root, 'docs', page);
      for (const file of [`${base}.md`, path.join(base, 'index.md')]) {
        if (fs.existsSync(file) && fs.statSync(file).isFile()) { files.add(file); break; }
      }
    }
  }
  return [...files].sort();
}

function lineAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

function privateFindings(source, file) {
  const findings = [];
  for (const { type, regex } of PATTERNS) {
    regex.lastIndex = 0;
    for (const match of source.matchAll(regex)) {
      findings.push(`${file}:${lineAt(source, match.index)}: ${type}`);
    }
  }
  return findings;
}

test('user docs contain no secret-like token, tenant URL, home path, or client name', () => {
  const findings = userDocFiles().flatMap((file) => {
    const source = fs.readFileSync(file, 'utf8');
    return privateFindings(source, path.relative(root, file).split(path.sep).join('/'));
  });
  assert.deepEqual(findings, [], `Private-value scan findings (values are omitted):\n${findings.join('\n')}`);
});

test('the private-value scan catches neutral synthetic examples', () => {
  const fixtures = [
    { text: 'access_token=NEUTRAL_SAMPLE_VALUE_0123456789', type: 'secret-like token' },
    { text: 'https://sample.tenant.invalid/setup', type: 'tenant URL' },
    { text: '/Users/example-user/Projects/demo', type: 'home-directory path' },
    { text: 'Sample Workshop LLC', type: 'client name' },
  ];
  for (const [index, fixture] of fixtures.entries()) {
    const finding = privateFindings(fixture.text, `test/docs-private-values.test.js:synthetic-${index + 1}`);
    assert.ok(finding.some((item) => item.endsWith(fixture.type)), `test/docs-private-values.test.js: synthetic fixture ${index + 1} should match ${fixture.type}`);
  }
  assert.deepEqual(privateFindings('Public documentation uses a loopback URL and neutral placeholders.', 'test/docs-private-values.test.js:synthetic-safe'), []);
});
