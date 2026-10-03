import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Delete each entry as its page is added by DOC1f, DOC1g, DOC1h, or ONB1.
const PENDING_GUIDE_PAGES = new Set([
  'docs/guide/see.md',
  'docs/guide/answer.md',
  'docs/guide/review.md',
  'docs/guide/cost.md',
  'docs/concepts.md',
  'docs/getting-started-prompt.md',
]);

function markdownFiles(folder) {
  return fs.readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => path.join(folder, entry.name));
}

function withoutCode(markdown) {
  const lines = markdown.split('\n');
  const kept = [];
  let fence = null;
  for (const line of lines) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}(?:`{3,}|~{3,})\s*$/.test(line)) fence = null;
      continue;
    }
    if (marker) { fence = marker; continue; }
    kept.push(line);
  }
  return kept.join('\n').replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, '');
}

function linkTargets(markdown) {
  const text = withoutCode(markdown);
  const targets = [];
  const pattern = /!?\[[^\]]*\]\((<[^>\n]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)/g;
  for (const match of text.matchAll(pattern)) {
    const raw = match[1];
    targets.push(raw.startsWith('<') ? raw.slice(1, -1) : raw);
  }
  return targets;
}

test('relative links in root docs and Reference pages resolve to files', () => {
  const sources = [...markdownFiles(path.join(root, 'docs')), ...markdownFiles(path.join(root, 'docs/reference'))];
  const errors = [];
  for (const source of sources) {
    for (const target of linkTargets(fs.readFileSync(source, 'utf8'))) {
      if (!target || target.startsWith('/') || target.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
      const pathname = target.split(/[?#]/, 1)[0];
      let destination = source;
      try {
        if (pathname) destination = path.resolve(path.dirname(source), decodeURIComponent(pathname));
      } catch {
        errors.push(`${path.relative(root, source)}: malformed link ${target}`);
        continue;
      }
      const relative = path.relative(root, destination).split(path.sep).join('/');
      if (PENDING_GUIDE_PAGES.has(relative)) continue;
      if (!fs.existsSync(destination) || !fs.statSync(destination).isFile()) {
        errors.push(`${path.relative(root, source)}: ${target} does not resolve to a file`);
      }
    }
  }
  assert.deepEqual(errors, []);
});
