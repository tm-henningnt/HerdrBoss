// The CLI of `herdr-boss project register`: store, add, edit, import, sync, list, and the audit file.
// Each test runs the CLI in a temporary HOME and HERDR_BOSS_DIR with a fake herdr on PATH.
import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripRemoteCredentials } from '../src/harness.js';
import { githubRepoFromRemote, remoteProblem } from '../src/project-register.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const REPO = path.resolve(path.dirname(CLI), '..');
const TMP = path.resolve(os.tmpdir()).startsWith(REPO) ? '/tmp' : os.tmpdir();

// A fake herdr answers the caller check and returns empty project state unless a test sets explicit rows.
// FAKE_HERDR_LABEL picks the pane label. FAKE_HERDR_FAIL_WORKSPACE makes the workspace list fail.
const HERDR_SCRIPT = `#!/bin/sh
if [ "$1" = "pane" ] && [ "$2" = "get" ]; then
  printf '{"pane":{"pane_id":"%s","label":"%s","workspace_id":"ws-1"}}\\n' "$3" "\${FAKE_HERDR_LABEL:-boss}"
  exit 0
fi
if [ "$1" = "workspace" ] && [ "$2" = "list" ]; then
  if [ -n "$FAKE_HERDR_FAIL_WORKSPACE" ]; then exit 1; fi
  if [ -n "$FAKE_HERDR_WORKSPACES" ]; then
    printf '%s\\n' "$FAKE_HERDR_WORKSPACES"
  else
    printf '%s\\n' '{"workspaces":[]}'
  fi
  exit 0
fi
if [ "$1" = "pane" ] && [ "$2" = "list" ]; then
  if [ -n "$FAKE_HERDR_PANES" ]; then
    printf '%s\\n' "$FAKE_HERDR_PANES"
  else
    printf '%s\\n' '{"panes":[]}'
  fi
  exit 0
fi
if [ "$1" = "agent" ] && [ "$2" = "list" ]; then
  if [ -n "$FAKE_HERDR_AGENTS" ]; then
    printf '%s\\n' "$FAKE_HERDR_AGENTS"
  else
    printf '%s\\n' '{"agents":[]}'
  fi
  exit 0
fi
printf '%s\\n' '{}'
`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(TMP, 'herdr-register-'));
  const home = path.join(root, 'home');
  const dataDir = path.join(root, 'data');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(dataDir);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'herdr'), HERDR_SCRIPT, { mode: 0o755 });
  // The fake herdr must be the herdr that the CLI finds. The fixture is the Owner, so no other Herdr variable changes the caller check.
  const base = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: home, HERDR_BOSS_DIR: dataDir };
  const run = (args, env = base) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: 'utf8' });
  const registerPath = path.join(dataDir, 'project-register.json');
  const auditPath = path.join(dataDir, 'project-audit.jsonl');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home, dataDir, base, run, registerPath, auditPath };
}

function record(slug, over = {}) {
  return {
    slug,
    title: slug,
    group: '',
    repo: '',
    remote: '',
    factory: 'factory-zero',
    state: 'parked',
    pinned: false,
    priority: 'normal',
    issueSource: null,
    autoOpen: 'off',
    lastOpenedAt: '',
    lastActivityAt: '',
    nextAction: '',
    notes: '',
    createdAt: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

function writeRegisterFile(dataDir, records) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'project-register.json'), `${JSON.stringify({ version: 1, projects: records }, null, 2)}\n`, { mode: 0o600 });
}

function readRegisterFile(f) {
  return JSON.parse(fs.readFileSync(f.registerPath, 'utf8'));
}

