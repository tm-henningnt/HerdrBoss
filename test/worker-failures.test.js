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
  assert.deepEqual(resolveFreeUsageRun(pane, { providerFor: () => null, policy: {} }), { project: 'sample', kind: 'opencode', model: 'opencode/free' });
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

test('worker screen reads happen on first observation, on idle/done transitions, and on every working tick', () => {
  const worker = { id: 'w1:p2', agent: 'codex', status: 'idle' };
  assert.equal(shouldReadWorkerScreen(null, worker), true);
  assert.equal(shouldReadWorkerScreen({ id: worker.id, agent: worker.agent, status: 'idle' }, worker), false);
  assert.equal(shouldReadWorkerScreen({ id: worker.id, agent: worker.agent, status: 'working' }, worker), true);
  assert.equal(shouldReadWorkerScreen({ id: worker.id, agent: 'pi', status: 'idle' }, worker), true);
  assert.equal(shouldReadWorkerScreen({ id: worker.id, agent: worker.agent, status: 'blocked' }, { ...worker, status: 'blocked' }), false);
  assert.equal(shouldReadWorkerScreen({ id: worker.id, agent: worker.agent, status: 'working' }, { ...worker, status: 'working' }), true);
  assert.equal(shouldReadWorkerScreen({ id: worker.id, agent: worker.agent, status: 'idle' }, { ...worker, status: 'blocked' }), false);
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
  assert.equal(working.failures['w1:p2'].label, 'API Error', 'a failing working pane stays failed');
  assert.equal(working.failures['w1:p2'].at, first.failures['w1:p2'].at, 'a repeated match keeps the original notice time');
  assert.equal(working.notices[0].key, first.notices[0].key, 'a repeated match keeps one notice');
  assert.doesNotMatch(JSON.stringify(working), /sk-secret-token/);
  const recovered = await inspectWorkerTransitions([{ ...pane, status: 'working' }], working.observed, working.failures, async () => 'ordinary output', 4234);
  assert.equal(recovered.failures['w1:p2'], undefined, 'a successful read clears a working failure');
  assert.deepEqual(recovered.notices, []);
  const idleAgain = await inspectWorkerTransitions([pane], recovered.observed, recovered.failures, async () => secret, 5234);
  assert.equal(idleAgain.notices.length, 1);
  assert.equal(idleAgain.failures['w1:p2'].label, 'API Error');
});

test('failed workers override the snapshot state and clear when the pane identity changes', () => {
  const panes = [
    { id: 'w1:p2', name: 'worker-a', agent: 'codex', status: 'idle' },
    { id: 'w1:p3', name: 'worker-b', agent: 'pi', status: 'working' },
  ];
  assert.deepEqual(applyWorkerFailureStatuses(panes, { 'w1:p2': { agent: 'codex', name: 'worker-a', label: '429' } })
    .map((p) => p.status), ['failed', 'working']);
  assert.equal(applyWorkerFailureStatuses([{ ...panes[0], status: 'working' }], { 'w1:p2': { agent: 'codex', name: 'worker-a', label: '429' } })[0].status, 'failed');
  assert.equal(applyWorkerFailureStatuses([{ ...panes[0], agent: 'pi' }], { 'w1:p2': { agent: 'codex', name: 'worker-a', label: '429' } })[0].status, 'idle');
  assert.equal(applyWorkerFailureStatuses([{ ...panes[0], sessionId: 'other' }],
    { 'w1:p2': { agent: 'codex', name: 'worker-a', sessionId: 's1', label: '429' } })[0].status, 'idle');
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
  // A failed pane always has an agent: applyWorkerFailureStatuses marks only agent panes.
  assert.equal(workerStatusFromState('w1:p2', { herdr: { panes: [{ id: 'w1:p2', agent: 'codex', status: 'failed' }] } }), 'failed');
  assert.equal(workerStatusFromState('w1:p3', { herdr: { panes: [{ id: 'w1:p2', agent: 'codex', status: 'failed' }] } }), null);
});

