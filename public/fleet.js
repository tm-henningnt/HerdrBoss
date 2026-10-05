// The read-only fleet view v2. The rollup (src/fleet-rollup.js) holds every shared fact.
// The page renders the totals, the collapsed alert strip, the compact comparison, and the factory cards.
// T6 wires the exported hooks and the data-action / data-copy attributes.

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const num = (value) => typeof value === 'number' && Number.isFinite(value);
const UNKNOWN = 'unknown';
const unknown = (reason) => `<span class="fleet-unknown">${UNKNOWN}</span>${reason ? `<span class="fleet-secondary">${esc(reason)}</span>` : ''}`;
const money = (value) => `$${value.toFixed(2)}`;
const base = (value) => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.origin : ''; } catch { return ''; } };
const reasons = { unreachable: 'Host unreachable', timeout: 'Request timed out', auth: 'Read credential refused', 'contract-mismatch': 'Contract mismatch' };

// A short age in the page style: seconds, minutes, or hours.
function ageText(value) {
  if (!num(value) || value < 0) return null;
  if (value < 60) return `${value} s`;
  if (value < 3600) return `${Math.round(value / 60)} min`;
  return `${Math.round(value / 3600)} h`;
}
// A signed clock offset keeps its sign. Null is unknown.
function secondsText(value) {
  if (!num(value)) return null;
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${Math.abs(value)} s`;
}
const shortKey = (value) => typeof value === 'string' && value.length > 10 ? `${value.slice(0, 4)}…${value.slice(-4)}` : null;

// A value line: "unknown" with its reason, or the escaped value.
function valueHtml(info) {
  const reason = info?.reason ? `<span class="fleet-secondary">${esc(info.reason)}</span>` : '';
  const drift = info?.drift ? ` <span class="drift">${esc(info.drift)}</span>` : '';
  const date = info?.date ? `<span class="fleet-secondary">${esc(info.date)}</span>` : '';
  const text = !info || info.text === UNKNOWN ? `${UNKNOWN}` : esc(info.text);
  return `${text === UNKNOWN ? unknown() : text}${drift}${date}${reason}`;
}

// ---- Factory facts -------------------------------------------------------------------------

function healthClass(row) {
  if (row.status === 'offline' || row.error) return 'offline';
  if (row.health === 'healthy') return 'healthy';
  if (row.health === 'degraded') return 'degraded';
  return 'unknown';
}
function healthInfo(row) {
  const status = typeof row.health === 'string' && row.health ? row.health : UNKNOWN;
  if (row.error && reasons[row.error]) return { text: status, reason: reasons[row.error] };
  if (row.error) return { text: status, reason: row.error };
  return { text: status };
}
function kindText(row) {
  const kind = row.kind ?? row.summary?.kind;
  return kind === 'native' || kind === 'container' ? kind : null;
}
function lastSeenInfo(row) {
  if (!row.lastSeenAt) return { text: 'never seen' };
  const age = ageText(row.ageSeconds);
  if (!age) return { text: UNKNOWN, reason: 'summary age unknown' };
  const suffix = row.freshness === 'cached' ? ' · last good' : row.freshness === 'fresh' ? '' : ' · unknown age';
  return { text: `${age}${suffix}`, iso: row.lastSeenAt };
}
function workersInfo(row) {
  const running = row.workers ?? row.summary?.workers?.running;
  const max = row.summary?.workers?.max;
  if (!row.summary && running === null) return { text: UNKNOWN, reason: 'never seen' };
  if (!num(running)) return { text: UNKNOWN, reason: 'workers unknown' };
  const reading = num(max) ? `${running} / ${max}` : `${running}`;
  return { text: row.freshness === 'cached' ? `last good ${reading}` : reading };
}
function quotaInfo(row) {
  const quota = row.quota;
  if (!quota) return { text: UNKNOWN, reason: 'quota unknown' };
  const reading = `${quota.usedPercent}% ${quota.harness ?? 'unknown harness'}`;
  return { text: row.freshness === 'cached' ? `last good ${reading}` : reading };
}
function spendInfo(row) {
  const spend = row.spend;
  if (!spend || !num(spend.value)) return { text: UNKNOWN, reason: spend?.reason || 'no spend reading' };
  const reading = money(spend.value);
  return { text: row.freshness === 'cached' ? `last good ${reading}` : reading, date: spend.label || spend.day || null };
}
function ownerInfo(row) {
  if (!num(row.ownerItems)) return { text: UNKNOWN, reason: row.summary ? 'owner count unknown' : 'never seen' };
  return { text: row.freshness === 'cached' ? `last good ${row.ownerItems}` : String(row.ownerItems) };
}
function driftText(row, reference) {
  const parts = [];
  if (typeof row.drift === 'string' && row.drift.trim()) parts.push(row.drift.trim());
  if (reference && row.summary) {
    if (row.summary.version && reference.version && row.summary.version !== reference.version) parts.push('version differs');
    if (row.summary.kitRevision && reference.kitRevision && row.summary.kitRevision !== reference.kitRevision) parts.push('kit differs');
  }
  return [...new Set(parts)].join(' · ');
}
function versionInfo(row, reference) {
  const summary = row.summary;
  if (!summary) return { text: UNKNOWN, reason: 'never seen' };
  const version = typeof summary.version === 'string' && summary.version ? summary.version : UNKNOWN;
  const kit = typeof summary.kitRevision === 'string' && summary.kitRevision ? summary.kitRevision : UNKNOWN;
  if (version === UNKNOWN && kit === UNKNOWN) return { text: UNKNOWN, reason: 'no version reading' };
  const reading = `${version} / ${kit}`;
  return { text: row.freshness === 'cached' ? `last good ${reading}` : reading, drift: driftText(row, reference) };
}
// The cached-facts health: the summary health status with the summary age (design section 2).
function summaryHealthInfo(row) {
  if (!row.summary) return { text: UNKNOWN, reason: 'never seen' };
  const status = typeof row.summaryHealth === 'string' && row.summaryHealth ? row.summaryHealth : (row.summary.health?.status ?? UNKNOWN);
  const age = ageText(row.ageSeconds);
  if (!age) return { text: status, reason: 'summary age unknown' };
  return { text: `${status} · ${age} old` };
}

// ---- Totals --------------------------------------------------------------------------------

// The rollup coverage string is one long line. The card shows one short line and keeps the full
// text in a collapsed element, so the names of the non-fresh factories stay visible in text.
function coverageCounts(total) {
  const match = /(\d+)\s+of\s+(\d+)/.exec(typeof total?.coverage === 'string' ? total.coverage : '');
  return match ? `${match[1]} of ${match[2]}` : 'coverage unknown';
}
function coverageNames(total) {
  const segment = /unavailable:\s*([^;]*)/.exec(typeof total?.coverage === 'string' ? total.coverage : '');
  if (!segment) return [];
  const names = [];
  const entry = /([^()]+?)\s*\([^()]*\)/g;
  let match;
  while ((match = entry.exec(segment[1]))) names.push(match[1].trim());
  return names;
}
function coverageLine(key, label, total) {
  const asOf = num(total?.asOf) ? ageText(total.asOf) : UNKNOWN;
  const parts = [`as of ${esc(asOf)}`, esc(coverageCounts(total))];
  // Keep the line short so every comparison row stays in the first phone viewport.
  const names = coverageNames(total);
  if (names.length) parts.push(`${esc(names.join(', '))} unavailable`);
  return `<p class="fleet-s" data-fleet-coverage="${esc(key)}"><span class="fleet-k">${esc(label)}</span> ${parts.join(' · ')}</p>`;
}
// One collapsed element holds the long coverage text for all three totals, so the short lines stay
// small and the reasons and the selected spend days stay reachable.
function coverageDetail(entries) {
  const rows = entries
    .filter(([, , total]) => typeof total?.coverage === 'string' && total.coverage)
    .map(([key, label, total]) => `<p data-fleet-coverage-detail="${esc(key)}"><span class="fleet-k">${esc(label)}</span> ${esc(total.coverage)}</p>`);
  if (!rows.length) return '';
  return `<details class="fleet-coverage-detail" data-fleet-coverage-details data-key="fleet-coverage-details" data-keep-attrs="open"><summary>Coverage detail</summary>${rows.join('')}</details>`;
}
function totalCard(key, label, info) {
  return `<article class="fleet-total" data-fleet-total="${esc(key)}"><span class="fleet-k">${esc(label)}</span><span class="fleet-v">${valueHtml(info)}</span></article>`;
}
export function fleetTotals(totals) {
  const workers = totals?.workers || {};
  const spend = totals?.spend || {};
  const quota = totals?.quota || {};
  const mixedDays = typeof spend.coverage === 'string' && spend.coverage.includes('latest factory day');
  const spendLabel = mixedDays ? 'Spend · latest factory days' : 'Spend today';
  const entries = [['workers', 'Workers', workers], ['spend', spendLabel, spend], ['quota', 'Quota burn', quota]];
  return `<section class="fleet-totals" data-fleet-totals aria-label="Fleet totals"><div class="fleet-total-row">${
    totalCard('workers', 'Workers', num(workers.value) ? { text: String(workers.value) } : { text: UNKNOWN })
  }${
    totalCard('spend', spendLabel, num(spend.value) ? { text: money(spend.value) } : { text: UNKNOWN })
  }${
    totalCard('quota', 'Quota burn', num(quota.value) ? { text: `${quota.value}%` } : { text: UNKNOWN })
  }</div><div class="fleet-coverage">${
    entries.map(([key, label, total]) => coverageLine(key, label, total)).join('')
  }</div>${coverageDetail(entries)}</section>`;
}

// ---- Alerts --------------------------------------------------------------------------------

const FIX_WORDS = {
  unreachable: 'check the host',
  'read-credential-refused': 'check the read credential',
  'contract-mismatch': 'update the service',
  'kit-drift': 'update the service',
  'login-expired': 'sign in',
  'disk-low': 'free disk space',
  'clock-offset': 'check the clock',
  'status-stale': 'check the project',
};
function alertWords(alert) {
  if (alert.code === 'kit-drift' && alert.drift === 'head office older') return 'update the head office';
  return FIX_WORDS[alert.code] || 'check the factory';
}
// A short label for the collapsed phone strip. The full rollup label stays in the title attribute.
function alertLabel(alert) {
  const name = alert.factory ?? 'the factory';
  switch (alert.code) {
    case 'unreachable': return `${name} is not reachable — check the host`;
    case 'read-credential-refused': return `${name} refused the read credential — check the credential`;
    case 'contract-mismatch': return `${name} has a contract mismatch — update the service`;
    case 'kit-drift': return alert.drift === 'head office older' ? `${name} kit drift — update the head office` : `${name} kit drift — update the service`;
    case 'login-expired': return `${name} ${alert.harness ?? 'harness'} login expired — sign in`;
    case 'disk-low': return `${name} disk low — free disk space`;
    case 'clock-offset': return `${name} clock offset ${alert.offsetSeconds} s — check the clock`;
    case 'status-stale': return `${name} status stale${alert.projectSlug ? ` for ${alert.projectSlug}` : ''} — check the project`;
    default: return `${alert.label ?? name} — ${alertWords(alert)}`;
  }
}
function alertIdSafe(id, index) {
  const safe = String(id ?? index).replace(/[^a-zA-Z0-9_-]/g, '-');
  return `fleet-alert-fix-${safe || index}`;
}
export function fleetAlerts(alerts) {
  const list = Array.isArray(alerts) ? alerts : [];
  if (!list.length) return '';
  const order = { error: 0, warning: 1, info: 2 };
  const sorted = [...list].sort((left, right) => (order[left.severity] ?? 3) - (order[right.severity] ?? 3) || String(left.id).localeCompare(String(right.id)));
  const items = sorted.map((alert, index) => {
    const fix = String(alert.fix ?? '');
    const label = alertLabel(alert);
    const severity = ['error', 'warning', 'info'].includes(alert.severity) ? alert.severity : 'warning';
    const id = alertIdSafe(alert.id, index);
    return `<div class="alert" data-fleet-alert data-fleet-alert-code="${esc(alert.code ?? UNKNOWN)}" data-fleet-alert-severity="${esc(severity)}" data-key="fleet-alert:${esc(alert.id ?? index)}" data-keep-attrs="class">`
      + `<button class="alert-toggle" type="button" data-fleet-alert-toggle aria-expanded="false" data-keep-attrs="aria-expanded" aria-controls="${esc(id)}" title="${esc(alert.label ?? '')}">`
      + `<span class="sev ${esc(severity)}" aria-hidden="true"></span><span class="alert-label grow">${esc(label)}</span><span class="tag">Fix</span></button>`
      + `<div class="alert-fix" id="${esc(id)}" data-fleet-alert-fix><code class="cmd">${esc(fix)}</code>`
      + `<button class="copy" type="button" data-fleet-alert-fix-copy data-copy="${esc(fix)}">Copy</button></div></div>`;
  });
  return `<section class="fleet-alerts" data-fleet-alerts aria-label="Alerts">${items.join('')}</section>`;
}

// ---- Comparison ----------------------------------------------------------------------------

export function fleetComparison(factories, reference = null) {
  const rows = (factories || []).map((row) => {
    const kind = kindText(row) ?? UNKNOWN;
    const health = healthInfo(row);
    const lastSeen = lastSeenInfo(row);
    const workers = workersInfo(row);
    const quota = quotaInfo(row);
    const spend = spendInfo(row);
    const owner = ownerInfo(row);
    const version = versionInfo(row, reference);
    const sum = [kind, lastSeen.text, `${workers.text} workers`, quota.text, `spend ${spend.text}`, `${owner.text} owner`, version.text].join(' · ');
    const drift = version.drift ? ` <span class="drift">drift</span>` : '';
    const name = String(row.name ?? UNKNOWN);
    return `<div class="cmp-row" data-fleet-compare-row data-fleet-factory="${esc(name)}" data-key="fleet-row:${esc(name)}">`
      + `<span class="cmp-cell cmp-name"><span class="cmp-k">Factory</span>${esc(name)}</span>`
      + `<span class="cmp-cell cmp-kind hide-phone"><span class="cmp-k">Kind</span>${esc(kind)}</span>`
      + `<span class="cmp-cell cmp-health"><span class="state ${healthClass(row)}"><span class="cmp-k">Health</span>● ${valueHtml(health)}</span></span>`
      + `<span class="cmp-cell hide-phone"><span class="cmp-k">Last seen</span>${lastSeen.iso ? `<time datetime="${esc(lastSeen.iso)}">${esc(lastSeen.text)}</time>` : esc(lastSeen.text)}</span>`
      + `<span class="cmp-cell hide-phone"><span class="cmp-k">Workers</span>${valueHtml(workers)}</span>`
      + `<span class="cmp-cell hide-phone"><span class="cmp-k">Worst quota</span>${valueHtml(quota)}</span>`
      + `<span class="cmp-cell hide-phone"><span class="cmp-k">Spend</span>${valueHtml(spend)}</span>`
      + `<span class="cmp-cell hide-phone"><span class="cmp-k">Owner</span>${valueHtml(owner)}</span>`
      + `<span class="cmp-cell hide-phone"><span class="cmp-k">Version / kit</span>${valueHtml(version)}</span>`
      + `<span class="cmp-sum">${esc(sum)}${drift}</span>`
      + `</div>`;
  });
  return `<section class="fleet-compare" data-fleet-comparison aria-label="Factory comparison"><div class="cmp-row cmp-head" aria-hidden="true">`
    + ['Factory', 'Kind', 'Health', 'Last seen', 'Workers', 'Worst quota', 'Spend', 'Owner', 'Version / kit'].map((heading) => `<span class="cmp-cell">${esc(heading)}</span>`).join('')
    + `</div>${rows.join('')}</section>`;
}

// ---- Factory cards -------------------------------------------------------------------------

const STALE_SECONDS = 2 * 60 * 60;

function fact(label, info, extra = '') {
  return `<div class="fact"><span class="k">${esc(label)}</span><span class="v">${valueHtml(info)}${extra}</span></div>`;
}
function laneHtml(lane, worst) {
  const used = lane.usedPercent;
  const cls = used >= 90 ? 'crit' : used >= 70 ? 'warn' : '';
  const status = lane.status === 'unknown' ? 'last good' : lane.status === 'warning' ? 'warning' : 'ok';
  return `<div class="lane${worst ? ' worst' : ' more'}" data-fleet-lane="${esc(lane.harness ?? UNKNOWN)}-${esc(lane.lane ?? UNKNOWN)}">`
    + `<span class="who">${esc(lane.harness ?? 'unknown harness')} · ${esc(lane.lane ?? 'unknown lane')} <span class="muted small">shared${shortKey(lane.accountKey) ? ` · ${esc(shortKey(lane.accountKey))}` : ''}</span></span>`
    + `<span class="mono">${esc(String(used))}% <span class="pill">${esc(status)}</span></span>`
    + `<span class="bar"><i class="${cls}" style="width:${esc(String(used))}%"></i></span></div>`;
}
function lanesHtml(row) {
  const readable = (row.summary?.quotas || []).filter((lane) => num(lane?.usedPercent) && lane.usedPercent >= 0 && lane.usedPercent <= 100);
  const lanes = [...readable].sort((left, right) => right.usedPercent - left.usedPercent);
  if (!lanes.length) return '';
  const worst = lanes[0];
  return `<div class="lanes" data-fleet-lanes data-key="fleet-lanes:${esc(String(row.name))}" data-keep-attrs="class"><h3>Quota${row.freshness === 'cached' ? ' · last good data' : ''}</h3>`
    + `<button class="lane-more" type="button" data-fleet-lane-toggle aria-expanded="false" data-keep-attrs="aria-expanded">${lanes.length} lane${lanes.length === 1 ? '' : 's'} · worst ${esc(String(worst.usedPercent))}%</button>`
    + lanes.map((lane, index) => laneHtml(lane, index === 0)).join('') + `</div>`;
}
function boardHtml(project) {
  const board = project.board || {};
  const cell = (key, label) => `${esc(label)} <b>${num(board[key]) ? board[key] : UNKNOWN}</b>`;
  return `<span class="board">${cell('doing', 'doing')}${cell('review', 'review')}${cell('blocked', 'blocked')}${cell('done7d', 'done 7d')}</span>`;
}
function projectsHtml(row) {
  const projects = Array.isArray(row.projects) ? row.projects : [];
  if (!projects.length) return '';
  const stale = row.freshness === 'cached' ? ' · last good data' : '';
  const items = projects.map((project) => {
    const slug = String(project.slug ?? UNKNOWN);
    const staleFlag = num(project.statusAgeSeconds) && project.statusAgeSeconds > STALE_SECONDS
      ? ` <span class="stale">status stale · ${esc(ageText(project.statusAgeSeconds) ?? UNKNOWN)}</span>` : '';
    return `<div class="proj" data-fleet-project="${esc(slug)}"><span class="slug">${esc(slug)}${project.phase ? ` <span class="pill">${esc(project.phase)}</span>` : ''}${staleFlag}</span>`
      + `<span class="mono small">${esc(project.status ?? UNKNOWN)}</span>${boardHtml(project)}</div>`;
  });
  return `<div class="projects"><h3>Projects${stale}</h3>${items.join('')}</div>`;
}
function pendingHtml(row) {
  const waits = Array.isArray(row.pending) ? row.pending : [];
  if (!waits.length) return '';
  return waits.map((wait) => `<p class="wait-owner" data-fleet-pending data-fleet-pending-step="${esc(wait.step ?? UNKNOWN)}"><span><b>Waiting for you:</b> ${esc(wait.step ?? UNKNOWN)}${wait.since ? ` since <time datetime="${esc(wait.since)}">${esc(wait.since)}</time>` : ''}.</span></p>`).join('');
}
function bossInfo(row) {
  const boss = row.summary?.boss;
  if (!boss) return { text: UNKNOWN, reason: 'no Boss reading' };
  if (boss.running === true) return { text: `${'running'}${boss.harness ? ` · ${boss.harness}` : ''}` };
  if (boss.running === false) return { text: 'not running', reason: 'a stopped Boss can be deliberate' };
  return { text: UNKNOWN, reason: 'no pane reading' };
}
function loginsInfo(row) {
  const logins = Array.isArray(row.summary?.harnesses) ? row.summary.harnesses : [];
  if (!logins.length) return { text: UNKNOWN, reason: 'no login reading' };
  return { text: logins.map((login) => `${login.harness ?? UNKNOWN} ${login.login ?? UNKNOWN}`).join(' · ') };
}
function backupInfo() { return { text: UNKNOWN, reason: 'no producer yet (G11)' }; }
function dashboardLink(row) {
  const url = base(row.summary?.dashboardUrl);
  if (!url) return '';
  return `<a class="fleet-dashboard" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open dashboard</a>`;
}
function actionsHtml(row, kind) {
  const name = String(row.name ?? '');
  const summary = row.summary;
  if (!summary) return `<div class="actions" data-fleet-actions>${dashboardLink(row)}<span class="note">No summary is available. Check the factory and its read credential.</span></div>`;
  if (kind === 'native') {
    return `<div class="actions" data-fleet-actions>${dashboardLink(row)}`
      + `<span class="note" data-fleet-native-note>Update: run the release steps in AGENTS.md (fast-forward main, restart the service). Boss start: not available from this page for a native factory (G8).</span></div>`;
  }
  return `<div class="actions" data-fleet-actions>`
    + `<button type="button" class="primary" data-action="update" data-name="${esc(name)}" data-command="herdr-boss factory update ${esc(name)} --tier service" data-effect="Restarts the service and fast-forwards the code.">Factory update</button>`
    + `<button type="button" data-action="boss" data-name="${esc(name)}" data-command="herdr-boss factory boss start ${esc(name)} --resume" data-effect="Starts the Boss pane in the factory.">Boss start</button>`
    + `<button type="button" data-action="copy" data-copy="herdr-boss factory attach ${esc(name)}" data-copy-text="herdr-boss factory attach ${esc(name)}">Copy attach command</button>`
    + dashboardLink(row) + `</div>`;
}
export function fleetFactoryCard(row, reference = null, role = null) {
  const name = String(row.name ?? UNKNOWN);
  const kind = kindText(row);
  const health = healthInfo(row);
  const summary = row.summary;
  const machine = summary?.machine || {};
  const load = num(machine.load1) ? { text: `${machine.load1} · ${num(machine.cpus) ? `${machine.cpus} cpus` : 'cpu count unknown'}` } : { text: UNKNOWN, reason: 'no load reading' };
  const memory = num(machine.memoryFreePercent) ? { text: `${machine.memoryFreePercent}% free` } : { text: UNKNOWN, reason: 'no memory reading' };
  const disk = num(machine.diskFreePercent) ? { text: `${machine.diskFreePercent}% free` } : { text: UNKNOWN, reason: 'no disk reading (G2)' };
  const clock = secondsText(summary?.health?.clockOffsetSeconds) ? { text: secondsText(summary.health.clockOffsetSeconds) } : { text: UNKNOWN, reason: 'no clock reading' };
  const version = versionInfo(row, reference);
  const roleLabel = role && row.role === 'head-office'
    ? `${name} (${kind ?? UNKNOWN}) · Head office (epoch ${role.epoch ?? UNKNOWN})`
    : `${kind ?? UNKNOWN} factory`;
  const owner = ownerInfo(row);
  const facts = [
    fact('Load', load),
    fact('Memory', memory),
    fact('Disk', disk),
    fact('Clock', clock),
    fact('Health (summary)', summaryHealthInfo(row)),
    fact('Version / kit', version),
    fact('Boss (fact)', bossInfo(row)),
    fact('Workers', workersInfo(row)),
    fact('Logins', loginsInfo(row)),
    fact('Spend today', spendInfo(row)),
    fact('Owner items', owner, ` <span class="fleet-secondary">from the Mailbox</span>`),
    fact('Last backup', backupInfo()),
  ].join('');
  const stale = row.freshness === 'cached' ? ' · last good data' : '';
  const packs = Array.isArray(summary?.reviewPacks) ? summary.reviewPacks.length : UNKNOWN;
  const projectNote = `${esc(owner.text)} Owner items · ${esc(String(packs))} review packs waiting · per-project counts are a gap (G7)`;
  const projects = projectsHtml(row);
  const seen = lastSeenInfo(row).text;
  const seenHtml = seen === 'never seen' ? 'never seen' : `last seen ${esc(seen)} ago`;
  return `<article class="card" data-fleet-card data-fleet-factory="${esc(name)}" data-key="fleet-card:${esc(name)}">`
    + `<div class="card-head"><h2>${esc(name)}</h2><span class="role">${esc(roleLabel)}</span><span class="grow"></span>`
    + `<span class="state ${healthClass(row)}">● ${valueHtml(health)}</span><span class="muted small">${seenHtml}${stale}</span></div>`
    + pendingHtml(row)
    + `<div class="facts">${facts}</div>`
    + lanesHtml(row)
    + projects
    + `${projects ? `<p class="small muted">${projectNote}</p>` : ''}`
    + actionsHtml(row, kind)
    + `</article>`;
}

// ---- Role view -----------------------------------------------------------------------------

function roleView(role, factories) {
  if (!role?.headOfficeFactoryId) return '';
  const holder = factories.find((factory) => factory.summary?.factoryId === role.headOfficeFactoryId)?.name || role.headOfficeFactoryId;
  const holds = role.holds ? 'This factory holds the head office role.' : 'Another factory holds the head office role. This factory does not poll the fleet and does not send guidance.';
  const neverTold = role.neverTold?.length ? `<span role="alert" class="fleet-role-alert">Never told of the move: ${esc(role.neverTold.join(', '))}. Turn off head office polling on each of these factories.</span>` : '';
  return ` · Head office: <strong>${esc(holder)}</strong> · epoch ${esc(role.epoch)}<span class="fleet-role-holds"> · ${esc(holds)}</span>${neverTold}`;
}

// ---- Panels (settings and shares) ----------------------------------------------------------

function settingsFieldsHtml(settings, message = '') {
  return `<form data-fleet-settings-form>
    <p>Factory ID: <code>${esc(settings.factoryId)}</code></p>
    <label>Factory name<input name="name" value="${esc(settings.name)}" required maxlength="64"></label>
    <label>Dashboard base URL<input name="dashboardUrl" type="url" value="${esc(settings.dashboardUrl)}" required></label>
    <label class="fleet-checkbox"><input name="headOffice" type="checkbox"${settings.headOffice ? ' checked' : ''}> Poll registered factories</label>
    <label class="fleet-checkbox"><input name="shareItemTitles" type="checkbox"${settings.shareItemTitles ? ' checked' : ''}> Share item titles</label>
    <fieldset><legend>Account scope</legend>${(settings.accounts || []).map((account) => `<label>${esc(account.harness)}<code class="fleet-key">${esc(account.accountKey)}</code><input data-fleet-account="${esc(account.harness)}" value="${esc(account.scope.join(', '))}" aria-label="${esc(account.harness)} factory IDs"></label>`).join('') || '<p class="muted">No account is provisioned.</p>'}</fieldset>
    <button type="submit">Save fleet settings</button><p data-fleet-feedback role="status">${esc(message)}</p></form>`;
}
function fleetPanels(settings, message, shares) {
  if (!settings && !shares) return '';
  const sharesHtml = shares ? fleetSharesView(shares, settings) : '';
  const settingsHtml = settings ? settingsFieldsHtml(settings, message) : '';
  return `<details class="panel fleet-panels" data-key="fleet-panels" data-keep-attrs="open"><summary>Fleet settings and factory shares</summary><div class="fleet-panels-body">${sharesHtml}<div class="fleet-settings" data-fleet-settings>${settingsHtml}</div></div></details>`;
}

// ---- The page ------------------------------------------------------------------------------

function fallbackRow(row) {
  return { ...row,
    health: typeof row.status === 'string' ? row.status : UNKNOWN,
    freshness: row.summary ? 'unknown' : 'never seen',
    lastSeenAt: row.lastSeenAt ?? null,
    workers: num(row.summary?.workers?.running) ? row.summary.workers.running : null,
    quota: null,
    spend: { value: null, day: null, label: null, reason: 'the rollup is unavailable' },
    pending: Array.isArray(row.summary?.pending) ? row.summary.pending : [],
    projects: Array.isArray(row.summary?.projects) ? row.summary.projects : [],
    ownerItems: num(row.summary?.ownerItems?.needsOwner) ? row.summary.ownerItems.needsOwner : null,
    alerts: [] };
}
function findReference(rows, viewFactories, role) {
  const headOfficeId = role?.headOfficeFactoryId;
  return rows.find((row) => headOfficeId && row.summary?.factoryId === headOfficeId)?.summary
    || rows.find((row) => row.role === 'head-office')?.summary
    || rows.find((row) => row.remote === false)?.summary
    || viewFactories.find((row) => row.remote === false)?.summary
    || rows.find((row) => row.summary)?.summary
    || null;
}
function collectAlerts(rows) {
  return rows.flatMap((row) => Array.isArray(row.alerts) ? row.alerts : []);
}

export function fleetView(data, settings, message = '', shares) {
  if (!data) return '<header class="page-head"><h1>Fleet</h1></header><p role="status">Loading the fleet…</p>';
  const rollup = data.rollup && typeof data.rollup === 'object' ? data.rollup : null;
  const viewFactories = Array.isArray(data.factories) ? data.factories : [];
  const rows = rollup && Array.isArray(rollup.factories) ? rollup.factories : viewFactories.map(fallbackRow);
  const reference = findReference(rows, viewFactories, data.role);
  const alerts = collectAlerts(rows);
  // The head keeps its fact line and its Add a host control side by side, so the phone header
  // costs one row instead of two, and the action is a 44 by 44 target at every width.
  const head = `<header class="page-head fleet-head"><h1>Fleet</h1><div class="fleet-head-row"><p class="muted">${rows.length} factories · poll every ${esc(String(data.pollSeconds || 30))} seconds${roleView(data.role, viewFactories.concat(rows))}</p><a class="fleet-add-host" data-fleet-add-host href="/fleet/add-host">Add a host</a></div></header>`;
  const registryError = data.registryError ? `<p role="alert" class="fleet-registry-error">Fleet data unavailable: ${esc(data.registryError)}. Check the fleet registry.</p>` : '';
  const rollupError = !rollup && data.rollupError ? `<p role="alert" class="fleet-registry-error">${esc(data.rollupError)}</p>` : '';
  return `<div class="fleet-page">${head}${registryError}${rollupError}`
    + `${fleetTotals(rollup?.totals)}${fleetAlerts(alerts)}${fleetComparison(rows, reference)}`
    + `${rows.map((row) => fleetFactoryCard(row, reference, data.role)).join('')}`
    + `${fleetPanels(settings, message, shares)}</div>`;
}

export function fleetMailbox(data) {
  const factories = data?.factories || [];
  const rows = factories.flatMap((factory) => (factory.summary?.ownerItems.rows || []).map((item) => {
    const url = base(factory.summary.dashboardUrl);
    const label = item.title || `${item.kind} · ${item.id}`;
    return `<li><span class="tag">${esc(factory.name)}</span><a href="${esc(url)}/mailbox?item=${encodeURIComponent(item.id)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a><span class="muted">${esc(item.kind)}${factory.status === 'offline' ? ' · last good data' : ''}</span></li>`;
  }));
  return `<section class="fleet-mail"><h2>Fleet Mailbox</h2>${rows.length ? `<ul class="fleet-item-list">${rows.join('')}</ul>` : '<p class="muted">No Owner items in the available summaries.</p>'}</section>`;
}

