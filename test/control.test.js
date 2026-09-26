import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { deriveControl, POLICY_DEFAULTS, providerFor, selectModel, validatePolicy } from '../src/control.js';
import { validateUsage, usageProvider, usageSummary } from '../src/usage.js';
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

// A child process gives every call fresh module state, so the data directory and the private paths follow the
// temporary HOME.
function loadAccess(home, data, { migrate = false } = {}) {
  const configUrl = new URL('../src/config.js', import.meta.url).href;
  const script = `import { ${migrate ? 'loadConfig, migrateAccessFiles' : 'loadConfig'} } from ${JSON.stringify(configUrl)};
const cfg = loadConfig();
${migrate ? 'migrateAccessFiles(cfg);' : ''}
console.log(JSON.stringify(cfg.access));`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HOME: home, HERDR_BOSS_DIR: data }, encoding: 'utf8',
  }));
}

const legacySessionState = JSON.stringify({ token: 'f'.repeat(64), sessions: { ['e'.repeat(64)]: 1234567890123 } });

test('loadConfig leaves legacy credential files and the stored config alone', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-loadconfig-home-'));
  const data = path.join(home, 'shared-data');
  const privateDir = path.join(home, '.config', 'herdr-boss');
  const legacyToken = path.join(data, 'access-token');
  const legacySessions = path.join(data, 'sessions.json');
  const configFile = path.join(data, 'config.json');
  const storedConfig = `${JSON.stringify({ push: false, access: { tokenFile: legacyToken, sessionDays: 11 } }, null, 2)}\n`;
  fs.mkdirSync(data);
  fs.writeFileSync(legacyToken, `${'a'.repeat(64)}\n`, { mode: 0o644 });
  fs.writeFileSync(legacySessions, legacySessionState, { mode: 0o644 });
  fs.writeFileSync(configFile, storedConfig, { mode: 0o644 });
  for (const file of [legacyToken, legacySessions, configFile]) fs.chmodSync(file, 0o644);
  const access = loadAccess(home, data);
  assert.equal(access.tokenFile, path.join(privateDir, 'access-token'), 'the private default is the effective token path');
  assert.equal(access.sessionDays, 11);
  assert.equal(fs.existsSync(path.join(data, 'projects')), true, 'loadConfig still creates the projects directory');
  assert.equal(fs.existsSync(privateDir), false, 'loadConfig does not create the private access directory');
  assert.equal(fs.readFileSync(legacyToken, 'utf8'), `${'a'.repeat(64)}\n`, 'loadConfig does not move the legacy token');
  assert.equal(fs.readFileSync(legacySessions, 'utf8'), legacySessionState, 'loadConfig does not move the legacy sessions');
  assert.equal(fs.statSync(legacyToken).mode & 0o777, 0o644, 'loadConfig does not chmod the legacy token');
  assert.equal(fs.statSync(legacySessions).mode & 0o777, 0o644, 'loadConfig does not chmod the legacy sessions');
  assert.equal(fs.readFileSync(configFile, 'utf8'), storedConfig, 'loadConfig does not rewrite the stored config');
  fs.rmSync(home, { recursive: true, force: true });
});

test('loadConfig leaves existing private credential files alone', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-loadconfig-home-'));
  const data = path.join(home, 'shared-data');
  const privateDir = path.join(home, '.config', 'herdr-boss');
  const tokenFile = path.join(privateDir, 'access-token');
  const sessionFile = path.join(privateDir, 'sessions.json');
  fs.mkdirSync(data);
  fs.mkdirSync(privateDir, { recursive: true });
  fs.writeFileSync(tokenFile, `${'a'.repeat(64)}\n`, { mode: 0o644 });
  fs.writeFileSync(sessionFile, legacySessionState, { mode: 0o644 });
  fs.chmodSync(tokenFile, 0o644);
  fs.chmodSync(sessionFile, 0o644);
  loadAccess(home, data);
  loadAccess(home, data);
  assert.equal(fs.readFileSync(tokenFile, 'utf8'), `${'a'.repeat(64)}\n`, 'loadConfig does not rewrite the token');
  assert.equal(fs.readFileSync(sessionFile, 'utf8'), legacySessionState, 'loadConfig does not rewrite the sessions');
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o644, 'loadConfig does not chmod the token');
  assert.equal(fs.statSync(sessionFile).mode & 0o777, 0o644, 'loadConfig does not chmod the sessions');
  assert.equal(fs.statSync(privateDir).mode & 0o777, 0o755, 'loadConfig does not chmod the private access directory');
  fs.rmSync(home, { recursive: true, force: true });
});

