import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../../src/fleet-schema.js';

const schemaFile = fileURLToPath(new URL('../../docs/contracts/schema/factory-registry.v1.schema.json', import.meta.url));
const schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));

export function assertPollerRegistry(env) {
  assert.ok(env.HERDR_FACTORIES_DIR, 'the factory registry must use a temporary fixture directory');
  const file = path.join(env.HERDR_FACTORIES_DIR, 'fleet.json');
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(validate(registry, schema, { schemaFile }), [], 'the written registry must pass the poller schema');
  return registry;
}
