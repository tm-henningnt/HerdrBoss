import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDocument, find } from './fake-dom.js';

const {
  buildDraftShares, draftSignature, shareTotal, distributeRemainder, checkSave, confirmText, totalHtml, moveShares, allocationFooterHtml, staleRowHtml,
} = await import('../public/allocation-draft.js');
const { patchHtml } = await import('../public/keyed.js');
const draftSource = fs.readFileSync(new URL('../public/allocation-draft.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

const SLUGS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
const policyOf = (shares) => Object.fromEntries(Object.entries(shares).map(([slug, share]) => [slug, { share, mode: 'auto', excludedKinds: [], excludedModels: [] }]));
const P99 = policyOf({ alpha: 9, beta: 36, gamma: 31, delta: 13, epsilon: 10 });

test('a policy of 5 projects with total 99 shows exactly its shares, not an equal split', () => {
  const draft = buildDraftShares(SLUGS, P99);
  assert.deepEqual(draft.shares, { alpha: 9, beta: 36, gamma: 31, delta: 13, epsilon: 10 });
  assert.deepEqual(draft.defaults, []);
  assert.equal(draft.sum, 99);
});

test('a total below 100 and a total of 100 keep every saved share', () => {
  assert.deepEqual(buildDraftShares(['a', 'b'], policyOf({ a: 10, b: 20 })).shares, { a: 10, b: 20 });
  assert.deepEqual(buildDraftShares(['a', 'b'], policyOf({ a: 60, b: 40 })).shares, { a: 60, b: 40 });
});

test('a total above 100 is shown as it is', () => {
  const draft = buildDraftShares(['a', 'b'], policyOf({ a: 70, b: 50 }));
  assert.deepEqual(draft.shares, { a: 70, b: 50 });
  assert.equal(draft.sum, 120);
});

test('a sixth project that has no policy entry gets a default only for itself', () => {
  const draft = buildDraftShares([...SLUGS, 'zeta'], P99);
  assert.deepEqual(draft.shares, { alpha: 9, beta: 36, gamma: 31, delta: 13, epsilon: 10, zeta: 1 });
  assert.deepEqual(draft.defaults, ['zeta']);
});

test('missing projects split the remaining room, and get 0 when there is none', () => {
  const two = buildDraftShares(['a', 'b', 'c', 'd'], policyOf({ a: 50, b: 41 }));
  assert.deepEqual(two.shares, { a: 50, b: 41, c: 5, d: 4 });
  assert.deepEqual(two.defaults, ['c', 'd']);
  const none = buildDraftShares(['a', 'b'], policyOf({ a: 100 }));
  assert.deepEqual(none.shares, { a: 100, b: 0 });
  assert.deepEqual(none.defaults, ['b']);
});

test('a project that the state no longer lists has no share in the form', () => {
  const draft = buildDraftShares(['a'], policyOf({ a: 30, gone: 20 }));
  assert.deepEqual(draft.shares, { a: 30 });
});

test('the signature changes when the project set or a saved share changes', () => {
  const base = draftSignature(SLUGS, P99);
  assert.equal(draftSignature(SLUGS, structuredClone(P99)), base);
  assert.notEqual(draftSignature([...SLUGS, 'zeta'], P99), base);
  assert.notEqual(draftSignature(SLUGS, policyOf({ alpha: 10, beta: 36, gamma: 31, delta: 13, epsilon: 10 })), base);
});

test('Distribute the remaining adds the remainder to the largest share only', () => {
  const shares = { alpha: 9, beta: 36, gamma: 31, delta: 13, epsilon: 10 };
  const out = distributeRemainder(shares, SLUGS);
  assert.deepEqual(out, { alpha: 9, beta: 37, gamma: 31, delta: 13, epsilon: 10 });
  assert.equal(shareTotal(out, SLUGS), 100);
  assert.deepEqual(shares.beta, 36, 'the input is not changed');
  assert.deepEqual(distributeRemainder(out, SLUGS), out, 'nothing to distribute at 100');
  assert.deepEqual(distributeRemainder({ a: 20, b: 20 }, ['a', 'b']), { a: 80, b: 20 }, 'the first of equal shares wins');
});

test('the total line shows the sum and offers the button only below 100', () => {
  const below = totalHtml(99);
  assert.match(below, /Total 99 of 100/);
  assert.match(below, /data-distribute-remaining[^>]*>Distribute the remaining 1</);
  const full = totalHtml(100);
  assert.match(full, /Total 100 of 100/);
  assert.doesNotMatch(full, /Distribute/);
  const over = totalHtml(120);
  assert.match(over, /Total 120 of 100/);
  assert.match(over, /role="alert"/);
  assert.doesNotMatch(over, /Distribute/);
});

const base = (over = {}) => {
  const loaded = over.loaded || P99;
  const draft = buildDraftShares(over.slugs || SLUGS, loaded);
  return { slugs: SLUGS, loaded, shares: draft.shares, defaults: draft.defaults, touched: [], boundaries: 0, otherChanged: false, ...over };
};

test('the save refuses when a share differs only because of a display default', () => {
  const slugs = [...SLUGS, 'zeta'];
  const draft = buildDraftShares(slugs, P99);
  const result = checkSave({ slugs, loaded: P99, shares: draft.shares, defaults: draft.defaults, touched: [], boundaries: 0, otherChanged: false });
  assert.equal(result.action, 'refuse');
  assert.match(result.message, /zeta/);
});

test('an untouched default is written only after the Owner confirms', () => {
  const slugs = [...SLUGS, 'zeta'];
  const draft = buildDraftShares(slugs, P99);
  const result = checkSave({ slugs, loaded: P99, shares: draft.shares, defaults: draft.defaults, touched: [], boundaries: 0, otherChanged: true });
  assert.equal(result.action, 'confirm');
  const zeta = result.rows.find((row) => row.slug === 'zeta');
  assert.deepEqual([zeta.old, zeta.next], [null, 1]);
});

test('a touched default saves without a confirmation', () => {
  const slugs = [...SLUGS, 'zeta'];
  const shares = { alpha: 9, beta: 36, gamma: 31, delta: 13, epsilon: 9, zeta: 2 };
  const result = checkSave({ slugs, loaded: P99, shares, defaults: ['zeta'], touched: ['zeta', 'epsilon'], boundaries: 1, otherChanged: false });
  assert.equal(result.action, 'save');
});

test('a slider move between two neighbors is a normal save', () => {
  const shares = { alpha: 9, beta: 36, gamma: 34, delta: 10, epsilon: 11 };
  const result = checkSave(base({ shares, touched: ['gamma', 'delta', 'epsilon'], boundaries: 1 }));
  assert.equal(result.action, 'save');
});

test('more than one changed share from more than one edit needs a confirmation that lists every project', () => {
  const shares = { alpha: 12, beta: 33, gamma: 31, delta: 14, epsilon: 10 };
  const result = checkSave(base({ shares, touched: ['alpha', 'beta', 'delta'], boundaries: 2 }));
  assert.equal(result.action, 'confirm');
  assert.deepEqual(result.rows.map((row) => row.slug), SLUGS);
  assert.deepEqual(result.rows.map((row) => [row.old, row.next]), [[9, 12], [36, 33], [31, 31], [13, 14], [10, 10]]);
  const text = confirmText(result.rows);
  for (const [slug, old, next] of [['alpha', 9, 12], ['beta', 36, 33], ['gamma', 31, 31], ['delta', 13, 14], ['epsilon', 10, 10]]) {
    assert.ok(text.includes(`${slug}: ${old}% -> ${next}%`), `${slug} in ${text}`);
  }
  assert.match(text, /Total: 99% -> 100%/);
});

test('a total that changes by more than 5 points needs a confirmation', () => {
  const shares = { alpha: 9, beta: 36, gamma: 31, delta: 13, epsilon: 3 };
  const result = checkSave(base({ shares, touched: ['epsilon'], boundaries: 1 }));
  assert.equal(result.action, 'confirm');
  assert.equal(checkSave(base({ shares: { ...shares, epsilon: 5 }, touched: ['epsilon'], boundaries: 1 })).action, 'save', 'a change of 5 points is not confirmed');
});

test('a total above 100 blocks the save', () => {
  const shares = { alpha: 9, beta: 36, gamma: 31, delta: 13, epsilon: 20 };
  const result = checkSave(base({ shares, touched: ['epsilon'], boundaries: 1 }));
  assert.equal(result.action, 'refuse');
  assert.match(result.message, /109/);
});

test('an unchanged policy with a total of 99 saves without a confirmation', () => {
  assert.equal(checkSave(base({ otherChanged: true })).action, 'save');
});

test('moveShares moves one boundary and keeps a total of 100 with the largest remainder method', () => {
  const out = moveShares({ a: 40, b: 30, c: 30 }, ['a', 'b', 'c'], 0, 50);
  assert.deepEqual(out, { a: 50, b: 25, c: 25 });
  const odd = moveShares({ a: 33, b: 33, c: 34 }, ['a', 'b', 'c'], 0, 34);
  assert.equal(shareTotal(odd, ['a', 'b', 'c']), 100);
  const from99 = moveShares({ alpha: 9, beta: 36, gamma: 31, delta: 13, epsilon: 10 }, SLUGS, 1, 50);
  assert.equal(shareTotal(from99, SLUGS), 100);
  assert.equal(from99.alpha, 9);
  assert.equal(from99.beta, 41);
});

test('app.js builds the form from the draft module and has no equal-split fallback', () => {
  assert.match(app, /from '\.\/allocation-draft\.js'/);
  assert.doesNotMatch(app, /Math\.floor\(100 \/ projects\.length\)/);
  assert.match(draftSource, /The policy changed on the server\. Reload the shares\?/);
  assert.match(draftSource, /data-distribute-remaining/);
  assert.match(app, /default, not saved/);
});

test('a project that is not in the project list keeps its share, counts in the total, and is never changed by a save', () => {
  const loaded = policyOf({ a: 40, b: 30, old: 20 });
  const draft = buildDraftShares(['a', 'b'], loaded);
  assert.deepEqual(draft.shares, { a: 40, b: 30 });
  const fixed = { old: 20 };
  const shares = { a: 45, b: 25 };
  const result = checkSave({ slugs: ['a', 'b'], loaded, shares, defaults: [], touched: ['a', 'b'], boundaries: 1, fixed });
  assert.equal(result.action, 'save');
  const row = result.rows.find((r) => r.slug === 'old');
  assert.deepEqual([row.old, row.next], [20, 20]);
  const over = checkSave({ slugs: ['a', 'b'], loaded, shares: { a: 60, b: 30 }, defaults: [], touched: ['a'], boundaries: 1, fixed });
  assert.equal(over.action, 'refuse', 'the stale share counts: 60 + 30 + 20 is above 100');
  assert.match(over.message, /110/);
  assert.match(staleRowHtml('old', 20), /not in the project list/);
  assert.match(staleRowHtml('old', 20), /20%/);
  assert.doesNotMatch(staleRowHtml('old', 20), /<input|<button/);
  assert.match(app, /staleRowHtml\(slug, share\)/);
  assert.doesNotMatch(app, /\]\.share = 0;\n/, 'no code zeroes a share');
});

test('a boundary move keeps the room of a stale project, and a distribute counts it', () => {
  const out = moveShares({ a: 40, b: 30 }, ['a', 'b'], 0, 90, 20);
  assert.deepEqual(out, { a: 80, b: 0 });
  assert.deepEqual(distributeRemainder({ a: 40, b: 30 }, ['a', 'b'], 20), { a: 50, b: 30 });
});

test('a boundary move never gives a negative share and does nothing while the total is above 100', () => {
  const shares = { a: 60, b: 60, c: 5, d: 5 };
  const slugs = ['a', 'b', 'c', 'd'];
  for (const index of [0, 1, 2]) for (const position of [0, 30, 60, 100, 500, -20]) {
    assert.deepEqual(moveShares(shares, slugs, index, position), shares);
  }
  for (const index of [0, 1, 2]) for (const position of [-50, 0, 33, 61, 100, 400]) {
    const out = moveShares({ a: 20, b: 30, c: 40, d: 10 }, slugs, index, position);
    for (const slug of slugs) assert.ok(Number.isInteger(out[slug]) && out[slug] >= 0, `${slug}=${out[slug]}`);
    assert.equal(shareTotal(out, slugs), 100);
  }
});

test('the save refuses a share that is negative or not a whole number', () => {
  const base2 = { slugs: ['a', 'b'], loaded: policyOf({ a: 50, b: 50 }), defaults: [], touched: ['a'], boundaries: 1 };
  assert.equal(checkSave({ ...base2, shares: { a: -5, b: 105 } }).action, 'refuse');
  assert.equal(checkSave({ ...base2, shares: { a: 50.5, b: 49.5 } }).action, 'refuse');
});

test('a keyed refresh with a dirty draft keeps the typed edit and the reload line', () => {
  globalThis.document = createDocument();
  const page = (total, stale) => `<div class="control-shell"><input id="max" type="number" value="8" data-policy-number="maxWorkers">${allocationFooterHtml(total, stale)}</div>`;
  const root = document.html(page(99, false));
  const input = find(root, (el) => el.tagName === 'INPUT');
  input.value = '12';
  input.focus();
  assert.equal(find(root, (el) => el.getAttribute('data-reload-shares') !== null), null);
  patchHtml(root, page(109, true));
  assert.equal(find(root, (el) => el.tagName === 'INPUT'), input, 'the input node stays');
  assert.equal(input.value, '12', 'the typed edit stays');
  assert.equal(document.activeElement, input);
  assert.ok(find(root, (el) => el.getAttribute('data-reload-shares') !== null), 'the reload line shows');
  assert.ok(find(root, (el) => el.getAttribute('role') === 'alert'), 'the total warning shows');
});
