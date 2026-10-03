import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function readOrEmpty(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }

function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

// Scan complete TOML statements so table-shaped text inside multiline values stays data.
function tomlStatements(text) {
  const statements = [];
  let start = 0, quote = '', depth = 0, comment = false, codeEnd = null;
  for (let index = 0; index <= text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (quote[0] === '"' && char === '\\') { index += 1; continue; }
      if (text.startsWith(quote, index)) { index += quote.length - 1; quote = ''; }
      continue;
    }
    if (comment && char !== '\n' && index !== text.length) continue;
    if (!comment && (char === '"' || char === "'")) {
      quote = text.startsWith(char.repeat(3), index) ? char.repeat(3) : char;
      index += quote.length - 1;
      continue;
    }
    if (!comment && char === '#') { comment = true; codeEnd ??= index; }
    if (!comment && (char === '[' || char === '{')) depth += 1;
    if (!comment && (char === ']' || char === '}')) depth -= 1;
    if ((char === '\n' && depth === 0) || index === text.length) {
      const end = codeEnd ?? index;
      const raw = text.slice(start, end).trim();
      if (raw) statements.push({ start, end, next: index + 1, raw });
      start = index + 1;
      codeEnd = null;
    } else if (char === '\n') codeEnd = null;
    if (char === '\n') comment = false;
  }
  if (quote || depth !== 0) throw new Error('The Codex configuration is invalid.');
  return statements;
}

function tomlKey(text) {
  const keys = [];
  let index = 0;
  const token = /\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*/y;
  do {
    token.lastIndex = index;
    const match = token.exec(text);
    if (!match) throw new Error('The Codex configuration key cannot be merged.');
    const raw = match[1];
    keys.push(raw[0] === '"' ? JSON.parse(raw) : raw[0] === "'" ? raw.slice(1, -1) : raw);
    index = token.lastIndex;
    if (text[index] !== '.') break;
    index += 1;
  } while (index < text.length);
  return { keys, index };
}

const quoteTomlKey = (key) => /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);

function mergeCodexState(text, roots) {
  const targets = [...roots.map((root) => ({ keys: ['projects', root, 'trust_level'], value: '"trusted"' })),
    { keys: ['notice', 'hide_full_access_warning'], value: 'true' }];
  const edits = [];
  const tables = new Map();
  let section = [];
  for (const statement of tomlStatements(text)) {
    if (statement.raw.startsWith('[')) {
      const array = statement.raw.startsWith('[[');
      const body = statement.raw.slice(array ? 2 : 1, array ? -2 : -1);
      section = tomlKey(body).keys;
      if (array && targets.some((target) => section.every((key, index) => key === target.keys[index]))) {
        throw new Error('Use TOML tables for the Codex first-run state.');
      }
      if (!array) tables.set(JSON.stringify(section), statement.next);
      continue;
    }
    const leading = text.slice(statement.start, statement.end).match(/^\s*/)[0].length;
    const parsed = tomlKey(statement.raw);
    if (statement.raw[parsed.index] !== '=') throw new Error('The Codex configuration cannot be merged.');
    const keys = [...section, ...parsed.keys];
    for (const target of targets) {
      const table = target.keys.slice(0, -1);
      if (keys.length > table.length && table.every((key, index) => key === keys[index])) {
        target.sibling = { position: statement.next, keys: target.keys.slice(section.length) };
      }
      if (keys.length <= target.keys.length && keys.every((key, index) => key === target.keys[index])) {
        if (keys.length !== target.keys.length) throw new Error('Use TOML tables for the Codex first-run state.');
        if (target.found) throw new Error('The Codex first-run state has a duplicate key.');
        const valueStart = statement.start + leading + parsed.index + 1;
        const valueText = text.slice(valueStart, statement.end);
        const whitespace = valueText.match(/^\s*/)[0].length;
        const trailing = valueText.match(/\s*$/)[0].length;
        edits.push({ start: valueStart + whitespace, end: statement.end - trailing, text: target.value });
        target.found = true;
      }
    }
  }
  for (const target of targets.filter((item) => !item.found)) {
    const table = target.keys.slice(0, -1);
    const tablePosition = tables.get(JSON.stringify(table));
    const key = tablePosition !== undefined ? target.keys.at(-1) : (target.sibling?.keys ?? [target.keys.at(-1)]).map(quoteTomlKey).join('.');
    const line = `${key} = ${target.value}\n`;
    const position = tablePosition ?? target.sibling?.position;
    if (position !== undefined) edits.push({ start: Math.min(position, text.length), end: Math.min(position, text.length), text: `${position > text.length ? '\n' : ''}${line}` });
    else {
      const header = table.map(quoteTomlKey).join('.');
      edits.push({ start: text.length, end: text.length, tableAddition: true, text: `\n[${header}]\n${line}` });
    }
  }
  // At one offset, insert new tables first so later key insertions stay in their original table.
  for (const edit of edits.sort((a, b) => b.start - a.start || Number(Boolean(b.tableAddition)) - Number(Boolean(a.tableAddition)))) {
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  }
  return text;
}

// Change first-run preferences and folder trust only. Credential files stay untouched.
export function prepareHarnessHome(harness, roots, home = process.env.HOME) {
  if (harness === 'codex') {
    const file = path.join(home, '.codex', 'config.toml');
    const previous = readOrEmpty(file);
    const text = mergeCodexState(previous, roots);
    if (previous !== text) writePrivate(file, text);
    else fs.chmodSync(file, 0o600);
    return;
  }
  if (harness !== 'claude') throw new Error('The harness first-run state is not supported.');
  const file = path.join(home, '.claude.json');
  const previous = readOrEmpty(file);
  const state = previous ? JSON.parse(previous) : {};
  if (!object(state) || (state.projects !== undefined && !object(state.projects))) {
    throw new Error('The Claude first-run state is invalid.');
  }
  state.hasCompletedOnboarding = true;
  if (typeof state.theme !== 'string' || !state.theme) state.theme = 'dark';
  state.projects ??= {};
  for (const root of roots) {
    const project = state.projects[root] ?? {};
    if (!object(project)) throw new Error('The Claude project state is invalid.');
    state.projects[root] = { ...project, hasTrustDialogAccepted: true };
  }
  const text = `${JSON.stringify(state, null, 2)}\n`;
  if (previous !== text) writePrivate(file, text);
  else fs.chmodSync(file, 0o600);
}
