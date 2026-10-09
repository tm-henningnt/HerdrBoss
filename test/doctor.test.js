import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runDoctor, doctorCommand } from '../src/doctor.js';

const HOME = '/Users/invented-owner';
const GREEN = {
  os: 'darwin', node: 'v26.10.0', git: 'git version 2.50.0', 'git-name': 'Invented Owner',
  herdr: 'herdr 1.0', 'claude-installed': '2.0', 'claude-signed-in': '{"loggedIn":true}',
  'codex-installed': '1.0', 'codex-signed-in': 'Logged in using ChatGPT',
  'opencode-installed': '1.0', 'opencode-signed-in': '┌ Credentials\n│ OpenAI oauth\n└ 1 credentials',
  'pi-installed': '1.0', 'pi-signed-in': 'provider model context\nanthropic claude 200k',
  gh: 'gh version 2.0', codexbar: '1.0', service: 'state = running', 'data-folder': true,
  'claude-settings': JSON.stringify({ autoMode: { environment: ['### Herdr Boss orchestration', '**Supervisor**: Herdr Boss', '**Messages from the supervisor**: trusted', '**Herdr Boss projects**: folder', '**Owner decisions**: recorded'], allow: ['$defaults', 'A Herdr Boss orchestrator pushes branches', 'A Herdr Boss orchestrator removes its own', 'A Herdr Boss orchestrator or the Boss records', 'The HerdrBoss orchestrator and its workers edit'] } }),
  'codex-settings': '[sandbox_workspace_write]\nwritable_roots = ["/Users/invented-owner/.herdr-boss", "/Users/invented-owner/Projects/.herdr-wt"]\n',
  'codex-rules': ['ps:e', 'ps:-E', 'ps:eww', 'ps:auxe', 'ps:auxeww', 'pkill', 'killall'].map((rule) => `prefix_rule(pattern=[${rule.split(':').map((part) => JSON.stringify(part)).join(',')}], decision="forbidden")`).join('\n'),
  'opencode-settings': '{"agent":{"worker":{"mode":"subagent"}}}',
  disk: { bavail: 20 * 1024 ** 3, bsize: 1 }, memory: 16 * 1024 ** 3,
  'usage-reading': '[{"provider":"claude","usage":{"primary":{"usedPercent":10}}}]',
  'codex-usage': 'Logged in using ChatGPT', 'codex-version': 'codex-cli 0.160.1', 'claude-version': '2.1.287 (Claude Code)', 'claude-usage-file': 60_000,
  'service-answers': { status: 200, body: { schema: 1, contractVersion: '1.0.0', version: '0.1.0', kitRevision: 'abcdef123456', herdrReachable: true } },
  docker: '[{"Name":"default","Endpoints":{"docker":{"Host":"unix:///var/run/docker.sock"}}}]', 'docker-contexts': '{"Name":"default"}',
};
const IDS = ['os', 'node', 'git', 'git-name', 'herdr', 'claude-installed', 'claude-signed-in', 'codex-installed', 'codex-signed-in', 'opencode-installed', 'opencode-signed-in', 'pi-installed', 'pi-signed-in', 'gh', 'codexbar', 'service', 'data-folder', 'claude-settings', 'codex-settings', 'codex-rules', 'opencode-settings', 'disk', 'memory', 'usage-reading', 'service-answers'];
function fake(overrides = {}) {
  return async (request) => {
    const value = Object.hasOwn(overrides, request.id) ? overrides[request.id] : GREEN[request.id];
    if (value instanceof Error) throw value;
    return value;
  };
}

