// The CodexBar CLI of a factory container. The command `herdr-boss codexbar-install --apply` runs inside the container.
// It installs or repairs the pinned binary in the home folder, and it writes the provider config with the source `auto`.
// It reads no login file, passes no credential, and prints no file content. It prints fixed state words only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isInsideContainer } from './factory-core.js';

export const CODEXBAR_PROVIDERS = Object.freeze(['codex', 'claude', 'opencodego']);
export const CODEXBAR_INSTALL_REASONS = Object.freeze(['download-failed', 'hash-mismatch', 'unsupported-architecture', 'no-network']);
const PINS_FILE = new URL('../factory/pins.json', import.meta.url);
const ARCHES = Object.freeze({ x64: 'x86_64', arm64: 'aarch64' });
const DOWNLOAD_URL = (version, arch) => `https://github.com/steipete/CodexBar/releases/download/v${version}/CodexBarCLI-v${version}-linux-${arch}.tar.gz`;
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// The pinned CodexBar version and the SHA-256 of both Linux glibc tarballs. The pins file stays the one place for versions.
export function codexbarPins(pinsPath = PINS_FILE) {
  const pins = JSON.parse(fs.readFileSync(pinsPath, 'utf8'));
  const version = pins?.codexbar;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('The CodexBar pin is invalid.');
  const hashes = {};
  for (const arch of Object.values(ARCHES)) {
    const file = `CodexBarCLI-v${version}-linux-${arch}.tar.gz`;
    const hash = pins?.sha256?.[file];
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('A CodexBar tarball hash is missing from the pins file.');
    hashes[arch] = hash;
  }
  return { version, hashes };
}

// The download target of one architecture, or null when the architecture is unsupported.
export function codexbarTarget({ version, arch, hashes }) {
  const name = ARCHES[arch];
  if (!name || !hashes?.[name]) return null;
  return { arch: name, url: DOWNLOAD_URL(version, name), sha256: hashes[name] };
}

// Parse the version that the installed binary reports. `codexbar --version` prints a bare version or one inside a line.
export function parseCodexbarVersion(text) {
  const match = String(text || '').match(/\b(\d+\.\d+\.\d+)\b/);
  return match ? match[1] : null;
}

// Build the config text. The three providers use the source `auto`. An existing provider keeps its fields, so a stored
// API key and an Owner choice survive a repair. An existing file that is not a JSON object gives null and is not written.
export function codexbarConfigText(reference = null) {
  let current;
  if (reference === null || reference === undefined || String(reference).trim() === '') current = { version: 1, providers: [] };
  else {
    try { current = JSON.parse(String(reference)); } catch { return null; }
  }
  if (!isRecord(current)) return null;
  const listed = Array.isArray(current.providers) ? current.providers.filter(isRecord) : [];
  const known = new Map(listed.filter((provider) => typeof provider.id === 'string').map((provider) => [provider.id, provider]));
  const ours = CODEXBAR_PROVIDERS.map((id) => {
    const provider = known.get(id);
    if (!provider) return { id, enabled: true, source: 'auto' };
    return { ...provider, id, enabled: provider.enabled !== false, source: typeof provider.source === 'string' && provider.source ? provider.source : 'auto' };
  });
  const others = listed.filter((provider) => !CODEXBAR_PROVIDERS.includes(provider.id));
  return `${JSON.stringify({ ...current, version: 1, providers: [...ours, ...others] }, null, 2)}\n`;
}

function writeConfig(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

// The config file of the factory user. It returns the state word `ok`, `invalid`, or `unreadable`.
export function applyCodexbarConfig({ home, readFile = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null), write = writeConfig, validate = null } = {}) {
  const file = path.join(home, '.config', 'codexbar', 'config.json');
  let reference = null;
  try { reference = readFile(file); } catch { return { state: 'unreadable' }; }
  const text = codexbarConfigText(reference);
  if (text === null) return { state: 'invalid' };
  try { write(file, text); } catch { return { state: 'unreadable' }; }
  if (validate && !validate({ file, home })) return { state: 'invalid' };
  return { state: 'ok' };
}

// The real readers. They spawn only the pinned vendor binary and standard tools, and they print nothing.
function defaultReadVersion({ home }) {
  const local = path.join(home, '.local', 'bin', 'codexbar');
  const command = fs.existsSync(local) ? local : 'codexbar';
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] });
  return result.status === 0 ? parseCodexbarVersion(result.stdout) : null;
}

