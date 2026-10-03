import fs from 'node:fs';
import path from 'node:path';
import { managedFactory, transportFor, inspect, assertOwned, dockerCall, readHealth, configSafetyError } from './factory-core.js';
import { factoryFile, readPrivate, writePrivate, updateFleet, assertVersion, effectiveMinimum, VOLUMES } from './factory-store.js';
import { isHostUnreachable } from './factory-transport.js';

export const FACTORY_STEPS = Object.freeze(['container', 'volumes', 'herdr', 'service', 'harness-claude', 'harness-codex', 'harness-other', 'github', 'project']);

function safetyError(container, name) {
  if (!container?.State?.Running) return 'The factory container is stopped.';
  return configSafetyError(container, name);
}

async function codexGate(docker, name, enabled) {
  const script = `const {loadPolicy,writePolicy}=await import("/home/factory/herdr-boss/src/control.js");const p=loadPolicy();const was=p.allowedKinds.includes("codex");p.allowedKinds=${enabled ? '[...new Set([...p.allowedKinds,"codex"])]' : 'p.allowedKinds.filter(k=>k!=="codex")'};writePolicy(p,{caller:"cli"});console.log(JSON.stringify({codexWasAllowed:was}));`;
  const raw = await dockerCall(docker, ['exec', '--user', 'factory', `hf-${name}`, 'node', '--input-type=module', '-e', script]);
  try { return JSON.parse(raw); } catch { throw new Error('The Codex safety gate returned no result.'); }
}

async function containerStep(docker, name, flow) {
  const container = await inspect(docker, 'container', `hf-${name}`);
  if (!container) { flow.codexEnabled = false; throw new Error('The factory container is missing.'); }
  assertOwned(container, name);
  const error = safetyError(container, name);
  if (error) {
    flow.codexEnabled = false;
    if (!container.State?.Running) throw new Error(error);
    const result = await codexGate(docker, name, false);
    flow.codexDisabledByWizard ||= result.codexWasAllowed === true;
    throw new Error(error);
  }
  if (flow.codexDisabledByWizard) { await codexGate(docker, name, true); flow.codexDisabledByWizard = false; }
  flow.codexEnabled = true;
}

async function serviceStep(docker, name, fleet, record) {
  // Set the public factory hostname. Do not read or copy a credential.
  const script = 'const fs=require("fs");const file="/home/factory/.herdr-boss/config.json";const c=JSON.parse(fs.readFileSync(file,"utf8"));const host=process.argv[1];const changed=!(c.allowedHosts||[]).includes(host);if(changed){c.allowedHosts=[...new Set([...(c.allowedHosts||[]),host])];fs.writeFileSync(file+".factory.tmp",JSON.stringify(c)+"\\n",{mode:0o600});fs.renameSync(file+".factory.tmp",file);}console.log(JSON.stringify({changed}));';
  const result = JSON.parse(await dockerCall(docker, ['exec', '--user', 'factory', `hf-${name}`, 'node', '-e', script, `${name}.localhost`]));
  const hostnameProbe = () => docker.run(['exec', `hf-${name}`, 'curl', '-sS', '--max-time', '5', '-o', '/dev/null', '-w', '%{http_code}', '--header', `Host: ${name}.localhost`, 'http://127.0.0.1:4477/api/health']);
  const allowed = (probe) => probe.code === 0 && ['200', '401'].includes(probe.stdout.trim());
  let probe = await hostnameProbe();
  if (result.changed || !allowed(probe)) await dockerCall(docker, ['exec', `hf-${name}`, '/command/s6-svc', '-r', '/run/service/herdr-boss-serve']);
  // A named host still requires authentication. Measure health through container loopback.
  const health = await readHealth(docker, name);
  probe = await hostnameProbe();
  if (!allowed(probe)) throw new Error('The service does not accept the factory hostname.');
  if (health.herdrReachable !== true) throw new Error('The service cannot reach its Herdr server.');
  assertVersion(health.version, effectiveMinimum(fleet));
  record.version = health.version;
  record.kitRevision = health.kitRevision;
  return { health, hostnameStatus: Number(probe.stdout.trim()) };
}

