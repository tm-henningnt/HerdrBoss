import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// All logs below are fixtures in a temporary HOME. The real harness logs are never read.
const ROOT = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'herdr-denials-'));
process.env.HERDR_BOSS_DIR = path.join(ROOT, 'boss');
fs.mkdirSync(process.env.HERDR_BOSS_DIR, { recursive: true });
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));
const {
  parseClaudeLine, parseCodexLine, parseOpenCodeLine, parsePiLine, guardCause, projectFor, projectForPiFolder,
  scanDenialLogs, mergeDenials, readDenials, saveDenials, runDenialScan, denialSummary, DISCUSS_NOTE,
} = await import('../src/denials.js');
const { Engine } = await import('../src/engine.js');
const { renderBulletin } = await import('../src/rules.js');

const SECRET = 'sk-fixture-SECRET-9f8e7d';
const NOW = Date.parse('2026-09-28T12:00:00Z');
const MIN = 60 * 1000;
const DAY = 86400 * 1000;
const REPOS = [{ slug: 'herdrboss', repo: '/work/HerdrBoss' }, { slug: 'shop', repo: '/work/Shop' }];

let homeCount = 0;
function newHome() {
  const home = path.join(ROOT, `home-${homeCount += 1}`);
  fs.mkdirSync(home, { recursive: true });
  return home;
}
function writeLines(file, lines, flag = 'w') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n', { flag });
}
const iso = (ms) => new Date(ms).toISOString();

function claudeDenial(reason, cwd, at = NOW) {
  return {
    type: 'user', cwd, timestamp: iso(at), toolDenialKind: 'automode-blocked',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: `Permission for this action was denied by the Claude Code auto mode classifier. Reason: [${reason}]. If you have other tasks ${SECRET}` }] },
  };
}
function codexOutput(text, at = NOW, exitMarker = null) {
  const output = exitMarker ? `${text}\n${exitMarker}` : text;
  return { timestamp: iso(at), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output } };
}
function codexMeta(cwd, at = NOW) {
  return { timestamp: iso(at), type: 'session_meta', payload: { cwd, id: 's1' } };
}
function codexCall(input, at = NOW) {
  return { timestamp: iso(at), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input } };
}
const ocAsk = (id, type, run, at) => `INFO  ${iso(at)} +1ms service=permission id=${id} permission=${type} patterns=["cat ${SECRET}", "ls"] run=${run} timestamp=${iso(at)} message=asking`;
const ocReply = (id, run, at) => `INFO  ${iso(at)} +1ms service=permission requestID=${id} reply=once run=${run} timestamp=${iso(at)} message=replied`;
const ocCwd = (run, cwd, at) => `INFO  ${iso(at)} +0ms service=session run=${run} cwd=${cwd} timestamp=${iso(at)} message=created`;
function piGuard(reason, at = NOW) {
  return { type: 'message', timestamp: iso(at), message: { role: 'toolResult', toolName: 'bash', isError: true, content: [{ type: 'text', text: reason }] } };
}
const total = (records, cause) => records.filter((r) => !cause || r.cause === cause).reduce((n, r) => n + r.count, 0);

