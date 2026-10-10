import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptSheetListing, adaptSheetState, prepareQlikDemoApp, scanExportContent } from '../kit/skills/herdr-orchestrator/reference/qlik-demo-app.mjs';

const helperPath = fileURLToPath(new URL('../kit/skills/herdr-orchestrator/reference/qlik-demo-app.mjs', import.meta.url));

test('sheet listing adapter reads supported object id and published and approved fields', () => {
  assert.deepEqual(adaptSheetListing({ objects: [
    { objectId: 'sheet-one', objectType: 'sheet', qMeta: { published: false, approved: false } },
    { qInfo: { qId: 'sheet-two', qType: 'sheet' }, qMetaDef: { published: true, approved: true } },
    { id: 'chart-one', type: 'chart', published: false, approved: false },
  ] }), [
    { id: 'sheet-one', published: false, approved: false },
    { id: 'sheet-two', published: true, approved: true },
  ]);
});

test('sheet listing adapter accepts the current state-less qlik-cli shape and skips other object types', () => {
  assert.deepEqual(adaptSheetListing({ objects: [
    { qId: 'sheet-1', qType: 'sheet', title: 'Sheet one' },
    { qId: 'chart-1', qType: 'chart', title: 'Chart one' },
  ] }), [{ id: 'sheet-1', published: undefined, approved: undefined }]);
});

test('per-sheet state adapter reads published and approved qMeta flags', () => {
  assert.deepEqual(adaptSheetState({ qMeta: { published: true, approved: true } }), { published: true, approved: true });
  assert.deepEqual(adaptSheetState({ qMeta: { published: false, approved: false } }), { published: false, approved: false });
});

test('the demo app workflow reads per-sheet state, publishes only private sheets, verifies again, then exports', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qlik-demo-app-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const states = new Map([
    ['sheet-1', { published: true, approved: true }],
    ['sheet-2', { published: false, approved: false }],
  ]);
  const calls = [];
  const run = async (executable, args, options) => {
    calls.push({ executable, args });
    if (args[0] === 'app' && args[1] === 'object' && args[2] === 'ls') {
      return { status: 0, stdout: JSON.stringify({ objects: [
        { qId: 'sheet-1', qType: 'sheet', title: 'Sheet one' },
        { qId: 'sheet-2', qType: 'sheet', title: 'Sheet two' },
        { qId: 'chart-1', qType: 'chart', title: 'Chart one' },
      ] }) };
    }
    if (args[0] === 'app' && args[1] === 'object' && args[2] === 'properties') {
      return { status: 0, stdout: JSON.stringify({ qMeta: states.get(args[3]) }) };
    }
    if (args[0] === 'app' && args[1] === 'object' && args[2] === 'publish') {
      states.set(args[3], { published: true, approved: true });
      return { status: 0, stdout: '' };
    }
    if (args[0] === 'app' && args[1] === 'export') {
      fs.writeFileSync(path.join(options.cwd, args[args.indexOf('--output-file') + 1]), 'synthetic demo data');
      return { status: 0, stdout: '' };
    }
    throw new Error('unexpected fixture command');
  };
  const result = await prepareQlikDemoApp({ appId: 'fixture-app', outputName: 'fixture-demo', noData: true, cwd, run });
  assert.deepEqual(calls.map(({ executable, args }) => [executable, ...args]), [
    ['qlik', 'app', 'object', 'ls', '--app', 'fixture-app', '--json'],
    ['qlik', 'app', 'object', 'properties', 'sheet-1', '--app', 'fixture-app', '--json'],
    ['qlik', 'app', 'object', 'properties', 'sheet-2', '--app', 'fixture-app', '--json'],
    ['qlik', 'app', 'object', 'publish', 'sheet-2', '--app', 'fixture-app'],
    ['qlik', 'app', 'object', 'ls', '--app', 'fixture-app', '--json'],
    ['qlik', 'app', 'object', 'properties', 'sheet-1', '--app', 'fixture-app', '--json'],
    ['qlik', 'app', 'object', 'properties', 'sheet-2', '--app', 'fixture-app', '--json'],
    ['qlik', 'app', 'export', 'fixture-app', '--output-file', 'out/fixture-demo.qvf', '--NoData'],
  ]);
  assert.equal(result.sheetCount, 2);
  assert.equal(result.scan.bytes, Buffer.byteLength('synthetic demo data'));
  assert.equal(fs.existsSync(path.join(cwd, 'out', 'fixture-demo.qvf')), true);
  assert.doesNotMatch(JSON.stringify(result), /fixture-app|sheet-1|Sheet one|synthetic demo data/);
});

