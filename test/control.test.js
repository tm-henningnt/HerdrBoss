import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveControl, POLICY_DEFAULTS, providerFor, validatePolicy } from '../src/control.js';
import { validateUsage, usageSummary } from '../src/usage.js';
import { loadModels } from '../src/kit/config.js';

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
