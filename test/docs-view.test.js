import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { docsPageName, docsUrl, docsNeighbors, docsViewHtml, docsPageTitle } from '../public/docs-view.js';
import { renderMarkdown, headingSlug } from '../public/markdown.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const tree = { sections: [{ title: 'Start', pages: [{ name: '', title: 'Front' }, { name: 'a', title: 'A <b>' }] }, { title: 'Guide', pages: [{ name: 'guide/x', title: 'X' }] }] };

test('an address maps to a page name', () => {
  assert.equal(docsPageName('/docs'), '');
  assert.equal(docsPageName('/docs/'), '');
  assert.equal(docsPageName('/docs/guide/x'), 'guide/x');
  assert.equal(docsPageName('/docs/guide%20x/'), 'guide x');
  assert.equal(docsPageName('/documents'), null);
  assert.equal(docsPageName('/board'), null);
  assert.equal(docsUrl('guide/x', '#d-y'), '/docs/guide/x#d-y');
  assert.equal(docsUrl(''), '/docs');
});

test('the previous and next pages follow the tree', () => {
  assert.deepEqual(docsNeighbors(tree, 'a'), { prev: tree.sections[0].pages[0], next: tree.sections[1].pages[0] });
  assert.deepEqual(docsNeighbors(tree, ''), { prev: null, next: tree.sections[0].pages[1] });
  assert.deepEqual(docsNeighbors(tree, 'none'), { prev: null, next: null });
});

test('the view escapes titles, marks the current page, and shows the states', () => {
  const page = { name: 'a', title: 'A <b>', source: 'docs/a.md', html: '<h1 id="d-a">A</h1>', headings: [{ level: 2, text: 'One', id: 'd-one' }, { level: 2, text: 'Two', id: 'd-two' }] };
  const html = docsViewHtml({ tree, name: 'a', page });
  assert.match(html, /<a href="\/docs\/a" aria-current="page">A &lt;b&gt;<\/a>/);
  assert.match(html, /data-docs-nav-toggle aria-expanded="false" aria-controls="docs-nav"/);
  assert.match(html, /<a href="#d-two">Two<\/a>/);
  assert.match(html, /Source: <code>docs\/a\.md<\/code>/);
  assert.match(html, /class="docs-prev" href="\/docs"/);
  assert.match(html, /class="docs-next" href="\/docs\/guide\/x"/);
  assert.match(docsViewHtml({ tree: null, name: 'a' }), /Loading/);
  assert.match(docsViewHtml({ tree, name: 'zz', error: 'Page not found.' }), /Page not found\.[\s\S]*Docs front page/);
  assert.equal(docsPageTitle(page), 'A <b> · Docs · Herdr Boss');
  assert.equal(docsPageTitle(undefined), 'Docs · Herdr Boss');
  const help = docsViewHtml({ tree, name: 'help/board', page: { name: 'help/board', title: 'Board help', source: 'docs/help/board.md', html: '', headings: [] } });
  assert.match(help, /also shows in the Help panel of the Board page/);
});

test('docs mode renders headings from h1, with ids, and leaves the default render alone', () => {
  const source = '# One\n\n## Two words\n\n## Two words\n\n[x](a.md#y) ![i](p.png)';
  const seen = [];
  const docs = { link: (raw) => (raw === 'a.md#y' ? '/docs/a#d-y' : null), image: (raw) => (raw === 'p.png' ? '/docs/images/p.png' : null) };
  const html = renderMarkdown(source, { headingOffset: 0, minHeading: 1, headingIds: 'd-', onHeading: (h) => seen.push(h.id), docs });
  assert.match(html, /<h1 id="d-one">One<\/h1><h2 id="d-two-words">Two words<\/h2><h2 id="d-two-words-1">Two words<\/h2>/);
  assert.match(html, /<a href="\/docs\/a#d-y">x<\/a> <img src="\/docs\/images\/p\.png" alt="i" loading="lazy" class="md-image">/);
  assert.deepEqual(seen, ['d-one', 'd-two-words', 'd-two-words-1']);
  // Without the hooks a relative link and a local image stay text, as before.
  assert.doesNotMatch(renderMarkdown(source), /<a |<img|id=/);
  // A hook cannot write an unsafe URL.
  const bad = renderMarkdown('[x](a) ![i](b)', { docs: { link: () => 'javascript:alert(1)', image: () => 'https://example.com/x.png' } });
  assert.doesNotMatch(bad, /<a |<img/);
  assert.equal(headingSlug('The `API` & [links](x.md)!'), 'the-api--links');
});

test('help text lives in docs/help and not in app.js', () => {
  const app = read('public/app.js');
  const files = /const HELP_FILES = \[([^\]]*)\]/.exec(app)[1].match(/'([a-z0-9-]+)'/g).map((t) => t.slice(1, -1));
  assert.deepEqual(files, ['board', 'browsers', 'docs', 'fleet']);
  const help = app.slice(app.indexOf('const HELP = {'), app.indexOf('const HELP_FILES'));
  for (const topic of files) {
    const md = read(`docs/help/${topic}.md`);
    assert.match(md, /^# [A-Z][^\n]* help\n/, `${topic} starts with its title`);
    assert.doesNotMatch(help, new RegExp(`^  ${topic}: \\[`, 'm'), `${topic} has no second copy in app.js`);
  }
});

test('the dashboard links to the Docs section from the menu and from the Help panel', () => {
  const app = read('public/app.js');
  assert.match(app, /docsLink\.href = '\/docs'/);
  assert.match(app, /\$nav\.insertBefore\(docsLink, \$roamgate\)/);
  assert.match(app, /docs: 'Docs'/);
  assert.match(app, /href="\/docs\/start-here">Start here<\/a> in the Docs/);
  assert.match(read('public/index.html'), /href="\/docs\.css"/);
});
