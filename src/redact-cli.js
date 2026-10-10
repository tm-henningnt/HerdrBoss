import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { addRedactLiteral, createRedactor, readRedactLiterals, readRedactTenantHosts, REDACT_LITERAL_CLASSES } from './redact.js';

const MAX_BUFFER_CHARS = 64 * 1024;
const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i;
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/i;

function isSensitiveWrap(left, right, redact) {
  if (!/^[ \t]+/.test(right) || !left.trim()) return false;
  const continuation = right.replace(/^[ \t]+/, '');
  if (!continuation) return false;
  return redact(left + continuation) !== redact(left) + redact(continuation);
}

function redactRecord(body, ending, redact, privateKey, onFinding = () => {}) {
  // Discard private-key body lines as they arrive instead of buffering the block.
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
    onFinding('key');
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

async function visitRecords(input, redact, visit) {
  const decoder = new StringDecoder('utf8');
  let inputBuffer = '';
  let pending = null;
  let line = 0;
  const flush = async () => {
    if (pending) await visit(pending);
    pending = null;
  };
  const acceptLine = async (body, ending) => {
    line += 1;
    if (body.length > MAX_BUFFER_CHARS) throw new Error('input line is too long');
    if (pending && isSensitiveWrap(pending.body, body, redact)) {
      const continuation = body.replace(/^[ \t]+/, '');
      if (pending.body.length + continuation.length > MAX_BUFFER_CHARS) throw new Error('input line is too long');
      pending = { body: pending.body + continuation, ending, line: pending.line };
      return;
    }
    await flush();
    pending = { body, ending, line };
  };
  for await (const chunk of input) {
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
  await flush();
}

async function checkFiles(files, hosts, literals, stdout, stderr) {
  try {
    const git = (args, cwd = process.cwd()) => execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
    });
    const root = git(['rev-parse', '--show-toplevel']).trim();
    const tracked = new Set(git(['ls-files', '-z'], root).split('\0').filter(Boolean));
    const selected = files.length ? files.map((file) => path.relative(root, path.resolve(file)).split(path.sep).join('/')) : [...tracked];
    const redact = createRedactor(hosts, literals);
    // File suffixes can hide a token boundary. Do not print a private value inside a file name.
    const privateNames = new Map(hosts.map((host) => [host, 'host']));
    for (const kind of REDACT_LITERAL_CLASSES) {
      for (const value of literals[kind]) if (!privateNames.has(value)) privateNames.set(value, kind);
    }
    const names = [...privateNames.keys()].sort((a, b) => b.length - a.length)
      .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const namePattern = names ? new RegExp(names, 'g') : null;
    const locations = new Map();
    const totals = new Map();
    for (const file of new Set(selected)) {
      if (!tracked.has(file) || /[\u0000-\u001f\u007f]/.test(file)) throw new Error('untracked file');
      const absolute = path.join(root, file);
      const relative = path.relative(fs.realpathSync(root), fs.realpathSync(absolute));
      if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)
        || !fs.lstatSync(absolute).isFile()) throw new Error('unsafe file');
      const privateKey = { active: false };
      const label = namePattern ? redact(file).replace(namePattern, (match) => `<${privateNames.get(match)}>`) : redact(file);
      let line;
      const onFinding = (kind) => {
        const location = `${label}:${line} ${kind}`;
        locations.set(location, (locations.get(location) || 0) + 1);
        totals.set(kind, (totals.get(kind) || 0) + 1);
      };
      const scan = createRedactor(hosts, literals, { onFinding });
      await visitRecords(fs.createReadStream(absolute), redact, (record) => {
        line = record.line;
        redactRecord(record.body, record.ending, scan, privateKey, onFinding);
      });
    }
    const output = [
      ...[...locations].map(([location, count]) => `${location}: ${count}\n`),
      ...[...totals].map(([kind, count]) => `${kind}: ${count}\n`),
    ].join('');
    if (output && !stdout.write(output)) await once(stdout, 'drain');
    return locations.size ? 1 : 0;
  } catch {
    stderr.write('herdr-boss redact: check could not scan tracked files safely.\n');
    return 2;
  }
}

export async function redactCommand(args = [], {
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const literals = readRedactLiterals();
  if (args[0] === 'list' && args.length === 1) {
    stdout.write(REDACT_LITERAL_CLASSES.map((kind) => `${kind}: ${literals[kind].length}\n`).join(''));
    return 0;
  }
  if (args[0] === 'add' && args.length === 2 && REDACT_LITERAL_CLASSES.includes(args[1])) {
    try {
      if (stdin.isTTY) throw new Error('use a pipe');
      const chunks = [];
      let size = 0;
      for await (const chunk of stdin) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > 4098) throw new Error('input too long');
        chunks.push(buffer);
      }
      const value = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).replace(/\r?\n$/, '');
      addRedactLiteral(args[1], value);
      return 0;
    } catch {
      stderr.write('herdr-boss redact: literal could not be stored safely. Use one literal from a pipe.\n');
      return 1;
    }
  }
  if (args[0] === '--check') return checkFiles(args.slice(1), readRedactTenantHosts(), literals, stdout, stderr);
  if (args.length) {
    stderr.write('Usage: herdr-boss redact [add CLASS | list | --check FILE...] < stdin\n');
    return 2;
  }

  const redact = createRedactor(readRedactTenantHosts(), literals);
  const privateKey = { active: false };

  const write = async (value) => {
    if (!value) return;
    if (!stdout.write(value)) await once(stdout, 'drain');
  };

  try {
    await visitRecords(stdin, redact, ({ body, ending }) => write(redactRecord(body, ending, redact, privateKey)));
    return 0;
  } catch {
    stderr.write('herdr-boss redact: input could not be redacted safely.\n');
    return 1;
  }
}
