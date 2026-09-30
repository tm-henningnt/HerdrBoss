// The phone app view of the Mailbox, the Reviews, and the Chat. The page is one column with the height of the visual viewport.
// When the phone keyboard opens, the visual viewport gets smaller, so the composer stays above the keyboard.

export const APP_VIEW_ROUTES = ['mailbox', 'reviews', 'chat'];

// height and offsetTop come from window.visualViewport. A pinch zoom (scale > 1) keeps the layout height.
export function appViewport({ height, offsetTop, scale, innerHeight }) {
  if (!height || scale > 1.01) return { height: Math.round(innerHeight), top: 0 };
  return { height: Math.round(height), top: Math.max(0, Math.round(offsetTop || 0)) };
}
