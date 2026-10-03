// The "Add a host" guide: the saved progress, the checks, and the dashboard routes.
// The state of one guide is host-guide/<label>.json in the Herdr Boss data directory (mode 600). A save with the same content changes no file.
// The checks use the ssh and Docker code of the host tool (factory-host.js, factory-transport.js) and the host registry. They run no shell and print no address,
// no key path, and no context name: the output passes through the mask of the host tool.
// A guide holds values that the user typed. It holds no secret. The format check refuses a value that looks like one.
import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { HOST_TYPES, STEPS } from '../public/host-guide-data.js';
import { HOST_NAME, checkField, fieldsFor, normalizeField } from '../public/host-guide-fields.js';
import { loadRegistry, maskLine, shellQuote, sshArguments } from './factory-host.js';
import { createDockerTransport } from './factory-transport.js';
import { writePrivate } from './factory-store.js';

export const GUIDE_DIR = 'host-guide';
export const BODY_LIMIT = 16 * 1024;
export const TERMINATE_LIMIT_MS = 7 * 60 * 1000;
export const REBOOT_LIMIT_MS = 30 * 60 * 1000;
const OUTPUT_LIMIT = 1000;
const GIB = 1024 ** 3;
const SSH_TIMEOUT_MS = 15000;
const KILL_GRACE_MS = 1000;
const CAPTURE_LIMIT = 64 * 1024;
const ACTIONS = ['terminate-start', 'terminate-reset', 'reboot-start', 'reboot-reset'];
const CHECK_IDS = ['all', 'terminate', 'reboot'];

export class GuideError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const typeIds = HOST_TYPES.map((type) => type.id);
export const stepIds = (type) => (STEPS[type] || []).map((step) => step.id);
const stepName = (type, id) => STEPS[type].find((step) => step.id === id)?.name ?? id;

function assertLabel(label) {
  if (typeof label !== 'string' || !HOST_NAME.test(label) || label === 'local') throw new GuideError(400, 'The machine label must use 1 to 31 lower case letters, digits, or hyphens. The label "local" is reserved.');
}

export function guidePath(dataDir, label) {
  assertLabel(label);
  return path.join(dataDir, GUIDE_DIR, `${label}.json`);
}

