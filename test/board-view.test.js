import test from 'node:test';
import assert from 'node:assert/strict';
import { FLOW, taskState, blockReasons, boardColumns, dependencyChain, criticalPath, graphTasks } from '../public/board.js';

const ids = (list) => list.map((t) => t.id);
const byId = (tasks) => new Map(tasks.filter((t) => t.id).map((t) => [t.id, t]));

// Invented neutral tasks. The overlay fields (state, worker, blockers) come from src/task-state.js.
function sample() {
  return [
    { id: 'A1', title: 'Spec', status: 'done', state: 'done', group: 'm1', updated: '2026-09-20T10:00:00Z' },
    { id: 'A2', title: 'Parser', status: 'doing', state: 'doing', group: 'm1', blockedBy: ['A1'], worker: { name: 'w-a2', model: 'model-x', startedAt: '2026-09-29T10:00:00Z' } },
    { id: 'A3', title: 'Errors', status: 'todo', state: 'blocked', group: 'm1', blockedBy: ['A2'], blockers: ['A2'], blockedReason: 'waits on task A2' },
    { id: 'A4', title: 'Retry', status: 'todo', state: 'blocked', group: 'm1', blockedBy: ['A3'], blockers: ['A3'] },
    { id: 'A5', title: 'Side task', status: 'todo', state: 'ready', group: 'm1' },
    { id: 'A6', title: 'Pick format', status: 'blocked', state: 'blocked', group: 'm1', waitingOn: 'owner', ask: 'Which format?' },
    { id: 'B1', title: 'Report', status: 'todo', state: 'blocked', group: 'm2', blockedBy: ['A4'], blockers: ['A4'] },
    { id: 'B2', title: 'Early report item', status: 'todo', state: 'ready', group: 'm2' },
    { id: 'A7', title: 'Sorted', status: 'review', state: 'review', group: 'm1', worker: { name: 'w-a7', model: 'model-y', startedAt: '2026-09-29T08:00:00Z' } },
    { id: 'A8', title: 'Next in chain', status: 'todo', state: 'ready', group: 'm1', blockedBy: ['A1'] },
  ];
}
const groups = [{ id: 'm1', title: 'M1' }, { id: 'm2', title: 'M2' }];

test('the flow has six columns in order', () => {
  assert.deepEqual(FLOW, ['blocked', 'ready', 'doing', 'stuck', 'review', 'done']);
});

test('taskState uses the overlay state and derives a state for a task without one', () => {
  const tasks = [
    { id: 'X', status: 'done' },
    { id: 'Y', status: 'todo', blockedBy: ['X'] },
    { id: 'Z', status: 'todo', blockedBy: ['Y'] },
    { id: 'W', status: 'todo', waitingOn: 'external' },
    { id: 'V', status: 'doing', blockedBy: ['Z'] },
    { id: 'U', status: 'todo', blockedBy: ['missing'] },
    { id: 'T', status: 'todo', state: 'doing' },
  ];
  const map = byId(tasks);
  assert.deepEqual(tasks.map((t) => taskState(t, map)), ['done', 'ready', 'blocked', 'blocked', 'doing', 'blocked', 'doing']);
});

test('blockReasons names each open blocker task and the waiting party', () => {
  const tasks = sample();
  const map = byId(tasks);
  assert.deepEqual(blockReasons(map.get('A3'), map), [{ kind: 'task', id: 'A2', known: true }]);
  assert.deepEqual(blockReasons(map.get('A6'), map), [{ kind: 'owner', ask: 'Which format?' }]);
  const external = { id: 'Q', status: 'blocked', blockedBy: ['A1', 'Z9'], waitingOn: 'external' };
  assert.deepEqual(blockReasons(external, map), [{ kind: 'task', id: 'Z9', known: false }, { kind: 'external', ask: null }], 'a done blocker is not a reason');
  assert.deepEqual(blockReasons(map.get('A5'), map), []);
});

