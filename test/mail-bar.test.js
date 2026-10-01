// The phone action bar of a Mailbox thread and the phone selection bar.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDocument, find, byKey } from './fake-dom.js';

const { mailBarItem, mailActionBarHtml, mailSelectionBarHtml } = await import('../public/mail-bar.js');
const { patchHtml } = await import('../public/keyed.js');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const icon = (name) => `<svg data-icon="${name}"></svg>`;
const helpers = (extra = {}) => ({ esc, icon, busy: false, draft: '', status: '', noteOpen: false, ...extra });

function body(signature) {
  const match = new RegExp(`\\nfunction ${signature.replace(/[()]/g, '\\$&')} \\{([\\s\\S]*?)\\n\\}`).exec(app);
  assert.ok(match, `the UI defines ${signature}`);
  return match[1];
}

test('the bar holds the open item of the last agent message, and only then', () => {
  const ask = { id: 'a1', from: 'orch', to: 'owner' };
  const open = { a1: { id: 'a1', action: 'approve' } };
  assert.equal(mailBarItem([ask], (id) => open[id]).id, 'a1');
  assert.equal(mailBarItem([ask, { id: 'o1', from: 'owner', to: 'orch' }], (id) => open[id]).id, 'a1', 'the last agent message counts, not the last message');
  assert.equal(mailBarItem([ask], () => ({ id: 'a1', action: 'decide', closedAt: '2026-09-30T10:00:00Z' })), null, 'a closed item');
  assert.equal(mailBarItem([ask], () => ({ id: 'a1', action: 'read' })), null, 'a read item has no action form');
  assert.equal(mailBarItem([ask], () => undefined), null, 'an item outside the loaded folders');
  assert.equal(mailBarItem([], () => undefined), null);
  const older = { id: 'a0', from: 'orch', to: 'owner' };
  const items = { a0: { id: 'a0', action: 'answer' }, a1: { id: 'a1', action: 'read' } };
  assert.equal(mailBarItem([older, ask], (id) => items[id]), null, 'an older open item keeps its form in the message');
});

test('an approval bar has Approve, Reject, a note button, and Dismiss in one row', () => {
  const html = mailActionBarHtml({ id: 'a1', action: 'approve' }, helpers());
  assert.match(html, /^<form class="mail-action-bar"[^>]*data-key="mail-bar:a1"[^>]*data-mail-form="a1"/);
  assert.match(html, /<button type="submit" class="mail-bar-primary" data-mail-verdict="Approved\.">Approve<\/button>/);
  assert.match(html, /<button type="submit" class="mail-decline" data-mail-verdict="Rejected\.">Reject<\/button>/);
  assert.match(html, /data-mail-note="a1"[^>]*aria-label="Add a note"/);
  assert.match(html, /data-mail-dismiss="a1"[^>]*aria-label="Dismiss"/);
  assert.doesNotMatch(html, /<textarea/, 'the note field is closed');
  assert.match(html, /<p class="mail-status" role="status"><\/p>/);
});

test('the note field opens on request and stays open while it holds text', () => {
  for (const extra of [{ noteOpen: true }, { draft: 'Keep the old flag.' }]) {
    const html = mailActionBarHtml({ id: 'a1', action: 'approve' }, helpers(extra));
    assert.match(html, /<label class="visually-hidden" for="mail-text-a1">Note \(optional\)<\/label><textarea id="mail-text-a1" data-mail-draft="a1" maxlength="1700" rows="1"/);
    assert.doesNotMatch(html, /data-mail-note=/, 'no note button while the field shows');
  }
  assert.match(mailActionBarHtml({ id: 'a1', action: 'approve' }, helpers({ draft: 'a <b>' })), />a &lt;b&gt;<\/textarea>/);
});

test('a decision with choices shows one button for each choice in a sideways row', () => {
  const html = mailActionBarHtml({ id: 'd1', action: 'decide', choices: ['Ship', 'Wait'] }, helpers());
  assert.match(html, /<div class="mail-bar-choices" role="group" aria-label="Choices"><button type="button" data-mail-choice="Ship" data-mail-item="d1">Ship<\/button><button type="button" data-mail-choice="Wait" data-mail-item="d1">Wait<\/button><\/div>/);
  assert.match(html, /data-mail-note="d1"[^>]*aria-label="Write another answer or a note"/);
  const typed = mailActionBarHtml({ id: 'd1', action: 'decide', choices: ['Ship'] }, helpers({ noteOpen: true }));
  assert.match(typed, /for="mail-text-d1">Other answer, or a note for the choice<\/label>/);
  assert.match(typed, /<button type="submit" class="mail-bar-send" aria-label="Send">/);
});

test('an answer bar is a composer: Dismiss, the answer field, and Send', () => {
  const html = mailActionBarHtml({ id: 'q1', action: 'answer' }, helpers());
  assert.match(html, /data-mail-dismiss="q1"[\s\S]*<textarea id="mail-text-q1" data-mail-draft="q1" maxlength="2000" rows="1" placeholder="Answer…"[\s\S]*class="mail-bar-send" aria-label="Send"/);
  assert.match(html, /<label class="visually-hidden" for="mail-text-q1">Answer<\/label>/);
  const decision = mailActionBarHtml({ id: 'q2', action: 'decide', choices: [] }, helpers());
  assert.match(decision, /for="mail-text-q2">Decision<\/label>/);
  assert.match(decision, /placeholder="Decision…"/);
});

