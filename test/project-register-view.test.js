import test from 'node:test';
import assert from 'node:assert/strict';
import { filterProjectRegister, projectActivityAge, reconcileProjectSelection, renderProjectRegister } from '../public/project-register-view.js';

const records = [
  { slug: 'pine-api', title: 'Pine API', group: 'platform', clientTag: 'Example Client', state: 'open', priority: 'high', pinned: true, nextAction: 'Review the sample flow', lastActivityAt: '2026-10-08T12:00:00Z' },
  { slug: 'maple-web', title: 'Maple Web', group: 'web', clientTag: 'Sample Studio', state: 'open', priority: 'normal', pinned: false, nextAction: 'Check the sample page', lastActivityAt: '2026-10-07T12:00:00Z' },
  { slug: 'cedar-tool', title: 'Cedar Tool', group: 'platform', state: 'parked', priority: 'low', pinned: false, nextAction: 'Wait for sample work', lastActivityAt: '' },
  { slug: 'birch-old', title: 'Birch Old', group: 'web', state: 'archived', priority: 'low', pinned: false, nextAction: '', lastActivityAt: '' },
];

test('register filters by area and client tag, then sorts by priority, activity, or title', () => {
  assert.deepEqual(filterProjectRegister(records, { group: 'platform', state: 'all', sort: 'title' }).map((row) => row.slug), ['cedar-tool', 'pine-api']);
  assert.deepEqual(filterProjectRegister(records, { query: 'sample studio', state: 'all', sort: 'title' }).map((row) => row.slug), ['maple-web']);
  assert.deepEqual(filterProjectRegister(records, { state: 'open', sort: 'priority' }).map((row) => row.slug), ['pine-api', 'maple-web']);
  assert.deepEqual(filterProjectRegister(records, { state: 'open', sort: 'activity' }).map((row) => row.slug), ['pine-api', 'maple-web']);
  assert.deepEqual(filterProjectRegister(records, { state: 'all', sort: 'title' }).map((row) => row.slug), ['birch-old', 'cedar-tool', 'maple-web', 'pine-api']);
});

test('register selection drops projects that the current filters hide', () => {
  assert.deepEqual(
    reconcileProjectSelection(records, { group: 'platform', state: 'all' }, ['pine-api', 'maple-web', 'cedar-tool']),
    ['pine-api', 'cedar-tool'],
  );
});

test('activity ages use readable relative time and pinned cards show the age', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  assert.equal(projectActivityAge('2026-10-07T12:00:00Z', now), '3 days ago');
  assert.equal(projectActivityAge('', now), 'No activity yet');
  const html = renderProjectRegister(records, { canWrite: true });
  assert.match(html, /<time class="register-focus-activity"[^>]*>Last active \d+ day(?:s)? ago<\/time>/);
  assert.doesNotMatch(html.replace(/ datetime="[^"]*"/g, ''), /2026-10-08T12:00:00Z/);
});

test('register renders focus, grouped rows, collapsed parked and archived folds, and safe labels', () => {
  const html = renderProjectRegister(records, { selected: ['pine-api'], canWrite: true });
  assert.match(html, /data-register-search/);
  assert.match(html, /data-register-group/);
  assert.match(html, /data-register-state/);
  assert.match(html, /data-register-sort/);
  assert.match(html, /Pinned projects/);
  assert.match(html, /Example Client/);
  assert.match(html, /Parked \(1\)/);
  assert.match(html, /Archived \(1\)/);
  assert.match(html, /<details[^>]*data-register-fold="parked"/);
  assert.doesNotMatch(html, /<details[^>]*data-register-fold="archived"[^>]*open/);
  assert.match(html, /data-register-select="pine-api"/);
  assert.match(html, /data-register-bulk="park"/);

  const hostile = renderProjectRegister([{ ...records[0], title: '<img src=x onerror=alert(1)>' }]);
  assert.doesNotMatch(hostile, /<img src=x/);
  assert.match(hostile, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('read-only register disables mutations while keeping project links available', () => {
  const html = renderProjectRegister(records, { canWrite: false });
  assert.match(html, /data-register-action="park"[^>]*disabled/);
  assert.match(html, /data-register-pin="pine-api"[^>]*disabled/);
  assert.match(html, /href="\/projects\/pine-api"/);
});