test('access credentials use private defaults and migrate legacy files once', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-credentials-home-'));
  const data = path.join(home, 'shared-data');
  const privateDir = path.join(home, '.config', 'herdr-boss');
  const legacyToken = path.join(data, 'access-token');
  const legacySessions = path.join(data, 'sessions.json');
  fs.mkdirSync(data);
  fs.writeFileSync(legacyToken, `${'a'.repeat(64)}\n`, { mode: 0o600 });
  fs.writeFileSync(legacySessions, JSON.stringify({ token: 'f'.repeat(64), sessions: { ['e'.repeat(64)]: 1234567890123 } }), { mode: 0o600 });
  const run = () => loadAccess(home, data, { migrate: true });
  const config = run();
  assert.equal(config.tokenFile, path.join(privateDir, 'access-token'));
  assert.equal(fs.readFileSync(config.tokenFile, 'utf8'), `${'a'.repeat(64)}\n`);
  assert.equal(fs.existsSync(path.join(privateDir, 'sessions.json')), true);
  assert.equal(path.join(path.dirname(config.tokenFile), 'sessions.json'), path.join(privateDir, 'sessions.json'));
  assert.equal(fs.existsSync(legacyToken), false);
  assert.equal(fs.existsSync(legacySessions), false);
  assert.equal(fs.statSync(privateDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(config.tokenFile).mode & 0o777, 0o600);
  run();
  assert.equal(fs.readFileSync(config.tokenFile, 'utf8'), `${'a'.repeat(64)}\n`);
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ push: false, access: { tokenFile: legacyToken, sessionDays: 11 } }));
  fs.writeFileSync(legacyToken, `${'b'.repeat(64)}\n`, { mode: 0o600 });
  const migratedConfig = run();
  assert.equal(migratedConfig.tokenFile, config.tokenFile);
  assert.equal(migratedConfig.sessionDays, 11);
  assert.equal(fs.readFileSync(config.tokenFile, 'utf8'), `${'a'.repeat(64)}\n`);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')), {
    push: false, access: { tokenFile: config.tokenFile, sessionDays: 11 },
  });
  const custom = path.join(home, 'custom-token');
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ access: { tokenFile: custom } }));
  assert.equal(run().tokenFile, custom);
  fs.rmSync(home, { recursive: true, force: true });
});

test('machine policy defaults and validates owner and CPU limits', () => {
  assert.equal(POLICY_DEFAULTS.machine.ownerAwayMinutes, 10);
  assert.equal(POLICY_DEFAULTS.machine.presentCpuPercent, 70);
  assert.equal(POLICY_DEFAULTS.machine.awayCpuPercent, 95);
  assert.equal(POLICY_DEFAULTS.machine.alertCooldownSeconds, 21600);
  assert.deepEqual(validatePolicy(policy(), models), []);
  assert.match(validatePolicy(policy({ machine: { ...POLICY_DEFAULTS.machine, presentCpuPercent: 101 } }), models).join(' '), /presentCpuPercent/);
  assert.deepEqual(validatePolicy(policy({ machine: { ...POLICY_DEFAULTS.machine, awayCpuPercent: null, awayLoadFactor: null } }), models), []);
  assert.match(validatePolicy(policy({ machine: { ...POLICY_DEFAULTS.machine, alertCooldownSeconds: -1 } }), models).join(' '), /machine.alertCooldownSeconds/);
});

test('policy defaults override legacy machine and cooldown config values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-policy-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ machine: { loadWarnFactor: 0 }, alertCooldownSeconds: 1 }));
  const controlUrl = new URL('../src/control.js', import.meta.url).href;
  const script = `import { loadPolicy } from ${JSON.stringify(controlUrl)}; console.log(JSON.stringify(loadPolicy().machine));`;
  const machine = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HERDR_BOSS_DIR: dir }, encoding: 'utf8',
  }));
  assert.equal(machine.presentLoadFactor, 3);
  assert.equal(machine.alertCooldownSeconds, 21600);
});

