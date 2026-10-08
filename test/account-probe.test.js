import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE = 'invented-login-value';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'account-probe-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { HOME: home, HERDR_BOSS_DIR: path.join(root, 'data') };
  const auth = [path.join(home, '.local/share/opencode/auth.json'), path.join(home, '.pi/agent/auth.json')];
  function write(file, value, mode = 0o600) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode });
    fs.chmodSync(file, mode);
  }
  for (const file of auth) write(file, { 'opencode-go': { type: PRIVATE, key: PRIVATE } });
  const out = [], err = [], waits = [];
  const options = { cwd: project, listProcesses: () => ({ verified: 'yes', pids: [] }), wait: async (ms) => { waits.push(ms); } };
  const io = { env, stdin: { isTTY: true }, stdout: { isTTY: true, write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) }, probeOptions: options };
  return { root, home, project, env, auth, write, out, err, waits, options, io, text: () => out.join(''), report: () => JSON.parse(out.join('')) };
}

test('CLI account probe refuses non-TTY before configuration migration or login reads', (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, ['src/cli.js', 'account', 'probe'], { cwd: ROOT, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TTYs on stdin and stdout/);
  assert.equal(result.stdout, '');
  assert.equal(fs.existsSync(f.env.HERDR_BOSS_DIR), false);
  assert.equal(`${result.stdout}${result.stderr}`.includes(PRIVATE), false);
});

test('Owner probe reports login shape, modes and names without any values', async (t) => {
  const { accountProbeCommand } = await import('../src/account-probe.js');
  const f = fixture(t);
  f.write(f.auth[1], { 'opencode-go': { type: 'api', key: PRIVATE, accountId: PRIVATE, user: { email: PRIVATE }, other: 12, absent: null } }, 0o640);
  Object.assign(f.env, { OPENCODE_TEST: PRIVATE, TEST_API_KEY: PRIVATE, PI_TEST: PRIVATE, XDG_DATA_HOME: PRIVATE });
  assert.equal(await accountProbeCommand(['probe'], f.io), 0);
  const report = f.report();
  assert.deepEqual(report.loginFiles[0], {
    path: f.auth[0], exists: 'yes', mode: '0600', ownerOnly: 'yes', readable: 'yes', validJson: 'yes', objectRoot: 'yes',
    topLevelKeys: ['opencode-go'], entries: [{ name: 'opencode-go', object: 'yes', keys: [{ name: 'key', string: 'yes', object: 'no' }, { name: 'type', string: 'yes', object: 'no' }], candidateIdentityKeys: [] }],
  });
  assert.equal(report.loginFiles[1].ownerOnly, 'no');
  assert.equal(report.loginFiles[1].mode, '0640');
  assert.deepEqual(report.loginFiles[1].entries[0].candidateIdentityKeys, ['accountId', 'user']);
  assert.deepEqual(report.loginFiles[1].entries[0].keys.find(({ name }) => name === 'user'), { name: 'user', string: 'no', object: 'yes' });
  assert.deepEqual(report.loginFiles[1].entries[0].keys.find(({ name }) => name === 'absent'), { name: 'absent', string: 'no', object: 'no' });
  for (const name of ['OPENCODE_TEST', 'TEST_API_KEY', 'PI_TEST', 'XDG_DATA_HOME']) assert.ok(report.environment.some((item) => item.name === name && item.status === 'set'));
  assert.ok(report.environment.some((item) => item.name === 'OPENCODE_API_KEY' && item.status === 'unset'));
  assert.equal(f.text().includes(PRIVATE), false);
  assert.deepEqual(f.waits, []);
});

test('probe lists other pi files by metadata only and finds nested JSON and JSONC overrides', async (t) => {
  const { accountProbeCommand } = await import('../src/account-probe.js');
  const f = fixture(t);
  const piOther = path.join(f.home, '.pi/agent/login-backup.json');
  f.write(piOther, `not JSON: ${PRIVATE}`, 0o644);
  f.write(path.join(f.home, '.config/opencode/opencode.json'), { provider: { example: { options: { apiKey: PRIVATE } } } });
  f.write(path.join(f.project, 'opencode.jsonc'), `{
    // "apiKey": "comment only"
    "text": "escaped \\\"apiKey\\\" and https://example.invalid/",
    "provider": {"api_key": "${PRIVATE}",},
  }`);
  f.write(path.join(f.home, '.pi/agent/settings.json'), { nested: [{ api_key: PRIVATE }] });
  f.write(path.join(f.home, '.pi/agent/models.json'), { note: 'apiKey' });
  const originalRead = fs.readFileSync;
  const reads = [];
  f.options.filesystem = { ...fs, readFileSync(file, ...args) { reads.push(file); return originalRead(file, ...args); } };
  assert.equal(await accountProbeCommand(['probe'], f.io), 0);
  const report = f.report();
  assert.ok(report.otherPiFiles.files.some((row) => row.path === piOther && row.mode === '0644'));
  assert.equal(reads.includes(piOther), false);
  assert.deepEqual(report.configurationFiles.find((row) => row.path === path.join(f.project, 'opencode.jsonc')).apiKeyFields, ['api_key']);
  assert.deepEqual(report.configurationFiles.find((row) => row.path === path.join(f.home, '.pi/agent/models.json')).apiKeyFields, []);
  assert.equal(report.configurationFiles.filter((row) => row.apiKeyFields.length > 0).length, 3);
  assert.equal(f.text().includes(PRIVATE), false);
});

