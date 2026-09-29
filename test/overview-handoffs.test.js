import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

// Load one top-level function of the dashboard script, with the constants it reads.
function load(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists in public/app.js`);
  const end = source.indexOf('\n}\n', start);
  const context = { HANDOFF_OPEN: ['preparing', 'prepared', 'needs-inspection'] };
  vm.runInNewContext(`${source.slice(start, end + 2)}\nthis.fn = ${name};`, context);
  return context.fn;
}

const panes = [{ id: 'ws:p1' }, { id: 'ws:p2' }, { id: 'wb:p1' }, { id: 'wb:p2' }];
const valid = { id: 'h-valid', project: 'alpha', status: 'prepared', sourcePane: 'ws:p1', newPane: 'ws:p2' };

test('the Overview lists a valid open record for each open state', () => {
  const openRecords = load('openHandoffRecords');
  for (const status of ['prepared', 'preparing', 'needs-inspection']) {
    assert.deepEqual(openRecords([{ ...valid, status }], panes).map((x) => x.id), ['h-valid']);
  }
});

test('the Overview drops an expired, closed, or missing record', () => {
  const openRecords = load('openHandoffRecords');
  const records = [
    { ...valid, id: 'expired', status: 'expired' },
    { ...valid, id: 'active', status: 'active' },
    { ...valid, id: 'superseded', status: 'superseded' },
    { ...valid, id: 'successor-pane-gone', newPane: 'ws:p9' },
    { ...valid, id: 'source-pane-closed', sourcePane: 'ws:p8' },
    { ...valid, id: 'no-successor-pane', newPane: undefined },
    null,
    valid,
  ];
  assert.deepEqual(openRecords(records, panes).map((x) => x.id), ['h-valid']);
  assert.equal(openRecords(undefined, panes).length, 0);
});

test('the Overview keeps a Boss record only as a record, never as a candidate', () => {
  const openRecords = load('openHandoffRecords');
  const boss = { id: 'h-boss', project: 'Boss', boss: true, status: 'prepared', sourcePane: 'wb:p1', newPane: 'wb:p2' };
  assert.deepEqual(openRecords([boss], panes).map((x) => x.id), ['h-boss']);
  const overview = source.slice(source.indexOf('function overview('), source.indexOf('function allocationView('));
  assert.doesNotMatch(overview, /bossHandoff|control\?*\.handoffs/);
  const block = source.slice(source.indexOf('function handoffBlock('), source.indexOf('function browserViewToggle('));
  assert.match(block.split('\n').find((line) => line.includes('const candidates')), /^ *const candidates = projectSlug \? .*bossHandoff.* : \[\];$/);
});
