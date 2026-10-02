import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULT_RULES_FILE, findGitRoot, loadModels, loadProjectConfig } from './config.js';
import os from 'node:os';
import { mergeModels, providerFor } from '../control.js';
import { activeLaunchRecords, enableModel, markModelUnavailable } from './model-unavailable.js';
import { appendDelegatedRun, compareChangedPaths, gitStatusPaths, readDelegatedRuns, readJson, validateAllowedPaths, validateDelegatedRun, normalizeWorkerReport, validateWorkerReport } from './orchestration.js';
import { buildGhArgs, buildGhLabelArgs, buildGhMilestoneArgs, loadLabelPreset, parseLabelSync } from './gh.js';
import { cleanGhEnv, ghRunner, originRepo, syncLabels } from '../gh-labels.js';
import { allowWorkerScope, collectWorker, createHerdrRunner, listWorkers, parkWorker, startWorker } from './workers.js';
import { pruneWorktrees } from './worktrees.js';
import { acquireProjectLock, listProjectLocks, pushWithLock, releaseProjectLock } from './locks.js';
import { SUITE_WAIT_SECONDS, listSuitePasses, runSuite } from './suite.js';
import { agentsBlock, checkAgentsFile, installedKitRevision, installKit, kitChangesSince, kitRequiredBehind, kitRevision, kitRevisionState, KIT_FILE, KIT_STATES, rulesPolicy } from './agents-check.js';
import { loadConfig } from '../config.js';
import { listProjects } from '../projects.js';
import { createWaitHerdr, parseWaitArgs, waitForWorkers } from './wait.js';

const USAGE = `Kit commands:
  worker start <name> --kind <kind> (--task TEXT | --task-file FILE) [--task-id ID] [--lease POOL]... [--planner] [options]
  worker collect <name> [--no-record] [--keep-pane] [--allow PATH]... [--outcome done|partial|failed --gate-passed|--gate-failed]
  worker list
  wait [<worker>...] [--timeout SECONDS] [--stall SECONDS]
  worker park <name> --reason TEXT | worker unpark <name>
  worker allow <name> <path>... --reason TEXT
  worker scope add <name> <path>... --reason TEXT
  lock acquire <name> [--wait SECONDS] | lock release <name> [--slot long|N] | lock list
  push [git push arguments]
  suite [--wait SECONDS] [--keep NAME]... [--reuse] -- <command...> | suite --list-passes
  worktree prune [--apply] [--no-archive]
  ledger append --entry FILE | ledger check [--runs]
  check --report FILE | --run FILE | --worktree DIR --allow PATH...
  check agents [FILE]
  check kit
  kit install [--no-hook]
  kit update [--quiet]
  kit block
  gh issue create|comment|edit ... --body-file FILE
  gh label create|list|edit|sync ...
  gh milestone create|list ...
  models [--kind KIND]
`;

function fail(message, code = 2) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

function parseArgs(argv, { boolean = [], repeat = [] } = {}) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) { positional.push(token); continue; }
    const key = token.slice(2).replaceAll('-', '');
    if (boolean.includes(token)) {
      if (key in flags) fail(`${token} may be used only once.`);
      flags[key] = true;
      continue;
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) fail(`${token} needs a value.`);
    if (repeat.includes(token)) (flags[key] ??= []).push(value);
    else if (key in flags) fail(`${token} may be used only once.`);
    else flags[key] = value;
  }
  return { positional, flags };
}

function filePath(root, value) { return path.isAbsolute(value) ? value : path.resolve(root, value); }
function valid(errors, label) { if (errors.length) fail(`${label}: FAIL\n- ${errors.join('\n- ')}`, 1); }
function knownFlags(flags, allowed) {
  const unknown = Object.keys(flags).filter((key) => !allowed.includes(key));
  if (unknown.length) fail(`Unknown option: --${unknown[0]}.`);
}

export { installedKitRevision };

// The digest lines of a kit update, oldest change first. The digest names the impact and the
// summary of every change. With no change it gives one line.
export function formatKitDigest(installed, changes) {
  if (!changes.length) {
    return [installed
      ? `kit update: installed kit revision ${installed} is current (no recorded change)`
      : 'kit update: no installed kit revision found (no recorded change)'];
  }
  return [
    installed
      ? `kit update: ${changes.length} kit change(s) since installed revision ${installed}`
      : `kit update: installed kit revision is unknown; showing all ${changes.length} known change(s)`,
    ...changes.map((change) => `  ${change.impact}: ${change.summary ?? change.revision} (${change.revision})`),
  ];
}

