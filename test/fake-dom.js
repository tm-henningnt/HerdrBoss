// A minimal DOM for tests of public/keyed.js. It parses the HTML that the dashboard writes:
// elements, quoted or bare attributes, text, void elements, and the five escapes of esc().
// It keeps node identity, focus, and the caret of a field, so a test can check what a patch keeps.

const VOID = new Set(['input', 'br', 'img', 'hr', 'meta', 'link', 'source', 'wbr']);
const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => ENTITY[name]);

class Node {
  constructor(document, nodeType, nodeName) {
    this.ownerDocument = document;
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.parentNode = null;
    this.childNodes = [];
  }
  get firstChild() { return this.childNodes[0] || null; }
  get nextSibling() {
    const list = this.parentNode?.childNodes;
    return list ? list[list.indexOf(this) + 1] || null : null;
  }
  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node === this.ownerDocument.body;
  }
  contains(other) {
    for (let node = other; node; node = node.parentNode) if (node === this) return true;
    return false;
  }
  insertBefore(node, ref) {
    if (node.parentNode) node.parentNode.childNodes.splice(node.parentNode.childNodes.indexOf(node), 1);
    const at = ref ? this.childNodes.indexOf(ref) : -1;
    if (at < 0) this.childNodes.push(node); else this.childNodes.splice(at, 0, node);
    node.parentNode = this;
    return node;
  }
  appendChild(node) { return this.insertBefore(node, null); }
  remove() {
    if (!this.parentNode) return;
    const doc = this.ownerDocument;
    if (doc.activeElement && this.contains(doc.activeElement)) doc.activeElement = doc.body;
    this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
    this.parentNode = null;
  }
}

class Text extends Node {
  constructor(document, value) { super(document, 3, '#text'); this.nodeValue = value; }
  get textContent() { return this.nodeValue; }
}

class Element extends Node {
  constructor(document, tag) {
    super(document, 1, tag.toUpperCase());
    this.tagName = tag.toUpperCase();
    this.attrs = new Map();
    this.current = '';
    this.dirty = false;
    this.checked = false;
    this.selectionStart = 0;
    this.selectionEnd = 0;
  }
  // A field follows its value attribute until the user types, as in a browser.
  get value() { return this.current; }
  set value(text) { this.current = String(text); this.dirty = true; }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  get type() { return this.attrs.get('type') || 'text'; }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  hasAttribute(name) { return this.attrs.has(name); }
  setAttribute(name, value) {
    this.attrs.set(name, String(value));
    if (name === 'value' && this.tagName === 'INPUT' && !this.dirty) this.current = String(value);
  }
  removeAttribute(name) { this.attrs.delete(name); }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  focus() { this.ownerDocument.activeElement = this; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  // Only the selectors that keyed.js uses: tag, and tag[attribute].
  querySelector(selector) {
    const [, tag, attr] = /^([a-z]+)(?:\[([a-z-]+)\])?$/.exec(selector) || [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue;
        if (child.tagName === tag.toUpperCase() && (!attr || child.hasAttribute(attr))) return child;
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return tag ? walk(this) : null;
  }
}

function parse(document, html, into) {
  const stack = [into];
  const tokens = /<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z0-9-]+)((?:\s+[^\s=>/]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|([^<]+)/g;
  for (const [, close, open, attrs, text] of html.matchAll(tokens)) {
    const top = stack.at(-1);
    if (text != null) { top.appendChild(new Text(document, decode(text))); continue; }
    if (close) { if (stack.length > 1 && top.nodeName === close.toUpperCase()) stack.pop(); continue; }
    const el = new Element(document, open.toLowerCase());
    for (const [, name, , dq, sq, bare] of (attrs || '').matchAll(/([^\s=>/]+)(=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      el.setAttribute(name, decode(dq ?? sq ?? bare ?? ''));
    }
    if (el.tagName === 'INPUT') el.checked = el.hasAttribute('checked');
    if (el.tagName === 'TEXTAREA') { stack.push(el); top.appendChild(el); continue; }
    top.appendChild(el);
    if (!VOID.has(el.tagName.toLowerCase())) stack.push(el);
  }
  // A textarea holds its text as its value.
  const fill = (node) => { for (const c of node.childNodes) { if (c.tagName === 'TEXTAREA') c.current = c.textContent; if (c.nodeType === 1) fill(c); } };
  fill(into);
}

export function createDocument() {
  const document = {
    activeElement: null,
    createElement(tag) {
      const el = new Element(document, tag);
      if (tag === 'template') {
        el.content = new Node(document, 11, '#document-fragment');
        Object.defineProperty(el, 'innerHTML', { set(html) { el.content.childNodes = []; parse(document, html, el.content); } });
      }
      return el;
    },
  };
  document.body = new Element(document, 'body');
  document.activeElement = document.body;
  document.html = (html) => { const root = document.createElement('div'); document.body.appendChild(root); parse(document, html, root); return root; };
  return document;
}

// Depth-first search for the first element that passes the test.
export function find(root, test) {
  for (const child of root.childNodes) {
    if (child.nodeType !== 1) continue;
    if (test(child)) return child;
    const found = find(child, test);
    if (found) return found;
  }
  return null;
}
export const byKey = (root, key) => find(root, (el) => el.getAttribute('data-key') === key);
