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

test('the flow has five columns in order', () => {
  assert.deepEqual(FLOW, ['blocked', 'ready', 'doing', 'review', 'done']);
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
