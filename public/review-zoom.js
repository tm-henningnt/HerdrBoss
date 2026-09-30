// The zoom, pan, pin, and swipe math of the review item viewer. See docs/ideas/review-packs.md, section Item viewer.
// The module has no DOM use, so the Node tests import it directly. public/review-gestures.js applies the results.
//
// The model: the image sits at its fit size in the middle of the stage. The canvas gets
// `translate(x, y) scale(s)` with the transform origin in its middle, so x and y are the offset of the
// image middle from the stage middle in screen pixels. A point is also measured from the stage middle.
// box: width and height of the stage, contentWidth and contentHeight of the image at fit (scale 1).

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 8;
export const DOUBLE_TAP_SCALE = 2;
export const ZOOM_STEP = 1.5;
const SWIPE_MIN = 50;
const SWIPE_DOWN_MIN = 80;
const SWIPE_RATIO = 1.5;

export function clampScale(scale) {
  if (!Number.isFinite(scale)) return ZOOM_MIN;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
}

// Keep the zoomed image over the stage. When the image is smaller than the stage on one axis, it stays in the middle.
export function clampPan(view, box) {
  const scale = clampScale(view.scale);
  const spareX = Math.max(0, (box.contentWidth * scale - box.width) / 2);
  const spareY = Math.max(0, (box.contentHeight * scale - box.height) / 2);
  const clamp = (value, spare) => (spare === 0 ? 0 : Math.min(spare, Math.max(-spare, Number.isFinite(value) ? value : 0)));
  return { scale, x: clamp(view.x, spareX), y: clamp(view.y, spareY) };
}

// Zoom to `scale` and keep the image point under `point` in place.
export function zoomAt(view, scale, point, box) {
  const next = clampScale(scale);
  if (next === ZOOM_MIN) return { scale: ZOOM_MIN, x: 0, y: 0 };
  const ratio = next / view.scale;
  return clampPan({ scale: next, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio }, box);
}

// A double tap zooms to 2x at the tap point, and again to fit.
export function doubleTap(view, point, box) {
  return view.scale > ZOOM_MIN ? { scale: ZOOM_MIN, x: 0, y: 0 } : zoomAt(view, DOUBLE_TAP_SCALE, point, box);
}

// The scale that shows one image pixel for one screen pixel. The image never shows smaller than fit.
export function fullScale(natural, box) {
  if (!natural?.naturalWidth || !box.contentWidth) return ZOOM_MIN;
  return clampScale(natural.naturalWidth / box.contentWidth);
}

// z toggles fit and 100 percent, at the middle of the stage.
export function toggleFit(view, natural, box) {
  return view.scale > ZOOM_MIN ? { scale: ZOOM_MIN, x: 0, y: 0 } : zoomAt(view, fullScale(natural, box), { x: 0, y: 0 }, box);
}

// + and - zoom in or out by one step at the middle of the stage. `direction` is 1 or -1.
export function stepZoom(view, direction, box) {
  return zoomAt(view, view.scale * ZOOM_STEP ** Math.sign(direction), { x: 0, y: 0 }, box);
}

export function transformCss(view) {
  const round = (value) => Math.round(value * 100) / 100;
  return `translate(${round(view.x)}px, ${round(view.y)}px) scale(${round(view.scale)})`;
}

// A tap as fractions of the drawn image, with 4 decimals. `rect` is the image rectangle on screen after the zoom.
// A tap outside the image gives null.
export function pinFraction(client, rect) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
  const x = (client.clientX - rect.left) / rect.width;
  const y = (client.clientY - rect.top) / rect.height;
  if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return null;
  const round = (value) => Math.round(value * 10000) / 10000;
  return { x: round(x), y: round(y) };
}

// The intent of a finished one-finger move: 'next', 'prev', 'back' (a swipe down, only where `down` allows it), or null.
// Above fit, a move pans the image and is never a swipe.
export function swipeIntent({ dx, dy, scale = ZOOM_MIN, down = false }) {
  if (scale > ZOOM_MIN) return null;
  if (Math.abs(dx) >= SWIPE_MIN && Math.abs(dx) > Math.abs(dy) * SWIPE_RATIO) return dx < 0 ? 'next' : 'prev';
  if (down && dy >= SWIPE_DOWN_MIN && dy > Math.abs(dx) * SWIPE_RATIO) return 'back';
  return null;
}
