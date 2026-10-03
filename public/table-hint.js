// The scroll hint of a Markdown table. A shadow above the table shows at each edge that has more columns.
// hintState has no DOM use, so the Node tests import it. installTableHints sets data-more on each .md-table-wrap from the scroll position.

// '' when the table fits, else 'end', 'start', or 'both': the edges that have hidden columns.
export function hintState(scrollLeft, clientWidth, scrollWidth) {
  const max = scrollWidth - clientWidth;
  if (!(max > 1)) return '';
  const start = scrollLeft > 1;
  const end = scrollLeft < max - 1;
  return start && end ? 'both' : end ? 'end' : start ? 'start' : '';
}

function update(wrap) {
  const box = wrap.firstElementChild;
  if (!box) return;
  const state = hintState(box.scrollLeft, box.clientWidth, box.scrollWidth);
  if ((wrap.getAttribute('data-more') || '') !== state) {
    if (state) wrap.setAttribute('data-more', state); else wrap.removeAttribute('data-more');
  }
}

// The scroll event does not bubble, so one capture listener serves all tables. A DOM change or a resize checks all tables again.
// It reads the globals inside the function, and does nothing where there is no page (a Node test that loads the app code).
export function installTableHints(doc = globalThis.document, win = globalThis.window) {
  if (typeof doc?.addEventListener !== 'function' || !doc.body || typeof win?.MutationObserver !== 'function' || typeof win.requestAnimationFrame !== 'function') return;
  const refresh = () => doc.querySelectorAll('.md-table-wrap').forEach(update);
  let queued = false;
  const later = () => {
    if (queued) return;
    queued = true;
    win.requestAnimationFrame(() => { queued = false; refresh(); });
  };
  doc.addEventListener('scroll', (event) => {
    const box = event.target;
    if (box?.classList?.contains('md-table')) update(box.parentElement);
  }, { capture: true, passive: true });
  new win.MutationObserver(later).observe(doc.body, { childList: true, subtree: true });
  win.addEventListener('resize', later);
  later();
}