test('boardColumns assigns each task to its flow column', () => {
  const board = boardColumns(sample(), { groups });
  assert.deepEqual(ids(board.columns.blocked), ['A3', 'A4', 'A6', 'B1']);
  assert.deepEqual(ids(board.columns.doing), ['A2']);
  assert.deepEqual(ids(board.columns.review), ['A7']);
  assert.deepEqual(ids(board.columns.done), ['A1']);
  assert.equal(board.counts.ready, 3);
});

test('Ready sorts by priority: the critical path, then the group order, then the published order', () => {
  const tasks = sample();
  tasks.push({ id: 'A9', title: 'On the path', status: 'todo', state: 'ready', group: 'm1' });
  tasks.find((t) => t.id === 'A2').blockedBy = ['A9'];
  tasks.find((t) => t.id === 'A2').state = 'blocked';
  const board = boardColumns(tasks, { groups });
  assert.deepEqual(ids(board.columns.ready), ['A9', 'A5', 'A8', 'B2']);
});

test('Done shows the last 10 by update time and counts the rest', () => {
  const tasks = Array.from({ length: 14 }, (_, i) => ({ id: `D${i}`, title: `d${i}`, status: 'done', updated: `2026-09-${String(10 + i).padStart(2, '0')}T00:00:00Z` }));
  tasks.push({ id: 'D-old', title: 'no time', status: 'done' });
  const board = boardColumns(tasks);
  assert.equal(board.columns.done.length, 10);
  assert.equal(board.columns.done[0].id, 'D13');
  assert.equal(board.counts.done, 15);
  assert.equal(board.hiddenDone, 5);
  const all = boardColumns(tasks, { showAllDone: true });
  assert.equal(all.columns.done.length, 15);
  assert.equal(all.columns.done.at(-1).id, 'D-old', 'a task without a time goes last');
  assert.equal(all.hiddenDone, 0);
});

test('dependencyChain holds the task, all its blockers, and all its dependents', () => {
  const tasks = sample();
  assert.deepEqual([...dependencyChain('A3', tasks)].sort(), ['A1', 'A2', 'A3', 'A4', 'B1']);
  assert.deepEqual([...dependencyChain('A5', tasks)], ['A5']);
  assert.deepEqual([...dependencyChain('nope', tasks)], []);
  const cycle = [{ id: 'P', blockedBy: ['Q'] }, { id: 'Q', blockedBy: ['P'] }];
  assert.deepEqual([...dependencyChain('P', cycle)].sort(), ['P', 'Q'], 'a cycle ends');
});

test('criticalPath is the longest open chain to the next milestone', () => {
  const tasks = sample();
  const result = criticalPath(tasks, groups);
  assert.equal(result.milestone.id, 'm1');
  assert.deepEqual(result.path, ['A2', 'A3', 'A4']);

  // With M1 done except for one task, the milestone moves on only when M1 has no open task.
  const later = tasks.map((t) => (t.group === 'm1' ? { ...t, state: 'done' } : t));
  const next = criticalPath(later, groups);
  assert.equal(next.milestone.id, 'm2');
  assert.deepEqual(next.path, ['B1']);

  // Without groups, the path runs to any open task.
  const flat = criticalPath(tasks.map(({ group, ...t }) => t), []);
  assert.equal(flat.milestone, null);
  assert.deepEqual(flat.path, ['A2', 'A3', 'A4', 'B1']);

  assert.deepEqual(criticalPath([{ id: 'X', status: 'done' }], []).path, []);
});

test('graphTasks keeps open work and the done blockers of open work when it filters to open work', () => {
  const tasks = sample();
  tasks.push({ id: 'Z1', title: 'Old', status: 'done', state: 'done' });
  assert.deepEqual(ids(graphTasks(tasks, { openOnly: true })).sort(), ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'B1', 'B2']);
  assert.equal(graphTasks(tasks, { openOnly: false }).length, tasks.length);
});

test('domPart gives a different id part to each different value', async () => {
  const { domPart } = await import('../public/board.js');
  const values = ['a b', 'a_b', 'a-b', 'a.b', 'a/b', 'ab', 'a__b', '_', ' ', 'æ'];
  const parts = values.map(domPart);
  assert.equal(new Set(parts).size, values.length, parts.join(' | '));
  for (const part of parts) assert.match(part, /^[A-Za-z0-9_-]+$/);
  assert.equal(domPart('A-12'), 'A-12', 'a plain id stays readable');
});

