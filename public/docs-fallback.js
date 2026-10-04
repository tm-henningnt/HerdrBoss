// The plain fallback of a Docs diagram. The source fold stays and the page shows one error line.
// `public/app.js` imports this module directly, so it can show the fallback also when the lazy
// diagram module does not load. `public/docs-diagrams.js` uses the same function for its failures.
export const ERROR_TEXT = 'The diagram could not be drawn.';

// Shows the error line and keeps the source fold. Hides an empty view.
export function showFallback(block) {
  const view = block.querySelector('[data-mermaid-view]');
  const error = block.querySelector('[data-mermaid-error]');
  const fold = block.querySelector('[data-mermaid-source]');
  if (view) { view.hidden = true; view.textContent = ''; }
  if (error) { error.textContent = ERROR_TEXT; error.hidden = false; }
  if (fold) fold.hidden = false;
}

// The fallback for a page whose diagram module did not load. Each block is marked, so a later
// render does not try the import again for the same elements.
export function showImportFallback(blocks) {
  for (const block of blocks) {
    if (block.dataset) block.dataset.mermaidDrawn = '1';
    showFallback(block);
  }
}
