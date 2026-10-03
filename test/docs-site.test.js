import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-docs-site-'));
const repo = path.join(root, 'repo');
process.env.HOME = path.join(root, 'home');
process.env.HERDR_BOSS_DIR = path.join(root, 'data');
fs.mkdirSync(process.env.HOME, { recursive: true });
const { createDocsSite, pageName, firstHeading } = await import('../src/docs-site.js');
const { serve } = await import('../src/server.js');
const { loadConfig } = await import('../src/config.js');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
const put = (file, text) => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), text); };
put('README.md', '# Front\n\n<!-- hidden note -->\n\nStart with [Start here](docs/start-here.md#first-step) and the [guide](docs/guide/see.md).\n\n<picture>\n  <source media="(prefers-color-scheme: dark)" srcset="docs/images/shot-dark.png">\n  <img src="docs/images/shot.png" alt="The shot">\n</picture>\n');
put('docs/start-here.md', '# Start here\n\n## First step\n\nRead [the glossary](glossary.md) and [source](../src/x.js). See [below](#first-step).\n\n## First step\n\nSecond.\n\n[bad](javascript:alert(1)) [back](../README.md)\n');
put('docs/glossary.md', '# Glossary\n\n```\n<!-- keep -->\n```\n');
put('docs/guide/see.md', '# See\n\n![Shot](../images/shot.png)\n![Missing](../images/none.png)\n![Out](../../secret.png)\n\n[Up](../start-here.md)\n');
put('docs/guide/answer.md', '# Answer\n');
put('docs/reference/index.md', '# Reference\n');
put('docs/reference/api.md', '# API\n');
put('docs/help/board.md', '# Board\n\nIntro with **bold**.\n\n## Columns\n\nText.\n');
put('docs/diagram.md', '# D\n\n```mermaid\nflowchart TD\n  a --> b\n```\n\n```js\nlet x;\n```\n');
put('docs/images/shot.png', png);
put('docs/images/shot-dark.png', png);
put('docs/nav.json', JSON.stringify({ sections: [
  { title: 'Start', pages: ['', 'start-here', 'glossary', 'missing'] },
  { title: 'Guide', pages: ['guide/see', 'guide/answer'] },
  { title: 'Reference', pages: ['reference/*'] },
] }));
fs.writeFileSync(path.join(root, 'secret.md'), '# Secret\n\nSECRET-TEXT\n');
fs.writeFileSync(path.join(root, 'secret.png'), png);
fs.writeFileSync(path.join(repo, 'secret.md'), '# Root secret\n\nSECRET-TEXT\n');
fs.symlinkSync(path.join(root, 'secret.png'), path.join(repo, 'docs/images/link.png'));
fs.symlinkSync(path.join(root, 'secret.md'), path.join(repo, 'docs/linked.md'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const site = () => createDocsSite({ root: repo });

test('page names follow the file layout', () => {
  assert.equal(pageName('README.md'), '');
  assert.equal(pageName('docs/start-here.md'), 'start-here');
  assert.equal(pageName('docs/reference/index.md'), 'reference');
  assert.equal(firstHeading('text\n```\n# no\n```\n## also no\n# Real *title*\n'), 'Real title');
});

test('the tree follows nav.json, takes titles from headings, and skips a missing page', () => {
  const { status, body } = site().tree();
  assert.equal(status, 200);
  assert.deepEqual(body.sections.map((s) => s.title), ['Start', 'Guide', 'Reference']);
  assert.deepEqual(body.sections[0].pages, [{ name: '', title: 'Front' }, { name: 'start-here', title: 'Start here' }, { name: 'glossary', title: 'Glossary' }]);
  assert.deepEqual(body.sections[2].pages.map((p) => p.name), ['reference', 'reference/api']);
});

test('a page resolves relative links, anchors, and images', () => {
  const s = site();
  const start = s.page('start-here').body;
  assert.equal(start.title, 'Start here');
  assert.match(start.html, /<h1 id="d-start-here">Start here<\/h1>/);
  assert.match(start.html, /<h2 id="d-first-step">First step<\/h2>/);
  assert.match(start.html, /<h2 id="d-first-step-1">First step<\/h2>/);
  assert.match(start.html, /<a href="\/docs\/glossary">the glossary<\/a>/);
  assert.match(start.html, /<a href="#d-first-step">below<\/a>/);
  assert.match(start.html, /<a href="\/docs">back<\/a>/);
  assert.doesNotMatch(start.html, /javascript:|src\/x\.js/);
  assert.match(start.html, /source/);
  assert.deepEqual(start.headings.map((h) => h.id), ['d-first-step', 'd-first-step-1']);
  const see = s.page('guide/see').body.html;
  assert.match(see, /<img src="\/docs\/images\/shot\.png" alt="Shot" loading="lazy" class="md-image">/);
  assert.doesNotMatch(see, /none\.png|secret/);
  assert.match(see, /<a href="\/docs\/start-here">Up<\/a>/);
});

test('the front page is the README, a picture becomes a light and a dark image, and comments disappear', () => {
  const front = site().page('').body;
  assert.equal(front.source, 'README.md');
  assert.doesNotMatch(front.html, /hidden note|&lt;picture/);
  assert.match(front.html, /<a href="\/docs\/start-here#d-first-step">Start here<\/a>/);
  assert.match(front.html, /src="\/docs\/images\/shot\.png#only-light"/);
  assert.match(front.html, /src="\/docs\/images\/shot-dark\.png#only-dark"/);
  assert.match(site().page('glossary').body.html, /&lt;!-- keep --&gt;/);
});

test('a Mermaid block shows as source in a closed fold and other code stays as it is', () => {
  const html = site().page('diagram').body.html;
  assert.match(html, /<details class="docs-diagram"><summary>Diagram source \(Mermaid\)<\/summary><div class="md-code">[\s\S]*language-mermaid[\s\S]*a --&gt; b[\s\S]*<\/details>/);
  assert.equal(html.match(/<details/g).length, 1);
  assert.match(html, /<\/details><div class="md-code">[\s\S]*language-js/);
});

test('page help drops its title and starts at h3', () => {
  const { status, body } = site().help('board');
  assert.equal(status, 200);
  assert.equal(body.title, 'Board');
  assert.doesNotMatch(body.html, /<h1|<h2/);
  assert.match(body.html, /<h3>Columns<\/h3>/);
  assert.match(body.html, /<strong>bold<\/strong>/);
  assert.equal(site().help('nothing').status, 404);
  for (const topic of ['../board', 'a/b', '', 'Board', 'x'.repeat(41)]) assert.equal(site().help(topic).status, 400, topic);
});

test('a page name that leaves docs/ is refused and never returns the outside file', () => {
  const s = site();
  for (const name of ['../secret', '../../secret', 'guide/../../secret', '..', '/secret', '/etc/passwd', 'guide\\..\\..\\secret', 'a\0b', '%2e%2e/secret', 'linked', '../repo/secret']) {
    const answer = s.page(name);
    assert.ok([400, 404].includes(answer.status), `${JSON.stringify(name)} gave ${answer.status}`);
    assert.doesNotMatch(JSON.stringify(answer.body), /SECRET-TEXT/);
  }
  assert.equal(s.page('secret').status, 404);
  assert.equal(s.page('nothing').status, 404);
  assert.equal(s.page(['guide/see']).status, 400);
});

test('an image comes only from inside docs/', () => {
  const s = site();
  assert.equal(s.image('images/shot.png').type, 'image/png');
  assert.deepEqual(s.image('images/shot.png').bytes, png);
  for (const name of ['../secret.png', 'images/../../secret.png', 'images/link.png', 'images/none.png', 'start-here.md', 'nav.json', 'images/%2e%2e/x.png', '', 'images', 'images\\..\\..\\secret.png']) {
    assert.equal(s.image(name).status, 404, name);
  }
});

test('the cache renders again after the file changes', () => {
  const s = site();
  const first = s.page('guide/answer').body;
  assert.equal(s.page('guide/answer').body, first);
  const file = path.join(repo, 'docs/guide/answer.md');
  fs.writeFileSync(file, '# Answer changed\n');
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  let tick = 0;
  const fresh = createDocsSite({ root: repo, now: () => (tick += 10000) });
  assert.equal(fresh.page('guide/answer').body.title, 'Answer changed');
});

test('the routes answer at the HTTP boundary and need the login for a remote request', async (t) => {
  const cfg = loadConfig(); cfg.host = '127.0.0.1'; cfg.port = 0; cfg.tickSeconds = 3600;
  const app = serve(cfg, { liveDataDir: process.env.HERDR_BOSS_DIR, docsSite: site(), createEngine: () => {
    const engine = new EventEmitter(); engine.state = { control: { projects: {} } };
    engine.tick = async () => engine.state; engine.log = () => {}; return engine;
  } });
  if (!app.server.listening) await once(app.server, 'listening');
  t.after(() => app.close());
  const port = app.server.address().port;
  const raw = (route, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: route, headers }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  assert.equal((await raw('/api/docs/tree')).status, 200);
  const page = await raw('/api/docs/page?path=guide%2Fsee');
  assert.equal(JSON.parse(page.body).title, 'See');
  assert.equal(JSON.parse((await raw('/api/docs/help/board')).body).title, 'Board');
  const image = await raw('/docs/images/shot.png');
  assert.equal(image.status, 200);
  assert.equal(image.headers['content-type'], 'image/png');
  assert.equal(image.headers['x-content-type-options'], 'nosniff');
  for (const route of ['/api/docs/page?path=..%2Fsecret', '/api/docs/page?path=%2e%2e%2f%2e%2e%2fsecret', '/api/docs/page?path=%2Fetc%2Fpasswd', '/api/docs/help/..%2Fboard']) {
    const answer = await raw(route);
    assert.ok([400, 404].includes(answer.status), route);
    assert.doesNotMatch(answer.body.toString(), /SECRET-TEXT/);
  }
  for (const route of ['/docs/../secret.png', '/docs/%2e%2e/secret.png', '/docs/images%2f..%2f..%2fsecret.png', '/docs/images/link.png', '/docs/images/..%5c..%5csecret.png']) {
    const answer = await raw(route);
    assert.notEqual(answer.status === 200 && answer.headers['content-type'] === 'image/png' && answer.body.equals(png) && /secret|link/.test(route), true, route);
  }
  assert.equal((await raw('/docs/images/link.png')).status, 404);
  const remote = { host: 'fixture.tail0000.ts.net' };
  for (const route of ['/api/docs/tree', '/api/docs/page?path=', '/api/docs/help/board', '/docs/images/shot.png']) assert.equal((await raw(route, remote)).status, 401, route);
});
