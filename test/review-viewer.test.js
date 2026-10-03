// The item viewer of hosted review packs: the render of each item type, the answer bar, the key map,
// the next open item, the pin math, and the zoom math. public/review-viewer.js and public/review-zoom.js
// have no DOM use, so the tests import them directly.
import test from 'node:test';
import assert from 'node:assert/strict';

const viewer = await import('../public/review-viewer.js');
const zoom = await import('../public/review-zoom.js');
const {
  viewerKeyAction, nextOpenItem, itemNeighbors, sectionStep, addPin, removePin, setPinText, PIN_MAX, PIN_TEXT_MAX,
  itemViewerHtml, answerBarHtml, viewerBarHtml, parseCsv, diffLines, fileLines, fileUrl, liveLinks, itemSpec,
} = viewer;
const {
  ZOOM_MIN, ZOOM_MAX, clampScale, clampPan, zoomAt, doubleTap, fullScale, toggleFit, stepZoom, pinFraction, swipeIntent, transformCss,
} = zoom;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EVIL = '<img src=x onerror=alert(1)>"\'&';

function packWith(spec, answer = null, extra = {}) {
  const item = { id: spec.id, section: 'main', title: spec.title, type: spec.type, ask: spec.ask, state: 'open', stale: false, answer, ...extra };
  return {
    slug: 'shop', pack: 'checkout-redesign', title: 'Checkout', version: 2, state: 'open',
    manifest: { live: [{ label: 'Staging checkout', url: 'https://staging.example.test/checkout' }], sections: [{ id: 'main', title: 'Main', items: [spec] }] },
    items: [item],
    derived: { sections: [{ id: 'main', title: 'Main', state: 'open' }] },
  };
}

const helpers = (texts = {}) => ({ esc, text: (src) => texts[src] });
const render = (pack, ui = {}, texts = {}) => itemViewerHtml(pack, pack.items[0], ui, helpers(texts));
const bar = (pack, ui = {}) => answerBarHtml(pack, pack.items[0], ui, helpers());

// ---------- Key map ----------

test('the viewer keys move, answer, zoom, and go back, and a text field takes every key except Esc', () => {
  const expect = {
    j: 'next', ArrowRight: 'next', k: 'prev', ArrowLeft: 'prev', J: 'next-section', K: 'prev-section', n: 'next-open',
    a: 'accept', d: 'deny', l: 'live', c: 'note', p: 'pin', v: 'viewed', e: 'viewed-next', t: 'pair', z: 'fit',
    '+': 'zoom-in', '=': 'zoom-in', '-': 'zoom-out', s: 'summary', u: 'back', Escape: 'back', '?': 'help',
    1: 'pick-1', 6: 'pick-6',
  };
  for (const [key, action] of Object.entries(expect)) assert.equal(viewerKeyAction({ key }), action, key);
  assert.equal(viewerKeyAction({ key: '7' }), null);
  assert.equal(viewerKeyAction({ key: 'x' }), null);
  for (const mod of ['ctrlKey', 'metaKey', 'altKey']) assert.equal(viewerKeyAction({ key: 'a', [mod]: true }), null, mod);
  assert.equal(viewerKeyAction({ key: 'a', inField: true }), null);
  assert.equal(viewerKeyAction({ key: 'j', inField: true }), null);
  assert.equal(viewerKeyAction({ key: 'ArrowRight', inField: true }), null);
  assert.equal(viewerKeyAction({ key: 'Escape', inField: true }), 'leave-field');
});

// ---------- Item order ----------

const order = [
  { id: 'a1', section: 's1', state: 'accepted' },
  { id: 'a2', section: 's1', state: 'open' },
  { id: 'b1', section: 's2', state: 'denied' },
  { id: 'b2', section: 's2', state: 'open', stale: true },
  { id: 'c1', section: 's3', state: 'open' },
];

test('the next open item follows the current item and wraps to the start', () => {
  assert.equal(nextOpenItem(order, 'a1').id, 'a2');
  assert.equal(nextOpenItem(order, 'a2').id, 'b2');
  assert.equal(nextOpenItem(order, 'c1').id, 'a2', 'it wraps');
  assert.equal(nextOpenItem(order, 'nope').id, 'a2', 'an unknown item starts at the top');
  assert.equal(nextOpenItem([{ id: 'x', state: 'open' }], 'x'), null, 'the current item is not its own next');
  assert.equal(nextOpenItem(order.map((item) => ({ ...item, state: 'accepted' })), 'a1'), null);
});

test('the neighbors give the place of the item, and a section step goes to the first item of the next section', () => {
  assert.deepEqual(itemNeighbors(order, 'b1'), { index: 2, total: 5, prev: order[1], next: order[3] });
  assert.equal(itemNeighbors(order, 'a1').prev, null);
  assert.equal(itemNeighbors(order, 'c1').next, null);
  assert.equal(sectionStep(order, 'a2', 1).id, 'b1');
  assert.equal(sectionStep(order, 'b2', -1).id, 'a1');
  assert.equal(sectionStep(order, 'c1', 1), null);
  assert.equal(sectionStep(order, 'a1', -1), null);
});

