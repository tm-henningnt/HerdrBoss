// Step `harness` of `herdr-boss project new` and the command `herdr-boss project check <slug>`.
// The check only reads. It reports one item for each part of a project and names the flow step that fixes the item.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DATA_DIR } from './config.js';
import { claudeLines, readProjectRepos, stripRemoteCredentials, syncCodex } from './harness.js';
import { HOOK_COMMAND, KIT_FILE, checkAgentsFile, installedKitRevision, kitRevision } from './kit/agents-check.js';
import { KIT_ROOT } from './kit/config.js';
import { SLUG } from './projects.js';
import { redact } from './project-new-remote.js';

export const CHECK_ITEMS = ['folder', 'agents', 'memory', 'kit', 'config', 'gitignore', 'commit', 'remote', 'policy', 'register', 'status', 'workspace', 'orchestrator', 'harness', 'browser'];
const CLAUDE_CLEAN = 'Claude autoMode: nothing to change.';
const BROWSER_TIMEOUT_MS = 60000;

const samePath = (a, b) => path.resolve(a) === path.resolve(b);
const first = (text) => redact(String(text ?? '')).trim().split('\n')[0].slice(0, 300);

function readJson(file) {
  try { return { value: JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (error) { return { error: error.code === 'ENOENT' ? 'missing' : 'not valid JSON' }; }
}

// The home folder of the harness step. The default data dir belongs to this account.
// Another data dir belongs to a test or a preview: it needs an explicit home, or the step does not run.
function harnessHome(context) {
  if (context.home) return path.resolve(context.home);
  return samePath(context.dataDir, DATA_DIR) ? os.homedir() : null;
}

// The text of the dry run.
export function describeHarness(_inputs, context) {
  if (!harnessHome(context)) return 'skipped: no home folder for this data dir';
  return 'run harness sync for the Codex writable roots with a backup, print the Claude autoMode lines without editing ~/.claude/settings.json, and reserve the project browser';
}

// Reserve the project browser with the command `browser request SLUG --reserve`. It launches no browser.
export function reserveBrowserCommand(slug, { dataDir, home }) {
  // The caller of project new is already verified. Without the pane variables the browser command does not check the pane again.
  const env = { ...process.env, HERDR_BOSS_DIR: dataDir, HOME: home };
  for (const name of ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID']) delete env[name];
  const run = spawnSync(process.execPath, [path.join(KIT_ROOT, 'src', 'cli.js'), 'browser', 'request', slug, '--reserve'], {
    env, encoding: 'utf8', timeout: BROWSER_TIMEOUT_MS,
  });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(first(run.stderr) || `the command exited with ${run.status}`);
  let port = null;
  try { port = JSON.parse(run.stdout).port ?? null; } catch { /* The port is only for the detail line. */ }
  return port ? `reserved port ${port}` : 'reserved';
}

// Run the step. context: dataDir, home, reserveBrowser(slug, { dataDir, home }) (tests replace it).
// A Codex root or a browser port that cannot be set is a warning. The Claude lines are for the Owner: nothing edits ~/.claude/settings.json.
export function harnessStep(inputs, context) {
  const home = harnessHome(context);
  if (!home) return { status: 'skipped', detail: 'skipped: no home folder for this data dir' };
  const lines = [];
  const parts = [];
  const codex = syncCodex({ home, dataDir: context.dataDir });
  if (codex.ok) parts.push(codex.changed ? `Codex writable roots: added ${codex.added.length}` : 'Codex writable roots present');
  else {
    parts.push('warning: Codex writable roots not set');
    lines.push(...codex.lines);
  }
  const claude = claudeLines({ home, dataDir: context.dataDir });
  if (claude[0] === CLAUDE_CLEAN) parts.push(CLAUDE_CLEAN.replace(/\.$/, ''));
  else {
    parts.push('Claude autoMode: needs Owner action, the lines are printed');
    lines.push(...claude);
  }
  try {
    parts.push(`browser ${(context.reserveBrowser ?? reserveBrowserCommand)(inputs.slug, { dataDir: context.dataDir, home })}`);
  } catch (error) { parts.push(`warning: browser not reserved: ${first(error.message)}`); }
  return { detail: parts.join('; '), lines };
}

function readState(dataDir, slug) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'flows', `${slug}.json`), 'utf8')); } catch { return null; }
}

