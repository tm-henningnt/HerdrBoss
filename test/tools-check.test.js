import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createToolsCheck, TOOLS_STATE_FILE, toolsCommand } from '../src/tools-check.js';
import { readMessages, updateMessage } from '../src/messages.js';

const CHECKED_AT = new Date('2026-10-07T00:00:00.000Z');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  const pinsFile = path.join(root, 'pins.json');
  const pins = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../factory/pins.json', import.meta.url)), 'utf8'));
  fs.writeFileSync(pinsFile, JSON.stringify(pins));
  return { dataDir, pinsFile };
}

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function fixtureFetch({ fail = new Set(), failAdvisories = new Set(), advisories = {}, releaseBodies = {} } = {}) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    const target = new URL(url);
    if (fail.has(target.hostname)) throw new Error('private failure detail');
    if (target.hostname === 'registry.npmjs.org') {
      const versions = {
        '@anthropic-ai%2fclaude-code': ['2.1.288', '2.1.292'],
        '@openai%2fcodex': ['0.160.0', '0.160.1'],
        'opencode-ai': ['1.18.34', '1.18.35'],
        '@earendil-works%2fpi-coding-agent': ['1.0.0', '1.0.4'],
      }[target.pathname.slice(1).toLowerCase()];
      assert.ok(versions, `unexpected npm package URL: ${target.pathname}`);
      const [prior, latest] = versions;
      return jsonResponse({
        'dist-tags': { latest, stable: latest },
        time: { [prior]: '2026-09-01T00:00:00.000Z', [latest]: '2026-09-20T00:00:00.000Z' },
      });
    }
    if (target.hostname === 'api.github.com') {
      const repo = target.pathname.split('/').slice(2, 4).join('/');
      if (target.pathname.endsWith('/security-advisories')) {
        if (failAdvisories.has(repo)) throw new Error('private failure detail');
        return jsonResponse(advisories[repo] ?? (repo === 'cli/cli' ? [{
          published_at: '2026-09-20T00:00:00.000Z',
          withdrawn_at: null,
          vulnerabilities: [{ vulnerable_version_range: '< 2.102.0' }],
        }] : []));
      }
      const releases = {
        'anthropics/claude-code': ['v2.1.291', 'v2.1.292'],
        'openai/codex': ['v0.160.0', 'v0.160.1'],
        'anomalyco/opencode': ['v1.18.34', 'v1.18.35'],
        'badlogic/pi-mono': ['v1.0.0', 'v1.0.4'],
        'ogulcancelik/herdr': ['v0.9.2', 'v0.9.3'],
        'steipete/CodexBar': ['v0.72.0', 'v0.73.0'],
        'cli/cli': ['v2.101.0', 'v2.102.0'],
        'nodejs/node': ['v26.10.0', 'v26.11.0', 'v27.0.0', 'v24.11.0'],
        'just-containers/s6-overlay': ['v3.2.3.1', 'v3.2.3.2'],
        'moby/buildkit': ['v0.33.0', 'v0.33.1'],
      }[repo];
      assert.ok(releases, `unexpected GitHub URL: ${target.pathname}`);
      return jsonResponse(releases.map((tag_name, index) => ({
        tag_name,
        name: tag_name,
        body: releaseBodies[tag_name] ?? (repo === 'cli/cli' && index === 1 ? 'Security fix CVE-2026-12345.' : 'Maintenance release.'),
        published_at: repo === 'nodejs/node'
          ? ['2026-09-01T00:00:00.000Z', '2026-09-10T00:00:00.000Z', '2026-09-20T00:00:00.000Z', '2026-10-01T00:00:00.000Z'][index]
          : index === 0 ? '2026-09-01T00:00:00.000Z' : '2026-09-20T00:00:00.000Z',
        prerelease: false,
        draft: false,
      })).reverse());
    }
    if (target.hostname === 'tracker.debian.org') {
      return { ok: true, status: 200, text: async () => '<span><b>stable-sec:</b></span><a>154.<wbr>0.<wbr>8037.<wbr>92-<wbr>1~<wbr>deb13u1</a><span class="news-date">2026-10-01</span><span class="news-title">Accepted chromium 154.0.8037.92-1~deb13u1 (source) into stable-security</span>' };
    }
    if (target.hostname === 'hub.docker.com') {
      return jsonResponse({ name: 'trixie-slim', digest: 'sha256:fixture-digest', last_updated: '2026-09-20T00:00:00.000Z' });
    }
    assert.fail(`unexpected upstream host: ${target.hostname}`);
  };
  fetch.calls = calls;
  return fetch;
}

