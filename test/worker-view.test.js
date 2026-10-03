import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BRIEF_KEEP_MS, briefCopy, capFinished, briefCopyText, firstParagraph, noOutputMinutes, paneAction, pruneBriefCopies,
  readWorkerRows, titleFromBrief, titleFromTask, workerBrief,
} from '../src/worker-view.js';

const FAKE_SECRET = 'sk-FAKESECRET1234567890abcdef';
const NOW = Date.parse('2026-10-03T12:00:00Z');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-worker-view-'));

test('paneAction describes the last tool line of a Claude pane', () => {
  const screen = [
    '● Bash(node --test --test-concurrency=2 test/factory/render.test.js)',
    '  ⎿  Running…',
    '✻ Cogitating… (12s)',
    '',
    '❯',
  ].join('\n');
  assert.equal(paneAction(screen), 'Running tests in test/factory');
});

test('paneAction handles file tools, the report, the lock, and Codex lines', () => {
  assert.equal(paneAction('● Update(src/render.ts)\n  ⎿  Updated'), 'Editing src/render.ts');
  assert.equal(paneAction('● Read(src/server.js)'), 'Reading src/server.js');
  assert.equal(paneAction('● Write(.worker/report.md)'), 'Writing the report');
  assert.equal(paneAction('● Grep(pattern: "x")'), 'Searching the code');
  assert.equal(paneAction('● Bash(herdr-boss suite --wait 3600 -- npm test)'), 'Waiting for the lock or running the suite');
  assert.equal(paneAction('Waiting for the full-suite lock held by w1\n'), 'Waiting for the lock');
  assert.equal(paneAction('• Ran node --test test/a.test.js'), 'Running tests in test');
  assert.equal(paneAction('• Edited src/render.ts (+3 -1)'), 'Editing src/render.ts');
  assert.equal(paneAction('● Bash(git status --short)'), 'Running git status');
  assert.equal(paneAction('● Bash(herdr agent prompt herdrboss-orch "WORKER REPORT av1: done")'), 'Sending the report to the orchestrator');
});

test('paneAction strips escape codes and terminal artifacts', () => {
  const screen = '\u001b[2J\u001b[1;32m● Update(src/a.js)\u001b[0m\u0007\r\n\u001b]0;title\u0007';
  assert.equal(paneAction(screen), 'Editing src/a.js');
  assert.equal(paneAction('╭────╮\n│ > │\n╰────╯'), null);
  assert.equal(paneAction(''), null);
  assert.equal(paneAction(null), null);
});

test('paneAction masks a secret in a command', () => {
  const line = paneAction(`● Bash(curl -H "Authorization: Bearer ${FAKE_SECRET}" http://127.0.0.1:4477/api/state)`);
  assert.ok(line);
  assert.doesNotMatch(line, /FAKESECRET/);
  const key = paneAction(`● Bash(export API_KEY=${FAKE_SECRET} && node x.js)`);
  assert.doesNotMatch(key, /FAKESECRET/);
});

test('noOutputMinutes counts whole minutes since the screen changed', () => {
  assert.equal(noOutputMinutes({ changedAt: NOW - 5 * 60000 - 1000 }, NOW), 5);
  assert.equal(noOutputMinutes({ changedAt: NOW - 20000 }, NOW), 0);
  assert.equal(noOutputMinutes(null, NOW), 0);
});

test('titles come from the task text first, then the brief heading', () => {
  assert.equal(titleFromTask('  \n# FT15 Factory updates: service tiers\nMore text'), 'FT15 Factory updates: service tiers');
  assert.equal(titleFromTask(''), null);
  assert.equal(titleFromTask(`Fix ${FAKE_SECRET} leak`), 'Fix [REDACTED] leak');
  assert.equal(titleFromBrief('# Worker brief\n\nRole: x\n\n# AV1: readable workers\n'), 'AV1: readable workers');
  assert.equal(titleFromBrief('no heading here'), null);
  assert.ok(titleFromTask('x'.repeat(500)).length <= 140);
});

test('firstParagraph returns the first prose block of a report', () => {
  const report = `# Report av1\n\nAdded the Agents table and the brief panel.\nThe tests pass.\n\n## Commands\n\n- node --test\n`;
  assert.equal(firstParagraph(report), 'Added the Agents table and the brief panel. The tests pass.');
  assert.equal(firstParagraph('# Only a heading\n'), null);
  assert.equal(firstParagraph(`# R\n\nToken ${FAKE_SECRET} was used.`), 'Token [REDACTED] was used.');
});

