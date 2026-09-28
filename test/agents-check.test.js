import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { agentsBlock, blockHash, checkAgentsFile, checkAgentsText, checkKitText, projectKit } from '../src/kit/agents-check.js';
import { runKitCommand } from '../src/kit/cli.js';
import { loadModels } from '../src/kit/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(ROOT, 'kit', 'templates', 'agents-stub.md');
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

test('a missing stub, a missing marker, and two blocks are errors', () => {
  only(check('# Project\nNo block.\n'), 'error', /no Herdr Boss stub/);
  only(check('# Project\n<!-- herdr-boss:end -->\n'), 'error', /no begin marker; run herdr-boss kit install/);
  const noEnd = `# Project\n<!-- herdr-boss:begin v=${current().hash} -->\nbody\n`;
  only(check(noEnd), 'error', /no end marker/);
  const twice = `${file()}\n${current().block}`;
  only(check(twice), 'error', /more than one block/);
});

test('a file without markers is an error that names kit install', () => {
  const findings = check('# Project\nNo stub.\n');
  only(findings, 'error', /no Herdr Boss stub; run herdr-boss kit install/);
  assert.equal(findings.filter((finding) => finding.level === 'error').length, 1);
});

test('an old full block between the markers is an error with run herdr-boss kit install', () => {
  const body = '## Herdr Boss orchestration\n\n' + Array.from({ length: 30 }, (_, i) => `- Rule ${i}.`).join('\n');
  const findings = check(`# Project\n<!-- herdr-boss:begin v=${blockHash(body)} -->\n${body}\n<!-- herdr-boss:end -->\n`);
  const hits = only(findings, 'error', /old full kit block.*run herdr-boss kit install/);
  assert.equal(hits[0].line, 2);
  assert.equal(findings.length, 1, JSON.stringify(findings));
});

test('an old block hash and a hand-edited block are errors', () => {
  const body = fs.readFileSync(TEMPLATE, 'utf8').replace(/\r\n/g, '\n').trimEnd();
  const old = `# Project\n<!-- herdr-boss:begin v=${blockHash('old body')} -->\nold body\n<!-- herdr-boss:end -->\n`;
  const oldFindings = check(old);
  only(oldFindings, 'error', /old kit stub; run herdr-boss kit install/);
  assert.ok(!oldFindings.some((finding) => /edited by hand/.test(finding.message)));
  assert.equal(oldFindings[0].line, 2);

  const edited = `# Project\n<!-- herdr-boss:begin v=${current().hash} -->\n${body}\n- A local extra rule.\n<!-- herdr-boss:end -->\n`;
  const editedFindings = check(edited);
  only(editedFindings, 'error', /edited by hand/);
  assert.ok(!editedFindings.some((finding) => /old kit stub/.test(finding.message)));
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
    ['Freeze starts 3. December.', /dated.*docs\/orchestration\/memory\.md/],
    ['Freeze starts 3 Mar.', /dated.*docs\/orchestration\/memory\.md/],
  ];
  for (const [line, pattern] of cases) {
    const findings = check(file(line));
    const hits = only(findings, 'warn', pattern);
    assert.equal(hits[0].line, 2, `line number for ${line}`);
    assert.ok(findings.every((finding) => finding.level === 'warn'), `only warnings for ${line}`);
  }
});

