import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DATA_DIR } from './config.js';
import { collectHerdr, collectQuotas, collectMachine, collectProcesses, findBrowsers, run } from './collect.js';
import { evaluate, renderBulletin, fmtDuration } from './rules.js';
import { listProjects } from './projects.js';
import { loadModels } from './kit/config.js';
import { loadPolicy, deriveControl } from './control.js';
import { recordQuotaSnapshot } from './usage.js';
import { listBrowserSessions } from './browser-pool.js';

const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const BULLETIN_FILE = path.join(DATA_DIR, 'bulletin.md');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
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
      snap.policy = policy;
      snap.control = control;
      if (this.act) await this.reap(browsers);
      const evaluation = evaluate(snap, this.cfg, this.memory.paneSince, now, policy);
      for (const h of control.handoffs) {
        const p = control.projects[h.project];
        evaluation.alerts.push({
          key: `handoff:${h.workspace}:${h.provider}:${h.window.resetsAt}`,
          severity: h.window.usedPercent >= 98 ? 'critical' : 'warn',
          scope: p.slug === 'herdrboss' ? 'user' : h.workspace,
          suppressPrompt: h.window.usedPercent >= 98,
          title: `Prepare ${h.project} orchestrator handover`,
          text: `${h.provider} is at ${h.window.usedPercent}% in its ${h.window.label} window. Prepare a ${h.target ? `${h.target.kind} (${h.target.model})` : 'different-provider'} successor before the orchestrator runs out. Use herdr-boss handoff plan ${h.pane} --to ${h.target?.kind || 'codex'}, then handoff prepare after review. Keep the current orchestrator until the successor is ready.`,
        });
      }
      for (const p of Object.values(control.projects)) if (p.running > p.slots && !p.idle) evaluation.alerts.push({
        key: `allocation:${p.workspace}:${p.slots}`, severity: 'info', scope: p.workspace,
        title: `${p.label} uses ${p.running}/${p.slots} worker slots`,
        text: `${p.label} has ${p.running} working agents; its current allocation is ${p.slots}. Let current work finish, then delay new workers until within allocation.`,
      });
      for (const b of managedBrowsers) {
        if (!b.launchedAt || now - Date.parse(b.launchedAt) < 120000) continue;
        if (browsers.some((x) => x.kind === 'automation-chrome' && x.port === String(b.port) && x.profile === b.profile)) continue;
        const p = control.projects[b.project];
        evaluation.alerts.push({
          key: `browser:managed-down:${b.project}:${b.port}`, severity: 'warn', scope: p?.workspace || 'user',
          title: `${b.project} browser is offline`,
          text: `The recorded browser for ${b.project} on port ${b.port} is offline. Request it again with herdr-boss browser request ${b.project} before browser work.`,
        });
      }
      snap.alerts = evaluation.alerts;
      snap.advice = evaluation.advice;
      const quotaAlerts = evaluation.alerts.filter((alert) => alert.key.startsWith('quota:'));
      const criticalProviders = new Set(quotaAlerts.filter((alert) => alert.severity === 'critical').map((alert) => alert.key.split(':')[1]));
      const limitedProviders = new Set(quotaAlerts.map((alert) => alert.key.split(':')[1]));
      const avoidKinds = [...new Set([...criticalProviders].filter((provider) => provider === 'codex' || provider === 'claude'))];
      const preferredKinds = Object.keys(control.globalAllowed).filter((kind) => control.globalAllowed[kind].some((model) => {
        const provider = kind === 'codex' || kind === 'claude' ? kind : model.startsWith('opencode-go/') ? 'opencodego' : null;
        return !provider || !limitedProviders.has(provider);
      }));
      writeJson(path.join(DATA_DIR, 'rules.json'), {
        updatedAt: snap.updatedAt,
        avoidKinds,
        avoidProviders: Object.keys(control.pressures).filter((provider) => control.pressures[provider] || control.risks[provider]),
        preferredKinds,
        memFreePercent: machine?.memFreePercent ?? null,
        notes: evaluation.advice,
        policy,
        control: { runningWorkers: control.runningWorkers, maxWorkers: control.maxWorkers, projects: control.projects },
      });
      snap.paneSince = this.memory.paneSince;
      snap.history = this.memory.history || [];
      snap.push = this.push;
      if (this.act) await this.deliver(evaluation.alerts, herdr, now);
      snap.events = this.events.slice(-60);

      this.state = snap;
      writeJson(STATE_FILE, snap);
      fs.writeFileSync(BULLETIN_FILE, renderBulletin(snap, evaluation, this.cfg));
      writeJson(MEMORY_FILE, this.memory);
      this.emit('state', snap);
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

  async deliver(alerts, herdr, now) {
    const cooldown = this.cfg.alertCooldownSeconds * 1000;
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
      for (const a of alerts) {
        if (a.suppressPrompt || a.scope === 'user') continue;
        const targets = a.scope === 'all' ? orchs : orchs.filter((o) => o.workspace === a.scope);
        for (const o of targets) {
          const rec = this.memory.pushes[`${a.key}@${o.id}`];
          const due = !rec || now - rec.at > cooldown || SEV[a.severity] > SEV[rec.severity];
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
          `Current rules: ${path.join(DATA_DIR, 'bulletin.md')}. Dashboard: http://${this.cfg.host}:${this.cfg.port}`,
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
