import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MEASURE_LIMITS, capMeasurement, measureScript, parseMeasureOptions } from '../src/browser-measure.js';
import { browserMeasure } from '../src/browser-preview.js';
import { formatBrowserJson } from '../src/cli.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

// A fake DOM that can run the fixed measure script through new Function.
function fakePage({ nodes = {}, text = 'Hello world', width = 800, height = 600, dpr = 2, scrollWidth = 1200, clientWidth = 800, url = 'https://tenant1.example.test/dash' } = {}) {
  const nodesBySelector = new Map(Object.entries(nodes));
  const styleOf = new Map();
  const getComputedStyle = (node) => styleOf.get(node) || {
    fontSize: '16px', color: 'rgb(17, 34, 51)', backgroundColor: 'rgba(0, 0, 0, 0)', display: 'block', visibility: 'visible',
  };
  const windowObj = { innerWidth: width, innerHeight: height, devicePixelRatio: dpr, getComputedStyle };
  const documentObj = {
    documentElement: { scrollWidth, clientWidth },
    body: { innerText: text },
    querySelectorAll(selector) {
      if (/^!/.test(selector)) throw new Error('invalid selector');
      const listed = nodesBySelector.get(selector);
      return typeof listed === 'function' ? listed(selector) : listed || [];
    },
  };
  const evaluate = (script) => new Function('document', 'window', 'getComputedStyle', 'location', `return (${script});`)
    (documentObj, windowObj, getComputedStyle, { href: url });
  return { evaluate, windowObj, styleOf };
}

// A fake browser client that answers the one Runtime.evaluate with a fixed measurement.
function measureAdapters(measurement, evaluateRequests = []) {
  return {
    verifySession: async () => ({ port: 9223 }),
    listTargets: async () => [{ id: 'tab-1', webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/1' }],
    listViewports: () => ({}),
    commands: async (_endpoint, requests) => {
      const results = [];
      for (const entry of requests) {
        const request = typeof entry === 'function' ? entry({}) : entry;
        if (request.method === 'Runtime.evaluate') evaluateRequests.push(request);
        results.push({ result: { type: 'object', value: measurement } });
      }
      return results;
    },
  };
}

function baseMeasurement() {
  return {
    viewport: { width: 800, height: 600, devicePixelRatio: 2 },
    overflow: { scrollWidth: 1200, clientWidth: 800, innerWidth: 800, horizontal: true },
    selectors: [],
    visibleTextLength: 12345,
    url: 'https://tenant1.example.test/dash',
  };
}

function bigItem(color = `#${'a1'.repeat(40)}`) {
  return { x: 123.4, y: 56.7, width: 89.1, height: 20, fontSize: '14px', color, backgroundColor: color, visible: true };
}

test('measure script returns viewport, overflow, selectors, visible text length, and the URL', () => {
  const first = { getBoundingClientRect: () => ({ x: 10.25, y: 20.45, width: 100.55, height: 30.65 }) };
  const hidden = { getBoundingClientRect: () => ({ x: 0, y: 0, width: 400, height: 0 }) };
  const page = fakePage({ nodes: { h1: [first, hidden], '.missing': [] } });
  page.styleOf.set(first, { fontSize: '22px', color: 'rgb(255, 0, 0)', backgroundColor: 'rgb(0, 0, 255)', display: 'block', visibility: 'visible' });
  page.styleOf.set(hidden, { fontSize: '12px', color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)', display: 'none', visibility: 'hidden' });
  const output = page.evaluate(measureScript(['h1', '.missing', '!!!bad']));
  assert.deepEqual(output.viewport, { width: 800, height: 600, devicePixelRatio: 2 });
  assert.deepEqual(output.overflow, { scrollWidth: 1200, clientWidth: 800, innerWidth: 800, horizontal: true });
  assert.equal(output.selectors.length, 3);
  assert.equal(output.selectors[0].count, 2);
  assert.deepEqual(output.selectors[0].items[0], {
    x: 10.3, y: 20.5, width: 100.6, height: 30.7,
    fontSize: '22px', color: 'rgb(255, 0, 0)', backgroundColor: 'rgb(0, 0, 255)', visible: true,
  });
  assert.deepEqual(output.selectors[0].items[1], {
    x: 0, y: 0, width: 400, height: 0,
    fontSize: '12px', color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)', visible: false,
  });
  assert.deepEqual(output.selectors[1], { selector: '.missing', count: 0 });
  assert.deepEqual(output.selectors[2], { selector: '!!!bad', error: 'invalid selector' });
  assert.equal(output.visibleTextLength, 11);
  assert.equal(output.url, 'https://tenant1.example.test/dash');
  assert.ok(!JSON.stringify(output).includes('Hello world'), 'measure output must not contain the page text');
});

test('measure script passes selectors as JSON data and a hostile selector cannot inject code', () => {
  const page = fakePage();
  const hostile = 'x");window.__pwned=true;//';
  const output = page.evaluate(measureScript([hostile]));
  assert.equal(page.windowObj.__pwned, undefined, 'A hostile selector must not execute inside the measure script');
  assert.equal(output.selectors[0].count, 0);
  assert.ok(measureScript([hostile]).includes(JSON.stringify([hostile])));
});

test('measure script keeps a constant script text and a single data point', () => {
  assert.ok(measureScript(['h1']).includes('["h1"]'), 'the JSON array is embedded as data');
  assert.equal(measureScript(['h1']).replace('["h1"]', '[]'), measureScript([]), 'only the JSON data differs between calls');
});

test('measure script treats a dollar and a backtick in a selector as data', () => {
  const page = fakePage();
  const selector = 'a$`b';
  const script = measureScript([selector]);
  assert.ok(script.includes(JSON.stringify([selector])), 'the JSON data stays intact in the script text');
  const output = page.evaluate(script);
  assert.deepEqual(output.selectors[0], { selector, count: 0 });
});

test('measure script counts all matches while listing at most 20 items', () => {
  const nodes = Array.from({ length: 25 }, () => ({ getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10 }) }));
  const page = fakePage({ nodes: { li: nodes } });
  const output = page.evaluate(measureScript(['li']));
  assert.equal(output.selectors[0].count, 25, 'count holds the number of matched nodes');
  assert.equal(output.selectors[0].items.length, 20, 'the item list keeps the limit of 20');
});

