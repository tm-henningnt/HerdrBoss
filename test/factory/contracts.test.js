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
  'fleet-guidance', 'factory-health', 'factory-backup',
];
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

test('factory registry keeps inline SSH records and accepts private connection references', async () => {
  const { validateFile } = await import('./schema-check.js');
  const file = `${schemaDir}/factory-registry.v1.schema.json`;
  const oldForm = readJson(`${exampleDir}/factory-registry.valid.local-and-ssh.json`);
  const referenceForm = readJson(`${exampleDir}/factory-registry.valid.connection-ref.json`);
  assert.deepEqual(validateFile(oldForm, file), []);
  assert.deepEqual(validateFile(referenceForm, file), []);
  referenceForm.hosts[0].keyFile = '/example/id';
  assert.ok(validateFile(referenceForm, file).length > 0);
});

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
            assert.ok(['1.0.0', '1.1.0'].includes(readJson(`${exampleDir}/${file}`).contractVersion), `${file} must use a supported 1.x version`);
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
    const expectedVersion = file === 'fleet-summary.v1.schema.json' ? '1.1.0' : '1.0.0';
    assert.equal(schema.version, expectedVersion);
    assert.match(schema.description, new RegExp(`Version ${expectedVersion.replaceAll('.', '\\.')}`));
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

test('fleet summaries accept open harness identifiers and reject invalid identifiers', async () => {
  const { validateFile } = await import('./schema-check.js');
  const schemaFile = `${schemaDir}/fleet-summary.v1.schema.json`;
  const summary = readJson(`${exampleDir}/fleet-summary.valid.personal.json`);
  for (const harness of ['pi', 'my-harness']) {
    const candidate = structuredClone(summary);
    candidate.quotas[0].harness = harness;
    candidate.spend[0].harness = harness;
    assert.deepEqual(validateFile(candidate, schemaFile), [], `accepts ${harness}`);
  }
  for (const harness of ['Claude', '1x', '', 'a'.repeat(33)]) {
    const candidate = structuredClone(summary);
    candidate.quotas[0].harness = harness;
    candidate.spend[0].harness = harness;
    assert.ok(validateFile(candidate, schemaFile).length > 0, `rejects ${JSON.stringify(harness)}`);
  }
});

const fleetSummarySchemaFile = `${schemaDir}/fleet-summary.v1.schema.json`;

test('the fleet summary accepts the complete, minimal, and null add-only examples', async () => {
  const { validateFile } = await import('./schema-check.js');
  const complete = readJson(`${exampleDir}/fleet-summary.valid.complete.json`);
  const minimal = readJson(`${exampleDir}/fleet-summary.valid.minimal.json`);
  const nulls = readJson(`${exampleDir}/fleet-summary.valid.nulls.json`);
  assert.deepEqual(validateFile(complete, fleetSummarySchemaFile), []);
  assert.deepEqual(validateFile(minimal, fleetSummarySchemaFile), []);
  assert.deepEqual(validateFile(nulls, fleetSummarySchemaFile), []);
  // The complete example sets every new optional field.
  assert.equal(complete.kind, 'native');
  assert.deepEqual(complete.workers, { running: 5, max: 12 });
  assert.equal(complete.harnesses[0].login, 'expired');
  assert.deepEqual(complete.boss, { running: true, harness: 'claude' });
  assert.equal(complete.pending[0].step, 'login-claude');
  assert.equal(complete.backup.lastAt, '2026-10-02T06:00:00Z');
  assert.equal(complete.machine.diskFreePercent, 34);
  assert.equal(complete.machine.diskFreeMb, 51200);
  assert.equal(complete.machine.utcOffsetMinutes, 120);
  assert.equal(complete.ownerItems.rows[0].projectSlug, 'sample-project');
  // The minimal example is an older summary without any new field.
  for (const field of ['kind', 'workers', 'harnesses', 'boss', 'pending', 'backup']) {
    assert.equal(minimal[field], undefined, `minimal omits ${field}`);
  }
  for (const field of ['diskFreePercent', 'diskFreeMb', 'utcOffsetMinutes']) {
    assert.equal(minimal.machine[field], undefined, `minimal omits machine.${field}`);
  }
  // The null example keeps an unavailable reading as null, never as zero.
  assert.equal(nulls.kind, null);
  assert.deepEqual(nulls.workers, { running: null, max: null });
  assert.equal(nulls.harnesses[0].checkedAt, null);
  assert.deepEqual(nulls.boss, { running: null, harness: null });
  assert.equal(nulls.backup.lastAt, null);
  assert.equal(nulls.machine.diskFreePercent, null);
  assert.equal(nulls.machine.diskFreeMb, null);
  assert.equal(nulls.machine.utcOffsetMinutes, null);
  // The title-sharing condition still holds when an Owner item also names a project.
  const sharingOff = structuredClone(complete);
  sharingOff.shareItemTitles = false;
  assert.ok(validateFile(sharingOff, fleetSummarySchemaFile).length > 0, 'refuses a title when sharing is off');
  const sharingOffNoTitles = structuredClone(complete);
  sharingOffNoTitles.shareItemTitles = false;
  sharingOffNoTitles.ownerItems.rows = sharingOffNoTitles.ownerItems.rows.map(({ title, ...row }) => row);
  assert.deepEqual(validateFile(sharingOffNoTitles, fleetSummarySchemaFile), [], 'accepts a projectSlug without a title when sharing is off');
});

