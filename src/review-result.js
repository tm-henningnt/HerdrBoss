// The result of a submitted review pack: the JSON, the Markdown summary, and the prompt for the orchestrator.
// See docs/ideas/review-packs.md, sections The result and What the Owner sees.
// The module has no I/O. The store keeps the JSON and the Markdown. The Mailbox path delivers the prompt.
import { redactSecrets } from './redact.js';

export const RESULT_SCHEMA = 'herdr-boss.review-result/1';
export const RESULT_JSON_MAX = 256 * 1024;
export const RESULT_MARKDOWN_MAX = 64 * 1024;
export const PROMPT_MAX = 1500;
export const PROMPT_LINE_MAX = 200;
const PROMPT_TITLE_MAX = 60;
const PROMPT_ID_MAX = 80;

export const VERDICTS = ['accept', 'accept-with-changes', 'deny'];
export const VERDICT_LABEL = { accept: 'Accept pack', 'accept-with-changes': 'Accept with changes', deny: 'Deny pack' };
// A result that an earlier build stored keeps its own label.
const LEGACY_LABEL = { approve: 'Approve', 'request-changes': 'Request changes', comment: 'Comment' };
export const verdictLabel = (verdict) => VERDICT_LABEL[verdict] ?? LEGACY_LABEL[verdict] ?? String(verdict);

const LINE_BREAKS = /\r\n|[\r\n\u000b\u000c\u0085\u2028\u2029]/g;
const CONTROLS = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g;
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Cut on a code point boundary. A cut text ends with "…" and has at most `max` code points.
function cutText(text, max) {
  const points = Array.from(text);
  if (points.length <= max) return text;
  return `${points.slice(0, max - 1).join('')}…`;
}

// One line: no line break, no control character, no repeated space. A text cannot start a second prompt line.
export function singleLine(text, max) {
  const plain = String(text ?? '').replace(LINE_BREAKS, ' ').replace(CONTROLS, ' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  return cutText(plain, max);
}

// Text for a Markdown quote: line breaks stay, controls go.
function multiLine(text) {
  return String(text ?? '').replace(LINE_BREAKS, '\n').replace(CONTROLS, '').replace(INVISIBLE, '').replace(/\n{3,}/g, '\n\n').trim();
}

const quote = (text, indent = '') => multiLine(text).split('\n').map((line) => `${indent}> ${line}`.trimEnd()).join('\n');

// The verdict that the summary screen proposes from the counts. The Owner can choose another one.
export function proposeVerdict(counts = {}) {
  const { items = 0, accepted = 0, denied = 0, live = 0, noteOnly = 0, open = 0 } = counts;
  if (!items) return 'accept-with-changes';
  if (denied > 0) return accepted + noteOnly + live === 0 ? 'deny' : 'accept-with-changes';
  if (live > 0 || open > 0) return 'accept-with-changes';
  return 'accept';
}

// ---------- JSON ----------

// The result of a pack at one version. It holds ids, states, and the Owner's notes. It holds no file content and no image.
export function buildResult(pack, verdict, note, at) {
  const specs = new Map(pack.manifest.sections.flatMap((section) => section.items).map((entry) => [entry.id, entry]));
  const items = pack.items.map((item) => {
    const out = { id: item.id, title: item.title, section: item.section, hash: item.hash, state: item.state };
    const answer = item.answer;
    if (item.stale) out.stale = true;
    if (item.state === 'changed' && answer?.previous) {
      const { decision, choice, rating, live, at } = answer.previous;
      out.was = Object.fromEntries(Object.entries({ decision, choice, rating, live, at }).filter(([, value]) => value != null));
    }
    if (answer) {
      if (answer.decision) out.decision = answer.decision;
      if (answer.choice !== null) out.choice = answer.choice;
      if (answer.rating !== null) out.rating = answer.rating;
      if (answer.live) out.live = answer.live;
      if (answer.note) out.note = answer.note;
      if (answer.pins.length) out.pins = answer.pins;
      if (Object.keys(answer.checks).length) out.checks = answer.checks;
    }
    const entries = specs.get(item.id)?.entries;
    if (entries) out.unchecked = entries.filter((entry) => !answer?.checks?.[entry.id]).map((entry) => entry.id);
    return out;
  });
  return {
    schema: RESULT_SCHEMA,
    slug: pack.slug,
    pack: pack.pack,
    title: pack.title,
    version: pack.version,
    submittedAt: at,
    verdict,
    note,
    counts: pack.derived.counts,
    sections: pack.derived.sections.map((section) => ({ id: section.id, state: section.state })),
    items,
    removed: pack.removed.map((entry) => ({ id: entry.id, decision: entry.answer.decision, note: entry.answer.note })),
  };
}

const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value));
// The items that a cut leaves out first.
const OMIT_ORDER = ['accepted', 'answered', 'open', 'changed', 'note', 'live', 'denied'];

