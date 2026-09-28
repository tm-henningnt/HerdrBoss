import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
    'model = "gpt-6-sol"',
    extraAfter,
  ].join('\n');
}

// A complete fixture: every fixed entry is present. Tests remove one entry at a time.
function healthy(f, repos) {
  const roots = [path.join(f.home, '.herdr-boss'), ...repos.map((repo) => path.join(repo, '.git'))];
  writeFile(path.join(f.home, '.codex', 'config.toml'), codexConfig(roots));
  writeFile(path.join(f.home, '.codex', 'rules', 'herdr.rules'), `${FORBIDDEN_PS.map((arg) => `prefix_rule(pattern=["ps", "${arg}"], decision="forbidden")`).join('\n')}\n`);
  writeFile(path.join(f.home, '.claude', 'settings.json'), JSON.stringify({
    apiKeyHelper: 'SECRET-HELPER-VALUE',
    autoMode: { environment: [`**Herdr Boss projects**: ${repos.map((repo) => `${repo} (o/${path.basename(repo)})`).join(', ')}.`], allow: ['$defaults'] },
  }));
  writeFile(path.join(f.home, '.config', 'opencode', 'opencode.json'), JSON.stringify({
    provider: { secret: { options: { apiKey: 'SECRET-OPENCODE-KEY' } } },
    agent: { worker: { mode: 'primary', permission: { bash: { '*': 'allow' } } } },
  }));
  writeFile(path.join(f.home, '.pi', 'agent', 'extensions', 'herdr-guard.ts'), 'export default function () {}\n');
}

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
  const result = run(f, ['harness', 'check']);
  // Codex has no -s workspace-write in kit/models.json yet; every other entry is present.
  const missing = result.stdout.split('\n').filter((line) => line.startsWith('missing'));
  assert.ok(missing.every((line) => /models\.json codex/.test(line)), missing.join('\n'));
  assert.match(result.stdout, /^ok +codex writable_roots: .*Alpha\/\.git \(alpha\)$/m);
  assert.match(result.stdout, /^ok +claude autoMode: \*\*Herdr Boss projects\*\* names .*Alpha \(alpha\)$/m);
  assert.match(result.stdout, /^ok +opencode: agent worker exists$/m);
  assert.doesNotMatch(result.stdout + result.stderr, /SECRET|apiKey|primary|allow\b/);
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
  assert.match(out, /^ok +codex rules: ps e is forbidden$/m);
  for (const arg of ['-E', 'eww', 'auxe', 'auxeww']) assert.match(out, new RegExp(`^missing +codex rules: ps ${arg} is not forbidden`, 'm'));
  assert.match(out, /^missing +opencode: agent worker/m);
  assert.match(out, /^missing +pi: .*herdr-guard\.ts$/m);
  assert.match(out, /^ok +models\.json claude: --permission-mode auto$/m);
  assert.match(out, /^ok +models\.json opencode: --agent worker$/m);
  assert.match(out, /^ok +models\.json pi: --no-approve$/m);
  assert.match(out, /^ok +models\.json pi: --no-extensions$/m);

  // A parent folder of the private directory also makes it writable.
  fs.writeFileSync(config, codexConfig([path.join(f.home, '.herdr-boss'), path.join(f.home, '.config')]));
  assert.match(run(f, ['harness', 'check']).stdout, /^bad +codex writable_roots: .*\.config\/herdr-boss must not be writable$/m);
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
  const expected = before.replace(`  "${path.join(beta, '.git')}",\n`, `  "${path.join(beta, '.git')}",\n  "${path.join(f.home, '.herdr-boss')}",\n  "${path.join(alpha, '.git')}",\n`);
  assert.equal(after, expected);
  assert.equal(fs.statSync(config).mode & 0o777, 0o600);
  const backups = fs.readdirSync(path.dirname(config)).filter((name) => /^config\.toml\.bak-\d{8}T\d{6}Z$/.test(name));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(config), backups[0]), 'utf8'), before);
  // The Claude lines are printed for the Owner; the settings file is not touched.
  assert.match(result.stdout, /\*\*Herdr Boss projects\*\*: .*Beta \(example\/beta\), .*Alpha/);
  assert.equal(fs.existsSync(path.join(f.home, '.claude', 'settings.json')), false);

  // A second run finds nothing to add and makes no new backup.
  const again = run(f, ['harness', 'sync', '--codex-only']);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /nothing to add/);
  assert.doesNotMatch(again.stdout, /Herdr Boss projects/);
  assert.equal(fs.readdirSync(path.dirname(config)).filter((name) => name.startsWith('config.toml.bak-')).length, 1);
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
  assert.match(result.stdout, /Dry run/);
  assert.equal(fs.readFileSync(config, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.dirname(config)).filter((name) => name.startsWith('config.toml.bak-')), []);
});
