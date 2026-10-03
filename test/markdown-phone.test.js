import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdown } from '../public/markdown.js';
import { LONG_MESSAGES } from './fixtures/long-messages.js';

const css = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'style.css'), 'utf8');
const rule = (selector) => new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`, 'g');
const declarations = (selector) => [...css.matchAll(rule(selector))].map((m) => m[1]).join(' ');

// No DOM or layout engine runs in the tests. A box can be wider than the screen only when it is not a scroll box and
// does not wrap, so the tests check both halves: the renderer puts each wide element in a scroll box, and the style sheet makes the box scroll or wrap.

test('every long fixture puts each table and code block in its own scroll box', () => {
  for (const source of LONG_MESSAGES) {
    const html = renderMarkdown(source);
    const tables = (html.match(/<table>/g) || []).length;
    assert.equal((html.match(/<div class="md-table-wrap"><div class="md-table" role="region" tabindex="0" aria-label="Table"><table>/g) || []).length, tables);
    assert.equal((html.match(/<pre>/g) || []).length, (html.match(/<div class="md-code">/g) || []).length);
    assert.ok(!/<table[^>]*style=|<pre[^>]*style=/.test(html));
  }
});

test('the fixtures hold the shapes that broke on the phone', () => {
  const all = LONG_MESSAGES.join('\n');
  assert.ok(LONG_MESSAGES.length >= 15);
  for (const shape of [/^\| ---/m, /^```/m, /^\d+\. /m, /^#{1,6} /m, /https:\/\/\S{80,}/, /[A-Za-z0-9_/.-]{120,}/, /- \[x\]/]) assert.match(all, shape);
});

test('a table and a code block scroll sideways inside their own box', () => {
  assert.match(declarations('.md .md-table'), /overflow-x: auto/);
  assert.match(declarations('.md .md-table'), /max-width: 100%/);
  assert.match(declarations('.md pre'), /overflow-x: auto/);
  assert.match(declarations('.md pre code'), /white-space: pre/);
});

test('a table shows a scroll hint above the table at each edge with hidden columns', () => {
  const before = declarations('.md .md-table-wrap::before');
  const after = declarations('.md .md-table-wrap::after');
  assert.match(css, /\.md \.md-table-wrap::before, \.md \.md-table-wrap::after \{[^}]*position: absolute[^}]*z-index: 1[^}]*pointer-events: none[^}]*opacity: 0/);
  assert.match(before, /linear-gradient\(to right/);
  assert.match(after, /linear-gradient\(to left/);
  assert.match(css, /\[data-more="end"\]::after[^{]*\{[^}]*opacity: 1/);
  assert.match(css, /\[data-more="start"\]::before[^{]*\{[^}]*opacity: 1/);
  // The wrapper does not scroll, so the hint stays at the edge. The table box inside it scrolls.
  assert.doesNotMatch(declarations('.md .md-table-wrap'), /overflow/);
});

test('long strings wrap in text, links, and inline code, and stay whole in table cells', () => {
  assert.match(declarations('.md'), /overflow-wrap: anywhere/);
  assert.match(css, /\.md, \.md p, \.md li, \.md blockquote, \.md a, \.md code[^{]*\{[^}]*overflow-wrap: anywhere/);
  assert.match(declarations('.md td a, .md td code, .md th code'), /overflow-wrap: normal/);
});

test('the phone rules shrink headings, list indents, and code', () => {
  const phone = /@media \(max-width: 500px\) \{([^]*?)\n\}\n/.exec(css.slice(css.indexOf('/* Phone: long strings wrap')))[1];
  assert.match(phone, /\.md h3 \{ font-size: 15px/);
  assert.match(phone, /\.md ul, \.md ol \{ padding-left: 16px/);
  assert.match(phone, /\.md pre code \{ font-size: 11\.5px/);
});

test('bubbles on a phone use at least 94 percent of the width', () => {
  const tail = css.slice(css.lastIndexOf('/* Phone: wider bubbles'));
  assert.match(tail, /\.chat-bubbles > \.chat-bubble[^{]*\{ max-width: 94%/);
});

// A static form of the browser audit (.worker/overflow-audit.js). A rule under .md that stops wrapping must sit on an element
// that scrolls (a code block, a table cell inside the table box) or on a code element inside one. No .md rule sets a fixed width of 200 px or more.
test('only scroll-box content stops wrapping, and no .md rule sets a wide fixed width', () => {
  const rules = [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
  const noWrap = rules.filter((r) => /\.md\b/.test(r.selector) && /white-space:\s*(nowrap|pre)(?![-\w])/.test(r.body));
  assert.ok(noWrap.length >= 3);
  for (const r of noWrap) assert.match(r.selector, /\bpre\b|\bt[dh]\b|\.md-table|\.n\b/, r.selector);
  for (const r of rules.filter((x) => /\.md\b/.test(x.selector))) assert.doesNotMatch(r.body, /(^|[;\s])(min-)?width:\s*(\d{3,}px|[2-9]\d{2,}px)/, r.selector);
});

test('on a phone each table cell stays on one line inside the scroll box', () => {
  const phone = /@media \(max-width: 500px\) \{([^]*?)\n\}\n/.exec(css.slice(css.indexOf('/* Phone: long strings wrap')))[1];
  assert.match(phone, /\.md th, \.md td \{ white-space: nowrap/);
});

test('the browser audit script is kept with the worker files', () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.worker', 'overflow-audit.js');
  if (!fs.existsSync(file)) return;
  assert.match(fs.readFileSync(file, 'utf8'), /scrollWidth > width/);
});
