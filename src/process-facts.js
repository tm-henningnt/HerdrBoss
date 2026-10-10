import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const LIMIT_MS = 2000;
const MAX_BYTES = 16 * 1024 * 1024;
const TIMEOUT_REASON = 'The process facts probe timed out.';
const unknown = (reason) => ({ known: false, reason });
const validPid = (pid) => Number.isSafeInteger(Number(pid)) && Number(pid) > 0;
const validPort = (port) => validPid(port) && Number(port) <= 65535;
const name = (value) => path.basename(String(value ?? '').trim()).slice(0, 128);
const inside = (root, cwd) => {
  const relative = path.relative(root, cwd);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
let serviceReaders = 0;

// The service is already outside the sandbox. Its own readers must not make a synchronous request to itself.
export function enterProcessFactsService() {
  serviceReaders++;
  let released = false;
  return () => { if (!released) { released = true; serviceReaders--; } };
}

// Resolve existing ancestors too, so aliases and a symlink followed by a missing child use the same root check.
export function canonicalProcessPath(target) {
  let current = path.resolve(target);
  const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync(current), ...tail.reverse()); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code) || current === path.dirname(current)) throw error;
      tail.push(path.basename(current)); current = path.dirname(current);
    }
  }
}

// A Node child makes a bounded HTTP request while the existing synchronous CLI waits.
// Only caller metadata enters its input. No credential, command line, or environment enters its output.
const REQUEST_SCRIPT = `
import http from 'node:http';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { port, route, headers } = JSON.parse(input);
let connected = false, done = false, timer;
const finish = result => {
  if (done) return;
  done = true; clearTimeout(timer);
  process.stdout.write(JSON.stringify(result) + '\\n');
};
const req = http.get({ hostname: '127.0.0.1', port, path: route, headers }, res => {
  let body = '';
  res.on('data', chunk => {
    body += chunk;
    if (body.length > ${MAX_BYTES}) { finish({ reachable: true, status: res.statusCode }); req.destroy(); }
  });
  res.on('end', () => {
    try { finish({ reachable: true, status: res.statusCode, body: JSON.parse(body) }); }
    catch { finish({ reachable: true, status: res.statusCode }); }
  });
  res.on('error', () => finish({ reachable: true }));
});
req.on('socket', socket => {
  const markConnected = () => {
    connected = true;
    process.stdout.write(JSON.stringify({ connected: true }) + '\\n');
  };
  if (socket.connecting) socket.once('connect', markConnected);
  else markConnected();
});
timer = setTimeout(() => { finish({ reachable: connected, timedOut: true }); req.destroy(); }, ${LIMIT_MS});
req.on('error', () => finish({ reachable: connected }));
`;

export function requestProcessFacts(route, { env = process.env, runner = spawnSync } = {}) {
  if (serviceReaders) return { reachable: false };
  const port = Number(env.HERDR_BOSS_PORT || 4477);
  if (!validPort(port)) return { reachable: true, status: 400 };
  const headers = {
    'x-herdr-env': env.HERDR_ENV || '',
    'x-herdr-pane-id': env.HERDR_PANE_ID || '',
    'x-herdr-workspace-id': env.HERDR_WORKSPACE_ID || '',
  };
  try {
    const result = runner(process.execPath, ['--input-type=module', '-e', REQUEST_SCRIPT], {
      input: JSON.stringify({ port, route, headers }), encoding: 'utf8', timeout: LIMIT_MS + 500,
      maxBuffer: MAX_BYTES, env: { PATH: env.PATH || '' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const messages = String(result.stdout || '').split('\n').flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    const connected = messages.some((message) => message.connected === true || message.reachable === true);
    if (result.error || result.status !== 0) return { reachable: connected,
      ...(connected && result.error?.code === 'ETIMEDOUT' ? { timedOut: true } : {}) };
    return messages.findLast((message) => typeof message.reachable === 'boolean') || { reachable: connected };
  } catch { return { reachable: false }; }
}

function rowsOnly(rows, { cwd = false } = {}) {
  if (!Array.isArray(rows) || rows.some((row) => !validPid(row?.pid) || typeof row.command !== 'string')) return null;
  return rows.map((row) => ({ pid: Number(row.pid), ppid: validPid(row.ppid) ? Number(row.ppid) : null,
    command: name(row.command), ...(cwd ? { inCwd: row.inCwd === true } : {}) }));
}

// Project each answer onto its public fields. Never forward a runner or service payload wholesale.
export function publicProcessFacts(kind, body) {
  if (body?.known !== true) return unknown(body?.reason === TIMEOUT_REASON ? TIMEOUT_REASON : 'The process facts could not be checked.');
  if (kind === 'info') {
    const parents = rowsOnly(body.parents);
    if (!validPid(body.pid) || typeof body.alive !== 'boolean' || !parents
      || (body.start !== null && (typeof body.start !== 'string' || !Number.isFinite(Date.parse(body.start))))) {
      return unknown('The process info answer is invalid.');
    }
    return { known: true, pid: Number(body.pid), alive: body.alive, start: body.start,
      state: ['alive', 'zombie', 'gone'].includes(body.state) ? body.state : 'unknown', parents };
  }
  if (kind === 'port') {
    const listeners = rowsOnly(body.listeners), clients = rowsOnly(body.clients);
    if (!listeners || !clients) return unknown('The port clients answer is invalid.');
    const strip = (row) => ({ pid: row.pid, command: row.command });
    const excluded = new Set([...listeners.map((row) => row.pid), process.pid, Number(body.servicePid)]);
    const external = new Map(clients.filter((row) => !excluded.has(row.pid)).map((row) => [row.pid, strip(row)]));
    return { known: true, listeners: listeners.map(strip), clients: [...external.values()],
      ...(validPid(body.servicePid) ? { servicePid: Number(body.servicePid) } : {}) };
  }
  const processes = rowsOnly(body.processes, { cwd: true });
  return processes ? { known: true, processes } : unknown('The cwd processes answer is invalid.');
}

function runProbe(runner, command, args, { empty = false, deadline, now } = {}) {
  const timeout = Math.min(LIMIT_MS, Math.ceil(deadline - now()));
  if (timeout <= 0) throw Object.assign(new Error(TIMEOUT_REASON), { code: 'ETIMEDOUT' });
  const result = runner(command, args, { encoding: 'utf8', timeout, maxBuffer: MAX_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH || '', LC_ALL: 'C' } });
  if (result.error?.code === 'ETIMEDOUT' || now() >= deadline) throw Object.assign(new Error(TIMEOUT_REASON), { code: 'ETIMEDOUT' });
  if (!result.error && result.status === 0) return String(result.stdout || '');
  if (empty && !result.error && result.status === 1 && !String(result.stdout || '').trim() && !String(result.stderr || '').trim()) return '';
  throw new Error('Process probe unavailable');
}

function processTable(runner, budget) {
  const output = runProbe(runner, 'ps', ['-axo', 'pid=,ppid=,stat=,lstart=,comm='], budget);
  const rows = output.split('\n').filter((line) => line.trim()).map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(line);
    if (!match || !Number.isFinite(Date.parse(match[4]))) throw new Error('Invalid process table');
    return { pid: Number(match[1]), ppid: Number(match[2]) || null, state: match[3].startsWith('Z') ? 'zombie' : 'alive',
      start: match[4].trim().replace(/\s+/g, ' '), command: name(match[5]) };
  });
  if (!rows.length) throw new Error('Empty process table');
  return rows;
}

