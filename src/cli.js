#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadConfig, migrateAccessFiles, assertPreviewDataDir, assertLiveDataDir, assertDataWritable, sandboxWriteError, DATA_DIR, PROJECTS_DIR, dashboardUrl } from './config.js';
import { writeProject, statusWarnings, capDoneTasks, STATUS_WARN_BYTES, SLUG } from './projects.js';
import { loadProjectConfig } from './kit/config.js';
import { TRIAL_RESULT_TARGET, untilText } from './kit/model-unavailable.js';
import { maskDeep, maskBrowserText, maskCliError, redactBrowserSecrets } from './browser-url-mask.js';
import { planDeviationText, projectionText } from './quota-plan.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LABEL = 'no.tallmaker.herdr-boss';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

export function formatBrowserJson(value, options = {}) {
  return redactBrowserSecrets(JSON.stringify(maskDeep(value, options), null, 2));
}

export function formatBrowserTabs(tabs, options = {}) {
  const { full = false } = options;
  const formatted = tabs.map((tab) => ({
    id: tab.id,
    title: tab.title,
    url: (() => {
      try {
        const url = new URL(tab.url);
        return full && ['http:', 'https:'].includes(url.protocol)
          ? `${url.origin}${url.pathname}`
          : url.href;
      } catch {
        return '';
      }
    })(),
    visibility: tab.visibility,
    agentAttached: tab.attached,
  }));
  return formatBrowserJson(formatted, options);
}

// Browser ownership follows the Herdr workspace. Any pane in a project's workspace may change that project's
// browser. The Boss (the pane labeled boss, or any pane in the Boss workspace) may change every browser.
async function verifyBrowserCaller(slug, { env = process.env, herdr = null } = {}) {
  const paneId = env.HERDR_PANE_ID;
  const workspaceId = env.HERDR_WORKSPACE_ID;
  if (!paneId && !workspaceId) {
    console.error(maskBrowserText('Warning: no Herdr pane; the project check is skipped.'));
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
    console.error(maskBrowserText(`Warning: Herdr is not reachable from this shell (${code || 'EPERM'}); workspace ${workspaceId} from the environment decides.`));
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

// Only the Boss pane, the Owner in a plain terminal, or the dashboard may start or stop the
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
    throw new Error(`Only the pane labeled boss can run herdr-boss watch. This pane is labeled ${pane.label ?? '(none)'}. An orchestrator or a worker cannot start or stop the watch: ask the Boss.`);
  }
  return { role: 'boss' };
}

