// The gestures of the review item viewer: pinch, pan, double tap, Ctrl and the wheel, the tap that drops a pin,
// and the swipe between items. The math is in public/review-zoom.js. This module only reads pointer and touch events
// and writes the canvas transform. See docs/ideas/review-packs.md, section Item viewer.
//
// A stage (.rv-stage) has touch-action: none, so pointer events carry every touch. A vertical drag at fit scrolls the
// page body, as a native scroll would. The rest of the item keeps native scrolling; a horizontal touch swipe there moves
// between items, except inside a box that scrolls sideways, a field, or a video.
import { ZOOM_MIN, clampPan, zoomAt, doubleTap, toggleFit, stepZoom, pinFraction, swipeIntent, transformCss } from './review-zoom.js';

const TAP_MOVE = 10;
const TAP_MS = 300;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_MOVE = 30;
const SWIPE_MS = 800;
const NO_SWIPE = '.rv-stage, .rv-table, .rv-code, .md-table, .md pre, input, textarea, select, video, [contenteditable="true"]';

const views = new Map();
const fit = () => ({ scale: ZOOM_MIN, x: 0, y: 0 });

// The stage can have a top padding for the pair toggle. The image sits in the middle of the rest.
const padOf = (stage) => parseFloat(getComputedStyle(stage).paddingTop) || 0;

function boxOf(stage) {
  const canvas = stage.querySelector('.rv-canvas');
  return { width: stage.clientWidth, height: stage.clientHeight - padOf(stage), contentWidth: canvas?.offsetWidth || 0, contentHeight: canvas?.offsetHeight || 0 };
}

export function stageView(stage) {
  return views.get(stage.dataset.rvStage) || fit();
}

function apply(stage, view) {
  const clamped = clampPan(view, boxOf(stage));
  views.set(stage.dataset.rvStage, clamped);
  const canvas = stage.querySelector('.rv-canvas');
  if (canvas) {
    canvas.style.transform = transformCss(clamped);
    canvas.style.setProperty('--rv-scale', String(clamped.scale));
  }
  stage.classList.toggle('rv-zoomed', clamped.scale > ZOOM_MIN);
  const chip = stage.querySelector('.rv-zoom');
  if (chip) chip.dataset.zoom = clamped.scale > ZOOM_MIN ? `${Math.round(clamped.scale * 10) / 10}×` : 'Fit';
  return clamped;
}

// A new stage node gets the zoom of its key again, for example after a render that replaced the node.
export function restoreStages(root) {
  for (const stage of root.querySelectorAll('.rv-stage')) {
    const view = views.get(stage.dataset.rvStage);
    if (view && !stage.querySelector('.rv-canvas')?.style.transform) apply(stage, view);
  }
}

// Forget every zoom. The page calls it when another item opens.
export function resetStages() {
  views.clear();
}

const visibleImage = (stage) => [...stage.querySelectorAll('.rv-img')].find((img) => img.offsetParent !== null && getComputedStyle(img).visibility !== 'hidden') || stage.querySelector('.rv-img');

// + and -, z, or the zoom buttons. action: 'in', 'out', or 'fit'.
export function zoomStage(stage, action) {
  if (!stage) return;
  const view = stageView(stage);
  const box = boxOf(stage);
  if (action === 'fit') apply(stage, toggleFit(view, visibleImage(stage), box));
  else apply(stage, stepZoom(view, action === 'out' ? -1 : 1, box));
}

function fromCenter(stage, clientX, clientY) {
  const rect = stage.getBoundingClientRect();
  const pad = padOf(stage);
  return { x: clientX - (rect.left + rect.width / 2), y: clientY - (rect.top + pad + (rect.height - pad) / 2) };
}

// The pin of a tap. A pair in the slider view takes the side of the split line.
function pinAt(stage, clientX, clientY) {
  const split = stage.querySelector('.rv-canvas.rv-split');
  const img = split ? stage.querySelector('.rv-img-a') : visibleImage(stage);
  if (!img) return null;
  const point = pinFraction({ clientX, clientY }, img.getBoundingClientRect());
  if (!point) return null;
  let src = img.dataset.src;
  if (split) {
    const at = parseFloat(getComputedStyle(stage).getPropertyValue('--rv-split')) || 50;
    src = point.x * 100 < at ? 'a' : 'b';
  }
  return src ? { ...point, src } : point;
}

