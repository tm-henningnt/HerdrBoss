import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const cpuSamples = new Map();
const read = async (file) => { try { return await fs.readFile(file, 'utf8'); } catch { return ''; } };
const unsigned = (text) => /^\d+$/.test(text ?? '') && Number.isSafeInteger(Number(text)) ? Number(text) : null;
const positive = (text) => { const n = unsigned(text); return n > 0 ? n : null; };
const clampPercent = (value) => Math.max(0, Math.min(100, value));

function meminfo(text) {
  const fields = {};
  for (const line of text.split('\n')) {
    const match = /^(\w+):\s+(\d+)\s+kB\s*$/.exec(line);
    if (match) fields[match[1]] = unsigned(match[2]);
  }
  const total = fields.MemTotal > 0 ? fields.MemTotal * 1024 : null;
  const available = fields.MemAvailable ?? fields.MemFree;
  const swapTotal = fields.SwapTotal ?? null;
  const swapFree = fields.SwapFree ?? null;
  return {
    total,
    free: total !== null && available != null ? clampPercent(available * 1024 / total * 100) : null,
    swapTotalMB: swapTotal !== null ? Math.round(swapTotal / 1024) : null,
    swapUsedMB: swapTotal !== null && swapFree !== null ? Math.round(Math.max(0, swapTotal - swapFree) / 1024) : null,
  };
}

function pressure(text) {
  if (!text.trim()) return null;
  const result = { some: null, full: null };
  for (const line of text.trim().split('\n')) {
    const match = /^(some|full) avg10=(\d+(?:\.\d+)?) avg60=(\d+(?:\.\d+)?) avg300=(\d+(?:\.\d+)?) total=(\d+)$/.exec(line.trim());
    if (!match) continue;
    const values = match.slice(2).map(Number);
    if (values.every(Number.isFinite) && values.slice(0, 3).every((n) => n <= 100) && Number.isSafeInteger(values[3])) {
      result[match[1]] = Object.fromEntries(['avg10', 'avg60', 'avg300', 'total'].map((key, i) => [key, values[i]]));
    }
  }
  return result;
}

const mountPath = (value) => value.replace(/\\([0-7]{3})/g, (_, n) => String.fromCharCode(parseInt(n, 8)));

// Resolve the process group inside the mounted hierarchy. A mount can expose only a container subtree.
async function cgroupDirectories(procRoot) {
  const [groups, mounts] = await Promise.all([read(path.join(procRoot, 'self/cgroup')), read(path.join(procRoot, 'self/mountinfo'))]);
  const group = /^0::(\/[^\n]*)$/m.exec(groups)?.[1];
  if (!group || group.split('/').some((part) => part === '..' || part === '.')) return [];
  const candidates = [];
  for (const line of mounts.split('\n')) {
    const [before, after] = line.split(' - ');
    if (after?.split(' ')[0] !== 'cgroup2') continue;
    const fields = before.split(' ');
    if (!fields[3] || !fields[4]) continue;
    const root = mountPath(fields[3]);
    const mount = mountPath(fields[4]);
    if (!path.isAbsolute(root) || !path.isAbsolute(mount)) continue;
    if (group === '/' || root === '/' || group === root || group.startsWith(`${root}/`)) candidates.push({ root, mount });
  }
  candidates.sort((a, b) => b.root.length - a.root.length);
  const chosen = candidates[0];
  if (!chosen) return [];
  const relative = group === '/' ? '' : chosen.root === '/' ? group.slice(1) : group.slice(chosen.root.length).replace(/^\//, '');
  const root = path.resolve(chosen.mount);
  const directories = [];
  for (let dir = path.resolve(root, relative); dir === root || dir.startsWith(`${root}${path.sep}`); dir = path.dirname(dir)) {
    directories.push(dir);
    if (dir === root) break;
  }
  return directories;
}

function cpuSetCount(text) {
  if (!text.trim()) return null;
  let count = 0, end = -1;
  for (const item of text.trim().split(',')) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(item);
    if (!match) return null;
    const first = unsigned(match[1]), last = unsigned(match[2] ?? match[1]);
    if (first === null || last === null || first <= end || last < first) return null;
    count += last - first + 1;
    end = last;
  }
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}

