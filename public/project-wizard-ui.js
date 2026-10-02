// The controller of the New project wizard. It holds the state, calls the project new routes, and polls the status.
// It has no DOM use of its own. The page gives it a view (patch, focusFirst, isOpen, show, hide), a fetch function,
// a storage, timers, and a confirm function, so the Node tests drive it with fakes.
import { WIZARD_STEPS, DRAFT_KEY, emptyDraft, hasContent, validateStep, toRequest, wizardHtml, progressHtml, isSettled, saveDraft, loadDraft } from './project-wizard.js';

export const POLL_MS = 2000;
export const BACKOFF_MS = [2000, 4000, 8000];
export const MAX_FAILURES = 10;
export const NETWORK_MESSAGE = 'The service is not reachable. It may be restarting. Try again in a moment.';
const STATUS_MESSAGE = { 401: 'Sign in again.', 403: 'This action is not allowed here.', 404: 'The project was not found.', 409: 'The request conflicts with a run that is active.', 429: 'Too many runs are active. Try again when one ends.' };

// The sentence for a failed response. The API sentence is used for 400, 404, 409, and 429. A 5xx never shows the API text.
export function failureMessage(status, apiError) {
  const api = typeof apiError === 'string' && apiError.trim() ? apiError : '';
  if (status === 401 || status === 403) return STATUS_MESSAGE[status];
  if (status >= 500) return 'The service reported an error.';
  if ([400, 404, 409, 429].includes(status)) return api || STATUS_MESSAGE[status] || 'The request was refused.';
  return api || 'The request failed.';
}

const failure = (message, extra) => Object.assign(new Error(message), extra);

