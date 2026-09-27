// The versioned Herdr Boss block in a project AGENTS.md and the drift check for that file.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { KIT_ROOT, loadModels } from './config.js';
import { mergeModels } from '../control.js';

export const BLOCK_TEMPLATE = path.join(KIT_ROOT, 'kit', 'templates', 'agents-section.md');
const BEGIN = /^\s*<!--\s*herdr-boss:begin(?:\s+v=(\S*))?\s*-->\s*$/;
const END = /^\s*<!--\s*herdr-boss:end\s*-->\s*$/;
const MEMORY = 'move it to docs/orchestration/memory.md';

// Line endings and trailing whitespace do not change the hash.
function normalize(text) { return String(text).replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trimEnd(); }

export function blockHash(body) { return createHash('sha256').update(normalize(body)).digest('hex').slice(0, 12); }

// The current block body, its hash, and the full marked block to paste into a project file.
export function agentsBlock(file = BLOCK_TEMPLATE) {
  const body = normalize(fs.readFileSync(file, 'utf8'));
  const hash = blockHash(body);
  return { hash, body, block: `<!-- herdr-boss:begin v=${hash} -->\n${body}\n<!-- herdr-boss:end -->\n` };
}

// The local policy copy in the rules file. A missing or unreadable file gives no policy.
export function rulesPolicy(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8'))?.policy ?? null; }
  catch { return null; }
}

// All model IDs of kit/models.json plus the policy extraModels, the same merge as herdr-boss models.
export function mergedModelIds(rulesFile, models = loadModels()) {
  const merged = mergeModels(models, rulesPolicy(rulesFile));
  return [...new Set(Object.values(merged.kinds).flatMap((kind) => kind.allowedModels || []))];
}

const STALE = [
  [/\bherdr agent start\b/, 'herdr agent start is not the worker path; use herdr-boss worker start'],
  [/\bherdr pane split\b/, 'herdr pane split is not the worker path; use herdr-boss worker start'],
  [/\bdashboard:update\b/, 'dashboard:update is not used; publish status with herdr-boss publish'],
];
// A line that forbids a process command or port 9222 is a safety rule, not drift.
const PROHIBITION = /\b(?:do not|don't|never)\b/i;
const PORT = /(?<![\w.])9222(?!\w)/;
const PROCESS = /\bpgrep\s+-f|\bps\s+aux\b|\bps\s+-ef\b/;
const PANE_ID = /\bw[0-9A-Za-z]+:p[0-9A-Za-z]+\b/;
const DATE = /\b20\d\d-\d\d-\d\d\b|\b\d{1,2}\.?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b/;
// A token that looks like a model ID. gpt-, claude-, deepseek, and muse-spark need a digit, so claude-code is not a model.
const MODEL_TOKEN = /(?<![\w/.-])(?:opencode(?:-go)?\/[\w.-]+|(?:gpt-|claude-|deepseek|muse-spark)[\w.-]*\d[\w.-]*)/g;

function modelTokens(line) { return [...line.matchAll(MODEL_TOKEN)].map((match) => match[0].replace(/[.-]+$/, '')); }

// Findings for the text of an AGENTS.md file: [{ level: 'error'|'warn', line, message }].
// hash is the current block hash. models is the merged list of allowed model IDs.
export function checkAgentsText(text, { hash, models = [] } = {}) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const allowed = new Set(models);
  const findings = [];
  const add = (level, line, message) => findings.push({ level, line, message });
  const begins = [];
  const ends = [];
  lines.forEach((line, index) => {
    if (BEGIN.test(line)) begins.push(index);
    else if (END.test(line)) ends.push(index);
  });
  let block = null;
  if (!begins.length) add('error', 1, 'no begin marker; run herdr-boss kit block and paste the block');
  if (!ends.length) add('error', begins.length ? begins[0] + 1 : 1, 'no end marker; run herdr-boss kit block and paste the block');
  if (begins.length > 1 || ends.length > 1) add('error', (begins[1] ?? ends[1]) + 1, 'more than one block; keep one Herdr Boss block');
  else if (begins.length === 1 && ends.length === 1) {
    if (ends[0] < begins[0]) add('error', ends[0] + 1, 'end marker before begin marker');
    else block = { begin: begins[0], end: ends[0] };
  }
  if (block) {
    const version = BEGIN.exec(lines[block.begin])[1] || '';
    const own = blockHash(lines.slice(block.begin + 1, block.end).join('\n'));
    if (version !== hash) add('error', block.begin + 1, 'old kit block; run herdr-boss kit block');
    if (own !== version) add('error', block.begin + 1, 'block edited by hand; replace it with the output of herdr-boss kit block');
  }

  const copied = [];
  lines.forEach((line, index) => {
    const number = index + 1;
    const inside = block && index >= block.begin && index <= block.end;
    if (inside) return;
    for (const [pattern, message] of STALE) if (pattern.test(line)) add('warn', number, message);
    if (PORT.test(line) && !PROHIBITION.test(line)) add('warn', number, 'port 9222 is the Chrome of another project; use herdr-boss browser request');
    if (PROCESS.test(line) && !PROHIBITION.test(line)) add('warn', number, 'a process command prints command lines; use pgrep -l or ps -o pid,ppid,etime,comm');
    if (PANE_ID.test(line)) add('warn', number, `fixed pane ID ${PANE_ID.exec(line)[0]}; ${MEMORY}`);
    if (DATE.test(line)) add('warn', number, `dated line; ${MEMORY}`);
    for (const model of modelTokens(line)) {
      if (!allowed.has(model)) add('warn', number, `${model} is not in the model list; run herdr-boss models`);
      else copied.push({ model, number });
    }
  });
  const distinct = new Set(copied.map((item) => item.model));
  if (distinct.size >= 3) add('warn', copied[0].number, `copied model list (${distinct.size} models); use herdr-boss models and herdr-boss lanes`);
  return findings.sort((a, b) => a.line - b.line || (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
}

function plural(count, word) { return `${count} ${word}${count === 1 ? '' : 's'}`; }

// Reads a file and checks it. relative is the file name to report.
export function checkAgentsFile(file, { rulesFile, relative = file } = {}) {
  const findings = checkAgentsText(fs.readFileSync(file, 'utf8'), { hash: agentsBlock().hash, models: mergedModelIds(rulesFile) });
  const errors = findings.filter((finding) => finding.level === 'error').length;
  const warnings = findings.length - errors;
  return {
    file: relative,
    findings,
    errors,
    warnings,
    lines: findings.map((finding) => `${finding.level} line ${finding.line}: ${finding.message}`),
    summary: `${relative}: ${plural(errors, 'error')}, ${plural(warnings, 'warning')}`,
  };
}
