import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-quota-plan-service-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'quota-history.jsonl'), `${syntheticHistory().map((row) => JSON.stringify(row)).join('\n')}\n`);
  return { dir, service: createQuotaPlanService({ dataDir: dir }) };
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
