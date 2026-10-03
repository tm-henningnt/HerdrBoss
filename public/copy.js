// Copy to the clipboard. The module has no DOM use at import time, so the Node tests import it with a fake environment.
// navigator.clipboard needs a secure page and a user gesture. iPhone Safari, the home-screen web app, and a plain http page
// can refuse it. The fallback selects a textarea and runs document.execCommand('copy').

export const COPIED_MS = 1500;

// The Copy action of a message. It copies the Markdown source of the message, found by the message ID.
export const messageCopyHtml = (id, esc) => `<button type="button" class="copy-btn copy-msg" data-copy-message="${esc(id)}" aria-label="Copy message"><span class="copy-icon" aria-hidden="true"></span><span class="copy-text" data-done="Copied">Copy</span></button>`;

export const COPY_ICON_HTML = '<span class="copy-icon" aria-hidden="true"></span><span class="copy-flash" aria-hidden="true">Copied</span>';

// A copy button for code in a field. The text is the value that the button copies.
export function copyFieldHtml(value, esc, label = 'Copy') {
  return `<button type="button" class="copy-btn copy-inline copy-field" data-copy-text="${esc(value)}" aria-label="${esc(label)}">${COPY_ICON_HTML}</button>`;
}

function fallbackCopy(text, doc) {
  if (!doc?.createElement || !doc.body || typeof doc.execCommand !== 'function') return false;
  // The textarea takes the focus for the copy. The element that had the focus gets it back, also when the copy fails.
  const previous = doc.activeElement;
  const area = doc.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  // A font size of 16 px stops iPhone Safari from zooming on focus.
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;pointer-events:none';
  doc.body.append(area);
  let ok = false;
  try {
    area.focus?.({ preventScroll: true });
    area.select?.();
    area.setSelectionRange?.(0, text.length);
    ok = !!doc.execCommand('copy');
  } catch { ok = false; }
  area.remove();
  if (previous && previous !== doc.body && typeof previous.focus === 'function') previous.focus({ preventScroll: true });
  return ok;
}

// Returns true when the text reached the clipboard.
export async function copyText(text, env = globalThis) {
  const value = String(text ?? '');
  const clipboard = env.navigator?.clipboard;
  if (clipboard && typeof clipboard.writeText === 'function' && env.isSecureContext !== false) {
    try { await clipboard.writeText(value); return true; } catch { /* Refused: use the fallback. */ }
  }
  return fallbackCopy(value, env.document);
}

// The text that a copy button stands for, or null.
// A code block copies the source of the fence. The attribute holds the source only when it differs from the shown text (tabs).
// A line of a file or a diff copies its marker and text, without the line numbers.
export function copySource(button, { messageText = () => null } = {}) {
  if (button.hasAttribute('data-copy-code')) {
    const source = button.getAttribute('data-copy-code');
    if (source) return source;
    const code = button.closest('.md-code')?.querySelector('code');
    return code ? code.textContent : null;
  }
  if (button.hasAttribute('data-copy-lines')) {
    const block = button.closest('[data-copy-scope]')?.querySelector('.rv-code');
    if (!block) return null;
    return [...block.querySelectorAll('.rv-line')].map((row) => `${row.getAttribute('data-copy-prefix') ?? ''}${row.querySelector('code')?.textContent ?? ''}`).join('\n');
  }
  if (button.hasAttribute('data-copy-message')) return messageText(button.getAttribute('data-copy-message'));
  if (button.hasAttribute('data-copy-text')) return button.getAttribute('data-copy-text');
  return null;
}

const ALL = '[data-copy-code], [data-copy-lines], [data-copy-message], [data-copy-text]';
const timers = new WeakMap();

// Shows "Copied" for COPIED_MS. A second click restarts the time.
export function flashCopied(button, { setTimer = setTimeout, clearTimer = clearTimeout, ms = COPIED_MS } = {}) {
  const label = timers.get(button)?.label ?? button.getAttribute('aria-label');
  clearTimer(timers.get(button)?.id);
  button.setAttribute('data-state', 'copied');
  button.setAttribute('aria-label', 'Copied');
  const text = button.querySelector('.copy-text');
  const before = text ? (timers.get(button)?.text ?? text.textContent) : null;
  if (text) text.textContent = 'Copied';
  const id = setTimer(() => {
    button.removeAttribute('data-state');
    button.setAttribute('aria-label', label);
    if (text) text.textContent = before;
    timers.delete(button);
  }, ms);
  timers.set(button, { id, label, text: before });
}

// One click listener on the root covers every button, also in HTML that a later render adds.
export function installCopy(root, options = {}) {
  const env = options.env || globalThis;
  // The capture phase runs before the handlers of a bubble or a row that holds the button.
  root.addEventListener('click', async (event) => {
    const button = event.target.closest?.(ALL);
    if (!button || !root.contains(button)) return;
    event.preventDefault();
    event.stopPropagation();
    const text = copySource(button, options);
    if (text === null || text === undefined) return;
    if (await copyText(text, env)) flashCopied(button, options);
  }, true);
}
