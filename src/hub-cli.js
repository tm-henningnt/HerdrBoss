import { DATA_DIR, PRIVATE_ACCESS_DIR, loadConfig } from './config.js';
import { createFleetSettings } from './fleet-settings.js';
import { createFleetRole } from './fleet-role.js';

const USAGE = 'Usage: hub promote [--force]';
export async function hubCommand(args, { dir = DATA_DIR, privateDir = PRIVATE_ACCESS_DIR, stdout = process.stdout, fetchImpl = fetch, registryFile } = {}) {
  const [command, ...rest] = args;
  if (command !== 'promote' || rest.length > 1 || (rest.length && rest[0] !== '--force')) throw new Error(USAGE);
  const settings = createFleetSettings({ dir, cfg: loadConfig() });
  const role = createFleetRole({ dir, privateDir, settings: settings.read, fetchImpl, ...(registryFile ? { registryFile } : {}),
    enableHeadOffice: () => { const { factoryId, accounts, ...values } = settings.read(); settings.write({ ...values, headOffice: true }); } });
  const result = await role.promote({ force: rest.length === 1 });
  if (result.status === 'already-holder') {
    stdout.write(`This factory already holds the head office role at epoch ${result.epoch}. Nothing changed.\n`);
    return 0;
  }
  const lines = [`This factory holds the head office role at epoch ${result.epoch}.`,
    `Told: ${result.told.length ? result.told.join(', ') : 'no factory'}.`];
  if (result.pending.length) lines.push(`Not told: ${result.pending.map((row) => `${row.name} (${row.error})`).join(', ')}. Each one learns of the change at the next successful poll.`);
  lines.push({ received: 'Registry and factory shares: received from the former head office.',
    'kept-own-copy': 'Registry and factory shares: the former head office gave none. This factory keeps its own copy.',
    none: 'Registry and factory shares: no former head office is known. This factory keeps its own copy.' }[result.handover]);
  stdout.write(`${lines.join('\n')}\n`);
  return 0;
}
