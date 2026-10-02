// Step `labels` of `herdr-boss project new` and the labels item of `herdr-boss project check`.
// The step sets the triage labels on a private GitHub repository through the label sync. It never deletes a label.
// It skips when there is no GitHub origin, when the repository is not private, and when gh is missing or not logged in.
// It never runs `gh auth login`. Every line of gh output passes through redact().
import { cleanGhEnv, ghRunner, labelsInSync, parseGithubRepo, syncLabels } from './gh-labels.js';
import { loadLabelPreset } from './kit/gh.js';
import { ghEnv, originUrl, redact, run } from './project-new-remote.js';

const PRESET = 'triage';

// The text of the dry run.
export function describeLabels(_inputs, context) {
  if ((context.remote ?? 'none') === 'none') return 'skipped: no remote';
  return `for a private GitHub repository, run gh label sync --preset ${PRESET}: create or edit the triage labels, never delete one; skip a public repository, a missing gh, and a missing gh login`;
}

// The gh state of a project: { skip } with a plain reason, { fail }, or { run, repo }.
// url is the raw origin URL. created is the name of a repository that the remote step created with gh.
// decided is the visibility that the wizard chose. It counts only when created names the repository of origin.
function inspect({ dir, url, created, decided, env, ghProbe = run }) {
  if (!url) return { skip: 'no remote' };
  const repo = parseGithubRepo(url);
  if (!repo) return { skip: 'the origin is not a GitHub repository' };
  const trusted = decided && created && String(created).toLowerCase() === repo.toLowerCase() ? decided : undefined;
  if (trusted && trusted !== 'private') return { skip: `the repository is ${trusted}, not private` };
  const clean = cleanGhEnv(env);
  const auth = ghProbe('gh', ['auth', 'status'], { cwd: dir, env: clean });
  if (auth.error?.code === 'ENOENT') return { skip: 'gh is not installed' };
  if (auth.status !== 0) return { skip: 'gh is not logged in' };
  const runGh = ghRunner({ cwd: dir, env: clean });
  let visibility = trusted;
  if (!visibility) {
    const view = runGh(['repo', 'view', repo, '--json', 'visibility', '--jq', '.visibility']);
    if (view.error || view.status !== 0) return { fail: `gh repo view failed: ${redact(`${view.stderr}${view.stdout}`).trim().split('\n').slice(0, 3).join(' ').slice(0, 400) || 'no message'}` };
    visibility = view.stdout.trim().toLowerCase();
  }
  if (visibility !== 'private') return { skip: `the repository is ${visibility || 'of unknown visibility'}, not private` };
  return { run: runGh, repo };
}

export function labelsStep(inputs, context) {
  const url = originUrl(inputs, context);
  const found = inspect({ dir: inputs.path, url, created: context.ids?.remoteCreated, decided: context.ids?.remoteDecision?.visibility, env: ghEnv(context), ghProbe: context.ghProbe });
  if (found.skip) return { status: 'skipped', detail: `skipped: ${found.skip}` };
  if (found.fail) throw new Error(found.fail);
  const result = syncLabels(loadLabelPreset(PRESET), found.run, { repo: found.repo });
  return { detail: `${PRESET} labels on the private repository: created ${result.created}, updated ${result.updated}, unchanged ${result.unchanged}`, lines: result.lines };
}

// The labels item of project check, or null when the check does not apply or gh cannot answer. Read only.
// url is the origin URL. state is the flow state, or null.
export function checkLabels({ dir, url, state, env }) {
  if (!dir || !url) return null;
  const found = inspect({ dir, url, created: state?.ids?.remoteCreated, decided: state?.ids?.remoteDecision?.visibility, env: { ...process.env, ...(env || {}) } });
  if (!found.run) return null;
  try {
    return labelsInSync(loadLabelPreset(PRESET), found.run, found.repo)
      ? { ok: true, detail: `${PRESET} labels present` }
      : { ok: false, detail: `the ${PRESET} labels are missing or differ: run herdr-boss gh label sync --preset ${PRESET}` };
  } catch { return null; }
}
