import { verifyNightCaller } from './cli.js';
import { hasHerdrPaneVariables, probeTerminalRefusal, writeAccountProbe } from '../scripts/account-probe.mjs';

export async function accountProbeCommand(args, io) {
  if (args.length !== 1 || args[0] !== 'probe') {
    io.stderr.write('Usage: herdr-boss account probe\n');
    return 1;
  }
  let caller;
  try {
    let herdr = io.herdr;
    if (!herdr && hasHerdrPaneVariables(io.env) && io.env.HERDR_PANE_ID && io.env.HERDR_WORKSPACE_ID) {
      const { createHerdrRunner } = await import('./kit/workers.js');
      herdr = createHerdrRunner();
    }
    caller = await verifyNightCaller(io.env, herdr);
  } catch { caller = null; }
  // The shared guard also catches an empty marker or HERDR_WORKTREE, which verifyNightCaller permits.
  const refusal = probeTerminalRefusal(io);
  if (refusal) return refusal;
  if (caller?.role !== 'owner') {
    io.stderr.write('Run account probe at an Owner terminal. The caller is not verified.\n');
    return 3;
  }
  return writeAccountProbe(io);
}
