// A fake gh for the label and milestone tests. It is an executable script that comes first in PATH.
// It logs each call as one JSON line. A file in the fake directory sets what it answers:
//   labels.json (label list), visibility (repo view), mode (ok, loggedout, failwrite).
import fs from 'node:fs';
import path from 'node:path';

const SCRIPT = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.FAKE_GH_DIR;
const read = (name, fallback) => { try { return fs.readFileSync(path.join(dir, name), 'utf8').trim(); } catch { return fallback; } };
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.log'), JSON.stringify({ args, cwd: process.cwd(), ghRepo: process.env.GH_REPO ?? null, ghHost: process.env.GH_HOST ?? null }) + '\\n');
const mode = read('mode', 'ok');
const token = process.env.FAKE_GH_TOKEN || '';
if (args[0] === 'auth' && args[1] === 'status') {
  if (mode === 'loggedout') { console.error('You are not logged in. ' + token); process.exit(1); }
  console.log('Logged in'); process.exit(0);
}
if (args[0] === 'repo' && args[1] === 'view') { console.log(read('visibility', 'PRIVATE')); process.exit(0); }
if (args[0] === 'label' && args[1] === 'list') { console.log(read('labels.json', '[]')); process.exit(0); }
if (args[0] === 'label' && (args[1] === 'create' || args[1] === 'edit')) {
  if (mode === 'failwrite') { console.error('HTTP 403: nope ' + token); process.exit(1); }
  console.log('done'); process.exit(0);
}
if (args[0] === 'api' && args[1] === 'user') { console.log('octo'); process.exit(0); }
if (args[0] === 'repo' && args[1] === 'create') {
  const { execFileSync } = require('node:child_process');
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/' + args[2] + '.git'], { cwd: args[args.indexOf('--source') + 1] });
  console.log('Created repository ' + args[2]); process.exit(0);
}
if (args[0] === 'api') { console.log('ok'); process.exit(0); }
console.error('fake gh: unexpected ' + args.join(' '));
process.exit(9);
`;

// Make the fake in dir. Returns { env(base), calls(), writes(), set(name, value) }.
export function makeFakeGh(dir, { token = 'unused' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  // The temporary folder of a worker is inside a package of type module. The fake is CommonJS.
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}\n');
  fs.writeFileSync(path.join(dir, 'gh'), SCRIPT, { mode: 0o755 });
  const clean = (base) => Object.fromEntries(Object.entries(base).filter(([key]) => !key.startsWith('HERDR_')));
  const calls = () => {
    try { return fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; }
  };
  return {
    dir,
    env: (base = process.env) => ({ ...clean(base), PATH: `${dir}${path.delimiter}${base.PATH}`, FAKE_GH_DIR: dir, FAKE_GH_TOKEN: token }),
    calls: () => calls().map((call) => call.args),
    envs: () => calls().map((call) => ({ ghRepo: call.ghRepo, ghHost: call.ghHost })),
    cwds: () => calls().map((call) => call.cwd),
    writes: () => calls().map((call) => call.args).filter((args) => (args[0] === 'label' && args[1] !== 'list') || (args[0] === 'api' && args[1] !== 'user') || (args[0] === 'repo' && args[1] === 'create')),
    set: (name, value) => fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value)),
  };
}
