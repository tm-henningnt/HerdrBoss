// Remove smoke resources through the registered factory's Docker transport.
import { createInterface } from 'node:readline';
import { managedFactory, transportFor, inspect, assertOwned, dockerCall } from './factory-core.js';
import { assertName } from './factory-store.js';
import { FACTORY_PROJECT_GROUP } from './factory-role.js';

const USAGE = 'Use factory clean-smoke NAME [--dry-run] [--yes].';
const PREFIX = 'smoke-';
const parseJson = (text) => {
  try { return JSON.parse(text); } catch { throw new Error('The factory smoke inventory is invalid.'); }
};

// Run this same filesystem boundary for inventory, preflight, and removal.
// Each apply uses only the confirmed names. It checks all folders before removing any.
const folderScript = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const root = ${JSON.stringify(FACTORY_PROJECT_GROUP)};
const mode = process.argv[1];
const unsafe = () => { throw Object.assign(new Error(), { code: 'smoke-unsafe' }); };
try {
  for (let parent = root; ; parent = path.dirname(parent)) {
    if (fs.lstatSync(parent).isSymbolicLink()) unsafe();
    if (path.dirname(parent) === parent) break;
  }
  if (!fs.statSync(root).isDirectory() || fs.realpathSync(root) !== root) unsafe();
  const withinRoot = (file) => {
    const relative = path.relative(root, fs.realpathSync(file));
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) unsafe();
  };
  const checkTree = (file) => {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) unsafe();
    withinRoot(file);
    if (stat.isDirectory()) for (const entry of fs.readdirSync(file)) checkTree(path.join(file, entry));
  };
  if (mode === 'list') {
    const folders = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.name.startsWith('smoke-') && (entry.isDirectory() || entry.isSymbolicLink()))
      .map((entry) => entry.name).sort();
    process.stdout.write(JSON.stringify({ folders }));
  } else {
    if (!['check', 'remove'].includes(mode)) unsafe();
    const names = JSON.parse(fs.readFileSync(0, 'utf8'));
    if (!Array.isArray(names)) unsafe();
    const folders = [];
    for (const name of names) {
      if (typeof name !== 'string' || !name.startsWith('smoke-') || name !== path.basename(name) || name.includes('\0')) unsafe();
      const file = path.join(root, name);
      let stat;
      try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (stat.isSymbolicLink() || !stat.isDirectory()) unsafe();
      checkTree(file);
      folders.push(file);
    }
    if (mode === 'remove') for (const file of folders) { checkTree(file); fs.rmSync(file, { recursive: true }); }
    process.stdout.write(JSON.stringify({ count: folders.length }));
  }
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error.code === 'smoke-unsafe'
    ? 'A smoke folder has a symbolic link or resolves outside the work root. Cleanup refused.'
    : 'The factory smoke folders could not be inspected or removed.' }));
}
`;

async function folders(docker, record, mode, names = []) {
  const result = parseJson(await dockerCall(docker, ['exec', '-i', '--user', 'factory', record.containerName, 'node', '-e', folderScript, mode], { input: JSON.stringify(names) }));
  if (result.error) throw new Error(result.error);
  return result;
}

async function workspaces(docker, record) {
  const value = parseJson(await dockerCall(docker, ['exec', '--user', 'factory', '-e', 'HOME=/home/factory', record.containerName, 'herdr', 'workspace', 'list']));
  const rows = value.result?.workspaces ?? value.workspaces;
  if (!Array.isArray(rows)) throw new Error('The factory smoke workspace inventory is invalid.');
  const matches = rows.filter((row) => typeof row.label === 'string' && row.label.startsWith(PREFIX));
  if (matches.some((row) => typeof row.workspace_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(row.workspace_id))) {
    throw new Error('A smoke workspace has no valid ID. Cleanup refused.');
  }
  return matches.sort((a, b) => a.label.localeCompare(b.label));
}

async function confirm(name, io) {
  io.stdout.write(`Type clean-smoke ${name} to confirm: `);
  const lines = createInterface({ input: io.stdin, crlfDelay: Infinity });
  let answer;
  try { for await (const line of lines) { answer = line; break; } } finally { lines.close(); }
  if (answer !== `clean-smoke ${name}`) throw new Error('The typed smoke cleanup confirmation does not match.');
}

export async function factoryCleanSmokeCommand(args, io) {
  const names = args.filter((arg) => !arg.startsWith('--'));
  const flags = args.filter((arg) => arg.startsWith('--'));
  if (names.length !== 1 || flags.some((flag) => !['--dry-run', '--yes'].includes(flag)) || new Set(flags).size !== flags.length) throw new Error(USAGE);
  const name = names[0]; assertName(name);
  const { record, host } = managedFactory(io.env, name);
  const docker = transportFor(host, io);
  const container = await inspect(docker, 'container', record.containerName);
  assertOwned(container, name);
  if (!container.State?.Running || container.State?.Paused) throw new Error('The factory must be running and unpaused for smoke cleanup.');
  const selected = await workspaces(docker, record);
  const { folders: folderNames } = await folders(docker, record, 'list');
  if (!Array.isArray(folderNames) || folderNames.some((value) => typeof value !== 'string' || !value.startsWith(PREFIX))) throw new Error('The factory smoke folder inventory is invalid.');
  io.stdout.write(`Factory ${name} smoke cleanup:\nWorkspaces: ${selected.length}\n`);
  for (const workspace of selected) io.stdout.write(`  ${JSON.stringify(workspace.label)}\n`);
  io.stdout.write(`Folders: ${folderNames.length}\n`);
  for (const folder of folderNames) io.stdout.write(`  ${JSON.stringify(folder)}\n`);
  await folders(docker, record, 'check', folderNames);
  if (flags.includes('--dry-run')) { io.stdout.write('Dry run. No smoke resources changed.\n'); return 0; }
  if (!selected.length && !folderNames.length) { io.stdout.write('No smoke resources to remove.\n'); return 0; }
  if (!flags.includes('--yes')) await confirm(name, io);
  // A workspace renamed during confirmation no longer belongs to this cleanup.
  const current = await workspaces(docker, record);
  if (selected.some((row) => !current.some((item) => item.workspace_id === row.workspace_id && item.label === row.label))) {
    throw new Error('The smoke workspace inventory changed. Run clean-smoke again.');
  }
  await folders(docker, record, 'check', folderNames);
  for (const workspace of selected) {
    await dockerCall(docker, ['exec', '--user', 'factory', '-e', 'HOME=/home/factory', record.containerName, 'herdr', 'workspace', 'close', workspace.workspace_id]);
  }
  const removed = await folders(docker, record, 'remove', folderNames);
  io.stdout.write(`Removed ${selected.length} smoke workspaces and ${removed.count} smoke folders.\n`);
  return 0;
}
