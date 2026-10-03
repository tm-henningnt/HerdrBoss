import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdown, renderInlineMarkdown, markdownOrPlain, safeUrl, sanitizeRendered, ALLOWED_TAGS, ALLOWED_ATTRS, MAX_DEPTH, MAX_INLINE_DEPTH, MAX_TABLE_COLUMNS } from '../public/markdown.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name) => fs.readFileSync(path.join(root, 'test', 'fixtures', name), 'utf8');
const md = (source) => renderMarkdown(source);
const code = (inner) => `<div class="md-code"><button type="button" class="copy-btn" data-copy-code aria-label="Copy code"><span class="copy-icon" aria-hidden="true"></span><span class="copy-flash" aria-hidden="true">Copied</span></button><pre>${inner}</pre></div>`;

// A small tag and attribute scanner. The renderer writes attribute values only in double quotes, and esc() removes each quote and angle bracket from a value.
function scan(html) {
  const tags = [];
  const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = [];
    const attrRe = /\s([^\s=/>]+)(?:="([^"]*)")?/g;
    let a;
    while ((a = attrRe.exec(m[3]))) attrs.push({ name: a[1], value: a[2] ?? '' });
    const rest = m[3].replace(attrRe, '').trim();
    tags.push({ closing: !!m[1], name: m[2].toLowerCase(), attrs, rest });
  }
  // Text between the tags must hold no raw angle bracket.
  const text = html.replace(re, '');
  return { tags, text };
}

