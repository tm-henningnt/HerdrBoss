import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-attachments-'));
process.env.HOME = path.join(root, 'home');
process.env.HERDR_BOSS_DIR = path.join(root, 'data');
fs.mkdirSync(process.env.HOME);
const { serve } = await import('../src/server.js');
const { loadConfig } = await import('../src/config.js');
const messages = await import('../src/messages.js');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
// A complete one-pixel grayscale JPEG: one quantization table and DC/AC zero codes.
const jpeg = Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  jpegSegment(0xdb, Buffer.from([0, ...Array(64).fill(1)])),
  jpegSegment(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])),
  jpegSegment(0xc4, Buffer.from([0, 1, ...Array(15).fill(0), 0, 0x10, 1, ...Array(15).fill(0), 0])),
  jpegSegment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
  Buffer.from([0x3f, 0xff, 0xd9]),
]);
function webpChunk(type, bytes) {
  const size = Buffer.alloc(4); size.writeUInt32LE(bytes.length);
  return Buffer.concat([Buffer.from(type), size, bytes, bytes.length % 2 ? Buffer.from([0]) : Buffer.alloc(0)]);
}
function webp(...chunks) {
  const body = Buffer.concat([Buffer.from('WEBP'), ...chunks]);
  const size = Buffer.alloc(4); size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from('RIFF'), size, body]);
}
function heif(brand) {
  const size = Buffer.alloc(4); size.writeUInt32BE(24);
  return Buffer.concat([size, Buffer.from(`ftyp${brand}`), Buffer.alloc(4), Buffer.from(`${brand}mif1`)]);
}
const pictures = {
  'image/jpeg': jpeg, 'image/png': png, 'image/gif': gif,
  'image/webp': Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64'),
  'image/heic': heif('heic'), 'image/heif': heif('mif1'),
};
// A little-endian TIFF with GPSInfoIFDPointer, GPSLatitudeRef and three rationals.
const gpsTiff = Buffer.alloc(80);
gpsTiff.write('II'); gpsTiff.writeUInt16LE(42, 2); gpsTiff.writeUInt32LE(8, 4);
gpsTiff.writeUInt16LE(1, 8); gpsTiff.writeUInt16LE(0x8825, 10); gpsTiff.writeUInt16LE(4, 12);
gpsTiff.writeUInt32LE(1, 14); gpsTiff.writeUInt32LE(26, 18);
gpsTiff.writeUInt16LE(2, 26); gpsTiff.writeUInt16LE(1, 28); gpsTiff.writeUInt16LE(2, 30);
gpsTiff.writeUInt32LE(2, 32); gpsTiff.write('N', 36);
gpsTiff.writeUInt16LE(2, 40); gpsTiff.writeUInt16LE(5, 42); gpsTiff.writeUInt32LE(3, 44); gpsTiff.writeUInt32LE(56, 48);
for (const [index, value] of [59, 55, 0].entries()) { gpsTiff.writeUInt32LE(value, 56 + index * 8); gpsTiff.writeUInt32LE(1, 60 + index * 8); }
const gps = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), gpsTiff]);
const cfg = loadConfig(); cfg.host = '127.0.0.1'; cfg.port = 0; cfg.tickSeconds = 3600;
const app = serve(cfg, { liveDataDir: process.env.HERDR_BOSS_DIR, createEngine: () => {
  const engine = new EventEmitter(); engine.state = { control: { projects: {} } };
  engine.tick = async () => engine.state; engine.log = () => {}; return engine;
} });
if (!app.server.listening) await once(app.server, 'listening');
const base = `http://127.0.0.1:${app.server.address().port}`;
test.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
const upload = (type, body, headers = {}) => fetch(`${base}/api/attachments`, { method: 'POST', headers: { 'content-type': type, ...headers }, body });
const send = (attachments, text = 'See this picture.') => fetch(`${base}/api/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ thread: 'boss', kind: 'message', text, attachments }) });
async function raw(method, route, headers = {}, body = Buffer.alloc(0)) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + '/', { method, path: route, headers }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }); req.on('error', reject); req.end(body);
  });
}

test('upload and download use private files, magic types and safe names for every supported picture', async () => {
  for (const [type, bytes] of Object.entries(pictures)) {
    const response = await upload(type, bytes, { 'x-filename': encodeURIComponent('../phone\n"photo.jpg') });
    assert.equal(response.status, 200, type);
    const metadata = await response.json();
    assert.match(metadata.id, /^att_[0-9a-f]{32}$/);
    assert.equal(metadata.type, type); assert.equal(metadata.size, bytes.length);
    assert.equal(metadata.url, `/attachments/${metadata.id}`);
    assert.equal(metadata.metadataStripped, !type.startsWith('image/hei'));
    assert.doesNotMatch(metadata.name, /[\/\\\r\n"]/);
    assert.equal(new Date(metadata.createdAt).toISOString(), metadata.createdAt);
    const folder = path.join(process.env.HERDR_BOSS_DIR, 'attachments');
    const disk = JSON.parse(fs.readFileSync(path.join(folder, `${metadata.id}.json`)));
    assert.equal(disk.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(fs.statSync(folder).mode & 0o777, 0o700);
    for (const name of fs.readdirSync(folder).filter((name) => name.startsWith(metadata.id))) assert.equal(fs.statSync(path.join(folder, name)).mode & 0o777, 0o600);
    const fetched = await fetch(base + metadata.url);
    assert.equal(fetched.status, 200); assert.equal(fetched.headers.get('content-type'), type);
    assert.equal(fetched.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(fetched.headers.get('cache-control'), 'private, max-age=3600');
    assert.equal(fetched.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.match(fetched.headers.get('content-disposition'), type.startsWith('image/hei') ? /^attachment; filename="[^"\r\n]+"$/ : /^inline$/);
    assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), bytes);
  }
});

test('upload rejects a mismatched type, malformed name and a body over 10 MB', async () => {
  assert.equal((await upload('image/jpeg', png)).status, 415);
  assert.equal((await upload('image/png', Buffer.from('not an image'))).status, 415);
  assert.equal((await upload('image/svg+xml', png)).status, 415);
  assert.equal((await upload('image/png', png, { 'x-filename': '%' })).status, 400);
  assert.equal((await upload('image/png', png, { 'x-filename': 'x'.repeat(121) })).status, 400);
  assert.equal((await upload('image/png', Buffer.alloc(10 * 1024 * 1024 + 1))).status, 413);
});

test('rejects an oversized declared attachment body before consuming it', async () => {
  const response = await raw('POST', '/api/attachments', {
    'content-type': 'image/png', 'content-length': String(10 * 1024 * 1024 + 1), connection: 'close',
  }, Buffer.from('small body'));
  assert.equal(response.status, 413);
});

test('attachment reads reject invalid ids and traversal at the raw HTTP boundary', async () => {
  for (const route of ['/attachments', '/attachments/bad', '/attachments/../package.json', '/attachments/%2e%2e/package.json', '/attachments//etc/passwd', `/attachments/att_${'a'.repeat(32)}.png`]) {
    assert.equal((await raw('GET', route)).status, 404, route);
  }
});

test('attachment routes require remote login and same-origin requests', async () => {
  const headers = { host: 'fixture.tail0000.ts.net', 'content-type': 'image/png' };
  assert.equal((await raw('POST', '/api/attachments', headers, png)).status, 401);
  const response = await upload('image/png', png); const attachment = await response.json();
  assert.equal((await raw('GET', attachment.url, headers)).status, 401);
  assert.equal((await raw('POST', '/api/attachments', { ...headers, origin: 'http://evil.example' }, png)).status, 403);
  const token = fs.readFileSync(cfg.access.tokenFile, 'utf8').trim();
  const login = await raw('POST', '/login', { host: headers.host, 'content-type': 'application/x-www-form-urlencoded' }, Buffer.from(new URLSearchParams({ token }).toString()));
  assert.equal(login.status, 303);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  assert.equal((await raw('POST', '/api/attachments', { ...headers, cookie }, png)).status, 200);
  assert.equal((await raw('GET', attachment.url, { host: headers.host, cookie })).status, 200);
});

function pngChunk(type, bytes) {
  const head = Buffer.alloc(4); head.writeUInt32BE(bytes.length);
  const content = Buffer.concat([Buffer.from(type), bytes]);
  let crc = 0xffffffff;
  for (const byte of content) { crc ^= byte; for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const tail = Buffer.alloc(4); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([head, content, tail]);
}
function jpegSegment(marker, bytes) {
  const header = Buffer.alloc(4); header[0] = 255; header[1] = marker; header.writeUInt16BE(bytes.length + 2, 2);
  return Buffer.concat([header, bytes]);
}

test('uploads remove GPS EXIF and other metadata and preserve image and ICC bytes', async () => {
  const icc = jpegSegment(0xe2, Buffer.from('ICC_PROFILE\0public-colour', 'latin1'));
  const jpegClean = Buffer.concat([jpeg.subarray(0, 2), icc, jpeg.subarray(2)]);
  const webpClean = webp(webpChunk('VP8X', Buffer.alloc(10)), pictures['image/webp'].subarray(12));
  const extended = Buffer.alloc(10); extended[0] = 0x0c;
  const cases = [
    ['image/jpeg', Buffer.concat([jpeg.subarray(0, 2), jpegSegment(0xe1, gps), jpegSegment(0xed, Buffer.from('IPTC-private')), icc, jpeg.subarray(2)]), jpegClean],
    ['image/png', Buffer.concat([png.subarray(0, 33), ...['eXIf', 'tEXt', 'iTXt', 'zTXt'].map((type) => pngChunk(type, gps)), png.subarray(33)]), png],
    ['image/webp', webp(webpChunk('VP8X', extended), webpChunk('EXIF', gps), webpChunk('XMP ', gps), pictures['image/webp'].subarray(12)), webpClean],
    ['image/gif', Buffer.concat([gif.subarray(0, 19), Buffer.from([0x21, 0xfe, gps.length]), gps, Buffer.from([0]), Buffer.from([0x21, 0xff, 11]), Buffer.from('PRIVATEAPP1'), Buffer.from([gps.length]), gps, Buffer.from([0]), gif.subarray(19)]), gif],
  ];
  for (const [type, dirty, clean] of cases) {
    const response = await upload(type, dirty); assert.equal(response.status, 200, type);
    const metadata = await response.json(); const fetched = await fetch(base + metadata.url);
    const actual = Buffer.from(await fetched.arrayBuffer());
    assert.deepEqual(actual, clean, type); assert.equal(actual.includes(gps), false);
    assert.equal(metadata.size, clean.length);
  }
});

test('PNG uploads drop tIME and preserve the IDAT and remaining bytes', async () => {
  const timestamp = Buffer.from([0x07, 0xea, 1, 1, 0, 0, 0]);
  const timed = Buffer.concat([png.subarray(0, 33), pngChunk('tIME', timestamp), png.subarray(33)]);
  const response = await upload('image/png', timed);
  assert.equal(response.status, 200);
  const metadata = await response.json();
  const fetched = await fetch(base + metadata.url);
  const actual = Buffer.from(await fetched.arrayBuffer());
  assert.deepEqual(actual, png);
  assert.deepEqual(actual.subarray(33), png.subarray(33));
});

test('messages link at most six existing unused ids and expose descriptors in Chat and Mailbox', async () => {
  const attachment = await (await upload('image/png', png)).json();
  const response = await send([attachment.id]); assert.equal(response.status, 200);
  const record = (await response.json()).message;
  const descriptor = { id: attachment.id, type: attachment.type, size: attachment.size, name: attachment.name };
  assert.deepEqual(record.attachments, [descriptor]);
  const listed = await (await fetch(base + '/api/messages?thread=boss')).json();
  assert.deepEqual(listed.find((item) => item.id === record.id).attachments, [descriptor]);
  assert.equal((await send([attachment.id])).status, 400);
  assert.equal((await send([`att_${'0'.repeat(32)}`])).status, 404);
  for (const ids of [['../photo'], [attachment.id, attachment.id], Array(7).fill(attachment.id), 'bad', null, [null]]) assert.equal((await send(ids)).status, 400);
  const blankAttachment = await (await upload('image/png', png)).json();
  assert.equal((await send([blankAttachment.id], '')).status, 200, 'a picture can be sent without a caption');
});

test('delivery includes a private id-based image-tool path in the same prompt and never logs that path', async () => {
  const dir = fs.mkdtempSync(path.join(root, 'delivery-'));
  const { storeAttachment } = await import('../src/attachments.js');
  const attachment = storeAttachment(jpeg, { dir });
  const record = messages.appendMessage({ thread: 'boss', from: 'owner', kind: 'message', text: 'Look here.', status: 'queued', attachments: [attachment.id] }, { dir });
  const prompts = []; const logs = [];
  await messages.deliverQueued({ dir, panes: [{ id: 'w1:p1', label: 'boss', agent: 'codex', status: 'idle' }], prompt: async (...args) => prompts.push(args), log: (...args) => logs.push(args) });
  assert.equal(prompts.length, 1); assert.equal(prompts[0][0], 'w1:p1');
  assert.ok(prompts[0][1].includes(`Attachment: ${path.join(dir, 'attachments', attachment.id + '.jpg')} (image/jpeg, 1 KB)`));
  assert.match(prompts[0][1], /read.*image tool/i);
  assert.doesNotMatch(JSON.stringify(logs), /attachments\//);
  assert.equal(messages.readMessages({ dir }).find((item) => item.id === record.id).status, 'sent');
});

function cliFixture() {
  const cwd = fs.mkdtempSync(path.join(root, 'cli-'));
  const home = path.join(cwd, 'home'); const data = path.join(cwd, 'data'); const bin = path.join(cwd, 'bin');
  for (const folder of [home, data, bin]) fs.mkdirSync(folder);
  fs.writeFileSync(path.join(bin, 'herdr'), `#!/usr/bin/env node\nconsole.log(JSON.stringify({result:{pane:{pane_id:'w1:p1',workspace_id:'w1',label:'boss'}}}));\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, HERDR_BOSS_DIR: data, PATH: `${bin}:${process.env.PATH}`, HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HERDR_WORKSPACE_ID: 'w1' };
  delete env.NODE_TEST_CONTEXT;
  const cli = (...args) => spawnSync(process.execPath, [path.resolve('src/cli.js'), ...args], { cwd, env, encoding: 'utf8', timeout: 20000 });
  return { cwd, data, cli };
}