const USAGE = `herdr-boss <command>

  serve [--read-only-preview [--host <address>]] Run the collector loop and the dashboard server.
                              The preview binds 127.0.0.1 unless --host names another address.
  tick [--json]         Collect once and print alerts. Sends nothing, terminates nothing.
  publish <slug> <file> [--force] [--sync] Validate a project status file and install it. Use "-" for stdin. --sync sets each card state from git, workers and issues first.
                        Refuses a live worker on a task that is not doing, unless --force.
  install               Install and start the launchd agent.
  uninstall             Stop and remove the launchd agent.
  logs                  Show the server log.
  lanes                 Print one line per quota provider and the unmetered models lane.
  quota plan codex [--burst-pace N] [--announce TIME[:full|partial]] [--what-if TIME] [--json]
                        Show the Codex quota plan. What-if options do not write the plan.
  quota announce codex --at TIME [--kind full|partial] [--refund N]
  quota announce --list | --remove ID
  quota credit used ID  Mark a Codex reset credit used after Owner confirmation.
  project new <slug> [--group DIR | --path DIR] [--remote gh|URL|none] [--visibility private|public] [--org NAME]
                        [--kind claude|codex] [--goal TEXT] [--start] [--dry-run] [--resume]
                        Create a project folder with the kit files and the first commit.
                        Exit 0 done, 1 usage or refusal, 2 not built, 3 waiting for the Owner.
  project check <slug> [--fix STEP [--start]]  Check a project set-up. Exit 4 when an item is missing.
  project paths [--json]  Print the registered paths of other projects.
  fleet settings|init|account|read-token  Read fleet settings and provision private account digests or read credentials. See docs/cli.md.
  factory new|build|start|stop|status|list  Create and control container factories from the host. The minimum factory version is 0.1.0.
  factory configure NAME [--resume] [--step STEP]  Check the container, volumes, Herdr server, and service. Exit 3 waits for Owner logins.
  factory connect [--check|--undo] NAME  Connect a registered factory to Fleet. Check prints name, state, and age only. Undo reverses the connection.
  factory host add|list|remove  Keep private host connections. Use --docker-context CONTEXT for Docker. Run factory ssh HOST -- COMMAND... or factory docker HOST -- ARGS...
  goal set <project|pane> [--text TEXT] [--dry-run]  Set the /goal of a running orchestrator when its pane is idle.
                        Exit 0 goal active, 2 pane busy or not an orchestrator, 3 sent but not shown.
  scratch SLUG          Create the durable scratch folder of a project and print its path.
  policy show|set FILE  Show or replace the local resource policy.
  usage record FILE     Add measured or unmeasured project usage.
  usage summary         Summarize project and provider usage.
  spend [--days N] [--json]  Print the token use and estimated cost per day and role for all harnesses.
  store import|export messages  Import or export messages through SQLite.
  browser request SLUG [--full] [--reserve] [--headless|--visible]  Reserve or launch a persistent project browser.
  browser size SLUG WIDTH HEIGHT  Save window size for the next browser launch.
  browser viewport SLUG --tab ID WIDTHxHEIGHT [--scale N] [--mobile]  Set one tab's device metrics.
  browser viewport SLUG --tab ID --reset  Clear one tab's device metrics.
  browser close SLUG      Gracefully close a managed browser, keeping its profile.
  browser release SLUG    Give back the port lease of a closed project browser.
  browser restart SLUG --headless|--visible [--no-restore]  Switch mode and restore the current page.
  browser list          List registered browser sessions.
  browser tabs SLUG [--full]  List the pages, their visibility, and whether an agent is attached.
  browser tab new SLUG [URL] [--full]  Open a tab in its own background window and print its ID.
  browser tab close SLUG --tab ID [--force]  Close a tab; refuses a tab an agent is attached to.
  browser screenshot SLUG [--tab ID] [--out DIR]  Save a private JPEG and print its path.
  browser navigate SLUG URL [--tab ID] [--full]  Open an HTTP(S) page.
  browser click SLUG X% Y% [--tab ID]  Click at screenshot-relative percentages.
  browser drag SLUG X1% Y1% X2% Y2% [--tab ID] [--steps N]  Press at the first position, move to the second, and release. N is 1 to 60 and defaults to 10.
  browser text SLUG --stdin [--tab ID]  Send text from standard input without echoing it.
  browser key SLUG KEY [--tab ID]  Send Tab, Enter, Backspace, arrow keys, etc.
  browser bookmarks SLUG list [--full]  List the project bookmarks and the start page.
  browser bookmarks SLUG add NAME URL  Add one bookmark.
  browser bookmarks SLUG rm INDEX  Remove one bookmark.
  browser bookmarks SLUG open INDEX [--new-tab] [--full]  Open a bookmark in the current tab or a new tab.
  browser bookmarks SLUG start URL|none [--full]  Set or clear the start page of the next launch.
  --full prints real URLs and stored bookmark names. Use it only as the Owner at a terminal.
  browser sweep-clones [--dry-run]  Delete orphaned Chrome code-sign clones now; --dry-run only lists them.
  handoff plan PANE --to KIND [--mode migrate|fresh] [--model MODEL] [--effort EFFORT] [--force]
  handoff prepare PANE --to KIND [--mode migrate|fresh] [--model MODEL] [--effort EFFORT] [--force]
  handoff cancel ID [--force]  Cancel a prepared successor; --force closes a working successor.
  handoff activate ID --confirmed
  handoff ready ID      Signal automatic successor readiness.
  worker ...            Start, collect, or list workers.
  wait [<worker>...]    Block until the first report, question, block, stall, or lost pane of a worker.
  lock acquire <name> [--wait SECONDS]  Acquire a project lock.
  lock release <name> [--slot long|N]   Release a project lock.
  lock list             List project locks with their scope.
  lease acquire POOL [--for SLUG|WORKER] [--prefer ITEM] [--ttl MINUTES] [--pid PID] [--wait SECONDS] [--env-file FILE]  Lease one pool item and print it. --pid binds the lease to the server process. --wait queues for a free item. --env-file writes the pool variables for a shell to source.
  lease bind POOL ITEM --pid PID  Bind a lease to the server process that uses its port.
  lease release POOL ITEM  Release a lease of your project; the Boss can release any lease.
  lease list [POOL]     Print the pool items and their leases as JSON.
  push [git push arguments]  Run git push. Take the full-suite lock when a pre-push hook exists.
  suite [--wait SECONDS] [--keep NAME]... -- <command...>  Run a full test suite inside the full-suite lock, without tokens in its environment.
  worktree prune        List safe worktree removals; --apply removes them and archives worker reports.
  ledger ...            Append or check delegated-run records.
  check ...             Validate worker handoffs and scope.
  check agents [FILE]   Check the AGENTS.md stub, the kit file, and stale orchestration text.
  check kit             List each published project with its loaded kit revision.
  harness check [--live-codex]  Check the harness settings that orchestration needs. Exit 1 on a missing entry.
                        --live-codex also runs one codex exec to check the worker shell variables.
  harness sync [--dry-run] [--codex-only]  Add missing Codex writable roots and print the Claude autoMode lines.
  harness change <harness> <label> [--date YYYY-MM-DD]  Mark a harness fix on the denial chart of the Analytics page.
  kit install [--no-hook]  Write the kit file, the AGENTS.md stub, and the Claude SessionStart hook.
  kit update [--quiet]    Install the kit, print the kit changes since the installed kit revision, and print the kit file.
                          --quiet prints nothing when the kit is current and no file changes. Otherwise it
                          prints the digest and the summary line only.
  kit block             Print the marked Herdr Boss stub for AGENTS.md.
  gh issue ...          Run safe GitHub issue commands.
  gh label create|list|edit|sync ...  Run safe GitHub label commands. sync --preset triage [--dry-run] sets the triage labels.
  gh milestone create|list ...  Run safe GitHub milestone commands.
  models                Show allowed worker models.
  say [--reply-to ID] [--action answer|approve|decide|read] [--image FILE] TEXT  Reply to the Owner from the boss pane or an orch pane.
  messages [THREAD]     Print the message records of one thread, or of all threads, as JSON.
  messages relay ID... --by boss  Mark queued Owner messages as relayed by the Boss.
  mail post --to owner [--title TEXT] [--action read|decide|approve|answer] FILE  Post a Markdown report for the Owner from the boss pane.
  mail close ID... --note TEXT  Close open Owner mailbox items as answered through the Boss.
  tell TARGET TEXT [--file FILE] [--kind nudge|reminder|reply] [--reply-to ID]
                        Store an agent message, then send it to a pane, agent, or project's orchestrator.
  watch start [--until 'YYYY-MM-DD HH:MM'|HH:MM|--until-cancelled] [--report HH:MM] [--retro HH:MM] [--quiet-hours|--no-quiet-hours] [--routines ID,ID|none] [--adhoc TEXT]
                       Start the watch. The default end time is the next 07:30 local time.
  watch stop           Stop the watch.
  watch routines       Print the next and last run of each routine of the running watch.
  watch                Print the current watch state. "night" is an alias of "watch".
  review check FOLDER   Validate a review pack folder. Any pane can run it. Exit 2 when the pack is not valid.
  review publish SLUG FOLDER [--note TEXT] [--dry-run]  Publish a review pack and post a Mailbox item. Run it from an orch pane of SLUG, the boss pane (SLUG boss), or a plain terminal.
  review import SLUG FOLDER-OR-FILE [--id ID] [--title TEXT] [--dry-run]  Import HTML pages as a review pack and publish it.
  review result [SLUG] PACK [--version N] [--format json|md]  Print the stored result of a submitted review: Markdown by default. PACK can also be SLUG/PACK. Exit 3 when there is no result.
  review delete [SLUG] PACK  Delete a review pack and close its Mailbox item. Same caller rules as publish.
  review list [SLUG] [--state open|done|all] [--json]  List review packs.
  plan start KIND PROJECT --input PATH --pane PANE  Start a planner session for a pane and label the pane planner. The pane can then run review publish for PROJECT.
  plan list [PROJECT] [--all] [--json]  List the active planner sessions. --all adds ended sessions.
  plan end ID  End a planner session and clear the pane label.
  kit-path              Print the shared kit directory.
`;

