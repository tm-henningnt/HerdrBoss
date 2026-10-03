// The worker list of the Agents page: rows, filters, the brief excerpt, and the orchestrator focus line.
// The module has no DOM use, so the Node tests import it directly. The caller passes esc, dur, and markdown.

export const BRIEF_EXCERPT_LINES = 25;
export const STATE_FILTERS = [['', 'All'], ['working', 'Working'], ['waiting', 'Waiting'], ['finished', 'Finished']];
const STATE_LABEL = {
  working: 'Working', blocked: 'Blocked', idle: 'Idle', done: 'Idle', unknown: 'Unknown',
  review: 'Collected', merged: 'Merged', finished: 'Finished', failed: 'Failed', abandoned: 'Abandoned',
};
const DOING_LIMIT = 2;

const isWorkerPane = (pane) => pane.agent && !pane.orch && pane.label !== 'boss';

// The card status as the board counts it: a stuck card counts as doing.
function cardStatus(task) {
  const computed = task.computedState;
  if (!computed) return task.status || 'todo';
  if (computed === 'stuck') return 'doing';
  if (computed === 'todo') return task.status === 'blocked' ? 'blocked' : 'todo';
  return computed;
}

function projectOfWorkspace(state, workspace) {
  return Object.values(state.control?.projects || {}).find((project) => project.workspace === workspace)?.slug || null;
}

export function cardTitle(state, project, taskId) {
  if (!taskId) return null;
  const published = (state.projects || []).find((item) => item.slug === project);
  const card = (published?.tasks || []).find((task) => String(task.id) === String(taskId));
  return card?.title || null;
}

// The plain focus line of an orchestrator: the phase and the cards on Doing, from the published status.
export function orchestratorFocus(state, workspace) {
  const slug = projectOfWorkspace(state, workspace);
  const published = slug ? (state.projects || []).find((item) => item.slug === slug) : null;
  if (!published) return null;
  const doing = (published.tasks || []).filter((task) => task?.title && cardStatus(task) === 'doing');
  const names = doing.slice(0, DOING_LIMIT).map((task) => (task.id ? `${task.id} ${task.title}` : task.title));
  const more = doing.length - names.length;
  const cards = names.length ? `Doing: ${names.join('; ')}${more > 0 ? ` (+${more} more)` : ''}` : 'No card on Doing';
  return published.phase ? `Phase: ${published.phase}. ${cards}` : cards;
}

// Rows for the worker list: the engine rows first, then a row for each live worker pane without a run record.
export function workerRows(state) {
  const rows = (state.workerView?.rows || []).map((row) => ({ ...row }));
  const known = new Set(rows.map((row) => row.pane).filter(Boolean));
  const workspaces = new Map((state.herdr?.workspaces || []).map((workspace) => [workspace.id, workspace]));
  for (const pane of (state.herdr?.panes || []).filter(isWorkerPane)) {
    if (known.has(pane.id)) continue;
    const status = pane.status || 'unknown';
    rows.push({
      key: `pane/${pane.id}`, project: projectOfWorkspace(state, pane.workspace) || workspaces.get(pane.workspace)?.label || '', name: pane.name || pane.agent,
      kind: pane.agent, model: pane.model || null, pane: pane.id, taskId: null, title: pane.title || pane.name || 'Untitled worker',
      state: status, group: status === 'working' ? 'working' : 'waiting', startedAt: null, finishedAt: null,
      now: STATE_LABEL[status] || 'Unknown', summary: null, result: null, hasBrief: false, scope: [], reportPath: null,
    });
  }
  return rows;
}

export function projectOptions(rows) {
  return [...new Set(rows.map((row) => row.project).filter(Boolean))].sort();
}

export function filterRows(rows, { project = '', state = '' } = {}) {
  return rows.filter((row) => (!project || row.project === project) && (!state || row.group === state));
}

// The first lines of a brief. truncated is true when lines remain.
export function briefExcerpt(text, limit = BRIEF_EXCERPT_LINES) {
  const lines = String(text ?? '').split('\n');
  return { text: lines.slice(0, limit).join('\n'), truncated: lines.length > limit, total: lines.length };
}

function runtime(row, dur, now) {
  const start = Date.parse(row.startedAt);
  if (!Number.isFinite(start)) return '–';
  const end = row.group === 'finished' ? Date.parse(row.finishedAt) : now;
  return Number.isFinite(end) ? dur(Math.max(0, end - start) / 1000) : '–';
}

function briefPanel(row, context, deps) {
  const { esc, markdown } = deps;
  const entry = context.briefs?.[row.key];
  if (!row.hasBrief) return '<p class="wbrief-note">No brief is stored for this worker.</p>';
  if (!entry || entry.status === 'loading') return '<p class="wbrief-note">Loading the brief…</p>';
  if (entry.status !== 'ok') return '<p class="wbrief-note">The brief is no longer available.</p>';
  const full = context.showAll?.has(row.key);
  const excerpt = briefExcerpt(entry.data.text);
  const shown = full ? entry.data.text : excerpt.text;
  const toggle = excerpt.truncated
    ? `<button type="button" class="wbrief-toggle" data-worker-brief-all="${esc(row.key)}" aria-expanded="${full ? 'true' : 'false'}">${full ? 'Show first 25 lines' : `Show all (${excerpt.total} lines)`}</button>`
    : '';
  const source = entry.data.source === 'copy' ? 'Copy kept in the worker record' : 'Read from the worktree';
  return `<div class="wbrief"><div class="wbrief-head"><b>Brief</b><span>${esc(source)}</span></div><div class="md wbrief-body">${markdown(shown)}</div>${toggle}</div>`;
}

