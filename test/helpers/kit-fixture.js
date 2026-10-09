import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadProjectConfig } from '../../src/kit/config.js';
import { readyAgent } from './ready-agent.js';

export const CLAUDE_READY_SCREEN = '────\n❯\n────\nauto mode';

export const CODEX_READY_SCREEN = '› Ask Codex to do anything\n? for shortcuts';

export const ALL_READY_SCREENS = `${CLAUDE_READY_SCREEN}\n${CODEX_READY_SCREEN}`;

export const tiers = ['unit', 'integration', 'local-browser', 'hosted', 'owner'];
export const validReport = {
  issue: 7,
  branch: 'kit-worker',
  worktree: '/tmp/kit-worker',
  changedPaths: ['src/a.js'],
  commands: [{ command: 'node --test test/', result: 'PASS' }],
  evidenceTier: ['unit'],
  unverified: [],
  stoppedEarly: false,
};
export const validRun = {
  issue: 7,
  model: 'gpt-6-luna',
  surface: 'herdr',
  worktree: '/tmp/kit-worker',
  startedAt: '2026-09-24T10:00:00.000Z',
  endedAt: '2026-09-24T10:10:00.000Z',
  outcome: 'done',
  timedOut: false,
  toolCalls: 0,
  changedPaths: ['src/a.js'],
  independentGate: { passed: true, command: 'node --test test/' },
  defectsFound: [],
  rework: [],
  evidenceTier: ['unit'],
};


// Worker worktrees default to ~/Projects/.herdr-wt. Keep them out of the real home folder.
export const TEST_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-kit-home-')));
process.env.HOME = TEST_HOME;
process.on('exit', () => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

export function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function temporaryRepo(prefix = 'herdr-kit-') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Test User');
  git(root, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(root, 'README.md'), 'seed\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-m', 'seed');
  return root;
}

export function setupFixture(setup) {
  const root = temporaryRepo();
  const template = path.join(root, 'brief-template.md');
  fs.writeFileSync(template, 'Worker {{name}}: {{task}} Inputs: {{copyPaths}}');
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ briefTemplate: template, setup }));
  const config = loadProjectConfig({ cwd: root });
  const rulesFile = path.join(root, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({ updatedAt: new Date().toISOString(), avoidKinds: [] }));
  const calls = [];
  let paneCwd = root;
  const herdr = (args) => {
    calls.push(args.slice(0, 2).join(' '));
    if (args[0] === 'pane' && args[1] === 'get') return args[2] === 'ws:orch'
      ? { pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } }
      : { pane: { pane_id: args[2], workspace_id: 'ws', foreground_cwd: paneCwd } };
    if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: { shell_pid: 10, foreground_process_group_id: 10 } };
    if (args[0] === 'pane' && args[1] === 'read') return { text: `% \n${ALL_READY_SCREENS}` };
    if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
    if (args[0] === 'tab' && args[1] === 'list') return { tabs: [{ tab_id: 'ws:t1', workspace_id: 'ws', label: 'Workers' }] };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [{ pane_id: 'ws:p1', workspace_id: 'ws', tab_id: 'ws:t1', width: 160, height: 45 }] };
    if (args[0] === 'pane' && args[1] === 'split') { paneCwd = args[args.indexOf('--cwd') + 1]; return { pane: { pane_id: 'ws:p2' } }; }
    if (args[0] === 'pane' && args[1] === 'close') return {};
    if (args[0] === 'agent' && args[1] === 'get') return readyAgent();
    if (args[0] === 'agent' && args[1] === 'read') return { text: ALL_READY_SCREENS };
    if (args[0] === 'agent' && (args[1] === 'start' || args[1] === 'prompt')) return {};
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const env = { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch' };
  return { root, config, rulesFile, calls, herdr, env };
}