test('a task that blocks itself does not loop, and it stays out of the graph layers', async () => {
  const { graphDepths } = await import('../public/board.js');
  const tasks = [{ id: 'S', title: 'self', status: 'todo', blockedBy: ['S'] }, { id: 'T', title: 't', status: 'todo', blockedBy: ['S'] }];
  assert.deepEqual(criticalPath(tasks).path.length > 0, true);
  const depths = graphDepths(tasks);
  assert.equal(depths.get('S'), 0);
  assert.equal(depths.get('T'), 1);
});

test('the critical path and the graph depth handle a chain of 20000 tasks', async () => {
  const { graphDepths } = await import('../public/board.js');
  const n = 20000;
  const tasks = Array.from({ length: n }, (_, i) => ({ id: `L${i}`, title: `l${i}`, status: 'todo', blockedBy: i ? [`L${i - 1}`] : [] }));
  const result = criticalPath(tasks);
  assert.equal(result.path.length, n);
  assert.equal(result.path[0], 'L0');
  assert.equal(result.path.at(-1), `L${n - 1}`);
  const depths = graphDepths(tasks);
  assert.equal(depths.get(`L${n - 1}`), n - 1);
  // A cycle at the end of a long chain ends too.
  tasks[0].blockedBy = [`L${n - 1}`];
  assert.ok(criticalPath(tasks).path.length <= n);
  assert.equal(graphDepths(tasks).size, n);
});

test('a Blocked card with waitingOn task and no open blocker gets a reason', () => {
  const tasks = [
    { id: 'D', title: 'done', status: 'done' },
    { id: 'W', title: 'waits on a task', status: 'blocked', state: 'blocked', waitingOn: 'task', blockedBy: ['D'] },
    { id: 'N', title: 'no reason', status: 'blocked', state: 'blocked' },
  ];
  const map = byId(tasks);
  assert.deepEqual(blockReasons(map.get('W'), map), [{ kind: 'task', id: null, known: false }]);
  assert.deepEqual(blockReasons(map.get('N'), map), [{ kind: 'unstated', ask: null }]);
});

// Invented neutral projects for the cross-project board.
function fleet(now) {
  const hour = 3600000;
  const at = (h) => new Date(now - h * hour).toISOString();
  return [
    { slug: 'north', project: 'North', tasks: [
      { id: 'N1', title: 'Old done', status: 'done', state: 'done', updated: at(30) },
      { id: 'N2', title: 'Fresh done', status: 'done', state: 'done', updated: at(2) },
      { id: 'N3', title: 'Build', status: 'doing', state: 'doing', worker: { name: 'w-n3', kind: 'claude', model: 'model-a', startedAt: at(1) } },
      { id: 'N4', title: 'Needs a choice', status: 'blocked', state: 'blocked', waitingOn: 'owner', ask: 'Which one?' },
      { id: 'N5', title: 'After build', status: 'todo', state: 'blocked', blockedBy: ['N3'], blockers: ['N3'] },
    ] },
    { slug: 'south', project: 'South', tasks: [
      { id: 'S1', title: 'Check', status: 'review', state: 'review', worker: { name: 'w-s1', kind: 'codex', model: 'model-b', startedAt: at(5) } },
      { id: 'S2', title: 'Ready work', status: 'todo', state: 'ready' },
      { id: 'S3', title: 'Long run', status: 'doing', state: 'doing', worker: { name: 'w-s3', kind: 'codex', model: 'model-b', startedAt: at(4) } },
      { id: 'S4', title: 'Done, no time', status: 'done', state: 'done' },
    ] },
    { slug: 'empty', project: 'Empty' },
  ];
}

