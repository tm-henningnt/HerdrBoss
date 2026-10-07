import { verifyMessageCaller } from './messages.js';

// A terminal is the Owner. A Herdr pane must belong to the Boss or to a project lead.
export function verifyProjectCaller(env, herdr, command = 'project', { targetSlug = null, action = null } = {}) {
  if (env.HERDR_ENV !== '1' && !env.HERDR_PANE_ID && !env.HERDR_WORKSPACE_ID) return { role: 'owner' };
  let caller;
  try { caller = verifyMessageCaller(env, herdr, command); } catch (error) {
    throw new Error(error.message.replace(' A worker does not message the Owner: ask your orchestrator with a WORKER QUESTION.', ' A worker asks its orchestrator.'));
  }
  if (caller.role !== 'orch' || !targetSlug) return caller;

  let workspaces;
  try {
    const response = herdr(['workspace', 'list']);
    workspaces = Array.isArray(response?.workspaces) ? response.workspaces : Array.isArray(response) ? response : [];
  } catch (error) {
    throw new Error(`Cannot verify the project lead workspace: Herdr could not list workspaces: ${error.message}`);
  }
  const matches = workspaces.filter((workspace) => workspace?.label === targetSlug);
  const ownWorkspace = matches.length === 1
    ? matches[0].workspace_id ?? matches[0].workspaceId ?? matches[0].id ?? null
    : null;
  if (!ownWorkspace || ownWorkspace !== caller.workspaceId) {
    throw new Error(`Only the Boss or Owner can run herdr-boss ${command} for another project.`);
  }
  if (action === 'park') {
    throw new Error(`Only the Boss or Owner can park ${targetSlug}. A project lead cannot park its own workspace.`);
  }
  return caller;
}