test('text that sends pushes or product decisions to the Boss or the Owner gives warnings', () => {
  const cases = [
    'Ask the Boss before each push.',
    'Pushes need Owner approval.',
    'Escalate product decisions to the Owner.',
    'Send human decisions to the Boss.',
    'Notify the other project orchestrators after a release.',
    'Tell another project when the API changes.',
    '- After a release, notify other projects.',
  ];
  for (const line of cases) {
    const findings = check(file(line));
    assert.equal(findings.length, 1, `${line}: ${JSON.stringify(findings)}`);
    assert.equal(findings[0].level, 'warn');
    assert.equal(findings[0].line, 2);
    assert.match(findings[0].message, /Boss|project/);
  }
  for (const line of [
    'Push `main` yourself after the release steps.',
    'Decide product details yourself. Do not ask the Boss about them.',
    'Do not message another project\'s orchestrator.',
    'Report to the Boss when a task is merged and live.',
    'The Boss decides when to tell the other projects.',
  ]) assert.deepEqual(check(file(line)), [], line);
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
  assert.deepEqual(check(file('Worker panes also open in the `Workers 2` and `Workers 3` tabs.')), []);
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

test('kit block prints the marked stub', () => {
  const lines = [];
  const result = runKitCommand('kit', ['block'], { output: (line) => lines.push(line) });
  assert.equal(lines.join('\n'), current().block.trimEnd());
  assert.equal(result.hash, current().hash);
});

test('the kit file check finds a missing file, an old revision, and a hand edit', () => {
  const kit = projectKit();
  assert.deepEqual(checkKitText(kit.text, kit.revision), []);
  only(checkKitText(null, kit.revision), 'error', /docs\/orchestration\/herdr-boss\.md is missing; run herdr-boss kit install/);
  only(checkKitText('# Kit\nbody\n', kit.revision), 'error', /no version line; run herdr-boss kit install/);
  const oldBody = 'old kit body';
  const old = `<!-- herdr-boss kit v=${blockHash(oldBody)} -->\nHerdr Boss writes this file. Do not edit it. Run herdr-boss kit install to update it.\n\n${oldBody}\n`;
  const oldFindings = checkKitText(old, kit.revision);
  only(oldFindings, 'error', /old kit revision .*; run herdr-boss kit install/);
  assert.ok(!oldFindings.some((finding) => /edited by hand/.test(finding.message)));
  const edited = `${kit.text}- A local rule.\n`;
  const editedFindings = checkKitText(edited, kit.revision);
  only(editedFindings, 'error', /edited by hand; run herdr-boss kit install/);
  assert.equal(editedFindings.length, 1);
});

test('check agents exits 0 for the current layout and 1 for a file without a stub', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-check-agents-'));
  const env = { ...process.env, HOME: dir, HERDR_BOSS_DIR: path.join(dir, 'boss'), TMPDIR: dir };
  const good = path.join(dir, 'good.md');
  const bad = path.join(dir, 'bad.md');
  fs.writeFileSync(good, file('Project rules.'));
  fs.writeFileSync(bad, '# Project\nNo block. Use pane w1:p2.\n');
  const cli = path.join(ROOT, 'src', 'cli.js');
  const noKit = spawnSync(process.execPath, [cli, 'check', 'agents', good], { env, encoding: 'utf8' });
  assert.equal(noKit.status, 1, noKit.stderr);
  assert.match(noKit.stdout, /^error line 1: docs\/orchestration\/herdr-boss\.md is missing; run herdr-boss kit install/m);
  fs.mkdirSync(path.join(dir, 'docs', 'orchestration'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'orchestration', 'herdr-boss.md'), projectKit().text);
  const ok = spawnSync(process.execPath, [cli, 'check', 'agents', good], { env, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /0 errors, 0 warnings/);
  const failed = spawnSync(process.execPath, [cli, 'check', 'agents', bad], { env, encoding: 'utf8' });
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stdout, /^error line 1: no Herdr Boss stub; run herdr-boss kit install/m);
  assert.match(failed.stdout, /^warn line 2: .*pane ID/m);
  assert.match(failed.stdout, /1 error, 1 warning/);

  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-check-repo-')));
  execFileSync('git', ['init', '-q', repo]);
  fs.mkdirSync(path.join(repo, 'sub'));
  fs.mkdirSync(path.join(repo, 'docs', 'orchestration'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'orchestration', 'herdr-boss.md'), projectKit().text);
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), file());
  const inRepo = spawnSync(process.execPath, [cli, 'check', 'agents'], { env, cwd: path.join(repo, 'sub'), encoding: 'utf8' });
  assert.equal(inRepo.status, 0, inRepo.stdout + inRepo.stderr);
  assert.match(inRepo.stdout, /AGENTS\.md/);
});

// A Git repository with the current kit file and AGENTS.md stub, and the extra files that orchestrators read.
function orchestrationRepo(files = {}) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-check-scan-')));
  execFileSync('git', ['init', '-q', repo]);
  const write = (relative, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true });
    fs.writeFileSync(path.join(repo, relative), text);
  };
  write('docs/orchestration/herdr-boss.md', projectKit().text);
  write('AGENTS.md', file());
  for (const [relative, text] of Object.entries(files)) write(relative, text);
  return repo;
}
function scan(repo) {
  const rulesFile = path.join(repo, 'no-rules.json');
  return checkAgentsFile(path.join(repo, 'AGENTS.md'), { rulesFile, relative: 'AGENTS.md' });
}