// ---------- Pins ----------

test('a new pin takes the next number and stops at 20 pins', () => {
  let pins = [];
  pins = addPin(pins, { x: 0.25, y: 0.5, src: 'b' });
  assert.deepEqual(pins, [{ n: 1, x: 0.25, y: 0.5, src: 'b', text: '' }]);
  pins = addPin(pins, { x: 0.9, y: 0.1 });
  assert.equal(pins[1].n, 2);
  assert.equal(Object.hasOwn(pins[1], 'src'), false, 'a pin on a single image has no src');
  pins = removePin(pins, 1);
  assert.deepEqual(pins.map((pin) => pin.n), [2]);
  assert.equal(addPin(pins, { x: 0, y: 0 })[1].n, 3, 'a number is not used twice');
  assert.equal(PIN_MAX, 20);
  const full = Array.from({ length: PIN_MAX }, (_, i) => ({ n: i + 1, x: 0, y: 0 }));
  assert.equal(addPin(full, { x: 0.5, y: 0.5 }), null);
  assert.equal(addPin([], { x: 1.5, y: -2 })[0].x, 1, 'a fraction is clamped');
  assert.equal(addPin([], { x: 1.5, y: -2 })[0].y, 0);
  assert.equal(addPin([], { x: Number.NaN, y: 0.5 }), null, 'a pin needs a number');
});

test('a pin note is cut to the store limit and a missing pin changes nothing', () => {
  const pins = [{ n: 1, x: 0.1, y: 0.2, text: '' }];
  assert.equal(setPinText(pins, 1, 'Too faint')[0].text, 'Too faint');
  assert.equal(setPinText(pins, 1, 'x'.repeat(500))[0].text.length, PIN_TEXT_MAX);
  assert.equal(PIN_TEXT_MAX, 200);
  assert.deepEqual(setPinText(pins, 9, 'nothing'), pins);
});

test('a tap gives a pin as fractions of the image, and a tap outside the image gives no pin', () => {
  const rect = { left: 100, top: 50, width: 400, height: 200 };
  assert.deepEqual(pinFraction({ clientX: 300, clientY: 100 }, rect), { x: 0.5, y: 0.25 });
  assert.deepEqual(pinFraction({ clientX: 100, clientY: 250 }, rect), { x: 0, y: 1 });
  assert.deepEqual(pinFraction({ clientX: 233.33333, clientY: 50 }, rect), { x: 0.3333, y: 0 }, 'four decimals');
  assert.equal(pinFraction({ clientX: 99, clientY: 100 }, rect), null);
  assert.equal(pinFraction({ clientX: 300, clientY: 251 }, rect), null);
  assert.equal(pinFraction({ clientX: 300, clientY: 100 }, { left: 0, top: 0, width: 0, height: 0 }), null);
});

// ---------- Zoom ----------

const box = { width: 400, height: 600, contentWidth: 400, contentHeight: 300 };

test('the zoom stays from 1x to 8x, and a pan stays inside the zoomed image', () => {
  assert.equal(ZOOM_MIN, 1);
  assert.equal(ZOOM_MAX, 8);
  assert.equal(clampScale(0.2), 1);
  assert.equal(clampScale(30), 8);
  assert.equal(clampScale(Number.NaN), 1);
  assert.deepEqual(clampPan({ scale: 1, x: 50, y: -40 }, box), { scale: 1, x: 0, y: 0 });
  // At 2x the image is 800 x 600: 200 px spare on each side, and no spare height in a 600 px stage.
  assert.deepEqual(clampPan({ scale: 2, x: 500, y: 90 }, box), { scale: 2, x: 200, y: 0 });
  assert.deepEqual(clampPan({ scale: 2, x: -500, y: 0 }, box), { scale: 2, x: -200, y: 0 });
});

test('a zoom keeps the point under the finger, and a double tap toggles 2x and fit', () => {
  const view = zoomAt({ scale: 1, x: 0, y: 0 }, 2, { x: 100, y: 0 }, box);
  assert.deepEqual(view, { scale: 2, x: -100, y: 0 });
  assert.deepEqual(zoomAt(view, 1, { x: 0, y: 0 }, box), { scale: 1, x: 0, y: 0 });
  assert.deepEqual(zoomAt(view, 50, { x: 0, y: 0 }, box).scale, 8);
  assert.deepEqual(doubleTap({ scale: 1, x: 0, y: 0 }, { x: -100, y: 0 }, box), { scale: 2, x: 100, y: 0 });
  assert.deepEqual(doubleTap({ scale: 3, x: 40, y: 0 }, { x: 0, y: 0 }, box), { scale: 1, x: 0, y: 0 });
});

