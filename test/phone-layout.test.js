// Static checks for the phone layout. The browser check in test/phone-check.mjs measures the rendered pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pub = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const css = readFileSync(join(pub, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const html = readFileSync(join(pub, 'index.html'), 'utf8');
const app = readFileSync(join(pub, 'app.js'), 'utf8');

// Split a CSS text into top-level blocks: { head, body }. A block body can hold nested blocks.
function blocks(text) {
  const out = [];
  let depth = 0, start = 0, head = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') { if (depth === 0) { head = text.slice(start, i).trim(); start = i + 1; } depth++; }
    else if (text[i] === '}') { depth--; if (depth === 0) { out.push({ head, body: text.slice(start, i) }); start = i + 1; } }
  }
  return out;
}

// All rules, with the media query that holds each one ('' for a top-level rule).
function rules() {
  const all = [];
  for (const b of blocks(css)) {
    if (b.head.startsWith('@media')) for (const r of blocks(b.body)) all.push({ media: b.head, selector: r.head, body: r.body });
    else if (!b.head.startsWith('@')) all.push({ media: '', selector: b.head, body: b.body });
  }
  return all;
}

const decls = (body) => body.split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const i = d.indexOf(':'); return [d.slice(0, i).trim(), d.slice(i + 1).trim()]; });
const phone = (media) => /max-width:\s*760px/.test(media);

test('the viewport meta keeps pinch zoom', () => {
  const meta = /<meta name="viewport" content="([^"]*)"/.exec(html)?.[1] || '';
  assert.match(meta, /width=device-width/);
  assert.match(meta, /initial-scale=1(,|$)/);
  assert.doesNotMatch(meta, /user-scalable/);
  assert.doesNotMatch(meta, /maximum-scale/);
});

test('at phone width every input, select, and textarea has a font size of at least 16px', () => {
  const found = new Set();
  for (const r of rules().filter((x) => phone(x.media))) {
    const fs = decls(r.body).find(([p]) => p === 'font-size');
    if (!fs || !/^(1[6-9]|[2-9]\d)(px)?\b/.test(fs[1])) continue;
    for (const sel of r.selector.split(',').map((s) => s.trim())) {
      for (const tag of ['input', 'select', 'textarea']) if (new RegExp(`(^|[\\s>+~])${tag}(\\[[^\\]]*\\]|:[a-z-]+\\([^)]*\\))*$`).test(sel)) found.add(tag);
    }
  }
  assert.deepEqual([...found].sort(), ['input', 'select', 'textarea']);
});

test('at phone width buttons, selects, and text inputs are at least 44px high', () => {
  const found = new Set();
  for (const r of rules().filter((x) => phone(x.media))) {
    const mh = decls(r.body).find(([p]) => p === 'min-height');
    if (!mh || !/^(4[4-9]|[5-9]\d)px\b/.test(mh[1])) continue;
    for (const sel of r.selector.split(',').map((s) => s.trim())) {
      for (const tag of ['button', 'select', 'input']) if (new RegExp(`(^|[\\s>+~])${tag}(\\[[^\\]]*\\]|:[a-z-]+\\([^)]*\\))*$`).test(sel)) found.add(tag);
    }
  }
  assert.deepEqual([...found].sort(), ['button', 'input', 'select']);
});

test('a viewport height unit has a dynamic viewport fallback in the same rule', () => {
  const bad = [];
  for (const r of rules()) {
    const list = decls(r.body);
    for (const [prop, value] of list) {
      if (!/\d(\.\d+)?vh\b/.test(value)) continue;
      const want = value.replace(/(\d(?:\.\d+)?)vh\b/g, '$1dvh');
      if (!list.some(([p, v]) => p === prop && (v === want || v.replace(/svh/g, 'dvh') === want))) bad.push(`${r.selector} { ${prop}: ${value} }`);
    }
  }
  assert.deepEqual(bad, []);
});

test('a preformatted block scrolls in its own box', () => {
  const ok = rules().some((r) => /(^|,)\s*pre\s*(,|$)/.test(r.selector) && decls(r.body).some(([p, v]) => p === 'overflow-x' && v === 'auto'));
  assert.ok(ok, 'a rule "pre { overflow-x: auto }" is missing');
});

test('every table in a template sits in a scroll box or a card layout', () => {
  const bare = [];
  const scrollWrap = /(wrap|scroll)/;
  for (const m of app.matchAll(/<table class="([^"]*)"/g)) {
    const before = app.slice(Math.max(0, m.index - 220), m.index);
    if (!scrollWrap.test(before.slice(before.lastIndexOf('<div') >= 0 ? before.lastIndexOf('<div') : 0))) bare.push(m[1]);
  }
  assert.deepEqual(bare, []);
});

test('the fixed bars follow the visual viewport', () => {
  assert.match(app, /visualViewport/);
  const bar = rules().find((r) => r.selector.includes('.control-actions.pending') && r.media === '');
  assert.ok(bar && /var\(--kb-inset/.test(bar.body), 'the fixed action bar does not use --kb-inset');
});

// Tags (and classes on those tags) of the controls that a template renders.
function controlClasses() {
  const map = new Map();
  for (const m of app.matchAll(/<(button|input|select|textarea|label|summary|a)\b[^>]*?class="([^"]*)"/g)) {
    for (const cls of m[2].split(/\s+/).filter((c) => c && !c.includes('$'))) {
      if (!map.has(cls)) map.set(cls, new Set());
      map.get(cls).add(m[1]);
    }
  }
  return map;
}