test('doctor returns each onboarding item with its shared step ID when all checks pass', async () => {
  const report = await runDoctor({ home: HOME, runner: fake() });
  assert.equal(report.schema, 'herdr-boss.doctor/1');
  assert.equal(report.ok, true);
  assert.equal(report.exitCode, 0);
  assert.deepEqual(report.items.map((item) => item.id), IDS);
  for (const item of report.items) {
    assert.equal(item.status, 'green', item.id);
    assert.equal(item.fix, null, item.id);
    assert.ok(['check', 'tools', 'signin', 'settings', 'service', 'pacing', 'dashboard'].includes(item.stepId));
    assert.equal(typeof item.message, 'string');
  }
  assert.equal(report.items.find((item) => item.id === 'service-answers').stepId, 'dashboard');
  const lines = [];
  assert.equal(await doctorCommand([], { home: HOME, runner: fake(), output: (line) => lines.push(line) }), 0);
  assert.equal(lines.length, IDS.length);
  assert.ok(lines.every((line) => /^green: [^\n]+$/.test(line)));
});

test('doctor reports free disk space as a note under 15 GB and keeps the existing error threshold', async () => {
  for (const [freeBytes, expectedLine, expectedExit] of [
    [20_000_000_000, /green: Disk has 20\.0 GB free\./, 0],
    [10_000_000_000, /note: Disk has 10\.0 GB free\./, 0],
    [4_000_000_000, /error: Disk has 4\.0 GB free\./, 4],
  ]) {
    const lines = [];
    const code = await doctorCommand([], {
      home: HOME,
      runner: fake({ disk: { bavail: freeBytes, bsize: 1 } }),
      output: (line) => lines.push(line),
    });
    assert.equal(code, expectedExit);
    assert.match(lines.find((line) => /Disk/.test(line)), expectedLine);
  }
});

test('doctor can verify one setup step without probing later steps', async () => {
  const ids = [];
  const report = await runDoctor({ home: HOME, stepId: 'tools', runner: async (request) => {
    ids.push(request.id);
    return fake({ os: 'linux', node: '' })(request);
  } });
  assert.deepEqual(report.items.map((item) => item.id), ['node', 'git', 'git-name', 'herdr', 'claude-installed', 'codex-installed', 'opencode-installed', 'pi-installed', 'gh', 'codexbar']);
  assert.deepEqual(ids, ['os', ...report.items.map((item) => item.id)]);
  assert.equal(report.ok, false);
  assert.equal(report.items[0].fix, 'Follow the Node vendor instructions. Install Node 26.10 or later. Put node on PATH.');
});