test('say --image accepts three repeats, links pictures and refuses a fourth before reading files', () => {
  const { cwd, data, cli } = cliFixture(); fs.writeFileSync(path.join(cwd, 'photo.png'), png);
  const sent = cli('say', '--image', 'photo.png', '--image', 'photo.png', '--image', 'photo.png', 'Three views.');
  assert.equal(sent.status, 0, sent.stderr);
  const stored = messages.readMessages({ dir: data }); assert.equal(stored.length, 1);
  assert.equal(stored[0].attachments.length, 3);
  for (const item of stored[0].attachments) assert.deepEqual((storedPng(data, item.id)), png);
  const refused = cli('say', ...Array(4).fill(['--image', 'missing.png']).flat(), 'Too many.');
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /at most 3/i);
  assert.equal(messages.readMessages({ dir: data }).length, 1);
});
function storedPng(dir, id) {
  return fs.readFileSync(path.join(dir, 'attachments', `${id}.png`));
}

test('mail post rewrites local pictures, keeps remote targets as text and exposes attachments in Mailbox', async () => {
  const { cwd, data, cli } = cliFixture(); fs.writeFileSync(path.join(cwd, 'photo.png'), png);
  const source = '# Views\n\n![Phone](photo.png)\n![Web](https://example.invalid/photo.png)\n![inline](data:image/png;base64,abc)\n';
  fs.writeFileSync(path.join(cwd, 'report.md'), source);
  const posted = cli('mail', 'post', '--to', 'owner', 'report.md'); assert.equal(posted.status, 0, posted.stderr);
  const record = messages.readMessages({ dir: data })[0];
  assert.equal(record.attachments.length, 1);
  assert.ok(record.text.includes(`![Phone](/attachments/${record.attachments[0].id})`));
  assert.ok(record.text.includes('![Web](https://example.invalid/photo.png)'));
  assert.ok(record.text.includes('![inline](data:image/png;base64,abc)'));
  assert.deepEqual(messages.mailboxView([record]).updates[0].attachments, record.attachments);
});

