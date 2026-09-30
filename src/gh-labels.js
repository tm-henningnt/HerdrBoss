// The label sync of `herdr-boss gh label sync`, `project new`, and `project check`.
// A sync creates or edits labels through `gh label create` and `gh label edit`. It never deletes a label.
// Every line of gh output passes through redact().
import { execFileSync, spawnSync } from 'node:child_process';
import { stripRemoteCredentials } from './harness.js';
import { buildGhLabelArgs, planLabelSync } from './kit/gh.js';
import { redact } from './project-new-remote.js';

const TIMEOUT_MS = 60_000;
const LIST_FIELDS = 'name,color,description';

const GITHUB_ORIGIN = [
  /^https?:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i,
  /^ssh:\/\/(?:[^/@]+@)?github\.com(?::\d+)?\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i,
  /^[A-Za-z0-9._-]+@github\.com:([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i,
];

// OWNER/REPO of a github.com origin URL in https or ssh form, or null.
export function parseGithubRepo(url) {
  const text = stripRemoteCredentials(String(url ?? '')).trim();
  for (const pattern of GITHUB_ORIGIN) {
    const match = pattern.exec(text);
    if (match) return `${match[1]}/${match[2]}`;
  }
  return null;
}

// OWNER/REPO of remote.origin.url in cwd, read raw. Throws a plain Error without a github.com origin.
export function originRepo(cwd) {
  let url = '';
  try { url = execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
  if (!url) throw new Error('The project has no origin remote. Herdr Boss will not let gh choose a repository.');
  const repo = parseGithubRepo(url);
  if (!repo) throw new Error('The origin remote is not a github.com repository. Herdr Boss will not let gh choose a repository.');
  return repo;
}

// The environment of a gh child process. GH_REPO and GH_HOST cannot redirect it.
export function cleanGhEnv(env = process.env) {
  const { GH_REPO, GH_HOST, ...rest } = env;
  return { ...rest, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' };
}

// The default runner: run gh in cwd and return { status, error, stdout, stderr }.
export function ghRunner({ cwd, env = process.env } = {}) {
  return (args) => {
    const result = spawnSync('gh', args, { cwd, env: cleanGhEnv(env), encoding: 'utf8', timeout: TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: result.status, error: result.error, stdout: result.stdout || '', stderr: result.stderr || '' };
  };
}

const brief = (result) => redact(`${result.stderr}${result.stdout}`).trim().split('\n').slice(0, 3).join(' ').slice(0, 400) || 'no message';

// Read the labels of the repository. Returns an array, or throws an Error with a redacted message.
export function listLabels(run, repo) {
  const result = run(['label', 'list', `--repo=${repo}`, '--json', LIST_FIELDS, '--limit', '1000']);
  if (result.error || result.status !== 0) throw new Error(`gh label list failed: ${result.error ? redact(result.error.message) : brief(result)}`);
  let labels;
  try { labels = JSON.parse(result.stdout); } catch { throw new Error('gh label list returned text that is not JSON.'); }
  if (!Array.isArray(labels)) throw new Error('gh label list returned no list.');
  return labels;
}

// Sync the preset labels. run(args) is a gh runner. With dryRun the function calls no write command.
// Returns { lines, created, updated, unchanged }: one line for each label.
export function syncLabels(preset, run, { repo, dryRun = false } = {}) {
  const plan = planLabelSync(preset, listLabels(run, repo));
  const lines = [];
  const counts = { created: 0, updated: 0, unchanged: 0 };
  const prefix = dryRun ? 'would ' : '';
  for (const { action, label } of plan) {
    if (action === 'ok') { counts.unchanged += 1; lines.push(`ok ${label.name}`); continue; }
    if (!dryRun) {
      const args = action === 'create'
        ? buildGhLabelArgs('create', [label.name, '--color', label.color, '--description', label.description], { repo })
        : buildGhLabelArgs('edit', [label.name, '--color', label.color, '--description', label.description], { repo });
      const result = run(args);
      if (result.error || result.status !== 0) throw new Error(`gh label ${action} ${label.name} failed: ${result.error ? redact(result.error.message) : brief(result)}`);
    }
    if (action === 'create') counts.created += 1; else counts.updated += 1;
    lines.push(`${prefix}${action === 'create' ? 'create' : 'update'} ${label.name}`);
  }
  return { lines, ...counts };
}

// True when the labels of the preset are all present and equal. Read only.
export function labelsInSync(preset, run, repo) {
  return planLabelSync(preset, listLabels(run, repo)).every((step) => step.action === 'ok');
}
