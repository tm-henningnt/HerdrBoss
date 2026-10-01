import { isIP } from 'node:net';

const WEB_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);
const URL_FIELDS = new Set(['url', 'start', 'startUrl', 'webSocketDebuggerUrl']);
const WEB_URL_PREFIX = /^(?:https?|wss?):\/\//i;
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

function maskBookmarkName(value, { full = false } = {}) {
  if (typeof value !== 'string' || full) return value;
  return value.replace(HOST_TEXT_TOKEN, (token) => {
    const host = token.replace(/^\[|\]$/g, '');
    if (isLoopback(host) || (!isIP(host) && !/[\p{L}]/u.test(host))) return token;
    return maskedHost(host);
  });
}

export function maskUrl(value, { full = false } = {}) {
  if (typeof value !== 'string' || full) return value;

  let parsed;
  try { parsed = new URL(value); }
  catch { return value; }

  if (parsed.protocol === 'data:' || parsed.protocol === 'javascript:') return '<redacted-url>';

  const hadCredentials = parsed.username !== '' || parsed.password !== '';
  if (!WEB_PROTOCOLS.has(parsed.protocol)) {
    if (!hadCredentials) return value;
    parsed.username = '';
    parsed.password = '';
    return parsed.href;
  }

  const host = isLoopback(parsed.hostname) ? parsed.hostname : maskedHost(parsed.hostname);
  const port = explicitPort(value) || (parsed.port ? `:${parsed.port}` : '');
  const suffix = isLoopback(parsed.hostname) ? `${parsed.search}${parsed.hash}` : '';
  return `${parsed.protocol}//${host}${port}${parsed.pathname}${suffix}`;
}

export function maskDeep(value, options = {}) {
  if (typeof value === 'string') return WEB_URL_PREFIX.test(value) ? maskUrl(value, options) : value;
  if (Array.isArray(value)) return value.map((item) => maskDeep(item, options));
  if (value && typeof value === 'object') {
    const result = Object.create(Object.getPrototypeOf(value));
    const isBookmark = typeof value.name === 'string' && typeof value.url === 'string';
    for (const [key, item] of Object.entries(value)) {
      const shouldMask = URL_FIELDS.has(key) && typeof item === 'string';
      if (key === 'name' && isBookmark) result[key] = maskBookmarkName(item, options);
      else if (shouldMask || (typeof item === 'string' && WEB_URL_PREFIX.test(item))) result[key] = maskUrl(item, options);
      else result[key] = maskDeep(item, options);
    }
    return result;
  }
  return value;
}
