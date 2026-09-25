import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveControl, POLICY_DEFAULTS, providerFor, validatePolicy } from '../src/control.js';
import { validateUsage, usageSummary } from '../src/usage.js';
import { loadModels } from '../src/kit/config.js';
import { broadcastTargets } from '../src/rules.js';

const models = loadModels();
const policy = (patch = {}) => ({ ...structuredClone(POLICY_DEFAULTS), ...patch });
const snapshot = () => ({
  projects: [{ slug: 'a', workspace: 'w1' }, { slug: 'b', workspace: 'w2' }],
  herdr: {
    workspaces: [{ id: 'w1', label: 'A' }, { id: 'w2', label: 'B' }],
    panes: [
      { id: 'w1:p1', workspace: 'w1', orch: true, agent: 'claude', status: 'idle', sessionId: 's1' },
      { id: 'w2:p1', workspace: 'w2', orch: true, agent: 'codex', status: 'working', sessionId: 's2' },
      { id: 'w2:p2', workspace: 'w2', orch: false, agent: 'pi', status: 'working' },
    ],
  },
  quotas: [{ provider: 'claude', windows: [{ key: 'secondary', label: 'Weekly', usedPercent: 88, willLast: false, etaSeconds: 3000, resetsAt: '2026-09-25T00:00:00Z' }] }],
});

test('policy only permits project exclusions from global availability', () => {
  const p = policy({ projects: { a: { share: 100, mode: 'auto', excludedKinds: ['codex'], excludedModels: [] } } });
  assert.deepEqual(validatePolicy(p, models), []);
  p.allowedKinds = ['claude'];
  assert.match(validatePolicy(p, models).join(' '), /globally available kinds/);
});

test('idle borrowing reallocates slots and quota risk offers a different harness', () => {
  const p = policy({ maxWorkers: 6, idleMinutes: 10, projects: {
    a: { share: 40, mode: 'auto', excludedKinds: [], excludedModels: [] },
    b: { share: 60, mode: 'active', excludedKinds: [], excludedModels: [] },
  } });
  const now = Date.parse('2026-09-24T17:00:00Z');
  const result = deriveControl(snapshot(), p, models, { 'w1:p1': { status: 'idle', since: now - 11 * 60000 } }, now);
  assert.equal(result.projects.a.idle, true);
  assert.equal(result.projects.a.slots, 0);
  assert.equal(result.projects.b.slots, 6);
  assert.equal(result.runningWorkers, 1);
  assert.equal(result.handoffs[0].target.kind, 'codex');
  assert.equal(result.handoffs[0].sessionId, 's1');
});

test('ignore quota disables handoff while preserving observed usage', () => {
  const p = policy({ providerModes: { ...POLICY_DEFAULTS.providerModes, claude: 'ignore' } });
  const result = deriveControl(snapshot(), p, models);
  assert.deepEqual(result.handoffs, []);
  assert.equal(result.risks.claude, null);
});

test('provider routing separates free OpenCode from OpenCode Go', () => {
  assert.equal(providerFor('opencode', 'opencode/big-pickle'), null);
  assert.equal(providerFor('pi', 'opencode-go/deepseek-v4.1-flash'), 'opencodego');
  assert.equal(providerFor('codex', 'gpt-6-luna'), 'codex');
});

test('usage summary distinguishes recorded runs from measured tokens', () => {
  const base = { project: 'a', kind: 'codex', model: 'gpt-6-luna', provider: 'codex', startedAt: '2026-09-24T10:00:00Z', endedAt: '2026-09-24T10:10:00Z', outcome: 'done' };
  assert.deepEqual(validateUsage(base), []);
  const rows = usageSummary([{ ...base, inputTokens: null }, { ...base, inputTokens: 100, outputTokens: 20 }]);
  assert.equal(rows.byProject.a.runs, 2);
  assert.equal(rows.byProject.a.measuredRuns, 1);
  assert.equal(rows.byProject.a.inputTokens, 100);
});

test('broadcast notices skip orchestrators in workspaces without active agents', () => {
  const orchs = [{ id: 'w1:p1', workspace: 'w1' }, { id: 'w2:p1', workspace: 'w2' }, { id: 'w3:p1', workspace: 'w3' }];
  const panes = [
    { id: 'w1:p1', workspace: 'w1', agent: 'claude', orch: true, status: 'working' },
    { id: 'w1:p2', workspace: 'w1', agent: 'pi', orch: false, status: 'idle' },
    { id: 'w2:p2', workspace: 'w2', agent: 'codex', orch: false, status: 'working' },
    { id: 'w3:p2', workspace: 'w3', agent: 'claude', orch: false, status: 'blocked' },
    { id: 'w3:p3', workspace: 'w3', agent: null, orch: false, status: null },
  ];
  assert.deepEqual(broadcastTargets(orchs, panes).map((o) => o.id), ['w2:p1', 'w3:p1']);
});

