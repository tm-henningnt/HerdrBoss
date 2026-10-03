import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  BRIEF_EXCERPT_LINES, briefExcerpt, cardTitle, filterRows, orchestratorFocus, projectOptions, workerListHtml, workerRowHtml, workerRows,
} from '../public/worker-rows.js';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const dur = (seconds) => `${Math.round(seconds / 60)}m`;
const markdown = (text) => `<p>${esc(text)}</p>`;
const deps = { esc, dur, markdown };
const NOW = Date.parse('2026-10-03T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

const live = {
  key: 'alpha/av1', project: 'alpha', name: 'av1', kind: 'claude', model: 'sonnet', pane: 'w1:p2', taskId: 'AV1', title: 'AV1: readable workers',
  state: 'working', group: 'working', startedAt: iso(NOW - 3600000), finishedAt: null, now: 'Running tests in test/factory', summary: null, result: null,
  hasBrief: true, scope: ['src', 'test'], reportPath: '.worker/report.md',
};
const done = { ...live, key: 'beta/ft15', project: 'beta', name: 'ft15', pane: 'w2:p3', taskId: null, title: 'FT15 <b>Updates</b>', state: 'review', group: 'finished', now: null, finishedAt: iso(NOW - 600000), result: 'Merged', summary: 'Built the tiers.' };
const state = {
  workerView: { rows: [live, done] },
  projects: [{ slug: 'alpha', phase: 'Build', tasks: [{ id: 'AV1', title: 'Readable workers in the Agents view', status: 'doing' }, { id: 'X', title: 'Other', status: 'todo' }] }],
  control: { projects: { alpha: { slug: 'alpha', workspace: 'w1' } } },
  herdr: {
    workspaces: [{ id: 'w1', label: 'alpha' }],
    panes: [
      { id: 'w1:p1', workspace: 'w1', agent: 'claude', orch: true, label: 'orch', status: 'idle' },
      { id: 'w1:p2', workspace: 'w1', agent: 'claude', name: 'av1', status: 'working' },
      { id: 'w1:p9', workspace: 'w1', agent: 'codex', name: 'manual', status: 'idle', title: 'by hand' },
    ],
  },
};

test('workerRows adds a row for a live worker pane without a run record', () => {
  const rows = workerRows(state);
  assert.equal(rows.length, 3);
  const manual = rows.find((row) => row.pane === 'w1:p9');
  assert.equal(manual.title, 'by hand');
  assert.equal(manual.project, 'alpha');
  assert.equal(manual.group, 'waiting');
  assert.equal(manual.hasBrief, false);
});

test('filters select by project and by state group', () => {
  const rows = workerRows(state);
  assert.deepEqual(projectOptions(rows), ['alpha', 'beta']);
  assert.equal(filterRows(rows, { project: 'beta' }).length, 1);
  assert.equal(filterRows(rows, { state: 'finished' })[0].name, 'ft15');
  assert.equal(filterRows(rows, { project: 'alpha', state: 'working' })[0].name, 'av1');
  assert.equal(filterRows(rows, {}).length, 3);
});

test('cardTitle and orchestratorFocus read the published status', () => {
  assert.equal(cardTitle(state, 'alpha', 'AV1'), 'Readable workers in the Agents view');
  assert.equal(cardTitle(state, 'alpha', 'nope'), null);
  assert.equal(orchestratorFocus(state, 'w1'), 'Phase: Build. Doing: AV1 Readable workers in the Agents view');
  assert.equal(orchestratorFocus({ ...state, projects: [{ slug: 'alpha', tasks: [] }] }, 'w1'), 'No card on Doing');
  assert.equal(orchestratorFocus(state, 'w9'), null);
});

test('a worker row shows the title, the card title, the project, the agent, and the doing-now line', () => {
  const html = workerRowHtml(live, { state, open: new Set(), now: NOW }, deps);
  assert.match(html, /AV1: readable workers/);
  assert.match(html, /AV1 · Readable workers in the Agents view/);
  assert.match(html, />alpha</);
  assert.match(html, /claude · sonnet/);
  assert.match(html, /Running tests in test\/factory/);
  assert.match(html, />60m</);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /wpanel/);
});

test('a finished row shows the result and the summary, and it escapes the title', () => {
  const html = workerRowHtml(done, { state, open: new Set(), now: NOW }, deps);
  assert.match(html, /Merged · Built the tiers\./);
  assert.match(html, /FT15 &lt;b&gt;Updates&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>Updates/);
  assert.match(html, />50m</);
});