test('check agents scans the orchestration files in the Git top level', () => {
  const kinds = [
    'docs/agents/push.md',
    'docs/agents/deep/escalation.md',
    '.orchestration/rules.md',
    '.orchestration/notes/handoff-note.md',
    'OrchestratorPrompt.md',
    'my-orchestrator.md',
  ];
  const repo = orchestrationRepo(Object.fromEntries(kinds.map((relative) => [relative, '# Notes\n\nAsk the Boss before each push.\n'])));
  const result = scan(repo);
  assert.equal(result.errors, 0, JSON.stringify(result.findings));
  for (const relative of kinds) {
    const hits = result.findings.filter((finding) => finding.file === relative);
    assert.equal(hits.length, 1, `${relative}: ${JSON.stringify(result.findings)}`);
    assert.equal(hits[0].level, 'warn');
    assert.equal(hits[0].line, 3);
    assert.match(hits[0].message, /pushes or product decisions to the Boss/);
    assert.ok(result.lines.includes(`warn ${relative} line 3: ${hits[0].message}`), result.lines.join('\n'));
  }
  assert.equal(result.warnings, kinds.length);
});

test('the scanned files get the same warnings as the text outside the stub', () => {
  const text = [
    '# Rules',
    'Notify the other project orchestrators after a release.',
    'The Boss is in pane w12:p3.',
    'Owner accepted the layout on 2026-09-20.',
    'Use `claude-sonnet-9` for review.',
    'Run `pgrep -f vite` to find the server.',
    '- gpt-6-luna',
    '- gpt-6-sol',
    '- opencode/big-pickle',
  ].join('\n');
  const result = scan(orchestrationRepo({ 'docs/agents/rules.md': text }));
  const hits = result.findings.filter((finding) => finding.file === 'docs/agents/rules.md');
  for (const [line, pattern] of [
    [2, /notify another project/], [3, /fixed pane ID w12:p3/], [4, /dated line/], [5, /claude-sonnet-9.*not in the model list/],
    [6, /process command/], [7, /copied model list/],
  ]) assert.ok(hits.some((finding) => finding.line === line && pattern.test(finding.message)), `${line} ${pattern}: ${JSON.stringify(hits)}`);
  assert.ok(hits.every((finding) => finding.level === 'warn'));
});

test('a handoff note warns for each rule-like line', () => {
  const note = [
    '# Handoff',
    'Task V12 is half done.',
    'Always run the lint step.',
    '- Never merge on a Friday.',
    'Do not touch the parser.',
    '1. Must rebase first.',
    'Mustard is on the list.',
  ].join('\n');
  const result = scan(orchestrationRepo({ '.orchestration/handoff-note.md': note, '.orchestration/plan.md': 'Always run the lint step.\n' }));
  const handoff = result.findings.filter((finding) => finding.file === '.orchestration/handoff-note.md');
  assert.deepEqual(handoff.map((finding) => finding.line), [3, 4, 5, 6], JSON.stringify(handoff));
  for (const finding of handoff) assert.match(finding.message, /handoff note carries no rules/);
  assert.deepEqual(result.findings.filter((finding) => finding.file === '.orchestration/plan.md'), [], 'a rule in another file is not drift');
});

test('check agents does not scan memory.md, herdr-boss.md, or other files', () => {
  const drift = 'Ask the Boss before each push. The Boss is in pane w1:p2.\n';
  const repo = orchestrationRepo({
    'docs/orchestration/memory.md': drift,
    'docs/orchestration/notes.md': drift,
    'docs/agents/notes.txt': drift,
    '.orchestration/deep/plan.md': drift,
    'docs/Orchestrator.md': drift,
    'README.md': drift,
  });
  const result = scan(repo);
  assert.deepEqual(result.findings, []);
  fs.appendFileSync(path.join(repo, 'docs/orchestration/herdr-boss.md'), drift);
  const edited = scan(repo);
  assert.deepEqual(edited.findings.map((finding) => finding.message), ['docs/orchestration/herdr-boss.md was edited by hand; run herdr-boss kit install']);
});

test('publish counts the scanned files in agentsCheck.warnings, and errors stay with the stub and the kit file', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-publish-scan-')));
  const repo = orchestrationRepo({
    'docs/agents/push.md': 'Ask the Boss before each push.\n',
    '.orchestration/handoff.md': 'Never merge on a Friday.\nThe Boss is in pane w1:p2.\n',
  });
  const direct = scan(repo);
  assert.equal(direct.errors, 0);
  assert.equal(direct.warnings, 3, JSON.stringify(direct.findings));
  assert.equal(direct.summary, 'AGENTS.md: 0 errors, 3 warnings');
  const status = path.join(home, 'status.json');
  fs.writeFileSync(status, JSON.stringify({ project: 'Demo' }));
  const dataDir = path.join(home, 'boss');
  const env = { ...process.env, HOME: home, HERDR_BOSS_DIR: dataDir, TMPDIR: home };
  const result = spawnSync(process.execPath, [path.join(ROOT, 'src', 'cli.js'), 'publish', 'demo', status], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /warn \.orchestration\/handoff\.md line 2: .*pane ID/);
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'projects', 'demo.json'), 'utf8'));
  assert.equal(stored.agentsCheck.errors, 0);
  assert.equal(stored.agentsCheck.warnings, 3);
});

