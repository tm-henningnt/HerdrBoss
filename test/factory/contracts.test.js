import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const schemaDir = fileURLToPath(new URL('../../docs/contracts/schema/', import.meta.url));
const exampleDir = fileURLToPath(new URL('../../docs/contracts/examples/', import.meta.url));
const contractDoc = new URL('../../docs/contracts/factories.md', import.meta.url);
const contracts = [
  'fleet-summary', 'head-office-role', 'succession-list', 'fleet-join',
  'fleet-enrolment', 'viewer-routes', 'project-transfer', 'factory-registry',
  'fleet-guidance', 'factory-health',
];
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

test('every contract has valid and invalid examples', async t => {
  const { validateFile } = await import('./schema-check.js');
  const files = readdirSync(exampleDir).filter(file => file.endsWith('.json'));
  const seen = new Set();
  for (const contract of contracts) {
    for (const kind of ['valid', 'invalid']) {
      const examples = files.filter(file => file.startsWith(`${contract}.${kind}.`));
      assert.ok(examples.length > 0, `${contract} needs a ${kind} example`);
      for (const file of examples) {
        seen.add(file);
        await t.test(file, () => {
          const errors = validateFile(readJson(`${exampleDir}/${file}`), `${schemaDir}/${contract}.v1.schema.json`);
          if (kind === 'valid') {
            assert.deepEqual(errors, [], errors.join('\n'));
            assert.equal(readJson(`${exampleDir}/${file}`).contractVersion, '1.0.0');
          }
          else assert.ok(errors.length > 0, `${file} must fail`);
        });
      }
    }
  }
  assert.deepEqual([...seen].sort(), files.sort(), 'an example has no contract test');
});

