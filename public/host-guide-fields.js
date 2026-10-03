// The values that the "Add a host" guide collects, the format check of each value, and the text that the guide builds from them.
// No DOM use: the page, the service, and the Node tests import this file.
// No field holds a secret. A value that looks like a secret is refused in every field.

const int = (min, max) => (value) => (/^\d{1,4}$/.test(value) && Number(value) >= min && Number(value) <= max ? '' : `Type a whole number from ${min} to ${max}.`);
const pattern = (regex, message) => (value) => (regex.test(value) ? '' : message);

// Same rule as the host registry of the host tool (src/factory-host.js). A test compares both.
export const HOST_NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;
export const HOST_USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;
const WORD = /^[a-z][a-z0-9-]{0,30}$/;
const TAILNET_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.ts\.net$/;
const FINGERPRINT = /SHA256:[A-Za-z0-9+/]{43}(?![A-Za-z0-9+/=])/;
const SECRET = /-----BEGIN|PRIVATE KEY|\b(?:ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-\S+)\s+AAAA|\btskey-\S|\bghp_\S|\bgithub_pat_\S|\bsk-[A-Za-z0-9]{8}|\bAKIA[0-9A-Z]{12}|\bxox[abp]-\S/i;

const FIELD_LIST = [
  { id: 'label', name: 'Machine label', hint: 'Lower case letters, digits, and hyphens. This is the host name in the registry.', example: 'build-box', check: (v) => (HOST_NAME.test(v) && v !== 'local' ? '' : 'Use 1 to 31 lower case letters, digits, or hyphens. Start with a letter or a digit. The name "local" is reserved.') },
  { id: 'role', name: 'Role', hint: 'What the host does, in one word.', example: 'factory', check: pattern(WORD, 'Use lower case letters, digits, and hyphens. Start with a letter.') },
  { id: 'user', name: 'Linux user', hint: 'The user that runs the factory on the host.', example: 'factory', placeholder: 'FACTORY_USER', check: pattern(HOST_USER, 'Use letters, digits, dot, hyphen, and underscore. Start with a letter or an underscore. Use at most 32 characters.') },
  { id: 'distro', name: 'WSL distribution name', hint: 'The name in `wsl --list --verbose`.', example: 'Ubuntu', placeholder: 'DISTRO', types: ['windows-wsl2'], check: pattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'Use letters, digits, dot, hyphen, and underscore. No space.') },
  { id: 'tailnetName', name: 'Tailnet name of the host', hint: 'The full name of the host in Tailscale. It ends in .ts.net. Keep it private.', example: '<machine>.<tailnet>.ts.net', placeholder: 'HOST_FQDN', check: pattern(TAILNET_NAME, 'Type the full name that ends in .ts.net, in lower case, for example <machine>.<tailnet>.ts.net.') },
  { id: 'tailscaleAddress', name: 'Tailscale address', hint: 'The result of `tailscale ip -4`. It starts with 100.', example: '100.64.0.10', check: (v) => { const m = /^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v); return m && m[1] >= 64 && m[1] <= 127 && m[2] <= 255 && m[3] <= 255 ? '' : 'Type an address from 100.64.0.0 to 100.127.255.255.'; } },
  { id: 'macName', name: 'Name of the Mac in Tailscale', hint: 'The machine name that `tailscale status` shows for the Mac.', example: 'my-mac', check: pattern(/^[a-z0-9][a-z0-9-]{0,62}$/, 'Use lower case letters, digits, and hyphens.') },
  { id: 'alias', name: 'SSH alias', hint: 'The short name in ~/.ssh/config. The default is the machine label.', example: 'build-box', placeholder: 'HOST_ALIAS', check: pattern(HOST_NAME, 'Use 1 to 31 lower case letters, digits, or hyphens.') },
  { id: 'keyName', name: 'Key file name', hint: 'The name of the key file in ~/.ssh/herdr-factory. Type the name only, never the key.', example: 'build-box-key', placeholder: 'KEY_NAME', check: pattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, 'Use letters, digits, hyphen, and underscore. No dot, no space, no slash.') },
  { id: 'fingerprint', name: 'Key fingerprint', hint: 'The line that `ssh-keygen -l` prints. Paste the line. The page keeps the SHA256 part. Never paste a key.', example: 'SHA256:… (43 characters)', check: pattern(FINGERPRINT, 'Paste the line from `ssh-keygen -l`. It has SHA256: and 43 characters.') },
  { id: 'context', name: 'Docker context name', hint: 'The default is hf- and the machine label.', example: 'hf-build-box', placeholder: 'CONTEXT', check: pattern(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/, 'Use letters, digits, dot, hyphen, and underscore. No space.') },
  { id: 'ubuntuVersion', name: 'Ubuntu version', hint: 'The release, for example 24.04.', example: '24.04', check: pattern(/^\d{2}\.\d{2}$/, 'Type the release as two numbers, for example 24.04.') },
  { id: 'dockerVersion', name: 'Docker version', hint: 'The server version.', example: '28.0.1', check: pattern(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/, 'Type three numbers with dots, for example 28.0.1.') },
  { id: 'tailscaleVersion', name: 'Tailscale version', hint: 'The first line of `tailscale version`.', example: '1.80.2', check: pattern(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/, 'Type three numbers with dots, for example 1.80.2.') },
  { id: 'wslVersion', name: 'WSL version', hint: 'The WSL version line of `wsl --version`.', example: '2.4.8.0', types: ['windows-wsl2'], check: pattern(/^\d{1,3}(?:\.\d{1,5}){2,3}$/, 'Type the version with dots, for example 2.4.8.0.') },
  { id: 'memoryGb', name: 'Memory limit in GB', hint: 'The memory that WSL or OrbStack may use. Leave memory for the system.', example: '48', placeholder: 'MEMORY_GB', check: int(1, 1024) },
  { id: 'cpuCount', name: 'CPU threads', hint: 'The number of processors that WSL may use.', example: '16', placeholder: 'CPU_COUNT', types: ['windows-wsl2', 'linux'], check: int(1, 512) },
  { id: 'swapGb', name: 'Swap in GB', hint: 'Type 0 for no swap.', example: '8', placeholder: 'SWAP_GB', types: ['windows-wsl2'], check: int(0, 1024) },
  { id: 'windowsAccount', name: 'Windows account name', hint: 'The account that owns the WSL distribution. Type the name only, never the password. Keep it private.', example: 'owner', types: ['windows-wsl2'], check: pattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/, 'Use letters, digits, dot, hyphen, and underscore. Use at most 20 characters.') },
  { id: 'tailscaleAccount', name: 'Tailscale login', hint: 'The login of your own Tailscale account, for example an email address. Keep it private.', example: 'owner@example.com', placeholder: 'OWNER_LOGIN', check: pattern(/^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}$/, 'Type the login as name@domain.') },
];

