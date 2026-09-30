// Keyed DOM update. patchHtml() changes a live tree to match new HTML and keeps each element that stays.
// An element with data-key matches the element with the same key, so a card or a graph node keeps its DOM node when the order changes.
// Other nodes match by position, tag, and type. A kept element keeps its scroll position, focus, and caret.
// data-keep-attrs="a b" names attributes that page code sets after a render; a patch does not change them.
// A keyed element that moves to another parent, such as a card that moves to another column, gets a new DOM node.
// The focus then goes to the same element in the new node, found by the key and the child path.

const keyOf = (node) => (node.nodeType === 1 ? node.getAttribute('data-key') : null);

export function patchHtml(target, html) {
  const focus = focusMark(target);
  const template = document.createElement('template');
  template.innerHTML = html;
  patchChildren(target, template.content);
  restoreFocus(target, focus);
}

// The focused element in target: the key of its nearest keyed ancestor and the child indexes from there.
function focusMark(target) {
  const active = document.activeElement;
  if (!active || active === target || !target.contains(active)) return null;
  const path = [];
  let host = active;
  while (host !== target && keyOf(host) == null) {
    path.unshift(Array.prototype.indexOf.call(host.parentNode.childNodes, host));
    host = host.parentNode;
  }
  return host === target ? null : { active, key: keyOf(host), path, name: active.nodeName };
}

function findKey(root, key) {
  const stack = [...root.childNodes].reverse();
  while (stack.length) {
    const node = stack.pop();
    if (node.nodeType !== 1) continue;
    if (keyOf(node) === key) return node;
    for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]);
  }
  return null;
}

function restoreFocus(target, mark) {
  if (!mark || target.contains(mark.active)) return;
  let node = findKey(target, mark.key);
  for (const i of mark.path) node = node?.childNodes[i];
  if (node && node.nodeName === mark.name && typeof node.focus === 'function') node.focus({ preventScroll: true });
}

function patchAttributes(el, want) {
  const keep = new Set((want.getAttribute('data-keep-attrs') || '').split(/\s+/).filter(Boolean));
  for (const { name } of [...el.attributes]) if (!want.hasAttribute(name) && !keep.has(name)) el.removeAttribute(name);
  for (const { name, value } of [...want.attributes]) if (!keep.has(name) && el.getAttribute(name) !== value) el.setAttribute(name, value);
  // Attributes set only the default state of a form field. The rendered state is the view state, so set the live property too.
  if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) el.checked = want.hasAttribute('checked');
  if (el.tagName === 'SELECT') {
    const chosen = want.querySelector('option[selected]') || want.querySelector('option');
    if (chosen && el.value !== chosen.getAttribute('value')) el.value = chosen.getAttribute('value');
  }
}

function patchNode(node, want) {
  if (node.nodeType !== 1) {
    if (node.nodeValue !== want.nodeValue) node.nodeValue = want.nodeValue;
    return;
  }
  patchAttributes(node, want);
  // A focused text field keeps what the Owner types.
  if ((node.tagName === 'TEXTAREA' || node.tagName === 'INPUT') && node === document.activeElement) return;
  if (node.tagName === 'TEXTAREA') { if (node.value !== want.value) node.value = want.value; return; }
  patchChildren(node, want);
}

export function patchChildren(from, to) {
  const keyed = new Map();
  for (const child of from.childNodes) {
    const key = keyOf(child);
    if (key != null) keyed.set(key, child);
  }
  let cursor = from.firstChild;
  for (const want of [...to.childNodes]) {
    const key = keyOf(want);
    let match = null;
    if (key != null) {
      const found = keyed.get(key);
      if (found && found.nodeName === want.nodeName) { match = found; keyed.delete(key); }
    } else if (cursor && keyOf(cursor) == null && cursor.nodeType === want.nodeType && cursor.nodeName === want.nodeName) match = cursor;
    if (!match) { from.insertBefore(want, cursor); continue; }
    if (match === cursor) cursor = cursor.nextSibling;
    else from.insertBefore(match, cursor);
    patchNode(match, want);
  }
  while (cursor) {
    const next = cursor.nextSibling;
    cursor.remove();
    cursor = next;
  }
}