test('Claude parser counts a classifier denial with its reason and ignores quoted text', () => {
  assert.deepEqual(parseClaudeLine(JSON.stringify(claudeDenial('Credential Exploration', '/work/Shop'))), [{ at: NOW, cause: 'classifier:Credential Exploration', cwd: '/work/Shop' }]);
  assert.deepEqual(parseClaudeLine(JSON.stringify(claudeDenial('Sandbox (safe mode)', '/work/Shop'))), [{ at: NOW, cause: 'classifier:Sandbox (safe mode)', cwd: '/work/Shop' }]);
  // A tool result that only quotes the phrase, such as grep output, is not a denial.
  const quoted = { type: 'user', cwd: '/w', timestamp: iso(NOW), message: { content: [{ type: 'tool_result', content: 'match: denied by the Claude Code auto mode classifier. Reason: [Git Destructive]' }] } };
  assert.deepEqual(parseClaudeLine(JSON.stringify(quoted)), []);
  assert.deepEqual(parseClaudeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: [X]' }] } })), []);
  assert.deepEqual(parseClaudeLine('not json'), []);
});

test('Codex parser counts sandbox causes only for failed outputs and escalation requests per call', () => {
  const ctx = {};
  assert.deepEqual(parseCodexLine(JSON.stringify(codexMeta('/work/HerdrBoss-wt-a')), ctx), []);
  assert.equal(ctx.cwd, '/work/HerdrBoss-wt-a');
  assert.deepEqual(parseCodexLine(JSON.stringify(codexOutput('grep hit: EPERM', NOW, 'Exit code: 0')), ctx), []);
  assert.deepEqual(parseCodexLine(JSON.stringify(codexOutput('EPERM with no exit status')), ctx), []);
  const events = [
    ...parseCodexLine(JSON.stringify(codexOutput('EPERM: x\nEPERM again', NOW, 'Exit code: 1')), ctx),
    ...parseCodexLine(JSON.stringify(codexOutput('Operation not permitted', NOW, 'Process exited with code 1')), ctx),
    ...parseCodexLine(JSON.stringify({ ...codexOutput({ stderr: `Permission denied ${SECRET}`, exit_code: 2 }), timestamp: iso(NOW) }), ctx),
  ];
  assert.deepEqual(events.map((e) => e.cause).sort(), ['sandbox:eperm', 'sandbox:not-permitted', 'sandbox:permission-denied']);
  assert.ok(events.every((e) => e.cwd === '/work/HerdrBoss-wt-a' && e.at === NOW));
  assert.deepEqual(parseCodexLine(JSON.stringify(codexOutput(`Permission denied and Operation not permitted; EPERM ${SECRET}`, NOW, 'Exit code: 2')), ctx).map((e) => e.cause), ['sandbox:eperm']);
  assert.deepEqual(parseCodexLine(JSON.stringify(codexOutput({ stderr: 'Mach port bootstrap_look_up failed (1100)', exit_code: 1 })), ctx).map((e) => e.cause), ['sandbox:mach-port']);
  const metadataOutput = { type: 'response_item', payload: { type: 'function_call_output', output: JSON.stringify({ output: 'EPERM', metadata: { exit_code: 1 } }) } };
  assert.deepEqual(parseCodexLine(JSON.stringify(metadataOutput), ctx).map((e) => e.cause), ['sandbox:eperm']);
  const escalation = parseCodexLine(JSON.stringify(codexCall(`await tools.exec_command({ cmd: "git push", sandbox_permissions: "require_escalated", justification: "${SECRET}" })`)), ctx);
  assert.deepEqual(escalation.map((e) => e.cause), ['escalation:request']);
  const fnCall = { timestamp: iso(NOW), type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['ls'], sandbox_permissions: 'require_escalated' }) } };
  assert.deepEqual(parseCodexLine(JSON.stringify(fnCall), ctx).map((e) => e.cause), ['escalation:request']);
  assert.deepEqual(parseCodexLine(JSON.stringify(codexCall('ls -la')), ctx), []);
});

test('OpenCode parser reads the permission fields without the patterns', () => {
  const ask = parseOpenCodeLine(ocAsk('per_1', 'bash', 'r1', NOW));
  assert.equal(ask.message, 'asking');
  assert.equal(ask.id, 'per_1');
  assert.equal(ask.type, 'bash');
  assert.equal(ask.run, 'r1');
  assert.equal(ask.at, NOW);
  assert.equal(JSON.stringify(ask).includes(SECRET), false);
  assert.equal(parseOpenCodeLine(ocReply('per_1', 'r1', NOW)).requestID, 'per_1');
  assert.equal(parseOpenCodeLine(ocCwd('r1', '/work/Shop', NOW)).cwd, '/work/Shop');
});

