// The factory role: the process runs as the factory user inside a factory container.
// The image holds the seed checkout of Herdr Boss at /opt/herdr-boss-seed. A Mac install has neither the home nor the seed.
import fs from 'node:fs';
import path from 'node:path';
import { prepareHarnessHome } from './factory-harness-state.js';

export const FACTORY_HOME = '/home/factory';
export const FACTORY_SEED = '/opt/herdr-boss-seed';
// The work volume of the factory. `project new` uses it when no --group or --path is given.
export const FACTORY_PROJECT_GROUP = `${FACTORY_HOME}/work`;
export const FACTORY_GIT_IDENTITY = Object.freeze({ 'user.name': 'Herdr Factory', 'user.email': 'factory@localhost.invalid' });

export function isTrustedFactoryProjectPath(value, { workRoot = FACTORY_PROJECT_GROUP, resolveSymlinks = true } = {}) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')
    || typeof workRoot !== 'string' || !path.isAbsolute(workRoot)) return false;
  let root = path.resolve(workRoot);
  let project = path.resolve(value);
  if (resolveSymlinks) {
    try {
      root = fs.realpathSync(workRoot);
      project = fs.realpathSync(value);
    } catch { return false; }
  }
  const relative = path.relative(root, project);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

export function factoryProjectWarning(project) {
  const slug = typeof project?.slug === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(project.slug) ? project.slug : 'unknown';
  return `project ${slug} is outside the work volume and is not trusted.`;
}

// Set the Git identity of the factory user once. An identity that exists stays as it is.
export async function ensureFactoryGitIdentity(docker, name) {
  for (const [key, value] of Object.entries(FACTORY_GIT_IDENTITY)) {
    const prefix = ['exec', '--user', 'factory', '--env', 'HOME=/home/factory', `hf-${name}`, 'git', 'config', '--global'];
    const current = await docker.run([...prefix, '--get', key]);
    if (current.code === 0 && current.stdout.trim()) continue;
    const set = await docker.run([...prefix, key, value]);
    if (set.code !== 0) throw new Error('The Git identity of the factory user could not be set. Check the factory configuration.');
  }
}

export function isFactoryRole(env = process.env, exists = fs.existsSync) {
  return env.HOME === FACTORY_HOME && exists(FACTORY_SEED);
}

// Mark a project folder as trusted for Claude and Codex, with the helper of `factory login`.
export function trustProjectFolder(folders, home) {
  const roots = [...new Set(folders)];
  for (const harness of ['claude', 'codex']) prepareHarnessHome(harness, roots, home);
}
