import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyCodexbarConfig, codexbarConfigText, codexbarInstallCommand, codexbarPins, codexbarTarget, installCodexbar, parseCodexbarVersion } from '../src/factory-codexbar.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'codexbar-'));

// The pins file: the version and both glibc tarball hashes, in the format that the build script reads.
test('the pins file holds the CodexBar version and the hash of both Linux tarballs', () => {
  const pins = codexbarPins();
  assert.match(pins.version, /^\d+\.\d+\.\d+$/);
  assert.ok(Object.values(pins.hashes).every((hash) => /^[a-f0-9]{64}$/.test(hash)));
  assert.deepEqual(Object.keys(pins.hashes).sort(), ['aarch64', 'x86_64']);
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'factory/pins.json'), 'utf8'));
  assert.equal(raw.codexbar, pins.version);
  for (const [arch, hash] of Object.entries(pins.hashes)) {
    assert.equal(raw.sha256[`CodexBarCLI-v${pins.version}-linux-${arch}.tar.gz`], hash);
    assert.notEqual(hash, '0'.repeat(64));
  }
});

test('the image build and the host build args name the CodexBar pin for both architectures', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'factory/Dockerfile'), 'utf8');
  assert.match(dockerfile, /ARG CODEXBAR_VERSION/);
  assert.match(dockerfile, /CB=CodexBarCLI-v\$\{CODEXBAR_VERSION\}-linux-\$\{HA\}/);
  // The release holds CodexBarCLI as a regular file and codexbar as a link to it: extract the file.
  assert.match(dockerfile, /tar -xzf \$\{CB\}\.tar\.gz CodexBarCLI;/);
  assert.match(dockerfile, /install -m 0755 CodexBarCLI \/usr\/local\/bin\/codexbar/);
  const build = fs.readFileSync(path.join(root, 'factory/build.sh'), 'utf8');
  assert.match(build, /CODEXBAR_VERSION=\$\(pin codexbar\)/);
  const source = fs.readFileSync(path.join(root, 'src/factory-build.js'), 'utf8');
  assert.match(source, /CODEXBAR_VERSION: pins\.codexbar/);
});

test('the MIT notice file of CodexBar is the only file under the notice folder', () => {
  const file = path.join(root, 'factory/rootfs/usr/share/doc/codexbar/LICENSE');
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^MIT License\n/);
  assert.match(text, /Copyright \(c\) 2026 Peter Steinberger/);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['LICENSE']);
});

test('codexbarTarget names the glibc tarball and rejects another architecture', () => {
  const pins = codexbarPins();
  const target = codexbarTarget({ version: pins.version, arch: 'x64', hashes: pins.hashes });
  assert.equal(target.sha256, pins.hashes.x86_64);
  assert.match(target.url, new RegExp(`CodexBarCLI-v${pins.version}-linux-x86_64\\.tar\\.gz$`));
  assert.equal(codexbarTarget({ version: pins.version, arch: 'arm64', hashes: pins.hashes }).arch, 'aarch64');
  assert.equal(codexbarTarget({ version: pins.version, arch: 'ppc64', hashes: pins.hashes }), null);
});

test('parseCodexbarVersion reads a bare version or one inside a line', () => {
  assert.equal(parseCodexbarVersion('0.72.0\n'), '0.72.0');
  assert.equal(parseCodexbarVersion('CodexBarCLI 0.71.3'), '0.71.3');
  assert.equal(parseCodexbarVersion('no version here'), null);
});

// The config file: mode 0600, the three providers, source auto, and no key invented.
test('the config names the three providers with source auto and keeps a stored key', () => {
  const fresh = codexbarConfigText(null);
  const parsed = JSON.parse(fresh);
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.providers.map((p) => p.id), ['codex', 'claude', 'opencodego']);
  assert.ok(parsed.providers.every((p) => p.source === 'auto' && p.enabled === true));
  assert.doesNotMatch(fresh, /apiKey|cookieHeader|token/i);
  const kept = JSON.parse(codexbarConfigText(JSON.stringify({ version: 1, providers: [{ id: 'opencodego', enabled: true, source: 'auto', apiKey: 'stored-by-the-store' }] })));
  assert.equal(kept.providers.find((p) => p.id === 'opencodego').apiKey, 'stored-by-the-store');
  assert.equal(kept.providers.find((p) => p.id === 'codex').source, 'auto');
  assert.equal(codexbarConfigText('{ not json'), null);
});

