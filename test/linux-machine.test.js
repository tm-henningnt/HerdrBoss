import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { collectMachine } from '../src/collect.js';
import { Engine } from '../src/engine.js';
import { loadConfig } from '../src/config.js';
import { serve } from '../src/server.js';
import { renderBulletin } from '../src/rules.js';

const GB = 2 ** 30;
const MB = 2 ** 20;
const system = { cpus: () => Array(16).fill({}), totalmem: () => 64 * GB, loadavg: () => [1, 2, 3] };

function fixture(t, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-linux-machine-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, text) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write('proc/meminfo', 'MemTotal: 67108864 kB\nMemFree: 1048576 kB\nMemAvailable: 16777216 kB\nSwapTotal: 4194304 kB\nSwapFree: 3145728 kB\n');
  write('proc/loadavg', '2.50 4.25 3.00 1/200 1234\n');
  write('proc/self/cgroup', '0::/factory\n');
  write('proc/self/mountinfo', `30 20 0:28 / ${root}/cgroup rw - cgroup2 cgroup rw\n`);
  for (const [name, text] of Object.entries(files)) write(name, text);
  return { root, write, options: { platform: 'linux', procRoot: path.join(root, 'proc'), system, cpuSamples: new Map(), now: 1000,
    runner: async () => { throw new Error('Linux must not run a macOS probe'); } } };
}

test('Linux machine sample reads meminfo, load, and each pressure file', async (t) => {
  const { root, options } = fixture(t, {
    'proc/pressure/memory': 'some avg10=2.50 avg60=1.20 avg300=0.50 total=1234\nfull avg10=1.00 avg60=0.40 avg300=0.10 total=321\n',
    'proc/pressure/cpu': 'some avg10=8.50 avg60=3.00 avg300=1.00 total=4567\n',
    'proc/pressure/io': 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n',
  });
  const sample = await collectMachine(root, options);
  assert.equal(sample.cpus, 16);
  assert.equal(sample.memTotalGB, 64);
  assert.equal(sample.memFreePercent, 25, 'use available memory, which includes reclaimable cache');
  assert.equal(sample.swapUsedMB, 1024);
  assert.equal(sample.swapTotalMB, 4096);
  assert.equal(sample.ownerIdleMinutes, null);
  assert.deepEqual(sample.load, [2.5, 4.25, 3]);
  assert.deepEqual(sample.pressure.memory.full, { avg10: 1, avg60: 0.4, avg300: 0.1, total: 321 });
  assert.equal(sample.pressure.cpu.some.avg10, 8.5);
  assert.equal(sample.pressure.cpu.full, null);
  assert.equal(sample.pressure.io.full.total, 0);
  assert.ok(sample.diskFreeBytes > 0);
});

test('Linux machine guard uses fractional cgroup CPU and memory limits', async (t) => {
  const { root, options } = fixture(t, {
    'cgroup/factory/cpu.max': '150000 100000\n',
    'cgroup/factory/memory.max': `${8 * GB}\n`,
    'cgroup/factory/memory.current': `${7.5 * GB}\n`,
    'cgroup/factory/memory.swap.max': `${2 * GB}\n`,
    'cgroup/factory/memory.swap.current': `${MB * 1536}\n`,
  });
  const sample = await collectMachine(root, options);
  assert.equal(sample.cpus, 1.5);
  assert.equal(sample.memTotalGB, 8);
  assert.equal(sample.memFreePercent, 6.25);
  assert.equal(sample.swapTotalMB, 2048);
  assert.equal(sample.swapUsedMB, 1536);
  const engine = makeEngine(sample);
  const state = await engine.tick();
  assert.equal(state.machine.limits.loadLimit, 4.5);
  assert.ok(state.alerts.some((row) => row.key === 'machine:mem'));
});

test('Linux uses the tightest visible parent limit and effective CPU set', async (t) => {
  const { root, options } = fixture(t, {
    'proc/self/cgroup': '0::/factory/worker\n',
    'cgroup/factory/worker/cpu.max': 'max 100000\n',
    'cgroup/factory/worker/cpuset.cpus.effective': '0-1,4\n',
    'cgroup/factory/worker/memory.max': 'max\n',
    'cgroup/factory/cpu.max': '200000 100000\n',
    'cgroup/factory/memory.max': `${8 * GB}\n`,
    'cgroup/factory/memory.current': `${7 * GB}\n`,
  });
  const sample = await collectMachine(root, options);
  assert.equal(sample.cpus, 2);
  assert.equal(sample.memTotalGB, 8);
  assert.equal(sample.memFreePercent, 12.5);
});

