// The Claude usage helper of a factory container. The container start script runs this file as the factory user.
// It writes the `statusLine` key of the factory user settings (~/.claude/settings.json) and no other key.
// It never reads a login file. It never touches a file of the Owner Mac: it runs only inside the container.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { claudeRateLimitsDir } from './claude-statusline.js';
import { isInsideContainer } from './factory-core.js';

export const CLAUDE_STATUSLINE_COMMAND = 'herdr-boss claude-statusline';
const ENTRY = Object.freeze({ type: 'command', command: CLAUDE_STATUSLINE_COMMAND });
// An entry is ours when it runs `herdr-boss claude-statusline`, with any path prefix and any extra key.
const OWN_COMMAND = /^(?:\S*\/)?herdr-boss claude-statusline$/;
const isOurs = (value) => Boolean(value) && typeof value === 'object' && value.type === ENTRY.type && typeof value.command === 'string' && OWN_COMMAND.test(value.command.trim());
const isRecord = (value) => value && typeof value === 'object' && !Array.isArray(value);

// The switch is `factories.claudeUsageHelper` in config.json of the data folder. It is on unless the value is false.
export function claudeHelperEnabled(dataDir) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    return config?.factories?.claudeUsageHelper !== false;
  } catch { return true; }
}

function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

// Install or remove the entry. Returns { state: installed | removed | unchanged | refused, message? }.
export function applyClaudeHelper({ home, enabled }) {
  const file = path.join(home, '.claude', 'settings.json');
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isRecord(settings)) return { state: 'refused', message: `The Claude settings file of the factory user is not a JSON object. The usage helper is not changed. Fix ${file}.` };
  } catch (error) {
    if (error.code !== 'ENOENT') return { state: 'refused', message: `The Claude settings file of the factory user cannot be read as JSON. The usage helper is not changed. Fix ${file}.` };
  }
  const present = Object.hasOwn(settings, 'statusLine');
  if (!enabled) {
    if (!present || !isOurs(settings.statusLine)) return { state: 'unchanged' };
    const { statusLine, ...rest } = settings;
    writeSettings(file, rest);
    return { state: 'removed' };
  }
  if (present && isOurs(settings.statusLine)) {
    if (settings.statusLine.command === ENTRY.command) return { state: 'unchanged' };
    writeSettings(file, { ...settings, statusLine: { ...settings.statusLine, command: ENTRY.command } });
    return { state: 'installed' };
  }
  if (present) return { state: 'refused', message: `The factory user already has a statusLine in ${file}. The usage helper is not installed and the Claude usage limit stays unknown. Remove that statusLine or turn the setting off.` };
  writeSettings(file, { ...settings, statusLine: { ...ENTRY } });
  return { state: 'installed' };
}

// One state word for the host tool: installed, unchanged, removed, off, foreign, or unreadable.
// A foreign statusLine is never replaced, so no backup of it is needed.
export function claudeHelperWord({ home }) {
  const enabled = claudeHelperEnabled(path.join(home, '.herdr-boss'));
  const result = applyClaudeHelper({ home, enabled });
  if (result.state === 'refused') return /already has a statusLine/.test(result.message) ? 'foreign' : 'unreadable';
  return !enabled && result.state === 'unchanged' ? 'off' : result.state;
}

function newestReadingMs(dir) {
  let newest = null;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const file = path.join(dir, name);
      const at = Date.parse(JSON.parse(fs.readFileSync(file, 'utf8')).observedAt);
      const time = Number.isFinite(at) ? at : fs.statSync(file).mtimeMs;
      if (newest === null || time > newest) newest = time;
    } catch {}
  }
  return newest;
}

// The helper state for the Fleet summary. Reads the settings of the factory user and the readings folder. Never a login file.
export function claudeHelperState({ home, now = Date.now() }) {
  const dataDir = path.join(home, '.herdr-boss');
  if (!claudeHelperEnabled(dataDir)) return { state: 'not-installed', reason: 'setting-off' };
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    if (!isRecord(settings)) return { state: 'not-installed', reason: 'settings-unreadable' };
  } catch (error) {
    if (error.code !== 'ENOENT') return { state: 'not-installed', reason: 'settings-unreadable' };
  }
  if (Object.hasOwn(settings, 'statusLine') && !isOurs(settings.statusLine)) return { state: 'not-installed', reason: 'different-statusline' };
  let newest = null;
  try { newest = newestReadingMs(claudeRateLimitsDir(dataDir)); } catch {}
  if (!isOurs(settings.statusLine) || newest === null) return { state: 'not-installed', reason: 'no-reading' };
  return { state: 'installed', lastReadingSeconds: Math.max(0, Math.floor((now - newest) / 1000)) };
}

// The command `herdr-boss claude-helper --apply`. It writes the settings file of the home folder, so it runs only in a container.
// Returns the exit code. A usage error throws.
export function claudeHelperCommand(args, { home = process.env.HOME || os.homedir(), isContainer = isInsideContainer, print = (text) => console.log(text) } = {}) {
  if (args[0] !== '--apply') throw new Error('Use herdr-boss claude-helper --apply.');
  if (!isContainer()) {
    print('The Claude usage helper command runs only inside a factory container. Nothing was changed.');
    return 1;
  }
  print(claudeHelperWord({ home }));
  return 0;
}

// The container start entry. A refusal prints one message and exits 0, so the container still starts.
export function main({ home = process.env.HOME || os.homedir(), print = (text) => console.log(text) } = {}) {
  try {
    const result = applyClaudeHelper({ home, enabled: claudeHelperEnabled(path.join(home, '.herdr-boss')) });
    if (result.message) print(result.message);
  } catch (error) { print(`The Claude usage helper was not applied: ${String(error?.message || error).split('\n')[0]}`); }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
