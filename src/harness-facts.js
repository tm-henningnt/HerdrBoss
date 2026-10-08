// Compare safe harness facts. Persist hashes only; marker labels never contain config or model values.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { appendHarnessChange, CHANGE_HARNESSES, withHarnessChangeGuard } from './harness-changes.js';
import { modelEnabled } from './control.js';

const STATE_FILE = 'harness-facts.json';
const FACTS = ['version', 'models', 'sandbox', 'launch'];
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function readText(file, limit = 256 * 1024) {
  try {
    if (fs.statSync(file).size > limit) return null;
    return fs.readFileSync(file, 'utf8');
  } catch { return null; }
}

function readJson(file, limit) {
  try { return JSON.parse(readText(file, limit)); } catch { return null; }
}

function codexSandbox(text) {
  if (text === null) return null;
  const lines = [];
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) { section = line; continue; }
    if (section === '[sandbox_workspace_write]' || (!section && /^(sandbox_mode|approval_policy)\s*=/.test(line))) lines.push(line);
  }
  return lines;
}

function currentFacts({ home, dataDir, modelsFile }) {
  const facts = {};
  const add = (kind, field, value, label) => {
    if (value !== undefined && value !== null) (facts[kind] ||= {})[field] = { hash: digest(value), label };
  };
  // tools check already reads these versions in an isolated HOME. Do not launch a harness here.
  const tools = readJson(path.join(dataDir, 'tools-state.json'));
  const models = readJson(modelsFile);
  const policy = readJson(path.join(dataDir, 'policy.json'));
  for (const kind of CHANGE_HARNESSES) {
    const version = Array.isArray(tools?.tools) ? tools.tools.find((tool) => tool?.id === kind)?.installed?.mac : null;
    if (typeof version === 'string' && /^\d+(?:\.\d+){1,3}(?:[-+~][0-9A-Za-z.-]+)?$/.test(version) && version.length <= 40) {
      add(kind, 'version', version, 'Harness version changed');
    }
    const config = models?.kinds?.[kind];
    const extra = policy?.extraModels?.[kind];
    const list = Array.isArray(config?.allowedModels) ? [...config.allowedModels, ...(Array.isArray(extra) ? extra : [])] : null;
    if (Array.isArray(list) && list.length <= 500 && list.every((item) => typeof item === 'string' && item.length <= 200)) {
      add(kind, 'models', [...new Set(list)].filter((model) => modelEnabled(kind, model, policy)).sort(), 'Model list changed');
    }
    const args = config?.launchArgs;
    const launch = Array.isArray(args) && args.length <= 100 && args.every((item) => typeof item === 'string') ? args : null;
    let settings = null;
    if (kind === 'codex') settings = codexSandbox(readText(path.join(home, '.codex', 'config.toml')));
    if (kind === 'claude') {
      const value = readJson(path.join(home, '.claude', 'settings.json'));
      if (value) settings = { sandbox: value.sandbox ?? null, mode: value.permissions?.defaultMode ?? null };
    }
    if (kind === 'opencode') {
      const value = readJson(path.join(home, '.config', 'opencode', 'opencode.json'));
      if (value) settings = { permission: value.permission ?? null };
    }
    add(kind, 'sandbox', settings, 'Sandbox settings changed');
    add(kind, 'launch', launch, 'Sandbox settings changed');
  }
  return facts;
}

export function recordHarnessFacts(options) {
  return withHarnessChangeGuard(options.dataDir, () => observeHarnessFacts(options));
}

function observeHarnessFacts(options) {
  const { dataDir } = options;
  const file = path.join(dataDir, STATE_FILE);
  const previous = readJson(file, 16 * 1024);
  const valid = previous?.schema === 1 && previous.facts && typeof previous.facts === 'object';
  const next = {};
  const changes = [];
  const current = currentFacts(options);
  for (const kind of CHANGE_HARNESSES) {
    next[kind] = {};
    for (const field of FACTS) {
      const old = valid ? previous.facts[kind]?.[field] : undefined;
      const oldHash = typeof old === 'string' && /^[a-f0-9]{64}$/.test(old) ? old : undefined;
      const fact = current[kind]?.[field];
      if (fact) {
        next[kind][field] = fact.hash;
        if (valid && oldHash !== fact.hash && !changes.some((change) => change.harness === kind && change.label === fact.label)) {
          changes.push({ harness: kind, label: fact.label });
        }
      } else if (oldHash) next[kind][field] = oldHash; // A missing reading must not erase a known fact.
    }
  }
  if (valid && JSON.stringify(previous.facts) === JSON.stringify(next)) return [];
  fs.mkdirSync(dataDir, { recursive: true });
  const temp = `${file}.${process.pid}-${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify({ schema: 1, facts: next })}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* The successful rename removes it. */ }
  }
  // Save the hashes first. An append failure loses its marker instead of retrying successful markers.
  const errors = [];
  for (const change of changes) {
    try { appendHarnessChange(dataDir, change); }
    catch (error) { errors.push(error); }
  }
  if (errors.length) throw errors[0];
  return changes;
}
