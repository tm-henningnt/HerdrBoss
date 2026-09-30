// The G5c page pass: the Mailbox, the Chat, the Analytics page, the Help panel, and the dialogs
// share the buttons, the dialog title, and the chart sizes of the other pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { lineChart, stripBars } from '../public/analytics.js';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const body = (name) => { const start = source.indexOf(`function ${name}(`); assert.ok(start >= 0, `${name} exists`); return source.slice(start, source.indexOf('\n}\n', start)); };
function load(names, context = {}) {
  const code = names.map((name) => body(name) + '\n}\n').join('\n');
  const ctx = { ...context };
  vm.runInNewContext(`${code}\nthis.fns = { ${names.join(', ')} };`, ctx);
  return ctx.fns;
}
// The rules of one media block, or of the top level when media is null.
function rule(selector, media = null) {
  const scope = media === null ? css : css.slice(css.indexOf(media));
  const at = scope.indexOf(`${selector} {`);
  assert.ok(at >= 0, `${selector} has a rule${media ? ` in ${media}` : ''}`);
  return scope.slice(at, scope.indexOf('}', at));
}

test('a delivered or relayed message without a time shows no stray dash', () => {
  const { mailDeliveryState } = load(['mailDeliveryState', 'clock']);
  assert.equal(mailDeliveryState({ status: 'sent' }), 'delivered');
  assert.equal(mailDeliveryState({ status: 'relayed' }), 'relayed by the Boss');
  assert.match(mailDeliveryState({ status: 'sent', sentAt: new Date().toISOString() }), /^delivered \d\d:\d\d$/);
  assert.equal(mailDeliveryState({ status: 'failed' }), 'failed: unknown error');
  assert.equal(mailDeliveryState({}), 'queued');
});

test('the quota chart names one hour in the singular', () => {
  const { lastWindowText } = load(['lastWindowText']);
  assert.equal(lastWindowText(1), 'the last hour');
  assert.equal(lastWindowText(6), 'the last 6 hours');
  assert.equal(lastWindowText(96), 'the last 4 days');
  assert.match(body('quotaChart'), /\$\{lastWindowText\(hours\)\}/);
});

test('a long timeline keeps its tick labels readable on a phone and scrolls in its own box', () => {
  const values = Array.from({ length: 144 }, (_, i) => i % 50);
  const points = values.map((_, i) => i);
  const minWidth = (svg) => Number(/min-width:(\d+)px/.exec(svg)[1]);
  const viewWidth = (svg) => Number(/viewBox="0 0 (\d+(?:\.\d+)?) /.exec(svg)[1]);
  for (const svg of [lineChart({ points, series: [{ cls: 's1', values }] }), stripBars({ values, max: 50 })]) {
    // A 10.5 px tick renders at 9 px or more when the chart keeps 86 percent of its view width.
    assert.ok(minWidth(svg) >= Math.round(viewWidth(svg) * 0.86), `min-width ${minWidth(svg)} of ${viewWidth(svg)}`);
  }
  assert.match(rule('.viz-scroll'), /overflow-x:\s*auto/);
});

test('an empty chart card shows one frame, not a box in a box', () => {
  const empty = rule('.viz-card .calm-state');
  assert.match(empty, /border:\s*0/);
  assert.match(empty, /background:\s*transparent/);
});

test('the phone decide bar wraps its choices, so no choice is out of view', () => {
  const choices = rule('.mail-bar-choices');
  assert.match(choices, /flex-wrap:\s*wrap/);
  assert.doesNotMatch(choices, /overflow-x:\s*auto/);
  assert.match(css, /\.mail-bar-row:has\(> \.mail-bar-choices\)\s*\{[^}]*align-items:\s*flex-end/);
  assert.match(css, /:root \.mail-bar-choices button\s*\{[^}]*white-space:\s*normal/);
});

test('every dialog uses one title style and one quiet close or cancel button', () => {
  assert.match(css, /dialog h2\s*\{[^}]*text-transform:\s*none/);
  const dialogs = body('messageDialog') + body('leaseDialog') + body('resourcePoolRemoveDialog') + body('browserConfirm');
  assert.match(dialogs, /<button type="button" class="quiet" data-message-close>Close<\/button>/);
  assert.match(dialogs, /<button type="button" class="quiet" data-lease-cancel>Cancel<\/button>/);
  assert.match(dialogs, /<button type="button" class="quiet" data-pool-remove-cancel>Cancel<\/button>/);
  assert.match(dialogs, /<button type="button" class="quiet" data-browser-confirm="no">Cancel<\/button>/);
  assert.match(html, /<button type="button" id="browser-viewer-close" class="quiet">Close<\/button>/);
});

test('the Messages dialog has one primary action; the quick messages are quiet', () => {
  const dialog = body('messageDialog');
  assert.match(dialog, /class="quiet" data-message-nudge=/);
  assert.match(dialog, /class="quiet" data-message-status>Ask for status/);
  assert.match(dialog, /<button type="submit">Send<\/button>/);
});

test('a destructive dialog action is a red outline, never red on the accent fill', () => {
  assert.match(body('leaseDialog'), /class="danger" id="lease-confirm-release"/);
  assert.match(body('resourcePoolRemoveDialog'), /class="danger" id="resource-pool-remove-confirm"/);
  assert.match(css, /\n:root dialog button\.danger \{[^}]*background:\s*transparent[^}]*color:\s*var\(--crit\)/);
});

test('the phone browser viewer gives the address field its own row', () => {
  const block = css.slice(css.indexOf('#browser-viewer[open] { display: flex;'));
  assert.match(block, /#browser-viewer \.browser-viewer-head \.browser-navigate\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(block, /#browser-viewer \.browser-navigate input\s*\{[^}]*order:\s*-2[^}]*flex:\s*1 1 calc\(100% - \d+px\)/);
  assert.match(block, /#browser-viewer \.browser-navigate button\[type="submit"\]\s*\{[^}]*order:\s*-1/);
});

test('muted text on a current or open row keeps 4.5:1 contrast', () => {
  assert.match(css, /\[aria-current="page"\] > \.mail-folder-count, \[aria-current="page"\] > \.app-drawer-count\s*\{[^}]*color:\s*var\(--text\)/);
  assert.match(css, /\.mail-entry\[aria-current="true"\] \.mail-side time\s*\{[^}]*color:\s*var\(--text\)/);
  assert.match(rule('.chat-bubble.from-owner .chat-bubble-time'), /color:/);
});
