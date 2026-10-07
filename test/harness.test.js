import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { guardCause } from '../src/denials.js';
import { unregisterProjectRepo } from '../src/harness.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.js');
const TEMPLATES = path.join(ROOT, 'kit', 'templates', 'harness');
const PLACEHOLDERS = new Set(['HOME', 'UID', 'HERDR_BOSS_REPO', 'HERDR_BOSS_URL', 'PROJECT_LIST']);
const FORBIDDEN_PS = ['e', '-E', 'eww', 'auxe', 'auxeww'];

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-harness-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dataDir = path.join(home, 'boss');
  fs.mkdirSync(dataDir, { recursive: true });
  return { home, dataDir };
}

function run(f, args, cwd = f.home) {
  const env = { ...process.env, HOME: f.home, HERDR_BOSS_DIR: f.dataDir, TMPDIR: f.home };
  delete env.XDG_CONFIG_HOME;
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' });
}

function gitRepo(f, name, remote) {
  const dir = path.join(f.home, 'Projects', name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  if (remote) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remote]);
  return dir;
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function registry(f, rows) { writeFile(path.join(f.dataDir, 'project-repos.json'), JSON.stringify(rows)); }

function codexConfig(roots, { extraBefore = '', extraAfter = '' } = {}) {
  return [
    'model = "gpt-6-luna"',
    extraBefore,
    '[sandbox_workspace_write]',
    'network_access = true',
    'writable_roots = [',
    ...roots.map((root) => `  "${root}",`),
    ']',
    '',
    '[profiles.fast]',
    'model = "gpt-6.1-sol"',
    extraAfter,
  ].join('\n');
}

// A complete fixture: every fixed entry is present. Tests remove one entry at a time.
function healthy(f, repos) {
  const roots = [path.join(f.home, '.herdr-boss'), path.join(f.home, 'Projects', '.herdr-wt'), ...repos.map((repo) => path.join(repo, '.git'))];
  writeFile(path.join(f.home, '.codex', 'config.toml'), codexConfig(roots));
  writeFile(path.join(f.home, '.codex', 'rules', 'herdr.rules'), `${[...FORBIDDEN_PS.map((arg) => `prefix_rule(pattern=["ps", "${arg}"], decision="forbidden")`), 'prefix_rule(pattern=["pkill"], decision="forbidden")', 'prefix_rule(pattern=["killall"], decision="forbidden")'].join('\n')}\n# A worker stops its own process through the helper, never with a raw signal.\nprefix_rule(pattern=["herdr-boss", "worker", "stop-own"], decision="allow")\nprefix_rule(pattern=["herdr-boss", "release", "request"], decision="allow")\nprefix_rule(pattern=["herdr-boss", "release", "publish"], decision="allow")\n`);
  writeFile(path.join(f.home, '.claude', 'settings.json'), JSON.stringify({
    apiKeyHelper: 'SECRET-HELPER-VALUE',
    autoMode: { environment: [`**Herdr Boss projects**: ${repos.map((repo) => `${repo} (o/${path.basename(repo)})`).join(', ')}.`], allow: ['$defaults', 'Run only `herdr-boss release request`.', 'Run only `herdr-boss release publish`.'] },
  }));
  writeFile(path.join(f.home, '.config', 'opencode', 'opencode.json'), JSON.stringify({
    provider: { secret: { options: { apiKey: 'SECRET-OPENCODE-KEY' } } },
    agent: { worker: { mode: 'primary', permission: { bash: { '*': 'allow' } } } },
  }));
  writeFile(path.join(f.home, '.pi', 'agent', 'extensions', 'herdr-guard.ts'), 'export default function () {}\n');
}

function harnessSyncFixture(t) {
  const f = fixture(t);
  const alpha = gitRepo(f, 'Alpha', 'https://github.com/example/alpha.git');
  registry(f, [{ slug: 'alpha', repo: alpha, remote: 'https://github.com/example/alpha.git' }]);
  const roots = [path.join(f.home, '.herdr-boss'), path.join(f.home, 'Projects', '.herdr-wt'), path.join(alpha, '.git')];
  writeFile(path.join(f.home, '.codex', 'config.toml'), codexConfig(roots));
  const template = JSON.parse(fs.readFileSync(path.join(TEMPLATES, 'claude-automode.json'), 'utf8'));
  const values = {
    HOME: f.home,
    UID: String(process.getuid?.() ?? ''),
    HERDR_BOSS_REPO: ROOT,
    HERDR_BOSS_URL: 'http://127.0.0.1:4477',
    PROJECT_LIST: `${alpha} (example/alpha)`,
  };
  const filled = JSON.parse(JSON.stringify(template, (_key, value) => value));
  for (const key of ['environment', 'allow']) {
    filled[key] = filled[key].map((line) => line.replace(/\{\{([A-Z_]+)\}\}/g, (_all, name) => values[name]));
  }
  // The recommended projects line names the parent folder of each registered repository.
  filled.environment = filled.environment.map((line) => (line.startsWith('**Herdr Boss projects**') ? line.replace(`: ${values.PROJECT_LIST}.`, `: every repository under ${path.dirname(alpha)}/ that contains the file docs/orchestration/herdr-boss.md is a Herdr Boss project, with its own origin remote only.`) + ' A folder without that file is not a Herdr Boss project.' : line));
  return { ...f, alpha, expected: filled };
}

function writeClaudeAutoMode(f, autoMode, settings = {}) {
  writeFile(path.join(f.home, '.claude', 'settings.json'), JSON.stringify({ ...settings, autoMode }));
}

test('unregister keeps null and non-object registry rows unchanged', (t) => {
  const f = fixture(t);
  const file = path.join(f.dataDir, 'project-repos.json');
  const before = `${JSON.stringify([{ slug: 'remove', repo: '/tmp/remove' }, null, 'keep', 17], null, 2)}\n`;
  writeFile(file, before);

  assert.doesNotThrow(() => unregisterProjectRepo('remove', { dataDir: f.dataDir }));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [null, 'keep', 17]);
});