test('fleetItems holds each open task of each project and the done tasks of the last 24 hours', async () => {
  const { fleetItems, fleetColumns, DONE_WINDOW_MS } = await import('../public/board.js');
  const now = Date.parse('2026-09-30T12:00:00Z');
  assert.equal(DONE_WINDOW_MS, 24 * 3600000);
  const items = fleetItems(fleet(now), { now });
  assert.deepEqual(items.map((i) => `${i.slug}/${i.task.id}`).sort(), ['north/N2', 'north/N3', 'north/N4', 'north/N5', 'south/S1', 'south/S2', 'south/S3']);
  const board = fleetColumns(items);
  assert.deepEqual(board.counts, { blocked: 2, ready: 1, doing: 2, stuck: 0, review: 1, done: 1 });
  assert.deepEqual(board.columns.doing.map((i) => i.task.id), ['S3', 'N3'], 'the longest-running worker comes first');
  assert.equal(items.find((i) => i.task.id === 'N5').key, 'north/N5');
});

test('fleetFilter filters by project, by who the task waits on or who works on it, by state, and by a search', async () => {
  const { fleetItems, fleetFilter, fleetWho } = await import('../public/board.js');
  const now = Date.parse('2026-09-30T12:00:00Z');
  const items = fleetItems(fleet(now), { now });
  const ids = (list) => list.map((i) => i.task.id).sort();
  assert.deepEqual(ids(fleetFilter(items, { project: 'south' })), ['S1', 'S2', 'S3']);
  assert.deepEqual(ids(fleetFilter(items, { who: 'owner' })), ['N4']);
  assert.deepEqual(ids(fleetFilter(items, { who: 'worker' })), ['N3', 'S1', 'S3']);
  assert.deepEqual(ids(fleetFilter(items, { who: 'kind:codex' })), ['S1', 'S3']);
  assert.deepEqual(ids(fleetFilter(items, { who: 'model:model-a' })), ['N3']);
  assert.deepEqual(ids(fleetFilter(items, { state: 'blocked' })), ['N4', 'N5']);
  assert.deepEqual(ids(fleetFilter(items, { query: 'which' })), ['N4'], 'the search reads the ask');
  assert.deepEqual(ids(fleetFilter(items, { query: 'w-s3' })), ['S3'], 'the search reads the worker name');
  assert.deepEqual(ids(fleetFilter(items, { query: 'SOUTH ready' })), ['S2'], 'each word must match, in any case');
  assert.deepEqual(fleetWho(items), { kinds: ['claude', 'codex'], models: ['model-a', 'model-b'] });
});

test('the board counts a task that waits for the Owner from a Mailbox link or waitingOn, never from the published text', async () => {
  const { fleetItems, fleetFilter, waitsForOwner } = await import('../public/board.js');
  const now = Date.parse('2026-09-30T12:00:00Z');
  const projects = [
    { slug: 'north', project: 'North', phase: 'Waiting for the Owner', summary: 'Waiting for the Owner.', tasks: [
      { id: 'N1', title: 'Linked wait', status: 'blocked', mailboxId: 'm1' },
      { id: 'N2', title: 'Named wait', status: 'blocked', waitingOn: 'owner', ask: 'Which one?' },
      { id: 'N3', title: 'Done wait', status: 'done', state: 'done', waitingOn: 'owner', ask: 'Old', updated: new Date(now - 60000).toISOString() },
      { id: 'N4', title: 'Plain work', status: 'todo' },
    ] },
  ];
  const items = fleetItems(projects, { now });
  const ids = (list) => list.map((i) => i.task.id).sort();
  assert.deepEqual(ids(fleetFilter(items, { who: 'owner' })), ['N1', 'N2'], 'a Mailbox link or waitingOn owner counts; a done task does not');
  assert.equal(waitsForOwner({ status: 'todo', mailboxId: 'm1' }), true);
  assert.equal(waitsForOwner({ status: 'todo', waitingOn: 'owner' }), true);
  assert.equal(waitsForOwner({ status: 'done', mailboxId: 'm1' }), false);
  assert.equal(waitsForOwner({ status: 'done', waitingOn: 'owner' }), false);
  assert.equal(waitsForOwner({ status: 'todo' }), false);
  assert.equal(waitsForOwner({ status: 'todo', mailboxId: '   ' }), false);
});