test('100 percent shows one image pixel for one screen pixel, and z toggles it with fit', () => {
  assert.equal(fullScale({ naturalWidth: 1600 }, box), 4);
  assert.equal(fullScale({ naturalWidth: 20000 }, box), 8, 'clamped to 8x');
  assert.equal(fullScale({ naturalWidth: 200 }, box), 1, 'a small image stays at fit');
  assert.equal(fullScale({ naturalWidth: 0 }, box), 1);
  assert.equal(toggleFit({ scale: 1, x: 0, y: 0 }, { naturalWidth: 1600 }, box).scale, 4);
  assert.deepEqual(toggleFit({ scale: 4, x: 30, y: 0 }, { naturalWidth: 1600 }, box), { scale: 1, x: 0, y: 0 });
  assert.equal(stepZoom({ scale: 1, x: 0, y: 0 }, 1, box).scale, 1.5);
  assert.equal(stepZoom({ scale: 1, x: 0, y: 0 }, -1, box).scale, 1);
  assert.equal(stepZoom({ scale: 7, x: 0, y: 0 }, 1, box).scale, 8);
  assert.equal(transformCss({ scale: 2, x: -100, y: 5 }), 'translate(-100px, 5px) scale(2)');
});

test('a swipe at fit moves between items, a swipe down goes back, and a zoomed swipe pans', () => {
  assert.equal(swipeIntent({ dx: -80, dy: 10, scale: 1 }), 'next');
  assert.equal(swipeIntent({ dx: 80, dy: -10, scale: 1 }), 'prev');
  assert.equal(swipeIntent({ dx: 30, dy: 0, scale: 1 }), null, 'too short');
  assert.equal(swipeIntent({ dx: 70, dy: 60, scale: 1 }), null, 'not horizontal enough');
  assert.equal(swipeIntent({ dx: -80, dy: 0, scale: 1.5 }), null, 'a zoomed swipe pans');
  assert.equal(swipeIntent({ dx: 5, dy: 120, scale: 1, down: true }), 'back');
  assert.equal(swipeIntent({ dx: 5, dy: 120, scale: 1 }), null, 'swipe down only where the stage allows it');
});

// ---------- Item types ----------

test('an image renders with its file URL, alt text, zoom stage, pins, and hint', () => {
  const spec = { id: 'hero', title: 'Hero', type: 'image', src: 'img/hero shot.png', alt: 'The hero', ask: ['accept', 'deny', 'note'] };
  const pack = packWith(spec, { note: '', pins: [{ n: 1, x: 0.5, y: 0.25, text: 'Too faint' }], rev: 1 });
  const html = render(pack, { hint: true });
  assert.match(html, /<img[^>]* src="\/api\/reviews\/shop\/checkout-redesign\/files\/2\/img\/hero%20shot\.png"/);
  assert.match(html, /alt="The hero"/);
  assert.match(html, /decoding="async"/);
  assert.match(html, /class="rv-stage"[^>]*data-rv-stage="hero"/);
  assert.match(html, /data-keep-attrs="style"/, 'the zoom transform survives a keyed render');
  assert.match(html, /class="rv-pin"[^>]*style="left: 50%; top: 25%"[^>]*>1</);
  assert.match(html, /Pinch to zoom · double tap for 2×/);
  assert.match(html, /value="Too faint"/, 'the pin note field');
  assert.match(html, /maxlength="200"/);
});

test('an image pair has a toggle with the manifest labels, a split slider, and pins on each side', () => {
  const spec = { id: 'cart', title: 'Cart', type: 'image-pair', variant: 'theme', a: { src: 'a.png', label: 'Light' }, b: { src: 'b.png', label: 'Dark' }, ask: ['accept', 'note'] };
  const pack = packWith(spec, { note: '', pins: [{ n: 1, x: 0.1, y: 0.2, src: 'a' }, { n: 2, x: 0.3, y: 0.4, src: 'b' }], rev: 1 });
  const html = render(pack, { pair: 'b' });
  assert.match(html, /role="group" aria-label="Pair"/);
  assert.match(html, /data-rv-pair="a"[^>]*aria-pressed="false"[^>]*>Light</);
  assert.match(html, /data-rv-pair="b"[^>]*aria-pressed="true"[^>]*>Dark</);
  assert.match(html, /data-rv-mode="split" aria-pressed="false">[^]*?<span>Slider</);
  assert.match(html, /class="rv-canvas rv-show-b"/);
  assert.match(html, /src="\/api\/reviews\/shop\/checkout-redesign\/files\/2\/a\.png"[^>]*alt="Light"/);
  assert.match(html, /data-src="a"[^>]*>1</);
  assert.match(html, /data-src="b"[^>]*>2</);
  const split = render(pack, { pairMode: 'split', split: 30 });
  assert.match(split, /data-rv-stage="cart"[^>]*style="--rv-split: 30%"/, 'the split sits on the stage, so the zoom style of the canvas stays');
  assert.match(split, /class="rv-canvas rv-split"/);
  assert.match(split, /type="range"[^>]*data-rv-split[^>]*value="30"/);
  assert.match(split, /aria-label="Split between Light and Dark"/);
});