// Page cache that the kernel can reclaim is not memory pressure. Subtract it from the used memory of the group.
function reclaimableAdjusted(used, statText) {
  if (used === null) return null;
  let cache = 0;
  for (const name of ['inactive_file', 'active_file']) cache += unsigned(new RegExp(`^${name}\\s+(\\d+)$`, 'm').exec(statText)?.[1]) ?? 0;
  return Math.max(0, used - cache);
}

async function groupSample(dir) {
  const names = ['cpu.max', 'cpuset.cpus.effective', 'memory.max', 'memory.current', 'memory.swap.max', 'memory.swap.current', 'memory.stat'];
  const values = await Promise.all(names.map((name) => read(path.join(dir, name))));
  const [quota, period] = values[0].trim().split(/\s+/);
  return {
    cpuLimit: positive(quota) && positive(period) ? Number(quota) / Number(period) : null,
    cpuSet: cpuSetCount(values[1]),
    memoryLimit: positive(values[2].trim()), memoryUsed: reclaimableAdjusted(unsigned(values[3].trim()), values[6]),
    swapLimit: unsigned(values[4].trim()), swapUsed: unsigned(values[5].trim()),
  };
}

export async function collectLinuxMachine({ procRoot = '/proc', system = os, now = performance.now(), cpuSamples: samples = cpuSamples } = {}) {
  const [memoryText, loadText, directories] = await Promise.all([
    read(path.join(procRoot, 'meminfo')), read(path.join(procRoot, 'loadavg')), cgroupDirectories(procRoot),
  ]);
  const memory = meminfo(memoryText);
  const groups = await Promise.all(directories.map(groupSample));
  const hostTotal = memory.total ?? system.totalmem();
  const memoryGroups = groups.filter((g) => g.memoryLimit !== null && g.memoryLimit <= hostTotal);
  const total = Math.min(hostTotal, ...memoryGroups.map((g) => g.memoryLimit));
  // Ancestor usage includes siblings that share its cap. Use its remaining capacity too.
  let free = memory.free;
  if (memoryGroups.length) {
    const remaining = Math.min(...memoryGroups.map((g) => g.memoryLimit - g.memoryUsed));
    free = memoryGroups.some((g) => g.memoryUsed === null) ? null : clampPercent(remaining / total * 100);
  }
  const swapGroups = groups.filter((g) => g.swapLimit !== null);
  const swap = swapGroups.reduce((tightest, g) => !tightest || g.swapLimit < tightest.swapLimit ? g : tightest, null);
  const cpus = +Math.min(system.cpus().length || 1, ...groups.flatMap((g) => [g.cpuLimit, g.cpuSet].filter((n) => n !== null))).toFixed(2);
  const parsedLoad = loadText.trim().split(/\s+/).slice(0, 3).map((n) => n === '' ? NaN : Number(n));
  const load = parsedLoad.length === 3 && parsedLoad.every((n) => Number.isFinite(n) && n >= 0) ? parsedLoad : system.loadavg();
  const pressureRows = await Promise.all(['cpu', 'memory', 'io'].map(async (name) => {
    const local = directories.length ? await read(path.join(directories[0], `${name}.pressure`)) : '';
    return pressure(local || await read(path.join(procRoot, 'pressure', name)));
  }));
  const sample = {
    cpus, ownerIdleMinutes: null,
    memTotalGB: +(total / 2 ** 30).toFixed(1), memFreePercent: free,
    swapTotalMB: swap ? Math.round(swap.swapLimit / 2 ** 20) : memory.swapTotalMB,
    swapUsedMB: swap ? swap.swapUsed === null ? null : Math.round(swap.swapUsed / 2 ** 20) : memory.swapUsedMB,
    load: load.map((n) => +n.toFixed(2)),
    pressure: Object.fromEntries(['cpu', 'memory', 'io'].map((name, i) => [name, pressureRows[i]])),
  };
  if (directories.length) {
    const file = path.join(directories[0], 'cpu.stat');
    const usage = unsigned(/^usage_usec\s+(\d+)$/m.exec(await read(file))?.[1]);
    const previous = samples.get(file);
    if (usage !== null) {
      if (previous && now > previous.at && usage >= previous.usage) {
        sample.cpuTotalSample = (usage - previous.usage) / (now - previous.at) / 10;
        sample.cpuSampleSource = 'cgroup-v2';
      }
      samples.set(file, { at: now, usage });
      if (samples.size > 32) samples.delete(samples.keys().next().value);
    } else samples.delete(file);
  }
  return sample;
}
