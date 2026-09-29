#!/usr/bin/env node
// Phone layout check. Needs the project browser: it drives that browser over its DevTools port.
// It is not part of `npm test`. Run it with `npm run check:phone`.
//
//   node test/phone-check.mjs [--base URL] [--project SLUG] [--widths 320,375,390,430] [--strict-targets] [--only /logs,/chat]
//
// Without --base the script starts a read-only preview with a temporary HOME and HERDR_BOSS_DIR.
// The script fails when a page is wider than the viewport, or when a visible input, select, or
// textarea has a computed font size under 16 px. --strict-targets also fails on touch targets under 44 px.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const project = opt('project', 'herdrboss');
const widths = opt('widths', '320,375,390,430').split(',').map(Number);
const only = opt('only', '').split(',').filter(Boolean);
const strictTargets = args.includes('--strict-targets');
const height = 844;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const sh = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { encoding: 'utf8' });

async function startPreview() {
  const home = mkdtempSync(join(tmpdir(), 'phone-home-'));
  const dir = join(mkdtempSync(join(tmpdir(), 'phone-boss-')), 'herdr-boss');
  mkdirSync(dir, { recursive: true });
  const port = 4600 + Math.floor(Math.random() * 300);
  const child = spawn(process.execPath, ['src/cli.js', 'serve', '--read-only-preview'], {
    cwd: root, stdio: 'ignore', env: { ...process.env, HOME: home, HERDR_BOSS_DIR: dir, HERDR_BOSS_PORT: String(port) },
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/state`)).ok) return { base, child }; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  child.kill();
  throw new Error('preview did not start');
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } }; }
  static async open(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cdp connect failed')); }); return new Cdp(ws); }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`cdp ${method} timed out`)); }, 60000); this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } }); }); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '')); return r.result.value; }
  close() { this.ws.close(); }
}

// Runs in the page. Returns the overflow and control findings for the current render.
const MEASURE = `(() => {
  const vw = document.documentElement.clientWidth;
  const doc = document.documentElement.scrollWidth;
  const path = (el) => { const parts = []; for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) parts.unshift(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.classList.length ? '.' + [...n.classList].slice(0, 2).join('.') : '')); return parts.join(' > '); };
  const visible = (el) => { const r = el.getBoundingClientRect(); if (!r.width || !r.height) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none'; };
  const clipCache = new Map();
  const clipped = (el) => { const n = el.parentElement; if (!n || n === document.body || n === document.documentElement) return false; if (clipCache.has(n)) return clipCache.get(n); const r = /(auto|scroll|hidden|clip)/.test(getComputedStyle(n).overflowX) || clipped(n); clipCache.set(n, r); return r; };
  const fixedOrAbsOffscreen = (el) => !!el.closest('dialog:not([open])');
  const offenders = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (['SCRIPT', 'STYLE', 'PATH', 'CIRCLE', 'LINE', 'POLYLINE', 'G'].includes(el.tagName)) continue;
    if (!visible(el) || clipped(el) || fixedOrAbsOffscreen(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 0.5 || r.left < -0.5) offenders.push({ el: path(el), left: Math.round(r.left), right: Math.round(r.right) });
  }
  const small = [];
  for (const el of document.querySelectorAll('input, select, textarea')) {
    if (el.type && /^(checkbox|radio|hidden|range|file|button|submit|reset|image|color)$/.test(el.type)) continue;
    if (!visible(el)) continue;
    const px = parseFloat(getComputedStyle(el).fontSize);
    if (px < 16) small.push({ el: path(el), fontSize: px });
  }
  const targets = [];
  const targetSel = 'button, select, summary, [role="button"], input[type="checkbox"], input[type="radio"], #primary-nav a, a.top-icon, a.brand';
  for (const el of document.querySelectorAll(targetSel)) {
    if (!visible(el)) continue;
    let r = el.getBoundingClientRect();
    const label = el.closest('label');
    if (/checkbox|radio/.test(el.type || '')) r = (label || el.parentElement).getBoundingClientRect();
    if (r.height < 43.5) targets.push({ el: path(el), height: Math.round(r.height * 10) / 10 });
  }
  const pre = [];
  for (const el of document.querySelectorAll('table, pre')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 0.5 && !clipped(el) && !/(auto|scroll)/.test(getComputedStyle(el).overflowX)) pre.push(path(el));
  }
  const bad = {}; for (const el of document.querySelectorAll('#app *')) { if (!visible(el)) continue; }
  return { vw, doc, offenders: offenders.slice(0, 8), offenderCount: offenders.length, small, targets, unscrolled: pre };
})()`;

async function settle(cdp) {
  let last = -1, stable = 0;
  for (let i = 0; i < 40 && stable < 2; i++) {
    const len = await cdp.eval(`(document.querySelector('#app')?.innerHTML.length || 0) + ':' + document.readyState`);
    const n = len === last ? stable + 1 : 0;
    stable = n; last = len;
    await new Promise((r) => setTimeout(r, 200));
  }
}

const preview = opt('base') ? null : await startPreview();
const base = opt('base', preview?.base);
let failures = 0, warnings = 0, tabId = null, cdp = null;
try {
  const list = JSON.parse(sh('herdr-boss', ['browser', 'list']));
  const port = list.find((b) => b.project === project)?.port;
  if (!port) throw new Error(`no project browser for ${project}. Run: herdr-boss browser request ${project}`);
  const out = sh('herdr-boss', ["browser", "tab", "new", project, "about:blank"]);
  tabId = JSON.parse(out).id;
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) throw new Error(`tab ${tabId} not found on DevTools port`);
  cdp = await Cdp.open(tab.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  await cdp.send('Page.bringToFront').catch(() => {});

  const state = await (await fetch(`${base}/api/state`)).json();
  const slug = state.projects?.[0]?.slug;
  const pages = ['/', '/projects', '/agents', '/agents?view=chart', '/allocation', '/analytics', '/settings', '/mailbox', '/chat', '/logs', '/browsers'];
  if (slug) pages.splice(2, 0, `/projects/${slug}`);

  for (const width of widths) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
    // A state with a click needs data. When the element is missing, the state is skipped and listed.
    const runs = [...pages.map((p) => ({ p })), { p: '/', help: true }, { p: '/', menu: true },
      { p: '/mailbox', click: '[data-mail-compose-open]', name: '+compose' },
      { p: '/mailbox', click: '[data-mail-open]', name: '+message' },
      { p: '/mailbox?folder=needs-you', click: '[data-mail-open]', name: '+message' },
      { p: '/chat', click: '[data-chat-open]', name: '+thread' }];
    for (const run of runs) {
      if (only.length && !only.some((o) => `${run.p}${run.name ? ' ' + run.name : ''}`.startsWith(o))) continue;
      const label = `${width}px ${run.p}${run.help ? ' +help' : ''}${run.menu ? ' +menu' : ''}${run.name ? ' ' + run.name : ''}`;
      try {
        let navError = null;
        try { await cdp.send('Page.navigate', { url: `${base}${run.p}` }); } catch (e) { navError = e.message; }
        await settle(cdp);
        if (run.help) { await cdp.eval(`document.getElementById('help-toggle').click()`); await settle(cdp); }
        if (run.click) {
          const hit = await cdp.eval(`(() => { const el = document.querySelector(${JSON.stringify(run.click)}); if (el) el.click(); return !!el; })()`);
          if (!hit) { console.log(`skip ${label} (no ${run.click})`); continue; }
          await settle(cdp);
        }
        if (run.menu) { await cdp.eval(`document.getElementById('nav-menu').click()`); await settle(cdp); }
        const m = await cdp.eval(MEASURE);
        const problems = navError ? [navError] : [];
        if (m.doc > m.vw) problems.push(`scrollWidth ${m.doc} > clientWidth ${m.vw}`);
        for (const o of m.offenders) problems.push(`wide element ${o.el} (${o.left}..${o.right})`);
        for (const s of m.small) problems.push(`font ${s.fontSize}px on ${s.el}`);
        for (const u of m.unscrolled) problems.push(`no scroll box: ${u}`);
        const tw = m.targets.map((t) => `target ${t.height}px on ${t.el}`);
        if (problems.length) { failures++; console.log(`FAIL ${label}`); for (const p of problems) console.log(`  ${p}`); }
        else console.log(`ok   ${label}`);
        if (tw.length) { if (strictTargets) failures++; else warnings++; console.log(`${strictTargets ? 'FAIL' : 'warn'} ${label}`); for (const t of tw.slice(0, 12)) console.log(`  ${t}`); if (tw.length > 12) console.log(`  … ${tw.length - 12} more`); }
      } catch (e) { failures++; console.log(`FAIL ${label}\n  ${e.message}`); }
    }
  }
} catch (e) {
  console.error(e.message);
  failures++;
} finally {
  try { cdp?.send('Emulation.clearDeviceMetricsOverride'); } catch {}
  cdp?.close();
  if (tabId) { try { sh('herdr-boss', ['browser', 'tab', 'close', project, '--tab', tabId, '--force']); } catch {} }
  preview?.child.kill();
}
console.log(`\n${failures} failing page checks, ${warnings} touch target warnings`);
process.exit(failures ? 1 : 0);
