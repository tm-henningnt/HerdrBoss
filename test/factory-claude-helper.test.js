import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CLAUDE_STATUSLINE_COMMAND, applyClaudeHelper, claudeHelperEnabled } from '../src/factory-claude-helper.js';

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'factory-claude-helper-'));
const settingsFile = (dir) => path.join(dir, '.claude', 'settings.json');
const read = (dir) => JSON.parse(fs.readFileSync(settingsFile(dir), 'utf8'));
const ENTRY = { type: 'command', command: 'herdr-boss claude-statusline' };

// Slice 5: the settings entry of the factory user.

test('the entry runs only herdr-boss claude-statusline', () => {
  assert.equal(CLAUDE_STATUSLINE_COMMAND, 'herdr-boss claude-statusline');
});

test('a missing settings file gets the entry, with mode 0600 and no other key', () => {
  const dir = home();
  const result = applyClaudeHelper({ home: dir, enabled: true });
  assert.equal(result.state, 'installed');
  assert.deepEqual(read(dir), { statusLine: ENTRY });
  assert.equal(fs.statSync(settingsFile(dir)).mode & 0o777, 0o600);
});

test('the entry keeps every other key of the settings file', () => {
  const dir = home();
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(settingsFile(dir), JSON.stringify({ theme: 'dark', permissions: { allow: ['Bash(ls)'] } }));
  applyClaudeHelper({ home: dir, enabled: true });
  assert.deepEqual(read(dir), { theme: 'dark', permissions: { allow: ['Bash(ls)'] }, statusLine: ENTRY });
});

test('a second run changes nothing', () => {
  const dir = home();
  applyClaudeHelper({ home: dir, enabled: true });
  const before = fs.readFileSync(settingsFile(dir), 'utf8');
  assert.equal(applyClaudeHelper({ home: dir, enabled: true }).state, 'unchanged');
  assert.equal(fs.readFileSync(settingsFile(dir), 'utf8'), before);
});

test('an existing statusLine of the factory user is refused and stays as it is', () => {
  const dir = home();
  fs.mkdirSync(path.join(dir, '.claude'));
  const own = JSON.stringify({ statusLine: { type: 'command', command: 'my-own-line' } });
  fs.writeFileSync(settingsFile(dir), own);
  const result = applyClaudeHelper({ home: dir, enabled: true });
  assert.equal(result.state, 'refused');
  assert.match(result.message, /statusLine/);
  assert.match(result.message, /already/);
  assert.equal(fs.readFileSync(settingsFile(dir), 'utf8'), own);
});

test('a settings file that is not a JSON object is refused and stays as it is', () => {
  for (const text of ['{broken', '[]', '"x"']) {
    const dir = home();
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.writeFileSync(settingsFile(dir), text);
    assert.equal(applyClaudeHelper({ home: dir, enabled: true }).state, 'refused');
    assert.equal(fs.readFileSync(settingsFile(dir), 'utf8'), text);
  }
});

test('turning the helper off removes our entry only', () => {
  const dir = home();
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(settingsFile(dir), JSON.stringify({ theme: 'dark', statusLine: ENTRY }));
  assert.equal(applyClaudeHelper({ home: dir, enabled: false }).state, 'removed');
  assert.deepEqual(read(dir), { theme: 'dark' });
  const other = JSON.stringify({ statusLine: { type: 'command', command: 'my-own-line' } });
  fs.writeFileSync(settingsFile(dir), other);
  assert.equal(applyClaudeHelper({ home: dir, enabled: false }).state, 'unchanged');
  assert.equal(fs.readFileSync(settingsFile(dir), 'utf8'), other);
  const none = home();
  assert.equal(applyClaudeHelper({ home: none, enabled: false }).state, 'unchanged');
  assert.equal(fs.existsSync(settingsFile(none)), false);
});

test('the switch reads factories.claudeUsageHelper and defaults to on', () => {
  const data = home();
  assert.equal(claudeHelperEnabled(data), true);
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ factories: { claudeUsageHelper: false } }));
  assert.equal(claudeHelperEnabled(data), false);
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ factories: { claudeUsageHelper: 'no' } }));
  assert.equal(claudeHelperEnabled(data), true);
  fs.writeFileSync(path.join(data, 'config.json'), '{broken');
  assert.equal(claudeHelperEnabled(data), true);
});

test('the start script entry installs the helper under a temporary home and exits 0 on a refusal', () => {
  const dir = home();
  const script = new URL('../src/factory-claude-helper.js', import.meta.url).pathname;
  const run = () => spawnSync(process.execPath, [script], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir } });
  const first = run();
  assert.equal(first.status, 0);
  assert.deepEqual(read(dir), { statusLine: ENTRY });
  fs.writeFileSync(settingsFile(dir), JSON.stringify({ statusLine: { type: 'command', command: 'x' } }));
  const second = run();
  assert.equal(second.status, 0);
  assert.match(second.stdout, /statusLine/);
  assert.equal(fs.existsSync(path.join(dir, '.herdr-boss')), false);
});

// Slice 5: the image and the data volume.

