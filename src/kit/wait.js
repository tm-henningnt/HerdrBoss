import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readJson } from './orchestration.js';

// Exit code for each reason. 2 is the usage error code of the other kit commands.
export const WAIT_EXIT_CODES = Object.freeze({ report: 0, question: 10, blocked: 11, stalled: 12, gone: 13, timeout: 75 });
export const WAIT_USAGE = 'Usage: wait [<worker>...] [--timeout SECONDS] [--stall SECONDS]';
export const WAIT_DEFAULT_STALL_SECONDS = 20 * 60;

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
// The reasons in the order that a tie in one poll resolves.
const PRIORITY = ['report', 'question', 'blocked', 'gone', 'stalled'];

// An unknown shape gives null, and the caller treats it as a failed call.
function listFrom(value, key) {
  if (Array.isArray(value?.[key])) return value[key];
  return Array.isArray(value) ? value : null;
}
const agentName = (agent) => agent?.name ?? agent?.agent_name ?? null;
const agentStatus = (agent) => agent?.agent_status ?? agent?.status ?? null;

function defaultPause(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function unfinishedRuns(config) {
  let files = [];
  try { files = fs.readdirSync(config.runsPath).filter((file) => file.endsWith('.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const runs = [];
  for (const file of files) {
    try {
      const run = readJson(path.join(config.runsPath, file));
      if (run?.name && !run.finishedAt) runs.push(run);
    } catch { /* A broken record is not a worker to wait on. */ }
  }
  return runs;
}

// A report is a file, so this reads metadata only and never opens the file.
function reportWritten(run) {
  const started = Date.parse(run.startedAt);
  const dir = path.join(run.worktree, run.workerDir || '.worker');
  for (const name of ['report.json', 'report.md']) {
    try {
      const stat = fs.statSync(path.join(dir, name));
      if (stat.isFile() && (!Number.isFinite(started) || stat.mtimeMs > started)) return true;
    } catch { /* No file yet. */ }
  }
  return false;
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Heuristic: count the lines that echo the send command, that is, a line with both `herdr agent prompt` and
// `WORKER QUESTION <name>`. A brief or a quoted text without the command does not count.
function questionCount(text, name) {
  const pattern = new RegExp(`WORKER QUESTION ${escapeRegExp(name)}(?![a-z0-9-])`);
  return String(text ?? '').split(/\r?\n/).filter((line) => /herdr agent prompt/.test(line) && pattern.test(line)).length;
}

const CALL_TIMEOUT_MS = 10000;

// A herdr runner whose calls stop at a timeout. waitForWorkers sets the timeout before each call.
export function createWaitHerdr(createRunner) {
  const limit = { ms: CALL_TIMEOUT_MS };
  const runner = createRunner((args) => execFileSync('herdr', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: limit.ms }));
  runner.setCallTimeout = (ms) => { limit.ms = ms; };
  return runner;
}

// Wait for the first event of any listed worker. Only run records, report file times, `agent list`, and
// `agent read` are used. The function makes at most one herdr call per poll and polls once per pollMs.
export function waitForWorkers(names, {
  config, herdr, output = console.log, now = () => Date.now(), pause = defaultPause,
  timeoutSeconds = null, stallSeconds = WAIT_DEFAULT_STALL_SECONDS, pollMs = 1000,
} = {}) {
  const runs = unfinishedRuns(config);
  let targets;
  if (names.length) {
    targets = names.map((name) => {
      if (!NAME_PATTERN.test(name)) throw Object.assign(new Error(`Worker name must match [a-z][a-z0-9-]{0,31}: ${name}.`), { exitCode: 2 });
      const run = runs.find((item) => item.name === name);
      if (!run) throw Object.assign(new Error(`No unfinished worker named ${name}.`), { exitCode: 2 });
      return run;
    });
  } else {
    targets = runs;
    if (!targets.length) throw Object.assign(new Error('No unfinished workers to wait for.'), { exitCode: 2 });
  }

  const started = now();
  const deadline = timeoutSeconds === null ? null : started + timeoutSeconds * 1000;
  const seen = new Map(targets.map((run) => [run.name, { baseline: null, hash: null, changedAt: started }]));
  const status = new Map();
  // The herdr calls rotate: one list, then one read for each worker.
  const cycle = ['list', ...targets.map((run) => run.name)];
  let tick = 0;

  const finish = (name, reason) => {
    output(`${name} ${reason}`);
    return { worker: name, reason, exitCode: WAIT_EXIT_CODES[reason] };
  };

  for (;;) {
    const events = new Map();
    const note = (run, reason) => { if (!events.has(run.name)) events.set(run.name, new Set()); events.get(run.name).add(reason); };
    for (const run of targets) if (reportWritten(run)) note(run, 'report');

    const step = cycle[tick % cycle.length];
    tick += 1;
    // A hung herdr call stops at the timeout, or earlier when the wait deadline is near.
    if (typeof herdr.setCallTimeout === 'function') {
      herdr.setCallTimeout(Math.max(1000, Math.min(CALL_TIMEOUT_MS, deadline === null ? CALL_TIMEOUT_MS : deadline - now())));
    }
    if (step === 'list') {
      try {
        const live = listFrom(herdr(['agent', 'list']), 'agents');
        if (!live) throw new Error('unknown agent list shape');
        for (const run of targets) {
          const agent = live.find((item) => agentName(item) === run.name);
          if (!agent) { status.set(run.name, 'gone'); note(run, 'gone'); continue; }
          status.set(run.name, agentStatus(agent));
          if (agentStatus(agent) === 'blocked') note(run, 'blocked');
        }
      } catch { /* A failed list call is retried at the next rotation. */ }
    } else {
      const run = targets.find((item) => item.name === step);
      const state = seen.get(step);
      try {
        const result = herdr(['agent', 'read', step, '--source', 'recent-unwrapped', '--lines', '60']);
        const text = result?.text ?? String(result ?? '');
        const count = questionCount(text, step);
        if (state.baseline !== null && count > state.baseline) note(run, 'question');
        state.baseline = state.baseline === null ? count : Math.min(state.baseline, count);
        const hash = crypto.createHash('sha1').update(text).digest('hex');
        if (hash !== state.hash) { state.hash = hash; state.changedAt = now(); }
      } catch (error) {
        if (/not[ _]found|no such agent|unknown agent/i.test(`${error?.message ?? ''} ${error?.stderr ?? ''}`)) note(run, 'gone');
      }
    }
    for (const run of targets) {
      const state = seen.get(run.name);
      if (state.hash !== null && status.get(run.name) !== 'working' && now() - state.changedAt >= stallSeconds * 1000) note(run, 'stalled');
    }

    for (const reason of PRIORITY) {
      for (const run of targets) if (events.get(run.name)?.has(reason)) return finish(run.name, reason);
    }
    if (deadline !== null && now() >= deadline) return finish(targets.map((run) => run.name).join(','), 'timeout');
    pause(pollMs);
  }
}

export function parseWaitArgs(argv) {
  const names = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) { names.push(token); continue; }
    if (!['--timeout', '--stall'].includes(token)) throw Object.assign(new Error(`Unknown option: ${token}.`), { exitCode: 2 });
    const value = argv[++index];
    if (value === undefined || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
      throw Object.assign(new Error(`${token} must be a whole number of seconds, 1 or more.`), { exitCode: 2 });
    }
    const key = token.slice(2);
    if (key in flags) throw Object.assign(new Error(`${token} may be used only once.`), { exitCode: 2 });
    flags[key] = Number(value);
  }
  return { names, timeoutSeconds: flags.timeout ?? null, stallSeconds: flags.stall ?? null };
}
