// The CDP round-trip probe of a project browser and the tracker that turns two failed probes into "not responding".
// A fake CDP server answers, fails, or hangs. No real Chrome runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeCdp } from './fake-cdp.js';
import fs from 'node:fs';
import { probeBrowser, createBrowserProbes, isProbeTab, PROBE_INTERVAL_MS } from '../src/browser-probe.js';

const fast = { stepMs: 200, totalMs: 800, cleanupMs: 200 };
async function withCdp(options, run) {
  const cdp = await fakeCdp(options);
  try { await run(cdp); } finally { await cdp.close(); }
}

test('a probe that gets an answer at each step succeeds and closes its temporary tab', async () => {
  await withCdp({}, async (cdp) => {
    // Use the production limits for a cold HTTP client on a shared machine. Failure tests keep short limits.
    const result = await probeBrowser(cdp.port);
    assert.deepEqual(result, { ok: true, pageIds: ['user-tab'], attachedTabIds: ['user-tab'], attachedClientCount: 1 });
    assert.deepEqual(cdp.calls, ['Browser.getVersion', 'Target.getTargets', 'Target.createTarget', 'Target.attachToTarget', 'Runtime.evaluate', 'Target.closeTarget']);
    assert.equal(cdp.created.length, 1);
    assert.deepEqual(cdp.created[0].params, { url: 'about:blank', background: true });
    assert.deepEqual(cdp.closed, [cdp.created[0].id]);
  });
});

test('the status probe carries attached tabs and open page IDs into tracked browser state', async () => {
  const probes = createBrowserProbes({ probe: async () => ({ ok: true, pageIds: ['page-one'], attachedTabIds: ['page-one'], attachedClientCount: 1 }) });
  const browser = { key: 'project:9224', project: 'project', port: 9224, active: true };
  probes.tick(browser, 10_000);
  await probes.idle();
  const state = probes.tick(browser, 10_000 + PROBE_INTERVAL_MS - 1);
  assert.deepEqual(state.pageIds, ['page-one']);
  assert.deepEqual(state.attachedTabIds, ['page-one']);
  assert.equal(state.attachedClientCount, 1);
});

test('the probe never touches a tab that it did not create', async () => {
  await withCdp({}, async (cdp) => {
    await probeBrowser(cdp.port, fast);
    assert.ok(!cdp.closed.includes('user-tab'));
    assert.equal(cdp.calls.filter((m) => m === 'Target.closeTarget').length, 1);
  });
});

test('the probe saves real page addresses privately, without adding them to its result', async () => {
  let saved;
  await withCdp({ behavior: { 'Target.getTargets': () => ({ targetInfos: [
    { targetId: 'one', type: 'page', url: 'https://sample.example.com/one?choice=1', title: 'Sample' },
    { targetId: 'worker', type: 'worker', url: 'https://sample.example.com/worker' },
  ] }) } }, async (cdp) => {
    const result = await probeBrowser(cdp.port, { ...fast, onTabs: (tabs) => { saved = tabs; } });
    assert.deepEqual(saved, [{ id: 'one', url: 'https://sample.example.com/one?choice=1' }]);
    assert.doesNotMatch(JSON.stringify(result), /sample\.example\.com|Sample|choice=1/);
  });
});

for (const [method, reason, mode, opened] of [
  ['Browser.getVersion', 'getVersion timed out', 'hang', false],
  ['Target.getTargets', 'getTargets timed out', 'hang', false],
  ['Target.getTargets', 'getTargets failed', 'error', false],
  ['Target.createTarget', 'createTarget timed out', 'hang', false],
  ['Runtime.evaluate', 'evaluate did not return', 'hang', true],
  ['Runtime.evaluate', 'evaluate failed', 'error', true],
]) {
  test(`${method} that ${mode === 'hang' ? 'hangs' : 'fails'} gives the reason "${reason}"`, async () => {
    await withCdp({ behavior: { [method]: mode } }, async (cdp) => {
      const result = await probeBrowser(cdp.port, fast);
      assert.deepEqual(result, { ok: false, reason });
      // A tab that was opened is closed, also after a failure.
      assert.deepEqual(cdp.closed, opened ? [cdp.created[0].id] : []);
    });
  });
}

test('a browser that answers /json/version but never the CDP socket gives "getVersion timed out"', async () => {
  await withCdp({ behavior: { 'Browser.getVersion': 'hang' } }, async (cdp) => {
    assert.deepEqual(await probeBrowser(cdp.port, fast), { ok: false, reason: 'getVersion timed out' });
  });
});

