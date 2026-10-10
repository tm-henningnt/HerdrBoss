import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installNavMenu } from '../public/nav-menu.js';
import { MENU_ROUTES } from '../public/routes.js';

// A small DOM with the event order of a Chrome tap on a phone: pointerdown, touchstart, pointerup, touchend,
// the compatibility mousedown (which moves the focus), mouseup, and click. A tap on iOS Safari does not move
// the focus. Both modes run. The model does not cover layout, z-index, or the real iOS engine.
class El {
  constructor(tag, attrs = {}, parent = null) {
    this.tag = tag; this.attrs = { ...attrs }; this.parent = parent; this.children = []; this.listeners = {};
    this.set = new Set((attrs.class || '').split(' ').filter(Boolean));
    this.classList = { contains: (c) => this.set.has(c), toggle: (c, on) => (on ? this.set.add(c) : this.set.delete(c)) };
    this.dataset = {}; this.doc = parent?.doc;
    parent?.children.push(this);
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  matches(sel) {
    return sel.split(',').some((part) => {
      part = part.trim();
      if (part === 'a' || part === 'button') return this.tag === part;
      if (part.startsWith('#')) return this.attrs.id === part.slice(1);
      const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part);
      return Boolean(m) && (m[2] === undefined ? m[1] in this.attrs : this.attrs[m[1]] === m[2]);
    });
  }
  closest(sel) { for (let e = this; e; e = e.parent) if (e.matches(sel)) return e; return null; }
  contains(other) { for (let e = other; e; e = e.parent) if (e === this) return true; return false; }
  all() { return [this, ...this.children.flatMap((c) => c.all())]; }
  querySelectorAll(sel) { return this.all().filter((e) => e !== this && e.matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  focus() { this.doc.moveFocus(this); }
}
function page({ appView }) {
  const doc = new El('document');
  doc.doc = doc;
  const body = new El('body', {}, doc); body.doc = doc;
  const brand = new El('a', { 'data-nav-trigger': '', href: '/', 'aria-expanded': 'false' }, body);
  const nav = new El('nav', { id: 'primary-nav' }, body);
  const links = MENU_ROUTES.map((route) => { const a = new El('a', { href: route.path }, nav); a.route = route; return a; });
  const help = new El('button', { 'data-nav-help': '', id: 'nav-help' }, nav);
  const plain = new El('div', { id: 'plain' }, body);
  const appButton = new El('button', { 'data-nav-trigger': '', 'aria-expanded': 'false' }, body);
  doc.focused = null; doc.path = '/'; doc.helpOpen = false;
  doc.moveFocus = (next) => {
    const prev = doc.focused;
    if (prev === next) return;
    doc.focused = next;
    if (prev) emit(prev, 'focusout', { relatedTarget: next });
    emit(next, 'focusin', { relatedTarget: prev });
  };
  const emit = (target, type, extra = {}) => {
    const event = { type, target, relatedTarget: null, preventDefault() { this.prevented = true; }, ...extra };
    for (let e = target; e; e = e.parent) for (const fn of e.listeners[type] || []) fn(event);
    return event;
  };
  const menu = installNavMenu({ doc, nav, brand, isPhone: () => true, isAppView: () => appView, openHelp: () => { doc.helpOpen = true; } });
  const tap = (target, { focusMoves = true } = {}) => {
    for (const type of ['pointerdown', 'touchstart', 'pointerup', 'touchend']) emit(target, type);
    emit(target, 'mousedown');
    if (focusMoves) {
      const focusable = target.closest('a, button');
      if (focusable) doc.moveFocus(focusable); else if (doc.focused) doc.moveFocus(null);
    }
    emit(target, 'mouseup');
    const click = emit(target, 'click');
    const link = target.closest('a');
    if (link?.attrs.href && !click.prevented) doc.path = link.attrs.href;
  };
  return { doc, brand, nav, links, help, plain, appButton, tap, menu };
}
const open = (p, trigger) => { p.tap(trigger); assert.equal(p.nav.classList.contains('open'), true, 'a tap on the trigger opens the menu'); };

for (const appView of [false, true]) {
  for (const focusMoves of [true, false]) {
    const mode = `${appView ? 'app view' : 'page'}, ${focusMoves ? 'focus moves on tap' : 'no focus move on tap'}`;
    test(`a tap opens the menu and each entry opens its route and closes the menu (${mode})`, () => {
      for (const route of MENU_ROUTES) {
        const p = page({ appView });
        open(p, appView ? p.appButton : p.brand);
        const link = p.links.find((a) => a.route === route);
        p.tap(link, { focusMoves });
        assert.equal(p.doc.path, route.path, `${route.label} opens ${route.path}`);
        assert.equal(p.nav.classList.contains('open'), false, `${route.label} closes the menu`);
        open(p, appView ? p.appButton : p.brand);
      }
    });
    test(`a tap on the trigger closes an open menu (${mode})`, () => {
      const p = page({ appView });
      const trigger = appView ? p.appButton : p.brand;
      p.tap(trigger, { focusMoves });
      assert.equal(p.nav.classList.contains('open'), true);
      p.tap(trigger, { focusMoves });
      assert.equal(p.nav.classList.contains('open'), false, 'the second tap closes the menu');
      assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    });
    test(`a tap outside the menu closes it, and Help opens the panel (${mode})`, () => {
      const p = page({ appView });
      p.tap(appView ? p.appButton : p.brand, { focusMoves });
      p.tap(p.plain, { focusMoves });
      assert.equal(p.nav.classList.contains('open'), false, 'a tap on a plain area closes the menu');
      p.tap(appView ? p.appButton : p.brand, { focusMoves });
      p.tap(p.help, { focusMoves });
      assert.equal(p.doc.helpOpen, true);
      assert.equal(p.nav.classList.contains('open'), false);
    });
  }
}

test('on iOS a tap on a plain area sends no click, and the release still closes the menu', () => {
  const p = page({ appView: false });
  open(p, p.brand);
  for (const type of ['pointerdown', 'touchstart', 'pointerup', 'touchend']) {
    const event = { type, target: p.plain, relatedTarget: null };
    for (let e = p.plain; e; e = e.parent) for (const fn of e.listeners[type] || []) fn(event);
  }
  assert.equal(p.nav.classList.contains('open'), false);
});

test('Escape closes the open menu and the trigger takes the focus', () => {
  const p = page({ appView: false });
  open(p, p.brand);
  assert.equal(p.menu.escape(), true);
  assert.equal(p.nav.classList.contains('open'), false);
  assert.equal(p.doc.focused, p.brand);
  assert.equal(p.menu.escape(), false, 'a closed menu leaves Escape to the Help panel');
});

test('a live render that replaces the trigger keeps the open state in the new trigger', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const button = /function appMenuButton\([\s\S]*?\n\}/.exec(app)?.[0] || '';
  assert.match(button, /aria-expanded="\$\{\$nav\.classList\.contains\('open'\)\}"/, 'the new trigger reads the state from the menu element');
  assert.match(app, /installNavMenu\(\{[^}]*doc: document[^}]*nav: \$nav/, 'one menu controller owns the open state, outside the render target');
});
