#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadConfig, migrateAccessFiles, assertPreviewDataDir, assertDataWritable, sandboxWriteError, DATA_DIR, dashboardUrl } from './config.js';
import { writeProject, statusWarnings, SLUG } from './projects.js';
import { loadProjectConfig } from './kit/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LABEL = 'no.tallmaker.herdr-boss';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

// Browser ownership follows the Herdr workspace. Any pane in a project's workspace may change that project's
// browser. The Boss (the pane labeled boss, or any pane in the Boss workspace) may change every browser.
async function verifyBrowserCaller(slug, { env = process.env, herdr = null } = {}) {
  const paneId = env.HERDR_PANE_ID;
  const workspaceId = env.HERDR_WORKSPACE_ID;
  if (!paneId && !workspaceId) {
    console.error('Warning: no Herdr pane; the project check is skipped.');
    return;
  }
  if (!paneId || !workspaceId) throw new Error('Set both HERDR_PANE_ID and HERDR_WORKSPACE_ID, or neither.');
  const { createHerdrRunner } = await import('./kit/workers.js');
  const runner = herdr ?? createHerdrRunner();
  let pane = null;
  try {
    const response = runner(['pane', 'get', paneId]);
    pane = response?.pane ?? response;
  } catch (error) {
    // A sandboxed tool shell (for example Codex, when a prefix keeps the command out of its allow rule) cannot
    // start herdr. The pane's own workspace variable then decides, with the same ownership rule.
    const code = error?.code ?? error?.cause?.code;
    if (!['EPERM', 'EACCES', 'ENOENT'].includes(code) && !/\b(EPERM|EACCES|Operation not permitted)\b/.test(String(error?.message))) {
      throw new Error(`Herdr could not read pane ${paneId}: ${error.message}`);
    }
    console.error(`Warning: Herdr is not reachable from this shell (${code || 'EPERM'}); workspace ${workspaceId} from the environment decides.`);
  }
  let paneWorkspace = workspaceId;
  if (pane) {
    const returnedId = pane?.pane_id ?? pane?.paneId ?? pane?.id;
    paneWorkspace = pane?.workspace_id ?? pane?.workspaceId ?? pane?.workspace;
    if (returnedId !== paneId || paneWorkspace !== workspaceId) throw new Error(`Herdr does not confirm pane ${paneId} in workspace ${workspaceId}.`);
    if (pane.label === 'boss') return;
  }
  let control = {};
  try { control = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'rules.json'), 'utf8'))?.control || {}; }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`Could not read the Herdr Boss rules: ${error.message}`); }
  const entry = (control.workspaces || []).find((workspace) => workspace.workspace === paneWorkspace);
  if (entry?.boss) return;
  const owner = entry?.slug ?? Object.entries(control.projects || {}).find(([, project]) => project?.workspace === paneWorkspace)?.[0] ?? null;
  if (owner === slug) return;
  const where = entry?.label ? `${entry.label} (${paneWorkspace})` : paneWorkspace;
  throw new Error(`The ${slug} browser belongs to project ${slug}. This pane is in workspace ${where}, ${owner ? `which belongs to project ${owner}` : 'which belongs to no project'}. Only a pane in the ${slug} workspace or the Boss can change it.`);
}

// Only the Boss pane, the Owner in a plain terminal, or the dashboard may start or stop night
// watch. An orchestrator or a worker gets a refusal with the reason. The pane check is the same
// as the other Boss-only commands, for example mail close.
async function verifyNightCaller(env, herdr) {
  // A plain terminal is the Owner. No pane check runs there.
  // Any Herdr pane variable means a pane, which must pass the pane check. Only a shell with none is the Owner.
  if (env.HERDR_ENV !== '1' && !env.HERDR_PANE_ID && !env.HERDR_WORKSPACE_ID) return { role: 'owner' };
  const paneId = env.HERDR_PANE_ID;
  const workspaceId = env.HERDR_WORKSPACE_ID;
  if (!paneId) throw new Error('Cannot verify the caller pane: HERDR_PANE_ID is required.');
  if (!workspaceId) throw new Error('Cannot verify the caller pane: HERDR_WORKSPACE_ID is required.');
  let response;
  try { response = herdr(['pane', 'get', paneId]); }
  catch (error) { throw new Error(`Cannot verify the caller pane: Herdr could not read pane ${paneId}: ${error.message}`); }
  const pane = response?.pane ?? response ?? {};
  const returnedId = pane.pane_id ?? pane.paneId ?? pane.id ?? null;
  if (returnedId !== paneId) throw new Error(`Cannot verify the caller pane: the returned pane ID (${returnedId ?? '(missing)'}) differs from HERDR_PANE_ID (${paneId}).`);
  const paneWorkspace = pane.workspace_id ?? pane.workspaceId ?? pane.workspace ?? null;
  if (paneWorkspace !== workspaceId) throw new Error(`Cannot verify the caller pane: HERDR_WORKSPACE_ID (${workspaceId}) differs from the pane workspace (${paneWorkspace ?? '(missing)'}).`);
  if (pane.label !== 'boss') {
    throw new Error(`Only the pane labeled boss can run herdr-boss night. This pane is labeled ${pane.label ?? '(none)'}. An orchestrator or a worker cannot start or stop night watch: ask the Boss.`);
  }
  return { role: 'boss' };
}

