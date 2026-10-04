// The project page order (actionable first, then the plan, then history, then details) and the Overview guidance section.
import test from 'node:test';
import { readUserGuide } from './helpers/user-guide.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { waitsForOwner } from '../public/board.js';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const guide = readUserGuide();

// Load top-level functions of the dashboard script into one context, with the helpers they read.
function load(names, context = {}) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ctx = { esc, waitsForOwner, isDone: (t) => (t.status || 'todo') === 'done', ...context };
  const code = names.map((name) => {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} exists in public/app.js`);
    return source.slice(start, source.indexOf('\n}\n', start) + 2);
  }).join('\n');
  vm.runInNewContext(`${code}\nthis.fns = { ${names.join(', ')} };`, ctx);
  return ctx.fns;
}

const body = (name) => {
  const start = source.indexOf(`function ${name}(`);
  return source.slice(start, source.indexOf('\n}\n', start));
};

test('the Now model lists decisions, running workers with their task, work to merge, and the next task', () => {
  const { projectNowModel } = load(['projectNowModel']);
  const p = {
    workspace: 'Orchard',
    git: { dirty: true },
    tasks: [
      { id: 'A1', title: 'Parse rows', status: 'doing', state: 'doing', worker: { name: 'a1', kind: 'codex', model: 'm' } },
      { id: 'A2', title: 'Check totals', status: 'review', state: 'review' },
      { id: 'A3', title: 'Pick format', status: 'blocked', state: 'blocked', waitingOn: 'owner', ask: 'PNG or SVG?' },
      { id: 'A4', title: 'Done work', status: 'done', state: 'done' },
      { id: 'A5', title: 'Print labels', status: 'todo', state: 'ready' },
    ],
  };
  const panes = [
    { id: 'w1:p1', workspace: 'w1', orch: true, agent: 'claude', status: 'working' },
    { id: 'w1:p2', workspace: 'w1', agent: 'codex', name: 'a1', status: 'working', title: 'Parse rows' },
    { id: 'w1:p3', workspace: 'w1', agent: 'claude', name: 'x9', status: 'blocked', title: 'Something else' },
    { id: 'w2:p1', workspace: 'w2', agent: 'codex', name: 'other', status: 'working' },
  ];
  const model = projectNowModel(p, { workspace: 'w1', panes, ready: [p.tasks[4]], since: { 'w1:p2': { since: 1000 } }, now: 61000 });
  assert.deepEqual(model.decisions.map((t) => t.id), ['A3']);
  assert.deepEqual(model.workers.map((w) => [w.name, w.kind, w.status, w.task?.id ?? null, w.seconds]), [['a1', 'codex', 'working', 'A1', 60], ['x9', 'claude', 'blocked', null, null]]);
  assert.equal(model.orch.status, 'working');
  assert.deepEqual(model.review.map((t) => t.id), ['A2']);
  assert.equal(model.dirty, true);
  assert.equal(model.next.id, 'A5');
  assert.equal(model.blocked, 1);
});

test('the Now model is empty for a project without a workspace or tasks', () => {
  const { projectNowModel } = load(['projectNowModel']);
  const model = projectNowModel({ tasks: [] }, { workspace: null, panes: [], ready: [], since: {}, now: 0 });
  assert.deepEqual([model.decisions.length, model.workers.length, model.review.length, model.dirty, model.next, model.orch], [0, 0, 0, false, null, null]);
});

test('the guidance summary names the Use now lanes, the lanes over pace, and the rule counts', () => {
  const { guidanceSummary } = load(['watchLabelText', 'validPlan', 'useNowList', 'guidanceSummary'], { PROVIDERS: { claude: 'Claude', codex: 'Codex' } });
  const lanes = { claude: { state: 'pace' }, codex: { state: 'open', roomPercent: 12 }, unmetered: { state: 'open', unmetered: true } };
  assert.equal(guidanceSummary({ lanes, alerts: [{ severity: 'warn' }, { severity: 'info' }], advice: [], night: { active: false } }), 'Use now: free models, codex · Claude ahead of pace · 1 warning');
  assert.equal(guidanceSummary({ lanes: {}, alerts: [], advice: ['x'], night: { active: true } }), 'Watch on · Use now: no metered lane · 1 advice');
  assert.equal(guidanceSummary({ lanes: { codex: { state: 'open' } }, alerts: [{ severity: 'critical' }] }), 'Use now: codex · 1 critical');
});

test('the Use now list follows the bulletin order: free models, below pace by room, ignored, trickle, open', () => {
  const { useNowList } = load(['validPlan', 'useNowList']);
  const lanes = {
    claude: { state: 'open' },
    codex: { state: 'open', roomPercent: 5 },
    opencodego: { state: 'open', roomPercent: 20 },
    unmetered: { state: 'open', unmetered: true },
    other: { state: 'exhausted' },
  };
  assert.deepEqual([...useNowList(lanes)], ['free models', 'opencode', 'codex', 'claude']);
});

test('a detail card is a details element on every screen size and remembers its state per project', () => {
  const stored = { orchard: { files: true } };
  const { foldCard } = load(['foldCard'], { foldOpen: (slug, key, fallback) => (typeof stored[slug]?.[key] === 'boolean' ? stored[slug][key] : fallback) });
  const closed = foldCard({ slug: 'lantern', key: 'files', title: 'Files', count: 'kit current', body: '<p>x</p>' });
  assert.match(closed, /^<details data-key="section:files" class="fold-phone fold-card" data-project-fold="lantern" data-fold-key="files">/);
  assert.match(closed, /<h2>Files <span class="sub">kit current<\/span><\/h2>/);
  assert.match(foldCard({ slug: 'orchard', key: 'files', title: 'Files', body: '' }), /data-fold-key="files" open>/);
  assert.doesNotMatch(body('foldCard'), /isPhone/);
  assert.match(body('foldState'), /localStorage\.getItem\(FOLD_PREFIX \+ slug\)/);
  assert.match(body('setFoldOpen'), /localStorage\.setItem\(FOLD_PREFIX \+ slug/);
});

test('the project page puts actionable work first, then the plan, then history, then the collapsed details', () => {
  const page = body('project');
  const order = ['projectNow(', 'metrics,', 'programBlock(', 'boardBlock(', 'dependencyGraph(', 'groupsBlock(', 'specsBlock(', 'gatesRisksBlock(', 'issueTable(', 'projectDetails('];
  const at = order.map((name) => page.indexOf(name));
  at.forEach((index, i) => assert.ok(index >= 0, `project() calls ${order[i]}`));
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'the sections keep the use order');
  for (const name of ['filesBlock(', 'workerConfigBlock(', 'wsBlock', 'handoffBlock(', 'decisionsBlock(', 'agentsDriftLine(']) assert.equal(page.indexOf(name), -1, `project() leaves ${name} to the Now or Details section`);
  const now = body('projectNow');
  assert.match(now, /decisionsBlock\(/);
  assert.match(now, /agentsDriftLine\(p\.agentsCheck\)/);
  assert.match(now, /handoffBlock\(s, slug\)/);
  const details = body('projectDetails');
  for (const name of ['filesBlock(p, s.kit)', 'workerConfigBlock(s, slug)', 'workspacesBlock(', 'browserLeaseBlock(']) assert.ok(details.includes(name), `projectDetails() holds ${name}`);
  assert.match(details, /foldCard\(/);
});

test('a project handover that is not needed is a slim orchestrator line', () => {
  const block = body('handoffBlock');
  assert.match(block, /orch-line/);
  assert.match(block, /foldCard\(/);
});

test('the Overview shows the current guidance collapsed near the top and remembers its state', () => {
  const page = body('overview');
  assert.ok(page.indexOf('guidanceFold(s)') > page.indexOf('page-intro'), 'the guidance follows the page header');
  assert.ok(page.indexOf('guidanceFold(s)') < page.indexOf('overview-action-grid'), 'the guidance comes before Needs attention');
  const fold = body('guidanceFold');
  assert.match(fold, /foldCard\(\{ slug: OVERVIEW_FOLD, key: 'guidance'/);
  assert.doesNotMatch(fold, /defaultOpen: true/);
  assert.match(fold, /guidanceSummary\(s\)/);
  assert.match(fold, /rulesRows\(s\)/);
});

test('the help and the user guide describe the new layout', () => {
  const help = source.slice(source.indexOf('const HELP = {'), source.indexOf('function currentRoute('));
  assert.match(help, /<h3>Current guidance<\/h3>/);
  assert.match(help, /<h3>Now<\/h3>/);
  assert.match(help, /<h3>Details<\/h3>/);
  assert.match(guide, /### Current guidance/);
  assert.match(guide, /### Now/);
  assert.match(guide, /### Project details/);
});

test('the Waiting to merge card shows the unpushed commit and unmerged branch counts above 0', () => {
  const { gitCountsLine } = load(['gitCountsLine']);
  assert.equal(gitCountsLine({ ahead: 0, unmerged: 0 }), '');
  assert.equal(gitCountsLine(null), '');
  assert.equal(gitCountsLine({ ahead: null, unmerged: null }), '');
  assert.match(gitCountsLine({ ahead: 3, unmerged: 0 }), /3 unpushed commits/);
  assert.doesNotMatch(gitCountsLine({ ahead: 3, unmerged: 0 }), /unmerged/);
  assert.match(gitCountsLine({ ahead: 1, unmerged: 2 }), /1 unpushed commit\b(?!s)/);
  assert.match(gitCountsLine({ ahead: 1, unmerged: 2 }), /2 unmerged branches/);
  assert.match(gitCountsLine({ ahead: 0, unmerged: 1 }), /1 unmerged branch\b(?!es)/);
  const now = body('projectNow');
  assert.match(now, /gitCountsLine\(p\.git\)/);
});

test('the Status stale card shows the reason for a live worker on a task that is not doing, else the age', () => {
  const { staleStatusText } = load(['staleStatusText'], { dur: (s) => `${Math.round(s / 60)} min` });
  const updated = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  assert.equal(staleStatusText({ updated, mismatch: [], reason: 'published status is 3 h old while workers ran' }, updated), '180 min');
  const reason = 'worker w1 runs task A, which the status lists as todo';
  assert.equal(staleStatusText({ updated, mismatch: [{ taskId: 'A' }], reason }, updated), reason);
  assert.match(body('projectNow'), /staleStatusText\(stale, p\.updated\)/);
});