test('malformed, missing, non-object and unreadable login files produce no raw diagnostics', async (t) => {
  const { accountProbeCommand } = await import('../src/account-probe.js');
  const f = fixture(t);
  f.write(f.auth[0], `{"bad": ${PRIVATE}`);
  f.write(f.auth[1], ['fake']);
  assert.equal(await accountProbeCommand(['probe'], f.io), 0);
  assert.equal(f.report().loginFiles[0].validJson, 'no');
  assert.equal(f.report().loginFiles[1].objectRoot, 'no');
  assert.equal(f.text().includes(PRIVATE), false);
  f.out.length = 0;
  fs.rmSync(f.auth[0]);
  f.options.filesystem = { ...fs, readFileSync() { throw new Error(PRIVATE); } };
  assert.equal(await accountProbeCommand(['probe'], f.io), 0);
  assert.equal(f.report().loginFiles[0].exists, 'no');
  assert.equal(f.report().loginFiles[1].readable, 'no');
  assert.equal(f.text().includes(PRIVATE), false);
});

test('pane variables, including empty and nonstandard pane variables, refuse before all probe work', async (t) => {
  const { accountProbeCommand } = await import('../src/account-probe.js');
  const { standaloneAccountProbe } = await import('../scripts/account-probe.mjs');
  const f = fixture(t);
  f.options.filesystem = new Proxy({}, { get() { throw new Error('No filesystem access is allowed'); } });
  f.io.herdr = () => { throw new Error(PRIVATE); };
  for (const [name, value] of [['HERDR_ENV', '1'], ['HERDR_ENV', '0'], ['HERDR_ENV', ''], ['HERDR_PANE_ID', 'worker'], ['HERDR_PANE', ''], ['HERDR_PANE_LABEL', 'orch'], ['HERDR_WORKSPACE_ID', 'w1'], ['HERDR_WORKTREE', f.root]]) {
    f.io.env = { ...f.env, [name]: value };
    for (const invoke of [() => accountProbeCommand(['probe'], f.io), () => standaloneAccountProbe([], f.io)]) {
      assert.equal(await invoke(), 3, name);
      assert.equal(f.text(), '');
      assert.equal(f.err.join('').includes(PRIVATE), false);
    }
  }
});

test('verified Boss caller also refuses without reading login files', async (t) => {
  const { accountProbeCommand } = await import('../src/account-probe.js');
  const f = fixture(t);
  Object.assign(f.env, { HERDR_ENV: '1', HERDR_PANE_ID: 'boss-pane', HERDR_WORKSPACE_ID: 'boss-space' });
  let calls = 0;
  f.io.herdr = (args) => { calls += 1; assert.deepEqual(args, ['pane', 'get', 'boss-pane']); return { pane: { id: 'boss-pane', workspace: 'boss-space', label: 'boss' } }; };
  f.options.filesystem = new Proxy({}, { get() { throw new Error('No filesystem access is allowed'); } });
  assert.equal(await accountProbeCommand(['probe'], f.io), 3);
  assert.equal(calls, 1);
  assert.equal(f.text(), '');
});

test('both entry points reject options and missing TTYs without probes', async (t) => {
  const { accountProbeCommand } = await import('../src/account-probe.js');
  const { standaloneAccountProbe } = await import('../scripts/account-probe.mjs');
  const f = fixture(t);
  f.options.filesystem = new Proxy({}, { get() { throw new Error('No filesystem access is allowed'); } });
  for (const args of [[], ['list'], ['probe', '--json'], ['probe', PRIVATE]]) assert.equal(await accountProbeCommand(args, f.io), 1);
  assert.equal(await standaloneAccountProbe([PRIVATE], f.io), 1);
  for (const stream of ['stdin', 'stdout']) {
    f.io[stream].isTTY = false;
    assert.equal(await accountProbeCommand(['probe'], f.io), 1);
    assert.equal(await standaloneAccountProbe([], f.io), 1);
    f.io[stream].isTTY = true;
  }
  assert.equal(f.text(), '');
  assert.equal(f.err.join('').includes(PRIVATE), false);
});