function readAudit(f) {
  return fs.readFileSync(f.auditPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

const mode = (file) => fs.statSync(file).mode & 0o777;

test('project register list prints the empty message', (t) => {
  const f = fixture(t);
  const result = f.run(['project', 'register', 'list']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'No projects in the register.\n');
  assert.ok(!fs.existsSync(f.registerPath), 'list writes no register');
});

test('project register add writes the record with mode 0600 and one audit line', (t) => {
  const f = fixture(t);
  const repoPath = path.join(f.root, 'repos', 'acme-web');
  const result = f.run([
    'project', 'register', 'add', 'acme-web',
    '--title', 'Acme Web',
    '--group', 'web',
    '--repo', repoPath,
    '--remote', 'acme/acme-web',
    '--priority', 'high',
    '--next-action', 'Ship the report',
    '--issue-repo', 'acme/acme-web',
    '--issue-label', 'ready-for-agent',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Added acme-web to the register.\n');

  assert.ok(fs.existsSync(f.registerPath), 'add writes the register');
  assert.equal(mode(f.registerPath), 0o600, 'the register file has mode 0600');
  const data = readRegisterFile(f);
  assert.equal(data.version, 1);
  assert.equal(data.projects.length, 1);
  const stored = data.projects[0];
  assert.deepEqual(stored, {
    slug: 'acme-web',
    title: 'Acme Web',
    group: 'web',
    clientTag: '',
    repo: repoPath,
    remote: 'acme/acme-web',
    factory: 'factory-zero',
    state: 'parked',
    pinned: false,
    priority: 'high',
    issueSource: { repo: 'acme/acme-web', label: 'ready-for-agent' },
    autoOpen: 'off',
    lastOpenedAt: '',
    lastActivityAt: '',
    nextAction: 'Ship the report',
    notes: '',
    createdAt: stored.createdAt,
  });
  assert.ok(Number.isFinite(Date.parse(stored.createdAt)), 'createdAt is an ISO time');

  assert.ok(fs.existsSync(f.auditPath), 'add writes the audit file');
  assert.equal(mode(f.auditPath), 0o600, 'the audit file has mode 0600');
  const lines = readAudit(f);
  assert.equal(lines.length, 1);
  const raw = fs.readFileSync(f.auditPath, 'utf8');
  assert.deepEqual(Object.keys(lines[0]).sort(), ['action', 'at', 'by', 'dryRun', 'failedCheck', 'result', 'slug'].sort());
  assert.match(lines[0].at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'at is an ISO time');
  assert.equal(lines[0].slug, 'acme-web');
  assert.equal(lines[0].action, 'register-add');
  assert.equal(lines[0].by, 'owner-cli');
  assert.equal(lines[0].result, 'done');
  assert.equal(lines[0].failedCheck, null);
  assert.equal(lines[0].dryRun, false);
  assert.ok(!raw.includes(repoPath), 'the audit line holds no path');
  assert.ok(!raw.includes('acme/acme-web'), 'the audit line holds no remote');
});

test('project register add uses the factory triage label when the issue source has no override', (t) => {
  const f = fixture(t);
  const result = f.run(['project', 'register', 'add', 'cedar-tool', '--issue-repo', 'example/cedar-tool']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readRegisterFile(f).projects[0].issueSource, { repo: 'example/cedar-tool', label: '' });
});

test('project register add uses a GitHub remote as the default issue source', (t) => {
  const f = fixture(t);
  const result = f.run(['project', 'register', 'add', 'juniper-api', '--remote', 'example/juniper-api']);
  assert.equal(result.status, 0, result.stderr);
  const stored = readRegisterFile(f).projects[0];
  assert.deepEqual(stored.issueSource, { repo: 'example/juniper-api', label: '' });
});

test('project register add can set a label override for a GitHub remote', (t) => {
  const f = fixture(t);
  const result = f.run(['project', 'register', 'add', 'juniper-api', '--remote', 'example/juniper-api', '--issue-label', 'security-review']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readRegisterFile(f).projects[0].issueSource, { repo: 'example/juniper-api', label: 'security-review' });
});

test('project register edit changes an issue label without repeating the issue repository', (t) => {
  const f = fixture(t);
  assert.equal(f.run(['project', 'register', 'add', 'juniper-api', '--remote', 'example/juniper-api']).status, 0);
  const result = f.run(['project', 'register', 'edit', 'juniper-api', '--issue-label', 'security-review']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readRegisterFile(f).projects[0].issueSource, { repo: 'example/juniper-api', label: 'security-review' });
});

test('register recognizes GitHub remotes and ignores other hosts or nested paths', () => {
  assert.equal(githubRepoFromRemote('example/juniper-api'), 'example/juniper-api');
  assert.equal(githubRepoFromRemote('example/juniper-api.git'), 'example/juniper-api');
  assert.equal(githubRepoFromRemote('https://github.com/example/juniper-api.git'), 'example/juniper-api');
  assert.equal(githubRepoFromRemote('ssh://git@github.com/example/juniper-api.git'), 'example/juniper-api');
  assert.equal(githubRepoFromRemote('git@github.com:example/juniper-api.git'), 'example/juniper-api');
  assert.equal(githubRepoFromRemote('https://gitlab.com/example/juniper-api.git'), null);
  assert.equal(githubRepoFromRemote('https://github.com/example/juniper-api/issues'), null);
});

test('project register add --dry-run writes nothing', (t) => {
  const f = fixture(t);
  const result = f.run(['project', 'register', 'add', 'orchard-api', '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Dry run: would add orchard-api to the register.\n');
  assert.ok(!fs.existsSync(f.registerPath), 'a dry run writes no register');
  assert.ok(!fs.existsSync(f.auditPath), 'a dry run writes no audit file');
});

test('project register add refuses a duplicate slug and keeps the record', (t) => {
  const f = fixture(t);
  const first = f.run(['project', 'register', 'add', 'acme-web']);
  assert.equal(first.status, 0, first.stderr);
  const again = f.run(['project', 'register', 'add', 'acme-web']);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already in the register/);
  assert.equal(again.stdout, '');
  assert.equal(readRegisterFile(f).projects.length, 1, 'the register keeps one record for the slug');
});

test('project register add refuses a value that matches the secret scan and prints no value', (t) => {
  const f = fixture(t);
  const secret = 'password=abcdefghijklmnop';
  const result = f.run(['project', 'register', 'add', 'acme-web', '--title', `login ${secret}`]);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1);
  assert.match(output, /secret scan/);
  assert.match(output, /credential assignment/, 'the refusal names the class of the secret');
  assert.ok(!output.includes(secret), 'the refusal prints no value');
  assert.ok(!fs.existsSync(f.registerPath), 'the register is not written');
  assert.ok(!fs.existsSync(f.auditPath), 'the audit file is not written');
});

test('project register add refuses a remote with credentials or a bad shape and prints no value', (t) => {
  const f = fixture(t);
  const cred = f.run(['project', 'register', 'add', 'acme-web', '--remote', 'https://user:secretpass1@example.invalid/acme/web']);
  const credOutput = `${cred.stdout}${cred.stderr}`;
  assert.equal(cred.status, 1);
  assert.match(credOutput, /must not hold credentials/);
  assert.ok(!credOutput.includes('secretpass1'), 'the refusal prints no value');

  const shape = f.run(['project', 'register', 'add', 'acme-web', '--remote', 'not a remote']);
  assert.equal(shape.status, 1);
  assert.match(shape.stderr, /owner\/name or a URL/);
  assert.ok(!fs.existsSync(f.registerPath), 'the register is not written');
});

test('project register edit changes the Owner fields and writes one audit line', (t) => {
  const f = fixture(t);
  const added = f.run(['project', 'register', 'add', 'acme-web', '--title', 'Acme Web']);
  assert.equal(added.status, 0, added.stderr);

  const edited = f.run(['project', 'register', 'edit', 'acme-web', '--group', 'apps', '--priority', 'low', '--notes', 'focus now']);
  assert.equal(edited.status, 0, edited.stderr);
  assert.equal(edited.stdout, 'Edited acme-web: group, priority, notes\n');
  assert.ok(!edited.stdout.includes('focus now'), 'the edit prints field names, never values');

  const stored = readRegisterFile(f).projects[0];
  assert.equal(stored.group, 'apps');
  assert.equal(stored.priority, 'low');
  assert.equal(stored.notes, 'focus now');
  assert.equal(stored.title, 'Acme Web', 'an untouched field stays');

  const lines = readAudit(f);
  assert.equal(lines.length, 2, 'one audit line per register write');
  assert.equal(lines[1].action, 'register-edit');
  assert.ok(!Object.hasOwn(lines[1], 'command'));
  assert.equal(lines[1].slug, 'acme-web');
});

test('project register stores the client tag separately from the project area', (t) => {
  const f = fixture(t);
  const added = f.run(['project', 'register', 'add', 'pine-api', '--group', 'platform', '--client-tag', 'Example Client']);
  assert.equal(added.status, 0, added.stderr);
  assert.ok(!added.stdout.includes('Example Client'), 'the command does not print the tag value');
  assert.equal(readRegisterFile(f).projects[0].group, 'platform');
  assert.equal(readRegisterFile(f).projects[0].clientTag, 'Example Client');

  const edited = f.run(['project', 'register', 'edit', 'pine-api', '--client-tag', 'Sample Studio']);
  assert.equal(edited.status, 0, edited.stderr);
  assert.equal(edited.stdout, 'Edited pine-api: clientTag\n');
  assert.ok(!edited.stdout.includes('Sample Studio'), 'the edit prints the field name, never the tag value');
  assert.equal(readRegisterFile(f).projects[0].clientTag, 'Sample Studio');
});

test('project register pins only open projects and refuses a fourth pinned project', (t) => {
  const f = fixture(t);
  writeRegisterFile(f.dataDir, [
    record('focus-one', { state: 'open', pinned: true }),
    record('focus-two', { state: 'open', pinned: true }),
    record('focus-three', { state: 'open', pinned: true }),
    record('focus-next', { state: 'open' }),
    record('parked-next'),
  ]);
  const fourth = f.run(['project', 'register', 'edit', 'focus-next', '--pinned', 'on']);
  assert.equal(fourth.status, 1);
  assert.match(fourth.stderr, /up to three pinned projects/);
  assert.equal(readRegisterFile(f).projects.find((item) => item.slug === 'focus-next').pinned, false);

  const parked = f.run(['project', 'register', 'edit', 'parked-next', '--pinned', 'on']);
  assert.equal(parked.status, 1);
  assert.match(parked.stderr, /Only an open project can be pinned/);
  assert.equal(readRegisterFile(f).projects.find((item) => item.slug === 'parked-next').pinned, false);
  assert.equal(fs.existsSync(f.auditPath), false, 'refused pins write no audit entry');
});

test('project register edit refuses an unknown flag, a bad value, a missing record, and an empty edit', (t) => {
  const f = fixture(t);
  const added = f.run(['project', 'register', 'add', 'acme-web']);
  assert.equal(added.status, 0, added.stderr);

  const unknown = f.run(['project', 'register', 'edit', 'acme-web', '--state', 'open']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown option: --state/);

  const badValue = f.run(['project', 'register', 'edit', 'acme-web', '--priority', 'urgent']);
  assert.equal(badValue.status, 1);
  assert.match(badValue.stderr, /must be high, normal, or low/);

  const missing = f.run(['project', 'register', 'edit', 'no-such-project', '--group', 'web']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /is not in the register/);

  const empty = f.run(['project', 'register', 'edit', 'acme-web']);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /Give at least one field/);

  const stored = readRegisterFile(f).projects[0];
  assert.equal(stored.group, '', 'a refused edit changes nothing');
  assert.equal(readAudit(f).length, 1, 'a refused edit writes no audit line');
});

test('project register list filters by state and group and prints JSON', (t) => {
  const f = fixture(t);
  const orchard = record('orchard-api', { state: 'open', title: 'Orchard API' });
  const acme = record('acme-web', { group: 'web', title: 'Acme Web' });
  writeRegisterFile(f.dataDir, [orchard, acme]);
  const line = (entry) => `${entry.slug.padEnd(16)}${entry.state.padEnd(9)}${(entry.group || '-').padEnd(16)}${entry.title}`;

  const all = f.run(['project', 'register', 'list']);
  assert.equal(all.status, 0, all.stderr);
  assert.equal(all.stdout, `${line(acme)}\n${line(orchard)}\n`, 'the list is sorted by slug');

  const open = f.run(['project', 'register', 'list', '--state', 'open']);
  assert.equal(open.status, 0, open.stderr);
  assert.equal(open.stdout, `${line(orchard)}\n`);

  const group = f.run(['project', 'register', 'list', '--group', 'web']);
  assert.equal(group.status, 0, group.stderr);
  assert.equal(group.stdout, `${line(acme)}\n`);

  const json = f.run(['project', 'register', 'list', '--json']);
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), [acme, orchard]);
});

