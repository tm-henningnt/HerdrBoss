// The dashboard routes of `herdr-boss project new`. They use the flow module of the command line: no second implementation.
// The routes sit behind the dashboard access control and the read-only preview guard of the server, so the caller is the Owner.
// A run goes to a child process, so the synchronous Git and Herdr calls of the steps never block the server tick.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NOT_BUILT, PROJECT_NEW_STEPS, ProjectNewError, markFlowCrashed, readFlowState, resolveInputs, runProjectNew } from './project-new.js';
import { checkProject } from './project-new-check.js';
import { ORG_NAME, RemoteError, checkDecision, redact, validateRemoteUrl } from './project-new-remote.js';
import { SLUG } from './projects.js';

export const MAX_RUNS = 2;
export const BODY_LIMIT = 16 * 1024;
const MAX_FINISHED = 20;
const RUN_TIMEOUT_MS = 15 * 60 * 1000;
const EXIT_WAITING = 3;
const WAITING_REASON = 'waiting for an Owner decision';
const RUNNER = fileURLToPath(new URL('./project-new-run.js', import.meta.url));
const OPTION_FIELDS = ['remote', 'visibility', 'org', 'kind', 'start'];
const FIELD_TYPES = { slug: 'string', name: 'string', group: 'string', path: 'string', remote: 'string', visibility: 'string', org: 'string', kind: 'string', goal: 'string', start: 'boolean', decision: 'object' };

export class ApiError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
const bad = (message) => new ApiError(400, message);

// The default runner: the flow in a child process. It passes only the data of the options.
export function runFlowInChild(options) {
  const data = JSON.parse(JSON.stringify(options));
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PATH: `${path.join(os.homedir(), '.local/bin')}:${process.env.PATH || ''}` };
    const child = execFile(process.execPath, [RUNNER], { timeout: RUN_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env }, (error, stdout) => {
      if (error) return reject(new Error(`The flow process stopped: ${error.killed ? 'timeout' : `exit code ${error.code ?? 'unknown'}${error.signal ? `, signal ${error.signal}` : ''}`}.`));
      let result;
      try { result = JSON.parse(stdout); } catch { return reject(new Error('The flow process gave no result.')); }
      if (result.refused) return reject(new Error(result.error));
      return resolve(result);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(data));
  });
}

const DECISION_FIELDS = ['visibility', 'source', 'confirmPublic'];
function parseDecision(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad('The decision must be an object.');
  const extra = Object.keys(value).find((key) => !DECISION_FIELDS.includes(key));
  if (extra !== undefined) throw bad(`Unknown decision field: ${extra.slice(0, 40)}.`);
  try { checkDecision(value); } catch (error) { if (error instanceof RemoteError) throw bad(error.message); throw error; }
  return { visibility: value.visibility, source: value.source, ...(value.confirmPublic === true ? { confirmPublic: true } : {}) };
}

// Read the body fields into the options of the flow. Throws an ApiError with status 400.
// The decision field exists only on these routes. The command line has no way to send it.
// requireGh false is for the resume route: the saved request holds the remote.
export function parseRequest(body, { allowed = Object.keys(FIELD_TYPES), requireGh = true } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('The body must be a JSON object.');
  const options = {};
  for (const [key, value] of Object.entries(body)) {
    if (!allowed.includes(key)) throw bad(`Unknown field: ${key.slice(0, 40)}.`);
    if (typeof value !== FIELD_TYPES[key]) throw bad(`${key} must be a ${FIELD_TYPES[key]}.`);
    if (key === 'decision') { options.decision = parseDecision(value); continue; }
    if (typeof value === 'string' && (value.length > 4096 || value.includes('\0'))) throw bad(`${key} is not valid.`);
    // An empty text field is the same as no field. A form sends empty fields.
    if (value === '' && key !== 'slug') continue;
    options[key] = value;
  }
  if (options.remote !== undefined && options.remote !== 'gh' && options.remote !== 'none') {
    // The message never holds the URL: a URL can hold a credential.
    try { validateRemoteUrl(options.remote); } catch (error) { if (error instanceof RemoteError) throw bad(error.message); throw error; }
  }
  if (options.visibility !== undefined && !['private', 'public'].includes(options.visibility)) throw bad('visibility must be private or public.');
  if (options.visibility === 'public' && (options.remote ?? 'none') === 'none') throw bad('visibility public needs a remote that is not none.');
  if (options.decision) {
    if (requireGh && options.remote !== 'gh') throw bad('A decision needs remote gh.');
    if (options.visibility !== undefined && options.visibility !== options.decision.visibility) throw bad('The decision visibility must match the visibility field.');
  }
  if (options.kind !== undefined && !['claude', 'codex'].includes(options.kind)) throw bad('kind must be claude or codex.');
  if (options.org !== undefined && !ORG_NAME.test(options.org)) throw bad('org must be an organization or user name.');
  return options;
}

