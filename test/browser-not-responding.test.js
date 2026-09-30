// The "not responding" state of a project browser: engine state, the notice, the API fields, the card, and the rule that nothing restarts a browser by itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-not-responding-')));
process.env.HERDR_BOSS_DIR = dataDir;
const { browserUnresponsiveAlert, alertPromptDue } = await import('../src/engine.js');
const { withProbeState } = await import('../src/browser-probe.js');
const { renderBulletin } = await import('../src/rules.js');
const app = fs.readFileSync(path.join(repo, 'public/app.js'), 'utf8');

const b = { project: 'alpha', port: 9223, headless: true, probeSince: '2026-09-30T10:00:00.000Z' };

test('the notice tells the orchestrator the exact command in the current mode', () => {
  const headless = browserUnresponsiveAlert(b, 'w1');
  assert.equal(headless.text, 'Your project browser is not responding. Run herdr-boss browser restart alpha --headless, then continue.');
  assert.equal(browserUnresponsiveAlert({ ...b, headless: false }, 'w1').text, 'Your project browser is not responding. Run herdr-boss browser restart alpha --visible, then continue.');
  assert.equal(headless.scope, 'w1');
  assert.equal(headless.once, true);
  assert.equal(headless.severity, 'warn');
});

test('the notice goes out once for a change, and a later change has a new key', () => {
  const first = browserUnresponsiveAlert(b, 'w1');
  assert.equal(alertPromptDue(first, undefined, 1000, 60000), true);
  assert.equal(alertPromptDue(first, { at: 1000, severity: 'warn' }, 10_000_000, 60000), false);
  const later = browserUnresponsiveAlert({ ...b, probeSince: '2026-09-30T12:00:00.000Z' }, 'w1');
  assert.notEqual(later.key, first.key);
  assert.equal(alertPromptDue(later, undefined, 1000, 60000), true);
});

test('the browsers API adds the probe state to a verified browser only', () => {
  const sessions = [
    { project: 'alpha', port: 9223, profileVerified: true },
    { project: 'beta', port: 9224, profileVerified: false },
    { project: 'gamma', port: 9225, profileVerified: true },
  ];
  const managed = [
    { project: 'alpha', port: 9223, notResponding: true, probeAt: '2026-09-30T10:00:00.000Z', probeReason: 'getTargets failed' },
    { project: 'beta', port: 9224, notResponding: true, probeAt: 'x', probeReason: 'getVersion timed out' },
    { project: 'gamma', port: 9999, notResponding: true, probeAt: 'x', probeReason: 'getVersion timed out' },
  ];
  const [alpha, beta, gamma] = withProbeState(sessions, managed);
  assert.deepEqual([alpha.notResponding, alpha.probeAt, alpha.probeReason], [true, '2026-09-30T10:00:00.000Z', 'getTargets failed']);
  assert.deepEqual([beta.notResponding, beta.probeAt, beta.probeReason], [false, null, null]);
  assert.deepEqual([gamma.notResponding, gamma.probeReason], [false, null]);
  assert.deepEqual(withProbeState(sessions, undefined).map((x) => x.notResponding), [false, false, false]);
  assert.match(fs.readFileSync(path.join(repo, 'src/server.js'), 'utf8'), /withProbeState\(sessions, engine\.state\?\.managedBrowsers\)/);
});

test('the bulletin lists a probe-marked browser as not responding with the reason', () => {
  const snap = {
    updatedAt: '2026-09-30T10:00:00.000Z', resourceLeases: { pools: [], errors: [], leases: [] }, browsers: [{ kind: 'automation-chrome', port: '9223', profile: '/p/alpha' }],
    managedBrowsers: [{ project: 'alpha', port: 9223, profile: '/p/alpha', headless: true, responsive: true, notResponding: true, probeReason: 'evaluate did not return' }],
  };
  const text = renderBulletin(snap, { alerts: [], advice: [] }, { host: '127.0.0.1', port: 4477 });
  assert.match(text, /- alpha: not responding \(headless\).*\(evaluate did not return\)/);
});

// ----- the card -----

const body = (name) => { const start = app.indexOf(`function ${name}(`); assert.ok(start >= 0, `${name} exists`); return app.slice(start, app.indexOf('\n}\n', start)); };
function load(names, context = {}) {
  const ctx = { esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])), ...context };
  vm.runInNewContext(`const browserAnswers = (b) => !!b?.responsive && !b.notResponding;\n${names.map(body).map((x) => `${x}\n}`).join('\n')}\nthis.fns = { ${names.join(', ')} };`, ctx);
  return ctx.fns;
}

