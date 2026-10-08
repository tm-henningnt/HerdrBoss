import { createInterface } from 'node:readline';
import { isHerdrPane, verifyNightCaller } from './cli.js';
import { assertName } from './factory-store.js';
import { managedFactory, transportFor, inspect, assertOwned, configSafetyError, dockerCall } from './factory-core.js';

const SERVICE = '/run/service/herdr-boss-serve';
const TOKEN_USAGE = 'Usage: herdr-boss factory token NAME [--rotate]';

// Send this function over stdin. The factory image needs no new module to run the command.
// Every failure returns a fixed stage code. No filesystem or child-process error leaves the factory.
export async function factoryTokenFiles(phase, name, caller, rotate) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { randomBytes, randomUUID } = await import('node:crypto');
  const privateDir = '/home/factory/.config/herdr-boss';
  const dataDir = '/home/factory/.herdr-boss';
  const auditFile = path.join(privateDir, 'factory-token-audit.jsonl');
  const sessions = path.join(privateDir, 'sessions.json');
  const configFile = path.join(dataDir, 'config.json');
  let changed = false;
  let stage = 'config';
  const time = () => new Date().toISOString();
  const audit = (result) => {
    fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    const fd = fs.openSync(auditFile, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try {
      if (!fs.fstatSync(fd).isFile()) throw new Error();
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, `${JSON.stringify({ time: time(), factory: name, action: rotate ? 'rotate' : 'read', caller, result })}\n`);
    } finally { fs.closeSync(fd); }
  };
  try {
    if (!['prepare', 'finish', 'failed'].includes(phase) || !['owner', 'boss'].includes(caller) || caller === 'boss' && !rotate) return { ok: false, changed, stage: 'caller' };
    if (phase === 'failed') { stage = 'audit'; audit('failed'); return { ok: true }; }
    let config = {};
    try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error();
    let tokenFile = config.access?.tokenFile ?? path.join(privateDir, 'access-token');
    if (typeof tokenFile !== 'string' || !tokenFile || tokenFile.includes('\0')) throw new Error();
    // loadConfig also treats the old data-directory default as the private default.
    if (tokenFile === path.join(dataDir, 'access-token')) tokenFile = path.join(privateDir, 'access-token');
    tokenFile = path.resolve('/home/factory/herdr-boss', tokenFile);
    if ([auditFile, sessions, configFile].includes(tokenFile)) throw new Error();
    if (phase === 'prepare') {
      stage = 'audit'; audit('attempt');
      if (rotate) {
        stage = 'write';
        fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
        const temporary = `${tokenFile}.${randomUUID()}.tmp`;
        let fd;
        try {
          fd = fs.openSync(temporary, 'wx', 0o600);
          fs.fchmodSync(fd, 0o600);
          fs.writeFileSync(fd, `${randomBytes(32).toString('hex')}\n`);
          fs.fsyncSync(fd);
          fs.closeSync(fd); fd = undefined;
          fs.renameSync(temporary, tokenFile);
          changed = true;
        } finally {
          if (fd !== undefined) fs.closeSync(fd);
          fs.rmSync(temporary, { force: true });
        }
        stage = 'sessions'; fs.rmSync(sessions, { force: true });
      }
      return { ok: true, changed };
    }
    let token;
    if (caller === 'owner') {
      stage = 'read';
      token = fs.readFileSync(tokenFile, 'utf8').trim();
      if (!token || token.length > 4096 || /[\s\x00-\x1f\x7f]/.test(token)) throw new Error();
    }
    stage = 'audit'; audit('ok');
    return { ok: true, time: time(), ...(caller === 'owner' ? { token } : {}) };
  } catch { return { ok: false, changed, stage }; }
}

// A 200 from the old process is not enough. Wait for a new supervised PID before testing health.
export async function waitForTokenDashboard(oldPid, { timeoutMs = 30_000, run, now = Date.now, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (!run) {
    const { execFile } = await import('node:child_process');
    run = (file, args, timeout) => new Promise((resolve, reject) => {
      execFile(file, args, { timeout, maxBuffer: 4096 }, (error, stdout) => error ? reject(new Error('Service check failed.')) : resolve(stdout));
    });
  }
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    try {
      const pid = String(await run('/command/s6-svstat', ['-o', 'pid', '/run/service/herdr-boss-serve'], Math.max(1, deadline - now()))).trim();
      if (/^[1-9][0-9]*$/.test(pid) && pid !== oldPid && now() < deadline) {
        const status = await run('curl', ['--max-time', '2', '--silent', '--output', '/dev/null', '--write-out', '%{http_code}', 'http://127.0.0.1:4477/api/health'], Math.max(1, Math.min(2500, deadline - now())));
        if (String(status).trim() === '200' && now() < deadline) return { ok: true };
      }
    } catch { /* A restarting service may not answer yet. */ }
    if (now() < deadline) await delay(Math.min(200, deadline - now()));
  }
  return { ok: false };
}

function recovery(name, changed) {
  return `The token file ${changed ? 'changed' : 'may have changed'}. The new token is not printed.\nOpen an Owner terminal and run herdr-boss factory shell ${name}.\nIn the factory shell, run /command/s6-svc -r ${SERVICE}.\nThen run curl --retry 30 --retry-connrefused --retry-delay 1 --fail --silent --show-error --output /dev/null http://127.0.0.1:4477/api/health.\nExit the factory shell. Then run herdr-boss factory token ${name} at the Owner terminal.\nSee docs/guide/factory.md#recover-an-incomplete-token-rotation.`;
}

