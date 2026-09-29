import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WAIT_EXIT_CODES, parseWaitArgs, waitForWorkers } from '../src/kit/wait.js';
import { runKitCommand } from '../src/kit/cli.js';

const START = Date.parse('2026-09-30T10:00:00Z');

function fixture(names) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-wait-'));
  const runsPath = path.join(root, 'runs');
  fs.mkdirSync(runsPath);
  for (const name of names) {
    const worktree = path.join(root, name);
    fs.mkdirSync(path.join(worktree, '.worker'), { recursive: true });
    fs.writeFileSync(path.join(runsPath, `${name}.json`), JSON.stringify({
      name, pane: `p-${name}`, worktree, workerDir: '.worker', startedAt: new Date(START).toISOString(),
    }));
  }
  return { root, config: { runsPath }, worktree: (name) => path.join(root, name) };
}

// A fake clock: each pause advances it. The herdr fake counts calls and gives one status and one screen per agent.
function harness(names, { statuses = {}, screens = {}, live = names } = {}) {
  const fx = fixture(names);
  const clock = { t: START + 1000 };
  const calls = [];
  const lines = [];
  const state = { statuses: { ...statuses }, screens: { ...screens }, live: [...live] };
  const herdr = (args) => {
    calls.push({ args, at: clock.t });
    if (state.listOverride !== undefined && args[1] === 'list') return state.listOverride;
    if (state.readError && args[1] === 'read') throw state.readError;
    if (args[1] === 'list') return { agents: state.live.map((name) => ({ name, agent_status: state.statuses[name] ?? 'idle' })) };
    if (args[1] === 'read') return { text: state.screens[args[2]] ?? 'screen' };
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const options = { config: fx.config, herdr, output: (line) => lines.push(line), now: () => clock.t, pause: (ms) => { clock.t += ms; } };
  return { fx, clock, calls, lines, state, options };
}

const writeReport = (fx, name, file = 'report.json', text = 'SECRET REPORT BODY') => {
  const target = path.join(fx.worktree(name), '.worker', file);
  fs.writeFileSync(target, text);
  fs.utimesSync(target, new Date(START + 5000), new Date(START + 5000));
};

test('exit codes are distinct for each reason', () => {
  assert.deepEqual(WAIT_EXIT_CODES, { report: 0, question: 10, blocked: 11, stalled: 12, gone: 13, timeout: 75 });
});

test('a report.json written after the start ends the wait with reason report', () => {
  const h = harness(['w1']);
  writeReport(h.fx, 'w1');
  const result = waitForWorkers(['w1'], h.options);
  assert.deepEqual(h.lines, ['w1 report']);
  assert.equal(result.exitCode, 0);
});

test('a report.md written after the start ends the wait', () => {
  const h = harness(['w1']);
  writeReport(h.fx, 'w1', 'report.md');
  assert.equal(waitForWorkers(['w1'], h.options).reason, 'report');
});

test('a report file older than the start does not end the wait', () => {
  const h = harness(['w1']);
  const target = path.join(h.fx.worktree('w1'), '.worker', 'report.json');
  fs.writeFileSync(target, 'old');
  fs.utimesSync(target, new Date(START - 60000), new Date(START - 60000));
  const result = waitForWorkers(['w1'], { ...h.options, timeoutSeconds: 5 });
  assert.equal(result.reason, 'timeout');
});

test('the wait never prints report contents', () => {
  const h = harness(['w1']);
  writeReport(h.fx, 'w1', 'report.json', 'SECRET REPORT BODY');
  writeReport(h.fx, 'w1', 'report.md', 'SECRET REPORT BODY');
  waitForWorkers(['w1'], h.options);
  assert.equal(h.lines.length, 1);
  assert.doesNotMatch(h.lines.join('\n'), /SECRET/);
  assert.ok(h.calls.every((call) => !JSON.stringify(call.args).includes('SECRET')));
});

test('a new WORKER QUESTION on the pane ends the wait with reason question', () => {
  const h = harness(['w1'], { screens: { w1: 'old text' } });
  // The first read sets the baseline. The question appears after it.
  h.options.herdr = ((inner) => (args) => {
    if (args[1] === 'read' && h.calls.filter((call) => call.args[1] === 'read').length >= 2) h.state.screens.w1 = 'ran herdr agent prompt "WORKER QUESTION w1: which flag?"';
    return inner(args);
  })(h.options.herdr);
  const result = waitForWorkers(['w1'], h.options);
  assert.equal(result.reason, 'question');
  assert.equal(result.exitCode, 10);
  assert.deepEqual(h.lines, ['w1 question']);
});

test('a WORKER QUESTION already on the screen at the start does not count', () => {
  const h = harness(['w1'], { screens: { w1: 'the brief says WORKER QUESTION w1: <what you need>' } });
  const result = waitForWorkers(['w1'], { ...h.options, timeoutSeconds: 10 });
  assert.equal(result.reason, 'timeout');
});

test('a blocked pane ends the wait with reason blocked', () => {
  const h = harness(['w1'], { statuses: { w1: 'blocked' } });
  const result = waitForWorkers(['w1'], h.options);
  assert.equal(result.reason, 'blocked');
  assert.equal(result.exitCode, 11);
  assert.deepEqual(h.lines, ['w1 blocked']);
});

test('a pane without output change for the stall time ends the wait with reason stalled', () => {
  const h = harness(['w1']);
  const result = waitForWorkers(['w1'], { ...h.options, stallSeconds: 30 });
  assert.equal(result.reason, 'stalled');
  assert.equal(result.exitCode, 12);
  assert.deepEqual(h.lines, ['w1 stalled']);
});

test('changing output keeps the wait going past the stall time', () => {
  const h = harness(['w1']);
  const inner = h.options.herdr;
  h.options.herdr = (args) => {
    if (args[1] === 'read') h.state.screens.w1 = `frame ${h.clock.t}`;
    return inner(args);
  };
  const result = waitForWorkers(['w1'], { ...h.options, stallSeconds: 30, timeoutSeconds: 120 });
  assert.equal(result.reason, 'timeout');
});

test('a worker missing from the agent list ends the wait with reason gone', () => {
  const h = harness(['w1'], { live: [] });
  const result = waitForWorkers(['w1'], h.options);
  assert.equal(result.reason, 'gone');
  assert.equal(result.exitCode, 13);
  assert.deepEqual(h.lines, ['w1 gone']);
});

test('the timeout gives reason timeout and exit code 75', () => {
  const h = harness(['w1']);
  const result = waitForWorkers(['w1'], { ...h.options, timeoutSeconds: 7, stallSeconds: 3600 });
  assert.equal(result.reason, 'timeout');
  assert.equal(result.exitCode, 75);
  assert.deepEqual(h.lines, ['w1 timeout']);
  assert.ok(h.clock.t - START >= 7000);
});

test('the first of many workers ends the wait and names that worker', () => {
  const h = harness(['w1', 'w2', 'w3'], { statuses: { w2: 'blocked' } });
  const result = waitForWorkers(['w1', 'w2', 'w3'], h.options);
  assert.equal(result.worker, 'w2');
  assert.deepEqual(h.lines, ['w2 blocked']);
  writeReport(h.fx, 'w3');
  const later = harness(['w1', 'w3']);
  writeReport(later.fx, 'w3');
  assert.deepEqual(waitForWorkers(['w1', 'w3'], later.options).worker, 'w3');
});

test('with no worker name the wait covers all unfinished workers and skips finished ones', () => {
  const h = harness(['w1', 'w2']);
  fs.writeFileSync(path.join(h.fx.config.runsPath, 'done.json'), JSON.stringify({
    name: 'done', worktree: h.fx.worktree('w1'), workerDir: '.worker', startedAt: new Date(START).toISOString(), finishedAt: new Date(START).toISOString(),
  }));
  writeReport(h.fx, 'w2');
  const result = waitForWorkers([], h.options);
  assert.equal(result.worker, 'w2');
  const timeout = waitForWorkers([], { ...harness(['w1', 'w2']).options, timeoutSeconds: 3, stallSeconds: 3600 });
  assert.equal(timeout.reason, 'timeout');
});

test('an unknown worker name and an empty project fail with exit code 2', () => {
  const h = harness(['w1']);
  assert.throws(() => waitForWorkers(['nope'], h.options), (error) => error.exitCode === 2 && /No unfinished worker named nope/.test(error.message));
  const empty = harness([]);
  assert.throws(() => waitForWorkers([], empty.options), (error) => error.exitCode === 2);
});

test('the wait makes at most one herdr call per poll and polls once per second', () => {
  const h = harness(['w1', 'w2']);
  waitForWorkers(['w1', 'w2'], { ...h.options, timeoutSeconds: 20, stallSeconds: 3600 });
  const times = h.calls.map((call) => call.at);
  assert.equal(new Set(times).size, times.length, 'two herdr calls share one instant');
  for (let index = 1; index < times.length; index += 1) assert.ok(times[index] - times[index - 1] >= 1000);
});

test('the option parser accepts names and whole-second options only', () => {
  assert.deepEqual(parseWaitArgs(['a', 'b', '--timeout', '30']), { names: ['a', 'b'], timeoutSeconds: 30, stallSeconds: null });
  assert.deepEqual(parseWaitArgs(['--stall', '90']), { names: [], timeoutSeconds: null, stallSeconds: 90 });
  for (const bad of [['--timeout'], ['--timeout', 'x'], ['--timeout', '0'], ['--timeout', '1', '--timeout', '2'], ['--other', '1']]) {
    assert.throws(() => parseWaitArgs(bad), (error) => error.exitCode === 2);
  }
});

test('the kit command wait returns the exit code of the reason', () => {
  const h = harness(['w1'], { statuses: { w1: 'blocked' } });
  const lines = [];
  const result = runKitCommand('wait', ['w1', '--timeout', '5'], {
    config: h.fx.config, herdr: h.options.herdr, output: (line) => lines.push(line), now: h.options.now, pause: h.options.pause,
  });
  assert.equal(result.exitCode, 11);
  assert.deepEqual(lines, ['w1 blocked']);
});

test('an unknown or null agent list shape is a failed call and never gone', () => {
  const h = harness(['w1']);
  h.state.listOverride = null;
  assert.equal(waitForWorkers(['w1'], { ...h.options, timeoutSeconds: 5, stallSeconds: 3600 }).reason, 'timeout');
  h.state.listOverride = { unexpected: true };
  assert.equal(waitForWorkers(['w1'], { ...h.options, timeoutSeconds: 5, stallSeconds: 3600 }).reason, 'timeout');
  // A later good list is used.
  let calls = 0;
  const inner = h.options.herdr;
  h.state.listOverride = undefined;
  const flaky = (args) => (args[1] === 'list' && (calls += 1) === 1 ? null : inner(args));
  h.state.statuses.w1 = 'blocked';
  assert.equal(waitForWorkers(['w1'], { ...h.options, herdr: flaky }).reason, 'blocked');
});

test('a pane in status working is never stalled', () => {
  const h = harness(['w1'], { statuses: { w1: 'working' } });
  const result = waitForWorkers(['w1'], { ...h.options, stallSeconds: 30, timeoutSeconds: 120 });
  assert.equal(result.reason, 'timeout');
});

test('a quoted WORKER QUESTION without the send command does not count', () => {
  const h = harness(['w1'], { screens: { w1: 'start' } });
  const inner = h.options.herdr;
  h.options.herdr = (args) => {
    if (args[1] === 'read' && h.calls.filter((call) => call.args[1] === 'read').length >= 2) h.state.screens.w1 = 'I will send WORKER QUESTION w1: later';
    return inner(args);
  };
  assert.equal(waitForWorkers(['w1'], { ...h.options, timeoutSeconds: 10, stallSeconds: 3600 }).reason, 'timeout');
});

test('a worker name with a prefix in common does not match another worker question', () => {
  const h = harness(['w1', 'w10'], { screens: { w1: 'start', w10: 'start' } });
  const inner = h.options.herdr;
  h.options.herdr = (args) => {
    if (args[1] === 'read' && args[2] === 'w10' && h.calls.filter((call) => call.args[2] === 'w10').length >= 2) h.state.screens.w10 = 'herdr agent prompt p "WORKER QUESTION w10: x"';
    return inner(args);
  };
  const result = waitForWorkers(['w1', 'w10'], h.options);
  assert.equal(result.worker, 'w10');
});

test('a read error that names a missing agent ends the wait with reason gone', () => {
  const h = harness(['w1']);
  h.state.readError = Object.assign(new Error('failed'), { stderr: 'agent not found' });
  const result = waitForWorkers(['w1'], h.options);
  assert.equal(result.reason, 'gone');
  assert.equal(result.exitCode, 13);
});

// Herdr calls rotate: list, then one read per worker. A mutation runs after the given call count, so two
// events become due in the same poll. pollMs 1000 and stallSeconds 1 make a stall due one poll after its first read.
function tie(names, mutations, options = {}) {
  const h = harness(names, { screens: Object.fromEntries(names.map((name) => [name, 'start'])) });
  const inner = h.options.herdr;
  let count = 0;
  h.options.herdr = (args) => {
    const result = inner(args);
    count += 1;
    for (const [after, mutate] of mutations) if (after === count) mutate(h);
    return result;
  };
  return waitForWorkers(names, { ...h.options, stallSeconds: 1, pollMs: 1000, ...options });
}
const echo = (name) => `herdr agent prompt p "WORKER QUESTION ${name}: x"`;

test('a tie in one poll resolves in the order report, question, blocked, gone, stalled', () => {
  // Report beats blocked: both are due in the first poll.
  const reportTie = harness(['b1', 'r1'], { statuses: { b1: 'blocked' } });
  writeReport(reportTie.fx, 'r1');
  assert.equal(waitForWorkers(['b1', 'r1'], reportTie.options).reason, 'report');
  // Question beats stalled: the read of q at call 6 finds a question, and s stalls at the same instant.
  assert.equal(tie(['s', 'q'], [[3, (h) => { h.state.screens.q = echo('q'); }]], { stallSeconds: 4 }).reason, 'question');
  // Blocked beats gone: both show in one list call.
  const both = harness(['g2', 'b2'], { statuses: { b2: 'blocked' }, live: ['b2'] });
  assert.equal(waitForWorkers(['g2', 'b2'], both.options).reason, 'blocked');
  // Blocked beats stalled: s stalls at the list call, and its status turns blocked there.
  assert.equal(tie(['s'], [[2, (h) => { h.state.statuses.s = 'blocked'; }]]).reason, 'blocked');
  // Gone beats stalled: s leaves the agent list before the poll where it stalls.
  assert.equal(tie(['s'], [[2, (h) => { h.state.live = []; }]]).reason, 'gone');
});

test('the herdr runner for wait gets a call timeout before each call', () => {
  const h = harness(['w1']);
  const timeouts = [];
  h.options.herdr.setCallTimeout = (ms) => timeouts.push(ms);
  waitForWorkers(['w1'], { ...h.options, timeoutSeconds: 3, stallSeconds: 3600 });
  assert.ok(timeouts.length > 0);
  assert.ok(timeouts.every((ms) => ms >= 1000 && ms <= 10000));
});