test('unregister keeps a leftover temp file and writes an exclusive timestamp and pid backup', (t) => {
  const f = fixture(t);
  const file = path.join(f.dataDir, 'project-repos.json');
  const before = `${JSON.stringify([{ slug: 'remove', repo: '/tmp/remove' }, { slug: 'keep', repo: '/tmp/keep' }], null, 2)}\n`;
  const leftover = `${file}.${process.pid}.tmp`;
  writeFile(file, before);
  fs.writeFileSync(leftover, 'leftover temp');

  const result = unregisterProjectRepo('remove', { dataDir: f.dataDir });
  assert.equal(result.removed, true);
  assert.match(path.basename(result.backup), /^project-repos\.json\.\d+-\d+(?:-\d+)?\.bak$/);
  assert.equal(fs.readFileSync(result.backup, 'utf8'), before);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [{ slug: 'keep', repo: '/tmp/keep' }]);
  assert.equal(fs.readFileSync(leftover, 'utf8'), 'leftover temp');
  assert.deepEqual(fs.readdirSync(f.dataDir).filter((name) => name.endsWith('.tmp')), [path.basename(leftover)]);
});

test('the harness templates use only the known placeholders and name no real path, user, or owner', () => {
  const files = fs.readdirSync(TEMPLATES).sort();
  assert.deepEqual(files, ['claude-automode.json', 'codex-herdr.rules', 'codex-sandbox.toml', 'opencode-worker-agent.json', 'pi-herdr-guard.ts']);
  for (const file of files) {
    const text = fs.readFileSync(path.join(TEMPLATES, file), 'utf8');
    for (const [, name] of text.matchAll(/\{\{([A-Z_]+)\}\}/g)) assert.ok(PLACEHOLDERS.has(name), `${file}: unknown placeholder ${name}`);
    assert.doesNotMatch(text, /\/Users\/|hentol|tm-henningnt|gui\/501\b/, file);
  }
  assert.match(fs.readFileSync(path.join(TEMPLATES, 'codex-herdr.rules'), 'utf8'), /gui\/\{\{UID\}\}\/no\.tallmaker\.herdr-boss/);
  const automode = JSON.parse(fs.readFileSync(path.join(TEMPLATES, 'claude-automode.json'), 'utf8'));
  assert.equal(automode.allow[0], '$defaults');
  assert.ok(automode.environment.some((line) => line.startsWith('**Herdr Boss projects**: {{PROJECT_LIST}}')));
  const agent = JSON.parse(fs.readFileSync(path.join(TEMPLATES, 'opencode-worker-agent.json'), 'utf8'));
  assert.equal(agent.permission.external_directory['*'], 'deny');
  const docs = fs.readFileSync(path.join(ROOT, 'docs', 'harness-setup.md'), 'utf8');
  assert.doesNotMatch(docs, /\/Users\/|hentol|tm-henningnt/);
});

test('publish records the project repository once and strips credentials from the remote', (t) => {
  const f = fixture(t);
  const repo = gitRepo(f, 'Demo', 'https://someone:s3cret-token@github.com/example/demo.git');
  const status = path.join(f.home, 'status.json');
  fs.writeFileSync(status, JSON.stringify({ project: 'Demo' }));
  const first = run(f, ['publish', 'demo', status], repo);
  assert.equal(first.status, 0, first.stderr);
  const file = path.join(f.dataDir, 'project-repos.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const saved = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(saved, /s3cret|someone/);
  assert.deepEqual(JSON.parse(saved), [{ slug: 'demo', repo, remote: 'https://github.com/example/demo.git' }]);
  assert.doesNotMatch(first.stdout + first.stderr, /s3cret/);
  // No Codex config in the fixture: the registration sync prints a warning and changes nothing.
  assert.match(first.stderr, /^warning: harness sync: /m);
  assert.equal(fs.existsSync(path.join(f.home, '.codex', 'config.toml')), false);

  // A later publish of the same slug keeps the first record and runs no sync.
  execFileSync('git', ['-C', repo, 'remote', 'set-url', 'origin', 'https://github.com/example/moved.git']);
  const second = run(f, ['publish', 'demo', status], repo);
  assert.equal(second.status, 0, second.stderr);
  assert.doesNotMatch(second.stderr, /harness sync/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [{ slug: 'demo', repo, remote: 'https://github.com/example/demo.git' }]);
});

test('publish of a new slug adds the project .git to the Codex writable roots', (t) => {
  const f = fixture(t);
  const repo = gitRepo(f, 'Fresh', 'git@github.com:example/fresh.git');
  const config = path.join(f.home, '.codex', 'config.toml');
  writeFile(config, codexConfig([path.join(f.home, '.herdr-boss')]));
  const status = path.join(f.home, 'status.json');
  fs.writeFileSync(status, JSON.stringify({ project: 'Fresh' }));
  const result = run(f, ['publish', 'fresh', status], repo);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /^warning: harness sync: .*added .*Fresh\/\.git/m);
  assert.ok(fs.readFileSync(config, 'utf8').includes(`"${path.join(repo, '.git')}",`));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'project-repos.json'), 'utf8'))[0].remote, 'git@github.com:example/fresh.git');
});

test('harness check passes on a complete setup and prints no setting value that is not a path', (t) => {
  const f = fixture(t);
  const alpha = gitRepo(f, 'Alpha');
  registry(f, [{ slug: 'alpha', repo: alpha, remote: 'https://github.com/example/alpha.git' }]);
  healthy(f, [alpha]);
  writeClaudeAutoMode(f, {
    environment: [`**Herdr Boss projects**: ${alpha} (o/alpha)`, '**Owner note**: KEEP-ENV-PRIVATE'],
    allow: ['$defaults', 'KEEP-ALLOW-PRIVATE', 'Run only `herdr-boss release request`.', 'Run only `herdr-boss release publish`.'],
  }, { apiKeyHelper: 'SECRET-HELPER-VALUE' });
  const result = run(f, ['harness', 'check']);
  // Codex has no -s workspace-write in kit/models.json yet; every other entry is present.
  const missing = result.stdout.split('\n').filter((line) => line.startsWith('missing'));
  assert.ok(missing.every((line) => /models\.json codex/.test(line)), missing.join('\n'));
  assert.match(result.stdout, /^ok +codex writable_roots: .*Alpha\/\.git \(alpha\)$/m);
  assert.ok(result.stdout.split('\n').some((line) => /^ok +codex writable_roots: /.test(line) && line.endsWith(`${path.join(f.home, 'Projects', '.herdr-wt')} (worker worktrees)`)), result.stdout);
  assert.match(result.stdout, /^ok +claude autoMode: \*\*Herdr Boss projects\*\* names .*Alpha \(alpha\)$/m);
  assert.match(result.stdout, /^ok +codex rules: stop-own is allowed in .*herdr\.rules$/m);
  assert.match(result.stdout, /^ok +opencode: agent worker exists$/m);
  // The printed rule line for a stop by pid holds the word allow. It is a fixed text, not a setting value.
  assert.doesNotMatch((result.stdout + result.stderr).replaceAll('decision="allow"', ''), /SECRET|apiKey|primary|allow\b/);
  assert.doesNotMatch(result.stdout + result.stderr, /KEEP-ENV-PRIVATE|KEEP-ALLOW-PRIVATE/);
});