test('the register store refuses an unknown field or an invalid stored value and echoes no secret-looking name', (t) => {
  const f = fixture(t);
  writeRegisterFile(f.dataDir, [{ ...record('acme-web'), 'token=abcdefghijklmnop': 'x' }]);
  const unknown = f.run(['project', 'register', 'list']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown field/);
  assert.ok(!unknown.stderr.includes('abcdefghijklmnop'), 'the refusal echoes no secret-looking field name');

  writeRegisterFile(f.dataDir, [record('acme-web', { priority: 'urgent' })]);
  const invalid = f.run(['project', 'register', 'list']);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /must be high, normal, or low/);
});

test('project register import adds a record for each source, keeps edits, and is idempotent', (t) => {
  const f = fixture(t);
  const repoA = path.join(f.root, 'repos', 'acme-web');
  const repoB = path.join(f.root, 'repos', 'harbor-docs');
  fs.writeFileSync(path.join(f.dataDir, 'project-repos.json'), JSON.stringify([
    { slug: 'acme-web', repo: repoA, remote: 'acme/acme-web' },
    { slug: 'harbor-docs', repo: repoB, remote: '' },
  ]));
  fs.writeFileSync(path.join(f.dataDir, 'policy.json'), JSON.stringify({ projects: { 'orchard-api': { share: 10 } } }));
  fs.mkdirSync(path.join(f.dataDir, 'projects'));
  fs.writeFileSync(path.join(f.dataDir, 'projects', 'kite-sdk.json'), JSON.stringify({ project: 'Kite SDK', updated: '2026-10-01T00:00:00.000Z' }));

  const liveHerdr = {
    FAKE_HERDR_WORKSPACES: JSON.stringify({ workspaces: [{ id: 'ws-a', label: 'acme-web' }, { id: 'ws-k', label: 'kite-sdk' }] }),
    FAKE_HERDR_PANES: JSON.stringify({ panes: [{ pane_id: 'p-a', workspace_id: 'ws-a', label: 'orch' }, { pane_id: 'p-k', workspace_id: 'ws-k', label: 'orch' }] }),
    FAKE_HERDR_AGENTS: JSON.stringify({ agents: [{ pane_id: 'p-a', name: 'acme-web-orch' }, { pane_id: 'p-k', name: 'kite-sdk-orch' }] }),
  };
  const first = f.run(['project', 'register', 'import'], { ...f.base, ...liveHerdr });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, [
    'new acme-web (open)',
    'new harbor-docs (parked)',
    'new orchard-api (parked)',
    'new kite-sdk (open)',
    '4 new records.',
    '',
  ].join('\n'));

  const stored = Object.fromEntries(readRegisterFile(f).projects.map((entry) => [entry.slug, entry]));
  assert.equal(Object.keys(stored).length, 4);
  assert.equal(stored['acme-web'].repo, repoA, 'import copies the repo of the row');
  assert.equal(stored['acme-web'].remote, 'acme/acme-web');
  assert.deepEqual(stored['acme-web'].issueSource, { repo: 'acme/acme-web', label: '' });
  assert.equal(stored['acme-web'].state, 'open', 'a Herdr workspace label opens the project');
  assert.equal(stored['acme-web'].title, 'acme-web', 'the title falls back to the slug');
  assert.equal(stored['harbor-docs'].repo, repoB);
  assert.equal(stored['harbor-docs'].state, 'parked');
  assert.equal(stored['orchard-api'].state, 'parked');
  assert.equal(stored['orchard-api'].priority, 'normal', 'the defaults of a new record hold');
  assert.equal(stored['kite-sdk'].title, 'Kite SDK', 'the title comes from the published status');
  assert.equal(stored['kite-sdk'].lastActivityAt, '2026-10-01T00:00:00.000Z', 'the activity comes from the published status');
  assert.equal(stored['kite-sdk'].state, 'open');
  assert.equal(readAudit(f).length, 4, 'one audit line per new record');
  assert.ok(readAudit(f).every((line) => line.action === 'register-add' && !Object.hasOwn(line, 'command')));

  const edited = f.run(['project', 'register', 'edit', 'acme-web', '--group', 'web']);
  assert.equal(edited.status, 0, edited.stderr);

  const second = f.run(['project', 'register', 'import'], { ...f.base, ...liveHerdr });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, '0 new records.\n');
  const after = Object.fromEntries(readRegisterFile(f).projects.map((entry) => [entry.slug, entry]));
  assert.equal(Object.keys(after).length, 4, 'import adds no second record for a slug');
  assert.equal(after['acme-web'].group, 'web', 'import keeps the edit of the Owner');
  assert.equal(readAudit(f).length, 5, 'the second import writes no audit line');
});