const FIXES = {
  os: 'Use macOS or Linux. On Windows, install Ubuntu under WSL2 and run this command in Ubuntu.',
  node: 'Run brew install node. Use Node 26.10 or later. Put node on PATH.', git: 'Run brew install git. Put git on PATH.',
  'git-name': 'Run git config --global user.name "Your name". Replace Your name with your name.',
  herdr: 'Run brew install herdr. Put herdr on PATH.',
  'claude-installed': 'Run brew install --cask claude-code@latest. Put claude on PATH.',
  'claude-signed-in': 'Only you: run claude auth login in your terminal. Sign in on the browser page.',
  'codex-installed': 'Run brew install --cask codex. Put codex on PATH.',
  'codex-signed-in': 'Only you: run codex login in your terminal. Sign in on the browser page.',
  'opencode-installed': 'Run npm install -g opencode-ai. Put opencode on PATH.',
  'opencode-signed-in': 'Only you: run herdr-boss factory login NAME opencode at an Owner terminal. Complete the sign-in there.',
  'pi-installed': 'Run npm install -g @earendil-works/pi-coding-agent. Put pi on PATH.',
  'pi-signed-in': 'Only you: open pi in your terminal. Run /login and sign in to your provider.',
  gh: 'Run brew install gh. Put gh on PATH.',
  codexbar: 'Run brew install --cask codexbar. Put codexbar on PATH.',
  service: 'Run doctor as your normal user, without sudo. On macOS, sudo checks gui/0. Run bin/herdr-boss install from the Herdr Boss folder. On Linux, set up the systemd user service.',
  'data-folder': 'Run bin/herdr-boss install. Give your user read, write, and search access to the data folder.',
  'claude-settings': 'Only you: run herdr-boss harness sync. Back up ~/.claude/settings.json. Add the missing autoMode lines in your editor.',
  'codex-settings': 'Run herdr-boss harness sync --codex-only. Keep ~/.config/herdr-boss and its parent folders outside writable_roots.',
  'codex-rules': 'Copy kit/templates/harness/codex-herdr.rules to ~/.codex/rules/herdr.rules. Replace {{UID}} with your numeric user ID.',
  'opencode-settings': 'Copy the worker profile from kit/templates/harness/opencode-worker-agent.json into ~/.config/opencode/opencode.json under agent.worker.',
  disk: 'Free at least 5 GiB on the disk that holds your Herdr Boss data and worktrees. Remove only files that you own.',
  memory: 'Use a computer with at least 8 GiB of memory. For a factory, give it at least 8 GiB.',
  'usage-reading': 'Only you: sign in to Claude Code. Set the Claude usage source in CodexBar to Auto. Run doctor again.',
  'service-answers': 'Run bin/herdr-boss install from the Herdr Boss folder. Run doctor again after the service starts.',
  docker: 'Install Docker on this factory host. Run docker context inspect to check its saved context.',
  'docker-contexts': 'Create one Docker context for each host with herdr-boss factory host add NAME --docker-context CONTEXT.',
};
const BAD = {
  os: 'win32', node: 'v26.9.9', git: '', 'git-name': ' ', herdr: '',
  'claude-installed': '', 'claude-signed-in': '{"loggedIn":false}',
  'codex-installed': '', 'codex-signed-in': 'Not logged in',
  'opencode-installed': '', 'opencode-signed-in': '0 credentials',
  'pi-installed': '', 'pi-signed-in': 'provider model context\n', gh: '', codexbar: '',
  service: 'state = stopped', 'data-folder': false, 'claude-settings': '{}',
  'codex-settings': '[sandbox_workspace_write]\nwritable_roots = []',
  'codex-rules': '', 'opencode-settings': '{}', disk: { bavail: 1, bsize: 1 }, memory: 1,
  'usage-reading': '[{"provider":"claude","error":{"message":"missing login"}}]',
  'service-answers': { status: 503, body: {} }, docker: '', 'docker-contexts': '',
};
for (const id of IDS.concat(['docker', 'docker-contexts'])) {
  test(`doctor gives the exact fix when ${id} is red`, async () => {
    const lines = [];
    const args = ['--json', ...(id.startsWith('docker') ? ['--factory-host'] : [])];
    const code = await doctorCommand(args, { home: HOME, runner: fake({ [id]: BAD[id] }), output: (line) => lines.push(line) });
    assert.equal(code, 4);
    assert.equal(lines.length, 1);
    const report = JSON.parse(lines[0]);
    assert.equal(report.ok, false);
    assert.equal(report.exitCode, 4);
    const red = report.items.filter((item) => item.status === 'red');
    assert.equal(red.length, 1);
    assert.equal(red[0].id, id);
    assert.equal(red[0].fix, FIXES[id]);
    const plain = [];
    await doctorCommand(args.filter((arg) => arg !== '--json'), { home: HOME, runner: fake({ [id]: BAD[id] }), output: (line) => plain.push(line) });
    const level = id === 'disk' ? 'error' : 'red';
    assert.equal(plain.filter((line) => line.startsWith(`${level}: `)).length, 1);
    assert.ok(plain.find((line) => line.startsWith(`${level}: `)).endsWith(`Fix: ${FIXES[id]}`));
  });
}

// The launchd text of a job that a Homebrew node upgrade stopped, and of the same job in a good state.
const LAUNCHD = (...lines) => ['gui/501/no.tallmaker.herdr-boss = {', '\tactive count = 1', ...lines, '\tprogram = /opt/homebrew/bin/node', '}'].join('\n');
const NODE_PROBLEM = LAUNCHD('\tstate = exited', '\tlast exit code = 78');

