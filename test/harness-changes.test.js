import './helpers/test-env.js';
// The harness change markers: the reader of harness-changes.jsonl, the append helper, and the `harness change` command.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readHarnessChanges, appendHarnessChange, assertHarnessChangeCaller, HARNESS_CHANGES_FILE, MAX_CHANGE_LINES, MAX_CHANGE_BYTES } from '../src/harness-changes.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-changes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const line = (o) => JSON.stringify(o);
const write = (dir, text) => fs.writeFileSync(path.join(dir, HARNESS_CHANGES_FILE), text);

test('the reader returns a valid entry with date, harness, and label', (t) => {
  const dir = tmp(t);
  write(dir, `${line({ date: '2026-01-05', harness: 'codex', label: 'Test rule added' })}\n`);
  assert.deepEqual(readHarnessChanges(dir), [{ date: '2026-01-05', harness: 'codex', label: 'Test rule added' }]);
});

test('the reader returns an empty list for a missing file and never throws', (t) => {
  const dir = tmp(t);
  assert.deepEqual(readHarnessChanges(dir), []);
  assert.deepEqual(readHarnessChanges(path.join(dir, 'no', 'such', 'dir')), []);
  fs.mkdirSync(path.join(dir, HARNESS_CHANGES_FILE));
  assert.deepEqual(readHarnessChanges(dir), []);
});

test('the reader skips a broken line and a line with a bad field', (t) => {
  const dir = tmp(t);
  write(dir, [
    'not json',
    line({ date: '2026-01-05', harness: 'codex', label: 'ok one' }),
    '[1,2]',
    'null',
    line({ date: '2026-13-05', harness: 'codex', label: 'bad month' }),
    line({ date: '2026-02-30', harness: 'codex', label: 'bad day' }),
    line({ date: '2026-1-5', harness: 'codex', label: 'bad format' }),
    line({ date: '2026-01-06', harness: 'gemini', label: 'bad harness' }),
    line({ date: '2026-01-06', harness: 'pi', label: '' }),
    line({ date: '2026-01-06', harness: 'pi', label: '   ' }),
    line({ date: '2026-01-06', harness: 'pi', label: 'x'.repeat(81) }),
    line({ date: '2026-01-06', harness: 'pi', label: 'tab\there' }),
    line({ date: '2026-01-06', harness: 'pi', label: 42 }),
    line({ date: 20260106, harness: 'pi', label: 'number date' }),
    '{"date":"2026-01-07","harness":"pi","label":"cut',
    line({ date: '2026-01-08', harness: 'opencode', label: 'ok two', extra: '/Users/x/secret' }),
  ].join('\n'));
  const rows = readHarnessChanges(dir);
  assert.deepEqual(rows, [
    { date: '2026-01-05', harness: 'codex', label: 'ok one' },
    { date: '2026-01-08', harness: 'opencode', label: 'ok two' },
  ]);
  assert.doesNotMatch(JSON.stringify(rows), /secret/);
});

test('the reader and the append helper reject bidi and zero-width format characters in a label', (t) => {
  const dir = tmp(t);
  const bad = ['\u200B', '\u200F', '\u202A', '\u202E', '\u2066', '\u2069', '\uFEFF'];
  write(dir, bad.map((c) => line({ date: '2026-01-05', harness: 'pi', label: `ab${c}cd` })).concat(bad.map((c) => line({ date: '2026-01-05', harness: 'pi', label: `${c}edge` }))).concat(line({ date: '2026-01-05', harness: 'pi', label: 'plain label' })).join('\n'));
  assert.deepEqual(readHarnessChanges(dir).map((r) => r.label), ['plain label']);
  for (const c of bad) assert.throws(() => appendHarnessChange(dir, { harness: 'pi', label: `ab${c}cd`, date: '2026-01-05' }), /label/, JSON.stringify(c));
  assert.throws(() => appendHarnessChange(dir, { harness: 'pi', label: `${'\uFEFF'}edge`, date: '2026-01-05' }), /label/);
});

