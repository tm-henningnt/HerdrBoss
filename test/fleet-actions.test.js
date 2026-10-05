// FP1 T6: the Fleet actions and the copy outcomes.
// Invented data only. No real factory, host, path, or credential enters this file.
import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createDocument, find } from './fake-dom.js';
import { buildFleetRollup } from '../src/fleet-rollup.js';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const now = Date.parse('2026-10-05T12:00:00Z');
const accountKey = 'a'.repeat(64);

function summary(name, overrides = {}) {
  return {
    schema: 1, contractVersion: '1.0.0', factoryId: name, name, version: '0.1.0', kitRevision: '2e0a5d394ccc',
    generatedAt: '2026-10-05T11:59:50Z', dashboardUrl: 'https://factory.example',
    health: { status: 'healthy', tickAgeSeconds: 10, herdrReachable: true, clockOffsetSeconds: null },
    machine: { load1: 0.8, cpus: 8, memoryFreePercent: 42, diskFreePercent: 50, utcOffsetMinutes: 0 },
    workers: { running: 2, max: 8 }, harnesses: [], boss: { running: true, harness: 'claude' }, pending: [],
    projects: [], quotas: [], spend: [], alerts: [], ownerItems: { total: 0, needsOwner: 0, rows: [] }, reviewPacks: [],
    ...overrides,
  };
}

function factory(name, options = {}) {
  const { summary: body = null, ...fields } = options;
  return {
    name, factoryId: name, kind: body?.kind ?? (name === 'factory-zero' ? 'native' : 'container'),
    status: body ? 'healthy' : 'offline', error: body ? null : 'unreachable', drift: null,
    ageSeconds: body ? 10 : null, lastSeenAt: body ? '2026-10-05T11:59:50Z' : null, summary: body, ...fields,
  };
}

const native = () => factory('factory-zero', { summary: summary('factory-zero', { kind: 'native',
  machine: { load1: 0.8, cpus: 8, memoryFreePercent: 42, diskFreePercent: 12, utcOffsetMinutes: 0 } }) });
const container = () => factory('win1', { summary: summary('win1', { kind: 'container',
  harnesses: [{ harness: 'claude', login: 'expired' }, { harness: 'codex', login: 'ok' }] }) });

function rollupFor(factories) {
  return buildFleetRollup(factories, { now });
}

// The rollup keeps the alerts on each factory row.
function alertsFor(factories) {
  return rollupFor(factories).factories.flatMap((row) => row.alerts);
}

// The Copy button inside one alert of the rendered strip.
function alertCopyButton(html, code) {
  const root = createDocument().html(html);
  const alert = find(root, (el) => el.getAttribute('data-fleet-alert-code') === code);
  assert.ok(alert, `an alert with code ${code}`);
  const button = find(alert, (el) => el.hasAttribute('data-fleet-alert-fix-copy'));
  assert.ok(button, `a copy button for ${code}`);
  return button;
}

