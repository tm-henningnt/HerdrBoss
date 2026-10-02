import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FLOW, FLOW_LABEL, taskState, boardColumns, fleetItems, fleetColumns, visibleLanes, cardFacts, divergenceText, durationText, agoText } from '../public/board.js';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

const MIN = 60000;
const NOW = Date.parse('2026-10-02T10:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

// The task fields that the service adds (src/board-facts.js).
function card(id, extra = {}) {
  return { id, title: `Task ${id}`, status: 'todo', state: 'ready', publishedState: 'todo', computedState: 'todo', source: null, diverges: false, stuck: null, ...extra };
}
const merged = (id, publishedState = 'doing', at = NOW - 3 * 60 * MIN) => card(id, {
  status: publishedState, state: 'done', publishedState, computedState: 'done', diverges: publishedState !== 'done', source: { kind: 'commit', ref: 'abc1234', at: iso(at) },
});
const stuck = (id, ageMin = 190) => card(id, {
  status: 'doing', state: 'doing', publishedState: 'doing', computedState: 'stuck',
  stuck: { reason: `no live worker and no commit for ${Math.floor(ageMin / 60)} hours`, ageMin },
});

function body(signature) {
  const match = new RegExp(`function ${signature.replace(/[()]/g, '\\$&')} \\{([\\s\\S]*?)\\n\\}`).exec(app);
  assert.ok(match, `the UI defines ${signature}`);
  return match[1];
}

test('the age texts use whole units', () => {
  assert.equal(agoText(iso(NOW - 20 * 1000), NOW), 'just now');
  assert.equal(agoText(iso(NOW - MIN), NOW), '1 minute ago');
  assert.equal(agoText(iso(NOW - 45 * MIN), NOW), '45 minutes ago');
  assert.equal(agoText(iso(NOW - 3 * 60 * MIN - 5 * MIN), NOW), '3 hours ago');
  assert.equal(agoText(iso(NOW - 60 * MIN), NOW), '1 hour ago');
  assert.equal(agoText(iso(NOW - 49 * 60 * MIN), NOW), '2 days ago');
  assert.equal(agoText(null, NOW), '');
  assert.equal(durationText(45), '45 min');
  assert.equal(durationText(190), '3 h 10 min');
  assert.equal(durationText(120), '2 h');
  assert.equal(durationText(26 * 60), '1 d 2 h');
});

test('a card with a commit fact shows the auto badge and the short commit id', () => {
  const facts = cardFacts(merged('T1', 'done'), NOW);
  assert.deepEqual(facts, { auto: true, fact: 'abc1234', factTitle: 'merged abc1234 3 hours ago', diverge: null, stuck: null });
});

test('a card whose published state differs shows both states and the fact', () => {
  const facts = cardFacts(merged('T1'), NOW);
  assert.equal(facts.diverge, 'published: doing, computed: done, merged abc1234 3 hours ago');
});

test('the fact of a worker and of an issue names the worker or the issue number', () => {
  const worker = card('T2', { status: 'doing', state: 'review', publishedState: 'doing', computedState: 'review', diverges: true, source: { kind: 'worker', ref: 'bd2b', at: iso(NOW - 10 * MIN) } });
  assert.equal(cardFacts(worker, NOW).fact, 'bd2b');
  assert.equal(cardFacts(worker, NOW).diverge, 'published: doing, computed: review, worker bd2b 10 minutes ago');
  const issue = card('T3', { status: 'doing', state: 'done', publishedState: 'doing', computedState: 'done', diverges: true, source: { kind: 'issue', ref: '12', at: null } });
  assert.equal(cardFacts(issue, NOW).fact, '#12');
  assert.equal(cardFacts(issue, NOW).diverge, 'published: doing, computed: done, issue #12');
});

test('a card without a fact has no auto badge and no divergence', () => {
  assert.deepEqual(cardFacts(card('T4'), NOW), { auto: false, fact: '', factTitle: '', diverge: null, stuck: null });
  assert.equal(cardFacts({ id: 'X', title: 'x', status: 'todo' }, NOW).auto, false, 'a task from an older service has no source field');
});

test('a stuck card shows the reason and the age', () => {
  const facts = cardFacts(stuck('T5'), NOW);
  assert.deepEqual(facts.stuck, { reason: 'no live worker and no commit for 3 hours', age: 'Last activity 3 h 10 min ago' });
});

test('the divergence line counts the cards and names the ids', () => {
  assert.equal(divergenceText({ boardDiverged: 0, boardDivergedIds: [] }), '');
  assert.equal(divergenceText({}), '');
  assert.equal(divergenceText({ boardDiverged: 1, boardDivergedIds: ['A'] }), '1 card differs from git: A. Publish the status with --sync.');
  assert.equal(divergenceText({ boardDiverged: 2, boardDivergedIds: ['A', 'B'] }), '2 cards differ from git: A, B. Publish the status with --sync.');
});

test('a stuck card is in the Stuck lane and the lane shows only with a stuck card', () => {
  assert.deepEqual(FLOW, ['blocked', 'ready', 'doing', 'stuck', 'review', 'done']);
  assert.equal(FLOW_LABEL.stuck, 'Stuck');
  assert.equal(taskState(stuck('S')), 'stuck');
  assert.equal(taskState(card('D', { status: 'doing', state: 'doing', computedState: 'doing' })), 'doing');
  const tasks = [stuck('S1', 200), stuck('S2', 400), card('D', { status: 'doing', state: 'doing', computedState: 'doing' }), merged('M')];
  const board = boardColumns(tasks);
  assert.deepEqual(board.columns.stuck.map((t) => t.id), ['S2', 'S1'], 'the oldest stuck card comes first');
  assert.deepEqual(board.columns.doing.map((t) => t.id), ['D']);
  assert.equal(board.counts.stuck, 2);
  assert.deepEqual(visibleLanes(board.counts), ['blocked', 'ready', 'doing', 'stuck', 'review', 'done']);
  assert.deepEqual(visibleLanes({ ...board.counts, stuck: 0 }), ['blocked', 'ready', 'doing', 'review', 'done']);
  assert.deepEqual(visibleLanes({}), ['blocked', 'ready', 'doing', 'review', 'done']);
});

test('the Board page puts a stuck card in the Stuck column and counts the computed state', () => {
  const project = { slug: 'p', tasks: [stuck('S1'), merged('M', 'doing', NOW - 60 * MIN)] };
  const items = fleetItems([project], { now: NOW });
  const { columns, counts } = fleetColumns(items);
  assert.deepEqual(columns.stuck.map((i) => i.task.id), ['S1']);
  assert.deepEqual(columns.done.map((i) => i.task.id), ['M']);
  assert.equal(counts.stuck, 1);
  assert.equal(counts.doing, 0);
});

test('both boards render the card facts, the divergence line and the Stuck lane', () => {
  assert.match(body('boardCard(t, ctx)'), /cardFactsView\(t, ctx\.now\)/);
  assert.match(body('fleetCard(item, { chip, now })'), /cardFactsView\(t, now\)/);
  const view = body('cardFactsView(t, now)');
  assert.match(view, /class="auto-badge"/);
  assert.match(view, /class="card-fact mono"/);
  assert.match(view, /class="card-diverge"/);
  assert.match(view, /class="card-stuck"/);
  assert.match(view, /data-key="card-auto"/);
  const block = body('boardBlock(p, slug)');
  assert.match(block, /visibleLanes\(b\.counts\)/);
  assert.match(block, /divergenceText\(p\)/);
  assert.match(block, /data-key="board-diverge"/);
  assert.match(block, /has-stuck/);
  assert.match(app, /const BOARD_EMPTY = \{[^}]*stuck: /);
  assert.match(app, /const FLEET_EMPTY = \{[^}]*stuck: /);
  assert.match(body('boardView(s)'), /visibleLanes\(summary\)/);
  assert.match(body('boardView(s)'), /divergenceText\(p\)/);
});

test('a phone opens the Stuck tab only when it has cards', () => {
  const activeColumn = new Function('FLOW', 'view', 'counts', 'hasUnplanned', body('boardActiveColumn(view, counts, hasUnplanned = false)'));
  const counts = { blocked: 0, ready: 0, doing: 0, stuck: 0, review: 0, done: 0 };
  assert.equal(activeColumn(FLOW, { boardCol: 'stuck' }, counts, false), 'ready', 'a saved Stuck tab falls back when the lane is gone');
  assert.equal(activeColumn(FLOW, { boardCol: 'stuck' }, { ...counts, stuck: 1 }, false), 'stuck');
  assert.equal(activeColumn(FLOW, {}, { ...counts, stuck: 1 }, false), 'stuck', 'a stuck card needs attention before a ready card');
  assert.equal(activeColumn(FLOW, {}, { ...counts, doing: 1, stuck: 1 }, false), 'doing');
});

test('the style holds the Stuck color, the badges and the six-lane layout, and keeps one phone block', () => {
  assert.match(css, /--st-stuck: #[0-9a-f]{6}/i);
  assert.match(css, /\.st-stuck \{ --st: var\(--st-stuck\); \}/);
  assert.match(css, /\.auto-badge \{/);
  assert.match(css, /\.card-diverge \{/);
  assert.match(css, /\.card-stuck \{/);
  assert.match(css, /\.board-cols\.has-stuck \{[^}]*repeat\(6,/);
  assert.match(css, /\.kb-counts\.has-stuck \{[^}]*repeat\(6,/);
  // The phone tab bar gets the sixth tab inside the existing board block. The 44 px rule of the tab stays.
  const phone = /@media \(max-width: 760px\), \(pointer: coarse\) and \(max-height: 500px\) \{([\s\S]*?)\n\}/.exec(css.slice(css.indexOf('.dep-btn, .dep-close { min-height: 44px; }') - 200));
  assert.ok(phone, 'the board phone block exists');
  assert.match(phone[1], /\.board-tabs\.has-stuck \{[^}]*repeat\(6,/);
  assert.match(phone[1], /\.board-tab \{[^}]*min-height: 48px/);
  assert.equal((css.match(/\.board-tabs\.has-stuck/g) || []).length, 1, 'one phone rule for the sixth tab');
});
