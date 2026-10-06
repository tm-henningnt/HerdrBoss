import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { isHerdrPane } from './cli.js';
import { createMasterKeyProvider, MASTER_KEY_BYTES } from './secret-master-key.js';
import { createSecretStore, secretsDir } from './secret-store.js';

const SECRET_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/;
const AGENT_PANE_MESSAGE = 'Run this command at a terminal. It is not available in an agent pane.';
const STDIN_VALUE_MESSAGE = 'Secret values must come from stdin. Use stdin.';
const SECRET_VALUE_MESSAGE = 'Secret values must hold 1 to 4096 bytes of UTF-8 text with no whitespace.';
const MAX_SECRET_BYTES = 4096;
const MAX_STDIN_BYTES = MAX_SECRET_BYTES + 1;

// Add a provider-specific validator only after its login-entry format is verified.
export const SECRET_PROVIDER_VALIDATORS = Object.freeze({});

function secretError(message, exitCode = 1) {
  const error = new Error(message);
  error.secretCommandError = true;
  error.secretCommandExitCode = exitCode;
  return error;
}

function validSlug(value) {
  return typeof value === 'string' && SECRET_NAME.test(value);
}

function validIsoDateTime(value) {
  const match = ISO_DATE_TIME.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]) return false;
  if (Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59) return false;
  if (zone !== 'Z' && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59)) return false;
  return true;
}

function parseSetArgs(args) {
  if (args.length > 1 && !['--provider', '--label', '--expires'].includes(args[1])) {
    throw secretError(STDIN_VALUE_MESSAGE);
  }
  if (!validSlug(args[0])) throw secretError('Use a valid secret name.');
  const meta = {};
  const flags = new Map([
    ['--provider', 'provider'],
    ['--label', 'label'],
    ['--expires', 'expires'],
  ]);
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    const key = flags.get(option);
    if (!key) throw secretError(STDIN_VALUE_MESSAGE);
    if (Object.hasOwn(meta, key)) throw secretError('Use each metadata option only once.');
    const value = args[index + 1];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      throw secretError(`The ${option} option needs a value.`);
    }
    if (key === 'provider' || key === 'label') {
      if (!validSlug(value)) throw secretError(`The ${option} value must be a lower case slug.`);
    } else if (!validIsoDateTime(value)) {
      throw secretError('--expires must be an ISO date and time.');
    }
    meta[key] = value;
    index += 1;
  }
  return { name: args[0], meta };
}

async function readAll(stream, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    const remaining = limit - length;
    if (typeof chunk === 'string') {
      if (Buffer.byteLength(chunk) > remaining) throw secretError(SECRET_VALUE_MESSAGE);
      chunks.push(Buffer.from(chunk));
      length += Buffer.byteLength(chunk);
      continue;
    }
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (bytes.length > remaining) throw secretError(SECRET_VALUE_MESSAGE);
    chunks.push(bytes);
    length += bytes.length;
  }
  return Buffer.concat(chunks, length);
}

async function readPromptLine(input, output, prompt) {
  const readline = createInterface({ input, output, terminal: false, historySize: 0, crlfDelay: Infinity });
  try { return await readline.question(prompt); }
  catch { return ''; }
  finally { readline.close(); }
}

async function readHiddenLine(input, output) {
  const restoreRawMode = input.isRaw === true;
  input.setRawMode(true);
  output.write('Secret value: ');
  return new Promise((resolve, reject) => {
    const bytes = [];
    let complete = false;

    function finish(error) {
      if (complete) return;
      complete = true;
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      input.setRawMode(restoreRawMode);
      output.write('\n');
      if (error) reject(error);
      else resolve(Buffer.from(bytes));
    }

    function onData(chunk) {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      for (const byte of incoming) {
        if (byte === 0x03) return finish(secretError('Secret input cancelled.', 130));
        if (byte === 0x04 || byte === 0x0a || byte === 0x0d) return finish();
        if (byte === 0x08 || byte === 0x7f) {
          let last = bytes.pop();
          while (last !== undefined && (last & 0xc0) === 0x80) last = bytes.pop();
          continue;
        }
        if (bytes.length >= MAX_SECRET_BYTES) return finish(secretError(SECRET_VALUE_MESSAGE));
        bytes.push(byte);
      }
    }

    function onEnd() { finish(); }
    function onError() { finish(secretError('Could not read the secret value.')); }
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onError);
  });
}

async function readSecret(input, output) {
  if (input?.isTTY) return readHiddenLine(input, output);
  const value = await readAll(input, MAX_STDIN_BYTES);
  if (value.subarray(-2).equals(Buffer.from('\r\n'))) return value.subarray(0, -2);
  if (value.at(-1) === 0x0a) return value.subarray(0, -1);
  return value;
}

function writeAudit(dir, { name, action, now }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, 'audit.jsonl');
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, `${JSON.stringify({ name, action, time: now() })}\n`);
  } finally {
    fs.closeSync(fd);
  }
}