test('an open row shows the scope, the report path, and the loading state before the brief arrives', () => {
  const html = workerRowHtml(live, { state, open: new Set([live.key]), now: NOW, briefs: {} }, deps);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /src, test/);
  assert.match(html, /\.worker\/report\.md/);
  assert.match(html, /Loading the brief/);
  const missing = workerRowHtml(live, { state, open: new Set([live.key]), now: NOW, briefs: { [live.key]: { status: 'missing' } } }, deps);
  assert.match(missing, /no longer available/);
});

test('the brief excerpt keeps 25 lines and Show all shows the rest', () => {
  const text = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n');
  const excerpt = briefExcerpt(text);
  assert.equal(BRIEF_EXCERPT_LINES, 25);
  assert.equal(excerpt.truncated, true);
  assert.equal(excerpt.text.split('\n').length, 25);
  assert.equal(briefExcerpt('short').truncated, false);
  const briefs = { [live.key]: { status: 'ok', data: { text, source: 'copy' } } };
  const short = workerRowHtml(live, { state, open: new Set([live.key]), now: NOW, briefs, showAll: new Set() }, deps);
  assert.match(short, /line 25/);
  assert.doesNotMatch(short, /line 26/);
  assert.match(short, /Show all \(40 lines\)/);
  const full = workerRowHtml(live, { state, open: new Set([live.key]), now: NOW, briefs, showAll: new Set([live.key]) }, deps);
  assert.match(full, /line 40/);
  assert.match(full, /Show first 25 lines/);
});

test('the list has a filter bar and an empty message', () => {
  const html = workerListHtml(state, { filter: { project: '', state: '' }, open: new Set(), now: NOW }, deps);
  assert.match(html, /data-worker-project/);
  assert.match(html, /data-worker-state="finished"/);
  assert.match(html, /aria-pressed="true"[^>]*>All/);
  const none = workerListHtml(state, { filter: { project: 'beta', state: 'working' }, open: new Set(), now: NOW }, deps);
  assert.match(none, /No worker matches this filter/);
  assert.match(none, /0 of 3/);
  assert.match(workerListHtml({}, { filter: {}, open: new Set(), now: NOW }, deps), /No worker has run yet/);
});

test('the page wires the worker list, the HELP text, the docs, and the phone layout', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const guide = fs.readFileSync(new URL('../docs/user-guide.md', import.meta.url), 'utf8');
  assert.match(app, /import \{ orchestratorFocus, workerListHtml \} from '\.\/worker-rows\.js'/);
  assert.match(app, /workerListHtml\(s, \{ \.\.\.workerUi, now: Date\.now\(\) \}/);
  assert.match(app, /\/api\/worker-brief\?project=/);
  assert.match(app, /<b>Doing now<\/b> column/);
  assert.match(css, /\.wlist-head \{ display: none; \}/);
  assert.match(css, /\.wrow-main \{ display: grid/);
  assert.match(guide, /#### The Doing now line/);
  assert.match(guide, /#### The brief panel/);
  assert.match(guide, /GET \/api\/worker-brief/);
});

test('an idle worker over 2 hours shows the stale badge, and a pane without a run record shows its label', () => {
  const idle = { ...live, state: 'idle', group: 'waiting', now: 'Idle for 150 minutes' };
  const since = { paneSince: { 'w1:p2': { since: NOW - 3 * 3600000 } } };
  assert.match(workerRowHtml(idle, { state: { ...state, ...since }, open: new Set(), now: NOW }, deps), /Idle over 2h/);
  const fresh = { paneSince: { 'w1:p2': { since: NOW - 3600000 } } };
  assert.doesNotMatch(workerRowHtml(idle, { state: { ...state, ...fresh }, open: new Set(), now: NOW }, deps), /Idle over 2h/);
  assert.doesNotMatch(workerRowHtml(live, { state: { ...state, ...since }, open: new Set(), now: NOW }, deps), /Idle over 2h/);
  const withLabel = { ...state, herdr: { ...state.herdr, panes: [...state.herdr.panes, { id: 'w1:p8', workspace: 'w1', agent: 'claude', label: 'planner', status: 'idle' }] } };
  const orphan = workerRows(withLabel).find((row) => row.pane === 'w1:p8');
  assert.equal(orphan.paneLabel, 'planner');
  assert.match(workerRowHtml(orphan, { state: withLabel, open: new Set(), now: NOW }, deps), /planner/);
});