export function readGuide(dataDir, label) {
  let raw;
  try { raw = fs.readFileSync(guidePath(dataDir, label), 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try { return JSON.parse(raw); } catch { throw new GuideError(500, 'The saved guide cannot be read.'); }
}

export function progress(state) {
  const ids = stepIds(state.type);
  const done = ids.filter((id) => state.done?.[id]).length;
  return { done, total: ids.length, next: ids.find((id) => !state.done?.[id]) ?? null };
}

export function listGuides(dataDir) {
  let names;
  try { names = fs.readdirSync(path.join(dataDir, GUIDE_DIR)); } catch { return []; }
  const rows = [];
  for (const name of names) {
    const label = name.endsWith('.json') ? name.slice(0, -5) : null;
    if (!label || !HOST_NAME.test(label)) continue;
    let state;
    try { state = readGuide(dataDir, label); } catch { continue; }
    if (!state || !typeIds.includes(state.type)) continue;
    const { done, total } = progress(state);
    rows.push({ label, type: state.type, done, total, updatedAt: state.updatedAt });
  }
  return rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.label.localeCompare(b.label));
}

const save = (dataDir, state) => writePrivate(guidePath(dataDir, state.label), state);
const iso = (now) => new Date(now()).toISOString();
const sameContent = (a, b) => JSON.stringify({ ...a, updatedAt: null }) === JSON.stringify({ ...b, updatedAt: null });

function applyValues(next, values) {
  if (!isObject(values)) throw new GuideError(400, 'The values must be an object.');
  const allowed = new Set(fieldsFor(next.type).map((field) => field.id));
  const out = { ...next.values };
  for (const [id, raw] of Object.entries(values)) {
    if (id === 'label') {
      if (raw !== next.label) throw new GuideError(400, 'The machine label cannot change. Start a new guide for another label.');
      continue;
    }
    if (!allowed.has(id)) throw new GuideError(400, `The field ${id.slice(0, 40)} does not belong to this host type.`);
    if (typeof raw !== 'string' || raw.length > 300) throw new GuideError(400, 'A value must be a text of at most 300 characters.');
    const result = checkField(id, raw);
    if (!result.ok) throw new GuideError(400, result.message);
    const value = normalizeField(id, raw);
    if (value === '') delete out[id]; else out[id] = value;
  }
  next.values = out;
}

function applyDone(next, done) {
  if (!isObject(done)) throw new GuideError(400, 'The done list must be an object.');
  const ids = stepIds(next.type);
  const set = new Set(Object.keys(next.done));
  let marked = false;
  for (const [id, flag] of Object.entries(done)) {
    if (!ids.includes(id)) throw new GuideError(400, 'The step is not known.');
    if (typeof flag !== 'boolean') throw new GuideError(400, 'A step is done or not done.');
    if (flag) { set.add(id); marked = true; } else set.delete(id);
  }
  const first = ids.findIndex((id) => !set.has(id));
  const last = ids.findLastIndex((id) => set.has(id));
  if (first !== -1 && last > first) {
    if (marked) throw new GuideError(409, `Finish the step "${stepName(next.type, ids[first])}" first.`);
    throw new GuideError(409, `Undo the step "${stepName(next.type, ids[last])}" first.`);
  }
  next.done = Object.fromEntries(ids.filter((id) => set.has(id)).map((id) => [id, true]));
}

// Change a guide. The first save needs the host type. The same patch twice gives the same state and writes nothing.
export function updateGuide(dataDir, label, patch, { now = Date.now } = {}) {
  assertLabel(label);
  if (!isObject(patch)) throw new GuideError(400, 'The body must be a JSON object.');
  const unknown = Object.keys(patch).find((key) => !['type', 'values', 'done'].includes(key));
  if (unknown !== undefined) throw new GuideError(400, `Unknown field: ${unknown.slice(0, 40)}.`);
  const existing = readGuide(dataDir, label);
  const next = existing ? structuredClone(existing) : { schema: 1, label, type: null, createdAt: iso(now), updatedAt: iso(now), values: { label }, done: {}, checks: {}, terminate: null, reboot: null };
  if (patch.type !== undefined) {
    if (!typeIds.includes(patch.type)) throw new GuideError(400, `Choose a host type: ${typeIds.join(', ')}.`);
    if (next.type && patch.type !== next.type) {
      if (Object.keys(next.done).length) throw new GuideError(409, 'The host type cannot change after a step is done. Start a new guide.');
      const allowed = new Set(fieldsFor(patch.type).map((field) => field.id));
      next.values = Object.fromEntries(Object.entries(next.values).filter(([id]) => id === 'label' || allowed.has(id)));
      next.checks = {};
      next.terminate = null;
      next.reboot = null;
    }
    next.type = patch.type;
  }
  if (!next.type) throw new GuideError(400, `Choose a host type first: ${typeIds.join(', ')}.`);
  if (patch.values !== undefined) applyValues(next, patch.values);
  if (patch.done !== undefined) applyDone(next, patch.done);
  if (existing && sameContent(existing, next)) return existing;
  next.updatedAt = iso(now);
  save(dataDir, next);
  return next;
}

export function deleteGuide(dataDir, label) {
  const file = guidePath(dataDir, label);
  if (!fs.existsSync(file)) throw new GuideError(404, 'No guide has this label.');
  fs.rmSync(file);
}

function requireGuide(dataDir, label) {
  const state = readGuide(dataDir, label);
  if (!state) throw new GuideError(404, 'No guide has this label.');
  return state;
}

// The two tests that the user starts by hand: stop WSL on purpose, and restart the host.
export function guideAction(dataDir, label, action, { now = Date.now } = {}) {
  const state = requireGuide(dataDir, label);
  if (!ACTIONS.includes(action)) throw new GuideError(400, `Unknown action. Use ${ACTIONS.join(', ')}.`);
  const kind = action.startsWith('terminate') ? 'terminate' : 'reboot';
  if (kind === 'terminate' && state.type !== 'windows-wsl2') throw new GuideError(409, 'The terminate test is for a Windows host with WSL2.');
  const next = structuredClone(state);
  if (action.endsWith('-reset')) next[kind] = null;
  else if (next[kind]?.status !== 'waiting') next[kind] = { status: 'waiting', startedAt: iso(now) };
  if (sameContent(state, next)) return state;
  if (action.endsWith('-reset')) delete next.checks[kind];
  next.updatedAt = iso(now);
  save(dataDir, next);
  return next;
}

// systemd is fine when it runs, or when only systemd-binfmt.service failed. Docker, SSH, and Tailscale have their own checks.
export function evaluateSystemd(running, failed) {
  const state = String(running ?? '').trim().split('\n')[0].trim();
  const units = String(failed ?? '').split('\n').map((line) => line.replace(/^[\s●*×]+/, '').trim().split(/\s+/)[0]).filter(Boolean);
  if (state === 'running') return { ok: true, detail: 'systemd runs.' };
  if (state === 'degraded') {
    if (units.length && units.every((unit) => unit === 'systemd-binfmt.service')) return { ok: true, detail: 'systemd is degraded. Only systemd-binfmt.service failed. This is accepted.' };
    return { ok: false, detail: units.length ? `systemd is degraded. Failed units: ${units.join(', ').slice(0, 300)}.` : 'systemd is degraded, and no failed unit is listed.' };
  }
  return { ok: false, detail: `systemd state: ${state.slice(0, 40) || 'unknown'}.` };
}

// The memory that Docker sees is a little less than the limit of the runtime.
export function memoryMatches(bytes, limitGb) {
  const ratio = Number(bytes) / (limitGb * GIB);
  return Number.isFinite(ratio) && ratio >= 0.8 && ratio <= 1.02;
}

const minutes = (seconds) => {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m} minutes${s ? ` and ${s} seconds` : ''}`;
};

// The terminate test. The host must go down and come back within 7 minutes: the repeating trigger runs every 5 minutes.
export function advanceTerminate(record, { answered, now }) {
  if (record?.status !== 'waiting') return record;
  const started = Date.parse(record.startedAt);
  const next = { ...record };
  if (!next.downAt) {
    if (!answered) next.downAt = new Date(now).toISOString();
  } else if (answered) {
    next.status = 'passed';
    next.upAt = new Date(now).toISOString();
    next.seconds = Math.round((now - started) / 1000);
    return next;
  }
  if (now - started > TERMINATE_LIMIT_MS) { next.status = 'failed'; next.reason = next.downAt ? 'not-back' : 'never-down'; }
  return next;
}

// The reboot test. The host passes when it started after the click and Docker answers.
export function advanceReboot(record, { answered, dockerOk, uptimeSeconds, now }) {
  if (record?.status !== 'waiting') return record;
  const elapsed = now - Date.parse(record.startedAt);
  if (answered && dockerOk && Number.isFinite(uptimeSeconds) && uptimeSeconds * 1000 < elapsed) {
    return { ...record, status: 'passed', recoverySeconds: Math.round(elapsed / 1000), uptimeSeconds: Math.round(uptimeSeconds) };
  }
  return elapsed > REBOOT_LIMIT_MS ? { ...record, status: 'failed' } : record;
}

function clip(text) {
  const value = String(text ?? '').replace(/\r/g, '').trim();
  return value.length > OUTPUT_LIMIT ? `${value.slice(0, OUTPUT_LIMIT)}…` : value;
}

// One ssh call with the arguments of the host tool. The result is captured, not printed.
// One ssh call with the arguments of the host tool. The result is captured, not printed.
// ssh runs in its own process group. A hung call gets SIGTERM, then SIGKILL after a grace time. Each stream is capped.
function runSsh(host, command, spawn, { timeout = SSH_TIMEOUT_MS, grace = KILL_GRACE_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn('ssh', sshArguments(host, [command]), { stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: true }); } catch { resolve({ code: 255, stdout: '', stderr: 'ssh could not start.' }); return; }
    let stdout = '';
    let stderr = '';
    let finished = false;
    let killTimer;
    const signal = (name) => {
      try { if (child.pid) process.kill(-child.pid, name); else child.kill(name); } catch { try { child.kill(name); } catch { /* The process is gone. */ } }
    };
    const stop = () => { signal('SIGTERM'); killTimer ||= setTimeout(() => signal('SIGKILL'), grace); };
    const done = (result) => { if (!finished) { finished = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { stop(); done({ code: 255, stdout, stderr: `${stderr}\nConnection timed out.` }); }, timeout);
    const take = (kind, chunk) => {
      if (kind === 'out') { if (stdout.length < CAPTURE_LIMIT) stdout += chunk; } else if (stderr.length < CAPTURE_LIMIT) stderr += chunk;
      if (stdout.length >= CAPTURE_LIMIT || stderr.length >= CAPTURE_LIMIT) stop();
    };
    child.stdout?.on('data', (chunk) => take('out', chunk));
    child.stderr?.on('data', (chunk) => take('err', chunk));
    child.once('error', () => { clearTimeout(killTimer); done({ code: 255, stdout, stderr: 'ssh could not start.' }); });
    child.once('close', (code) => { clearTimeout(killTimer); done({ code: code ?? 255, stdout, stderr }); });
  });
}

async function runDocker(host, args, spawn, env) {
  try { return await createDockerTransport(host, { spawn, env }).run(args, { timeout: SSH_TIMEOUT_MS }); } catch (error) {
    return { code: 255, stdout: '', stderr: error?.message || 'Docker could not start.', unreachable: true };
  }
}

const DENIED = /Permission denied|Too many authentication failures|no mutual signature|Host key verification failed|REMOTE HOST IDENTIFICATION/i;

// The checks. Each check is a row: { id, status, at, command, output, next }. status is pass, fail, skipped, or pending.
export const CHECKS = [
  { id: 'registered', title: 'Host in the registry' }, { id: 'answers', title: 'Host answers on the tailnet name' }, { id: 'key-login', title: 'Key login works' },
  { id: 'architecture', title: 'Architecture is x86_64', types: ['windows-wsl2'] }, { id: 'docker', title: 'Docker answers over the context' }, { id: 'systemd', title: 'systemd state' },
  { id: 'docker-memory', title: 'Docker memory limit' }, { id: 'sshd-password', title: 'SSH password login is off' }, { id: 'terminate', title: 'Terminate and wait', types: ['windows-wsl2'] }, { id: 'reboot', title: 'Reboot test' },
];

const running = new Set();

export async function runGuideChecks(dataDir, label, { env = process.env, spawn = nodeSpawn, now = Date.now, ids = ['all'], sshTimeout = SSH_TIMEOUT_MS, killGrace = KILL_GRACE_MS } = {}) {
  const state = requireGuide(dataDir, label);
  const mode = ids[0] ?? 'all';
  if (!CHECK_IDS.includes(mode)) throw new GuideError(400, `Unknown check. Use ${CHECK_IDS.join(', ')}.`);
  if (mode !== 'all' && !state[mode]) throw new GuideError(409, `Start the ${mode} test first.`);
  if (running.has(label)) throw new GuideError(409, 'A check of this host is already running.');
  running.add(label);
  try {
    const next = structuredClone(state);
    const at = iso(now);
    const results = {};
    const put = (id, status, extra = {}) => { results[id] = { id, status, at, command: extra.command ?? '', output: clip(extra.output), next: extra.next ?? '' }; return results[id]; };
    const type = state.type;
    const windows = type === 'windows-wsl2';
    // The copied command is one quoted argument, so the Mac shell does not expand a glob or split at a semicolon.
    const ssh = (command) => `herdr-boss factory ssh ${label} -- ${shellQuote(command)}`;
    const runRemote = (target, command) => runSsh(target, command, spawn, { timeout: sshTimeout, grace: killGrace });
    const skipFrom = (ids2, why) => { for (const id of ids2) if (!results[id]) put(id, 'skipped', { output: why }); };
    const order = CHECKS.filter((check) => !check.types || check.types.includes(type)).map((check) => check.id);
    // The timed tests have a row only after the user starts them.
    const skippable = order.filter((id) => !['terminate', 'reboot'].includes(id));
    let registry = null;
    try { registry = loadRegistry(env).hosts[label] ?? null; } catch { registry = null; }
    const host = registry?.address && registry?.user && registry?.keyFile ? { name: label, ...registry } : null;
    if (!host) {
      put('registered', 'fail', { command: `herdr-boss factory host list`, output: 'The registry has no SSH record for this label.', next: `Run \`herdr-boss factory host add ${label} --from-file -\`. Type the fields address, user, and keyFile as JSON on the private input. End with Ctrl+D.` });
      if (mode === 'all') skipFrom(skippable, 'Register the host first.');
      for (const kind of ['terminate', 'reboot']) {
        if (next[kind] && (mode === 'all' || mode === kind) && (kind === 'reboot' || windows)) put(kind, 'skipped', { output: 'The host is not registered.', next: 'Register the host first.' });
      }
    } else {
      put('registered', 'pass', { command: 'herdr-boss factory host list', output: 'The registry has this host.' });
      const mask = (text, docker = false) => clip(maskLine(String(text ?? ''), host, docker));
      const probe = await runRemote(host, 'uname -m');
      const denied = probe.code === 255 && DENIED.test(probe.stderr);
      const keyOk = probe.code !== 255;
      const answered = keyOk || denied;
      const identity = ssh('uname -m');
      if (mode === 'all') {
        put('answers', answered ? 'pass' : 'fail', answered ? { command: identity, output: 'The host answered on port 22.' } : { command: identity, output: mask(probe.stderr || probe.stdout), next: 'Check that Tailscale runs on the Mac and on the host. Check the access policy for port 22. On a Windows host, check that the boot task started WSL.' });
        if (!answered) skipFrom(skippable, 'The host does not answer.');
        else {
          put('key-login', keyOk ? 'pass' : 'fail', keyOk ? { command: identity, output: 'Key login works.' } : { command: identity, output: mask(probe.stderr), next: 'Check the key file path in the registry, the public key in authorized_keys of the factory user, and the ssh config entry. Never type a password.' });
          if (!keyOk) skipFrom(skippable, 'Key login does not work.');
        }
      }
      if (mode === 'all' && answered && keyOk) {
        if (windows) {
          const arch = probe.stdout.trim();
          put('architecture', arch === 'x86_64' ? 'pass' : 'fail', { command: identity, output: mask(arch), next: arch === 'x86_64' ? '' : 'The runbook needs a host with x86_64. Use a host with that architecture.' });
        }
        // Docker over the context.
        let dockerOk = false;
        if (!host.dockerContext) {
          put('docker', 'fail', { command: `herdr-boss factory docker ${label} -- ps`, output: 'The registry has no Docker context for this host.', next: `Run \`herdr-boss factory host add ${label} --docker-context CONTEXT\`. Replace CONTEXT with the name of the context that you made in the step "Tell the Mac which key to use".` });
          skipFrom(['docker-memory'], 'The Docker check needs the Docker context.');
        } else {
          const ps = await runDocker(host, ['ps', '--format', '{{.ID}} {{.Status}}'], spawn, env);
          dockerOk = ps.code === 0;
          put('docker', dockerOk ? 'pass' : 'fail', { command: `herdr-boss factory docker ${label} -- ps --format '{{.ID}} {{.Status}}'`, output: dockerOk ? 'Docker answers over the context.' : mask(ps.stderr || ps.stdout, true), next: dockerOk ? '' : 'Run `docker --context CONTEXT ps` on the Mac. Check that docker runs on the host with `sudo systemctl status docker`.' });
        }
        // systemd.
        if (type === 'mac-orbstack') put('systemd', 'skipped', { output: 'A Mac has no systemd.' });
        else {
          const result = await runRemote(host, 'systemctl is-system-running; systemctl --failed --no-legend');
          const [first, ...rest] = result.stdout.split('\n');
          const verdict = result.code === 255 ? { ok: false, detail: mask(result.stderr) } : evaluateSystemd(first, rest.join('\n'));
          put('systemd', verdict.ok ? 'pass' : 'fail', { command: ssh('systemctl is-system-running; systemctl --failed --no-legend'), output: verdict.detail, next: verdict.ok ? '' : 'Read each failed unit with `systemctl --failed --no-legend`. Fix it. Only systemd-binfmt.service is accepted as failed.' });
        }
        // Docker memory.
        const limit = Number(state.values.memoryGb) || (type === 'mac-orbstack' ? 4 : null);
        if (!host.dockerContext) {
          // The Docker row above says why.
        } else if (!limit) {
          if (windows) put('docker-memory', 'fail', { command: `herdr-boss factory docker ${label} -- info --format '{{.MemTotal}}'`, output: 'No memory limit is typed.', next: 'Type the memory limit in the step "Limit memory and CPU". Then run the test again.' });
          else put('docker-memory', 'skipped', { output: 'No memory limit is typed. Type one to turn this check on.' });
        } else {
          const info = await runDocker(host, ['info', '--format', '{{.MemTotal}}'], spawn, env);
          const bytes = Number(info.stdout.trim());
          const ok = info.code === 0 && memoryMatches(bytes, limit);
          const seen = Number.isFinite(bytes) && bytes > 0 ? `Docker sees ${(bytes / GIB).toFixed(1)} GiB. The limit is ${limit} GB.` : mask(info.stderr, true);
          put('docker-memory', ok ? 'pass' : 'fail', { command: `herdr-boss factory docker ${label} -- info --format '{{.MemTotal}}'`, output: seen, next: ok ? '' : (windows ? 'Check the memory line of the .wslconfig file. Run `wsl --shutdown` in PowerShell. Open Ubuntu again.' : 'Check the memory limit of the runtime. Restart it.') });
        }
        // The SSH server takes no password.
        if (type === 'mac-orbstack') {
          const grep = "grep -ihs '^[[:space:]]*PasswordAuthentication' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*";
          const result = await runRemote(host, grep);
          const lines = result.stdout.split('\n').map((line) => line.trim().toLowerCase()).filter(Boolean);
          const ok = lines.length > 0 && lines.every((line) => /^passwordauthentication\s+no$/.test(line));
          put('sshd-password', ok ? 'pass' : 'fail', { command: ssh(grep), output: ok ? 'PasswordAuthentication is no.' : (lines.join('\n') || 'No PasswordAuthentication line.'), next: ok ? '' : 'Set `PasswordAuthentication no` in a file in /etc/ssh/sshd_config.d. Turn Remote Login off and on.' });
        } else {
          const result = await runRemote(host, 'sudo -n sshd -T');
          const off = /^passwordauthentication\s+no\s*$/mi.test(result.stdout);
          const fail = result.code !== 0 && !off;
          put('sshd-password', off ? 'pass' : 'fail', { command: ssh('sudo -n sshd -T'), output: off ? 'passwordauthentication no' : (fail ? mask(result.stderr || result.stdout) : 'passwordauthentication is not no.'), next: off ? '' : 'Run `sudo sshd -T | grep -i passwordauthentication` on the host. Set `PasswordAuthentication no` in /etc/ssh/sshd_config.d/00-herdr-factory.conf. Run `sudo sshd -t`. Reload SSH.' });
        }
      }
      // The two timed tests share the probe with the full run.
      if (windows && next.terminate && ['all', 'terminate'].includes(mode)) {
        next.terminate = advanceTerminate(next.terminate, { answered: answered && keyOk, now: now() });
        const record = next.terminate;
        const waiting = record.status === 'waiting';
        const output = record.status === 'passed' ? `The host came back ${minutes(record.seconds)} after the stop.`
          : waiting ? (record.downAt ? 'The host is down. Waiting for the repeating trigger to start it again.' : 'The host still answers. Run the stop command in PowerShell.')
          : (record.reason === 'never-down' ? 'The host never went down.' : 'The host did not come back in 7 minutes.');
        put('terminate', record.status === 'passed' ? 'pass' : waiting ? 'pending' : 'fail', { command: ssh('uname -m'), output, next: record.status === 'failed' ? (record.reason === 'never-down' ? 'Run `wsl --terminate DISTRO` in PowerShell on the host. Then press the button again.' : 'Open Task Scheduler. Check that the task has a repeating trigger every 5 minutes with no end date. Read its Last Run Result.') : '' });
      }
      if (next.reboot && ['all', 'reboot'].includes(mode)) {
        let uptime = null;
        let dockerOk = false;
        if (answered && keyOk) {
          const command = type === 'mac-orbstack' ? 'sysctl -n kern.boottime' : 'cat /proc/uptime';
          const result = await runRemote(host, command);
          if (type === 'mac-orbstack') { const boot = /sec\s*=\s*(\d+)/.exec(result.stdout); uptime = boot ? now() / 1000 - Number(boot[1]) : null; } else uptime = Number.parseFloat(result.stdout);
          const ps = host.dockerContext ? await runDocker(host, ['ps', '--format', '{{.ID}}'], spawn, env) : { code: 1 };
          dockerOk = ps.code === 0;
        }
        next.reboot = advanceReboot(next.reboot, { answered: answered && keyOk, dockerOk, uptimeSeconds: uptime, now: now() });
        const record = next.reboot;
        const waiting = record.status === 'waiting';
        const output = record.status === 'passed' ? `The host came back ${minutes(record.recoverySeconds)} after the start of the test.`
          : !answered ? 'The host does not answer yet.'
          : !keyOk ? 'The host answers but key login does not work.'
          : !dockerOk ? 'SSH answers but Docker does not.'
          : 'The host has not restarted since you started the test.';
        put('reboot', record.status === 'passed' ? 'pass' : waiting ? 'pending' : 'fail', { command: ssh(type === 'mac-orbstack' ? 'sysctl -n kern.boottime' : 'cat /proc/uptime'), output, next: record.status === 'failed' ? (windows ? 'Sign in at the machine. Open Task Scheduler. Read the Last Run Result of the boot task. Check that it runs when no user is signed in.' : 'Go to the machine. Check the power, the network, and that Tailscale and Docker start at boot.') : '' });
      }
    }
    // The check took a while. Read the file again and keep what was saved meanwhile. A deleted guide stays deleted.
    const fresh = readGuide(dataDir, label);
    if (!fresh) throw new GuideError(404, 'The guide was deleted during the check.');
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const merged = {
      ...fresh,
      checks: mode === 'all' ? Object.fromEntries(inCheckOrder(results, type)) : { ...fresh.checks, ...results },
      terminate: same(fresh.terminate, state.terminate) ? next.terminate : fresh.terminate,
      reboot: same(fresh.reboot, state.reboot) ? next.reboot : fresh.reboot,
      updatedAt: at,
    };
    save(dataDir, merged);
    return merged;
  } finally { running.delete(label); }
}