test('tools check records the Mac and factory inventory from an injected upstream', async (t) => {
  const { dataDir, pinsFile } = fixture(t);
  const pins = JSON.parse(fs.readFileSync(pinsFile, 'utf8'));
  pins.gh = '2.101.0';
  pins.chromium = '154.0.8037.92-1~deb13u0';
  fs.writeFileSync(pinsFile, JSON.stringify(pins));
  const fetch = fixtureFetch();
  const installed = {
    claude: '2.1.292', codex: '0.160.1', opencode: '2.0.20', pi: '1.0.0',
    herdr: '0.9.3', codexbar: '0.72.0', gh: '2.102.0', node: '26.10.0',
  };
  const check = createToolsCheck({ dataDir, pinsFile, fetch, installed, now: () => CHECKED_AT });

  const state = await check();

  assert.equal(state.schemaVersion, 1);
  assert.equal(state.checkedAt, CHECKED_AT.toISOString());
  assert.equal(state.tools.length, 12);
  assert.ok(fetch.calls.length >= 10);
  assert.ok(fetch.calls.every((url) => ['registry.npmjs.org', 'api.github.com', 'tracker.debian.org', 'hub.docker.com'].includes(new URL(url).hostname)));
  const opencode = state.tools.find((tool) => tool.id === 'opencode');
  assert.equal(opencode.installed.mac, '2.0.20');
  assert.equal(opencode.pinned, '1.18.34');
  assert.equal(opencode.latest, '1.18.35');
  assert.equal(opencode.ageDays, 17);
  assert.equal(opencode.risk, 'late');
  const gh = state.tools.find((tool) => tool.id === 'gh');
  assert.equal(gh.risk, 'security');
  const chromium = state.tools.find((tool) => tool.id === 'chromium');
  assert.equal(chromium.risk, 'security');
  assert.equal(chromium.ageDays, 6);
  assert.equal(state.tools.find((tool) => tool.id === 'pi').pinned, null);
  assert.equal(state.tools.find((tool) => tool.id === 'pi').whereRuns.join(','), 'mac');

  const file = path.join(dataDir, TOOLS_STATE_FILE);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), state);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(dataDir).filter((name) => name.endsWith('.tmp')).length, 0);
  assert.doesNotMatch(JSON.stringify(state), /token|authorization|private failure detail/i);
});

test('a failed upstream keeps the last latest value and marks the tool unknown', async (t) => {
  const { dataDir, pinsFile } = fixture(t);
  const installed = { claude: '2.1.292', codex: '0.160.1', opencode: '2.0.20', pi: '1.0.0', herdr: '0.9.3', codexbar: '0.72.0', gh: '2.102.0', node: '26.10.0' };
  const first = await createToolsCheck({ dataDir, pinsFile, fetch: fixtureFetch(), installed, now: () => CHECKED_AT })();
  assert.equal(first.tools.find((tool) => tool.id === 'chromium').risk, 'ok');
  const failed = fixtureFetch({ fail: new Set(['registry.npmjs.org']) });

  const state = await createToolsCheck({ dataDir, pinsFile, fetch: failed, installed, now: () => CHECKED_AT })();

  const codex = state.tools.find((tool) => tool.id === 'codex');
  assert.equal(codex.latest, first.tools.find((tool) => tool.id === 'codex').latest);
  assert.equal(codex.risk, 'unknown');
  assert.equal(codex.error, 'upstream unavailable');
  assert.doesNotMatch(JSON.stringify(state), /private failure detail/i);
});

test('a failed fetch preserves a previously saved security risk', async (t) => {
  const { dataDir, pinsFile } = fixture(t);
  const pins = JSON.parse(fs.readFileSync(pinsFile, 'utf8'));
  pins.gh = '2.101.0';
  fs.writeFileSync(pinsFile, JSON.stringify(pins));
  const installed = { claude: '2.1.292', codex: '0.160.1', opencode: '2.0.20', pi: '1.0.0', herdr: '0.9.3', codexbar: '0.72.0', gh: '2.102.0', node: '26.10.0' };
  const first = await createToolsCheck({ dataDir, pinsFile, fetch: fixtureFetch(), installed, now: () => CHECKED_AT })();
  assert.equal(first.tools.find((tool) => tool.id === 'gh').risk, 'security');

  const failed = await createToolsCheck({ dataDir, pinsFile, fetch: fixtureFetch({ fail: new Set(['api.github.com']) }), installed, now: () => CHECKED_AT })();

  const gh = failed.tools.find((tool) => tool.id === 'gh');
  assert.equal(gh.risk, 'security');
  assert.equal(gh.error, 'upstream unavailable');
});

