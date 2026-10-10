import { dockerCall } from './factory-core.js';

const SETUP = `
try {
  const { setupFactoryHarnessHome } = await import('/home/factory/herdr-boss/src/harness.js');
  const result = setupFactoryHarnessHome({ home: process.env.HOME });
  console.log(JSON.stringify(result));
} catch {
  console.log(JSON.stringify({ error: 'The factory harness setup failed. Check the harness settings inside the factory.' }));
}
`;
const ITEMS = ['Codex writable_roots', 'Codex rules', 'Claude autoMode', 'Pi guard'];

export async function syncFactoryHarness(docker, name, io) {
  let result;
  try {
    result = JSON.parse(await dockerCall(docker, ['exec', '--user', 'factory', '-e', 'HOME=/home/factory',
      `hf-${name}`, 'node', '--input-type=module', '-e', SETUP]));
  } catch (error) {
    const failure = new Error('The factory harness setup could not run. Check the factory connection.');
    if (error.code === 'FACTORY_HOST_UNREACHABLE') failure.code = error.code;
    throw failure;
  }
  if (!Array.isArray(result.changed) || result.changed.some(item => !ITEMS.includes(item))) throw new Error('The factory harness setup failed. Check the harness settings inside the factory.');
  io.stdout.write(`Harness setup: ${result.changed.length} changed${result.changed.length ? ` (${result.changed.join(', ')})` : ''}.\n`);
  return result;
}
