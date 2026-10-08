// The Herdr Boss kit file and the stub in a project AGENTS.md, and the drift check for both files and the other orchestration files.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { checkAgentsExclude, globMatches, KIT_ROOT, loadModels } from './config.js';
import { mergeModels } from '../control.js';

export const STUB_TEMPLATE = path.join(KIT_ROOT, 'kit', 'templates', 'agents-stub.md');
export const KIT_TEMPLATE = path.join(KIT_ROOT, 'kit', 'templates', 'project-kit.md');
// The kit file path in a project repository, relative to its Git top level.
export const KIT_FILE = 'docs/orchestration/herdr-boss.md';
const KIT_NOTE = 'Herdr Boss writes this file. Do not edit it. Run herdr-boss kit install to update it.';
const KIT_VERSION = /^<!--\s*herdr-boss kit v=(\S*)\s*-->$/;
// The Claude SessionStart hook prints the kit file and the project memory. A missing file does not fail the hook.
// It first runs herdr-boss kit update --quiet, so the printed kit file is current. A failed or missing update does not fail the hook.
export const HOOK_COMMAND = 'cd "${CLAUDE_PROJECT_DIR:-.}" && { herdr-boss kit update --quiet 2>/dev/null; cat docs/orchestration/herdr-boss.md docs/orchestration/memory.md 2>/dev/null; }; exit 0';
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
  const revision = kitRevision();
  return { revision, body, text: `<!-- herdr-boss kit v=${revision} -->\n${KIT_NOTE}\n\n${body}\n` };
}

function kitFiles(root, directory) {
  const absolute = path.join(root, directory);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(directory, entry.name);
    return entry.isDirectory() ? kitFiles(root, relative) : entry.isFile() ? [relative] : [];
  });
}

// Hash shared guidance and installed assets so either kind of change requires a kit update. The
// project-kit template body is canonical; its generated revision line and note are not part of input.
export function kitRevision(root = KIT_ROOT) {
  try {
    const template = path.join(root, 'kit/templates/project-kit.md');
    const files = [
      ...kitFiles(root, 'kit/templates'),
      'kit/skills/herdr-orchestrator/SKILL.md',
      ...kitFiles(root, 'kit/skills/herdr-orchestrator/reference'),
      // Older kit roots can lack model guidance. Keep their revision valid, but hash it when present.
      ...(fs.existsSync(path.join(root, 'kit/models.md')) ? ['kit/models.md'] : []),
      'kit/models.json',
      ...kitFiles(root, 'kit/watch'),
    ].sort();
    const hash = createHash('sha256');
    for (const file of files) {
      hash.update(file).update('\0');
      hash.update(file === 'kit/templates/project-kit.md'
        ? normalize(fs.readFileSync(template, 'utf8'))
        : fs.readFileSync(path.join(root, file)));
      hash.update('\0');
    }
    return hash.digest('hex').slice(0, 12);
  } catch { return null; }
}

// The kit change log. It is the fallback record for changes without a Kit-Impact: trailer.
// It is not part of the kit revision inputs.
export const CHANGES_FILE = path.join(KIT_ROOT, 'kit', 'CHANGES.md');

// A Git trailer line: Key: value where Key starts with a letter and contains only letters, digits, and hyphens.
const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9-]*: .+$/;

// Parse a Kit-Impact: trailer from commit message text.
// The trailer must appear in the final trailer block — the last consecutive run of
// trailer lines at the end of the message. Multiple ordinary trailers are allowed
// in that block. A body line followed by more body text is not a trailer.
// The value must be exactly required, useful, or none (case-insensitive).
// The trailer key is case-sensitive. Returns null when the trailer is absent, ambiguous, or has an invalid value.
export function parseKitImpact(message) {
  const lines = String(message || '').replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && lines.at(-1).trim() === '') lines.pop();
  if (!lines.length) return null;
  // Find the start of the final trailer block: walk backwards from the end while lines are trailers.
  let trailerStart = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (TRAILER_LINE.test(lines[i])) {
      trailerStart = i;
    } else {
      break;
    }
  }
  if (trailerStart >= lines.length) return null;
  if (trailerStart > 0 && lines[trailerStart - 1].trim() !== '') return null;
  // Count malformed Kit-Impact lines too. An invalid or duplicate trailer must not
  // let another value in the same block silently lower the change impact.
  const impacts = lines.slice(trailerStart).filter((line) => /^Kit-Impact(?:\s|:)/.test(line));
  if (impacts.length !== 1) return null;
  const match = /^Kit-Impact: ([A-Za-z]+)$/.exec(impacts[0]);
  if (!match) return null;
  const value = match[1].toLowerCase();
  return ['required', 'useful', 'none'].includes(value) ? value : null;
}

