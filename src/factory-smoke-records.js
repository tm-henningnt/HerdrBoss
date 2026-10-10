import fs from 'node:fs';
import path from 'node:path';
import { readProjectRepos, unregisterProjectRepo } from './harness.js';
import { pinnedProjects, unpinProject } from './git-pins.js';
import { readRegister, writeRegister, withRegisterLock } from './project-register.js';
import { readDataFile, writeDataFile } from './data-file-safety.js';

const smoke = slug => typeof slug === 'string' && /^smoke-[a-z0-9-]*$/.test(slug) && slug.length <= 64;
const read = (file, dataDir) => {
  try { return JSON.parse(readDataFile(file, dataDir)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

// This boundary runs inside factory exec. It returns confirmed slugs and counts only.
export function cleanupSmokeProjectRecords(mode, names = [], { home = process.env.HOME,
  dataDir = process.env.HERDR_BOSS_DIR || path.join(home, '.herdr-boss'), workRoot = path.join(home, 'work') } = {}) {
  if (!['list', 'check', 'remove'].includes(mode) || !Array.isArray(names) || names.some(slug => !smoke(slug))) throw new Error('Invalid smoke cleanup request.');
  const repos = readProjectRepos(dataDir), pins = pinnedProjects({ home }), register = readRegister(dataDir);
  const policyFile = path.join(dataDir, 'policy.json'), rulesFile = path.join(dataDir, 'rules.json');
  const policy = read(policyFile, dataDir), rules = read(rulesFile, dataDir);
  const found = new Set([...repos, ...pins, ...register.projects].map(row => row.slug).filter(smoke));
  for (const projects of [policy?.projects, rules?.control?.projects]) for (const slug of Object.keys(projects || {})) if (smoke(slug)) found.add(slug);
  for (const folder of ['projects', 'flows']) {
    try { for (const file of fs.readdirSync(path.join(dataDir, folder))) if (file.endsWith('.json') && smoke(file.slice(0, -5))) found.add(file.slice(0, -5)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const row of [...repos, ...pins, ...register.projects].filter(row => found.has(row.slug) && row.repo)) {
    if (path.resolve(row.repo) !== path.join(path.resolve(workRoot), row.slug)) throw new Error('A smoke registration is outside the work root. Cleanup refused.');
  }
  const projects = [...found].sort();
  if (mode === 'list') return { projects };
  if (JSON.stringify([...names].sort()) !== JSON.stringify(projects)) throw new Error('The smoke project inventory changed. Run clean-smoke again.');
  if (mode === 'check') return { count: names.length };
  withRegisterLock(dataDir, () => {
    const current = readRegister(dataDir);
    const kept = current.projects.filter(row => !names.includes(row.slug));
    if (kept.length !== current.projects.length) writeRegister({ ...current, projects: kept }, dataDir);
  });
  for (const slug of names) {
    unpinProject(slug, { home });
    unregisterProjectRepo(slug, { dataDir });
    for (const folder of ['projects', 'flows']) fs.rmSync(path.join(dataDir, folder, `${slug}.json`), { force: true });
    if (policy?.projects) delete policy.projects[slug];
    if (rules?.control?.projects) delete rules.control.projects[slug];
  }
  if (policy) writeDataFile(policyFile, `${JSON.stringify(policy)}\n`, dataDir);
  if (rules) writeDataFile(rulesFile, `${JSON.stringify(rules)}\n`, dataDir);
  return { count: names.length };
}
