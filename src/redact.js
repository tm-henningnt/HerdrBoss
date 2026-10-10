import fs from 'node:fs';
import path from 'node:path';
import { PRIVATE_ACCESS_DIR } from './config.js';

// The same patterns as the handover context redaction in handoff.js.
export function redactSecrets(value) {
  return value
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{3,}|gh[pousr]_[a-zA-Z0-9_]{8,}|github_pat_[a-zA-Z0-9_]{8,}|AIza[a-zA-Z0-9_-]{12,}|xox[baprs]-[a-zA-Z0-9-]{8,})\b/g, '[REDACTED]')
    .replace(/("(?:[a-z][a-z0-9]*[_-])*(?:api[_-]?key|key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd)"\s*[:=]\s*")(?:(?:\\.)|[^"\\\r\n])*"/gi, '$1[REDACTED]"')
    .replace(/\b((?:[a-z][a-z0-9]*[_-])*(?:api[_-]?key|key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd)\s*[:=]\s*)(?:["'][^"'\r\n]*["']|[^\s,;]+)/gi, '$1[REDACTED]');
}

const SECRET_NAME = '(?:[a-z][a-z0-9_.-]*[._-])?(?:access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd|api[_-]?key|authorization|(?:private[_-]?|secret[_-]?)?key)';
export const REDACT_LITERAL_CLASSES = Object.freeze(['host', 'app-id', 'ext-id', 'space-id']);
const MAX_LITERAL_CHARS = 4096;

function validLiteral(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_LITERAL_CHARS
    && !/[\s\u0000-\u001f\u007f]/.test(value);
}

function normalizeLiterals(values) {
  return Object.fromEntries(REDACT_LITERAL_CLASSES.map((kind) => [kind,
    [...new Set((Array.isArray(values?.[kind]) ? values[kind] : []).filter(validLiteral))],
  ]));
}

export function readRedactLiterals({ privateDir = PRIVATE_ACCESS_DIR } = {}) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(privateDir, 'config.json'), 'utf8'));
    return normalizeLiterals(config?.redact?.literals);
  } catch { return normalizeLiterals(); }
}

// Only stdin supplies a literal. Keep errors and successful output free of private values.
export function addRedactLiteral(kind, value, { privateDir = PRIVATE_ACCESS_DIR } = {}) {
  if (!REDACT_LITERAL_CLASSES.includes(kind) || !validLiteral(value)) throw new Error('invalid literal');
  const file = path.join(privateDir, 'config.json');
  let config = {};
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error('invalid config');
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('private config unavailable');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || (config.redact !== undefined && (!config.redact || typeof config.redact !== 'object' || Array.isArray(config.redact)))) {
    throw new Error('invalid config');
  }
  const literals = normalizeLiterals(config.redact?.literals);
  literals[kind] = [...new Set([...literals[kind], value])];
  config.redact = { ...config.redact, literals };
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  const temporaryDir = fs.mkdtempSync(path.join(privateDir, '.redact-'));
  try {
    const temporaryFile = path.join(temporaryDir, 'config.json');
    fs.writeFileSync(temporaryFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryFile, file);
  } finally { fs.rmSync(temporaryDir, { recursive: true, force: true }); }
}

function validTenantHost(value) {
  if (typeof value !== 'string') return null;
  let host = value.trim();
  if (!host || /[\u0000-\u0020\u007f]/.test(host)) return null;
  if (/^https?:\/\//i.test(host)) {
    try {
      const url = new URL(host);
      if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
      host = url.hostname;
    } catch { return null; }
  }
  host = host.replace(/\.$/, '').toLowerCase();
  if (host.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?))*$/.test(host)) return null;
  return host;
}

// Read this optional Owner-local list on every command. Never include its values in errors or output.
export function readRedactTenantHosts({ privateDir = PRIVATE_ACCESS_DIR } = {}) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(privateDir, 'config.json'), 'utf8'));
    if (!Array.isArray(config?.redact?.tenantHosts)) return [];
    return [...new Set(config.redact.tenantHosts.map(validTenantHost).filter(Boolean))].slice(0, 100);
  } catch { return []; }
}

function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function secretValuePattern() {
  return new RegExp(`(^|[^A-Za-z0-9_.-])(${SECRET_NAME}\\s*[:=]\\s*)(?:"((?:\\\\.|[^"\\\\])*)"|'([^'\\r\\n]*)'|([^\\s,;]+))`, 'gi');
}

function jsonSecretPattern() {
  return new RegExp(`("${SECRET_NAME}"\\s*:\\s*")(?:(?:\\\\.)|[^"\\\\])*(")`, 'gi');
}

function idValuePattern() {
  return /(^|[^A-Za-z0-9_.-])((?:app(?:lication)?|space|user)[_-]?id\s*(?::\s*|=\s*|\s+))(?:"[^"\r\n]*"|'[^'\r\n]*'|[A-Za-z0-9][A-Za-z0-9._:-]*)/gi;
}

function jsonIdPattern() {
  return /("(?:app(?:lication)?|space|user)[_-]?id"\s*:\s*")(?:(?:\\.)|[^"\\])*(")/gi;
}

