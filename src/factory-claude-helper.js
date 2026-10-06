// The Claude usage helper of a factory container. The container start script runs this file as the factory user.
// It writes the `statusLine` key of the factory user settings (~/.claude/settings.json) and no other key.
// It never reads a login file. It never touches a file of the Owner Mac: it runs only inside the container.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const CLAUDE_STATUSLINE_COMMAND = 'herdr-boss claude-statusline';
const ENTRY = Object.freeze({ type: 'command', command: CLAUDE_STATUSLINE_COMMAND });
const isOurs = (value) => value && typeof value === 'object' && value.type === ENTRY.type && value.command === ENTRY.command;
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
  if (present && isOurs(settings.statusLine)) return { state: 'unchanged' };
  if (present) return { state: 'refused', message: `The factory user already has a statusLine in ${file}. The usage helper is not installed and the Claude usage limit stays unknown. Remove that statusLine or turn the setting off.` };
  writeSettings(file, { ...settings, statusLine: { ...ENTRY } });
  return { state: 'installed' };
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
