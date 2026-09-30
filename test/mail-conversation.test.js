import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function body(signature) {
  const match = new RegExp(`\\nfunction ${signature.replace(/[()]/g, '\\$&')} \\{([\\s\\S]*?)\\n\\}`).exec(app);
  assert.ok(match, `the UI defines ${signature}`);
  return match[1];
}

// An open answer, approve, or decide item has its own form. A second Reply form below it would send to the same item.
test('the Reply form hides while the last agent message is an open item with its own form', () => {
  const shown = new Function('records', 'find', body('mailReplyFormShown(records, find)'));
  const ask = { id: 'a1', from: 'orch', to: 'owner', action: 'decide' };
  const items = { a1: { id: 'a1', action: 'decide' } };
  assert.equal(shown([ask], (id) => items[id]), false);
  assert.equal(shown([ask], (id) => ({ ...items[id], action: 'approve' })), false);
  assert.equal(shown([ask], (id) => ({ ...items[id], action: 'answer' })), false);
  assert.equal(shown([ask], (id) => ({ ...items[id], closedAt: '2026-09-30T10:00:00Z' })), true, 'a closed item has no form');
  assert.equal(shown([ask], (id) => ({ ...items[id], action: 'read' })), true, 'a read item has no answer form');
  assert.equal(shown([ask], () => undefined), true, 'an item outside the loaded folders');
  assert.equal(shown([ask, { id: 'o1', from: 'owner', to: 'orch' }], (id) => items[id]), false, 'the last agent message counts, not the last message');
  assert.equal(shown([], () => undefined), true);
  assert.match(body('mailConversationView(s)'), /mailReplyFormShown\(records, mailFind\) \? `<form class="mail-reply"/);
});

// The first line of a reply is its headline. The body shows the same line, so the header shows only the sender and the time.
test('a conversation message does not repeat its first line above the body', () => {
  const fn = body('mailConversationMessage(s, record, barItem)');
  assert.doesNotMatch(fn, /mailHeadline\(record\)/);
  assert.doesNotMatch(fn, /<span>\$\{esc\(headline\)\}<\/span>/);
});

// The Mailbox and the Chat card answer an approval with the same two verdicts, so the agent reads one word for one decision.
test('the Mailbox and the Chat card use the same approval verdicts', () => {
  const mail = body('mailActions(item)');
  assert.match(mail, /data-mail-verdict="Approved\."[^>]*>Approve<\/button>/);
  assert.match(mail, /data-mail-verdict="Rejected\."[^>]*>Reject<\/button>/);
  // The Chat label still reads a stored `Declined.` answer from an older Mailbox; nothing sends it.
  assert.match(app, /startsWith\('Declined\.'\)/);
  assert.doesNotMatch(app.replace(/body\.startsWith\('Declined\.'\)/, ''), /Declined\.|>Decline</);
  assert.match(app, /\{ value: 'Rejected\.', label: 'Reject', deny: true \}/);
});
