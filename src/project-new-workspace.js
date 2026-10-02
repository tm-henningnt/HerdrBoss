// Step `workspace` of `herdr-boss project new`: the Herdr workspace, the orchestrator pane, the agent, the goal, and the first prompt.
// The step spends model quota, so it runs only with --start. The flow state keeps the ids and one flag for each sent message,
// so a rerun creates no second workspace or pane and sends nothing twice.
import fs from 'node:fs';
import path from 'node:path';
import { loadPolicy } from './control.js';
import { cleanGoal, goalDelivery, goalPromptText, goalShown } from './goal.js';
import { handoffTarget, successorAgentArgs } from './handoff.js';
import { loadModels } from './kit/config.js';
import { agentReadyVisible, createHerdrRunner, deliverPrompt, isAgentPaneBusy, readAgentText, waitForAgentReady, waitForWorkerPane } from './kit/workers.js';
import { appendMessage } from './messages.js';
import { writeProject } from './projects.js';
import { TRUST_HARNESSES, hasTrustCue, matchTrustPrompt } from './trust-prompts.js';

const GOAL_CHECKS = 3;
const GOAL_CHECK_WAIT_MS = 2000;
const FIRST_TASK = 'Set up the project';
const TRUST_WINDOW_MS = 180_000;
const TRUST_POLL_MS = 2000;
const pauseMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const rows = (response, key) => (Array.isArray(response?.[key]) ? response[key] : Array.isArray(response) ? response : []);
const workspaceId = (workspace) => workspace?.workspace_id ?? workspace?.workspaceId ?? workspace?.id ?? null;
const paneId = (pane) => pane?.pane_id ?? pane?.paneId ?? pane?.id ?? null;
const paneOf = (response) => response?.pane ?? response;

export const orchestratorName = (slug) => `${slug}-orch`;

// The harness and model of the orchestrator: --kind with the model of the policy for that kind,
// else the first entry of orchestratorLadder that handoffTarget() accepts. Throws with the reason when none is usable.
export function pickOrchestrator({ kind = null, policy, models }) {
  if (kind) {
    if (!['claude', 'codex'].includes(kind)) throw new Error('--kind must be claude or codex.');
    try { return { kind, ...handoffTarget(kind, {}, policy, models) }; } catch (error) { throw new Error(`--kind ${kind}: ${error.message}`); }
  }
  const reasons = [];
  for (const rung of policy.orchestratorLadder || []) {
    try { return { kind: rung.kind, ...handoffTarget(rung.kind, { model: rung.model, effort: rung.effort }, policy, models) }; } catch (error) {
      reasons.push(`${rung.kind} ${rung.model}: ${error.message}`);
    }
  }
  throw new Error(`No entry of orchestratorLadder is usable. ${reasons.join(' ')}`.trim());
}

function loadTarget(context, kind) {
  const models = loadModels();
  const policy = loadPolicy({ file: path.join(context.dataDir, 'policy.json'), models, warn: () => {} });
  return { policy, target: pickOrchestrator({ kind, policy, models }) };
}

// The text of the dry run.
export function describeWorkspace(inputs, context) {
  if (!context.start) return 'skipped: no --start';
  let harness = '';
  try {
    const { target } = loadTarget(context, context.kind);
    harness = ` with ${target.kind} ${target.model}`;
  } catch (error) { harness = ` (no usable harness: ${error.message})`; }
  return `would create the Herdr workspace ${inputs.slug} in ${inputs.path}, label the root pane orch, start the agent ${orchestratorName(inputs.slug)}${harness}, deliver the goal, and send the first prompt`;
}

// The workspace of the state, else the only workspace with the label of the slug, else the one whose pane is in the folder.
function findWorkspace(herdr, recordedId, slug, cwd) {
  const workspaces = rows(herdr(['workspace', 'list']), 'workspaces');
  const recorded = recordedId && workspaces.find((w) => workspaceId(w) === recordedId);
  if (recorded) return workspaceId(recorded);
  const labeled = workspaces.filter((w) => w.label === slug);
  if (labeled.length <= 1) return labeled.length ? workspaceId(labeled[0]) : null;
  const inFolder = labeled.filter((w) => rows(herdr(['pane', 'list', '--workspace', workspaceId(w)]), 'panes').some((p) => (p.foreground_cwd ?? p.cwd) === cwd));
  if (inFolder.length === 1) return workspaceId(inFolder[0]);
  throw new Error(`More than one Herdr workspace has the label ${slug}. Close the extra workspaces, then run the flow again with --resume.`);
}

function findPane(herdr, ids, workspace) {
  if (ids.paneId) {
    try {
      const pane = paneOf(herdr(['pane', 'get', ids.paneId]));
      if (paneId(pane) === ids.paneId && (pane.workspace_id ?? pane.workspaceId) === workspace) return ids.paneId;
    } catch { /* The recorded pane is gone. Look in the workspace. */ }
  }
  const panes = rows(herdr(['pane', 'list', '--workspace', workspace]), 'panes');
  const pane = panes.find((p) => p.label === 'orch') ?? panes[0];
  if (!pane) throw new Error(`The Herdr workspace ${workspace} has no pane.`);
  return paneId(pane);
}

