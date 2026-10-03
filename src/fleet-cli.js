import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, PRIVATE_ACCESS_DIR, loadConfig, resolveAlias } from './config.js';
import { createFleetReadAccess, FLEET_READ_TOKEN } from './fleet-access.js';
import { createFleetSettings, validateFleetSettings } from './fleet-settings.js';
import { provisionAccount, validateAccounts } from './fleet-quotas.js';
import { readFleetFile, writeFleetFile } from './fleet-store.js';

const USAGE = 'Usage: fleet settings | fleet init --from-file FILE|- | fleet account --from-file FILE|- | fleet read-token rotate --out-file FILE | fleet read-token set FACTORY --from-file FILE|-';
async function input(file, stdin) {
  let bytes = 0, text = '';
  const stream = file === '-' ? stdin : fs.createReadStream(file);
  try {
    for await (const chunk of stream) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 16384) throw new Error('The private input exceeds 16 KB.');
      text += chunk;
    }
    return JSON.parse(text);
  } catch { throw new Error('The private input is not valid JSON or cannot be read.'); }
}
export async function fleetCommand(args, { dir = DATA_DIR, privateDir = PRIVATE_ACCESS_DIR, stdin = process.stdin, stdout = process.stdout } = {}) {
  const [command, ...rest] = args;
  if (command === 'settings' && !rest.length) {
    stdout.write(`${JSON.stringify(createFleetSettings({ dir, cfg: loadConfig() }).read(), null, 2)}\n`);
    return 0;
  }
  if (command === 'init' && rest.length === 2 && rest[0] === '--from-file') {
    const body = await input(rest[1], stdin);
    const { factoryId, ...settings } = body;
    if (typeof factoryId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(factoryId)) throw new Error('The factory identity is invalid.');
    const identityFile = path.join(dir, 'factory-identity.json');
    const { accounts, ...values } = settings;
    validateFleetSettings(values);
    if (accounts !== undefined) validateAccounts(accounts);
    const current = readFleetFile(identityFile, null);
    if (current && current.factoryId !== factoryId) throw new Error('The factory already has another identity.');
    // Validate all settings before publishing the identity.
    if (!current) writeFleetFile(identityFile, { factoryId });
    const draft = createFleetSettings({ dir, cfg: loadConfig() });
    draft.write(settings);
    stdout.write('Factory identity and fleet settings saved.\n');
    return 0;
  }
  if (command === 'account' && rest.length === 2 && rest[0] === '--from-file') {
    provisionAccount(await input(rest[1], stdin), { file: path.join(dir, 'fleet-accounts.json') });
    stdout.write('Account digest and scope saved.\n');
    return 0;
  }
  if (command === 'read-token' && rest[0] === 'rotate' && rest.length === 3 && rest[1] === '--out-file') {
    const file = path.resolve(rest[2]);
    const relative = path.relative(resolveAlias(privateDir), resolveAlias(file));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.existsSync(file)) throw new Error('Use a new export file inside the private Herdr Boss configuration folder.');
    const token = createFleetReadAccess({ privateDir }).rotate();
    writeFleetFile(file, token);
    stdout.write('Read credential rotated and saved to the private export file.\n');
    return 0;
  }
  if (command === 'read-token' && rest[0] === 'set' && rest.length === 4 && rest[2] === '--from-file') {
    const factoryId = rest[1];
    const token = await input(rest[3], stdin);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(factoryId) || typeof token !== 'string' || !FLEET_READ_TOKEN.test(token)) throw new Error('The factory identity or read credential is invalid.');
    const file = path.join(privateDir, 'fleet-remotes.json');
    const records = readFleetFile(file, {});
    records[factoryId] = token;
    writeFleetFile(file, records);
    stdout.write('Factory read credential saved.\n');
    return 0;
  }
  throw new Error(USAGE);
}
