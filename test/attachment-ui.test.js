import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ATTACHMENT_LIMIT,
  MAX_ATTACHMENT_BYTES,
  SUPPORTED_ATTACHMENT_TYPES,
  attachmentFileError,
  attachmentStripState,
  attachmentPickerHtml,
  attachmentStripHtml,
} from '../public/attachment-ui.js';
import { mailActionBarHtml } from '../public/mail-bar.js';

const esc = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const icon = (name) => `<svg data-icon="${name}"></svg>`;
const helpers = (extra = {}) => ({ esc, icon, busy: false, draft: '', status: '', noteOpen: false, ...extra });

test('picture helpers enforce the six file, 10 MB, and supported type limits', () => {
  assert.equal(ATTACHMENT_LIMIT, 6);
  assert.equal(MAX_ATTACHMENT_BYTES, 10 * 1024 * 1024);
  assert.deepEqual([...SUPPORTED_ATTACHMENT_TYPES], ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']);
  assert.equal(attachmentFileError({ size: MAX_ATTACHMENT_BYTES, type: 'image/png' }), '');
  assert.match(attachmentFileError({ size: MAX_ATTACHMENT_BYTES + 1, type: 'image/png' }), /10 MB/);
  assert.match(attachmentFileError({ size: 1, type: 'image/svg+xml' }), /JPEG, PNG, WebP, GIF, HEIC or HEIF/);
});

test('strip state counts uploading, ready, and failed files and returns only ready ids', () => {
  const state = attachmentStripState([
    { key: 'one', name: 'one.png', status: 'uploading' },
    { key: 'two', name: 'two.png', status: 'ready', id: 'att_11111111111111111111111111111111' },
    { key: 'three', name: 'three.svg', status: 'failed', error: 'Unsupported picture type.' },
  ]);
  assert.equal(state.count, 3);
  assert.equal(state.canAdd, true);
  assert.equal(state.uploading, 1);
  assert.equal(state.ready, 1);
  assert.equal(state.failed, 1);
  assert.deepEqual(state.ids, ['att_11111111111111111111111111111111']);
  assert.equal(attachmentStripState(Array(6).fill({ status: 'ready', id: 'ready' })).canAdd, false);
});

test('attachment picker and strip markup keep an accessible 44 px control and stable keyed chips', () => {
  const picker = attachmentPickerHtml('chat:boss', icon, esc);
  const strip = attachmentStripHtml('chat:boss', [{ key: 'photo-1', name: 'photo.png', status: 'uploading' }], esc);
  assert.match(picker, /type="file"[^>]*accept="image\/\*"[^>]*multiple[^>]*hidden/);
  assert.doesNotMatch(picker, /\bcapture\b/);
  assert.match(picker, /aria-label="Attach a picture"/);
  assert.match(strip, /class="attachment-strip"[^>]*data-attachment-strip="chat:boss"/);
  assert.match(strip, /data-key="attachment:photo-1"/);
  assert.match(strip, /Uploading/);
  assert.match(strip, /data-attachment-remove="chat:boss:photo-1"/);
});

test('the Mailbox answer bar includes its keyed picture picker and strip', () => {
  const html = mailActionBarHtml({ id: 'q1', action: 'answer' }, helpers({ attachments: [] }));
  assert.match(html, /data-key="mail-bar:q1"/);
  assert.match(html, /data-attachment-open="mail-item:q1"/);
  assert.match(html, /data-attachment-input="mail-item:q1"/);
  assert.match(html, /data-attachment-strip="mail-item:q1"/);
  assert.match(html, /<textarea[^>]*data-mail-draft="q1"[^>]*>/);
});

test('the Chat composer renders a picture picker and strip above its field', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const composer = app.slice(app.indexOf('function chatConversationView()'), app.indexOf('\nfunction chatParseChoices('));
  assert.match(composer, /const attachmentContext = `chat:\$\{chat\.thread\}`;/);
  assert.match(composer, /attachmentStrip\(attachmentContext\)/);
  assert.match(composer, /attachmentPicker\(attachmentContext\)/);
  assert.ok(composer.indexOf('attachmentStrip(attachmentContext)') < composer.indexOf('chat-composer-row'), 'the strip is above the Chat field');
});