test('doctor names the install repair when the service check shows a replaced node binary', async () => {
  const lines = [];
  const options = { home: HOME, runner: fake({ service: NODE_PROBLEM }), installedNode: '/opt/homebrew/bin/node' };
  assert.equal(await doctorCommand([], { ...options, output: (line) => lines.push(line) }), 4);
  const line = lines.find((item) => item.startsWith('red: ') && item.includes('Herdr Boss service'));
  assert.equal(line, 'red: Herdr Boss service needs a fix. Fix: Homebrew replaced node: run herdr-boss install');
  const json = [];
  await doctorCommand(['--json'], { ...options, output: (line) => json.push(line) });
  const red = JSON.parse(json[0]).items.filter((item) => item.id === 'service');
  assert.equal(red[0].status, 'red');
  assert.equal(red[0].fix, 'Homebrew replaced node: run herdr-boss install');
  // The same job after `herdr-boss install` runs the installed node path, so the check stays green.
  const good = await runDoctor({ home: HOME, runner: fake({ service: LAUNCHD('\tstate = running') }), installedNode: '/opt/homebrew/bin/node' });
  assert.equal(good.exitCode, 0);
  assert.equal(good.items.find((item) => item.id === 'service').status, 'green');
  // A job that a Homebrew upgrade registered under a versioned node path fails the same way.
  const cellar = await runDoctor({ home: HOME, runner: fake({ service: LAUNCHD('\tstate = running').replace('/opt/homebrew/bin/node', '/opt/homebrew/Cellar/node/26.10.0/bin/node') }), installedNode: '/opt/homebrew/bin/node' });
  assert.equal(cellar.items.find((item) => item.id === 'service').fix, 'Homebrew replaced node: run herdr-boss install');
  assert.equal(cellar.exitCode, 4);
});

test('doctor JSON and plain output do not expose raw output, errors, homes, addresses or keys', async () => {
  const unsafe = `${HOME}/secret/config.json private.example.test 192.0.2.1 sk-invented-key`;
  const runner = fake({ 'git-name': unsafe, 'claude-signed-in': `{\"loggedIn\":true,\"token\":\"${unsafe}\"}`, node: new Error(unsafe), 'opencode-settings': '{"agent":{"worker":{}},"apiKey":"sk-invented-key"}' });
  for (const args of [[], ['--json']]) {
    const lines = [];
    assert.equal(await doctorCommand(args, { home: HOME, runner, output: (line) => lines.push(line) }), 4);
    const output = lines.join('\n');
    for (const forbidden of [HOME, 'private.example.test', '192.0.2.1', 'sk-invented-key', '/secret/config.json']) assert.ok(!output.includes(forbidden));
    assert.ok(!output.includes('\u001b'), 'no terminal controls from probes');
  }
  const lines = [];
  await doctorCommand(['--json'], { home: HOME, runner: fake({ 'claude-settings': '' }), output: (line) => lines.push(line) });
  assert.ok(lines[0].includes('~/.claude/settings.json'));
});

test('doctor aborts a timed out check and continues the remaining checks', async () => {
  let signal;
  const ids = [];
  const runner = async (request, options) => {
    ids.push(request.id);
    assert.ok(options.timeout > 0);
    if (request.id === 'herdr') {
      signal = options.signal;
      return new Promise(() => {});
    }
    return fake()(request);
  };
  const report = await runDoctor({ home: HOME, runner, timeoutMs: 20 });
  assert.equal(signal.aborted, true);
  assert.deepEqual(ids, IDS);
  const red = report.items.filter((item) => item.status === 'red');
  assert.equal(red.length, 1);
  assert.equal(red[0].id, 'herdr');
  assert.equal(red[0].message, 'Herdr check timed out.');
  assert.equal(red[0].fix, FIXES.herdr);
  assert.equal(report.exitCode, 4);
});

test('doctor adds Docker checks only on an explicit factory host request', async () => {
  const requests = [];
  const runner = async (request) => { requests.push(request); return fake()(request); };
  const lines = [];
  assert.equal(await doctorCommand(['--json', '--factory-host'], { home: HOME, runner, output: (line) => lines.push(line) }), 0);
  assert.deepEqual(JSON.parse(lines[0]).items.map((item) => item.id), IDS.concat(['docker', 'docker-contexts']));
  assert.equal(requests.filter((request) => request.command === 'docker').length, 2);
});