test('CLI reports missing, oversized, unsupported and escaping relative files without posting a message', () => {
  const { cwd, data, cli } = cliFixture();
  fs.writeFileSync(path.join(cwd, 'bad.png'), Buffer.from('not a picture'));
  fs.writeFileSync(path.join(cwd, 'huge.png'), Buffer.alloc(10 * 1024 * 1024 + 1));
  for (const [file, error] of [['missing.png', /missing|not found|cannot read/i], ['huge.png', /10 MB/], ['bad.png', /picture|supported/i]]) {
    const result = cli('say', '--image', file, 'Check.'); assert.notEqual(result.status, 0); assert.match(result.stderr, error);
    fs.writeFileSync(path.join(cwd, 'report.md'), `![view](${file})`);
    const report = cli('mail', 'post', '--to', 'owner', 'report.md'); assert.notEqual(report.status, 0); assert.match(report.stderr, error);
  }
  assert.deepEqual(messages.readMessages({ dir: data }), []);
});

for (const backend of ['json', 'sqlite']) {
  test(`${backend} deletion, dismissal and message retention delete linked pictures`, async () => {
    const { storeAttachment, readAttachment } = await import('../src/attachments.js');
    const { openMessageStore } = await import('../src/message-store.js');
    const dir = fs.mkdtempSync(path.join(root, `delete-${backend}-`));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ store: { messages: backend } }));
    const store = openMessageStore({ dir }); const now = Date.now();
    try {
      const deleted = storeAttachment(png, { dir, now });
      const record = store.append({ thread: 'boss', attachments: [deleted.id] }, { now });
      store.mutate((records) => ({ records: records.filter((item) => item.id !== record.id) }));
      assert.throws(() => readAttachment(deleted.id, { dir }), /not found/);
      const dismissed = storeAttachment(png, { dir, now });
      const mail = store.append({ thread: 'boss', from: 'boss', to: 'owner', kind: 'reply', action: 'approve', text: 'Review.', attachments: [dismissed.id] }, { now });
      assert.equal(messages.dismissMailboxItems({ ids: [mail.id] }, { dir, now }).ok, true);
      assert.throws(() => readAttachment(dismissed.id, { dir }), /not found/);
      const expired = storeAttachment(png, { dir, now });
      store.append({ thread: 'boss', attachments: [expired.id] }, { now });
      store.append({ thread: 'boss', text: 'Later.' }, { now: now + 31 * 86400000 });
      assert.throws(() => readAttachment(expired.id, { dir }), /not found/);
    } finally { store.close(); }
  });
}

