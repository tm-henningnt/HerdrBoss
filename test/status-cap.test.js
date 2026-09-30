import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Every file is in a temporary HOME and data directory. No real project is touched.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-status-cap-'));
process.env.HERDR_BOSS_DIR = path.join(ROOT, 'boss');
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));
const { capDoneTasks, validateProject, DONE_KEEP } = await import('../src/projects.js');
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

const done = (id, extra = {}) => ({ id: String(id), title: `Task ${id}`, status: 'done', ...extra });
const stamp = (n) => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();

test('keeps the last 30 done tasks by updated time and counts the rest', () => {
  const tasks = Array.from({ length: 35 }, (_, i) => done(i, { updated: stamp(35 - i) }));
  tasks.push({ id: 'open', title: 'Open', status: 'todo' });
  const data = { project: 'P', tasks };
  const removed = capDoneTasks(data, null);
  assert.equal(DONE_KEEP, 30);
  assert.equal(removed, 5);
  assert.equal(data.doneCount, 5);
  assert.equal(data.tasks.filter((t) => t.status === 'done').length, 30);
  // Task 0 has the newest time. Tasks 30 to 34 have the oldest times.
  assert.ok(data.tasks.some((t) => t.id === '0'));
  assert.ok(!data.tasks.some((t) => ['30', '31', '32', '33', '34'].includes(t.id)));
  assert.ok(data.tasks.some((t) => t.id === 'open'));
});

test('uses file order when done tasks have no updated time', () => {
  const data = { project: 'P', tasks: Array.from({ length: 32 }, (_, i) => done(i)) };
  assert.equal(capDoneTasks(data, null), 2);
  assert.deepEqual(data.tasks.map((t) => t.id).slice(0, 2), ['2', '3']);
});

test('keeps a done task that another open task lists in blockedBy', () => {
  const tasks = Array.from({ length: 32 }, (_, i) => done(i));
  tasks.push({ id: 'next', title: 'Next', status: 'todo', blockedBy: ['0'] });
  const data = { project: 'P', tasks };
  assert.equal(capDoneTasks(data, null), 1);
  assert.ok(data.tasks.some((t) => t.id === '0'));
  assert.ok(!data.tasks.some((t) => t.id === '1'));
  assert.equal(data.doneCount, 1);
});

test('a status without done tasks stays as it is', () => {
  const data = { project: 'P', tasks: [{ title: 'A', status: 'todo' }, { title: 'B', status: 'doing' }] };
  const before = JSON.stringify(data);
  assert.equal(capDoneTasks(data, null), 0);
  assert.equal(JSON.stringify(data), before);
  const empty = { project: 'P' };
  assert.equal(capDoneTasks(empty, null), 0);
  assert.equal(Object.hasOwn(empty, 'doneCount'), false);
});

test('a legacy doneCount without ids is kept in doneCountBase', () => {
  const data = { project: 'P', tasks: Array.from({ length: 31 }, (_, i) => done(i)) };
  assert.equal(capDoneTasks(data, { doneCount: 10 }), 1);
  assert.equal(data.doneCountBase, 10);
  assert.deepEqual(data.doneIds, ['0']);
  assert.equal(data.doneCount, 11);
  const none = { project: 'P', tasks: [done(1)] };
  capDoneTasks(none, { doneCount: 7 });
  assert.equal(none.doneCount, 7);
  assert.equal(none.doneCountBase, 7);
});

test('an id that is open again leaves doneIds and the count drops', () => {
  const data = { project: 'P', tasks: Array.from({ length: 31 }, (_, i) => done(i)) };
  capDoneTasks(data, null);
  assert.equal(data.doneCount, 1);
  data.tasks.push({ id: '0', title: 'Task 0', status: 'todo' });
  assert.equal(capDoneTasks(data, null), 0);
  assert.equal(data.doneCount, undefined);
  assert.equal(data.doneIds, undefined);
});

test('doneIds keeps 5000 ids and moves the oldest into doneCountBase', () => {
  const doneIds = Array.from({ length: 5000 }, (_, i) => `old${i}`);
  const data = { project: 'P', doneIds, doneCount: 5000, tasks: Array.from({ length: 31 }, (_, i) => done(i)) };
  capDoneTasks(data, null);
  assert.equal(data.doneIds.length, 5000);
  assert.equal(data.doneIds.at(-1), '0');
  assert.equal(data.doneIds[0], 'old1');
  assert.equal(data.doneCountBase, 1);
  assert.equal(data.doneCount, 5001);
});

test('doneCount, doneCountBase, and doneIds are validated', () => {
  for (const bad of [-1, 1.5, '3', NaN, {}, [], true, 1000001]) {
    assert.ok(validateProject({ project: 'P', doneCount: bad }).some((e) => e.includes('doneCount')), String(bad));
    assert.ok(validateProject({ project: 'P', doneCountBase: bad }).some((e) => e.includes('doneCountBase')), String(bad));
  }
  assert.deepEqual(validateProject({ project: 'P', doneCount: 1000000, doneCountBase: 0, doneIds: ['a'] }), []);
  for (const bad of ['a', [1], [''], ['a\nb'], ['x'.repeat(201)], Array(5001).fill('a')]) {
    assert.ok(validateProject({ project: 'P', doneIds: bad }).some((e) => e.includes('doneIds')));
  }
});

