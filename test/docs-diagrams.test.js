// The Docs diagrams. The tests cover the lazy load, the shared fallback, and the draw without a browser.
// The browser check in the task covers the drawn diagram, the theme, and the phone width.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountDiagrams, loadMermaid, resetMermaidLoader, themeVariables, VENDOR_URL } from '../public/docs-diagrams.js';
import { ERROR_TEXT, showFallback, showImportFallback } from '../public/docs-fallback.js';

// A block with the elements that the modules read.
function block(source = 'flowchart TD\n a --> b') {
  const view = { hidden: true, textContent: '', innerHTML: '' };
  const error = { hidden: true, textContent: '' };
  const fold = { hidden: false };
  const code = { textContent: source };
  const querySelector = (selector) => {
    if (selector === '[data-mermaid-view]') return view;
    if (selector === '[data-mermaid-error]') return error;
    if (selector === '[data-mermaid-source]') return fold;
    if (selector === 'code.language-mermaid') return code;
    return null;
  };
  return { dataset: {}, isConnected: true, querySelector, view, error, fold };
}

const renderer = { initialize() {}, render: async () => ({ svg: '<svg></svg>' }) };

test.afterEach(() => {
  resetMermaidLoader();
  delete globalThis.mermaid;
});

test('a page without a diagram never loads Mermaid', async () => {
  let loads = 0;
  await mountDiagrams([], { load: () => { loads += 1; return Promise.resolve(renderer); } });
  assert.equal(loads, 0);
  assert.equal(VENDOR_URL, '/vendor/mermaid.min.js');
});

test('loadMermaid adds one script element with the vendor URL', async () => {
  const created = [];
  const document = {
    head: { appendChild: (element) => { created.push(element); } },
    createElement: () => {
      const listeners = {};
      return { src: '', async: false, addEventListener: (type, fn) => { listeners[type] = fn; }, fire: (type) => listeners[type]?.() };
    },
  };
  const promise = loadMermaid(document);
  assert.equal(created.length, 1);
  assert.equal(created[0].src, VENDOR_URL);
  globalThis.mermaid = renderer;
  created[0].fire('load');
  assert.equal(await promise, renderer);
});

test('a page with a diagram loads Mermaid and draws the block', async () => {
  const one = block();
  let loads = 0;
  await mountDiagrams([one], { load: () => { loads += 1; return Promise.resolve(renderer); } });
  assert.equal(loads, 1);
  assert.equal(one.view.innerHTML, '<svg></svg>');
  assert.equal(one.view.hidden, false);
  assert.equal(one.fold.hidden, true);
  assert.equal(one.error.hidden, true);
});

test('two distinct blocks load Mermaid once and draw both', async () => {
  const first = block();
  const second = block('flowchart LR\n x --> y');
  let loads = 0;
  await mountDiagrams([first, second], { load: () => { loads += 1; return Promise.resolve(renderer); } });
  assert.equal(loads, 1);
  assert.equal(first.view.innerHTML, '<svg></svg>');
  assert.equal(second.view.innerHTML, '<svg></svg>');
  assert.equal(first.fold.hidden, true);
  assert.equal(second.fold.hidden, true);
});

test('a mounted block is not drawn a second time', async () => {
  const one = block();
  let loads = 0;
  const load = () => { loads += 1; return Promise.resolve(renderer); };
  await mountDiagrams([one], { load });
  await mountDiagrams([one], { load });
  assert.equal(loads, 1);
});

test('a failed load keeps the source fold and shows the error line', async () => {
  const one = block();
  await mountDiagrams([one], { load: () => Promise.reject(new Error('no library')) });
  assert.equal(one.error.hidden, false);
  assert.equal(one.error.textContent, ERROR_TEXT);
  assert.equal(one.fold.hidden, false);
  assert.equal(one.view.hidden, true);
});

test('a failed drawing keeps the source fold and shows the error line', async () => {
  const one = block();
  const broken = { initialize() {}, render: async () => { throw new Error('bad diagram'); } };
  await mountDiagrams([one], { load: () => Promise.resolve(broken) });
  assert.equal(one.error.hidden, false);
  assert.equal(one.error.textContent, ERROR_TEXT);
  assert.equal(one.fold.hidden, false);
  assert.equal(one.view.hidden, true);
});

test('a failed module import shows the error line next to the source fold', () => {
  const one = block();
  showImportFallback([one]);
  assert.equal(one.error.hidden, false);
  assert.equal(one.error.textContent, ERROR_TEXT);
  assert.equal(one.fold.hidden, false);
  assert.equal(one.view.hidden, true);
  assert.equal(one.dataset.mermaidDrawn, '1');
});

test('the fallback hides a drawn view and shows the error line', () => {
  const one = block();
  one.view.hidden = false;
  one.view.innerHTML = '<svg></svg>';
  showFallback(one);
  assert.equal(one.view.hidden, true);
  assert.equal(one.view.textContent, '');
  assert.equal(one.error.hidden, false);
});

test('the theme variables read the dashboard colors and fall back without a document', () => {
  const document = {
    documentElement: {},
    defaultView: { getComputedStyle: () => ({ getPropertyValue: (name) => ({ '--text': '#111111', '--panel': '#ffffff' })[name] || '' }) },
  };
  const variables = themeVariables(document);
  assert.equal(variables.primaryTextColor, '#111111');
  assert.equal(variables.background, 'transparent');
  assert.equal(themeVariables(undefined).primaryTextColor, '#1d1b18');
});
