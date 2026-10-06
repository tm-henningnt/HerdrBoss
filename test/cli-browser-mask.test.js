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
import { maskBrowserText, redactBrowserSecrets } from '../src/browser-url-mask.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('hostile browser strings finish filtering in under 200 ms in both output modes', (t) => {
  const masker = new URL('../src/browser-url-mask.js', import.meta.url).href;
  const script = `
    import { performance } from 'node:perf_hooks';
    import { redactBrowserSecrets, maskBrowserText } from ${JSON.stringify(masker)};
    import { formatBrowserJson } from ${JSON.stringify(new URL('../src/cli.js', import.meta.url).href)};
    const timings = [];
    for (const input of ['a'.repeat(50000) + '.' + 'b'.repeat(50000), 'a.'.repeat(30000), 'a'.repeat(50000)]) {
      for (const full of [false, true]) {
        for (const [name, filter] of [
          ['redactor', () => redactBrowserSecrets(input)],
          ['text', () => maskBrowserText(input, { full, maskHosts: true })],
          ['json', () => JSON.parse(formatBrowserJson({ title: input, error: input }, { full }))],
        ]) {
          const start = performance.now();
          filter();
          timings.push({ name, full, length: input.length, ms: performance.now() - start });
        }
      }
    }
    process.stdout.write(JSON.stringify(timings));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 2000 });
  assert.equal(result.error, undefined, 'Hostile input exceeded the isolated two-second guard');
  assert.equal(result.status, 0, result.stderr);
  const timings = JSON.parse(result.stdout);
  for (const { name, full, length, ms } of timings) assert.ok(ms < 200, `${name} full=${full} length=${length} took ${ms.toFixed(1)} ms`);
  const slowest = timings.reduce((max, timing) => timing.ms > max.ms ? timing : max);
  t.diagnostic(`Hostile-input maximum: ${slowest.ms.toFixed(1)} ms across ${timings.length} checks (${slowest.name}, full=${slowest.full}, length=${slowest.length})`);
});

test('browser text and JSON redact encoded and colon delimiters after compound key suffixes', () => {
  const keys = ['code', 'state', 'session_state', 'access_token', 'id_token', 'refresh_token', 'token', 'key'];
  for (const full of [false, true]) {
    for (const key of keys) {
      for (const prefix of ['', 'api_', 'my_']) {
        for (const delimiter of ['=', '%3D', '%3d', ':', ': ']) {
          for (const name of [`${prefix}${key}`, `${prefix}${key}`.toUpperCase()]) {
            const input = `${name}${delimiter}abc123`;
            const expected = `${name}${delimiter.startsWith('%') ? '=' : delimiter}<redacted>`;
            assert.equal(maskBrowserText(input, { full, maskHosts: true }), expected);
            const body = JSON.parse(formatBrowserJson({ title: input, error: input, bookmark: { name: input, url: 'about:blank' } }, { full }));
            assert.deepEqual([body.title, body.error, body.bookmark.name], [expected, expected, expected]);
            assert.ok(!formatBrowserTabs([{ id: 'tab-1', title: input, url: 'about:blank' }], { full }).includes('abc123'));
          }
        }
      }
    }
    for (const input of ['code%3Dabc123', 'access_token%3Dabc', 'code: abc123', 'token:abc', 'api_key=abc', 'my_token=abc']) {
      for (const output of [maskBrowserText(input, { full }), formatBrowserJson({ title: input }, { full })]) assert.ok(!output.includes('abc'), 'Output disclosed an invented value');
    }
    const body = JSON.parse(formatBrowserJson({ api_key: 'abc', my_token: 'abc' }, { full }));
    assert.deepEqual(body, { api_key: '<redacted>', my_token: '<redacted>' });
  }
});

test('browser text decodes each title once and retains JSON escaping', () => {
  for (const full of [false, true]) {
    const input = 'Login%20https%3A%2F%2Ftenant1.example.test%2Fcallback%3Fcode%3Dabc123%26state%3Dabc';
    const host = full ? 'tenant1.example.test' : '<tenant>.example.test';
    assert.equal(maskBrowserText(input, { full, maskHosts: true }), `Login https://${host}/callback`);
    assert.equal(JSON.parse(formatBrowserJson({ title: 'Quoted%20%22code%3Dabc123%22' }, { full })).title, 'Quoted "code=<redacted>"');
  }
});

