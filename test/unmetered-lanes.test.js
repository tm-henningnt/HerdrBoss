import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { loadModels, loadProjectConfig } from '../src/kit/config.js';
import { startWorker } from './helpers/start-worker.js';
import { POLICY_DEFAULTS, unavailablePiModels, unmeteredLane, unmeteredSummary } from '../src/control.js';
import { parsePiModels } from '../src/collect.js';
import { renderBulletin } from '../src/rules.js';

const models = loadModels();
// A fixture Pi model of a provider that Pi has no credential for. The kit allow-list has no such model.
const FIXTURE_PI_MODEL = 'fixturezen/free-a';
const fixtureModels = structuredClone(models);
fixtureModels.kinds.pi.allowedModels.push(FIXTURE_PI_MODEL);
const policy = (patch = {}) => ({ ...structuredClone(POLICY_DEFAULTS), ...patch });
const projects = { a: { excludedKinds: [], excludedModels: [] } };
const TABLE = [
  'provider     model                         context  max-out  thinking  images',
  'opencode-go  deepseek-v4.1-flash           128K     8K       no        no',
  'opencode-go  muse-spark-1.3-contributor    128K     8K       yes       no',
  'oc-sdk-go    some-model                    64K      4K       no        no',
].join('\n');

test('parsePiModels reads provider/model rows after the header row', () => {
  assert.deepEqual(parsePiModels(TABLE), ['opencode-go/deepseek-v4.1-flash', 'opencode-go/muse-spark-1.3-contributor', 'oc-sdk-go/some-model']);
  assert.deepEqual(parsePiModels(`Loading...\n${TABLE}\n\n`), ['opencode-go/deepseek-v4.1-flash', 'opencode-go/muse-spark-1.3-contributor', 'oc-sdk-go/some-model']);
  assert.deepEqual(parsePiModels('provider  model  context  max-out  thinking  images\n'), [], 'a header without rows lists no models');
  assert.equal(parsePiModels('opencode-go  deepseek-v4.1-flash  128K'), null, 'output without a header is not a result');
  assert.equal(parsePiModels(''), null);
  assert.equal(parsePiModels(null), null);
});

function runCollector(temp, script) {
  const bin = path.join(temp, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'pi'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const url = new URL('../src/collect.js', import.meta.url).href;
  const code = `import { collectPiModels } from ${JSON.stringify(url)}; console.log(JSON.stringify(await collectPiModels({ now: 1234 })));`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, HOME: temp, HERDR_BOSS_DIR: path.join(temp, 'data') }, encoding: 'utf8',
  }));
}

test('collectPiModels runs pi --list-models and returns null on failure or a missing header', (t) => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-pi-models-')));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const table = TABLE.replace(/'/g, '');
  const ok = runCollector(temp, `[ "$1" = "--list-models" ] || exit 9\ncat <<'EOF'\n${table}\nEOF`);
  assert.deepEqual(ok, { at: 1234, models: ['opencode-go/deepseek-v4.1-flash', 'opencode-go/muse-spark-1.3-contributor', 'oc-sdk-go/some-model'] });
  assert.equal(runCollector(temp, 'echo "No API key" >&2; exit 1'), null, 'a failed command gives no result');
  assert.equal(runCollector(temp, 'echo "opencode-go  deepseek-v4.1-flash"'), null, 'output without a header gives no result');
});

test('the Pi allow-list holds no free opencode/ model', () => {
  assert.deepEqual(models.kinds.pi.allowedModels.filter((model) => model.startsWith('opencode/')), []);
  assert.ok(models.kinds.pi.allowedModels.every((model) => model.startsWith('opencode-go/')));
  assert.ok(models.kinds.opencode.allowedModels.includes('opencode/big-pickle'), 'the opencode harness keeps its free models');
});

test('the failing Muse Spark 1.3 OpenCode model is not allowed or offered in the unmetered line', () => {
  const removed = 'opencode/muse-spark-1.3-contributor-free';
  assert.ok(!models.kinds.opencode.allowedModels.includes(removed), 'the failed model is not in the OpenCode allow-list');
  const lane = unmeteredLane(models, policy(), projects, {}, { now: Date.parse('2026-09-27T12:00:00Z') });
  assert.doesNotMatch(unmeteredSummary(lane), /muse-spark-1\.3-contributor-free/, 'the failed model is not offered in Use now');
});

