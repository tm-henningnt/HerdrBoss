// A fake Chrome debugging endpoint for the browser probe tests: an HTTP server with a minimal WebSocket server.
// Each CDP method can answer, fail, or hang. The server records the targets that a client creates and closes.
import http from 'node:http';
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(text) {
  const payload = Buffer.from(text);
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
  else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
  return Buffer.concat([header, payload]);
}

// Read the masked text frames of a client from a buffer. Return the messages and the rest of the buffer.
function readFrames(buffer) {
  const messages = [];
  let closed = false;
  for (;;) {
    if (buffer.length < 2) break;
    const opcode = buffer[0] & 0x0f;
    let length = buffer[1] & 0x7f;
    let offset = 2;
    if (length === 126) { if (buffer.length < 4) break; length = buffer.readUInt16BE(2); offset = 4; }
    else if (length === 127) { if (buffer.length < 10) break; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
    if (buffer.length < offset + 4 + length) break;
    const mask = buffer.subarray(offset, offset + 4);
    const data = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
    for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    buffer = buffer.subarray(offset + 4 + length);
    if (opcode === 8) closed = true;
    else if (opcode === 1) messages.push(data.toString());
  }
  return { messages, rest: buffer, closed };
}

// behavior maps a CDP method to 'hang', 'error', 'drop', { delayMs }, or a function (params) => result. A method without a behavior answers with a default.
export async function fakeCdp({ behavior = {}, evaluateValue = 2, httpVersion = 'ok', versionDelayMs = 0, upgradeDelayMs = 0, httpClose = 'ok' } = {}) {
  const state = { behavior: { ...behavior }, evaluateValue, httpVersion, created: [], closed: [], calls: [], httpClosed: [], sockets: new Set(), versionRequests: 0, versionAnswers: 0 };
  let nextTarget = 1;
  const defaults = {
    'Browser.getVersion': () => ({ product: 'FakeChrome/1' }),
    'Target.getTargets': () => ({ targetInfos: [{ targetId: 'user-tab', type: 'page', attached: true }] }),
    'Target.createTarget': (params) => { const id = `T${nextTarget++}`; state.created.push({ id, params }); return { targetId: id }; },
    'Target.attachToTarget': (params) => ({ sessionId: `S-${params.targetId}` }),
    'Runtime.evaluate': () => ({ result: { type: 'number', value: state.evaluateValue } }),
    'Target.closeTarget': (params) => { state.closed.push(params.targetId); return { success: true }; },
  };
  const server = http.createServer((req, res) => {
    if (req.url === '/json/version') {
      state.versionRequests++;
      if (state.httpVersion === 'hang') return;
      res.setHeader('content-type', 'application/json');
      const body = JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/fake` });
      return versionDelayMs ? setTimeout(() => { state.versionAnswers++; try { res.end(body); } catch {} }, versionDelayMs) : res.end(body);
    }
    const close = /^\/json\/close\/(.+)$/.exec(req.url);
    if (close && httpClose === 'fail') { res.statusCode = 500; return res.end('no'); }
    if (close) { state.httpClosed.push(close[1]); state.closed.push(close[1]); return res.end('Target is closing'); }
    res.statusCode = 404;
    res.end();
  });
  server.on('upgrade', (req, socket) => {
    state.sockets.add(socket);
    socket.on('close', () => state.sockets.delete(socket));
    socket.on('error', () => {});
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64');
    const handshake = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`;
    state.upgrades = (state.upgrades || 0) + 1;
    if (upgradeDelayMs) setTimeout(() => { if (!socket.destroyed) socket.write(handshake); }, upgradeDelayMs); else socket.write(handshake);
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const read = readFrames(buffer);
      buffer = read.rest;
      if (read.closed) socket.end();
      for (const text of read.messages) {
        const message = JSON.parse(text);
        state.calls.push(message.method);
        const rule = state.behavior[message.method];
        if (rule === 'hang') continue;
        if (rule === 'error') { socket.write(frame(JSON.stringify({ id: message.id, error: { code: -32000, message: 'Internal error' } }))); continue; }
        if (rule === 'drop') { socket.destroy(); continue; }
        const answer = () => {
          const result = (typeof rule === 'function' ? rule : defaults[message.method] || (() => ({})))(message.params || {});
          if (!socket.destroyed) socket.write(frame(JSON.stringify({ id: message.id, result, ...(message.sessionId ? { sessionId: message.sessionId } : {}) })));
        };
        // A rule { delayMs } answers with the default result after a delay.
        if (rule && typeof rule === 'object') setTimeout(() => { state.behavior[message.method] = undefined; answer(); }, rule.delayMs);
        else answer();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = server.address().port;
  state.close = () => new Promise((resolve) => {
    for (const socket of state.sockets) socket.destroy();
    server.closeAllConnections();
    server.close(() => resolve());
  });
  return state;
}
