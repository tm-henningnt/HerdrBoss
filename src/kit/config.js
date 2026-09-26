import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const MODELS_FILE = path.join(KIT_ROOT, 'kit', 'models.json');
export const DEFAULT_BRIEF_TEMPLATE = path.join(KIT_ROOT, 'kit', 'templates', 'worker-brief.md');
export const DEFAULT_RULES_FILE = path.join(process.env.HERDR_BOSS_DIR || path.join(os.homedir(), '.herdr-boss'), 'rules.json');

export const PROJECT_DEFAULTS = Object.freeze({
  baseBranch: 'main',
  worktreeRoot: '..',
  worktreeName: '{repo}-wt-{name}',
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

export function findGitRoot(cwd = process.cwd()) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
  } catch (error) {
    throw new Error(`Could not find a git repository from ${cwd}: ${error.stderr?.toString().trim() || error.message}`);
  }
}

export function loadProjectConfig({ cwd = process.cwd(), file = '.herdr-boss.json' } = {}) {
  const root = findGitRoot(cwd);
  const configPath = path.resolve(root, file);
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
  const repo = path.basename(root);
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
  if (!Number.isInteger(config.setupTimeoutSeconds) || config.setupTimeoutSeconds < 10) throw new Error('setupTimeoutSeconds must be an integer of 10 or more.');
  if (!Number.isInteger(config.agentStartTimeoutMs) || config.agentStartTimeoutMs < 1 || config.agentStartTimeoutMs > 300000) {
    throw new Error('agentStartTimeoutMs must be an integer from 1 to 300000.');
  }
  if (!Number.isInteger(config.imageBudget) || config.imageBudget < 1) throw new Error('imageBudget must be a positive integer.');
  if (!Array.isArray(config.evidenceTiers) || config.evidenceTiers.length === 0 || config.evidenceTiers.some((tier) => typeof tier !== 'string')) {
    throw new Error('evidenceTiers must be a non-empty array of strings.');
  }
  const worktreeParent = path.isAbsolute(config.worktreeRoot)
    ? config.worktreeRoot
    : path.resolve(root, config.worktreeRoot);
  return {
    ...config,
    root,
    repo,
    configPath,
    worktreeParent,
    worktreePath(name) {
      const leaf = String(config.worktreeName).replaceAll('{repo}', repo).replaceAll('{name}', name);
      return path.resolve(worktreeParent, leaf);
    },
    ledgerPath: path.resolve(root, config.ledger),
    runsPath: path.resolve(root, config.runsDir),
    briefTemplatePath: config.briefTemplate === null ? DEFAULT_BRIEF_TEMPLATE : path.resolve(root, config.briefTemplate),
  };
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
  return models;
}