test('Linux resolves a cgroup mount whose root is the container group', async (t) => {
  const f = fixture(t, {
    'cgroup/cpu.max': '50000 100000\n',
    'cgroup/memory.max': `${4 * GB}\n`,
    'cgroup/memory.current': `${GB}\n`,
  });
  f.write('proc/self/mountinfo', `30 20 0:28 /factory ${f.root}/cgroup rw - cgroup2 cgroup rw\n`);
  const sample = await collectMachine(f.root, f.options);
  assert.equal(sample.cpus, 0.5);
  assert.equal(sample.memTotalGB, 4);
  assert.equal(sample.memFreePercent, 75);
});

test('Linux free memory is bounded by the remaining bytes in a shared parent', async (t) => {
  const { root, options } = fixture(t, {
    'proc/self/cgroup': '0::/factory/worker\n',
    'cgroup/factory/worker/memory.max': `${4 * GB}\n`,
    'cgroup/factory/worker/memory.current': `${GB}\n`,
    'cgroup/factory/memory.max': `${8 * GB}\n`,
    'cgroup/factory/memory.current': `${7 * GB}\n`,
  });
  const sample = await collectMachine(root, options);
  assert.equal(sample.memTotalGB, 4);
  assert.equal(sample.memFreePercent, 25, 'only 1 GB of the 4 GB capacity remains available');
});

test('Linux uses the namespace root cgroup and does not escape it', async (t) => {
  const { root, options } = fixture(t, {
    'proc/self/cgroup': '0::/\n',
    'cgroup/cpu.max': '100000 100000\n',
    'cgroup/memory.max': `${GB}\n`,
    'cgroup/memory.current': `${2 * GB}\n`,
  });
  const sample = await collectMachine(root, options);
  assert.equal(sample.cpus, 1);
  assert.equal(sample.memFreePercent, 0, 'over-limit usage never produces negative free memory');
});

test('Linux unlimited or malformed cgroup values keep the host sample', async (t) => {
  const { root, options } = fixture(t, {
    'cgroup/factory/cpu.max': 'max 100000\n',
    'cgroup/factory/memory.max': 'max\n',
    'cgroup/factory/memory.swap.max': 'max\n',
  });
  for (const value of ['max', 'bad', '-1', '0']) {
    fs.writeFileSync(path.join(root, 'cgroup/factory/memory.max'), value);
    const sample = await collectMachine(root, options);
    assert.equal(sample.cpus, 16);
    assert.equal(sample.memTotalGB, 64);
    assert.equal(sample.memFreePercent, 25);
    assert.equal(sample.swapUsedMB, 1024);
  }
});

test('Linux cgroup counters supply CPU usage through the engine guard', async (t) => {
  const f = fixture(t, { 'cgroup/factory/cpu.max': '200000 100000\n', 'cgroup/factory/cpu.stat': 'usage_usec 1000000\n' });
  await collectMachine(f.root, f.options);
  f.write('cgroup/factory/cpu.stat', 'usage_usec 2800000\n');
  const sample = await collectMachine(f.root, { ...f.options, now: 2000 });
  assert.equal(sample.cpuTotalSample, 180);
  const engine = makeEngine(sample);
  const state = await engine.tick();
  assert.equal(state.machine.cpuTotalSample, 180, 'the process CPU sum must not replace the container counter');
  assert.equal(state.machine.limits.cpuPercent, 90);
  assert.ok(state.alerts.some((row) => row.key === 'machine:load' && /Machine CPU high/.test(row.title)));
  f.write('cgroup/factory/cpu.stat', 'usage_usec 10\n');
  assert.equal((await collectMachine(f.root, { ...f.options, now: 3000 })).cpuTotalSample, undefined, 'a reset has no measured CPU interval');
});

test('Linux missing or invalid files report unknown fields', async (t) => {
  const f = fixture(t, { 'proc/meminfo': 'MemTotal: bad kB\nMemAvailable: -1 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n',
    'proc/pressure/memory': 'some avg10=bad avg60=0 avg300=0 total=1\n' });
  const sample = await collectMachine(f.root, f.options);
  assert.equal(sample.memFreePercent, null);
  assert.equal(sample.swapUsedMB, 0);
  assert.equal(sample.swapTotalMB, 0);
  assert.equal(sample.pressure.memory.some, null);
  assert.equal(sample.pressure.cpu, null);
  fs.rmSync(path.join(f.root, 'proc/meminfo'));
  assert.equal((await collectMachine(f.root, f.options)).swapUsedMB, null);
});

