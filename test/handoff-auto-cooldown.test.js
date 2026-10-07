// K28: the automatic successor choice never picks a weaker tier than the source, and it skips a kind
// whose automatic record expired, was stuck, or never got readyAt within autoCooldownHours.
import './helpers/test-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModels } from '../src/kit/config.js';
import { POLICY_DEFAULTS, autoCooldownSkips, pickSuccessorDetailed, pickSuccessor, validatePolicy } from '../src/control.js';

const PROJECT = { excludedKinds: [], excludedModels: [] };
const NOW = Date.parse('2026-10-07T12:00:00.000Z');
const HOUR = 3600000;
const EXPIRY_MS = 30 * 60 * 1000;
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

const LADDER = [
  { kind: 'pi', model: 'opencode-go/deepseek-v4.1-flash', effort: null },
  { kind: 'codex', model: 'gpt-6-luna', effort: 'xhigh' },
  { kind: 'claude', model: 'claude-opus-5-5', effort: null },
];
const POLICY = { ...POLICY_DEFAULTS, orchestratorLadder: LADDER, harnessRoutes: { pi: { 'opencode-go/deepseek-v4.1-flash': null } } };
const control = (extra = {}) => ({
  globalAllowed: { pi: ['opencode-go/deepseek-v4.1-flash'], codex: ['gpt-6-luna'], claude: ['claude-opus-5-5'] },
  risks: {}, exhausted: {}, lanes: {}, weeklyUse: {}, sourceModel: 'opencode/space-bunny-free', ...extra,
});

test('the policy default is 6 hours and the range is 1 to 72', () => {
  assert.deepEqual(POLICY_DEFAULTS.handoff, { autoCooldownHours: 6 });
  const check = (hours) => validatePolicy({ ...structuredClone(POLICY_DEFAULTS), handoff: { autoCooldownHours: hours } }, loadModels());
  assert.deepEqual(check(1), []);
  assert.deepEqual(check(72), []);
  for (const bad of [0, 73, 1.5, '6']) {
    assert.ok(check(bad).some((e) => /handoff\.autoCooldownHours/.test(e)), `${bad} is refused`);
  }
});

test('the automatic choice never picks a weaker tier than the source model', () => {
  // The source is Codex gpt-6.1-sol (tier 5). Pi deepseek (tier 2) and Codex luna (tier 3) are weaker.
  const result = pickSuccessorDetailed(PROJECT, 'codex', 'codex', POLICY, control({ sourceModel: 'gpt-6.1-sol' }), NOW);
  assert.equal(result.target.kind, 'claude');
  assert.equal(result.target.model, 'claude-opus-5-5');
  const names = result.skipped.map((s) => `${s.kind} ${s.model}`);
  assert.ok(names.includes('pi opencode-go/deepseek-v4.1-flash'));
  assert.match(result.skipped.find((s) => s.kind === 'pi').reason, /weaker.*gpt-6\.1-sol/);
});

test('an equal tier is allowed and an unknown tier is never equal or stronger', () => {
  const equal = pickSuccessor(PROJECT, 'claude', 'claude', POLICY, control({ sourceModel: 'gpt-6-luna' }), NOW);
  assert.equal(equal.kind, 'codex', 'luna (tier 3) is equal to a luna source');
  for (const sourceModel of ['some-local-model', undefined, null]) {
    const result = pickSuccessorDetailed(PROJECT, 'codex', 'codex', POLICY, control({ sourceModel }), NOW);
    assert.equal(result.target, null, `a source of ${sourceModel} gives no target`);
    assert.ok(result.skipped.length > 0 && result.skipped.every((s) => /does not rank the source model/.test(s.reason)));
  }
  const unrankedTarget = { ...POLICY, orchestratorLadder: [{ kind: 'pi', model: 'fixturezen/free-a', effort: null }] };
  const refused = pickSuccessorDetailed(PROJECT, 'claude', 'claude', unrankedTarget, control({
    sourceModel: 'opencode/space-bunny-free', globalAllowed: { pi: ['fixturezen/free-a'] },
  }), NOW);
  assert.equal(refused.target, null, 'an unranked target is refused');
});

test('no usable equal or stronger choice gives no target and the skip reasons', () => {
  const policy = { ...POLICY, orchestratorLadder: LADDER.slice(0, 2) };
  const result = pickSuccessorDetailed(PROJECT, 'claude', 'claude', policy, control({ sourceModel: 'claude-opus-5-5' }), NOW);
  assert.equal(result.target, null);
  assert.equal(result.skipped.length, 2);
  assert.ok(result.skipped.every((s) => /weaker/.test(s.reason)));
});

