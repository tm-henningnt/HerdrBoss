// The New project wizard of the Projects page: the pure parts. The module has no DOM use, so the Node tests import it directly.
// It builds the HTML of each step, checks the form, builds the request for the project new routes, and keeps the draft.
// The routes and the flow are in src/project-new-api.js. The wizard adds no rule: the server checks every value again.

import { copyFieldHtml } from './copy.js';

export const WIZARD_STEPS = ['name', 'folder', 'remote', 'orchestrator', 'review'];
export const GOAL_LIMIT = 1000;
export const DRAFT_KEY = 'herdr-boss.project-wizard';
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ORG_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const STEP_TITLE = { name: 'Name', folder: 'Folder', remote: 'Remote', orchestrator: 'Orchestrator', review: 'Review' };
const STATUS_LABEL = { done: 'done', running: 'running', pending: 'pending', skipped: 'skipped', failed: 'failed', waiting: 'waiting for your decision', planned: 'planned' };
const RUN_LABEL = { running: 'Running', waiting: 'Waiting for your decision', failed: 'Failed', interrupted: 'Interrupted', done: 'Done', idle: 'Idle' };
const SETTLED = new Set(['done', 'failed', 'waiting', 'interrupted']);

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function emptyDraft() {
  return { slug: '', name: '', folderMode: 'group', group: '', path: '', remote: 'gh', url: '', visibility: 'private', confirmPublic: '', org: '', kind: 'ladder', goal: '', start: true };
}

// True when the form holds anything that the Owner typed. Escape asks before it closes such a form.
export function hasContent(draft) {
  const empty = emptyDraft();
  return ['slug', 'name', 'group', 'path', 'url', 'org', 'goal'].some((key) => String(draft[key] ?? '').trim() !== empty[key]);
}

// The Owner confirms a public repository by typing this word.
export const PUBLIC_WORD = 'public';
export const publicConfirmed = (draft) => String(draft.confirmPublic ?? '').trim().toLowerCase() === PUBLIC_WORD;
const needsConfirm = (draft) => draft.remote === 'gh' && draft.visibility === 'public' && !publicConfirmed(draft);

function checkUrl(value) {
  const url = String(value ?? '').trim();
  if (!url || /[\s\0]/.test(url)) return false;
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(url) && !url.includes('://')) return true;
  const match = /^(https|ssh|git):\/\/(?:([^/@]*)@)?([^/@]+)\/\S*$/.exec(url);
  if (!match) return false;
  const [, scheme, userinfo] = match;
  return userinfo === undefined || (scheme === 'ssh' && !userinfo.includes(':'));
}

// The errors of one step, as plain sentences. No message holds a value that the user typed.
export function validateStep(step, draft) {
  const errors = [];
  if (step === 'name') {
    if (!SLUG.test(draft.slug)) errors.push('The slug must use lowercase letters, digits, and hyphens. It starts with a letter or a digit and has at most 64 characters.');
  } else if (step === 'folder') {
    if (draft.folderMode === 'path') {
      if (!String(draft.path).trim()) errors.push('Enter the full path of the project folder.');
    } else {
      if (!String(draft.group).trim()) errors.push('Enter the group folder.');
      const name = String(draft.name || draft.slug).trim();
      if (/[\\/\0]/.test(name) || name === '..' || name.startsWith('.')) errors.push('With a group folder the name must be one folder name: no slash, no "..", no leading dot.');
    }
  } else if (step === 'remote') {
    if (draft.remote === 'url' && !checkUrl(draft.url)) errors.push('Enter a https, ssh, or git URL, or user@host:path. The URL must not hold a password or a token.');
    if (needsConfirm(draft)) errors.push(`Type the word ${PUBLIC_WORD} in the confirmation field to create a public repository.`);
    if (draft.remote === 'gh' && String(draft.org).trim() && !ORG_NAME.test(String(draft.org).trim())) errors.push('The organization is a name with letters, digits, and hyphens. It does not start with a hyphen.');
  } else if (step === 'orchestrator') {
    if (!['ladder', 'claude', 'codex'].includes(draft.kind)) errors.push('Choose the ladder default, Claude, or Codex.');
    if (String(draft.goal).length > GOAL_LIMIT) errors.push(`The goal has at most ${GOAL_LIMIT} characters.`);
  }
  return errors;
}