const CHANGE_HEAD = /^## ([0-9a-f]{12})$/;
const CHANGE_IMPACT = /^Impact: (required|useful|none)$/;
const CHANGE_SUMMARY = /^Summary: (.+)$/;

// Read a kit change log and return parsed entries in chronological order.
// Each entry: { revision, impact, summary }.
// A missing or unreadable file returns an empty list.
// An entry with a missing or invalid Impact line defaults to required (conservative).
export function readKitChanges(file = CHANGES_FILE) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const entries = [];
  let current = null;
  const finish = () => {
    if (!current) return;
    const impact = current.impacts.length === 1 ? CHANGE_IMPACT.exec(current.impacts[0]) : null;
    entries.push({
      revision: current.revision,
      impact: impact?.[1] ?? 'required',
      summary: current.summary,
    });
    current = null;
  };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = line.trim();
    const head = CHANGE_HEAD.exec(trimmed);
    if (head) {
      finish();
      current = { revision: head[1], impacts: [], summary: null };
      continue;
    }
    if (!current) continue;
    if (/^Impact(?:\s|:)/.test(trimmed)) { current.impacts.push(trimmed); continue; }
    const summary = CHANGE_SUMMARY.exec(trimmed);
    if (summary) { current.summary = summary[1].trim(); }
  }
  finish();
  return entries;
}

// Return kit changes after a given revision through the current revision.
// If the revision is unknown, return all entries in order.
export function kitChangesSince(revision, file = CHANGES_FILE) {
  const entries = readKitChanges(file);
  if (!revision) return entries;
  const index = entries.findIndex((entry) => entry.revision === revision);
  if (index < 0) return entries;
  return entries.slice(index + 1);
}

// The kit revision that a project has installed, read from its own kit file. Returns null when the
// file is missing, unreadable, or has no version line.
export function installedKitRevision(root) {
  try {
    const [line] = fs.readFileSync(path.join(root, KIT_FILE), 'utf8').split('\n');
    return KIT_VERSION.exec(String(line ?? '').trim())?.[1] || null;
  } catch { return null; }
}

// One line that says the project kit is behind for a required or useful change, or null. A project
// with no installed kit, a current kit, or only changes with impact none gives null. A required change
// gives the direct line. A useful-only change gives an optional line that waits for a task boundary.
export function kitBehindLine(root, { changesFile = CHANGES_FILE, current = kitRevision() } = {}) {
  const installed = installedKitRevision(root);
  if (!installed || installed === current) return null;
  const changes = kitChangesSince(installed, changesFile);
  const required = changes.filter((change) => change.impact === 'required').length;
  const useful = changes.filter((change) => change.impact === 'useful').length;
  if (!required && !useful) return null;
  const parts = [required && `${required} required`, useful && `${useful} useful`].filter(Boolean).join(' and ');
  const lead = `Kit update: this project kit is behind by ${parts} change(s).`;
  // A required change needs action. A useful-only change is optional and waits for a task boundary.
  if (required) return `${lead} Run herdr-boss kit update.`;
  return `${lead} The update is optional to act on now. Run herdr-boss kit update at the next task boundary.`;
}

// The number of required changes after a kit revision, up to the current revision. The result is
// null when the revision is missing or the change log does not know it.
export function kitRequiredBehind(revision, current = kitRevision(), entries = readKitChanges()) {
  if (!revision) return null;
  if (revision === current) return 0;
  const index = entries.findIndex((entry) => entry.revision === revision);
  if (index < 0) return null;
  return entries.slice(index + 1).filter((entry) => entry.impact === 'required').length;
}

// installKit records the hash of the kit file text that it wrote. The record is a file in the Git
// directory of the project, so it is never committed. A refresh compares the kit file with it, so
// an earlier install that nobody committed is not a hand edit.
const KIT_RECORD = 'herdr-boss-kit.json';
const sha = (text) => createHash('sha256').update(text).digest('hex');

function kitRecordFile(root) {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-path', KIT_RECORD], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out ? path.resolve(root, out) : null;
  } catch { return null; }
}

