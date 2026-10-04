// The vendored Mermaid build. One test checks the recorded hash of the file. Another test parses
// every Mermaid block of README.md and docs/ with the real parser of the vendored build.
// The browser build needs a DOM. The test gives it a minimal stub, so the parser runs in Node.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(root, 'public/vendor/mermaid.min.js');
const VENDOR_README = path.join(root, 'public/vendor/README.md');
const ADR = path.join(root, 'docs/adr/0026-vendored-mermaid.md');

function markdownFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) markdownFiles(file, out);
    else if (entry.name.endsWith('.md')) out.push(file);
  }
  return out;
}

// The source of each fenced block whose info string is `mermaid`.
function mermaidBlocks(source) {
  const blocks = [];
  let open = null;
  for (const line of source.split(/\r?\n/)) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open) {
      if (fence && fence[1][0] === open.fence[0] && fence[1].length >= open.fence.length && !fence[2].trim()) {
        blocks.push(open.lines.join('\n'));
        open = null;
      } else open.lines.push(line);
      continue;
    }
    if (fence && /^mermaid\b/i.test(fence[2].trim())) open = { fence: fence[1], lines: [] };
  }
  return blocks;
}

// The minimal DOM that the browser build needs to parse a diagram with labels and subgraphs.
function loadVendoredMermaid() {
  const element = () => ({
    nodeType: 1, attributes: [], childNodes: [], style: {}, innerHTML: '', textContent: '',
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {}, appendChild() {}, removeChild() {},
    cloneNode: () => element(), addEventListener() {}, querySelectorAll: () => [], querySelector: () => null,
  });
  const document = {
    nodeType: 9, body: element(), head: element(), documentElement: element(),
    createElement: () => element(), createElementNS: () => element(),
    createDocumentFragment: () => ({ nodeType: 11, childNodes: [], appendChild() {} }),
    createTextNode: (text) => ({ nodeType: 3, textContent: text }),
    implementation: { createHTMLDocument: () => document },
    querySelectorAll: () => [], querySelector: () => null,
    addEventListener() {}, removeEventListener() {},
  };
  const sandbox = { console, setTimeout, clearTimeout, setInterval, clearInterval, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true };
  Object.assign(sandbox, {
    window: sandbox, self: sandbox, globalThis: sandbox, document, navigator: { userAgent: 'node' },
    DOMParser: class { parseFromString() { return document; } },
    Node: class {}, Element: class {}, HTMLElement: class {},
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4, SHOW_COMMENT: 128 },
    trustedTypes: undefined,
  });
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(VENDOR, 'utf8'), context, { filename: 'mermaid.min.js' });
  return sandbox.mermaid;
}

test('the vendored Mermaid file matches the recorded hash', () => {
  const hash = createHash('sha256').update(fs.readFileSync(VENDOR)).digest('hex');
  const recorded = /SHA-256\s*\|\s*`([0-9a-f]{64})`/.exec(fs.readFileSync(VENDOR_README, 'utf8'))?.[1];
  assert.ok(recorded, 'public/vendor/README.md records the SHA-256');
  assert.equal(hash, recorded);
  assert.match(fs.readFileSync(ADR, 'utf8'), new RegExp(recorded), 'the ADR records the same hash');
});

test('every Mermaid block in README.md and docs/ parses', async () => {
  const mermaid = loadVendoredMermaid();
  const files = [...markdownFiles(path.join(root, 'docs')), path.join(root, 'README.md')];
  const failures = [];
  let count = 0;
  for (const file of files) {
    for (const block of mermaidBlocks(fs.readFileSync(file, 'utf8'))) {
      count += 1;
      try {
        await mermaid.parse(block);
      } catch (error) {
        failures.push(`${path.relative(root, file)}: ${String(error.message).split('\n')[0]}`);
      }
    }
  }
  assert.ok(count > 0, 'the documentation holds at least one Mermaid block');
  assert.deepEqual(failures, []);
});
