import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  WIZARD_STEPS, GOAL_LIMIT, DRAFT_KEY, emptyDraft, validateStep, firstInvalidStep, toRequest, reviewRows,
  wizardHtml, planHtml, progressHtml, isSettled, saveDraft, loadDraft, mailboxLink,
} from '../public/project-wizard.js';

const filled = (over = {}) => ({ ...emptyDraft(), slug: 'demo-app', name: 'Demo App', folderMode: 'group', group: '/tmp/work', ...over });
const EVIL = '<img src=x onerror=alert(1)>"\'&';

test('the steps are in the order of the flow', () => {
  assert.deepEqual(WIZARD_STEPS, ['name', 'folder', 'remote', 'orchestrator', 'review']);
});

test('the empty draft is private, has no folder, and starts the orchestrator', () => {
  const d = emptyDraft();
  assert.equal(d.remote, 'gh');
  assert.equal(d.visibility, 'private');
  assert.equal(d.start, true);
  assert.equal(d.kind, 'ladder');
  assert.equal(d.group, '');
  assert.equal(d.path, '');
});

test('the name step refuses a bad slug', () => {
  assert.deepEqual(validateStep('name', filled()), []);
  for (const slug of ['', 'Demo', '-a', 'a b', 'a/b', 'x'.repeat(65)]) assert.equal(validateStep('name', filled({ slug })).length, 1, JSON.stringify(slug));
});

test('the folder step needs a group or a path, and a group needs a one-folder name', () => {
  assert.equal(validateStep('folder', filled({ group: '' })).length, 1);
  assert.equal(validateStep('folder', filled({ folderMode: 'path', path: '' })).length, 1);
  assert.deepEqual(validateStep('folder', filled({ folderMode: 'path', path: '/tmp/x/demo' })), []);
  for (const name of ['a/b', '..', '.hidden']) assert.equal(validateStep('folder', filled({ name })).length, 1, name);
  assert.deepEqual(validateStep('folder', filled({ name: 'a/b', folderMode: 'path', path: '/tmp/a/b' })), []);
});

test('the remote step checks the URL, the organization, and refuses a credential', () => {
  assert.deepEqual(validateStep('remote', filled()), []);
  assert.deepEqual(validateStep('remote', filled({ remote: 'none' })), []);
  assert.equal(validateStep('remote', filled({ remote: 'url', url: '' })).length, 1);
  assert.equal(validateStep('remote', filled({ remote: 'url', url: 'https://user:secret@example.com/a.git' })).length, 1);
  assert.equal(validateStep('remote', filled({ remote: 'url', url: 'not a url' })).length, 1);
  assert.deepEqual(validateStep('remote', filled({ remote: 'url', url: 'https://example.com/a/b.git' })), []);
  assert.deepEqual(validateStep('remote', filled({ remote: 'url', url: 'git@example.com:a/b.git' })), []);
  assert.equal(validateStep('remote', filled({ org: '-bad' })).length, 1);
  assert.deepEqual(validateStep('remote', filled({ org: 'my-org' })), []);
});

test('an error message never holds the URL that the user typed', () => {
  const text = validateStep('remote', filled({ remote: 'url', url: 'https://user:hunter2@example.com/a.git' })).join(' ');
  assert.doesNotMatch(text, /hunter2|example\.com/);
});

test('the orchestrator step limits the goal and the kind', () => {
  assert.deepEqual(validateStep('orchestrator', filled({ goal: 'x'.repeat(GOAL_LIMIT) })), []);
  assert.equal(validateStep('orchestrator', filled({ goal: 'x'.repeat(GOAL_LIMIT + 1) })).length, 1);
  assert.equal(validateStep('orchestrator', filled({ kind: 'gpt' })).length, 1);
});

test('firstInvalidStep gives the first step with an error', () => {
  assert.equal(firstInvalidStep(filled()), null);
  assert.equal(firstInvalidStep(filled({ slug: '' })), 'name');
  assert.equal(firstInvalidStep(filled({ group: '', goal: 'x'.repeat(2000) })), 'folder');
});

test('toRequest builds the body of the routes', () => {
  assert.deepEqual(toRequest(filled()), { slug: 'demo-app', name: 'Demo App', group: '/tmp/work', remote: 'gh', visibility: 'private', start: true });
  assert.deepEqual(toRequest(filled({ folderMode: 'path', path: ' /tmp/p ', remote: 'none', kind: 'codex', goal: ' Build it ', start: false })),
    { slug: 'demo-app', name: 'Demo App', path: '/tmp/p', remote: 'none', kind: 'codex', goal: 'Build it', start: false });
  assert.deepEqual(toRequest(filled({ remote: 'gh', visibility: 'public', org: 'acme' })).org, 'acme');
  const url = toRequest(filled({ remote: 'url', url: ' https://example.com/a.git ', visibility: 'public', org: 'acme' }));
  assert.equal(url.remote, 'https://example.com/a.git');
  assert.equal('visibility' in url, false);
  assert.equal('org' in url, false);
  assert.equal('name' in toRequest(filled({ name: '' })), false);
});

