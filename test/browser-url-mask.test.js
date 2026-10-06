import assert from 'node:assert/strict';
import test from 'node:test';
import { maskBrowserText, maskDeep, maskUrl, repairWebUrl } from '../src/browser-url-mask.js';

test('browser masking is safe to repeat on API and engine output', () => {
  const input = { title: 'tenant1.example.test', bookmark: { name: 'Open tenant1.example.test', url: 'https://tenant1.example.test/callback?code=AAAAfakecode' } };
  const masked = maskDeep(input);
  assert.equal(masked.title, '<tenant>.example.test');
  assert.deepEqual(maskDeep(masked), masked);
});

test('maskUrl keeps the scheme, remaining host, port, and path for outside hosts', () => {
  assert.equal(maskUrl('https://acme.example.com:8443/a/b?x=1#y'), 'https://<tenant>.example.com:8443/a/b');
  assert.equal(maskUrl('http://intranet:8080/home?x=1#y'), 'http://<tenant>:8080/home');
  assert.equal(maskUrl('wss://acme.example.com:9443/socket?token=one#debug'), 'wss://<tenant>.example.com:9443/socket');
});

test('maskUrl keeps loopback hosts and removes credentials, queries, and fragments', () => {
  assert.equal(maskUrl('http://user:pass@localhost:8080/a?x=1#y'), 'http://localhost:8080/a');
  assert.equal(maskUrl('http://user:pass@127.24.2.9:8080/a?x=1#y'), 'http://127.24.2.9:8080/a');
  assert.equal(maskUrl('http://[::1]:8080/a?x=1#y'), 'http://[::1]:8080/a');
});

test('maskUrl masks outside IP addresses and removes credentials from every URL', () => {
  assert.equal(maskUrl('https://192.0.2.9:8443/a?x=1#y'), 'https://<ip>:8443/a');
  assert.equal(maskUrl('https://user:pass@acme.example.com/a?x=1#y'), 'https://<tenant>.example.com/a');
  assert.equal(maskUrl('ftp://user:pass@files.example.com/path'), 'ftp://<tenant>.example.com/path');
});

test('maskUrl keeps non-web browser URLs and redacts active or embedded content', () => {
  assert.equal(maskUrl('about:blank'), 'about:blank');
  assert.equal(maskUrl('chrome://newtab/'), 'chrome://newtab/');
  assert.equal(maskUrl(''), '');
  assert.equal(maskUrl('data:text/html,secret'), '<redacted-url>');
  assert.equal(maskUrl('javascript:alert(1)'), '<redacted-url>');
});

test('maskUrl full mode keeps hosts but removes credentials, queries, and fragments', () => {
  const value = 'https://user:pass@acme.example.com/a?x=1#y';
  assert.equal(maskUrl(value, { full: true }), 'https://acme.example.com/a');
});

test('maskDeep masks nested URLs, returns new values, and leaves input unchanged', () => {
  const input = {
    tabs: [
      { url: 'https://acme.example.com:8443/a?x=1#y', title: 'Example' },
      { url: 'http://localhost:8080/a?x=1#y' },
      { websocket: 'wss://acme.example.com/socket?token=one' },
    ],
    start: 'https://intranet/start?private=yes',
    startUrl: 'about:blank',
    nested: { webSocketDebuggerUrl: 'ws://dev.example.net:9222/devtools/browser/1?secret=yes' },
    ordinary: 'https://other.example.org/path?q=1#frag',
    data: 'data:text/plain,private',
  };
  const before = structuredClone(input);
  const result = maskDeep(input);

  assert.deepEqual(result, {
    tabs: [
      { url: 'https://<tenant>.example.com:8443/a', title: 'Example' },
      { url: 'http://localhost:8080/a' },
      { websocket: 'wss://<tenant>.example.com/socket' },
    ],
    start: 'https://<tenant>/start',
    startUrl: 'about:blank',
    nested: { webSocketDebuggerUrl: 'ws://<tenant>.example.net:9222/devtools/browser/1' },
    ordinary: 'https://<tenant>.example.org/path',
    data: '<redacted-url>',
  });
  assert.notStrictEqual(result, input);
  assert.notStrictEqual(result.tabs, input.tabs);
  assert.notStrictEqual(result.tabs[0], input.tabs[0]);
  assert.deepEqual(input, before);
  assert.equal(maskDeep(input, { full: true }).tabs[0].url, 'https://acme.example.com:8443/a');
});

