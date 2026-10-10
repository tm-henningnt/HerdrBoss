import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkAgentsExclude, contextTokensFor, globMatches, loadModels, loadProjectConfig, PROJECT_DEFAULTS, workerConfigView } from '../src/kit/config.js';
import { appendDelegatedRun, compareChangedPaths, gitChangedPaths, readDelegatedRuns, validateAllowedPaths, validateDelegatedRun, validateWorkerReport } from '../src/kit/orchestration.js';
import { buildGhArgs } from '../src/kit/gh.js';
import { formatKitDigest, runKitCommand } from '../src/kit/cli.js';
import { allowWorkerScope, collectWorker, createHerdrRunner, filterCollectProcesses, listWorkers, parseWorktreeCwdProcesses, renderBrief, waitForAgentReady, waitForWorkerPane } from '../src/kit/workers.js';
import { startWorker } from './helpers/start-worker.js';
import { classifyWorktrees, pruneWorktrees } from '../src/kit/worktrees.js';
import { usageProvider, validateUsage } from '../src/usage.js';
import { validateProject } from '../src/projects.js';
import { Engine } from '../src/engine.js';
import { renderBulletin } from '../src/rules.js';
import { readWorkerFacts, gitIsMerged } from '../src/task-state.js';
import { kitRevision, parseKitImpact, projectKit, readKitChanges, kitChangesSince } from '../src/kit/agents-check.js';
import { ALL_READY_SCREENS, CLAUDE_READY_SCREEN, CODEX_READY_SCREEN, git, setupFixture, temporaryRepo, TEST_HOME, tiers, validReport, validRun } from './helpers/kit-fixture.js';

test('kit revision stays valid without optional model guidance', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-kit-legacy-revision-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, text) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write('kit/templates/project-kit.md', 'canonical body');
  write('kit/skills/herdr-orchestrator/SKILL.md', 'skill');
  write('kit/models.json', '{}');
  const revision = kitRevision(root);
  assert.match(revision, /^[0-9a-f]{12}$/);
  write('kit/models.md', 'model guidance');
  assert.notEqual(kitRevision(root), revision, 'model guidance changes the revision when present');
  fs.rmSync(path.join(root, 'kit/models.md'));
  assert.equal(kitRevision(root), revision, 'removing optional guidance restores the earlier revision');
  fs.rmSync(path.join(root, 'kit/models.json'));
  assert.equal(kitRevision(root), null, 'a missing required model catalog still invalidates the revision');
});

test('kit revision follows installed kit assets and ignores product code', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-kit-revision-'));
  const write = (relative, text) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  try {
    write('kit/templates/project-kit.md', 'canonical body');
    write('kit/templates/agents-stub.md', 'other template');
    write('kit/skills/herdr-orchestrator/SKILL.md', 'skill');
    write('kit/skills/herdr-orchestrator/reference/handover.md', 'reference');
    write('kit/models.md', 'model guidance');
    write('kit/models.json', '{}');
    write('src/engine.js', 'service');
    write('public/app.js', 'dashboard');
    write('website/page.js', 'website');

    write('docs/orchestration/herdr-boss.md', '<!-- herdr-boss kit v=old -->\nold note\n\nold generated body');
    const revision = kitRevision(root);
    assert.match(revision, /^[0-9a-f]{12}$/);
    write('kit/templates/agents-stub.md', 'changed stub template');
    assert.notEqual(kitRevision(root), revision, 'an installed template changes the revision');
    write('kit/templates/agents-stub.md', 'other template');
    write('kit/skills/herdr-orchestrator/reference/handover.md', 'changed reference');
    assert.notEqual(kitRevision(root), revision, 'an installed reference file changes the revision');
    write('kit/skills/herdr-orchestrator/reference/handover.md', 'reference');
    write('kit/models.json', '{"changed":true}');
    assert.notEqual(kitRevision(root), revision, 'the model catalog changes the revision');
    write('kit/models.json', '{}');
    write('kit/models.md', 'changed model guidance');
    assert.notEqual(kitRevision(root), revision, 'model guidance changes the revision');
    write('kit/models.md', 'model guidance');
    write('kit/templates/project-kit.md', 'changed canonical body');
    assert.notEqual(kitRevision(root), revision, 'the canonical template changes the revision');
    write('kit/templates/project-kit.md', 'canonical body');
    write('docs/orchestration/herdr-boss.md', '<!-- herdr-boss kit v=other -->\nnew note\n\nother generated body');
    write('src/engine.js', 'changed service');
    write('public/app.js', 'changed dashboard');
    write('website/page.js', 'changed website');
    assert.equal(kitRevision(root), revision, 'generated kit output and product code do not change the revision');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('parseKitImpact reads required, useful, and none case-insensitively from a trailer block', () => {
  for (const value of ['required', 'REQUIRED', 'Required', 'useful', 'USEFUL', 'none', 'NONE', 'None']) {
    assert.equal(parseKitImpact(`Kit-Impact: ${value}`), value.toLowerCase());
  }
  // A trailer block with multiple ordinary trailers.
  assert.equal(parseKitImpact('Kit-Impact: required\nSigned-off-by: Someone'), 'required');
  assert.equal(parseKitImpact('Signed-off-by: Someone\nKit-Impact: useful'), 'useful');
  assert.equal(parseKitImpact('Co-Authored-By: A\nKit-Impact: none\nSigned-off-by: B'), 'none');
  assert.equal(parseKitImpact('Kit-Impact: useful\n'), 'useful');
  assert.equal(parseKitImpact('Kit-Impact: useful\n\n'), 'useful');
  // A body line followed by a blank line and then a trailer block.
  assert.equal(parseKitImpact('Some body text\n\nKit-Impact: required'), 'required');
  assert.equal(parseKitImpact('Some body text\n\nSigned-off-by: Someone\nKit-Impact: useful'), 'useful');
});

test('parseKitImpact rejects a middle-of-body Kit-Impact and invalid forms', () => {
  // A body line followed by more body text is not a trailer.
  assert.equal(parseKitImpact('Kit-Impact: required\nMore body text'), null);
  assert.equal(parseKitImpact('Some text\nKit-Impact: required\nMore text'), null);
  assert.equal(parseKitImpact('Kit-Impact: required\n\nMore body text'), null);
  // A trailer block followed by body text is not the final trailer block.
  assert.equal(parseKitImpact('Kit-Impact: required\nSigned-off-by: Someone\n\nMore body'), null);
  // A trailer needs a blank separator after body text.
  assert.equal(parseKitImpact('Subject\nKit-Impact: useful'), null);
  // No trailer block at all.
  assert.equal(parseKitImpact('no trailer at all'), null);
  // Invalid values.
  assert.equal(parseKitImpact('Kit-Impact: '), null);
  assert.equal(parseKitImpact('Kit-Impact: maybe'), null);
  assert.equal(parseKitImpact('Kit-Impact: required extra'), null);
  // Malformed trailer syntax.
  assert.equal(parseKitImpact('Kit-Impact:required'), null);
  assert.equal(parseKitImpact('Kit-Impact : required'), null);
  assert.equal(parseKitImpact('Kit-Impact: required\t'), null);
  assert.equal(parseKitImpact('Kit-Impact:\trequired'), null);
  assert.equal(parseKitImpact('Kit-Impact: required '), null);
  assert.equal(parseKitImpact('xKit-Impact: required'), null);
  // Wrong key case.
  assert.equal(parseKitImpact('kit-impact: required'), null);
  // Ambiguous: multiple Kit-Impact trailers in the block.
  assert.equal(parseKitImpact('Kit-Impact: required\nKit-Impact: none'), null);
  assert.equal(parseKitImpact('Kit-Impact: useful\nKit-Impact: maybe'), null);
  assert.equal(parseKitImpact('Kit-Impact: useful\nKit-Impact:required'), null);
  assert.equal(parseKitImpact('Kit-Impact: useful\nKit-Impact : required'), null);
  // Empty and null inputs.
  assert.equal(parseKitImpact(''), null);
  assert.equal(parseKitImpact(null), null);
  assert.equal(parseKitImpact(undefined), null);
});

test('readKitChanges parses a documented changelog format', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-kit-changes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'CHANGES.md');
  const text = [
    '# Kit change log',
    '',
    'This file is the fallback record of kit changes.',
    '',
    '## Format',
    '',
    'Each entry starts with a level-two heading that holds the kit revision.',
    '',
    '## Entries',
    '',
    '## 883095fbe869',
    'Impact: required',
    'Summary: Compute the kit revision from installed kit assets only.',
    '',
    '## aaaaaaaaaaaa',
    'Impact: useful',
    'Summary: Add a helpful but non-critical feature.',
    '',
    '## bbbbbbbbbbbb',
    'Impact: none',
    'Summary: A cosmetic change with no action needed.',
    '',
  ].join('\n');
  fs.writeFileSync(file, text);
  const entries = readKitChanges(file);
  assert.deepEqual(entries, [
    { revision: '883095fbe869', impact: 'required', summary: 'Compute the kit revision from installed kit assets only.' },
    { revision: 'aaaaaaaaaaaa', impact: 'useful', summary: 'Add a helpful but non-critical feature.' },
    { revision: 'bbbbbbbbbbbb', impact: 'none', summary: 'A cosmetic change with no action needed.' },
  ]);
});

