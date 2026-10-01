import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { formatBrowserJson, formatBrowserTabs } from '../src/cli.js';
import { browserNavigate } from '../src/browser-preview.js';

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
        { name: 'acme.example.com', url: 'https://acme.example.com/host' },
        { name: 'Team handbook', url: 'https://docs.example.org/' },
        { name: 'localhost', url: 'http://localhost:4477/' },
        { name: '127.0.0.1', url: 'http://127.0.0.1:4477/' },
        { name: '::1', url: 'http://[::1]:4477/' },
        { name: 'Open acme.example.com docs', url: 'https://acme.example.com/docs' },
        { name: '192.0.2.15', url: 'https://192.0.2.15/' },
      ],
      startPage: 'https://acme.example.com/home?secret=yes',
    },
  }));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, HERDR_BOSS_DIR: dataDir };
  for (const key of ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'HERDR_WORKTREE']) delete env[key];
  const run = (args) => spawnSync(process.execPath, [CLI, 'browser', ...args], { cwd: base, env, encoding: 'utf8' });
  return { run, dataDir };
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
  const { run } = bookmarksCli(t);
  const result = run(['bookmarks', 'alpha', 'list']);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.bookmarks[0].url, 'https://<tenant>.example.com/start');
  assert.equal(output.bookmarks[1].url, 'http://127.0.0.1:4477/local?debug=yes#here');
  assert.equal(output.startPage, 'https://<tenant>.example.com/home');
});

test('bookmarks list accepts --full before or after its arguments', (t) => {
  const { run } = bookmarksCli(t);
  const before = run(['--full', 'bookmarks', 'alpha', 'list']);
  assert.equal(before.status, 0, before.stderr);
  assert.equal(JSON.parse(before.stdout).bookmarks[0].url, 'https://acme.example.com/start?secret=yes#frag');
  assert.equal(JSON.parse(before.stdout).bookmarks[2].name, 'acme.example.com');
  const after = run(['bookmarks', 'alpha', 'list', '--full']);
  assert.equal(after.status, 0, after.stderr);
  assert.equal(JSON.parse(after.stdout).startPage, 'https://acme.example.com/home?secret=yes');
});

test('bookmark names mask non-loopback hosts and keep plain and loopback names', (t) => {
  const { run } = bookmarksCli(t);
  const result = run(['bookmarks', 'alpha', 'list']);
  assert.equal(result.status, 0, result.stderr);
  const names = JSON.parse(result.stdout).bookmarks.map((bookmark) => bookmark.name);

  assert.deepEqual(names, [
    'Outside',
    'Loopback',
    '<tenant>.example.com',
    'Team handbook',
    'localhost',
    '127.0.0.1',
    '::1',
    'Open <tenant>.example.com docs',
    '<ip>',
  ]);
});

test('bookmark names stay stored but are masked in add output', (t) => {
  const { run, dataDir } = bookmarksCli(t);
  const result = run(['bookmarks', 'alpha', 'add', 'new.example.net', 'https://new.example.net/docs']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).bookmarks.at(-1).name, '<tenant>.example.net');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'browser-sessions.json'), 'utf8')).alpha.bookmarks.at(-1).name, 'new.example.net');
});

test('bookmark names are masked in remove output', (t) => {
  const { run } = bookmarksCli(t);
  const result = run(['bookmarks', 'alpha', 'rm', '0']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).bookmarks[1].name, '<tenant>.example.com');
});

test('bookmark start output masks names in the returned bookmark list', (t) => {
  const { run } = bookmarksCli(t);
  const result = run(['bookmarks', 'alpha', 'start', 'https://start.example.com/']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).bookmarks[2].name, '<tenant>.example.com');
});

test('bookmark list --full prints names as stored', (t) => {
  const { run } = bookmarksCli(t);
  const result = run(['bookmarks', 'alpha', 'list', '--full']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).bookmarks[2].name, 'acme.example.com');
  assert.equal(JSON.parse(result.stdout).bookmarks[7].name, 'Open acme.example.com docs');
});

test('browser JSON formatter masks bookmark names in its output shape', () => {
  const output = JSON.parse(formatBrowserJson({ bookmark: { name: 'acme.example.com', url: 'https://acme.example.com/' } }));
  assert.equal(output.bookmark.name, '<tenant>.example.com');
});

test('bookmark open navigation result uses the shared URL masker', async () => {
  const result = await browserNavigate('alpha', null, 'https://acme.example.com/host', {
    verifySession: async () => ({ port: 9223 }),
    listTargets: async () => [{
      id: 'page-1', url: 'about:blank',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/page-1',
    }],
    listViewports: () => ({}),
    commands: async () => [{ result: {} }],
  });
  const output = JSON.parse(formatBrowserJson(result));
  assert.equal(output.url, 'https://<tenant>.example.com/host');
});