test('machine load guard reports active CPU and load limits', async () => {
  const { machineLimits } = await import('../src/control.js');
  assert.deepEqual(machineLimits({ cpus: 8, load: [1, 4, 5], ownerIdleMinutes: 11, cpuUse: { a: { cpu: 400 } } }, policy()), {
    owner: 'away', cpuPercent: 50, cpuLimit: 95, fiveMinute: 4, loadLimit: 64,
  });
  assert.equal(machineLimits({ cpus: 8, load: [1, 4, 5], ownerIdleMinutes: null, cpuUse: { a: { cpu: 560 } } }, policy()).owner, 'present');
  assert.equal(machineLimits({ cpus: 8, load: [1, 4, 5], ownerIdleMinutes: 0, cpuUse: {} }, policy()).loadLimit, 24);
  const disabled = machineLimits({ cpus: 8, load: [1, 4, 5], ownerIdleMinutes: 11, cpuUse: {}, }, policy({ machine: { ...POLICY_DEFAULTS.machine, awayCpuPercent: null, awayLoadFactor: null } }));
  assert.equal(disabled.cpuLimit, null);
  assert.equal(disabled.loadLimit, null);
  assert.equal(disabled.cpuPercent, 0);
});

test('Owner idle time parses HIDIdleTime nanoseconds and rejects missing or invalid readings', async () => {
  const { parseOwnerIdleMinutes } = await import('../src/collect.js');
  assert.equal(parseOwnerIdleMinutes('"HIDIdleTime" = 600000000000'), 10);
  assert.equal(parseOwnerIdleMinutes('no reading'), null);
  assert.equal(parseOwnerIdleMinutes('"HIDIdleTime" = -1'), null);
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

test('handoff target checks use the configured model route', () => {
  const routed = policy({ modelProviders: { 'gpt-6-luna': 'claude' } });
  const result = deriveControl(snapshot(), routed, models, {}, Date.parse('2026-09-24T17:00:00Z'));
  assert.equal(result.handoffs[0].target.kind, 'pi');
  assert.equal(result.handoffs[0].target.provider, 'opencodego');
});

test('current orchestrator provider falls back to its preferred model route', () => {
  const p = policy({ preferredModels: { codex: 'gpt-6-sol' }, modelProviders: { 'gpt-6-sol': 'claude' } });
  const result = deriveControl(snapshot(), p, models, {}, Date.parse('2026-09-24T17:00:00Z'));
  const handoff = result.handoffs.find((item) => item.fromKind === 'codex');
  assert.equal(handoff.provider, 'claude');
  assert.equal(handoff.target.kind, 'pi');
});

test('provider routing separates free OpenCode from OpenCode Go', () => {
  assert.equal(providerFor('opencode', 'opencode/big-pickle'), null);
  assert.equal(providerFor('pi', 'opencode-go/deepseek-v4.1-flash'), 'opencodego');
  assert.equal(providerFor('codex', 'gpt-6-luna'), 'codex');
});

test('policy validates preferred models and explicit provider routes', () => {
  const p = policy({ preferredModels: { codex: 'gpt-6-sol' }, modelProviders: { 'gpt-6-sol': 'claude' } });
  assert.deepEqual(validatePolicy(p, models), []);
  assert.match(validatePolicy(policy({ preferredModels: { codex: 'claude-sonnet-4-5' } }), models).join(' '), /preferredModels/);
  assert.match(validatePolicy(policy({ modelProviders: { 'unknown-model': 'codex' } }), models).join(' '), /modelProviders/);
  assert.match(validatePolicy(policy({ modelProviders: { 'gpt-6-luna': 'other' } }), models).join(' '), /modelProviders/);
});

test('model provider override applies while legacy policy keeps inferred routing', () => {
  assert.equal(providerFor('codex', 'gpt-6-luna'), 'codex');
  assert.equal(providerFor('codex', 'gpt-6-luna', { modelProviders: { 'gpt-6-luna': 'claude' } }), 'claude');
  assert.equal(providerFor('opencode', 'opencode/big-pickle', { modelProviders: { 'opencode/big-pickle': null } }), null);
});

test('usage attribution prefers an explicit provider over changed policy routes', () => {
  const changedRoute = { modelProviders: { 'gpt-6-luna': 'opencodego' } };
  assert.equal(usageProvider({ kind: 'codex', model: 'gpt-6-luna', provider: 'claude' }, changedRoute), 'claude');
  assert.equal(usageProvider({ kind: 'codex', model: 'gpt-6-luna', provider: null }, changedRoute), 'unmetered-or-unknown');
  assert.equal(usageProvider({ kind: 'codex', model: 'gpt-6-luna' }, { modelProviders: { 'gpt-6-luna': 'claude' } }), 'claude');
  assert.equal(usageProvider({ kind: 'codex', model: 'gpt-6-luna' }, {}), 'codex');
});

test('preferred model selection preserves explicit choices and legacy defaults', () => {
  assert.equal(selectModel('codex', null, models, { preferredModels: { codex: 'gpt-6-sol' } }), 'gpt-6-sol');
  assert.equal(selectModel('codex', 'gpt-6-astra', models, { preferredModels: { codex: 'gpt-6-sol' } }), 'gpt-6-astra');
  assert.equal(selectModel('codex', null, models, {}), models.kinds.codex.defaultModel);
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

test('project status validation accepts work structure and rejects unsafe or malformed fields', async () => {
  const { validateProject } = await import('../src/projects.js');
  assert.deepEqual(validateProject({
    project: 'Demo',
    groups: [{ id: '1.0', title: 'Release 1.0', refs: [{ label: 'docs/Plan.md' }] }],
    tasks: [{ id: '1', title: 'Spec', kind: 'spec', status: 'done' }, { id: '2', title: 'Build', parent: '1', blockedBy: ['1'], group: '1.0', url: 'https://example.com/2' }],
    gates: [{ title: 'Owner review' }], risks: ['Quota'], git: { branch: 'main', commit: 'abc', dirty: false },
  }), []);
  const errors = validateProject({
    project: 'Demo',
    tasks: [{ id: '1', title: 'A', blockedBy: '2' }, { id: '1', title: 'B', url: 'javascript:alert(1)' }],
    links: [{ label: 'x', url: 'javascript:alert(1)' }],
  });
  assert.ok(errors.some((e) => /blockedBy must be an array/.test(e)));
  assert.ok(errors.some((e) => /task IDs must be unique/.test(e)));
  assert.ok(errors.some((e) => /tasks\[1\]\.url must start with http/.test(e)));
  assert.ok(errors.some((e) => /links\[0\]\.url must start with http/.test(e)));
});

test('CPU use counts pane processes and project browsers per workspace', async () => {
  const { cpuUse } = await import('../src/collect.js');
  const procs = new Map([
    [10, { pid: 10, ppid: 1, cpu: 0, cmd: '/bin/zsh' }],
    [11, { pid: 11, ppid: 10, cpu: 90, cmd: 'node (vitest 1)' }],
    [12, { pid: 12, ppid: 10, cpu: 80, cmd: 'node (vitest 2)' }],
    [20, { pid: 20, ppid: 1, cpu: 70, cmd: '/Applications/Google Chrome.app/Contents/Frameworks/Helper --type=renderer --user-data-dir=/p/viz' }],
    [30, { pid: 30, ppid: 1, cpu: 40, cmd: '/usr/bin/other' }],
  ]);
  const use = cpuUse(procs, [{ id: 'w1:p1', workspace: 'w1', shellPid: 10 }], { '/p/viz': 'w2' });
  assert.deepEqual(use.w1, { cpu: 170, top: [{ label: 'vitest', cpu: 170, count: 2 }] });
  assert.equal(use.w2.top[0].label, 'Chrome');
  assert.equal(use.other.cpu, 40);
});

test('a load alert goes to the projects that cause it and the bulletin groups project rules', async () => {
  const { evaluate, renderBulletin } = await import('../src/rules.js');
  const cfg = { quota: { warnPercent: 90, criticalPercent: 98 }, machine: { memFreeWarnPercent: 15, loadWarnFactor: 2 }, browsers: { staleOwnedMinutes: 30 }, workers: { staleIdleMinutes: 120 }, sharedBrowsers: [] };
  const snap = {
    updatedAt: new Date().toISOString(),
    machine: { load: [40, 35, 30], cpus: 10, memFreePercent: 50 },
    herdr: { workspaces: [{ id: 'w1', label: 'Alpha' }, { id: 'w2', label: 'Beta' }], panes: [] },
    cpuUse: { w1: { cpu: 420, top: [{ label: 'vitest', cpu: 400, count: 9 }] }, w2: { cpu: 30, top: [] } },
  };
  const evaluation = evaluate(snap, cfg, {}, Date.now());
  const load = evaluation.alerts.filter((a) => a.key.startsWith('machine:load'));
  assert.deepEqual(load.map((a) => a.scope).sort(), ['user', 'w1']);
  assert.match(load.find((a) => a.scope === 'w1').text, /Your project uses about 420% CPU now .*vitest ×9 400%/);
  const bulletin = renderBulletin(snap, evaluation, cfg);
  assert.match(bulletin, /## Project rules\n\n### Alpha\n\n- The 5-minute load average/);
});

test('bulletin shows Owner state, normalized CPU limit, load backstop, and stop action', async () => {
  const { evaluate, renderBulletin } = await import('../src/rules.js');
  const cfg = { quota: { warnPercent: 90, criticalPercent: 98 }, machine: { memFreeWarnPercent: 15, loadWarnFactor: 2 }, browsers: { staleOwnedMinutes: 30 }, workers: { staleIdleMinutes: 120 }, sharedBrowsers: [], providerKinds: { claude: ['claude'], codex: ['codex'], opencodego: ['pi'] } };
  const p = policy();
  const snap = { ...snapshot(), updatedAt: '2026-09-25T00:00:00Z', machine: { load: [1, 4, 5], cpus: 8, memFreePercent: 50, memTotalGB: 16, swapUsedMB: 0,
    limits: { owner: 'present', cpuPercent: 75, cpuLimit: 70, fiveMinute: 4, loadLimit: 24 } }, cpuUse: {}, browsers: [], managedBrowsers: [], control: { projects: {}, runningWorkers: 0, maxWorkers: 8 }, policy: p };
  const evaluation = evaluate(snap, cfg, {}, Date.parse(snap.updatedAt), p);
  const bulletin = renderBulletin(snap, evaluation, cfg);
  assert.match(bulletin, /Owner: present; machine CPU 75% \/ active limit 70%; 5-minute load 4 \/ active backstop 24/);
  assert.match(bulletin, /stop new workers and full test suites/);
});

test('a remote session survives a restart, and a new token signs every device out', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createAccessControl } = await import('../src/access.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-access-'));
  fs.chmodSync(dir, 0o755);
  const tokenFile = path.join(dir, 'access-token');
  const first = createAccessControl(tokenFile, { privateDirectory: true });
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const req = (cookie) => ({ socket: { remoteAddress: '10.0.0.2' }, headers: { host: '10.0.0.1:4477', cookie } });
  const res = { setHeader() {} };
  const login = first.login(req(), token);
  assert.equal(login.ok, true);
  assert.match(login.cookie, /SameSite=Lax/);
  assert.match(login.cookie, /Max-Age=2592000/);
  const cookie = login.cookie.split(';')[0];
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8'), new RegExp(cookie.split('=')[1]));
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, 'sessions.json')).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8'))).sort(), ['sessions', 'token']);
  fs.chmodSync(tokenFile, 0o644);
  fs.chmodSync(path.join(dir, 'sessions.json'), 0o644);
  createAccessControl(tokenFile);
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, 'sessions.json')).mode & 0o777, 0o600);
  assert.equal(createAccessControl(tokenFile).authorized(req(cookie), res), true);
  fs.writeFileSync(tokenFile, `${'b'.repeat(64)}\n`);
  assert.equal(createAccessControl(tokenFile).authorized(req(cookie), res), false);
  assert.equal(first.login(req(), 'wrong').ok, false);
});

