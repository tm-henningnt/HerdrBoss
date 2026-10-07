import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createToolsCheck, toolsCommand } from '../src/tools-check.js';
import { postToolUpdate } from '../src/messages.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-update-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(path.join(repoRoot, 'factory'), { recursive: true });
  const pinsFile = path.join(repoRoot, 'factory', 'pins.json');
  const source = fileURLToPath(new URL('../factory/pins.json', import.meta.url));
  fs.copyFileSync(source, pinsFile);
  return { root, repoRoot, dataDir, pinsFile };
}

const CHECKOUT_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

function initGit(root) {
  const run = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  run(['init', '-b', 'main']);
  run(['config', 'user.name', 'Herdr Boss Fixture']);
  run(['config', 'user.email', 'fixture@example.invalid']);
  run(['add', 'factory/pins.json']);
  run(['commit', '-m', 'fixture baseline']);
}

function bumpProject(root, worktreeRoot) {
  return {
    baseBranch: 'main',
    worktreePath: (name) => path.join(worktreeRoot, path.basename(root), name),
  };
}

function fixtureGit(root, calls, afterCommand = () => {}) {
  return (args, context = {}) => {
    const cwd = context.cwd ?? process.cwd();
    const command = args[0] === '-C' ? args.slice(2) : args;
    const mutation = ['add', 'checkout', 'commit', 'switch'].includes(command[0])
      || (command[0] === 'branch' && ['-D', '-d', '-m', '-M', '-c', '-C'].includes(command[1]))
      || (command[0] === 'worktree' && ['add', 'move', 'prune', 'remove', 'repair', 'lock', 'unlock'].includes(command[1]));
    if ([CHECKOUT_ROOT, path.resolve(root)].includes(path.resolve(cwd))) assert.equal(mutation, false, 'git must not mutate the served checkout');
    calls.push({ args, cwd: path.resolve(cwd) });
    if (args[0] === 'status' && !Object.hasOwn(context, 'cwd')) return '';
    const output = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    afterCommand(args, cwd);
    return output;
  };
}

function response(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => body };
}

function npmFetch({ integrity = 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', publishedAt = '2026-09-20T00:00:00.000Z', releaseBody = 'Maintenance release.', failAdvisories = false } = {}) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    const target = new URL(url);
    if (target.hostname === 'registry.npmjs.org') {
      return response({
        'dist-tags': { latest: '0.160.1' },
        time: { '0.160.0': '2026-09-01T00:00:00.000Z', '0.160.1': publishedAt },
        versions: {
          '0.160.0': { dist: { integrity: 'sha512-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=' } },
          '0.160.1': { dist: integrity ? { integrity } : {} },
        },
      });
    }
    assert.equal(target.hostname, 'api.github.com');
    if (target.pathname.endsWith('/security-advisories')) {
      if (failAdvisories) throw new Error('private failure detail');
      return response([]);
    }
    return response([{ tag_name: 'v0.160.1', name: 'v0.160.1', body: releaseBody, published_at: publishedAt, draft: false, prerelease: false, assets: [] }]);
  };
  fetch.calls = calls;
  return fetch;
}

function cleanGit(calls = []) {
  return (args) => {
    calls.push(args);
    if (args[0] === 'status') return '';
    return '';
  };
}

test('tools bump dry-run prints a diff and does not write or create a branch', async (t) => {
  const { pinsFile } = fixture(t);
  const before = fs.readFileSync(pinsFile, 'utf8');
  const output = [];
  const gitCalls = [];
  const fetch = npmFetch();

  await toolsCommand(['bump', 'codex', '--to', '0.160.1', '--dry-run'], {
    pinsFile,
    fetch,
    git: cleanGit(gitCalls),
    output: (line) => output.push(line),
  });

  assert.equal(fs.readFileSync(pinsFile, 'utf8'), before);
  assert.deepEqual(gitCalls, []);
  assert.match(output.join('\n'), /^--- a\/factory\/pins\.json/m);
  assert.match(output.join('\n'), /^\+.*0\.160\.1/m);
  assert.match(output.join('\n'), /sha512-/);
});

