// Connect a registered container factory without exposing provisioning output.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { managedFactory, transportFor, inspect, assertOwned, dockerCall, readHealth } from './factory-core.js';
import { factoryFile, readPrivate, writePrivate, readFleet, updateFleet, assertName } from './factory-store.js';
import { createHostTransport, isHostUnreachable } from './factory-transport.js';
import { pollFleetSummary, fleetPollError } from './fleet-poller.js';
import { FLEET_READ_TOKEN } from './fleet-access.js';
import { readFleetFile, writeFleetFile } from './fleet-store.js';
import { validateDashboardUrl } from './fleet-settings.js';
import { maskLine } from './factory-host.js';

const CREATED_FILE = 'connect-created.json';
const REMOTE_CLI = '/home/factory/herdr-boss/src/cli.js';
const failure = (code, extra = {}) => Object.assign(new Error(code), { code }, extra);
const privateDir = (env) => path.join(env.HOME || os.homedir(), '.config', 'herdr-boss');
const parse = (raw) => { try { return JSON.parse(raw); } catch { throw failure('contract-mismatch'); } };
const remoteCli = (record, args) => ['exec', '-i', '--user', 'factory', '-e', 'HOME=/home/factory', record.containerName, 'node', REMOTE_CLI, 'fleet', ...args];

// The export stays private in the factory so that a failed Mac import can resume.
const tokenScript = `
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fleetCommand } from '/home/factory/herdr-boss/src/fleet-cli.js';
import { FLEET_READ_TOKEN } from '/home/factory/herdr-boss/src/fleet-access.js';
const privateDir = '/home/factory/.config/herdr-boss';
const file = privateDir + '/fleet-connect-token.json';
let token;
try { token = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('The private export is invalid.'); }
let current;
try { current = JSON.parse(fs.readFileSync(privateDir + '/fleet-read.json', 'utf8')).current; } catch (error) { if (error.code !== 'ENOENT') throw new Error('The private read credential is invalid.'); }
if (!FLEET_READ_TOKEN.test(token) || createHash('sha256').update(token).digest('hex') !== current) {
  fs.rmSync(file, { force: true });
  await fleetCommand(['read-token', 'rotate', '--out-file', file], { privateDir, stdout: { write() {} } });
  token = JSON.parse(fs.readFileSync(file, 'utf8'));
}
fs.chmodSync(file, 0o600);
process.stdout.write(JSON.stringify(token));
`;

// Only an access denied message needs the Owner. Other Serve failures fail without a wait.
const serveError = (result, host) => {
  const output = `${result.stdout}${result.stderr}`;
  return Object.assign(failure(/access denied/i.test(output) ? 'serve-owner-required' : 'serve-failed'), { publicError: maskLine(output, host, true) });
};

async function endpoint(host, record, container, io, created) {
  const transport = io.hostTransportFactory ? io.hostTransportFactory(host) : createHostTransport(host, io);
  const status = await transport.run(['tailscale', 'status', '--json']);
  if (status.code !== 0) throw failure('tailnet-unavailable');
  const tailnet = parse(status.stdout);
  const hostname = tailnet.Self?.DNSName?.replace(/\.$/, '').toLowerCase();
  const address = tailnet.Self?.TailscaleIPs?.find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
  if (tailnet.BackendState !== 'Running' || !hostname || !address) throw failure('tailnet-unavailable');
  const port = record.ports.dashboard;
  const target = `http://127.0.0.1:${port}`;
  const bindings = container.HostConfig?.PortBindings?.['4477/tcp'] || [];
  if (!bindings.some((binding) => binding.HostIp === '127.0.0.1' && binding.HostPort === String(port)) || bindings.some((binding) => !['127.0.0.1', '::1'].includes(binding.HostIp))) throw failure('unsafe-dashboard-binding');
  const config = await transport.run(['tailscale', 'serve', 'status', '--json']);
  if (config.code === 0) {
    const current = parse(config.stdout);
    // Reuse the Owner's default HTTPS forward or an existing HTTP forward.
    for (const [site, web] of Object.entries(current.Web || {})) {
      const split = site.lastIndexOf(':');
      const name = site.slice(0, split).toLowerCase();
      const listeningPort = Number(site.slice(split + 1));
      const proxy = web?.Handlers?.['/']?.Proxy;
      let matching = false;
      try {
        const url = new URL(proxy);
        matching = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && Number(url.port) === port && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash;
      } catch { /* An unrelated handler cannot supply the factory endpoint. */ }
      const tcp = current.TCP?.[listeningPort];
      if (name === hostname && matching && (tcp?.HTTPS || tcp?.HTTP)) return validateDashboardUrl(`${tcp.HTTPS ? 'https' : 'http'}://${hostname}:${listeningPort}`);
    }
    const site = `${hostname}:${port}`;
    const handler = current.Web?.[site]?.Handlers?.['/'];
    if (handler && handler.Proxy !== target) throw failure('serve-route-conflict');
    if (current.TCP?.[port] && !current.TCP[port].HTTP) throw failure('serve-route-conflict');
    if (handler?.Proxy !== target) {
      const args = ['tailscale', 'serve', '--bg', `--http=${port}`, target];
      const result = await transport.run(args);
      if (result.code !== 0) throw serveError(result, host);
      created.serve = true;
    }
    return validateDashboardUrl(`http://${hostname}:${port}`);
  }
  throw serveError(config, host);
}

