import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { headingSlug } from '../public/markdown.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PENDING_PAGES = new Map([
  ['docs/getting-started-prompt.md', 'ONB1d has not added this page yet'],
]);

function relative(file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function blankLine(line) {
  return line.replace(/[^\r\n]/g, ' ');
}

function maskCode(source) {
  let fence = null;
  const lines = source.split(/(?<=\n)/);
  const withoutFences = lines.map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      const closes = marker && marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}(?:`{3,}|~{3,})\s*$/.test(line);
      if (closes) fence = null;
      return blankLine(line);
    }
    if (marker) {
      fence = marker;
      return blankLine(line);
    }
    return line;
  }).join('');
  return withoutFences.replace(/(`+)[\s\S]*?\1/g, (span) => blankLine(span));
}

function pageFile(name) {
  if (name === '') return path.join(root, 'README.md');
  const base = path.join(root, 'docs', name);
  for (const candidate of [`${base}.md`, path.join(base, 'index.md')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function userDocFiles() {
  const navFile = path.join(root, 'docs/nav.json');
  const nav = JSON.parse(fs.readFileSync(navFile, 'utf8'));
  const files = new Set([path.join(root, 'README.md')]);
  const errors = [];
  for (const section of nav.sections || []) {
    for (const page of section.pages || []) {
      if (page.endsWith('/*')) {
        const dir = path.join(root, 'docs', page.slice(0, -2));
        if (!fs.existsSync(dir)) {
          errors.push(`docs/nav.json:1: page folder ${page} is missing`);
          continue;
        }
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith('.md')) files.add(path.join(dir, entry.name));
        }
        continue;
      }
      const file = pageFile(page);
      if (file) files.add(file);
      else errors.push(`docs/nav.json:1: page ${page || '(front page)'} has no Markdown file`);
    }
  }
  return { files: [...files].filter((file) => fs.existsSync(file)).sort(), errors };
}

function linksIn(source) {
  const text = maskCode(source);
  const links = [];
  const markdownLink = /(!?)\[[^\]\n]*\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)/g;
  for (const match of text.matchAll(markdownLink)) {
    const wrapped = match[2];
    links.push({ target: wrapped.startsWith('<') ? wrapped.slice(1, -1) : wrapped, image: match[1] === '!', index: match.index });
  }
  const htmlLink = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  for (const match of text.matchAll(htmlLink)) links.push({ target: match[1] ?? match[2], image: false, index: match.index });
  return links.sort((a, b) => a.index - b.index);
}

function lineAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

function headingAnchors(source) {
  const anchors = new Set();
  const counts = new Map();
  let fence = null;
  for (const line of source.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}(?:`{3,}|~{3,})\s*$/.test(line)) fence = null;
      continue;
    }
    if (marker) { fence = marker; continue; }
    const heading = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (!heading) continue;
    const base = headingSlug(heading[1]) || 'section';
    const count = counts.get(base) || 0;
    counts.set(base, count + 1);
    anchors.add(count ? `${base}-${count}` : base);
  }
  return anchors;
}

function resolveLocalTarget(sourceFile, target) {
  const hashAt = target.indexOf('#');
  const rawPath = (hashAt === -1 ? target : target.slice(0, hashAt)).split('?', 1)[0];
  const rawAnchor = hashAt === -1 ? '' : target.slice(hashAt + 1).split('?', 1)[0];
  let decodedPath;
  let anchor;
  try {
    decodedPath = decodeURIComponent(rawPath);
    anchor = decodeURIComponent(rawAnchor);
  } catch {
    return { error: `malformed escaped target ${target}` };
  }
  const destination = rawPath ? path.resolve(path.dirname(sourceFile), decodedPath) : sourceFile;
  const rel = relative(destination);
  if (rel === '..' || rel.startsWith('../')) return { error: `target leaves the repository: ${target}` };
  const candidates = [destination];
  if (!path.extname(destination)) candidates.push(`${destination}.md`);
  candidates.push(path.join(destination, 'index.md'), path.join(destination, 'README.md'));
  const file = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  return file ? { file, anchor } : { error: `target does not resolve to a file: ${target}`, rel };
}

test('relative links and heading anchors in the user docs resolve', (t) => {
  const { files, errors } = userDocFiles();
  const skips = [];
  for (const sourceFile of files) {
    const sourceRel = relative(sourceFile);
    const source = fs.readFileSync(sourceFile, 'utf8');
    for (const { target, image, index } of linksIn(source)) {
      if (!target || target.startsWith('/') || target.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
      const location = `${sourceRel}:${lineAt(source, index)}`;
      const result = resolveLocalTarget(sourceFile, target);
      if (result.error) {
        if (PENDING_PAGES.has(result.rel)) {
          skips.push(`${location}: ${target} (${PENDING_PAGES.get(result.rel)})`);
        } else errors.push(`${location}: ${result.error}`);
        continue;
      }
      if (image || !result.anchor || path.extname(result.file).toLowerCase() !== '.md') continue;
      const anchors = headingAnchors(fs.readFileSync(result.file, 'utf8'));
      if (!anchors.has(headingSlug(result.anchor))) {
        errors.push(`${location}: ${target} has no matching heading in ${relative(result.file)}`);
      }
    }
  }
  for (const skip of skips) t.diagnostic(`Pending page link skipped: ${skip}`);
  assert.deepEqual(errors, [], `Broken user-doc links or anchors:\n${errors.join('\n')}`);
});