export function fleetSharesFromForm(form, data, validate = true) {
  const accounts = (data?.accounts || []).map((account) => ({ accountKey: account.accountKey,
    shares: account.scope.map((factoryId) => {
      const field = form.querySelector(`[data-fleet-share-account="${account.accountKey}"][data-fleet-share-factory="${factoryId}"]`);
      const share = field ? Number(field.value) : account.shares.find((row) => row.factoryId === factoryId)?.share ?? 0;
      if (validate && (!Number.isInteger(share) || share < 0 || share > 100)) throw new Error('Use whole shares from 0 to 100.');
      return { factoryId, share };
    }) }));
  if (validate && accounts.some((account) => account.shares.reduce((sum, row) => sum + row.share, 0) > 100)) throw new Error('The shares of each account must total at most 100.');
  return { accounts };
}

export function fleetSharesView(data, settings) {
  if (!settings.headOffice) return `<section class="panel"><h2>Factory shares</h2><p class="muted">Set factory shares at the head office. This factory keeps its last accepted share.</p><ul>${(data.local?.shares || []).map((row) => `<li>${esc(row.harness)} · ${esc(row.share)}% ceiling</li>`).join('')}</ul></section>`;
  const accounts = data.accounts || [];
  const deliveries = (data.deliveries || []).map((row) => `<li>${esc(row.factoryId)} · ${esc(row.status)}${row.error ? ` · ${esc(row.error)}` : ''}</li>`).join('');
  const targets = [...new Set(accounts.flatMap((account) => account.scope))];
  return `<section class="panel fleet-shares"><h2>Factory shares</h2><p>Set the ceiling for each shared account. The shares of one account must total at most 100%.</p>
    ${data.error ? `<p role="alert">${esc(data.error)}</p>` : ''}
    ${accounts.length ? `<form data-fleet-shares-form>${accounts.map((account) => {
      const total = account.shares.reduce((sum, row) => sum + row.share, 0);
      return `<fieldset data-fleet-share-group="${esc(account.accountKey)}"><legend>${esc(account.harness)}</legend><code class="fleet-key">${esc(account.accountKey)}</code>
        ${account.shares.map((row) => `<label class="fleet-share-row" data-key="fleet-share:${esc(account.accountKey)}:${esc(row.factoryId)}"><span>${esc(row.factoryId)}</span><output>${esc(row.share)}%</output>
          <input type="range" min="0" max="100" step="1" value="${esc(row.share)}"${data.saving ? ' disabled' : ''} aria-label="${esc(account.harness)} share for ${esc(row.factoryId)}" data-fleet-share-account="${esc(account.accountKey)}" data-fleet-share-factory="${esc(row.factoryId)}"></label>`).join('')}
        <p data-fleet-share-total${total > 100 ? ' class="fleet-share-invalid"' : ''}>Total: ${esc(total)}%${total > 100 ? ' · reduce the shares before saving' : ''}</p></fieldset>`;
    }).join('')}<button type="submit"${data.saving || accounts.some((account) => account.shares.reduce((sum, row) => sum + row.share, 0) > 100) ? ' disabled' : ''}>Save factory shares</button><p role="status" data-fleet-shares-feedback>${esc(data.feedback)}</p></form>` : '<p class="muted">Provision an account digest and scope before setting shares.</p>'}
    ${deliveries ? `<ul class="fleet-deliveries">${deliveries}</ul>` : ''}
    ${targets.length ? `<details data-key="fleet-nudge" data-keep-attrs="open"><summary>Nudge a factory Boss</summary><form data-fleet-nudge-form>
      <label>Factory<select name="factoryId"${data.nudgeSaving ? ' disabled' : ''}>${targets.map((id) => `<option value="${esc(id)}"${data.nudge?.factoryId === id ? ' selected' : ''}>${esc(id)}</option>`).join('')}</select></label>
      <label>Nudge<textarea name="text" required maxlength="500" rows="3"${data.nudgeSaving ? ' disabled' : ''}>${esc(data.nudge?.text)}</textarea></label><button type="submit"${data.nudgeSaving ? ' disabled' : ''}>Send nudge</button><p role="status" data-fleet-nudge-feedback>${esc(data.nudgeFeedback)}</p></form></details>` : ''}</section>`;
}

export function fleetSettingsFromForm(form, settings) {
  return { name: form.elements.name.value, dashboardUrl: form.elements.dashboardUrl.value,
    headOffice: form.elements.headOffice.checked, shareItemTitles: form.elements.shareItemTitles.checked,
    accounts: settings.accounts.map((account) => {
      const field = form.querySelector(`[data-fleet-account="${account.harness}"]`);
      return { ...account, scope: field ? field.value.split(',').map((id) => id.trim()).filter(Boolean) : account.scope };
    }) };
}

export function fleetSettingsView(settings, message = '') {
  return `<details class="panel fleet-settings" data-key="fleet-settings" data-keep-attrs="open"><summary>Fleet settings</summary>${settingsFieldsHtml(settings, message)}</details>`;
}
