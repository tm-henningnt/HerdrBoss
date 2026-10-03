// The controller of the "Add a host" page. It holds the state, calls the host-guide routes, and keeps the page up to date.
// createHostGuide has no DOM use: the Node tests give it a fetch function and a timer. mountHostGuide binds it to the page.
import { HOST_TYPES } from './host-guide-data.js';
import { checkField, normalizeField, substitute, missingPlaceholders } from './host-guide-fields.js';
import { pageHtml, answersHtml, commandCodeHtml, checkRowHtml, HOST_GUIDE_PATH } from './host-guide-view.js';

export const SAVE_DELAY_MS = 600;
export const POLL_MS = 10000;
export const NETWORK_MESSAGE = 'The service is not reachable. It may be restarting. Try again in a moment.';
const STATUS_MESSAGE = { 401: 'Sign in again.', 403: 'The host guide needs the Owner session. Open the dashboard on the machine that runs Herdr Boss, or sign in.', 404: 'The guide was not found.', 405: 'The service refused this request.', 409: 'The request conflicts with the saved guide.', 413: 'The request is too large.' };

export function failureMessage(status, apiError) {
  if (status === 403 && /read-only/i.test(apiError || '')) return apiError;
  if (status >= 500) return 'The service reported an error.';
  if ([400, 409, 404].includes(status) && typeof apiError === 'string' && apiError.trim()) return apiError;
  return STATUS_MESSAGE[status] || 'The request failed.';
}

const emptyGuide = (label, type) => ({ label, type, values: { label }, done: {}, checks: {}, terminate: null, reboot: null });