// The one-line label of a night end time: the local weekday and time, for example "Tue 07:30".
function nightLabel(iso) {
  const date = new Date(iso);
  const day = new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(date);
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(date);
  return `${day} ${time}`;
}

const USAGE = `herdr-boss <command>

  serve [--read-only-preview] Run the collector loop and the dashboard server.
  tick [--json]         Collect once and print alerts. Sends nothing, terminates nothing.
  publish <slug> <file> Validate a project status file and install it. Use "-" for stdin.
  install               Install and start the launchd agent.
  uninstall             Stop and remove the launchd agent.
  logs                  Show the server log.
  lanes                 Print one line per quota provider and the unmetered models lane.
  scratch SLUG          Create the durable scratch folder of a project and print its path.
  policy show|set FILE  Show or replace the local resource policy.
  usage record FILE     Add measured or unmeasured project usage.
  usage summary         Summarize project and provider usage.
  store import|export messages  Import or export messages through SQLite.
  browser request SLUG [--reserve] [--headless|--visible]  Reserve or launch a persistent project browser.
  browser size SLUG WIDTH HEIGHT  Save window size for the next browser launch.
  browser viewport SLUG --tab ID WIDTHxHEIGHT [--scale N] [--mobile]  Set one tab's device metrics.
  browser viewport SLUG --tab ID --reset  Clear one tab's device metrics.
  browser close SLUG      Gracefully close a managed browser, keeping its profile.
  browser release SLUG    Give back the port lease of a closed project browser.
  browser restart SLUG --headless|--visible [--no-restore]  Switch mode and restore the current page.
  browser list          List registered browser sessions.
  browser tabs SLUG      List the pages, their visibility, and whether an agent is attached.
  browser tab new SLUG [URL]  Open a tab in its own background window and print its ID.
  browser tab close SLUG --tab ID [--force]  Close a tab; refuses a tab an agent is attached to.
  browser screenshot SLUG [--tab ID] [--out DIR]  Save a private JPEG and print its path.
  browser navigate SLUG URL [--tab ID]  Open an HTTP(S) page.
  browser click SLUG X% Y% [--tab ID]  Click at screenshot-relative percentages.
  browser drag SLUG X1% Y1% X2% Y2% [--tab ID] [--steps N]  Press at the first position, move to the second, and release. N is 1 to 60 and defaults to 10.
  browser text SLUG --stdin [--tab ID]  Send text from standard input without echoing it.
  browser key SLUG KEY [--tab ID]  Send Tab, Enter, Backspace, arrow keys, etc.
  browser bookmarks SLUG list  List the project bookmarks and the start page.
  browser bookmarks SLUG add NAME URL  Add one bookmark.
  browser bookmarks SLUG rm INDEX  Remove one bookmark.
  browser bookmarks SLUG open INDEX [--new-tab]  Open a bookmark in the current tab or a new tab.
  browser bookmarks SLUG start URL|none  Set or clear the start page of the next launch.
  browser sweep-clones [--dry-run]  Delete orphaned Chrome code-sign clones now; --dry-run only lists them.
  handoff plan PANE --to KIND [--mode migrate|fresh] [--model MODEL] [--effort EFFORT]
  handoff prepare PANE --to KIND [--mode migrate|fresh] [--model MODEL] [--effort EFFORT]
  handoff activate ID --confirmed
  handoff ready ID      Signal automatic successor readiness.
  worker ...            Start, collect, or list workers.
  lock acquire <name> [--wait SECONDS]  Acquire a project lock.
  lock release <name>   Release a project lock.
  lock list             List project locks with their scope.
  lease acquire POOL [--for SLUG|WORKER] [--prefer ITEM] [--ttl MINUTES]  Lease one pool item and print it.
  lease release POOL ITEM  Release a lease of your project; the Boss can release any lease.
  lease list [POOL]     Print the pool items and their leases as JSON.
  push [git push arguments]  Run git push. Take the full-suite lock when a pre-push hook exists.
  suite [--wait SECONDS] [--keep NAME]... -- <command...>  Run a full test suite inside the full-suite lock, without tokens in its environment.
  worktree prune        List safe worktree removals.
  ledger ...            Append or check delegated-run records.
  check ...             Validate worker handoffs and scope.
  check agents [FILE]   Check the AGENTS.md stub, the kit file, and stale orchestration text.
  check kit             List each published project with its loaded kit revision.
  harness check [--live-codex]  Check the harness settings that orchestration needs. Exit 1 on a missing entry.
                        --live-codex also runs one codex exec to check the worker shell variables.
  harness sync [--dry-run] [--codex-only]  Add missing Codex writable roots and print the Claude autoMode lines.
  kit install [--no-hook]  Write the kit file, the AGENTS.md stub, and the Claude SessionStart hook.
  kit update [--quiet]    Print the kit changes since the installed kit revision, then install the kit.
                          --quiet keeps the digest and hides the per-file install lines.
  kit block             Print the marked Herdr Boss stub for AGENTS.md.
  gh issue ...          Run safe GitHub issue commands.
  models                Show allowed worker models.
  say [--reply-to ID] [--action answer|approve|decide|read] TEXT  Reply to the Owner from the boss pane or an orch pane.
  messages [THREAD]     Print the message records of one thread, or of all threads, as JSON.
  messages relay ID... --by boss  Mark queued Owner messages as relayed by the Boss.
  mail post --to owner [--title TEXT] [--action read|decide|approve|answer] FILE  Post a Markdown report for the Owner from the boss pane.
  mail close ID... --note TEXT  Close open Owner mailbox items as answered through the Boss.
  night start [--until HH:MM|ISO] [--report HH:MM|ISO] [--retro HH:MM|ISO] [--quiet-hours|--no-quiet-hours]  Start night watch. The default end time is the next 07:30 local time.
  night stop           Stop night watch.
  night                Print the current night watch state.
  kit-path              Print the shared kit directory.
`;

