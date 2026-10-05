import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { BOSS_RULES_MAX, POLICY_DEFAULTS, validatePolicy } from '../src/control.js';
import { loadModels } from '../src/kit/config.js';
import { SECTION_LIMITS, bossRulesSection, bootstrapSections, openItemsSection, ownerDecisionsFrom, paneMapSection } from '../src/handoff-bootstrap.js';
import { handoffFixture, handoffPromptCalls, runHandoffCli } from './helpers/handoff-fixture.js';

const MODELS = loadModels();
const policyErrors = (result) => (Array.isArray(result) ? result : result?.errors || []).filter((message) => /bossRules/.test(message));

test('the boss rules policy field holds standing rules and has its own character limit', () => {
  assert.equal(typeof POLICY_DEFAULTS.bossRules, 'string');
  assert.ok(POLICY_DEFAULTS.bossRules.trim().length > 40, 'the default rules are the standing rules');
  assert.ok(POLICY_DEFAULTS.bossRules.length <= BOSS_RULES_MAX, 'the default rules fit the policy cap');
  assert.equal(BOSS_RULES_MAX, SECTION_LIMITS.bossRules, 'the section cap and the policy cap are the same');
  assert.deepEqual(validatePolicy(structuredClone(POLICY_DEFAULTS), MODELS), []);
  assert.deepEqual(policyErrors(validatePolicy({ ...structuredClone(POLICY_DEFAULTS), bossRules: '' }, MODELS)), [], 'an empty text turns the section off');
  assert.equal(policyErrors(validatePolicy({ ...structuredClone(POLICY_DEFAULTS), bossRules: 'R'.repeat(BOSS_RULES_MAX + 1) }, MODELS)).length, 1, 'a text over the cap is refused');
  assert.equal(policyErrors(validatePolicy({ ...structuredClone(POLICY_DEFAULTS), bossRules: 42 }, MODELS)).length, 1, 'a non-string is refused');
});

test('every generated section stays inside its own character cap', () => {
  const rules = bossRulesSection('Rule. '.repeat(4000));
  const panes = paneMapSection({ agents: Array.from({ length: 400 }, (_, i) => ({ name: `project${i}-orch`, pane_id: `w${i}:p1` })), projects: Array.from({ length: 400 }, (_, i) => ({ slug: `project${i}` })) });
  const items = openItemsSection({
    items: Array.from({ length: 400 }, (_, i) => ({ id: `m-${i}`, title: `Item ${i}`, needsAction: true })),
    tasks: Array.from({ length: 400 }, (_, i) => ({ id: `t-${i}`, title: `Task ${i}`, mailboxId: `m-${i}` })),
    decisions: Array.from({ length: 400 }, (_, i) => ({ date: '2026-10-04', text: `Decision ${i}` })),
  });
  for (const [name, section] of Object.entries({ bossRules: rules, paneMap: panes, openItems: items })) {
    assert.equal(section.title, name === 'bossRules' ? 'Boss rules' : name === 'paneMap' ? 'Pane map' : 'Open items');
    assert.ok(section.body.length <= SECTION_LIMITS[name], `${name} body is ${section.body.length} characters, cap is ${SECTION_LIMITS[name]}`);
    assert.match(section.text, new RegExp(`^${section.title}:\n`));
    assert.ok(section.text.endsWith(`\nEnd ${section.title}.`));
  }
});

test('the pane map names the Boss pane and every registered project, and marks a missing pane', () => {
  const section = paneMapSection({
    agents: [{ name: 'boss', pane_id: 'w1:p2' }, { name: 'alpha-orch', pane_id: 'w1:p9' }, { name: 'beta-orch previous', pane_id: 'w1:p8' }],
    projects: [{ slug: 'alpha' }, { slug: 'beta' }],
  });
  assert.match(section.body, /^- Boss: w1:p2$/m);
  assert.match(section.body, /^- alpha: w1:p9$/m);
  assert.match(section.body, /^- beta: no live pane$/m);
  assert.doesNotMatch(section.body, /beta-orch previous/);
});

test('the open items section lists the Mailbox items, the tasks with a Mailbox item, and the recent Owner decisions', () => {
  const section = openItemsSection({
    items: [{ id: 'm-1', title: 'Approve the release plan', needsAction: true }, { id: 'm-2', title: 'Night report', needsAction: false }],
    tasks: [{ id: 't-12', title: 'Merge the release', mailboxId: 'm-1' }, { id: 't-13', title: 'Ship the notes', mailboxId: null }],
    decisions: [{ date: '2026-10-04', text: 'Keep the K27 bootstrap cap.' }],
  });
  assert.match(section.body, /m-1 \[approve\]: Approve the release plan/);
  assert.match(section.body, /m-2 \[read\]: Night report/);
  assert.match(section.body, /t-12: Merge the release \(mailboxId m-1\)/);
  assert.doesNotMatch(section.body, /t-13/);
  assert.match(section.body, /2026-10-04: Keep the K27 bootstrap cap\./);
});

test('the open items section says what is empty and names no private memory source', () => {
  const section = openItemsSection({ items: [], tasks: [], decisions: [], decisionsOmitted: 'The Boss memory file is private. A Boss handover generates no Owner decisions.' });
  assert.match(section.body, /Mailbox items that are open \(0\): none\./);
  assert.match(section.body, /Tasks with a Mailbox item \(0\): none\./);
  assert.match(section.body, /The Boss memory file is private/);
  assert.doesNotMatch(section.text, /boss-memory/);
});

