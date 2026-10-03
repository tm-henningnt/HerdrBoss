import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
