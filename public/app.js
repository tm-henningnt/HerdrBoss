const $app = document.getElementById('app');
const $dot = document.getElementById('dot');
const $updated = document.getElementById('updated');
const $crumbs = document.getElementById('crumbs');
const $nav = document.getElementById('primary-nav');
const $roamgate = document.getElementById('roamgate-link');
const $navMenu = document.getElementById('nav-menu');
const $navMenuLabel = document.getElementById('nav-menu-label');
const NAV_LABEL = { overview: 'Overview', mailbox: 'Mailbox', projects: 'Projects', allocation: 'Allocation', organization: 'Organization', settings: 'Settings', agents: 'Agents', browsers: 'Browsers', analytics: 'Analytics', logs: 'Logs' };
const settingsLink = document.createElement('a');
settingsLink.href = '/settings';
settingsLink.dataset.nav = 'settings';
settingsLink.textContent = 'Settings';
$nav.insertBefore(settingsLink, $nav.querySelector('[data-nav="allocation"]')?.nextSibling || null);
function setNavMenu(open) {
  $nav.classList.toggle('open', open);
  $navMenu.setAttribute('aria-expanded', String(open));
}

let state = null;
let lastRender = '';
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
      <div class="allocation-name"><b><i class="allocation-swatch" style="background-color:${allocationColor(s, p.slug)}"></i>${esc(p.label)}</b><small>${p.running}/${p.slots} working slots${p.borrowed ? ` · +${p.borrowed} borrowed` : ''}${p.lent ? ` · ${p.lent} lent` : ''} · ${activity}</small></div>
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

