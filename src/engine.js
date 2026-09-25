import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { DATA_DIR, dashboardUrl } from './config.js';
import { collectHerdr, collectQuotas, collectMachine, collectProcesses, findBrowsers, cpuUse, run } from './collect.js';
import { evaluate, renderBulletin, fmtDuration, providerName, broadcastTargets } from './rules.js';
import { listProjects } from './projects.js';
import { loadModels } from './kit/config.js';
import { loadPolicy, deriveControl, providerFor, pickSuccessor, laneStatus, leastOverProvider, machineLimits } from './control.js';
import { recordQuotaSnapshot } from './usage.js';
import { listBrowserSessions } from './browser-pool.js';
import { listHandoffs, expireHandoff } from './handoff.js';

const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const BULLETIN_FILE = path.join(DATA_DIR, 'bulletin.md');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const CLI_FILE = fileURLToPath(new URL('./cli.js', import.meta.url));
const SEV = { info: 0, warn: 1, critical: 2 };

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export class Engine extends EventEmitter {
  constructor(cfg, { push = cfg.push, act = true } = {}) {
    super();
    this.cfg = cfg;
    this.push = push;
    this.act = act; // false: collect and evaluate only (no reaping, notifications or prompts)
    this.memory = readJson(MEMORY_FILE, { paneSince: {}, pushes: {}, notified: {} });
    this.quotas = null;
    this.quotasAt = 0;
    this.state = readJson(STATE_FILE, null);
    this.events = [];
    try {
      this.events = fs.readFileSync(EVENTS_FILE, 'utf8').trim().split('\n').slice(-200).map((l) => JSON.parse(l));
    } catch {}
    this.running = false;
    this.models = loadModels();
  }

  log(type, text, extra = {}) {
    const e = { at: new Date().toISOString(), type, text, ...extra };
    this.events.push(e);
    if (this.events.length > 200) this.events.shift();
    try { fs.appendFileSync(EVENTS_FILE, JSON.stringify(e) + '\n'); } catch {}
    this.emit('event', e);
  }

  async tick() {
    if (this.running) return this.state;
    this.running = true;
    const errors = [];
    const now = Date.now();
    try {
      const refreshQuotas = !this.quotas || now - this.quotasAt > this.cfg.quotaSeconds * 1000;
      const [herdr, machine, procs, quotas] = await Promise.all([
        collectHerdr(this.cfg.orchestratorLabel).catch((e) => { errors.push(`herdr: ${e.message}`); return this.state?.herdr || null; }),
        collectMachine().catch((e) => { errors.push(`machine: ${e.message}`); return null; }),
        collectProcesses().catch((e) => { errors.push(`ps: ${e.message}`); return new Map(); }),
        refreshQuotas ? collectQuotas().catch((e) => { errors.push(`codexbar: ${e.message}`); return null; }) : null,
      ]);
      if (quotas) { this.quotas = quotas; this.quotasAt = now; recordQuotaSnapshot(quotas, new Date(now).toISOString()); }
      const managedBrowsers = Object.values(listBrowserSessions());
      const browsers = findBrowsers(procs, herdr?.panes || [], [
        { port: 9222, label: 'Protected legacy browser' },
        ...this.cfg.sharedBrowsers,
        ...managedBrowsers.map((b) => ({ port: b.port, profile: b.profile, label: `Managed browser: ${b.project}` })),
      ]);

      this.trackPaneStatus(herdr, now);
      if (machine) {
        const h = (this.memory.history ||= []);
        h.push({ t: now, load: machine.load[0], mem: machine.memFreePercent });
        while (h.length > 240) h.shift();
      }
      const snap = {
        updatedAt: new Date(now).toISOString(),
        quotasAt: this.quotasAt ? new Date(this.quotasAt).toISOString() : null,
        quotas: this.quotas || [],
        machine,
        herdr,
        browsers,
        managedBrowsers,
        errors,
      };
      snap.projects = listProjects();
      const policy = loadPolicy();
      const control = deriveControl(snap, policy, this.models, this.memory.paneSince, now);
      const profileWorkspaces = Object.fromEntries(managedBrowsers.map((b) => [b.profile, control.projects[b.project]?.workspace]).filter(([, ws]) => ws));
      snap.cpuUse = cpuUse(procs, herdr?.panes || [], profileWorkspaces);
      if (machine) {
        snap.machine.cpuUse = snap.cpuUse;
        snap.machine.cpuTotalSample = [...procs.values()].reduce((sum, proc) => sum + Math.max(0, proc.cpu), 0);
        snap.machine.limits = machineLimits(snap.machine, policy);
      }
      snap.lanes = laneStatus(snap.quotas, policy, now);
      snap.leastOverProvider = leastOverProvider(snap.lanes);
      snap.policy = policy;
      snap.control = control;
      this.memory.lastOrchestrators ||= {};
      for (const p of Object.values(control.projects)) if (p.orch?.kind) this.memory.lastOrchestrators[p.workspace] = { pane: p.orch.pane, kind: p.orch.kind, project: p.slug };
      if (this.act) await this.reap(browsers);
      // A prepared successor waits idle by design, so the idle-worker rule skips it.
      try { snap.standbyPanes = listHandoffs().filter((h) => ['preparing', 'prepared', 'needs-inspection'].includes(h.status)).map((h) => h.newPane); }
      catch { snap.standbyPanes = []; }
      const evaluation = evaluate(snap, this.cfg, this.memory.paneSince, now, policy);
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
        evaluation.alerts.push({ key: `quota:recovered:${id}:${recovery.resetsAt}`, severity: 'info', scope: 'all',
          title: 'Quota restriction cleared', text: recovery.text });
      }
      for (const h of control.handoffs) {
        const p = control.projects[h.project];
        evaluation.alerts.push({
          key: `handoff:${h.workspace}:${h.provider}:${h.window.resetsAt}`,
          severity: h.window.usedPercent >= 98 ? 'critical' : 'warn',
          // The Boss's own handover goes to the Owner, not to the Boss pane itself.
          scope: (herdr?.panes || []).some((x) => x.id === h.pane && x.label === 'boss') ? 'user' : h.workspace,
          suppressPrompt: h.window.usedPercent >= 98,
          title: `Prepare ${h.project} orchestrator handover`,
          text: h.target
            ? `${h.provider} is at ${h.window.usedPercent}% in its ${h.window.label} window. Prepare a ${h.target.kind} (${h.target.model}${h.target.effort ? `, ${h.target.effort}` : ''}) successor before the orchestrator runs out. Use herdr-boss handoff plan ${h.pane} --to ${h.target.kind} --model ${h.target.model}${h.target.effort ? ` --effort ${h.target.effort}` : ''}, then handoff prepare after review. Keep the current orchestrator until the successor is ready.`
            : `${h.provider} is at ${h.window.usedPercent}% in its ${h.window.label} window, but no eligible choice remains in the orchestrator succession ladder. Review Allocation and prepare a successor manually before this quota runs out.`,
        });
      }
      let handoffRecords = [];
      try { handoffRecords = listHandoffs(); } catch {}
      for (const h of handoffRecords) {
        if (['prepared', 'needs-inspection'].includes(h.status) && h.promptError) evaluation.alerts.push({
          key: `successor:prompt:${h.id}`, severity: 'warn', once: true, scope: h.workspace || 'user',
          title: `${h.project} successor did not get its prompt`,
          text: `The bootstrap prompt did not reach the proposed successor ${h.id} in pane ${h.newPane}. It cannot report ready, so automatic activation cannot happen. Read the pane with herdr agent read ${h.newPane}, then send the prompt again or close the pane and prepare a new successor.`,
        });
        // Expire an automatic successor two hours after preparation when its source provider is no longer at risk.
        const sourceProvider = providerFor(h.fromKind, policy.preferredModels?.[h.fromKind] ?? this.models.kinds[h.fromKind]?.defaultModel, policy);
        if (h.status === 'prepared' && h.automatic && now - Date.parse(h.preparedAt) > 2 * 3600000 && !control.risks[sourceProvider]) {
          const expired = this.act ? expireHandoff(h.id, `${sourceProvider || 'the source provider'} is no longer near its limit`) : null;
          if (expired) {
            this.log('handoff', `Expired unused successor ${h.id} in pane ${h.newPane}`, { project: h.project, pane: h.newPane });
            evaluation.alerts.push({
              key: `successor:expired:${h.id}`, severity: 'info', once: true, scope: h.workspace || 'user',
              title: `${h.project} successor expired`,
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
        if (running && b.launchedAt && now - Date.parse(b.launchedAt) < 86400000) {
          const p = control.projects[b.project];
          if (p?.workspace) evaluation.alerts.push({
            // One notice per port and mode, so a restart in the same mode does not repeat it.
            key: `browser:managed-ready:${b.project}:${b.port}:${b.headless ? 'headless' : 'visible'}`, severity: 'info', once: true, scope: p.workspace,
            title: `${b.project} browser is ready`,
            text: `Browser for ${b.project} is ready (${b.headless ? 'headless' : 'visible'}) on port ${b.port}. Use herdr-boss browser tabs ${b.project} to find a page, then herdr-boss browser screenshot ${b.project} --tab <id> for a private JPEG. Browser service commands are in the Herdr Boss kit.`,
          });
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
        avoidProviders: Object.keys(control.pressures).filter((provider) => control.pressures[provider] || control.risks[provider]),
        lanes: snap.lanes,
        leastOverProvider: snap.leastOverProvider,
        preferredKinds,
        memFreePercent: machine?.memFreePercent ?? null,
        load: machine ? { oneMinute: machine.load[0], fiveMinute: machine.load[1], cpus: machine.cpus, limit: machineLimits(snap.machine, policy).loadLimit } : null,
        machine: snap.machine?.limits || null,
        notes: evaluation.advice,
        browsers: managedBrowsers.map((b) => ({ project: b.project, port: b.port, profile: b.profile, headless: !!b.headless, windowSize: b.windowSize || { width: 1280, height: 800 }, ready: browsers.some((x) => x.kind === 'automation-chrome' && x.port === String(b.port) && x.profile === b.profile) })),
        policy,
        control: { runningWorkers: control.runningWorkers, maxWorkers: control.maxWorkers, projects: control.projects },
      });
      snap.paneSince = this.memory.paneSince;
      snap.history = this.memory.history || [];
      snap.push = this.push;
      fs.writeFileSync(BULLETIN_FILE, renderBulletin(snap, evaluation, this.cfg));
      if (this.act) await this.deliver(evaluation.alerts, herdr, now);
      snap.events = this.events.slice(-60);

      this.state = snap;
      writeJson(STATE_FILE, snap);
      writeJson(MEMORY_FILE, this.memory);
      this.emit('state', snap);
      if (this.act && this.push) {
        try { await this.notifyHandoffPeers(herdr, now); }
        catch (e) { this.log('error', `Handover peer notice check failed: ${e.message}`); }
      }
      if (this.act && policy.autoHandover) {
        try { await this.autoHandover(control, herdr, policy, now); }
        catch (e) { this.log('error', `Automatic handover check failed: ${e.message}`); }
      }
      writeJson(MEMORY_FILE, this.memory);
      return snap;
    } finally {
      this.running = false;
    }
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

  async autoHandover(control, herdr, policy, now) {
    // Never switch labels using stale quota data or a guessed successor state.
    if (!this.quotasAt || now - this.quotasAt > (this.cfg.quotaSeconds + this.cfg.tickSeconds) * 1000) return;
    this.memory.autoHandoverAttempts ||= {};
    for (const [key, at] of Object.entries(this.memory.autoHandoverAttempts)) if (now - at > 7 * 86400 * 1000) delete this.memory.autoHandoverAttempts[key];
    const records = listHandoffs();
    for (const item of records.filter((x) => x.status === 'prepared' && x.automatic && x.readyAt && !x.promptError)) {
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
        await run(process.execPath, [CLI_FILE, 'handoff', 'activate', item.id, '--confirmed'], { timeout: 180000 });
        this.log('handoff', `Automatically activated ${item.toKind} successor for ${item.project}`, { project: item.project, pane: item.newPane });
      } catch (e) { this.log('error', `Automatic activation for ${item.project} failed: ${String(e.stderr || e.message).slice(0, 300)}`); }
    }
    const stopped = Object.values(control.projects).flatMap((p) => {
      const last = this.memory.lastOrchestrators[p.workspace];
      if (!p.orch || p.orch.kind || last?.pane !== p.orch.pane) return [];
      const provider = providerFor(last.kind, policy.preferredModels?.[last.kind] ?? this.models.kinds[last.kind]?.defaultModel, policy);
      const window = this.quotas.find((q) => q.provider === provider && !q.error)?.windows?.find((w) => !w.extra && w.usedPercent >= policy.autoHandoverPercent);
      if (!window || policy.providerModes[provider] === 'ignore') return [];
      return [{ project: p.slug, pane: p.orch.pane, fromKind: last.kind, sessionId: null, window, target: pickSuccessor(p, last.kind, provider, policy, control) }];
    });
    for (const h of [...control.handoffs, ...stopped]) {
      if (records.some((x) => x.sourcePane === h.pane && ['prepared', 'preparing', 'needs-inspection'].includes(x.status))) continue;
      if (!h.target) {
        const key = `no-target:${h.pane}:${h.window.resetsAt}`;
        if (!this.memory.autoHandoverAttempts[key]) {
          this.memory.autoHandoverAttempts[key] = now;
          this.log('error', `Automatic handover for ${h.project} has no eligible alternative provider`, { project: h.project });
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
        const plan = JSON.parse(await run(process.execPath, args, { timeout: 180000 }));
        const chosen = mode === 'migrate' && !plan.migration?.available ? 'fresh' : mode;
        const prepared = JSON.parse(await run(process.execPath,
          [CLI_FILE, 'handoff', 'prepare', h.pane, '--to', h.target.kind, '--model', h.target.model, '--mode', chosen, ...effort, '--auto'],
          { timeout: 300000 }));
        this.log('handoff', `Automatically prepared ${h.target.kind} successor for ${h.project}; awaiting readiness`, { project: h.project, pane: prepared.newPane });
      } catch (e) {
        const reason = String(e.stderr || e.message).slice(0, 300);
        this.log('error', `Automatic preparation for ${h.project} failed: ${reason}`);
      }
    }
  }

  async notifyHandoffPeers(herdr, now) {
    this.memory.handoffPeerNotices ||= {};
    this.memory.handoffPeerAttempts ||= {};
    const panes = new Map((herdr?.panes || []).map((p) => [p.id, p]));
    for (const item of listHandoffs().filter((x) => x.status === 'active' && now - Date.parse(x.activatedAt) < 7 * 86400 * 1000)) {
      for (const id of item.peerPanes || []) {
        const key = `${item.id}@${id}`;
        if (this.memory.handoffPeerNotices[key] || now - (this.memory.handoffPeerAttempts[key] || 0) < 60000) continue;
        const pane = panes.get(id);
        if (!pane?.agent || !['idle', 'done'].includes(pane.status)) continue;
        this.memory.handoffPeerAttempts[key] = now;
        const text = id === item.sourcePane
          ? `[herdr-boss] Handover complete. You are now standby. Orchestrator pane ${item.newPane} controls ${item.project}; do not dispatch new work. Share any remaining context with the successor.`
          : `[herdr-boss] ${item.project} has a new orchestrator in pane ${item.newPane} (${item.toKind}). Continue your assigned task and report completion and blockers to that pane. The previous orchestrator pane ${item.sourcePane} is standby.`;
        try {
          await run('herdr', ['agent', 'prompt', id, text]);
          this.memory.handoffPeerNotices[key] = now;
          this.log('push', `Notified ${id} of ${item.project} orchestrator handover`, { pane: id, project: item.project });
        } catch (e) { this.log('error', `Handover notice to ${id} failed: ${String(e.stderr || e.message).slice(0, 200)}`); }
      }
    }
    for (const [key, at] of Object.entries(this.memory.handoffPeerNotices)) if (now - at > 8 * 86400 * 1000) delete this.memory.handoffPeerNotices[key];
    for (const [key, at] of Object.entries(this.memory.handoffPeerAttempts)) if (now - at > 8 * 86400 * 1000) delete this.memory.handoffPeerAttempts[key];
  }

  async deliver(alerts, herdr, now) {
    const cooldown = loadPolicy().machine.alertCooldownSeconds * 1000;
    const orchs = (herdr?.panes || []).filter((p) => p.orch && p.agent);
    const active = new Set(alerts.map((a) => a.key));

    // User notifications: warn and critical, once per alert key.
    for (const a of alerts) {
      if (SEV[a.severity] < 1 || this.memory.notified[a.key]) continue;
      this.memory.notified[a.key] = now;
      run('herdr', ['notification', 'show', `Herdr Boss: ${a.title}`, '--body', a.text, '--sound', a.severity === 'critical' ? 'request' : 'none']).catch(() => {});
      this.log('notify', a.title, { severity: a.severity });
    }

    // Prompts to orchestrators, grouped per pane.
    if (this.push) {
      const perPane = new Map();
      const broadcast = broadcastTargets(orchs, herdr?.panes);
      for (const a of alerts) {
        if (a.suppressPrompt || a.scope === 'user') continue;
        // A skipped broadcast stays unsent, so it reaches the orchestrator when its workers become active.
        const targets = a.scope === 'all' ? broadcast : orchs.filter((o) => o.workspace === a.scope);
        for (const o of targets) {
          const rec = this.memory.pushes[`${a.key}@${o.id}`];
          const due = !rec || (!a.once && now - rec.at > cooldown) || SEV[a.severity] > SEV[rec.severity];
          if (!due) continue;
          if (!perPane.has(o.id)) perPane.set(o.id, { o, list: [] });
          perPane.get(o.id).list.push(a);
        }
      }
      for (const { o, list } of perPane.values()) {
        if (o.status !== 'idle' && o.status !== 'done') continue; // retry next tick
        list.sort((x, y) => SEV[y.severity] - SEV[x.severity]);
        const text = [
          '[herdr-boss] Resource notice. Act on it if it concerns your work. You do not need to reply to me.',
          ...list.map((a) => `- ${a.text}`),
          `Current rules: ${path.join(DATA_DIR, 'bulletin.md')}. Dashboard: ${dashboardUrl(this.cfg)}`,
        ].join('\n');
        try {
          await run('herdr', ['agent', 'prompt', o.id, text]);
          for (const a of list) this.memory.pushes[`${a.key}@${o.id}`] = { at: now, severity: a.severity };
          this.log('push', `Sent ${list.length} notice(s) to ${o.id} (${o.workspace})`, { pane: o.id, titles: list.map((a) => a.title) });
        } catch (e) {
          this.log('error', `Prompt to ${o.id} failed: ${(e.stderr || e.message).slice(0, 200)}`);
        }
      }
    }

    // Forget alerts that cleared more than a week ago.
    const week = 7 * 86400 * 1000;
    for (const [k, v] of Object.entries(this.memory.pushes)) if (!active.has(k.split('@')[0]) && now - v.at > week) delete this.memory.pushes[k];
    for (const [k, at] of Object.entries(this.memory.notified)) if (!active.has(k) && now - at > week) delete this.memory.notified[k];
    // Allow a cleared machine alert to notify again when it returns.
    for (const k of Object.keys(this.memory.notified)) if (k.startsWith('machine:') && !active.has(k)) delete this.memory.notified[k];
  }
}
