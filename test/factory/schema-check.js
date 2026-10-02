// Test-only JSON Schema subset. No network access and no runtime integration.
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const own = (object, key) => Object.hasOwn(object, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const types = {
  object, array: Array.isArray, string: value => typeof value === 'string',
  boolean: value => typeof value === 'boolean', null: value => value === null,
  number: value => typeof value === 'number' && Number.isFinite(value),
  integer: Number.isInteger,
};
const keywords = new Set([
  '$schema', '$id', '$defs', 'title', 'description', 'version', '$ref',
  'type', 'properties', 'required', 'additionalProperties', 'enum', 'const',
  'items', 'minItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'oneOf',
]);

function equal(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => equal(value, right[index]));
  }
  if (object(left) && object(right)) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every(key => own(right, key) && equal(left[key], right[key]));
  }
  return false;
}

function context(schema, schemaFile) {
  const file = schemaFile ? realpathSync(schemaFile) : null;
  return { root: schema, file, directory: file ? dirname(file) : null, files: new Map(file ? [[file, schema]] : []) };
}

function reference(ref, ctx) {
  const [name, fragment = '', ...extra] = ref.split('#');
  if (extra.length || /[:\\?]/.test(name) || isAbsolute(name)) throw new Error('Only local schema references are supported');
  let next = ctx;
  if (name) {
    if (!ctx.file) throw new Error('A local file reference needs schemaFile');
    const candidate = resolve(dirname(ctx.file), name);
    const inside = path => {
      const part = relative(ctx.directory, path);
      return part !== '..' && !part.startsWith('../') && !isAbsolute(part);
    };
    if (!inside(candidate)) throw new Error('Only local schema references are supported');
    const file = realpathSync(candidate);
    if (!inside(file)) throw new Error('Only local schema references are supported');
    if (!ctx.files.has(file)) ctx.files.set(file, JSON.parse(readFileSync(file, 'utf8')));
    next = { ...ctx, file, root: ctx.files.get(file) };
  }
  let schema = next.root;
  if (fragment) {
    if (!fragment.startsWith('/')) throw new Error('A schema reference must use a JSON pointer');
    for (const encoded of fragment.slice(1).split('/')) {
      const key = decodeURIComponent(encoded).replace(/~1/g, '/').replace(/~0/g, '~');
      if (!object(schema) || !own(schema, key)) throw new Error(`Missing schema reference: ${ref}`);
      schema = schema[key];
    }
  }
  return { schema, ctx: next };
}

function inspect(schema, ctx, seen = new Set(), active = new Set()) {
  if (typeof schema === 'boolean') return;
  if (!object(schema)) throw new Error('A schema must be an object or boolean');
  if (active.has(schema)) throw new Error('Unsupported cyclic schema reference');
  if (seen.has(schema)) return;
  seen.add(schema);
  active.add(schema);
  for (const key of Object.keys(schema)) {
    if (!keywords.has(key)) throw new Error(`Unsupported schema keyword: ${key}`);
  }
  if (own(schema, 'type')) {
    const names = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!names.length || names.some(name => typeof name !== 'string' || !own(types, name))) throw new Error('Invalid schema type');
  }
  for (const key of ['minItems', 'minLength', 'maxLength']) {
    if (own(schema, key) && (!Number.isSafeInteger(schema[key]) || schema[key] < 0)) throw new Error(`Invalid ${key}`);
  }
  for (const key of ['minimum', 'maximum']) {
    if (own(schema, key) && !types.number(schema[key])) throw new Error(`Invalid ${key}`);
  }
  if (own(schema, 'required') && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string') || new Set(schema.required).size !== schema.required.length)) throw new Error('Invalid required');
  if (own(schema, 'enum') && (!Array.isArray(schema.enum) || !schema.enum.length)) throw new Error('Invalid enum');
  if (own(schema, 'pattern')) {
    if (typeof schema.pattern !== 'string') throw new Error('Invalid pattern');
    new RegExp(schema.pattern, 'u');
  }
  for (const key of ['$defs', 'properties']) {
    if (!own(schema, key)) continue;
    if (!object(schema[key])) throw new Error(`Invalid ${key}`);
    for (const child of Object.values(schema[key])) inspect(child, ctx, seen, active);
  }
  for (const key of ['items', 'additionalProperties']) {
    if (own(schema, key)) inspect(schema[key], ctx, seen, active);
  }
  if (own(schema, 'oneOf')) {
    if (!Array.isArray(schema.oneOf) || !schema.oneOf.length) throw new Error('Invalid oneOf');
    for (const child of schema.oneOf) inspect(child, ctx, seen, active);
  }
  if (own(schema, '$ref')) {
    if (typeof schema.$ref !== 'string') throw new Error('Invalid reference');
    const target = reference(schema.$ref, ctx);
    inspect(target.schema, target.ctx, seen, active);
  }
  active.delete(schema);
}

