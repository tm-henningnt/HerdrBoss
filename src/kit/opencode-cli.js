// OpenCode 1.x starts an interactive TUI. OpenCode 2.x uses `run` with a message.
// Read the installed help before worker start so an unsupported command cannot create a worktree.
import { execFileSync } from 'node:child_process';

const HELP_TIMEOUT_MS = 15_000;
const OPEN_CODE_CONFIG_FILE = 'opencode.json';
const UNSUPPORTED_FLAG = /unrecognized flag:\s*(\S+)\s+in command opencode(?:\s+run)?/i;

let cachedTuiModelFlags = null;

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
  const match = /\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(String(text ?? ''));
  return match?.[1] ?? null;
}

function unsupportedLaunch(version, rejected) {
  const label = version ? `OpenCode ${version}` : 'The installed OpenCode CLI';
  const flags = [...new Set(rejected)];
  return new Error(`${label} has no accepted worker launch form. Help did not accept: ${flags.join(', ') || 'opencode run'}. Worker start stopped before worktree creation.`);
}

// Return the selected launch form and the version that worker start must record.
export function detectOpenCodeCli({ run = execFileSync, env = process.env, timeoutMs = HELP_TIMEOUT_MS } = {}) {
  const versionResult = runOpenCode(run, ['--version'], env, timeoutMs);
  const topResult = runOpenCode(run, ['--help'], env, timeoutMs);
  const runResult = runOpenCode(run, ['run', '--help'], env, timeoutMs);
  const version = parseVersion(versionResult.text) || parseVersion(topResult.text) || parseVersion(runResult.text);
  if (!version) throw new Error('Could not read the OpenCode version from `opencode --version` or its help. Worker start stopped before worktree creation.');
  const major = version ? Number(version.split('.')[0]) : null;

  const tuiModelFlag = helpListsFlag(topResult.text, '-m') ? '-m' : null;
  const tuiAgentFlag = helpListsFlag(topResult.text, '--agent') ? '--agent' : null;
  const runExists = runResult.ok && /\bopencode\s+run\b/i.test(runResult.text);
  const runModelFlag = helpListsFlag(runResult.text, '--model') ? '--model'
    : helpListsFlag(runResult.text, '-m') ? '-m' : null;
  const runAgentFlag = helpListsFlag(runResult.text, '--agent') ? '--agent' : null;

  let profile;
  if (major === 1) {
    if (tuiModelFlag && tuiAgentFlag) {
      profile = { version, mode: 'tui', modelFlag: tuiModelFlag, agentFlag: tuiAgentFlag, config: false };
    } else {
      const rejected = [];
      if (!tuiModelFlag) rejected.push('opencode -m');
      if (!tuiAgentFlag) rejected.push('opencode --agent');
      throw unsupportedLaunch(version, rejected);
    }
  } else if (major === null || major >= 2) {
    if (runExists && runModelFlag) {
      profile = { version, mode: 'run', modelFlag: runModelFlag, agentFlag: runAgentFlag, config: !runAgentFlag };
    } else {
      const rejected = [];
      if (!runExists) rejected.push('opencode run');
      if (!runModelFlag) {
        rejected.push('opencode run --model');
        if (!helpListsFlag(runResult.text, '-m')) rejected.push('opencode run -m');
      }
      if (!tuiModelFlag) rejected.push('opencode -m');
      if (!tuiAgentFlag) rejected.push('opencode --agent');
      throw unsupportedLaunch(version, rejected);
    }
  } else {
    throw unsupportedLaunch(version, ['opencode -m', 'opencode --agent', 'opencode run --model']);
  }

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
