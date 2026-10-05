import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDocument, find } from './fake-dom.js';
import { buildFleetRollup } from '../src/fleet-rollup.js';

// Invented data only. No real factory, host, path, or credential enters this file.
const now = Date.parse('2026-10-05T12:00:00Z');
const accountKey = 'a'.repeat(64);
const role = { headOfficeFactoryId: 'factory-zero', epoch: 3, holds: true };

function summary(name, overrides = {}) {
  return {
    schema: 1, contractVersion: '1.0.0', factoryId: name, name, version: '0.1.0', kitRevision: '2e0a5d394ccc',
    generatedAt: '2026-10-05T11:59:50Z', dashboardUrl: 'https://factory.example',
    health: { status: 'healthy', tickAgeSeconds: 10, herdrReachable: true, clockOffsetSeconds: null },
    machine: { load1: 0.8, cpus: 8, memoryFreePercent: 42, diskFreePercent: 50, utcOffsetMinutes: 0 },
    workers: { running: 2, max: 8 }, harnesses: [], boss: { running: true, harness: 'claude' }, pending: [],
    projects: [], quotas: [], spend: [], alerts: [], ownerItems: { total: 0, needsOwner: 0, rows: [] }, reviewPacks: [],
    ...overrides,
  };
}
function factory(name, options = {}) {
  const { summary: body = null, ageSeconds = 10, ...fields } = options;
  return { name, factoryId: name, kind: body?.kind ?? (name === 'factory-zero' ? 'native' : 'container'),
    status: body ? 'healthy' : 'offline', error: body ? null : 'unreachable', drift: null,
    ageSeconds: body ? ageSeconds : null, lastSeenAt: body ? '2026-10-05T11:59:50Z' : null, summary: body, ...fields };
}

function inventedFactories() {
  return [
    factory('factory-zero', { summary: summary('factory-zero', { kind: 'native',
      workers: { running: 2, max: 8 },
      spend: [{ day: '2026-10-05', role: 'worker', harness: 'claude', usd: 6.1 }],
      quotas: [{ harness: 'claude', accountKey, lane: 'weekly', usedPercent: 61, status: 'ok' }],
      machine: { load1: 0.8, cpus: 8, memoryFreePercent: 42, diskFreePercent: 12, utcOffsetMinutes: 0 },
      health: { status: 'healthy', tickAgeSeconds: 10, herdrReachable: true, clockOffsetSeconds: -42 },
      harnesses: [{ harness: 'claude', login: 'ok' }, { harness: 'codex', login: 'ok' }],
      boss: { running: true, harness: 'claude' },
      projects: [{ slug: 'sample-app', phase: 'build', status: 'doing', statusAgeSeconds: 10800, board: { doing: 1, review: 0, blocked: 0, done7d: 2 } }],
      ownerItems: { total: 2, needsOwner: 2, rows: [] }, reviewPacks: [{ id: 'pack-a', waitingItems: 1 }] }) }),
    factory('win1', { ageSeconds: 12, summary: summary('win1', { kind: 'container', kitRevision: '9c1f04ea77b2',
      workers: { running: 3, max: 8 },
      spend: [{ day: '2026-10-04', role: 'worker', harness: 'claude', usd: 8.2 }],
      quotas: [{ harness: 'claude', accountKey, lane: 'weekly', usedPercent: 61, status: 'ok' }],
      machine: { load1: 0.3, cpus: 4, memoryFreePercent: 61, diskFreePercent: 61, utcOffsetMinutes: null },
      health: { status: 'healthy', tickAgeSeconds: 10, herdrReachable: true, clockOffsetSeconds: 2 },
      harnesses: [{ harness: 'claude', login: 'expired' }, { harness: 'codex', login: 'ok' }],
      boss: { running: true, harness: 'codex' }, pending: [{ step: 'login-claude', since: '2026-10-04T08:00:00Z' }],
      projects: [{ slug: 'win1-lab', phase: 'build', status: 'doing', statusAgeSeconds: 60, board: { doing: 2, review: 0, blocked: 1, done7d: 4 } }],
      ownerItems: { total: 1, needsOwner: 1, rows: [] }, reviewPacks: [{ id: 'pack-b', waitingItems: 1 }] }) }),
    factory('win2', { summary: null }),
  ];
}
const settings = { factoryId: 'factory-zero', name: 'factory-zero', dashboardUrl: 'https://factory.example', headOffice: true, shareItemTitles: true, accounts: [] };
const shares = { accounts: [{ harness: 'claude', accountKey, scope: ['factory-zero'], shares: [{ factoryId: 'factory-zero', share: 100 }] }] };

async function render(factories = inventedFactories(), roleOverride = role) {
  const { fleetView } = await import('../public/fleet.js');
  const rollup = buildFleetRollup(factories, { now, role: roleOverride });
  return { html: fleetView({ factories, pollSeconds: 30, rollup, role: roleOverride }, settings, '', shares), rollup };
}