test('the retention sweep uses a fake clock for unlinked, lost-message and linked uploads', async (t) => {
  const { storeAttachment, readAttachment, sweepAttachments } = await import('../src/attachments.js');
  const dir = fs.mkdtempSync(path.join(root, 'retention-'));
  const start = Date.now(); t.mock.timers.enable({ apis: ['Date'], now: start });
  const orphan = storeAttachment(png, { dir }); const linked = storeAttachment(png, { dir });
  const lost = storeAttachment(png, { dir });
  const record = messages.appendMessage({ attachments: [linked.id] }, { dir });
  messages.appendMessage({ attachments: [lost.id] }, { dir });
  assert.equal(sweepAttachments({ dir, records: [record], retentionDays: 1 }).deleted, 0);
  t.mock.timers.tick(3600001);
  assert.equal(sweepAttachments({ dir, records: [record], retentionDays: 1 }).deleted, 2);
  assert.throws(() => readAttachment(orphan.id, { dir })); assert.throws(() => readAttachment(lost.id, { dir }));
  assert.equal(readAttachment(linked.id, { dir }).id, linked.id);
  t.mock.timers.tick(86400000);
  assert.equal(sweepAttachments({ dir, records: [record], retentionDays: 1 }).deleted, 1);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'attachments')), []);
});

