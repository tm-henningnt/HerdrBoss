import assert from 'node:assert/strict';
import test from 'node:test';
import { maskDeep, maskUrl } from '../src/browser-url-mask.js';

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
  assert.equal(maskUrl('ftp://user:pass@files.example.com/path'), 'ftp://files.example.com/path');
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
