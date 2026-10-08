import { maskBrowserText } from './browser-url-mask.js';

export const CONSOLE_LEVELS = Object.freeze(['error', 'warn', 'info', 'log', 'debug']);
export const CONSOLE_LIMITS = Object.freeze({ last: 100, textChars: 500, inputChars: 20_000, sourceChars: 2_000, waitMs: 10_000, setupMs: 3_000 });

const USAGE = 'Use --tab ID, --level error|warn|info|log|debug, --last N, --wait-ms N, and --json to read console messages.';
const CONSOLE_SECRET_NAME = /pass(word)?|passwd|pwd|secret|session|sid|auth|credential|cookie|api[_-]?key|access[_-]?key/i;

function maskConsoleSecrets(value) {
  const headersMasked = value.replace(/(\b(?:set-cookie|cookie|authorization)\s*:\s*)[^\r\n]*/gi, '$1[masked]');
  return headersMasked.replace(/(^|[^A-Za-z0-9_-])(["']?)([A-Za-z0-9_-]+)\2(\s*[=:]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;)}\]]+)/gm, (match, prefix, quote, name, separator) => (
    CONSOLE_SECRET_NAME.test(name) ? `${prefix}${quote}${name}${quote}${separator}[masked]` : match
  ));
}

function maskConsoleOpaqueStrings(value) {
  return value
    .replace(/(?<![A-Fa-f0-9])[A-Fa-f0-9]{32,}(?![A-Fa-f0-9])/g, '[masked]')
    .replace(/(?<![A-Za-z0-9+/_=-])(?=[A-Za-z0-9+/_=-]{24,}(?![A-Za-z0-9+/_=-]))(?=[A-Za-z0-9+/_=-]*[A-Za-z])(?=[A-Za-z0-9+/_=-]*\d)[A-Za-z0-9+/_=-]{24,}(?![A-Za-z0-9+/_=-])/g, '[masked]')
    .replace(/(?<![A-Za-z0-9])[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g, (run) => (
      /[A-Za-z]/.test(run) && /\d/.test(run) ? '[masked]' : run
    ));
}

function maskConsoleText(value, options, sourcePath = false) {
  const safeText = maskConsoleSecrets(maskBrowserText(value, options));
  if (sourcePath) return safeText.split('/').map(maskConsoleOpaqueStrings).join('/');
  return maskConsoleOpaqueStrings(safeText);
}

function boundedInteger(value, min, max, flag) {
  if (!/^-?\d+$/.test(value || '')) throw new Error(USAGE);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`${flag} must be from ${min} to ${max}.`);
  return parsed;
}

export function parseConsoleOptions(args) {
  let tab = null;
  let last = 20;
  let waitMs = 1000;
  let json = false;
  let lastSeen = false;
  let waitSeen = false;
  const levels = [];

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--tab' && args[index + 1] && tab === null) tab = args[++index];
    else if (args[index] === '--level' && args[index + 1]) {
      const level = args[++index];
      if (!CONSOLE_LEVELS.includes(level)) throw new Error('Use --level error|warn|info|log|debug.');
      if (!levels.includes(level)) levels.push(level);
    } else if (args[index] === '--last' && args[index + 1] && !lastSeen) {
      last = boundedInteger(args[++index], 1, CONSOLE_LIMITS.last, '--last');
      lastSeen = true;
    } else if (args[index] === '--wait-ms' && args[index + 1] && !waitSeen) {
      waitMs = boundedInteger(args[++index], 0, CONSOLE_LIMITS.waitMs, '--wait-ms');
      waitSeen = true;
    } else if (args[index] === '--json' && !json) json = true;
    else throw new Error(USAGE);
  }

  return { tab, levels: levels.length ? levels : [...CONSOLE_LEVELS], last, waitMs, json };
}