test('measure script sanitizes page-controlled numbers and style strings', () => {
  const hostile = { getBoundingClientRect: () => ({ x: '10px', y: Infinity, width: 100, height: 50 }) };
  const clean = { getBoundingClientRect: () => ({ x: 10.2, y: 20.3, width: 30.4, height: 40.5 }) };
  const page = fakePage({ nodes: { h1: [hostile, clean] }, text: { length: Infinity } });
  page.styleOf.set(hostile, { fontSize: 'x'.repeat(100), color: 'url(https://tenant1.example.test/leak)', backgroundColor: 'rgb(0, 0, 0)', display: 'block', visibility: 'visible' });
  page.styleOf.set(clean, { fontSize: '16px', color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(1, 2, 3, 0.5)', display: 'block', visibility: 'visible' });
  const output = page.evaluate(measureScript(['h1']));
  assert.deepEqual(output.selectors[0].items[0], {
    x: null, y: null, width: 100, height: 50,
    fontSize: null, color: null, backgroundColor: 'rgb(0, 0, 0)', visible: true,
  });
  assert.deepEqual(output.selectors[0].items[1], {
    x: 10.2, y: 20.3, width: 30.4, height: 40.5,
    fontSize: '16px', color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(1, 2, 3, 0.5)', visible: true,
  });
  assert.equal(output.visibleTextLength, 0, 'a non-finite text length becomes 0');
});

test('browserMeasure reads one Runtime.evaluate and returns the measurement', async () => {
  const evaluateRequests = [];
  const adapters = measureAdapters(baseMeasurement(), evaluateRequests);
  const result = await browserMeasure('alpha', 'tab-1', ['h1', 'p.note'], adapters);
  assert.deepEqual(result, baseMeasurement());
  assert.equal(evaluateRequests.length, 1);
  assert.equal(evaluateRequests[0].method, 'Runtime.evaluate');
  assert.equal(evaluateRequests[0].params.returnByValue, true);
  assert.ok(evaluateRequests[0].params.expression.includes(JSON.stringify(['h1', 'p.note'])), 'selectors travel as JSON data');
});

test('browserMeasure maps a page exception to a fixed error without page text', async () => {
  const adapters = measureAdapters(null);
  adapters.commands = async () => [{ result: { type: 'object', value: null }, exceptionDetails: { text: 'Script failed.', exception: { description: 'secret tenant details from the page' } } }];
  await assert.rejects(browserMeasure('alpha', 'tab-1', ['h1'], adapters), (error) => {
    assert.equal(error.message, 'The page could not be measured.');
    assert.ok(!error.message.includes('secret'), 'the error must not carry page text');
    return true;
  });
});

test('capMeasurement leaves a measured output under the limit untouched', () => {
  const small = { ...baseMeasurement(), selectors: [{ selector: 'h1', count: 1, items: [bigItem()] }] };
  assert.deepEqual(capMeasurement(small), small);
});

test('capMeasurement cuts the biggest item lists until the JSON fits in 20 KB and sets truncated', () => {
  const measurement = baseMeasurement();
  const counts = [];
  for (let index = 0; index < 10; index++) {
    counts.push(47 + index);
    measurement.selectors.push({ selector: `s${index}`, count: counts[index], items: Array.from({ length: MEASURE_LIMITS.items }, () => bigItem()) });
  }
  const capped = capMeasurement(measurement);
  assert.equal(capped.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(capped, null, 2), 'utf8') <= MEASURE_LIMITS.bytes);
  assert.equal(capped.selectors.length, 10, 'item cutting must not remove selector entries when it can fit');
  const total = capped.selectors.reduce((sum, entry) => sum + entry.items.length, 0);
  assert.ok(total < 200, 'the biggest item lists were cut');
  assert.ok(total >= 10, 'item cutting stops as soon as the JSON fits');
  for (const entry of capped.selectors) assert.ok(entry.items.length <= MEASURE_LIMITS.items, 'no item list exceeds the limit');
  capped.selectors.forEach((entry, index) => assert.equal(entry.count, counts[index], 'count keeps the matched-node number while item cutting trims the list'));
});

test('capMeasurement removes selectors and then shortens the URL as a last resort', () => {
  const withUrl = { ...baseMeasurement(), url: `https://tenant1.example.test/${'abcdef'.repeat(8000)}` };
  const capped = capMeasurement(withUrl);
  assert.equal(capped.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(capped, null, 2), 'utf8') <= MEASURE_LIMITS.bytes);
  assert.ok(capped.url.length < withUrl.url.length);
});