// The results in the order of the CHECKS list, for the types that have them.
function inCheckOrder(results, type) {
  return CHECKS.filter((check) => results[check.id] && (!check.types || check.types.includes(type))).map((check) => [check.id, results[check.id]]);
}

// The routes. `handle` returns { status, body }, or null for a path that is not a guide route.
// Each route needs the owner: the dashboard page on this machine or a page with a login session. The server refuses all routes in the read-only preview.
export function createHostGuideApi({ dataDir, spawn = nodeSpawn, env = process.env, now = Date.now } = {}) {
  const view = (state) => ({ state, progress: progress(state) });
  const hosts = () => { try { return Object.keys(loadRegistry(env).hosts).filter((name) => name !== 'local').sort(); } catch { return []; } };
  return {
    async handle(method, p, readBody, { owner = false } = {}) {
      const match = /^\/api\/host-guide(?:\/([^/]+)(?:\/(check|action))?)?\/?$/.exec(p);
      if (!match) return null;
      try {
        // The saved values hold the tailnet and account names, so a read needs the owner too. A token session gets 403.
        if (!owner) return { status: 403, body: { error: 'The host guide needs the Owner session.' } };
        if (!match[1]) {
          if (method !== 'GET') return { status: 405, body: { error: 'Use GET.' } };
          return { status: 200, body: { guides: listGuides(dataDir), hosts: hosts(), checks: CHECKS } };
        }
        let label;
        try { label = decodeURIComponent(match[1]); } catch { label = ''; }
        if (!HOST_NAME.test(label) || label === 'local') return { status: 404, body: { error: 'No guide has this label.' } };
        const sub = match[2];
        if (method === 'GET' && !sub) {
          const state = readGuide(dataDir, label);
          return state ? { status: 200, body: view(state) } : { status: 404, body: { error: 'No guide has this label.' } };
        }
        const allowed = sub ? method === 'POST' : ['PUT', 'DELETE'].includes(method);
        if (!allowed) return { status: 405, body: { error: 'This method is not allowed here.' } };
        if (method === 'DELETE') { deleteGuide(dataDir, label); return { status: 200, body: { ok: true } }; }
        const body = await readBody();
        if (!isObject(body)) throw new GuideError(400, 'The body must be a JSON object.');
        if (!sub) return { status: 200, body: view(updateGuide(dataDir, label, body, { now })) };
        if (sub === 'action') return { status: 200, body: view(guideAction(dataDir, label, body.action, { now })) };
        const extra = Object.keys(body).find((key) => key !== 'check');
        if (extra !== undefined) throw new GuideError(400, `Unknown field: ${extra.slice(0, 40)}.`);
        return { status: 200, body: view(await runGuideChecks(dataDir, label, { env, spawn, now, ids: [body.check ?? 'all'] })) };
      } catch (error) {
        if (error instanceof GuideError) return { status: error.status, body: { error: error.message } };
        // A body error from the server has its own status. Any other error is a file failure: its text can hold a local path.
        if (Number.isInteger(error?.statusCode)) throw error;
        return { status: 500, body: { error: 'The host guide could not read or write its saved file.' } };
      }
    },
  };
}