async function importCredential(factoryId, token, io) {
  if (io.importCredential) return io.importCredential(factoryId, token);
  const { fleetCommand } = await import('./fleet-cli.js');
  await fleetCommand(['read-token', 'set', factoryId, '--from-file', '-'], {
    privateDir: privateDir(io.env), stdin: Readable.from([JSON.stringify(token)]), stdout: { write() {} },
  });
}

async function enableHeadOffice(io) {
  const fetchImpl = io.fetchImpl || fetch;
  const origin = `http://127.0.0.1:${io.env.HERDR_BOSS_PORT || 4477}`;
  const response = await fetchImpl(`${origin}/api/fleet/settings`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) throw failure('head-office-unavailable');
  const { factoryId: _id, error, ...settings } = await response.json();
  if (error) throw failure('head-office-unavailable');
  if (settings.headOffice === true) return;
  const saved = await fetchImpl(`${origin}/api/fleet/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...settings, headOffice: true }), signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!saved.ok) throw failure('head-office-unavailable');
}

async function check(record, io, token) {
  const file = factoryFile(io.env, record.name, 'connect-cache.json');
  const old = readPrivate(file, null);
  const now = io.now || Date.now;
  let accepted, error;
  try {
    token ??= readFleetFile(path.join(privateDir(io.env), 'fleet-remotes.json'), {})[record.factoryId];
    accepted = await pollFleetSummary(record, token, { fetchImpl: io.fetchImpl || fetch, now });
    writePrivate(file, { factoryId: record.factoryId, dashboardUrl: record.dashboardUrl, summary: accepted.summary, lastSeenAt: new Date(now()).toISOString() });
  } catch (cause) { error = fleetPollError(cause); }
  const summary = accepted?.summary || (old?.factoryId === record.factoryId && old.dashboardUrl === record.dashboardUrl ? old.summary : null);
  const age = summary ? `${Math.max(0, Math.floor((now() - Date.parse(summary.generatedAt)) / 1000))}s` : 'unknown';
  const state = error ? 'offline' : accepted.summary.health.status;
  io.stdout.write(`${record.name} ${state} ${age}\n`);
  return error ? 1 : 0;
}

const undoScript = 'const fs=require("fs");const file="/home/factory/.herdr-boss/config.json";const host=process.argv[1];let c;try{c=JSON.parse(fs.readFileSync(file,"utf8"));}catch(e){if(e.code==="ENOENT"){console.log(JSON.stringify({removed:false}));process.exit(0);}throw e;}const removed=(c.allowedHosts||[]).includes(host);if(removed){c.allowedHosts=c.allowedHosts.filter((item)=>item!==host);fs.writeFileSync(file+".connect-undo.tmp",JSON.stringify(c)+"\\n",{mode:0o600});fs.renameSync(file+".connect-undo.tmp",file);}console.log(JSON.stringify({removed}));';

async function disableHeadOffice(io) {
  const fetchImpl = io.fetchImpl || fetch;
  const origin = `http://127.0.0.1:${io.env.HERDR_BOSS_PORT || 4477}`;
  const response = await fetchImpl(`${origin}/api/fleet/settings`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) throw failure('head-office-unavailable');
  const { factoryId: _id, error, ...settings } = await response.json();
  if (error) throw failure('head-office-unavailable');
  if (settings.headOffice !== true) return;
  const saved = await fetchImpl(`${origin}/api/fleet/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...settings, headOffice: false }), signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!saved.ok) throw failure('head-office-unavailable');
}

// Remove what connect created. Keep the registration until the last step so that a retry can finish.
async function undo(name, io) {
  if (!readFleet(io.env).factories.some((item) => item.name === name && item.kind === 'container')) {
    io.stdout.write(`${name} nothing is left to undo.\n`);
    return 0;
  }
  const { record, host } = managedFactory(io.env, name);
  const createdFile = factoryFile(io.env, name, CREATED_FILE);
  const created = { serve: false, allowedHost: null, ...readPrivate(createdFile, {}) };
  const removed = [];
  let stage = 'serve';
  try {
    if (created.serve) {
      const transport = io.hostTransportFactory ? io.hostTransportFactory(host) : createHostTransport(host, io);
      const result = await transport.run(['tailscale', 'serve', `--http=${record.ports.dashboard}`, 'off']);
      if (result.code !== 0 && !/no (serve )?config|not found|does not exist|nothing to/i.test(`${result.stdout}${result.stderr}`)) throw failure('serve-failed');
      created.serve = false; writePrivate(createdFile, created); removed.push('serve forward');
    }
    stage = 'allowed-host';
    if (created.allowedHost) {
      const docker = transportFor(host, io);
      const container = await inspect(docker, 'container', record.containerName);
      if (!container) throw failure('container-stopped');
      assertOwned(container, name);
      if (!container.State?.Running) throw failure('container-stopped');
      const { removed: gone } = parse(await dockerCall(docker, ['exec', '--user', 'factory', record.containerName, 'node', '-e', undoScript, created.allowedHost]));
      if (gone) {
        await dockerCall(docker, ['exec', record.containerName, '/command/s6-svc', '-r', '/run/service/herdr-boss-serve']);
        await readHealth(docker, name);
        removed.push('allowed host');
      }
      created.allowedHost = null; writePrivate(createdFile, created);
    }
    stage = 'credential';
    const remotes = path.join(privateDir(io.env), 'fleet-remotes.json');
    const records = readFleetFile(remotes, {});
    if (Object.hasOwn(records, record.factoryId)) {
      delete records[record.factoryId];
      writeFleetFile(remotes, records);
      removed.push('read credential');
    }
    stage = 'head-office';
    if (!readFleet(io.env).factories.some((item) => item.name !== name)) await disableHeadOffice(io);
    stage = 'register';
    updateFleet(io.env, (fleet) => { fleet.factories = fleet.factories.filter((item) => item.name !== name); });
    removed.push('registration');
    for (const file of [CREATED_FILE, 'connect.json', 'connect-cache.json']) fs.rmSync(factoryFile(io.env, name, file), { force: true });
  } catch (error) {
    const reason = isHostUnreachable(error) ? 'unreachable' : ['serve-failed', 'container-stopped', 'head-office-unavailable'].includes(error.code) ? error.code : 'undo-failed';
    io.stderr.write(`${name} undo failed: ${stage} ${reason}. Retry factory connect --undo ${name}.\n`);
    return 1;
  }
  io.stdout.write(`${name} undone: removed ${removed.join(', ')}.\n`);
  return 0;
}

export async function factoryConnectCommand(args, io) {
  const checkOnly = args.includes('--check');
  const undoOnly = args.includes('--undo');
  const names = args.filter((arg) => arg !== '--check' && arg !== '--undo');
  if (names.length !== 1 || args.length !== (checkOnly || undoOnly ? 2 : 1) || (checkOnly && undoOnly)) throw new Error('Use factory connect [--check|--undo] NAME.');
  assertName(names[0]);
  if (undoOnly) return undo(names[0], io);
  const { record, host } = managedFactory(io.env, names[0]);
  if (checkOnly) return check(record, io);
  const journal = factoryFile(io.env, record.name, 'connect.json');
  const createdFile = factoryFile(io.env, record.name, CREATED_FILE);
  const created = { serve: false, allowedHost: null, ...readPrivate(createdFile, {}) };
  let stage = 'endpoint';
  try {
    const docker = transportFor(host, io);
    const container = await inspect(docker, 'container', record.containerName);
    assertOwned(container, record.name);
    if (!container.State?.Running) throw failure('container-stopped');
    const dashboardUrl = await endpoint(host, record, container, io, created);
    writePrivate(journal, { schema: 1, name: record.name, stage, dashboardUrl });
    if (created.serve) writePrivate(createdFile, created);
    stage = 'settings';
    const settings = parse(await dockerCall(docker, remoteCli(record, ['settings'])));
    if (typeof settings.factoryId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(settings.factoryId)) throw failure('contract-mismatch');
    // Reject a clone before it can replace another factory's private read credential.
    if (readFleet(io.env).factories.some((item) => item.name !== record.name && item.factoryId === settings.factoryId)) throw failure('duplicate-factory-id');
    const configScript = 'const fs=require("fs");const file="/home/factory/.herdr-boss/config.json";let c={};try{c=JSON.parse(fs.readFileSync(file,"utf8"));}catch(e){if(e.code!=="ENOENT")throw e;}const host=process.argv[1];const changed=!(c.allowedHosts||[]).includes(host);if(changed){c.allowedHosts=[...new Set([...(c.allowedHosts||[]),host])];fs.writeFileSync(file+".connect.tmp",JSON.stringify(c)+"\\n",{mode:0o600});fs.renameSync(file+".connect.tmp",file);}console.log(JSON.stringify({changed}));';
    const changed = parse(await dockerCall(docker, ['exec', '--user', 'factory', record.containerName, 'node', '-e', configScript, new URL(dashboardUrl).hostname])).changed;
    if (changed) { created.allowedHost = new URL(dashboardUrl).hostname; writePrivate(createdFile, created); }
    const { factoryId, ...values } = settings;
    await dockerCall(docker, remoteCli(record, ['init', '--from-file', '-']), { input: JSON.stringify({ factoryId, ...values, name: record.name, dashboardUrl }) });
    if (changed) {
      await dockerCall(docker, ['exec', record.containerName, '/command/s6-svc', '-r', '/run/service/herdr-boss-serve']);
      await readHealth(docker, record.name);
    }
    stage = 'access';
    let access;
    try { access = await (io.fetchImpl || fetch)(`${dashboardUrl}/api/health`, { redirect: 'error', signal: AbortSignal.timeout(5000) }); }
    catch (error) {
      // The host answered the Docker calls, so SSH works. A silent dashboard port points to the tailnet access rules.
      throw failure('dashboard-unreachable', { port: Number(new URL(dashboardUrl).port) || (new URL(dashboardUrl).protocol === 'https:' ? 443 : 80) });
    }
    await access.body?.cancel();
    if (access.status !== 401) throw failure('dashboard-auth-required');
    stage = 'credential';
    const token = parse(await dockerCall(docker, ['exec', '--user', 'factory', '-e', 'HOME=/home/factory', record.containerName, 'node', '--input-type=module', '-e', tokenScript]));
    if (!FLEET_READ_TOKEN.test(token)) throw failure('credential-invalid');
    await importCredential(factoryId, token, io);
    stage = 'register';
    updateFleet(io.env, (fleet) => {
      if (fleet.factories.some((item) => item.name !== record.name && item.factoryId === factoryId)) throw failure('duplicate-factory-id');
      const registered = fleet.factories.find((item) => item.name === record.name);
      if (!registered || registered.hostId !== record.hostId) throw failure('registration-changed');
      registered.factoryId = factoryId; registered.dashboardUrl = dashboardUrl;
    });
    stage = 'head-office';
    await enableHeadOffice(io);
    stage = 'check';
    const code = await check({ ...record, factoryId, dashboardUrl }, io, token);
    if (code === 0) {
      const { summary } = readPrivate(factoryFile(io.env, record.name, 'connect-cache.json'));
      updateFleet(io.env, (fleet) => {
        const registered = fleet.factories.find((item) => item.name === record.name);
        if (!registered || registered.factoryId !== factoryId) throw failure('registration-changed');
        registered.version = summary.version; registered.kitRevision = summary.kitRevision;
      });
    }
    writePrivate(journal, { schema: 1, name: record.name, factoryId, dashboardUrl, stage: code === 0 ? 'connected' : 'check', state: code === 0 ? 'connected' : 'offline' });
    return code;
  } catch (error) {
    if (error.code === 'serve-owner-required') {
      try { writePrivate(journal, { schema: 1, name: record.name, stage, state: 'waiting', error: error.code }); }
      catch { io.stderr.write(`${record.name} connect failed: private-store-unavailable.\n`); return 1; }
      io.stderr.write(`${record.name} waiting for the Owner.\n${error.publicError?.trim() || 'Tailscale Serve is unavailable.'}\nRun one command in the WSL Owner terminal:\n  sudo tailscale set --operator=${host.user}\n  sudo tailscale serve --bg ${record.ports.dashboard}\nThen retry factory connect ${record.name}.\n`);
      return 3;
    }
    const allowed = ['serve-failed', 'tailnet-unavailable', 'unsafe-dashboard-binding', 'serve-route-conflict', 'dashboard-auth-required', 'dashboard-unreachable', 'contract-mismatch', 'container-stopped', 'credential-invalid', 'duplicate-factory-id', 'registration-changed', 'head-office-unavailable'];
    const reason = isHostUnreachable(error) ? 'unreachable' : allowed.includes(error.code) ? error.code : 'connect-failed';
    try { writePrivate(journal, { schema: 1, name: record.name, stage, state: 'failed', error: reason }); }
    catch { io.stderr.write(`${record.name} connect failed: private-store-unavailable.\n`); return 1; }
    io.stderr.write(`${record.name} connect failed: ${stage} ${reason}.${reason === 'serve-failed' && error.publicError?.trim() ? `\n${error.publicError.trim()}` : ''}${reason === 'dashboard-unreachable' ? `\nThe tailnet access rules may not allow port ${error.port}; add it next to port 22.` : ''} Retry factory connect.\n`);
    return 1;
  }
}
