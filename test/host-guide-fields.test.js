import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIELDS, FIELD_IDS, HOST_NAME, HOST_USER, checkField, normalizeField, substitute, missingPlaceholders, registryEntry, summaryTable, effectiveValues, fieldsFor, PLACEHOLDERS } from '../public/host-guide-fields.js';
import { HOST_TYPES, STEPS, HOST_CHECKS, GLOSSARY } from '../public/host-guide-data.js';
import { hostGuideHint, HOST_GUIDE_PATH } from '../src/host-guide-link.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
// Invented values. They belong to no real host.
const FINGERPRINT = `SHA256:${'A'.repeat(43)}`;
const GOOD = {
  label: 'build-box', role: 'factory', user: 'factory', distro: 'Ubuntu', tailnetName: 'build-box.example-tailnet.ts.net', tailscaleAddress: '100.64.0.10',
  macName: 'my-mac', alias: 'build-box', keyName: 'build-box-key', fingerprint: FINGERPRINT, context: 'hf-build-box', ubuntuVersion: '24.04',
  dockerVersion: '28.0.1', tailscaleVersion: '1.80.2', wslVersion: '2.4.8.0', memoryGb: '48', cpuCount: '16', swapGb: '8', windowsAccount: 'owner', tailscaleAccount: 'owner@example.com',
};

test('every field accepts its example value and refuses a value in the wrong format', () => {
  assert.deepEqual(Object.keys(GOOD).sort(), [...FIELD_IDS].sort(), 'the fixture covers each field');
  for (const [id, value] of Object.entries(GOOD)) assert.deepEqual(checkField(id, value), { ok: true, message: '' }, id);
  const bad = {
    label: ['Build', 'a b', '-x', 'local', 'x'.repeat(32)], role: ['Factory', '1x'], user: ['1user', 'a b', 'x'.repeat(33)],
    distro: ['a b', '-x'], tailnetName: ['build-box', 'build-box.example.com', 'BUILD.example.ts.net', 'a b.ts.net'], tailscaleAddress: ['10.0.0.1', '100.128.0.1', '100.64.0'],
    macName: ['My Mac', 'Mac_1'], alias: ['A', 'a b'], keyName: ['a/b', 'a.b', 'a b', '../x'], fingerprint: ['SHA256:short', 'MD5:aa:bb', 'abc'], context: ['a b', '-x'],
    ubuntuVersion: ['24', '24.4', 'noble'], dockerVersion: ['28', '28.0', 'v28.0.1'], tailscaleVersion: ['1.80', 'x'], wslVersion: ['2', '2.4', 'x.y.z'],
    memoryGb: ['0', '-1', '1.5', '2000', 'abc', '48GB'], cpuCount: ['0', '513', 'x'], swapGb: ['-1', '1025', 'x'], windowsAccount: ['a b', 'a\\b', 'x'.repeat(21)], tailscaleAccount: ['owner', 'a@b', 'a b@example.com', '@example.com'],
  };
  for (const id of FIELD_IDS) assert.ok(bad[id]?.length, `${id} has bad examples`);
  for (const [id, values] of Object.entries(bad)) for (const value of values) {
    const result = checkField(id, value);
    assert.equal(result.ok, false, `${id}: ${value}`);
    assert.ok(result.message.length > 0 && result.message.length < 220, `${id} message`);
  }
});

test('an empty value is ok, so a field is optional until the registry entry', () => {
  for (const id of FIELD_IDS) assert.deepEqual(checkField(id, ''), { ok: true, message: '' });
});

