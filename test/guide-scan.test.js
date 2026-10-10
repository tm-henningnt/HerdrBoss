import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUIDE_DIRS = ['docs/ideas/sc1-guides'];

// A guide gives placeholders only. These patterns find a GUID, a tenant host, a token, a key block, or a home path.
export const GUIDE_PATTERNS = [
  ['guid', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ['tenant host', /\b[a-z0-9-]+\.(?:[a-z]{2}\.)?qlikcloud\.com\b/i],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['token', /\b(?:ghp|gho|github_pat|sk|xox[bp])[-_][A-Za-z0-9_-]{16,}/],
  ['PEM private key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/],
  ['home path', /\/Users\/[a-z][a-z0-9._-]*\//i],
];

export function scanGuideText(text) {
  return GUIDE_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

test('the guide scan finds each pattern class and passes a placeholder', () => {
  assert.deepEqual(scanGuideText('app <APP_ID> on <tenant>.example'), []);
  assert.deepEqual(scanGuideText('id 0123abcd-4567-89ab-cdef-0123456789ab'), ['guid']);
  assert.deepEqual(scanGuideText('https://acme.eu.qlikcloud.com/x'), ['tenant host']);
  assert.deepEqual(scanGuideText('Authorization eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0'), ['jwt']);
  assert.deepEqual(scanGuideText('/Users/someone/Documents/x'), ['home path']);
  assert.deepEqual(scanGuideText('/Users/someone/Projects/Tallmaker/project'), ['home path']);
});

test('the guide scan rejects PEM private keys', () => {
  const pemHeader = ['-----BEGIN ', 'RSA ', 'PRIVATE KEY-----'].join('');
  assert.deepEqual(scanGuideText(pemHeader), ['PEM private key']);
});

test('the knowledge base guides hold no GUID, tenant host, token or home path', () => {
  for (const dir of GUIDE_DIRS) {
    const folder = path.join(repo, dir);
    if (!fs.existsSync(folder)) continue;
    for (const name of fs.readdirSync(folder).filter((file) => file.endsWith('.md'))) {
      const findings = scanGuideText(fs.readFileSync(path.join(folder, name), 'utf8'));
      assert.deepEqual(findings, [], `${dir}/${name} holds a ${findings.join(', ')}`);
    }
  }
});
