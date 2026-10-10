import './helpers/test-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateAlerts } from '../src/alert-groups.js';
import { dismissInformationalAlert, filterDismissedInfoAlerts } from '../public/alert-dismissal.js';

const BASE = Date.parse('2026-10-10T10:00:00.000Z');
const disk = (freeGB = '18.9', scope = 'project-a') => ({
  key: `machine:disk:${scope}:warn`, severity: 'warn', scope,
  title: `Disk space low: ${freeGB} GB free`, text: `The data filesystem has ${freeGB} GB free.`,
});
const info = (title = 'Browser is ready') => ({
  key: 'browser:managed-ready:project-a:9334:visible', severity: 'info', scope: 'project-a', title, text: `${title}.`,
});

function fakeStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test('five identical raises make one stable row with a count and first and last times', () => {
  let state = {};
  let rows = [];
  for (let index = 0; index < 5; index++) {
    const result = aggregateAlerts([disk()], state, BASE + index * 1000);
    state = result.state;
    rows = result.alerts;
  }

  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 'machine:disk');
  assert.equal(rows[0].count, 5);
  assert.equal(rows[0].firstAt, new Date(BASE).toISOString());
  assert.equal(rows[0].lastAt, new Date(BASE + 4000).toISOString());
});

test('a changed value updates the row text and keeps the stable key', () => {
  const first = aggregateAlerts([disk()], {}, BASE);
  const changed = aggregateAlerts([disk('17.2')], first.state, BASE + 1000);

  assert.equal(changed.alerts.length, 1);
  assert.equal(changed.alerts[0].key, 'machine:disk');
  assert.match(changed.alerts[0].text, /17\.2 GB free/);
});

test('a cleared alert leaves no stale row and the next raise starts a new count', () => {
  const first = aggregateAlerts([disk(), disk('18.9', 'project-b')], {}, BASE);
  const cleared = aggregateAlerts([], first.state, BASE + 1000);
  const raisedAgain = aggregateAlerts([disk()], cleared.state, BASE + 2000);

  assert.equal(first.alerts.length, 1);
  assert.equal(first.alerts[0].count, 2);
  assert.deepEqual(cleared.alerts, []);
  assert.equal(raisedAgain.alerts[0].count, 1);
  assert.equal(raisedAgain.alerts[0].firstAt, new Date(BASE + 2000).toISOString());
});

test('an informational notice expires after 24 hours', () => {
  const first = aggregateAlerts([info()], {}, BASE);
  const now = BASE + 24 * 60 * 60 * 1000 + 1;
  const expired = aggregateAlerts([], first.state, now);
  const repeated = aggregateAlerts([info()], first.state, now);

  assert.deepEqual(expired.alerts, []);
  assert.deepEqual(repeated.alerts, []);
});

test('a dismissed informational notice stays hidden until it fires again', () => {
  const storage = fakeStorage();
  const first = aggregateAlerts([info()], {}, BASE).alerts[0];
  assert.equal(filterDismissedInfoAlerts([first], storage).length, 1);

  assert.equal(dismissInformationalAlert(first, storage, BASE + 500), true);
  assert.deepEqual(filterDismissedInfoAlerts([first], storage), []);

  const continued = aggregateAlerts([info()], { [first.key]: { ...first, present: true } }, BASE + 1000).alerts[0];
  assert.deepEqual(filterDismissedInfoAlerts([continued], storage), []);

  const cleared = aggregateAlerts([], { [first.key]: { ...first, present: true } }, BASE + 2000);
  const raisedAgain = aggregateAlerts([info()], cleared.state, BASE + 3000).alerts[0];
  assert.ok(Date.parse(raisedAgain.firstAt) > BASE + 500);
  assert.equal(filterDismissedInfoAlerts([raisedAgain], storage).length, 1);

  const warning = { ...disk(), firstAt: new Date(BASE).toISOString() };
  assert.equal(dismissInformationalAlert(warning, storage, BASE + 4000), false);
  assert.deepEqual(filterDismissedInfoAlerts([warning], storage), [warning]);
});

test('informational notices still work when browser storage throws', () => {
  const storage = {
    getItem() { throw new Error('storage is unavailable'); },
    setItem() { throw new Error('storage is unavailable'); },
  };
  const notice = aggregateAlerts([{ ...info('Kit updated'), key: 'kit:updated:fixture' }], {}, BASE).alerts[0];

  assert.equal(filterDismissedInfoAlerts([notice], storage).length, 1);
  assert.equal(dismissInformationalAlert(notice, storage, BASE + 500), true);
  assert.deepEqual(filterDismissedInfoAlerts([notice], storage), []);
});
