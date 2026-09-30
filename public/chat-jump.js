// The jump-to-newest button of the Chat conversation. It shows when the Owner reads older messages.
// The module has no DOM use, so the Node tests import it directly.

const BOTTOM_TOLERANCE = 48;

// The count in the badge. The badge shows 99+ above 99.
export function chatJumpBadge(unread) {
  const count = Number(unread) || 0;
  if (count <= 0) return '';
  return count > 99 ? '99+' : String(count);
}

// helpers: visible (the list is not at the bottom), unread, and icon(name).
export function chatJumpButtonHtml({ visible, unread, icon }) {
  const badge = chatJumpBadge(unread);
  return `<button type="button" class="chat-jump" data-key="chat-jump" data-chat-jump aria-label="Jump to the newest message"${visible ? '' : ' hidden'}>${icon('down')}${badge ? `<span class="chat-jump-badge" aria-hidden="true">${badge}</span>` : ''}</button>`;
}

// The anchor has no height. It sits between the message list and the composer, and the button floats above the composer.
export function chatJumpHtml(helpers) {
  return `<div class="chat-jump-anchor" data-key="chat-jump-anchor">${chatJumpButtonHtml(helpers)}</div>`;
}

export function chatAtBottom(scroller) {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < BOTTOM_TOLERANCE;
}

export function chatJumpScroll(scroller, reducedMotion) {
  scroller.scrollTo({ top: scroller.scrollHeight, behavior: reducedMotion ? 'auto' : 'smooth' });
}