test('Pi parser counts Herdr guard blocks by reason class', () => {
  assert.equal(guardCause('Herdr guard: /etc/x is outside the worktree. Work only in /w.'), 'guard:outside-worktree');
  assert.equal(guardCause('Herdr guard: ~/.ssh/id is a protected path.'), 'guard:protected-path');
  assert.equal(guardCause('Herdr guard: rm -rf outside the temporary directories (/x). Ask your orchestrator.'), 'guard:rm-rf');
  assert.equal(guardCause('Herdr guard: git push is not allowed for a worker. Ask your orchestrator.'), 'guard:denied-command');
  assert.equal(guardCause(`Herdr guard: ${SECRET} something new`), 'guard:other');
  assert.deepEqual(parsePiLine(JSON.stringify(piGuard('Herdr guard: /x is a protected path.'))), [{ at: NOW, cause: 'guard:protected-path' }]);
  assert.deepEqual(parsePiLine(JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Herdr guard: /x is a protected path.' }] } })), []);
});

test('project attribution maps the repository and its worktree siblings to the slug', () => {
  assert.equal(projectFor('/work/HerdrBoss', REPOS), 'herdrboss');
  assert.equal(projectFor('/work/HerdrBoss/src/x', REPOS), 'herdrboss');
  assert.equal(projectFor('/work/HerdrBoss-wt-v24denials/src', REPOS), 'herdrboss');
  assert.equal(projectFor('/work/HerdrBossOther', REPOS), 'other');
  assert.equal(projectFor('/work/HerdrBoss-copy', REPOS), 'other');
  assert.equal(projectFor('/elsewhere', REPOS), 'other');
  assert.equal(projectFor(undefined, REPOS), 'other');
  assert.equal(projectForPiFolder('--work-HerdrBoss--', REPOS), 'herdrboss');
  assert.equal(projectForPiFolder('--work-HerdrBoss-wt-fix--', REPOS), 'herdrboss');
  assert.equal(projectForPiFolder('--work-Shop-sub--', REPOS), 'shop');
  assert.equal(projectForPiFolder('--work-Else--', REPOS), 'other');
});

test('project attribution maps a worktree under the shared parent folder to the slug', () => {
  const home = '/home/u';
  const shared = '/home/u/Projects/.herdr-wt';
  assert.equal(projectFor(`${shared}/HerdrBoss/v22wtparent`, REPOS, home), 'herdrboss');
  assert.equal(projectFor(`${shared}/HerdrBoss/v22wtparent/src/x`, REPOS, home), 'herdrboss');
  assert.equal(projectFor(`${shared}/Shop/fix`, REPOS, home), 'shop');
  assert.equal(projectFor(`${shared}/HerdrBossOther/fix`, REPOS, home), 'other');
  assert.equal(projectFor(`${shared}/HerdrBoss`, REPOS, home), 'other');
  assert.equal(projectFor(`${shared}/Else/fix`, REPOS, home), 'other');
  assert.equal(projectFor('/work/HerdrBoss-wt-old/src', REPOS, home), 'herdrboss');
  assert.equal(projectForPiFolder('--home-u-Projects-.herdr-wt-HerdrBoss-fix--', REPOS, home), 'herdrboss');
  assert.equal(projectForPiFolder('--home-u-Projects-.herdr-wt-Shop-fix--', REPOS, home), 'shop');
  assert.equal(projectForPiFolder('--home-u-Projects-.herdr-wt-Else-fix--', REPOS, home), 'other');
});

test('a scan attributes a denial in a shared-parent worktree to its project', () => {
  const home = newHome();
  writeLines(path.join(home, '.claude/projects/-x/s1.jsonl'), [claudeDenial('Git Destructive', path.join(home, 'Projects', '.herdr-wt', 'Shop', 'w1'))]);
  const result = runDenialScan({ home, dataDir: path.join(home, 'boss'), repos: REPOS, now: NOW, write: false });
  assert.deepEqual(result.records.map((r) => [r.harness, r.project]), [['claude', 'shop']]);
});

test('a scan of all four sources stores counts by day, harness, cause, and project', () => {
  const home = newHome();
  writeLines(path.join(home, '.claude/projects/-work-Shop/s1.jsonl'), [claudeDenial('Instruction Poisoning', '/work/Shop'), claudeDenial('Instruction Poisoning', '/work/Shop'), claudeDenial('Git Destructive', '/work/HerdrBoss-wt-x')]);
  writeLines(path.join(home, '.codex/sessions/2026/09/28/rollout-a.jsonl'), [codexMeta('/work/HerdrBoss'), codexOutput('EPERM', NOW, 'Exit code: 1'), codexOutput('Operation not permitted', NOW, 'Exit code: 1'), codexCall('x({ sandbox_permissions: "require_escalated" })')]);
  writeLines(path.join(home, '.local/share/opencode/log/opencode.log'), [
    ocCwd('r1', '/work/Shop', NOW - 30 * MIN),
    ocAsk('per_1', 'bash', 'r1', NOW - 25 * MIN), ocReply('per_1', 'r1', NOW - 24 * MIN),
    ocAsk('per_2', 'edit', 'r1', NOW - 20 * MIN),
    ocAsk('per_3', 'bash', 'r1', NOW - 2 * MIN),
  ]);
  writeLines(path.join(home, '.pi/agent/sessions/--work-HerdrBoss--/p.jsonl'), [piGuard('Herdr guard: /x is outside the worktree. Work only in /w.')]);
  const result = scanDenialLogs({ home, state: {}, now: NOW, repos: REPOS });
  const find = (harness, cause, project) => result.records.find((r) => r.harness === harness && r.cause === cause && r.project === project)?.count;
  assert.equal(find('claude', 'classifier:Instruction Poisoning', 'shop'), 2);
  assert.equal(find('claude', 'classifier:Git Destructive', 'herdrboss'), 1);
  assert.equal(find('codex', 'sandbox:eperm', 'herdrboss'), 1);
  assert.equal(find('codex', 'sandbox:not-permitted', 'herdrboss'), 1);
  assert.equal(find('codex', 'escalation:request', 'herdrboss'), 1);
  // per_1 got a reply, per_2 got none within 10 minutes, and per_3 is still inside its 10 minutes.
  assert.equal(find('opencode', 'permission:asked:bash', 'shop'), 1);
  assert.equal(find('opencode', 'permission:asked:edit', 'shop'), 1);
  assert.equal(find('opencode', 'permission:unanswered:edit', 'shop'), 1);
  assert.equal(find('opencode', 'permission:unanswered:bash', 'shop'), undefined);
  assert.equal(find('pi', 'guard:outside-worktree', 'herdrboss'), 1);
  assert.ok(result.records.every((r) => r.day === '2026-09-28'));

  // After 10 more minutes without a reply, per_3 counts as asked and unanswered.
  const later = scanDenialLogs({ home, state: result.state, now: NOW + 10 * MIN, repos: REPOS });
  assert.deepEqual(later.records.filter((r) => r.harness === 'opencode').map((r) => [r.cause, r.count]).sort(), [['permission:asked:bash', 1], ['permission:unanswered:bash', 1]]);
  assert.equal(total(later.records.filter((r) => r.harness !== 'opencode')), 0);
});

test('a reply that comes after 10 minutes still leaves the request unanswered', () => {
  const home = newHome();
  writeLines(path.join(home, '.local/share/opencode/log/opencode.log'), [ocAsk('per_9', 'bash', 'r9', NOW - 30 * MIN), ocReply('per_9', 'r9', NOW - 15 * MIN)]);
  const result = scanDenialLogs({ home, state: {}, now: NOW, repos: REPOS });
  assert.equal(total(result.records, 'permission:unanswered:bash'), 1);
  assert.equal(result.records.find((r) => r.cause === 'permission:unanswered:bash').project, 'other');
});

test('the scan is incremental and restarts a rotated or shorter file at 0', () => {
  const home = newHome();
  const file = path.join(home, '.claude/projects/-work-Shop/s.jsonl');
  writeLines(file, [claudeDenial('A', '/work/Shop'), claudeDenial('A', '/work/Shop')]);
  const first = scanDenialLogs({ home, state: {}, now: NOW, repos: REPOS });
  assert.equal(total(first.records), 2);
  const second = scanDenialLogs({ home, state: first.state, now: NOW, repos: REPOS });
  assert.equal(total(second.records), 0);
  assert.equal(second.bytes, 0);
  writeLines(file, [claudeDenial('B', '/work/Shop')], 'a');
  const third = scanDenialLogs({ home, state: second.state, now: NOW, repos: REPOS });
  assert.deepEqual(third.records.map((r) => [r.cause, r.count]), [['classifier:B', 1]]);
  // A partial line at the end waits for its newline.
  fs.appendFileSync(file, JSON.stringify(claudeDenial('C', '/work/Shop')));
  const partial = scanDenialLogs({ home, state: third.state, now: NOW, repos: REPOS });
  assert.equal(total(partial.records), 0);
  fs.appendFileSync(file, '\n');
  assert.equal(total(scanDenialLogs({ home, state: partial.state, now: NOW, repos: REPOS }).records, 'classifier:C'), 1);
  // Rotation: a new file with the same name and new content.
  const before = scanDenialLogs({ home, state: partial.state, now: NOW, repos: REPOS }).state;
  fs.rmSync(file);
  writeLines(file, [claudeDenial('D', '/work/Shop')]);
  assert.equal(total(scanDenialLogs({ home, state: before, now: NOW, repos: REPOS }).records, 'classifier:D'), 1);
  // Truncation in place: the file is shorter than the saved offset.
  const log = path.join(home, '.local/share/opencode/log/opencode.log');
  writeLines(log, [ocCwd('r1', '/work/Shop', NOW), ocCwd('r1', '/work/Shop', NOW), ocAsk('per_a', 'bash', 'r1', NOW - 20 * MIN)]);
  const oc = scanDenialLogs({ home, state: {}, now: NOW, repos: REPOS });
  assert.equal(total(oc.records, 'permission:unanswered:bash'), 1);
  fs.truncateSync(log, 0);
  writeLines(log, [ocAsk('per_b', 'read', 'r2', NOW - 20 * MIN)], 'a');
  assert.equal(total(scanDenialLogs({ home, state: oc.state, now: NOW, repos: REPOS }).records, 'permission:unanswered:read'), 1);
});

test('Codex keeps the session cwd across incremental reads', () => {
  const home = newHome();
  const file = path.join(home, '.codex/sessions/2026/09/28/rollout-b.jsonl');
  writeLines(file, [codexMeta('/work/Shop')]);
  const first = scanDenialLogs({ home, state: {}, now: NOW, repos: REPOS });
  writeLines(file, [codexOutput('EPERM', NOW, 'Exit code: 1')], 'a');
  const second = scanDenialLogs({ home, state: first.state, now: NOW, repos: REPOS });
  assert.deepEqual(second.records.map((r) => [r.cause, r.project]), [['sandbox:eperm', 'shop']]);
});

test('one run reads at most the byte budget and the next run continues', () => {
  const home = newHome();
  const lines = Array.from({ length: 40 }, () => claudeDenial('Budget', '/work/Shop'));
  writeLines(path.join(home, '.claude/projects/-work-Shop/a.jsonl'), lines);
  writeLines(path.join(home, '.claude/projects/-work-Shop/b.jsonl'), lines);
  const size = fs.statSync(path.join(home, '.claude/projects/-work-Shop/a.jsonl')).size;
  const budgetBytes = Math.floor(size * 0.75);
  let state = {};
  let seen = 0;
  let runs = 0;
  for (;;) {
    const result = scanDenialLogs({ home, state, now: NOW, repos: REPOS, budgetBytes });
    assert.ok(result.bytes <= budgetBytes, `read ${result.bytes} bytes with a budget of ${budgetBytes}`);
    seen += total(result.records);
    state = result.state;
    runs += 1;
    if (!result.bytes) break;
  }
  assert.equal(seen, 80);
  assert.ok(runs >= 4);
});

test('the default budget is 20 MB per run', () => {
  const home = newHome();
  const file = path.join(home, '.local/share/opencode/log/opencode.log');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = `INFO  ${iso(NOW)} +0ms service=noise run=r1 message=${'x'.repeat(1000)}\n`;
  fs.writeFileSync(file, line.repeat(Math.ceil((21 * 1024 * 1024) / line.length)));
  const result = scanDenialLogs({ home, state: {}, now: NOW, repos: REPOS });
  assert.ok(result.bytes <= 20 * 1024 * 1024);
  assert.ok(result.bytes > 19 * 1024 * 1024);
});

test('stored records and scan state hold no text fields', () => {
  const home = newHome();
  const dataDir = path.join(ROOT, 'data-text');
  writeLines(path.join(home, '.claude/projects/-work-Shop/s1.jsonl'), [claudeDenial(`Evil ${SECRET}`, '/work/Shop'), claudeDenial('Credential Exploration', '/work/Shop')]);
  writeLines(path.join(home, '.codex/sessions/2026/09/28/r.jsonl'), [codexMeta('/work/Shop'), codexOutput(`EPERM ${SECRET}`, NOW, 'Exit code: 1')]);
  writeLines(path.join(home, '.local/share/opencode/log/opencode.log'), [ocAsk('per_1', `bash${SECRET}`, 'r1', NOW - 20 * MIN)]);
  writeLines(path.join(home, '.pi/agent/sessions/--work-Shop--/p.jsonl'), [piGuard(`Herdr guard: ${SECRET} is outside the worktree.`)]);
  const result = runDenialScan({ home, dataDir, state: {}, now: NOW, repos: REPOS });
  const stored = readDenials(dataDir);
  assert.ok(stored.length >= 4);
  for (const r of stored) {
    assert.deepEqual(Object.keys(r).sort(), ['cause', 'count', 'day', 'harness', 'project']);
    assert.equal(typeof r.count, 'number');
    assert.match(r.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(r.cause, /^[a-z]+:[A-Za-z0-9 :-]{1,80}$/);
  }
  const text = fs.readFileSync(path.join(dataDir, 'denials.json'), 'utf8');
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes('/work'), false);
  assert.equal(JSON.stringify(result.state).includes(SECRET), false);
  assert.equal(fs.statSync(path.join(dataDir, 'denials.json')).mode & 0o777, 0o600);
  // A reason with a secret is dropped to a generic class; a bad permission type too.
  assert.ok(stored.some((r) => r.cause === 'classifier:other'));
  assert.ok(stored.some((r) => r.cause === 'permission:unanswered:other'));
});

test('records older than 30 days are pruned and counts merge by key', () => {
  const day = (n) => new Date(NOW - n * DAY).toISOString().slice(0, 10);
  const base = { harness: 'codex', cause: 'sandbox:eperm', project: 'shop' };
  const merged = mergeDenials([{ ...base, day: day(31), count: 5 }, { ...base, day: day(29), count: 2 }, { ...base, day: day(0), count: 1 }], [{ ...base, day: day(0), count: 3 }], NOW);
  assert.deepEqual(merged.map((r) => [r.day, r.count]).sort(), [[day(29), 2], [day(0), 4]]);
  const dataDir = path.join(ROOT, 'data-prune');
  saveDenials(dataDir, merged);
  assert.deepEqual(readDenials(dataDir), merged);
});

test('the trend rule flags a cause above 2 times its 6-day mean and above 10 a day', () => {
  const day = (n) => new Date(NOW - n * DAY).toISOString().slice(0, 10);
  const rec = (n, cause, count, project = 'shop') => ({ day: day(n), harness: 'claude', cause, project, count });
  const records = [
    // Rising: 25 today against a mean of 2 in the 6 days before the last 24 hours.
    ...[2, 3, 4, 5, 6, 7].map((n) => rec(n, 'classifier:Rise', 2)), rec(0, 'classifier:Rise', 20), rec(0, 'classifier:Rise', 5, 'herdrboss'),
    // Not above 2 times the mean: 15 against a mean of 10.
    ...[2, 3, 4, 5, 6, 7].map((n) => rec(n, 'classifier:Steady', 10)), rec(0, 'classifier:Steady', 15),
    // Not above 10 a day: 8 against a mean of 0.
    rec(0, 'classifier:Small', 8),
  ];
  const summary = denialSummary(records, NOW);
  const cause = (name) => summary.causes.find((c) => c.cause === name);
  assert.equal(cause('classifier:Rise').rising, true);
  assert.equal(cause('classifier:Rise').trend, 'up');
  assert.equal(cause('classifier:Steady').rising, false);
  assert.equal(cause('classifier:Small').rising, false);
  assert.deepEqual(summary.rising.map((c) => c.cause), ['classifier:Rise']);
  assert.equal(summary.note, DISCUSS_NOTE);
  assert.equal(DISCUSS_NOTE, 'Discuss this trend with the Boss.');
  assert.equal(summary.days.length, 7);
  assert.equal(summary.days[6], day(0));
  const row = summary.rows.find((r) => r.cause === 'classifier:Rise' && r.project === 'shop');
  assert.equal(row.counts[6], 20);
  assert.equal(row.total, 20 + 2 * 5);
  assert.equal(summary.harnessTotals.claude, 25 + 10 + 15 + 50 + 8);
  assert.equal(denialSummary([], NOW).note, null);
});

test('the bulletin puts the note in the Owner section and in no project rules', () => {
  const day = new Date(NOW).toISOString().slice(0, 10);
  const denials = denialSummary([{ day, harness: 'codex', cause: 'sandbox:eperm', project: 'shop', count: 40 }], NOW);
  const snap = { updatedAt: iso(NOW), quotas: [{ provider: 'codex', windows: [] }], denials };
  const text = renderBulletin(snap, { alerts: [], advice: [] }, { port: 4477 });
  const owner = text.split('## Owner')[1];
  assert.ok(owner, 'the bulletin has an Owner section');
  assert.match(owner, /sandbox:eperm/);
  assert.match(owner, /Discuss this trend with the Boss\./);
  assert.equal(text.split('## Owner')[0].includes(DISCUSS_NOTE), false);
  assert.equal(renderBulletin({ ...snap, denials: denialSummary([], NOW) }, { alerts: [], advice: [] }, { port: 4477 }).includes('## Owner'), false);
});

test('the engine scan runs at most every 15 minutes, never twice at once, and prompts no pane', async () => {
  const prompts = [];
  let calls = 0;
  let release;
  const scanDenialLogs = () => { calls += 1; return new Promise((resolve) => { release = () => resolve({ state: { files: {} }, records: [], bytes: 0 }); }); };
  const engine = new Engine({ push: false, browsers: {} }, { push: false, act: false, collectors: { runDenialScan: scanDenialLogs }, herdrRunner: async (...args) => { prompts.push(args); return ''; } });
  const t0 = NOW;
  const running = engine.scanDenials(t0);
  assert.ok(running);
  assert.equal(engine.scanDenials(t0 + 20 * MIN), null, 'no second scan while one runs');
  release();
  await running;
  assert.equal(engine.scanDenials(t0 + 14 * MIN), null);
  const next = engine.scanDenials(t0 + 15 * MIN);
  assert.ok(next);
  release();
  await next;
  assert.equal(calls, 2);
  assert.deepEqual(engine.memory.denialScan, { files: {} });
  assert.deepEqual(prompts, []);
});

test('the engine adds no alert for a rising trend, so no pane prompt follows', async () => {
  const { loadConfig } = await import('../src/config.js');
  const day = new Date().toISOString().slice(0, 10);
  saveDenials(process.env.HERDR_BOSS_DIR, [{ day, harness: 'codex', cause: 'sandbox:eperm', project: 'shop', count: 500 }]);
  const prompts = [];
  const engine = new Engine(loadConfig(), {
    push: false, act: false, herdrRunner: async (...args) => { prompts.push(args); return ''; },
    collectors: {
      collectHerdr: async () => ({ workspaces: [], panes: [] }), collectQuotas: async () => null,
      collectMachine: async () => null, collectProcesses: async () => new Map(), collectCwdProcesses: async () => [],
      collectMissingWorktreeProcesses: async () => [], collectWorktreeCounts: async () => ({}),
      runDenialScan: async () => { throw new Error('no scan in this test'); },
    },
  });
  const state = await engine.tick();
  assert.equal(state.denials.rising[0].cause, 'sandbox:eperm');
  assert.equal(state.alerts.some((a) => /denial|Discuss this trend/i.test(`${a.key} ${a.title} ${a.text}`)), false);
  const bulletin = fs.readFileSync(path.join(process.env.HERDR_BOSS_DIR, 'bulletin.md'), 'utf8');
  assert.match(bulletin.split('## Owner')[1] || '', /Discuss this trend with the Boss\./);
  assert.deepEqual(prompts, []);
});

test('while older logs are unread, the trend note waits', () => {
  const home = newHome();
  const lines = Array.from({ length: 200 }, () => claudeDenial('Backlog', '/work/Shop'));
  writeLines(path.join(home, '.claude/projects/-work-Shop/a.jsonl'), lines);
  const size = fs.statSync(path.join(home, '.claude/projects/-work-Shop/a.jsonl')).size;
  const partial = scanDenialLogs({ home, state: {}, now: NOW, repos: REPOS, budgetBytes: Math.floor(size / 3) });
  assert.ok(partial.state.pendingBytes > 0);
  const done = scanDenialLogs({ home, state: {}, now: NOW, repos: REPOS });
  assert.equal(done.state.pendingBytes, 0);
  const day = new Date(NOW).toISOString().slice(0, 10);
  const records = [{ day, harness: 'claude', cause: 'classifier:Backlog', project: 'shop', count: 50 }];
  const waiting = denialSummary(records, NOW, { pendingBytes: 2 * 1024 * 1024 });
  assert.equal(waiting.catchingUp, true);
  assert.deepEqual(waiting.rising, []);
  assert.equal(waiting.note, null);
  assert.equal(waiting.causes[0].rising, true);
  assert.equal(denialSummary(records, NOW, { pendingBytes: 1000 }).note, DISCUSS_NOTE);
});

test('the state exposes the fixed scan and store limits', async () => {
  const { loadConfig } = await import('../src/config.js');
  const engine = new Engine(loadConfig(), {
    push: false, act: false, herdrRunner: async () => '',
    collectors: {
      collectHerdr: async () => ({ workspaces: [], panes: [] }), collectQuotas: async () => null,
      collectMachine: async () => null, collectProcesses: async () => new Map(), collectCwdProcesses: async () => [],
      collectMissingWorktreeProcesses: async () => [], collectWorktreeCounts: async () => ({}),
      runDenialScan: async () => { throw new Error('no scan in this test'); },
    },
  });
  const state = await engine.tick();
  assert.deepEqual(state.limits, {
    denials: { intervalMs: 15 * 60 * 1000, budgetBytes: 20 * 1024 * 1024, retainDays: 30, riseFactor: 2, riseMinEvents: 10 },
    messages: { retentionMs: 30 * 86400 * 1000, sendLimitPerMinute: 10 },
  });
});