function assertAllowed(html, label = '') {
  const { tags, text } = scan(html);
  assert.ok(!/[<>]/.test(text), `raw angle bracket in text ${label}: ${html}`);
  for (const tag of tags) {
    assert.ok(ALLOWED_TAGS.has(tag.name), `tag ${tag.name} ${label}`);
    assert.equal(tag.rest, '', `unparsed attribute text on ${tag.name} ${label}: ${html}`);
    for (const attr of tag.attrs) {
      assert.ok(ALLOWED_ATTRS.has(attr.name), `attribute ${attr.name} ${label}`);
      assert.ok(!/^on/i.test(attr.name), `event attribute ${attr.name} ${label}`);
      if (attr.name === 'href') assert.ok(/^(https?:\/\/|mailto:|\/(?![/\\])|#)/i.test(attr.value.replace(/&amp;/g, '&')), `href ${attr.value} ${label}`);
      if (attr.name === 'style') assert.match(attr.value, /^text-align:(left|center|right)$/);
    }
  }
  assert.ok(!/javascript:|vbscript:|data:/i.test(tags.flatMap((t) => t.attrs.map((a) => a.value)).join(' ')), `unsafe scheme ${label}: ${html}`);
}

// ---------- Blocks ----------

test('headings render as h3 to h6 with the default offset', () => {
  assert.equal(md('# One'), '<h3>One</h3>');
  assert.equal(md('## Two ##'), '<h4>Two</h4>');
  assert.equal(md('### Three'), '<h5>Three</h5>');
  assert.equal(md('###### Six'), '<h6>Six</h6>');
  assert.equal(renderMarkdown('## Two', { headingOffset: 1 }), '<h3>Two</h3>');
  assert.equal(md('#nospace'), '<p>#nospace</p>');
});

test('paragraphs join soft breaks and keep hard breaks', () => {
  assert.equal(md('one\ntwo'), '<p>one two</p>');
  assert.equal(md('one  \ntwo'), '<p>one<br>two</p>');
  assert.equal(md('one\\\ntwo'), '<p>one<br>two</p>');
  assert.equal(md('a\n\nb'), '<p>a</p><p>b</p>');
});

test('bullet and ordered lists render, with the start number', () => {
  assert.equal(md('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(md('* a\n+ b'), '<ul><li>a</li></ul><ul><li>b</li></ul>');
  assert.equal(md('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
  assert.equal(md('3) a\n4) b'), '<ol start="3"><li>a</li><li>b</li></ol>');
  assert.equal(md('- a\n\n- b'), '<ul><li><p>a</p></li><li><p>b</p></li></ul>');
});

test('lists nest by indent and keep lazy continuation lines', () => {
  assert.equal(md('- a\n  - b\n    - c\n- d'), '<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>');
  assert.equal(md('1. a\n   - b\n2. c'), '<ol><li>a<ul><li>b</li></ul></li><li>c</li></ol>');
  assert.equal(md('- one\ntwo'), '<ul><li>one two</li></ul>');
  assert.equal(md('- a\n\n  more'), '<ul><li><p>a</p><p>more</p></li></ul>');
});

test('task list items render as disabled check boxes with a label', () => {
  assert.equal(md('- [x] done\n- [ ] open'), '<ul class="md-task"><li><input type="checkbox" disabled checked aria-label="Done"> <span>done</span></li><li><input type="checkbox" disabled aria-label="Not done"> <span>open</span></li></ul>');
  assert.match(md('- [ ] open\n- plain'), /^<ul><li><input/);
});

test('tables render with alignment in a scroll region', () => {
  const html = md('| a | b | c |\n| :-- | :-: | --: |\n| x | y | 1 |\n| \\| | `q` | 22 |');
  assert.equal(html, '<div class="md-table-wrap"><div class="md-table" role="region" tabindex="0" aria-label="Table"><table><thead><tr><th style="text-align:left">a</th><th style="text-align:center">b</th><th style="text-align:right">c</th></tr></thead><tbody><tr><td style="text-align:left">x</td><td style="text-align:center">y</td><td class="n" style="text-align:right">1</td></tr><tr><td style="text-align:left">|</td><td style="text-align:center"><code>q</code></td><td class="n" style="text-align:right">22</td></tr></tbody></table></div></div>');
  assert.match(md('a | b\n--|--\n1 | 2'), /<table><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead><tbody><tr><td class="n">1<\/td>/);
  assert.equal(md('| a | b |\n| - |'), '<p>| a | b | | - |</p>', 'a delimiter row with the wrong cell count is text');
});

test('fenced code blocks keep text and take a checked language class', () => {
  assert.equal(md('```js\nconst a = 1 < 2;\n```'), code('<code class="language-js">const a = 1 &lt; 2;</code>'));
  assert.equal(md('~~~\n# not a heading\n~~~'), code('<code># not a heading</code>'));
  assert.equal(md('```x"onload=1\nx\n```'), code('<code>x</code>'));
  assert.equal(md('````\n```\n````'), code('<code>```</code>'));
});

test('block quotes nest and hold lists', () => {
  assert.equal(md('> a\n> > b'), '<blockquote><p>a</p><blockquote><p>b</p></blockquote></blockquote>');
  assert.equal(md('> - a\n> - b'), '<blockquote><ul><li>a</li><li>b</li></ul></blockquote>');
  assert.equal(md('> a\nlazy'), '<blockquote><p>a lazy</p></blockquote>');
});

test('thematic breaks render as hr', () => {
  for (const rule of ['---', '***', '___', '- - -']) assert.equal(md(`a\n\n${rule}\n\nb`), '<p>a</p><hr><p>b</p>', rule);
});

// ---------- Inline ----------

test('code spans are not parsed further', () => {
  assert.equal(renderInlineMarkdown('`**x** <b>`'), '<code>**x** &lt;b&gt;</code>');
  assert.equal(renderInlineMarkdown('``a ` b``'), '<code>a ` b</code>');
  assert.equal(renderInlineMarkdown('`open'), '`open');
});

test('bold, italic, and strike render', () => {
  assert.equal(renderInlineMarkdown('**b** __b__ *i* _i_ ~~s~~'), '<strong>b</strong> <strong>b</strong> <em>i</em> <em>i</em> <del>s</del>');
  assert.equal(renderInlineMarkdown('***both***'), '<em><strong>both</strong></em>');
  assert.equal(renderInlineMarkdown('**a *b* c**'), '<strong>a <em>b</em> c</strong>');
  assert.equal(renderInlineMarkdown('snake_case_name and 2*3*4'), 'snake_case_name and 2<em>3</em>4');
  assert.equal(renderInlineMarkdown('a * b * c'), 'a * b * c');
});

test('links, titles, autolinks, and bare URLs render', () => {
  assert.equal(renderInlineMarkdown('[x](https://a.test/p?q=1&r=2 "T")'), '<a href="https://a.test/p?q=1&amp;r=2" title="T" target="_blank" rel="noopener noreferrer">x</a>');
  assert.equal(renderInlineMarkdown('[in](/mailbox?folder=inbox)'), '<a href="/mailbox?folder=inbox">in</a>');
  assert.equal(renderInlineMarkdown('[top](#top)'), '<a href="#top">top</a>');
  assert.equal(renderInlineMarkdown('<https://a.test>'), '<a href="https://a.test" target="_blank" rel="noopener noreferrer">https://a.test</a>');
  assert.equal(renderInlineMarkdown('<mailto:o@a.test>'), '<a href="mailto:o@a.test" target="_blank" rel="noopener noreferrer">o@a.test</a>');
  assert.equal(renderInlineMarkdown('see https://a.test/x_(y).'), 'see <a href="https://a.test/x_(y)" target="_blank" rel="noopener noreferrer">https://a.test/x_(y)</a>.');
  assert.equal(renderInlineMarkdown('[**b**](https://a.test)'), '<a href="https://a.test" target="_blank" rel="noopener noreferrer"><strong>b</strong></a>');
  assert.equal(renderInlineMarkdown('[a](https://a.test/(x))'), '<a href="https://a.test/(x)" target="_blank" rel="noopener noreferrer">a</a>');
});

test('backslash escapes the ASCII punctuation', () => {
  assert.equal(renderInlineMarkdown('\\*a\\* \\[b\\](c) \\`d\\` \\\\'), '*a* [b](c) `d` \\');
  assert.equal(renderInlineMarkdown('\\a'), '\\a');
});

// ---------- Fixture ----------

test('the neutral night report fixture renders to the snapshot', () => {
  const html = md(fixture('night-report.md'));
  assert.equal(html, fixture('night-report.html').trimEnd());
  assert.match(html, /<ol><li><strong>Atlas<\/strong><ul><li>Merged/, 'the ordered list holds the nested bullet list');
  assert.equal((html.match(/<table>/g) || []).length, 2);
  assert.match(html, /<td class="n" style="text-align:right">184,220<\/td>/);
  assert.match(html, /<code>~\/Projects\/Atlas\/out\/report.csv<\/code>/);
  assert.match(html, /Night report – 2026-09-29/);
  assertAllowed(html, 'fixture');
});

// ---------- Safety ----------

const ATTACKS = [
  '<script>alert(1)</script>',
  '<SCRIPT SRC=//x.test/x.js></SCRIPT>',
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)>',
  '<a href="javascript:alert(1)">x</a>',
  '<div><p><b onclick="x()">nested</b></p></div>',
  '<iframe src="https://x.test"></iframe>',
  '<style>body{display:none}</style>',
  '<!-- comment --><b>x',
  '<b>unclosed',
  '[x](javascript:alert(1))',
  '[x](JaVaScRiPt:alert(1))',
  '[x](javascript&colon;alert(1))',
  '[x](javascript&#58;alert(1))',
  '[x](javascript&#x3A;alert(1))',
  '[x](jav\tascript:alert(1))',
  '[x](&#106;avascript:alert(1))',
  '[x](data:text/html;base64,PHNjcmlwdD4=)',
  '[x](vbscript:msgbox(1))',
  '[x](//evil.test/path)',
  '[x](/\\evil.test)',
  '[x](https://a.test" onmouseover="alert(1))',
  '[x](https://a.test "t\\" onmouseover=\\"alert(1)")',
  '[x](https://a.test \'t" onclick="x\')',
  '<javascript:alert(1)>',
  '<https://a.test" onclick="x>',
  '[<img src=x onerror=alert(1)>](https://a.test)',
  '[x](https://a.test)<script>',
  '**<script>**alert(1)**</script>**',
  '`<script>`',
  '```\n<script>alert(1)</script>',
  '```js" onclick="x\ncode\n```',
  '| <b>a</b> | b |\n| - | - |\n| <img src=x onerror=1> |',
  '| a | b |\n| --- | --- |',
  '> <script>alert(1)</script>',
  '- [x] <img src=x onerror=1>',
  '# <script>alert(1)</script>',
  '[a](b)[c](javascript:d)[e](https://f.test)',
  '[[[[[x](javascript:alert(1))]]]]',
  'https://a.test/"onmouseover="alert(1)',
  '[x]( javascript:alert(1) )',
  '[x](&#0000106avascript:alert(1))',
  '&lt;script&gt;',
  '\u0000<script>',
];

test('the safety corpus renders no raw HTML, no event attribute, and no unsafe URL', () => {
  assert.ok(ATTACKS.length >= 30);
  for (const source of ATTACKS) {
    const html = md(source);
    assertAllowed(html, JSON.stringify(source));
    assert.ok(!/<(script|img|iframe|style|svg|b)\b/i.test(html), `raw tag for ${JSON.stringify(source)}: ${html}`);
  }
});

test('raw HTML shows as the source characters', () => {
  assert.equal(md('<b>x</b>'), '<p>&lt;b&gt;x&lt;/b&gt;</p>');
  assert.equal(md('<img src=x onerror=alert(1)>'), '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
});

test('an unsafe link renders its text without a link', () => {
  assert.equal(renderInlineMarkdown('[click](javascript:alert(1))'), 'click');
  assert.equal(renderInlineMarkdown('[click](JaVaScRiPt&colon;alert(1))'), 'click');
  assert.equal(renderInlineMarkdown('[click](data:text/html,x)'), 'click');
});

test('safeUrl accepts only http, https, mailto, a local path, and a fragment', () => {
  for (const url of ['https://a.test', 'HTTP://a.test', 'mailto:o@a.test', '/mailbox', '#x']) assert.ok(safeUrl(url), url);
  for (const url of ['javascript:x', ' javascript:x', 'java\u0000script:x', 'java\nscript:x', 'javascript&colon;x', '&#x6A;avascript:x', 'data:x', 'vbscript:x', 'file:///etc/passwd', '//evil.test', '/\\evil.test', 'ftp://a.test', '']) assert.equal(safeUrl(url), null, JSON.stringify(url));
});

test('a quote in a URL or a title stays inside the attribute', () => {
  const html = renderInlineMarkdown('[x](https://a.test/"q "a\\"b")');
  assert.match(html, /href="https:\/\/a.test\/&quot;q" title="a&quot;b"/);
  assertAllowed(html);
});

test('unclosed constructs render as text', () => {
  assert.equal(md('**bold'), '<p>**bold</p>');
  assert.equal(md('[text](https://a.test'), '<p>[text](<a href="https://a.test" target="_blank" rel="noopener noreferrer">https://a.test</a></p>');
  assert.equal(md('```\nopen fence'), code('<code>open fence</code>'));
  assert.equal(md('<https://a.test'), '<p>&lt;<a href="https://a.test" target="_blank" rel="noopener noreferrer">https://a.test</a></p>');
  assert.equal(md('| a | b |\n| --- | --- |'), '<div class="md-table-wrap"><div class="md-table" role="region" tabindex="0" aria-label="Table"><table><thead><tr><th>a</th><th>b</th></tr></thead></table></div></div>');
});

test('nesting deeper than the limit renders as text', () => {
  const deep = `${'> '.repeat(MAX_DEPTH + 4)}deep`;
  const html = md(deep);
  assert.equal((html.match(/<blockquote>/g) || []).length, MAX_DEPTH + 1);
  assert.match(html, /&gt; &gt; deep/);
  assertAllowed(html);
  const list = Array.from({ length: 20 }, (_, n) => `${'  '.repeat(n)}- item ${n}`).join('\n');
  assertAllowed(md(list));
});

test('pathological input renders in linear time', () => {
  const cases = ['['.repeat(10000), `${'['.repeat(10000)}x${']'.repeat(10000)}`, '*'.repeat(10000), '*a'.repeat(10000), '_a '.repeat(10000), '`'.repeat(10000), '` '.repeat(10000), '[](' .repeat(5000), '<'.repeat(10000), '> '.repeat(10000), '- '.repeat(5000), `${'  - x\n'.repeat(3000)}`, '| a |\n| - |\n' + '| b |\n'.repeat(5000), 'https://a.test/'.repeat(3000)];
  for (const source of cases) {
    const started = process.hrtime.bigint();
    const html = md(source);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 1500, `${JSON.stringify(source.slice(0, 12))} took ${ms} ms`);
    assertAllowed(html, JSON.stringify(source.slice(0, 12)));
  }
});

test('input over 200 KB is cut and marked', () => {
  const html = md('a'.repeat(210 * 1024));
  assert.ok(html.endsWith('<p>…</p>'));
});

// ---------- The browser walk ----------

// A minimal DOM stand-in with the node API that sanitizeRendered uses.
function element(localName, attrs = {}, children = []) {
  const node = {
    nodeType: 1, localName, parent: null, childNodes: [],
    get attributes() { return Object.entries(this.attrs).map(([name, value]) => ({ name, value })); },
    attrs: { ...attrs },
    getAttribute(name) { return this.attrs[name] ?? null; },
    removeAttribute(name) { delete this.attrs[name]; },
    remove() { this.parent.childNodes.splice(this.parent.childNodes.indexOf(this), 1); },
  };
  for (const child of children) { child.parent = node; node.childNodes.push(child); }
  return node;
}
const textNode = (value) => ({ nodeType: 3, value, remove() { this.parent.childNodes.splice(this.parent.childNodes.indexOf(this), 1); } });

// Builds the stand-in tree from renderer output. The renderer output is well formed, so a stack parser is enough.
function parseTree(html) {
  const rootNode = element('#root');
  const stack = [rootNode];
  const voids = new Set(['br', 'hr', 'input']);
  const re = /<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1];
    if (m[4]) { const t = textNode(m[4]); t.parent = top; top.childNodes.push(t); continue; }
    if (m[1]) { stack.pop(); continue; }
    const attrs = {};
    for (const a of m[3].matchAll(/\s([^\s=]+)(?:="([^"]*)")?/g)) attrs[a[1]] = (a[2] ?? '').replace(/&amp;/g, '&');
    const el = element(m[2], attrs);
    el.parent = top;
    top.childNodes.push(el);
    if (!voids.has(m[2])) stack.push(el);
  }
  return rootNode;
}

test('the browser walk removes nothing from renderer output', () => {
  const sources = [fixture('night-report.md'), ...ATTACKS, '- [x] a\n\n1. b\n\n> c\n\n---\n\n[l](https://a.test "t")'];
  for (const source of sources) assert.equal(sanitizeRendered(parseTree(md(source))), 0, JSON.stringify(source.slice(0, 40)));
});

test('the browser walk removes elements and attributes outside the allowlist', () => {
  const tree = element('#root', {}, [
    element('p', { onclick: 'x()', class: 'ok' }, [textNode('a')]),
    element('script', {}, [textNode('alert(1)')]),
    element('a', { href: 'javascript:alert(1)', target: '_blank' }),
    element('td', { style: 'background:url(x)' }),
    element('th', { style: 'text-align:right' }),
    element('input', { type: 'text' }),
    { nodeType: 8, remove() { this.parent.childNodes.splice(this.parent.childNodes.indexOf(this), 1); } },
  ]);
  tree.childNodes[6].parent = tree;
  assert.equal(sanitizeRendered(tree), 6);
  assert.deepEqual(tree.childNodes.map((n) => n.localName), ['p', 'a', 'td', 'th', 'input']);
  assert.deepEqual(tree.childNodes[0].attrs, { class: 'ok' });
  assert.deepEqual(tree.childNodes[1].attrs, { target: '_blank' });
  assert.deepEqual(tree.childNodes[3].attrs, { style: 'text-align:right' });
});

// ---------- The app ----------

test('the app renders message and chat text through the shared renderer', () => {
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.match(app, /^import \{[^}]*markdownOrPlain[^}]*\} from '\.\/markdown\.js';/m);
  assert.doesNotMatch(app, /function markdownHtml/);
  assert.match(app, /function messageBody[\s\S]{0,400}markdownBlock\(/);
  assert.match(app, /function chatBubble[\s\S]{0,2500}chat-bubble-text md">\$\{safeMarkdownHtml\(/);
  assert.match(app, /sanitizeRendered\(/);
});

// ---------- Review fixes ----------

test('deep emphasis nesting renders without a stack overflow and keeps the inner text as plain text', () => {
  const source = `${'*a '.repeat(30000)}b${'*'.repeat(30000)}`;
  assert.ok(source.length > 90000);
  const html = md(source);
  assertAllowed(html.slice(0, 20000), 'deep emphasis head');
  const depth = Math.max(...html.split(/(?=<\/?em>)/).reduce((acc, part) => {
    const last = acc.length ? acc[acc.length - 1] : 0;
    acc.push(part.startsWith('</em>') ? last - 1 : part.startsWith('<em>') ? last + 1 : last);
    return acc;
  }, []));
  assert.ok(depth <= MAX_INLINE_DEPTH, `em depth ${depth}`);
  assert.match(html, /a \*a \*a/, 'the emphasis beyond the limit shows its marks as text');
  assert.equal((html.match(/<em>/g) || []).length, (html.match(/<\/em>/g) || []).length);
  assert.equal(renderInlineMarkdown(`${'**'.repeat(20000)}x${'**'.repeat(20000)}`).length > 0, true);
});

test('markdownOrPlain falls back to escaped pre-wrap text when the renderer throws', () => {
  const html = markdownOrPlain('<b>x</b>\nline 2', () => { throw new RangeError('Maximum call stack size exceeded'); });
  assert.equal(html, '<p class="md-plain">&lt;b&gt;x&lt;/b&gt;\nline 2</p>');
  assertAllowed(html);
  assert.equal(markdownOrPlain('**a**'), '<p><strong>a</strong></p>');
  const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
  assert.match(css, /\.md-plain \{[^}]*white-space: pre-wrap/);
});

test('the app catches a render error and shows the escaped text', () => {
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function safeMarkdownHtml'), app.indexOf('function markdownBlock'));
  assert.match(fn, /markdownOrPlain\(key\)/);
  assert.match(fn, /try \{[\s\S]*sanitizeRendered\(template\.content\)[\s\S]*\} catch \{[\s\S]*plainTextHtml\(key\)/);
});

test('a table keeps at most 30 columns and drops the extra cells', () => {
  const cells = (n, f) => `| ${Array.from({ length: n }, (_, c) => f(c)).join(' | ')} |`;
  const source = [cells(40, (c) => `h${c}`), cells(40, () => '---'), cells(45, (c) => `v${c}`)].join('\n');
  const html = md(source);
  assert.equal((html.match(/<th>/g) || []).length, MAX_TABLE_COLUMNS);
  assert.equal((html.match(/<td[ >]/g) || []).length, MAX_TABLE_COLUMNS);
  assert.match(html, /<th>h29<\/th><\/tr>/);
  assert.doesNotMatch(html, /h30|v30|v44/);
  assert.equal(MAX_TABLE_COLUMNS, 30);
});

test('only exact attachment image URLs render lazy images with escaped alt text', () => {
  const url = `/attachments/att_${'a'.repeat(32)}`;
  const html = md(`![A "view" <test>](${url})`);
  assert.equal(html, `<p><img src="${url}" alt="A &quot;view&quot; &lt;test&gt;" loading="lazy" class="md-attachment"></p>`);
  assertAllowed(html);
  for (const target of ['https://example.invalid/image.png', 'http://example.invalid/image.png', 'data:image/png;base64,abc', 'relative.png', '//example.invalid/a', '/elsewhere/a.png', url + '?x=1', url + '.png', '/attachments/att_' + 'A'.repeat(32), url.replace('attachments', 'attach&#109;ents')]) {
    const rendered = md(`![plain alt](${target})`);
    assert.equal(rendered, '<p>plain alt</p>', target);
    assert.doesNotMatch(rendered, /<img|<a|src=/i);
  }
  assert.equal(md(`\`![code](${url})\``), `<p><code>![code](${url})</code></p>`);
  assert.equal(md(`\\![escaped](${url})`), `<p>!<a href="${url}">escaped</a></p>`);
});

test('the sanitizer keeps attachment images and removes other image sources and attributes', () => {
  const url = `/attachments/att_${'b'.repeat(32)}`;
  const tree = element('#root', {}, [
    element('img', { src: url, alt: 'Photo', loading: 'lazy', class: 'md-attachment' }),
    element('img', { src: 'https://example.invalid/photo.png' }),
    element('img', { src: url, srcset: 'https://example.invalid/other.png', onerror: 'x()', loading: 'eager' }),
  ]);
  assert.equal(sanitizeRendered(tree), 4);
  assert.equal(tree.childNodes.length, 2);
  assert.deepEqual(tree.childNodes[0].attrs, { src: url, alt: 'Photo', loading: 'lazy', class: 'md-attachment' });
  assert.deepEqual(tree.childNodes[1].attrs, { src: url });
});

test('a fenced code block has a copy button and the code text stays exact', () => {
  const source = 'a  <b> & "q"\n\n  indented\n# x';
  const html = md('```sh\n' + source + '\n```');
  assert.match(html, /^<div class="md-code"><button type="button" class="copy-btn" data-copy-code aria-label="Copy code">/);
  const inner = /<code class="language-sh">([^]*)<\/code><\/pre>/.exec(html)[1];
  assert.equal(inner, 'a  &lt;b&gt; &amp; &quot;q&quot;\n\n  indented\n# x');
  assert.ok(!/```|<span class="rv-ln"/.test(inner));
  assertAllowed(html, 'copy button');
  assert.equal(sanitizeRendered(parseTree(html)), 0);
});

test('every fenced block in a message gets its own button', () => {
  const html = md('```\none\n```\n\ntext\n\n~~~\ntwo\n~~~');
  assert.equal(html.match(/data-copy-code/g).length, 2);
});

test('inline code gets no copy button', () => {
  assert.ok(!/copy-btn/.test(md('use `npm test` now')));
});

test('a code block with tabs copies the source and shows four spaces', () => {
  const html = md('```make\nall:\n\techo ok\n```');
  assert.match(html, /data-copy-code="all:\n\techo ok"/);
  assert.match(html, /<code class="language-make">all:\n    echo ok<\/code>/);
  assert.ok(!/\t/.test(html.replace(/data-copy-code="[^"]*"/, '')));
});

test('a code block in a list or a quote keeps its tabs for the copy', () => {
  assert.match(md('- item\n\n  ```\n  a\tb\n  ```'), /data-copy-code="a\tb"/);
  assert.match(md('> ```\n> x\ty\n> ```'), /data-copy-code="x\ty"/);
});

test('a code block without a tab has a bare copy attribute and a tab elsewhere does not leak', () => {
  assert.match(md('```\nplain\n```'), /data-copy-code aria-label/);
  const html = md('a\tb\n\n```\nplain\n```');
  assert.match(html, /data-copy-code aria-label/);
  assert.equal(md('```\nplain\n```'), md('```\nplain\n```'));
});

test('a copy source with quotes and angle brackets stays inside the attribute', () => {
  const html = md('```\n"x"\t<b>&\n```');
  assert.match(html, /data-copy-code="&quot;x&quot;\t&lt;b&gt;&amp;"/);
  assertAllowed(html, 'tab source');
  assert.equal(sanitizeRendered(parseTree(html)), 0);
});
