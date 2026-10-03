// Safe Markdown for the Mailbox and the Chat. No dependencies and no DOM use, so the Node tests import this file.
// The renderer builds HTML only from its own tokens. Every source text piece passes through esc(). Raw HTML shows as text.

export const MAX_INPUT = 200 * 1024;
export const MAX_DEPTH = 8;
export const MAX_INLINE_DEPTH = 16;
export const MAX_TABLE_COLUMNS = 30;
const MAX_URL = 2048;
const MAX_TITLE = 512;

export const ALLOWED_TAGS = new Set(['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'input', 'blockquote', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div', 'a', 'span', 'svg', 'use', 'img', 'button']);
export const ALLOWED_ATTRS = new Set(['href', 'target', 'rel', 'title', 'class', 'role', 'tabindex', 'aria-label', 'aria-hidden', 'type', 'disabled', 'checked', 'start', 'style', 'src', 'alt', 'loading', 'data-copy-code']);
const CELL_STYLE = /^text-align:(left|center|right)$/;

export function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------- URLs ----------

const NAMED = { colon: ':', sol: '/', tab: '\t', newline: '\n', lpar: '(', rpar: ')', amp: '&', period: '.', num: '#', quot: '"', apos: "'", lt: '<', gt: '>' };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});?/gi, (all, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return NAMED[body.toLowerCase()] ?? all;
  });
}

