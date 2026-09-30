import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.js');
const MARKER = 'docs/orchestration/herdr-boss.md';

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-parent-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dataDir = path.join(home, 'boss');
  fs.mkdirSync(dataDir, { recursive: true });
  return { home, dataDir };
}

function run(f, args) {
  const env = { ...process.env, HOME: f.home, HERDR_BOSS_DIR: f.dataDir, TMPDIR: f.home };
  delete env.XDG_CONFIG_HOME;
  return spawnSync(process.execPath, [CLI, ...args], { cwd: f.home, env, encoding: 'utf8' });
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function projects(f, repos) {
  write(path.join(f.dataDir, 'project-repos.json'), JSON.stringify(repos.map((repo) => ({ slug: path.basename(repo).toLowerCase(), repo, remote: '' }))));
}

function settings(f, environment) {
  const file = path.join(f.home, '.claude', 'settings.json');
  write(file, JSON.stringify({ autoMode: { environment, allow: ['$defaults'] } }));
  return file;
}

function parentLine(f, parents) {
  return `**Herdr Boss projects**: every repository under ${parents.join(' or ')} that contains the file ${MARKER} is a Herdr Boss project. Worker worktrees are in ${f.home}/Projects/.herdr-wt/<repo>/<name>.`;
}

function claudeFindings(result) {
  return result.stdout.split('\n').filter((line) => /^(ok|missing|bad) +claude autoMode:/.test(line));
}

test('harness check accepts the per-project line', (t) => {
  const f = fixture(t);
  const alpha = path.join(f.home, 'work', 'apps', 'alpha');
  projects(f, [alpha]);
  settings(f, [`**Herdr Boss projects**: ${alpha} (o/alpha). Worker worktrees are in ${f.home}/Projects/.herdr-wt/<repo>/<name>.`]);
  const lines = claudeFindings(run(f, ['harness', 'check']));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^ok +claude autoMode: .*names .*alpha \(alpha\)$/);
});

test('harness check accepts a parent folder line and says which projects it covers', (t) => {
  const f = fixture(t);
  const alpha = path.join(f.home, 'work', 'apps', 'alpha');
  const beta = path.join(f.home, 'work', 'tools', 'beta');
  projects(f, [alpha, beta]);
  settings(f, [parentLine(f, [`${f.home}/work/apps/`, `${f.home}/work/tools/`])]);
  const lines = claudeFindings(run(f, ['harness', 'check']));
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[0], /^ok +claude autoMode: .*covers .*alpha \(alpha\) through the parent folder .*work\/apps$/);
  assert.match(lines[1], /^ok +claude autoMode: .*covers .*beta \(beta\) through the parent folder .*work\/tools$/);
});

test('harness check accepts a ~ parent folder and a parent without a trailing slash', (t) => {
  const f = fixture(t);
  projects(f, [path.join(f.home, 'work', 'apps', 'alpha')]);
  settings(f, [parentLine(f, ['~/work/apps'])]);
  assert.match(claudeFindings(run(f, ['harness', 'check']))[0], /^ok +claude autoMode: .*covers/);
});

test('harness check reports a project outside every named parent as missing', (t) => {
  const f = fixture(t);
  const alpha = path.join(f.home, 'work', 'apps', 'alpha');
  const gamma = path.join(f.home, 'other', 'gamma');
  projects(f, [alpha, gamma]);
  settings(f, [parentLine(f, [`${f.home}/work/apps/`])]);
  const result = run(f, ['harness', 'check']);
  const lines = claudeFindings(result);
  assert.match(lines[0], /^ok +claude autoMode: .*covers .*alpha/);
  assert.match(lines[1], /^missing +claude autoMode: .*does not name .*gamma \(gamma\)$/);
  assert.equal(result.status, 1);
});

test('harness check does not count a line without the marker rule as a parent line', (t) => {
  const f = fixture(t);
  projects(f, [path.join(f.home, 'work', 'apps', 'alpha')]);
  settings(f, [`**Herdr Boss projects**: folders under ${f.home}/work/apps/ are projects.`]);
  assert.match(claudeFindings(run(f, ['harness', 'check']))[0], /^missing +claude autoMode: .*does not name .*alpha/);
});

test('harness check does not count a line that names one project as the parent of a sibling', (t) => {
  const f = fixture(t);
  const alpha = path.join(f.home, 'work', 'apps', 'alpha');
  const beta = path.join(f.home, 'work', 'apps', 'beta');
  projects(f, [alpha, beta]);
  settings(f, [parentLine(f, [alpha])]);
  const lines = claudeFindings(run(f, ['harness', 'check']));
  assert.match(lines[0], /^ok +claude autoMode: .*names .*alpha/);
  assert.match(lines[1], /^missing +claude autoMode: .*does not name .*beta/);
});

