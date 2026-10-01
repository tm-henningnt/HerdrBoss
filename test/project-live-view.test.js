import test from 'node:test';
import assert from 'node:assert/strict';
import {
  noWorkerBadgeView,
  phaseAgeText,
  publishedAgeBadgeView,
  projectSyncLineView,
  summaryAgeText,
  unplannedCardView,
} from '../public/project-live-view.js';

test('unplanned worker cards show the name, kind, model, age, and a stable key', () => {
  assert.deepEqual(unplannedCardView({
    name: 'worker-a', kind: 'codex', model: 'gpt-6-luna', startedAt: '2026-10-01T10:00:00.000Z', ageMin: 7, pane: 'p1',
  }), {
    key: 'unplanned:worker-a:2026-10-01T10:00:00.000Z:p1',
    name: 'worker-a', kind: 'codex', model: 'gpt-6-luna', age: '7 min ago',
  });
});

test('the no-worker badge is amber only for a task marked by the server', () => {
  assert.deepEqual(noWorkerBadgeView({ noWorker: true }), { text: 'No worker', tone: 'warn' });
  assert.equal(noWorkerBadgeView({ noWorker: false }), null);
});

test('published, phase, and summary ages use the live minute fields', () => {
  assert.deepEqual(publishedAgeBadgeView(31, 'warn'), { text: 'status published 31 min ago', tone: 'warn' });
  assert.deepEqual(publishedAgeBadgeView(4, 'ok'), { text: 'status published 4 min ago', tone: 'plain' });
  assert.deepEqual(publishedAgeBadgeView(4, null), { text: 'status published 4 min ago', tone: 'plain' });
  assert.equal(phaseAgeText(12), 'phase updated 12 min ago');
  assert.equal(summaryAgeText(3), 'summary updated 3 min ago');
});

test('the sync line uses the server text and marks an out-of-sync result', () => {
  assert.deepEqual(projectSyncLineView({ text: 'Agents 3 working, board Doing 0: out of sync', inSync: false }), {
    text: 'Agents 3 working, board Doing 0: out of sync', tone: 'warn',
  });
  assert.deepEqual(projectSyncLineView({ text: 'Agents 0 working, board Doing 0: in sync', inSync: true }), {
    text: 'Agents 0 working, board Doing 0: in sync', tone: 'plain',
  });
});
