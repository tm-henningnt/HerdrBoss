import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const MODELS_FILE = path.join(KIT_ROOT, 'kit', 'models.json');
export const DEFAULT_BRIEF_TEMPLATE = path.join(KIT_ROOT, 'kit', 'templates', 'worker-brief.md');
export const DEFAULT_RULES_FILE = path.join(process.env.HERDR_BOSS_DIR || path.join(os.homedir(), '.herdr-boss'), 'rules.json');

// All worker worktrees share one parent folder, so a Codex sandbox needs one writable root for them.
export const DEFAULT_WORKTREE_ROOT = '~/Projects/.herdr-wt';

export function expandHome(value, home = os.homedir()) {
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
}

export function sharedWorktreeRoot(home = os.homedir()) {
  return expandHome(DEFAULT_WORKTREE_ROOT, home);
}

export const PROJECT_DEFAULTS = Object.freeze({
  baseBranch: 'main',
  worktreeRoot: DEFAULT_WORKTREE_ROOT,
  worktreeName: '{repo}/{name}',
  evidenceTiers: ['unit', 'integration', 'local-browser', 'hosted', 'owner'],
  ledger: '.orchestration/delegated-runs.jsonl',
  runsDir: '.orchestration/runs',
  briefTemplate: null,
  allowedModels: null,
  // Shell command that worker start runs in each new worktree before the agent starts, for example "npm ci --prefer-offline".
  setup: null,
  // Flag that limits the test runner to two threads, for example "--maxWorkers=2". worker start puts it in the brief.
  testThreadsFlag: null,
  setupTimeoutSeconds: 900,
  agentStartTimeoutMs: 90000,
  imageBudget: 10,
  // The most worker panes that worker start puts in one Workers tab.
  workerPanesPerTab: 3,
  artifactChecks: [],
});

function validateArtifactPattern(pattern, label) {
  if (typeof pattern !== 'string' || pattern.length === 0) throw new Error(`${label} must be a non-empty repository-relative POSIX glob.`);
  if (pattern.includes('\\') || /[\u0000-\u001f\u007f]/.test(pattern)) throw new Error(`${label} must not contain backslashes or control characters.`);
  if (path.posix.isAbsolute(pattern) || /^[A-Za-z]:\//.test(pattern)) throw new Error(`${label} must not be absolute.`);
  const segments = pattern.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${label} must not contain empty, current-directory, or parent-directory segments.`);
  }
  if (segments.some((segment) => segment !== '**' && segment.includes('**'))) throw new Error(`${label} may use ** only as a complete path segment.`);
  if (/[?\[\]{}]/.test(pattern)) throw new Error(`${label} supports only * and ** glob operators.`);
}

function validateArtifactChecks(artifactChecks) {
  if (!Array.isArray(artifactChecks)) throw new Error('artifactChecks must be an array of { artifacts, sources } rules.');
  artifactChecks.forEach((rule, index) => {
    const label = `artifactChecks[${index}]`;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)
      || Object.keys(rule).length !== 2
      || !Object.hasOwn(rule, 'artifacts')
      || !Object.hasOwn(rule, 'sources')) {
      throw new Error(`${label} must contain only artifacts and sources patterns.`);
    }
    validateArtifactPattern(rule.artifacts, `${label}.artifacts`);
    validateArtifactPattern(rule.sources, `${label}.sources`);
  });
}

function validateCheckAgents(checkAgents) {
  if (!checkAgents || typeof checkAgents !== 'object' || Array.isArray(checkAgents) || Object.keys(checkAgents).some((key) => key !== 'exclude')) {
    throw new Error('checkAgents must be an object with only an exclude list.');
  }
  if (checkAgents.exclude === undefined) return;
  if (!Array.isArray(checkAgents.exclude)) throw new Error('checkAgents.exclude must be an array of repository-relative POSIX globs.');
  checkAgents.exclude.forEach((pattern, index) => validateArtifactPattern(pattern, `checkAgents.exclude[${index}]`));
}

// True when a repository-relative POSIX path matches a glob. * matches inside one segment; ** matches zero or more segments.
export function globMatches(pattern, relative) {
  const segment = (glob, name) => new RegExp(`^${glob.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&').replaceAll('\\*', '[^/]*')}$`).test(name);
  const globs = pattern.split('/');
  const names = relative.split('/');
  const match = (g, n) => {
    if (g === globs.length) return n === names.length;
    if (globs[g] === '**') return match(g + 1, n) || (n < names.length && match(g, n + 1));
    return n < names.length && segment(globs[g], names[n]) && match(g + 1, n + 1);
  };
  return match(0, 0);
}

// The checkAgents.exclude globs of the .herdr-boss.json file in root. A missing file gives an empty list.
// An unreadable or invalid file throws an error.
export function checkAgentsExclude(root, file = '.herdr-boss.json') {
  let user;
  try { user = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`Could not read ${file}: ${error.message}`);
  }
  if (user?.checkAgents === undefined) return [];
  validateCheckAgents(user.checkAgents);
  return user.checkAgents.exclude ?? [];
}

export function findGitRoot(cwd = process.cwd()) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
  } catch (error) {
    throw new Error(`Could not find a git repository from ${cwd}: ${error.stderr?.toString().trim() || error.message}`);
  }
}

