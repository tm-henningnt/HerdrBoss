import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildGhLabelArgs, buildGhMilestoneArgs, loadLabelPreset, planLabelSync } from '../src/kit/gh.js';
import { runKitCommand } from '../src/kit/cli.js';
import { execFileSync } from 'node:child_process';
import { makeFakeGh } from './fake-gh.js';

// The token-like string is built at run time, so no scanner finds a literal in this file.
const TOKEN = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');

test('label create builds an argument array with the name after --', () => {
  assert.deepEqual(buildGhLabelArgs('create', ['needs-triage', '--color', 'FBCA04', '--description', 'Maintainer needs to evaluate this issue'], { repo: 'octo/demo' }),
    ['label', 'create', '--repo=octo/demo', '--color=FBCA04', '--description=Maintainer needs to evaluate this issue', '--', 'needs-triage']);
  assert.deepEqual(buildGhLabelArgs('create', ['--color=ffffff', 'wontfix'], { repo: 'octo/demo' }), ['label', 'create', '--repo=octo/demo', '--color=ffffff', '--', 'wontfix']);
});

test('label list takes no value and edit changes only the given fields', () => {
  assert.deepEqual(buildGhLabelArgs('list', [], { repo: 'octo/demo' }), ['label', 'list', '--repo=octo/demo', '--limit', '1000']);
  assert.throws(() => buildGhLabelArgs('list', ['extra'], { repo: 'octo/demo' }), /label list/);
  assert.deepEqual(buildGhLabelArgs('edit', ['bug', '--color', '00ff00'], { repo: 'octo/demo' }), ['label', 'edit', '--repo=octo/demo', '--color=00ff00', '--', 'bug']);
  assert.deepEqual(buildGhLabelArgs('edit', ['bug', '--new-name', 'defect', '--description', 'A defect'], { repo: 'octo/demo' }), ['label', 'edit', '--repo=octo/demo', '--description=A defect', '--name=defect', '--', 'bug']);
  assert.throws(() => buildGhLabelArgs('edit', ['bug'], { repo: 'octo/demo' }), /at least one/);
});

test('label refusals: delete, other actions, flags, and every bad value', () => {
  assert.throws(() => buildGhLabelArgs('delete', ['bug']), /not supported.*delete/i);
  assert.throws(() => buildGhLabelArgs('clone', ['bug']), /not supported/);
  assert.throws(() => buildGhLabelArgs(undefined, []), /Usage/);
  assert.throws(() => buildGhLabelArgs('create', ['bug', '--color', 'ff0000', '--force'], { repo: 'octo/demo' }), /Unknown option/);
  assert.throws(() => buildGhLabelArgs('create', ['-bug', '--color', 'ff0000'], { repo: 'octo/demo' }), /leading dash|start with/);
  assert.throws(() => buildGhLabelArgs('create', ['--color', 'ff0000'], { repo: 'octo/demo' }), /name/);
  assert.throws(() => buildGhLabelArgs('create', ['a', 'b', '--color', 'ff0000'], { repo: 'octo/demo' }), /one name/);
  assert.throws(() => buildGhLabelArgs('create', ['bug'], { repo: 'octo/demo' }), /--color/);
  for (const color of ['ff00', '#ff0000', 'gg0000', 'ff00000', '']) assert.throws(() => buildGhLabelArgs('create', ['bug', '--color', color], { repo: 'octo/demo' }), /color/, color);
  assert.throws(() => buildGhLabelArgs('create', ['x'.repeat(51), '--color', 'ff0000'], { repo: 'octo/demo' }), /50/);
  assert.throws(() => buildGhLabelArgs('create', ['bad\nname', '--color', 'ff0000'], { repo: 'octo/demo' }), /control/);
  assert.throws(() => buildGhLabelArgs('create', ['bug', '--color', 'ff0000', '--description', 'x'.repeat(101)], { repo: 'octo/demo' }), /100/);
  assert.throws(() => buildGhLabelArgs('create', ['bug', '--color', 'ff0000', '--description', 'line\none'], { repo: 'octo/demo' }), /control/);
  assert.throws(() => buildGhLabelArgs('create', ['bug', '--color', 'ff0000', '--description', '-x'], { repo: 'octo/demo' }), /start with/);
  assert.throws(() => buildGhLabelArgs('edit', ['bug', '--new-name', '-x'], { repo: 'octo/demo' }), /start with/);
});

