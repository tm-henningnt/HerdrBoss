import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MAX_SCAN_BYTES = 20 * 1024 * 1024;
const ENGINE_INLINE_PATH = /(?:(?<![A-Za-z0-9._/-])|(?<=8))\/home\/engine\/[0-9a-fA-F-]{36}\.inline(?![A-Za-z0-9._/-])/g;
const OBJECT_LIST_FIELDS = ['objects', 'items', 'appObjects', 'qAppObjects'];
const OBJECT_TYPE_FIELDS = [['type'], ['objectType'], ['qType'], ['qInfo', 'qType'], ['qMeta', 'type'], ['qMetaDef', 'type']];
const OBJECT_ID_FIELDS = [['id'], ['objectId'], ['qId'], ['qInfo', 'qId'], ['qMetaDef', 'qId']];
const PUBLISHED_FIELDS = [['published'], ['isPublished'], ['meta', 'published'], ['qMeta', 'published'], ['qMetaDef', 'published']];
const APPROVED_FIELDS = [['approved'], ['isApproved'], ['meta', 'approved'], ['qMeta', 'approved'], ['qMetaDef', 'approved']];

function valueAt(record, fields) {
  for (const parts of fields) {
    let value = record;
    for (const part of parts) value = value?.[part];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function objectList(payload) {
  if (Array.isArray(payload)) return payload;
  for (const field of OBJECT_LIST_FIELDS) if (Array.isArray(payload?.[field])) return payload[field];
  if (Array.isArray(payload?.data)) return payload.data;
  throw new Error('The qlik-cli object listing has no supported object list.');
}

// qlik-cli has used these JSON names across versions:
// type/objectType/qType/qInfo.qType/qMeta.type/qMetaDef.type;
// id/objectId/qId/qInfo.qId/qMetaDef.qId;
// published/isPublished/meta.published/qMeta.published/qMetaDef.published;
// approved/isApproved/meta.approved/qMeta.approved/qMetaDef.approved.
// Keep version adaptation here and update this list with a fixture when a new shape appears.
export function adaptSheetListing(payload) {
  return objectList(payload).flatMap((object) => {
    const type = valueAt(object, OBJECT_TYPE_FIELDS);
    if (typeof type !== 'string') throw new Error('The qlik-cli object listing has an unsupported object type field.');
    if (type.toLowerCase() !== 'sheet') return [];
    const id = valueAt(object, OBJECT_ID_FIELDS);
    const published = valueAt(object, PUBLISHED_FIELDS);
    const approved = valueAt(object, APPROVED_FIELDS);
    if (typeof id !== 'string' || !id || typeof published !== 'boolean' || typeof approved !== 'boolean') {
      throw new Error('The qlik-cli sheet listing has unsupported id, published, or approved fields.');
    }
    return [{ id, published, approved }];
  });
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

// Return counters only. Do not include a matched value, object ID, app ID, or output path.
export function scanExportContent(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const tooLarge = bytes.length > MAX_SCAN_BYTES;
  if (tooLarge) return { bytes: bytes.length, tooLarge: 1, privateKeyBlocks: 0, tokenLikeStrings: 0, privatePaths: 0, urlHosts: 0, allowedInlinePaths: 0 };
  const text = bytes.toString('latin1');
  const allowedInlinePaths = countMatches(text, ENGINE_INLINE_PATH);
  const withoutAllowedInlinePaths = text.replace(ENGINE_INLINE_PATH, '');
  const tokenPattern = new RegExp(['gh', '[pousr]', '[_-][A-Za-z0-9_-]{20,}', '|github', '_pat_[A-Za-z0-9_]{20,}'].join(''), 'gi');
  return {
    bytes: bytes.length,
    tooLarge: 0,
    privateKeyBlocks: countMatches(text, /-----BEGIN [A-Z ]*PRIVATE KEY-----/g),
    tokenLikeStrings: countMatches(text, tokenPattern),
    privatePaths: countMatches(withoutAllowedInlinePaths, /\/(?:Users|home)\/[A-Za-z0-9._-]+\//g),
    urlHosts: countMatches(text, /https?:\/\/[A-Za-z0-9.-]+/gi),
    allowedInlinePaths,
  };
}

function runQlik(executable, args, { cwd }) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return { status: result.status ?? 1, error: result.error ?? null, stdout: result.stdout ?? '' };
}

async function checkedRun(run, executable, args, cwd) {
  let result;
  try { result = await run(executable, args, { cwd }); }
  catch { throw new Error('A qlik-cli command failed. Check its configured session and retry.'); }
  if (!result || result.error || result.status !== 0) throw new Error('A qlik-cli command failed. Check its configured session and retry.');
  return result.stdout ?? '';
}

async function listSheets(run, executable, appId, cwd) {
  const stdout = await checkedRun(run, executable, ['app', 'object', 'ls', '--app', appId, '--json'], cwd);
  let payload;
  try { payload = JSON.parse(stdout); } catch { throw new Error('The qlik-cli object listing is not valid JSON.'); }
  return adaptSheetListing(payload);
}

function scanIsClean(scan) {
  return scan.tooLarge === 0 && scan.privateKeyBlocks === 0 && scan.tokenLikeStrings === 0 && scan.privatePaths === 0;
}

export async function prepareQlikDemoApp({ appId, outputName, executable = 'qlik', noData = false, cwd = process.cwd(), run = runQlik } = {}) {
  if (typeof appId !== 'string' || !appId.trim() || typeof outputName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(outputName) || outputName === '.' || outputName === '..') {
    throw new Error('A valid app ID and simple output name are required.');
  }
  if (typeof executable !== 'string' || !executable.trim() || typeof run !== 'function') throw new Error('A qlik-cli executable and runner are required.');
  const outputPath = path.join('out', `${outputName}.qvf`);
  const absoluteOutput = path.resolve(cwd, outputPath);
  if (!absoluteOutput.startsWith(`${path.resolve(cwd)}${path.sep}`)) throw new Error('The output path is not inside the current project.');
  if (fs.existsSync(absoluteOutput)) throw new Error('The demo app output file already exists. Move it before you retry.');

  const before = await listSheets(run, executable, appId, cwd);
  for (const sheet of before) {
    if (sheet.published && sheet.approved) continue;
    await checkedRun(run, executable, ['app', 'object', 'publish', sheet.id, '--app', appId], cwd);
  }
  const after = await listSheets(run, executable, appId, cwd);
  const beforeIds = new Set(before.map(({ id }) => id));
  if (after.length !== before.length || after.some(({ id }) => !beforeIds.has(id))) {
    throw new Error('The Qlik sheet count changed while the helper published sheets.');
  }
  if (after.some((sheet) => !sheet.published || !sheet.approved)) {
    throw new Error('A Qlik sheet is not both published and approved.');
  }

  fs.mkdirSync(path.dirname(absoluteOutput), { recursive: true });
  const exportArgs = ['app', 'export', appId, '--output-file', outputPath];
  if (noData) exportArgs.push('--NoData');
  await checkedRun(run, executable, exportArgs, cwd);
  if (!fs.existsSync(absoluteOutput) || !fs.statSync(absoluteOutput).isFile()) {
    throw new Error('qlik-cli did not create the demo app file.');
  }
  const scan = scanExportContent(fs.readFileSync(absoluteOutput));
  if (!scanIsClean(scan)) {
    fs.rmSync(absoluteOutput, { force: true });
    throw new Error('The demo app content scan found a problem or the file exceeded the scan limit.');
  }
  return { sheetCount: after.length, scan };
}

async function main(args) {
  const [appId, outputName, ...options] = args;
  let executable = 'qlik';
  let noData = false;
  for (let index = 0; index < options.length; index += 1) {
    if (options[index] === '--qlik' && options[index + 1]) { executable = options[++index]; continue; }
    if (options[index] === '--NoData') { noData = true; continue; }
    throw new Error('Unknown qlik-demo-app option.');
  }
  if (!appId || !outputName) throw new Error('Usage: node kit/skills/herdr-orchestrator/reference/qlik-demo-app.mjs APPID OUTPUT-NAME [--qlik EXECUTABLE] [--NoData]');
  process.stdout.write(`${JSON.stringify(await prepareQlikDemoApp({ appId, outputName, executable, noData }))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write('qlik-demo-app: operation failed; no input values were printed.\n');
    process.exitCode = 1;
  });
}
