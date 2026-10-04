// Pure view logic of the project board and the dependency graph. Both use the same states.
// The service adds state, worker, and blockers to each task (src/task-state.js). A task without them gets a derived state here.

export const FLOW = ['blocked', 'ready', 'doing', 'stuck', 'review', 'done'];
export const FLOW_LABEL = { blocked: 'Blocked', ready: 'Ready', doing: 'Doing', stuck: 'Stuck', review: 'Review', done: 'Done' };
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

// The blockedBy IDs as strings. A blockedBy that is not an array gives no IDs.
export function blockerIds(t) {
  return (Array.isArray(t?.blockedBy) ? t.blockedBy : []).map(String);
}

// The blockedBy IDs that are not done. An ID that is not in the tasks counts as not done.
export function openBlockers(t, map) {
  return blockerIds(t).filter((id) => !doneOnly(map.get(id)));
}

// The lanes that a board shows. The Stuck lane shows only when a card is stuck.
export function visibleLanes(counts = {}) {
  return FLOW.filter((k) => k !== 'stuck' || counts.stuck > 0);
}

export function taskState(t, map = new Map()) {
  // The service keeps state doing on a stuck card. The computed state decides the lane.
  if (t?.computedState === 'stuck' && t.state === 'doing') return 'stuck';
  if (FLOW_SET.has(t?.state)) return t.state;
  const status = t?.status || 'todo';
  if (status === 'done' || status === 'doing' || status === 'review') return status;
  if (status === 'blocked' || t?.waitingOn != null || openBlockers(t, map).length) return 'blocked';
  return 'ready';
}

// Whether a task shows as an open wait for the Owner. Only a real signal counts: waitingOn owner, or a
// linked Mailbox item. The published phase and summary text never decides this.
export function waitsForOwner(t) {
  if (!t || (FLOW_SET.has(t.state) ? t.state === 'done' : (t.status || 'todo') === 'done')) return false;
  return t.waitingOn === 'owner' || (typeof t.mailboxId === 'string' && t.mailboxId.trim().length > 0);
}

// What a blocked task waits on: each open blocker task first, then the waiting party.
export function blockReasons(t, map) {
  if (taskState(t, map) !== 'blocked') return [];
  const reasons = openBlockers(t, map).map((id) => ({ kind: 'task', id, known: map.has(id) }));
  if (t.waitingOn && t.waitingOn !== 'task') reasons.push({ kind: t.waitingOn, ask: t.ask || null });
  // A blocked task always shows a reason. waitingOn task without an open blocker names no task; a task without waitingOn states none.
  if (!reasons.length) reasons.push(t.waitingOn === 'task' ? { kind: 'task', id: null, known: false } : { kind: 'unstated', ask: t.ask || null });
  return reasons;
}

// A DOM id part for any value. Each character outside A-Z, a-z, 0-9, and the hyphen becomes _<hex>_, so two values never share a part.
export function domPart(value) {
  return String(value).replace(/[^A-Za-z0-9-]/gu, (c) => `_${c.codePointAt(0).toString(16)}_`);
}

// The column of each task in the dependency graph: 0 for a task without blockers in the set, else 1 + the deepest blocker.
// The walk is iterative, so a long chain cannot overflow the stack. A cycle, also a task that blocks itself, is cut where the walk meets it.
export function graphDepths(tasks, keyOf = (t) => String(t.id)) {
  const list = (tasks || []).filter(Boolean);
  const byKey = new Map(list.map((t) => [keyOf(t), t]));
  const depth = new Map();
  const onStack = new Set();
  for (const root of list) {
    const rootKey = keyOf(root);
    if (depth.has(rootKey)) continue;
    const stack = [rootKey];
    onStack.add(rootKey);
    while (stack.length) {
      const key = stack.at(-1);
      const blockers = blockerIds(byKey.get(key)).filter((id) => byKey.has(id) && id !== key);
      const next = blockers.find((id) => !depth.has(id) && !onStack.has(id));
      if (next) { stack.push(next); onStack.add(next); continue; }
      const known = blockers.filter((id) => depth.has(id));
      depth.set(key, known.length ? 1 + Math.max(...known.map((id) => depth.get(id))) : 0);
      stack.pop();
      onStack.delete(key);
    }
  }
  return depth;
}