test('worker list reports no failed status for previous-role panes from a stale run record', () => {
  const state = { herdr: { panes: [
    { id: 'w1:p1', label: 'orch previous', orch: false, name: 'worker-a', agent: 'codex', status: 'failed' },
    { id: 'wb:p1', label: 'boss previous', orch: false, name: 'worker-a', agent: 'codex', status: 'failed' },
    { id: 'w1:p3', label: null, orch: false, name: 'worker-a', agent: 'codex', status: 'failed' },
  ] } };
  const run = { name: 'worker-a', kind: 'codex' };
  assert.equal(workerStatusFromState('w1:p1', state, run), null);
  assert.equal(workerStatusFromState('wb:p1', state, run), null);
  assert.equal(workerStatusFromState('w1:p3', state, run), 'failed');
});

test('a report notice waits for the grace time, then names a worker that sent no report prompt', async () => {
  const { inspectWorkerReports, WORKER_REPORT_GRACE_MS } = await import('../src/worker-failures.js');
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
  const reads = [];
  const readScreen = async (args) => { reads.push(args.join(' ')); return 'no prompt here'; };
  const first = await inspectWorkerReports(panes, {}, 100, stat, readScreen);
  assert.deepEqual(first.notices, [], 'the first sight of a report gives no notice');
  assert.deepEqual(calls, [
    '/work/a/.worker/report.json', '/work/a/.worker/alpha/report.json',
    '/work/b/.worker/report.json', '/work/b/.worker/beta/report.json',
  ]);
  const early = await inspectWorkerReports(panes, first.observed, 100 + WORKER_REPORT_GRACE_MS - 1, stat, readScreen);
  assert.deepEqual(early.notices, []);
  const late = await inspectWorkerReports(panes, early.observed, 100 + WORKER_REPORT_GRACE_MS, stat, readScreen);
  assert.deepEqual(late.notices.map(({ text, scope }) => [text, scope]), [
    ['Worker alpha in pane ws:p1 wrote its report: /work/a/.worker/report.json', 'ws'],
    ['Worker beta in pane ws:p2 wrote its report: /work/b/.worker/beta/report.json', 'ws'],
  ]);
  const readsBefore = reads.length;
  const changedStatus = await inspectWorkerReports(panes.map((pane) => ({ ...pane, status: 'blocked' })), late.observed, 100 + WORKER_REPORT_GRACE_MS + 5, stat, readScreen);
  assert.deepEqual(changedStatus.notices.map((notice) => notice.key), late.notices.map((notice) => notice.key));
  assert.equal(reads.length, readsBefore, 'a noticed report is not read again');
  const changedIdentity = await inspectWorkerReports([
    { ...panes[0], agent: 'pi', name: 'renamed', sessionId: 'new-session' },
  ], late.observed, 100 + WORKER_REPORT_GRACE_MS + 6, stat, readScreen);
  assert.equal(changedIdentity.observed['ws:p1'].firstSeen, 100);
  assert.equal(changedIdentity.notices[0].text, 'Worker renamed in pane ws:p1 wrote its report: /work/a/.worker/report.json');
  files.set('/work/a/.worker/report.json', { isFile: true, mtimeMs: 201 });
  const edited = await inspectWorkerReports(panes, changedStatus.observed, 100 + WORKER_REPORT_GRACE_MS + 7, stat, readScreen);
  assert.deepEqual(edited.notices.map((notice) => notice.key), late.notices.map((notice) => notice.key), 'an edited report keeps its key');
});