test('label values refuse an inline secret and the message never shows it', () => {
  for (const args of [
    ['create', ['bug', '--color', 'ff0000', '--description', `token ${TOKEN}`]],
    ['create', [TOKEN, '--color', 'ff0000']],
    ['edit', ['bug', '--description', `password=${'a1b2c3d4e5f6g7h8i9'}`]],
  ]) {
    try { buildGhLabelArgs(args[0], args[1], { repo: 'octo/demo' }); assert.fail('no error'); } catch (error) {
      assert.match(error.message, /secret/);
      assert.ok(!error.message.includes(TOKEN));
    }
  }
});

test('milestone create and list build argument arrays, delete is refused', () => {
  const create = buildGhMilestoneArgs('create', ['v1', '--description', 'First release', '--due', '2026-12-31'], { repo: 'octo/demo' });
  assert.deepEqual(create, ['api', '--method', 'POST', 'repos/octo/demo/milestones', '-f', 'title=v1', '-f', 'description=First release', '-f', 'due_on=2026-12-31T00:00:00Z']);
  assert.deepEqual(buildGhMilestoneArgs('create', ['v2'], { repo: 'octo/demo' }), ['api', '--method', 'POST', 'repos/octo/demo/milestones', '-f', 'title=v2']);
  assert.equal(buildGhMilestoneArgs('list', [], { repo: 'octo/demo' })[0], 'api');
  assert.ok(buildGhMilestoneArgs('list', [], { repo: 'octo/demo' }).includes('repos/octo/demo/milestones'));
  assert.throws(() => buildGhMilestoneArgs('delete', ['v1']), /not supported.*delete/i);
  assert.throws(() => buildGhMilestoneArgs('edit', ['v1']), /not supported/);
  assert.throws(() => buildGhMilestoneArgs('create', ['-v1'], { repo: 'octo/demo' }), /start with/);
  assert.throws(() => buildGhMilestoneArgs('create', [], { repo: 'octo/demo' }), /title/);
  assert.throws(() => buildGhMilestoneArgs('create', ['v1', '--due', '2026-02-30'], { repo: 'octo/demo' }), /date/);
  assert.throws(() => buildGhMilestoneArgs('create', ['v1', '--due', '31-12-2026'], { repo: 'octo/demo' }), /date/);
  assert.throws(() => buildGhMilestoneArgs('create', ['v1', '--description', `key ${TOKEN}`], { repo: 'octo/demo' }), /secret/);
  assert.throws(() => buildGhMilestoneArgs('create', ['x'.repeat(256)], { repo: 'octo/demo' }), /255/);
});

test('the triage preset holds exactly the five labels of the Owner', () => {
  assert.deepEqual(loadLabelPreset('triage'), [
    { name: 'needs-triage', color: 'FBCA04', description: 'Maintainer needs to evaluate this issue' },
    { name: 'needs-info', color: 'D4C5F9', description: 'Waiting on reporter for more information' },
    { name: 'ready-for-agent', color: '0E8A16', description: 'Fully specified, ready for an AFK agent' },
    { name: 'ready-for-human', color: '1D76DB', description: 'Requires human implementation' },
    { name: 'wontfix', color: 'ffffff', description: 'This will not be worked on.' },
  ]);
  assert.throws(() => loadLabelPreset('nope'), /preset/);
});