function consoleLevel(value) {
  if (value === 'warning') return 'warn';
  if (value === 'verbose') return 'debug';
  if (value === 'assert') return 'error';
  if (value === 'trace' || value === 'dir' || value === 'dirxml' || value === 'table' || value === 'startGroup' || value === 'startGroupCollapsed' || value === 'endGroup') return 'debug';
  if (value === 'count' || value === 'timeEnd') return 'info';
  return CONSOLE_LEVELS.includes(value) ? value : 'log';
}

function argumentText(argument) {
  if (!argument || typeof argument !== 'object') return '[value]';
  if (argument.type === 'string' && typeof argument.value === 'string') return argument.value;
  if (argument.type === 'number' && typeof argument.value === 'number' && Number.isFinite(argument.value)) return String(argument.value);
  if (argument.type === 'boolean' && typeof argument.value === 'boolean') return String(argument.value);
  if (argument.type === 'undefined') return 'undefined';
  if (argument.subtype === 'null') return 'null';
  if (argument.type === 'symbol') return '[symbol]';
  if (argument.type === 'function') return '[function]';
  return '[object]';
}

function eventDetails(event) {
  if (event?.method === 'Log.entryAdded') {
    const entry = event.params?.entry;
    if (!entry || typeof entry !== 'object') return null;
    const frame = entry.stackTrace?.callFrames?.[0];
    return {
      level: consoleLevel(entry.level),
      timestamp: entry.timestamp,
      text: typeof entry.text === 'string' ? entry.text : '',
      url: typeof frame?.url === 'string' ? frame.url : entry.url,
      lineNumber: typeof frame?.lineNumber === 'number' ? frame.lineNumber : entry.lineNumber,
    };
  }

  if (event?.method === 'Runtime.consoleAPICalled') {
    const params = event.params;
    if (!params || typeof params !== 'object') return null;
    const frame = params.stackTrace?.callFrames?.[0];
    const args = Array.isArray(params.args) ? params.args.slice(0, 50).map(argumentText) : [];
    return {
      level: consoleLevel(params.type),
      timestamp: params.timestamp,
      text: args.join(' '),
      url: typeof frame?.url === 'string' ? frame.url : '',
      lineNumber: frame?.lineNumber,
    };
  }

  return null;
}

function timestampText(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  const milliseconds = Number.isFinite(parsed) ? (parsed < 1_000_000_000_000 ? parsed * 1000 : parsed) : Date.now();
  try { return new Date(milliseconds).toISOString(); }
  catch { return new Date().toISOString(); }
}

function sourceText(value, lineNumber, knownHosts) {
  let path = 'unknown';
  if (typeof value === 'string' && value) {
    if (/^(?:data|javascript):/i.test(value)) path = '<redacted-url>';
    else {
      const bounded = value.slice(0, CONSOLE_LIMITS.sourceChars);
      try {
        path = new URL(bounded).pathname || bounded.split(/[?#]/, 1)[0];
      } catch {
        path = bounded.split(/[?#]/, 1)[0];
      }
    }
  }
  const safePath = maskConsoleText(path, { knownHosts }, true)
    .replace(/[\r\n\t]/g, ' ')
    .slice(0, 300);
  const line = Number.isFinite(lineNumber) && lineNumber >= 0 ? Math.floor(lineNumber) + 1 : null;
  return line === null ? safePath || 'unknown' : `${safePath || 'unknown'}:${line}`;
}

export function formatConsoleEvent(event, { levels = CONSOLE_LEVELS, knownHosts = [] } = {}) {
  const details = eventDetails(event);
  if (!details || !levels.includes(details.level)) return null;
  const maskedText = maskConsoleText(details.text.slice(0, CONSOLE_LIMITS.inputChars), { maskHosts: true, knownHosts });
  const text = Array.from(maskedText).slice(0, CONSOLE_LIMITS.textChars).join('');
  return {
    level: details.level,
    timestamp: timestampText(details.timestamp),
    text,
    source: sourceText(details.url, details.lineNumber, knownHosts),
  };
}
