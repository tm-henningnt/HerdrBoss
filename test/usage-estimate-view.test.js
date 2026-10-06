import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const fixture = JSON.parse(fs.readFileSync(new URL('../docs/contracts/examples/fleet-summary.valid.opencode-estimate.json', import.meta.url)));
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('the estimate text shows tokens and cost with the label and never a percent', async () => {
  const { usageEstimateText, ESTIMATE_LABEL, compactTokens } = await import('../public/usage-estimate.js');
  assert.equal(ESTIMATE_LABEL, 'used in this factory (local estimate)');
  assert.equal(compactTokens(270_018_600), '270.0m');
  assert.equal(compactTokens(18_600), '18.6k');
  assert.equal(compactTokens(950), '950');
  assert.equal(usageEstimateText({ days: 7, tokens: 270_018_600, costUsd: 2.37, omittedModels: 0 }), '270.0m tokens, $2.37 in the last 7 days');
  assert.match(usageEstimateText({ days: 1, tokens: 5, costUsd: 0, omittedModels: 2 }), /^5 tokens, \$0\.00 in the last 1 day \(2 more models not counted\)$/);
  assert.equal(usageEstimateText(null), null);
});

test('the Fleet factory card shows the OpenCode Go estimate with its label and the manual reset time', async () => {
  const { fleetView } = await import('../public/fleet.js');
  const { buildFleetRollup } = await import('../src/fleet-rollup.js');
  const rows = [{ name: 'win1', status: 'healthy', ageSeconds: 0, kind: 'container', lastSeenAt: fixture.generatedAt, summary: { ...fixture, kind: 'container', factoryId: 'win1', name: 'win1' } }];
  const rollup = buildFleetRollup(rows, { now: Date.parse('2026-10-05T12:00:00Z') });
  const html = fleetView({ factories: rows, pollSeconds: 30, rollup });
  assert.match(html, /data-fleet-estimate="opencode"/);
  assert.match(html, /used in this factory \(local estimate\)/);
  assert.match(html, /270\.0m tokens, \$2\.37 in the last 7 days/);
  assert.match(html, /unknown/i);
  const block = html.slice(html.indexOf('data-fleet-estimate'), html.indexOf('data-fleet-estimate') + 700);
  assert.doesNotMatch(block, /\d%/);
  assert.match(html, /data-fleet-lane="codex-primary"/);
});

test('the usage limit card of OpenCode Go uses the estimate helper', async () => {
  const { unknownQuotaDetailHtml } = await import('../public/usage-estimate.js');
  const html = unknownQuotaDetailHtml({ provider: 'opencodego', unavailable: true, reason: 'no usage reader in this factory', resetAt: '2026-10-09T08:00:00.000Z',
    estimate: { days: 7, tokens: 270_018_600, costUsd: 2.37, omittedModels: 0, models: [{ model: 'opencode-go/qwen3.8-flash', tokens: 18_600, costUsd: 0 }] } }, (v) => String(v), (v) => `T:${v}`);
  assert.match(html, /used in this factory \(local estimate\)/);
  assert.match(html, /270\.0m tokens, \$2\.37 in the last 7 days/);
  assert.match(html, /Resets T:2026-10-09T08:00:00\.000Z \(set by hand\)/);
  assert.match(html, /opencode-go\/qwen3\.8-flash/);
  assert.equal(unknownQuotaDetailHtml({ provider: 'codex', unavailable: true }, String, String), '');
  assert.match(app, /unknownQuotaDetailHtml\(q/);
});

test('compactTokens never prints 1000.0k and the no local use line shows', async () => {
  const { compactTokens, usageEstimateText } = await import('../public/usage-estimate.js');
  assert.equal(compactTokens(999_999), '1.0m');
  assert.equal(compactTokens(999_950), '1.0m');
  assert.equal(compactTokens(999_949), '999.9k');
  assert.equal(compactTokens(999_999_999), '1.0b');
  assert.equal(usageEstimateText({ days: 7, tokens: 0, costUsd: 0, omittedModels: 0, models: [] }), 'no local use found in the last 7 days');
});

test('the Fleet card names the reason for the unknown OpenCode Go limit', async () => {
  const { fleetView } = await import('../public/fleet.js');
  const { buildFleetRollup } = await import('../src/fleet-rollup.js');
  const rows = [{ name: 'win1', status: 'healthy', ageSeconds: 0, kind: 'container', lastSeenAt: fixture.generatedAt, summary: { ...fixture, kind: 'container', factoryId: 'win1', name: 'win1' } }];
  const html = fleetView({ factories: rows, pollSeconds: 30, rollup: buildFleetRollup(rows, { now: Date.parse('2026-10-05T12:00:00Z') }) });
  assert.match(html, /OpenCode Go · usage limit unknown \(no usage reader in this factory\)/);
});

test('the Fleet card estimate row is not a hidden "more" lane', async () => {
  const { fleetView } = await import('../public/fleet.js');
  const { buildFleetRollup } = await import('../src/fleet-rollup.js');
  const rows = [{ name: 'win1', status: 'healthy', ageSeconds: 0, kind: 'container', lastSeenAt: fixture.generatedAt, summary: { ...fixture, kind: 'container', factoryId: 'win1', name: 'win1' } }];
  const rollup = buildFleetRollup(rows, { now: Date.parse('2026-10-05T12:00:00Z') });
  const html = fleetView({ factories: rows, pollSeconds: 30, rollup });
  const tag = html.match(/<div class="([^"]*)" data-fleet-estimate="opencode"/);
  assert.ok(tag, 'the estimate row renders');
  assert.ok(!tag[1].split(/\s+/).includes('more'), `estimate row class is "${tag[1]}"`);
});