// Keep the JSON at RESULT_JSON_MAX bytes. The cut shortens the notes first, then leaves items out, and names the cut in `truncated`.
// It returns { result, json } with the result that the JSON holds.
export function boundResult(result, max = RESULT_JSON_MAX) {
  if (bytesOf(result) <= max) return { result, json: JSON.stringify(result) };
  const room = max - 1024;
  const out = { ...result, items: result.items.map((item) => ({ ...item })), removed: (result.removed ?? []).map((item) => ({ ...item })) };
  const cutNotes = (limit, dropPins) => {
    for (const list of [out.items, out.removed]) {
      for (const item of list) {
        if (item.note) item.note = cutText(item.note, limit);
        if (dropPins) delete item.pins;
      }
    }
    out.note = cutText(out.note ?? '', 2000);
  };
  const marks = { notesCut: false, itemsOmitted: 0 };
  for (const [limit, dropPins] of [[500, false], [100, true], [0, true]]) {
    if (bytesOf(out) <= room) break;
    marks.notesCut = true;
    if (limit === 0) for (const list of [out.items, out.removed]) for (const item of list) delete item.note;
    else cutNotes(limit, dropPins);
  }
  for (const state of OMIT_ORDER) {
    while (bytesOf(out) > room) {
      const at = out.items.findLastIndex((item) => item.state === state);
      if (at < 0) break;
      out.items.splice(at, 1);
      marks.itemsOmitted += 1;
    }
    if (bytesOf(out) <= room) break;
  }
  while (bytesOf(out) > room && out.removed.length) out.removed.pop();
  out.truncated = {
    marker: `cut: the result was longer than ${RESULT_JSON_MAX / 1024} KB.${marks.notesCut ? ' Some notes are shortened.' : ''}${marks.itemsOmitted ? ` ${plural(marks.itemsOmitted, 'item')} left out.` : ''}`,
    ...marks,
  };
  return { result: out, json: JSON.stringify(out) };
}

// ---------- Markdown ----------

function cutBytes(text, max) {
  if (Buffer.byteLength(text) <= max) return text;
  return Buffer.from(text).subarray(0, max).toString('utf8').replace(/\ufffd+$/, '');
}

const countLine = (counts = {}) => `Denied: ${counts.denied ?? 0}. Needs live check: ${counts.live ?? 0}. Notes: ${counts.noteOnly ?? 0}. Accepted: ${counts.accepted ?? 0}. Open: ${counts.open ?? 0}${counts.changed ? ` (${counts.changed} changed)` : ''}.`;

