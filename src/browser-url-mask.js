import { isIP } from 'node:net';
import { domainToASCII, domainToUnicode } from 'node:url';

const WEB_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);
const URL_FIELDS = new Set(['url', 'start', 'startUrl', 'startPage', 'pageUrl', 'targetUrl', 'webSocketDebuggerUrl']);
const SCHEME = '(?:https?|wss?|ftp|file)';
// A scheme is followed by a slash run that may hold whitespace or a backslash, by a dotted host, or by another scheme.
const SCHEME_SEP = `:(?:[\\\\/][\\s\\\\/]*|(?=[\\p{L}\\p{N}-]+\\.[\\p{L}\\p{N}])|(?=${SCHEME}:[\\\\/]))`;
const URL_TEXT_SOURCE = `(?<![\\p{L}\\p{N}_.-])(?:${SCHEME}${SCHEME_SEP}(?:${SCHEME}${SCHEME_SEP})*|[a-z][a-z\\d+.-]*:\\/\\/|about:|data:|javascript:|blob:)[^\\s"'\`<>]+|(?<![\\p{L}\\p{N}_.:/\\\\-])\\/\\/(?=[\\p{L}\\p{N}-]+\\.)[^\\s"'\`<>]+`;
const MAX_JWT_PART_LENGTH = 4096;
const SECRET_FIELDS = /^[A-Za-z0-9_]*(?:code|state|session_state|access_token|id_token|refresh_token|token|key)$/i;
// Status fields with fixed enum values. Their names end in a secret suffix, but they hold no secret.
const STATUS_FIELDS = new Set(['processState']);
const HOST_TEXT_TOKEN = /(?<![\p{L}\p{N}_.-])(?:\[[\da-f:.]+\]|(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?|(?:\d{1,3}\.){3}\d{1,3})(?![\p{L}\p{N}_-])/giu;
// A UUID is masked only after --app, --app-id, --id, /apps/, or app/. A bare UUID stays readable, because
// ordinary identifiers in a message must survive the filter.
const APP_UUID_TOKEN = /(?:(--app(?:-id)?|--id)(?:=|\s+)|(\/apps\/|app\/))([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/gi;

function maskAppUuid(value, { full = false } = {}) {
  if (full || typeof value !== 'string') return value;
  return value.replace(APP_UUID_TOKEN, (match, flag, prefix, uuid) => `${match.slice(0, match.length - uuid.length)}<uuid>`);
}

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

const WEB_SCHEME_PREFIX = /^(?:(?:https?|wss?|ftp|file):[\s\\/]*)+/i;
const NON_WEB_SCHEMES = /^(?:about|data|javascript|blob|mailto|tel|chrome|devtools|view-source):/i;
const BARE_HOST = /^(?:localhost|(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?)(?::\d+)?(?:[/?#]|$)/iu;
const MASKED_HOST_PROTOCOLS = new Set([...WEB_PROTOCOLS, 'ftp:', 'file:']);

// Decode a percent-encoded scheme separator, once or repeatedly, so that https%253A%252F%252Fhost reads as a URL.
function decodeSchemeEscapes(value) {
  return value.replace(/(?<=\b(?:https?|wss?|ftp|file))(?:(?:%25)*(?:%25|%)(?:3a|2f|5c|0a|0d|09|20)|[:/\\])+/gi, (run) => run
    .replace(/(?:%25)+(?=(?:3a|2f|5c|0a|0d|09|20))/gi, '%')
    .replace(/%3a/gi, ':').replace(/%2f/gi, '/').replace(/%5c/gi, '\\')
    .replace(/%0a/gi, '\n').replace(/%0d/gi, '\r').replace(/%09/gi, '\t').replace(/%20/gi, ' '));
}

// Repair a URL with a repeated scheme (https://https://host), a single slash, a backslash, whitespace after the
// scheme, a colon without slashes, a leading //, or no scheme (host/path), so that the host is parsed as a host.
export function repairWebUrl(value) {
  let text = decodeSchemeEscapes(value).trim();
  if (/^[<("'`]/.test(text)) text = text.replace(/^[<("'`]+/, '').replace(/[>)"'`,.;]+$/, '');
  if (/^file:\/\/\//i.test(text)) return text;
  const first = WEB_SCHEME_PREFIX.exec(text);
  if (first) return `${first[0].split(':')[0].toLowerCase()}://${text.slice(first[0].length)}`;
  if (/^\/\/[^\s/]/.test(text)) return `https:${text}`;
  if (!NON_WEB_SCHEMES.test(text) && !/^[a-z][a-z\d+.-]*:\/\//i.test(text) && BARE_HOST.test(text)) return `https://${text}`;
  return value;
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

function maskHostTokens(text, full) {
  if (full) return text;
  return text.replace(HOST_TEXT_TOKEN, (token) => {
    const host = token.replace(/^\[|\]$/g, '');
    if (isLoopback(host) || (!isIP(host) && !/[\p{L}]/u.test(host))) return token;
    return maskedHost(host);
  });
}

function maskKnownHosts(text, knownHosts) {
  let result = text;
  const forms = new Set();
  for (const host of knownHosts) {
    if (typeof host !== 'string' || host.length < 3 || isLoopback(host)) continue;
    for (const form of [host, domainToASCII(host), domainToUnicode(host)]) if (form) forms.add(form);
  }
  for (const host of forms) {
    result = result.replace(new RegExp(`(?<![\\p{L}\\p{N}_-])${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_-])`, 'giu'), maskedHost(host));
  }
  return result;
}

export function maskBrowserText(value, { full = false, maskHosts = false, knownHosts = [] } = {}) {
  if (typeof value !== 'string') return value;
  // Decode raw text once, before JSON serialization can introduce escapes.
  value = decodeSchemeEscapes(value);
  try { value = decodeURIComponent(value); } catch {}
  const maskText = (text) => {
    // Redact the complete JWT, including padding, before matching host names.
    const redacted = maskAppUuid(redactBrowserSecrets(text), { full });
    if (full) return redacted;
    const known = knownHosts.length ? maskKnownHosts(redacted, knownHosts) : redacted;
    if (!maskHosts) return known;
    return known.replace(HOST_TEXT_TOKEN, (token) => {
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
  return maskAppUuid(redactBrowserSecrets(output.join('')), { full });
}

// A command error keeps a plain file name, such as src/cli.js, intact. Mask the secrets, the app UUID forms,
// and the host inside a URL. A child command line ("Command failed: ...") can hold a bare host, so mask a
// bare host on that line only.
export function maskCliError(value, { full = false } = {}) {
  if (typeof value !== 'string') return value;
  if (full) return maskBrowserText(value, { full });
  return value.split('\n')
    .map((line) => maskBrowserText(line, { maskHosts: /Command failed:/.test(line) }))
    .join('\n');
}

export function maskUrl(value, { full = false } = {}) {
  if (typeof value !== 'string') return value;

  value = repairWebUrl(value);
  let parsed;
  try { parsed = new URL(value); }
  catch {
    let decoded = null;
    try { decoded = decodeURIComponent(value); } catch {}
    if (decoded !== null && decoded !== value) return maskUrl(decoded, { full });
    // An unparsable value keeps no query and no fragment, and masks each host-like token.
    return maskAppUuid(redactBrowserSecrets(maskHostTokens(value.split(/[?#]/, 1)[0], full)), { full });
  }

  if (parsed.protocol === 'data:' || parsed.protocol === 'javascript:') return '<redacted-url>';

  if (!MASKED_HOST_PROTOCOLS.has(parsed.protocol)) {
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return maskAppUuid(redactBrowserSecrets(parsed.href), { full });
  }

  const host = full || !parsed.hostname || isLoopback(parsed.hostname) ? parsed.hostname : maskedHost(parsed.hostname);
  const port = explicitPort(value) || (parsed.port ? `:${parsed.port}` : '');
  return maskAppUuid(redactBrowserSecrets(`${parsed.protocol}//${host}${port}${parsed.pathname}`), { full });
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

export function maskBrowserState(state, { full = false } = {}) {
  if (!state || typeof state !== 'object') return state;
  const result = { ...state };
  for (const key of ['managedBrowsers', 'browsers', 'events']) {
    if (Object.hasOwn(result, key)) result[key] = maskDeep(result[key], { full });
  }
  return result;
}