export function createHostGuide({ fetchJson, setTimer = setTimeout, clearTimer = clearTimeout, search = '', onChange = () => {} }) {
  const c = { loading: true, screen: 'chooser', list: [], hosts: [], checks: [], guide: null, local: false, message: '', answers: false, busy: '', draft: { type: HOST_TYPES[0].id, label: '' } };
  let pending = {};
  let timer = null;

  const say = (message) => { c.message = message; };
  async function call(method, url, body) {
    let response;
    try { response = await fetchJson(method, url, body); } catch { throw Object.assign(new Error(NETWORK_MESSAGE), { network: true }); }
    if (response.status < 200 || response.status >= 300) {
      if (response.status === 403 && /read-only/i.test(response.json?.error || '')) c.local = true;
      throw Object.assign(new Error(failureMessage(response.status, response.json?.error)), { status: response.status });
    }
    return response.json;
  }
  const adopt = (body) => {
    // Keep what the user typed and the service has not saved yet: a value in the queue, or a value with a wrong format.
    const mine = c.guide?.values || {};
    const keep = Object.entries(mine).filter(([id, value]) => id in pending || (value !== '' && !checkField(id, value).ok));
    c.guide = { ...body.state, values: { ...body.state.values, ...Object.fromEntries(keep) } };
  };

  async function load() {
    c.loading = true;
    try {
      const body = await call('GET', '/api/host-guide');
      c.list = body.guides; c.hosts = body.hosts; c.checks = body.checks;
    } catch (error) {
      if (!c.local) say(error.message);
    }
    c.loading = false;
    const params = new URLSearchParams(search);
    const host = params.get('host');
    const type = HOST_TYPES.find((item) => item.id === params.get('type'))?.id;
    if (type) c.draft.type = type;
    if (host && /^[a-z0-9][a-z0-9-]{0,30}$/.test(host)) {
      if (c.list.some((row) => row.label === host)) await open(host);
      else {
        c.draft.label = host;
        // The preview keeps no file. A link with a host and a type opens a guide in memory.
        if (c.local && type) await start();
      }
    }
    onChange('all');
  }

  const selectType = (id) => { if (HOST_TYPES.some((type) => type.id === id)) c.draft.type = id; };
  function setStartLabel(value) { c.draft.label = String(value).trim(); return checkField('label', c.draft.label); }

  async function start() {
    const { label, type } = c.draft;
    const result = checkField('label', label);
    if (!label || !result.ok) { say(label ? result.message : 'Type a machine label first.'); onChange('all'); return; }
    if (c.local) { c.guide = emptyGuide(label, type); c.screen = 'guide'; say(''); onChange('all'); return; }
    try {
      adopt(await call('PUT', `/api/host-guide/${label}`, { type }));
      c.screen = 'guide'; say('');
      await refreshList();
    } catch (error) {
      if (error.status === 409 || error.status === 400) say(error.message); else say(error.message);
      if (c.local) { c.guide = emptyGuide(label, type); c.screen = 'guide'; say(''); }
    }
    onChange('all');
  }

  async function open(label) {
    try { adopt(await call('GET', `/api/host-guide/${label}`)); c.screen = 'guide'; say(''); } catch (error) { say(error.message); }
    onChange('all');
  }

  async function refreshList() {
    try { const body = await call('GET', '/api/host-guide'); c.list = body.guides; c.hosts = body.hosts; c.checks = body.checks; } catch { /* The list stays as it was. */ }
  }

  // The live format check. A valid value is saved after a short pause. An invalid value stays on the page and is not sent.
  function setValue(id, raw) {
    const result = checkField(id, raw);
    const text = String(raw ?? '');
    c.guide.values = { ...c.guide.values };
    if (text.trim() === '') delete c.guide.values[id]; else c.guide.values[id] = result.ok ? normalizeField(id, text) : text;
    if (result.ok && !c.local) {
      pending[id] = normalizeField(id, text);
      clearTimer(timer);
      timer = setTimer(() => { void flush(); }, SAVE_DELAY_MS);
    } else delete pending[id];
    return result;
  }

  async function flush() {
    clearTimer(timer); timer = null;
    if (!c.guide || c.local || !Object.keys(pending).length) return;
    const sent = pending; pending = {};
    try { await call('PUT', `/api/host-guide/${c.guide.label}`, { values: sent }); say(''); } catch (error) { pending = { ...sent, ...pending }; say(error.message); onChange('message'); }
  }

  async function setDone(step, done) {
    if (c.local) return false;
    await flush();
    try { adopt(await call('PUT', `/api/host-guide/${c.guide.label}`, { done: { [step]: done } })); say(''); onChange('all'); return true; } catch (error) { say(error.message); onChange('done-failed'); return false; }
  }

  async function run(kind = 'all') {
    if (c.local || c.busy) return;
    await flush();
    c.busy = 'check'; onChange('tests');
    try { adopt(await call('POST', `/api/host-guide/${c.guide.label}/check`, { check: kind })); say(''); } catch (error) { say(error.message); }
    c.busy = ''; onChange('all');
  }

  async function action(name) {
    if (c.local || c.busy) return;
    c.busy = 'action'; onChange('tests');
    try { adopt(await call('POST', `/api/host-guide/${c.guide.label}/action`, { action: name })); say(''); } catch (error) { say(error.message); }
    c.busy = ''; onChange('all');
  }

  async function remove() {
    if (!c.guide || c.local) return;
    try { await call('DELETE', `/api/host-guide/${c.guide.label}`); c.guide = null; c.screen = 'chooser'; say('The guide is deleted.'); await refreshList(); } catch (error) { say(error.message); }
    onChange('all');
  }

  async function back() { await flush(); c.guide = null; c.screen = 'chooser'; c.answers = false; say(''); await refreshList(); onChange('all'); }
  const toggleAnswers = () => { c.answers = !c.answers; };
  // The kind of timed test that needs a new reading, or null.
  const waiting = () => (['terminate', 'reboot'].find((kind) => c.guide?.[kind]?.status === 'waiting') ?? null);

  return { state: c, load, selectType, setStartLabel, start, open, setValue, flush, setDone, run, action, remove, back, toggleAnswers, waiting };
}

