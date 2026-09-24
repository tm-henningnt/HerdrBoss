#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadConfig, DATA_DIR } from './config.js';
import { writeProject } from './projects.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LABEL = 'no.tallmaker.herdr-boss';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

const USAGE = `herdr-boss <command>

  serve                 Run the collector loop and the dashboard server.
  tick [--json]         Collect once and print alerts. Sends nothing, terminates nothing.
  publish <slug> <file> Validate a project status file and install it. Use "-" for stdin.
  install               Install and start the launchd agent.
  uninstall             Stop and remove the launchd agent.
  logs                  Show the server log.
  policy show|set FILE  Show or replace the local resource policy.
  usage record FILE     Add measured or unmeasured project usage.
  usage summary         Summarize project and provider usage.
  browser request SLUG [--reserve]  Reserve or launch a persistent project browser.
  browser list          List registered browser sessions.
  handoff plan PANE --to KIND [--mode migrate|fresh]
  handoff prepare PANE --to KIND [--mode migrate|fresh]
  handoff activate ID --confirmed
  handoff ready ID      Signal automatic successor readiness.
  worker ...            Start, collect, or list workers.
  worktree prune        List safe worktree removals.
  ledger ...            Append or check delegated-run records.
  check ...             Validate worker handoffs and scope.
  gh issue ...          Run safe GitHub issue commands.
  models                Show allowed worker models.
  kit-path              Print the shared kit directory.
`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'kit-path') {
    const { KIT_ROOT } = await import('./kit/config.js');
    console.log(KIT_ROOT);
    return;
  }
  if (['worker', 'worktree', 'ledger', 'check', 'gh', 'models'].includes(cmd)) {
    const { runKitCommand } = await import('./kit/cli.js');
    runKitCommand(cmd, args);
    return;
  }
  const cfg = loadConfig();
  switch (cmd) {
    case 'policy': {
      const { loadPolicy, savePolicy } = await import('./control.js');
      if (args[0] === 'show' && args.length === 1) console.log(JSON.stringify(loadPolicy(), null, 2));
      else if (args[0] === 'set' && args.length === 2) {
        const { loadModels } = await import('./kit/config.js');
        const errors = savePolicy(JSON.parse(fs.readFileSync(args[1], 'utf8')), loadModels());
        if (errors.length) throw new Error(errors.join('\n'));
        console.log('Policy saved. The service will apply it on its next tick.');
      } else throw new Error('Usage: policy show | policy set FILE');
      break;
    }
    case 'usage': {
      const { recordUsage, usageSummary } = await import('./usage.js');
      if (args[0] === 'summary' && args.length === 1) console.log(JSON.stringify(usageSummary(), null, 2));
      else if (args[0] === 'record' && args.length === 2) {
        const result = recordUsage(JSON.parse(fs.readFileSync(args[1], 'utf8')));
        if (result.errors.length) throw new Error(result.errors.join('\n'));
        console.log(result.duplicate ? 'Usage event already recorded.' : 'Usage recorded.');
      } else throw new Error('Usage: usage record FILE | usage summary');
      break;
    }
    case 'browser': {
      const { requestBrowser, listBrowserSessions, browserStatus } = await import('./browser-pool.js');
      if (args[0] === 'list' && args.length === 1) console.log(JSON.stringify(await Promise.all(Object.values(listBrowserSessions()).map(browserStatus)), null, 2));
      else if (args[0] === 'request' && args[1] && (args.length === 2 || args[2] === '--reserve')) console.log(JSON.stringify(await requestBrowser(args[1], { launch: !args.includes('--reserve') }), null, 2));
      else throw new Error('Usage: browser request SLUG [--reserve] | browser list');
      break;
    }
    case 'handoff': {
      const { planHandoff, prepareHandoff, activateHandoff, markHandoffReady, listHandoffs } = await import('./handoff.js');
      const [action, target] = args;
      if (action === 'list') { console.log(JSON.stringify(listHandoffs(), null, 2)); break; }
      if (action === 'activate') { console.log(JSON.stringify(activateHandoff(target, { confirmed: args.includes('--confirmed') }), null, 2)); break; }
      if (action === 'ready') { console.log(JSON.stringify(markHandoffReady(target), null, 2)); break; }
      const value = (flag, fallback) => { const i = args.indexOf(flag); return i < 0 ? fallback : args[i + 1]; };
      const to = value('--to');
      if (!target || !to || !['plan', 'prepare'].includes(action)) throw new Error('Usage: handoff plan|prepare PANE --to KIND [--mode migrate|fresh] [--model MODEL]');
      const options = { mode: value('--mode', 'migrate'), model: value('--model', null), force: args.includes('--force'), auto: args.includes('--auto') };
      console.log(JSON.stringify(action === 'plan' ? planHandoff(target, to, options) : prepareHandoff(target, to, options), null, 2));
      break;
    }
    case 'serve': {
      const { serve } = await import('./server.js');
      serve(cfg);
      break;
    }
    case 'tick': {
      const { Engine } = await import('./engine.js');
      const snap = await new Engine(cfg, { push: false, act: false }).tick();
      if (args.includes('--json')) { console.log(JSON.stringify(snap, null, 2)); break; }
      for (const a of snap.advice) console.log(`ADVICE   ${a}`);
      for (const a of snap.alerts) console.log(`${a.severity.toUpperCase().padEnd(8)} [${a.scope}] ${a.text}`);
      if (!snap.alerts.length && !snap.advice.length) console.log('No alerts.');
      if (snap.errors.length) console.error('Errors:', snap.errors.join('; '));
      break;
    }
    case 'publish': {
      const [slug, file] = args;
      if (!slug || !file) { console.error('usage: herdr-boss publish <slug> <file|->'); process.exit(2); }
      const text = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
      const errors = writeProject(slug, JSON.parse(text));
      if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
      console.log(`published http://${cfg.host}:${cfg.port}/projects/${slug}`);
      break;
    }
    case 'install': {
      const node = process.execPath;
      const log = path.join(DATA_DIR, 'server.log');
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${node}</string><string>${path.join(ROOT, 'src', 'cli.js')}</string><string>serve</string></array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
      fs.mkdirSync(path.dirname(PLIST), { recursive: true });
      try { execFileSync('launchctl', ['bootout', `gui/${process.getuid()}`, PLIST], { stdio: 'ignore' }); } catch {}
      fs.writeFileSync(PLIST, plist);
      execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, PLIST]);
      console.log(`installed ${PLIST}\ndashboard http://${cfg.host}:${cfg.port}`);
      break;
    }
    case 'uninstall': {
      try { execFileSync('launchctl', ['bootout', `gui/${process.getuid()}`, PLIST], { stdio: 'ignore' }); } catch {}
      try { fs.unlinkSync(PLIST); } catch {}
      console.log('uninstalled');
      break;
    }
    case 'logs': {
      process.stdout.write(fs.readFileSync(path.join(DATA_DIR, 'server.log'), 'utf8').split('\n').slice(-100).join('\n'));
      break;
    }
    default:
      process.stdout.write(USAGE);
      process.exit(cmd ? 2 : 0);
  }
}

main().catch((e) => { console.error(e.message); process.exit(e.exitCode ?? 1); });