test('doctor reports invalid factory rows without printing their values', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-doctor-registry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const factories = path.join(root, 'factories');
  fs.mkdirSync(factories);
  fs.writeFileSync(path.join(factories, 'fleet.json'), JSON.stringify({ schema: 1, contractVersion: '1.0.0', minimumFactoryVersion: '0.1.0', hosts: [
    { hostId: 'example-host', runtime: 'orbstack', personalOnly: true, codexSandbox: 'user-namespaces', transport: 'local' },
  ], factories: [
    { factoryId: 'win1', name: 'win1', hostId: 'example-host', kind: 'container', profile: 'personal', dashboardUrl: 'http://win1.localhost:4478', version: '0.1.0', kitRevision: 'abcdef012345', containerName: 'hf-win1', hostname: 'win1.localhost', ports: { dashboard: 4478, ssh: 2222 }, image: { builtAt: '2026-10-07T10:59:22.928Z', pinsHash: 'a'.repeat(64) } },
    { factoryId: 'factory-good', name: 'factory-good', hostId: 'example-host', kind: 'native', profile: 'personal', dashboardUrl: 'http://good.localhost:4478', version: '0.1.0', kitRevision: 'abcdef012345' },
  ] }));
  const lines = [];
  const env = { HOME: root, HERDR_FACTORIES_DIR: factories, HERDR_BOSS_DIR: path.join(root, 'boss') };
  assert.equal(await doctorCommand([], { home: HOME, env, runner: fake(), output: (line) => lines.push(line) }), 0);
  assert.ok(lines.includes('warning: registry row win1: image.builtAt must be YYYY-MM-DDTHH:MM:SSZ'));
  assert.doesNotMatch(lines.join('\n'), /10:59:22\.928/);
  const json = [];
  assert.equal(await doctorCommand(['--json'], { home: HOME, env, runner: fake(), output: (line) => json.push(line) }), 0);
  assert.ok(JSON.parse(json[0]).warnings.includes('registry row win1: image.builtAt must be YYYY-MM-DDTHH:MM:SSZ'));
});

test('doctor diagnostics hide hostile registry field names', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-doctor-hostile-registry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const factories = path.join(root, 'factories');
  fs.mkdirSync(factories);
  const hostile = 'SECRET-KEY-xyz';
  const row = { factoryId: 'win1', name: 'win1', hostId: 'example-host', kind: 'container', profile: 'personal',
    dashboardUrl: 'http://win1.localhost:4478', version: '0.1.0', kitRevision: 'abcdef012345', containerName: 'hf-win1',
    hostname: 'win1.localhost', ports: { dashboard: 4478, ssh: 2222 },
    image: { builtAt: '2026-10-07T10:59:22Z', pinsHash: 'a'.repeat(64), [hostile]: 'private nested value' }, [hostile]: 'private row value' };
  fs.writeFileSync(path.join(factories, 'fleet.json'), JSON.stringify({ schema: 1, contractVersion: '1.0.0', minimumFactoryVersion: '0.1.0', hosts: [
    { hostId: 'example-host', runtime: 'orbstack', personalOnly: true, codexSandbox: 'user-namespaces', transport: 'local' },
  ], factories: [row] }));
  const lines = [];
  const env = { HOME: root, HERDR_FACTORIES_DIR: factories, HERDR_BOSS_DIR: path.join(root, 'boss') };
  assert.equal(await doctorCommand([], { home: HOME, env, runner: fake(), output: (line) => lines.push(line) }), 0);
  assert.ok(lines.includes('warning: registry row win1: <unknown field> is not allowed'));
  assert.ok(lines.includes('warning: registry row win1: image.<unknown field> is not allowed'));
  assert.doesNotMatch(lines.join('\n'), /SECRET-KEY-xyz|private row value|private nested value/);
});