test('the sync plan creates, updates, or keeps each label', () => {
  const preset = loadLabelPreset('triage');
  const existing = [
    { name: 'needs-triage', color: 'fbca04', description: 'Maintainer needs to evaluate this issue' },
    { name: 'needs-info', color: '000000', description: 'Waiting on reporter for more information' },
    { name: 'ready-for-agent', color: '0E8A16', description: 'old' },
    { name: 'unrelated', color: '111111', description: '' },
  ];
  const plan = planLabelSync(preset, existing);
  assert.deepEqual(plan.map((step) => [step.action, step.label.name]), [
    ['ok', 'needs-triage'], ['edit', 'needs-info'], ['edit', 'ready-for-agent'], ['create', 'ready-for-human'], ['create', 'wontfix'],
  ]);
  assert.deepEqual(planLabelSync(preset, preset).map((step) => step.action), ['ok', 'ok', 'ok', 'ok', 'ok']);
  // A description that GitHub returns as null counts as empty.
  assert.equal(planLabelSync([{ name: 'a', color: 'ffffff', description: '' }], [{ name: 'A', color: 'FFFFFF', description: null }])[0].action, 'ok');
});

function cliFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-gh-labels-'));
  const fake = makeFakeGh(path.join(root, 'fake'), { token: TOKEN });
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  for (const args of [['init', '-q', '-b', 'main'], ['remote', 'add', 'origin', 'git@github.com:octo/demo.git'], ['remote', 'add', 'upstream', 'https://github.com/other/upstream.git']]) execFileSync('git', args, { cwd: project });
  const out = [];
  // GH_REPO and GH_HOST in the caller environment must not reach gh.
  const env = { ...fake.env(), GH_REPO: 'evil/elsewhere', GH_HOST: 'ghe.example.invalid' };
  const run = (argv) => runKitCommand('gh', argv, { output: (line) => out.push(line), env, config: { root: project } });
  return { root, fake, project, out, run, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('gh label create, list, and edit run gh in the project root', () => {
  const f = cliFixture();
  try {
    f.run(['label', 'create', 'bug', '--color', 'd73a4a', '--description', 'Something is broken']);
    f.run(['label', 'edit', 'bug', '--color', '000000']);
    f.run(['label', 'list']);
    assert.deepEqual(f.fake.calls(), [
      ['label', 'create', '--repo=octo/demo', '--color=d73a4a', '--description=Something is broken', '--', 'bug'],
      ['label', 'edit', '--repo=octo/demo', '--color=000000', '--', 'bug'],
      ['label', 'list', '--repo=octo/demo', '--limit', '1000'],
    ]);
    // The upstream remote and GH_REPO cannot redirect gh. GH_HOST is github.com.
    for (const env of f.fake.envs()) assert.deepEqual(env, { ghRepo: null, ghHost: 'github.com' });
    for (const cwd of f.fake.cwds()) assert.equal(fs.realpathSync(cwd), fs.realpathSync(f.project));
  } finally { f.cleanup(); }
});

test('gh label and milestone refuse delete and call no gh', () => {
  const f = cliFixture();
  try {
    assert.throws(() => f.run(['label', 'delete', 'bug']), /delete/);
    assert.throws(() => f.run(['milestone', 'delete', 'v1']), /delete/);
    assert.throws(() => f.run(['release', 'create']), /Usage/);
    assert.throws(() => f.run(['label', 'create', '-x', '--color', 'ffffff']), /start with/);
    assert.deepEqual(f.fake.calls(), []);
  } finally { f.cleanup(); }
});

test('gh milestone create and list run gh api in the project root', () => {
  const f = cliFixture();
  try {
    f.run(['milestone', 'create', 'v1', '--due', '2026-12-31']);
    f.run(['milestone', 'list']);
    const calls = f.fake.calls();
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call[0] === 'api' && call.includes('repos/octo/demo/milestones')));
    for (const env of f.fake.envs()) assert.deepEqual(env, { ghRepo: null, ghHost: 'github.com' });
  } finally { f.cleanup(); }
});

test('gh label sync --dry-run prints the plan and calls no write command', () => {
  const f = cliFixture();
  try {
    f.fake.set('labels.json', [{ name: 'needs-triage', color: 'FBCA04', description: 'Maintainer needs to evaluate this issue' }]);
    f.run(['label', 'sync', '--preset', 'triage', '--dry-run']);
    assert.equal(f.out.length, 5);
    assert.match(f.out[0], /needs-triage/);
    assert.match(f.out[0], /ok/);
    assert.match(f.out[1], /would create.*needs-info/);
    assert.deepEqual(f.fake.writes(), []);
    assert.deepEqual(f.fake.calls(), [['label', 'list', '--repo=octo/demo', '--json', 'name,color,description', '--limit', '1000']]);
  } finally { f.cleanup(); }
});

