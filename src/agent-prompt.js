import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const DEFAULT_PROMPT_TIMEOUT_SECONDS = 25;
// These keys are best-known harness defaults. Read-back decides whether they worked.
const CLEAR_KEYS = Object.freeze({ claude: ['esc', 'esc'], codex: ['ctrl+u'] });

export function agentPromptTimeoutMs({ dir = DATA_DIR, policy } = {}) {
  if (!policy) {
    try { policy = JSON.parse(fs.readFileSync(path.join(dir, 'policy.json'), 'utf8')); } catch {}
  }
  const seconds = policy?.agentMessages?.promptTimeoutSeconds;
  return (Number.isInteger(seconds) && seconds >= 1 && seconds <= 120 ? seconds : DEFAULT_PROMPT_TIMEOUT_SECONDS) * 1000;
}

// Keep prompt errors independent of the message text and raw pane contents.
function promptFailureCode(error) {
  let code = error?.code;
  for (const output of [error?.stderr, error?.stdout]) {
    try { code = JSON.parse(String(output)).error?.code || code; } catch {}
  }
  return /(?:busy|stalled|timeout|ETIMEDOUT)/i.test(String(code)) ? 75 : 1;
}

function checked(response) {
  if (response?.error || response?.ok === false) {
    const error = new Error('Herdr refused the prompt.');
    error.code = response.error?.code;
    throw error;
  }
  return response;
}

function uncertainInputStyle(raw) {
  // A dim suggestion is not typed input. Unknown SGR forms cannot prove ownership.
  for (const [, source] of raw.matchAll(/\x1b\[([0-9;:]*)m/g)) {
    if (source.includes(':')) return true;
    const codes = source.split(';').map(Number);
    for (let i = 0; i < codes.length; i += 1) {
      if (codes[i] === 2) return true;
      if ([38, 48, 58].includes(codes[i])) {
        const length = codes[i + 1] === 2 ? 4 : codes[i + 1] === 5 ? 2 : null;
        if (length === null || i + length >= codes.length) return true;
        i += length;
      }
    }
  }
  return false;
}

// Read only a complete input block. A history match, cropped block or unknown layout is not proof.
function paneInputText(raw) {
  const rawLines = String(raw ?? '').split(/\r?\n/);
  // eslint-disable-next-line no-control-regex
  const lines = String(raw ?? '').replace(/\x1b(?:\[[0-9;:?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g, '').split(/\r?\n/);
  let footer = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/(?:\? for shortcuts|auto mode)/i.test(lines[i])) { footer = i; break; }
  }
  if (footer < 0 || lines.slice(footer + 1).some((line) => line.trim())) return null;
  let end = footer;
  while (end > 0 && !lines[end - 1].trim()) end -= 1;
  if (/^[─━]{3,}\s*$/.test(lines[end - 1] ?? '')) end -= 1;
  let start = -1;
  // A continuation line can contain a prompt marker. It is part of the draft.
  for (let i = 0; i < end; i += 1) if (/^[❯›](?: |$)/.test(lines[i])) start = i;
  if (start < 0) return null;
  const marker = /^([❯›] ?)(.*)$/.exec(lines[start]);
  const markerAt = rawLines[start].indexOf(marker[1][0]);
  if (uncertainInputStyle([rawLines[start].slice(markerAt + 1), ...rawLines.slice(start + 1, end)].join('\n'))) return null;
  const input = [marker[2].trimEnd()];
  const indent = ' '.repeat(marker[1].length);
  for (let i = start + 1; i < end; i += 1) {
    const line = lines[i].trimEnd();
    if (!line.trim()) { input.push(''); continue; }
    if (!line.startsWith(indent)) return null;
    input.push(line.slice(indent.length));
  }
  return input.join('\n').replace(/\n+$/, '');
}

export function deliverAgentPrompt(pane, text, { herdr, kind, timeoutMs = agentPromptTimeoutMs() }) {
  const options = { timeout: Math.min(timeoutMs, 2500), killSignal: 'SIGKILL' };
  const read = () => {
    try {
      const result = herdr(['pane', 'read', pane, '--source', 'visible', '--lines', '2000', '--format', 'ansi'], options);
      return paneInputText(result?.text ?? result);
    } catch { return null; }
  };
  const keys = (...names) => checked(herdr(['agent', 'send-keys', pane, ...names], options));
  try {
    checked(herdr(['agent', 'prompt', pane, text], { timeout: timeoutMs, killSignal: 'SIGKILL' }));
    return { exitCode: 0 };
  } catch (error) {
    if (promptFailureCode(error) !== 75) return { exitCode: 1, reason: 'Herdr could not deliver the prompt.' };
  }
  if (read() !== text) return { exitCode: 75, reason: 'The pane could not take the prompt. Other or unreadable input was left unchanged.' };
  // Retry submission once, only for the complete text of this send.
  try { keys('enter'); } catch {}
  let remaining = read();
  if (remaining === '') {
    try {
      const response = checked(herdr(['agent', 'get', pane], options));
      if (['working', 'blocked'].includes((response?.agent ?? response)?.agent_status)) return { exitCode: 0 };
    } catch {}
  }
  const failed = { exitCode: 76, reason: 'The prompt was typed but not submitted. Remaining input was left alone.' };
  if (remaining !== text || !CLEAR_KEYS[kind]) return failed;
  // A second read guards against an input change after the submit retry.
  if (read() !== text) return failed;
  try {
    const sequence = kind === 'codex' ? Array(text.split('\n').length).fill('ctrl+u') : CLEAR_KEYS[kind];
    keys(...sequence);
    remaining = read();
    // Do not send the fallback into a different draft or an unknown input block.
    if (kind === 'codex' && remaining && (remaining === text || text.startsWith(`${remaining}\n`))) {
      keys('ctrl+c');
      remaining = read();
    }
  } catch { return failed; }
  return remaining === '' ? { exitCode: 76, reason: 'The prompt was typed but not submitted. Its input text was cleared.' } : failed;
}