test('project register import matches names without case or punctuation and refreshes only derived fields', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.dataDir, 'projects'));
  fs.writeFileSync(path.join(f.dataDir, 'projects', 'alpha-store.json'), JSON.stringify({
    project: 'Status title must not replace the Owner title', updated: '2026-10-09T12:00:00.000Z',
  }));
  const ownerRecord = record('alpha-store', {
    title: 'Owner title', group: 'Owner area', nextAction: 'Owner action', state: 'parked',
    lastActivityAt: '2026-10-01T00:00:00.000Z',
  });
  writeRegisterFile(f.dataDir, [ownerRecord]);
  const herdr = {
    FAKE_HERDR_WORKSPACES: JSON.stringify({ workspaces: [{ id: 'ws-alpha', label: 'Project Alpha', name: 'Alpha_Store' }] }),
    FAKE_HERDR_PANES: JSON.stringify({ panes: [{ pane_id: 'p-alpha', workspace_id: 'ws-alpha', label: 'orch' }] }),
    FAKE_HERDR_AGENTS: JSON.stringify({ agents: [{ pane_id: 'p-alpha', name: 'alpha-store-orch', agent_status: 'idle' }] }),
  };

  const first = f.run(['project', 'register', 'import'], { ...f.base, ...herdr });
  assert.equal(first.status, 0, first.stderr);
  let stored = readRegisterFile(f).projects[0];
  assert.equal(stored.state, 'open', 'the normalized live workspace and orchestrator keep the project open');
  assert.equal(stored.lastActivityAt, '2026-10-09T12:00:00.000Z', 'published activity is derived');
  assert.equal(stored.title, 'Owner title', 'the import keeps the Owner title');
  assert.equal(stored.group, 'Owner area', 'the import keeps the Owner area');
  assert.equal(stored.nextAction, 'Owner action', 'the import keeps the Owner next action');
  const auditCount = readAudit(f).length;

  const second = f.run(['project', 'register', 'import'], { ...f.base, ...herdr });
  assert.equal(second.status, 0, second.stderr);
  stored = readRegisterFile(f).projects[0];
  assert.equal(stored.state, 'open');
  assert.equal(stored.title, 'Owner title');
  assert.equal(readAudit(f).length, auditCount, 'a repeated import writes no additional audit line');
});

