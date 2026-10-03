import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createDocument, find } from './fake-dom.js';
import { patchHtml } from '../public/keyed.js';
const fixture = JSON.parse(fs.readFileSync(new URL('../docs/contracts/examples/fleet-summary.valid.personal.json', import.meta.url)));

test('the Fleet table shows factory zero and both Windows factories with last seen and a red outage reason', async () => {
  const { fleetView } = await import('../public/fleet.js');
  const factories = ['factory-zero', 'win1', 'win2'].map((name, index) => ({ name, remote: index !== 0,
    status: index === 2 ? 'offline' : 'healthy', error: index === 2 ? 'unreachable' : null, ageSeconds: index === 2 ? 90 : 0,
    lastSeenAt: fixture.generatedAt, summary: { ...fixture, factoryId: name, name } }));
  const html = fleetView({ factories, pollSeconds: 30 });
  for (const name of ['factory-zero', 'win1', 'win2']) assert.match(html, new RegExp(name));
  assert.match(html, /Last seen/);
  assert.match(html, /fleet-state-offline/);
  assert.match(html, /Host unreachable/);
  assert.match(html, /abcdef|012345/);
  assert.match(html, /90 s old/);
});

test('the Fleet page shows stale age, shared quota, spend, drift, and safe Owner item links', async () => {
  const { fleetView, fleetMailbox } = await import('../public/fleet.js');
  const rows = [
    { name: 'factory-a', status: 'healthy', ageSeconds: 0, summary: fixture },
    { name: 'factory-b', status: 'offline', error: 'poll-failed', ageSeconds: 90, drift: 'head office older', summary: { ...fixture, name: 'factory-b', factoryId: 'factory-b', kitRevision: '012345abcdef', dashboardUrl: 'https://example.invalid', version: '0.2.0', ownerItems: { ...fixture.ownerItems, rows: [{ id: 'item-b', kind: 'decide', title: '<img src=x onerror=alert(1)>' }] } } },
  ];
  const html = fleetView({ factories: rows, pollSeconds: 30 });
  assert.match(html, /factory-a/); assert.match(html, /90 s old/); assert.match(html, /offline/);
  assert.match(html, /Shared account quota/); assert.match(html, /25|20/);
  assert.match(html, /Spend/); assert.match(html, /0\.15/);
  assert.match(html, /kit differs/); assert.match(html, /version differs/); assert.match(html, /head office older/);
  const mail = fleetMailbox({ factories: rows });
  assert.match(mail, /https:\/\/example.invalid\/mailbox\?item=item-b/);
  assert.match(mail, /&lt;img/); assert.doesNotMatch(mail, /<img/);
  assert.doesNotMatch(mail, /PRIVATE|accountIdentity/);
  assert.match(fleetView({ factories: [{ name: 'empty', status: 'offline', ageSeconds: null }] }), /No summary/);
  assert.match(fleetView(null), /Loading/);
});

test('the Fleet controls show title sharing and account scopes without a credential field', async () => {
  const { fleetSettingsView } = await import('../public/fleet.js');
  const html = fleetSettingsView({ factoryId: 'factory-a', name: 'factory-a', dashboardUrl: 'https://example.invalid', headOffice: true, shareItemTitles: false, accounts: [{ harness: 'codex', accountKey: 'a'.repeat(64), scope: ['factory-a', 'factory-b'] }] });
  assert.match(html, /Share item titles/); assert.match(html, /Account scope/); assert.match(html, /factory-a, factory-b/);
  assert.doesNotMatch(html, /type="password"|name="token"/);
});

test('a fleet refresh keeps the settings section open', async () => {
  const { fleetSettingsView } = await import('../public/fleet.js');
  globalThis.document = createDocument();
  const settings = { factoryId: 'factory-a', name: 'factory-a', dashboardUrl: 'https://example.invalid', headOffice: true, shareItemTitles: true, accounts: [] };
  const root = document.html(fleetSettingsView(settings));
  const details = find(root, (node) => node.tagName === 'DETAILS');
  details.setAttribute('open', '');
  patchHtml(root, fleetSettingsView(settings));
  assert.equal(details.hasAttribute('open'), true);
});

test('a fleet refresh and submission keep the Owner draft including checkbox and account scope changes', async () => {
  const { fleetSettingsView, fleetSettingsFromForm } = await import('../public/fleet.js');
  globalThis.document = createDocument();
  const saved = { factoryId: 'factory-a', name: 'factory-a', dashboardUrl: 'https://example.invalid', headOffice: true, shareItemTitles: true, accounts: [{ harness: 'codex', accountKey: 'a'.repeat(64), scope: ['factory-a'] }] };
  const root = document.html(fleetSettingsView(saved));
  const fields = Object.fromEntries(['name', 'dashboardUrl', 'headOffice', 'shareItemTitles'].map((name) => [name, find(root, (node) => node.getAttribute('name') === name)]));
  const scope = find(root, (node) => node.getAttribute('data-fleet-account') === 'codex');
  const form = { elements: fields, querySelector: () => scope };
  fields.name.value = 'draft-name'; fields.headOffice.checked = false; fields.shareItemTitles.checked = false;
  scope.value = 'factory-a, factory-b';
  const draft = fleetSettingsFromForm(form, saved);
  patchHtml(root, fleetSettingsView({ ...saved, ...draft }));
  assert.equal(fields.name.value, 'draft-name');
  assert.equal(fields.headOffice.checked, false);
  assert.equal(fields.shareItemTitles.checked, false);
  assert.deepEqual(draft.accounts[0].scope, ['factory-a', 'factory-b']);
  assert.equal(draft.accounts[0].accountKey, saved.accounts[0].accountKey);
  assert.equal(draft.factoryId, undefined, 'the immutable identity is not sent as a setting');
});

