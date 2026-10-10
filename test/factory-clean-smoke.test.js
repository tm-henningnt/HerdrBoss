import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { factoryCommand } from '../src/factory-host.js';
import { writeFleet, writePrivate, factoryFile } from '../src/factory-store.js';
import { readProjectRepos, recordProjectRepo } from '../src/harness.js';
import { checkProjectPin, pinnedProjects, gitPinsDir } from '../src/git-pins.js';
import { buildCandidateRecord, readRegister, writeRegister } from '../src/project-register.js';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-clean-smoke-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const work = path.join(root, 'work'); fs.mkdirSync(work);
  const env = { HOME: root, HERDR_BOSS_DIR: path.join(root, 'data'), HERDR_FACTORIES_DIR: path.join(root, 'factories') };
  writeFleet(env, { schema: 1, contractVersion: '1.0.0', minimumFactoryVersion: '0.1.0', hosts: [{ hostId: 'local', transport: 'local', runtime: 'orbstack', personalOnly: true, codexSandbox: 'user-namespaces' }], factories: [{
    factoryId: 'demo', name: 'demo', hostId: 'local', kind: 'container', containerName: 'hf-demo', hostname: 'demo.localhost',
    ports: { dashboard: 4478, ssh: 2222 }, profile: 'personal', dashboardUrl: 'http://demo.localhost:4478', version: '0.1.0', kitRevision: 'abcdef012345',
    image: { builtAt: '2026-10-03T00:00:00Z', pinsHash: 'a'.repeat(64) },
  }] });
  writePrivate(factoryFile(env, 'demo'), { name: 'demo', hostId: 'local', ports: { dashboard: 4478, ssh: 2222 } });
  const workspaces = [{ workspace_id: 'w1', label: 'smoke-agent' }, { workspace_id: 'w2', label: 'project' }, { workspace_id: 'w3', label: 'smokey' }];
  for (const name of ['smoke-agent', 'smoke-folder', 'project', 'smokey']) {
    fs.mkdirSync(path.join(work, name)); fs.writeFileSync(path.join(work, name, 'keep.txt'), 'sample');
  }
  const calls = [], output = [];
  const ok = (body) => ({ code: 0, stdout: JSON.stringify(body), stderr: '' });
  const docker = { async run(args, options = {}) {
    calls.push({ args, options });
    if (args[0] === 'container' && args[1] === 'inspect') return ok([{ Config: { Labels: { 'herdr-factory': 'demo' } }, State: { Running: true } }]);
    if (args.includes('herdr')) {
      if (args.includes('list')) return ok({ result: { workspaces: [...workspaces] } });
      if (args.includes('close')) {
        const id = args.at(-1), index = workspaces.findIndex((row) => row.workspace_id === id);
        assert.ok(index >= 0); assert.ok(workspaces[index].label.startsWith('smoke-'));
        workspaces.splice(index, 1); return ok({});
      }
    }
    if (args.includes('node') && args.includes('-e')) {
      const scriptIndex = args.indexOf('-e', args.indexOf('node')) + 1;
      const script = args[scriptIndex].replaceAll('/home/factory/work', work)
        .replace('/home/factory/herdr-boss/src/factory-smoke-records.js', fileURLToPath(new URL('../src/factory-smoke-records.js', import.meta.url)));
      const result = spawnSync(process.execPath, [...(args.includes('--input-type=module') ? ['--input-type=module'] : []), '-e', script, ...args.slice(scriptIndex + 1)], { encoding: 'utf8', input: options.input, env: { ...process.env, HOME: root, HERDR_BOSS_DIR: env.HERDR_BOSS_DIR } });
      return { code: result.status, stdout: result.stdout, stderr: result.stderr };
    }
    throw new Error('Unexpected fake Docker call.');
  } };
  const io = { env, isContainer: () => false, transportFactory: () => docker, stdin: Readable.from(['clean-smoke demo\n']),
    stdout: { write: (value) => output.push(value) }, stderr: { write: (value) => output.push(value) } };
  return { root, work, io, calls, output, workspaces };
}

function seedRecords(f) {
  const dataDir = f.io.env.HERDR_BOSS_DIR;
  fs.mkdirSync(path.join(dataDir, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'flows'), { recursive: true });
  for (const slug of ['smoke-agent', 'smoke-stale', 'project', 'smokey']) {
    const repo = path.join(f.work, slug);
    fs.mkdirSync(repo, { recursive: true });
    const init = spawnSync('git', ['init', '--quiet', repo], { env: { ...process.env, HOME: f.root } });
    assert.equal(init.status, 0);
    recordProjectRepo(slug, repo, 'https://github.com/example/sample.git', { dataDir });
    assert.equal(checkProjectPin({ slug, repo }, { home: f.root, dataDir, allowBaseline: true }).ok, true);
    fs.writeFileSync(path.join(dataDir, 'projects', `${slug}.json`), JSON.stringify({ project: slug }));
    fs.writeFileSync(path.join(dataDir, 'flows', `${slug}.json`), JSON.stringify({ slug }));
  }
  fs.rmSync(path.join(f.work, 'smoke-stale'), { recursive: true });
  const rows = readProjectRepos(dataDir);
  writeRegister({ version: 1, projects: rows.map(row => buildCandidateRecord(row, dataDir)) }, dataDir);
  fs.writeFileSync(path.join(dataDir, 'policy.json'), JSON.stringify({ projects: Object.fromEntries(rows.map(row => [row.slug, { weight: 10 }])) }));
  fs.writeFileSync(path.join(dataDir, 'rules.json'), JSON.stringify({ control: { projects: Object.fromEntries(rows.map(row => [row.slug, { running: 0 }])) } }));
  return dataDir;
}

