// The folder trust dialogs that the flow of `herdr-boss project new` detects in the pane of the orchestrator that it started.
// Each matcher takes the pane text and the folder that the flow created. It returns { match: true } only when the
// whole dialog is on screen and every part is the known text: the folder line is one whole line that equals the folder (after realpath, exact
// string), the sentence is the known sentence, the accept option is the selected one, and nothing else follows.
// A dialog with any other text, path, or option does not match. Callers decide what to do with a match.
//
// Known prompts, with the tool version where the text was found:
// - claude: Claude Code 2.1.285. Dialog "Accessing workspace:", the folder, "Quick safety check: Is this a project you
//   created or one you trust? ...", the options "1. Yes, I trust this folder" and "2. No, exit". The variant with the
//   option "No, continue without these permissions" (the folder has project settings) has other text and does not match.
// - codex: Codex 0.159.2. Dialog "Trust this folder? Codex can read, edit, and run files here, ..." with the options
//   "Trust and continue" and "Open restricted". The binary holds the sentences and the option labels, not the layout, so
//   the matcher requires the sentences, the folder line, and the options in any layout that has no other text.
//   The variant "Trusting will apply to the repository root" (the folder is inside a Git project) does not match.
// - pi (0.87.1) and opencode (1.18.30): no folder trust prompt found. No automation.
import fs from 'node:fs';

export const TRUST_HARNESSES = Object.freeze(['claude', 'codex']);

const CLAUDE_SENTENCE = 'Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what\'s in this folder first.';
const CODEX_SENTENCES = [
  'Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.',
  'Folder settings can run code automatically, even without a model request.',
  'Continue only if you trust these files.',
  'Your trust decision will be saved.',
];
const CUE = /Quick safety check: [Ii]s this a project you created|Trust this folder\?|Do you trust the contents of this directory/;
const MATCH = { match: true };
const CLAUDE_EXTRA = [/^Claude Code.ll be able to read, edit, and execute files here\.$/, /^Security guide$/];
const NO = { match: false };

// Strip ANSI escapes and box borders. Return the non-empty lines, trimmed.
function screenLines(text) {
  return String(text ?? '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-Z\\-_]/g, '')
    .split(/\r?\n|\r/)
    .map((line) => line.replace(/^[\s│┃]+|[\s│┃]+$/g, ''))
    .filter((line) => line && !/^[─━╭╮╰╯┌┐└┘\s]+$/.test(line));
}

const collapse = (text) => text.replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();

function realFolder(folder) {
  try { return fs.realpathSync(folder); } catch { return String(folder); }
}

export function hasTrustCue(text) {
  return CUE.test(screenLines(text).join(' '));
}

// Claude: heading, one folder line, the sentence, the known extra lines, the two option lines, the footer, in this order.
function claudeTrust(lines, folder) {
  let head = -1;
  lines.forEach((line, index) => { if (line === 'Accessing workspace:') head = index; });
  if (head < 0 || lines[head + 1] !== folder) return NO;
  const quick = head + 2;
  if (!(lines[quick] ?? '').startsWith('Quick safety check:')) return NO;
  let end = quick;
  while (end < lines.length && !collapse(lines.slice(quick, end + 1).join(' ')).endsWith('in this folder first.')) end += 1;
  if (end >= lines.length || collapse(lines.slice(quick, end + 1).join(' ')) !== CLAUDE_SENTENCE) return NO;
  const yes = lines.findIndex((line, index) => index > end && /^[❯>]\s*1\.\s*Yes, I trust this folder$/.test(line));
  if (yes < 0 || !/^2\.\s*No, exit$/.test(lines[yes + 1] ?? '')) return NO;
  if (!lines.slice(end + 1, yes).every((line) => CLAUDE_EXTRA.some((known) => known.test(line)))) return NO;
  return lines.slice(yes + 2).every((line) => /^(?:Enter to confirm(?: · Esc to (?:cancel|exit))?|Esc to (?:cancel|exit))$/.test(line)) ? MATCH : NO;
}

// Codex: the known sentences, exactly one folder line, the selected accept option, the other option, the footer. Nothing else.
function codexTrust(lines, folder) {
  const head = lines.findIndex((line) => line.startsWith('Trust this folder?'));
  if (head < 0) return NO;
  const yes = lines.findIndex((line, index) => index > head && /^[›>❯]\s*(?:1\.\s*)?Trust and continue$/.test(line));
  if (yes < 0) return NO;
  let folderLines = 0;
  const prose = [];
  for (const line of lines.slice(head, yes)) {
    if (line === folder) folderLines += 1;
    else prose.push(line);
  }
  let body = ` ${collapse(prose.join(' '))} `;
  if (folderLines !== 1 || !body.includes(CODEX_SENTENCES[0])) return NO;
  for (const sentence of CODEX_SENTENCES) body = body.replace(sentence, ' ');
  if (body.trim()) return NO;
  if (!/^(?:2\.\s*)?Open restricted$/.test(lines[yes + 1] ?? '')) return NO;
  return lines.slice(yes + 2).every((line) => /^Press enter to continue$|^Esc to (?:cancel|go back|exit)$/.test(line)) ? MATCH : NO;
}

const MATCHERS = { claude: claudeTrust, codex: codexTrust };

// { match: true } when the pane text shows the known trust dialog of the harness for exactly this folder.
export function matchTrustPrompt(harness, text, folder) {
  const matcher = MATCHERS[harness];
  if (!matcher || !folder) return NO;
  return matcher(screenLines(text), realFolder(folder));
}

// Watch one pane for a strict folder dialog. Call onMatch at most once. Detection-only callers supply no input action.
// Count waited time as well as wall time so the deadline also holds when a test clock does not advance.
export function watchTrustPrompt({ kind, folder, read, isReady, working = () => false, onMatch = () => {}, onMismatch = () => {},
  detected = false, now = Date.now, since = now(), wait, timeoutMs = 180_000, pollMs = 2000 }) {
  let waited = 0;
  for (;;) {
    const elapsed = Math.max(now() - since, waited);
    if (elapsed >= timeoutMs) return { ready: false, detected, timedOut: true };
    const text = read();
    if (Math.max(now() - since, waited) >= timeoutMs) return { ready: false, detected, timedOut: true };
    if (!hasTrustCue(text)) {
      if (isReady(text) || working()) return { ready: true, detected, timedOut: false };
    } else if (!matchTrustPrompt(kind, text, folder).match) {
      onMismatch();
    } else if (!detected) {
      detected = true;
      onMatch();
    }
    const delay = Math.max(1, Math.min(pollMs, timeoutMs - Math.max(now() - since, waited)));
    wait(delay);
    waited += delay;
  }
}
