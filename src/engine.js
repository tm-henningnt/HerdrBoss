import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DATA_DIR } from './config.js';
import { collectHerdr, collectQuotas, collectMachine, collectProcesses, findBrowsers, run } from './collect.js';
import { evaluate, renderBulletin, fmtDuration } from './rules.js';
import { listProjects } from './projects.js';

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
      if (quotas) { this.quotas = quotas; this.quotasAt = now; }
      const browsers = findBrowsers(procs, herdr?.panes || [], this.cfg.sharedBrowsers);

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
        errors,
      };
      if (this.act) await this.reap(browsers);
      const evaluation = evaluate(snap, this.cfg, this.memory.paneSince, now);
      snap.alerts = evaluation.alerts;
      snap.advice = evaluation.advice;
      const quotaAlerts = evaluation.alerts.filter((alert) => alert.key.startsWith('quota:'));
      const criticalProviders = new Set(quotaAlerts.filter((alert) => alert.severity === 'critical').map((alert) => alert.key.split(':')[1]));
      const limitedProviders = new Set(quotaAlerts.map((alert) => alert.key.split(':')[1]));
      const avoidKinds = [...new Set([...criticalProviders].flatMap((provider) => this.cfg.providerKinds[provider] || []))];
      const preferredKinds = [...new Set(Object.entries(this.cfg.providerKinds)
        .filter(([provider]) => !limitedProviders.has(provider))
        .flatMap(([, kinds]) => kinds))];
      writeJson(path.join(DATA_DIR, 'rules.json'), {
        updatedAt: snap.updatedAt,
        avoidKinds,
        preferredKinds,
        memFreePercent: machine?.memFreePercent ?? null,
        notes: evaluation.advice,
      });
      snap.paneSince = this.memory.paneSince;
      snap.history = this.memory.history || [];
      snap.push = this.push;
      if (this.act) await this.deliver(evaluation.alerts, herdr, now);
      snap.projects = listProjects();
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
