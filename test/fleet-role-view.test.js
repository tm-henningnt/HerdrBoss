import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const fixture = JSON.parse(fs.readFileSync(new URL('../docs/contracts/examples/fleet-summary.valid.personal.json', import.meta.url)));

test('the Fleet page shows the head office holder and the epoch', async () => {
  const { fleetView } = await import('../public/fleet.js');
  const factories = [{ name: 'factory-zero', remote: false, status: 'healthy', ageSeconds: 0, summary: { ...fixture, factoryId: 'factory-zero', name: 'factory-zero' } },
    { name: 'win1', remote: true, status: 'healthy', ageSeconds: 0, summary: { ...fixture, factoryId: 'factory-win1', name: 'win1' } }];
  const held = fleetView({ factories, role: { factoryId: 'factory-zero', headOfficeFactoryId: 'factory-win1', epoch: 3, holds: false } });
  assert.match(held, /Head office/); assert.match(held, /win1/); assert.match(held, /epoch 3/);
  assert.match(held, /Another factory holds/);
  const own = fleetView({ factories, role: { factoryId: 'factory-zero', headOfficeFactoryId: 'factory-zero', epoch: 1, holds: true } });
  assert.match(own, /This factory/); assert.match(own, /epoch 1/);
  assert.match(fleetView({ factories, role: { factoryId: 'a', headOfficeFactoryId: '<b>x</b>', epoch: 2, holds: false } }), /&lt;b&gt;x/);
  assert.match(fleetView({ factories, role: { factoryId: 'factory-zero', headOfficeFactoryId: 'factory-zero', epoch: 2, holds: true, neverTold: ['win2'] } }), /Never told of the move: win2/);
  assert.doesNotMatch(fleetView({ factories }), /epoch/);
});