test('doctor prints a warning for an outside factory project without failing the checks', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-doctor-factory-'));
  const dataDir = path.join(root, 'data');
  const workRoot = path.join(root, 'work');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(workRoot, 'trusted'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(workRoot, 'linked'), 'dir');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, 'project-repos.json'), JSON.stringify([
    { slug: 'herdrboss', repo: '/home/factory/herdr-boss' },
    { slug: 'trusted', repo: path.join(workRoot, 'trusted') },
    { slug: 'outside', repo: path.join(workRoot, 'linked') },
  ]));
  const options = { home: HOME, env: { HOME: '/home/factory', HERDR_BOSS_DIR: dataDir }, factoryProjectGroup: workRoot, factory: true, runner: fake() };
  const lines = [];
  assert.equal(await doctorCommand([], { ...options, output: (line) => lines.push(line) }), 0);
  assert.ok(lines.includes('warning: project outside is outside the work volume and is not trusted.'));
  assert.equal(lines.some((line) => /project trusted is outside/.test(line)), false);
  assert.equal(lines.some((line) => /project herdrboss is outside/.test(line)), false);

  const json = [];
  assert.equal(await doctorCommand(['--json'], { ...options, output: (line) => json.push(line) }), 0);
  assert.deepEqual(JSON.parse(json[0]).warnings, ['project outside is outside the work volume and is not trusted.']);
});

test('doctor rejects unknown and repeated flags before it reads anything', async () => {
  let calls = 0;
  const runner = async () => { calls += 1; throw new Error('must not run'); };
  for (const args of [['--unknown=sk-invented-key'], ['--json', '--json'], ['--factory-host', '--factory-host']]) {
    await assert.rejects(doctorCommand(args, { runner }), { message: 'Usage: doctor [--json] [--factory-host]' });
  }
  assert.equal(calls, 0);
});

test('doctor accepts OpenCode JSONC settings without treating comments as settings', async () => {
  const report = await runDoctor({ home: HOME, runner: fake({ 'opencode-settings': '// comment\n{"agent":{"worker":{"mode":"primary",}},"url":"https://example.test/a,b}",}' }) });
  assert.equal(report.items.find((item) => item.id === 'opencode-settings').status, 'green');
});

test('doctor refuses malformed or duplicate Codex roots instead of reporting green', async () => {
  for (const config of [
    GREEN['codex-settings'] + 'writable_roots = []\n',
    GREEN['codex-settings'] + '\n[sandbox_workspace_write]\nwritable_roots = []\n',
    GREEN['codex-settings'].replace(/\]\n$/, ', 42]\n'),
  ]) {
    const report = await runDoctor({ home: HOME, runner: fake({ 'codex-settings': config }) });
    assert.equal(report.items.find((item) => item.id === 'codex-settings').status, 'red');
  }
});

test('Linux install fixes use the Pi command and vendor instructions without Mac commands', async () => {
  const overrides = Object.fromEntries(['herdr', 'claude-installed', 'codex-installed', 'opencode-installed', 'pi-installed', 'codexbar'].map((id) => [id, '']));
  const report = await runDoctor({ home: HOME, runner: fake({ ...overrides, os: 'linux' }) });
  const item = (id) => report.items.find((row) => row.id === id);
  assert.equal(item('herdr').fix, 'Follow the Herdr vendor instructions. Put herdr on PATH.');
  assert.equal(item('codex-installed').fix, 'Follow the Codex vendor instructions. Put codex on PATH.');
  assert.equal(item('pi-installed').fix, 'Run npm install -g @earendil-works/pi-coding-agent. Put pi on PATH.');
  assert.equal(item('codexbar').fix, 'CodexBar does not exist on Linux and is not needed. The Codex usage and Claude usage checks replace it.');
  for (const row of report.items.filter((row) => row.fix)) {
    assert.ok(!row.fix.includes('brew install'));
    if (row.id !== 'pi-installed') assert.ok(!row.fix.includes('npm install'));
  }
});