const rows = (response, key) => (Array.isArray(response?.[key]) ? response[key] : Array.isArray(response) ? response : []);
const workspaceOf = (row) => row?.workspace_id ?? row?.workspaceId ?? row?.id ?? null;
const paneOf = (row) => row?.pane_id ?? row?.paneId ?? row?.id ?? null;

function git(dir, args) {
  const run = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : null;
}

// Check one project. Read only: no file is written, no step runs, Herdr gets list and get calls only.
// options: dataDir, home, herdr (runner, needed only for a project that the flow started).
export function checkProject(slug, options = {}) {
  if (!SLUG.test(String(slug))) throw new Error('The slug must match [a-z0-9][a-z0-9-]{0,63}.');
  const dataDir = path.resolve(options.dataDir || DATA_DIR);
  const home = options.home ? path.resolve(options.home) : os.homedir();
  const state = readState(dataDir, slug);
  const row = readProjectRepos(dataDir).find((entry) => entry.slug === slug);
  const dir = row?.repo ?? state?.inputs?.path ?? null;
  const items = [];
  const ok = (name, detail = '') => items.push({ name, ok: true, detail });
  const missing = (name, detail, fix = null) => items.push({ name, ok: false, detail, fix });
  const file = (relative) => path.join(dir ?? '', relative);
  const has = (relative) => Boolean(dir) && fs.existsSync(file(relative));
  const isRepo = Boolean(dir) && fs.existsSync(path.join(dir, '.git'));

  if (!dir) missing('folder', `no folder is known: ${slug} is not registered and has no flow state`);
  else if (!isRepo) missing('folder', `${dir} does not exist or is not a Git repository`, 'folder');
  else {
    const branch = git(dir, ['symbolic-ref', '--short', 'HEAD']);
    if (branch === 'main') ok('folder', dir);
    else missing('folder', `the branch is ${branch ?? 'not set'}, not main`);
  }

  if (!has('AGENTS.md')) missing('agents', 'AGENTS.md is missing', 'files');
  else {
    const result = checkAgentsFile(file('AGENTS.md'), { relative: 'AGENTS.md' });
    if (result.errors) missing('agents', `check agents reports ${result.errors} error(s): ${result.lines.find((line) => line.startsWith('error')) ?? result.summary}`, 'kit');
    else ok('agents');
  }

  if (has('docs/orchestration/memory.md')) ok('memory'); else missing('memory', 'docs/orchestration/memory.md is missing', 'files');

  if (!has(KIT_FILE)) missing('kit', `${KIT_FILE} is missing`, 'kit');
  else {
    const installed = installedKitRevision(dir);
    const settings = readJson(file('.claude/settings.json')).value;
    if (installed !== kitRevision()) missing('kit', `the kit revision is ${installed ?? 'unknown'}, the current revision is ${kitRevision()}`, 'kit');
    else if (!JSON.stringify(settings ?? {}).includes(JSON.stringify(HOOK_COMMAND).slice(1, -1))) missing('kit', 'the SessionStart hook is missing in .claude/settings.json', 'kit');
    else ok('kit', installed);
  }

  if (!has('.herdr-boss.json')) missing('config', '.herdr-boss.json is missing', 'files');
  else {
    const config = readJson(file('.herdr-boss.json'));
    if (config.error) missing('config', `.herdr-boss.json is ${config.error}. Correct it by hand`);
    else if (!config.value || typeof config.value !== 'object' || Array.isArray(config.value) || config.value.slug !== slug) missing('config', `the slug in .herdr-boss.json is not ${slug}. Correct it by hand`);
    else ok('config');
  }

  if (has('.gitignore')) ok('gitignore'); else missing('gitignore', '.gitignore is missing', 'files');

  if (isRepo && git(dir, ['rev-parse', '--verify', '-q', 'HEAD'])) ok('commit', git(dir, ['rev-parse', '--short', 'HEAD']));
  else missing('commit', 'the project has no commit', 'commit');

  const origin = isRepo ? git(dir, ['remote', 'get-url', 'origin']) : null;
  const recorded = state?.steps?.remote;
  if (origin) ok('remote', `origin ${stripRemoteCredentials(origin)}`);
  else if (recorded?.status === 'skipped') ok('remote', `none recorded: ${recorded.detail}`);
  else missing('remote', 'the project has no origin and the state does not record none', 'remote');

  const policy = readJson(path.join(dataDir, 'policy.json')).value;
  if (policy?.projects && Object.hasOwn(policy.projects, slug)) ok('policy', `share ${policy.projects[slug].share}`);
  else missing('policy', `the policy has no entry for ${slug}`, 'policy');

  if (row) ok('register'); else missing('register', `project-repos.json has no row for ${slug}`, 'register');

  const status = readJson(path.join(dataDir, 'projects', `${slug}.json`));
  if (status.error) missing('status', `${slug} has no published status`, 'status');
  else if (!Array.isArray(status.value.tasks) || !status.value.tasks.length) missing('status', 'the published status has no task', 'status');
  else ok('status', `${status.value.tasks.length} task(s)`);

  const started = state?.steps?.workspace?.status === 'done';
  if (!started) {
    ok('workspace', 'not started: the flow ran without --start');
    ok('orchestrator', 'not started: the flow ran without --start');
  } else {
    let workspaces = null;
    let panes = [];
    let agents = [];
    let problem = null;
    try {
      const herdr = options.herdr;
      if (!herdr) throw new Error('no Herdr runner');
      workspaces = rows(herdr(['workspace', 'list']), 'workspaces');
      const found = workspaces.find((w) => (state.ids?.workspaceId && workspaceOf(w) === state.ids.workspaceId) || w.label === slug);
      if (found) {
        panes = rows(herdr(['pane', 'list', '--workspace', workspaceOf(found)]), 'panes');
        agents = rows(herdr(['agent', 'list']), 'agents');
      }
    } catch (error) { problem = `cannot read Herdr: ${first(error.message)}`; }
    const found = workspaces?.find((w) => (state.ids?.workspaceId && workspaceOf(w) === state.ids.workspaceId) || w.label === slug);
    if (problem) { missing('workspace', problem, 'workspace'); missing('orchestrator', problem, 'workspace'); }
    else if (!found) { missing('workspace', `Herdr has no workspace labeled ${slug}`, 'workspace'); missing('orchestrator', 'there is no workspace', 'workspace'); }
    else {
      const id = workspaceOf(found);
      if (status.value?.workspace && status.value.workspace !== id) missing('workspace', `the status names the workspace ${status.value.workspace}, Herdr has ${id}`, 'workspace');
      else ok('workspace', id);
      const pane = panes.find((p) => p.label === 'orch');
      const agent = pane && agents.find((a) => paneOf(a) === paneOf(pane));
      const expected = `${slug}-orch`;
      const name = agent?.name ?? agent?.agent_name ?? null;
      if (!pane) missing('orchestrator', `workspace ${id} has no pane labeled orch`, 'workspace');
      else if (!agent) missing('orchestrator', `the pane ${paneOf(pane)} has no agent`, 'workspace');
      else if (name !== expected) missing('orchestrator', `the agent is named ${name ?? '(unknown)'}, not ${expected}. Run herdr agent rename ${paneOf(pane)} ${expected}`);
      else ok('orchestrator', paneOf(pane));
    }
  }

  const codex = syncCodex({ home, dataDir, dryRun: true });
  if (!codex.ok) missing('harness', `Codex writable_roots are not set: ${first(codex.lines[0])}`, 'harness');
  else if (codex.added.length) missing('harness', `Codex writable_roots lack ${codex.added.length} path(s)`, 'harness');
  else ok('harness');

  const sessions = readJson(path.join(dataDir, 'browser-sessions.json')).value;
  if (sessions && Object.hasOwn(sessions, slug)) ok('browser', `port ${sessions[slug].port}`);
  else missing('browser', `no browser reservation for ${slug}`, 'harness');

  return { slug, path: dir, items, ok: items.every((item) => item.ok) };
}

// The printed lines of a check: one line for each item, then one summary line.
export function formatCheck(check) {
  const lines = [`Project ${check.slug}${check.path ? `: ${check.path}` : ''}`];
  for (const item of check.items) {
    const text = item.ok
      ? `ok${item.detail ? `: ${item.detail}` : ''}`
      : `missing: ${item.detail} (${item.fix ? `fix: herdr-boss project check ${check.slug} --fix ${item.fix}` : 'fix by hand'})`;
    lines.push(`  ${item.name.padEnd(13)}${text}`);
  }
  const bad = check.items.filter((item) => !item.ok).length;
  lines.push(bad ? `${bad} of ${check.items.length} items missing.` : `All ${check.items.length} items present.`);
  return lines;
}
