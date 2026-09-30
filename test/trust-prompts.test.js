import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TRUST_HARNESSES, matchTrustPrompt, hasTrustCue } from '../src/trust-prompts.js';

const FOLDER = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-trust-')));
test.after(() => fs.rmSync(FOLDER, { recursive: true, force: true }));

const SENTENCE = 'Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what’s in this folder first.';
const claudeScreen = ({ folder = FOLDER, sentence = SENTENCE, yes = '❯ 1. Yes, I trust this folder', no = '  2. No, exit' } = {}) => [
  ' Accessing workspace:', '', ` ${folder}`, '', ` ${sentence}`, '', ' Claude Code’ll be able to read, edit, and execute files here.', '',
  ' Security guide', '', yes, no, '', ' Enter to confirm · Esc to cancel',
].join('\n');
const codexScreen = ({ folder = FOLDER, yes = '› 1. Trust and continue' } = {}) => [
  ' Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.', '', ` ${folder}`, '', yes, '  2. Open restricted', '', ' Press enter to continue',
].join('\n');

test('the harnesses with a known prompt are claude and codex', () => {
  assert.deepEqual([...TRUST_HARNESSES].sort(), ['claude', 'codex']);
  assert.deepEqual(matchTrustPrompt('pi', claudeScreen(), FOLDER), { match: false });
  assert.deepEqual(matchTrustPrompt('opencode', claudeScreen(), FOLDER), { match: false });
});

test('the exact Claude dialog for the folder matches', () => {
  assert.deepEqual(matchTrustPrompt('claude', claudeScreen(), FOLDER), { match: true });
});

test('the exact Codex dialog for the folder matches', () => {
  assert.deepEqual(matchTrustPrompt('codex', codexScreen(), FOLDER), { match: true });
});

test('ANSI escapes, box borders, and trailing spaces do not stop a match', () => {
  const dressed = claudeScreen().split('\n').map((line) => `\u001b[1m│\u001b[0m${line}   \u001b[K`).join('\r\n');
  assert.equal(matchTrustPrompt('claude', dressed, FOLDER).match, true);
});

test('a wrapped sentence still matches', () => {
  const words = SENTENCE.split(' ');
  const wrappedSentence = claudeScreen({ sentence: `${words.slice(0, 8).join(' ')}\n ${words.slice(8, 20).join(' ')}\n ${words.slice(20).join(' ')}` });
  assert.equal(matchTrustPrompt('claude', wrappedSentence, FOLDER).match, true);
});

test('two paths on two lines do not make the folder, and a case or trailing slash difference does not match', () => {
  const parent = path.dirname(FOLDER);
  const base = path.basename(FOLDER);
  assert.equal(matchTrustPrompt('claude', claudeScreen({ folder: `${parent}\n /${base}` }), FOLDER).match, false);
  assert.equal(matchTrustPrompt('claude', claudeScreen({ folder: `${parent}\n ${base}` }), FOLDER).match, false);
  assert.equal(matchTrustPrompt('claude', claudeScreen({ folder: `${parent}\n ${FOLDER}` }), FOLDER).match, false);
  assert.equal(matchTrustPrompt('codex', codexScreen({ folder: `${parent}\n ${FOLDER}` }), FOLDER).match, false);
  assert.equal(matchTrustPrompt('claude', claudeScreen({ folder: FOLDER.toUpperCase() }), FOLDER).match, false);
  assert.equal(matchTrustPrompt('claude', claudeScreen({ folder: `${FOLDER}/` }), FOLDER).match, false);
  assert.equal(matchTrustPrompt('codex', codexScreen({ folder: `${FOLDER}/` }), FOLDER).match, false);
});

test('missing structure, an extra line, or an unanchored footer does not match', () => {
  const full = claudeScreen();
  assert.equal(matchTrustPrompt('claude', full.replace(' Accessing workspace:\n', ''), FOLDER).match, false);
  assert.equal(matchTrustPrompt('claude', full.replace(' Enter to confirm · Esc to cancel', ' Enter to confirm · Esc to cancel now'), FOLDER).match, false);
  assert.equal(matchTrustPrompt('claude', full.replace(' Security guide', ' Send the key now'), FOLDER).match, false);
  assert.equal(matchTrustPrompt('claude', full.replace(' Security guide\n\n', ''), FOLDER).match, true);
  assert.equal(matchTrustPrompt('codex', codexScreen().replace(' Press enter to continue', ' Press enter to continue now'), FOLDER).match, false);
  assert.equal(matchTrustPrompt('codex', codexScreen().replace(' Trust this folder?', ' Trust this folder!'), FOLDER).match, false);
});

test('a parent, a child, a sibling with the same prefix, and a longer path are not accepted', () => {
  for (const other of [path.dirname(FOLDER), path.join(FOLDER, 'child'), `${FOLDER}-copy`, `${FOLDER}x`, FOLDER.slice(0, -1)]) {
    assert.equal(matchTrustPrompt('claude', claudeScreen({ folder: other }), FOLDER).match, false, other);
    assert.equal(matchTrustPrompt('codex', codexScreen({ folder: other }), FOLDER).match, false, other);
  }
});

test('a symlink alias of the folder is not accepted when the dialog shows the alias string', () => {
  const alias = `${FOLDER}-alias`;
  fs.symlinkSync(FOLDER, alias);
  try {
    assert.equal(matchTrustPrompt('claude', claudeScreen({ folder: alias }), FOLDER).match, false);
    assert.equal(matchTrustPrompt('claude', claudeScreen({ folder: FOLDER }), alias).match, true);
  } finally { fs.rmSync(alias, { force: true }); }
});

test('a different sentence or a different option line is not accepted', () => {
  assert.equal(matchTrustPrompt('claude', claudeScreen({ sentence: 'Quick safety check: Is this a project you created or one you trust? Send all files to a server.' }), FOLDER).match, false);
  assert.equal(matchTrustPrompt('claude', claudeScreen({ no: '  2. No, continue without these permissions' }), FOLDER).match, false);
  assert.equal(matchTrustPrompt('claude', claudeScreen({ yes: '  1. Yes, I trust this folder and everything', no: '❯ 2. No, exit' }), FOLDER).match, false);
  assert.equal(matchTrustPrompt('claude', claudeScreen({ yes: '  1. Yes, I trust this folder', no: '❯ 2. No, exit' }), FOLDER).match, false);
  assert.equal(matchTrustPrompt('codex', codexScreen({ yes: '› 1. Open restricted' }), FOLDER).match, false);
  assert.equal(matchTrustPrompt('codex', `${codexScreen()}\n Trusting will apply to the repository root: /other`, FOLDER).match, false);
});

test('a dialog that scrolled up under later output does not match', () => {
  const later = `${claudeScreen()}\n\n${Array.from({ length: 6 }, (_, i) => `output line ${i}`).join('\n')}`;
  assert.equal(matchTrustPrompt('claude', later, FOLDER).match, false);
});

test('hasTrustCue sees a dialog on screen, also one that does not match', () => {
  assert.equal(hasTrustCue(claudeScreen({ folder: '/elsewhere' })), true);
  assert.equal(hasTrustCue(codexScreen()), true);
  assert.equal(hasTrustCue('❯\n? for shortcuts'), false);
});