test('a Pi model that the last good result does not list is left out of the lane and reported', () => {
  const piModels = { at: 1, models: parsePiModels(TABLE) };
  const unavailable = unavailablePiModels(fixtureModels.kinds.pi.allowedModels, piModels);
  assert.ok(unavailable.some((item) => item.model === FIXTURE_PI_MODEL && item.provider === 'fixturezen' && item.reason === 'no-credential'));
  assert.ok(!unavailable.some((item) => item.model === 'opencode-go/deepseek-v4.1-flash'));
  assert.ok(unavailable.some((item) => item.model === 'opencode-go/space-bunny-free' && item.reason === 'not-listed'), 'a missing model of a listed provider is not listed');
  const lane = unmeteredLane(fixtureModels, policy(), projects, {}, { unavailablePiModels: unavailable });
  assert.ok(!(lane.byProject.a.pi || []).includes(FIXTURE_PI_MODEL), 'the fixture model does not stay open for pi');
  assert.ok(lane.byProject.a.opencode.includes('opencode/big-pickle'), 'the check applies only to the pi kind');
  const reported = lane.unavailable.find((item) => item.model === FIXTURE_PI_MODEL);
  assert.deepEqual(reported, { kind: 'pi', model: FIXTURE_PI_MODEL, provider: 'fixturezen', reason: 'no-credential', projects: ['a'] });
  assert.equal(lane.state, 'open');
  assert.doesNotMatch(unmeteredSummary(lane), /pi:/, 'the summary does not offer a closed Pi model');
});

test('an unknown Pi result hides no Pi model', () => {
  assert.deepEqual(unavailablePiModels(models.kinds.pi.allowedModels, null), []);
  assert.deepEqual(unavailablePiModels(models.kinds.pi.allowedModels, undefined), []);
  const lane = unmeteredLane(fixtureModels, policy(), projects, {}, { unavailablePiModels: [] });
  assert.ok(lane.byProject.a.pi.includes(FIXTURE_PI_MODEL));
  assert.deepEqual(lane.unavailable, []);
});

function bulletinFor(lane) {
  return renderBulletin({ updatedAt: new Date().toISOString(), lanes: { unmetered: lane } }, { alerts: [], advice: [] }, { dashboardUrl: 'http://127.0.0.1:4477/' });
}

test('the bulletin lists only models that can start and reports unavailable Pi models', () => {
  const now = Date.now();
  const unavailable = unavailablePiModels(fixtureModels.kinds.pi.allowedModels, { at: 1, models: parsePiModels(TABLE) });
  const lane = unmeteredLane(fixtureModels, policy(), projects, {}, {
    unavailablePiModels: unavailable,
    now,
  });
  const text = bulletinFor(lane);
  const open = text.split('\n').find((line) => line.startsWith('- Unmetered: '));
  assert.ok(open, text);
  assert.doesNotMatch(open, /free-a/, 'the open line lists no closed model');
  assert.match(open, /opencode:/, 'available OpenCode models stay in the open line');
  assert.ok(text.split('\n').includes('- Unmetered pi fixturezen/ models: unavailable. Pi has no credential for the fixturezen provider.'), text);
  assert.doesNotMatch(text, /Owner's decision/);
  assert.doesNotMatch(text, /Unmetered opencode: exhausted/);
});

function startFixture(rules, kitModels = models) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-unmetered-start-')));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test User');
  git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(root, 'README.md'), 'seed\n');
  git('add', 'README.md');
  git('commit', '-m', 'seed');
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ slug: 'herdrboss' }));
  const config = loadProjectConfig({ cwd: root });
  const rulesFile = path.join(root, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({ updatedAt: new Date().toISOString(), avoidKinds: [], ...rules }));
  const herdr = (args) => {
    if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } };
    if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
    if (args[0] === 'tab' && args[1] === 'list') return { tabs: [] };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [] };
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const env = { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch' };
  const start = (name, options) => startWorker(name, { task: 'x', allow: ['src/'], dryRun: true, ...options }, {
    config, models: kitModels, herdr, env, rulesFile, output: () => {},
  });
  return { root, start };
}

