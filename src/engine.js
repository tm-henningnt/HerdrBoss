import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { DATA_DIR, LIVE_DATA_DIR, dashboardUrl, serviceSettingsView } from './config.js';
import { collectHerdr, collectQuotas, collectMachine, collectProcesses, collectCwdProcesses, collectMissingWorktreeProcesses, collectWorktreeCounts, collectPiModels, findBrowsers, cpuUse, keepStaleRows, run } from './collect.js';
import { evaluate, renderBulletin, fmtDuration, providerName, broadcastTargets, staleStatuses } from './rules.js';
import { listProjects } from './projects.js';
import { checkHarness, readProjectRepos } from './harness.js';
import { loadModels, loadProjectConfig, KIT_ROOT, workerConfigView } from './kit/config.js';
import { loadPolicy, clearExpiredOneOffGoals, deriveControl, migrateWorkspacePolicy, providerFor, pickSuccessor, laneStatus, leastOverProvider, machineLimits, unmeteredLane, unavailablePiModels, mergeModels } from './control.js';
import { quotaUsageToday, recordQuotaSnapshot, readUsage } from './usage.js';
import { renderNightReport } from './night-report.js';
import { listBrowserSessions, cdpResponds, browserProcessCheck } from './browser-pool.js';
import { readLeases, reclaimLeases, publicLease, tcpListening, leasePools, migrateProjectBrowserLeases } from './leases.js';
import { codeSignCloneDir, sweepCodeSignClones } from './clone-sweep.js';
import { runDenialScan, readDenials, denialSummary, DENIAL_SCAN_INTERVAL_MS, SCAN_BUDGET_BYTES, RETAIN_DAYS, RISE_FACTOR, RISE_MIN_EVENTS } from './denials.js';
import { listHandoffs, saveHandoffs, supersedeHandoffs, expireHandoff, expireMissingHandoffs, handoffNotices } from './handoff.js';
import { deliverQueued, mailboxCounts, readMessages, RETENTION_MS, SEND_LIMIT_PER_MINUTE } from './messages.js';
import { openMessageStore } from './message-store.js';
import { readKitNotice, pendingKitAlert, isKitAlert, kitNoticeTargets } from './kit-notice.js';
import { nightNoticeSent, quietHoursActive, readNight, readNightRecord, withNightReportMark, withNoticeMark, writeNight } from './night.js';
import { inspectWorkerTransitions, inspectWorkerReports, isWorkerPane, applyWorkerFailureStatuses, resolveFreeUsageRun, activeFreeModelExhaustions, extendFreeModelExhaustion, activeFreeLaneExhaustions, extendFreeLaneExhaustion, freeUsageLaneRetry } from './worker-failures.js';
import { FULL_SUITE_LOCK, readLockQueue, readLockTakeoverNotices, readMachineLocks, removeLockTakeoverNotice } from './kit/locks.js';

const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const BULLETIN_FILE = path.join(DATA_DIR, 'bulletin.md');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const CLI_FILE = fileURLToPath(new URL('./cli.js', import.meta.url));
const SEV = { info: 0, warn: 1, critical: 2 };
const POLICY_FILE = path.join(DATA_DIR, 'policy.json');

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Build the model scorecard from usage events. One row per harness and model.
export function buildModelScorecard(events = [], now = Date.now()) {
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  const rows = {};
  for (const e of events) {
    const end = Date.parse(e.endedAt);
    if (!Number.isFinite(end) || end < cutoff) continue;
    const key = `${e.kind}\n${e.model}`;
    const row = rows[key] ||= { kind: e.kind, model: e.model, runs: 0, firstTime: 0, rework: 0, failed: 0, durations: [] };
    row.runs++;
    const result = e.modelOutcome?.result;
    if (result === 'first-time') row.firstTime++;
    else if (result === 'rework') row.rework++;
    else if (result === 'failed') row.failed++;
    const start = Date.parse(e.startedAt);
    if (Number.isFinite(start)) row.durations.push((end - start) / 60000);
  }
  return Object.values(rows)
    .map((row) => ({
      ...row,
      reworkRate: row.runs ? (row.rework + row.failed) / row.runs : 0,
      medianMinutes: median(row.durations),
    }))
    .sort((a, b) => b.runs - a.runs || a.kind.localeCompare(b.kind) || a.model.localeCompare(b.model));
}
const WORKTREE_SCAN_INTERVAL_MS = 5 * 60 * 1000;
const CLONE_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const PI_MODELS_INTERVAL_MS = 15 * 60 * 1000;
const WORKER_NO_REPORT_MS = 10 * 60 * 1000;
// The engine reads the harness settings files at each service start and then at most this often.
export const HARNESS_CHECK_INTERVAL_MS = 10 * 60 * 1000;
// The stale status rule reads the HEAD of each project repository at most this often.
// The browsers that Herdr Boss labels: configured shared browsers and managed project browsers. Herdr Boss never stops a browser that it did not start.
export function knownBrowsers(sharedBrowsers = [], browserSessions = []) {
  return [
    ...sharedBrowsers,
    ...browserSessions.map((b) => ({ port: b.port, profile: b.profile, label: `Managed browser: ${b.project}` })),
  ];
}

export const STATUS_HEAD_INTERVAL_MS = 10 * 60 * 1000;
// The worker config read runs at start and every 10 minutes, for each project in project-repos.json.
const PROJECT_CONFIG_INTERVAL_MS = 10 * 60 * 1000;
// Quotas younger than this are shown without the codexbar error, and saved quotas this young load at start.
const QUOTA_CACHE_MS = 15 * 60 * 1000;