export const FIELDS = Object.freeze(Object.fromEntries(FIELD_LIST.map((field) => [field.id, Object.freeze(field)])));
export const FIELD_IDS = FIELD_LIST.map((field) => field.id);

// A value in angle brackets in the step text stands for a field. WORKER and HOST name the machine label.
export const PLACEHOLDERS = Object.freeze({
  HOST: 'label', WORKER: 'label', HOST_ALIAS: 'alias', HOST_FQDN: 'tailnetName', FACTORY_USER: 'user', DISTRO: 'distro',
  KEY_NAME: 'keyName', CONTEXT: 'context', CPU_COUNT: 'cpuCount', MEMORY_GB: 'memoryGb', SWAP_GB: 'swapGb', OWNER_LOGIN: 'tailscaleAccount',
});

export const fieldsFor = (type) => FIELD_LIST.filter((field) => !field.types || field.types.includes(type));

// The value without the characters around it. A fingerprint line keeps its SHA256 part only.
export function normalizeField(id, value) {
  const text = String(value ?? '').trim();
  if (id === 'fingerprint') return FINGERPRINT.exec(text)?.[0] ?? text;
  return text;
}

// { ok, message }. An empty value is ok: a field is optional until the guide builds the registry entry.
export function checkField(id, value) {
  const field = FIELDS[id];
  if (!field) return { ok: false, message: 'This field is not known.' };
  const text = String(value ?? '');
  if (/[\0\r\n]/.test(text) && id !== 'fingerprint') return { ok: false, message: 'Type one line.' };
  if (SECRET.test(text)) return { ok: false, message: 'This looks like a secret. Never type a secret here. Keep it on the host or on your Mac.' };
  const normalized = normalizeField(id, text);
  if (normalized === '') return { ok: true, message: '' };
  const message = field.check(normalized);
  return { ok: message === '', message };
}