test('a listing with the older state fields does not need a per-sheet read', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qlik-demo-app-old-listing-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const calls = [];
  const run = async (_executable, args, options) => {
    calls.push(args);
    if (args[2] === 'ls') return { status: 0, stdout: JSON.stringify({ objects: [
      { id: 'sheet-1', type: 'sheet', meta: { published: true, approved: true } },
    ] }) };
    if (args[1] === 'export') {
      fs.writeFileSync(path.join(options.cwd, args[args.indexOf('--output-file') + 1]), 'synthetic demo data');
      return { status: 0, stdout: '' };
    }
    throw new Error('unexpected fixture command');
  };
  await prepareQlikDemoApp({ appId: 'fixture-app', outputName: 'fixture-demo', cwd, run });
  assert.deepEqual(calls.map((args) => args.slice(0, 3)), [
    ['app', 'object', 'ls'],
    ['app', 'object', 'ls'],
    ['app', 'export', 'fixture-app'],
  ]);
});

for (const [mode, expectedMessage] of [
  ['property-fail', 'qlik-demo-app: refused: a qlik command failed. No file was exported.'],
  ['property-no-state', 'qlik-demo-app: refused: the listing has no complete published and approved state, and the per-sheet read failed or returned no state. The CLI output changed. No file was exported.'],
  ['property-string', 'qlik-demo-app: refused: the listing has no complete published and approved state, and the per-sheet read failed or returned no state. The CLI output changed. No file was exported.'],
  ['property-null', 'qlik-demo-app: refused: the listing has no complete published and approved state, and the per-sheet read failed or returned no state. The CLI output changed. No file was exported.'],
  ['property-invalid-json', 'qlik-demo-app: refused: the listing has no complete published and approved state, and the per-sheet read failed or returned no state. The CLI output changed. No file was exported.'],
  ['bad-sheet-leading-dash', 'qlik-demo-app: refused: an app or sheet id is invalid. No file was exported.'],
  ['bad-sheet-special', 'qlik-demo-app: refused: an app or sheet id is invalid. No file was exported.'],
  ['too-many-sheets', 'qlik-demo-app: refused: the app has more than 500 sheets. No file was exported.'],
  ['duplicate-sheets', 'qlik-demo-app: refused: the sheet list has duplicate IDs. No file was exported.'],
]) {
  test(`the CLI prints a fixed safe refusal for ${mode}`, async (t) => {
    const { stderr, calls } = await runCliFixture(t, mode);
    assert.equal(stderr, `${expectedMessage}\n`);
    if (['too-many-sheets', 'duplicate-sheets', 'bad-sheet-leading-dash', 'bad-sheet-special'].includes(mode)) {
      assertNoPropertiesRead(calls);
    }
    assertNoInputValues(stderr);
  });
}

test('an invalid app id refuses before the helper calls qlik', async (t) => {
  const { stderr, calls } = await runCliFixture(t, 'normal', { appId: '-fixture-app' });
  assert.equal(stderr, 'qlik-demo-app: refused: an app or sheet id is invalid. No file was exported.\n');
  assert.deepEqual(calls, []);
  assertNoExport(calls);
  assertNoInputValues(stderr);
});

test('string listing flags force a per-sheet state read', async (t) => {
  const { status, calls, stderr } = await runCliFixture(t, 'listing-string-flags', { expectedStatus: 0 });
  assert.equal(status, 0);
  assert.equal(stderr, '');
  assert.equal(calls.filter((args) => args[2] === 'properties').length, 2);
  assert.equal(calls.filter((args) => args[2] === 'publish').length, 0);
  assert.equal(calls.filter((args) => args[1] === 'export').length, 1);
});

