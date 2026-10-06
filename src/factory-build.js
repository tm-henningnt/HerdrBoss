import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { updateRegistry } from './factory-host.js';
import { FACTORY_ROOT, dockerCall, inspect } from './factory-core.js';

const runFile = promisify(execFile);

async function git(args, env) {
  try { return (await runFile('git', args, { env, timeout: 60_000, maxBuffer: 1024 * 1024 })).stdout.trim(); }
  catch { throw new Error('The factory build cannot prepare its public seed checkout.'); }
}

// The pins file records the BuildKit image. A digest is used when the file holds one.
function buildkitImage() {
  const { buildkit } = JSON.parse(fs.readFileSync(path.join(FACTORY_ROOT, 'pins.json'), 'utf8'));
  if (!buildkit || !/^[a-z0-9./-]+$/.test(buildkit.image) || !/^[A-Za-z0-9_.-]+$/.test(buildkit.tag) || (buildkit.digest && !/^sha256:[a-f0-9]{64}$/.test(buildkit.digest))) throw new Error('The BuildKit pin is invalid.');
  return `${buildkit.image}:${buildkit.tag}${buildkit.digest ? `@${buildkit.digest}` : ''}`;
}

async function buildContext(io) {
  const dir = fs.mkdtempSync(path.join(io.env.TMPDIR || os.tmpdir(), 'factory-build-'));
  try {
    for (const file of ['Dockerfile', 'pins.json', 'sshd_config', 'rootfs']) fs.cpSync(path.join(FACTORY_ROOT, file), path.join(dir, file), { recursive: true });
    const raw = fs.readFileSync(path.join(FACTORY_ROOT, 'pins.json'));
    const pins = JSON.parse(raw);
    const hashes = Object.entries(pins.sha256 || {});
    if (!hashes.length || hashes.some(([file, hash]) => !/^[A-Za-z0-9_.-]+$/.test(file) || !/^[a-f0-9]{64}$/.test(hash))) throw new Error('The factory pins are invalid.');
    fs.writeFileSync(path.join(dir, 'checksums.txt'), `${hashes.map(([file, hash]) => `${hash}  ${file}`).join('\n')}\n`);
    const repository = path.dirname(FACTORY_ROOT.replace(/\/$/, ''));
    await git(['clone', '--quiet', '--no-hardlinks', repository, path.join(dir, 'seed')], io.env);
    await git(['-C', path.join(dir, 'seed'), 'remote', 'remove', 'origin'], io.env);
    const revision = await git(['-C', path.join(dir, 'seed'), 'rev-parse', 'HEAD'], io.env);
    const args = {
      BASE_IMAGE: `${pins.base.image}:${pins.base.tag}@${pins.base.digest}`,
      S6_VERSION: pins.s6Overlay, NODE_VERSION: pins.node, HERDR_VERSION: pins.herdr, GH_VERSION: pins.gh,
      CLAUDE_CODE_VERSION: pins.claudeCode, CODEX_VERSION: pins.codex, OPENCODE_VERSION: pins.opencode, CODEXBAR_VERSION: pins.codexbar, CHROMIUM_VERSION: pins.chromium,
      PINS_SHA256: createHash('sha256').update(raw).digest('hex'), PINS_JSON: JSON.stringify(pins), BUILD_DATE: new Date().toISOString(), SOURCE_REVISION: revision,
    };
    if (Object.values(args).some((value) => typeof value !== 'string' || !value)) throw new Error('A factory build pin is missing.');
    return { dir, args };
  } catch (error) { fs.rmSync(dir, { recursive: true, force: true }); throw error; }
}

export async function prepareFactoryBuilder(host, docker, io) {
  const builderName = host.builderName || `herdr-factory-${host.hostId}`;
  if (builderName !== `herdr-factory-${host.hostId}`) throw new Error('Use the dedicated factory builder for this host.');
  const containerName = `herdr-factory-buildkit-${host.hostId}`;
  const endpoint = `docker-container://${containerName}`;
  const container = await inspect(docker, 'container', containerName);
  if (container) {
    const labels = container.Config?.Labels || {};
    if (labels['herdr-factory-spike'] !== 'fa1' || labels['herdr-factory-builder'] !== host.hostId) throw new Error('The builder container does not carry this worker label.');
    if (!container.State?.Running) await dockerCall(docker, ['start', containerName]);
  } else await dockerCall(docker, ['run', '-d', '--name', containerName, '--label', 'herdr-factory-spike=fa1', '--label', `herdr-factory-builder=${host.hostId}`, '--privileged', '--cpus', '2', '--memory', '4g', '--memory-swap', '4g', '--pids-limit', '1024', buildkitImage()]);
  const found = await docker.run(['buildx', 'inspect', builderName]);
  if (found.code !== 0) {
    if (!/no builder|not found|no such file or directory/i.test(found.stderr || '')) throw new Error('Docker cannot inspect the factory builder.');
    await dockerCall(docker, ['buildx', 'create', '--name', builderName, '--driver', 'remote', endpoint]);
  } else {
    const actualName = /^Name:\s*(\S+)/m.exec(found.stdout)?.[1];
    const driver = /^Driver:\s*(\S+)/m.exec(found.stdout)?.[1];
    const endpoints = [...found.stdout.matchAll(/^Endpoint:\s*(\S+)/gm)].map((match) => match[1]);
    if (actualName !== builderName || driver !== 'remote' || endpoints.length !== 1 || endpoints[0] !== endpoint) throw new Error('The builder is not the dedicated factory builder.');
  }
  updateRegistry(io.env, (connections) => { connections.hosts[host.hostId] = { ...(connections.hosts[host.hostId] || { transport: 'local' }), builderName }; });
  return builderName;
}

export async function buildFactoryImage(name, imageTag, host, docker, io) {
  const builderName = await prepareFactoryBuilder(host, docker, io);
  const context = await buildContext(io);
  try {
    const args = ['buildx', 'build', '--builder', builderName, '--load', '--label', `herdr-factory=${name}`, '--label', 'herdr-factory-spike=fa1', '-t', imageTag];
    for (const [key, value] of Object.entries(context.args)) args.push('--build-arg', `${key}=${value}`);
    args.push(context.dir);
    io.stdout.write(`Building factory image for ${name}.\n`);
    await dockerCall(docker, args, { timeout: 1_200_000 });
  } finally { fs.rmSync(context.dir, { recursive: true, force: true }); }
}
