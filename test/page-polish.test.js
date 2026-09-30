// The G5a page pass: contrast of the text tokens, the Overview order, the Watch fold, the Board phone toolbar, and the header.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const phoneCheck = fs.readFileSync(new URL('./phone-check.mjs', import.meta.url), 'utf8');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function load(names, context = {}) {
  const ctx = { esc, ...context };
  const code = names.map((name) => {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} exists in public/app.js`);
    return source.slice(start, source.indexOf('\n}\n', start) + 2);
  }).join('\n');
  vm.runInNewContext(`${code}\nthis.fns = { ${names.join(', ')} };`, ctx);
  return ctx.fns;
}
const body = (name) => { const start = source.indexOf(`function ${name}(`); return source.slice(start, source.indexOf('\n}\n', start)); };

// The token values of one :root block: the first light block, or the first dark block.
function tokens(dark) {
  const block = dark ? /:root\[data-theme="dark"\]\s*\{([^}]*)\}/.exec(css)[1] : /:root\s*\{([^}]*)\}/.exec(css)[1];
  return Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
}
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lum = (hex) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; const [r, g, b] = rgb(hex); return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

test('the text tokens have a contrast of at least 4.5:1 on the page and panel backgrounds in both themes', () => {
  for (const dark of [false, true]) {
    const t = tokens(dark);
    for (const fg of ['text', 'muted', 'accent', 'warn', 'ok', 'crit', 'info']) {
      for (const bg of ['bg', 'panel', 'panel-2']) {
        const r = ratio(t[fg], t[bg]);
        assert.ok(r >= 4.5, `${dark ? 'dark' : 'light'} --${fg} on --${bg} is ${r.toFixed(2)}:1`);
      }
    }
  }
});

test('the faint token is not a text color', () => {
  assert.doesNotMatch(css, /(^|[;{\s])color:\s*var\(--faint\)/m);
});

test('a pill keeps its own text color inside an agent row', () => {
  assert.match(css, /\.pill\s*\{[^}]*color:\s*var\(--on-accent\)/);
  assert.match(css, /\.agent \.who span:not\(\.pill\)/);
});

test('checkboxes and radio buttons use the accent color', () => {
  assert.match(css, /input\[type="checkbox"\],\s*input\[type="radio"\]\s*\{[^}]*accent-color:\s*var\(--accent\)/);
});

test('the Overview shows the Owner decisions before the alerts and has one allocation link', () => {
  const page = body('overview');
  assert.ok(page.indexOf('decisionSummary(s)') >= 0 && page.indexOf('decisionSummary(s)') < page.indexOf('overview-action-grid'), 'decisions come before Needs attention');
  assert.ok(page.indexOf('guidanceFold(s)') < page.indexOf('decisionSummary(s)'), 'the guidance stays first');
  const { allocationSummary } = load(['allocationSummary'], {
    projectSlugs: () => ['a'], allocationSegment: () => '<i></i>', compactPercent: (x) => x,
  });
  const s = { control: { projects: { a: { slug: 'a', share: 50 } } } };
  assert.match(allocationSummary(s), /href="\/allocation"/);
  assert.doesNotMatch(allocationSummary(s, { link: false }), /href="\/allocation"/);
  assert.match(body('fleetBlock'), /allocationSummary\(s, \{ link: false \}\)/);
});

test('the decision summary has no colored side stripe', () => {
  for (const m of css.matchAll(/\.decisions-summary[^{]*\{([^}]*)\}/g)) assert.doesNotMatch(m[1], /border-left:\s*[2-9]/);
});

test('the Overview continuity section is one slim line when no handover needs action', () => {
  const { handoffBlock } = load(['handoffBlock'], { openHandoffRecords: () => [], handoffRecords: [] });
  const html = handoffBlock({ control: { handoffs: [] }, herdr: { panes: [] } });
  assert.match(html, /class="handoff-section handoff-none"/);
  assert.doesNotMatch(html, /handoff-list/);
  assert.match(css, /\.overview-action-grid:has\(> \.handoff-none\)\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test('the Watch box is a fold that is closed without a watch and open while a watch runs', () => {
  const store = new Map();
  const context = {
    watchForm: { until: '2026-01-01T08:00', forever: false, daily: false, report: '07:30', routines: {}, adhoc: '' },
    nightBusy: false, nightMessage: '',
    localInputValue: (x) => x, defaultWatchUntil: () => '', watchUntilPhrase: () => 'until 08:00',
    watchRoutineLive: () => '<ul></ul>', watchRoutineFields: () => '<fieldset></fieldset>',
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    FOLD_PREFIX: 'fold.', AGENTS_FOLD: '~agents',
  };
  const { watchPanel } = load(['foldState', 'foldOpen', 'foldCard', 'watchPanel'], context);
  const off = watchPanel({ night: { active: false } });
  assert.match(off, /^<details[^>]*id="watch"/);
  assert.doesNotMatch(off, /^<details[^>]* open>/);
  assert.match(off, /No watch runs\./);
  assert.match(off, /data-night-start/);
  const on = watchPanel({ night: { active: true } });
  assert.match(on, /^<details[^>]* open>/);
  assert.match(on, /On watch until 08:00/);
});

test('an address with a hash opens a closed fold that it names', () => {
  const { revealHash } = load(['revealHash'], {
    location: { hash: '#watch' },
    requestAnimationFrame: (fn) => fn(),
    document: { getElementById: (id) => (id === 'watch' ? target : null) },
  });
  const target = { tagName: 'DETAILS', open: false, scrolled: false, scrollIntoView() { this.scrolled = true; } };
  revealHash();
  assert.deepEqual([target.open, target.scrolled], [true, true]);
});

test('the Board search on a phone has no key hint, and a card chip on a phone is not a link', () => {
  const ctx = { fleet: { project: '', who: '', state: '', query: '' }, fleetWho: () => ({ kinds: [], models: [] }), HARNESS_NAMES: {}, FLOW: ['blocked', 'ready', 'doing', 'review', 'done'], fleetColLabel: (k) => k, WHO_LABEL: { owner: 'o', worker: 'w' } };
  const { fleetToolbar } = load(['fleetToolbar'], ctx);
  assert.match(fleetToolbar([], [], true), /placeholder="Search tasks"/);
  assert.match(fleetToolbar([], [], false), /placeholder="Search tasks \(press \/\)"/);
  const { fleetChip } = load(['fleetChip'], { avatarSlot: () => '<i></i>' });
  assert.match(fleetChip({ slug: 'a', label: 'A' }), /^<a class="proj-chip"/);
  assert.match(fleetChip({ slug: 'a', label: 'A' }, { plain: true }), /^<span class="proj-chip"/);
});

test('the phone check covers the Board page and the header height', () => {
  assert.match(phoneCheck, /'\/board'/);
  assert.match(phoneCheck, /header/i);
});

test('the compact phone table and the 44 px link rule reach only the Overview project table', () => {
  assert.match(body('fleetBlock'), /<table class="fleet-table overview-projects">/);
  for (const m of css.matchAll(/([^{}]*)\{[^}]*\}/g)) {
    const selectors = m[1].split(',').map((x) => x.trim());
    for (const sel of selectors) {
      if (/\.fleet-table (tr|td)\b/.test(sel) && /grid-(column|row|template-columns)|content:\s*" workers"/.test(m[0])) assert.match(sel, /\.fleet-table\.overview-projects/, `${sel} is scoped to the Overview table`);
    }
    assert.ok(!selectors.some((x) => /\.fleet-table td\)? a$|\.fleet-table td\) a/.test(x)), 'no 44 px rule for every table link');
  }
  const targets = /:is\(([^)]*)\) a, \.decision-mail/.exec(css)[1];
  assert.doesNotMatch(targets, /(^|, )\.section-head(,|$)/);
  assert.doesNotMatch(targets, /\.fleet-table td/);
});