test('readKitChanges defaults to required for a missing or invalid Impact line', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-kit-changes-default-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'CHANGES.md');
  const text = [
    '## 111111111111',
    'Summary: No impact line at all.',
    '',
    '## 222222222222',
    'Impact: maybe',
    'Summary: Invalid impact value.',
    '',
    '## 333333333333',
    'Impact: required',
    'Summary: Valid impact.',
    '',
    '## 444444444444',
    'Impact: useful',
    'Impact: none',
    'Summary: Duplicate impacts are conservative.',
    '',
    '## 555555555555',
    'Impact: useful',
    'Impact: maybe',
    'Summary: An invalid duplicate is conservative.',
    '',
    '## 666666666666',
    'Impact: ',
    'Summary: An empty impact is invalid.',
    '',
    '## 777777777777',
    'Impact: useful',
    'Impact : none',
    'Summary: A malformed duplicate is conservative.',
    '',
  ].join('\n');
  fs.writeFileSync(file, text);
  const entries = readKitChanges(file);
  assert.equal(entries[0].impact, 'required', 'missing Impact defaults to required');
  assert.equal(entries[1].impact, 'required', 'invalid Impact defaults to required');
  assert.equal(entries[2].impact, 'required', 'valid Impact is preserved');
  assert.equal(entries[3].impact, 'required', 'duplicate valid Impact lines default to required');
  assert.equal(entries[4].impact, 'required', 'a valid and invalid Impact pair defaults to required');
  assert.equal(entries[5].impact, 'required', 'an empty Impact line defaults to required');
  assert.equal(entries[6].impact, 'required', 'a malformed duplicate defaults to required');
});

test('readKitChanges returns an empty list for a missing or invalid file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-kit-changes-missing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(readKitChanges(path.join(dir, 'nonexistent.md')), []);
  const file = path.join(dir, 'CHANGES.md');
  fs.writeFileSync(file, '# No entries\n\nJust text, no entries.\n');
  assert.deepEqual(readKitChanges(file), []);
});

test('kitChangesSince returns entries after a known revision', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-kit-changes-since-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'CHANGES.md');
  const text = [
    '## 111111111111',
    'Impact: required',
    'Summary: First change.',
    '',
    '## 222222222222',
    'Impact: useful',
    'Summary: Second change.',
    '',
    '## 333333333333',
    'Impact: none',
    'Summary: Third change.',
    '',
  ].join('\n');
  fs.writeFileSync(file, text);
  assert.deepEqual(kitChangesSince('111111111111', file), [
    { revision: '222222222222', impact: 'useful', summary: 'Second change.' },
    { revision: '333333333333', impact: 'none', summary: 'Third change.' },
  ]);
  assert.deepEqual(kitChangesSince('222222222222', file), [
    { revision: '333333333333', impact: 'none', summary: 'Third change.' },
  ]);
  assert.deepEqual(kitChangesSince('333333333333', file), []);
});

test('kitChangesSince returns all entries for an unknown or missing revision', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-kit-changes-unknown-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'CHANGES.md');
  const text = [
    '## 111111111111',
    'Impact: required',
    'Summary: First change.',
    '',
    '## 222222222222',
    'Impact: useful',
    'Summary: Second change.',
    '',
  ].join('\n');
  fs.writeFileSync(file, text);
  const all = [
    { revision: '111111111111', impact: 'required', summary: 'First change.' },
    { revision: '222222222222', impact: 'useful', summary: 'Second change.' },
  ];
  assert.deepEqual(kitChangesSince('unknown', file), all);
  assert.deepEqual(kitChangesSince('', file), all);
  assert.deepEqual(kitChangesSince(null, file), all);
  assert.deepEqual(kitChangesSince(undefined, file), all);
});

test('the real kit/CHANGES.md has a valid format and at least one entry', () => {
  const entries = readKitChanges();
  assert.ok(entries.length >= 1, 'the real changelog must have at least one entry');
  for (const entry of entries) {
    assert.match(entry.revision, /^[0-9a-f]{12}$/, `revision ${entry.revision} must be 12 hex chars`);
    assert.ok(['required', 'useful', 'none'].includes(entry.impact), `impact ${entry.impact} must be valid`);
    assert.ok(entry.summary && entry.summary.length > 0, 'summary must be non-empty');
  }
});

test('project status accepts a durable goal and rejects invalid goal values', () => {
  const valid = { project: 'Example', goal: 'Preserve the Owner direction.' };
  assert.deepEqual(validateProject(valid), []);
  assert.deepEqual(validateProject({ project: 'Example' }), []);
  for (const goal of [null, 42, {}, [], '', '   ', '\n\t']) {
    assert.ok(validateProject({ project: 'Example', goal }).some((error) => error.includes('goal')),
      `expected ${JSON.stringify(goal)} to be rejected`);
  }
  assert.ok(validateProject({ project: 'Example', goal: 'x'.repeat(1001) }).some((error) => error.includes('goal')));
  assert.deepEqual(validateProject({ project: 'Example', goal: 'x'.repeat(1000) }), []);
});

test('worker process check finds only cwd paths inside the exact worktree', () => {
  const worktree = path.resolve('/tmp/worker-tree');
  const output = [
    'p101', 'R10', 'cnode', `n${worktree}/test/server.test.js`,
    'p102', 'R1', 'cnpm', `n${worktree}-other`,
    'p103', 'R1', 'czsh', `n${worktree}`,
  ].join('\n');
  assert.deepEqual(parseWorktreeCwdProcesses(output, worktree), [
    { pid: 101, ppid: 10, command: 'node', cwd: `${worktree}/test/server.test.js` },
    { pid: 103, ppid: 1, command: 'zsh', cwd: worktree },
  ]);
});

test('worker process collection flags descendants and ignores unrelated worktree processes', () => {
  const cwd = path.resolve('/tmp/worker-tree');
  const processes = [
    { pid: 10, ppid: 1, command: 'zsh', cwd },
    { pid: 11, ppid: 10, command: 'node', args: 'codex worker runtime', cwd },
    { pid: 12, ppid: 9, command: 'app-server-daemon', executable: 'n/Applications/Codex.app/Contents/Resources/app-server-daemon', cwd },
    { pid: 13, ppid: 12, command: 'node', args: 'shared tool runtime', cwd },
    { pid: 20, ppid: 11, command: 'node', args: 'node --test test/a.test.js', cwd },
    { pid: 21, ppid: 11, command: 'node', args: 'node server.js', cwd },
    { pid: 22, ppid: 11, command: 'node', args: 'watcher --watch src', cwd },
    { pid: 23, ppid: 1, command: 'node', args: 'unknown process', cwd },
  ];
  assert.deepEqual(filterCollectProcesses(processes, { worktree: cwd, shellPid: 10 }).map(({ pid }) => pid), [11, 20, 21, 22]);
  assert.deepEqual(filterCollectProcesses(processes, { worktree: cwd }).map(({ pid }) => pid), [10, 11, 20, 21, 22, 23]);
});

function writeModelsFile(t, kinds) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-boss-models-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'models.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, kinds }));
  return file;
}

const MODEL_KIND = { defaultModel: 'm1', allowedModels: ['m1', 'm2'], allowedEfforts: [], defaultEffort: null, launchArgs: ['--model', '{{model}}'] };

test('the kit catalog sets a 200000-token window for claude and codex only', () => {
  const models = loadModels();
  assert.equal(models.kinds.claude.contextTokens, 200000);
  assert.equal(models.kinds.codex.contextTokens, 200000);
  for (const kind of ['pi', 'opencode']) assert.equal(Object.hasOwn(models.kinds[kind], 'contextTokens'), false);
  assert.equal(contextTokensFor(models, 'codex', models.kinds.codex.defaultModel), 200000);
  assert.equal(contextTokensFor(models, 'pi', models.kinds.pi.defaultModel), null);
});

test('contextTokensByModel overrides the kind window for one model', (t) => {
  const file = writeModelsFile(t, { claude: { ...MODEL_KIND, contextTokens: 200000, contextTokensByModel: { m2: 1000000 } } });
  const models = loadModels(file);
  assert.equal(contextTokensFor(models, 'claude', 'm2'), 1000000);
  assert.equal(contextTokensFor(models, 'claude', 'm1'), 200000);
  assert.equal(contextTokensFor(models, 'missing', 'm1'), null);
});

test('a models file without contextTokens stays valid', (t) => {
  const models = loadModels(writeModelsFile(t, { claude: { ...MODEL_KIND } }));
  assert.equal(contextTokensFor(models, 'claude', 'm1'), null);
});

test('loadModels refuses an invalid contextTokens or contextTokensByModel', (t) => {
  for (const value of [0, -1, 1.5, '200000', null, true]) {
    assert.throws(() => loadModels(writeModelsFile(t, { claude: { ...MODEL_KIND, contextTokens: value } })), /claude\.contextTokens must be a positive integer/);
  }
  for (const value of [[], 'x', null, { m1: 0 }, { m1: '5' }]) {
    assert.throws(() => loadModels(writeModelsFile(t, { claude: { ...MODEL_KIND, contextTokensByModel: value } })), /claude\.contextTokensByModel/);
  }
});