test('parseMeasureOptions reads --tab and repeated --selector', () => {
  assert.deepEqual(parseMeasureOptions(['--tab', 'tab-1', '--selector', 'h1', '--selector', 'p.note']), { tab: 'tab-1', selectors: ['h1', 'p.note'] });
  assert.deepEqual(parseMeasureOptions(['--selector', 'h1']), { tab: null, selectors: ['h1'] });
});

test('parseMeasureOptions refuses no selector, an unknown flag, too many selectors, and an overlong selector', () => {
  assert.throws(() => parseMeasureOptions([]), /Use --tab ID and --selector CSS to measure a page/);
  assert.throws(() => parseMeasureOptions(['--tab', 'tab-1']), /Use --tab ID and --selector CSS to measure a page/);
  assert.throws(() => parseMeasureOptions(['--selector', 'h1', '--out', 'dir']), /Use --tab ID and --selector CSS to measure a page/);
  const many = [];
  for (let index = 0; index < MEASURE_LIMITS.selectors + 1; index++) many.push('--selector', `s${index}`);
  assert.throws(() => parseMeasureOptions(many), /Use at most 10 selectors/);
  assert.throws(() => parseMeasureOptions(['--selector', 'x'.repeat(MEASURE_LIMITS.selectorChars + 1)]), /Each selector must be at most 200 characters/);
});

