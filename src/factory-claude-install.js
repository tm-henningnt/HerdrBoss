// The host side of the Claude usage helper. It runs the helper inside the factory container as the factory user.
// It never reads or writes a file of the Owner Mac. It prints a fixed line, never a file content.
const LINES = Object.freeze({
  installed: 'installed',
  unchanged: 'installed, no change',
  removed: 'removed, the setting is off',
  off: 'not installed, the setting is off',
  foreign: 'not installed, a statusLine from the Owner exists',
  unreadable: 'not installed, the settings file is unreadable',
});

// Returns the state word, or 'failed'. A failure never throws, so a service update goes on.
export async function ensureClaudeHelper(docker, name, io) {
  let word = 'failed';
  let reason = 'the step did not finish';
  try {
    const result = await docker.run(['exec', '--user', 'factory', '-e', 'HOME=/home/factory', '--workdir', '/home/factory/herdr-boss', `hf-${name}`, 'herdr-boss', 'claude-helper', '--apply']);
    const output = String(result.stdout || '').trim();
    if (result.code === 0 && Object.hasOwn(LINES, output)) word = output;
    else reason = result.code === 0 ? 'the answer is not known' : `the command exited with ${result.code}`;
  } catch (error) { reason = String(error?.message || error).split('\n')[0]; }
  io.stdout.write(`Claude usage helper: ${word === 'failed' ? `not applied, ${reason}` : LINES[word]}.\n`);
  return word;
}
