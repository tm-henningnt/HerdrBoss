import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openMessageStore } from '../src/message-store.js';
import { createQuotaPlanService } from '../src/quota-plan-service.js';

const HOUR = 3600000;
const NOW = Date.parse('2032-04-01T00:00:00.000Z');
const at = (hours) => new Date(NOW + hours * HOUR).toISOString();

function quota(credits = []) {
  return [{
    provider: 'codex',
    observedAt: at(0),
    windows: [{ key: 'primary', label: 'Weekly', usedPercent: 1, resetsAt: at(168), windowMinutes: 10080 }],
    resetCredits: credits.filter((credit) => credit.status === 'available').length,
    codexResetCredits: credits,
  }];
}

function syntheticHistory() {
  return Array.from({ length: 337 }, (_, hour) => {
    const withinWindow = hour % 168;
    const dayHour = hour % 24;
    let usedPercent = 0;
    for (let step = 0; step < withinWindow; step += 1) {
      const h = step % 24;
      usedPercent += h < 8 ? 0 : h < 12 ? 1.5 : 0.5;
    }
    const windowStart = hour - withinWindow;
    return {
      at: new Date(NOW + (hour - 336) * HOUR).toISOString(),
      provider: 'codex', window: 'primary', usedPercent,
      resetsAt: new Date(NOW + (windowStart - 336 + 168) * HOUR).toISOString(),
    };
  });
}

function setup(t, { withMailbox = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-quota-plan-service-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'quota-history.jsonl'), `${syntheticHistory().map((row) => JSON.stringify(row)).join('\n')}\n`);
  const messageStore = withMailbox ? openMessageStore({ dir, backend: 'json' }) : null;
  return { dir, messageStore, service: createQuotaPlanService({ dataDir: dir, now: () => NOW, messageStore }) };
}

test('service reads the weekly Codex quota and synthetic history without exposing other credit fields', (t) => {
  const { dir, service } = setup(t);
  const credits = [{
    id: 'credit-a', status: 'available', grantedAt: at(-24), expiresAt: at(400),
    accountId: 'must-not-leak', email: 'private@example.invalid', token: 'secret-value',
  }];
  const result = service.replan({ provider: 'codex', quotas: quota(credits), now: NOW });

  assert.equal(result.provider, 'codex');
  assert.equal(result.usedPercent, 1);
  assert.equal(result.windowHours, 168);
  assert.equal(result.historicalP90, 1.5);
  assert.equal(result.credits.length, 1);
  assert.equal(result.credits[0].id, 'credit-a');
  assert.ok(result.plan.fast);
  assert.equal(result.burstTable.length, 5);
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak|private@example|secret-value/);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'quota-plan.json'), 'utf8'));
  assert.equal(saved.plans.length, 1);
  assert.deepEqual(saved.plans[0].creditTimes, result.plan.credits.map((credit) => credit.applyAt));
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.tmp')), []);
});

test('service selects the longest measured non-extra Codex window', (t) => {
  const { service } = setup(t);
  const result = service.replan({
    provider: 'codex',
    quotas: [{
      provider: 'codex',
      windows: [
        { key: 'primary', usedPercent: 12, resetsAt: at(5), windowMinutes: 300 },
        { key: 'weekly', usedPercent: 40, resetsAt: at(168), windowMinutes: 10080 },
        { key: 'model-extra', usedPercent: 90, resetsAt: at(20), windowMinutes: 10080, extra: true },
      ],
      resetCredits: 0,
      codexResetCredits: [],
    }],
    now: NOW,
  });

  assert.equal(result.usedPercent, 40);
  assert.equal(result.resetsAt, at(168));
  assert.equal(result.windowHours, 168);
});