test('a /json/version that hangs gives "getVersion timed out"', async () => {
  await withCdp({ httpVersion: 'hang' }, async (cdp) => {
    assert.deepEqual(await probeBrowser(cdp.port, fast), { ok: false, reason: 'getVersion timed out' });
  });
});

test('an evaluate result other than 2 fails and the tab is closed', async () => {
  await withCdp({ evaluateValue: 3 }, async (cdp) => {
    assert.deepEqual(await probeBrowser(cdp.port, fast), { ok: false, reason: 'evaluate returned a wrong value' });
    assert.deepEqual(cdp.closed, [cdp.created[0].id]);
  });
});

test('the tab is closed over HTTP when the socket does not answer the close command', async () => {
  await withCdp({ behavior: { 'Runtime.evaluate': 'hang', 'Target.closeTarget': 'hang' } }, async (cdp) => {
    const result = await probeBrowser(cdp.port, fast);
    assert.equal(result.ok, false);
    assert.deepEqual(cdp.httpClosed, [cdp.created[0].id]);
  });
});

test('a probe with a socket that drops closes the tab and reports a failure', async () => {
  await withCdp({ behavior: { 'Runtime.evaluate': 'drop' } }, async (cdp) => {
    const result = await probeBrowser(cdp.port, fast);
    assert.equal(result.ok, false);
    assert.deepEqual(cdp.closed, [cdp.created[0].id]);
  });
});

test('a late answer to createTarget still closes the tab that it opened', async () => {
  await withCdp({ behavior: { 'Target.createTarget': { delayMs: 150 } } }, async (cdp) => {
    const result = await probeBrowser(cdp.port, { stepMs: 60, totalMs: 800, cleanupMs: 600 });
    assert.deepEqual(result, { ok: false, reason: 'createTarget timed out' });
    assert.equal(cdp.created.length, 1);
    assert.deepEqual(cdp.closed, [cdp.created[0].id]);
  });
});

test('the total time of a probe is at most totalMs plus the cleanup', async () => {
  const totalMs = 250;
  const cleanupMs = 400;
  const timerSlackMs = 50;
  await withCdp({ behavior: { 'Target.createTarget': 'hang' } }, async (cdp) => {
    const started = performance.now();
    const result = await probeBrowser(cdp.port, { stepMs: 5000, totalMs, cleanupMs });
    const elapsed = performance.now() - started;
    assert.equal(result.ok, false);
    assert.match(result.reason, / timed out$/);
    assert.ok(elapsed <= totalMs + cleanupMs + timerSlackMs, `took ${elapsed.toFixed(1)} ms; limit ${totalMs + cleanupMs} ms plus ${timerSlackMs} ms timer slack`);
  });
});

test('a port with no listener gives a failed probe, not an exception', async () => {
  const cdp = await fakeCdp({});
  const port = cdp.port;
  await cdp.close();
  const result = await probeBrowser(port, fast);
  assert.equal(result.ok, false);
  assert.match(result.reason, /^getVersion (failed|timed out)$/);
});

test('a reason holds no URL and no tab title', async () => {
  await withCdp({ behavior: { 'Target.getTargets': 'error' } }, async (cdp) => {
    const result = await probeBrowser(cdp.port, fast);
    assert.doesNotMatch(result.reason, /https?:|127\.0\.0\.1|user-tab/);
  });
});

// ----- tracker -----

function tracker(results, extra = {}) {
  const calls = [];
  const queue = [...results];
  const probes = createBrowserProbes({ probe: async (port) => { calls.push(port); const next = queue.shift(); return next instanceof Error ? Promise.reject(next) : next ?? { ok: true }; }, ...extra });
  return { probes, calls };
}
const browser = (over = {}) => ({ key: 'alpha:9223:t1', project: 'alpha', port: 9223, active: true, ...over });

test('the tracker doubles probe limits while a separate CDP client is connected', async () => {
  let options;
  const probes = createBrowserProbes({ probe: async (_port, actual) => { options = actual; return { ok: true }; } });
  probes.tick(browser({ externalClients: 1 }), 1_000_000);
  await probes.idle();
  assert.equal(options.stepMs, 6000);
  assert.equal(options.totalMs, 16000);
});

test('a failure during a command or within 20 seconds of it does not count', async () => {
  let now = 1_000_000;
  let activity = { inFlight: 1, lastCommandAt: now };
  const { probes } = tracker(Array(4).fill({ ok: false, reason: 'evaluate did not return' }), {
    intervalMs: 0, clock: () => now, activity: () => activity,
  });
  probes.tick(browser(), now);
  await probes.idle();
  assert.equal(probes.tick(browser(), now).failures, 0);
  await probes.idle();
  activity = { inFlight: 0, lastCommandAt: now };
  now += 19_999;
  probes.tick(browser(), now);
  await probes.idle();
  assert.equal(probes.tick(browser(), now).notResponding, false);
  await probes.idle();
});