test('a live window that will not last is ahead of pace at any usage level', async () => {
  const { laneStatus, leastOverProvider } = await import('../src/control.js');
  const { describeLane } = await import('../src/kit/workers.js');
  const now = Date.parse('2026-09-25T16:00:00Z');
  const quotas = [
    { provider: 'claude', windows: [
      { label: 'Session', usedPercent: 13, expectedPercent: 15, willLast: true, windowMinutes: 300, resetsAt: '2026-09-25T19:59:00Z' },
      { label: 'Weekly', usedPercent: 42, expectedPercent: 12, willLast: false, windowMinutes: 10080, resetsAt: '2026-10-01T18:59:00Z' },
      { label: 'Fable only', usedPercent: 0, willLast: true, extra: true, resetsAt: '2026-10-01T19:00:00Z' },
    ] },
    { provider: 'codex', windows: [{ label: 'Weekly', usedPercent: 54, expectedPercent: 47, willLast: false, windowMinutes: 10080, resetsAt: '2026-09-29T09:24:00Z' }] },
  ];
  const lanes = laneStatus(quotas, policy(), now);
  assert.equal(lanes.claude.state, 'pace');
  assert.equal(lanes.claude.window, 'Weekly');
  assert.equal(lanes.claude.overPercent, 30);
  assert.match(describeLane('claude', lanes.claude, now), /^claude ahead of pace: 42% used against 12% expected in the Weekly window/);
  // Codex is 7 points over and Claude 30, so the least-over rule still picks Codex.
  assert.equal(leastOverProvider(lanes), 'codex');
  const control = deriveControl({ ...snapshot(), quotas }, policy(), models, {}, now);
  assert.equal(control.pressures.claude.label, 'Weekly');
});

