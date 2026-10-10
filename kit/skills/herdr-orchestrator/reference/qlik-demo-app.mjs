import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MAX_SCAN_BYTES = 20 * 1024 * 1024;
const MAX_SHEETS = 500;
const QLIK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ENGINE_INLINE_PATH = /(?:(?<![A-Za-z0-9._/-])|(?<=8))\/home\/engine\/[0-9a-fA-F-]{36}\.inline(?![A-Za-z0-9._/-])/g;
const OBJECT_LIST_FIELDS = ['objects', 'items', 'appObjects', 'qAppObjects'];
const OBJECT_TYPE_FIELDS = [['type'], ['objectType'], ['qType'], ['qInfo', 'qType'], ['qMeta', 'type'], ['qMetaDef', 'type']];
const OBJECT_ID_FIELDS = [['id'], ['objectId'], ['qId'], ['qInfo', 'qId'], ['qMetaDef', 'qId']];
const PUBLISHED_FIELDS = [['published'], ['isPublished'], ['meta', 'published'], ['qMeta', 'published'], ['qMetaDef', 'published']];
const APPROVED_FIELDS = [['approved'], ['isApproved'], ['meta', 'approved'], ['qMeta', 'approved'], ['qMetaDef', 'approved']];
const FAILURE_MESSAGES = Object.freeze({
  QLIK_COMMAND_FAILED: 'qlik-demo-app: refused: a qlik command failed. No file was exported.',
  INVALID_ID: 'qlik-demo-app: refused: an app or sheet id is invalid. No file was exported.',
  TOO_MANY_SHEETS: 'qlik-demo-app: refused: the app has more than 500 sheets. No file was exported.',
  DUPLICATE_SHEET_IDS: 'qlik-demo-app: refused: the sheet list has duplicate IDs. No file was exported.',
  SHEET_STATE_UNAVAILABLE: 'qlik-demo-app: refused: the listing has no complete published and approved state, and the per-sheet read failed or returned no state. The CLI output changed. No file was exported.',
  SHEET_COUNT_CHANGED: 'qlik-demo-app: refused: the sheet count changed. No file was exported.',
  SHEETS_STILL_PRIVATE: 'qlik-demo-app: refused: sheets remain unpublished or unapproved after publishing. No file was exported.',
  EXPORT_SCAN_REFUSED: 'qlik-demo-app: refused: the export scan found unsafe content. The file was removed.',
});
const GENERIC_FAILURE_MESSAGE = 'qlik-demo-app: operation failed; no input values were printed.';

function refusal(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

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
// Current object listings can contain only qId, qType, and title. Read missing
// state with app object properties and adapt its qMeta.published and qMeta.approved.
// Keep version adaptation here and update this list with a fixture when a new shape appears.
export function adaptSheetListing(payload) {
  return objectList(payload).flatMap((object) => {
    const type = valueAt(object, OBJECT_TYPE_FIELDS);
    if (typeof type !== 'string') throw new Error('The qlik-cli object listing has an unsupported object type field.');
    if (type.toLowerCase() !== 'sheet') return [];
    const id = valueAt(object, OBJECT_ID_FIELDS);
    const published = valueAt(object, PUBLISHED_FIELDS);
    const approved = valueAt(object, APPROVED_FIELDS);
    if (typeof id !== 'string' || !QLIK_ID_PATTERN.test(id)) {
      throw refusal('INVALID_ID', 'An app or sheet id is invalid.');
    }
    return [{ id, published, approved }];
  });
}

export function adaptSheetState(payload) {
  const published = valueAt(payload, PUBLISHED_FIELDS);
  const approved = valueAt(payload, APPROVED_FIELDS);
  if (typeof published !== 'boolean' || typeof approved !== 'boolean') {
    throw refusal('SHEET_STATE_UNAVAILABLE', 'Published and approved sheet state is unavailable.');
  }
  return { published, approved };
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
  catch { throw refusal('QLIK_COMMAND_FAILED', 'A qlik-cli command failed.'); }
  if (!result || result.error || result.status !== 0) throw refusal('QLIK_COMMAND_FAILED', 'A qlik-cli command failed.');
  return result.stdout ?? '';
}

async function listSheets(run, executable, appId, cwd) {
  const stdout = await checkedRun(run, executable, ['app', 'object', 'ls', '--app', appId, '--json'], cwd);
  let payload;
  try { payload = JSON.parse(stdout); } catch { throw new Error('The qlik-cli object listing is not valid JSON.'); }
  const sheets = adaptSheetListing(payload);
  if (sheets.length > MAX_SHEETS) throw refusal('TOO_MANY_SHEETS', 'The app has more than 500 sheets.');
  if (new Set(sheets.map(({ id }) => id)).size !== sheets.length) {
    throw refusal('DUPLICATE_SHEET_IDS', 'The sheet list has duplicate IDs.');
  }
  const resolved = [];
  for (const sheet of sheets) {
    if (typeof sheet.published === 'boolean' && typeof sheet.approved === 'boolean') {
      resolved.push(sheet);
      continue;
    }
    try {
      const properties = await checkedRun(run, executable, ['app', 'object', 'properties', sheet.id, '--app', appId, '--json'], cwd);
      resolved.push({ ...sheet, ...adaptSheetState(JSON.parse(properties)) });
    } catch (error) {
      if (error?.code === 'QLIK_COMMAND_FAILED') throw error;
      throw refusal('SHEET_STATE_UNAVAILABLE', 'Published and approved sheet state is unavailable.');
    }
  }
  return resolved;
}

function scanIsClean(scan) {
  return scan.tooLarge === 0 && scan.privateKeyBlocks === 0 && scan.tokenLikeStrings === 0 && scan.privatePaths === 0;
}

export async function prepareQlikDemoApp({ appId, outputName, executable = 'qlik', noData = false, cwd = process.cwd(), run = runQlik } = {}) {
  if (typeof appId !== 'string' || !QLIK_ID_PATTERN.test(appId)) throw refusal('INVALID_ID', 'An app or sheet id is invalid.');
  if (typeof outputName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(outputName) || outputName === '.' || outputName === '..') {
    throw new Error('A simple output name is required.');
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
    throw refusal('SHEET_COUNT_CHANGED', 'The Qlik sheet count changed while the helper published sheets.');
  }
  if (after.some((sheet) => !sheet.published || !sheet.approved)) {
    throw refusal('SHEETS_STILL_PRIVATE', 'A Qlik sheet is not both published and approved.');
  }

  fs.mkdirSync(path.dirname(absoluteOutput), { recursive: true });
  const exportArgs = ['app', 'export', appId, '--output-file', outputPath];
  if (noData) exportArgs.push('--NoData');
  try {
    await checkedRun(run, executable, exportArgs, cwd);
  } catch (error) {
    if (error?.code === 'QLIK_COMMAND_FAILED') fs.rmSync(absoluteOutput, { force: true });
    throw error;
  }
  if (!fs.existsSync(absoluteOutput) || !fs.statSync(absoluteOutput).isFile()) {
    throw new Error('qlik-cli did not create the demo app file.');
  }
  const scan = scanExportContent(fs.readFileSync(absoluteOutput));
  if (!scanIsClean(scan)) {
    fs.rmSync(absoluteOutput, { force: true });
    throw refusal('EXPORT_SCAN_REFUSED', 'The demo app content scan found a problem or the file exceeded the scan limit.');
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
  main(process.argv.slice(2)).catch((error) => {
    const message = Object.hasOwn(FAILURE_MESSAGES, error?.code)
      ? FAILURE_MESSAGES[error.code]
      : GENERIC_FAILURE_MESSAGE;
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