test('service re-plans when credits or announcements change and bounds plan history', (t) => {
  const { dir, service } = setup(t);
  const first = service.replan({ provider: 'codex', quotas: quota([{ id: 'credit-a', status: 'available', expiresAt: at(400) }]), now: NOW });
  const withNewCredit = service.replan({ provider: 'codex', quotas: quota([
    { id: 'credit-a', status: 'available', expiresAt: at(400) },
    { id: 'credit-b', status: 'available', expiresAt: at(600) },
    { id: 'credit-c', status: 'used', expiresAt: at(650) },
  ]), now: NOW });
  assert.notEqual(withNewCredit.inputsDigest, first.inputsDigest);
  assert.deepEqual(withNewCredit.credits.map((credit) => credit.id), ['credit-a', 'credit-b']);

  const announcement = service.announce({ provider: 'codex', at: at(72), kind: 'partial', refundPercent: 15, now: NOW, quotas: quota([
    { id: 'credit-a', status: 'available', expiresAt: at(400) },
    { id: 'credit-b', status: 'available', expiresAt: at(600) },
  ]) });
  assert.equal(announcement.kind, 'partial');
  assert.equal(announcement.refundPercent, 15);
  assert.equal(service.read().announcements.length, 1);
  assert.equal(service.read().plans.length, 3);

  const beforeBound = JSON.parse(fs.readFileSync(path.join(dir, 'quota-plan.json'), 'utf8'));
  beforeBound.plans = Array.from({ length: 50 }, (_, index) => ({ at: at(index), inputsDigest: `fixture-${index}`, creditTimes: [] }));
  fs.writeFileSync(path.join(dir, 'quota-plan.json'), JSON.stringify(beforeBound));
  service.replan({ provider: 'codex', quotas: quota([{ id: 'credit-new', status: 'available', expiresAt: at(410) }]), now: NOW });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'quota-plan.json'), 'utf8'));
  assert.equal(saved.plans.length, 50);
});

test('service records a detected reset drop and plans again', (t) => {
  const { dir, service } = setup(t);
  const historyFile = path.join(dir, 'quota-history.jsonl');
  fs.writeFileSync(historyFile, `${[
    { at: at(-2), provider: 'codex', window: 'primary', usedPercent: 80, resetsAt: at(168) },
    { at: at(-1), provider: 'codex', window: 'primary', usedPercent: 40, resetsAt: at(168) },
  ].map((row) => JSON.stringify(row)).join('\n')}\n`);
  const result = service.replan({ provider: 'codex', quotas: quota(), now: NOW });

  assert.equal(service.read().observedResets.length, 1);
  assert.equal(service.read().observedResets[0].dropPercent, 40);
  assert.equal(service.read().plans.length, 1);
  assert.equal(result.provider, 'codex');
});

test('service rejects unsupported providers and validates announced reset times', (t) => {
  const { service } = setup(t);
  assert.throws(() => service.replan({ provider: 'claude', quotas: [], now: NOW }), /only codex is supported/i);
  assert.throws(() => service.announce({ provider: 'codex', at: at(-1), now: NOW }), /future/i);
  assert.throws(() => service.announce({ provider: 'codex', at: at(31 * 24), now: NOW }), /30 days/i);
  assert.throws(() => service.announce({ provider: 'codex', at: at(1), kind: 'partial', refundPercent: 101, now: NOW }), /refund/i);
});

test('quota tick posts one approval item when a credit is due or expires within 48 hours', (t) => {
  const { service, messageStore } = setup(t, { withMailbox: true });
  const quotas = quota([{ id: 'credit-due', status: 'available', expiresAt: at(400) }]);
  quotas[0].windows[0].usedPercent = 95;

  const result = service.replan({ provider: 'codex', quotas, now: NOW });
  let items = messageStore.all().filter((item) => item.quotaCreditId === 'credit-due' && !item.closedAt);
  assert.equal(result.credits[0].applyAt, at(0));
  assert.equal(items.length, 1);
  assert.equal(items[0].action, 'approve');
  assert.match(items[0].text, /95%/);
  assert.match(items[0].text, new RegExp(new Date(NOW).toISOString()));
  assert.match(items[0].text, /Value of applying now against waiting/);
  assert.match(items[0].text, new RegExp(at(400)));

  service.replan({ provider: 'codex', quotas, now: NOW + 60000 });
  items = messageStore.all().filter((item) => item.quotaCreditId === 'credit-due' && !item.closedAt);
  assert.equal(items.length, 1, 'a later quota tick must reuse the open item');

  const expiring = quota([{ id: 'credit-expiring', status: 'available', expiresAt: at(47) }]);
  service.replan({ provider: 'codex', quotas: expiring, now: NOW });
  assert.equal(messageStore.all().filter((item) => item.quotaCreditId === 'credit-expiring' && !item.closedAt).length, 1);
});