test('gh label sync creates, edits, and skips through the create and edit calls', () => {
  const f = cliFixture();
  try {
    f.fake.set('labels.json', [
      { name: 'needs-triage', color: 'FBCA04', description: 'Maintainer needs to evaluate this issue' },
      { name: 'needs-info', color: 'ffffff', description: 'Waiting on reporter for more information' },
    ]);
    f.run(['label', 'sync', '--preset', 'triage']);
    const writes = f.fake.writes();
    assert.deepEqual(writes.map((args) => [args[1], args.at(-1)]), [['edit', 'needs-info'], ['create', 'ready-for-agent'], ['create', 'ready-for-human'], ['create', 'wontfix']]);
    assert.ok(writes.every((args) => args[1] !== 'delete'));
    assert.equal(f.out.length, 5);
    // Second run on a full set changes nothing.
    f.fake.set('labels.json', loadLabelPreset('triage'));
    const before = f.fake.writes().length;
    f.out.length = 0;
    f.run(['label', 'sync', '--preset', 'triage']);
    assert.equal(f.fake.writes().length, before);
    assert.equal(f.out.length, 5);
    assert.ok(f.out.every((line) => /\bok\b/.test(line)));
  } finally { f.cleanup(); }
});

test('gh label sync needs the preset and refuses unknown values', () => {
  const f = cliFixture();
  try {
    assert.throws(() => f.run(['label', 'sync']), /--preset/);
    assert.throws(() => f.run(['label', 'sync', '--preset', 'nope']), /preset/);
    assert.throws(() => f.run(['label', 'sync', '--preset', 'triage', '--force']), /Unknown option/);
    assert.deepEqual(f.fake.calls(), []);
  } finally { f.cleanup(); }
});

test('a failed write in sync stops with a redacted message', () => {
  const f = cliFixture();
  try {
    f.fake.set('mode', 'failwrite');
    assert.throws(() => f.run(['label', 'sync', '--preset', 'triage']), (error) => /needs-triage/.test(error.message) && !error.message.includes(TOKEN));
  } finally { f.cleanup(); }
});

test('gh label and milestone refuse a missing or non-GitHub origin and call no gh', () => {
  const f = cliFixture();
  try {
    execFileSync('git', ['remote', 'set-url', 'origin', 'https://gitlab.example.invalid/octo/demo.git'], { cwd: f.project });
    assert.throws(() => f.run(['label', 'list']), /not a github\.com/);
    assert.throws(() => f.run(['milestone', 'list']), /not a github\.com/);
    assert.throws(() => f.run(['label', 'sync', '--preset', 'triage']), /not a github\.com/);
    execFileSync('git', ['remote', 'remove', 'origin'], { cwd: f.project });
    assert.throws(() => f.run(['label', 'create', 'bug', '--color', 'ffffff']), /no origin/);
    assert.deepEqual(f.fake.calls(), []);
  } finally { f.cleanup(); }
});

test('gh label sync acts on origin and sees no GH_REPO', () => {
  const f = cliFixture();
  try {
    f.run(['label', 'sync', '--preset', 'triage']);
    const calls = f.fake.calls();
    assert.ok(calls.length >= 6);
    assert.ok(calls.every((args) => args.includes('--repo=octo/demo')));
    for (const env of f.fake.envs()) assert.deepEqual(env, { ghRepo: null, ghHost: 'github.com' });
  } finally { f.cleanup(); }
});

test('label names are compared without case and sync does not rename a case-only difference', () => {
  const f = cliFixture();
  try {
    f.fake.set('labels.json', loadLabelPreset('triage').map((label) => ({ ...label, name: label.name.toUpperCase() })));
    f.run(['label', 'sync', '--preset', 'triage']);
    assert.deepEqual(f.fake.writes(), []);
    assert.ok(f.out.every((line) => /^ok /.test(line)));
  } finally { f.cleanup(); }
});