function defaultDownload(url, file) {
  const result = spawnSync('curl', ['-fsSL', '--max-time', '300', '-o', file, url], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (result.error || result.status !== 0) {
    const error = new Error('The CodexBar download failed.');
    error.network = [6, 7, 28, 35].includes(result.status);
    throw error;
  }
}

function defaultExtract(tarFile, dir) {
  const result = spawnSync('tar', ['-xzf', tarFile, '-C', dir, 'codexbar'], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (result.error || result.status !== 0) throw new Error('The CodexBar archive cannot be unpacked.');
}

function defaultValidate({ home }) {
  const local = path.join(home, '.local', 'bin', 'codexbar');
  const command = fs.existsSync(local) ? local : 'codexbar';
  const result = spawnSync(command, ['config', 'validate'], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'ignore', 'ignore'] });
  return result.status === 0;
}

// Install or repair the binary and write the config. It returns { state, configInvalid }. It never throws.
// States: installed, unchanged, download-failed, hash-mismatch, unsupported-architecture, no-network.
export function installCodexbar({
  home = process.env.HOME || os.homedir(),
  version,
  arch = process.arch,
  hashes,
  pins,
  deps = {},
} = {}) {
  try {
    const pinned = pins || codexbarPins();
    version = version || pinned.version;
    hashes = hashes || pinned.hashes;
    const readVersion = deps.readVersion || (() => defaultReadVersion({ home }));
    const download = deps.download || defaultDownload;
    const extract = deps.extract || defaultExtract;
    const validate = deps.validate || ((options) => defaultValidate(options));
    let state = 'unchanged';
    if (readVersion({ home }) !== version) {
      const target = codexbarTarget({ version, arch, hashes });
      if (!target) return finish('unsupported-architecture', home, null);
      const work = fs.mkdtempSync(path.join(home, '.codexbar-install-'));
      const tarFile = path.join(work, 'codexbar.tar.gz');
      const unpacked = path.join(work, 'unpacked');
      try {
        try { download(target.url, tarFile); }
        catch (error) { return finish(error?.network ? 'no-network' : 'download-failed', home, null); }
        if (sha256File(tarFile) !== target.sha256) return finish('hash-mismatch', home, null);
        fs.mkdirSync(unpacked, { recursive: true });
        try { extract(tarFile, unpacked); } catch { return finish('download-failed', home, null); }
        const produced = path.join(unpacked, 'codexbar');
        if (!fs.existsSync(produced)) return finish('download-failed', home, null);
        // lstat does not follow a link: a linked member is refused with the fixed reason, and nothing is copied.
        const producedStat = fs.lstatSync(produced);
        if (!producedStat.isFile() || producedStat.isSymbolicLink()) return finish('download-failed', home, null);
        const bin = path.join(home, '.local', 'bin', 'codexbar');
        fs.mkdirSync(path.dirname(bin), { recursive: true, mode: 0o755 });
        fs.copyFileSync(produced, bin);
        fs.chmodSync(bin, 0o755);
        state = 'installed';
      } finally { fs.rmSync(work, { recursive: true, force: true }); }
    }
    return finish(state, home, validate);
  } catch { return { state: 'download-failed', configInvalid: false }; }
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function finish(state, home, validate) {
  const config = applyCodexbarConfig({ home, validate });
  return { state, configInvalid: config.state === 'invalid' };
}


// The command `herdr-boss codexbar-install --apply`. It runs only inside a container, prints fixed state words,
// and exits 0 after the container check, so a failure never stops a service update. A usage error throws.
export function codexbarInstallCommand(args, { home = process.env.HOME || os.homedir(), isContainer = isInsideContainer, print = (text) => console.log(text), deps = {} } = {}) {
  if (args[0] !== '--apply') throw new Error('Use herdr-boss codexbar-install --apply.');
  if (!isContainer()) {
    print('The CodexBar install step runs only inside a factory container. Nothing was changed.');
    return 1;
  }
  const result = installCodexbar({ home, deps });
  print(result.state);
  if (result.configInvalid) print('config-invalid');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = codexbarInstallCommand(process.argv.slice(2));