test('project config finds the git root and applies contract defaults', () => {
  const root = temporaryRepo();
  fs.mkdirSync(path.join(root, 'nested'));
  const config = loadProjectConfig({ cwd: path.join(root, 'nested') });
  assert.equal(config.root, root);
  assert.equal(config.slug, path.basename(root).toLowerCase());
  assert.equal(config.imageBudget, 10);
  assert.deepEqual(config.artifactChecks, []);
  for (const [key, value] of Object.entries(PROJECT_DEFAULTS)) assert.deepEqual(config[key], value);
  assert.equal(config.worktreeParent, path.join(TEST_HOME, 'Projects', '.herdr-wt'));
  assert.equal(config.worktreePath('worker'), path.join(TEST_HOME, 'Projects', '.herdr-wt', path.basename(root), 'worker'));
});

test('project config expands a leading ~ in worktreeRoot with the given home', () => {
  const root = temporaryRepo();
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-kit-otherhome-')));
  const config = loadProjectConfig({ cwd: root, home });
  assert.equal(config.worktreePath('w1'), path.join(home, 'Projects', '.herdr-wt', path.basename(root), 'w1'));
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ worktreeRoot: '~/trees' }));
  assert.equal(loadProjectConfig({ cwd: root, home }).worktreePath('w1'), path.join(home, 'trees', path.basename(root), 'w1'));
});

test('a project setting keeps the sibling worktree layout', () => {
  const root = temporaryRepo();
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ worktreeRoot: '..', worktreeName: '{repo}-wt-{name}' }));
  const config = loadProjectConfig({ cwd: root });
  assert.equal(config.worktreePath('worker'), path.join(path.dirname(root), `${path.basename(root)}-wt-worker`));
});

test('project config validates artifact check patterns', () => {
  const root = temporaryRepo();
  const configFile = path.join(root, '.herdr-boss.json');
  const artifactChecks = [{ artifacts: 'docs/gallery/**/*.png', sources: 'extensions/**/src/**' }];
  fs.writeFileSync(configFile, JSON.stringify({ artifactChecks }));
  assert.deepEqual(loadProjectConfig({ cwd: root }).artifactChecks, artifactChecks);

  for (const invalid of [
    null,
    'docs/gallery/**/*.png',
    [{}],
    [{ artifacts: 'out/*.png' }],
    [{ artifacts: 'out/*.png', sources: '' }],
    [{ artifacts: '../out/*.png', sources: 'src/**' }],
    [{ artifacts: '/tmp/out/*.png', sources: 'src/**' }],
    [{ artifacts: 'C:/out/*.png', sources: 'src/**' }],
    [{ artifacts: 'out\\*.png', sources: 'src/**' }],
    [{ artifacts: 'out//*.png', sources: 'src/**' }],
    [{ artifacts: 'out/***/x.png', sources: 'src/**' }],
    [{ artifacts: 'out/**suffix.png', sources: 'src/**' }],
    [{ artifacts: 'out/?.png', sources: 'src/**' }],
    [{ artifacts: 'out/*.png', sources: 'src/**', unexpected: true }],
  ]) {
    fs.writeFileSync(configFile, JSON.stringify({ artifactChecks: invalid }));
    assert.throws(() => loadProjectConfig({ cwd: root }), /artifactChecks/);
  }
});

test('project config validates checkAgents.exclude globs', () => {
  const root = temporaryRepo();
  const configFile = path.join(root, '.herdr-boss.json');
  const checkAgents = { exclude: ['.orchestration/tenant-*.md', 'docs/agents/**/generated/*.md'] };
  fs.writeFileSync(configFile, JSON.stringify({ checkAgents }));
  assert.deepEqual(loadProjectConfig({ cwd: root }).checkAgents, checkAgents);
  assert.deepEqual(checkAgentsExclude(root), checkAgents.exclude);
  fs.writeFileSync(configFile, JSON.stringify({}));
  assert.deepEqual(checkAgentsExclude(root), []);

  for (const invalid of [
    null,
    [],
    { exclude: 'docs/*.md' },
    { exclude: [''] },
    { exclude: ['../out/*.md'] },
    { exclude: ['/tmp/*.md'] },
    { exclude: ['docs\\*.md'] },
    { exclude: ['docs/**x.md'] },
    { exclude: ['docs/?.md'] },
    { exclude: [], unexpected: true },
  ]) {
    fs.writeFileSync(configFile, JSON.stringify({ checkAgents: invalid }));
    assert.throws(() => loadProjectConfig({ cwd: root }), /checkAgents/, JSON.stringify(invalid));
    assert.throws(() => checkAgentsExclude(root), /checkAgents/, JSON.stringify(invalid));
  }
});

test('glob matching uses * inside a segment and ** for whole segments', () => {
  assert.ok(globMatches('.orchestration/tenant-*.md', '.orchestration/tenant-resources.md'));
  assert.ok(!globMatches('.orchestration/tenant-*.md', '.orchestration/deep/tenant-resources.md'));
  assert.ok(globMatches('docs/**/*.md', 'docs/a.md'));
  assert.ok(globMatches('docs/**/*.md', 'docs/a/b/c.md'));
  assert.ok(globMatches('docs/**', 'docs/a/b.md'));
  assert.ok(!globMatches('docs/*.md', 'docs/a/b.md'));
  assert.ok(!globMatches('docs/a.md', 'docs/a.mdx'));
});

test('project config reads overrides and rejects malformed allowedModels', () => {
  const root = temporaryRepo();
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ slug: 'example', baseBranch: 'trunk', allowedModels: ['gpt-6-luna'], agentStartTimeoutMs: 120000 }));
  const config = loadProjectConfig({ cwd: root });
  assert.equal(config.slug, 'example');
  assert.equal(config.baseBranch, 'trunk');
  assert.deepEqual(config.allowedModels, ['gpt-6-luna']);
  assert.equal(config.agentStartTimeoutMs, 120000);
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ allowedModels: 'gpt-6-luna' }));
  assert.throws(() => loadProjectConfig({ cwd: root }), /allowedModels must be null or an array/);
  for (const invalid of [0, 300001, 1.5, '90000']) {
    fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ agentStartTimeoutMs: invalid }));
    assert.throws(() => loadProjectConfig({ cwd: root }), /agentStartTimeoutMs must be an integer from 1 to 300000/);
  }
});

test('project imageBudget defaults to ten and accepts only positive integers', () => {
  const root = temporaryRepo();
  assert.equal(loadProjectConfig({ cwd: root }).imageBudget, 10);
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ imageBudget: 4 }));
  assert.equal(loadProjectConfig({ cwd: root }).imageBudget, 4);
  for (const imageBudget of [0, -1, 1.5, '10', null]) {
    fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ imageBudget }));
    assert.throws(() => loadProjectConfig({ cwd: root }), /imageBudget must be a positive integer/);
  }
});

test('Herdr runner returns plain pane-read text without JSON parsing', () => {
  const runner = createHerdrRunner((args) => {
    assert.deepEqual(args, ['pane', 'read', 'ws:p2', '--source', 'visible', '--lines', '40', '--format', 'text']);
    return '% ';
  });
  assert.deepEqual(runner(['pane', 'read', 'ws:p2', '--source', 'visible', '--lines', '40', '--format', 'text']), { text: '% ' });
});

test('worker pane readiness recognizes Oh My Zsh git prompt marks', () => {
  for (const prompt of ['➜  project git:(main) ✗', '➜  project git:(main) ✔']) {
    let reads = 0;
    const herdr = (args) => {
      if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: 'ws:p2', workspace_id: 'ws', foreground_cwd: '/worktree' } };
      if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
      if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: { shell_pid: 42, foreground_processes: [{ pid: 42 }] } };
      if (args[0] === 'pane' && args[1] === 'read') { reads++; return { text: `${prompt}\n` }; }
      throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
    };
    waitForWorkerPane('ws:p2', 'ws', '/worktree', herdr, () => assert.fail('a recognized prompt must return immediately'));
    assert.equal(reads, 1, `${prompt} must be recognized as a prompt`);
  }
});

test('worker pane readiness uses its configured timeout', () => {
  let waits = 0;
  const herdr = () => { throw new Error('pane is not ready'); };
  assert.throws(() => waitForWorkerPane('ws:p2', 'ws', '/worktree', herdr, () => { waits++; }, { timeoutMs: 90_000 }), /within 90 seconds/);
  assert.equal(waits, 360);
});

