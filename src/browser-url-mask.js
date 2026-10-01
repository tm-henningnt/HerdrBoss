import { isIP } from 'node:net';

const WEB_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);
const URL_FIELDS = new Set(['url', 'start', 'startUrl', 'startPage', 'pageUrl', 'targetUrl', 'webSocketDebuggerUrl']);
const URL_TEXT_SOURCE = '(?:[a-z][a-z\\d+.-]*:\\/\\/|about:|data:|javascript:|blob:)[^\\s"\'`<>]+';
const SECRET_FIELDS = /^(?:code|state|session_state|access_token|id_token|refresh_token|token|key)$/i;
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

export function redactBrowserSecrets(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/\b((?:code|state|session_state|access_token|id_token|refresh_token|token|key)\s*=\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&?#"'<>;,\\]+)/gi, '$1<redacted>')
    .replace(/\b(Bearer\s+)[^\s"'<>;,\\]+/gi, '$1<redacted>')
    .replace(/(?<![A-Za-z0-9_-])([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/g, (token, header) => {
      if (header.startsWith('eyJ')) return '<redacted>';
      // A JWT header is a base64url JSON object. Ordinary three-label hosts stay readable.
      try {
        const parsed = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return '<redacted>';
      } catch {}
      return token;
    });
}

export function maskBrowserText(value, { full = false, maskHosts = false } = {}) {
  if (typeof value !== 'string') return value;
  // Match a URL as one token, so its replacement is not masked again as a host.
  const tokens = new RegExp(maskHosts ? `${URL_TEXT_SOURCE}|${HOST_TEXT_TOKEN.source}` : URL_TEXT_SOURCE, 'giu');
  const output = value.replace(tokens, (token) => {
    if (/^[a-z][a-z\d+.-]*:/i.test(token) && !isIP(token.replace(/^\[|\]$/g, ''))) return maskUrl(token, { full });
    const redacted = redactBrowserSecrets(token);
    if (redacted !== token) return redacted;
    if (full) return token;
    const host = token.replace(/^\[|\]$/g, '');
    if (isLoopback(host) || (!isIP(host) && !/[\p{L}]/u.test(host))) return token;
    return maskedHost(host);
  });
  return redactBrowserSecrets(output);
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
      if (SECRET_FIELDS.test(key) && item !== null && ['string', 'number', 'boolean'].includes(typeof item)) result[key] = '<redacted>';
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
