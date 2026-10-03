import './helpers/test-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { FACTORY_PROJECT_GROUP, isFactoryRole } from '../src/factory-role.js';

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
