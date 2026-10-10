import './helpers/test-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const read = (name) => strip(fs.readFileSync(path.join(publicDir, name), 'utf8'));

// The main sheet and the theme sheet style every page. Each other sheet belongs to one page and keeps its rules under the
// scope names of that page. The index.html file loads all of them on every page, so an unscoped rule leaks to all pages.
const SHARED_SHEETS = ['style.css', 'theme.css'];
const PAGE_SHEETS = {
  'fleet.css': /^(fleet|projects$)/,
  'docs.css': /^docs?(-|$)|^help-body$/,
  'host-guide.css': /^hg-/,
  'explainer.css': /^(ex-|explainer$)/,
};

// The selectors of all rules, also inside @media and @supports blocks. A keyframe step such as `from` has no class.
function selectors(css) {
  const found = [];
  for (const match of css.matchAll(/(?:^|[}{;])\s*([^{}@;]+)\{/g)) {
    for (const part of match[1].split(',')) found.push(part.trim());
  }
  return found.filter(Boolean);
}

// The first class of a selector that starts with a class, for example `.proj` of `.proj:hover .slug`.
const firstClass = (selector) => /^\.([a-zA-Z][\w-]*)(?![\w-])/.exec(selector)?.[1] ?? null;

test('every page style sheet is known to this test', () => {
  const sheets = fs.readdirSync(publicDir).filter((name) => name.endsWith('.css'));
  const unknown = sheets.filter((name) => !SHARED_SHEETS.includes(name) && !(name in PAGE_SHEETS));
  assert.deepEqual(unknown, [], 'add the sheet to PAGE_SHEETS with its scope names, or to SHARED_SHEETS');
});

test('a page style sheet never starts a selector with a class that another sheet also styles', () => {
  const firstClassesOf = (name) => new Set(selectors(read(name)).map(firstClass).filter(Boolean));
  const owners = new Map();
  for (const name of [...SHARED_SHEETS, ...Object.keys(PAGE_SHEETS)]) {
    for (const cls of firstClassesOf(name)) owners.set(cls, [...(owners.get(cls) || []), name]);
  }
  const collisions = [];
  for (const [sheet, scope] of Object.entries(PAGE_SHEETS)) {
    for (const selector of selectors(read(sheet))) {
      const cls = firstClass(selector);
      if (!cls || scope.test(cls)) continue;
      // An unscoped class of a page sheet that also starts a selector in another sheet leaks into the other page.
      if ((owners.get(cls) || []).some((owner) => owner !== sheet)) collisions.push(`${sheet}: ${selector}`);
    }
  }
  assert.deepEqual([...new Set(collisions)], [], 'put the selector under the scope class of its page, for example .fleet-page .card');
});

test('the Projects page card classes are not restyled by a page sheet', () => {
  for (const sheet of Object.keys(PAGE_SHEETS)) {
    const bad = selectors(read(sheet)).filter((selector) => ['proj', 'proj-head', 'project-selector', 'seg', 'card', 'bar', 'sev', 'board', 'stale'].includes(firstClass(selector)));
    assert.deepEqual(bad, [], `${sheet} must not start a selector with a class of the main sheet`);
  }
});

test('wide pages use the viewport width and responsive minimum-width grids', () => {
  const css = read('style.css');
  const rule = (selector) => css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`))?.[1] || '';
  const grid = (selector) => {
    const declaration = rule(selector);
    assert.match(declaration, /grid-template-columns:\s*repeat\(auto-(?:fill|fit),\s*minmax\(/, `${selector} must fill available width with responsive cards`);
    assert.match(declaration, /min\(100%,\s*\d+px\)/, `${selector} must keep one card on a phone`);
  };

  assert.doesNotMatch(rule('main'), /max-width\s*:/, 'main must use the viewport width');
  grid('\\.control-grid > div');
  grid('\\.settings-grid');
  grid('\\.board-cols');
  grid('\\.ws-grid');
  grid('\\.project-selector-grid');
});

test('browser bookmark summary keeps a 44px target in the browser layout', () => {
  const css = read('style.css');
  const rule = (selector) => css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`))?.[1] || '';
  const layout = rule('\\.browser-bookmarks');
  const summary = rule('\\.browser-bookmarks > summary');
  assert.match(layout, /display:\s*grid/);
  assert.match(summary, /display:\s*flex/);
  assert.match(summary, /align-items:\s*center/);
  assert.match(summary, /min-height:\s*44px/);
});