test('browser text and JSON redact bearer values after tabs and non-breaking spaces', () => {
  for (const full of [false, true]) {
    for (const whitespace of ['\t', '\u00a0', '%09', '%C2%A0']) {
      const input = `bEaReR${whitespace}abc123`;
      const text = maskBrowserText(input, { full, maskHosts: true });
      assert.ok(!text.includes('abc123'));
      assert.match(text, /bEaReR\s+<redacted>/);
      const body = JSON.parse(formatBrowserJson({ title: input, error: input }, { full }));
      assert.equal(body.title, text);
      assert.equal(body.error, text);
    }
  }
});

test('browser JWT redaction includes padding in text and JSON in both host modes', () => {
  for (const full of [false, true]) {
    for (const jwt of ['eyJfake.eyJfake.fakesig==', 'eyJfake==.eyJfake==.fakesig==', 'ewoJImFsZyI6IkhTMjU2In0.eyJfake.fakesig==']) {
      assert.equal(redactBrowserSecrets(`JWT ${jwt} end`), 'JWT <redacted> end');
      const text = maskBrowserText(`JWT ${jwt} end`, { full, maskHosts: true });
      assert.equal(text, 'JWT <redacted> end');
      const body = JSON.parse(formatBrowserJson({ title: `JWT ${jwt} end`, error: `JWT ${jwt} end` }, { full }));
      assert.deepEqual(body, { title: 'JWT <redacted> end', error: 'JWT <redacted> end' });
    }
  }
});

test('browser output strips callback secrets from titles and URLs in both host modes', () => {
  const callback = 'https://tenant1.example.test/login/callback?code=AAAAfakecode&state=eyJfake.eyJfake.fakesig&session_state=AAAAfakesession#access_token=AAAAfakeaccess';
  for (const full of [false, true]) {
    const output = formatBrowserTabs([{ id: 'tab-1', title: `Login ${callback}`, url: callback }], { full });
    for (const secret of ['AAAAfakecode', 'eyJfake.eyJfake.fakesig', 'AAAAfakesession', 'AAAAfakeaccess']) {
      assert.ok(!output.includes(secret), `Browser output disclosed fake secret in full=${full}`);
    }
    const tab = JSON.parse(output)[0];
    const host = full ? 'tenant1.example.test' : '<tenant>.example.test';
    assert.equal(tab.url, `https://${host}/login/callback`);
    assert.equal(tab.title, `Login https://${host}/login/callback`);
  }
});

test('browser text and JSON remove token assignments, bearer values, and standalone JWTs', async () => {
  const { maskBrowserText } = await import('../src/browser-url-mask.js');
  const fields = ['code', 'state', 'session_state', 'access_token', 'id_token', 'refresh_token', 'token', 'key'];
  const message = `${fields.map((field, index) => `${field}=AAAAfake${index}`).join(' ')} Bearer xyz eyJfake.eyJfake.fakesig`;
  for (const full of [false, true]) {
    for (const output of [maskBrowserText(message, { full }), formatBrowserJson({ title: message, error: message, bookmark: { name: message, url: 'http://localhost/callback?code=AAAAfakecode#state=AAAAfakestate' } }, { full })]) {
      for (const secret of [...fields.map((_, index) => `AAAAfake${index}`), 'xyz', 'eyJfake', 'fakesig', 'AAAAfakecode', 'AAAAfakestate']) {
        assert.ok(!output.includes(secret), `Browser output disclosed fake secret in full=${full}`);
      }
      assert.match(output, /Bearer <redacted>/);
    }
  }
});

test('browser errors that start with URLs and JWTs with JSON whitespace cannot bypass the filter', () => {
  const jwt = 'ewoJImFsZyI6IkhTMjU2In0.eyJfake.fakesig';
  for (const full of [false, true]) {
    const output = formatBrowserJson({ error: `https://tenant1.example.test/callback Bearer xyz ${jwt}`, title: jwt }, { full });
    for (const secret of ['xyz', 'ewoJImFsZyI6IkhTMjU2In0', 'eyJfake', 'fakesig']) assert.ok(!output.includes(secret), 'Final filter disclosed a fake secret');
    assert.doesNotThrow(() => JSON.parse(output));
  }
});

