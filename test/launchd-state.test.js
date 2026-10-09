import './helpers/test-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { LAUNCHD_NODE_FIX, LAUNCHD_PROBE_TIMEOUT_MS, launchdNodeNotice, launchdNodeProblem } from '../src/launchd-state.js';
import { launchdNodeNoticeLine } from '../src/cli.js';

const NODE = '/opt/homebrew/bin/node';
const CELLAR = '/opt/homebrew/Cellar/node/26.10.0/bin/node';
// The launchd text of a job that a Homebrew node upgrade stopped, and of the same job in a good state.
const job = (...lines) => ['gui/501/no.tallmaker.herdr-boss = {', '\tactive count = 1', ...lines, `\tprogram = ${NODE}`, '}'].join('\n');
const STOPPED = job('\tstate = exited');
const REPLACED = job('\tstate = exited', '\tlast exit code = 78');
const LWCR = job('\tstate = exited', '\tthe program needs LWCR update');
const RUNNING = job('\tstate = running');
const down = async () => false;
const up = async () => true;
const prints = (output) => async () => output;

test('a stopped job with exit code 78 and a running job read as a replaced node binary', () => {
  assert.equal(launchdNodeProblem(REPLACED, { installedNode: NODE }), true);
  assert.equal(launchdNodeProblem(RUNNING, { installedNode: NODE }), false);
});

test('a stopped job that needs LWCR update reads as a replaced node binary', () => {
  assert.equal(launchdNodeProblem(LWCR, { installedNode: NODE }), true);
  const running = job('\tstate = running', '\tthe program needs LWCR update');
  assert.equal(launchdNodeProblem(running, { installedNode: NODE }), false);
});

test('a program path that differs from the installed node reads as a replaced node binary', () => {
  const cellar = (lines) => ['gui/501/no.tallmaker.herdr-boss = {', ...lines, `\tprogram = ${CELLAR}`, '}'].join('\n');
  assert.equal(launchdNodeProblem(cellar(['\tstate = exited']), { installedNode: NODE }), true);
  assert.equal(launchdNodeProblem(cellar(['\tstate = running']), { installedNode: NODE }), true);
  assert.equal(launchdNodeProblem(RUNNING, { installedNode: NODE }), false);
  assert.equal(launchdNodeProblem(STOPPED, { installedNode: null }), false, 'without an installed node path only the exit code counts');
});

test('text without the markers of a replaced node binary reads as good', () => {
  for (const output of ['', '   ', 'state = exited', '\tlast exit code = 0', 'system could not find the job', undefined, null, 78]) {
    assert.equal(launchdNodeProblem(output, { installedNode: NODE }), false, JSON.stringify(output));
  }
  assert.equal(launchdNodeProblem(REPLACED), true, 'the exit code alone needs no installed node path');
  assert.equal(launchdNodeProblem(REPLACED, {}), true);
});

test('the notice gives one fixed repair line and one short timeout', () => {
  assert.equal(LAUNCHD_NODE_FIX, 'Homebrew replaced node: run herdr-boss install');
  assert.equal(LAUNCHD_PROBE_TIMEOUT_MS, 1000);
});

test('the notice prints nothing when the dashboard port answers', async () => {
  let asked = false;
  const line = await launchdNodeNotice({ launchctl: async () => { asked = true; return REPLACED; }, probe: up, installedNode: NODE });
  assert.equal(line, '');
  assert.equal(asked, false, 'the notice must not read launchctl when the dashboard answers');
});

test('the notice prints nothing when launchctl fails or times out', async () => {
  const failed = await launchdNodeNotice({ launchctl: async () => { throw new Error('Command timed out.'); }, probe: down, installedNode: NODE });
  assert.equal(failed, '');
  const refused = await launchdNodeNotice({ launchctl: prints(REPLACED), probe: async () => { throw new Error('The port probe failed.'); }, installedNode: NODE });
  assert.equal(refused, '');
});

test('the notice gives the repair line for a stopped job and nothing for a running one', async () => {
  assert.equal(await launchdNodeNotice({ launchctl: prints(REPLACED), probe: down, installedNode: NODE }), LAUNCHD_NODE_FIX);
  assert.equal(await launchdNodeNotice({ launchctl: prints(RUNNING), probe: down, installedNode: NODE }), '');
});

test('a command prints the repair line once on standard error', async () => {
  const writes = [];
  const line = await launchdNodeNoticeLine('publish', {
    launchctl: prints(REPLACED),
    probe: down,
    installedNode: NODE,
    platform: 'darwin',
    stderr: { write: (value) => writes.push(value) },
  });
  assert.equal(line, LAUNCHD_NODE_FIX);
  assert.deepEqual(writes, [`${LAUNCHD_NODE_FIX}\n`]);
});

test('the service commands, another platform and a failed check print no repair line', async () => {
  const options = { launchctl: prints(REPLACED), probe: down, installedNode: NODE };
  for (const command of ['doctor', 'install', 'uninstall', 'logs', 'serve', undefined]) {
    const writes = [];
    const line = await launchdNodeNoticeLine(command, { ...options, platform: 'darwin', stderr: { write: (value) => writes.push(value) } });
    assert.equal(line, '', `${command} must not print the repair line`);
    assert.deepEqual(writes, []);
  }
  const linux = [];
  assert.equal(await launchdNodeNoticeLine('publish', { ...options, platform: 'linux', stderr: { write: (value) => linux.push(value) } }), '');
  assert.deepEqual(linux, []);
  const broken = [];
  assert.equal(await launchdNodeNoticeLine('publish', {
    ...options,
    launchctl: async () => { throw new Error('launchctl is not allowed.'); },
    platform: 'darwin',
    stderr: { write: (value) => broken.push(value) },
  }), '');
  assert.deepEqual(broken, []);
});
