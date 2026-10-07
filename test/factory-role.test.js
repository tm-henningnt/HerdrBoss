import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FACTORY_PROJECT_GROUP, isFactoryRole, isTrustedFactoryProjectPath } from '../src/factory-role.js';

test('the factory role needs the factory home and the seed checkout of the image', () => {
  const seed = (path) => path === '/opt/herdr-boss-seed';
  assert.equal(isFactoryRole({ HOME: '/home/factory' }, seed), true);
  assert.equal(isFactoryRole({ HOME: '/home/factory' }, () => false), false);
  assert.equal(isFactoryRole({ HOME: '/Users/owner' }, seed), false);
  assert.equal(isFactoryRole({}, seed), false);
});

test('the default project folder lies on the work volume of the factory', () => {
  assert.equal(FACTORY_PROJECT_GROUP, '/home/factory/work');
});

test('factory project trust resolves symlinks and refuses paths outside the real work root', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-role-work-'));
  const workRoot = path.join(root, 'work');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(workRoot, 'inside'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(workRoot, 'linked'), 'dir');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(isTrustedFactoryProjectPath(path.join(workRoot, 'inside'), { workRoot }), true);
  assert.equal(isTrustedFactoryProjectPath(path.join(workRoot, 'linked'), { workRoot }), false);
  assert.equal(isTrustedFactoryProjectPath(path.join(workRoot, 'missing'), { workRoot }), false);
});