test('tools bump commits pins in a separate worktree and leaves the served checkout untouched', async (t) => {
  const { root, repoRoot, pinsFile } = fixture(t);
  initGit(repoRoot);
  const worktreeRoot = path.join(root, 'worker-trees');
  const projectConfig = bumpProject(repoRoot, worktreeRoot);
  const worktreePath = projectConfig.worktreePath('tools-bump-codex-0.160.1');
  const mainBefore = fs.readFileSync(pinsFile, 'utf8');
  const fetch = npmFetch();
  const gitCalls = [];
  const output = [];

  await toolsCommand(['bump', 'codex', '--to', '0.160.1'], {
    root: repoRoot,
    pinsFile,
    projectConfig,
    fetch,
    git: fixtureGit(repoRoot, gitCalls),
    output: (line) => output.push(line),
  });

  const pins = JSON.parse(fs.readFileSync(path.join(worktreePath, 'factory', 'pins.json'), 'utf8'));
  assert.equal(pins.schema, 2);
  assert.equal(pins.codex, '0.160.1');
  assert.deepEqual(pins.integrity.codex, {
    version: '0.160.1',
    value: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    mark: 'published',
  });
  assert.equal(pins.digestMark.base, 'published');
  assert.ok(Object.values(pins.sha256Mark).every((mark) => mark === 'published'));
  assert.equal(fs.readFileSync(pinsFile, 'utf8'), mainBefore, 'the main checkout pin file stays unchanged');
  assert.equal(execFileSync('git', ['-C', repoRoot, 'branch', '--show-current'], { encoding: 'utf8' }).trim(), 'main');
  assert.match(execFileSync('git', ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }), /^tools\/codex-0\.160\.1\n$/);
  assert.match(execFileSync('git', ['-C', worktreePath, 'show', '-s', '--format=%B', 'HEAD'], { encoding: 'utf8' }), /\nKit-Impact: none\n+$/);
  assert.equal(fs.readdirSync(path.join(worktreePath, 'factory')).some((name) => name.endsWith('.tmp')), false);
  assert.ok(gitCalls.every(({ cwd }) => path.resolve(cwd) !== CHECKOUT_ROOT), 'all Git commands run outside the served checkout');
  assert.ok(gitCalls.some(({ args }) => args.includes('worktree') && args.includes('add')));
  assert.ok(gitCalls.some(({ args }) => args.includes('commit')));
  assert.match(output.join('\n'), /^--- a\/factory\/pins\.json/m);
  assert.ok(output.includes(`Worktree: ${worktreePath}`));
  assert.ok(output.includes('Branch: tools/codex-0.160.1'));
});

test('tools bump removes its worktree and branch when the atomic pin write fails', async (t) => {
  const { root, repoRoot, pinsFile } = fixture(t);
  initGit(repoRoot);
  const worktreeRoot = path.join(root, 'worker-trees');
  const projectConfig = bumpProject(repoRoot, worktreeRoot);
  const worktreePath = projectConfig.worktreePath('tools-bump-codex-0.160.1');
  const gitCalls = [];
  const makePinsDirectory = (args) => {
    if (args[0] !== '-C' || args[2] !== 'worktree' || args[3] !== 'add') return;
    const target = args[6];
    fs.rmSync(path.join(target, 'factory', 'pins.json'));
    fs.mkdirSync(path.join(target, 'factory', 'pins.json'));
  };

  await assert.rejects(toolsCommand(['bump', 'codex', '--to', '0.160.1'], {
    root: repoRoot,
    pinsFile,
    projectConfig,
    fetch: npmFetch(),
    git: fixtureGit(repoRoot, gitCalls, makePinsDirectory),
    output: () => {},
  }));

  assert.equal(fs.existsSync(worktreePath), false);
  assert.notEqual(execFileSync('git', ['-C', repoRoot, 'branch', '--list', 'tools/codex-0.160.1'], { encoding: 'utf8' }).trim(), 'tools/codex-0.160.1');
  assert.ok(gitCalls.some(({ args }) => args.includes('remove') && args.includes('--force')));
  assert.ok(gitCalls.some(({ args }) => args.includes('branch') && args.includes('-D')));
});

