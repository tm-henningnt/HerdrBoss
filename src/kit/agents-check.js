// The Herdr Boss kit file and the stub in a project AGENTS.md, and the drift check for both files.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { KIT_ROOT, loadModels } from './config.js';
import { mergeModels } from '../control.js';

export const STUB_TEMPLATE = path.join(KIT_ROOT, 'kit', 'templates', 'agents-stub.md');
export const KIT_TEMPLATE = path.join(KIT_ROOT, 'kit', 'templates', 'project-kit.md');
// The kit file path in a project repository, relative to its Git top level.
export const KIT_FILE = 'docs/orchestration/herdr-boss.md';
const KIT_NOTE = 'Herdr Boss writes this file. Do not edit it. Run herdr-boss kit install to update it.';
const KIT_VERSION = /^<!--\s*herdr-boss kit v=(\S*)\s*-->$/;
// The Claude SessionStart hook prints the kit file and the project memory. A missing file does not fail the hook.
export const HOOK_COMMAND = 'cd "${CLAUDE_PROJECT_DIR:-.}" && cat docs/orchestration/herdr-boss.md docs/orchestration/memory.md 2>/dev/null; exit 0';
const INSTALL = 'run herdr-boss kit install';
const BEGIN = /^\s*<!--\s*herdr-boss:begin(?:\s+v=(\S*))?\s*-->\s*$/;
const END = /^\s*<!--\s*herdr-boss:end\s*-->\s*$/;
const MEMORY = 'move it to docs/orchestration/memory.md';

// Line endings and trailing whitespace do not change the hash.
function normalize(text) { return String(text).replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trimEnd(); }

export function blockHash(body) { return createHash('sha256').update(normalize(body)).digest('hex').slice(0, 12); }

// The current stub body, its hash, and the full marked stub for a project AGENTS.md.
export function agentsBlock(file = STUB_TEMPLATE) {
  const body = normalize(fs.readFileSync(file, 'utf8'));
  const hash = blockHash(body);
  return { hash, body, block: `<!-- herdr-boss:begin v=${hash} -->\n${body}\n<!-- herdr-boss:end -->\n` };
}

// The current kit body, its revision, and the full text of docs/orchestration/herdr-boss.md.
export function projectKit(file = KIT_TEMPLATE) {
  const body = normalize(fs.readFileSync(file, 'utf8'));
  const revision = blockHash(body);
  return { revision, body, text: `<!-- herdr-boss kit v=${revision} -->\n${KIT_NOTE}\n\n${body}\n` };
}

// The current kit revision, or null when the template cannot be read.
export function kitRevision() {
  try { return projectKit().revision; } catch { return null; }
}

