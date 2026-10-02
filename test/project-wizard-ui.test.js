import test from 'node:test';
import assert from 'node:assert/strict';
import { createWizard, failureMessage, NETWORK_MESSAGE, MAX_FAILURES } from '../public/project-wizard-ui.js';
import { DRAFT_KEY, emptyDraft } from '../public/project-wizard.js';

// A fake page: a view that records the HTML, a scripted fetch, a manual timer queue, and a memory storage.
function setup({ responses = [], content = false, confirmAnswer = true, suggestedGroup } = {}) {
  const calls = [];
  const queue = [];
  let ids = 0;
  const cleared = [];
  const store = new Map();
  const shown = { open: false, html: '', focus: 0, confirms: 0 };
  const script = [...responses];
  const wizard = createWizard({
    suggestedGroup,
    view: { patch: (html) => { shown.html = html; }, focusFirst: () => { shown.focus += 1; }, isOpen: () => shown.open, show: () => { shown.open = true; }, hide: () => { shown.open = false; } },
    fetchJson: async (method, url, body) => {
      calls.push({ method, url, body });
      const next = script.length ? script.shift() : { status: 404, json: { error: 'There is no flow.' } };
      if (next instanceof Error) throw next;
      return next;
    },
    storage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    setTimer: (fn, ms) => { const id = ++ids; queue.push({ id, fn, ms }); return id; },
    clearTimer: (id) => { cleared.push(id); const at = queue.findIndex((t) => t.id === id); if (at >= 0) queue.splice(at, 1); },
    confirmClose: async () => { shown.confirms += 1; return confirmAnswer; },
  });
  if (content) { wizard.state.draft = { ...emptyDraft(), slug: 'demo' }; }
  // Run the queued timer and wait for its async work.
  const fire = async () => { const t = queue.shift(); assert.ok(t, 'a timer is queued'); await t.fn(); return t; };
  return { wizard, calls, queue, cleared, shown, script, fire, store };
}

const running = { status: 200, json: { ok: true, slug: 'demo', state: 'running', steps: [{ name: 'validate', status: 'running', detail: '' }] } };
const done = { status: 200, json: { ok: true, slug: 'demo', state: 'done', steps: [{ name: 'validate', status: 'done', detail: 'ok' }] } };
const start = async (t, replies) => {
  t.script.push(...replies);
  t.wizard.state.draft = { ...emptyDraft(), slug: 'demo', group: '/tmp/g' };
  t.wizard.state.plan = { path: '/tmp/g/demo', steps: [] };
  await t.wizard.create();
};

test('failureMessage maps each status to a fixed sentence', () => {
  assert.equal(failureMessage(401, '<html>'), 'Sign in again.');
  assert.equal(failureMessage(403, 'raw'), 'This action is not allowed here.');
  assert.equal(failureMessage(404, 'There is no flow for x.'), 'There is no flow for x.');
  assert.equal(failureMessage(409, 'A run of x is already running.'), 'A run of x is already running.');
  assert.equal(failureMessage(429, '2 runs are already running.'), '2 runs are already running.');
  assert.equal(failureMessage(400, 'The slug is taken.'), 'The slug is taken.');
  assert.equal(failureMessage(502, 'stack trace /Users/x'), 'The service reported an error.');
  assert.equal(failureMessage(404, ''), 'The project was not found.');
});

test('the wizard uses the current project root suggestion and keeps explicit saved folders', async () => {
  let root = '/tmp/projects one';
  const t = setup({ suggestedGroup: () => root });
  await t.wizard.open();
  assert.equal(t.wizard.state.draft.group, root);
  t.wizard.state.draft.group = '/tmp/explicit group';
  await t.wizard.open();
  assert.equal(t.wizard.state.draft.group, '/tmp/explicit group');
  root = '/tmp/projects two';
  t.wizard.discard();
  assert.equal(t.wizard.state.draft.group, root);
  const saved = setup({ suggestedGroup: () => root });
  saved.store.set(DRAFT_KEY, JSON.stringify({ ...emptyDraft(), folderMode: 'path', path: '/tmp/explicit/path' }));
  await saved.wizard.open();
  assert.equal(saved.wizard.state.draft.path, '/tmp/explicit/path');
  assert.equal(saved.wizard.state.draft.group, '');
});