test('the card shows Not responding, the reason, and a Restart button in the current mode', () => {
  const { browserNotRespondingBlock, browserState } = load(['browserNotRespondingBlock', 'browserState']);
  const card = { port: 9223, profileVerified: true, responsive: true, notResponding: true, headless: true, probeReason: 'getTargets failed' };
  assert.equal(browserState(card), 'not responding');
  assert.equal(browserState({ ...card, notResponding: false }), 'ready');
  const html = browserNotRespondingBlock('alpha', card);
  assert.match(html, /Not responding/);
  assert.match(html, /getTargets failed/);
  assert.match(html, /<button type="button" data-browser-restart="alpha" data-browser-mode="headless" data-browser-no-restore="1"[^>]*>Restart<\/button>/);
  assert.match(browserNotRespondingBlock('alpha', { ...card, headless: false }), /data-browser-mode="visible"/);
});

test('the card escapes the reason', () => {
  const { browserNotRespondingBlock } = load(['browserNotRespondingBlock']);
  assert.doesNotMatch(browserNotRespondingBlock('alpha', { probeReason: '<img src=x>' }), /<img/);
});

test('the Restart button uses the existing restart route and never reopens a page', () => {
  const start = app.indexOf('if (e.target.dataset.browserClose || e.target.dataset.browserRestart)');
  const handler = app.slice(start, app.indexOf('await refreshExtras();', start));
  assert.match(handler, /\/api\/browser-sessions\/\$\{restart \? 'restart' : 'close'\}/);
  assert.match(handler, /const restorePage = !e\.target\.dataset\.browserNoRestore/);
});

test('the card block shows only for a verified browser that Herdr Boss started', () => {
  const card = app.slice(app.indexOf('function browserResources('), app.indexOf('\n}\n', app.indexOf('function browserResources(')));
  assert.match(card, /b\?\.profileVerified && b\.notResponding \? browserNotRespondingBlock\(p\.slug, b\)/);
  assert.match(card, /const b = sessions\.find\(\(x\) => x\.project === p\.slug\)/);
});