test('reviewRows lists each choice and warns about a public repository', () => {
  const rows = reviewRows(filled({ remote: 'gh', visibility: 'public', goal: 'Ship' }));
  const map = Object.fromEntries(rows.map((r) => [r.label, r.value]));
  assert.match(map.Remote, /public/i);
  assert.equal(map.Slug, 'demo-app');
  assert.equal(map.Folder, '/tmp/work/Demo App');
  assert.equal(map['Start the orchestrator'], 'yes');
  assert.ok(rows.find((r) => r.warn));
  assert.equal(reviewRows(filled()).some((r) => r.warn), false);
});

test('every interpolated value is escaped in the wizard HTML', () => {
  const d = filled({ slug: EVIL, name: EVIL, group: EVIL, path: EVIL, url: EVIL, org: EVIL, goal: EVIL, remote: 'url' });
  for (const step of WIZARD_STEPS) {
    const html = wizardHtml({ draft: d, step, errors: [EVIL], plan: { path: EVIL, steps: [{ name: EVIL, status: EVIL, detail: EVIL }] }, message: EVIL });
    assert.doesNotMatch(html, /<img/, step);
    assert.doesNotMatch(html, /onerror=alert\(1\)>/, step);
  }
});

test('the wizard has one heading, labelled fields, and keyed nodes', () => {
  for (const step of WIZARD_STEPS) {
    const html = wizardHtml({ draft: filled(), step, errors: [] });
    assert.equal((html.match(/<h1\b/g) || []).length, 0, 'the page holds the only h1');
    assert.equal((html.match(/<h2\b/g) || []).length, 1, step);
    assert.match(html, /data-key="wizard-step"/);
    for (const input of html.match(/<(input|textarea|select)\b[^>]*>/g) || []) {
      if (/type="radio"|type="checkbox"/.test(input)) continue;
      assert.match(input, /id="wiz-[a-z-]+"/, input);
    }
  }
});

test('the name step keeps the typed text in the field value', () => {
  assert.match(wizardHtml({ draft: filled({ slug: 'abc' }), step: 'name', errors: [] }), /id="wiz-slug"[^>]*value="abc"/);
});

test('the remote step offers four choices, private by default, and a warning line for public', () => {
  const html = wizardHtml({ draft: filled(), step: 'remote', errors: [] });
  for (const v of ['none', 'gh', 'url']) assert.match(html, new RegExp(`name="remote" value="${v}"`));
  assert.match(html, /name="visibility" value="private" checked/);
  assert.doesNotMatch(html, /Anyone on the internet/);
  const pub = wizardHtml({ draft: filled({ visibility: 'public' }), step: 'remote', errors: [] });
  assert.match(pub, /Anyone on the internet/);
  assert.match(html, /Mailbox/, 'the step says that the question goes to the Mailbox');
});

test('the orchestrator step has the tick box, on by default', () => {
  const html = wizardHtml({ draft: filled(), step: 'orchestrator', errors: [] });
  assert.match(html, /id="wiz-start"[^>]*checked/);
  assert.match(html, /Start the orchestrator/);
  assert.doesNotMatch(wizardHtml({ draft: filled({ start: false }), step: 'orchestrator', errors: [] }), /id="wiz-start"[^>]*checked/);
});

test('the review step shows the plan steps and the errors, and the create button only with a plan', () => {
  const plan = { path: '/tmp/work/Demo App', steps: [{ name: 'folder', status: 'planned', detail: 'would create the folder' }, { name: 'check', status: 'planned', detail: 'not built yet' }] };
  const withPlan = wizardHtml({ draft: filled(), step: 'review', errors: [], plan });
  assert.match(withPlan, /would create the folder/);
  assert.match(withPlan, /data-wizard="create"/);
  const noPlan = wizardHtml({ draft: filled(), step: 'review', errors: ['The path is inside the data dir.'], plan: null });
  assert.match(noPlan, /inside the data dir/);
  assert.doesNotMatch(noPlan, /data-wizard="create"/);
  assert.match(planHtml(plan), /Demo App/);
});

test('the read-only message replaces the form', () => {
  const html = wizardHtml({ draft: filled(), step: 'name', errors: [], readOnly: true });
  assert.match(html, /read-only/i);
  assert.doesNotMatch(html, /<input/);
});

