import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// The probe runs in a child process. This process reads only constants, and it uses a temporary data directory.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-notice-digest-const-'));
process.env.HERDR_BOSS_DIR = DATA;
process.on('exit', () => fs.rmSync(DATA, { recursive: true, force: true }));
const { browserUnresponsiveAlert, INFO_PROMPT_INTERVAL_MS } = await import('../src/engine.js');

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const NOW = Date.parse('2026-10-01T09:00:00Z');
const MIN = 60000;
const HOUR = 60 * MIN;

// Runs Engine.deliver in a child process with a temporary data directory and a fake herdr on PATH.
// Each round is { at, panes, alerts }. The injected herdr runner records each pane prompt.
const deliverProbe = `
import { Engine } from './src/engine.js';
import { loadConfig } from './src/config.js';
const input = JSON.parse(process.env.DIGEST_SCENARIO);
const prompts = [];
const cfg = loadConfig();
cfg.push = false;
const engine = new Engine(cfg, {
  push: false, act: false,
  herdrRunner: async (cmd, args) => { prompts.push({ round: current, pane: args[2], text: args[3] }); return ''; },
});
engine.push = true;
engine.log = () => {};
let current = 0;
for (const [i, round] of input.rounds.entries()) {
  current = i;
  await engine.deliver(round.alerts, { panes: round.panes }, round.at);
}
console.log(JSON.stringify({ prompts }));
`;

function deliverRounds(t, rounds) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-notice-digest-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(dir, 'data', 'projects'), { recursive: true });
  // The desktop notice uses the herdr binary directly. This fake one does nothing.
  fs.writeFileSync(path.join(bin, 'herdr'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', deliverProbe], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env, HOME: dir, HERDR_BOSS_DIR: path.join(dir, 'data'), NODE_TEST_CONTEXT: '1',
      PATH: `${bin}${path.delimiter}${process.env.PATH}`, DIGEST_SCENARIO: JSON.stringify({ rounds }),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim()).prompts;
}

const orch = (status = 'idle') => ({ id: 'w1:p1', workspace: 'w1', orch: true, label: 'orch', agent: 'claude', status });
// A broadcast notice with scope `all` reaches only a project with a worker that runs.
const worker = { id: 'w1:p2', workspace: 'w1', label: 'worker', agent: 'claude', status: 'working' };
const panes = [orch(), worker];

const info = (n) => ({ key: `test:info:${n}`, severity: 'info', scope: 'w1', title: `Info ${n}`, text: `Info notice ${n}.` });
const swap = (text = 'Swap is 62% used (4.0 GB).') => ({ key: 'machine:swap', severity: 'warn', scope: 'all', title: 'Swap high', text });
const mem = (severity = 'warn') => ({ key: 'machine:mem', severity, scope: 'all', title: 'Memory low', text: `System memory is 12% free (${severity}).` });
const load = (key = 'machine:load') => ({ key, severity: 'warn', scope: key === 'machine:load' ? 'all' : 'w1', title: 'Machine CPU high', text: `Machine CPU is high (${key}).` });
const down = () => ({ key: 'browser:managed-down:herdrboss:9333', severity: 'warn', scope: 'w1', title: 'herdrboss browser is offline', text: 'The recorded browser for herdrboss on port 9333 is offline.' });
const owned = () => ({ key: 'browser:owned:4242', severity: 'info', scope: 'w1', title: 'Idle worker holds a browser', text: 'Worker beta is idle and its automation browser still runs.' });
const orphan = () => ({ key: 'browser:orphan:4343', severity: 'info', scope: 'all', title: 'Orphaned automation Chrome', text: 'An automation browser has no owner process: pid 4343.' });
const disk = () => ({ key: 'machine:disk:w1:warn', severity: 'warn', scope: 'w1', title: 'Disk space low', text: 'The Herdr Boss data filesystem has 12.4 GB free.' });

const byRound = (prompts, round) => prompts.filter((p) => p.round === round);
const noticeLines = (prompt) => prompt.text.split('\n').filter((line) => line.startsWith('- '));

test('a machine or browser warning joins the info digest and starts its interval', (t) => {
  const prompts = deliverRounds(t, [
    { at: NOW, panes, alerts: [swap(), down()] },
    { at: NOW + 60 * MIN, panes, alerts: [swap(), down(), info('a')] },
    { at: NOW + 121 * MIN, panes, alerts: [swap(), down(), info('a'), info('b')] },
  ]);
  const digest = byRound(prompts, 0);
  assert.equal(digest.length, 1, 'the first settled tick sends one digest');
  assert.deepEqual(noticeLines(digest[0]), ['- Swap is 62% used (4.0 GB).', '- The recorded browser for herdrboss on port 9333 is offline.'], 'one line each');
  assert.match(digest[0].text, /Resource notice/, 'the digest is the resource notice prompt');
  assert.equal(byRound(prompts, 1).length, 0, 'the warning and the info notice share one interval');
  const next = byRound(prompts, 2);
  assert.equal(next.length, 1, 'the next digest goes out after 2 hours');
  assert.deepEqual(noticeLines(next[0]), ['- Info notice a.', '- Info notice b.'], 'the digest carries the waiting info notices');
});

