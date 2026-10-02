import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// The data dir and HOME are temporary. The config module reads both when it loads.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-review-raw-data-'));
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-review-raw-home-'));
process.env.HOME = homeDir;
process.env.HERDR_BOSS_DIR = dataDir;
process.env.HERDR_BOSS_PORT = '0';

const [{ assertTempDataDir }, { serve }, { loadConfig }, store, { openSqliteStore }, { validatePack }, { createRawTokens, RAW_CSP, TOKEN_TTL_MS }] = await Promise.all([
  import('../src/data-dir-guard.js'),
  import('../src/server.js'),
  import('../src/config.js'),
  import('../src/review-store.js'),
  import('../src/sqlite-store.js'),
  import('../src/review-pack.js'),
  import('../src/review-raw.js'),
]);
assertTempDataDir(dataDir);

const roots = [dataDir, homeDir];
test.after(() => {
  openSqliteStore({ dir: dataDir }).close();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const EXPECTED_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self'; font-src 'self' data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

function png(tag) {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(40, 8);
  ihdr.writeUInt32BE(30, 12);
  ihdr[16] = 8; ihdr[17] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(16, tag)]);
}

const PAGE = '<!doctype html><html><head><title>Invented shop</title></head><body><h1 id="top">Shop</h1><img src="img/one.png" alt="One"><script>fetch("/api/state")</script></body></html>';
const OTHER = '<!doctype html><html><head><title>Second</title></head><body><h1>Second page</h1></body></html>';
const NOTES = 'Plain notes of the invented pack.\n';

function tmp(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

const slugOf = (id) => `s-${id}`;

// A pack with two page items, one image item, and one text file.
function publish(id, { page = PAGE } = {}) {
  const root = tmp('herdr-review-raw-pack-');
  const files = { 'site/index.html': page, 'site/other.html': OTHER, 'img/one.png': png(1), 'notes.txt': NOTES };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
    schema: 'herdr-boss.review-pack/1',
    id,
    title: 'Invented legacy pack',
    sections: [{ id: 'pages', title: 'Pages', items: [
      { id: 'home', title: 'Home page', type: 'page', src: 'site/index.html', ask: ['accept', 'deny', 'note'] },
      { id: 'other', title: 'Other page', type: 'page', src: 'site/other.html', ask: ['accept', 'deny', 'note'] },
      { id: 'one', title: 'One image', type: 'image', src: 'img/one.png', alt: 'One', ask: ['accept', 'deny', 'note'] },
      { id: 'notes', title: 'Notes', type: 'file', src: 'notes.txt', ask: ['note'] },
    ] }],
  }));
  const validation = validatePack(root, { allowPage: true });
  assert.ok(validation.ok, JSON.stringify(validation.errors));
  return store.publishVersion({ dir: dataDir, now: Date.now(), slug: slugOf(id), folder: root, publishedBy: 'orch', validation });
}

function raw(base, method, route, { headers = {}, body } = {}) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, path: route, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, bytes, text: bytes.toString('utf8') });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function start(t, { preview = false, rawTokens } = {}) {
  fs.mkdirSync(path.join(dataDir, 'projects'), { recursive: true });
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  const { server, close } = serve(cfg, {
    liveDataDir: process.env.HERDR_BOSS_DIR,
    readOnlyPreview: preview,
    rawTokens,
    createEngine: () => {
      const engine = new EventEmitter();
      engine.state = {};
      engine.tick = async () => engine.state;
      engine.log = () => {};
      return engine;
    },
  });
  t.after(async () => { await close(); });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return { base: `http://127.0.0.1:${server.address().port}`, cfg };
}

const JSON_HEADERS = { 'content-type': 'application/json' };
const REMOTE = { host: 'mac.tail0000.ts.net' };
const tokenRoute = (id) => `/api/reviews/${slugOf(id)}/${id}/raw-token`;

async function issue(base, id, query = '') {
  const response = await raw(base, 'POST', tokenRoute(id) + query, { headers: JSON_HEADERS, body: '{}' });
  assert.equal(response.status, 200, response.text);
  return JSON.parse(response.text);
}

// ---------- The token route ----------