test('tools bump validates the requested version before an upstream lookup', async (t) => {
  const { pinsFile } = fixture(t);
  let requests = 0;
  await assert.rejects(toolsCommand(['bump', 'codex', '--to', '0.160'], {
    pinsFile,
    fetch: async () => { requests += 1; return response({}); },
    git: cleanGit(),
    output: () => {},
  }), /Usage: tools bump/);
  await assert.rejects(toolsCommand(['bump', 'constructor', '--to', '0.160.1'], {
    pinsFile,
    fetch: async () => { requests += 1; return response({}); },
    git: cleanGit(),
    output: () => {},
  }), /no factory pin to bump/i);
  assert.equal(requests, 0);
});

test('tools bump refuses an existing target worktree', async (t) => {
  const { root, repoRoot, pinsFile } = fixture(t);
  initGit(repoRoot);
  const worktreeRoot = path.join(root, 'worker-trees');
  const projectConfig = bumpProject(repoRoot, worktreeRoot);
  const worktreePath = projectConfig.worktreePath('tools-bump-codex-0.160.1');
  fs.mkdirSync(worktreePath, { recursive: true });
  const gitCalls = [];

  await assert.rejects(toolsCommand(['bump', 'codex', '--to', '0.160.1'], {
    root: repoRoot,
    pinsFile,
    projectConfig,
    fetch: npmFetch(),
    git: fixtureGit(repoRoot, gitCalls),
    output: () => {},
  }), /worktree already exists/i);

  assert.deepEqual(gitCalls, []);
  assert.equal(fs.existsSync(worktreePath), true);
  assert.equal(fs.readFileSync(pinsFile, 'utf8'), fs.readFileSync(fileURLToPath(new URL('../factory/pins.json', import.meta.url)), 'utf8'));
});

test('tools bump notes a failed advisory check and keeps the three-day wait', async (t) => {
  const { pinsFile } = fixture(t);
  const output = [];
  await assert.rejects(toolsCommand(['bump', 'codex', '--to', '0.160.1', '--dry-run'], {
    pinsFile,
    fetch: npmFetch({ publishedAt: '2026-10-06T12:00:00.000Z', failAdvisories: true }),
    now: () => new Date('2026-10-07T00:00:00.000Z'),
    output: (line) => output.push(line),
  }), /less than 3 days old/i);
  assert.equal(output.length, 1);
  assert.match(output[0], /security exception was not checked/i);
});

test('tools bump refuses when the published registry integrity is missing', async (t) => {
  const { pinsFile } = fixture(t);
  const before = fs.readFileSync(pinsFile, 'utf8');

  await assert.rejects(toolsCommand(['bump', 'codex'], {
    pinsFile,
    fetch: npmFetch({ integrity: null }),
    git: cleanGit(),
    output: () => {},
  }), /published integrity is missing/i);

  assert.equal(fs.readFileSync(pinsFile, 'utf8'), before);
});

test('tools bump waits three days for a harness release unless it fixes a security issue', async (t) => {
  const waiting = fixture(t);
  await assert.rejects(toolsCommand(['bump', 'codex', '--to', '0.160.1', '--dry-run'], {
    pinsFile: waiting.pinsFile,
    fetch: npmFetch({ publishedAt: '2026-10-06T12:00:00.000Z' }),
    now: () => new Date('2026-10-07T00:00:00.000Z'),
    output: () => {},
  }), /less than 3 days old/i);

  const security = fixture(t);
  const output = [];
  await toolsCommand(['bump', 'codex', '--to', '0.160.1', '--dry-run'], {
    pinsFile: security.pinsFile,
    fetch: npmFetch({ publishedAt: '2026-10-06T12:00:00.000Z', releaseBody: 'Fixes CVE-2026-12345.' }),
    now: () => new Date('2026-10-07T00:00:00.000Z'),
    output: (line) => output.push(line),
  });
  assert.match(output.join('\n'), /^--- a\/factory\/pins\.json/m);
});