test('harness check ignores a line that names the home folder as a parent', (t) => {
  const f = fixture(t);
  projects(f, [path.join(f.home, 'work', 'apps', 'alpha')]);
  settings(f, [parentLine(f, [`${f.home}/`])]);
  assert.match(claudeFindings(run(f, ['harness', 'check']))[0], /^missing +claude autoMode: .*does not name .*alpha/);
});

test('harness sync accepts a parent folder line without a difference', (t) => {
  const f = fixture(t);
  projects(f, [path.join(f.home, 'work', 'apps', 'alpha')]);
  settings(f, [parentLine(f, [`${f.home}/work/apps/`])]);
  const result = run(f, ['harness', 'sync', '--dry-run']);
  assert.doesNotMatch(result.stdout, /change environment "Herdr Boss projects"|missing path:/, result.stdout);
});

test('harness sync reports a project outside the named parent folders', (t) => {
  const f = fixture(t);
  const gamma = path.join(f.home, 'other', 'gamma');
  projects(f, [path.join(f.home, 'work', 'apps', 'alpha'), gamma]);
  settings(f, [parentLine(f, [`${f.home}/work/apps/`])]);
  const result = run(f, ['harness', 'sync', '--dry-run']);
  assert.ok(result.stdout.includes('change environment "Herdr Boss projects"'), result.stdout);
  assert.deepEqual(result.stdout.split('\n').filter((line) => line.startsWith('missing path:')), [`missing path: ${gamma}`]);
});

test('harness sync recommends each distinct parent once, sorted, with the marker rule', (t) => {
  const f = fixture(t);
  projects(f, [
    path.join(f.home, 'work', 'tools', 'beta'),
    path.join(f.home, 'work', 'apps', 'alpha'),
    path.join(f.home, 'work', 'apps', 'delta'),
  ]);
  const result = run(f, ['harness', 'sync', '--dry-run']);
  const line = result.stdout.split('\n').find((entry) => entry.includes('**Herdr Boss projects**'));
  assert.ok(line, result.stdout);
  assert.ok(line.includes(`every repository under ${f.home}/work/apps/ or ${f.home}/work/tools/ that contains the file ${MARKER}`), line);
  assert.equal(line.split(`${f.home}/work/apps/`).length, 2);
  assert.ok(line.includes(`Worker worktrees are in ${f.home}/Projects/.herdr-wt/<repo>/<name>.`), line);
});

test('harness sync deduplicates a parent inside another parent', (t) => {
  const f = fixture(t);
  projects(f, [path.join(f.home, 'work', 'alpha'), path.join(f.home, 'work', 'apps', 'beta')]);
  const line = run(f, ['harness', 'sync', '--dry-run']).stdout.split('\n').find((entry) => entry.includes('**Herdr Boss projects**'));
  assert.ok(line.includes(`every repository under ${f.home}/work/ that contains`), line);
  assert.ok(!line.includes(`${f.home}/work/apps/ `), line);
});

test('harness sync refuses to name the home folder, a parent above it, or the root', (t) => {
  const f = fixture(t);
  const direct = path.join(f.home, 'solo');
  const rootChild = '/herdr-parent-test-root-child';
  projects(f, [direct, rootChild, path.join(f.home, 'work', 'apps', 'alpha')]);
  const line = run(f, ['harness', 'sync', '--dry-run']).stdout.split('\n').find((entry) => entry.includes('**Herdr Boss projects**'));
  assert.ok(line.includes(`every repository under ${f.home}/work/apps/ that contains`), line);
  assert.ok(!line.includes(`under ${f.home}/ `) && !line.includes('under / '), line);
  assert.ok(line.includes(direct), 'a project under an unusable parent is named by path');
  assert.ok(line.includes(rootChild), 'a project under the root is named by path');
});

test('harness sync names at most 10 parents', (t) => {
  const f = fixture(t);
  projects(f, Array.from({ length: 12 }, (_v, i) => path.join(f.home, 'work', `p${String(i).padStart(2, '0')}`, 'repo')));
  const line = run(f, ['harness', 'sync', '--dry-run']).stdout.split('\n').find((entry) => entry.includes('**Herdr Boss projects**'));
  const named = line.match(new RegExp(`${f.home}/work/p\\d\\d/(?= |\\.)`, 'g')) ?? [];
  assert.equal(new Set(named).size, 10, line);
});

test('harness sync leaves ~/.claude/settings.json unchanged and prints no secret', (t) => {
  const f = fixture(t);
  projects(f, [path.join(f.home, 'work', 'apps', 'alpha')]);
  const file = path.join(f.home, '.claude', 'settings.json');
  write(file, JSON.stringify({ apiKeyHelper: 'SECRET-HELPER-VALUE', autoMode: { environment: ['**Owner note**: KEEP-ENV-PRIVATE'], allow: ['$defaults'] } }));
  const before = fs.readFileSync(file, 'utf8');
  const result = run(f, ['harness', 'sync']);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.doesNotMatch(result.stdout + result.stderr, /SECRET|KEEP-ENV-PRIVATE/);
  assert.ok(result.stdout.includes(`every repository under ${f.home}/work/apps/`), result.stdout);
});