test('a gallery shows a grid of buttons, and an open image has the same stage with next and previous', () => {
  const spec = { id: 'shots', title: 'Shots', type: 'gallery', images: [{ src: 'g/1.png', alt: 'One', caption: 'First' }, { src: 'g/2.png', alt: 'Two' }, { src: 'g/3.png' }], ask: ['accept'] };
  const pack = packWith(spec);
  const grid = render(pack);
  assert.equal((grid.match(/data-rv-open=/g) || []).length, 3);
  assert.match(grid, /loading="lazy"/);
  assert.match(grid, /First/);
  const one = render(pack, { gallery: 1 });
  assert.match(one, /data-rv-stage="shots:1"/);
  assert.match(one, /src="\/api\/reviews\/shop\/checkout-redesign\/files\/2\/g\/2\.png"/);
  assert.match(one, /2 of 3/);
  assert.match(one, /data-rv-gallery="0"[^>]*aria-label="Previous image"/);
  assert.match(one, /data-rv-gallery="2"[^>]*aria-label="Next image"/);
  assert.match(one, /data-rv-gallery="grid"/);
  assert.match(one, /alt="Image 2 of 3: Two"/);
});

test('a video uses the native player with the file route, the poster, and no autoplay', () => {
  const spec = { id: 'flow', title: 'Flow', type: 'video', src: 'media/flow.mp4', poster: 'media/flow.png', ask: ['accept', 'deny', 'live'] };
  const html = render(packWith(spec));
  assert.match(html, /<video[^>]* controls[^>]* preload="metadata"[^>]* playsinline[^>]*src="\/api\/reviews\/shop\/checkout-redesign\/files\/2\/media\/flow\.mp4"[^>]*poster="\/api\/reviews\/shop\/checkout-redesign\/files\/2\/media\/flow\.png"/);
  assert.doesNotMatch(html, /autoplay/);
});

test('markdown text goes through the sanitizer: raw HTML is text, and an external link opens a new tab and is marked', () => {
  const spec = { id: 'intro', title: 'Intro', type: 'markdown', text: '# Title\n\n<script>alert(1)</script> [docs](https://example.test/docs) [bad](javascript:alert(1))\n\n| a | b |\n|---|---|\n| 1 | 2 |', ask: ['note'] };
  const html = render(packWith(spec));
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<a href="https:\/\/example\.test\/docs" target="_blank" rel="noopener noreferrer">docs<\/a>/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /class="md rv-md"/);
  assert.match(html, /class="md-table" role="region"/, 'a table scrolls in its own box');
});

test('a body from a file loads through the text helper and shows a plain loading line first', () => {
  const spec = { id: 'notes', title: 'Notes', type: 'markdown', body: { src: 'notes.md' }, ask: ['note'] };
  const pack = packWith(spec);
  assert.match(render(pack), /data-rv-text="\/api\/reviews\/shop\/checkout-redesign\/files\/2\/notes\.md"/);
  assert.match(render(pack), /Loading the text…/);
  const url = '/api/reviews/shop/checkout-redesign/files/2/notes.md';
  assert.match(render(pack, {}, { [url]: { text: 'Hello **there**' } }), /Hello <strong>there<\/strong>/);
  assert.match(render(pack, {}, { [url]: { error: 'The file does not exist.' } }), /role="alert"[^>]*>The text could not load\. The file does not exist\./);
});

test('a table has a sticky header and scrolls sideways in its own box, from rows or from a CSV file', () => {
  const inline = { id: 'errs', title: 'Errors', type: 'table', columns: ['Code', 'Text'], rows: [['E1', 'Card declined'], ['E2', EVIL]], ask: ['accept'] };
  const html = render(packWith(inline));
  assert.match(html, /<div class="rv-table" role="region" aria-label="Table: Errors" tabindex="0"><table><thead><tr><th scope="col">Code<\/th>/);
  assert.match(html, /<td>Card declined<\/td>/);
  assert.doesNotMatch(html, /<img src=x/);
  const csv = { id: 'csv', title: 'CSV', type: 'table', src: 'data/e.csv', ask: ['accept'] };
  const url = '/api/reviews/shop/checkout-redesign/files/2/data/e.csv';
  const fromFile = render(packWith(csv), {}, { [url]: { text: 'code,text\nE1,"Declined, try again"\nE2,"Say ""hi"""\n' } });
  assert.match(fromFile, /<th scope="col">code<\/th><th scope="col">text<\/th>/);
  assert.match(fromFile, /<td>Declined, try again<\/td>/);
  assert.match(fromFile, /<td>Say &quot;hi&quot;<\/td>/);
});