function configuredHostPattern(hosts) {
  if (!hosts.length) return null;
  const names = hosts.map(escapeRegExp).sort((a, b) => b.length - a.length).join('|');
  return new RegExp(`(^|[^A-Za-z0-9.-])(?:${names})(?=[:/?#\\s"'<>),;!?]|\\.(?=$|[\\s"'<>),;!?])|$)`, 'gi');
}

// Keep this order fixed. Earlier classes must consume their complete value before a later rule
// can replace an overlapping part of it.
export function createRedactor(tenantHosts = [], literals = {}, { onFinding = () => {} } = {}) {
  const hosts = [...new Set((Array.isArray(tenantHosts) ? tenantHosts : []).map(validTenantHost).filter(Boolean))];
  const tenantHost = configuredHostPattern(hosts);
  const secretValue = secretValuePattern();
  const jsonSecret = jsonSecretPattern();
  const idValue = idValuePattern();
  const jsonId = jsonIdPattern();
  const literalClasses = new Map();
  for (const [kind, values] of Object.entries(normalizeLiterals(literals))) {
    for (const value of values) if (!literalClasses.has(value)) literalClasses.set(value, kind);
  }
  const literalNames = [...literalClasses.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
  const literalPattern = literalNames ? new RegExp(`(?<![A-Za-z0-9_.-])(?:${literalNames})(?![A-Za-z0-9_.-])`, 'g') : null;

  return function redactText(value) {
    let text = String(value);
    // Mark replacements privately until all rules finish. Later rules cannot match part of a tag.
    let marker = '\uE000';
    while (text.includes(marker)) marker += '\uE000';
    const classes = [];
    const mask = (kind) => `${marker}${classes.push(kind) - 1}${marker}`;
    const maskedValue = new RegExp(`^${marker}\\d+${marker}$`);
    const maskQuotedValue = (kind) => (match, before, after) => {
      const value = match.slice(before.length, -after.length);
      return maskedValue.test(value) ? match : before + mask(kind) + after;
    };
    // 1. Whole GUIDs first, including uppercase GUIDs and GUIDs adjacent to longer values.
    text = text.replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi, () => mask('uuid'));
    // 2. Match each private literal as a complete, case-sensitive token.
    if (literalPattern) text = text.replace(literalPattern, (match) => mask(literalClasses.get(match)));
    // 3. Mask hex runs of 24 or more characters. This covers every longer run too.
    text = text.replace(/(?<![0-9a-f])[0-9a-f]{24,}(?![0-9a-f])/gi, () => mask('hex'));
    // 4. Mask configured tenant hosts and Qlik Cloud tenant hostnames.
    if (tenantHost) text = text.replace(tenantHost, (match, before) => before + mask('host'));
    text = text.replace(/\b[a-z0-9-]+\.[a-z0-9-]+\.qlikcloud\.com\b/gi, () => mask('host'));
    // 5. Mask private-key blocks, bearer values, JWTs, and common token prefixes.
    text = text.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi, () => mask('key'));
    text = text.replace(/\bBearer[ \t]+[^\s"']+/gi, () => mask('token'));
    text = text.replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, () => mask('token'));
    text = text.replace(/\b(?:github_pat_|ghp_|sk-|xox)[A-Za-z0-9_-]{8,}/gi, () => mask('token'));
    // 6. Keep secret field names and their quote style.
    text = text.replace(jsonSecret, maskQuotedValue('secret'));
    text = text.replace(secretValue, (match, before, keyAndSeparator, doubleQuoted, singleQuoted, unquoted) => {
      if (maskedValue.test(doubleQuoted ?? singleQuoted ?? unquoted)) return match;
      const tag = mask('secret');
      const secret = doubleQuoted !== undefined ? `"${tag}"` : singleQuoted !== undefined ? `'${tag}'` : tag;
      return `${before}${keyAndSeparator}${secret}`;
    });
    // 7. Keep app, space, and user ID field names.
    text = text.replace(jsonId, maskQuotedValue('id'));
    text = text.replace(idValue, (match, before, keyAndSeparator) => {
      const value = match.slice(before.length + keyAndSeparator.length);
      const unquoted = value.startsWith('"') || value.startsWith("'") ? value.slice(1, -1) : value;
      if (maskedValue.test(unquoted)) return match;
      const tag = mask('id');
      const id = value.startsWith('"') ? `"${tag}"` : value.startsWith("'") ? `'${tag}'` : tag;
      return `${before}${keyAndSeparator}${id}`;
    });
    // 8. Qlik object IDs have 24 alphanumeric characters, with a letter and a digit.
    text = text.replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9]{24}(?![A-Za-z0-9_-])/g,
      (match) => /[A-Za-z]/.test(match) && /[0-9]/.test(match) ? mask('qlik-id') : match);
    // 9. Extension IDs have 32 characters in two or three groups of 5 to 17 letters and digits.
    text = text.replace(/(?<![A-Za-z0-9-])[A-Za-z0-9]{5,17}(?:-[A-Za-z0-9]{5,17}){1,2}(?![A-Za-z0-9-])/g,
      (match) => match.length === 32 && match.split('-').every((group) => /[A-Za-z]/.test(group) && /[0-9]/.test(group)) ? mask('ext-id') : match);
    return text.replace(new RegExp(`${marker}(\\d+)${marker}`, 'g'), (match, index) => {
      const kind = classes[Number(index)];
      onFinding(kind);
      return `<${kind}>`;
    });
  };
}
