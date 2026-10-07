export const MEASURE_LIMITS = Object.freeze({
  selectors: 10,
  selectorChars: 200,
  items: 20,
  bytes: 20 * 1024,
});

export function parseMeasureOptions(args) {
  const selectors = [];
  let tab = null;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--tab' && args[index + 1] && tab === null) tab = args[++index];
    else if (args[index] === '--selector' && args[index + 1]) selectors.push(args[++index]);
    else throw new Error('Use --tab ID and --selector CSS to measure a page.');
  }
  if (!selectors.length) throw new Error('Use --tab ID and --selector CSS to measure a page.');
  if (selectors.length > MEASURE_LIMITS.selectors) throw new Error('Use at most 10 selectors.');
  for (const selector of selectors) {
    if (selector.length > MEASURE_LIMITS.selectorChars) throw new Error('Each selector must be at most 200 characters.');
  }
  return { tab, selectors };
}

// The measurement runs one fixed script in the page. The only text that changes is the JSON encoding of the
// selectors array, injected through a replacer function so a dollar or a backtick in a selector is never read
// as a replacement pattern. JSON escapes every quote and backslash, so a selector can never leave the array
// literal and cannot become executable code. The script never collects page text, cookies, storage, or
// attributes: the body text contributes its length only, and every page-controlled field is type-checked.
const SCRIPT_TEMPLATE = `(function (selectors) {
  "use strict";
  const finite = (n) => Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
  const styleValue = (value) => typeof value === "string" && value.length <= 64 && /^[0-9a-z.,() %#-]+$/i.test(value) ? value : null;
  const docEl = document.documentElement;
  const width = window.innerWidth;
  const textLength = document.body && document.body.innerText ? document.body.innerText.length : 0;
  const output = {
    viewport: {
      width: width,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
    },
    overflow: {
      scrollWidth: docEl ? docEl.scrollWidth : 0,
      clientWidth: docEl ? docEl.clientWidth : 0,
      innerWidth: width,
      horizontal: docEl ? docEl.scrollWidth > width : false,
    },
    selectors: [],
    visibleTextLength: Number.isFinite(textLength) ? textLength : 0,
    url: location.href,
  };
  for (const selector of selectors) {
    let nodes;
    try {
      nodes = document.querySelectorAll(selector);
    } catch (error) {
      output.selectors.push({ selector: selector, error: "invalid selector" });
      continue;
    }
    const items = [];
    for (let index = 0; index < nodes.length && index < 20; index += 1) {
      const node = nodes[index];
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      const w = finite(rect.width);
      const h = finite(rect.height);
      items.push({
        x: finite(rect.x),
        y: finite(rect.y),
        width: w,
        height: h,
        fontSize: styleValue(style.fontSize),
        color: styleValue(style.color),
        backgroundColor: styleValue(style.backgroundColor),
        visible: w > 0 && h > 0 && style.display !== "none" && style.visibility !== "hidden",
      });
    }
    const entry = { selector: selector, count: nodes.length };
    if (items.length) entry.items = items;
    output.selectors.push(entry);
  }
  return output;
})(__MEASURE_SELECTORS__)`;

export function measureScript(selectors) {
  const data = JSON.stringify(Array.isArray(selectors) ? selectors : []);
  return SCRIPT_TEMPLATE.replace('__MEASURE_SELECTORS__', () => data);
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8');
}

// Cap the printed JSON at 20 KB. The measure script already limits each listed item list to 20 items; count
// keeps the number of matched nodes. When the output is still larger, cut the biggest item lists first, then
// remove whole selector entries, and as a last resort shorten the URL. Every cut sets truncated to true. A
// smaller output returns unchanged, so truncated stays false.
export function capMeasurement(value) {
  if (jsonBytes(value) <= MEASURE_LIMITS.bytes) return value;
  const result = {
    ...value,
    selectors: (value?.selectors || []).map((entry) => ({ ...entry, items: Array.isArray(entry?.items) ? [...entry.items] : entry?.items })),
  };
  let bytes = jsonBytes(result);
  while (bytes > MEASURE_LIMITS.bytes) {
    const entry = result.selectors
      .filter((candidate) => Array.isArray(candidate?.items) && candidate.items.length > 0)
      .sort((a, b) => b.items.length - a.items.length)[0];
    if (!entry) break;
    entry.items.pop();
    if (!entry.items.length) delete entry.items;
    bytes = jsonBytes(result);
  }
  while (bytes > MEASURE_LIMITS.bytes && result.selectors.length) {
    const at = result.selectors
      .map((entry, index) => ({ index, items: Array.isArray(entry?.items) ? entry.items.length : 0 }))
      .sort((a, b) => b.items - a.items || a.index - b.index)[0].index;
    result.selectors.splice(at, 1);
    bytes = jsonBytes(result);
  }
  while (bytes > MEASURE_LIMITS.bytes && typeof result.url === 'string' && result.url.length > 16) {
    result.url = `${result.url.slice(0, Math.ceil(result.url.length / 2))}...`;
    bytes = jsonBytes(result);
  }
  result.truncated = true;
  return result;
}