test('the CSV parser reads quotes, commas, line ends, and a missing last line end', () => {
  assert.deepEqual(parseCsv('a,b\r\n1,"x\ny"\n2,3'), [['a', 'b'], ['1', 'x\ny'], ['2', '3']]);
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('a,,c\n'), [['a', '', 'c']]);
});

test('a diff shows added, removed, and hunk lines with line numbers, in plain monospace', () => {
  const text = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -10,3 +10,3 @@ intro\n same\n-old <b>\n+new\n';
  const lines = diffLines(text);
  assert.deepEqual(lines.map((line) => line.kind), ['meta', 'meta', 'meta', 'hunk', 'same', 'del', 'add']);
  assert.deepEqual(lines.slice(4).map((line) => [line.old, line.new]), [[10, 10], [11, null], [null, 11]]);
  const html = render(packWith({ id: 'd', title: 'D', type: 'diff', src: 'x.diff', ask: ['accept'] }), {}, { '/api/reviews/shop/checkout-redesign/files/2/x.diff': { text } });
  assert.match(html, /class="rv-code rv-diff" role="region" aria-label="Diff: D" tabindex="0"/);
  assert.match(html, /class="rv-line rv-del" data-copy-prefix="-"><span class="rv-ln">11<\/span><span class="rv-ln"><\/span><span class="rv-mark">−<\/span><code>old &lt;b&gt;<\/code>/);
  assert.match(html, /class="rv-line rv-add" data-copy-prefix="\+">/);
  assert.doesNotMatch(html, /<b>/);
});

test('a file shows numbered lines in a scroll box and names its language', () => {
  assert.deepEqual(fileLines('a\nb\n'), ['a', 'b']);
  const spec = { id: 'f', title: 'Source', type: 'file', src: 'src/<x>.js', language: 'js', ask: ['accept'] };
  const url = '/api/reviews/shop/checkout-redesign/files/2/src/%3Cx%3E.js';
  const html = render(packWith(spec), {}, { [url]: { text: 'const a = "<b>";\nlet b;' } });
  assert.match(html, /src\/&lt;x&gt;\.js · js/, 'the file name is escaped');
  assert.match(html, /class="rv-line"><span class="rv-ln">1<\/span><code>const a = &quot;&lt;b&gt;&quot;;<\/code>/);
  assert.match(html, /<span class="rv-ln">2<\/span>/);
});

