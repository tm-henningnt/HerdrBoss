import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// The price editor code of public/app.js runs here with a stub document and fetch. The prices are invented.
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = app.indexOf('// The price table of the Settings page.');
const end = app.indexOf("document.addEventListener('input', (e) => {\n  const input = e.target.closest?.('#price-settings");
assert.ok(start > 0 && end > start, 'the price editor block exists');
const block = app.slice(start, end);

function editor({ table, inputs = [], response }) {
  const calls = [];
  const status = { textContent: '' };
  const document = {
    querySelectorAll: () => inputs,
    querySelector: () => status,
  };
  const fetch = async (url, init) => { calls.push({ url, init }); return { ok: response.ok, json: async () => response.body }; };
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const api = new Function('document', 'fetch', 'esc', 'render', `let lastRender = 'x';\n${block}\nreturn { pricesPanel, savePrices, setTable: (t) => { priceTable = t; }, draft: priceDraft, message: () => priceMessage, table: () => priceTable, lastRender: () => lastRender };`)(document, fetch, esc, () => {});
  api.setTable(table);
  return { ...api, calls, status };
}

const table = {
  prices: {
    'claude/claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8, unconfirmed: ['cacheRead', 'cacheWrite', 'cacheWrite1h'], source: 'Anthropic API pricing', date: '2026-09-25' },
    'claude/claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4, removed: true, source: 'Anthropic API pricing', date: '2026-09-25' },
    'codex/gpt-6-luna': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  },
  defaults: {
    'claude/claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 },
    'codex/gpt-6-luna': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  },
  overrides: { models: {} },
};

test('the price editor lists each model with five price columns, the source, the date, and the unconfirmed marks', () => {
  const html = editor({ table }).pricesPanel();
  assert.match(html, /API-price equivalent/);
  for (const label of ['Input', 'Output', 'Cache read', 'Cache write 5 min', 'Cache write 1 h', 'Source']) assert.ok(html.includes(`>${label}<`), label);
  assert.equal((html.match(/data-price-field="cacheWrite1h"/g) || []).length, 3);
  assert.match(html, /claude\/claude-opus-5-5/);
  assert.match(html, /2026-09-25/);
  assert.equal((html.match(/>unconfirmed</g) || []).length, 3);
  assert.match(html, /removed/);
  assert.match(html, /data-save-prices/);
});

test('the price editor shows a draft value and a load failure', () => {
  const e = editor({ table });
  e.draft['claude/claude-opus-5-5'] = { input: '4.5' };
  assert.match(e.pricesPanel(), /value="4.5" data-price-model="claude\/claude-opus-5-5" data-price-field="input"/);
  e.setTable(null);
  assert.match(e.pricesPanel(), /not loaded/);
});

test('Save prices sends only the figures that differ from the defaults and shows the server error', async () => {
  const inputs = [
    { value: '4.5', dataset: { priceModel: 'claude/claude-opus-5-5', priceField: 'input' } },
    { value: '20', dataset: { priceModel: 'claude/claude-opus-5-5', priceField: 'output' } },
    { value: '', dataset: { priceModel: 'claude/claude-opus-5-5', priceField: 'cacheRead' } },
    { value: '0.3', dataset: { priceModel: 'codex/gpt-6-luna', priceField: 'cacheWrite' } },
  ];
  const bad = editor({ table, inputs, response: { ok: false, body: { ok: false, error: 'claude/claude-opus-5-5: input must be a number from 0 to 1000.' } } });
  const button = { disabled: false };
  await bad.savePrices(false, button);
  assert.equal(bad.calls[0].url, '/api/settings/prices');
  assert.equal(bad.calls[0].init.method, 'PUT');
  assert.deepEqual(JSON.parse(bad.calls[0].init.body), { models: { 'claude/claude-opus-5-5': { input: 4.5 }, 'codex/gpt-6-luna': { cacheWrite: 0.3 } } });
  assert.match(bad.status.textContent, /must be a number from 0 to 1000/);
  assert.equal(button.disabled, false);

  const next = { ...table, prices: { ...table.prices, 'claude/claude-opus-5-5': { ...table.prices['claude/claude-opus-5-5'], input: 4.5 } } };
  const good = editor({ table, inputs, response: { ok: true, body: { ok: true, ...next } } });
  good.draft['claude/claude-opus-5-5'] = { input: '4.5' };
  await good.savePrices(false, { disabled: false });
  assert.equal(good.message(), 'Saved.');
  assert.equal(good.table().prices['claude/claude-opus-5-5'].input, 4.5);
  assert.deepEqual(good.draft, {});
  assert.equal(good.lastRender(), '');
});

test('Reset to defaults sends an empty override', async () => {
  const e = editor({ table, response: { ok: true, body: { ok: true, ...table } } });
  await e.savePrices(true, { disabled: false });
  assert.deepEqual(JSON.parse(e.calls[0].init.body), { models: {} });
  assert.match(e.message(), /reset/);
});

test('the Settings page places the price editor in its own section and the help names it', () => {
  assert.match(app, /\$\{serviceSettings\}\$\{pricesPanel\(\)\}\$\{harnessPanel\}/);
  assert.match(app, /<h3>Token prices<\/h3>/);
  assert.match(app, /'\/api\/settings\/prices'\]/);
});
