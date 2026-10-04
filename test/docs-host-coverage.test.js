import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STEP_NAMES = [
  'BIOS',
  'Update Windows',
  'Never sleep',
  'Active hours',
  'Install WSL',
  'Install Ubuntu',
  'Turn on systemd',
  'Limit memory and CPU',
  'Add the Docker repository',
  'Install Docker',
  'Configure and test Docker',
  'Put the Mac on Tailscale',
  'Turn on MagicDNS and HTTPS',
  'Write the access policy',
  'Install Tailscale in Ubuntu',
  'Make the SSH key on the Mac',
  'Add the public key to Ubuntu',
  'Install the SSH server',
  'Let SSH start after Tailscale',
  'Tell the Mac which key to use',
  'Create the boot task',
  'Test from the Mac',
  'Reboot test',
  'Collect the machine facts',
  'Answers and table',
];

function sourceLine(file, marker) {
  const lines = fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/);
  const index = lines.findIndex((line) => line.includes(marker));
  return index === -1 ? 1 : index + 1;
}

function decodeHtml(text) {
  return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

test('the Add a host page lists H1 to H15 and all 25 Windows step names', async (t) => {
  const dataPath = path.join(root, 'public/host-guide-data.js');
  const viewPath = path.join(root, 'public/host-guide-view.js');
  if (!fs.existsSync(dataPath) || !fs.existsSync(viewPath)) {
    t.skip('The Add a host page does not exist yet; it will be checked when its page source is added.');
    return;
  }

  const [{ pageHtml }, { HOST_CHECKS }] = await Promise.all([
    import('../public/host-guide-view.js'),
    import('../public/host-guide-data.js'),
  ]);
  const model = {
    screen: 'guide',
    guide: { type: 'windows-wsl2', label: 'sample-host', values: {}, done: {}, checks: {}, terminate: null, reboot: null },
    checks: [],
    hosts: [],
    local: true,
    message: '',
    answers: false,
    busy: '',
  };
  const html = pageHtml(model);
  const actualNames = [...html.matchAll(/<li class="hg-step"[^>]*>[\s\S]*?<h3>([\s\S]*?)<\/h3>/g)].map((match) => decodeHtml(match[1]));
  const dataLocation = `public/host-guide-data.js:${sourceLine('public/host-guide-data.js', 'export const HOST_TYPES')}`;
  const stepViewLocation = `public/host-guide-view.js:${sourceLine('public/host-guide-view.js', 'steps.map((step, index) => stepHtml')}`;
  assert.deepEqual(actualNames, STEP_NAMES, `${dataLocation} and ${stepViewLocation}: the rendered Windows step names must match the 25 names in the docs plan`);

  const actualChecks = [...html.matchAll(/<li id="h(\d+)"><strong>H\1<\/strong>/g)].map((match) => Number(match[1]));
  const checkLocation = `public/host-guide-data.js:${sourceLine('public/host-guide-data.js', 'export const HOST_CHECKS')}`;
  const checkViewLocation = `public/host-guide-view.js:${sourceLine('public/host-guide-view.js', 'HOST_CHECKS.map((check) =>')}`;
  const expectedChecks = Array.from({ length: 15 }, (_, index) => index + 1);
  assert.deepEqual(actualChecks, expectedChecks, `${checkLocation} and ${checkViewLocation}: the rendered Add a host page must list H1 to H15`);

  const sourceIds = HOST_CHECKS.map((check) => check.id);
  assert.deepEqual(sourceIds, expectedChecks.map((number) => `H${number}`), `${checkLocation}: every host check must be present in order`);
});
