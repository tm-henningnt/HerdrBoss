import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { clearNight, nightFile, nightNoticeSent, readNight, readNightRecord, withNoticeMark, writeNight } from '../src/night.js';
import { renderBulletin } from '../src/rules.js';

const NOW = Date.parse('2026-09-28T22:00:00Z');
const UNTIL = '2026-09-29T05:30:00.000Z';

let counter = 0;
// Every test uses its own data directory. The service data directory is never written.
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `herdr-night-${counter += 1}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function bulletin(snap) {
  return renderBulletin({ updatedAt: new Date(NOW).toISOString(), quotas: [], ...snap }, { alerts: [], advice: [] }, { host: '127.0.0.1', port: 4477 });
}

test('night state round trips through the data directory', (t) => {
  const dataDir = tempDir(t);
  assert.deepEqual(readNight({ dataDir, now: NOW }), { active: false });
  writeNight({ active: true, since: new Date(NOW).toISOString(), until: UNTIL, by: 'owner', quietHours: false }, { dataDir });
  const state = readNight({ dataDir, now: NOW });
  assert.equal(state.active, true);
  assert.equal(state.since, new Date(NOW).toISOString());
  assert.equal(Date.parse(state.until), Date.parse(UNTIL));
  assert.equal(state.by, 'owner');
  assert.equal(state.quietHours, false);
  assert.equal(state.active, true);
});

test('a cleared night state reads as not active', (t) => {
  const dataDir = tempDir(t);
  writeNight({ active: true, since: new Date(NOW).toISOString(), until: UNTIL, by: 'owner', quietHours: true }, { dataDir });
  clearNight({ dataDir });
  assert.deepEqual(readNight({ dataDir, now: NOW }), { active: false });
  // A clear on a directory without a state file does nothing.
  clearNight({ dataDir });
  assert.deepEqual(readNight({ dataDir, now: NOW }), { active: false });
});

test('the night state file holds only the owner', (t) => {
  const dataDir = tempDir(t);
  writeNight({ active: true, since: new Date(NOW).toISOString(), until: UNTIL, by: 'owner', quietHours: true }, { dataDir });
  assert.equal(fs.statSync(nightFile(dataDir)).mode & 0o777, 0o600);
  // A second write keeps the mode, because the temporary file is renamed over the old one.
  writeNight({ active: true, since: new Date(NOW).toISOString(), until: UNTIL, by: 'owner', quietHours: true }, { dataDir });
  assert.equal(fs.statSync(nightFile(dataDir)).mode & 0o777, 0o600);
});

test('a night state that passed its end time reads as not active', (t) => {
  const dataDir = tempDir(t);
  writeNight({ active: true, since: new Date(NOW).toISOString(), until: UNTIL, by: 'owner', quietHours: false }, { dataDir });
  assert.equal(readNight({ dataDir, now: Date.parse(UNTIL) - 1 }).active, true);
  assert.deepEqual(readNight({ dataDir, now: Date.parse(UNTIL) }), { active: false });
  assert.deepEqual(readNight({ dataDir, now: Date.parse(UNTIL) + 3600000 }), { active: false });
  // The file stays, so a later task can read the notice marks from it.
  assert.ok(fs.existsSync(nightFile(dataDir)));
});

test('the bulletin names the night end time and the quiet hours', (t) => {
  const dir = tempDir(t);
  assert.ok(dir);
  const label = new Date(UNTIL).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const off = bulletin({ night: { active: true, since: new Date(NOW).toISOString(), until: UNTIL, by: 'owner', quietHours: false } });
  assert.ok(off.includes(`- Night watch until ${label} (Owner away). Work as normal; the Boss handles judgment calls.`), off);
  assert.ok(!off.includes('Quiet hours: on.'), off);
  const on = bulletin({ night: { active: true, since: new Date(NOW).toISOString(), until: UNTIL, by: 'owner', quietHours: true } });
  assert.ok(on.includes(`- Night watch until ${label} (Owner away). Work as normal; the Boss handles judgment calls.`), on);
  assert.ok(on.includes('- Quiet hours: on.'), on);
  assert.ok(!bulletin({ night: { active: false } }).includes('Night watch'), 'an inactive state adds no line');
  assert.ok(!bulletin({}).includes('Night watch'), 'a snapshot without a state adds no line');
  // The line comes before the quota and lane lines, so an orchestrator reads it first.
  assert.ok(off.indexOf('Night watch until') < off.indexOf('## Quotas'), 'the line stays near the top');
});

test('the engine state carries the stored night state', (t) => {
  const temp = tempDir(t);
  const dataDir = path.join(temp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  writeNight({ active: true, since: new Date(NOW).toISOString(), until: UNTIL, by: 'owner', quietHours: true }, { dataDir });
  const engineUrl = new URL('../src/engine.js', import.meta.url).href;
  const configUrl = new URL('../src/config.js', import.meta.url).href;
  const script = `
