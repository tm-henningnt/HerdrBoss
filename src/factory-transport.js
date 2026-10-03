// Both transports accept Docker arguments and return a captured result. No shell parses an argument.
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import { sshArguments, shellQuote } from './factory-host.js';

export function hostUnreachable() {
  const error = new Error('The factory host is unreachable.');
  error.code = 'FACTORY_HOST_UNREACHABLE';
  return error;
}

export const isHostUnreachable = (error) => ['FACTORY_HOST_UNREACHABLE', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(error?.code);

export function createDockerTransport(host, { spawn = nodeSpawn, env = process.env } = {}) {
  const context = host?.dockerContext;
  if (context !== undefined && (typeof context !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(context))) {
    throw new Error('The Docker context name is invalid.');
  }
  if (host?.transport !== 'local' && !context) throw new Error('The host has no Docker context.');
  // The local host uses the OrbStack context by argument. No DOCKER_HOST or DOCKER_CONTEXT value from the caller reaches Docker.
  const selected = context || (host?.runtime === 'orbstack' ? 'orbstack' : undefined);
  const childEnv = { ...env };
  delete childEnv.DOCKER_HOST;
  delete childEnv.DOCKER_CONTEXT;
  return {
    async run(args, { timeout = context ? 15_000 : 30_000, input, inputFile, outputFile, interactive = false } = {}) {
      return new Promise((resolve, reject) => {
        let child;
        let inputFd, outputFd;
        const closeFiles = () => {
          if (inputFd !== undefined) { fs.closeSync(inputFd); inputFd = undefined; }
          if (outputFd !== undefined) { fs.closeSync(outputFd); outputFd = undefined; }
        };
        try {
          if (inputFile) inputFd = fs.openSync(inputFile, 'r');
          if (outputFile) outputFd = fs.openSync(outputFile, 'wx', 0o600);
          child = spawn('docker', [...(selected ? ['--context', selected] : []), ...args], {
            env: childEnv, shell: false, stdio: interactive ? ['inherit', 'inherit', 'pipe'] : [inputFd ?? (input === undefined ? 'ignore' : 'pipe'), outputFd ?? 'pipe', 'pipe'],
          });
        } catch { closeFiles(); reject(new Error('Docker could not start.')); return; }
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let killTimer;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
        }, timeout);
        child.stdout?.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
        child.once('error', () => { clearTimeout(timer); clearTimeout(killTimer); closeFiles(); reject(new Error('Docker could not start.')); });
        child.once('close', (code) => {
          clearTimeout(timer);
          clearTimeout(killTimer);
          closeFiles();
          if (timedOut) reject(context ? hostUnreachable() : new Error('Docker did not finish before the time limit.'));
          else if (context && code !== 0 && /connection refused|connection timed out|no route to host|network is unreachable|could not resolve|dial tcp|exit status 255/i.test(stderr)) reject(hostUnreachable());
          else resolve({ code: code ?? 1, stdout, stderr });
        });
      });
    },
  };
}

// Capture private provisioning output. The caller prints only public state codes.
export function createHostTransport(host, { spawn = nodeSpawn, env = process.env } = {}) {
  if (!host?.address || !host?.user || !host?.keyFile) throw new Error('The factory connection needs an SSH host record.');
  return { async run(args, { timeout = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      let child;
      try { child = spawn('ssh', sshArguments(host, args.map(shellQuote)), { env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch { reject(hostUnreachable()); return; }
      let stdout = '', stderr = '', expired = false, overflow = false, killTimer;
      const stop = () => { child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 1000); };
      const timer = setTimeout(() => { expired = true; stop(); }, timeout);
      const append = (kind, chunk) => {
        if (kind === 'stdout') stdout += chunk; else stderr += chunk;
        if (!overflow && Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 128 * 1024) { overflow = true; stop(); }
      };
      child.stdout.on('data', (chunk) => append('stdout', chunk));
      child.stderr.on('data', (chunk) => append('stderr', chunk));
      child.once('error', () => { clearTimeout(timer); clearTimeout(killTimer); reject(hostUnreachable()); });
      child.once('close', (code) => {
        clearTimeout(timer); clearTimeout(killTimer);
        if (expired || code === 255) reject(hostUnreachable());
        else if (overflow) reject(new Error('The host result exceeds the size limit.'));
        else resolve({ code: code ?? 1, stdout, stderr });
      });
    });
  } };
}