export function firstInvalidStep(draft) {
  return WIZARD_STEPS.find((step) => validateStep(step, draft).length) ?? null;
}

// The body of POST /api/project-new/plan and POST /api/project-new.
export function toRequest(draft) {
  const body = { slug: draft.slug };
  if (String(draft.name).trim()) body.name = String(draft.name).trim();
  if (draft.folderMode === 'path') body.path = String(draft.path).trim(); else body.group = String(draft.group).trim();
  if (draft.remote === 'none') body.remote = 'none';
  else if (draft.remote === 'url') body.remote = String(draft.url).trim();
  else {
    body.remote = 'gh';
    const visibility = draft.visibility === 'public' ? 'public' : 'private';
    body.visibility = visibility;
    // The choice in the wizard is the Owner decision. The server creates the repository without a Mailbox item.
    body.decision = { visibility, source: 'wizard', ...(visibility === 'public' && publicConfirmed(draft) ? { confirmPublic: true } : {}) };
    if (String(draft.org).trim()) body.org = String(draft.org).trim();
  }
  if (draft.kind === 'claude' || draft.kind === 'codex') body.kind = draft.kind;
  if (String(draft.goal).trim()) body.goal = String(draft.goal).trim();
  body.start = draft.start === true;
  return body;
}

const REMOTE_TEXT = { none: 'none', url: 'existing URL' };
export function reviewRows(draft) {
  const name = String(draft.name || draft.slug).trim();
  const folder = draft.folderMode === 'path' ? String(draft.path).trim() : `${String(draft.group).trim().replace(/\/+$/, '')}/${name}`;
  let remote = REMOTE_TEXT[draft.remote] || `GitHub, ${draft.visibility === 'public' ? 'public' : 'private'}${String(draft.org).trim() ? `, organization ${String(draft.org).trim()}` : ''}`;
  if (draft.remote === 'url') remote = 'existing URL (not shown)';
  const rows = [
    { label: 'Slug', value: draft.slug },
    { label: 'Name', value: name },
    { label: 'Folder', value: folder },
    { label: 'Remote', value: remote },
  ];
  if (draft.remote === 'gh' && draft.visibility === 'public') rows.push({ label: 'Warning', value: 'Anyone on the internet can read a public repository. You typed public to confirm it.', warn: true });
  rows.push({ label: 'Orchestrator', value: draft.kind === 'ladder' ? 'first usable entry of the ladder' : draft.kind });
  rows.push({ label: 'Goal', value: String(draft.goal).trim() || 'none' });
  rows.push({ label: 'Start the orchestrator', value: draft.start === true ? 'yes' : 'no' });
  return rows;
}

export const mailboxLink = (item) => `/mailbox?thread=boss&conversation=${encodeURIComponent(item)}`;
export const isSettled = (status) => Boolean(status) && SETTLED.has(status.state);