// All tasks that the task waits on, directly or through other tasks, and all tasks that wait on it.
export function dependencyChain(id, tasks) {
  const list = (tasks || []).filter((t) => t && t.id != null);
  const map = taskMap(list);
  const start = String(id);
  if (!map.has(start)) return new Set();
  const dependents = new Map();
  for (const t of list) for (const b of blockerIds(t)) {
    if (!dependents.has(b)) dependents.set(b, []);
    dependents.get(b).push(String(t.id));
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
  walk(start, (x) => blockerIds(map.get(x)));
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
  // The longest open chain that ends in each task, as its length and the previous task. The walk is iterative and cuts a cycle.
  const best = new Map();
  const onStack = new Set();
  const measure = (root) => {
    const stack = [root];
    onStack.add(root);
    while (stack.length) {
      const id = stack.at(-1);
      const blockers = openBlockers(map.get(id), map).filter((b) => openIds.has(b) && b !== id);
      const next = blockers.find((b) => !best.has(b) && !onStack.has(b));
      if (next) { stack.push(next); onStack.add(next); continue; }
      let entry = { length: 1, prev: null };
      for (const b of blockers) {
        const chain = best.get(b);
        if (chain && chain.length + 1 > entry.length) entry = { length: chain.length + 1, prev: b };
      }
      best.set(id, entry);
      stack.pop();
      onStack.delete(id);
    }
  };
  let end = null;
  for (const t of targets) {
    const id = String(t.id);
    if (!best.has(id)) measure(id);
    if (!end || best.get(id).length > best.get(end).length) end = id;
  }
  const path = [];
  const seen = new Set();
  for (let id = end; id != null && !seen.has(id); id = best.get(id)?.prev ?? null) { seen.add(id); path.unshift(id); }
  return { milestone: milestone ? { id: milestone.id, title: milestone.title || milestone.id } : null, path };
}

const time = (value) => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

// The time of a done card: the newest of its update time and the time of the fact that made it done.
const doneTime = (t) => {
  const times = [time(t?.updated), t?.source?.kind === 'commit' || t?.computedState === 'done' ? time(t?.source?.at) : null].filter((v) => v != null);
  return times.length ? Math.max(...times) : null;
};

// The stuck cards sort with the oldest first.
const stuckAge = (t) => (Number.isFinite(t?.stuck?.ageMin) ? t.stuck.ageMin : 0);

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
  columns.stuck.sort((a, b) => stuckAge(b) - stuckAge(a) || published(a, b));
  columns.done.sort((a, b) => (doneTime(b) ?? -Infinity) - (doneTime(a) ?? -Infinity) || published(b, a));
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
    for (const id of blockerIds(t)) if (map.has(id)) keep.add(map.get(id));
  }
  return list.filter((t) => keep.has(t));
}

// ---------- Cross-project board ----------
// One item for each task of each published project. The Board page shows open work and the tasks done in the last DONE_WINDOW_MS.

export const DONE_WINDOW_MS = 24 * 3600000;

// A done task counts when its update time is in the window. A done task without a valid time is not shown.
export function fleetItems(projects, { now = Date.now(), doneWindowMs = DONE_WINDOW_MS } = {}) {
  const items = [];
  (projects || []).forEach((p, projectIndex) => {
    if (!p?.slug || !Array.isArray(p.tasks)) return;
    const tasks = p.tasks.filter((t) => t && t.title != null);
    const board = boardColumns(tasks, { groups: p.groups, showAllDone: true });
    const path = new Set(board.critical.path);
    const label = String(p.label || p.project || p.slug);
    for (const state of FLOW) board.columns[state].forEach((task, rank) => {
      if (state === 'done') {
        // A done task counts only with an update time from the last doneWindowMs up to now. A future time does not count.
        const age = now - (doneTime(task) ?? -Infinity);
        if (!(age >= 0 && age <= doneWindowMs)) return;
      }
      const id = task.id != null ? String(task.id) : `~${state}${rank}`;
      items.push({ slug: p.slug, label, task, state, map: board.map, onPath: task.id != null && path.has(String(task.id)), key: `${p.slug}/${id}`, projectIndex, rank });
    });
  });
  return items;
}

// The items in their flow columns. Doing puts the longest-running worker first and Done the newest first.
// The other columns keep the project order and, in a project, the order of the project board.
export function fleetColumns(items) {
  const columns = Object.fromEntries(FLOW.map((k) => [k, []]));
  for (const item of items || []) columns[item.state].push(item);
  const board = (a, b) => a.projectIndex - b.projectIndex || a.rank - b.rank;
  columns.doing.sort((a, b) => (time(a.task.worker?.startedAt) ?? Infinity) - (time(b.task.worker?.startedAt) ?? Infinity) || board(a, b));
  columns.done.sort((a, b) => (doneTime(b.task) ?? -Infinity) - (doneTime(a.task) ?? -Infinity) || board(a, b));
  columns.stuck.sort((a, b) => stuckAge(b.task) - stuckAge(a.task) || board(a, b));
  for (const k of ['blocked', 'ready', 'review']) columns[k].sort(board);
  const counts = Object.fromEntries(FLOW.map((k) => [k, columns[k].length]));
  return { columns, counts };
}

