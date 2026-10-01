import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const checker = readFileSync(join(root, 'test/phone-check.mjs'), 'utf8');

test('phone checker includes the Reviews page and the open Watch panel', () => {
  const pages = /const pages = \[([\s\S]*?)\];/.exec(checker)?.[1];
  assert.ok(pages, 'phone checker page list is missing');
  assert.match(pages, /'\/reviews'/);
  assert.match(pages, /'\/agents#watch'/);
});