test('project register import opens every live project above the configured open cap', (t) => {
  const f = fixture(t);
  const projects = ['alpha-store', 'birch-api', 'cedar-tool', 'delta-web'];
  const workspaces = projects.map((slug, index) => ({ id: `ws-${index}`, label: slug.toUpperCase().replace('-', ' ') }));
  const panes = projects.map((slug, index) => ({ pane_id: `p-${index}`, workspace_id: `ws-${index}`, label: 'orch' }));
  const agents = projects.map((_slug, index) => ({ pane_id: `p-${index}`, name: `project-${index}-orch` }));
  const result = f.run(['project', 'register', 'import'], {
    ...f.base,
    FAKE_HERDR_WORKSPACES: JSON.stringify({ workspaces }),
    FAKE_HERDR_PANES: JSON.stringify({ panes }),
    FAKE_HERDR_AGENTS: JSON.stringify({ agents }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readRegisterFile(f).projects.map((entry) => [entry.slug, entry.state]), projects.map((slug) => [slug, 'open']));
});

test('project register import --dry-run prints the same lines and writes nothing', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dataDir, 'project-repos.json'), JSON.stringify([
    { slug: 'orchard-api', repo: path.join(f.root, 'repos', 'orchard-api'), remote: '' },
  ]));

  const dry = f.run(['project', 'register', 'import', '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(dry.stdout, 'new orchard-api (parked)\n1 new records.\n');
  assert.ok(!fs.existsSync(f.registerPath), 'a dry run writes no register');
  assert.ok(!fs.existsSync(f.auditPath), 'a dry run writes no audit file');

  const real = f.run(['project', 'register', 'import']);
  assert.equal(real.status, 0, real.stderr);
  assert.equal(real.stdout, dry.stdout, 'the real run prints the same lines');
  assert.equal(readRegisterFile(f).projects.length, 1);
  assert.equal(readAudit(f).length, 1);
});

test('project register import warns and parks every record when Herdr lists no workspaces', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dataDir, 'project-repos.json'), JSON.stringify([
    { slug: 'acme-web', repo: path.join(f.root, 'repos', 'acme-web'), remote: '' },
  ]));

  const result = f.run(['project', 'register', 'import'], { ...f.base, FAKE_HERDR_FAIL_WORKSPACE: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Warning: Herdr did not list its workspaces and project leads/);
  assert.equal(result.stdout, 'new acme-web (parked)\n1 new records.\n');
  assert.equal(readRegisterFile(f).projects[0].state, 'parked');
});