test('the Browsers help describes the state and the restart rule', () => {
  assert.match(app, /<b>not responding<\/b>[^`]*two checks in a row failed[^`]*<b>Restart<\/b>[^`]*never restarts a browser by itself/);
});

// ----- the engine -----

const engineScript = `
  import fs from 'node:fs';
  import path from 'node:path';
  import { Engine } from './src/engine.js';
  import { loadConfig } from './src/config.js';
  import { createBrowserProbes } from './src/browser-probe.js';
  const dir = process.env.HERDR_BOSS_DIR;
  const sessionsFile = path.join(dir, 'browser-sessions.json');
  const profile = (project) => path.join(dir, 'browser-profiles', project);
  const chrome = (port, project) => ({ pid: port, cmd: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=' + port + ' --user-data-dir=' + profile(project) + ' --headless' });
  const running = { alpha: true, beta: false };
  let outcome = { ok: true };
  const probed = [];
  const cfg = loadConfig();
  cfg.push = false;
  cfg.browsers.reapOrphanDaemons = false;
  cfg.browsers.sweepCodeSignClones = false;
  const engine = new Engine(cfg, { push: false, act: process.env.ACT !== '0', collectors: {
    collectProcesses: async () => new Map([[1, { pid: 1, cmd: '/sbin/launchd' }], ...Object.entries(running).filter(([, on]) => on).map(([project]) => [project === 'alpha' ? 9223 : 9224, chrome(project === 'alpha' ? 9223 : 9224, project)])]),
    cdpResponds: async () => true,
    probeBrowser: async (port) => { probed.push(port); return outcome; },
    collectPiModels: async () => null,
    runDenialScan: async () => ({ state: {}, denials: [] }),
  } });
  engine.browserProbes = createBrowserProbes({ probe: (port) => engine.collectors.probeBrowser(port), intervalMs: 0 });
  const before = fs.readFileSync(sessionsFile, 'utf8');
  const steps = [];
  for (const next of JSON.parse(process.env.STEPS)) {
    outcome = next;
    await engine.tick();
    await engine.browserProbes.idle();
    await engine.tick();
    const alpha = engine.state.managedBrowsers.find((x) => x.project === 'alpha');
    steps.push({ notResponding: alpha.notResponding, reason: alpha.probeReason, probeAt: !!alpha.probeAt,
      alerts: engine.state.alerts.filter((a) => a.key.startsWith('browser:managed-unresponsive:')).map((a) => ({ key: a.key, text: a.text, scope: a.scope })) });
  }
  console.log(JSON.stringify({ steps, probed, sessionsUnchanged: fs.readFileSync(sessionsFile, 'utf8') === before, rulesBrowsers: JSON.parse(fs.readFileSync(path.join(dir, 'rules.json'), 'utf8')).browsers }));
`;

function runEngine(steps, { act = true, launchedAgoMs = 600000 } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-not-responding-engine-')));
  const bin = path.join(dir, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const executable = (name, source) => { fs.writeFileSync(path.join(bin, name), source); fs.chmodSync(path.join(bin, name), 0o755); };
  executable('herdr', `#!/bin/sh\ncase "$1 $2" in\n  "workspace list") echo '{"result":{"workspaces":[]}}' ;;\n  "tab list") echo '{"result":{"tabs":[]}}' ;;\n  "pane list") echo '{"result":{"panes":[]}}' ;;\n  "agent list") echo '{"result":{"agents":[]}}' ;;\n  *) echo '{"result":{}}' ;;\nesac\n`);
  executable('codexbar', "#!/bin/sh\nprintf '[]\\n'\n");
  executable('ps', '#!/bin/sh\nexit 0\n');
  executable('memory_pressure', "#!/bin/sh\nprintf 'System-wide memory free percentage: 60%%\\n'\n");
  executable('sysctl', "#!/bin/sh\nprintf 'total = 1024.00M used = 1.00M free = 1023.00M\\n'\n");
  executable('ioreg', "#!/bin/sh\nprintf '\"HIDIdleTime\" = 1000000000\\n'\n");
  const record = (project, port) => ({ project, port, profile: path.join(dir, 'browser-profiles', project), headless: true, windowSize: { width: 1280, height: 800 }, pid: null, codeSignClone: null, launchedAt: new Date(Date.now() - launchedAgoMs).toISOString() });
  fs.writeFileSync(path.join(dir, 'browser-sessions.json'), JSON.stringify({ alpha: record('alpha', 9223), beta: record('beta', 9224) }));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', engineScript], {
    cwd: repo, encoding: 'utf8',
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`, HOME: dir, HERDR_BOSS_DIR: dir, HERDR_BOSS_LIVE_DIR: dir, HERDR_BOSS_ALLOW_ACTIONS: '1', HERDR_BOSS_PUSH: '0', STEPS: JSON.stringify(steps), ACT: act ? '1' : '0' },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

const fail = (reason) => ({ ok: false, reason });

test('the engine marks a browser after two failed probes, keeps one notice, and clears it on a success', { timeout: 60000 }, () => {
  const out = runEngine([fail('getVersion timed out'), fail('evaluate did not return'), fail('evaluate did not return'), { ok: true }]);
  const [first, second, third, fourth] = out.steps;
  assert.equal(first.notResponding, false);
  assert.deepEqual(first.alerts, []);
  assert.equal(second.notResponding, true);
  assert.equal(second.reason, 'evaluate did not return');
  assert.equal(second.alerts.length, 1);
  assert.equal(second.alerts[0].text, 'Your project browser is not responding. Run herdr-boss browser restart alpha --headless, then continue.');
  assert.equal(third.alerts.length, 1);
  assert.equal(third.alerts[0].key, second.alerts[0].key, 'the key stays the same while the state stays');
  assert.equal(fourth.notResponding, false);
  assert.deepEqual(fourth.alerts, []);
  const alpha = out.rulesBrowsers.find((x) => x.project === 'alpha');
  assert.equal(alpha.notResponding, false);
});

test('the engine never probes a browser without a matching process, and starts no restart', { timeout: 60000 }, () => {
  const out = runEngine([fail('getVersion timed out'), fail('getVersion timed out')]);
  assert.ok(out.probed.length > 0);
  assert.ok(out.probed.every((port) => port === 9223), 'only the running browser is probed');
  assert.equal(out.sessionsUnchanged, true, 'the engine changes no browser record');
});

test('a browser that started less than 120 seconds ago gets no probe and no notice', { timeout: 60000 }, () => {
  const out = runEngine([fail('getVersion timed out'), fail('getVersion timed out'), fail('getVersion timed out')], { launchedAgoMs: 30000 });
  assert.deepEqual(out.probed, []);
  assert.ok(out.steps.every((step) => !step.notResponding && step.alerts.length === 0));
});

test('a browser that started 130 seconds ago is probed', { timeout: 60000 }, () => {
  const out = runEngine([fail('getVersion timed out'), fail('getVersion timed out')], { launchedAgoMs: 130000 });
  assert.ok(out.probed.length > 0);
});

test('a tick that does not act runs no probe', { timeout: 60000 }, () => {
  const out = runEngine([fail('getVersion timed out'), fail('getVersion timed out')], { act: false });
  assert.deepEqual(out.probed, []);
  assert.equal(out.steps.at(-1).notResponding, false);
});

test('the engine code has no path that restarts or closes a browser', () => {
  const engine = fs.readFileSync(path.join(repo, 'src/engine.js'), 'utf8');
  assert.doesNotMatch(engine, /restartBrowser|closeBrowser|requestBrowser/);
  const probe = fs.readFileSync(path.join(repo, 'src/browser-probe.js'), 'utf8');
  assert.doesNotMatch(probe, /restartBrowser|closeBrowser|Browser\.close\b|process\.kill/);
});