test('passive check waits 10 seconds without reads or writes and never infers re-read from unchanged atime', async (t) => {
  const { accountProbeCommand } = await import('../src/account-probe.js');
  const f = fixture(t);
  let waited = false;
  let snapshots = 0;
  f.options.listProcesses = (tool) => ({ verified: 'yes', pids: tool === 'opencode' ? [42] : [] });
  f.options.filesystem = { ...fs,
    readFileSync(file, ...args) { assert.equal(waited, false, 'no reads after baseline'); return fs.readFileSync(file, ...args); },
    statSync(file) { const stat = fs.statSync(file); snapshots += 1; return { ...stat, atimeMs: 1000, mtimeMs: 2000 }; },
  };
  f.options.wait = async (ms) => { assert.equal(ms, 10000); waited = true; assert.ok(snapshots >= 2); };
  assert.equal(await accountProbeCommand(['probe'], f.io), 0);
  assert.equal(reportValue(f, 'performed'), 'yes');
  for (const row of f.report().passiveCheck.files) {
    assert.equal(row.atimeChanged, 'no');
    assert.equal(row.mtimeChanged, 'no');
    assert.equal(row.reRead, 'unverified');
    assert.equal(row.conclusion, 'cannot tell');
  }
  assert.equal(f.report().passiveCheck.rotationWaitsForProcesses, 'yes');
  assert.deepEqual(f.report().processes[0], { tool: 'opencode', count: 1, pids: [42], verified: 'yes' });
});

function reportValue(f, key) { return f.report().passiveCheck[key]; }

test('atime change reports observed access only, and mtime or process changes remain unverified', async (t) => {
  const { accountProbeCommand } = await import('../src/account-probe.js');
  const f = fixture(t);
  let waited = false;
  f.options.listProcesses = () => ({ verified: 'yes', pids: waited ? [] : [42] });
  f.options.filesystem = { ...fs, statSync(file) { return { ...fs.statSync(file), atimeMs: waited ? 3000 : 1000, mtimeMs: waited ? 4000 : 2000 }; } };
  f.options.wait = async () => { waited = true; };
  assert.equal(await accountProbeCommand(['probe'], f.io), 0);
  for (const row of f.report().passiveCheck.files) {
    assert.equal(row.atimeChanged, 'yes');
    assert.equal(row.mtimeChanged, 'yes');
    assert.equal(row.reRead, 'unverified');
  }
  assert.equal(f.report().passiveCheck.processesStillRunning, 'no');
});

test('process reader uses names and current-user PIDs only, and discards raw diagnostics', async () => {
  const { listToolProcesses } = await import('../scripts/account-probe.mjs');
  const calls = [];
  assert.deepEqual(listToolProcesses('pi', { uid: 501, run(file, args, options) { calls.push({ file, args, options }); return { status: 0, stdout: args.includes('-l') ? '13 pi\n11 pi\n13 pi\n' : '13\n11\n', stderr: PRIVATE }; } }), { verified: 'yes', pids: [11, 13] });
  assert.equal(calls[0].file, 'pgrep');
  assert.deepEqual(calls[0].args, ['-l', '-u', '501', '-x', 'pi']);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].options.env, { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
  assert.deepEqual(listToolProcesses('opencode', { run: () => ({ status: 1, stdout: '', stderr: PRIVATE }) }), { verified: 'yes', pids: [] });
  assert.deepEqual(listToolProcesses('pi', { run: () => { throw new Error(PRIVATE); } }), { verified: 'no', pids: [] });
});

test('process discovery also matches Node tool launchers with PID-only pgrep output', async () => {
  const { listToolProcesses } = await import('../scripts/account-probe.mjs');
  const calls = [];
  const result = listToolProcesses('pi', { uid: 501, run(file, args, options) {
    calls.push({ file, args, options });
    return args.includes('-l') ? { status: 0, stdout: '11 pi\n', stderr: '' } : { status: 0, stdout: '11\n23\n', stderr: PRIVATE };
  } });
  assert.deepEqual(result, { verified: 'yes', pids: [11, 23] });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].file, 'pgrep');
  assert.deepEqual(calls[1].args.slice(0, 3), ['-u', '501', '-f']);
  assert.equal(calls[1].args.includes('-l'), false, 'never combine full-command matching with name output');
  assert.match(calls[1].args[3], /pi-coding-agent/);
  const launcher = new RegExp(calls[1].args[3].replaceAll('[:space:]', '\\s'));
  for (const command of ['pi --print', '/tools/node /tools/pi --print', 'node /tools/node_modules/@earendil-works/pi-coding-agent/dist/cli.js --print', 'node --no-warnings /tools/node_modules/@mariozechner/pi-coding-agent/dist/cli.js']) assert.equal(launcher.test(command), true, command);
  for (const command of ['codex --prompt pi', 'node /tools/worker.js pi', '/tools/pipeline --print']) assert.equal(launcher.test(command), false, command);
  assert.equal(JSON.stringify(calls).includes(PRIVATE), false);
});