test('a command that starts during a probe breaks the run of consecutive failed probes', async () => {
  let now = 1_000_000;
  let activity = { inFlight: 0, lastCommandAt: null };
  let release;
  let pending = false;
  const probes = createBrowserProbes({ intervalMs: 0, clock: () => now, activity: () => activity, probe: async () => {
    if (pending) await new Promise((resolve) => { release = resolve; });
    return { ok: false, reason: 'getTargets timed out' };
  } });
  probes.tick(browser(), now);
  await probes.idle();
  pending = true;
  probes.tick(browser(), ++now);
  activity = { inFlight: 0, lastCommandAt: now };
  release();
  await probes.idle();
  pending = false;
  activity = { inFlight: 0, lastCommandAt: null };
  const state = probes.tick(browser(), now + 60_000);
  assert.equal(state.failures, 0);
  assert.equal(state.notResponding, false);
  await probes.idle();
});

test('one failed probe does not mark the browser, two in a row do', async () => {
  const { probes } = tracker([{ ok: false, reason: 'getVersion timed out' }, { ok: false, reason: 'getTargets failed' }]);
  let now = 1_000_000;
  let state = probes.tick(browser(), now);
  await probes.idle();
  state = probes.tick(browser(), now);
  assert.equal(state.notResponding, false);
  assert.equal(state.failures, 1);
  now += PROBE_INTERVAL_MS;
  probes.tick(browser(), now);
  await probes.idle();
  state = probes.tick(browser(), now);
  assert.equal(state.notResponding, true);
  assert.equal(state.reason, 'getTargets failed');
  assert.equal(state.lastProbeAt, new Date(now).toISOString());
  assert.equal(state.since, new Date(now).toISOString());
});

test('one success clears the state and the failure count', async () => {
  const { probes } = tracker([{ ok: false, reason: 'a' }, { ok: false, reason: 'b' }, { ok: true }]);
  let now = 1_000_000;
  for (let i = 0; i < 3; i++) { probes.tick(browser(), now); await probes.idle(); now += PROBE_INTERVAL_MS; }
  const state = probes.tick(browser(), now - PROBE_INTERVAL_MS);
  assert.equal(state.notResponding, false);
  assert.equal(state.failures, 0);
  assert.equal(state.reason, null);
});

test('an interrupted failure run does not count: fail, success, fail is not "not responding"', async () => {
  const { probes } = tracker([{ ok: false, reason: 'a' }, { ok: true }, { ok: false, reason: 'b' }]);
  let now = 1_000_000;
  for (let i = 0; i < 3; i++) { probes.tick(browser(), now); await probes.idle(); now += PROBE_INTERVAL_MS; }
  assert.equal(probes.tick(browser(), now - 1).notResponding, false);
});

test('a probe that throws counts as a failed probe', async () => {
  const { probes } = tracker([new Error('boom https://secret.example/x'), new Error('boom')]);
  let now = 1_000_000;
  for (let i = 0; i < 2; i++) { probes.tick(browser(), now); await probes.idle(); now += PROBE_INTERVAL_MS; }
  const state = probes.tick(browser(), now - 1);
  assert.equal(state.notResponding, true);
  assert.doesNotMatch(state.reason, /secret|https?:/);
});

test('a browser gets at most one probe in 60 seconds', async () => {
  const { probes, calls } = tracker([]);
  const now = 1_000_000;
  probes.tick(browser(), now);
  await probes.idle();
  probes.tick(browser(), now + 1000);
  probes.tick(browser(), now + PROBE_INTERVAL_MS - 1);
  await probes.idle();
  assert.equal(calls.length, 1);
  probes.tick(browser(), now + PROBE_INTERVAL_MS);
  await probes.idle();
  assert.equal(calls.length, 2);
});

test('two probes of one browser never run at the same time', async () => {
  let running = 0;
  let peak = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const probes = createBrowserProbes({ probe: async () => { running++; peak = Math.max(peak, running); await gate; running--; return { ok: true }; } });
  probes.tick(browser(), 1_000_000);
  probes.tick(browser(), 1_000_000 + 10 * PROBE_INTERVAL_MS);
  release();
  await probes.idle();
  assert.equal(peak, 1);
});

test('no probe runs for a browser that is not active', async () => {
  const { probes, calls } = tracker([]);
  const state = probes.tick(browser({ active: false }), 1_000_000);
  await probes.idle();
  assert.equal(calls.length, 0);
  assert.equal(state.notResponding, false);
  assert.equal(state.lastProbeAt, null);
});