test('a known memory cap with unreadable usage reports unknown free memory', async (t) => {
  const { root, options } = fixture(t, { 'cgroup/factory/memory.max': `${GB}\n`, 'cgroup/factory/memory.current': 'bad\n' });
  const sample = await collectMachine(root, options);
  assert.equal(sample.memTotalGB, 1);
  assert.equal(sample.memFreePercent, null);
});

test('macOS machine probes and sample shape stay unchanged', async () => {
  const calls = [];
  const outputs = { memory_pressure: 'System-wide memory free percentage: 37%\n', sysctl: 'total = 4096.00M used = 1024.00M\n', ioreg: '"HIDIdleTime" = 600000000000\n' };
  const sample = await collectMachine(process.cwd(), { platform: 'darwin', system, runner: async (command, args) => { calls.push([command, args]); return outputs[command]; } });
  assert.deepEqual(calls, [['memory_pressure', []], ['sysctl', ['-n', 'vm.swapusage']], ['ioreg', ['-c', 'IOHIDSystem']]]);
  assert.equal(sample.ownerIdleMinutes, 10);
  assert.equal(sample.memFreePercent, 37);
  assert.equal(sample.memTotalGB, 64);
  assert.equal(sample.swapUsedMB, 1024);
  assert.deepEqual(sample.load, [1, 2, 3]);
  assert.equal(Object.hasOwn(sample, 'pressure'), false);
});

test('macOS process CPU is sampled again when a collector reuses its sample object', async () => {
  const machine = { cpus: 16, load: [1, 2, 3], memFreePercent: 50, memTotalGB: 64 };
  let cpu = 200;
  const engine = makeEngine(machine, async () => new Map([[123, { pid: 123, ppid: 1, cmd: 'fixture', cpu }]]));
  assert.equal((await engine.tick()).machine.cpuTotalSample, 200);
  cpu = 400;
  assert.equal((await engine.tick()).machine.cpuTotalSample, 400);
});

test('Linux reads pressure from the process cgroup before host pressure', async (t) => {
  const { root, options } = fixture(t, {
    'proc/pressure/memory': 'some avg10=1.00 avg60=0.00 avg300=0.00 total=1\n',
    'cgroup/factory/memory.pressure': 'some avg10=20.00 avg60=10.00 avg300=5.00 total=500\n',
  });
  const sample = await collectMachine(root, options);
  assert.equal(sample.pressure.memory.some.avg10, 20);
});

test('Linux rejects invalid CPU limits and caps quota by the effective CPU set', async (t) => {
  const f = fixture(t, { 'cgroup/factory/cpuset.cpus.effective': '0-1,4\n' });
  for (const quota of ['bad 100000', '100000 0', '-1 100000', '0 100000']) {
    f.write('cgroup/factory/cpu.max', quota);
    assert.equal((await collectMachine(f.root, f.options)).cpus, 3);
  }
  f.write('cgroup/factory/cpu.max', '400000 100000\n');
  assert.equal((await collectMachine(f.root, f.options)).cpus, 3);
});

function makeEngine(machine, collectProcesses = async () => new Map()) {
  const cfg = loadConfig();
  cfg.browsers.reapOrphanDaemons = false;
  return new Engine(cfg, { push: false, act: false, collectors: {
    collectMachine: async () => machine,
    collectHerdr: async () => ({ workspaces: [], panes: [] }),
    collectProcesses, collectQuotas: async () => [],
    collectWorktreeCounts: async () => ({}), collectCwdProcesses: async () => [],
    collectMissingWorktreeProcesses: async () => [], collectPiModels: async () => null,
  } });
}