const defaultFetchJson = async (method, url, body) => {
  const response = await fetch(url, { method, headers: { 'x-herdr-boss-caller': 'page', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await response.json(); } catch { /* No body. */ }
  return { status: response.status, json };
};

// Update the commands and the answers after a value changes. The fields keep their focus: only the text around them changes.
export function refreshCommands(root, values) {
  for (const cmd of root.querySelectorAll('[data-hg-cmd]')) {
    const template = cmd.getAttribute('data-template');
    cmd.querySelector('code').innerHTML = commandCodeHtml(template, values);
    const button = cmd.querySelector('[data-copy-text]');
    if (button) button.setAttribute('data-copy-text', substitute(template, values));
    const note = cmd.querySelector('.hg-ph-note');
    if (note) note.hidden = missingPlaceholders(template, values).length === 0;
  }
}

function markField(root, id, result, value) {
  const wrap = root.querySelector(`[data-hg-wrap="${id}"]`);
  if (!wrap) return;
  wrap.setAttribute('data-state', String(value).trim() === '' ? 'empty' : result.ok ? 'ok' : 'bad');
  const message = wrap.querySelector('.hg-msg');
  if (message) message.textContent = result.message;
}

// One controller serves the page for the whole session. A render of the dashboard can replace the root element.
// The next mount binds the same controller to the new element, so the typed values and the progress stay.
let shared = null;

export function mountHostGuide(root, { fetchJson = defaultFetchJson, search = globalThis.location?.search || '', confirmDelete = (text) => globalThis.confirm(text) } = {}) {
  let polling = null;
  if (!shared) {
    shared = { view: () => {} };
    shared.guide = createHostGuide({ fetchJson, search, onChange: (kind) => shared.view(kind) });
    shared.fresh = true;
  }
  const guide = shared.guide;
  const state = guide.state;

  function render() {
    const active = document.activeElement;
    const names = ['data-hg-run', 'data-hg-action', 'data-hg-start', 'data-hg-show-answers'];
    const hit = names.map((name) => { const el = active?.closest?.(`[${name}]`); return el ? `[${name}${el.getAttribute(name) ? `="${el.getAttribute(name)}"` : ''}]` : null; }).find(Boolean);
    const open = [...root.querySelectorAll('details')].map((el) => el.open);
    root.innerHTML = pageHtml({ ...state, loading: state.loading });
    root.querySelectorAll('details').forEach((el, index) => { if (open[index]) el.open = true; });
    if (hit) root.querySelector(hit)?.focus({ preventScroll: true });
  }

  // A step that is not the next one cannot be marked done. The page shows this without a request.
  function syncDone() {
    const done = Object.keys(state.guide?.done || {}).length;
    const steps = [...root.querySelectorAll('[data-step]')];
    root.querySelectorAll('[data-hg-done]').forEach((box) => {
      const step = box.closest('[data-step]');
      const isDone = !!state.guide.done[step.dataset.step];
      box.checked = isDone;
      box.disabled = !isDone && steps.indexOf(step) > done;
    });
  }

  function schedulePoll() {
    clearInterval(polling); polling = null;
    if (!state.guide || !guide.waiting()) return;
    polling = setInterval(() => {
      if (!root.isConnected) { clearInterval(polling); polling = null; return; }
      if (!document.hidden && guide.waiting() && !state.busy) void guide.run(guide.waiting());
    }, POLL_MS);
  }

  shared.view = (kind) => {
    if (kind === 'message' || kind === 'done-failed') {
      const el = root.querySelector('[data-hg-message]');
      if (el) el.textContent = state.message;
      if (kind === 'done-failed') syncDone();
      return;
    }
    render();
    schedulePoll();
    // A link with a step in the address (for example #step-8) scrolls to that step once the guide shows.
    if (state.guide && location.hash && !shared.scrolled) { shared.scrolled = true; document.getElementById(location.hash.slice(1))?.scrollIntoView(); }
  };

  root.addEventListener('click', (event) => {
    const hit = (name) => event.target.closest?.(`[${name}]`);
    if (hit('data-hg-start')) void guide.start();
    else if (hit('data-hg-open')) void guide.open(hit('data-hg-open').getAttribute('data-hg-open'));
    else if (hit('data-hg-back')) void guide.back();
    else if (hit('data-hg-run')) void guide.run(hit('data-hg-run').getAttribute('data-hg-run'));
    else if (hit('data-hg-action')) void guide.action(hit('data-hg-action').getAttribute('data-hg-action'));
    else if (hit('data-hg-show-answers')) { guide.toggleAnswers(); render(); }
    else if (hit('data-hg-delete')) { if (confirmDelete('Delete this guide and all values that it saved? You cannot undo this.')) void guide.remove(); }
  });
  root.addEventListener('change', (event) => {
    const target = event.target;
    if (target.matches?.('[data-hg-type]')) guide.selectType(target.value);
    else if (target.matches?.('[data-hg-done]')) void guide.setDone(target.getAttribute('data-hg-done'), target.checked);
    else if (target.matches?.('[data-hg-field]')) void guide.flush();
  });
  root.addEventListener('input', (event) => {
    const target = event.target;
    if (target.matches?.('[data-hg-field]')) {
      const id = target.getAttribute('data-hg-field');
      const result = guide.setValue(id, target.value);
      markField(root, id, result, target.value);
      refreshCommands(root, state.guide.values);
      const answers = root.querySelector('[data-hg-answers]');
      if (answers && state.answers) answers.outerHTML = answersHtml({ ...state });
    } else if (target.matches?.('[data-hg-start-label]')) markField(root, 'label', guide.setStartLabel(target.value), target.value);
  });

  render();
  schedulePoll();
  if (shared.fresh) { shared.fresh = false; void guide.load(); }
  return { guide, unmount: () => { clearInterval(polling); root.replaceChildren(); } };
}

export { HOST_GUIDE_PATH, checkRowHtml };