function lsofRows(output) {
  const rows = [];
  let row = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) { row = { pid: Number(line.slice(1)), command: '' }; rows.push(row); }
    else if (row && line.startsWith('c')) row.command = name(line.slice(1));
    else if (row && line.startsWith('n')) row.cwd = line.slice(1);
  }
  if (rows.some((row) => !validPid(row.pid) || !row.command)) throw new Error('Invalid process list');
  return rows;
}

export function localProcessFacts(kind, value, { runner = spawnSync, now = () => performance.now() } = {}) {
  try {
    const budget = { now, deadline: now() + LIMIT_MS };
    if (kind === 'port') {
      const read = (state) => lsofRows(runProbe(runner, 'lsof', ['-nP', `-iTCP:${value}`, `-sTCP:${state}`, '-Fpc'], { ...budget, empty: true }));
      return publicProcessFacts(kind, { known: true, listeners: read('LISTEN'), clients: read('ESTABLISHED') });
    }
    const rows = processTable(runner, budget);
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    if (kind === 'info') {
      const row = byPid.get(Number(value));
      if (!row) return { known: true, pid: Number(value), alive: false, start: null, state: 'gone', parents: [] };
      const parents = [], seen = new Set([row.pid]);
      let parent = byPid.get(row.ppid);
      while (parent && !seen.has(parent.pid)) {
        seen.add(parent.pid); parents.push(parent); parent = byPid.get(parent.ppid);
      }
      return publicProcessFacts(kind, { known: true, ...row, alive: row.state !== 'zombie', parents });
    }
    const root = canonicalProcessPath(value);
    const cwdRows = lsofRows(runProbe(runner, 'lsof', ['-a', '-d', 'cwd', '-FpcnR'], { ...budget, empty: true }));
    const matches = new Set(cwdRows.filter((row) => row.cwd && inside(root, canonicalProcessPath(row.cwd))).map((row) => row.pid));
    // Keep the safe full tree: a recorded worker shell and all its children can have changed cwd.
    return publicProcessFacts(kind, { known: true, processes: rows
      .map((row) => ({ ...row, inCwd: matches.has(row.pid) })) });
  } catch (error) { return unknown(error.code === 'ETIMEDOUT' ? TIMEOUT_REASON
    : `Local ${kind === 'port' ? 'port clients' : kind === 'cwd' ? 'cwd processes' : 'process info'} could not be checked with ps or lsof.`); }
}

export function createProcessFactsClient({ request = requestProcessFacts, runner = spawnSync } = {}) {
  const read = (kind, value) => {
    if ((kind === 'info' && !validPid(value)) || (kind === 'port' && !validPort(value))
      || (kind === 'cwd' && (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value)))) {
      return unknown('The process facts request is invalid.');
    }
    let response;
    try { response = request(`/api/process-facts/${kind}?${kind === 'cwd' ? 'path' : kind === 'port' ? 'port' : 'pid'}=${encodeURIComponent(value)}`); }
    catch { response = { reachable: false }; }
    if (response?.reachable === false) return localProcessFacts(kind, value, { runner });
    if (response?.timedOut) return unknown('The process facts service timed out after connection.');
    if (response?.status !== 200) return unknown(`The process facts service refused the request (HTTP ${Number(response?.status) || 'unknown'}).`);
    return publicProcessFacts(kind, response.body);
  };
  return { processInfo: (pid) => read('info', pid), portClients: (port) => read('port', port), processesInCwd: (cwd) => read('cwd', cwd) };
}

const client = createProcessFactsClient();
export const getProcessInfo = (pid) => client.processInfo(pid);
export const getPortClients = (port) => client.portClients(port);
export const getCwdProcesses = (cwd) => client.processesInCwd(cwd);