function firstPrompt({ slug, pane, boss, goal, kind }) {
  return `[herdr-boss] You are the orchestrator of the new project ${slug}. Your pane is ${pane}, labeled orch. ${boss ? `The Boss pane is ${boss}. ` : ''}`
    + 'Read AGENTS.md, docs/orchestration/memory.md, and docs/orchestration/herdr-boss.md. '
    + `Then start with the published task "${FIRST_TASK}".${goal ? `\n${goalPromptText({ goal, kind, autoCommand: false })}` : ''}`;
}

const TRUST_OPTION = { claude: 'Yes, I trust this folder', codex: 'Trust and continue' };

function trustItemText({ pane, kind, slug, folder }) {
  return [
    `Accept the folder trust prompt in pane ${pane} (the ${kind} agent of ${slug}): open the Agents page, choose the pane, and press Enter on "${TRUST_OPTION[kind]}".`,
    `Folder: ${folder}`,
    'Agents page: /agents',
  ].join('\n');
}

function trustTimeoutText({ pane, kind, slug }) {
  return [
    `The pane ${pane} (the ${kind} agent of ${slug}) may wait for input. It is not ready and not working after 3 minutes.`,
    'Open the Agents page, choose the pane, and answer the question in it.',
    'Agents page: /agents',
  ].join('\n');
}