test('maskUrl masks the host of a URL with a repeated or malformed scheme', () => {
  for (const input of [
    'https://https://tenant1.example.test/a/b',
    'https:/tenant1.example.test/a/b',
    'tenant1.example.test/a/b',
    'http:https://tenant1.example.test/a/b',
    'tenant1.example.test:8443/a/b',
  ]) {
    const output = maskUrl(input);
    assert.ok(!output.includes('tenant1'), `${input} leaked: ${output}`);
    assert.ok(output.includes('<tenant>'), `${input} not masked: ${output}`);
  }
});

test('maskBrowserText masks the host of a malformed URL inside free text', () => {
  for (const input of [
    'bad https://https://tenant1.example.test/x end',
    'bad https:/tenant1.example.test/x end',
    'bad http:https://tenant1.example.test/x end',
  ]) {
    const output = maskBrowserText(input);
    assert.ok(!output.includes('tenant1'), `${input} leaked: ${output}`);
  }
});

test('maskBrowserText masks a stored host and keeps the credential filter', () => {
  const output = maskBrowserText('see tenant1.example.test code=abc123', { knownHosts: ['tenant1.example.test'] });
  assert.ok(!output.includes('tenant1'));
  assert.ok(!output.includes('abc123'));
  assert.equal(maskBrowserText('plain words here', { knownHosts: ['tenant1.example.test'] }), 'plain words here');
});

test('maskDeep masks a stored host in a URL field of a bookmark', () => {
  const masked = maskDeep({ url: 'https://https://tenant1.example.test/a' });
  assert.ok(!JSON.stringify(masked).includes('tenant1'));
});

const LEAK_FORMS = [
  'https:/ /tenant1.example.test/a',
  'https:// tenant1.example.test/a',
  'https: //tenant1.example.test/a',
  'https://\ntenant1.example.test/a',
  'https:\\\\tenant1.example.test\\a',
  'https:\\tenant1.example.test',
  'https:tenant1.example.test/a',
  'http:tenant1.example.test',
  '//tenant1.example.test/a',
  'ftp://tenant1.example.test/a',
  'file://tenant1.example.test/x',
  'ftp://https://tenant1.example.test',
  'https%253A%252F%252Ftenant1.example.test',
  'https%3A%2F%2Ftenant1.example.test',
  'https%253A%252F%252Fhttps%253A%252F%252Ftenant1.example.test',
];

test('maskBrowserText masks the host of every repaired scheme form', () => {
  for (const form of LEAK_FORMS) {
    const output = maskBrowserText(`see ${form} end`);
    assert.ok(!output.includes('tenant1'), `${JSON.stringify(form)} leaked: ${output}`);
  }
});

test('maskUrl masks the host of every repaired scheme form', () => {
  for (const form of LEAK_FORMS) {
    const output = maskUrl(form);
    assert.ok(!output.includes('tenant1'), `${JSON.stringify(form)} leaked: ${output}`);
  }
});

test('maskUrl decodes and unwraps a URL field before it masks', () => {
  for (const form of [
    'https%3A%2F%2Ftenant1.example.test%2Fa',
    'https://tenant1.example.test%2fpath',
    'https://tenant1.example.test%0a',
    '"https://https://tenant1.example.test/a",',
    '<https:/tenant1.example.test/a>',
  ]) {
    const output = maskUrl(form);
    assert.ok(!output.includes('tenant1'), `${JSON.stringify(form)} leaked: ${output}`);
  }
});

test('maskBrowserText keeps prose, file paths, and loopback readable', () => {
  assert.equal(maskBrowserText('Use https: for the link and file: for paths.'), 'Use https: for the link and file: for paths.');
  assert.equal(maskBrowserText('open file:///tmp/a.txt now'), 'open file:///tmp/a.txt now');
  assert.equal(maskBrowserText('a // comment and src//x.js'), 'a // comment and src//x.js');
  assert.equal(maskUrl('http://localhost:4477/x'), 'http://localhost:4477/x');
});

test('a known host also matches its punycode and Unicode forms', () => {
  const unicode = maskBrowserText('x xn--bcher-kva.example.test y', { knownHosts: ['bücher.example.test'] });
  assert.ok(!unicode.includes('bcher'), unicode);
  const ascii = maskBrowserText('x bücher.example.test y', { knownHosts: ['xn--bcher-kva.example.test'] });
  assert.ok(!ascii.includes('cher.example'), ascii);
});

test('repairWebUrl gives the real host of a legacy stored URL', () => {
  assert.equal(new URL(repairWebUrl('https://https://tenant2.example.test/old')).hostname, 'tenant2.example.test');
});