test('harness check reports a missing project .git and a missing Claude line and exits 1', (t) => {
  const f = fixture(t);
  const alpha = gitRepo(f, 'Alpha');
  const beta = gitRepo(f, 'Beta');
  healthy(f, [alpha]);
  registry(f, [{ slug: 'alpha', repo: alpha, remote: '' }, { slug: 'beta', repo: beta, remote: '' }]);
  const result = run(f, ['harness', 'check']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^missing +codex writable_roots: .*Beta\/\.git \(beta\)$/m);
  assert.match(result.stdout, /^missing +claude autoMode: \*\*Herdr Boss projects\*\* does not name .*Beta \(beta\)$/m);
  // A sibling worker worktree path does not count as the project path.
  const settings = path.join(f.home, '.claude', 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ autoMode: { environment: [`**Herdr Boss projects**: ${alpha}-wt-x (o/a), ${beta} (o/b).`] } }));
  const sibling = run(f, ['harness', 'check']);
  assert.match(sibling.stdout, /^missing +claude autoMode: .*does not name .*Alpha \(alpha\)$/m);
  assert.match(sibling.stdout, /^ok +claude autoMode: .*names .*Beta \(beta\)$/m);
});

// K19: the check must report a missing stop-own rule, name the rules file, and print the line to add.
test('harness check reports a missing stop-own rule with the rules file and the line to add', (t) => {
  const f = fixture(t);
  healthy(f, []);
  const rulesFile = path.join(f.home, '.codex', 'rules', 'herdr.rules');
  const original = 'prefix_rule(pattern=["ps", "e"], decision="forbidden")\n';
  fs.writeFileSync(rulesFile, original);
  const result = run(f, ['harness', 'check']);
  assert.equal(result.status, 1);
  const line = result.stdout.split('\n').find((entry) => entry.startsWith('missing') && entry.includes('codex rules') && entry.includes('stop-own'));
  assert.ok(line, `no missing stop-own finding in:\n${result.stdout}`);
  assert.ok(line.includes(rulesFile), line);
  assert.ok(line.includes('prefix_rule(pattern=["herdr-boss", "worker", "stop-own"], decision="allow")'), line);
  // The check reads only. It adds nothing.
  assert.equal(fs.readFileSync(rulesFile, 'utf8'), original);
});

// K19: release checks report the two required command permissions and leave both files unchanged.
test('harness check reports missing release request and publish rules for Claude and Codex', (t) => {
  const f = fixture(t);
  healthy(f, []);
  const rulesFile = path.join(f.home, '.codex', 'rules', 'herdr.rules');
  const rules = 'prefix_rule(pattern=["herdr-boss", "worker", "stop-own"], decision="allow")\n';
  fs.writeFileSync(rulesFile, rules);
  const settingsFile = path.join(f.home, '.claude', 'settings.json');
  const claude = { autoMode: { environment: [], allow: ['$defaults'] } };
  fs.writeFileSync(settingsFile, JSON.stringify(claude));
  const result = run(f, ['harness', 'check']);
  assert.equal(result.status, 1);
  for (const command of ['request', 'publish']) {
    const codex = result.stdout.split('\n').find((line) => line.startsWith('missing') && line.includes(`release ${command}`) && line.includes('codex rules'));
    assert.ok(codex, `no missing Codex release ${command} finding in:\n${result.stdout}`);
    assert.ok(codex.includes(rulesFile), codex);
    assert.ok(codex.includes(`prefix_rule(pattern=["herdr-boss", "release", "${command}"], decision="allow")`), codex);
    const claudeLine = result.stdout.split('\n').find((line) => line.startsWith('missing') && line.includes(`release ${command}`) && line.includes('claude autoMode'));
    assert.ok(claudeLine, `no missing Claude release ${command} finding in:\n${result.stdout}`);
    assert.ok(claudeLine.includes(settingsFile), claudeLine);
    assert.ok(claudeLine.includes(`Run only \`herdr-boss release ${command}\`.`), claudeLine);
  }
  assert.equal(fs.readFileSync(rulesFile, 'utf8'), rules);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), claude);
});

test('harness check treats missing Claude autoMode as an empty release allow list', (t) => {
  const f = fixture(t);
  healthy(f, []);
  const settingsFile = path.join(f.home, '.claude', 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ unrelated: 'not printed' }));
  const result = run(f, ['harness', 'check']);
  assert.equal(result.status, 1);
  for (const command of ['request', 'publish']) {
    const line = result.stdout.split('\n').find((entry) => entry.startsWith('missing') && entry.includes(`release ${command}`) && entry.includes('claude autoMode'));
    assert.ok(line, `no missing Claude release ${command} finding in:\n${result.stdout}`);
    assert.ok(line.includes(settingsFile), line);
  }

  fs.writeFileSync(settingsFile, '{');
  const readError = run(f, ['harness', 'check']);
  assert.equal(readError.status, 1);
  assert.doesNotMatch(readError.stdout, /claude autoMode: Release (?:request|publish) permission/);
});