// An absolute path: a segment may hold spaces when another segment follows. A URL does not match: its slashes have no lead character.
const PATH_TOKEN = /(^|[\s"'`(=])(\/(?!\/)(?:[^/\n"'`;<>]*(?=\/)\/)*[^\s/"'`;,)<>]*)/g;
const KEEP = '\u0000';

// Remove credentials and every absolute path except the project path of the request.
export function scrub(text, projectPath) {
  let out = redact(text);
  const kept = [];
  if (projectPath) {
    const escaped = projectPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`${escaped}(?![^\\s"'\`;,)<>/])`, 'g'), () => { kept.push(projectPath); return `${KEEP}${kept.length - 1}${KEEP}`; });
  }
  out = out.replace(PATH_TOKEN, (match, lead) => `${lead}<path>`);
  return out.replace(new RegExp(`${KEEP}(\\d+)${KEEP}`, 'g'), (_, index) => kept[Number(index)]);
}

function scrubDeep(value, projectPath) {
  if (typeof value === 'string') return scrub(value, projectPath);
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, projectPath));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubDeep(item, projectPath)]));
  return value;
}

// options: dataDir, runFlow (async options => result; tests replace it), flowOptions (repoRoot, ceiling, home, herdr, hooks, env, stepRunners), maxRuns.
export function createProjectNewApi({ dataDir, runFlow = runFlowInChild, flowOptions = {}, maxRuns = MAX_RUNS, log = () => {} } = {}) {
  const runs = new Map();
  const requestFile = (slug) => path.join(dataDir, 'flows', `${slug}.request.json`);

  // The marker file exists while a run is active. After a restart, a marker without a run in memory means the run was interrupted.
  const markerFile = (slug) => path.join(dataDir, 'flows', `${slug}.running`);
  const readMarker = (slug) => { try { return JSON.parse(fs.readFileSync(markerFile(slug), 'utf8')); } catch { return null; } };
  const writeMarker = (slug, marker) => {
    fs.mkdirSync(path.dirname(markerFile(slug)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(markerFile(slug), `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  };
  const clearMarker = (slug) => { try { fs.rmSync(markerFile(slug), { force: true }); } catch {} };
  // Keep the newest 20 finished runs in memory. The state file still answers for the others.
  function prune() {
    const finished = [...runs].filter(([, run]) => !run.running).sort((a, b) => String(a[1].finishedAt).localeCompare(String(b[1].finishedAt)));
    for (const [slug] of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) runs.delete(slug);
  }

  // The options of the run that are not part of the state file. Resume needs them again.
  function saveRequest(slug, options) {
    const picked = Object.fromEntries(OPTION_FIELDS.filter((key) => options[key] !== undefined).map((key) => [key, options[key]]));
    fs.mkdirSync(path.dirname(requestFile(slug)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(requestFile(slug), `${JSON.stringify(picked)}\n`, { mode: 0o600 });
  }
  function loadRequest(slug) {
    const record = runs.get(slug)?.options;
    if (record) return Object.fromEntries(OPTION_FIELDS.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));
    try { return JSON.parse(fs.readFileSync(requestFile(slug), 'utf8')); } catch { return {}; }
  }

  // The dry run checks the inputs and the state before the run starts. A refusal is a 400.
  function dryRun(options) {
    try { return runProjectNew({ ...flowOptions, ...options, dataDir, dryRun: true }); } catch (error) {
      if (error instanceof ProjectNewError) throw bad(scrub(error.message, null));
      throw error;
    }
  }

  function begin(options, { resume }) {
    const { slug } = options;
    if (runs.get(slug)?.running) throw new ApiError(409, `A run of ${slug} is already running.`);
    if ([...runs.values()].filter((run) => run.running).length >= maxRuns) throw new ApiError(429, `${maxRuns} runs are already running. Try again when one ends.`);
    const flow = { ...options, resume, dataDir };
    const preview = dryRun(flow);
    const record = { running: true, startedAt: new Date().toISOString(), options: flow, projectPath: preview.path, result: null, error: null };
    runs.set(slug, record);
    try { saveRequest(slug, flow); writeMarker(slug, { startedAt: record.startedAt, path: preview.path }); } catch (error) { runs.delete(slug); throw error; }
    Promise.resolve()
      .then(() => runFlow({ ...flowOptions, ...flow }))
      .then((result) => { record.result = result; })
      .catch((error) => {
        record.error = scrub(error.message, record.projectPath);
        try { markFlowCrashed(dataDir, slug, record.error); } catch (writeError) { log('error', `Project flow ${slug}: the state file was not updated: ${writeError.message}`); }
        log('error', `Project flow ${slug} stopped: ${record.error}`);
      })
      .finally(() => { clearMarker(slug); record.running = false; record.finishedAt = new Date().toISOString(); prune(); });
    return { status: 202, body: { ok: true, slug, state: 'running', url: `/api/project-new/${slug}` } };
  }

  function statusOf(slug) {
    const state = readFlowState(dataDir, slug);
    const record = runs.get(slug);
    const marker = record?.running ? null : readMarker(slug);
    if (!state && !record && !marker) return null;
    const projectPath = state?.inputs?.path ?? record?.projectPath ?? marker?.path ?? null;
    const saved = state?.steps ?? {};
    const lines = new Map((record?.result?.steps ?? []).filter((step) => step.lines?.length).map((step) => [step.name, step.lines]));
    let next = true;
    const steps = PROJECT_NEW_STEPS.map((name) => {
      if (saved[name]) return { name, status: saved[name].status, detail: saved[name].detail, ...(lines.has(name) ? { lines: lines.get(name) } : {}) };
      if (NOT_BUILT.has(name)) return { name, status: 'not-built', detail: 'not built yet' };
      const active = next && record?.running;
      next = false;
      return { name, status: active ? 'running' : 'pending', detail: '' };
    });
    const running = Boolean(record?.running);
    const waitingStep = steps.find((step) => step.status === 'waiting');
    const failedStep = steps.find((step) => step.status === 'failed');
    const finished = steps.every((step) => ['done', 'skipped', 'not-built'].includes(step.status));
    let overall = 'idle';
    if (running) overall = 'running';
    else if (marker) overall = 'interrupted';
    else if (failedStep || record?.error) overall = 'failed';
    else if (waitingStep) overall = 'waiting';
    else if (finished) overall = 'done';
    const item = state?.ids?.remoteAsk?.id ?? /mailbox item (\S+)/.exec(waitingStep?.detail ?? '')?.[1] ?? null;
    const exitCode = { running: null, interrupted: 1, failed: 1, waiting: EXIT_WAITING, done: 0, idle: null }[overall];
    return scrubDeep({
      ok: true,
      slug,
      state: overall,
      running,
      exitCode,
      path: projectPath,
      steps,
      waiting: overall === 'waiting' ? { reason: WAITING_REASON, item } : null,
      error: overall === 'failed' ? (record?.error ?? failedStep?.detail ?? null)
        : overall === 'interrupted' ? 'The run was interrupted, for example by a restart of the service. Call the resume route.' : null,
      startedAt: record?.startedAt ?? state?.createdAt ?? null,
      updatedAt: state?.updatedAt ?? null,
    }, projectPath);
  }

  function checkOf(slug) {
    const result = checkProject(slug, { dataDir, herdr: flowOptions.herdr, home: flowOptions.home });
    return scrubDeep({ ok: result.ok, slug: result.slug, path: result.path, items: result.items }, result.path);
  }

  // Serve one request. readBody() gives the parsed JSON body and runs only for a POST route.
  // Returns { status, body }.
  async function handle(method, pathname, readBody) {
    try {
      const parts = pathname.split('/').filter(Boolean).slice(2);
      const only = (...allowed) => { if (!allowed.includes(method)) throw new ApiError(405, `The route ${pathname} does not accept ${method}.`); };
      if (parts.length === 0) {
        only('POST');
        const options = parseRequest(await readBody());
        resolveInputs(options);
        return begin({ ...options, start: options.start === true }, { resume: false });
      }
      const [first, second] = parts;
      if (parts.length === 1 && first === 'plan' && method === 'POST') {
        const options = parseRequest(await readBody());
        const result = dryRun({ ...options, start: options.start === true });
        return { status: 200, body: scrubDeep({ ok: true, dryRun: true, slug: result.slug, path: result.path, steps: result.steps }, result.path) };
      }
      if (parts.length > 2) throw new ApiError(404, 'not found');
      if (!SLUG.test(first)) throw bad('The slug must match [a-z0-9][a-z0-9-]{0,63}.');
      if (parts.length === 1) {
        only('GET');
        const status = statusOf(first);
        if (!status) throw new ApiError(404, `There is no flow for ${first}.`);
        return { status: 200, body: status };
      }
      if (second === 'check') { only('GET'); return { status: 200, body: checkOf(first) }; }
      if (second === 'resume') {
        only('POST');
        const body = parseRequest(await readBody(), { allowed: [...OPTION_FIELDS, 'decision'], requireGh: false });
        if (runs.get(first)?.running) throw new ApiError(409, `A run of ${first} is already running.`);
        const state = readFlowState(dataDir, first);
        if (!state?.inputs) throw new ApiError(404, `There is no state for ${first}. Nothing to resume.`);
        const { name, goal } = state.inputs;
        const options = { slug: first, path: state.inputs.path, name, goal, ...loadRequest(first), ...body };
        return begin(options, { resume: true });
      }
      throw new ApiError(404, 'not found');
    } catch (error) {
      if (error instanceof ApiError) return { status: error.status, body: { ok: false, error: error.message, ...error.extra } };
      if (error instanceof ProjectNewError) return { status: 400, body: { ok: false, error: scrub(error.message, null) } };
      // The body reader of the server sets statusCode: 400 for a bad body, 413 for a large one.
      if (Number.isInteger(error.statusCode)) return { status: error.statusCode, body: { ok: false, error: error.message } };
      // An unexpected error: log it here, and send a message without credentials and without absolute paths.
      log('error', `Project route ${method} ${scrub(pathname, null)} failed: ${scrub(error.message, null)}`);
      return { status: 500, body: { ok: false, error: scrub(error.message, null) } };
    }
  }

  return { handle, stats: () => ({ tracked: runs.size, running: [...runs.values()].filter((run) => run.running).length }) };
}