test('the config file is written with mode 0600 and an invalid file is left alone', () => {
  const home = tempHome();
  try {
    assert.equal(applyCodexbarConfig({ home }).state, 'ok');
    const file = path.join(home, '.config', 'codexbar', 'config.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).providers.length, 3);
    fs.writeFileSync(file, '{ not json');
    assert.equal(applyCodexbarConfig({ home }).state, 'invalid');
    assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// The install step with an injected download, extract, and version check. It never uses the network here.
function fakeInstall(pins, { current = null, body = 'codexbar-binary', failure = null, extract = true, validate = () => true, extra = {} } = {}) {
  const home = tempHome();
  const calls = { download: 0, extract: 0 };
  const deps = {
    readVersion: () => current,
    download: (url, file) => { calls.download += 1; calls.url = url; if (failure) throw failure; fs.writeFileSync(file, body); },
    extract: (tarFile, dir) => { calls.extract += 1; if (extract) fs.writeFileSync(path.join(dir, 'codexbar'), 'installed-binary', { mode: 0o755 }); },
    validate,
    ...extra,
  };
  return { home, calls, deps, hashes: { x86_64: sha256(body), aarch64: sha256(body) } };
}

test('a missing binary is downloaded, hash checked, and installed to the home bin folder', () => {
  const pins = codexbarPins();
  const f = fakeInstall(pins, { body: 'pinned-bytes' });
  try {
    const result = installCodexbar({ home: f.home, version: pins.version, arch: 'x64', hashes: f.hashes, deps: f.deps });
    assert.deepEqual(result, { state: 'installed', configInvalid: false });
    const bin = path.join(f.home, '.local', 'bin', 'codexbar');
    assert.equal(fs.statSync(bin).mode & 0o777, 0o755);
    assert.equal(fs.readFileSync(bin, 'utf8'), 'installed-binary');
    assert.equal(f.calls.download, 1);
    assert.match(f.calls.url, /linux-x86_64\.tar\.gz$/);
    assert.equal(fs.statSync(path.join(f.home, '.config', 'codexbar', 'config.json')).mode & 0o777, 0o600);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});

test('a current binary is a no-op and downloads nothing', () => {
  const pins = codexbarPins();
  const f = fakeInstall(pins, { current: pins.version });
  try {
    assert.equal(installCodexbar({ home: f.home, version: pins.version, arch: 'x64', hashes: f.hashes, deps: f.deps }).state, 'unchanged');
    assert.equal(f.calls.download, 0);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});

test('a hash mismatch refuses the install and writes no binary', () => {
  const pins = codexbarPins();
  const f = fakeInstall(pins, { body: 'tampered-bytes' });
  try {
    const result = installCodexbar({ home: f.home, version: pins.version, arch: 'x64', hashes: { x86_64: sha256('expected'), aarch64: sha256('expected') }, deps: f.deps });
    assert.deepEqual(result, { state: 'hash-mismatch', configInvalid: false });
    assert.equal(fs.existsSync(path.join(f.home, '.local', 'bin', 'codexbar')), false);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});

test('an unsupported architecture and both download failures give fixed states', () => {
  const pins = codexbarPins();
  for (const [failure, expected] of [[Object.assign(new Error('x'), { network: true }), 'no-network'], [new Error('x'), 'download-failed']]) {
    const f = fakeInstall(pins, { failure });
    try {
      assert.equal(installCodexbar({ home: f.home, version: pins.version, arch: 'x64', hashes: f.hashes, deps: f.deps }).state, expected);
    } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
  }
  const arch = fakeInstall(pins);
  try {
    assert.equal(installCodexbar({ home: arch.home, version: pins.version, arch: 'ppc64', hashes: arch.hashes, deps: arch.deps }).state, 'unsupported-architecture');
  } finally { fs.rmSync(arch.home, { recursive: true, force: true }); }
});

test('a symlink member in a hash-valid tarball is refused with a fixed reason and writes no binary', () => {
  const pins = codexbarPins();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbar-symlink-'));
  try {
    const target = path.join(dir, 'secret.txt');
    fs.writeFileSync(target, 'INVENTED-SECRET');
    fs.symlinkSync(target, path.join(dir, 'codexbar'));
    const tarFile = path.join(dir, 'cli.tar.gz');
    assert.equal(spawnSync('tar', ['-czf', tarFile, '-C', dir, 'codexbar'], { stdio: ['ignore', 'ignore', 'pipe'] }).status, 0);
    const body = fs.readFileSync(tarFile);
    const home = tempHome();
    try {
      const result = installCodexbar({
        home, version: pins.version, arch: 'x64',
        hashes: { x86_64: sha256(body), aarch64: sha256(body) },
        deps: { readVersion: () => null, download: (_url, file) => { fs.writeFileSync(file, body); }, validate: () => true },
      });
      assert.deepEqual(result, { state: 'download-failed', configInvalid: false });
      assert.equal(fs.existsSync(path.join(home, '.local', 'bin', 'codexbar')), false);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the release layout installs: codexbar is a link to the regular file CodexBarCLI', () => {
  const pins = codexbarPins();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbar-layout-'));
  try {
    fs.writeFileSync(path.join(dir, 'CodexBarCLI'), 'INVENTED-BINARY', { mode: 0o755 });
    fs.symlinkSync('CodexBarCLI', path.join(dir, 'codexbar'));
    const tarFile = path.join(dir, 'cli.tar.gz');
    assert.equal(spawnSync('tar', ['-czf', tarFile, '-C', dir, 'CodexBarCLI', 'codexbar'], { stdio: ['ignore', 'ignore', 'pipe'] }).status, 0);
    const body = fs.readFileSync(tarFile);
    const home = tempHome();
    try {
      const result = installCodexbar({
        home, version: pins.version, arch: 'x64',
        hashes: { x86_64: sha256(body), aarch64: sha256(body) },
        deps: { readVersion: () => null, download: (_url, file) => { fs.writeFileSync(file, body); }, validate: () => true },
      });
      assert.deepEqual(result, { state: 'installed', configInvalid: false });
      const bin = path.join(home, '.local', 'bin', 'codexbar');
      assert.equal(fs.lstatSync(bin).isSymbolicLink(), false);
      assert.equal(fs.readFileSync(bin, 'utf8'), 'INVENTED-BINARY');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an extracted archive without the binary and a failed config validation give fixed words', () => {
  const pins = codexbarPins();
  const empty = fakeInstall(pins, { extract: false });
  const bad = fakeInstall(pins, { validate: () => false });
  try {
    assert.equal(installCodexbar({ home: empty.home, version: pins.version, arch: 'x64', hashes: empty.hashes, deps: empty.deps }).state, 'download-failed');
    assert.deepEqual(installCodexbar({ home: bad.home, version: pins.version, arch: 'x64', hashes: bad.hashes, deps: bad.deps }), { state: 'installed', configInvalid: true });
  } finally {
    fs.rmSync(empty.home, { recursive: true, force: true });
    fs.rmSync(bad.home, { recursive: true, force: true });
  }
});

test('the command prints one state word and a config word, never a file content or a credential', () => {
  const home = tempHome();
  const out = [];
  try {
    const word = codexbarInstallCommand(['--apply'], { home, isContainer: () => true, print: (line) => out.push(line), deps: { readVersion: () => null, download: () => { throw Object.assign(new Error('leak NOT-A-REAL-SECRET'), { network: true }); }, extract() {}, validate: () => true } });
    assert.equal(word, 0);
    assert.deepEqual(out, ['no-network']);
    assert.doesNotMatch(out.join('\n'), /NOT-A-REAL-SECRET/);
    assert.throws(() => codexbarInstallCommand([], { home, isContainer: () => true, print: () => {} }), /codexbar-install --apply/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