test('attachments retention has a policy default and validates integers from 1 to 365', async () => {
  const { POLICY_DEFAULTS, validatePolicy, loadPolicy } = await import('../src/control.js');
  const { loadModels } = await import('../src/kit/config.js');
  assert.deepEqual(POLICY_DEFAULTS.attachments, { retentionDays: 30 });
  const models = loadModels(); const policy = JSON.parse(JSON.stringify(POLICY_DEFAULTS));
  for (const value of [1, 30, 365]) { policy.attachments.retentionDays = value; assert.deepEqual(validatePolicy(policy, models), []); }
  for (const value of [0, 366, 1.5, '30', null]) { policy.attachments.retentionDays = value; assert.ok(validatePolicy(policy, models).some((error) => error.includes('attachments.retentionDays'))); }
  const file = path.join(root, 'legacy-policy.json'); fs.writeFileSync(file, '{}');
  assert.deepEqual(loadPolicy({ file }).attachments, { retentionDays: 30 });
});

test('the engine tick sweeps pictures at most once an hour with the saved retention setting', async (t) => {
  const { Engine } = await import('../src/engine.js');
  const start = Date.now(); t.mock.timers.enable({ apis: ['Date'], now: start });
  const calls = [];
  const oldActions = process.env.HERDR_BOSS_ALLOW_ACTIONS; process.env.HERDR_BOSS_ALLOW_ACTIONS = '1';
  t.after(() => { if (oldActions === undefined) delete process.env.HERDR_BOSS_ALLOW_ACTIONS; else process.env.HERDR_BOSS_ALLOW_ACTIONS = oldActions; });
  const engine = new Engine(cfg, { push: false, act: true, collectors: {
    collectHerdr: async () => ({ panes: [], workspaces: [] }), collectMachine: async () => null,
    collectProcesses: async () => new Map(), collectQuotas: async () => [], collectWorktreeCounts: async () => ({}),
    collectCwdProcesses: async () => [], collectMissingWorktreeProcesses: async () => [], checkHarness: () => [],
    collectPiModels: async () => ({ models: [] }), sweepCodeSignClones: async () => ({ removed: [], freedBytes: 0 }),
    sweepReviewPacks: async () => ({}), runDenialScan: async () => null, runSpendScan: async () => null,
    sweepAttachments: (options) => { calls.push(options); return { deleted: 0 }; },
  } });
  const { POLICY_DEFAULTS } = await import('../src/control.js');
  const policy = JSON.parse(JSON.stringify(POLICY_DEFAULTS)); policy.attachments = { retentionDays: 45 };
  fs.writeFileSync(path.join(process.env.HERDR_BOSS_DIR, 'policy.json'), JSON.stringify(policy));
  await engine.tick(); assert.equal(calls.length, 1);
  assert.equal(calls[0].retentionDays, 45); assert.equal(calls[0].now, start);
  await engine.tick(); assert.equal(calls.length, 1);
  t.mock.timers.tick(3600000); await engine.tick(); assert.equal(calls.length, 2);
});