function herdrList(result, key) {
  if (Array.isArray(result?.[key])) return result[key];
  return Array.isArray(result) ? result : null;
}
function herdrAgentName(agent) { return agent?.name ?? agent?.agent_name ?? null; }
function herdrPaneId(value) { return value?.pane_id ?? value?.paneId ?? value?.id ?? null; }
function herdrWorkspace(value) { return value?.workspace_id ?? value?.workspaceId ?? value?.workspace ?? null; }

function commandKit(command, argv, { output = console.log, env = process.env, herdr = null, config: injectedConfig = null, serviceConfig: injectedServiceConfig = null, schedulePaneCloseFn, rulesFile = DEFAULT_RULES_FILE, lockDataDir, now, pause, pidAlive, pushStdio, suiteStdio } = {}) {
  herdr ??= command === 'wait' ? createWaitHerdr(createHerdrRunner) : createHerdrRunner();
  if (command === 'models') {
    const modelConfig = mergeModels(loadModels(), rulesPolicy(rulesFile));
    const { positional, flags } = parseArgs(argv);
    if (positional[0] === 'enable' || positional[0] === 'disable') {
      const usage = 'Usage: models enable KIND/MODEL | models disable KIND/MODEL [--reason TEXT]';
      const target = positional[1] ?? '';
      const split = target.indexOf('/');
      const kind = split > 0 ? target.slice(0, split) : '';
      const model = split > 0 ? target.slice(split + 1) : '';
      if (positional.length !== 2 || !model || Object.keys(flags).some((key) => key !== 'reason' || positional[0] === 'enable')) fail(usage);
      if (!modelConfig.kinds[kind]) fail(`Unknown model kind: ${kind}.`);
      if (!modelConfig.kinds[kind].allowedModels.includes(model)) fail(`Model ${model} is not allowed for ${kind}.`);
      const dir = env.HERDR_BOSS_DIR || path.join(os.homedir(), '.herdr-boss');
      if (positional[0] === 'enable') {
        const removed = enableModel(dir, kind, model);
        output(removed ? `Enabled ${kind}/${model}.` : `${kind}/${model} had no unavailable record.`);
        return { kind, model, enabled: removed };
      }
      const reason = typeof flags.reason === 'string' && flags.reason ? flags.reason : 'disabled by the Owner';
      const record = markModelUnavailable(dir, { kind, model, provider: providerFor(kind, model, rulesPolicy(rulesFile)), untilReenabled: true, label: reason, reason });
      output(`Disabled ${kind}/${model} until it is re-enabled with herdr-boss models enable ${kind}/${model}.`);
      return record;
    }
    if (positional.length || Object.keys(flags).some((key) => key !== 'kind')) fail('Usage: models [--kind KIND] | models enable KIND/MODEL | models disable KIND/MODEL [--reason TEXT]');
    if (flags.kind && !modelConfig.kinds[flags.kind]) fail(`Unknown model kind: ${flags.kind}.`);
    let unavailableModels = {};
    try { unavailableModels = JSON.parse(fs.readFileSync(rulesFile, 'utf8')).unavailableModels || {}; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const activeUnavailable = [...Object.values(unavailableModels), ...activeLaunchRecords(env.HERDR_BOSS_DIR || path.join(os.homedir(), '.herdr-boss'))].filter((item) => typeof item?.model === 'string' && typeof item?.kind === 'string'
      && modelConfig.kinds[item.kind]?.allowedModels.includes(item.model)
      && Number.isSafeInteger(item.retryAt) && item.retryAt > Date.now());
    // localModels lists the models that come from the policy extraModels and not from kit/models.json.
    const base = loadModels().kinds;
    const kinds = Object.fromEntries(Object.entries(modelConfig.kinds).map(([kind, cfg]) => {
      const localModels = cfg.allowedModels.filter((model) => !base[kind]?.allowedModels.includes(model));
      const cooldowns = activeUnavailable.filter((item) => item.kind === kind && cfg.allowedModels.includes(item.model)).sort((a, b) => a.model.localeCompare(b.model));
      return [kind, { ...cfg, ...(localModels.length ? { localModels } : {}), ...(cooldowns.length ? { unavailableModels: cooldowns } : {}) }];
    }));
    const result = flags.kind ? { [flags.kind]: kinds[flags.kind] } : kinds;
    output(JSON.stringify(result, null, 2));
    return result;
  }

  if (command === 'kit') {
    const usage = 'Usage: kit install [--no-hook] | kit update [--quiet] | kit block';
    if (argv[0] === 'block') {
      // kit block prints the AGENTS.md stub, for old instructions.
      if (argv.length !== 1) fail(usage);
      const result = agentsBlock();
      output(result.block.trimEnd());
      return result;
    }
    if (argv[0] === 'update') {
      if (argv.length > 2 || argv.slice(1).some((flag) => flag !== '--quiet')) fail(usage);
      const root = injectedConfig?.root ?? findGitRoot();
      const installed = installedKitRevision(root);
      const changes = kitChangesSince(installed);
      const result = installKit(root);
      const quiet = argv.includes('--quiet');
      // A quiet update on a current project prints nothing: no digest, no summary, and no file written.
      if (quiet && !changes.length && !result.written.length) return { ...result, installed, changes };
      for (const line of formatKitDigest(installed, changes)) output(line);
      if (!quiet) {
        for (const file of result.written) output(`wrote ${file}`);
        for (const file of result.unchanged) output(`unchanged ${file}`);
        // The kit file follows, so a session with a stale copy loads the current rules.
        output(fs.readFileSync(path.join(root, KIT_FILE), 'utf8').trimEnd());
      }
      output(`kit update: kit revision ${result.revision}, stub ${result.hash}, in ${root}`);
      return { ...result, installed, changes };
    }
    if (argv[0] !== 'install' || argv.slice(1).some((flag) => flag !== '--no-hook') || argv.length > 2) fail(usage);
    const root = injectedConfig?.root ?? findGitRoot();
    const result = installKit(root, { hook: !argv.includes('--no-hook') });
    for (const file of result.written) output(`wrote ${file}`);
    for (const file of result.unchanged) output(`unchanged ${file}`);
    output(`kit install: kit revision ${result.revision}, stub ${result.hash}, in ${root}`);
    return result;
  }

  if (command === 'check' && argv[0] === 'kit') {
    if (argv.length !== 1) fail('Usage: check kit');
    const current = injectedConfig?.currentKitRevision ?? kitRevision();
    const entries = injectedConfig?.kitChanges;
    const rows = listProjects().map((project) => {
      const loaded = typeof project.kitRevision === 'string' && project.kitRevision ? project.kitRevision : null;
      const state = kitRevisionState(loaded, current, entries);
      const c = project.agentsCheck;
      const counts = c && Number.isInteger(c.errors) && Number.isInteger(c.warnings) ? `${c.errors} errors, ${c.warnings} warnings` : 'not published';
      const installed = typeof project.installedKitRevision === 'string' && project.installedKitRevision ? project.installedKitRevision : null;
      const requiredBehind = kitRequiredBehind(loaded, current, entries);
      const gap = requiredBehind ? `; ${requiredBehind} required change${requiredBehind === 1 ? '' : 's'} behind` : '';
      output(`${project.slug}: kit revision ${loaded ?? 'none'} (${state})${gap}; installed ${installed ?? 'none'}; agents check ${counts}`);
      return { slug: project.slug, kitRevision: loaded, installedKitRevision: installed, requiredBehind, state, agentsCheck: c ?? null };
    });
    const count = (state) => rows.filter((row) => row.state === state).length;
    const required = count(KIT_STATES.required);
    const useful = count(KIT_STATES.useful);
    const unpublished = count(KIT_STATES.unpublished);
    let nameErrors = 0;
    let agents = null;
    try { agents = herdrList(herdr(['agent', 'list']), 'agents'); } catch {}
    if (!agents) output('WARNING: Herdr agent list is unavailable; orchestrator agent names were not checked.');
    else {
      let panes = null;
      try { panes = herdrList(herdr(['pane', 'list']), 'panes'); } catch {}
      if (!panes) output('WARNING: Herdr pane list is unavailable; orchestrator agent names were not checked.');
      else {
        const agentsByPane = new Map(agents.map((agent) => [herdrPaneId(agent), agent]));
        const projectsByWorkspace = new Map();
        for (const project of listProjects()) {
          if (typeof project.workspace !== 'string' || !project.workspace) continue;
          const projects = projectsByWorkspace.get(project.workspace) ?? [];
          projects.push(project);
          projectsByWorkspace.set(project.workspace, projects);
        }
        for (const pane of panes) {
          const paneId = herdrPaneId(pane);
          const agent = agentsByPane.get(paneId);
          if (!paneId || !agent) continue;
          const name = herdrAgentName(agent) ?? '(unknown)';
          if (pane.label === 'orch') {
            for (const project of projectsByWorkspace.get(herdrWorkspace(pane)) ?? []) {
              const expected = `${project.slug}-orch`;
              if (name === expected) continue;
              output(`${project.slug}: orchestrator agent is named ${name}; rename it with herdr agent rename ${paneId} ${expected}`);
              nameErrors += 1;
            }
          } else if (pane.label === 'boss' && name !== 'boss') {
            output(`boss: Boss agent is named ${name}; rename it with herdr agent rename ${paneId} boss`);
            nameErrors += 1;
          }
        }
      }
    }
    const failCheck = required || unpublished || nameErrors;
    const stateSummary = [
      required ? `${required} ${KIT_STATES.required}` : null,
      useful ? `${useful} ${KIT_STATES.useful}` : null,
      unpublished ? `${unpublished} ${KIT_STATES.unpublished}` : null,
    ].filter(Boolean).map((text) => `, ${text}`).join('');
    const nameSummary = nameErrors ? `; ${nameErrors} wrong agent name${nameErrors === 1 ? '' : 's'}` : '';
    output(`check kit: ${failCheck ? 'FAIL' : 'PASS'} (current revision ${current}; ${rows.length} projects${stateSummary}${nameSummary})`);
    return { current, projects: rows, nameErrors, exitCode: failCheck ? 1 : 0 };
  }

  if (command === 'check' && argv[0] === 'agents') {
    if (argv.length > 2 || argv.slice(1).some((value) => value.startsWith('--'))) fail('Usage: check agents [FILE]');
    const root = argv[1] ? null : (injectedConfig?.root ?? findGitRoot());
    const file = argv[1] ? path.resolve(argv[1]) : path.join(root, 'AGENTS.md');
    if (!fs.existsSync(file)) fail(`No such file: ${file}`, 1);
    const result = checkAgentsFile(file, { rulesFile, relative: argv[1] ?? 'AGENTS.md' });
    for (const line of result.lines) output(line);
    output(`check agents: ${result.errors ? 'FAIL' : 'PASS'} (${result.summary})`);
    return { ...result, exitCode: result.errors ? 1 : 0 };
  }

  const config = injectedConfig ?? loadProjectConfig();
  const modelConfig = command === 'worker' ? loadModels() : null;
  if (command === 'wait') {
    const { names, timeoutSeconds, stallSeconds } = parseWaitArgs(argv);
    let stall = stallSeconds;
    if (stall === null) stall = injectedConfig ? null : loadConfig().workers.staleIdleMinutes * 60;
    return waitForWorkers(names, { config, herdr, output, now, pause, timeoutSeconds, ...(stall ? { stallSeconds: stall } : {}) });
  }
  if (command === 'lock') {
    const [action, ...rest] = argv;
    if (action === 'acquire') {
      const { positional, flags } = parseArgs(rest);
      if (positional.length !== 1) fail('Usage: lock acquire <name> [--wait SECONDS]');
      knownFlags(flags, ['wait']);
      const waitSeconds = flags.wait === undefined ? null : Number(flags.wait);
      if (waitSeconds !== null && (!/^\d+$/.test(flags.wait) || !Number.isSafeInteger(waitSeconds))) {
        fail('--wait must be a whole non-negative number of seconds.');
      }
      return acquireProjectLock(positional[0], {
        config, env, herdr, dataDir: lockDataDir, waitSeconds, output, now, pause, pidAlive,
      });
    }
    if (action === 'release') {
      const { positional, flags } = parseArgs(rest);
      if (positional.length !== 1) fail('Usage: lock release <name> [--slot long|N]');
      knownFlags(flags, ['slot']);
      const slot = flags.slot === undefined ? null : flags.slot === 'long' ? 'long' : /^[1-4]$/.test(flags.slot) ? Number(flags.slot) : NaN;
      if (Number.isNaN(slot)) fail('--slot must be long or an integer from 1 to 4.');
      return releaseProjectLock(positional[0], {
        config, env, herdr, dataDir: lockDataDir, output, pidAlive, now, slot,
      });
    }
    if (action === 'list') {
      if (rest.length) fail('Usage: lock list');
      return listProjectLocks({ config, env, herdr, dataDir: lockDataDir, output, pidAlive, now });
    }
    fail('Usage: lock acquire <name> [--wait SECONDS] | lock release <name> [--slot long|N] | lock list');
  }
  if (command === 'push') {
    // All arguments go to git push unchanged.
    return pushWithLock(argv, { config, env, herdr, dataDir: lockDataDir, output, now, pause, pidAlive, stdio: pushStdio, rulesFile });
  }
  if (command === 'suite') {
    // The options come before --. Everything after -- is the command.
    const usage = 'Usage: suite [--wait SECONDS] [--keep NAME]... [--reuse] -- <command...> | suite --list-passes';
    if (argv[0] === '--list-passes') {
      if (argv.length !== 1) fail(usage);
      return listSuitePasses({ dataDir: lockDataDir, output, herdr, pidAlive, now });
    }
    const separator = argv.indexOf('--');
    if (separator < 0 || separator === argv.length - 1) fail(usage);
    const { positional, flags } = parseArgs(argv.slice(0, separator), { boolean: ['--reuse'], repeat: ['--keep'] });
    if (positional.length) fail(usage);
    knownFlags(flags, ['wait', 'keep', 'reuse']);
    if (flags.wait !== undefined && !/^\d+$/.test(flags.wait)) fail('--wait must be a whole non-negative number of seconds.');
    const waitSeconds = flags.wait === undefined ? SUITE_WAIT_SECONDS : Number(flags.wait);
    if (!Number.isSafeInteger(waitSeconds)) fail('--wait must be a whole non-negative number of seconds.');
    return runSuite(argv.slice(separator + 1), {
      config, env, herdr, dataDir: lockDataDir, waitSeconds, keep: flags.keep ?? [], reuse: flags.reuse ?? false, output, now, pause, pidAlive, stdio: suiteStdio, rulesFile,
    });
  }
  if (command === 'worker') {
    const [action, ...rest] = argv;
    if (action === 'start') {
      const { positional, flags } = parseArgs(rest, { boolean: ['--no-worktree', '--dry-run', '--force', '--force-swap', '--read-only', '--planner'], repeat: ['--allow', '--copy', '--lease'] });
      if (positional.length !== 1) fail('Usage: worker start <name> --kind <kind> --task TEXT [options]');
      knownFlags(flags, ['kind', 'model', 'effort', 'issue', 'taskid', 'task', 'taskfile', 'allow', 'copy', 'lease', 'base', 'orch', 'noworktree', 'dryrun', 'force', 'forceswap', 'readonly', 'planner']);
      try { return startWorker(positional[0], {
        kind: flags.kind,
        model: flags.model,
        effort: flags.effort,
        issue: flags.issue,
        taskId: flags.taskid,
        task: flags.task,
        taskFile: flags.taskfile,
        allow: flags.allow ?? [],
        copy: flags.copy ?? [],
        lease: flags.lease ?? [],
        base: flags.base,
        orch: flags.orch,
        noWorktree: flags.noworktree,
        readOnly: flags.readonly,
        dryRun: flags.dryrun,
        force: flags.force,
        forceSwap: flags.forceswap,
        planner: flags.planner,
      }, {
        config, models: modelConfig, herdr, env, output, rulesFile,
        projectStatus: flags.taskid == null && flags.issue == null
          ? listProjects().find((project) => project.slug === config.slug) || null
          : null,
        now: typeof now === 'function' ? now() : now,
      }); }
      catch (error) {
        if (!/\nSTART FAILED: /.test(error.message)) error.message = `${error.message}\nSTART FAILED: ${error.message.split('\n')[0]}`;
        throw error;
      }
    }
    if (action === 'park' || action === 'unpark') {
      const { positional, flags } = parseArgs(rest);
      if (positional.length !== 1) fail(`Usage: worker ${action} <name>${action === 'park' ? ' --reason TEXT' : ''}`);
      knownFlags(flags, action === 'park' ? ['reason'] : []);
      return parkWorker(positional[0], { reason: flags.reason, unpark: action === 'unpark' }, { config, herdr, output });
    }
    if (action === 'collect') {
      const { positional, flags } = parseArgs(rest, { boolean: ['--record', '--no-record', '--gate-passed', '--gate-failed', '--keep-pane'], repeat: ['--allow'] });
      if (positional.length !== 1) fail('Usage: worker collect <name> [options]');
      knownFlags(flags, ['record', 'norecord', 'allow', 'outcome', 'gatepassed', 'gatefailed', 'keeppane', 'defects', 'rework', 'modelresult', 'modelreason']);
      if (flags.record && flags.norecord) fail('Use either --record or --no-record, not both.');
      const serviceConfig = injectedServiceConfig ?? loadConfig();
      return collectWorker(positional[0], {
        record: flags.record,
        noRecord: flags.norecord,
        allow: flags.allow ?? [],
        keepPane: flags.keeppane,
        paneCloseDelayMinutes: serviceConfig.workers?.paneCloseDelayMinutes ?? 2,
        outcome: flags.outcome,
        gatePassed: flags.gatepassed,
        gateFailed: flags.gatefailed,
        defects: flags.defects == null ? 0 : Number(flags.defects),
        rework: flags.rework == null ? 0 : Number(flags.rework),
        modelResult: flags.modelresult || null,
        modelReason: flags.modelreason || null,
      }, { config, output, schedulePaneCloseFn });
    }
    if (action === 'allow') {
      const { positional, flags } = parseArgs(rest);
      knownFlags(flags, ['reason']);
      if (positional.length < 2) fail('Usage: worker allow <name> <path>... --reason TEXT');
      const [name, ...paths] = positional;
      return allowWorkerScope(name, { paths, reason: flags.reason }, { config, herdr, env, output });
    }
    if (action === 'scope') {
      const [scopeAction, ...scopeArgs] = rest;
      if (scopeAction !== 'add') fail('Usage: worker scope add <name> <path>... --reason TEXT');
      const { positional, flags } = parseArgs(scopeArgs);
      knownFlags(flags, ['reason']);
      if (positional.length < 2) fail('Usage: worker scope add <name> <path>... --reason TEXT');
      const [name, ...paths] = positional;
      return allowWorkerScope(name, { paths, reason: flags.reason }, { config, herdr, env, output });
    }
    if (action === 'list') {
      if (rest.length) fail('Usage: worker list');
      return listWorkers(config, { herdr, output });
    }
    fail('Usage: worker start|collect|list|park|unpark|allow|scope add');
  }

  if (command === 'worktree') {
    const [action, ...rest] = argv;
    if (action !== 'prune') fail('Usage: worktree prune [--apply] [--no-archive]');
    const { positional, flags } = parseArgs(rest, { boolean: ['--apply', '--no-archive'] });
    knownFlags(flags, ['apply', 'noarchive']);
    if (positional.length) fail('Usage: worktree prune [--apply] [--no-archive]');
    return pruneWorktrees(config, { apply: flags.apply, archive: !flags.noarchive, herdr, output });
  }

  if (command === 'ledger') {
    const [action, ...rest] = argv;
    const { flags } = parseArgs(rest, { boolean: ['--runs'] });
    knownFlags(flags, ['entry', 'file', 'runs']);
    const ledgerPath = flags.file ? filePath(config.root, flags.file) : config.ledgerPath;
    if (action === 'append' && flags.entry) {
      const entry = readJson(filePath(config.root, flags.entry));
      appendDelegatedRun(ledgerPath, entry, { evidenceTiers: config.evidenceTiers });
      output(`ledger: appended ${ledgerPath}`);
      return;
    }
    if (action === 'check') {
      const checkLedgerPath = flags.file ? filePath(config.mainRoot ?? config.root, flags.file) : config.ledgerPath;
      const runs = readDelegatedRuns(checkLedgerPath, { evidenceTiers: config.evidenceTiers });
      if (flags.runs) {
        // Every run record needs a ledger entry for its worktree, except a worker that is still running.
        const recorded = new Set(runs.map((run) => path.resolve(run.worktree)));
        let live = new Set();
        try { live = new Set((herdr(['agent', 'list']).agents || []).map((agent) => agent.name).filter(Boolean)); } catch {}
        const records = (fs.existsSync(config.runsPath) ? fs.readdirSync(config.runsPath) : []).filter((file) => file.endsWith('.json'))
          .map((file) => readJson(path.join(config.runsPath, file)));
        const running = records.filter((record) => live.has(record.name) && !record.finishedAt);
        const missing = records.filter((record) => !recorded.has(path.resolve(record.worktree)) && !running.includes(record));
        if (missing.length) fail(`ledger: ${missing.length} run record(s) have no ledger entry:\n${missing.map((record) => `- ${record.name} (${record.worktree}, started ${record.startedAt})`).join('\n')}\nRecord each one with herdr-boss worker collect <name> --record, or append it with herdr-boss ledger append --entry FILE.`, 1);
        output(`ledger: PASS (${runs.length} entries; ${records.length} run records, ${running.length} still running)`);
        return runs;
      }
      output(`ledger: PASS (${runs.length} entries)`);
      return runs;
    }
    fail('Usage: ledger append --entry FILE | ledger check [--runs]');
  }

  if (command === 'check') {
    const { positional, flags } = parseArgs(argv, { repeat: ['--allow'] });
    knownFlags(flags, ['report', 'run', 'worktree', 'allow']);
    if (positional.length) fail('Usage: check --report FILE | --run FILE | --worktree DIR --allow PATH...');
    const targets = ['report', 'run', 'worktree'].filter((key) => flags[key]);
    if (targets.length > 1) fail('Use only one of --report, --run, or --worktree.');
    if (flags.report) {
      const normalized = normalizeWorkerReport(readJson(filePath(config.root, flags.report)));
      for (const warning of normalized.warnings) output(warning);
      const report = normalized.report;
      valid(validateWorkerReport(report, { evidenceTiers: config.evidenceTiers }), 'worker report');
      output('check: PASS (worker report)');
      return report;
    }
    if (flags.run) {
      const run = readJson(filePath(config.root, flags.run));
      valid(validateDelegatedRun(run, { evidenceTiers: config.evidenceTiers }), 'delegated run');
      output('check: PASS (delegated run)');
      return run;
    }
    if (flags.worktree) {
      const allowed = flags.allow ?? [];
      if (!allowed.length) fail('--allow is required with --worktree.');
      valid(validateAllowedPaths(allowed), 'allowed paths');
      const directory = filePath(config.root, flags.worktree);
      const actual = gitStatusPaths(directory);
      const disallowed = compareChangedPaths(actual, allowed);
      if (disallowed.length) fail(`worktree scope: FAIL\n- paths outside --allow: ${disallowed.join(', ')}.`, 1);
      output(`check: PASS (worktree scope, ${actual.length} changed paths)`);
      return { actual, disallowed };
    }
    fail('Usage: check --report FILE | --run FILE | --worktree DIR --allow PATH...');
  }

  if (command === 'gh') {
    const GH_USAGE = 'Usage: gh issue create|comment|edit ... --body-file FILE | gh label create|list|edit|sync ... | gh milestone create|list ...';
    const [group, action, ...ghArgs] = argv;
    if (!['issue', 'label', 'milestone'].includes(group)) fail(GH_USAGE);
    if (group === 'label' && action === 'sync') {
      const { preset, dryRun } = parseLabelSync(ghArgs);
      const labels = loadLabelPreset(preset);
      const result = syncLabels(labels, ghRunner({ cwd: config.root, env }), { repo: originRepo(config.root), dryRun });
      for (const line of result.lines) output(line);
      return result;
    }
    // A label or milestone command acts on the repository of origin, named on the command line.
    const built = group === 'issue' ? buildGhArgs(action, ghArgs)
      : group === 'label' ? buildGhLabelArgs(action, ghArgs, { repo: ['create', 'edit', 'list'].includes(action) ? originRepo(config.root) : undefined })
        : buildGhMilestoneArgs(action, ghArgs, { repo: ['create', 'list'].includes(action) ? originRepo(config.root) : undefined });
    execFileSync('gh', built, { cwd: config.root, env: group === 'issue' ? env : cleanGhEnv(env), stdio: 'inherit' });
    return;
  }

  fail(USAGE);
}

export function runKitCommand(command, argv = process.argv.slice(3), options = {}) {
  return commandKit(command, argv, options);
}

export { USAGE as KIT_USAGE };
