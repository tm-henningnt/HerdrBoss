// The OpenCode TUI and its command line. OpenCode v2 keeps --model and --agent in the `run`
// subcommand only. The bare TUI rejects them. Older releases accept them. Detect the ability once
// for the process, then choose the launch path.
import { execFileSync } from 'node:child_process';

const HELP_TIMEOUT_MS = 15_000;
const OPEN_CODE_CONFIG_FILE = 'opencode.json';
const UNSUPPORTED_FLAG = /unrecognized flag:\s*(\S+)\s+in command opencode/i;

// Cache the TUI answer for the process. A second worker start reuses the first answer.
let cachedTuiModelFlags = null;

// Find a whole flag in the top-level help text, for example `--model` or `--agent`.
function namesTopLevelFlag(help, flag) {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${escaped}(?=[,\\s]|$)`, 'm').test(help);
}

// True when the bare TUI accepts --model and --agent. An unreadable help falls back to the old flag
// path, so a detection problem never changes the launch on its own.
export function opencodeTuiAcceptsModelFlags({ run = execFileSync, env = process.env, refresh = false, timeoutMs = HELP_TIMEOUT_MS } = {}) {
  if (!refresh && cachedTuiModelFlags !== null) return cachedTuiModelFlags;
  let help = '';
  try {
    help = String(run('opencode', ['--help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, env }) ?? '');
    cachedTuiModelFlags = namesTopLevelFlag(help, '--model') && namesTopLevelFlag(help, '--agent');
  } catch {
    cachedTuiModelFlags = true;
  }
  return cachedTuiModelFlags;
}

// Drop the cached answer. Tests use this after they change the fake CLI.
export function resetOpenCodeTuiFlagsCache() {
  cachedTuiModelFlags = null;
}

// The flag that the OpenCode CLI refused, or null. A v2 TUI prints `Unrecognized flag: -m in command opencode`.
export function unsupportedOpenCodeFlag(text) {
  const match = UNSUPPORTED_FLAG.exec(String(text ?? ''));
  return match ? match[1] : null;
}

// The project config that selects the model and the worker agent for a v2 TUI. It holds no secret.
export function openCodeConfigText(model) {
  return `${JSON.stringify({ $schema: 'https://opencode.ai/config.json', model, default_agent: 'worker' }, null, 2)}\n`;
}

// The config file name that the v2 TUI reads from its working folder.
export const OPEN_CODE_CONFIG_NAME = OPEN_CODE_CONFIG_FILE;