test('brief rendering fills known slots and rejects an unknown slot', () => {
  assert.equal(renderBrief('Worker {{name}} in {{project}}: {{task}} / {{allowedPaths}}', {
    name: 'demo', project: 'sample', task: 'do the work', allowedPaths: ['src/', 'test/'],
  }), 'Worker demo in sample: do the work / - src/\n- test/');
  assert.equal(renderBrief('Issue {{issue}}', {}), 'Issue (none)');
  assert.throws(() => renderBrief('Bad {{notAContractSlot}}', {}), /Unknown brief template slot/);
  const template = fs.readFileSync(path.resolve('kit/templates/worker-brief.md'), 'utf8');
  assert.match(template, /WORKER REPORT.*WORKER QUESTION.*fails, record the failed command and reason in the worker report, then stop/s);
  assert.match(template, /Boss monitors report metadata and will notify the orchestrator/);
  assert.match(template, /These report and question commands are an exception to the rule against Herdr commands outside Herdr/);
  assert.match(template, /{{herdrEnvPrefix}}{{herdrBin}} agent prompt {{orchAgent}} "WORKER QUESTION/);
  assert.match(template, /{{herdrEnvPrefix}}{{herdrBin}} agent prompt {{orchAgent}} "WORKER REPORT/);
});

test('worker report and delegated run validation enforce their handoff schemas', () => {
  assert.deepEqual(validateWorkerReport(validReport, { evidenceTiers: tiers }), []);
  assert.deepEqual(validateWorkerReport({ ...validReport, issue: null }, { evidenceTiers: tiers }), []);
  assert.ok(validateWorkerReport({ ...validReport, stoppedEarly: 'no', evidenceTier: ['reload'] }, { evidenceTiers: tiers }).some((error) => error.includes('unknown')));
  assert.ok(validateWorkerReport({ ...validReport, changedPaths: 'src/a.js' }, { evidenceTiers: tiers }).some((error) => error.includes('changedPaths must be an array')));
  assert.deepEqual(validateDelegatedRun(validRun, { evidenceTiers: tiers }), []);
  assert.deepEqual(validateDelegatedRun({ ...validRun, issue: null, toolCalls: null }, { evidenceTiers: tiers }), []);
  assert.ok(validateDelegatedRun({ ...validRun, issue: 0 }, { evidenceTiers: tiers }).some((error) => error.includes('issue')));
});

test('ledger append and read validate JSONL entries', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-ledger-'));
  const file = path.join(directory, 'runs.jsonl');
  appendDelegatedRun(file, validRun, { evidenceTiers: tiers });
  assert.deepEqual(readDelegatedRuns(file, { evidenceTiers: tiers }), [validRun]);
  fs.appendFileSync(file, '{bad json}\n');
  assert.throws(() => readDelegatedRuns(file, { evidenceTiers: tiers }), /Invalid JSONL entry 2/);
});

test('scope comparison accepts allowed directories and reports paths outside them', () => {
  assert.deepEqual(compareChangedPaths(['src/a.js', 'test/a.test.js', 'docs/new.md'], ['src/', 'test/*.test.js']), ['docs/new.md']);
  assert.deepEqual(validateAllowedPaths(['src/', 'test/a.test.js']), []);
  assert.ok(validateAllowedPaths(['../outside']).some((error) => error.includes('stay inside')));
});

test('committed rename checks both removed and added paths', () => {
  const root = temporaryRepo();
  git(root, 'switch', '-c', 'worker');
  git(root, 'mv', 'README.md', 'renamed.md');
  git(root, 'commit', '-m', 'rename');
  assert.deepEqual(gitChangedPaths(root, 'main').sort(), ['README.md', 'renamed.md']);
});

test('safe GitHub arguments require one body file and reject inline bodies', () => {
  assert.deepEqual(buildGhArgs('create', ['--title', 'Example', '--body-file', 'body.md']), ['issue', 'create', '--title', 'Example', '--body-file', 'body.md']);
  assert.deepEqual(buildGhArgs('comment', ['17', '--body-file', 'body.md']), ['issue', 'comment', '17', '--body-file', 'body.md']);
  assert.throws(() => buildGhArgs('edit', ['17', '--body', 'unsafe']), /inline --body/);
  assert.throws(() => buildGhArgs('comment', ['nope', '--body-file', 'body.md']), /numeric issue/);
  assert.throws(() => buildGhArgs('create', ['--body-file', 'one.md', '--body-file', 'two.md']), /exactly one/);
});

test('worktree classification uses temporary git state and live pane cwd', () => {
  const root = temporaryRepo();
  const safe = path.join(path.dirname(root), `${path.basename(root)}-wt-safe`);
  git(root, 'switch', '-c', 'safe');
  fs.writeFileSync(path.join(root, 'safe.txt'), 'merged\n');
  git(root, 'add', 'safe.txt');
  git(root, 'commit', '-m', 'safe change');
  git(root, 'switch', 'main');
  git(root, 'merge', '--no-ff', 'safe', '-m', 'merge safe');
  git(root, 'worktree', 'add', safe, 'safe');
  const busy = path.join(path.dirname(root), `${path.basename(root)}-wt-busy`);
  git(root, 'worktree', 'add', '-b', 'busy', busy, 'main');
  const dirty = path.join(path.dirname(root), `${path.basename(root)}-wt-dirty`);
  git(root, 'worktree', 'add', '-b', 'dirty', dirty, 'main');
  fs.writeFileSync(path.join(dirty, 'local.txt'), 'uncommitted\n');
  const config = loadProjectConfig({ cwd: root });
  const classified = classifyWorktrees(config, { panes: [{ cwd: path.join(busy, 'src') }], now: Date.now() });
  const byPath = new Map(classified.map((item) => [item.path, item]));
  assert.equal(byPath.get(safe).merged, true);
  assert.equal(byPath.get(safe).clean, true);
  assert.equal(byPath.get(safe).removable, true);
  assert.equal(byPath.get(busy).livePane, true);
  assert.equal(byPath.get(busy).removable, false);
  assert.equal(byPath.get(dirty).clean, false);
  assert.equal(byPath.get(dirty).removable, false);
  assert.equal(byPath.get(root).isPrimary, true);
});

test('worktree apply removes a clean merged worker tree in a temporary repo', () => {
  const root = temporaryRepo();
  const safe = path.join(path.dirname(root), `${path.basename(root)}-wt-safe`);
  git(root, 'switch', '-c', 'safe');
  fs.writeFileSync(path.join(root, 'safe.txt'), 'merged\n');
  git(root, 'add', 'safe.txt');
  git(root, 'commit', '-m', 'safe change');
  git(root, 'switch', 'main');
  git(root, 'merge', '--no-ff', 'safe', '-m', 'merge safe');
  git(root, 'worktree', 'add', safe, 'safe');
  const config = loadProjectConfig({ cwd: root });
  const output = [];
  const remaining = pruneWorktrees(config, { apply: true, herdr: () => ({ panes: [] }), listProcesses: () => [], output: (text) => output.push(text) });
  assert.equal(remaining.find((item) => item.path === safe).removable, true);
  assert.equal(fs.existsSync(safe), false);
  assert.throws(() => git(root, 'show-ref', '--verify', 'refs/heads/safe'));
  assert.ok(output.some((line) => line.includes(`Removed ${safe}`)));
});

function generatedKitWorktree(name = 'generated-kit', {
  ignoreWorkerFiles = false,
  baseKit = 'base generated kit\n',
  worktreeKit = projectKit().text,
  historicalKitVersions = [],
} = {}) {
  const root = temporaryRepo();
  const generated = path.join(root, 'docs', 'orchestration', 'herdr-boss.md');
  fs.mkdirSync(path.dirname(generated), { recursive: true });
  for (const [index, version] of historicalKitVersions.entries()) {
    fs.writeFileSync(generated, version);
    git(root, 'add', 'docs/orchestration/herdr-boss.md');
    git(root, 'commit', '-m', `generated kit history ${index + 1}`);
  }
  fs.writeFileSync(generated, baseKit);
  git(root, 'add', 'docs/orchestration/herdr-boss.md');
  if (ignoreWorkerFiles) {
    fs.writeFileSync(path.join(root, '.gitignore'), '.worker/\n.orchestration/\nopencode.json\n');
    git(root, 'add', '.gitignore');
  }
  git(root, 'commit', '-m', 'add generated kit');
  const worktree = path.join(path.dirname(root), `${path.basename(root)}-wt-${name}`);
  git(root, 'worktree', 'add', '-b', name, worktree, 'main');
  fs.writeFileSync(path.join(worktree, 'docs', 'orchestration', 'herdr-boss.md'), worktreeKit);
  fs.mkdirSync(path.join(worktree, '.worker'), { recursive: true });
  fs.writeFileSync(path.join(worktree, '.worker', 'report.md'), 'worker report\n');
  fs.writeFileSync(path.join(worktree, '.worker', 'report.json'), '{"issue":null}\n');
  fs.writeFileSync(path.join(worktree, '.worker', 'brief.md'), 'worker brief\n');
  fs.writeFileSync(path.join(worktree, 'opencode.json'), '{"model":"sample"}\n');
  fs.mkdirSync(path.join(worktree, '.orchestration'), { recursive: true });
  fs.writeFileSync(path.join(worktree, '.orchestration', 'local.md'), 'worker input\n');
  return { root, worktree, generated, config: loadProjectConfig({ cwd: root }) };
}

test('worktree prune treats generated kit and worker files as clean, restores and archives on apply', (t) => {
  const { root, worktree, generated, config } = generatedKitWorktree();
  t.after(() => {
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const dryRun = [];
  const candidate = pruneWorktrees(config, {
    herdr: () => ({ panes: [] }),
    listProcesses: () => [],
    output: (line) => dryRun.push(line),
  }).find((item) => item.path === worktree);

  assert.equal(candidate.merged, true);
  assert.equal(candidate.clean, true);
  assert.equal(candidate.removable, true);
  assert.equal(candidate.generatedKitDirty, true);
  assert.ok(dryRun.includes(`${worktree}: would restore the generated kit file`));
  assert.equal(fs.existsSync(worktree), true, 'a dry run keeps the worktree');
  assert.equal(fs.readFileSync(generated, 'utf8'), 'base generated kit\n', 'a dry run does not change the main checkout');

  const applied = [];
  pruneWorktrees(config, {
    apply: true,
    herdr: () => ({ panes: [] }),
    listProcesses: () => [],
    output: (line) => applied.push(line),
  });
  assert.equal(fs.existsSync(worktree), false);
  assert.ok(applied.some((line) => line.includes('Restored the generated kit file')));
  const archive = path.join(root, '.orchestration', 'reports', 'generated-kit');
  assert.equal(fs.readFileSync(path.join(archive, 'report.md'), 'utf8'), 'worker report\n');
  assert.equal(fs.readFileSync(path.join(archive, 'report.json'), 'utf8'), '{"issue":null}\n');
  assert.equal(fs.readFileSync(path.join(archive, 'brief.md'), 'utf8'), 'worker brief\n');
  assert.throws(() => git(root, 'show-ref', '--verify', 'refs/heads/generated-kit'));
});

test('worktree prune removes ignored worker files from its allowed paths', (t) => {
  const { root, worktree, config } = generatedKitWorktree('generated-kit-ignored', { ignoreWorkerFiles: true });
  t.after(() => {
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const output = [];
  const candidate = pruneWorktrees(config, {
    apply: true,
    herdr: () => ({ panes: [] }),
    listProcesses: () => [],
    output: (line) => output.push(line),
  }).find((item) => item.path === worktree);

  assert.equal(candidate.removable, true);
  assert.equal(fs.existsSync(worktree), false);
  assert.ok(output.some((line) => line.includes(`Removed ${worktree}`)));
  const archive = path.join(root, '.orchestration', 'reports', 'generated-kit-ignored');
  assert.equal(fs.readFileSync(path.join(archive, 'report.md'), 'utf8'), 'worker report\n');
});

test('worktree prune keeps staged, hand-edited, and symlinked generated kit changes', (t) => {
  for (const { name, staged, symlink } of [
    { name: 'generated-kit-staged-edit', staged: true },
    { name: 'generated-kit-hand-edit', staged: false },
    { name: 'generated-kit-symlink-edit', staged: false, symlink: true },
  ]) {
    const { root, worktree, generated, config } = generatedKitWorktree(name);
    t.after(() => {
      fs.rmSync(worktree, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    });
    const file = path.join(worktree, 'docs', 'orchestration', 'herdr-boss.md');
    let expectedContent = `private hand edit ${name}\n`;
    if (symlink) {
      const target = path.join(worktree, '.worker', 'kit-copy.md');
      expectedContent = projectKit().text;
      fs.writeFileSync(target, expectedContent);
      fs.rmSync(file);
      fs.symlinkSync(target, file);
    } else {
      fs.writeFileSync(file, expectedContent);
    }
    if (staged) git(worktree, 'add', 'docs/orchestration/herdr-boss.md');
    const output = [];
    const candidate = pruneWorktrees(config, {
      apply: true,
      herdr: () => ({ panes: [] }),
      listProcesses: () => [],
      output: (line) => output.push(line),
    }).find((item) => item.path === worktree);

    assert.equal(candidate.clean, false, name);
    assert.equal(candidate.removable, false, name);
    assert.ok(candidate.dirtyPaths.includes('docs/orchestration/herdr-boss.md'), name);
    assert.equal(fs.existsSync(worktree), true, name);
    assert.equal(fs.readFileSync(file, 'utf8'), expectedContent, name);
    assert.equal(fs.readFileSync(generated, 'utf8'), 'base generated kit\n', name);
    assert.equal(output.some((line) => /Restored the generated kit file/.test(line)), false, name);
  }
});

test('worktree prune restores a generated kit version from base history', (t) => {
  const oldVersion = 'historical generated kit version\n';
  const currentVersion = projectKit().text;
  const { root, worktree, generated, config } = generatedKitWorktree('generated-kit-old', {
    historicalKitVersions: [oldVersion],
    baseKit: currentVersion,
    worktreeKit: oldVersion,
  });
  t.after(() => {
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  let restored;
  const applied = [];
  const candidate = pruneWorktrees(config, {
    apply: true,
    herdr: () => ({ panes: [] }),
    listProcesses: () => [],
    checkoutKitFile: (cwd, file) => {
      git(cwd, 'checkout', '--', file);
      restored = fs.readFileSync(path.join(cwd, file), 'utf8');
    },
    output: (line) => applied.push(line),
  }).find((item) => item.path === worktree);

  assert.equal(candidate.generatedKitDirty, true);
  assert.equal(restored, currentVersion);
  assert.equal(fs.existsSync(worktree), false);
  assert.ok(applied.some((line) => line.includes('Restored the generated kit file')));
  assert.equal(fs.readFileSync(generated, 'utf8'), currentVersion);
});

test('worktree prune keeps a generated kit worktree when checkout fails', (t) => {
  const oldVersion = 'historical generated kit version\n';
  const { root, worktree, config } = generatedKitWorktree('generated-kit-checkout-fail', {
    historicalKitVersions: [oldVersion],
    baseKit: projectKit().text,
    worktreeKit: oldVersion,
  });
  t.after(() => {
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const output = [];
  const result = pruneWorktrees(config, {
    apply: true,
    herdr: () => ({ panes: [] }),
    listProcesses: () => [],
    checkoutKitFile: () => { throw new Error('simulated checkout failure'); },
    output: (line) => output.push(line),
  });
  const candidate = result.find((item) => item.path === worktree);

  assert.equal(candidate.restoreError, 'simulated checkout failure');
  assert.equal(fs.existsSync(worktree), true);
  assert.equal(fs.readFileSync(path.join(worktree, 'docs', 'orchestration', 'herdr-boss.md'), 'utf8'), oldVersion);
  assert.ok(output.some((line) => /Restore of the generated kit file failed: simulated checkout failure; worktree kept\./.test(line)));
});

test('worktree prune rejects a non-null empty target path', (t) => {
  const { root, worktree, config } = generatedKitWorktree('generated-kit-empty-target');
  t.after(() => {
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  for (const worktreePath of ['', false, 0]) {
    assert.throws(() => pruneWorktrees(config, {
      worktreePath,
      herdr: () => ({ panes: [] }),
      listProcesses: () => [],
      output: () => {},
    }), /worktreePath must be null or a non-empty path/);
  }
});

test('worktree prune keeps generated kit changes when another project path is dirty', (t) => {
  const { root, worktree, generated, config } = generatedKitWorktree('generated-kit-extra-dirty');
  t.after(() => {
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(worktree, 'local-change.txt'), 'keep this project change\n');
  const output = [];
  const candidate = pruneWorktrees(config, {
    apply: true,
    herdr: () => ({ panes: [] }),
    listProcesses: () => [],
    output: (line) => output.push(line),
  }).find((item) => item.path === worktree);

  assert.equal(candidate.merged, true);
  assert.equal(candidate.clean, false);
  assert.equal(candidate.removable, false);
  assert.match(output.find((line) => line.startsWith(`${worktree} `)), /merged, dirty/);
  assert.equal(fs.existsSync(worktree), true);
  assert.equal(fs.readFileSync(path.join(worktree, 'docs', 'orchestration', 'herdr-boss.md'), 'utf8'), projectKit().text, 'prune does not restore one path from a dirty worktree');
  assert.equal(fs.existsSync(path.join(root, '.orchestration', 'reports')), false);
});

test('worktree prune ignores done agents but keeps parked and unknown existing panes live', (t) => {
  const root = temporaryRepo();
  const worktree = path.join(path.dirname(root), `${path.basename(root)}-wt-done`);
  git(root, 'worktree', 'add', '-b', 'done-worker', worktree, 'main');
  t.after(() => {
    try { git(root, 'worktree', 'remove', '--force', worktree); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  const config = loadProjectConfig({ cwd: root });
  const classify = (pane) => classifyWorktrees(config, { panes: pane ? [pane] : [] }).find((item) => item.path === worktree);
  for (const status of ['working', 'blocked', 'idle', 'unknown', undefined]) {
    assert.equal(classify({ cwd: worktree, status }).livePane, true, String(status));
  }
  assert.equal(classify({ foreground_cwd: worktree, agent_status: 'done' }).livePane, false);
  assert.equal(classify({ cwd: worktree, status: 'done' }).removable, true);
  assert.equal(classify({ cwd: worktree, status: 'done', label: 'parked' }).livePane, true);
  assert.equal(classify({ cwd: worktree, status: 'done', name: 'parked' }).livePane, true);
  assert.equal(classify(null).livePane, false);
  const pruned = pruneWorktrees(config, {
    herdr: () => ({ panes: [{ cwd: worktree, agent_status: 'done' }] }),
    listProcesses: () => [{ pid: 55, ppid: 1, command: 'node', cwd: worktree }], output: () => {},
  }).find((item) => item.path === worktree);
  assert.equal(pruned.livePane, false);
  assert.equal(pruned.processBlocked, true, 'process safety still applies to a done pane');
  assert.equal(pruned.removable, false);
});

function archiveFixture(name = 'arch') {
  const root = temporaryRepo();
  const worktree = path.join(path.dirname(root), `${path.basename(root)}-wt-${name}`);
  git(root, 'switch', '-c', name);
  fs.writeFileSync(path.join(root, `${name}.txt`), 'merged\n');
  git(root, 'add', `${name}.txt`);
  git(root, 'commit', '-m', `${name} change`);
  git(root, 'switch', 'main');
  git(root, 'merge', '--no-ff', name, '-m', `merge ${name}`);
  git(root, 'worktree', 'add', worktree, name);
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '.worker/\n');
  fs.mkdirSync(path.join(worktree, '.worker', 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(worktree, '.worker', 'report.md'), 'human report\n');
  fs.writeFileSync(path.join(worktree, '.worker', 'report.json'), '{"issue":null}\n');
  fs.writeFileSync(path.join(worktree, '.worker', 'brief.md'), 'brief\n');
  fs.writeFileSync(path.join(worktree, '.worker', 'tmp', 'scratch.txt'), 'scratch\n');
  fs.writeFileSync(path.join(worktree, '.worker', 'inputs.txt'), 'input\n');
  const target = path.join(root, '.orchestration', 'reports', name);
  const run = (options = {}) => {
    const lines = [];
    const config = loadProjectConfig({ cwd: root });
    const result = pruneWorktrees(config, { apply: true, herdr: () => ({ panes: [] }), listProcesses: () => [], output: (line) => lines.push(line), ...options });
    return { lines, result };
  };
  return { root, worktree, target, run };
}

test('worktree prune archives the three worker reports into the main checkout before removal', (t) => {
  const { root, worktree, target, run } = archiveFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { lines } = run();
  assert.equal(fs.existsSync(worktree), false);
  assert.deepEqual(fs.readdirSync(target).sort(), ['brief.md', 'report.json', 'report.md']);
  assert.equal(fs.readFileSync(path.join(target, 'report.md'), 'utf8'), 'human report\n');
  assert.ok(target.startsWith(path.join(root, '.orchestration', 'reports') + path.sep));
  assert.ok(lines.includes(`archived reports of arch to ${target}`));
});

test('worktree prune keeps an older archive and writes a newer report to a suffixed folder', (t) => {
  const { root, worktree, target, run } = archiveFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'report.md'), 'older copy\n');
  fs.rmSync(path.join(worktree, '.worker', 'report.json'));
  const { lines } = run({ now: Date.UTC(2026, 8, 30, 12, 0, 0) });
  const suffixed = path.join(path.dirname(target), 'arch-20260930T120000Z');
  assert.equal(fs.existsSync(worktree), false);
  assert.equal(fs.readFileSync(path.join(target, 'report.md'), 'utf8'), 'older copy\n');
  assert.deepEqual(fs.readdirSync(target), ['report.md']);
  assert.equal(fs.readFileSync(path.join(suffixed, 'report.md'), 'utf8'), 'human report\n');
  assert.deepEqual(fs.readdirSync(suffixed).sort(), ['brief.md', 'report.md']);
  assert.ok(lines.includes('skipped report.json: missing'));
  assert.ok(lines.includes(`archived reports of arch to ${suffixed}`));
});

test('worktree prune adds a counter when the suffixed folder exists', (t) => {
  const { root, target, run } = archiveFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'report.md'), 'older copy\n');
  fs.mkdirSync(path.join(path.dirname(target), 'arch-20260930T120000Z'));
  run({ now: Date.UTC(2026, 8, 30, 12, 0, 0) });
  assert.equal(fs.readFileSync(path.join(path.dirname(target), 'arch-20260930T120000Z-2', 'report.json'), 'utf8'), '{"issue":null}\n');
});

test('worktree prune keeps the worktree when .worker is a symlink', (t) => {
  const { root, worktree, run } = archiveFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-worker-link-'));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  fs.writeFileSync(path.join(elsewhere, 'report.md'), 'outside\n');
  fs.rmSync(path.join(worktree, '.worker'), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(worktree, '.worker'));
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '.worker\n');
  const { lines } = run();
  assert.equal(fs.existsSync(worktree), true);
  assert.ok(lines.some((line) => line.startsWith('Archive of arch failed:') && line.includes('.worker is not a real directory')));
  assert.equal(fs.existsSync(path.join(root, '.orchestration', 'reports')), false);
});

test('worktree prune keeps the worktree when the archive folder is a symlink', (t) => {
  const { root, worktree, target, run } = archiveFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-archive-link-'));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(elsewhere, target);
  const { lines } = run();
  assert.equal(fs.existsSync(worktree), true);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  assert.ok(lines.some((line) => line.startsWith('Archive of arch failed:')));
});

test('worktree prune skips a report larger than 1 MB', (t) => {
  const { root, worktree, target, run } = archiveFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(worktree, '.worker', 'report.md'), Buffer.alloc(1024 * 1024 + 1, 'a'));
  const { lines } = run();
  assert.ok(lines.includes('skipped report.md: over 1 MB'));
  assert.equal(fs.existsSync(worktree), false);
  assert.deepEqual(fs.readdirSync(target).sort(), ['brief.md', 'report.json']);
});

test('worktree prune keeps the worktree when the archive copy fails', (t) => {
  const { root, worktree, target, run } = archiveFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'a file where the folder belongs\n');
  const { lines } = run();
  assert.equal(fs.existsSync(worktree), true);
  assert.ok(lines.some((line) => line.startsWith('Archive of arch failed:') && line.includes('worktree kept')));
  assert.ok(!lines.some((line) => line.startsWith('Removed ')));
});

test('worktree prune --no-archive removes the worktree without a copy', (t) => {
  const { root, worktree, run } = archiveFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { lines } = run({ archive: false });
  assert.equal(fs.existsSync(worktree), false);
  assert.equal(fs.existsSync(path.join(root, '.orchestration', 'reports')), false);
  assert.ok(!lines.some((line) => line.startsWith('archived reports')));
});

test('worktree prune without --apply archives nothing', (t) => {
  const { root, worktree, run } = archiveFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  run({ apply: false });
  assert.equal(fs.existsSync(worktree), true);
  assert.equal(fs.existsSync(path.join(root, '.orchestration', 'reports')), false);
});

test('worktree prune blocks live cwd processes, missing-worktree orphans, and failed scans', (t) => {
  const root = temporaryRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const safe = path.join(path.dirname(root), `${path.basename(root)}-wt-process`);
  git(root, 'switch', '-c', 'process-safe');
  fs.writeFileSync(path.join(root, 'safe.txt'), 'merged\n');
  git(root, 'add', 'safe.txt');
  git(root, 'commit', '-m', 'safe change');
  git(root, 'switch', 'main');
  git(root, 'merge', '--no-ff', 'process-safe', '-m', 'merge safe');
  git(root, 'worktree', 'add', safe, 'process-safe');
  const config = loadProjectConfig({ cwd: root });
  const live = [];
  const kept = pruneWorktrees(config, {
    apply: true,
    herdr: () => ({ panes: [] }),
    listProcesses: () => [{ pid: 321, ppid: 44, command: 'node --token should-not-print', cwd: path.join(safe, 'src') }],
    output: (line) => live.push(line),
  });
  assert.equal(kept.find((item) => item.path === safe).removable, false);
  assert.equal(kept.find((item) => item.path === safe).processBlocked, true);
  assert.equal(kept.find((item) => item.path === safe).processes[0].pid, 321);
  assert.equal(fs.existsSync(safe), true);
  assert.ok(live.some((line) => line.includes(`node (pid 321, ppid 44, cwd ${path.join(safe, 'src')})`)));
  assert.ok(!live.join('\n').includes('should-not-print'));

  fs.rmSync(safe, { recursive: true, force: true });
  const orphanLines = [];
  const orphaned = pruneWorktrees(config, {
    apply: true,
    herdr: () => ({ panes: [] }),
    listProcesses: () => [{ pid: 322, ppid: 1, command: 'zsh', cwd: path.join(safe, 'deleted-subdir') }],
    output: (line) => orphanLines.push(line),
  });
  const missing = orphaned.find((item) => item.path === safe);
  assert.equal(missing.exists, false);
  assert.equal(missing.processBlocked, true);
  assert.deepEqual(missing.processes.map((item) => item.pid), [322]);
  assert.ok(orphanLines.some((line) => line.includes(`zsh (pid 322, ppid 1, cwd ${path.join(safe, 'deleted-subdir')})`)));
  assert.ok(git(root, 'worktree', 'list', '--porcelain').includes(safe), 'the missing worktree record stays available for inspection');

  const failedLines = [];
  const afterFailure = pruneWorktrees(config, {
    apply: true,
    herdr: () => ({ panes: [] }),
    listProcesses: () => { throw new Error('lsof unavailable'); },
    output: (line) => failedLines.push(line),
  });
  assert.equal(afterFailure.find((item) => item.path === safe).processScanError, 'lsof unavailable');
  assert.ok(failedLines.some((line) => /Process scan failed.*no worktrees can be removed/.test(line)));
});

test('project locks enforce pane ownership, wait, stale takeover, and safe release', (t) => {
  const root = temporaryRepo('herdr-lock-');
  const linked = path.join(path.dirname(root), `${path.basename(root)}-linked`);
  git(root, 'worktree', 'add', '-b', 'linked-lock-test', linked, 'main');
  t.after(() => {
    try { git(root, 'worktree', 'remove', '--force', linked); } catch {}
    try { git(root, 'branch', '-D', 'linked-lock-test'); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(linked, { recursive: true, force: true });
  });
  const config = loadProjectConfig({ cwd: root });
  const linkedConfig = loadProjectConfig({ cwd: linked });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-lock-data-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const livePanes = new Set(['ws:orch-a', 'ws:orch-b']);
  const livePids = new Set([501, 502]);
  let caller = 'ws:orch-a';
  let sleepCount = 0;
  const calls = [];
  const herdr = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: args[2], workspace_id: 'ws', label: 'orch' } };
    if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: { shell_pid: args.at(-1) === 'ws:orch-a' ? 501 : 502 } };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [...livePanes].map((pane_id) => ({ pane_id })) };
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const options = (projectConfig = config) => ({
    config: projectConfig,
    lockDataDir: dataDir,
    env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: caller },
    herdr,
    pidAlive: (pid) => livePids.has(pid),
    output: () => {},
    now: () => Date.parse('2026-09-26T12:00:00.000Z'),
    pause: () => {
      sleepCount += 1;
      caller = 'ws:orch-a';
      runKitCommand('lock', ['release', 'deploy'], options(config));
      caller = 'ws:orch-b';
    },
  });
  const output = [];
  caller = 'ws:orch-a';
  const created = runKitCommand('lock', ['acquire', 'deploy'], { ...options(), output: (line) => output.push(line) });
  assert.equal(created.ownerPane, 'ws:orch-a');
  assert.equal(created.pid, 501);
  assert.equal(created.command, 'herdr-boss lock acquire deploy');
  assert.equal(created.acquiredAt, '2026-09-26T12:00:00.000Z');
  assert.throws(() => runKitCommand('lock', ['acquire', 'deploy'], { ...options(), config: linkedConfig }), /held by active pane ws:orch-a \(PID 501/i);
  caller = 'ws:orch-b';
  assert.throws(() => runKitCommand('lock', ['release', 'deploy'], { ...options(), config: linkedConfig }), /active lock.*another pane/i);
  const waited = runKitCommand('lock', ['acquire', 'deploy', '--wait', '2'], { ...options(linkedConfig), output: (line) => output.push(line) });
  assert.equal(waited.ownerPane, 'ws:orch-b');
  assert.equal(sleepCount, 1);
  assert.ok(calls.includes('pane get ws:orch-b'));
  assert.equal(fs.statSync(path.join(dataDir, 'locks')).mode & 0o777, 0o700);
  const repositoryLocksDir = path.join(dataDir, 'locks', fs.readdirSync(path.join(dataDir, 'locks'))[0]);
  assert.equal(fs.statSync(repositoryLocksDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(repositoryLocksDir, 'deploy.json')).mode & 0o777, 0o600);
  const listed = runKitCommand('lock', ['list'], { ...options(linkedConfig), output: (line) => output.push(line) });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].ownerPane, 'ws:orch-b');
  assert.equal(listed[0].state, 'live');
  const permissionDenied = runKitCommand('lock', ['list'], {
    ...options(linkedConfig),
    pidAlive: () => { const error = new Error('permission denied'); error.code = 'EPERM'; throw error; },
    output: () => {},
  });
  assert.equal(permissionDenied[0].state, 'live');
  const herdrUnavailable = (args) => {
    if (args[0] === 'pane' && args[1] === 'list') throw new Error('pane service unavailable');
    return herdr(args);
  };
  assert.throws(() => runKitCommand('lock', ['list'], { ...options(linkedConfig), herdr: herdrUnavailable, output: () => {} }), /pane service unavailable/);
  caller = 'ws:orch-a';
  assert.throws(() => runKitCommand('lock', ['release', 'deploy'], options()), /active lock.*another pane/i);
  livePids.delete(502);
  caller = 'ws:orch-a';
  const stale = runKitCommand('lock', ['list'], { ...options(), output: () => {} });
  assert.equal(stale[0].state, 'stale');
  const takeover = runKitCommand('lock', ['acquire', 'deploy'], { ...options(), output: (line) => output.push(line) });
  assert.equal(takeover.ownerPane, 'ws:orch-a');
  assert.equal(takeover.state, 'live');
  assert.ok(output.some((line) => /NOTICE.*taking over stale lock.*ws:orch-b.*502/i.test(line)));
  caller = 'ws:orch-b';
  assert.throws(() => runKitCommand('lock', ['release', 'deploy'], options()), /active lock.*another pane/i);
  caller = 'ws:orch-a';
  runKitCommand('lock', ['release', 'deploy'], options());
  assert.equal(runKitCommand('lock', ['list'], { ...options(), output: () => {} }).length, 0);
  runKitCommand('lock', ['acquire', 'closed-pane'], options());
  livePanes.delete('ws:orch-a');
  const closedPaneLock = runKitCommand('lock', ['list'], { ...options(), output: () => {} });
  assert.equal(closedPaneLock[0].state, 'stale');
  caller = 'ws:orch-b';
  assert.equal(runKitCommand('lock', ['acquire', 'closed-pane'], options()).ownerPane, 'ws:orch-b');
  runKitCommand('lock', ['release', 'closed-pane'], options());
  assert.throws(() => runKitCommand('lock', ['acquire', '../unsafe'], options()), /lock name.*path-safe/i);
  assert.throws(() => runKitCommand('lock', ['acquire', 'deploy', '--wait', '1.5'], options()), /whole non-negative number/i);
});

test('a concurrent lock mutation cannot replace an observed stale lock during takeover', (t) => {
  const root = temporaryRepo('herdr-lock-race-');
  const config = loadProjectConfig({ cwd: root });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-lock-race-data-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const livePanes = new Set(['ws:orch-a', 'ws:orch-b', 'ws:orch-stale']);
  const livePids = new Set([701, 702, 703]);
  const pids = { 'ws:orch-a': 701, 'ws:orch-b': 702, 'ws:orch-stale': 703 };
  let caller = 'ws:orch-stale';
  let competingAcquireTried = false;
  let competingAcquireError;
  const herdr = (args) => {
    if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: args[2], workspace_id: 'ws', label: 'orch' } };
    if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: { shell_pid: pids[args.at(-1)] } };
    if (args[0] === 'pane' && args[1] === 'list') {
      if (!competingAcquireTried) {
        competingAcquireTried = true;
        caller = 'ws:orch-b';
        try { runKitCommand('lock', ['acquire', 'deploy'], options()); }
        catch (error) { competingAcquireError = error; }
        finally { caller = 'ws:orch-a'; }
      }
      return { panes: [...livePanes].map((pane_id) => ({ pane_id })) };
    }
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const options = () => ({
    config,
    lockDataDir: dataDir,
    env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: caller },
    herdr,
    pidAlive: (pid) => livePids.has(pid),
    output: () => {},
    now: () => Date.parse('2026-09-26T12:00:00.000Z'),
  });

  runKitCommand('lock', ['acquire', 'deploy'], options());
  livePanes.delete('ws:orch-stale');
  caller = 'ws:orch-a';
  const takeover = runKitCommand('lock', ['acquire', 'deploy'], options());

  assert.match(competingAcquireError?.message || '', /lock operation is already in progress/i);
  assert.equal(takeover.ownerPane, 'ws:orch-a');
  caller = 'ws:orch-b';
  assert.throws(() => runKitCommand('lock', ['acquire', 'deploy'], options()), /held by active pane ws:orch-a/i);
  const listed = runKitCommand('lock', ['list'], { ...options(), output: () => {} });
  assert.equal(listed[0].ownerPane, 'ws:orch-a');
  assert.equal(listed[0].state, 'live');
});

test('worker start dry-run prints the plan and makes no worktree or agent changes', () => {
  const root = temporaryRepo();
  const template = path.join(root, 'brief-template.md');
  fs.writeFileSync(template, 'Worker {{name}}: {{task}} {{allowedPaths}}');
  const configFile = path.join(root, '.herdr-boss.json');
  fs.writeFileSync(configFile, JSON.stringify({ briefTemplate: template }));
  const config = loadProjectConfig({ cwd: root });
  const rulesFile = path.join(root, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({ updatedAt: '2026-09-24T12:00:00.000Z', avoidKinds: [], preferredKinds: ['codex'], memFreePercent: 50, notes: [], policy: { allowedKinds: ['codex'], excludedModels: [], preferredModels: { codex: 'gpt-6.1-sol' } } }));
  const models = loadModels();
  const calls = [];
  const herdr = (args) => {
    calls.push(args);
    if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } };
    if (args[0] === 'agent') return { agents: [] };
    if (args[0] === 'tab') return { tabs: [{ tab_id: 'ws:t1', workspace_id: 'ws', label: 'Workers' }] };
    if (args[0] === 'pane') return { panes: [{ pane_id: 'ws:p1', workspace_id: 'ws', tab_id: 'ws:t1', width: 160, height: 45 }] };
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const output = [];
  const result = startWorker('demo', { kind: 'codex', task: 'x', allow: ['src/'], dryRun: true }, {
    config, models, herdr, env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch' }, rulesFile, now: Date.parse('2026-09-24T12:00:00Z'), output: (text) => output.push(text),
  });
  assert.equal(result.dryRun, true);
  assert.match(output.join('\n'), /git worktree add -b demo/);
  assert.match(output.join('\n'), /Validate kind\/model\/effort: codex \/ gpt-6-luna/);
  assert.match(output.join('\n'), /herdr pane split ws:p1 --direction right --cwd/);
  assert.match(output.join('\n'), /New pane: <new-pane-id>/);
  assert.match(output.join('\n'), /herdr agent start demo --kind codex --pane '<new-pane-id>' --timeout 90000 --/);
  assert.ok(!output.join('\n').includes('tab create'));
  assert.match(output.join('\n'), /Read \.worker\/brief\.md in your working directory and execute it/);
  assert.ok(calls.some((call) => call.join(' ') === 'agent list'));
  const newPath = path.join(TEST_HOME, 'Projects', '.herdr-wt', path.basename(root), 'demo');
  assert.equal(result.worktree, newPath);
  assert.ok(output.join('\n').includes(newPath));
  assert.ok(!fs.existsSync(config.worktreePath('demo')));
  assert.ok(!fs.existsSync(path.dirname(newPath)));
  assert.ok(!fs.existsSync(path.join(config.runsPath, 'demo.json')));
  assert.deepEqual(git(root, 'branch', '--show-current'), 'main');
  const explicitOutput = [];
  startWorker('demo-explicit', { kind: 'codex', model: 'gpt-6-astra', task: 'x', allow: ['src/'], dryRun: true }, {
    config, models, herdr, env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch' }, rulesFile, now: Date.parse('2026-09-24T12:00:00Z'), output: (text) => explicitOutput.push(text),
  });
  assert.match(explicitOutput.join('\n'), /Validate kind\/model\/effort: codex \/ gpt-6-astra/);
  fs.writeFileSync(rulesFile, JSON.stringify({ avoidProviders: ['claude'], policy: { allowedKinds: ['codex'], excludedModels: [], modelProviders: { 'gpt-6.1-sol': 'claude' } } }));
  assert.throws(() => startWorker('demo-routed', { kind: 'codex', model: 'gpt-6.1-sol', task: 'x', allow: ['src/'], dryRun: true }, {
    config, models, herdr, env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch' }, rulesFile, output: () => {},
  }), /claude is ahead of quota pace or near exhaustion/);
});