import { Engine } from ${JSON.stringify(engineUrl)};
import { loadConfig } from ${JSON.stringify(configUrl)};
const engine = new Engine(loadConfig(), { push: false, act: false, collectors: {
  collectHerdr: async () => ({ panes: [], workspaces: [] }),
  collectMachine: async () => null,
  collectProcesses: async () => new Map(),
  collectQuotas: async () => [],
  collectWorktreeCounts: async () => ({}),
  collectCwdProcesses: async () => [],
  collectMissingWorktreeProcesses: async () => [],
} });
console.log(JSON.stringify((await engine.tick()).night));
`;
  const env = { ...process.env, HOME: temp, HERDR_BOSS_DIR: dataDir, HERDR_BOSS_LIVE_DIR: path.join(temp, 'live'), NODE_TEST_CONTEXT: '1' };
  const state = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' }));
  assert.equal(state.active, true);
  assert.equal(state.quietHours, true);
  assert.equal(state.by, 'owner');
  assert.equal(fs.statSync(nightFile(dataDir)).mode & 0o777, 0o600);
  clearNight({ dataDir });
  const off = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' }));
  assert.deepEqual(off, { active: false });
});

test('the engine and the bulletin pass the night state to machineLimits', () => {
  const engine = fs.readFileSync(new URL('../src/engine.js', import.meta.url), 'utf8');
  const rules = fs.readFileSync(new URL('../src/rules.js', import.meta.url), 'utf8');
  const calls = [...engine.matchAll(/machineLimits\(([^)]*)\)/g), ...rules.matchAll(/machineLimits\(([^)]*\))[^)]*\)/g)].map((m) => m[0]);
  assert.ok(calls.length >= 3, calls.join('\n'));
  for (const call of calls) assert.match(call, /snap\.night/, call);
});

test('a notice mark is stored per pane and keeps the other keys', () => {
  const base = { active: true, since: new Date(NOW).toISOString(), until: UNTIL, by: 'owner', quietHours: true };
  const marked = withNoticeMark(base, 'start', 'w1:p1', new Date(NOW).toISOString());
  assert.deepEqual(marked.noticeStartAt, { 'w1:p1': new Date(NOW).toISOString() });
  assert.equal(marked.until, UNTIL, 'the end time stays as it is');
  assert.equal(marked.quietHours, true, 'the quiet hours stay as they are');
  assert.equal(base.noticeStartAt, undefined, 'the stored record is not changed');
  const two = withNoticeMark(marked, 'start', 'w2:p1', new Date(NOW + 1).toISOString());
  assert.deepEqual(Object.keys(two.noticeStartAt), ['w1:p1', 'w2:p1'], 'a second pane adds a mark');
  const stopped = withNoticeMark(two, 'end', 'w1:p1', new Date(NOW + 2).toISOString());
  assert.equal(Object.keys(stopped.noticeStopAt).length, 1, 'the end marks are a separate key');
  assert.deepEqual([...nightNoticeSent(stopped, 'start')], ['w1:p1', 'w2:p1'], 'the start marks name both panes');
  assert.deepEqual([...nightNoticeSent(stopped, 'end')], ['w1:p1'], 'the end marks name the pane that got the notice');
  assert.throws(() => nightNoticeSent(stopped, 'middle'), TypeError, 'an unknown phase is a caller error');
  assert.throws(() => withNoticeMark(base, 'middle', 'w1:p1', new Date(NOW).toISOString()), TypeError);
});

test('a mark from before the night started does not count', () => {
  const record = { active: true, since: new Date(NOW).toISOString(), until: UNTIL,
    noticeStartAt: { 'w1:p1': new Date(NOW - 1).toISOString(), 'w2:p1': new Date(NOW).toISOString() } };
  assert.deepEqual([...nightNoticeSent(record, 'start')], ['w2:p1'], 'the earlier mark belongs to an earlier night');
  assert.deepEqual([...nightNoticeSent({ active: true, startedAt: record.since, noticeStopAt: { 'w9:p9': record.noticeStartAt['w1:p1'] } }, 'end')], [],
    'a record without a start time takes every mark');
  assert.deepEqual([...nightNoticeSent(null, 'start')], [], 'a missing record has no marks');
  assert.deepEqual([...nightNoticeSent({ active: true, noticeStartAt: [] }, 'start')], [], 'a broken mark key has no marks');
});

test('the stored record reads back with its notice marks', (t) => {
  const dataDir = tempDir(t);
  assert.equal(readNightRecord({ dataDir }), null, 'a directory without a state file has no record');
  writeNight(withNoticeMark({ active: true, since: new Date(NOW).toISOString(), until: UNTIL, by: 'owner', quietHours: false },
    'start', 'w1:p1', new Date(NOW).toISOString()), { dataDir });
  const record = readNightRecord({ dataDir });
  assert.equal(record.noticeStartAt['w1:p1'], new Date(NOW).toISOString());
  assert.equal(readNight({ dataDir, now: NOW }).until, new Date(UNTIL).toISOString(), 'the read state still works');
  clearNight({ dataDir });
  assert.equal(readNightRecord({ dataDir }), null, 'a cleared state file has no record');
});