function publish(slug, data) {
  const file = path.join(ROOT, `${slug}-in.json`);
  fs.writeFileSync(file, JSON.stringify(data));
  const cwd = fs.mkdtempSync(path.join(ROOT, 'cwd-'));
  const env = { ...process.env, HOME: path.join(ROOT, 'home'), HERDR_BOSS_DIR: path.join(ROOT, 'boss'), GIT_CEILING_DIRECTORIES: ROOT };
  return spawnSync(process.execPath, [CLI, 'publish', slug, file], { cwd, env, encoding: 'utf8' });
}
const stored = (slug) => JSON.parse(fs.readFileSync(path.join(ROOT, 'boss', 'projects', `${slug}.json`), 'utf8'));

const many = (from, n) => Array.from({ length: n }, (_, i) => done(from + i));

test('publish prints one line and the count adds up over two publishes', () => {
  fs.mkdirSync(path.join(ROOT, 'boss', 'projects'), { recursive: true });
  const first = publish('capped', { project: 'P', tasks: many(0, 34) });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /moved 4 done tasks into doneCount/);
  assert.equal(stored('capped').doneCount, 4);
  assert.equal(stored('capped').tasks.length, 30);
  // The orchestrator publishes the stored file again with 3 new done tasks.
  const again = stored('capped');
  again.tasks.push(...many(100, 3));
  const second = publish('capped', again);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /moved 3 done tasks into doneCount/);
  assert.equal(stored('capped').doneCount, 7);
  // A file without doneCount does not lose the stored count.
  const third = publish('capped', { project: 'P', tasks: many(200, 31) });
  assert.equal(third.status, 0, third.stderr);
  assert.equal(stored('capped').doneCount, 8);
});

test('a republish of the same uncapped file leaves doneCount unchanged', () => {
  const file = { project: 'P', tasks: many(0, 40) };
  assert.equal(publish('same', file).status, 0);
  assert.equal(stored('same').doneCount, 10);
  const again = publish('same', file);
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /doneCount/);
  assert.equal(stored('same').doneCount, 10);
  const third = publish('same', file);
  assert.equal(third.status, 0);
  assert.equal(stored('same').doneCount, 10);
});

test('a local file that gained 3 done tasks adds 3', () => {
  const file = { project: 'P', tasks: many(0, 40) };
  publish('grow', file);
  file.tasks.push(...many(100, 3));
  const result = publish('grow', file);
  assert.match(result.stdout, /moved 3 done tasks/);
  assert.equal(stored('grow').doneCount, 13);
});

test('a counted id that is open again drops out of the count', () => {
  const file = { project: 'P', tasks: many(0, 31) };
  publish('reopen', file);
  assert.equal(stored('reopen').doneCount, 1);
  file.tasks[0] = { id: '0', title: 'Task 0', status: 'todo' };
  assert.equal(publish('reopen', file).status, 0);
  assert.equal(stored('reopen').doneCount, undefined);
});

test('a legacy stored doneCount is preserved', () => {
  fs.writeFileSync(path.join(ROOT, 'boss', 'projects', 'legacy.json'), JSON.stringify({ project: 'P', doneCount: 12, tasks: [] }));
  const result = publish('legacy', { project: 'P', tasks: many(0, 31) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(stored('legacy').doneCount, 13);
  assert.equal(stored('legacy').doneCountBase, 12);
  assert.equal(publish('legacy', { project: 'P', tasks: many(0, 31) }).status, 0);
  assert.equal(stored('legacy').doneCount, 13);
});

test('publish prints no cap line when no done task moves', () => {
  const result = publish('small', { project: 'P', tasks: [done(1)] });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /doneCount/);
});

test('publish rejects an invalid doneCount', () => {
  const result = publish('bad', { project: 'P', doneCount: -3, tasks: [] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /doneCount/);
});

test('publish warns when the status is larger than 200 KB and still publishes', () => {
  const result = publish('big', { project: 'P', notes: ['x'.repeat(210 * 1024)] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /larger than 200 KB/);
  assert.ok(fs.existsSync(path.join(ROOT, 'boss', 'projects', 'big.json')));
});

test('a done task without a usable id stays in the file and doneCount stays stable', () => {
  const odd = [{ title: 'No id', status: 'done' }, done('x'.repeat(201)), done('a\nb')];
  const file = { project: 'P', tasks: [...odd, ...many(0, 33)] };
  assert.equal(publish('odd', file).status, 0);
  const first = stored('odd');
  assert.equal(first.doneCount, 3);
  for (const task of odd) assert.ok(first.tasks.some((t) => t.title === task.title), task.title);
  assert.equal(publish('odd', file).status, 0);
  assert.equal(stored('odd').doneCount, 3);
  assert.equal(stored('odd').tasks.length, first.tasks.length);
});