test('the digest lists each key once with its newest text', (t) => {
  const prompts = deliverRounds(t, [
    { at: NOW, panes, alerts: [swap('Swap is 61% used.'), swap('Swap is 62% used.'), info('a')] },
  ]);
  const [digest] = byRound(prompts, 0);
  assert.equal(digest.text.match(/Swap is 6/g).length, 1, 'one line for the key');
  assert.match(digest.text, /- Swap is 62% used\./, 'the newest text wins');
  assert.doesNotMatch(digest.text, /61% used/, 'the older text is not listed');
});

test('a key that is no longer active is not listed', (t) => {
  const alerts = [swap(), info('a')];
  const prompts = deliverRounds(t, [
    { at: NOW, panes, alerts },
    { at: NOW + 121 * MIN, panes, alerts: [info('a'), info('b')] },
  ]);
  assert.match(byRound(prompts, 0)[0].text, /- Swap is 62% used \(4\.0 GB\)\./);
  const next = byRound(prompts, 1);
  assert.equal(next.length, 1);
  // The swap alert left the alerts. The digest lists the new notice, and the cleared key is gone.
  assert.deepEqual(noticeLines(next[0]), ['- Info notice b.']);
});

test('the named machine and browser keys join the digest', (t) => {
  const alerts = [swap(), mem(), load(), load('machine:load:w1'), down(), owned(), orphan()];
  const prompts = deliverRounds(t, [
    { at: NOW, panes, alerts },
    { at: NOW + 60 * MIN, panes, alerts: [...alerts, { ...down(), key: 'browser:managed-down:herdrboss:9334', text: 'The recorded browser for herdrboss on port 9334 is offline.' }] },
  ]);
  const digest = byRound(prompts, 0);
  assert.equal(digest.length, 1, 'one digest holds every named key');
  assert.deepEqual(noticeLines(digest[0]), [
    '- Swap is 62% used (4.0 GB).',
    '- System memory is 12% free (warn).',
    '- Machine CPU is high (machine:load).',
    '- Machine CPU is high (machine:load:w1).',
    '- The recorded browser for herdrboss on port 9333 is offline.',
    '- Worker beta is idle and its automation browser still runs.',
    '- An automation browser has no owner process: pid 4343.',
  ], 'every named key is in the one digest');
  assert.equal(byRound(prompts, 1).length, 0, 'a new browser warning waits for the next digest');
});

test('a critical machine warning goes out at once', (t) => {
  const prompts = deliverRounds(t, [{ at: NOW, panes, alerts: [mem('critical')] }]);
  const [urgent] = byRound(prompts, 0);
  assert.equal(prompts.length, 1, 'the critical warning does not wait for the interval');
  assert.deepEqual(noticeLines(urgent), ['- System memory is 12% free (critical).']);
});

test('a machine:disk warning goes out at once', (t) => {
  const prompts = deliverRounds(t, [{ at: NOW, panes, alerts: [disk()] }]);
  const [urgent] = byRound(prompts, 0);
  assert.equal(prompts.length, 1, 'the disk warning keeps its own path');
  assert.deepEqual(noticeLines(urgent), ['- The Herdr Boss data filesystem has 12.4 GB free.']);
});

test('browser:managed-unresponsive stays immediate', () => {
  assert.equal(INFO_PROMPT_INTERVAL_MS, 2 * HOUR);
  const alert = browserUnresponsiveAlert({ project: 'herdrboss', port: 9333, headless: true, probeSince: '2026-10-01T08:00:00Z' }, 'w1');
  assert.match(alert.key, /^browser:managed-unresponsive:/);
  assert.equal(alert.immediate, true);
});

test('an immediate browser warning reaches a working pane at once', (t) => {
  const alert = { key: 'browser:managed-unresponsive:herdrboss:9333', severity: 'warn', immediate: true, once: true, scope: 'w1', title: 'browser is not responding', text: 'Your project browser is not responding.' };
  const prompts = deliverRounds(t, [{ at: NOW, panes: [orch('working')], alerts: [alert] }]);
  const [urgent] = byRound(prompts, 0);
  assert.equal(prompts.length, 1, 'the immediate warning reaches a working pane');
  assert.deepEqual(noticeLines(urgent), ['- Your project browser is not responding.']);
});

test('a machine warning waits for a settled pane', (t) => {
  const prompts = deliverRounds(t, [
    { at: NOW, panes: [orch('working'), worker], alerts: [swap()] },
    { at: NOW + 10 * MIN, panes: [orch('idle'), worker], alerts: [swap()] },
  ]);
  assert.equal(byRound(prompts, 0).length, 0, 'a working pane gets no digest');
  const digest = byRound(prompts, 1);
  assert.equal(digest.length, 1, 'the digest goes out when the pane is idle');
  assert.deepEqual(noticeLines(digest[0]), ['- Swap is 62% used (4.0 GB).']);
});
