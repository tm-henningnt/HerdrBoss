// The phone app view of the Mailbox, the Reviews, and the Chat.

export const APP_VIEW_ROUTES = ['mailbox', 'reviews', 'chat'];

// height and offsetTop come from window.visualViewport. A pinch zoom (scale > 1) keeps the layout height.
export function appViewport({ height, offsetTop, scale, innerHeight }) {
  if (!height || scale > 1.01) return { height: Math.round(innerHeight), top: 0 };
  return { height: Math.round(height), top: Math.max(0, Math.round(offsetTop || 0)) };
}

export function chatKeyboardOpen(layoutHeight, visualHeight) {
  return layoutHeight - visualHeight > 150;
}

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const rounded = (value) => Math.round(finite(value));

// iOS can scroll the visual viewport without shrinking the layout viewport. Zoom uses the full layout height.
export function chatViewportLayout({ innerHeight, height, offsetTop, scale, safeAreaBottom, draftFocused = false } = {}) {
  const layoutHeight = Math.max(0, finite(innerHeight));
  const visualHeight = Math.max(0, finite(height, layoutHeight)) || layoutHeight;
  const visualTop = Math.max(0, finite(offsetTop));
  const zoomed = finite(scale, 1) > 1.01;
  const keyboardOpen = !zoomed && (layoutHeight - visualHeight > 150 || (draftFocused && visualTop > 0));
  return {
    top: zoomed ? 0 : rounded(visualTop),
    height: rounded(zoomed ? layoutHeight : visualHeight),
    keyboardOpen,
    bottomInset: keyboardOpen ? 0 : rounded(Math.max(0, finite(safeAreaBottom))),
  };
}

// Read a real viewport, or the narrowly scoped mock used by the project browser.
export function readViewport({ innerHeight, visualViewport, search = '', debugEnabled = false } = {}) {
  const layoutHeight = finite(innerHeight);
  const viewport = visualViewport || {};
  const result = {
    innerHeight: layoutHeight,
    height: finite(viewport.height, layoutHeight) || layoutHeight,
    offsetTop: finite(viewport.offsetTop),
    offsetLeft: finite(viewport.offsetLeft),
    scale: finite(viewport.scale, 1),
    mocked: false,
  };
  const query = new URLSearchParams(search);
  const mock = debugEnabled && query.get('vvdebug') === '1' && /^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(query.get('vvmock') || '');
  if (mock) {
    const height = Number(mock[1]);
    const offsetTop = Number(mock[2]);
    if (height > 0 && offsetTop >= 0) Object.assign(result, { height, offsetTop, mocked: true });
  }
  return result;
}

const CHAT_DEBUG_SESSION_KEY = 'herdr-boss.chat-vvdebug';

// Create no debug UI unless the URL or this tab's saved flag enables it.
export function createChatViewportDebug({ search = '', storage = null, document: doc } = {}) {
  const query = new URLSearchParams(search);
  let enabled = query.get('vvdebug') === '1';
  try {
    if (enabled) storage?.setItem(CHAT_DEBUG_SESSION_KEY, '1');
    else enabled = storage?.getItem(CHAT_DEBUG_SESSION_KEY) === '1';
  } catch { /* Storage can be unavailable in private browsing. */ }
  if (!enabled || !doc?.createElement || !doc.body?.append) return null;

  const overlay = doc.createElement('pre');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647;max-width:100vw;max-height:42vh;overflow:hidden;margin:0;padding:4px 6px;border:1px solid CanvasText;box-sizing:border-box;background:CanvasText;color:Canvas;font:11px/1.25 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere;pointer-events:none';
  doc.body.append(overlay);

  const value = (number) => Number.isFinite(Number(number)) ? String(Math.round(Number(number) * 100) / 100) : 'n/a';
  const rect = (name, item) => `${name} top ${value(item?.top)} bottom ${value(item?.bottom)} height ${value(item?.height)}`;
  return {
    setVisible(visible) {
      overlay.hidden = !visible;
    },
    update(data = {}) {
      const safe = data.safeArea || {};
      overlay.textContent = [
        `innerHeight ${value(data.innerHeight)}`,
        `visualViewport.height ${value(data.height)}`,
        `offsetTop ${value(data.offsetTop)}  offsetLeft ${value(data.offsetLeft)}  scale ${value(data.scale)}`,
        `safe-area top ${value(safe.top)}  right ${value(safe.right)}  bottom ${value(safe.bottom)}  left ${value(safe.left)}`,
        rect('composer', data.composerRect),
        rect('container', data.containerRect),
        `keyboardOpen ${Boolean(data.keyboardOpen)}  display-mode standalone ${Boolean(data.standalone)}`,
      ].join('\n');
    },
  };
}

export function chatShouldStickToBottom({ scrollHeight, scrollTop, clientHeight } = {}) {
  return scrollHeight - scrollTop - clientHeight <= 40;
}
