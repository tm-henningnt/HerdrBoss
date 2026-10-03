import './helpers/test-env.js';
import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { tcpListening, tcpListeningAsync } from '../src/leases.js';

function listenOn(host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error) => resolve({ error }));
    server.listen(0, host, () => resolve({ server, port: server.address().port }));
  });
}
const close = (server) => new Promise((resolve) => server.close(resolve));

for (const [host, label] of [['127.0.0.1', 'IPv4'], ['::1', 'IPv6']]) {
  test(`tcp probes see a server that listens only on ${label} loopback`, async (t) => {
    const { server, port, error } = await listenOn(host);
    if (error) return t.skip(`${host} loopback is not available on this machine: ${error.code}`);
    try {
      assert.equal(tcpListening(String(port)), true);
      assert.equal(await tcpListeningAsync(port), true);
    } finally { await close(server); }
    assert.equal(tcpListening(String(port)), false);
    assert.equal(await tcpListeningAsync(port), false);
  });
}
