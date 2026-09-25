#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { loadConfig, DATA_DIR, dashboardUrl } from './config.js';
import { writeProject, SLUG } from './projects.js';

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
  lanes                 Print one line per quota provider: open, ahead of pace, or near exhaustion.
  scratch SLUG          Create the durable scratch folder of a project and print its path.
  policy show|set FILE  Show or replace the local resource policy.
  usage record FILE     Add measured or unmeasured project usage.
  usage summary         Summarize project and provider usage.
  browser request SLUG [--reserve] [--headless|--visible]  Reserve or launch a persistent project browser.
  browser size SLUG WIDTH HEIGHT  Save window size for the next browser launch.
  browser close SLUG      Gracefully close a managed browser, keeping its profile.
  browser restart SLUG --headless|--visible [--no-restore]  Switch mode and restore the current page.
  browser list          List registered browser sessions.
  browser tabs SLUG      List the pages, their visibility, and whether an agent is attached.
  browser tab new SLUG [URL]  Open a tab in its own background window and print its ID.
  browser tab close SLUG --tab ID [--force]  Close a tab; refuses a tab an agent is attached to.
  browser screenshot SLUG [--tab ID]  Save a private JPEG and print its path.
  browser navigate SLUG URL [--tab ID]  Open an HTTP(S) page.
  browser click SLUG X% Y% [--tab ID]  Click at screenshot-relative percentages.
  browser text SLUG --stdin [--tab ID]  Send text from standard input without echoing it.
  browser key SLUG KEY [--tab ID]  Send Tab, Enter, Backspace, arrow keys, etc.
  handoff plan PANE --to KIND [--mode migrate|fresh] [--model MODEL] [--effort EFFORT]
  handoff prepare PANE --to KIND [--mode migrate|fresh] [--model MODEL] [--effort EFFORT]
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
  if (cmd === 'scratch') {
    if (args.length !== 1 || !SLUG.test(args[0])) throw new Error('Usage: scratch <slug>. The slug must match [a-z0-9][a-z0-9-]*.');
    const dir = path.join(DATA_DIR, 'scratch', args[0]);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    console.log(path.resolve(dir));
    return;
  }
  if (['worker', 'worktree', 'ledger', 'check', 'gh', 'models'].includes(cmd)) {
    const { runKitCommand } = await import('./kit/cli.js');
    runKitCommand(cmd, args);
    return;
  }
  const cfg = loadConfig();
  switch (cmd) {
    case 'lanes': {
      const { describeLane } = await import('./kit/workers.js');
      const rules = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'rules.json'), 'utf8'));
      const lanes = rules.lanes || {};
      if (!Object.keys(lanes).length) throw new Error('No lane data yet. Wait for the next Herdr Boss tick.');
      for (const [provider, lane] of Object.entries(lanes)) console.log(`${describeLane(provider, lane)}${rules.leastOverProvider === provider ? ' (least over; worker start allows it)' : ''}`);
      break;
    }
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
      const { requestBrowser, listBrowserSessions, browserStatus, setBrowserWindowSize, closeBrowser, restartBrowser } = await import('./browser-pool.js');
      const { listBrowserTabs, browserScreenshot, browserNavigate, browserClick, browserInsertText, browserKey, browserNewTab, browserCloseTab } = await import('./browser-preview.js');
      const tabOption = (rest) => {
        if (!rest.length) return null;
        if (rest.length !== 2 || rest[0] !== '--tab' || !rest[1]) throw new Error('Use --tab ID to select a browser page.');
        return rest[1];
      };
      const selectedTab = async (project, rest) => {
        const requested = tabOption(rest);
        const tabs = await listBrowserTabs(project);
        if (!tabs.length) throw new Error('No browser page is open.');
        if (requested) {
          if (!tabs.some((tab) => tab.id === requested)) throw new Error('That tab is no longer open. Run browser tabs again.');
          return requested;
        }
        if (tabs.length !== 1) throw new Error('Several pages are open. Run browser tabs and specify --tab ID.');
        return tabs[0].id;
      };
      const percent = (value) => {
        const match = /^(?:100(?:\.0+)?|\d{1,2}(?:\.\d+)?)%$/.exec(value || '');
        if (!match) throw new Error('Click coordinates must be percentages from 0% to 100%, for example 42% 65%.');
        return Number(value.slice(0, -1)) / 100;
      };
      if (args[0] === 'list' && args.length === 1) console.log(JSON.stringify(await Promise.all(Object.values(listBrowserSessions()).map(browserStatus)), null, 2));
      else if (args[0] === 'size' && args.length === 4) console.log(JSON.stringify(setBrowserWindowSize(args[1], Number(args[2]), Number(args[3])), null, 2));
      else if (args[0] === 'close' && args.length === 2) console.log(JSON.stringify(await closeBrowser(args[1]), null, 2));
      else if (args[0] === 'restart' && [3, 4].includes(args.length) && ['--headless', '--visible'].includes(args[2]) && (args.length === 3 || args[3] === '--no-restore')) console.log(JSON.stringify(await restartBrowser(args[1], args[2] === '--headless', { restorePage: !args.includes('--no-restore') }), null, 2));
      else if (args[0] === 'tabs' && args.length === 2) {
        const tabs = await listBrowserTabs(args[1]);
        console.log(JSON.stringify(tabs.map((tab) => ({ id: tab.id, title: tab.title, url: (() => { try { const url = new URL(tab.url); return ['http:', 'https:'].includes(url.protocol) ? `${url.origin}${url.pathname}` : url.href; } catch { return ''; } })(), visibility: tab.visibility, agentAttached: tab.attached })), null, 2));
      }
      else if (args[0] === 'tab' && args[1] === 'new' && args[2] && args.length <= 4) console.log(JSON.stringify(await browserNewTab(args[2], args[3])));
      else if (args[0] === 'tab' && args[1] === 'close' && args[2] && args[3] === '--tab' && args[4] && (args.length === 5 || (args.length === 6 && args[5] === '--force'))) console.log(JSON.stringify(await browserCloseTab(args[2], args[4], { force: args[5] === '--force' })));
      else if (args[0] === 'screenshot' && args[1]) {
        const tab = await selectedTab(args[1], args.slice(2));
        const image = await browserScreenshot(args[1], tab);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-boss-browser-'));
        const file = path.join(dir, `${args[1]}-${randomBytes(4).toString('hex')}.jpg`);
        fs.writeFileSync(file, image, { flag: 'wx', mode: 0o600 });
        console.log(file);
      }
      else if (args[0] === 'navigate' && args[1] && args[2]) {
        const tab = await selectedTab(args[1], args.slice(3));
        console.log(JSON.stringify(await browserNavigate(args[1], tab, args[2])));
      }
      else if (args[0] === 'click' && args[1] && args[2] && args[3]) {
        const tab = await selectedTab(args[1], args.slice(4));
        await browserClick(args[1], tab, percent(args[2]), percent(args[3]));
        console.log('Click sent.');
      }
      else if (args[0] === 'text' && args[1] && args[2] === '--stdin') {
        const tab = await selectedTab(args[1], args.slice(3));
        await browserInsertText(args[1], tab, fs.readFileSync(0, 'utf8'));
        console.log('Text sent.');
      }
      else if (args[0] === 'key' && args[1] && args[2]) {
        const tab = await selectedTab(args[1], args.slice(3));
        await browserKey(args[1], tab, args[2]);
        console.log('Key sent.');
      }
      else if (args[0] === 'request' && args[1] && args.includes('--headless') && args.includes('--visible')) throw new Error('Choose either --headless or --visible.');
      else if (args[0] === 'request' && args[1] && args.slice(2).every((flag) => ['--reserve', '--headless', '--visible'].includes(flag))) console.log(JSON.stringify(await requestBrowser(args[1], { launch: !args.includes('--reserve'), headless: args.includes('--headless') ? true : args.includes('--visible') ? false : null }), null, 2));
      else throw new Error('Usage: browser request|size|close|restart|list|tabs|tab new|tab close|screenshot|navigate|click|text|key. Run herdr-boss without arguments for details.');
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
      const options = { mode: value('--mode', 'migrate'), model: value('--model', null), effort: value('--effort', null), force: args.includes('--force'), auto: args.includes('--auto') };
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
      console.log(`published ${dashboardUrl(cfg)}/projects/${slug}`);
      break;
    }
    case 'install': {
      // A package manager upgrade removes a versioned path such as .../Cellar/node/<version>/bin/node.
      // Prefer a stable link on PATH that points to the same binary, so the service survives an upgrade.
      const stable = ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find((candidate) => {
        try { return fs.realpathSync(candidate) === fs.realpathSync(process.execPath); } catch { return false; }
      });
      const node = stable || process.execPath;
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
      console.log(`installed ${PLIST}\ndashboard ${dashboardUrl(cfg)}`);
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