// Split a selector list at top-level commas.
const selectors = (list) => { const out = []; let d = 0, s = 0; for (let i = 0; i < list.length; i++) { if ("([".includes(list[i])) d++; else if (")]".includes(list[i])) d--; else if (list[i] === "," && d === 0) { out.push(list.slice(s, i).trim()); s = i + 1; } } out.push(list.slice(s).trim()); return out; };
const px = (v) => { const m = /^(\d+(?:\.\d+)?)px\b/.exec(v); return m ? Number(m[1]) : null; };

test('the phone block raises every control rule that is under 44px high', () => {
  const classes = controlClasses();
  const floorTags = new Set();
  for (const r of rules().filter((x) => phone(x.media))) {
    const mh = decls(r.body).find(([p, v]) => p === 'min-height' && /!important/.test(v) && px(v) >= 44);
    if (!mh) continue;
    for (const sel of selectors(r.selector)) for (const t of ['button', 'select', 'textarea', 'input', 'label']) if (new RegExp(`(^|[\\s>+~])${t}(:|\\[|$)`).test(sel) || (t === 'button' && sel === '[role="button"]')) floorTags.add(t);
  }
  assert.deepEqual([...floorTags].sort(), ['button', 'input', 'label', 'select', 'textarea']);

  const uncovered = [], lowered = [];
  for (const r of rules()) {
    for (const [prop, value] of decls(r.body)) {
      if (!['min-height', 'height'].includes(prop)) continue;
      const n = px(value);
      if (n === null || n >= 44) continue;
      if (/!important/.test(value) && phone(r.media)) lowered.push(`${r.selector} { ${prop}: ${value} }`);
      for (const sel of selectors(r.selector).filter((s) => !s.includes('::'))) {
        const last = sel.split(/[\s>+~]+/).pop();
        const tag = /^[a-z]+/.exec(last)?.[0];
        const cls = [...last.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
        const tags = new Set(tag ? [tag] : []);
        for (const c of cls) for (const t of classes.get(c) || []) tags.add(t);
        const interactive = [...tags].filter((t) => ['button', 'input', 'select', 'textarea', 'label', 'summary', 'a'].includes(t));
        const missing = interactive.filter((t) => !floorTags.has(t) && t !== 'summary');
        if (missing.length) uncovered.push(`${sel} { ${prop}: ${value} } on ${missing.join(', ')}`);
      }
    }
  }
  assert.deepEqual(lowered, []);
  assert.deepEqual(uncovered, []);
});

test('the phone block gives the round icon buttons a 44px width', () => {
  const body = rules().filter((r) => phone(r.media) && /\.chat-send/.test(r.selector) && /\.browser-tab-close/.test(r.selector)).map((r) => r.body).join(';');
  assert.match(body, /min-width:\s*44px/);
  assert.match(body, /(^|[;\s])height:\s*44px/);
});

test('the chat composer textarea sets its font in one top-level rule, at 15px or more', () => {
  const fontRules = rules().filter((r) => r.media === '' && selectors(r.selector).includes('.chat-composer textarea')
    && decls(r.body).some(([p]) => p === 'font' || p === 'font-size'));
  assert.equal(fontRules.length, 1, fontRules.map((r) => r.body.trim()).join(' | '));
  const size = decls(fontRules[0].body).map(([p, v]) => (p === 'font-size' ? v : p === 'font' ? /(\d+(?:\.\d+)?)px/.exec(v)?.[0] : null)).filter(Boolean).pop();
  assert.ok(px(size) >= 15, `desktop font size ${size}`);
});

// Each app view renders one h1: the title in its app bar. The page shell has no h1.
test('the Mailbox and the Chat each render one h1, and the page shell renders none', () => {
  assert.doesNotMatch(html, /<h1\b/);
  const fn = (name) => new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{([\\s\\S]*?)\\n\\}`).exec(app)?.[1] || '';
  for (const name of ['mailboxView', 'chatView']) assert.equal((fn(name).match(/<h1\b/g) || []).length, 1, name);
  for (const name of ['mailConversationView', 'mailComposeView', 'mailRowsHtml', 'chatConversationView', 'appMenuButton']) assert.doesNotMatch(fn(name), /<h1\b/, name);
});

// The row checkbox is 18px wide at the right edge of a 40px column, so it starts at 22px. The Select all box starts there too.
test('the Select all checkbox lines up with the row checkboxes', () => {
  const bulk = rules().filter((r) => selectors(r.selector).includes('.mail-bulk') && decls(r.body).some(([p]) => p === 'padding'));
  assert.ok(bulk.length >= 2, 'a desktop rule and a phone rule');
  for (const r of bulk) {
    const pad = decls(r.body).find(([p]) => p === 'padding')[1];
    const parts = []; let d = 0, cur = '';
    for (const ch of pad + ' ') { if (ch === '(') d++; if (ch === ')') d--; if (ch === ' ' && d === 0) { if (cur) parts.push(cur); cur = ''; } else cur += ch; }
    const left = parts[3] || parts[1];
    assert.match(left, /^(22px|max\(22px, env\(safe-area-inset-left\)\))$/, `${r.media || 'desktop'}: ${pad}`);
  }
});

test('the answer field of a Mailbox item has the same field style as the Reply field', () => {
  const r = rules().find((x) => x.media === '' && selectors(x.selector).includes('.mail-reply textarea') && decls(x.body).some(([p]) => p === 'background'));
  assert.ok(selectors(r.selector).includes('.mail-actions textarea'), r.selector);
});

// At a 1280px laptop width the eleven nav links with their badges fit on one line only with the compact padding.
test('the compact desktop nav covers a 1280px window', () => {
  const compact = rules().filter((r) => r.selector === '#primary-nav a' && /min-width:\s*761px/.test(r.media) && /padding:\s*5px 6px/.test(r.body));
  assert.equal(compact.length, 1);
  const max = Number(/max-width:\s*(\d+)px/.exec(compact[0].media)?.[1]);
  assert.ok(max >= 1360, compact[0].media);
});