function ownerText(name, remote) {
  const docker = remote ? 'docker --context <context from the private connection store>' : 'docker';
  return `# Factory ${name}: Owner logins\n\nUse an Owner terminal. Run these commands on the host tool machine. Keep codes and tokens out of agent panes, reports, and the Mailbox.\n\n1. Run \`${docker} exec -it --user factory hf-${name} claude auth login\`.\n2. Run \`${docker} exec -it --user factory hf-${name} codex login --device-auth\`.\n3. Run \`${docker} exec -it --user factory hf-${name} opencode auth login\`.\n4. Run \`${docker} exec -it --user factory hf-${name} gh auth login\`.\n\nHarness verification and project setup are pending in this slice. The wizard checks the container, volumes, Herdr server, and service only. The Boss can post this file as one Mailbox item. Do not send a credential in an answer.\n`;
}

export async function configureFactory(args, io) {
  const name = args[0];
  let through = 'service';
  let ownerWait = true;
  const seen = new Set();
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    if (seen.has(option)) throw new Error('Use each wizard option once.');
    seen.add(option);
    if (option === '--resume') continue;
    if (option === '--step') {
      through = args[++index];
      if (!FACTORY_STEPS.includes(through)) throw new Error('The wizard step is unknown.');
      ownerWait = FACTORY_STEPS.indexOf(through) >= 4;
      continue;
    }
    throw new Error('Use factory configure NAME [--resume] [--step STEP].');
  }
  const { fleet, record, host } = managedFactory(io.env, name);
  const docker = transportFor(host, io);
  const file = factoryFile(io.env, name, 'flow.json');
  const flow = readPrivate(file, { schema: 1, name, state: 'pending', codexEnabled: false, steps: FACTORY_STEPS.map((step) => ({ name: step, status: 'pending', detail: '' })) });
  if (flow.schema !== 1 || flow.name !== name || !Array.isArray(flow.steps) || flow.steps.length !== FACTORY_STEPS.length || flow.steps.some((step, index) => step.name !== FACTORY_STEPS[index])) throw new Error('The factory flow record is invalid.');
  flow.state = 'running';
  const end = Math.min(3, FACTORY_STEPS.indexOf(through));
  for (let index = 0; index <= end; index += 1) {
    const step = flow.steps[index];
    step.status = 'running';
    writePrivate(file, flow);
    try {
      if (step.name === 'container') await containerStep(docker, name, flow);
      if (step.name === 'volumes') {
        for (const kind of Object.keys(VOLUMES)) {
          const volume = await inspect(docker, 'volume', `hf-${name}-${kind}`);
          if (!volume) throw new Error('A factory volume is missing.');
          assertOwned(volume, name);
        }
      }
      if (step.name === 'herdr') {
        const value = JSON.parse(await dockerCall(docker, ['exec', '--user', 'factory', `hf-${name}`, 'herdr', 'pane', 'list']));
        if (!Array.isArray(value.result?.panes)) throw new Error('The Herdr server did not return a pane list.');
      }
      if (step.name === 'service') {
        const { health, hostnameStatus } = await serviceStep(docker, name, fleet, record);
        step.health = { route: '/api/health', status: 200, version: health.version, kitRevision: health.kitRevision };
        step.hostname = { name: `${name}.localhost`, status: hostnameStatus };
        updateFleet(io.env, (current) => {
          const factory = current.factories.find((item) => item.name === name);
          if (!factory) throw new Error('The factory registration is missing.');
          factory.version = health.version;
          factory.kitRevision = health.kitRevision;
        });
      }
      step.status = 'done';
      step.detail = 'The check passed.';
      writePrivate(file, flow);
    } catch (error) {
      step.status = 'failed';
      step.detail = error.message;
      flow.state = isHostUnreachable(error) ? 'host-unreachable' : 'failed';
      writePrivate(file, flow);
      io.stderr.write(`Factory ${name}: ${step.name} failed. ${error.message}\n`);
      return 1;
    }
  }
  if (!ownerWait) {
    flow.state = through === 'service' ? 'service-ready' : 'checked';
    writePrivate(file, flow);
    io.stdout.write(`Factory ${name}: checks through ${through} passed.\n`);
    return 0;
  }
  const instructionFile = path.join(path.dirname(file), 'owner-instructions.md');
  if (!fs.existsSync(instructionFile)) fs.writeFileSync(instructionFile, ownerText(name, host.transport !== 'local'), { mode: 0o600, flag: 'wx' });
  flow.steps[4].status = 'waiting';
  flow.steps[4].detail = 'The Owner must sign in at an Owner terminal.';
  flow.state = 'waiting';
  flow.ownerInstruction = 'owner-instructions.md';
  writePrivate(file, flow);
  io.stdout.write(`Factory ${name}: the service checks passed. Owner logins are pending.\n`);
  return 3;
}
