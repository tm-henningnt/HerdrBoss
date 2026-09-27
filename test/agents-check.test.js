import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { agentsBlock, blockHash, checkAgentsText } from '../src/kit/agents-check.js';
import { runKitCommand } from '../src/kit/cli.js';
import { loadModels } from '../src/kit/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(ROOT, 'kit', 'templates', 'agents-section.md');
const MODELS = Object.values(loadModels().kinds).flatMap((kind) => kind.allowedModels);

function current() { return agentsBlock(); }
function check(text, options = {}) { return checkAgentsText(text, { hash: current().hash, models: MODELS, ...options }); }
function file(before = '', after = '') { return `# Project\n${before}\n${current().block}\n${after}`; }
function only(findings, level, pattern) {
  const hits = findings.filter((finding) => finding.level === level && pattern.test(finding.message));
  assert.ok(hits.length >= 1, `expected ${level} ${pattern} in ${JSON.stringify(findings)}`);
  return hits;
}

test('the block hash is the first 12 hex characters of the normalized template SHA-256', async () => {
  const { createHash } = await import('node:crypto');
  const body = fs.readFileSync(TEMPLATE, 'utf8').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trimEnd();
  const expected = createHash('sha256').update(body).digest('hex').slice(0, 12);
  const { hash, block } = current();
  assert.equal(hash, expected);
  assert.equal(blockHash(`${body.replace(/\n/g, '\r\n')}  \r\n\r\n`), expected, 'CRLF and trailing whitespace do not change the hash');
  assert.ok(block.startsWith(`<!-- herdr-boss:begin v=${hash} -->\n${body}\n<!-- herdr-boss:end -->`));
});

test('a file with the current block and clean project text has no findings', () => {
  assert.deepEqual(check(file('Project rules go here.', 'Run `npm test` before a merge.')), []);
});

test('a missing block, a missing end marker, and two blocks are errors', () => {
  only(check('# Project\nNo block.\n'), 'error', /no begin marker/);
  only(check('# Project\nNo block.\n'), 'error', /no end marker/);
  const noEnd = `# Project\n<!-- herdr-boss:begin v=${current().hash} -->\nbody\n`;
  only(check(noEnd), 'error', /no end marker/);
  const twice = `${file()}\n${current().block}`;
  only(check(twice), 'error', /more than one block/);
});

test('an old block hash and a hand-edited block are errors', () => {
  const body = fs.readFileSync(TEMPLATE, 'utf8').replace(/\r\n/g, '\n').trimEnd();
  const old = `# Project\n<!-- herdr-boss:begin v=${blockHash('old body')} -->\nold body\n<!-- herdr-boss:end -->\n`;
  const oldFindings = check(old);
  only(oldFindings, 'error', /old kit block; run herdr-boss kit block/);
  assert.ok(!oldFindings.some((finding) => /edited by hand/.test(finding.message)));
  assert.equal(oldFindings[0].line, 2);

  const edited = `# Project\n<!-- herdr-boss:begin v=${current().hash} -->\n${body}\n- A local extra rule.\n<!-- herdr-boss:end -->\n`;
  const editedFindings = check(edited);
  only(editedFindings, 'error', /edited by hand/);
  assert.ok(!editedFindings.some((finding) => /old kit block/.test(finding.message)));
});

test('stale orchestration text outside the block gives warnings', () => {
  const cases = [
    ['Run `herdr agent start worker-a` for a worker.', /herdr agent start/],
    ['Use `herdr pane split` for a new pane.', /herdr pane split/],
    ['Run `npm run dashboard:update` after each task.', /dashboard:update/],
    ['Attach to Chrome on port 9222.', /9222/],
    ['Run `pgrep -f vite` to find the server.', /process/],
    ['Run `ps aux | grep node` to check.', /process/],
    ['The Boss is in pane w12:p3.', /pane ID.*docs\/orchestration\/memory\.md/],
    ['Owner accepted the layout on 2026-09-20.', /dated.*docs\/orchestration\/memory\.md/],
    ['Freeze starts 26 Sept.', /dated.*docs\/orchestration\/memory\.md/],
  ];
  for (const [line, pattern] of cases) {
    const findings = check(file(line));
    const hits = only(findings, 'warn', pattern);
    assert.equal(hits[0].line, 2, `line number for ${line}`);
    assert.ok(findings.every((finding) => finding.level === 'warn'), `only warnings for ${line}`);
  }
});