// Findings for the text of docs/orchestration/herdr-boss.md. text is null for a missing file.
export function checkKitText(text, revision) {
  const findings = [];
  const add = (message) => findings.push({ level: 'error', line: 1, message: `${KIT_FILE} ${message}` });
  if (text == null) { findings.push({ level: 'error', line: 1, message: `${KIT_FILE} is missing; ${INSTALL}` }); return findings; }
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const match = KIT_VERSION.exec(lines[0].trim());
  if (!match) { add(`has no version line; ${INSTALL}`); return findings; }
  const version = match[1];
  const body = lines.slice(lines[1]?.trim() === KIT_NOTE ? 2 : 1).join('\n').replace(/^\n+/, '');
  if (version !== revision) add(`has old kit revision ${version || '(none)'}; ${INSTALL}`);
  if (blockHash(body) !== version) add(`was edited by hand; ${INSTALL}`);
  return findings;
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

// Text outside the stub that sends pushes, product decisions, or human decisions to the Boss or the Owner.
const SENDS_DECISION = /\bpush(?:es|ing)?\b|\bproduct decisions?\b|\bhuman decisions?\b/i;
const BOSS_OR_OWNER = /\b(?:Boss|Owner)\b/;
const ESCALATE = /\b(?:ask|approv\w*|escalat\w*|send|go(?:es)? to|consult|confirm|permission|sign-?off|wait for)\b/i;
const OWN_DECISION = /\byourself\b|\bnobody\b|\b(?:do not|don't|never) ask\b/i;
// The verb is an instruction: at most three words before it, so "The Boss decides when to tell other projects" is not drift.
const NOTIFY_PROJECT = /^\s*(?:[-*]\s+|\d+\.\s+)?(?:[\w,]+\s+){0,3}?(?:notify|tell|message|inform|prompt)\b.*\b(?:other|another)\s+projects?\b/i;
// An old full kit block between the markers: the kit heading or more lines than a stub has.
function fullBlock(lines) {
  return lines.some((line) => /^#+\s*Herdr Boss orchestration\b/.test(line)) || lines.filter((line) => line.trim()).length > 12;
}

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
  if (!begins.length && !ends.length) add('error', 1, `no Herdr Boss stub; ${INSTALL}`);
  else if (!begins.length) add('error', 1, `no begin marker; ${INSTALL}`);
  else if (!ends.length) add('error', begins[0] + 1, `no end marker; ${INSTALL}`);
  if (begins.length > 1 || ends.length > 1) add('error', (begins[1] ?? ends[1]) + 1, 'more than one block; keep one Herdr Boss stub');
  else if (begins.length === 1 && ends.length === 1) {
    if (ends[0] < begins[0]) add('error', ends[0] + 1, 'end marker before begin marker');
    else block = { begin: begins[0], end: ends[0] };
  }
  if (block) {
    const version = BEGIN.exec(lines[block.begin])[1] || '';
    const inner = lines.slice(block.begin + 1, block.end);
    const own = blockHash(inner.join('\n'));
    if (version === hash && own === version) { /* current stub */ }
    else if (fullBlock(inner)) add('error', block.begin + 1, `old full kit block in AGENTS.md; ${INSTALL}`);
    else {
      if (version !== hash) add('error', block.begin + 1, `old kit stub; ${INSTALL}`);
      if (own !== version) add('error', block.begin + 1, `stub edited by hand; ${INSTALL}`);
    }
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
    if (SENDS_DECISION.test(line) && BOSS_OR_OWNER.test(line) && ESCALATE.test(line) && !OWN_DECISION.test(line)) {
      add('warn', number, 'text sends pushes or product decisions to the Boss or the Owner; the kit makes the orchestrator decide them');
    }
    if (NOTIFY_PROJECT.test(line) && !PROHIBITION.test(line)) add('warn', number, 'text tells the orchestrator to notify another project; the Boss relays messages between projects');
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

// Reads an AGENTS.md file and the kit file next to it, and checks both. relative is the file name to report.
// The kit file is docs/orchestration/herdr-boss.md in the directory of the AGENTS.md file.
export function checkAgentsFile(file, { rulesFile, relative = file } = {}) {
  const kitPath = path.join(path.dirname(file), KIT_FILE);
  const kitText = fs.existsSync(kitPath) ? fs.readFileSync(kitPath, 'utf8') : null;
  const findings = [
    ...checkKitText(kitText, projectKit().revision),
    ...checkAgentsText(fs.readFileSync(file, 'utf8'), { hash: agentsBlock().hash, models: mergedModelIds(rulesFile) }),
  ];
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

// AGENTS.md with the current stub. It replaces the text between the markers, or puts the stub after the first heading.
export function agentsWithStub(text) {
  const { block } = agentsBlock();
  const stub = block.trimEnd().split('\n');
  if (text == null) return `# Agent instructions\n\n${block}`;
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const begins = lines.flatMap((line, index) => (BEGIN.test(line) ? [index] : []));
  const ends = lines.flatMap((line, index) => (END.test(line) ? [index] : []));
  if (begins.length > 1 || ends.length > 1) throw new Error('AGENTS.md has more than one Herdr Boss block. Keep one block, then run herdr-boss kit install again.');
  if (begins.length !== ends.length || (begins.length && ends[0] < begins[0])) {
    throw new Error('AGENTS.md has an incomplete Herdr Boss block. Fix the begin and end markers, then run herdr-boss kit install again.');
  }
  if (begins.length) lines.splice(begins[0], ends[0] - begins[0] + 1, ...stub);
  else {
    const heading = lines.findIndex((line) => /^#{1,6}\s/.test(line));
    const at = heading + 1;
    lines.splice(at, 0, ...(heading < 0 ? [] : ['']), ...stub, ...(lines[at]?.trim() ? [''] : []));
  }
  return lines.join('\n');
}

// Claude settings with the SessionStart hook. An older Herdr Boss hook is replaced; other keys and hooks stay.
export function settingsWithHook(text) {
  let settings = {};
  if (text != null) {
    try { settings = JSON.parse(text); } catch (error) { throw new Error(`.claude/settings.json is not valid JSON: ${error.message}`); }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('.claude/settings.json must contain a JSON object.');
  }
  const ours = (hook) => typeof hook?.command === 'string' && hook.command.includes('cat docs/orchestration/herdr-boss.md');
  settings.hooks ??= {};
  if (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) throw new Error('.claude/settings.json hooks must be an object.');
  const entries = Array.isArray(settings.hooks.SessionStart) ? settings.hooks.SessionStart : [];
  if (entries.some((entry) => (entry?.hooks || []).some((hook) => hook?.command === HOOK_COMMAND))) return text;
  const kept = entries.map((entry) => (Array.isArray(entry?.hooks) ? { ...entry, hooks: entry.hooks.filter((hook) => !ours(hook)) } : entry))
    .filter((entry) => !Array.isArray(entry?.hooks) || entry.hooks.length);
  settings.hooks.SessionStart = [...kept, { hooks: [{ type: 'command', command: HOOK_COMMAND }] }];
  return `${JSON.stringify(settings, null, 2)}\n`;
}

// Writes the kit file, the AGENTS.md stub, and (unless hook is false) the Claude SessionStart hook in the repository root.
// It computes every file first, so an error writes nothing. It returns the relative paths it wrote and left unchanged.
export function installKit(root, { hook = true } = {}) {
  const read = (relative) => { const file = path.join(root, relative); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null; };
  const plan = [
    [KIT_FILE, read(KIT_FILE), projectKit().text],
    ['AGENTS.md', read('AGENTS.md'), agentsWithStub(read('AGENTS.md'))],
  ];
  if (hook) {
    const current = read('.claude/settings.json');
    plan.push(['.claude/settings.json', current, settingsWithHook(current)]);
  }
  const written = [];
  const unchanged = [];
  for (const [relative, before, after] of plan) {
    if (before === after) { unchanged.push(relative); continue; }
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, after);
    fs.renameSync(`${file}.tmp`, file);
    written.push(relative);
  }
  return { root, written, unchanged, revision: projectKit().revision, hash: agentsBlock().hash };
}