function visibleTotal(html, key) {
  const root = createDocument().html(html);
  return find(root, (node) => node.getAttribute('data-fleet-coverage') === key).textContent;
}

test('the Fleet page renders the T5 DOM hooks for the totals, alerts, comparison, cards, and panels', async () => {
  const { html } = await render();
  for (const hook of ['data-fleet-totals', 'data-fleet-total="workers"', 'data-fleet-total="spend"', 'data-fleet-total="quota"',
    'data-fleet-alerts', 'data-fleet-alert-toggle', 'data-fleet-alert-fix', 'data-fleet-comparison', 'data-fleet-compare-row',
    'data-fleet-card', 'data-fleet-lanes', 'data-fleet-lane-toggle', 'data-fleet-actions', 'data-fleet-project', 'data-fleet-pending',
    'data-fleet-settings-form', 'data-fleet-shares-form']) assert.match(html, new RegExp(hook), hook);
  // The action hooks that T6 wires.
  assert.match(html, /data-action="update" data-name="win1" data-command="herdr-boss factory update win1 --tier service"/);
  assert.match(html, /data-action="boss" data-name="win1" data-command="herdr-boss factory boss start win1 --resume"/);
  assert.match(html, /data-fleet-alert-fix-copy data-copy="herdr-boss factory login win1 claude"/);
  assert.match(html, /data-copy="herdr-boss factory attach win1"/);
  // The native factory shows the release note and no container command.
  assert.match(html, /data-fleet-native-note/);
  assert.doesNotMatch(html, /data-name="factory-zero"/);
  const root = createDocument().html(html);
  assert.ok(find(root, (node) => node.getAttribute('data-fleet-totals') !== null));
  assert.ok(find(root, (node) => node.getAttribute('data-fleet-card') !== null));
  assert.ok(find(root, (node) => node.getAttribute('data-fleet-alert-toggle') !== null));
});

test('the compact comparison carries every hand-computed fact for each factory', async () => {
  const { html } = await render();
  assert.match(html, /data-fleet-factory="factory-zero"/);
  assert.match(html, /native · 10 s · 2 \/ 8 workers · 61% claude · spend \$6\.10 · 2 owner · 0\.1\.0 \/ 2e0a5d394ccc/);
  assert.match(html, /container · 12 s · 3 \/ 8 workers · 61% claude · spend \$8\.20 · 1 owner · 0\.1\.0 \/ 9c1f04ea77b2/);
  assert.match(html, /kit differs/);
  // The fresh-only totals are the hand-computed sums.
  assert.match(html, /data-fleet-total="workers"><span class="fleet-k">Workers<\/span><span class="fleet-v">5<\/span>/);
  assert.match(html, /data-fleet-total="spend"><span class="fleet-k">Spend · latest factory days<\/span><span class="fleet-v">\$14\.30<\/span>/);
  assert.match(html, /data-fleet-total="quota"><span class="fleet-k">Quota burn<\/span><span class="fleet-v">61%<\/span>/);
  // F1: the named non-fresh factory is visible, not only in a title attribute.
  assert.match(visibleTotal(html, 'workers'), /2 of 3 factories reporting/);
  assert.match(visibleTotal(html, 'workers'), /unavailable: win2 \(never seen\)/);
  assert.match(visibleTotal(html, 'spend'), /unavailable: win2 \(never seen\)/);
  assert.doesNotMatch(html, /title="2 of 3 factories reporting/);
});

test('the alert strip is collapsed at every width and names each fix command', async () => {
  const { html } = await render();
  assert.equal((html.match(/data-fleet-alert /g) || []).length, 5, 'five alerts for three factories');
  assert.equal((html.match(/data-fleet-alert-toggle aria-expanded="false"/g) || []).length, 5, 'every alert starts collapsed');
  assert.doesNotMatch(html, /class="alert open"/);
  for (const label of ['win2 is not reachable — check the host', 'win1 claude login expired — sign in',
    'factory-zero disk low — free disk space', 'factory-zero clock offset -42 s — check the clock',
    'factory-zero status stale for sample-app — check the project']) assert.ok(html.includes(label), label);
  for (const command of ['herdr-boss factory connect win2', 'herdr-boss factory login win1 claude',
    'Free disk space on this Mac. Check the data volume with df -h.',
    'Check Date and Time in System Settings on this Mac.', 'Open the sample-app project page. The orchestrator publishes.']) assert.ok(html.includes(command), command);
});

test('the phone section order is totals, alerts, comparison, cards, then the collapsed panels', async () => {
  const { html } = await render();
  const order = ['data-fleet-totals', 'data-fleet-alerts', 'data-fleet-comparison', 'data-fleet-card', 'data-fleet-settings-form'].map((mark) => html.indexOf(mark));
  for (const index of order) assert.ok(index >= 0, 'every section is present');
  for (let i = 1; i < order.length; i += 1) assert.ok(order[i - 1] < order[i], `section ${i} follows section ${i - 1}`);
  assert.match(html, /<details class="panel fleet-panels"/);
  assert.match(html, /Fleet settings and factory shares/);
});

test('a never-seen factory renders unknown with its reason and never a zero', async () => {
  const { html } = await render();
  const row = html.slice(html.indexOf('data-fleet-factory="win2"'), html.indexOf('data-fleet-factory="win2"') + 2000);
  assert.match(row, /unknown workers/);
  assert.match(row, /spend unknown/);
  assert.match(row, /unknown owner/);
  assert.doesNotMatch(row, /\$0\.00/);
  assert.doesNotMatch(row, /0 owner/);
  assert.match(html, /Last backup/);
  assert.match(html, /unknown/);
});

test('the C3 selected-date label shows latest factory day when the factory offset is absent', async () => {
  const { html } = await render();
  assert.match(html, /Spend · latest factory days/);
  assert.match(html, /latest factory day 2026-10-04/);
  assert.match(visibleTotal(html, 'spend'), /selected spend days: factory-zero 2026-10-05, win1 latest factory day 2026-10-04/);
});

test('a hostile factory name is escaped everywhere it appears', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const factories = inventedFactories();
  factories[2] = factory(hostile, { summary: null });
  const { html } = await render(factories);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img/);
});

