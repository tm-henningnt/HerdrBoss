import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertTempDataDir } from '../src/data-dir-guard.js';
import { openSqliteStore } from '../src/sqlite-store.js';
import { getPack, getResultRecord, submitPack, putAnswer, publishVersion } from '../src/review-store.js';
import { reviewCommand } from '../src/review-cli.js';
import { readMessages } from '../src/messages.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots = [];
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

const tmp = (prefix) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
};

// A PNG header with the given size. `tag` makes the bytes differ between images.
function png(width, height, tag = 0) {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; ihdr[17] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(16, tag)]);
}

function write(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
}

// A pack folder about a checkout flow redesign: 2 sections and 4 items.
function packFolder({ id = 'checkout-redesign', tag = 0, edit } = {}) {
  const root = tmp('herdr-review-cli-pack-');
  const manifest = {
    schema: 'herdr-boss.review-pack/1',
    id,
    title: 'Checkout flow redesign',
    sections: [
      { id: 'cart', title: 'Cart', items: [
        { id: 'cart-themes', title: 'Cart, light and dark', type: 'image-pair', variant: 'theme',
          a: { src: 'img/cart-light.png', label: 'Light' }, b: { src: 'img/cart-dark.png', label: 'Dark' }, ask: ['accept', 'deny', 'note'] },
        { id: 'error-copy', title: 'Error messages', type: 'markdown', text: `The card was declined. Try another card.${tag ? ` Edit ${tag}.` : ''}`, ask: ['accept', 'deny', 'note'] },
      ] },
      { id: 'errors', title: 'Error handling', items: [
        { id: 'live-form', title: 'Staging checkout', type: 'link', url: 'https://staging.example.test/checkout', label: 'Staging checkout', ask: ['accept', 'deny', 'live'] },
        { id: 'release-notes', title: 'Release notes', type: 'markdown', text: 'Notes for the release.', ask: ['note'] },
      ] },
    ],
  };
  const files = { 'img/cart-light.png': png(390, 800, 1), 'img/cart-dark.png': png(390, 800, 2) };
  if (edit) edit(manifest, files);
  write(root, files);
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  return root;
}

const CONTROL = { projects: { shop: { slug: 'shop', workspace: 'wA', orch: { pane: 'wA:p1' } }, blog: { slug: 'blog', workspace: 'wC', orch: { pane: 'wC:p1' } } } };

