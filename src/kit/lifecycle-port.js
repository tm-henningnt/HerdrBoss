let configuredPort = null;

export function setLifecyclePort(port) {
  if (!port || typeof port !== 'object' || typeof port.createHerdrRunner !== 'function'
    || typeof port.verifyCallerPane !== 'function' || typeof port.acquireLeaseFor !== 'function'
    || typeof port.dropLeases !== 'function' || typeof port.portEnvStatus !== 'function'
    || typeof port.setLeasePane !== 'function') {
    throw new TypeError('The lifecycle port is incomplete.');
  }
  if (configuredPort && configuredPort !== port) throw new Error('The lifecycle port is already set.');
  configuredPort = Object.freeze(port);
  return configuredPort;
}

export function lifecyclePort() {
  if (!configuredPort) throw new Error('The lifecycle port is not set.');
  return configuredPort;
}
