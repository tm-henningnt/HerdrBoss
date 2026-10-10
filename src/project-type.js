import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_PATH = fileURLToPath(new URL('../kit/project-types/manifest.schema.json', import.meta.url));
const MANIFEST_NAME = 'manifest.json';
const SCHEMA = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));

function jsonTypeMatches(value, expected) {
  const types = Array.isArray(expected) ? expected : [expected];
  return types.some((type) => {
    if (type === 'null') return value === null;
    if (type === 'array') return Array.isArray(value);
    if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
    if (type === 'integer') return Number.isInteger(value);
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    return typeof value === type;
  });
}

function equalJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function checkSchema(value, schema, field, issues) {
  if (schema.type && !jsonTypeMatches(value, schema.type)) {
    issues.push(`${field} has the wrong type.`);
    return;
  }
  if (Object.hasOwn(schema, 'const') && !equalJson(value, schema.const)) issues.push(`${field} has an unsupported value.`);
  if (schema.enum && !schema.enum.some((item) => equalJson(item, value))) issues.push(`${field} has an unsupported value.`);
  if (schema.type === 'string' || (Array.isArray(schema.type) && schema.type.includes('string') && typeof value === 'string')) {
    if (schema.minLength !== undefined && value.length < schema.minLength) issues.push(`${field} must not be empty.`);
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) issues.push(`${field} has an invalid format.`);
  }
  if (schema.type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) issues.push(`${field} must have at least ${schema.minItems} item(s).`);
    if (schema.uniqueItems) {
      const seen = new Set();
      for (const item of value) {
        const key = JSON.stringify(item);
        if (seen.has(key)) { issues.push(`${field} has duplicate items.`); break; }
        seen.add(key);
      }
    }
    if (schema.items) value.forEach((item, index) => checkSchema(item, schema.items, `${field}[${index}]`, issues));
  }
  if (schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object') && value !== null && typeof value === 'object' && !Array.isArray(value))) {
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) issues.push(`${field}.${required} is required.`);
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = schema.properties?.[key];
      if (childSchema) checkSchema(child, childSchema, `${field}.${key}`, issues);
      else if (schema.additionalProperties === false) issues.push(`${field} has unknown field "${key}".`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        checkSchema(child, schema.additionalProperties, `${field}.${key}`, issues);
      }
    }
  }
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || /[\u0000-\u001f]/.test(value)) return false;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.split('/');
  return segments.every((part) => part !== '' && part !== '.' && part !== '..') && path.posix.normalize(value) === value;
}

function referencedFiles(manifest) {
  const refs = [];
  for (const [index, value] of (manifest.templates ?? []).entries()) refs.push([`manifest.templates[${index}]`, value]);
  for (const [index, section] of (manifest.agentsSections ?? []).entries()) refs.push([`manifest.agentsSections[${index}].file`, section?.file]);
  for (const [index, check] of (manifest.checks ?? []).entries()) {
    if (check?.script) refs.push([`manifest.checks[${index}].script`, check.script]);
    for (const [fileIndex, file] of (check?.files ?? []).entries()) refs.push([`manifest.checks[${index}].files[${fileIndex}]`, file]);
  }
  for (const [index, file] of (manifest.releaseFlow?.assets ?? []).entries()) refs.push([`manifest.releaseFlow.assets[${index}]`, file]);
  if (manifest.releaseFlow?.checklist) refs.push(['manifest.releaseFlow.checklist', manifest.releaseFlow.checklist]);
  return refs;
}

function checkPaths(manifest, root, issues) {
  const references = referencedFiles(manifest);
  for (const [field, value] of references) {
    if (!safeRelativePath(value)) {
      issues.push(`${field} uses an unsafe path.`);
      continue;
    }
    const candidate = path.resolve(root, ...value.split('/'));
    const relative = path.relative(root, candidate);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      issues.push(`${field} uses an unsafe path.`);
      continue;
    }
    let realFile;
    try { realFile = fs.realpathSync(candidate); }
    catch { issues.push(`${field} references a missing named file.`); continue; }
    const realRelative = path.relative(root, realFile);
    if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
      issues.push(`${field} resolves outside the type folder.`);
      continue;
    }
    try {
      if (!fs.statSync(realFile).isFile()) issues.push(`${field} does not name a file.`);
    } catch { issues.push(`${field} references a missing named file.`); }
  }
  for (const [index, input] of (manifest.requiredInputs ?? []).entries()) {
    if (!safeRelativePath(input?.destination)) issues.push(`manifest.requiredInputs[${index}].destination uses an unsafe path.`);
  }
}