export async function factoryTokenCommand(args, io) {
  const positional = [];
  let rotate = false;
  for (const word of args) {
    if (word === '--rotate' && !rotate) rotate = true;
    else if (word.startsWith('-')) throw new Error(`Invalid factory token option.\n${TOKEN_USAGE}`);
    else positional.push(word);
  }
  if (positional.length !== 1) throw new Error(`Give exactly one factory name.\n${TOKEN_USAGE}`);
  const [name] = positional; assertName(name);
  if (!io.stdin?.isTTY || !io.stdout?.isTTY) throw new Error('Use a terminal with TTYs on stdin and stdout for factory token.');
  if (isHerdrPane(io.env) && (!io.env.HERDR_PANE_ID || !io.env.HERDR_WORKSPACE_ID)) throw new Error('Cannot verify the caller pane: both pane and workspace IDs are required.');
  let herdr = io.herdr;
  if (!herdr && isHerdrPane(io.env)) {
    const { createHerdrRunner } = await import('./kit/workers.js');
    herdr = createHerdrRunner();
  }
  let caller;
  try { caller = await verifyNightCaller(io.env, herdr); }
  catch { throw new Error('Cannot verify the caller. Only the Owner terminal or the verified Boss pane can run factory token.'); }
  if (caller.role === 'boss' && !rotate) throw new Error('The Boss may run factory token only with --rotate. Read the token at an Owner terminal.');
  const factory = managedFactory(io.env, name);
  io.stderr.write(`Type the factory name ${name} to confirm: `);
  const lines = createInterface({ input: io.stdin, crlfDelay: Infinity });
  let answer;
  try { for await (const line of lines) { answer = line; break; } } finally { lines.close(); }
  if (answer !== name) throw new Error('The typed factory confirmation does not match.');
  const docker = transportFor(factory.host, io);
  const container = await inspect(docker, 'container', factory.record.containerName);
  if (!container) throw new Error('The factory container is missing.');
  assertOwned(container, name);
  const unsafe = configSafetyError(container, name, factory.host.codexSandbox);
  if (unsafe) throw new Error(unsafe);
  if (!container.State?.Running || container.State?.Paused) throw new Error('The factory must be running and not paused.');
  const filesScript = `${factoryTokenFiles.toString()}\nconst [phase, name, caller, action] = process.argv.slice(2);\nconst result = await factoryTokenFiles(phase, name, caller, action === 'rotate');\nprocess.stdout.write(JSON.stringify(result));\n`;
  const files = async (phase) => {
    const result = await docker.run(['exec', '--interactive', '--user', 'factory', '--workdir', '/home/factory/herdr-boss', factory.record.containerName, 'node', '--input-type=module', '-', phase, name, caller.role, rotate ? 'rotate' : 'read'], { input: filesScript, timeout: 15_000 });
    if (result.code !== 0) throw new Error('The factory token file operation did not finish.');
    try { return JSON.parse(result.stdout); } catch { throw new Error('The factory token result is invalid.'); }
  };
  let mayHaveChanged = false;
  let changed = false;
  let attempted = false;
  let failure = 'The factory token transport or dashboard service check failed.';
  try {
    let oldPid;
    if (rotate) {
      oldPid = (await dockerCall(docker, ['exec', factory.record.containerName, '/command/s6-svstat', '-o', 'pid', SERVICE])).trim();
      if (!/^[1-9][0-9]*$/.test(oldPid)) {
        failure = 'The factory dashboard service has no running PID.';
        throw new Error();
      }
    }
    attempted = true;
    // A lost transport result cannot prove that the atomic write did not happen.
    mayHaveChanged = rotate;
    const prepared = await files('prepare');
    changed = prepared.changed === true;
    mayHaveChanged = changed;
    if (prepared.ok !== true) {
      const stages = { config: 'configuration', audit: 'attempt audit', write: 'atomic write', sessions: 'session removal' };
      failure = `The factory token ${stages[prepared.stage] || 'file operation'} failed.`;
      throw new Error();
    }
    if (rotate) {
      await dockerCall(docker, ['exec', factory.record.containerName, '/command/s6-svc', '-r', SERVICE]);
      const healthScript = `${waitForTokenDashboard.toString()}\nprocess.stdout.write(JSON.stringify(await waitForTokenDashboard(process.argv[2])));\n`;
      const result = await docker.run(['exec', '--interactive', factory.record.containerName, 'node', '--input-type=module', '-', oldPid], { input: healthScript, timeout: 35_000 });
      let healthy = false;
      try { healthy = result.code === 0 && JSON.parse(result.stdout)?.ok === true; } catch {}
      if (!healthy) { failure = 'The factory dashboard health wait timed out.'; throw new Error(); }
    }
    const finished = await files('finish');
    if (finished.ok !== true || !/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(finished.time) || caller.role === 'owner' && (typeof finished.token !== 'string' || !finished.token || /[\s\x00-\x1f\x7f]/.test(finished.token))) {
      failure = 'The factory token read or result audit failed.';
      throw new Error();
    }
    if (caller.role === 'owner') io.stdout.write(`${finished.token}\n`);
    else io.stdout.write(`${name} ${finished.time} signed out all devices\n`);
    return 0;
  } catch {
    if (attempted) { try { await files('failed'); } catch {} }
    // Discard untrusted transport and output-writer errors; they can contain token text.
    const message = mayHaveChanged ? `${failure}\n${recovery(name, changed)}` : failure;
    throw new Error(message);
  }
}