test('the CLI prints a fixed safe refusal when the sheet count changes', async (t) => {
  const { stderr } = await runCliFixture(t, 'count-changed');
  assert.equal(stderr, 'qlik-demo-app: refused: the sheet count changed. No file was exported.\n');
  assertNoInputValues(stderr);
});

test('the CLI prints a fixed safe refusal when sheets stay private after publishing', async (t) => {
  const { stderr } = await runCliFixture(t, 'still-private');
  assert.equal(stderr, 'qlik-demo-app: refused: sheets remain unpublished or unapproved after publishing. No file was exported.\n');
  assertNoInputValues(stderr);
});

test('the CLI prints a fixed safe refusal when the export scan refuses the file', async (t) => {
  const { stderr, calls, outputPath } = await runCliFixture(t, 'scan-refused');
  assert.equal(stderr, 'qlik-demo-app: refused: the export scan found unsafe content. The file was removed.\n');
  assert.equal(calls.filter((args) => args[1] === 'export').length, 1);
  assert.equal(fs.existsSync(outputPath), false);
  assertNoInputValues(stderr);
});

test('the CLI removes a partial file when the export command fails', async (t) => {
  const { stderr, calls, outputPath } = await runCliFixture(t, 'export-fail');
  assert.equal(stderr, 'qlik-demo-app: refused: a qlik command failed. No file was exported.\n');
  assert.equal(calls.filter((args) => args[1] === 'export').length, 1);
  assert.equal(fs.existsSync(outputPath), false);
  assertNoInputValues(stderr);
});

test('the CLI keeps the generic safe message for unknown errors', async (t) => {
  const { stderr } = await runCliFixture(t, 'unknown');
  assert.equal(stderr, 'qlik-demo-app: operation failed; no input values were printed.\n');
  assertNoInputValues(stderr);
});