test('the Owner decisions of the memory file are the dated lines of the last 48 hours', () => {
  const memory = [
    '# Memory', '',
    '- 2026-10-05: A decision today.',
    '- 2026-10-03: A decision three days old.',
    '- K27 released 2026-10-05: a release line without a leading date.',
    'Some prose without a date.',
  ].join('\n');
  const now = Date.parse('2026-10-05T12:00:00.000Z');
  const decisions = ownerDecisionsFrom(memory, { now });
  assert.deepEqual(decisions, [{ date: '2026-10-05', text: 'A decision today.' }]);
  assert.deepEqual(ownerDecisionsFrom('- 2026-10-06: A future decision.', { now }), [], 'a line in the future is not a decision of the last 48 hours');
  assert.deepEqual(ownerDecisionsFrom(null, { now }), []);
});

test('the bootstrap prompt text holds the three sections and drops an empty one', () => {
  const result = bootstrapSections({ bossRules: 'Only read and report.', agents: [], projects: [], items: [], tasks: [], decisions: [] });
  assert.deepEqual(result.sections.map((section) => section.title), ['Boss rules', 'Pane map', 'Open items']);
  assert.match(result.text, /Boss rules:\nOnly read and report\.\nEnd Boss rules\./);
  const thin = bootstrapSections({ bossRules: '   ', agents: [], projects: [], items: [], tasks: [], decisions: [] });
  assert.deepEqual(thin.sections.map((section) => section.title), ['Pane map', 'Open items']);
  assert.doesNotMatch(thin.text, /Boss rules/);
});

const AGENTS = [{ name: 'boss', pane_id: 'w1:p2' }, { name: 'project-orch', pane_id: 'w1:p9' }];

function seed(f, { memory = null, items = [], tasks = [], policy = {} } = {}) {
  fs.writeFileSync(path.join(f.root, 'policy.json'), JSON.stringify({ projects: {}, ...policy }));
  fs.mkdirSync(path.join(f.root, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'projects', 'project.json'), JSON.stringify({ project: 'project', tasks, updated: '2026-10-05T09:00:00.000Z' }));
  if (items.length) fs.writeFileSync(path.join(f.root, 'messages.jsonl'), `${items.map((item) => JSON.stringify(item)).join('\n')}\n`);
  if (memory) {
    fs.mkdirSync(path.join(f.project, 'docs', 'orchestration'), { recursive: true });
    fs.writeFileSync(path.join(f.project, 'docs', 'orchestration', 'memory.md'), memory);
  }
  return f;
}

const ITEM = (id, text, action, extra = {}) => ({ id, at: '2026-10-05T09:00:00.000Z', thread: 'project', from: 'orch', to: 'owner', kind: 'report', text, action, status: 'delivered', ...extra });

test('a prepared successor prompt carries the three generated sections beside the capped three-source read', (t) => {
  const f = handoffFixture(t, { agents: AGENTS });
  seed(f, {
    memory: ['# Memory', '- 2026-10-05: Keep the bootstrap cap.'].join('\n'),
    items: [ITEM('m-1', 'Approve the release plan', 'approve'), ITEM('m-2', 'Night report', 'read')],
    tasks: [{ id: 't-12', title: 'Merge the release', status: 'doing', mailboxId: 'm-1', waitingOn: 'owner', ask: 'Approve the release plan.' }],
  });
  runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'fresh'], f.env);
  const [prompt] = handoffPromptCalls(f.root);
  assert.match(prompt, /Read only these three sources/);
  assert.match(prompt, /Boss rules:\n/);
  assert.match(prompt, /Pane map:\n- Boss: w1:p2\n- project: w1:p9\nEnd Pane map\./);
  assert.match(prompt, /Open items:\n/);
  assert.match(prompt, /m-1 \[approve\]: Approve the release plan/);
  assert.match(prompt, /m-2 \[read\]: Night report/);
  assert.match(prompt, /t-12: Merge the release \(mailboxId m-1\)/);
  assert.match(prompt, /2026-10-05: Keep the bootstrap cap\./);
  assert.match(prompt, /End Boss rules\.[\s\S]*End Open items\./);
});

test('a Boss handover generates no Owner decisions and reads no private memory file', (t) => {
  const f = handoffFixture(t, { agents: AGENTS, sourceLabel: 'boss' });
  seed(f);
  fs.writeFileSync(path.join(f.root, 'policy.json'), JSON.stringify({ projects: {} }));
  fs.mkdirSync(path.join(f.root, '.herdr-boss'), { recursive: true });
  fs.writeFileSync(path.join(f.root, '.herdr-boss', 'boss-memory.md'), '- 2026-10-05: Private Boss decision that must not reach a prompt.');
  runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'fresh'], f.env);
  const [prompt] = handoffPromptCalls(f.root);
  assert.match(prompt, /Pane map:\n- Boss: w1:p2\n- project: w1:p9\nEnd Pane map\./);
  assert.doesNotMatch(prompt, /Private Boss decision/);
  assert.match(prompt, /A Boss handover generates no Owner decisions\./);
});