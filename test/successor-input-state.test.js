import './helpers/test-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeInputState } from '../src/goal-set.js';

// SYNTHETIC Claude screens. All words are invented.
const footer = ['➜  Project git:(main)  Sonnet 5.5 ctx:6%', '⏵⏵ auto mode on (shift+tab to cycle)'];
const screen = (...lines) => [...lines, ...footer].join('\n');
const longPrompt = Array.from({ length: 14 }, (_, i) => `  line ${i} of a bootstrap prompt that wraps at the pane width`);

test('claudeInputState: an empty prompt and a ghost suggestion are empty', () => {
  assert.equal(claudeInputState(screen('❯ ')), 'empty');
  assert.equal(claudeInputState(screen('❯\x1b[0m\x1b[2m wait for a report\x1b[0m')), 'empty');
});

test('claudeInputState: typed text on the marker line is typed', () => {
  assert.equal(claudeInputState(screen('❯ run the prepared handover')), 'typed');
});

test('claudeInputState: a wrapped prompt keeps the marker line and is typed', () => {
  assert.equal(claudeInputState(screen('❯ first line of a long prompt', ...longPrompt)), 'typed');
});

test('claudeInputState: a wrapped prompt taller than the pane has no marker line and is typed', () => {
  assert.equal(claudeInputState(screen(...longPrompt)), 'typed');
});

test('claudeInputState: a dim paste placeholder is typed text, not a ghost suggestion', () => {
  assert.equal(claudeInputState(screen('❯ \x1b[2m[Pasted text #1 +30 lines]\x1b[0m')), 'typed');
});

test('claudeInputState: a selection dialog, a blank pane, and a trust dialog have no input line', () => {
  assert.equal(claudeInputState(screen('Do you want to proceed?', '❯ 1. Yes', '  2. No', 'Esc to cancel')), 'none');
  assert.equal(claudeInputState(screen('Pick one', '  1. Yes', '  2. No', 'Enter to confirm')), 'none');
  assert.equal(claudeInputState(''), 'none');
  assert.equal(claudeInputState('Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit'), 'none');
});