// K19: harness sync adds the rule to the Codex rules file, keeps every other line, and makes a backup.
test('harness sync adds the stop-own rule to the Codex rules file and keeps the other lines', (t) => {
  const f = fixture(t);
  const config = path.join(f.home, '.codex', 'config.toml');
  writeFile(config, codexConfig([path.join(f.home, '.herdr-boss'), path.join(f.home, 'Projects', '.herdr-wt')]));
  const rulesFile = path.join(f.home, '.codex', 'rules', 'herdr.rules');
  const before = [
    'prefix_rule(pattern=["ps"], decision="allow")',
    'prefix_rule(pattern=["ps", "e"], decision="forbidden")',
    'prefix_rule(pattern=["pkill"], decision="forbidden")',
    '',
  ].join('\n');
  writeFile(rulesFile, before);

  const dry = run(f, ['harness', 'sync', '--codex-only', '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.ok(dry.stdout.includes('stop-own'), dry.stdout);
  assert.equal(fs.readFileSync(rulesFile, 'utf8'), before, 'a dry run writes nothing');

  const result = run(f, ['harness', 'sync', '--codex-only']);
  assert.equal(result.status, 0, result.stderr);
  const after = fs.readFileSync(rulesFile, 'utf8');
  assert.equal((after.match(/stop-own/g) ?? []).length, 1, after);
  assert.ok(after.includes('prefix_rule(pattern=["ps"], decision="allow")'), after);
  assert.ok(after.indexOf('stop-own') < after.indexOf('"ps", "e"'), 'the allow rule comes before the forbidden rules');
  const backups = fs.readdirSync(path.dirname(rulesFile)).filter((name) => /^herdr\.rules\.bak-\d{8}T\d{6}Z$/.test(name));
  assert.equal(backups.length, 1, backups.join(', '));
  assert.equal(fs.readFileSync(path.join(path.dirname(rulesFile), backups[0]), 'utf8'), before);

  const again = run(f, ['harness', 'sync', '--codex-only']);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /Codex rules in .*herdr\.rules: nothing to add/);
  assert.equal(fs.readdirSync(path.dirname(rulesFile)).filter((name) => name.startsWith('herdr.rules.bak-')).length, 1);
});

// Without a rules file the sync cannot add anything. It prints the line and writes nothing.
test('harness sync without a Codex rules file prints the stop-own line and writes nothing', (t) => {
  const f = fixture(t);
  const config = path.join(f.home, '.codex', 'config.toml');
  writeFile(config, codexConfig([path.join(f.home, '.herdr-boss'), path.join(f.home, 'Projects', '.herdr-wt')]));
  const result = run(f, ['harness', 'sync', '--codex-only']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No Codex rules at .*herdr\.rules/);
  assert.ok(result.stdout.includes('prefix_rule(pattern=["herdr-boss", "worker", "stop-own"], decision="allow")'), result.stdout);
  assert.equal(fs.existsSync(path.join(f.home, '.codex', 'rules', 'herdr.rules')), false);
});

// K19 rework: only an active exact allow rule counts. A deny, a comment, a malformed line,
// a prompt line, a broader pattern, and an allow-plus-deny pair must not pass the check.
test('harness check counts only an active exact allow rule for stop-own', (t) => {
  const f = fixture(t);
  healthy(f, []);
  const rulesFile = path.join(f.home, '.codex', 'rules', 'herdr.rules');
  const allow = 'prefix_rule(pattern=["herdr-boss", "worker", "stop-own"], decision="allow")';
  const cases = [
    { name: 'forbidden only', body: 'prefix_rule(pattern=["herdr-boss", "worker", "stop-own"], decision="forbidden")\n', status: 'bad' },
    { name: 'commented allow', body: `# ${allow}\n`, status: 'missing' },
    { name: 'malformed without a decision', body: 'prefix_rule(pattern=["herdr-boss", "worker", "stop-own"])\n', status: 'missing' },
    { name: 'prompt decision', body: 'prefix_rule(pattern=["herdr-boss", "worker", "stop-own"], decision="prompt")\n', status: 'missing' },
    { name: 'broader pattern', body: 'prefix_rule(pattern=["herdr-boss", "worker"], decision="allow")\n', status: 'missing' },
    { name: 'allow and forbidden', body: `${allow}\nprefix_rule(pattern=["herdr-boss", "worker", "stop-own"], decision="forbidden")\n`, status: 'bad' },
  ];
  for (const { name, body, status } of cases) {
    fs.writeFileSync(rulesFile, body);
    const out = run(f, ['harness', 'check']).stdout;
    const line = out.split('\n').find((entry) => entry.includes('codex rules') && entry.includes('stop-own'));
    assert.ok(line, `${name}: no stop-own finding in:\n${out}`);
    assert.ok(line.startsWith(status), `${name}: expected ${status}, got: ${line}`);
    assert.ok(line.includes(rulesFile), `${name}: ${line}`);
    assert.equal(fs.readFileSync(rulesFile, 'utf8'), body, `${name}: the check writes nothing`);
  }
  // A valid allow rule with spaces between the tokens passes.
  const spaced = 'prefix_rule( pattern = [ "herdr-boss" , "worker" , "stop-own" ] , decision = "allow" )';
  fs.writeFileSync(rulesFile, `${spaced}\n`);
  const out = run(f, ['harness', 'check']).stdout;
  assert.match(out, /^ok +codex rules: stop-own is allowed in .*herdr\.rules$/m, out);
});

// K19 rework: sync must not weaken an explicit deny. It reports the conflict and writes nothing.
test('harness sync writes no stop-own rule over an explicit deny or a conflict', (t) => {
  const f = fixture(t);
  const config = path.join(f.home, '.codex', 'config.toml');
  writeFile(config, codexConfig([path.join(f.home, '.herdr-boss'), path.join(f.home, 'Projects', '.herdr-wt')]));
  const rulesFile = path.join(f.home, '.codex', 'rules', 'herdr.rules');
  const allow = 'prefix_rule(pattern=["herdr-boss", "worker", "stop-own"], decision="allow")';
  const cases = [
    { name: 'forbidden only', body: 'prefix_rule(pattern=["herdr-boss", "worker", "stop-own"], decision="forbidden")\n' },
    { name: 'allow and forbidden', body: `${allow}\nprefix_rule(pattern=["herdr-boss", "worker", "stop-own"], decision="forbidden")\n` },
  ];
  for (const { name, body } of cases) {
    writeFile(rulesFile, body);
    const result = run(f, ['harness', 'sync', '--codex-only']);
    assert.equal(result.status, 1, `${name}: ${result.stderr}`);
    assert.match(result.stdout, /Conflict/, `${name}: ${result.stdout}`);
    assert.equal(fs.readFileSync(rulesFile, 'utf8'), body, `${name}: the file is unchanged`);
    assert.deepEqual(fs.readdirSync(path.dirname(rulesFile)).filter((entry) => entry.startsWith('herdr.rules.bak-')), [], name);
    const check = run(f, ['harness', 'check']);
    assert.equal(check.status, 1, name);
    assert.doesNotMatch(check.stdout, /^ok +codex rules: stop-own/m, `${name}: the check must not claim permission: ${check.stdout}`);
  }
});

test('harness check reports each fixed entry', (t) => {
  const f = fixture(t);
  registry(f, []);
  healthy(f, []);
  const config = path.join(f.home, '.codex', 'config.toml');
  fs.writeFileSync(config, codexConfig([path.join(f.home, '.config', 'herdr-boss')]));
  fs.writeFileSync(path.join(f.home, '.codex', 'rules', 'herdr.rules'), 'prefix_rule(pattern=["ps", "e"], decision="forbidden")\n');
  fs.writeFileSync(path.join(f.home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ agent: { build: {} } }));
  fs.rmSync(path.join(f.home, '.pi', 'agent', 'extensions', 'herdr-guard.ts'));
  const result = run(f, ['harness', 'check']);
  assert.equal(result.status, 1);
  const out = result.stdout;
  assert.match(out, new RegExp(`^missing +codex writable_roots: ${path.join(f.home, '.herdr-boss').replace(/[.]/g, '\\.')}$`, 'm'));
  assert.match(out, /^bad +codex writable_roots: .*\.config\/herdr-boss must not be writable$/m);
  assert.match(out, /^missing +codex writable_roots: .*\/Projects\/\.herdr-wt \(worker worktrees\)$/m);
  assert.match(out, /^ok +codex rules: ps e is forbidden$/m);
  for (const arg of ['-E', 'eww', 'auxe', 'auxeww']) assert.match(out, new RegExp(`^missing +codex rules: ps ${arg} is not forbidden`, 'm'));
  for (const command of ['pkill', 'killall']) assert.match(out, new RegExp(`^missing +codex rules: ${command} is not forbidden`, 'm'));
  // The check reports the missing stop-own rule with the file and the line to add. It adds nothing.
  const stopOwn = out.split('\n').find((line) => line.startsWith('missing') && line.includes('stop-own'));
  assert.ok(stopOwn, out);
  assert.ok(stopOwn.includes(path.join(f.home, '.codex', 'rules', 'herdr.rules')), stopOwn);
  assert.ok(stopOwn.includes('prefix_rule(pattern=["herdr-boss", "worker", "stop-own"], decision="allow")'), stopOwn);
  assert.doesNotMatch(fs.readFileSync(path.join(f.home, '.codex', 'rules', 'herdr.rules'), 'utf8'), /stop-own/);
  assert.match(out, /^missing +opencode: agent worker/m);
  assert.match(out, /^missing +pi: .*herdr-guard\.ts$/m);
  assert.match(out, /^ok +models\.json claude: --permission-mode auto$/m);
  assert.match(out, /^ok +models\.json opencode: --agent worker$/m);
  assert.match(out, /^ok +models\.json pi: --no-approve$/m);
  assert.match(out, /^ok +models\.json pi: --no-extensions$/m);

  // A root written with ~ counts as the parent folder of the worker worktrees.
  fs.writeFileSync(config, codexConfig([path.join(f.home, '.herdr-boss'), '~/Projects/.herdr-wt']));
  assert.match(run(f, ['harness', 'check']).stdout, /^ok +codex writable_roots: .*\/Projects\/\.herdr-wt \(worker worktrees\)$/m);

  // A parent folder of the private directory also makes it writable.
  fs.writeFileSync(config, codexConfig([path.join(f.home, '.herdr-boss'), path.join(f.home, '.config')]));
  assert.match(run(f, ['harness', 'check']).stdout, /^bad +codex writable_roots: .*\.config\/herdr-boss must not be writable$/m);
});

