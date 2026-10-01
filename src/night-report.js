import { agentCommunication } from './analytics.js';

const METERED_LANES = new Set(['codex', 'claude', 'opencodego']);
const REPORT_LINES_MAX = 60;

function clean(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

function timeLabel(value) {
  const ms = timestamp(value);
  return ms === null ? 'unknown time' : new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function timestamp(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function taskLabel(task) {
  const id = clean(task?.id);
  const title = clean(task?.title);
  return [id, title].filter(Boolean).join(' ');
}

function workerStart(task, project, herdr, paneSince) {
  const taskStart = timestamp(task.startedAt ?? task.started ?? task.startAt);
  if (taskStart !== null) return taskStart;
  const workers = (herdr?.panes || []).filter((pane) => pane.workspace === project.workspace && pane.agent
    && !pane.orch && pane.label !== 'boss' && pane.status === 'working');
  const worker = task.worker ? workers.find((pane) => [pane.id, pane.name, pane.worker].includes(task.worker)) : workers[0];
  return timestamp(paneSince?.[worker?.id]?.since ?? worker?.startedAt ?? worker?.createdAt);
}

function laneUse(project, usage, since, now) {
  const minutes = new Map();
  for (const item of usage || []) {
    if (item?.project !== project.slug || !METERED_LANES.has(item.provider)) continue;
    const start = timestamp(item.startedAt);
    const end = timestamp(item.endedAt);
    if (start === null || end === null) continue;
    const overlap = Math.max(0, Math.min(end, now) - Math.max(start, since));
    if (overlap) minutes.set(item.provider, (minutes.get(item.provider) || 0) + overlap);
  }
  const total = [...minutes.values()].reduce((sum, value) => sum + value, 0);
  if (!total) return 'Lane use: no metered usage recorded.';
  const shares = [...minutes].sort(([a], [b]) => a.localeCompare(b))
    .map(([lane, value]) => `${lane} ${Math.round(value * 100 / total)}%`);
  return `Lane use (recorded metered work time): ${shares.join(', ')}.`;
}

function eventForProject(event, project, herdr) {
  if (event.project === project.slug || event.workspace === project.workspace) return true;
  if (!event.pane) return false;
  const pane = (herdr?.panes || []).find((item) => item.id === event.pane);
  return pane?.workspace === project.workspace;
}

function reportEvents(project, events, herdr, since, now) {
  const lines = [];
  for (const event of events || []) {
    const at = timestamp(event.at);
    if (at === null || at < since || at > now || !['notify', 'push', 'alert'].includes(event.type)) continue;
    if (!eventForProject(event, project, herdr)) continue;
    const titles = Array.isArray(event.titles) ? event.titles : [];
    const text = clean(event.title || event.text);
    if (text) lines.push(text);
    for (const title of titles) if (clean(title)) lines.push(clean(title));
  }
  return [...new Set(lines)];
}

// Render a short plain-text snapshot from engine state and usage records.
export function renderNightReport({ night, kind = 'report', now = Date.now(), projects = [], control = {}, herdr = {}, paneSince = {}, usage = [], events = [], agentMetadata = null }) {
  const since = timestamp(night?.since) ?? now;
  const lines = [
    kind === 'retro' ? 'Watch retro' : 'Watch report',
    `Since: ${new Date(since).toISOString()}`,
    `As of: ${new Date(now).toISOString()}`,
  ];
  if (agentMetadata) {
    const figures = agentCommunication(agentMetadata, { now, since: new Date(since).toISOString() });
    const nudges = figures.nudgesPerTask.reduce((sum, task) => sum + task.nudges, 0);
    const seconds = value => value === null ? 'unknown' : `${Math.round(value / 1000)} s`;
    const share = figures.reminderShare === null ? 'unknown' : `${Math.round(figures.reminderShare * 100)}%`;
    lines.push(`Agent communication: ${figures.total} messages; ${nudges} nudges; ${figures.reminders} reminders (${share}); ${figures.responses} responses; median ${seconds(figures.medianMs)}; p90 ${seconds(figures.p90Ms)}.`);
  }
  const ordered = [...projects].sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
  if (!ordered.length) lines.push('No project status is available.');
  for (const project of ordered) {
    const slug = project.slug;
    const workers = control.projects?.[slug]?.running ?? (herdr.panes || []).filter((pane) => pane.workspace === project.workspace
      && pane.agent && !pane.orch && pane.label !== 'boss' && pane.status === 'working').length;
    lines.push('', `${clean(project.project || project.label || slug)} (${clean(slug)})`, `Workers: ${workers}`);
    const tasks = Array.isArray(project.tasks) ? project.tasks : [];
    const done = tasks.filter((task) => task?.status === 'done'
      && (timestamp(task.doneAt ?? task.completedAt ?? task.updated) ?? -Infinity) >= since);
    const running = tasks.filter((task) => task?.status === 'doing' || task?.status === 'running');
    const blocked = tasks.filter((task) => task?.status === 'blocked');
    lines.push(`Done since start: ${done.length ? done.map(taskLabel).filter(Boolean).map((label) => `${label}: done`).join('; ') : 'none.'}`);
    lines.push(`Running: ${running.length ? running.map((task) => {
      const label = taskLabel(task) || 'Task';
      return `${label}: in progress, started ${timeLabel(workerStart(task, project, herdr, paneSince))}`;
    }).join('; ') : 'none.'}`);
    lines.push(`Blocked: ${blocked.length ? blocked.map((task) => `${taskLabel(task) || 'Task'}: blocked, waiting on ${clean(task.waitingOn || 'not recorded')}`).join('; ') : 'none.'}`);
    lines.push(laneUse(project, usage, since, now));
    const notices = reportEvents(project, events, herdr, since, now);
    lines.push(`Notices and alerts: ${notices.length ? notices.join('; ') : 'none.'}`);
  }
  if (lines.length <= REPORT_LINES_MAX) return lines.join('\n');
  return [...lines.slice(0, REPORT_LINES_MAX - 1), 'Report truncated to 60 lines.'].join('\n');
}