test('a bare security word does not mark a release as a security release', async (t) => {
  const { dataDir, pinsFile } = fixture(t);
  const pins = JSON.parse(fs.readFileSync(pinsFile, 'utf8'));
  pins.gh = '2.101.0';
  fs.writeFileSync(pinsFile, JSON.stringify(pins));
  const fetch = fixtureFetch({
    advisories: { 'cli/cli': [] },
    releaseBodies: { 'v2.102.0': 'Security improvements for the terminal output.' },
  });
  const installed = { gh: '2.102.0' };

  const state = await createToolsCheck({ dataDir, pinsFile, fetch, installed, now: () => CHECKED_AT })();

  assert.equal(state.tools.find((tool) => tool.id === 'gh').risk, 'late');
});

test('a GitHub advisory link marks a release as a security release', async (t) => {
  const { dataDir, pinsFile } = fixture(t);
  const pins = JSON.parse(fs.readFileSync(pinsFile, 'utf8'));
  pins.gh = '2.101.0';
  fs.writeFileSync(pinsFile, JSON.stringify(pins));
  const fetch = fixtureFetch({
    advisories: { 'cli/cli': [] },
    releaseBodies: { 'v2.102.0': 'See https://github.com/advisories/GHSA-abcd-efgh-ijkl.' },
  });

  const state = await createToolsCheck({ dataDir, pinsFile, fetch, installed: { gh: '2.102.0' }, now: () => CHECKED_AT })();

  assert.equal(state.tools.find((tool) => tool.id === 'gh').risk, 'security');
});

test('GitHub latest uses the highest version on the tracked major line', async (t) => {
  const { dataDir, pinsFile } = fixture(t);
  const pins = JSON.parse(fs.readFileSync(pinsFile, 'utf8'));
  pins.node = '26.10.0';
  fs.writeFileSync(pinsFile, JSON.stringify(pins));

  const state = await createToolsCheck({ dataDir, pinsFile, fetch: fixtureFetch(), installed: { node: '26.10.0' }, now: () => CHECKED_AT })();

  assert.equal(state.tools.find((tool) => tool.id === 'node').latest, '26.11.0');
});

test('GitHub latest uses the highest version overall when no release matches the tracked line', async (t) => {
  const { dataDir, pinsFile } = fixture(t);
  const pins = JSON.parse(fs.readFileSync(pinsFile, 'utf8'));
  pins.node = '25.0.0';
  fs.writeFileSync(pinsFile, JSON.stringify(pins));

  const state = await createToolsCheck({ dataDir, pinsFile, fetch: fixtureFetch(), installed: { node: '25.0.0' }, now: () => CHECKED_AT })();

  assert.equal(state.tools.find((tool) => tool.id === 'node').latest, '27.0.0');
});

test('a failed advisory request does not discard good release data', async (t) => {
  const { dataDir, pinsFile } = fixture(t);
  const pins = JSON.parse(fs.readFileSync(pinsFile, 'utf8'));
  pins.gh = '2.101.0';
  fs.writeFileSync(pinsFile, JSON.stringify(pins));

  const state = await createToolsCheck({
    dataDir,
    pinsFile,
    fetch: fixtureFetch({ failAdvisories: new Set(['cli/cli']) }),
    installed: { gh: '2.102.0' },
    now: () => CHECKED_AT,
  })();

  const gh = state.tools.find((tool) => tool.id === 'gh');
  assert.equal(gh.latest, '2.102.0');
  assert.equal(gh.risk, 'security');
  assert.equal(gh.error, undefined);
});

test('a read tool update stays read after a second tools check', async (t) => {
  const { dataDir, pinsFile } = fixture(t);
  const pins = JSON.parse(fs.readFileSync(pinsFile, 'utf8'));
  pins.gh = '2.101.0';
  fs.writeFileSync(pinsFile, JSON.stringify(pins));
  const check = createToolsCheck({ dataDir, pinsFile, fetch: fixtureFetch(), installed: {}, now: () => CHECKED_AT });
  await check();

  const item = readMessages({ dir: dataDir }).find((record) => record.key === 'tools:gh:2.102.0');
  assert.ok(item);
  const readAt = '2026-10-07T00:01:00.000Z';
  updateMessage(item.id, { status: 'read', readAt }, { dir: dataDir, now: Date.parse(readAt) });

  await check();

  const updated = readMessages({ dir: dataDir }).find((record) => record.id === item.id);
  assert.equal(updated.status, 'read');
  assert.equal(updated.readAt, readAt);
});