test('every harness finding carries a fixed item label and holds no path or text', async (t) => {
  const { checkHarness } = await import('../src/harness.js');
  const f = fixture(t);
  const alpha = gitRepo(f, 'Alpha');
  registry(f, [{ slug: 'alpha', repo: alpha, remote: 'https://github.com/example/alpha.git' }]);
  healthy(f, [alpha]);
  const findings = checkHarness({ home: f.home, dataDir: f.dataDir });
  assert.ok(findings.length > 0);
  const items = new Set(findings.map((finding) => finding.item));
  assert.ok(items.has('Pi guard'), [...items].join(', '));
  assert.ok(items.has('OpenCode worker agent'), [...items].join(', '));
  for (const finding of findings) {
    assert.equal(typeof finding.item, 'string', 'every finding has an item label');
    assert.ok(finding.item.length > 0, 'the item label is not empty');
    assert.equal(finding.item, finding.item.trim(), 'the item label has no surrounding space');
    assert.doesNotMatch(finding.item, /\//, `the item label names no path: ${finding.item}`);
    assert.equal(finding.item.includes(f.home), false, `the item label holds the home path: ${finding.item}`);
    assert.notEqual(finding.item, finding.text, 'the item label is not the finding text');
  }

  // The unsafe-root finding also gets a fixed label and no path.
  writeFile(path.join(f.home, '.codex', 'config.toml'), codexConfig([path.join(f.home, '.config')]));
  const bad = checkHarness({ home: f.home, dataDir: f.dataDir }).find((finding) => finding.status === 'bad');
  assert.ok(bad, 'the fixture reports the private folder as writable');
  assert.equal(bad.item, 'Private config folder not writable');
  assert.equal(bad.item.includes(f.home), false);
});

test('harness sync adds the missing roots, keeps the others, makes a backup, and changes no other line', (t) => {
  const f = fixture(t);
  const alpha = gitRepo(f, 'Alpha');
  const beta = gitRepo(f, 'Beta');
  registry(f, [{ slug: 'beta', repo: beta, remote: 'https://github.com/example/beta.git' }, { slug: 'alpha', repo: alpha, remote: '' }]);
  const config = path.join(f.home, '.codex', 'config.toml');
  const keep = path.join(f.home, '.npm');
  const before = codexConfig([keep, path.join(beta, '.git')], { extraBefore: '# a comment\n', extraAfter: '[mcp_servers.x]\ncommand = "y"\n' });
  writeFile(config, before);
  fs.chmodSync(config, 0o600);

  const result = run(f, ['harness', 'sync']);
  assert.equal(result.status, 0, result.stderr);
  const after = fs.readFileSync(config, 'utf8');
  const expected = before.replace(`  "${path.join(beta, '.git')}",\n`, `  "${path.join(beta, '.git')}",\n  "${path.join(f.home, '.herdr-boss')}",\n  "${path.join(f.home, 'Projects', '.herdr-wt')}",\n  "${path.join(alpha, '.git')}",\n`);
  assert.equal(after, expected);
  assert.equal(fs.statSync(config).mode & 0o777, 0o600);
  const backups = fs.readdirSync(path.dirname(config)).filter((name) => /^config\.toml\.bak-\d{8}T\d{6}Z$/.test(name));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(config), backups[0]), 'utf8'), before);
  // The Claude lines are printed for the Owner; the settings file is not touched.
  assert.ok(result.stdout.includes(`**Herdr Boss projects**: every repository under ${path.join(f.home, 'Projects')}/ that contains the file docs/orchestration/herdr-boss.md is a Herdr Boss project`), result.stdout);
  assert.ok(result.stdout.includes(`Worker worktrees are in ${f.home}/Projects/.herdr-wt/<repo>/<name>.`), result.stdout);
  assert.equal(fs.existsSync(path.join(f.home, '.claude', 'settings.json')), false);

  // A second run finds nothing to add and makes no new backup.
  const again = run(f, ['harness', 'sync', '--codex-only']);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /nothing to add/);
  assert.doesNotMatch(again.stdout, /Herdr Boss projects/);
  assert.equal(fs.readdirSync(path.dirname(config)).filter((name) => name.startsWith('config.toml.bak-')).length, 1);
});