test('the lane names the worst window by pace, not the highest-used window', async () => {
  const { laneStatus } = await import('../src/control.js');
  const { providerGate } = await import('../src/kit/workers.js');
  const now = Date.parse('2026-09-25T16:00:00Z');
  const quotas = [{ provider: 'opencodego', windows: [
    { label: '5-hour', usedPercent: 20, expectedPercent: 5, willLast: false, windowMinutes: 300, resetsAt: '2026-09-25T20:29:00Z' },
    { label: 'Weekly', usedPercent: 76, expectedPercent: 67, willLast: false, windowMinutes: 10080, resetsAt: '2026-09-27T23:59:00Z' },
    { label: 'Monthly', usedPercent: 38, expectedPercent: 6, willLast: false, windowMinutes: 43200, resetsAt: '2026-10-23T16:57:00Z' },
  ] }];
  const lanes = laneStatus(quotas, policy(), now);
  assert.equal(lanes.opencodego.state, 'pace');
  assert.equal(lanes.opencodego.window, 'Monthly');
  assert.equal(lanes.opencodego.overPercent, 32);
  const refused = providerGate('opencodego', { avoidProviders: ['opencodego'], lanes, leastOverProvider: null }, { now }).error;
  assert.match(refused, /^opencodego ahead of pace: 38% used against 6% expected in the Monthly window/);
  // Without expected use, the usage percentage ranks the windows.
  const unexpected = laneStatus([{ provider: 'codex', windows: [
    { label: 'Session', usedPercent: 30, willLast: false, resetsAt: '2026-09-25T20:00:00Z' },
    { label: 'Weekly', usedPercent: 45, willLast: false, resetsAt: '2026-09-29T09:24:00Z' },
  ] }], policy(), now);
  assert.equal(unexpected.codex.window, 'Weekly');
  assert.equal(unexpected.codex.overPercent, null);
});

