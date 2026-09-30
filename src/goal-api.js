// The dashboard routes of `herdr-boss goal set`. They use the same steps as the command line: no second implementation.
// The routes sit behind the dashboard access control and the read-only preview guard of the server, so the caller is the Owner.
// A job waits in the background of the service, so the request returns at once with status 202.
import fs from 'node:fs';
import path from 'node:path';
import { GoalError, cleanReason, resolveGoalTarget, setGoal } from './goal-set.js';
import { goalSetText } from './goal.js';
import { postGoalNotice } from './goal-notice.js';
import { SLUG } from './projects.js';

export const MAX_GOAL_JOBS = 2;
const BODY_FIELDS = ['project', 'text'];
const CANCEL_FIELDS = ['project'];
const RUNNING = ['waiting', 'sending', 'verifying'];

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (message) => new ApiError(400, message);

// options: run (async Herdr runner), control (function that gives the control object), policy (function that gives the policy),
// dataDir (the job files live in dataDir/goal-jobs; without it nothing is saved), log, and the clock, sleep, waitMs, pollMs of setGoal.
export function createGoalApi({ run, control = () => ({}), policy = () => ({}), dataDir = null, log = () => {}, maxJobs = MAX_GOAL_JOBS, now = Date.now, mailNow = Date.now, ...timing } = {}) {
  const jobs = new Map();
  const iso = () => new Date(now()).toISOString();
  const file = (slug) => path.join(dataDir, 'goal-jobs', `${slug}.json`);

  // One small file for each project. It holds the state and the goal text, never pane text.
  function save(slug, job) {
    if (!dataDir) return;
    try {
      fs.mkdirSync(path.dirname(file(slug)), { recursive: true, mode: 0o700 });
      const data = { state: job.state, pane: job.pane, text: job.text, startedAt: job.startedAt, updatedAt: job.updatedAt, reason: job.reason, message: job.message, verifiedAt: job.verifiedAt };
      const tmp = `${file(slug)}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, file(slug));
    } catch (error) { log('error', `Goal job ${slug}: the state file was not written: ${cleanReason(error.message)}`); }
  }
  function load(slug) {
    if (!dataDir) return null;
    try {
      const data = JSON.parse(fs.readFileSync(file(slug), 'utf8'));
      if (!data || typeof data !== 'object' || typeof data.state !== 'string') return null;
      // A file that says running, without a job in memory, belongs to a service that stopped.
      if (RUNNING.includes(data.state)) return { ...data, state: 'interrupted', reason: 'The service restarted while the job ran. Start the job again.' };
      return data;
    } catch { return null; }
  }

  function view(slug, job) {
    return { ok: true, slug, state: job.state, ...(job.reason ? { reason: job.reason } : {}), ...(job.message ? { message: job.message } : {}),
      pane: job.pane ?? null, text: job.text, startedAt: job.startedAt, updatedAt: job.updatedAt, ...(job.verifiedAt ? { verifiedAt: job.verifiedAt } : {}) };
  }

  async function start(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('The body must be a JSON object.');
    const extra = Object.keys(body).find((key) => !BODY_FIELDS.includes(key));
    if (extra !== undefined) throw bad(`Unknown field: ${extra.slice(0, 40)}.`);
    if (typeof body.project !== 'string' || !SLUG.test(body.project)) throw bad('project must be a project slug.');
    if (body.text !== undefined && typeof body.text !== 'string') throw bad('text must be a string.');
    const slug = body.project;
    const checked = goalSetText(body.text ?? policy().defaultOrchestratorGoal ?? '');
    if (checked.error) throw bad(checked.error);
    // The slot is reserved before the first await. Two requests in the same tick cannot both pass.
    const old = jobs.get(slug);
    if (old?.running) throw new ApiError(409, `A goal job of ${slug} is already running.`);
    if ([...jobs.values()].filter((job) => job.running).length >= maxJobs) throw new ApiError(429, `${maxJobs} goal jobs are already running. Try again when one ends.`);
    const controller = new AbortController();
    const job = { running: true, state: 'waiting', pane: null, text: checked.text, startedAt: iso(), updatedAt: iso(), controller };
    jobs.set(slug, job);
    const update = (fields) => { Object.assign(job, fields, { updatedAt: iso() }); save(slug, job); };
    const release = (fields) => { job.running = false; update(fields); };
    let target;
    try { target = await resolveGoalTarget(slug, { run, control: control() }); }
    catch (error) {
      // The job never started: give the slot back and keep the old result.
      if (old) jobs.set(slug, old); else jobs.delete(slug);
      job.running = false;
      if (error instanceof GoalError) throw new ApiError(error.code === 2 ? 409 : 404, cleanReason(error.message));
      throw error;
    }
    job.pane = target.pane;
    save(slug, job);
    setGoal({ pane: target.pane, kind: target.kind, goal: checked.text, run, now, signal: controller.signal, ...timing,
      notify: ({ blocker, pane }) => postGoalNotice({ slug, pane, blocker, dir: dataDir ?? undefined, now: mailNow }),
      onState: (state, reason) => { if (job.running) update({ state, reason: state === 'waiting' ? cleanReason(reason) : undefined }); } })
      .then((result) => {
        if (result.outcome === 'active') release({ state: 'active', message: result.message, reason: undefined, verifiedAt: iso() });
        else if (result.outcome === 'cancelled') release({ state: 'cancelled', message: result.message, reason: result.reason });
        else release({ state: 'failed', message: result.message, reason: cleanReason(result.reason ?? result.message) });
      })
      .catch((error) => {
        release({ state: 'failed', message: 'the goal job stopped', reason: cleanReason(error.message) });
        log('error', `Goal job ${slug} stopped: ${cleanReason(error.message)}`);
      });
    return { status: 202, body: { ok: true, slug, state: 'waiting', url: `/api/goal/status/${slug}` } };
  }

  function cancel(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('The body must be a JSON object.');
    const extra = Object.keys(body).find((key) => !CANCEL_FIELDS.includes(key));
    if (extra !== undefined) throw bad(`Unknown field: ${extra.slice(0, 40)}.`);
    if (typeof body.project !== 'string' || !SLUG.test(body.project)) throw bad('project must be a project slug.');
    const job = jobs.get(body.project);
    if (!job?.running) throw new ApiError(409, `There is no running goal job for ${body.project}.`);
    job.controller.abort();
    return { status: 200, body: { ok: true, slug: body.project, state: 'cancelling' } };
  }

  // Serve one request. readBody() gives the parsed JSON body and runs only for a POST route. Returns { status, body }.
  async function handle(method, pathname, readBody) {
    try {
      const parts = pathname.split('/').filter(Boolean).slice(2);
      if (parts.length === 1 && (parts[0] === 'set' || parts[0] === 'cancel')) {
        if (method !== 'POST') throw new ApiError(405, `The route ${pathname} does not accept ${method}.`);
        const body = await readBody();
        return parts[0] === 'set' ? await start(body) : cancel(body);
      }
      if (parts.length === 2 && parts[0] === 'status') {
        if (method !== 'GET') throw new ApiError(405, `The route ${pathname} does not accept ${method}.`);
        if (!SLUG.test(parts[1])) throw bad('The slug must match [a-z0-9][a-z0-9-]{0,63}.');
        const job = jobs.get(parts[1]) ?? load(parts[1]);
        if (!job) throw new ApiError(404, `There is no goal job for ${parts[1]}.`);
        return { status: 200, body: view(parts[1], job) };
      }
      throw new ApiError(404, 'not found');
    } catch (error) {
      if (error instanceof ApiError) return { status: error.status, body: { ok: false, error: error.message } };
      if (Number.isInteger(error.statusCode)) return { status: error.statusCode, body: { ok: false, error: cleanReason(error.message) } };
      log('error', `Goal route ${method} failed: ${cleanReason(error.message)}`);
      return { status: 500, body: { ok: false, error: 'The goal route failed.' } };
    }
  }

  return { handle, stats: () => ({ tracked: jobs.size, running: [...jobs.values()].filter((job) => job.running).length }) };
}