function mkdirs(...dirs) { for (const dir of dirs) fs.mkdirSync(dir, { recursive: true }); }

test('harness check compares real paths when the repo is registered under a symlink', (t) => {
  const f = fixture(t);
  const real = path.join(f.home, 'real');
  mkdirs(path.join(real, 'apps', 'alpha'));
  fs.symlinkSync(real, path.join(f.home, 'link'));
  projects(f, [path.join(f.home, 'link', 'apps', 'alpha')]);
  settings(f, [parentLine(f, [`${real}/apps/`])]);
  assert.match(claudeFindings(run(f, ['harness', 'check']))[0], /^ok +claude autoMode: .*covers/);
});

test('harness check compares real paths when the line names a symlink', (t) => {
  const f = fixture(t);
  const real = path.join(f.home, 'real');
  mkdirs(path.join(real, 'apps', 'alpha'));
  fs.symlinkSync(real, path.join(f.home, 'link'));
  projects(f, [path.join(real, 'apps', 'alpha')]);
  settings(f, [parentLine(f, [`${f.home}/link/apps/`])]);
  assert.match(claudeFindings(run(f, ['harness', 'check']))[0], /^ok +claude autoMode: .*covers/);
});

test('harness check resolves .. in a parent folder of the line', (t) => {
  const f = fixture(t);
  projects(f, [path.join(f.home, 'work', 'tools', 'x')]);
  settings(f, [parentLine(f, [`${f.home}/work/apps/../tools/`])]);
  assert.match(claudeFindings(run(f, ['harness', 'check']))[0], /^ok +claude autoMode: .*covers .*through the parent folder .*work\/tools$/);
  settings(f, [parentLine(f, [`${f.home}/work/tools/../apps/`])]);
  assert.match(claudeFindings(run(f, ['harness', 'check']))[0], /^missing +claude autoMode: /);
});

test('harness check does not match a parent whose name only starts like a named folder', (t) => {
  const f = fixture(t);
  projects(f, [path.join(f.home, 'work', 'apps', 'alpha')]);
  settings(f, [parentLine(f, [`${f.home}/work/apps.old/`])]);
  assert.match(claudeFindings(run(f, ['harness', 'check']))[0], /^missing +claude autoMode: /);
  settings(f, [`**Herdr Boss projects**: every repository under ${f.home}/work/apps. A repository that holds the file ${MARKER} is a project.`]);
  assert.match(claudeFindings(run(f, ['harness', 'check']))[0], /^ok +claude autoMode: .*covers/);
});

test('harness check requires the marker file in the sentence that states the rule', (t) => {
  const f = fixture(t);
  projects(f, [path.join(f.home, 'work', 'apps', 'alpha')]);
  const tail = `Worker worktrees are in ${f.home}/Projects/.herdr-wt/<repo>/<name>.`;
  for (const text of [
    `every repository under ${f.home}/work/apps/ is a project. The file ${MARKER} is not required.`,
    `every repository under ${f.home}/work/apps/ is a project, and it does not contain the file ${MARKER}.`,
    `every repository under ${f.home}/work/apps/ is a project. See ${MARKER}.`,
  ]) {
    settings(f, [`**Herdr Boss projects**: ${text} ${tail}`]);
    assert.match(claudeFindings(run(f, ['harness', 'check']))[0], /^missing +claude autoMode: /, text);
  }
  settings(f, [`**Herdr Boss projects**: every repository under ${f.home}/work/apps/ that holds ${MARKER} is a project. ${tail}`]);
  assert.match(claudeFindings(run(f, ['harness', 'check']))[0], /^ok +claude autoMode: .*covers/);
});

test('harness sync names a project singly when it needs an eleventh parent, and the line still covers it', async (t) => {
  const f = fixture(t);
  const repos = Array.from({ length: 12 }, (_v, i) => path.join(f.home, 'work', `p${String(i).padStart(2, '0')}`, 'repo'));
  const { parentFolders } = await import(pathToFileURL(path.join(ROOT, 'src', 'harness.js')).href);
  const { parents, single } = parentFolders(repos, f.home);
  assert.equal(parents.length, 10);
  assert.deepEqual(single, repos.slice(10));
  projects(f, repos);
  const line = /"(\*\*Herdr Boss projects\*\*[^"]*)"/.exec(run(f, ['harness', 'sync', '--dry-run']).stdout)?.[1];
  assert.ok(line);
  settings(f, [line]);
  const findings = claudeFindings(run(f, ['harness', 'check']));
  assert.equal(findings.length, 12);
  assert.ok(findings.every((entry) => entry.startsWith('ok ')), findings.join('\n'));
});