test('callback query and fragment values never appear in JSON for outside or loopback hosts', () => {
  for (const full of [false, true]) {
    for (const origin of ['https://tenant1.example.test', 'http://127.0.0.1:4477', 'http://localhost:4477', 'http://[::1]:4477']) {
      for (const separator of ['?', '#']) {
        const url = `${origin}/login/callback${separator}code=AAAAfakecode&state=eyJfake.eyJfake.fakesig&session_state=AAAAfakesession`;
        const output = formatBrowserJson({ title: `Login ${url}`, url, pageUrl: url, targetUrl: url, startPage: url, token: 'AAAAfaketoken', nested: { access_token: 'AAAAfakeaccess' } }, { full });
        for (const secret of ['AAAAfakecode', 'eyJfake', 'AAAAfakesession', 'AAAAfaketoken', 'AAAAfakeaccess']) assert.ok(!output.includes(secret), 'Callback JSON disclosed a fake secret');
        const body = JSON.parse(output);
        const host = full || origin.startsWith('http:') ? origin : 'https://<tenant>.example.test';
        assert.equal(body.url, `${host}/login/callback`);
        assert.equal(body.title, `Login ${host}/login/callback`);
      }
    }
  }
});

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
  const run = (args, extra = {}) => spawnSync(process.execPath, [CLI, 'browser', ...args], { cwd: base, env: { ...env, ...extra }, encoding: 'utf8' });
  return { run, dataDir };
}

test('browser CLI decodes bookmark names once before JSON serialization', (t) => {
  const { run, dataDir } = bookmarksCli(t);
  const file = path.join(dataDir, 'browser-sessions.json');
  const sessions = JSON.parse(fs.readFileSync(file, 'utf8'));
  sessions.alpha.bookmarks = [{ name: 'Keep%2522literal%20code%3Dabc123', url: 'about:blank' }];
  fs.writeFileSync(file, JSON.stringify(sessions));
  for (const full of [false, true]) {
    const result = run(['bookmarks', 'alpha', 'list', ...(full ? ['--full'] : [])]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes('abc123'));
    assert.equal(JSON.parse(result.stdout).bookmarks[0].name, 'Keep%22literal code=<redacted>');
  }
});

test('browser size output use the same final filter as bookmarks', (t) => {
  const { run, dataDir } = bookmarksCli(t);
  const file = path.join(dataDir, 'browser-sessions.json');
  const sessions = JSON.parse(fs.readFileSync(file, 'utf8'));
  sessions.alpha.bookmarks = [{ name: 'token=AAAAfakebookmark Bearer xyz', url: 'https://tenant1.example.test/callback?code=AAAAfakecode#session_state=AAAAfakesession' }];
  sessions.alpha.startPage = 'http://localhost/callback#state=eyJfake.eyJfake.fakesig';
  fs.writeFileSync(file, JSON.stringify(sessions));
  for (const args of [['size', 'alpha', '1280', '800'], ['bookmarks', 'alpha', 'list'], ['bookmarks', 'alpha', 'list', '--full']]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    for (const secret of ['AAAAfakebookmark', 'xyz', 'AAAAfakecode', 'AAAAfakesession', 'eyJfake']) {
      assert.ok(!`${result.stdout}${result.stderr}`.includes(secret), `CLI disclosed fake secret in ${args[0]}`);
    }
    assert.doesNotThrow(() => JSON.parse(result.stdout));
  }
});

test('browser JSON output masks outside hosts and keeps loopback hosts', () => {
  const value = {
    tabs: [
      { url: 'https://acme.example.com:8443/a?secret=yes#frag' },
      { url: 'http://127.0.0.1:4477/local?debug=yes#here' },
    ],
    bookmarks: [{ url: 'https://acme.example.com/start?secret=yes' }],
  };
  const output = JSON.parse(formatBrowserJson(value));

  assert.equal(output.tabs[0].url, 'https://<tenant>.example.com:8443/a');
  assert.equal(output.tabs[1].url, 'http://127.0.0.1:4477/local');
  assert.equal(output.bookmarks[0].url, 'https://<tenant>.example.com/start');
});