test('quota plan exposes one warn notice in the 24 hours before each credit expires', (t) => {
  const { service } = setup(t);
  service.replan({ provider: 'codex', quotas: quota([{ id: 'credit-soon', status: 'available', expiresAt: at(48) }]), now: NOW });

  assert.deepEqual(service.expiryNotices({ now: NOW + 23 * HOUR }).map((notice) => notice.key), []);
  const notices = service.expiryNotices({ now: NOW + 24 * HOUR });
  assert.equal(notices.length, 1);
  assert.equal(notices[0].severity, 'warn');
  assert.match(notices[0].text, new RegExp(at(48)));
  assert.deepEqual(service.expiryNotices({ now: NOW + 25 * HOUR }).map((notice) => notice.key), [notices[0].key]);
  assert.deepEqual(service.expiryNotices({ now: NOW + 49 * HOUR }), []);
});

test('marking a credit used closes its open approval item', (t) => {
  const { service, messageStore } = setup(t, { withMailbox: true });
  const quotas = quota([{ id: 'credit-used', status: 'available', expiresAt: at(47) }]);
  service.replan({ provider: 'codex', quotas, now: NOW });
  const item = messageStore.all().find((message) => message.quotaCreditId === 'credit-used');
  assert.ok(item);

  service.markCreditUsed({ provider: 'codex', id: 'credit-used', now: NOW + HOUR, quotas });

  const closed = messageStore.all().find((message) => message.id === item.id);
  assert.ok(closed.closedAt);
  assert.ok(service.read().usedCredits.some((credit) => credit.id === 'credit-used'));
});

test('an observed usage drop closes and marks the soonest-expiring open credit prompt used', (t) => {
  const { dir, service, messageStore } = setup(t, { withMailbox: true });
  const quotas = quota([{ id: 'credit-observed', status: 'available', expiresAt: at(47) }]);
  service.replan({ provider: 'codex', quotas, now: NOW - HOUR });
  const item = messageStore.all().find((message) => message.quotaCreditId === 'credit-observed');
  assert.ok(item);
  fs.writeFileSync(path.join(dir, 'quota-history.jsonl'), `${[
    { at: at(-2), provider: 'codex', window: 'primary', usedPercent: 80, resetsAt: at(168) },
    { at: at(-1), provider: 'codex', window: 'primary', usedPercent: 40, resetsAt: at(168) },
  ].map((row) => JSON.stringify(row)).join('\n')}\n`);

  service.replan({ provider: 'codex', quotas, now: NOW });

  const closed = messageStore.all().find((message) => message.id === item.id);
  assert.ok(closed.closedAt);
  assert.ok(service.read().usedCredits.some((credit) => credit.id === 'credit-observed'));
});

function writeDrop(dir, { beforeAt, afterAt, before, after, resetsAt }) {
  fs.writeFileSync(path.join(dir, 'quota-history.jsonl'), `${[
    { at: beforeAt, provider: 'codex', window: 'primary', usedPercent: before, resetsAt },
    { at: afterAt, provider: 'codex', window: 'primary', usedPercent: after, resetsAt: at(168) },
  ].map((row) => JSON.stringify(row)).join('\n')}\n`);
}

test('a natural weekly rollover is recorded and marks no credit used', (t) => {
  const { dir, service, messageStore } = setup(t, { withMailbox: true });
  const quotas = quota([{ id: 'credit-roll', status: 'available', expiresAt: at(47) }]);
  service.replan({ provider: 'codex', quotas, now: NOW - HOUR });
  writeDrop(dir, { beforeAt: at(-3), afterAt: at(0), before: 96, after: 2, resetsAt: at(-1) });

  service.replan({ provider: 'codex', quotas, now: NOW });

  assert.equal(service.read().observedResets.length, 1);
  assert.deepEqual(service.read().usedCredits, []);
  assert.equal(messageStore.all().filter((item) => item.quotaCreditId === 'credit-roll' && !item.closedAt).length, 1);
});