test('a decision line fires only when it routes the decision to the Boss, the Owner, a human, or the user', () => {
  for (const line of [
    'Ask the Owner about product decisions.',
    'Wait for the Boss to approve the push.',
    'Route release decisions to a human.',
    'Report product questions to the user.',
    'Get approval from the Boss for each release.',
  ]) {
    const findings = check(file(line));
    assert.equal(findings.length, 1, `${line}: ${JSON.stringify(findings)}`);
    assert.match(findings[0].message, /pushes or product decisions to the Boss/);
  }
  for (const line of [
    '1. Decide the order of the tasks.',
    '2. Decide the push order; the Boss can confirm the list later.',
    '- Push the branch, then release it.',
    'Release the lock when the Boss is idle.',
    'Never ask the Boss about product decisions.',
    "Don't send push decisions to the Owner.",
    'Report to the Boss when a task is merged and live.',
  ]) assert.deepEqual(check(file(line)), [], line);
});

test('check agents skips excluded globs, the state folder, and data files, and counts them in one summary line', () => {
  const drift = '# Log\n\n2026-09-20 tenant-a created. Ask the Boss before each push.\n';
  const repo = orchestrationRepo({
    '.herdr-boss.json': JSON.stringify({ checkAgents: { exclude: ['.orchestration/tenant-*.md', 'docs/agents/**/generated/*.md'] } }),
    '.orchestration/tenant-resources.md': drift,
    'docs/agents/deep/generated/list.md': drift,
    '.orchestration/state/handoff-live.md': drift,
    '.orchestration/log.md': `<!-- herdr-boss: data -->\n${drift}`,
    '.orchestration/marked-late.md': `# Log\n<!-- herdr-boss: data -->\n${drift}`,
    'docs/agents/push.md': drift,
  });
  const result = scan(repo);
  const files = [...new Set(result.findings.map((finding) => finding.file).filter(Boolean))].sort();
  assert.deepEqual(files, ['.orchestration/marked-late.md', 'docs/agents/push.md'], JSON.stringify(result.findings));
  assert.equal(result.skipped, 4);
  assert.equal(result.summary, 'AGENTS.md: 0 errors, 4 warnings; 4 files skipped');
  for (const name of ['tenant-resources', 'generated', 'state', 'log.md']) {
    assert.ok(!result.lines.some((line) => line.includes(name)), `${name} is not named: ${result.lines.join('\n')}`);
  }
  const clean = scan(orchestrationRepo({ 'docs/agents/push.md': drift }));
  assert.equal(clean.skipped, 0);
  assert.equal(clean.summary, 'AGENTS.md: 0 errors, 2 warnings');
});

test('check agents prints the skipped-file count in its summary line', () => {
  const repo = orchestrationRepo({ '.orchestration/log.md': '<!-- herdr-boss: data -->\n2026-09-20 row\n' });
  const out = spawnSync(process.execPath, [path.join(ROOT, 'src', 'cli.js'), 'check', 'agents'], { cwd: repo, encoding: 'utf8', env: { ...process.env, HERDR_BOSS_DIR: path.join(repo, 'boss') } });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^check agents: PASS \(AGENTS\.md: 0 errors, 0 warnings; 1 file skipped\)$/m);
  assert.doesNotMatch(out.stdout, /log\.md/);
});

test('an invalid checkAgents.exclude is an error finding, and the scan still runs', () => {
  const repo = orchestrationRepo({
    '.herdr-boss.json': JSON.stringify({ checkAgents: { exclude: ['../outside/*.md'] } }),
    'docs/agents/push.md': 'Ask the Boss before each push.\n',
  });
  const result = scan(repo);
  assert.equal(result.errors, 1, JSON.stringify(result.findings));
  assert.ok(result.findings.some((finding) => finding.level === 'error' && /\.herdr-boss\.json.*checkAgents\.exclude/.test(finding.message)), JSON.stringify(result.findings));
  assert.ok(result.findings.some((finding) => finding.file === 'docs/agents/push.md'));
});