// The main checkout of a linked worktree: the folder that holds its shared .git folder. For the main
// checkout itself, and when git cannot tell, this is root.
export function mainCheckoutRoot(root) {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
    return path.basename(common) === '.git' ? path.dirname(common) : root;
  } catch { return root; }
}

export function loadProjectConfig({ cwd = process.cwd(), file = '.herdr-boss.json', home = os.homedir() } = {}) {
  const root = findGitRoot(cwd);
  // A worker worktree can lack an untracked .herdr-boss.json. Then the main checkout's file and name apply,
  // so a worktree folder name never becomes the project slug.
  const mainRoot = mainCheckoutRoot(root);
  const ownPath = path.resolve(root, file);
  const configPath = mainRoot !== root && !fs.existsSync(ownPath) ? path.resolve(mainRoot, file) : ownPath;
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Could not read project config ${configPath}: ${error.message}`);
  }
  if (!user || typeof user !== 'object' || Array.isArray(user)) throw new Error(`${configPath} must contain a JSON object.`);
  for (const field of ['baseBranch', 'worktreeRoot', 'worktreeName', 'ledger', 'runsDir']) {
    if (user[field] !== undefined && (typeof user[field] !== 'string' || user[field].trim() === '')) throw new Error(`${field} must be a non-empty string.`);
  }
  if (user.slug !== undefined && (typeof user.slug !== 'string' || user.slug.trim() === '')) throw new Error('slug must be a non-empty string.');
  if (user.briefTemplate !== undefined && user.briefTemplate !== null && (typeof user.briefTemplate !== 'string' || user.briefTemplate.trim() === '')) throw new Error('briefTemplate must be a non-empty path or null.');
  const repo = path.basename(mainRoot);
  const config = {
    ...PROJECT_DEFAULTS,
    ...user,
    slug: user.slug ?? repo.toLowerCase(),
  };
  if (config.allowedModels !== null && (!Array.isArray(config.allowedModels) || config.allowedModels.some((model) => typeof model !== 'string'))) {
    throw new Error('allowedModels must be null or an array of model names.');
  }
  if (config.setup !== null && (typeof config.setup !== 'string' || !config.setup.trim())) throw new Error('setup must be null or a non-empty shell command.');
  if (config.testThreadsFlag !== null && (typeof config.testThreadsFlag !== 'string' || !config.testThreadsFlag.trim())) throw new Error('testThreadsFlag must be null or a non-empty string.');
  validateArtifactChecks(config.artifactChecks);
  if (config.checkAgents !== undefined) validateCheckAgents(config.checkAgents);
  if (!Number.isInteger(config.setupTimeoutSeconds) || config.setupTimeoutSeconds < 10) throw new Error('setupTimeoutSeconds must be an integer of 10 or more.');
  if (!Number.isInteger(config.agentStartTimeoutMs) || config.agentStartTimeoutMs < 1 || config.agentStartTimeoutMs > 300000) {
    throw new Error('agentStartTimeoutMs must be an integer from 1 to 300000.');
  }
  if (!Number.isInteger(config.imageBudget) || config.imageBudget < 1) throw new Error('imageBudget must be a positive integer.');
  if (!Number.isInteger(config.workerPanesPerTab) || config.workerPanesPerTab < 1 || config.workerPanesPerTab > 6) {
    throw new Error('workerPanesPerTab must be an integer from 1 to 6.');
  }
  if (!Array.isArray(config.evidenceTiers) || config.evidenceTiers.length === 0 || config.evidenceTiers.some((tier) => typeof tier !== 'string')) {
    throw new Error('evidenceTiers must be a non-empty array of strings.');
  }
  const worktreeRoot = expandHome(config.worktreeRoot, home);
  const worktreeParent = path.isAbsolute(worktreeRoot)
    ? worktreeRoot
    : path.resolve(root, worktreeRoot);
  return {
    ...config,
    root,
    mainRoot,
    repo,
    configPath,
    worktreeParent,
    worktreePath(name) {
      const leaf = String(config.worktreeName).replaceAll('{repo}', repo).replaceAll('{name}', name);
      return path.resolve(worktreeParent, leaf);
    },
    ledgerPath: path.resolve(mainRoot, config.ledger),
    runsPath: path.resolve(mainRoot, config.runsDir),
    briefTemplatePath: config.briefTemplate === null ? DEFAULT_BRIEF_TEMPLATE : path.resolve(root, config.briefTemplate),
  };
}

// The non-secret worker config fields that the dashboard shows for a project. Never add a secret field.
export const WORKER_CONFIG_FIELDS = Object.freeze([
  'slug', 'baseBranch', 'worktreeRoot', 'worktreeName',
  'evidenceTiers', 'allowedModels', 'workerPanesPerTab', 'imageBudget',
  'setup', 'setupTimeoutSeconds', 'agentStartTimeoutMs', 'testThreadsFlag',
]);

function sameValue(a, b) {
  if (a === undefined || b === undefined) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

// Show the home folder as ~, and keep one ~ form when the value already uses it.
function homeRelative(value, home = os.homedir()) {
  if (typeof value !== 'string' || !home) return value;
  if (value === home) return '~';
  if (value.startsWith(`${home}${path.sep}`)) return `~${value.slice(home.length)}`;
  return value;
}

// The read-only view of one project worker config. It holds allow-listed fields only.
// The value of a field never holds a secret. The setup command shows as "set" or "not set".
export function workerConfigView(config, { home = os.homedir() } = {}) {
  const fields = WORKER_CONFIG_FIELDS.map((key) => {
    const raw = config?.[key];
    const source = sameValue(raw, PROJECT_DEFAULTS[key]) ? 'default' : 'config';
    let value = raw;
    if (key === 'setup') value = raw ? 'set' : 'not set';
    else if (key === 'worktreeRoot') value = homeRelative(raw, home);
    else if (value === null || value === undefined) value = 'not set';
    return { key, value, source };
  });
  return { fields };
}

export function loadModels(file = MODELS_FILE) {
  let models;
  try {
    models = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read model allow-list ${file}: ${error.message}`);
  }
  if (!models || typeof models !== 'object' || !models.kinds || typeof models.kinds !== 'object') {
    throw new Error(`${file} must contain a kinds object.`);
  }
  for (const [kind, cfg] of Object.entries(models.kinds)) {
    if (!cfg || typeof cfg !== 'object') continue;
    if (Object.hasOwn(cfg, 'contextTokens') && !positiveInteger(cfg.contextTokens)) throw new Error(`${file}: ${kind}.contextTokens must be a positive integer.`);
    if (Object.hasOwn(cfg, 'contextTokensByModel')) {
      const byModel = cfg.contextTokensByModel;
      if (!byModel || typeof byModel !== 'object' || Array.isArray(byModel) || !Object.values(byModel).every(positiveInteger)) {
        throw new Error(`${file}: ${kind}.contextTokensByModel must map model names to positive integers.`);
      }
    }
  }
  return models;
}

function positiveInteger(value) { return Number.isInteger(value) && value > 0; }

// The context window of a model in tokens, or null when the catalog does not give one.
export function contextTokensFor(models, kind, model) {
  const cfg = models?.kinds?.[kind];
  if (!cfg) return null;
  return cfg.contextTokensByModel?.[model] ?? cfg.contextTokens ?? null;
}