// Parse --flag VALUE pairs. Only the named repeat options can appear more than once.
function messageFlags(args, known, usage, repeat = []) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) { positional.push(token); continue; }
    if (!known.includes(token)) throw new Error(`Unknown option: ${token}. ${usage}`);
    if (token in flags && !repeat.includes(token)) throw new Error(`${token} may be used only once.`);
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value.`);
    if (repeat.includes(token)) (flags[token] ||= []).push(value);
    else flags[token] = value;
  }
  return { flags, positional };
}

async function messageCommand(cmd, args) {
  const { sayMessage, postReport, readMessages, listThread, relayOwnerMessages, closeMailboxItems, validThread, verifyMessageCaller, readControl, REPORT_MAX_BYTES } = await import('./messages.js');
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
  if (cmd === 'tell') {
    const usage = 'Usage: tell TARGET TEXT [--file FILE] [--kind nudge|reminder|reply] [--reply-to ID]';
    let parsed;
    try { parsed = messageFlags(args, ['--file', '--kind', '--reply-to'], usage); }
    catch (error) { error.exitCode = 2; throw error; }
    const { flags, positional } = parsed;
    const fromFile = flags['--file'] !== undefined;
    if ((fromFile && positional.length !== 1) || (!fromFile && positional.length !== 2)) {
      const error = new Error(`${usage}. Give TEXT or --file, not both.`);
      error.exitCode = 2;
      throw error;
    }
    const kind = flags['--kind'] ?? 'task';
    if (flags['--kind'] && !['nudge', 'reminder', 'reply'].includes(kind)) {
      const error = new Error(`${usage}. --kind must be nudge, reminder, or reply.`);
      error.exitCode = 2;
      throw error;
    }
    let text = positional[1] ?? '';
    if (fromFile) {
      let stat;
      try { stat = fs.lstatSync(flags['--file']); }
      catch (error) { throw new Error(`Cannot read --file: ${error.message}`); }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('--file must name a regular file.');
      if (stat.size > REPORT_MAX_BYTES) throw new Error(`The file is ${stat.size} bytes. The limit is 64 KB (${REPORT_MAX_BYTES} bytes).`);
      text = fs.readFileSync(flags['--file'], 'utf8');
    }
    const { tellAgent } = await import('./agent-messages.js');
    const result = tellAgent(positional[0], text, {
      env: process.env, herdr: createHerdrRunner(), control: readControl(), dir: DATA_DIR,
      kind, replyTo: flags['--reply-to'] ?? null,
    });
    if (result.metadataWarning) console.error(result.metadataWarning);
    if (result.exitCode) {
      console.error(`Agent message${result.record ? ` ${result.record.id}` : ''} failed: ${result.reason}`);
      process.exitCode = result.exitCode;
      return;
    }
    console.log(`Agent message ${result.record.id} was delivered.`);
    return;
  }
  if (cmd === 'say') {
    const usage = 'Usage: say [--reply-to ID] [--action answer|approve|decide|read] [--image FILE] "TEXT"';
    const { flags, positional } = messageFlags(args, ['--reply-to', '--action', '--image'], usage, ['--image']);
    if ((flags['--image'] || []).length > 3) throw new Error('say accepts at most 3 pictures.');
    if (positional.length !== 1) throw new Error(`${usage}. Quote the text as one argument.`);
    const record = sayMessage(positional[0], { replyTo: flags['--reply-to'] ?? null, action: flags['--action'] ?? null, images: flags['--image'] || [] }, { herdr: createHerdrRunner() });
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

function quotaOptionValue(args, index, option) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${option} needs a value.`);
  return value;
}

function announcedResetOption(value) {
  const match = /^(.*?)(?::(full|partial))?$/.exec(value);
  const at = match?.[1];
  if (!at || !Number.isFinite(Date.parse(at))) throw new Error('--announce needs an ISO time, with optional :full or :partial.');
  return { at, kind: match[2] || 'full', refundPercent: 0 };
}

function quotaPlainText(view) {
  const plan = view.plan;
  const lines = [
    `Codex quota plan at ${view.now}`,
    `Used: ${view.usedPercent}% · weekly reset: ${view.resetsAt}`,
    `Historical p90 burn: ${view.historicalP90.toFixed(2)} points per hour`,
    `Plan mode: ${view.planMode || 'paced'}`,
  ];
  if (Number.isFinite(view.plannedUsageNow)) {
    lines.push(`Planned now: ${Number(view.plannedUsageNow.toFixed(1))}% · ${planDeviationText(view.guidance?.difference)}`);
  }
  const projected = projectionText(view.projection);
  if (projected) lines.push(`Recent burn: ${Number(view.projection.ratePerHour.toFixed(1))} points per hour over the last 24 hours; ${projected}`);
  if (plan.credits.length) {
    lines.push('Credits:');
    for (const credit of plan.credits) {
      lines.push(`  ${credit.id}: earliest ${credit.earliestAt || 'none'}, planned ${credit.applyAt || 'unused'}, latest ${credit.latestAt || 'none'}; expiry ${credit.expiresAt}`);
    }
  } else lines.push('Credits: none available');
  lines.push(`By ${view.horizon}: ${plan.totalConsumed.toFixed(1)} points; gain over no credits ${plan.gain.toFixed(1)} points`);
  lines.push('Burst pace | points by last expiry | gain');
  for (const row of view.burstTable) {
    lines.push(`  ${row.burstPace.toFixed(1)} / hour | ${row.totalConsumedByLastExpiry.toFixed(1)} | ${row.gainAgainstNoCredits.toFixed(1)}`);
  }
  lines.push(`Fast: ${plan.fast.totalConsumed.toFixed(1)} points, gain ${plan.fast.gain.toFixed(1)}; slow: ${plan.slow.totalConsumed.toFixed(1)} points, gain ${plan.slow.gain.toFixed(1)}.`);
  return lines.join('\n');
}

async function quotaCommand(args, cfg) {
  const { createQuotaPlanService } = await import('./quota-plan-service.js');
  const service = createQuotaPlanService({ dataDir: DATA_DIR, settings: cfg.quotaPlan });
  const action = args[0];
  const currentNow = Date.now();
  const quotas = service.readQuotas();
  if (action === 'plan') {
    const provider = args[1];
    if (!provider) throw new Error('Usage: quota plan codex [--burst-pace N] [--announce TIME[:full|partial]] [--what-if TIME] [--json]');
    let burstPace, horizon, whatIf, json = false;
    for (let index = 2; index < args.length; index += 1) {
      const flag = args[index];
      if (flag === '--json') { json = true; continue; }
      if (flag === '--burst-pace') {
        const value = Number(quotaOptionValue(args, index, flag));
        if (!Number.isFinite(value)) throw new Error('--burst-pace must be a number from 0.1 to 10.');
        burstPace = value; index += 1; continue;
      }
      if (flag === '--announce') {
        whatIf = announcedResetOption(quotaOptionValue(args, index, flag));
        index += 1; continue;
      }
      if (flag === '--what-if') {
        horizon = quotaOptionValue(args, index, flag);
        if (!Number.isFinite(Date.parse(horizon))) throw new Error('--what-if needs an ISO time.');
        index += 1; continue;
      }
      throw new Error(`Unknown quota plan option: ${flag}`);
    }
    const options = { provider, quotas, now: currentNow, burstPace, horizon, whatIf };
    const view = whatIf || horizon ? service.preview(options) : service.replan(options);
    process.stdout.write(json ? `${JSON.stringify(view, null, 2)}\n` : `${quotaPlainText(view)}\n`);
    return;
  }
  if (action === 'announce') {
    if (args[1] === '--list' && args.length === 2) {
      const rows = service.read().announcements.filter((item) => item.provider === 'codex');
      process.stdout.write(rows.length ? `${rows.map((item) => `${item.id} ${item.kind} at ${item.at}${item.kind === 'partial' ? `; refund ${item.refundPercent}` : ''}`).join('\n')}\n` : 'No announced Codex resets.\n');
      return;
    }
    if (args[1] === '--remove' && args.length === 3) {
      await verifyQuotaMutationCaller();
      service.removeAnnouncement({ provider: 'codex', id: args[2], quotas, now: currentNow });
      console.log(`Removed announced reset ${args[2]}.`);
      return;
    }
    if (args[1] !== 'codex') throw new Error('Usage: quota announce codex --at TIME [--kind full|partial] [--refund N] | quota announce --list | --remove ID');
    let at, kind = 'full', refundPercent = 0;
    for (let index = 2; index < args.length; index += 1) {
      const flag = args[index];
      if (flag === '--at') { at = quotaOptionValue(args, index, flag); index += 1; continue; }
      if (flag === '--kind') { kind = quotaOptionValue(args, index, flag); index += 1; continue; }
      if (flag === '--refund') {
        refundPercent = Number(quotaOptionValue(args, index, flag));
        if (!Number.isFinite(refundPercent)) throw new Error('--refund must be a number from 0 to 100.');
        index += 1; continue;
      }
      throw new Error(`Unknown quota announce option: ${flag}`);
    }
    await verifyQuotaMutationCaller();
    const result = service.announce({ provider: 'codex', at, kind, refundPercent, quotas, now: currentNow });
    console.log(`Announcement ID: ${result.id}`);
    return;
  }
  if (action === 'credit' && args[1] === 'used' && args.length === 3) {
    await verifyQuotaMutationCaller();
    const { openMessageStore } = await import('./message-store.js');
    const mailboxService = createQuotaPlanService({ dataDir: DATA_DIR, settings: cfg.quotaPlan,
      messageStore: openMessageStore({ dir: DATA_DIR }) });
    mailboxService.markCreditUsed({ provider: 'codex', id: args[2], quotas, now: currentNow });
    console.log(`Marked Codex credit ${args[2]} used.`);
    return;
  }
  throw new Error('Usage: quota plan codex [options] | quota announce codex --at TIME [--kind full|partial] [--refund N] | quota announce --list | --remove ID | quota credit used ID');
}

