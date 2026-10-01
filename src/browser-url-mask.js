import { isIP } from 'node:net';

const WEB_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);
const URL_FIELDS = new Set(['url', 'start', 'startUrl', 'startPage', 'pageUrl', 'targetUrl', 'webSocketDebuggerUrl']);
const URL_TEXT_SOURCE = '(?<![\\p{L}\\p{N}_.-])(?:[a-z][a-z\\d+.-]*:\\/\\/|about:|data:|javascript:|blob:)[^\\s"\'`<>]+';
const MAX_JWT_PART_LENGTH = 4096;
const SECRET_FIELDS = /^[A-Za-z0-9_]*(?:code|state|session_state|access_token|id_token|refresh_token|token|key)$/i;
// Status fields with fixed enum values. Their names end in a secret suffix, but they hold no secret.
const STATUS_FIELDS = new Set(['processState']);
const HOST_TEXT_TOKEN = /(?<![\p{L}\p{N}_.-])(?:\[[\da-f:.]+\]|(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?|(?:\d{1,3}\.){3}\d{1,3})(?![\p{L}\p{N}_-])/giu;

function explicitPort(value) {
  const authority = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(value)?.[1];
  if (!authority) return '';
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  if (hostPort.startsWith('[')) {
    const close = hostPort.indexOf(']');
    const port = hostPort.slice(close + 1);
    return /^:\d+$/.test(port) ? port : '';
  }
  const colon = hostPort.lastIndexOf(':');
  const port = hostPort.slice(colon);
  return colon >= 0 && /^:\d+$/.test(port) ? port : '';
}

function isLoopback(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  return isIP(host) === 4 && host.split('.')[0] === '127';
}

function maskedHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return '<ip>';
  const labels = host.split('.');
  return labels.length === 1 ? '<tenant>' : `<tenant>.${labels.slice(1).join('.')}`;
}

function redactJwtTokens(value) {
  const output = [];
  const parts = [];
  let copiedUntil = 0;
  // Consume each run once. A failed candidate never retries inside a long run.
  for (const match of value.matchAll(/[A-Za-z0-9_-]+={0,2}/g)) {
    const start = match.index;
    const previous = parts.at(-1);
    if (previous && (start !== previous.end + 1 || value[previous.end] !== '.')) parts.length = 0;
    parts.push({ start, end: start + match[0].length, text: match[0] });
    if (parts.length < 3) continue;
    const header = parts[0].text;
    let redact = parts.some((part) => part.text.length > MAX_JWT_PART_LENGTH);
    if (!redact && header.length >= 3) {
      redact = header.startsWith('eyJ');
      if (!redact) {
        // A JSON header distinguishes a JWT from an ordinary three-label host.
        const decoded = Buffer.from(header, 'base64url').toString('utf8').trimStart();
        if (decoded.startsWith('{')) {
          try {
            const parsed = JSON.parse(decoded);
            redact = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
          } catch {}
        }
      }
    }
    if (redact) {
      output.push(value.slice(copiedUntil, parts[0].start), '<redacted>');
      copiedUntil = parts[2].end;
      parts.length = 0;
    } else parts.shift();
  }
  output.push(value.slice(copiedUntil));
  return output.join('');
}

export function redactBrowserSecrets(value) {
  if (typeof value !== 'string') return value;
  return redactJwtTokens(value
    .replace(/\b([A-Za-z0-9_]*(?:code|state|session_state|access_token|id_token|refresh_token|token|key)\s*(?:=|%3d|:)\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&?#"'<>;,\\]+)/gi, '$1<redacted>')
    .replace(/\b(Bearer\s+)[^\s"'<>;,\\]+/gi, '$1<redacted>'));
}

export function maskBrowserText(value, { full = false, maskHosts = false } = {}) {
  if (typeof value !== 'string') return value;
  // Decode raw text once, before JSON serialization can introduce escapes.
  try { value = decodeURIComponent(value); } catch {}
  const maskText = (text) => {
    // Redact the complete JWT, including padding, before matching host names.
    const redacted = redactBrowserSecrets(text);
    if (!maskHosts || full) return redacted;
    return redacted.replace(HOST_TEXT_TOKEN, (token) => {
      const host = token.replace(/^\[|\]$/g, '');
      if (isLoopback(host) || (!isIP(host) && !/[\p{L}]/u.test(host))) return token;
      return maskedHost(host);
    });
  };
  const output = [];
  let copiedUntil = 0;
  // Strip each URL as a whole before redaction can add markers to its query.
  for (const match of value.matchAll(new RegExp(URL_TEXT_SOURCE, 'giu'))) {
    output.push(maskText(value.slice(copiedUntil, match.index)), maskUrl(match[0], { full }));
    copiedUntil = match.index + match[0].length;
  }
  output.push(maskText(value.slice(copiedUntil)));
  return redactBrowserSecrets(output.join(''));
}

export function maskUrl(value, { full = false } = {}) {
  if (typeof value !== 'string') return value;

  let parsed;
  try { parsed = new URL(value); }
  catch { return redactBrowserSecrets(value.split(/[?#]/, 1)[0]); }

  if (parsed.protocol === 'data:' || parsed.protocol === 'javascript:') return '<redacted-url>';

  if (!WEB_PROTOCOLS.has(parsed.protocol)) {
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return redactBrowserSecrets(parsed.href);
  }

  const host = full || isLoopback(parsed.hostname) ? parsed.hostname : maskedHost(parsed.hostname);
  const port = explicitPort(value) || (parsed.port ? `:${parsed.port}` : '');
  return redactBrowserSecrets(`${parsed.protocol}//${host}${port}${parsed.pathname}`);
}

export function maskDeep(value, options = {}) {
  if (typeof value === 'string') return maskBrowserText(value, options);
  if (Array.isArray(value)) return value.map((item) => maskDeep(item, options));
  if (value && typeof value === 'object') {
    const result = Object.create(Object.getPrototypeOf(value));
    const isBookmark = typeof value.name === 'string' && typeof value.url === 'string';
    for (const [key, item] of Object.entries(value)) {
      const shouldMask = URL_FIELDS.has(key) && typeof item === 'string';
      if (SECRET_FIELDS.test(key) && !STATUS_FIELDS.has(key) && item !== null && ['string', 'number', 'boolean'].includes(typeof item)) result[key] = '<redacted>';
      else if (typeof item === 'string' && (key === 'title' || (key === 'name' && isBookmark))) result[key] = maskBrowserText(item, { ...options, maskHosts: true });
      else if (shouldMask) result[key] = maskUrl(item, options);
      else result[key] = maskDeep(item, options);
    }
    return result;
  }
  return value;
}

export function maskBrowserState(state) {
  if (!state || typeof state !== 'object') return state;
  const result = { ...state };
  for (const key of ['managedBrowsers', 'browsers', 'events']) {
    if (Object.hasOwn(result, key)) result[key] = maskDeep(result[key]);
  }
  return result;
}
