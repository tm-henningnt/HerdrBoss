import test from 'node:test';
import assert from 'node:assert/strict';

import {
  matchWorkerFailure,
  parseFreeUsageRetryTime,
  resolveFreeUsageRun,
  activeFreeModelExhaustions,
  extendFreeModelExhaustion,
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
    ['HTTP 401', '401'],
    ['status 401', '401'],
    ['HTTP 429; retry later', '429'],
    ['Connection Lost', 'Connection lost'],
    ['usage LIMIT reached', 'usage limit'],
    ['usage limit exceeded', 'usage limit'],
    ['hit your usage limit', 'usage limit'],
    ['RATE LIMIT exceeded', 'rate limit'],
    ['provider overloaded', 'overloaded'],
    ['FREE USAGE EXCEEDED. Retry in 5h 48m.', 'Free usage exceeded'],
  ]) assert.equal(matchWorkerFailure([line]), label);
  for (const line of ['401', 'usage limit']) assert.equal(matchWorkerFailure([line]), null);
  assert.equal(matchWorkerFailure(['all good']), null);
});

test('free usage retry parser accepts fixed-clock relative and absolute times only when future', () => {
  const now = Date.parse('2026-09-26T10:00:00.000Z');
  assert.equal(parseFreeUsageRetryTime('Free usage exceeded. retry in 5h 48m', now), now + 5 * 3600000 + 48 * 60000);
  assert.equal(parseFreeUsageRetryTime('Free usage exceeded. retry at 2026-09-26T15:48:00Z', now), Date.parse('2026-09-26T15:48:00Z'));
  assert.equal(parseFreeUsageRetryTime('Free usage exceeded. retry in 5 hours-ish', now), null);
  assert.equal(parseFreeUsageRetryTime('Free usage exceeded.', now), null);
  assert.equal(parseFreeUsageRetryTime('Free usage exceeded. retry at 2026-09-26T09:00:00Z', now), null);
  assert.equal(parseFreeUsageRetryTime('Free usage exceeded. retry at 2026-02-30T15:48:00Z', now), null);
});

test('free usage failure stores only its fixed label and parsed retry time', async () => {
  const pane = { id: 'w1:p2', workspace: 'w1', name: 'worker-a', agent: 'codex', status: 'idle' };
  const result = await inspectWorkerTransitions([pane], {}, {}, async () => 'Free usage exceeded. retry in 5h 48m. secret=do-not-store', Date.parse('2026-09-26T10:00:00Z'));
  assert.equal(result.failures['w1:p2'].label, 'Free usage exceeded');
  assert.equal(result.failures['w1:p2'].retryAt, Date.parse('2026-09-26T15:48:00Z'));
  assert.doesNotMatch(JSON.stringify(result), /secret|do-not-store|retry in/);
});

test('free usage model association requires matching recorded name and pane and an unmetered route', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'free-run-'));
  const checkout = path.join(root, 'checkout');
  const worker = path.join(root, 'worker');
  fs.mkdirSync(checkout);
  execFileSync('git', ['init', '-b', 'main', checkout], { stdio: 'ignore' });
  fs.writeFileSync(path.join(checkout, '.herdr-boss.json'), JSON.stringify({ slug: 'sample', runsDir: '.worker/runs' }));
  fs.writeFileSync(path.join(checkout, 'tracked.txt'), 'tracked');
  execFileSync('git', ['-C', checkout, 'add', '.herdr-boss.json', 'tracked.txt'], { stdio: 'ignore' });
  execFileSync('git', ['-C', checkout, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'], { stdio: 'ignore' });
  execFileSync('git', ['-C', checkout, 'worktree', 'add', '-b', 'worker-a', worker], { stdio: 'ignore' });
  fs.mkdirSync(path.join(checkout, '.worker/runs'), { recursive: true });
  const record = path.join(checkout, '.worker/runs', 'worker-a.json');
  const pane = { id: 'w1:p2', name: 'W worker-a', cwd: worker };
  fs.writeFileSync(record, JSON.stringify({ name: 'worker-a', pane: pane.id, kind: 'opencode', model: 'opencode/free', worktree: worker }));
  assert.equal(resolveFreeUsageRun(pane, { providerFor: () => null, policy: {} }), null);
  assert.deepEqual(resolveFreeUsageRun(pane, { providerFor: () => null, policy: {}, runsCwd: checkout }), { project: 'sample', kind: 'opencode', model: 'opencode/free' });
  assert.equal(resolveFreeUsageRun(pane, { providerFor: () => 'opencodego', policy: {}, runsCwd: checkout }), null);
  fs.writeFileSync(record, JSON.stringify({ name: 'worker-a', pane: 'other:pane', kind: 'opencode', model: 'opencode/free', worktree: worker }));
  assert.equal(resolveFreeUsageRun(pane, { providerFor: () => null, policy: {}, runsCwd: checkout }), null);
  fs.writeFileSync(record, JSON.stringify({ name: 'worker-a', pane: pane.id, kind: 'opencode', model: 'opencode/free', worktree: worker, finishedAt: '2026-09-26T09:00:00Z' }));
  assert.equal(resolveFreeUsageRun(pane, { providerFor: () => null, policy: {}, runsCwd: checkout }), null);
});

