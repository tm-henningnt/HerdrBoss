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
export function createRedactor(tenantHosts = []) {
  const hosts = [...new Set((Array.isArray(tenantHosts) ? tenantHosts : []).map(validTenantHost).filter(Boolean))];
  const tenantHost = configuredHostPattern(hosts);
  const secretValue = secretValuePattern();
  const jsonSecret = jsonSecretPattern();
  const idValue = idValuePattern();
  const jsonId = jsonIdPattern();

  return function redactText(value) {
    let text = String(value);
    // 1. Whole GUIDs first, including uppercase GUIDs and GUIDs adjacent to longer values.
    text = text.replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi, '<uuid>');
    // 2. Mask hex runs of 24 or more characters. This covers every longer run too.
    text = text.replace(/(?<![0-9a-f])[0-9a-f]{24,}(?![0-9a-f])/gi, '<hex>');
    // 3. Mask configured tenant hosts and Qlik Cloud tenant hostnames.
    if (tenantHost) text = text.replace(tenantHost, '$1<host>');
    text = text.replace(/\b[a-z0-9-]+\.[a-z0-9-]+\.qlikcloud\.com\b/gi, '<host>');
    // 4. Mask private-key blocks, bearer values, JWTs, and common token prefixes.
    text = text.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi, '<key>');
    text = text.replace(/\bBearer[ \t]+[^\s"']+/gi, '<token>');
    text = text.replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '<token>');
    text = text.replace(/\b(?:github_pat_|ghp_|sk-|xox)[A-Za-z0-9_-]{8,}/gi, '<token>');
    // 5. Keep secret field names and their quote style.
    text = text.replace(jsonSecret, '$1<secret>$2');
    text = text.replace(secretValue, (match, before, keyAndSeparator, doubleQuoted, singleQuoted) => {
      const secret = doubleQuoted !== undefined ? '"<secret>"' : singleQuoted !== undefined ? "'<secret>'" : '<secret>';
      return `${before}${keyAndSeparator}${secret}`;
    });
    // 6. Keep app, space, and user ID field names.
    text = text.replace(jsonId, '$1<id>$2');
    text = text.replace(idValue, (match, before, keyAndSeparator) => {
      const value = match.slice(before.length + keyAndSeparator.length);
      const id = value.startsWith('"') ? '"<id>"' : value.startsWith("'") ? "'<id>'" : '<id>';
      return `${before}${keyAndSeparator}${id}`;
    });
    return text;
  };
}
