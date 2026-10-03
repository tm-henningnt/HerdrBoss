import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PARTS, PART_IDS, STEPS, clampStep, diagramHtml, textHtml, controlsHtml, listHtml, shellHtml, mountExplainer, currentStep } from '../public/explainer.js';
import { docsViewHtml } from '../public/docs-view.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const NAMED = ['boss', 'lead', 'workers', 'panes', 'service', 'dashboard', 'locks', 'quota', 'policy', 'mailbox', 'packs', 'kit', 'handover', 'factory'];

// A root that records what the module writes and what it listens to. Buttons come from the real controls HTML.
function fakeRoot() {
  const listeners = {};
  const parts = {};
  const focused = [];
  const root = {
    innerHTML: '',
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener(type, fn) { listeners[type] = fn; },
    querySelector(selector) {
      const named = /^\[data-ex-(diagram|text|controls|list)\]$/.exec(selector);
      if (named) return (parts[named[1]] ||= { innerHTML: '' });
      if (selector === '[aria-current="step"]') return { focus: () => focused.push('chip') };
      const go = /^\[data-ex-go="(\w+)"\]:not\(:disabled\)$/.exec(selector);
      if (go && !new RegExp(`data-ex-go="${go[1]}" disabled`).test(parts.controls.innerHTML)) return { focus: () => focused.push(go[1]) };
      return null;
    },
  };
  const button = (go) => ({
    disabled: new RegExp(`data-ex-go="${go}" disabled`).test(parts.controls.innerHTML),
    getAttribute: () => go,
  });
  const click = (go) => listeners.click({ target: { closest: () => button(go) } });
  const key = (name, extra = {}) => { const e = { key: name, target: { closest: () => null }, preventDefault() { this.prevented = true; }, ...extra }; listeners.keydown(e); return e; };
  return { root, parts, focused, click, key, listeners };
}
const shown = (fake) => Number(/Step (\d+) of/.exec(fake.parts.controls.innerHTML)[1]) - 1;

test('the data names each part of the walkthrough', () => {
  for (const id of NAMED) {
    assert.ok(PART_IDS.includes(id), `${id} is a part`);
    assert.ok(STEPS.some((step) => step.parts.includes(id)), `a step highlights ${id}`);
  }
  assert.deepEqual(PARTS.map((p) => p.id).filter((id, i, all) => all.indexOf(id) !== i), []);
  assert.deepEqual(STEPS.map((s) => s.id).filter((id, i, all) => all.indexOf(id) !== i), []);
  for (const step of STEPS) for (const id of step.parts) assert.ok(PART_IDS.includes(id), `${step.id} names the unknown part ${id}`);
});

test('each step has a title and 2 to 4 short sentences, and the text names no private detail', () => {
  assert.ok(STEPS.length >= 10);
  for (const step of STEPS) {
    assert.ok(step.title.trim().length > 0, step.id);
    assert.ok(step.parts.length > 0, step.id);
    assert.ok(step.text.length >= 2 && step.text.length <= 4, `${step.id} has ${step.text.length} sentences`);
    const sentences = step.text.join(' ').split(/(?<=\.)\s+/);
    for (const sentence of sentences) assert.ok(sentence.split(/\s+/).length <= 25, `${step.id}: too long: ${sentence}`);
    assert.doesNotMatch(step.text.join(' '), /\/Users\/|\.ts\.net|\b\d{1,3}(?:\.\d{1,3}){3}\b|https?:|@/);
  }
});

test('the diagram highlights the parts of the step and no other part', () => {
  STEPS.forEach((step, i) => {
    const html = diagramHtml(i);
    const active = [...html.matchAll(/class="[^"]*\bis-active\b[^"]*" data-part="([a-z]+)"/g)].map((m) => m[1]).sort();
    assert.deepEqual(active, [...step.parts].sort(), step.id);
    for (const { id, label } of PARTS) assert.match(html, new RegExp(`data-part="${id}">${label}<`));
  });
});

test('the clamp keeps the step in range', () => {
  assert.equal(clampStep(-3), 0);
  assert.equal(clampStep(999), STEPS.length - 1);
  assert.equal(clampStep(undefined), 0);
  assert.equal(clampStep('2'), 0);
});

test('the pieces escape text and mark the step', () => {
  assert.match(textHtml(1), new RegExp(`<h3 class="ex-title">${STEPS[1].title}</h3>`));
  assert.match(controlsHtml(0), /data-ex-go="prev" disabled/);
  assert.match(controlsHtml(0), /aria-valuenow="1"/);
  assert.match(controlsHtml(STEPS.length - 1), /data-ex-go="next" disabled/);
  assert.match(controlsHtml(STEPS.length - 1), new RegExp(`aria-valuenow="${STEPS.length}"`));
  const list = listHtml(3);
  assert.equal((list.match(/data-ex-go="\d+"/g) || []).length, STEPS.length);
  assert.equal((list.match(/aria-current="step"/g) || []).length, 1);
  assert.match(list, /data-ex-go="3" aria-label="Step 4: [^"]+" aria-current="step">4</);
  assert.match(shellHtml(), /data-ex-text aria-live="polite"/);
});