test('briefCopy masks secrets, hashes the original text, and is bounded', () => {
  const copy = briefCopy(`# Brief\nUse ${FAKE_SECRET}\n`, NOW);
  assert.match(copy.hash, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(copy.text, /FAKESECRET/);
  assert.equal(copy.savedAt, new Date(NOW).toISOString());
  assert.ok(briefCopy('x'.repeat(2 * 1024 * 1024), NOW).text.length <= 256 * 1024 + 64);
});

test('briefCopyText returns the copy only inside the 30 day window', () => {
  const record = { startedAt: new Date(NOW - 40 * 86400000).toISOString(), finishedAt: new Date(NOW - 10 * 86400000).toISOString(), briefCopy: briefCopy('# Brief', NOW - 10 * 86400000) };
  assert.equal(briefCopyText(record, NOW), '# Brief');
  assert.equal(briefCopyText(record, NOW + 25 * 86400000), null);
  assert.equal(BRIEF_KEEP_MS, 30 * 86400000);
});

function fixture({ withCopy = true, live = true } = {}) {
  const root = tmp();
  const runs = path.join(root, 'runs');
  const worktree = path.join(root, 'wt');
  fs.mkdirSync(runs, { recursive: true });
  fs.mkdirSync(path.join(worktree, '.worker'), { recursive: true });
  fs.writeFileSync(path.join(worktree, '.worker', 'brief.md'), `# Live brief heading\n\nUse ${FAKE_SECRET}\n`);
  const record = {
    name: 'av1', kind: 'claude', model: 'claude-sonnet-5-5', pane: 'w1:p2', taskId: 'AV1', worktree, branch: 'av1', workerDir: '.worker',
    allowedPaths: ['src', 'test'], startedAt: new Date(NOW - 3600000).toISOString(),
    ...(withCopy ? { title: 'AV1: readable workers', briefCopy: briefCopy('# Copy heading\nBody', NOW - 3600000) } : {}),
    ...(live ? {} : { finishedAt: new Date(NOW - 600000).toISOString(), collectedAt: new Date(NOW - 600000).toISOString(), outcome: 'done', reportSummary: 'Built the view.' }),
  };
  fs.writeFileSync(path.join(runs, 'av1.json'), JSON.stringify(record));
  return { root, runs, worktree, record };
}

test('readWorkerRows builds a live row with title, action, and no brief text', () => {
  const { runs } = fixture();
  const rows = readWorkerRows(runs, {
    project: 'alpha', now: NOW,
    panes: new Map([['w1:p2', { status: 'working' }]]),
    actions: new Map([['w1:p2', { text: 'Running tests in test/factory', changedAt: NOW - 1000 }]]),
  });
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.project, 'alpha');
  assert.equal(row.title, 'AV1: readable workers');
  assert.equal(row.taskId, 'AV1');
  assert.equal(row.state, 'working');
  assert.equal(row.group, 'working');
  assert.equal(row.now, 'Running tests in test/factory');
  assert.equal(row.hasBrief, true);
  assert.deepEqual(row.scope, ['src', 'test']);
  assert.equal(row.reportPath, '.worker/report.md');
  assert.equal(JSON.stringify(row).includes('Copy heading'), false);
});

test('a working row without an action says how long the screen was quiet', () => {
  const { runs } = fixture();
  const [row] = readWorkerRows(runs, {
    project: 'alpha', now: NOW,
    panes: new Map([['w1:p2', { status: 'working' }]]),
    actions: new Map([['w1:p2', { text: null, changedAt: NOW - 7 * 60000 }]]),
  });
  assert.equal(row.now, 'Working (no output for 7 minutes)');
  const [fresh] = readWorkerRows(runs, { project: 'alpha', now: NOW, panes: new Map([['w1:p2', { status: 'working' }]]) });
  assert.equal(fresh.now, 'Working');
});

test('the title falls back to the live brief heading', () => {
  const { runs } = fixture({ withCopy: false });
  const [row] = readWorkerRows(runs, { project: 'alpha', now: NOW, panes: new Map([['w1:p2', { status: 'idle' }]]) });
  assert.equal(row.title, 'Live brief heading');
  assert.equal(row.group, 'waiting');
});

test('a finished row shows the report summary and the result', () => {
  const { runs } = fixture({ live: false });
  const make = (isMerged) => readWorkerRows(runs, { project: 'alpha', now: NOW, panes: new Map(), isMerged })[0];
  assert.equal(make(() => false).summary, 'Built the view.');
  assert.equal(make(() => false).result, 'Collected, not merged');
  assert.equal(make(() => true).result, 'Merged');
  assert.equal(make(() => false).group, 'finished');
});

test('a failed or abandoned run reads as needs rework or abandoned', () => {
  const { runs, record } = fixture({ live: false });
  fs.writeFileSync(path.join(runs, 'av1.json'), JSON.stringify({ ...record, outcome: 'partial' }));
  assert.equal(readWorkerRows(runs, { project: 'a', now: NOW, panes: new Map() })[0].result, 'Needs rework');
  const { runs: second, record: other } = fixture();
  const gone = { ...other, worktree: path.join(os.tmpdir(), 'herdr-worker-view-missing') };
  fs.writeFileSync(path.join(second, 'av1.json'), JSON.stringify(gone));
  assert.equal(readWorkerRows(second, { project: 'a', now: NOW, panes: new Map() })[0].result, 'Abandoned');
});

