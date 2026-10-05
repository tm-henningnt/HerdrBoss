import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

// The fake command starts a helper that holds both output pipes. Test cleanup
// stops only these fixture PIDs, including when the old implementation hangs.
// Every fixture process also sets its own deadline. An interrupted run leaves the cleanup hook unexecuted, so the
// deadline is the only thing that still stops a fixture process. The deadline must stay above the command timeout of
// 2000 ms and the 7000 ms deadline of the test.
const fixtureHoldMs = 15000;
test('a command timeout stops its helper and lets the caller leave the event loop', { timeout: 15000 }, async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-process-')));
  const ready = path.join(home, 'ready.json');
  const shim = path.join(home, 'shim.cjs');
  const driver = path.join(home, 'driver.mjs');
  fs.writeFileSync(shim, `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const hold = ${fixtureHoldMs};
const helper = spawn(process.execPath, ['-e', "process.send('ready'); setTimeout(() => process.exit(0), " + hold + "); setInterval(() => {}, 60000)"], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
helper.once('message', () => fs.writeFileSync(process.argv[2], JSON.stringify({ parent: process.pid, helper: helper.pid })));
setTimeout(() => process.exit(0), ${fixtureHoldMs});
setInterval(() => {}, 60000);
`);
  const module = pathToFileURL(path.resolve('src/doctor.js')).href;
  fs.writeFileSync(driver, `
import { createDoctorRunner } from ${JSON.stringify(module)};
const controller = new AbortController();
// This fixture process also keeps a deadline of its own. The deadline is cleared when the command ends, so it never
// holds this process after the normal timeout path.
const deadline = setTimeout(() => process.exit(0), ${fixtureHoldMs});
const runner = createDoctorRunner({ home: process.env.HOME, env: process.env });
try {
  await runner({ kind: 'command', command: process.execPath, args: [process.argv[2], process.argv[3]] }, { signal: controller.signal, timeout: 2000 });
  process.stdout.write('unexpected success');
} catch {
  process.stdout.write('timeout completed');
}
clearTimeout(deadline);
`);
  const child = spawn(process.execPath, [driver, shim, ready], { env: { ...process.env, HOME: home, HERDR_BOSS_DIR: path.join(home, 'data') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  const closed = once(child, 'close');
  let timer;
  t.after(async () => {
    clearTimeout(timer);
    const pids = fs.existsSync(ready) ? Object.values(JSON.parse(fs.readFileSync(ready, 'utf8'))) : [];
    for (const pid of pids.concat(child.pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await closed;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The command helper kept the caller alive.')), 7000); });
  const [code] = await Promise.race([closed, deadline]);
  assert.equal(fs.existsSync(ready), true, 'the fixture started its helper before the timeout');
  assert.equal(code, 0);
  assert.equal(output, 'timeout completed');
  const { helper } = JSON.parse(fs.readFileSync(ready, 'utf8'));
  assert.throws(() => process.kill(helper, 0), { code: 'ESRCH' }, 'the helper must leave with the timed out command');
});