test('worker start refuses a Pi model that pi --list-models does not list, also with --force', (t) => {
  const f = startFixture({ piModels: { at: Date.now(), models: parsePiModels(TABLE) } }, fixtureModels);
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const refusal = (error) => /^pi cannot run fixturezen\/free-a: the last pi --list-models result does not list it\. Pi has no credential for the fixturezen provider\. --force cannot bypass this refusal\.$/.test(error.message);
  assert.throws(() => f.start('pione', { kind: 'pi', model: FIXTURE_PI_MODEL }), refusal);
  assert.throws(() => f.start('pitwo', { kind: 'pi', model: FIXTURE_PI_MODEL, force: true, reason: 'Verify that an authorized override cannot bypass the Pi listing' }), refusal);
  assert.throws(() => f.start('pinot', { kind: 'pi', model: 'opencode-go/space-bunny-free' }), /Pi does not list this model\. --force cannot bypass/);
  assert.doesNotThrow(() => f.start('pithree', { kind: 'pi', model: 'opencode-go/deepseek-v4.1-flash' }));
  assert.throws(() => f.start('pizen', { kind: 'pi', model: 'opencode/big-pickle' }), /not allowed for pi/, 'Pi refuses a free opencode/ model');
  const unknown = startFixture({}, fixtureModels);
  t.after(() => fs.rmSync(unknown.root, { recursive: true, force: true }));
  assert.doesNotThrow(() => unknown.start('pifour', { kind: 'pi', model: FIXTURE_PI_MODEL }), 'an unknown Pi result refuses nothing');
});

test('worker start ignores a legacy free-lane exhaustion rule', (t) => {
  const retryAt = Date.now() + 3600000;
  const lane = { state: 'open', unmetered: true, byProject: {}, exhausted: [], unavailable: [], exhaustedLanes: [{ kind: 'opencode', retryAt, retryKnown: false, reason: 'free usage exceeded', projects: ['herdrboss'] }] };
  const f = startFixture({ lanes: { unmetered: lane } });
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  assert.doesNotThrow(() => f.start('ocone', { kind: 'opencode', model: 'opencode/space-bunny-free' }));
});