test('a hostile rollup string is escaped in every rendered field', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const rows = [
    factory('factory-zero', { summary: summary('factory-zero', { kind: 'native',
      workers: { running: 1, max: 8 },
      quotas: [{ harness: hostile, accountKey: `${hostile}${'a'.repeat(64)}`, lane: hostile, usedPercent: 50, status: 'ok' }],
      projects: [{ slug: hostile, phase: hostile, status: 'doing', statusAgeSeconds: 10, board: { doing: 1, review: 0, blocked: 0, done7d: 0 } }],
      pending: [{ step: hostile, since: hostile }],
      harnesses: [{ harness: hostile, login: 'expired' }] }) }),
    factory('win1', { drift: hostile, summary: null }),
  ];
  const { html } = await render(rows, { ...role, neverTold: [hostile] });
  // The alert label and fix, the lane harness and key, the project slug and phase, the pending step, the drift, and neverTold.
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<script/);
  assert.ok((html.match(/&lt;img/g) || []).length >= 6, 'each hostile field is escaped');
});

test('the card shows the cached-facts health with the summary age', async () => {
  const { html } = await render();
  assert.match(html, /Health \(summary\)/);
  assert.match(html, /healthy · 10 s old/);
});

test('the head-office card label uses the row name, not a hardcoded factory name', async () => {
  const { html } = await render();
  assert.match(html, /factory-zero \(native\) · Head office \(epoch 3\)/);
  assert.doesNotMatch(html, /Factory zero/);
});

test('a hostile share value is escaped in the shares form', async () => {
  const { fleetSharesView } = await import('../public/fleet.js');
  const html = fleetSharesView({ accounts: [{ harness: 'codex', accountKey: 'a'.repeat(64), scope: ['factory-a'], shares: [{ factoryId: 'factory-a', share: '<img src=x onerror=alert(1)>' }] }] }, { headOffice: true });
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img/);
});

test('an unknown alert severity falls back to warning', async () => {
  const { fleetAlerts } = await import('../public/fleet.js');
  const html = fleetAlerts([{ id: 'x', code: 'disk-low', severity: 'crit"><script>', factory: 'f', label: 'l', fix: 'f' }]);
  assert.match(html, /class="sev warning"/);
  assert.match(html, /data-fleet-alert-severity="warning"/);
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /sev crit/);
});

test('the phone stylesheet keeps the C1 density and the 44 px controls', () => {
  const css = fs.readFileSync(new URL('../public/fleet.css', import.meta.url), 'utf8');
  const phone = css.slice(css.indexOf('@media (max-width: 760px)'));
  assert.match(phone, /\.fleet-page \{ margin: 0 -4px/);
  assert.match(phone, /\.fleet-total \{ flex: 1 1 30%; padding: 6px 8px; \}/);
  assert.match(phone, /\.cmp-row \{ grid-template-columns: minmax\(0, 1fr\) auto; gap: 0; padding: 6px 0; \}/);
  assert.match(phone, /\.cmp-sum \{[^}]*overflow-wrap: anywhere/);
  assert.match(phone, /\.fleet-page input, \.fleet-page textarea, \.fleet-page select \{ font-size: 16px; \}/);
  assert.match(css, /\.alert-toggle \{[^}]*min-height: 44px/);
  assert.match(css, /button\.lane-more \{[^}]*min-height: 44px/);
  assert.match(css, /button\.copy \{[^}]*min-height: 44px/);
  assert.match(css, /\.actions button, \.actions a, \.actions \.unavailable \{[^}]*min-height: 44px/);
});
