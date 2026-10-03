import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateFile } from './fleet-schema.js';

export const SUMMARY_SCHEMA_FILE = fileURLToPath(new URL('../docs/contracts/schema/fleet-summary.v1.schema.json', import.meta.url));
const common = JSON.parse(fs.readFileSync(new URL('../docs/contracts/schema/common.v1.schema.json', import.meta.url), 'utf8'));
const summarySchema = JSON.parse(fs.readFileSync(SUMMARY_SCHEMA_FILE, 'utf8'));
const resolve = (schema) => schema.$ref ? common.$defs[schema.$ref.split('/').at(-1)] : schema;
function select(value, schema) {
  schema = resolve(schema);
  if (Array.isArray(value) && schema.items) return value.map((item) => select(item, schema.items));
  if (value && typeof value === 'object' && schema.properties) {
    return Object.fromEntries(Object.entries(schema.properties).filter(([key]) => Object.hasOwn(value, key)).map(([key, child]) => [key, select(value[key], child)]));
  }
  return value;
}
export function assertFleetSummary(body) {
  const errors = validateFile(body, SUMMARY_SCHEMA_FILE);
  if (errors.length) throw new Error(`The fleet summary does not match the supported contract: ${errors[0]}.`);
  return body;
}
export function acceptFleetSummary(body, dashboardUrl) {
  if (!body || body.schema !== 1 || typeof body.contractVersion !== 'string' || !/^1\.\d+\.\d+$/.test(body.contractVersion)) throw new Error('The fleet summary version is unsupported.');
  const selection = select(body, summarySchema);
  assertFleetSummary(selection);
  if (new URL(selection.dashboardUrl).origin !== new URL(dashboardUrl).origin) throw new Error('The fleet summary belongs to another dashboard.');
  if (!Number.isFinite(Date.parse(selection.generatedAt))) throw new Error('The fleet summary time is invalid.');
  return { summary: selection, drift: selection.contractVersion === '1.0.0' ? null : 'head office older' };
}