test('a browser that closes loses its state, and a new launch starts clean', async () => {
  const { probes } = tracker([{ ok: false, reason: 'a' }, { ok: false, reason: 'b' }]);
  let now = 1_000_000;
  for (let i = 0; i < 2; i++) { probes.tick(browser(), now); await probes.idle(); now += PROBE_INTERVAL_MS; }
  assert.equal(probes.tick(browser(), now - 1).notResponding, true);
  assert.equal(probes.tick(browser({ active: false }), now).notResponding, false);
  assert.equal(probes.tick(browser({ key: 'alpha:9223:t2' }), now + 1).failures, 0);
});

test('the state of the browser is a plain object of the documented fields', async () => {
  const { probes } = tracker([]);
  const state = probes.tick(browser(), 1_000_000);
  assert.deepEqual(Object.keys(state).sort(), ['attachedClientCount', 'attachedTabIds', 'failures', 'lastProbeAt', 'notResponding', 'ok', 'pageIds', 'reason', 'since']);
});

// ----- late sockets, warnings, and the probe tab registry -----

async function until(condition, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error('condition not met');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('a socket whose upgrade answers after the getVersion timeout is closed', async () => {
  await withCdp({ upgradeDelayMs: 300 }, async (cdp) => {
    const result = await probeBrowser(cdp.port, { ...fast, stepMs: 100 });
    assert.deepEqual(result, { ok: false, reason: 'getVersion timed out' });
    await until(() => cdp.upgrades === 1);
    await until(() => cdp.sockets.size === 0);
    assert.deepEqual(cdp.calls, []);
  });
});

test('a /json/version that answers after the getVersion timeout opens no socket', async () => {
  await withCdp({ versionDelayMs: 300 }, async (cdp) => {
    const result = await probeBrowser(cdp.port, { ...fast, stepMs: 100 });
    assert.deepEqual(result, { ok: false, reason: 'getVersion timed out' });
    await until(() => cdp.versionAnswers === 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cdp.upgrades ?? 0, 0);
    assert.equal(cdp.sockets.size, 0);
  });
});

test('a tab that does not close gives one plain warning with the target ID and no URL', async () => {
  await withCdp({ behavior: { 'Runtime.evaluate': 'hang', 'Target.closeTarget': 'hang' }, httpClose: 'fail' }, async (cdp) => {
    const result = await probeBrowser(cdp.port, fast);
    assert.equal(result.ok, false);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0], `The probe tab ${cdp.created[0].id} on port ${cdp.port} did not close.`);
    assert.doesNotMatch(result.warnings[0], /https?:|\//);
  });
});

test('a probe that closes its tab returns no warning', async () => {
  await withCdp({}, async (cdp) => {
    assert.equal((await probeBrowser(cdp.port, fast)).warnings, undefined);
  });
});

test('the tracker passes each warning to onWarning', async () => {
  const warned = [];
  const probes = createBrowserProbes({ probe: async () => ({ ok: true, warnings: ['The probe tab T1 on port 9223 did not close.'] }), onWarning: (text, b) => warned.push([text, b.project]) });
  probes.tick(browser(), 1_000_000);
  await probes.idle();
  assert.deepEqual(warned, [['The probe tab T1 on port 9223 did not close.', 'alpha']]);
});

test('the registry holds the probe tab while the probe runs, drops it after a close, and keeps it after a failed close', async () => {
  let midProbe;
  await withCdp({}, async (cdp) => {
    cdp.behavior['Runtime.evaluate'] = () => { midProbe = isProbeTab(cdp.created[0].id); return { result: { type: 'number', value: 2 } }; };
    await probeBrowser(cdp.port, fast);
    assert.equal(midProbe, true);
    assert.equal(isProbeTab(cdp.created[0].id), false);
  });
  await withCdp({ behavior: { 'Runtime.evaluate': 'hang', 'Target.closeTarget': 'hang' }, httpClose: 'fail' }, async (cdp) => {
    await probeBrowser(cdp.port, fast);
    const id = cdp.created[0].id;
    assert.equal(isProbeTab(id), true);
    assert.equal(isProbeTab(id, Date.now() + 9 * 60000), true);
    assert.equal(isProbeTab(id, Date.now() + 11 * 60000), false, 'an entry older than 10 minutes is dropped');
  });
});

test('the tab list hides the tabs of the probe', () => {
  const source = fs.readFileSync(new URL('../src/browser-preview.js', import.meta.url), 'utf8');
  assert.match(source, /\(await targets\(session\)\)\.filter\(\(page\) => !isProbeTab\(page\.id\)\)/);
});
