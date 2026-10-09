import './helpers/test-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = (name) => fs.readFileSync(path.join(publicDir, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// The selectors of the rules at the top level of a style sheet. Rules inside @media blocks are included.
function selectors(css) {
  const found = [];
  for (const match of css.matchAll(/(?:^|[}{;])\s*([^{}@;]+)\{/g)) {
    for (const part of match[1].split(',')) found.push(part.trim());
  }
  return found.filter(Boolean);
}

// A selector that starts with a bare class, for example `.proj` or `.proj:hover` or `.proj .slug`. Return the class.
const firstClass = (selector) => /^\.([a-zA-Z][\w-]*)(?![\w-])/.exec(selector)?.[1] ?? null;

test('Fleet style sheet does not restyle a class that the main style sheet owns', () => {
  const main = new Set(selectors(read('style.css')).map(firstClass).filter(Boolean));
  // Classes that fleet.css defines for its own page and that the main sheet uses with the same meaning.
  const shared = new Set(['panel', 'tag', 'small', 'mono', 'legend', 'win-foot']);
  const collisions = selectors(read('fleet.css'))
    .map((selector) => [selector, firstClass(selector)])
    .filter(([, name]) => name && main.has(name) && !shared.has(name))
    .map(([selector]) => selector);
  // Known collisions that need their own review (follow-up PG1b). A new collision fails this test.
  const known = ['.sev', '.sev.error', '.sev.warning', '.sev.info', '.card', '.card p[data-fleet-claude-helper]', '.bar', '.bar i', '.bar i.warn', '.bar i.crit'];
  assert.deepEqual([...new Set(collisions)].filter((selector) => !known.includes(selector)), [], 'scope each of these selectors under .fleet-page or .projects');
});

test('the project card selectors in the main sheet are not overridden by fleet.css', () => {
  const fleet = selectors(read('fleet.css'));
  for (const name of ['proj', 'proj-head', 'project-selector', 'seg']) {
    assert.equal(fleet.some((selector) => firstClass(selector) === name), false, `fleet.css must not start a selector with .${name}`);
  }
});