test('clean-smoke unregisters smoke records and pins even after their folders were deleted', async (t) => {
  const f = fixture(t), dataDir = seedRecords(f);
  assert.equal(await factoryCommand(['clean-smoke', 'demo'], f.io), 0);
  assert.deepEqual(readProjectRepos(dataDir).map(row => row.slug), ['project', 'smokey']);
  assert.deepEqual(pinnedProjects({ home: f.root }).map(row => row.slug), ['project', 'smokey']);
  assert.equal(fs.readdirSync(gitPinsDir({ home: f.root })).filter(file => file.endsWith('.json')).length, 3);
  assert.deepEqual(readRegister(dataDir).projects.map(row => row.slug), ['project', 'smokey']);
  for (const file of ['policy.json', 'rules.json']) {
    const data = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
    assert.deepEqual(Object.keys(data.projects || data.control.projects), ['project', 'smokey']);
  }
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'projects')), ['project.json', 'smokey.json']);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'flows')), ['project.json', 'smokey.json']);
  assert.match(f.output.join(''), /Project records: 2/);
  assert.match(f.output.join(''), /2 smoke project records/);
});

test('clean-smoke dry-run and wrong confirmation keep registrations and pins', async (t) => {
  const f = fixture(t), dataDir = seedRecords(f);
  const pins = pinnedProjects({ home: f.root });
  assert.equal(await factoryCommand(['clean-smoke', 'demo', '--dry-run'], f.io), 0);
  f.io.stdin = Readable.from(['wrong\n']);
  await assert.rejects(factoryCommand(['clean-smoke', 'demo'], f.io), /confirmation/);
  assert.equal(readProjectRepos(dataDir).length, 4);
  assert.deepEqual(pinnedProjects({ home: f.root }), pins);
});

test('clean-smoke confirms and removes stale records when no smoke folder or workspace remains', async (t) => {
  const f = fixture(t), dataDir = seedRecords(f);
  f.workspaces.shift();
  for (const name of ['smoke-agent', 'smoke-folder']) fs.rmSync(path.join(f.work, name), { recursive: true });
  assert.equal(await factoryCommand(['clean-smoke', 'demo'], f.io), 0);
  assert.equal(readProjectRepos(dataDir).length, 2);
  assert.equal(pinnedProjects({ home: f.root }).length, 2);
  assert.match(f.output.join(''), /Type clean-smoke demo to confirm/);
  assert.match(f.output.join(''), /Removed 0 smoke workspaces, 0 smoke folders, and 2 smoke project records/);
});

test('clean-smoke uses the same smoke- prefix for a registration named smoke-', async (t) => {
  const f = fixture(t), dataDir = f.io.env.HERDR_BOSS_DIR;
  const repo = path.join(f.work, 'smoke-'); fs.mkdirSync(repo);
  recordProjectRepo('smoke-', repo, '', { dataDir });
  assert.equal(await factoryCommand(['clean-smoke', 'demo'], f.io), 0);
  assert.deepEqual(readProjectRepos(dataDir), []);
});

test('clean-smoke lists and removes only smoke- workspaces and work-root folders after typed confirmation', async (t) => {
  const f = fixture(t);
  assert.equal(await factoryCommand(['clean-smoke', 'demo'], f.io), 0);
  assert.deepEqual(f.workspaces.map((row) => row.label), ['project', 'smokey']);
  assert.deepEqual(fs.readdirSync(f.work), ['project', 'smokey']);
  assert.equal(fs.readFileSync(path.join(f.work, 'project', 'keep.txt'), 'utf8'), 'sample');
  const text = f.output.join('');
  assert.match(text, /Workspaces: 1/); assert.match(text, /Folders: 2/);
  assert.match(text, /smoke-agent/); assert.match(text, /smoke-folder/);
  assert.match(text, /Type clean-smoke demo to confirm/);
  assert.doesNotMatch(text, /"(?:project|smokey)"/); assert.equal(text.includes(f.root), false);
  assert.equal(f.calls.some(({ args }) => args.includes('--group') || args[0] === 'stop' || args[0] === 'rm'), false);
});