test('a Mailbox failure adds one note and does not stop later tool updates', async (t) => {
  const { dataDir, pinsFile } = fixture(t);
  const attempts = [];
  const notes = [];
  const state = await createToolsCheck({
    dataDir,
    pinsFile,
    fetch: fixtureFetch(),
    installed: {},
    now: () => CHECKED_AT,
    output: (line) => notes.push(line),
    mailbox: async (tool) => {
      attempts.push(tool.id);
      if (attempts.length === 1) throw new Error('private failure detail');
    },
  })();

  const expected = state.tools.filter((tool) => tool.risk === 'security' || (tool.risk === 'late' && Number.isInteger(tool.ageDays) && tool.ageDays > 14));
  assert.ok(attempts.length > 1);
  assert.equal(attempts.length, expected.length);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^note: could not post .* to the Mailbox; continuing\.$/);
  assert.doesNotMatch(notes[0], /private failure detail/i);
});

test('the default GitHub request uses fetch without the gh login', async (t) => {
  const { dataDir, pinsFile } = fixture(t);
  const bin = path.join(dataDir, 'bin');
  fs.mkdirSync(bin);
  const marker = path.join(dataDir, 'gh-was-called');
  const fakeGh = path.join(bin, 'gh');
  fs.writeFileSync(fakeGh, '#!/bin/sh\n: > "$HERDR_TEST_GH_MARKER"\nprintf "[]"\n');
  fs.chmodSync(fakeGh, 0o700);
  const oldPath = process.env.PATH;
  const oldMarker = process.env.HERDR_TEST_GH_MARKER;
  const oldFetch = globalThis.fetch;
  const calls = [];
  const mockUpstream = fixtureFetch();
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  process.env.HERDR_TEST_GH_MARKER = marker;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return mockUpstream(url);
  };
  try {
    await createToolsCheck({ dataDir, pinsFile, installed: {}, now: () => CHECKED_AT })();
  } finally {
    globalThis.fetch = oldFetch;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldMarker === undefined) delete process.env.HERDR_TEST_GH_MARKER;
    else process.env.HERDR_TEST_GH_MARKER = oldMarker;
  }
  assert.equal(fs.existsSync(marker), false);
  const githubCalls = calls.filter((call) => new URL(call.url).hostname === 'api.github.com');
  assert.ok(githubCalls.length > 0);
  for (const call of githubCalls) assert.equal(new Headers(call.options.headers).has('authorization'), false);
});

test('tools check chmods an existing owned data directory to 0700', async (t) => {
  const { dataDir, pinsFile } = fixture(t);
  fs.chmodSync(dataDir, 0o755);
  assert.equal(fs.statSync(dataDir).uid, process.getuid());

  await createToolsCheck({ dataDir, pinsFile, fetch: fixtureFetch(), installed: {}, now: () => CHECKED_AT })();

  assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
});

test('tools check skips a directory mode change through a symbolic link', async (t) => {
  const { dataDir: fixtureDir, pinsFile } = fixture(t);
  fs.rmSync(fixtureDir, { recursive: true });
  const targetDir = path.join(path.dirname(fixtureDir), 'target-data');
  fs.mkdirSync(targetDir);
  fs.chmodSync(targetDir, 0o755);
  const dataDir = path.join(path.dirname(fixtureDir), 'data-link');
  fs.symlinkSync(targetDir, dataDir, 'dir');

  await createToolsCheck({ dataDir, pinsFile, fetch: fixtureFetch(), installed: {}, now: () => CHECKED_AT })();

  assert.equal(fs.statSync(targetDir).mode & 0o777, 0o755);
});

test('tools check prints JSON and rejects invalid options before an upstream request', async (t) => {
  const { dataDir, pinsFile } = fixture(t);
  const output = [];
  await toolsCommand(['check', '--json'], {
    dataDir,
    pinsFile,
    fetch: fixtureFetch(),
    installed: { claude: '2.1.292', codex: '0.160.1', opencode: '2.0.20', pi: '1.0.0', herdr: '0.9.3', codexbar: '0.72.0', gh: '2.102.0', node: '26.10.0' },
    now: () => CHECKED_AT,
    output: (value) => output.push(value),
  });
  assert.equal(JSON.parse(output[0]).schemaVersion, 1);

  let requests = 0;
  const options = {
    dataDir,
    pinsFile,
    installed: {},
    now: () => CHECKED_AT,
    fetch: async () => { requests += 1; return jsonResponse([]); },
  };
  await assert.rejects(toolsCommand(['check', '--unknown'], options), /Usage: tools check/);
  await assert.rejects(toolsCommand(['check', '--now'], options), /Usage: tools check/);
  assert.equal(requests, 0);
});