test('mount renders step 1 into the root and sets the group role', () => {
  const fake = fakeRoot();
  const api = mountExplainer(fake.root, { start: 0 });
  assert.match(fake.root.innerHTML, /data-ex-diagram/);
  assert.equal(fake.root.attrs.role, 'group');
  assert.equal(fake.root.attrs.tabindex, '0');
  assert.match(fake.parts.text.innerHTML, new RegExp(STEPS[0].title));
  assert.match(fake.parts.diagram.innerHTML, /ex-factory is-active/);
  assert.equal(shown(fake), 0);
  api.go(4);
  assert.match(fake.parts.text.innerHTML, new RegExp(STEPS[4].title));
  assert.equal(api.index(), 4);
});

test('the buttons and the step numbers move through the steps', () => {
  const fake = fakeRoot();
  mountExplainer(fake.root, { start: 0 });
  fake.click('prev');
  assert.equal(shown(fake), 0, 'Back does nothing at the first step');
  fake.click('next');
  fake.click('next');
  assert.equal(shown(fake), 2);
  assert.match(fake.parts.text.innerHTML, new RegExp(STEPS[2].title));
  fake.click('prev');
  assert.equal(shown(fake), 1);
  fake.click('7');
  assert.equal(shown(fake), 7);
  assert.match(fake.parts.list.innerHTML, /data-ex-go="7" aria-label="Step 8: [^"]+" aria-current="step"/);
  assert.equal(fake.focused.at(-1), 'chip');
  fake.click('99');
  assert.equal(shown(fake), STEPS.length - 1, 'a step number out of range stops at the last step');
  fake.click('next');
  assert.equal(shown(fake), STEPS.length - 1, 'Next does nothing at the last step');
});

test('the arrow keys, Home, and End move through the steps', () => {
  const fake = fakeRoot();
  mountExplainer(fake.root, { start: 0 });
  assert.equal(fake.key('ArrowRight').prevented, true);
  assert.equal(shown(fake), 1);
  fake.key('ArrowRight');
  fake.key('ArrowLeft');
  assert.equal(shown(fake), 1);
  fake.key('End');
  assert.equal(shown(fake), STEPS.length - 1);
  fake.key('ArrowRight');
  assert.equal(shown(fake), STEPS.length - 1);
  fake.key('Home');
  assert.equal(shown(fake), 0);
  fake.key('ArrowLeft');
  assert.equal(shown(fake), 0);
  const other = fake.key('a');
  assert.notEqual(other.prevented, true);
  const modified = fake.key('ArrowRight', { altKey: true });
  assert.notEqual(modified.prevented, true);
  assert.equal(shown(fake), 0, 'a key with a modifier changes nothing');
});

test('a focused button comes back after the render, and the chip takes the focus of a disabled button', () => {
  const fake = fakeRoot();
  mountExplainer(fake.root, { start: 0 });
  fake.click('next');
  assert.equal(fake.focused.at(-1), 'next');
  fake.click('prev');
  assert.equal(fake.focused.at(-1), 'chip', 'Back is disabled at the first step');
});

test('a new mount starts at the step that the reader last saw', () => {
  const fake = fakeRoot();
  mountExplainer(fake.root, { start: 0 }).go(6);
  assert.equal(currentStep(), 6);
  const again = fakeRoot();
  mountExplainer(again.root);
  assert.equal(shown(again), 6);
});

test('the Docs view adds the mount point to the explainer page only', () => {
  const tree = { sections: [{ title: 'Start', pages: [{ name: 'explainer', title: 'How' }, { name: 'a', title: 'A' }] }] };
  const page = (name) => ({ name, title: 'T', source: `docs/${name}.md`, html: '<h1>T</h1>', headings: [] });
  assert.match(docsViewHtml({ tree, name: 'explainer', page: page('explainer') }), /<div class="explainer" data-explainer><\/div>/);
  assert.doesNotMatch(docsViewHtml({ tree, name: 'a', page: page('a') }), /data-explainer/);
});

test('the page, the style sheet, the module, and the page help are wired', () => {
  assert.match(read('public/index.html'), /<link rel="stylesheet" href="\/explainer\.css">/);
  assert.match(read('public/app.js'), /import\('\/explainer\.js'\)/);
  assert.match(read('docs/nav.json'), /"explainer"/);
  assert.match(read('docs/help/docs.md'), /## Explainer/);
  assert.match(read('docs/reference/explainer.md'), /public\/explainer\.js/);
  const css = read('public/explainer.css');
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,6}\b/i, 'the style sheet uses the colour tokens only');
});

test('the Docs service serves the explainer page and lists it in the tree', async () => {
  const { createDocsSite } = await import('../src/docs-site.js');
  const site = createDocsSite({ root: path.resolve(fileURLToPathDir(), '..') });
  const answer = site.page('explainer');
  assert.equal(answer.status, 200);
  assert.equal(answer.body.title, 'How the parts work together');
  assert.ok(site.tree().body.sections.some((s) => s.pages.some((p) => p.name === 'explainer')));
  assert.equal(site.page('reference/explainer').status, 200);
});

function fileURLToPathDir() { return path.dirname(new URL(import.meta.url).pathname); }