test('tools bump compares a downloaded artifact with its published checksum', async (t) => {
  const { pinsFile } = fixture(t);
  const before = fs.readFileSync(pinsFile, 'utf8');
  const fetch = async (url) => {
    const value = String(url);
    if (value.includes('api.github.com/repos/just-containers/s6-overlay/releases')) {
      return response([{ tag_name: 'v3.2.3.3', name: 'v3.2.3.3', published_at: '2026-10-01T00:00:00.000Z', draft: false, prerelease: false, assets: [] }]);
    }
    if (value.endsWith('.sha256')) return response(`${'0'.repeat(64)}  ${value.split('/').at(-1).slice(0, -7)}\n`);
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('different artifact') };
  };

  await assert.rejects(toolsCommand(['bump', 's6-overlay'], {
    pinsFile,
    fetch,
    git: cleanGit(),
    output: () => {},
  }), /checksum does not match/i);

  assert.equal(fs.readFileSync(pinsFile, 'utf8'), before);
});

test('tools bump refuses when a published artifact checksum is missing', async (t) => {
  const { pinsFile } = fixture(t);
  const before = fs.readFileSync(pinsFile, 'utf8');
  const fetch = async (url) => {
    const value = String(url);
    if (value.includes('api.github.com/repos/just-containers/s6-overlay/releases')) {
      return response([{ tag_name: 'v3.2.3.3', name: 'v3.2.3.3', published_at: '2026-10-01T00:00:00.000Z', draft: false, prerelease: false, assets: [] }]);
    }
    if (value.endsWith('.sha256')) return response('not a checksum file');
    assert.fail('the command tried to download an artifact without a published checksum');
  };

  await assert.rejects(toolsCommand(['bump', 's6-overlay'], {
    pinsFile,
    fetch,
    git: cleanGit(),
    output: () => {},
  }), /published checksum is missing/i);

  assert.equal(fs.readFileSync(pinsFile, 'utf8'), before);
});

test('tools bump reports a tool with no checksum source and makes no guess', async (t) => {
  const { pinsFile } = fixture(t);
  const before = fs.readFileSync(pinsFile, 'utf8');

  await assert.rejects(toolsCommand(['bump', 'herdr'], {
    pinsFile,
    fetch: async () => assert.fail('Herdr has no checksum source'),
    git: cleanGit(),
    output: () => {},
  }), /no checksum source/i);

  assert.equal(fs.readFileSync(pinsFile, 'utf8'), before);
});