test('every field refuses a secret and the message says so', () => {
  const secrets = ['-----BEGIN OPENSSH PRIVATE KEY-----', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexample', 'tskey-auth-abc123', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'AKIAABCDEFGHIJKLMNOP', 'my PRIVATE KEY text'];
  for (const id of FIELD_IDS) for (const secret of secrets) {
    const result = checkField(id, secret);
    assert.equal(result.ok, false, `${id}: ${secret.slice(0, 12)}`);
    assert.match(result.message, /secret/i);
    assert.equal(result.message.includes(secret), false, 'the message never repeats the value');
  }
});

test('the fingerprint field keeps the SHA256 part of an ssh-keygen line', () => {
  const line = `256 ${FINGERPRINT} herdr-factory-build-box (ED25519)`;
  assert.deepEqual(checkField('fingerprint', line), { ok: true, message: '' });
  assert.equal(normalizeField('fingerprint', line), FINGERPRINT);
  assert.equal(normalizeField('fingerprint', `  ${FINGERPRINT}\n`), FINGERPRINT);
  assert.equal(checkField('fingerprint', 'x'.repeat(5000)).ok, false);
});

test('a value that a command can hold has no character that a shell treats as special', () => {
  const hostile = ['a;b', 'a b', '$(id)', '`id`', 'a&&b', 'a|b', "a'b", 'a"b', 'a\nb', 'a>b', 'a<b', '${x}', 'a\\b', '*', 'a#b', '!x'];
  const used = new Set(Object.values(PLACEHOLDERS));
  assert.ok(used.size >= 10);
  for (const id of used) for (const value of hostile) assert.equal(checkField(id, value).ok, false, `${id}: ${JSON.stringify(value)}`);
});

test('the label and user rules match the host registry of the host tool', async () => {
  const host = await import('../src/factory-host.js');
  assert.equal(HOST_NAME.source, host.HOST_NAME.source);
  assert.equal(HOST_USER.source, host.HOST_USER.source);
});

test('substitute fills a placeholder with a valid value and leaves a missing or invalid one visible', () => {
  const text = 'ssh <HOST_ALIAS> then <CONTEXT> for <FACTORY_USER> and <HOST_FQDN> and <WORKER>';
  assert.equal(substitute(text, GOOD), 'ssh build-box then hf-build-box for factory and build-box.example-tailnet.ts.net and build-box');
  assert.equal(substitute(text, {}), text);
  assert.equal(substitute('<HOST_FQDN>', { tailnetName: 'bad name; rm -rf /' }), '<HOST_FQDN>', 'an invalid value never reaches a command');
  assert.equal(substitute('x <NOT_A_FIELD> y', GOOD), 'x <NOT_A_FIELD> y');
  assert.deepEqual(missingPlaceholders(text, { label: 'build-box' }).sort(), ['FACTORY_USER', 'HOST_FQDN']);
  assert.deepEqual(effectiveValues({ label: 'x' }), { label: 'x', alias: 'x', context: 'hf-x' });
  assert.equal(substitute('<HOST>', { label: 'x' }), 'x');
});

test('the registry entry has the fields of `factory host add` and no secret', () => {
  const entry = registryEntry(GOOD, 'docker-engine-wsl2');
  assert.equal(entry.complete, true);
  assert.deepEqual(entry.missing, []);
  assert.equal(entry.command, 'herdr-boss factory host add build-box --from-file -');
  assert.deepEqual(JSON.parse(entry.json), { address: 'build-box.example-tailnet.ts.net', user: 'factory', keyFile: '~/.ssh/herdr-factory/build-box-key', dockerContext: 'hf-build-box', runtime: 'docker-engine-wsl2' });
  assert.equal(entry.next, 'herdr-boss factory new <NAME> --host build-box');
  const partial = registryEntry({ label: 'build-box' }, 'orbstack');
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.missing, ['tailnetName', 'user', 'keyName']);
  assert.match(partial.json, /<HOST_FQDN>/);
});

test('the summary table has one row for each value of step 25 and hides nothing that is missing', () => {
  const table = summaryTable(GOOD, 'windows-wsl2');
  const rows = table.split('\n').slice(2).map((line) => line.split('|')[1].trim());
  assert.deepEqual(rows, ['Machine label', 'Role', 'User', 'Tailnet name', 'Tailscale address', 'Key fingerprint', 'Versions', 'Memory and CPU limits', 'Account names']);
  assert.match(table, /\| Versions \| Ubuntu 24\.04, Docker 28\.0\.1, Tailscale 1\.80\.2, WSL 2\.4\.8\.0 \|/);
  assert.match(table, /\| Memory and CPU limits \| 48 GB memory, 16 threads, 8 GB swap \|/);
  assert.match(summaryTable({}, 'linux'), /\| Role \| not set \|/);
  assert.doesNotMatch(summaryTable(GOOD, 'linux'), /WSL|swap/);
  assert.ok(fieldsFor('mac-orbstack').every((field) => !field.types || field.types.includes('mac-orbstack')));
});