// A CLI fixture with a fake herdr binary. `label` is the pane label. label === false runs as a plain terminal.
function fixture(t, label = 'orch', workspace = 'wA', paneId = 'wA:p1') {
  const root = tmp('herdr-review-cli-');
  const data = path.join(root, 'data');
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  for (const dir of [data, home, bin]) fs.mkdirSync(dir, { recursive: true });
  assertTempDataDir(data);
  fs.writeFileSync(path.join(bin, 'herdr'), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'pane' && args[1] === 'get') console.log(JSON.stringify({ result: { pane: { pane_id: args[2], workspace_id: ${JSON.stringify(workspace)}, label: ${JSON.stringify(label || null)} } } }));
else { console.error('unexpected herdr call'); process.exit(3); }
`);
  fs.chmodSync(path.join(bin, 'herdr'), 0o755);
  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ control: CONTROL }));
  const env = { ...process.env, HOME: home, HERDR_BOSS_DIR: data, PATH: `${bin}:${process.env.PATH}` };
  for (const key of ['NODE_TEST_CONTEXT', 'HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'HERDR_BOSS_LIVE_DIR']) delete env[key];
  if (label !== false) Object.assign(env, { HERDR_ENV: '1', HERDR_PANE_ID: paneId, HERDR_WORKSPACE_ID: workspace });
  const cli = (...args) => spawnSync(process.execPath, [path.join(repo, 'src', 'cli.js'), ...args], { cwd: root, env, encoding: 'utf8' });
  t.after(() => openSqliteStore({ dir: data }).close());
  return { cli, data, root };
}

const output = (result) => `${result.stdout}${result.stderr}`;
const reviewRecords = (data) => readMessages({ dir: data }).filter((record) => record.kind === 'review');
const noStore = (data) => !fs.existsSync(path.join(data, 'review-packs')) && !fs.existsSync(path.join(data, 'herdr-boss.db'));

// ---------- check ----------

test('review check accepts a valid folder from any pane and writes nothing', (t) => {
  const worker = fixture(t, 'worker', 'wA', 'wA:p2');
  const result = worker.cli('review', 'check', packFolder());
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /checkout-redesign/);
  assert.match(result.stdout, /2 sections/);
  assert.match(result.stdout, /4 items/);
  assert.ok(noStore(worker.data), 'check writes no review data');
  assert.deepEqual(readMessages({ dir: worker.data }), []);
});

test('review check exits 2 with each failed rule and prints no secret value', (t) => {
  const { cli } = fixture(t, false);
  const secret = 'ghp_abcdefghijklmnop1234567890';
  const folder = packFolder({ edit: (manifest, files) => {
    manifest.sections[0].items[1] = { id: 'error-copy', title: 'Error messages', type: 'markdown', body: 'notes/errors.md', ask: ['accept'] };
    manifest.sections[1].items[0].a = undefined;
    manifest.sections[1].items.push({ id: 'missing-image', title: 'Missing', type: 'image', src: 'img/none.png' });
    files['notes/errors.md'] = `The token is ${secret}\n`;
  } });
  const result = cli('review', 'check', folder);
  assert.equal(result.status, 2, output(result));
  assert.match(output(result), /secret/i);
  assert.match(output(result), /notes\/errors\.md/);
  assert.match(output(result), /img\/none\.png/);
  assert.ok(!output(result).includes(secret), 'the output holds no secret value');
});

test('review check refuses a text file over the size limit and a folder without a manifest', (t) => {
  const { cli } = fixture(t, false);
  const folder = packFolder({ edit: (manifest, files) => {
    manifest.sections[0].items[1] = { id: 'error-copy', title: 'Error messages', type: 'file', src: 'data/big.txt', ask: ['accept'] };
    files['data/big.txt'] = 'a'.repeat(2 * 1024 * 1024 + 1);
  } });
  const big = cli('review', 'check', folder);
  assert.equal(big.status, 2, output(big));
  assert.match(output(big), /data\/big\.txt/);
  const empty = cli('review', 'check', tmp('herdr-review-cli-empty-'));
  assert.equal(empty.status, 2, output(empty));
  assert.match(output(empty), /manifest\.json/);
});

test('review check warns about a file that no field names and still exits 0', (t) => {
  const { cli } = fixture(t, false);
  const folder = packFolder({ edit: (manifest, files) => { files['notes/extra.txt'] = 'Not named.\n'; } });
  const result = cli('review', 'check', folder);
  assert.equal(result.status, 0, output(result));
  assert.match(output(result), /notes\/extra\.txt/);
});

test('review check warns once per item with missing guidance and once per pack metadata gap', (t) => {
  const { cli } = fixture(t, false);
  const result = cli('review', 'check', packFolder());
  assert.equal(result.status, 0, output(result));
  const warnings = result.stdout.split('\n').filter((line) => line.startsWith('Warning:'));
  assert.equal(warnings.filter((line) => /needs description, steps, expected, link/.test(line)).length, 4);
  assert.equal(warnings.filter((line) => /items that lack verifiedBy/.test(line)).length, 1);
  assert.equal(warnings.filter((line) => /design pass is missing or not-run/.test(line)).length, 1);
});

test('review check warns when an agent-verified item has no evidence', (t) => {
  const { cli } = fixture(t, false);
  const folder = packFolder({ edit: (manifest) => {
    manifest.designPass = { reviewer: 'gpt-6.1-sol', result: 'passed' };
    for (const section of manifest.sections) for (const item of section.items) Object.assign(item, {
      description: 'The checkout step.\nWhy it matters.', steps: ['Open the test app.'],
      expected: 'The result appears.', link: 'https://app.example.test/checkout', verifiedBy: 'needs-you',
    });
    manifest.sections[0].items[0].verifiedBy = 'agent-verified';
  } });
  const result = cli('review', 'check', folder);
  assert.equal(result.status, 0, output(result));
  assert.equal(result.stdout.split('\n').filter((line) => line.startsWith('Warning:')).length, 1);
  assert.match(result.stdout, /agent-verified item cart-themes has no evidence/i);
});

// ---------- publish ----------

test('review publish from the orch pane stores version 1 and posts one Mailbox item', (t) => {
  const { cli, data } = fixture(t);
  const result = cli('review', 'publish', 'shop', packFolder());
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /Published shop\/checkout-redesign v1/);
  assert.match(result.stdout, /\/reviews\/shop\/checkout-redesign/);
  const pack = getPack({ dir: data, slug: 'shop', pack: 'checkout-redesign' });
  assert.equal(pack.version, 1);
  assert.equal(pack.items.length, 4);
  assert.equal(pack.publishedBy, 'orch');
  const [record] = reviewRecords(data);
  assert.equal(record.thread, 'shop');
  assert.equal(record.from, 'orch');
  assert.equal(record.to, 'owner');
  assert.equal(record.action, 'decide');
  assert.equal(record.status, 'new');
  assert.equal(record.title, 'Review: Checkout flow redesign (v1)');
  assert.match(record.text, /4 items in 2 sections/);
  assert.match(record.text, /\[Open review\]\(\/reviews\/shop\/checkout-redesign\)/);
  assert.deepEqual(record.review, { slug: 'shop', pack: 'checkout-redesign', version: 1 });
  assert.equal(pack.mailId, record.id);
});

test('review publish adds --note to the Mailbox text and refuses a note with a secret', (t) => {
  const { cli, data } = fixture(t);
  const folder = packFolder();
  const bad = cli('review', 'publish', 'shop', folder, '--note', 'password: hunter2');
  assert.equal(bad.status, 1, output(bad));
  assert.ok(!output(bad).includes('hunter2'));
  assert.ok(noStore(data) || getPack({ dir: data, slug: 'shop', pack: 'checkout-redesign' }) === null, 'a refused note publishes nothing');
  const ok = cli('review', 'publish', 'shop', folder, '--note', 'Please check the dark cart first.');
  assert.equal(ok.status, 0, output(ok));
  assert.match(reviewRecords(data)[0].text, /Please check the dark cart first\./);
});

test('a new version closes the older Mailbox item and posts a new one', (t) => {
  const { cli, data } = fixture(t);
  assert.equal(cli('review', 'publish', 'shop', packFolder()).status, 0);
  const first = reviewRecords(data)[0];
  putAnswer({ dir: data, now: Date.now(), slug: 'shop', pack: 'checkout-redesign', item: 'error-copy', patch: { rev: 0, decision: 'accept' } });
  const result = cli('review', 'publish', 'shop', packFolder({ tag: 1 }));
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /v2/);
  const records = reviewRecords(data);
  assert.equal(records.length, 2);
  const older = records.find((record) => record.id === first.id);
  const newer = records.find((record) => record.id !== first.id);
  assert.ok(older.closedAt, 'the older item is closed');
  assert.equal(older.closedBy, 'review');
  assert.ok(!newer.closedAt, 'the new item is open');
  assert.equal(newer.title, 'Review: Checkout flow redesign (v2)');
  assert.match(newer.text, /1 item changed since v1/);
  assert.equal(getPack({ dir: data, slug: 'shop', pack: 'checkout-redesign' }).mailId, newer.id);
});

test('publish caller rules: a worker, another project, and the Boss for a project slug are refused', (t) => {
  const worker = fixture(t, 'worker', 'wA', 'wA:p2');
  const refused = worker.cli('review', 'publish', 'shop', packFolder());
  assert.equal(refused.status, 1, output(refused));
  assert.match(refused.stderr, /worker|orch/i);
  assert.ok(noStore(worker.data));

  const other = fixture(t, 'orch', 'wA', 'wA:p1');
  const wrong = other.cli('review', 'publish', 'blog', packFolder());
  assert.equal(wrong.status, 1, output(wrong));
  assert.match(wrong.stderr, /shop/);
  assert.ok(noStore(other.data));

  const orphan = fixture(t, 'orch', 'wX', 'wX:p1');
  const none = orphan.cli('review', 'publish', 'shop', packFolder());
  assert.equal(none.status, 1, output(none));
  assert.match(none.stderr, /No project uses workspace wX/);

  const boss = fixture(t, 'boss', 'wB', 'wB:p1');
  const bossProject = boss.cli('review', 'publish', 'shop', packFolder());
  assert.equal(bossProject.status, 1, output(bossProject));
  assert.match(bossProject.stderr, /boss/);
  const bossOwn = boss.cli('review', 'publish', 'boss', packFolder());
  assert.equal(bossOwn.status, 0, output(bossOwn));
  assert.equal(reviewRecords(boss.data)[0].from, 'boss');
  assert.equal(reviewRecords(boss.data)[0].thread, 'boss');

  const bare = fixture(t, 'orch', 'wA', 'wA:p1');
  const env = { ...process.env, HERDR_PANE_ID: 'wA:p1', HERDR_WORKSPACE_ID: 'wA' };
  delete env.HERDR_ENV;
  const noEnv = spawnSync(process.execPath, [path.join(repo, 'src', 'cli.js'), 'review', 'publish', 'shop', packFolder()], { env: { ...env, HOME: path.join(bare.root, 'home'), HERDR_BOSS_DIR: bare.data, PATH: `${path.join(bare.root, 'bin')}:${process.env.PATH}` }, encoding: 'utf8' });
  assert.equal(noEnv.status, 1, output(noEnv));
  assert.match(noEnv.stderr, /HERDR_ENV/);
});

test('a plain terminal publishes for any slug', (t) => {
  const { cli, data } = fixture(t, false);
  const result = cli('review', 'publish', 'shop', packFolder());
  assert.equal(result.status, 0, output(result));
  assert.equal(reviewRecords(data)[0].thread, 'shop');
});

test('publish exits 2 for an invalid folder and 1 for a bad slug or usage', (t) => {
  const { cli, data } = fixture(t);
  const invalid = cli('review', 'publish', 'shop', tmp('herdr-review-cli-empty-'));
  assert.equal(invalid.status, 2, output(invalid));
  assert.ok(noStore(data));
  const slug = cli('review', 'publish', 'Not A Slug', packFolder());
  assert.equal(slug.status, 1, output(slug));
  const usage = cli('review', 'publish', 'shop');
  assert.equal(usage.status, 1, output(usage));
  assert.match(usage.stderr, /Usage: review publish/);
  const flag = cli('review', 'publish', 'shop', packFolder(), '--force');
  assert.equal(flag.status, 1, output(flag));
  assert.match(flag.stderr, /Unknown option: --force/);
});

test('publish refuses a secret in a text file without printing the value', (t) => {
  const { cli, data } = fixture(t);
  const secret = 'ghp_abcdefghijklmnop1234567890';
  const folder = packFolder({ edit: (manifest, files) => {
    manifest.sections[0].items[1] = { id: 'error-copy', title: 'Error messages', type: 'markdown', body: 'notes/errors.md', ask: ['accept'] };
    files['notes/errors.md'] = `Use ${secret} to sign in.\n`;
  } });
  const result = cli('review', 'publish', 'shop', folder);
  assert.equal(result.status, 2, output(result));
  assert.match(output(result), /notes\/errors\.md/);
  assert.ok(!output(result).includes(secret));
  assert.ok(noStore(data) || getPack({ dir: data, slug: 'shop', pack: 'checkout-redesign' }) === null);
  assert.deepEqual(reviewRecords(data), []);
});

test('publish refuses the sixth open pack and names the limit', (t) => {
  const { cli, data } = fixture(t);
  for (let index = 1; index <= 5; index += 1) assert.equal(cli('review', 'publish', 'shop', packFolder({ id: `pack-${index}` })).status, 0);
  const result = cli('review', 'publish', 'shop', packFolder({ id: 'pack-6' }));
  assert.equal(result.status, 1, output(result));
  assert.match(result.stderr, /5/);
  assert.equal(reviewRecords(data).length, 5);
});

test('publish --dry-run validates and prints the plan and writes nothing', (t) => {
  const { cli, data } = fixture(t);
  const result = cli('review', 'publish', 'shop', packFolder(), '--dry-run');
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /Dry run/);
  assert.match(result.stdout, /checkout-redesign/);
  assert.match(result.stdout, /4 items in 2 sections/);
  assert.ok(noStore(data), 'a dry run writes no review data');
  assert.deepEqual(readMessages({ dir: data }), []);
  const invalid = cli('review', 'publish', 'shop', tmp('herdr-review-cli-empty-'), '--dry-run');
  assert.equal(invalid.status, 2, output(invalid));
});

// ---------- import ----------

function htmlSource() {
  const root = tmp('herdr-review-cli-html-');
  write(root, {
    'index.html': '<!doctype html><html><head><title>Landing page redesign</title></head><body><h1>Landing</h1><a href="pricing.html">Pricing</a> <a href="about.html">About</a><img src="img/hero.png" alt="Hero, light"></body></html>',
    'about.html': '<html><head><title>About us</title></head><body><img src="img/team.png" alt="The team"><img src="img/logo.svg" alt="Logo"><img src="https://cdn.example.test/lib.png?token=abc123secret"><img src="data:image/png;base64,AAAA"><script src="https://cdn.example.test/app.js?key=zzz999"></script></body></html>',
    'pricing.html': '<html><head><title>Pricing</title></head><body><img src="img/hero.png" alt="Hero again"><img src="img/missing.png" alt="Gone"></body></html>',
    'img/hero.png': png(1200, 600, 5),
    'img/team.png': png(800, 400, 6),
    'img/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  });
  return root;
}

test('review import --dry-run lists sections, image items, external URLs, and skipped files and writes nothing', (t) => {
  const { cli, data } = fixture(t);
  const secretQuery = ['abc123secret', 'zzz999'];
  const result = cli('review', 'import', 'shop', htmlSource(), '--id', 'landing-redesign', '--dry-run');
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /Dry run/);
  assert.match(result.stdout, /3 sections/);
  assert.match(result.stdout, /3 pages/);
  assert.match(result.stdout, /2 images/);
  assert.match(result.stdout, /https:\/\/cdn\.example\.test\/lib\.png/);
  assert.match(result.stdout, /https:\/\/cdn\.example\.test\/app\.js/);
  assert.match(result.stdout, /img\/logo\.svg/);
  assert.match(result.stdout, /img\/missing\.png/);
  for (const value of secretQuery) assert.ok(!output(result).includes(value), 'a query string is not printed');
  assert.ok(noStore(data));
});

test('review import makes a section for each page and an item for each local image', (t) => {
  const { cli, data } = fixture(t);
  const result = cli('review', 'import', 'shop', htmlSource(), '--id', 'landing-redesign', '--title', 'Landing page redesign');
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /Published shop\/landing-redesign v1/);
  const pack = getPack({ dir: data, slug: 'shop', pack: 'landing-redesign' });
  assert.equal(pack.title, 'Landing page redesign');
  // The order follows the links in index.html (pricing, about), after index.html itself.
  assert.deepEqual(pack.manifest.sections.map((section) => section.title), ['Landing page redesign', 'Pricing', 'About us']);
  const types = (section) => section.items.map((item) => item.type);
  assert.deepEqual(types(pack.manifest.sections[0]), ['page', 'image']);
  assert.deepEqual(types(pack.manifest.sections[1]), ['page']);
  assert.deepEqual(types(pack.manifest.sections[2]), ['page', 'image']);
  const images = pack.manifest.sections.flatMap((section) => section.items).filter((item) => item.type === 'image');
  assert.deepEqual(images.map((item) => item.title), ['Hero, light', 'The team']);
  assert.deepEqual(images.map((item) => item.src), ['img/hero.png', 'img/team.png']);
  assert.ok(pack.files.some((file) => file.path === 'pricing.html'));
  assert.ok(!pack.files.some((file) => file.path.endsWith('.svg')), 'an SVG is never copied');
  const [record] = reviewRecords(data);
  assert.match(record.text, /5 items in 3 sections/);
});

test('review import takes one HTML file', (t) => {
  const { cli, data } = fixture(t);
  const source = htmlSource();
  const result = cli('review', 'import', 'shop', path.join(source, 'about.html'));
  assert.equal(result.status, 0, output(result));
  const pack = getPack({ dir: data, slug: 'shop', pack: 'about' });
  assert.deepEqual(pack.manifest.sections.map((section) => section.title), ['About us']);
  assert.deepEqual(pack.items.map((item) => item.type), ['page', 'image']);
});

test('review import applies the caller rules and refuses a folder with no HTML file', (t) => {
  const worker = fixture(t, 'worker', 'wA', 'wA:p2');
  const refused = worker.cli('review', 'import', 'shop', htmlSource());
  assert.equal(refused.status, 1, output(refused));
  assert.ok(noStore(worker.data));
  const { cli, data } = fixture(t);
  const wrong = cli('review', 'import', 'blog', htmlSource());
  assert.equal(wrong.status, 1, output(wrong));
  const none = cli('review', 'import', 'shop', tmp('herdr-review-cli-nohtml-'));
  assert.equal(none.status, 1, output(none));
  assert.match(none.stderr, /no HTML/i);
  assert.ok(noStore(data));
});

test('review import refuses a page that holds a secret without printing it', (t) => {
  const { cli, data } = fixture(t);
  const secret = 'ghp_abcdefghijklmnop1234567890';
  const source = tmp('herdr-review-cli-html-');
  write(source, { 'index.html': `<html><head><title>Docs</title></head><body><p>token ${secret}</p></body></html>` });
  const result = cli('review', 'import', 'shop', source);
  assert.equal(result.status, 2, output(result));
  assert.match(output(result), /index\.html/);
  assert.ok(!output(result).includes(secret));
  assert.deepEqual(reviewRecords(data), []);
});

// ---------- result, list, delete ----------

function published(t, label = 'orch') {
  const env = fixture(t, label);
  assert.equal(env.cli('review', 'publish', 'shop', packFolder()).status, 0);
  return env;
}

test('review result prints the Markdown summary and the JSON for both argument forms', (t) => {
  const { cli, data } = published(t);
  const none = cli('review', 'result', 'shop', 'checkout-redesign');
  assert.equal(none.status, 3, output(none));
  assert.match(none.stderr, /no result/i);
  const missing = cli('review', 'result', 'shop', 'unknown-pack');
  assert.equal(missing.status, 3, output(missing));

  const now = Date.now();
  putAnswer({ dir: data, now, slug: 'shop', pack: 'checkout-redesign', item: 'cart-themes', patch: { rev: 0, decision: 'deny', note: 'The total is hard to read in dark.' } });
  putAnswer({ dir: data, now, slug: 'shop', pack: 'checkout-redesign', item: 'error-copy', patch: { rev: 0, decision: 'accept' } });
  const submit = submitPack({ dir: data, now, slug: 'shop', pack: 'checkout-redesign', verdict: 'accept-with-changes', note: 'Fix the dark cart.' });
  assert.equal(submit.ok, true);

  const markdown = cli('review', 'result', 'shop', 'checkout-redesign');
  assert.equal(markdown.status, 0, output(markdown));
  assert.match(markdown.stdout, /Accept with changes/);
  assert.match(markdown.stdout, /Fix the dark cart\./);
  assert.match(markdown.stdout, /cart-themes/);
  assert.match(markdown.stdout, /The total is hard to read in dark\./);
  const slashed = cli('review', 'result', 'shop/checkout-redesign', '--json');
  assert.equal(slashed.status, 0, output(slashed));
  const json = JSON.parse(slashed.stdout);
  assert.equal(json.schema, 'herdr-boss.review-result/1');
  assert.equal(json.verdict, 'accept-with-changes');
  assert.equal(json.counts.denied, 1);
});

test('review result serves the stored result: Markdown by default, --format json|md, and --version', (t) => {
  const { cli, data } = published(t);
  const now = Date.now();
  putAnswer({ dir: data, now, slug: 'shop', pack: 'checkout-redesign', item: 'cart-themes', patch: { rev: 0, decision: 'deny', note: 'Too faint.' } });
  submitPack({ dir: data, now, slug: 'shop', pack: 'checkout-redesign', verdict: 'accept-with-changes', note: 'One.' });
  const stored = getResultRecord({ dir: data, slug: 'shop', pack: 'checkout-redesign' });
  const plain = cli('review', 'result', 'shop', 'checkout-redesign');
  assert.equal(plain.status, 0, output(plain));
  assert.equal(plain.stdout.trimEnd(), stored.markdown.trimEnd(), 'the default is the stored Markdown');
  const md = cli('review', 'result', 'shop', 'checkout-redesign', '--format', 'md', '--version', '1');
  assert.equal(md.stdout, plain.stdout);
  const json = cli('review', 'result', 'shop', 'checkout-redesign', '--version', '1', '--format', 'json');
  assert.equal(json.status, 0, output(json));
  assert.deepEqual(JSON.parse(json.stdout), stored.result);
  assert.deepEqual(JSON.parse(cli('review', 'result', 'shop', 'checkout-redesign', '--json').stdout), stored.result, '--json still works');
  const missing = cli('review', 'result', 'shop', 'checkout-redesign', '--version', '2');
  assert.equal(missing.status, 3, output(missing));
  assert.match(missing.stderr, /version 2/);
  for (const bad of [['--format', 'xml'], ['--version', '0'], ['--version', 'x'], ['--format', 'json', '--json']]) {
    const refused = cli('review', 'result', 'shop', 'checkout-redesign', ...bad);
    assert.equal(refused.status, 1, output(refused));
  }
});

test('review result takes a bare pack ID from an orch pane and refuses it from a plain terminal', (t) => {
  const { cli, data } = published(t);
  const now = Date.now();
  submitPack({ dir: data, now, slug: 'shop', pack: 'checkout-redesign', verdict: 'deny', note: 'Fine.' });
  const bare = cli('review', 'result', 'checkout-redesign', '--json');
  assert.equal(bare.status, 0, output(bare));
  assert.equal(JSON.parse(bare.stdout).slug, 'shop');
  const terminal = fixture(t, false);
  const refused = terminal.cli('review', 'result', 'checkout-redesign');
  assert.equal(refused.status, 1, output(refused));
  assert.match(refused.stderr, /slug/i);
});

test('review list prints open packs, filters by slug and state, and prints JSON', (t) => {
  const { cli, data } = published(t);
  assert.equal(cli('review', 'publish', 'shop', packFolder({ id: 'api-reference' })).status, 0);
  submitPack({ dir: data, now: Date.now(), slug: 'shop', pack: 'api-reference', verdict: 'accept', note: '' });
  const open = cli('review', 'list');
  assert.equal(open.status, 0, output(open));
  assert.match(open.stdout, /shop\/checkout-redesign/);
  assert.match(open.stdout, /v1/);
  assert.ok(!open.stdout.includes('api-reference'), 'the default list holds open packs only');
  const done = cli('review', 'list', 'shop', '--state', 'done');
  assert.match(done.stdout, /shop\/api-reference/);
  assert.match(done.stdout, /submitted Accept pack/);
  const all = JSON.parse(cli('review', 'list', '--state', 'all', '--json').stdout);
  assert.deepEqual(all.map((entry) => entry.pack).sort(), ['api-reference', 'checkout-redesign']);
  assert.equal(cli('review', 'list', '--state', 'bogus').status, 1);
});

test('review list works in a fresh data dir', (t) => {
  const { cli } = fixture(t, false);
  const result = cli('review', 'list');
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /No review packs/);
});

test('review delete removes the pack and closes its Mailbox item', (t) => {
  const { cli, data } = published(t);
  const files = path.join(data, 'review-packs', 'shop', 'checkout-redesign');
  assert.ok(fs.existsSync(files));
  const result = cli('review', 'delete', 'shop', 'checkout-redesign');
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /Deleted shop\/checkout-redesign/);
  assert.equal(getPack({ dir: data, slug: 'shop', pack: 'checkout-redesign' }), null);
  assert.ok(!fs.existsSync(files));
  const [record] = reviewRecords(data);
  assert.ok(record.closedAt);
  assert.equal(record.closedBy, 'review');
  const again = cli('review', 'delete', 'shop', 'checkout-redesign');
  assert.equal(again.status, 3, output(again));
});

test('review delete applies the caller rules', (t) => {
  const { data } = published(t);
  const worker = fixture(t, 'worker', 'wA', 'wA:p2');
  // The worker fixture has its own data dir, so point it at the published one.
  const env = { ...process.env, HERDR_BOSS_DIR: data, HOME: path.join(worker.root, 'home'), PATH: `${path.join(worker.root, 'bin')}:${process.env.PATH}`, HERDR_ENV: '1', HERDR_PANE_ID: 'wA:p2', HERDR_WORKSPACE_ID: 'wA' };
  delete env.NODE_TEST_CONTEXT;
  const refused = spawnSync(process.execPath, [path.join(repo, 'src', 'cli.js'), 'review', 'delete', 'shop', 'checkout-redesign'], { env, encoding: 'utf8' });
  assert.equal(refused.status, 1, output(refused));
  assert.ok(getPack({ dir: data, slug: 'shop', pack: 'checkout-redesign' }), 'the pack stays');
  const other = fixture(t, 'orch', 'wC', 'wC:p1');
  const wrong = other.cli('review', 'delete', 'shop', 'checkout-redesign');
  assert.equal(wrong.status, 1, output(wrong));
  assert.match(wrong.stderr, /blog/);
});

// ---------- usage ----------

test('review without a valid subcommand prints the usage and exits 1', (t) => {
  const { cli } = fixture(t, false);
  for (const args of [['review'], ['review', 'frobnicate'], ['review', 'check'], ['review', 'check', 'a', 'b'], ['review', 'import', 'shop'], ['review', 'result'], ['review', 'delete', 'shop']]) {
    const result = cli(...args);
    assert.equal(result.status, 1, `${args.join(' ')}: ${output(result)}`);
    assert.match(result.stderr, /Usage: review/);
  }
});

test('the herdr-boss usage text lists the review commands', (t) => {
  const { cli } = fixture(t, false);
  const help = cli('--help');
  const text = output(help);
  for (const name of ['review check', 'review publish', 'review import', 'review result', 'review delete', 'review list']) assert.match(text, new RegExp(name));
});

// ---------- Caller scope of result and list ----------

// Put a pack of another project into a data dir without the CLI.
function seedPack(data, slug, id) {
  publishVersion({ dir: data, now: Date.now(), slug, folder: packFolder({ id }), publishedBy: 'orch' });
}

test('result and list follow the caller scope of publish', (t) => {
  const orch = published(t);
  seedPack(orch.data, 'blog', 'api-reference');
  submitPack({ dir: orch.data, now: Date.now(), slug: 'blog', pack: 'api-reference', verdict: 'accept', note: '' });
  submitPack({ dir: orch.data, now: Date.now(), slug: 'shop', pack: 'checkout-redesign', verdict: 'deny', note: '' });

  // An orch pane sees its own slug only. The default list is the own slug.
  const own = JSON.parse(orch.cli('review', 'list', '--state', 'all', '--json').stdout);
  assert.deepEqual(own.map((entry) => entry.slug), ['shop']);
  assert.equal(orch.cli('review', 'list', 'shop').status, 0);
  for (const args of [['list', 'blog'], ['list', 'blog', '--json'], ['result', 'blog', 'api-reference'], ['result', 'blog/api-reference', '--json']]) {
    const refused = orch.cli('review', ...args);
    assert.equal(refused.status, 1, `${args.join(' ')}: ${output(refused)}`);
    assert.match(refused.stderr, /shop/);
    assert.ok(!output(refused).includes('api-reference') || /result|list/.test(refused.stderr));
  }
  assert.equal(orch.cli('review', 'result', 'shop', 'checkout-redesign').status, 0);

  // A worker pane is refused.
  const workerEnv = fixture(t, 'worker', 'wA', 'wA:p2');
  const shell = (fx, ...args) => spawnSync(process.execPath, [path.join(repo, 'src', 'cli.js'), ...args], {
    env: { ...process.env, HERDR_BOSS_DIR: orch.data, HOME: path.join(fx.root, 'home'), PATH: `${path.join(fx.root, 'bin')}:${process.env.PATH}`, HERDR_ENV: '1', HERDR_PANE_ID: fx.pane, HERDR_WORKSPACE_ID: fx.workspace },
    encoding: 'utf8',
  });
  workerEnv.pane = 'wA:p2'; workerEnv.workspace = 'wA';
  for (const args of [['review', 'list'], ['review', 'result', 'shop', 'checkout-redesign']]) {
    const refused = shell(workerEnv, ...args);
    assert.equal(refused.status, 1, `${args.join(' ')}: ${output(refused)}`);
    assert.match(refused.stderr, /worker|orch/i);
  }

  // The Boss lists every project and reads only the slug boss. A plain terminal reads everything.
  const bossEnv = fixture(t, 'boss', 'wB', 'wB:p1');
  bossEnv.pane = 'wB:p1'; bossEnv.workspace = 'wB';
  const bossList = JSON.parse(shell(bossEnv, 'review', 'list', '--state', 'all', '--json').stdout);
  assert.deepEqual(bossList.map((entry) => entry.slug).sort(), ['blog', 'shop']);
  const bossResult = shell(bossEnv, 'review', 'result', 'shop', 'checkout-redesign');
  assert.equal(bossResult.status, 1, output(bossResult));
  assert.match(bossResult.stderr, /boss/);
  const terminal = fixture(t, false);
  const shellAll = (...args) => spawnSync(process.execPath, [path.join(repo, 'src', 'cli.js'), ...args], {
    env: { ...process.env, HERDR_BOSS_DIR: orch.data, HOME: path.join(terminal.root, 'home'), HERDR_ENV: '', HERDR_PANE_ID: '', HERDR_WORKSPACE_ID: '' },
    encoding: 'utf8',
  });
  const all = JSON.parse(shellAll('review', 'list', '--state', 'all', '--json').stdout);
  assert.equal(all.length, 2);
  assert.equal(shellAll('review', 'result', 'blog', 'api-reference').status, 0);
});

// ---------- Publish order, repair, and idempotence ----------

const T = Date.parse('2026-10-05T08:00:00.000Z');

// Run reviewCommand in this process against a temporary data dir, as a plain terminal.
function inProcess(t) {
  const root = tmp('herdr-review-cli-inproc-');
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  assertTempDataDir(data);
  t.after(() => openSqliteStore({ dir: data }).close());
  const run = (args, deps = {}, now = T) => {
    const out = [];
    const err = [];
    const code = reviewCommand(args, { env: {}, dir: data, now, baseUrl: 'http://127.0.0.1:1', deps, out: (line) => out.push(line), err: (line) => err.push(line) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  return { data, run };
}

const openItems = (data) => reviewRecords(data).filter((record) => !record.closedAt);

test('a failed Mailbox post leaves the stored pack and names the repair, and the same publish then repairs it', (t) => {
  const { data, run } = inProcess(t);
  const folder = packFolder();
  const failed = run(['publish', 'shop', folder], { postReview: () => { throw new Error('disk full'); } });
  assert.equal(failed.code, 1);
  assert.match(failed.err, /shop\/checkout-redesign/);
  assert.match(failed.err, /v1/);
  assert.match(failed.err, /review publish/);
  assert.match(failed.err, /disk full/);
  assert.equal(getPack({ dir: data, slug: 'shop', pack: 'checkout-redesign' }).version, 1);
  assert.equal(reviewRecords(data).length, 0);

  const repaired = run(['publish', 'shop', folder]);
  assert.equal(repaired.code, 0, repaired.err);
  assert.match(repaired.out, /repair/i);
  const pack = getPack({ dir: data, slug: 'shop', pack: 'checkout-redesign' });
  assert.equal(pack.version, 1, 'the repair creates no new version');
  assert.equal(openItems(data).length, 1);
  assert.equal(pack.mailId, openItems(data)[0].id);
  assert.equal(openItems(data)[0].review.version, 1);
});

test('a failure after the Mailbox post is repaired without a second item', (t) => {
  const { data, run } = inProcess(t);
  const folder = packFolder();
  const failed = run(['publish', 'shop', folder], { setMailId: () => { throw new Error('database is locked'); } });
  assert.equal(failed.code, 1);
  assert.match(failed.err, /shop\/checkout-redesign/);
  assert.match(failed.err, /review publish/);
  assert.equal(reviewRecords(data).length, 1);
  assert.equal(getPack({ dir: data, slug: 'shop', pack: 'checkout-redesign' }).mailId, null);

  const repaired = run(['publish', 'shop', folder]);
  assert.equal(repaired.code, 0, repaired.err);
  assert.equal(reviewRecords(data).length, 1, 'no duplicate item');
  const pack = getPack({ dir: data, slug: 'shop', pack: 'checkout-redesign' });
  assert.equal(pack.version, 1);
  assert.equal(pack.mailId, reviewRecords(data)[0].id);
});

test('a failure of the store write posts nothing', (t) => {
  const { data, run } = inProcess(t);
  const failed = run(['publish', 'shop', packFolder()], { publishVersion: () => { throw new Error('no space left'); } });
  assert.equal(failed.code, 1);
  assert.match(failed.err, /no space left/);
  assert.equal(reviewRecords(data).length, 0);
  assert.equal(getPack({ dir: data, slug: 'shop', pack: 'checkout-redesign' }), null);
});

test('a publish of unchanged content makes no new version and no new item', (t) => {
  const { data, run } = inProcess(t);
  const folder = packFolder();
  assert.equal(run(['publish', 'shop', folder]).code, 0);
  const again = run(['publish', 'shop', folder], {}, T + 1000);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /unchanged/i);
  assert.equal(getPack({ dir: data, slug: 'shop', pack: 'checkout-redesign' }).version, 1);
  assert.equal(reviewRecords(data).length, 1);
  assert.equal(openItems(data).length, 1);
  // Changed content still makes version 2.
  const changed = run(['publish', 'shop', packFolder({ tag: 1 })], {}, T + 2000);
  assert.equal(changed.code, 0, changed.err);
  assert.equal(getPack({ dir: data, slug: 'shop', pack: 'checkout-redesign' }).version, 2);
  assert.equal(openItems(data).length, 1);
});

test('an unchanged publish repairs a closed item, and a submitted pack opens as a new version', (t) => {
  const { data, run } = inProcess(t);
  const folder = packFolder();
  assert.equal(run(['publish', 'shop', folder]).code, 0);
  submitPack({ dir: data, now: T, slug: 'shop', pack: 'checkout-redesign', verdict: 'deny', note: '' });
  const reopened = run(['publish', 'shop', folder], {}, T + 1000);
  assert.equal(reopened.code, 0, reopened.err);
  assert.equal(getPack({ dir: data, slug: 'shop', pack: 'checkout-redesign' }).version, 2, 'a submitted pack takes the next version');
  assert.equal(openItems(data).length, 1);
});

test('the dry run of an unchanged pack writes nothing', (t) => {
  const { data, run } = inProcess(t);
  const folder = packFolder();
  assert.equal(run(['publish', 'shop', folder]).code, 0);
  const before = readMessages({ dir: data }).length;
  assert.equal(run(['publish', 'shop', folder, '--dry-run']).code, 0);
  assert.equal(readMessages({ dir: data }).length, before);
});

// ---------- Terminal output from imported HTML ----------

test('the import output holds no control character and no long line from a hostile page', (t) => {
  const { cli } = fixture(t, false);
  const source = tmp('herdr-review-cli-html-');
  const long = 'n'.repeat(400);
  write(source, {
    'index.html': `<!doctype html><title>Docs\u001b[2J\u001b]0;pwn\u0007 site</title><img src="img/\u001b[2Jname.png"><img src="https://cdn.example.test/a\u001b[31mb.png"><script src="local/${long}.js"></script><a href="x.html">x</a>`,
    'x.html': '<!doctype html><title>Second\u0007 page</title>',
  });
  const result = cli('review', 'import', 'shop', source, '--id', 'hostile', '--dry-run');
  assert.equal(result.status, 0, output(result));
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(output(result)), JSON.stringify(output(result)));
  assert.ok(output(result).split('\n').every((line) => line.length < 500), 'each line is short');
  assert.match(output(result), /img\//);
});