// Attach the listeners once. handlers: swipe(intent), pin({ x, y, src }), placing() gives true while the next tap drops a pin.
export function attachGestures(root, handlers) {
  const pointers = new Map();
  let gesture = null;
  let lastTap = null;

  const stageOf = (target) => target.closest?.('.rv-stage');
  const control = (target) => target.closest?.('button, a, input, .rv-pairbar');

  root.addEventListener('pointerdown', (e) => {
    const stage = stageOf(e.target);
    if (!stage || control(e.target) || (e.pointerType === 'mouse' && e.button !== 0)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { stage.setPointerCapture(e.pointerId); } catch { /* the pointer is gone */ }
    stage.classList.add('rv-live');
    const view = stageView(stage);
    if (pointers.size === 1) {
      const scroller = stage.closest('.review-body');
      gesture = { stage, kind: 'one', startX: e.clientX, startY: e.clientY, at: e.timeStamp, view, moved: false, scroller, scrollTop: scroller?.scrollTop ?? 0 };
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      gesture = { stage, kind: 'pinch', distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, view, moved: true };
    }
  });

  root.addEventListener('pointermove', (e) => {
    if (!gesture || !pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const { stage } = gesture;
    if (gesture.kind === 'pinch' && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const middle = fromCenter(stage, (a.x + b.x) / 2, (a.y + b.y) / 2);
      apply(stage, zoomAt(stageView(stage), gesture.view.scale * (distance / gesture.distance), middle, boxOf(stage)));
      return;
    }
    const dx = e.clientX - gesture.startX;
    const dy = e.clientY - gesture.startY;
    if (Math.hypot(dx, dy) > TAP_MOVE) gesture.moved = true;
    if (!gesture.moved) return;
    if (gesture.view.scale > ZOOM_MIN) apply(stage, { ...gesture.view, x: gesture.view.x + dx, y: gesture.view.y + dy });
    else if (gesture.scroller && Math.abs(dy) > Math.abs(dx)) gesture.scroller.scrollTop = gesture.scrollTop - dy;
  });

  const end = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (!gesture) return;
    const { stage } = gesture;
    if (!pointers.size) stage.classList.remove('rv-live');
    if (gesture.kind === 'pinch') {
      // One finger stays on the glass after a pinch: it pans from here, and it is no tap and no swipe.
      if (pointers.size === 1) {
        const [rest] = [...pointers.values()];
        gesture = { stage, kind: 'one', startX: rest.x, startY: rest.y, at: e.timeStamp, view: stageView(stage), moved: true };
      } else gesture = null;
      return;
    }
    if (pointers.size) return;
    const current = gesture;
    gesture = null;
    if (e.type === 'pointercancel') return;
    const dx = e.clientX - current.startX;
    const dy = e.clientY - current.startY;
    if (!current.moved && e.timeStamp - current.at < TAP_MS * 2) {
      if (handlers.placing?.() && !stage.closest('.rv-evidence-agent')) {
        const pin = pinAt(stage, e.clientX, e.clientY);
        if (pin) handlers.pin?.(pin);
        lastTap = null;
        return;
      }
      if (lastTap && e.timeStamp - lastTap.at < DOUBLE_TAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < DOUBLE_TAP_MOVE && lastTap.stage === stage) {
        apply(stage, doubleTap(stageView(stage), fromCenter(stage, e.clientX, e.clientY), boxOf(stage)));
        lastTap = null;
      } else lastTap = { at: e.timeStamp, x: e.clientX, y: e.clientY, stage };
      return;
    }
    if (e.timeStamp - current.at > SWIPE_MS) return;
    const intent = swipeIntent({ dx, dy, scale: current.view.scale });
    if (intent) handlers.swipe?.(intent);
  };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);

  root.addEventListener('wheel', (e) => {
    const stage = stageOf(e.target);
    if (!stage || !e.ctrlKey) return;
    e.preventDefault();
    const view = stageView(stage);
    apply(stage, zoomAt(view, view.scale * Math.exp(-e.deltaY * 0.01), fromCenter(stage, e.clientX, e.clientY), boxOf(stage)));
  }, { passive: false });

  // A horizontal touch swipe on the rest of the item. The browser scrolls natively, so these are passive touch events.
  let touch = null;
  root.addEventListener('touchstart', (e) => {
    const item = e.target.closest?.('.rv-item');
    touch = item && e.touches.length === 1 && !e.target.closest(NO_SWIPE) ? { x: e.touches[0].clientX, y: e.touches[0].clientY, at: e.timeStamp } : null;
  }, { passive: true });
  root.addEventListener('touchend', (e) => {
    if (!touch || e.changedTouches.length !== 1) { touch = null; return; }
    const start = touch;
    touch = null;
    if (e.timeStamp - start.at > SWIPE_MS) return;
    const intent = swipeIntent({ dx: e.changedTouches[0].clientX - start.x, dy: e.changedTouches[0].clientY - start.y });
    if (intent) handlers.swipe?.(intent);
  }, { passive: true });
}
