// The answer area of a review item: option cards, the order of the controls, and the resizable width on a desktop.
import test from 'node:test';
import { readUserGuide } from './helpers/user-guide.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { answerBarHtml } from '../public/review-viewer.js';
import { packPageHtml } from '../public/review.js';
import {
  ANSWER_KEY, ANSWER_MIN, ANSWER_DEFAULT, answerMax, clampAnswer, keyAnswer, loadAnswerWidth, createAnswerWidth, answerHandleHtml,
} from '../public/review-answer.js';

const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const guide = readUserGuide();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const helpers = () => ({ esc, text: () => undefined, avatar: () => '', projectLabel: (s) => s, time: () => '08:12', menuButton: '' });

const spec = {
  id: 'host', title: 'Host', type: 'markdown', text: 'x', ask: ['choice', 'note'],
  choices: [
    { id: 'a', label: 'A. One machine', consequence: 'Client code stays on one host.', recommended: true },
    { id: 'b', label: 'B. Two machines' },
  ],
};
function packWith(answer = null) {
  const item = { id: spec.id, section: 'main', title: spec.title, type: spec.type, ask: spec.ask, state: 'open', stale: false, answer };
  return {
    slug: 'shop', pack: 'r2', title: 'R2', version: 1, state: 'open',
    manifest: { sections: [{ id: 'main', title: 'Main', items: [spec] }] }, items: [item],
    derived: { sections: [{ id: 'main', title: 'Main', state: 'open' }], counts: { items: 1, open: 1 } },
  };
}
const bar = (answer, ui = {}) => { const pack = packWith(answer); return answerBarHtml(pack, pack.items[0], ui, helpers()); };

test('a choice is a card with a radio mark, the label, the consequence and the badge', () => {
  const html = bar(null);
  const card = /<button[^>]*data-rv-choice="a"[^>]*>[\s\S]*?<\/button>/.exec(html)[0];
  assert.match(card, /class="rv-radio"[^>]*aria-hidden="true"/);
  assert.match(card, /class="rv-choice-label"[^>]*>A\. One machine</);
  assert.match(card, /class="rv-choice-text"[^>]*>Client code stays on one host\.</);
  assert.match(card, /rv-recommended[^>]*>Recommended</);
  assert.match(card, /aria-pressed="false"/);
  assert.doesNotMatch(/<button[^>]*data-rv-choice="b"[^>]*>[\s\S]*?<\/button>/.exec(html)[0], /rv-choice-text/);
  assert.match(bar({ choice: 'a', rev: 1 }), /data-rv-choice="a"[^>]*aria-pressed="true"/);
});

test('the consequence text is escaped', () => {
  const evil = packWith();
  evil.manifest.sections[0].items[0] = { ...spec, choices: [{ id: 'a', label: 'A', consequence: '<img src=x>' }, { id: 'b', label: 'B' }] };
  const html = answerBarHtml(evil, evil.items[0], {}, helpers());
  assert.ok(!html.includes('<img'));
});

test('Ask later and the note field follow the options in the answer area', () => {
  const html = bar({ note: 'Why', rev: 1 });
  const at = (needle) => html.indexOf(needle);
  assert.ok(at('class="rv-choices"') >= 0 && at('class="rv-later"') > at('class="rv-choices"'));
  assert.ok(at('data-rv-note maxlength') > at('class="rv-later"'), 'the note field sits below Ask later');
  assert.match(html, /<textarea id="rv-note-host" class="rv-note-field" data-rv-note/);
});

