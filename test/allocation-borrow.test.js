import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { deriveControl, POLICY_DEFAULTS } from '../src/control.js';
import { renderBulletin } from '../src/rules.js';
import { loadModels, loadProjectConfig } from '../src/kit/config.js';
import { allocationSummary, startWorker } from '../src/kit/workers.js';

const models = loadModels();
const NOW = Date.parse('2026-09-27T12:00:00Z');
const policy = (patch = {}) => ({ ...structuredClone(POLICY_DEFAULTS), maxWorkers: 10, idleMinutes: 15, ...patch });
const shares = (entries) => Object.fromEntries(Object.entries(entries).map(([slug, [share, mode = 'auto']]) => [slug, { share, mode, excludedKinds: [], excludedModels: [] }]));

// Each project spec: [orchestrator status, running workers].
function snapshot(specs) {
  const slugs = Object.keys(specs);
  const panes = [];
  for (const [slug, [status, running]] of Object.entries(specs)) {
    panes.push({ id: `${slug}:orch`, workspace: slug, orch: true, agent: 'claude', status, sessionId: `s-${slug}` });
    for (let i = 0; i < running; i++) panes.push({ id: `${slug}:w${i}`, workspace: slug, orch: false, agent: 'codex', status: 'working' });
  }
  return {
    projects: slugs.map((slug) => ({ slug, workspace: slug })),
    herdr: { workspaces: slugs.map((slug) => ({ id: slug, label: slug[0].toUpperCase() + slug.slice(1) })), panes },
    quotas: [],
  };
}
// The orchestrator of each named project has held its status for longer than idleMinutes.
const longAgo = (...slugs) => Object.fromEntries(slugs.map((slug) => [`${slug}:orch`, { since: NOW - 60 * 60000 }]));

test('a project with a working orchestrator and no workers lends all but one slot to a full project', () => {
  const p = policy({ projects: shares({ quiet: [50], busy: [50] }) });
  const result = deriveControl(snapshot({ quiet: ['working', 0], busy: ['working', 5] }), p, models, {}, NOW);
  assert.equal(result.projects.quiet.baseSlots, 5);
  assert.equal(result.projects.quiet.lent, 4);
  assert.equal(result.projects.quiet.borrowed, 0);
  assert.equal(result.projects.quiet.slots, 1);
  assert.equal(result.projects.busy.lent, 0);
  assert.equal(result.projects.busy.borrowed, 4);
  assert.equal(result.projects.busy.slots, 9);
});

test('a blocked orchestrator keeps a reserve of one slot', () => {
  const p = policy({ projects: shares({ quiet: [50], busy: [50] }) });
  const result = deriveControl(snapshot({ quiet: ['blocked', 1], busy: ['working', 5] }), p, models, {}, NOW);
  assert.equal(result.projects.quiet.lent, 3);
  assert.equal(result.projects.quiet.slots, 2);
  assert.equal(result.projects.busy.slots, 8);
});

test('an idle project lends all its slots', () => {
  const p = policy({ projects: shares({ quiet: [50], busy: [50] }) });
  const result = deriveControl(snapshot({ quiet: ['idle', 0], busy: ['working', 5] }), p, models, longAgo('quiet'), NOW);
  assert.equal(result.projects.quiet.idle, true);
  assert.equal(result.projects.quiet.lent, 5);
  assert.equal(result.projects.quiet.slots, 0);
  assert.equal(result.projects.busy.borrowed, 5);
  assert.equal(result.projects.busy.slots, 10);
});

test('an idle or done orchestrator keeps no reserve before the project counts as idle', () => {
  const p = policy({ projects: shares({ quiet: [50], busy: [50] }) });
  const result = deriveControl(snapshot({ quiet: ['done', 2], busy: ['working', 5] }), p, models, {}, NOW);
  assert.equal(result.projects.quiet.idle, false);
  assert.equal(result.projects.quiet.lent, 3);
  assert.equal(result.projects.quiet.slots, 2);
});

test('a paused project lends all its slots', () => {
  const p = policy({ projects: shares({ quiet: [50, 'paused'], busy: [50] }) });
  const result = deriveControl(snapshot({ quiet: ['working', 0], busy: ['working', 5] }), p, models, {}, NOW);
  assert.equal(result.projects.quiet.lent, 5);
  assert.equal(result.projects.quiet.slots, 0);
  assert.equal(result.projects.busy.slots, 10);
});

test('no borrower means no lending', () => {
  const p = policy({ projects: shares({ quiet: [50], other: [50] }) });
  const result = deriveControl(snapshot({ quiet: ['working', 0], other: ['working', 1] }), p, models, longAgo('quiet'), NOW);
  for (const slug of ['quiet', 'other']) {
    assert.equal(result.projects[slug].lent, 0);
    assert.equal(result.projects[slug].borrowed, 0);
    assert.equal(result.projects[slug].slots, result.projects[slug].baseSlots);
  }
});