test('project register import skips invalid repository slugs and counts them in a warning', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dataDir, 'project-repos.json'), JSON.stringify([
    { slug: 'good-project', repo: path.join(f.root, 'repos', 'good-project'), remote: '' },
    { slug: 'Bad_Name', repo: path.join(f.root, 'repos', 'bad-name'), remote: '' },
  ]));

  const result = f.run(['project', 'register', 'import']);
  assert.equal(result.status, 0, 'an invalid source row does not abort the import');
  assert.match(result.stderr, /Warning: skipped 1 project-repos\.json row with an invalid slug\./);
  assert.equal(result.stdout, 'new good-project (parked)\n1 new records.\n');
  assert.deepEqual(readRegisterFile(f).projects.map((entry) => entry.slug), ['good-project']);
});

test('register remote parsing removes credentials and query data and accepts SSH user names', (t) => {
  const slashPassword = 'https://user:pa/ss@host/o/n';
  const queryRemote = 'https://host/o/n?access_token=example';
  const strippedPassword = stripRemoteCredentials(slashPassword);
  const strippedQuery = stripRemoteCredentials(queryRemote);
  const strippedFragment = stripRemoteCredentials('https://host/o/n#access_token=example');
  const strippedSshUser = stripRemoteCredentials('ssh://git@github.com/o/n');
  assert.ok(strippedPassword === 'https://host/o/n', 'URL parsing removes credentials with a slash in the password');
  assert.ok(strippedQuery === 'https://host/o/n', 'URL parsing removes query data');
  assert.ok(strippedFragment === 'https://host/o/n', 'URL parsing removes fragment data');
  assert.ok(strippedSshUser === 'ssh://git@github.com/o/n', 'URL parsing keeps a bare SSH user name');
  assert.equal(remoteProblem(slashPassword), 'credentials');
  assert.notEqual(remoteProblem(queryRemote), null, 'direct validation refuses a query string');
  assert.equal(remoteProblem('ssh://git@github.com/o/n'), null, 'SSH accepts a user name without a password');
  assert.equal(remoteProblem('git@github.com:o/n.git'), null, 'scp-style SSH remotes remain valid');
  assert.equal(remoteProblem('ssh://git:example@github.com/o/n'), 'credentials', 'SSH refuses a password');
  assert.equal(remoteProblem('./repo'), 'shape');
  assert.equal(remoteProblem('../repo'), 'shape');
  assert.equal(remoteProblem('./name'), 'shape');
  assert.equal(remoteProblem('owner/..'), 'shape');
  assert.equal(remoteProblem('owner/name/subpath'), 'shape');

  const f = fixture(t);
  const ssh = f.run(['project', 'register', 'add', 'ssh-url', '--remote', 'ssh://git@github.com/o/n']);
  assert.equal(ssh.status, 0, 'register add accepts a bare SSH user name');
  const scp = f.run(['project', 'register', 'add', 'scp-url', '--remote', 'git@github.com:o/n.git']);
  assert.equal(scp.status, 0, 'register add accepts an scp-style remote');
});

