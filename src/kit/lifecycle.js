import { acquireLeaseFor, dropLeases, portEnvStatus, setLeasePane } from '../leases.js';
import { createHerdrRunner, verifyCallerPane } from './workers.js';
import { setLifecyclePort } from './lifecycle-port.js';

const PORT = Object.freeze({
  createHerdrRunner,
  verifyCallerPane,
  acquireLeaseFor,
  dropLeases,
  portEnvStatus,
  setLeasePane,
});

export function initializeLifecyclePort() {
  return setLifecyclePort(PORT);
}