test('every schema has its identity, version, subset check, and document entry', async () => {
  const { assertSchema } = await import('./schema-check.js');
  const files = readdirSync(schemaDir).filter(file => file.endsWith('.json')).sort();
  assert.deepEqual(files, [...contracts, 'common'].map(name => `${name}.v1.schema.json`).sort());
  const doc = readFileSync(contractDoc, 'utf8');
  const ids = new Set();
  for (const file of files) {
    const schema = readJson(`${schemaDir}/${file}`);
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.match(schema.$id, /^https:\/\/contracts\.example\//);
    assert.ok(!ids.has(schema.$id), `duplicate $id: ${schema.$id}`);
    ids.add(schema.$id);
    assert.equal(schema.version, '1.0.0');
    assert.match(schema.description, /Version 1\.0\.0/);
    assert.ok(doc.includes(file), `document must name ${file}`);
    assertSchema(schema, `${schemaDir}/${file}`);
    const checkReferences = value => {
      if (Array.isArray(value)) return value.forEach(checkReferences);
      if (!value || typeof value !== 'object') return;
      if (value.$ref && !value.$ref.startsWith('#')) {
        const [target] = value.$ref.split('#');
        assert.equal(new URL(target, schema.$id).href, readJson(`${schemaDir}/${target}`).$id, `${file}: local reference must match the target $id`);
      }
      Object.values(value).forEach(checkReferences);
    };
    checkReferences(schema);
  }
  assert.match(doc, /^## Decisions$/m);
});

test('the validator enforces each supported value keyword', async () => {
  const { validate } = await import('./schema-check.js');
  const cases = [
    [{ type: 'object' }, {}, [null, []]],
    [{ type: 'array' }, [], [{}]],
    [{ type: 'boolean' }, false, [0]],
    [{ type: 'null' }, null, ['null']],
    [{ type: ['number', 'null'], minimum: 0, maximum: 100 }, null, [-1, 101, Infinity, NaN]],
    [{ type: 'integer', minimum: 1, maximum: 2 }, 2, [0, 3, 1.5]],
    [{ type: 'string', minLength: 1, maxLength: 2, pattern: '^[ab]+$' }, 'ab', ['', 'aaa', 'c']],
    [{ type: 'string', minLength: 1, maxLength: 1 }, '😀', ['', '😀😀']],
    [{ enum: [{ a: 1, b: 2 }] }, { b: 2, a: 1 }, [{ a: 1 }]],
    [{ const: { a: [1, 2] } }, { a: [1, 2] }, [{ a: [2, 1] }]],
    [{ const: 0 }, -0, [1]],
    [{ type: 'array', minItems: 1, items: { type: 'integer' } }, [1], [[], ['1']]],
    [{ type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false }, { id: 1 }, [{}, { id: '1' }, { id: 1, extra: true }]],
    [{ type: 'object', additionalProperties: { type: 'boolean' } }, { enabled: true }, [{ enabled: 1 }]],
    [{ oneOf: [{ type: 'integer' }, { const: 'none' }] }, 'none', [null]],
    [{ oneOf: [{ type: 'number' }, { type: 'integer' }] }, 1.5, [1, '1']],
  ];
  for (const [schema, valid, invalid] of cases) {
    assert.deepEqual(validate(valid, schema), [], JSON.stringify(schema));
    for (const value of invalid) assert.ok(validate(value, schema).length > 0, JSON.stringify(schema));
  }
  assert.deepEqual(validate({}, { required: ['missing'] }).length > 0, true);
  assert.deepEqual(validate('text', { minimum: 1 }), []);
  assert.ok(validate(Object.create({ id: 1 }), { required: ['id'] }).length > 0);
});

test('local references resolve and keep sibling constraints', async () => {
  const { validate } = await import('./schema-check.js');
  const options = { schemaFile: `${schemaDir}/fleet-summary.v1.schema.json` };
  const schema = { $ref: 'common.v1.schema.json#/$defs/slug', maxLength: 9 };
  assert.deepEqual(validate('factory-a', schema, options), []);
  for (const value of ['factory-aaa', 'factory-a\n', '../factory-a', 1]) {
    assert.ok(validate(value, schema, options).length > 0);
  }
  assert.deepEqual(validate('ok', { $defs: { 'a/b~c': { const: 'ok' } }, $ref: '#/$defs/a~1b~0c' }), []);
  assert.throws(() => validate({}, { $ref: 'https://factory-a.example/schema.json' }, options), /local/);
  assert.throws(() => validate({}, { $ref: '../factories.md' }, options), /local/);
  assert.throws(() => validate({}, { $ref: '#/$defs/missing' }), /reference/);
  assert.throws(() => validate({}, { $ref: '#' }), /cyclic/);
  assert.throws(() => validate({}, { type: 'object', $defs: { loop: { $ref: '#/$defs/loop' } } }), /cyclic/);
});

test('unsupported or malformed schemas cannot produce a false pass', async () => {
  const { validate } = await import('./schema-check.js');
  for (const schema of [
    { format: 'uri' }, { type: 'unknown' }, { required: 'id' },
    { oneOf: [] }, { pattern: '[' }, { minItems: -1 }, { additionalProperties: 3 },
  ]) assert.throws(() => validate({}, schema));
});

test('shared definitions enforce port bounds, host names, and the transferred state', async () => {
  const { validate } = await import('./schema-check.js');
  const options = { schemaFile: `${schemaDir}/fleet-summary.v1.schema.json` };
  const def = name => ({ $ref: `common.v1.schema.json#/$defs/${name}` });
  const accepts = (name, values) => values.forEach(value => assert.deepEqual(validate(value, def(name), options), [], `${name}: ${value}`));
  const refuses = (name, values) => values.forEach(value => assert.ok(validate(value, def(name), options).length > 0, `${name}: ${value}`));
  accepts('dashboardUrl', ['http://factory-a.example:1', 'https://factory-a.example:4477/', 'http://factory-a.example:65535', 'http://localhost:9999']);
  refuses('dashboardUrl', ['http://factory-a.example:0', 'http://factory-a.example:00080', 'http://factory-a.example:65536', 'http://factory-a.example:99999', 'http://factory-a.example:100000', 'http://factory-a.example:']);
  accepts('hostname', ['host-b.example', 'factory-a.localhost']);
  refuses('hostname', ['host-b', 'host-b.', '.example', 'user@host-b.example']);
  accepts('hostAddress', ['host-b', 'host-b.example', 'a1']);
  refuses('hostAddress', ['', 'host-b.', '-host', 'host_b', 'user@host-b', 'host-b:22', 'host-b\n']);
  accepts('state', ['transferred', 'ready', 'unknown']);
  refuses('state', ['moved']);
});
