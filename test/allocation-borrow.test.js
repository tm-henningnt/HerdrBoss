import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { deriveControl, POLICY_DEFAULTS } from '../src/control.js';
import { renderBulletin } from '../src/rules.js';
import { loadModels, loadProjectConfig } from '../src/kit/config.js';
import { allocationSummary } from '../src/kit/workers.js';
import { startWorker } from './helpers/start-worker.js';

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

test('a busy project with 1 of 4 running keeps its 4 slots and offers 3 to a full project', () => {
  const p = policy({ maxWorkers: 8, projects: shares({ quiet: [50], busy: [50] }) });
  const result = deriveControl(snapshot({ quiet: ['working', 1], busy: ['working', 4] }), p, models, {}, NOW);
  assert.equal(result.projects.quiet.baseSlots, 4);
  assert.equal(result.projects.quiet.slots, 4);
  assert.equal(result.projects.quiet.offered, 3);
  assert.equal(result.projects.quiet.lent, 0);
  assert.equal(result.projects.quiet.borrowed, 0);
  assert.equal(result.projects.busy.offered, 0);
  assert.equal(result.projects.busy.borrowed, 3);
  assert.equal(result.projects.busy.slots, 7);
});

test('a working or blocked orchestrator with no workers keeps its full base and needs no reserve', () => {
  const p = policy({ projects: shares({ quiet: [50], busy: [50] }) });
  for (const status of ['working', 'blocked']) {
    const result = deriveControl(snapshot({ quiet: [status, 0], busy: ['working', 5] }), p, models, {}, NOW);
    assert.equal(result.projects.quiet.slots, 5, status);
    assert.equal(result.projects.quiet.offered, 5, status);
    assert.equal(result.projects.busy.borrowed, 5, status);
    assert.equal(result.projects.busy.slots, 10, status);
  }
});

test('an orchestrator between turns keeps its base before the project counts as idle', () => {
  const p = policy({ projects: shares({ quiet: [50], busy: [50] }) });
  for (const status of ['idle', 'done']) {
    const since = { 'quiet:orch': { since: NOW - 5 * 60000 } };
    const result = deriveControl(snapshot({ quiet: [status, 0], busy: ['working', 5] }), p, models, since, NOW);
    assert.equal(result.projects.quiet.idle, false, status);
    assert.equal(result.projects.quiet.lent, 0, status);
    assert.equal(result.projects.quiet.offered, 5, status);
    assert.equal(result.projects.quiet.slots, 5, status);
  }
});

test('an idle project lends all its slots', () => {
  const p = policy({ projects: shares({ quiet: [50], busy: [50] }) });
  const result = deriveControl(snapshot({ quiet: ['idle', 0], busy: ['working', 5] }), p, models, longAgo('quiet'), NOW);
  assert.equal(result.projects.quiet.idle, true);
  assert.equal(result.projects.quiet.lent, 5);
  assert.equal(result.projects.quiet.offered, 0);
  assert.equal(result.projects.quiet.slots, 0);
  assert.equal(result.projects.busy.borrowed, 5);
  assert.equal(result.projects.busy.slots, 10);
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
    assert.equal(result.projects[slug].offered, 0);
    assert.equal(result.projects[slug].borrowed, 0);
    assert.equal(result.projects[slug].slots, result.projects[slug].baseSlots);
  }
});

test('borrowers get the idle lent slots plus the offered slots by share', () => {
  const p = policy({ projects: shares({ quiet: [30, 'idle'], part: [30], big: [20], small: [20] }) });
  const result = deriveControl(snapshot({ quiet: ['idle', 0], part: ['working', 1], big: ['working', 2], small: ['working', 2] }), p, models, {}, NOW);
  assert.equal(result.projects.quiet.lent, 3);
  assert.equal(result.projects.quiet.slots, 0);
  assert.equal(result.projects.part.offered, 2);
  assert.equal(result.projects.part.slots, 3);
  assert.equal(result.projects.big.borrowed + result.projects.small.borrowed, 5);
  assert.equal(result.projects.big.slots, 2 + result.projects.big.borrowed);
  assert.equal(result.projects.small.slots, 2 + result.projects.small.borrowed);
  assert.ok(Math.abs(result.projects.big.borrowed - result.projects.small.borrowed) <= 1, 'equal shares split the pool evenly');
});

test('borrowIdle false turns all lending off', () => {
  const p = policy({ borrowIdle: false, projects: shares({ quiet: [50, 'paused'], busy: [50] }) });
  const result = deriveControl(snapshot({ quiet: ['idle', 0], busy: ['working', 5] }), p, models, longAgo('quiet'), NOW);
  for (const slug of ['quiet', 'busy']) {
    assert.equal(result.projects[slug].lent, 0);
    assert.equal(result.projects[slug].offered, 0);
    assert.equal(result.projects[slug].borrowed, 0);
    assert.equal(result.projects[slug].slots, 5);
  }
});

test('the bulletin shows effective slots with the borrowed, lent, or free count', () => {
  const p = policy({ projects: shares({ quiet: [30, 'idle'], part: [30], busy: [40] }) });
  const snap = snapshot({ quiet: ['idle', 0], part: ['working', 1], busy: ['working', 4] });
  const control = deriveControl(snap, p, models, {}, NOW);
  const bulletin = renderBulletin({ ...snap, updatedAt: NOW, policy: p, control }, { alerts: [], advice: [] }, { dashboardPort: 4477 });
  assert.match(bulletin, /^- Busy: 4\/9 slots \(40% share, \+5 borrowed\)\. Allowed kinds: /m);
  assert.match(bulletin, /^- Quiet: 0\/0 slots \(30% share, idle, 3 lent\)\. Allowed kinds: /m);
  assert.match(bulletin, /^- Part: 1\/3 slots \(30% share, 2 free for others\)\. Allowed kinds: /m);
  assert.match(bulletin, /^- Borrowed slots are real capacity\. Start workers up to your effective slots; the global limit still applies\.$/m);
});

test('allocationSummary gives effective slots, running workers, global use, and load in one line', () => {
  const rules = {
    control: { runningWorkers: 5, maxWorkers: 10, projects: { busy: { running: 5, slots: 9, baseSlots: 5, lent: 0, offered: 0, borrowed: 4 } } },
    machine: { fiveMinute: 3.2 },
  };
  assert.equal(allocationSummary(rules, 'busy'), 'Allocation for busy: 5/9 effective slots (+4 borrowed); 5/10 working agents globally; 5-minute load 3.2.');
  rules.control.projects.busy = { running: 0, slots: 0, baseSlots: 5, lent: 5, offered: 0, borrowed: 0 };
  delete rules.machine;
  assert.equal(allocationSummary(rules, 'busy'), 'Allocation for busy: 0/0 effective slots (5 lent); 5/10 working agents globally; 5-minute load unknown.');
  rules.control.projects.busy = { running: 1, slots: 4, baseSlots: 4, lent: 0, offered: 3, borrowed: 0 };
  assert.equal(allocationSummary(rules, 'busy'), 'Allocation for busy: 1/4 effective slots (3 free for others); 5/10 working agents globally; 5-minute load unknown.');
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
