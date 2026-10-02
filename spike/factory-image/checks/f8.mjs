import { listCwdProcesses } from '/home/factory/herdr-boss/src/kit/workers.js';
import * as collect from '/home/factory/herdr-boss/src/collect.js';
import { execFileSync } from 'node:child_process';
const t = (name, fn) => Promise.resolve().then(fn).then((r) => console.log('PASS', name, r ?? ''), (e) => console.log('FAIL', name, String(e.message).split('\n')[0].slice(0, 120)));
await t('listCwdProcesses (lsof -a -d cwd -FpcnR)', () => `${listCwdProcesses().length} procs`);
await t('checkMachineTools(linux)', async () => JSON.stringify(await collect.checkMachineTools({ platform: 'linux' })));
await t('collectCwdProcesses', async () => `${(await collect.collectCwdProcesses()).length ?? '?'} items`);
for (const [cmd, args] of [['ps', ['-Ao', 'pid=,ppid=,etime=,pcpu=,rss=,command=']], ['ps', ['-axo', 'pid=,lstart=,comm=']], ['ps', ['-o', 'lstart=', '-p', '1']], ['ps', ['-o', 'stat=', '-o', 'lstart=', '-p', '1']], ['lsof', ['-a', '-p', String(process.pid), '-d', 'txt', '-Fn']], ['memory_pressure', []], ['sysctl', ['-n', 'vm.swapusage']], ['ioreg', ['-c', 'IOHIDSystem']], ['codexbar', ['usage', '--format', 'json']], ['launchctl', ['list']], ['/usr/bin/google-chrome', ['--version']]])
  await t(`${cmd} ${args.slice(0, 2).join(' ')}`, () => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').length + ' lines');
