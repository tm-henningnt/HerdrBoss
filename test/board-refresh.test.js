import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDocument, byKey } from './fake-dom.js';
import { patchHtml } from '../public/keyed.js';
import { KEYED_ROUTES } from '../public/routes.js';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const keyed = fs.readFileSync(new URL('../public/keyed.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

function body(signature) {
  const match = new RegExp(`function ${signature.replace(/[()]/g, '\\$&')} \\{([\\s\\S]*?)\\n\\}`).exec(app);
  assert.ok(match, `the UI defines ${signature}`);
  return match[1];
}

test('a render of the project page patches the page in place and does not replace it', () => {
  assert.match(app, /import \{ patchHtml \} from '\.\/keyed\.js';/);
  const renderBody = body('render(force = false)');
  assert.ok(KEYED_ROUTES.includes('projects') && KEYED_ROUTES.includes('board'), 'the registry keys the projects and board routes');
  assert.match(renderBody, /if \(KEYED_ROUTES\.includes\(route\) && lastRoute === route\) patchHtml\(\$app, html\);\s*else \$app\.innerHTML = html;/);
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

test('project live data uses stable view nodes and the server-derived values', () => {
  assert.ok(/from '\.\/project-live-view\.js'/.test(app), 'the project uses pure live-view helpers');
  assert.ok(/unplannedCardView\(worker, i\)/.test(body('boardBlock(p, slug)')), 'the Doing column maps unplanned workers');
  assert.ok(/if \(!tasks\.length && !unplanned\.length\) return ''/.test(body('boardBlock(p, slug)')), 'unplanned workers can show without published tasks');
  assert.ok(/noWorkerBadgeView\(t\)/.test(body('boardCard(t, ctx)')), 'Doing cards read the server noWorker flag');
  const projectBody = body('project(s, slug)');
  assert.ok(/publishedAgeBadgeView\(p\.publishedAgeMin, p\.statusStale\?\.level\)/.test(projectBody));
  assert.ok(/phaseAgeText\(p\.phaseAgeMin\)/.test(projectBody));
  assert.ok(/summaryAgeText\(p\.summaryAgeMin\)/.test(projectBody));
  assert.ok(/projectSyncLineView\(p\.sync\)/.test(projectBody));
  assert.ok(/data-key="project-sync"/.test(projectBody));
  assert.ok(/data-key="project-published-age"/.test(projectBody));
  assert.ok(/\.project-published-row\s*\{[^}]*min-height:\s*22px/.test(css), 'the published badge keeps its row height');
  assert.ok(/\.project-sync-line\s*\{[^}]*min-height:\s*1\.4em/.test(css), 'the sync line keeps its row height');
  assert.ok(/state === 'doing' \|\| noWorker \|\| pathBadge/.test(body('boardCard(t, ctx)')), 'Doing cards keep a badge row');
  assert.ok(/\.card-badges\s*\{[^}]*min-height:\s*18px/.test(css), 'the Doing badge row has a reserved height');
});

function liveProject(status, sync, selected = 'doing') {
  return `<section class="phead" data-key="project-head"><div data-key="project-published-age">${status}</div><p data-key="project-sync">${sync}</p></section>`
    + `<details data-key="section:board" open><div class="board" data-key="board:demo"><div data-key="board-cols"><section data-key="col:doing"><button data-key="tab:doing" aria-selected="${selected === 'doing'}">Doing</button><ol><li data-key="task:A"><button data-key="task-title:A">Task A</button></li></ol></section><section data-key="col:ready"><button data-key="tab:ready" aria-selected="${selected === 'ready'}">Ready</button></section></div></div></details>`;
}

test('a project refresh keeps scroll, focus, the open Board section, and the selected column', () => {
  globalThis.document = createDocument();
  const root = document.html(liveProject('status published 2 min ago', 'Agents 1 working, board Doing 1: in sync'));
  const board = byKey(root, 'board-cols');
  const taskTitle = byKey(root, 'task-title:A');
  root.scrollTop = 245;
  board.scrollLeft = 320;
  taskTitle.focus();

  patchHtml(root, liveProject('status published 3 min ago', 'Agents 2 working, board Doing 1: out of sync'));

  assert.equal(root.scrollTop, 245);
  assert.equal(byKey(root, 'board-cols'), board);
  assert.equal(board.scrollLeft, 320);
  assert.equal(byKey(root, 'task-title:A'), taskTitle);
  assert.equal(document.activeElement, taskTitle);
  assert.equal(byKey(root, 'section:board').getAttribute('open'), '');
  assert.equal(byKey(root, 'tab:doing').getAttribute('aria-selected'), 'true');
});

test('a phone project board opens Doing when it has only unplanned work', () => {
  const activeColumn = new Function('FLOW', 'view', 'counts', 'hasUnplanned', body('boardActiveColumn(view, counts, hasUnplanned = false)'));
  const counts = { blocked: 0, ready: 0, doing: 0, review: 0, done: 0 };
  const flow = ['blocked', 'ready', 'doing', 'review', 'done'];
  assert.equal(activeColumn(flow, {}, counts, true), 'doing');
  assert.equal(activeColumn(flow, {}, counts, false), 'ready');
  assert.equal(activeColumn(flow, { boardCol: 'review' }, counts, true), 'review');
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
  assert.match(renderBody, /readLocation\(location, history\)/);
  assert.match(renderBody, /projectView\(task\.slug\)\.selected = task\.id;/);
  assert.match(fs.readFileSync(new URL('../public/shell.js', import.meta.url), 'utf8'), /hist\.replaceState\(null, '', loc\.pathname \+ loc\.hash\);/);
  assert.match(fs.readFileSync(new URL('../public/routes.js', import.meta.url), 'utf8'), /new URLSearchParams\(search\)\.get\('task'\)/);
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
