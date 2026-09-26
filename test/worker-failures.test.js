import test from 'node:test';
import assert from 'node:assert/strict';

import {
  matchWorkerFailure,
  shouldReadWorkerScreen,
  applyWorkerFailureStatuses,
  blockedWorkerAlerts,
  workerStatusFromState,
  inspectWorkerTransitions,
} from '../src/worker-failures.js';

test('worker failure matching returns only a fixed case-insensitive label', () => {
  for (const [line, label] of [
    ['API ERROR: sk-secret-token', 'API Error'],
    ['request got 401 unauthorized', '401'],
    ['HTTP 429; retry later', '429'],
    ['Connection Lost', 'Connection lost'],
    ['usage LIMIT reached', 'usage limit'],
    ['RATE LIMIT exceeded', 'rate limit'],
    ['provider overloaded', 'overloaded'],
  ]) assert.equal(matchWorkerFailure([line]), label);
  assert.equal(matchWorkerFailure(['all good']), null);
});

test('worker screen reads happen only on first observation or idle/done transitions', () => {
  const worker = { id: 'w1:p2', agent: 'codex', status: 'idle' };
  assert.equal(shouldReadWorkerScreen(null, worker), true);
  assert.equal(shouldReadWorkerScreen({ id: worker.id, agent: worker.agent, status: 'idle' }, worker), false);
  assert.equal(shouldReadWorkerScreen({ id: worker.id, agent: worker.agent, status: 'working' }, worker), true);
  assert.equal(shouldReadWorkerScreen({ id: worker.id, agent: 'pi', status: 'idle' }, worker), true);
  assert.equal(shouldReadWorkerScreen({ id: worker.id, agent: worker.agent, status: 'blocked' }, { ...worker, status: 'working' }), false);
});

test('screen inspection uses the bounded visible read and never exposes screen text', async () => {
  const pane = { id: 'w1:p2', workspace: 'w1', name: 'worker-a', agent: 'codex', status: 'idle' };
  const secret = 'API Error sk-secret-token';
  let reads = 0;
  const first = await inspectWorkerTransitions([pane], {}, {}, async (args) => {
    reads++;
    assert.deepEqual(args, ['pane', 'read', 'w1:p2', '--source', 'visible', '--lines', '8', '--format', 'text']);
    return secret;
  }, 1234);
  assert.equal(reads, 1);
  assert.equal(first.failures['w1:p2'].label, 'API Error');
  assert.doesNotMatch(JSON.stringify(first), /sk-secret-token|API Error sk-secret-token/);
  const again = await inspectWorkerTransitions([pane], first.observed, first.failures, async () => {
    reads++;
    return secret;
  }, 2234);
  assert.equal(reads, 1);
  assert.equal(again.notices.length, 1, 'an undelivered failure notice remains eligible');
  assert.equal(again.notices[0].key, first.notices[0].key);
  assert.doesNotMatch(JSON.stringify(again), /sk-secret-token/);
  const working = await inspectWorkerTransitions([{ ...pane, status: 'working' }], again.observed, again.failures, async () => secret, 3234);
  assert.equal(working.failures['w1:p2'], undefined);
  const idleAgain = await inspectWorkerTransitions([pane], working.observed, working.failures, async () => secret, 4234);
  assert.equal(idleAgain.notices.length, 1);
  assert.equal(idleAgain.failures['w1:p2'].label, 'API Error');
});

test('failed workers override the snapshot state and clear when working or replaced', () => {
  const panes = [
    { id: 'w1:p2', name: 'worker-a', agent: 'codex', status: 'idle' },
    { id: 'w1:p3', name: 'worker-b', agent: 'pi', status: 'working' },
  ];
  assert.deepEqual(applyWorkerFailureStatuses(panes, { 'w1:p2': { agent: 'codex', name: 'worker-a', label: '429' } })
    .map((p) => p.status), ['failed', 'working']);
  assert.equal(applyWorkerFailureStatuses([{ ...panes[0], status: 'working' }], { 'w1:p2': { agent: 'codex', name: 'worker-a', label: '429' } })[0].status, 'working');
  assert.equal(applyWorkerFailureStatuses([{ ...panes[0], agent: 'pi' }], { 'w1:p2': { agent: 'codex', name: 'worker-a', label: '429' } })[0].status, 'idle');
});

test('blocked workers get no notice before five minutes and a named notice after', () => {
  const now = 1_000_000;
  const snap = { herdr: { panes: [{ id: 'w1:p2', workspace: 'w1', name: 'worker-a', agent: 'codex', status: 'blocked' }] } };
  assert.deepEqual(blockedWorkerAlerts(snap, { 'w1:p2': { status: 'blocked', since: now - 299_999 } }, now), []);
  const [alert] = blockedWorkerAlerts(snap, { 'w1:p2': { status: 'blocked', since: now - 300_001 } }, now);
  assert.match(alert.text, /worker-a.*w1:p2/);
  assert.equal(alert.scope, 'w1');
});

test('the Agents snapshot boundary exposes a failed status for display', () => {
  const [pane] = applyWorkerFailureStatuses([
    { id: 'w1:p2', name: 'worker-a', agent: 'codex', status: 'idle' },
  ], { 'w1:p2': { agent: 'codex', name: 'worker-a', label: '429' } });
  assert.equal(pane.status, 'failed');
  assert.equal(pane.failureLabel, '429');
});

test('worker list can surface only matching failed-pane state', () => {
  assert.equal(workerStatusFromState('w1:p2', { herdr: { panes: [{ id: 'w1:p2', status: 'failed' }] } }), 'failed');
  assert.equal(workerStatusFromState('w1:p3', { herdr: { panes: [{ id: 'w1:p2', status: 'failed' }] } }), null);
});