test('browser JSON full mode exposes only hosts and paths', () => {
  const value = { url: 'https://user:pass@acme.example.com:8443/a?secret=yes#frag' };
  assert.equal(JSON.parse(formatBrowserJson(value, { full: true })).url, 'https://acme.example.com:8443/a');
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

test('bookmarks list prints masked outside hosts and loopback hosts', (t) => {
  const { run } = bookmarksCli(t);
  const result = run(['bookmarks', 'alpha', 'list']);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.bookmarks[0].url, 'https://<tenant>.example.com/start');
  assert.equal(output.bookmarks[1].url, 'http://127.0.0.1:4477/local');
  assert.equal(output.startPage, 'https://<tenant>.example.com/home');
});

test('bookmarks list accepts --full before or after its arguments', (t) => {
  const { run } = bookmarksCli(t);
  const before = run(['--full', 'bookmarks', 'alpha', 'list']);
  assert.equal(before.status, 0, before.stderr);
  assert.equal(JSON.parse(before.stdout).bookmarks[0].url, 'https://acme.example.com/start');
  assert.equal(JSON.parse(before.stdout).bookmarks[2].name, 'acme.example.com');
  const after = run(['bookmarks', 'alpha', 'list', '--full']);
  assert.equal(after.status, 0, after.stderr);
  assert.equal(JSON.parse(after.stdout).startPage, 'https://acme.example.com/home');
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

test('bookmarks add refuses a URL whose host holds a scheme and prints no URL', (t) => {
  const { run, dataDir } = bookmarksCli(t);
  for (const url of ['https://https://tenant1.example.test/x', 'http:https://tenant1.example.test/x']) {
    const result = run(['bookmarks', 'alpha', 'add', 'Bad', url]);
    assert.notEqual(result.status, 0);
    assert.ok(!`${result.stdout}${result.stderr}`.includes('tenant1'));
    assert.match(result.stderr, /scheme/i);
  }
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'browser-sessions.json'), 'utf8')).alpha.bookmarks;
  assert.ok(!stored.some((b) => b.name === 'Bad'));
});

test('bookmarks list prints only names and indexes to a worker', (t) => {
  const { run } = bookmarksCli(t);
  const result = run(['bookmarks', 'alpha', 'list'], { HERDR_ENV: '1', HERDR_PANE_ID: 'p1', HERDR_WORKSPACE_ID: 'w1' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(output.bookmarks[0]).sort(), ['index', 'name']);
  assert.equal(output.bookmarks[0].index, 0);
  assert.ok(!result.stdout.includes('docs.example.org'));
  assert.ok(!('startPage' in output));
});

test('bookmarks list keeps the full list for the Owner', (t) => {
  const { run } = bookmarksCli(t);
  assert.equal(JSON.parse(run(['bookmarks', 'alpha', 'list']).stdout).bookmarks[3].url, 'https://<tenant>.example.org/');
});

const WORKER_ENVS = {
  'all pane variables': { HERDR_ENV: '1', HERDR_PANE_ID: 'p1', HERDR_WORKSPACE_ID: 'w1' },
  'only HERDR_WORKTREE': { HERDR_WORKTREE: '/tmp/worktree-x' },
};

test('a worker with only HERDR_WORKTREE gets names and indexes, also with --full', (t) => {
  const { run } = bookmarksCli(t);
  for (const [label, extra] of Object.entries(WORKER_ENVS)) {
    for (const flags of [[], ['--full']]) {
      const result = run(['bookmarks', 'alpha', 'list', ...flags], extra);
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.deepEqual(Object.keys(output), ['bookmarks'], label);
      assert.deepEqual(Object.keys(output.bookmarks[0]).sort(), ['index', 'name'], label);
      assert.ok(!result.stdout.includes('acme.example.com/start'), label);
      assert.ok(!result.stdout.includes('docs.example.org'), label);
      assert.ok(!result.stdout.includes('"url"'), label);
    }
  }
});

test('a worker with --full never sees a host from a bookmark name', (t) => {
  const { run } = bookmarksCli(t);
  const result = run(['bookmarks', 'alpha', 'list', '--full'], WORKER_ENVS['only HERDR_WORKTREE']);
  assert.ok(!result.stdout.includes('acme.example.com'), result.stdout);
});

test('bookmarks add refuses a backslash, whitespace, control character, or scheme word as host', (t) => {
  const { run, dataDir } = bookmarksCli(t);
  for (const url of [
    'https:\\https://tenant9.example.test',
    'https://\nhttps://tenant9.example.test',
    'https:\\\\tenant9.example.test',
    'https:/ /tenant9.example.test',
    'https://https:8080/tenant9.example.test',
  ]) {
    const result = run(['bookmarks', 'alpha', 'add', 'Bad', url]);
    assert.notEqual(result.status, 0, JSON.stringify(url));
    assert.ok(!`${result.stdout}${result.stderr}`.includes('tenant9'), JSON.stringify(url));
  }
  const start = run(['bookmarks', 'alpha', 'start', 'https:\\https://tenant9.example.test']);
  assert.notEqual(start.status, 0);
  assert.ok(!`${start.stdout}${start.stderr}`.includes('tenant9'));
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'browser-sessions.json'), 'utf8')).alpha;
  assert.ok(!JSON.stringify(stored).includes('tenant9'));
});