test('a worker that sent its WORKER REPORT prompt gets no report notice', async () => {
  const { inspectWorkerReports, workerReportPromptSent, WORKER_REPORT_GRACE_MS } = await import('../src/worker-failures.js');
  const sent = 'x\n$ herdr agent prompt wB:p5T "WORKER REPORT alpha: done. Report: /work/a/.worker/report.md"\nok';
  assert.equal(workerReportPromptSent(sent, 'alpha'), true);
  assert.equal(workerReportPromptSent(sent, 'alp'), false);
  assert.equal(workerReportPromptSent(sent, 'alpha-2'), false);
  assert.equal(workerReportPromptSent('The brief says: WORKER REPORT alpha: <done|blocked|stopped>', 'alpha'), false, 'text without the send command does not count');
  const panes = [{ id: 'ws:p1', workspace: 'ws', cwd: '/work/a', name: 'alpha', agent: 'codex', status: 'idle' }];
  const stat = () => ({ isFile: true, mtimeMs: 101 });
  let screen = 'still writing';
  const readScreen = async () => screen;
  const first = await inspectWorkerReports(panes, {}, 100, stat, readScreen);
  assert.deepEqual(first.notices, []);
  screen = sent;
  const second = await inspectWorkerReports(panes, first.observed, 100 + 1000, stat, readScreen);
  assert.deepEqual(second.notices, []);
  screen = 'scrolled away';
  const third = await inspectWorkerReports(panes, second.observed, 100 + WORKER_REPORT_GRACE_MS + 1, stat, readScreen);
  assert.deepEqual(third.notices, [], 'a prompt seen once stays settled');
  const one = (file) => (file === '/work/a/.worker/report.json' ? { isFile: true, mtimeMs: 101 } : null);
  const failing = await inspectWorkerReports(panes, {}, 100, one, async () => { throw new Error('boom'); });
  const afterGrace = await inspectWorkerReports(panes, failing.observed, 100 + WORKER_REPORT_GRACE_MS, one, async () => { throw new Error('boom'); });
  assert.equal(afterGrace.notices.length, 1, 'a failed read counts as no prompt');
});