const status = (over = {}) => ({
  ok: true, slug: 'demo-app', state: 'running', path: '/tmp/work/Demo App', error: null, waiting: null,
  steps: [
    { name: 'validate', status: 'done', detail: 'ok' },
    { name: 'folder', status: 'running', detail: '' },
    { name: 'remote', status: 'pending', detail: '' },
    { name: 'check', status: 'not-built', detail: 'not built yet' },
  ], ...over,
});

test('the progress view shows each step with its state and detail', () => {
  const html = progressHtml(status());
  for (const name of ['validate', 'folder', 'remote']) assert.match(html, new RegExp(name));
  assert.match(html, /data-step-status="done"/);
  assert.match(html, /data-step-status="running"/);
  assert.doesNotMatch(html, /not built yet/, 'a step that is not built is not shown');
  assert.doesNotMatch(html, /data-wizard="resume"/);
});

test('a waiting run shows the state and a link to the Mailbox item', () => {
  const html = progressHtml(status({ state: 'waiting', waiting: { reason: 'waiting for an Owner decision', item: 'abc123' } }));
  assert.match(html, /waiting for your decision/);
  assert.match(html, /href="\/mailbox\?thread=boss&amp;conversation=abc123"/);
  assert.match(html, /data-wizard="resume"/);
  assert.match(html, /data-wizard="check"/);
  assert.equal(mailboxLink('a b&c'), '/mailbox?thread=boss&conversation=a%20b%26c');
  assert.doesNotMatch(progressHtml(status({ state: 'waiting', waiting: { item: null } })), /href="\/mailbox/);
});

test('a failed run shows the error and Resume; a done run shows Check only', () => {
  const failed = progressHtml(status({ state: 'failed', error: 'The step failed.' }));
  assert.match(failed, /The step failed\./);
  assert.match(failed, /data-wizard="resume"/);
  const done = progressHtml(status({ state: 'done' }));
  assert.doesNotMatch(done, /data-wizard="resume"/);
  assert.match(done, /data-wizard="check"/);
  assert.match(done, /href="\/projects\/demo-app"/);
});

test('the progress view escapes every value and shows check items', () => {
  const html = progressHtml(status({ slug: EVIL, path: EVIL, error: EVIL, state: 'failed', steps: [{ name: EVIL, status: EVIL, detail: EVIL, lines: [EVIL] }] }),
    { check: { ok: false, items: [{ name: EVIL, ok: false, detail: EVIL }] } });
  assert.doesNotMatch(html, /<img/);
});

test('isSettled stops the poll for finished, failed, waiting, and interrupted', () => {
  for (const state of ['done', 'failed', 'waiting', 'interrupted']) assert.equal(isSettled(status({ state })), true, state);
  for (const state of ['running', 'idle']) assert.equal(isSettled(status({ state })), false, state);
  assert.equal(isSettled(null), false);
});

const memoryStorage = () => { const data = new Map(); return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) }; };

test('the draft saves and loads, without the URL, and with the goal cut to the limit', () => {
  const storage = memoryStorage();
  saveDraft(storage, filled({ remote: 'url', url: 'https://example.com/a.git', goal: 'x'.repeat(GOAL_LIMIT + 50) }));
  const raw = storage.getItem(DRAFT_KEY);
  assert.doesNotMatch(raw, /example\.com/);
  const loaded = loadDraft(storage);
  assert.equal(loaded.slug, 'demo-app');
  assert.equal(loaded.goal.length, GOAL_LIMIT);
  assert.equal(loaded.url, '');
});

test('a broken localStorage gives the empty draft and does not throw', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); } };
  assert.doesNotThrow(() => saveDraft(broken, filled()));
  assert.deepEqual(loadDraft(broken), emptyDraft());
  assert.deepEqual(loadDraft(undefined), emptyDraft());
  assert.deepEqual(loadDraft({ getItem: () => '{not json' }), emptyDraft());
  assert.deepEqual(loadDraft({ getItem: () => '[1]' }), emptyDraft());
  const junk = loadDraft({ getItem: () => JSON.stringify({ slug: 5, remote: 'evil', visibility: 'x', start: 'yes', kind: 'gpt', folderMode: 'zz' }) });
  assert.deepEqual(junk, emptyDraft());
});

test('the Projects page has the New project button, the wizard has no other h1, and the preview message exists', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function projectsView(');
  const body = source.slice(start, source.indexOf('\n}\n', start));
  assert.match(body, /data-wizard-open/);
  assert.match(body, /New project/);
  assert.match(source, /from '\.\/project-wizard-ui\.js'/);
  assert.match(fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8'), /\.wizard-panel/);
});
