import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adaptSheetListing, prepareQlikDemoApp, scanExportContent } from '../kit/skills/herdr-orchestrator/reference/qlik-demo-app.mjs';

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

test('the demo app workflow publishes private sheets, verifies the count and flags, then exports', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qlik-demo-app-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  let published = false;
  const calls = [];
  const run = async (executable, args, options) => {
    calls.push({ executable, args });
    if (args[0] === 'app' && args[1] === 'object' && args[2] === 'ls') {
      return { status: 0, stdout: JSON.stringify({ objects: [
        { id: 'sheet-one', type: 'sheet', meta: { published, approved: published } },
      ] }) };
    }
    if (args[0] === 'app' && args[1] === 'object' && args[2] === 'publish') {
      published = true;
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
    ['qlik', 'app', 'object', 'publish', 'sheet-one', '--app', 'fixture-app'],
    ['qlik', 'app', 'object', 'ls', '--app', 'fixture-app', '--json'],
    ['qlik', 'app', 'export', 'fixture-app', '--output-file', 'out/fixture-demo.qvf', '--NoData'],
  ]);
  assert.equal(result.sheetCount, 1);
  assert.equal(result.scan.bytes, Buffer.byteLength('synthetic demo data'));
  assert.equal(fs.existsSync(path.join(cwd, 'out', 'fixture-demo.qvf')), true);
  assert.doesNotMatch(JSON.stringify(result), /fixture-app|sheet-one|synthetic demo data/);
});

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
  const run = async (_executable, args) => {
    if (args[2] === 'ls') return { status: 0, stdout: JSON.stringify({ objects: [{ id: 'sheet-one', type: 'sheet', meta: { published: false, approved: false } }] }) };
    if (args[2] === 'publish') return { status: 0, stdout: '' };
    throw new Error('export must not run before verification passes');
  };
  await assert.rejects(prepareQlikDemoApp({ appId: 'fixture-app', outputName: 'fixture-demo', cwd, run }), /A Qlik sheet is not both published and approved/);
});

test('the workflow fails when the sheet count changes before export', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qlik-demo-app-count-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  let listings = 0;
  const run = async (_executable, args) => {
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
});
