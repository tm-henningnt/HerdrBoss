import { ATTACHMENT_URL, uploadLocalPictures, deleteAttachment } from './attachments.js';

// Find inline Markdown images, outside escapes, code spans and fenced code blocks.
// Keep offsets so an upload changes only the target, not the report's other text.
export function imageReferences(text) {
  const references = []; let fence = null;
  for (let at = 0; at < text.length; at += 1) {
    if (at === 0 || text[at - 1] === '\n') {
      const marker = /^ {0,3}(`{3,}|~{3,})[^\n]*/.exec(text.slice(at));
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
        at += marker[0].length; continue;
      }
    }
    if (fence) continue;
    if (text[at] === '\\') { at += 1; continue; }
    if (text[at] === '`') {
      let count = 1; while (text[at + count] === '`') count += 1;
      const marker = '`'.repeat(count); let close = text.indexOf(marker, at + count);
      while (close >= 0 && (text[close - 1] === '`' || text[close + count] === '`')) close = text.indexOf(marker, close + count);
      if (close >= 0) at = close + count - 1;
      else at += count - 1;
      continue;
    }
    if (text[at] !== '!' || text[at + 1] !== '[') continue;
    let close = at + 2; let depth = 1;
    for (; close < text.length && depth; close += 1) {
      if (text[close] === '\\') close += 1;
      else if (text[close] === '[') depth += 1;
      else if (text[close] === ']') depth -= 1;
    }
    if (depth || text[close] !== '(') continue;
    let start = close + 1; while (text[start] === ' ') start += 1;
    let end = start; let nested = 0; const angle = text[start] === '<';
    if (angle) { start += 1; end = text.indexOf('>', start); if (end < 0) continue; }
    else {
      for (; end < text.length; end += 1) {
        if (text[end] === '\\') { end += 1; continue; }
        if (text[end] === '(') nested += 1;
        if (text[end] === ')') { if (!nested) break; nested -= 1; }
        if (/\s/.test(text[end])) break;
      }
    }
    let finish = angle ? end + 1 : end; while (text[finish] === ' ') finish += 1;
    if (['"', "'"].includes(text[finish])) {
      const quote = text[finish++];
      while (finish < text.length && text[finish] !== quote) { if (text[finish] === '\\') finish += 1; finish += 1; }
      finish += 1; while (text[finish] === ' ') finish += 1;
    }
    if (text[finish] !== ')') continue;
    references.push({ start: angle ? start - 1 : start, end: angle ? end + 1 : end, target: text.slice(start, end).replace(/\\([!-/:-@[-`{-~])/g, '$1') });
    at = finish;
  }
  return references;
}

export function uploadReportPictures(text, options = {}) {
  const references = imageReferences(text);
  const local = references.filter(({ target }) => !ATTACHMENT_URL.test(target) && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target));
  const files = [...new Set(local.map(({ target }) => target))];
  const existing = [...new Set(references.filter(({ target }) => ATTACHMENT_URL.test(target)).map(({ target }) => target.slice('/attachments/'.length)))];
  if (files.length + existing.length > 6) throw new Error('A report accepts at most 6 pictures.');
  const stored = uploadLocalPictures(files, options);
  const byFile = new Map(files.map((file, index) => [file, stored[index].id]));
  let rewritten = text;
  for (const { start, end, target } of [...local].reverse()) rewritten = rewritten.slice(0, start) + `/attachments/${byFile.get(target)}` + rewritten.slice(end);
  return { text: rewritten, attachments: [...existing, ...stored.map(({ id }) => id)], rollback: () => { for (const { id } of stored) deleteAttachment(id, options); } };
}