test('autoCooldownSkips counts expired, cancelled, unready and stuck automatic records', () => {
  const rec = (over) => ({ automatic: true, toKind: 'pi', model: 'opencode-go/deepseek-v4.1-flash', ...over });
  const records = [
    rec({ id: 'expired', status: 'expired', expiredAt: iso(-2 * HOUR), expiredReason: 'successor not ready after 30 minutes' }),
    rec({ id: 'cancelled', toKind: 'codex', model: 'gpt-6-luna', status: 'expired', expiredAt: iso(-1 * HOUR), expiredReason: 'cancelled' }),
    rec({ id: 'unready', toKind: 'claude', model: 'claude-opus-5-5', status: 'prepared', preparedAt: iso(-EXPIRY_MS - 1000) }),
    rec({ id: 'stuck', toKind: 'opencode', model: 'opencode/big-pickle', status: 'preparing', preparedAt: iso(-EXPIRY_MS - 1000) }),
    // Records that do not count:
    rec({ id: 'ready-unused', toKind: 'opencode', model: 'opencode/space-bunny-free', status: 'expired', readyAt: iso(-3 * HOUR), expiredAt: iso(-1 * HOUR), expiredReason: 'codex is no longer near its limit' }),
    rec({ id: 'ready-cancelled', toKind: 'opencode', model: 'opencode/space-bunny-free', status: 'expired', readyAt: iso(-3 * HOUR), expiredAt: iso(-1 * HOUR), expiredReason: 'cancelled' }),
    rec({ id: 'superseded', toKind: 'opencode', model: 'opencode/space-bunny-free', status: 'expired', expiredAt: iso(-1 * HOUR), expiredReason: 'Successor handoff-alpha-x1 was activated for the same orchestrator.' }),
    rec({ id: 'old', toKind: 'opencode', model: 'opencode/space-bunny-free', status: 'expired', expiredAt: iso(-7 * HOUR), expiredReason: 'x' }),
    rec({ id: 'fresh-unready', toKind: 'opencode', model: 'opencode/ling-3.1-flash-free', status: 'prepared', preparedAt: iso(-60000) }),
    rec({ id: 'ready', toKind: 'opencode', model: 'opencode/fledge-alpha-free', status: 'prepared', preparedAt: iso(-3 * HOUR), readyAt: iso(-3 * HOUR + 1000) }),
    rec({ id: 'preparing-prompted', toKind: 'opencode', model: 'opencode/nemotron-3-ultra-free', status: 'preparing', preparedAt: iso(-3 * HOUR), promptAt: iso(-3 * HOUR) }),
    rec({ id: 'manual', automatic: false, toKind: 'opencode', model: 'opencode/mimo-v2.6-flash-free', status: 'expired', expiredAt: iso(-1 * HOUR), expiredReason: 'x' }),
    rec({ id: 'active', toKind: 'opencode', model: 'opencode/muse-spark-1.2-contributor-free', status: 'active', preparedAt: iso(-1 * HOUR), readyAt: iso(-1 * HOUR) }),
  ];
  const skips = autoCooldownSkips(records, { now: NOW, hours: 6, expiryMs: EXPIRY_MS });
  assert.deepEqual(skips.map((s) => `${s.kind} ${s.model}`).sort(), [
    'claude claude-opus-5-5', 'codex gpt-6-luna', 'opencode opencode/big-pickle', 'pi opencode-go/deepseek-v4.1-flash',
  ]);
  assert.match(skips.find((s) => s.kind === 'pi').reason, /expired.*ago/);
  assert.match(skips.find((s) => s.kind === 'codex').reason, /cancelled/);
  assert.match(skips.find((s) => s.kind === 'claude').reason, /never became ready/);
  assert.match(skips.find((s) => s.kind === 'opencode').reason, /stuck/);
  const narrow = autoCooldownSkips(records, { now: NOW, hours: 1, expiryMs: EXPIRY_MS });
  assert.ok(!narrow.some((s) => s.kind === 'pi'), 'a 2-hour-old expiry is outside a 1-hour cooldown');
});

test('the automatic choice skips a kind in cooldown and names it in the reason', () => {
  const cooldownSkips = [{ kind: 'pi', model: 'opencode-go/deepseek-v4.1-flash', reason: 'its automatic successor expired 2 hours ago' }];
  const result = pickSuccessorDetailed(PROJECT, 'claude', 'claude', POLICY, control({ cooldownSkips }), NOW);
  assert.equal(result.target.kind, 'codex');
  assert.match(result.target.reason, /skipped pi opencode-go\/deepseek-v4\.1-flash: its automatic successor expired 2 hours ago/);
  assert.deepEqual(result.skipped.map((s) => s.kind), ['pi']);
});

test('a candidate with nothing skipped has no skip text in the reason', () => {
  const result = pickSuccessorDetailed(PROJECT, 'claude', 'claude', POLICY, control(), NOW);
  assert.equal(result.target.reason, undefined);
  assert.deepEqual(result.skipped, []);
});

test('the cooldown setting is explained in Settings and has a dashboard control', async () => {
  const { SETTING_HELP } = await import('../public/setting-help.js');
  const fs = await import('node:fs');
  const help = SETTING_HELP['handoff.autoCooldownHours'];
  assert.ok(help, 'the setting has an explanation');
  assert.equal(help.default, '6');
  assert.equal(help.range, '1 to 72');
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /data-policy-handoff="autoCooldownHours"/);
  assert.match(app, /Successor cooldown hours/);
});
