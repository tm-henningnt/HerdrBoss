import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadPolicy, POLICY_DEFAULTS, validatePolicy } from '../src/control.js';
import { loadModels } from '../src/kit/config.js';

test('To do digest settings default off and load partial saved settings', (t) => {
  assert.deepEqual(POLICY_DEFAULTS.ownerTodo, { digestTime: null, timeZone: 'local', notify: false });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-todo-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'policy.json');
  fs.writeFileSync(file, JSON.stringify({ ownerTodo: { digestTime: '08:00' } }));
  assert.deepEqual(loadPolicy({ file }).ownerTodo, { digestTime: '08:00', timeZone: 'local', notify: false });
});

test('policy refuses invalid digest times, time zones and notification flags', () => {
  const check = (ownerTodo) => validatePolicy({ ...structuredClone(POLICY_DEFAULTS), ownerTodo }, loadModels());
  const good = { digestTime: '08:00', timeZone: 'Europe/Oslo', notify: true };
  for (const digestTime of ['8:00', '24:00', '08:60', '', 800, false]) {
    assert.ok(check({ ...good, digestTime }).some((error) => error.startsWith('ownerTodo.digestTime')));
  }
  for (const timeZone of ['', 'Mars/Olympus', null, 12]) assert.ok(check({ ...good, timeZone }).some((error) => error.startsWith('ownerTodo.timeZone')));
  assert.ok(check({ ...good, notify: 'yes' }).some((error) => error.startsWith('ownerTodo.notify')));
  assert.ok(check(null).some((error) => error.startsWith('ownerTodo')));
  assert.deepEqual(check(good), []);
  assert.deepEqual(check({ digestTime: null, timeZone: 'local', notify: false }), []);
});