test('free model exhaustion extends to the latest retry and expires at the retry time', () => {
  const association = { project: 'sample', kind: 'opencode', model: 'opencode/free' };
  const first = extendFreeModelExhaustion({}, association, 5000, 1000);
  const extended = extendFreeModelExhaustion(first, { ...association, project: 'another-project', kind: 'pi' }, 9000, 2000);
  const older = extendFreeModelExhaustion(extended, association, 7000, 3000);
  const key = 'opencode/free';
  assert.equal(older[key].retryAt, 9000);
  assert.deepEqual(Object.keys(activeFreeModelExhaustions(older, 8999)), [key]);
  assert.deepEqual(activeFreeModelExhaustions(older, 9000), {});
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

test('report notices use first-seen metadata for both paths and ignore orchestrators', async () => {
  const { inspectWorkerReports } = await import('../src/worker-failures.js');
  const panes = [
    { id: 'ws:p1', workspace: 'ws', cwd: '/work/a', name: 'alpha', agent: 'codex', status: 'working' },
    { id: 'ws:p2', workspace: 'ws', cwd: '/work/b', name: 'beta', agent: 'pi', status: 'idle' },
    { id: 'ws:p3', workspace: 'ws', cwd: '/work/c', name: 'orch', agent: 'codex', status: 'working', orch: true },
  ];
  const files = new Map([
    ['/work/a/.worker/report.json', { isFile: true, mtimeMs: 101 }],
    ['/work/b/.worker/beta/report.json', { isFile: true, mtimeMs: 102 }],
    ['/work/c/.worker/report.json', { isFile: true, mtimeMs: 999 }],
  ]);
  const calls = [];
  const stat = (file) => { calls.push(file); return files.get(file) || null; };
  const first = inspectWorkerReports(panes, {}, 100, stat);
  assert.deepEqual(first.notices.map(({ text, scope }) => [text, scope]), [
    ['Worker alpha in pane ws:p1 wrote its report: /work/a/.worker/report.json', 'ws'],
    ['Worker beta in pane ws:p2 wrote its report: /work/b/.worker/beta/report.json', 'ws'],
  ]);
  assert.deepEqual(calls, [
    '/work/a/.worker/report.json', '/work/a/.worker/alpha/report.json',
    '/work/b/.worker/report.json', '/work/b/.worker/beta/report.json',
  ]);
  const changedStatus = inspectWorkerReports(panes.map((pane) => ({ ...pane, status: 'blocked' })), first.observed, 200, stat);
  assert.deepEqual(changedStatus.notices.map((notice) => notice.key), first.notices.map((notice) => notice.key));
  const changedIdentity = inspectWorkerReports([
    { ...panes[0], agent: 'pi', name: 'renamed', sessionId: 'new-session' },
  ], first.observed, 150, stat);
  assert.equal(changedIdentity.observed['ws:p1'].firstSeen, 100);
  assert.equal(changedIdentity.notices[0].text, 'Worker renamed in pane ws:p1 wrote its report: /work/a/.worker/report.json');
  files.set('/work/a/.worker/report.json', { isFile: true, mtimeMs: 201 });
  const edited = inspectWorkerReports(panes, changedStatus.observed, 202, stat);
  assert.equal(edited.notices.length, 2);
  assert.ok(edited.notices.some((notice) => notice.key.endsWith(':201')
    && notice.text === 'Worker alpha in pane ws:p1 wrote its report: /work/a/.worker/report.json'));
});

test('report inspection accepts metadata only and ignores non-files and stale reports', async () => {
  const { inspectWorkerReports } = await import('../src/worker-failures.js');
  const pane = { id: 'ws:p1', workspace: 'ws', cwd: '/work', name: 'alpha', agent: 'codex' };
  const calls = [];
  const result = inspectWorkerReports([pane], {}, 500, (file) => {
    calls.push(file);
    if (file === '/work/.worker/report.json') return { isFile: false, mtimeMs: 900 };
    if (file === '/work/.worker/alpha/report.json') return { isFile: true, mtimeMs: 499 };
    return null;
  });
  assert.deepEqual(calls, ['/work/.worker/report.json', '/work/.worker/alpha/report.json']);
  assert.deepEqual(result.notices, []);
  assert.equal(result.observed['ws:p1'].firstSeen, 500);
});

test('worker failure matching ignores Tip lines and requires error forms for 401 and usage limits', () => {
  for (const [screen, label] of [
    ['401 Unauthorized', '401'],
    ['HTTP 401', '401'],
    ['status 401', '401'],
    ['usage limit reached', 'usage limit'],
    ['usage limit exceeded', 'usage limit'],
    ['hit your usage limit', 'usage limit'],
    ['Tip: Check when your usage limits reset', null],
    ['401', null],
    ['usage limit', null],
    ['other text\n  tIP: 401 Unauthorized', null],
    ['Tip: Check usage limits\nAPI Error: request failed', 'API Error'],
  ]) assert.equal(matchWorkerFailure(screen), label, screen);
});