function checkUniqueIds(manifest, issues) {
  for (const field of ['setupSteps', 'agentsSections', 'gates', 'settings', 'checks', 'requiredInputs']) {
    const seen = new Set();
    for (const item of manifest[field] ?? []) {
      if (typeof item?.id !== 'string') continue;
      if (seen.has(item.id)) issues.push(`manifest.${field} has a duplicate id.`);
      seen.add(item.id);
    }
  }
  const licenseModes = manifest.licenseMode;
  if (licenseModes && Array.isArray(licenseModes.values) && typeof licenseModes.default === 'string'
      && !licenseModes.values.includes(licenseModes.default)) {
    issues.push('manifest.licenseMode.default must be declared in manifest.licenseMode.values.');
  }
  for (const setting of manifest.settings ?? []) {
    if (!setting || typeof setting !== 'object') continue;
    const value = setting.default;
    const typeMatches = setting.type === 'string' ? typeof value === 'string'
      : setting.type === 'boolean' ? typeof value === 'boolean'
        : setting.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
          : setting.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
            : setting.type === 'array' ? Array.isArray(value)
              : false;
    if (!typeMatches) issues.push(`manifest.settings has a default with the wrong type for ${setting.name}.`);
  }
}

function throwIfInvalid(issues) {
  if (issues.length) throw new ProjectTypeValidationError(issues);
}

export class ProjectTypeValidationError extends Error {
  constructor(issues) {
    super(`Invalid project type: ${issues.join(' ')}`);
    this.name = 'ProjectTypeValidationError';
    this.issues = issues;
  }
}

export function validateProjectTypeFolder(folder) {
  let root;
  try { root = fs.realpathSync(path.resolve(folder)); }
  catch { throw new ProjectTypeValidationError(['the type folder does not exist.']); }
  let manifestPath;
  try { manifestPath = fs.realpathSync(path.join(root, MANIFEST_NAME)); }
  catch { throw new ProjectTypeValidationError(['manifest.json is missing.']); }
  const manifestRelative = path.relative(root, manifestPath);
  if (!manifestRelative || manifestRelative === '..' || manifestRelative.startsWith(`..${path.sep}`) || path.isAbsolute(manifestRelative)) {
    throw new ProjectTypeValidationError(['manifest.json resolves outside the type folder.']);
  }
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch { throw new ProjectTypeValidationError(['manifest.json must contain valid JSON.']); }
  const issues = [];
  checkSchema(manifest, SCHEMA, 'manifest', issues);
  if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
    checkPaths(manifest, root, issues);
    checkUniqueIds(manifest, issues);
  }
  throwIfInvalid(issues);
  return { folder: root, manifest };
}

export function validateProjectTypeCatalog(folder) {
  let root;
  try { root = fs.realpathSync(path.resolve(folder)); }
  catch { throw new ProjectTypeValidationError(['the type catalog folder does not exist.']); }
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { throw new ProjectTypeValidationError(['the type catalog folder cannot be read.']); }
  const typeFolders = entries.filter((entry) => entry.isDirectory());
  const issues = entries.some((entry) => entry.isSymbolicLink()) ? ['the type catalog cannot contain symbolic links.'] : [];
  if (!typeFolders.length) issues.push('the type catalog has no type folders.');
  const manifests = [];
  for (const entry of typeFolders) {
    try { manifests.push(validateProjectTypeFolder(path.join(root, entry.name)).manifest); }
    catch (error) {
      if (error instanceof ProjectTypeValidationError) issues.push(...error.issues.map((issue) => `${entry.name}: ${issue}`));
      else issues.push(`${entry.name}: the type could not be validated.`);
    }
  }
  const ids = new Set();
  for (const manifest of manifests) {
    if (ids.has(manifest.id)) issues.push('the catalog has a duplicate type ID.');
    ids.add(manifest.id);
  }
  const defaults = manifests.filter(({ default: isDefault }) => isDefault);
  if (defaults.length !== 1) issues.push('the type catalog must have exactly one default type.');
  throwIfInvalid(issues);
  return manifests;
}

export function validateProjectLicenseMode(manifest, project) {
  const values = manifest?.licenseMode?.values;
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    throw new ProjectTypeValidationError(['the project must have a licenseMode field.']);
  }
  const licenseMode = project && Object.hasOwn(project, 'licenseMode')
    ? project.licenseMode
    : manifest?.licenseMode?.default;
  if (!Array.isArray(values) || typeof licenseMode !== 'string' || !values.includes(licenseMode)) {
    throw new ProjectTypeValidationError(['the project licenseMode must be declared by the type.']);
  }
  return licenseMode;
}