async function verifyQuotaMutationCaller() {
  if (process.env.HERDR_ENV !== '1' && !process.env.HERDR_PANE_ID && !process.env.HERDR_WORKSPACE_ID) return;
  const { verifyMessageCaller } = await import('./messages.js');
  const { createHerdrRunner } = await import('./kit/workers.js');
  const caller = verifyMessageCaller(process.env, createHerdrRunner(), 'quota changes', { labels: ['boss', 'orch'] });
  return caller;
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
  if (cmd === 'project') {
    if (args[0] === 'paths') {
      if (args.length > 2 || (args.length === 2 && args[1] !== '--json')) throw new Error('Usage: project paths [--json]');
      const { listProjectPaths } = await import('./project-paths.js');
      const projects = listProjectPaths({ dataDir: DATA_DIR, cwd: process.cwd() });
      console.log(args[1] === '--json'
        ? JSON.stringify(projects, null, 2)
        : projects.map(({ slug, path: projectPath }) => `${slug}=${projectPath}`).join(' '));
      return;
    }
    const { projectCommand } = await import('./project-new-cli.js');
    const { createHerdrRunner } = await import('./kit/workers.js');
    const code = projectCommand(args, { env: process.env, herdr: createHerdrRunner() });
    if (code) process.exitCode = code;
    return;
  }
  if (cmd === 'goal') {
    const { goalCommand } = await import('./goal-cli.js');
    const { createHerdrRunner } = await import('./kit/workers.js');
    const { readControl } = await import('./messages.js');
    const { loadPolicy } = await import('./control.js');
    // SIGINT cancels the wait. The command prints the result and exits with code 130.
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    const code = await goalCommand(args, { env: process.env, herdr: createHerdrRunner(), control: readControl(), policy: loadPolicy(), signal: controller.signal });
    if (code) process.exitCode = code;
    return;
  }
  if (cmd === 'fleet') {
    const { fleetCommand } = await import('./fleet-cli.js');
    const code = await fleetCommand(args);
    if (code) process.exitCode = code;
    return;
  }
  if (cmd === 'factory') {
    const { factoryCommand } = await import('./factory-host.js');
    const code = await factoryCommand(args);
    if (code) process.exitCode = code;
    return;
  }
  if (cmd === 'review') {
    const { reviewCommand } = await import('./review-cli.js');
    const { createHerdrRunner } = await import('./kit/workers.js');
    const code = reviewCommand(args, { env: process.env, herdr: createHerdrRunner() });
    if (code) process.exitCode = code;
    return;
  }
  if (cmd === 'plan') {
    const { planCommand } = await import('./plan-cli.js');
    const { createHerdrRunner } = await import('./kit/workers.js');
    const code = planCommand(args, { env: process.env, herdr: createHerdrRunner() });
    if (code) process.exitCode = code;
    return;
  }
  if (cmd === 'quota') {
    const cfg = loadConfig();
    await quotaCommand(args, cfg);
    return;
  }
  if (['say', 'messages', 'mail', 'tell'].includes(cmd)) {
    await messageCommand(cmd, args);
    return;
  }
  if (['worker', 'wait', 'lock', 'push', 'suite', 'worktree', 'ledger', 'check', 'gh', 'models', 'kit'].includes(cmd)) {
    const { runKitCommand } = await import('./kit/cli.js');
    const result = runKitCommand(cmd, args);
    if (result?.exitCode) process.exitCode = result.exitCode;
    return;
  }
  // Check the startup data directory before loadConfig() creates it.
  if (cmd === 'serve') {
    if (args.includes('--read-only-preview')) assertPreviewDataDir();
    else if (!args.includes('--host')) assertLiveDataDir(); // --host without a preview is a usage error below
  }
  const cfg = loadConfig();
  switch (cmd) {
    case 'lanes': {
      const { describeLane, describeMachine, describeUnmetered } = await import('./kit/workers.js');
      const { useNowLanes } = await import('./control.js');
      const { codexPlanLine } = await import('./rules.js');
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
      const planLine = codexPlanLine(lanes.codex?.planGuidance);
      if (planLine) console.log(planLine);
      if (!Object.keys(lanes).length) throw new Error('No lane data yet. Wait for the next Herdr Boss tick.');
      for (const [provider, lane] of Object.entries(lanes)) {
        if (lane.unmetered) {
          console.log(describeUnmetered(lane, project));
          const exhausted = (lane.exhausted || []).filter((item) => !project || item.projects?.includes(project))
            .map((item) => `${item.model} until ${untilText(item.retryAt)}`).sort();
          if (exhausted.length) console.log(`unmetered exhausted: ${exhausted.join('; ')}`);
          continue;
        }
        console.log(`${describeLane(provider, lane)}${rules.leastOverProvider === provider ? ' (least over; worker start allows it)' : ''}`);
      }
      const unavailable = Object.values(rules.unavailableModels || {}).filter((item) => typeof item?.model === 'string'
        && item.provider !== null && Number.isSafeInteger(item.retryAt) && item.retryAt > Date.now())
        .sort((a, b) => a.model.localeCompare(b.model));
      const trial = (Array.isArray(rules.trialModels) ? rules.trialModels : []).filter((item) => typeof item?.model === 'string');
      if (trial.length) console.log(`trial models (fewer than ${TRIAL_RESULT_TARGET} scorecard results): ${trial.map((item) => `${item.model} (${item.results ?? 0})`).join('; ')}`);
      if (unavailable.length) console.log(`models unavailable: ${unavailable.map((item) => `${item.model} (${item.lane || item.provider || 'unmetered'}) until ${untilText(item.retryAt)}${item.reason ? `: ${item.reason}` : ''}`).join('; ')}`);
      break;
    }
    case 'policy': {
      const { loadPolicy, savePolicy } = await import('./control.js');
      if (args[0] === 'show' && args.length === 1) console.log(JSON.stringify(loadPolicy(), null, 2));
      else if (args[0] === 'set' && args.length >= 2 && args.slice(2).every((flag) => flag === '--confirmed' || flag === '--allow-sum')) {
        const { loadModels } = await import('./kit/config.js');
        const { policyShareGuard } = await import('./control.js');
        const draft = JSON.parse(fs.readFileSync(args[1], 'utf8'));
        const refusal = policyShareGuard(loadPolicy(), draft, { confirmed: args.includes('--confirmed'), allowSum: args.includes('--allow-sum'), via: 'cli' });
        if (refusal) throw new Error(refusal.error);
        const notes = [];
        const errors = savePolicy(draft, loadModels(), { notes, caller: 'cli' });
        if (errors.length) throw new Error(errors.join('\n'));
        for (const note of notes) console.log(note);
        console.log('Policy saved. The service will apply it on its next tick.');
      } else throw new Error('Usage: policy show | policy set FILE [--confirmed] [--allow-sum]');
      break;
    }
    case 'watch':
    case 'night': {
      const { readNight, writeNight, clearNight, buildWatchRecord, watchUntilPhrase } = await import('./night.js');
      const usage = "Usage: watch start [--until 'YYYY-MM-DD HH:MM'|HH:MM|--until-cancelled] [--report HH:MM] [--retro HH:MM] [--quiet-hours|--no-quiet-hours] [--routines ID,ID|none] [--adhoc TEXT] | watch stop | watch routines | watch";
      const [action, ...rest] = args;
      if (action === undefined) {
        const state = readNight();
        console.log(state.active
          ? `On watch ${watchUntilPhrase(state)}${state.by ? ` (by ${state.by})` : ''}.`
          : 'No watch.');
        break;
      }
      if (action === 'routines' && rest.length === 0) {
        const state = readNight();
        if (!state.active) console.log('No watch.');
        for (const routine of state.active ? state.routines : []) {
          console.log(`${routine.id}: next ${routine.nextAt ?? 'none'}, last ${routine.lastAt ?? 'never'}`);
        }
        break;
      }
      if (!['start', 'stop'].includes(action)) throw new Error(usage);
      const { createHerdrRunner } = await import('./kit/workers.js');
      const caller = await verifyNightCaller(process.env, createHerdrRunner());
      if (action === 'stop') {
        clearNight();
        console.log('Watch stopped.');
        break;
      }
      const flags = {};
      const positional = [];
      const BOOLEAN_FLAGS = ['--quiet-hours', '--no-quiet-hours', '--until-cancelled'];
      for (let index = 0; index < rest.length; index += 1) {
        const token = rest[index];
        if (!token.startsWith('--')) { positional.push(token); continue; }
        if (!['--until', '--report', '--retro', '--routines', '--adhoc', ...BOOLEAN_FLAGS].includes(token)) throw new Error(`Unknown option: ${token}. ${usage}`);
        if (token in flags) throw new Error(`${token} may be used only once.`);
        if (BOOLEAN_FLAGS.includes(token)) { flags[token] = true; continue; }
        const value = rest[++index];
        if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value.`);
        flags[token] = value;
      }
      if (positional.length) throw new Error(usage);
      if (flags['--quiet-hours'] && flags['--no-quiet-hours']) throw new Error('Use only one of --quiet-hours or --no-quiet-hours.');
      // --routines lists the routines that run. Every other routine is off for this watch. Without the option, the
      // last choice applies.
      let routines;
      if (flags['--routines'] !== undefined) {
        const { effectiveRoutines } = await import('./watch-routines.js');
        const wanted = flags['--routines'] === 'none' ? [] : flags['--routines'].split(',').map((id) => id.trim()).filter(Boolean);
        routines = Object.fromEntries(effectiveRoutines().map((routine) => [routine.id, { enabled: wanted.includes(routine.id) }]));
        for (const id of wanted) if (!(id in routines)) throw new Error(`Unknown routine ${id}. Known routines: ${Object.keys(routines).join(', ')}.`);
      }
      const { record, warning, choice } = buildWatchRecord({
        until: flags['--until'],
        untilCancelled: flags['--until-cancelled'] === true,
        report: flags['--report'],
        retro: flags['--retro'],
        by: caller.role,
        routines,
        adhoc: flags['--adhoc'],
        quietHours: flags['--quiet-hours'] === true
          ? true
          : flags['--no-quiet-hours'] === true
            ? false
            : (cfg.watch?.quietHours === true),
      });
      writeNight(record);
      if (choice) (await import('./watch-routines.js')).rememberChoice(choice);
      console.log(`On watch ${watchUntilPhrase(record)}.`);
      if (warning) console.log(`Warning: ${warning}`);
      break;
    }
    case 'spend': {
      const { spendSummary, formatSpend, clampSpendDays, SPEND_DEFAULT_DAYS } = await import('./spend.js');
      let days = SPEND_DEFAULT_DAYS;
      let json = false;
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === '--json') json = true;
        else if (args[i] === '--days' && /^\d+$/.test(args[i + 1] || '')) days = clampSpendDays(args[++i]);
        else throw new Error('Usage: spend [--days N] [--json]');
      }
      const summary = spendSummary({ days });
      console.log(json ? JSON.stringify(summary, null, 2) : formatSpend(summary));
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
      const fullCount = args.filter((arg) => arg === '--full').length;
      if (fullCount > 1) throw new Error('--full may be used only once.');
      const full = fullCount === 1;
      if (full) {
        args.splice(0, args.length, ...args.filter((arg) => arg !== '--full'));
        const supportsFull = ['request', 'tabs', 'navigate', 'list', 'size', 'viewport', 'close', 'release', 'restart', 'screenshot'].includes(args[0])
          || (args[0] === 'tab' && args[1] === 'new')
          || (args[0] === 'bookmarks' && ['list', 'open', 'start', 'add', 'rm'].includes(args[2]));
        if (!supportsFull) throw new Error('--full is for the Owner at a terminal. Use it with browser request, tabs, tab new, navigate, or bookmarks list, open, or start.');
      }
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
      const printBrowser = (value, formatter = maskBrowserText) => console.log(redactBrowserSecrets(formatter(value, { full })));
      const printBrowserJson = (value) => printBrowser(value, formatBrowserJson);
      if (args[0] === 'sweep-clones' && (args.length === 1 || (args.length === 2 && args[1] === '--dry-run'))) {
        const { codeSignCloneDir, sweepCodeSignClones } = await import('./clone-sweep.js');
        const { fmtDuration } = await import('./rules.js');
        const dryRun = args[1] === '--dry-run';
        const dir = codeSignCloneDir();
        if (!dir) { printBrowser('No Chrome code-sign clone folder on this machine. Nothing to do.'); break; }
        const result = await sweepCodeSignClones({ dir, dryRun });
        if (result.error) throw new Error(result.error);
        if (dryRun) {
          for (const c of result.candidates) printBrowser(`${c.name}  ${fmtDuration(Math.round(c.ageMs / 1000))} old`);
          printBrowser(`Dry run: ${result.candidates.length} orphaned clone(s) would be deleted. Nothing was deleted.`);
        } else printBrowser(`Deleted ${result.removed.length} orphaned clone(s) and freed ${(result.freedBytes / 1024 ** 3).toFixed(1)} GiB.`);
      }
      else if (args[0] === 'list' && args.length === 1) printBrowserJson(await Promise.all(Object.values(listBrowserSessions()).map(browserStatus)));
      else if (args[0] === 'size' && args.length === 4) {
        await verifyBrowserCaller(args[1]);
        printBrowserJson(setBrowserWindowSize(args[1], Number(args[2]), Number(args[3])));
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
          printBrowser('viewport: reset');
        } else if (viewportResult.method === 'window') {
          printBrowser(`viewport: window ${viewportResult.width}x${viewportResult.height} (inner ${viewportResult.innerWidth}x${viewportResult.innerHeight})`);
        } else {
          printBrowser(`viewport: emulation ${viewportResult.width}x${viewportResult.height} (window resize not possible: ${viewportResult.reason})`);
        }
      }
      else if (args[0] === 'close' && args.length === 2) {
        await verifyBrowserCaller(args[1]);
        printBrowserJson(await closeBrowser(args[1]));
      }
      else if (args[0] === 'release' && args.length === 2) {
        await verifyBrowserCaller(args[1]);
        const released = await releaseBrowser(args[1]);
        printBrowser(`Released project browser port ${released.port} of ${released.project}.`);
      }
      else if (args[0] === 'restart' && [3, 4].includes(args.length) && ['--headless', '--visible'].includes(args[2]) && (args.length === 3 || args[3] === '--no-restore')) {
        await verifyBrowserCaller(args[1]);
        printBrowserJson(await restartBrowser(args[1], args[2] === '--headless', { restorePage: !args.includes('--no-restore') }));
      }
      else if (args[0] === 'tabs' && args.length === 2) {
        const tabs = await listBrowserTabs(args[1]);
        printBrowser(tabs, formatBrowserTabs);
      }
      else if (args[0] === 'tab' && args[1] === 'new' && args[2] && args.length <= 4) {
        await verifyBrowserCaller(args[2]);
        printBrowserJson(await browserNewTab(args[2], args[3]));
      }
      else if (args[0] === 'tab' && args[1] === 'close' && args[2] && args[3] === '--tab' && args[4] && (args.length === 5 || (args.length === 6 && args[5] === '--force'))) {
        await verifyBrowserCaller(args[2]);
        printBrowserJson(await browserCloseTab(args[2], args[4], { force: args[5] === '--force' }));
      }
      else if (args[0] === 'screenshot' && args[1]) {
        const screenshotOptions = parseScreenshotOptions(args.slice(2));
        const tab = await selectedTab(args[1], screenshotOptions.tab ? ['--tab', screenshotOptions.tab] : []);
        const image = await browserScreenshot(args[1], tab);
        printBrowser(saveBrowserScreenshot(image, { out: screenshotOptions.out }));
      }
      else if (args[0] === 'navigate' && args[1] && args[2]) {
        await verifyBrowserCaller(args[1]);
        const tab = await selectedTab(args[1], args.slice(3));
        printBrowserJson(await browserNavigate(args[1], tab, args[2]));
      }
      else if (args[0] === 'click' && args[1] && args[2] && args[3]) {
        await verifyBrowserCaller(args[1]);
        const tab = await selectedTab(args[1], args.slice(4));
        await browserClick(args[1], tab, percent(args[2]), percent(args[3]));
        printBrowser('Click sent.');
      }
      else if (args[0] === 'hover' && args[1] && args[2] && args[3]) {
        await verifyBrowserCaller(args[1]);
        const tab = await selectedTab(args[1], args.slice(4));
        await browserHover(args[1], tab, percent(args[2], 'Hover coordinates'), percent(args[3], 'Hover coordinates'));
        printBrowser('Hover sent.');
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
        printBrowser('Drag sent.');
      }
      else if (args[0] === 'text' && args[1] && args[2] === '--stdin') {
        await verifyBrowserCaller(args[1]);
        const tab = await selectedTab(args[1], args.slice(3));
        await browserInsertText(args[1], tab, fs.readFileSync(0, 'utf8'));
        printBrowser('Text sent.');
      }
      else if (args[0] === 'key' && args[1] && args[2]) {
        await verifyBrowserCaller(args[1]);
        const tab = await selectedTab(args[1], args.slice(3));
        await browserKey(args[1], tab, args[2]);
        printBrowser('Key sent.');
      }
      else if (args[0] === 'bookmarks' && args[1] && args[2] === 'list' && args.length === 3) printBrowserJson(listBookmarks(args[1]));
      else if (args[0] === 'bookmarks' && args[1] && args[2] === 'add' && args[3] && args[4] && args.length === 5) {
        await verifyBrowserCaller(args[1]);
        printBrowserJson(addBookmark(args[1], { name: args[3], url: args[4] }));
      }
      else if (args[0] === 'bookmarks' && args[1] && args[2] === 'rm' && args[3] && args.length === 4) {
        await verifyBrowserCaller(args[1]);
        printBrowserJson(removeBookmark(args[1], args[3]));
      }
      else if (args[0] === 'bookmarks' && args[1] && args[2] === 'start' && args[3] && args.length === 4) {
        await verifyBrowserCaller(args[1]);
        printBrowserJson(setStartPage(args[1], args[3] === 'none' ? null : args[3]));
      }
      else if (args[0] === 'bookmarks' && args[1] && args[2] === 'open' && args[3] && (args.length === 4 || (args.length === 5 && args[4] === '--new-tab'))) {
        await verifyBrowserCaller(args[1]);
        const bookmark = listBookmarks(args[1]).bookmarks[Number(args[3])];
        if (!bookmark) throw new Error('Bookmark index is out of range.');
        if (args[4] === '--new-tab') printBrowserJson(await browserNewTab(args[1], bookmark.url));
        else printBrowserJson(await browserNavigate(args[1], null, bookmark.url));
      }
      else if (args[0] === 'request' && args[1] && args.includes('--headless') && args.includes('--visible')) throw new Error('Choose either --headless or --visible.');
      else if (args[0] === 'request' && args[1] && args.slice(2).every((flag) => ['--reserve', '--headless', '--visible'].includes(flag))) {
        await verifyBrowserCaller(args[1]);
        printBrowserJson(await requestBrowser(args[1], { launch: !args.includes('--reserve'), headless: args.includes('--headless') ? true : args.includes('--visible') ? false : null }));
      }
      else throw new Error('Usage: browser request|size|viewport|close|release|restart|list|tabs|tab new|tab close|screenshot|navigate|click|hover|drag|text|key|bookmarks|sweep-clones. Run herdr-boss without arguments for details.');
      break;
    }
    case 'handoff': {
      const { planHandoff, prepareHandoff, activateHandoff, cancelHandoff, markHandoffReady, listHandoffs } = await import('./handoff.js');
      const [action, target] = args;
      // A sandbox cannot write handoff records. Fail before the first Herdr call or file write.
      if (['prepare', 'activate', 'ready', 'cancel'].includes(action)) assertDataWritable();
      if (action === 'list') { console.log(JSON.stringify(listHandoffs(), null, 2)); break; }
      if (action === 'activate') { console.log(JSON.stringify(await activateHandoff(target, { confirmed: args.includes('--confirmed') }), null, 2)); break; }
      if (action === 'ready') { console.log(JSON.stringify(markHandoffReady(target), null, 2)); break; }
      if (action === 'cancel') {
        if (!target || args.length > 3 || (args.length === 3 && args[2] !== '--force')) throw new Error('Usage: handoff cancel ID [--force]');
        const result = cancelHandoff(target, { force: args.includes('--force') });
        console.log(result.closed ? `Cancelled handoff ${target}; closed successor pane ${result.item.newPane}.`
          : result.panePresent ? `Cancelled handoff ${target}; left pane ${result.item.newPane} open because it was not a safely closable successor pane.`
            : `Cancelled handoff ${target}; successor pane ${result.item.newPane} was already absent.`);
        break;
      }
      const value = (flag, fallback) => { const i = args.indexOf(flag); return i < 0 ? fallback : args[i + 1]; };
      const to = value('--to');
      if (!target || !to || !['plan', 'prepare'].includes(action)) throw new Error('Usage: handoff plan|prepare PANE --to KIND [--mode migrate|fresh] [--model MODEL] [--effort EFFORT] [--force]');
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
      const { acquireLease, releaseLease, bindLease, listLeases, leasePools } = await import('./leases.js');
      const { pools, errors: poolErrors } = leasePools(cfg);
      if (poolErrors.length) throw new Error(`The resourcePools setting in ${path.join(DATA_DIR, 'config.json')} is invalid:\n- ${poolErrors.join('\n- ')}`);
      const [action, ...rest] = args;
      const usage = 'Usage: lease acquire POOL [--for SLUG|WORKER] [--prefer ITEM] [--ttl MINUTES] [--pid PID] [--wait SECONDS] [--env-file FILE] | lease bind POOL ITEM --pid PID | lease release POOL ITEM | lease list [POOL]';
      if (action === 'list') {
        if (rest.length > 1) throw new Error(usage);
        listLeases({ pools, pool: rest[0] ?? null });
        break;
      }
      if (!['acquire', 'release', 'bind'].includes(action)) throw new Error(usage);
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
      const allowed = action === 'bind' ? ['--pid'] : ['--for', '--prefer', '--ttl', '--pid', '--wait', '--env-file'];
      for (let index = 0; index < rest.length; index += 1) {
        const token = rest[index];
        if (!token.startsWith('--')) { positional.push(token); continue; }
        if (!allowed.includes(token)) throw new Error(`Unknown option: ${token}. ${usage}`);
        if (token in flags) throw new Error(`${token} may be used only once.`);
        const value = rest[++index];
        if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value.`);
        flags[token] = value;
      }
      if (flags['--pid'] !== undefined && !/^[1-9]\d*$/.test(flags['--pid'])) throw new Error('--pid must be a positive whole number.');
      if (action === 'bind') {
        if (positional.length !== 2 || flags['--pid'] === undefined) throw new Error(usage);
        const bound = bindLease(positional[0], positional[1], Number(flags['--pid']), common);
        console.log(`Bound lease ${positional[0]} ${positional[1]} to process ${bound.pid}.`);
        break;
      }
      if (positional.length !== 1) throw new Error(usage);
      if (flags['--ttl'] !== undefined && !/^\d+$/.test(flags['--ttl'])) throw new Error('--ttl must be a positive whole number of minutes.');
      if (flags['--wait'] !== undefined && !/^\d+$/.test(flags['--wait'])) throw new Error('--wait must be a whole number of seconds.');
      acquireLease(positional[0], {
        ...common, forTarget: flags['--for'] ?? null, prefer: flags['--prefer'] ?? null,
        ttlMinutes: flags['--ttl'] === undefined ? null : Number(flags['--ttl']),
        pid: flags['--pid'] === undefined ? null : Number(flags['--pid']),
        waitSeconds: flags['--wait'] === undefined ? null : Number(flags['--wait']),
        envFile: flags['--env-file'] ?? null,
      });
      break;
    }
    case 'serve': {
      const usageServe = 'Usage: serve [--read-only-preview [--host <address>]]';
      const preview = args.includes('--read-only-preview');
      const hostAt = args.indexOf('--host');
      if (hostAt !== -1 && (!preview || args.indexOf('--host', hostAt + 1) !== -1 || hostAt === args.length - 1)) throw new Error(usageServe);
      const rest = args.filter((arg, i) => arg !== '--read-only-preview' && i !== hostAt && (hostAt === -1 || i !== hostAt + 1));
      if (rest.length || args.filter((arg) => arg === '--read-only-preview').length > 1) throw new Error(usageServe);
      const { serve, assertPreviewHost } = await import('./server.js');
      const previewHost = hostAt === -1 ? undefined : assertPreviewHost(args[hostAt + 1]);
      if (!preview) migrateAccessFiles(cfg);
      serve(cfg, { readOnlyPreview: preview, previewHost });
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
      const force = args.includes('--force');
      const sync = args.includes('--sync');
      const [slug, file] = args.filter((arg) => arg !== '--force' && arg !== '--sync');
      if (!slug || !file) { console.error('usage: herdr-boss publish <slug> <file|-> [--force] [--sync]'); process.exit(2); }
      const text = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
      const data = JSON.parse(text);
      let top = null;
      try { top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch {}
      // The kit files live in the registered repository of the slug. Without a registration, the Git top level holds them.
      let kitRoot = top;
      try {
        const { readProjectRepos } = await import('./harness.js');
        const registered = readProjectRepos().find((row) => row.slug === slug)?.repo;
        if (registered && fs.existsSync(registered)) kitRoot = registered;
      } catch {}
      // Refresh a behind kit first, then set kitRevision from the disk copy, so a stale status shows no false gap.
      let refresh = null;
      if (kitRoot && data && typeof data === 'object' && !Array.isArray(data)) {
        const { installedKitRevision, safeRefreshKit } = await import('./kit/agents-check.js');
        refresh = safeRefreshKit(kitRoot);
        const disk = installedKitRevision(kitRoot);
        if (disk) data.kitRevision = disk;
      }
      // Check AGENTS.md at the Git top level. Findings are warnings here; the status still publishes.
      const agentsFile = top && path.join(top, 'AGENTS.md');
      if (agentsFile && fs.existsSync(agentsFile) && data && typeof data === 'object' && !Array.isArray(data)) {
        const { checkAgentsFile } = await import('./kit/agents-check.js');
        const result = checkAgentsFile(agentsFile, { rulesFile: path.join(DATA_DIR, 'rules.json'), relative: 'AGENTS.md' });
        for (const line of result.lines) console.error(`warning: ${line.includes(".md line") ? line : `AGENTS.md ${line}`}`);
        if (result.findings.length) console.error(`warning: ${result.summary}. Run herdr-boss check agents.`);
        data.agentsCheck = { checkedAt: new Date().toISOString(), errors: result.errors, warnings: result.warnings, file: result.file };
      }
      // The worker facts of this repository. Only a working or blocked agent counts. When Herdr lists nothing, no
      // worker is live. A failed read gives no facts.
      let projectConfig = null;
      let workerFacts = null;
      const readFacts = async () => {
        if (workerFacts) return workerFacts;
        workerFacts = [];
        try {
          const { readWorkerFacts, gitIsMerged, agentStatuses } = await import('./task-state.js');
          const { createHerdrRunner } = await import('./kit/workers.js');
          projectConfig = loadProjectConfig({ cwd: top });
          let statuses = null;
          try { statuses = agentStatuses(createHerdrRunner()(['agent', 'list'])); } catch {}
          workerFacts = readWorkerFacts(projectConfig.runsPath, {
            isLive: (run) => Boolean(statuses?.has(run.name)),
            agentStatus: (run) => statuses?.get(run.name) ?? null,
            isMerged: gitIsMerged(projectConfig.root),
          });
        } catch {}
        return workerFacts;
      };
      if (sync) {
        if (top && data && typeof data === 'object' && Array.isArray(data.tasks)) {
          const { syncStatuses } = await import('./board-sync.js');
          const { readCommits, readIssues } = await import('./board-facts.js');
          const workers = await readFacts();
          const branch = projectConfig?.baseBranch || 'main';
          const changed = syncStatuses(data, { workers, facts: { commits: await readCommits(top, { branch }), issues: await readIssues(top) } });
          for (const { id, from, to, commit } of changed) {
            const evidence = commit ? ` (${commit.short}: ${commit.subject.slice(0, 60)})` : '';
            console.error(`sync: ${id} ${from} -> ${to}${evidence}`);
          }
          console.log(`synced ${changed.length} ${changed.length === 1 ? 'card' : 'cards'} from git and workers`);
        } else console.error('warning: --sync needs a Git repository and a status with tasks. No card changed.');
      }
      if (!force && top && data && typeof data === 'object' && Array.isArray(data.tasks)) {
        // A live worker on a task that is not doing means the status is wrong. A failed check never blocks a publish.
        let conflicts = [];
        try {
          const { publishConflicts } = await import('./task-state.js');
          conflicts = publishConflicts(data, await readFacts());
        } catch {}
        if (conflicts.length) {
          for (const line of conflicts) console.error(`error: ${line}.`);
          console.error(`Nothing was published. Set each of these tasks to doing, or run herdr-boss publish ${slug} <file> --force to publish anyway.`);
          process.exit(1);
        }
      }
      // Keep the stored status small: only the newest done tasks stay. The removed ones go into doneCount.
      let previous = null;
      if (SLUG.test(slug)) try { previous = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, `${slug}.json`), 'utf8')); } catch {}
      const submitted = structuredClone(data);
      const moved = SLUG.test(slug) ? capDoneTasks(data, previous) : 0;
      const errors = writeProject(slug, data);
      if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
      // A failed Mailbox update does not fail the publish.
      const { closeResolvedOnPublish } = await import('./messages.js');
      closeResolvedOnPublish(slug, submitted, { previous, log: (line) => console.log(line), warn: (line) => console.error(`warning: ${line}`) });
      const storedBytes = Buffer.byteLength(JSON.stringify(data, null, 2));
      if (storedBytes > STATUS_WARN_BYTES) console.error(`warning: the status is larger than 200 KB (${Math.round(storedBytes / 1024)} KB). Shorten notes and task text.`);
      for (const warning of statusWarnings(data)) console.error(`Warning: ${warning}`);
      if (kitRoot) {
        const { kitBehindLine } = await import('./kit/agents-check.js');
        if (refresh?.line) console.error(refresh.line);
        const line = refresh?.status === 'refreshed' ? null : kitBehindLine(kitRoot);
        if (line) console.error(line);
      }
      console.log(`published ${dashboardUrl(cfg)}/projects/${slug}`);
      if (moved) console.log(`moved ${moved} done ${moved === 1 ? 'task' : 'tasks'} into doneCount`);
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
      } else if (action === 'change') {
        // The label is every word that is not the harness or the --date option, so an unquoted label works.
        const words = [];
        let date;
        for (let i = 0; i < flags.length; i += 1) {
          if (flags[i] === '--date') {
            date = flags[i + 1];
            if (date === undefined || date.startsWith('--')) throw new Error('Usage: harness change <harness> <label> [--date YYYY-MM-DD]. The option --date needs a date.');
            i += 1;
          } else words.push(flags[i]);
        }
        const [harness, ...label] = words;
        if (!harness || !label.length) throw new Error('Usage: harness change <harness> <label> [--date YYYY-MM-DD]');
        const { appendHarnessChange, assertHarnessChangeCaller } = await import('./harness-changes.js');
        const { createHerdrRunner } = await import('./kit/workers.js');
        assertHarnessChangeCaller(process.env, createHerdrRunner());
        assertDataWritable();
        const entry = appendHarnessChange(DATA_DIR, { harness, label: label.join(' '), date });
        console.log(`Recorded the harness change: ${entry.date} ${entry.harness} ${entry.label}`);
      } else throw new Error('Usage: harness check [--live-codex] | harness sync [--dry-run] [--codex-only] | harness change <harness> <label> [--date YYYY-MM-DD]');
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
      // service.log rotates by size. Before the first start of a server that writes it, show the launchd file.
      const rotating = path.join(DATA_DIR, 'service.log');
      const file = fs.existsSync(rotating) ? rotating : path.join(DATA_DIR, 'server.log');
      process.stdout.write(fs.readFileSync(file, 'utf8').split('\n').slice(-100).join('\n'));
      break;
    }
    default:
      process.stdout.write(USAGE);
      process.exit(cmd ? 2 : 0);
  }
}

let directInvocation = false;
if (process.argv[1]) {
  const argvPath = path.resolve(process.argv[1]);
  const modulePath = path.resolve(fileURLToPath(import.meta.url));
  try {
    directInvocation = fs.realpathSync(argvPath) === fs.realpathSync(modulePath);
  } catch {
    directInvocation = argvPath === modulePath;
  }
}

if (directInvocation) {
  main().catch((error) => {
    const e = sandboxWriteError(error);
    const full = process.argv.includes('--full');
    const message = process.argv[2] === 'browser'
      ? maskBrowserText(e.message, { full })
      : maskCliError(e.message, { full });
    console.error(message);
    process.exit(e.exitCode ?? 1);
  });
}
