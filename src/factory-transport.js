// Both transports accept Docker arguments and return a captured result. No shell parses an argument.
import { spawn as nodeSpawn } from 'node:child_process';

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
  return {
    async run(args, { timeout = context ? 15_000 : 30_000 } = {}) {
      return new Promise((resolve, reject) => {
        let child;
        try {
          child = spawn('docker', [...(context ? ['--context', context] : []), ...args], {
            env: { ...env, ...(context ? { DOCKER_CONTEXT: context } : host?.runtime === 'orbstack' ? { DOCKER_CONTEXT: 'orbstack' } : {}) }, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch { reject(new Error('Docker could not start.')); return; }
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let killTimer;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
        }, timeout);
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.once('error', () => { clearTimeout(timer); clearTimeout(killTimer); reject(new Error('Docker could not start.')); });
        child.once('close', (code) => {
          clearTimeout(timer);
          clearTimeout(killTimer);
          if (timedOut) reject(context ? hostUnreachable() : new Error('Docker did not finish before the time limit.'));
          else if (context && code !== 0 && /connection refused|connection timed out|no route to host|network is unreachable|could not resolve|dial tcp|exit status 255/i.test(stderr)) reject(hostUnreachable());
          else resolve({ code: code ?? 1, stdout, stderr });
        });
      });
    },
  };
}