test('Linux service startup reports missing lsof and procps in the state API', async (t) => {
  const cfg = loadConfig();
  cfg.port = 0;
  cfg.host = '127.0.0.1';
  const engine = makeEngine(null);
  const calls = [];
  const stateReady = once(engine, 'state');
  const app = serve(cfg, { liveDataDir: process.env.HERDR_BOSS_DIR, createEngine: () => engine,
    machineTools: { platform: 'linux', runner: async (cmd, args, options) => {
      calls.push([cmd, args, options.timeout]);
      throw new Error('not installed');
    } } });
  t.after(() => app.close());
  if (!app.server.listening) await once(app.server, 'listening');
  await stateReady;
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/state`);
  assert.equal(response.status, 200);
  const { events } = await response.json();
  assert.deepEqual(calls, [['lsof', ['-v'], 3000], ['ps', ['--version'], 3000]]);
  assert.ok(events.some((event) => event.type === 'warn' && /Install lsof/.test(event.text)));
  assert.ok(events.some((event) => event.type === 'warn' && /Install procps/.test(event.text)));
});

for (const scenario of [
  { title: 'installed Linux tools', platform: 'linux', psVersion: 'ps from procps-ng 4.0.4', warnings: 0, calls: 2 },
  { title: 'Linux ps without procps', platform: 'linux', psVersion: 'BusyBox ps', warnings: 1, calls: 2 },
  { title: 'macOS startup', platform: 'darwin', psVersion: '', warnings: 0, calls: 0 },
]) {
  test(`service tool check: ${scenario.title}`, async (t) => {
    const cfg = loadConfig();
    cfg.port = 0;
    cfg.host = '127.0.0.1';
    const engine = makeEngine(null);
    const before = engine.events.length;
    const calls = [];
    const stateReady = once(engine, 'state');
    const app = serve(cfg, { liveDataDir: process.env.HERDR_BOSS_DIR, createEngine: () => engine,
      machineTools: { platform: scenario.platform, runner: async (cmd) => {
        calls.push(cmd);
        return cmd === 'ps' ? scenario.psVersion : '';
      } } });
    t.after(() => app.close());
    if (!app.server.listening) await once(app.server, 'listening');
    await stateReady;
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/state`);
    const state = await response.json();
    const warnings = state.events.slice(before).filter((event) => event.type === 'warn' && /Linux machine tools/.test(event.text));
    assert.equal(warnings.length, scenario.warnings);
    assert.equal(calls.length, scenario.calls);
    if (scenario.warnings) assert.match(warnings[0].text, /Install procps/);
  });
}

test('Linux cgroup free memory excludes reclaimable file cache', async (t) => {
  const f = fixture(t, {
    'cgroup/factory/memory.max': `${8 * GB}\n`,
    'cgroup/factory/memory.current': `${6 * GB}\n`,
    'cgroup/factory/memory.stat': `anon ${GB}\ninactive_file ${2 * GB}\nactive_file ${GB}\n`,
  });
  assert.equal((await collectMachine(f.root, f.options)).memFreePercent, 62.5, '3 GB of file cache is reclaimable');
  f.write('cgroup/factory/memory.stat', `inactive_file ${8 * GB}\nactive_file ${8 * GB}\n`);
  assert.equal((await collectMachine(f.root, f.options)).memFreePercent, 100, 'used memory never goes below 0');
  f.write('cgroup/factory/memory.stat', 'bad\n');
  assert.equal((await collectMachine(f.root, f.options)).memFreePercent, 25, 'an unreadable stat keeps the current value');
});

test('Linux rounds a fractional CPU count to 2 decimals and the rules text prints it cleanly', async (t) => {
  const { root, options } = fixture(t, { 'cgroup/factory/cpu.max': '33333 100000\n' });
  const sample = await collectMachine(root, options);
  assert.equal(sample.cpus, 0.33);
  sample.load = [2, 2, 2];
  const state = await makeEngine({ ...sample, cpus: 0.5 }).tick();
  const alert = state.alerts.find((row) => row.key === 'machine:load');
  assert.ok(alert, 'load 2 on 0.5 cores raises the load alert');
  assert.match(alert.title, /on 0\.5 cores$/);
  const bulletin = renderBulletin({ machine: { ...sample, cpus: 0.1 + 0.2 }, updatedAt: Date.now(), workspaces: [], panes: [] }, { alerts: [], advice: [] }, loadConfig());
  assert.match(bulletin, /- Load: 2 \/ 2 \/ 2 on 0\.3 cores/);
  const noisy = await makeEngine({ ...sample, cpus: 0.1 + 0.2 }).tick();
  assert.match(noisy.alerts.find((row) => row.key === 'machine:load').title, /on 0\.3 cores$/);
});

test('service tool check does not delay the first tick', async (t) => {
  const cfg = loadConfig();
  cfg.port = 0;
  cfg.host = '127.0.0.1';
  const engine = makeEngine(null);
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const stateReady = once(engine, 'state');
  const app = serve(cfg, { liveDataDir: process.env.HERDR_BOSS_DIR, createEngine: () => engine,
    machineTools: { platform: 'linux', runner: async (cmd) => { calls.push(cmd); await gate; throw new Error('not installed'); } } });
  t.after(() => app.close());
  if (!app.server.listening) await once(app.server, 'listening');
  await stateReady;
  assert.ok(calls.includes('lsof'), 'the check started');
  const warned = new Promise((resolve) => { const log = engine.log.bind(engine); engine.log = (...args) => { log(...args); if (args[0] === 'warn') resolve(); }; });
  release();
  await warned;
});