// Parse --flag VALUE pairs. Each flag appears at most once; other tokens are positional.
function messageFlags(args, known, usage) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) { positional.push(token); continue; }
    if (!known.includes(token)) throw new Error(`Unknown option: ${token}. ${usage}`);
    if (token in flags) throw new Error(`${token} may be used only once.`);
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value.`);
    flags[token] = value;
  }
  return { flags, positional };
}

async function messageCommand(cmd, args) {
  const { sayMessage, postReport, readMessages, listThread, relayOwnerMessages, closeMailboxItems, validThread, verifyMessageCaller } = await import('./messages.js');
  if (cmd === 'messages') {
    if (args[0] === 'relay') {
      const usage = 'Usage: messages relay ID... --by boss';
      const { flags, positional } = messageFlags(args.slice(1), ['--by'], usage);
      if (!positional.length || flags['--by'] !== 'boss') throw new Error(usage);
      const { createHerdrRunner } = await import('./kit/workers.js');
      const caller = verifyMessageCaller(process.env, createHerdrRunner(), 'messages relay');
      if (caller.role !== 'boss') throw new Error('Only the pane labeled boss can run herdr-boss messages relay.');
      const result = relayOwnerMessages(positional, { by: caller.role });
      if (result.error) throw new Error(result.error);
      console.log(`Relayed ${result.relayed} queued Owner message${result.relayed === 1 ? '' : 's'}.`);
      return;
    }
    if (args.length > 1 || (args.length === 1 && !validThread(args[0]))) throw new Error('Usage: messages [THREAD]. THREAD is boss or a project slug.');
    console.log(JSON.stringify(args.length ? listThread(args[0]) : readMessages(), null, 2));
    return;
  }
  const { createHerdrRunner } = await import('./kit/workers.js');
  if (cmd === 'say') {
    const usage = 'Usage: say [--reply-to ID] [--action answer|approve|decide|read] "TEXT"';
    const { flags, positional } = messageFlags(args, ['--reply-to', '--action'], usage);
    if (positional.length !== 1) throw new Error(`${usage}. Quote the text as one argument.`);
    const record = sayMessage(positional[0], { replyTo: flags['--reply-to'] ?? null, action: flags['--action'] ?? null }, { herdr: createHerdrRunner() });
    console.log(`Message ${record.id} is in the ${record.thread} thread for the Owner.`);
    return;
  }
  if (args[0] === 'close') {
    const usage = 'Usage: mail close ID... --note TEXT';
    const { flags, positional } = messageFlags(args.slice(1), ['--note'], usage);
    if (!positional.length || flags['--note'] === undefined) throw new Error(usage);
    const caller = verifyMessageCaller(process.env, createHerdrRunner(), 'mail close');
    if (caller.role !== 'boss') throw new Error('Only the pane labeled boss can run herdr-boss mail close.');
    const result = closeMailboxItems(positional, flags['--note'], { by: caller.role });
    if (result.error) throw new Error(result.error);
    console.log(`Closed ${result.closed} Owner mailbox item${result.closed === 1 ? '' : 's'} as answered through the Boss.`);
    return;
  }
  const usage = 'Usage: mail post --to owner [--title TEXT] [--action read|decide|approve|answer] FILE';
  if (args[0] !== 'post') throw new Error(usage);
  const { flags, positional } = messageFlags(args.slice(1), ['--to', '--title', '--action'], usage);
  if (positional.length !== 1) throw new Error(usage);
  const record = postReport(positional[0], { to: flags['--to'] ?? null, title: flags['--title'] ?? null, action: flags['--action'] ?? null }, { herdr: createHerdrRunner() });
  console.log(`Report ${record.id} is in the boss thread for the Owner.`);
}

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
  if (['say', 'messages', 'mail'].includes(cmd)) {
    await messageCommand(cmd, args);
    return;
  }
  if (['worker', 'lock', 'push', 'suite', 'worktree', 'ledger', 'check', 'gh', 'models', 'kit'].includes(cmd)) {
    const { runKitCommand } = await import('./kit/cli.js');
    const result = runKitCommand(cmd, args);
    if (result?.exitCode) process.exitCode = result.exitCode;
    return;
  }
  // Refuse an unsafe preview before loadConfig() creates the data directory.
  if (cmd === 'serve' && args.includes('--read-only-preview')) assertPreviewDataDir();
  const cfg = loadConfig();
  switch (cmd) {
    case 'lanes': {
      const { describeLane, describeMachine, describeUnmetered } = await import('./kit/workers.js');
      const { useNowLanes } = await import('./control.js');
      const rules = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'rules.json'), 'utf8'));
      let project = null;
      try {
        const config = loadProjectConfig();
        if (fs.existsSync(config.configPath)) project = config.slug;
      } catch {}
      const machineStatus = describeMachine(rules);
      if (machineStatus) console.log(machineStatus);
      const lanes = rules.lanes || {};
      const useNow = useNowLanes(lanes);
      console.log(useNow.length
        ? `Use now: ${useNow.map(({ provider, reason }) => `${provider} (${reason})`).join(', ')}`
        : 'Use now: no metered lane; use unmetered models or wait.');
      if (!Object.keys(lanes).length) throw new Error('No lane data yet. Wait for the next Herdr Boss tick.');
      for (const [provider, lane] of Object.entries(lanes)) {
        if (lane.unmetered) {
          console.log(describeUnmetered(lane, project));
          const exhausted = (lane.exhausted || []).filter((item) => !project || item.projects?.includes(project))
            .map((item) => `${item.model} until ${new Date(item.retryAt).toISOString()}`).sort();
          if (exhausted.length) console.log(`unmetered exhausted: ${exhausted.join('; ')}`);
          continue;
        }
        console.log(`${describeLane(provider, lane)}${rules.leastOverProvider === provider ? ' (least over; worker start allows it)' : ''}`);
      }
      break;
    }
    case 'policy': {
      const { loadPolicy, savePolicy } = await import('./control.js');
      if (args[0] === 'show' && args.length === 1) console.log(JSON.stringify(loadPolicy(), null, 2));
      else if (args[0] === 'set' && args.length === 2) {
        const { loadModels } = await import('./kit/config.js');
        const notes = [];
        const errors = savePolicy(JSON.parse(fs.readFileSync(args[1], 'utf8')), loadModels(), { notes });
        if (errors.length) throw new Error(errors.join('\n'));
        for (const note of notes) console.log(note);
        console.log('Policy saved. The service will apply it on its next tick.');
      } else throw new Error('Usage: policy show | policy set FILE');
      break;
    }
    case 'night': {
      const { readNight, writeNight, clearNight, nightUntil, defaultNightUntil } = await import('./night.js');
      const usage = 'Usage: night start [--until HH:MM|ISO] [--report HH:MM|ISO] [--retro HH:MM|ISO] [--quiet-hours|--no-quiet-hours] | night stop | night';
      const [action, ...rest] = args;
      if (action === undefined) {
        const state = readNight();
        console.log(state.active
          ? `Night watch until ${nightLabel(state.until)}${state.by ? ` (by ${state.by})` : ''}.`
          : 'No night watch.');
        break;
      }
      if (!['start', 'stop'].includes(action)) throw new Error(usage);
      const { createHerdrRunner } = await import('./kit/workers.js');
      const caller = await verifyNightCaller(process.env, createHerdrRunner());
      if (action === 'stop') {
        clearNight();
        console.log('Night watch stopped.');
        break;
      }
      const flags = {};
      const positional = [];
      for (let index = 0; index < rest.length; index += 1) {
        const token = rest[index];
        if (!token.startsWith('--')) { positional.push(token); continue; }
        if (!['--until', '--report', '--retro', '--quiet-hours', '--no-quiet-hours'].includes(token)) throw new Error(`Unknown option: ${token}. ${usage}`);
        if (token in flags) throw new Error(`${token} may be used only once.`);
        if (token === '--quiet-hours' || token === '--no-quiet-hours') { flags[token] = true; continue; }
        const value = rest[++index];
        if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value.`);
        flags[token] = value;
      }
      if (positional.length) throw new Error(usage);
      if (flags['--quiet-hours'] && flags['--no-quiet-hours']) throw new Error('Use only one of --quiet-hours or --no-quiet-hours.');
      const until = flags['--until'] === undefined ? defaultNightUntil() : nightUntil(flags['--until']);
      const reportAt = flags['--report'] === undefined ? until : nightUntil(flags['--report']);
      const retroAt = flags['--retro'] === undefined ? null : nightUntil(flags['--retro']);
      writeNight({
        active: true,
        since: new Date().toISOString(),
        until: until.toISOString(),
        reportAt: reportAt.toISOString(),
        ...(retroAt ? { retroAt: retroAt.toISOString() } : {}),
        by: caller.role,
        quietHours: flags['--quiet-hours'] === true
          ? true
          : flags['--no-quiet-hours'] === true
            ? false
            : cfg.night?.quietHours === true,
      });
      console.log(`Night watch until ${nightLabel(until.toISOString())}.`);
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
    case 'store': {
      const { importMessages, exportMessages } = await import('./message-store.js');
      if (args.length === 2 && args[0] === 'import' && args[1] === 'messages') {
        const count = importMessages({ dir: DATA_DIR });
        console.log(`Imported ${count} message${count === 1 ? '' : 's'}.`);
      } else if (args.length === 2 && args[0] === 'export' && args[1] === 'messages') {
        const count = exportMessages({ dir: DATA_DIR });
        console.log(`Exported ${count} message${count === 1 ? '' : 's'}.`);
      } else throw new Error('Usage: store import messages | store export messages');
      break;
    }
    case 'browser': {
      const { parseScreenshotOptions, saveBrowserScreenshot } = await import('./browser-output.js');
      const { requestBrowser, listBrowserSessions, browserStatus, setBrowserWindowSize, closeBrowser, restartBrowser, releaseBrowser, listBookmarks, addBookmark, removeBookmark, setStartPage } = await import('./browser-pool.js');
      const { listBrowserTabs, browserScreenshot, browserNavigate, browserClick, browserHover, browserDrag, browserInsertText, browserKey, browserViewport, browserNewTab, browserCloseTab } = await import('./browser-preview.js');
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
      const percent = (value, subject = 'Click coordinates') => {
        const match = /^(?:100(?:\.0+)?|\d{1,2}(?:\.\d+)?)%$/.exec(value || '');
        if (!match) throw new Error(`${subject} must be percentages from 0% to 100%, for example 42% 65%.`);
        return Number(value.slice(0, -1)) / 100;
      };
      if (args[0] === 'sweep-clones' && (args.length === 1 || (args.length === 2 && args[1] === '--dry-run'))) {
        const { codeSignCloneDir, sweepCodeSignClones } = await import('./clone-sweep.js');
        const { fmtDuration } = await import('./rules.js');
        const dryRun = args[1] === '--dry-run';
        const dir = codeSignCloneDir();
        if (!dir) { console.log('No Chrome code-sign clone folder on this machine. Nothing to do.'); break; }
        const result = await sweepCodeSignClones({ dir, dryRun });
        if (result.error) throw new Error(result.error);
        if (dryRun) {
          for (const c of result.candidates) console.log(`${c.name}  ${fmtDuration(Math.round(c.ageMs / 1000))} old`);
          console.log(`Dry run: ${result.candidates.length} orphaned clone(s) would be deleted. Nothing was deleted.`);
        } else console.log(`Deleted ${result.removed.length} orphaned clone(s) and freed ${(result.freedBytes / 1024 ** 3).toFixed(1)} GiB.`);
      }
      else if (args[0] === 'list' && args.length === 1) console.log(JSON.stringify(await Promise.all(Object.values(listBrowserSessions()).map(browserStatus)), null, 2));
      else if (args[0] === 'size' && args.length === 4) {
        await verifyBrowserCaller(args[1]);
        console.log(JSON.stringify(setBrowserWindowSize(args[1], Number(args[2]), Number(args[3])), null, 2));
      }
      else if (args[0] === 'viewport' && args[1]) {
        await verifyBrowserCaller(args[1]);
        if (args[2] !== '--tab' || !args[3]) throw new Error('Use browser viewport SLUG --tab ID WIDTHxHEIGHT [--scale N] [--mobile], or browser viewport SLUG --tab ID --reset.');
        let viewport;
        if (args[4] === '--reset') {
          if (args.length !== 5) throw new Error('Use --reset by itself.');
          viewport = { reset: true };
        } else {
          const size = /^(\d+)x(\d+)$/.exec(args[4] || '');
          if (!size) throw new Error('Use WIDTHxHEIGHT, for example 473x291.');
          viewport = { width: Number(size[1]), height: Number(size[2]) };
          let scaleSeen = false;
          let mobileSeen = false;
          for (let index = 5; index < args.length; index++) {
            if (args[index] === '--scale' && !scaleSeen && args[index + 1]) {
              scaleSeen = true;
              viewport.scale = Number(args[++index]);
            } else if (args[index] === '--mobile' && !mobileSeen) {
              mobileSeen = true;
              viewport.mobile = true;
            } else {
              throw new Error('Use browser viewport SLUG --tab ID WIDTHxHEIGHT [--scale N] [--mobile], or browser viewport SLUG --tab ID --reset.');
            }
          }
        }
        const tab = await selectedTab(args[1], ['--tab', args[3]]);
        const viewportResult = await browserViewport(args[1], tab, viewport);
        if (viewportResult.reset) {
          console.log('viewport: reset');
        } else if (viewportResult.method === 'window') {
          console.log(`viewport: window ${viewportResult.width}x${viewportResult.height} (inner ${viewportResult.innerWidth}x${viewportResult.innerHeight})`);
        } else {
          console.log(`viewport: emulation ${viewportResult.width}x${viewportResult.height} (window resize not possible: ${viewportResult.reason})`);
        }
      }
      else if (args[0] === 'close' && args.length === 2) {
        await verifyBrowserCaller(args[1]);
        console.log(JSON.stringify(await closeBrowser(args[1]), null, 2));
      }
      else if (args[0] === 'release' && args.length === 2) {
        await verifyBrowserCaller(args[1]);
        const released = await releaseBrowser(args[1]);
        console.log(`Released project browser port ${released.port} of ${released.project}.`);
      }
      else if (args[0] === 'restart' && [3, 4].includes(args.length) && ['--headless', '--visible'].includes(args[2]) && (args.length === 3 || args[3] === '--no-restore')) {
        await verifyBrowserCaller(args[1]);
        console.log(JSON.stringify(await restartBrowser(args[1], args[2] === '--headless', { restorePage: !args.includes('--no-restore') }), null, 2));
      }
      else if (args[0] === 'tabs' && args.length === 2) {
        const tabs = await listBrowserTabs(args[1]);
        console.log(JSON.stringify(tabs.map((tab) => ({ id: tab.id, title: tab.title, url: (() => { try { const url = new URL(tab.url); return ['http:', 'https:'].includes(url.protocol) ? `${url.origin}${url.pathname}` : url.href; } catch { return ''; } })(), visibility: tab.visibility, agentAttached: tab.attached })), null, 2));
      }
      else if (args[0] === 'tab' && args[1] === 'new' && args[2] && args.length <= 4) {
        await verifyBrowserCaller(args[2]);
        console.log(JSON.stringify(await browserNewTab(args[2], args[3])));
      }
      else if (args[0] === 'tab' && args[1] === 'close' && args[2] && args[3] === '--tab' && args[4] && (args.length === 5 || (args.length === 6 && args[5] === '--force'))) {
        await verifyBrowserCaller(args[2]);
        console.log(JSON.stringify(await browserCloseTab(args[2], args[4], { force: args[5] === '--force' })));
      }
      else if (args[0] === 'screenshot' && args[1]) {
        const screenshotOptions = parseScreenshotOptions(args.slice(2));
        const tab = await selectedTab(args[1], screenshotOptions.tab ? ['--tab', screenshotOptions.tab] : []);
        const image = await browserScreenshot(args[1], tab);
        console.log(saveBrowserScreenshot(image, { out: screenshotOptions.out }));
      }
      else if (args[0] === 'navigate' && args[1] && args[2]) {
        await verifyBrowserCaller(args[1]);
        const tab = await selectedTab(args[1], args.slice(3));
        console.log(JSON.stringify(await browserNavigate(args[1], tab, args[2])));
      }
      else if (args[0] === 'click' && args[1] && args[2] && args[3]) {
        await verifyBrowserCaller(args[1]);
        const tab = await selectedTab(args[1], args.slice(4));
        await browserClick(args[1], tab, percent(args[2]), percent(args[3]));
        console.log('Click sent.');
      }
      else if (args[0] === 'hover' && args[1] && args[2] && args[3]) {
        await verifyBrowserCaller(args[1]);
        const tab = await selectedTab(args[1], args.slice(4));
        await browserHover(args[1], tab, percent(args[2], 'Hover coordinates'), percent(args[3], 'Hover coordinates'));
        console.log('Hover sent.');
      }
      else if (args[0] === 'drag' && args[1] && args[2] && args[3] && args[4] && args[5]) {
        await verifyBrowserCaller(args[1]);
        const rest = args.slice(6);
        let steps = 10;
        const at = rest.indexOf('--steps');
        if (at >= 0) {
          if (rest.length !== at + 2 || rest.indexOf('--steps', at + 1) >= 0) throw new Error('Use --steps N with N from 1 to 60.');
          const value = rest[at + 1];
          if (!/^\d{1,2}$/.test(value) || Number(value) < 1 || Number(value) > 60) throw new Error('Drag steps must be from 1 to 60.');
          steps = Number(value);
          rest.splice(at, 2);
        }
        const tab = await selectedTab(args[1], rest);
        await browserDrag(args[1], tab, { x: percent(args[2], 'Drag coordinates'), y: percent(args[3], 'Drag coordinates') },
          { x: percent(args[4], 'Drag coordinates'), y: percent(args[5], 'Drag coordinates') }, { steps });
        console.log('Drag sent.');
      }
      else if (args[0] === 'text' && args[1] && args[2] === '--stdin') {
        await verifyBrowserCaller(args[1]);
        const tab = await selectedTab(args[1], args.slice(3));
        await browserInsertText(args[1], tab, fs.readFileSync(0, 'utf8'));
        console.log('Text sent.');
      }
      else if (args[0] === 'key' && args[1] && args[2]) {
        await verifyBrowserCaller(args[1]);
        const tab = await selectedTab(args[1], args.slice(3));
        await browserKey(args[1], tab, args[2]);
        console.log('Key sent.');
      }
      else if (args[0] === 'bookmarks' && args[1] && args[2] === 'list' && args.length === 3) console.log(JSON.stringify(listBookmarks(args[1]), null, 2));
      else if (args[0] === 'bookmarks' && args[1] && args[2] === 'add' && args[3] && args[4] && args.length === 5) {
        await verifyBrowserCaller(args[1]);
        console.log(JSON.stringify(addBookmark(args[1], { name: args[3], url: args[4] }), null, 2));
      }
      else if (args[0] === 'bookmarks' && args[1] && args[2] === 'rm' && args[3] && args.length === 4) {
        await verifyBrowserCaller(args[1]);
        console.log(JSON.stringify(removeBookmark(args[1], args[3]), null, 2));
      }
      else if (args[0] === 'bookmarks' && args[1] && args[2] === 'start' && args[3] && args.length === 4) {
        await verifyBrowserCaller(args[1]);
        console.log(JSON.stringify(setStartPage(args[1], args[3] === 'none' ? null : args[3]), null, 2));
      }
      else if (args[0] === 'bookmarks' && args[1] && args[2] === 'open' && args[3] && (args.length === 4 || (args.length === 5 && args[4] === '--new-tab'))) {
        await verifyBrowserCaller(args[1]);
        const bookmark = listBookmarks(args[1]).bookmarks[Number(args[3])];
        if (!bookmark) throw new Error('Bookmark index is out of range.');
        if (args[4] === '--new-tab') console.log(JSON.stringify(await browserNewTab(args[1], bookmark.url)));
        else console.log(JSON.stringify(await browserNavigate(args[1], null, bookmark.url)));
      }
      else if (args[0] === 'request' && args[1] && args.includes('--headless') && args.includes('--visible')) throw new Error('Choose either --headless or --visible.');
      else if (args[0] === 'request' && args[1] && args.slice(2).every((flag) => ['--reserve', '--headless', '--visible'].includes(flag))) {
        await verifyBrowserCaller(args[1]);
        console.log(JSON.stringify(await requestBrowser(args[1], { launch: !args.includes('--reserve'), headless: args.includes('--headless') ? true : args.includes('--visible') ? false : null }), null, 2));
      }
      else throw new Error('Usage: browser request|size|viewport|close|release|restart|list|tabs|tab new|tab close|screenshot|navigate|click|hover|drag|text|key|bookmarks|sweep-clones. Run herdr-boss without arguments for details.');
      break;
    }
    case 'handoff': {
      const { planHandoff, prepareHandoff, activateHandoff, markHandoffReady, listHandoffs } = await import('./handoff.js');
      const [action, target] = args;
      // A sandbox cannot write handoff records. Fail before the first Herdr call or file write.
      if (['prepare', 'activate', 'ready'].includes(action)) assertDataWritable();
      if (action === 'list') { console.log(JSON.stringify(listHandoffs(), null, 2)); break; }
      if (action === 'activate') { console.log(JSON.stringify(activateHandoff(target, { confirmed: args.includes('--confirmed') }), null, 2)); break; }
      if (action === 'ready') { console.log(JSON.stringify(markHandoffReady(target), null, 2)); break; }
      const value = (flag, fallback) => { const i = args.indexOf(flag); return i < 0 ? fallback : args[i + 1]; };
      const to = value('--to');
      if (!target || !to || !['plan', 'prepare'].includes(action)) throw new Error('Usage: handoff plan|prepare PANE --to KIND [--mode migrate|fresh] [--model MODEL]');
      // The JSON result goes to stdout, so the kit line goes to stderr.
      try {
        const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        const { kitBehindLine } = await import('./kit/agents-check.js');
        const kitLine = top && kitBehindLine(top);
        if (kitLine) console.error(kitLine);
      } catch {}
      const options = { mode: value('--mode', 'migrate'), model: value('--model', null), effort: value('--effort', null), force: args.includes('--force'), auto: args.includes('--auto') };
      console.log(JSON.stringify(action === 'plan' ? planHandoff(target, to, options) : prepareHandoff(target, to, options), null, 2));
      break;
    }
    case 'lease': {
      const { acquireLease, releaseLease, listLeases, leasePools } = await import('./leases.js');
      const { pools, errors: poolErrors } = leasePools(cfg);
      if (poolErrors.length) throw new Error(`The resourcePools setting in ${path.join(DATA_DIR, 'config.json')} is invalid:\n- ${poolErrors.join('\n- ')}`);
      const [action, ...rest] = args;
      const usage = 'Usage: lease acquire POOL [--for SLUG|WORKER] [--prefer ITEM] [--ttl MINUTES] | lease release POOL ITEM | lease list [POOL]';
      if (action === 'list') {
        if (rest.length > 1) throw new Error(usage);
        listLeases({ pools, pool: rest[0] ?? null });
        break;
      }
      if (!['acquire', 'release'].includes(action)) throw new Error(usage);
      const { createHerdrRunner } = await import('./kit/workers.js');
      let project = null;
      try { project = loadProjectConfig(); } catch {}
      const log = (item) => console.error(`Reclaimed lease ${item.pool} ${item.item} of ${item.project}: ${item.reason}.`);
      const common = { pools, config: project, herdr: createHerdrRunner(), log };
      if (action === 'release') {
        if (rest.length !== 2) throw new Error(usage);
        releaseLease(rest[0], rest[1], common);
        break;
      }
      const flags = {};
      const positional = [];
      for (let index = 0; index < rest.length; index += 1) {
        const token = rest[index];
        if (!token.startsWith('--')) { positional.push(token); continue; }
        if (!['--for', '--prefer', '--ttl'].includes(token)) throw new Error(`Unknown option: ${token}. ${usage}`);
        if (token in flags) throw new Error(`${token} may be used only once.`);
        const value = rest[++index];
        if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value.`);
        flags[token] = value;
      }
      if (positional.length !== 1) throw new Error(usage);
      if (flags['--ttl'] !== undefined && !/^\d+$/.test(flags['--ttl'])) throw new Error('--ttl must be a positive whole number of minutes.');
      acquireLease(positional[0], {
        ...common, forTarget: flags['--for'] ?? null, prefer: flags['--prefer'] ?? null,
        ttlMinutes: flags['--ttl'] === undefined ? null : Number(flags['--ttl']),
      });
      break;
    }
    case 'serve': {
      if (args.some((arg) => arg !== '--read-only-preview') || args.length > 1) throw new Error('Usage: serve [--read-only-preview]');
      if (!args.includes('--read-only-preview')) migrateAccessFiles(cfg);
      const { serve } = await import('./server.js');
      serve(cfg, { readOnlyPreview: args.includes('--read-only-preview') });
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
      const data = JSON.parse(text);
      // Check AGENTS.md at the Git top level. Findings are warnings here; the status still publishes.
      let top = null;
      try { top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch {}
      const agentsFile = top && path.join(top, 'AGENTS.md');
      if (agentsFile && fs.existsSync(agentsFile) && data && typeof data === 'object' && !Array.isArray(data)) {
        const { checkAgentsFile } = await import('./kit/agents-check.js');
        const result = checkAgentsFile(agentsFile, { rulesFile: path.join(DATA_DIR, 'rules.json'), relative: 'AGENTS.md' });
        for (const line of result.lines) console.error(`warning: ${line.includes(".md line") ? line : `AGENTS.md ${line}`}`);
        if (result.findings.length) console.error(`warning: ${result.summary}. Run herdr-boss check agents.`);
        data.agentsCheck = { checkedAt: new Date().toISOString(), errors: result.errors, warnings: result.warnings, file: result.file };
      }
      const errors = writeProject(slug, data);
      if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
      for (const warning of statusWarnings(data)) console.error(`Warning: ${warning}`);
      if (top) {
        const { kitBehindLine } = await import('./kit/agents-check.js');
        const kitLine = kitBehindLine(top);
        if (kitLine) console.error(kitLine);
      }
      console.log(`published ${dashboardUrl(cfg)}/projects/${slug}`);
      if (top) {
        // The first publish of a slug registers its repository and adds its .git to the Codex writable roots.
        const { recordProjectRepo, syncHarness } = await import('./harness.js');
        let remote = '';
        try { remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: top, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
        if (recordProjectRepo(slug, top, remote).isNew) {
          try {
            for (const line of syncHarness({ codexOnly: true }).lines) console.error(`warning: harness sync: ${line}`);
          } catch (error) { console.error(`warning: harness sync: ${error.message}. Run herdr-boss harness sync.`); }
        }
      }
      break;
    }
    case 'harness': {
      const { checkHarness, formatFinding, liveCodexCheck, syncHarness } = await import('./harness.js');
      const [action, ...flags] = args;
      if (action === 'check' && flags.every((flag) => flag === '--live-codex')) {
        const findings = checkHarness();
        // Only --live-codex calls a model. It prints set or missing, never a value.
        if (flags.includes('--live-codex')) findings.push(liveCodexCheck());
        for (const finding of findings) console.log(formatFinding(finding));
        const failed = findings.filter((finding) => finding.status !== 'ok').length;
        console.log(`harness check: ${failed ? 'FAIL' : 'PASS'} (${findings.length} entries, ${failed} missing or bad). See docs/harness-setup.md.`);
        if (failed) process.exitCode = 1;
      } else if (action === 'sync' && flags.every((flag) => ['--dry-run', '--codex-only'].includes(flag))) {
        const result = syncHarness({ dryRun: flags.includes('--dry-run'), codexOnly: flags.includes('--codex-only'), url: dashboardUrl(cfg) });
        for (const line of result.lines) console.log(line);
        if (!result.ok) process.exitCode = 1;
      } else throw new Error('Usage: harness check [--live-codex] | harness sync [--dry-run] [--codex-only]');
      break;
    }
    case 'install': {
      migrateAccessFiles(cfg);
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

main().catch((error) => { const e = sandboxWriteError(error); console.error(e.message); process.exit(e.exitCode ?? 1); });
