import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DATA_DIR } from './config.js';
import { loadModels } from './kit/config.js';
import { loadPolicy, providerFor } from './control.js';

const FILE = path.join(DATA_DIR, 'handoffs.json');
const TARGETS = new Set(['codex', 'claude', 'pi', 'opencode']);

function call(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
}
function herdr(args) {
  const response = JSON.parse(call('herdr', args));
  if (response.error) throw new Error(response.error.message || String(response.error));
  return response.result;
}
function readFile(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } }
function save(items) { const tmp = `${FILE}.${process.pid}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify(items, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, FILE); }
export function listHandoffs() { return readFile(FILE, []); }

function sourcePane(id, { allowStopped = false } = {}) {
  const pane = herdr(['pane', 'get', id]).pane;
  if (!pane || !['orch', 'boss'].includes(pane.label) || (!pane.agent && !allowStopped)) throw new Error('Source must be a labeled orchestrator or Boss pane.');
  return pane;
}

export function planHandoff(id, toKind, { mode = 'migrate', model = null, force = false } = {}) {
  if (!TARGETS.has(toKind)) throw new Error(`Unsupported target kind: ${toKind}.`);
  if (!['migrate', 'fresh'].includes(mode)) throw new Error('mode must be migrate or fresh.');
  const pane = sourcePane(id, { allowStopped: mode === 'fresh' });
  const models = loadModels().kinds;
  const targetModel = model || models[toKind].defaultModel;
  const policy = loadPolicy();
  if (!policy.allowedKinds.includes(toKind) || policy.excludedModels.includes(targetModel)) throw new Error('Target is disabled by global policy.');
  if (!models[toKind].allowedModels.includes(targetModel)) throw new Error('Target model is not in the allow-list.');
  const state = readFile(path.join(DATA_DIR, 'state.json'), {});
  const project = Object.values(state.control?.projects || {}).find((p) => p.workspace === pane.workspace_id);
  const slug = project?.slug || path.basename(pane.cwd).toLowerCase();
  const settings = policy.projects[slug];
  if (settings?.excludedKinds?.includes(toKind) || settings?.excludedModels?.includes(targetModel)) throw new Error('Target is excluded for this project.');
  const provider = providerFor(toKind, targetModel);
  if (!force && provider && state.control?.risks?.[provider]) throw new Error(`${provider} is near exhaustion; use another target or --force.`);
  const sessionId = pane.agent_session?.kind === 'id' ? pane.agent_session.value : null;
  const result = { sourcePane: id, workspace: pane.workspace_id, cwd: pane.cwd, project: slug, label: pane.label, fromKind: pane.agent, sessionId, toKind, model: targetModel, mode, provider, migration: null };
  if (mode === 'migrate') {
    if (!sessionId) result.migration = { available: false, error: 'Herdr has no native session ID for this pane.' };
    else if (!['codex', 'claude'].includes(toKind)) result.migration = { available: false, error: 'Automated resume is available for Codex and Claude targets. Use fresh mode for other kinds.' };
    else try {
      const r = JSON.parse(call('session-migrate', ['transfer', sessionId, '--from', pane.agent, '--to', toKind, '--cwd', pane.cwd, '--dry-run'], pane.cwd));
      result.migration = { available: true, records: r.records, droppedEvents: r.dropped_events, warnings: r.warnings?.length || 0 };
    } catch (e) { result.migration = { available: false, error: String(e.stderr || e.message).trim().slice(0, 500) }; }
  }
  return result;
}

export function prepareHandoff(id, toKind, options = {}) {
  if (listHandoffs().some((x) => x.sourcePane === id && ['prepared', 'preparing', 'needs-inspection'].includes(x.status))) throw new Error('A successor already exists for this orchestrator. Inspect it before preparing another.');
  const plan = planHandoff(id, toKind, options);
  if (plan.mode === 'migrate' && !plan.migration?.available) throw new Error(`Session migration is unavailable: ${plan.migration?.error}. Use --mode fresh.`);
  const policy = loadModels().kinds[toKind];
  const launchArgs = policy.launchArgs.map((arg) => arg.replaceAll('{{model}}', plan.model).replaceAll('{{effort}}', policy.defaultEffort || ''));
  let migratedId = null;
  if (plan.mode === 'migrate') {
    const r = JSON.parse(call('session-migrate', ['transfer', plan.sessionId, '--from', plan.fromKind, '--to', toKind, '--cwd', plan.cwd], plan.cwd));
    migratedId = r.session_id;
    if (!migratedId) throw new Error('session-migrate did not return a target session ID.');
  }
  const name = `handoff-${plan.project}`.slice(0, 23) + `-${Date.now().toString(36).slice(-6)}`;
  const created = herdr(['tab', 'create', '--workspace', plan.workspace, '--label', 'Orchestrator Next', '--cwd', plan.cwd, '--no-focus']);
  const newPane = created.root_pane?.pane_id;
  if (!newPane) throw new Error('Herdr created a tab but did not return its root pane. Inspect the tab before retrying.');
  const item = { ...plan, id: name, newPane, migratedId, status: 'preparing', preparedAt: new Date().toISOString(), automatic: options.auto === true };
  const records = listHandoffs(); records.push(item); save(records);
  const args = migratedId && toKind === 'codex' ? ['resume', migratedId, ...launchArgs]
    : migratedId && toKind === 'claude' ? ['--resume', migratedId, ...launchArgs]
      : launchArgs;
  try { herdr(['agent', 'start', name, '--kind', toKind, '--pane', newPane, '--', ...args]); }
  catch (e) { item.status = 'needs-inspection'; item.promptError = e.message; save(records); throw new Error(`Successor may be in ${newPane}. Inspect it before retrying: ${e.message}`); }
  item.status = 'prepared'; save(records);
  const prompt = `[herdr-boss] You are the proposed successor orchestrator for ${plan.project}. Read the project AGENTS.md, Herdr Boss bulletin, and source pane ${id} with herdr agent read. ${migratedId ? 'Your session was migrated; verify the current repo and tool state because runtime config did not transfer.' : 'Discover the project state from files, issues and the source pane.'} Do not dispatch workers yet. When ready, write READY FOR HANDOFF and summarize current work, active workers, blockers, quotas, and the next action.${item.automatic ? ` Then run herdr-boss handoff ready ${name} to signal readiness for automatic activation.` : ''} The source orchestrator keeps control until activation.`;
  try { herdr(['agent', 'prompt', name, prompt, '--wait', '--timeout', '20000']); }
  catch (e) { item.promptError = e.message; save(records); }
  return item;
}

export function markHandoffReady(id) {
  const records = listHandoffs();
  const item = records.find((x) => x.id === id && x.status === 'prepared' && x.automatic);
  if (!item) throw new Error('Automatic prepared handoff not found.');
  const target = herdr(['pane', 'get', item.newPane]).pane;
  if (target?.agent !== item.toKind) throw new Error('Successor agent is unavailable.');
  item.readyAt = new Date().toISOString();
  delete item.promptError;
  save(records);
  return item;
}

export function activateHandoff(id, { confirmed = false } = {}) {
  if (!confirmed) throw new Error('Review the successor output, then pass --confirmed.');
  const records = listHandoffs();
  const item = records.find((x) => x.id === id && x.status === 'prepared');
  if (!item) throw new Error('Prepared handoff not found.');
  const target = herdr(['pane', 'get', item.newPane]).pane;
  if (target?.agent !== item.toKind || !['idle', 'done'].includes(target.agent_status)) throw new Error('Successor is not settled and ready.');
  const oldLabel = item.label;
  herdr(['pane', 'rename', item.sourcePane, 'standby']);
  try { herdr(['pane', 'rename', item.newPane, oldLabel]); }
  catch (e) { try { herdr(['pane', 'rename', item.sourcePane, oldLabel]); } catch {} throw e; }
  item.status = 'active'; item.activatedAt = new Date().toISOString();
  try {
    item.peerPanes = herdr(['pane', 'list']).panes
      .filter((pane) => pane.workspace_id === item.workspace && pane.pane_id !== item.newPane && pane.agent)
      .map((pane) => pane.pane_id);
  } catch { item.peerPanes = [item.sourcePane]; }
  save(records);
  const roster = item.peerPanes.length ? ` Existing agent panes in your workspace: ${item.peerPanes.join(', ')}.` : ' No other agents remain in your workspace.';
  try { herdr(['agent', 'prompt', item.newPane, `[herdr-boss] Handover activated. You now control this project.${roster} The previous orchestrator pane ${item.sourcePane} is standby. Read the current Herdr Boss bulletin, check each agent's work, and resume orchestration within the current policy.`]); }
  catch (e) { item.activationPromptError = String(e.stderr || e.message).slice(0, 500); save(records); }
  return item;
}
