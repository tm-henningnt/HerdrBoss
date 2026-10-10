import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Execute the factory script in a disposable home, with a different factory UID.
export function runFactoryHarness(args, env) {
  if (!args.includes('node')) return null;
  const script = args[args.indexOf('-e', args.indexOf('node')) + 1];
  if (!String(script).includes('setupFactoryHarnessHome')) return null;
  const local = fileURLToPath(new URL('../../src/harness.js', import.meta.url));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    'process.getuid = () => 2468;\n' + script.replace('/home/factory/herdr-boss/src/harness.js', local)], {
    env: { ...process.env, ...env }, encoding: 'utf8',
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}