test('harness sync reports nothing when every Claude template line is present', (t) => {
  const f = harnessSyncFixture(t);
  writeClaudeAutoMode(f, f.expected);
  const result = run(f, ['harness', 'sync']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Claude autoMode: nothing to change\./);
  assert.doesNotMatch(result.stdout, /missing (?:environment|allow):|change environment|now:/);
  assert.match(result.stdout, /Owner lines kept: 0 environment, 0 allow/);
  assert.doesNotMatch(result.stdout, /"environment"\s*:/);
  assert.doesNotMatch(result.stdout, /"allow"\s*:/);
  for (const line of f.expected.allow) assert.ok(!result.stdout.includes(line), `unexpected allow line: ${line}`);
});

test('harness sync shows only a changed labeled environment line and its current value', (t) => {
  const f = harnessSyncFixture(t);
  const current = { ...f.expected, environment: [...f.expected.environment], allow: [...f.expected.allow] };
  const index = current.environment.findIndex((line) => line.startsWith('**Supervisor**:'));
  current.environment[index] = current.environment[index].replace('runs on this machine', 'runs on another machine');
  writeClaudeAutoMode(f, current);
  const result = run(f, ['harness', 'sync']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`change environment "Supervisor": ${f.expected.environment[index]}`), result.stdout);
  assert.ok(result.stdout.includes(`now: ${current.environment[index]}`), result.stdout);
  assert.doesNotMatch(result.stdout, /"allow"\s*:/);
  assert.doesNotMatch(result.stdout, /"environment"\s*:/);
});

test('harness sync reports only a missing allow line and never prints a full allow list', (t) => {
  const f = harnessSyncFixture(t);
  const current = { ...f.expected, environment: [...f.expected.environment], allow: [...f.expected.allow] };
  current.allow.splice(2, 1);
  writeClaudeAutoMode(f, current);
  const result = run(f, ['harness', 'sync']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`missing allow: ${f.expected.allow[2]}`), result.stdout);
  assert.doesNotMatch(result.stdout, /"allow"\s*:/);
  assert.doesNotMatch(result.stdout, /\$defaults/);
  for (const line of f.expected.allow.filter((_line, index) => index !== 2)) assert.ok(!result.stdout.includes(line), `unexpected allow line: ${line}`);
});

test('harness sync treats a tilde home path as equal to the full home path', (t) => {
  const f = harnessSyncFixture(t);
  const current = { ...f.expected, environment: [...f.expected.environment], allow: [...f.expected.allow] };
  const index = current.environment.findIndex((line) => line.startsWith('**Supervisor**:'));
  current.environment[index] = current.environment[index].replaceAll(f.home, '~');
  writeClaudeAutoMode(f, current);
  const result = run(f, ['harness', 'sync']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Claude autoMode: nothing to change\./);
  assert.doesNotMatch(result.stdout, /change environment|missing environment/);
});

test('harness sync accepts a projects line with extra Owner text and the same paths in another order', (t) => {
  const f = harnessSyncFixture(t);
  const beta = gitRepo(f, 'Beta', 'https://github.com/example/beta.git');
  registry(f, [
    { slug: 'alpha', repo: f.alpha, remote: 'https://github.com/example/alpha.git' },
    { slug: 'beta', repo: beta, remote: 'https://github.com/example/beta.git' },
  ]);
  const current = { ...f.expected, environment: [...f.expected.environment], allow: [...f.expected.allow] };
  const index = current.environment.findIndex((line) => line.startsWith('**Herdr Boss projects**'));
  current.environment[index] = `**Herdr Boss projects**: PUBLIC NOTE. Worker worktrees are in ${f.home}/Projects/.herdr-wt/<repo>/<name>. The projects in another order: ${beta} (example/beta), ${f.alpha} (example/alpha).`;
  writeClaudeAutoMode(f, current);
  const result = run(f, ['harness', 'sync']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Claude autoMode: nothing to change\./);
  assert.doesNotMatch(result.stdout, /change environment "Herdr Boss projects"|missing path:|now:/);
});

