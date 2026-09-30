import { markdownOrPlain, plainTextHtml, sanitizeRendered } from './markdown.js';
import { FLOW, FLOW_LABEL, DONE_LIMIT, taskMap, taskState, blockReasons, boardColumns, dependencyChain, criticalPath, graphTasks, graphDepths, blockerIds, elapsedText, domPart, fleetItems, fleetColumns, fleetFilter, fleetWho } from './board.js';
import { patchHtml } from './keyed.js';
import { groupMailRows, inboxSections, listTime, mailRowHtml } from './mail-rows.js';
import { APP_VIEW_ROUTES, appViewport } from './app-view.js';

const $app = document.getElementById('app');
// A visual check can force a theme with ?theme=light or ?theme=dark. Without it, the page follows the system.
const forcedTheme = new URLSearchParams(location.search).get('theme');
if (forcedTheme === 'light' || forcedTheme === 'dark') document.documentElement.dataset.theme = forcedTheme;
const $dot = document.getElementById('dot');
const $updated = document.getElementById('updated');
const $nav = document.getElementById('primary-nav');
const $roamgate = document.getElementById('roamgate-link');
const $navMenu = document.getElementById('nav-menu');
const $navMenuLabel = document.getElementById('nav-menu-label');
const NAV_LABEL = { overview: 'Overview', board: 'Board', mailbox: 'Mailbox', chat: 'Chat', agents: 'Agents', projects: 'Projects', browsers: 'Browsers', allocation: 'Allocation', analytics: 'Analytics', logs: 'Logs', settings: 'Settings' };
const settingsLink = document.createElement('a');
settingsLink.href = '/settings';
settingsLink.dataset.nav = 'settings';
settingsLink.textContent = 'Settings';
// Settings goes after Logs and before Roamgate. Roamgate stays the last entry when it is shown.
$nav.insertBefore(settingsLink, $roamgate);
function setNavMenu(open) {
  $nav.classList.toggle('open', open);
  $navMenu.setAttribute('aria-expanded', String(open));
}

let state = null;
let lastRender = '';
// The project page patches its DOM in place when the previous render was the project page too.
let lastRoute = null;
let models = {};
let usage = null;
let denials = null;
let browserSessions = [];
const browserMessages = {};
const browserPreviewOpen = new Set();
const browserPreviewLive = new Set();
const browserManageOpen = new Set();
const browserPreviewPending = new Set();
const browserPreviewUrls = {};
const browserPreviewMessages = {};
const browserPreviewFrames = {};
let browserPreviewsInitialized = false;
const browserTabs = {};
const browserTabsAt = {};
// View mode per browser: 'tab' shows one focused tab with controls; 'grid' shows every tab and no controls.
const BROWSER_VIEW_KEY = 'herdr-boss.browser-view-modes';
const browserViewModes = (() => { try { const value = JSON.parse(localStorage.getItem(BROWSER_VIEW_KEY)); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; } })();
const browserGridUrls = {};
const browserGridErrors = {};
const gridMode = (slug) => browserViewModes[slug] === 'grid';
// Tabs where the Owner confirmed control although an agent is attached. Kept for this page load only.
const browserConfirmedTabs = new Set();
const browserSelectedTab = {};
const browserNavigation = {};
const browserAddressDraft = {};
// The bookmark row that shows an inline rename form: { slug, index, name } or null.
let browserBookmarkDraft = null;
const PREVIEW_INTERVALS = [1500, 3000, 5000, 10000, 30000];
const PREVIEW_INTERVAL_KEY = 'herdr-boss.browser-preview-intervals';
const browserPreviewIntervals = (() => { try { const value = JSON.parse(localStorage.getItem(PREVIEW_INTERVAL_KEY)); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; } })();
const browserNextRefresh = {};
let viewerInputQueue = Promise.resolve();
let viewerTextBuffer = '';
let viewerTextTimer = null;
let viewerRefreshTimer = null;
let handoffRecords = [];
const handoffPlans = {};
const handoffModes = {};
const handoffTargets = {};
const handoffModels = {};
const handoffEfforts = {};
const handoffOutputs = {};
const handoffReviewed = new Set();
const handoffBusy = new Set();
const handoffMessages = {};
let quotaExpanded = false;
let machineExpanded = false;
let policyDraft = null;
let policyDirty = false;
let saveMessage = '';
let machineGuardBusy = false;
let machineGuardMessage = '';
let nightBusy = false;
let nightMessage = '';
// The Watch form on the Agents page. until is a datetime-local value; null means the default at the next render.
const watchForm = { until: null, forever: false, daily: false, report: '07:30', routines: {}, adhoc: '' };
// The routine editors on Settings keep their drafts, their open state, and their messages across renders.
const routineDrafts = {};
const routineOpen = new Set();
const routineMessages = {};
let hashScrolled = false;

function markPolicyDirty() {
  policyDirty = true;
  saveMessage = '';
  const actions = document.querySelector('.control-actions');
  if (actions) {
    actions.classList.add('pending');
    actions.querySelector('[data-policy-status]').textContent = 'Unsaved changes · Apply policy to keep them';
    actions.querySelector('#save-policy').disabled = false;
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const previewInterval = (slug) => PREVIEW_INTERVALS.includes(Number(browserPreviewIntervals[slug])) ? Number(browserPreviewIntervals[slug]) : 1500;
function browserTabLabel(tab) {
  let location = tab.url;
  try { const url = new URL(tab.url); location = `${url.hostname}${url.pathname}`; } catch {}
  return `${tab.attached ? 'Agent · ' : ''}${tab.visibility === 'hidden' ? 'Hidden · ' : ''}${String(tab.title || 'Untitled page').slice(0, 42)} · ${String(location || '').slice(0, 70)}`;
}
const code = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
const PROVIDERS = { claude: 'Claude', codex: 'Codex', opencodego: 'OpenCode Go' };
const STATUSES = ['todo', 'doing', 'review', 'blocked', 'done'];
const STATUS_LABEL = { todo: 'To do', doing: 'In progress', review: 'Review', blocked: 'Blocked', done: 'Done' };

function dur(sec) {
  if (sec == null || !isFinite(sec)) return '–';
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${sec}s`;
}
const ago = (iso) => (iso ? `${dur((Date.now() - new Date(iso)) / 1000)} ago` : '–');
// The engine marks a published status stale. A new publish clears the mark before the next engine tick.
function staleStatusTag(s, p) {
  const item = p && s.staleStatus?.[p.slug];
  if (!item || item.updated !== p.updated) return '';
  return ` · <span style="color:var(--warn)">Status stale: ${esc(dur((Date.now() - new Date(p.updated)) / 1000))}</span>`;
}
const until = (iso) => (iso ? dur((new Date(iso) - Date.now()) / 1000) : '–');
function clock(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric' })} ${t}`;
}

function machineGuardMode(machine = {}, now = Date.now()) {
  if (machine.guardEnabled === false) return 'off';
  const pauseAt = machine.guardPausedUntil == null ? NaN : Date.parse(machine.guardPausedUntil);
  return Number.isFinite(pauseAt) && pauseAt > now ? 'paused' : 'active';
}

function machineGuardUntilText(untilAt) {
  return untilAt ? ` until ${new Date(untilAt).toLocaleString()}` : '';
}

// The local end time of a watch, as HH:MM.
function nightTime(iso) {
  if (!iso || !Number.isFinite(Date.parse(iso))) return '--:--';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

// The label of a watch end time: the local weekday and time, for example "Wed 08:00". A time more than 6 days ahead
// also shows the date.
function watchLabel(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--';
  const far = Math.abs(date.getTime() - Date.now()) > 6 * 24 * 3600 * 1000;
  const day = new Intl.DateTimeFormat('en-GB', far ? { weekday: 'short', day: 'numeric', month: 'short' } : { weekday: 'short' }).format(date);
  return `${day} ${nightTime(iso)}`;
}

function watchUntilPhrase(night) {
  return night?.untilCancelled === true || !night?.until ? 'until cancelled' : `until ${watchLabel(night.until)}`;
}

// The value of a datetime-local input for a Date, in local time.
function localInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// The default end time: the next 07:30. Before 07:30 it is today at 07:30. Otherwise it is tomorrow at 07:30.
function defaultWatchUntil(now = new Date()) {
  const date = new Date(now);
  date.setHours(7, 30, 0, 0);
  if (date.getTime() <= now.getTime()) date.setDate(date.getDate() + 1);
  return date;
}

// The length text, the warning, and the validity of the Watch form.
function watchFormView() {
  if (watchForm.forever) return { length: 'until you cancel', warning: '', valid: true };
  const end = new Date(watchForm.until || '');
  if (!watchForm.until || Number.isNaN(end.getTime())) return { length: '', warning: 'Choose an end time.', valid: false };
  const hours = Math.round(((end.getTime() - Date.now()) / 3600000) * 10) / 10;
  if (hours <= 0) return { length: '', warning: 'The end time is in the past. Choose a later time.', valid: false };
  return { length: `${hours} hours`, warning: hours > 48 ? `This watch lasts ${hours} hours. The Boss acts for the Owner for the whole time.` : '', valid: true };
}

// Patch the length text, the warning, and the field states without a full render, so the picker keeps focus.
function syncWatchForm() {
  const root = document.querySelector('[data-night-form]');
  if (!root) return;
  const view = watchFormView();
  const set = (selector, text) => { const el = root.querySelector(selector); if (el && el.textContent !== text) el.textContent = text; };
  set('[data-night-length]', view.length);
  set('[data-night-warning]', view.warning);
  const until = root.querySelector('[data-night-until]');
  if (until) until.disabled = watchForm.forever || nightBusy;
  const daily = root.querySelector('[data-night-daily-row]');
  if (daily) daily.hidden = !watchForm.forever;
  const report = root.querySelector('[data-night-report]');
  if (report) report.disabled = !watchForm.daily || nightBusy;
  const start = root.querySelector('[data-night-start]');
  if (start) start.disabled = !view.valid || nightBusy;
}

// The watch symbol in the top bar. Off: faded. On: an eye with a small label on desktop ("until 08:00" or "on"), the
// icon only on the phone. A click opens a popover with the end time, the mode, and a Stop button. There is no banner.
function watchLabelText(night) {
  return night?.untilCancelled === true || !night?.until ? 'on' : `until ${nightTime(night.until)}`;
}

function updateWatchIcon(s) {
  const button = document.getElementById('watch-toggle');
  if (!button) return;
  const night = s?.night;
  const on = night?.active === true;
  button.dataset.empty = on ? 'false' : 'true';
  button.setAttribute('aria-label', on ? `Watch ${watchLabelText(night)}` : 'Watch off');
  button.title = on ? `Watch ${watchLabelText(night)}` : 'Watch off';
  const label = button.querySelector('[data-watch-label]');
  if (label) { label.hidden = !on; label.textContent = on ? watchLabelText(night) : ''; }
  renderWatchPopover(night);
}

let watchPopRendering = false;
function renderWatchPopover(night) {
  const pop = document.getElementById('watch-pop');
  if (!pop) return;
  const on = night?.active === true;
  const rows = on
    ? `<dl><dt>Ends</dt><dd>${esc(night.untilCancelled === true || !night.until ? 'When you cancel' : watchLabel(night.until))}</dd><dt>Mode</dt><dd>${esc(night.untilCancelled === true || !night.until ? 'Until cancelled' : 'Until the end time')}${night.quietHours === true ? ' · Quiet hours on' : ''}</dd></dl><p>The Boss acts for the Owner.</p><button type="button" data-night-stop="true"${nightBusy ? ' disabled' : ''}>Stop</button>`
    : '<p>No watch runs.</p><a href="/agents#watch" data-watch-pop-link>Start a watch on the Agents page</a>';
  const html = `<h2>Watch</h2>${rows}`;
  if (pop.dataset.html !== html) {
    // Replacing the content drops the focused element. That is not a Tab out, so the flag stops the close.
    const hadFocus = pop.contains(document.activeElement);
    watchPopRendering = true;
    pop.dataset.html = html;
    pop.innerHTML = html;
    watchPopRendering = false;
    if (hadFocus && !pop.hidden) pop.querySelector('button, a')?.focus();
  }
}

function toggleWatchPopover(force) {
  const pop = document.getElementById('watch-pop');
  const button = document.getElementById('watch-toggle');
  if (!pop || !button) return;
  const open = force ?? pop.hidden;
  pop.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
  if (open) {
    const rect = button.getBoundingClientRect();
    pop.style.top = `${Math.round(rect.bottom + 6)}px`;
    pop.style.left = `${Math.max(12, Math.min(Math.round(rect.left), window.innerWidth - pop.offsetWidth - 12))}px`;
    pop.style.right = 'auto';
    pop.querySelector('button, a')?.focus();
  }
}

document.addEventListener('click', (e) => {
  if (e.target.closest?.('#watch-toggle')) { toggleWatchPopover(); return; }
  if (e.target.closest?.('[data-watch-pop-link]')) { toggleWatchPopover(false); return; }
  if (!e.target.closest?.('#watch-pop')) toggleWatchPopover(false);
});
// Close the popover. With refocus, focus returns to the toggle, so a keyboard user does not lose the place.
function closeWatchPopover(refocus = false) {
  toggleWatchPopover(false);
  if (refocus) document.getElementById('watch-toggle')?.focus();
}
window.addEventListener('resize', () => toggleWatchPopover(false));
// Tab out of the popover closes it. Focus moving to the toggle or inside the popover keeps it open.
document.addEventListener('focusout', (e) => {
  const pop = document.getElementById('watch-pop');
  if (!pop || pop.hidden || watchPopRendering || !pop.contains(e.target)) return;
  const next = e.relatedTarget;
  if (next && (pop.contains(next) || next.id === 'watch-toggle')) return;
  toggleWatchPopover(false);
});
document.addEventListener('keydown', (e) => {
  const pop = document.getElementById('watch-pop');
  if (e.key === 'Escape' && pop && !pop.hidden) closeWatchPopover(true);
});

// Start or stop the watch from the popover or from the Agents page. A stop asks the Owner first. Both routes return the new
// watch state, and a tick already refreshed the page state, so the page re-reads it after a change.
async function updateNight(action) {
  if (nightBusy) return;
  if (action === 'stop' && !confirm('Stop the watch?\n\nThe Owner rules apply again at once. The Boss sends the end notice to every pane that got the start notice.')) return;
  if (action === 'start' && !watchFormView().valid) { nightMessage = watchFormView().warning; lastRender = ''; render(true); return; }
  const body = action === 'start' ? {
    ...(watchForm.forever
      ? { untilCancelled: true, ...(watchForm.daily ? { report: watchForm.report } : {}) }
      : { until: new Date(watchForm.until).toISOString() }),
    routines: watchRoutineChoiceBody(),
    adhoc: watchForm.adhoc,
  } : undefined;
  const quietHours = action === 'start' ? document.querySelector('[data-night-quiet-hours]')?.checked === true : undefined;
  nightBusy = true;
  nightMessage = action === 'start' ? 'Starting the watch…' : 'Stopping the watch…';
  lastRender = '';
  render(true);
  try {
    const result = await postJson(`/api/watch/${action}`, action === 'start' ? { ...body, quietHours } : {});
    if (result.night) state.night = result.night;
    nightMessage = action === 'start' ? `On watch ${watchUntilPhrase(result.night)}.${result.warning ? ` ${result.warning}` : ''}` : 'Watch stopped.';
  } catch (error) { nightMessage = error.message; }
  finally {
    nightBusy = false;
    await refreshState();
    lastRender = '';
    render(true);
    // The focused Stop button is gone after a stop, so close the popover and return focus to the toggle.
    if (action === 'stop') closeWatchPopover(true);
  }
}

async function updateOverviewMachineGuard(action, hours = 1, enabled = null) {
  if (machineGuardBusy) return;
  machineGuardBusy = true;
  machineGuardMessage = 'Saving machine guard…';
  lastRender = '';
  render(true);
  try {
    if (action === 'pause' && (!Number.isInteger(hours) || hours < 1 || hours > 24)) throw new Error('Choose a pause from 1 to 24 hours.');
    const currentResponse = await fetch('/api/policy');
    const current = await currentResponse.json();
    if (!currentResponse.ok) throw new Error(current.error || 'The policy could not be read.');
    current.machine ||= {};
    if (action === 'toggle') current.machine.guardEnabled = !!enabled;
    else if (action === 'pause') {
      current.machine.guardEnabled = true;
      current.machine.guardPausedUntil = new Date(Date.now() + hours * 3600000).toISOString();
    } else {
      current.machine.guardEnabled = true;
      current.machine.guardPausedUntil = null;
    }
    const response = await fetch('/api/policy', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(current) });
    const result = await response.json();
    if (!response.ok) throw new Error((result.errors || [result.error || 'The machine guard could not be updated.']).join(' '));
    state.policy = result.policy;
    if (result.control) state.control = result.control;
    if (policyDraft) {
      if (!policyDirty) policyDraft = clone(result.policy);
      else {
        policyDraft.machine ||= {};
        policyDraft.machine.guardEnabled = result.policy.machine.guardEnabled;
        policyDraft.machine.guardPausedUntil = result.policy.machine.guardPausedUntil;
      }
    }
    const machine = result.policy.machine;
    const mode = machineGuardMode(machine);
    machineGuardMessage = `Machine guard ${mode}${mode === 'paused' ? machineGuardUntilText(machine.guardPausedUntil) : ''}.`;
  } catch (error) { machineGuardMessage = error.message; }
  finally {
    machineGuardBusy = false;
    lastRender = '';
    render(true);
  }
}

const clone = (x) => JSON.parse(JSON.stringify(x));
function ensureDraft(s) {
  if (policyDraft || !s.policy || !s.control) return;
  policyDraft = clone(s.policy);
  const projects = Object.values(s.control.projects);
  if (!projects.length) return;
  for (const slug of Object.keys(policyDraft.projects)) if (!s.control.projects[slug]) policyDraft.projects[slug].share = 0;
  const saved = projects.map((p) => policyDraft.projects[p.slug]?.share);
  const shares = saved.every((x) => Number.isInteger(x)) && saved.reduce((a, b) => a + b, 0) === 100
    ? saved : projects.map((_p, i) => Math.floor(100 / projects.length) + (i < 100 % projects.length ? 1 : 0));
  projects.forEach((p, i) => {
    policyDraft.projects[p.slug] ||= { share: shares[i], mode: p.mode, excludedKinds: [], excludedModels: [] };
    policyDraft.projects[p.slug].share = shares[i];
  });
}

function allocationProjects() { return Object.values(state?.control?.projects || {}); }
const SHARE_COLORS = ['var(--accent)', 'var(--info)', 'var(--ok)', 'var(--warn)', 'var(--muted)'];
// The project order of projectSlugs sets the bar segments, the project cards, and the card accents.
function allocationColor(s, slug) {
  const i = Object.keys(s.control?.projects || {}).indexOf(slug);
  return i < 0 ? null : SHARE_COLORS[i % SHARE_COLORS.length];
}
// Effective values come from the applied control state; the set share comes from the policy draft.
function compactPercent(x) { return x === 0 || x >= 10 ? String(Math.round(x)) : String(Math.round(x * 10) / 10); }
function allocationActivity(p) { return p.effectiveMode === 'paused' ? 'paused' : p.idle ? 'idle' : 'active'; }
function effectiveAllocation(p) {
  const slots = p.slots || 0;
  const max = state?.policy?.maxWorkers || 0;
  return { slots, percent: compactPercent(max ? slots / max * 100 : 0) };
}
function segmentText(p, share) {
  const eff = effectiveAllocation(p);
  const activity = allocationActivity(p);
  return {
    title: `${p.label}: set share ${share}% · effective ${eff.percent}% · ${eff.slots} slot${eff.slots === 1 ? '' : 's'}${activity === 'active' ? '' : ` · ${activity}`}`,
    value: `${p.label}: set share ${share} percent, ${eff.slots} effective slot${eff.slots === 1 ? '' : 's'}${activity === 'active' ? '' : `, ${activity}`}`,
  };
}
function allocationSegment(s, p, share) {
  const text = segmentText(p, share);
  return `<div class="allocation-segment ${allocationActivity(p)}" data-segment="${esc(p.slug)}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${share}" aria-label="${esc(p.label)} set share" aria-valuetext="${esc(text.value)}" style="width:${share}%;background-color:${allocationColor(s, p.slug)}" title="${esc(text.title)}"><span class="allocation-label" aria-hidden="true"><span class="allocation-share">${share}%</span><span class="allocation-slots"> · ${effectiveAllocation(p).slots}</span></span></div>`;
}
// The read-only summary shows the applied shares. The Allocation page shows the editable draft.
function allocationSummary(s) {
  const live = s.control?.projects || {};
  const projects = projectSlugs(s).map((slug) => live[slug]).filter(Boolean);
  if (!projects.length) return '';
  const segments = projects.map((p) => allocationSegment(s, p, Number(compactPercent(p.share || 0)))).join('');
  return `<div class="allocation-summary"><div class="allocation-bar" role="group" aria-label="Applied project allocation, 0 to 100 percent, in project card order">${segments}</div><a href="/allocation">Adjust allocation →</a></div>`;
}
function moveBoundary(index, position) {
  const projects = allocationProjects();
  if (!policyDraft || index < 0 || index >= projects.length - 1) return;
  const left = projects.slice(0, index).reduce((sum, p) => sum + policyDraft.projects[p.slug].share, 0);
  const share = Math.max(0, Math.min(100 - left, Math.round(position) - left));
  const right = projects.slice(index + 1);
  const remaining = 100 - left - share;
  const total = right.reduce((sum, p) => sum + policyDraft.projects[p.slug].share, 0);
  const parts = right.map((p, order) => ({ slug: p.slug, order, raw: remaining * (total ? policyDraft.projects[p.slug].share / total : 1 / right.length) }));
  policyDraft.projects[projects[index].slug].share = share;
  let spare = remaining;
  for (const part of parts) { policyDraft.projects[part.slug].share = Math.floor(part.raw); spare -= Math.floor(part.raw); }
  parts.sort((a, b) => (b.raw % 1) - (a.raw % 1) || a.order - b.order);
  for (let i = 0; i < spare; i++) policyDraft.projects[parts[i].slug].share++;
  updateShares();
  markPolicyDirty();
}

function controlBlock(s) {
  ensureDraft(s);
  if (!policyDraft || !s.control) return '';
  const d = policyDraft;
  const projects = Object.values(s.control.projects);
  const workspaces = s.control.workspaces || [];
  let cumulative = 0;
  const shareSegments = projects.map((p) => allocationSegment(s, p, d.projects[p.slug]?.share || 0)).join('');
  const shareHandles = projects.slice(0, -1).map((p, i) => {
    const minimum = cumulative;
    cumulative += d.projects[p.slug]?.share || 0;
    return `<button type="button" class="allocation-handle" data-boundary="${i}" role="slider" aria-label="${esc(p.label)} allocation boundary" aria-valuemin="${minimum}" aria-valuemax="100" aria-valuenow="${cumulative}" aria-valuetext="${esc(p.label)} ${d.projects[p.slug]?.share || 0} percent" style="left:${cumulative}%"></button>`;
  }).join('');
  const ladderRows = (d.orchestratorLadder || []).map((rung, i) => {
    const cfg = models[rung.kind] ? { ...models[rung.kind], allowedModels: kindModels(rung.kind, d) } : { allowedModels: [rung.model], allowedEfforts: [] };
    return `<div class="succession-row"><span class="num">${i + 1}</span>
      <select data-ladder-kind="${i}" aria-label="Choice ${i + 1} harness">${Object.keys(models).map((kind) => `<option value="${esc(kind)}" ${kind === rung.kind ? 'selected' : ''}>${esc(kind)}</option>`).join('')}</select>
      <select data-ladder-model="${i}" aria-label="Choice ${i + 1} model">${cfg.allowedModels.map((model) => `<option value="${esc(model)}" ${model === rung.model ? 'selected' : ''}>${esc(model)}</option>`).join('')}</select>
      ${cfg.allowedEfforts.length ? `<select data-ladder-effort="${i}" aria-label="Choice ${i + 1} reasoning effort">${cfg.allowedEfforts.map((effort) => `<option value="${esc(effort)}" ${effort === (rung.effort || cfg.defaultEffort) ? 'selected' : ''}>${esc(effort)}</option>`).join('')}</select>` : '<span class="sub">Default effort</span>'}
      <div class="succession-actions"><button type="button" class="quiet" data-ladder-up="${i}" aria-label="Move choice ${i + 1} up" ${i ? '' : 'disabled'}>↑</button><button type="button" class="quiet" data-ladder-down="${i}" aria-label="Move choice ${i + 1} down" ${i === d.orchestratorLadder.length - 1 ? 'disabled' : ''}>↓</button><button type="button" class="quiet" data-ladder-remove="${i}" aria-label="Remove choice ${i + 1}" ${d.orchestratorLadder.length === 1 ? 'disabled' : ''}>Remove</button></div>
    </div>`;
  }).join('');
  const projectRows = projects.map((p) => {
    const x = d.projects[p.slug] || { share: 0, mode: 'auto', excludedKinds: [], excludedModels: [] };
    const availableKinds = d.allowedKinds;
    const projectModels = [...new Set(availableKinds.flatMap((k) => kindModels(k, d).filter((m) => modelOn(k, m, d))))];
    const eff = effectiveAllocation(p);
    const activity = allocationActivity(p);
    return `<div class="allocation-row ${activity}" data-project-row="${esc(p.slug)}">
      <div class="allocation-name"><b><i class="allocation-swatch" style="background-color:${allocationColor(s, p.slug)}"></i>${esc(p.label)}</b><small>${p.running}/${p.slots} working slots${p.borrowed ? ` · +${p.borrowed} borrowed` : ''}${p.lent ? ` · ${p.lent} lent` : ''}${p.offered ? ` · ${p.offered} free for others` : ''} · ${activity}</small></div>
      <div class="share-values"><span><small>Set</small><strong class="num share-value">${x.share}%</strong></span><span title="Applied state: ${esc(p.label)} has ${eff.slots} of ${state.policy?.maxWorkers ?? 0} worker slots now"><small>Effective</small><strong class="num">${eff.percent}% · ${eff.slots} slot${eff.slots === 1 ? '' : 's'}</strong></span></div>
      <select data-mode="${esc(p.slug)}" aria-label="${esc(p.label)} activity mode">${['auto','active','idle','paused'].map((m) => `<option value="${m}" ${x.mode === m ? 'selected' : ''}>${m}</option>`).join('')}</select>
      <details class="project-exclude"><summary>Exclude kinds / models</summary><div class="exclude-grid">${availableKinds.map((k) => `<label><input type="checkbox" data-exclude-kind="${esc(p.slug)}:${k}" ${x.excludedKinds.includes(k) ? 'checked' : ''}> ${esc(k)}</label>`).join('')}
      ${projectModels.map((m) => `<label><input type="checkbox" data-exclude-model="${esc(p.slug)}:${esc(m)}" ${x.excludedModels.includes(m) ? 'checked' : ''}> ${esc(m)}</label>`).join('')}</div></details>
    </div>`;
  }).join('');
  const workspaceRows = workspaces.map((workspace) => {
    const excluded = workspace.boss || (d.excludedWorkspaces || []).some((entry) => entry === workspace.label || entry === workspace.workspace);
    return `<label class="setting-line workspace-exclusion"><span>${esc(workspace.label)}${workspace.boss ? ' · automatically excluded while the boss pane is present' : ''}</span><input type="checkbox" data-workspace-exclusion="${esc(workspace.label)}" aria-label="${esc(workspace.label)} is not a project" ${excluded ? 'checked' : ''} ${workspace.boss ? 'disabled' : ''}></label>`;
  }).join('');
  return `<section id="control-plane"><h2>Policy settings <span class="sub">project shares are advisory · the worker CLI enforces the global cap</span></h2>
    <div class="panel control-shell">
      <div class="control-grid">
        <div><h3>Capacity &amp; handover</h3>
          <label class="setting-line"><span>Maximum working agents</span><input type="number" min="1" max="64" value="${d.maxWorkers}" data-policy-number="maxWorkers"></label>
          <label class="setting-line"><span>Borrow idle shares</span><input type="checkbox" data-policy-bool="borrowIdle" ${d.borrowIdle ? 'checked' : ''}></label>
          <label class="setting-line"><span>Idle after minutes</span><input type="number" min="0" max="1440" value="${d.idleMinutes}" data-policy-number="idleMinutes"></label>
          <label class="setting-line"><span>Orchestrator reserve %</span><input type="number" min="0" max="80" value="${d.reservePercent}" data-policy-number="reservePercent"></label>
          <label class="setting-line"><span>Handover lead minutes</span><input type="number" min="0" max="10080" value="${d.handoffLeadMinutes}" data-policy-number="handoffLeadMinutes"></label>
          <label class="setting-line"><span>Automatic handover</span><input type="checkbox" data-policy-bool="autoHandover" ${d.autoHandover ? 'checked' : ''}></label>
          <p class="setting-help">Apply policy to save this choice.</p>
          <label class="setting-line"><span>Activate at quota used %</span><input type="number" min="90" max="100" value="${d.autoHandoverPercent}" data-policy-number="autoHandoverPercent"></label>
          <p class="setting-help">When enabled, Boss prepares a successor at the reserve limit and activates it at this quota level after the successor reports ready. The source stays in control until then.</p>
          <label class="setting-line"><span>Hand over at context tokens</span><input type="number" min="50000" max="2000000" step="10000" value="${d.autoHandoverContextTokens}" data-policy-number="autoHandoverContextTokens"></label>
          <label class="setting-line goal-setting"><span>Default orchestrator goal</span><input type="text" maxlength="4000" value="${esc(d.defaultOrchestratorGoal ?? '')}" data-policy-text="defaultOrchestratorGoal"></label>
          <p class="setting-help">A handover copies the goal of the old orchestrator to the successor: the published status goal, else the last <code>/goal</code> command of its session. A new orchestrator with no goal gets this text. Leave it empty for no default. Use one line of at most 4000 characters. A Claude successor gets <code>/goal</code> after it answers. Other harnesses get the goal in the activation prompt.</p>
          <p class="setting-help">At a task boundary, a Claude orchestrator with a context above this many tokens gets a fresh successor from the project memory file, with the same model. Herdr Boss activates it when the orchestrator pane is not working. It reads the context size only for Claude. A pane it sees for the first time waits for its next boundary.</p>
          <p class="setting-help">Automatic handover never runs for the Boss, for a project that no longer works, for a project that is paused or stood down in its published status, or for a successor model that is weaker than the source model. After activation, Herdr Boss closes the old pane when the successor has answered and the old pane is idle.</p>
        </div>
      </div>
      <div class="succession"><div class="section-head"><h3>Orchestrator succession</h3><button type="button" data-ladder-add ${d.orchestratorLadder?.length >= 20 ? 'disabled' : ''}>Add choice</button></div>
        <p class="setting-help">Automatic handover tries these choices in order, skipping the current provider, unavailable quotas, and global or project exclusions. Choices outside this list are never selected automatically.</p>
        <div class="succession-list">${ladderRows}</div></div>
      <div class="allocations"><h3>Project shares <span class="sub">drag a boundary; only projects to its right rebalance · labels show set share · effective slots</span></h3>
        <div class="workspace-exclusions"><h4>Workspace projects</h4><p class="setting-help">Clear a workspace switch to include it as a project. The Boss workspace stays excluded while its pane is labelled <code>boss</code>.</p>${workspaceRows || '<p class="empty">No live workspaces.</p>'}</div>
        <div class="allocation-bar" role="group" aria-label="Project allocation, 0 to 100 percent">${shareSegments}${shareHandles}</div>
        <div class="allocation-scale"><span>0%</span><span>100%</span></div>
        ${projectRows}</div>
      <div class="control-actions ${policyDirty ? 'pending' : ''}"><span data-policy-status role="status">${esc(saveMessage || (policyDirty ? 'Unsaved changes · Apply policy to keep them' : `${s.control.runningWorkers}/${d.maxWorkers} workers active · policy saved`))}</span><button id="save-policy" ${policyDirty ? '' : 'disabled'}>Apply policy</button></div>
    </div></section>`;
}

// A model string holds letters, digits, dots, underscores, slashes, and hyphens. The server applies the same rule.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const settingsMessages = {};
// The price table of the Settings page. The draft keeps typed values across a refresh.
let priceTable = null;
const priceDraft = {};
let priceMessage = '';
const PRICE_COLUMNS = [['input', 'Input'], ['output', 'Output'], ['cacheRead', 'Cache read'], ['cacheWrite', 'Cache write 5 min'], ['cacheWrite1h', 'Cache write 1 h']];
function pricesPanel() {
  const intro = '<p class="setting-help">USD per million tokens. The cost that Herdr Boss shows is an <b>API-price equivalent</b>: a subscription is not billed per token. A blank field uses the default.</p>';
  if (!priceTable) return `<section id="price-settings" class="panel"><h2>Token prices</h2>${intro}<p class="setting-help">Prices are not loaded.</p></section>`;
  const rows = Object.entries(priceTable.prices || {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, p]) => {
    const cells = PRICE_COLUMNS.map(([field, label]) => {
      const draft = priceDraft[name]?.[field];
      const value = draft !== undefined ? draft : p[field] ?? '';
      const mark = (p.unconfirmed || []).includes(field) ? '<div class="muted">unconfirmed</div>' : '';
      return `<td><input type="number" min="0" max="1000" step="any" style="width:84px" value="${esc(value)}" data-price-model="${esc(name)}" data-price-field="${esc(field)}" aria-label="${esc(name)} ${esc(label)}">${mark}</td>`;
    }).join('');
    return `<tr><th scope="row"><code>${esc(name)}</code>${p.removed ? ' <span class="muted">removed</span>' : ''}</th>${cells}<td>${esc(p.source || '')}${p.date ? ` <span class="muted">${esc(p.date)}</span>` : ''}</td></tr>`;
  }).join('');
  const head = PRICE_COLUMNS.map(([, label]) => `<th scope="col">${label}</th>`).join('');
  return `<section id="price-settings" class="panel"><h2>Token prices</h2>${intro}<div class="service-settings-scroll"><table class="service-settings-table"><thead><tr><th scope="col">Model</th>${head}<th scope="col">Source</th></tr></thead><tbody>${rows}</tbody></table></div><p class="inline-feedback" role="status" aria-live="polite" data-price-message>${esc(priceMessage)}</p><div class="control-actions"><button type="button" data-save-prices>Save prices</button> <button type="button" class="quiet" data-reset-prices>Reset to defaults</button></div></section>`;
}
async function savePrices(reset, button) {
  const models = {};
  if (!reset) {
    for (const input of document.querySelectorAll('#price-settings [data-price-model]')) {
      const { priceModel: name, priceField: field } = input.dataset;
      if (input.value.trim() === '') continue;
      const value = Number(input.value);
      // Send only the figures that differ from the default table. The server checks the range.
      if (value === priceTable?.defaults?.[name]?.[field]) continue;
      (models[name] ||= {})[field] = value;
    }
  }
  const status = document.querySelector('[data-price-message]');
  button.disabled = true;
  try {
    const response = await fetch('/api/settings/prices', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ models }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The prices could not be saved.');
    priceTable = result;
    for (const key of Object.keys(priceDraft)) delete priceDraft[key];
    priceMessage = reset ? 'Prices reset to the defaults.' : 'Saved.';
    lastRender = '';
    render();
  } catch (error) {
    priceMessage = error.message;
    if (status) status.textContent = error.message;
  } finally { button.disabled = false; }
}
document.addEventListener('input', (e) => {
  const input = e.target.closest?.('#price-settings [data-price-model]');
  if (input) (priceDraft[input.dataset.priceModel] ||= {})[input.dataset.priceField] = input.value;
});
document.addEventListener('click', (e) => {
  const save = e.target.closest?.('[data-save-prices]');
  if (save) savePrices(false, save);
  const reset = e.target.closest?.('[data-reset-prices]');
  if (reset) savePrices(true, reset);
});
const serviceSettingsMessages = {};
const avatarMessages = {};
const nullableServiceSettings = new Set(['watch.maxWorkers']);
// The kit catalog of a harness plus the local extra models in the policy draft.
function kindModels(kind, d = policyDraft) {
  const base = models[kind]?.allowedModels || [];
  return [...base, ...(d?.extraModels?.[kind] || []).filter((model) => !base.includes(model))];
}
// The global exclusion list and the list of the harness each disable a model.
function modelOn(kind, model, d = policyDraft) {
  return !(d?.excludedModels || []).includes(model) && !(d?.disabledModels?.[kind] || []).includes(model);
}
// The same precedence as providerFor on the server: harness route, legacy model route, then harness and prefix rules.
// The provider of a legacy modelProviders route that this harness cannot use and that no harness route overrides.
// The server treats such a route as unmetered at load time and refuses it at save time.
function ignoredLegacyRoute(kind, model, d = policyDraft) {
  if (d?.harnessRoutes?.[kind] && Object.hasOwn(d.harnessRoutes[kind], model)) return null;
  if (!d?.modelProviders || !Object.hasOwn(d.modelProviders, model)) return null;
  const legacy = d.modelProviders[model];
  return legacy !== null && !harnessProviders(kind).includes(legacy) ? legacy : null;
}
function routeFor(kind, model, d = policyDraft) {
  const routes = d?.harnessRoutes?.[kind];
  if (routes && Object.hasOwn(routes, model)) return routes[model];
  if (ignoredLegacyRoute(kind, model, d)) return null;
  if (d?.modelProviders && Object.hasOwn(d.modelProviders, model)) return d.modelProviders[model];
  if (kind === 'codex' || kind === 'claude') return kind;
  return model.startsWith('opencode-go/') ? 'opencodego' : null;
}
// Codex and Claude run only their own subscription models. Open harnesses can use any provider. The server applies the same rule.
function harnessProviders(kind) {
  return kind === 'codex' || kind === 'claude' ? [kind] : Object.keys(PROVIDERS);
}
// A project may exclude only a model that an available harness enables, so drop the other exclusions.
function pruneProjectModels(d) {
  const enabled = new Set(d.allowedKinds.flatMap((kind) => kindModels(kind, d).filter((model) => modelOn(kind, model, d))));
  for (const p of Object.values(d.projects)) p.excludedModels = (p.excludedModels || []).filter((model) => enabled.has(model));
}

function harnessSection(kind, cfg, d) {
  const extras = d.extraModels?.[kind] || [];
  const list = kindModels(kind, d);
  const providers = harnessProviders(kind);
  const rows = list.map((model) => {
    const route = routeFor(kind, model, d);
    const ignored = ignoredLegacyRoute(kind, model, d);
    const local = extras.includes(model);
    const noteId = `route-note-${kind}-${model}`.replace(/[^A-Za-z0-9_-]/g, '-');
    const choices = providers.map((provider) => PROVIDERS[provider]).concat('Unmetered').join(' or ');
    // An ignored legacy route has a placeholder that cannot be chosen again, so any choice stores a compatible harness route.
    return `<li class="harness-model"><label><input type="checkbox" data-harness-model="${esc(kind)}" data-model="${esc(model)}" ${modelOn(kind, model, d) ? 'checked' : ''}> <span>${esc(model)}</span>${local ? ' <span class="tag">local</span>' : ''}</label>
      <select data-harness-route="${esc(kind)}" data-model="${esc(model)}" aria-label="Provider for ${esc(model)} in ${esc(kind)}" ${ignored ? `aria-describedby="${noteId}"` : ''}>${ignored ? '<option value="" disabled selected data-ignored-route>Ignored</option>' : ''}<option value="unmetered" ${route === null && !ignored ? 'selected' : ''}>Unmetered</option>${providers.map((provider) => `<option value="${provider}" ${route === provider ? 'selected' : ''}>${esc(PROVIDERS[provider])}</option>`).join('')}</select>
      ${local ? `<button type="button" class="quiet" data-remove-model="${esc(kind)}" data-model="${esc(model)}" aria-label="Remove ${esc(model)} from ${esc(kind)}">Remove</button>` : '<span aria-hidden="true"></span>'}
      ${ignored ? `<p class="setting-help" id="${noteId}" data-route-note style="grid-column: 1 / -1; max-width: none; margin: 0 0 6px; color: var(--warn)">The legacy route to ${esc(PROVIDERS[ignored] || ignored)} is ignored. ${esc(kind)} treats this model as Unmetered. Choose ${esc(choices)}, then Apply policy.</p>` : ''}</li>`;
  }).join('');
  return `<section class="harness" data-harness="${esc(kind)}" aria-labelledby="harness-${esc(kind)}">
    <div class="harness-head"><h3 id="harness-${esc(kind)}">${esc(kind)}</h3><label><input type="checkbox" data-kind="${esc(kind)}" ${d.allowedKinds.includes(kind) ? 'checked' : ''}> Available</label></div>
    <label class="setting-line"><span>Preferred model</span><select data-preferred-model="${esc(kind)}"><option value="">Harness default (${esc(cfg.defaultModel)})</option>${list.map((model) => `<option value="${esc(model)}" ${d.preferredModels?.[kind] === model ? 'selected' : ''}>${esc(model)}</option>`).join('')}</select></label>
    <div class="harness-columns" aria-hidden="true"><span>Model</span><span>Provider</span></div>
    <ul class="harness-models">${rows}</ul>
    <form class="add-model" data-add-model="${esc(kind)}"><input name="model" data-add-model-input="${esc(kind)}" autocomplete="off" spellcheck="false" placeholder="vendor/model-id" aria-label="New model string for ${esc(kind)}" maxlength="128"><button type="submit" class="quiet">Add model</button></form>
    <p class="inline-feedback" role="status" data-settings-message="${esc(kind)}">${esc(settingsMessages[kind] || '')}</p>
  </section>`;
}

function localDateTime(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const two = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
}

// A stale row is the last good row of a provider whose latest probe failed. It still counts as quota data.
const hasQuotaData = (q) => !q?.error || q.stale === true;
const staleQuotaText = (q) => `${PROVIDERS[q.provider] || q.provider} quota from ${clock(q.staleSince)} (probe failed)`;
function quotaThresholds(s, fallback = { warnPercent: 90, criticalPercent: 98 }) {
  const values = s?.quotaThresholds || {};
  return {
    warnPercent: Number.isFinite(values.warnPercent) ? values.warnPercent : fallback.warnPercent,
    criticalPercent: Number.isFinite(values.criticalPercent) ? values.criticalPercent : fallback.criticalPercent,
  };
}

function pacingDraftError(draft, quotas, now = Date.now()) {
  for (const [provider, windows] of Object.entries(draft.pacingGoals || {})) for (const [key, goal] of Object.entries(windows || {})) {
    if (!goal?.end) continue;
    const window = (quotas || []).find((q) => q.provider === provider && hasQuotaData(q))?.windows?.find((w) => w.key === key && !w.extra);
    const reset = Date.parse(window?.resetsAt);
    const start = reset - window?.windowMinutes * 60000;
    const end = goal.end.type === 'at' ? Date.parse(goal.end.at) : reset - goal.end.hours * 3600000;
    const name = `${PROVIDERS[provider] || provider} ${window?.label || key}`;
    if (goal.end.type === 'hoursBeforeReset' && (!Number.isSafeInteger(goal.end.hours) || goal.end.hours < 1)) return `${name}: enter a positive whole number of hours before reset.`;
    if (!Number.isFinite(reset) || !Number.isFinite(start)) return `${name}: wait for a measured quota window before setting an end.`;
    if (!Number.isFinite(end) || end <= now) return `${name}: the goal end must be after now.`;
    if (end > reset) return `${name}: the goal end must be at or before reset.`;
    if (end <= start) return `${name}: the goal end must be after the window start.`;
  }
  return null;
}

// The Owner's own image for the Boss and for each project. The page uses the generated avatar when no image is stored.
function avatarSettings(s) {
  const rows = [{ slug: 'boss', title: 'Boss' }, ...Object.entries(s.control?.projects || {}).map(([slug, project]) => ({ slug, title: project?.label || slug }))];
  const list = rows.map((row) => `<div class="avatar-row">
    ${avatarSlot(row.slug, { title: avatarTitle(row.slug, row.title), size: 28 })}
    <span class="avatar-row-name">${esc(row.title)}</span>
    <label class="avatar-upload"><span>Upload image</span><input type="file" accept="image/png,image/jpeg,image/webp" data-avatar-upload="${esc(row.slug)}" aria-label="Upload an image for ${esc(row.title)}"></label>
    <button type="button" data-avatar-reset="${esc(row.slug)}">Reset</button>
    <span class="avatar-status" role="status" aria-live="polite" data-avatar-status="${esc(row.slug)}">${esc(avatarMessages[row.slug] || '')}</span>
  </div>`).join('');
  return `<section class="panel avatar-settings"><h2>Avatars</h2><p class="setting-help">Each row holds the avatar of the Boss or of a project. Choose <b>Upload image</b> to use your own image. Choose <b>Reset</b> to use the generated avatar again. An image is a PNG, JPEG, or WebP file of at most 512 KB. Herdr Boss keeps no other format.</p>${list || '<p class="setting-help">No project is open.</p>'}</section>`;
}

// The Owner's own avatar image. The page sends the file as it is, and the service checks the bytes.
async function uploadAvatar(slug, input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (file.size > AVATAR_MAX_BYTES) { avatarMessages[slug] = `The file is larger than 512 KB. Choose a smaller image.`; lastRender = ''; render(true); return; }
  avatarMessages[slug] = 'Uploading…';
  lastRender = ''; render(true);
  try {
    const response = await fetch(`/api/avatars/${encodeURIComponent(slug)}`, { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The image could not be stored.');
    avatarMessages[slug] = 'The image is in use. It shows at once in the Chat, the Mailbox, and the Agents chart.';
  } catch (error) { avatarMessages[slug] = error.message; }
  finally {
    if (input) input.value = '';
    lastRender = ''; render(true);
  }
}

async function resetAvatar(slug, button) {
  avatarMessages[slug] = 'Removing…';
  lastRender = ''; render(true);
  try {
    const response = await fetch(`/api/avatars/${encodeURIComponent(slug)}`, { method: 'DELETE' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The image could not be removed.');
    avatarMessages[slug] = 'The generated avatar is in use again.';
  } catch (error) { avatarMessages[slug] = error.message; }
  finally {
    if (button?.isConnected) button.focus();
    lastRender = ''; render(true);
  }
}

// An image of the Owner replaces the generated avatar. A missing image keeps the generated one.
document.addEventListener('load', (e) => avatarImageLoaded(e.target), true);
document.addEventListener('error', (e) => avatarImageFailed(e.target), true);

document.addEventListener('change', (e) => {
  const upload = e.target.dataset?.avatarUpload;
  if (!upload) return;
  uploadAvatar(upload, e.target);
});

function settingsView(s) {
  ensureDraft(s);
  if (!policyDraft) return '';
  const d = policyDraft;
  const { warnPercent, criticalPercent } = quotaThresholds(s);
  const harnesses = Object.entries(models || {}).map(([kind, cfg]) => harnessSection(kind, cfg, d)).join('');
  const ignoredCount = Object.keys(models || {}).reduce((n, kind) => n + kindModels(kind, d).filter((model) => ignoredLegacyRoute(kind, model, d)).length, 0);
  const providerRows = Object.keys(d.providerModes).map((p) => `<label class="setting-line"><span>${esc(PROVIDERS[p] || p)}</span><select data-provider="${esc(p)}" aria-label="${esc(PROVIDERS[p] || p)} quota mode"><option value="managed" ${d.providerModes[p] === 'managed' ? 'selected' : ''}>Manage pace</option><option value="ignore" ${d.providerModes[p] === 'ignore' ? 'selected' : ''}>Ignore quota</option></select></label>`).join('');
  const machine = d.machine || {};
  const machineNumber = (key, label, max, nullable = false, min = 0) => `<label class="setting-line"><span>${label}</span><input type="number" min="${min}" max="${max}" ${nullable ? 'step="any" placeholder="Disabled"' : ''} value="${machine[key] ?? ''}" data-policy-machine="${key}"></label>`;
  const guardMode = machineGuardMode(machine);
  const pauseHours = [1, 2, 4, 8, 12, 24].map((hours) => `<option value="${hours}">${hours} hour${hours === 1 ? '' : 's'}</option>`).join('');
  const machineGuardSettings = `<div class="machine-guard-controls"><label class="setting-line"><span>Machine guard · ${guardMode}${guardMode === 'paused' ? esc(machineGuardUntilText(machine.guardPausedUntil)) : ''}</span><input type="checkbox" role="switch" aria-label="Machine guard enabled" data-policy-machine-bool="guardEnabled" ${machine.guardEnabled ? 'checked' : ''}></label><div class="action-row"><label class="setting-line"><span>Pause for</span><select aria-label="Machine guard pause duration" data-machine-pause-hours>${pauseHours}</select></label><button type="button" data-machine-guard-draft="pause">Pause guard</button>${guardMode === 'active' ? '' : '<button type="button" data-machine-guard-draft="resume">Resume guard</button>'}</div><p class="setting-help">${esc(machineGuardMessage || (guardMode === 'paused' ? `The guard resumes ${machineGuardUntilText(machine.guardPausedUntil).slice(7)}.` : guardMode === 'off' ? 'CPU and load limits do not block worker starts while the guard is off.' : 'CPU and load limits block worker starts while the guard is active.'))}</p></div>`;
  const machineSettings = `<section class="panel"><h2>Machine</h2><p class="setting-help">The Owner is away after the idle period. CPU is a percent of total machine capacity. Disk alerts stay active when the CPU and load guard is off or paused. Disk thresholds use free GB. GB uses 2³⁰ bytes. The swap warning starts at the swap percent below when 3 samples in a row are at or above it and at least the minimum GB is in use. It stays off the guard switch and never blocks work. The swap refusal is off by default. When the switch below is on, an orchestrator or a worker cannot start a worker, a suite, or a push with a pre-push suite while swap is at or above the refusal percent and at least the minimum GB is in use. The message shows the swap figure. Start work with --force-swap, or set HERDR_BOSS_FORCE_SWAP=1 for suite and push, to override. Work that the Owner or the Boss starts is never refused. A null refusal percent switches the refusal off.</p><label class="setting-line"><span>Refuse new work at high swap</span><input type="checkbox" role="switch" aria-label="Refuse new work at high swap" data-policy-machine-bool="swapRefuseEnabled" ${machine.swapRefuseEnabled ? 'checked' : ''}></label>${machineGuardSettings}${machineNumber('ownerAwayMinutes', 'Owner away after minutes', 1440)}${machineNumber('presentCpuPercent', 'CPU limit while present %', 100)}${machineNumber('awayCpuPercent', 'CPU limit while away %', 100, true)}${machineNumber('presentLoadFactor', 'Present load backstop × cores', 128, true)}${machineNumber('awayLoadFactor', 'Away load backstop × cores', 128, true)}${machineNumber('diskWarnFreeGB', 'Disk warning below free GB', 1048576)}${machineNumber('diskCriticalFreeGB', 'Disk critical below free GB', 1048576)}${machineNumber('swapWarnPercent', 'Swap warning at % used', 100, true, 1)}${machineNumber('swapRefusePercent', 'Swap refusal at % used', 100, true, 1)}${machineNumber('swapMinUsedGB', 'Swap rules need at least GB used', 1024)}<label class="setting-line"><span>Notice cooldown seconds</span><input type="number" min="0" max="604800" value="${machine.alertCooldownSeconds}" data-policy-machine="alertCooldownSeconds"></label></section>`;
  // A goal exists only for a live, measured window with a stable key. Extra model-only windows do not get one.
  const goalWindows = [];
  for (const q of s.quotas || []) {
    if (!hasQuotaData(q)) continue;
    for (const w of q.windows || []) if (!w.extra && w.key != null) goalWindows.push({ provider: q.provider, key: w.key, label: w.label, resetsAt: w.resetsAt });
  }
  const goalRows = goalWindows.length
    ? goalWindows.map(({ provider, key, label, resetsAt }) => {
      const value = d.pacingGoals?.[provider]?.[key];
      const percent = typeof value === 'object' ? value.percent : value;
      const end = typeof value === 'object' ? value.end : null;
      const id = `${esc(provider)}:${esc(key)}`;
      const kind = end?.type || 'reset';
      const endValue = kind === 'at' ? localDateTime(end.at) : end?.hours ?? '';
      return `<div class="setting-line" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));align-items:end;margin-bottom:12px"><label style="display:grid;gap:4px"><span>${esc(PROVIDERS[provider] || provider)} ${esc(label)} goal %</span><input type="number" min="0" max="100" step="1" placeholder="100" value="${percent ?? ''}" data-pacing-goal="${id}"></label><label style="display:grid;gap:4px"><span>Goal end</span><select data-pacing-end-type="${id}"><option value="reset" ${kind === 'reset' ? 'selected' : ''}>At reset</option><option value="at" ${kind === 'at' ? 'selected' : ''}>One-off local date and time</option><option value="hoursBeforeReset" ${kind === 'hoursBeforeReset' ? 'selected' : ''}>Hours before reset, every window</option></select></label>${kind === 'at' ? `<label style="display:grid;gap:4px"><span>Local date and time</span><input type="datetime-local" value="${esc(endValue)}" data-pacing-end-value="${id}"></label>` : kind === 'hoursBeforeReset' ? `<label style="display:grid;gap:4px"><span>Whole hours before reset</span><input type="number" min="1" step="1" value="${esc(endValue)}" data-pacing-end-value="${id}"></label>` : ''}<span class="setting-help" style="grid-column:1/-1">Resets ${esc(resetsAt || 'unknown')}${end ? ` · Goal ${esc(percent)}% ${kind === 'at' ? `by ${esc(localDateTime(end.at) || 'choose a time')}` : `${esc(end.hours)} h before reset`}` : ''}</span></div>`;
    }).join('')
    : '<p class="setting-help">No measured quota window yet. A goal field appears after the next quota reading.</p>';
  const quotaPanel = `<section class="panel"><h2>Provider quotas</h2><p class="setting-help">Quota warning at ${esc(warnPercent)}%, critical at ${esc(criticalPercent)}%. Set them in config.json.</p><h3>Quota mode</h3>${providerRows}<p class="setting-help">Ignore quota turns off pacing and pace warnings for worker dispatch. Handover risk and automatic handover still use live quota data.</p><h3 class="quota-goals">Pacing goals</h3><p class="setting-help">The most percent of a window to use by its end. Blank means 100%. A one-off end uses your local time. A recurring end is a whole number of hours before reset.</p>${goalRows}</section>`;
  const settingsGroups = ['Machine', 'Quota', 'Status', 'Workers', 'Browsers', 'Service'];
  const serviceSettingRanges = {
    'machine.memFreeWarnPercent': [1, 50],
    'quota.warnPercent': [50, 99],
    'quota.criticalPercent': [51, 100],
    staleStatusMinutes: [5, 1440],
    'workers.staleIdleMinutes': [5, 1440],
    'watch.maxWorkers': [1, 40],
    'watch.maxWorkersByLane': [1, 40],
    'browsers.staleOwnedMinutes': [5, 1440],
    'browsers.orphanDaemonMinAgeSeconds': [60, 86400],
  };
  const serviceSettingBooleans = new Set(['browsers.reapOrphanDaemons', 'browsers.sweepCodeSignClones']);
  const serviceRows = settingsGroups.map((group) => {
    const groupRows = (s.serviceSettings || []).filter((item) => item.group === group).map((item) => {
      const value = item.value !== null && typeof item.value === 'object' ? JSON.stringify(item.value) : item.value == null ? '' : String(item.value);
      const range = serviceSettingRanges[item.setting];
      const input = item.setting === 'watch.maxWorkersByLane'
        ? `<div style="display:grid;grid-template-columns:repeat(2,minmax(100px,1fr));gap:8px">${[['unmetered', 'Unmetered'], ['codex', 'Codex'], ['claude', 'Claude'], ['opencodego', 'OpenCode Go']].map(([lane, label]) => `<label style="display:grid;gap:3px"><span>${label}</span><input type="number" min="1" max="40" step="1" value="${esc(item.value?.[lane] ?? '')}" placeholder="Day value" data-service-setting="${esc(item.setting)}" data-service-lane="${lane}" data-service-group="${esc(group)}" aria-label="Watch ${label} worker cap"></label>`).join('')}</div>`
        : serviceSettingBooleans.has(item.setting)
        ? `<input type="checkbox" data-service-setting="${esc(item.setting)}" data-service-group="${esc(group)}" aria-label="${esc(item.setting)}" ${item.value ? 'checked' : ''}>`
        : range
          ? `<input type="number" min="${range[0]}" max="${range[1]}" step="1" value="${esc(value)}" placeholder="${nullableServiceSettings.has(item.setting) ? 'Day value' : ''}" data-service-setting="${esc(item.setting)}" data-service-group="${esc(group)}" aria-label="${esc(item.setting)}">`
          : `<code>${esc(value)}</code>`;
      return `<tr><th scope="row"><code>${esc(item.setting)}</code></th><td>${input}</td><td>${item.source === 'config' ? 'from config.json' : 'default'}</td></tr>`;
    }).join('');
    const canSave = (s.serviceSettings || []).some((item) => item.group === group && (serviceSettingRanges[item.setting] || serviceSettingBooleans.has(item.setting)));
    const controls = canSave ? `<span class="service-settings-group-actions"><span role="status" aria-live="polite" data-service-settings-status="${esc(group)}">${esc(serviceSettingsMessages[group] || '')}</span><button type="button" data-save-service-settings="${esc(group)}">Save</button></span>` : '';
    return `<tr class="service-settings-group"><th colspan="3" scope="colgroup"><span>${group}</span>${controls}</th></tr>${groupRows}`;
  }).join('');
  const serviceSettings = `<section id="service-settings" class="panel service-settings-panel"><h2>Service settings</h2><div class="service-settings-scroll"><table class="service-settings-table"><thead><tr><th scope="col">Setting</th><th scope="col">Value</th><th scope="col">Source</th></tr></thead><tbody>${serviceRows}</tbody></table></div><p class="service-settings-note">Rows without inputs are read-only. Change in config.json and restart.</p></section>`;
  // The harness readiness rows hold a status, the area, and a fixed item label. The state holds no path or value.
  const harnessFindings = s?.harness?.findings || [];
  const harnessRows = harnessFindings.length
    ? harnessFindings.map((finding) => `<tr><td><span class="harness-readiness-status harness-readiness-${esc(finding.status)}">${esc(finding.status)}</span></td><td>${esc(finding.area)}</td><td>${esc(finding.item)}</td></tr>`).join('')
    : '<tr><td colspan="3" class="harness-readiness-empty">No readiness data yet.</td></tr>';
  const harnessPanel = `<section class="panel harness-readiness-panel"><h2>Harness readiness</h2><div class="service-settings-scroll"><table class="service-settings-table harness-readiness-table"><thead><tr><th scope="col">Status</th><th scope="col">Area</th><th scope="col">Item</th></tr></thead><tbody>${harnessRows}</tbody></table></div><p class="service-settings-note">Run herdr-boss harness sync to see the changes to make.</p></section>`;
  const night = s.night || { active: false };
  const nightPanel = `<section class="panel night-panel"><h2>Watch</h2><p class="setting-help">The Watch control is on the <a href="/agents#watch">Agents page</a>.</p></section>`;
  const settingsPanels = `${quotaPanel}${machineSettings}${nightPanel}${watchRoutineSettings(s)}${avatarSettings(s)}${serviceSettings}${pricesPanel()}${harnessPanel}`;
  return `<header class="page-intro"><div><h1>Settings</h1><p>Assign models and provider routes in each harness. Set provider quotas and machine limits below.</p></div></header><section id="settings-plane" class="control-shell"><section class="panel"><h2>Harnesses</h2><p class="setting-help harness-help">Clear a model box to stop that harness from using it. The same model in another harness keeps its own box and provider.</p>${ignoredCount ? `<p class="setting-help harness-help" role="note" style="color: var(--warn)">${ignoredCount} legacy provider route${ignoredCount === 1 ? ' is' : 's are'} not compatible with ${ignoredCount === 1 ? 'its harness' : 'their harnesses'}. Herdr Boss treats ${ignoredCount === 1 ? 'it' : 'them'} as Unmetered. Choose a provider in each marked row before you apply the policy.</p>` : ''}<div class="harness-grid">${harnesses}</div></section><div class="settings-grid">${settingsPanels}</div><div class="control-actions ${policyDirty ? 'pending' : ''}"><span data-policy-status role="status" aria-live="polite">${esc(saveMessage || (policyDirty ? 'Unsaved changes · Apply policy to keep them' : 'Policy saved'))}</span><button id="save-policy" ${policyDirty ? '' : 'disabled'}>Apply policy</button></div></section>`;
}

// The handoff records that need the Owner: an open record whose source pane and successor pane still exist.
// A record in another state, or a record with a missing pane, is stale. The pane check is skipped when the pane list is unknown.
// A goal shows as one collapsed line. Select the line to read the whole text.
function goalField(label, text, source = '') {
  if (typeof text !== 'string' || !text.trim()) return '';
  return `<details class="goal-field"><summary><b>${esc(label)}</b><span class="goal-line">${esc(text)}</span></summary><p>${esc(text)}</p>${source ? `<p class="muted">Source: ${esc(source)}</p>` : ''}</details>`;
}

function openHandoffRecords(records, panes) {
  const live = Array.isArray(panes) ? new Set(panes.map((p) => p.id)) : null;
  return (Array.isArray(records) ? records : []).filter((x) => x && HANDOFF_OPEN.includes(x.status) && x.newPane && (!live || (live.has(x.newPane) && (!x.sourcePane || live.has(x.sourcePane)))));
}

function handoffBlock(s, projectSlug = null) {
  // The Overview shows prepared records only. A recommendation without a record belongs to the project page.
  const candidates = projectSlug ? [...(s.control?.handoffs || []), ...(s.control?.bossHandoff ? [s.control.bossHandoff] : [])].filter((h) => h.project === projectSlug) : [];
  const project = projectSlug && s.control?.projects?.[projectSlug];
  if (project?.orch && !candidates.length) candidates.push({ project: projectSlug, pane: project.orch.pane, fromKind: project.orch.kind, target: null, window: null });
  const prepared = openHandoffRecords(handoffRecords, s.herdr?.panes).filter((x) => !projectSlug || x.project === projectSlug);
  const cards = [
    ...prepared.map((item) => {
      const output = handoffOutputs[item.id];
      return `<article class="handoff-item panel"><div class="handoff-head"><div><b>${esc(item.displayLabel || s.control?.projects?.[item.project]?.label || item.project)}</b><p>Successor ${item.status === 'prepared' ? 'prepared' : 'needs inspection'} · ${esc(item.toKind)} / ${esc(item.model)}</p></div><span class="tag">${item.status !== 'prepared' ? 'Inspect pane' : item.automatic ? item.readyAt ? 'Ready for automatic activation' : 'Awaiting successor readiness' : 'Awaiting review'}</span></div>
        ${goalField('Goal', item.goal, ({ status: 'published status', transcript: 'source session', default: 'default goal in Settings' })[item.goalSource] || '')}
        <p>${item.status !== 'prepared' ? `Preparation stopped. Inspect pane ${esc(item.newPane)} before taking further action.` : item.automatic ? 'Automatic handover is enabled. The source remains in control until the successor reports ready and the quota reaches the activation level. You can inspect and activate it sooner.' : 'The source orchestrator still controls this project. Inspect the successor\'s response before transferring the label.'}</p>
        <div class="action-row"><button type="button" data-handoff-output="${esc(item.id)}" ${handoffBusy.has(item.id) ? 'disabled' : ''}>Inspect successor</button><span class="inline-feedback" role="status">${esc(handoffMessages[item.id] || item.promptError || '')}</span></div>
        ${output != null ? `<pre class="handoff-output">${esc(output)}</pre>${item.status === 'prepared' ? `<label class="review-check"><input type="checkbox" data-handoff-reviewed="${esc(item.id)}" ${handoffReviewed.has(item.id) ? 'checked' : ''}> I have reviewed the successor's response</label><button type="button" data-handoff-activate="${esc(item.id)}" ${!handoffReviewed.has(item.id) || handoffBusy.has(item.id) ? 'disabled' : ''}>Confirm activation</button>` : ''}` : ''}
      </article>`;
    }),
    ...candidates.filter((h) => !prepared.some((x) => x.sourcePane === h.pane)).map((h) => {
      const eligible = Object.entries(s.control.globalAllowed || {}).filter(([kind]) => (projectSlug || kind !== h.fromKind) && !s.control.projects[h.project]?.excludedKinds.includes(kind)).map(([kind, names]) => [kind, names.filter((model) => !s.control.projects[h.project]?.excludedModels.includes(model) && !s.control.risks?.[model.startsWith('opencode-go/') ? 'opencodego' : kind])]).filter(([, names]) => names.length);
      const target = handoffTargets[h.pane] || (eligible.some(([kind]) => kind === h.target?.kind) ? h.target.kind : eligible[0]?.[0]) || '';
      const availableModels = eligible.find(([kind]) => kind === target)?.[1] || [];
      const model = availableModels.includes(handoffModels[h.pane]) ? handoffModels[h.pane] : availableModels.includes(h.target?.model) ? h.target.model : availableModels[0] || '';
      const efforts = models[target]?.allowedEfforts || [];
      const effort = efforts.includes(handoffEfforts[h.pane]) ? handoffEfforts[h.pane] : efforts.includes(h.target?.effort) ? h.target.effort : models[target]?.defaultEffort;
      const mode = handoffModes[h.pane] || h.defaultMode || (['codex', 'claude'].includes(target) ? 'migrate' : 'fresh');
      const modeOptions = h.defaultMode === 'fresh'
        ? '<option value="fresh" selected>Fresh bootstrap</option>'
        : `<option value="migrate" ${mode === 'migrate' ? 'selected' : ''}>Migrated session</option><option value="fresh" ${mode === 'fresh' ? 'selected' : ''}>Fresh bootstrap</option>`;
      const plan = handoffPlans[h.pane];
      const sourceDescription = h.defaultMode === 'fresh'
        ? `Boss pane is present · no active agent · ${esc(h.pane)}`
        : h.window ? `${esc(h.fromKind)} is at ${h.window.usedPercent}% · ${esc(h.window.label)} quota` : `Current orchestrator · ${esc(h.fromKind)} · ${esc(h.pane)}`;
      const handoffDescription = h.defaultMode === 'fresh'
        ? 'Start a fresh successor from this workspace and source pane.'
        : h.window ? 'Prepare another orchestrator before this provider becomes unavailable.' : 'Start a successor when you want to change harnesses or refresh this orchestrator.';
      return `<article class="handoff-item panel"><div class="handoff-head"><div><b>${esc(h.label || s.control.projects[h.project]?.label || h.project)}</b><p>${sourceDescription}</p></div><span class="tag">${h.window ? 'Handover needed' : 'Manual handover'}</span></div>
        <p>${handoffDescription} ${h.defaultMode === 'fresh' ? '' : 'The current pane remains in charge until activation.'}</p>
        <div class="handoff-controls"><label>Successor<select data-handoff-target="${esc(h.pane)}">${eligible.map(([kind]) => `<option value="${esc(kind)}" ${kind === target ? 'selected' : ''}>${esc(kind)}</option>`).join('')}</select></label><label>Model<select data-handoff-model="${esc(h.pane)}">${availableModels.map((name) => `<option value="${esc(name)}" ${name === model ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select></label>${efforts.length ? `<label>Effort<select data-handoff-effort="${esc(h.pane)}">${efforts.map((name) => `<option value="${esc(name)}" ${name === effort ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select></label>` : ''}<label>Start from<select data-handoff-mode="${esc(h.pane)}">${modeOptions}</select></label></div>
        <div class="action-row"><button type="button" data-handoff-plan="${esc(h.pane)}" ${!eligible.length || handoffBusy.has(h.pane) ? 'disabled' : ''}>Plan handover</button>${plan ? `<button type="button" data-handoff-prepare="${esc(h.pane)}" ${handoffBusy.has(h.pane) ? 'disabled' : ''}>Prepare successor</button>` : ''}<span class="inline-feedback" role="status">${esc(handoffMessages[h.pane] || '')}</span></div>
        ${plan ? `<div class="plan-result">${plan.mode === 'fresh' ? 'Fresh bootstrap: the successor will read project files and the source pane.' : plan.migration?.available ? `Migration available · ${plan.migration.records ?? '?'} records · ${plan.migration.warnings ?? 0} warnings.` : `Migration unavailable: ${esc(String(plan.migration?.error || 'unknown reason').replace(/\.$/, ''))}. Prepare will use fresh mode.`}</div>` : ''}
      </article>`;
    }),
  ];
  const empty = projectSlug && !project?.orch ? '<div class="calm-state">No labeled orchestrator is available for this workspace. Label its pane <code>orch</code> in Herdr before planning a handover.</div>' : '<p class="empty">No orchestrator handovers need action.</p>';
  const countText = cards.length ? (projectSlug && !prepared.length && !candidates.some((h) => h.window) ? 'Start when needed' : `${cards.length} need review`) : 'No handovers pending';
  const head = `<div class="section-head"><h2>Project continuity</h2><span>${countText}</span></div>`;
  const body = cards.length ? `<div class="handoff-list">${cards.join('')}</div>` : empty;
  if (!projectSlug) return `<section class="handoff-section">${head}${body}</section>`;
  return collapsible({ slug: projectSlug, key: 'continuity', className: 'handoff-section', head, title: 'Project continuity', count: countText, body });
}

function browserViewToggle(slug, withProject = true) {
  const attr = withProject ? ` data-browser-project="${esc(slug)}"` : '';
  return `<div class="browser-view-toggle" role="group" aria-label="Browser view"><button type="button" data-browser-view="tab"${attr} aria-pressed="${!gridMode(slug)}">One tab</button><button type="button" data-browser-view="grid"${attr} aria-pressed="${gridMode(slug)}">All tabs</button></div>`;
}

function browserTabCloseButton(slug, tab) {
  return `<button type="button" class="browser-tab-close" data-browser-close-tab="${esc(slug)}" data-tab="${esc(tab.id)}" aria-label="Close tab ${esc(tab.title || 'Untitled page')}" title="Close this tab">×</button>`;
}

// The one-tab view lists every tab as a row. Select a row to show it, or close it with the × control.
function browserTabRow(slug, tab) {
  const selected = tab.id === browserSelectedTab[slug];
  return `<div class="browser-tab-row${selected ? ' selected' : ''}" role="listitem"><button type="button" class="browser-tab-pick" data-browser-pick-tab="${esc(slug)}" data-tab="${esc(tab.id)}" aria-current="${selected ? 'true' : 'false'}" title="Show this tab">${esc(browserTabLabel(tab))}</button>${browserTabCloseButton(slug, tab)}</div>`;
}

function browserTabList(slug) {
  const tabs = browserTabs[slug] || [];
  if (!tabs.length) return '<p class="browser-tab-none">No tabs are open.</p>';
  return `<div class="browser-tab-list" role="list" aria-label="Browser tabs">${tabs.map((tab) => browserTabRow(slug, tab)).join('')}</div>`;
}

function browserGridMarkup(slug) {
  const tabs = browserTabs[slug] || [];
  if (!tabs.length) return '<div class="browser-preview-empty">No tabs are open.</div>';
  const cols = Math.ceil(Math.sqrt(tabs.length));
  return `<div class="browser-tab-grid" style="--cols:${cols};--rows:${Math.ceil(tabs.length / cols)}">${tabs.map((tab) => {
    const url = browserGridUrls[slug]?.[tab.id];
    return `<div class="browser-tab-cell"><button type="button" class="browser-tab-tile" data-browser-focus-tab="${esc(slug)}" data-tab="${esc(tab.id)}" title="Show only this tab">${url
      ? `<img data-browser-grid-image="${esc(slug)}" data-tab="${esc(tab.id)}" src="${url}" alt="${esc(tab.title || 'Browser tab')}">`
      : `<span class="browser-tile-empty">${esc(browserGridErrors[slug]?.[tab.id] || 'Capturing…')}</span>`}<span class="browser-tile-label">${esc(browserTabLabel(tab))}</span></button>${browserTabCloseButton(slug, tab)}</div>`;
  }).join('')}</div>`;
}

// The expanded view hides every browser control in grid mode.
function syncViewerMode() {
  const viewer = document.getElementById('browser-viewer');
  const slug = viewer.dataset.project;
  if (!slug) return;
  const grid = gridMode(slug);
  viewer.classList.toggle('grid-mode', grid);
  viewer.querySelector('#browser-viewer-grid').innerHTML = grid ? browserGridMarkup(slug) : '';
  for (const button of viewer.querySelectorAll('.browser-viewer-head [data-browser-view]')) button.setAttribute('aria-pressed', String(button.dataset.browserView === (grid ? 'grid' : 'tab')));
  if (grid) {
    viewer.querySelector('#browser-viewer-control').checked = false;
    for (const control of viewer.querySelectorAll('.browser-viewer-controls input, .browser-viewer-controls button')) control.disabled = true;
    browserRefreshStopped(slug);
  } else viewer.dataset.tab = browserSelectedTab[slug] || '';
}

function setBrowserView(slug, mode) {
  browserViewModes[slug] = mode;
  try { localStorage.setItem(BROWSER_VIEW_KEY, JSON.stringify(browserViewModes)); } catch {}
  lastRender = ''; render();
  const viewer = document.getElementById('browser-viewer');
  if (viewer.open && viewer.dataset.project === slug) syncViewerMode();
  refreshBrowserPreview(slug, true);
}

// A browser whose process matches its port and profile but does not answer CDP is "not responding".
function browserState(b) {
  if (b.profileVerified) return b.responsive ? 'ready' : 'not responding';
  return b.reachable ? 'port conflict' : 'offline';
}

// A small bookmark list and a start-page field for each project card.
function browserBookmarkSection(slug, b) {
  const list = Array.isArray(b?.bookmarks) ? b.bookmarks : [];
  const editing = browserBookmarkDraft?.slug === slug ? browserBookmarkDraft.index : null;
  const rows = list.map((bookmark, index) => {
    if (index === editing) {
      return `<li class="browser-bookmark-row"><form class="browser-bookmark-rename" data-browser-bookmark-rename="${esc(slug)}" data-index="${index}"><input type="text" name="name" maxlength="60" value="${esc(browserBookmarkDraft.name ?? '')}" aria-label="Bookmark name" required><button type="submit">Save</button><button type="button" data-browser-bookmark-cancel="${esc(slug)}">Cancel</button></form></li>`;
    }
    return `<li class="browser-bookmark-row"><span class="browser-bookmark-name" title="${esc(bookmark.url)}">${esc(bookmark.name)}</span><span class="browser-bookmark-actions"><button type="button" data-browser-bookmark-open="${esc(slug)}" data-index="${index}" title="Open in the current tab">Open</button><button type="button" data-browser-bookmark-open-tab="${esc(slug)}" data-index="${index}" title="Open in a new tab">New tab</button><button type="button" data-browser-bookmark-rename="${esc(slug)}" data-index="${index}">Rename</button><button type="button" data-browser-bookmark-up="${esc(slug)}" data-index="${index}" ${index === 0 ? 'disabled' : ''} aria-label="Move ${esc(bookmark.name)} up">↑</button><button type="button" data-browser-bookmark-down="${esc(slug)}" data-index="${index}" ${index === list.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(bookmark.name)} down">↓</button><button type="button" data-browser-bookmark-remove="${esc(slug)}" data-index="${index}" class="danger" aria-label="Delete ${esc(bookmark.name)}">Delete</button></span></li>`;
  }).join('');
  return `<div class="browser-bookmarks" data-browser-bookmarks="${esc(slug)}"><h4>Bookmarks</h4>${list.length ? `<ol class="browser-bookmark-list">${rows}</ol>` : '<p class="browser-bookmark-empty">No bookmarks.</p>'}<div class="browser-bookmark-tools"><button type="button" data-browser-bookmark-add="${esc(slug)}">Add current page</button></div><form class="browser-start-page" data-browser-start-page="${esc(slug)}"><label>Start page <input type="text" name="url" value="${esc(b?.startPage ?? '')}" placeholder="https://… (blank clears)" aria-label="${esc(slug)} start page" autocomplete="off" spellcheck="false"></label><button type="submit">Save</button></form></div>`;
}

function browserResources(s) {
  const projects = Object.values(s.control?.projects || {});
  const sessions = browserSessions;
  const cards = (group) => group.map((p) => {
    const b = sessions.find((x) => x.project === p.slug);
    const tabs = browserTabs[p.slug] || [];
    const size = b?.windowSize || { width: 1280, height: 800 };
    const preview = browserPreviewOpen.has(p.slug) && !!b?.responsive;
    const lease = (s.resourceLeases?.leases || []).find((candidate) => candidate.pool === 'project-browsers' && candidate.project === p.slug);
    const leaseLine = lease ? `<p class="browser-lease"><span class="mono">Leased port :${esc(lease.item)}</span> · CDP <span class="mono">http://127.0.0.1:${esc(lease.item)}</span> · <a href="/allocation#lease-project-browsers-${esc(lease.item)}">View lease</a></p>` : '';
    return `<article class="panel browser-card ${b?.profileVerified ? 'browser-card-active' : 'browser-card-idle'}"><div class="browser-card-head"><div><h3>${esc(p.label)}</h3><p>${b ? `<span class="mono">:${b.port}</span> · ${browserState(b)} · ${b.headless ? 'headless' : 'visible'}` : 'No browser running'}</p></div>${b?.profileVerified ? `<div class="browser-head-actions">${b.responsive ? `<button type="button" class="browser-preview-toggle" data-browser-preview="${esc(p.slug)}">${preview ? 'Hide preview' : 'Show preview'}</button>` : ''}<details class="browser-manage" data-browser-manage="${esc(p.slug)}" ${browserManageOpen.has(p.slug) ? 'open' : ''}><summary>Manage</summary><div class="browser-manage-content"><div class="browser-actions"><button type="button" data-browser-restart="${esc(p.slug)}" data-browser-mode="${b.headless ? 'visible' : 'headless'}">Restart ${b.headless ? 'visible' : 'headless'}</button>${b.responsive ? `<label class="browser-restore"><input type="checkbox" data-browser-restore="${esc(p.slug)}" checked> Reopen current page</label>` : ''}<button type="button" data-browser-close="${esc(p.slug)}">Close browser</button></div><form class="browser-size" data-browser-size="${esc(p.slug)}"><label>Next launch size <input type="number" name="width" min="320" max="3840" value="${size.width}" aria-label="${esc(p.label)} window width"> × <input type="number" name="height" min="240" max="2160" value="${size.height}" aria-label="${esc(p.label)} window height"> px</label><button type="submit">Save size</button></form><details class="browser-record"><summary>Connection and profile</summary><small class="mono">http://127.0.0.1:${b.port}<br>${esc(b.profile)}</small></details></div></details></div>` : '<span class="tag">Available</span>'}</div>
      ${leaseLine}
      ${!b?.profileVerified ? `<div class="browser-actions"><button type="button" data-browser-request="${esc(p.slug)}" data-browser-mode="visible">Open visible</button><button type="button" data-browser-request="${esc(p.slug)}" data-browser-mode="headless">Open headless</button></div>` : ''}
      ${b?.profileVerified && !b.responsive ? '<small class="inline-feedback" role="status">Chrome does not answer on its debugging port. Restart or close it from Manage.</small>' : ''}
      ${browserMessages[p.slug] ? `<small class="inline-feedback" role="status">${esc(browserMessages[p.slug])}</small>` : ''}
      ${browserBookmarkSection(p.slug, b)}
      ${preview ? `<div class="browser-preview"><div class="browser-preview-tools">${browserViewToggle(p.slug)}<span class="browser-grid-count">${tabs.length} tab${tabs.length === 1 ? '' : 's'}</span><button type="button" data-browser-refresh="${esc(p.slug)}">Refresh</button>${gridMode(p.slug) ? `<button type="button" data-browser-expand="${esc(p.slug)}">Expand</button>` : `<button type="button" data-browser-new-tab="${esc(p.slug)}" title="Open a blank tab of your own. Agent tabs stay unchanged.">New tab</button>`}<label class="browser-live-toggle"><input type="checkbox" data-browser-live="${esc(p.slug)}" ${browserPreviewLive.has(p.slug) ? 'checked' : ''}> Live</label><label class="browser-live-rate">Every <select data-browser-interval="${esc(p.slug)}" aria-label="${esc(p.label)} live refresh interval">${PREVIEW_INTERVALS.map((ms) => `<option value="${ms}" ${ms === previewInterval(p.slug) ? 'selected' : ''}>${ms / 1000}s</option>`).join('')}</select></label></div>
        ${gridMode(p.slug) ? browserGridMarkup(p.slug) : `${browserTabList(p.slug)}<form class="browser-navigate" data-browser-navigate="${esc(p.slug)}"><button type="button" data-browser-history="back" data-browser-project="${esc(p.slug)}" ${browserNavigation[p.slug]?.canGoBack ? '' : 'disabled'}>Back</button><button type="button" data-browser-history="forward" data-browser-project="${esc(p.slug)}" ${browserNavigation[p.slug]?.canGoForward ? '' : 'disabled'}>Forward</button><button type="button" data-browser-history="home" data-browser-project="${esc(p.slug)}" ${tabs.length ? '' : 'disabled'}>Home</button><input type="text" name="url" value="${esc(browserAddressDraft[p.slug] ?? browserNavigation[p.slug]?.url ?? tabs.find((tab) => tab.id === browserSelectedTab[p.slug])?.url ?? '')}" placeholder="Enter a web address" aria-label="${esc(p.label)} browser address" autocomplete="off" spellcheck="false" required><button type="submit" ${tabs.length ? '' : 'disabled'}>Go</button></form>
        ${browserPreviewUrls[p.slug] ? `<button type="button" class="browser-image-button" data-browser-expand="${esc(p.slug)}" aria-label="Expand ${esc(p.label)} browser screenshot"><img data-browser-image="${esc(p.slug)}" src="${browserPreviewUrls[p.slug]}" alt="Current browser page in ${esc(p.label)}"></button>` : '<div class="browser-preview-empty">No screenshot yet</div>'}`}
        <small class="inline-feedback" data-browser-preview-message="${esc(p.slug)}" role="status">${esc(browserPreviewMessages[p.slug] || '')}</small></div>` : ''}
    </article>`;
  }).join('');
  const active = projects.filter((p) => sessions.find((b) => b.project === p.slug)?.profileVerified);
  const inactive = projects.filter((p) => !sessions.find((b) => b.project === p.slug)?.profileVerified);
  return `<section class="browser-fleet"><div class="section-head"><h2>Running browsers</h2><span>${active.length} active</span></div>${active.length ? `<div class="browser-grid">${cards(active)}</div>` : '<p class="empty">No project browsers are running.</p>'}</section><section class="browser-fleet"><div class="section-head"><h2>Other projects</h2><span>${inactive.length} available</span></div>${inactive.length ? `<div class="browser-idle-grid">${cards(inactive)}</div>` : '<p class="empty">Every open project has a browser.</p>'}</section>`;
}

// Refresh repeats only for the card-level Live setting or while Control browser is on in the large view.
function browserRefreshActive(slug) {
  const viewer = document.getElementById('browser-viewer');
  return browserPreviewLive.has(slug) || (viewer.open && viewer.dataset.project === slug && viewer.querySelector('#browser-viewer-control').checked);
}

// Stop the timer and relabel the last status when no refresh source remains.
function browserRefreshStopped(slug) {
  if (browserRefreshActive(slug)) return;
  delete browserNextRefresh[slug];
  const message = browserPreviewMessages[slug];
  if (message?.startsWith('Live · ')) previewMessage(slug, `Captured${message.slice(4)}`);
}

function previewMessage(slug, message) {
  browserPreviewMessages[slug] = message;
  const label = [...document.querySelectorAll('[data-browser-preview-message]')].find((el) => el.dataset.browserPreviewMessage === slug);
  if (label) label.textContent = message;
  const viewer = document.getElementById('browser-viewer');
  if (viewer.open && viewer.dataset.project === slug) viewer.querySelector('#browser-viewer-status').textContent = message;
}

async function refreshBrowserNavigation(slug) {
  const tab = browserSelectedTab[slug];
  if (!tab) return;
  const params = new URLSearchParams({ project: slug, tab });
  const response = await fetch(`/api/browser-sessions/navigation?${params}`, { cache: 'no-store' });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Could not read browser history.');
  if (browserSelectedTab[slug] !== tab) return;
  browserNavigation[slug] = value;
  const viewer = document.getElementById('browser-viewer');
  for (const form of [document.querySelector(`[data-browser-navigate="${slug}"]`), viewer.open && viewer.dataset.project === slug ? viewer.querySelector('#browser-viewer-navigate') : null]) {
    if (!form) continue;
    const input = form.elements.url;
    if (document.activeElement !== input && browserAddressDraft[slug] === undefined) input.value = value.url;
    form.querySelector('[data-browser-history="back"]').disabled = !value.canGoBack;
    form.querySelector('[data-browser-history="forward"]').disabled = !value.canGoForward;
  }
}

async function captureBrowserGrid(slug) {
  const tabs = browserTabs[slug] || [];
  const urls = browserGridUrls[slug] ||= {};
  const errors = browserGridErrors[slug] = {};
  let rebuild = false;
  await Promise.all(tabs.map(async (tab) => {
    try {
      const params = new URLSearchParams({ project: slug, tab: tab.id });
      const response = await fetch(`/api/browser-sessions/screenshot?${params}`, { cache: 'no-store' });
      if (!response.ok) { const result = await response.json(); throw new Error(result.error || 'Screenshot failed.'); }
      const next = URL.createObjectURL(await response.blob());
      const previous = urls[tab.id];
      urls[tab.id] = next;
      const images = [...document.querySelectorAll('[data-browser-grid-image]')].filter((el) => el.dataset.browserGridImage === slug && el.dataset.tab === tab.id);
      if (!images.length) rebuild = true;
      for (const image of images) image.src = next;
      if (previous) URL.revokeObjectURL(previous);
    } catch (error) { errors[tab.id] = error.message; rebuild = true; }
  }));
  for (const id of Object.keys(urls)) if (!tabs.some((tab) => tab.id === id)) { URL.revokeObjectURL(urls[id]); delete urls[id]; rebuild = true; }
  const viewer = document.getElementById('browser-viewer');
  const viewerActive = viewer.open && viewer.dataset.project === slug;
  if (rebuild) { lastRender = ''; render(); if (viewerActive) syncViewerMode(); }
  browserPreviewFrames[slug] = (browserPreviewFrames[slug] || 0) + 1;
  const failed = Object.keys(errors).length;
  previewMessage(slug, `${browserRefreshActive(slug) ? 'Live' : 'Captured'} · all ${tabs.length} tabs · frame ${browserPreviewFrames[slug]} · ${new Date().toLocaleTimeString()}${failed ? ` · ${failed} failed` : ''}`);
}

async function refreshBrowserPreview(slug, reloadTabs = false) {
  if (!browserPreviewOpen.has(slug) || browserPreviewPending.has(slug)) return;
  if (browserSessions.find((b) => b.project === slug)?.responsive === false) return;
  browserPreviewPending.add(slug);
  try {
    // Agents open and close tabs, so reload the list on request and at least every 10 s.
    if (reloadTabs || !browserTabs[slug] || Date.now() - (browserTabsAt[slug] || 0) > 10000) {
      const response = await fetch(`/api/browser-sessions/tabs?project=${encodeURIComponent(slug)}`);
      const tabs = await response.json();
      if (!response.ok) throw new Error(tabs.error || 'Could not list browser pages.');
      const changed = JSON.stringify(tabs) !== JSON.stringify(browserTabs[slug]);
      browserTabs[slug] = tabs;
      browserTabsAt[slug] = Date.now();
      if (!tabs.some((tab) => tab.id === browserSelectedTab[slug])) { browserSelectedTab[slug] = tabs[0]?.id; delete browserNavigation[slug]; }
      if (changed) {
        lastRender = ''; render();
        const viewer = document.getElementById('browser-viewer');
        if (viewer.open && viewer.dataset.project === slug && gridMode(slug)) syncViewerMode();
      }
    }
    if (gridMode(slug)) { await captureBrowserGrid(slug); return; }
    if (!browserSelectedTab[slug]) throw new Error('No inspectable page is open in this browser.');
    const params = new URLSearchParams({ project: slug, tab: browserSelectedTab[slug] });
    const response = await fetch(`/api/browser-sessions/screenshot?${params}`, { cache: 'no-store' });
    if (!response.ok) { const result = await response.json(); throw new Error(result.error || 'Screenshot failed.'); }
    const next = URL.createObjectURL(await response.blob());
    const previous = browserPreviewUrls[slug];
    browserPreviewUrls[slug] = next;
    const image = [...document.querySelectorAll('[data-browser-image]')].find((el) => el.dataset.browserImage === slug);
    if (image) image.src = next;
    else { lastRender = ''; render(); }
    const viewer = document.getElementById('browser-viewer');
    if (viewer.open && viewer.dataset.project === slug) viewer.querySelector(':scope > img').src = next;
    if (previous) URL.revokeObjectURL(previous);
    browserPreviewFrames[slug] = (browserPreviewFrames[slug] || 0) + 1;
    const agentTab = browserTabs[slug]?.find((tab) => tab.id === browserSelectedTab[slug])?.attached;
    previewMessage(slug, `${browserRefreshActive(slug) ? 'Live' : 'Captured'} · frame ${browserPreviewFrames[slug]} · ${new Date().toLocaleTimeString()}${agentTab ? ' · an agent is using this tab' : ''}`);
    try { await refreshBrowserNavigation(slug); } catch (error) { previewMessage(slug, error.message); }
  } catch (error) { previewMessage(slug, error.message); }
  finally { browserPreviewPending.delete(slug); }
}

// ---------- Overview ----------

function rulesBlock(s) {
  const rows = [];
  for (const a of s.alerts || []) if (a.severity !== 'info') rows.push(`<div class="rule ${a.severity}"><span class="sev">${a.severity}</span><div>${code(a.text)}</div></div>`);
  for (const a of s.advice || []) rows.push(`<div class="rule advice"><span class="sev">advice</span><div>${code(a)}</div></div>`);
  for (const a of s.alerts || []) if (a.severity === 'info') rows.push(`<div class="rule"><span class="sev">notice</span><div>${code(a.text)} <span class="tag">${esc(a.scope)}</span></div></div>`);
  if (!rows.length) rows.push(`<div class="rule ok"><span class="sev">ok</span><div>No restrictions. All quotas and machine resources are within limits.</div></div>`);
  return `<section id="guidance"><h2>Current guidance <span class="sub">also published to orchestrators in <a href="/bulletin.md">bulletin.md</a></span></h2><div class="rules">${rows.join('')}</div></section>`;
}

function quotaCard(q, s = state) {
  const name = PROVIDERS[q.provider] || q.provider;
  if (!hasQuotaData(q)) return `<div class="panel provider"><div class="provider-head"><b>${esc(name)}</b></div><div class="err">${esc(q.error)}</div></div>`;
  const lane = state?.lanes?.[q.provider];
  const thresholds = quotaThresholds(s);
  const wins = q.windows.map((w) => {
    const windowGoalText = lane?.goals?.find((goal) => goal.key === w.key)?.text || '';
    const goalLabel = windowGoalText ? ` <span class="muted">· ${esc(windowGoalText)}</span>` : '';
    if (w.resetsAt && Date.parse(w.resetsAt) <= Date.now()) return `<div class="win"><div class="win-row"><span>${esc(w.label)}${goalLabel}</span><span class="muted">Reset, not yet measured</span></div><div class="bar"></div><div class="win-row win-foot"><span>The next quota reading shows the new use.</span><span>reset ${clock(w.resetsAt)}</span></div></div>`;
    const cls = w.usedPercent >= thresholds.criticalPercent ? 'crit' : w.usedPercent >= thresholds.warnPercent ? 'warn' : w.willLast === false ? 'warn' : '';
    const tick = w.expectedPercent != null ? `<s style="left:calc(${Math.min(100, w.expectedPercent)}% - 1px)" title="Expected at even pace: ${w.expectedPercent}%"></s>` : '';
    const foot = w.paceSummary ? esc(w.paceSummary) : w.extra ? 'Extra window' : '';
    return `<div class="win">
      <div class="win-row"><span>${esc(w.label)}${goalLabel}</span><span><span class="pct">${w.usedPercent}%</span></span></div>
      <div class="bar"><i class="${cls}" style="width:${Math.min(100, w.usedPercent)}%"></i>${tick}</div>
      <div class="win-row win-foot"><span>${foot}</span><span>resets ${clock(w.resetsAt)} · in ${until(w.resetsAt)}</span></div>
    </div>`;
  }).join('');
  const extras = [];
  if (q.credits?.remaining != null) extras.push(`${q.credits.remaining} credits`);
  if (q.resetCredits) extras.push(`${q.resetCredits} reset credit${q.resetCredits > 1 ? 's' : ''}`);
  const trickleGoalText = lane?.goals?.find((goal) => goal.key === lane.windowKey)?.text || '';
  const trickle = lane?.state === 'trickle'
    ? `<div class="win-foot">Trickle allowance: about ${lane.allowancePercent.toFixed(1)}%/day · ${(lane.usedTodayPercent || 0).toFixed(1)}% used today${trickleGoalText ? ` · ${esc(trickleGoalText)}` : ''}</div>` : '';
  const trend = usage?.quotaTrend?.[q.provider] || [];
  return `<div class="panel provider"><div class="provider-head"><b>${esc(name)}</b><span class="tag">${esc(extras.join(' · ') || q.plan || '')}</span></div>${q.stale ? `<div class="err" title="${esc(q.error)}">${esc(staleQuotaText(q))}</div>` : ''}${wins}${trickle}${trend.length > 1 ? `<div class="win-foot">Weekly use trend · last ${Math.min(24, Math.round(trend.length / 12))}h${spark(trend.map((x) => x.usedPercent), 100)}</div>` : ''}</div>`;
}

function spark(values, max) {
  if (values.length < 2) return '';
  const w = 200, h = 34;
  const top = Math.max(max, ...values) || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - (v / top) * (h - 2) - 1}`);
  const ref = h - (max / top) * (h - 2) - 1;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><line x1="0" x2="${w}" y1="${ref}" y2="${ref}"/><path d="M${pts.join('L')}"/></svg>`;
}

function machineCard(s) {
  const m = s.machine;
  if (!m) return `<div class="err">No machine data.</div>`;
  const hist = s.history || [];
  const limits = m.limits || {};
  const guardMode = machineGuardMode(s.policy?.machine || limits);
  return `<div class="stats">
      <div class="stat"><div class="k">Machine guard</div><div class="v">${esc(guardMode)}<small>${guardMode === 'paused' ? esc(machineGuardUntilText(limits.guardPausedUntil || s.policy?.machine?.guardPausedUntil)) : `Owner ${esc(limits.owner || 'unknown')}`}</small></div></div>
      <div class="stat"><div class="k">CPU / ${guardMode === 'active' ? 'limit' : 'configured limit'}</div><div class="v">${Number.isFinite(limits.cpuPercent) ? limits.cpuPercent.toFixed(1) : '–'}%<small>${limits.cpuLimit == null ? 'disabled' : `${limits.cpuLimit}%`}</small></div></div>
      <div class="stat"><div class="k">Load (1 / 5 / 15 min)</div><div class="v">${m.load[0]} <small>${m.load[1]} / ${m.load[2]} · ${m.cpus} cores; ${guardMode === 'active' ? 'backstop' : 'configured backstop'} ${limits.loadLimit ?? 'disabled'}</small></div>${spark(hist.map((x) => x.load), m.cpus)}</div>
      <div class="stat"><div class="k">Memory free</div><div class="v">${m.memFreePercent ?? '–'}<small>% of ${m.memTotalGB} GB</small></div>${spark(hist.map((x) => 100 - (x.mem ?? 0)), 100 - 15)}</div>
      <div class="stat"><div class="k">Disk free</div><div class="v">${m.diskFreeBytes != null ? (m.diskFreeBytes / 2 ** 30).toFixed(1) : '–'}<small> GB · ${Number.isFinite(m.diskFreePercent) ? m.diskFreePercent.toFixed(1) : '–'}%</small></div></div>
      <div class="stat"><div class="k">Swap used</div><div class="v">${m.swapUsedMB != null ? (m.swapUsedMB / 1024).toFixed(1) : '–'}<small> GB</small></div></div>
    </div>`;
}

function agentRow(p, s) {
  const since = s.paneSince?.[p.id]?.since;
  const idleSec = since && (p.status === 'idle' || p.status === 'done') ? (Date.now() - since) / 1000 : null;
  const stale = idleSec != null && idleSec > 7200 && !p.orch && p.label !== 'boss';
  const browsers = (s.browsers || []).filter((b) => b.pane === p.id);
  const bTag = browsers.length ? ` <span class="tag" title="${esc(browsers.map((b) => `${b.kind} pid ${b.pid}`).join('\n'))}">${browsers.length} browser${browsers.length > 1 ? 's' : ''}</span>` : '';
  const who = p.name || p.agent || 'shell';
  const kind = p.name && p.agent ? p.agent : '';
  const status = p.agent ? p.status : 'shell';
  const meta = p.agent ? `${status}${since ? ` ${dur((Date.now() - since) / 1000)}` : ''}` : 'shell';
  const isOrchestrator = p.orch || p.label === 'boss';
  return `<li class="agent ${isOrchestrator ? 'orch' : ''}" title="${esc(p.cwd)}">
    <span class="st ${status}"></span>
    <div class="who">${isOrchestrator ? `<span class="pill">${p.label === 'boss' ? 'boss' : 'orch'}</span>` : ''}<b>${esc(who)}</b>${kind ? `<span class="pill ghost">${esc(kind)}</span>` : ''}<span>${esc(p.title)}</span>${bTag}</div>
    <span class="meta ${stale ? 'stale' : ''}">${esc(p.id.split(':')[1])} · ${esc(meta)}</span>
  </li>`;
}

function workspacesBlock(s, slug) {
  const h = s.herdr;
  if (!h) return '';
  const cards = h.workspaces.map((w) => {
    const panes = h.panes.filter((p) => p.workspace === w.id && (p.agent || p.orch));
    panes.sort((a, b) => (b.orch - a.orch) || String(a.tab).localeCompare(String(b.tab)));
    const hasOrch = panes.some((p) => p.orch || p.label === 'boss');
    const excluded = (s.policy?.excludedWorkspaces || []).some((entry) => entry === w.label || entry === w.id) || panes.some((p) => p.label === 'boss');
    const working = panes.filter((p) => p.status === 'working' && p.label !== 'boss').length;
    return `<div class="panel">
      <div class="ws-head"><b>${esc(w.label)}</b><span class="tag">${excluded ? 'Not a project · ' : ''}${esc(w.id)} · ${panes.length} agent${panes.length === 1 ? '' : 's'}${working ? ` · ${working} working` : ''}</span></div>
      <ul class="agents">${panes.map((p) => agentRow(p, s)).join('') || '<li class="empty">No agents.</li>'}</ul>
      ${hasOrch ? '' : `<div class="noorch">No orchestrator. Label one with <code>herdr pane rename &lt;pane&gt; orch</code>.</div>`}
    </div>`;
  }).join('');
  return collapsible({ slug, key: 'workspaces', head: '<h2>Workspaces <span class="sub">live from Herdr</span></h2>', title: 'Workspaces', count: `${h.workspaces.length}`, body: `<div class="ws-grid">${cards}</div>` });
}

function agentProfile(p, s) {
  const since = s.paneSince?.[p.id]?.since;
  const elapsed = since ? dur((Date.now() - since) / 1000) : null;
  const staleWorker = !p.orch && p.label !== 'boss' && ['idle', 'done'].includes(p.status) && since && Date.now() - since > 7200000;
  const processes = (s.browsers || []).filter((b) => b.pane === p.id);
  const name = p.name || p.agent || 'Agent';
  const task = p.title || 'No current title';
  const isOrchestrator = p.orch || p.label === 'boss';
  return `<div class="agent-profile">
    <div class="agent-profile-main"><span class="st ${esc(p.status || 'unknown')}" aria-hidden="true"></span><strong>${esc(name)}</strong>${isOrchestrator ? `<span class="pill">${p.label === 'boss' ? 'boss' : 'orch'}</span>` : ''}${p.name && p.agent ? `<span class="agent-kind">${esc(p.agent)}</span>` : ''}<span class="agent-state ${staleWorker ? 'stale' : ''}">${esc(p.status || 'unknown')}${elapsed ? ` · ${elapsed}` : ''}</span></div>
    <p class="agent-profile-task">${esc(task)}</p>
    <div class="agent-profile-meta"><span>Pane <code>${esc(p.id)}</code></span><span>Tab <code>${esc(p.tab || '–')}</code></span>${processes.length ? `<span title="${esc(processes.map((x) => `${x.kind} PID ${x.pid}`).join('\n'))}">${processes.length} tracked process${processes.length === 1 ? '' : 'es'}</span>` : ''}${staleWorker ? '<span class="stale">Idle over 2h</span>' : ''}</div>
  </div>`;
}

function agentInventory(s) {
  const h = s.herdr;
  if (!h) return '<div class="calm-state">Herdr workspace data is unavailable.</div>';
  const agents = h.panes.filter((p) => p.agent);
  const workers = agents.filter((p) => !p.orch && p.label !== 'boss');
  const summary = `<div class="agents-totals"><span><strong>${h.workspaces.length}</strong> workspaces</span><span><strong>${agents.length - workers.length}</strong> orchestrators</span><span><strong>${workers.length}</strong> workers</span><span><strong>${agents.filter((p) => p.status === 'working' && p.label !== 'boss').length}</strong> working</span><span><strong>${agents.filter((p) => p.status === 'failed').length}</strong> failed</span></div>`;
  const rows = h.workspaces.map((w) => {
    const panes = agents.filter((p) => p.workspace === w.id);
    const orch = panes.find((p) => p.orch || p.label === 'boss');
    const project = Object.values(s.control?.projects || {}).find((p) => p.workspace === w.id);
    const slug = project?.slug;
    const excluded = panes.some((p) => p.label === 'boss') || (s.policy?.excludedWorkspaces || []).some((entry) => entry === w.id || entry === w.label);
    const work = panes.filter((p) => !p.orch && p.label !== 'boss');
    const mode = !project && excluded ? 'Not a project' : project?.effectiveMode === 'paused' ? 'Paused' : project?.idle ? 'Idle' : 'Active';
    return `<section class="workspace-row"><header class="workspace-row-head"><div class="workspace-title"><h2>${slug ? `<a href="/projects/${esc(slug)}">${esc(w.label)}</a>` : esc(w.label)}</h2><span class="mono">${esc(w.id)}</span>${!project && excluded ? '<span class="tag">Not a project</span>' : ''}</div><div class="workspace-context"><span>${mode}</span><span>${work.length} worker${work.length === 1 ? '' : 's'}</span>${slug ? `<a href="/projects/${esc(slug)}">Project details →</a>` : ''}</div></header>
      <div class="workspace-row-body"><div class="workspace-role"><h3>Orchestrator</h3>${orch ? agentProfile(orch, s) : '<div class="missing-orch">No labeled orchestrator. Label its Herdr pane <code>orch</code> to supervise this project.</div>'}</div>
      <div class="workspace-role workspace-workers"><h3>Workers <span>${work.length}</span></h3>${work.length ? `<ul>${work.map((p) => `<li>${agentProfile(p, s)}</li>`).join('')}</ul>` : '<p class="workspace-empty">No worker agents in this workspace.</p>'}</div></div></section>`;
  }).join('');
  return `${summary}<div class="workspace-list">${rows || '<div class="calm-state">No Herdr workspaces are open.</div>'}</div>`;
}

function taskCounts(p) {
  const c = Object.fromEntries(STATUSES.map((k) => [k, 0]));
  for (const t of p.tasks || []) c[t.status || 'todo']++;
  return c;
}
function segBar(c) {
  const total = STATUSES.reduce((n, k) => n + c[k], 0);
  if (!total) return '';
  return `<div class="seg">${STATUSES.filter((k) => c[k]).map((k) => `<i class="c-${k}" style="flex:${c[k]}" title="${STATUS_LABEL[k]}: ${c[k]}"></i>`).join('')}</div>
    <div class="legend">${STATUSES.filter((k) => c[k]).map((k) => `<span style="--c:var(--${k === 'todo' ? 'faint' : k === 'doing' ? 'info' : k === 'review' ? 'accent' : k === 'blocked' ? 'crit' : 'ok'})">${STATUS_LABEL[k]} ${c[k]}</span>`).join('')}</div>`;
}

function projectSlugs(s) {
  const open = Object.keys(s.control?.projects || {});
  return s.control ? open : (s.projects || []).map((p) => p.slug);
}

function defaultProject(s) {
  const live = s.control?.projects || {};
  const published = new Set((s.projects || []).map((p) => p.slug));
  return projectSlugs(s).sort((a, b) => {
    const rank = (slug) => {
      const p = live[slug];
      return [p && p.effectiveMode !== 'paused' && !p.idle ? 1 : 0, p?.running || 0, p?.slots || 0, published.has(slug) ? 1 : 0, p?.share || 0];
    };
    const x = rank(a), y = rank(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i];
    return a.localeCompare(b);
  })[0];
}

function projectSelector(s, selected) {
  const live = s.control?.projects || {};
  const published = new Map((s.projects || []).map((p) => [p.slug, p]));
  const slugs = [...new Set([...projectSlugs(s), selected].filter(Boolean))];
  if (!slugs.length) return '<div class="panel empty">No projects are open. Orchestrators can publish a status file to make project details available.</div>';
  return `<nav class="project-selector-grid" aria-label="Select project">${slugs.map((slug) => {
    const p = published.get(slug), l = live[slug];
    const mode = l?.effectiveMode === 'paused' ? 'Paused' : l?.idle ? 'Idle' : l ? 'Active' : 'Published';
    const name = p?.project || l?.label || slug;
    const color = allocationColor(s, slug);
    const decisions = (p?.tasks || []).filter((t) => !isDone(t) && t.waitingOn === 'owner').length;
    return `<a class="panel proj project-selector ${slug === selected ? 'selected' : ''} ${color ? `has-allocation ${allocationActivity(l)}` : ''}" href="/projects/${esc(slug)}" ${slug === selected ? 'aria-current="page"' : ''} ${color ? `style="--allocation-color:${color}"` : ''}>
      <div class="proj-head"><b>${esc(name)}</b><span class="tag">${esc(mode)}</span></div>
      <div class="project-selector-meta"><span>${esc(p?.status || p?.phase || 'No status published')}</span><span>${l ? `${l.running} / ${l.slots} workers` : 'No live allocation'}</span></div>
      ${p?.summary ? `<p>${esc(p.summary)}</p>` : ''}
      ${p ? segBar(taskCounts(p)) : ''}
      ${decisions ? `<span class="project-decision-count">Needs your decision ${decisions}</span>` : ''}
      ${p?.errors?.length ? `<span class="project-card-error">${p.errors.length} status issue${p.errors.length === 1 ? '' : 's'}</span>` : ''}
      <div class="win-foot">${p ? `updated ${ago(p.updated)}${staleStatusTag(s, p)}` : 'Awaiting project status'}</div>
    </a>`;
  }).join('')}</nav>`;
}

function browsersBlock(s) {
  const br = s.browsers || [];
  if (!br.length) return '';
  const pane = (id) => s.herdr?.panes.find((p) => p.id === id);
  return `<div class="table-scroll"><table class="browsers"><thead><tr><th>Process</th><th>PID</th><th>Owner</th><th>Age</th><th>MB</th></tr></thead><tbody>
    ${br.map((b) => { const p = pane(b.pane); return `<tr><td data-label="Process">${esc(b.kind)}${b.headless ? ' (headless)' : ''}${b.port ? ` :${b.port}` : ''}</td><td class="mono" data-label="PID">${b.pid}</td><td data-label="Owner">${p ? esc(p.name || p.id) : b.shared ? `<span title="${esc(b.shared)}">shared</span>` : b.orphan ? '<span class="stale">orphan</span>' : '–'}</td><td class="mono" data-label="Age">${dur(b.age)}</td><td class="mono" data-label="MB">${b.rssMB}</td></tr>`; }).join('')}
  </tbody></table></div>`;
}

function eventsBlock(s) {
  const ev = (s.events || []).slice().reverse();
  return `<div class="panel">${ev.length ? `<ul class="events">${ev.map((e) => `<li><span class="t">${new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</span><span class="ty ${esc(e.type)}">${esc(e.type)}</span><span>${esc(e.text)}</span></li>`).join('')}</ul>` : '<div class="empty">No activity yet.</div>'}</div>`;
}

function quotaSummary(s) {
  const thresholds = quotaThresholds(s);
  const strip = (s.quotas || []).map((q) => {
    const w = q.windows?.find((x) => x.key === 'secondary') || q.windows?.find((x) => !x.extra);
    return `<span class="quota-summary-item"><span>${esc(PROVIDERS[q.provider] || q.provider)}</span><strong class="${w?.usedPercent >= thresholds.warnPercent ? 'text-crit' : ''}">${w ? `${w.usedPercent}%` : '–'}</strong><small>${q.stale ? esc(staleQuotaText(q)) : q.error ? esc(q.error) : w ? `${esc(w.label)} · resets ${clock(w.resetsAt)}` : 'No quota data'}</small></span>`;
  }).join('');
  // Saved quotas from before a restart show their read time until the first new read succeeds.
  const cached = s.quotasCached && s.quotasAt && Date.now() - Date.parse(s.quotasAt) < 15 * 60 * 1000;
  return `<section class="quota-summary"><div class="section-head"><h2>Subscriptions</h2><span>${cached ? `Quotas from ${clock(s.quotasAt)}` : `Updated ${ago(s.quotasAt)}`}</span></div><details data-quota-detail ${quotaExpanded ? 'open' : ''}><summary><span class="quota-summary-grid">${strip}</span><span class="fold-hint">Details</span></summary><div class="quota-foldout">${(s.quotas || []).map((q) => quotaCard(q, s)).join('')}</div></details></section>`;
}

function machineSummary(s) {
  const m = s.machine;
  const browsers = s.browsers || [];
  const automation = browsers.filter((b) => b.kind === 'automation-chrome').length;
  const daemons = browsers.filter((b) => b.kind === 'agent-browser-daemon').length;
  const limits = m?.limits || {};
  const machinePolicy = s.policy?.machine || limits;
  const guardMode = machineGuardMode(machinePolicy);
  const threshold = guardMode === 'active' ? 'limit' : 'configured limit';
  const guardControls = `<div class="machine-guard-controls"><label class="setting-line"><span>Machine guard · ${guardMode}${guardMode === 'paused' ? esc(machineGuardUntilText(machinePolicy.guardPausedUntil)) : ''}</span><input type="checkbox" role="switch" aria-label="Machine guard enabled" data-overview-guard-toggle ${machinePolicy.guardEnabled !== false ? 'checked' : ''} ${machineGuardBusy ? 'disabled' : ''}></label><div class="action-row"><label class="setting-line"><span>Pause for</span><select aria-label="Machine guard pause duration" data-overview-pause-hours ${machineGuardBusy ? 'disabled' : ''}>${[1, 2, 4, 8, 12, 24].map((hours) => `<option value="${hours}">${hours} hour${hours === 1 ? '' : 's'}</option>`).join('')}</select></label><button type="button" data-overview-guard-action="pause" ${machineGuardBusy ? 'disabled' : ''}>Pause guard</button>${guardMode === 'active' ? '' : `<button type="button" data-overview-guard-action="resume" ${machineGuardBusy ? 'disabled' : ''}>Resume guard</button>`}</div><p class="setting-help" role="status" aria-live="polite">${esc(machineGuardMessage || (guardMode === 'paused' ? `The guard resumes ${machineGuardUntilText(machinePolicy.guardPausedUntil).slice(7)}.` : guardMode === 'off' ? 'CPU and load limits do not block worker starts while the guard is off.' : 'CPU and load limits block worker starts while the guard is active.'))}</p></div>`;
  const cpu = Number.isFinite(limits.cpuPercent) ? `${limits.cpuPercent.toFixed(1)}%` : '–';
  const body = m ? `<span>Guard <b>${esc(guardMode)}${guardMode === 'paused' ? esc(machineGuardUntilText(machinePolicy.guardPausedUntil)) : ''}</b></span><span>Owner <b>${esc(limits.owner || 'unknown')}</b></span><span>CPU <b class="mono">${cpu}</b> / ${threshold} ${limits.cpuLimit == null ? 'disabled' : `${limits.cpuLimit}%`}</span><span>5-minute load <b class="mono">${esc(m.load?.[1] ?? '–')}</b> / ${guardMode === 'active' ? 'backstop' : 'configured backstop'} ${limits.loadLimit ?? 'disabled'}</span><span>Free memory <b class="mono">${esc(m.memFreePercent ?? '–')}%</b></span><span>Free disk <b class="mono">${m.diskFreeBytes != null ? (m.diskFreeBytes / 2 ** 30).toFixed(1) : '–'} GB · ${Number.isFinite(m.diskFreePercent) ? m.diskFreePercent.toFixed(1) : '–'}%</b></span><span>Browsers <b class="mono">${automation}</b> · daemons <b class="mono">${daemons}</b></span>` : '<span>Machine data unavailable</span>';
  return `<section class="machine-summary"><div class="section-head"><h2>Machine health</h2><span>Automation processes: Chrome, browser MCP, and agent-browser daemons</span></div>${guardControls}<details data-machine-detail ${machineExpanded ? 'open' : ''}><summary>${body}<span class="fold-hint">Details</span></summary><div class="machine-foldout"><div>${machineCard(s)}</div><div>${browsersBlock(s) || '<div class="empty">No tracked automation processes.</div>'}</div></div></details></section>`;
}

function attentionBlock(s) {
  const alerts = (s.alerts || []).filter((a) => ['warn', 'critical'].includes(a.severity) && !a.key?.startsWith('handoff:'));
  if (s.errors?.length) alerts.unshift({ key: 'collection', severity: 'warn', title: 'Some status data is unavailable', text: s.errors.join(' · ') });
  return `<section class="attention-section"><div class="section-head"><h2>Needs attention</h2><span>${alerts.length ? `${alerts.length} alerts` : 'Clear'}</span></div>${alerts.length ? `<div class="attention-list">${alerts.map((a) => `<article class="attention-item ${esc(a.severity)}"><span class="severity-dot" aria-hidden="true"></span><div><b>${esc(a.title || a.severity)}</b><p>${esc(a.text)}</p></div><a href="${a.key?.startsWith('quota:') ? '/allocation' : '/logs#guidance'}">${a.key?.startsWith('quota:') ? 'Adjust policy' : 'Details'}</a></article>`).join('')}</div>` : '<div class="calm-state">No resource alerts need action. Project orchestrators can continue within the current policy.</div>'}</section>`;
}

function fleetBlock(s) {
  const projects = Object.values(s.control?.projects || {});
  return `<section class="fleet-section"><div class="section-head"><h2>Projects</h2><a href="/agents">Live agents →</a></div>${allocationSummary(s)}${projectSelector(s, null)}<div class="fleet-table-wrap"><table class="fleet-table"><thead><tr><th>Project</th><th>Orchestrator</th><th>Workers</th><th>Policy</th><th>Published status</th></tr></thead><tbody>${projects.map((p) => {
    const published = (s.projects || []).find((x) => x.slug === p.slug);
    const detail = `/projects/${p.slug}`;
    return `<tr><td data-label="Project"><a href="${esc(detail)}"><strong>${esc(p.label)}</strong></a><small>${esc(p.workspace)}</small></td><td data-label="Orchestrator">${p.orch ? `<span class="status-inline"><span class="st ${esc(p.orch.status)}"></span>${esc(p.orch.kind)} · ${esc(p.orch.status)}</span>` : '<span class="text-crit">Missing</span>'}</td><td class="mono" data-label="Workers">${p.running} / ${p.slots}</td><td data-label="Policy">${esc(p.effectiveMode === 'paused' ? 'Paused' : p.idle ? 'Idle · lending' : `${Math.round(p.share)}% share`)}</td><td data-label="Published status">${published ? `${esc(published.status || published.phase || 'Published')}<small>updated ${ago(published.updated)}${staleStatusTag(s, published)}</small>` : '<span class="muted">Not published</span>'}</td></tr>`;
  }).join('')}</tbody></table></div></section>`;
}

// The total of open Owner waits across projects, with a link to each project group.
function decisionSummary(s) {
  const rows = (s.projects || []).map((p) => ({ slug: p.slug, label: p.project || p.slug, count: (p.tasks || []).filter((t) => !isDone(t) && t.waitingOn === 'owner').length })).filter((r) => r.count > 0);
  if (!rows.length) return '';
  const total = rows.reduce((n, r) => n + r.count, 0);
  return `<div class="panel decisions-summary"><strong>Needs your decision <span class="num">${total}</span></strong><span>${rows.map((r) => `<a href="/projects/${esc(r.slug)}#decisions">${esc(r.label)} ${r.count}</a>`).join(' · ')}</span></div>`;
}

function overview(s) {
  const handovers = openHandoffRecords(handoffRecords, s.herdr?.panes).length;
  const alertCount = (s.alerts || []).filter((a) => ['warn', 'critical'].includes(a.severity) && !a.key?.startsWith('handoff:')).length;
  return [
    `<header class="page-intro"><div><h1>Overview</h1><p>${alertCount || handovers ? `${alertCount} resource alert${alertCount === 1 ? '' : 's'} · ${handovers} handover${handovers === 1 ? '' : 's'} to review` : 'Projects are operating within the current resource policy.'}</p></div><div class="capacity-readout"><strong>${s.control?.runningWorkers ?? 0}<span> / ${s.control?.maxWorkers ?? '–'}</span></strong><small>working agents</small><a href="/allocation">Adjust allocation →</a></div></header>`,
    `<div class="overview-action-grid">${attentionBlock(s)}${handoffBlock(s)}</div>`,
    decisionSummary(s),
    fleetBlock(s),
    quotaSummary(s),
    machineSummary(s),
  ].join('');
}

function allocationView(s) {
  return [
    '<header class="page-intro"><div><h1>Resource allocation</h1><p>Set worker capacity, project shares, exclusions, and orchestrator succession.</p></div></header>',
    controlBlock(s),
    machineLocksBlock(s),
    leasesBlock(s),
  ].join('');
}

function machineLocksBlock(s) {
  const locks = Array.isArray(s.locks) ? s.locks : [];
  const rows = locks.map((lock) => {
    const queue = Array.isArray(lock.queue) ? lock.queue : [];
    const queueRow = queue.length ? `<tr class="machine-lock-queue"><td colspan="6"><strong>Queue</strong><ol>${queue.map((ticket) => `<li>${esc(ticket.position)}. ${esc(ticket.project)} ${esc(ticket.pane)} (${esc(ticket.kind)}) ${esc(dur(ticket.waitSeconds))}</li>`).join('')}</ol></td></tr>` : '';
    return `<tr>
    <td class="mono" data-label="Lock">${esc(lock.name)}</td>
    <td data-label="Holder">${esc(lock.project || 'Unknown project')} · ${esc(lock.ownerPane || 'Unknown pane')}</td>
    <td data-label="Kind">${esc(lock.kind)}</td>
    <td data-label="Age">${esc(dur(lock.ageSeconds))}</td>
    <td data-label="Time left">${lock.kind === 'manual' ? `${esc(until(lock.expiresAt))} left` : 'until the command ends'}</td>
    <td data-label="State"><span class="tag machine-lock-state ${lock.state === 'live' ? 'is-live' : 'is-stale'}">${esc(lock.state)}</span></td>
  </tr>${queueRow}`;
  }).join('');
  const stats = s.lockStats;
  const ms = (value) => (value == null ? '–' : dur(value / 1000));
  const statsLine = stats && stats.acquires
    ? `<p class="machine-lock-help machine-lock-stats" data-lock-stats>Last ${esc(stats.windowDays)} days: median hold <strong>${esc(ms(stats.medianHoldMs))}</strong>, median wait <strong>${esc(ms(stats.medianWaitMs))}</strong>, ${esc(stats.acquires)} acquires.${Object.entries(stats.byName || {}).map(([name, n]) => ` ${esc(name)}: hold ${esc(ms(n.medianHoldMs))}, wait ${esc(ms(n.medianWaitMs))}.`).join('')}</p>`
    : '<p class="machine-lock-help machine-lock-stats" data-lock-stats>No lock history yet.</p>';
  return `<section class="machine-lock-panel panel">
    <div class="section-head"><h2>Locks</h2><span>Machine locks</span></div>
    ${statsLine}
    ${locks.length ? `<div class="machine-lock-table-wrap"><table class="machine-lock-table"><thead><tr><th>Lock</th><th>Holder</th><th>Kind</th><th>Age</th><th>Time left</th><th>State</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="machine-lock-empty">No machine locks are held.</p>'}
    <p class="machine-lock-help">A command lock ends when its command ends. A manual lock expires after 60 minutes. Herdr Boss takes over a stale lock. A full-suite queue shows each waiter's position, project, pane, kind, and wait time. The history line shows the median hold time and median wait time of the last 7 days, from the lock ledger.</p>
  </section>`;
}

// ---------- Resource leases ----------
// The Allocation page shows each pool, its items, and the holder of each item. A held row can release its lease.
let leaseMessage = '';
let leaseBusy = false;
const leaseRelease = { pool: '', item: '', project: '', holder: '' };
const poolEditor = { open: false, action: 'create', name: '', values: null, status: '' };
let poolBusy = false;
let poolRemoveTarget = '';
let poolRemoveBusy = false;

function leaseTtlText(pool) {
  return pool.ttlMinutes == null ? 'no TTL' : `${pool.ttlMinutes} min TTL`;
}

function leaseReclaimText(pool) {
  if (pool.check === 'cdp') return 'reclaim when its Chrome process is gone (cdp)';
  if (pool.check === 'tcp') return 'reclaim when the holder is gone or the TTL ends';
  return 'reclaim when the pane or worker is gone, or the TTL lapses';
}

function leaseAgeText(lease) { return lease.at ? ago(lease.at) : '–'; }
function leaseTimeLeftText(lease) { return lease.expiresAt ? until(lease.expiresAt) : 'no TTL'; }

// A project browser that runs keeps its lease, so the Release button is disabled until you close the browser.
// The state holds the browser records and the running Chrome processes; a match needs both.
function browserRunningForLease(s, lease) {
  const processes = s.browsers || [];
  return (s.managedBrowsers || []).some((browser) => browser.project === lease.project && String(browser.port) === lease.item
    && processes.some((proc) => proc.kind === 'automation-chrome' && String(proc.port) === String(browser.port) && proc.profile === browser.profile));
}

function leaseRow(s, pool, item) {
  const lease = (s.resourceLeases?.leases || []).find((candidate) => candidate.pool === pool.name && candidate.item === item) || null;
  const id = `lease-${esc(pool.name)}-${esc(item)}`;
  if (!lease) {
    return `<tr id="${id}" class="lease-row lease-free"><td class="mono" data-label="Item">${esc(item)}</td><td data-label="State">Free</td><td data-label="Holder project">–</td><td data-label="Pane or worker">–</td><td data-label="Age">–</td><td data-label="Time left">–</td><td data-label=""></td></tr>`;
  }
  const holder = lease.worker || lease.pane || '';
  const running = pool.name === 'project-browsers' && browserRunningForLease(s, lease);
  const action = running
    ? '<button type="button" disabled>Release</button><small class="lease-note">Close the browser first on the Browsers page.</small>'
    : `<button type="button" class="quiet" data-lease-release="${esc(pool.name)}" data-lease-item="${esc(item)}" data-lease-project="${esc(lease.project)}" data-lease-holder="${esc(holder)}">Release</button>`;
  return `<tr id="${id}" class="lease-row lease-held"><td class="mono" data-label="Item">${esc(item)}</td><td data-label="State">Held${lease.borrowed ? ' <span class="pill ghost">borrowed</span>' : ''}</td><td data-label="Holder project">${esc(lease.project)}</td><td class="mono" data-label="Pane or worker">${esc(holder) || '–'}</td><td data-label="Age">${esc(leaseAgeText(lease))}</td><td data-label="Time left">${esc(leaseTimeLeftText(lease))}</td><td data-label="" class="lease-action">${action}</td></tr>`;
}

function leasePoolBlock(s, pool) {
  const held = (s.resourceLeases?.leases || []).filter((lease) => lease.pool === pool.name && pool.items.includes(lease.item));
  // The built-in browser pool lists only the held ports, with one line for the free ports.
  const items = pool.builtIn ? held.map((lease) => lease.item) : pool.items;
  const free = pool.items.length - held.length;
  const rows = items.map((item) => leaseRow(s, pool, item)).join('') || '<tr><td colspan="7" class="empty">No items.</td></tr>';
  const controls = pool.builtIn ? '' : `<div class="lease-pool-controls"><button type="button" class="quiet" data-pool-edit="${esc(pool.name)}"${poolBusy ? ' disabled' : ''}>Edit</button><button type="button" class="quiet" data-pool-remove="${esc(pool.name)}"${poolBusy || poolRemoveBusy ? ' disabled' : ''}>Remove</button></div>`;
  return `<div class="lease-pool">
    <div class="lease-head"><b>${esc(pool.name)}</b><span>${held.length} held · ${free} free</span><span>${esc(leaseTtlText(pool))}</span><span>${esc(leaseReclaimText(pool))}</span>${controls}</div>
    <div class="lease-table-wrap"><table class="lease-table"><thead><tr><th>Item</th><th>State</th><th>Holder project</th><th>Pane or worker</th><th>Age</th><th>Time left</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    ${pool.builtIn ? `<p class="lease-free-line">${free} free port${free === 1 ? '' : 's'}</p>` : ''}
  </div>`;
}

function resourcePoolForm() {
  if (!poolEditor.open) return '';
  const values = poolEditor.values || {};
  const update = poolEditor.action === 'update';
  const check = values.check || '';
  return `<form class="resource-pool-form" data-resource-pool-form>
    <div><h3>${update ? `Edit ${esc(poolEditor.name)}` : 'Add a resource pool'}</h3><p>Set the pool items and the lease rules.</p></div>
    <div class="resource-pool-fields">
      <label>Pool name<input name="name" value="${esc(values.name || '')}" maxlength="64" pattern="[a-z0-9][a-z0-9-]{0,63}" required${update ? ' readonly' : ''}></label>
      <label class="pool-items-field">Items<textarea name="items" rows="4" required placeholder="8000&#10;8001">${esc(values.items || '')}</textarea><small>Enter one item per line or separate items with commas.</small></label>
      <label class="pool-split-field">Project split (JSON)<textarea name="split" rows="4" placeholder="{&#10;  &quot;project&quot;: [&quot;8000&quot;]&#10;}">${esc(values.split || '{}')}</textarea><small>Give each project an array of pool items.</small></label>
      <label>Environment variable<input name="env" value="${esc(values.env || '')}" maxlength="64" pattern="[A-Z_][A-Z0-9_]{0,63}" required></label>
      <label>Lease TTL (minutes)<input name="ttlMinutes" type="number" min="1" step="1" value="${esc(values.ttlMinutes ?? '')}" required></label>
      <label>Reclaim check<select name="check"><option value=""${check === '' ? ' selected' : ''}>None</option><option value="tcp"${check === 'tcp' ? ' selected' : ''}>TCP</option></select></label>
      <label>Grace period (minutes)<input name="graceMinutes" type="number" min="0" step="1" value="${esc(values.graceMinutes ?? '')}" required></label>
    </div>
    <p class="resource-pool-status" role="status">${esc(poolEditor.status)}</p>
    <div class="resource-pool-actions"><button type="submit"${poolBusy ? ' disabled' : ''}>${poolBusy ? 'Saving…' : update ? 'Save pool' : 'Add pool'}</button><button type="button" class="quiet" data-pool-cancel${poolBusy ? ' disabled' : ''}>Cancel</button></div>
  </form>`;
}

function leasesBlock(s) {
  const pools = s.resourceLeases?.pools || [];
  const errors = s.resourceLeases?.errors || [];
  if (!pools.length && !errors.length) return '';
  const errorLines = errors.map((error) => `<p class="lease-error" role="status">Resource pool config is invalid: ${esc(error)}</p>`).join('');
  return `<section class="lease-panel panel">
    <div class="section-head"><h2>Resource leases</h2><span>Pools that projects share</span><button type="button" data-pool-add${poolBusy ? ' disabled' : ''}>Add pool</button></div>
    <p class="setting-help">Each pool lists its items and the holder of each item. Select <b>Release</b> to give a lease back.</p>
    ${leaseMessage ? `<p class="lease-status" role="status">${esc(leaseMessage)}</p>` : ''}
    ${errorLines}
    ${resourcePoolForm()}
    ${pools.map((pool) => leasePoolBlock(s, pool)).join('')}
  </section>`;
}

// A dialog, not window.confirm, so the confirmation is part of the page and shows on every screen.
function leaseDialog() {
  let dialog = document.getElementById('lease-confirm');
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'lease-confirm';
  dialog.className = 'lease-confirm';
  dialog.setAttribute('aria-labelledby', 'lease-confirm-title');
  dialog.innerHTML = `<h2 id="lease-confirm-title">Release this lease?</h2>
    <p id="lease-confirm-text"></p>
    <p class="setting-help">The release removes the lease from leases.json. It never stops a process.</p>
    <p class="lease-confirm-status" id="lease-confirm-status" role="status"></p>
    <div class="lease-confirm-actions"><button type="button" data-lease-cancel>Cancel</button><button type="button" id="lease-confirm-release">Release</button></div>`;
  document.body.append(dialog);
  dialog.querySelector('[data-lease-cancel]').addEventListener('click', () => dialog.close());
  dialog.querySelector('#lease-confirm-release').addEventListener('click', confirmLeaseRelease);
  return dialog;
}

function openLeaseRelease(pool, item, project, holder) {
  Object.assign(leaseRelease, { pool, item, project, holder });
  const dialog = leaseDialog();
  dialog.querySelector('#lease-confirm-text').innerHTML = `Pool <b>${esc(pool)}</b> · item <b>${esc(item)}</b> · holder project <b>${esc(project)}</b>${holder ? ` · pane or worker <b>${esc(holder)}</b>` : ''}`;
  dialog.querySelector('#lease-confirm-status').textContent = '';
  dialog.querySelector('#lease-confirm-release').disabled = false;
  if (!dialog.open) dialog.showModal();
}

// Re-read the whole state from the service, for example after a change that the engine applied on a tick.
async function refreshState() {
  const response = await fetch('/api/state');
  if (response.ok) state = await response.json();
}

// The lease release re-reads the whole state after the change.
async function refreshLeaseState() {
  return refreshState();
}

async function confirmLeaseRelease() {
  if (leaseBusy) return;
  const dialog = leaseDialog();
  const button = dialog.querySelector('#lease-confirm-release');
  const status = dialog.querySelector('#lease-confirm-status');
  leaseBusy = true;
  button.disabled = true;
  status.textContent = 'Releasing…';
  try {
    await postJson('/api/leases/release', { pool: leaseRelease.pool, item: leaseRelease.item, project: leaseRelease.project });
    dialog.close();
    leaseMessage = `Released ${leaseRelease.pool} item ${leaseRelease.item}.`;
    await refreshLeaseState();
  } catch (error) {
    leaseMessage = error.message;
    status.textContent = error.message;
    if (/changed/i.test(error.message)) { dialog.close(); await refreshLeaseState(); }
  } finally {
    leaseBusy = false;
    button.disabled = false;
    lastRender = '';
    render();
  }
}

document.addEventListener('click', (e) => {
  const button = e.target.closest?.('[data-lease-release]');
  if (!button) return;
  openLeaseRelease(button.dataset.leaseRelease, button.dataset.leaseItem, button.dataset.leaseProject, button.dataset.leaseHolder || '');
});

function openResourcePoolForm(action, pool = null) {
  Object.assign(poolEditor, {
    open: true,
    action,
    name: pool?.name || '',
    status: '',
    values: pool ? {
      name: pool.name,
      items: (pool.items || []).join('\n'),
      split: JSON.stringify(pool.split || {}, null, 2),
      env: pool.env || '',
      ttlMinutes: pool.ttlMinutes ?? '',
      check: pool.check || '',
      graceMinutes: pool.graceMinutes ?? '',
    } : { name: '', items: '', split: '{}', env: '', ttlMinutes: '', check: '', graceMinutes: '' },
  });
  lastRender = '';
  render();
  requestAnimationFrame(() => document.querySelector('[data-resource-pool-form] [name="items"]')?.focus());
}

async function saveResourcePool(body) {
  const response = await fetch('/api/pools', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error((result.errors || [result.error || 'The resource pool could not be saved.']).join(' '));
  return result;
}

function resourcePoolRemoveDialog() {
  let dialog = document.getElementById('resource-pool-remove');
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'resource-pool-remove';
  dialog.className = 'lease-confirm';
  dialog.setAttribute('aria-labelledby', 'resource-pool-remove-title');
  dialog.innerHTML = `<h2 id="resource-pool-remove-title">Remove resource pool?</h2>
    <p id="resource-pool-remove-text"></p>
    <p class="setting-help">A pool cannot be removed while one of its items is held.</p>
    <p class="lease-confirm-status" id="resource-pool-remove-status" role="status"></p>
    <div class="lease-confirm-actions"><button type="button" data-pool-remove-cancel>Cancel</button><button type="button" id="resource-pool-remove-confirm">Remove pool</button></div>`;
  document.body.append(dialog);
  dialog.querySelector('[data-pool-remove-cancel]').addEventListener('click', () => dialog.close());
  dialog.querySelector('#resource-pool-remove-confirm').addEventListener('click', confirmResourcePoolRemove);
  return dialog;
}

function openResourcePoolRemove(name) {
  poolRemoveTarget = name;
  const dialog = resourcePoolRemoveDialog();
  dialog.querySelector('#resource-pool-remove-text').textContent = `Remove the resource pool ${name}?`;
  dialog.querySelector('#resource-pool-remove-status').textContent = '';
  dialog.querySelector('#resource-pool-remove-confirm').disabled = false;
  if (!dialog.open) dialog.showModal();
}

async function confirmResourcePoolRemove() {
  if (poolRemoveBusy) return;
  const dialog = resourcePoolRemoveDialog();
  const button = dialog.querySelector('#resource-pool-remove-confirm');
  const status = dialog.querySelector('#resource-pool-remove-status');
  poolRemoveBusy = true;
  button.disabled = true;
  status.textContent = 'Removing…';
  try {
    await saveResourcePool({ action: 'remove', pool: { name: poolRemoveTarget } });
    dialog.close();
    leaseMessage = `Removed resource pool ${poolRemoveTarget}.`;
    await refreshLeaseState();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    poolRemoveBusy = false;
    button.disabled = false;
    lastRender = '';
    render();
  }
}

document.addEventListener('input', (e) => {
  const form = e.target.closest?.('[data-resource-pool-form]');
  if (form) poolEditor.values = Object.fromEntries(new FormData(form).entries());
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest?.('[data-resource-pool-form]');
  if (!form) return;
  e.preventDefault();
  if (poolBusy) return;
  const values = Object.fromEntries(new FormData(form).entries());
  poolEditor.values = values;
  let split;
  try {
    split = values.split.trim() ? JSON.parse(values.split) : {};
    if (!split || typeof split !== 'object' || Array.isArray(split)) throw new Error('Project split must be a JSON object.');
  } catch (error) {
    poolEditor.status = error.message === 'Project split must be a JSON object.' ? error.message : 'Project split must be valid JSON.';
    lastRender = '';
    render();
    return;
  }
  const pool = {
    name: values.name,
    items: values.items.split(/[\s,]+/).filter(Boolean),
    split,
    env: values.env,
    ttlMinutes: values.ttlMinutes === '' ? null : Number(values.ttlMinutes),
    check: values.check || null,
    graceMinutes: values.graceMinutes === '' ? null : Number(values.graceMinutes),
  };
  poolBusy = true;
  poolEditor.status = 'Saving…';
  lastRender = '';
  render();
  try {
    await saveResourcePool({ action: poolEditor.action, pool });
    leaseMessage = `${poolEditor.action === 'create' ? 'Added' : 'Updated'} resource pool ${pool.name}.`;
    Object.assign(poolEditor, { open: false, values: null, status: '' });
    await refreshLeaseState();
  } catch (error) {
    poolEditor.status = error.message;
  } finally {
    poolBusy = false;
    lastRender = '';
    render();
  }
});

document.addEventListener('click', (e) => {
  const add = e.target.closest?.('[data-pool-add]');
  if (add) { openResourcePoolForm('create'); return; }
  if (e.target.closest?.('[data-pool-cancel]')) {
    Object.assign(poolEditor, { open: false, values: null, status: '' });
    lastRender = '';
    render();
    return;
  }
  const edit = e.target.closest?.('[data-pool-edit]');
  if (edit) {
    const pool = (state?.resourceLeases?.pools || []).find((item) => item.name === edit.dataset.poolEdit && !item.builtIn);
    if (pool) openResourcePoolForm('update', pool);
    return;
  }
  const remove = e.target.closest?.('[data-pool-remove]');
  if (remove) openResourcePoolRemove(remove.dataset.poolRemove);
});

function browsersView(s) {
  return [
    '<header class="page-intro"><div><h1>Project browsers</h1><p>Dedicated profiles, live page previews, and controls for each project.</p></div></header>',
    browserResources(s),
  ].join('');
}

function analyticsView(s) {
  return [
    '<header class="page-intro"><div><h1>Analytics</h1><p>Recorded work by project and provider. Token totals include only runs with measured tokens.</p></div></header>',
    usageBlock(),
    providerUsageBlock(),
    modelScorecardBlock(s),
    recentUsageBlock(),
    denialsBlock(s),
  ].join('');
}

// The text of a routine schedule.
function routineScheduleText(routine) {
  return routine.every !== undefined ? `every ${routine.every} min` : `${routine.beforeEnd} before the end`;
}

// The Watch form value of a routine. The first render takes the value from the service, which holds the last choice.
function watchRoutineDraft(routine) {
  return (watchForm.routines[routine.id] ??= { enabled: routine.enabled !== false, every: routine.every, beforeEnd: routine.beforeEnd });
}

// The choice that the start request carries: one entry for each routine.
function watchRoutineChoiceBody() {
  return Object.fromEntries((state?.watchRoutines || []).map((routine) => {
    const draft = watchRoutineDraft(routine);
    if (draft.enabled === false) return [routine.id, { enabled: false }];
    return [routine.id, routine.every !== undefined ? { enabled: true, every: Number(draft.every) } : { enabled: true, beforeEnd: draft.beforeEnd }];
  }));
}

// The routine rows and the ad-hoc text of the Watch form.
function watchRoutineFields(s) {
  const dis = nightBusy ? ' disabled' : '';
  const rows = (s?.watchRoutines || []).map((routine) => {
    const draft = watchRoutineDraft(routine);
    const id = esc(routine.id);
    const when = routine.every !== undefined
      ? `every <input type="number" id="wr-every-${id}" min="1" max="1440" inputmode="numeric" data-routine-every="${id}" value="${esc(draft.every)}" aria-label="${esc(routine.title)}: minutes between runs"${dis}> min`
      : `<input type="time" id="wr-before-${id}" data-routine-before="${id}" value="${esc(draft.beforeEnd)}" aria-label="${esc(routine.title)}: time before the end"${dis}> before the end`;
    return `<div class="watch-routine"><label class="setting-line"><input type="checkbox" data-routine-enabled="${id}"${draft.enabled ? ' checked' : ''}${dis}><span>${esc(routine.title)}</span></label><span class="watch-routine-when">${when}</span></div>`;
  }).join('');
  return `<fieldset class="watch-routines"><legend>Routines</legend>${rows || '<p class="setting-help">No routine is defined.</p>'}</fieldset><label class="watch-adhoc"><span>Instructions for this watch</span><textarea id="watch-adhoc" data-watch-adhoc rows="3" maxlength="2000" placeholder="Optional. The Boss gets this text with each routine. The orchestrators get it in the start notice."${dis}>${esc(watchForm.adhoc)}</textarea></label>`;
}

// The routines of the running watch, with the next run and the last run.
function watchRoutineLive(night) {
  const items = night.routines || [];
  const extra = night.adhoc ? `<p class="setting-help">Instructions for this watch: ${esc(night.adhoc)}</p>` : '';
  if (!items.length) return `<p class="setting-help">No routine runs in this watch.</p>${extra}`;
  const rows = items.map((routine) => {
    const note = routine.waitingSince ? ' · waiting for an idle Boss' : routine.missedAt ? ` · skipped ${watchLabel(routine.missedAt)}` : '';
    return `<li><b>${esc(routine.title)}</b><span>${esc(routineScheduleText(routine))}</span><span>Next ${routine.nextAt ? esc(watchLabel(routine.nextAt)) : 'none'} · Last ${routine.lastAt ? esc(watchLabel(routine.lastAt)) : 'never'}${esc(note)}</span></li>`;
  }).join('');
  return `<ul class="watch-routine-list">${rows}</ul>${extra}`;
}

// The editor draft of one routine on Settings. The key __new is the form of a new routine.
function routineEditorDraft(key, routine) {
  return (routineDrafts[key] ??= {
    id: '', title: routine?.title ?? '', model: routine?.model ?? 'default',
    kind: routine?.beforeEnd !== undefined ? 'beforeEnd' : 'every',
    every: routine?.every ?? 60, beforeEnd: routine?.beforeEnd ?? '01:00', prompt: routine?.prompt ?? '',
  });
}

function routineEditor(routine) {
  const key = routine ? routine.id : '__new';
  const draft = routineEditorDraft(key, routine);
  const k = esc(key);
  const field = (name) => `id="rd-${k}-${name}" data-rd="${k}:${name}"`;
  const source = routine ? { kit: 'kit text', override: 'edited', custom: 'own routine' }[routine.source] : 'new';
  const summary = routine ? `${esc(routine.title)} <small>${esc(routineScheduleText(routine))} · ${source}</small>` : 'Add a routine';
  const schedule = draft.kind === 'every'
    ? `<input type="number" ${field('every')} min="1" max="1440" inputmode="numeric" value="${esc(draft.every)}" aria-label="Minutes between runs"> min`
    : `<input type="time" ${field('beforeEnd')} value="${esc(draft.beforeEnd)}" aria-label="Time before the end"> before the end`;
  const reset = routine && routine.source !== 'kit'
    ? `<button type="button" data-routine-reset="${k}">${routine.source === 'custom' ? 'Delete routine' : 'Reset to the kit text'}</button>`
    : '';
  return `<details class="routine-editor" data-routine-details="${k}"${routineOpen.has(key) ? ' open' : ''}><summary>${summary}</summary><div class="routine-fields">`
    + (routine ? '' : `<label><span>Id</span><input ${field('id')} value="${esc(draft.id)}" maxlength="40" placeholder="lowercase-with-hyphens"></label>`)
    + `<label><span>Title</span><input ${field('title')} value="${esc(draft.title)}" maxlength="60"></label>`
    + `<label><span>Model hint</span><input ${field('model')} value="${esc(draft.model)}" maxlength="40"></label>`
    + `<label><span>Schedule</span><select ${field('kind')}><option value="every"${draft.kind === 'every' ? ' selected' : ''}>Every N minutes</option><option value="beforeEnd"${draft.kind === 'beforeEnd' ? ' selected' : ''}>Before the end of the watch</option></select></label>`
    + `<label><span>Time</span><span class="routine-when">${schedule}</span></label>`
    + `<label class="routine-prompt"><span>Prompt</span><textarea ${field('prompt')} rows="10" maxlength="8000">${esc(draft.prompt)}</textarea></label>`
    + `<div class="routine-actions"><button type="button" data-routine-save="${k}">Save</button>${reset}<span class="setting-help" role="status" aria-live="polite">${esc(routineMessages[key] || '')}</span></div>`
    + '</div></details>';
}

function watchRoutineSettings(s) {
  const routines = s?.watchRoutines || [];
  return `<section class="panel night-panel watch-routine-settings" id="watch-routines"><h2>Watch routines</h2><p class="setting-help">A routine is a prompt that the service sends to the Boss pane while a watch runs. Turn routines on for a watch in the Watch box on the <a href="/agents#watch">Agents page</a>. The default texts are kit files. A change here is saved on this machine and never changes the kit file.</p>${routines.map(routineEditor).join('')}${routineEditor(null)}</section>`;
}

async function sendJson(method, url, body) {
  const response = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || (result.errors || []).join(' ') || 'The request failed.');
  return result;
}

async function saveRoutineEditor(key) {
  const draft = routineDrafts[key];
  if (!draft) return;
  const id = key === '__new' ? draft.id.trim() : key;
  const body = {
    title: draft.title, model: draft.model, prompt: draft.prompt,
    ...(draft.kind === 'every' ? { every: Number(draft.every) } : { beforeEnd: draft.beforeEnd }),
  };
  try {
    await sendJson('PUT', `/api/watch/routines/${encodeURIComponent(id)}`, body);
    delete routineDrafts[key];
    delete watchForm.routines[id];
    routineMessages[key] = 'Saved.';
  } catch (error) { routineMessages[key] = error.message; }
  await refreshState();
  lastRender = '';
  render(true);
}

async function resetRoutineEditor(key) {
  if (!confirm('Reset this routine to the kit text?\n\nA routine that you added is deleted.')) return;
  try {
    await sendJson('DELETE', `/api/watch/routines/${encodeURIComponent(key)}`);
    delete routineDrafts[key];
    delete watchForm.routines[key];
    routineMessages[key] = 'Reset.';
  } catch (error) { routineMessages[key] = error.message; }
  await refreshState();
  lastRender = '';
  render(true);
}

// The Watch control. It sits at the top of the Agents page in a compact box. The form values live in watchForm.
function watchPanel(s) {
  const night = s?.night || { active: false };
  watchForm.until ??= localInputValue(defaultWatchUntil());
  const status = `${night.active ? `On watch ${watchUntilPhrase(night)}${night.quietHours ? ' · Quiet hours on' : ''}.` : 'No watch runs.'}${nightMessage ? ` ${nightMessage}` : ''}`;
  const dis = nightBusy ? ' disabled' : '';
  const form = night.active
    ? `${watchRoutineLive(night)}<button type="button" data-night-stop="true"${dis}>Stop the watch</button>`
    : `<div class="watch-form" data-night-form><label class="setting-line"><span>Until</span><input type="datetime-local" data-night-until value="${esc(watchForm.until)}" aria-label="Watch end date and time"${watchForm.forever || nightBusy ? ' disabled' : ''}></label><span class="watch-length" data-night-length aria-live="polite"></span><label class="setting-line"><input type="checkbox" data-night-forever aria-label="Watch until I cancel"${watchForm.forever ? ' checked' : ''}${dis}><span>Until I cancel</span></label><span class="watch-daily" data-night-daily-row${watchForm.forever ? '' : ' hidden'}><label class="setting-line"><input type="checkbox" data-night-daily aria-label="Send a daily report"${watchForm.daily ? ' checked' : ''}${dis}><span>Daily report</span></label><input type="time" data-night-report value="${esc(watchForm.report)}" aria-label="Daily report time"${watchForm.daily && !nightBusy ? '' : ' disabled'}></span><label class="setting-line"><input type="checkbox" data-night-quiet-hours aria-label="Quiet hours during the watch"${dis}><span>Quiet hours</span></label>${watchRoutineFields(s)}<button type="button" data-night-start="true"${dis}>Start</button><p class="setting-help watch-warning" role="alert" data-night-warning></p></div>`;
  return `<section class="panel night-panel watch-compact" id="watch"><h2>Watch</h2><p class="setting-help" role="status" aria-live="polite" data-night-status>${esc(status)}</p>${form}</section>`;
}

function agentsView(s) {
  const view = agentsViewMode();
  const chart = view === 'chart';
  const viewSwitch = `<div class="agents-view-switch" role="group" aria-label="Agents view">${[['chart', 'Chart'], ['list', 'List']].map(([key, label]) => `<button type="button" data-agents-view="${key}" aria-pressed="${view === key}">${label}</button>`).join('')}</div>`;
  const styleSwitch = `<div class="org-style-switch" role="group" aria-label="Chart style">${['plain', 'cards'].map((style) => `<button type="button" data-org-style="${style}" aria-pressed="${orgStyle === style}">${style === 'plain' ? 'Plain' : 'Cards'}</button>`).join('')}</div>`;
  return [
    `<header class="page-intro"><div><h1>Agents</h1><p>Chart or list of the Owner, the Boss, project orchestrators, and workers. Use the switch to change the view.</p></div><div class="page-switches">${viewSwitch}${chart ? styleSwitch : ''}</div></header>`,
    watchPanel(s),
    chart ? organizationChart(s) : agentInventory(s),
  ].join('');
}

// ---------- Messages ----------
// One thread for the Boss and one for each project. The panel is a dialog outside #app, so a state render keeps the typed text.

const MESSAGE_NUDGES = ['Continue.', 'Use your free worker slots.', 'Pause after the current task.'];
const MESSAGE_SENDER = { owner: 'Owner', boss: 'Boss', orch: 'Orchestrator' };
const messagePanel = { thread: null, name: '', timer: null, records: [], status: '', busy: false };

// Safe Markdown from public/markdown.js. The browser walk then removes any element or attribute outside the allowlist.
// The cache keeps the 10-second render cheap.
const markdownCache = new Map();
function safeMarkdownHtml(source) {
  const key = String(source ?? '');
  if (markdownCache.has(key)) return markdownCache.get(key);
  // One hostile message must not break the whole page render.
  let html;
  try {
    const template = document.createElement('template');
    template.innerHTML = markdownOrPlain(key);
    sanitizeRendered(template.content);
    html = template.innerHTML;
  } catch {
    html = plainTextHtml(key);
  }
  if (markdownCache.size >= 300) markdownCache.delete(markdownCache.keys().next().value);
  markdownCache.set(key, html);
  return html;
}

function markdownBlock(source, className = '') {
  return `<div class="md${className ? ` ${className}` : ''}">${safeMarkdownHtml(source)}</div>`;
}

function messageState(m) {
  if (m.from !== 'owner') return m.action ? `Action: ${m.action}` : '';
  const delivery = mailDeliveryState(m);
  return `${delivery}${m.repliedAt ? ` · replied ${clock(m.repliedAt)}` : ''}`;
}

function mailDeliveryState(m) {
  if (m.status === 'relayed') return `relayed by the Boss ${clock(m.relayedAt)}`;
  if (m.status === 'sent') return `delivered ${clock(m.sentAt)}`;
  if (m.status === 'failed') return `failed: ${m.error || 'unknown error'}`;
  return 'queued';
}

// Each record body is safe Markdown. A report also shows its title when the text does not start with it.
function messageBody(m) {
  if (m.kind !== 'report') return markdownBlock(m.text, 'msg-text');
  const title = m.title && /^#{1,6}\s+(.*)/.exec(String(m.text).trimStart())?.[1]?.trim() !== m.title ? `<h3>${esc(m.title)}</h3>` : '';
  return `<div class="md msg-report">${title}${safeMarkdownHtml(m.text)}</div>`;
}

function messageItem(m) {
  const sender = MESSAGE_SENDER[m.from] || m.from;
  const kind = m.kind === 'nudge' ? 'Nudge' : m.kind === 'status-request' ? 'Status request' : m.kind === 'report' ? 'Report' : '';
  const state = messageState(m);
  const body = messageBody(m);
  return `<li class="msg msg-${esc(m.from)} msg-${esc(m.status || 'new')}"><div class="msg-head"><strong>${esc(sender)}</strong>${kind ? `<span class="pill">${esc(kind)}</span>` : ''}<time datetime="${esc(m.at)}">${esc(clock(m.at))}</time></div>${body}${state ? `<p class="msg-state">${esc(state)}</p>` : ''}</li>`;
}

function messageDialog() {
  let dialog = document.getElementById('message-panel');
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'message-panel';
  dialog.className = 'message-panel';
  dialog.setAttribute('aria-labelledby', 'message-title');
  dialog.innerHTML = `<div class="message-head"><h2 id="message-title">Messages</h2><button type="button" data-message-close>Close</button></div>
    <ol class="msg-thread" id="message-thread" aria-live="polite"></ol>
    <form class="message-form" id="message-form"><label for="message-text">Message</label><textarea id="message-text" maxlength="2000" rows="3" required></textarea>
      <div class="message-send"><span class="sub" id="message-count">0 / 2000</span><button type="submit">Send</button></div></form>
    <div class="message-nudges" role="group" aria-label="Quick messages">${MESSAGE_NUDGES.map((text) => `<button type="button" data-message-nudge="${esc(text)}">${esc(text)}</button>`).join('')}<button type="button" data-message-status>Ask for status</button></div>
    <p class="message-status" id="message-status" role="status"></p>`;
  document.body.append(dialog);
  dialog.addEventListener('close', () => { clearInterval(messagePanel.timer); messagePanel.timer = null; messagePanel.thread = null; });
  dialog.querySelector('[data-message-close]').addEventListener('click', () => dialog.close());
  dialog.querySelector('#message-text').addEventListener('input', (e) => { dialog.querySelector('#message-count').textContent = `${e.target.value.length} / 2000`; });
  dialog.querySelector('#message-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = dialog.querySelector('#message-text').value.trim();
    if (text) sendMessage({ kind: 'message', text }, `Send this message to ${messagePanel.name}?\n\n${text}`, true);
  });
  dialog.querySelector('.message-nudges').addEventListener('click', (e) => {
    const nudge = e.target.closest('[data-message-nudge]')?.dataset.messageNudge;
    if (nudge) sendMessage({ kind: 'nudge', text: nudge }, `Send "${nudge}" to ${messagePanel.name}?`);
    else if (e.target.closest('[data-message-status]')) sendMessage({ kind: 'status-request' }, `Ask ${messagePanel.name} for a status report?`);
  });
  return dialog;
}

function renderMessages() {
  const dialog = messageDialog();
  dialog.querySelector('#message-title').textContent = `Messages · ${messagePanel.name}`;
  const list = dialog.querySelector('#message-thread');
  const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.innerHTML = messagePanel.records.length ? messagePanel.records.map(messageItem).join('') : '<li class="msg-empty">No messages in this thread.</li>';
  if (atEnd) list.scrollTop = list.scrollHeight;
  dialog.querySelector('#message-status').textContent = messagePanel.status;
  for (const button of dialog.querySelectorAll('button[type="submit"], [data-message-nudge], [data-message-status]')) button.disabled = messagePanel.busy;
}

async function loadMessages() {
  const thread = messagePanel.thread;
  if (!thread) return;
  try {
    const response = await fetch(`/api/messages?thread=${encodeURIComponent(thread)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The thread could not be read.');
    if (messagePanel.thread !== thread) return;
    messagePanel.records = result;
  } catch (error) { messagePanel.status = error.message; }
  renderMessages();
}

async function sendMessage(body, question, clear = false) {
  if (!messagePanel.thread || messagePanel.busy || !confirm(question)) return;
  messagePanel.busy = true; messagePanel.status = 'Sending…'; renderMessages();
  try {
    await postJson('/api/messages', { thread: messagePanel.thread, ...body });
    messagePanel.status = 'Queued. Herdr Boss delivers it when the agent is working, idle, or done.';
    if (clear) { const field = document.getElementById('message-text'); field.value = ''; field.dispatchEvent(new Event('input')); }
  } catch (error) { messagePanel.status = error.message; }
  finally { messagePanel.busy = false; }
  await loadMessages();
}

function openMessages(thread, name) {
  const dialog = messageDialog();
  clearInterval(messagePanel.timer);
  Object.assign(messagePanel, { thread, name, records: [], status: '', busy: false });
  renderMessages();
  if (!dialog.open) dialog.showModal();
  dialog.querySelector('#message-text').focus();
  loadMessages();
  messagePanel.timer = setInterval(loadMessages, 10000);
}

document.addEventListener('click', (e) => {
  const button = e.target.closest?.('[data-messages-thread]');
  if (button) openMessages(button.dataset.messagesThread, button.dataset.messagesName);
});

// ---------- Mailbox ----------
// Every agent reply and Boss report to the Owner. An answer uses the Owner send path with replyTo, and the server closes the item.
// A state render replaces #app, so the typed answers live in mailDrafts and go back into the fields after each render.

const MAIL_ACTION_LABEL = { answer: 'Answer', approve: 'Approve', decide: 'Decide', read: 'Read' };
const MAIL_FOLDER_KEY = 'herdr-boss-mailbox-folder';
const MAIL_FOLDERS = ['needs-you', 'inbox', 'updates', 'done', 'sent'];
const MAIL_FOLDER_LABEL = { 'needs-you': 'Needs you', inbox: 'Inbox', updates: 'Reports and updates', done: 'Done', sent: 'Sent' };
const MAIL_FOLDER_ICON = { 'needs-you': 'alert', inbox: 'inbox', updates: 'report', done: 'check', sent: 'send' };
const MAIL_FOLDER_KEYS = { 'needs-you': 'needsYou', inbox: 'inbox', updates: 'updates', done: 'done', sent: 'sent' };
const mailbox = { needsYou: [], inbox: [], updates: [], sent: [], done: [], updatesUnread: 0, folder: null, loaded: false, loading: false, error: '', notice: '', counts: '', busy: false, status: {}, currentConversation: null, conversationRecords: [], conversationLoading: false, conversationError: '', composing: false, composeDraft: '', composeThread: 'boss', replyDraft: '', openedDeepLink: null };
const mailReading = new Set();
const mailSelected = new Set();
const mailDrafts = {};

function resolveMailboxFolder(requested, remembered, needsYouCount) {
  if (MAIL_FOLDERS.includes(requested)) return requested;
  if (needsYouCount > 0) return 'needs-you';
  return MAIL_FOLDERS.includes(remembered) ? remembered : 'needs-you';
}

function storedMailboxFolder() {
  try { return localStorage.getItem(MAIL_FOLDER_KEY); }
  catch { return null; }
}

function saveMailboxFolder(folder) {
  try { localStorage.setItem(MAIL_FOLDER_KEY, folder); }
  catch { /* Storage can be unavailable in private or restricted browser modes. */ }
}

function mailboxFolderFromLocation() {
  return resolveMailboxFolder(new URLSearchParams(location.search).get('folder'), storedMailboxFolder(), mailbox.needsYou.length);
}

function mailboxFolderUrl(folder) {
  return `/mailbox?folder=${encodeURIComponent(folder)}`;
}

function mailProject(s, item) {
  return item.thread === 'boss' ? '' : s.control?.projects?.[item.thread]?.label || item.thread;
}

function mailHeadline(item) {
  if (item.kind === 'report') return item.title || 'Report';
  return String(item.text || '').split('\n').find((line) => line.trim())?.trim() || 'Reply';
}

function mailItemLabel(s, item) {
  const project = mailProject(s, item);
  return `${MESSAGE_SENDER[item.from] || item.from}${project ? ` · ${project}` : ''}`;
}

function mailField(item, label, max, required) {
  const id = esc(item.id);
  return `<label for="mail-text-${id}">${label}</label><textarea id="mail-text-${id}" data-mail-draft="${id}" maxlength="${max}" rows="3"${required ? ' required' : ''}>${esc(mailDrafts[item.id] || '')}</textarea>`;
}

function mailActions(item) {
  const id = esc(item.id);
  const off = mailbox.busy ? ' disabled' : '';
  const status = `<p class="mail-status" role="status">${esc(mailbox.status[item.id] || '')}</p>`;
  const dismiss = `<div class="mail-dismiss-row"><button type="button" data-mail-dismiss="${id}"${off}>Dismiss</button></div>`;
  if (item.action === 'approve') {
    return `<form class="mail-actions" data-mail-form="${id}">${mailField(item, 'Note (optional)', 1700, false)}
      <div class="mail-buttons"><button type="submit" data-mail-verdict="Approved."${off}>Approve</button><button type="submit" class="mail-decline" data-mail-verdict="Declined."${off}>Decline</button></div>${dismiss}${status}</form>`;
  }
  const choices = item.action === 'decide' && item.choices?.length
    ? `<div class="mail-choices" role="group" aria-label="Choices">${item.choices.map((choice) => `<button type="button" data-mail-choice="${esc(choice)}" data-mail-item="${id}"${off}>${esc(choice)}</button>`).join('')}</div>`
    : '';
  const label = item.action === 'decide' ? (choices ? 'Other answer, or a note for the choice' : 'Decision') : 'Answer';
  return `<form class="mail-actions" data-mail-form="${id}">${choices}${mailField(item, label, choices ? 1700 : 2000, !choices)}
    <div class="mail-buttons"><button type="submit"${off}>Send</button></div>${dismiss}${status}</form>`;
}

function mailDoneLine(item) {
  if (item.answer) {
    const state = mailDeliveryState(item.answer);
    const replied = item.answer.repliedAt ? ` · replied ${clock(item.answer.repliedAt)}` : '';
    return `<div class="mail-answer"><span class="sub">Your answer · ${esc(state)} · ${esc(clock(item.answer.at))}${esc(replied)}</span>${markdownBlock(item.answer.text, 'msg-text')}</div>`;
  }
  if (item.closedBy === 'boss') {
    return `<p class="sub mail-answer">Closed by the Boss · ${esc(clock(item.closedAt))}</p>`;
  }
  if (item.dismissed) {
    return `<p class="sub mail-answer">Dismissed · ${esc(clock(item.closedAt))}</p>`;
  }
  return `<p class="sub mail-answer">Closed ${esc(clock(item.closedAt))}</p>`;
}

// The sender line of a row. A Sent row names the recipient.
function mailRowSender(s, row) {
  const item = row.item;
  const name = item.thread === 'boss' ? 'Boss' : mailProject(s, item);
  return item.from === 'owner' ? `To ${name}` : name;
}

function mailRowsHtml(s, rows, folder) {
  const current = mailbox.currentConversation ? `${mailbox.currentConversation.thread}:${mailbox.currentConversation.id}` : '';
  const selectable = folder === 'needs-you';
  return rows.map((row) => mailRowHtml(row, {
    esc, clock: (iso) => listTime(iso), current, selectable, selected: mailSelected,
    avatar: (thread) => avatarSlot(thread, { title: avatarTitle(thread), size: 36 }),
    sender: (x) => mailRowSender(s, x),
    state: folder === 'sent' ? (item) => `${mailDeliveryState(item)}${item.repliedAt ? ` · replied ${clock(item.repliedAt)}` : ''}` : null,
  })).join('');
}

// ---------- App view: icons, the app bar, and the drawer ----------
// One stroke icon set for the phone app view. 24-unit view box, stroke 1.8.
const APP_ICON = {
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="M13.5 6.5l4 4"/>',
  inbox: '<path d="M4 13.5 6.5 5h11l2.5 8.5V19H4v-5.5Z"/><path d="M4 13.5h5a3 3 0 0 0 6 0h5"/>',
  alert: '<path d="M12 4 21 19.5H3L12 4Z"/><path d="M12 10v4m0 2.6v.01"/>',
  report: '<path d="M7 3.5h7l4 4V20.5H7z"/><path d="M14 3.5v4h4M9.5 12h6M9.5 15.5h6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  send: '<path d="M4 12 20 4l-4 16-4-6.5L4 12Z"/><path d="m12 13.5 8-9.5"/>',
  mail: '<path d="M3.5 6.5h17v12h-17z"/><path d="m4 7 8 6 8-6"/>',
  chat: '<path d="M4 5.5h16v11H9l-5 4v-15Z"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.4m0 2.6v.01"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
};
const appIcon = (name) => `<svg class="app-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${APP_ICON[name] || ''}</svg>`;

let appDrawerOpen = false;

// The menu button of the phone app bar. A dot shows unread items on the other page.
function appMenuButton(s, route) {
  const counts = topIconCounts(s);
  const other = route === 'mailbox' ? counts.chat : counts['needs-action'] + counts.mail;
  return `<button type="button" class="app-icon-button app-menu" data-app-drawer aria-expanded="${appDrawerOpen}" aria-controls="app-drawer" aria-label="Menu${other ? `, ${other} unread on other pages` : ''}">${appIcon('menu')}${other ? '<span class="app-menu-dot" aria-hidden="true"></span>' : ''}</button>`;
}

// The drawer holds the Mailbox folders (on the Mailbox) and the links to all pages. It replaces the page header on a phone.
function appDrawer(s, route, folderLinks = '') {
  const counts = topIconCounts(s);
  const pages = [['/', 'Overview'], ['/board', 'Board'], ['/mailbox', 'Mailbox', counts['needs-action']], ['/chat', 'Chat', counts.chat], ['/agents', 'Agents'], ['/projects', 'Projects'], ['/browsers', 'Browsers'], ['/allocation', 'Allocation'], ['/analytics', 'Analytics'], ['/logs', 'Logs']];
  const links = pages.map(([href, label, count]) => `<a href="${href}"${href.slice(1) === route ? ' aria-current="page"' : ''}><span>${label}</span>${count ? `<span class="app-drawer-count num">${count > 99 ? '99+' : count}</span>` : ''}</a>`).join('');
  return `<div class="app-drawer" id="app-drawer" data-key="app-drawer"${appDrawerOpen ? '' : ' hidden'}><button type="button" class="app-drawer-scrim" data-app-drawer-close tabindex="-1" aria-label="Close the menu"></button>`
    + `<nav class="app-drawer-panel" aria-label="Menu"><div class="app-drawer-head"><span class="app-drawer-brand">Herdr Boss</span><button type="button" class="app-icon-button" data-app-drawer-close aria-label="Close the menu">${appIcon('close')}</button></div>`
    + `${folderLinks ? `<div class="app-drawer-group" aria-label="Mailbox folders">${folderLinks}</div><hr>` : ''}<div class="app-drawer-group app-drawer-pages">${links}</div><hr><button type="button" class="app-drawer-help" data-app-help>${appIcon('help')}<span>Help</span></button></nav></div>`;
}

document.addEventListener('click', (e) => {
  if (e.target.closest?.('[data-app-drawer]')) { appDrawerOpen = !appDrawerOpen; render(); if (appDrawerOpen) document.querySelector('.app-drawer-panel a[aria-current], .app-drawer-panel a')?.focus(); return; }
  if (e.target.closest?.('[data-app-drawer-close]')) { appDrawerOpen = false; render(); document.querySelector('[data-app-drawer]')?.focus(); return; }
  if (e.target.closest?.('[data-app-help]')) { appDrawerOpen = false; render(); setHelp(true); return; }
  // A link in the drawer changes the page. The global link handler renders the page, so the drawer closes first.
  if (e.target.closest?.('.app-drawer a')) appDrawerOpen = false;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && appDrawerOpen) { appDrawerOpen = false; render(); document.querySelector('[data-app-drawer]')?.focus(); }
});

// A project page link opens one Mailbox conversation directly with ?thread= and ?conversation=.
function openMailboxDeepLink() {
  const params = new URLSearchParams(location.search);
  const thread = params.get('thread');
  const conversation = params.get('conversation');
  if (!thread || !conversation) return;
  const key = `${thread}:${conversation}`;
  if (mailbox.openedDeepLink === key) return;
  mailbox.openedDeepLink = key;
  const item = [...mailbox.inbox, ...mailbox.sent, ...mailbox.done].find((x) => x.thread === thread && (x.conversationId || x.id) === conversation);
  openMailboxConversation(thread, conversation, item?.id);
}

// The fixed store limits, from the state. The line is read-only.
function messageLimitsLine(s) {
  const l = s?.limits?.messages;
  if (!l) return '';
  const days = Math.round(l.retentionMs / 86400000);
  return `<p class="mail-folder-limits">Herdr Boss keeps messages for ${days} days and accepts at most ${l.sendLimitPerMinute} Owner messages a minute.</p>`;
}

function mailFolderLinks(folder, counts, className) {
  const link = (key) => `<a class="${className}" href="${mailboxFolderUrl(key)}"${folder === key ? ' aria-current="page"' : ''}>${appIcon(MAIL_FOLDER_ICON[key])}<span>${esc(MAIL_FOLDER_LABEL[key])}</span>${counts[key] ? `<span class="mail-folder-count num">${counts[key]}</span>` : ''}</a>`;
  // Sent is below a divider: the Owner reads it for the delivery state, not for work.
  return `${MAIL_FOLDERS.filter((key) => key !== 'sent').map(link).join('')}<hr class="mail-folder-divider">${link('sent')}`;
}

function mailEmpty(folder) {
  if (folder === 'needs-you') return `<div class="mail-empty"><p>Nothing needs you.</p><p class="mail-empty-next">${mailbox.updates.length} ${mailbox.updates.length === 1 ? 'report or update' : 'reports and updates'} · <a href="${mailboxFolderUrl('inbox')}">Open Inbox</a></p></div>`;
  const text = { inbox: 'The Inbox is empty.', updates: 'No reports or updates.', sent: 'No sent messages.', done: 'No completed items.' }[folder];
  return `<div class="mail-empty"><p>${text}</p></div>`;
}

function mailboxView(s) {
  if (!mailbox.loaded && !mailbox.loading) loadMailbox();
  const folder = mailboxFolderFromLocation();
  if (mailbox.folder !== folder) {
    mailbox.folder = folder;
    mailbox.currentConversation = null;
    mailbox.conversationRecords = [];
    mailbox.composing = false;
  }
  const items = mailbox[MAIL_FOLDER_KEYS[folder]] || [];
  const counts = { 'needs-you': mailbox.needsYou.length, inbox: mailbox.inbox.length, updates: mailbox.updatesUnread || 0, done: 0, sent: 0 };
  const label = MAIL_FOLDER_LABEL[folder];
  const allSelected = mailbox.needsYou.length > 0 && mailbox.needsYou.every((item) => mailSelected.has(item.id));
  const selected = mailbox.needsYou.filter((item) => mailSelected.has(item.id)).length;
  const bulk = folder === 'needs-you' && mailbox.needsYou.length ? `<div class="mail-bulk"><label><input type="checkbox" data-mail-select-all ${allSelected ? 'checked' : ''} aria-label="Select all Needs-you items"> Select all</label><button type="button" data-mail-dismiss-selected ${mailbox.busy || !selected ? 'disabled' : ''}>Dismiss selected${selected ? ` (${selected})` : ''}</button></div>` : '';
  let list;
  if (!mailbox.loaded) list = '<div class="mail-empty"><p>Loading…</p></div>';
  else if (!items.length) list = mailEmpty(folder);
  else if (folder === 'inbox') list = inboxSections(items).map((section) => `<section class="mail-section" data-key="section:${section.key}" aria-label="${esc(section.label)}"><h2 class="mail-section-head">${esc(section.label)}</h2><ol class="mail-list">${mailRowsHtml(s, section.rows, folder)}</ol></section>`).join('');
  else list = `<ol class="mail-list">${mailRowsHtml(s, groupMailRows(items), folder)}</ol>`;
  const open = mailbox.currentConversation || mailbox.composing;
  const conversationPanel = mailbox.composing ? mailComposeView(s) : mailbox.currentConversation ? mailConversationView(s) : '';
  return `<div class="mailbox-layout${open ? ' conversation-open' : ''}" data-key="mailbox"${appDrawerOpen ? ' inert' : ''}>`
    + `<aside class="mail-folder-pane" data-key="mail-rail"><button type="button" class="mail-compose-button" data-mail-compose-open${mailbox.busy ? ' disabled' : ''}>${appIcon('pencil')}<span>New message</span></button><nav class="mail-folder-nav" aria-label="Mailbox folders">${mailFolderLinks(folder, counts, 'mail-folder-link')}</nav>${messageLimitsLine(s)}</aside>`
    + `<section class="mail-list-pane" data-key="mail-list" aria-label="${esc(label)}"><div class="app-bar mail-list-bar">${appMenuButton(s, 'mailbox')}<h1>${esc(label)}${mailbox.loaded ? `<span class="app-bar-count num">${items.length}</span>` : ''}</h1></div>`
    + `<p class="mail-notice" role="status"${mailbox.error || mailbox.notice ? '' : ' hidden'}>${esc(mailbox.error || mailbox.notice)}</p>${bulk}`
    + `<div class="mail-list-scroll" data-key="mail-list-scroll">${list}</div>`
    + `<button type="button" class="mail-fab" data-mail-compose-open${mailbox.busy ? ' disabled' : ''}>${appIcon('pencil')}<span>New</span></button></section>`
    + `<section class="mail-conversation-pane" data-key="mail-thread-pane"${open ? '' : ' hidden'}>${conversationPanel}</section></div>`
    + appDrawer(s, 'mailbox', mailFolderLinks(folder, counts, 'app-drawer-folder'));
}

async function loadMailbox(auto = false) {
  mailbox.loading = true;
  try {
    const folder = mailboxFolderFromLocation();
    const response = await fetch(`/api/mailbox?folder=${encodeURIComponent(folder)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The mailbox could not be read.');
    Object.assign(mailbox, { needsYou: result.needsYou, inbox: result.inbox || [], updates: result.updates, sent: result.sent, done: result.done, updatesUnread: result.updatesUnread, loaded: true, error: '', counts: JSON.stringify(result.mailbox) });
    const requested = new URLSearchParams(location.search).get('folder');
    const resolved = resolveMailboxFolder(requested, storedMailboxFolder(), mailbox.needsYou.length);
    mailbox.folder = resolved;
    saveMailboxFolder(resolved);
    openMailboxDeepLink();
    if (!requested || !MAIL_FOLDERS.includes(requested)) history.replaceState(null, '', mailboxFolderUrl(resolved));
    for (const id of mailSelected) if (!mailbox.needsYou.some((item) => item.id === id)) mailSelected.delete(id);
    if (state) state.mailbox = result.mailbox;
  } catch (error) { mailbox.error = error.message; }
  finally { mailbox.loading = false; }
  if (auto) autoRender();
  else render();
}

function mailFind(id) { return mailbox.inbox.find((item) => item.id === id) || mailbox.needsYou.find((item) => item.id === id) || mailbox.updates.find((item) => item.id === id) || mailbox.done.find((item) => item.id === id); }

function mailComposeView(s) {
  const projects = Object.values(s.control?.projects || {}).filter((project) => project.orch?.pane).map((project) => ({ thread: project.slug, name: project.label || project.slug }));
  const options = [{ thread: 'boss', name: 'Boss' }, ...projects].map((item) => `<option value="${esc(item.thread)}"${mailbox.composeThread === item.thread ? ' selected' : ''}>${esc(item.name)}</option>`).join('');
  return `<section class="mail-compose"><div class="app-bar mail-panel-head"><button type="button" class="app-icon-button mail-back" data-mail-back aria-label="Back to ${esc(MAIL_FOLDER_LABEL[mailbox.folder])}">${appIcon('back')}</button><h2>New message</h2></div><form data-mail-compose><label for="mail-compose-recipient">To</label><select id="mail-compose-recipient" name="thread">${options}</select><label for="mail-compose-text">Message</label><textarea id="mail-compose-text" data-mail-compose-draft maxlength="2000" rows="8" required>${esc(mailbox.composeDraft)}</textarea><div class="mail-compose-actions"><button type="submit"${mailbox.busy ? ' disabled' : ''}>Send</button></div><p class="mail-status" role="status">${esc(mailbox.status.compose || '')}</p></form></section>`;
}

function mailConversationView(s) {
  const selected = mailbox.currentConversation;
  const records = mailbox.conversationRecords;
  const titleRecord = [...records].reverse().find((record) => record.to === 'owner') || records.at(-1);
  const title = titleRecord ? mailItemLabel(s, titleRecord) : selected.thread === 'boss' ? 'Boss' : s.control?.projects?.[selected.thread]?.label || selected.thread;
  const messages = mailbox.conversationLoading ? '<p class="mail-empty">Loading conversation…</p>' : mailbox.conversationError ? `<p class="mail-error" role="alert">${esc(mailbox.conversationError)}</p>` : records.length ? `<ol class="mail-conversation">${records.map((record) => mailConversationMessage(s, record)).join('')}</ol>` : '<p class="mail-empty">No messages in this conversation.</p>';
  const lastAgent = [...records].reverse().find((record) => ['boss', 'orch'].includes(record.from) && record.to === 'owner');
  const replyTo = lastAgent && !lastAgent.closedAt ? lastAgent.id : '';
  return `<section class="mail-reading"><div class="app-bar mail-panel-head"><button type="button" class="app-icon-button mail-back" data-mail-back aria-label="Back to ${esc(MAIL_FOLDER_LABEL[mailbox.folder])}">${appIcon('back')}</button>${avatarSlot(selected.thread, { title: avatarTitle(selected.thread), size: 28 })}<h2>${esc(title)}</h2></div><div class="mail-conversation-scroll" data-key="mail-thread:${esc(selected.thread)}:${esc(selected.id)}">${messages}</div><form class="mail-reply" data-mail-reply data-mail-thread="${esc(selected.thread)}" data-mail-reply-to="${esc(replyTo)}"><label for="mail-reply-text">Reply</label><textarea id="mail-reply-text" data-mail-reply-draft maxlength="2000" rows="3" required>${esc(mailbox.replyDraft)}</textarea><div><span class="sub">${replyTo ? 'Replies to the last message.' : 'Starts a new message in this thread.'}</span><button type="submit"${mailbox.busy ? ' disabled' : ''}>Send</button></div><p class="mail-status" role="status">${esc(mailbox.status.reply || '')}</p></form></section>`;
}

function mailConversationMessage(s, record) {
  const owner = record.from === 'owner';
  const item = mailFind(record.id);
  const headline = record.kind === 'report' ? record.title || 'Report' : mailHeadline(record);
  const meta = `${mailItemLabel(s, record)} · ${clock(record.at)}`;
  const delivery = owner ? mailDeliveryState(record) : record.action ? `Action: ${record.action}` : '';
  const status = delivery ? `<p class="mail-message-state">${esc(delivery)}${owner && record.repliedAt ? ` · replied ${esc(clock(record.repliedAt))}` : ''}</p>` : '';
  const controls = item && item.closedAt ? mailDoneLine(item) : item && ['answer', 'approve', 'decide'].includes(item.action) ? mailActions(item) : '';
  return `<li><article class="mail-message${owner ? ' from-owner' : ''}"><header class="mail-message-head"><strong>${esc(meta)}</strong>${record.kind === 'report' ? '' : `<span>${esc(headline)}</span>`}</header>${messageBody(record)}${status}${controls}</article></li>`;
}

async function loadMailboxConversation(thread, conversation) {
  mailbox.conversationLoading = true;
  mailbox.conversationError = '';
  try {
    const response = await fetch(`/api/mailbox?thread=${encodeURIComponent(thread)}&conversation=${encodeURIComponent(conversation)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The conversation could not be read.');
    if (mailbox.currentConversation?.thread !== thread || mailbox.currentConversation?.id !== conversation) return;
    mailbox.conversationRecords = result.messages;
  } catch (error) { mailbox.conversationError = error.message; }
  finally { mailbox.conversationLoading = false; }
  render();
}

function openMailboxConversation(thread, conversation, itemId) {
  mailbox.composing = false;
  mailbox.composeDraft = '';
  mailbox.replyDraft = '';
  mailbox.currentConversation = { thread, id: conversation };
  mailbox.conversationRecords = [];
  const item = mailFind(itemId);
  render();
  if (item) mailOpened(item);
  loadMailboxConversation(thread, conversation);
}

async function mailSendReply(form) {
  const thread = form.dataset.mailThread;
  const replyTo = form.dataset.mailReplyTo || null;
  const text = mailbox.replyDraft.trim();
  if (!text || mailbox.busy || !confirm(`Send this reply to ${thread === 'boss' ? 'the Boss' : mailProject(state || {}, { thread })}?\n\n${text}`)) return;
  mailbox.busy = true;
  mailbox.status.reply = 'Sending…';
  render();
  try {
    await postJson('/api/messages', { thread, kind: 'message', text, ...(replyTo ? { replyTo } : {}) });
    mailbox.replyDraft = '';
    mailbox.status.reply = 'Queued. Herdr Boss delivers it when the agent is working, idle, or done.';
    await loadMailbox();
    if (mailbox.currentConversation) await loadMailboxConversation(thread, mailbox.currentConversation.id);
  } catch (error) { mailbox.status.reply = error.message; render(); }
  finally { mailbox.busy = false; render(); }
}

async function mailSendNewMessage(form) {
  const thread = form.elements.thread.value;
  const text = mailbox.composeDraft.trim();
  const name = thread === 'boss' ? 'the Boss' : mailProject(state || {}, { thread });
  if (!text || mailbox.busy || !confirm(`Send this message to ${name}?\n\n${text}`)) return;
  mailbox.busy = true;
  mailbox.status.compose = 'Sending…';
  render();
  try {
    const result = await postJson('/api/messages', { thread, kind: 'message', text });
    mailbox.composeDraft = '';
    mailbox.composeThread = thread;
    mailbox.composing = false;
    mailbox.currentConversation = { thread, id: result.message.id };
    if (mailbox.folder !== 'sent') history.pushState(null, '', mailboxFolderUrl('sent'));
    mailbox.folder = 'sent';
    saveMailboxFolder('sent');
    mailbox.notice = 'Message queued.';
    await loadMailbox();
    await loadMailboxConversation(thread, result.message.id);
  } catch (error) { mailbox.status.compose = error.message; mailbox.composing = true; render(); }
  finally { mailbox.busy = false; render(); }
}

async function mailMarkRead(item) {
  const result = await postJson('/api/messages/read', { ids: [item.id] });
  if (state) state.mailbox = result.mailbox;
  return result;
}

// Opening an item marks it read. A refused read, for example in the read-only preview, leaves it unread.
async function mailOpened(item) {
  if (item.readAt || mailReading.has(item.id)) return;
  mailReading.add(item.id);
  try { await mailMarkRead(item); item.readAt = new Date().toISOString(); mailbox.updatesUnread = mailbox.updates.filter((record) => !record.readAt).length; }
  catch (error) { mailbox.status[item.id] = error.message; }
  finally { mailReading.delete(item.id); }
  render();
}

async function mailSend(item, text, question) {
  if (mailbox.busy || !confirm(question)) return;
  mailbox.busy = true; mailbox.status[item.id] = 'Sending…'; mailbox.notice = ''; render();
  try {
    await postJson('/api/messages', { thread: item.thread, kind: 'message', text, replyTo: item.id });
    delete mailDrafts[item.id];
    delete mailbox.status[item.id];
    mailbox.notice = `Queued for ${mailItemLabel(state || {}, item)}. Herdr Boss delivers it when the agent is working, idle, or done. The item is in Done.`;
  } catch (error) { mailbox.status[item.id] = error.message; }
  finally { mailbox.busy = false; }
  await loadMailbox();
  if (mailbox.currentConversation) await loadMailboxConversation(mailbox.currentConversation.thread, mailbox.currentConversation.id);
}

async function mailDismiss(items) {
  if (mailbox.busy || !items.length) return;
  const question = items.length === 1
    ? `Dismiss this item from ${mailItemLabel(state || {}, items[0])} without sending an answer?`
    : `Dismiss ${items.length} selected items without sending answers?`;
  if (!confirm(question)) return;
  mailbox.busy = true; mailbox.notice = ''; mailbox.error = ''; render();
  try {
    await postJson('/api/messages/dismiss', { ids: items.map((item) => item.id) });
    for (const item of items) {
      mailSelected.delete(item.id);
      delete mailDrafts[item.id];
      delete mailbox.status[item.id];
    }
    mailbox.notice = items.length === 1 ? 'Dismissed. No message was sent.' : `Dismissed ${items.length} items. No messages were sent.`;
  } catch (error) { mailbox.notice = error.message; }
  finally { mailbox.busy = false; }
  await loadMailbox();
  if (mailbox.currentConversation) await loadMailboxConversation(mailbox.currentConversation.thread, mailbox.currentConversation.id);
}

function mailRestoreDrafts(focusId, caret) {
  for (const field of $app.querySelectorAll('[data-mail-draft]')) if (field !== document.activeElement) field.value = mailDrafts[field.dataset.mailDraft] || '';
  const compose = $app.querySelector('[data-mail-compose-draft]');
  if (compose && compose !== document.activeElement) compose.value = mailbox.composeDraft;
  const reply = $app.querySelector('[data-mail-reply-draft]');
  if (reply && reply !== document.activeElement) reply.value = mailbox.replyDraft;
  // A keyed patch keeps the focused field, its text, and its caret. Only a replaced field needs them back.
  const focused = focusId ? document.getElementById(focusId) : null;
  if (focused && focused !== document.activeElement) {
    focused.focus({ preventScroll: true });
    if (caret) focused.setSelectionRange(caret[0], caret[1]);
  }
}

document.addEventListener('input', (e) => {
  const id = e.target.dataset?.mailDraft;
  if (id) mailDrafts[id] = e.target.value;
  if (e.target.matches?.('[data-mail-compose-draft]')) mailbox.composeDraft = e.target.value;
  if (e.target.matches?.('[data-mail-reply-draft]')) mailbox.replyDraft = e.target.value;
});
document.addEventListener('change', (e) => {
  if (e.target.matches?.('[data-mail-select]')) {
    for (const id of e.target.dataset.mailSelect.split(',')) {
      if (e.target.checked) mailSelected.add(id);
      else mailSelected.delete(id);
    }
    render();
  } else if (e.target.matches?.('[data-mail-select-all]')) {
    if (e.target.checked) for (const item of mailbox.needsYou) mailSelected.add(item.id);
    else mailSelected.clear();
    render();
  } else if (e.target.matches?.('#mail-compose-recipient')) {
    mailbox.composeThread = e.target.value;
  }
});
document.addEventListener('submit', (e) => {
  if (e.target.matches?.('[data-mail-compose]')) { e.preventDefault(); mailSendNewMessage(e.target); return; }
  if (e.target.matches?.('[data-mail-reply]')) { e.preventDefault(); mailSendReply(e.target); return; }
  const id = e.target.dataset?.mailForm;
  if (!id) return;
  e.preventDefault();
  const item = mailFind(id);
  if (!item) return;
  const note = (mailDrafts[id] || '').trim();
  const verdict = e.submitter?.dataset.mailVerdict;
  const who = mailItemLabel(state || {}, item);
  if (verdict) mailSend(item, note ? `${verdict} ${note}` : verdict, `Send "${verdict}" to ${who}?${note ? `\n\n${note}` : ''}`);
  else if (note) mailSend(item, note, `Send this answer to ${who}?\n\n${note}`);
});
document.addEventListener('click', (e) => {
  if (e.target.closest?.('[data-mail-compose-open]')) {
    mailbox.composing = true;
    mailbox.currentConversation = null;
    mailbox.conversationRecords = [];
    mailbox.status.compose = '';
    render();
    return;
  }
  if (e.target.closest?.('[data-mail-back]')) {
    mailbox.composing = false;
    mailbox.currentConversation = null;
    mailbox.conversationRecords = [];
    mailbox.replyDraft = '';
    mailbox.status.compose = '';
    render();
    return;
  }
  const open = e.target.closest?.('[data-mail-open]');
  if (open) { openMailboxConversation(open.dataset.mailThread, open.dataset.mailConversation, open.dataset.mailItemId); return; }
  const dismiss = e.target.closest?.('[data-mail-dismiss]');
  if (dismiss) {
    const item = mailFind(dismiss.dataset.mailDismiss);
    if (item) mailDismiss([item]);
    return;
  }
  if (e.target.closest?.('[data-mail-dismiss-selected]')) {
    mailDismiss(mailbox.needsYou.filter((item) => mailSelected.has(item.id)));
    return;
  }
  const choice = e.target.closest?.('[data-mail-choice]');
  if (choice) {
    const item = mailFind(choice.dataset.mailItem);
    const note = (mailDrafts[choice.dataset.mailItem] || '').trim();
    const text = `Choice: ${choice.dataset.mailChoice}${note ? `\n\n${note}` : ''}`;
    if (item) mailSend(item, text, `Send this choice to ${mailItemLabel(state || {}, item)}?\n\n${text}`);
    return;
  }
});

function updateMailboxBadge(s) {
  const unread = s?.mailbox?.needsYouUnread ?? s?.mailbox?.unread ?? 0;
  const text = (count) => count > 99 ? '99+' : String(count);
  for (const badge of document.querySelectorAll('[data-mailbox-badge]')) { badge.hidden = !unread; badge.textContent = text(unread); }
  const link = $nav.querySelector('[data-nav="mailbox"]');
  if (link) link.setAttribute('aria-label', unread ? `Mailbox, ${unread} unread` : 'Mailbox');
  $navMenu.setAttribute('aria-label', unread ? `Menu, ${unread} unread in Mailbox` : 'Menu');
  updateTopIcons(s);
}

// The three top-bar icons: chat unread, mail unread, and open action items. An icon with nothing to show is faded and has no badge.
const TOP_ICON_NAMES = { chat: 'Chat', mail: 'Updates', 'needs-action': 'Needs you' };
const TOP_ICON_COUNT_LABEL = { chat: (n) => `Chat, ${n} unread`, mail: (n) => `Updates, ${n} unread`, 'needs-action': (n) => `Needs you, ${n} items` };
const topIconCounts = (s) => ({
  chat: s?.mailbox?.chatUnread ?? 0,
  mail: s?.mailbox?.mailUnread ?? 0,
  'needs-action': s?.mailbox?.needsAction ?? s?.mailbox?.open ?? 0,
});

function updateTopIcons(s) {
  for (const [name, count] of Object.entries(topIconCounts(s))) {
    const icon = document.querySelector(`[data-top-icon="${name}"]`);
    if (icon) {
      icon.dataset.empty = count ? 'false' : 'true';
      icon.setAttribute('aria-label', count ? TOP_ICON_COUNT_LABEL[name](count) : TOP_ICON_NAMES[name]);
    }
    for (const badge of document.querySelectorAll(`[data-top-badge="${name}"]`)) {
      badge.hidden = !count;
      badge.textContent = count > 99 ? '99+' : String(count);
    }
  }
}

// ---------- Chat ----------
// One thread for the Boss and one for each project orchestrator. A chat message is a normal bubble.
// The only write path is POST /api/messages. A read, a page, and the list are reads.

const CHAT_PAGE_LIMIT = 50;
const CHAT_MAX_LINES = 6;
// The actions that ask the Owner for something. A decide without a choice list is not a real choice.
const CHAT_CHOICES_MAX = 10;
const CHAT_CHOICE_TEXT_MAX = 200;
const chat = { list: [], loaded: false, loading: false, error: '', status: '', thread: null, title: '', messages: [], more: false, moreLoading: false, loadingThread: false, draft: '', pending: [], unseen: 0, busy: false, scroll: null, keepScroll: null, drafts: {}, results: {}, cardStatus: {}, focus: null, backThread: null };

const chatThreadFromLocation = () => new URLSearchParams(location.search).get('thread');
const chatUrl = (thread) => (thread ? `/chat?thread=${encodeURIComponent(thread)}` : '/chat');
function chatFind(thread) { return chat.list.find((item) => item.thread === thread); }

// The row order is the order of the API: the newest last message first, then the thread name.
function chatSortList(list) {
  return [...list].sort((left, right) => {
    if (!left.last) return right.last ? 1 : left.thread.localeCompare(right.thread);
    if (!right.last) return -1;
    return Date.parse(right.last.at) - Date.parse(left.last.at) || left.thread.localeCompare(right.thread);
  });
}

function chatUnreadTotal() { return chat.list.reduce((sum, item) => sum + (item.unread || 0), 0); }

function chatUpdateBadge() {
  const unread = chatUnreadTotal();
  const text = (count) => count > 99 ? '99+' : String(count);
  for (const badge of document.querySelectorAll('[data-chat-badge]')) { badge.hidden = !unread; badge.textContent = text(unread); }
  const link = $nav.querySelector('[data-nav="chat"]');
  if (link) link.setAttribute('aria-label', unread ? `Chat, ${unread} unread` : 'Chat');
}

// ---------- Avatars: one stable circle per thread ----------
// A fixed palette of 12 hues. Each hue reads in the light theme and in the dark theme. No pure white and no pure black circle.
const AVATAR_PALETTE = ['#2f6f9f', '#1f7a6a', '#4a5bb5', '#7a4bb0', '#a24a8f', '#a5453f', '#9c5c22', '#8a7420', '#5f7a24', '#277a35', '#1a7a86', '#d99b3a'];
const AVATAR_TEXT_LIGHT = '#ffffff';
const AVATAR_TEXT_DARK = '#14181d';
const AVATAR_SIZES = [20, 28, 36];
const AVATAR_MAX_BYTES = 512 * 1024;

// A camel-case name starts a new word, so AlphaBeta gives the letters A and B.
function avatarWords(title) {
  return String(title || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_.-]+/).filter((word) => /[A-Za-z0-9]/.test(word));
}

function avatarInitials(title) {
  const words = avatarWords(title);
  const letters = (words.length > 1 ? `${words[0][0]}${words[1][0]}` : String(words[0] || '?')).replace(/[^A-Za-z0-9]/g, '');
  return (letters || '?').toUpperCase().slice(0, 2);
}

function avatarHash(slug) {
  let hash = 0;
  for (const char of String(slug || '?')) hash = (hash * 31 + char.codePointAt(0)) % 1000003;
  return hash;
}

// The same slug always gets the same hue, in the Chat, the Mailbox, and the Agents chart.
function avatarColor(slug) {
  return AVATAR_PALETTE[avatarHash(slug) % AVATAR_PALETTE.length];
}

// The relative luminance of a hex color, as WCAG 2.1 defines it.
function avatarLuminance(hex) {
  const value = parseInt(String(hex).slice(1), 16);
  const [red, green, blue] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => {
    const part = channel / 255;
    return part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function avatarContrast(one, two) {
  const high = Math.max(avatarLuminance(one), avatarLuminance(two));
  const low = Math.min(avatarLuminance(one), avatarLuminance(two));
  return (high + 0.05) / (low + 0.05);
}

// The initials take the color of the best contrast on the circle.
function avatarTextColor(background) {
  return avatarContrast(background, AVATAR_TEXT_LIGHT) >= avatarContrast(background, AVATAR_TEXT_DARK) ? AVATAR_TEXT_LIGHT : AVATAR_TEXT_DARK;
}

// One avatar as inline SVG. The Boss gets a fixed crown in the accent color. The avatar is decoration, so the name stays as text.
function avatarSvg(slug, { title, size } = {}) {
  const side = AVATAR_SIZES.includes(Number(size)) ? Number(size) : 28;
  if (String(slug) === 'boss') return `<svg class="avatar avatar-${side} avatar-boss" width="${side}" height="${side}" viewBox="0 0 40 40" aria-hidden="true" focusable="false"><circle cx="20" cy="20" r="20" fill="var(--panel-2)"/><path d="M10.5 25 9 15.4l5.6 3.8L20 11.5l5.4 7.7 5.6-3.8L29.5 25Z" fill="var(--accent)"/><rect x="10.5" y="26.4" width="19" height="2.8" rx="1.4" fill="var(--accent)"/></svg>`;
  const background = avatarColor(slug);
  // The view box is 40 units wide, so 16 units give 40 percent of the rendered size.
  return `<svg class="avatar avatar-${side}" width="${side}" height="${side}" viewBox="0 0 40 40" aria-hidden="true" focusable="false"><circle cx="20" cy="20" r="20" fill="${background}"/><text x="20" y="20" dy="0.36em" text-anchor="middle" font-family="ui-monospace, monospace" font-size="16" font-weight="650" fill="${avatarTextColor(background)}">${avatarInitials(title || slug)}</text></svg>`;
}

// One title for one avatar. Every page reads the project display name from the state, so the Chat, the Mailbox, the Agents chart, and Settings show the same avatar. The chat title and then the slug are the fallbacks.
function avatarTitle(slug, fallback = '', projects = state?.control?.projects) {
  if (slug === 'boss') return 'Boss';
  const project = projects?.[slug];
  return project?.label || project?.title || fallback || slug;
}

// The image of the Owner replaces the generated avatar when it exists. The generated one stays as the fallback.
function avatarSlot(slug, { title, size } = {}) {
  return `<span class="avatar-slot" data-avatar-slot="${esc(slug)}">${avatarSvg(slug, { title, size })}<img class="avatar avatar-image" data-avatar-image="${esc(slug)}" src="/api/avatars/${encodeURIComponent(slug)}" alt="" hidden></span>`;
}

function avatarImageLoaded(image) {
  if (!image?.dataset?.avatarImage) return;
  image.hidden = false;
  if (image.previousElementSibling) image.previousElementSibling.hidden = true;
}

function avatarImageFailed(image) {
  if (!image?.dataset?.avatarImage) return;
  image.remove();
}
// ---------- End avatars ----------

function chatTitle(thread) {
  const item = chatFind(thread);
  if (item) return item.title;
  if (thread === 'boss') return 'Boss';
  return state?.control?.projects?.[thread]?.label || thread;
}

function chatView(s) {
  if (!chat.loaded && !chat.loading) loadChats();
  chatSyncLocation();
  const rows = chat.list.map(chatRow).join('');
  const list = chat.list.length
    ? `<ul class="chat-list">${rows}</ul>`
    : `<p class="chat-empty">${chat.loaded ? 'No chats.' : 'Loading…'}</p>`;
  const conversation = chat.thread ? chatConversationView() : '<section class="chat-empty-state"><p>Select a chat to read it.</p></section>';
  return `<div class="chat-layout${chat.thread ? ' thread-open' : ''}" data-key="chat"${appDrawerOpen ? ' inert' : ''}><aside class="chat-list-pane" data-key="chat-list" aria-label="Chats"><div class="app-bar chat-list-head">${appMenuButton(s, 'chat')}<h1>Chats<span class="app-bar-count num">${chat.list.length}</span></h1></div>`
    + `<p class="chat-notice" role="status"${chat.error || chat.status ? '' : ' hidden'}>${esc(chat.error || chat.status)}</p>`
    + `<div class="chat-list-scroll" data-key="chat-list-scroll">${list}</div></aside><section class="chat-conversation-pane" data-key="chat-thread-pane">${conversation}</section></div>`
    + appDrawer(s, 'chat');
}

function chatRow(item) {
  const unread = item.unread || 0;
  const time = item.last ? listTime(item.last.at) : '';
  const open = item.thread === chat.thread;
  const badge = unread ? `<span class="chat-unread">${unread > 99 ? '99+' : unread}</span>` : '';
  // A report is mail. The row shows it as one short line with a link to the Mailbox.
  const preview = !item.last ? 'No messages yet.' : item.last.channel === 'mail' ? `Report: ${item.last.title || 'Report'}` : item.last.text;
  return `<li class="chat-item${unread ? ' unread' : ''}" data-key="chat:${esc(item.thread)}"><button class="chat-row" type="button" data-chat-open="${esc(item.thread)}"${open ? ' aria-current="true"' : ''} aria-label="Open the ${esc(item.title)} chat${unread ? `. ${unread} unread message${unread === 1 ? '' : 's'}` : ''}">
    ${avatarSlot(item.thread, { title: avatarTitle(item.thread, item.title), size: 36 })}
    <span class="chat-main"><span class="chat-line-one"><span class="chat-name">${esc(item.title)}</span>${time ? `<span class="chat-time">${esc(time)}</span>` : ''}</span><span class="chat-line-two"><span class="chat-preview">${esc(preview)}</span>${badge}</span></span>
  </button></li>`;
}

function chatConversationView() {
  const title = chatTitle(chat.thread);
  const bubbles = chat.loadingThread && !chat.messages.length
    ? '<p class="chat-empty">Loading messages…</p>'
    : chat.messages.length || chat.pending.length
      ? `<ol class="chat-bubbles" role="log" aria-live="polite" aria-label="Messages in the ${esc(title)} chat">${[...chat.messages, ...chat.pending].map((record, index, list) => chatBubble(record, index === 0 || list[index - 1].from !== record.from)).join('')}</ol>`
      : '<p class="chat-empty">No messages in this chat.</p>';
  const older = chat.more ? `<p class="chat-more">${chat.moreLoading ? 'Loading older messages…' : 'Scroll up for older messages.'}</p>` : '';
  const pill = chat.unseen ? `<button type="button" class="chat-new-pill" data-chat-new>${chat.unseen} new message${chat.unseen === 1 ? '' : 's'}</button>` : '';
  return `<div class="chat-panel"><div class="app-bar chat-panel-head"><button type="button" class="app-icon-button chat-back" data-chat-back aria-label="Back to chats">${appIcon('back')}</button>${avatarSlot(chat.thread, { title: avatarTitle(chat.thread, title), size: 28 })}<h2>${esc(title)}</h2><a class="app-icon-button chat-mail-link" href="/mailbox?folder=inbox" aria-label="Open the Mailbox">${appIcon('mail')}</a></div><div class="chat-scroll" data-key="chat-scroll:${esc(chat.thread)}" data-chat-scroll tabindex="0">${older}${bubbles}</div>${pill}<form class="chat-composer" data-key="chat-composer" data-chat-compose><label class="visually-hidden" for="chat-draft">Message to ${esc(title)}</label><div class="chat-composer-row"><textarea id="chat-draft" data-chat-draft maxlength="2000" rows="1" placeholder="Message…">${esc(chat.draft)}</textarea><button type="submit" class="chat-send" aria-label="Send"${chat.busy ? ' disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 20 21 12 3.5 4v6l12 2-12 2v6Z"/></svg></button></div><p class="chat-hint">Enter sends · Shift+Enter makes a new line</p></form></div>`;
}

// The same rule as parseChoices in src/messages.js: the Markdown list items under a Choices heading.
function chatParseChoices(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^#{1,6}\s+choices\s*:?\s*$/i.test(line.trim()));
  if (start < 0) return [];
  const choices = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line) || /^\s*(?:[-*+]|\d+[.)])\s*$/.exec(line);
    if (!item) break;
    const choice = String(item[1] ?? '').trim().slice(0, CHAT_CHOICE_TEXT_MAX);
    if (choice && !choices.includes(choice)) choices.push(choice);
    if (choices.length >= CHAT_CHOICES_MAX) break;
  }
  return choices;
}

// The result line names the outcome: Approved 22:05, Rejected 22:05, or Answered 22:05.
function chatResultLabel(text) {
  const body = String(text || '');
  if (body.startsWith('Approved.')) return 'Approved';
  if (body.startsWith('Rejected.')) return 'Rejected';
  if (body.startsWith('Choice: ')) return body.split('\n')[0].slice(0, 80);
  return 'Answered';
}

// A card shows a short question line. The choices move to the buttons, so the page drops the list from the text.
function chatQuestionText(text) {
  const body = String(text || '');
  const at = body.search(/^#{1,6}\s+choices\s*:?\s*$/im);
  return (at < 0 ? body : body.slice(0, at)).trim();
}

// An accept, a deny, and a postpone. Later only collapses the card.
function chatApproveOptions() {
  return [
    { value: 'Approved.', label: 'Approve' },
    { value: 'Rejected.', label: 'Reject', deny: true },
    { value: 'later', label: 'Later', later: true },
  ];
}

// A decide shows one button for each choice. Without a choice list it is not a real choice, so it stays a normal bubble.
function chatActionOptions(record) {
  if (record.action === 'approve') return chatApproveOptions();
  return chatParseChoices(record.text).map((choice) => ({ value: `Choice: ${choice}`, label: choice }));
}

// The Owner message that closed an action item is the next record in the thread with the same replyTo.
function chatAnswerTo(record) {
  if (record.closedBy === 'boss' && record.closeNote) return { text: record.closeNote, at: record.closedAt };
  return chat.messages.find((item) => item.replyTo === record.id && item.from === 'owner') || null;
}

// The accessible name of a bubble. It names the sender, the time, the text, and the state.
function chatBubbleLabel(sender, record, state) {
  const text = String(record.text || '').replace(/\s+/g, ' ').trim();
  return [sender, clock(record.at), text, state].filter(Boolean).join('. ');
}

function chatCardField(record) {
  const id = esc(record.id);
  return `<label class="visually-hidden" for="chat-card-${id}">Answer</label><input id="chat-card-${id}" data-chat-card-draft="${id}" type="text" maxlength="1700" value="${esc(chat.drafts[record.id] || '')}" placeholder="Answer…">`;
}

// An open item with a real choice shows as the same bubble with one small button per option. There is no card frame.
function chatActionCard(record) {
  const id = esc(record.id);
  const collapsed = chat.results[record.id];
  if (collapsed) return `<p class="chat-card-result" role="status">${esc(collapsed)}</p>`;
  const off = chat.busy ? ' disabled' : '';
  const error = chat.cardStatus[record.id] ? `<p class="chat-card-error" role="alert">${esc(chat.cardStatus[record.id])}</p>` : '';
  if (record.action === 'answer') {
    return `<form class="chat-card-answer" data-chat-card-form="${id}">${chatCardField(record)}<button type="submit"${off}>Send</button></form>${error}`;
  }
  const options = chatActionOptions(record);
  const buttons = options.map((option) => `<button type="button" class="${option.deny ? 'chat-card-deny' : ''}${option.later ? ' chat-card-later' : ''}" data-chat-option="${id}" data-chat-value="${esc(option.value)}"${off}>${esc(option.label)}</button>`).join('');
  return `<div class="chat-card-options" role="group" aria-label="Options for this ${esc(MAIL_ACTION_LABEL[record.action] || record.action)} request">${buttons}</div>${error}`;
}

function chatBubble(record, startOfRun = false) {
  const owner = record.from === 'owner';
  const sender = MESSAGE_SENDER[record.from] || record.from;
  // A mail report is not a chat message. The bubble holds one short line and a link to the Mailbox.
  if (record.channel === 'mail') {
    return `<li class="chat-report" data-key="msg:${esc(record.id)}" data-chat-bubble="${esc(record.id)}" aria-label="${esc(chatBubbleLabel(sender, { ...record, text: `Report: ${record.title || 'Report'}` }, 'Open in Mailbox'))}"><span class="chat-report-text">Report: ${esc(record.title || 'Report')}</span><a class="chat-action-link" href="/mailbox?folder=updates">Open in Mailbox</a></li>`;
  }
  // A closed item shows the answer that closed it, for example Approved 22:05.
  const answer = owner ? null : chatAnswerTo(record);
  const result = answer ? `${chatResultLabel(answer.text)} ${clock(answer.at)}` : record.closedAt ? `closed ${clock(record.closedAt)}` : '';
  const state = owner ? mailDeliveryState(record) : result || (record.action ? `Action: ${record.action}` : record.readAt ? 'read' : 'unread');
  const tone = !owner ? '' : record.status === 'sent' || record.status === 'relayed' ? ' ok' : record.status === 'failed' ? ' fail' : '';
  // A card is a normal bubble with buttons. The text is a short question line.
  const options = owner ? [] : chatActionOptions(record);
  const isCard = !owner && !record.closedAt && (record.action === 'answer' || options.length > 0);
  const card = isCard ? chatActionCard(record) : '';
  const text = isCard ? chatQuestionText(record.text) : record.text;
  const action = !owner && record.action ? `<a class="chat-action-link" href="/mailbox?thread=${encodeURIComponent(record.thread)}">Open in Mailbox</a>` : '';
  const retry = record.local && record.error ? `<p class="chat-bubble-retry"><button type="button" data-chat-retry="${esc(record.id)}">Retry</button></p>` : '';
  const label = esc(chatBubbleLabel(sender, { ...record, text }, state));
  const content = `<div class="chat-bubble-text md">${safeMarkdownHtml(text)}</div><p class="chat-bubble-meta"><span class="chat-bubble-time">${esc(clock(record.at))}</span>${state ? ` <span class="chat-state${tone}">${esc(state)}</span>` : ''}</p>${card}${action}${retry}`;
  // The avatar of the other party shows on the first bubble of a run of messages from that sender.
  if (!owner && startOfRun) return `<li class="chat-entry" data-key="msg:${esc(record.id)}" data-chat-bubble="${esc(record.id)}" aria-label="${label}">${avatarSlot(record.thread, { title: avatarTitle(record.thread), size: 20 })}<div class="chat-bubble from-agent${card ? ' chat-card' : ''}" data-chat-bubble="${esc(record.id)}" aria-label="${label}">${content}</div></li>`;
  return `<li class="chat-bubble${owner ? ' from-owner' : ' from-agent'}${startOfRun ? ' run-start' : ''}${card ? ' chat-card' : ''}" data-key="msg:${esc(record.id)}" data-chat-bubble="${esc(record.id)}" aria-label="${label}">${content}</li>`;
}

async function loadChats() {
  chat.loading = true;
  try {
    const response = await fetch('/api/chats');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The chats could not be read.');
    chat.list = chatSortList(result);
    chat.loaded = true;
    chat.error = '';
  } catch (error) { chat.error = error.message; }
  finally { chat.loading = false; render(); }
}

async function loadChatThread(thread, { older = false } = {}) {
  const oldest = older ? chat.messages[0] : null;
  const before = oldest ? `&before=${encodeURIComponent(oldest.id)}` : '';
  if (older) chat.moreLoading = true; else chat.loadingThread = true;
  try {
    const response = await fetch(`/api/chats/${encodeURIComponent(thread)}?limit=${CHAT_PAGE_LIMIT}${before}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The chat could not be read.');
    if (chat.thread !== thread) return;
    chat.messages = older ? [...result.messages, ...chat.messages] : result.messages;
    chat.more = result.more;
    chat.error = '';
  } catch (error) { chat.error = error.message; }
  finally { if (older) chat.moreLoading = false; else chat.loadingThread = false; render(); }
}

// A link, the Back control, or the browser Back button can change the open thread.
function chatSyncLocation() {
  const requested = chatThreadFromLocation();
  if (requested === chat.thread) return;
  chat.thread = requested;
  chat.messages = [];
  chat.more = false;
  chat.pending = [];
  chat.unseen = 0;
  chat.scroll = null;
  chat.keepScroll = null;
  chat.status = '';
  chat.drafts = {};
  chat.results = {};
  chat.cardStatus = {};
  if (!requested) { render(); return; }
  loadChatThread(requested);
  chatMarkRead(requested);
}

function openChat(thread) {
  if (chat.thread === thread) return;
  history.pushState(null, '', chatUrl(thread));
  chatSyncLocation();
  chat.focus = 'composer';
  render();
}

function closeChat() {
  if (!chat.thread) return;
  chat.backThread = chat.thread;
  chat.focus = 'row';
  history.pushState(null, '', '/chat');
  chatSyncLocation();
  render();
}

// Opening a chat marks the messages to the Owner as read. A refused read, for example in the read-only preview, leaves them unread.
async function chatMarkRead(thread) {
  if (!(chatFind(thread)?.unread > 0)) return;
  try {
    const response = await fetch(`/api/chats/${encodeURIComponent(thread)}/read`, { method: 'POST' });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'The chat could not be marked read.');
    const item = chatFind(thread);
    if (item) item.unread = 0;
    for (const record of chat.messages) if (record.to === 'owner' && !record.readAt) record.readAt = new Date().toISOString();
  } catch (error) { chat.status = error.message; }
  render();
}

// A re-render replaces the conversation. Keep the reading position, the draft, and the caret.
function chatCaptureView() {
  chatScrolled();
  const field = $app.querySelector('[data-chat-draft]');
  return { focus: field === document.activeElement, caret: field && document.activeElement === field ? field.selectionStart : null };
}

function chatRestoreView(view) {
  const scroller = $app.querySelector('[data-chat-scroll]');
  if (scroller) {
    if (chat.keepScroll) {
      scroller.scrollTop = chat.keepScroll.top + (scroller.scrollHeight - chat.keepScroll.height);
      chat.scroll = scroller.scrollTop;
      chat.keepScroll = null;
    } else scroller.scrollTop = chat.scroll === null ? scroller.scrollHeight : chat.scroll;
    scroller.addEventListener('scroll', chatScrolled, { passive: true });
  }
  const field = $app.querySelector('[data-chat-draft]');
  // A keyed patch keeps the focused field with its text and caret. A replaced field gets the draft and the caret back.
  if (field && field !== document.activeElement) {
    field.value = chat.draft;
    chatGrowField(field);
    if (view?.focus || chat.focus === 'composer') {
      field.focus();
      if (view?.caret != null) field.setSelectionRange(view.caret, view.caret);
    }
  }
  // On Back the focus goes to the list row of the chat that was open.
  if (chat.focus === 'row' && chat.backThread) $app.querySelector(`[data-chat-open="${CSS.escape(chat.backThread)}"]`)?.focus();
  chat.focus = null;
}

// A scroll to the top reads an older page. The reading position must stay on the same message.
function chatScrolled() {
  const scroller = $app.querySelector('[data-chat-scroll]');
  if (!scroller) return;
  if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48) { chat.scroll = null; chat.unseen = 0; }
  else chat.scroll = scroller.scrollTop;
  if (scroller.scrollTop < 32 && chat.more && !chat.moreLoading) loadChatOlder();
}

async function loadChatOlder() {
  const scroller = $app.querySelector('[data-chat-scroll]');
  if (!chat.thread || !scroller || !chat.more || chat.moreLoading) return;
  chat.keepScroll = { top: scroller.scrollTop, height: scroller.scrollHeight };
  await loadChatThread(chat.thread, { older: true });
}

// The text area grows with the text, up to six lines. Its scroll bar shows only when the text is longer than that.
function chatGrowField(field) {
  const line = parseFloat(getComputedStyle(field).lineHeight) || 20;
  const limit = Math.round(line) * CHAT_MAX_LINES;
  field.style.height = 'auto';
  field.style.height = `${Math.min(field.scrollHeight, limit)}px`;
  field.classList.toggle('chat-overflow', field.scrollHeight > limit);
}

function chatUpsertRecord(record) {
  const index = chat.messages.findIndex((item) => item.id === record.id);
  if (index === -1) chat.messages.push(record);
  else chat.messages[index] = record;
  chat.messages.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
}

// The page shows a queued bubble at once. A refused send marks it failed and offers a retry.
async function chatSend(retry = null) {
  const thread = chat.thread;
  const field = $app.querySelector('[data-chat-draft]');
  const text = String(retry ? retry.text : field ? field.value : chat.draft).trim();
  if (!thread || !text || chat.busy) return;
  const pending = retry || { id: `local-${Date.now()}-${chat.pending.length}`, local: true, thread, from: 'owner', at: new Date().toISOString(), text, status: 'queued', error: '' };
  pending.status = 'queued';
  pending.error = '';
  chat.busy = true;
  chat.draft = '';
  chat.status = 'Sending…';
  if (field) field.value = '';
  chat.pending = [...chat.pending.filter((item) => item.id !== pending.id), pending];
  chat.scroll = null;
  render();
  try {
    const result = await postJson('/api/messages', { thread, kind: 'message', text });
    chat.pending = chat.pending.filter((item) => item.id !== pending.id);
    chatUpsertRecord(result.message);
    chat.status = 'Queued. Herdr Boss delivers the message when the agent is working, idle, or done.';
  } catch (error) {
    pending.status = 'failed';
    pending.error = error.message;
    chat.status = error.message;
  } finally { chat.busy = false; render(); }
  $app.querySelector('[data-chat-draft]')?.focus();
}

// One write path. The card sends the same request the Mailbox sends, with replyTo set to the item.
// The server closes the item. The card then shows the result, and the message stream refreshes both views.
async function chatSendAction(record, text) {
  if (chat.busy || !record || !text) return;
  chat.busy = true;
  chat.status = 'Sending…';
  render();
  try {
    await postJson('/api/messages', { thread: record.thread, kind: 'message', text, replyTo: record.id });
    delete chat.drafts[record.id];
    delete chat.cardStatus[record.id];
    chat.results[record.id] = `${chatResultLabel(text)} ${clock(new Date().toISOString())}`;
    chat.status = 'Queued. Herdr Boss delivers it when the agent is working, idle, or done. The item is closed.';
  } catch (error) {
    chat.cardStatus[record.id] = error.message;
    chat.status = error.message;
  } finally { chat.busy = false; render(); }
  await loadChatThread(record.thread);
}

// A message change arrives on the existing event stream. The list and the open chat follow it.
function onChatMessage(event) {
  const record = event?.record;
  if (!record || typeof record.id !== 'string') return;
  const item = chatFind(record.thread);
  if (item) {
    item.last = { id: record.id, at: record.at, from: record.from, text: String(record.text ?? '').slice(0, 120), status: record.status ?? null };
    if (record.to === 'owner' && record.readAt) item.unread = 0;
    else if (event.type === 'append' && record.to === 'owner' && record.thread !== chat.thread) item.unread = (item.unread || 0) + 1;
    chat.list = chatSortList(chat.list);
  }
  if (record.thread === chat.thread) {
    const isNew = event.type === 'append' && !chat.messages.some((message) => message.id === record.id);
    chatUpsertRecord(record);
    // The page scrolls down only when the Owner reads the newest message. Otherwise it shows a pill.
    if (isNew && chat.scroll !== null) chat.unseen += 1;
  }
  render();
}

document.addEventListener('click', (e) => {
  const open = e.target.closest?.('[data-chat-open]');
  if (open) { openChat(open.dataset.chatOpen); return; }
  if (e.target.closest?.('[data-chat-back]')) { closeChat(); return; }
  if (e.target.closest?.('[data-chat-new]')) { chat.scroll = null; chat.unseen = 0; render(); return; }
  const option = e.target.closest?.('[data-chat-option]');
  if (option) {
    const item = chat.messages.find((record) => record.id === option.dataset.chatOption);
    if (!item) return;
    // Later only collapses the card. The Mailbox item stays open, and the page writes nothing.
    if (option.dataset.chatValue === 'later') {
      chat.results[item.id] = 'Later. The item stays open in the Mailbox.';
      render();
      return;
    }
    chatSendAction(item, option.dataset.chatValue);
    return;
  }
  const retry = e.target.closest?.('[data-chat-retry]');
  if (retry) {
    const pending = chat.pending.find((item) => item.id === retry.dataset.chatRetry);
    if (pending) chatSend(pending);
  }
});

document.addEventListener('submit', (e) => {
  const id = e.target.dataset?.chatCardForm;
  if (id) {
    e.preventDefault();
    const record = chat.messages.find((item) => item.id === id);
    const text = (chat.drafts[id] || '').trim();
    if (record && text) chatSendAction(record, text);
    return;
  }
  if (!e.target.matches?.('[data-chat-compose]')) return;
  e.preventDefault();
  chatSend();
});

document.addEventListener('input', (e) => {
  const cardId = e.target.dataset?.chatCardDraft;
  if (cardId) { chat.drafts[cardId] = e.target.value; return; }
  if (!e.target.matches?.('[data-chat-draft]')) return;
  chat.draft = e.target.value;
  chatGrowField(e.target);
});

document.addEventListener('keydown', (e) => {
  // Arrow keys move through the chat list. Enter opens a row because every row is a button.
  const row = e.target.closest?.('[data-chat-open]');
  if (row) {
    const rows = [...$app.querySelectorAll('[data-chat-open]')];
    const index = rows.indexOf(row);
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : e.key === 'Home' ? -index : e.key === 'End' ? rows.length - 1 - index : 0;
    if (!step) return;
    e.preventDefault();
    rows[Math.min(rows.length - 1, Math.max(0, index + step))]?.focus();
    return;
  }
  // Escape goes back to the list. On a phone the Back button does the same.
  if (e.key === 'Escape' && chat.thread) { closeChat(); return; }
  if (!e.target.matches?.('[data-chat-draft]')) return;
  // Enter sends the message. Shift+Enter makes a new line.
  if (e.key !== 'Enter' || e.shiftKey) return;
  e.preventDefault();
  chatSend();
});

// ---------- Organization ----------
// A read-only chart from existing state: Owner, Boss, project orchestrators, and their workers.
// Pane titles, pane output, and preferred models are not facts about an agent, so the chart does not use them.

const orgOpen = new Set();
const NOT_REPORTED = 'Not reported';

// Plain is the default style. Cards is optional and only this browser remembers it.
const ORG_STYLE_KEY = 'herdr-boss.orgStyle';
function storedOrgStyle() {
  try { return localStorage.getItem(ORG_STYLE_KEY) === 'cards' ? 'cards' : 'plain'; } catch { return 'plain'; }
}
let orgStyle = storedOrgStyle();
function setOrgStyle(style) {
  orgStyle = style === 'cards' ? 'cards' : 'plain';
  try { localStorage.setItem(ORG_STYLE_KEY, orgStyle); } catch {}
}
// The Agents page has a Chart view (the organization chart) and a List view (the agent inventory).
// Chart is the default. The URL holds the current view, and only this browser remembers the last choice.
const AGENTS_VIEW_KEY = 'herdr-boss.agentsView';
function storedAgentsView() {
  try { return localStorage.getItem(AGENTS_VIEW_KEY) === 'list' ? 'list' : 'chart'; } catch { return 'chart'; }
}
function agentsViewMode() {
  const view = new URLSearchParams(location.search).get('view');
  return view === 'list' || view === 'chart' ? view : storedAgentsView();
}
function setAgentsView(view) {
  const next = view === 'list' ? 'list' : 'chart';
  try { localStorage.setItem(AGENTS_VIEW_KEY, next); } catch {}
  const url = new URL(location.href);
  url.searchParams.set('view', next);
  history.replaceState(null, '', `${url.pathname}${url.search}`);
}
const ORG_STATES = ['working', 'blocked', 'failed', 'idle', 'done'];
const HARNESS_MARK = {
  claude: '<svg viewBox="0 0 16 16"><path d="M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2"/></svg>',
  codex: '<svg viewBox="0 0 16 16"><path d="M8 1.5l5.6 3.25v6.5L8 14.5l-5.6-3.25v-6.5z"/><path d="M5.6 6.4L7.6 8l-2 1.6M8.6 10h2"/></svg>',
  opencode: '<svg viewBox="0 0 16 16"><path d="M5.5 2.5C3.6 2.5 4.2 7 2.5 8c1.7 1 1.1 5.5 3 5.5M10.5 2.5c1.9 0 1.3 4.5 3 5.5-1.7 1-1.1 5.5-3 5.5"/></svg>',
  pi: '<svg viewBox="0 0 16 16"><path d="M2.5 4.5h11M6 4.5v9M10 4.5v7c0 1.3.7 2 2 2"/></svg>',
  unknown: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5"/><path d="M6.1 6.3a1.9 1.9 0 1 1 2.7 1.7c-.5.3-.8.7-.8 1.3v.4M8 11.5v.5"/></svg>',
};
const ORG_BLOCKED_ICON = '<svg class="org-alert" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8l6.6 12H1.4z"/><path d="M8 6.2v3.6M8 11.6v.4"/></svg>';
const orgWorkersOpen = new Set();
// Motion: node ID to the time its reduced-motion highlight ends, and the newest event time already shown.
const orgFlash = new Map();
let orgEventMark = null;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const HANDOFF_OPEN = ['preparing', 'prepared', 'needs-inspection'];

// A successor is prepared only when the record is prepared, its source is the current role pane, and its pane is live.
function orgSuccessor(s, sourcePane) {
  if (!sourcePane) return null;
  const panes = s.herdr?.panes || [];
  const record = handoffRecords.find((x) => x.status === 'prepared' && x.sourcePane === sourcePane && x.newPane && panes.some((p) => p.id === x.newPane));
  return record ? { record, pane: panes.find((p) => p.id === record.newPane) } : null;
}

function orgHandover(s, sourcePane, risk) {
  const closing = handoffRecords.find((x) => x.status === 'active' && x.newPane === sourcePane && x.finish?.plannedAt && !x.finish.doneAt);
  if (closing) return `closing old orchestrator at ${new Date(closing.finish.plannedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  const records = handoffRecords.filter((x) => HANDOFF_OPEN.includes(x.status) && sourcePane && x.sourcePane === sourcePane);
  if (orgSuccessor(s, sourcePane)) return 'Successor prepared';
  if (records.some((x) => x.status === 'needs-inspection')) return 'Successor needs inspection';
  if (records.some((x) => x.status === 'preparing')) return 'Successor preparing';
  if (records.some((x) => x.status === 'prepared')) return 'Prepared record without a live successor pane';
  if (risk?.window) return `Handover needed · ${risk.window.usedPercent}% of ${risk.window.label || 'quota'}`;
  return 'No handover';
}

// Codex and Claude always use their own subscription, so their quota is known without a model. Other harnesses are not.
function orgQuotaWindow(s, kind) {
  if (!['codex', 'claude'].includes(kind)) return null;
  const q = (s.quotas || []).find((x) => x.provider === kind);
  if (!q || !hasQuotaData(q)) return null;
  return q.windows?.find((x) => x.key === 'secondary') || q.windows?.find((x) => !x.extra) || null;
}

// The Cards bar of a Codex or Claude pane. A stale row keeps its value. A missing or failed row shows as unavailable.
function orgQuotaMeter(s, kind) {
  if (!['codex', 'claude'].includes(kind)) return null;
  const w = orgQuotaWindow(s, kind);
  if (!w) return { unavailable: true };
  const q = s.quotas.find((x) => x.provider === kind);
  const thresholds = quotaThresholds(s, { warnPercent: 70, criticalPercent: 90 });
  return { ...w, ...thresholds, stale: q.stale === true, staleSince: q.staleSince };
}

function orgMeter(agent, quota) {
  if (quota.unavailable) return `<div class="org-quota-row"><div class="org-quota unavailable" role="img" aria-label="${esc(`${PROVIDERS[agent]} quota unavailable`)}"></div><span class="org-quota-note" aria-hidden="true">quota unavailable</span></div>`;
  const stale = quota.stale ? `quota from ${clock(quota.staleSince)}, the last probe failed` : '';
  const label = `${PROVIDERS[agent]} quota ${quota.usedPercent}% used${quota.label ? ` · ${quota.label}` : ''}${stale ? ` · ${stale}` : ''}`;
  const level = quota.stale ? '' : quota.usedPercent >= quota.criticalPercent ? 'crit' : quota.usedPercent >= quota.warnPercent ? 'warn' : '';
  return `<div class="org-quota${quota.stale ? ' stale' : ''}" role="img" aria-label="${esc(label)}"${stale ? ` title="${esc(stale)}"` : ''}><i class="${level}" style="width:${Math.max(0, Math.min(100, quota.usedPercent))}%"></i></div>`;
}

function orgQuota(s, kind) {
  const w = orgQuotaWindow(s, kind);
  return w ? `${PROVIDERS[kind]} ${w.usedPercent}% · ${w.label}` : NOT_REPORTED;
}

function orgSince(s, pane) {
  const since = s.paneSince?.[pane.id]?.since;
  return since ? dur((Date.now() - since) / 1000) : null;
}

// The published task that names this worker. The chart does not read a task from the pane title.
function orgWorkerTask(published, pane) {
  if (!pane.name) return null;
  return (published?.tasks || []).find((t) => t && t.worker === pane.name && !isDone(t)) || null;
}

function orgFacts(rows) {
  return `<dl class="org-facts">${rows.filter(Boolean).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v ?? NOT_REPORTED)}</dd></div>`).join('')}</dl>`;
}

function orgNode({ id, role, name, status, summary, facts, className = '', thread = null, agent, quota = null, avatar = null }) {
  const open = orgOpen.has(id);
  const domId = `org-detail-${id.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  const cards = orgStyle === 'cards';
  const state = ORG_STATES.includes(status) ? status : 'unknown';
  const flash = (orgFlash.get(id) || 0) > Date.now() ? ' org-flash' : '';
  // An agent node has a harness; the Owner node has none and keeps only its dot.
  const kind = agent === undefined ? null : HARNESS_MARK[agent] ? agent : 'unknown';
  const mark = cards && kind ? `<span class="org-mark" title="${esc(agent || 'Unknown harness')}" aria-hidden="true">${HARNESS_MARK[kind]}</span>` : '';
  // The Boss and each project card show the avatar of that thread.
  const face = cards && avatar ? avatarSlot(avatar.slug, { title: avatarTitle(avatar.slug, avatar.title), size: 36 }) : '';
  const alert = cards && state === 'blocked' ? ORG_BLOCKED_ICON : '';
  const meter = cards && quota ? orgMeter(agent, quota) : '';
  return `<article class="org-node ${esc(className)} org-state-${state}${flash}" data-org-id="${esc(id)}"><div class="org-node-head">${face}${mark}<span class="st ${esc(status || 'unknown')}" aria-hidden="true"></span><span class="pill">${esc(role)}</span><strong>${esc(name)}</strong>${alert}</div>
    ${meter}<p class="org-node-summary">${summary.filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join('')}</p>
    <div class="org-actions"><button type="button" class="quiet org-toggle" data-org-node="${esc(id)}" aria-expanded="${open}" aria-controls="${domId}">${open ? 'Hide details' : 'Details'}<span class="visually-hidden"> for ${esc(name)}</span></button>${thread ? `<button type="button" class="quiet org-messages" data-messages-thread="${esc(thread)}" data-messages-name="${esc(name)}">Messages<span class="visually-hidden"> for ${esc(name)}</span></button>` : ''}</div>
    <div class="org-detail" id="${domId}" ${open ? '' : 'hidden'}>${orgFacts(facts)}</div></article>`;
}

function orgAgentFacts(s, pane, extra = []) {
  return [
    ['Pane', pane.id],
    ['Harness', pane.agent || NOT_REPORTED],
    ['Model', NOT_REPORTED],
    ['State', pane.status || NOT_REPORTED],
    ['In state for', orgSince(s, pane) || NOT_REPORTED],
    ...extra,
  ];
}

// On a phone, a worker list starts as a count button. The button expands the list.
function orgWorkers(s, panes, published, ownerId) {
  if (!panes.length) return '<p class="org-empty">No workers.</p>';
  const listId = `org-workers-${ownerId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  const open = !isPhone() || orgWorkersOpen.has(ownerId);
  const count = `${panes.length} worker${panes.length === 1 ? '' : 's'}`;
  const toggle = isPhone() ? `<button type="button" class="quiet org-worker-count" data-org-workers="${esc(ownerId)}" aria-expanded="${open}" aria-controls="${listId}">${open ? `Hide ${count}` : `Show ${count}`}</button>` : '';
  return `${toggle}<ul class="org-workers" id="${listId}" ${open ? '' : 'hidden'}>${panes.map((pane) => {
    const task = orgWorkerTask(published, pane);
    const name = pane.name || pane.agent || pane.id;
    return `<li>${orgNode({
      id: `${ownerId}:${pane.id}`, role: pane.label || 'worker', name, status: pane.status, className: 'org-worker', agent: pane.agent || null, quota: orgQuotaMeter(s, pane.agent),
      summary: [pane.agent || NOT_REPORTED, pane.status || NOT_REPORTED, task?.id ? `Task ${task.id}` : 'Task not reported'],
      facts: orgAgentFacts(s, pane, [['Agent name', pane.name || NOT_REPORTED], ['Task ID', task?.id || NOT_REPORTED], ['Task title', task?.title || NOT_REPORTED], ['Task status', task ? STATUS_LABEL[task.status || 'todo'] || task.status : NOT_REPORTED]]),
    })}</li>`;
  }).join('')}</ul>`;
}

function orgReserve(s, successor, ownerId) {
  if (!successor) return '';
  const { record, pane } = successor;
  return `<div class="org-reserve">${orgNode({
    id: `${ownerId}:reserve`, role: 'reserve', name: `Successor · ${record.toKind || pane.agent || 'agent'}`, status: pane.status, className: 'org-reserve-node', agent: pane.agent || record.toKind || null,
    summary: [record.toKind || NOT_REPORTED, pane.status || NOT_REPORTED, record.automatic ? 'Automatic' : 'Awaiting review'],
    facts: orgAgentFacts(s, pane, [['Start model', record.model || NOT_REPORTED], ['Prepared', record.preparedAt ? clock(record.preparedAt) : NOT_REPORTED], ['Reported ready', record.readyAt ? clock(record.readyAt) : 'No']]).filter(([k]) => k !== 'Model'),
  })}</div>`;
}

function organizationChart(s) {
  const panes = s.herdr?.panes || [];
  const agents = panes.filter((p) => p.agent);
  // A successor of an active handoff record and a previous orchestrator are not workers. A successor shows as a reserve only after the prepared and live checks.
  const successorPanes = new Set(handoffRecords.filter((x) => HANDOFF_OPEN.includes(x.status) && x.newPane).map((x) => x.newPane));
  const PREVIOUS_ROLES = ['orch previous', 'boss previous'];
  const workersIn = (workspace) => agents.filter((p) => p.workspace === workspace && !p.orch && p.label !== 'boss' && !PREVIOUS_ROLES.includes(p.label) && !successorPanes.has(p.id));
  const owner = s.machine?.limits?.owner;
  const ownerText = owner === 'present' ? 'At the Mac' : owner === 'away' ? 'Away' : NOT_REPORTED;
  const ownerNode = orgNode({ id: 'owner', role: 'owner', name: 'Owner', status: owner === 'present' ? 'done' : owner === 'away' ? 'idle' : 'unknown', className: 'org-owner', summary: [ownerText], facts: [['Presence', ownerText], ['Source', 'Machine idle time']] });

  const boss = panes.find((p) => p.label === 'boss');
  const bossRisk = s.control?.bossHandoff;
  const bossSuccessor = boss ? orgSuccessor(s, boss.id) : null;
  const bossNode = boss ? orgNode({
    id: 'boss', role: 'boss', name: 'Boss', status: boss.status, className: 'org-boss', thread: 'boss', agent: boss.agent || null, quota: orgQuotaMeter(s, boss.agent), avatar: { slug: 'boss', title: 'Boss' },
    summary: [boss.agent || 'No agent', boss.status || NOT_REPORTED, orgHandover(s, boss.id, bossRisk)],
    facts: orgAgentFacts(s, boss, [['Workspace', boss.workspaceLabel || boss.workspace], ['Quota use', orgQuota(s, boss.agent)], ['Handover', orgHandover(s, boss.id, bossRisk)]]),
  }) : '<article class="org-node org-boss org-missing"><strong>Boss</strong><p class="org-node-summary"><span>No pane is labeled <code>boss</code>.</span></p></article>';
  const bossWorkers = boss ? workersIn(boss.workspace) : [];

  const live = s.control?.projects || {};
  const projects = projectSlugs(s).map((slug) => live[slug]).filter(Boolean);
  const hidden = (s.control?.workspaces || []).filter((w) => w.excluded && !w.boss).length;
  const columns = projects.map((p) => {
    const published = (s.projects || []).find((x) => x.slug === p.slug);
    const orch = p.orch && panes.find((x) => x.id === p.orch.pane);
    const risk = (s.control?.handoffs || []).find((h) => h.project === p.slug);
    const current = (published?.tasks || []).filter((t) => t && t.title && t.status === 'doing');
    const taskText = current.length ? `${current[0].id ? `${current[0].id} · ` : ''}${current[0].title}${current.length > 1 ? ` (+${current.length - 1} more)` : ''}` : NOT_REPORTED;
    const slots = `${p.running} / ${p.slots} slots · ${Math.round(p.share || 0)}% share`;
    const handover = orgHandover(s, p.orch?.pane, risk);
    const mode = p.effectiveMode === 'paused' ? 'Paused' : p.idle ? 'Idle' : 'Active';
    const node = orgNode({
      id: `project:${p.slug}`, role: 'orch', name: p.label, status: orch?.status || (p.orch ? p.orch.status : 'unknown'), thread: p.slug, agent: orch?.agent || null, quota: orgQuotaMeter(s, orch?.agent), avatar: { slug: p.slug, title: p.label },
      summary: [orch ? `${orch.agent || 'No agent'} · ${orch.status || NOT_REPORTED}` : 'No orchestrator', slots],
      facts: [
        ['Project', p.label],
        ['Mode', mode],
        ['Orchestrator pane', p.orch?.pane || 'None labeled orch'],
        ['Harness', orch?.agent || NOT_REPORTED],
        ['Model', NOT_REPORTED],
        ['State', orch?.status || NOT_REPORTED],
        ['In state for', orch ? orgSince(s, orch) || NOT_REPORTED : NOT_REPORTED],
        ['Current task', taskText],
        ['Worker slots', slots],
        ['Handover', handover],
        ['Published status', published ? `${published.status || published.phase || 'Published'} · updated ${ago(published.updated)}` : 'Not published'],
      ],
    });
    return `<section class="org-column" aria-label="${esc(p.label)}"><div class="org-lead">${node}${orgReserve(s, orgSuccessor(s, p.orch?.pane), `project:${p.slug}`)}</div><p class="org-current"><span>Current task</span> ${esc(taskText)}</p>${orgWorkers(s, workersIn(p.workspace), published, `project:${p.slug}`)}<a class="org-link" href="/projects/${esc(p.slug)}">Project details →</a></section>`;
  }).join('');

  return [
    `<section class="org-chart${orgStyle === 'cards' ? ' org-cards' : ''}" aria-label="Organization chart">
      <ol class="org-tier" aria-label="Owner"><li>${ownerNode}</li></ol>
      <ol class="org-tier" aria-label="Boss"><li><div class="org-lead">${bossNode}${orgReserve(s, bossSuccessor, 'boss')}</div>${boss ? `<div class="org-boss-workers"><h2>Boss workspace workers <span class="sub">${bossWorkers.length}</span></h2>${orgWorkers(s, bossWorkers, null, 'boss')}</div>` : ''}</li></ol>
      <div class="org-tier org-projects" aria-label="Projects">${columns || '<p class="calm-state">No open projects.</p>'}</div>
    </section>`,
    `<p class="org-note">${hidden ? `${hidden} workspace${hidden === 1 ? ' is' : 's are'} marked not a project and ${hidden === 1 ? 'is' : 'are'} not shown. ` : ''}Herdr Boss does not receive the model of a running agent, so the chart shows <b>Not reported</b>.</p>`,
  ].join('');
}

// ---------- Organization motion ----------
// A new Owner message event or a worker report notice draws a short line between two nodes. The page reads only the events in the state.

// The chart node of an orchestrator or Boss pane.
function orgLeadId(s, paneId) {
  const project = Object.values(s.control?.projects || {}).find((p) => p.orch?.pane === paneId);
  if (project) return `project:${project.slug}`;
  return (s.herdr?.panes || []).some((p) => p.id === paneId && p.label === 'boss') ? 'boss' : null;
}

function orgEventLinks(s, events) {
  const panes = s.herdr?.panes || [];
  const links = [];
  for (const e of events) {
    if (e.type === 'message' && e.thread && !e.failed) links.push(['owner', e.thread === 'boss' ? 'boss' : `project:${e.thread}`]);
    if (e.type !== 'push' || !e.pane) continue;
    const lead = orgLeadId(s, e.pane);
    const orch = panes.find((p) => p.id === e.pane);
    if (!lead || !orch) continue;
    for (const title of e.titles || []) {
      const name = /^Worker (.+) wrote its report$/.exec(title)?.[1];
      const worker = name && panes.find((p) => p.workspace === orch.workspace && p.id !== orch.id && (p.name || p.agent) === name);
      if (worker) links.push([`${lead}:${worker.id}`, lead]);
    }
  }
  return links.slice(-6);
}

// A hidden worker node, such as one in a collapsed phone list, uses its orchestrator node.
function orgNodeElement(id) {
  const find = (key) => [...document.querySelectorAll('[data-org-id]')].find((el) => el.dataset.orgId === key && el.getClientRects().length);
  const lead = id.startsWith('boss:') || id.split(':').length > 2 ? id.slice(0, id.lastIndexOf(':')) : null;
  return find(id) || (lead && find(lead));
}

function orgEdge(a, b) {
  const x = (r) => r.left + r.width / 2 + scrollX;
  if (a.top > b.bottom) return [x(a), a.top + scrollY, x(b), b.bottom + scrollY];
  if (a.bottom < b.top) return [x(a), a.bottom + scrollY, x(b), b.top + scrollY];
  return [x(a), a.top + a.height / 2 + scrollY, x(b), b.top + b.height / 2 + scrollY];
}

function orgDrawLink(from, to) {
  const [x1, y1, x2, y2] = orgEdge(from.getBoundingClientRect(), to.getBoundingClientRect());
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'org-motion');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', document.documentElement.scrollWidth);
  svg.setAttribute('height', document.documentElement.scrollHeight);
  const line = document.createElementNS(ns, 'line');
  for (const [k, v] of Object.entries({ x1, y1, x2, y2 })) line.setAttribute(k, v);
  const dot = document.createElementNS(ns, 'circle');
  dot.setAttribute('r', 4);
  svg.append(line, dot);
  document.body.append(svg);
  const length = Math.hypot(x2 - x1, y2 - y1) || 1;
  line.style.strokeDasharray = length;
  line.animate([{ strokeDashoffset: length }, { strokeDashoffset: 0 }], { duration: 400, easing: 'ease-out', fill: 'forwards' });
  dot.animate([{ transform: `translate(${x1}px, ${y1}px)` }, { transform: `translate(${x2}px, ${y2}px)` }], { duration: 1000, easing: 'ease-in-out', fill: 'forwards' });
  svg.animate([{ opacity: 1, offset: 0.8 }, { opacity: 0 }], { duration: 1100 }).finished.then(() => svg.remove(), () => svg.remove());
}

// Reduced motion: a highlight on both nodes for 1 second, with no movement.
function orgFlashNodes(ids) {
  const until = Date.now() + 1000;
  for (const id of ids) {
    orgFlash.set(id, until);
    orgNodeElement(id)?.classList.add('org-flash');
  }
  setTimeout(() => {
    for (const id of ids) if ((orgFlash.get(id) || 0) <= Date.now()) {
      orgFlash.delete(id);
      for (const el of document.querySelectorAll('.org-flash')) if (el.dataset.orgId === id) el.classList.remove('org-flash');
    }
  }, 1000);
}

function orgMotion(s) {
  const events = s.events || [];
  const newest = events.at(-1)?.at || '';
  // The first view of the page records the newest event and replays nothing.
  if (orgEventMark === null) { orgEventMark = newest; return; }
  const fresh = events.filter((e) => e.at > orgEventMark);
  if (newest > orgEventMark) orgEventMark = newest;
  if (orgStyle !== 'cards' || !fresh.length) return;
  for (const [fromId, toId] of orgEventLinks(s, fresh)) {
    const from = orgNodeElement(fromId);
    const to = orgNodeElement(toId);
    if (!from || !to || from === to) continue;
    if (reducedMotion.matches) orgFlashNodes([from.dataset.orgId, to.dataset.orgId]);
    else orgDrawLink(from, to);
  }
}

function projectsView(s, slug) {
  // A link to a published project opens it also when its workspace is closed, for example a link from the Board.
  const selected = slug && (projectSlugs(s).includes(slug) || (s.projects || []).some((p) => p.slug === slug)) ? slug : defaultProject(s);
  return [
    '<header class="page-intro"><div><h1>Projects</h1><p>Select a project to inspect its status, work, agents, and orchestrator handover.</p></div></header>',
    allocationSummary(s),
    projectSelector(s, selected),
    selected ? `<div class="project-detail" id="project-detail">${project(s, selected)}</div>` : '',
  ].join('');
}

// ---------- Board page: one kanban across all projects ----------
// The page uses the task model of the project board (board.js). The filters, the grouping, and the closed swimlanes are remembered
// in this browser. The search stays in memory. On a phone the page is one mixed board with a column tab bar and a project chip row.

const FLEET_KEY = 'herdr-boss.board';
const FLEET_SLUG = '~board';
const WHO_LABEL = { owner: 'Waits for the Owner', worker: 'Has a worker' };
const fleet = (() => {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(FLEET_KEY)) || {}; } catch { saved = {}; }
  const text = (value) => (typeof value === 'string' ? value : '');
  return {
    group: saved.group === 'mixed' ? 'mixed' : 'project',
    closed: saved.closed && typeof saved.closed === 'object' && !Array.isArray(saved.closed) ? saved.closed : {},
    project: text(saved.project), who: text(saved.who), state: FLOW.includes(saved.state) ? saved.state : '', query: '',
  };
})();
function saveFleet() {
  const { group, closed, project, who, state } = fleet;
  try { localStorage.setItem(FLEET_KEY, JSON.stringify({ group, closed, project, who, state })); } catch { /* Storage can be off. */ }
}

// The published projects with tasks, with the display name of the allocation.
function fleetProjects(s) {
  return (s.projects || []).filter((p) => p?.slug && Array.isArray(p.tasks) && p.tasks.length)
    .map((p) => ({ ...p, label: avatarTitle(p.slug, p.project || p.slug) }));
}

function fleetChip(item) {
  return `<a class="proj-chip" href="/projects/${encodeURIComponent(item.slug)}" title="Open ${esc(item.label)}">${avatarSlot(item.slug, { title: item.label, size: 20 })}<span>${esc(item.label)}</span></a>`;
}

function fleetTaskUrl(slug, id) {
  return `/projects/${encodeURIComponent(slug)}?task=${encodeURIComponent(id)}`;
}

// What a Blocked card waits on. A blocker task shows its ID and title and links to it on its project page.
function fleetReason(r, item) {
  const { task: t, slug, map } = item;
  if (r.kind === 'task' && r.id == null) return 'a task that the status does not name';
  if (r.kind === 'task') {
    const blocker = map.get(r.id);
    if (!r.known) return `<span class="mono" title="This task is not in the published status">${esc(r.id)} (outside)</span>`;
    return `<a class="wait-link" href="${fleetTaskUrl(slug, r.id)}"><span class="mono">${esc(r.id)}</span> ${esc(blocker?.title || '')}</a>`;
  }
  if (r.kind === 'unstated') return 'a reason that the status does not state';
  const party = r.kind === 'owner' && t.mailboxId
    ? `<a href="/mailbox?thread=${encodeURIComponent(slug)}&conversation=${encodeURIComponent(t.mailboxId)}">the Owner</a>`
    : esc(WAIT_PARTY[r.kind] || r.kind);
  return `${party}${r.ask ? `: <q>${esc(r.ask)}</q>` : ''}`;
}

function fleetCard(item, { chip, now }) {
  const { task: t, state, slug } = item;
  const id = t.id != null ? String(t.id) : '';
  const reasons = blockReasons(t, item.map);
  const wait = reasons.length ? `<p class="card-wait">Waits on ${reasons.map((r) => fleetReason(r, item)).join(', ')}</p>` : '';
  const w = t.worker;
  const elapsed = state === 'doing' ? elapsedText(w?.startedAt, now) : '';
  const worker = w ? `<p class="card-worker"><span class="mono">${esc(w.name)}</span>${w.model ? ` · ${esc(w.model)}` : ''}${elapsed ? ` · <span class="num" title="Elapsed time">${esc(elapsed)}</span>` : ''}</p>` : '';
  const title = id
    ? `<a class="card-title" href="${fleetTaskUrl(slug, id)}" title="Open ${esc(id)} on the ${esc(item.label)} board">${esc(t.title)}</a>`
    : `<span class="card-title">${esc(t.title)}</span>`;
  return `<li class="card kb-card st-${state}${item.onPath ? ' on-path' : ''}" data-key="task:${esc(item.key)}" id="fleet-${esc(domPart(item.key))}">`
    + `<div class="card-top">${chip ? fleetChip(item) : '<span class="card-dot" aria-hidden="true"></span>'}<span class="card-id mono">${esc(id)}</span>${item.onPath ? '<span class="card-flag" title="On the critical path of the project">path</span>' : ''}</div>`
    + `${title}${wait}${worker}</li>`;
}

const FLEET_EMPTY = { blocked: 'Nothing waits.', ready: 'No task is ready.', doing: 'No worker runs.', review: 'Nothing to review.', done: 'Nothing done in 24 h.' };
const fleetColLabel = (k) => (k === 'done' ? 'Done · 24 h' : FLOW_LABEL[k]);

function fleetList(list, k, ctx) {
  return list.length ? `<ol class="board-list">${list.map((item) => fleetCard(item, ctx)).join('')}</ol>` : `<p class="board-empty">${FLEET_EMPTY[k]}</p>`;
}

// Counts per column and a Needs the Owner count. A column count selects the state filter; select it again to clear the filter.
function fleetCounts(counts, s) {
  const owner = s.mailbox?.needsAction ?? s.mailbox?.open ?? 0;
  const cells = FLOW.map((k) => `<button type="button" class="kb-count st-${k}" data-fleet-state="${k}" aria-pressed="${fleet.state === k}" title="${fleet.state === k ? 'Show all states' : `Show only ${FLOW_LABEL[k]}`}"><span class="card-dot" aria-hidden="true"></span><span class="kb-count-label">${fleetColLabel(k)}</span><span class="num">${counts[k]}</span></button>`).join('');
  return `<div class="kb-counts" role="group" aria-label="Tasks per column">${cells}<a class="kb-owner${owner ? ' has-items' : ''}" href="/mailbox?folder=needs-you"><span class="num">${owner}</span><span>Needs the Owner</span></a></div>`;
}

// One bar per project: the open tasks of each state and the done tasks of 24 hours, on one scale for all projects.
// Each bar is a project filter. The column counts above name the colors.
function fleetProjectBars(projects, items) {
  const rows = projects.map((p) => {
    const own = items.filter((i) => i.slug === p.slug);
    const counts = Object.fromEntries(FLOW.map((k) => [k, own.filter((i) => i.state === k).length]));
    return { p, counts, total: own.length };
  }).filter((r) => r.total);
  const max = Math.max(1, ...rows.map((r) => r.total));
  const body = rows.map(({ p, counts, total }) => {
    const parts = FLOW.filter((k) => counts[k]).map((k) => `${counts[k]} ${FLOW_LABEL[k]}`).join(', ');
    const segs = FLOW.filter((k) => counts[k]).map((k) => `<i class="st-${k}" style="flex-grow:${counts[k]}" title="${esc(`${p.label}: ${counts[k]} ${fleetColLabel(k)}`)}"></i>`).join('');
    return `<button type="button" class="kb-bar-row" data-key="bar:${esc(p.slug)}" data-fleet-project="${esc(p.slug)}" aria-pressed="${fleet.project === p.slug}" aria-label="${esc(`${p.label}: ${parts}. ${fleet.project === p.slug ? 'Show all projects' : 'Show only this project'}`)}">`
      + `${avatarSlot(p.slug, { title: p.label, size: 20 })}<span class="kb-bar-name">${esc(p.label)}</span>`
      + `<span class="kb-bar-track"><span class="kb-bar" style="width:${(total / max) * 100}%">${segs}</span></span><span class="num">${total}</span></button>`;
  }).join('');
  return rows.length ? `<div class="kb-bars" role="group" aria-label="Tasks per project">${body}</div>` : '';
}

// The phone replaces the swimlanes with a row of project chips.
function fleetProjectChips(projects, items) {
  const open = (slug) => items.filter((i) => (!slug || i.slug === slug) && i.state !== 'done').length;
  const chip = (slug, label, avatar) => `<button type="button" class="kb-chip" data-key="chip:${esc(slug || '*')}" data-fleet-project="${esc(slug)}" aria-pressed="${fleet.project === slug}">${avatar}<span>${esc(label)}</span><span class="num">${open(slug)}</span></button>`;
  return `<div class="kb-chips" role="group" aria-label="Project filter">${chip('', 'All', '')}${projects.filter((p) => items.some((i) => i.slug === p.slug)).map((p) => chip(p.slug, p.label, avatarSlot(p.slug, { title: p.label, size: 20 }))).join('')}</div>`;
}

function fleetToolbar(projects, items, phone) {
  const who = fleetWho(items);
  const option = (value, label, current) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`;
  const whoOptions = option('', 'All kinds', fleet.who) + option('owner', WHO_LABEL.owner, fleet.who) + option('worker', WHO_LABEL.worker, fleet.who)
    + (who.kinds.length ? `<optgroup label="Worker harness">${who.kinds.map((k) => option(`kind:${k}`, HARNESS_NAMES[k] || k, fleet.who)).join('')}</optgroup>` : '')
    + (who.models.length ? `<optgroup label="Worker model">${who.models.map((m) => option(`model:${m}`, m, fleet.who)).join('')}</optgroup>` : '');
  const project = phone ? '' : `<label class="kb-field"><span>Project</span><select data-fleet-filter="project">${option('', 'All projects', fleet.project)}${projects.map((p) => option(p.slug, p.label, fleet.project)).join('')}</select></label>`;
  const state = phone ? '' : `<label class="kb-field"><span>State</span><select data-fleet-filter="state">${option('', 'All states', fleet.state)}${FLOW.map((k) => option(k, fleetColLabel(k), fleet.state)).join('')}</select></label>`;
  const active = fleet.project || fleet.who || (fleet.state && !phone) || fleet.query;
  return `<div class="kb-toolbar" role="search" aria-label="Filter the board">`
    + `<label class="kb-search"><span class="visually-hidden">Search tasks</span><input type="search" id="fleet-search" data-fleet-query value="${esc(fleet.query)}" placeholder="Search tasks (press /)" autocomplete="off" spellcheck="false"></label>`
    + `${project}<label class="kb-field"><span>Kind</span><select data-fleet-filter="who">${whoOptions}</select></label>${state}`
    + `<button type="button" class="kb-clear" data-fleet-clear${active ? '' : ' hidden'}>Clear filters</button></div>`;
}

function boardView(s) {
  const now = Date.now();
  const phone = isPhone();
  const projects = fleetProjects(s);
  const all = fleetItems(projects, { now });
  if (fleet.project && !projects.some((p) => p.slug === fleet.project)) fleet.project = '';
  // A stored harness or model that no task uses now would hide every card behind a choice that the select cannot show.
  const kinds = fleetWho(all);
  if (/^kind:/.test(fleet.who) && !kinds.kinds.includes(fleet.who.slice(5))) fleet.who = '';
  if (/^model:/.test(fleet.who) && !kinds.models.includes(fleet.who.slice(6))) fleet.who = '';
  const group = phone || !projects.length ? '' : `<div class="kb-group" role="group" aria-label="Group the board"><button type="button" data-fleet-group="project" aria-pressed="${fleet.group === 'project'}">By project</button><button type="button" data-fleet-group="mixed" aria-pressed="${fleet.group === 'mixed'}">One board</button></div>`;
  const intro = `<header class="page-intro kb-intro"><div><h1>Board</h1><p>Open work of all projects in the flow columns, and the tasks done in the last 24 hours.</p></div>${group}</header>`;
  if (!projects.length) return `${intro}<div class="calm-state">No project publishes tasks yet. Orchestrators publish them with <code>herdr-boss publish</code>.</div>`;
  // The phone shows the state as tabs, so its state filter is the tab and not a filter.
  const filtered = fleetFilter(all, { ...fleet, state: phone ? '' : fleet.state });
  const board = fleetColumns(filtered);
  const summary = fleetColumns(fleetFilter(all, { ...fleet, state: '' })).counts;
  const tools = `${fleetToolbar(projects, all, phone)}${phone ? fleetProjectChips(projects, fleetFilter(all, { ...fleet, project: '', state: '' })) : ''}`;
  const strip = `<section class="kb-strip" aria-label="Summary and filters"><div class="kb-main">${fleetCounts(summary, s)}${tools}</div>${phone ? '' : fleetProjectBars(projects, fleetFilter(all, { ...fleet, project: '', state: '' }))}</section>`;
  const empty = !filtered.length ? '<p class="kb-none" role="status">No task matches the filters. <button type="button" class="board-more" data-fleet-clear>Clear filters</button></p>' : '';
  const cols = phone || !fleet.state ? FLOW : [fleet.state];
  let body;
  if (phone || fleet.group === 'mixed') {
    const view = projectView(FLEET_SLUG);
    const active = boardActiveColumn(view, board.counts);
    const tabs = phone ? `<div class="board-tabs" role="tablist" aria-label="Board columns">${FLOW.map((k) => `<button type="button" role="tab" class="board-tab st-${k}" data-board-tab="${k}" data-slug="${FLEET_SLUG}" aria-selected="${k === active}" aria-controls="fleet-col-${k}" tabindex="${k === active ? 0 : -1}"><span class="card-dot" aria-hidden="true"></span><span class="tab-label">${FLOW_LABEL[k]}</span><span class="num">${board.counts[k]}</span></button>`).join('')}</div>` : '';
    const sections = cols.map((k) => `<section class="board-col st-${k}" data-key="col:${k}" data-col="${k}" id="fleet-col-${k}"${phone ? ' role="tabpanel"' : ''} aria-label="${fleetColLabel(k)}, ${board.counts[k]}"><h3><span class="card-dot" aria-hidden="true"></span>${fleetColLabel(k)}<span class="num">${board.counts[k]}</span></h3>${fleetList(board.columns[k], k, { chip: true, now })}</section>`).join('');
    body = `<div class="board kb-board" data-key="fleet:mixed">${tabs}<div class="board-cols kb-cols" data-board-cols="${FLEET_SLUG}" data-keep-attrs="style" style="--cols:${cols.length}">${sections}</div></div>`;
  } else {
    const head = `<div class="kb-head" style="--cols:${cols.length}" aria-hidden="true">${cols.map((k) => `<span class="st-${k}"><span class="card-dot"></span>${fleetColLabel(k)}<span class="num">${board.counts[k]}</span></span>`).join('')}</div>`;
    const lanes = projects.map((p) => {
      const own = filtered.filter((i) => i.slug === p.slug);
      if (!own.length) return '';
      const lane = fleetColumns(own);
      const open = !fleet.closed[p.slug];
      const mini = FLOW.filter((k) => lane.counts[k]).map((k) => `<span class="kb-mini st-${k}" title="${lane.counts[k]} ${fleetColLabel(k)}"><span class="card-dot" aria-hidden="true"></span><span class="num">${lane.counts[k]}</span><span class="visually-hidden"> ${fleetColLabel(k)}</span></span>`).join('');
      const cells = cols.map((k) => `<div class="kb-cell st-${k}" data-key="col:${k}" role="group" aria-label="${esc(`${p.label}, ${fleetColLabel(k)}, ${lane.counts[k]}`)}">${lane.columns[k].length ? `<ol class="board-list">${lane.columns[k].map((item) => fleetCard(item, { chip: false, now })).join('')}</ol>` : ''}</div>`).join('');
      return `<details class="kb-lane" data-key="lane:${esc(p.slug)}" data-fleet-lane="${esc(p.slug)}"${open ? ' open' : ''}><summary>${avatarSlot(p.slug, { title: p.label, size: 20 })}<span class="kb-lane-name">${esc(p.label)}</span><span class="kb-minis">${mini}</span><a class="kb-lane-open" href="/projects/${encodeURIComponent(p.slug)}">Project page</a><span class="fold-chevron" aria-hidden="true"></span></summary><div class="kb-lane-cols" style="--cols:${cols.length}">${cells}</div></details>`;
    }).join('');
    body = `<div class="kb-lanes" data-key="fleet:lanes">${head}${lanes}</div>`;
  }
  return `${intro}${strip}${empty}${body}`;
}

// Sticky Board parts sit below the top bar. The top bar wraps on a narrow window, so the page measures its height.
function syncTopHeight() {
  const height = `${document.querySelector('.top')?.offsetHeight || 0}px`;
  if (document.documentElement.style.getPropertyValue('--top-h') !== height) document.documentElement.style.setProperty('--top-h', height);
}
window.addEventListener('resize', syncTopHeight);

function setFleet(change) {
  Object.assign(fleet, change);
  saveFleet();
  lastRender = '';
  render();
}

document.addEventListener('click', (e) => {
  if (location.pathname !== '/board') return;
  const state = e.target.closest?.('[data-fleet-state]');
  if (state) { setFleet({ state: fleet.state === state.dataset.fleetState ? '' : state.dataset.fleetState }); if (isPhone() && fleet.state) showBoardColumn(FLEET_SLUG, fleet.state); return; }
  const project = e.target.closest?.('[data-fleet-project]');
  if (project) { const slug = project.dataset.fleetProject; setFleet({ project: slug && fleet.project === slug ? '' : slug }); return; }
  const group = e.target.closest?.('[data-fleet-group]');
  if (group) { setFleet({ group: group.dataset.fleetGroup }); return; }
  if (e.target.closest?.('[data-fleet-clear]')) {
    setFleet({ project: '', who: '', state: '', query: '' });
    document.getElementById('fleet-search')?.focus();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || location.pathname !== '/board' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  const search = document.getElementById('fleet-search');
  if (!search) return;
  e.preventDefault();
  search.focus();
  search.select();
});
document.addEventListener('change', (e) => {
  const field = e.target.dataset?.fleetFilter;
  if (field) setFleet({ [field]: e.target.value });
});
// The search renders 150 ms after the last key, not on each key.
let fleetQueryTimer = null;
document.addEventListener('input', (e) => {
  if (e.target.dataset?.fleetQuery == null) return;
  fleet.query = e.target.value;
  clearTimeout(fleetQueryTimer);
  fleetQueryTimer = setTimeout(() => {
    fleetQueryTimer = null;
    if (location.pathname !== '/board') return;
    lastRender = '';
    render();
  }, 150);
});
document.addEventListener('toggle', (e) => {
  const slug = e.target.dataset?.fleetLane;
  if (slug == null) return;
  if (e.target.open) delete fleet.closed[slug];
  else fleet.closed[slug] = true;
  saveFleet();
}, true);

function logsView(s) {
  return [
    '<header class="page-intro"><div><h1>Logs &amp; guidance</h1><p>Current instructions sent to orchestrators and recent Boss activity.</p></div></header>',
    `<div class="notice-status"><strong>Automatic orchestrator notices: ${s.push ? 'on' : 'off'}</strong><span>${s.push ? 'HerdrBoss can prompt idle orchestrators about resource issues.' : 'HerdrBoss is collecting status without prompting orchestrators.'}</span></div>`,
    rulesBlock(s),
    `<section id="events"><h2>Activity log</h2>${eventsBlock(s)}</section>`,
  ].join('');
}

function usageBlock() {
  const rows = Object.entries(usage?.byProject || {});
  const runs = rows.reduce((n, [, x]) => n + x.runs, 0);
  const measured = rows.reduce((n, [, x]) => n + x.measuredRuns, 0);
  const minutes = rows.reduce((n, [, x]) => n + x.workMinutes, 0);
  return `<section id="usage"><div class="section-head"><h2>Work recorded</h2><span>Measured runs are a subset of recorded runs</span></div><div class="usage-metrics"><div><strong>${runs}</strong><span>worker runs</span></div><div><strong>${measured} / ${runs}</strong><span>with token counts</span></div><div><strong>${Math.round(minutes)}</strong><span>work minutes</span></div></div>${rows.length ? `<div class="fleet-table-wrap"><table class="fleet-table"><thead><tr><th>Project</th><th>Runs</th><th>Measured</th><th>Input</th><th>Output</th><th>Work time</th></tr></thead><tbody>${rows.map(([slug, x]) => `<tr><td data-label="Project"><a href="/projects/${esc(slug)}"><strong>${esc(state.control?.projects?.[slug]?.label || slug)}</strong></a></td><td class="mono" data-label="Runs">${x.runs}</td><td class="mono" data-label="Measured">${x.measuredRuns} / ${x.runs}</td><td class="mono" data-label="Input">${x.inputTokens.toLocaleString()}</td><td class="mono" data-label="Output">${x.outputTokens.toLocaleString()}</td><td class="mono" data-label="Work time">${Math.round(x.workMinutes)} min</td></tr>`).join('')}</tbody></table></div>` : '<div class="calm-state">No worker runs have been recorded yet. Orchestrators add them with <code>herdr-boss worker collect --record</code>.</div>'}</section>`;
}

function providerUsageBlock() {
  const rows = Object.entries(usage?.byProvider || {});
  return `<section><div class="section-head"><h2>By provider</h2><span>Recorded work, not subscription balance</span></div>${rows.length ? `<div class="fleet-table-wrap"><table class="fleet-table"><thead><tr><th>Provider</th><th>Runs</th><th>Measured</th><th>Input</th><th>Output</th><th>Work time</th></tr></thead><tbody>${rows.map(([provider, x]) => `<tr><td data-label="Provider"><strong>${esc(PROVIDERS[provider] || provider)}</strong></td><td class="mono" data-label="Runs">${x.runs}</td><td class="mono" data-label="Measured">${x.measuredRuns} / ${x.runs}</td><td class="mono" data-label="Input">${x.inputTokens.toLocaleString()}</td><td class="mono" data-label="Output">${x.outputTokens.toLocaleString()}</td><td class="mono" data-label="Work time">${Math.round(x.workMinutes)} min</td></tr>`).join('')}</tbody></table></div>` : '<div class="calm-state">Provider usage will appear as worker runs are recorded.</div>'}</section>`;
}

function modelScorecardBlock(s) {
  const rows = s?.modelScorecard || [];
  return `<section><div class="section-head"><h2>Model scorecard</h2><span>Last 30 days, sorted by runs</span></div>${rows.length ? `<div class="fleet-table-wrap"><table class="fleet-table"><thead><tr><th>Harness</th><th>Model</th><th>Runs</th><th>First-time</th><th>Rework</th><th>Failed</th><th>Rework rate</th><th>Median time</th></tr></thead><tbody>${rows.map((r) => `<tr><td data-label="Harness">${esc(HARNESS_NAMES[r.kind] || r.kind)}</td><td data-label="Model" class="mono">${esc(r.model)}</td><td class="mono" data-label="Runs">${r.runs}</td><td class="mono" data-label="First-time">${r.firstTime}</td><td class="mono" data-label="Rework">${r.rework}</td><td class="mono" data-label="Failed">${r.failed}</td><td class="mono" data-label="Rework rate">${(r.reworkRate * 100).toFixed(1)}%</td><td class="mono" data-label="Median time">${r.medianMinutes != null ? Math.round(r.medianMinutes) + ' min' : '—'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="calm-state">No model outcome data yet. Orchestrators record it with <code>worker collect --record --model-result</code>.</div>'}</section>`;
}

const HARNESS_NAMES = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi' };
const TREND_ARROW = { up: ['↑', 'rising'], down: ['↓', 'falling'], flat: ['→', 'steady'] };

// The fixed scan limits, from the state. The line is read-only.
function denialLimitsLine(s) {
  const l = s?.limits?.denials;
  if (!l) return '';
  const minutes = Math.round(l.intervalMs / 60000);
  const megabytes = Math.round(l.budgetBytes / 1024 ** 2);
  return `<p class="denial-limits">Scans every ${minutes} min, reads at most ${megabytes} MB for each scan, keeps ${l.retainDays} days, and marks a rise at ${l.riseFactor}× the 6-day mean and ${l.riseMinEvents} events.</p>`;
}

// Counts only: the scan keeps no message text. A rising cause asks the Owner to talk with the Boss; it sends no pane prompt.
function denialsBlock(s) {
  const d = denials;
  const head = '<div class="section-head"><h2>Denials and permission prompts</h2><span>Last 7 days, counts only</span></div>';
  const limits = denialLimitsLine(s);
  if (!d?.rows?.length) return `<section id="denials">${head}${limits}<div class="calm-state">No denials or permission prompts are recorded yet. Herdr Boss reads the harness logs every 15 minutes.</div></section>`;
  const totals = Object.entries(d.harnessTotals || {}).sort((a, b) => b[1] - a[1]);
  const arrow = (x) => { const [sign, word] = TREND_ARROW[x.trend] || TREND_ARROW.flat; return `<span class="denial-trend ${esc(x.trend)}" title="${esc(`${word}: ${x.recent} in 24 hours, 6-day mean ${x.mean}`)}">${sign}<span class="visually-hidden"> ${word}</span></span>`; };
  const dayHead = d.days.map((day) => `<th class="mono">${esc(day.slice(5))}</th>`).join('');
  const waiting = d.catchingUp ? `<div class="calm-state">Herdr Boss still reads older logs: ${Math.ceil(d.pendingBytes / 1024 ** 2).toLocaleString()} MB left. The counts of older days are not complete, so the trend note waits.</div>` : '';
  const note = d.rising?.length ? `<div class="denial-note" role="status"><strong>${esc(d.note)}</strong><span>${d.rising.map((c) => `${esc(c.cause)}: ${c.recent} in 24 hours, 6-day mean ${c.mean}`).join(' · ')}</span></div>` : '';
  const modelRows = d.modelRows || [];
  const modelTable = modelRows.length ? `<div class="denial-model-breakdown"><h3>Counts by harness and model</h3><div class="fleet-table-wrap"><table class="fleet-table denial-model-table"><thead><tr><th>Harness</th><th>Model</th><th>Cause</th><th>Count</th></tr></thead><tbody>`
    + modelRows.slice(0, 10).map((r) => `<tr><td data-label="Harness">${esc(HARNESS_NAMES[r.harness] || r.harness)}</td><td data-label="Model" class="mono">${esc(r.model)}</td><td data-label="Cause">${esc(r.cause)}</td><td data-label="Count" class="mono">${r.count.toLocaleString()}</td></tr>`).join('')
    + `</tbody></table></div>${d.modelMoreCount ? `<p class="denial-model-more">${d.modelMoreCount.toLocaleString()} more</p>` : ''}</div>` : '';
  return `<section id="denials">${head}${limits}${waiting}${note}<div class="usage-metrics">${totals.map(([h, n]) => `<div><strong>${n.toLocaleString()}</strong><span>${esc(HARNESS_NAMES[h] || h)}</span></div>`).join('')}</div>`
    + `<div class="fleet-table-wrap"><table class="fleet-table denial-table"><thead><tr><th>Cause</th><th>Project</th><th>Harness</th>${dayHead}<th>Total</th><th>Trend</th></tr></thead><tbody>`
    + d.rows.map((r) => `<tr><td data-label="Cause"><strong>${esc(r.cause)}</strong></td><td data-label="Project">${esc(state.control?.projects?.[r.project]?.label || r.project)}</td><td data-label="Harness">${esc(HARNESS_NAMES[r.harness] || r.harness)}</td>${r.counts.map((n, i) => `<td class="mono" data-label="${esc(d.days[i].slice(5))}">${n || '·'}</td>`).join('')}<td class="mono" data-label="Total">${r.total.toLocaleString()}</td><td data-label="Trend">${arrow(r)}</td></tr>`).join('')
    + '</tbody></table></div>' + modelTable + '</section>';
}

function recentUsageBlock() {
  const rows = usage?.recent || [];
  return `<section><div class="section-head"><h2>Recent recorded work</h2><span>Latest ${rows.length} runs</span></div>${rows.length ? `<div class="fleet-table-wrap"><table class="fleet-table"><thead><tr><th>Finished</th><th>Project</th><th>Harness / model</th><th>Outcome</th><th>Tokens</th></tr></thead><tbody>${rows.map((r) => `<tr><td data-label="Finished">${esc(clock(r.endedAt))}</td><td data-label="Project"><a href="/projects/${esc(r.project)}">${esc(r.project)}</a></td><td data-label="Harness / model">${esc(r.kind)}<small>${esc(r.model)}</small></td><td data-label="Outcome">${esc(r.outcome)}</td><td class="mono" data-label="Tokens">${r.inputTokens != null || r.outputTokens != null ? `${(r.inputTokens || 0).toLocaleString()} in · ${(r.outputTokens || 0).toLocaleString()} out` : 'unmeasured'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="calm-state">No run history yet.</div>'}</section>`;
}

// ---------- Project page ----------

// ---------- Project work: frontier, dependencies, groups, specs ----------
// Orchestrators publish these fields (docs/project-status.md). The Boss only derives views from them.

const projectViews = {};
const projectView = (slug) => (projectViews[slug] ||= { showDone: false, sort: 'order', group: 'all', selected: null, doneAll: false, graphAll: false, boardCol: null });
const safeUrl = (url) => (/^https?:\/\//i.test(String(url || '')) ? String(url) : null);
const byId = (a, b) => String(a.id ?? '').localeCompare(String(b.id ?? ''), undefined, { numeric: true });
const isDone = (t) => (t.status || 'todo') === 'done';
const STATUS_COLOR = { todo: 'faint', doing: 'info', review: 'accent', blocked: 'crit', done: 'ok' };

// Phone layout: a top menu, collapsed project sections, and compact cards and tables.
const phoneMedia = window.matchMedia('(max-width: 760px), (pointer: coarse) and (max-height: 500px)');
const isPhone = () => phoneMedia.matches;
const FOLD_PREFIX = 'herdr-boss.project-folds.';
function foldState(slug) {
  try { const value = JSON.parse(sessionStorage.getItem(FOLD_PREFIX + slug)); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
}
function foldOpen(slug, key, fallback = false) { const value = foldState(slug)[key]; return typeof value === 'boolean' ? value : fallback; }
function setFoldOpen(slug, key, open) {
  const value = foldState(slug);
  value[key] = open;
  try { sessionStorage.setItem(FOLD_PREFIX + slug, JSON.stringify(value)); } catch {}
}
// A long project section stays a plain section on a desktop. On a phone it becomes a details element that remembers its open state for the session.
function collapsible({ slug, key, className = '', head = '', title, count = '', controls = '', body, id = '', defaultOpen = false }) {
  if (!isPhone()) return `<section data-key="section:${esc(key)}"${id ? ` id="${esc(id)}"` : ''}${className ? ` class="${esc(className)}"` : ''}>${head}${body}</section>`;
  const open = foldOpen(slug, key, defaultOpen);
  return `<details data-key="section:${esc(key)}"${id ? ` id="${esc(id)}"` : ''} class="fold-phone${className ? ` ${esc(className)}` : ''}" data-project-fold="${esc(slug)}" data-fold-key="${esc(key)}"${open ? ' open' : ''}>`
    + `<summary class="fold-summary"><h2>${esc(title)}${count ? ` <span class="sub">${esc(count)}</span>` : ''}</h2><span class="fold-chevron" aria-hidden="true"></span></summary>`
    + `<div class="fold-body">${controls}${body}</div></details>`;
}

// Current frontier: open work whose known blockers are all done. Next: open work that waits only on the current frontier.
// An orchestrator can set tasks[].frontier itself; then the Boss uses that and derives nothing.
function workModel(p) {
  const tasks = (p.tasks || []).filter((t) => t && t.title);
  const map = new Map(tasks.filter((t) => t.id != null && t.id !== '').map((t) => [String(t.id), t]));
  const openBlockers = (t) => blockerIds(t).filter((id) => map.has(id) && !isDone(map.get(id)));
  const explicit = tasks.some((t) => t.frontier);
  const current = new Set(), next = new Set();
  for (const t of tasks) {
    if (isDone(t)) continue;
    if (explicit) { if (t.frontier === 'current') current.add(t); else if (t.frontier === 'next') next.add(t); continue; }
    if (t.status !== 'blocked' && openBlockers(t).length === 0) current.add(t);
  }
  if (!explicit) for (const t of tasks) {
    if (isDone(t) || current.has(t)) continue;
    const waits = openBlockers(t);
    if (waits.length && waits.every((id) => current.has(map.get(id)))) next.add(t);
  }
  const groups = [...(Array.isArray(p.groups) ? p.groups : [])];
  if (tasks.some((t) => !t.group || !groups.some((g) => g.id === t.group))) groups.push({ id: '', title: 'Other work' });
  // Done tasks that herdr-boss publish moved into doneCount count as done in the overall total.
  const counted = Number.isInteger(p.doneCount) && p.doneCount > 0 ? p.doneCount : 0;
  return { tasks, map, openBlockers, current, next, groups, explicit, counted };
}

// The short wait text of a task. A waitingOn value names the party; otherwise the open blockers are named.
function waitText(t, m) {
  if (isDone(t)) return '';
  const ask = t.ask ? `: ${t.ask}` : '';
  if (t.waitingOn === 'owner') return `waits for the Owner${ask}`;
  if (t.waitingOn === 'boss') return `waits for the Boss${ask}`;
  if (t.waitingOn === 'external') return `waits for an external party${ask}`;
  const open = m.openBlockers(t);
  if (open.length) return `waiting on ${open.map((id) => `#${id}`).join(', ')}`;
  return '';
}

// Open work that waits on an Owner decision. Each entry links to its Mailbox conversation.
function decisionsBlock(p, m, slug) {
  const items = m.tasks.filter((t) => !isDone(t) && t.waitingOn === 'owner');
  if (!items.length) return '';
  const body = `<div class="decision-list">${items.map((t) => {
    const mail = t.mailboxId
      ? `<a class="decision-mail" href="/mailbox?thread=${encodeURIComponent(slug)}&conversation=${encodeURIComponent(t.mailboxId)}">Open Mailbox conversation</a>`
      : '<span class="muted">No Mailbox item yet</span>';
    return `<article class="decision-item"><div>${t.id ? `<b class="mono">${esc(t.id)}</b> ` : ''}<b>${esc(t.title)}</b>${t.ask ? `<p>${esc(t.ask)}</p>` : ''}</div>${mail}</article>`;
  }).join('')}</div>`;
  return collapsible({ slug, key: 'decisions', id: 'decisions', className: 'decision-section', head: '<div class="section-head"><h2>Needs your decision <span class="sub">open work that waits for you</span></h2></div>', title: 'Needs your decision', count: `${items.length}`, body });
}

function taskChip(t, extra = '') {
  const url = safeUrl(t.url);
  const label = `${t.id ? `<b>${esc(t.id)}</b> ` : ''}${esc(t.title)}`;
  return `<li class="task-chip s-${esc(t.status || 'todo')}${extra}">${url ? `<a href="${esc(url)}" target="_blank" rel="noreferrer">${label}</a>` : label}</li>`;
}

function progressBar(done, total) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return `<div class="work-bar" role="img" aria-label="${done} of ${total} done"><i style="width:${pct}%"></i></div><small class="num">${done} / ${total} done · ${pct}%</small>`;
}

function programBlock(m) {
  if (!m.tasks.length) return '';
  const done = m.tasks.filter(isDone).length + m.counted;
  const total = m.tasks.length + m.counted;
  const waiting = m.tasks.filter((t) => !isDone(t) && (t.status === 'blocked' || m.openBlockers(t).length)).length;
  const list = (set, empty) => set.size ? `<ul class="chip-list">${[...set].sort(byId).slice(0, 12).map((t) => taskChip(t)).join('')}</ul>${set.size > 12 ? `<small>+${set.size - 12} more</small>` : ''}` : `<p class="muted">${empty}</p>`;
  return `<section class="program"><div class="panel program-total"><h2>Overall progress</h2>${progressBar(done, total)}<small>${total - done} open · ${waiting} waiting on a blocker</small></div>
    <div class="panel"><h2>Current frontier <span class="sub">${m.explicit ? 'set by the orchestrator' : 'open, no open blockers'}</span></h2>${list(m.current, 'No open work is ready.')}</div>
    <div class="panel"><h2>Next <span class="sub">${m.explicit ? 'set by the orchestrator' : 'waits only on the current frontier'}</span></h2>${list(m.next, 'Nothing waits only on the current frontier.')}</div></section>`;
}

function groupsBlock(m, slug) {
  if (!(m.groups.length > 1 || (m.groups[0] && m.groups[0].id))) return '';
  const body = `<div class="group-grid">${m.groups.map((g) => {
    const items = m.tasks.filter((t) => (g.id ? t.group === g.id : !t.group || !m.groups.some((x) => x.id && x.id === t.group)));
    if (!items.length && !g.id) return '';
    const open = items.filter((t) => !isDone(t)).sort(byId);
    const refs = (Array.isArray(g.refs) ? g.refs : []).map((r) => safeUrl(r.url) ? `<a href="${esc(safeUrl(r.url))}" target="_blank" rel="noreferrer">${esc(r.label)}</a>` : `<span class="mono">${esc(r.label)}</span>`).join(' · ');
    return `<article class="panel group-card"><div class="proj-head"><b>${esc(g.title)}</b>${open.some((t) => m.current.has(t)) ? '<span class="tag">active</span>' : !open.length && items.length ? '<span class="tag">complete</span>' : ''}</div>
      ${progressBar(items.length - open.length, items.length)}${g.note ? `<p>${esc(g.note)}</p>` : ''}${refs ? `<small>${refs}</small>` : ''}
      ${open.length ? `<ul class="chip-list">${open.slice(0, 8).map((t) => taskChip(t, m.current.has(t) ? ' current' : '')).join('')}</ul>${open.length > 8 ? `<small>+${open.length - 8} more open</small>` : ''}` : ''}</article>`;
  }).join('')}</div>`;
  return collapsible({ slug, key: 'groups', head: '<h2>Groups <span class="sub">releases or phases in the published order</span></h2>', title: 'Groups', count: `${m.groups.length}`, body });
}

function specsBlock(m, slug) {
  const specs = m.tasks.filter((t) => t.kind === 'spec').sort(byId);
  if (!specs.length) return '';
  const body = `<div class="spec-list">${specs.map((spec) => {
    const children = m.tasks.filter((t) => t.parent && t.parent === spec.id);
    const done = children.filter(isDone).length;
    const url = safeUrl(spec.url);
    return `<article class="panel spec-row"><div><span class="st-badge s-${esc(spec.status || 'todo')}">${esc(STATUS_LABEL[spec.status || 'todo'] || spec.status)}</span> ${spec.id ? `<b>${esc(spec.id)}</b> ` : ''}${url ? `<a href="${esc(url)}" target="_blank" rel="noreferrer">${esc(spec.title)}</a>` : esc(spec.title)}</div>
      ${children.length ? progressBar(done, children.length) : '<small class="muted">No work linked with parent</small>'}</article>`;
  }).join('')}</div>`;
  return collapsible({ slug, key: 'specs', head: `<h2>Specs <span class="sub">${specs.length} · progress of the work under each spec</span></h2>`, title: 'Specs', count: `${specs.length}`, body });
}

// ---------- Board and dependency graph: one model ----------
// The board and the graph use the flow states of board.js and the same --st-* colors.
// A selected task highlights its card, its graph node, and its dependency chain. The selection lives in the project view.

const WAIT_PARTY = { owner: 'the Owner', boss: 'the Boss', external: 'an external item', task: 'a task' };
const BOARD_EMPTY = { blocked: 'Nothing waits.', ready: 'No task is ready.', doing: 'No worker runs a task.', review: 'Nothing waits for review.', done: 'No task is done yet.' };
const ICON_EXTERNAL = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M4.5 2.5h5v5M9.5 2.5 3 9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const cardDomId = (slug, id) => `card-${domPart(slug)}-${domPart(id)}`;
const colDomId = (slug, k) => `board-${domPart(slug)}-${k}`;

function waitReason(r, t, slug) {
  if (r.kind === 'task' && r.id == null) return 'a task that the status does not name';
  if (r.kind === 'unstated') return 'a reason that the status does not state';
  if (r.kind === 'task') return r.known
    ? `<button type="button" class="wait-link mono" data-task-select="${esc(r.id)}" data-slug="${esc(slug)}" data-reveal="card" aria-label="Select blocking task ${esc(r.id)}">${esc(r.id)}</button>`
    : `<span class="mono" title="This task is not in the published status">${esc(r.id)} (outside)</span>`;
  if (r.kind === 'owner' && t.mailboxId) return `<a href="/mailbox?thread=${encodeURIComponent(slug)}&conversation=${encodeURIComponent(t.mailboxId)}">the Owner</a>`;
  return esc(WAIT_PARTY[r.kind] || r.kind);
}

function boardCard(t, ctx) {
  const { slug, map, selected, chain, path, now } = ctx;
  const state = taskState(t, map);
  const id = t.id != null ? String(t.id) : '';
  const key = id || `~${ctx.index}`;
  const url = safeUrl(t.url);
  const cls = ['card', `st-${state}`, id && id === selected ? 'is-selected' : '', id && id !== selected && chain.has(id) ? 'in-chain' : '', id && path.has(id) ? 'on-path' : ''].filter(Boolean).join(' ');
  const reasons = blockReasons(t, map);
  const wait = reasons.length ? `<p class="card-wait">Waits on ${reasons.map((r) => waitReason(r, t, slug)).join(', ')}</p>` : '';
  const w = t.worker;
  const elapsed = state === 'doing' ? elapsedText(w?.startedAt, now) : '';
  const worker = w ? `<p class="card-worker"><span class="mono">${esc(w.name)}</span>${w.model ? ` · ${esc(w.model)}` : ''}${elapsed ? ` · <span class="num">${esc(elapsed)}</span>` : ''}</p>` : '';
  const source = t.stateSource && t.stateSource !== 'published' && (state === 'doing' || state === 'review') ? `<p class="card-source">${esc(t.stateSource)}</p>` : '';
  const title = id
    ? `<button type="button" class="card-title" data-task-select="${esc(id)}" data-slug="${esc(slug)}" data-reveal="graph" aria-pressed="${id === selected}">${esc(t.title)}</button>`
    : `<span class="card-title">${esc(t.title)}</span>`;
  return `<li class="${cls}" data-key="task:${esc(key)}"${id ? ` id="${esc(cardDomId(slug, id))}" data-task-card="${esc(id)}"` : ''}>`
    + `<div class="card-top"><span class="card-dot" aria-hidden="true"></span><span class="card-id mono">${esc(id)}</span>${id && path.has(id) ? '<span class="card-flag">critical path</span>' : ''}${url ? `<a class="card-link" href="${esc(url)}" target="_blank" rel="noreferrer" aria-label="Open issue ${esc(id)}">${ICON_EXTERNAL}</a>` : ''}</div>`
    + `${title}${wait}${worker}${source}</li>`;
}

// The phone shows one column at a time. The first column with work opens, in the order Doing, Ready, Blocked, Review, Done.
function boardActiveColumn(view, counts) {
  if (FLOW.includes(view.boardCol)) return view.boardCol;
  return ['doing', 'ready', 'blocked', 'review', 'done'].find((k) => counts[k] > 0) || 'ready';
}

function boardBlock(p, slug) {
  const tasks = (p.tasks || []).filter((t) => t && t.title != null);
  if (!tasks.length) return '';
  const view = projectView(slug);
  const b = boardColumns(tasks, { groups: p.groups, showAllDone: view.doneAll });
  const selected = view.selected && b.map.has(view.selected) ? view.selected : null;
  const ctx = { slug, map: b.map, selected, chain: selected ? dependencyChain(selected, tasks) : new Set(), path: new Set(b.critical.path), now: Date.now() };
  const active = boardActiveColumn(view, b.counts);
  const open = tasks.length - b.counts.done;
  const steps = b.critical.path.length;
  const pathText = steps ? ` · critical path${b.critical.milestone ? ` to ${b.critical.milestone.title}` : ''}: ${steps} ${steps === 1 ? 'task' : 'tasks'}` : '';
  const stale = p.boardStale ? `<p class="board-stale" role="status"><span class="stale-mark">stale</span> ${esc(p.boardStaleReason || 'The published status does not match the workers.')}</p>` : '';
  const tabs = `<div class="board-tabs" role="tablist" aria-label="Board columns">${FLOW.map((k) => `<button type="button" role="tab" class="board-tab st-${k}" data-board-tab="${k}" data-slug="${esc(slug)}" aria-selected="${k === active}" aria-controls="${esc(colDomId(slug, k))}" tabindex="${k === active ? 0 : -1}"><span class="card-dot" aria-hidden="true"></span><span class="tab-label">${FLOW_LABEL[k]}</span><span class="num">${b.counts[k]}</span></button>`).join('')}</div>`;
  const cols = FLOW.map((k) => {
    const list = b.columns[k];
    const more = k === 'done' && (b.hiddenDone || (view.doneAll && b.counts.done > DONE_LIMIT))
      ? `<button type="button" class="board-more" data-board-done="${esc(slug)}">${b.hiddenDone ? `Show all ${b.counts.done} done` : `Show the last ${DONE_LIMIT}`}</button>` : '';
    const cards = list.length ? `<ol class="board-list">${list.map((t, i) => boardCard(t, { ...ctx, index: `${k}${i}` })).join('')}</ol>` : `<p class="board-empty">${BOARD_EMPTY[k]}</p>`;
    return `<section class="board-col st-${k}" data-key="col:${k}" data-col="${k}" id="${esc(colDomId(slug, k))}" role="tabpanel" aria-label="${FLOW_LABEL[k]}, ${b.counts[k]}"><h3><span class="card-dot" aria-hidden="true"></span>${FLOW_LABEL[k]}<span class="num">${b.counts[k]}</span></h3>${cards}${more}</section>`;
  }).join('');
  const body = `<div class="board" data-key="board:${esc(slug)}">${stale}${tabs}<div class="board-cols" data-board-cols="${esc(slug)}" data-keep-attrs="style">${cols}</div></div>`;
  return collapsible({ slug, key: 'board', id: 'board', className: 'board-section', defaultOpen: true, head: `<div class="section-head"><h2>Board <span class="sub">${open} open${esc(pathText)}</span></h2></div>`, title: 'Board', count: `${open} open${p.boardStale ? ' · stale' : ''}`, body });
}

// Layered dependency graph: each column holds tasks whose blockers sit in earlier columns. Arrows run from blocker to dependent.
// Every task is a box. A task without links sits in column 0, after the linked tasks of that column.
function dependencyGraph(p, slug) {
  const view = projectView(slug);
  const all = (p.tasks || []).filter((t) => t && t.title != null);
  const map = taskMap(all);
  const nodes = graphTasks(all, { openOnly: !view.graphAll });
  if (!nodes.length) return '';
  const groups = Array.isArray(p.groups) ? p.groups : [];
  // A task without an id still gets a box; a synthetic key keeps it apart from the real ids.
  const keyOf = new Map();
  nodes.forEach((t, i) => keyOf.set(t, t.id != null ? String(t.id) : `~${i}`));
  const inSet = new Set(nodes.map((t) => keyOf.get(t)));
  const linked = new Set();
  const edgeKeys = [];
  for (const t of nodes) for (const raw of blockerIds(t)) {
    const id = String(raw);
    if (!map.has(id) || !inSet.has(id)) continue;
    linked.add(id); linked.add(keyOf.get(t));
    edgeKeys.push([id, keyOf.get(t)]);
  }
  // The layer of each box. graphDepths walks without recursion and cuts a cycle in published data.
  const layer = graphDepths(nodes, (t) => keyOf.get(t));
  const groupOrder = new Map(groups.map((g, i) => [g.id, i]));
  const columns = [];
  for (const t of nodes) (columns[layer.get(keyOf.get(t))] ||= []).push(t);
  // Linked tasks come first in a column; tasks without links follow in the published group order.
  for (const col of columns) col?.sort((a, b) => (linked.has(keyOf.get(a)) ? 0 : 1) - (linked.has(keyOf.get(b)) ? 0 : 1) || (groupOrder.get(a.group) ?? 99) - (groupOrder.get(b.group) ?? 99) || byId(a, b));
  const W = 176, H = 48, GX = 56, GY = 12, PAD = 8;
  const pos = new Map();
  columns.forEach((col, x) => (col || []).forEach((t, y) => pos.set(keyOf.get(t), { x: PAD + x * (W + GX), y: PAD + y * (H + GY) })));
  const width = PAD * 2 + columns.length * (W + GX) - GX;
  const height = PAD * 2 + Math.max(...columns.map((c) => c?.length || 0)) * (H + GY) - GY;
  const critical = criticalPath(all, groups);
  const path = new Set(critical.path);
  const pathEdges = new Set(critical.path.slice(1).map((id, i) => `${critical.path[i]}>${id}`));
  const selected = view.selected && map.has(view.selected) ? view.selected : null;
  const chain = selected ? dependencyChain(selected, all) : null;
  const focus = (a, b) => (!chain ? '' : chain.has(a) && (b == null || chain.has(b)) ? ' in-chain' : ' dim');
  const paths = edgeKeys.map(([a, b]) => {
    const s = pos.get(a), e = pos.get(b);
    if (!s || !e) return '';
    const x1 = s.x + W, y1 = s.y + H / 2, x2 = e.x, y2 = e.y + H / 2, mid = (x1 + x2) / 2;
    const open = taskState(map.get(a), map) !== 'done';
    const cls = `dep-edge${open ? ' open' : ''}${pathEdges.has(`${a}>${b}`) ? ' on-path' : ''}${focus(a, b)}`;
    return `<path data-key="edge:${esc(a)}>${esc(b)}" class="${cls}" d="M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2 - 4},${y2}" marker-end="url(#dep-arrow-${esc(slug)})"></path>`;
  }).join('');
  const boxes = nodes.map((t) => {
    const key = keyOf.get(t);
    const { x, y } = pos.get(key);
    const state = taskState(t, map);
    const hidden = blockerIds(t).filter((id) => !map.has(id)).length;
    const label = `${t.id ?? ''} · ${FLOW_LABEL[state]}${path.has(key) ? ' · path' : ''}${hidden ? ` · +${hidden} outside` : ''}`;
    const cls = `dep-node-group st-${state}${key === selected ? ' is-selected' : ''}${path.has(key) ? ' on-path' : ''}${focus(key)}`;
    const select = t.id != null ? ` data-task-select="${esc(key)}" data-slug="${esc(slug)}" data-reveal="card" role="button" tabindex="0" aria-pressed="${key === selected}" aria-label="${esc(`${t.id} ${t.title}, ${FLOW_LABEL[state]}`)}"` : '';
    return `<g class="${cls}" data-key="node:${esc(key)}"${select}><rect class="dep-node" x="${x}" y="${y}" width="${W}" height="${H}" rx="6"></rect>`
      + `<rect class="dep-mark" x="${x + 9}" y="${y + 10}" width="8" height="8" rx="2"></rect>`
      + `<text x="${x + 22}" y="${y + 18}" class="dep-id">${esc(label)}</text>`
      + `<text x="${x + 9}" y="${y + 36}" class="dep-title">${esc(String(t.title).length > 25 ? `${String(t.title).slice(0, 24)}…` : t.title)}</text><title>${esc(`${t.id ?? ''} ${t.title} (${FLOW_LABEL[state]})`)}</title></g>`;
  }).join('');
  const toggle = `<label class="inline-toggle"><input type="checkbox" data-graph-open="${esc(slug)}" ${view.graphAll ? '' : 'checked'}> Open work only</label>`;
  const toolbar = `<div class="dep-toolbar" role="group" aria-label="Dependency graph view">
    <button type="button" class="dep-btn" data-dep-action="fit" data-dep-slug="${esc(slug)}" aria-label="Fit the whole graph in the panel">Fit</button>
    <button type="button" class="dep-btn" data-dep-action="out" data-dep-slug="${esc(slug)}" aria-label="Zoom out">−</button>
    <button type="button" class="dep-btn" data-dep-action="in" data-dep-slug="${esc(slug)}" aria-label="Zoom in">+</button>
    <button type="button" class="dep-btn" data-dep-action="100" data-dep-slug="${esc(slug)}" aria-label="Zoom to 100 percent">100%</button>
    <button type="button" class="dep-btn" data-dep-action="full" data-dep-slug="${esc(slug)}" aria-label="Show the graph at full size">Full size</button>
    <span class="dep-zoom" data-dep-readout="${esc(slug)}" aria-hidden="true">100%</span></div>`;
  const milestone = critical.milestone ? ` to ${critical.milestone.title}` : '';
  const legend = `<div class="dep-legend">${FLOW.map((k) => `<span class="st-${k}">${FLOW_LABEL[k]}</span>`).join('')}${critical.path.length ? `<span class="on-path">Critical path${esc(milestone)}</span>` : ''}${selected ? `<span class="in-chain">Chain of ${esc(selected)}</span>` : ''}</div>`;
  const body = `<div class="dep" data-key="graph:${esc(slug)}">${toolbar}${legend}
    <div class="panel dep-scroll"><div class="dep-stage" data-dep-stage="${esc(slug)}" data-keep-attrs="style">
      <button type="button" class="dep-close" data-dep-action="close" data-dep-slug="${esc(slug)}" aria-label="Close full size">Close</button>
      <svg class="dep-graph${chain ? ' has-selection' : ''}" style="--gw:${width}px;--gh:${height}px" data-dep-graph="${esc(slug)}" data-dep-width="${width}" data-dep-height="${height}" data-keep-attrs="viewBox" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="group" aria-label="Dependency graph with ${nodes.length} tasks">
      <defs><marker id="dep-arrow-${esc(slug)}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" class="dep-arrow"></path></marker></defs>${paths}${boxes}</svg></div></div></div>`;
  return collapsible({ slug, key: 'dependencies', id: 'dependencies', className: 'dep-section', head: `<div class="section-head"><h2>Dependencies <span class="sub">arrows run from blocker to dependent${critical.path.length ? ` · the critical path${esc(milestone)} is marked` : ''}</span></h2>${toggle}</div>`, title: 'Dependencies', count: `${nodes.length}`, controls: `<div class="fold-controls">${toggle}</div>`, body });
}

// Dependency graph view: zoom and pan for each project live in memory only, never in localStorage.
const DEP_MIN_ZOOM = 0.25, DEP_MAX_ZOOM = 4;
// The automatic view never draws the graph text smaller than this zoom. Fit can go lower.
const DEP_READABLE_ZOOM = 0.85;
const depState = (slug) => {
  const view = projectView(slug);
  return (view.dep ||= { zoom: null, cx: null, cy: null, full: false, moved: false, whole: false });
};
const clampDepZoom = (z) => Math.min(DEP_MAX_ZOOM, Math.max(DEP_MIN_ZOOM, z));
const depStageEl = (slug) => [...document.querySelectorAll('[data-dep-stage]')].find((s) => s.dataset.depStage === slug) || null;
const depEl = (selector, key, slug) => [...document.querySelectorAll(selector)].find((el) => el.dataset[key] === slug) || null;

// Change the viewBox for zoom and pan. The graph fits the panel until the Owner zooms or pans it; then the view stays.
function depTransform(slug, { fit = false } = {}) {
  const stage = depStageEl(slug);
  const svg = stage?.querySelector('[data-dep-graph]');
  if (!stage || !svg) return;
  const rect = svg.getBoundingClientRect();
  let sw = rect.width, sh = rect.height;
  if (!(sw > 0) || !(sh > 0)) return; // a hidden section has no size; fit it when it opens
  const st = depState(slug);
  const gw = Number(svg.dataset.depWidth) || 1, gh = Number(svg.dataset.depHeight) || 1;
  // On a phone the graph has its natural size and scrolls sideways in its own box.
  if (st.full || isPhone()) stage.style.height = '';
  if (isPhone() && !st.full) { svg.setAttribute('viewBox', `0 0 ${gw} ${gh}`); return; }
  if (fit) { st.moved = false; st.whole = true; }
  const pad = 20;
  // Until the Owner zooms or pans, the graph fits the panel. The automatic view keeps the text readable: a wide graph
  // starts at DEP_READABLE_ZOOM at its left edge. Fit shows the whole graph at any zoom.
  const autoZoom = (width) => Math.min(1, st.whole ? (width - pad * 2) / gw : Math.max((width - pad * 2) / gw, DEP_READABLE_ZOOM));
  // A wide, flat graph gets a lower panel, so the fitted graph leaves no large empty band.
  if (!st.full && !st.moved) {
    const fitted = Math.round(Math.max(200, Math.min(520, innerHeight * 0.6, gh * autoZoom(sw) + pad * 2)));
    if (Math.abs(stage.offsetHeight - fitted) > 2) {
      stage.style.height = `${fitted}px`;
      const next = svg.getBoundingClientRect();
      sw = next.width; sh = next.height;
    }
  }
  if (!st.moved || st.zoom == null || st.cx == null || st.cy == null) {
    st.zoom = clampDepZoom(Math.min(autoZoom(sw), (sh - pad * 2) / gh));
    const whole = st.zoom <= (sw - pad * 2) / gw + 1e-6;
    st.cx = whole ? gw / 2 : sw / st.zoom / 2 - pad / st.zoom;
    st.cy = gh / 2;
  }
  st.zoom = clampDepZoom(st.zoom);
  const vw = sw / st.zoom, vh = sh / st.zoom;
  svg.setAttribute('viewBox', `${st.cx - vw / 2} ${st.cy - vh / 2} ${vw} ${vh}`);
  const readout = depEl('[data-dep-readout]', 'depReadout', slug);
  if (readout) readout.textContent = `${Math.round(st.zoom * 100)}%`;
}

// The current zoom of a project, after a fit when the page has not drawn it yet.
function depCurrentZoom(slug) {
  const st = depState(slug);
  if (st.zoom == null) depTransform(slug);
  return st.zoom;
}

// Zoom to a target scale. ax and ay are the pointer fractions of the width and the height; the point stays still.
function depZoomTo(slug, target, ax = 0.5, ay = 0.5) {
  const svg = depStageEl(slug)?.querySelector('[data-dep-graph]');
  if (!svg) return;
  const rect = svg.getBoundingClientRect();
  const sw = rect.width, sh = rect.height;
  if (!(sw > 0) || !(sh > 0)) return;
  const st = depState(slug);
  const gw = Number(svg.dataset.depWidth) || 1, gh = Number(svg.dataset.depHeight) || 1;
  const z = clampDepZoom(st.zoom ?? 1);
  const vw = sw / z, vh = sh / z;
  const gx = (st.cx ?? gw / 2) - vw / 2 + ax * vw;
  const gy = (st.cy ?? gh / 2) - vh / 2 + ay * vh;
  st.zoom = clampDepZoom(target);
  st.moved = true; st.whole = false;
  st.cx = gx + (0.5 - ax) * (sw / st.zoom);
  st.cy = gy + (0.5 - ay) * (sh / st.zoom);
  depTransform(slug);
}

// Apply the remembered state to every drawn graph after a render, a fold, or a window resize.
function syncDepGraphs() {
  for (const stage of document.querySelectorAll('[data-dep-stage]')) {
    const st = depState(stage.dataset.depStage);
    stage.classList.toggle('full', !!st.full);
    depTransform(stage.dataset.depStage);
  }
  document.body.classList.toggle('dep-full-open', !!document.querySelector('.dep-stage.full'));
}

// Open or close the full-size overlay. The graph fits the window when it opens.
function setDepFull(slug, on) {
  const st = depState(slug);
  st.full = on;
  const stage = depStageEl(slug);
  if (!stage) return;
  stage.classList.toggle('full', on);
  if (on) stage.style.height = '';
  document.body.classList.toggle('dep-full-open', on);
  if (on) { depTransform(slug, { fit: true }); stage.querySelector('[data-dep-action="close"]')?.focus(); }
  else { depTransform(slug); depEl('[data-dep-action="full"]', 'depSlug', slug)?.focus(); }
}

function issueTable(m, slug) {
  if (!m.tasks.length) return '';
  const view = projectView(slug);
  const rank = (t) => (m.current.has(t) ? 0 : m.next.has(t) ? 1 : isDone(t) ? 3 : 2);
  let rows = m.tasks.filter((t) => (view.showDone || !isDone(t)) && (view.group === 'all' || (t.group || '') === view.group));
  const sorts = {
    order: (a, b) => rank(a) - rank(b) || byId(a, b),
    id: byId,
    updated: (a, b) => String(b.updated || '').localeCompare(String(a.updated || '')),
    status: (a, b) => STATUSES.indexOf(a.status || 'todo') - STATUSES.indexOf(b.status || 'todo') || byId(a, b),
  };
  rows = rows.sort(sorts[view.sort] || sorts.order);
  const groups = m.groups.filter((g) => g.id);
  const tools = `<div class="issue-tools">
    <label>Sort <select data-project-sort="${esc(slug)}">${[['order', 'Frontier first'], ['id', 'ID'], ['status', 'Status'], ['updated', 'Recently updated']].map(([v, l]) => `<option value="${v}" ${view.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    ${groups.length ? `<label>Group <select data-project-group="${esc(slug)}"><option value="all">All groups</option>${groups.map((g) => `<option value="${esc(g.id)}" ${view.group === g.id ? 'selected' : ''}>${esc(g.title)}</option>`).join('')}</select></label>` : ''}
    <label class="inline-toggle"><input type="checkbox" data-project-done="${esc(slug)}" ${view.showDone ? 'checked' : ''}> Show completed</label></div>`;
  const table = `<div class="panel issue-table-wrap"><table class="issue-table"><thead><tr><th>ID</th><th>Title</th><th>Status</th><th>Group</th><th>Blocked by</th><th>Labels</th><th>Updated</th></tr></thead><tbody>${rows.map((t) => {
      const url = safeUrl(t.url);
      const waits = m.openBlockers(t);
      const group = m.groups.find((g) => g.id && g.id === t.group);
      const wait = waitText(t, m);
      const statusBadge = (t.status || 'todo') === 'blocked' && wait
        ? `<span class="st-badge s-blocked">${esc(wait)}</span>`
        : `<span class="st-badge s-${esc(t.status || 'todo')}">${esc(STATUS_LABEL[t.status || 'todo'] || t.status)}</span>${wait ? `<div class="wait">${esc(wait)}</div>` : ''}`;
      return `<tr class="${m.current.has(t) ? 'row-current' : ''}"><td class="mono" data-label="ID">${esc(t.id || '')}</td><td data-label="Title">${url ? `<a href="${esc(url)}" target="_blank" rel="noreferrer">${esc(t.title)}</a>` : esc(t.title)}${t.kind ? ` <span class="tag">${esc(t.kind)}</span>` : ''}${m.current.has(t) ? ' <span class="tag current">current</span>' : m.next.has(t) ? ' <span class="tag">next</span>' : ''}</td><td data-label="Status">${statusBadge}</td><td data-label="Group">${esc(group?.title || '')}</td><td class="mono" data-label="Blocked by">${blockerIds(t).map((id) => `<span class="${waits.includes(id) ? 'text-crit' : 'muted'}">${esc(id)}</span>`).join(' ')}</td><td data-label="Labels">${(t.labels || []).map((l) => `<span class="tag">${esc(l)}</span>`).join(' ')}</td><td class="mono" data-label="Updated">${t.updated ? esc(ago(t.updated)) : ''}</td></tr>`;
    }).join('') || '<tr><td colspan="7" class="muted" data-label="">No work matches the filter.</td></tr>'}</tbody></table></div>`;
  return collapsible({ slug, key: 'work', head: `<div class="section-head"><h2>All work <span class="sub">${rows.length} shown of ${m.tasks.length}</span></h2>${tools}</div>`, title: 'All work', count: `${rows.length} of ${m.tasks.length}`, controls: tools, body: table });
}

function gatesRisksBlock(p) {
  const gates = Array.isArray(p.gates) ? p.gates : [];
  const risks = Array.isArray(p.risks) ? p.risks : [];
  if (!gates.length && !risks.length) return '';
  return `<section class="two">${gates.length ? `<div class="panel"><h2>Human gates</h2><div class="table-scroll"><table class="issue-table"><thead><tr><th>Gate</th><th>Needs</th><th>Evidence</th><th>Status</th></tr></thead><tbody>${gates.map((g) => `<tr><td data-label="Gate">${g.id ? `<b class="mono">${esc(g.id)}</b> ` : ''}${esc(g.title)}</td><td data-label="Needs">${esc(g.needs || '')}</td><td data-label="Evidence">${esc(g.evidence || '')}</td><td data-label="Status">${esc(g.status || '')}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
    ${risks.length ? `<div class="panel"><h2>Risks</h2><ul class="notes">${risks.map((r) => `<li>${code(r)}</li>`).join('')}</ul></div>` : ''}</section>`;
}

// The drift check result that herdr-boss publish stores for the project AGENTS.md.
function agentsDriftLine(check) {
  const errors = Number.isInteger(check?.errors) ? check.errors : 0;
  const warnings = Number.isInteger(check?.warnings) ? check.warnings : 0;
  if (!errors && !warnings) return '';
  return `<div class="warnbox">AGENTS.md drift: ${errors} errors, ${warnings} warnings. Run <span class="mono">herdr-boss check agents</span>.</div>`;
}

// The Boss memory file is outside every project repository.
const BOSS_MEMORY_PATH = '~/.herdr-boss/boss-memory.md';

// The state of the loaded kit revision, from the current revision and the impact of each recorded change.
// It matches kitRevisionState() in src/kit/agents-check.js. An unknown revision is behind on a required change.
function kitState(loaded, kit) {
  if (!loaded) return 'not published';
  if (loaded === kit.current) return 'current';
  const changes = kit.changes || [];
  const index = changes.findIndex((c) => c.revision === loaded);
  if (index < 0 || changes.at(-1)?.revision !== kit.current) return 'behind (required)';
  return changes.slice(index + 1).some((c) => c.impact === 'required') ? 'behind (required)' : 'behind (useful only)';
}

// The kit revision that the orchestrator loaded, against the current kit revision of Herdr Boss.
// A project that is behind on useful changes only shows a muted line. A required change shows a warning.
function kitRevisionLine(p, kit) {
  const current = p.currentKitRevision;
  if (!current) return '';
  const loaded = p.kitRevision || 'not published';
  const text = `Kit revision ${esc(loaded)}, current ${esc(current)}`;
  const state = kitState(p.kitRevision, { current, changes: kit?.changes });
  if (state === 'current') return `<div class="win-foot">${text}.</div>`;
  if (state === 'behind (useful only)') return `<div class="win-foot muted">${text}. Behind (useful only): the kit changes since then need no action. Run <span class="mono">herdr-boss kit update</span> when convenient.</div>`;
  return `<div class="warnbox">${text}. The orchestrator uses an old kit. Run <span class="mono">herdr-boss kit update</span> in the project, and read its digest of the kit changes.</div>`;
}

// The read-only file paths that an orchestrator reads. Show paths only, never file contents.
function filesBlock(p, kit) {
  const row = (label, value) => `<li><span class="k">${esc(label)}</span>${value ? `<span class="mono">${esc(value)}</span>` : '<span class="muted">not registered yet</span>'}</li>`;
  return `<section class="panel files"><h2>Files</h2><div class="win-foot">Paths that the orchestrator reads.</div><ul class="files-list">
    ${row('Project memory', p.repo ? `${p.repo}/docs/orchestration/memory.md` : null)}
    ${row('Kit file', p.repo ? `${p.repo}/docs/orchestration/herdr-boss.md` : null)}
    ${row('Boss memory', BOSS_MEMORY_PATH)}
  </ul>${kitRevisionLine(p, kit)}</section>`;
}

// The read-only worker config that the engine read from .herdr-boss.json. It shows allow-listed fields only.
function workerConfigValue(value) {
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'none';
  if (value === null || value === undefined || value === '') return 'not set';
  return String(value);
}

function workerConfigBlock(s, slug) {
  const view = s.workerConfig?.[slug];
  if (!view) return '';
  const note = 'Change these in <span class="mono">.herdr-boss.json</span> in the repository.';
  const body = view.error
    ? `<div class="warnbox">Could not read <span class="mono">.herdr-boss.json</span>: ${esc(view.error)}</div>`
    : `<ul class="files-list">${(view.fields || []).map((f) => `<li><span class="k">${esc(f.key)}</span><span class="mono">${esc(workerConfigValue(f.value))}</span>${f.source === 'config' ? '<span class="tag">config</span>' : ''}</li>`).join('')}</ul>`;
  return `<section class="panel files worker-config"><h2>Worker config</h2>${body}<div class="win-foot">${note}</div></section>`;
}

function project(s, slug) {
  const published = (s.projects || []).find((x) => x.slug === slug);
  const live = s.control?.projects?.[slug];
  const p = published || (live ? { slug, project: live.label, workspace: live.workspace, tasks: [] } : null);
  if (!p) return `<div class="panel empty">No open project "${esc(slug)}".</div>`;
  const phases = p.phases?.length ? `<ol class="phases">${p.phases.map((ph) => {
    const idx = p.phases.indexOf(p.phase);
    const i = p.phases.indexOf(ph);
    return `<li class="${ph === p.phase ? 'current' : idx >= 0 && i < idx ? 'done' : ''}">${esc(ph)}</li>`;
  }).join('')}</ol>` : p.phase ? `<div><span class="tag">${esc(p.phase)}</span></div>` : '';
  const metrics = p.metrics?.length ? `<section class="metrics">${p.metrics.map((m) => `<div class="panel metric"><div class="k">${esc(m.label)}</div><div class="v">${esc(m.value)}</div>${m.detail ? `<div class="d">${esc(m.detail)}</div>` : ''}</div>`).join('')}</section>` : '';
  const work = workModel(p);
  const links = p.links?.length ? `<div class="panel"><h2>Links</h2><ul class="links">${p.links.map((l) => safeUrl(l.url) ? `<li><a href="${esc(safeUrl(l.url))}" target="_blank" rel="noreferrer">${esc(l.label || l.url)}</a></li>` : `<li>${esc(l.label || '')}</li>`).join('')}</ul></div>` : '';
  const notes = p.notes?.length ? `<div class="panel"><h2>Notes</h2><ul class="notes">${p.notes.map((n) => `<li>${code(n)}</li>`).join('')}</ul></div>` : '';
  const ws = p.workspace && s.herdr?.workspaces.find((w) => w.id === p.workspace || w.label === p.workspace);
  const wsBlock = ws ? workspacesBlock({ ...s, herdr: { ...s.herdr, workspaces: [ws] } }, slug) : '';
  return [
    `<section class="phead"><h1>${esc(p.project)}</h1>${p.goal ? `<div class="owner-goal">${goalField('Current Owner goal', p.goal)}</div>` : ''}${p.summary ? `<p>${esc(p.summary)}</p>` : ''}${phases}<div class="win-foot">${published ? `updated ${ago(p.updated)}${staleStatusTag(s, p)}${p.status ? ` · ${esc(p.status)}` : ''}` : 'No project status published yet'}${p.git && typeof p.git === 'object' ? ` · <span class="mono">${esc(p.git.branch || '')}${p.git.commit ? ` @ ${esc(String(p.git.commit).slice(0, 12))}` : ''}${p.git.dirty ? ' · uncommitted changes' : ''}</span>` : ''}</div></section>`,
    p.errors ? `<div class="warnbox">${esc(p.errors.join('; '))}</div>` : '',
    agentsDriftLine(p.agentsCheck),
    published ? filesBlock(p, s.kit) : '',
    workerConfigBlock(s, slug),
    handoffBlock(s, slug),
    metrics,
    programBlock(work),
    boardBlock(p, slug),
    dependencyGraph(p, slug),
    groupsBlock(work, slug),
    specsBlock(work, slug),
    decisionsBlock(p, work, slug),
    issueTable(work, slug),
    gatesRisksBlock(p),
    links || notes ? `<section class="two">${notes}${links}</section>` : '',
    wsBlock,
  ].join('');
}

// ---------- Help panel ----------
// Short notes for each page. They say what the page shows and how to use it; the CLI and setup are in docs/.

const HELP = {
  overview: ['Overview', `
    <p>The state of all projects and shared resources at one glance.</p>
    <h3>Needs attention</h3><p>Warnings and critical alerts: quotas, memory, machine load, and orphaned worktree processes. <b>Details</b> opens the rule text in Logs.</p>
    <h3>Handovers</h3><p>Prepared successors that wait for review. Each shows the goal that the successor gets, as one collapsed line. A record shows only while its source pane and successor pane exist. A recommendation without a record is not listed here. Open the project to plan, inspect, or activate a handover.</p>
    <h3>Projects</h3><p>The bar above the cards shows the applied share of each project, in card order. Its colors match the top edge of each card. A label such as <b>30% · 2</b> shows the share and the effective slots; the tooltip shows all values. Change the shares on the Allocation page.</p><p>A card per project with its published status and task mix. The table shows the orchestrator, workers in use against the share, and the policy mode. Select a project for its details.</p>
    <h3>Watch symbol</h3><p>The eye symbol in the top bar, next to the chat, mail, and needs-action icons, shows the watch. When no watch runs, the symbol is faded. While a watch runs, the symbol is clear and, on a wide screen, shows a label such as <b>until 08:00</b> or <b>on</b>. On a phone it shows the icon only. Select it to open a popover with the end time, the mode, and <b>Stop</b>. The page asks you to confirm a stop. The page has no banner. A read-only preview shows the symbol and refuses a change.</p>
    <h3>Subscriptions and machine health</h3><p>Select a bar to open all quota windows, or the processes and load history. After a restart, "Quotas from HH:MM" shows saved quotas until the first new quota read succeeds. When the probe for one provider fails, "Claude quota from HH:MM (probe failed)" shows its last good quota for up to 60 minutes. The Machine guard switch turns CPU and load warnings and worker-start blocks on or off. Choose a pause length to suspend those rules for a time; select <b>Resume guard</b> to end a pause early. Memory and disk warnings stay on. Disk space reports the filesystem that contains the Herdr Boss data directory.</p>`],
  board: ['Board', `
    <p>The Board shows the tasks of all projects on one kanban. It uses the same task states as the board on each project page.</p>
    <h3>Columns</h3><p><b>Blocked</b> holds a task that waits on another task, the Owner, the Boss, or an external item. <b>Ready</b> holds a task whose dependencies are all done. <b>Doing</b> holds a task with a live worker; the longest-running worker comes first. <b>Review</b> holds a task whose worker was collected and is not merged. <b>Done · 24 h</b> holds the tasks done in the last 24 hours, newest first. A done task without an update time does not show.</p>
    <h3>Cards</h3><p>A card shows the project, the task ID, the title, and the worker with its model. A Doing card also shows the elapsed time. A Blocked card shows what it waits on: the ID and title of each open blocker task, or the Owner, the Boss, or an external item with the ask. When the status names no blocker, the card says so. A <b>path</b> mark shows a task on the critical path of its project.</p>
    <p>Select a card title to open the project page with the task selected. The page shows the task card on the project board and its chain in the dependency graph. Select a blocker to open that task. Select the project name to open the project page.</p>
    <h3>Summary</h3><p>The counts show the tasks in each column after the project, who, and search filters. Select a count to show only that column. Select it again to show all columns. <b>Needs the Owner</b> counts the open Mailbox items that need you and opens the Mailbox. Each project bar shows the tasks of that project in each state, on one scale for all projects. Select a bar to show only that project.</p>
    <h3>Filters</h3><p><b>Project</b> shows one project. <b>Kind</b> shows the tasks that wait for the Owner, the tasks with a worker, or the tasks of one worker harness or one model. <b>State</b> shows one column. The search matches the project, the task ID, the title, the ask, and the worker name and model. Each word must match. Press <kbd>/</kbd> to go to the search. <b>Clear filters</b> removes all filters.</p>
    <h3>Grouping</h3><p><b>By project</b> shows one swimlane for each project. Select a swimlane title to close or open it. <b>One board</b> shows all projects in one set of columns. The page remembers the grouping, the filters, and the closed swimlanes in this browser. It does not remember the search.</p>
    <h3>Refresh</h3><p>The page updates in place. It keeps the scroll position, the focus, and the search text.</p>
    <h3>Phone</h3><p>On a phone the page shows one column at a time. The tab bar shows each column with its count. Select a tab or swipe sideways to change the column. The row of project chips replaces the swimlanes. Select a chip to show one project, and select <b>All</b> to show all projects.</p>`],
  projects: ['Projects', `
    <p>Select a project card. The detail below it shows what the orchestrator published and what runs now.</p>
    <p><b>Current Owner goal</b> shows the durable direction set by the Owner. Keep it in every status publication until the Owner changes or clears it.</p>
    <p>The bar above the cards shows the applied share and the effective slots of each project, in card order. Its colors match the top edge of each card. An idle project is faded. A paused project is faded and striped.</p>
    <h3>Progress and frontier</h3><p><b>Current frontier</b> is open work with no open blocker. <b>Next</b> waits only on the current frontier. The orchestrator can set both itself.</p>
    <h3>Needs your decision</h3><p>Open work that waits on you. Each item shows its ID, title, and ask, and links to its Mailbox conversation when the orchestrator set <code>mailboxId</code>. A task that waits on other tasks shows <b>waiting on #ID</b>. A task that waits on the Boss or an external party names it and shows the ask.</p>
    <h3>Board</h3><p>The board has five columns in the order of the flow. <b>Blocked</b> holds a task that waits on another task, the Owner, the Boss, or an external item. <b>Ready</b> holds a task whose dependencies are all done. <b>Doing</b> holds a task with a live worker. <b>Review</b> holds a task whose worker was collected and is not merged. <b>Done</b> shows the last 10 done tasks. Select <b>Show all N done</b> to see the rest.</p>
    <p>Each card shows the task ID, the title, what the task waits on, and its worker. A Doing card shows the worker, the model, the elapsed time, and the source, for example <b>live from worker NAME</b>. The state comes from the worker records, so it does not wait for a publish. Ready sorts by priority: the critical path first, then the group order, then the published order. A Blocked card always shows a reason. When the status names no blocker, the card says so. The <b>Board</b> page shows the tasks of all projects, and its card links open this page with the task selected.</p>
    <p>A <b>stale</b> mark with its reason shows when the published status does not match the workers or is too old. The orchestrator clears it with a new publish.</p>
    <h3>Select a task</h3><p>Select a card title to select the task. The card gets a ring, and the graph shows the task and its dependency chain; the other tasks fade. Select a graph box to select its task and go to its card. On a Blocked card, select a blocker ID to go to that task. Select the selected task again to clear the selection. A refresh keeps the selection and the scroll position.</p>
    <h3>Dependencies</h3><p>The graph uses the same states and colors as the board. Each box names its state. Columns show the order. An arrow runs from a blocker to the work that waits on it. A task without links sits in the first column, after the linked tasks. <b>Open work only</b> shows the open tasks and the done tasks that block them directly. Clear it to show all tasks.</p>
    <p>The orange line is the critical path: the longest chain of open tasks to the next milestone. The next milestone is the first group with open work. Its boxes say <b>path</b>, and its cards say <b>critical path</b>.</p>
    <h3>Graph view</h3><p>The graph fits the panel until you zoom or pan it. A wide graph starts at its left edge at a zoom that keeps the text readable. Select <b>Fit</b> to show the whole graph. Select <b>−</b>, <b>+</b>, or <b>100%</b> to zoom. Press Ctrl or Cmd and turn the mouse wheel to zoom around the pointer. Drag the background to pan. Select <b>Full size</b> to fill the window. Select <b>Close</b> or press Escape to return.</p>
    <h3>Groups and specs</h3><p>Progress per release or phase, and the work under each spec.</p>
    <h3>All work</h3><p>The list sorts and filters all work by the published status.</p>
    <h3>Project continuity</h3><p>Plan a handover to another harness. Prepare copies the published Owner goal to the successor. The handover record shows the goal as one collapsed line. A Claude successor gets <code>/goal</code> once, after it answers. An invalid published goal, such as a blank value or a value over 1000 characters, is omitted. If migration is unavailable or fails, Prepare starts fresh and records the reason. Fresh preparation captures at most 200 recent source-pane lines and 20,000 characters, and both caps include the truncation marker. It redacts likely credentials and marks the snapshot as historical context. If recent text is unavailable, it tries the visible pane; if both reads fail, it marks context unavailable. The successor only reads and reports until activation. Inspect its answer, then confirm activation. For a project, activation labels the successor <b>orch</b> and the old pane <b>orch previous</b>. For the Boss, it labels them <b>boss</b> and <b>boss previous</b>. Herdr Boss closes the old pane and renames the successor tab to <b>Orchestrator</b> when the successor has answered, or after 15 minutes with the old pane idle. It never closes a pane that works or a pane of a project with a running worker, and it does not do this for the Boss. It tells the Boss when the old pane is still busy after 60 minutes. The Overview shows <b>closing old orchestrator at</b> a time until then. Otherwise it closes the old pane after 120 minutes when the same handoff and pane roles are still confirmed. Unavailable pane data defers retirement until a later engine tick. The successor gets one notice after retirement. The old agent is asked for a final summary for the successor. A project handover notifies the project workers and the Boss. A Boss handover notifies the Boss-workspace peers and the Owner.</p>
    <h3>Phone</h3><p>On a phone, the long sections start collapsed. Select a section title to open it. The dashboard remembers each open section for this project during the session. Overall progress, the frontier, and the board stay open.</p><p>The board shows one column at a time. The tab bar above it shows each column with its count. Select a tab or swipe sideways to change the column. The graph has its natural size and scrolls sideways in its own box.</p>
    <h3>AGENTS.md drift</h3><p><b>AGENTS.md drift</b> shows the errors and warnings that <b>herdr-boss publish</b> found in the project AGENTS.md. An error is a missing, old, or hand-edited Herdr Boss stub, or a missing, old, or hand-edited kit file <code>docs/orchestration/herdr-boss.md</code>. A warning is stale orchestration text, such as a fixed pane ID, a dated line, a copied model list, or text that sends pushes or product decisions to the Boss. Run <b>herdr-boss check agents</b> in the project for each finding. Run <b>herdr-boss kit install</b> to fix an error.</p>
    <h3>Files</h3><p><b>Files</b> shows the paths that the orchestrator reads: the project memory file, the installed kit file, and the Boss memory file. The home folder shows as <b>~</b>. The panel shows paths only. It never shows the contents of a memory or kit file.</p>
    <h3>Worker config</h3><p><b>Worker config</b> shows the fields that Herdr Boss read from <code>.herdr-boss.json</code> in the project repository. A <b>config</b> tag marks a field that the file sets; the other fields use the default. The <code>setup</code> command shows as <b>set</b> or <b>not set</b>, and a home folder path shows as <b>~</b>. Change a field in <code>.herdr-boss.json</code> in the repository.</p>
    <h3>Kit revision</h3><p><b>Kit revision</b> shows the kit revision that the orchestrator loaded, from <code>kitRevision</code> in its status file, and the current kit revision. A muted line shows when the project is behind on changes that need no action (<b>behind (useful only)</b>). A warning shows when the project is behind on a required change, or when its revision is not in the change log. The <b>Kit updated</b> notice then tells the orchestrator to run <b>herdr-boss kit update</b> and to continue. The command prints the kit file. A working orchestrator that stays behind on a required change for 2 hours gets one reminder. The command first prints a digest of the kit changes since the installed kit revision. The digest names the impact and the summary of each change, oldest first. The command then installs the kit as <b>herdr-boss kit install</b> does. The Claude session hook runs <b>herdr-boss kit update --quiet</b> at each session start. <b>worker start</b>, <b>publish</b>, and <b>handoff</b> print one line when the project kit is behind for a required or useful change.</p>
    <h3>Stale status</h3><p><b>Status stale: AGE</b> shows next to the updated time when the published status is older than 2 hours and, after that publish, a worker was working in the last 2 hours or new commits landed on the project repository. A paused project is never stale. The orchestrator gets one notice for each stale status. Publish the current plan and progress to clear the mark.</p>
    <p>The data comes from the project's status file. When a section is missing, the orchestrator has not published those fields.</p>`],
  mailbox: ['Mailbox', `
    <p>Use the folders to read messages from the Boss and project orchestrators. The page groups each conversation by its project or the Boss and by its reply chain.</p>
    <h3>Folders</h3><p><b>Needs you</b> is the default folder when an open item needs an answer, approval, or decision. <b>Inbox</b> holds all open items: Needs you first, then reports and updates. <b>Reports and updates</b> holds open information items with action <code>read</code> or no action. Opening an item marks it read. <b>Done</b> holds closed or dismissed items and relayed messages. <b>Sent</b>, below the divider, holds your messages with the queued, delivered, failed, or relayed state and the reply time.</p>
    <p>The folder stays in the page address. The page remembers your last folder. When Needs you has items, it opens that folder by default. When it is empty, the page says <b>Nothing needs you</b> and links to the Inbox.</p>
    <h3>Rows</h3><p>Each row is one conversation. It shows the project or the Boss, the message count, the action tag, the subject, a preview, and the time. An unread row is bold and has a dot. Select a row to open the conversation. Select one or more check boxes in Needs you to dismiss items without an answer. The page asks you to confirm. Dismissal sends nothing.</p>
    <h3>Conversations</h3><p>The conversation shows Owner and agent messages in time order. Each message and each report shows as formatted Markdown. Opening an item marks it read. On a desktop the conversation opens at the right of the list. On a phone it fills the screen. Select the Back arrow to return to the list.</p>
    <h3>Refresh</h3><p>The page reads new data every 30 seconds. It changes only the rows and messages that changed. It keeps the open conversation, the selection, the typed text, the caret, and the scroll position. The refresh waits until 3 seconds after you last type or scroll.</p>
    <p>Use the reply box to answer the last agent message. The page asks you to confirm each send. Herdr Boss delivers the message when the agent is working, idle, or done.</p>
    <h3>Markdown</h3><p>The page shows headings, bold, italic, lists, task lists, tables, code, quotes, rules, and links. A wide table or code block scrolls sideways in its own box. Raw HTML shows as text. A link opens only when it uses <code>http</code>, <code>https</code>, or <code>mailto</code>, or a local path. An external link opens in a new tab.</p>
    <h3>Actions</h3><p><b>Answer</b>: type an answer and select <b>Send</b>. <b>Approve</b>: select <b>Approve</b> or <b>Decline</b>. A note is optional. <b>Decide</b>: select a choice, or type an answer and select <b>Send</b>. Choice buttons appear when the message has a Markdown list under a <b>Choices</b> heading. Each answer uses the same delivery limit and safety checks as a new message. An answered item moves to <b>Done</b>.</p>
    <h3>Compose</h3><p>Select <b>New message</b> to write to the Boss or a project with an <code>orch</code> pane. The page asks you to confirm before it sends. The new conversation opens in <b>Sent</b>.</p>
    <h3>Phone</h3><p>The Mailbox fills the screen. The page header does not show. Select the menu button at the top left to open the drawer with the folders, the other pages, and Help. A dot on the menu button shows unread chats. Select <b>New</b> at the bottom right to write a message. The desktop Mailbox badge shows unread Needs-you items.</p>
    <p>The folder pane shows the fixed limits: Herdr Boss keeps messages for 30 days and accepts at most 10 Owner messages a minute. A read-only preview shows messages and refuses a read or a send.</p>`],
  chat: ['Chat', `
    <p>The Chat page shows one conversation for the Boss and one for each project orchestrator. The page has no large heading. On a desktop the chat list and the open chat fill the window. Above the conversation there is one slim bar with the avatar, the chat name, and a link to the Mailbox.</p>
    <h3>Channels</h3><p><b>Chat</b> holds the conversation. A normal reply, an Owner message, a nudge, and a status request stay in Chat only. A reply that asks you for an <b>answer</b>, an <b>approval</b>, or a <b>decision</b> shows in Chat and in Mailbox <b>Needs you</b> while it is open. A <b>report</b> from the Boss is mail. It shows in Mailbox <b>Updates</b> and as one short line in Chat. A normal reply never shows in Updates.</p>
    <h3>Top bar</h3><p>The top bar has three icons: chat unread, mail unread, and open action items. An icon with nothing to show is faded and has no count. An icon with something to show is bright and shows the count. <b>Needs action</b> is the most visible icon. The three icons are on a desktop and on a phone. On a phone the Mailbox and the Chat hide the top bar, and the menu drawer shows the counts.</p>
    <h3>Layout</h3><p>The chat is compact. A bubble has slim padding and no card frame. The time is 11 px. The composer is one line and grows to 6 lines. Its send button is a round button. A list row is 72 px high. The first line holds the title and the time. The second line holds the last message and the unread badge. The row keeps a touch target of at least 44 px on a phone.</p>
    <h3>List</h3><p>Each row shows the title, the last message on one line, the time, and the unread count. A report shows as <b>Report: TITLE</b>. The newest chat comes first. The menu badge shows the total unread count. The list follows the message stream. It never reloads the page. The automatic refresh keeps the list and conversation scroll. It waits until 3 seconds after you last type or scroll.</p>
    <h3>Conversation</h3><p>Select a row to open the chat. Your messages sit on the right, and the agent messages sit on the left. Each bubble shows the text as formatted Markdown and the time. A wide table or code block scrolls sideways inside the bubble. Raw HTML shows as text. Your bubble also shows the delivery state: <b>queued</b>, <b>delivered</b>, or <b>failed</b> with the reason. Opening a chat marks the messages to you as read.</p>
    <p>Scroll up to read older messages. The page asks for the page before the oldest message and keeps your reading position. It stops at the oldest message in the store. The store keeps messages for 30 days.</p>
    <p>A new message goes at the bottom. The page scrolls down only when you already read the newest message. Otherwise it shows a <b>new messages</b> pill. Select the pill to go to the newest message.</p>
    <h3>Composer</h3><p>Select the round send button or press Enter to send the message. Select Shift and press Enter to make a new line. The text area grows with the text, up to 6 lines. A message holds at most 2000 characters. The service accepts at most 10 messages a minute.</p>
    <p>The page shows your message as <b>queued</b> at once. The stored record replaces it when the service stores it. A refused send marks the bubble <b>failed</b> and shows <b>Retry</b>. Select <b>Retry</b> to send the same text again.</p>
    <h3>Action cards</h3><p>A message from an agent that asks for a decision shows as a normal bubble with one small button per option. The bubble holds a short question line. The page drops the choice list from the text, because the buttons hold the choices. A message with no real choice shows as a plain bubble with the <b>Open in Mailbox</b> link.</p>
    <p><b>Approve</b> and <b>Reject</b> answer an approval. <b>Later</b> only collapses the card. It writes nothing, and the Mailbox item stays open. A <b>decide</b> message with a Markdown list under a <b>Choices</b> heading shows one button for each choice. A decide with the choices <b>Yes</b> and <b>No</b> shows those two buttons. An <b>answer</b> message shows a one-line text field and <b>Send</b>.</p>
    <p>The card uses the same send route as the Mailbox. The item closes and the bubble shows the result, for example <b>Approved 22:05</b>. A closed item shows as a normal bubble with the result of the answer that closed it. Select <b>Open in Mailbox</b> to see the item in the Mailbox.</p>
    <h3>Keyboard</h3><p>The chat list is a list of buttons. The arrow keys, <b>Home</b>, and <b>End</b> move through the rows. Enter opens a chat. The focus then goes to the message field. <b>Escape</b> goes back to the list, and the focus goes to the row of the chat that was open. The message list is a live region, so a screen reader reads each new message once. Each bubble has a name with the sender, the time, the text, and the state.</p>
    <h3>Phone</h3><p>The Chat fills the screen. The page header does not show. Select the menu button to open the drawer with the other pages and Help. Select a chat to open it full screen. The slim bar has the Back arrow. When the keyboard opens, the composer stays above it. The card buttons and the send button are at least 44 px.</p>
    <p>A read-only preview shows the chats and refuses a send. It also refuses a read, so the unread count stays.</p>`],
  allocation: ['Allocation', `
    <p>The resource policy for all projects. Changes are a draft until you select <b>Apply policy</b>.</p>
    <h3>Capacity and handover</h3><p>The global limit of working agents, the lending of unused slots, the quota reserve, and automatic handover with its activation level. Automatic handover prepares a successor only for a workspace that has a working agent or a running worker. It skips a project that is paused or stood down in its published status or summary, and it activates a successor only when that model is not weaker than the source model. It never runs for the Boss. The context token setting starts a second trigger: at a task boundary, an idle Claude orchestrator with a context above this many tokens gets a fresh successor with the same model.</p>
    <h3>Orchestrator succession</h3><p>The ranked successors for automatic handover. Use the arrows to change the order. Unlisted choices are never selected automatically.</p>
    <h3>Workspace projects</h3><p>Clear a workspace switch to include that workspace as a project. An excluded workspace stays on Agents and shows <b>Not a project</b>. It gets no project share or worker slots. Herdr Boss stores workspace labels and resolves saved Herdr IDs to labels. The Boss workspace stays excluded while a pane is labelled <code>boss</code>.</p>
    <h3>Project shares</h3><p>Drag a boundary on the bar, or focus it and use the arrow keys. Projects to the left stay fixed; the rest share the remainder. A share is advisory. The mode sets a project to auto, active, idle, or paused.</p>
    <p>The <b>set share</b> is the share in your policy draft. The bar widths show it. The <b>effective share</b> is the number of worker slots the project has now, divided by the applied maximum of working agents. It changes only after you select <b>Apply policy</b>.</p>
    <p>A bar label such as <b>30% · 2</b> shows the set share and the effective slots. A narrow segment shows fewer labels; its tooltip shows all values.</p>
    <p>An idle project is faded. A paused project is faded and striped.</p>
    <p>When <b>Borrow idle shares</b> is on, a project lends its unused slots to the projects that use all their slots. An idle or paused project lends all its slots. Another project always keeps its base slots. It offers its unused slots to other projects and does not lose them. The lent and offered slots go to the full projects by share. When no project is full, no project lends. A project row shows <b>N lent</b> for an idle project, <b>N free for others</b> for a project with unused slots, and <b>+N borrowed</b> for a full project. Borrowed slots are real capacity. The global limit still applies.</p>
    <h3>Locks</h3><p>The panel lists machine locks. Each row shows the lock name, holder project and pane, kind, age, time left, and state. When no lock exists, the panel shows <b>No machine locks are held.</b> A manual lock expires after 60 minutes. A command lock ends when its command ends. Herdr Boss takes over a stale lock. The history line above the table shows the median hold time and the median wait time of all locks in the last 7 days, and of each lock name. A re-entrant suite under a push is not part of the medians. Before the first lock change, it shows <b>No lock history yet.</b> You cannot release a lock from this panel.</p>
    <h3>Resource leases</h3><p>Each pool lists its items and the holder of each item. The head shows the held and free counts, the lease TTL, and the reclaim rule. A held row shows the holder project, the pane or worker, the lease age, and the time left. <b>borrowed</b> marks an item of another project's split. For <code>project-browsers</code>, the panel lists only the held ports and the number of free ports; that pool has 77 ports. An invalid resource pool shows an error line.</p>
    <p>Select <b>Release</b> to give a lease back. The page asks you to confirm, and names the pool, the item, the holder project, and the pane or worker. The release removes the lease only while its holder project is still the project that the page shows. Otherwise the page reports that the lease changed, and you reload the page. A release never stops a process. For a project browser that runs, the button is disabled until you close the browser on the Browsers page.</p>
    <h3>Manage pools</h3><p>Select <b>Add pool</b> to create a pool. Enter one item per line or separate items with commas. Enter the project split as JSON. Set the environment variable, lease TTL, reclaim check, and grace period. Keep ports 9222 to 9299 out of custom pools. Select <b>Edit</b> to change a config pool. Select <b>Remove</b>, then confirm the pool name, to remove it. A held item blocks removal and any update that drops it. Herdr Boss saves the change to <code>config.json</code> and applies it at once. The built-in <code>project-browsers</code> pool has no edit or remove controls. The read-only preview refuses pool changes.</p>`],
  settings: ['Settings', `
    <p>Each harness section holds the models and provider routes of that harness. Provider quotas and machine limits are below the harnesses.</p>
    <h3>Avatars</h3><p>The <b>Avatars</b> section has one row for the Boss and one row for each project. A row shows the avatar of that chat. Select <b>Upload image</b> to use your own image. Select <b>Reset</b> to use the generated avatar again. An image is a PNG, JPEG, or WebP file of at most 512 KB. Herdr Boss keeps no other format. The image shows at once in the Chat, the Mailbox, and the Agents chart. Without an image, the page uses a generated avatar. Its color comes from the name of the project, and it stays the same. The two letters come from the project display name, the same on every page. The Boss has a crown. Each other project has two letters. The letters use the color of the best contrast on the circle.</p>
    <h3>Watch</h3><p>The <b>Watch</b> box is on the <b>Agents</b> page. Select the link on this page to open it.</p>
    <h3>Watch routines</h3><p>Each routine in the <b>Watch routines</b> section has a title, a model hint, a schedule, and a prompt text. Select a routine to edit it. The schedule is a number of minutes between runs, or a time before the end of the watch. Select <b>Save</b> to store the change on this machine. The change never edits the kit file, and it applies to the next prompt of a running watch. Select <b>Reset to the kit text</b> to remove your change. Use <b>Add a routine</b> to create your own routine. Turn routines on or off for a watch in the Watch box on the Agents page.</p>
    <h3>Service settings</h3><p>The table shows the values that the service uses. Each row shows whether the value comes from <code>config.json</code> or a default. Rows with inputs can be changed in the dashboard. Change the values in a group, then select <b>Save</b>. Herdr Boss applies saved values at once. Keep the quota warning below the critical value. Rows without inputs are read-only. Change in <code>config.json</code> and restart.</p>
    <h3>Token prices</h3><p>The <b>Token prices</b> section lists the price of each model in USD per million tokens: input, output, cache read, cache write for 5 minutes, and cache write for 1 hour. It shows the source and date of each entry. <b>unconfirmed</b> marks a figure that does not match the published pricing rule. Herdr Boss shows the cost as an <b>API-price equivalent</b>, because a subscription is not billed per token. Change a figure and select <b>Save prices</b>. A blank field uses the default. <b>Reset to defaults</b> removes all changes. A figure that you save is no longer unconfirmed.</p>
    <h3>Harness readiness</h3><p>This read-only table shows the status of each harness entry that orchestration needs. A row shows the status, the area, and the item. The status is <code>ok</code>, <code>missing</code>, or <code>bad</code>. The table shows no file path and no setting value. Herdr Boss reads these entries at each service start and then every 10 minutes. Run <code>herdr-boss harness sync</code> to see the changes to make.</p>
    <h3>Harnesses</h3><p>Clear <b>Available</b> to stop all workers from using a harness. The preferred model is the model that worker start and handover use when no model is given. An empty choice uses the harness default.</p>
    <p>Each model row has a box and a provider. Clear the box to stop that harness from using the model. Choose a provider to count the model against that provider quota. Choose <b>Unmetered</b> when no quota applies.</p>
    <p>A Codex row offers only <b>Codex</b> and <b>Unmetered</b>. A Claude row offers only <b>Claude</b> and <b>Unmetered</b>. Opencode and Pi rows offer <b>Claude</b>, <b>Codex</b>, <b>OpenCode Go</b>, and <b>Unmetered</b>. </p>
    <p>An old <code>modelProviders</code> route can send a Codex or Claude model to another provider. Herdr Boss ignores that route and treats the model as Unmetered in that harness. The row shows <b>Ignored</b> and a note. Choose a provider in the row to store a compatible route for that harness. Apply policy refuses a save while an available Codex or Claude harness still has an ignored route.</p>
    <p>Apply policy removes references to models that no harness allows any more, and repeated entries. It removes them from the routes, the disabled lists, the local models, the excluded lists, and the preferred models. The status line names each removed model and the list that held it. Other invalid values still stop the save and show an error.</p>
    <p>A model can be in more than one harness. Each harness keeps its own box and provider for it, so a change in one harness does not change another.</p>
    <p>Pi also uses seven unmetered OpenCode Zen entries: <code>opencode/big-pickle</code>, <code>opencode/ling-3.0-flash-fin-free</code>, <code>opencode/mimo-v2.6-flash-free</code>, <code>opencode/muse-spark-1.2-contributor-free</code>, <code>opencode/muse-spark-1.3-contributor-free</code>, <code>opencode/nemotron-3-ultra-free</code>, and <code>opencode/nemotron-3.5-lightning-free</code>. They start unmetered and appear as Pi rows here. <code>opencode/space-bunny-free</code> has no Pi catalog entry, so Pi refuses it. Catalog support does not guarantee a configured account or live provider availability.</p>
    <h3>Add a model</h3><p>Type a model string in a harness section and select <b>Add model</b>. Use letters, digits, dots, underscores, slashes, and hyphens. Spaces and shell characters are refused. A new model is marked <b>local</b>, starts unmetered, and is stored in the local policy, not in <code>kit/models.json</code>. Select <b>Remove</b> to delete a local model.</p>
    <h3>Provider quotas</h3><p>Quota colors use the warning and critical values from <code>config.json</code>. Settings shows both values.</p>
    <p>Choose <b>Manage pace</b> or <b>Ignore quota</b> for each provider. Ignore quota turns off pacing and pace warnings for worker dispatch. Handover risk and automatic handover still use live quota data. A live window at 100% or more still exhausts the provider until its reset, and worker start refuses it unless you use <code>--force</code>. Enter a whole pacing goal percent from 0 to 100. Leave it blank for 100%. Choose <b>At reset</b>, a one-off local date and time, or whole hours before each reset. A goal end must be after now, after the window start, and no later than reset. A one-off goal clears after its time or window reset. A recurring end stays in later windows.</p>
    <p>The quota card, bulletin, and lanes show each goal as <code>goal: 100% by Thu 8 Oct</code>. The text shows the time for a one-off end within 48 hours. A trickle allowance uses the goal percent and days left to a future goal end. After that end, it uses the unused quota and days left to reset. Without a goal end, it uses the goal percent and days left to reset. For a timed end, runs-out advice estimates when the rate reaches the goal percent. It names the goal end when that happens before the end.</p>
    <p>The Machine section sets the guard, CPU limits, 5-minute load backstops, the Owner idle period, disk warning thresholds, the swap thresholds, and the notice cooldown. Turn the guard off to stop CPU and load warnings and worker-start blocks. Choose a pause length to suspend those rules until the expiry time. Select <b>Resume guard</b> to end a pause early. Memory, disk, and swap warnings stay on. The swap warning needs 3 samples in a row at or above the swap warning percent, with at least the minimum GB in use. It clears when swap is 5 points below the warning percent. Leave the swap warning percent blank to turn it off. The swap refusal percent has no effect yet.</p>
    <p>Disk free space is measured on the filesystem that contains the Herdr Boss data directory. The warning threshold defaults to 20 GB free. The critical threshold defaults to 5 GB free. Free percent is information only. Herdr Boss shows it to one decimal place. Disk notices go to the project orchestrator when that project has linked worker worktrees. They include linked and prunable counts.</p>
    <p>When the guard is active, Herdr Boss blocks a worker start if total sampled CPU exceeds its configured limit or the 5-minute load average exceeds its configured backstop. Leave the away CPU limit or either load backstop blank to disable that threshold.</p>
    <p>Changes stay in a draft until you select <b>Apply policy</b>. A rejected save shows the server error and keeps your draft.</p>`],
  agents: ['Agents', `
    <p>One page with two views. The switch at the top changes the view. The <b>Chart</b> view shows the organization from the Owner down to the workers. The <b>List</b> view lists every Herdr workspace with its orchestrator and workers. Chart is the default. The URL holds the view as <code>?view=chart</code> or <code>?view=list</code>, and this browser remembers the last choice.</p>
    <h3>Watch</h3><p>The box at the top shows the watch state. Choose the end date and time in the picker. The default is the next 07:30: today when it is before 07:30, tomorrow otherwise. The length in hours shows next to the picker, and a warning shows above 48 hours. A watch has no maximum length. The end time must be in the future.</p>
    <p>Select <b>Until I cancel</b> to run the watch until you stop it. Then you can select <b>Daily report</b> and set a time, by default 07:30. A watch until cancelled sends no report unless you select this. Select <b>Quiet hours</b> to hold back the held actions.</p>
    <p>The <b>Routines</b> list shows the prompts that the service sends to the Boss pane during the watch. Clear the box of a routine to leave it out of this watch. Set its schedule: a number of minutes between runs, or a time before the end of the watch. A routine before the end has no run in a watch until cancelled.</p>
    <p>Write <b>Instructions for this watch</b> to add a text for this watch only. The service sends the text to the Boss with each routine, and to each orchestrator in the start notice. The box keeps your last choice of routines and schedules as the default of the next watch.</p>
    <p>Select <b>Start</b> to start the watch. While the watch runs, the box lists each routine with its next run and its last run. The service prompts the Boss only when the Boss pane is idle, and once for each run. If the Boss is busy, the service tries again until the next run is due, then skips the run. Select <b>Stop the watch</b> to end it. The page asks you to confirm first. The read-only preview refuses both actions.</p>
    <h3>Chart</h3><p>A chart of the organization, from top to bottom: the Owner, the Boss, one orchestrator for each project, and the workers under each orchestrator. The page cannot change resources. Use Settings for resources.</p>
    <h3>Nodes</h3><p><b>Owner</b> shows <b>At the Mac</b> or <b>Away</b> from the machine idle time. <b>Boss</b> shows the pane labeled <code>boss</code>, its harness and state, the quota use of a Codex or Claude harness, and the handover state. The Boss workspace workers are below the Boss.</p>
    <p>Each project node shows the orchestrator pane, harness, and state, the first published task with status <b>doing</b>, the worker slots in use against the slots and share, and the handover state. The projects use the project order. A workspace marked not a project has no node.</p>
    <p>A worker node shows the agent name, harness, and state. The task ID comes from the published task whose <b>worker</b> field names that agent.</p>
    <h3>Reserve</h3><p>A <b>reserve</b> node shows a prepared successor. It appears only when a handoff record is prepared, its source is the current orchestrator or Boss pane, and the successor pane is live. A recommended successor is not a reserve.</p>
    <h3>Details</h3><p>Select <b>Details</b> on a node to show its recorded values. Select <b>Hide details</b> to close them.</p>
    <h3>Style</h3><p>The style switch at the top selects the <b>Plain</b> and <b>Cards</b> styles. Plain is the default. This browser keeps your choice. If the browser cannot store it, the page uses Plain at the next load.</p>
    <p>In Cards, each agent node has a harness mark: Claude, Codex, OpenCode, Pi, or a question mark for an unknown harness. A Codex or Claude node shows a thin bar with its quota use. When the quota data is missing or the probe failed, the bar is empty and shows <b>quota unavailable</b>. When the last probe failed but an earlier reading exists, the bar shows that reading in a muted color. Point to the bar to see the time of the reading. A working node has a slow pulse on its border. A blocked node has the warning color and a warning icon. A failed node has the error color. An idle or done node is dimmed.</p>
    <p>In Cards, a new Owner message draws a short line with a moving dot from the Owner to the Boss or the orchestrator for about 1 second. A new worker report notice draws a line from the worker to its orchestrator. The page uses only the events that it already loads. When your system asks for reduced motion, the page shows a 1-second highlight on both nodes and no movement.</p>
    <h3>Phone</h3><p>On a phone, the chart has one column. Each worker list shows only a count. Select <b>Show</b> to expand the workers, and select <b>Hide</b> to collapse them.</p>
    <h3>Messages</h3><p>The Boss node and each project node have a <b>Messages</b> button. It opens the thread of that node. A thread holds the messages in both directions, oldest first.</p>
    <p>Type a message of up to 2000 characters and select <b>Send</b>. The nudge buttons send a fixed text: <b>Continue.</b>, <b>Use your free worker slots.</b>, or <b>Pause after the current task.</b> <b>Ask for status</b> asks the agent for a short status report and a new status file. The page asks you to confirm each send.</p>
    <p>A new message is <b>queued</b>. Herdr Boss delivers it when the agent is working, idle, or done. A blocked, unknown, or missing pane keeps it queued. Then the message shows <b>delivered</b> with a time. A <b>failed</b> message gets up to 3 more attempts on later ticks. Herdr Boss accepts at most 10 messages a minute.</p>
    <p>The Boss can run <code>herdr-boss messages relay ID... --by boss</code> to mark queued Owner messages as relayed. Herdr Boss never sends a relayed message. The thread shows its relay time and any reply time.</p>
    <p>The Boss and the orchestrators reply with <code>herdr-boss say</code>. The Boss can post a longer report with <code>herdr-boss mail post</code>. The page shows each message and each report as formatted Markdown. You cannot message a worker. Send a worker request to its orchestrator.</p>
    <p>The open panel reads the thread again every 10 seconds. A read-only preview shows the threads and refuses a send.</p>
    <h3>Data limits</h3><p><b>Not reported</b> means that the current state does not hold the value. Herdr Boss does not receive the model of a running agent. The page does not read a task from a pane title. It shows no pane output, messages, or secrets.</p>
    <h3>List</h3><p>Every Herdr workspace with its orchestrator and workers, live from Herdr.</p>
    <p>A status dot shows working, blocked, failed, idle, or done. Failed means the last visible worker output matched a known provider error, including <b>Free usage exceeded</b>. Herdr Boss reads only the last eight visible lines: on every tick while a worker is working, and when a worker first appears idle or done or changes into either state. A worker can show failed while Herdr still reports it working; the engine then does not count it as a running worker. The failed status clears when a later read shows no known failure, or when a different worker uses the pane. Herdr Boss sends the matched error label, worker name, and pane ID to the project orchestrator. Blocked workers get a notice after five minutes. Idle and done agents are ready for input; they have not always finished their task. Rows with the <b>orch</b> or <b>boss</b> label are orchestrators.</p>
    <p>An orchestrator that stays idle gets a nudge when its published status still has an actionable task: status <b>todo</b>, <b>doing</b>, or <b>review</b> with every task in its <b>blocked by</b> list done. The project must be in <b>auto</b> or <b>active</b> mode, no other worker in that workspace may work, be blocked, or have failed, and the idle period must reach the configured idle minutes. The notice names the task ID and title. Resume an idle or done worker on that task, or start suitable work. One key per project and task keeps the normal notice cooldown in charge; a different next task prompts again.</p>`],
  browsers: ['Browsers', `
    <p>One persistent Chrome per project. Agents drive it; you can watch and help.</p>
    <p>Each card shows the leased port and the CDP address <code>http://127.0.0.1:PORT</code> of the project, with a link to its row on the Allocation page.</p>
    <h3>Start and manage</h3><p><b>Open visible</b> or <b>Open headless</b> starts the browser. <b>Manage</b> restarts it in the other mode, closes it, or sets the window size for the next launch.</p>
    <h3>States</h3><p><b>ready</b>: Chrome runs with the project profile and answers on its debugging port. <b>not responding</b>: Chrome runs with the project profile, but its debugging port does not answer within 2 seconds. The preview is not available. Use <b>Manage</b> to restart or close it. If Chrome does not accept the close command, Herdr Boss sends SIGTERM to that Chrome process only. <b>offline</b>: no Chrome runs with the project profile. <b>port conflict</b>: another process uses the port.</p>
    <h3>Preview</h3><p><b>One tab</b> shows the selected tab with its address bar. <b>All tabs</b> shows every tab in one grid, without controls; select a tile to focus it. <b>Live</b> refreshes at the chosen interval. Without <b>Live</b>, the preview shows the last capture; <b>Refresh</b> takes a new one.</p>
    <h3>Tabs</h3><p><b>Agent</b> marks a tab an agent uses. Screenshots never change a page. Navigation and input on an agent tab ask for confirmation first. <b>Hidden</b> marks a tab that is not visible; some web apps do not draw there. <b>New tab</b> opens a page of your own. Each tab row has a <b>Close tab</b> control. Before it closes a tab that an agent holds, the page asks you to confirm. It also warns you before it closes the last tab. A close never stops the browser.</p>
    <h3>Address box</h3><p>The first focus of the address box selects all its text. A second click places a cursor where you select it.</p>
    <h3>Bookmarks</h3><p>A project keeps at most 30 bookmarks. A bookmark name has at most 60 characters. A bookmark URL must use http or https and must not hold a user name or a password. <b>Add current page</b> saves the selected tab. <b>Open</b> loads a bookmark in the current tab; <b>New tab</b> opens it in a new tab. <b>Rename</b>, the arrows, and <b>Delete</b> change the list; Delete asks you to confirm. <b>Start page</b> opens in the first tab of the next launch. <b>Save</b> stores the start page; a blank value clears it.</p>
    <h3>Control</h3><p>Select the screenshot to open the large view. The large view shows a still image of the last capture. Turn on <b>Control browser</b> or <b>Live</b> to refresh it at the chosen interval. Turn on <b>Control browser</b>, then click the image and type. Paste long text or a password into the masked field. On a phone the large view is full screen and the image fills the height. The text field and key controls appear only while <b>Control browser</b> is on.</p>`],
  analytics: ['Analytics', `
    <p>Recorded worker runs per project and provider: duration, outcome, and measured tokens.</p>
    <p>Token totals include only runs that report tokens. Coverage shows how many runs have measurements. Quota percentages are global per provider; they are not project token counts.</p>
    <h3>Denials and permission prompts</h3><p>Herdr Boss reads the Claude, Codex, OpenCode, and Pi logs every 15 minutes. It counts classifier refusals, sandbox errors, escalation requests, permission prompts, prompts with no answer within 10 minutes, OpenCode worker permission denials, and Herdr guard blocks. It keeps the day, harness, cause, project, model, and count. It keeps no message text.</p>
    <p>The small table shows counts for the last 7 days by harness, model, and cause. It shows up to 10 rows.</p>
    <p>The table shows the last 7 days by cause and project. The arrow compares the last 24 hours with the mean of the 6 days before. When a cause is above 2 times its mean and above 10 events, the page and the bulletin show <b>Discuss this trend with the Boss.</b> Herdr Boss sends no prompt to an orchestrator about it. While more than 1 MB of older logs is unread, the note waits, because the counts of older days are not complete.</p>
    <p>A read-only line shows the limits: the scan interval, the bytes for one scan, the days kept, and the rise rule.</p>`],
  logs: ['Logs', `
    <p>The top line tells whether Herdr Boss sends notices to orchestrators.</p>
    <p>Herdr Boss sends the <code>info</code> notices of a pane as one digest, at most once in 2 hours, and never while the pane works. <code>warn</code> and <code>critical</code> notices arrive at once.</p>
    <p>The guidance section shows the rules in force now, the same text as the bulletin that orchestrators read.</p>
    <p><b>Activity log</b> lists prompts sent to orchestrators, notifications, handovers, and stopped processes, newest first.</p>`],
};

function currentRoute() {
  if (/^\/(projects|p)(\/|$)/.test(location.pathname)) return 'projects';
  const name = location.pathname.slice(1);
  return HELP[name] ? name : 'overview';
}

function fillHelp() {
  const [title, body] = HELP[currentRoute()] || HELP.overview;
  document.getElementById('help-title').textContent = `${title} help`;
  document.getElementById('help-body').innerHTML = `${body}<p class="help-more">On a screen up to 760 px wide, use the menu button at the top to change pages. On the Mailbox and the Chat the menu button opens a drawer. Commands and setup: <code>docs/cli.md</code> and <code>docs/user-guide.md</code> in the Herdr Boss repository.</p>`;
}

function setHelp(open) {
  const panel = document.getElementById('help-panel');
  const toggle = document.getElementById('help-toggle');
  if (open) { fillHelp(); panel.hidden = false; requestAnimationFrame(() => panel.classList.add('open')); document.getElementById('help-close').focus(); }
  else { panel.classList.remove('open'); panel.hidden = true; if (document.activeElement && panel.contains(document.activeElement)) toggle.focus(); }
  toggle.setAttribute('aria-expanded', String(open));
}

document.getElementById('help-toggle').addEventListener('click', () => setHelp(document.getElementById('help-panel').hidden));
document.getElementById('help-close').addEventListener('click', () => setHelp(false));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($nav.classList.contains('open')) { setNavMenu(false); return; }
  if (!document.getElementById('help-panel').hidden && !document.getElementById('browser-viewer').open) setHelp(false);
});
$navMenu.addEventListener('click', () => setNavMenu(!$nav.classList.contains('open')));
$nav.addEventListener('click', (e) => { if (e.target.closest('a')) setNavMenu(false); });
document.addEventListener('click', (e) => {
  if (!$nav.classList.contains('open')) return;
  if (e.target.closest?.('#nav-menu') || e.target.closest?.('#primary-nav')) return;
  setNavMenu(false);
});

// ---------- Render loop ----------

// The Owner reads or types on the Mailbox and the Chat. An automatic render waits until the Owner pauses.
const OWNER_QUIET_MS = 3000;
let ownerActiveAt = 0;
let autoRenderTimer = null;
let ignoreScrollUntil = 0;

function ownerQuietWait(lastActiveAt, now) {
  return Math.max(0, lastActiveAt + OWNER_QUIET_MS - now);
}

function autoRender() {
  const wait = ['/mailbox', '/chat'].includes(location.pathname) ? ownerQuietWait(ownerActiveAt, Date.now()) : 0;
  if (wait) {
    if (!autoRenderTimer) autoRenderTimer = setTimeout(() => { autoRenderTimer = null; autoRender(); }, wait);
    return;
  }
  clearTimeout(autoRenderTimer);
  autoRenderTimer = null;
  render();
}

function markOwnerActive(e) {
  if (!['/mailbox', '/chat'].includes(location.pathname)) return;
  if (e.type === 'scroll' && Date.now() < ignoreScrollUntil) return;
  if (e.target === document || $app.contains(e.target)) ownerActiveAt = Date.now();
}
document.addEventListener('input', markOwnerActive, { capture: true, passive: true });
document.addEventListener('scroll', markOwnerActive, { capture: true, passive: true });

// The scroll containers to keep for each route. A position is restored only when its key is the same after the render.
function keptScrollKeys(route, mailbox, chat) {
  if (route === 'mailbox') {
    const view = mailbox.composing ? 'compose' : mailbox.currentConversation?.id || '';
    return { window: `${mailbox.folder}|${view}`, '.mail-list-scroll': mailbox.folder, '.mail-conversation-scroll': view };
  }
  if (route === 'chat') return { window: chat.thread || '', '.chat-list-scroll': 'list' };
  return {};
}

function captureScroll(route) {
  const keys = keptScrollKeys(route, mailbox, chat);
  const tops = {};
  for (const selector of Object.keys(keys)) tops[selector] = selector === 'window' ? scrollY : $app.querySelector(selector)?.scrollTop ?? null;
  return { keys, tops };
}

function restoreScroll(route, scroll) {
  ignoreScrollUntil = Date.now() + 250;
  for (const [selector, key] of Object.entries(keptScrollKeys(route, mailbox, chat))) {
    const top = scroll.tops[selector];
    if (top == null) continue;
    // A keyed patch keeps a scroll region node. When the view changed, for example to another folder, the region starts at the top.
    if (scroll.keys[selector] !== key) {
      const element = selector === 'window' ? null : $app.querySelector(selector);
      if (element) element.scrollTop = 0;
      continue;
    }
    if (selector === 'window') { if (scrollY !== top) scrollTo(scrollX, top); }
    else { const element = $app.querySelector(selector); if (element) element.scrollTop = top; }
  }
}

// A check can force a theme with ?theme=light or ?theme=dark. Without the parameter the page follows the system theme.
{
  const theme = new URLSearchParams(location.search).get('theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
}

// These routes keep their DOM across a render. A keyed patch changes only what changed.
const KEYED_ROUTES = ['projects', 'board', 'mailbox', 'chat'];

function render(force = false) {
  if (!state) return;
  if (!policyDirty) policyDraft = null;
  if (!force && policyDirty && ['/allocation', '/settings'].includes(location.pathname) && document.activeElement?.closest?.('#control-plane, #settings-plane')) {
    $updated.textContent = `updated ${ago(state.updatedAt)}`;
    return;
  }
  if (!force && Object.keys(priceDraft).length && location.pathname === '/settings' && document.activeElement?.closest?.('#price-settings')) {
    $updated.textContent = `updated ${ago(state.updatedAt)}`;
    return;
  }
  const legacy = /^\/p\/([^/]+)\/?$/.exec(location.pathname);
  if (legacy) history.replaceState(null, '', `/projects/${legacy[1]}`);
  // An old Organization link opens the Agents page in the Chart view.
  if (location.pathname === '/organization') history.replaceState(null, '', '/agents?view=chart');
  const m = /^\/projects\/([^/]+)\/?$/.exec(location.pathname);
  // A Board card links to /projects/<slug>?task=<id>. The page selects the task once, then drops the parameter from the address.
  const pick = m ? new URLSearchParams(location.search).get('task') : null;
  if (pick) {
    const slug = decodeURIComponent(m[1]);
    projectView(slug).selected = pick;
    history.replaceState(null, '', location.pathname + location.hash);
    requestAnimationFrame(() => { centerGraphOn(slug, pick); revealCard(slug, pick, 'center'); });
  }
  const route = m || location.pathname === '/projects' ? 'projects' : ['board', 'mailbox', 'chat', 'allocation', 'settings', 'agents', 'browsers', 'analytics', 'logs'].includes(location.pathname.slice(1)) ? location.pathname.slice(1) : 'overview';
  const page = route === 'projects' ? projectsView(state, m ? decodeURIComponent(m[1]) : null) : route === 'board' ? boardView(state) : route === 'mailbox' ? mailboxView(state) : route === 'chat' ? chatView(state) : route === 'allocation' ? allocationView(state) : route === 'settings' ? settingsView(state) : route === 'agents' ? agentsView(state) : route === 'browsers' ? browsersView(state) : route === 'analytics' ? analyticsView(state) : route === 'logs' ? logsView(state) : overview(state);
  const html = page;
  // The Mailbox and the Chat are app views: on a phone they fill the visual viewport and hide the page header.
  document.body.classList.toggle('app-view', APP_VIEW_ROUTES.includes(route));
  if (!APP_VIEW_ROUTES.includes(route)) appDrawerOpen = false;
  $navMenuLabel.textContent = NAV_LABEL[route] || 'Menu';
  for (const a of $nav.querySelectorAll('a')) {
    if (a.dataset.nav === route) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  updateMailboxBadge(state);
  updateWatchIcon(state);
  chatUpdateBadge();
  if (html !== lastRender) {
    const active = document.activeElement;
    const focusId = active?.dataset?.mailDraft || active?.matches?.('[data-mail-compose-draft], [data-mail-reply-draft]') ? active.id : null;
    const caret = focusId && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    // A field of the Watch box or of a routine editor keeps its focus and caret across a render.
    const watchField = active?.id && active.matches?.('#watch-adhoc, [data-rd], [data-routine-every], [data-routine-before]')
      ? { id: active.id, range: typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null } : null;
    const chatViewState = route === 'chat' ? chatCaptureView() : null;
    const scroll = captureScroll(route);
    if (KEYED_ROUTES.includes(route) && lastRoute === route) patchHtml($app, html);
    else $app.innerHTML = html;
    lastRoute = route;
    lastRender = html;
    if (watchField) {
      const field = document.getElementById(watchField.id);
      if (field) {
        field.focus();
        try { if (watchField.range) field.setSelectionRange(...watchField.range); } catch { /* A number or time input has no caret. */ }
      }
    }
    if (route === 'mailbox') mailRestoreDrafts(focusId, caret);
    if (route === 'chat') chatRestoreView(chatViewState);
    restoreScroll(route, scroll);
  }
  if (route === 'agents' && agentsViewMode() === 'chart') orgMotion(state);
  else orgEventMark = null;
  syncDepGraphs();
  syncBoards();
  syncTopHeight();
  if (!document.getElementById('help-panel').hidden) fillHelp();
  $updated.textContent = `updated ${ago(state.updatedAt)}`;
}

document.addEventListener('toggle', (e) => {
  if (e.target.matches?.('[data-quota-detail]')) quotaExpanded = e.target.open;
  if (e.target.matches?.('[data-machine-detail]')) machineExpanded = e.target.open;
  if (e.target.dataset?.browserManage) {
    if (e.target.open) browserManageOpen.add(e.target.dataset.browserManage);
    else browserManageOpen.delete(e.target.dataset.browserManage);
  }
  if (e.target.dataset?.projectFold) setFoldOpen(e.target.dataset.projectFold, e.target.dataset.foldKey, e.target.open);
  if (e.target.open && e.target.querySelector?.('[data-dep-stage]')) syncDepGraphs();
}, true);

// Re-render when the viewport crosses the phone breakpoint, so the desktop and phone treatments swap.
phoneMedia.addEventListener('change', () => { appDrawerOpen = false; lastRender = ''; render(); });

function updateShares() {
  const projects = allocationProjects();
  let cumulative = 0;
  const bar = document.querySelector('.allocation-bar');
  if (!bar) return;
  for (const [index, p] of projects.entries()) {
    const share = policyDraft.projects[p.slug].share;
    const segment = [...bar.querySelectorAll('[data-segment]')].find((x) => x.dataset.segment === p.slug);
    if (segment) {
      const text = segmentText(p, share);
      segment.style.width = `${share}%`;
      segment.title = text.title;
      segment.setAttribute('aria-valuenow', String(share));
      segment.setAttribute('aria-valuetext', text.value);
      const label = segment.querySelector('.allocation-share');
      if (label) label.textContent = `${share}%`;
    }
    const handle = bar.querySelector(`[data-boundary="${index}"]`);
    if (handle) {
      handle.style.left = `${cumulative + share}%`;
      handle.setAttribute('aria-valuemin', String(cumulative));
      handle.setAttribute('aria-valuenow', String(cumulative + share));
      handle.setAttribute('aria-valuetext', `${p.label} ${share} percent`);
    }
    cumulative += share;
  }
  for (const [slug, p] of Object.entries(policyDraft.projects)) {
    const row = [...document.querySelectorAll('[data-project-row]')].find((x) => x.dataset.projectRow === slug);
    if (!row) continue;
    row.querySelector('.share-value').textContent = `${p.share}%`;
  }
}

document.addEventListener('pointerdown', (e) => {
  const handle = e.target.closest?.('[data-boundary]');
  if (!handle || !policyDraft) return;
  e.preventDefault();
  handle.focus();
  handle.dataset.dragging = 'true';
  handle.setPointerCapture(e.pointerId);
});
document.addEventListener('pointermove', (e) => {
  const handle = e.target.closest?.('[data-boundary][data-dragging="true"]');
  if (!handle) return;
  const rect = handle.closest('.allocation-bar').getBoundingClientRect();
  moveBoundary(Number(handle.dataset.boundary), (e.clientX - rect.left) / rect.width * 100);
});
document.addEventListener('pointerup', (e) => { if (e.target.dataset?.dragging) delete e.target.dataset.dragging; });
document.addEventListener('pointercancel', (e) => { if (e.target.dataset?.dragging) delete e.target.dataset.dragging; });

// Dependency graph: Ctrl or Cmd with the wheel zooms around the pointer. A drag on the background pans.
let depDrag = null;
document.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const stage = e.target.closest?.('[data-dep-stage]');
  if (!stage) return;
  const svg = stage.querySelector('[data-dep-graph]');
  const rect = svg?.getBoundingClientRect();
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return;
  e.preventDefault();
  const z = depCurrentZoom(stage.dataset.depStage);
  if (!z) return;
  depZoomTo(stage.dataset.depStage, z * Math.exp(-e.deltaY * 0.0015), (e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
}, { passive: false });
document.addEventListener('pointerdown', (e) => {
  const stage = e.target.closest?.('[data-dep-stage]');
  if (!stage || e.button !== 0) return;
  if (e.target.closest?.('button, a, .dep-node-group')) return; // a drag on a task box keeps the selection working
  if (isPhone() && !depState(stage.dataset.depStage).full) return; // the phone box scrolls natively
  e.preventDefault();
  const st = depState(stage.dataset.depStage);
  depDrag = { slug: stage.dataset.depStage, pointerId: e.pointerId, x: e.clientX, y: e.clientY, cx: st.cx ?? 0, cy: st.cy ?? 0, zoom: st.zoom ?? 1 };
  stage.dataset.dragging = 'true';
  try { stage.setPointerCapture(e.pointerId); } catch {}
});
document.addEventListener('pointermove', (e) => {
  if (!depDrag || e.pointerId !== depDrag.pointerId) return;
  const stage = depStageEl(depDrag.slug);
  if (!stage) return;
  const st = depState(depDrag.slug);
  st.moved = true;
  st.cx = depDrag.cx - (e.clientX - depDrag.x) / depDrag.zoom;
  st.cy = depDrag.cy - (e.clientY - depDrag.y) / depDrag.zoom;
  depTransform(depDrag.slug);
});
function endDepDrag(e) {
  if (!depDrag || e.pointerId !== depDrag.pointerId) return;
  const stage = depStageEl(depDrag.slug);
  if (stage) { delete stage.dataset.dragging; try { stage.releasePointerCapture(e.pointerId); } catch {} }
  depDrag = null;
}
document.addEventListener('pointerup', endDepDrag);
document.addEventListener('pointercancel', endDepDrag);
document.addEventListener('click', (e) => {
  const btn = e.target.closest?.('[data-dep-action]');
  if (!btn) return;
  const slug = btn.dataset.depSlug;
  const action = btn.dataset.depAction;
  if (action === 'full') { setDepFull(slug, true); return; }
  if (action === 'close') { setDepFull(slug, false); return; }
  if (action === 'fit') { depTransform(slug, { fit: true }); return; }
  const z = depCurrentZoom(slug);
  if (!z) return;
  if (action === 'in') depZoomTo(slug, z * 1.25);
  else if (action === 'out') depZoomTo(slug, z * 0.8);
  else if (action === '100') depZoomTo(slug, 1);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const stage = document.querySelector('.dep-stage.full');
  if (stage) setDepFull(stage.dataset.depStage, false);
});
window.addEventListener('resize', () => syncDepGraphs());

// ---------- Board and graph selection ----------
const scrollBehavior = () => (reducedMotion.matches ? 'auto' : 'smooth');
let boardScrollAt = 0;

function boardColsEl(slug) {
  return [...document.querySelectorAll('[data-board-cols]')].find((el) => el.dataset.boardCols === slug) || null;
}

// Show one board column on the phone. The tabs follow the column in view.
function showBoardColumn(slug, key, { smooth = true } = {}) {
  const cols = boardColsEl(slug);
  const col = cols?.querySelector(`[data-col="${key}"]`);
  if (!col) return;
  projectView(slug).boardCol = key;
  markBoardTab(cols, key);
  if (!isPhone()) return;
  if (Math.abs(cols.scrollLeft - col.offsetLeft) > 2) cols.scrollTo({ left: col.offsetLeft, behavior: smooth ? scrollBehavior() : 'auto' });
}

// On a phone the swipe box takes the height of the column in view, not the height of the longest column.
function fitBoardHeight(cols, key) {
  const col = isPhone() && cols.querySelector(`[data-col="${key}"]`);
  const height = col ? `${col.offsetHeight}px` : '';
  if (cols.style.height !== height) cols.style.height = height;
}

function markBoardTab(cols, key) {
  fitBoardHeight(cols, key);
  for (const tab of cols.parentElement.querySelectorAll('[data-board-tab]')) {
    const on = tab.dataset.boardTab === key;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
  }
}

// After a render, the phone board shows the column of the selected tab. A swipe in progress keeps its place.
function syncBoards() {
  for (const cols of document.querySelectorAll('[data-board-cols]')) {
    const key = cols.parentElement.querySelector('[data-board-tab][aria-selected="true"]')?.dataset.boardTab;
    fitBoardHeight(cols, key);
    if (!isPhone() || Date.now() - boardScrollAt < 800) continue;
    const col = key && cols.querySelector(`[data-col="${key}"]`);
    if (col && Math.abs(cols.scrollLeft - col.offsetLeft) > 2) cols.scrollLeft = col.offsetLeft;
  }
}

document.addEventListener('scroll', (e) => {
  const cols = e.target?.dataset?.boardCols != null ? e.target : null;
  if (!cols || !isPhone()) return;
  boardScrollAt = Date.now();
  const index = Math.max(0, Math.min(FLOW.length - 1, Math.round(cols.scrollLeft / Math.max(1, cols.clientWidth))));
  const key = cols.children[index]?.dataset.col;
  if (!key || projectView(cols.dataset.boardCols).boardCol === key) return;
  projectView(cols.dataset.boardCols).boardCol = key;
  markBoardTab(cols, key);
}, true);

// Center the graph on a task node when the node is outside the visible part. The zoom stays.
function centerGraphOn(slug, id) {
  const svg = depStageEl(slug)?.querySelector('[data-dep-graph]');
  const node = [...(svg?.querySelectorAll('[data-task-select]') || [])].find((el) => el.dataset.taskSelect === id);
  const rect = node?.querySelector('.dep-node');
  if (!rect) return;
  const x = Number(rect.getAttribute('x')), y = Number(rect.getAttribute('y')), w = Number(rect.getAttribute('width')), h = Number(rect.getAttribute('height'));
  const stage = depStageEl(slug);
  if (isPhone() && !depState(slug).full) {
    if (x < stage.scrollLeft || x + w > stage.scrollLeft + stage.clientWidth) stage.scrollTo({ left: Math.max(0, x + w / 2 - stage.clientWidth / 2), behavior: scrollBehavior() });
    return;
  }
  const [vx, vy, vw, vh] = (svg.getAttribute('viewBox') || '').split(/\s+/).map(Number);
  if ([vx, vy, vw, vh].every(Number.isFinite) && x >= vx && y >= vy && x + w <= vx + vw && y + h <= vy + vh) return;
  const st = depState(slug);
  if (st.zoom == null) depTransform(slug);
  st.cx = x + w / 2; st.cy = y + h / 2; st.moved = true;
  depTransform(slug);
}

function revealCard(slug, id, block = 'nearest') {
  const card = document.getElementById(cardDomId(slug, id));
  if (!card) return;
  const fold = card.closest('details');
  if (fold && !fold.open) fold.open = true;
  const col = card.closest('[data-col]');
  if (col) showBoardColumn(slug, col.dataset.col);
  card.scrollIntoView({ block, inline: 'nearest', behavior: scrollBehavior() });
  card.querySelector('.card-title')?.focus({ preventScroll: true });
}

// A card title selects the task and shows its chain in the graph. A graph node or a blocker link selects the task and shows its card.
// Selecting the selected task from its card or its node clears the selection.
function selectTask(slug, id, reveal) {
  const view = projectView(slug);
  view.selected = view.selected === id && reveal !== 'card-link' ? null : id;
  lastRender = '';
  render();
  if (!view.selected) return;
  centerGraphOn(slug, id);
  if (reveal === 'card' || reveal === 'card-link') revealCard(slug, id);
}

document.addEventListener('click', (e) => {
  const pick = e.target.closest?.('[data-task-select]');
  if (pick) {
    e.preventDefault();
    const reveal = pick.classList.contains('wait-link') ? 'card-link' : pick.dataset.reveal;
    selectTask(pick.dataset.slug, pick.dataset.taskSelect, reveal);
    return;
  }
  const tab = e.target.closest?.('[data-board-tab]');
  if (tab) { showBoardColumn(tab.dataset.slug, tab.dataset.boardTab); return; }
  const more = e.target.closest?.('[data-board-done]');
  if (more) {
    const view = projectView(more.dataset.boardDone);
    view.doneAll = !view.doneAll;
    lastRender = ''; render();
  }
});

document.addEventListener('keydown', (e) => {
  const node = e.target.closest?.('g[data-task-select]');
  if (node && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    selectTask(node.dataset.slug, node.dataset.taskSelect, 'card');
    return;
  }
  const tab = e.target.closest?.('[data-board-tab]');
  if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault();
  const i = FLOW.indexOf(tab.dataset.boardTab);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? FLOW.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + FLOW.length) % FLOW.length;
  showBoardColumn(tab.dataset.slug, FLOW[next]);
  tab.parentElement.querySelector(`[data-board-tab="${FLOW[next]}"]`)?.focus();
});
document.addEventListener('keydown', (e) => {
  const viewer = document.getElementById('browser-viewer');
  if (viewer.open && e.target === viewer.querySelector(':scope > img') && viewer.querySelector('#browser-viewer-control').checked) {
    if (e.key === 'Escape') return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault(); flushViewerText(); queueViewerInput({ type: 'key', key: 'SelectAll' }); return;
    }
    if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) {
      e.preventDefault(); viewerTextBuffer += e.key;
      clearTimeout(viewerTextTimer);
      viewerTextTimer = setTimeout(flushViewerText, 80);
      return;
    }
    if (['Tab', 'Enter', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
      e.preventDefault(); flushViewerText(); queueViewerInput({ type: 'key', key: e.key }); return;
    }
  }
  const handle = e.target.closest?.('[data-boundary]');
  if (!handle || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault();
  const index = Number(handle.dataset.boundary);
  const value = Number(handle.getAttribute('aria-valuenow'));
  moveBoundary(index, e.key === 'Home' ? Number(handle.getAttribute('aria-valuemin')) : e.key === 'End' ? 100 : value + (e.key === 'ArrowRight' ? 1 : -1));
});

// The first focus of an address box selects all text. A second click places a normal cursor.
document.addEventListener('focus', (e) => {
  const input = e.target;
  if (!input.matches?.('.browser-navigate input[name="url"]')) return;
  if (input.dataset.selectAllForFocus) return;
  input.dataset.selectAllForFocus = input.dataset.selectAllPointer ? 'pending' : 'done';
  // Keyboard focus has no pointerup, so select at once. A pointer interaction selects on pointerup.
  if (input.dataset.selectAllForFocus === 'done') input.select();
}, true);

document.addEventListener('pointerdown', (e) => {
  const input = e.target.closest?.('.browser-navigate input[name="url"]');
  if (input) input.dataset.selectAllPointer = '1';
}, true);

document.addEventListener('pointerup', (e) => {
  const input = e.target.closest?.('.browser-navigate input[name="url"]');
  if (input) delete input.dataset.selectAllPointer;
  if (!input || input.dataset.selectAllForFocus !== 'pending') return;
  input.dataset.selectAllForFocus = 'done';
  if (document.activeElement === input) { e.preventDefault(); input.select(); }
}, true);

document.addEventListener('blur', (e) => {
  const input = e.target;
  if (input.matches?.('.browser-navigate input[name="url"]')) delete input.dataset.selectAllForFocus;
}, true);

document.addEventListener('input', (e) => {
  const addressForm = e.target.closest?.('.browser-navigate');
  if (addressForm && e.target.name === 'url') {
    const slug = addressForm.dataset.browserNavigate || document.getElementById('browser-viewer').dataset.project;
    if (slug) browserAddressDraft[slug] = e.target.value;
    return;
  }
  // The new-model field is not a policy value until Add model accepts it.
  if (e.target.dataset?.addModelInput) { e.target.removeAttribute('aria-invalid'); return; }
  if (!e.target.closest('#control-plane, #settings-plane') || !policyDraft) return;
  const el = e.target;
  if (el.dataset.policyNumber) policyDraft[el.dataset.policyNumber] = Number(el.value);
  if (el.dataset.policyText) policyDraft[el.dataset.policyText] = el.value;
  if (el.dataset.policyMachine) { policyDraft.machine ||= {}; policyDraft.machine[el.dataset.policyMachine] = el.value === '' ? null : Number(el.value); }
  if (el.dataset.pacingGoal || el.dataset.pacingEndValue) {
    const [provider, key] = (el.dataset.pacingGoal || el.dataset.pacingEndValue).split(':');
    policyDraft.pacingGoals ||= {};
    policyDraft.pacingGoals[provider] ||= {};
    const old = policyDraft.pacingGoals[provider][key];
    if (el.dataset.pacingGoal && el.value === '') {
      delete policyDraft.pacingGoals[provider][key];
      if (!Object.keys(policyDraft.pacingGoals[provider]).length) delete policyDraft.pacingGoals[provider];
    } else if (el.dataset.pacingGoal) {
      policyDraft.pacingGoals[provider][key] = typeof old === 'object' ? { ...old, percent: Number(el.value) } : Number(el.value);
    } else if (typeof old === 'object' && old.end?.type === 'at') {
      old.end.at = el.value && Number.isFinite(new Date(el.value).getTime()) ? new Date(el.value).toISOString() : '';
    } else if (typeof old === 'object' && old.end?.type === 'hoursBeforeReset') old.end.hours = el.value === '' ? null : Number(el.value);
  }
  markPolicyDirty();
});

document.addEventListener('change', (e) => {
  if (e.target.matches?.('[data-overview-guard-toggle]')) {
    updateOverviewMachineGuard('toggle', 1, e.target.checked);
    return;
  }
  if (e.target.dataset?.graphOpen) {
    projectView(e.target.dataset.graphOpen).graphAll = !e.target.checked;
    lastRender = ''; render();
    return;
  }
  const projectControl = e.target.dataset?.projectDone || e.target.dataset?.projectSort || e.target.dataset?.projectGroup;
  if (projectControl) {
    const view = projectView(projectControl);
    if (e.target.dataset.projectDone) view.showDone = e.target.checked;
    if (e.target.dataset.projectSort) view.sort = e.target.value;
    if (e.target.dataset.projectGroup) view.group = e.target.value;
    lastRender = ''; render();
    return;
  }
  if (e.target.dataset.browserInterval) {
    const slug = e.target.dataset.browserInterval;
    const interval = Number(e.target.value);
    if (!PREVIEW_INTERVALS.includes(interval)) return;
    browserPreviewIntervals[slug] = interval;
    browserNextRefresh[slug] = Date.now() + interval;
    try { localStorage.setItem(PREVIEW_INTERVAL_KEY, JSON.stringify(browserPreviewIntervals)); } catch {}
    return;
  }
  if (e.target.id === 'browser-viewer-control') {
    const viewer = document.getElementById('browser-viewer');
    for (const control of viewer.querySelectorAll('.browser-viewer-controls input, .browser-viewer-controls button')) control.disabled = !e.target.checked;
    const slug = viewer.dataset.project;
    if (e.target.checked) {
      viewer.querySelector(':scope > img')?.focus();
      browserNextRefresh[slug] = Date.now() + previewInterval(slug);
      refreshBrowserPreview(slug);
    } else {
      viewerTextBuffer = ''; clearTimeout(viewerTextTimer); viewer.querySelector('#browser-viewer-text').value = '';
      browserRefreshStopped(slug);
    }
    return;
  }
  if (e.target.dataset.browserLive) {
    const slug = e.target.dataset.browserLive;
    if (e.target.checked) { browserPreviewLive.add(slug); browserNextRefresh[slug] = Date.now() + previewInterval(slug); refreshBrowserPreview(slug); }
    else { browserPreviewLive.delete(slug); browserRefreshStopped(slug); }
    return;
  }
  if (e.target.dataset.ladderKind !== undefined || e.target.dataset.ladderModel !== undefined || e.target.dataset.ladderEffort !== undefined) {
    const i = Number(e.target.dataset.ladderKind ?? e.target.dataset.ladderModel ?? e.target.dataset.ladderEffort);
    const rung = policyDraft?.orchestratorLadder?.[i];
    if (!rung) return;
    if (e.target.dataset.ladderKind !== undefined) {
      rung.kind = e.target.value;
      rung.model = models[rung.kind].defaultModel;
      rung.effort = models[rung.kind].defaultEffort || null;
    } else if (e.target.dataset.ladderModel !== undefined) rung.model = e.target.value;
    else rung.effort = e.target.value;
    policyDirty = true; saveMessage = ''; lastRender = ''; render(true);
    return;
  }
  if (e.target.dataset.handoffTarget || e.target.dataset.handoffMode || e.target.dataset.handoffModel || e.target.dataset.handoffEffort) {
    const pane = e.target.dataset.handoffTarget || e.target.dataset.handoffMode || e.target.dataset.handoffModel || e.target.dataset.handoffEffort;
    if (e.target.dataset.handoffTarget) { handoffTargets[pane] = e.target.value; delete handoffModels[pane]; delete handoffEfforts[pane]; }
    else if (e.target.dataset.handoffModel) handoffModels[pane] = e.target.value;
    else if (e.target.dataset.handoffEffort) handoffEfforts[pane] = e.target.value;
    else handoffModes[pane] = e.target.value;
    delete handoffPlans[pane]; delete handoffMessages[pane];
    lastRender = ''; render();
    return;
  }
  if (e.target.dataset.handoffReviewed) {
    if (e.target.checked) handoffReviewed.add(e.target.dataset.handoffReviewed);
    else handoffReviewed.delete(e.target.dataset.handoffReviewed);
    lastRender = ''; render();
    return;
  }
  if (!e.target.closest('#control-plane, #settings-plane') || !policyDraft || e.target.dataset.addModelInput) return;
  const el = e.target;
  const d = policyDraft;
  if (el.dataset.workspaceExclusion !== undefined) {
    const label = el.dataset.workspaceExclusion;
    const workspace = (state.control.workspaces || []).find((item) => item.label === label);
    d.excludedWorkspaces = (d.excludedWorkspaces || []).filter((entry) => entry !== label && entry !== workspace?.workspace);
    if (el.checked) d.excludedWorkspaces.push(label);
    markPolicyDirty();
    lastRender = ''; render(true);
    return;
  }
  if (el.dataset.pacingEndType) {
    const [provider, key] = el.dataset.pacingEndType.split(':');
    d.pacingGoals ||= {};
    d.pacingGoals[provider] ||= {};
    const old = d.pacingGoals[provider][key];
    const percent = typeof old === 'object' ? old.percent : old ?? 100;
    d.pacingGoals[provider][key] = el.value === 'reset' ? percent : { percent, end: el.value === 'at' ? { type: 'at', at: '' } : { type: 'hoursBeforeReset', hours: null } };
    markPolicyDirty();
    lastRender = ''; render(true);
    return;
  }
  if (el.dataset.policyMachine) { d.machine ||= {}; d.machine[el.dataset.policyMachine] = el.value === '' ? null : Number(el.value); }
  if (el.dataset.policyMachineBool) { d.machine ||= {}; d.machine[el.dataset.policyMachineBool] = el.checked; }
  if (el.dataset.policyBool) d[el.dataset.policyBool] = el.checked;
  if (el.dataset.provider) d.providerModes[el.dataset.provider] = el.value;
  if (el.dataset.preferredModel) {
    d.preferredModels ||= {};
    if (el.value) d.preferredModels[el.dataset.preferredModel] = el.value;
    else delete d.preferredModels[el.dataset.preferredModel];
  }
  if (el.dataset.harnessRoute) {
    const kind = el.dataset.harnessRoute;
    d.harnessRoutes ||= {};
    d.harnessRoutes[kind] ||= {};
    // Each choice stores a compatible harness route, which overrides an ignored legacy route.
    d.harnessRoutes[kind][el.dataset.model] = el.value === 'unmetered' ? null : el.value;
    el.querySelector('[data-ignored-route]')?.remove();
    el.closest('.harness-model')?.querySelector('[data-route-note]')?.remove();
    el.removeAttribute('aria-describedby');
  }
  if (el.dataset.mode) d.projects[el.dataset.mode].mode = el.value;
  if (el.dataset.kind) {
    d.allowedKinds = el.checked ? [...new Set([...d.allowedKinds, el.dataset.kind])] : d.allowedKinds.filter((x) => x !== el.dataset.kind);
    if (!el.checked) for (const p of Object.values(d.projects)) p.excludedKinds = p.excludedKinds.filter((x) => x !== el.dataset.kind);
    pruneProjectModels(d);
  }
  if (el.dataset.harnessModel) {
    const kind = el.dataset.harnessModel;
    const m = el.dataset.model;
    d.disabledModels ||= {};
    if (!el.checked) d.disabledModels[kind] = [...new Set([...(d.disabledModels[kind] || []), m])];
    else {
      // A legacy global exclusion becomes one entry for each other harness, so enabling the model here changes no other harness.
      if (d.excludedModels.includes(m)) {
        d.excludedModels = d.excludedModels.filter((x) => x !== m);
        for (const other of Object.keys(models)) if (other !== kind && kindModels(other, d).includes(m)) d.disabledModels[other] = [...new Set([...(d.disabledModels[other] || []), m])];
      }
      d.disabledModels[kind] = (d.disabledModels[kind] || []).filter((x) => x !== m);
    }
    for (const k of Object.keys(d.disabledModels)) if (!d.disabledModels[k].length) delete d.disabledModels[k];
    pruneProjectModels(d);
  }
  for (const [key, attr] of [['excludeKind', 'excludedKinds'], ['excludeModel', 'excludedModels']]) if (el.dataset[key]) {
    const [slug, value] = el.dataset[key].split(':');
    d.projects[slug][attr] = el.checked ? [...new Set([...d.projects[slug][attr], value])] : d.projects[slug][attr].filter((x) => x !== value);
  }
  markPolicyDirty();
});

function settingsRerender(kind, focus) {
  lastRender = ''; render(true);
  document.querySelector(focus)?.focus();
  const status = document.querySelector(`[data-settings-message="${kind}"]`);
  if (status) status.textContent = settingsMessages[kind] || '';
}

async function saveServiceSettings(group, button) {
  const inputs = [...document.querySelectorAll(`[data-service-group="${CSS.escape(group)}"][data-service-setting]`)];
  const changes = {};
  for (const input of inputs) {
    const setting = input.dataset.serviceSetting;
    if (input.dataset.serviceLane) {
      changes[setting] ||= {};
      changes[setting][input.dataset.serviceLane] = input.value === '' ? null : Number(input.value);
    } else if (input.type === 'checkbox') changes[setting] = input.checked;
    else changes[setting] = input.value === '' && nullableServiceSettings.has(setting) ? null : Number(input.value);
  }
  const status = document.querySelector(`[data-service-settings-status="${CSS.escape(group)}"]`);
  button.disabled = true;
  if (status) status.textContent = '';
  try {
    const response = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changes }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Service settings could not be saved.');
    serviceSettingsMessages[group] = 'Saved.';
    if (state) {
      state.serviceSettings = result.settings;
      state.quotaThresholds = {
        warnPercent: result.settings.find(({ setting }) => setting === 'quota.warnPercent')?.value ?? state.quotaThresholds?.warnPercent ?? 90,
        criticalPercent: result.settings.find(({ setting }) => setting === 'quota.criticalPercent')?.value ?? state.quotaThresholds?.criticalPercent ?? 98,
      };
      lastRender = '';
      render();
    } else if (status) status.textContent = 'Saved.';
  } catch (error) {
    serviceSettingsMessages[group] = error.message;
    if (status) status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

// A new model joins only this harness. It starts enabled and unmetered.
function addExtraModel(kind, model) {
  const d = policyDraft;
  if (!d || !models[kind]) return;
  if (!MODEL_ID.test(model)) settingsMessages[kind] = 'Use letters, digits, dots, underscores, slashes, or hyphens. Start with a letter or digit. No spaces.';
  else if (kindModels(kind, d).includes(model)) settingsMessages[kind] = `${model} is already in ${kind}.`;
  else {
    d.extraModels ||= {};
    d.extraModels[kind] = [...(d.extraModels[kind] || []), model];
    d.harnessRoutes ||= {};
    d.harnessRoutes[kind] = { ...(d.harnessRoutes[kind] || {}), [model]: null };
    settingsMessages[kind] = `Added ${model} as unmetered. Apply policy to keep it.`;
    policyDirty = true; saveMessage = '';
    settingsRerender(kind, `[data-add-model-input="${kind}"]`);
    return;
  }
  const input = document.querySelector(`[data-add-model-input="${kind}"]`);
  const status = document.querySelector(`[data-settings-message="${kind}"]`);
  if (status) status.textContent = settingsMessages[kind];
  input?.setAttribute('aria-invalid', 'true');
  input?.focus();
}

// Removing a local model also removes its route, its disabled entry, its preferred choice, and its succession choices.
function removeExtraModel(kind, model) {
  const d = policyDraft;
  if (!d?.extraModels?.[kind]?.includes(model)) return;
  const ladder = (d.orchestratorLadder || []).filter((rung) => !(rung.kind === kind && rung.model === model));
  if (!ladder.length) {
    settingsMessages[kind] = `${model} is the only succession choice. Add another choice on the Allocation page first.`;
    const status = document.querySelector(`[data-settings-message="${kind}"]`);
    if (status) status.textContent = settingsMessages[kind];
    return;
  }
  d.orchestratorLadder = ladder;
  d.extraModels[kind] = d.extraModels[kind].filter((x) => x !== model);
  if (!d.extraModels[kind].length) delete d.extraModels[kind];
  if (d.harnessRoutes?.[kind]) delete d.harnessRoutes[kind][model];
  if (d.disabledModels?.[kind]) d.disabledModels[kind] = d.disabledModels[kind].filter((x) => x !== model);
  if (d.preferredModels?.[kind] === model) delete d.preferredModels[kind];
  pruneProjectModels(d);
  settingsMessages[kind] = `Removed ${model}. Apply policy to keep this change.`;
  policyDirty = true; saveMessage = '';
  settingsRerender(kind, `[data-add-model-input="${kind}"]`);
}

async function postJson(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || (result.errors || []).join(' ') || 'The request failed.'), { attached: result.attached === true });
  return result;
}

// A bookmark change returns the new list and the start page. Update the loaded session in place.
function applyBookmarkResult(slug, result) {
  const session = browserSessions.find((b) => b.project === slug);
  if (session) { session.bookmarks = result.bookmarks; session.startPage = result.startPage; }
  browserBookmarkDraft = null;
  browserMessages[slug] = 'Bookmarks saved.';
  lastRender = '';
  render();
}

async function postBookmark(slug, body) {
  const result = await postJson('/api/browser-sessions/bookmarks', { project: slug, ...body });
  applyBookmarkResult(slug, result);
  return result;
}

// Navigation and input on a tab that an agent holds need one confirmation per tab.
async function postBrowserAction(url, body) {
  const key = `${body.project}:${body.tab}`;
  try { return await postJson(url, { ...body, confirmAttached: browserConfirmedTabs.has(key) }); }
  catch (error) {
    if (!error.attached) throw error;
    if (!confirm('An agent is using this tab. Navigation or input can disturb its work.\n\nControl this tab anyway? Choose Cancel and use New tab for a page of your own.')) throw new Error('Cancelled: an agent is using this tab.');
    browserConfirmedTabs.add(key);
    return postJson(url, { ...body, confirmAttached: true });
  }
}

// A dialog, not window.confirm, so the confirmation is part of the page and shows on every screen.
function browserConfirm(question, action = 'Close tab') {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'browser-confirm';
    dialog.setAttribute('aria-label', 'Confirm tab close');
    dialog.innerHTML = '<p class="browser-confirm-text"></p><div class="browser-confirm-actions"><button type="button" data-browser-confirm="no">Cancel</button><button type="button" data-browser-confirm="yes" class="danger"></button></div>';
    dialog.querySelector('.browser-confirm-text').textContent = question;
    dialog.querySelector('[data-browser-confirm="yes"]').textContent = action;
    let answer = false;
    const finish = (result) => { answer = result; if (dialog.open) dialog.close(); };
    dialog.addEventListener('close', () => { dialog.remove(); resolve(answer); }, { once: true });
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); finish(false); });
    dialog.querySelector('[data-browser-confirm="no"]').addEventListener('click', () => finish(false));
    dialog.querySelector('[data-browser-confirm="yes"]').addEventListener('click', () => finish(true));
    document.body.append(dialog);
    dialog.showModal();
  });
}

// A close asks before it removes a tab that an agent holds. A close never stops the browser process.
async function closeBrowserTab(slug, tabId, button = null) {
  const tabs = browserTabs[slug] || [];
  const tab = tabs.find((candidate) => candidate.id === tabId);
  const agent = tab?.owner || (tab?.attached ? 'an agent' : null);
  const title = tab?.title || 'Untitled page';
  if (agent && !(await browserConfirm(`Tab ${title} belongs to ${agent}. Close it anyway?`))) return;
  if (tabs.length === 1 && !(await browserConfirm('This is the last tab. The browser keeps running with no page. Close it anyway?'))) return;
  if (button) button.disabled = true;
  try {
    const body = { project: slug, tabId };
    if (agent) body.force = true;
    await postJson('/api/browser-sessions/tab-close', body);
    if (browserSelectedTab[slug] === tabId) delete browserSelectedTab[slug];
    delete browserNavigation[slug]; delete browserAddressDraft[slug];
    previewMessage(slug, 'Closed one tab. The browser keeps running.');
    lastRender = ''; render();
    await refreshBrowserPreview(slug, true);
  } catch (error) { previewMessage(slug, error.message); }
  finally { if (button) button.disabled = false; }
}

function scheduleViewerRefresh(slug) {
  clearTimeout(viewerRefreshTimer);
  viewerRefreshTimer = setTimeout(() => refreshBrowserPreview(slug), 350);
}

function queueViewerInput(input) {
  const viewer = document.getElementById('browser-viewer');
  const project = viewer.dataset.project;
  const tab = viewer.dataset.tab;
  viewerInputQueue = viewerInputQueue.catch(() => {}).then(async () => {
    try {
      await postBrowserAction('/api/browser-sessions/input', { project, tab, ...input });
      scheduleViewerRefresh(project);
    } catch (error) { previewMessage(project, error.message); }
  });
  return viewerInputQueue;
}

function flushViewerText() {
  clearTimeout(viewerTextTimer);
  if (!viewerTextBuffer) return;
  const text = viewerTextBuffer;
  viewerTextBuffer = '';
  queueViewerInput({ type: 'text', text });
}

document.addEventListener('submit', async (e) => {
  if (e.target.dataset.addModel) {
    e.preventDefault();
    addExtraModel(e.target.dataset.addModel, e.target.elements.model.value.trim());
    return;
  }
  if (e.target.id === 'browser-viewer-text-form') {
    e.preventDefault();
    const input = document.getElementById('browser-viewer-text');
    const text = input.value;
    input.value = '';
    if (text && document.getElementById('browser-viewer-control').checked) {
      flushViewerText();
      queueViewerInput({ type: 'text', text });
    }
    return;
  }
  const sizeSlug = e.target.dataset.browserSize;
  const startSlug = e.target.dataset.browserStartPage;
  const renameSlug = e.target.dataset.browserBookmarkRename;
  const navigateSlug = e.target.dataset.browserNavigate || (e.target.id === 'browser-viewer-navigate' ? document.getElementById('browser-viewer').dataset.project : null);
  if (!sizeSlug && !navigateSlug && !startSlug && !renameSlug) return;
  e.preventDefault();
  const form = e.target;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    if (startSlug) {
      await postBookmark(startSlug, { action: 'start', url: form.elements.url.value });
    } else if (renameSlug) {
      await postBookmark(renameSlug, { action: 'rename', index: Number(form.dataset.index), name: form.elements.name.value });
    } else if (sizeSlug) {
      await postJson('/api/browser-sessions/window-size', { project: sizeSlug, width: Number(form.elements.width.value), height: Number(form.elements.height.value) });
      browserMessages[sizeSlug] = 'Size saved for the next browser launch. Close and reopen the browser to apply it.';
      await refreshExtras();
    } else {
      await postBrowserAction('/api/browser-sessions/navigate', { project: navigateSlug, tab: browserSelectedTab[navigateSlug], url: form.elements.url.value });
      delete browserAddressDraft[navigateSlug];
      previewMessage(navigateSlug, 'Opening page…');
      setTimeout(() => refreshBrowserPreview(navigateSlug, true), 800);
    }
  } catch (error) {
    if (sizeSlug) { browserMessages[sizeSlug] = error.message; lastRender = ''; render(); }
    else if (startSlug || renameSlug) { browserMessages[startSlug || renameSlug] = error.message; browserBookmarkDraft = null; lastRender = ''; render(); }
    else previewMessage(navigateSlug, error.message);
  } finally { button.disabled = false; }
});

async function runHandoffAction(action, key) {
  if (handoffBusy.has(key)) return;
  const h = state.control?.handoffs?.find((x) => x.pane === key) || (state.control?.bossHandoff?.pane === key ? state.control.bossHandoff : null) || Object.values(state.control?.projects || {}).filter((p) => p.orch?.pane === key).map((p) => ({ project: p.slug, pane: key, fromKind: p.orch.kind }))[0];
  const item = handoffRecords.find((x) => x.id === key);
  const selectedTarget = [...document.querySelectorAll('[data-handoff-target]')].find((x) => x.dataset.handoffTarget === key)?.value;
  const selectedModel = [...document.querySelectorAll('[data-handoff-model]')].find((x) => x.dataset.handoffModel === key)?.value;
  const selectedMode = [...document.querySelectorAll('[data-handoff-mode]')].find((x) => x.dataset.handoffMode === key)?.value;
  const selectedEffort = [...document.querySelectorAll('[data-handoff-effort]')].find((x) => x.dataset.handoffEffort === key)?.value;
  if (action === 'activate' && !confirm(`Activate the prepared ${item?.toKind || ''} orchestrator for ${item?.displayLabel || item?.project || key}? ${item?.boss || item?.label === 'boss' ? 'The successor pane becomes boss, and the current pane becomes boss previous. Boss-workspace peers and the Owner get a notice.' : 'The successor pane becomes orch, and the current pane becomes orch previous. Project workers and the Boss get a notice.'}`)) return;
  handoffBusy.add(key);
  handoffMessages[key] = action === 'plan' ? 'Planning handover…' : action === 'prepare' ? 'Starting successor…' : action === 'output' ? 'Reading successor…' : 'Activating…';
  lastRender = ''; render();
  try {
    if (action === 'plan' || action === 'prepare') {
      if (!h) throw new Error('This handover is no longer current. Refresh the dashboard.');
      const body = { project: h.project, pane: h.pane, to: selectedTarget, model: selectedModel, mode: selectedMode, effort: selectedEffort || null };
      if (action === 'plan') {
        const plan = await postJson('/api/handoffs/plan', body);
        handoffPlans[key] = plan;
        handoffMessages[key] = plan.migration && !plan.migration.available ? 'Migration unavailable; Prepare will use fresh mode.' : 'Plan ready for review.';
      } else {
        if (!handoffPlans[key]) throw new Error('Plan this handover first.');
        const prepared = await postJson('/api/handoffs/prepare', body);
        handoffRecords = await fetch('/api/handoffs').then((r) => r.json());
        handoffMessages[prepared.id] = prepared.promptError ? `Successor started. Prompt needs inspection: ${prepared.promptError}` : 'Successor started. Inspect its response before activation.';
      }
    } else if (action === 'output') {
      const result = await fetch(`/api/handoffs/output?id=${encodeURIComponent(key)}`).then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not read successor.');
        return data;
      });
      handoffOutputs[key] = result.output;
      handoffMessages[key] = 'Review the output below before confirming activation.';
    } else if (action === 'activate') {
      await postJson('/api/handoffs/activate', { id: key, confirmed: true });
      handoffRecords = await fetch('/api/handoffs').then((r) => r.json());
      await fetch('/api/tick', { method: 'POST' });
      handoffMessages[key] = 'Handover activated.';
    }
  } catch (error) { handoffMessages[key] = error.message; }
  finally { handoffBusy.delete(key); lastRender = ''; render(); }
}

document.addEventListener('click', (e) => {
  const button = e.target.closest?.('[data-org-style], [data-org-workers]');
  if (!button) return;
  const selector = button.dataset.orgStyle ? `[data-org-style="${button.dataset.orgStyle}"]` : `[data-org-workers="${CSS.escape(button.dataset.orgWorkers)}"]`;
  if (button.dataset.orgStyle) setOrgStyle(button.dataset.orgStyle);
  else if (orgWorkersOpen.has(button.dataset.orgWorkers)) orgWorkersOpen.delete(button.dataset.orgWorkers);
  else orgWorkersOpen.add(button.dataset.orgWorkers);
  lastRender = ''; render(true);
  document.querySelector(selector)?.focus();
});

document.addEventListener('click', (e) => {
  const button = e.target.closest?.('[data-agents-view]');
  if (!button) return;
  setAgentsView(button.dataset.agentsView);
  lastRender = ''; render(true);
});

document.addEventListener('click', (e) => {
  const toggle = e.target.closest?.('[data-org-node]');
  if (!toggle) return;
  const id = toggle.dataset.orgNode;
  if (orgOpen.has(id)) orgOpen.delete(id); else orgOpen.add(id);
  lastRender = ''; render(true);
  document.querySelector(`[data-org-node="${CSS.escape(id)}"]`)?.focus();
});

// The Watch form on Settings keeps its values in watchForm. A change patches the length text and the warning at once.
document.addEventListener('input', (e) => {
  if (e.target.matches?.('[data-night-until]')) { watchForm.until = e.target.value; syncWatchForm(); }
  else if (e.target.matches?.('[data-night-report]')) watchForm.report = e.target.value || '07:30';
  else if (e.target.matches?.('[data-watch-adhoc]')) watchForm.adhoc = e.target.value;
  else if (e.target.matches?.('[data-routine-every]')) (watchForm.routines[e.target.dataset.routineEvery] ??= {}).every = e.target.value;
  else if (e.target.matches?.('[data-routine-before]')) (watchForm.routines[e.target.dataset.routineBefore] ??= {}).beforeEnd = e.target.value;
  else if (e.target.matches?.('[data-rd]')) {
    const [key, name] = e.target.dataset.rd.split(/:(.*)/s);
    if (routineDrafts[key] && name !== 'kind') routineDrafts[key][name] = e.target.value;
  }
});
document.addEventListener('change', (e) => {
  if (e.target.matches?.('[data-night-forever]')) { watchForm.forever = e.target.checked; syncWatchForm(); }
  else if (e.target.matches?.('[data-night-daily]')) { watchForm.daily = e.target.checked; syncWatchForm(); }
  else if (e.target.matches?.('[data-routine-enabled]')) (watchForm.routines[e.target.dataset.routineEnabled] ??= {}).enabled = e.target.checked;
  else if (e.target.matches?.('[data-rd$=":kind"]')) {
    const [key] = e.target.dataset.rd.split(/:(.*)/s);
    if (routineDrafts[key]) routineDrafts[key].kind = e.target.value;
    lastRender = '';
    render(true);
  }
});
// The open state of a routine editor is kept, because a render replaces the page. The toggle event does not bubble.
document.addEventListener('toggle', (e) => {
  const key = e.target.dataset?.routineDetails;
  if (key === undefined) return;
  if (e.target.open) routineOpen.add(key); else routineOpen.delete(key);
}, true);
// A render replaces the form, so the length text is filled again after each render.
new MutationObserver(() => syncWatchForm()).observe(document.getElementById('app') || document.body, { childList: true });
setInterval(syncWatchForm, 30000);

document.addEventListener('click', async (e) => {
  const nightButton = e.target.closest?.('[data-night-stop], [data-night-start]');
  if (nightButton) {
    await updateNight(nightButton.dataset.nightStop ? 'stop' : 'start');
    return;
  }
  const routineSave = e.target.closest?.('[data-routine-save]');
  if (routineSave) {
    await saveRoutineEditor(routineSave.dataset.routineSave);
    return;
  }
  const routineReset = e.target.closest?.('[data-routine-reset]');
  if (routineReset) {
    await resetRoutineEditor(routineReset.dataset.routineReset);
    return;
  }
  const avatarReset = e.target.closest?.('[data-avatar-reset]');
  if (avatarReset) {
    await resetAvatar(avatarReset.dataset.avatarReset, avatarReset);
    return;
  }
  const serviceSave = e.target.closest?.('[data-save-service-settings]');
  if (serviceSave) {
    await saveServiceSettings(serviceSave.dataset.saveServiceSettings, serviceSave);
    return;
  }
  if (e.target.dataset.machineGuardDraft) {
    if (!policyDraft) return;
    policyDraft.machine ||= {};
    if (e.target.dataset.machineGuardDraft === 'pause') {
      const hours = Number(document.querySelector('[data-machine-pause-hours]')?.value || 1);
      if (!Number.isInteger(hours) || hours < 1 || hours > 24) { machineGuardMessage = 'Choose a pause from 1 to 24 hours.'; lastRender = ''; render(true); return; }
      policyDraft.machine.guardEnabled = true;
      policyDraft.machine.guardPausedUntil = new Date(Date.now() + hours * 3600000).toISOString();
    } else {
      policyDraft.machine.guardEnabled = true;
      policyDraft.machine.guardPausedUntil = null;
    }
    machineGuardMessage = '';
    policyDirty = true;
    saveMessage = '';
    lastRender = '';
    render(true);
    return;
  }
  if (e.target.dataset.overviewGuardAction) {
    const hours = Number(document.querySelector('[data-overview-pause-hours]')?.value || 1);
    await updateOverviewMachineGuard(e.target.dataset.overviewGuardAction, hours);
    return;
  }
  if (e.target.id === 'browser-viewer-close') { document.getElementById('browser-viewer').close(); return; }
  if (e.target.dataset.browserHistory) {
    const slug = e.target.dataset.browserProject || document.getElementById('browser-viewer').dataset.project;
    const action = e.target.dataset.browserHistory;
    e.target.disabled = true;
    try {
      const result = await postBrowserAction('/api/browser-sessions/history', { project: slug, tab: browserSelectedTab[slug], action });
      delete browserAddressDraft[slug];
      browserNavigation[slug] = { ...browserNavigation[slug], url: result.url };
      previewMessage(slug, `${action === 'home' ? 'Opening home' : action === 'back' ? 'Going back' : 'Going forward'}…`);
      setTimeout(() => refreshBrowserPreview(slug, true), 500);
    } catch (error) { previewMessage(slug, error.message); }
    finally { e.target.disabled = false; }
    return;
  }
  if (e.target.dataset.browserViewerKey) {
    flushViewerText(); queueViewerInput({ type: 'key', key: e.target.dataset.browserViewerKey }); return;
  }
  const viewerImage = document.querySelector('#browser-viewer > img');
  if (e.target === viewerImage) {
    viewerImage.focus();
    const viewer = document.getElementById('browser-viewer');
    if (!viewer.querySelector('#browser-viewer-control').checked) return;
    flushViewerText();
    const rect = viewerImage.getBoundingClientRect();
    queueViewerInput({ type: 'click', x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)) });
    return;
  }
  if (e.target.closest?.('[data-browser-expand]')) {
    const slug = e.target.closest('[data-browser-expand]').dataset.browserExpand;
    const viewer = document.getElementById('browser-viewer');
    let image = viewer.querySelector(':scope > img');
    if (!image) { image = document.createElement('img'); viewer.append(image); }
    image.src = browserPreviewUrls[slug];
    image.alt = `${slug} browser screenshot`;
    image.tabIndex = 0;
    viewer.dataset.project = slug;
    viewer.dataset.tab = browserSelectedTab[slug];
    viewer.querySelector('#browser-viewer-control').checked = false;
    for (const control of viewer.querySelectorAll('.browser-viewer-controls input, .browser-viewer-controls button')) control.disabled = true;
    viewer.querySelector('#browser-viewer-status').textContent = browserPreviewMessages[slug] || '';
    const form = viewer.querySelector('#browser-viewer-navigate');
    form.elements.url.value = browserAddressDraft[slug] ?? browserNavigation[slug]?.url ?? browserTabs[slug]?.find((tab) => tab.id === browserSelectedTab[slug])?.url ?? '';
    form.querySelector('[data-browser-history="back"]').disabled = !browserNavigation[slug]?.canGoBack;
    form.querySelector('[data-browser-history="forward"]').disabled = !browserNavigation[slug]?.canGoForward;
    viewer.showModal();
    syncViewerMode();
    if (!gridMode(slug)) refreshBrowserNavigation(slug).catch((error) => previewMessage(slug, error.message));
    return;
  }
  if (e.target.dataset.browserPreview) {
    const slug = e.target.dataset.browserPreview;
    if (browserPreviewOpen.has(slug)) { browserPreviewOpen.delete(slug); browserPreviewLive.delete(slug); delete browserNextRefresh[slug]; }
    else browserPreviewOpen.add(slug);
    lastRender = ''; render();
    if (browserPreviewOpen.has(slug)) await refreshBrowserPreview(slug, true);
    return;
  }
  if (e.target.dataset.browserView) {
    setBrowserView(e.target.dataset.browserProject || document.getElementById('browser-viewer').dataset.project, e.target.dataset.browserView);
    return;
  }
  if (e.target.dataset.browserCloseTab) {
    await closeBrowserTab(e.target.dataset.browserCloseTab, e.target.dataset.tab, e.target);
    return;
  }
  if (e.target.dataset.browserPickTab) {
    const slug = e.target.dataset.browserPickTab;
    browserSelectedTab[slug] = e.target.dataset.tab;
    delete browserNavigation[slug]; delete browserAddressDraft[slug];
    lastRender = ''; render();
    await refreshBrowserPreview(slug, true);
    return;
  }
  const tile = e.target.closest?.('[data-browser-focus-tab]');
  if (tile) {
    const slug = tile.dataset.browserFocusTab;
    browserSelectedTab[slug] = tile.dataset.tab;
    delete browserNavigation[slug]; delete browserAddressDraft[slug];
    setBrowserView(slug, 'tab');
    return;
  }
  if (e.target.dataset.browserBookmarkAdd) {
    const slug = e.target.dataset.browserBookmarkAdd;
    const tabs = browserTabs[slug] || [];
    const tab = tabs.find((t) => t.id === browserSelectedTab[slug]) || tabs[0];
    if (!tab) { browserMessages[slug] = 'No page is open to bookmark.'; lastRender = ''; render(); return; }
    e.target.disabled = true;
    try { await postBookmark(slug, { action: 'add', name: tab.title || tab.url, url: tab.url }); }
    catch (error) { browserMessages[slug] = error.message; lastRender = ''; render(); }
    finally { e.target.disabled = false; }
    return;
  }
  if (e.target.dataset.browserBookmarkOpen || e.target.dataset.browserBookmarkOpenTab) {
    const newTab = Boolean(e.target.dataset.browserBookmarkOpenTab);
    const slug = e.target.dataset.browserBookmarkOpen || e.target.dataset.browserBookmarkOpenTab;
    const bookmark = (browserSessions.find((b) => b.project === slug)?.bookmarks || [])[Number(e.target.dataset.index)];
    if (!bookmark) return;
    e.target.disabled = true;
    try {
      if (newTab) {
        const created = await postJson('/api/browser-sessions/new-tab', { project: slug });
        browserSelectedTab[slug] = created.id;
        await postBrowserAction('/api/browser-sessions/navigate', { project: slug, tab: created.id, url: bookmark.url });
      } else {
        await postBrowserAction('/api/browser-sessions/navigate', { project: slug, tab: browserSelectedTab[slug], url: bookmark.url });
      }
      delete browserAddressDraft[slug];
      previewMessage(slug, 'Opening bookmark…');
      setTimeout(() => refreshBrowserPreview(slug, true), 800);
    } catch (error) { browserMessages[slug] = error.message; lastRender = ''; render(); }
    finally { e.target.disabled = false; }
    return;
  }
  if (e.target.dataset.browserBookmarkRename) {
    const slug = e.target.dataset.browserBookmarkRename;
    const bookmark = (browserSessions.find((b) => b.project === slug)?.bookmarks || [])[Number(e.target.dataset.index)];
    if (!bookmark) return;
    browserBookmarkDraft = { slug, index: Number(e.target.dataset.index), name: bookmark.name };
    lastRender = ''; render();
    document.querySelector(`[data-browser-bookmark-rename="${slug}"] input`)?.focus();
    return;
  }
  if (e.target.dataset.browserBookmarkCancel) { browserBookmarkDraft = null; lastRender = ''; render(); return; }
  if (e.target.dataset.browserBookmarkUp || e.target.dataset.browserBookmarkDown) {
    const up = Boolean(e.target.dataset.browserBookmarkUp);
    const slug = e.target.dataset.browserBookmarkUp || e.target.dataset.browserBookmarkDown;
    const index = Number(e.target.dataset.index);
    e.target.disabled = true;
    try { await postBookmark(slug, { action: 'move', index, to: up ? index - 1 : index + 1 }); }
    catch (error) { browserMessages[slug] = error.message; lastRender = ''; render(); }
    return;
  }
  if (e.target.dataset.browserBookmarkRemove) {
    const slug = e.target.dataset.browserBookmarkRemove;
    const index = Number(e.target.dataset.index);
    const bookmark = (browserSessions.find((b) => b.project === slug)?.bookmarks || [])[index];
    if (!bookmark) return;
    if (!(await browserConfirm(`Delete the bookmark ${bookmark.name}?`, 'Delete'))) return;
    e.target.disabled = true;
    try { await postBookmark(slug, { action: 'remove', index }); }
    catch (error) { browserMessages[slug] = error.message; lastRender = ''; render(); }
    return;
  }
  if (e.target.dataset.browserRefresh) { await refreshBrowserPreview(e.target.dataset.browserRefresh, true); return; }
  if (e.target.dataset.browserNewTab) {
    const slug = e.target.dataset.browserNewTab;
    e.target.disabled = true;
    try {
      const result = await postJson('/api/browser-sessions/new-tab', { project: slug });
      browserSelectedTab[slug] = result.id;
      delete browserNavigation[slug]; delete browserAddressDraft[slug];
      await refreshBrowserPreview(slug, true);
      previewMessage(slug, 'Opened a new tab. Enter a web address and press Go.');
    } catch (error) { previewMessage(slug, error.message); }
    finally { e.target.disabled = false; }
    return;
  }
  if (e.target.dataset.browserClose || e.target.dataset.browserRestart) {
    const restart = Boolean(e.target.dataset.browserRestart);
    const slug = e.target.dataset.browserClose || e.target.dataset.browserRestart;
    const restorePage = document.querySelector(`[data-browser-restore="${slug}"]`)?.checked !== false;
    e.target.disabled = true;
    browserMessages[slug] = restart ? 'Restarting browser…' : 'Closing browser…';
    lastRender = ''; render();
    try {
      const result = await postJson(`/api/browser-sessions/${restart ? 'restart' : 'close'}`, { project: slug, ...(restart ? { headless: e.target.dataset.browserMode === 'headless', restorePage, tab: browserSelectedTab[slug] || null } : {}) });
      browserMessages[slug] = restart ? `${result.responsive ? 'Ready' : 'Starting'} on port ${result.port} · ${result.headless ? 'headless' : 'visible'}${result.restoreError ? ` · Page could not reopen: ${result.restoreError}` : ''}` : 'Browser closed. Its profile is saved.';
      browserPreviewOpen.delete(slug);
      browserPreviewLive.delete(slug);
      delete browserNextRefresh[slug];
      delete browserTabs[slug];
      delete browserNavigation[slug];
      delete browserAddressDraft[slug];
      if (browserPreviewUrls[slug]) URL.revokeObjectURL(browserPreviewUrls[slug]);
      delete browserPreviewUrls[slug];
      await refreshExtras();
      if (restart) { browserPreviewOpen.add(slug); lastRender = ''; render(); await refreshBrowserPreview(slug, true); }
    } catch (error) { browserMessages[slug] = error.message; lastRender = ''; render(); }
    return;
  }
  if (e.target.dataset.removeModel && policyDraft) {
    removeExtraModel(e.target.dataset.removeModel, e.target.dataset.model);
    return;
  }
  if (e.target.dataset.ladderAdd !== undefined || e.target.dataset.ladderUp !== undefined || e.target.dataset.ladderDown !== undefined || e.target.dataset.ladderRemove !== undefined) {
    const list = policyDraft?.orchestratorLadder;
    if (!list) return;
    if (e.target.dataset.ladderAdd !== undefined) {
      const kind = Object.keys(models).find((k) => kindModels(k).some((m) => !list.some((r) => r.kind === k && r.model === m))) || Object.keys(models)[0];
      if (!kind) return;
      const cfg = models[kind];
      const model = kindModels(kind).find((m) => !list.some((r) => r.kind === kind && r.model === m)) || cfg.defaultModel;
      list.push({ kind, model, effort: cfg.defaultEffort || null });
    } else {
      const i = Number(e.target.dataset.ladderUp ?? e.target.dataset.ladderDown ?? e.target.dataset.ladderRemove);
      if (e.target.dataset.ladderRemove !== undefined) list.splice(i, 1);
      else { const next = i + (e.target.dataset.ladderUp !== undefined ? -1 : 1); [list[i], list[next]] = [list[next], list[i]]; }
    }
    policyDirty = true; saveMessage = ''; lastRender = ''; render(true);
    return;
  }
  for (const [action, attr] of [['plan', 'handoffPlan'], ['prepare', 'handoffPrepare'], ['output', 'handoffOutput'], ['activate', 'handoffActivate']]) {
    if (e.target.dataset[attr]) { await runHandoffAction(action, e.target.dataset[attr]); return; }
  }
  if (e.target.id === 'save-policy' && policyDraft) {
    e.target.disabled = true;
    try {
      const pacingError = pacingDraftError(policyDraft, state?.quotas);
      if (pacingError) throw new Error(pacingError);
      const response = await fetch('/api/policy', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(policyDraft) });
      const result = await response.json();
      if (!response.ok) throw new Error((result.errors || [result.error || 'The policy could not be saved.']).join(' '));
      policyDraft = result.policy;
      policyDirty = false;
      saveMessage = ['Policy saved.', ...(result.notes || [])].join(' ');
      for (const kind of Object.keys(settingsMessages)) delete settingsMessages[kind];
      state.policy = result.policy;
      state.control = result.control;
      lastRender = '';
      render();
    } catch (error) { saveMessage = error.message; e.target.disabled = false; e.target.previousElementSibling.textContent = saveMessage; e.target.previousElementSibling.setAttribute('role', 'alert'); }
  }
  if (e.target.dataset.browserRequest) {
    const slug = e.target.dataset.browserRequest;
    const headless = e.target.dataset.browserMode === 'headless';
    e.target.disabled = true;
    try {
      const response = await fetch('/api/browser-sessions/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: slug, headless }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Browser request failed.');
      browserMessages[slug] = `${result.profileVerified ? (result.responsive ? 'Ready' : 'Not responding') : 'Starting'} on port ${result.port}. Profile: ${result.profile}`;
      await refreshExtras();
      if (result.profileVerified && result.responsive) { browserPreviewOpen.add(slug); lastRender = ''; render(); await refreshBrowserPreview(slug, true); }
    } catch (error) { browserMessages[slug] = error.message; lastRender = ''; render(); } finally { e.target.disabled = false; }
  }
});

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="/"]');
  if (!a || a.target || e.metaKey || e.ctrlKey || /\.md$/.test(a.getAttribute('href'))) return;
  e.preventDefault();
  history.pushState(null, '', a.getAttribute('href'));
  lastRender = '';
  render();
  if (location.pathname === '/browsers') for (const slug of browserPreviewOpen) if (!browserPreviewUrls[slug]) refreshBrowserPreview(slug, true);
  if (location.hash) requestAnimationFrame(() => document.getElementById(location.hash.slice(1))?.scrollIntoView());
  else scrollTo(0, 0);
});
addEventListener('popstate', () => { lastRender = ''; render(); if (location.pathname === '/browsers') for (const slug of browserPreviewOpen) if (!browserPreviewUrls[slug]) refreshBrowserPreview(slug, true); if (location.hash) requestAnimationFrame(() => document.getElementById(location.hash.slice(1))?.scrollIntoView()); });

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => {
    state = JSON.parse(e.data);
    autoRender();
    // A link from the Browsers page opens /allocation#lease-POOL-ITEM. Scroll to that row once.
    if (!hashScrolled && location.hash) {
      hashScrolled = true;
      const target = document.getElementById(location.hash.slice(1));
      if (target) requestAnimationFrame(() => target.scrollIntoView());
    }
    if (location.pathname === '/mailbox' && mailbox.loaded && !mailbox.loading && JSON.stringify(state.mailbox) !== mailbox.counts) loadMailbox(true);
  });
  es.onopen = () => $dot.classList.add('on');
  es.addEventListener('message', (e) => onChatMessage(JSON.parse(e.data)));
  es.onerror = () => { $dot.classList.remove('on'); $updated.textContent = 'reconnecting…'; };
}
async function refreshRoamgate() {
  try {
    const response = await fetch('/api/roamgate');
    const status = await response.json();
    $roamgate.hidden = !response.ok || !status.available;
  } catch { $roamgate.hidden = true; }
}
// The Mailbox and the Chat keep their DOM when the refreshed HTML is the same, so the reading position stays.
function refreshForcesRender(pathname) {
  return !['/mailbox', '/chat'].includes(pathname);
}

async function refreshExtras() {
  const results = await Promise.allSettled(['/api/models', '/api/usage', '/api/browser-sessions', '/api/handoffs', '/api/denials', '/api/mailbox?folder=needs-you', '/api/chats', '/api/settings/prices'].map((url) => fetch(url).then((r) => r.json())));
  if (results[0].status === 'fulfilled') models = results[0].value;
  if (results[1].status === 'fulfilled') usage = results[1].value;
  if (results[2].status === 'fulfilled') {
    browserSessions = results[2].value;
    if (!browserPreviewsInitialized) {
      for (const browser of browserSessions) if (browser.profileVerified && browser.responsive) browserPreviewOpen.add(browser.project);
      browserPreviewsInitialized = true;
    }
  }
  if (results[3].status === 'fulfilled') handoffRecords = results[3].value;
  if (results[4].status === 'fulfilled') denials = results[4].value;
  if (results[5].status === 'fulfilled') mailbox.updatesUnread = results[5].value.updatesUnread || 0;
  if (results[6].status === 'fulfilled' && Array.isArray(results[6].value)) { chat.list = chatSortList(results[6].value); chat.loaded = true; }
  if (results[7].status === 'fulfilled' && results[7].value?.prices) priceTable = results[7].value;
  if (location.pathname === '/mailbox' && !mailbox.loading) await loadMailbox(true);
  if (refreshForcesRender(location.pathname)) lastRender = '';
  autoRender();
  if (location.pathname === '/browsers') for (const slug of browserPreviewOpen) if (!browserPreviewUrls[slug]) refreshBrowserPreview(slug, true);
}
connect();
refreshExtras();
refreshRoamgate();
setInterval(refreshExtras, 30000);
setInterval(refreshRoamgate, 30000);
setInterval(() => {
  if (document.hidden || location.pathname !== '/browsers') return;
  const active = new Set(browserPreviewLive);
  const viewer = document.getElementById('browser-viewer');
  if (viewer.dataset.project && browserRefreshActive(viewer.dataset.project)) active.add(viewer.dataset.project);
  const now = Date.now();
  for (const slug of active) if (now >= (browserNextRefresh[slug] || 0)) {
    browserNextRefresh[slug] = now + previewInterval(slug);
    refreshBrowserPreview(slug);
  }
}, 500);
document.getElementById('browser-viewer').addEventListener('close', () => {
  viewerTextBuffer = '';
  clearTimeout(viewerTextTimer);
  clearTimeout(viewerRefreshTimer);
  document.getElementById('browser-viewer-text').value = '';
  document.getElementById('browser-viewer-control').checked = false;
  const slug = document.getElementById('browser-viewer').dataset.project;
  if (slug) browserRefreshStopped(slug);
});
setInterval(autoRender, 10000);

// Keep fixed bars above the on-screen keyboard. --kb-inset is the height the keyboard hides. A pinch zoom sets it to 0.
if (window.visualViewport) {
  const vv = window.visualViewport;
  const setKeyboardInset = () => document.documentElement.style.setProperty('--kb-inset', `${vv.scale > 1.01 ? 0 : Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop))}px`);
  // The phone app view has the height of the visual viewport, so the composer sits on top of the keyboard.
  const setAppViewport = () => {
    const view = appViewport({ height: vv.height, offsetTop: vv.offsetTop, scale: vv.scale, innerHeight });
    document.documentElement.style.setProperty('--app-h', `${view.height}px`);
    document.documentElement.style.setProperty('--app-top', `${view.top}px`);
  };
  const onViewport = () => { setKeyboardInset(); setAppViewport(); };
  vv.addEventListener('resize', onViewport);
  vv.addEventListener('scroll', onViewport);
  setAppViewport();
}