test('the fleet summary refuses an unknown field in each add-only object', async () => {
  const { validateFile } = await import('./schema-check.js');
  const complete = readJson(`${exampleDir}/fleet-summary.valid.complete.json`);
  const targets = [
    ['top level', body => { body.extra = 1; }],
    ['workers', body => { body.workers.extra = 1; }],
    ['harnesses', body => { body.harnesses[0].extra = 1; }],
    ['boss', body => { body.boss.extra = 1; }],
    ['pending', body => { body.pending[0].extra = 1; }],
    ['backup', body => { body.backup.extra = 1; }],
    ['machine', body => { body.machine.extra = 1; }],
    ['ownerItems.rows', body => { body.ownerItems.rows[0].extra = 1; }],
  ];
  for (const [name, mutate] of targets) {
    const body = structuredClone(complete);
    mutate(body);
    assert.ok(validateFile(body, fleetSummarySchemaFile).length > 0, `refuses an unknown ${name} field`);
  }
});

test('the fleet summary refuses a wrong type for each add-only field', async () => {
  const { validateFile } = await import('./schema-check.js');
  const complete = readJson(`${exampleDir}/fleet-summary.valid.complete.json`);
  const cases = [
    ['kind', body => { body.kind = 'desktop'; }],
    ['workers.running', body => { body.workers.running = 'five'; }],
    ['workers.max', body => { body.workers.max = 1.5; }],
    ['harnesses[].harness', body => { body.harnesses[0].harness = 'Claude'; }],
    ['harnesses[].login', body => { body.harnesses[0].login = 'maybe'; }],
    ['harnesses[].checkedAt', body => { body.harnesses[0].checkedAt = 'yesterday'; }],
    ['boss.running', body => { body.boss.running = 'yes'; }],
    ['boss.harness', body => { body.boss.harness = 7; }],
    ['pending[].step', body => { body.pending[0].step = 'Login Claude'; }],
    ['pending[].since', body => { body.pending[0].since = 123; }],
    ['backup.lastAt', body => { body.backup.lastAt = 123; }],
    ['machine.diskFreePercent', body => { body.machine.diskFreePercent = 140; }],
    ['machine.diskFreePercent negative', body => { body.machine.diskFreePercent = -1; }],
    ['machine.diskFreeMb', body => { body.machine.diskFreeMb = 'lots'; }],
    ['machine.utcOffsetMinutes', body => { body.machine.utcOffsetMinutes = 'two hours'; }],
    ['ownerItems.rows[].projectSlug', body => { body.ownerItems.rows[0].projectSlug = 'Sample Project'; }],
  ];
  for (const [field, mutate] of cases) {
    const body = structuredClone(complete);
    mutate(body);
    assert.ok(validateFile(body, fleetSummarySchemaFile).length > 0, `refuses ${field}`);
  }
});

test('a fleet summary at the supported version has no drift and an older one reports factory older', async () => {
  const { acceptFleetSummary } = await import('../../src/fleet-contract.js');
  const source = readJson(`${exampleDir}/fleet-summary.valid.complete.json`);
  assert.equal(acceptFleetSummary(source, source.dashboardUrl).drift, null);
  const older = structuredClone(source);
  older.contractVersion = '1.0.0';
  older.quotas = older.quotas.filter((row) => typeof row.accountKey === 'string');
  assert.equal(acceptFleetSummary(older, source.dashboardUrl).drift, 'factory older');
});

test('an accepted newer 1.x fleet summary keeps working and drops an unsupported field', async () => {
  const { acceptFleetSummary, assertFleetSummary } = await import('../../src/fleet-contract.js');
  const source = readJson(`${exampleDir}/fleet-summary.valid.complete.json`);
  const newer = structuredClone(source);
  newer.contractVersion = '1.2.0';
  newer.futureField = 'a later 1.x addition';
  const accepted = acceptFleetSummary(newer, source.dashboardUrl);
  assert.equal(accepted.drift, 'head office older');
  assert.equal(accepted.summary.contractVersion, '1.2.0');
  assert.equal(accepted.summary.futureField, undefined);
  assert.deepEqual(accepted.summary.workers, { running: 5, max: 12 });
  assert.equal(accepted.summary.kind, 'native');
  // The strict producer allow-list still refuses the same unknown field.
  assert.throws(() => assertFleetSummary(newer), /supported contract/);
});

test('the fleet summary quota row takes an optional local estimate and refuses a percent in it', async () => {
  const { validateFile } = await import('./schema-check.js');
  const valid = readJson(`${exampleDir}/fleet-summary.valid.opencode-estimate.json`);
  assert.deepEqual(validateFile(valid, fleetSummarySchemaFile), []);
  assert.equal(valid.quotas[2].usedPercent, null);
  assert.equal(valid.quotas[2].status, 'unknown');
  assert.equal(valid.quotas[0].estimate, undefined);
  assert.ok(validateFile(readJson(`${exampleDir}/fleet-summary.invalid.estimate-percent.json`), fleetSummarySchemaFile).length > 0);
  for (const [field, value] of [['days', 0], ['tokens', -1], ['costUsd', -0.5], ['omittedModels', 1.5], ['tokens', 'many']]) {
    const body = structuredClone(valid);
    body.quotas[2].estimate[field] = value;
    assert.ok(validateFile(body, fleetSummarySchemaFile).length > 0, `refuses ${field} ${value}`);
  }
  const bare = structuredClone(valid);
  delete bare.quotas[2].estimate;
  assert.deepEqual(validateFile(bare, fleetSummarySchemaFile), []);
});