const errorList = (errors) => (errors?.length ? `<ul class="wizard-errors" role="alert">${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : '');
const field = (id, label, control, hint = '') => `<div class="wizard-field"><label for="${id}">${esc(label)}</label>${control}${hint ? `<p class="wizard-hint" id="${id}-hint">${esc(hint)}</p>` : ''}</div>`;
const text = (id, value, extra = '') => `<input id="${id}" type="text" value="${esc(value)}" autocomplete="off" autocapitalize="off" spellcheck="false" ${extra}>`;
const radio = (name, value, current, label, hint = '') => `<label class="wizard-choice"><input type="radio" name="${name}" value="${value}"${current === value ? ' checked' : ''}><span><b>${esc(label)}</b>${hint ? `<small>${esc(hint)}</small>` : ''}</span></label>`;

// The warning and the typed confirmation of a public repository. The next button is disabled until the word matches.
function publicConfirm(d) {
  const ok = publicConfirmed(d);
  return '<div class="wizard-confirm" data-key="public-confirm">'
    + '<p class="wizard-warn" id="wiz-public-warning" role="note"><b>Public means public.</b> Anyone on the internet can read all files and the full history of a public repository. Do not put secrets, client names, or private data in it. If someone copies it, making it private later does not undo that.</p>'
    + field('wiz-confirm-public', `Type ${PUBLIC_WORD} to confirm`, text('wiz-confirm-public', d.confirmPublic, `aria-describedby="wiz-public-warning" aria-label="Type ${PUBLIC_WORD} to confirm a public repository" aria-invalid="${ok ? 'false' : 'true'}" maxlength="20" data-wizard-first`))
    + '</div>';
}

function stepBody(step, d) {
  if (step === 'name') {
    return field('wiz-slug', 'Slug', text('wiz-slug', d.slug, 'aria-describedby="wiz-slug-hint" aria-label="Project slug" maxlength="64" data-wizard-first'), 'Lowercase letters, digits, and hyphens. Used in commands, URLs, and the workspace name.')
      + field('wiz-name', 'Name (optional)', text('wiz-name', d.name, 'aria-describedby="wiz-name-hint" aria-label="Project name" maxlength="200"'), 'The folder name and the title. The default is the slug.');
  }
  if (step === 'folder') {
    const path = d.folderMode === 'path';
    return `<fieldset class="wizard-group"><legend>Where does the project go?</legend>${radio('folderMode', 'group', d.folderMode, 'In a group folder', 'The project folder is the group folder plus the name.')}${radio('folderMode', 'path', d.folderMode, 'At an exact path', 'The folder must not exist or must be empty.')}</fieldset>`
      + (path ? field('wiz-path', 'Project path', text('wiz-path', d.path, 'aria-label="Project path" placeholder="/Users/you/Projects/my-project" data-wizard-first'), 'The full path of the project folder.')
        : field('wiz-group', 'Group folder', text('wiz-group', d.group, 'aria-label="Group folder" placeholder="/path/to/projects" data-wizard-first'), 'The full path of the folder that holds the project folder. Settings supplies the suggested group. You can change it.'));
  }
  if (step === 'remote') {
    const gh = d.remote === 'gh';
    return `<fieldset class="wizard-group"><legend>Remote repository</legend>${radio('remote', 'gh', d.remote, 'New GitHub repository', 'Herdr Boss creates the repository with the visibility that you choose. It does not ask in the Mailbox.')}${radio('remote', 'none', d.remote, 'No remote', 'Local Git only.')}${radio('remote', 'url', d.remote, 'Existing URL', 'Add a repository that already exists as origin.')}</fieldset>`
      + (gh ? `<fieldset class="wizard-group"><legend>Visibility</legend>${radio('visibility', 'private', d.visibility, 'Private', 'The default.')}${radio('visibility', 'public', d.visibility, 'Public')}</fieldset>${d.visibility === 'public' ? publicConfirm(d) : ''}${field('wiz-org', 'Organization (optional)', text('wiz-org', d.org, 'aria-label="GitHub organization" maxlength="39"'), 'The default is your gh login.')}` : '')
      + (d.remote === 'url' ? field('wiz-url', 'Repository URL', text('wiz-url', d.url, 'aria-label="Repository URL" inputmode="url" data-wizard-first'), 'A https, ssh, or git URL, or user@host:path. Never put a password or a token in it. The draft does not keep this URL.') : '');
  }
  if (step === 'orchestrator') {
    return `<div class="wizard-field"><label for="wiz-kind">Orchestrator</label><select id="wiz-kind" aria-label="Orchestrator kind" data-wizard-first>${[['ladder', 'Ladder default'], ['claude', 'Claude'], ['codex', 'Codex']].map(([v, l]) => `<option value="${v}"${d.kind === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>`
      + field('wiz-goal', 'Goal (optional)', `<textarea id="wiz-goal" rows="5" maxlength="${GOAL_LIMIT}" aria-describedby="wiz-goal-hint" aria-label="Project goal">${esc(d.goal)}</textarea>`, `What the first task is. At most ${GOAL_LIMIT} characters. ${String(d.goal).length} used.`)
      + `<label class="wizard-check"><input id="wiz-start" type="checkbox"${d.start ? ' checked' : ''}><span><b>Start the orchestrator</b><small>Herdr Boss sends the first prompt. This spends model quota.</small></span></label>`;
  }
  return '';
}

export function planHtml(plan) {
  if (!plan) return '';
  return `<p class="wizard-path">Folder: <code>${esc(plan.path)}</code>${copyFieldHtml(plan.path, esc, 'Copy the folder path')}</p><ol class="wizard-plan">${(plan.steps || []).filter((s) => s.status !== 'not-built' && s.detail !== 'not built yet').map((s) => `<li data-step-status="${esc(s.status)}"><b>${esc(s.name)}</b><span>${esc(s.detail)}</span></li>`).join('')}</ol>`;
}

function reviewBody(model) {
  const rows = reviewRows(model.draft);
  return `<dl class="wizard-review">${rows.map((r) => `<div${r.warn ? ' class="warn"' : ''}><dt>${esc(r.label)}</dt><dd>${esc(r.value)}</dd></div>`).join('')}</dl>`
    + (model.planning ? '<p class="wizard-hint" role="status">Checking the plan…</p>' : planHtml(model.plan));
}

// model: draft, step, errors, plan, planning, busy, message, readOnly.
export function wizardHtml(model) {
  const { draft, step, errors = [], message = '' } = model;
  const head = '<div class="wizard-head"><h2 id="wizard-title">New project</h2><button type="button" class="quiet" data-wizard="close">Close</button></div>';
  if (model.readOnly) {
    return `${head}<div class="wizard-body" data-key="wizard-step"><p class="wizard-warn" role="status">The read-only preview does not allow a new project. Open the dashboard on the service to create one.</p></div>`;
  }
  const index = WIZARD_STEPS.indexOf(step);
  const last = step === 'review';
  const nav = `<div class="wizard-actions">${index > 0 ? '<button type="button" class="quiet" data-wizard="back">Back</button>' : ''}`
    + (last ? (model.plan ? `<button type="button" data-wizard="create"${model.busy ? ' disabled' : ''}>Create project</button>` : '<button type="button" data-wizard="plan">Check again</button>')
      : `<button type="submit"${step === 'remote' && needsConfirm(draft) ? ' disabled aria-disabled="true"' : ''}>${WIZARD_STEPS[index + 1] === 'review' ? 'Review' : 'Next'}</button>`) + '</div>';
  const dots = `<ol class="wizard-steps" aria-label="Steps">${WIZARD_STEPS.map((s, i) => `<li${s === step ? ' aria-current="step"' : ''}${i < index ? ' class="past"' : ''}>${esc(STEP_TITLE[s])}</li>`).join('')}</ol>`;
  return `${head}${dots}<form class="wizard-body" data-key="wizard-step" data-wizard-form novalidate aria-labelledby="wizard-title"><h3 data-key="wizard-step-title" tabindex="-1" data-wizard-title>Step ${index + 1} of ${WIZARD_STEPS.length}: ${esc(STEP_TITLE[step])}</h3>`
    + `<div data-key="step-${esc(step)}">${last ? reviewBody(model) : stepBody(step, draft)}</div>${errorList(errors)}<p class="wizard-hint" role="status">${esc(message)}</p>${nav}</form>`;
}

const okIcon = { done: '✓', failed: '✕', waiting: '…', running: '…', skipped: '–' };
export function progressHtml(status, { check = null, busy = false, message = '', stalled = false } = {}) {
  const shown = (status.steps || []).filter((s) => s.status !== 'not-built');
  const steps = `<ol class="wizard-plan wizard-progress">${shown.map((s) => `<li data-step-status="${esc(s.status)}"><b>${esc(okIcon[s.status] || '·')} ${esc(s.name)}</b><span>${esc(STATUS_LABEL[s.status] || s.status)}${s.detail ? ` · ${esc(s.detail)}` : ''}</span>${(s.lines || []).map((l) => `<small>${esc(l)}</small>`).join('')}</li>`).join('')}</ol>`;
  const waiting = status.state === 'waiting'
    ? `<p class="wizard-warn" role="status">This project is waiting for your decision.${status.waiting?.item ? ` <a href="${esc(mailboxLink(status.waiting.item))}">Open the Mailbox item.</a>` : ' The Mailbox item is not known yet.'} Answer it, then select Resume.</p>` : '';
  const failed = status.error ? `<p class="wizard-errors" role="alert">${esc(status.error)}</p>` : '';
  const checked = check ? `<ul class="wizard-check-list" aria-label="Project check">${(check.items || []).map((i) => `<li class="${i.ok ? 'ok' : 'bad'}"><b>${i.ok ? 'ok' : 'missing'}</b> ${esc(i.name)}${i.detail ? ` · ${esc(i.detail)}` : ''}</li>`).join('')}</ul>` : '';
  const settled = isSettled(status) || stalled;
  const buttons = settled
    ? `<div class="wizard-actions">${['waiting', 'failed', 'interrupted'].includes(status.state) || stalled ? `<button type="button" data-wizard="resume"${busy ? ' disabled' : ''}>Resume</button>` : ''}<button type="button" class="quiet" data-wizard="check"${busy ? ' disabled' : ''}>Check</button><button type="button" class="quiet" data-wizard="discard">Start a new form</button>${status.state === 'done' ? `<a class="button-link" href="/projects/${encodeURIComponent(status.slug)}" data-wizard="open">Open project</a>` : ''}</div>` : '';
  return `<div class="wizard-head"><h2 id="wizard-title">New project · ${esc(status.slug)}</h2><button type="button" class="quiet" data-wizard="close">Close</button></div>`
    + `<div class="wizard-body" data-key="wizard-step"><p class="wizard-state" data-run-state="${esc(status.state)}" role="status"><b>${esc(RUN_LABEL[status.state] || status.state)}</b>${status.path ? ` · <code>${esc(status.path)}</code>${copyFieldHtml(status.path, esc, 'Copy the folder path')}` : ''}</p>${waiting}${failed}${steps}${checked}<p class="wizard-hint" role="status">${esc(message)}</p>${buttons}</div>`;
}

const clean = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
const str = (value, limit = 4096) => (typeof value === 'string' ? value.slice(0, limit) : '');

// The draft holds no repository URL: a URL can hold a credential. It holds no typed confirmation: the Owner types it again each time.
export function saveDraft(storage, draft) {
  try {
    const { url, confirmPublic, ...rest } = draft; // eslint-disable-line no-unused-vars
    storage.setItem(DRAFT_KEY, JSON.stringify({ ...rest, goal: String(rest.goal ?? '').slice(0, GOAL_LIMIT) }));
  } catch { /* Storage can be off or full. */ }
}

export function loadDraft(storage) {
  const base = emptyDraft();
  try {
    const saved = JSON.parse(storage.getItem(DRAFT_KEY));
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return base;
    return {
      slug: str(saved.slug, 64), name: str(saved.name, 200), folderMode: clean(saved.folderMode, ['group', 'path'], base.folderMode),
      group: str(saved.group), path: str(saved.path), remote: clean(saved.remote, ['gh', 'none', 'url'], base.remote), url: '',
      visibility: clean(saved.visibility, ['private', 'public'], base.visibility), confirmPublic: '', org: str(saved.org, 39),
      kind: clean(saved.kind, ['ladder', 'claude', 'codex'], base.kind), goal: str(saved.goal, GOAL_LIMIT),
      start: typeof saved.start === 'boolean' ? saved.start : base.start,
    };
  } catch { return base; }
}