test('the choice cards are one column, 48 px tall, and 2 columns above 1100 px in the desktop answer area', () => {
  assert.match(css, /#app \.rv-choice \{[^}]*min-height: 48px/);
  assert.match(css, /\.rv-choices \{[^}]*flex-direction: column;[^}]*gap: 8px/);
  const wide = /@media \(min-width: 1101px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] || '';
  assert.match(wide, /@container \(min-width: 600px\)/, 'two columns need an area of 600 px');
  assert.match(wide, /\.review-page\.item-open \.rv-answer \.rv-choices \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /#app \.rv-choice:focus-visible \{[^}]*outline: 2px solid var\(--accent\)/);
  assert.match(css, /#app \.rv-choice\[aria-pressed="true"\] \.rv-radio/);
  assert.doesNotMatch(css, /\.rv-choice-label \{[^}]*text-overflow: ellipsis/);
});

test('the answer width has a minimum of 280 px and a maximum of 60 % of the viewport', () => {
  assert.equal(ANSWER_MIN, 280);
  assert.equal(answerMax(1280), 768);
  assert.equal(clampAnswer(100, 1280), 280);
  assert.equal(clampAnswer(2000, 1280), 768);
  assert.equal(clampAnswer(400, 1280), 400);
  assert.equal(clampAnswer('x', 1280), ANSWER_DEFAULT);
  assert.equal(answerMax(300), 280, 'a narrow viewport keeps the minimum');
  assert.equal(keyAnswer(400, 'ArrowLeft', 1280), 416);
  assert.equal(keyAnswer(400, 'ArrowRight', 1280), 384);
  assert.equal(keyAnswer(400, 'Home', 1280), ANSWER_DEFAULT);
  assert.equal(keyAnswer(400, 'a', 1280), null);
});

test('the width is stored per browser, a broken storage does not throw, and a reset restores the default', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const seen = [];
  const answer = createAnswerWidth({ storage, viewport: () => 1280, apply: (w) => seen.push(w) });
  answer.resize(500);
  assert.equal(JSON.parse(store.get(ANSWER_KEY)).width, 500);
  assert.equal(loadAnswerWidth(storage), 500);
  assert.equal(createAnswerWidth({ storage, viewport: () => 1280 }).get(), 500);
  answer.resize(450, false);
  assert.equal(JSON.parse(store.get(ANSWER_KEY)).width, 500, 'a drag stores only at its end');
  answer.reset();
  assert.equal(answer.get(), ANSWER_DEFAULT);
  assert.equal(loadAnswerWidth(storage), ANSWER_DEFAULT);
  const broken = { getItem() { throw new Error('off'); }, setItem() { throw new Error('off'); } };
  assert.equal(loadAnswerWidth(broken), ANSWER_DEFAULT);
  assert.doesNotThrow(() => createAnswerWidth({ storage: broken, viewport: () => 1280 }).resize(400));
  assert.equal(loadAnswerWidth({ getItem: () => '{bad' }), ANSWER_DEFAULT);
});

test('the handle is a focusable separator and the page sets the width variable', () => {
  const handle = answerHandleHtml(400, 1280);
  assert.match(handle, /role="separator"[^>]*tabindex="0"[^>]*data-review-answer-resize/);
  assert.match(handle, /aria-valuemin="280"[^>]*aria-valuemax="768"[^>]*aria-valuenow="400"/);
  const pack = packWith();
  const page = packPageHtml(pack, { item: 'host', answerWidth: 420, sidebar: { viewport: 1280 } }, helpers());
  assert.match(page, /--review-answer: 420px/);
  assert.match(page, /data-review-answer-resize/);
  assert.doesNotMatch(packPageHtml(pack, {}, helpers()), /data-review-answer-resize/, 'no handle on the item list');
  assert.match(css, /\.review-resize, \.review-answer-resize, \.review-side-bar \{ display: none/);
  assert.match(css, /\.review-page\.item-open \{[^}]*grid-template-columns: minmax\(0, 1fr\) var\(--review-answer, 400px\)/);
});

test('app.js wires the drag, the double-click reset and the HELP text', () => {
  assert.match(app, /createAnswerWidth/);
  assert.match(app, /addEventListener\('dblclick'/);
  assert.match(app, /\[data-review-answer-resize\]/);
  assert.match(app, /Drag the handle at the left edge of the answer area/);
  assert.ok(guide.includes('Drag the handle at the left edge of the answer area'));
  assert.ok(guide.includes('`consequence`'));
});