test('pacing goals default to 100 percent and validate as whole percentages', () => {
  assert.deepEqual(POLICY_DEFAULTS.pacingGoals, {});
  assert.deepEqual(validatePolicy(policy({ pacingGoals: { codex: { primary: 80 }, claude: { secondary: 0 } } }), models), []);
  assert.match(validatePolicy(policy({ pacingGoals: { codex: { weekly: 80 } } }), models).join(' '), /pacingGoals/);
  assert.match(validatePolicy(policy({ pacingGoals: { codex: { primary: 101 } } }), models).join(' '), /pacingGoals/);
  assert.match(validatePolicy(policy({ pacingGoals: { codex: { primary: 80.5 } } }), models).join(' '), /pacingGoals/);
  assert.match(validatePolicy(policy({ pacingGoals: { other: { primary: 80 } } }), models).join(' '), /pacingGoals/);
  assert.match(validatePolicy(policy({ pacingGoals: [] }), models).join(' '), /pacingGoals/);
});

test('a pacing goal makes a willLast window ahead of pace and scales its numbers', async () => {
  const { laneStatus } = await import('../src/control.js');
  const now = Date.parse('2026-09-25T10:00:00Z');
  const quotas = [{ provider: 'codex', windows: [{ key: 'primary', label: 'Weekly', usedPercent: 45, expectedPercent: 50, willLast: true, windowMinutes: 10080, resetsAt: '2026-09-29T09:00:00Z' }] }];
  assert.equal(laneStatus(quotas, policy(), now).codex.state, 'open');
  const lane = laneStatus(quotas, policy({ pacingGoals: { codex: { primary: 80 } } }), now).codex;
  assert.equal(lane.state, 'pace');
  assert.equal(lane.expectedPercent, 40);
  assert.equal(lane.overPercent, 5);
  assert.equal(Date.parse(lane.backOnPaceAt) - now, 5 / 80 * 10080 * 60000);
});

