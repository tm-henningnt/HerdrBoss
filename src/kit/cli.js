import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadModels, loadProjectConfig } from './config.js';
import { appendDelegatedRun, compareChangedPaths, gitStatusPaths, readDelegatedRuns, readJson, validateAllowedPaths, validateDelegatedRun, validateWorkerReport } from './orchestration.js';
import { buildGhArgs } from './gh.js';
import { allowWorkerScope, collectWorker, createHerdrRunner, listWorkers, parkWorker, startWorker } from './workers.js';
import { pruneWorktrees } from './worktrees.js';

const USAGE = `Kit commands:
  worker start <name> --kind <kind> (--task TEXT | --task-file FILE) [options]
  worker collect <name> [--record --outcome done|partial|failed --gate-passed|--gate-failed]
  worker list
  worker park <name> --reason TEXT | worker unpark <name>
  worker allow <name> <path>... --reason TEXT
  worktree prune [--apply]
  ledger append --entry FILE | ledger check [--runs]
  check --report FILE | --run FILE | --worktree DIR --allow PATH...
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

function commandKit(command, argv, { output = console.log, env = process.env, herdr = createHerdrRunner(), config: injectedConfig = null } = {}) {
  if (command === 'models') {
    const modelConfig = loadModels();
    const { positional, flags } = parseArgs(argv);
    if (positional.length || Object.keys(flags).some((key) => key !== 'kind')) fail('Usage: models [--kind KIND]');
    if (flags.kind && !modelConfig.kinds[flags.kind]) fail(`Unknown model kind: ${flags.kind}.`);
    const result = flags.kind ? { [flags.kind]: modelConfig.kinds[flags.kind] } : modelConfig.kinds;
    output(JSON.stringify(result, null, 2));
    return result;
  }

  const config = injectedConfig ?? loadProjectConfig();
  const modelConfig = command === 'worker' ? loadModels() : null;
  if (command === 'worker') {
    const [action, ...rest] = argv;
    if (action === 'start') {
      const { positional, flags } = parseArgs(rest, { boolean: ['--no-worktree', '--dry-run', '--force'], repeat: ['--allow'] });
      if (positional.length !== 1) fail('Usage: worker start <name> --kind <kind> --task TEXT [options]');
      knownFlags(flags, ['kind', 'model', 'effort', 'issue', 'task', 'taskfile', 'allow', 'base', 'orch', 'noworktree', 'dryrun', 'force']);
      return startWorker(positional[0], {
        kind: flags.kind,
        model: flags.model,
        effort: flags.effort,
        issue: flags.issue,
        task: flags.task,
        taskFile: flags.taskfile,
        allow: flags.allow ?? [],
        base: flags.base,
        orch: flags.orch,
        noWorktree: flags.noworktree,
        dryRun: flags.dryrun,
        force: flags.force,
      }, { config, models: modelConfig, herdr, env, output });
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
      knownFlags(flags, ['record', 'outcome', 'gatepassed', 'gatefailed', 'defects', 'rework']);
      return collectWorker(positional[0], {
        record: flags.record,
        outcome: flags.outcome,
        gatePassed: flags.gatepassed,
        gateFailed: flags.gatefailed,
        defects: flags.defects == null ? 0 : Number(flags.defects),
        rework: flags.rework == null ? 0 : Number(flags.rework),
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
      const report = readJson(filePath(config.root, flags.report));
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