test('factory host checks inspect saved Docker metadata without a daemon request', async () => {
  const calls = [];
  const runner = async (request) => {
    if (request.command === 'docker') {
      calls.push(request.args);
      assert.equal(request.args[0], 'context');
      assert.ok(['inspect', 'ls'].includes(request.args[1]));
    }
    return fake({ docker: '[{"Name":"remote","Endpoints":{"docker":{"Host":"ssh://invented.example.test"}}}]' })(request);
  };
  const report = await runDoctor({ home: HOME, runner, factoryHost: true });
  assert.equal(report.items.find((item) => item.id === 'docker').status, 'green');
  assert.deepEqual(calls, [['context', 'inspect'], ['context', 'ls', '--format', '{{json .}}']]);
  assert.ok(!JSON.stringify(report).includes('invented.example.test'));
});

const LINUX_READER_IDS = ['codex-usage', 'codex-version', 'claude-usage-file', 'claude-version'];

test('Linux doctor checks the usage readers of a factory and skips the CodexBar reading', async () => {
  const report = await runDoctor({ home: HOME, stepId: 'pacing', runner: fake({ os: 'linux' }) });
  assert.deepEqual(report.items.map((item) => item.id), LINUX_READER_IDS);
  assert.ok(report.items.every((item) => item.status === 'green' && item.stepId === 'pacing'));
  const mac = await runDoctor({ home: HOME, stepId: 'pacing', runner: fake() });
  assert.deepEqual(mac.items.map((item) => item.id), ['usage-reading']);
});

test('Linux doctor gives a plain fix when Codex is missing or logged out', async () => {
  const report = await runDoctor({ home: HOME, stepId: 'pacing', runner: fake({ os: 'linux', 'codex-usage': new Error('ENOENT'), 'codex-version': '' }) });
  const item = (id) => report.items.find((row) => row.id === id);
  assert.equal(item('codex-usage').status, 'red');
  assert.equal(item('codex-usage').fix, 'Install Codex in the factory image and log in as the factory user. Run doctor again.');
  assert.equal(item('codex-version').fix, 'Install Codex in the factory image. The usage reader runs codex app-server.');
  const out = await runDoctor({ home: HOME, stepId: 'pacing', runner: fake({ os: 'linux', 'codex-usage': 'Not logged in' }) });
  assert.equal(out.items.find((row) => row.id === 'codex-usage').status, 'red');
});

test('Linux doctor gives the Claude hint when the helper file is missing or older than 3 hours', async () => {
  for (const age of [null, 3 * 3600_000 + 1]) {
    const report = await runDoctor({ home: HOME, stepId: 'pacing', runner: fake({ os: 'linux', 'claude-usage-file': age }) });
    const item = report.items.find((row) => row.id === 'claude-usage-file');
    assert.equal(item.status, 'red');
    assert.equal(item.fix, 'Start a Claude session in the factory. Check that Claude usage helper in factories is on in Settings. Run doctor again.');
  }
  const bad = await runDoctor({ home: HOME, stepId: 'pacing', runner: fake({ os: 'linux', 'claude-version': '' }) });
  assert.equal(bad.items.find((row) => row.id === 'claude-version').fix, 'Install Claude Code in the factory image. The status line helper runs inside it.');
});

test('the doctor probe for the Claude helper file returns the age and reads no content', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createDoctorRunner } = await import('../src/doctor.js');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-claude-'));
  const runner = createDoctorRunner({ home: HOME, env: { HERDR_BOSS_DIR: data }, platform: 'linux' });
  const ask = () => runner({ kind: 'claude-usage-age', id: 'claude-usage-file' }, { signal: new AbortController().signal, timeout: 1000 });
  assert.equal(await ask(), null);
  const dir = path.join(data, 'claude-rate-limits');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'a.json'), 'not read');
  const age = await ask();
  assert.ok(age >= 0 && age < 60_000);
});
