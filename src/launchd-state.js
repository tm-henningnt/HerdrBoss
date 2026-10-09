// The state of the launchd job of the installed macOS service. A Homebrew node upgrade replaces the binary of a
// registered job, and launchd then keeps the job down until `herdr-boss install` registers it again. The module
// reads `launchctl print` text and owns no Herdr Boss code, so the doctor and every command share one rule.
import { execFile } from 'node:child_process';
import net from 'node:net';

export const SERVICE_LABEL = 'no.tallmaker.herdr-boss';
// The one line that names the problem and the repair. The doctor prints it as the fix of the service item.
export const LAUNCHD_NODE_FIX = 'Homebrew replaced node: run herdr-boss install';
// The notice runs inside a command, so both probes stay short. A timeout prints nothing.
export const LAUNCHD_PROBE_TIMEOUT_MS = 1000;

// Read the text of `launchctl print` for the job of the current user. A failure rejects, so the caller prints
// nothing.
export function launchctlPrint({ uid = process.getuid?.() ?? 0, label = SERVICE_LABEL, timeout = LAUNCHD_PROBE_TIMEOUT_MS, exec = execFile } = {}) {
  return new Promise((resolve, reject) => {
    exec('launchctl', ['print', `gui/${uid}/${label}`], { timeout, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(typeof stdout === 'string' ? stdout : String(stdout ?? ''));
    });
  });
}

// Report whether something answers on the dashboard port of the loopback interface. A closed port fails at once.
export function dashboardAnswers({ port = 4477, timeout = LAUNCHD_PROBE_TIMEOUT_MS, host = '127.0.0.1', connect = net.connect } = {}) {
  return new Promise((resolve) => {
    let socket;
    try { socket = connect({ host, port }); }
    catch { resolve(false); return; }
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

// Read the launchd text and report whether a replaced node binary stopped the job. Return true when the job is not
// running and shows exit code 78 (EX_CONFIG) or an LWCR note, or when the registered program is another node path.
// Return false for a healthy job, for text without these markers, and for a value that is not text.
export function launchdNodeProblem(printOutput, { installedNode } = {}) {
  const output = typeof printOutput === 'string' ? printOutput : '';
  if (!output.trim()) return false;
  // A running job with these markers still serves. Only a job that is not running needs the install.
  const running = /\bstate = running\b/.test(output);
  if (!running && (/\blast exit code = 78\b/.test(output) || /\bneeds LWCR update\b/.test(output))) return true;
  // A versioned path such as .../Cellar/node/<version>/bin/node does not survive a Homebrew upgrade.
  const node = typeof installedNode === 'string' ? installedNode.trim() : '';
  if (!node) return false;
  const program = /^[ \t]*program = (.+)$/m.exec(output);
  return program ? program[1].trim() !== node : false;
}

// Return the repair line, or an empty string. The caller prints the line once. A probe that throws or times out
// lands in the catch, so the check prints nothing and changes no exit code.
export async function launchdNodeNotice({ launchctl = launchctlPrint, probe = dashboardAnswers, installedNode = process.execPath, timeout = LAUNCHD_PROBE_TIMEOUT_MS, port = 4477 } = {}) {
  try {
    // An answer from the dashboard means that the job runs. Do not read launchctl then.
    if (await probe({ timeout, port })) return '';
    return launchdNodeProblem(await launchctl({ timeout }), { installedNode }) ? LAUNCHD_NODE_FIX : '';
  } catch {
    return '';
  }
}
