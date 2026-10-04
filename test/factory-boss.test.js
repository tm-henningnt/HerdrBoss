import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { factoryCommand } from '../src/factory-host.js';
import { BOSS_START_CALL_PLAN } from '../src/factory-boss.js';
import { factoryFile, writeFleet, writePrivate } from '../src/factory-store.js';
import { createDockerTransport } from '../src/factory-transport.js';

function fixture({
  interactiveCode = 0,
  verifierCode = 0,
  workspaceRows = [],
  paneRows = [],
  factoryLabel = 'demo',
  workerLabel = 'fa1',
  running = true,
  projectPaths = [],
  kitCheckCode = 1,
  kitInstallCode = 0,
  herdrFailure = false,
  workspaceCreateFailure = false,
  tabCreateFailure = false,
  paneRenameFailure = false,
  workspaceAppearsAfterPaths = false,
  resumePromptProbe = { promptMarkerPresent: false, promptTyped: false },
  promptCode = 0,
  promptOutcome = 'ready',
  executeHarnessState = false,
  paneText = '',
  promptStderr = 'private prompt error',
  containerHostname = 'fixture-node',
  paneReadCode = 0,
  detectionReadCode = paneReadCode,
  gitConfig = {},
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-boss-'));
  const env = {
    HOME: root,
    HERDR_BOSS_DIR: path.join(root, 'data'),
    HERDR_FACTORIES_DIR: path.join(root, 'factories'),
    TMPDIR: root,
  };
  const factory = {
    factoryId: 'demo', name: 'demo', hostId: 'local', profile: 'personal',
    dashboardUrl: 'http://demo.localhost:4478', version: '0.1.0', kitRevision: 'abcdef012345',
    kind: 'container', containerName: 'hf-demo', hostname: 'demo.localhost',
    ports: { dashboard: 4478, ssh: 2222 },
    image: { builtAt: '2026-10-03T00:00:00Z', pinsHash: 'a'.repeat(64) },
  };
  writeFleet(env, {
    schema: 1, contractVersion: '1.0.0', minimumFactoryVersion: '0.1.0',
    hosts: [{ hostId: 'local', runtime: 'orbstack', personalOnly: true, codexSandbox: 'user-namespaces', transport: 'local' }],
    factories: [factory],
  });
  writePrivate(factoryFile(env, 'demo'), {
    schema: 1, name: 'demo', hostId: 'local', profile: 'personal',
    ports: factory.ports, imageTag: 'example-factory:test', image: factory.image,
  });
  const output = [];
  const dockerCalls = [];
  const container = {
    Config: { Hostname: containerHostname, Labels: { 'herdr-factory': factoryLabel, ...(workerLabel ? { 'herdr-factory-spike': workerLabel } : {}) } },
    State: { Status: running ? 'running' : 'exited', Running: running },
  };
  const installedPaths = new Set();
  const git = { ...gitConfig };
  let currentResumePromptProbe = resumePromptProbe;
  let workspaces = workspaceRows;
  let panes = paneRows;
  const docker = { async run(args, options) {
      dockerCalls.push({ args, options });
      if (args[0] === 'container' && args[1] === 'inspect') return { code: 0, stdout: JSON.stringify([container]), stderr: '' };
      const scriptIndex = args.indexOf('-e');
      const script = scriptIndex >= 0 ? args[scriptIndex + 1] : '';
      if (executeHarnessState && script.includes('prepareHarnessHome')) {
        const localScript = script.replace('/home/factory/herdr-boss/src/factory-harness-state.js',
          pathToFileURL(path.resolve('src/factory-harness-state.js')).href);
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', localScript, ...args.slice(scriptIndex + 2)], {
          encoding: 'utf8', env: { ...process.env, HOME: root },
        });
        return { code: result.status, stdout: result.stdout, stderr: result.stderr };
      }
      const gitAt = args.indexOf('git');
      if (gitAt >= 0 && args[gitAt + 1] === 'config') {
        const rest = args.slice(gitAt + 2);
        if (!rest.includes('--global')) return { code: 2, stdout: '', stderr: 'unexpected git scope' };
        if (rest.includes('--get')) return git[rest.at(-1)] ? { code: 0, stdout: `${git[rest.at(-1)]}\n`, stderr: '' } : { code: 1, stdout: '', stderr: '' };
        git[rest.at(-2)] = rest.at(-1);
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args.includes('auth') && args.at(-1) === 'login') return { code: interactiveCode, stdout: 'private login output', stderr: '' };
      if ((args.includes('auth') || args.includes('login')) && args.at(-1) === 'status') return { code: verifierCode, stdout: 'private verifier output', stderr: '' };
      if (args.includes('project') && args.includes('paths')) {
        if (workspaceAppearsAfterPaths) {
          workspaces = [{ workspace_id: 'ws-late', label: 'Boss' }];
          panes = [{ pane_id: 'ws-late:p1', workspace_id: 'ws-late', label: 'boss' }];
        }
        return { code: 0, stdout: JSON.stringify(projectPaths), stderr: '' };
      }
      if (args.includes('check') && args.includes('agents')) {
        const cwd = args[args.indexOf('--workdir') + 1];
        return { code: installedPaths.has(cwd) ? 0 : kitCheckCode, stdout: '', stderr: '' };
      }
      if (args.includes('kit') && args.includes('install')) {
        if (kitInstallCode === 0) installedPaths.add(args[args.indexOf('--workdir') + 1]);
        return { code: kitInstallCode, stdout: '', stderr: '' };
      }
      if (args.includes('workspace') && args.at(-1) === 'list') {
        if (herdrFailure) return { code: 1, stdout: '', stderr: 'private herdr error' };
        return { code: 0, stdout: JSON.stringify({ workspaces }), stderr: '' };
      }
      if (args.includes('pane') && args.includes('list')) return { code: 0, stdout: JSON.stringify({ panes }), stderr: '' };
      if (args.includes('pane') && args.includes('read')) return { code: args.includes('--source') ? detectionReadCode : paneReadCode, stdout: JSON.stringify({ text: paneText }), stderr: '' };
      if (script.includes('inspectBossPromptText') && script.includes('readAgentText')) {
        return { code: 0, stdout: JSON.stringify(currentResumePromptProbe), stderr: '' };
      }
      if (args.includes('workspace') && args.includes('create')) {
        if (workspaceCreateFailure) return { code: 1, stdout: '', stderr: 'private herdr create error' };
        workspaces = [{ workspace_id: 'ws-boss', label: 'Boss' }];
        panes = [{ pane_id: 'ws-boss:p1', workspace_id: 'ws-boss', label: '' }];
        return { code: 0, stdout: JSON.stringify({ workspace: workspaces[0], root_pane: panes[0] }), stderr: '' };
      }
      if (args.includes('pane') && args.includes('rename')) {
        if (paneRenameFailure) return { code: 1, stdout: '', stderr: 'private pane rename error' };
        const pane = panes.find((item) => item.pane_id === args.at(-2));
        if (pane) pane.label = args.at(-1);
        return { code: 0, stdout: '{}', stderr: '' };
      }
      if (args.includes('tab') && args.includes('create')) {
        if (tabCreateFailure) return { code: 1, stdout: '', stderr: 'private tab create error' };
        const createdPane = { pane_id: `${args[args.indexOf('--workspace') + 1]}:p-new`, workspace_id: args[args.indexOf('--workspace') + 1], label: '' };
        panes = [...panes, createdPane];
        return { code: 0, stdout: JSON.stringify({ root_pane: createdPane }), stderr: '' };
      }
      if (script.includes('openMessageStore')) return { code: 0, stdout: '', stderr: '' };
      if (script.includes('deliverPrompt')) {
        if (promptCode !== 0) return { code: promptCode, stdout: '', stderr: promptStderr };
        const pane = panes.find((item) => item.label === 'boss');
        if (pane) Object.assign(pane, {
          agent: 'claude',
          agent_status: promptOutcome === 'unsent' ? 'idle' : 'working',
          ...(promptOutcome === 'unsent' ? { pending_prompt: args.at(-2), prompt_marker_present: false } : {}),
        });
        if (promptOutcome === 'unsent') currentResumePromptProbe = { promptMarkerPresent: false, promptTyped: true };
        return { code: 0, stdout: JSON.stringify({ outcome: promptOutcome }), stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    } };
  const io = {
    env,
    isContainer: () => false,
    transportFactory: () => docker,
    stdout: { write: (text) => output.push(text) },
    stderr: { write: (text) => output.push(text) },
  };
  return { root, io, output, dockerCalls, git, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function hasBossPromptScript({ args }) {
  const index = args.indexOf('-e');
  return index >= 0 && args[index + 1]?.includes('deliverPrompt');
}

test('factory boss start --dry-run prints the call plan without contacting Docker', async () => {
  const f = fixture();
  try {
    assert.equal(await factoryCommand(['boss', 'start', 'demo', '--dry-run'], f.io), 0);
    assert.match(f.output.join(''), /Claude/);
    assert.match(f.output.join(''), /install the Herdr Boss kit/);
    assert.match(f.output.join(''), /Boss pane/);
    assert.deepEqual(f.dockerCalls, []);
  } finally { f.cleanup(); }
});

test('factory boss start refuses a container without both ownership labels before exec', async () => {
  const f = fixture({ workerLabel: null });
  try {
    await assert.rejects(factoryCommand(['boss', 'start', 'demo'], f.io), /matching factory and worker labels/);
    assert.equal(f.dockerCalls.length, 1);
    assert.deepEqual(f.dockerCalls[0].args.slice(0, 2), ['container', 'inspect']);
  } finally { f.cleanup(); }
});

test('factory login uses inherited stdio for the harness flow, then prints only ok after verification', async () => {
  const f = fixture();
  try {
    assert.equal(await factoryCommand(['login', 'demo', 'claude'], f.io), 0);
    assert.equal(f.output.join(''), 'ok\n');
    const login = f.dockerCalls.find(({ args }) => args.includes('auth') && args.at(-1) === 'login');
    assert.deepEqual(login.args, ['exec', '-it', '--user', 'factory', 'hf-demo', 'claude', 'auth', 'login']);
    assert.equal(login.options.interactive, true);
    assert.equal(login.options.timeout, 30 * 60_000);
    assert.deepEqual(f.dockerCalls.find(({ args }) => args.includes('auth') && args.at(-1) === 'status').args,
      ['exec', '--user', 'factory', 'hf-demo', 'claude', 'auth', 'status']);
    assert.doesNotMatch(f.output.join(''), /private|token/i);
  } finally { f.cleanup(); }
});

test('factory login prints only failed when the harmless verifier rejects the login', async () => {
  const f = fixture({ verifierCode: 1 });
  try {
    assert.equal(await factoryCommand(['login', 'demo', 'codex'], f.io), 1);
    assert.equal(f.output.join(''), 'failed\n');
    const login = f.dockerCalls.find(({ args }) => args.includes('--device-auth'));
    assert.deepEqual(login.args, ['exec', '-it', '--user', 'factory', 'hf-demo', 'codex', 'login', '--device-auth']);
    assert.equal(login.options.interactive, true);
    assert.deepEqual(f.dockerCalls.find(({ args }) => args.includes('login') && args.at(-1) === 'status').args,
      ['exec', '--user', 'factory', 'hf-demo', 'codex', 'login', 'status']);
  } finally { f.cleanup(); }
});

test('factory login prepares a fresh Claude home and keeps the credential file untouched', async () => {
  const f = fixture({ executeHarnessState: true, projectPaths: [{ path: '/home/factory/work/alpha' }] });
  try {
    fs.mkdirSync(path.join(f.root, '.claude'));
    const credential = path.join(f.root, '.claude', '.credentials.json');
    fs.writeFileSync(credential, '{"fixture":"keep exactly"}\n', { mode: 0o600 });
    const before = fs.statSync(credential);
    assert.equal(await factoryCommand(['login', 'demo', 'claude'], f.io), 0);
    const file = path.join(f.root, '.claude.json');
    assert.ok(fs.existsSync(file), 'the factory user gets first-run state after login');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(state.hasCompletedOnboarding, true);
    assert.equal(state.theme, 'dark');
    for (const folder of ['/home/factory/herdr-boss', '/home/factory/work/alpha']) {
      assert.equal(state.projects[folder].hasTrustDialogAccepted, true);
    }
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(credential, 'utf8'), '{"fixture":"keep exactly"}\n');
    assert.equal(fs.statSync(credential).mtimeMs, before.mtimeMs);
    const prepare = f.dockerCalls.find(({ args }) => args.some((arg) => arg.includes('prepareHarnessHome')));
    assert.ok(prepare.args.includes('HOME=/home/factory'));
    assert.equal(prepare.args[prepare.args.indexOf('--user') + 1], 'factory');
  } finally { f.cleanup(); }
});

test('factory boss start prepares an existing Claude home without losing other keys', async () => {
  const f = fixture({ executeHarnessState: true, projectPaths: [{ path: '/home/factory/work/alpha' }] });
  try {
    const file = path.join(f.root, '.claude.json');
    fs.writeFileSync(file, JSON.stringify({ theme: 'light', oauthAccount: { fixture: 'keep' }, custom: [1, 2],
      projects: { '/home/factory/work/alpha': { allowedTools: ['Read'], hasTrustDialogAccepted: false },
        '/unrelated': { hasTrustDialogAccepted: false } } }));
    assert.equal(await factoryCommand(['boss', 'start', 'demo'], f.io), 0);
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(state.hasCompletedOnboarding, true);
    assert.equal(state.theme, 'light');
    assert.deepEqual(state.oauthAccount, { fixture: 'keep' });
    assert.deepEqual(state.custom, [1, 2]);
    assert.deepEqual(state.projects['/home/factory/work/alpha'], { allowedTools: ['Read'], hasTrustDialogAccepted: true });
    assert.deepEqual(state.projects['/unrelated'], { hasTrustDialogAccepted: false });
    const prepIndex = f.dockerCalls.findIndex(({ args }) => args.some((arg) => arg.includes('prepareHarnessHome')));
    assert.ok(prepIndex >= 0 && prepIndex < f.dockerCalls.findIndex(hasBossPromptScript));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { f.cleanup(); }
});

test('factory boss start trusts the factory work folder for a fresh Claude home', async () => {
  const f = fixture({ executeHarnessState: true, projectPaths: [{ path: '/home/factory/work/alpha' }] });
  try {
    assert.equal(await factoryCommand(['boss', 'start', 'demo'], f.io), 0);
    const state = JSON.parse(fs.readFileSync(path.join(f.root, '.claude.json'), 'utf8'));
    for (const folder of ['/home/factory/herdr-boss', '/home/factory/work', '/home/factory/work/alpha']) {
      assert.equal(state.projects[folder]?.hasTrustDialogAccepted, true, `the folder ${folder} is trusted`);
    }
    // The work folder is trusted, but it is not a project: it gets no kit files.
    const kitChecks = f.dockerCalls.filter(({ args }) => args.includes('check') && args.includes('agents'));
    const kitWorkdirs = kitChecks.map(({ args }) => args[args.indexOf('--workdir') + 1]);
    assert.equal(kitWorkdirs.includes('/home/factory/work'), false);
  } finally { f.cleanup(); }
});

test('factory login prepares fresh Codex trust and first-run notice state without touching auth', async () => {
  const f = fixture({ executeHarnessState: true, projectPaths: [{ path: '/home/factory/work/alpha' }] });
  try {
    fs.mkdirSync(path.join(f.root, '.codex'));
    const auth = path.join(f.root, '.codex', 'auth.json');
    fs.writeFileSync(auth, '{"fixture":"unchanged"}\n', { mode: 0o600 });
    const before = fs.statSync(auth);
    assert.equal(await factoryCommand(['login', 'demo', 'codex'], f.io), 0);
    const file = path.join(f.root, '.codex', 'config.toml');
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /\[projects\."\/home\/factory\/herdr-boss"\]\ntrust_level = "trusted"/);
    assert.match(text, /\[projects\."\/home\/factory\/work\/alpha"\]\ntrust_level = "trusted"/);
    assert.match(text, /\[notice\]\nhide_full_access_warning = true/);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(auth, 'utf8'), '{"fixture":"unchanged"}\n');
    assert.equal(fs.statSync(auth).mtimeMs, before.mtimeMs);
  } finally { f.cleanup(); }
});

test('factory boss start merges existing Codex tables and repeated preparation is stable', async () => {
  const f = fixture({ executeHarnessState: true, projectPaths: [{ path: '/home/factory/work/alpha' }] });
  try {
    fs.mkdirSync(path.join(f.root, '.codex'));
    const file = path.join(f.root, '.codex', 'config.toml');
    const previous = '# keep this comment\nmodel = "fixture-model"\n\n[sandbox_workspace_write]\nnetwork_access = true\n\n' +
      "[projects.'/home/factory/herdr-boss'] # keep header\ntrust_level = 'untrusted' # change only this value\nextra = 7\n\n" +
      '[projects."/unrelated"]\ntrust_level = "untrusted"\n\n[notice]\nhide_full_access_warning = false\ncustom = true\n';
    fs.writeFileSync(file, previous);
    assert.equal(await factoryCommand(['boss', 'start', 'demo', '--harness', 'codex'], f.io), 0);
    const once = fs.readFileSync(file, 'utf8');
    assert.match(once, /trust_level = "trusted" # change only this value/);
    assert.match(once, /hide_full_access_warning = true/);
    for (const keep of ['# keep this comment', 'model = "fixture-model"', '[sandbox_workspace_write]\nnetwork_access = true',
      '[projects."/unrelated"]\ntrust_level = "untrusted"', 'extra = 7', 'custom = true']) assert.ok(once.includes(keep));
    assert.equal(once.match(/^\[notice\]/gm).length, 1);
    assert.equal(await factoryCommand(['login', 'demo', 'codex'], f.io), 0);
    assert.equal(fs.readFileSync(file, 'utf8'), once);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { f.cleanup(); }
});

test('factory preparation preserves dotted Codex keys and table text inside multiline strings', async () => {
  const f = fixture({ executeHarnessState: true });
  try {
    fs.mkdirSync(path.join(f.root, '.codex'));
    const file = path.join(f.root, '.codex', 'config.toml');
    fs.writeFileSync(file, 'projects."/home/factory/herdr-boss".trust_level = "untrusted"\n' +
      'notice.hide_full_access_warning = false\n' +
      'custom = """\n[notice]\nhide_full_access_warning = false\n"""\n');
    assert.equal(await factoryCommand(['login', 'demo', 'codex'], f.io), 0);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /^projects\."\/home\/factory\/herdr-boss"\.trust_level = "trusted"/);
    assert.match(text, /notice\.hide_full_access_warning = true/);
    assert.ok(text.includes('custom = """\n[notice]\nhide_full_access_warning = false\n"""'));
    assert.equal(text.match(/^\[notice\]/gm).length, 1, 'the only notice header is inside the string');
  } finally { f.cleanup(); }
});

test('factory preparation adds a missing dotted trust key before a new Codex project table', async () => {
  const f = fixture({ executeHarnessState: true, projectPaths: [{ path: '/home/factory/work/alpha' }] });
  try {
    fs.mkdirSync(path.join(f.root, '.codex'));
    const file = path.join(f.root, '.codex', 'config.toml');
    fs.writeFileSync(file, 'notice.custom = true\nprojects."/home/factory/herdr-boss".extra = 7\n');
    assert.equal(await factoryCommand(['login', 'demo', 'codex'], f.io), 0);
    const text = fs.readFileSync(file, 'utf8');
    const trust = text.indexOf('projects."/home/factory/herdr-boss".trust_level = "trusted"');
    const table = text.indexOf('[projects."/home/factory/work/alpha"]');
    assert.ok(trust >= 0 && table > trust, 'the dotted assignment stays in the root table');
    assert.ok(text.includes('notice.hide_full_access_warning = true'));
  } finally { f.cleanup(); }
});

test('factory preparation does not replace malformed Claude state or inline Codex tables', async () => {
  for (const [harness, relative, previous] of [['claude', '.claude.json', '{broken'],
    ['codex', '.codex/config.toml', 'projects = { "/home/factory/herdr-boss" = { trust_level = "untrusted" } }\n']]) {
    const f = fixture({ executeHarnessState: true });
    try {
      const file = path.join(f.root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, previous);
      assert.equal(await factoryCommand(['login', 'demo', harness], f.io), 1);
      assert.equal(f.output.join(''), 'failed\n');
      assert.equal(fs.readFileSync(file, 'utf8'), previous);
      await assert.rejects(factoryCommand(['boss', 'start', 'demo', '--harness', harness], f.io), /first-run state could not be prepared/);
      assert.equal(f.dockerCalls.some(hasBossPromptScript), false);
      assert.equal(fs.readFileSync(file, 'utf8'), previous);
    } finally { f.cleanup(); }
  }
});

test('factory login still checks authentication after the interactive command fails', async () => {
  const f = fixture({ interactiveCode: 1 });
  try {
    assert.equal(await factoryCommand(['login', 'demo', 'claude'], f.io), 1);
    assert.equal(f.output.join(''), 'failed\n');
    assert.equal(f.dockerCalls.filter(({ args }) => args.includes('auth') && args.at(-1) === 'status').length, 1);
  } finally { f.cleanup(); }
});

test('factory boss start exposes and follows the five-step call plan inside the factory', async () => {
  const f = fixture({ projectPaths: [{ path: '/home/factory/work/alpha' }] });
  try {
    assert.deepEqual(BOSS_START_CALL_PLAN, ['harness-login', 'kit-install', 'herdr-workspace-and-pane', 'boss-prompt', 'ready-prompt-check']);
    assert.equal(await factoryCommand(['boss', 'start', 'demo'], f.io), 0);
    const commandText = (call) => call.args.join(' ');
    const verifier = f.dockerCalls.find((call) => commandText(call).includes('claude auth status'));
    const paths = f.dockerCalls.find((call) => commandText(call).includes('project paths --json'));
    const kitChecks = f.dockerCalls.filter((call) => commandText(call).includes('check agents'));
    const kitInstalls = f.dockerCalls.filter((call) => commandText(call).includes('kit install'));
    const createWorkspace = f.dockerCalls.find((call) => commandText(call).includes('workspace create'));
    const renamePane = f.dockerCalls.find((call) => commandText(call).includes('pane rename'));
    const prompt = f.dockerCalls.find(hasBossPromptScript);
    assert.ok(verifier && paths && createWorkspace && renamePane && prompt, f.dockerCalls.map(commandText).join('\n'));
    assert.equal(renamePane.args.at(-2), 'ws-boss:p-new');
    assert.ok(verifier.args.includes('hf-demo'));
    assert.ok(paths.args.includes('hf-demo'));
    assert.equal(kitChecks.length, 4);
    assert.equal(kitInstalls.length, 2);
    assert.ok(kitInstalls.some((call) => call.args.includes('/home/factory/herdr-boss')));
    assert.ok(kitInstalls.some((call) => call.args.includes('/home/factory/work/alpha')));
    assert.ok(f.dockerCalls.indexOf(verifier) < f.dockerCalls.indexOf(paths));
    assert.ok(f.dockerCalls.indexOf(paths) < f.dockerCalls.indexOf(kitChecks[0]));
    assert.ok(f.dockerCalls.indexOf(kitChecks.at(-1)) < f.dockerCalls.indexOf(createWorkspace));
    assert.ok(f.dockerCalls.indexOf(createWorkspace) < f.dockerCalls.indexOf(prompt));
    assert.ok(prompt.args.includes('HERDR_BOSS_DIR=/home/factory/.herdr-boss'));
    const promptScript = prompt.args[prompt.args.indexOf('-e') + 1];
    assert.ok(prompt.args.at(-2).includes('herdr-boss project new'));
    assert.ok(promptScript.includes('/home/factory/herdr-boss/src/handoff.js'));
    assert.match(promptScript, /runBossPromptReadiness/);
    assert.doesNotMatch(promptScript, /enterAttempts < 3/);
    assert.doesNotMatch(promptScript, /waitForAgentReady/);
    assert.ok(prompt.args.at(-2).includes('Keep projects, messages, and handover state in this factory.'));
  } finally { f.cleanup(); }
});

test('factory boss start returns the live Boss state without checking login or making a second pane', async () => {
  const f = fixture({
    workspaceRows: [{ workspace_id: 'ws-existing', label: 'Boss' }],
    paneRows: [{ pane_id: 'ws-existing:p1', workspace_id: 'ws-existing', label: 'boss', agent: 'claude', agent_status: 'working' }],
  });
  try {
    assert.equal(await factoryCommand(['boss', 'start', 'demo'], f.io), 0);
    assert.match(f.output.join(''), /Boss is working in pane ws-existing:p1/);
    assert.equal(f.dockerCalls.some(({ args }) => args.includes('auth') && args.at(-1) === 'status'), false);
    assert.equal(f.dockerCalls.some(({ args }) => args.includes('kit') && args.includes('install')), false);
    assert.equal(f.dockerCalls.some(({ args }) => args.includes('workspace') && args.includes('create')), false);
  } finally { f.cleanup(); }
});

test('a second Boss start skips kit installation after the first start makes the Boss live', async () => {
  const f = fixture();
  try {
    assert.equal(await factoryCommand(['boss', 'start', 'demo'], f.io), 0);
    const installsAfterFirstStart = f.dockerCalls.filter(({ args }) => args.includes('kit') && args.includes('install')).length;
    assert.equal(installsAfterFirstStart, 1);
    assert.equal(await factoryCommand(['boss', 'start', 'demo', '--resume'], f.io), 0);
    assert.equal(f.dockerCalls.filter(({ args }) => args.includes('kit') && args.includes('install')).length, installsAfterFirstStart);
  } finally { f.cleanup(); }
});

test('resume on a live idle Boss prints its state and does not start or resend the prompt', async () => {
  const f = fixture({
    workspaceRows: [{ workspace_id: 'ws-existing', label: 'Boss' }],
    paneRows: [{ pane_id: 'ws-existing:p1', workspace_id: 'ws-existing', label: 'boss', agent: 'claude', agent_status: 'idle' }],
  });
  try {
    assert.equal(await factoryCommand(['boss', 'start', 'demo', '--resume'], f.io), 0);
    assert.match(f.output.join(''), /Boss is idle in pane ws-existing:p1/);
    assert.equal(f.dockerCalls.some(hasBossPromptScript), false);
    assert.equal(f.dockerCalls.some(({ args }) => args.includes('auth') && args.at(-1) === 'status'), false);
  } finally { f.cleanup(); }
});

test('resume on a live Boss with another harness prints the state and does not start a prompt', async () => {
  const f = fixture({
    workspaceRows: [{ workspace_id: 'ws-existing', label: 'Boss' }],
    paneRows: [{ pane_id: 'ws-existing:p1', workspace_id: 'ws-existing', label: 'boss', agent: 'codex', agent_status: 'idle' }],
  });
  try {
    assert.equal(await factoryCommand(['boss', 'start', 'demo', '--harness', 'claude', '--resume'], f.io), 0);
    assert.match(f.output.join(''), /Boss is idle in pane ws-existing:p1/);
    assert.equal(f.dockerCalls.some(hasBossPromptScript), false);
  } finally { f.cleanup(); }
});

test('resume does not continue when a prompt marker is present or the prompt is not typed', async () => {
  for (const resumePromptProbe of [
    { promptMarkerPresent: true, promptTyped: true },
    { promptMarkerPresent: false, promptTyped: false },
  ]) {
    const f = fixture({
      workspaceRows: [{ workspace_id: 'ws-existing', label: 'Boss' }],
      paneRows: [{ pane_id: 'ws-existing:p1', workspace_id: 'ws-existing', label: 'boss', agent: 'claude', agent_status: 'idle' }],
      resumePromptProbe,
    });
    try {
      assert.equal(await factoryCommand(['boss', 'start', 'demo', '--resume'], f.io), 0);
      assert.match(f.output.join(''), /Boss is idle in pane ws-existing:p1/);
      assert.equal(f.dockerCalls.some(hasBossPromptScript), false);
    } finally { f.cleanup(); }
  }
});

test('resume probe distinguishes a trailing typed prompt from a submitted prompt', async () => {
  const { inspectBossPromptText } = await import('../src/factory-boss.js');
  const prompt = '[herdr-boss] You are the Boss of this factory. Read the factory guide.';
  const marker = 'You are the Boss of this factory.';
  assert.deepEqual(inspectBossPromptText(`old transcript\n${prompt}`, prompt, marker), {
    promptMarkerPresent: false,
    promptTyped: true,
  });
  assert.deepEqual(inspectBossPromptText(`${prompt}\n? for shortcuts`, prompt, marker), {
    promptMarkerPresent: true,
    promptTyped: false,
  });
});

test('an installed kit is skipped when the Boss starts', async () => {
  const f = fixture({ kitCheckCode: 0 });
  try {
    assert.equal(await factoryCommand(['boss', 'start', 'demo'], f.io), 0);
    assert.equal(f.dockerCalls.some(({ args }) => args.includes('kit') && args.includes('install')), false);
  } finally { f.cleanup(); }
});

test('an existing Boss workspace and pane are reused', async () => {
  const f = fixture({
    workspaceRows: [{ workspace_id: 'ws-existing', label: 'Boss' }],
    paneRows: [{ pane_id: 'ws-existing:p1', workspace_id: 'ws-existing', label: 'boss' }],
    kitCheckCode: 0,
  });
  try {
    assert.equal(await factoryCommand(['boss', 'start', 'demo'], f.io), 0);
    assert.equal(f.dockerCalls.some(({ args }) => args.includes('workspace') && args.includes('create')), false);
    assert.equal(f.dockerCalls.some(({ args }) => args.includes('tab') && args.includes('create')), false);
    assert.equal(f.dockerCalls.some(({ args }) => args.includes('pane') && args.includes('rename')), false);
  } finally { f.cleanup(); }
});

test('an unlabeled pane is never renamed or reused for the Boss', async () => {
  const f = fixture({
    workspaceRows: [{ workspace_id: 'ws-existing', label: 'Boss' }],
    paneRows: [{ pane_id: 'ws-existing:p1', workspace_id: 'ws-existing', label: '' }],
    kitCheckCode: 0,
  });
  try {
    assert.equal(await factoryCommand(['boss', 'start', 'demo'], f.io), 0);
    const commands = f.dockerCalls.map(({ args }) => args);
    assert.equal(commands.some((args) => args.includes('pane') && args.includes('rename') && args.includes('ws-existing:p1')), false);
    assert.ok(commands.some((args) => args.includes('tab') && args.includes('create')));
    assert.ok(commands.some((args) => args.includes('pane') && args.includes('rename') && args.includes('ws-existing:p-new')));
    assert.equal(f.dockerCalls.find(hasBossPromptScript).args.includes('ws-existing:p-new'), true);
  } finally { f.cleanup(); }
});

test('a failure to create a new Boss tab gives a clear error', async () => {
  const f = fixture({
    workspaceRows: [{ workspace_id: 'ws-existing', label: 'Boss' }],
    paneRows: [{ pane_id: 'ws-existing:p1', workspace_id: 'ws-existing', label: 'Work' }],
    tabCreateFailure: true,
    kitCheckCode: 0,
  });
  try {
    await assert.rejects(factoryCommand(['boss', 'start', 'demo'], f.io), /could not create a new Boss tab and pane/);
    assert.equal(f.dockerCalls.some(hasBossPromptScript), false);
  } finally { f.cleanup(); }
});

test('a failure to label the new Boss pane gives a clear error', async () => {
  const f = fixture({
    workspaceRows: [{ workspace_id: 'ws-existing', label: 'Boss' }],
    paneRows: [{ pane_id: 'ws-existing:p1', workspace_id: 'ws-existing', label: 'Work' }],
    paneRenameFailure: true,
    kitCheckCode: 0,
  });
  try {
    await assert.rejects(factoryCommand(['boss', 'start', 'demo'], f.io), /could not label the new Boss pane/);
    assert.equal(f.dockerCalls.some(hasBossPromptScript), false);
  } finally { f.cleanup(); }
});

test('Boss workspace is re-probed before creation', async () => {
  const f = fixture({ workspaceAppearsAfterPaths: true, kitCheckCode: 0 });
  try {
    assert.equal(await factoryCommand(['boss', 'start', 'demo'], f.io), 0);
    const commands = f.dockerCalls.map(({ args }) => args);
    const listIndex = commands.reduce((found, args, index) => args.includes('workspace') && args.at(-1) === 'list' ? index : found, -1);
    assert.ok(listIndex > commands.findIndex((args) => args.includes('project') && args.includes('paths')));
    assert.equal(commands.some((args) => args.includes('workspace') && args.includes('create')), false);
    assert.equal(f.dockerCalls.some(hasBossPromptScript), true);
  } finally { f.cleanup(); }
});

test('a missing harness login waits with one Mailbox item naming the factory login command', async () => {
  const f = fixture({ verifierCode: 1 });
  try {
    assert.equal(await factoryCommand(['boss', 'start', 'demo', '--harness', 'codex'], f.io), 3);
    assert.match(f.output.join(''), /codex login is required/i);
    const mailbox = f.dockerCalls.filter(({ args }) => args.some((value) => typeof value === 'string' && value.includes('openMessageStore')));
    assert.equal(mailbox.length, 1);
    assert.match(mailbox[0].args.at(-1), /herdr-boss factory login demo codex/);
    assert.match(mailbox[0].args.at(-1), /herdr-boss factory boss start demo --resume/);
    assert.doesNotMatch(mailbox[0].args.at(-1), /\btoken\b|\bcode\b|private verifier output/i);
    assert.equal(f.dockerCalls.some(({ args }) => args.includes('kit') && args.includes('install')), false);
  } finally { f.cleanup(); }
});

test('a failed kit install stops before the Herdr and Boss prompt steps', async () => {
  const f = fixture({ kitInstallCode: 1 });
  try {
    await assert.rejects(factoryCommand(['boss', 'start', 'demo'], f.io), /kit could not be installed/);
    assert.equal(f.dockerCalls.some(({ args }) => args.includes('workspace') && args.at(-1) === 'list'), true);
    assert.equal(f.dockerCalls.some(({ args }) => args.includes('workspace') && args.includes('create')), false);
    assert.equal(f.dockerCalls.some(hasBossPromptScript), false);
  } finally { f.cleanup(); }
});

test('a failed Herdr preflight stops before login and kit changes', async () => {
  const f = fixture({ herdrFailure: true });
  try {
    await assert.rejects(factoryCommand(['boss', 'start', 'demo'], f.io), /The Herdr server is not running\. Run factory configure NAME --resume\./);
    assert.equal(f.dockerCalls.some(({ args }) => args.includes('auth') && args.at(-1) === 'status'), false);
    assert.equal(f.dockerCalls.some(({ args }) => args.includes('kit') && args.includes('install')), false);
    assert.equal(f.dockerCalls.some(({ args }) => args.includes('workspace') && args.includes('create')), false);
  } finally { f.cleanup(); }
});

test('a failed Herdr workspace step stops before the Boss prompt', async () => {
  const f = fixture({ workspaceCreateFailure: true });
  try {
    await assert.rejects(factoryCommand(['boss', 'start', 'demo'], f.io), /factory Boss operation failed/);
    assert.equal(f.dockerCalls.some(({ args }) => args.includes('kit') && args.includes('install')), true);
    assert.equal(f.dockerCalls.some(({ args }) => args.includes('workspace') && args.includes('create')), true);
    assert.equal(f.dockerCalls.some(hasBossPromptScript), false);
  } finally { f.cleanup(); }
});

test('a failed Boss start stops with a safe error', async () => {
  const f = fixture({ promptCode: 1 });
  try {
    await assert.rejects(factoryCommand(['boss', 'start', 'demo'], f.io), /Boss could not start/);
    assert.doesNotMatch(f.output.join(''), /private prompt error|token/i);
  } finally { f.cleanup(); }
});

test('a Boss startup dialog names its kind and pane and masks the pane and prompt stderr', async () => {
  const f = fixture({ promptCode: 1,
    paneText: 'Choose the text style\n/home/factory/herdr-boss\nServer: 192.0.2.45 fixture-node demo.localhost\nBearer fixture-bearer\naccess_token=fixture-access',
    promptStderr: 'agent_not_ready: onboarding blocked at /home/factory/.claude.json token=fixture-stderr\nhttps://private.example.test/login',
  });
  try {
    await assert.rejects(factoryCommand(['boss', 'start', 'demo'], f.io), (error) => {
      assert.match(error.message, /theme dialog.*ws-boss:p-new/);
      assert.match(error.message, /Pane text:\nChoose the text style/);
      assert.match(error.message, /Prompt script stderr:\nagent_not_ready: onboarding blocked/);
      assert.doesNotMatch(error.message, /fixture-bearer|fixture-access|fixture-stderr|192\.0\.2\.45|private\.example|\/home\/factory|fixture-node|demo\.localhost/);
      return true;
    });
    const read = f.dockerCalls.find(({ args }) => args.includes('pane') && args.includes('read'));
    assert.ok(read.args.includes('ws-boss:p-new'));
    assert.equal(read.args[read.args.indexOf('--user') + 1], 'factory');
  } finally { f.cleanup(); }
});

test('a failed Boss pane capture still reports masked prompt stderr and an unknown dialog', async () => {
  const f = fixture({ paneReadCode: 1, promptCode: 1, promptStderr: 'agent_not_ready at /home/factory token=fixture-private' });
  try {
    await assert.rejects(factoryCommand(['boss', 'start', 'demo'], f.io), (error) => {
      assert.match(error.message, /unknown dialog in pane ws-boss:p-new/);
      assert.match(error.message, /capture unavailable/);
      assert.match(error.message, /agent_not_ready/);
      assert.doesNotMatch(error.message, /\/home\/factory|fixture-private/);
      return true;
    });
  } finally { f.cleanup(); }
});

test('Boss start succeeds when the detection pane read fails but a plain pane read works', async () => {
  const f = fixture({ detectionReadCode: 1, paneReadCode: 0, paneText: 'Boss prompt answered' });
  try {
    assert.equal(await factoryCommand(['boss', 'start', 'demo'], f.io), 0);
    const reads = f.dockerCalls.filter(({ args }) => args.includes('pane') && args.includes('read'));
    assert.ok(reads.some(({ args }) => args.includes('--source')));
    assert.ok(reads.some(({ args }) => !args.includes('--source')));
  } finally { f.cleanup(); }
});

test('Boss start names a dialog that only the plain pane read shows', async () => {
  const f = fixture({ detectionReadCode: 1, paneText: 'Choose the text style', promptOutcome: 'not-ready' });
  try { await assert.rejects(factoryCommand(['boss', 'start', 'demo'], f.io), /theme dialog in pane ws-boss:p-new/); }
  finally { f.cleanup(); }
});

test('Boss start trusts a ready outcome when no pane read works and shows no dialog', async () => {
  const f = fixture({ paneReadCode: 1, promptOutcome: 'ready' });
  try { assert.equal(await factoryCommand(['boss', 'start', 'demo'], f.io), 0); }
  finally { f.cleanup(); }
});

test('Boss start fails with capture unavailable when no pane read works and the prompt did not reach ready', async () => {
  const f = fixture({ paneReadCode: 1, promptOutcome: 'not-ready' });
  try { await assert.rejects(factoryCommand(['boss', 'start', 'demo'], f.io), /capture unavailable/); }
  finally { f.cleanup(); }
});

test('Boss start names trust, login, update and unknown dialogs even when the script exits zero', async () => {
  for (const [kind, paneText] of [['trust', 'Do you trust this folder?'], ['login', 'Not logged in · Please run /login'],
    ['update', 'Update available. Update now?'], ['unknown', 'Select an option to continue']]) {
    const f = fixture({ paneText, promptOutcome: 'not-ready' });
    try {
      await assert.rejects(factoryCommand(['boss', 'start', 'demo'], f.io), (error) => {
        assert.ok(error.message.includes(`${kind} dialog in pane ws-boss:p-new`));
        assert.ok(error.message.includes(paneText));
        assert.match(error.message, /Prompt script stderr:/);
        return true;
      });
    } finally { f.cleanup(); }
  }
  const f = fixture({ paneText: 'Choose the text style', promptOutcome: 'ready' });
  try { await assert.rejects(factoryCommand(['boss', 'start', 'demo'], f.io), /theme dialog/); }
  finally { f.cleanup(); }
});

test('an existing blocked Boss dialog fails with the pane text instead of reporting success', async () => {
  const f = fixture({ workspaceRows: [{ workspace_id: 'ws-existing', label: 'Boss' }],
    paneRows: [{ pane_id: 'ws-existing:p1', label: 'boss', agent: 'claude', agent_status: 'blocked' }],
    paneText: 'Do you trust this folder? /home/factory/herdr-boss',
  });
  try {
    await assert.rejects(factoryCommand(['boss', 'start', 'demo', '--resume'], f.io), /trust dialog in pane ws-existing:p1/);
    assert.equal(f.dockerCalls.some(hasBossPromptScript), false);
  } finally { f.cleanup(); }
});

test('an unsent Boss prompt exits 3 and posts one Mailbox resume item', async () => {
  const f = fixture({ promptOutcome: 'unsent' });
  try {
    assert.equal(await factoryCommand(['boss', 'start', 'demo'], f.io), 3);
    const mailbox = f.dockerCalls.filter(({ args }) => args.some((value) => typeof value === 'string' && value.includes('openMessageStore')));
    assert.equal(mailbox.length, 1);
    assert.match(mailbox[0].args.at(-1), /factory boss start demo --resume/);
    assert.match(f.output.join(''), /prompt is still unsent/);
  } finally { f.cleanup(); }
});

test('resume retries an unsent prompt in the existing Boss pane without creating another pane', async () => {
  const f = fixture({ promptOutcome: 'unsent' });
  try {
    assert.equal(await factoryCommand(['boss', 'start', 'demo'], f.io), 3);
    const tabCreatesAfterFirstStart = f.dockerCalls.filter(({ args }) => args.includes('tab') && args.includes('create')).length;
    assert.equal(tabCreatesAfterFirstStart, 1);
    assert.equal(await factoryCommand(['boss', 'start', 'demo', '--resume'], f.io), 3);
    const promptStarts = f.dockerCalls.filter(hasBossPromptScript);
    assert.equal(promptStarts.length, 2);
    assert.equal(promptStarts[1].args.at(-1), 'true');
    assert.equal(f.dockerCalls.filter(({ args }) => args.includes('workspace') && args.includes('create')).length, 1);
    assert.equal(f.dockerCalls.filter(({ args }) => args.includes('tab') && args.includes('create')).length, tabCreatesAfterFirstStart);
    assert.match(promptStarts[1].args[promptStarts[1].args.indexOf('-e') + 1], /resumeExisting/);
  } finally { f.cleanup(); }
});

test('prompt readiness retries three Enter presses with 20 second waits and returns unsent', async () => {
  const enters = [];
  const waits = [];
  const herdr = (args) => {
    if (args[0] === 'agent' && args[1] === 'get') return { agent: { agent_status: 'idle' } };
    if (args[0] === 'agent' && args[1] === 'send-keys') enters.push(args);
    return {};
  };
  const { runBossPromptReadiness } = await import('../src/factory-boss.js');
  assert.equal(typeof runBossPromptReadiness, 'function');
  const result = runBossPromptReadiness({
    herdr,
    wait: (ms) => waits.push(ms),
    harness: 'claude',
    readText: () => 'typed: You are the Boss of this factory.',
    isReady: () => false,
    resumeExisting: true,
    promptMarker: 'You are the Boss of this factory.',
  });
  assert.equal(result.outcome, 'unsent');
  assert.equal(result.enterAttempts, 3);
  assert.equal(enters.length, 3);
  assert.deepEqual(waits, [20000, 20000, 20000]);
});

test('prompt readiness sends no prompt or Enter when a startup dialog is visible', async () => {
  const { runBossPromptReadiness } = await import('../src/factory-boss.js');
  const calls = [];
  const result = runBossPromptReadiness({ harness: 'claude', herdr: (args) => calls.push(args),
    readText: () => 'Choose the text style\nYou are the Boss of this factory.', isReady: () => true,
    deliverPrompt: () => calls.push('prompt'), promptMarker: 'You are the Boss of this factory.',
  });
  assert.equal(result.outcome, 'dialog');
  assert.deepEqual(calls, []);
});

test('interactive Docker calls inherit all terminal streams and return no captured text', async () => {
  const calls = [];
  const transport = createDockerTransport({ transport: 'local' }, {
    env: {},
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      setImmediate(() => child.emit('close', 0));
      return child;
    },
  });
  assert.deepEqual(await transport.run(['exec', '-it', 'hf-demo', 'claude', 'auth', 'login'], { interactive: true }),
    { code: 0, stdout: '', stderr: '' });
  assert.equal(calls[0].options.stdio, 'inherit');
});

test('factory boss start sets a neutral Git identity for the factory user when none exists', async () => {
  const f = fixture({ projectPaths: [{ path: '/home/factory/work/alpha' }] });
  try {
    assert.equal(await factoryCommand(['boss', 'start', 'demo'], f.io), 0);
    assert.deepEqual(f.git, { 'user.name': 'Herdr Factory', 'user.email': 'factory@localhost.invalid' });
    const writes = f.dockerCalls.filter(({ args }) => args.includes('git') && !args.includes('--get'));
    for (const { args } of writes) assert.deepEqual(args.slice(0, 5), ['exec', '--user', 'factory', '--env', 'HOME=/home/factory']);
  } finally { f.cleanup(); }
});

test('factory boss start keeps a Git identity that exists', async () => {
  const f = fixture({ gitConfig: { 'user.name': 'Existing Name' }, projectPaths: [{ path: '/home/factory/work/alpha' }] });
  try {
    assert.equal(await factoryCommand(['boss', 'start', 'demo'], f.io), 0);
    assert.deepEqual(f.git, { 'user.name': 'Existing Name', 'user.email': 'factory@localhost.invalid' });
  } finally { f.cleanup(); }
});

test('factory boss prompt sends the Boss notes to ~/work/boss-notes and not to the repository', async () => {
  const f = fixture({ projectPaths: [{ path: '/home/factory/work/alpha' }] });
  try {
    assert.equal(await factoryCommand(['boss', 'start', 'demo'], f.io), 0);
    const call = f.dockerCalls.find(hasBossPromptScript);
    const prompt = call.args.find((word) => word.startsWith('[herdr-boss] You are the Boss of this factory.'));
    assert.match(prompt, /~\/work\/boss-notes\/memory\.md/);
    assert.match(prompt, /not to docs\/orchestration\/memory\.md/);
  } finally { f.cleanup(); }
});