test('worker start validates the caller pane and uses it for placement and reporting', () => {
  const f = setupFixture(null);
  const template = path.join(f.root, 'brief-template.md');
  fs.writeFileSync(template, 'Report target: {{orchPane}}');
  fs.writeFileSync(path.join(f.root, '.herdr-boss.json'), JSON.stringify({ briefTemplate: template }));
  const config = loadProjectConfig({ cwd: f.root });
  const calls = [];
  const herdr = (args) => {
    calls.push(args);
    if (args[0] === 'pane' && args[1] === 'get') return args[2] === 'ws:orch'
      ? { pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } }
      : { pane: { pane_id: args[2], workspace_id: 'ws', foreground_cwd: config.worktreePath('caller-valid') } };
    return f.herdr(args);
  };
  const result = startWorker('caller-valid', { kind: 'codex', task: 'x', allow: ['src/'] }, {
    config, models: loadModels(), herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  assert.equal(fs.readFileSync(path.join(result.worktree, '.worker', 'brief.md'), 'utf8'), 'Report target: ws:orch\n\n## Worker start details\n\nScreenshot budget: 10 screenshots. The project setting overrides the kit default.\n\nIn a Codex shell, run `setopt NO_BG_NICE` before a background command.\nReport a failing tool, a missing file, or missing evidence explicitly in your report. Never give a best guess in place of a result. The orchestrator verifies each claim at the source. For an eligible leftover process in this worker, run `herdr-boss worker stop-own caller-valid --pid <pid>`.\n\nStop it with `herdr-boss worker stop-own caller-valid --pid <pid>`. Never run `kill`, `pkill`, `killall`, or `kill` with a name pattern such as `kill $(pgrep …)`.\n\nCodex worker commit rule: do not run `git add` or `git commit`. Leave the change in the working tree. Say in your report that the change is uncommitted. The orchestrator commits the change with `herdr-boss worker commit caller-valid -m MESSAGE`.');
  assert.ok(calls.some((args) => args.join(' ') === 'tab list --workspace ws'));
  assert.ok(calls.some((args) => args.join(' ') === 'pane get ws:orch'));

  for (const [name, env, pane, options, message] of [
    ['caller-no-pane', { ...f.env, HERDR_PANE_ID: undefined }, { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' }, {}, /HERDR_PANE_ID is required/],
    ['caller-no-workspace', { ...f.env, HERDR_WORKSPACE_ID: undefined }, { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' }, {}, /HERDR_WORKSPACE_ID is required/],
    ['caller-id', f.env, { pane_id: 'ws:someone-else', workspace_id: 'ws', label: 'orch' }, {}, /differs from HERDR_PANE_ID/],
    ['caller-workspace', { ...f.env, HERDR_WORKSPACE_ID: 'other' }, { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' }, {}, /workspace/],
    ['caller-label', f.env, { pane_id: 'ws:orch', workspace_id: 'ws', label: 'worker' }, {}, /label/],
    ['caller-orch', f.env, { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' }, { orch: 'ws:other' }, /--orch must match/],
  ]) {
    const fixtureEntries = new Set(fs.readdirSync(f.root));
    const fixtureStatus = git(f.root, 'status', '--porcelain');
    const callsBefore = f.calls.length;
    const rejectedHerdr = (args) => {
      if (args[0] === 'pane' && args[1] === 'get') return { pane };
      return f.herdr(args);
    };
    assert.throws(() => startWorker(name, { kind: 'codex', task: 'x', allow: ['src/'], ...options }, {
      config, models: loadModels(), herdr: rejectedHerdr, env, rulesFile: f.rulesFile, output: () => {},
    }), (error) => message.test(error.message) && /Pass explicit HERDR_PANE_ID and HERDR_WORKSPACE_ID values/.test(error.message) && /restart the Codex session/.test(error.message));
    assert.equal(fs.existsSync(config.worktreePath(name)), false);
    assert.equal(fs.existsSync(path.join(config.runsPath, `${name}.json`)), false);
    assert.ok(!f.calls.slice(callsBefore).includes('agent start'));
    assert.ok(!f.calls.slice(callsBefore).some((call) => ['pane split', 'tab create', 'agent start'].includes(call)), 'invalid caller creates no worker-side Herdr resources');
    assert.equal(git(f.root, 'status', '--porcelain'), fixtureStatus, 'invalid caller does not change the fixture repository');
    assert.deepEqual(new Set(fs.readdirSync(f.root)), fixtureEntries, 'invalid caller leaves its isolated fixture paths unchanged');
  }
});

test('worker start refuses excluded caller workspace before creating worktree, tab, or agent', (t) => {
  const f = setupFixture(null);
  t.after(() => {
    const worktree = f.config.worktreePath('excluded-caller');
    try { if (fs.existsSync(worktree)) git(f.root, 'worktree', 'remove', '--force', worktree); } catch {}
    try { git(f.root, 'branch', '-D', 'excluded-caller'); } catch {}
    fs.rmSync(path.join(f.config.runsPath, 'excluded-caller.json'), { force: true });
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  const workspaceId = 'workspace-excluded';
  const workspaceLabel = 'Research Room';
  fs.writeFileSync(f.rulesFile, JSON.stringify({
    updatedAt: new Date().toISOString(),
    avoidKinds: [],
    policy: {
      allowedKinds: ['codex'], excludedModels: [], preferredModels: { codex: 'gpt-6-luna' },
      projects: { [f.config.slug]: { share: 100, mode: 'auto', excludedKinds: [], excludedModels: [] } },
    },
    control: {
      runningWorkers: 0, maxWorkers: 8,
      projects: { [f.config.slug]: { running: 0, slots: 8, effectiveMode: 'active' } },
      workspaces: [{ workspace: workspaceId, label: workspaceLabel, excluded: true }],
    },
  }));
  const calls = [];
  const herdr = (args) => {
    calls.push(args);
    if (args[0] === 'pane' && args[1] === 'get' && args[2] === 'ws:orch') {
      return { pane: { pane_id: 'ws:orch', workspace_id: workspaceId, label: 'orch' } };
    }
    if (args[0] === 'tab' && args[1] === 'create') throw new Error('Test guard: unexpected tab creation.');
    return f.herdr(args);
  };
  let failure;
  try {
    startWorker('excluded-caller', { kind: 'codex', task: 'x', allow: ['src/'], force: true, reason: 'Verify the excluded workspace refusal with an authorized override' }, {
      config: f.config, models: loadModels(), herdr, env: { ...f.env, HERDR_WORKSPACE_ID: workspaceId }, rulesFile: f.rulesFile, output: () => {},
    });
  } catch (error) { failure = error; }
  assert.ok(failure, 'worker start must refuse the excluded workspace');
  assert.match(failure.message, new RegExp(`${workspaceLabel}.*has no worker slots`));
  assert.equal(fs.existsSync(f.config.worktreePath('excluded-caller')), false);
  assert.throws(() => git(f.root, 'show-ref', '--verify', 'refs/heads/excluded-caller'));
  assert.equal(calls.some((args) => args[0] === 'tab' && args[1] === 'create'), false);
  assert.equal(calls.some((args) => args[0] === 'agent' && args[1] === 'start'), false);
});