test('a blockedBy that is not an array, and a title that is not a string, break no board function', async () => {
  const { graphDepths, fleetItems, fleetFilter, blockerIds } = await import('../public/board.js');
  const tasks = [
    { id: 'A', title: 42, status: 'todo', blockedBy: 7 },
    { id: 'B', title: 'object blockers', status: 'todo', blockedBy: { id: 'A' } },
    { id: 'C', title: 'string blocker', status: 'todo', blockedBy: 'A' },
    { id: 'D', title: null, status: 'todo', blockedBy: ['A'] },
  ];
  assert.deepEqual(blockerIds(tasks[0]), []);
  assert.deepEqual(blockerIds(tasks[3]), ['A']);
  assert.deepEqual([...graphDepths(tasks)].sort(), [['A', 0], ['B', 0], ['C', 0], ['D', 1]]);
  assert.doesNotThrow(() => dependencyChain('A', tasks));
  assert.doesNotThrow(() => graphTasks(tasks));
  assert.doesNotThrow(() => criticalPath(tasks));
  const items = fleetItems([{ slug: 'p', tasks }], { now: Date.now() });
  assert.deepEqual(fleetFilter(items, { query: '42' }).map((i) => i.task.id), ['A']);
  assert.deepEqual(fleetFilter(items, { query: 'object' }).map((i) => i.task.id), ['B']);
});

test('a done task with an update time in the future is not in the last 24 hours', async () => {
  const { fleetItems } = await import('../public/board.js');
  const now = Date.parse('2026-09-30T12:00:00Z');
  const tasks = [
    { id: 'F', title: 'future', status: 'done', updated: '2026-10-01T12:00:00Z' },
    { id: 'N', title: 'now', status: 'done', updated: '2026-09-30T12:00:00Z' },
    { id: 'E', title: 'edge', status: 'done', updated: '2026-09-29T12:00:00Z' },
  ];
  assert.deepEqual(fleetItems([{ slug: 'p', tasks }], { now }).map((i) => i.task.id), ['N', 'E']);
});

test('the elapsed time of a Doing card changes only once a minute after the first minute', async () => {
  const { elapsedText } = await import('../public/board.js');
  const start = '2026-09-30T10:00:00Z';
  const at = (sec) => Date.parse(start) + sec * 1000;
  assert.equal(elapsedText(start, at(42)), '42s');
  assert.equal(elapsedText(start, at(60)), '1m');
  assert.equal(elapsedText(start, at(119)), '1m');
  assert.equal(elapsedText(start, at(3 * 3600 + 5 * 60 + 59)), '3h 5m');
  assert.equal(elapsedText(start, at(2 * 86400 + 3600 + 30)), '2d 1h');
  assert.equal(elapsedText(start, at(-5)), '0s', 'a start in the future counts as now');
  assert.equal(elapsedText('not a time', at(10)), '');
  const polls = new Set([0, 10, 20, 30, 40, 50].map((s) => elapsedText(start, at(600 + s))));
  assert.equal(polls.size, 1, 'six polls in one minute give one text');
});

test('a task of a finished, not collected worker stays in Review, and a merged task is Done', () => {
  const tasks = [
    { id: 'F1', title: 'Finished', status: 'doing', state: 'review', stateSource: 'finished, not collected (worker w-f1)', worker: { name: 'w-f1' } },
    { id: 'F2', title: 'Merged', status: 'doing', state: 'done', stateSource: 'merged from worker w-f2', worker: { name: 'w-f2' }, updated: '2026-09-30T10:00:00Z' },
    { id: 'F3', title: 'Gone', status: 'doing', state: 'ready', stateSource: 'worker w-f3 abandoned' },
  ];
  const map = byId(tasks);
  assert.deepEqual(tasks.map((t) => taskState(t, map)), ['review', 'done', 'ready']);
  const board = boardColumns(tasks, { groups: [] });
  assert.deepEqual(ids(board.columns.review), ['F1']);
  assert.deepEqual(ids(board.columns.ready), ['F3']);
});
