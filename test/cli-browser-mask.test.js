import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { formatBrowserJson, formatBrowserTabs } from '../src/cli.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function bookmarksCli(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-browser-mask-'));
  const dataDir = path.join(base, 'data');
  const home = path.join(base, 'home');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(dataDir, 'browser-sessions.json'), JSON.stringify({
    alpha: {
      project: 'alpha',
      bookmarks: [
        { name: 'Outside', url: 'https://acme.example.com/start?secret=yes#frag' },
        { name: 'Loopback', url: 'http://127.0.0.1:4477/local?debug=yes#here' },
      ],
      startPage: 'https://acme.example.com/home?secret=yes',
    },
  }));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return (args) => spawnSync(process.execPath, [CLI, 'browser', ...args], {
    cwd: base,
    env: { ...process.env, HOME: home, HERDR_BOSS_DIR: dataDir },
    encoding: 'utf8',
  });
}

test('browser JSON output masks outside URLs and keeps loopback URLs in full', () => {
  const value = {
    tabs: [
      { url: 'https://acme.example.com:8443/a?secret=yes#frag' },
      { url: 'http://127.0.0.1:4477/local?debug=yes#here' },
    ],
    bookmarks: [{ url: 'https://acme.example.com/start?secret=yes' }],
  };
  const output = JSON.parse(formatBrowserJson(value));

  assert.equal(output.tabs[0].url, 'https://<tenant>.example.com:8443/a');
  assert.equal(output.tabs[1].url, 'http://127.0.0.1:4477/local?debug=yes#here');
  assert.equal(output.bookmarks[0].url, 'https://<tenant>.example.com/start');
});

test('browser JSON output prints real URLs when full mode is enabled', () => {
  const value = { url: 'https://user:pass@acme.example.com:8443/a?secret=yes#frag' };
  assert.equal(JSON.parse(formatBrowserJson(value, { full: true })).url, value.url);
});

test('tabs --full keeps the legacy origin and path URL shape', () => {
  const tabs = [{
    id: 'tab-1',
    title: 'Example',
    url: 'https://acme.example.com:8443/a/b?secret=yes#frag',
    visibility: 'visible',
    attached: false,
  }];
  const output = JSON.parse(formatBrowserTabs(tabs, { full: true }));

  assert.equal(output[0].url, 'https://acme.example.com:8443/a/b');
});

test('CLI prints usage when it is started through a symlink to src/cli.js', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-cli-symlink-'));
  const dataDir = path.join(base, 'data');
  const home = path.join(base, 'home');
  const linkedCli = path.join(base, 'herdr-boss.mjs');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(home);
  fs.symlinkSync(CLI, linkedCli);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [linkedCli], {
    cwd: base,
    env: { ...process.env, HOME: home, HERDR_BOSS_DIR: dataDir },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /herdr-boss <command>/);
});

test('bookmarks list prints masked outside URLs and full loopback URLs', (t) => {
  const run = bookmarksCli(t);
  const result = run(['bookmarks', 'alpha', 'list']);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.bookmarks[0].url, 'https://<tenant>.example.com/start');
  assert.equal(output.bookmarks[1].url, 'http://127.0.0.1:4477/local?debug=yes#here');
  assert.equal(output.startPage, 'https://<tenant>.example.com/home');
});

test('bookmarks list accepts --full before or after its arguments', (t) => {
  const run = bookmarksCli(t);
  const before = run(['--full', 'bookmarks', 'alpha', 'list']);
  assert.equal(before.status, 0, before.stderr);
  assert.equal(JSON.parse(before.stdout).bookmarks[0].url, 'https://acme.example.com/start?secret=yes#frag');
  const after = run(['bookmarks', 'alpha', 'list', '--full']);
  assert.equal(after.status, 0, after.stderr);
  assert.equal(JSON.parse(after.stdout).startPage, 'https://acme.example.com/home?secret=yes');
});
