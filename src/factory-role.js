// The factory role: the process runs as the factory user inside a factory container.
// The image holds the seed checkout of Herdr Boss at /opt/herdr-boss-seed. A Mac install has neither the home nor the seed.
import fs from 'node:fs';
import { prepareHarnessHome } from './factory-harness-state.js';

export const FACTORY_HOME = '/home/factory';
export const FACTORY_SEED = '/opt/herdr-boss-seed';
// The work volume of the factory. `project new` uses it when no --group or --path is given.
export const FACTORY_PROJECT_GROUP = `${FACTORY_HOME}/work`;
export const FACTORY_GIT_IDENTITY = Object.freeze({ 'user.name': 'Herdr Factory', 'user.email': 'factory@localhost.invalid' });

export function isFactoryRole(env = process.env, exists = fs.existsSync) {
  return env.HOME === FACTORY_HOME && exists(FACTORY_SEED);
}

// Mark a project folder as trusted for Claude and Codex, with the helper of `factory login`.
export function trustProjectFolder(folders, home) {
  const roots = [...new Set(folders)];
  for (const harness of ['claude', 'codex']) prepareHarnessHome(harness, roots, home);
}