test('a worker gets names and indexes only from add, rm, and start', (t) => {
  const { run } = bookmarksCli(t);
  const extra = WORKER_ENVS['only HERDR_WORKTREE'];
  const runs = [
    ['bookmarks', 'alpha', 'add', 'Docs', 'https://new.example.net/docs'],
    ['bookmarks', 'alpha', 'rm', '0'],
    ['bookmarks', 'alpha', 'start', 'https://start.example.net/'],
    ['bookmarks', 'alpha', 'add', 'Docs2', 'https://new2.example.net/docs', '--full'],
  ];
  for (const args of runs) {
    const result = run(args, extra);
    // The caller check needs no live Herdr when only HERDR_WORKTREE is set.
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(output), ['bookmarks']);
    assert.ok(output.bookmarks.every((b) => Object.keys(b).sort().join() === 'index,name'));
    assert.ok(!/example\.net|"url"|startPage/.test(result.stdout), result.stdout);
  }
});

test('the Owner keeps masked output from add', (t) => {
  const { run } = bookmarksCli(t);
  const result = run(['bookmarks', 'alpha', 'add', 'Docs', 'https://new.example.net/docs']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).bookmarks.at(-1).url, 'https://<tenant>.example.net/docs');
});

test('the top-level error text masks a stored host, also from a legacy stored URL', (t) => {
  const { dataDir } = bookmarksCli(t);
  const file = path.join(dataDir, 'browser-sessions.json');
  const sessions = JSON.parse(fs.readFileSync(file, 'utf8'));
  sessions.alpha.bookmarks.push({ name: 'Legacy', url: 'https://https://tenant2.example.test/old' });
  fs.writeFileSync(file, JSON.stringify(sessions));
  const script = `
    import { browserErrorText } from ${JSON.stringify(new URL('../src/cli.js', import.meta.url).href)};
    process.stdout.write(await browserErrorText('getaddrinfo ENOTFOUND tenant2.example.test and acme.example.com', { full: false }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, HERDR_BOSS_DIR: dataDir, HOME: path.dirname(dataDir) } });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes('tenant2'), result.stdout);
  assert.ok(!result.stdout.includes('acme.example.com'), result.stdout);
});

test('bookmarks add refuses a scheme word as the parsed hostname', (t) => {
  const { run, dataDir } = bookmarksCli(t);
  for (const url of ['https://%68ttps/tenant9.example.test', 'https://wss./tenant9.example.test', 'https://https.:80/tenant9.example.test']) {
    const result = run(['bookmarks', 'alpha', 'add', 'Bad', url]);
    assert.notEqual(result.status, 0, url);
    assert.ok(!`${result.stdout}${result.stderr}`.includes('tenant9'), url);
  }
  assert.ok(!fs.readFileSync(path.join(dataDir, 'browser-sessions.json'), 'utf8').includes('tenant9'));
});

test('bookmarks add keeps a plain URL and a host that starts with a scheme word', (t) => {
  const { run } = bookmarksCli(t);
  for (const url of ['https://plain.example.test/a', 'https://https-proxy.example.test/a']) {
    const result = run(['bookmarks', 'alpha', 'add', 'Ok', url]);
    assert.equal(result.status, 0, `${url}: ${result.stderr}`);
  }
});

test('the error text for a worker never unmasks a host with --full, and the Owner keeps --full', (t) => {
  const { dataDir } = bookmarksCli(t);
  const script = (env) => `
    import { browserErrorText } from ${JSON.stringify(new URL('../src/cli.js', import.meta.url).href)};
    process.stdout.write(await browserErrorText('ENOTFOUND https://other.example.org/x', { full: true }));
  `;
  const base = { ...process.env, HERDR_BOSS_DIR: dataDir, HOME: path.dirname(dataDir) };
  for (const key of ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'HERDR_WORKTREE']) delete base[key];
  const owner = spawnSync(process.execPath, ['--input-type=module', '-e', script()], { encoding: 'utf8', env: base });
  assert.equal(owner.stdout, 'ENOTFOUND https://other.example.org/x');
  const worker = spawnSync(process.execPath, ['--input-type=module', '-e', script()], { encoding: 'utf8', env: { ...base, HERDR_WORKTREE: '/tmp/wt-x' } });
  assert.ok(!worker.stdout.includes('other.example.org'), worker.stdout);
  assert.ok(worker.stdout.includes('<tenant>'), worker.stdout);
});