test('a live link has Open with noopener noreferrer and the needs live check action next to it', () => {
  const spec = { id: 'signup', title: 'Sign-up', type: 'link', url: 'https://staging.example.test/signup', label: 'Staging sign-up', ask: ['accept', 'live'] };
  const html = render(packWith(spec, { live: 'pending', rev: 1, note: '' }));
  assert.match(html, /<a class="rv-open" href="https:\/\/staging\.example\.test\/signup" target="_blank" rel="noopener noreferrer">Open<svg class="app-icon rv-open-icon"[^>]*aria-hidden="true"[^]*?<\/svg><span class="rv-open-note">\(opens in a new tab\)<\/span><\/a>/, 'the new tab is visible text next to the icon');
  assert.match(html, /staging\.example\.test/);
  assert.match(html, /Staging sign-up/);
  assert.match(html, /data-rv-live="done">[^]*?Checked<\/button>/);
  const bad = render(packWith({ ...spec, url: 'javascript:alert(1)' }));
  assert.doesNotMatch(bad, /href="javascript/);
});

test('a checklist has one tap target for each entry with its stored state', () => {
  const spec = { id: 'a11y', title: 'Checks', type: 'checklist', entries: [{ id: 'focus', text: 'Focus order' }, { id: 'labels', text: EVIL }], ask: ['accept'] };
  const html = render(packWith(spec, { checks: { focus: true }, rev: 1, note: '' }));
  assert.match(html, /<label class="rv-check"><input type="checkbox" data-rv-check="focus" checked>/);
  assert.match(html, /<label class="rv-check"><input type="checkbox" data-rv-check="labels">/);
  assert.doesNotMatch(html, /<img src=x/);
});

test('an unknown or custom type shows the text with a small note', () => {
  const spec = { id: 'odd', title: 'Odd', type: 'markdown', fallbackFrom: 'custom:heatmap', body: { text: 'Plain *text*' }, ask: ['note'] };
  const html = render(packWith(spec));
  assert.match(html, /Herdr Boss has no viewer for custom:heatmap\. It shows the text\./);
  assert.match(html, /Plain <em>text<\/em>/);
  const page = render(packWith({ id: 'p', title: 'P', type: 'page', src: 'p.html', ask: ['note'] }));
  assert.match(page, /Herdr Boss has no viewer for page\. It shows the text\./);
});

test('the item body shows under the evidence', () => {
  const spec = { id: 'hero', title: 'Hero', type: 'image', src: 'h.png', body: { text: 'The hero on a **390 px** screen.' }, ask: ['accept'] };
  assert.match(render(packWith(spec)), /class="md rv-md rv-body"><p>The hero on a <strong>390 px<\/strong> screen\.<\/p>/);
});

// ---------- Answer bar ----------

test('the answer bar has only the asked controls, and a decision shows as pressed', () => {
  const spec = { id: 'x', title: 'X', type: 'image', src: 'x.png', ask: ['accept', 'deny', 'note', 'live'] };
  const html = bar(packWith(spec, { decision: 'deny', live: null, note: 'Hi', rev: 1 }));
  assert.match(html, /data-rv-decision="deny"[^>]*aria-pressed="true"/);
  assert.match(html, /data-rv-decision="accept"[^>]*aria-pressed="false"/);
  assert.match(html, /data-rv-note-open/);
  assert.match(html, /data-rv-live="pending"/);
  const only = bar(packWith({ ...spec, ask: ['accept'] }));
  assert.match(only, /data-rv-decision="deny"/);
  assert.doesNotMatch(only, /data-rv-note-open/);
  assert.doesNotMatch(only, /data-rv-live/);
});

test('choices and a rating show in the bar with their labels and state', () => {
  const spec = { id: 'pay', title: 'Pay', type: 'image', src: 'p.png', ask: ['choice', 'rating', 'note'], choices: [{ id: 'a', label: 'Keep before' }, { id: 'b', label: EVIL }], rating: { max: 5 } };
  const html = bar(packWith(spec, { choice: 'b', rating: 3, note: '', rev: 2 }));
  assert.match(html, /data-rv-choice="a"[^>]*aria-pressed="false"[^>]*>.*Keep before/s);
  assert.match(html, /data-rv-choice="b"[^>]*aria-pressed="true"/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.equal((html.match(/data-rv-rating="/g) || []).length, 5);
  assert.match(html, /data-rv-rating="3"[^>]*aria-pressed="true"/);
  assert.match(html, /data-rv-rating="4"[^>]*aria-pressed="false"/);
  // Ask later is the one built-in decision. Accept and Deny need an entry in ask.
  assert.doesNotMatch(html, /data-rv-decision="(accept|deny)"/);
});

test('the note field is in the answer area, grows, has 16 px text in CSS, and shows the draft over the stored note', () => {
  const spec = { id: 'x', title: 'X', type: 'image', src: 'x.png', ask: ['accept', 'note'] };
  const pack = packWith(spec, { note: EVIL, rev: 1 });
  const html = bar(pack);
  assert.match(html, /<textarea id="rv-note-x" class="rv-note-field" data-rv-note maxlength="2000"/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(bar(pack, { note: 'Draft' }), />Draft<\/textarea>/);
  assert.doesNotMatch(bar(packWith(spec, { note: '', rev: 1 })), /<textarea/, 'no field until Note opens it or a note exists');
  assert.match(bar(packWith(spec, { note: '', rev: 1 }), { noteOpen: true }), /<textarea/);
});

test('the save state shows Saved, a plain error, or the conflict choice with the other answer', () => {
  const spec = { id: 'x', title: 'X', type: 'image', src: 'x.png', ask: ['accept', 'deny', 'note'] };
  const pack = packWith(spec, { decision: 'accept', note: '', rev: 3 });
  assert.match(render(pack, { status: 'Saved' }), /role="status">[^]*?Saved<\/p>/);
  assert.match(render(pack, { error: EVIL }), /Not saved\. &lt;img/);
  const conflict = render(pack, { conflict: { mine: { decision: 'deny' }, theirs: { decision: 'accept', note: EVIL, rev: 4 } } });
  assert.match(conflict, /Changed on another device/);
  assert.match(conflict, /data-rv-conflict="mine"[^>]*>Keep mine</);
  assert.match(conflict, /data-rv-conflict="theirs"[^>]*>Use theirs</);
  assert.match(conflict, /Accepted/);
  assert.doesNotMatch(conflict, /<img src=x/);
});

test('the live links come from the item and then from the pack', () => {
  const pack = packWith({ id: 'x', title: 'X', type: 'image', src: 'x.png', ask: ['live'], liveUrl: 'https://one.example.test/' });
  assert.deepEqual(liveLinks(pack, itemSpec(pack, 'x')).map((link) => link.url), ['https://one.example.test/']);
  const packOnly = packWith({ id: 'y', title: 'Y', type: 'image', src: 'y.png', ask: ['live'] });
  assert.deepEqual(liveLinks(packOnly, itemSpec(packOnly, 'y')).map((link) => link.label), ['Staging checkout']);
});

test('the top bar has one h1 with the title, the place, the section, and the Viewed toggle', () => {
  const spec = { id: 'x', title: EVIL, type: 'image', src: 'x.png', ask: ['accept'] };
  const pack = packWith(spec, { viewed: true, rev: 1, note: '' });
  const html = viewerBarHtml(pack, pack.items[0], helpers());
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.match(html, /Item 1 of 1<\/span> · Main/);
  assert.match(html, /aria-label="Viewed"[^>]*aria-pressed="true"/);
  assert.match(html, /href="\/reviews\/shop\/checkout-redesign#item=x"[^>]*aria-label="Back to the sections"/);
  assert.doesNotMatch(html, /<img src=x/);
});

test('every interpolated value in the viewer is escaped: file names, alt texts, captions, labels, notes, and pin notes', () => {
  const specs = [
    { id: 'i', title: EVIL, type: 'image', src: `img/${EVIL}.png`, alt: EVIL, body: { text: EVIL }, ask: ['note'] },
    { id: 'p', title: EVIL, type: 'image-pair', variant: 'compare', a: { src: 'a.png', label: EVIL, alt: EVIL }, b: { src: 'b.png', label: EVIL }, ask: ['note'] },
    { id: 'g', title: EVIL, type: 'gallery', images: [{ src: `${EVIL}.png`, alt: EVIL, caption: EVIL }, { src: 'b.png' }], ask: ['note'] },
    { id: 'v', title: EVIL, type: 'video', src: `${EVIL}.mp4`, poster: `${EVIL}.png`, ask: ['note'] },
    { id: 'l', title: EVIL, type: 'link', url: 'https://x.example.test/?q="><img', label: EVIL, ask: ['live', 'note'] },
    { id: 'k', title: EVIL, type: 'checklist', entries: [{ id: 'e', text: EVIL }], ask: ['note'] },
    { id: 'm', title: EVIL, type: 'markdown', fallbackFrom: EVIL, body: { text: EVIL }, ask: ['note'] },
  ];
  for (const spec of specs) {
    const pack = packWith(spec, { note: EVIL, pins: [{ n: 1, x: 0.5, y: 0.5, text: EVIL, src: EVIL }], rev: 1 });
    for (const ui of [{}, { gallery: 0, note: EVIL, error: EVIL }]) {
      const html = itemViewerHtml(pack, pack.items[0], ui, helpers()) + answerBarHtml(pack, pack.items[0], ui, helpers()) + viewerBarHtml(pack, pack.items[0], helpers());
      assert.doesNotMatch(html, /<img src=x/, spec.type);
      assert.doesNotMatch(html, /"><img src=x/, spec.type);
    }
  }
});

test('the file URL encodes each path part and keeps the slashes', () => {
  assert.equal(fileUrl({ slug: 'shop', pack: 'p', version: 3 }, 'a b/c#d.png'), '/api/reviews/shop/p/files/3/a%20b/c%23d.png');
});

test('a live row link also names the new tab in visible text', () => {
  const spec = { id: 'x', title: 'X', type: 'image', src: 'x.png', ask: ['live'] };
  const html = render(packWith(spec));
  assert.match(html, /<a class="rv-open" href="https:\/\/staging\.example\.test\/checkout" target="_blank" rel="noopener noreferrer">Staging checkout<svg[^]*?<span class="rv-open-note">\(opens in a new tab\)<\/span><\/a>/);
});

test('a field with a running save shows busy and stays enabled', () => {
  const spec = { id: 'x', title: 'X', type: 'image', src: 'x.png', ask: ['accept', 'deny', 'note', 'live', 'choice', 'rating'], choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], rating: { max: 3 } };
  const pack = packWith(spec, { decision: 'accept', note: '', rev: 1 });
  const idle = bar(pack, {});
  assert.doesNotMatch(idle, /aria-busy/);
  const busy = bar(pack, { pending: { decision: 1, note: 1 } });
  assert.match(busy, /data-rv-decision="accept" aria-pressed="true" aria-busy="true">/);
  assert.match(busy, /data-rv-decision="deny" aria-pressed="false" aria-busy="true">/);
  assert.match(busy, /data-rv-note-open aria-expanded="false" aria-busy="true">/);
  assert.doesNotMatch(busy, /data-rv-live="pending"[^>]*aria-busy/);
  assert.doesNotMatch(busy, /aria-busy="true" disabled/, 'busy never disables, so the focus stays');
  assert.match(bar(pack, { pending: { choice: 1 } }), /data-rv-choice="a" aria-pressed="false" aria-busy="true">/);
  assert.match(bar(pack, { pending: { rating: 1 } }), /data-rv-rating="1"[^>]*aria-busy="true">/);
});

test('the item heading is the focus target after a move: focusable by script, not in the tab order', () => {
  const spec = { id: 'x', title: 'X', type: 'image', src: 'x.png', ask: ['accept'] };
  const pack = packWith(spec);
  assert.match(viewerBarHtml(pack, pack.items[0], helpers()), /<h1 class="review-title" tabindex="-1" data-rv-heading title="[^"]*">/);
});

test('markdown goes through the page renderer before the string is built, and the string has no script or event attribute', () => {
  const hostile = '<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1)) <a href="#" onclick="alert(1)">y</a>';
  const specs = [
    { id: 'm', title: 'M', type: 'markdown', text: hostile, ask: ['note'] },
    { id: 'b', title: 'B', type: 'image', src: 'b.png', body: { text: hostile }, ask: ['note'] },
    { id: 'c', title: 'C', type: 'markdown', fallbackFrom: 'custom:x', body: { text: hostile }, ask: ['note'] },
  ];
  for (const spec of specs) {
    const seen = [];
    const html = itemViewerHtml(packWith(spec), packWith(spec).items[0], {}, { esc, text: () => undefined, markdown: (text) => { seen.push(text); return '<p>SANITIZED</p>'; } });
    assert.deepEqual(seen, [hostile], `${spec.id}: the page renderer gets the text`);
    assert.match(html, /<div class="md rv-md[^"]*"><p>SANITIZED<\/p><\/div>/);
    const plain = render(packWith(spec));
    assert.doesNotMatch(plain, /<script/i, spec.id);
    assert.doesNotMatch(plain, /<[a-z][^>]*\son[a-z]+\s*=/i, `${spec.id}: no event attribute on a tag`);
    assert.doesNotMatch(plain, /href="javascript:/i);
  }
});

// ---------- PS1: recommended choice and ask later ----------

test('the choice that the pack marks as recommended shows one Recommended badge, and no other choice does', () => {
  const spec = { id: 'one', title: 'One', type: 'markdown', text: 'x', ask: ['choice', 'note'], choices: [{ id: 'a', label: 'Keep before' }, { id: 'b', label: 'Use after', recommended: true }, { id: 'c', label: 'Neither' }] };
  const html = bar(packWith(spec));
  assert.equal((html.match(/rv-recommended/g) || []).length, 1);
  const choice = (id) => new RegExp(`<button[^>]*data-rv-choice="${id}"[^>]*>[\\s\\S]*?</button>`).exec(html)[0];
  assert.match(choice('b'), /rv-recommended[^>]*>Recommended</);
  assert.ok(!/Recommended/.test(choice('a')) && !/Recommended/.test(choice('c')));
  const plain = bar(packWith({ ...spec, choices: spec.choices.map(({ recommended, ...rest }) => rest) }));
  assert.ok(!/Recommended/.test(plain));
});

test('the badge text of a recommended choice is escaped like the label', () => {
  const spec = { id: 'one', title: 'One', type: 'markdown', text: 'x', ask: ['choice'], choices: [{ id: 'a', label: EVIL, recommended: true }, { id: 'b', label: 'B' }] };
  const html = bar(packWith(spec));
  assert.ok(!html.includes('<img'), 'no raw tag from the label');
});

test('the answer bar always offers Ask later, and the button shows its pressed state', () => {
  for (const ask of [['accept', 'deny', 'note'], ['choice'], ['note']]) {
    const spec = { id: 'one', title: 'One', type: 'markdown', text: 'x', ask, ...(ask.includes('choice') ? { choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } : {}) };
    const html = bar(packWith(spec));
    assert.match(html, /data-rv-decision="skip"[^>]*aria-pressed="false"/, ask.join());
    assert.match(html, /Ask later/);
  }
  const spec = { id: 'one', title: 'One', type: 'markdown', text: 'x', ask: ['accept'] };
  assert.match(bar(packWith(spec, { decision: 'skip', note: '', pins: [], rev: 1 })), /data-rv-decision="skip"[^>]*aria-pressed="true"/);
  const closed = packWith(spec);
  closed.state = 'submitted';
  assert.match(bar(closed), /data-rv-decision="skip"[^>]*disabled/);
});

test('the key b asks later, and the other keys keep their action', () => {
  assert.equal(viewerKeyAction({ key: 'b' }), 'skip');
  assert.equal(viewerKeyAction({ key: 'b', inField: true }), null);
  assert.equal(viewerKeyAction({ key: 'b', ctrlKey: true }), null);
  assert.equal(viewerKeyAction({ key: 'a' }), 'accept');
});

test('the copy of a diff gives back the source diff: markers kept, line numbers dropped', async () => {
  const { copySource } = await import('../public/copy.js');
  const text = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -10,3 +10,3 @@ intro\n same\n-old <b>\n+new\n\\ No newline at end of file\n';
  const html = render(packWith({ id: 'd', title: 'D', type: 'diff', src: 'x.diff', ask: ['accept'] }), {}, { '/api/reviews/shop/checkout-redesign/files/2/x.diff': { text } });
  const unescape = (value) => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const rows = [...html.matchAll(/<div class="rv-line[^"]*"(?: data-copy-prefix="([^"]*)")?>[^]*?<code>([^]*?)<\/code><\/div>/g)].map((m) => ({ getAttribute: (k) => (k === 'data-copy-prefix' ? m[1] ?? null : null), querySelector: () => ({ textContent: unescape(m[2]) }) }));
  const scope = { querySelector: () => ({ querySelectorAll: () => rows }) };
  const button = { hasAttribute: (k) => k === 'data-copy-lines', closest: () => scope };
  assert.equal(copySource(button), text.trimEnd());
});