test('a prohibition line for port 9222 or a process command is not drift', () => {
  assert.deepEqual(check(file('- Never touch the Chrome on port 9222.')), []);
  assert.deepEqual(check(file('- Do not use `ps aux` with the output printed.')), []);
  const hits = only(check(file('- Use the Chrome on port 9222.')), 'warn', /port 9222/);
  assert.equal(hits[0].line, 2);
});

test('the shared Workers tab is not drift', () => {
  assert.deepEqual(check(file('Workers run as panes in the shared `Workers` tab.')), []);
  assert.deepEqual(check(file('Open workers in the Workers tab.')), []);
});

test('stale text inside the block does not give warnings', () => {
  const body = 'Run `herdr agent start x` in w1:p2 on 2026-01-01 with port 9222.';
  const text = `<!-- herdr-boss:begin v=${blockHash(body)} -->\n${body}\n<!-- herdr-boss:end -->\n`;
  assert.deepEqual(check(text, { hash: blockHash(body) }), []);
});

test('an unknown model ID and a copied model list give warnings', () => {
  const unknown = check(file('Use `claude-sonnet-9` for review.'));
  only(unknown, 'warn', /claude-sonnet-9.*not in the model list/);
  assert.deepEqual(check(file('Use `gpt-6-luna` for review.')), [], 'one allowed model is not a copied list');
  assert.deepEqual(check(file('Use claude-code and the claude-api skill.')), [], 'a word without a version is not a model');

  const copied = check(file('- gpt-6-luna\n- gpt-6-sol\n- opencode/big-pickle'));
  const hits = only(copied, 'warn', /copied model list.*herdr-boss models.*herdr-boss lanes/);
  assert.equal(hits[0].line, 2);

  const extra = check(file('Use `opencode-go/glm-5.2`.'), { models: [...MODELS, 'opencode-go/glm-5.2'] });
  assert.deepEqual(extra, [], 'a policy extra model is known');
});

test('the models command marks policy extra models in localModels', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-local-models-'));
  const rulesFile = path.join(dir, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({ policy: { extraModels: { claude: ['claude-sonnet-5'], pi: ['opencode-go/deepseek-v4.1-flash'] } } }));
  const result = runKitCommand('models', [], { output: () => {}, rulesFile });
  assert.deepEqual(result.claude.localModels, ['claude-sonnet-5']);
  assert.ok(result.claude.allowedModels.includes('claude-sonnet-5'));
  assert.equal(result.claude.defaultModel, loadModels().kinds.claude.defaultModel);
  assert.ok(!('localModels' in result.pi), 'a model that kit/models.json already lists is not local');
  assert.ok(!('localModels' in result.codex));
});

test('kit block prints the marked block', () => {
  const lines = [];
  const result = runKitCommand('kit', ['block'], { output: (line) => lines.push(line) });
  assert.equal(lines.join('\n'), current().block.trimEnd());
  assert.equal(result.hash, current().hash);
});

test('check agents exits 0 for a current block and 1 for a file without a block', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-check-agents-'));
  const env = { ...process.env, HOME: dir, HERDR_BOSS_DIR: path.join(dir, 'boss'), TMPDIR: dir };
  const good = path.join(dir, 'good.md');
  const bad = path.join(dir, 'bad.md');
  fs.writeFileSync(good, file('Project rules.'));
  fs.writeFileSync(bad, '# Project\nNo block. Use pane w1:p2.\n');
  const cli = path.join(ROOT, 'src', 'cli.js');
  const ok = spawnSync(process.execPath, [cli, 'check', 'agents', good], { env, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /0 errors, 0 warnings/);
  const failed = spawnSync(process.execPath, [cli, 'check', 'agents', bad], { env, encoding: 'utf8' });
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stdout, /^error line 1: no begin marker/m);
  assert.match(failed.stdout, /^warn line 2: .*pane ID/m);
  assert.match(failed.stdout, /2 errors, 1 warning/);

  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-check-repo-')));
  execFileSync('git', ['init', '-q', repo]);
  fs.mkdirSync(path.join(repo, 'sub'));
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), file());
  const inRepo = spawnSync(process.execPath, [cli, 'check', 'agents'], { env, cwd: path.join(repo, 'sub'), encoding: 'utf8' });
  assert.equal(inRepo.status, 0, inRepo.stderr);
  assert.match(inRepo.stdout, /AGENTS\.md/);
});
