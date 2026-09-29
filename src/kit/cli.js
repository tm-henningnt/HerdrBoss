import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULT_RULES_FILE, findGitRoot, loadModels, loadProjectConfig } from './config.js';
import { mergeModels } from '../control.js';
import { appendDelegatedRun, compareChangedPaths, gitStatusPaths, readDelegatedRuns, readJson, validateAllowedPaths, validateDelegatedRun, normalizeWorkerReport, validateWorkerReport } from './orchestration.js';
import { buildGhArgs } from './gh.js';
import { allowWorkerScope, collectWorker, createHerdrRunner, listWorkers, parkWorker, startWorker } from './workers.js';
import { pruneWorktrees } from './worktrees.js';
import { acquireProjectLock, listProjectLocks, pushWithLock, releaseProjectLock } from './locks.js';
import { SUITE_WAIT_SECONDS, runSuite } from './suite.js';
import { agentsBlock, checkAgentsFile, installKit, kitRevision, rulesPolicy } from './agents-check.js';
import { listProjects } from '../projects.js';

const USAGE = `Kit commands:
  worker start <name> --kind <kind> (--task TEXT | --task-file FILE) [--lease POOL]... [options]
  worker collect <name> [--record --outcome done|partial|failed --gate-passed|--gate-failed]
  worker list
  worker park <name> --reason TEXT | worker unpark <name>
  worker allow <name> <path>... --reason TEXT
  lock acquire <name> [--wait SECONDS] | lock release <name> | lock list
  push [git push arguments]
  suite [--wait SECONDS] [--keep NAME]... -- <command...>
  worktree prune [--apply]
  ledger append --entry FILE | ledger check [--runs]
  check --report FILE | --run FILE | --worktree DIR --allow PATH...
  check agents [FILE]
  check kit
  kit install [--no-hook]
  kit block
  gh issue create|comment|edit ... --body-file FILE
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

function commandKit(command, argv, { output = console.log, env = process.env, herdr = createHerdrRunner(), config: injectedConfig = null, rulesFile = DEFAULT_RULES_FILE, lockDataDir, now, pause, pidAlive, pushStdio, suiteStdio } = {}) {
  if (command === 'models') {
    const modelConfig = mergeModels(loadModels(), rulesPolicy(rulesFile));
    const { positional, flags } = parseArgs(argv);
    if (positional.length || Object.keys(flags).some((key) => key !== 'kind')) fail('Usage: models [--kind KIND]');
    if (flags.kind && !modelConfig.kinds[flags.kind]) fail(`Unknown model kind: ${flags.kind}.`);
    // localModels lists the models that come from the policy extraModels and not from kit/models.json.
    const base = loadModels().kinds;
    const kinds = Object.fromEntries(Object.entries(modelConfig.kinds).map(([kind, cfg]) => {
      const localModels = cfg.allowedModels.filter((model) => !base[kind]?.allowedModels.includes(model));
      return [kind, localModels.length ? { ...cfg, localModels } : cfg];
    }));
    const result = flags.kind ? { [flags.kind]: kinds[flags.kind] } : kinds;
    output(JSON.stringify(result, null, 2));
    return result;
  }

  if (command === 'kit') {
    const usage = 'Usage: kit install [--no-hook] | kit block';
    if (argv[0] === 'block') {
      // kit block prints the AGENTS.md stub, for old instructions.
      if (argv.length !== 1) fail(usage);
      const result = agentsBlock();
      output(result.block.trimEnd());
      return result;
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
    const current = kitRevision();
    const rows = listProjects().map((project) => {
      const loaded = typeof project.kitRevision === 'string' && project.kitRevision ? project.kitRevision : null;
      const state = !loaded ? 'not published' : loaded === current ? 'current' : 'old';
      const c = project.agentsCheck;
      const counts = c && Number.isInteger(c.errors) && Number.isInteger(c.warnings) ? `${c.errors} errors, ${c.warnings} warnings` : 'not published';
      output(`${project.slug}: kit revision ${loaded ?? 'none'} (${state}); agents check ${counts}`);
      return { slug: project.slug, kitRevision: loaded, state, agentsCheck: c ?? null };
    });
    const stale = rows.filter((row) => row.state !== 'current').length;
    output(`check kit: ${stale ? 'FAIL' : 'PASS'} (current revision ${current}; ${rows.length} projects, ${stale} not current)`);
    return { current, projects: rows, exitCode: stale ? 1 : 0 };
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
      if (positional.length !== 1 || Object.keys(flags).length) fail('Usage: lock release <name>');
      return releaseProjectLock(positional[0], {
        config, env, herdr, dataDir: lockDataDir, output, pidAlive,
      });
    }
    if (action === 'list') {
      if (rest.length) fail('Usage: lock list');
      return listProjectLocks({ config, env, herdr, dataDir: lockDataDir, output, pidAlive, now });
    }
    fail('Usage: lock acquire <name> [--wait SECONDS] | lock release <name> | lock list');
  }
  if (command === 'push') {
    // All arguments go to git push unchanged.
    return pushWithLock(argv, { config, env, herdr, dataDir: lockDataDir, output, now, pause, pidAlive, stdio: pushStdio });
  }
  if (command === 'suite') {
    // The options come before --. Everything after -- is the command.
    const usage = 'Usage: suite [--wait SECONDS] [--keep NAME]... -- <command...>';
    const separator = argv.indexOf('--');
    if (separator < 0 || separator === argv.length - 1) fail(usage);
    const { positional, flags } = parseArgs(argv.slice(0, separator), { repeat: ['--keep'] });
    if (positional.length) fail(usage);
    knownFlags(flags, ['wait', 'keep']);
    if (flags.wait !== undefined && !/^\d+$/.test(flags.wait)) fail('--wait must be a whole non-negative number of seconds.');
    const waitSeconds = flags.wait === undefined ? SUITE_WAIT_SECONDS : Number(flags.wait);
    if (!Number.isSafeInteger(waitSeconds)) fail('--wait must be a whole non-negative number of seconds.');
    return runSuite(argv.slice(separator + 1), {
      config, env, herdr, dataDir: lockDataDir, waitSeconds, keep: flags.keep ?? [], output, now, pause, pidAlive, stdio: suiteStdio,
    });
  }
  if (command === 'worker') {
    const [action, ...rest] = argv;
    if (action === 'start') {
      const { positional, flags } = parseArgs(rest, { boolean: ['--no-worktree', '--dry-run', '--force', '--read-only'], repeat: ['--allow', '--copy', '--lease'] });
      if (positional.length !== 1) fail('Usage: worker start <name> --kind <kind> --task TEXT [options]');
      knownFlags(flags, ['kind', 'model', 'effort', 'issue', 'task', 'taskfile', 'allow', 'copy', 'lease', 'base', 'orch', 'noworktree', 'dryrun', 'force', 'readonly']);
      try { return startWorker(positional[0], {
        kind: flags.kind,
        model: flags.model,
        effort: flags.effort,
        issue: flags.issue,
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
      }, { config, models: modelConfig, herdr, env, output }); }
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
      const { positional, flags } = parseArgs(rest, { boolean: ['--record', '--gate-passed', '--gate-failed'] });
      if (positional.length !== 1) fail('Usage: worker collect <name> [options]');
      knownFlags(flags, ['record', 'outcome', 'gatepassed', 'gatefailed', 'defects', 'rework', 'modelresult', 'modelreason']);
      return collectWorker(positional[0], {
        record: flags.record,
        outcome: flags.outcome,
        gatePassed: flags.gatepassed,
        gateFailed: flags.gatefailed,
        defects: flags.defects == null ? 0 : Number(flags.defects),
        rework: flags.rework == null ? 0 : Number(flags.rework),
        modelResult: flags.modelresult || null,
        modelReason: flags.modelreason || null,
      }, { config, output });
    }
    if (action === 'allow') {
      const { positional, flags } = parseArgs(rest);
      knownFlags(flags, ['reason']);
      if (positional.length < 2) fail('Usage: worker allow <name> <path>... --reason TEXT');
      const [name, ...paths] = positional;
      return allowWorkerScope(name, { paths, reason: flags.reason }, { config, herdr, env, output });
    }
    if (action === 'list') {
      if (rest.length) fail('Usage: worker list');
      return listWorkers(config, { herdr, output });
    }
    fail('Usage: worker start|collect|list|park|unpark|allow');
  }

  if (command === 'worktree') {
    const [action, ...rest] = argv;
    if (action !== 'prune') fail('Usage: worktree prune [--apply]');
    const { positional, flags } = parseArgs(rest, { boolean: ['--apply'] });
    knownFlags(flags, ['apply']);
    if (positional.length) fail('Usage: worktree prune [--apply]');
    return pruneWorktrees(config, { apply: flags.apply, herdr, output });
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
      const runs = readDelegatedRuns(ledgerPath, { evidenceTiers: config.evidenceTiers });
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
    const [group, action, ...ghArgs] = argv;
    if (group !== 'issue') fail('Usage: gh issue create|comment|edit ... --body-file FILE');
    const built = buildGhArgs(action, ghArgs);
    execFileSync('gh', built, { cwd: config.root, stdio: 'inherit' });
    return;
  }

  fail(USAGE);
}

export function runKitCommand(command, argv = process.argv.slice(3), options = {}) {
  return commandKit(command, argv, options);
}

export { USAGE as KIT_USAGE };