// The values with a default for the alias and for the Docker context.
export function effectiveValues(values = {}) {
  const out = { ...values };
  if (out.label) {
    out.alias ||= out.label;
    out.context ||= `hf-${out.label}`;
  }
  return out;
}

const TOKEN = /<([A-Z][A-Z_]*)>/g;

// Replace each <NAME> with the value of its field. A name without a value stays as it is, so the user sees what is missing.
export function substitute(text, values) {
  const have = effectiveValues(values);
  return text.replace(TOKEN, (whole, name) => {
    const id = PLACEHOLDERS[name];
    return id && have[id] && !checkField(id, have[id]).message ? normalizeField(id, have[id]) : whole;
  });
}

export function missingPlaceholders(text, values) {
  const have = effectiveValues(values);
  return [...new Set([...text.matchAll(TOKEN)].map((match) => match[1]).filter((name) => PLACEHOLDERS[name] && (!have[PLACEHOLDERS[name]] || checkField(PLACEHOLDERS[name], have[PLACEHOLDERS[name]]).message)))];
}

// The registry fields that `factory host add` needs.
const ENTRY_FIELDS = ['label', 'tailnetName', 'user', 'keyName'];

export function missingForEntry(values) {
  const have = effectiveValues(values);
  return ENTRY_FIELDS.filter((id) => !have[id] || checkField(id, have[id]).message);
}

// The registry entry for `herdr-boss factory host add`. The page shows it and posts nothing.
// The JSON goes to the private input of the command, so the address stays out of the shell history.
export function registryEntry(values, runtime) {
  const have = effectiveValues(values);
  const missing = missingForEntry(values);
  const label = have.label || '<HOST>';
  const entry = {
    address: have.tailnetName || '<HOST_FQDN>',
    user: have.user || '<FACTORY_USER>',
    keyFile: `~/.ssh/herdr-factory/${have.keyName || '<KEY_NAME>'}`,
    ...(have.context ? { dockerContext: have.context } : {}),
    runtime,
  };
  return {
    complete: missing.length === 0,
    missing,
    command: `herdr-boss factory host add ${label} --from-file -`,
    json: JSON.stringify(entry, null, 2),
    next: `herdr-boss factory new <NAME> --host ${label}`,
  };
}

const SUMMARY_ROWS = [
  ['Machine label', ['label']], ['Role', ['role']], ['User', ['user']], ['Tailnet name', ['tailnetName']], ['Tailscale address', ['tailscaleAddress']],
  ['Key fingerprint', ['fingerprint']], ['Versions', ['ubuntuVersion', 'dockerVersion', 'tailscaleVersion', 'wslVersion']],
  ['Memory and CPU limits', ['memoryGb', 'cpuCount', 'swapGb']], ['Account names', ['windowsAccount', 'tailscaleAccount']],
];
const UNITS = { memoryGb: (v) => `${v} GB memory`, cpuCount: (v) => `${v} threads`, swapGb: (v) => `${v} GB swap`, ubuntuVersion: (v) => `Ubuntu ${v}`, dockerVersion: (v) => `Docker ${v}`, tailscaleVersion: (v) => `Tailscale ${v}`, wslVersion: (v) => `WSL ${v}` };

// A Markdown table of the answers, for private notes. A missing value shows as "not set".
export function summaryTable(values, type) {
  const have = effectiveValues(values);
  const allowed = new Set(fieldsFor(type).map((field) => field.id));
  const rows = SUMMARY_ROWS.map(([name, ids]) => {
    const shown = ids.filter((id) => allowed.has(id) && have[id]).map((id) => (UNITS[id] ? UNITS[id](have[id]) : have[id]));
    return `| ${name} | ${shown.length ? shown.join(', ') : 'not set'} |`;
  });
  return ['| Value | Answer |', '|---|---|', ...rows].join('\n');
}
