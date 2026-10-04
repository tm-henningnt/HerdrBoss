// Finds the text of string literals in a browser source file, so that a test can check the words that the user reads.
// Each segment is the plain text of one literal, or of one part of a template literal between two `${}` holes.
// The text of an HTML tag, a code span, or a `<code>` element is removed, because those name real identifiers.

export function literalSegments(source) {
  const segments = [];
  const n = source.length;
  let line = 1;

  function skipTemplate(i, startLine) {
    // i is just after the opening backtick. Returns the index after the closing backtick.
    let text = '';
    let textLine = startLine;
    let textStart = i;
    while (i < n) {
      const ch = source[i];
      if (ch === '\\') { text += source[i + 1] === 'n' ? '\n' : source[i + 1]; i += 2; continue; }
      if (ch === '\n') line += 1;
      if (ch === '`') { segments.push({ line: textLine, text, start: textStart, end: i }); return i + 1; }
      if (ch === '$' && source[i + 1] === '{') {
        segments.push({ line: textLine, text, start: textStart, end: i });
        text = '';
        i = skipCode(i + 2, true);
        textLine = line;
        textStart = i;
        continue;
      }
      text += ch;
      i += 1;
    }
    return i;
  }

  function skipCode(i, inHole) {
    let depth = 0;
    let prevSignificant = '';
    while (i < n) {
      const ch = source[i];
      if (ch === '\n') { line += 1; i += 1; continue; }
      if (ch === '/' && source[i + 1] === '/') { while (i < n && source[i] !== '\n') i += 1; continue; }
      if (ch === '/' && source[i + 1] === '*') {
        i += 2;
        while (i < n && !(source[i] === '*' && source[i + 1] === '/')) { if (source[i] === '\n') line += 1; i += 1; }
        i += 2;
        continue;
      }
      if (ch === '\'' || ch === '"') {
        const startLine = line;
        let text = '';
        i += 1;
        const start = i;
        while (i < n && source[i] !== ch && source[i] !== '\n') {
          if (source[i] === '\\') { text += source[i + 1]; i += 2; continue; }
          text += source[i];
          i += 1;
        }
        segments.push({ line: startLine, text, start, end: i });
        i += 1;
        prevSignificant = ch;
        continue;
      }
      if (ch === '`') { i = skipTemplate(i + 1, line); prevSignificant = '`'; continue; }
      if (ch === '/' && /[=(,:;!&|?{}[\n]|^$/.test(prevSignificant)) {
        // a regular expression literal
        i += 1;
        let inClass = false;
        while (i < n && source[i] !== '\n') {
          if (source[i] === '\\') { i += 2; continue; }
          if (source[i] === '[') inClass = true;
          else if (source[i] === ']') inClass = false;
          else if (source[i] === '/' && !inClass) break;
          i += 1;
        }
        i += 1;
        while (/[a-z]/.test(source[i] || '')) i += 1;
        prevSignificant = 'x';
        continue;
      }
      if (inHole) {
        if (ch === '{') depth += 1;
        else if (ch === '}') { if (depth === 0) return i + 1; depth -= 1; }
      }
      if (!/\s/.test(ch)) prevSignificant = ch;
      i += 1;
    }
    return i;
  }

  skipCode(0, false);
  return segments;
}

// The words that the user reads: no HTML tags, no `<code>` elements, no Markdown code spans.
// An attribute value stays when the user reads it: title, aria-label, placeholder, and alt.
const READ_ATTRIBUTES = new Set(['title', 'aria-label', 'placeholder', 'alt']);

export function readableText(text) {
  return text
    .replace(/<code\b[^>]*>[\s\S]*?<\/code>/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    // an attribute, also when a `${}` hole cuts the tag into several segments
    .replace(/([\w:-]+)=(?:"([^"]*)"?|'([^']*)'?)/g, (all, name, a, b) => (READ_ATTRIBUTES.has(name) ? ` ${a ?? b} ` : ' '))
    .replace(/<[^>]*>?/g, ' ')
    .replace(/^[^<]*?>/, ' ');
}
