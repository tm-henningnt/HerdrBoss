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
`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const cfg = loadConfig();
  switch (cmd) {
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
      console.log(`published http://${cfg.host}:${cfg.port}/p/${slug}`);
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

main().catch((e) => { console.error(e.message); process.exit(1); });
