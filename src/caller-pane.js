export function getWorkspace(value) { return value.workspace_id ?? value.workspaceId ?? value.workspace ?? null; }
export function getPane(value) { return value.pane_id ?? value.paneId ?? value.id ?? null; }

function callerValidationError(reason) {
  return new Error(`Cannot verify the caller pane: ${reason} A shared Codex app-server daemon can pass another pane's environment. Pass explicit HERDR_PANE_ID and HERDR_WORKSPACE_ID values, or restart the Codex session. Do not stop the shared daemon.`);
}

export function verifyCallerPane(env, herdr, requestedOrch = null) {
  const paneId = env.HERDR_PANE_ID;
  if (!paneId) throw callerValidationError('HERDR_PANE_ID is required.');
  const workspaceId = env.HERDR_WORKSPACE_ID;
  if (!workspaceId) throw callerValidationError('HERDR_WORKSPACE_ID is required.');
  let response;
  try { response = herdr(['pane', 'get', paneId]); }
  catch (error) { throw callerValidationError(`Herdr could not read pane ${paneId}: ${error.message}`); }
  const pane = response?.pane ?? response;
  const returnedId = getPane(pane);
  if (returnedId !== paneId) throw callerValidationError(`The returned pane ID (${returnedId ?? '(missing)'}) differs from HERDR_PANE_ID (${paneId}).`);
  if (!['orch', 'boss'].includes(pane.label)) throw callerValidationError(`The caller pane label must be exactly orch or boss; received ${pane.label ?? '(missing)'}.`);
  const paneWorkspace = getWorkspace(pane);
  if (workspaceId !== paneWorkspace) throw callerValidationError(`HERDR_WORKSPACE_ID (${workspaceId}) differs from the pane workspace (${paneWorkspace ?? '(missing)'}).`);
  if (requestedOrch != null && requestedOrch !== returnedId) throw callerValidationError(`--orch must match the verified caller pane (${returnedId}).`);
  return { paneId: returnedId, workspaceId: paneWorkspace };
}