function assertNoInputValues(text) {
  assert.doesNotMatch(text, /fixture-app|fixture-demo|sheet-1|Sheet one|\/out\//);
}

async function runCliFixture(t, mode, { appId = 'fixture-app', expectedStatus = 1 } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `qlik-demo-app-cli-${mode}-`));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const fakeQlik = path.join(cwd, 'qlik-fixture.mjs');
  const callLogPath = path.join(cwd, 'qlik-calls.jsonl');
  fs.writeFileSync(fakeQlik, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const mode = process.env.FIXTURE_MODE;
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_CALL_LOG, JSON.stringify(args) + '\\n');
if (mode === 'unknown') {
  process.stdout.write('not json');
  process.exit(0);
}
if (args[0] === 'app' && args[1] === 'object' && args[2] === 'ls') {
  const countFile = path.join(process.cwd(), '.fixture-list-count');
  const count = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf8') : 0) + 1;
  fs.writeFileSync(countFile, String(count));
  let objects = [{ qId: 'sheet-1', qType: 'sheet', title: 'Sheet one' }];
  if (mode === 'bad-sheet-leading-dash') objects[0].qId = '-sheet-1';
  if (mode === 'bad-sheet-special') objects[0].qId = 'sheet/1';
  if (mode === 'listing-string-flags') objects[0] = { ...objects[0], published: 'false', approved: 'true' };
  if (mode === 'too-many-sheets') objects = Array.from({ length: 501 }, (_, index) => ({ qId: 'sheet-' + index, qType: 'sheet', title: 'Sheet one' }));
  if (mode === 'duplicate-sheets') objects.push({ qId: 'sheet-1', qType: 'sheet', title: 'Sheet two' });
  if (mode === 'count-changed' && count > 1) objects.push({ qId: 'sheet-2', qType: 'sheet', title: 'Sheet two' });
  console.log(JSON.stringify({ objects }));
  process.exit(0);
}
if (args[0] === 'app' && args[1] === 'object' && args[2] === 'properties') {
  if (mode === 'property-fail') process.exit(8);
  if (mode === 'too-many-sheets' || mode === 'duplicate-sheets' || mode === 'bad-sheet-leading-dash' || mode === 'bad-sheet-special') process.exit(8);
  if (mode === 'property-no-state') {
    console.log(JSON.stringify({ qMeta: {} }));
    process.exit(0);
  }
  if (mode === 'property-string') {
    console.log(JSON.stringify({ qMeta: { published: 'false', approved: false } }));
    process.exit(0);
  }
  if (mode === 'property-null') {
    console.log(JSON.stringify({ qMeta: { published: null, approved: true } }));
    process.exit(0);
  }
  if (mode === 'property-invalid-json') {
    process.stdout.write('not json');
    process.exit(0);
  }
  const isPrivate = mode === 'still-private';
  console.log(JSON.stringify({ qMeta: { published: !isPrivate, approved: !isPrivate } }));
  process.exit(0);
}
if (args[0] === 'app' && args[1] === 'object' && args[2] === 'publish') process.exit(0);
if (args[0] === 'app' && args[1] === 'export') {
  const outputPath = args[args.indexOf('--output-file') + 1];
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, mode === 'scan-refused' ? '/Users/synthetic/fixture' : 'synthetic demo data');
  if (mode === 'export-fail') process.exit(8);
  process.exit(0);
}
process.exit(9);
`);
  fs.chmodSync(fakeQlik, 0o700);
  const result = spawnSync(process.execPath, [helperPath, appId, `fixture-${mode}`, '--qlik', fakeQlik], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, FIXTURE_MODE: mode, FIXTURE_CALL_LOG: callLogPath },
  });
  assert.equal(result.status, expectedStatus);
  const calls = fs.existsSync(callLogPath)
    ? fs.readFileSync(callLogPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const outputPath = path.join(cwd, 'out', `fixture-${mode}.qvf`);
  if (expectedStatus !== 0 && !['scan-refused', 'export-fail'].includes(mode)) assertNoExport(calls);
  return { status: result.status, stderr: result.stderr, stdout: result.stdout, calls, outputPath };
}

function assertNoExport(calls) {
  assert.equal(calls.some((args) => args[0] === 'app' && args[1] === 'export'), false);
}

function assertNoPropertiesRead(calls) {
  assert.equal(calls.some((args) => args[0] === 'app' && args[1] === 'object' && args[2] === 'properties'), false);
}

test('export scanning returns counts without copying matched content', () => {
  const result = scanExportContent(Buffer.from('See https://example.org in synthetic demo content.'));
  assert.equal(result.bytes, Buffer.byteLength('See https://example.org in synthetic demo content.'));
  assert.equal(result.urlHosts, 1);
  assert.doesNotMatch(JSON.stringify(result), /example\.org|synthetic demo content/);
});

test('export scanning counts a private path without returning it', () => {
  const privatePath = `/${['Users', 'sample', 'private'].join('/')}/fixture`;
  const result = scanExportContent(Buffer.from(privatePath));
  assert.equal(result.privatePaths, 1);
  assert.doesNotMatch(JSON.stringify(result), /Users|sample/);
});

test('the workflow fails when a sheet stays private after publishing', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qlik-demo-app-private-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const calls = [];
  const run = async (_executable, args) => {
    calls.push(args);
    if (args[2] === 'ls') return { status: 0, stdout: JSON.stringify({ objects: [{ id: 'sheet-one', type: 'sheet', meta: { published: false, approved: false } }] }) };
    if (args[2] === 'publish') return { status: 0, stdout: '' };
    throw new Error('export must not run before verification passes');
  };
  await assert.rejects(prepareQlikDemoApp({ appId: 'fixture-app', outputName: 'fixture-demo', cwd, run }), /A Qlik sheet is not both published and approved/);
  assertNoExport(calls);
});

test('the workflow fails when the sheet count changes before export', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qlik-demo-app-count-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  let listings = 0;
  const calls = [];
  const run = async (_executable, args) => {
    calls.push(args);
    if (args[2] === 'ls') {
      listings += 1;
      const objects = listings === 1
        ? [{ id: 'sheet-one', type: 'sheet', meta: { published: true, approved: true } }]
        : [
          { id: 'sheet-one', type: 'sheet', meta: { published: true, approved: true } },
          { id: 'sheet-two', type: 'sheet', meta: { published: true, approved: true } },
        ];
      return { status: 0, stdout: JSON.stringify({ objects }) };
    }
    throw new Error('export must not run when the sheet count changes');
  };
  await assert.rejects(prepareQlikDemoApp({ appId: 'fixture-app', outputName: 'fixture-demo', cwd, run }), /sheet count changed/);
  assertNoExport(calls);
});