test('harness sync reports a missing project path in the projects line as one change', (t) => {
  const f = harnessSyncFixture(t);
  const beta = gitRepo(f, 'Beta', 'https://github.com/example/beta.git');
  registry(f, [
    { slug: 'alpha', repo: f.alpha, remote: 'https://github.com/example/alpha.git' },
    { slug: 'beta', repo: beta, remote: 'https://github.com/example/beta.git' },
  ]);
  const current = { ...f.expected, environment: [...f.expected.environment], allow: [...f.expected.allow] };
  const index = current.environment.findIndex((line) => line.startsWith('**Herdr Boss projects**'));
  current.environment[index] = `**Herdr Boss projects**: ${f.alpha} (example/alpha). Worker worktrees are in ${f.home}/Projects/.herdr-wt/<repo>/<name>.`;
  writeClaudeAutoMode(f, current);
  const result = run(f, ['harness', 'sync']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((result.stdout.match(/change environment "Herdr Boss projects"/g) ?? []).length, 1, result.stdout);
  const missingPaths = result.stdout.split('\n').filter((line) => line.startsWith('missing path:'));
  assert.deepEqual(missingPaths, [`missing path: ${beta}`]);
});

test('harness sync accepts ~/ paths in place of the full home path in the projects line', (t) => {
  const f = harnessSyncFixture(t);
  const current = { ...f.expected, environment: [...f.expected.environment], allow: [...f.expected.allow] };
  const index = current.environment.findIndex((line) => line.startsWith('**Herdr Boss projects**'));
  current.environment[index] = `${current.environment[index].replaceAll(f.home, '~')} Owner extra text.`;
  writeClaudeAutoMode(f, current);
  const result = run(f, ['harness', 'sync']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Claude autoMode: nothing to change\./);
  assert.doesNotMatch(result.stdout, /change environment|missing path:/);
});

test('harness sync still reports another labeled environment line next to an accepted projects line', (t) => {
  const f = harnessSyncFixture(t);
  const current = { ...f.expected, environment: [...f.expected.environment], allow: [...f.expected.allow] };
  const projects = current.environment.findIndex((line) => line.startsWith('**Herdr Boss projects**'));
  current.environment[projects] = `${current.environment[projects]} Owner extra text.`;
  const decisions = current.environment.findIndex((line) => line.startsWith('**Owner decisions**:'));
  current.environment[decisions] = current.environment[decisions].replace('each project records them', 'each project stores them');
  writeClaudeAutoMode(f, current);
  const result = run(f, ['harness', 'sync']);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /change environment "Herdr Boss projects"|missing path:/);
  assert.ok(result.stdout.includes(`change environment "Owner decisions": ${f.expected.environment[decisions]}`), result.stdout);
});

test('harness sync counts Owner-only lines without printing them', (t) => {
  const f = harnessSyncFixture(t);
  const current = {
    ...f.expected,
    environment: [...f.expected.environment, '**Owner note**: KEEP-ENV-PRIVATE'],
    allow: [...f.expected.allow, 'KEEP-ALLOW-PRIVATE'],
  };
  writeClaudeAutoMode(f, current);
  const result = run(f, ['harness', 'sync']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Claude autoMode: nothing to change\./);
  assert.match(result.stdout, /Owner lines kept: 1 environment, 1 allow/);
  assert.doesNotMatch(result.stdout, /KEEP-ENV-PRIVATE|KEEP-ALLOW-PRIVATE|Owner note/);
});

test('harness sync prints the full Claude template and says when settings are missing', (t) => {
  const f = harnessSyncFixture(t);
  const result = run(f, ['harness', 'sync']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Claude settings file is missing:/);
  for (const line of [...f.expected.environment, ...f.expected.allow]) assert.ok(result.stdout.includes(line), `missing template line: ${line}`);
});

test('harness sync prints the full Claude template and says when autoMode is missing', (t) => {
  const f = harnessSyncFixture(t);
  writeFile(path.join(f.home, '.claude', 'settings.json'), JSON.stringify({ unrelated: 'not printed' }));
  const result = run(f, ['harness', 'sync']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Claude settings file has no autoMode key:/);
  for (const line of [...f.expected.environment, ...f.expected.allow]) assert.ok(result.stdout.includes(line), `missing template line: ${line}`);
  assert.doesNotMatch(result.stdout, /not printed/);
});

test('harness sync changes nothing when the section cannot be parsed safely', (t) => {
  const f = fixture(t);
  const alpha = gitRepo(f, 'Alpha');
  registry(f, [{ slug: 'alpha', repo: alpha, remote: '' }]);
  const config = path.join(f.home, '.codex', 'config.toml');
  const cases = [
    'model = "x"\n',
    '[sandbox_workspace_write]\nnetwork_access = true\n',
    '[sandbox_workspace_write]\nwritable_roots = [\n  "/a", # note\n]\n',
    '[sandbox_workspace_write]\nwritable_roots = [\n  "/a",\n',
    '[sandbox_workspace_write]\nwritable_roots = ["/a"]\n[sandbox_workspace_write]\nwritable_roots = []\n',
  ];
  for (const text of cases) {
    writeFile(config, text);
    const result = run(f, ['harness', 'sync', '--codex-only']);
    assert.equal(result.status, 1, text);
    assert.equal(fs.readFileSync(config, 'utf8'), text);
    assert.match(result.stdout, /Add these lines/);
    assert.ok(result.stdout.includes(`"${path.join(alpha, '.git')}",`), result.stdout);
    assert.deepEqual(fs.readdirSync(path.dirname(config)).filter((name) => name.startsWith('config.toml.bak-')), []);
  }
});