// Watch the pane that this run created for a folder trust dialog. Herdr Boss never presses a key here.
// The wait is synchronous and can last 3 minutes. The API runs the flow in a child process (runFlowInChild in src/project-new-api.js),
// so the wait never blocks the dashboard server.
// The watch reads the pane by its id every 2 seconds. It stops when the agent shows its input prompt or works, or 3 minutes
// after the creation of the pane. The known dialog for exactly this folder gets one Mailbox item and one event.
// At the timeout, an agent that is neither ready nor working and had no known dialog gets one item that says the pane may wait.
function watchTrust({ name, pane, kind, slug, folder, since, herdr, hooks, context }) {
  const now = hooks.now ?? Date.now;
  const wait = hooks.wait ?? pauseMs;
  const deadline = since + TRUST_WINDOW_MS;
  let waited = 0;
  let detected = Boolean(context.ids.trustDetectedItem);
  const read = () => {
    try {
      const response = herdr(['pane', 'read', pane, '--source', 'recent-unwrapped', '--lines', '60', '--format', 'text']);
      return String(typeof response === 'string' ? response : response?.text ?? '');
    } catch { return ''; }
  };
  const working = () => {
    try { const status = herdr(['agent', 'get', name]); return (status?.agent ?? status)?.agent_status === 'working'; } catch { return false; }
  };
  const post = (text) => appendMessage({ thread: 'boss', from: 'boss', to: 'owner', kind: 'reply', text, action: 'answer', replyTo: null, status: 'new' }, { dir: context.dataDir }).id;
  for (;;) {
    const text = read();
    if (!hasTrustCue(text)) {
      if (agentReadyVisible(kind, text) || working()) return;
    } else if (!detected && matchTrustPrompt(kind, text, folder).match) {
      detected = true;
      context.remember({ trustDetectedItem: post(trustItemText({ pane, kind, slug, folder })) });
      try { fs.appendFileSync(path.join(context.dataDir, 'events.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), type: 'project-new', text: 'trust prompt detected', pane, folder, harness: kind })}\n`); } catch { /* The event log is not required for the flow. */ }
    }
    if (Math.max(now() - since, waited) >= TRUST_WINDOW_MS) break;
    const delay = Math.max(1, Math.min(TRUST_POLL_MS, deadline - now(), TRUST_WINDOW_MS - waited));
    wait(delay);
    waited += delay;
  }
  if (!detected && !context.ids.trustTimeoutItem) context.remember({ trustTimeoutItem: post(trustTimeoutText({ pane, kind, slug })) });
}

// Point the published status at the workspace. A status that does not exist yet is left alone.
function linkStatus(dataDir, slug, workspace) {
  const dir = path.join(dataDir, 'projects');
  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(dir, `${slug}.json`), 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (data.workspace === workspace) return;
  const errors = writeProject(slug, { ...data, workspace }, { dir });
  if (errors.length) throw new Error(`The status of ${slug} is not valid: ${errors.join(' ')}`);
}

// Run the step. context: start, kind, herdr (runner), hooks (tests replace the wait functions), env,
// dataDir, ids (the saved ids), remember(patch) (merge into ids and save the state at once).
export function workspaceStep(inputs, context) {
  if (!context.start) return { status: 'skipped', reason: 'no-start', detail: 'skipped: no --start' };
  const herdr = context.herdr ?? createHerdrRunner();
  const hooks = { waitForPane: waitForWorkerPane, waitForReady: waitForAgentReady, readText: readAgentText, ...context.hooks };
  const { policy, target } = loadTarget(context, context.kind);
  const cwd = fs.realpathSync(inputs.path);
  const name = orchestratorName(inputs.slug);
  const ids = context.ids;

  let workspace = findWorkspace(herdr, ids.workspaceId, inputs.slug, cwd);
  let created = null;
  if (!workspace) {
    const response = herdr(['workspace', 'create', '--cwd', cwd, '--label', inputs.slug, '--no-focus']);
    workspace = workspaceId(response?.workspace ?? response);
    if (!workspace) throw new Error('Herdr created a workspace but did not return its id. Inspect the Herdr workspaces, then run the flow again with --resume.');
    created = paneId(response?.root_pane ?? response?.pane);
  }
  // Another workspace than the recorded one: the old flags describe a pane that is gone.
  const createdAt = (hooks.now ?? Date.now)();
  if (ids.workspaceId !== workspace) context.remember({ workspaceId: workspace, paneId: created, agentStarted: false, kind: null, model: null, goalSent: false, goalVerified: false, promptSent: false, trustPane: created, trustSince: created ? createdAt : null, trustDone: false, trustDetectedItem: null, trustTimeoutItem: null });
  else if (created) context.remember({ paneId: created, trustPane: created, trustSince: createdAt, trustDone: false, trustDetectedItem: null, trustTimeoutItem: null });
  linkStatus(context.dataDir, inputs.slug, workspace);

  const pane = findPane(herdr, ids, workspace);
  if (ids.paneId !== pane) context.remember({ paneId: pane });
  const info = paneOf(herdr(['pane', 'get', pane]));
  if (info.label !== 'orch') herdr(['pane', 'rename', pane, 'orch']);

  let kind = info.agent || target.kind;
  if (!info.agent) {
    hooks.waitForPane(pane, workspace, cwd, herdr, hooks.wait);
    const launch = successorAgentArgs({ toKind: target.kind, project: inputs.slug, newPane: pane, newTab: info.tab_id ?? info.tabId, workspace },
      target.launchArgs, { ...(context.env ?? process.env), HERDR_BOSS_DIR: context.dataDir }, { browserLookup: hooks.browserLookup });
    try { herdr(['agent', 'start', name, '--kind', target.kind, '--pane', pane, '--', ...launch]); } catch (error) { if (!isAgentPaneBusy(error)) throw error; }
    context.remember({ agentStarted: true, kind: target.kind, model: target.model });
  } else if (!ids.kind) context.remember({ agentStarted: true, kind });
  kind = ids.kind || kind;

  // Only the pane that this run created, only for 3 minutes after its creation, only for a harness with a known dialog.
  if (ids.trustPane === pane && !ids.trustDone && TRUST_HARNESSES.includes(kind)) {
    watchTrust({ name, pane, kind, slug: inputs.slug, folder: cwd, since: ids.trustSince, herdr, hooks, context });
    context.remember({ trustDone: true });
  }

  const goal = cleanGoal(inputs.goal) ?? cleanGoal(policy.defaultOrchestratorGoal);
  const delivery = goalDelivery({ goal, kind, autoCommand: policy.goals.autoCommand });
  const settle = () => hooks.waitForReady(name, kind, { herdr, readText: hooks.readText, wait: hooks.wait });
  if (delivery === 'command') {
    if (!ids.goalSent) {
      settle();
      herdr(['agent', 'prompt', name, goalPromptText({ goal, kind, autoCommand: policy.goals.autoCommand })]);
      context.remember({ goalSent: true });
    }
    if (!ids.goalVerified) {
      let shown = false;
      for (let check = 1; check <= GOAL_CHECKS && !shown; check += 1) {
        try {
          const read = herdr(['pane', 'read', pane, '--source', 'visible', '--lines', '80', '--format', 'text']);
          shown = goalShown(typeof read === 'string' ? read : read?.text, goal);
        } catch { /* An unreadable pane counts as a goal that does not show yet. */ }
        if (!shown && check < GOAL_CHECKS) (hooks.wait ?? ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)))(GOAL_CHECK_WAIT_MS);
      }
      if (!shown) throw new Error(`The pane ${pane} does not show the /goal after ${GOAL_CHECKS} checks. Check the pane, then run the flow again with --resume. The goal is not sent again.`);
      context.remember({ goalVerified: true });
    }
  }
  if (!ids.promptSent) {
    if (!ids.goalSent) settle();
    let boss = null;
    try { boss = paneId(rows(herdr(['pane', 'list']), 'panes').find((p) => p.label === 'boss')); } catch { /* The prompt works without the Boss pane. */ }
    const text = firstPrompt({ slug: inputs.slug, pane, boss, goal: delivery === 'prompt' ? goal : null, kind });
    deliverPrompt(name, text, `orchestrator of the new project ${inputs.slug}`, { herdr, readText: hooks.readText, wait: hooks.wait, kind });
    context.remember({ promptSent: true });
  }
  return { detail: `workspace ${workspace}, pane ${pane}, agent ${name} (${kind}${ids.model ? ` ${ids.model}` : ''})` };
}