test('register add and edit refuse unsafe remotes without printing or storing them', (t) => {
  const f = fixture(t);
  const slashPassword = 'https://user:pa/ss@host/o/n';
  const queryRemote = 'https://host/o/n?access_token=example';

  const add = f.run(['project', 'register', 'add', 'unsafe-remote', '--remote', slashPassword]);
  assert.equal(add.status, 1, 'add refuses HTTP user information');
  assert.ok(!add.stdout.includes('pa/ss') && !add.stderr.includes('pa/ss'), 'add prints no credential');
  assert.ok(!fs.existsSync(f.registerPath), 'add stores no rejected remote');

  const created = f.run(['project', 'register', 'add', 'safe-project']);
  assert.equal(created.status, 0);
  const edit = f.run(['project', 'register', 'edit', 'safe-project', '--remote', queryRemote]);
  assert.equal(edit.status, 1, 'edit refuses a query string');
  assert.ok(!edit.stdout.includes('access_token') && !edit.stderr.includes('access_token'), 'edit prints no query data');
  assert.equal(readRegisterFile(f).projects[0].remote, '', 'edit stores no rejected remote');
});

test('register import strips credentials and query data before storing source remotes', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dataDir, 'project-repos.json'), JSON.stringify([
    { slug: 'slash-password', repo: path.join(f.root, 'repos', 'slash-password'), remote: 'https://user:pa/ss@host/o/n' },
    { slug: 'query-remote', repo: path.join(f.root, 'repos', 'query-remote'), remote: 'https://host/o/n?access_token=example' },
  ]));

  const result = f.run(['project', 'register', 'import']);
  assert.equal(result.status, 0, 'source URLs are sanitized');
  const remotes = readRegisterFile(f).projects.map((entry) => entry.remote);
  assert.ok(remotes.every((remote) => remote === 'https://host/o/n'), 'only clean remotes are stored');
  assert.ok(!result.stdout.includes('pa/ss') && !result.stderr.includes('pa/ss'), 'import prints no credential');
  assert.ok(!result.stdout.includes('access_token') && !result.stderr.includes('access_token'), 'import prints no query data');
});

test('register sync strips credentials and query data and normalizes repository paths', (t) => {
  const f = fixture(t);
  const created = f.run(['project', 'register', 'add', 'sync-project']);
  assert.equal(created.status, 0);
  const rawRepo = `${f.root}/repos/parent/../sync-project`;
  fs.writeFileSync(path.join(f.dataDir, 'project-repos.json'), JSON.stringify([
    { slug: 'sync-project', repo: rawRepo, remote: 'https://user:pa/ss@host/o/n?access_token=example' },
  ]));

  const result = f.run(['project', 'register', 'sync']);
  assert.equal(result.status, 0);
  const stored = readRegisterFile(f).projects[0];
  assert.ok(stored.repo === path.normalize(rawRepo), 'sync normalizes the repository path');
  assert.ok(stored.remote === 'https://host/o/n', 'sync stores no credentials or query data');
  assert.ok(!result.stdout.includes('pa/ss') && !result.stderr.includes('pa/ss'), 'sync prints no credential');
  assert.ok(!result.stdout.includes('access_token') && !result.stderr.includes('access_token'), 'sync prints no query data');
});

test('register sync refuses an unparseable source remote without clearing a saved remote', (t) => {
  const f = fixture(t);
  const created = f.run(['project', 'register', 'add', 'saved-remote', '--remote', 'owner/repo']);
  assert.equal(created.status, 0);
  fs.writeFileSync(path.join(f.dataDir, 'project-repos.json'), JSON.stringify([
    { slug: 'saved-remote', repo: '', remote: 'https://user:pa/ss@?access_token=example' },
  ]));

  const result = f.run(['project', 'register', 'sync']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '0 records changed.\n');
  assert.equal(readRegisterFile(f).projects[0].remote, 'owner/repo', 'a rejected source remote does not clear a saved remote');
  assert.ok(!result.stdout.includes('access_token') && !result.stderr.includes('access_token'), 'sync prints no query data');
});

test('register add normalizes repository paths', (t) => {
  const f = fixture(t);
  const rawRepo = `${f.root}/repos/parent/../normalized-project`;
  const result = f.run(['project', 'register', 'add', 'normalized-project', '--repo', rawRepo]);
  assert.equal(result.status, 0);
  assert.ok(readRegisterFile(f).projects[0].repo === path.normalize(rawRepo), 'add stores a normalized repository path');
  const rawEditedRepo = `${f.root}/repos/other/../edited-project`;
  const edited = f.run(['project', 'register', 'edit', 'normalized-project', '--repo', rawEditedRepo]);
  assert.equal(edited.status, 0);
  assert.ok(readRegisterFile(f).projects[0].repo === path.normalize(rawEditedRepo), 'edit stores a normalized repository path');
});

test('register rejects an empty createdAt value', (t) => {
  const f = fixture(t);
  writeRegisterFile(f.dataDir, [record('empty-created-at', { createdAt: '' })]);

  const result = f.run(['project', 'register', 'list']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /createdAt.*ISO time/);
});

test('register reports an audit failure after keeping the changed record', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.auditPath);

  const result = f.run(['project', 'register', 'add', 'audit-project']);
  assert.equal(result.status, 1, 'an audit failure does not report success');
  assert.equal(result.stdout, '', 'the command reports no success before the audit line');
  assert.match(result.stderr, /register changed.*audit line could not be written/i);
  assert.deepEqual(readRegisterFile(f).projects.map((entry) => entry.slug), ['audit-project']);
});

