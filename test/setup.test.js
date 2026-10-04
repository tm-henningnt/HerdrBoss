import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import { runDoctor } from '../src/doctor.js';
import { SETUP_STEPS, readSetupState, runSetup, setupCommand } from '../src/setup.js';
import { hasSetupProject } from '../src/setup-actions.js';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-unit-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dataDir = path.join(home, 'data');
  const values = {
    os: 'darwin', node: 'v26.10.0', git: 'git version 2.50.0', 'git-name': 'Invented Owner',
    herdr: '1.0', 'claude-installed': '2.0', 'claude-signed-in': '{"loggedIn":true}',
    'codex-installed': '1.0', 'codex-signed-in': 'Logged in using ChatGPT',
    'opencode-installed': '1.0', 'opencode-signed-in': '1 credentials',
    'pi-installed': '1.0', 'pi-signed-in': 'provider model\nanthropic claude',
    gh: 'gh version 2.0', codexbar: '1.0', service: 'state = running', 'data-folder': true,
    'claude-settings': JSON.stringify({ autoMode: {
      environment: ['### Herdr Boss orchestration', '**Supervisor**', '**Messages from the supervisor**', '**Herdr Boss projects**', '**Owner decisions**'],
      allow: ['$defaults', 'A Herdr Boss orchestrator pushes', 'A Herdr Boss orchestrator removes', 'A Herdr Boss orchestrator or the Boss records', 'The HerdrBoss orchestrator and its workers edit'],
    } }),
    'codex-settings': `[sandbox_workspace_write]\nwritable_roots = ${JSON.stringify([path.join(home, '.herdr-boss'), path.join(home, 'Projects/.herdr-wt')])}`,
    'codex-rules': ['ps:e', 'ps:-E', 'ps:eww', 'ps:auxe', 'ps:auxeww', 'pkill', 'killall'].map((rule) => `prefix_rule(pattern=${JSON.stringify(rule.split(':'))}, decision="forbidden")`).join('\n'),
    'opencode-settings': '{"agent":{"worker":{}}}',
    disk: { bavail: 20 * 1024 ** 3, bsize: 1 }, memory: 16 * 1024 ** 3,
    'usage-reading': '[{"provider":"claude","usage":{"primary":{"usedPercent":10}}}]',
    'service-answers': { status: 200, body: { schema: 1, contractVersion: '1.0.0', version: '0.1.0', kitRevision: 'abcdef123456' } },
  };
  const requests = [];
  const lines = [];
  const commands = [];
  const options = {
    home, dataDir, env: { HOME: home, HERDR_BOSS_DIR: dataDir },
    runner: async ({ id }) => { requests.push(id); return values[id]; },
    output: (line) => lines.push(line), ask: async () => null,
    execute: async (command, args) => commands.push([command, args]),
  };
  function project() {
    const repo = path.join(home, 'InventedProject');
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig') } });
    fs.mkdirSync(path.join(dataDir, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'project-repos.json'), JSON.stringify([{ slug: 'invented', repo }]));
    fs.writeFileSync(path.join(dataDir, 'projects/invented.json'), '{"slug":"invented"}');
  }
  return { home, dataDir, values, requests, lines, commands, options, project };
}