test('clean-smoke dry-run lists the candidates and keeps all workspaces and folders without confirmation', async (t) => {
  const f = fixture(t); f.io.stdin = Readable.from([]);
  assert.equal(await factoryCommand(['clean-smoke', 'demo', '--dry-run'], f.io), 0);
  assert.equal(f.workspaces.length, 3); assert.equal(fs.readdirSync(f.work).length, 4);
  assert.match(f.output.join(''), /Dry run/); assert.doesNotMatch(f.output.join(''), /Type .*confirm/);
});

test('clean-smoke refuses a smoke symlink outside the work root before closing any workspace', async (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep.txt'), 'sample');
  fs.symlinkSync(outside, path.join(f.work, 'smoke-link'));
  await assert.rejects(factoryCommand(['clean-smoke', 'demo', '--yes'], f.io), /symbolic link|outside the work root/);
  assert.equal(f.workspaces.length, 3); assert.equal(fs.readdirSync(f.work).length, 5);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'sample');
  assert.equal(f.output.join('').includes(outside), false);
});

test('clean-smoke requires the exact phrase and an absent or wrong confirmation changes nothing', async (t) => {
  for (const answer of ['', 'demo\n', 'clean-smoke other\n']) {
    const f = fixture(t); f.io.stdin = Readable.from([answer]);
    await assert.rejects(factoryCommand(['clean-smoke', 'demo'], f.io), /confirmation does not match/);
    assert.equal(f.workspaces.length, 3); assert.equal(fs.readdirSync(f.work).length, 4);
  }
});

test('clean-smoke --yes removes the listed smoke resources and a repeat finds nothing left', async (t) => {
  const f = fixture(t); f.io.stdin = Readable.from([]);
  fs.writeFileSync(path.join(f.work, 'smoke-file'), 'keep a file');
  fs.symlinkSync(path.join(f.work, 'project'), path.join(f.work, 'other-link'));
  assert.equal(await factoryCommand(['clean-smoke', 'demo', '--yes'], f.io), 0);
  assert.deepEqual(fs.readdirSync(f.work), ['other-link', 'project', 'smoke-file', 'smokey']);
  assert.doesNotMatch(f.output.join(''), /Type .*confirm/);
  assert.equal(await factoryCommand(['clean-smoke', 'demo'], f.io), 0);
  assert.match(f.output.join(''), /No smoke resources to remove/);
});

test('clean-smoke refuses links inside a smoke folder and links into the work root, including in dry-run', async (t) => {
  for (const nested of [false, true]) {
    const f = fixture(t);
    const link = nested ? path.join(f.work, 'smoke-agent', 'nested-link') : path.join(f.work, 'smoke-link');
    fs.symlinkSync(path.join(f.work, 'project'), link);
    await assert.rejects(factoryCommand(['clean-smoke', 'demo', '--dry-run'], f.io), /symbolic link/);
    assert.equal(f.workspaces.length, 3); assert.ok(fs.existsSync(path.join(f.work, 'smoke-folder')));
    assert.equal(fs.readFileSync(path.join(f.work, 'project', 'keep.txt'), 'utf8'), 'sample');
  }
});

test('clean-smoke refuses a linked work root and leaves the outside folders intact', async (t) => {
  const f = fixture(t), outside = path.join(f.root, 'outside');
  fs.renameSync(f.work, outside); fs.symlinkSync(outside, f.work);
  await assert.rejects(factoryCommand(['clean-smoke', 'demo', '--yes'], f.io), /symbolic link|outside the work root/);
  assert.equal(f.workspaces.length, 3); assert.equal(fs.readdirSync(outside).length, 4);
});

test('clean-smoke refuses a workspace rename or a folder symlink introduced during confirmation', async (t) => {
  for (const change of ['workspace', 'folder']) {
    const f = fixture(t);
    f.io.stdin = Readable.from((function* () {
      if (change === 'workspace') f.workspaces[0].label = 'project-new';
      else {
        fs.renameSync(path.join(f.work, 'smoke-agent'), path.join(f.root, 'outside'));
        fs.symlinkSync(path.join(f.root, 'outside'), path.join(f.work, 'smoke-agent'));
      }
      yield 'clean-smoke demo\n';
    })());
    await assert.rejects(factoryCommand(['clean-smoke', 'demo'], f.io), /inventory changed|symbolic link/);
    assert.equal(f.workspaces.length, 3); assert.ok(fs.existsSync(path.join(f.work, 'smoke-folder')));
    assert.equal(f.calls.some(({ args }) => args.includes('close')), false);
  }
});

test('clean-smoke refuses invalid names and options before it reaches the factory', async (t) => {
  const f = fixture(t);
  for (const args of [[], ['demo', '--force'], ['demo', '--yes', '--yes'], ['demo', 'other'], ['../demo']]) {
    await assert.rejects(factoryCommand(['clean-smoke', ...args], f.io));
  }
  assert.equal(f.calls.length, 0);
});