test('Engine marks only the failed free model unavailable for 1 hour and records Pi models', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-engine-free-lane-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const engineUrl = new URL('../src/engine.js', import.meta.url).href;
  const configUrl = new URL('../src/config.js', import.meta.url).href;
  const script = `
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Engine } from ${JSON.stringify(engineUrl)};
import { loadConfig } from ${JSON.stringify(configUrl)};
const data = process.env.HERDR_BOSS_DIR;
const checkout = path.join(data, 'checkout');
const worker = path.join(data, 'worker');
fs.mkdirSync(checkout, { recursive: true });
execFileSync('git', ['init', '-b', 'main', checkout], { stdio: 'ignore' });
fs.writeFileSync(path.join(checkout, '.herdr-boss.json'), JSON.stringify({ slug: 'sample', runsDir: '.orchestration/runs' }));
fs.writeFileSync(path.join(checkout, 'tracked.txt'), 'tracked');
execFileSync('git', ['-C', checkout, 'add', '.herdr-boss.json', 'tracked.txt'], { stdio: 'ignore' });
execFileSync('git', ['-C', checkout, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'], { stdio: 'ignore' });
execFileSync('git', ['-C', checkout, 'worktree', 'add', '-b', 'worker-a', worker], { stdio: 'ignore' });
fs.mkdirSync(path.join(checkout, '.orchestration/runs'), { recursive: true });
fs.writeFileSync(path.join(checkout, '.orchestration/runs/worker-a.json'), JSON.stringify({
  name: 'worker-a', kind: 'opencode', model: 'opencode/big-pickle', worktree: worker, pane: 'w1:p2', startedAt: '2026-09-27T09:00:00.000Z',
}));
fs.mkdirSync(path.join(data, 'projects'), { recursive: true });
fs.writeFileSync(path.join(data, 'projects/sample.json'), JSON.stringify({ project: 'Sample', workspace: 'w1' }));
fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify({ extraModels: { pi: [${JSON.stringify(FIXTURE_PI_MODEL)}] } }));
const start = Date.parse('2026-09-27T10:00:00.000Z');
let now = start;
Date.now = () => now;
let piCalls = 0;
let piResult = { at: start, models: ['opencode-go/deepseek-v4.1-flash'] };
const panes = [
  { id: 'w1:p1', workspace: 'w1', workspaceLabel: 'Sample', label: 'orch', orch: true, agent: 'codex', status: 'working', cwd: checkout },
  { id: 'w1:p2', workspace: 'w1', workspaceLabel: 'Sample', orch: false, agent: 'opencode', name: 'worker-a', status: 'idle', cwd: worker },
];
const engine = new Engine(loadConfig(), { push: false, act: false, collectors: {
  collectHerdr: async () => ({ workspaces: [{ id: 'w1', label: 'Sample' }], panes }),
  readWorkerScreen: async () => 'Free usage exceeded. Please try again later.',
  collectMachine: async () => null,
  collectProcesses: async () => new Map(),
  collectQuotas: async () => [],
  collectWorktreeCounts: async () => ({}),
  collectCwdProcesses: async () => [],
  collectMissingWorktreeProcesses: async () => [],
  collectPiModels: async () => { piCalls++; return piResult; },
} });
const first = await engine.tick();
const memory = JSON.parse(fs.readFileSync(path.join(data, 'memory.json'), 'utf8'));
const rules = JSON.parse(fs.readFileSync(path.join(data, 'rules.json'), 'utf8'));
const bulletin = fs.readFileSync(path.join(data, 'bulletin.md'), 'utf8');
now = start + 10 * 60000;
piResult = null;
await engine.tick();
const callsAt10 = piCalls;
now = start + 16 * 60000;
await engine.tick();
const keptAfterFailure = engine.memory.piModels;
now = start + 3600000;
const reopened = await engine.tick();
console.log(JSON.stringify({
  modelUnavailable: memory.unavailableModels['opencode/big-pickle'],
  laneAfterTick: first.lanes.unmetered.exhausted,
  opencodeOpen: first.lanes.unmetered.byProject.sample.opencode || [],
  piOpen: first.lanes.unmetered.byProject.sample.pi || [],
  piUnavailable: first.lanes.unmetered.unavailable.map((item) => item.model),
  rememberedPi: memory.piModels,
  rulesPi: rules.piModels,
  bulletin,
  callsAt10, piCalls, keptAfterFailure,
  reopenedOpen: reopened.lanes.unmetered.byProject.sample.opencode || [],
}));
`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HOME: temp, HERDR_BOSS_DIR: path.join(temp, 'data'), HERDR_BOSS_LIVE_DIR: path.join(temp, 'live'), NODE_TEST_CONTEXT: '1' },
    encoding: 'utf8',
  }));
  const start = Date.parse('2026-09-27T10:00:00.000Z');
  assert.deepEqual(result.modelUnavailable, {
    model: 'opencode/big-pickle', kind: 'opencode', provider: null, lane: 'unmetered',
    retryAt: start + 3600000, at: start, label: 'Free usage exceeded', reason: 'Free usage exceeded',
  });
  assert.deepEqual(result.laneAfterTick, [{ model: 'opencode/big-pickle', retryAt: start + 3600000, projects: ['sample'], kinds: ['opencode'] }]);
  assert.ok(result.opencodeOpen.length > 0, 'other models in the free lane stay available');
  assert.ok(!result.opencodeOpen.includes('opencode/big-pickle'));
  assert.ok(!result.piOpen.some((model) => model.startsWith('opencode/')));
  assert.ok(result.piUnavailable.includes(FIXTURE_PI_MODEL));
  assert.deepEqual(result.rememberedPi, { at: start, models: ['opencode-go/deepseek-v4.1-flash'] });
  assert.deepEqual(result.rulesPi, result.rememberedPi);
  assert.doesNotMatch(result.bulletin, /- Unmetered opencode: exhausted/);
  assert.match(result.bulletin, /- Unmetered pi fixturezen\/ models: unavailable\. Pi has no credential for the fixturezen provider\.\n/);
  assert.equal(result.callsAt10, 1, 'the collector runs at most once every 15 minutes');
  assert.equal(result.piCalls, 3);
  assert.deepEqual(result.keptAfterFailure, result.rememberedPi, 'a failed collection keeps the last good result');
  assert.ok(result.reopenedOpen.includes('opencode/big-pickle'), 'the model reopens at its cooldown deadline');
});