test('the token route returns a token and an expiry for the current version', async (t) => {
  publish('tok-pack');
  let now = 5_000_000;
  const rawTokens = createRawTokens({ now: () => now });
  const { base } = await start(t, { rawTokens });
  const body = await issue(base, 'tok-pack');
  assert.match(body.token, /^[0-9a-f]{64}$/);
  assert.equal(body.expiresAt, now + TOKEN_TTL_MS);
  assert.deepEqual(Object.keys(body).sort(), ['expiresAt', 'token']);
  assert.deepEqual(rawTokens.lookup(body.token), { slug: 's-tok-pack', pack: 'tok-pack', version: 1 });
  const response = await raw(base, 'POST', tokenRoute('tok-pack'), { headers: JSON_HEADERS, body: '{}' });
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('the token route refuses an unknown pack, a bad version, other methods, a cross-site request, and a missing login', async (t) => {
  publish('tok-refuse');
  const { base } = await start(t);
  assert.equal((await raw(base, 'POST', '/api/reviews/s-none/none/raw-token', { headers: JSON_HEADERS, body: '{}' })).status, 404);
  assert.equal((await raw(base, 'POST', `${tokenRoute('tok-refuse')}?version=9`, { headers: JSON_HEADERS, body: '{}' })).status, 404);
  assert.equal((await raw(base, 'POST', `${tokenRoute('tok-refuse')}?version=abc`, { headers: JSON_HEADERS, body: '{}' })).status, 400);
  assert.equal((await raw(base, 'POST', `${tokenRoute('tok-refuse')}?version=1`, { headers: JSON_HEADERS, body: '{}' })).status, 200);
  assert.equal((await raw(base, 'GET', tokenRoute('tok-refuse'))).status, 405);
  assert.equal((await raw(base, 'PUT', tokenRoute('tok-refuse'), { headers: JSON_HEADERS, body: '{}' })).status, 405);
  assert.equal((await raw(base, 'POST', tokenRoute('tok-refuse'), { headers: { ...JSON_HEADERS, 'sec-fetch-site': 'cross-site' }, body: '{}' })).status, 403);
  assert.equal((await raw(base, 'POST', tokenRoute('tok-refuse'), { headers: { ...JSON_HEADERS, origin: 'http://evil.example' }, body: '{}' })).status, 403);
  assert.equal((await raw(base, 'POST', tokenRoute('tok-refuse'), { headers: { ...JSON_HEADERS, origin: 'null' }, body: '{}' })).status, 403);
  const anonymous = await raw(base, 'POST', tokenRoute('tok-refuse'), { headers: { ...REMOTE, ...JSON_HEADERS }, body: '{}' });
  assert.equal(anonymous.status, 401);
  assert.ok(!/"token"/.test(anonymous.text), 'a refused request gets no token');
});

test('the token route is refused in the read-only preview', async (t) => {
  publish('tok-preview');
  const { base } = await start(t, { preview: true });
  const response = await raw(base, 'POST', tokenRoute('tok-preview'), { headers: JSON_HEADERS, body: '{}' });
  assert.equal(response.status, 403);
  assert.ok(!/"token"/.test(response.text));
});

test('a token names the version that the caller asks for', async (t) => {
  publish('tok-version');
  const rawTokens = createRawTokens();
  const { base } = await start(t, { rawTokens });
  const { token } = await issue(base, 'tok-version', '?version=1');
  assert.equal(rawTokens.lookup(token).version, 1);
});

// ---------- The raw route ----------

test('the raw route serves a page with the exact CSP, no frame header, and the bridge tag once', async (t) => {
  publish('raw-page');
  const { base } = await start(t);
  const { token } = await issue(base, 'raw-page');
  const page = await raw(base, 'GET', `/review-raw/${token}/site/index.html`);
  assert.equal(page.status, 200);
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(page.headers['content-security-policy'], EXPECTED_CSP);
  assert.equal(RAW_CSP, EXPECTED_CSP);
  assert.equal(page.headers['x-frame-options'], undefined, 'the frame needs no X-Frame-Options');
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.equal(page.headers['cache-control'], 'no-store');
  const tag = `<script src="/review-raw/${token}/__hb-bridge.js"></script>`;
  assert.equal(page.text, PAGE.replace('</body>', `${tag}</body>`), 'the tag sits before </body>');
  assert.equal(page.text.split(tag).length - 1, 1, 'one bridge tag');
  assert.equal(page.headers['content-length'], String(page.bytes.length));
});

test('the raw route does not append the bridge to other files and sets the same headers', async (t) => {
  publish('raw-image');
  const { base } = await start(t);
  const { token } = await issue(base, 'raw-image');
  const image = await raw(base, 'GET', `/review-raw/${token}/img/one.png`);
  assert.equal(image.status, 200);
  assert.equal(image.headers['content-type'], 'image/png');
  assert.deepEqual(image.bytes, png(1));
  assert.equal(image.headers['content-security-policy'], EXPECTED_CSP);
  assert.equal(image.headers['x-frame-options'], undefined);
  const text = await raw(base, 'GET', `/review-raw/${token}/notes.txt`);
  assert.equal(text.status, 200);
  assert.equal(text.text, NOTES);
  assert.match(text.headers['content-type'], /^text\/plain/);
  assert.ok(!text.text.includes('__hb-bridge'));
  const head = await raw(base, 'HEAD', `/review-raw/${token}/site/index.html`);
  assert.equal(head.status, 200);
  assert.equal(head.bytes.length, 0);
  assert.equal(head.headers['content-security-policy'], EXPECTED_CSP);
  assert.equal(head.headers['content-length'], String((await raw(base, 'GET', `/review-raw/${token}/site/index.html`)).bytes.length), 'HEAD reports the length with the bridge tag');
});

test('the bridge path serves public/review-bridge.js with the same headers', async (t) => {
  publish('raw-bridge');
  const { base } = await start(t);
  const { token } = await issue(base, 'raw-bridge');
  const bridge = await raw(base, 'GET', `/review-raw/${token}/__hb-bridge.js`);
  assert.equal(bridge.status, 200);
  assert.equal(bridge.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(bridge.headers['content-security-policy'], EXPECTED_CSP);
  assert.equal(bridge.headers['x-frame-options'], undefined);
  assert.equal(bridge.headers['x-content-type-options'], 'nosniff');
  assert.equal(bridge.headers['referrer-policy'], 'no-referrer');
  assert.equal(bridge.headers['cache-control'], 'no-store');
  assert.equal(bridge.text, fs.readFileSync(new URL('../public/review-bridge.js', import.meta.url), 'utf8'));
  assert.equal((await raw(base, 'GET', '/review-raw/0000/__hb-bridge.js')).status, 404, 'the bridge also needs a token');
  assert.equal((await raw(base, 'POST', `/review-raw/${token}/__hb-bridge.js`)).status, 405);
});

test('each refusal has the same 404 body and reveals nothing', async (t) => {
  publish('raw-refuse');
  publish('raw-other');
  let now = 10_000_000;
  const rawTokens = createRawTokens({ now: () => now });
  const { base } = await start(t, { rawTokens });
  const { token } = await issue(base, 'raw-refuse');
  const expired = await issue(base, 'raw-refuse');
  const good = await raw(base, 'GET', `/review-raw/${token}/site/index.html`);
  assert.equal(good.status, 200);
  now += TOKEN_TTL_MS;
  const fresh = await issue(base, 'raw-refuse');
  assert.equal((await raw(base, 'GET', `/review-raw/${expired.token}/site/index.html`)).status, 404, 'an expired token');

  const missing = await raw(base, 'GET', `/review-raw/${fresh.token}/site/none.html`);
  assert.equal(missing.status, 404);
  const cases = {
    unknown: `/review-raw/${'a'.repeat(64)}/site/index.html`,
    badToken: '/review-raw/not-a-token/site/index.html',
    expired: `/review-raw/${expired.token}/site/index.html`,
    missing: `/review-raw/${fresh.token}/site/none.html`,
    noPath: `/review-raw/${fresh.token}`,
    noPathSlash: `/review-raw/${fresh.token}/`,
    traversal: `/review-raw/${fresh.token}/../manifest.json`,
    encodedTraversal: `/review-raw/${fresh.token}/%2e%2e/manifest.json`,
    doubleEncoded: `/review-raw/${fresh.token}/%252e%252e/manifest.json`,
    backslash: `/review-raw/${fresh.token}/site%5c..%5cmanifest.json`,
    nul: `/review-raw/${fresh.token}/site/index.html%00.png`,
    badEscape: `/review-raw/${fresh.token}/%zz`,
    manifest: `/review-raw/${fresh.token}/manifest.json`,
  };
  for (const [name, route] of Object.entries(cases)) {
    const response = await raw(base, 'GET', route);
    assert.equal(response.status, 404, name);
    assert.equal(response.text, missing.text, `${name}: the same body`);
    assert.equal(response.headers['content-type'], missing.headers['content-type'], `${name}: the same type`);
    assert.equal(response.headers['x-frame-options'], undefined);
    assert.ok(!response.text.includes(dataDir));
  }
});

test('a token of one pack version does not open another pack or another version', async (t) => {
  publish('raw-a');
  publish('raw-b');
  const rawTokens = createRawTokens();
  const { base } = await start(t, { rawTokens });
  const { token } = await issue(base, 'raw-a');
  assert.equal((await raw(base, 'GET', `/review-raw/${token}/site/index.html`)).status, 200);
  assert.deepEqual(rawTokens.lookup(token), { slug: 's-raw-a', pack: 'raw-a', version: 1 });
  // A second version of pack A has other content. The token still names version 1.
  const root = tmp('herdr-review-raw-v2-');
  fs.mkdirSync(path.join(root, 'site'), { recursive: true });
  fs.writeFileSync(path.join(root, 'site/index.html'), OTHER);
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
    schema: 'herdr-boss.review-pack/1', id: 'raw-a', title: 'Invented legacy pack',
    sections: [{ id: 'pages', title: 'Pages', items: [{ id: 'home', title: 'Home page', type: 'page', src: 'site/index.html', ask: ['accept', 'deny', 'note'] }] }],
  }));
  store.publishVersion({ dir: dataDir, now: Date.now(), slug: 's-raw-a', folder: root, publishedBy: 'orch', validation: validatePack(root, { allowPage: true }) });
  const old = await raw(base, 'GET', `/review-raw/${token}/site/index.html`);
  assert.ok(old.text.includes('Invented shop'), 'the token still serves version 1');
  assert.ok(!old.text.includes('Second page'));
  assert.equal((await raw(base, 'GET', `/review-raw/${token}/img/one.png`)).status, 200, 'version 1 still has its image');
  const next = await issue(base, 'raw-a');
  assert.equal(rawTokens.lookup(next.token).version, 2);
  const current = await raw(base, 'GET', `/review-raw/${next.token}/site/index.html`);
  assert.ok(current.text.includes('Second page'));
  assert.equal((await raw(base, 'GET', `/review-raw/${next.token}/img/one.png`)).status, 404, 'version 2 has no image');
  const b = await issue(base, 'raw-b');
  assert.ok((await raw(base, 'GET', `/review-raw/${b.token}/site/index.html`)).text.includes('Invented shop'));
  // A file name of another pack is not a file of this token.
  assert.equal((await raw(base, 'GET', `/review-raw/${b.token}/../../raw-a/v1/site/index.html`)).status, 404);
});

