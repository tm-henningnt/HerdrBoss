import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createToolsCheck, TOOLS_STATE_FILE, toolsCommand } from '../src/tools-check.js';

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

function fixtureFetch({ fail = new Set() } = {}) {
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
        return jsonResponse(repo === 'cli/cli' ? [{
          published_at: '2026-09-20T00:00:00.000Z',
          withdrawn_at: null,
          vulnerabilities: [{ vulnerable_version_range: '< 2.102.0' }],
        }] : []);
      }
      const releases = {
        'anthropics/claude-code': ['v2.1.291', 'v2.1.292'],
        'openai/codex': ['v0.160.0', 'v0.160.1'],
        'anomalyco/opencode': ['v1.18.34', 'v1.18.35'],
        'badlogic/pi-mono': ['v1.0.0', 'v1.0.4'],
        'ogulcancelik/herdr': ['v0.9.2', 'v0.9.3'],
        'steipete/CodexBar': ['v0.72.0', 'v0.73.0'],
        'cli/cli': ['v2.101.0', 'v2.102.0'],
        'nodejs/node': ['v26.10.0', 'v26.11.0'],
        'just-containers/s6-overlay': ['v3.2.3.1', 'v3.2.3.2'],
        'moby/buildkit': ['v0.33.0', 'v0.33.1'],
      }[repo];
      assert.ok(releases, `unexpected GitHub URL: ${target.pathname}`);
      return jsonResponse(releases.map((tag_name, index) => ({
        tag_name,
        name: tag_name,
        body: repo === 'cli/cli' && index === 1 ? 'Security fix CVE-2026-12345.' : 'Maintenance release.',
        published_at: index === 0 ? '2026-09-01T00:00:00.000Z' : '2026-09-20T00:00:00.000Z',
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

test('tools check prints JSON and rejects invalid options before an upstream request', async (t) => {
  const { dataDir, pinsFile } = fixture(t);
  const output = [];
  await toolsCommand(['check', '--now', '--json'], {
    dataDir,
    pinsFile,
    fetch: fixtureFetch(),
    installed: { claude: '2.1.292', codex: '0.160.1', opencode: '2.0.20', pi: '1.0.0', herdr: '0.9.3', codexbar: '0.72.0', gh: '2.102.0', node: '26.10.0' },
    now: () => CHECKED_AT,
    output: (value) => output.push(value),
  });
  assert.equal(JSON.parse(output[0]).schemaVersion, 1);

  let requests = 0;
  await assert.rejects(toolsCommand(['check', '--unknown'], { fetch: async () => { requests += 1; } }), /Usage: tools check/);
  assert.equal(requests, 0);
});