test('a non-JSON 401 shows Sign in again, and a thrown fetch shows the fixed network sentence', async () => {
  const t = setup({ responses: [{ status: 401, json: null }] });
  t.wizard.state.draft = { ...emptyDraft(), slug: 'demo', group: '/tmp/g' };
  await t.wizard.plan();
  assert.deepEqual(t.wizard.state.errors, ['Sign in again.']);
  t.script.push(new TypeError('Failed to fetch: ECONNREFUSED 127.0.0.1:4477'));
  await t.wizard.plan();
  assert.deepEqual(t.wizard.state.errors, [NETWORK_MESSAGE]);
  assert.doesNotMatch(t.shown.html, /ECONNREFUSED|Failed to fetch/);
});

test('the polling stops when the state is settled', async () => {
  const t = setup();
  await start(t, [{ status: 202, json: { ok: true, slug: 'demo' } }, running, done]);
  assert.equal(t.queue.length, 1);
  assert.equal((await t.fire()).ms, 0);
  assert.equal(t.queue.length, 1, 'a running state schedules the next read');
  assert.equal(t.queue[0].ms, 2000);
  await t.fire();
  assert.equal(t.queue.length, 0, 'a done state schedules nothing');
  assert.equal(t.wizard.state.run.state, 'done');
});

for (const state of ['failed', 'waiting', 'interrupted']) {
  test(`the polling stops on the state ${state}`, async () => {
    const t = setup();
    await start(t, [{ status: 202, json: { slug: 'demo' } }, { status: 200, json: { ok: true, slug: 'demo', state, steps: [] } }]);
    await t.fire();
    assert.equal(t.queue.length, 0);
  });
}

for (const status of [401, 403]) {
  test(`the polling stops on ${status} and shows the sentence with Resume and Check`, async () => {
    const t = setup();
    await start(t, [{ status: 202, json: { slug: 'demo' } }, { status, json: null }]);
    await t.fire();
    assert.equal(t.queue.length, 0);
    assert.equal(t.wizard.state.message, status === 401 ? 'Sign in again.' : 'This action is not allowed here.');
    assert.match(t.shown.html, /data-wizard="resume"/);
    assert.match(t.shown.html, /data-wizard="check"/);
  });
}

test('a network error retries after 2, 4, 8, and 8 seconds and a success resets the count', async () => {
  const t = setup();
  const net = () => new TypeError('Failed to fetch');
  await start(t, [{ status: 202, json: { slug: 'demo' } }, net(), net(), net(), net(), running, net()]);
  await t.fire();
  const delays = [t.queue[0].ms];
  for (let i = 0; i < 3; i += 1) { await t.fire(); delays.push(t.queue[0].ms); }
  assert.deepEqual(delays, [2000, 4000, 8000, 8000]);
  await t.fire();
  assert.equal(t.wizard.state.failures, 0, 'the success reset the count');
  await t.fire();
  assert.equal(t.queue[0].ms, 2000, 'the first failure after a success waits 2 seconds');
});

test(`${MAX_FAILURES} failures in a row stop the polling with a hint`, async () => {
  const t = setup();
  await start(t, [{ status: 202, json: { slug: 'demo' } }, ...Array.from({ length: MAX_FAILURES }, () => new TypeError('Failed to fetch'))]);
  for (let i = 0; i < MAX_FAILURES; i += 1) await t.fire();
  assert.equal(t.queue.length, 0);
  assert.match(t.wizard.state.message, /Polling stopped/);
  assert.match(t.shown.html, /data-wizard="resume"/);
});

test('closing clears the timer and hides the dialog', async () => {
  const t = setup();
  t.shown.open = true;
  await start(t, [{ status: 202, json: { slug: 'demo' } }, running]);
  await t.fire();
  assert.equal(t.queue.length, 1);
  assert.equal(await t.wizard.close(), true);
  assert.equal(t.queue.length, 0, 'the queued read is cleared');
  assert.ok(t.cleared.length >= 1);
  assert.equal(t.shown.open, false);
  assert.equal(t.wizard.state.timer, null);
});

test('closing asks for a confirm only when the form has content', async () => {
  const empty = setup({ confirmAnswer: false });
  empty.shown.open = true;
  empty.wizard.state.draft = emptyDraft();
  assert.equal(await empty.wizard.close(), true);
  assert.equal(empty.shown.confirms, 0);
  assert.equal(empty.shown.open, false);

  const filled = setup({ content: true, confirmAnswer: false });
  filled.shown.open = true;
  assert.equal(await filled.wizard.close(), false);
  assert.equal(filled.shown.confirms, 1);
  assert.equal(filled.shown.open, true, 'a refused confirm keeps the dialog open');
  const yes = setup({ content: true, confirmAnswer: true });
  yes.shown.open = true;
  assert.equal(await yes.wizard.close(), true);
  assert.equal(yes.shown.open, false);
});