// The Markdown summary of a result: the counts, then the denied and the needs-live-check items with the Owner's notes quoted,
// then the rest. `titles` (id to title) fills the title of an item that the result holds without one.
export function resultMarkdown(result, titles = new Map()) {
  const name = (item) => {
    const title = item.title ?? titles.get(item.id);
    return title ? `**${item.id}** (${singleLine(title, 120)})` : `**${item.id}**`;
  };
  const lines = [`# Review result: ${singleLine(result.title ?? result.pack, 120)} v${result.version}, ${verdictLabel(result.verdict)}`, ''];
  lines.push(`${countLine(result.counts)} Submitted ${result.submittedAt}.`, '');
  if (result.note) lines.push('## Pack note', '', quote(result.note), '');
  const group = (heading, items, render) => {
    if (!items.length) return;
    lines.push(`## ${heading}`, '');
    for (const item of items) lines.push(render(item));
    lines.push('');
  };
  const noted = (head, item, extra = '') => `- ${head}${extra}${item.note ? `\n${quote(item.note, '  ')}` : ''}`;
  const items = result.items ?? [];
  group('Denied', items.filter((item) => item.state === 'denied'), (item) => noted(name(item), item, item.pins?.length ? ` (${plural(item.pins.length, 'pin')})` : ''));
  group('Needs live check', items.filter((item) => item.state === 'live'), (item) => noted(name(item), item));
  group('Notes', items.filter((item) => item.state === 'note' || (item.state === 'accepted' && item.note)), (item) => noted(name(item), item, item.state === 'accepted' ? ' (accepted)' : ''));
  group('Answered', items.filter((item) => item.state === 'answered'), (item) => noted(name(item), item, `: ${item.choice !== undefined ? `choice ${item.choice}` : item.rating !== undefined ? `rating ${item.rating}` : 'live check done'}`));
  group('Changed since accepted', items.filter((item) => item.state === 'changed'), (item) => noted(name(item), item, item.was?.decision ? ` (was ${item.was.decision})` : ' (changed in this version)'));
  group('Open', items.filter((item) => item.state === 'open'), (item) => noted(name(item), item, item.stale ? ' (changed in this version)' : ''));
  const accepted = items.filter((item) => item.state === 'accepted' && !item.note).map((item) => item.id);
  if (accepted.length) lines.push('## Accepted', '', accepted.join(', '), '');
  group('Unticked checklist entries', items.filter((item) => item.unchecked?.length), (item) => `- ${item.id}: ${item.unchecked.join(', ')}`);
  group('Removed in this version', result.removed ?? [], (item) => noted(`**${item.id}**`, item, item.decision ? ` (was ${item.decision})` : ''));
  if (result.truncated?.marker) lines.push(`> ${result.truncated.marker}`, '');
  const text = `${lines.join('\n').trimEnd()}\n`;
  if (Buffer.byteLength(text) <= RESULT_MARKDOWN_MAX) return text;
  const marker = `\n\nCut: the summary is longer than ${RESULT_MARKDOWN_MAX / 1024} KB. Fetch the JSON for the full result.\n`;
  return `${cutBytes(text, RESULT_MARKDOWN_MAX - Buffer.byteLength(marker)).trimEnd()}${marker}`;
}

// ---------- Prompt ----------

// The prompt for the orchestrator pane. It has the pack, the version, the verdict, the counts, the denied and the needs-live-check
// items with the notes, and the fetch command. It has at most PROMPT_MAX characters, and each line except the command has at most
// PROMPT_LINE_MAX. Every Owner text goes through singleLine() and redactSecrets(), so a note cannot add a line to the prompt.
export function promptText(result) {
  const counts = result.counts ?? {};
  const one = (value, max) => singleLine(redactSecrets(String(value ?? '')), max);
  const header = cutText(`[owner] Review of ${one(result.title ?? result.pack, PROMPT_TITLE_MAX)} v${result.version}: ${verdictLabel(result.verdict)}. Denied: ${counts.denied ?? 0}, needs live check: ${counts.live ?? 0}, notes: ${counts.noteOnly ?? 0}, accepted: ${counts.accepted ?? 0}, open: ${counts.open ?? 0}.`, PROMPT_LINE_MAX);
  const footer = `Fetch the full result: herdr-boss review result ${result.pack} --version ${result.version} --format json|md`;
  const itemLine = (label, item) => cutText(`${label}: ${one(item.id, PROMPT_ID_MAX)}${item.note ? `: ${one(item.note, PROMPT_LINE_MAX)}` : ''}`, PROMPT_LINE_MAX);
  const candidates = [
    ...(result.note ? [cutText(`Pack note: ${one(result.note, PROMPT_LINE_MAX)}`, PROMPT_LINE_MAX)] : []),
    ...(result.items ?? []).filter((item) => item.state === 'denied').map((item) => itemLine('Denied', item)),
    ...(result.items ?? []).filter((item) => item.state === 'live').map((item) => itemLine('Needs live check', item)),
  ];
  const included = [];
  for (const line of candidates) {
    const left = candidates.length - included.length - 1;
    const trial = [header, ...included, line, ...(left ? [`… ${left} more`] : []), footer].join('\n');
    if (trial.length > PROMPT_MAX) break;
    included.push(line);
  }
  const left = candidates.length - included.length;
  return [header, ...included, ...(left ? [`… ${left} more`] : []), footer].join('\n');
}