test('report inspection accepts metadata only and ignores non-files and stale reports', async () => {
  const { inspectWorkerReports } = await import('../src/worker-failures.js');
  const pane = { id: 'ws:p1', workspace: 'ws', cwd: '/work', name: 'alpha', agent: 'codex' };
  const calls = [];
  const result = await inspectWorkerReports([pane], {}, 500, (file) => {
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

async function makeFreeRunFixture() {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'free-run-working-'));
  const checkout = path.join(root, 'checkout');
  const worktree = path.join(root, 'worker');
  fs.mkdirSync(checkout);
  execFileSync('git', ['init', '-b', 'main', checkout], { stdio: 'ignore' });
  fs.writeFileSync(path.join(checkout, '.herdr-boss.json'), JSON.stringify({ slug: 'sample', runsDir: '.worker/runs' }));
  fs.writeFileSync(path.join(checkout, 'tracked.txt'), 'tracked');
  execFileSync('git', ['-C', checkout, 'add', '.herdr-boss.json', 'tracked.txt'], { stdio: 'ignore' });
  execFileSync('git', ['-C', checkout, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'], { stdio: 'ignore' });
  execFileSync('git', ['-C', checkout, 'worktree', 'add', '-b', 'worker-a', worktree], { stdio: 'ignore' });
  fs.mkdirSync(path.join(checkout, '.worker/runs'), { recursive: true });
  fs.writeFileSync(path.join(checkout, '.worker/runs', 'worker-a.json'), JSON.stringify({
    name: 'worker-a', pane: 'w1:p2', kind: 'opencode', model: 'opencode/free', worktree,
  }));
  return { checkout, worktree };
}

test('a working pane with a known provider error becomes failed without exposing pane text', async () => {
  const pane = { id: 'w1:p2', workspace: 'w1', name: 'worker-a', agent: 'codex', status: 'working', sessionId: 's1' };
  const result = await inspectWorkerTransitions([pane], {}, {}, async () => 'API Error: sk-secret-token', 1000);
  assert.equal(result.failures['w1:p2'].label, 'API Error');
  const [applied] = applyWorkerFailureStatuses([pane], result.failures);
  assert.equal(applied.status, 'failed');
  assert.equal(applied.failureLabel, 'API Error');
  assert.equal(result.notices.length, 1);
  assert.equal(result.notices[0].title, 'Worker worker-a failed');
  assert.doesNotMatch(JSON.stringify({ result, applied }), /sk-secret-token/);
});

test('an ordinary working pane stays working and a working failure clears after a clean read', async () => {
  const pane = { id: 'w1:p2', workspace: 'w1', name: 'worker-a', agent: 'codex', status: 'working', sessionId: 's1' };
  const clean = await inspectWorkerTransitions([pane], {}, {}, async () => 'still working on it', 1000);
  assert.equal(clean.failures['w1:p2'], undefined);
  assert.deepEqual(clean.notices, []);
  assert.equal(applyWorkerFailureStatuses([pane], clean.failures)[0].status, 'working');
  const failed = await inspectWorkerTransitions([pane], clean.observed, clean.failures, async () => 'HTTP 429 too many requests', 2000);
  assert.equal(failed.failures['w1:p2'].label, '429');
  assert.equal(applyWorkerFailureStatuses([pane], failed.failures)[0].status, 'failed');
  const repeat = await inspectWorkerTransitions([pane], failed.observed, failed.failures, async () => 'HTTP 429 too many requests', 2600);
  assert.equal(repeat.notices[0].key, failed.notices[0].key, 'a repeated match keeps one notice');
  assert.equal(repeat.failures['w1:p2'].at, failed.failures['w1:p2'].at);
  const recovered = await inspectWorkerTransitions([pane], repeat.observed, repeat.failures, async () => 'still working on it', 3200);
  assert.equal(recovered.failures['w1:p2'], undefined);
  assert.deepEqual(recovered.notices, []);
  assert.equal(applyWorkerFailureStatuses([pane], recovered.failures)[0].status, 'working');
});

test('a working-pane failure clears when the pane identity changes', async () => {
  const pane = { id: 'w1:p2', workspace: 'w1', name: 'worker-a', agent: 'codex', status: 'working', sessionId: 's1' };
  const failed = await inspectWorkerTransitions([pane], {}, {}, async () => 'Connection lost', 1000);
  assert.equal(failed.failures['w1:p2'].label, 'Connection lost');
  const replaced = await inspectWorkerTransitions([{ ...pane, sessionId: 's2' }], failed.observed, failed.failures, async () => 'ordinary output', 2000);
  assert.equal(replaced.failures['w1:p2'], undefined);
  assert.deepEqual(replaced.notices, []);
  assert.equal(applyWorkerFailureStatuses([{ ...pane, sessionId: 's2' }], replaced.failures)[0].status, 'working');
});

test('a free-usage failure from a working pane keeps one retry deadline and expires with it', async () => {
  const { checkout, worktree } = await makeFreeRunFixture();
  const now = Date.parse('2026-09-26T10:00:00Z');
  const retryAt = Date.parse('2026-09-26T15:48:00Z');
  const pane = { id: 'w1:p2', workspace: 'w1', name: 'W worker-a', agent: 'opencode', status: 'working', cwd: worktree };
  const screen = 'Free usage exceeded. retry in 5h 48m';
  const first = await inspectWorkerTransitions([pane], {}, {}, async () => screen, now);
  assert.equal(first.failures['w1:p2'].label, 'Free usage exceeded');
  assert.equal(first.failures['w1:p2'].retryAt, retryAt);
  const repeat = await inspectWorkerTransitions([pane], first.observed, first.failures, async () => screen, now + 60000);
  assert.equal(repeat.failures['w1:p2'].retryAt, retryAt, 'a repeated match keeps the first deadline');
  assert.equal(repeat.notices[0].key, first.notices[0].key);
  const laterTick = await inspectWorkerTransitions([pane], repeat.observed, repeat.failures, async () => screen, now + 600000);
  assert.equal(laterTick.failures['w1:p2'].retryAt, retryAt, 'unchanged relative retry text does not slide forward');
  assert.equal(laterTick.notices[0].key, first.notices[0].key);
  const association = resolveFreeUsageRun(pane, { providerFor: () => null, policy: {}, runsCwd: checkout });
  assert.deepEqual(association, { project: 'sample', kind: 'opencode', model: 'opencode/free' });
  const exhausted = extendFreeModelExhaustion({}, association, repeat.failures['w1:p2'].retryAt, now);
  assert.deepEqual(Object.keys(activeFreeModelExhaustions(exhausted, now)), ['opencode/free']);
  assert.deepEqual(activeFreeModelExhaustions(exhausted, retryAt), {});
});

test('a later absolute retry timestamp extends the deadline without a new notice', async () => {
  const pane = { id: 'w1:p2', workspace: 'w1', name: 'worker-a', agent: 'codex', status: 'working', sessionId: 's1' };
  const firstNow = Date.parse('2026-09-27T11:00:00Z');
  const firstDeadline = Date.parse('2026-09-27T12:00:00Z');
  const laterDeadline = Date.parse('2026-09-27T13:00:00Z');
  const first = await inspectWorkerTransitions([pane], {}, {}, async () => 'Free usage exceeded. retry at 2026-09-27T12:00:00Z', firstNow);
  assert.equal(first.failures['w1:p2'].retryAt, firstDeadline);
  const later = await inspectWorkerTransitions([pane], first.observed, first.failures,
    async () => 'Free usage exceeded. retry at 2026-09-27T13:00:00Z', Date.parse('2026-09-27T11:01:00Z'));
  assert.equal(later.failures['w1:p2'].retryAt, laterDeadline, 'a later absolute timestamp replaces the deadline');
  assert.equal(later.failures['w1:p2'].at, first.failures['w1:p2'].at, 'the first observation time stays');
  assert.equal(later.notices[0].key, first.notices[0].key, 'the notice stays deduplicated');
  assert.doesNotMatch(JSON.stringify(later), /retry at/);
  const earlier = await inspectWorkerTransitions([pane], later.observed, later.failures,
    async () => 'Free usage exceeded. retry at 2026-09-27T12:30:00Z', Date.parse('2026-09-27T11:02:00Z'));
  assert.equal(earlier.failures['w1:p2'].retryAt, laterDeadline, 'an earlier timestamp never shortens the deadline');
});

test('previous-role panes are left out of worker screen reads, reports, blocked alerts, and failure status', async () => {
  const { inspectWorkerReports, WORKER_REPORT_GRACE_MS } = await import('../src/worker-failures.js');
  const now = 1_000_000;
  const panes = [
    { id: 'w1:p1', workspace: 'w1', cwd: '/work/old-orch', label: 'orch previous', orch: false, agent: 'claude', status: 'working' },
    { id: 'wb:p1', workspace: 'wb', cwd: '/work/old-boss', label: 'boss previous', orch: false, agent: 'claude', status: 'blocked' },
    { id: 'w1:p3', workspace: 'w1', cwd: '/work/worker', label: null, orch: false, name: 'worker-a', agent: 'codex', status: 'blocked' },
  ];
  for (const pane of panes.slice(0, 2)) {
    for (const status of ['working', 'idle', 'done']) assert.equal(shouldReadWorkerScreen(null, { ...pane, status }), false);
  }
  assert.equal(shouldReadWorkerScreen(null, { ...panes[2], status: 'working' }), true);

  const reads = [];
  const transitions = await inspectWorkerTransitions(panes.map((pane) => ({ ...pane, status: 'working' })), {}, {
    'wb:p1': { agent: 'claude', name: null, sessionId: null, label: '429', at: now - 10 },
  }, async (args) => { reads.push(args[2]); return 'HTTP 429; retry later'; }, now);
  assert.deepEqual(reads, ['w1:p3']);
  assert.deepEqual(Object.keys(transitions.failures), ['w1:p3']);
  assert.deepEqual(transitions.notices.map((notice) => notice.key), [`workers:failed:w1:p3:${now}`]);

  const failures = Object.fromEntries(panes.map((pane) => [pane.id, { agent: pane.agent, name: pane.name || null, label: '429' }]));
  assert.deepEqual(applyWorkerFailureStatuses(panes, failures).map((pane) => pane.status), ['working', 'blocked', 'failed']);

  const paneSince = Object.fromEntries(panes.map((pane) => [pane.id, { status: pane.status, since: now - 600_000 }]));
  const blockedSnap = { herdr: { panes: panes.map((pane) => ({ ...pane, status: 'blocked' })) } };
  assert.deepEqual(blockedWorkerAlerts(blockedSnap, paneSince, now).map((alert) => alert.key), ['workers:blocked:w1:p3']);

  const stat = (file) => ({ isFile: true, mtimeMs: file.endsWith('/.worker/report.json') ? 200 : Number.NaN });
  const reports = await inspectWorkerReports(panes, { 'w1:p3': { reports: { 'workers:report:/work/worker/.worker/report.json': { seenAt: 100 - WORKER_REPORT_GRACE_MS } } } }, 100, stat);
  assert.deepEqual(Object.keys(reports.observed), ['w1:p3']);
  assert.deepEqual(reports.notices.map((notice) => notice.text), ['Worker worker-a in pane w1:p3 wrote its report: /work/worker/.worker/report.json']);
});