test('setup step IDs and names match the shared onboarding table', () => {
  const text = fs.readFileSync(new URL('../docs/onboarding.md', import.meta.url), 'utf8');
  const steps = [...text.matchAll(/^\| \d+ \| ([^|]+) \| `([^`]+)` \|/gm)].map(([, name, id]) => ({ id, name: name.trim() }));
  assert.deepEqual(SETUP_STEPS, steps);
});

test('doctor checks only the requested shared step and selects the right installer fixes', async (t) => {
  const f = fixture(t);
  f.values.node = '';
  const report = await runDoctor({ ...f.options, stepId: 'tools' });
  assert.ok(report.items.every((item) => item.stepId === 'tools'));
  assert.match(report.items.find((item) => item.id === 'node').fix, /brew install node/);
  for (const forbidden of ['claude-signed-in', 'claude-settings', 'service', 'usage-reading', 'service-answers', 'disk']) assert.ok(!f.requests.includes(forbidden));
});

test('resume uses live checks and proceeds from sign-in to protected settings without a login or edit', async (t) => {
  const f = fixture(t);
  f.values['claude-signed-in'] = '{"loggedIn":false,"token":"invented-secret"}';
  assert.equal(await setupCommand([], f.options), 3);
  assert.equal(readSetupState(f.dataDir).steps.signin.status, 'waiting');
  assert.ok(!f.requests.includes('claude-settings'));
  assert.match(f.lines.join('\n'), /claude auth login/);
  f.values['claude-signed-in'] = '{"loggedIn":true}';
  f.values['claude-settings'] = '{}';
  const result = await runSetup({ ...f.options, resume: true });
  assert.equal(result.waitingStep, 'settings');
  assert.equal(readSetupState(f.dataDir).steps.signin.status, 'done');
  assert.deepEqual(f.commands, []);
  assert.ok(!f.lines.join('\n').includes('invented-secret'));
  assert.ok(!fs.readFileSync(path.join(f.dataDir, 'setup.json'), 'utf8').includes('invented-secret'));
});

test('setup prints a fixed install command before consent and checks it again after execution', async (t) => {
  const f = fixture(t);
  f.values.node = '';
  f.values['claude-signed-in'] = '{}';
  const result = await runSetup({ ...f.options,
    ask: async () => { assert.match(f.lines.at(-1), /^Command: brew install node$/); return 'yes'; },
    execute: async (command, args) => { f.commands.push([command, args]); f.values.node = 'v26.10.0'; },
  });
  assert.equal(result.waitingStep, 'signin');
  assert.deepEqual(f.commands, [['brew', ['install', 'node']]]);
  assert.equal(f.requests.filter((id) => id === 'node').length, 2);
  assert.equal(readSetupState(f.dataDir).steps.tools.status, 'done');
});

test('a command that exits without fixing the check leaves the step waiting', async (t) => {
  const f = fixture(t);
  f.values.node = '';
  const result = await runSetup({ ...f.options, ask: async () => 'yes' });
  assert.equal(result.exitCode, 3);
  assert.equal(result.waitingStep, 'tools');
  assert.equal(readSetupState(f.dataDir).steps.tools.status, 'waiting');
  assert.ok(!f.requests.includes('claude-signed-in'));
});

test('a refused install exits 1 without executing, and an unavailable terminal waits with exit 3', async (t) => {
  const f = fixture(t);
  f.values.node = '';
  assert.equal((await runSetup({ ...f.options, ask: async () => 'no' })).exitCode, 1);
  assert.deepEqual(f.commands, []);
  assert.equal((await runSetup({ ...f.options, resume: true })).exitCode, 3);
  assert.deepEqual(f.commands, []);
});

test('service install needs consent and a fresh service check before pacing starts', async (t) => {
  const f = fixture(t);
  f.values.service = 'state = stopped';
  assert.equal((await runSetup(f.options)).waitingStep, 'service');
  assert.deepEqual(f.commands, []);
  const result = await runSetup({ ...f.options, resume: true,
    ask: async (question) => {
      if (question.startsWith('Choose')) return null;
      assert.equal(f.lines.at(-1), 'Command: bin/herdr-boss install');
      return 'yes';
    },
    execute: async (command, args) => { f.commands.push([command, args]); f.values.service = 'state = running'; },
  });
  // A pacing prompt is reached only after the service passes. Leave it pending.
  assert.equal(result.exitCode, 3);
  assert.equal(result.waitingStep, 'pacing');
  assert.equal(readSetupState(f.dataDir).steps.service.status, 'done');
  assert.equal(f.commands.length, 1);
  assert.equal(f.commands[0][0], process.execPath);
  assert.equal(path.basename(f.commands[0][1][0]), 'cli.js');
  assert.equal(f.commands[0][1][1], 'install');
});

test('missing usage reading cannot save a pacing choice, and an unsupported OS is refused', async (t) => {
  const f = fixture(t);
  f.values['usage-reading'] = '[]';
  assert.equal((await runSetup({ ...f.options, pacing: 'unpaced' })).waitingStep, 'pacing');
  assert.equal(fs.existsSync(path.join(f.dataDir, 'policy.json')), false);
  f.values.os = 'win32';
  assert.equal((await runSetup(f.options)).exitCode, 1);
  assert.deepEqual(f.commands, []);
});

test('setup rejects worker panes before writing progress', async (t) => {
  const f = fixture(t);
  await assert.rejects(setupCommand([], { ...f.options, env: { ...f.options.env, HERDR_ENV: '1', HERDR_PANE_ID: 'worker-pane' }, herdr: () => { throw new Error('unverified caller'); } }), /Setup is refused in this pane/);
  assert.equal(fs.existsSync(f.dataDir), false);
  assert.deepEqual(f.requests, []);
});

test('setup refuses a data folder inside the private access folder, including an alias', async (t) => {
  const f = fixture(t);
  const privateDir = path.join(f.home, '.config/herdr-boss');
  fs.mkdirSync(privateDir, { recursive: true });
  const alias = path.join(f.home, 'alias');
  fs.symlinkSync(privateDir, alias);
  for (const dataDir of [privateDir, path.join(privateDir, 'nested'), alias]) {
    await assert.rejects(setupCommand([], { ...f.options, dataDir }), /Setup cannot read or write its local files/);
    assert.deepEqual(fs.readdirSync(privateDir), []);
  }
});

test('dry run reads no probes, asks no questions, executes nothing, and keeps existing progress byte for byte', async (t) => {
  const f = fixture(t);
  f.values['claude-signed-in'] = '{}';
  await runSetup(f.options);
  const file = path.join(f.dataDir, 'setup.json');
  const before = fs.readFileSync(file);
  const mtime = fs.statSync(file).mtimeMs;
  const fail = () => { throw new Error('dry run attempted an action'); };
  assert.equal(await setupCommand(['--resume', '--dry-run', '--pacing', 'unpaced'], { ...f.options, runner: fail, ask: fail, execute: fail }), 0);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
});

test('finished setup saves pacing, verifies every step, and resumes without repeating actions', async (t) => {
  const f = fixture(t);
  f.project();
  fs.writeFileSync(path.join(f.dataDir, 'policy.json'), JSON.stringify({ providerModes: { codex: 'ignore', claude: 'managed' }, reservePercent: 21 }));
  const options = { ...f.options, pacing: 'unpaced', ask: async () => 'yes' };
  assert.equal((await runSetup(options)).exitCode, 0);
  const state = readSetupState(f.dataDir);
  assert.equal(state.revision, SETUP_STEPS.length);
  assert.ok(Object.values(state.steps).every((step) => step.status === 'done'));
  const policy = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'policy.json')));
  assert.equal(policy.providerModes.claude, 'ignore');
  assert.equal(policy.providerModes.codex, 'ignore');
  assert.equal(policy.reservePercent, 21);
  assert.deepEqual(f.commands.map(([command]) => command), ['open']);
  f.commands.length = 0;
  assert.equal((await runSetup({ ...options, resume: true, ask: () => { throw new Error('do not ask again'); } })).exitCode, 0);
  assert.equal(readSetupState(f.dataDir).revision, state.revision + SETUP_STEPS.length);
  assert.deepEqual(f.commands, []);
  f.values.disk = { bavail: 0, bsize: 1 };
  assert.equal((await runSetup({ ...options, resume: true })).waitingStep, 'check');
  assert.equal(readSetupState(f.dataDir).steps.review.status, 'pending');
});

test('pacing, project, dashboard and the two Owner confirmations each stop and resume', async (t) => {
  const f = fixture(t);
  assert.equal((await runSetup(f.options)).waitingStep, 'pacing');
  assert.equal(fs.existsSync(path.join(f.dataDir, 'policy.json')), false);
  assert.equal((await runSetup({ ...f.options, resume: true, pacing: 'paced' })).waitingStep, 'project');
  assert.match(f.lines.join('\n'), /project new <slug> --group <folder> --start/);
  f.project();
  f.values['service-answers'].status = 503;
  assert.equal((await runSetup({ ...f.options, resume: true })).waitingStep, 'dashboard');
  assert.deepEqual(f.commands, []);
  f.values['service-answers'].status = 200;
  assert.equal((await runSetup({ ...f.options, resume: true })).waitingStep, 'answer');
  let asks = 0;
  assert.equal((await runSetup({ ...f.options, resume: true, ask: async () => asks++ === 0 ? 'yes' : null })).waitingStep, 'review');
  assert.equal((await runSetup({ ...f.options, resume: true, ask: async () => 'yes' })).exitCode, 0);
});

test('step failures and hostile saved fields cannot disclose secrets or execute a saved command', async (t) => {
  const f = fixture(t);
  f.values.node = '';
  const unsafe = `${f.home}/private-file invented-token`;
  assert.equal((await runSetup({ ...f.options, ask: async () => 'yes', execute: () => { throw new Error(unsafe); } })).exitCode, 1);
  const file = path.join(f.dataDir, 'setup.json');
  const state = JSON.parse(fs.readFileSync(file));
  state.command = unsafe;
  state.steps.tools.detail = unsafe;
  fs.writeFileSync(file, JSON.stringify(state));
  await runSetup({ ...f.options, resume: true });
  assert.ok(!fs.readFileSync(file, 'utf8').includes(unsafe));
  assert.ok(!f.lines.join('\n').includes(unsafe));
  assert.deepEqual(f.commands, []);
  fs.writeFileSync(file, '{invalid');
  assert.equal(await setupCommand(['--resume'], f.options), 3);
  assert.equal(readSetupState(f.dataDir).revision, 3);
});

test('F1 setup refuses escaping progress, policy and policy-log destinations before probes or actions', async (t) => {
  for (const name of ['setup.json', 'policy.json', 'policy-changes.jsonl']) {
    await t.test(name, async (t) => {
      const f = fixture(t);
      f.project();
      const sentinel = path.join(f.home, 'outside-sentinel');
      const bytes = name === 'setup.json' ? '{"schema":"herdr-boss.setup/1","steps":{}}\n' : '{}\n';
      fs.writeFileSync(sentinel, bytes, { mode: 0o644 });
      fs.symlinkSync(sentinel, path.join(f.dataDir, name));
      const code = await setupCommand(['--pacing', 'paced'], { ...f.options, ask: async () => 'yes' }).catch(() => 1);
      assert.equal(fs.readFileSync(sentinel, 'utf8'), bytes, 'outside bytes stay intact');
      assert.equal(fs.statSync(sentinel).mode & 0o777, 0o644, 'outside mode stays intact');
      assert.equal(code, 1);
      assert.deepEqual(f.requests, [], 'refuse before reading progress or checking tools');
      assert.deepEqual(f.commands, []);
    });
  }
});

test('setup revisions refuse an older overlapping run without erasing newer progress', async (t) => {
  const f = fixture(t);
  f.project();
  let enter;
  const entered = new Promise((resolve) => { enter = resolve; });
  let release;
  const consent = new Promise((resolve) => { release = resolve; });
  const olderLines = [];
  const first = runSetup({ ...f.options, output: (line) => olderLines.push(line), runner: async ({ id }) => id === 'node' ? '' : f.values[id], ask: async () => { enter(); return consent; } });
  await entered;
  let newerProgress;
  let olderResult;
  try {
    const olderRevision = readSetupState(f.dataDir).revision;
    const alias = path.join(f.home, 'data-alias');
    fs.symlinkSync(f.dataDir, alias);
    const second = await runSetup({ ...f.options, dataDir: alias, pacing: 'unpaced', ask: async () => 'yes' });
    assert.equal(second.exitCode, 0);
    const newer = readSetupState(f.dataDir);
    assert.ok(newer.revision > olderRevision);
    assert.ok(Object.values(newer.steps).every((step) => step.status === 'done'));
    assert.equal(newer.pacing, 'unpaced');
    newerProgress = fs.readFileSync(path.join(f.dataDir, 'setup.json'));
  } finally { release('no'); olderResult = await first; }
  assert.equal(olderResult.exitCode, 1);
  assert.equal(olderLines.at(-1), 'Another setup run changed the progress. Run setup --resume.');
  assert.equal(olderLines.filter((line) => line === 'Another setup run changed the progress. Run setup --resume.').length, 1);
  assert.deepEqual(fs.readFileSync(path.join(f.dataDir, 'setup.json')), newerProgress);
});

test('setup crash leaves saved progress and no setup lock to clean up', async (t) => {
  const f = fixture(t);
  f.project();
  const source = `import { runSetup } from ${JSON.stringify(new URL('../src/setup.js', import.meta.url).href)};
    const values = ${JSON.stringify({ ...f.values, node: '' })};
    await runSetup({ home: ${JSON.stringify(f.home)}, dataDir: ${JSON.stringify(f.dataDir)},
      env: ${JSON.stringify(f.options.env)}, runner: async ({ id }) => values[id],
      output: () => {}, ask: async () => process.exit(23) });
    throw new Error('Fixture did not reach the prompt');`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-'], {
    input: source, encoding: 'utf8', env: { ...process.env, ...f.options.env },
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 23, child.stderr);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'setup.lock')), false);
  const before = readSetupState(f.dataDir).revision;
  assert.ok(before > 0);
  assert.equal((await runSetup({ ...f.options, resume: true, pacing: 'paced', ask: async () => 'yes' })).exitCode, 0);
  assert.equal(readSetupState(f.dataDir).revision, before + SETUP_STEPS.length);
});

test('F1 setup revalidates destinations after a terminal prompt yields', async (t) => {
  for (const name of ['setup.json', 'policy.json', 'policy-changes.jsonl']) {
    await t.test(name, async (t) => {
      const f = fixture(t);
      f.project();
      const sentinel = path.join(f.home, 'late-outside-sentinel');
      fs.writeFileSync(sentinel, '{}\n', { mode: 0o644 });
      const code = await setupCommand([], { ...f.options, ask: async () => {
        const file = path.join(f.dataDir, name);
        if (fs.existsSync(file)) fs.unlinkSync(file);
        fs.symlinkSync(sentinel, file);
        return 'paced';
      } }).catch(() => 1);
      assert.equal(code, 1);
      assert.equal(fs.readFileSync(sentinel, 'utf8'), '{}\n');
      assert.equal(fs.statSync(sentinel).mode & 0o777, 0o644);
      assert.deepEqual(f.commands, []);
    });
  }
});

test('setup revisions start at zero for missing, legacy and corrupt progress', async (t) => {
  for (const [name, text] of [
    ['missing', null], ['legacy', '{"schema":"herdr-boss.setup/1","steps":{}}'],
    ['invalid JSON', '{invalid'], ['invalid schema', '{"revision":99,"steps":{}}'],
    ['invalid state', '{"schema":"herdr-boss.setup/1","revision":99,"steps":{"tools":{"status":"unsafe"}}}'],
    ['invalid revision', '{"schema":"herdr-boss.setup/1","revision":-1,"steps":{}}'],
  ]) {
    await t.test(name, async (t) => {
      const f = fixture(t);
      fs.mkdirSync(f.dataDir);
      if (text !== null) fs.writeFileSync(path.join(f.dataDir, 'setup.json'), text);
      f.values.node = '';
      assert.equal((await runSetup(f.options)).exitCode, 3);
      assert.equal(readSetupState(f.dataDir).revision, 3);
    });
  }
});

test('setup revisions treat progress removed or corrupted during a prompt as revision zero', async (t) => {
  for (const kind of ['missing', 'corrupt']) {
    await t.test(kind, async (t) => {
      const f = fixture(t);
      f.values.node = '';
      const file = path.join(f.dataDir, 'setup.json');
      const result = await runSetup({ ...f.options, ask: async () => {
        if (kind === 'missing') fs.unlinkSync(file);
        else fs.writeFileSync(file, '{invalid');
        return 'no';
      } });
      assert.equal(result.exitCode, 1);
      assert.equal(f.lines.at(-1), 'Another setup run changed the progress. Run setup --resume.');
      if (kind === 'missing') assert.equal(fs.existsSync(file), false);
      else assert.equal(fs.readFileSync(file, 'utf8'), '{invalid');
    });
  }
});

test('F3 setup accepts a registered Git worktree and rejects invalid or missing Git metadata', async (t) => {
  const f = fixture(t);
  const primary = path.join(f.home, 'primary');
  const worktree = path.join(f.home, 'worktree');
  const env = { ...process.env, HOME: f.home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(f.home, 'gitconfig') };
  execFileSync('git', ['init', '-q', '-b', 'main', primary], { env });
  execFileSync('git', ['-C', primary, 'worktree', 'add', '--orphan', '-b', 'fixture-branch', worktree], { env, stdio: 'pipe' });
  assert.equal(fs.statSync(path.join(worktree, '.git')).isFile(), true);
  f.project();
  fs.writeFileSync(path.join(f.dataDir, 'project-repos.json'), JSON.stringify([{ slug: 'invented', repo: worktree }]));
  assert.equal(hasSetupProject(f.dataDir), true);
  assert.equal((await runSetup({ ...f.options, pacing: 'paced', ask: async () => 'yes' })).exitCode, 0);
  fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: missing-metadata\n');
  assert.equal(hasSetupProject(f.dataDir), false);
  fs.unlinkSync(path.join(worktree, '.git'));
  assert.equal(hasSetupProject(f.dataDir), false);
  fs.mkdirSync(path.join(worktree, '.git'));
  assert.equal(hasSetupProject(f.dataDir), false);
});