test('the reader accepts a label of 80 characters and trims spaces', (t) => {
  const dir = tmp(t);
  write(dir, `${line({ date: '2026-01-05', harness: 'claude', label: `  ${'y'.repeat(80)}  ` })}\n`);
  assert.equal(readHarnessChanges(dir)[0].label, 'y'.repeat(80));
});

test('the reader keeps at most 200 lines, the newest', (t) => {
  const dir = tmp(t);
  const lines = [];
  for (let i = 0; i < MAX_CHANGE_LINES + 25; i += 1) lines.push(line({ date: '2026-01-05', harness: 'claude', label: `change ${i}` }));
  write(dir, `${lines.join('\n')}\n`);
  const rows = readHarnessChanges(dir);
  assert.equal(rows.length, MAX_CHANGE_LINES);
  assert.equal(rows[0].label, 'change 25');
  assert.equal(rows.at(-1).label, `change ${MAX_CHANGE_LINES + 24}`);
});

test('the reader reads at most 64 KB and skips the cut first line', (t) => {
  const dir = tmp(t);
  const filler = 'z'.repeat(70 * 1024);
  write(dir, `${filler}\n${line({ date: '2026-01-05', harness: 'claude', label: 'after the filler' })}\n`);
  assert.ok(fs.statSync(path.join(dir, HARNESS_CHANGES_FILE)).size > MAX_CHANGE_BYTES);
  assert.deepEqual(readHarnessChanges(dir), [{ date: '2026-01-05', harness: 'claude', label: 'after the filler' }]);
});

test('the reader sorts by date and keeps the file order for one date', (t) => {
  const dir = tmp(t);
  write(dir, [
    line({ date: '2026-01-09', harness: 'pi', label: 'late' }),
    line({ date: '2026-01-05', harness: 'codex', label: 'first' }),
    line({ date: '2026-01-05', harness: 'claude', label: 'second' }),
  ].join('\n'));
  assert.deepEqual(readHarnessChanges(dir).map((r) => r.label), ['first', 'second', 'late']);
});

test('appendHarnessChange writes one validated line and rejects bad input', (t) => {
  const dir = tmp(t);
  const entry = appendHarnessChange(dir, { harness: 'codex', label: '  Escalation rule added ', date: '2026-01-05' });
  assert.deepEqual(entry, { date: '2026-01-05', harness: 'codex', label: 'Escalation rule added' });
  appendHarnessChange(dir, { harness: 'pi', label: 'Guard fix', date: '2026-01-06' });
  const text = fs.readFileSync(path.join(dir, HARNESS_CHANGES_FILE), 'utf8');
  assert.equal(text.split('\n').filter(Boolean).length, 2);
  assert.ok(text.endsWith('\n'));
  assert.equal((fs.statSync(path.join(dir, HARNESS_CHANGES_FILE)).mode & 0o777), 0o600);
  assert.throws(() => appendHarnessChange(dir, { harness: 'gemini', label: 'x', date: '2026-01-05' }), /harness/);
  assert.throws(() => appendHarnessChange(dir, { harness: 'codex', label: '', date: '2026-01-05' }), /label/);
  assert.throws(() => appendHarnessChange(dir, { harness: 'codex', label: 'x'.repeat(81), date: '2026-01-05' }), /label/);
  assert.throws(() => appendHarnessChange(dir, { harness: 'codex', label: 'x', date: '2026-02-31' }), /date/);
  assert.equal(readHarnessChanges(dir).length, 2);
});

test('appendHarnessChange uses today as the default date', (t) => {
  const dir = tmp(t);
  const entry = appendHarnessChange(dir, { harness: 'claude', label: 'No date given' });
  assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/);
});

const plainEnv = (dir) => {
  const env = { ...process.env, HOME: dir, HERDR_BOSS_DIR: dir, TMPDIR: dir };
  for (const key of ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID']) delete env[key];
  return env;
};
const run = (dir, ...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: plainEnv(dir) });