function readKitRecord(root) {
  try { return JSON.parse(fs.readFileSync(kitRecordFile(root), 'utf8'))?.kitFileHash ?? null; } catch { return null; }
}

function writeKitRecord(root, text) {
  try {
    const file = kitRecordFile(root);
    if (file) fs.writeFileSync(file, `${JSON.stringify({ kitFileHash: sha(text) })}\n`);
  } catch { /* the record is an aid; a failed write leaves the git comparison in use */ }
}

// The kit files that a refresh writes and that a person may have edited. The kit file has hand
// edits when its note line is missing or when its text differs from the text that the last install
// wrote. A project with no install record falls back to the committed copy. The stub has hand edits
// when its text does not match its own hash. A refresh does not overwrite such a file.
function handEditedKitFiles(root) {
  const edited = [];
  let kitText = null;
  try { kitText = fs.readFileSync(path.join(root, KIT_FILE), 'utf8'); } catch {}
  if (kitText != null) {
    const lines = kitText.split('\n');
    let changed = lines[1]?.trim() !== KIT_NOTE;
    const recorded = changed ? null : readKitRecord(root);
    if (!changed && recorded) changed = recorded !== sha(kitText);
    else if (!changed) {
      try {
        execFileSync('git', ['ls-files', '--error-unmatch', '--', KIT_FILE], { cwd: root, stdio: 'ignore' });
        const diff = execFileSync('git', ['diff', '--name-only', 'HEAD', '--', KIT_FILE], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        changed = diff.trim() !== '';
      } catch { /* an untracked file or a missing repository has no committed copy to compare */ }
    }
    if (changed) edited.push(KIT_FILE);
  }
  try {
    const lines = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8').replace(/\r\n?/g, '\n').split('\n');
    const begins = lines.flatMap((line, index) => (BEGIN.test(line) ? [index] : []));
    const ends = lines.flatMap((line, index) => (END.test(line) ? [index] : []));
    if (begins.length === 1 && ends.length === 1 && ends[0] > begins[0]) {
      const version = BEGIN.exec(lines[begins[0]])[1] || '';
      if (blockHash(lines.slice(begins[0] + 1, ends[0]).join('\n')) !== version) edited.push('AGENTS.md');
    }
  } catch { /* a missing AGENTS.md gets a new stub */ }
  return edited;
}

// Bring the kit files of a project to the current kit when the disk copy is behind on a required
// change. It writes the same files as herdr-boss kit install and commits nothing. It skips a file
// set that has hand edits. It returns { status, written, line }: status is current, refreshed, or
// skipped, and line is one line for the caller to print, or null.
export function refreshKitIfRequired(root, { changesFile = CHANGES_FILE, current = kitRevision() } = {}) {
  const installed = installedKitRevision(root);
  if (!installed || kitRevisionState(installed, current, readKitChanges(changesFile)) !== KIT_STATES.required) {
    return { status: 'current', written: [], line: null };
  }
  const skip = (reason) => ({ status: 'skipped', written: [], line: `Warning: kit files not refreshed: ${reason}. Run herdr-boss kit update.` });
  const edited = handEditedKitFiles(root);
  if (edited.length) return skip(`${edited.join(' and ')} ${edited.length === 1 ? 'has' : 'have'} hand edits`);
  try {
    const result = installKit(root);
    return { status: 'refreshed', written: result.written, line: `Kit refreshed: wrote ${result.written.join(', ')} (kit revision ${installed} to ${result.revision}). Commit the files with your next commit.` };
  } catch (error) { return skip(String(error?.message || error).split('\n')[0]); }
}

// refreshKitIfRequired that never throws. An error becomes a skipped result with a warning line, so
// publish and worker start go on. refresh is a test seam.
export function safeRefreshKit(root, { refresh = refreshKitIfRequired, ...options } = {}) {
  try { return refresh(root, options); } catch (error) {
    return { status: 'skipped', written: [], line: `Warning: kit files not refreshed: ${String(error?.message || error).split('\n')[0]}. Run herdr-boss kit update.` };
  }
}

// The state of a project kit revision against the current kit revision. A revision that the change
// log does not know, or a current revision that the change log does not end with, leaves the
// project behind on a required change, because the impact of an unrecorded change is unknown.
export const KIT_STATES = Object.freeze({
  current: 'current',
  useful: 'behind (useful only)',
  required: 'behind (required)',
  unpublished: 'not published',
});

export function kitRevisionState(loaded, current = kitRevision(), entries = readKitChanges()) {
  if (!loaded) return KIT_STATES.unpublished;
  if (loaded === current) return KIT_STATES.current;
  const index = entries.findIndex((entry) => entry.revision === loaded);
  if (index < 0 || entries.at(-1)?.revision !== current) return KIT_STATES.required;
  return entries.slice(index + 1).some((entry) => entry.impact === 'required') ? KIT_STATES.required : KIT_STATES.useful;
}

// The current kit revision and the impact of each recorded change, for the dashboard.
export function kitSnapshot(entries = readKitChanges(), current = kitRevision()) {
  return { current, changes: entries.map((entry) => ({ revision: entry.revision, impact: entry.impact })) };
}

// The rules that the kit file of a project must carry. Each entry names the rule, a pattern that matches the rule
// line in the kit template, and the message that names the rule for a project that lacks it.
export const KIT_RULES = Object.freeze([
  { id: 'license-never-inline', pattern: /^-\s*A license is never inline\./m, message: 'has no rule that a license is never inline; run herdr-boss kit install' },
]);

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
  for (const rule of KIT_RULES) if (!rule.pattern.test(body)) add(rule.message);
  if (version !== revision) add(`has old kit revision ${version || '(none)'}; ${INSTALL}`);
  else if (normalize(body) !== normalize(fs.readFileSync(KIT_TEMPLATE, 'utf8'))) add(`was edited by hand; ${INSTALL}`);
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
// A month is a whole word, so the list item "1. Decide" is not a date.
const DATE = /\b20\d\d-\d\d-\d\d\b|\b\d{1,2}\.?\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b/;
// A token that looks like a model ID. gpt-, claude-, deepseek, and muse-spark need a digit, so claude-code is not a model.
const MODEL_TOKEN = /(?<![\w/.-])(?:opencode(?:-go)?\/[\w.-]+|(?:gpt-|claude-|deepseek|muse-spark)[\w.-]*\d[\w.-]*)/g;

// Text outside the stub that routes a decision, a push, a release, or a product question to the Boss, the Owner, a human,
// or the user. The line needs an ask or escalate verb, a target, and a subject, so "1. Decide the order" is not routing.
const ROUTE_SUBJECT = /\b(?:decisions?|push(?:es)?|releases?|product questions?)\b/i;
const ROUTE_ALLOWED_SUBJECT = /\b(?:credentials?|secrets?|tenant\s+access|access|(?:spending money|billing|cost)(?:\s*\([^)]*\))?|(?:destructive|irreversible)(?: actions?)? outside (?:the )?project|(?:real\s+)?conflicts? with (?:a )?recorded Owner decision)\b/i;
const ROUTE_VERB = /\b(?:ask|escalat\w*|send|report|route|get approval|wait for)\b/i;
const ROUTE_TARGET = /\b(?:the Owner|the Boss|a human|the user)\b/i;
// "Pushes need Owner approval" has the verb and the target in one phrase.
const ROUTE_APPROVAL = /\b(?:Owner|Boss)(?:'s)? approval\b/;
const OWN_DECISION = /\byourself\b|\bnobody\b/i;
function routesDecision(line) {
  return line.split(/(?<=[.!?])\s+/).some((sentence) => {
    const instruction = sentence.replace(/^\s*(?:[-*]\s+|\d+\.\s+)?/, '');
    if (/^(?:record|write|log)\b/i.test(instruction) || /^delete\s+the\s+line\b/i.test(instruction)) return false;
    if (PROHIBITION.test(sentence) || OWN_DECISION.test(sentence)) return false;
    const unapprovedTopics = sentence.replace(new RegExp(ROUTE_ALLOWED_SUBJECT.source, 'gi'), ' ');
    if (!ROUTE_SUBJECT.test(unapprovedTopics)) return false;
    return ROUTE_APPROVAL.test(sentence) || (ROUTE_VERB.test(sentence) && ROUTE_TARGET.test(sentence));
  });
}
// The verb is an instruction: at most three words before it, so "The Boss decides when to tell other projects" is not drift.
const NOTIFY_PROJECT = /^\s*(?:[-*]\s+|\d+\.\s+)?(?:[\w,]+\s+){0,3}?(?:notify|tell|message|inform|prompt)\b.*\b(?:other|another)\s+projects?\b/i;
// An old full kit block between the markers: the kit heading or more lines than a stub has.
function fullBlock(lines) {
  return lines.some((line) => /^#+\s*Herdr Boss orchestration\b/.test(line)) || lines.filter((line) => line.trim()).length > 12;
}

// A rule-like line starts with Always, Never, Do not, or Must, after an optional list marker.
const RULE = /^\s*(?:[-*]\s+|\d+\.\s+)?(?:Always|Never|Do not|Must)\b/;

function modelTokens(line) { return [...line.matchAll(MODEL_TOKEN)].map((match) => match[0].replace(/[.-]+$/, '')); }

// Warnings for orchestration text: stale commands, fixed pane IDs, dates, decisions sent to the Boss or the Owner,
// notices to other projects, and model IDs. skip(index) is true for a line that is not checked.
// A handoff note also warns for each rule-like line.
function driftFindings(lines, { models = [], skip = () => false, handoff = false } = {}) {
  const allowed = new Set(models);
  const findings = [];
  const add = (level, line, message) => findings.push({ level, line, message });
  const copied = [];
  lines.forEach((line, index) => {
    const number = index + 1;
    if (skip(index)) return;
    for (const [pattern, message] of STALE) if (pattern.test(line)) add('warn', number, message);
    if (PORT.test(line) && !PROHIBITION.test(line)) add('warn', number, 'port 9222 is the retired legacy browser; use herdr-boss browser request');
    if (PROCESS.test(line) && !PROHIBITION.test(line)) add('warn', number, 'a process command prints command lines; use pgrep -l or ps -o pid,ppid,etime,comm');
    if (PANE_ID.test(line)) add('warn', number, `fixed pane ID ${PANE_ID.exec(line)[0]}; ${MEMORY}`);
    if (DATE.test(line)) add('warn', number, `dated line; ${MEMORY}`);
    if (routesDecision(line)) {
      add('warn', number, 'text sends pushes or product decisions to the Boss or the Owner; the kit makes the orchestrator decide them');
    }
    if (NOTIFY_PROJECT.test(line) && !PROHIBITION.test(line)) add('warn', number, 'text tells the orchestrator to notify another project; the Boss relays messages between projects');
    if (handoff && RULE.test(line)) add('warn', number, 'a handoff note carries no rules; move the rule to AGENTS.md or docs/orchestration/memory.md');
    for (const model of modelTokens(line)) {
      if (!allowed.has(model)) add('warn', number, `${model} is not in the model list; run herdr-boss models`);
      else copied.push({ model, number });
    }
  });
  const distinct = new Set(copied.map((item) => item.model));
  if (distinct.size >= 3) add('warn', copied[0].number, `copied model list (${distinct.size} models); use herdr-boss models and herdr-boss lanes`);
  return findings;
}

// Findings for the text of an AGENTS.md file: [{ level: 'error'|'warn', line, message }].
// hash is the current block hash. models is the merged list of allowed model IDs.
export function checkAgentsText(text, { hash, models = [] } = {}) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
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

  findings.push(...driftFindings(lines, { models, skip: (index) => block && index >= block.begin && index <= block.end }));
  return findings.sort((a, b) => a.line - b.line || (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
}

function plural(count, word) { return `${count} ${word}${count === 1 ? '' : 's'}`; }

// The Markdown files below a folder, as sorted paths relative to root. Symbolic links are not followed.
function markdownFiles(root, folder, { deep = true, match = () => true } = {}) {
  let entries;
  try { entries = fs.readdirSync(path.join(root, folder), { withFileTypes: true }); } catch { return []; }
  return entries.sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const relative = folder ? `${folder}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return deep ? markdownFiles(root, relative, { deep, match }) : [];
    return entry.isFile() && entry.name.endsWith('.md') && match(entry.name) ? [relative] : [];
  });
}

const HANDOFF = /handoff/i;
const ORCHESTRATOR_FILE = /(?:Orchestrator|orchestrator).*\.md$/;

// Other orchestration files that orchestrators read, relative to root: docs/agents/**/*.md, .orchestration/*.md,
// .orchestration/**/*handoff*.md, and a top-level *Orchestrator*.md file. The kit file and memory.md are not in the list.
export function orchestrationFiles(root) {
  const files = new Set([
    ...markdownFiles(root, 'docs/agents'),
    ...markdownFiles(root, '.orchestration', { deep: false }),
    ...markdownFiles(root, '.orchestration', { match: (name) => HANDOFF.test(name) }),
    ...markdownFiles(root, '', { deep: false, match: (name) => ORCHESTRATOR_FILE.test(name) }),
  ]);
  return [...files].sort();
}

// A file whose first line is this marker is data that a script writes. The scan skips it.
const DATA_MARKER = '<!-- herdr-boss: data -->';
const STATE_FOLDER = '.orchestration/state/';

// True when the scan skips an orchestration file: a checkAgents.exclude glob, the state folder, or the data marker.
function skippedFile(relative, text, exclude) {
  if (relative.startsWith(STATE_FOLDER) || exclude.some((pattern) => globMatches(pattern, relative))) return true;
  return String(text).replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] === DATA_MARKER;
}

// Warnings for one orchestration file. Each finding has the file name. A file name with "handoff" is a handoff note.
export function checkOrchestrationText(text, { file, models = [] } = {}) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  return driftFindings(lines, { models, handoff: HANDOFF.test(path.basename(file)) }).map((finding) => ({ ...finding, file }));
}

// Reads an AGENTS.md file and the kit file next to it, and checks both. relative is the file name to report.
// The kit file is docs/orchestration/herdr-boss.md in the directory of the AGENTS.md file.
// The check also scans the orchestration files of that directory. Their findings are warnings with a file name.
// The scan skips the files that skippedFile names, and the summary gives their count, not their names.
export function checkAgentsFile(file, { rulesFile, relative = file } = {}) {
  const root = path.dirname(file);
  const kitPath = path.join(root, KIT_FILE);
  const kitText = fs.existsSync(kitPath) ? fs.readFileSync(kitPath, 'utf8') : null;
  const models = mergedModelIds(rulesFile);
  const findings = [
    ...checkKitText(kitText, projectKit().revision),
    ...checkAgentsText(fs.readFileSync(file, 'utf8'), { hash: agentsBlock().hash, models }),
  ];
  let exclude = [];
  try { exclude = checkAgentsExclude(root); } catch (error) {
    findings.push({ level: 'error', line: 1, file: '.herdr-boss.json', message: `.herdr-boss.json: ${error.message} Fix checkAgents.exclude.` });
  }
  let skipped = 0;
  for (const other of orchestrationFiles(root)) {
    let text;
    try { text = fs.readFileSync(path.join(root, other), 'utf8'); } catch { continue; }
    if (skippedFile(other, text, exclude)) { skipped += 1; continue; }
    findings.push(...checkOrchestrationText(text, { file: other, models }));
  }
  const errors = findings.filter((finding) => finding.level === 'error').length;
  const warnings = findings.length - errors;
  return {
    file: relative,
    findings,
    errors,
    warnings,
    skipped,
    lines: findings.map((finding) => `${finding.level}${finding.file ? ` ${finding.file}` : ''} line ${finding.line}: ${finding.message}`),
    summary: `${relative}: ${plural(errors, 'error')}, ${plural(warnings, 'warning')}${skipped ? `; ${plural(skipped, 'file')} skipped` : ''}`,
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
  settings.permissions ??= {};
  if (typeof settings.permissions !== 'object' || Array.isArray(settings.permissions)) throw new Error('.claude/settings.json permissions must be an object.');
  settings.permissions.deny ??= [];
  if (!Array.isArray(settings.permissions.deny)) throw new Error('.claude/settings.json permissions.deny must be an array.');
  const addedDialogDenial = !settings.permissions.deny.includes('AskUserQuestion');
  if (addedDialogDenial) settings.permissions.deny.push('AskUserQuestion');
  const ours = (hook) => typeof hook?.command === 'string' && hook.command.includes('cat docs/orchestration/herdr-boss.md');
  settings.hooks ??= {};
  if (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) throw new Error('.claude/settings.json hooks must be an object.');
  const entries = Array.isArray(settings.hooks.SessionStart) ? settings.hooks.SessionStart : [];
  if (entries.some((entry) => (entry?.hooks || []).some((hook) => hook?.command === HOOK_COMMAND))) {
    return addedDialogDenial ? `${JSON.stringify(settings, null, 2)}\n` : text;
  }
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
  writeKitRecord(root, plan[0][2]);
  return { root, written, unchanged, revision: projectKit().revision, hash: agentsBlock().hash };
}