// Count each working pane on the provider recorded when its worker started. Herdr panes do not expose a model, so
// use the project run records to distinguish metered and unmetered OpenCode workers.
function runningWorkerCountsByLane(herdr, policy, models) {
  const active = new Map((herdr?.panes || [])
    .filter((pane) => pane.agent && !pane.orch && pane.label !== 'boss' && pane.status === 'working')
    .map((pane) => [pane.id, pane]));
  const counts = {};
  const add = (provider) => {
    const lane = provider || 'unmetered';
    counts[lane] = (counts[lane] || 0) + 1;
  };
  for (const { repo } of readProjectRepos(DATA_DIR)) {
    let projectConfig;
    try { projectConfig = loadProjectConfig({ cwd: repo }); }
    catch { continue; }
    const { mainRoot, runsPath } = projectConfig;
    const relative = path.relative(mainRoot, runsPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    let files;
    try {
      const stat = fs.lstatSync(runsPath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      files = fs.readdirSync(runsPath);
    } catch { continue; }
    for (const name of files) {
      if (!name.endsWith('.json')) continue;
      try {
        const file = path.join(runsPath, name);
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        const run = JSON.parse(fs.readFileSync(file, 'utf8'));
        const pane = active.get(run?.pane);
        if (!pane) continue;
        const provider = Object.hasOwn(run, 'provider')
          ? run.provider
          : providerFor(run.kind || pane.agent, run.model, policy);
        add(provider);
        active.delete(run.pane);
      } catch {}
    }
  }
  for (const pane of active.values()) {
    const kind = pane.agent;
    const model = pane.model || policy.preferredModels?.[kind] || models.kinds[kind]?.defaultModel;
    add(providerFor(kind, model, policy));
  }
  return counts;
}

function readActiveWorkerRuns() {
  const runs = [];
  for (const { repo } of readProjectRepos(DATA_DIR)) {
    let config;
    try { config = loadProjectConfig({ cwd: repo }); }
    catch { continue; }
    const relative = path.relative(config.mainRoot, config.runsPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    let files;
    try {
      const stat = fs.lstatSync(config.runsPath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      files = fs.readdirSync(config.runsPath);
    } catch { continue; }
    for (const name of files) {
      if (!name.endsWith('.json')) continue;
      try {
        const file = path.join(config.runsPath, name);
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        const run = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!run.finishedAt && run.name && run.pane && path.isAbsolute(run.worktree)) runs.push(run);
      } catch {}
    }
  }
  return runs;
}

// Keep one timer across idle and done states. A working or other state ends the idle period.
export function inspectWorkerNoReports(panes, runs, observed = {}, now = Date.now(), reportExists = fs.existsSync) {
  const live = new Map((panes || []).map((pane) => [pane.id, pane]));
  const nextObserved = {};
  const notices = [];
  for (const run of runs || []) {
    if (run.finishedAt || !run.name || !run.pane || !run.worktree) continue;
    const pane = live.get(run.pane);
    if (!pane || !isWorkerPane(pane) || !['idle', 'done'].includes(pane.status)) continue;
    const prior = observed?.[pane.id];
    const startedAt = run.startedAt || null;
    const sameRun = prior?.name === run.name && prior?.startedAt === startedAt && prior?.worktree === run.worktree;
    const since = sameRun && Number.isFinite(prior.since) ? prior.since : now;
    nextObserved[pane.id] = { name: run.name, startedAt, worktree: run.worktree, since };
    if (!Number.isFinite(now) || now - since < WORKER_NO_REPORT_MS) continue;
    const reportPath = path.join(run.worktree, run.workerDir || '.worker', 'report.json');
    let exists;
    try { exists = reportExists(reportPath); }
    catch { continue; }
    if (exists !== false) continue;
    const period = String(since);
    notices.push({
      key: `workers:no-report:${run.name}:${run.pane}:${startedAt || 'unknown'}:${period}`,
      severity: 'warn', scope: pane.workspace, immediate: true, once: true,
      title: `Worker ${run.name} is idle without a report`,
      text: `Worker ${run.name} in ${run.pane} is idle for 10 min with no report.json. Check it, then resume or collect it.`,
    });
  }
  return { observed: nextObserved, notices };
}

function handoffCandidates(control) {
  return [...(control.handoffs || []), ...(control.bossHandoff ? [control.bossHandoff] : [])];
}

export function alertPromptDue(alert, record, now, cooldown) {
  if (alert.immediate) return !record;
  if (!record) return true;
  if (SEV[alert.severity] > SEV[record.severity]) return true;
  return !alert.key.startsWith('machine:disk:') && !alert.once && now - record.at > cooldown;
}

// An immediate notice of warn or higher reaches a working orchestrator. Other notices wait until it is idle or done.
export function orchestratorCanReceiveNotice(orch, alerts) {
  return orch.status === 'idle' || orch.status === 'done' || alerts.some(skipsIdleGate);
}

const skipsIdleGate = (alert) => !!alert.immediate && SEV[alert.severity] >= SEV.warn;

// A pane gets at most one prompt with info notices in this interval.
export const INFO_PROMPT_INTERVAL_MS = 60 * 60 * 1000;
const INFO_PROMPT_LINES = 8;

// Bulletin-only alert sources: they set prompt: false, so deliver sends no pane prompt for them.
export function quotaRecoveredAlert(id, recovery) {
  return { key: `quota:recovered:${id}:${recovery.resetsAt}`, severity: 'info', scope: 'all', prompt: false,
    title: 'Quota restriction cleared', text: recovery.text };
}

export function browserReadyAlert(b, workspace) {
  return {
    // One notice per port and mode, so a restart in the same mode does not repeat it.
    key: `browser:managed-ready:${b.project}:${b.port}:${b.headless ? 'headless' : 'visible'}`, severity: 'info', once: true, scope: workspace, prompt: false,
    title: `${b.project} browser is ready`,
    text: `Browser for ${b.project} is ready (${b.headless ? 'headless' : 'visible'}) on port ${b.port}. Use herdr-boss browser tabs ${b.project} to find a page, then herdr-boss browser screenshot ${b.project} --tab <id> for a private JPEG. Browser service commands are in the Herdr Boss kit.`,
  };
}

export function pruneInactiveDiskPromptRecords(records, activeAlerts) {
  const active = activeAlerts instanceof Set ? activeAlerts : new Set(activeAlerts || []);
  return Object.fromEntries(Object.entries(records || {}).filter(([recordKey]) => {
    const alertKey = recordKey.split('@')[0];
    return !alertKey.startsWith('machine:disk:') || active.has(alertKey);
  }));
}

// The text of one night notice. The start notice names the stored end time.
export function nightNoticeText(phase, record) {
  if (phase === 'end') return '[herdr-boss] Night watch ended. The Owner rules apply again.';
  if (phase !== 'start') throw new TypeError('notice phase must be start or end.');
  const end = record?.until ? new Date(record.until) : null;
  const label = end && !Number.isNaN(end.getTime()) ? ` until ${end.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : '';
  return `[herdr-boss] Night watch${label}. The Owner is away; the Boss acts for the Owner. Work as normal. Escalate to the Boss.`;
}

// A night notice goes to an orchestrator pane and to the Boss pane. A pane without an agent takes no prompt.
export function nightNoticeTarget(pane) {
  return !!pane?.agent && (pane.orch === true || pane.label === 'orch' || pane.label === 'boss');
}

// The Herdr CLI can print an error envelope and exit with status 0. Only that envelope is a failure;
// other exit-zero output, including plain text or no output, is a success.
function checkHerdrResponse(stdout) {
  let response;
  try { response = JSON.parse(stdout); } catch { return; }
  if (response && typeof response === 'object' && response.error) {
    throw new Error(response.error.message || JSON.stringify(response.error));
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export class Engine extends EventEmitter {
  constructor(cfg, { push = cfg.push, act = true, collectors = {}, handoffRunner = run, herdrRunner = run, gitRunner = (args) => run('git', args, { timeout: 10000 }), kitRoot = KIT_ROOT, lockDataDir = DATA_DIR } = {}) {
    super();
    this.cfg = cfg;
    const guardReasons = [];
    if (process.env.NODE_TEST_CONTEXT) guardReasons.push('NODE_TEST_CONTEXT is set');
    if (DATA_DIR !== LIVE_DATA_DIR) guardReasons.push(`data directory ${DATA_DIR} is not the configured live data directory ${LIVE_DATA_DIR}`);
    const actionsAllowed = guardReasons.length === 0 || process.env.HERDR_BOSS_ALLOW_ACTIONS === '1';
    this.push = actionsAllowed && push;
    this.act = actionsAllowed && act; // false: collect and evaluate only (no reaping, notifications or prompts)
    this.memory = readJson(MEMORY_FILE, { paneSince: {}, pushes: {}, notified: {} });
    this.quotas = null;
    this.quotasAt = 0;
    this.quotasCached = false;
    this.quotaRead = null;
    this.quotaResult = null;
    this.quotaError = null;
    this.worktreeCounts = {};
    this.worktreeCountsAt = 0;
    this.orphanedWorktreeProcesses = [];
    this.cloneSweepAt = 0;
    this.cloneSweepRunning = false;
    this.denialScanAt = 0;
    this.denialScanRunning = false;
    this.harness = null;
    this.harnessAt = 0;
    this.headReads = new Set();
    this.workerConfig = {};
    this.workerConfigAt = 0;
    this.collectors = {
      collectHerdr,
      collectQuotas,
      collectMachine,
      collectProcesses,
      collectCwdProcesses,
      collectMissingWorktreeProcesses,
      collectWorktreeCounts,
      cdpResponds,
      probeTcp: tcpListening,
      codeSignCloneDir,
      sweepCodeSignClones,
      runDenialScan,
      checkHarness,
      // A test engine does not run the real pi unless a test injects a collector.
      collectPiModels: process.env.NODE_TEST_CONTEXT ? async () => null : collectPiModels,
      ...collectors,
    };
    this.handoffRunner = handoffRunner;
    this.herdrRunner = herdrRunner;
    this.gitRunner = gitRunner;
    this.kitRoot = kitRoot;
    this.lockDataDir = lockDataDir;
    this.kitNoticeRead = false;
    this.state = readJson(STATE_FILE, null);
    this.messageStore = openMessageStore({ dir: DATA_DIR });
    this.messageVersion = this.messageStore.version();
    this.messageSnapshot = new Map(this.messageStore.all().map((record) => [record.id, JSON.stringify(record)]));
    const savedAt = Date.parse(this.state?.quotasAt);
    if (Array.isArray(this.state?.quotas) && this.state.quotas.length && Number.isFinite(savedAt) && Date.now() - savedAt < QUOTA_CACHE_MS) {
      this.quotas = this.state.quotas;
      this.quotasAt = savedAt;
      this.quotasCached = true;
    }
    this.events = [];
    try {
      this.events = fs.readFileSync(EVENTS_FILE, 'utf8').trim().split('\n').slice(-200).map((l) => JSON.parse(l));
    } catch {}
    this.running = false;
    this.models = loadModels();
    if (!actionsAllowed) this.log('guard', `Actions and push disabled: ${guardReasons.join('; ')}. Set HERDR_BOSS_ALLOW_ACTIONS=1 to override.`);
  }

  log(type, text, extra = {}) {
    const e = { at: new Date().toISOString(), type, text, ...extra };
    this.events.push(e);
    if (this.events.length > 200) this.events.shift();
    try { fs.appendFileSync(EVENTS_FILE, JSON.stringify(e) + '\n'); } catch {}
    this.emit('event', e);
  }

  setResourcePools(pools) {
    this.cfg.resourcePools = pools;
    this.cfg.resourcePoolErrors = [];
    if (!this.state?.resourceLeases) return;
    const { pools: activePools, errors } = leasePools(this.cfg);
    this.state.resourceLeases = { ...this.state.resourceLeases, pools: activePools, errors };
    this.emit('state', this.state);
  }

  observeMessageChange(event) {
    if (!event || !['append', 'update'].includes(event.type) || typeof event.record?.id !== 'string') return;
    const serialized = JSON.stringify(event.record);
    if (this.messageSnapshot.get(event.record.id) === serialized) return;
    this.messageSnapshot.set(event.record.id, serialized);
    // Keep the last tick version so a local callback cannot hide another process change.
    this.emit('message', event);
  }

  checkMessageChanges() {
    const version = this.messageStore.version();
    if (version === this.messageVersion) return;
    const records = this.messageStore.all();
    const next = new Map();
    for (const record of records) {
      const serialized = JSON.stringify(record);
      const previous = this.messageSnapshot.get(record.id);
      if (!previous) this.emit('message', { type: 'append', record });
      else if (previous !== serialized) this.emit('message', { type: 'update', record });
      next.set(record.id, serialized);
    }
    this.messageSnapshot = next;
    this.messageVersion = version;
  }

  async tick() {
    if (this.running) return this.state;
    this.running = true;
    const errors = [];
    const now = Date.now();
    try { this.checkMessageChanges(); }
    catch (error) { errors.push(`messages: ${error.message}`); }
    const harness = this.readHarness(now);
    try {
      this.applyQuotaResult();
      if (!this.quotas || now - this.quotasAt > this.cfg.quotaSeconds * 1000) this.readQuotas();
      // Pi lists only the models it can use. A failed run keeps the last good result; no result means availability is unknown.
      const refreshPiModels = !Number.isFinite(this.piModelsCheckedAt) || now - this.piModelsCheckedAt >= PI_MODELS_INTERVAL_MS;
      if (refreshPiModels) this.piModelsCheckedAt = now;
      let currentHerdrSnapshot = false;
      let currentPaneList = false;
      let processesKnown = false;
      const [herdr, machine, procs] = await Promise.all([
        this.collectors.collectHerdr(this.cfg.orchestratorLabel).then((snapshot) => {
          currentHerdrSnapshot = true;
          currentPaneList = Array.isArray(snapshot?.panes);
          return currentPaneList ? snapshot : null;
        }).catch((e) => { errors.push(`herdr: ${e.message}`); return this.state?.herdr || null; }),
        this.collectors.collectMachine(DATA_DIR).catch((e) => { errors.push(`machine: ${e.message}`); return null; }),
        this.collectors.collectProcesses().then((table) => { processesKnown = true; return table; }).catch((e) => { errors.push(`ps: ${e.message}`); return new Map(); }),
        refreshPiModels ? this.collectors.collectPiModels({ now }).then((result) => {
          if (Array.isArray(result?.models)) this.memory.piModels = { at: Number.isFinite(result.at) ? result.at : now, models: [...result.models] };
        }).catch(() => {}) : null,
      ]);
      if (this.act) {
        try {
          const handoffs = listHandoffs();
          const changed = supersedeHandoffs(handoffs, now);
          if (changed.length) {
            saveHandoffs(handoffs);
            for (const item of changed) this.log('handoff', `Superseded handoff ${item.id} with ${item.supersededBy}`,
              item.boss || item.label === 'boss' ? { workspace: item.workspace, pane: item.newPane } : { project: item.project, pane: item.newPane });
          }
        } catch (e) { errors.push(`handoffs: ${e.message}`); }
      }
      if (this.act && currentHerdrSnapshot && currentPaneList) {
        try { expireMissingHandoffs(herdr?.panes); }
        catch (e) { errors.push(`handoffs: ${e.message}`); }
        try { await this.retirePreviousOrchestrators(herdr, now); }
        catch (e) { errors.push(`handoff retirement: ${e.message}`); }
      }
      if (herdr && currentHerdrSnapshot && currentPaneList && now - this.worktreeCountsAt >= WORKTREE_SCAN_INTERVAL_MS) {
        this.worktreeCountsAt = now;
        try { this.worktreeCounts = await this.collectors.collectWorktreeCounts(herdr.panes, { now }); }
        catch (error) { errors.push(`worktree count scan: ${error.message}`); }
        try {
          const cwdProcesses = await this.collectors.collectCwdProcesses();
          this.orphanedWorktreeProcesses = await this.collectors.collectMissingWorktreeProcesses(herdr.panes, cwdProcesses);
        } catch (error) { errors.push(`missing worktree process check: ${error.message}`); }
      }
      if (this.quotaError && !(this.quotas && now - this.quotasAt < QUOTA_CACHE_MS)) errors.push(this.quotaError);
      const browserSessions = Object.values(listBrowserSessions());
      const browsers = findBrowsers(procs, herdr?.panes || [], knownBrowsers(this.cfg.sharedBrowsers, browserSessions));
      // Probe only a browser whose process matches its port and profile. The probes run in parallel, so a hung browser delays the tick by at most 2 seconds.
      const managedBrowsers = await Promise.all(browserSessions.map(async (b) => {
        const matched = browsers.some((x) => x.kind === 'automation-chrome' && x.port === String(b.port) && x.profile === b.profile);
        return { ...b, responsive: matched ? await this.collectors.cdpResponds(b.port) : false };
      }));
      const night = readNight({ dataDir: DATA_DIR, now });

      // The first acting tick writes a project browser lease for each browser record. It runs once for each data directory.
      const { pools: resourcePools, errors: resourcePoolErrors } = leasePools(this.cfg);
      if (this.act && !this.browserLeasesMigrated) {
        try {
          migrateProjectBrowserLeases(Object.fromEntries(browserSessions.map((b) => [b.project, b])), {
            dataDir: DATA_DIR, now,
            log: (item) => this.log('lease', item.skipped
              ? `Did not migrate the ${item.project} browser to ${item.pool}: ${item.reason}`
              : `Migrated the ${item.project} browser to ${item.pool} ${item.item}`, { pool: item.pool, item: item.item, project: item.project }),
          });
          this.browserLeasesMigrated = true;
        } catch (e) { if (e.code !== 'ELOCKBUSY') errors.push(`leases: ${e.message}`); }
      }
      // Reclaim leases on an acting tick. A pane is gone only when the pane list of this tick succeeded.
      // A project browser lease is checked only when the process list of this tick succeeded.
      const reclaimedLeases = [];
      if (this.act) {
        try {
          reclaimLeases({
            pools: resourcePools, dataDir: DATA_DIR, now, probeTcp: this.collectors.probeTcp, waitMs: 0,
            panes: currentHerdrSnapshot && currentPaneList ? new Set(herdr.panes.map((pane) => pane.id)) : null,
            browserProcess: browserProcessCheck(processesKnown ? procs : null, Object.fromEntries(browserSessions.map((b) => [b.project, b]))),
            night,
            log: (item) => {
              if (item.held) this.log('quiet-hours', `quiet hours held ${item.held}`, { pool: item.pool, item: item.item, project: item.project });
              else {
                reclaimedLeases.push(item);
                this.log('lease', `Reclaimed ${item.pool} ${item.item} of ${item.project}${item.worker ? `/${item.worker}` : ''}: ${item.reason}`, { pool: item.pool, item: item.item, project: item.project, reason: item.reason });
              }
            },
          });
        } catch (e) { if (e.code !== 'ELOCKBUSY') errors.push(`leases: ${e.message}`); }
      }
      // Tell a holder whose pane is still alive that its lease went back to the pool, for example after its TTL.
      if (this.act && this.push && currentPaneList) {
        const livePanes = new Set(herdr.panes.map((pane) => pane.id));
        for (const item of reclaimedLeases) {
          if (!item.pane || !livePanes.has(item.pane)) continue;
          const text = `[herdr-boss] Your lease ${item.pool} ${item.item} was reclaimed: ${item.reason}. Stop using it, and take a new one with herdr-boss lease acquire ${item.pool}.`;
          try { checkHerdrResponse(await this.herdrRunner('herdr', ['agent', 'prompt', item.pane, text])); }
          catch (error) { this.log('error', `Lease reclaim notice to ${item.pane} failed: ${String(error.stderr || error.message).slice(0, 200)}`); }
        }
      }
      let leaseStore = { leases: [] };
      try { leaseStore = readLeases(DATA_DIR); } catch (e) { errors.push(`leases: ${e.message}`); }
      const resourceLeases = { pools: resourcePools, errors: resourcePoolErrors, leases: leaseStore.leases.map(publicLease) };

      this.trackPaneStatus(herdr, now);
      const workerTransitions = herdr ? await inspectWorkerTransitions(
        herdr.panes, this.memory.workerObserved, this.memory.workerFailures,
        this.collectors.readWorkerScreen || ((args) => run('herdr', args, { timeout: 10000 })), now,
      ) : { observed: this.memory.workerObserved || {}, failures: this.memory.workerFailures || {}, notices: [] };
      this.memory.workerObserved = workerTransitions.observed;
      this.memory.workerFailures = workerTransitions.failures;
      this.memory.exhaustedFreeModels ||= {};
      const reportTransitions = herdr ? inspectWorkerReports(
        herdr.panes, this.memory.workerReportObserved, now,
      ) : { observed: this.memory.workerReportObserved || {}, notices: [] };
      this.memory.workerReportObserved = reportTransitions.observed;
      const noReportTransitions = herdr ? inspectWorkerNoReports(
        herdr.panes, readActiveWorkerRuns(), this.memory.workerNoReportObserved, now,
      ) : { observed: this.memory.workerNoReportObserved || {}, notices: [] };
      this.memory.workerNoReportObserved = noReportTransitions.observed;
      if (machine) {
        const h = (this.memory.history ||= []);
        h.push({ t: now, load: machine.load[0], mem: machine.memFreePercent });
        while (h.length > 240) h.shift();
      }
      const snap = {
        updatedAt: new Date(now).toISOString(),
        quotasAt: this.quotasAt ? new Date(this.quotasAt).toISOString() : null,
        quotas: this.quotas || [],
        quotaThresholds: {
          warnPercent: this.cfg.quota?.warnPercent ?? 90,
          criticalPercent: this.cfg.quota?.criticalPercent ?? 98,
        },
        serviceSettings: serviceSettingsView(this.cfg),
        // The harness readiness findings hold a status, an area, and a fixed item label only.
        harness,
        // The fixed scan and store limits. The Analytics and Mailbox pages show them read-only.
        limits: {
          denials: {
            intervalMs: DENIAL_SCAN_INTERVAL_MS,
            budgetBytes: SCAN_BUDGET_BYTES,
            retainDays: RETAIN_DAYS,
            riseFactor: RISE_FACTOR,
            riseMinEvents: RISE_MIN_EVENTS,
          },
          messages: {
            retentionMs: RETENTION_MS,
            sendLimitPerMinute: SEND_LIMIT_PER_MINUTE,
          },
        },
        quotasCached: this.quotasCached,
        machine,
        // The stored night watch state is read once per tick.
        night,
        worktreeCounts: this.worktreeCounts,
        orphanedWorktreeProcesses: this.orphanedWorktreeProcesses,
        herdr,
        browsers,
        managedBrowsers,
        resourceLeases,
        locks: [],
        errors,
        modelScorecard: buildModelScorecard(readUsage(), now),
      };
      try {
        const livePanes = new Set((herdr?.panes || []).map((pane) => pane.id));
        const queue = readLockQueue({ dataDir: this.lockDataDir, livePanes, now });
        snap.locks = readMachineLocks({
          dataDir: this.lockDataDir,
          livePanes,
          now,
          night: snap.night,
        }).map((lock) => lock.name === FULL_SUITE_LOCK ? { ...lock, queue } : lock);
      } catch (error) { errors.push(`locks: ${error.message}`); }
      snap.projects = listProjects();
      const policy = migrateWorkspacePolicy(loadPolicy(), snap, { file: POLICY_FILE });
      this.memory.exhaustedFreeModels = activeFreeModelExhaustions(this.memory.exhaustedFreeModels, now);
      this.memory.exhaustedFreeLanes = activeFreeLaneExhaustions(this.memory.exhaustedFreeLanes, now);
      for (const pane of herdr?.panes || []) {
        const failure = workerTransitions.failures[pane.id];
        const laneRetry = freeUsageLaneRetry(failure, now);
        if (!laneRetry) continue;
        const checkoutPaths = [...new Set([
          ...herdr.panes.filter((candidate) => candidate.workspace === pane.workspace && candidate.orch && candidate.cwd).map((candidate) => candidate.cwd),
          pane.cwd,
        ])];
        let association = null;
        for (const runsCwd of checkoutPaths) {
          association = resolveFreeUsageRun(pane, { providerFor, policy, runsCwd });
          if (association) break;
        }
        if (!association) continue;
        if (laneRetry.retryKnown) this.memory.exhaustedFreeModels = extendFreeModelExhaustion(this.memory.exhaustedFreeModels, association, failure.retryAt, now);
        // The OpenCode free-usage limit closes every unmetered model of the opencode harness.
        if (association.kind === 'opencode') this.memory.exhaustedFreeLanes = extendFreeLaneExhaustion(this.memory.exhaustedFreeLanes, 'opencode', { ...laneRetry, at: failure.at }, now);
      }
      clearExpiredOneOffGoals(policy, snap.quotas, now, { log: (message) => this.log('policy', message) });
      // Apply the failure status before deriving control, so a failed worker does not count as running.
      snap.herdr = herdr ? { ...herdr, panes: applyWorkerFailureStatuses(herdr.panes, workerTransitions.failures) } : herdr;
      const todayUse = quotaUsageToday(snap.quotas, undefined, now);
      snap.lanes = laneStatus(snap.quotas, policy, now, { todayUse });
      const nightConfig = this.cfg.night || {};
      const laneCapsActive = snap.night?.active === true &&
        Object.values(nightConfig.maxWorkersByLane || {}).some((cap) => Number.isInteger(cap));
      const runningByLane = laneCapsActive ? runningWorkerCountsByLane(snap.herdr, policy, this.models) : {};
      const control = deriveControl(snap, policy, this.models, this.memory.paneSince, now, this.memory.exhaustedFreeModels, {
        exhaustedFreeLanes: this.memory.exhaustedFreeLanes, piModels: this.memory.piModels, lanes: snap.lanes,
        nightMaxWorkers: nightConfig.maxWorkers,
      });
      const profileWorkspaces = Object.fromEntries(managedBrowsers.map((b) => [b.profile, control.projects[b.project]?.workspace]).filter(([, ws]) => ws));
      snap.cpuUse = cpuUse(procs, herdr?.panes || [], profileWorkspaces);
      if (machine) {
        snap.machine.cpuUse = snap.cpuUse;
        snap.machine.cpuTotalSample = [...procs.values()].reduce((sum, proc) => sum + Math.max(0, proc.cpu), 0);
        snap.machine.limits = machineLimits(snap.machine, policy, now, snap.night);
      }
      // The unmetered lane lists the permitted free models that can start. It never affects least-over selection.
      snap.lanes.unmetered = unmeteredLane(this.models, policy, control.projects, this.memory.exhaustedFreeModels, {
        unavailablePiModels: unavailablePiModels(mergeModels(this.models, policy).kinds.pi?.allowedModels, this.memory.piModels),
        exhaustedLanes: this.memory.exhaustedFreeLanes, now,
      });
      snap.leastOverProvider = leastOverProvider(snap.lanes);
      snap.policy = policy;
      snap.control = control;
      this.recordStatusWork(control, now);
      this.readProjectHeads(now);
      this.readProjectConfigs(now);
      snap.workerConfig = this.workerConfig;
      snap.statusActivity = this.statusActivity();
      snap.staleStatus = staleStatuses(snap, this.cfg, now, this.memory.staleStatus);
      this.memory.staleStatus = snap.staleStatus;
      this.memory.lastOrchestrators ||= {};
      for (const p of Object.values(control.projects)) if (p.orch?.kind) this.memory.lastOrchestrators[p.workspace] = { pane: p.orch.pane, kind: p.orch.kind, project: p.slug };
      for (const pane of herdr?.panes || []) if (pane.label === 'boss' && pane.agent) this.memory.lastOrchestrators[pane.workspace] = { pane: pane.id, kind: pane.agent, project: 'Boss', label: 'Boss', boss: true };
      if (this.act) await this.reap(browsers);
      if (this.act) this.sweepClones(now);
      if (this.act) this.scanDenials(now);
      // A prepared successor waits idle by design, so the idle-worker rule skips it.
      try { snap.standbyPanes = listHandoffs().filter((h) => ['preparing', 'prepared', 'needs-inspection'].includes(h.status)).map((h) => h.newPane); }
      catch { snap.standbyPanes = []; }
      const evaluation = evaluate(snap, this.cfg, this.memory.paneSince, now, policy);
      evaluation.alerts.push(...workerTransitions.notices);
      evaluation.alerts.push(...reportTransitions.notices);
      evaluation.alerts.push(...noReportTransitions.notices);
      if (this.act) {
        if (!this.kitNoticeRead) {
          this.kitNoticeRead = true;
          await this.readKitNotice(now);
        }
        const kitAlert = pendingKitAlert(this.memory.kitNotice, now);
        if (kitAlert) evaluation.alerts.push(kitAlert);
      }
      this.memory.quotaRecoveries ||= {};
      // Older records used the reset timestamp as part of the key. Codexbar can
      // adjust that timestamp by a minute, so consolidate them by provider/window.
      for (const [id, recovery] of Object.entries(this.memory.quotaRecoveries)) {
        const parts = id.split(':');
        if (parts.length < 3) continue;
        const key = `${parts[0]}:${parts[1]}`;
        if (!this.memory.quotaRecoveries[key] || recovery.at < this.memory.quotaRecoveries[key].at) {
          this.memory.quotaRecoveries[key] = { ...recovery, resetsAt: parts.slice(2).join(':') };
        }
        delete this.memory.quotaRecoveries[id];
      }
      for (const [id, recovery] of Object.entries(this.memory.quotaRecoveries)) if (now - recovery.at > 7 * 86400 * 1000) delete this.memory.quotaRecoveries[id];
      for (const q of snap.quotas) {
        if (q.error) continue;
        for (const w of q.windows || []) {
          if (w.extra || w.usedPercent >= this.cfg.quota.warnPercent) continue;
          const id = `${q.provider}:${w.key}`;
          const recovery = this.memory.quotaRecoveries[id];
          if (recovery && now - recovery.at < 2 * 3600 * 1000 && Math.abs(Date.parse(w.resetsAt) - Date.parse(recovery.resetsAt)) < 3600 * 1000) continue;
          const old = this.state?.quotas?.find((x) => x.provider === q.provider)?.windows?.find((x) => x.key === w.key);
          const priorWarning = old?.usedPercent >= this.cfg.quota.warnPercent && Date.parse(w.resetsAt) > Date.parse(old.resetsAt);
          const pushedWarning = Object.entries(this.memory.pushes || {}).some(([key, push]) =>
            key.startsWith(`quota:${q.provider}:${w.key}:`) &&
            (key.includes(':warn:') || key.includes(':critical:')) &&
            now - push.at < 2 * 3600 * 1000 &&
            Date.parse(w.resetsAt) > Date.parse(key.split('@')[0].split(':').slice(4).join(':')));
          if (priorWarning || pushedWarning) this.memory.quotaRecoveries[id] = {
            at: now, resetsAt: w.resetsAt,
            text: `${providerName(q.provider)} ${w.label.toLowerCase()} quota has reset to ${w.usedPercent}%. The previous quota restriction is cleared. New agents may use this provider again within the current allocation policy.`,
          };
        }
      }
      for (const [id, recovery] of Object.entries(this.memory.quotaRecoveries)) {
        if (now - recovery.at > 2 * 3600 * 1000) continue;
        const [provider, window] = id.split(':');
        const current = snap.quotas.find((q) => q.provider === provider && !q.error)?.windows?.find((w) => w.key === window);
        if (!current || current.usedPercent >= this.cfg.quota.warnPercent || Math.abs(Date.parse(current.resetsAt) - Date.parse(recovery.resetsAt)) >= 3600 * 1000) continue;
        evaluation.alerts.push(quotaRecoveredAlert(id, recovery));
      }
      for (const h of handoffCandidates(control).filter((candidate) => candidate.window)) {
        evaluation.alerts.push({
          key: `handoff:${h.workspace}:${h.provider}:${h.window.resetsAt}`,
          severity: h.window.usedPercent >= 98 ? 'critical' : 'warn',
          // The Boss's own handover goes to the Owner, not to the Boss pane itself.
          scope: h.boss || (herdr?.panes || []).some((x) => x.id === h.pane && x.label === 'boss') ? 'user' : h.workspace,
          ...(h.window.usedPercent >= 98 ? { prompt: false } : {}),
          title: `Prepare ${h.label || h.project} orchestrator handover`,
          text: h.target
            ? `${h.provider} is at ${h.window.usedPercent}% in its ${h.window.label} window. Prepare a ${h.target.kind} (${h.target.model}${h.target.effort ? `, ${h.target.effort}` : ''}) successor before the orchestrator runs out. Use herdr-boss handoff plan ${h.pane} --to ${h.target.kind} --model ${h.target.model}${h.target.effort ? ` --effort ${h.target.effort}` : ''}, then handoff prepare after review. Keep the current orchestrator until the successor is ready.`
            : `${h.provider} is at ${h.window.usedPercent}% in its ${h.window.label} window, but no eligible choice remains in the orchestrator succession ladder. Review Allocation and prepare a successor manually before this quota runs out.`,
        });
      }
      let handoffRecords = [];
      try { handoffRecords = listHandoffs(); } catch {}
      for (const h of handoffRecords) {
        if (['prepared', 'needs-inspection'].includes(h.status) && h.promptError) evaluation.alerts.push({
          key: `successor:prompt:${h.id}`, severity: 'warn', once: true, scope: h.boss || h.label === 'boss' ? 'user' : h.workspace || 'user',
          title: `${h.project} successor did not get its prompt`,
          text: `The bootstrap prompt did not reach the proposed successor ${h.id} in pane ${h.newPane}. It cannot report ready, so automatic activation cannot happen. Read the pane with herdr agent read ${h.newPane}, then send the prompt again or close the pane and prepare a new successor.`,
        });
        // Expire an automatic successor two hours after preparation when its source provider is no longer at risk.
        const sourceProvider = providerFor(h.fromKind, policy.preferredModels?.[h.fromKind] ?? this.models.kinds[h.fromKind]?.defaultModel, policy);
        if (h.status === 'prepared' && h.automatic && now - Date.parse(h.preparedAt) > 2 * 3600000 && !control.risks[sourceProvider]) {
          const expired = this.act ? expireHandoff(h.id, `${sourceProvider || 'the source provider'} is no longer near its limit`) : null;
          if (expired) {
            this.log('handoff', `Expired unused successor ${h.id} in pane ${h.newPane}`, h.boss || h.label === 'boss' ? { workspace: h.workspace, pane: h.newPane } : { project: h.project, pane: h.newPane });
            evaluation.alerts.push({
              key: `successor:expired:${h.id}`, severity: 'info', once: true, scope: h.boss || h.label === 'boss' ? 'user' : h.workspace || 'user',
              title: `${h.displayLabel || h.project} successor expired`,
              text: `The prepared successor ${h.id} in pane ${h.newPane} expired: ${expired.expiredReason}. Close that pane when you do not need it. Boss prepares a new successor if the quota comes near its limit again.`,
            });
          }
        }
      }
      for (const p of Object.values(control.projects)) if (p.running > p.slots && !p.idle) evaluation.alerts.push({
        key: `allocation:${p.workspace}:${p.slots}`, severity: 'info', scope: p.workspace,
        title: `${p.label} uses ${p.running}/${p.slots} worker slots`,
        text: `${p.label} has ${p.running} working agents; its current allocation is ${p.slots}. Let current work finish, then delay new workers until within allocation.`,
      });
      for (const b of managedBrowsers) {
        const running = browsers.some((x) => x.kind === 'automation-chrome' && x.port === String(b.port) && x.profile === b.profile);
        if (running && b.responsive && b.launchedAt && now - Date.parse(b.launchedAt) < 86400000) {
          const p = control.projects[b.project];
          if (p?.workspace) evaluation.alerts.push(browserReadyAlert(b, p.workspace));
        }
        if (!b.launchedAt || now - Date.parse(b.launchedAt) < 120000) continue;
        if (running) continue;
        const p = control.projects[b.project];
        evaluation.alerts.push({
          key: `browser:managed-down:${b.project}:${b.port}`, severity: 'warn', scope: p?.workspace || 'user',
          title: `${b.project} browser is offline`,
          text: `The recorded browser for ${b.project} on port ${b.port} is offline. Request it again with herdr-boss browser request ${b.project} before browser work.`,
        });
      }
      snap.alerts = evaluation.alerts;
      snap.advice = evaluation.advice;
      const quotaAlerts = evaluation.alerts.filter((alert) => alert.key.startsWith('quota:') && alert.severity !== 'info');
      const criticalProviders = new Set(quotaAlerts.filter((alert) => alert.severity === 'critical').map((alert) => alert.key.split(':')[1]));
      const limitedProviders = new Set(quotaAlerts.map((alert) => alert.key.split(':')[1]));
      const avoidKinds = [...new Set([...criticalProviders].filter((provider) => provider === 'codex' || provider === 'claude'))];
      const preferredKinds = Object.keys(control.globalAllowed).filter((kind) => control.globalAllowed[kind].some((model) => {
        const provider = providerFor(kind, model, policy);
        return !provider || !limitedProviders.has(provider);
      }));
      writeJson(path.join(DATA_DIR, 'rules.json'), {
        updatedAt: snap.updatedAt,
        avoidKinds,
        avoidProviders: Object.keys(snap.lanes).filter((provider) => {
          const lane = snap.lanes[provider];
          if (lane.state === 'trickle' && lane.usedTodayPercent < lane.allowancePercent) return false;
          return control.pressures[provider] || control.risks[provider] || lane.state === 'exhausted';
        }),
        lanes: snap.lanes,
        leastOverProvider: snap.leastOverProvider,
        piModels: this.memory.piModels || null,
        preferredKinds,
        memFreePercent: machine?.memFreePercent ?? null,
        load: machine ? { oneMinute: machine.load[0], fiveMinute: machine.load[1], cpus: machine.cpus, limit: machineLimits(snap.machine, policy, now, snap.night).loadLimit } : null,
        machine: snap.machine?.limits || null,
        notes: evaluation.advice,
        browsers: managedBrowsers.map((b) => ({ project: b.project, port: b.port, profile: b.profile, headless: !!b.headless, windowSize: b.windowSize || { width: 1280, height: 800 }, ready: browsers.some((x) => x.kind === 'automation-chrome' && x.port === String(b.port) && x.profile === b.profile), responsive: b.responsive })),
        policy,
        night: { active: snap.night?.active === true, maxWorkersByLane: nightConfig.maxWorkersByLane || {} },
        control: { runningWorkers: control.runningWorkers, maxWorkers: control.maxWorkers, runningByLane, projects: control.projects, workspaces: control.workspaces },
      });
      snap.paneSince = this.memory.paneSince;
      snap.history = this.memory.history || [];
      snap.push = this.push;
      // The denial trend is for the Owner. It goes to the dashboard and the bulletin, never to a pane prompt.
      snap.denials = denialSummary(readDenials(DATA_DIR), now, { pendingBytes: this.memory.denialScan?.pendingBytes || 0 });
      fs.writeFileSync(BULLETIN_FILE, renderBulletin(snap, evaluation, this.cfg));
      if (this.act) await this.deliver(evaluation.alerts, herdr, now, snap.night);
      if (this.act && this.push) await this.deliverLockTakeoverNotices(herdr);
      if (this.act && this.push) await this.deliverNightNotices(snap.night, herdr, now);
      // Owner messages use a fresh pane list so delivery can act on current pane status.
      if (this.act && this.push && currentPaneList) {
        try { await this.deliverOwnerMessages(herdr, control.projects, now); }
        catch (e) { errors.push(`messages: ${e.message}`); }
      }
      await this.deliverNightReports(snap, now);
      snap.events = this.events.slice(-60);
      try { snap.mailbox = mailboxCounts(readMessages({ dir: DATA_DIR })); }
      catch (e) { errors.push(`mailbox: ${e.message}`); }

      this.state = snap;
      writeJson(STATE_FILE, snap);
      writeJson(MEMORY_FILE, this.memory);
      this.emit('state', snap);
      if (this.act) {
        try { await this.notifyHandoffPeers(herdr, now); }
        catch (e) { this.log('error', `Handover peer notice check failed: ${e.message}`); }
      }
      if (this.act && policy.autoHandover) {
        try { await this.autoHandover(control, herdr, policy, now, snap.lanes); }
        catch (e) { this.log('error', `Automatic handover check failed: ${e.message}`); }
      }
      writeJson(MEMORY_FILE, this.memory);
      return snap;
    } finally {
      this.running = false;
    }
  }

  // Runs once per service start: git reads only, no timers.
  async readKitNotice(now) {
    const result = await readKitNotice({ root: this.kitRoot, stored: this.memory.kitNotice, git: this.gitRunner, now });
    if (result.state) this.memory.kitNotice = result.state;
    if (result.event) this.log('kit', result.event);
    if (result.alert) this.log('kit', `Queued kit notice ${result.alert.key} for each project orchestrator`);
    return result;
  }

  // The stale status rule needs the last time each project had a working worker.
  recordStatusWork(control, now) {
    const activity = (this.memory.statusActivity ||= {});
    for (const p of Object.values(control?.projects || {})) if (p.slug && p.running > 0) activity[p.slug] = { ...activity[p.slug], workedAt: now };
    for (const [slug, item] of Object.entries(activity)) if (!(now - item.workedAt <= 7 * 86400 * 1000)) delete activity[slug];
  }

  // The HEAD read runs beside the tick, at most once every 10 minutes per project, for each project in project-repos.json.
  // A changed HEAD, or a HEAD commit after the published updated time, means new commits landed.
  readProjectHeads(now) {
    const heads = (this.memory.statusHeads ||= {});
    const repos = readProjectRepos(DATA_DIR);
    for (const slug of Object.keys(heads)) if (!repos.some((row) => row.slug === slug)) delete heads[slug];
    const reads = repos.filter((row) => !this.headReads.has(row.slug) && !(now - (heads[row.slug]?.checkedAt ?? -Infinity) < STATUS_HEAD_INTERVAL_MS)).map(async ({ slug, repo }) => {
      this.headReads.add(slug);
      heads[slug] = { ...heads[slug], checkedAt: now };
      try {
        const head = String(await this.gitRunner(['-C', repo, 'rev-parse', 'HEAD'])).trim();
        const committedAt = String(await this.gitRunner(['-C', repo, 'log', '-1', '--format=%cI'])).trim();
        const previous = heads[slug];
        heads[slug] = { checkedAt: now, head, committedAt, changedAt: previous.head && previous.head !== head ? now : previous.changedAt ?? null };
      } catch (error) {
        this.log('status', `HEAD read for ${slug} failed (${error.code || 'error'}).`, { project: slug });
      } finally { this.headReads.delete(slug); }
    });
    return Promise.all(reads);
  }

  // The read-only worker config of each registered project, with allow-listed fields only.
  // The read runs once at start and every 10 minutes. One bad project never stops the others.
  readProjectConfigs(now) {
    if (now - this.workerConfigAt < PROJECT_CONFIG_INTERVAL_MS) return;
    this.workerConfigAt = now;
    const next = {};
    for (const { slug, repo } of readProjectRepos(DATA_DIR)) {
      try {
        next[slug] = workerConfigView(loadProjectConfig({ cwd: repo }));
      } catch (error) {
        next[slug] = { fields: [], error: String(error?.message || error) };
      }
    }
    this.workerConfig = next;
  }

  // The harness readiness check reads the harness settings files. The engine runs it at each
  // service start and then every 10 minutes, not on each tick. The state keeps no finding text.
  readHarness(now) {
    if (this.harness && now - this.harnessAt < HARNESS_CHECK_INTERVAL_MS) return this.harness;
    this.harnessAt = now;
    let findings = [];
    try { findings = this.collectors.checkHarness() || []; }
    catch (error) { this.log('harness', `Harness readiness check failed (${error.code || 'error'}).`); }
    // Drop the text. It holds file paths and setting values.
    this.harness = {
      checkedAt: new Date(now).toISOString(),
      findings: findings.map(({ status, area, item }) => ({ status, area, item })),
    };
    return this.harness;
  }

  // { slug: { workedAt, landedAt } } in milliseconds, for staleStatuses().
  statusActivity() {
    const result = {};
    for (const [slug, item] of Object.entries(this.memory.statusActivity || {})) result[slug] = { workedAt: item.workedAt };
    for (const [slug, item] of Object.entries(this.memory.statusHeads || {})) {
      const times = [Date.parse(item.committedAt), item.changedAt].filter(Number.isFinite);
      if (times.length) result[slug] = { ...result[slug], landedAt: Math.max(...times) };
    }
    return result;
  }

  trackPaneStatus(herdr, now) {
    if (!herdr) return;
    const next = {};
    for (const p of herdr.panes) {
      const status = p.agent ? p.status : 'shell';
      const prev = this.memory.paneSince[p.id];
      next[p.id] = prev && prev.status === status ? prev : { status, since: now };
    }
    this.memory.paneSince = next;
  }

  async reap(browsers) {
    const c = this.cfg.browsers;
    if (!c.reapOrphanDaemons) return;
    // A daemon can hold a browser that it started as a detached process. Keep every daemon
    // that started up to 10 minutes before a running automation browser.
    const chromes = browsers.filter((b) => b.kind === 'automation-chrome');
    const holdsBrowser = (d) => chromes.some((b) => b.age <= d.age && d.age - b.age <= 600);
    const victims = browsers.filter((b) => b.kind === 'agent-browser-daemon' && b.orphan && b.children === 0 && b.cpu < 1
      && b.age >= c.orphanDaemonMinAgeSeconds && !holdsBrowser(b));
    if (!victims.length) return;
    for (const v of victims) { try { process.kill(v.pid, 'SIGTERM'); } catch {} }
    this.log('reap', `Terminated ${victims.length} orphaned agent-browser daemon(s): ${victims.map((v) => `${v.pid} (${fmtDuration(v.age)})`).join(', ')}`);
  }

  // The quota read runs beside the tick, because codexbar can take minutes on a loaded machine.
  // A later tick applies the result. Only one read runs at a time.
  readQuotas() {
    if (this.quotaRead) return this.quotaRead;
    let read;
    try { read = Promise.resolve(this.collectors.collectQuotas()); } catch (error) { read = Promise.reject(error); }
    this.quotaRead = read.then(
      (quotas) => { this.quotaResult = { quotas, at: Date.now() }; },
      (error) => {
        const message = String(error?.message || error);
        this.quotaResult = { error: /^codexbar\b/.test(message) ? message : `codexbar: ${message}` };
      },
    ).finally(() => { this.quotaRead = null; });
    return this.quotaRead;
  }

  applyQuotaResult() {
    const result = this.quotaResult;
    if (!result) return;
    this.quotaResult = null;
    if (result.error || !Array.isArray(result.quotas)) {
      // A failed read keeps the last good quotas.
      this.quotaError = result.error || 'codexbar: no quota rows';
      return;
    }
    this.quotas = keepStaleRows(result.quotas, this.quotas, this.quotasAt, result.at);
    this.quotasAt = result.at;
    this.quotasCached = false;
    this.quotaError = null;
    recordQuotaSnapshot(this.quotas, new Date(result.at).toISOString());
  }

  // The sweep runs beside the tick, because deleting many clones can take longer than one tick.
  sweepClones(now) {
    if (this.cfg.browsers?.sweepCodeSignClones === false || this.cloneSweepRunning || now - this.cloneSweepAt < CLONE_SWEEP_INTERVAL_MS) return null;
    this.cloneSweepAt = now;
    this.cloneSweepRunning = true;
    return (async () => {
      const dir = this.collectors.codeSignCloneDir();
      if (!dir) return;
      const result = await this.collectors.sweepCodeSignClones({ dir, now });
      if (!result.removed.length) return;
      const freedGiB = (result.freedBytes / 1024 ** 3).toFixed(1);
      this.log('clone-sweep', `Deleted ${result.removed.length} orphaned Chrome code-sign clone(s) and freed ${freedGiB} GiB.`, { count: result.removed.length, freedBytes: result.freedBytes });
    })().catch((error) => this.log('clone-sweep', `Chrome code-sign clone sweep failed: ${error.message}`))
      .finally(() => { this.cloneSweepRunning = false; });
  }

  // The denial log scan runs beside the tick, like the clone sweep. It logs counts only, never a path or a message.
  scanDenials(now) {
    if (this.denialScanRunning || now - this.denialScanAt < DENIAL_SCAN_INTERVAL_MS) return null;
    this.denialScanAt = now;
    this.denialScanRunning = true;
    return (async () => {
      const result = await this.collectors.runDenialScan({ state: this.memory.denialScan || {}, now });
      this.memory.denialScan = result.state;
    })().catch((error) => this.log('denials', `Denial log scan failed (${error.code || 'error'}).`))
      .finally(() => { this.denialScanRunning = false; });
  }

  async autoHandover(control, herdr, policy, now, lanes = {}) {
    // Never switch labels using stale quota data or a guessed successor state.
    if (!this.quotasAt || this.quotasCached || now - this.quotasAt > (this.cfg.quotaSeconds + this.cfg.tickSeconds) * 1000) return;
    this.memory.autoHandoverAttempts ||= {};
    for (const [key, at] of Object.entries(this.memory.autoHandoverAttempts)) if (now - at > 7 * 86400 * 1000) delete this.memory.autoHandoverAttempts[key];
    const records = listHandoffs();
    for (const item of records.filter((x) => x.status === 'prepared' && x.automatic && x.readyAt && !x.promptError)) {
      const targetProvider = providerFor(item.toKind, item.model, policy);
      const targetLane = lanes[targetProvider];
      if (targetLane?.state === 'trickle' && targetLane.usedTodayPercent >= targetLane.allowancePercent) continue;
      const sourceKind = item.fromKind || this.memory.lastOrchestrators?.[item.workspace]?.kind;
      const provider = providerFor(sourceKind, policy.preferredModels?.[sourceKind] ?? this.models.kinds[sourceKind]?.defaultModel, policy);
      const quota = this.quotas.find((q) => q.provider === provider && !q.error);
      if (!quota?.windows?.some((w) => !w.extra && w.usedPercent >= policy.autoHandoverPercent)) continue;
      const target = herdr?.panes?.find((p) => p.id === item.newPane);
      const source = herdr?.panes?.find((p) => p.id === item.sourcePane);
      if (target?.agent !== item.toKind || !['idle', 'done'].includes(target.status) || source?.label !== item.label) continue;
      const key = `activate:${item.id}`;
      if (now - (this.memory.autoHandoverAttempts[key] || 0) < 60000) continue;
      this.memory.autoHandoverAttempts[key] = now;
      writeJson(MEMORY_FILE, this.memory);
      try {
        await this.handoffRunner(process.execPath, [CLI_FILE, 'handoff', 'activate', item.id, '--confirmed'], { timeout: 180000 });
        this.log('handoff', `Automatically activated ${item.toKind} successor for ${item.label || item.project}`, item.boss ? { workspace: item.workspace, pane: item.newPane } : { project: item.project, pane: item.newPane });
      } catch (e) { this.log('error', `Automatic activation for ${item.label || item.project} failed: ${String(e.stderr || e.message).slice(0, 300)}`); }
    }
    const successorLimits = { exhaustedFreeModels: this.memory.exhaustedFreeModels, exhaustedFreeLanes: this.memory.exhaustedFreeLanes, piModels: this.memory.piModels, lanes };
    const stopped = Object.values(control.projects).flatMap((p) => {
      const last = this.memory.lastOrchestrators[p.workspace];
      if (!p.orch || p.orch.kind || last?.pane !== p.orch.pane) return [];
      const provider = providerFor(last.kind, policy.preferredModels?.[last.kind] ?? this.models.kinds[last.kind]?.defaultModel, policy);
      const window = this.quotas.find((q) => q.provider === provider && !q.error)?.windows?.find((w) => !w.extra && w.usedPercent >= policy.autoHandoverPercent);
      if (!window) return [];
      return [{ project: p.slug, pane: p.orch.pane, fromKind: last.kind, sessionId: null, window, target: pickSuccessor(p, last.kind, provider, policy, { ...control, ...successorLimits }, now) }];
    });
    const stoppedBoss = (herdr?.panes || []).filter((pane) => pane.label === 'boss' && !pane.agent).flatMap((pane) => {
      const last = this.memory.lastOrchestrators[pane.workspace];
      if (!last?.kind || last.pane !== pane.id) return [];
      const provider = providerFor(last.kind, policy.preferredModels?.[last.kind] ?? this.models.kinds[last.kind]?.defaultModel, policy);
      const window = this.quotas.find((q) => q.provider === provider && !q.error)?.windows?.find((w) => !w.extra && w.usedPercent >= policy.autoHandoverPercent);
      if (!window) return [];
      const project = { excludedKinds: [], excludedModels: [] };
      return [{ project: 'Boss', label: 'Boss', boss: true, workspace: pane.workspace, pane: pane.id, fromKind: last.kind, sessionId: null, window, target: pickSuccessor(project, last.kind, provider, policy, { ...control, ...successorLimits }, now) }];
    });
    for (const h of [...handoffCandidates(control), ...stopped, ...stoppedBoss]) {
      if (!h.window) continue;
      // A stale row is data for pacing, but not proof for a handover.
      if (h.provider && this.quotas.find((q) => q.provider === h.provider)?.stale) continue;
      if (records.some((x) => x.sourcePane === h.pane && ['prepared', 'preparing', 'needs-inspection'].includes(x.status))) continue;
      if (!h.target) {
        const key = `no-target:${h.pane}:${h.window.resetsAt}`;
        if (!this.memory.autoHandoverAttempts[key]) {
          this.memory.autoHandoverAttempts[key] = now;
          this.log('error', `Automatic handover for ${h.label || h.project} has no eligible alternative provider`, h.boss ? { workspace: h.workspace, pane: h.pane } : { project: h.project });
        }
        continue;
      }
      const key = `prepare:${h.pane}`;
      if (now - (this.memory.autoHandoverAttempts[key] || 0) < 15 * 60000) continue;
      this.memory.autoHandoverAttempts[key] = now;
      writeJson(MEMORY_FILE, this.memory);
      try {
        const mode = ['codex', 'claude'].includes(h.target.kind) && h.sessionId ? 'migrate' : 'fresh';
        const effort = h.target.effort ? ['--effort', h.target.effort] : [];
        const args = [CLI_FILE, 'handoff', 'plan', h.pane, '--to', h.target.kind, '--model', h.target.model, '--mode', mode, ...effort];
        const plan = JSON.parse(await this.handoffRunner(process.execPath, args, { timeout: 180000 }));
        const chosen = mode === 'migrate' && !plan.migration?.available ? 'fresh' : mode;
        const prepared = JSON.parse(await this.handoffRunner(process.execPath,
          [CLI_FILE, 'handoff', 'prepare', h.pane, '--to', h.target.kind, '--model', h.target.model, '--mode', chosen, ...effort, '--auto'],
          { timeout: 300000 }));
        this.log('handoff', `Automatically prepared ${h.target.kind} successor for ${h.label || h.project}; awaiting readiness`, h.boss ? { workspace: h.workspace, pane: prepared.newPane } : { project: h.project, pane: prepared.newPane });
      } catch (e) {
        const reason = String(e.stderr || e.message).slice(0, 300);
        this.log('error', `Automatic preparation for ${h.label || h.project} failed: ${reason}`);
      }
    }
  }

  async notifyHandoffPeers(herdr, now) {
    this.memory.handoffPeerNotices ||= {};
    this.memory.handoffPeerAttempts ||= {};
    const current = herdr?.panes || [];
    const panes = new Map(current.map((p) => [p.id, p]));
    const records = listHandoffs();
    const knownBossPanes = new Set(current.filter((pane) => ['boss', 'boss previous'].includes(pane.label)).map((pane) => pane.id));
    for (const record of records) {
      if (!(record.boss || record.label === 'boss')) continue;
      if (typeof record.sourcePane === 'string') knownBossPanes.add(record.sourcePane);
      if (typeof record.newPane === 'string') knownBossPanes.add(record.newPane);
    }
    for (const item of records.filter((x) => x.status === 'active' && now - Date.parse(x.activatedAt) < 7 * 86400 * 1000)) {
      for (const notice of handoffNotices(item, current)) {
        const { key } = notice;
        let deliveredAt = this.memory.handoffPeerNotices[key];
        if (!deliveredAt && key === `${item.id}@boss`) {
          for (const pane of knownBossPanes) {
            const legacyKey = `${item.id}@${pane}`;
            if (!this.memory.handoffPeerNotices[legacyKey]) continue;
            deliveredAt = this.memory.handoffPeerNotices[legacyKey];
            this.memory.handoffPeerNotices[key] = deliveredAt;
            break;
          }
        }
        if (deliveredAt || now - (this.memory.handoffPeerAttempts[key] || 0) < 60000) continue;
        // An agent prompt needs push and a settled agent pane; an unavailable recipient stays eligible.
        if (!notice.owner) {
          const pane = panes.get(notice.pane);
          if (!this.push || !pane?.agent || !['idle', 'done'].includes(pane.status)) continue;
        }
        this.memory.handoffPeerAttempts[key] = now;
        const recipient = notice.owner ? 'the Owner' : notice.pane;
        try {
          const args = notice.owner ? ['notification', 'show', notice.title, '--body', notice.text, '--sound', 'none'] : ['agent', 'prompt', notice.pane, notice.text];
          checkHerdrResponse(await this.herdrRunner('herdr', args));
          this.memory.handoffPeerNotices[key] = now;
          this.log(notice.owner ? 'notify' : 'push', `Notified ${recipient} of ${item.displayLabel || item.project} orchestrator handover`, notice.owner ? {} : { pane: notice.pane, project: item.project });
        } catch (e) { this.log('error', `Handover notice to ${recipient} failed: ${String(e.stderr || e.message).slice(0, 200)}`); }
      }
    }
    for (const [key, at] of Object.entries(this.memory.handoffPeerNotices)) if (now - at > 8 * 86400 * 1000) delete this.memory.handoffPeerNotices[key];
    for (const [key, at] of Object.entries(this.memory.handoffPeerAttempts)) if (now - at > 8 * 86400 * 1000) delete this.memory.handoffPeerAttempts[key];
  }

  async retirePreviousOrchestrators(herdr, now) {
    const handoffs = listHandoffs().filter((item) => ['active', 'superseded'].includes(item.status));
    const records = handoffs.filter((item) => Number.isFinite(Date.parse(item.activatedAt))
      && now - Date.parse(item.activatedAt) >= 120 * 60 * 1000
      && (!item.retirement?.completedAt || item.retirement.outcome === 'closed'));
    const panes = new Map((herdr?.panes || []).map((pane) => [pane.id, pane]));
    for (const item of records) {
      const latest = handoffs.find((candidate) => candidate.id === item.id && ['active', 'superseded'].includes(candidate.status)
        && candidate.sourcePane === item.sourcePane && candidate.newPane === item.newPane
        && candidate.activatedAt === item.activatedAt);
      if (!latest) continue;
      if (latest.retirement?.completedAt) {
        if (latest.retirement.outcome === 'closed') {
          const role = latest.boss || latest.label === 'boss' ? 'boss' : 'orch';
          const source = panes.get(latest.sourcePane);
          const successor = this.resolveHandoffSuccessor(latest, handoffs, panes, role);
          if (!source && successor) await this.notifyRetiredSuccessor(latest, role, successor, now);
        }
        continue;
      }
      const source = panes.get(latest.sourcePane);
      if (!source) {
        this.recordHandoffRetirement(latest, { outcome: 'source-absent', completedAt: new Date(now).toISOString() }, now);
        this.log('handoff', `Previous pane was already absent for handoff ${latest.id}; retirement is complete`, latest.boss
          ? { workspace: latest.workspace, pane: latest.newPane } : { project: latest.project, pane: latest.newPane });
        continue;
      }
      const role = latest.boss || latest.label === 'boss' ? 'boss' : 'orch';
      const successor = this.resolveHandoffSuccessor(latest, handoffs, panes, role);
      if (source.label !== `${role} previous` || !successor) continue;
      try {
        checkHerdrResponse(await this.herdrRunner('herdr', ['pane', 'close', latest.sourcePane]));
      } catch (error) {
        this.log('error', `Could not retire previous ${role} pane for handoff ${latest.id}: ${String(error.stderr || error.message).slice(0, 200)}`,
          latest.boss ? { workspace: latest.workspace, pane: latest.newPane } : { project: latest.project, pane: latest.newPane });
        continue;
      }
      this.recordHandoffRetirement(latest, { outcome: 'closed', completedAt: new Date(now).toISOString() }, now);
      await this.notifyRetiredSuccessor(latest, role, successor, now);
      this.log('handoff', `Retired previous ${role} pane for handoff ${latest.id}`, latest.boss
        ? { workspace: latest.workspace, pane: latest.sourcePane } : { project: latest.project, pane: latest.sourcePane });
    }
  }

  resolveHandoffSuccessor(item, activeRecords, panes, role) {
    let paneId = item.newPane;
    const seen = new Set([item.sourcePane]);
    while (typeof paneId === 'string' && !seen.has(paneId)) {
      seen.add(paneId);
      const pane = panes.get(paneId);
      if (!pane) return null;
      if (pane.label === role) return pane;
      if (pane.label !== `${role} previous`) return null;
      const next = activeRecords.find((candidate) => ['active', 'superseded'].includes(candidate.status)
        && candidate.sourcePane === paneId
        && candidate.id !== item.id && Date.parse(candidate.activatedAt) > Date.parse(item.activatedAt)
        && (candidate.boss || candidate.label === 'boss' ? 'boss' : 'orch') === role
        && candidate.activation?.sourcePane === candidate.sourcePane
        && candidate.activation?.successorPane === candidate.newPane
        && candidate.activation?.sourceLabel === `${role} previous`
        && candidate.activation?.successorLabel === role);
      if (!next) return null;
      paneId = next.newPane;
    }
    return null;
  }

  async notifyRetiredSuccessor(item, role, successor, now) {
    const noticeKey = `handoff-retirement:${item.id}`;
    this.memory.handoffRetirementNotices ||= {};
    if (this.memory.handoffRetirementNotices[noticeKey] || !successor?.id
      || successor.label !== role || !successor.agent || !['idle', 'done'].includes(successor.status)) return;
    const roleName = role === 'boss' ? 'Boss' : 'orchestrator';
    const message = `[herdr-boss] The 120-minute handover grace period ended. The previous ${roleName} pane ${item.sourcePane} was closed. Continue using pane ${successor.id}.`;
    try {
      checkHerdrResponse(await this.herdrRunner('herdr', ['agent', 'prompt', successor.id, message]));
      this.memory.handoffRetirementNotices[noticeKey] = now;
      writeJson(MEMORY_FILE, this.memory);
    } catch (error) {
      this.log('error', `Retirement notice for handoff ${item.id} failed: ${String(error.stderr || error.message).slice(0, 200)}`,
        item.boss ? { workspace: item.workspace, pane: item.newPane } : { project: item.project, pane: item.newPane });
    }
  }

  recordHandoffRetirement(item, retirement, now) {
    const current = listHandoffs();
    const record = current.find((candidate) => candidate.id === item.id && ['active', 'superseded'].includes(candidate.status)
      && candidate.sourcePane === item.sourcePane && candidate.newPane === item.newPane
      && candidate.activatedAt === item.activatedAt);
    if (!record) return false;
    if (record.retirement?.completedAt) {
      return false;
    }
    record.retirement = retirement;
    const file = path.join(DATA_DIR, 'handoffs.json');
    writeJson(file, current);
    return true;
  }

  // One Owner message per pane per tick. A pane that got a resource notice in this tick waits for the next tick.
  async deliverOwnerMessages(herdr, projects, now) {
    const busy = new Set(Object.entries(this.memory.pushes || {}).filter(([, record]) => record?.at === now).map(([key]) => key.slice(key.lastIndexOf('@') + 1)));
    await deliverQueued({
      panes: herdr?.panes || [], projects, now, busy,
      log: (type, text, extra) => this.log(type, text, extra),
      prompt: async (pane, text) => checkHerdrResponse(await this.herdrRunner('herdr', ['agent', 'prompt', pane, text])),
    });
  }

  async deliverLockTakeoverNotices(herdr) {
    if (!this.push || !herdr?.panes) return;
    let notices;
    try { notices = readLockTakeoverNotices({ dataDir: this.lockDataDir }); }
    catch (error) { this.log('error', `Could not read expired lock notices: ${error.message}`); return; }
    const panes = new Set(herdr.panes.map((pane) => pane.id));
    for (const notice of notices) {
      if (!panes.has(notice.ownerPane)) continue;
      const text = [
        '[herdr-boss] Resource notice. Act on it if it concerns your work. You do not need to reply to me.',
        `- ${notice.text}`,
      ].join('\n');
      try {
        checkHerdrResponse(await this.herdrRunner('herdr', ['agent', 'prompt', notice.ownerPane, text]));
        removeLockTakeoverNotice(notice.id, { dataDir: this.lockDataDir });
        this.log('notify', notice.text, { severity: notice.severity, pane: notice.ownerPane });
      } catch (error) {
        this.log('error', `Expired lock notice to ${notice.ownerPane} failed: ${String(error.stderr || error.message).slice(0, 200)}`);
      }
    }
  }

  // One start notice and one end notice per pane. The marks live in night.json, so a restart sends no notice twice.
  // A pane that joins during the night gets the start notice at the next tick. A failed send stores no mark, so the
  // next tick sends the notice again. A stop clears the file, so the engine keeps the last active record in memory
  // and sends the end notice from it.
  async deliverNightNotices(night, herdr, now) {
    if (!this.push || !herdr?.panes) return;
    const stored = readNightRecord({ dataDir: DATA_DIR });
    const active = night?.active === true;
    const record = stored || this.memory.nightRecord;
    if (!record) return;
    const phase = active ? 'start' : 'end';
    const sent = nightNoticeSent(record, phase);
    const live = new Map(herdr.panes.map((pane) => [pane.id, pane]));
    const targets = phase === 'start'
      ? herdr.panes.filter((pane) => nightNoticeTarget(pane) && !sent.has(pane.id)).map((pane) => pane.id)
      // Only a pane that got the start notice gets the end notice.
      : [...nightNoticeSent(record, 'start')].filter((pane) => !sent.has(pane) && live.has(pane));
    const text = nightNoticeText(phase, record);
    let marked = false;
    let marks = record;
    for (const pane of targets) {
      try {
        checkHerdrResponse(await this.herdrRunner('herdr', ['agent', 'prompt', pane, text]));
        marks = withNoticeMark(marks, phase, pane, new Date(now).toISOString());
        marked = true;
        this.log('notify', text, { pane });
      } catch (error) {
        this.log('error', `Night watch ${phase} notice to ${pane} failed: ${String(error.stderr || error.message).slice(0, 200)}`);
      }
    }
    if (marked && stored) {
      try { writeNight(marks, { dataDir: DATA_DIR }); }
      catch (error) { this.log('error', `Could not store the night notice marks: ${error.message}`); }
    }
    // The mirror holds the marks of an active night. It is dropped once the night is not active.
    const mirror = active ? marks : null;
    if (JSON.stringify(this.memory.nightRecord ?? null) !== JSON.stringify(mirror)) {
      this.memory.nightRecord = mirror;
      writeJson(MEMORY_FILE, this.memory);
    }
  }

  // Timed reports use the raw record so a tick at or after the end time can still fire.
  async deliverNightReports(snap, now) {
    for (const kind of ['retro', 'report']) {
      const record = readNightRecord({ dataDir: DATA_DIR });
      if (record?.active !== true || !record.since) continue;
      const deadline = Date.parse(record[kind === 'retro' ? 'retroAt' : 'reportAt']);
      const mark = kind === 'retro' ? 'retroSentAt' : 'reportSentAt';
      if (!Number.isFinite(deadline) || now < deadline || record[mark]) continue;
      const nightKey = `${record.since}:${kind}`;
      try {
        // Find a committed message after a restart before appending another one.
        const posted = this.messageStore.all().some((message) => message.kind === 'report' && message.nightReportKey === nightKey);
        if (!posted) {
          const text = renderNightReport({
            night: record,
            kind,
            now,
            projects: snap.projects,
            control: snap.control,
            herdr: snap.herdr,
            paneSince: this.memory.paneSince,
            usage: readUsage(),
            events: this.events,
          });
          this.messageStore.append({
            thread: 'boss', from: 'boss', to: 'owner', kind: 'report',
            title: kind === 'retro' ? 'Night watch retro' : 'Night watch report',
            text, action: 'read', replyTo: null, status: 'new', nightReportKey: nightKey,
          }, { now });
        }
        const latest = readNightRecord({ dataDir: DATA_DIR }) || record;
        if (!latest[mark]) writeNight(withNightReportMark(latest, kind, new Date(now).toISOString()), { dataDir: DATA_DIR });
      } catch (error) {
        this.log('error', `Night watch ${kind} failed: ${String(error?.message || error).slice(0, 200)}`);
      }
    }
  }

  async deliver(alerts, herdr, now, night = null) {
    const cooldown = loadPolicy().machine.alertCooldownSeconds * 1000;
    const orchs = (herdr?.panes || []).filter((p) => p.orch && p.agent);
    const active = new Set(alerts.map((a) => a.key));
    const quiet = quietHoursActive(night);
    this.memory.notified ||= {};
    this.memory.quietNotifications = Array.isArray(this.memory.quietNotifications) ? this.memory.quietNotifications : [];

    // Deliver notifications once when quiet hours end. The service keeps the queue in memory.json across restarts.
    if (!quiet && this.memory.quietNotifications.length) {
      for (const notice of this.memory.quietNotifications) {
        run('herdr', ['notification', 'show', `Herdr Boss: ${notice.title}`, '--body', notice.text, '--sound', notice.severity === 'critical' ? 'request' : 'none']).catch(() => {});
        this.log('notify', notice.title, { severity: notice.severity });
      }
      this.memory.quietNotifications = [];
    }

    // User notifications: warn and critical, once per alert key.
    for (const a of alerts) {
      if (SEV[a.severity] < 1 || this.memory.notified[a.key]) continue;
      this.memory.notified[a.key] = now;
      if (quiet) {
        this.memory.quietNotifications.push({ key: a.key, title: a.title, text: a.text, severity: a.severity });
        this.log('quiet-hours', 'quiet hours held desktop notification', { key: a.key, title: a.title, alertText: a.text, severity: a.severity });
      } else {
        run('herdr', ['notification', 'show', `Herdr Boss: ${a.title}`, '--body', a.text, '--sound', a.severity === 'critical' ? 'request' : 'none']).catch(() => {});
        this.log('notify', a.title, { severity: a.severity });
      }
    }

    // Prompts to orchestrators, grouped per pane.
    if (this.push) {
      const perPane = new Map();
      const broadcast = broadcastTargets(orchs, herdr?.panes);
      for (const a of alerts) {
        if (a.prompt === false || a.scope === 'user') continue;
        // A skipped broadcast stays unsent, so it reaches the orchestrator when its workers become active.
        let targets = a.scope === 'all' ? broadcast : orchs.filter((o) => o.workspace === a.scope);
        // A kit notice goes to every project orchestrator, also one without active workers.
        if (isKitAlert(a)) targets = kitNoticeTargets(orchs);
        if (a.key.startsWith('machine:disk:')) {
          const projectOrch = targets.find((o) => o.label === 'orch');
          targets = projectOrch ? [projectOrch] : targets.filter((o) => o.label !== 'boss').slice(0, 1);
        }
        for (const o of targets) {
          const rec = this.memory.pushes[`${a.key}@${o.id}`];
          const due = alertPromptDue(a, rec, now, cooldown);
          if (!due) continue;
          if (!perPane.has(o.id)) perPane.set(o.id, { o, list: [] });
          perPane.get(o.id).list.push(a);
        }
      }
      this.memory.infoPrompts ||= {};
      for (const { o, list: due } of perPane.values()) {
        // A notice that cannot go out now stays unsent, so it is due again at the next tick.
        if (!orchestratorCanReceiveNotice(o, due)) continue;
        const settled = o.status === 'idle' || o.status === 'done';
        const urgent = due.filter((a) => SEV[a.severity] >= SEV.warn && (settled || skipsIdleGate(a)));
        const infoAllowed = settled && now - (this.memory.infoPrompts[o.id] || 0) >= INFO_PROMPT_INTERVAL_MS;
        const info = infoAllowed ? due.filter((a) => SEV[a.severity] < SEV.warn) : [];
        if (!urgent.length && !info.length) continue;
        urgent.sort((x, y) => SEV[y.severity] - SEV[x.severity]);
        const list = [...urgent, ...info];
        const text = [
          '[herdr-boss] Resource notice. Act on it if it concerns your work. You do not need to reply to me.',
          ...urgent.map((a) => `- ${a.text}`),
          ...info.slice(0, INFO_PROMPT_LINES).map((a) => `- ${a.text}`),
          ...(info.length > INFO_PROMPT_LINES ? [`- and ${info.length - INFO_PROMPT_LINES} more`] : []),
          `Current rules: ${path.join(DATA_DIR, 'bulletin.md')}. Dashboard: ${dashboardUrl(this.cfg)}`,
        ].join('\n');
        try {
          await this.herdrRunner('herdr', ['agent', 'prompt', o.id, text]);
          for (const a of list) this.memory.pushes[`${a.key}@${o.id}`] = { at: now, severity: a.severity };
          if (info.length) this.memory.infoPrompts[o.id] = now;
          this.log('push', `Sent ${list.length} notice(s) to ${o.id} (${o.workspace})`, { pane: o.id, titles: list.map((a) => a.title) });
        } catch (e) {
          this.log('error', `Prompt to ${o.id} failed: ${(e.stderr || e.message).slice(0, 200)}`);
        }
      }
    }

    // Forget alerts that cleared more than a week ago.
    const week = 7 * 86400 * 1000;
    this.memory.pushes = pruneInactiveDiskPromptRecords(this.memory.pushes, active);
    for (const [k, v] of Object.entries(this.memory.pushes)) if (!active.has(k.split('@')[0]) && now - v.at > week) delete this.memory.pushes[k];
    for (const [k, at] of Object.entries(this.memory.notified)) if (!active.has(k) && now - at > week) delete this.memory.notified[k];
    for (const [pane, at] of Object.entries(this.memory.infoPrompts || {})) if (now - at > INFO_PROMPT_INTERVAL_MS) delete this.memory.infoPrompts[pane];
    // Allow a cleared machine alert to notify again when it returns.
    for (const k of Object.keys(this.memory.notified)) if (k.startsWith('machine:') && !active.has(k)) delete this.memory.notified[k];
  }
}