// The text that the search reads for one item.
function searchText(item) {
  const t = item.task;
  return [item.slug, item.label, t.id, t.title, t.ask, t.waitingOn, t.worker?.name, t.worker?.kind, t.worker?.model, ...blockerIds(t)]
    .filter((x) => x != null).join(' ').toLowerCase();
}

// who: 'owner' (waits for the Owner), 'worker' (has a worker), 'kind:<harness>', or 'model:<model>'. Each search word must match.
export function fleetFilter(items, { project = '', who = '', state = '', query = '' } = {}) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  return (items || []).filter((item) => {
    const t = item.task;
    if (project && item.slug !== project) return false;
    if (state && item.state !== state) return false;
    if (who === 'owner' && !waitsForOwner(t)) return false;
    if (who === 'worker' && !t.worker) return false;
    if (who.startsWith('kind:') && t.worker?.kind !== who.slice(5)) return false;
    if (who.startsWith('model:') && t.worker?.model !== who.slice(6)) return false;
    if (words.length) {
      const text = searchText(item);
      if (!words.every((w) => text.includes(w))) return false;
    }
    return true;
  });
}

// The worker harness kinds and models on the board, for the filter choices.
export function fleetWho(items) {
  const kinds = new Set();
  const models = new Set();
  for (const { task } of items || []) {
    if (task.worker?.kind) kinds.add(String(task.worker.kind));
    if (task.worker?.model) models.add(String(task.worker.model));
  }
  return { kinds: [...kinds].sort(), models: [...models].sort() };
}

// The elapsed time of a worker on a card. After the first minute the text has whole minutes only,
// so a refresh inside the same minute gives the same HTML. An invalid start gives an empty text.
export function elapsedText(startedAt, now = Date.now()) {
  const start = time(startedAt);
  if (start == null) return '';
  const sec = Math.max(0, Math.floor((now - start) / 1000));
  if (sec < 60) return `${sec}s`;
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

// ---------- Card facts ----------
// The service computes the state of each card from git, workers and issues (docs/board.md). These texts show the fact.

// The age of a time as text: just now, N minutes ago, N hours ago, or N days ago. A missing time gives an empty text.
export function agoText(at, now = Date.now()) {
  const ms = time(at);
  if (ms == null) return '';
  const min = Math.max(0, Math.floor((now - ms) / 60000));
  const unit = (n, name) => `${n} ${name}${n === 1 ? '' : 's'} ago`;
  if (min < 1) return 'just now';
  if (min < 60) return unit(min, 'minute');
  if (min < 1440) return unit(Math.floor(min / 60), 'hour');
  return unit(Math.floor(min / 1440), 'day');
}

// A length of time in minutes as text: N min, N h M min, or N d M h. Zero parts do not show.
export function durationText(minutes) {
  const min = Math.max(0, Math.floor(Number(minutes) || 0));
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  if (d) return h ? `${d} d ${h} h` : `${d} d`;
  if (h) return m ? `${h} h ${m} min` : `${h} h`;
  return `${m} min`;
}

// The short fact and the long fact text of a source: a commit, a worker, or an issue.
function sourceTexts(source) {
  if (source.kind === 'commit') return { fact: source.ref, text: `merged ${source.ref}` };
  if (source.kind === 'worker') return { fact: source.ref, text: `worker ${source.ref}` };
  if (source.kind === 'issue') return { fact: `#${source.ref}`, text: `issue #${source.ref}` };
  return { fact: String(source.ref ?? ''), text: String(source.ref ?? '') };
}

// What a card shows beside its title. auto: the service computed the state from a fact. fact: the commit short id,
// the worker name or the issue number. diverge: both states and the fact, when the published state differs.
// stuck: the reason and the age of a stuck card.
export function cardFacts(task, now = Date.now()) {
  const source = task?.source && typeof task.source === 'object' ? task.source : null;
  const stuck = task?.stuck && task.stuck.reason ? { reason: String(task.stuck.reason), age: `Last activity ${durationText(task.stuck.ageMin)} ago` } : null;
  if (!source) return { auto: false, fact: '', factTitle: '', diverge: null, stuck };
  const { fact, text } = sourceTexts(source);
  const ago = agoText(source.at, now);
  const factTitle = ago ? `${text} ${ago}` : text;
  const diverge = task.diverges === true ? `published: ${task.publishedState}, computed: ${task.computedState}, ${factTitle}` : null;
  return { auto: true, fact, factTitle, diverge, stuck };
}

// The line of a project with cards that differ from git. An empty text when no card differs.
export function divergenceText(project) {
  const count = Number(project?.boardDiverged) || 0;
  if (count < 1) return '';
  const ids = Array.isArray(project.boardDivergedIds) ? project.boardDivergedIds : [];
  return `${count} ${count === 1 ? 'card differs' : 'cards differ'} from git: ${ids.join(', ')}. Publish the status with --sync.`;
}
