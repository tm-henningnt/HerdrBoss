import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-review-retention-'));
const home = path.join(root, 'home');
const dir = path.join(root, 'data');
const source = path.join(root, 'source');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(dir, { recursive: true });
process.env.HOME = home;
process.env.HERDR_BOSS_DIR = dir;
process.env.HERDR_BOSS_LIVE_DIR = path.join(root, 'live');
process.env.HERDR_BOSS_PORT = '0';

const [
  { Engine },
  { loadConfig },
  { assertTempDataDir },
  store,
  messages,
  { openSqliteStore },
] = await Promise.all([
  import('../src/engine.js'),
  import('../src/config.js'),
  import('../src/data-dir-guard.js'),
  import('../src/review-store.js'),
  import('../src/messages.js'),
  import('../src/sqlite-store.js'),
]);

assertTempDataDir(dir);
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-10-01T08:00:00.000Z');
const PROJECTS = { shop: { slug: 'shop', workspace: 'ws-shop', orch: { pane: 'p-shop', kind: 'codex' } } };
const HERDR = { panes: [{ id: 'p-shop', label: 'orch', agent: 'codex', workspace: 'ws-shop' }] };
const EMPTY_SWEEP = { deleted: [], expired: [], purged: 0, cleaned: 0 };

test.after(() => {
  openSqliteStore({ dir }).close();
  fs.rmSync(root, { recursive: true, force: true });
});

function makePack(pack, now = T0) {
  const folder = path.join(source, pack);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({
    schema: 'herdr-boss.review-pack/1',
    id: pack,
    title: 'Retention test pack',
    sections: [{ id: 'section', title: 'Section', items: [
      { id: 'item', title: 'Evidence', type: 'markdown', text: 'Review this evidence.', ask: ['accept'] },
    ] }],
  }));
  const published = store.publishVersion({ dir, now, slug: 'shop', folder, publishedBy: 'orch' });
  const mail = messages.postReview({
    slug: 'shop', pack, title: 'Retention test pack', version: published.version, text: '1 item.', role: 'orch',
  }, { dir, now });
  return { published, mail };
}

function makeEngine(sweepReviewPacks) {
  const engine = new Engine(loadConfig(), {
    push: true,
    act: true,
    collectors: { sweepReviewPacks },
    herdrRunner: async () => '{}',
  });
  // The test runner disables engine actions by default. The runner is stubbed, so prompts stay local to this test.
  engine.push = true;
  return engine;
}

const countRows = (table, pack) => openSqliteStore({ dir }).db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE slug = ? AND pack = ?`).get('shop', pack).n;

test('the retention tick expires an open pack, closes its Mailbox item, and sends one orchestrator notice', async () => {
  const { mail } = makePack('retention-check');
  const notices = [];
  const engine = makeEngine(async (options) => store.sweep(options));
  engine.herdrRunner = async (_command, args) => { notices.push(args); return '{}'; };
  const expiredAt = T0 + 61 * DAY;

  await engine.sweepReviewPacks(expiredAt, { projects: PROJECTS }, HERDR);

  assert.equal(store.getPack({ dir, slug: 'shop', pack: 'retention-check' }).state, 'expired');
  assert.equal(messages.readMessages({ dir }).some((item) => item.id === mail.id), false, 'the normal prune removes the closed, 61-day-old item');
  assert.ok(engine.events.some((event) => event.type === 'review-retention' && event.closedItems === 1));
  assert.deepEqual(notices, [[
    'agent', 'prompt', 'p-shop',
    'The review pack "Retention test pack" (retention-check) expired after 60 days with no change. Publish it again if the Owner still needs it.',
  ]]);

  await engine.sweepReviewPacks(expiredAt + HOUR, { projects: PROJECTS }, HERDR);
  assert.equal(notices.length, 1);
});

test('the retention tick closes a stale Mailbox item and deletes a closed pack after 30 days', async () => {
  const { mail } = makePack('closed-check');
  const closedAt = T0 + 31 * DAY;
  store.submitPack({ dir, now: T0, slug: 'shop', pack: 'closed-check', verdict: 'accept', note: '' });
  const engine = makeEngine(async (options) => store.sweep(options));

  await engine.sweepReviewPacks(closedAt, { projects: PROJECTS }, HERDR);

  assert.equal(fs.existsSync(store.packDirectory(dir, 'shop', 'closed-check')), false);
  for (const table of ['review_packs', 'review_versions', 'review_items', 'review_files', 'review_answers']) {
    assert.equal(countRows(table, 'closed-check'), 0, table);
  }
  assert.equal(messages.readMessages({ dir }).some((item) => item.id === mail.id), false, 'the normal prune removes the closed, 31-day-old item');
  assert.ok(engine.events.some((event) => event.type === 'review-retention' && event.closedItems === 1));
});

test('the retention tick runs once at a time and no more than once an hour', async () => {
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const collectorStarted = new Promise((resolve) => { started = resolve; });
  let calls = 0;
  const engine = makeEngine(async () => {
    calls += 1;
    if (calls === 1) {
      started();
      await gate;
    }
    return EMPTY_SWEEP;
  });

  const first = engine.sweepReviewPacks(T0, { projects: PROJECTS }, HERDR);
  await collectorStarted;
  assert.equal(engine.sweepReviewPacks(T0 + HOUR, { projects: PROJECTS }, HERDR), null);
  release();
  await first;
  assert.equal(engine.sweepReviewPacks(T0 + HOUR - 1, { projects: PROJECTS }, HERDR), null);
  await engine.sweepReviewPacks(T0 + HOUR, { projects: PROJECTS }, HERDR);
  assert.equal(calls, 2);
});

test('a failed retention sweep is logged and a later tick still runs', async () => {
  let calls = 0;
  const engine = makeEngine(async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('private path omitted'), { code: 'EIO' });
    return EMPTY_SWEEP;
  });

  await assert.doesNotReject(engine.sweepReviewPacks(T0, { projects: PROJECTS }, HERDR));
  assert.ok(engine.events.some((event) => event.type === 'review-retention' && event.text === 'Review retention sweep failed (EIO).'));
  await engine.sweepReviewPacks(T0 + HOUR, { projects: PROJECTS }, HERDR);
  assert.equal(calls, 2);
});