test('the idle-worker notice skips a prepared handover successor', async () => {
  const { evaluate } = await import('../src/rules.js');
  const cfg = { quota: { warnPercent: 90, criticalPercent: 98 }, machine: { memFreeWarnPercent: 15, loadWarnFactor: 2 }, browsers: { staleOwnedMinutes: 30 }, workers: { staleIdleMinutes: 120 }, sharedBrowsers: [] };
  const now = Date.now();
  const since = now - 3 * 3600000;
  const snap = {
    herdr: { panes: [
      { id: 'w1:p6', workspace: 'w1', agent: 'codex', orch: false, status: 'done' },
      { id: 'w1:p7', workspace: 'w1', agent: 'pi', orch: false, status: 'idle' },
    ] },
    standbyPanes: ['w1:p6'],
  };
  const { alerts } = evaluate(snap, cfg, { 'w1:p6': { since }, 'w1:p7': { since } }, now);
  const stale = alerts.find((a) => a.key.startsWith('workers:stale:'));
  assert.ok(stale);
  assert.match(stale.text, /w1:p7/);
  assert.doesNotMatch(stale.text, /w1:p6/);
});

test('lane status marks pace and reserve, skips reset windows, and names the least-over provider', async () => {
  const { laneStatus, leastOverProvider } = await import('../src/control.js');
  const now = Date.parse('2026-09-25T10:00:00Z');
  const quotas = [
    { provider: 'codex', windows: [{ label: 'Weekly', usedPercent: 53, expectedPercent: 43, willLast: false, windowMinutes: 10080, resetsAt: '2026-09-29T09:00:00Z' }] },
    { provider: 'opencodego', windows: [{ label: 'Weekly', usedPercent: 69, expectedPercent: 63, willLast: false, windowMinutes: 10080, resetsAt: '2026-09-27T23:00:00Z' }] },
    { provider: 'claude', windows: [{ label: 'Session', usedPercent: 93, expectedPercent: 40, willLast: false, windowMinutes: 300, resetsAt: '2026-09-25T09:59:00Z' }] },
  ];
  const lanes = laneStatus(quotas, policy(), now);
  assert.equal(lanes.codex.state, 'pace');
  assert.equal(lanes.codex.overPercent, 10);
  // 10% over a 7-day window is 16.8 hours of catch-up when unused.
  assert.equal(Date.parse(lanes.codex.backOnPaceAt) - now, 0.1 * 10080 * 60000);
  assert.equal(lanes.claude.state, 'open');
  assert.deepEqual(lanes.claude.resetWindows, ['Session']);
  assert.equal(leastOverProvider(lanes), null);
  lanes.claude = { state: 'reserve', overPercent: 50 };
  assert.equal(leastOverProvider(lanes), 'opencodego');
});

test('worker start gate lets the least-over provider start and refuses the others with numbers', async () => {
  const { providerGate } = await import('../src/kit/workers.js');
  const now = Date.parse('2026-09-25T10:00:00Z');
  const rules = {
    avoidProviders: ['codex', 'opencodego', 'claude'],
    leastOverProvider: 'opencodego',
    lanes: {
      codex: { state: 'pace', window: 'Weekly', usedPercent: 53, expectedPercent: 43, overPercent: 10, backOnPaceAt: '2026-09-26T02:48:00Z' },
      opencodego: { state: 'pace', window: 'Weekly', usedPercent: 69, expectedPercent: 63, overPercent: 6, backOnPaceAt: '2026-09-25T20:00:00Z' },
      claude: { state: 'reserve', window: 'Session', usedPercent: 90, expectedPercent: 60, overPercent: 30, backOnPaceAt: '2026-09-25T15:00:00Z' },
    },
  };
  assert.match(providerGate('opencodego', rules, { now }).warning, /every metered provider is over pace.*least over/);
  const refused = providerGate('codex', rules, { now }).error;
  assert.match(refused, /codex ahead of pace: 53% used against 43% expected in the Weekly window; back on pace in about 17 h if unused/);
  assert.match(refused, /opencodego is the least over/);
  assert.match(providerGate('claude', rules, { now }).error, /claude near exhaustion/);
  assert.match(providerGate('claude', rules, { now, force: true }).warning, /--force overrides the quota guard/);
  assert.deepEqual(providerGate('pi', { avoidProviders: [] }, { now }), {});
});
