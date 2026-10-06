// The host side of the CodexBar install step. It runs the container command as the factory user.
// It reads the pins file of this checkout and prints one fixed line. It never prints container output.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const PINS_FILE = fileURLToPath(new URL('../factory/pins.json', import.meta.url));
// The state words of the container command and the fixed reason of each one.
const REASONS = Object.freeze({
  installed: null,
  unchanged: null,
  'download-failed': 'download failed',
  'hash-mismatch': 'hash mismatch',
  'unsupported-architecture': 'unsupported architecture',
  'no-network': 'no network',
});

export function pinnedVersion(pins = PINS_FILE) {
  const version = JSON.parse(fs.readFileSync(pins, 'utf8'))?.codexbar;
  return typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version) ? version : null;
}

// Run `herdr-boss codexbar-install --apply` in the container. Returns the state word, or 'failed'.
// A failure never throws, so a service update goes on and keeps its exit code.
export async function ensureCodexbar(docker, name, io, { pins = PINS_FILE } = {}) {
  let word = 'failed';
  let reason = 'the step did not finish';
  let configInvalid = false;
  try {
    const result = await docker.run(['exec', '--user', 'factory', '-e', 'HOME=/home/factory', '--workdir', '/home/factory/herdr-boss', `hf-${name}`, 'herdr-boss', 'codexbar-install', '--apply']);
    const lines = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    configInvalid = lines.includes('config-invalid');
    const answer = lines[0] || '';
    if (result.code === 0 && Object.hasOwn(REASONS, answer)) word = answer;
    else reason = result.code === 0 ? 'the answer is not known' : `the command exited with ${result.code}`;
  } catch (error) { reason = String(error?.message || error).split('\n')[0]; }
  const version = pinnedVersion(pins);
  const text = !Object.hasOwn(REASONS, word) ? `not installed, ${reason}`
    : REASONS[word] ? `not installed, ${REASONS[word]}`
    : `installed ${version || 'the pinned version'}`;
  io.stdout.write(`CodexBar: ${text}.\n`);
  if (configInvalid) io.stdout.write('CodexBar config: invalid.\n');
  return word;
}