test('a remote factory row shows the Attach state and a copy button for the attach command, with no host detail', async () => {
  const { fleetView } = await import('../public/fleet.js');
  const rows = [
    { name: 'win1', remote: true, status: 'healthy', ageSeconds: 0, attach: 'attached', summary: { ...fixture, name: 'win1', factoryId: 'win1' } },
    { name: 'win2', remote: true, status: 'offline', ageSeconds: null, attach: 'not-attached' },
    { name: 'factory-zero', remote: false, status: 'healthy', ageSeconds: 0, summary: fixture },
  ];
  const html = fleetView({ factories: rows, pollSeconds: 30 });
  assert.match(html, /Attach: attached/);
  assert.match(html, /Attach: not attached/);
  assert.match(html, /data-copy-text="herdr-boss factory attach win1"/);
  assert.match(html, /data-copy-text="herdr-boss factory attach win2"/);
  assert.equal(html.match(/Attach:/g).length, 2);
  assert.doesNotMatch(html, /ssh|hf-win/i);
});

test('factory shares show one slider per scoped factory, whole percentages, totals, and a nudge form', async () => {
  const { fleetSharesView } = await import('../public/fleet.js');
  const data = { accounts: [{ harness: 'codex', accountKey: 'a'.repeat(64), scope: ['factory-a', 'factory-b'], shares: [{ factoryId: 'factory-a', share: 40 }, { factoryId: 'factory-b', share: 60 }] }], deliveries: [{ factoryId: 'factory-b', status: 'pending', error: 'auth' }] };
  const html = fleetSharesView(data, { headOffice: true });
  assert.equal((html.match(/type="range"/g) || []).length, 2);
  assert.match(html, /factory-a/); assert.match(html, /factory-b/);
  assert.match(html, /min="0" max="100" step="1"/);
  assert.match(html, /Total: 100%/);
  assert.match(html, /data-fleet-nudge-form/);
  assert.match(html, /pending/);
  assert.doesNotMatch(fleetSharesView(data, { headOffice: false }), /type="range"/);
});

test('client refuses totals above 100 and an account refresh preserves a slider draft', async () => {
  const { fleetSharesView, fleetSharesFromForm } = await import('../public/fleet.js');
  globalThis.document = createDocument();
  const saved = { accounts: [{ harness: 'codex', accountKey: 'a'.repeat(64), scope: ['factory-a', 'factory-b'], shares: [{ factoryId: 'factory-a', share: 50 }, { factoryId: 'factory-b', share: 50 }] }] };
  const root = document.html(fleetSharesView(saved, { headOffice: true }));
  const sliders = ['factory-a', 'factory-b'].map((id) => find(root, (node) => node.getAttribute('data-fleet-share-factory') === id));
  const form = { querySelector: (selector) => sliders.find((node) => selector.includes(node.getAttribute('data-fleet-share-factory'))) };
  sliders[0].value = '60';
  assert.throws(() => fleetSharesFromForm(form, saved), /at most 100/);
  sliders[1].value = '40';
  const draft = fleetSharesFromForm(form, saved);
  patchHtml(root, fleetSharesView({ ...saved, accounts: saved.accounts.map((row, index) => ({ ...row, shares: draft.accounts[index].shares })) }, { headOffice: true }));
  assert.equal(sliders[0].value, '60'); assert.equal(sliders[1].value, '40');
  assert.deepEqual(draft.accounts[0].shares, [{ factoryId: 'factory-a', share: 60 }, { factoryId: 'factory-b', share: 40 }]);
  sliders[0].value = '0'; sliders[1].value = '0';
  assert.equal(fleetSharesFromForm(form, saved).accounts[0].shares[0].share, 0);
});

test('a refresh keeps nudge text, delivery feedback, and pending form controls', async () => {
  const { fleetSharesView } = await import('../public/fleet.js');
  globalThis.document = createDocument();
  const account = { harness: 'codex', accountKey: 'a'.repeat(64), scope: ['factory-a'], shares: [{ factoryId: 'factory-a', share: 100 }] };
  const data = { accounts: [account], feedback: 'Shares saved. Delivery pending.', nudge: { factoryId: 'factory-a', text: 'Please finish sample work.' }, nudgeFeedback: 'Nudge pending.', nudgeSaving: true };
  const root = document.html(fleetSharesView(data, { headOffice: true }));
  patchHtml(root, fleetSharesView({ ...data, deliveries: [{ factoryId: 'factory-a', status: 'pending' }] }, { headOffice: true }));
  const html = fleetSharesView(data, { headOffice: true });
  assert.match(html, /Please finish sample work\./);
  assert.match(html, /Shares saved\. Delivery pending\./);
  assert.match(html, /Nudge pending\./);
  assert.match(html, /textarea[^>]*disabled/);
});


test('the pacing view displays a factory share read problem without private details', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function laneLine(');
  const end = source.indexOf('\n}\n', start) + 2;
  const context = { PROVIDERS: { codex: 'Codex' }, esc: (value) => String(value).replaceAll('<', '&lt;'), validPlan: () => null };
  vm.runInNewContext(`${source.slice(start, end)}; this.render = laneLine;`, context);
  const html = context.render('codex', { state: 'open', factoryShareError: 'Factory shares could not be read. Repair the fleet files.' });
  assert.match(html, /Factory shares could not be read/);
  assert.match(html, /Repair the fleet files/);
});