test('borrowers get the lent slots by share', () => {
  const p = policy({ projects: shares({ quiet: [40, 'idle'], big: [40], small: [20] }) });
  const result = deriveControl(snapshot({ quiet: ['idle', 0], big: ['working', 4], small: ['working', 2] }), p, models, {}, NOW);
  assert.equal(result.projects.quiet.lent, 4);
  assert.equal(result.projects.big.borrowed, 3);
  assert.equal(result.projects.small.borrowed, 1);
  assert.equal(result.projects.big.slots, 7);
  assert.equal(result.projects.small.slots, 3);
  const total = Object.values(result.projects).reduce((n, x) => n + x.slots, 0);
  assert.equal(total, 10, 'lending keeps the total at the global limit');
});

test('borrowIdle false turns all lending off', () => {
  const p = policy({ borrowIdle: false, projects: shares({ quiet: [50, 'paused'], busy: [50] }) });
  const result = deriveControl(snapshot({ quiet: ['idle', 0], busy: ['working', 5] }), p, models, longAgo('quiet'), NOW);
  for (const slug of ['quiet', 'busy']) {
    assert.equal(result.projects[slug].lent, 0);
    assert.equal(result.projects[slug].borrowed, 0);
    assert.equal(result.projects[slug].slots, 5);
  }
});

test('the bulletin shows effective slots with the borrowed or lent count', () => {
  const p = policy({ projects: shares({ quiet: [50], busy: [50] }) });
  const snap = snapshot({ quiet: ['working', 0], busy: ['working', 5] });
  const control = deriveControl(snap, p, models, {}, NOW);
  const bulletin = renderBulletin({ ...snap, updatedAt: NOW, policy: p, control }, { alerts: [], advice: [] }, { dashboardPort: 4477 });
  assert.match(bulletin, /^- Busy: 5\/9 slots \(50% share, \+4 borrowed\)\. Allowed kinds: /m);
  assert.match(bulletin, /^- Quiet: 0\/1 slots \(50% share, 4 lent\)\. Allowed kinds: /m);
  assert.match(bulletin, /^- Borrowed slots are real capacity\. Start workers up to your effective slots; the global limit still applies\.$/m);
});

test('allocationSummary gives effective slots, running workers, global use, and load in one line', () => {
  const rules = {
    control: { runningWorkers: 5, maxWorkers: 10, projects: { busy: { running: 5, slots: 9, baseSlots: 5, lent: 0, borrowed: 4 } } },
    machine: { fiveMinute: 3.2 },
  };
  assert.equal(allocationSummary(rules, 'busy'), 'Allocation for busy: 5/9 effective slots (+4 borrowed); 5/10 working agents globally; 5-minute load 3.2.');
  rules.control.projects.busy = { running: 0, slots: 1, baseSlots: 5, lent: 4, borrowed: 0 };
  delete rules.machine;
  assert.equal(allocationSummary(rules, 'busy'), 'Allocation for busy: 0/1 effective slots (4 lent); 5/10 working agents globally; 5-minute load unknown.');
  assert.equal(allocationSummary(rules, 'missing'), null);
});

test('worker start prints the allocation summary and an advisory notice with effective slots', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-borrow-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test User');
  git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(root, 'README.md'), 'seed\n');
  const template = path.join(root, 'brief-template.md');
  fs.writeFileSync(template, 'Worker {{name}}: {{task}}');
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ briefTemplate: template }));
  git('add', '-A');
  git('commit', '-m', 'seed');
  const config = loadProjectConfig({ cwd: root });
  const rulesFile = path.join(root, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({
    updatedAt: new Date(NOW).toISOString(), avoidKinds: [],
    machine: { fiveMinute: 2.5 },
    control: { runningWorkers: 9, maxWorkers: 10, projects: { [config.slug]: { running: 9, slots: 9, baseSlots: 5, lent: 0, borrowed: 4, effectiveMode: 'auto' } } },
  }));
  const herdr = (args) => {
    if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } };
    if (args[0] === 'agent') return { agents: [] };
    if (args[0] === 'tab') return { tabs: [{ tab_id: 'ws:t1', workspace_id: 'ws', label: 'Workers' }] };
    if (args[0] === 'pane') return { panes: [{ pane_id: 'ws:p1', workspace_id: 'ws', tab_id: 'ws:t1', width: 160, height: 45 }] };
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const output = [];
  startWorker('demo', { kind: 'codex', task: 'x', allow: ['src/'], dryRun: true }, {
    config, models, herdr, env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch' }, rulesFile, now: NOW, output: (text) => output.push(text),
  });
  const text = output.join('\n');
  assert.ok(output.includes(`Allocation for ${config.slug}: 9/9 effective slots (+4 borrowed); 9/10 working agents globally; 5-minute load 2.5.`), text);
  assert.ok(output.includes(`Notice: ${config.slug} uses 9/9 effective slots. This share is advisory; global limit still applies.`), text);
});