test('a failed launcher check retains known running PIDs and marks the discovery unverified', async () => {
  const { listToolProcesses } = await import('../scripts/account-probe.mjs');
  const result = listToolProcesses('opencode', { run(file, args) {
    if (args.includes('-l')) return { status: 0, stdout: '42 opencode\n', stderr: '' };
    throw new Error(PRIVATE);
  } });
  assert.deepEqual(result, { verified: 'no', pids: [42] });
});

test('standalone copy runs with no repository dependencies and produces the same Owner report', async (t) => {
  const { accountProbeCommand } = await import('../src/account-probe.js');
  const { standaloneAccountProbe } = await import('../scripts/account-probe.mjs');
  const f = fixture(t);
  assert.equal(await accountProbeCommand(['probe'], f.io), 0);
  const expected = f.text();
  f.out.length = 0;
  assert.equal(await standaloneAccountProbe([], f.io), 0);
  assert.equal(f.text(), expected);
  const copy = path.join(f.root, 'probe.mjs');
  fs.copyFileSync(path.join(ROOT, 'scripts/account-probe.mjs'), copy);
  const result = spawnSync(process.execPath, [copy], { env: { ...f.env, HERDR_ENV: '1' }, encoding: 'utf8' });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /Owner terminal/);
  assert.equal(result.stdout, '');
});

test('real CLI route and an isolated standalone copy produce identical successful fixture reports', (t) => {
  const f = fixture(t);
  const copy = path.join(f.root, 'probe.mjs');
  fs.copyFileSync(path.join(ROOT, 'scripts/account-probe.mjs'), copy);
  const invoke = (file, args) => {
    // Set the terminal flags in this child only. Stub the OS process reader so no live tool state is used.
    const code = `import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { pathToFileURL } from 'node:url';
      cp.spawnSync = () => ({ status: 1, stdout: '', stderr: '' });
      syncBuiltinESMExports();
      process.stdin.isTTY = true;
      process.stdout.isTTY = true;
      process.argv = [process.execPath, ...${JSON.stringify([file, ...args])}];
      await import(pathToFileURL(process.argv[1]));`;
    return spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: f.project, env: f.env, encoding: 'utf8' });
  };
  const cli = invoke(path.join(ROOT, 'src/cli.js'), ['account', 'probe']);
  const standalone = invoke(copy, []);
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(standalone.status, 0, standalone.stderr);
  assert.equal(cli.stdout, standalone.stdout);
  assert.equal(cli.stderr, '');
  assert.equal(standalone.stderr, '');
  assert.equal(cli.stdout.includes(PRIVATE), false);
  assert.equal(JSON.parse(cli.stdout).loginFiles.length, 2);
  assert.equal(fs.existsSync(f.env.HERDR_BOSS_DIR), false);
});

test('symbolic links, oversized files and a failed passive wait never disclose diagnostics', async (t) => {
  const { accountProbeCommand } = await import('../src/account-probe.js');
  const f = fixture(t);
  fs.rmSync(f.auth[0]);
  fs.symlinkSync(f.auth[1], f.auth[0]);
  f.write(f.auth[1], ' '.repeat(1024 * 1024 + 1));
  f.options.filesystem = { ...fs, readFileSync() { throw new Error('No content read is allowed'); } };
  assert.equal(await accountProbeCommand(['probe'], f.io), 0);
  for (const row of f.report().loginFiles) assert.equal(row.readable, 'no');
  f.out.length = 0;
  f.options.listProcesses = () => ({ verified: 'yes', pids: [42] });
  f.options.wait = async () => { throw new Error(PRIVATE); };
  assert.equal(await accountProbeCommand(['probe'], f.io), 1);
  assert.equal(f.text(), '');
  assert.equal(f.err.join('').includes(PRIVATE), false);
  assert.match(f.err.join(''), /did not finish/);
});

test('probe keeps login bytes, modes and modification times unchanged and writes no data directory', async (t) => {
  const { accountProbeCommand } = await import('../src/account-probe.js');
  const f = fixture(t);
  const before = f.auth.map((file) => ({ bytes: fs.readFileSync(file), mode: fs.statSync(file).mode, mtime: fs.statSync(file).mtimeMs }));
  assert.equal(await accountProbeCommand(['probe'], f.io), 0);
  f.auth.forEach((file, index) => {
    assert.deepEqual(fs.readFileSync(file), before[index].bytes);
    assert.equal(fs.statSync(file).mode, before[index].mode);
    assert.equal(fs.statSync(file).mtimeMs, before[index].mtime);
  });
  assert.equal(fs.existsSync(f.env.HERDR_BOSS_DIR), false);
});