test('the host types are Windows with WSL2 first, then Linux, then Mac with OrbStack', () => {
  assert.deepEqual(HOST_TYPES.map((type) => type.id), ['windows-wsl2', 'linux', 'mac-orbstack']);
  assert.deepEqual(HOST_TYPES.map((type) => type.runtime), ['docker-engine-wsl2', 'docker-engine', 'orbstack']);
  for (const type of HOST_TYPES) {
    assert.ok(STEPS[type.id].length >= 13, type.id);
    assert.equal(new Set(STEPS[type.id].map((step) => step.id)).size, STEPS[type.id].length, 'step ids are unique');
    assert.equal(STEPS[type.id].at(-1).id, 'answers');
  }
});

test('the Windows step names are the step names of docs/windows-host.md, in the same order', () => {
  const docs = [...read('docs/windows-host.md').matchAll(/^## Step (\d+): (.+)$/gm)].map((match) => [Number(match[1]), match[2].trim()]);
  assert.equal(docs.length, 25);
  assert.deepEqual(STEPS['windows-wsl2'].map((step) => step.name), docs.map((row) => row[1]));
  assert.deepEqual(docs.map((row) => row[0]), docs.map((_, index) => index + 1));
});

test('every step has what, why, an expected result, and three errors with a fix', () => {
  const sentences = [];
  for (const type of HOST_TYPES) for (const step of STEPS[type.id]) {
    for (const key of ['name', 'where', 'what', 'why', 'expected']) assert.ok(typeof step[key] === 'string' && step[key].length > 0, `${step.id} ${key}`);
    assert.equal(step.errors.length, 3, `${step.id} has three errors`);
    for (const e of step.errors) { assert.ok(e.problem && e.fix, step.id); sentences.push(e.problem, e.fix); }
    sentences.push(step.what, step.why, step.expected, step.warning || '', ...(step.list || []));
  }
  // Short sentences (ASD-STE100): at most 25 words in a sentence of description.
  for (const text of sentences) for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const words = sentence.replace(/`[^`]*`/g, 'X').split(/\s+/).filter(Boolean).length;
    assert.ok(words <= 25, `too long (${words} words): ${sentence}`);
  }
});

test('the 15 host checks H1 to H15 are in the data, and each Windows check has a step', () => {
  assert.deepEqual(HOST_CHECKS.map((check) => check.id), Array.from({ length: 15 }, (_, index) => `H${index + 1}`));
  const ids = new Set(STEPS['windows-wsl2'].map((step) => step.id));
  for (const check of HOST_CHECKS) { assert.ok(ids.has(check.step), check.id); assert.ok(check.text.length > 10); }
  const tagged = new Set(STEPS['windows-wsl2'].flatMap((step) => step.h || []));
  for (let n = 1; n <= 15; n += 1) assert.ok(tagged.has(`H${n}`), `a step carries H${n}`);
});

test('the glossary explains WSL, systemd, Tailscale, SSH key, and Docker context', () => {
  assert.deepEqual(GLOSSARY.map((entry) => entry.term), ['WSL', 'systemd', 'Tailscale', 'SSH key', 'Docker context']);
  for (const entry of GLOSSARY) assert.ok(entry.text.length > 20 && entry.text.length < 200);
});

const normalize = (text) => text.replace(/<([A-Z][A-Z_]*)>/g, '$1').replace(/\r/g, '');

test('each command of the Windows list is in docs/windows-host.md, unless the step data marks it as its own', () => {
  const doc = normalize(read('docs/windows-host.md'));
  const allowed = [/^memory=MEMORY_GBGB$/, /^swap=SWAP_GBGB$/];
  let checked = 0;
  for (const step of STEPS['windows-wsl2']) for (const command of step.commands || []) {
    if (command.own) continue;
    for (const line of normalize(command.text).split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (allowed.some((rule) => rule.test(line))) continue;
      assert.ok(doc.includes(line), `${step.id}: ${line}`);
      checked += 1;
    }
  }
  assert.ok(checked > 60, `checked ${checked} lines`);
});

test('exact command text for the steps that carry the risk', () => {
  const byId = (id) => STEPS['windows-wsl2'].find((step) => step.id === id);
  const filled = (id) => byId(id).commands.map((command) => substitute(command.text, GOOD)).join('\n');
  assert.match(filled('boot-task'), /^-d Ubuntu -u root --exec \/bin\/sh -lc "systemctl start docker ssh tailscaled && exec \/usr\/bin\/sleep infinity"$/);
  assert.match(filled('ssh-config'), /Host build-box\n {2}HostName build-box\.example-tailnet\.ts\.net\n {2}User factory\n {2}IdentityFile ~\/\.ssh\/herdr-factory\/build-box-key\n {2}IdentitiesOnly yes/);
  assert.match(filled('ssh-config'), /docker context create hf-build-box --docker "host=ssh:\/\/build-box"/);
  assert.match(filled('ssh-server'), /PasswordAuthentication no/);
  assert.match(filled('install-wsl'), /^wsl --install --no-distribution\nwsl --update\nwsl --set-default-version 2$/);
  assert.match(filled('limit-memory'), /memory=48GB\nprocessors=16\nswap=8GB\ninstanceIdleTimeout=-1\nvmIdleTimeout=-1/);
  assert.match(filled('access-policy'), /"src": "owner@example\.com"/);
  assert.match(filled('systemd'), /systemctl mask systemd-binfmt\.service/);
  assert.match(filled('configure-docker'), /--label herdr-factory-spike=build-box hello-world/);
  assert.match(byId('docker-repository').warning, /docker system prune/);
  assert.match(byId('docker-repository').warning, /\(H12\)/);
});

test('a warning stands before the commands of each hard-to-undo step', () => {
  const hard = ['never-sleep', 'access-policy', 'ubuntu-tailscale', 'ssh-key', 'ssh-server', 'boot-task', 'reboot-test', 'docker-repository', 'install-docker', 'update-windows'];
  for (const id of hard) assert.ok(STEPS['windows-wsl2'].find((step) => step.id === id)?.warning, id);
  for (const id of ['linux-tailscale', 'linux-reboot-test']) assert.ok(STEPS.linux.find((step) => step.id === id)?.warning, id);
  assert.ok(STEPS['mac-orbstack'].find((step) => step.id === 'host-mac-ssh').warning);
});

test('no host name, address, tailnet name, key, fingerprint, or local path is in the guide files', () => {
  const files = ['public/host-guide-data.js', 'public/host-guide-fields.js', 'public/host-guide.js', 'public/host-guide-view.js', 'src/host-guide.js', 'src/host-guide-link.js', 'docs/help/add-host.md'];
  for (const file of files) {
    const text = read(file);
    assert.doesNotMatch(text, /[a-z0-9-]+\.[a-z0-9-]+\.ts\.net/i, `${file}: a tailnet name`);
    assert.doesNotMatch(text, /\b(?!127\.0\.0\.1\b|100\.64\.0\.0\b|100\.127\.255\.255\b|100\.128\.0\.1\b|100\.64\.0\.10\b|2\.4\.8\.0\b)(?:\d{1,3}\.){3}\d{1,3}\b/, `${file}: an address`);
    assert.doesNotMatch(text, /SHA256:[A-Za-z0-9+/]{43}/, `${file}: a fingerprint`);
    assert.doesNotMatch(text, /\/Users\/|\/home\/[a-z]|C:\\Users\\/i, `${file}: a local path`);
    assert.doesNotMatch(text, /BEGIN [A-Z ]*PRIVATE KEY-----|ssh-ed25519 AAAA[A-Za-z0-9+/]{10}|tskey-[a-z]+-[A-Za-z0-9]{6}|ghp_[A-Za-z0-9]{20}/, `${file}: a secret`);
  }
});

test('the wizard and the factory failure messages link to the guide', () => {
  assert.equal(HOST_GUIDE_PATH, '/fleet/add-host');
  assert.match(hostGuideHint('The factory host is unreachable.', 'build-box'), /Host setup guide: .*\/fleet\/add-host\?host=build-box/);
  assert.match(hostGuideHint('Docker could not start.'), /\/fleet\/add-host/);
  assert.match(hostGuideHint('The host is not in the private connection store.'), /\/fleet\/add-host/);
  assert.equal(hostGuideHint('The factory name is invalid.'), '');
  assert.equal(hostGuideHint('The factory host is unreachable.', 'bad name; x'), hostGuideHint('The factory host is unreachable.'), 'an invalid host name is left out of the link');
  assert.match(read('src/factory-wizard.js'), /hostGuideHint/);
  assert.match(read('src/cli.js'), /hostGuideHint/);
});