test('upload rejects truncated containers and high-bit lookalike magic bytes', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 120000 });
  for (const [type, bytes] of Object.entries(pictures).filter(([type]) => !type.startsWith('image/hei'))) {
    assert.equal((await upload(type, bytes.subarray(0, bytes.length - 2))).status, 415, type);
  }
  const spoof = Buffer.from(gif); spoof[0] |= 0x80;
  assert.equal((await upload('image/gif', spoof)).status, 415);
});

test('upload rate limiting allows thirty requests and resets after a minute', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 300000 });
  for (let i = 0; i < 30; i += 1) assert.equal((await upload('image/png', png)).status, 200, `upload ${i + 1}`);
  assert.equal((await upload('image/png', png)).status, 429);
  t.mock.timers.tick(60001);
  assert.equal((await upload('image/png', png)).status, 200);
});

test('local file access resolves symlinks and allows outside files only by owned absolute paths', async () => {
  const { readLocalPicture } = await import('../src/attachments.js');
  const cwd = fs.mkdtempSync(path.join(root, 'path-rule-'));
  const tempDir = path.join(cwd, 'tmp'); fs.mkdirSync(tempDir);
  const outside = path.join(root, 'outside.png'); fs.writeFileSync(outside, png);
  const relative = path.relative(cwd, outside);
  assert.throws(() => readLocalPicture(relative, { cwd, tempDir }), /absolute regular file owned by you/);
  fs.symlinkSync(outside, path.join(cwd, 'escape.png'));
  assert.throws(() => readLocalPicture('escape.png', { cwd, tempDir }), /absolute regular file owned by you/);
  assert.deepEqual(readLocalPicture(outside, { cwd, tempDir }).bytes, png);
  assert.throws(() => readLocalPicture(cwd, { cwd, tempDir }), /regular file/);
});