test('least-over ordering uses the goal-adjusted pace score', async () => {
  const { laneStatus, leastOverProvider, deriveControl } = await import('../src/control.js');
  const now = Date.parse('2026-09-25T10:00:00Z');
  const quotas = [
    { provider: 'codex', windows: [{ key: 'primary', label: 'Weekly', usedPercent: 45, expectedPercent: 43, willLast: false, windowMinutes: 10080, resetsAt: '2026-09-29T09:00:00Z' }] },
    { provider: 'claude', windows: [{ key: 'secondary', label: 'Weekly', usedPercent: 63, expectedPercent: 58, willLast: false, windowMinutes: 10080, resetsAt: '2026-10-01T18:00:00Z' }] },
  ];
  assert.equal(leastOverProvider(laneStatus(quotas, policy(), now)), 'codex');
  const goal = policy({ pacingGoals: { codex: { primary: 40 } } });
  assert.equal(leastOverProvider(laneStatus(quotas, goal, now)), 'claude');
  // The worst window of a provider also ranks by the adjusted pace, not the raw pace.
  const windows = [{ provider: 'codex', windows: [
    { key: 'primary', label: 'Weekly', usedPercent: 45, expectedPercent: 43, willLast: false, windowMinutes: 10080, resetsAt: '2026-09-29T09:00:00Z' },
    { key: 'secondary', label: 'Monthly', usedPercent: 60, expectedPercent: 50, willLast: false, windowMinutes: 43200, resetsAt: '2026-10-23T09:00:00Z' },
  ] }];
  assert.equal(deriveControl({ ...snapshot(), quotas: windows }, policy(), models, {}, now).pressures.codex.label, 'Monthly');
  assert.equal(deriveControl({ ...snapshot(), quotas: windows }, policy({ pacingGoals: { codex: { primary: 10 } } }), models, {}, now).pressures.codex.label, 'Weekly');
});

test('a pacing goal stays inert for an ignored provider and after a reset', async () => {
  const { laneStatus, deriveControl } = await import('../src/control.js');
  const now = Date.parse('2026-09-25T10:00:00Z');
  const live = [{ provider: 'codex', windows: [{ key: 'primary', label: 'Weekly', usedPercent: 45, expectedPercent: 30, willLast: true, windowMinutes: 10080, resetsAt: '2026-09-29T09:00:00Z' }] }];
  const ignored = policy({ providerModes: { ...POLICY_DEFAULTS.providerModes, codex: 'ignore' }, pacingGoals: { codex: { primary: 50 } } });
  const ignoredLane = laneStatus(live, ignored, now).codex;
  assert.equal(ignoredLane.state, 'open');
  assert.equal(ignoredLane.ignored, true);
  const expired = [{ provider: 'codex', windows: [{ key: 'primary', label: 'Weekly', usedPercent: 95, expectedPercent: 50, willLast: false, windowMinutes: 10080, resetsAt: '2026-09-25T09:00:00Z' }] }];
  const goal = policy({ pacingGoals: { codex: { primary: 50 } } });
  const lane = laneStatus(expired, goal, now).codex;
  assert.equal(lane.state, 'open');
  assert.deepEqual(lane.resetWindows, ['Weekly']);
  const control = deriveControl({ ...snapshot(), quotas: expired }, goal, models, {}, now);
  assert.equal(control.risks.codex, null);
  assert.equal(control.pressures.codex, null);
});