const root = new URL('..', import.meta.url).pathname;
const initScript = fs.readFileSync(path.join(root, 'factory/rootfs/etc/cont-init.d/10-factory-home'), 'utf8');
const dockerfile = fs.readFileSync(path.join(root, 'factory/Dockerfile'), 'utf8');

test('the image start script adds the readings folder to the data volume and runs the helper as the factory user', () => {
  assert.match(initScript, /claude-rate-limits/);
  assert.match(initScript, /chown[^\n]*claude-rate-limits/);
  assert.match(initScript, /chmod 700[^\n]*claude-rate-limits/);
  assert.match(initScript, /s6-setuidgid factory env HOME="\$home" node \/opt\/herdr-boss-seed\/src\/factory-claude-helper\.js/);
});

test('the image start script and the Dockerfile never touch a Mac path or a login file', () => {
  for (const text of [initScript, dockerfile]) assert.equal(/\.credentials|\.claude\.json|auth\.json/.test(text), false);
  assert.match(dockerfile, /ln -s \/home\/factory\/herdr-boss\/bin\/herdr-boss \/usr\/local\/bin\/herdr-boss/);
});

// FQ2: the state word and the state of the usage helper.

import { claudeHelperWord, claudeHelperState } from '../src/factory-claude-helper.js';

const withConfig = (dir, config) => {
  fs.mkdirSync(path.join(dir, '.herdr-boss'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.herdr-boss', 'config.json'), JSON.stringify(config));
};
const reading = (dir, observedAt) => {
  const folder = path.join(dir, '.herdr-boss', 'claude-rate-limits');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 's1.json'), JSON.stringify({ observedAt, rate_limits: {} }));
};

test('the state word is installed, then unchanged on the second run', () => {
  const dir = home();
  assert.equal(claudeHelperWord({ home: dir }), 'installed');
  const before = fs.readFileSync(settingsFile(dir), 'utf8');
  assert.equal(claudeHelperWord({ home: dir }), 'unchanged');
  assert.equal(fs.readFileSync(settingsFile(dir), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.join(dir, '.claude')), ['settings.json']);
});

test('a foreign statusLine gives the word foreign and no backup and no change', () => {
  const dir = home();
  fs.mkdirSync(path.join(dir, '.claude'));
  const own = JSON.stringify({ statusLine: { type: 'command', command: 'my-own-line' } });
  fs.writeFileSync(settingsFile(dir), own);
  assert.equal(claudeHelperWord({ home: dir }), 'foreign');
  assert.equal(fs.readFileSync(settingsFile(dir), 'utf8'), own);
  assert.deepEqual(fs.readdirSync(path.join(dir, '.claude')), ['settings.json']);
});

test('an unreadable settings file gives the word unreadable', () => {
  const dir = home();
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(settingsFile(dir), '{broken');
  assert.equal(claudeHelperWord({ home: dir }), 'unreadable');
});

test('the setting off installs nothing and removes nothing foreign', () => {
  const dir = home();
  withConfig(dir, { factories: { claudeUsageHelper: false } });
  assert.equal(claudeHelperWord({ home: dir }), 'off');
  assert.equal(fs.existsSync(settingsFile(dir)), false);
  fs.mkdirSync(path.join(dir, '.claude'));
  const own = JSON.stringify({ statusLine: { type: 'command', command: 'my-own-line' } });
  fs.writeFileSync(settingsFile(dir), own);
  assert.equal(claudeHelperWord({ home: dir }), 'off');
  assert.equal(fs.readFileSync(settingsFile(dir), 'utf8'), own);
  fs.writeFileSync(settingsFile(dir), JSON.stringify({ statusLine: ENTRY }));
  assert.equal(claudeHelperWord({ home: dir }), 'removed');
});

test('the state has a fixed reason for each case that is not installed', () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  const dir = home();
  assert.deepEqual(claudeHelperState({ home: dir, now }), { state: 'not-installed', reason: 'no-reading' });
  withConfig(dir, { factories: { claudeUsageHelper: false } });
  assert.deepEqual(claudeHelperState({ home: dir, now }), { state: 'not-installed', reason: 'setting-off' });
  fs.rmSync(path.join(dir, '.herdr-boss'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(settingsFile(dir), JSON.stringify({ statusLine: { type: 'command', command: 'x' } }));
  assert.deepEqual(claudeHelperState({ home: dir, now }), { state: 'not-installed', reason: 'different-statusline' });
  fs.writeFileSync(settingsFile(dir), '{broken');
  assert.deepEqual(claudeHelperState({ home: dir, now }), { state: 'not-installed', reason: 'settings-unreadable' });
});

test('the state is installed with the age of the newest reading', () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  const dir = home();
  claudeHelperWord({ home: dir });
  assert.deepEqual(claudeHelperState({ home: dir, now }), { state: 'not-installed', reason: 'no-reading' });
  reading(dir, '2026-10-06T11:59:18Z');
  assert.deepEqual(claudeHelperState({ home: dir, now }), { state: 'installed', lastReadingSeconds: 42 });
});