test('the 10-minute tolerance before the regular reset time separates a natural reset from a credit use', (t) => {
  const { dir, service } = setup(t);
  const quotas = quota([{ id: 'credit-edge', status: 'available', expiresAt: at(47) }]);
  writeDrop(dir, { beforeAt: at(-3), afterAt: at(0), before: 96, after: 2, resetsAt: at(0.15) });
  service.replan({ provider: 'codex', quotas, now: NOW });
  assert.deepEqual(service.read().usedCredits, [], 'a drop 9 minutes before the reset time is a natural reset');

  const second = setup(t);
  writeDrop(second.dir, { beforeAt: at(-3), afterAt: at(0), before: 96, after: 2, resetsAt: at(0.5) });
  second.service.replan({ provider: 'codex', quotas, now: NOW });
  assert.equal(second.service.read().usedCredits.length, 1, 'a drop 30 minutes before the reset time is a credit use');
});

test('a usage drop marks the earliest-expiry credit even when it has no open item', (t) => {
  const { dir, service, messageStore } = setup(t, { withMailbox: true });
  service.replan({ provider: 'codex', quotas: quota([{ id: 'credit-a', status: 'available', expiresAt: at(47) }]), now: NOW - HOUR });
  const itemA = messageStore.all().find((item) => item.quotaCreditId === 'credit-a');
  assert.ok(itemA);
  writeDrop(dir, { beforeAt: at(-2), afterAt: at(-1), before: 80, after: 40, resetsAt: at(168) });

  service.replan({ provider: 'codex', now: NOW, quotas: quota([
    { id: 'credit-a', status: 'available', expiresAt: at(47) },
    { id: 'credit-b', status: 'available', expiresAt: at(30) },
  ]) });

  assert.deepEqual(service.read().usedCredits.map((credit) => credit.id), ['credit-b']);
  assert.equal(messageStore.all().find((item) => item.id === itemA.id).closedAt, undefined);
});

test('a usage drop closes the item of the earliest-expiry credit', (t) => {
  const { dir, service, messageStore } = setup(t, { withMailbox: true });
  const quotas = quota([{ id: 'credit-a', status: 'available', expiresAt: at(47) }]);
  service.replan({ provider: 'codex', quotas, now: NOW - HOUR });
  writeDrop(dir, { beforeAt: at(-2), afterAt: at(-1), before: 80, after: 40, resetsAt: at(168) });
  service.replan({ provider: 'codex', quotas, now: NOW });
  assert.ok(messageStore.all().find((item) => item.quotaCreditId === 'credit-a').closedAt);
  assert.deepEqual(service.read().usedCredits.map((credit) => credit.id), ['credit-a']);
});

test('a closed credit item is not posted again, and a changed expiry allows one new item', (t) => {
  const { service, messageStore } = setup(t, { withMailbox: true });
  const quotas = quota([{ id: 'credit-closed', status: 'available', expiresAt: at(47) }]);
  service.replan({ provider: 'codex', quotas, now: NOW });
  const [item] = messageStore.all().filter((message) => message.quotaCreditId === 'credit-closed');
  messageStore.update(item.id, { closedAt: at(0) }, { now: NOW });

  service.replan({ provider: 'codex', quotas, now: NOW + HOUR });
  service.replan({ provider: 'codex', quotas, now: NOW + 2 * HOUR });
  assert.equal(messageStore.all().filter((message) => message.quotaCreditId === 'credit-closed').length, 1);

  const moved = quota([{ id: 'credit-closed', status: 'available', expiresAt: at(46) }]);
  service.replan({ provider: 'codex', quotas: moved, now: NOW + 3 * HOUR });
  service.replan({ provider: 'codex', quotas: moved, now: NOW + 4 * HOUR });
  assert.equal(messageStore.all().filter((message) => message.quotaCreditId === 'credit-closed').length, 2);
});

test('the credit prompt check and append run in one store mutate', (t) => {
  const { dir } = setup(t);
  const real = openMessageStore({ dir, backend: 'json' });
  // A stale read and a direct append stand for a second replan that races this one.
  const racing = { ...real, all: () => [], append: () => { throw new Error('append outside mutate'); } };
  const service = createQuotaPlanService({ dataDir: dir, now: () => NOW, messageStore: racing });
  const quotas = quota([{ id: 'credit-race', status: 'available', expiresAt: at(47) }]);

  service.replan({ provider: 'codex', quotas, now: NOW });
  service.replan({ provider: 'codex', quotas, now: NOW + 60000 });

  assert.equal(real.all().filter((item) => item.quotaCreditId === 'credit-race').length, 1);
});