test('a run in progress closes without a confirm', async () => {
  const t = setup({ confirmAnswer: false });
  t.shown.open = true;
  await start(t, [{ status: 202, json: { slug: 'demo' } }]);
  assert.equal(await t.wizard.close(), true);
  assert.equal(t.shown.confirms, 0);
});

test('open shows the read-only message when the probe answers 403 read-only', async () => {
  const t = setup({ responses: [{ status: 403, json: { error: 'This read-only preview does not allow changes.' } }] });
  await t.wizard.open();
  assert.equal(t.calls[0].url, '/api/project-new/wizard-probe');
  assert.equal(t.wizard.state.readOnly, true);
  assert.match(t.shown.html, /read-only preview does not allow a new project/);
  assert.doesNotMatch(t.shown.html, /<input/);
  assert.equal(t.shown.open, true);
});

test('open keeps the form when the probe answers 404, 401, or a network error', async () => {
  for (const reply of [{ status: 404, json: { error: 'There is no flow for wizard-probe.' } }, { status: 401, json: null }, new TypeError('Failed to fetch')]) {
    const t = setup({ responses: [reply] });
    await t.wizard.open();
    assert.equal(t.wizard.state.readOnly, false);
    assert.match(t.shown.html, /id="wiz-slug"/);
  }
});

test('a 403 that is not the preview does not set the read-only flag', async () => {
  const t = setup({ responses: [{ status: 403, json: { error: 'This control plane requires a local interface.' } }] });
  await t.wizard.open();
  assert.equal(t.wizard.state.readOnly, false);
});

test('reading a field saves the draft without the URL, and discard clears it', async () => {
  const t = setup();
  await t.wizard.open();
  t.wizard.read({ id: 'wiz-slug', value: 'abc' });
  t.wizard.read({ id: 'wiz-url', value: 'https://example.com/a.git' });
  assert.match(t.store.get(DRAFT_KEY), /"slug":"abc"/);
  assert.doesNotMatch(t.store.get(DRAFT_KEY), /example\.com/);
  t.wizard.discard();
  assert.equal(t.store.has(DRAFT_KEY), false);
  assert.equal(t.wizard.state.draft.slug, '');
});

test('typing the word public renders the form again with the next button enabled, and Next moves on only with the word', async () => {
  const t = setup();
  await t.wizard.open();
  Object.assign(t.wizard.state.draft, { slug: 'demo', group: '/tmp/g', remote: 'gh' });
  t.wizard.state.step = 'remote';
  t.wizard.read({ name: 'visibility', value: 'public' });
  t.wizard.render();
  assert.match(t.shown.html, /<button type="submit" disabled/);
  t.wizard.next();
  assert.equal(t.wizard.state.step, 'remote', 'Enter without the word stays on the step');
  assert.match(t.shown.html, /Type the word public/);
  t.wizard.read({ id: 'wiz-confirm-public', value: 'publi' });
  assert.match(t.shown.html, /<button type="submit" disabled/);
  t.wizard.read({ id: 'wiz-confirm-public', value: 'public' });
  assert.match(t.shown.html, /<button type="submit">Next<\/button>/);
  assert.equal(t.store.get(DRAFT_KEY).includes('confirmPublic'), false);
  t.wizard.next();
  assert.equal(t.wizard.state.step, 'orchestrator');
});

test('the create call sends the decision, and a public one carries confirmPublic true', async () => {
  const t = setup();
  t.script.push({ status: 202, json: { ok: true, slug: 'demo' } }, running);
  t.wizard.state.draft = { ...emptyDraft(), slug: 'demo', group: '/tmp/g', visibility: 'public', confirmPublic: 'public' };
  t.wizard.state.plan = { path: '/tmp/g/demo', steps: [] };
  await t.wizard.create();
  assert.deepEqual(t.calls[0].body.decision, { visibility: 'public', source: 'wizard', confirmPublic: true });
  t.wizard.stopPolling();
});

test('a server refusal of a public choice shows the API sentence', async () => {
  const t = setup();
  t.script.push({ status: 400, json: { ok: false, error: 'A public repository needs confirmPublic true. Type the word public to confirm it.' } });
  t.wizard.state.draft = { ...emptyDraft(), slug: 'demo', group: '/tmp/g', visibility: 'public' };
  t.wizard.state.plan = { path: '/tmp/g/demo', steps: [] };
  await t.wizard.create();
  assert.match(t.shown.html, /needs confirmPublic true/);
});
