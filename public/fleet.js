// The read-only fleet view. Links open the factory that owns an item.
import { copyFieldHtml } from './copy.js';
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const money = (value) => value === null || !Number.isFinite(value) ? 'Unknown' : `$${value.toFixed(2)}`;
const age = (value) => value === null || value === undefined ? 'Age unknown' : `${value} s old`;
const reasons = { unreachable: 'Host unreachable', timeout: 'Request timed out', auth: 'Read credential refused', 'contract-mismatch': 'Contract mismatch' };
const state = (factory) => `<td class="fleet-state${factory.status === 'offline' ? ' fleet-state-offline' : ''}">${esc(factory.status)}${factory.error ? `<span class="fleet-reason">${esc(reasons[factory.error] || factory.error)}</span>` : ''}</td>`;
const lastSeen = (factory) => `<td>${factory.lastSeenAt ? `<time datetime="${esc(factory.lastSeenAt)}">${esc(factory.lastSeenAt)}</time>` : 'Never seen'}<span class="fleet-secondary">${esc(age(factory.ageSeconds))}</span></td>`;
const attachLine = (factory) => factory.attach ? `<span class="fleet-secondary fleet-attach">Attach: ${factory.attach === 'attached' ? 'attached' : 'not attached'}${copyFieldHtml(`herdr-boss factory attach ${factory.name}`, esc, `Copy the attach command for ${factory.name}`)}</span>` : '';
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
function roleView(role, factories) {
  if (!role?.headOfficeFactoryId) return '';
  const holder = factories.find((factory) => factory.summary?.factoryId === role.headOfficeFactoryId)?.name || role.headOfficeFactoryId;
  return `<section class="panel fleet-role"><h2>Head office</h2><p>Holder: <strong>${esc(holder)}</strong> · epoch ${esc(role.epoch)}</p><p class="muted">${role.holds ? 'This factory holds the head office role.' : 'Another factory holds the head office role. This factory does not poll the fleet and does not send guidance.'}</p></section>`;
}
export function fleetView(data, settings, message = '', shares) {
  if (!data) return '<header class="page-head"><h1>Fleet</h1></header><p role="status">Loading the fleet…</p>';
  const factories = data.factories || [];
  const reference = factories.find((factory) => factory.remote === false)?.summary || factories[0]?.summary;
  const rows = factories.map((factory) => {
    const summary = factory.summary;
    if (!summary) return `<tr><th scope="row">${esc(factory.name)}${attachLine(factory)}</th>${state(factory)}${lastSeen(factory)}<td colspan="4">No summary. Check the factory and its read credential.</td><td>${esc(factory.version || 'Unknown')}<span class="fleet-secondary">${esc(factory.kitRevision || 'Unknown')}</span></td></tr>`;
    const used = summary.quotas.map((row) => row.usedPercent).filter((value) => value !== null);
    const worst = used.length ? `${Math.max(...used)}% used` : 'Unknown';
    const drift = [summary.version !== reference?.version ? 'version differs' : null, summary.kitRevision !== reference?.kitRevision ? 'kit differs' : null, factory.drift].filter(Boolean).join(' · ');
    const currentDay = new Date().toLocaleDateString('en-CA');
    const spend = summary.spend.filter((row) => row.day === currentDay);
    const today = spend.length && spend.every((row) => row.usd !== null) ? spend.reduce((sum, row) => sum + row.usd, 0) : null;
    const attention = summary.projects.filter((project) => ['blocked', 'review'].includes(project.status)).length;
    return `<tr><th scope="row"><a href="${esc(base(summary.dashboardUrl))}" target="_blank" rel="noopener noreferrer">${esc(factory.name)}</a>${attachLine(factory)}</th>${state(factory)}${lastSeen(factory)}<td>${summary.projects.length} projects${attention ? ` · ${attention} need attention` : ''}</td><td>${worst}</td><td>${money(today)}</td><td>${summary.ownerItems.needsOwner}</td><td>${esc(summary.version)}<span class="fleet-secondary">${esc(summary.kitRevision)}${drift ? ` · ${esc(drift)}` : ''}</span></td></tr>`;
  });
  const spends = factories.flatMap((factory) => (factory.summary?.spend || []).map((row) => `<tr><th scope="row">${esc(factory.name)}</th><td>${esc(row.day)}</td><td>${esc(row.role)}</td><td>${esc(row.harness)}</td><td>${money(row.usd)}${factory.status === 'offline' ? ' · last good data' : ''}</td></tr>`));
  return `<header class="page-head"><h1>Fleet</h1><p class="muted">${factories.length} factories · poll every ${data.pollSeconds || 30} seconds</p><p><a href="/fleet/add-host">Add a host</a></p></header>${data.registryError ? `<p role="alert">Fleet data unavailable: ${esc(data.registryError)}. Check the fleet registry.</p>` : ''}
    ${roleView(data.role, factories)}
    <section class="panel"><h2>Factories</h2>${table(['Factory', 'Health', 'Last seen', 'Projects', 'Worst quota', 'Spend today', 'Owner items', 'Version and kit'], rows, 'No factory summary is available.')}</section>
    <section class="panel"><h2>Shared account quota</h2>${table(['Account and lane', 'Use', 'Factories'], quotaRows(factories), 'No account is provisioned. Add an account digest and scope.')}<p class="muted">A shared account shows its highest reading. Repeated readings are not added.</p></section>
    ${settings && shares ? fleetSharesView(shares, settings) : ''}
    <section class="panel"><h2>Spend</h2>${table(['Factory', 'Day', 'Role', 'Harness', 'USD'], spends, 'No spend reading is available.')}</section>
    <div class="panel">${fleetMailbox(data)}</div>${settings ? fleetSettingsView(settings, message) : ''}`;
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
  if (!settings.headOffice) return `<section class="panel"><h2>Factory shares</h2><p class="muted">Set factory shares at the head office. This factory keeps its last accepted share.</p><ul>${(data.local?.shares || []).map((row) => `<li>${esc(row.harness)} · ${row.share}% ceiling</li>`).join('')}</ul></section>`;
  const accounts = data.accounts || [];
  const deliveries = (data.deliveries || []).map((row) => `<li>${esc(row.factoryId)} · ${esc(row.status)}${row.error ? ` · ${esc(row.error)}` : ''}</li>`).join('');
  const targets = [...new Set(accounts.flatMap((account) => account.scope))];
  return `<section class="panel fleet-shares"><h2>Factory shares</h2><p>Set the ceiling for each shared account. The shares of one account must total at most 100%.</p>
    ${data.error ? `<p role="alert">${esc(data.error)}</p>` : ''}
    ${accounts.length ? `<form data-fleet-shares-form>${accounts.map((account) => {
      const total = account.shares.reduce((sum, row) => sum + row.share, 0);
      return `<fieldset data-fleet-share-group="${esc(account.accountKey)}"><legend>${esc(account.harness)}</legend><code class="fleet-key">${esc(account.accountKey)}</code>
        ${account.shares.map((row) => `<label class="fleet-share-row" data-key="fleet-share:${esc(account.accountKey)}:${esc(row.factoryId)}"><span>${esc(row.factoryId)}</span><output>${row.share}%</output>
          <input type="range" min="0" max="100" step="1" value="${row.share}"${data.saving ? ' disabled' : ''} aria-label="${esc(account.harness)} share for ${esc(row.factoryId)}" data-fleet-share-account="${esc(account.accountKey)}" data-fleet-share-factory="${esc(row.factoryId)}"></label>`).join('')}
        <p data-fleet-share-total${total > 100 ? ' class="fleet-share-invalid"' : ''}>Total: ${total}%${total > 100 ? ' · reduce the shares before saving' : ''}</p></fieldset>`;
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
  return `<details class="panel fleet-settings" data-key="fleet-settings" data-keep-attrs="open"><summary>Fleet settings</summary><form data-fleet-settings-form>
    <p>Factory ID: <code>${esc(settings.factoryId)}</code></p>
    <label>Factory name<input name="name" value="${esc(settings.name)}" required maxlength="64"></label>
    <label>Dashboard base URL<input name="dashboardUrl" type="url" value="${esc(settings.dashboardUrl)}" required></label>
    <label class="fleet-checkbox"><input name="headOffice" type="checkbox"${settings.headOffice ? ' checked' : ''}> Poll registered factories</label>
    <label class="fleet-checkbox"><input name="shareItemTitles" type="checkbox"${settings.shareItemTitles ? ' checked' : ''}> Share item titles</label>
    <fieldset><legend>Account scope</legend>${(settings.accounts || []).map((account) => `<label>${esc(account.harness)}<code class="fleet-key">${esc(account.accountKey)}</code><input data-fleet-account="${esc(account.harness)}" value="${esc(account.scope.join(', '))}" aria-label="${esc(account.harness)} factory IDs"></label>`).join('') || '<p class="muted">No account is provisioned.</p>'}</fieldset>
    <button type="submit">Save fleet settings</button><p data-fleet-feedback role="status">${esc(message)}</p></form></details>`;
}
