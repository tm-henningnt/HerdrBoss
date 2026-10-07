import { verifyMessageCaller } from './messages.js';

// A terminal is the Owner. A Herdr pane must belong to the Boss or to a project lead.
export function verifyProjectCaller(env, herdr, command = 'project') {
  if (env.HERDR_ENV !== '1' && !env.HERDR_PANE_ID && !env.HERDR_WORKSPACE_ID) return { role: 'owner' };
  try { return verifyMessageCaller(env, herdr, command); } catch (error) {
    throw new Error(error.message.replace(' A worker does not message the Owner: ask your orchestrator with a WORKER QUESTION.', ' A worker asks its orchestrator.'));
  }
}
