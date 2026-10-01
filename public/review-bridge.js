// The bridge of a legacy HTML page in a review pack. The server appends a script tag for this file to each served page.
// The page runs in a sandboxed frame with an opaque origin. The bridge is the only way that the dashboard learns about the page.
// It sends `ready`, `pick`, `scroll`, and `open` to the parent. It handles `pins`, `goto`, and `place` from the parent.
// The message shapes are in docs/ideas/review-packs.md, section The frame protocol. The page scripts can send the same
// messages, so the parent checks each one. The bridge has no dependencies and reads no secret.
(function () {
  'use strict';
  var STRING_MAX = 200;
  var ANCHORS_MAX = 500;
  var parentWindow = window.parent;
  if (!parentWindow || parentWindow === window) return;

  var anchors = [];
  var anchorNodes = {};
  var pins = [];
  var placing = false;
  var layer = null;
  var readyTimer = null;
  var scrollQueued = false;

  function cut(text) { return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, STRING_MAX); }
  function send(message) {
    message.hb = 1;
    try { parentWindow.postMessage(message, '*'); } catch (error) { /* the parent is gone */ }
  }
  function root() { return document.documentElement; }
  function docHeight() { return Math.max(root().scrollHeight, document.body ? document.body.scrollHeight : 0, 1); }
  function docWidth() { return Math.max(root().scrollWidth, document.body ? document.body.scrollWidth : 0, 1); }
  function clamp(value) { return value < 0 ? 0 : value > 1 ? 1 : value; }
  function pageTop(node) { return node.getBoundingClientRect().top + (window.pageYOffset || 0); }

  // The anchors: headings and images, in document order, at most 500. An element without an ID gets a generated one in a map,
  // never in the page DOM, so the page scripts see no change.
  function collectAnchors() {
    var nodes = document.querySelectorAll('h1, h2, h3, h4, h5, h6, img');
    var height = docHeight();
    anchors = [];
    anchorNodes = {};
    for (var index = 0; index < nodes.length && anchors.length < ANCHORS_MAX; index += 1) {
      var node = nodes[index];
      var image = node.tagName === 'IMG';
      var text = cut(image ? node.getAttribute('alt') : node.textContent);
      var id = cut(node.id) || ('hb-' + index);
      if (anchorNodes[id]) id = 'hb-' + index;
      anchorNodes[id] = node;
      anchors.push({ id: id, kind: image ? 'image' : 'heading', text: text, top: clamp(pageTop(node) / height) });
    }
  }

  function ready() {
    readyTimer = null;
    collectAnchors();
    send({ type: 'ready', title: cut(document.title), height: docHeight(), anchors: anchors });
    drawPins();
  }
  function scheduleReady() {
    if (readyTimer) return;
    readyTimer = setTimeout(ready, 150);
  }

  // The numbered pins. The layer does not take pointer events, so the page keeps its clicks.
  function ensureLayer() {
    if (layer && layer.parentNode) return layer;
    layer = document.createElement('div');
    layer.setAttribute('data-hb-pins', '');
    layer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;margin:0;padding:0;border:0;pointer-events:none;z-index:2147483646;';
    root().appendChild(layer);
    return layer;
  }
  function drawPins() {
    var host = ensureLayer();
    while (host.firstChild) host.removeChild(host.firstChild);
    var width = docWidth();
    var height = docHeight();
    pins.forEach(function (pin) {
      var mark = document.createElement('span');
      mark.textContent = String(pin.n);
      mark.style.cssText = 'position:absolute;box-sizing:border-box;min-width:24px;height:24px;padding:0 6px;margin:-12px 0 0 -12px;border-radius:12px;'
        + 'background:#b3261e;color:#fff;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.45);font:700 12px/20px system-ui,sans-serif;text-align:center;'
        + 'left:' + Math.round(pin.x * width) + 'px;top:' + Math.round(pin.y * height) + 'px;';
      host.appendChild(mark);
    });
  }

  function scrollTop() {
    scrollQueued = false;
    send({ type: 'scroll', top: clamp((window.pageYOffset || 0) / docHeight()) });
  }

  // The nearest anchor at or above a point, by document position.
  function anchorAt(y) {
    var best = null;
    var bestTop = -1;
    Object.keys(anchorNodes).forEach(function (id) {
      var top = pageTop(anchorNodes[id]);
      if (top <= y + 1 && top > bestTop) { best = id; bestTop = top; }
    });
    return best;
  }

  function pick(event) {
    var x = (event.pageX != null ? event.pageX : event.clientX + (window.pageXOffset || 0));
    var y = (event.pageY != null ? event.pageY : event.clientY + (window.pageYOffset || 0));
    var selected = '';
    try { selected = cut(String(window.getSelection())); } catch (error) { selected = ''; }
    send({ type: 'pick', anchor: anchorAt(y), x: clamp(x / docWidth()), y: clamp(y / docHeight()), text: selected });
  }

  function externalLink(link) {
    var href = link.getAttribute('href');
    if (!href || href.charAt(0) === '#') return null;
    var url;
    try { url = new URL(link.href); } catch (error) { return null; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // A link to another file of the pack is on the same path tree. The pack items are separate, so the bridge only blocks it.
    if (url.origin === location.origin && url.pathname.indexOf('/review-raw/') === 0) return null;
    return url.href.length <= STRING_MAX ? url.href : null;
  }

  // One capture listener for each click. A tap with the pin tool picks a point. A link never navigates the frame.
  document.addEventListener('click', function (event) {
    if (placing) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      pick(event);
      return;
    }
    var node = event.target;
    while (node && node !== document && !(node.tagName === 'A' && node.hasAttribute('href'))) node = node.parentNode;
    if (!node || node === document) return;
    var href = node.getAttribute('href');
    if (href && href.charAt(0) === '#') return;
    event.preventDefault();
    var url = externalLink(node);
    if (url) send({ type: 'open', url: url });
  }, true);

  // While the pin tool is on, no other event of a tap reaches the page.
  ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'submit', 'auxclick', 'dblclick'].forEach(function (name) {
    document.addEventListener(name, function (event) {
      if (!placing) return;
      event.preventDefault();
      event.stopPropagation();
    }, true);
  });

  window.addEventListener('message', function (event) {
    if (event.source !== parentWindow) return;
    var data = event.data;
    if (!data || typeof data !== 'object' || data.hb !== 1) return;
    if (data.type === 'pins' && Array.isArray(data.pins)) {
      pins = data.pins.filter(function (pin) {
        return pin && Number.isInteger(pin.n) && typeof pin.x === 'number' && typeof pin.y === 'number' && pin.x >= 0 && pin.x <= 1 && pin.y >= 0 && pin.y <= 1;
      }).slice(0, 100);
      drawPins();
    } else if (data.type === 'goto') {
      if (typeof data.anchor === 'string' && anchorNodes[data.anchor]) window.scrollTo(0, Math.max(0, pageTop(anchorNodes[data.anchor]) - 8));
      else if (typeof data.y === 'number' && data.y >= 0 && data.y <= 1) window.scrollTo(0, Math.round(data.y * docHeight()));
    } else if (data.type === 'place') {
      placing = data.on === true;
      root().style.cursor = placing ? 'crosshair' : '';
    }
  });

  window.addEventListener('scroll', function () {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(scrollTop);
  }, { passive: true });
  window.addEventListener('resize', scheduleReady);
  window.addEventListener('load', scheduleReady);
  document.addEventListener('DOMContentLoaded', scheduleReady);
  if (typeof ResizeObserver === 'function' && document.body) {
    try { new ResizeObserver(scheduleReady).observe(document.body); } catch (error) { /* no observer */ }
  }
  if (document.readyState !== 'loading') scheduleReady();
})();