test('Mailbox context records retain picture descriptors for the Owner message and answer', async () => {
  const { storeAttachment } = await import('../src/attachments.js');
  const dir = fs.mkdtempSync(path.join(root, 'mail-context-'));
  const picture = storeAttachment(png, { dir });
  const owner = messages.appendMessage({ thread: 'boss', from: 'owner', to: 'boss', kind: 'message', text: 'View.', attachments: [picture.id] }, { dir });
  const reply = messages.appendMessage({ thread: 'boss', from: 'boss', to: 'owner', kind: 'reply', text: 'Question.', action: 'approve', replyTo: owner.id }, { dir });
  const answerPicture = storeAttachment(png, { dir });
  const answer = messages.appendMessage({ thread: 'boss', from: 'owner', to: 'boss', kind: 'message', text: 'Answer.', replyTo: reply.id, attachments: [answerPicture.id] }, { dir });
  const view = messages.mailboxView(messages.readMessages({ dir })).needsYou[0];
  assert.deepEqual(view.ownerMessage.attachments, owner.attachments);
  assert.deepEqual(view.answer.attachments, answer.attachments);
});

test('mail uploads spaced local paths once and leaves code examples untouched', async () => {
  const { cwd, data, cli } = cliFixture(); fs.writeFileSync(path.join(cwd, 'photo view.png'), png);
  fs.writeFileSync(path.join(cwd, 'report.md'), '# View\n\n![One](<photo view.png>)\n![Two](<photo view.png> "title")\n`![example](missing.png)`\n\n```md\n![example](missing.png)\n```\n');
  const result = cli('mail', 'post', '--to', 'owner', 'report.md'); assert.equal(result.status, 0, result.stderr);
  const record = messages.readMessages({ dir: data })[0]; assert.equal(record.attachments.length, 1);
  const target = `/attachments/${record.attachments[0].id}`;
  assert.ok(record.text.includes(`![One](${target})`));
  assert.ok(record.text.includes(`![Two](${target} "title")`));
  assert.ok(record.text.includes('`![example](missing.png)`'));
  assert.ok(record.text.includes('```md\n![example](missing.png)\n```'));
});

test('repeatable picture options leave Watch and lease flag validation unchanged', () => {
  const { cli } = cliFixture();
  const watch = cli('watch', 'start', '--until', 'not-a-date');
  assert.notEqual(watch.status, 0); assert.doesNotMatch(watch.stderr, /repeat is not defined/);
  assert.match(watch.stderr, /date|HH:MM/i);
  const lease = cli('lease', 'bind', 'serve-ports', '4478', '--pid', 'invalid');
  assert.notEqual(lease.status, 0); assert.match(lease.stderr, /--pid must be a positive whole number/);
});