export function createWizard({ view, fetchJson, storage, setTimer, clearTimer, confirmClose, suggestedGroup = () => '' }) {
  const w = { draft: null, step: 'name', errors: [], plan: null, planning: false, busy: false, message: '', readOnly: false, run: null, check: null, timer: null, focus: false, stalled: false, failures: 0 };

  function render() {
    const html = w.run
      ? progressHtml(w.run, { check: w.check, busy: w.busy, message: w.message, stalled: w.stalled })
      : wizardHtml({ draft: w.draft, step: w.step, errors: w.errors, plan: w.plan, planning: w.planning, busy: w.busy, message: w.message, readOnly: w.readOnly });
    view.patch(html);
    if (w.focus) { w.focus = false; view.focusFirst(); }
  }

  // One request. A thrown fetch error becomes a fixed sentence: the text of the network layer is never shown.
  async function call(method, url, body) {
    let response;
    try { response = await fetchJson(method, url, body); } catch { throw failure(NETWORK_MESSAGE, { network: true }); }
    const { status, json } = response;
    if (status === 403 && /read-only/i.test(json?.error || '')) { w.readOnly = true; throw failure(json.error, { status }); }
    if (status < 200 || status >= 300) throw failure(failureMessage(status, json?.error), { status });
    return json ?? {};
  }

  function stopPolling() { if (w.timer !== null) clearTimer(w.timer); w.timer = null; }

  async function open() {
    if (!w.draft) w.draft = loadDraft(storage);
    if (w.draft.folderMode === 'group' && !w.draft.group && !w.draft.path) w.draft.group = suggestedGroup();
    w.errors = []; w.message = ''; w.focus = true;
    if (!view.isOpen()) view.show();
    render();
    if (w.run) { if (!isSettled(w.run)) poll(); return; }
    // The preview refuses every project new route with a 403. A normal service answers 404 for a slug that has no flow.
    try { await call('GET', '/api/project-new/wizard-probe'); } catch { /* Only the read-only flag matters here. */ }
    if (w.readOnly) render();
  }

  // Escape and Close. A form with content asks first. A finished run is cleared.
  async function close() {
    if (!w.run && !w.readOnly && hasContent(w.draft) && !(await confirmClose())) return false;
    if (w.run && w.run.state === 'done') w.run = null;
    stopPolling();
    if (view.isOpen()) view.hide();
    return true;
  }

  function discard() {
    stopPolling();
    Object.assign(w, { run: null, check: null, plan: null, step: 'name', message: '', errors: [], stalled: false, failures: 0, draft: emptyDraft(), focus: true });
    w.draft.group = suggestedGroup();
    try { storage.removeItem(DRAFT_KEY); } catch { /* Storage can be off. */ }
    render();
  }

  function next() {
    if (w.readOnly || w.run) return;
    w.errors = validateStep(w.step, w.draft);
    w.plan = null;
    if (w.errors.length) { render(); return; }
    w.step = WIZARD_STEPS[Math.min(WIZARD_STEPS.length - 1, WIZARD_STEPS.indexOf(w.step) + 1)];
    w.focus = true;
    if (w.step === 'review') plan(); else render();
  }

  function back() {
    w.errors = [];
    w.step = WIZARD_STEPS[Math.max(0, WIZARD_STEPS.indexOf(w.step) - 1)];
    w.focus = true;
    render();
  }

  async function plan() {
    w.planning = true; w.errors = []; w.plan = null; render();
    try { w.plan = await call('POST', '/api/project-new/plan', toRequest(w.draft)); } catch (error) { w.errors = [error.message]; }
    w.planning = false;
    render();
  }

  async function create() {
    if (w.busy) return;
    w.busy = true; w.message = ''; render();
    try {
      const started = await call('POST', '/api/project-new', toRequest(w.draft));
      w.run = { ok: true, slug: started.slug, state: 'running', path: w.plan?.path ?? null, steps: [], error: null, waiting: null };
      w.check = null; w.stalled = false; w.failures = 0;
      try { storage.removeItem(DRAFT_KEY); } catch { /* Storage can be off. */ }
      w.busy = false; w.focus = true; render();
      poll();
    } catch (error) { w.busy = false; w.errors = [error.message]; render(); }
  }

  // Read the status every 2 seconds until the run is done, failed, waiting, or interrupted.
  // A 401 or 403 stops the poll. Other failures retry after 2, 4, and 8 seconds; 10 failures in a row stop the poll.
  function poll() {
    stopPolling();
    const slug = w.run.slug;
    w.stalled = false; w.failures = 0;
    const tick = async () => {
      w.timer = null;
      let delay = POLL_MS;
      try {
        const status = await call('GET', `/api/project-new/${encodeURIComponent(slug)}`);
        if (w.run?.slug !== slug) return;
        w.run = status; w.message = ''; w.failures = 0;
        if (isSettled(status)) { render(); return; }
      } catch (error) {
        if (w.run?.slug !== slug) return;
        w.message = error.message;
        if (error.status === 401 || error.status === 403) { w.stalled = true; render(); return; }
        w.failures += 1;
        if (w.failures >= MAX_FAILURES) { w.stalled = true; w.message = `${error.message} Polling stopped. Select Check or Resume when the service is back.`; render(); return; }
        delay = BACKOFF_MS[Math.min(w.failures - 1, BACKOFF_MS.length - 1)];
      }
      render();
      w.timer = setTimer(tick, delay);
    };
    w.timer = setTimer(tick, 0);
  }

  async function resume() {
    if (w.busy || !w.run) return;
    w.busy = true; w.message = ''; render();
    try {
      await call('POST', `/api/project-new/${encodeURIComponent(w.run.slug)}/resume`, {});
      w.run = { ...w.run, state: 'running', error: null, waiting: null };
      w.busy = false; render();
      poll();
    } catch (error) { w.busy = false; w.message = error.message; render(); }
  }

  async function check() {
    if (w.busy || !w.run) return;
    w.busy = true; w.message = ''; render();
    try { w.check = await call('GET', `/api/project-new/${encodeURIComponent(w.run.slug)}/check`); } catch (error) { w.message = error.message; }
    w.busy = false;
    render();
  }

  // Copy one field into the draft, then save the draft.
  const FIELDS = { 'wiz-slug': 'slug', 'wiz-name': 'name', 'wiz-group': 'group', 'wiz-path': 'path', 'wiz-url': 'url', 'wiz-confirm-public': 'confirmPublic', 'wiz-org': 'org', 'wiz-goal': 'goal', 'wiz-kind': 'kind' };
  function read(el) {
    const d = w.draft;
    if (FIELDS[el.id]) d[FIELDS[el.id]] = el.value;
    else if (el.id === 'wiz-start') d.start = el.checked;
    else if (['folderMode', 'remote', 'visibility'].includes(el.name)) d[el.name] = el.value;
    else return false;
    saveDraft(storage, d);
    // The next button depends on the typed word, so the form renders again. The page patch keeps the focus and the caret.
    if (el.id === 'wiz-confirm-public') render();
    return true;
  }

  return { state: w, render, open, close, discard, next, back, plan, create, poll, resume, check, read, stopPolling };
}