test('a near-exhaustion window keeps its reserve state under a goal', async () => {
  const { laneStatus } = await import('../src/control.js');
  const now = Date.parse('2026-09-25T10:00:00Z');
  const quotas = [{ provider: 'codex', windows: [{ key: 'primary', label: 'Weekly', usedPercent: 90, expectedPercent: 10, willLast: false, windowMinutes: 10080, resetsAt: '2026-09-29T09:00:00Z' }] }];
  const lane = laneStatus(quotas, policy({ pacingGoals: { codex: { primary: 50 } } }), now).codex;
  assert.equal(lane.state, 'reserve');
});

test('the unmetered lane lists permitted models after global and project exclusions', async () => {
  const { unmeteredLane } = await import('../src/control.js');
  const projects = { a: { excludedKinds: [], excludedModels: [] }, b: { excludedKinds: ['opencode'], excludedModels: [] } };
  const lane = unmeteredLane(models, policy({ excludedModels: ['opencode/big-pickle'] }), projects);
  assert.equal(lane.state, 'open');
  assert.equal(lane.unmetered, true);
  assert.ok(lane.byProject.a.opencode.includes('opencode/space-bunny-free'));
  assert.ok(!lane.byProject.a.opencode.includes('opencode/big-pickle'));
  assert.equal(lane.byProject.a.pi, undefined);
  assert.equal(lane.byProject.b, undefined);
  const projectModel = unmeteredLane(models, policy(), { a: { excludedKinds: [], excludedModels: ['opencode/space-bunny-free'] } });
  assert.ok(!projectModel.byProject.a.opencode.includes('opencode/space-bunny-free'));
  const routed = unmeteredLane(models, policy({ modelProviders: { 'opencode/space-bunny-free': 'codex' } }), projects);
  assert.ok(!routed.byProject.a.opencode.includes('opencode/space-bunny-free'));
  const kindsOff = unmeteredLane(models, policy({ allowedKinds: ['pi'] }), projects);
  assert.equal(kindsOff.byProject.a, undefined);
});

test('least-over selection skips the unmetered lane', async () => {
  const { laneStatus, leastOverProvider, unmeteredLane } = await import('../src/control.js');
  const now = Date.parse('2026-09-25T10:00:00Z');
  const quotas = [
    { provider: 'codex', windows: [{ key: 'primary', label: 'Weekly', usedPercent: 45, expectedPercent: 43, willLast: false, windowMinutes: 10080, resetsAt: '2026-09-29T09:00:00Z' }] },
    { provider: 'claude', windows: [{ key: 'secondary', label: 'Weekly', usedPercent: 63, expectedPercent: 58, willLast: false, windowMinutes: 10080, resetsAt: '2026-10-01T18:00:00Z' }] },
  ];
  const lanes = laneStatus(quotas, policy(), now);
  lanes.unmetered = unmeteredLane(models, policy(), { a: { excludedKinds: [], excludedModels: [] } });
  assert.equal(leastOverProvider(lanes), 'codex');
});

test('the bulletin shows the unmetered lane in Provider lanes', async () => {
  const { renderBulletin } = await import('../src/rules.js');
  const cfg = { quota: { warnPercent: 90, criticalPercent: 98 }, machine: { memFreeWarnPercent: 15, loadWarnFactor: 2 }, browsers: { staleOwnedMinutes: 30 }, workers: { staleIdleMinutes: 120 }, sharedBrowsers: [] };
  const snap = { ...snapshot(), updatedAt: '2026-09-25T00:00:00Z', lanes: { codex: { state: 'open' }, unmetered: { state: 'open', unmetered: true, byProject: { a: { opencode: ['opencode/space-bunny-free'] } } } }, policy: policy() };
  const bulletin = renderBulletin(snap, { alerts: [], advice: [] }, cfg);
  assert.match(bulletin, /Unmetered: open/);
  assert.match(bulletin, /opencode\/space-bunny-free/);
});