test('workerBrief prefers the copy, then the worktree, and masks secrets', () => {
  const { record } = fixture();
  const fromCopy = workerBrief(record, NOW);
  assert.equal(fromCopy.source, 'copy');
  assert.equal(fromCopy.text, '# Copy heading\nBody');
  const live = workerBrief({ ...record, briefCopy: undefined }, NOW);
  assert.equal(live.source, 'worktree');
  assert.doesNotMatch(live.text, /FAKESECRET/);
  assert.match(live.text, /\[REDACTED\]/);
  assert.equal(workerBrief({ ...record, briefCopy: undefined, worktree: path.join(os.tmpdir(), 'herdr-worker-view-missing') }, NOW), null);
});

test('pruneBriefCopies removes the text of an old copy and keeps the hash', () => {
  const { runs, record } = fixture({ live: false });
  const old = { ...record, finishedAt: new Date(NOW - 31 * 86400000).toISOString(), briefCopy: briefCopy('# Old', NOW - 31 * 86400000) };
  fs.writeFileSync(path.join(runs, 'av1.json'), JSON.stringify(old));
  assert.equal(pruneBriefCopies(runs, NOW), 1);
  const after = JSON.parse(fs.readFileSync(path.join(runs, 'av1.json'), 'utf8'));
  assert.equal(after.briefCopy.text, undefined);
  assert.equal(after.briefCopy.hash, old.briefCopy.hash);
  assert.equal(pruneBriefCopies(runs, NOW), 0);
});

test('pruneBriefCopies skips a record that changed after it was read, and writes the temp file as 0o600', () => {
  const { runs, record } = fixture({ live: false });
  const old = { ...record, finishedAt: new Date(NOW - 31 * 86400000).toISOString(), briefCopy: briefCopy('# Old', NOW - 31 * 86400000) };
  const file = path.join(runs, 'av1.json');
  fs.writeFileSync(file, JSON.stringify(old));
  let mode = null;
  const beforeRename = () => {
    mode = fs.statSync(`${file}.tmp`).mode & 0o777;
    fs.writeFileSync(file, JSON.stringify({ ...old, reportSummary: 'Written by collect.' }));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
  };
  assert.equal(pruneBriefCopies(runs, NOW, { beforeRename }), 0);
  assert.equal(mode, 0o600);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.reportSummary, 'Written by collect.');
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('finished rows use stored values and read no file; live rows with a copy skip the brief file check', () => {
  const { runs, worktree, record } = fixture({ live: false });
  fs.writeFileSync(path.join(worktree, '.worker', 'report.md'), '# R\n\nFile summary.\n');
  fs.writeFileSync(path.join(runs, 'av1.json'), JSON.stringify({ ...record, reportSummary: undefined }));
  const [row] = readWorkerRows(runs, { project: 'a', now: NOW, panes: new Map() });
  assert.equal(row.summary, null);
  assert.equal(row.hasBrief, true);
});

test('capFinished keeps all live rows and the 50 newest finished rows', () => {
  const rows = [
    ...Array.from({ length: 60 }, (_, index) => ({ group: 'finished', finishedAt: new Date(NOW - index * 1000).toISOString(), name: `f${index}` })),
    { group: 'working', name: 'live' },
  ];
  const capped = capFinished(rows, 50);
  assert.equal(capped.filter((row) => row.group === 'finished').length, 50);
  assert.equal(capped.some((row) => row.name === 'live'), true);
  assert.equal(capped.some((row) => row.name === 'f59'), false);
  assert.equal(capped.some((row) => row.name === 'f0'), true);
});

test('a brief file that is a symlink out of the worktree is not read', () => {
  const { record, root } = fixture();
  const outside = path.join(root, 'outside.md');
  fs.writeFileSync(outside, '# Outside\n');
  const link = path.join(record.worktree, '.worker', 'brief.md');
  fs.rmSync(link);
  fs.symlinkSync(outside, link);
  assert.equal(workerBrief({ ...record, briefCopy: undefined }, NOW), null);
});

test('scope is masked and the hash covers the masked text', () => {
  const { runs, record } = fixture();
  fs.writeFileSync(path.join(runs, 'av1.json'), JSON.stringify({ ...record, allowedPaths: [`src/${FAKE_SECRET}`] }));
  const [row] = readWorkerRows(runs, { project: 'a', now: NOW, panes: new Map([['w1:p2', { status: 'idle' }]]) });
  assert.doesNotMatch(JSON.stringify(row), /FAKESECRET/);
  const copy = briefCopy(`Key ${FAKE_SECRET}`, NOW);
  assert.equal(copy.hash, crypto.createHash('sha256').update(copy.text).digest('hex'));
  const live = workerBrief({ ...record, briefCopy: undefined }, NOW);
  assert.equal(live.hash, crypto.createHash('sha256').update(live.text).digest('hex'));
});