test('the raw route refuses each method except GET and HEAD with 405, and a wrong Host header', async (t) => {
  publish('raw-method');
  const { base } = await start(t);
  const { token } = await issue(base, 'raw-method');
  const route = `/review-raw/${token}/site/index.html`;
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const response = await raw(base, method, route, method === 'POST' || method === 'PUT' ? { headers: JSON_HEADERS, body: '{}' } : {});
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.allow, 'GET, HEAD');
    assert.equal(response.headers['x-frame-options'], undefined);
    assert.ok(!response.text.includes('Invented shop'));
  }
  for (const host of ['evil.example', 'evil.example:80', '127.0.0.1.evil.example', 'mac.tail0000.ts.net.evil.example']) {
    const response = await raw(base, 'GET', route, { headers: { host } });
    assert.equal(response.status, 404, `host ${host}`);
    assert.ok(!response.text.includes('Invented shop'));
  }
  const tailnet = await raw(base, 'GET', route, { headers: REMOTE });
  assert.equal(tailnet.status, 200, 'a Tailscale host name passes the host list');
});

test('the raw route needs no cookie and takes a cross-site request with an opaque origin', async (t) => {
  publish('raw-origin');
  const { base, cfg } = await start(t);
  const { token } = await issue(base, 'raw-origin');
  const route = `/review-raw/${token}/img/one.png`;
  const frame = await raw(base, 'GET', route, { headers: { origin: 'null', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' } });
  assert.equal(frame.status, 200);
  const remote = await raw(base, 'GET', route, { headers: { ...REMOTE, 'sec-fetch-site': 'cross-site' } });
  assert.equal(remote.status, 200, 'the token is the credential');
  // The dashboard routes still need the cookie on a remote host.
  assert.equal((await raw(base, 'GET', '/api/reviews', { headers: REMOTE })).status, 401);
  assert.ok(fs.existsSync(cfg.access.tokenFile));
});

test('the raw route refuses a symbolic link and a file outside the version folder', async (t) => {
  publish('raw-link');
  const { base } = await start(t);
  const { token } = await issue(base, 'raw-link');
  const folder = store.packDirectory(dataDir, 's-raw-link', 'raw-link', 1);
  const target = path.join(folder, 'img', 'one.png');
  const outside = tmp('herdr-review-raw-outside-');
  fs.writeFileSync(path.join(outside, 'secret.png'), png(9));
  assert.equal((await raw(base, 'GET', `/review-raw/${token}/img/one.png`)).status, 200);
  fs.rmSync(target);
  fs.symlinkSync(path.join(outside, 'secret.png'), target);
  const linked = await raw(base, 'GET', `/review-raw/${token}/img/one.png`);
  assert.equal(linked.status, 404, 'a symbolic link to a file outside');
  assert.ok(!linked.bytes.equals(png(9)));
  fs.rmSync(target);
  fs.symlinkSync(path.join(folder, 'notes.txt'), target);
  assert.equal((await raw(base, 'GET', `/review-raw/${token}/img/one.png`)).status, 404, 'a symbolic link inside the folder');
  fs.rmSync(target);
  const dir = path.join(folder, 'site');
  fs.renameSync(dir, `${dir}-real`);
  fs.symlinkSync(outside, dir);
  assert.equal((await raw(base, 'GET', `/review-raw/${token}/site/index.html`)).status, 404, 'a folder link to the outside');
});

test('the raw route runs in the read-only preview only for a token that exists', async (t) => {
  publish('raw-preview');
  const rawTokens = createRawTokens();
  const { token } = rawTokens.issue({ slug: 's-raw-preview', pack: 'raw-preview', version: 1 });
  const { base } = await start(t, { preview: true, rawTokens });
  assert.equal((await raw(base, 'GET', `/review-raw/${token}/site/index.html`)).status, 200);
  assert.equal((await raw(base, 'POST', `/review-raw/${token}/site/index.html`)).status, 405);
  assert.equal((await raw(base, 'GET', `/review-raw/${'b'.repeat(64)}/site/index.html`)).status, 404);
});

test('the store keeps at most the cap of live tokens across requests', async (t) => {
  publish('raw-cap');
  const rawTokens = createRawTokens({ max: 3 });
  const { base } = await start(t, { rawTokens });
  const tokens = [];
  for (let index = 0; index < 5; index += 1) tokens.push((await issue(base, 'raw-cap')).token);
  assert.equal(rawTokens.size(), 3);
  assert.equal((await raw(base, 'GET', `/review-raw/${tokens[0]}/site/index.html`)).status, 404, 'the oldest token gave way');
  assert.equal((await raw(base, 'GET', `/review-raw/${tokens[4]}/site/index.html`)).status, 200);
});

test('the bridge tag goes before the last </body> in any case, else at the end', async (t) => {
  const pages = {
    'raw-body-upper': '<!doctype html><HTML><BODY><p>Upper</p></BODY></HTML>',
    'raw-body-two': '<!doctype html><html><body><script>var a = "</body>";</script><p>Two</p></body></html>',
    'raw-body-open': '<!doctype html><html><body><script>var a = 1;',
  };
  const { base } = await start(t);
  for (const [id, page] of Object.entries(pages)) {
    publish(id, { page });
    const { token } = await issue(base, id);
    const tag = `<script src="/review-raw/${token}/__hb-bridge.js"></script>`;
    const body = (await raw(base, 'GET', `/review-raw/${token}/site/index.html`)).text;
    assert.equal(body.split(tag).length - 1, 1, `${id}: one tag`);
    if (id === 'raw-body-upper') assert.equal(body, page.replace('</BODY>', `${tag}</BODY>`));
    if (id === 'raw-body-two') assert.equal(body, page.replace(/<\/body><\/html>$/, `${tag}</body></html>`), 'before the last </body>');
    if (id === 'raw-body-open') assert.equal(body, page + tag, 'a page that ends in an open script gets the tag at the end');
  }
});

test('the store refuses a pin text or anchor that looks like a secret', () => {
  publish('raw-pin');
  const put = (pin) => store.putAnswer({ dir: dataDir, now: Date.now(), slug: 's-raw-pin', pack: 'raw-pin', item: 'home', patch: { rev: 0, pins: [{ n: 1, x: 0.5, y: 0.5, ...pin }] } });
  assert.throws(() => put({ text: 'Bearer abcdef123456' }), /secret/);
  assert.throws(() => put({ anchor: 'token: abc' }), /secret/);
  assert.ok(put({ text: 'The heading', anchor: 'top' }).answer);
});