function genericFormatValid(value) {
  if (!Buffer.isBuffer(value) || value.length < 1 || value.length > MAX_SECRET_BYTES) return false;
  let decoded;
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(value); }
  catch { return false; }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(decoded)) return false;
  return !/\s/u.test(decoded);
}

function checkValue(store, entry, providerValidators) {
  let value;
  try { value = store.getSecretValue(entry.name); }
  catch { return false; }
  if (!genericFormatValid(value)) return false;
  const validator = typeof entry.provider === 'string' ? providerValidators[entry.provider] : null;
  if (!validator) return true;
  try { return validator({ name: entry.name, value, metadata: { ...entry } }) === true; }
  catch { return false; }
}

// The journal is added by the account-use slice. Keep this call site stable for that work.
export function removeSecretJournal(_name, _dir) {}

function metadataLine(entry) {
  return JSON.stringify({
    name: entry.name,
    provider: entry.provider ?? null,
    label: entry.label ?? null,
    expires: entry.expires ?? null,
  });
}

function writeLine(stream, line) {
  stream.write(`${line}\n`);
}

async function executeSecretCommand(action, args, context) {
  const { dir, keyProvider, stdin, stdout, providerValidators } = context;
  const emptyKey = Buffer.alloc(MASTER_KEY_BYTES);
  const metadataStore = createSecretStore({ dir, key: emptyKey });

  if (action === 'set') {
    const { name, meta } = parseSetArgs(args);
    const value = await readSecret(stdin, stdout);
    if (!genericFormatValid(value)) throw secretError(SECRET_VALUE_MESSAGE);
    const store = createSecretStore({ dir, key: keyProvider.ensure() });
    store.putSecret(name, value, meta);
    writeLine(stdout, `stored ${name} in ${dir}.`);
    return 0;
  }

  if (action === 'list') {
    if (args.length !== 0) throw secretError('Usage: secret list.');
    const entries = metadataStore.listSecrets().sort((a, b) => a.name.localeCompare(b.name));
    if (!entries.length) writeLine(stdout, 'No secrets stored.');
    else for (const entry of entries) writeLine(stdout, metadataLine(entry));
    return 0;
  }

  if (action === 'remove') {
    if (args.length !== 1 || !validSlug(args[0])) throw secretError('Usage: secret remove NAME.');
    const [name] = args;
    const confirmation = await readPromptLine(stdin, stdout, 'Type the secret name to confirm removal: ');
    if (confirmation !== name) throw secretError('The secret name did not match.');
    if (!metadataStore.removeSecret(name)) throw secretError('The secret was not found.');
    removeSecretJournal(name, dir);
    writeLine(stdout, `removed ${name} from the secret store.`);
    return 0;
  }

  if (action === 'check') {
    if (args.length > 1 || (args.length === 1 && !validSlug(args[0]))) throw secretError('Usage: secret check [NAME].');
    const entries = metadataStore.listSecrets();
    const selected = args.length === 1
      ? [{ name: args[0], ...(entries.find((entry) => entry.name === args[0]) ?? {}) }]
      : entries.sort((a, b) => a.name.localeCompare(b.name));
    if (!selected.length) {
      writeLine(stdout, 'No secrets stored.');
      return 0;
    }
    let store = null;
    if (selected.some((entry) => entries.some((candidate) => candidate.name === entry.name))) {
      try { store = createSecretStore({ dir, key: keyProvider.read() }); }
      catch { store = null; }
    }
    let failed = false;
    for (const entry of selected) {
      const ok = Boolean(store && entries.some((candidate) => candidate.name === entry.name)
        && checkValue(store, entry, providerValidators));
      writeLine(stdout, `${entry.name} ${ok ? 'ok' : 'failed'}`);
      if (!ok) failed = true;
    }
    return failed ? 1 : 0;
  }

  throw secretError('Usage: secret set NAME [--provider P --label L --expires ISO] | secret list | secret remove NAME | secret check [NAME].');
}

export async function secretCommand(args = [], {
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  dir = secretsDir(),
  keyProvider = createMasterKeyProvider(),
  providerValidators = SECRET_PROVIDER_VALIDATORS,
  now = () => new Date().toISOString(),
} = {}) {
  const action = ['set', 'list', 'remove', 'check'].includes(args[0]) ? args[0] : 'unknown';
  const requestedName = action === 'list' || (action === 'check' && args.length === 1)
    ? '*'
    : (typeof args[1] === 'string' && validSlug(args[1]) ? args[1] : '');
  let exitCode = 1;
  if (['set', 'remove', 'check'].includes(action) && isHerdrPane(env)) {
    writeLine(stderr, AGENT_PANE_MESSAGE);
    return 3;
  }

  try {
    exitCode = await executeSecretCommand(action, args.slice(1), {
      dir, keyProvider, stdin, stdout, providerValidators,
    });
  } catch (error) {
    if (error?.secretCommandExitCode === 130) return 130;
    writeLine(stderr, error?.secretCommandError ? error.message : 'Secret command failed.');
    exitCode = 1;
  }

  try { writeAudit(dir, { name: requestedName, action, now }); }
  catch { writeLine(stderr, 'Could not write the secret audit record.'); exitCode = 1; }
  return exitCode;
}
