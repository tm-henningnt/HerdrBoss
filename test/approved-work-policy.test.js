import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkKitText, installKit, projectKit } from '../src/kit/agents-check.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('the kit, orchestrator skill, user guide, and CLI describe the Owner approval rule', () => {
  const kit = projectKit().body;
  const skill = read('kit/skills/herdr-orchestrator/SKILL.md');
  const reference = read('kit/skills/herdr-orchestrator/reference/approval-policy.md');

  const phrases = [
    'An orchestrator may propose work. It starts no unapproved work.',
    'a backlog task',
    'an Owner goal',
    'a fix for a finding of approved work',
    'a defect fix',
    'a survey, review, or audit that is itself new work',
    'a refactor',
    'a new feature',
    'a new test program',
    'a release outside an Owner request',
    'one To do decide item',
    'what, why, cost, and recommendation',
    "The Boss's yes does not replace the Owner's yes.",
  ];
  for (const phrase of phrases) {
    assert.ok(kit.includes(phrase), `kit is missing approval rule text: ${phrase}`);
    assert.ok(reference.includes(phrase), `skill reference is missing approval rule text: ${phrase}`);
  }

  assert.match(skill, /reference\/approval-policy\.md/);
  assert.ok(skill.trim().split(/\s+/).length <= 3120, 'the orchestrator skill must stay within its word limit');

  const userGuide = read('docs/user-guide.md');
  const cli = read('docs/cli.md');
  for (const phrase of phrases.slice(1, 12)) {
    assert.ok(userGuide.includes(phrase), `user guide is missing approval text: ${phrase}`);
    assert.ok(cli.includes(phrase), `CLI reference is missing approval text: ${phrase}`);
  }
  assert.ok(userGuide.includes(phrases.at(-1)));
  assert.ok(cli.includes(phrases.at(-1)));
  assert.match(cli, /--action decide/);
  assert.ok(cli.includes('## Choices\n- Accept\n- Deny'), 'the proposal command must show Accept and Deny choices');
});

test('the kit check warns when an installed project kit lacks the approval rule', () => {
  const current = projectKit();
  const installed = current.text.replace(/^- An orchestrator may propose work\. It starts no unapproved work\.$/m, '');
  const finding = checkKitText(installed, current.revision).find((entry) => /approval rule/.test(entry.message));

  assert.ok(finding, 'expected a finding for the missing approval rule');
  assert.equal(finding.level, 'warn');
  assert.match(finding.message, /run herdr-boss kit install/);
});

test('the generated kit keeps general rules before the work approval section', () => {
  const body = projectKit().body;
  const approval = body.indexOf('## Work approval');
  const generalRule = body.indexOf('- Use the Herdr Boss orchestrator skill');
  const lastGeneralRule = body.indexOf('- Stop only processes that you or your workers started');

  assert.ok(generalRule >= 0 && generalRule < approval, 'general rules must precede the work approval section');
  assert.ok(lastGeneralRule >= 0 && lastGeneralRule < approval, 'the full intro rules must precede the work approval section');
  assert.match(body.slice(approval), /^## Work approval/m);
});

test('kit install generates a readable herdr-boss.md with the approval section after the general rules', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-generated-kit-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  installKit(root, { hook: false });
  const generated = fs.readFileSync(path.join(root, 'docs', 'orchestration', 'herdr-boss.md'), 'utf8');
  const approval = generated.indexOf('## Work approval');
  const generalRule = generated.indexOf('- Use the Herdr Boss orchestrator skill');
  const lastGeneralRule = generated.indexOf('- Stop only processes that you or your workers started');

  assert.ok(generalRule >= 0 && generalRule < approval);
  assert.ok(lastGeneralRule >= 0 && lastGeneralRule < approval);
  assert.match(generated.slice(approval), /herdr-boss proposal check FILE/);
  assert.match(generated.slice(approval), /card type: decide/);
});

test('subagent reads and surveys inside approved work do not require a separate approval', () => {
  const kit = projectKit().body;
  const stub = read('kit/templates/agents-stub.md');
  const reference = read('kit/skills/herdr-orchestrator/reference/approval-policy.md');
  for (const [name, text] of [['kit', kit], ['stub', stub], ['approval reference', reference]]) {
    assert.match(text, /subagents?[^\n]*(inside approved work|within approved work)/i, `${name} must allow surveys inside approved work`);
    assert.match(text, /survey, review, or audit[^\n]*(new work|itself new work)/i, `${name} must require approval when the survey itself is new work`);
  }
});

test('proposal instructions give the Boss handoff flow and file headings', () => {
  const kit = projectKit().body;
  const reference = read('kit/skills/herdr-orchestrator/reference/approval-policy.md');
  const cli = read('docs/cli.md');
  for (const [name, text] of [['kit', kit], ['approval reference', reference], ['CLI docs', cli]]) {
    assert.match(text, /herdr-boss proposal check FILE/, `${name} must name the validator command`);
    assert.match(text, /herdr-boss tell boss[^\n]*proposal file[^\n]*card type: decide/i, `${name} must send the path and card type to the Boss`);
    for (const heading of ['## What', '## Why', '## Cost', '## Recommendation', '## Choices']) {
      assert.ok(text.includes(heading), `${name} must include ${heading}`);
    }
    assert.match(text, /Lane:/);
    assert.match(text, /Size:/);
    assert.match(text, /- Accept\s+- Deny/);
  }
  const proposalCommands = cli.match(/```sh\n([\s\S]*?)\n```/)?.[1] ?? '';
  assert.doesNotMatch(proposalCommands, /mail post/);
});
