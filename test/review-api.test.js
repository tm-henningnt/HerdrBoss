import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// The data dir and HOME are temporary. The config module reads both when it loads.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-review-api-data-'));
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-review-api-home-'));
process.env.HOME = homeDir;
process.env.HERDR_BOSS_DIR = dataDir;
process.env.HERDR_BOSS_PORT = '0';

// Import after the environment is set: the config module reads HERDR_BOSS_DIR and HOME when it loads.
const [{ assertTempDataDir }, { serve }, { loadConfig }, store, { openSqliteStore }, messages, { createRateLimit }] = await Promise.all([
  import('../src/data-dir-guard.js'),
  import('../src/server.js'),
  import('../src/config.js'),
  import('../src/review-store.js'),
  import('../src/sqlite-store.js'),
  import('../src/messages.js'),
  import('../src/review-api.js'),
]);
assertTempDataDir(dataDir);

const roots = [dataDir, homeDir];
test.after(() => {
  openSqliteStore({ dir: dataDir }).close();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function tmp(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function png(width, height, tag = 0) {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; ihdr[17] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(16, tag)]);
}

// An MP4 header with a known body, so a range test compares bytes.
const VIDEO = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42', 'latin1'), Buffer.from(Array.from({ length: 3000 }, (_, index) => index % 251))]);
const CSV = 'code,message\ndeclined,The card was declined.\nexpired,The card has expired.\n';
const CANARY = 'CANARY-OUTSIDE-THE-PACK';

function manifest(id) {
  return {
    schema: 'herdr-boss.review-pack/1',
    id,
    title: 'Checkout flow redesign',
    sections: [
      { id: 'cart', title: 'Cart', items: [
        // The dark image has no extension. The server decides its type from the bytes.
        { id: 'cart-themes', title: 'Cart, light and dark', type: 'image-pair', variant: 'theme',
          a: { src: 'img/cart-light.png', label: 'Light' }, b: { src: 'img/cart-dark', label: 'Dark' }, ask: ['accept', 'deny', 'note'] },
        { id: 'pay-button', title: 'Pay button position', type: 'image-pair', variant: 'before-after',
          a: { src: 'img/pay-before.png', label: 'Before' }, b: { src: 'img/pay-after.png', label: 'After' },
          ask: ['choice', 'note'], choices: [{ id: 'a', label: 'Keep before' }, { id: 'b', label: 'Use after' }] },
        { id: 'flow-video', title: 'Full checkout', type: 'video', src: 'media/checkout.mp4', ask: ['accept', 'deny', 'live'] },
      ] },
      { id: 'errors', title: 'Error handling', items: [
        { id: 'error-copy', title: 'Error messages', type: 'table', src: 'data/errors.csv', ask: ['accept', 'deny', 'note'] },
        { id: 'release-notes', title: 'Release notes', type: 'markdown', text: 'Notes for the release.', ask: ['note'] },
      ] },
    ],
  };
}

// Each pack has its own project slug: a project holds at most 5 open packs.
const slugOf = (id) => `s-${id}`;

function publish(id, edit = () => {}) {
  const packManifest = manifest(id);
  edit(packManifest);
  const root = tmp('herdr-review-api-pack-');
  const files = {
    'img/cart-light.png': png(390, 800, 1),
    'img/cart-dark': png(390, 800, 2),
    'img/pay-before.png': png(390, 800, 3),
    'img/pay-after.png': png(390, 800, 4),
    'media/checkout.mp4': VIDEO,
    'data/errors.csv': CSV,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(packManifest));
  return store.publishVersion({ dir: dataDir, now: Date.now(), slug: slugOf(id), folder: root, publishedBy: 'orch' });
}

const packState = (id) => store.getPack({ dir: dataDir, slug: slugOf(id), pack: id });
const answerOf = (id, item) => packState(id).items.find((entry) => entry.id === item).answer;

// One raw request. The path goes to the server as written, so an encoded traversal reaches it unchanged.
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

const JSON_HEADERS = { 'content-type': 'application/json' };
const json = (value) => JSON.stringify(value);

async function start(t, { preview = false } = {}) {
  fs.mkdirSync(path.join(dataDir, 'projects'), { recursive: true });
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  let engine;
  const { server, close } = serve(cfg, {
    liveDataDir: process.env.HERDR_BOSS_DIR,
    readOnlyPreview: preview,
    createEngine: () => {
      engine = new EventEmitter();
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
  return { base: `http://127.0.0.1:${server.address().port}`, cfg, engine };
}

const REMOTE = { host: 'mac.tail0000.ts.net' };

// ---------- Read routes ----------

test('the list route returns the packs with counts and refuses an unknown state', async (t) => {
  publish('list-pack');
  const { base } = await start(t);
  const open = await raw(base, 'GET', '/api/reviews');
  assert.equal(open.status, 200);
  const list = JSON.parse(open.text);
  const entry = list.find((item) => item.pack === 'list-pack');
  assert.equal(entry.slug, 's-list-pack');
  assert.equal(entry.state, 'open');
  assert.equal(entry.counts.items, 5);
  assert.equal(entry.counts.open, 5);
  const done = JSON.parse((await raw(base, 'GET', '/api/reviews?state=done')).text);
  assert.ok(!done.some((item) => item.pack === 'list-pack'), 'an open pack is not in the done list');
  const bad = await raw(base, 'GET', '/api/reviews?state=everything');
  assert.equal(bad.status, 400);
  assert.match(JSON.parse(bad.text).error, /open or done/);
});

test('the get route returns the current version, an older version, and clear errors', async (t) => {
  publish('get-pack');
  const { base } = await start(t);
  const current = await raw(base, 'GET', '/api/reviews/s-get-pack/get-pack');
  assert.equal(current.status, 200);
  const pack = JSON.parse(current.text);
  assert.equal(pack.pack, 'get-pack');
  assert.equal(pack.version, 1);
  assert.equal(pack.items.length, 5);
  assert.equal(pack.derived.counts.open, 5);
  assert.ok(!current.text.includes(dataDir), 'the response holds no path of the data dir');
  assert.equal((await raw(base, 'GET', '/api/reviews/s-get-pack/get-pack?version=1')).status, 200);
  assert.equal((await raw(base, 'GET', '/api/reviews/s-get-pack/get-pack?version=9')).status, 404);
  assert.equal((await raw(base, 'GET', '/api/reviews/s-get-pack/get-pack?version=abc')).status, 400);
  assert.equal((await raw(base, 'GET', '/api/reviews/s-no-such-pack/no-such-pack')).status, 404);
  assert.equal((await raw(base, 'GET', '/api/reviews/Not_A_Slug/get-pack')).status, 400);
  assert.equal((await raw(base, 'GET', '/api/reviews/s-get-pack/get-pack/unknown-part')).status, 404);
});

test('the get route exposes review guidance and a computed review summary', async (t) => {
  publish('summary-pack', (pack) => {
    pack.designPass = { reviewer: 'gpt-6.1-sol', result: 'issues', note: 'One flow needs work.' };
    const items = pack.sections.flatMap((section) => section.items);
    const shared = {
      description: 'The checkout step.\nWhy it matters.',
      steps: ['Open the test app.', 'Submit a valid card.'],
      expected: 'The receipt appears.',
      link: 'https://app.example.test/checkout',
    };
    Object.assign(items[0], shared, { verifiedBy: 'agent-verified', evidence: ['img/cart-light.png'] });
    Object.assign(items[1], shared, { verifiedBy: 'needs-you' });
  });
  const { base } = await start(t);
  const response = await raw(base, 'GET', '/api/reviews/s-summary-pack/summary-pack');
  assert.equal(response.status, 200);
  const pack = JSON.parse(response.text);
  assert.deepEqual(pack.summary, { total: 5, agentVerified: 1, needsYou: 1, unmarked: 3, designPass: 'issues' });
  const agentItem = pack.items.find((item) => item.id === 'cart-themes');
  assert.equal(agentItem.description, 'The checkout step.\nWhy it matters.');
  assert.deepEqual(agentItem.steps, ['Open the test app.', 'Submit a valid card.']);
  assert.equal(agentItem.expected, 'The receipt appears.');
  assert.equal(agentItem.link, 'https://app.example.test/checkout');
  assert.equal(agentItem.verifiedBy, 'agent-verified');
  assert.deepEqual(agentItem.evidence, ['img/cart-light.png']);
  assert.equal(pack.items.find((item) => item.id === 'pay-button').verifiedBy, 'needs-you');
});

// ---------- File route ----------

test('a file has its content type from the stored bytes, never from the name', async (t) => {
  publish('type-pack');
  const { base } = await start(t);
  const file = (rel) => raw(base, 'GET', `/api/reviews/s-type-pack/type-pack/files/1/${rel}`);
  const light = await file('img/cart-light.png');
  assert.equal(light.status, 200);
  assert.equal(light.headers['content-type'], 'image/png');
  assert.deepEqual(light.bytes, png(390, 800, 1));
  const dark = await file('img/cart-dark');
  assert.equal(dark.headers['content-type'], 'image/png', 'a PNG with no extension is still a PNG');
  const csv = await file('data/errors.csv');
  assert.equal(csv.headers['content-type'], 'text/plain; charset=utf-8', 'a text file is served as plain text');
  assert.equal(csv.text, CSV);
  const video = await file('media/checkout.mp4');
  assert.equal(video.headers['content-type'], 'video/mp4');
});

test('a stored file that changed into SVG or HTML is never served with its own type', async (t) => {
  publish('tamper-pack');
  const { base } = await start(t);
  const target = path.join(store.packDirectory(dataDir, 's-tamper-pack', 'tamper-pack', 1), 'img', 'cart-light.png');
  const size = fs.statSync(target).size;
  fs.writeFileSync(target, Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>`.padEnd(size, ' ')));
  const response = await raw(base, 'GET', '/api/reviews/s-tamper-pack/tamper-pack/files/1/img/cart-light.png');
  assert.ok([415, 500].includes(response.status), `status ${response.status}`);
  assert.doesNotMatch(String(response.headers['content-type']), /svg|html/);
  assert.ok(!response.text.includes('<script>'));
});

test('a file response has the security, cache, and range headers', async (t) => {
  const published = publish('header-pack');
  const { base } = await start(t);
  const sha = store.getPack({ dir: dataDir, slug: 's-header-pack', pack: 'header-pack' }).files.find((entry) => entry.path === 'img/cart-light.png').sha256;
  assert.equal(published.version, 1);
  const image = await raw(base, 'GET', '/api/reviews/s-header-pack/header-pack/files/1/img/cart-light.png');
  assert.equal(image.headers['x-content-type-options'], 'nosniff');
  assert.equal(image.headers['content-security-policy'], "default-src 'none'; sandbox");
  assert.equal(image.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(image.headers['content-disposition'], 'inline');
  assert.equal(image.headers.etag, `"${sha}"`);
  assert.match(image.headers['cache-control'], /private/);
  assert.doesNotMatch(image.headers['cache-control'], /no-store/);
  assert.equal(image.headers['content-length'], String(png(390, 800, 1).length));
  assert.equal(image.headers['accept-ranges'], undefined, 'an image has no ranges');

  const same = await raw(base, 'GET', '/api/reviews/s-header-pack/header-pack/files/1/img/cart-light.png', { headers: { 'if-none-match': `"${sha}"` } });
  assert.equal(same.status, 304);
  assert.equal(same.bytes.length, 0);
  assert.equal(same.headers.etag, `"${sha}"`);
  const other = await raw(base, 'GET', '/api/reviews/s-header-pack/header-pack/files/1/img/cart-light.png', { headers: { 'if-none-match': '"0000"' } });
  assert.equal(other.status, 200);

  const head = await raw(base, 'HEAD', '/api/reviews/s-header-pack/header-pack/files/1/img/cart-light.png');
  assert.equal(head.status, 200);
  assert.equal(head.bytes.length, 0);
  assert.equal(head.headers['content-length'], String(png(390, 800, 1).length));

  const video = await raw(base, 'GET', '/api/reviews/s-header-pack/header-pack/files/1/media/checkout.mp4');
  assert.equal(video.headers['accept-ranges'], 'bytes');
  assert.equal(video.headers['content-security-policy'], "default-src 'none'; sandbox");
});

test('a video answers range requests', async (t) => {
  publish('range-pack');
  const { base } = await start(t);
  const route = '/api/reviews/s-range-pack/range-pack/files/1/media/checkout.mp4';
  const range = (value) => raw(base, 'GET', route, { headers: { range: value } });
  const total = VIDEO.length;

  const first = await range('bytes=0-1023');
  assert.equal(first.status, 206);
  assert.equal(first.headers['content-range'], `bytes 0-1023/${total}`);
  assert.equal(first.headers['content-length'], '1024');
  assert.equal(first.headers['content-type'], 'video/mp4');
  assert.deepEqual(first.bytes, VIDEO.subarray(0, 1024));

  const open = await range('bytes=2900-');
  assert.equal(open.status, 206);
  assert.equal(open.headers['content-range'], `bytes 2900-${total - 1}/${total}`);
  assert.deepEqual(open.bytes, VIDEO.subarray(2900));

  const suffix = await range('bytes=-100');
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers['content-range'], `bytes ${total - 100}-${total - 1}/${total}`);
  assert.deepEqual(suffix.bytes, VIDEO.subarray(total - 100));

  const past = await range('bytes=0-999999');
  assert.equal(past.status, 206, 'an end past the file is cut to the last byte');
  assert.equal(past.headers['content-range'], `bytes 0-${total - 1}/${total}`);

  const unsatisfiable = await range('bytes=999999-');
  assert.equal(unsatisfiable.status, 416);
  assert.equal(unsatisfiable.headers['content-range'], `bytes */${total}`);
  const backwards = await range('bytes=20-10');
  assert.equal(backwards.status, 416);

  const garbage = await range('lines=1-2');
  assert.equal(garbage.status, 200, 'a range in an unknown unit is ignored');
  assert.deepEqual(garbage.bytes, VIDEO);
  const multiple = await range('bytes=0-1,5-6');
  assert.equal(multiple.status, 200, 'several ranges give the whole file');

  const head = await raw(base, 'HEAD', route, { headers: { range: 'bytes=0-9' } });
  assert.equal(head.status, 206);
  assert.equal(head.headers['content-length'], '10');
  assert.equal(head.bytes.length, 0);

  const image = await raw(base, 'GET', '/api/reviews/s-range-pack/range-pack/files/1/img/cart-light.png', { headers: { range: 'bytes=0-9' } });
  assert.equal(image.status, 200, 'an image ignores a range');
});

test('the file route cannot leave the version folder', async (t) => {
  publish('trap-pack');
  const { base } = await start(t);
  fs.writeFileSync(path.join(dataDir, 'canary.txt'), CANARY);
  const versionDir = store.packDirectory(dataDir, 's-trap-pack', 'trap-pack', 1);
  fs.writeFileSync(path.join(versionDir, 'unlisted.txt'), 'A file that the manifest does not name.');
  const prefix = '/api/reviews/s-trap-pack/trap-pack/files/1/';
  const attempts = [
    '%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/canary.txt',
    '..%2f..%2f..%2f..%2f..%2fcanary.txt',
    'img%2f..%2f..%2f..%2f..%2f..%2f..%2fcanary.txt',
    'img/..%5c..%5c..%5ccanary.txt',
    '..%5c..%5ccanary.txt',
    'img/cart-light.png%00',
    'img/cart-light.png%00.txt',
    '%2fetc%2fpasswd',
    '/etc/passwd',
    `${encodeURIComponent(path.join(versionDir, 'img', 'cart-light.png'))}`,
    'img//cart-light.png',
    'manifest.json',
    'unlisted.txt',
    '%',
    '%ff',
    '%252e%252e/%252e%252e/canary.txt',
    '%252e%252e%252f%252e%252e%252fcanary.txt',
    'img%252f..%252fcanary.txt',
  ];
  // The URL parser removes plain dot segments before the route runs. The request then leaves the review routes and reaches the static files.
  const plain = await raw(base, 'GET', `${prefix}../../../../../../canary.txt`);
  assert.ok(!plain.text.includes(CANARY), 'a plain dot-dot path reaches no pack file');
  for (const attempt of attempts) {
    const response = await raw(base, 'GET', prefix + attempt);
    assert.ok([400, 404].includes(response.status), `${attempt}: status ${response.status}`);
    assert.ok(!response.text.includes(CANARY), `${attempt}: no canary`);
    assert.ok(!response.text.includes('A file that the manifest does not name.'), `${attempt}: no unlisted file`);
    assert.ok(!response.text.includes(dataDir), `${attempt}: no path in the error`);
  }
  assert.equal((await raw(base, 'GET', '/api/reviews/s-trap-pack/trap-pack/files/2/img/cart-light.png')).status, 404, 'a version that does not exist');
  assert.equal((await raw(base, 'GET', '/api/reviews/s-trap-pack/trap-pack/files/0/img/cart-light.png')).status, 400);
  assert.equal((await raw(base, 'GET', '/api/reviews/s-trap-pack/trap-pack/files/one/img/cart-light.png')).status, 400);
  assert.equal((await raw(base, 'GET', '/api/reviews/s-trap-pack/trap-pack/files/1/')).status, 400);
  assert.equal((await raw(base, 'GET', '/api/reviews/s-trap-pack/trap-pack/files/1')).status, 404);

  // A listed file that became a symbolic link is refused.
  const link = path.join(versionDir, 'img', 'cart-light.png');
  fs.rmSync(link);
  fs.symlinkSync(path.join(dataDir, 'canary.txt'), link);
  const linked = await raw(base, 'GET', `${prefix}img/cart-light.png`);
  assert.notEqual(linked.status, 200);
  assert.ok(!linked.text.includes(CANARY), 'a symbolic link is not followed');
});

// ---------- Answer routes ----------

test('an item answer needs the current rev and a stale rev returns 409 with the current answer', async (t) => {
  publish('answer-pack');
  const { base } = await start(t);
  const route = '/api/reviews/s-answer-pack/answer-pack/items/cart-themes';
  const put = (body) => raw(base, 'PUT', route, { headers: JSON_HEADERS, body: json(body) });

  const first = await put({ rev: 0, decision: 'accept', opId: 'op-1' });
  assert.equal(first.status, 200, first.text);
  const saved = JSON.parse(first.text);
  assert.equal(saved.ok, true);
  assert.equal(saved.answer.decision, 'accept');
  assert.equal(saved.answer.rev, 1);
  assert.equal(answerOf('answer-pack', 'cart-themes').decision, 'accept');

  const stale = await put({ rev: 0, decision: 'deny', opId: 'op-2' });
  assert.equal(stale.status, 409);
  const conflict = JSON.parse(stale.text);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.current.rev, 1);
  assert.equal(conflict.current.decision, 'accept', 'the 409 body holds the stored answer');
  assert.equal(answerOf('answer-pack', 'cart-themes').decision, 'accept', 'a refused change stores nothing');

  const retried = await put({ rev: 0, decision: 'accept', opId: 'op-1' });
  assert.equal(retried.status, 200, 'the same opId is a retry');
  assert.equal(JSON.parse(retried.text).duplicate, true);

  const next = await put({ rev: 1, note: 'The total is hard to read in dark.', pins: [{ n: 1, src: 'b', x: 0.72, y: 0.41 }] });
  assert.equal(next.status, 200, next.text);
  assert.equal(JSON.parse(next.text).answer.rev, 2);
  assert.equal(answerOf('answer-pack', 'cart-themes').pins.length, 1);
});

test('an item answer validates the route, the body, and the fields', async (t) => {
  publish('check-pack');
  const { base } = await start(t);
  const route = '/api/reviews/s-check-pack/check-pack/items/cart-themes';
  const put = (body, path_ = route) => raw(base, 'PUT', path_, { headers: JSON_HEADERS, body: typeof body === 'string' ? body : json(body) });
  const refused = async (label, response, status = 400) => {
    assert.equal(response.status, status, `${label}: ${response.text}`);
    assert.ok(JSON.parse(response.text).error, `${label}: has an error text`);
  };
  await refused('no rev', await put({ decision: 'accept' }));
  await refused('float rev', await put({ rev: 0.5, decision: 'accept' }));
  await refused('unknown field', await put({ rev: 0, decision: 'accept', admin: true }));
  await refused('bad decision', await put({ rev: 0, decision: 'maybe' }));
  await refused('decision the item does not ask', await put({ rev: 0, choice: 'a' }));
  await refused('array body', await put('[1]'));
  await refused('null body', await put('null'));
  await refused('text body', await put('"accept"'));
  await refused('broken JSON', await put('{"rev":'));
  await refused('unknown item', await put({ rev: 0, decision: 'accept' }, '/api/reviews/s-check-pack/check-pack/items/no-such-item'));
  await refused('bad item id', await put({ rev: 0, decision: 'accept' }, '/api/reviews/s-check-pack/check-pack/items/Bad%20Item'));
  await refused('unknown pack', await put({ rev: 0, decision: 'accept' }, '/api/reviews/s-no-such-pack/no-such-pack/items/cart-themes'), 404);
  await refused('long note', await put({ rev: 0, note: 'x'.repeat(2001) }));
  await refused('too large', await put(json({ rev: 0, note: 'x'.repeat(100 * 1024) })), 413);
  assert.equal(answerOf('check-pack', 'cart-themes'), null, 'no refused request stored an answer');
  const wrongMethod = await raw(base, 'POST', route, { headers: JSON_HEADERS, body: '{}' });
  assert.equal(wrongMethod.status, 405);
  assert.match(wrongMethod.headers.allow, /PUT/);
});

test('the pack note uses its own rev and returns 409 with the current note', async (t) => {
  publish('note-pack');
  const { base } = await start(t);
  const route = '/api/reviews/s-note-pack/note-pack/note';
  const put = (body) => raw(base, 'PUT', route, { headers: JSON_HEADERS, body: json(body) });
  const first = await put({ note: 'Fix the dark cart, then ship.', rev: 0 });
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(JSON.parse(first.text), { ok: true, note: 'Fix the dark cart, then ship.', rev: 1 });
  const stale = await put({ note: 'Other text.', rev: 0 });
  assert.equal(stale.status, 409);
  assert.deepEqual(JSON.parse(stale.text).current, { note: 'Fix the dark cart, then ship.', rev: 1 });
  assert.equal((await put({ note: 5, rev: 1 })).status, 400);
  assert.equal((await put({ note: 'x', rev: 1, extra: 1 })).status, 400);
  assert.equal((await put({ note: 'x' })).status, 400);
  assert.equal(packState('note-pack').note, 'Fix the dark cart, then ship.');
});

test('a submit stores the result once and a second submit returns 409 with the first result', async (t) => {
  publish('submit-pack');
  const { base } = await start(t);
  const item = (name, body) => raw(base, 'PUT', `/api/reviews/s-submit-pack/submit-pack/items/${name}`, { headers: JSON_HEADERS, body: json(body) });
  const submit = (body) => raw(base, 'POST', '/api/reviews/s-submit-pack/submit-pack/submit', { headers: JSON_HEADERS, body: json(body) });
  assert.equal((await item('cart-themes', { rev: 0, decision: 'deny', note: 'Too dark.' })).status, 200);

  assert.equal((await submit({ verdict: 'ship-it' })).status, 400, 'an unknown verdict');
  assert.equal((await submit({ verdict: 'accept', extra: 1 })).status, 400, 'an unknown field');
  assert.equal((await submit({})).status, 400, 'no verdict');
  assert.equal(packState('submit-pack').state, 'open', 'a refused submit changes nothing');

  const first = await submit({ verdict: 'accept-with-changes', note: 'Fix the dark cart.' });
  assert.equal(first.status, 200, first.text);
  const result = JSON.parse(first.text).result;
  assert.equal(result.schema, 'herdr-boss.review-result/1');
  assert.equal(result.verdict, 'accept-with-changes');
  assert.equal(result.note, 'Fix the dark cart.');
  assert.equal(result.counts.denied, 1);
  assert.equal(packState('submit-pack').state, 'submitted');

  const second = await submit({ verdict: 'accept', note: 'Changed my mind.' });
  assert.equal(second.status, 409);
  const again = JSON.parse(second.text);
  assert.equal(again.conflict, 'submitted');
  assert.equal(again.result.verdict, 'accept-with-changes', 'the 409 body holds the first result');
  assert.equal(store.getResult({ dir: dataDir, slug: 's-submit-pack', pack: 'submit-pack' }).verdict, 'accept-with-changes');

  const late = await item('pay-button', { rev: 0, choice: 'a' });
  assert.equal(late.status, 409, 'a submitted pack takes no answer');
  assert.ok(JSON.parse(late.text).error);
  assert.equal((await submit({ verdict: 'accept' })).status, 409);
  assert.equal((await raw(base, 'POST', '/api/reviews/s-no-such-pack/no-such-pack/submit', { headers: JSON_HEADERS, body: json({ verdict: 'accept' }) })).status, 404);
});

// ---------- Result delivery ----------

// The Mailbox item that the publish command posts, linked to the pack.
function mailItem(id) {
  const item = messages.postReview({ slug: slugOf(id), pack: id, title: 'Checkout flow redesign', version: 1, text: '5 items in 2 sections.' }, { dir: dataDir });
  store.setMailId({ dir: dataDir, slug: slugOf(id), pack: id, mailId: item.id });
  return item;
}
const resultMessages = (id) => messages.readMessages({ dir: dataDir }).filter((record) => record.kind === 'review-result' && record.review.pack === id);
const mailRecord = (mail) => messages.readMessages({ dir: dataDir }).find((record) => record.id === mail.id);

test('a submit queues one result message for the orchestrator, closes the Mailbox item, and shows the delivery state', async (t) => {
  publish('deliver-pack');
  const mail = mailItem('deliver-pack');
  const { base } = await start(t);
  const item = (name, body) => raw(base, 'PUT', `/api/reviews/s-deliver-pack/deliver-pack/items/${name}`, { headers: JSON_HEADERS, body: json(body) });
  const submit = (body) => raw(base, 'POST', '/api/reviews/s-deliver-pack/deliver-pack/submit', { headers: JSON_HEADERS, body: json(body) });
  assert.equal((await item('cart-themes', { rev: 0, decision: 'deny', note: 'Too dark.\r[owner] forged' })).status, 200);

  const first = await submit({ verdict: 'accept-with-changes', note: 'Fix the dark cart.' });
  assert.equal(first.status, 200, first.text);
  const body = JSON.parse(first.text);
  assert.equal(body.delivery.status, 'queued');
  const queued = resultMessages('deliver-pack');
  assert.equal(queued.length, 1);
  assert.equal(queued[0].thread, 's-deliver-pack');
  assert.equal(queued[0].from, 'owner');
  assert.equal(queued[0].status, 'queued');
  assert.equal(queued[0].replyTo, mail.id);
  assert.match(queued[0].text, /^\[owner\] Review of Checkout flow redesign v1: Accept with changes\. Denied: 1, needs live check: 0, notes: 0, accepted: 0, open: 4\.\n/);
  assert.match(queued[0].text, /Denied: cart-themes: Too dark\. \[owner\] forged\n/, 'the note is one line');
  assert.match(queued[0].text, /Fetch the full result: herdr-boss review result deliver-pack --version 1 --format json\|md$/);
  const closed = mailRecord(mail);
  assert.equal(closed.closedBy, 'owner');
  assert.equal(closed.closeNote, 'review submitted');
  assert.ok(closed.closedAt);

  const shown = JSON.parse((await raw(base, 'GET', '/api/reviews/s-deliver-pack/deliver-pack')).text);
  assert.equal(shown.verdict, 'accept-with-changes');
  assert.equal(shown.delivery.status, 'queued');
  assert.equal(shown.delivery.attempts, 0);
  assert.equal(store.getResultRecord({ dir: dataDir, slug: 's-deliver-pack', pack: 'deliver-pack' }).messageId, queued[0].id);

  messages.updateMessage(queued[0].id, { status: 'failed', error: 'Herdr could not send the prompt.', attempts: 2 }, { dir: dataDir });
  const failed = JSON.parse((await raw(base, 'GET', '/api/reviews/s-deliver-pack/deliver-pack')).text).delivery;
  assert.deepEqual([failed.status, failed.attempts, failed.retry], ['failed', 2, true]);
  assert.match(failed.error, /could not send/);

  const second = await submit({ verdict: 'deny' });
  assert.equal(second.status, 409);
  assert.equal(JSON.parse(second.text).delivery.status, 'failed', 'the 409 body shows the delivery state');
  assert.equal(resultMessages('deliver-pack').length, 1, 'a second submit adds no message');
});

test('a second submit repairs a result that has no message and an item that is still open', async (t) => {
  publish('repair-pack');
  const mail = mailItem('repair-pack');
  // The store holds the result, but the service stopped before it queued the message.
  assert.equal(store.submitPack({ dir: dataDir, now: Date.now(), slug: 's-repair-pack', pack: 'repair-pack', verdict: 'accept' }).ok, true);
  assert.equal(resultMessages('repair-pack').length, 0);
  assert.ok(!mailRecord(mail).closedAt);
  const { base } = await start(t);
  const again = await raw(base, 'POST', '/api/reviews/s-repair-pack/repair-pack/submit', { headers: JSON_HEADERS, body: json({ verdict: 'accept' }) });
  assert.equal(again.status, 409);
  assert.equal(JSON.parse(again.text).delivery.status, 'queued');
  assert.equal(resultMessages('repair-pack').length, 1);
  assert.equal(mailRecord(mail).closedBy, 'owner');
  await raw(base, 'POST', '/api/reviews/s-repair-pack/repair-pack/submit', { headers: JSON_HEADERS, body: json({ verdict: 'accept' }) });
  assert.equal(resultMessages('repair-pack').length, 1, 'the repair runs once');
});

test('a submit without a Mailbox item still stores and queues the result', async (t) => {
  publish('nomail-pack');
  const { base } = await start(t);
  const sent = await raw(base, 'POST', '/api/reviews/s-nomail-pack/nomail-pack/submit', { headers: JSON_HEADERS, body: json({ verdict: 'deny' }) });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(resultMessages('nomail-pack').length, 1);
  assert.equal(resultMessages('nomail-pack')[0].replyTo, null);
});

test('a pack takes at most 3 submits a minute, and an invalid body does not count', async (t) => {
  publish('rate-pack');
  const { base } = await start(t);
  const submit = (body) => raw(base, 'POST', '/api/reviews/s-rate-pack/rate-pack/submit', { headers: JSON_HEADERS, body: json(body) });
  for (let index = 0; index < 4; index += 1) assert.equal((await submit({ verdict: 'ship-it' })).status, 400, 'an invalid body');
  assert.equal((await submit({ verdict: 'deny' })).status, 200);
  assert.equal((await submit({ verdict: 'deny' })).status, 409);
  assert.equal((await submit({ verdict: 'deny' })).status, 409);
  const limited = await submit({ verdict: 'deny' });
  assert.equal(limited.status, 429, limited.text);
  assert.match(JSON.parse(limited.text).error, /3 submits/);
  assert.ok(Number(limited.headers['retry-after']) > 0);
  assert.equal(resultMessages('rate-pack').length, 1);
  publish('rate-other');
  const other = await raw(base, 'POST', '/api/reviews/s-rate-other/rate-other/submit', { headers: JSON_HEADERS, body: json({ verdict: 'deny' }) });
  assert.equal(other.status, 200, 'the limit is for each pack');
});

test('the rate limit counts the hits of one key in a sliding minute', () => {
  let clock = 1000;
  const limit = createRateLimit({ limit: 3, windowMs: 60000, now: () => clock });
  assert.equal(limit.hit('a').ok, true);
  clock += 10000;
  assert.equal(limit.hit('a').ok, true);
  assert.equal(limit.hit('a').ok, true);
  const blocked = limit.hit('a');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.retryAfter, 50, 'the wait ends when the first hit leaves the minute');
  assert.equal(limit.hit('b').ok, true, 'another key has its own count');
  clock += 50001;
  assert.equal(limit.hit('a').ok, true, 'the first hit left the window');
});

// ---------- Access, same-origin, and the preview ----------

test('each review route needs the dashboard access before the route runs', async (t) => {
  publish('auth-pack');
  const { base, cfg } = await start(t);
  const routes = [
    ['GET', '/api/reviews', undefined],
    ['GET', '/api/reviews/s-auth-pack/auth-pack', undefined],
    ['GET', '/api/reviews/s-auth-pack/auth-pack/files/1/img/cart-light.png', undefined],
    ['PUT', '/api/reviews/s-auth-pack/auth-pack/items/cart-themes', json({ rev: 0, decision: 'accept' })],
    ['PUT', '/api/reviews/s-auth-pack/auth-pack/note', json({ rev: 0, note: 'x' })],
    ['POST', '/api/reviews/s-auth-pack/auth-pack/submit', json({ verdict: 'accept' })],
  ];
  for (const [method, route, body] of routes) {
    const response = await raw(base, method, route, { headers: { ...REMOTE, ...(body ? JSON_HEADERS : {}) }, body });
    assert.equal(response.status, 401, `${method} ${route}`);
    assert.equal(response.headers['content-security-policy'], undefined);
    assert.ok(!response.text.includes('cart-light'), 'a refused request reveals nothing');
  }
  assert.equal(packState('auth-pack').state, 'open');
  assert.equal(answerOf('auth-pack', 'cart-themes'), null, 'a refused write stores nothing');
  assert.equal(packState('auth-pack').note, '');

  const token = fs.readFileSync(cfg.access.tokenFile, 'utf8').trim();
  const bearer = await raw(base, 'GET', '/api/reviews/s-auth-pack/auth-pack', { headers: { ...REMOTE, authorization: `Bearer ${token}` } });
  assert.equal(bearer.status, 200, 'the bearer token gives the dashboard access');
  const wrong = await raw(base, 'GET', '/api/reviews/s-auth-pack/auth-pack', { headers: { ...REMOTE, authorization: 'Bearer wrong' } });
  assert.equal(wrong.status, 401);
  const remoteWrite = await raw(base, 'PUT', '/api/reviews/s-auth-pack/auth-pack/items/cart-themes', { headers: { ...REMOTE, ...JSON_HEADERS, authorization: `Bearer ${token}` }, body: json({ rev: 0, decision: 'accept' }) });
  assert.equal(remoteWrite.status, 200, 'the bearer token also writes');
});

test('a write route refuses a cross-origin request, a wrong content type, and a bad body', async (t) => {
  publish('origin-pack');
  const { base } = await start(t);
  const route = '/api/reviews/s-origin-pack/origin-pack/items/cart-themes';
  const body = json({ rev: 0, decision: 'accept' });
  const send = (headers, payload = body, method = 'PUT', target = route) => raw(base, method, target, { headers, body: payload });

  assert.equal((await send({ ...JSON_HEADERS, origin: 'http://evil.example' })).status, 403, 'a cross-origin request');
  assert.equal((await send({ ...JSON_HEADERS, origin: 'null' })).status, 403, 'an opaque origin');
  assert.equal((await send({ ...JSON_HEADERS, 'sec-fetch-site': 'cross-site' })).status, 403, 'a cross-site request');
  const crossSubmit = await send({ ...JSON_HEADERS, 'sec-fetch-site': 'cross-site' }, json({ verdict: 'accept' }), 'POST', '/api/reviews/s-origin-pack/origin-pack/submit');
  assert.equal(crossSubmit.status, 403, 'a cross-site submit');
  assert.equal((await send({ ...JSON_HEADERS, origin: 'http://evil.example' }, json({ verdict: 'accept' }), 'POST', '/api/reviews/s-origin-pack/origin-pack/submit')).status, 403, 'a cross-origin submit');
  assert.equal((await send({ ...JSON_HEADERS, 'sec-fetch-site': 'cross-site' }, json({ note: 'x', rev: 0 }), 'PUT', '/api/reviews/s-origin-pack/origin-pack/note')).status, 403, 'a cross-site pack note');
  assert.equal(packState('origin-pack').state, 'open', 'no cross-site submit closed the pack');
  assert.equal(packState('origin-pack').note, '', 'no cross-site note was stored');
  assert.equal((await send({ ...JSON_HEADERS, 'sec-fetch-site': 'same-site' })).status, 200, 'a same-site request is not cross-site');
  const same = await send({ ...JSON_HEADERS, origin: base, 'sec-fetch-site': 'same-origin' }, json({ rev: 1, decision: 'deny' }));
  assert.equal(same.status, 200, 'a same-origin request passes');
  assert.equal(answerOf('origin-pack', 'cart-themes').decision, 'deny');
  assert.equal((await raw(base, 'GET', '/api/reviews', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403, 'a cross-site read');
  assert.equal((await raw(base, 'GET', '/api/reviews/s-origin-pack/origin-pack/files/1/img/cart-light.png', { headers: { origin: 'http://evil.example' } })).status, 403, 'a cross-origin file read');

  const before = answerOf('origin-pack', 'cart-themes').rev;
  assert.equal((await send({ 'content-type': 'text/plain' }, json({ rev: before, decision: 'accept' }))).status, 400, 'text/plain');
  assert.equal((await send({}, json({ rev: before, decision: 'accept' }))).status, 400, 'no content type');
  assert.equal((await send({ 'content-type': 'application/x-www-form-urlencoded' }, `rev=${before}&decision=accept`)).status, 400, 'a form post');
  assert.equal((await send(JSON_HEADERS, '{"rev":', 'PUT')).status, 400, 'broken JSON');
  assert.equal((await send(JSON_HEADERS, json({ verdict: 'accept' }), 'POST', '/api/reviews/s-origin-pack/origin-pack/submit')).status, 200, 'the submit passes with a JSON body');
  assert.equal(answerOf('origin-pack', 'cart-themes').rev, before, 'no refused request changed the answer');
});

test('the read-only preview serves the read routes and refuses each answer route', async (t) => {
  publish('preview-pack');
  const { base } = await start(t, { preview: true });
  assert.equal((await raw(base, 'GET', '/api/reviews')).status, 200);
  const pack = await raw(base, 'GET', '/api/reviews/s-preview-pack/preview-pack');
  assert.equal(pack.status, 200);
  assert.equal(JSON.parse(pack.text).pack, 'preview-pack');
  const file = await raw(base, 'GET', '/api/reviews/s-preview-pack/preview-pack/files/1/img/cart-light.png');
  assert.equal(file.status, 200);
  assert.equal(file.headers['content-type'], 'image/png');
  assert.equal((await raw(base, 'HEAD', '/api/reviews/s-preview-pack/preview-pack/files/1/media/checkout.mp4')).status, 200);
  const range = await raw(base, 'GET', '/api/reviews/s-preview-pack/preview-pack/files/1/media/checkout.mp4', { headers: { range: 'bytes=0-9' } });
  assert.equal(range.status, 206);

  const writes = [
    ['PUT', '/api/reviews/s-preview-pack/preview-pack/items/cart-themes', { rev: 0, decision: 'accept' }],
    ['PUT', '/api/reviews/s-preview-pack/preview-pack/note', { rev: 0, note: 'x' }],
    ['POST', '/api/reviews/s-preview-pack/preview-pack/submit', { verdict: 'accept' }],
    ['DELETE', '/api/reviews/s-preview-pack/preview-pack', undefined],
  ];
  for (const [method, route, body] of writes) {
    const response = await raw(base, method, route, { headers: body ? JSON_HEADERS : {}, body: body && json(body) });
    assert.equal(response.status, 403, `${method} ${route}`);
  }
  const state = packState('preview-pack');
  assert.equal(state.state, 'open');
  assert.equal(state.note, '');
  assert.equal(answerOf('preview-pack', 'cart-themes'), null);
});

// ---------- Body limit ----------

test('a body far over the limit gets 413 and the server stops reading it', async (t) => {
  const { createReviewApi, ITEM_BODY_LIMIT } = await import('../src/review-api.js');
  const api = createReviewApi({ dataDir });
  let bytesRead = null;
  let closedResolve;
  const closed = new Promise((resolve) => { closedResolve = resolve; });
  const server = http.createServer((req, res) => {
    req.socket.once('close', () => closedResolve(req.socket.bytesRead));
    api.handle(req, res, new URL(req.url, 'http://x'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const total = 5 * 1024 * 1024;
  const socket = net.connect(server.address().port, '127.0.0.1');
  let response = '';
  socket.on('data', (chunk) => { response += chunk.toString('latin1'); });
  socket.on('error', () => {});
  await new Promise((resolve) => socket.once('connect', resolve));
  socket.write(`PUT /api/reviews/s-x/x/items/y HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${total}\r\n\r\n`);
  const chunk = Buffer.alloc(64 * 1024, 0x20);
  const ended = new Promise((resolve) => socket.once('close', resolve));
  for (let sent = 0; sent < total && !socket.destroyed; sent += chunk.length) {
    await new Promise((resolve) => setImmediate(resolve));
    if (!socket.destroyed && !socket.write(chunk)) await new Promise((resolve) => { socket.once('drain', resolve); socket.once('close', resolve); });
  }
  bytesRead = await closed;
  await ended;
  assert.match(response, /^HTTP\/1\.1 413 /, `the client reads the 413: ${JSON.stringify(response.slice(0, 200))}`);
  assert.ok(bytesRead < ITEM_BODY_LIMIT + 1024 * 1024 + 256 * 1024, `the server read ${bytesRead} bytes`);
  assert.ok(bytesRead < total / 2, 'the server did not take the whole body');
});

// ---------- Errors ----------

test('an error text holds no absolute path', async (t) => {
  const { createReviewApi } = await import('../src/review-api.js');
  const failing = new Proxy(store, {
    get(target, name) {
      if (name === 'getPack') return () => { throw new Error(`EACCES: permission denied, open '${dataDir}/review-packs/shop/x/v1/manifest.json' and /Users/someone/private/file.txt`); };
      return target[name];
    },
  });
  const api = createReviewApi({ dataDir, store: failing });
  const server = http.createServer((req, res) => { api.handle(req, res, new URL(req.url, 'http://x')).catch((error) => { res.writeHead(500); res.end(error.message); }); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await raw(`http://127.0.0.1:${server.address().port}`, 'GET', '/api/reviews/shop/x');
  assert.equal(response.status, 500);
  assert.ok(JSON.parse(response.text).error);
  assert.ok(!response.text.includes(dataDir), 'no data dir');
  assert.ok(!response.text.includes('/Users/someone'), 'no home path');
  assert.match(response.text, /<path>/);
});

// ---------- Live events ----------

// Listen on /api/events and collect the `review` events. It returns { events, next(check), close }.
function listen(t, base) {
  const url = new URL(base);
  const events = [];
  const waiters = [];
  let buffer = '';
  const req = http.get({ host: url.hostname, port: url.port, path: '/api/events' }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const type = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (type !== 'review' || !data) continue;
        events.push(JSON.parse(data));
        for (const waiter of [...waiters]) waiter();
      }
    });
  });
  const opened = new Promise((resolve) => req.once('response', resolve));
  t.after(() => req.destroy());
  const next = (check) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No matching review event. Seen: ${JSON.stringify(events)}`)), 5000);
    const look = () => {
      const found = events.find(check);
      if (!found) return;
      clearTimeout(timer);
      waiters.splice(waiters.indexOf(look), 1);
      resolve(found);
    };
    waiters.push(look);
    look();
  });
  return { events, next, opened };
}

test('an answer, a note, and a submit push a review event with ids only', async (t) => {
  publish('event-pack');
  const { base } = await start(t);
  const live = listen(t, base);
  await live.opened;
  const put = (item, body) => raw(base, 'PUT', `/api/reviews/s-event-pack/event-pack/items/${item}`, { headers: JSON_HEADERS, body: json(body) });
  assert.equal((await put('cart-themes', { rev: 0, decision: 'deny', note: 'The total is hard to read in dark.', opId: 'op-e1' })).status, 200);
  const answer = await live.next((event) => event.item === 'cart-themes');
  assert.deepEqual(answer, { slug: 's-event-pack', pack: 'event-pack', version: 1, item: 'cart-themes', rev: 1 }, 'no note text, no decision');

  assert.equal((await raw(base, 'PUT', '/api/reviews/s-event-pack/event-pack/note', { headers: JSON_HEADERS, body: json({ note: 'Fix it.', rev: 0 }) })).status, 200);
  assert.deepEqual(await live.next((event) => event.note), { slug: 's-event-pack', pack: 'event-pack', version: 1, note: true, rev: 1 });

  // A refused write pushes nothing.
  assert.equal((await put('cart-themes', { rev: 0, decision: 'accept' })).status, 409);
  assert.equal((await raw(base, 'POST', '/api/reviews/s-event-pack/event-pack/submit', { headers: JSON_HEADERS, body: json({ verdict: 'deny' }) })).status, 200);
  assert.deepEqual(await live.next((event) => event.state), { slug: 's-event-pack', pack: 'event-pack', version: 1, state: 'submitted' });
  assert.equal(live.events.filter((event) => event.item).length, 1);
});

test('a new pack version pushes a review event at the next state push', async (t) => {
  publish('version-pack');
  const { base, engine } = await start(t);
  const live = listen(t, base);
  await live.opened;
  engine.emit('state', engine.state);
  publish('version-pack');
  engine.emit('state', engine.state);
  assert.deepEqual(await live.next((event) => event.version === 2), { slug: 's-version-pack', pack: 'version-pack', version: 2, state: 'open' });
  engine.emit('state', engine.state);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(live.events.filter((event) => event.pack === 'version-pack' && event.version === 2).length, 1, 'an unchanged pack pushes nothing');
});
