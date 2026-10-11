// OpenCode 1.x starts an interactive TUI. OpenCode 2.x uses `run` with a message.
// Read the installed help before worker start so an unsupported command cannot create a worktree.
import { execFileSync } from 'node:child_process';

const HELP_TIMEOUT_MS = 15_000;
const OPEN_CODE_CONFIG_FILE = 'opencode.json';
const UNSUPPORTED_FLAG = /unrecognized flag:\s*(\S+)\s+in command opencode(?:\s+run)?/i;

let cachedTuiModelFlags = null;
let cachedOpenCodeDetection = null;

function helpListsFlag(help, flag) {
  return String(help ?? '').split(/\r?\n/).some((line) => {
    const columns = line.trim().split(/\s{2,}/, 1)[0] || '';
    return (` ${columns.replace(/,\s*/g, ' ')} `).includes(` ${flag} `);
  });
}

function runOpenCode(run, args, env, timeoutMs) {
  try {
    const text = run('opencode', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, env });
    return { ok: true, text: String(text ?? '') };
  } catch (error) {
    const text = [error?.stdout, error?.stderr].map((part) => Buffer.isBuffer(part) ? part.toString('utf8') : String(part ?? '')).filter(Boolean).join('\n');
    return { ok: false, text };
  }
}

function parseVersion(text) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const value = line.trim();
    if (/^\d+\.\d+\.\d+$/.test(value)) return value;
    if (/^opencode\b/i.test(value)) {
      const match = /(?:^|\s)v?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)(?=$|\s)/i.exec(value);
      if (match) return match[1];
    }
  }
  return null;
}

function unsupportedLaunch(version, rejected) {
  const label = version ? `OpenCode ${version}` : 'The installed OpenCode CLI';
  const flags = [...new Set(rejected)];
  return new Error(`${label} has no accepted worker launch form. Help did not accept: ${flags.join(', ') || 'opencode run'}. Worker start stopped before worktree creation.`);
}

// Return the selected launch form and the version that worker start must record.
function legacyTuiProfile(version = null) {
  return { version, mode: 'tui', modelFlag: '-m', agentFlag: '--agent', config: false };
}

function cacheDetection(profile, error = null) {
  cachedOpenCodeDetection = { profile: profile ? { ...profile } : null, error: error?.message ?? null };
}

export function detectOpenCodeCli({ run = execFileSync, env = process.env, refresh = false, timeoutMs = HELP_TIMEOUT_MS } = {}) {
  if (refresh) cachedOpenCodeDetection = null;
  if (!refresh && cachedOpenCodeDetection) {
    if (cachedOpenCodeDetection.error) throw new Error(cachedOpenCodeDetection.error);
    return { ...cachedOpenCodeDetection.profile };
  }

  const versionResult = runOpenCode(run, ['--version'], env, timeoutMs);
  const topResult = runOpenCode(run, ['--help'], env, timeoutMs);
  const runResult = runOpenCode(run, ['run', '--help'], env, timeoutMs);
  const version = versionResult.ok ? parseVersion(versionResult.text) : null;
  if (!version) {
    const profile = legacyTuiProfile();
    cacheDetection(profile);
    return { ...profile };
  }
  const major = Number(version.split('.')[0]);

  const tuiModelFlag = helpListsFlag(topResult.text, '-m') ? '-m' : null;
  const tuiAgentFlag = helpListsFlag(topResult.text, '--agent') ? '--agent' : null;
  const runExists = runResult.ok;
  const runModelFlag = helpListsFlag(runResult.text, '--model') ? '--model' : null;
  const runAgentFlag = helpListsFlag(runResult.text, '--agent') ? '--agent' : null;

  let profile;
  if (major === 1) {
    if (tuiModelFlag && tuiAgentFlag) {
      profile = { version, mode: 'tui', modelFlag: tuiModelFlag, agentFlag: tuiAgentFlag, config: false };
    } else {
      profile = legacyTuiProfile(version);
    }
  } else if (major >= 2) {
    if (runExists && runModelFlag) {
      profile = { version, mode: 'run', modelFlag: runModelFlag, agentFlag: runAgentFlag, config: !runAgentFlag };
    } else {
      const rejected = [];
      if (!runExists) rejected.push('opencode run');
      if (!runModelFlag) rejected.push('opencode run --model');
      const error = unsupportedLaunch(version, rejected);
      cacheDetection(null, error);
      throw error;
    }
  } else {
    const error = unsupportedLaunch(version, ['opencode -m', 'opencode --agent']);
    cacheDetection(null, error);
    throw error;
  }

  cacheDetection(profile);
  return { ...profile };
}

// Handoff still starts an interactive TUI. Keep its existing capability check and fallback.
export function opencodeTuiAcceptsModelFlags({ run = execFileSync, env = process.env, refresh = false, timeoutMs = HELP_TIMEOUT_MS } = {}) {
  if (!refresh && cachedTuiModelFlags !== null) return cachedTuiModelFlags;
  const result = runOpenCode(run, ['--help'], env, timeoutMs);
  cachedTuiModelFlags = result.ok
    ? helpListsFlag(result.text, '--model') && helpListsFlag(result.text, '--agent')
    : true;
  return cachedTuiModelFlags;
}

// Drop cached help answers. Tests use this after they change the fake CLI.
export function resetOpenCodeTuiFlagsCache() {
  cachedTuiModelFlags = null;
  cachedOpenCodeDetection = null;
}

// The flag that the OpenCode CLI refused, or null.
export function unsupportedOpenCodeFlag(text) {
  const match = UNSUPPORTED_FLAG.exec(String(text ?? ''));
  return match ? match[1] : null;
}

// The project config selects the model and worker agent when the launch command has no agent flag.
export function openCodeConfigText(model) {
  return `${JSON.stringify({ $schema: 'https://opencode.ai/config.json', model, default_agent: 'worker' }, null, 2)}\n`;
}

export const OPEN_CODE_CONFIG_NAME = OPEN_CODE_CONFIG_FILE;