// Returns the URL to write, or null when the scheme is not http, https, or mailto, or the path is not local.
export function safeUrl(raw) {
  // eslint-disable-next-line no-control-regex
  const url = decodeEntities(String(raw)).replace(/[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, '');
  if (!url || url.length > MAX_URL) return null;
  if (/^(https?:\/\/|mailto:)/i.test(url)) return url;
  if (/^\/(?![/\\])/.test(url) || url[0] === '#') return url;
  return null;
}

export const safeImageUrl = (url) => /^\/attachments\/att_[0-9a-f]{32}$/.test(url) ? url : null;

// ---------- Inline ----------

const PUNCT = /[!-/:-@[-`{-~\u2000-\u206f\u2e00-\u2e7f\u3000-\u303f]/;
const SPACE = /\s/;
const ESCAPABLE = /[!-/:-@[-`{-~]/;

function isPunct(ch) { return !!ch && PUNCT.test(ch); }
function isSpace(ch) { return !ch || SPACE.test(ch); }

// Matching brackets in one pass, so 10,000 nested brackets stay linear.
function bracketPairs(text) {
  const pairs = new Map();
  const stack = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') { i += 1; continue; }
    if (ch === '[') stack.push(i);
    else if (ch === ']' && stack.length) pairs.set(stack.pop(), i);
  }
  return pairs;
}

// [text](url "title"). Returns { url, title, end } or null.
function linkTail(text, at) {
  if (text[at] !== '(') return null;
  let i = at + 1;
  while (text[i] === ' ') i += 1;
  let url = '';
  let depth = 0;
  const limit = Math.min(text.length, i + MAX_URL);
  for (; i < limit; i += 1) {
    const ch = text[i];
    if (ch === '\\' && ESCAPABLE.test(text[i + 1] || '')) { url += text[i + 1]; i += 1; continue; }
    if (SPACE.test(ch)) break;
    if (ch === '(') depth += 1;
    if (ch === ')') { if (!depth) break; depth -= 1; }
    url += ch;
  }
  while (text[i] === ' ') i += 1;
  let title = '';
  const quote = text[i];
  if (quote === '"' || quote === "'") {
    let close = i + 1;
    for (; close < text.length && close - i <= MAX_TITLE; close += 1) {
      if (text[close] === '\\' && ESCAPABLE.test(text[close + 1] || '')) { title += text[close + 1]; close += 1; continue; }
      if (text[close] === quote) break;
      title += text[close];
    }
    if (text[close] !== quote) return null;
    i = close + 1;
    while (text[i] === ' ') i += 1;
  }
  if (text[i] !== ')') return null;
  return { url, title, end: i + 1 };
}

const BARE_URL = /^(https?:\/\/[^\s<>]+)/i;

function trimBareUrl(url) {
  let out = url.replace(/[.,:;!?'"*_~]+$/, '');
  while (out.endsWith(')') && (out.match(/\(/g) || []).length < (out.match(/\)/g) || []).length) out = out.slice(0, -1).replace(/[.,:;!?'"*_~]+$/, '');
  return out;
}

function linkNode(url, title, children) {
  return { type: 'link', url, title, external: /^(https?:|mailto:)/i.test(url), children };
}

// Tokens in a doubly linked list. Emphasis uses the CommonMark delimiter stack with a bottom per character, so it stays linear.
function inlineTokens(text, inLink) {
  const head = { type: 'root' };
  let tail = head;
  const push = (node) => { node.prev = tail; tail.next = node; tail = node; return node; };
  let buffer = '';
  const flush = () => { if (buffer) { push({ type: 'text', value: buffer }); buffer = ''; } };
  const delimiters = [];
  const pairs = bracketPairs(text);
  const noCloser = new Map();

  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === '\n') { flush(); push({ type: 'br' }); i += 2; continue; }
      if (next && ESCAPABLE.test(next)) { buffer += next; i += 2; continue; }
      buffer += ch; i += 1; continue;
    }
    if (ch === '\n') {
      const hard = / {2,}$/.test(buffer);
      buffer = buffer.replace(/ +$/, '');
      flush();
      push(hard ? { type: 'br' } : { type: 'text', value: ' ' });
      i += 1;
      while (text[i] === ' ') i += 1;
      continue;
    }
    if (ch === '`') {
      let run = 1;
      while (text[i + run] === '`') run += 1;
      const failedFrom = noCloser.get(run);
      let close = -1;
      if (failedFrom === undefined || failedFrom > i) {
        let j = i + run;
        while (j < text.length) {
          const k = text.indexOf('`', j);
          if (k < 0) break;
          let r = 1;
          while (text[k + r] === '`') r += 1;
          if (r === run) { close = k; break; }
          j = k + r;
        }
        if (close < 0) noCloser.set(run, i);
      }
      if (close < 0) { buffer += text.slice(i, i + run); i += run; continue; }
      let code = text.slice(i + run, close).replace(/\n/g, ' ');
      if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1);
      flush();
      push({ type: 'code', value: code });
      i = close + run;
      continue;
    }
    if (ch === '<' && !inLink) {
      const auto = /^<([a-z][a-z0-9+.-]{1,31}:[^\s<>]*)>/i.exec(text.slice(i, i + MAX_URL + 2));
      const url = auto && safeUrl(auto[1]);
      if (url && /^(https?:|mailto:)/i.test(url)) {
        flush();
        push(linkNode(url, '', [{ type: 'text', value: auto[1].replace(/^mailto:/i, '') }]));
        i += auto[0].length;
        continue;
      }
    }
    if (ch === '!' && text[i + 1] === '[') {
      const close = pairs.get(i + 1);
      const imageTail = close !== undefined && linkTail(text, close + 1);
      if (imageTail) {
        flush();
        const alt = text.slice(i + 2, close).replace(/\\([!-/:-@[-`{-~])/g, '$1');
        const url = safeImageUrl(imageTail.url);
        push(url ? { type: 'image', url, alt } : { type: 'text', value: alt });
        i = imageTail.end;
        continue;
      }
    }
    if (ch === '[' && !inLink && pairs.has(i)) {
      const close = pairs.get(i);
      const tail = linkTail(text, close + 1);
      if (tail) {
        flush();
        const children = inlineNodes(text.slice(i + 1, close), true);
        const url = safeUrl(tail.url);
        if (url) push(linkNode(url, tail.title, children));
        else push({ type: 'group', children });
        i = tail.end;
        continue;
      }
    }
    if ((ch === 'h' || ch === 'H') && !inLink && !/[a-z0-9]/i.test(text[i - 1] || '')) {
      const bare = BARE_URL.exec(text.slice(i, i + MAX_URL));
      if (bare) {
        const raw = trimBareUrl(bare[1]);
        const url = safeUrl(raw);
        if (url && raw.length > 8) {
          flush();
          push(linkNode(url, '', [{ type: 'text', value: raw }]));
          i += raw.length;
          continue;
        }
      }
    }
    if (ch === '*' || ch === '_' || (ch === '~' && text[i + 1] === '~')) {
      let run = 1;
      while (text[i + run] === ch) run += 1;
      if (ch === '~' && run !== 2) { buffer += text.slice(i, i + run); i += run; continue; }
      const before = text[i - 1] || '';
      const after = text[i + run] || '';
      const left = !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before));
      const right = !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after));
      const canOpen = ch === '_' ? left && (!right || isPunct(before)) : left;
      const canClose = ch === '_' ? right && (!left || isPunct(after)) : right;
      flush();
      const node = push({ type: 'text', value: text.slice(i, i + run), delim: ch, count: run, canOpen, canClose });
      if (canOpen || canClose) delimiters.push(node);
      i += run;
      continue;
    }
    buffer += ch;
    i += 1;
  }
  flush();
  resolveEmphasis(delimiters);
  const out = [];
  for (let node = head.next; node; node = node.next) out.push(node);
  return out;
}

function resolveEmphasis(delimiters) {
  // Link the delimiter stack both ways, so a match removes the inner delimiters in constant time each.
  for (let k = 0; k < delimiters.length; k += 1) {
    delimiters[k].dPrev = delimiters[k - 1] || null;
    delimiters[k].dNext = delimiters[k + 1] || null;
  }
  const remove = (d) => {
    if (d.dPrev) d.dPrev.dNext = d.dNext;
    if (d.dNext) d.dNext.dPrev = d.dPrev;
    d.removed = true;
  };
  const bottom = { '*': null, _: null, '~': null };
  let closer = delimiters[0] || null;
  while (closer) {
    if (!closer.canClose) { closer = closer.dNext; continue; }
    let opener = closer.dPrev;
    let found = null;
    while (opener && opener !== bottom[closer.delim]) {
      if (opener.delim === closer.delim && opener.canOpen) {
        const odd = (opener.canClose || closer.canOpen) && (opener.count + closer.count) % 3 === 0 && (opener.count % 3 || closer.count % 3);
        if (!odd) { found = opener; break; }
      }
      opener = opener.dPrev;
    }
    if (!found) {
      bottom[closer.delim] = closer.dPrev;
      const next = closer.dNext;
      if (!closer.canOpen) remove(closer);
      closer = next;
      continue;
    }
    const use = closer.delim === '~' ? 2 : closer.count >= 2 && found.count >= 2 ? 2 : 1;
    const type = closer.delim === '~' ? 'del' : use === 2 ? 'strong' : 'em';
    // Move the nodes between the two delimiters into a new container node.
    const wrap = { type, children: [], marker: closer.delim.repeat(use) };
    for (let n = found.next; n && n !== closer; n = n.next) wrap.children.push(n);
    wrap.prev = found; wrap.next = closer; found.next = wrap; closer.prev = wrap;
    for (let d = found.dNext; d && d !== closer; d = d.dNext) remove(d);
    found.count -= use; found.value = found.value.slice(use);
    closer.count -= use; closer.value = closer.value.slice(use);
    if (!found.count) { unlink(found); remove(found); }
    if (!closer.count) { const next = closer.dNext; unlink(closer); remove(closer); closer = next; }
  }
}

function unlink(node) {
  if (node.prev) node.prev.next = node.next;
  if (node.next) node.next.prev = node.prev;
}

function inlineNodes(text, inLink = false) {
  return inlineTokens(text, inLink);
}

// Iterative, so deep nesting cannot overflow the call stack.
// Emphasis deeper than MAX_INLINE_DEPTH shows its marks as plain text around the inner text.
function renderInline(nodes) {
  let html = '';
  const stack = [{ nodes, i: 0, close: '', depth: 0 }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.i >= frame.nodes.length) { html += frame.close; stack.pop(); continue; }
    const node = frame.nodes[frame.i];
    frame.i += 1;
    if (node.type === 'text') { html += esc(node.value); continue; }
    if (node.type === 'br') { html += '<br>'; continue; }
    if (node.type === 'image') { html += `<img src="${esc(node.url)}" alt="${esc(node.alt)}" loading="lazy" class="md-attachment">`; continue; }
    if (node.type === 'code') { html += `<code>${esc(node.value)}</code>`; continue; }
    const depth = node.type === 'group' ? frame.depth : frame.depth + 1;
    let open = '';
    let close = '';
    if (node.type === 'link') {
      const title = node.title ? ` title="${esc(node.title)}"` : '';
      open = node.external
        ? `<a href="${esc(node.url)}"${title} target="_blank" rel="noopener noreferrer">`
        : `<a href="${esc(node.url)}"${title}>`;
      close = '</a>';
    } else if (node.type !== 'group' && depth > MAX_INLINE_DEPTH) {
      open = esc(node.marker || '');
      close = open;
    } else if (node.type !== 'group') {
      open = `<${node.type}>`;
      close = `</${node.type}>`;
    }
    html += open;
    stack.push({ nodes: node.children, i: 0, close, depth });
  }
  return html;
}

export function renderInlineMarkdown(text) {
  return renderInline(inlineNodes(String(text ?? '')));
}

// ---------- Blocks ----------

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const LIST = /^( *)([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*)|[ \t]*)$/;
const DELIM_ROW = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

const indentOf = (line) => line.length - line.replace(/^ +/, '').length;
const blank = (line) => !line.trim();

function splitRow(line) {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  const cells = [];
  let cell = '';
  for (let i = 0; i < row.length; i += 1) {
    if (row[i] === '\\' && row[i + 1] === '|') { cell += '|'; i += 1; continue; }
    if (row[i] === '|') { cells.push(cell.trim()); cell = ''; continue; }
    cell += row[i];
  }
  cells.push(cell.trim());
  return cells;
}

function tableStart(lines, i) {
  const line = lines[i];
  const next = lines[i + 1];
  if (next === undefined || !line.includes('|') || !DELIM_ROW.test(next) || !next.includes('-')) return false;
  if (!next.includes('|') && !line.trim().startsWith('|')) return false;
  return splitRow(line).length === splitRow(next).length;
}

// A line that ends a paragraph and starts another block.
function interrupts(lines, i) {
  const line = lines[i];
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST.test(line) && !blank(line.replace(LIST, '$4')) || tableStart(lines, i);
}

// A tab in the source is four spaces while the parser reads the lines. The copy button of a code block still needs the tabs.
// TAB_LINES maps each expanded line that held a tab to its source line for the render in progress. It holds at most 500 lines.
let TAB_LINES = new Map();
const MAX_TAB_LINES = 500;

// The source of a code line. The line is a suffix of an expanded line, because a list or a quote removes a prefix.
function rawLine(line) {
  const exact = TAB_LINES.get(line);
  if (exact !== undefined) return exact;
  if (!line) return line;
  for (const [expanded, raw] of TAB_LINES) {
    if (expanded.length <= line.length || !expanded.endsWith(line)) continue;
    let rest = line.length;
    let at = raw.length;
    while (at > 0 && rest > 0) { at -= 1; rest -= raw[at] === '\t' ? 4 : 1; }
    if (rest === 0) return raw.slice(at);
  }
  return line;
}

function parseBlocks(lines, depth) {
  const blocks = [];
  if (depth > MAX_DEPTH) {
    const text = lines.join('\n').trim();
    if (text) blocks.push({ type: 'raw', text });
    return blocks;
  }
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) { i += 1; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1];
      const indent = indentOf(line);
      const body = [];
      i += 1;
      while (i < lines.length) {
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[i]);
        if (close && close[1][0] === mark[0] && close[1].length >= mark.length) { i += 1; break; }
        body.push(lines[i].replace(new RegExp(`^ {0,${indent}}`), ''));
        i += 1;
      }
      const lang = /^[a-z0-9-]{1,32}$/i.test(fence[2]) ? fence[2].toLowerCase() : '';
      const text = body.join('\n');
      blocks.push({ type: 'code', lang, text, source: TAB_LINES.size ? body.map(rawLine).join('\n') : text });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) { blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] || '' }); i += 1; continue; }

    if (RULE.test(line)) { blocks.push({ type: 'rule' }); i += 1; continue; }

    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && !blank(lines[i])) {
        if (QUOTE.test(lines[i])) inner.push(lines[i].replace(QUOTE, ''));
        else if (inner.length && !blank(inner[inner.length - 1]) && !interrupts(lines, i)) inner.push(lines[i]);
        else break;
        i += 1;
      }
      blocks.push({ type: 'quote', children: parseBlocks(inner, depth + 1) });
      continue;
    }

    if (LIST.test(line)) { i = parseList(lines, i, depth, blocks); continue; }

    if (tableStart(lines, i)) {
      const head = splitRow(line).slice(0, MAX_TABLE_COLUMNS);
      const align = splitRow(lines[i + 1]).slice(0, MAX_TABLE_COLUMNS).map((cell) => (cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : ''));
      const rows = [];
      i += 2;
      while (i < lines.length && !blank(lines[i]) && !interrupts(lines, i) && rows.length < 1000) {
        const cells = splitRow(lines[i]);
        rows.push(head.map((_, c) => cells[c] ?? ''));
        i += 1;
      }
      const numeric = head.map((_, c) => rows.some((row) => row[c]) && rows.every((row) => !row[c] || /^[+\-−]?[\d][\d\s.,:]*%?$/.test(row[c])));
      blocks.push({ type: 'table', head, align, numeric, rows });
      continue;
    }

    const para = [line];
    i += 1;
    while (i < lines.length && !blank(lines[i]) && !interrupts(lines, i)) { para.push(lines[i]); i += 1; }
    blocks.push({ type: 'para', text: para.map((l) => l.replace(/^[ \t]+/, '')).join('\n').replace(/[ \t]+$/, '') });
  }
  return blocks;
}

function parseList(lines, i, depth, blocks) {
  const first = LIST.exec(lines[i]);
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const delim = ordered ? first[2].slice(-1) : first[2];
  const list = { type: 'list', ordered, start: ordered ? parseInt(first[2], 10) : 1, items: [], loose: false };
  while (i < lines.length) {
    const m = LIST.exec(lines[i]);
    if (!m || m[1].length > baseIndent + 1 || m[1].length < baseIndent) break;
    if (/\d/.test(m[2]) !== ordered || (ordered ? m[2].slice(-1) : m[2]) !== delim) break;
    if (RULE.test(lines[i])) break;
    const markerEnd = m[1].length + m[2].length;
    const gap = m[3] ? m[3].length : 1;
    const contentIndent = markerEnd + (gap > 4 ? 1 : gap);
    const childIndent = m[1].length + 2;
    const body = [m[4] ?? ''];
    i += 1;
    let sawBlank = false;
    while (i < lines.length) {
      const line = lines[i];
      if (blank(line)) {
        let j = i + 1;
        while (j < lines.length && blank(lines[j])) j += 1;
        if (j < lines.length && indentOf(lines[j]) >= childIndent) { for (; i < j; i += 1) body.push(''); sawBlank = true; continue; }
        break;
      }
      const indent = indentOf(line);
      if (indent >= childIndent) { body.push(line.slice(Math.min(indent, contentIndent))); i += 1; continue; }
      // A lazy continuation line joins the paragraph of the item.
      if (!interrupts(lines, i) && !blank(body[body.length - 1])) { body.push(line.trim()); i += 1; continue; }
      break;
    }
    let task = null;
    const box = /^\[([ xX])\](?:[ \t]+|$)/.exec(body[0]);
    if (box) { task = box[1] !== ' '; body[0] = body[0].slice(box[0].length); }
    const children = parseBlocks(body, depth + 1);
    if (sawBlank && children.length > 1) list.loose = true;
    list.items.push({ task, children });
    // A blank line between two items makes the list loose.
    if (i < lines.length && blank(lines[i])) {
      let j = i;
      while (j < lines.length && blank(lines[j])) j += 1;
      const next = j < lines.length && LIST.exec(lines[j]);
      if (next && next[1].length >= baseIndent && next[1].length <= baseIndent + 1 && /\d/.test(next[2]) === ordered) { list.loose = true; i = j; }
    }
  }
  blocks.push(list);
  return i;
}

// The copy button of a code block. The click handler in public/copy.js reads the text of the code element.
// The attribute holds the copy text only when the source has tabs, so the button does not repeat the code otherwise.
const copyButton = (source, text) => `<button type="button" class="copy-btn" data-copy-code${source !== text ? `="${esc(source)}"` : ''} aria-label="Copy code"><span class="copy-icon" aria-hidden="true"></span><span class="copy-flash" aria-hidden="true">Copied</span></button>`;

function renderBlocks(blocks, options, tight = false) {
  return blocks.map((block) => {
    switch (block.type) {
      case 'para': return tight ? renderInlineMarkdown(block.text) : `<p>${renderInlineMarkdown(block.text)}</p>`;
      case 'raw': return `<p>${esc(block.text)}</p>`;
      case 'heading': {
        const level = Math.min(6, Math.max(3, block.level + options.headingOffset));
        return `<h${level}>${renderInlineMarkdown(block.text)}</h${level}>`;
      }
      case 'rule': return '<hr>';
      case 'code': return `<div class="md-code">${copyButton(block.source, block.text)}<pre><code${block.lang ? ` class="language-${esc(block.lang)}"` : ''}>${esc(block.text)}</code></pre></div>`;
      case 'quote': return `<blockquote>${renderBlocks(block.children, options)}</blockquote>`;
      case 'table': {
        const cellAttr = (c) => {
          const align = block.align[c];
          const cls = block.numeric[c] ? ' class="n"' : '';
          return `${cls}${align ? ` style="text-align:${align}"` : ''}`;
        };
        const head = block.head.map((cell, c) => `<th${block.align[c] ? ` style="text-align:${block.align[c]}"` : ''}>${renderInlineMarkdown(cell)}</th>`).join('');
        const rows = block.rows.map((row) => `<tr>${row.map((cell, c) => `<td${cellAttr(c)}>${renderInlineMarkdown(cell)}</td>`).join('')}</tr>`).join('');
        return `<div class="md-table-wrap"><div class="md-table" role="region" tabindex="0" aria-label="Table"><table><thead><tr>${head}</tr></thead>${rows ? `<tbody>${rows}</tbody>` : ''}</table></div></div>`;
      }
      case 'list': {
        const tag = block.ordered ? 'ol' : 'ul';
        const start = block.ordered && block.start !== 1 ? ` start="${block.start}"` : '';
        const task = !block.ordered && block.items.every((item) => item.task !== null) ? ' class="md-task"' : '';
        const items = block.items.map((item) => {
          const box = item.task === null ? '' : `<input type="checkbox" disabled${item.task ? ' checked' : ''} aria-label="${item.task ? 'Done' : 'Not done'}"> `;
          const body = renderBlocks(item.children, options, !block.loose);
          return `<li>${box}${item.task === null ? body : `<span>${body}</span>`}</li>`;
        }).join('');
        return `<${tag}${start}${task}>${items}</${tag}>`;
      }
      default: return '';
    }
  }).join('');
}

// Renders Markdown source to safe HTML. A heading offset of 2 renders # as h3.
export function renderMarkdown(source, { headingOffset = 2 } = {}) {
  let text = String(source ?? '');
  let cut = '';
  if (text.length > MAX_INPUT) { text = text.slice(0, MAX_INPUT); cut = '<p>…</p>'; }
  const raw = text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '\ufffd').split('\n');
  const lines = raw.map((line) => line.replace(/\t/g, '    '));
  TAB_LINES = new Map();
  if (text.includes('\t')) raw.forEach((line, i) => { if (line !== lines[i] && TAB_LINES.size < MAX_TAB_LINES) TAB_LINES.set(lines[i], line); });
  try {
    return renderBlocks(parseBlocks(lines, 0), { headingOffset }) + cut;
  } finally {
    TAB_LINES = new Map();
  }
}

// Escaped source text for a render that failed. CSS keeps the line breaks.
export function plainTextHtml(source) {
  return `<p class="md-plain">${esc(String(source ?? ''))}</p>`;
}

// Renders Markdown, or the escaped text when the renderer throws.
export function markdownOrPlain(source, render = renderMarkdown) {
  try {
    return render(source);
  } catch {
    return plainTextHtml(source);
  }
}

// Defense in depth for the browser: removes each element or attribute that is not on the allowlist.
// It takes a DocumentFragment or an element. On renderer output it removes nothing.
export function sanitizeRendered(root) {
  let removed = 0;
  const walk = (parent) => {
    for (const node of [...parent.childNodes]) {
      if (node.nodeType === 3) continue;
      if (node.nodeType !== 1) { node.remove(); removed += 1; continue; }
      const tag = node.localName;
      if (!ALLOWED_TAGS.has(tag)) { node.remove(); removed += 1; continue; }
      if (tag === 'img' && !safeImageUrl(node.getAttribute('src') || '')) { node.remove(); removed += 1; continue; }
      for (const attr of [...node.attributes]) {
        const name = attr.name.toLowerCase();
        const bad = !ALLOWED_ATTRS.has(name)
          || (name === 'src' && (tag !== 'img' || !safeImageUrl(attr.value)))
          || (name === 'alt' && tag !== 'img')
          || (name === 'loading' && (tag !== 'img' || attr.value !== 'lazy'))
          || (name === 'href' && !safeUrl(attr.value))
          || (name === 'style' && !(/^t[hd]$/.test(tag) && CELL_STYLE.test(attr.value)))
          || (name === 'type' && attr.value !== (tag === 'button' ? 'button' : 'checkbox'))
          || (name === 'data-copy-code' && tag !== 'button');
        if (bad) { node.removeAttribute(attr.name); removed += 1; }
      }
      walk(node);
    }
  };
  walk(root);
  return removed;
}