function pacingDraftError(draft, quotas, now = Date.now()) {
  for (const [provider, windows] of Object.entries(draft.pacingGoals || {})) for (const [key, goal] of Object.entries(windows || {})) {
    if (!goal?.end) continue;
    const window = (quotas || []).find((q) => q.provider === provider && !q.error)?.windows?.find((w) => w.key === key && !w.extra);
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

function settingsView(s) {
  ensureDraft(s);
  if (!policyDraft) return '';
  const d = policyDraft;
  const harnesses = Object.entries(models || {}).map(([kind, cfg]) => harnessSection(kind, cfg, d)).join('');
  const ignoredCount = Object.keys(models || {}).reduce((n, kind) => n + kindModels(kind, d).filter((model) => ignoredLegacyRoute(kind, model, d)).length, 0);
  const providerRows = Object.keys(d.providerModes).map((p) => `<label class="setting-line"><span>${esc(PROVIDERS[p] || p)}</span><select data-provider="${esc(p)}" aria-label="${esc(PROVIDERS[p] || p)} quota mode"><option value="managed" ${d.providerModes[p] === 'managed' ? 'selected' : ''}>Manage pace</option><option value="ignore" ${d.providerModes[p] === 'ignore' ? 'selected' : ''}>Ignore quota</option></select></label>`).join('');
  const machine = d.machine || {};
  const machineNumber = (key, label, max, nullable = false) => `<label class="setting-line"><span>${label}</span><input type="number" min="0" max="${max}" ${nullable ? 'step="any" placeholder="Disabled"' : ''} value="${machine[key] ?? ''}" data-policy-machine="${key}"></label>`;
  const guardMode = machineGuardMode(machine);
  const pauseHours = [1, 2, 4, 8, 12, 24].map((hours) => `<option value="${hours}">${hours} hour${hours === 1 ? '' : 's'}</option>`).join('');
  const machineGuardSettings = `<div class="machine-guard-controls"><label class="setting-line"><span>Machine guard · ${guardMode}${guardMode === 'paused' ? esc(machineGuardUntilText(machine.guardPausedUntil)) : ''}</span><input type="checkbox" role="switch" aria-label="Machine guard enabled" data-policy-machine-bool="guardEnabled" ${machine.guardEnabled ? 'checked' : ''}></label><div class="action-row"><label class="setting-line"><span>Pause for</span><select aria-label="Machine guard pause duration" data-machine-pause-hours>${pauseHours}</select></label><button type="button" data-machine-guard-draft="pause">Pause guard</button>${guardMode === 'active' ? '' : '<button type="button" data-machine-guard-draft="resume">Resume guard</button>'}</div><p class="setting-help">${esc(machineGuardMessage || (guardMode === 'paused' ? `The guard resumes ${machineGuardUntilText(machine.guardPausedUntil).slice(7)}.` : guardMode === 'off' ? 'CPU and load limits do not block worker starts while the guard is off.' : 'CPU and load limits block worker starts while the guard is active.'))}</p></div>`;
  const machineSettings = `<section class="panel"><h2>Machine</h2><p class="setting-help">The Owner is away after the idle period. CPU is a percent of total machine capacity. Disk alerts stay active when the CPU and load guard is off or paused. Disk thresholds use free GB. GB uses 2³⁰ bytes.</p>${machineGuardSettings}${machineNumber('ownerAwayMinutes', 'Owner away after minutes', 1440)}${machineNumber('presentCpuPercent', 'CPU limit while present %', 100)}${machineNumber('awayCpuPercent', 'CPU limit while away %', 100, true)}${machineNumber('presentLoadFactor', 'Present load backstop × cores', 128, true)}${machineNumber('awayLoadFactor', 'Away load backstop × cores', 128, true)}${machineNumber('diskWarnFreeGB', 'Disk warning below free GB', 1048576)}${machineNumber('diskCriticalFreeGB', 'Disk critical below free GB', 1048576)}<label class="setting-line"><span>Notice cooldown seconds</span><input type="number" min="0" max="604800" value="${machine.alertCooldownSeconds}" data-policy-machine="alertCooldownSeconds"></label></section>`;
  // A goal exists only for a live, measured window with a stable key. Extra model-only windows do not get one.
  const goalWindows = [];
  for (const q of s.quotas || []) {
    if (q.error) continue;
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
  const quotaPanel = `<section class="panel"><h2>Provider quotas</h2><h3>Quota mode</h3>${providerRows}<p class="setting-help">Ignore quota turns off pacing and pace warnings for worker dispatch. Handover risk and automatic handover still use live quota data.</p><h3 class="quota-goals">Pacing goals</h3><p class="setting-help">The most percent of a window to use by its end. Blank means 100%. A one-off end uses your local time. A recurring end is a whole number of hours before reset.</p>${goalRows}</section>`;
  return `<header class="page-intro"><div><h1>Settings</h1><p>Assign models and provider routes in each harness. Set provider quotas and machine limits below.</p></div></header><section id="settings-plane" class="control-shell"><section class="panel"><h2>Harnesses</h2><p class="setting-help harness-help">Clear a model box to stop that harness from using it. The same model in another harness keeps its own box and provider.</p>${ignoredCount ? `<p class="setting-help harness-help" role="note" style="color: var(--warn)">${ignoredCount} legacy provider route${ignoredCount === 1 ? ' is' : 's are'} not compatible with ${ignoredCount === 1 ? 'its harness' : 'their harnesses'}. Herdr Boss treats ${ignoredCount === 1 ? 'it' : 'them'} as Unmetered. Choose a provider in each marked row before you apply the policy.</p>` : ''}<div class="harness-grid">${harnesses}</div></section><div class="settings-grid">${quotaPanel}${machineSettings}</div><div class="control-actions ${policyDirty ? 'pending' : ''}"><span data-policy-status role="status" aria-live="polite">${esc(saveMessage || (policyDirty ? 'Unsaved changes · Apply policy to keep them' : 'Policy saved'))}</span><button id="save-policy" ${policyDirty ? '' : 'disabled'}>Apply policy</button></div></section>`;
}

function handoffBlock(s, projectSlug = null) {
  const candidates = [...(s.control?.handoffs || []), ...(s.control?.bossHandoff ? [s.control.bossHandoff] : [])].filter((h) => !projectSlug || h.project === projectSlug);
  const project = projectSlug && s.control?.projects?.[projectSlug];
  if (project?.orch && !candidates.length) candidates.push({ project: projectSlug, pane: project.orch.pane, fromKind: project.orch.kind, target: null, window: null });
  const prepared = handoffRecords.filter((x) => ['prepared', 'preparing', 'needs-inspection'].includes(x.status) && (!projectSlug || x.project === projectSlug));
  const cards = [
    ...prepared.map((item) => {
      const output = handoffOutputs[item.id];
      return `<article class="handoff-item panel"><div class="handoff-head"><div><b>${esc(item.displayLabel || s.control?.projects?.[item.project]?.label || item.project)}</b><p>Successor ${item.status === 'prepared' ? 'prepared' : 'needs inspection'} · ${esc(item.toKind)} / ${esc(item.model)}</p></div><span class="tag">${item.status !== 'prepared' ? 'Inspect pane' : item.automatic ? item.readyAt ? 'Ready for automatic activation' : 'Awaiting successor readiness' : 'Awaiting review'}</span></div>
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

function browserGridMarkup(slug) {
  const tabs = browserTabs[slug] || [];
  if (!tabs.length) return '<div class="browser-preview-empty">No tabs are open.</div>';
  const cols = Math.ceil(Math.sqrt(tabs.length));
  return `<div class="browser-tab-grid" style="--cols:${cols};--rows:${Math.ceil(tabs.length / cols)}">${tabs.map((tab) => {
    const url = browserGridUrls[slug]?.[tab.id];
    return `<button type="button" class="browser-tab-tile" data-browser-focus-tab="${esc(slug)}" data-tab="${esc(tab.id)}" title="Show only this tab">${url
      ? `<img data-browser-grid-image="${esc(slug)}" data-tab="${esc(tab.id)}" src="${url}" alt="${esc(tab.title || 'Browser tab')}">`
      : `<span class="browser-tile-empty">${esc(browserGridErrors[slug]?.[tab.id] || 'Capturing…')}</span>`}<span class="browser-tile-label">${esc(browserTabLabel(tab))}</span></button>`;
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

function browserResources(s) {
  const projects = Object.values(s.control?.projects || {});
  const sessions = browserSessions;
  const cards = (group) => group.map((p) => {
    const b = sessions.find((x) => x.project === p.slug);
    const tabs = browserTabs[p.slug] || [];
    const size = b?.windowSize || { width: 1280, height: 800 };
    const preview = browserPreviewOpen.has(p.slug) && !!b?.responsive;
    return `<article class="panel browser-card ${b?.profileVerified ? 'browser-card-active' : 'browser-card-idle'}"><div class="browser-card-head"><div><h3>${esc(p.label)}</h3><p>${b ? `<span class="mono">:${b.port}</span> · ${browserState(b)} · ${b.headless ? 'headless' : 'visible'}` : 'No browser running'}</p></div>${b?.profileVerified ? `<div class="browser-head-actions">${b.responsive ? `<button type="button" class="browser-preview-toggle" data-browser-preview="${esc(p.slug)}">${preview ? 'Hide preview' : 'Show preview'}</button>` : ''}<details class="browser-manage" data-browser-manage="${esc(p.slug)}" ${browserManageOpen.has(p.slug) ? 'open' : ''}><summary>Manage</summary><div class="browser-manage-content"><div class="browser-actions"><button type="button" data-browser-restart="${esc(p.slug)}" data-browser-mode="${b.headless ? 'visible' : 'headless'}">Restart ${b.headless ? 'visible' : 'headless'}</button>${b.responsive ? `<label class="browser-restore"><input type="checkbox" data-browser-restore="${esc(p.slug)}" checked> Reopen current page</label>` : ''}<button type="button" data-browser-close="${esc(p.slug)}">Close browser</button></div><form class="browser-size" data-browser-size="${esc(p.slug)}"><label>Next launch size <input type="number" name="width" min="320" max="3840" value="${size.width}" aria-label="${esc(p.label)} window width"> × <input type="number" name="height" min="240" max="2160" value="${size.height}" aria-label="${esc(p.label)} window height"> px</label><button type="submit">Save size</button></form><details class="browser-record"><summary>Connection and profile</summary><small class="mono">http://127.0.0.1:${b.port}<br>${esc(b.profile)}</small></details></div></details></div>` : '<span class="tag">Available</span>'}</div>
      ${!b?.profileVerified ? `<div class="browser-actions"><button type="button" data-browser-request="${esc(p.slug)}" data-browser-mode="visible">Open visible</button><button type="button" data-browser-request="${esc(p.slug)}" data-browser-mode="headless">Open headless</button></div>` : ''}
      ${b?.profileVerified && !b.responsive ? '<small class="inline-feedback" role="status">Chrome does not answer on its debugging port. Restart or close it from Manage.</small>' : ''}
      ${browserMessages[p.slug] ? `<small class="inline-feedback" role="status">${esc(browserMessages[p.slug])}</small>` : ''}
      ${preview ? `<div class="browser-preview"><div class="browser-preview-tools">${browserViewToggle(p.slug)}${gridMode(p.slug) ? `<span class="browser-grid-count">${tabs.length} tab${tabs.length === 1 ? '' : 's'}</span>` : `<select data-browser-tab="${esc(p.slug)}" aria-label="${esc(p.label)} browser page">${tabs.map((tab) => `<option value="${esc(tab.id)}" ${tab.id === browserSelectedTab[p.slug] ? 'selected' : ''}>${esc(browserTabLabel(tab))}</option>`).join('')}</select>`}<button type="button" data-browser-refresh="${esc(p.slug)}">Refresh</button>${gridMode(p.slug) ? `<button type="button" data-browser-expand="${esc(p.slug)}">Expand</button>` : `<button type="button" data-browser-new-tab="${esc(p.slug)}" title="Open a blank tab of your own. Agent tabs stay unchanged.">New tab</button>`}<label class="browser-live-toggle"><input type="checkbox" data-browser-live="${esc(p.slug)}" ${browserPreviewLive.has(p.slug) ? 'checked' : ''}> Live</label><label class="browser-live-rate">Every <select data-browser-interval="${esc(p.slug)}" aria-label="${esc(p.label)} live refresh interval">${PREVIEW_INTERVALS.map((ms) => `<option value="${ms}" ${ms === previewInterval(p.slug) ? 'selected' : ''}>${ms / 1000}s</option>`).join('')}</select></label></div>
        ${gridMode(p.slug) ? browserGridMarkup(p.slug) : `<form class="browser-navigate" data-browser-navigate="${esc(p.slug)}"><button type="button" data-browser-history="back" data-browser-project="${esc(p.slug)}" ${browserNavigation[p.slug]?.canGoBack ? '' : 'disabled'}>Back</button><button type="button" data-browser-history="forward" data-browser-project="${esc(p.slug)}" ${browserNavigation[p.slug]?.canGoForward ? '' : 'disabled'}>Forward</button><button type="button" data-browser-history="home" data-browser-project="${esc(p.slug)}" ${tabs.length ? '' : 'disabled'}>Home</button><input type="text" name="url" value="${esc(browserAddressDraft[p.slug] ?? browserNavigation[p.slug]?.url ?? tabs.find((tab) => tab.id === browserSelectedTab[p.slug])?.url ?? '')}" placeholder="Enter a web address" aria-label="${esc(p.label)} browser address" autocomplete="off" spellcheck="false" required><button type="submit" ${tabs.length ? '' : 'disabled'}>Go</button></form>
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

function quotaCard(q) {
  const name = PROVIDERS[q.provider] || q.provider;
  if (q.error) return `<div class="panel provider"><div class="provider-head"><b>${esc(name)}</b></div><div class="err">${esc(q.error)}</div></div>`;
  const wins = q.windows.map((w) => {
    if (w.resetsAt && Date.parse(w.resetsAt) <= Date.now()) return `<div class="win"><div class="win-row"><span>${esc(w.label)}</span><span class="muted">Reset, not yet measured</span></div><div class="bar"></div><div class="win-row win-foot"><span>The next quota reading shows the new use.</span><span>reset ${clock(w.resetsAt)}</span></div></div>`;
    const cls = w.usedPercent >= 98 ? 'crit' : w.usedPercent >= 90 ? 'warn' : w.willLast === false ? 'warn' : '';
    const tick = w.expectedPercent != null ? `<s style="left:calc(${Math.min(100, w.expectedPercent)}% - 1px)" title="Expected at even pace: ${w.expectedPercent}%"></s>` : '';
    const foot = w.paceSummary ? esc(w.paceSummary) : w.extra ? 'Extra window' : '';
    return `<div class="win">
      <div class="win-row"><span>${esc(w.label)}</span><span><span class="pct">${w.usedPercent}%</span></span></div>
      <div class="bar"><i class="${cls}" style="width:${Math.min(100, w.usedPercent)}%"></i>${tick}</div>
      <div class="win-row win-foot"><span>${foot}</span><span>resets ${clock(w.resetsAt)} · in ${until(w.resetsAt)}</span></div>
    </div>`;
  }).join('');
  const extras = [];
  if (q.credits?.remaining != null) extras.push(`${q.credits.remaining} credits`);
  if (q.resetCredits) extras.push(`${q.resetCredits} reset credit${q.resetCredits > 1 ? 's' : ''}`);
  const trend = usage?.quotaTrend?.[q.provider] || [];
  return `<div class="panel provider"><div class="provider-head"><b>${esc(name)}</b><span class="tag">${esc(extras.join(' · ') || q.plan || '')}</span></div>${wins}${trend.length > 1 ? `<div class="win-foot">Weekly use trend · last ${Math.min(24, Math.round(trend.length / 12))}h${spark(trend.map((x) => x.usedPercent), 100)}</div>` : ''}</div>`;
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
    return `<a class="panel proj project-selector ${slug === selected ? 'selected' : ''} ${color ? `has-allocation ${allocationActivity(l)}` : ''}" href="/projects/${esc(slug)}" ${slug === selected ? 'aria-current="page"' : ''} ${color ? `style="--allocation-color:${color}"` : ''}>
      <div class="proj-head"><b>${esc(name)}</b><span class="tag">${esc(mode)}</span></div>
      <div class="project-selector-meta"><span>${esc(p?.status || p?.phase || 'No status published')}</span><span>${l ? `${l.running} / ${l.slots} workers` : 'No live allocation'}</span></div>
      ${p?.summary ? `<p>${esc(p.summary)}</p>` : ''}
      ${p ? segBar(taskCounts(p)) : ''}
      ${p?.errors?.length ? `<span class="project-card-error">${p.errors.length} status issue${p.errors.length === 1 ? '' : 's'}</span>` : ''}
      <div class="win-foot">${p ? `updated ${ago(p.updated)}${staleStatusTag(s, p)}` : 'Awaiting project status'}</div>
    </a>`;
  }).join('')}</nav>`;
}

function browsersBlock(s) {
  const br = s.browsers || [];
  if (!br.length) return '';
  const pane = (id) => s.herdr?.panes.find((p) => p.id === id);
  return `<table class="browsers"><thead><tr><th>Process</th><th>PID</th><th>Owner</th><th>Age</th><th>MB</th></tr></thead><tbody>
    ${br.map((b) => { const p = pane(b.pane); return `<tr><td data-label="Process">${esc(b.kind)}${b.headless ? ' (headless)' : ''}${b.port ? ` :${b.port}` : ''}</td><td class="mono" data-label="PID">${b.pid}</td><td data-label="Owner">${p ? esc(p.name || p.id) : b.shared ? `<span title="${esc(b.shared)}">shared</span>` : b.orphan ? '<span class="stale">orphan</span>' : '–'}</td><td class="mono" data-label="Age">${dur(b.age)}</td><td class="mono" data-label="MB">${b.rssMB}</td></tr>`; }).join('')}
  </tbody></table>`;
}

function eventsBlock(s) {
  const ev = (s.events || []).slice().reverse();
  return `<div class="panel">${ev.length ? `<ul class="events">${ev.map((e) => `<li><span class="t">${new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</span><span class="ty ${esc(e.type)}">${esc(e.type)}</span><span>${esc(e.text)}</span></li>`).join('')}</ul>` : '<div class="empty">No activity yet.</div>'}</div>`;
}

function quotaSummary(s) {
  const strip = (s.quotas || []).map((q) => {
    const w = q.windows?.find((x) => x.key === 'secondary') || q.windows?.find((x) => !x.extra);
    return `<span class="quota-summary-item"><span>${esc(PROVIDERS[q.provider] || q.provider)}</span><strong class="${w?.usedPercent >= 90 ? 'text-crit' : ''}">${w ? `${w.usedPercent}%` : '–'}</strong><small>${q.error ? esc(q.error) : w ? `${esc(w.label)} · resets ${clock(w.resetsAt)}` : 'No quota data'}</small></span>`;
  }).join('');
  // Saved quotas from before a restart show their read time until the first new read succeeds.
  const cached = s.quotasCached && s.quotasAt && Date.now() - Date.parse(s.quotasAt) < 15 * 60 * 1000;
  return `<section class="quota-summary"><div class="section-head"><h2>Subscriptions</h2><span>${cached ? `Quotas from ${clock(s.quotasAt)}` : `Updated ${ago(s.quotasAt)}`}</span></div><details data-quota-detail ${quotaExpanded ? 'open' : ''}><summary><span class="quota-summary-grid">${strip}</span><span class="fold-hint">Details</span></summary><div class="quota-foldout">${(s.quotas || []).map(quotaCard).join('')}</div></details></section>`;
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

function overview(s) {
  const currentHandoffs = [...(s.control?.handoffs || []), ...(s.control?.bossHandoff ? [s.control.bossHandoff] : [])];
  const handovers = currentHandoffs.length + handoffRecords.filter((x) => ['prepared', 'preparing', 'needs-inspection'].includes(x.status) && !currentHandoffs.some((h) => h.pane === x.sourcePane)).length;
  const alertCount = (s.alerts || []).filter((a) => ['warn', 'critical'].includes(a.severity) && !a.key?.startsWith('handoff:')).length;
  return [
    `<header class="page-intro"><div><h1>Overview</h1><p>${alertCount || handovers ? `${alertCount} resource alert${alertCount === 1 ? '' : 's'} · ${handovers} handover${handovers === 1 ? '' : 's'} to review` : 'Projects are operating within the current resource policy.'}</p></div><div class="capacity-readout"><strong>${s.control?.runningWorkers ?? 0}<span> / ${s.control?.maxWorkers ?? '–'}</span></strong><small>working agents</small><a href="/allocation">Adjust allocation →</a></div></header>`,
    `<div class="overview-action-grid">${attentionBlock(s)}${handoffBlock(s)}</div>`,
    fleetBlock(s),
    quotaSummary(s),
    machineSummary(s),
  ].join('');
}

function allocationView(s) {
  return [
    '<header class="page-intro"><div><h1>Resource allocation</h1><p>Set worker capacity, project shares, exclusions, and orchestrator succession.</p></div></header>',
    controlBlock(s),
  ].join('');
}

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
    recentUsageBlock(),
    denialsBlock(),
  ].join('');
}

function agentsView(s) {
  return [
    '<header class="page-intro"><div><h1>Live agents</h1><p>Orchestrators and workers across the open Herdr workspaces.</p></div></header>',
    agentInventory(s),
  ].join('');
}

// ---------- Messages ----------
// One thread for the Boss and one for each project. The panel is a dialog outside #app, so a state render keeps the typed text.

const MESSAGE_NUDGES = ['Continue.', 'Use your free worker slots.', 'Pause after the current task.'];
const MESSAGE_SENDER = { owner: 'Owner', boss: 'Boss', orch: 'Orchestrator' };
const messagePanel = { thread: null, name: '', timer: null, records: [], status: '', busy: false };

// Escaped Markdown: headings, lists, fenced code, inline code, bold, and italic. Raw HTML stays text.
function markdownHtml(source) {
  const inline = (text) => text.split('`').map((part, index) => index % 2
    ? `<code>${esc(part)}</code>`
    : esc(part).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')).join('');
  const out = [];
  let list = null;
  let paragraph = [];
  let code = null;
  const flush = () => {
    if (paragraph.length) { out.push(`<p>${paragraph.map(inline).join(' ')}</p>`); paragraph = []; }
    if (list) { out.push(`<${list.tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join('')}</${list.tag}>`); list = null; }
  };
  for (const line of String(source || '').split(/\r?\n/)) {
    if (code) {
      if (/^\s*```/.test(line)) { out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); code = null; }
      else code.push(line);
      continue;
    }
    if (/^\s*```/.test(line)) { flush(); code = []; continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { flush(); const level = Math.min(heading[1].length + 2, 6); out.push(`<h${level}>${inline(heading[2])}</h${level}>`); continue; }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const tag = bullet ? 'ul' : 'ol';
      if (paragraph.length || (list && list.tag !== tag)) flush();
      list ||= { tag, items: [] };
      list.items.push((bullet || numbered)[1]);
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    if (list) flush();
    paragraph.push(line.trim());
  }
  if (code) out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
  flush();
  return out.join('');
}

function messageState(m) {
  if (m.from !== 'owner') return m.action ? `Action: ${m.action}` : '';
  if (m.status === 'sent') return `Sent ${clock(m.sentAt)}`;
  if (m.status === 'failed') return `Failed: ${m.error || 'unknown error'} (attempt ${m.attempts || 1} of 4)`;
  return 'Queued until the agent is idle or done';
}

// A report is safe Markdown. Every other record is escaped text.
function messageBody(m) {
  return m.kind === 'report'
    ? `<div class="msg-report">${m.title && /^#{1,6}\s+(.*)/.exec(String(m.text).trimStart())?.[1]?.trim() !== m.title ? `<h3>${esc(m.title)}</h3>` : ''}${markdownHtml(m.text)}</div>`
    : `<p class="msg-text">${esc(m.text)}</p>`;
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
    messagePanel.status = 'Queued. Herdr Boss sends it when the agent is idle or done.';
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
const mailbox = { open: [], done: [], loaded: false, loading: false, error: '', notice: '', counts: '', busy: false, status: {} };
const mailOpen = new Set();
const mailReading = new Set();
const mailDrafts = {};

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
  return `<label for="mail-text-${id}">${label}</label><textarea id="mail-text-${id}" data-mail-draft="${id}" maxlength="${max}" rows="3"${required ? ' required' : ''}></textarea>`;
}

function mailActions(item) {
  const id = esc(item.id);
  const off = mailbox.busy ? ' disabled' : '';
  const status = `<p class="mail-status" role="status">${esc(mailbox.status[item.id] || '')}</p>`;
  if (item.action === 'read') return `<div class="mail-actions"><div class="mail-buttons"><button type="button" data-mail-done="${id}"${off}>Mark read</button></div>${status}</div>`;
  if (item.action === 'approve') {
    return `<form class="mail-actions" data-mail-form="${id}">${mailField(item, 'Note (optional)', 1700, false)}
      <div class="mail-buttons"><button type="submit" data-mail-verdict="Approved."${off}>Approve</button><button type="submit" class="mail-decline" data-mail-verdict="Declined."${off}>Decline</button></div>${status}</form>`;
  }
  const choices = item.action === 'decide' && item.choices?.length
    ? `<div class="mail-choices" role="group" aria-label="Choices">${item.choices.map((choice) => `<button type="button" data-mail-choice="${esc(choice)}" data-mail-item="${id}"${off}>${esc(choice)}</button>`).join('')}</div>`
    : '';
  const label = item.action === 'decide' ? (choices ? 'Other answer, or a note for the choice' : 'Decision') : 'Answer';
  return `<form class="mail-actions" data-mail-form="${id}">${choices}${mailField(item, label, choices ? 1700 : 2000, !choices)}
    <div class="mail-buttons"><button type="submit"${off}>Send</button></div>${status}</form>`;
}

function mailDoneLine(item) {
  if (item.answer) {
    const state = item.answer.status === 'sent' ? 'sent' : item.answer.status === 'failed' ? 'failed' : 'queued';
    return `<div class="mail-answer"><span class="sub">Your answer · ${esc(state)} · ${esc(clock(item.answer.at))}</span><p class="msg-text">${esc(item.answer.text)}</p></div>`;
  }
  return `<p class="sub mail-answer">Marked read ${esc(clock(item.closedAt))}</p>`;
}

function mailItem(s, item, done) {
  const unread = !item.readAt;
  const open = mailOpen.has(item.id);
  return `<li class="mail-item${unread ? ' unread' : ''}${done ? ' done' : ''}"><details data-mail-item="${esc(item.id)}"${open ? ' open' : ''}>
    <summary><span class="mail-meta">${unread ? '<span class="mail-dot" aria-hidden="true"></span><span class="visually-hidden">Unread. </span>' : ''}<strong>${esc(mailItemLabel(s, item))}</strong><span class="pill ghost mail-action-${esc(item.action)}">${esc(MAIL_ACTION_LABEL[item.action] || 'Read')}</span><time datetime="${esc(item.at)}">${esc(clock(item.at))}</time></span>
      <span class="mail-headline">${item.kind === 'report' ? '<span class="pill">Report</span> ' : ''}${esc(mailHeadline(item))}</span></summary>
    <div class="mail-body">${messageBody(item)}${done ? mailDoneLine(item) : mailActions(item)}</div>
  </details></li>`;
}

function mailboxView(s) {
  if (!mailbox.loaded && !mailbox.loading) loadMailbox();
  const list = (items, done, empty) => items.length ? `<ol class="mail-list">${items.map((item) => mailItem(s, item, done)).join('')}</ol>` : `<p class="mail-empty">${empty}</p>`;
  return [
    '<header class="page-intro"><div><h1>Mailbox</h1><p>Replies and reports for the Owner. Open an item to read it. Answer, approve, or decide in the item.</p></div></header>',
    `<p class="mail-notice" role="status"${mailbox.error || mailbox.notice ? '' : ' hidden'}>${esc(mailbox.error || mailbox.notice)}</p>`,
    `<section class="mail-section"><h2>Open <span class="sub">${mailbox.open.length}</span></h2>${mailbox.loaded ? list(mailbox.open, false, 'No open items.') : '<p class="mail-empty">Loading…</p>'}</section>`,
    `<section class="mail-section"><h2>Done <span class="sub">${mailbox.done.length}</span></h2>${mailbox.loaded ? list(mailbox.done, true, 'No closed items.') : ''}</section>`,
  ].join('');
}

async function loadMailbox() {
  mailbox.loading = true;
  try {
    const response = await fetch('/api/mailbox');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The mailbox could not be read.');
    Object.assign(mailbox, { open: result.open, done: result.done, loaded: true, error: '', counts: JSON.stringify(result.mailbox) });
    if (state) state.mailbox = result.mailbox;
  } catch (error) { mailbox.error = error.message; }
  finally { mailbox.loading = false; }
  render();
}

function mailFind(id) { return mailbox.open.find((item) => item.id === id) || mailbox.done.find((item) => item.id === id); }

async function mailMarkRead(item, close = false) {
  const result = await postJson('/api/messages/read', { ids: [item.id], ...(close ? { close: true } : {}) });
  if (state) state.mailbox = result.mailbox;
  return result;
}

// Opening an item marks it read. A refused read, for example in the read-only preview, leaves it unread.
async function mailOpened(item) {
  if (item.readAt || mailReading.has(item.id)) return;
  mailReading.add(item.id);
  try { await mailMarkRead(item); item.readAt = new Date().toISOString(); }
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
    mailOpen.delete(item.id);
    mailbox.notice = `Queued for ${mailItemLabel(state || {}, item)}. Herdr Boss sends it when the agent is idle or done. The item is in Done.`;
  } catch (error) { mailbox.status[item.id] = error.message; }
  finally { mailbox.busy = false; }
  await loadMailbox();
}

async function mailDone(item) {
  if (mailbox.busy) return;
  mailbox.busy = true; render();
  try { await mailMarkRead(item, true); mailOpen.delete(item.id); delete mailbox.status[item.id]; mailbox.notice = 'Marked read. The item is in Done.'; }
  catch (error) { mailbox.status[item.id] = error.message; }
  finally { mailbox.busy = false; }
  await loadMailbox();
}

function mailRestoreDrafts(focusId) {
  for (const field of $app.querySelectorAll('[data-mail-draft]')) field.value = mailDrafts[field.dataset.mailDraft] || '';
  if (focusId) document.getElementById(focusId)?.focus();
}

document.addEventListener('input', (e) => {
  const id = e.target.dataset?.mailDraft;
  if (id) mailDrafts[id] = e.target.value;
});
document.addEventListener('toggle', (e) => {
  const id = e.target.dataset?.mailItem;
  if (!id || !e.target.matches('details')) return;
  if (e.target.open) { mailOpen.add(id); const item = mailFind(id); if (item) mailOpened(item); }
  else mailOpen.delete(id);
}, true);
document.addEventListener('submit', (e) => {
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
  const choice = e.target.closest?.('[data-mail-choice]');
  if (choice) {
    const item = mailFind(choice.dataset.mailItem);
    const note = (mailDrafts[choice.dataset.mailItem] || '').trim();
    const text = `Choice: ${choice.dataset.mailChoice}${note ? `\n\n${note}` : ''}`;
    if (item) mailSend(item, text, `Send this choice to ${mailItemLabel(state || {}, item)}?\n\n${text}`);
    return;
  }
  const done = e.target.closest?.('[data-mail-done]');
  if (done) { const item = mailFind(done.dataset.mailDone); if (item) mailDone(item); }
});

function updateMailboxBadge(s) {
  const unread = s?.mailbox?.unread || 0;
  const text = unread > 99 ? '99+' : String(unread);
  for (const badge of document.querySelectorAll('[data-mailbox-badge]')) { badge.hidden = !unread; badge.textContent = text; }
  const link = $nav.querySelector('[data-nav="mailbox"]');
  if (link) link.setAttribute('aria-label', unread ? `Mailbox, ${unread} unread` : 'Mailbox');
  $navMenu.setAttribute('aria-label', unread ? `Menu, ${unread} unread in Mailbox` : 'Menu');
}

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
  if (!q || q.error) return null;
  return q.windows?.find((x) => x.key === 'secondary') || q.windows?.find((x) => !x.extra) || null;
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

function orgNode({ id, role, name, status, summary, facts, className = '', thread = null, agent, quota = null }) {
  const open = orgOpen.has(id);
  const domId = `org-detail-${id.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  const cards = orgStyle === 'cards';
  const state = ORG_STATES.includes(status) ? status : 'unknown';
  const flash = (orgFlash.get(id) || 0) > Date.now() ? ' org-flash' : '';
  // An agent node has a harness; the Owner node has none and keeps only its dot.
  const kind = agent === undefined ? null : HARNESS_MARK[agent] ? agent : 'unknown';
  const mark = cards && kind ? `<span class="org-mark" title="${esc(agent || 'Unknown harness')}" aria-hidden="true">${HARNESS_MARK[kind]}</span>` : '';
  const alert = cards && state === 'blocked' ? ORG_BLOCKED_ICON : '';
  const meter = cards && quota ? `<div class="org-quota" role="img" aria-label="${esc(`${PROVIDERS[agent]} quota ${quota.usedPercent}% used${quota.label ? ` · ${quota.label}` : ''}`)}"><i class="${quota.usedPercent >= 90 ? 'crit' : quota.usedPercent >= 70 ? 'warn' : ''}" style="width:${Math.max(0, Math.min(100, quota.usedPercent))}%"></i></div>` : '';
  return `<article class="org-node ${esc(className)} org-state-${state}${flash}" data-org-id="${esc(id)}"><div class="org-node-head">${mark}<span class="st ${esc(status || 'unknown')}" aria-hidden="true"></span><span class="pill">${esc(role)}</span><strong>${esc(name)}</strong>${alert}</div>
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
      id: `${ownerId}:${pane.id}`, role: pane.label || 'worker', name, status: pane.status, className: 'org-worker', agent: pane.agent || null, quota: orgQuotaWindow(s, pane.agent),
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

function organizationView(s) {
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
    id: 'boss', role: 'boss', name: 'Boss', status: boss.status, className: 'org-boss', thread: 'boss', agent: boss.agent || null, quota: orgQuotaWindow(s, boss.agent),
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
      id: `project:${p.slug}`, role: 'orch', name: p.label, status: orch?.status || (p.orch ? p.orch.status : 'unknown'), thread: p.slug, agent: orch?.agent || null, quota: orgQuotaWindow(s, orch?.agent),
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
    `<header class="page-intro"><div><h1>Organization</h1><p>Chart of the Owner, the Boss, project orchestrators, and workers. Select <b>Details</b> on a node to see its recorded values. Select <b>Messages</b> to write to the Boss or an orchestrator.</p></div><div class="org-style-switch" role="group" aria-label="Chart style">${['plain', 'cards'].map((style) => `<button type="button" data-org-style="${style}" aria-pressed="${orgStyle === style}">${style === 'plain' ? 'Plain' : 'Cards'}</button>`).join('')}</div></header>`,
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
  const selected = slug && projectSlugs(s).includes(slug) ? slug : defaultProject(s);
  $crumbs.innerHTML = selected ? `/ <a href="/projects">projects</a> / ${esc((s.projects || []).find((p) => p.slug === selected)?.project || s.control?.projects?.[selected]?.label || selected)}` : '';
  return [
    '<header class="page-intro"><div><h1>Projects</h1><p>Select a project to inspect its status, work, agents, and orchestrator handover.</p></div></header>',
    allocationSummary(s),
    projectSelector(s, selected),
    selected ? `<div class="project-detail" id="project-detail">${project(s, selected)}</div>` : '',
  ].join('');
}

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

const HARNESS_NAMES = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi' };
const TREND_ARROW = { up: ['↑', 'rising'], down: ['↓', 'falling'], flat: ['→', 'steady'] };

// Counts only: the scan keeps no message text. A rising cause asks the Owner to talk with the Boss; it sends no pane prompt.
function denialsBlock() {
  const d = denials;
  const head = '<div class="section-head"><h2>Denials and permission prompts</h2><span>Last 7 days, counts only</span></div>';
  if (!d?.rows?.length) return `<section id="denials">${head}<div class="calm-state">No denials or permission prompts are recorded yet. Herdr Boss reads the harness logs every 15 minutes.</div></section>`;
  const totals = Object.entries(d.harnessTotals || {}).sort((a, b) => b[1] - a[1]);
  const arrow = (x) => { const [sign, word] = TREND_ARROW[x.trend] || TREND_ARROW.flat; return `<span class="denial-trend ${esc(x.trend)}" title="${esc(`${word}: ${x.recent} in 24 hours, 6-day mean ${x.mean}`)}">${sign}<span class="visually-hidden"> ${word}</span></span>`; };
  const dayHead = d.days.map((day) => `<th class="mono">${esc(day.slice(5))}</th>`).join('');
  const waiting = d.catchingUp ? `<div class="calm-state">Herdr Boss still reads older logs: ${Math.ceil(d.pendingBytes / 1024 ** 2).toLocaleString()} MB left. The counts of older days are not complete, so the trend note waits.</div>` : '';
  const note = d.rising?.length ? `<div class="denial-note" role="status"><strong>${esc(d.note)}</strong><span>${d.rising.map((c) => `${esc(c.cause)}: ${c.recent} in 24 hours, 6-day mean ${c.mean}`).join(' · ')}</span></div>` : '';
  return `<section id="denials">${head}${waiting}${note}<div class="usage-metrics">${totals.map(([h, n]) => `<div><strong>${n.toLocaleString()}</strong><span>${esc(HARNESS_NAMES[h] || h)}</span></div>`).join('')}</div>`
    + `<div class="fleet-table-wrap"><table class="fleet-table denial-table"><thead><tr><th>Cause</th><th>Project</th><th>Harness</th>${dayHead}<th>Total</th><th>Trend</th></tr></thead><tbody>`
    + d.rows.map((r) => `<tr><td data-label="Cause"><strong>${esc(r.cause)}</strong></td><td data-label="Project">${esc(state.control?.projects?.[r.project]?.label || r.project)}</td><td data-label="Harness">${esc(HARNESS_NAMES[r.harness] || r.harness)}</td>${r.counts.map((n, i) => `<td class="mono" data-label="${esc(d.days[i].slice(5))}">${n || '·'}</td>`).join('')}<td class="mono" data-label="Total">${r.total.toLocaleString()}</td><td data-label="Trend">${arrow(r)}</td></tr>`).join('')
    + '</tbody></table></div></section>';
}

function recentUsageBlock() {
  const rows = usage?.recent || [];
  return `<section><div class="section-head"><h2>Recent recorded work</h2><span>Latest ${rows.length} runs</span></div>${rows.length ? `<div class="fleet-table-wrap"><table class="fleet-table"><thead><tr><th>Finished</th><th>Project</th><th>Harness / model</th><th>Outcome</th><th>Tokens</th></tr></thead><tbody>${rows.map((r) => `<tr><td data-label="Finished">${esc(clock(r.endedAt))}</td><td data-label="Project"><a href="/projects/${esc(r.project)}">${esc(r.project)}</a></td><td data-label="Harness / model">${esc(r.kind)}<small>${esc(r.model)}</small></td><td data-label="Outcome">${esc(r.outcome)}</td><td class="mono" data-label="Tokens">${r.inputTokens != null || r.outputTokens != null ? `${(r.inputTokens || 0).toLocaleString()} in · ${(r.outputTokens || 0).toLocaleString()} out` : 'unmeasured'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="calm-state">No run history yet.</div>'}</section>`;
}

// ---------- Project page ----------

// ---------- Project work: frontier, dependencies, groups, specs ----------
// Orchestrators publish these fields (docs/project-status.md). The Boss only derives views from them.

const projectViews = {};
const projectView = (slug) => (projectViews[slug] ||= { showDone: false, sort: 'order', group: 'all' });
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
function foldOpen(slug, key) { return foldState(slug)[key] === true; }
function setFoldOpen(slug, key, open) {
  const value = foldState(slug);
  value[key] = open;
  try { sessionStorage.setItem(FOLD_PREFIX + slug, JSON.stringify(value)); } catch {}
}
// A long project section stays a plain section on a desktop. On a phone it becomes a details element that remembers its open state for the session.
function collapsible({ slug, key, className = '', head = '', title, count = '', controls = '', body }) {
  if (!isPhone()) return `<section${className ? ` class="${esc(className)}"` : ''}>${head}${body}</section>`;
  const open = foldOpen(slug, key);
  return `<details class="fold-phone${className ? ` ${esc(className)}` : ''}" data-project-fold="${esc(slug)}" data-fold-key="${esc(key)}"${open ? ' open' : ''}>`
    + `<summary class="fold-summary"><h2>${esc(title)}${count ? ` <span class="sub">${esc(count)}</span>` : ''}</h2><span class="fold-chevron" aria-hidden="true"></span></summary>`
    + `<div class="fold-body">${controls}${body}</div></details>`;
}

// Current frontier: open work whose known blockers are all done. Next: open work that waits only on the current frontier.
// An orchestrator can set tasks[].frontier itself; then the Boss uses that and derives nothing.
function workModel(p) {
  const tasks = (p.tasks || []).filter((t) => t && t.title);
  const map = new Map(tasks.filter((t) => t.id).map((t) => [t.id, t]));
  const openBlockers = (t) => (t.blockedBy || []).filter((id) => map.has(id) && !isDone(map.get(id)));
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
  return { tasks, map, openBlockers, current, next, groups, explicit };
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
  const done = m.tasks.filter(isDone).length;
  const waiting = m.tasks.filter((t) => !isDone(t) && (t.status === 'blocked' || m.openBlockers(t).length)).length;
  const list = (set, empty) => set.size ? `<ul class="chip-list">${[...set].sort(byId).slice(0, 12).map((t) => taskChip(t)).join('')}</ul>${set.size > 12 ? `<small>+${set.size - 12} more</small>` : ''}` : `<p class="muted">${empty}</p>`;
  return `<section class="program"><div class="panel program-total"><h2>Overall progress</h2>${progressBar(done, m.tasks.length)}<small>${m.tasks.length - done} open · ${waiting} waiting on a blocker</small></div>
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

// Layered dependency graph: each column holds tasks whose blockers sit in earlier columns. Arrows run from blocker to dependent.
function dependencyGraph(m, slug) {
  const view = projectView(slug);
  const edges = m.tasks.flatMap((t) => (t.blockedBy || []).filter((id) => m.map.has(id)).map((id) => [id, t.id]));
  if (!edges.length) return '';
  const linked = new Set(edges.flat());
  let nodes = m.tasks.filter((t) => t.id && linked.has(t.id));
  if (!view.showDone) {
    // Keep completed tasks only as the direct blockers of open work, so the open chain keeps its context.
    const keep = new Set(nodes.filter((t) => !isDone(t)).map((t) => t.id));
    for (const t of nodes) if (!isDone(t)) for (const id of t.blockedBy || []) if (m.map.has(id)) keep.add(id);
    nodes = nodes.filter((t) => keep.has(t.id));
  }
  const truncated = nodes.length > 90;
  if (truncated) nodes = nodes.filter((t) => !isDone(t)).slice(0, 90);
  const inSet = new Set(nodes.map((t) => t.id));
  const layer = new Map();
  const visiting = new Set();
  const depth = (t) => {
    if (layer.has(t.id)) return layer.get(t.id);
    if (visiting.has(t.id)) return 0; // a cycle in published data; break it here
    visiting.add(t.id);
    const blockers = (t.blockedBy || []).filter((id) => inSet.has(id));
    const d = blockers.length ? 1 + Math.max(...blockers.map((id) => depth(m.map.get(id)))) : 0;
    visiting.delete(t.id);
    layer.set(t.id, d);
    return d;
  };
  nodes.forEach(depth);
  const groupOrder = new Map(m.groups.map((g, i) => [g.id, i]));
  const columns = [];
  for (const t of nodes) (columns[layer.get(t.id)] ||= []).push(t);
  for (const col of columns) col?.sort((a, b) => (groupOrder.get(a.group) ?? 99) - (groupOrder.get(b.group) ?? 99) || byId(a, b));
  const W = 168, H = 46, GX = 56, GY = 12, PAD = 8;
  const pos = new Map();
  columns.forEach((col, x) => (col || []).forEach((t, y) => pos.set(t.id, { x: PAD + x * (W + GX), y: PAD + y * (H + GY) })));
  const width = PAD * 2 + columns.length * (W + GX) - GX;
  const height = PAD * 2 + Math.max(...columns.map((c) => c?.length || 0)) * (H + GY) - GY;
  const paths = edges.filter(([a, b]) => pos.has(a) && pos.has(b)).map(([a, b]) => {
    const s = pos.get(a), e = pos.get(b);
    const x1 = s.x + W, y1 = s.y + H / 2, x2 = e.x, y2 = e.y + H / 2, mid = (x1 + x2) / 2;
    const open = !isDone(m.map.get(a));
    return `<path class="dep-edge${open ? ' open' : ''}" d="M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2 - 4},${y2}" marker-end="url(#dep-arrow-${esc(slug)})"></path>`;
  }).join('');
  const boxes = nodes.map((t) => {
    const { x, y } = pos.get(t.id);
    const role = m.current.has(t) ? ' current' : m.next.has(t) ? ' next' : '';
    const hidden = (t.blockedBy || []).filter((id) => !inSet.has(id) && !(m.map.has(id) && isDone(m.map.get(id)))).length;
    const url = safeUrl(t.url);
    const body = `<rect class="dep-node s-${esc(t.status || 'todo')}${role}" x="${x}" y="${y}" width="${W}" height="${H}" rx="6"></rect>
      <text x="${x + 9}" y="${y + 18}" class="dep-id">${esc(t.id)}${role ? ` · ${role.trim()}` : ''}${hidden ? ` · +${hidden} external` : ''}</text>
      <text x="${x + 9}" y="${y + 35}" class="dep-title">${esc(t.title.length > 24 ? `${t.title.slice(0, 23)}…` : t.title)}</text><title>${esc(`${t.id} ${t.title} (${STATUS_LABEL[t.status || 'todo']})`)}</title>`;
    return url ? `<a href="${esc(url)}" target="_blank" rel="noreferrer">${body}</a>` : `<g>${body}</g>`;
  }).join('');
  const toggle = `<label class="inline-toggle"><input type="checkbox" data-project-done="${esc(slug)}" ${view.showDone ? 'checked' : ''}> Show completed work</label>`;
  const body = `<div class="dep-legend"><span class="s-todo">To do</span><span class="s-doing">In progress</span><span class="s-review">Review</span><span class="s-blocked">Blocked</span><span class="s-done">Done</span><span class="current">Current frontier</span><span class="next">Next</span></div>
    <div class="panel dep-scroll"><svg class="dep-graph" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Dependency graph with ${nodes.length} tasks">
      <defs><marker id="dep-arrow-${esc(slug)}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" class="dep-arrow"></path></marker></defs>${paths}${boxes}</svg></div>
    ${truncated ? '<small class="muted">The graph shows the first 90 open tasks. Filter the issue list below for the rest.</small>' : ''}`;
  return collapsible({ slug, key: 'dependencies', className: 'dep-section', head: `<div class="section-head"><h2>Dependencies <span class="sub">arrows run from blocker to dependent · columns show order</span></h2>${toggle}</div>`, title: 'Dependencies', count: `${edges.length}`, controls: `<div class="fold-controls">${toggle}</div>`, body });
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
      return `<tr class="${m.current.has(t) ? 'row-current' : ''}"><td class="mono" data-label="ID">${esc(t.id || '')}</td><td data-label="Title">${url ? `<a href="${esc(url)}" target="_blank" rel="noreferrer">${esc(t.title)}</a>` : esc(t.title)}${t.kind ? ` <span class="tag">${esc(t.kind)}</span>` : ''}${m.current.has(t) ? ' <span class="tag current">current</span>' : m.next.has(t) ? ' <span class="tag">next</span>' : ''}</td><td data-label="Status"><span class="st-badge s-${esc(t.status || 'todo')}">${esc(STATUS_LABEL[t.status || 'todo'] || t.status)}</span></td><td data-label="Group">${esc(group?.title || '')}</td><td class="mono" data-label="Blocked by">${(t.blockedBy || []).map((id) => `<span class="${waits.includes(id) ? 'text-crit' : 'muted'}">${esc(id)}</span>`).join(' ')}</td><td data-label="Labels">${(t.labels || []).map((l) => `<span class="tag">${esc(l)}</span>`).join(' ')}</td><td class="mono" data-label="Updated">${t.updated ? esc(ago(t.updated)) : ''}</td></tr>`;
    }).join('') || '<tr><td colspan="7" class="muted" data-label="">No work matches the filter.</td></tr>'}</tbody></table></div>`;
  return collapsible({ slug, key: 'work', head: `<div class="section-head"><h2>All work <span class="sub">${rows.length} shown of ${m.tasks.length}</span></h2>${tools}</div>`, title: 'All work', count: `${rows.length} of ${m.tasks.length}`, controls: tools, body: table });
}

function gatesRisksBlock(p) {
  const gates = Array.isArray(p.gates) ? p.gates : [];
  const risks = Array.isArray(p.risks) ? p.risks : [];
  if (!gates.length && !risks.length) return '';
  return `<section class="two">${gates.length ? `<div class="panel"><h2>Human gates</h2><table class="issue-table"><thead><tr><th>Gate</th><th>Needs</th><th>Evidence</th><th>Status</th></tr></thead><tbody>${gates.map((g) => `<tr><td data-label="Gate">${g.id ? `<b class="mono">${esc(g.id)}</b> ` : ''}${esc(g.title)}</td><td data-label="Needs">${esc(g.needs || '')}</td><td data-label="Evidence">${esc(g.evidence || '')}</td><td data-label="Status">${esc(g.status || '')}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${risks.length ? `<div class="panel"><h2>Risks</h2><ul class="notes">${risks.map((r) => `<li>${code(r)}</li>`).join('')}</ul></div>` : ''}</section>`;
}

// The drift check result that herdr-boss publish stores for the project AGENTS.md.
function agentsDriftLine(check) {
  const errors = Number.isInteger(check?.errors) ? check.errors : 0;
  const warnings = Number.isInteger(check?.warnings) ? check.warnings : 0;
  if (!errors && !warnings) return '';
  return `<div class="warnbox">AGENTS.md drift: ${errors} errors, ${warnings} warnings. Run <span class="mono">herdr-boss check agents</span>.</div>`;
}

// The kit revision that the orchestrator loaded, against the current kit revision of Herdr Boss.
function kitRevisionLine(p) {
  const current = p.currentKitRevision;
  if (!current) return '';
  const loaded = p.kitRevision || 'not published';
  const text = `Kit revision ${esc(loaded)}, current ${esc(current)}`;
  if (loaded === current) return `<div class="win-foot">${text}.</div>`;
  return `<div class="warnbox">${text}. The orchestrator uses an old kit. Run <span class="mono">herdr-boss kit install</span> in the project, and re-read <span class="mono">docs/orchestration/herdr-boss.md</span>.</div>`;
}

function project(s, slug) {
  const published = (s.projects || []).find((x) => x.slug === slug);
  const live = s.control?.projects?.[slug];
  const p = published || (live ? { slug, project: live.label, workspace: live.workspace, tasks: [] } : null);
  if (!p) return `<div class="panel empty">No open project "${esc(slug)}".</div>`;
  const panes = s.herdr?.panes || [];
  const byName = new Map(panes.filter((x) => x.name).map((x) => [x.name, x]));
  const phases = p.phases?.length ? `<ol class="phases">${p.phases.map((ph) => {
    const idx = p.phases.indexOf(p.phase);
    const i = p.phases.indexOf(ph);
    return `<li class="${ph === p.phase ? 'current' : idx >= 0 && i < idx ? 'done' : ''}">${esc(ph)}</li>`;
  }).join('')}</ol>` : p.phase ? `<div><span class="tag">${esc(p.phase)}</span></div>` : '';
  const metrics = p.metrics?.length ? `<section class="metrics">${p.metrics.map((m) => `<div class="panel metric"><div class="k">${esc(m.label)}</div><div class="v">${esc(m.value)}</div>${m.detail ? `<div class="d">${esc(m.detail)}</div>` : ''}</div>`).join('')}</section>` : '';
  const c = taskCounts(p);
  const colors = STATUS_COLOR;
  const work = workModel(p);
  const view = projectView(slug);
  // The Done column can hold hundreds of closed issues; show the latest ten unless completed work is on.
  const columnTasks = (k) => {
    const list = (p.tasks || []).filter((t) => (t.status || 'todo') === k);
    return k === 'done' && !view.showDone ? list.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || ''))).slice(0, 10) : list;
  };
  const board = (p.tasks || []).length ? collapsible({ slug, key: 'board', head: `<h2>Tasks <span class="sub">${(p.tasks || []).length} total · worker status is live from Herdr${!view.showDone && c.done > 10 ? ` · Done shows the latest 10 of ${c.done}` : ''}</span></h2>`, title: 'Tasks', count: `${(p.tasks || []).length}`, body: `<div class="board">${STATUSES.map((k) => `<div class="col" style="--c:var(--${colors[k]})"><h3><span>${STATUS_LABEL[k]}</span><span class="num">${c[k]}</span></h3>
      ${columnTasks(k).map((t) => {
        const w = t.worker && byName.get(t.worker);
        return `<div class="task">${t.id ? `<span class="id">${esc(t.id)}</span>` : ''}<span class="title">${esc(t.title)}</span>${t.note ? `<span class="note">${esc(t.note)}</span>` : ''}${t.worker ? `<span class="w"><span class="st ${w ? w.status : 'shell'}"></span>${esc(t.worker)}${w ? ` · ${esc(w.status)}` : ' · not running'}</span>` : ''}</div>`;
      }).join('')}</div>`).join('')}</div>` }) : '';
  const links = p.links?.length ? `<div class="panel"><h2>Links</h2><ul class="links">${p.links.map((l) => safeUrl(l.url) ? `<li><a href="${esc(safeUrl(l.url))}" target="_blank" rel="noreferrer">${esc(l.label || l.url)}</a></li>` : `<li>${esc(l.label || '')}</li>`).join('')}</ul></div>` : '';
  const notes = p.notes?.length ? `<div class="panel"><h2>Notes</h2><ul class="notes">${p.notes.map((n) => `<li>${code(n)}</li>`).join('')}</ul></div>` : '';
  const ws = p.workspace && s.herdr?.workspaces.find((w) => w.id === p.workspace || w.label === p.workspace);
  const wsBlock = ws ? workspacesBlock({ ...s, herdr: { ...s.herdr, workspaces: [ws] } }, slug) : '';
  return [
    `<section class="phead"><h1>${esc(p.project)}</h1>${p.goal ? `<div class="owner-goal"><strong>Current Owner goal</strong><p>${esc(p.goal)}</p></div>` : ''}${p.summary ? `<p>${esc(p.summary)}</p>` : ''}${phases}<div class="win-foot">${published ? `updated ${ago(p.updated)}${staleStatusTag(s, p)}${p.status ? ` · ${esc(p.status)}` : ''}` : 'No project status published yet'}${p.git && typeof p.git === 'object' ? ` · <span class="mono">${esc(p.git.branch || '')}${p.git.commit ? ` @ ${esc(String(p.git.commit).slice(0, 12))}` : ''}${p.git.dirty ? ' · uncommitted changes' : ''}</span>` : ''}</div></section>`,
    p.errors ? `<div class="warnbox">${esc(p.errors.join('; '))}</div>` : '',
    agentsDriftLine(p.agentsCheck),
    published ? kitRevisionLine(p) : '',
    handoffBlock(s, slug),
    metrics,
    programBlock(work),
    dependencyGraph(work, slug),
    groupsBlock(work, slug),
    specsBlock(work, slug),
    board,
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
    <h3>Handovers</h3><p>Orchestrators whose quota comes near its reserve, and successors that wait for review. Open the project to plan, inspect, or activate a handover.</p>
    <h3>Projects</h3><p>The bar above the cards shows the applied share of each project, in card order. Its colors match the top edge of each card. A label such as <b>30% · 2</b> shows the share and the effective slots; the tooltip shows all values. Change the shares on the Allocation page.</p><p>A card per project with its published status and task mix. The table shows the orchestrator, workers in use against the share, and the policy mode. Select a project for its details.</p>
    <h3>Subscriptions and machine health</h3><p>Select a bar to open all quota windows, or the processes and load history. After a restart, "Quotas from HH:MM" shows saved quotas until the first new quota read succeeds. The Machine guard switch turns CPU and load warnings and worker-start blocks on or off. Choose a pause length to suspend those rules for a time; select <b>Resume guard</b> to end a pause early. Memory and disk warnings stay on. Disk space reports the filesystem that contains the Herdr Boss data directory.</p>`],
  projects: ['Projects', `
    <p>Select a project card. The detail below it shows what the orchestrator published and what runs now.</p>
    <p><b>Current Owner goal</b> shows the durable direction set by the Owner. Keep it in every status publication until the Owner changes or clears it.</p>
    <p>The bar above the cards shows the applied share and the effective slots of each project, in card order. Its colors match the top edge of each card. An idle project is faded. A paused project is faded and striped.</p>
    <h3>Progress and frontier</h3><p><b>Current frontier</b> is open work with no open blocker. <b>Next</b> waits only on the current frontier. The orchestrator can set both itself.</p>
    <h3>Dependencies</h3><p>Columns show the order. An arrow runs from a blocker to the work that waits on it. Current work has an orange border; next work has a dashed border. Select a box to open the issue. <b>Show completed work</b> adds finished tasks.</p>
    <h3>Groups and specs</h3><p>Progress per release or phase, and the work under each spec.</p>
    <h3>Tasks and All work</h3><p>The board groups tasks by status; Done shows the latest 10 until you show completed work. The list sorts and filters all work.</p>
    <h3>Project continuity</h3><p>Plan a handover to another harness. Prepare copies the published Owner goal to the successor. An invalid published goal, such as a blank value or a value over 1000 characters, is omitted. If migration is unavailable or fails, Prepare starts fresh and records the reason. Fresh preparation captures at most 200 recent source-pane lines and 20,000 characters, and both caps include the truncation marker. It redacts likely credentials and marks the snapshot as historical context. If recent text is unavailable, it tries the visible pane; if both reads fail, it marks context unavailable. The successor only reads and reports until activation. Inspect its answer, then confirm activation. For a project, activation labels the successor <b>orch</b> and the old pane <b>orch previous</b>. For the Boss, it labels them <b>boss</b> and <b>boss previous</b>. Herdr Boss closes the old pane after 120 minutes when the same handoff and pane roles are still confirmed. Unavailable pane data defers retirement until a later engine tick. The successor gets one notice after retirement. The old agent is asked for a final summary for the successor. A project handover notifies the project workers and the Boss. A Boss handover notifies the Boss-workspace peers and the Owner.</p>
    <h3>Phone</h3><p>On a phone, the long sections start collapsed. Select a section title to open it. The dashboard remembers each open section for this project during the session. Overall progress and the frontier stay open.</p>
    <h3>AGENTS.md drift</h3><p><b>AGENTS.md drift</b> shows the errors and warnings that <b>herdr-boss publish</b> found in the project AGENTS.md. An error is a missing, old, or hand-edited Herdr Boss stub, or a missing, old, or hand-edited kit file <code>docs/orchestration/herdr-boss.md</code>. A warning is stale orchestration text, such as a fixed pane ID, a dated line, a copied model list, or text that sends pushes or product decisions to the Boss. Run <b>herdr-boss check agents</b> in the project for each finding. Run <b>herdr-boss kit install</b> to fix an error.</p>
    <h3>Kit revision</h3><p><b>Kit revision</b> shows the kit revision that the orchestrator loaded, from <code>kitRevision</code> in its status file, and the current kit revision. A warning shows when they are different. The orchestrator then runs <b>herdr-boss kit install</b> and re-reads <code>docs/orchestration/herdr-boss.md</code>.</p>
    <h3>Stale status</h3><p><b>Status stale: AGE</b> shows next to the updated time when the published status is older than 2 hours and, after that publish, a worker was working in the last 2 hours or new commits landed on the project repository. A paused project is never stale. The orchestrator gets one notice for each stale status. Publish the current plan and progress to clear the mark.</p>
    <p>The data comes from the project's status file. When a section is missing, the orchestrator has not published those fields.</p>`],
  mailbox: ['Mailbox', `
    <p>One inbox for every reply and report to the Owner. The Boss and the project orchestrators write them with <code>herdr-boss say</code>, and the Boss posts reports with <code>herdr-boss mail post</code>. Examples are the morning handback and the items queued for the Owner.</p>
    <h3>Items</h3><p>Each item shows the sender, the project, the time, the required action, and the title of a report or the first line of a reply. <b>Open</b> lists the items that wait for you, newest first. <b>Done</b> lists the closed items with your answer.</p>
    <p>Select an item to open it. The open item shows the full text. A report shows as formatted Markdown. A reply shows as plain text. Opening an item marks it read.</p>
    <h3>Actions</h3><p><b>Answer</b>: type an answer and select <b>Send</b>. <b>Approve</b>: select <b>Approve</b> or <b>Decline</b>. A note is optional. <b>Decide</b>: select a choice, or type an answer and select <b>Send</b>. The choice buttons appear when the item has a Markdown list under a <b>Choices</b> heading. <b>Read</b>: select <b>Mark read</b>.</p>
    <p>The page asks you to confirm each send. The answer goes to the thread of the sender, the same way as a message from the Organization page. Herdr Boss sends it when the agent is idle or done. Then the item moves to <b>Done</b>.</p>
    <h3>Unread count</h3><p>The number next to <b>Mailbox</b> in the header shows the unread items. On a phone, it also shows on the menu button.</p>
    <p>Herdr Boss keeps the items for 30 days. A read-only preview shows the items and refuses a read or a send.</p>`],
  allocation: ['Allocation', `
    <p>The resource policy for all projects. Changes are a draft until you select <b>Apply policy</b>.</p>
    <h3>Capacity and handover</h3><p>The global limit of working agents, the lending of unused slots, the quota reserve, and automatic handover with its activation level.</p>
    <h3>Orchestrator succession</h3><p>The ranked successors for automatic handover. Use the arrows to change the order. Unlisted choices are never selected automatically.</p>
    <h3>Workspace projects</h3><p>Clear a workspace switch to include that workspace as a project. An excluded workspace stays on Agents and shows <b>Not a project</b>. It gets no project share or worker slots. Herdr Boss stores workspace labels and resolves saved Herdr IDs to labels. The Boss workspace stays excluded while a pane is labelled <code>boss</code>.</p>
    <h3>Project shares</h3><p>Drag a boundary on the bar, or focus it and use the arrow keys. Projects to the left stay fixed; the rest share the remainder. A share is advisory. The mode sets a project to auto, active, idle, or paused.</p>
    <p>The <b>set share</b> is the share in your policy draft. The bar widths show it. The <b>effective share</b> is the number of worker slots the project has now, divided by the applied maximum of working agents. It changes only after you select <b>Apply policy</b>.</p>
    <p>A bar label such as <b>30% · 2</b> shows the set share and the effective slots. A narrow segment shows fewer labels; its tooltip shows all values.</p>
    <p>An idle project is faded. A paused project is faded and striped.</p>
    <p>When <b>Borrow idle shares</b> is on, a project lends its unused slots to the projects that use all their slots. An idle or paused project lends all its slots. Another project lends its base slots minus its running workers. It keeps 1 slot when its orchestrator is working or blocked. The lent slots go to the full projects by share. When no project is full, no project lends. A project row shows the borrowed or lent count. Borrowed slots are real capacity. The global limit still applies.</p>`],
  settings: ['Settings', `
    <p>Each harness section holds the models and provider routes of that harness. Provider quotas and machine limits are below the harnesses.</p>
    <h3>Harnesses</h3><p>Clear <b>Available</b> to stop all workers from using a harness. The preferred model is the model that worker start and handover use when no model is given. An empty choice uses the harness default.</p>
    <p>Each model row has a box and a provider. Clear the box to stop that harness from using the model. Choose a provider to count the model against that provider quota. Choose <b>Unmetered</b> when no quota applies.</p>
    <p>A Codex row offers only <b>Codex</b> and <b>Unmetered</b>. A Claude row offers only <b>Claude</b> and <b>Unmetered</b>. Opencode and Pi rows offer <b>Claude</b>, <b>Codex</b>, <b>OpenCode Go</b>, and <b>Unmetered</b>. </p>
    <p>An old <code>modelProviders</code> route can send a Codex or Claude model to another provider. Herdr Boss ignores that route and treats the model as Unmetered in that harness. The row shows <b>Ignored</b> and a note. Choose a provider in the row to store a compatible route for that harness. Apply policy refuses a save while an available Codex or Claude harness still has an ignored route.</p>
    <p>A model can be in more than one harness. Each harness keeps its own box and provider for it, so a change in one harness does not change another.</p>
    <p>Pi also uses seven unmetered OpenCode Zen entries: <code>opencode/big-pickle</code>, <code>opencode/ling-3.0-flash-fin-free</code>, <code>opencode/mimo-v2.6-flash-free</code>, <code>opencode/muse-spark-1.2-contributor-free</code>, <code>opencode/muse-spark-1.3-contributor-free</code>, <code>opencode/nemotron-3-ultra-free</code>, and <code>opencode/nemotron-3.5-lightning-free</code>. They start unmetered and appear as Pi rows here. <code>opencode/space-bunny-free</code> has no Pi catalog entry, so Pi refuses it. Catalog support does not guarantee a configured account or live provider availability.</p>
    <h3>Add a model</h3><p>Type a model string in a harness section and select <b>Add model</b>. Use letters, digits, dots, underscores, slashes, and hyphens. Spaces and shell characters are refused. A new model is marked <b>local</b>, starts unmetered, and is stored in the local policy, not in <code>kit/models.json</code>. Select <b>Remove</b> to delete a local model.</p>
    <h3>Provider quotas</h3><p>Choose <b>Manage pace</b> or <b>Ignore quota</b> for each provider. Ignore quota turns off pacing and pace warnings for worker dispatch. Handover risk and automatic handover still use live quota data. A live window at 100% or more still exhausts the provider until its reset, and worker start refuses it unless you use <code>--force</code>. Enter a whole pacing goal percent from 0 to 100. Leave it blank for 100%. Choose <b>At reset</b>, a one-off local date and time, or whole hours before each reset. A goal end must be after now, after the window start, and no later than reset. A one-off goal clears after its time or window reset. A recurring end stays in later windows.</p>
    <p>The Machine section sets the guard, CPU limits, 5-minute load backstops, the Owner idle period, disk warning thresholds, and the notice cooldown. Turn the guard off to stop CPU and load warnings and worker-start blocks. Choose a pause length to suspend those rules until the expiry time. Select <b>Resume guard</b> to end a pause early. Memory and disk warnings stay on.</p>
    <p>Disk free space is measured on the filesystem that contains the Herdr Boss data directory. The warning threshold defaults to 20 GB free. The critical threshold defaults to 5 GB free. Free percent is information only. Herdr Boss shows it to one decimal place. Disk notices go to the project orchestrator when that project has linked worker worktrees. They include linked and prunable counts.</p>
    <p>When the guard is active, Herdr Boss blocks a worker start if total sampled CPU exceeds its configured limit or the 5-minute load average exceeds its configured backstop. Leave the away CPU limit or either load backstop blank to disable that threshold.</p>
    <p>Changes stay in a draft until you select <b>Apply policy</b>. A rejected save shows the server error and keeps your draft.</p>`],
  organization: ['Organization', `
    <p>A chart of the organization, from top to bottom: the Owner, the Boss, one orchestrator for each project, and the workers under each orchestrator. The page cannot change resources. Use Settings for resources.</p>
    <h3>Nodes</h3><p><b>Owner</b> shows <b>At the Mac</b> or <b>Away</b> from the machine idle time. <b>Boss</b> shows the pane labeled <code>boss</code>, its harness and state, the quota use of a Codex or Claude harness, and the handover state. The Boss workspace workers are below the Boss.</p>
    <p>Each project node shows the orchestrator pane, harness, and state, the first published task with status <b>doing</b>, the worker slots in use against the slots and share, and the handover state. The projects use the project order. A workspace marked not a project has no node.</p>
    <p>A worker node shows the agent name, harness, and state. The task ID comes from the published task whose <b>worker</b> field names that agent.</p>
    <h3>Reserve</h3><p>A <b>reserve</b> node shows a prepared successor. It appears only when a handoff record is prepared, its source is the current orchestrator or Boss pane, and the successor pane is live. A recommended successor is not a reserve.</p>
    <h3>Details</h3><p>Select <b>Details</b> on a node to show its recorded values. Select <b>Hide details</b> to close them.</p>
    <h3>Style</h3><p>The switch at the top selects the <b>Plain</b> and <b>Cards</b> styles. Plain is the default. This browser keeps your choice. If the browser cannot store it, the page uses Plain at the next load.</p>
    <p>In Cards, each agent node has a harness mark: Claude, Codex, OpenCode, Pi, or a question mark for an unknown harness. A Codex or Claude node shows a thin bar with its quota use. A working node has a slow pulse on its border. A blocked node has the warning color and a warning icon. A failed node has the error color. An idle or done node is dimmed.</p>
    <p>In Cards, a new Owner message draws a short line with a moving dot from the Owner to the Boss or the orchestrator for about 1 second. A new worker report notice draws a line from the worker to its orchestrator. The page uses only the events that it already loads. When your system asks for reduced motion, the page shows a 1-second highlight on both nodes and no movement.</p>
    <h3>Phone</h3><p>On a phone, the chart has one column. Each worker list shows only a count. Select <b>Show</b> to expand the workers, and select <b>Hide</b> to collapse them.</p>
    <h3>Messages</h3><p>The Boss node and each project node have a <b>Messages</b> button. It opens the thread of that node. A thread holds the messages in both directions, oldest first.</p>
    <p>Type a message of up to 2000 characters and select <b>Send</b>. The nudge buttons send a fixed text: <b>Continue.</b>, <b>Use your free worker slots.</b>, or <b>Pause after the current task.</b> <b>Ask for status</b> asks the agent for a short status report and a new status file. The page asks you to confirm each send.</p>
    <p>A new message is <b>Queued</b>. Herdr Boss sends it only when the agent is idle or done. It never types into a working or blocked agent. Then the message is <b>Sent</b>. A <b>Failed</b> message gets up to 3 more attempts on later ticks. Herdr Boss accepts at most 10 messages a minute.</p>
    <p>The Boss and the orchestrators reply with <code>herdr-boss say</code>. The Boss can post a longer report with <code>herdr-boss mail post</code>. The page shows a report as formatted Markdown. You cannot message a worker. Send a worker request to its orchestrator.</p>
    <p>The open panel reads the thread again every 10 seconds. A read-only preview shows the threads and refuses a send.</p>
    <h3>Data limits</h3><p><b>Not reported</b> means that the current state does not hold the value. Herdr Boss does not receive the model of a running agent. The page does not read a task from a pane title. It shows no pane output, messages, or secrets.</p>`],
  agents: ['Agents', `
    <p>Every Herdr workspace with its orchestrator and workers, live from Herdr.</p>
    <p>A status dot shows working, blocked, failed, idle, or done. Failed means the last visible worker output matched a known provider error, including <b>Free usage exceeded</b>. Herdr Boss reads only the last eight visible lines: on every tick while a worker is working, and when a worker first appears idle or done or changes into either state. A worker can show failed while Herdr still reports it working; the engine then does not count it as a running worker. The failed status clears when a later read shows no known failure, or when a different worker uses the pane. Herdr Boss sends the matched error label, worker name, and pane ID to the project orchestrator. Blocked workers get a notice after five minutes. Idle and done agents are ready for input; they have not always finished their task. Rows with the <b>orch</b> or <b>boss</b> label are orchestrators.</p>
    <p>An orchestrator that stays idle gets a nudge when its published status still has an actionable task: status <b>todo</b>, <b>doing</b>, or <b>review</b> with every task in its <b>blocked by</b> list done. The project must be in <b>auto</b> or <b>active</b> mode, no other worker in that workspace may work, be blocked, or have failed, and the idle period must reach the configured idle minutes. The notice names the task ID and title. Resume an idle or done worker on that task, or start suitable work. One key per project and task keeps the normal notice cooldown in charge; a different next task prompts again.</p>`],
  browsers: ['Browsers', `
    <p>One persistent Chrome per project. Agents drive it; you can watch and help.</p>
    <h3>Start and manage</h3><p><b>Open visible</b> or <b>Open headless</b> starts the browser. <b>Manage</b> restarts it in the other mode, closes it, or sets the window size for the next launch.</p>
    <h3>States</h3><p><b>ready</b>: Chrome runs with the project profile and answers on its debugging port. <b>not responding</b>: Chrome runs with the project profile, but its debugging port does not answer within 2 seconds. The preview is not available. Use <b>Manage</b> to restart or close it. If Chrome does not accept the close command, Herdr Boss sends SIGTERM to that Chrome process only. <b>offline</b>: no Chrome runs with the project profile. <b>port conflict</b>: another process uses the port.</p>
    <h3>Preview</h3><p><b>One tab</b> shows the selected tab with its address bar. <b>All tabs</b> shows every tab in one grid, without controls; select a tile to focus it. <b>Live</b> refreshes at the chosen interval. Without <b>Live</b>, the preview shows the last capture; <b>Refresh</b> takes a new one.</p>
    <h3>Tabs</h3><p><b>Agent</b> marks a tab an agent uses. Screenshots never change a page. Navigation and input on an agent tab ask for confirmation first. <b>Hidden</b> marks a tab that is not visible; some web apps do not draw there. <b>New tab</b> opens a page of your own.</p>
    <h3>Control</h3><p>Select the screenshot to open the large view. The large view shows a still image of the last capture. Turn on <b>Control browser</b> or <b>Live</b> to refresh it at the chosen interval. Turn on <b>Control browser</b>, then click the image and type. Paste long text or a password into the masked field. On a phone the large view is full screen and the image fills the height. The text field and key controls appear only while <b>Control browser</b> is on.</p>`],
  analytics: ['Analytics', `
    <p>Recorded worker runs per project and provider: duration, outcome, and measured tokens.</p>
    <p>Token totals include only runs that report tokens. Coverage shows how many runs have measurements. Quota percentages are global per provider; they are not project token counts.</p>
    <h3>Denials and permission prompts</h3><p>Herdr Boss reads the Claude, Codex, OpenCode, and Pi logs every 15 minutes. It counts classifier refusals, sandbox errors, escalation requests, permission prompts, prompts with no answer within 10 minutes, and Herdr guard blocks. It keeps only the day, harness, cause, project, and count. It keeps no message text.</p>
    <p>The table shows the last 7 days by cause and project. The arrow compares the last 24 hours with the mean of the 6 days before. When a cause is above 2 times its mean and above 10 events, the page and the bulletin show <b>Discuss this trend with the Boss.</b> Herdr Boss sends no prompt to an orchestrator about it. While more than 1 MB of older logs is unread, the note waits, because the counts of older days are not complete.</p>`],
  logs: ['Logs', `
    <p>The top line tells whether Herdr Boss sends notices to orchestrators.</p>
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
  document.getElementById('help-body').innerHTML = `${body}<p class="help-more">On a screen up to 760 px wide, use the menu button at the top to change pages. Commands and setup: <code>docs/cli.md</code> and <code>docs/user-guide.md</code> in the Herdr Boss repository.</p>`;
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

function render(force = false) {
  if (!state) return;
  if (!policyDirty) policyDraft = null;
  if (!force && policyDirty && ['/allocation', '/settings'].includes(location.pathname) && document.activeElement?.closest?.('#control-plane, #settings-plane')) {
    $updated.textContent = `updated ${ago(state.updatedAt)}`;
    return;
  }
  const legacy = /^\/p\/([^/]+)\/?$/.exec(location.pathname);
  if (legacy) history.replaceState(null, '', `/projects/${legacy[1]}`);
  const m = /^\/projects\/([^/]+)\/?$/.exec(location.pathname);
  const route = m || location.pathname === '/projects' ? 'projects' : ['mailbox', 'allocation', 'settings', 'organization', 'agents', 'browsers', 'analytics', 'logs'].includes(location.pathname.slice(1)) ? location.pathname.slice(1) : 'overview';
  const html = route === 'projects' ? projectsView(state, m ? decodeURIComponent(m[1]) : null) : route === 'mailbox' ? mailboxView(state) : route === 'allocation' ? allocationView(state) : route === 'settings' ? settingsView(state) : route === 'organization' ? organizationView(state) : route === 'agents' ? agentsView(state) : route === 'browsers' ? browsersView(state) : route === 'analytics' ? analyticsView(state) : route === 'logs' ? logsView(state) : overview(state);
  $navMenuLabel.textContent = NAV_LABEL[route] || 'Menu';
  if (route !== 'projects') $crumbs.innerHTML = '';
  for (const a of $nav.querySelectorAll('a')) {
    if (a.dataset.nav === route) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  updateMailboxBadge(state);
  if (html !== lastRender) {
    const focusId = document.activeElement?.dataset?.mailDraft ? document.activeElement.id : null;
    $app.innerHTML = html;
    lastRender = html;
    if (route === 'mailbox') mailRestoreDrafts(focusId);
  }
  if (route === 'organization') orgMotion(state);
  else orgEventMark = null;
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
}, true);

// Re-render when the viewport crosses the phone breakpoint, so the desktop and phone treatments swap.
phoneMedia.addEventListener('change', () => { lastRender = ''; render(); });

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
  if (e.target.dataset.browserTab) {
    const slug = e.target.dataset.browserTab;
    browserSelectedTab[slug] = e.target.value;
    delete browserNavigation[slug];
    delete browserAddressDraft[slug];
    refreshBrowserPreview(slug);
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
  const navigateSlug = e.target.dataset.browserNavigate || (e.target.id === 'browser-viewer-navigate' ? document.getElementById('browser-viewer').dataset.project : null);
  if (!sizeSlug && !navigateSlug) return;
  e.preventDefault();
  const form = e.target;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    if (sizeSlug) {
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
  const toggle = e.target.closest?.('[data-org-node]');
  if (!toggle) return;
  const id = toggle.dataset.orgNode;
  if (orgOpen.has(id)) orgOpen.delete(id); else orgOpen.add(id);
  lastRender = ''; render(true);
  document.querySelector(`[data-org-node="${CSS.escape(id)}"]`)?.focus();
});

document.addEventListener('click', async (e) => {
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
  const tile = e.target.closest?.('[data-browser-focus-tab]');
  if (tile) {
    const slug = tile.dataset.browserFocusTab;
    browserSelectedTab[slug] = tile.dataset.tab;
    delete browserNavigation[slug]; delete browserAddressDraft[slug];
    setBrowserView(slug, 'tab');
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
      saveMessage = 'Policy saved';
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
    render();
    if (location.pathname === '/mailbox' && mailbox.loaded && !mailbox.loading && JSON.stringify(state.mailbox) !== mailbox.counts) loadMailbox();
  });
  es.onopen = () => $dot.classList.add('on');
  es.onerror = () => { $dot.classList.remove('on'); $updated.textContent = 'reconnecting…'; };
}
async function refreshRoamgate() {
  try {
    const response = await fetch('/api/roamgate');
    const status = await response.json();
    $roamgate.hidden = !response.ok || !status.available;
  } catch { $roamgate.hidden = true; }
}
async function refreshExtras() {
  const results = await Promise.allSettled(['/api/models', '/api/usage', '/api/browser-sessions', '/api/handoffs', '/api/denials'].map((url) => fetch(url).then((r) => r.json())));
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
  if (location.pathname === '/mailbox' && !mailbox.loading) await loadMailbox();
  lastRender = '';
  render();
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
setInterval(render, 10000);
