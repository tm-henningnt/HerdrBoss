// The read-only fleet view. Links open the factory that owns an item.
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const money = (value) => value === null || !Number.isFinite(value) ? 'Unknown' : `$${value.toFixed(2)}`;
const age = (value) => value === null || value === undefined ? 'Age unknown' : `${value} s old`;
const reasons = { unreachable: 'Host unreachable', timeout: 'Request timed out', auth: 'Read credential refused', 'contract-mismatch': 'Contract mismatch' };
const state = (factory) => `<td class="fleet-state${factory.status === 'offline' ? ' fleet-state-offline' : ''}">${esc(factory.status)}${factory.error ? `<span class="fleet-reason">${esc(reasons[factory.error] || factory.error)}</span>` : ''}</td>`;
const lastSeen = (factory) => `<td>${factory.lastSeenAt ? `<time datetime="${esc(factory.lastSeenAt)}">${esc(factory.lastSeenAt)}</time>` : 'Never seen'}<span class="fleet-secondary">${esc(age(factory.ageSeconds))}</span></td>`;
const base = (value) => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.origin : ''; } catch { return ''; } };
function table(headings, rows, empty) {
  return rows.length ? `<div class="fleet-table-scroll" tabindex="0" role="region" aria-label="${esc(headings.join(', '))}"><table class="fleet-table"><thead><tr>${headings.map((heading) => `<th scope="col">${esc(heading)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : `<p class="muted">${esc(empty)}</p>`;
}
function quotaRows(factories) {
  const groups = new Map();
  for (const factory of factories) for (const quota of factory.summary?.quotas || []) {
    const key = `${quota.accountKey}:${quota.harness}:${quota.lane}`;
    const group = groups.get(key) || { ...quota, names: [], stale: false, readings: [] };
    group.names.push(factory.name); group.stale ||= factory.status === 'offline' || factory.ageSeconds > 90;
    group.readings.push(quota.usedPercent); groups.set(key, group);
  }
  return [...groups.values()].map((row) => {
    const readings = row.readings.filter((reading) => reading !== null);
    const used = readings.length ? `${Math.max(...readings)}%` : 'Unknown';
    return `<tr><th scope="row"><span>${esc(row.harness)} · ${esc(row.lane)}</span><code class="fleet-key" title="${esc(row.accountKey)}">${esc(row.accountKey)}</code></th><td>${used}${row.readings.includes(null) ? ' · partial' : ''}</td><td>${esc(row.names.join(', '))}${row.stale ? ' · last good data' : ''}</td></tr>`;
  });
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
export function fleetView(data, settings, message = '') {
  if (!data) return '<header class="page-head"><h1>Fleet</h1></header><p role="status">Loading the fleet…</p>';
  const factories = data.factories || [];
  const reference = factories.find((factory) => factory.remote === false)?.summary || factories[0]?.summary;
  const rows = factories.map((factory) => {
    const summary = factory.summary;
    if (!summary) return `<tr><th scope="row">${esc(factory.name)}</th>${state(factory)}${lastSeen(factory)}<td colspan="4">No summary. Check the factory and its read credential.</td><td>${esc(factory.version || 'Unknown')}<span class="fleet-secondary">${esc(factory.kitRevision || 'Unknown')}</span></td></tr>`;
    const used = summary.quotas.map((row) => row.usedPercent).filter((value) => value !== null);
    const worst = used.length ? `${Math.max(...used)}% used` : 'Unknown';
    const drift = [summary.version !== reference?.version ? 'version differs' : null, summary.kitRevision !== reference?.kitRevision ? 'kit differs' : null, factory.drift].filter(Boolean).join(' · ');
    const currentDay = new Date().toLocaleDateString('en-CA');
    const spend = summary.spend.filter((row) => row.day === currentDay);
    const today = spend.length && spend.every((row) => row.usd !== null) ? spend.reduce((sum, row) => sum + row.usd, 0) : null;
    const attention = summary.projects.filter((project) => ['blocked', 'review'].includes(project.status)).length;
    return `<tr><th scope="row"><a href="${esc(base(summary.dashboardUrl))}" target="_blank" rel="noopener noreferrer">${esc(factory.name)}</a></th>${state(factory)}${lastSeen(factory)}<td>${summary.projects.length} projects${attention ? ` · ${attention} need attention` : ''}</td><td>${worst}</td><td>${money(today)}</td><td>${summary.ownerItems.needsOwner}</td><td>${esc(summary.version)}<span class="fleet-secondary">${esc(summary.kitRevision)}${drift ? ` · ${esc(drift)}` : ''}</span></td></tr>`;
  });
  const spends = factories.flatMap((factory) => (factory.summary?.spend || []).map((row) => `<tr><th scope="row">${esc(factory.name)}</th><td>${esc(row.day)}</td><td>${esc(row.role)}</td><td>${esc(row.harness)}</td><td>${money(row.usd)}${factory.status === 'offline' ? ' · last good data' : ''}</td></tr>`));
  return `<header class="page-head"><h1>Fleet</h1><p class="muted">${factories.length} factories · poll every ${data.pollSeconds || 30} seconds</p></header>${data.registryError ? `<p role="alert">Fleet data unavailable: ${esc(data.registryError)}. Check the fleet registry.</p>` : ''}
    <section class="panel"><h2>Factories</h2>${table(['Factory', 'Health', 'Last seen', 'Projects', 'Worst quota', 'Spend today', 'Owner items', 'Version and kit'], rows, 'No factory summary is available.')}</section>
    <section class="panel"><h2>Shared account quota</h2>${table(['Account and lane', 'Use', 'Factories'], quotaRows(factories), 'No account is provisioned. Add an account digest and scope.')}<p class="muted">A shared account shows its highest reading. Repeated readings are not added.</p></section>
    <section class="panel"><h2>Spend</h2>${table(['Factory', 'Day', 'Role', 'Harness', 'USD'], spends, 'No spend reading is available.')}</section>
    <div class="panel">${fleetMailbox(data)}</div>${settings ? fleetSettingsView(settings, message) : ''}`;
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
  return `<details class="panel fleet-settings" data-key="fleet-settings" data-keep-attrs="open"><summary>Fleet settings</summary><form data-fleet-settings-form>
    <p>Factory ID: <code>${esc(settings.factoryId)}</code></p>
    <label>Factory name<input name="name" value="${esc(settings.name)}" required maxlength="64"></label>
    <label>Dashboard base URL<input name="dashboardUrl" type="url" value="${esc(settings.dashboardUrl)}" required></label>
    <label class="fleet-checkbox"><input name="headOffice" type="checkbox"${settings.headOffice ? ' checked' : ''}> Poll registered factories</label>
    <label class="fleet-checkbox"><input name="shareItemTitles" type="checkbox"${settings.shareItemTitles ? ' checked' : ''}> Share item titles</label>
    <fieldset><legend>Account scope</legend>${(settings.accounts || []).map((account) => `<label>${esc(account.harness)}<code class="fleet-key">${esc(account.accountKey)}</code><input data-fleet-account="${esc(account.harness)}" value="${esc(account.scope.join(', '))}" aria-label="${esc(account.harness)} factory IDs"></label>`).join('') || '<p class="muted">No account is provisioned.</p>'}</fieldset>
    <button type="submit">Save fleet settings</button><p data-fleet-feedback role="status">${esc(message)}</p></form></details>`;
}