function check(value, schema, ctx, path = '$', trail = []) {
  if (schema === true) return [];
  if (schema === false) return [`${path}: false schema`];
  if (trail.some(entry => entry.schema === schema && entry.value === value)) throw new Error('Unsupported cyclic schema reference');
  const nextTrail = [...trail, { schema, value }];
  const errors = [];
  const fail = keyword => errors.push(`${path}: ${keyword}`);
  if (own(schema, '$ref')) {
    const target = reference(schema.$ref, ctx);
    errors.push(...check(value, target.schema, target.ctx, path, nextTrail));
  }
  if (own(schema, 'type')) {
    const names = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!names.some(name => types[name](value))) fail('type');
  }
  if (own(schema, 'enum') && !schema.enum.some(item => equal(item, value))) fail('enum');
  if (own(schema, 'const') && !equal(schema.const, value)) fail('const');
  if (typeof value === 'string') {
    const length = [...value].length;
    if (own(schema, 'minLength') && length < schema.minLength) fail('minLength');
    if (own(schema, 'maxLength') && length > schema.maxLength) fail('maxLength');
    if (own(schema, 'pattern') && !new RegExp(schema.pattern, 'u').test(value)) fail('pattern');
  }
  if (types.number(value)) {
    if (own(schema, 'minimum') && value < schema.minimum) fail('minimum');
    if (own(schema, 'maximum') && value > schema.maximum) fail('maximum');
  }
  if (Array.isArray(value)) {
    if (own(schema, 'minItems') && value.length < schema.minItems) fail('minItems');
    if (own(schema, 'items')) value.forEach((item, i) => errors.push(...check(item, schema.items, ctx, `${path}[${i}]`, nextTrail)));
  }
  if (object(value)) {
    for (const key of schema.required || []) if (!own(value, key)) fail(`required ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (own(schema.properties || {}, key)) errors.push(...check(item, schema.properties[key], ctx, `${path}.${key}`, nextTrail));
      else if (schema.additionalProperties === false) fail(`additionalProperties ${key}`);
      else if (object(schema.additionalProperties)) errors.push(...check(item, schema.additionalProperties, ctx, `${path}.${key}`, nextTrail));
    }
  }
  if (own(schema, 'oneOf')) {
    const matches = schema.oneOf.filter(child => check(value, child, ctx, path, nextTrail).length === 0).length;
    if (matches !== 1) fail('oneOf');
  }
  return errors;
}

export function assertSchema(schema, schemaFile) {
  inspect(schema, context(schema, schemaFile));
}

export function validate(value, schema, { schemaFile } = {}) {
  const ctx = context(schema, schemaFile);
  inspect(schema, ctx);
  return check(value, schema, ctx);
}

export function validateFile(value, schemaFile) {
  return validate(value, JSON.parse(readFileSync(schemaFile, 'utf8')), { schemaFile });
}