test('formatBrowserJson masks the measured URL host and keeps numbers only for the text', () => {
  const measurement = {
    viewport: { width: 800, height: 600, devicePixelRatio: 2 },
    overflow: { scrollWidth: 1200, clientWidth: 800, innerWidth: 800, horizontal: true },
    selectors: [{ selector: 'h1', count: 1, items: [bigItem()] }],
    visibleTextLength: 11,
    url: 'https://tenant1.example.test/dash?code=abc',
  };
  const text = formatBrowserJson(measurement);
  const parsed = JSON.parse(text);
  assert.equal(parsed.url, 'https://<tenant>.example.test/dash');
  assert.equal(parsed.visibleTextLength, 11);
  assert.equal(parsed.viewport.width, 800);
  assert.ok(!text.includes('Hello world'));
});

test('CLI usage lists the browser measure form', () => {
  const result = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /browser measure SLUG \[--tab ID\] \[--selector CSS \.\.\.\]/);
});

function browserCliFixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-browser-measure-'));
  const root = path.join(base, 'project');
  const dataDir = path.join(base, 'data');
  const home = path.join(base, 'home');
  const bin = path.join(base, 'bin');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(dataDir);
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ slug: 'alpha' }));
  fs.writeFileSync(path.join(dataDir, 'browser-sessions.json'), JSON.stringify({
    alpha: { project: 'alpha', port: 1, profile: path.join(dataDir, 'browser-profiles', 'alpha'), headless: true, windowSize: { width: 1280, height: 800 }, bookmarks: [], startPage: null },
    beta: { project: 'beta', port: 1, profile: path.join(dataDir, 'browser-profiles', 'beta'), headless: true, windowSize: { width: 1280, height: 800 }, bookmarks: [], startPage: null },
  }));
  fs.writeFileSync(path.join(dataDir, 'rules.json'), JSON.stringify({ control: { workspaces: [
    { slug: 'alpha', workspace: 'workspace-alpha', label: 'Alpha', boss: false },
    { slug: 'beta', workspace: 'workspace-beta', label: 'Beta', boss: false },
    { slug: 'boss', workspace: 'workspace-boss', label: 'Boss', boss: true },
  ] } }));
  fs.writeFileSync(path.join(bin, 'herdr'), `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args[0] !== 'pane' || args[1] !== 'get') process.exit(2);\nconst id = args[2];\nconst label = id === 'boss-pane' ? 'boss' : id === 'worker-pane' ? 'worker' : id === 'helper-pane' ? undefined : 'orch';\nconsole.log(JSON.stringify({ result: { pane: { pane_id: id, workspace_id: process.env.HERDR_WORKSPACE_ID, label } } }));\n`, { mode: 0o755 });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const envFor = ({ pane = 'orch-pane', workspace = 'workspace-alpha' } = {}) => {
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, HERDR_BOSS_DIR: dataDir };
    delete env.HERDR_PANE_ID;
    delete env.HERDR_WORKSPACE_ID;
    delete env.HERDR_ENV;
    delete env.HERDR_WORKTREE;
    if (pane) Object.assign(env, { HERDR_ENV: '1', HERDR_PANE_ID: pane, HERDR_WORKSPACE_ID: workspace });
    return env;
  };
  const run = (args, options = {}) => spawnSync(process.execPath, [CLI, 'browser', ...args], {
    cwd: options.cwd ?? root,
    env: envFor(options),
    encoding: 'utf8',
  });
  return { base, root, dataDir, run };
}

test('browser measure refuses another project browser', (t) => {
  const fixture = browserCliFixture(t);
  const result = fixture.run(['measure', 'beta', '--selector', 'h1']);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr.trim(), 'The beta browser belongs to project beta. This pane is in workspace Alpha (workspace-alpha), which belongs to project alpha. Only a pane in the beta workspace or the Boss can change it.');
});