test('the caller rule allows a plain terminal, the boss pane, and an orch pane, and refuses a worker pane', () => {
  const pane = (label) => () => ({ pane: { pane_id: 'wA:p1', workspace_id: 'wA', label } });
  const env = { HERDR_ENV: '1', HERDR_PANE_ID: 'wA:p1', HERDR_WORKSPACE_ID: 'wA' };
  assert.equal(assertHarnessChangeCaller({}, () => { throw new Error('no herdr call'); }), null);
  assert.equal(assertHarnessChangeCaller(env, pane('boss')).role, 'boss');
  assert.equal(assertHarnessChangeCaller(env, pane('orch')).role, 'orch');
  assert.throws(() => assertHarnessChangeCaller(env, pane('ad1')), /Only .*orch.*harness change/);
  assert.throws(() => assertHarnessChangeCaller(env, pane(undefined)), /harness change/);
  assert.throws(() => assertHarnessChangeCaller({ HERDR_ENV: '1' }, pane('boss')), /HERDR_PANE_ID/);
  assert.throws(() => assertHarnessChangeCaller({ ...env, HERDR_WORKSPACE_ID: 'wB' }, pane('boss')), /HERDR_WORKSPACE_ID/);
});

test('herdr-boss harness change in a Herdr pane without a verifiable pane exits 1 and writes nothing', (t) => {
  const dir = tmp(t);
  const result = spawnSync(process.execPath, [CLI, 'harness', 'change', 'codex', 'x'], { encoding: 'utf8', env: { ...plainEnv(dir), HERDR_ENV: '1' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HERDR_PANE_ID/);
  assert.equal(fs.existsSync(path.join(dir, HARNESS_CHANGES_FILE)), false);
});

test('herdr-boss harness change appends a line to the data dir', (t) => {
  const dir = tmp(t);
  const ok = run(dir, 'harness', 'change', 'codex', 'Escalation rule added', '--date', '2026-01-05');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /2026-01-05/);
  assert.deepEqual(readHarnessChanges(dir), [{ date: '2026-01-05', harness: 'codex', label: 'Escalation rule added' }]);
});

test('herdr-boss harness change joins several words and accepts --date first', (t) => {
  const dir = tmp(t);
  const ok = run(dir, 'harness', 'change', 'pi', '--date', '2026-01-06', 'Guard', 'fix');
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(readHarnessChanges(dir), [{ date: '2026-01-06', harness: 'pi', label: 'Guard fix' }]);
});

test('herdr-boss harness change exits 1 on a bad harness, label, or date and writes nothing', (t) => {
  const dir = tmp(t);
  for (const args of [
    ['harness', 'change', 'gemini', 'x'],
    ['harness', 'change', 'codex'],
    ['harness', 'change', 'codex', 'x'.repeat(81)],
    ['harness', 'change', 'codex', 'x', '--date', '2026-02-31'],
    ['harness', 'change', 'codex', 'x', '--date'],
  ]) {
    const result = run(dir, ...args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /harness change|harness|label|date/i);
  }
  assert.equal(fs.existsSync(path.join(dir, HARNESS_CHANGES_FILE)), false);
});

test('the reader also accepts the day and note spelling and cuts a long note', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-changes-alias-'));
  const long = 'n'.repeat(120);
  fs.writeFileSync(path.join(dir, HARNESS_CHANGES_FILE), [
    JSON.stringify({ day: '2026-03-01', harness: 'claude', note: 'rules added to the settings' }),
    JSON.stringify({ day: '2026-03-02', harness: 'codex', note: long }),
    JSON.stringify({ day: '2026-03-03', harness: 'pi', label: long }),
  ].join('\n') + '\n');
  const rows = readHarnessChanges(dir);
  assert.deepEqual(rows.map((r) => [r.date, r.harness]), [['2026-03-01', 'claude'], ['2026-03-02', 'codex']]);
  assert.equal(rows[1].label.length, 80);
});