async function load(names, context = {}) {
  const code = names.map((name) => {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} exists in public/app.js`);
    return source.slice(start, source.indexOf('\n}\n', start) + 2);
  }).join('\n');
  vm.runInNewContext(`${code}\nthis.fns = { ${names.join(', ')} };`, context);
  return context.fns;
}

// ----- P2-3: the kind-specific command for a card and for each alert -----

test('P2-3 a native disk-low alert carries the Owner-terminal instruction, not a host command', async () => {
  const { copySource } = await import('../public/copy.js');
  const html = (await import('../public/fleet.js')).fleetAlerts(alertsFor([native()]));
  const button = alertCopyButton(html, 'disk-low');
  assert.equal(button.getAttribute('data-copy'), 'Free disk space on this Mac. Check the data volume with df -h.');
  assert.equal(copySource(button), 'Free disk space on this Mac. Check the data volume with df -h.');
});

test('P2-3 the login fix copies the command of the expired row harness', async () => {
  const { copySource } = await import('../public/copy.js');
  const html = (await import('../public/fleet.js')).fleetAlerts(alertsFor([container()]));
  const button = alertCopyButton(html, 'login-expired');
  assert.equal(copySource(button), 'herdr-boss factory login win1 claude');
  assert.doesNotMatch(copySource(button), /codex/);
});

test('P2-3 a container card carries the host commands and a native card carries the release note', async () => {
  const { fleetView } = await import('../public/fleet.js');
  const html = fleetView({ factories: [native(), container()], pollSeconds: 30, rollup: rollupFor([native(), container()]) });
  assert.match(html, /data-action="update" data-name="win1" data-command="herdr-boss factory update win1 --tier service"/);
  assert.match(html, /data-action="boss" data-name="win1" data-command="herdr-boss factory boss start win1 --resume"/);
  assert.match(html, /data-action="copy" data-copy="herdr-boss factory attach win1"/);
  assert.match(html, /data-fleet-native-note/);
  assert.doesNotMatch(html, /data-name="factory-zero"/);
});

// ----- P2-5: success only after a successful write; a refused or missing API stays open -----

test('P2-5 Confirm copy shows success only after a successful clipboard write', async () => {
  const { confirmCopy } = await import('../public/copy.js');
  const writes = [];
  const result = await confirmCopy('herdr-boss factory update win1 --tier service', { navigator: { clipboard: { writeText: async (text) => { writes.push(text); } } } });
  assert.deepEqual(writes, ['herdr-boss factory update win1 --tier service']);
  assert.equal(result.copied, true);
  assert.equal(result.manual, false);
});

test('P2-5 a refused clipboard write shows the manual-copy instruction and no success', async () => {
  const { confirmCopy } = await import('../public/copy.js');
  const result = await confirmCopy('herdr-boss factory update win1 --tier service', { navigator: { clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } } } });
  assert.equal(result.copied, false);
  assert.equal(result.manual, true);
  assert.match(result.message, /by hand/i);
});

test('P2-5 a missing clipboard API shows the manual-copy instruction and no success', async () => {
  const { confirmCopy } = await import('../public/copy.js');
  const result = await confirmCopy('herdr-boss factory update win1 --tier service', {});
  assert.equal(result.copied, false);
  assert.equal(result.manual, true);
  assert.match(result.message, /by hand/i);
});

test('P2-5 the sheet shows the exact command, the Owner terminal, Confirm copy, and Cancel', async () => {
  const { fleetConfirmSheetHtml } = await load(['fleetConfirmSheetHtml']);
  const html = fleetConfirmSheetHtml();
  assert.match(html, /id="fleet-confirm-command"/);
  assert.match(html, /Run this command in the Owner terminal on the host machine\./);
  assert.match(html, />Confirm copy</);
  assert.match(html, />Cancel</);
  assert.match(html, /id="fleet-confirm-status" role="status"/);
});

test('P2-5 a failed write keeps the sheet open and selects the exact command', async () => {
  const { applyFleetConfirmResult } = await load(['applyFleetConfirmResult']);
  const command = { name: 'command' };
  const status = { textContent: '' };
  let closed = false;
  let selected = null;
  const sheet = { querySelector: (selector) => (selector === '#fleet-confirm-command' ? command : status), close() { closed = true; } };
  const kept = applyFleetConfirmResult(sheet, { copied: false, message: 'Copy failed. The command is selected. Copy it by hand.' }, (node) => { selected = node; }, () => { closed = true; });
  assert.equal(kept, false);
  assert.equal(status.textContent, 'Copy failed. The command is selected. Copy it by hand.');
  assert.equal(selected, command);
  assert.equal(closed, false, 'the sheet stays open');
});

test('P2-5 a successful write closes the sheet and selects nothing', async () => {
  const { applyFleetConfirmResult } = await load(['applyFleetConfirmResult']);
  const command = { name: 'command' };
  const status = { textContent: '' };
  let closed = false;
  let selected = null;
  const sheet = { querySelector: (selector) => (selector === '#fleet-confirm-command' ? command : status), close() { closed = true; } };
  const done = applyFleetConfirmResult(sheet, { copied: true, message: 'Copied.' }, (node) => { selected = node; }, () => { closed = true; });
  assert.equal(done, true);
  assert.equal(selected, null);
  assert.equal(closed, true, 'the sheet closes only after the write');
});

test('P2-5 the manual copy selects the text of the command', async () => {
  const { selectElementText } = await load(['selectElementText']);
  const command = { name: 'command' };
  const calls = { node: null, removed: 0, added: null };
  const range = { selectNodeContents(node) { calls.node = node; } };
  const selection = { removeAllRanges() { calls.removed += 1; }, addRange(value) { calls.added = value; } };
  const view = { document: { createRange: () => range }, getSelection: () => selection };
  assert.equal(selectElementText(command, view), true);
  assert.equal(calls.node, command);
  assert.equal(calls.added, range);
  assert.equal(calls.removed, 1);
});

// ----- The controls that reveal the command -----

test('the Fix control opens the alert detail and keeps aria-expanded accurate', async () => {
  const { toggleFleetDetail } = await load(['toggleFleetDetail']);
  const container = { classList: { open: false, toggle() { this.open = !this.open; return this.open; } } };
  const button = { attrs: {}, setAttribute(key, value) { this.attrs[key] = value; }, closest: (selector) => (selector === '.alert' ? container : null) };
  assert.equal(toggleFleetDetail(button, '.alert'), true);
  assert.equal(button.attrs['aria-expanded'], 'true');
  assert.equal(toggleFleetDetail(button, '.alert'), false);
  assert.equal(button.attrs['aria-expanded'], 'false');
});

test('the app wires the Fleet toggle, the confirm sheet, and confirmCopy', () => {
  assert.match(source, /data-fleet-alert-toggle/);
  assert.match(source, /data-fleet-lane-toggle/);
  assert.match(source, /data-action\]\[data-command/);
  assert.match(source, /openFleetConfirm\(/);
  assert.match(source, /confirmCopy\(/);
  assert.match(source, /#fleet-confirm-cancel/);
});
