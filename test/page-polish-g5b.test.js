// The G5b page pass: the Allocation, Browsers, and Settings pages share the buttons, the segmented control,
// and the form rows of the other pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const body = (name) => { const start = source.indexOf(`function ${name}(`); assert.ok(start >= 0, `${name} exists`); return source.slice(start, source.indexOf('\n}\n', start)); };
function load(names, context = {}) {
  const code = names.map((name) => body(name) + '\n}\n').join('\n');
  const ctx = { ...context };
  vm.runInNewContext(`${code}\nthis.fns = { ${names.join(', ')} };`, ctx);
  return ctx.fns;
}

test('the pacing goal rows use classes, not inline styles', () => {
  const settings = body('settingsView');
  assert.doesNotMatch(settings, /style="display:grid/);
  assert.match(settings, /class="setting-line goal-row"/);
  assert.match(css, /\.goal-row\s*\{[^}]*display:\s*grid/);
});

test('a goal row shows the reset time in local words, not as an ISO string', () => {
  const settings = body('settingsView');
  assert.doesNotMatch(settings, /Resets \$\{esc\(resetsAt/);
  assert.match(settings, /Resets \$\{esc\(resetWhen\(resetsAt\)\)/);
  const { resetWhen } = load(['resetWhen']);
  assert.equal(resetWhen(null), 'unknown');
  assert.equal(resetWhen('not a date'), 'unknown');
  const text = resetWhen('2026-10-03T04:58:01.429Z');
  assert.doesNotMatch(text, /T\d\d:\d\d:\d\d/);
  assert.match(text, /\d\d:\d\d/);
});

test('the Token prices card spans the settings grid and keeps each model name on one line', () => {
  assert.match(css, /\.settings-grid > #price-settings\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
  assert.match(css, /#price-settings tbody th code\s*\{[^}]*white-space:\s*nowrap/);
});

test('the browser view toggle is the shared segmented control', () => {
  assert.match(css, /:is\([^)]*\.browser-view-toggle[^)]*\)\s*\{[^}]*padding:\s*3px/);
  assert.doesNotMatch(css, /#app \.browser-view-toggle button/);
});

test('secondary actions on the three pages use the secondary button style', () => {
  const rule = /:root :is\(([^)]*)\)\s*\{[^}]*background:\s*var\(--panel-2\)[^}]*color:\s*var\(--text\)/.exec(css);
  assert.ok(rule, 'one secondary button rule exists');
  for (const sel of ['[data-ladder-add]', '[data-pool-add]', '[data-avatar-reset]', '[data-save-service-settings]']) assert.ok(rule[1].includes(sel), `${sel} is secondary`);
  assert.doesNotMatch(css, /\.browser-card \.browser-preview-toggle, \.browser-card \[data-browser-refresh\] \{ border-color: var\(--accent\)/);
});

test('the lease head keeps its note next to the title', () => {
  assert.match(css, /\.lease-panel > \.section-head > span\s*\{[^}]*margin-right:\s*auto/);
  assert.match(css, /\.lease-panel > \.setting-help\s*\{[^}]*max-width:\s*76ch/);
});

test('the avatar upload is one button with a hidden native file input', () => {
  assert.match(css, /\.avatar-upload input\[type="file"\]\s*\{[^}]*clip-path/);
  assert.match(css, /\.avatar-upload:focus-within/);
});

test('settings selects use the sans font so a phone shows the whole choice', () => {
  assert.match(css, /:is\(#control-plane, #settings-plane\) select\s*\{[^}]*font-family:\s*var\(--sans\)/);
});

test('the Settings goal row rule does not restyle the goal details fold', () => {
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /^\.goal-field \{ display: grid/m);
  assert.match(css, /\.goal-row > \.goal-field \{ display: grid/);
});
