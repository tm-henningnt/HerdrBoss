// Pure view logic of the project board and the dependency graph. Both use the same states.
// The service adds state, worker, and blockers to each task (src/task-state.js). A task without them gets a derived state here.

export const FLOW = ['blocked', 'ready', 'doing', 'review', 'done'];
export const FLOW_LABEL = { blocked: 'Blocked', ready: 'Ready', doing: 'Doing', review: 'Review', done: 'Done' };
export const DONE_LIMIT = 10;

const FLOW_SET = new Set(FLOW);

// A blocker counts as done only by its own state. This check does not recurse, so a cycle cannot loop.
function doneOnly(t) {
  if (!t) return false;
  return FLOW_SET.has(t.state) ? t.state === 'done' : (t.status || 'todo') === 'done';
}

export function taskMap(tasks) {
  return new Map((tasks || []).filter((t) => t && t.id != null).map((t) => [String(t.id), t]));
}

// The blockedBy IDs that are not done. An ID that is not in the tasks counts as not done.
export function openBlockers(t, map) {
  return (Array.isArray(t?.blockedBy) ? t.blockedBy : []).map(String).filter((id) => !doneOnly(map.get(id)));
}

export function taskState(t, map = new Map()) {
  if (FLOW_SET.has(t?.state)) return t.state;
  const status = t?.status || 'todo';
  if (status === 'done' || status === 'doing' || status === 'review') return status;
  if (status === 'blocked' || t?.waitingOn != null || openBlockers(t, map).length) return 'blocked';
  return 'ready';
}

// What a blocked task waits on: each open blocker task first, then the waiting party.
export function blockReasons(t, map) {
  if (taskState(t, map) !== 'blocked') return [];
  const reasons = openBlockers(t, map).map((id) => ({ kind: 'task', id, known: map.has(id) }));
  if (t.waitingOn && t.waitingOn !== 'task') reasons.push({ kind: t.waitingOn, ask: t.ask || null });
  return reasons;
}

// All tasks that the task waits on, directly or through other tasks, and all tasks that wait on it.
export function dependencyChain(id, tasks) {
  const list = (tasks || []).filter((t) => t && t.id != null);
  const map = taskMap(list);
  const start = String(id);
  if (!map.has(start)) return new Set();
  const dependents = new Map();
  for (const t of list) for (const b of t.blockedBy || []) {
    if (!dependents.has(String(b))) dependents.set(String(b), []);
    dependents.get(String(b)).push(String(t.id));
  }
  const chain = new Set([start]);
  const walk = (from, next) => {
    const stack = [from];
    while (stack.length) for (const other of next(stack.pop())) {
      if (!map.has(other) || chain.has(other)) continue;
      chain.add(other);
      stack.push(other);
    }
  };
  walk(start, (x) => (map.get(x).blockedBy || []).map(String));
  walk(start, (x) => dependents.get(x) || []);
  return chain;
}

// The next milestone is the first group, in the published order, that has open work.
// The critical path is the longest chain of open tasks that ends in that milestone. Without groups, any open task can end it.
// A tie goes to the chain whose last task comes first in the published order.
export function criticalPath(tasks, groups = []) {
  const list = (tasks || []).filter((t) => t && t.id != null);
  const map = taskMap(list);
  const open = list.filter((t) => taskState(t, map) !== 'done');
  const openIds = new Set(open.map((t) => String(t.id)));
  const known = (Array.isArray(groups) ? groups : []).filter((g) => g && g.id);
  const milestone = known.find((g) => open.some((t) => t.group === g.id)) || null;
  const targets = milestone ? open.filter((t) => t.group === milestone.id) : open;
  const memo = new Map();
  const visiting = new Set();
  const longest = (id) => {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return [];
    visiting.add(id);
    let best = [];
    for (const b of openBlockers(map.get(id), map)) {
      if (!openIds.has(b)) continue;
      const chain = longest(b);
      if (chain.length > best.length) best = chain;
    }
    visiting.delete(id);
    const result = [...best, id];
    memo.set(id, result);
    return result;
  };
  let path = [];
  for (const t of targets) {
    const chain = longest(String(t.id));
    if (chain.length > path.length) path = chain;
  }
  return { milestone: milestone ? { id: milestone.id, title: milestone.title || milestone.id } : null, path };
}

const time = (value) => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

// Each task in its flow column. Ready sorts by priority: the critical path first, then the group order, then the published order.
// Doing puts the longest-running worker first. Done shows the last DONE_LIMIT tasks by update time unless showAllDone is set.
export function boardColumns(tasks, { groups = [], showAllDone = false, doneLimit = DONE_LIMIT } = {}) {
  const list = (tasks || []).filter((t) => t && t.title != null);
  const map = taskMap(list);
  const order = new Map(list.map((t, i) => [t, i]));
  const groupOrder = new Map((groups || []).filter((g) => g && g.id).map((g, i) => [g.id, i]));
  const critical = criticalPath(list, groups);
  const onPath = new Map(critical.path.map((id, i) => [id, i]));
  const columns = Object.fromEntries(FLOW.map((k) => [k, []]));
  for (const t of list) columns[taskState(t, map)].push(t);
  const published = (a, b) => order.get(a) - order.get(b);
  const rank = (t) => (t.id != null && onPath.has(String(t.id)) ? onPath.get(String(t.id)) : Infinity);
  columns.ready.sort((a, b) => rank(a) - rank(b) || (groupOrder.get(a.group) ?? Infinity) - (groupOrder.get(b.group) ?? Infinity) || published(a, b));
  columns.doing.sort((a, b) => (time(a.worker?.startedAt) ?? Infinity) - (time(b.worker?.startedAt) ?? Infinity) || published(a, b));
  columns.done.sort((a, b) => (time(b.updated) ?? -Infinity) - (time(a.updated) ?? -Infinity) || published(b, a));
  const counts = Object.fromEntries(FLOW.map((k) => [k, columns[k].length]));
  const hiddenDone = showAllDone ? 0 : Math.max(0, columns.done.length - doneLimit);
  if (hiddenDone) columns.done = columns.done.slice(0, doneLimit);
  return { columns, counts, hiddenDone, critical, map };
}

// The tasks that the graph draws. Open work keeps the done tasks that directly block open work, so each chain keeps its start.
export function graphTasks(tasks, { openOnly = true } = {}) {
  const list = (tasks || []).filter((t) => t && t.title != null);
  if (!openOnly) return list;
  const map = taskMap(list);
  const keep = new Set();
  for (const t of list) {
    if (taskState(t, map) === 'done') continue;
    keep.add(t);
    for (const id of t.blockedBy || []) if (map.has(String(id))) keep.add(map.get(String(id)));
  }
  return list.filter((t) => keep.has(t));
}