test('register writes use and release the project-register mutation lock', (t) => {
  const f = fixture(t);
  const lockDirectory = path.join(f.dataDir, 'locks', 'project-register');

  const result = f.run(['project', 'register', 'add', 'locked-project']);
  assert.equal(result.status, 0);
  assert.ok(fs.statSync(lockDirectory).isDirectory(), 'the command uses the mutation lock directory');
  assert.ok(!fs.existsSync(path.join(lockDirectory, '.mutation')), 'the command releases its lock');
});

test('project register sync copies repo and remote, is idempotent, and matches its dry run', (t) => {
  const f = fixture(t);
  const added = f.run(['project', 'register', 'add', 'acme-web', '--title', 'Acme Web']);
  assert.equal(added.status, 0, added.stderr);
  const repoPath = path.join(f.root, 'repos', 'acme-web');
  const rowsFile = path.join(f.dataDir, 'project-repos.json');
  const firstUrl = 'https://example.invalid/acme/web';
  fs.writeFileSync(rowsFile, JSON.stringify([{ slug: 'acme-web', repo: repoPath, remote: firstUrl }]));

  const first = f.run(['project', 'register', 'sync']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, 'sync acme-web: repo, remote\n1 records changed.\n');
  let stored = readRegisterFile(f).projects[0];
  assert.equal(stored.repo, repoPath);
  assert.equal(stored.remote, firstUrl);
  let lines = readAudit(f);
  assert.equal(lines.length, 2, 'one audit line per register write, the add and the sync');
  assert.equal(lines[1].action, 'register-edit');
  assert.ok(!Object.hasOwn(lines[1], 'command'));

  const again = f.run(['project', 'register', 'sync']);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, '0 records changed.\n', 'a second sync changes nothing');
  assert.equal(readAudit(f).length, 2, 'an unchanged sync writes no audit line');

  fs.writeFileSync(rowsFile, JSON.stringify([{ slug: 'acme-web', repo: repoPath, remote: 'acme/acme-web' }]));
  const dry = f.run(['project', 'register', 'sync', '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(dry.stdout, 'sync acme-web: remote\n1 records changed.\n');
  assert.equal(readRegisterFile(f).projects[0].remote, firstUrl, 'a dry run changes nothing');
  assert.equal(readAudit(f).length, 2, 'a dry run writes no audit line');

  const real = f.run(['project', 'register', 'sync']);
  assert.equal(real.status, 0, real.stderr);
  assert.equal(real.stdout, dry.stdout, 'the real run prints the same lines');
  assert.equal(readRegisterFile(f).projects[0].remote, 'acme/acme-web');
  lines = readAudit(f);
  assert.equal(lines.length, 3);
  assert.ok(!Object.hasOwn(lines[2], 'command'));
});

test('a worker pane cannot run a register command and a boss pane can', (t) => {
  const f = fixture(t);
  const paneEnv = { ...f.base, HERDR_ENV: '1', HERDR_PANE_ID: 'p1', HERDR_WORKSPACE_ID: 'ws-1' };

  const refused = f.run(['project', 'register', 'add', 'acme-web'], { ...paneEnv, FAKE_HERDR_LABEL: 'worker' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /project lead/, 'the refusal tells a worker to ask its project lead');
  assert.ok(!fs.existsSync(f.registerPath), 'the refused command writes nothing');

  const allowed = f.run(['project', 'register', 'add', 'acme-web'], paneEnv);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout, 'Added acme-web to the register.\n');
  assert.equal(readAudit(f)[0].by, 'owner-cli');
});

test('project register rejects bad usage', (t) => {
  const f = fixture(t);
  const bare = f.run(['project', 'register']);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /Usage: project register list/);

  const sub = f.run(['project', 'register', 'bogus']);
  assert.equal(sub.status, 1);
  assert.match(sub.stderr, /Usage: project register/);

  const json = f.run(['project', 'register', 'add', 'acme-web', '--json']);
  assert.equal(json.status, 1);
  assert.match(json.stderr, /Unknown option: --json/, '--json is only for register list');

  const state = f.run(['project', 'register', 'list', '--state', 'sideways']);
  assert.equal(state.status, 1);
  assert.match(state.stderr, /--state must be open, parked, parking, or archived/);

  const slug = f.run(['project', 'register', 'add', 'Acme']);
  assert.equal(slug.status, 1);
  assert.match(slug.stderr, /The project slug must match/);
  assert.ok(!fs.existsSync(f.registerPath), 'a usage error writes nothing');
});

test('a remote with an encoded delimiter or a path parameter is refused and stripped to nothing', () => {
  for (const remote of ['https://host/o/n%3Faccess_token=example', 'https://host/o/n%3fx', 'https://host/o/n;token=example', 'https://host/o/n%23x']) {
    assert.equal(remoteProblem(remote), 'credentials', remote);
    assert.equal(stripRemoteCredentials(remote), '', remote);
  }
});
