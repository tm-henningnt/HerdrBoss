import { once } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { createRedactor, readRedactTenantHosts } from './redact.js';

const MAX_BUFFER_CHARS = 64 * 1024;
const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i;
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/i;

function isSensitiveWrap(left, right, redact) {
  if (!/^[ \t]+/.test(right) || !left.trim()) return false;
  const continuation = right.replace(/^[ \t]+/, '');
  if (!continuation) return false;
  return redact(left + continuation) !== redact(left) + redact(continuation);
}

function redactRecord(body, ending, redact, privateKey) {
  // Private-key blocks are rule 4. Discard each body line as it arrives instead of buffering the block.
  let output = '';
  let offset = 0;
  while (offset < body.length) {
    if (privateKey.active) {
      const end = PRIVATE_KEY_END.exec(body.slice(offset));
      if (!end) return '';
      offset += end.index + end[0].length;
      privateKey.active = false;
      if (offset === body.length) return '';
      continue;
    }

    const begin = PRIVATE_KEY_BEGIN.exec(body.slice(offset));
    if (!begin) {
      output += redact(body.slice(offset));
      break;
    }
    output += redact(body.slice(offset, offset + begin.index)) + '<key>';
    offset += begin.index + begin[0].length;
    const end = PRIVATE_KEY_END.exec(body.slice(offset));
    if (end) {
      offset += end.index + end[0].length;
      continue;
    }
    privateKey.active = true;
    return output + ending;
  }
  return output + ending;
}

export async function redactCommand(args = [], {
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  if (args.length) {
    stderr.write('Usage: herdr-boss redact < stdin\n');
    return 2;
  }

  const redact = createRedactor(readRedactTenantHosts());
  const decoder = new StringDecoder('utf8');
  const privateKey = { active: false };
  let inputBuffer = '';
  let pending = null;

  const write = async (value) => {
    if (!value) return;
    if (!stdout.write(value)) await once(stdout, 'drain');
  };

  const flushPending = async () => {
    if (!pending) return;
    await write(redactRecord(pending.body, pending.ending, redact, privateKey));
    pending = null;
  };

  const acceptLine = async (body, ending) => {
    if (body.length > MAX_BUFFER_CHARS) throw new Error('input line is too long');
    if (!pending) {
      pending = { body, ending };
      return;
    }
    if (isSensitiveWrap(pending.body, body, redact)) {
      const continuation = body.replace(/^[ \t]+/, '');
      if (pending.body.length + continuation.length > MAX_BUFFER_CHARS) throw new Error('input line is too long');
      const joined = pending.body + continuation;
      pending = { body: joined, ending };
      return;
    }
    await flushPending();
    pending = { body, ending };
  };

  try {
    for await (const chunk of stdin) {
      inputBuffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      let newline;
      while ((newline = inputBuffer.indexOf('\n')) !== -1) {
        let body = inputBuffer.slice(0, newline);
        const ending = body.endsWith('\r') ? '\r\n' : '\n';
        if (ending === '\r\n') body = body.slice(0, -1);
        inputBuffer = inputBuffer.slice(newline + 1);
        await acceptLine(body, ending);
      }
      if (inputBuffer.length > MAX_BUFFER_CHARS) throw new Error('input line is too long');
    }
    inputBuffer += decoder.end();
    if (inputBuffer) await acceptLine(inputBuffer, '');
    await flushPending();
    return 0;
  } catch {
    stderr.write('herdr-boss redact: input could not be redacted safely.\n');
    return 1;
  }
}
