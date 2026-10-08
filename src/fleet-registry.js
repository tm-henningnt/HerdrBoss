import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validate } from './fleet-schema.js';

const schemaFile = fileURLToPath(new URL('../docs/contracts/schema/factory-registry.v1.schema.json', import.meta.url));
const registrySchema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
const factoryItemSchema = registrySchema.properties.factories.items;
const factorySchemas = new Map(factoryItemSchema.oneOf.map((schema) => [schema.properties.kind.const, schema]));
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeName = (row) => typeof row?.name === 'string' && row.name.length <= 64 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(row.name) ? row.name : null;
export const factoryRowLabel = (row, index) => safeName(row) || `#${index + 1}`;

function registryInvalid() {
  return new Error('registry-invalid');
}

function safeFieldPath(location, schema) {
  const path = location.replace(/^\$\.?/, '');
  if (!path) return '';
  let current = schema;
  const fields = [];
  for (const part of path.split('.')) {
    if (current?.properties && Object.hasOwn(current.properties, part)) {
      fields.push(part);
      current = current.properties[part];
    } else {
      fields.push('<unknown field>');
      current = null;
    }
  }
  return fields.join('.');
}

function pathAndReason(issue, schema) {
  const separator = issue.indexOf(': ');
  const location = separator < 0 ? '$' : issue.slice(0, separator);
  const problem = separator < 0 ? issue : issue.slice(separator + 2);
  let field = safeFieldPath(location, schema);
  let reason;
  const required = /^required (.+)$/.exec(problem);
  if (required) {
    field = safeFieldPath(`${location === '$' ? '$.' : `${location}.`}${required[1]}`, schema);
    reason = 'is required';
  } else if (/^additionalProperties /.test(problem)) {
    field = [field, '<unknown field>'].filter(Boolean).join('.');
    reason = 'is not allowed';
  } else if (problem === 'pattern' && field === 'image.builtAt') {
    reason = 'must be YYYY-MM-DDTHH:MM:SSZ';
  } else if (problem === 'pattern' && field === 'image.pinsHash') {
    reason = 'must be a 64-character lowercase hexadecimal digest';
  } else if (problem === 'pattern' && field === 'kitRevision') {
    reason = 'must be a 12- to 64-character lowercase hexadecimal revision';
  } else if (problem === 'pattern' && ['name', 'factoryId', 'hostId'].includes(field)) {
    reason = 'must use lower case letters, digits, and hyphens';
  } else if (problem === 'pattern' && field === 'version') {
    reason = 'must be a version number';
  } else if (problem === 'pattern' && field === 'dashboardUrl') {
    reason = 'must be a valid HTTP or HTTPS URL';
  } else if (problem === 'type') {
    reason = 'has the wrong type';
  } else if (problem === 'enum') {
    reason = 'must use an allowed value';
  } else if (problem === 'const') {
    reason = 'does not match the required value';
  } else if (problem === 'oneOf') {
    field ||= 'row';
    reason = 'must be a native or container factory record';
  } else if (problem === 'minLength') {
    reason = 'must not be empty';
  } else if (problem === 'maxLength') {
    reason = 'is too long';
  } else if (problem.startsWith('minimum')) {
    reason = 'is below the allowed minimum';
  } else if (problem.startsWith('maximum')) {
    reason = 'is above the allowed maximum';
  } else {
    reason = 'does not meet the registry schema';
  }
  return { field: field || 'row', reason };
}

function rowDiagnostics(row, index) {
  const label = factoryRowLabel(row, index);
  if (!object(row)) return [`registry row ${label}: row must be an object`];
  const schema = factorySchemas.get(row.kind);
  if (!schema) return [`registry row ${label}: kind must be native or container`];
  const issues = validate(row, schema, { schemaFile });
  const byField = new Map();
  for (const issue of issues) {
    const { field, reason } = pathAndReason(issue, schema);
    const normalizedReason = field === 'image.builtAt' ? 'must be YYYY-MM-DDTHH:MM:SSZ' : reason;
    if (!byField.has(field) || field === 'image.builtAt') byField.set(field, normalizedReason);
  }
  return [...byField].map(([field, reason]) => `registry row ${label}: ${field} ${reason}`);
}

export function inspectFactoryRows(rows) {
  if (!Array.isArray(rows)) throw registryInvalid();
  const names = new Set();
  for (const row of rows) {
    const name = typeof row?.name === 'string' ? row.name : null;
    if (name !== null && names.has(name)) throw registryInvalid();
    if (name !== null) names.add(name);
  }
  const factories = [];
  const diagnostics = [];
  const rejectedRows = [];
  const rejectedRowLabels = [];
  rows.forEach((row, index) => {
    const issues = rowDiagnostics(row, index);
    if (issues.length) { diagnostics.push(...issues); rejectedRows.push(row); rejectedRowLabels.push(factoryRowLabel(row, index)); }
    else factories.push(row);
  });
  return { factories, diagnostics, rejectedRows, rejectedRowLabels };
}

export function readFactoryRegistry(file) {
  let body;
  try {
    body = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { schema: 1, contractVersion: '1.0.0', minimumFactoryVersion: '0.1.0', hosts: [], factories: [], diagnostics: [] };
    throw registryInvalid();
  }
  if (!object(body) || body.schema !== 1 || body.contractVersion !== '1.0.0' || !Array.isArray(body.factories)) throw registryInvalid();
  const { factories, diagnostics } = inspectFactoryRows(body.factories);
  return { ...body, factories, diagnostics };
}
