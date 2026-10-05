import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { KIT_FILE, KIT_RULES, checkKitText, projectKit } from '../src/kit/agents-check.js';

// The kit file text of a project with the current kit, then without one required rule line.
function kitText(without) {
  const kit = projectKit();
  const body = kit.body.split('\n').filter((line) => !without.some((rule) => line.includes(rule))).join('\n');
  return { text: `<!-- herdr-boss kit v=${kit.revision} -->\nHerdr Boss writes this file. Do not edit it. Run herdr-boss kit install to update it.\n\n${body}\n`, revision: kit.revision };
}

test('the current kit file passes the kit rule check', () => {
  const kit = projectKit();
  assert.deepEqual(checkKitText(kit.text, kit.revision), []);
});

test('a kit file without the license rule is told to update', () => {
  const kit = kitText(['A license is never inline.']);
  const findings = checkKitText(kit.text, kit.revision);
  const rule = findings.find((finding) => /license is never inline/.test(finding.message));
  assert.ok(rule, JSON.stringify(findings));
  assert.equal(rule.level, 'error');
  assert.match(rule.message, /run herdr-boss kit install/);
  assert.ok(rule.message.startsWith(KIT_FILE), rule.message);
});

test('every required kit rule names a message and a pattern', () => {
  assert.ok(KIT_RULES.length > 0);
  for (const rule of KIT_RULES) {
    assert.equal(typeof rule.id, 'string');
    assert.match(rule.message, /run herdr-boss kit install/);
    assert.ok(rule.pattern.test(projectKit().body), `${rule.id} is not in the kit template`);
  }
});

test('the kit file text that the generator makes holds the license rule', () => {
  assert.match(projectKit().body, /A license is never inline\./);
});