test('harness sync --dry-run prints the change and writes nothing', (t) => {
  const f = fixture(t);
  const alpha = gitRepo(f, 'Alpha');
  registry(f, [{ slug: 'alpha', repo: alpha, remote: '' }]);
  const config = path.join(f.home, '.codex', 'config.toml');
  const before = codexConfig([path.join(f.home, '.herdr-boss')]);
  writeFile(config, before);
  const result = run(f, ['harness', 'sync', '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`+ "${path.join(alpha, '.git')}"`), result.stdout);
  assert.ok(result.stdout.includes(`+ "${path.join(f.home, 'Projects', '.herdr-wt')}"`), result.stdout);
  assert.match(result.stdout, /Dry run/);
  assert.equal(fs.readFileSync(config, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.dirname(config)).filter((name) => name.startsWith('config.toml.bak-')), []);
});

// Load the guard template as a module and return its tool_call handler. The template holds no placeholder.
// TMPDIR points at an empty folder inside the fixture home, so the temporary roots hold no fixture path.
async function guardHandler(t) {
  const scratch = path.join(ROOT, '.worker');
  fs.mkdirSync(scratch, { recursive: true });
  const home = fs.realpathSync(fs.mkdtempSync(path.join(scratch, 'herdr-guard-')));
  const file = path.join(home, 'herdr-guard.ts');
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const pi = path.join(bin, 'pi');
  fs.writeFileSync(pi, '#!/bin/sh\nprintf "fake pi\\n"\n');
  fs.chmodSync(pi, 0o755);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(file, fs.readFileSync(path.join(TEMPLATES, 'pi-herdr-guard.ts'), 'utf8'));
  const previous = { home: process.env.HOME, tmp: process.env.TMPDIR, path: process.env.PATH };
  process.env.HOME = home;
  process.env.TMPDIR = path.join(home, 'empty-tmp');
  process.env.PATH = bin;
  const piProbe = spawnSync('pi', ['--version'], { cwd: home, env: { ...process.env, PATH: bin }, encoding: 'utf8' });
  assert.equal(piProbe.status, 0, piProbe.stderr);
  assert.equal(piProbe.stdout, 'fake pi\n');
  t.after(() => {
    for (const [key, value] of [['HOME', previous.home], ['TMPDIR', previous.tmp], ['PATH', previous.path]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const module = await import(pathToFileURL(file).href);
  let handler;
  module.default({ on: (_event, callback) => { handler = callback; } });
  assert.equal(typeof handler, 'function');
  return { handler, home, cwd: path.join(home, 'wt') };
}

const bashDecision = async (guard, command) => guard.handler({ toolName: 'bash', input: { command } }, { cwd: guard.cwd });

test('the Pi guard allows a removal of an exact path in the worktree .worker folder and blocks a pattern, the worktree, and an outside path', async (t) => {
  const guard = await guardHandler(t);
  fs.mkdirSync(path.join(guard.cwd, '.worker', 'tmp'), { recursive: true });
  assert.equal(await bashDecision(guard, 'rm -rf .worker/tmp/scratch'), undefined);
  assert.equal(await bashDecision(guard, 'rm -rf .worker/report.md'), undefined);
  assert.equal(await bashDecision(guard, 'rm -rf .worker/tmp/build && rm -rf .worker/tmp/dist'), undefined);
  for (const pattern of ['rm -rf .worker/tmp/*', 'rm -rf .worker/tmp/x?', 'rm -rf .worker/tmp/$SUB', 'rm -rf .worker/tmp/$(ls)']) {
    assert.match((await bashDecision(guard, pattern)).reason, /pattern or expansion/, pattern);
  }
  for (const blocked of ['rm -rf .worker', 'rm -rf .', 'rm -rf ..', 'rm -rf /etc/hosts', 'rm -rf src/index.js']) {
    assert.ok((await bashDecision(guard, blocked)).reason, `${blocked} stays blocked`);
  }
});

// Every refusal names the form that the worker may run instead, and every refusal keeps its guard class.
test('each Pi guard refusal names the allowed form', async (t) => {
  const guard = await guardHandler(t);
  fs.mkdirSync(path.join(guard.cwd, '.worker', 'tmp'), { recursive: true });
  const blocked = async (command) => {
    const decision = await bashDecision(guard, command);
    assert.ok(decision?.reason, `${command} is blocked`);
    assert.match(decision.reason, /^Herdr guard: /);
    assert.match(decision.reason, /Allowed instead: /, decision.reason);
    return decision.reason;
  };

  const pkillAllowed = 'kill <pid> of a process that you started, with the PID you saved (pgrep -l NAME shows the PID)';
  const pkill = await blocked('pkill node');
  assert.equal(pkill.includes('cwd check'), false, `no cwd check a worker cannot run: ${pkill}`);
  assert.ok(pkill.includes(pkillAllowed), pkill);
  const killall = await blocked('killall node');
  assert.ok(killall.includes(pkillAllowed), killall);
  // The new allowed text must run through the guard itself.
  assert.equal(await bashDecision(guard, pkillAllowed), undefined, pkillAllowed);
  assert.equal(await bashDecision(guard, 'kill 12345'), undefined, 'kill by saved PID stays allowed');

  const push = await blocked('git push origin main');
  assert.match(push, /is not allowed for a worker/, push);

  const pattern = await blocked('rm -rf .worker/tmp/*');
  assert.match(pattern, /\.worker\/tmp\/scratch/, pattern);
  const outside = await blocked('rm -rf /etc/hosts');
  assert.match(outside, /inside the worktree \.worker folder/, outside);

  const fileBlock = (path) => guard.handler({ toolName: 'read', input: { path } }, { cwd: guard.cwd });
  const protectedPath = (await fileBlock(path.join(guard.cwd, 'auth.json'))).reason;
  assert.match(protectedPath, /is a protected path/, protectedPath);
  assert.match(protectedPath, /Allowed instead: /, protectedPath);
  const outOfWorktree = (await fileBlock('/etc/x')).reason;
  assert.match(outOfWorktree, /is outside the worktree/, outOfWorktree);
  assert.match(outOfWorktree, /Allowed instead: /, outOfWorktree);

  for (const reason of [pkill, push, pattern, outside, protectedPath, outOfWorktree]) {
    assert.notEqual(guardCause(reason), 'guard:other', reason);
  }
});
