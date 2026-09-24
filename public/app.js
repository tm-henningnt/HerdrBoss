const $app = document.getElementById('app');
const $dot = document.getElementById('dot');
const $updated = document.getElementById('updated');
const $push = document.getElementById('push');
const $crumbs = document.getElementById('crumbs');
const $nav = document.getElementById('primary-nav');

let state = null;
let lastRender = '';
let models = {};
let usage = null;
let browserSessions = [];
let handoffRecords = [];
const handoffPlans = {};
const handoffModes = {};
const handoffTargets = {};
const handoffModels = {};
const handoffOutputs = {};
const handoffReviewed = new Set();
const handoffBusy = new Set();
const handoffMessages = {};
let policyDraft = null;
let policyDirty = false;
let saveMessage = '';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
const until = (iso) => (iso ? dur((new Date(iso) - Date.now()) / 1000) : '–');
function clock(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric' })} ${t}`;
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

function rebalance(changed, value) {
  const entries = Object.entries(policyDraft.projects).filter(([slug]) => state.control.projects[slug]);
  const rest = entries.filter(([slug]) => slug !== changed);
  policyDraft.projects[changed].share = Number(value);
  if (!rest.length) { policyDraft.projects[changed].share = 100; return; }
  const total = rest.reduce((n, [, p]) => n + p.share, 0);
  const slots = 100 - Number(value);
  const parts = rest.map(([slug, p]) => ({ slug, raw: slots * (total ? p.share / total : 1 / rest.length) }));
  let left = slots;
  for (const p of parts) { policyDraft.projects[p.slug].share = Math.floor(p.raw); left -= Math.floor(p.raw); }
  parts.sort((a, b) => (b.raw % 1) - (a.raw % 1));
  for (let i = 0; i < left; i++) policyDraft.projects[parts[i % parts.length].slug].share++;
}

function controlBlock(s) {
  ensureDraft(s);
  if (!policyDraft || !s.control) return '';
  const d = policyDraft;
  const projects = Object.values(s.control.projects);
  const providerRows = Object.keys(d.providerModes).map((p) => `<label class="setting-line"><span>${esc(PROVIDERS[p] || p)} quota</span><select data-provider="${p}"><option value="managed" ${d.providerModes[p] === 'managed' ? 'selected' : ''}>Manage pace</option><option value="ignore" ${d.providerModes[p] === 'ignore' ? 'selected' : ''}>Ignore quota</option></select></label>`).join('');
  const kindRows = Object.keys(models).map((kind) => {
    const enabled = d.allowedKinds.includes(kind);
    return `<div class="model-kind"><label><input type="checkbox" data-kind="${kind}" ${enabled ? 'checked' : ''}> ${esc(kind)}</label><details><summary>Models</summary><div class="model-list">${(models[kind].allowedModels || []).map((model) => `<label><input type="checkbox" data-global-model="${esc(model)}" ${!d.excludedModels.includes(model) ? 'checked' : ''}> ${esc(model)}</label>`).join('')}</div></details></div>`;
  }).join('');
  const projectRows = projects.map((p) => {
    const x = d.projects[p.slug] || { share: 0, mode: 'auto', excludedKinds: [], excludedModels: [] };
    const availableKinds = d.allowedKinds;
    const projectModels = [...new Set(availableKinds.flatMap((k) => models[k]?.allowedModels || []))].filter((m) => !d.excludedModels.includes(m));
    return `<div class="allocation-row" data-project-row="${esc(p.slug)}">
      <div class="allocation-name"><b>${esc(p.label)}</b><small>${p.running}/${p.slots} working slots · ${p.idle ? 'idle' : 'active'}</small></div>
      <input type="range" min="0" max="100" step="1" value="${x.share}" data-share="${esc(p.slug)}" aria-label="${esc(p.label)} allocation">
      <strong class="num share-value">${x.share}%</strong>
      <select data-mode="${esc(p.slug)}" aria-label="${esc(p.label)} activity mode">${['auto','active','idle','paused'].map((m) => `<option value="${m}" ${x.mode === m ? 'selected' : ''}>${m}</option>`).join('')}</select>
      <details class="project-exclude"><summary>Exclude kinds / models</summary><div class="exclude-grid">${availableKinds.map((k) => `<label><input type="checkbox" data-exclude-kind="${esc(p.slug)}:${k}" ${x.excludedKinds.includes(k) ? 'checked' : ''}> ${esc(k)}</label>`).join('')}
      ${projectModels.map((m) => `<label><input type="checkbox" data-exclude-model="${esc(p.slug)}:${esc(m)}" ${x.excludedModels.includes(m) ? 'checked' : ''}> ${esc(m)}</label>`).join('')}</div></details>
    </div>`;
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
        </div><div><h3>Subscriptions</h3>${providerRows}</div>
        <div><h3>Available harnesses &amp; models</h3><div class="model-kinds">${kindRows}</div></div>
      </div>
      <div class="allocations"><h3>Project shares <span class="sub">drag one slider; the rest rebalance</span></h3>${projectRows}</div>
      <div class="control-actions"><span>${esc(saveMessage || `${s.control.runningWorkers}/${d.maxWorkers} workers active · ${policyDirty ? 'unsaved changes' : 'saved'}`)}</span><button id="save-policy" ${policyDirty ? '' : 'disabled'}>Apply policy</button></div>
    </div></section>`;
}

function handoffBlock(s) {
  const candidates = s.control?.handoffs || [];
  const prepared = handoffRecords.filter((x) => x.status === 'prepared');
  const cards = [
    ...prepared.map((item) => {
      const output = handoffOutputs[item.id];
      return `<article class="handoff-item panel"><div class="handoff-head"><div><b>${esc(s.control?.projects?.[item.project]?.label || item.project)}</b><p>Successor prepared · ${esc(item.toKind)} / ${esc(item.model)}</p></div><span class="tag">Awaiting review</span></div>
        <p>The source orchestrator still controls this project. Inspect the successor's response before transferring the label.</p>
        <div class="action-row"><button type="button" data-handoff-output="${esc(item.id)}" ${handoffBusy.has(item.id) ? 'disabled' : ''}>Inspect successor</button><span class="inline-feedback" role="status">${esc(handoffMessages[item.id] || item.promptError || '')}</span></div>
        ${output != null ? `<pre class="handoff-output">${esc(output)}</pre><label class="review-check"><input type="checkbox" data-handoff-reviewed="${esc(item.id)}" ${handoffReviewed.has(item.id) ? 'checked' : ''}> I have reviewed the successor's response</label><button type="button" data-handoff-activate="${esc(item.id)}" ${!handoffReviewed.has(item.id) || handoffBusy.has(item.id) ? 'disabled' : ''}>Confirm activation</button>` : ''}
      </article>`;
    }),
    ...candidates.filter((h) => !prepared.some((x) => x.sourcePane === h.pane)).map((h) => {
      const eligible = Object.entries(s.control.globalAllowed || {}).filter(([kind]) => kind !== h.fromKind && !s.control.projects[h.project]?.excludedKinds.includes(kind)).map(([kind, names]) => [kind, names.filter((model) => !s.control.projects[h.project]?.excludedModels.includes(model) && !s.control.risks?.[model.startsWith('opencode-go/') ? 'opencodego' : kind])]).filter(([, names]) => names.length);
      const target = handoffTargets[h.pane] || (eligible.some(([kind]) => kind === h.target?.kind) ? h.target.kind : eligible[0]?.[0]) || '';
      const availableModels = eligible.find(([kind]) => kind === target)?.[1] || [];
      const model = availableModels.includes(handoffModels[h.pane]) ? handoffModels[h.pane] : availableModels.includes(h.target?.model) ? h.target.model : availableModels[0] || '';
      const mode = handoffModes[h.pane] || (['codex', 'claude'].includes(target) ? 'migrate' : 'fresh');
      const plan = handoffPlans[h.pane];
      return `<article class="handoff-item panel"><div class="handoff-head"><div><b>${esc(s.control.projects[h.project]?.label || h.project)}</b><p>${esc(h.fromKind)} is at ${h.window.usedPercent}% · ${esc(h.window.label)} quota</p></div><span class="tag">Handover needed</span></div>
        <p>Prepare another orchestrator before this provider becomes unavailable. The current pane remains in charge until activation.</p>
        <div class="handoff-controls"><label>Successor<select data-handoff-target="${esc(h.pane)}">${eligible.map(([kind]) => `<option value="${esc(kind)}" ${kind === target ? 'selected' : ''}>${esc(kind)}</option>`).join('')}</select></label><label>Model<select data-handoff-model="${esc(h.pane)}">${availableModels.map((name) => `<option value="${esc(name)}" ${name === model ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select></label><label>Start from<select data-handoff-mode="${esc(h.pane)}"><option value="migrate" ${mode === 'migrate' ? 'selected' : ''}>Migrated session</option><option value="fresh" ${mode === 'fresh' ? 'selected' : ''}>Fresh bootstrap</option></select></label></div>
        <div class="action-row"><button type="button" data-handoff-plan="${esc(h.pane)}" ${!eligible.length || handoffBusy.has(h.pane) ? 'disabled' : ''}>Plan handover</button>${plan && (mode === 'fresh' || plan.migration?.available) ? `<button type="button" data-handoff-prepare="${esc(h.pane)}" ${handoffBusy.has(h.pane) ? 'disabled' : ''}>Prepare successor</button>` : ''}<span class="inline-feedback" role="status">${esc(handoffMessages[h.pane] || '')}</span></div>
        ${plan ? `<div class="plan-result">${plan.mode === 'fresh' ? 'Fresh bootstrap: the successor will read project files and the source pane.' : plan.migration?.available ? `Migration available · ${plan.migration.records ?? '?'} records · ${plan.migration.warnings ?? 0} warnings.` : `Migration unavailable: ${esc(plan.migration?.error || 'unknown reason')}. Choose fresh bootstrap and plan again.`}</div>` : ''}
      </article>`;
    }),
  ];
  return `<section class="handoff-section"><div class="section-head"><h2>Project continuity</h2><span>${cards.length ? `${cards.length} need review` : 'No handovers pending'}</span></div>${cards.length ? `<div class="handoff-list">${cards.join('')}</div>` : '<p class="empty">No orchestrator handovers need action.</p>'}</section>`;
}

function projectResources(s) {
  const projects = Object.values(s.control?.projects || {});
  const sessions = browserSessions;
  return `<section><h2>Project browsers <span class="sub">one recorded profile and debugging port per project</span></h2><div class="grid cols-3">${projects.map((p) => {
    const b = sessions.find((x) => x.project === p.slug);
    return `<div class="panel resource-card"><b>${esc(p.label)}</b><div>Allocation <strong>${p.slots}</strong> · running <strong>${p.running}</strong>${p.idle ? ' · idle' : ''}</div>
      <div>Browser ${b ? `<span class="mono">:${b.port}</span> · ${b.profileVerified ? 'ready' : b.reachable ? 'port conflict' : 'offline'}` : 'none'}</div>
      <button data-browser-request="${esc(p.slug)}">${b?.profileVerified ? 'Show browser details' : 'Request browser'}</button>
      ${b ? `<small class="mono">http://127.0.0.1:${b.port} · ${esc(b.profile)}</small>` : ''}
    </div>`;
  }).join('')}</div></section>`;
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
  if (!m) return `<div class="panel"><div class="err">No machine data.</div></div>`;
  const hist = s.history || [];
  const br = s.browsers || [];
  const chrome = br.filter((b) => b.kind === 'automation-chrome');
  const mcp = br.filter((b) => b.kind.endsWith('-mcp'));
  const daemons = br.filter((b) => b.kind === 'agent-browser-daemon');
  return `<div class="panel">
    <div class="stats">
      <div class="stat"><div class="k">Load (1 / 5 / 15 min)</div><div class="v">${m.load[0]} <small>${m.load[1]} / ${m.load[2]} · ${m.cpus} cores</small></div>${spark(hist.map((x) => x.load), m.cpus)}</div>
      <div class="stat"><div class="k">Memory free</div><div class="v">${m.memFreePercent ?? '–'}<small>% of ${m.memTotalGB} GB</small></div>${spark(hist.map((x) => 100 - (x.mem ?? 0)), 100 - 15)}</div>
      <div class="stat"><div class="k">Swap used</div><div class="v">${m.swapUsedMB != null ? (m.swapUsedMB / 1024).toFixed(1) : '–'}<small> GB</small></div></div>
      <div class="stat"><div class="k">Automation browsers · MCP · daemons</div><div class="v">${chrome.length} <small>· ${mcp.length} · ${daemons.length}</small></div></div>
    </div>
  </div>`;
}

function agentRow(p, s) {
  const since = s.paneSince?.[p.id]?.since;
  const idleSec = since && (p.status === 'idle' || p.status === 'done') ? (Date.now() - since) / 1000 : null;
  const stale = idleSec != null && idleSec > 7200 && !p.orch;
  const browsers = (s.browsers || []).filter((b) => b.pane === p.id);
  const bTag = browsers.length ? ` <span class="tag" title="${esc(browsers.map((b) => `${b.kind} pid ${b.pid}`).join('\n'))}">${browsers.length} browser${browsers.length > 1 ? 's' : ''}</span>` : '';
  const who = p.name || p.agent || 'shell';
  const kind = p.name && p.agent ? p.agent : '';
  const status = p.agent ? p.status : 'shell';
  const meta = p.agent ? `${status}${since ? ` ${dur((Date.now() - since) / 1000)}` : ''}` : 'shell';
  return `<li class="agent ${p.orch ? 'orch' : ''}" title="${esc(p.cwd)}">
    <span class="st ${status}"></span>
    <div class="who">${p.orch ? '<span class="pill">orch</span>' : ''}<b>${esc(who)}</b>${kind ? `<span class="pill ghost">${esc(kind)}</span>` : ''}<span>${esc(p.title)}</span>${bTag}</div>
    <span class="meta ${stale ? 'stale' : ''}">${esc(p.id.split(':')[1])} · ${esc(meta)}</span>
  </li>`;
}

function workspacesBlock(s) {
  const h = s.herdr;
  if (!h) return '';
  const cards = h.workspaces.map((w) => {
    const panes = h.panes.filter((p) => p.workspace === w.id && (p.agent || p.orch));
    panes.sort((a, b) => (b.orch - a.orch) || String(a.tab).localeCompare(String(b.tab)));
    const hasOrch = panes.some((p) => p.orch);
    const working = panes.filter((p) => p.status === 'working').length;
    return `<div class="panel">
      <div class="ws-head"><b>${esc(w.label)}</b><span class="tag">${esc(w.id)} · ${panes.length} agent${panes.length === 1 ? '' : 's'}${working ? ` · ${working} working` : ''}</span></div>
      <ul class="agents">${panes.map((p) => agentRow(p, s)).join('') || '<li class="empty">No agents.</li>'}</ul>
      ${hasOrch ? '' : `<div class="noorch">No orchestrator. Label one with <code>herdr pane rename &lt;pane&gt; orch</code>.</div>`}
    </div>`;
  }).join('');
  return `<section><h2>Workspaces <span class="sub">live from Herdr</span></h2><div class="ws-grid">${cards}</div></section>`;
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

function projectsBlock(s) {
  const list = s.projects || [];
  const body = list.length
    ? `<div class="grid cols-3">${list.map((p) => `<a class="panel proj" href="/p/${esc(p.slug)}">
        <div class="proj-head"><b>${esc(p.project)}</b><span class="tag">${esc(p.phase || p.status || '')}</span></div>
        ${p.summary ? `<p>${esc(p.summary)}</p>` : ''}
        ${segBar(taskCounts(p))}
        ${p.errors ? `<div class="warnbox">${esc(p.errors.join('; '))}</div>` : ''}
        <div class="win-foot">updated ${ago(p.updated)}</div>
      </a>`).join('')}</div>`
    : `<div class="panel empty">No project status files yet. Orchestrators publish them to <code>~/.herdr-boss/projects/&lt;slug&gt;.json</code>. See <a href="/docs/project-status.md">the schema</a>.</div>`;
  return `<section><h2>Projects <span class="sub">published by orchestrators</span></h2>${body}</section>`;
}

function browsersBlock(s) {
  const br = (s.browsers || []).filter((b) => b.kind !== 'agent-browser-daemon' || b.age > 3600);
  if (!br.length) return '';
  const pane = (id) => s.herdr?.panes.find((p) => p.id === id);
  return `<div class="panel"><table class="browsers"><thead><tr><th>Kind</th><th>PID</th><th>Owner</th><th>Age</th><th>MB</th></tr></thead><tbody>
    ${br.map((b) => { const p = pane(b.pane); return `<tr><td>${esc(b.kind)}${b.headless ? ' (headless)' : ''}${b.port ? ` :${b.port}` : ''}</td><td class="mono">${b.pid}</td><td>${p ? esc(p.name || p.id) : b.shared ? `<span title="${esc(b.shared)}">shared</span>` : b.orphan ? '<span class="stale">orphan</span>' : '–'}</td><td class="mono">${dur(b.age)}</td><td class="mono">${b.rssMB}</td></tr>`; }).join('')}
  </tbody></table></div>`;
}

function eventsBlock(s) {
  const ev = (s.events || []).slice().reverse();
  return `<div class="panel">${ev.length ? `<ul class="events">${ev.map((e) => `<li><span class="t">${new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</span><span class="ty ${esc(e.type)}">${esc(e.type)}</span><span>${esc(e.text)}</span></li>`).join('')}</ul>` : '<div class="empty">No activity yet.</div>'}</div>`;
}

function quotaSummary(s) {
  return `<section class="quota-summary"><div class="section-head"><h2>Subscriptions</h2><a href="/analytics#quotas">All quota windows →</a></div><div class="quota-summary-grid">${(s.quotas || []).map((q) => {
    const w = q.windows?.find((x) => x.key === 'secondary') || q.windows?.find((x) => !x.extra);
    return `<div class="quota-summary-item"><span>${esc(PROVIDERS[q.provider] || q.provider)}</span><strong class="${w?.usedPercent >= 90 ? 'text-crit' : ''}">${w ? `${w.usedPercent}%` : '–'}</strong><small>${q.error ? esc(q.error) : w ? `${esc(w.label)} · resets ${clock(w.resetsAt)}` : 'No quota data'}</small></div>`;
  }).join('')}</div></section>`;
}

function attentionBlock(s) {
  const alerts = (s.alerts || []).filter((a) => ['warn', 'critical'].includes(a.severity) && !a.key?.startsWith('handoff:'));
  if (s.errors?.length) alerts.unshift({ key: 'collection', severity: 'warn', title: 'Some status data is unavailable', text: s.errors.join(' · ') });
  return `<section class="attention-section"><div class="section-head"><h2>Needs attention</h2><span>${alerts.length ? `${alerts.length} alerts` : 'Clear'}</span></div>${alerts.length ? `<div class="attention-list">${alerts.map((a) => `<article class="attention-item ${esc(a.severity)}"><span class="severity-dot" aria-hidden="true"></span><div><b>${esc(a.title || a.severity)}</b><p>${esc(a.text)}</p></div><a href="${a.key?.startsWith('quota:') ? '/allocation' : '/analytics#guidance'}">${a.key?.startsWith('quota:') ? 'Adjust policy' : 'Details'}</a></article>`).join('')}</div>` : '<div class="calm-state">No resource alerts need action. Project orchestrators can continue within the current policy.</div>'}</section>`;
}

function fleetBlock(s) {
  const projects = Object.values(s.control?.projects || {});
  return `<section class="fleet-section"><div class="section-head"><h2>Projects</h2><a href="/analytics#agents">Live agents →</a></div><div class="fleet-table-wrap"><table class="fleet-table"><thead><tr><th>Project</th><th>Orchestrator</th><th>Workers</th><th>Policy</th><th>Published status</th></tr></thead><tbody>${projects.map((p) => {
    const published = (s.projects || []).find((x) => x.slug === p.slug);
    const detail = published ? `/p/${p.slug}` : '/analytics#agents';
    return `<tr><td><a href="${esc(detail)}"><strong>${esc(p.label)}</strong></a><small>${esc(p.workspace)}</small></td><td>${p.orch ? `<span class="status-inline"><span class="st ${esc(p.orch.status)}"></span>${esc(p.orch.kind)} · ${esc(p.orch.status)}</span>` : '<span class="text-crit">Missing</span>'}</td><td class="mono">${p.running} / ${p.slots}</td><td>${esc(p.effectiveMode === 'paused' ? 'Paused' : p.idle ? 'Idle · lending' : `${Math.round(p.share)}% share`)}</td><td>${published ? `${esc(published.status || published.phase || 'Published')}<small>updated ${ago(published.updated)}</small>` : '<span class="muted">Not published</span>'}</td></tr>`;
  }).join('')}</tbody></table></div></section>`;
}

function overview(s) {
  const handovers = (s.control?.handoffs || []).length + handoffRecords.filter((x) => x.status === 'prepared' && !(s.control?.handoffs || []).some((h) => h.pane === x.sourcePane)).length;
  const alertCount = (s.alerts || []).filter((a) => ['warn', 'critical'].includes(a.severity) && !a.key?.startsWith('handoff:')).length;
  return [
    `<header class="page-intro"><div><h1>Overview</h1><p>${alertCount || handovers ? `${alertCount} resource alert${alertCount === 1 ? '' : 's'} · ${handovers} handover${handovers === 1 ? '' : 's'} to review` : 'Projects are operating within the current resource policy.'}</p></div><div class="capacity-readout"><strong>${s.control?.runningWorkers ?? 0}<span> / ${s.control?.maxWorkers ?? '–'}</span></strong><small>working agents</small><a href="/allocation">Adjust allocation →</a></div></header>`,
    `<div class="overview-action-grid">${attentionBlock(s)}${handoffBlock(s)}</div>`,
    fleetBlock(s),
    quotaSummary(s),
  ].join('');
}

function allocationView(s) {
  return [
    '<header class="page-intro"><div><h1>Resource allocation</h1><p>Set capacity, subscription availability, and the share each project can use.</p></div></header>',
    controlBlock(s),
    projectResources(s),
  ].join('');
}

function analyticsView(s) {
  return [
    '<header class="page-intro"><div><h1>Analytics</h1><p>Quota pace, measured usage, machine health, agents, and the event trail.</p></div></header>',
    '<nav class="section-nav" aria-label="Analytics sections"><a href="#quotas">Quotas</a><a href="#usage">Usage</a><a href="#machine">Machine</a><a href="#agents">Agents</a><a href="#events">Activity</a></nav>',
    `<section id="quotas"><div class="section-head"><h2>Quota windows</h2><span>CodexBar · updated ${ago(s.quotasAt)}</span></div><div class="grid cols-3">${(s.quotas || []).map(quotaCard).join('')}</div></section>`,
    usageBlock(),
    `<section id="machine"><h2>Machine health</h2><div class="two"><div>${machineCard(s)}</div><div><h3>Browsers &amp; MCP</h3>${browsersBlock(s) || '<div class="panel empty">None running.</div>'}</div></div></section>`,
    `<div id="agents">${workspacesBlock(s)}</div>`,
    projectsBlock(s),
    rulesBlock(s),
    `<section id="events"><h2>Activity log</h2>${eventsBlock(s)}</section>`,
  ].join('');
}

function usageBlock() {
  const rows = Object.entries(usage?.byProject || {});
  return `<section id="usage"><div class="section-head"><h2>Recorded project usage</h2><span>Measured runs are a subset of recorded runs</span></div>${rows.length ? `<div class="fleet-table-wrap"><table class="fleet-table"><thead><tr><th>Project</th><th>Runs</th><th>Measured</th><th>Input</th><th>Output</th><th>Work time</th></tr></thead><tbody>${rows.map(([slug, x]) => `<tr><td><strong>${esc(slug)}</strong></td><td class="mono">${x.runs}</td><td class="mono">${x.measuredRuns} / ${x.runs}</td><td class="mono">${x.inputTokens.toLocaleString()}</td><td class="mono">${x.outputTokens.toLocaleString()}</td><td class="mono">${Math.round(x.workMinutes)} min</td></tr>`).join('')}</tbody></table></div>` : '<div class="calm-state">No worker runs have been recorded yet. Orchestrators add them with <code>herdr-boss worker collect --record</code>.</div>'}</section>`;
}

// ---------- Project page ----------

function project(s, slug) {
  const p = (s.projects || []).find((x) => x.slug === slug);
  $crumbs.innerHTML = `/ <a href="/">overview</a> / ${esc(p?.project || slug)}`;
  if (!p) return `<div class="panel empty">No project "${esc(slug)}". It appears when <code>~/.herdr-boss/projects/${esc(slug)}.json</code> exists.</div>`;
  const panes = s.herdr?.panes || [];
  const byName = new Map(panes.filter((x) => x.name).map((x) => [x.name, x]));
  const phases = p.phases?.length ? `<ol class="phases">${p.phases.map((ph) => {
    const idx = p.phases.indexOf(p.phase);
    const i = p.phases.indexOf(ph);
    return `<li class="${ph === p.phase ? 'current' : idx >= 0 && i < idx ? 'done' : ''}">${esc(ph)}</li>`;
  }).join('')}</ol>` : p.phase ? `<div><span class="tag">${esc(p.phase)}</span></div>` : '';
  const metrics = p.metrics?.length ? `<section class="metrics">${p.metrics.map((m) => `<div class="panel metric"><div class="k">${esc(m.label)}</div><div class="v">${esc(m.value)}</div>${m.detail ? `<div class="d">${esc(m.detail)}</div>` : ''}</div>`).join('')}</section>` : '';
  const c = taskCounts(p);
  const colors = { todo: 'faint', doing: 'info', review: 'accent', blocked: 'crit', done: 'ok' };
  const board = (p.tasks || []).length ? `<section><h2>Tasks <span class="sub">${(p.tasks || []).length} total · worker status is live from Herdr</span></h2><div class="board">${STATUSES.map((k) => `<div class="col" style="--c:var(--${colors[k]})"><h3><span>${STATUS_LABEL[k]}</span><span class="num">${c[k]}</span></h3>
      ${(p.tasks || []).filter((t) => (t.status || 'todo') === k).map((t) => {
        const w = t.worker && byName.get(t.worker);
        return `<div class="task">${t.id ? `<span class="id">${esc(t.id)}</span>` : ''}<span class="title">${esc(t.title)}</span>${t.note ? `<span class="note">${esc(t.note)}</span>` : ''}${t.worker ? `<span class="w"><span class="st ${w ? w.status : 'shell'}"></span>${esc(t.worker)}${w ? ` · ${esc(w.status)}` : ' · not running'}</span>` : ''}</div>`;
      }).join('')}</div>`).join('')}</div></section>` : '';
  const links = p.links?.length ? `<div class="panel"><h2>Links</h2><ul class="links">${p.links.map((l) => `<li><a href="${esc(l.url)}" target="_blank" rel="noreferrer">${esc(l.label || l.url)}</a></li>`).join('')}</ul></div>` : '';
  const notes = p.notes?.length ? `<div class="panel"><h2>Notes</h2><ul class="notes">${p.notes.map((n) => `<li>${code(n)}</li>`).join('')}</ul></div>` : '';
  const ws = p.workspace && s.herdr?.workspaces.find((w) => w.id === p.workspace || w.label === p.workspace);
  const wsBlock = ws ? workspacesBlock({ ...s, herdr: { ...s.herdr, workspaces: [ws] } }) : '';
  return [
    `<section class="phead"><h1>${esc(p.project)}</h1>${p.summary ? `<p>${esc(p.summary)}</p>` : ''}${phases}<div class="win-foot">updated ${ago(p.updated)}${p.status ? ` · ${esc(p.status)}` : ''}</div></section>`,
    p.errors ? `<div class="warnbox">${esc(p.errors.join('; '))}</div>` : '',
    metrics,
    board,
    links || notes ? `<section class="two">${notes}${links}</section>` : '',
    wsBlock,
  ].join('');
}

// ---------- Render loop ----------

function render() {
  if (!state) return;
  if (!policyDirty) policyDraft = null;
  if (policyDirty && location.pathname === '/allocation' && document.activeElement?.closest?.('#control-plane')) {
    $updated.textContent = `updated ${ago(state.updatedAt)}`;
    return;
  }
  const m = /^\/p\/([^/]+)/.exec(location.pathname);
  const route = m ? 'project' : location.pathname === '/allocation' ? 'allocation' : location.pathname === '/analytics' ? 'analytics' : 'overview';
  const html = route === 'project' ? project(state, decodeURIComponent(m[1])) : route === 'allocation' ? allocationView(state) : route === 'analytics' ? analyticsView(state) : overview(state);
  if (route !== 'project') $crumbs.innerHTML = '';
  for (const a of $nav.querySelectorAll('a')) {
    if (a.dataset.nav === (route === 'project' ? 'overview' : route)) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  if (html !== lastRender) { $app.innerHTML = html; lastRender = html; }
  $updated.textContent = `updated ${ago(state.updatedAt)}`;
  $push.textContent = state.push ? 'prompts on' : 'prompts off';
}

function updateShares() {
  for (const [slug, p] of Object.entries(policyDraft.projects)) {
    const row = [...document.querySelectorAll('[data-project-row]')].find((x) => x.dataset.projectRow === slug);
    if (!row) continue;
    row.querySelector('[data-share]').value = p.share;
    row.querySelector('.share-value').textContent = `${p.share}%`;
  }
}

document.addEventListener('input', (e) => {
  if (!e.target.closest('#control-plane') || !policyDraft) return;
  const el = e.target;
  if (el.dataset.share) { rebalance(el.dataset.share, el.value); updateShares(); }
  if (el.dataset.policyNumber) policyDraft[el.dataset.policyNumber] = Number(el.value);
  policyDirty = true;
  saveMessage = '';
  document.getElementById('save-policy').disabled = false;
});

document.addEventListener('change', (e) => {
  if (e.target.dataset.handoffTarget || e.target.dataset.handoffMode || e.target.dataset.handoffModel) {
    const pane = e.target.dataset.handoffTarget || e.target.dataset.handoffMode || e.target.dataset.handoffModel;
    if (e.target.dataset.handoffTarget) { handoffTargets[pane] = e.target.value; delete handoffModels[pane]; }
    else if (e.target.dataset.handoffModel) handoffModels[pane] = e.target.value;
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
  if (!e.target.closest('#control-plane') || !policyDraft) return;
  const el = e.target;
  const d = policyDraft;
  if (el.dataset.policyBool) d[el.dataset.policyBool] = el.checked;
  if (el.dataset.provider) d.providerModes[el.dataset.provider] = el.value;
  if (el.dataset.mode) d.projects[el.dataset.mode].mode = el.value;
  if (el.dataset.kind) {
    d.allowedKinds = el.checked ? [...new Set([...d.allowedKinds, el.dataset.kind])] : d.allowedKinds.filter((x) => x !== el.dataset.kind);
    if (!el.checked) for (const p of Object.values(d.projects)) p.excludedKinds = p.excludedKinds.filter((x) => x !== el.dataset.kind);
  }
  if (el.dataset.globalModel) {
    const m = el.dataset.globalModel;
    d.excludedModels = el.checked ? d.excludedModels.filter((x) => x !== m) : [...new Set([...d.excludedModels, m])];
    if (!el.checked) for (const p of Object.values(d.projects)) p.excludedModels = p.excludedModels.filter((x) => x !== m);
  }
  for (const [key, attr] of [['excludeKind', 'excludedKinds'], ['excludeModel', 'excludedModels']]) if (el.dataset[key]) {
    const [slug, value] = el.dataset[key].split(':');
    d.projects[slug][attr] = el.checked ? [...new Set([...d.projects[slug][attr], value])] : d.projects[slug][attr].filter((x) => x !== value);
  }
  policyDirty = true;
  document.getElementById('save-policy').disabled = false;
});

async function postJson(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || (result.errors || []).join(' ') || 'The request failed.');
  return result;
}

async function runHandoffAction(action, key) {
  if (handoffBusy.has(key)) return;
  const h = state.control?.handoffs?.find((x) => x.pane === key);
  const item = handoffRecords.find((x) => x.id === key);
  const selectedTarget = [...document.querySelectorAll('[data-handoff-target]')].find((x) => x.dataset.handoffTarget === key)?.value;
  const selectedModel = [...document.querySelectorAll('[data-handoff-model]')].find((x) => x.dataset.handoffModel === key)?.value;
  const selectedMode = [...document.querySelectorAll('[data-handoff-mode]')].find((x) => x.dataset.handoffMode === key)?.value;
  if (action === 'activate' && !confirm(`Activate the prepared ${item?.toKind || ''} orchestrator for ${item?.project || key}? The current pane will become standby.`)) return;
  handoffBusy.add(key);
  handoffMessages[key] = action === 'plan' ? 'Checking session migration…' : action === 'prepare' ? 'Starting successor…' : action === 'output' ? 'Reading successor…' : 'Activating…';
  lastRender = ''; render();
  try {
    if (action === 'plan' || action === 'prepare') {
      if (!h) throw new Error('This handover is no longer current. Refresh the dashboard.');
      const body = { project: h.project, pane: h.pane, to: selectedTarget, model: selectedModel, mode: selectedMode };
      if (action === 'plan') {
        const plan = await postJson('/api/handoffs/plan', body);
        handoffPlans[key] = plan;
        handoffMessages[key] = plan.migration && !plan.migration.available ? 'Migration unavailable; choose Fresh bootstrap.' : 'Plan ready for review.';
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

document.addEventListener('click', async (e) => {
  for (const [action, attr] of [['plan', 'handoffPlan'], ['prepare', 'handoffPrepare'], ['output', 'handoffOutput'], ['activate', 'handoffActivate']]) {
    if (e.target.dataset[attr]) { await runHandoffAction(action, e.target.dataset[attr]); return; }
  }
  if (e.target.id === 'save-policy' && policyDraft) {
    e.target.disabled = true;
    try {
      const response = await fetch('/api/policy', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(policyDraft) });
      const result = await response.json();
      if (!response.ok) throw new Error((result.errors || [result.error]).join(' '));
      policyDraft = result.policy;
      policyDirty = false;
      saveMessage = 'Policy saved';
      state.policy = result.policy;
      state.control = result.control;
      lastRender = '';
      render();
    } catch (error) { saveMessage = error.message; e.target.disabled = false; e.target.previousElementSibling.textContent = saveMessage; }
  }
  if (e.target.dataset.browserRequest) {
    const slug = e.target.dataset.browserRequest;
    e.target.disabled = true;
    try {
      const response = await fetch('/api/browser-sessions/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: slug }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Browser request failed.');
      await refreshExtras();
      alert(`Browser for ${slug}: port ${result.port}\nProfile: ${result.profile}\n${result.profileVerified ? 'Ready' : 'Starting or needs inspection'}`);
    } catch (error) { alert(error.message); } finally { e.target.disabled = false; }
  }
});

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="/"]');
  if (!a || a.target || e.metaKey || e.ctrlKey || /\.md$/.test(a.getAttribute('href'))) return;
  e.preventDefault();
  history.pushState(null, '', a.getAttribute('href'));
  lastRender = '';
  render();
  if (location.hash) requestAnimationFrame(() => document.getElementById(location.hash.slice(1))?.scrollIntoView());
  else scrollTo(0, 0);
});
addEventListener('popstate', () => { lastRender = ''; render(); if (location.hash) requestAnimationFrame(() => document.getElementById(location.hash.slice(1))?.scrollIntoView()); });

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => { state = JSON.parse(e.data); render(); });
  es.onopen = () => $dot.classList.add('on');
  es.onerror = () => { $dot.classList.remove('on'); $updated.textContent = 'reconnecting…'; };
}
async function refreshExtras() {
  const results = await Promise.allSettled(['/api/models', '/api/usage', '/api/browser-sessions', '/api/handoffs'].map((url) => fetch(url).then((r) => r.json())));
  if (results[0].status === 'fulfilled') models = results[0].value;
  if (results[1].status === 'fulfilled') usage = results[1].value;
  if (results[2].status === 'fulfilled') browserSessions = results[2].value;
  if (results[3].status === 'fulfilled') handoffRecords = results[3].value;
  lastRender = '';
  render();
}
connect();
refreshExtras();
setInterval(refreshExtras, 30000);
setInterval(render, 10000);
