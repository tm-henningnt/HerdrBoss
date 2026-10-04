// The Docs diagrams. The Docs page imports this module only when it shows at least one Mermaid block.
// The module loads the vendored Mermaid build with a script element, draws each block, and keeps the
// source fold when the library or a diagram fails. It uses no CDN and no other network call.
import { showFallback } from './docs-fallback.js';

export const VENDOR_URL = '/vendor/mermaid.min.js';

let vendorPromise = null;
let counter = 0;
let themeBound = false;

// A test resets the cached load between cases.
export function resetMermaidLoader() { vendorPromise = null; }

// The colors of the dashboard, so the diagram matches the page.
export function themeVariables(doc) {
  const style = doc?.defaultView?.getComputedStyle?.(doc.documentElement);
  const read = (name, fallback) => (style?.getPropertyValue?.(name) || '').trim() || fallback;
  return {
    background: 'transparent',
    primaryColor: read('--panel-2', '#f8f6f2'),
    primaryTextColor: read('--text', '#1d1b18'),
    primaryBorderColor: read('--line', '#e3dfd7'),
    lineColor: read('--muted', '#6f6a61'),
    secondaryColor: read('--panel', '#ffffff'),
    tertiaryColor: read('--panel', '#ffffff'),
    clusterBkg: read('--panel-2', '#f8f6f2'),
    clusterBorder: read('--line', '#e3dfd7'),
    edgeLabelBackground: read('--panel', '#ffffff'),
    fontFamily: read('--sans', 'sans-serif'),
  };
}

// Loads the vendored build once with a script element. A failed load can be retried.
export function loadMermaid(doc = globalThis.document, url = VENDOR_URL) {
  if (globalThis.mermaid) return Promise.resolve(globalThis.mermaid);
  if (vendorPromise) return vendorPromise;
  vendorPromise = new Promise((resolve, reject) => {
    const script = doc.createElement('script');
    script.src = url;
    script.async = true;
    script.addEventListener('load', () => (globalThis.mermaid ? resolve(globalThis.mermaid) : reject(new Error('The diagram library did not load.'))));
    script.addEventListener('error', () => reject(new Error('The diagram library did not load.')));
    (doc.head || doc.body).appendChild(script);
  });
  vendorPromise.catch(() => { vendorPromise = null; });
  return vendorPromise;
}

async function drawBlock(block, mermaid, doc) {
  const view = block.querySelector('[data-mermaid-view]');
  const source = block.querySelector('code.language-mermaid');
  const error = block.querySelector('[data-mermaid-error]');
  const fold = block.querySelector('[data-mermaid-source]');
  if (!view || !source) return;
  try {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: themeVariables(doc),
      flowchart: { htmlLabels: true, useMaxWidth: true },
    });
    const { svg } = await mermaid.render(`docs-mermaid-${++counter}`, source.textContent || '');
    view.innerHTML = svg;
    view.hidden = false;
    if (error) error.hidden = true;
    if (fold) fold.hidden = true;
  } catch {
    showFallback(block);
  }
}

// Draws each block again when the system theme changes.
function bindTheme(mermaid, doc) {
  const media = doc?.defaultView?.matchMedia?.('(prefers-color-scheme: dark)');
  if (themeBound || !media?.addEventListener) return;
  themeBound = true;
  media.addEventListener('change', () => {
    for (const block of doc.querySelectorAll('[data-mermaid]')) {
      if (block.isConnected !== false) void drawBlock(block, mermaid, doc);
    }
  });
}

// Draws each block. `blocks` holds the [data-mermaid] elements of the page. `load` loads Mermaid;
// a test replaces it. A page without a block never calls `load`.
export async function mountDiagrams(blocks, { doc, load } = {}) {
  const target = doc || globalThis.document;
  const list = [...blocks].filter((block) => block && block.dataset && block.dataset.mermaidDrawn !== '1' && block.isConnected !== false);
  if (!list.length) return;
  for (const block of list) block.dataset.mermaidDrawn = '1';
  let mermaid;
  try { mermaid = await (load ? load() : loadMermaid(target)); } catch { mermaid = null; }
  if (!mermaid) { for (const block of list) showFallback(block); return; }
  for (const block of list) await drawBlock(block, mermaid, target);
  bindTheme(mermaid, target);
}
