import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const keyed = fs.readFileSync(new URL('../public/keyed.js', import.meta.url), 'utf8');

function body(signature) {
  const match = new RegExp(`function ${signature.replace(/[()]/g, '\\$&')} \\{([\\s\\S]*?)\\n\\}`).exec(app);
  assert.ok(match, `the UI defines ${signature}`);
  return match[1];
}

test('a render of the project page patches the page in place and does not replace it', () => {
  assert.match(app, /import \{ patchHtml \} from '\.\/keyed\.js';/);
  const renderBody = body('render(force = false)');
  assert.match(renderBody, /if \(\(route === 'projects' \|\| route === 'board'\) && lastRoute === route\) patchHtml\(\$app, html\);\s*else \$app\.innerHTML = html;/);
  assert.match(renderBody, /lastRoute = route;/);
  assert.match(renderBody, /syncBoards\(\);/);
});

test('the board cards, the columns, and the graph nodes and edges have stable keys', () => {
  assert.match(body('boardCard(t, ctx)'), /data-key="task:\$\{esc\(key\)\}"/);
  const board = body('boardBlock(p, slug)');
  assert.match(board, /data-key="col:\$\{k\}"/);
  assert.match(board, /data-key="board:\$\{esc\(slug\)\}"/);
  const graph = body('dependencyGraph(p, slug)');
  assert.match(graph, /data-key="node:\$\{esc\(key\)\}"/);
  assert.match(graph, /data-key="edge:\$\{esc\(a\)\}>\$\{esc\(b\)\}"/);
  assert.match(graph, /data-key="graph:\$\{esc\(slug\)\}"/);
  // The zoom and pan live in the viewBox that depTransform sets. A patch keeps it.
  assert.match(graph, /data-keep-attrs="viewBox"/);
});

test('the keyed patch matches keyed elements by key and keeps a focused field', () => {
  assert.match(keyed, /export function patchChildren\(from, to\)/);
  assert.match(keyed, /keyed\.get\(key\)/);
  assert.match(keyed, /from\.insertBefore\(match, cursor\)/);
  assert.match(keyed, /node === document\.activeElement/);
  assert.match(keyed, /data-keep-attrs/);
});

test('the automatic refresh of the project page goes through the keyed patch', () => {
  // refreshExtras clears lastRender for the project page; render then patches instead of replacing.
  const keeps = new Function('pathname', body('refreshForcesRender(pathname)'));
  assert.equal(keeps('/projects/sample'), true);
  assert.doesNotMatch(body('boardBlock(p, slug)'), /innerHTML/);
});

test('the Board page patches in place and keys each card by project and task', () => {
  const view = body('boardView(s)');
  assert.match(view, /data-key="fleet:mixed"/);
  assert.match(view, /data-key="fleet:lanes"/);
  assert.match(view, /data-key="lane:\$\{esc\(p\.slug\)\}"/);
  assert.match(view, /data-key="col:\$\{k\}"/);
  assert.match(body('fleetCard(item, { chip, now })'), /data-key="task:\$\{esc\(item\.key\)\}"/);
  assert.doesNotMatch(view, /innerHTML/);
  const keeps = new Function('pathname', body('refreshForcesRender(pathname)'));
  assert.equal(keeps('/board'), true);
});

test('a Board card links to the project page with the task selected, and the project page reads the task once', () => {
  assert.match(app, /function fleetTaskUrl\(slug, id\) \{\s*return `\/projects\/\$\{encodeURIComponent\(slug\)\}\?task=\$\{encodeURIComponent\(id\)\}`;/);
  const renderBody = body('render(force = false)');
  assert.match(renderBody, /new URLSearchParams\(location\.search\)\.get\('task'\)/);
  assert.match(renderBody, /projectView\(slug\)\.selected = pick;/);
  assert.match(renderBody, /history\.replaceState\(null, '', location\.pathname \+ location\.hash\);/);
});

test('the Board search renders once, 150 ms after the last key', () => {
  const handler = /let fleetQueryTimer = null;\s*document\.addEventListener\('input', \(e\) => \{([\s\S]*?)\n\}\);/.exec(app);
  assert.ok(handler, 'the search input handler has its own timer');
  assert.match(handler[1], /clearTimeout\(fleetQueryTimer\);/);
  assert.match(handler[1], /setTimeout\([\s\S]*render\(\);[\s\S]*\}, 150\);/);
  assert.doesNotMatch(handler[1].split('setTimeout')[0], /render\(\)/, 'no render before the timer');
  // Both boards use elapsedText, so a poll inside a minute gives the same card HTML.
  assert.equal(app.match(/const elapsed = state === 'doing' \? elapsedText\(w\?\.startedAt, now\) : '';/g)?.length, 2);
});