function panel(row, context, deps) {
  const { esc } = deps;
  const facts = [
    ['Worker', row.name], ['Pane', row.pane], ['Task', row.taskId],
    ['Scope', row.scope?.length ? row.scope.join(', ') : null], ['Report', row.reportPath],
  ].filter(([, value]) => value).map(([label, value]) => `<div><dt>${esc(label)}</dt><dd><code>${esc(value)}</code></dd></div>`).join('');
  const outcome = row.group === 'finished'
    ? `<p class="wresult"><b>${esc(row.result || 'Finished')}</b>${row.summary ? ` ${esc(row.summary)}` : ''}</p>`
    : '';
  return `<div class="wpanel" id="wpanel-${esc(row.key.replace(/[^A-Za-z0-9_-]/g, '-'))}">${outcome}<dl class="wfacts">${facts}</dl>${briefPanel(row, context, deps)}</div>`;
}

// One list item. The same markup is a table row on a desktop and a card on a phone.
export function workerRowHtml(row, context, deps) {
  const { esc, dur } = deps;
  const open = context.open?.has(row.key);
  const card = cardTitle(context.state, row.project, row.taskId);
  const status = row.state in STATE_LABEL ? row.state : 'unknown';
  const stateClass = row.group === 'finished' ? (status === 'merged' ? 'done' : status === 'failed' || status === 'abandoned' ? 'failed' : 'idle') : status;
  const line = row.group === 'finished' ? [row.result, row.summary].filter(Boolean).join(' · ') : row.now;
  const model = [row.kind, row.model].filter(Boolean).join(' · ');
  return `<li class="wrow${open ? ' open' : ''}" data-key="worker:${esc(row.key)}" data-group="${esc(row.group)}">`
    + `<button type="button" class="wrow-main" data-worker-toggle="${esc(row.key)}" aria-expanded="${open ? 'true' : 'false'}">`
    + `<span class="st ${esc(stateClass)}" aria-hidden="true"></span>`
    + `<span class="wcell wtitle"><b>${esc(row.title)}</b>${card && !row.title.includes(card) ? `<small>${esc(row.taskId)} · ${esc(card)}</small>` : (row.taskId ? `<small>Task ${esc(row.taskId)}</small>` : '')}</span>`
    + `<span class="wcell wproj" data-label="Project">${esc(row.project || '–')}</span>`
    + `<span class="wcell wmodel" data-label="Agent">${esc(model || '–')}</span>`
    + `<span class="wcell wstate" data-label="State">${esc(STATE_LABEL[status])}</span>`
    + `<span class="wcell wnow">${esc(line || '–')}</span>`
    + `<span class="wcell wtime" data-label="Runs">${esc(runtime(row, dur, context.now))}</span>`
    + `<span class="wchev" aria-hidden="true"></span></button>${open ? panel(row, context, deps) : ''}</li>`;
}

export function workerFilterBar(rows, filter, { esc }) {
  const projects = projectOptions(rows);
  const chips = STATE_FILTERS.map(([key, label]) => `<button type="button" data-worker-state="${esc(key)}" aria-pressed="${(filter.state || '') === key}">${esc(label)}</button>`).join('');
  const select = `<label class="wfilter-project"><span>Project</span><select data-worker-project><option value="">All projects</option>${projects.map((slug) => `<option value="${esc(slug)}"${filter.project === slug ? ' selected' : ''}>${esc(slug)}</option>`).join('')}</select></label>`;
  return `<div class="wfilter">${select}<div class="wfilter-state" role="group" aria-label="Worker state">${chips}</div></div>`;
}

export function workerListHtml(state, context, deps) {
  const all = workerRows(state);
  const shown = filterRows(all, context.filter);
  const items = shown.map((row) => workerRowHtml(row, { ...context, state }, deps)).join('');
  const head = '<div class="wlist-head" aria-hidden="true"><span></span><span>Work</span><span>Project</span><span>Agent</span><span>State</span><span>Doing now</span><span>Runs</span><span></span></div>';
  const empty = `<p class="workspace-empty">${all.length ? 'No worker matches this filter.' : 'No worker has run yet.'}</p>`;
  return `<section class="workers-section" aria-label="Workers"><div class="workers-head"><h2>Workers <span>${shown.length}${shown.length === all.length ? '' : ` of ${all.length}`}</span></h2></div>${workerFilterBar(all, context.filter || {}, deps)}${shown.length ? `${head}<ul class="wlist">${items}</ul>` : empty}</section>`;
}
