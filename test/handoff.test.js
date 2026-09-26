import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('Boss handover planning uses the boss pane without a project control entry', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-boss-handoff-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const herdr = path.join(bin, 'herdr');
  fs.writeFileSync(herdr, `#!/usr/bin/env node
const args = process.argv.slice(2);
let result = {};
if (args[0] === 'pane' && args[1] === 'get') result = { pane: {
  pane_id: args[2], workspace_id: 'ws-boss', label: 'boss', agent: 'codex',
  cwd: process.env.TEST_BOSS_CWD, agent_session: { kind: 'id', value: 'boss-session' },
} };
if (args[0] === 'tab' && args[1] === 'create') result = { root_pane: { pane_id: 'ws-boss:p2' } };
if (args[0] === 'agent' && args[1] === 'get') result = { agent_status: 'working' };
console.log(JSON.stringify({ result }));
`);
  fs.chmodSync(herdr, 0o755);
  fs.mkdirSync(path.join(root, 'project'), { recursive: true });
  fs.writeFileSync(path.join(root, 'policy.json'), JSON.stringify({ projects: {} }));
  fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({ control: { projects: {}, risks: {} } }));
  const handoffUrl = new URL('../src/handoff.js', import.meta.url).href;
  const script = `import { planHandoff } from ${JSON.stringify(handoffUrl)};
console.log(JSON.stringify(planHandoff('ws-boss:p1', 'pi', { mode: 'fresh' })));`;
  const plan = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.join(root, 'project'),
    env: {
      ...process.env,
      HOME: root,
      HERDR_BOSS_DIR: root,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      TEST_BOSS_CWD: path.join(root, 'project'),
    },
    encoding: 'utf8',
  }));
  assert.equal(plan.boss, true);
  assert.equal(plan.project, 'Boss');
  assert.equal(plan.label, 'boss');
  assert.equal(plan.workspace, 'ws-boss');
  assert.equal(plan.sessionId, 'boss-session');
});