test('a busy bar disables its buttons and shows the status', () => {
  const html = mailActionBarHtml({ id: 'a1', action: 'approve' }, helpers({ busy: true, status: 'Sending…' }));
  assert.equal((html.match(/<button[^>]*disabled/g) || []).length, (html.match(/<button/g) || []).length);
  assert.match(html, /role="status">Sending…<\/p>/);
});

test('the selection bar shows the count, Clear, Select all, and Dismiss', () => {
  const html = mailSelectionBarHtml({ selected: 2, total: 3, busy: false, esc, icon });
  assert.match(html, /^<div class="mail-action-bar mail-select-bar" data-key="mail-select-bar" role="region" aria-label="Selection">/);
  assert.match(html, /data-mail-select-clear aria-label="Clear the selection"/);
  assert.match(html, /<span class="mail-select-count" aria-live="polite"><span class="num">2<\/span> selected<\/span>/);
  assert.match(html, /<input type="checkbox" data-mail-select-all aria-label="Select all Needs-you items">/);
  assert.match(html, /<button type="button" class="mail-bar-primary" data-mail-dismiss-selected>Dismiss 2<\/button>/);
  assert.match(mailSelectionBarHtml({ selected: 3, total: 3, busy: true, esc, icon }), /data-mail-select-all aria-label="Select all Needs-you items" checked>[\s\S]*data-mail-dismiss-selected disabled>Dismiss 3/);
});

test('a keyed refresh of the bar keeps the focused field, its text, and its caret', () => {
  globalThis.document = createDocument();
  const pane = (status) => `<section class="mail-reading"><div class="mail-conversation-scroll" data-key="mail-thread:alpha:a1"><ol class="mail-conversation"><li>text</li></ol></div>${mailActionBarHtml({ id: 'q1', action: 'answer' }, helpers({ status }))}</section>`;
  const root = document.html(pane(''));
  const bar = byKey(root, 'mail-bar:q1');
  const field = find(root, (el) => el.tagName === 'TEXTAREA');
  field.value = 'half an ans';
  field.focus();
  field.setSelectionRange(4, 4);
  patchHtml(root, pane('Sending…'));
  assert.equal(byKey(root, 'mail-bar:q1'), bar);
  assert.equal(find(root, (el) => el.tagName === 'TEXTAREA'), field);
  assert.equal(field.value, 'half an ans');
  assert.deepEqual([field.selectionStart, field.selectionEnd], [4, 4]);
  assert.equal(document.activeElement, field);
});

test('on the phone the thread renders the bar, and the message keeps no second form', () => {
  const view = body('mailConversationView(s)');
  assert.match(view, /const barItem = appPhone\(\) \? mailBarItem\(records, mailFind\) : null;/);
  assert.match(view, /mailConversationMessage\(s, record, barItem\)/);
  assert.match(view, /barItem \? mailBar\(barItem\) : mailReplyFormShown\(records, mailFind\) \? `<form class="mail-reply"/);
  assert.match(body('mailConversationMessage(s, record, barItem)'), /item && item === barItem \? ''/);
});

test('on the phone the thread bar title is the page h1; on a desktop it is an h2 under the list h1', () => {
  assert.match(app, /const appPhoneMedia = window\.matchMedia\('\(max-width: 760px\)'\);/);
  assert.match(app, /appPhoneMedia\.addEventListener\('change'/);
  const tag = /const threadTitleTag = \(\) => (.*);/.exec(app)?.[1];
  assert.equal(tag, "appPhone() ? 'h1' : 'h2'");
  for (const fn of ['mailConversationView(s)', 'mailComposeView(s)', 'chatConversationView()']) {
    const src = body(fn);
    assert.doesNotMatch(src, /<h2>/, `${fn} has a fixed h2`);
    assert.match(src, /<\$\{titleTag\}>/, `${fn} uses the title tag`);
  }
});

test('on the phone a selection shows the selection bar in place of the New button', () => {
  const view = body('mailboxView(s)');
  assert.match(view, /const selecting = appPhone\(\) && folder === 'needs-you' && selected > 0;/);
  assert.match(view, /selecting \? mailSelectionBarHtml\(/);
  assert.match(view, /selecting \? '' : `<button type="button" class="mail-fab"/);
  const clear = /if \(e\.target\.closest\?\.\('\[data-mail-select-clear\]'\)\) \{ mailSelected\.clear\(\); render\(\); return; \}/;
  assert.match(app, clear);
  assert.match(app, /const note = e\.target\.closest\?\.\('\[data-mail-note\]'\);/);
});

test('the phone bars sit at the bottom edge above the safe-area inset', () => {
  const at = css.indexOf('@media (max-width: 760px) {\n  body.app-view {');
  assert.ok(at >= 0, 'the phone app view block exists');
  const phone = css.slice(at, css.indexOf('\n}\n', at));
  assert.match(phone, /\.mail-action-bar \{[^}]*flex: 0 0 auto;[^}]*padding: [^;]*calc\(6px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(css, /\.mail-bar-row \{[^}]*display: flex;/);
  // The choices wrap onto more rows, so a third choice is never out of view.
  assert.match(css, /\.mail-bar-choices \{[^}]*flex-wrap: wrap;/);
  assert.match(phone, /\.mail-list-pane\.selecting \.mail-list-scroll \{ padding-bottom: 0; \}/);
  assert.match(phone, /\.mail-reply \{ grid-template-columns: minmax\(0, 1fr\) auto;[^}]*calc\(6px \+ env\(safe-area-inset-bottom\)\)/, 'the Reply form is the same pill composer');
  assert.match(phone, /\.mail-reply textarea \{[^}]*border-radius: 22px;/);
});