test('tools check sends only late and security rows through the Mailbox seam', async (t) => {
  const { dataDir, pinsFile } = fixture(t);
  const posts = [];
  const fetch = async (url) => {
    const target = new URL(url);
    if (target.hostname === 'registry.npmjs.org') {
      const latest = target.pathname.includes('claude') ? '2.1.292'
        : target.pathname.includes('codex') ? '0.160.1'
          : target.pathname.includes('opencode') ? '1.18.35' : '1.0.4';
      const prior = target.pathname.includes('claude') ? '2.1.288'
        : target.pathname.includes('codex') ? '0.160.0'
          : target.pathname.includes('opencode') ? '1.18.34' : '1.0.0';
      return response({ 'dist-tags': { latest }, time: { [prior]: '2026-09-01T00:00:00.000Z', [latest]: '2026-09-20T00:00:00.000Z' } });
    }
    if (target.hostname === 'api.github.com') {
      const repo = target.pathname.split('/').slice(2, 4).join('/');
      if (target.pathname.endsWith('/security-advisories')) return response(repo === 'cli/cli' ? [{ published_at: '2026-09-20T00:00:00.000Z', withdrawn_at: null, vulnerabilities: [{ vulnerable_version_range: '< 2.102.0' }] }] : []);
      const release = { tag_name: repo === 'steipete/CodexBar' ? 'v0.73.0' : repo === 'nodejs/node' ? 'v26.11.0' : repo === 'moby/buildkit' ? 'v0.33.1' : repo === 'just-containers/s6-overlay' ? 'v3.2.3.2' : repo === 'cli/cli' ? 'v2.102.0' : repo === 'ogulcancelik/herdr' ? 'v0.9.3' : 'v2.1.292', name: 'release', body: repo === 'cli/cli' ? 'Fixes CVE-2026-12345.' : '', published_at: '2026-09-20T00:00:00.000Z', draft: false, prerelease: false, assets: [] };
      return response([release]);
    }
    if (target.hostname === 'tracker.debian.org') return response('<span><b>stable-sec:</b></span><a>154.0.8037.93-1~deb13u1</a><span class="news-date">2026-09-20</span><span class="news-title">Accepted chromium 154.0.8037.93-1~deb13u1 (source) into stable-security</span>');
    if (target.hostname === 'hub.docker.com') return response({ digest: 'sha256:fixture-digest', last_updated: '2026-09-20T00:00:00.000Z' });
    assert.fail(`unexpected upstream host: ${target.hostname}`);
  };

  const state = await createToolsCheck({
    dataDir,
    pinsFile,
    fetch,
    installed: {},
    now: () => new Date('2026-10-07T00:00:00.000Z'),
    mailbox: async (tool) => { posts.push({ id: tool.id, version: tool.latest, risk: tool.risk, ageDays: tool.ageDays }); },
  })();

  const expected = state.tools.filter((tool) => tool.risk === 'security' || (tool.risk === 'late' && tool.ageDays > 14));
  assert.deepEqual(posts.map(({ id, version, risk }) => [id, version, risk]), expected.map((tool) => [tool.id, tool.latest, tool.risk]));
  assert.ok(posts.length > 0);
});

test('tool Mailbox posts use stable per-tool-version keys and read actions', () => {
  const records = [];
  const messageStore = {
    mutate(change) {
      const result = change(records);
      records.splice(0, records.length, ...result.records);
      return result.result;
    },
  };
  const security = { id: 'gh', name: 'GitHub CLI', latest: '2.102.0', pinned: '2.101.0', risk: 'security', ageDays: 17 };
  const first = postToolUpdate(security, { messageStore, now: Date.parse('2026-10-07T00:00:00.000Z') });
  first.status = 'read';
  first.readAt = '2026-10-07T00:00:30.000Z';
  const duplicate = postToolUpdate(security, { messageStore, now: Date.parse('2026-10-07T00:01:00.000Z') });

  assert.equal(first.id, duplicate.id);
  assert.equal(duplicate.status, 'read');
  assert.equal(duplicate.readAt, '2026-10-07T00:00:30.000Z');
  assert.equal(records.length, 1);
  assert.equal(first.kind, 'report');
  assert.equal(first.action, 'read');
  assert.equal(Object.hasOwn(first, 'priority'), false);
  assert.equal(first.key, 'tools:gh:2.102.0');
  assert.match(first.title, /^Security: /);
  assert.match(first.text, /^Security release\./);

  const late = postToolUpdate({ id: 'opencode', name: 'OpenCode', latest: '1.18.35', pinned: '1.18.34', risk: 'late', ageDays: 17 }, { messageStore, now: Date.parse('2026-10-07T00:02:00.000Z') });
  assert.equal(late.action, 'read');
  assert.equal(late.title, 'Update: OpenCode 1.18.35');
  assert.equal(Object.hasOwn(late, 'priority'), false);

  postToolUpdate({ ...security, latest: '2.103.0' }, { messageStore, now: Date.parse('2026-10-07T00:03:00.000Z') });
  assert.equal(records.length, 3, 'a new tool version gets a new keyed item');
});
