// This function also runs in a labeled helper container. Keep it self-contained.
// The archive is a gzip stream of bounded JSON headers and raw file bytes.
export async function archiveWorker(args) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const zlib = await import('node:zlib');
  const { once } = await import('node:events');
  const { pipeline } = await import('node:stream/promises');
  const [action, rootsJSON, value] = args;
  const roots = JSON.parse(rootsJSON);
  const format = 'herdr-boss.factory-backup/1';
  const fail = () => { throw new Error('The factory backup is invalid.'); };
  if (action === 'backup') {
    const manifest = JSON.parse(value);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-snapshot-'));
    const gzip = zlib.createGzip();
    // Start the consumer before writing. Back pressure bounds memory use.
    const finished = pipeline(gzip, process.stdout);
    finished.catch(() => {});
    const write = async (chunk) => { if (!gzip.write(chunk)) await once(gzip, 'drain'); };
    const header = (entry) => write(`${JSON.stringify(entry)}\n`);
    const isDatabase = (file) => {
      let stat;
      try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
      if (!stat.isFile()) return false;
      const fd = fs.openSync(file, 'r');
      const signature = Buffer.alloc(16);
      try { fs.readSync(fd, signature, 0, 16, 0); } finally { fs.closeSync(fd); }
      return signature.toString() === 'SQLite format 3\0';
    };
    try {
      await header({ type: 'manifest', value: manifest });
      async function visit(kind, relative = '') {
        const file = path.join(roots[kind], relative);
        const name = relative ? `${kind}/${relative.split(path.sep).join('/')}` : kind;
        const stat = fs.lstatSync(file);
        const mode = stat.mode & 0o777;
        if (stat.isSymbolicLink()) { await header({ type: 'link', path: name, target: fs.readlinkSync(file), mode }); return; }
        if (stat.isDirectory()) {
          await header({ type: 'directory', path: name, mode });
          const names = fs.readdirSync(file).sort();
          for (const child of names) {
            // Nested mounts are separate volumes. Do not archive hidden old copies.
            if (kind === 'home' && !relative && ['.herdr-boss', 'work', 'herdr-boss'].includes(child)) continue;
            if (kind === 'data' && /(?:-wal|-shm|-journal)$/.test(child) && isDatabase(path.join(file, child.replace(/(?:-wal|-shm|-journal)$/, '')))) continue;
            await visit(kind, path.join(relative, child));
          }
          return;
        }
        if (!stat.isFile()) return; // Sockets and devices are runtime state.
        let source = file;
        if (kind === 'data') {
          if (isDatabase(file)) {
            const { DatabaseSync } = await import('node:sqlite');
            source = path.join(temporary, `${fs.readdirSync(temporary).length}.db`);
            const db = new DatabaseSync(file, { readOnly: true, timeout: 5000 });
            try { db.prepare('VACUUM INTO ?').run(source); } finally { db.close(); }
          }
        }
        await header({ type: 'file', path: name, mode, size: fs.statSync(source).size });
        for await (const chunk of fs.createReadStream(source)) await write(chunk);
      }
      for (const kind of manifest.volumes) await visit(kind);
      await header({ type: 'end' });
      gzip.end();
      await finished;
    } catch (error) { gzip.destroy(error); await finished.catch(() => {}); throw error; }
    finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    return;
  }
  if (!['check', 'restore'].includes(action)) fail();
  const source = action === 'check' ? fs.createReadStream(value) : process.stdin;
  const gunzip = zlib.createGunzip();
  const finished = pipeline(source, gunzip);
  finished.catch(() => {});
  const iterator = gunzip[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0), done = false;
  const fill = async () => {
    const next = await iterator.next();
    if (next.done) done = true;
    else pending = pending.length ? Buffer.concat([pending, next.value]) : next.value;
  };
  async function line() {
    for (;;) {
      const cut = pending.indexOf(10);
      if (cut >= 0) {
        if (cut > 65536) fail();
        const raw = pending.subarray(0, cut).toString('utf8'); pending = pending.subarray(cut + 1);
        try { return JSON.parse(raw); } catch { fail(); }
      }
      if (pending.length > 65536 || done) fail();
      await fill();
    }
  }
  const fields = (entry, keys) => entry && typeof entry === 'object' && !Array.isArray(entry) && Object.keys(entry).every((key) => keys.includes(key));
  let manifest;
  const seen = new Set(), directories = new Set(), modes = [];
  try {
    const first = await line();
    if (!fields(first, ['type', 'value']) || first.type !== 'manifest') fail();
    manifest = first.value;
    const keys = ['schema', 'contractVersion', 'format', 'name', 'factoryId', 'createdAt', 'profile', 'version', 'kitRevision', 'imageTag', 'image', 'ports', 'volumes', 'resourceOwner'];
    const validName = (name) => typeof name === 'string' && /^(?=.{1,31}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$(?![\s\S])/.test(name);
    const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z') === value;
    if (typeof manifest?.version !== 'string' || manifest.version.length > 64) fail();
    if (!fields(manifest, keys) || Object.keys(manifest).length !== keys.length || manifest.schema !== 1 || manifest.contractVersion !== '1.0.0' || manifest.format !== format || !validName(manifest.name) || typeof manifest.factoryId !== 'string' || manifest.factoryId.length > 64 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$(?![\s\S])/.test(manifest.factoryId) || !validName(manifest.resourceOwner) || manifest.profile !== 'personal' || !/^\d+\.\d+\.\d+$(?![\s\S])/.test(manifest.version) || !/^[a-f0-9]{12,64}$(?![\s\S])/.test(manifest.kitRevision) || typeof manifest.imageTag !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$(?![\s\S])/.test(manifest.imageTag) || !timestamp(manifest.createdAt)) fail();
    if (!fields(manifest.image, ['builtAt', 'pinsHash']) || !timestamp(manifest.image.builtAt) || !/^[a-f0-9]{64}$(?![\s\S])/.test(manifest.image.pinsHash)) fail();
    if (!fields(manifest.ports, ['dashboard', 'ssh']) || ![manifest.ports.dashboard, manifest.ports.ssh].every((port) => Number.isInteger(port) && port >= 1 && port <= 65535) || manifest.ports.dashboard === manifest.ports.ssh) fail();
    if (JSON.stringify(manifest.volumes) !== '["data","work"]' && JSON.stringify(manifest.volumes) !== '["data","work","home"]') fail();
    if (action === 'restore') for (const kind of manifest.volumes) {
      if (!roots[kind] || fs.readdirSync(roots[kind]).length) throw new Error('Restore needs empty factory volumes.');
    }
    for (;;) {
      const entry = await line();
      if (entry?.type === 'end') { if (!fields(entry, ['type'])) fail(); break; }
      if (!fields(entry, ['type', 'path', 'mode', ...(entry?.type === 'file' ? ['size'] : entry?.type === 'link' ? ['target'] : [])]) || !['directory', 'file', 'link'].includes(entry.type) || typeof entry.path !== 'string' || entry.path.length > 4096 || entry.path.includes('\\') || entry.path.includes('\0') || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) fail();
      const parts = entry.path.split('/');
      if (!manifest.volumes.includes(parts[0]) || parts.some((part) => !part || part === '.' || part === '..') || seen.has(entry.path) || (parts.length === 1 && entry.type !== 'directory')) fail();
      for (let index = 1; index < parts.length; index += 1) if (!directories.has(parts.slice(0, index).join('/'))) fail();
      seen.add(entry.path);
      const destination = action === 'restore' ? path.join(roots[parts[0]], ...parts.slice(1)) : null;
      if (entry.type === 'directory') {
        directories.add(entry.path);
        if (destination) { fs.mkdirSync(destination, { recursive: true, mode: 0o700 }); modes.push([destination, entry.mode]); }
      } else if (entry.type === 'link') {
        if (typeof entry.target !== 'string' || !entry.target || entry.target.includes('\0') || entry.target.length > 4096) fail();
        if (destination) fs.symlinkSync(entry.target, destination);
      } else {
        if (!Number.isSafeInteger(entry.size) || entry.size < 0) fail();
        const fd = destination ? fs.openSync(destination, 'wx', 0o600) : null;
        try {
          let remaining = entry.size;
          while (remaining) {
            if (!pending.length) { if (done) fail(); await fill(); continue; }
            const count = Math.min(remaining, pending.length);
            if (fd !== null) fs.writeFileSync(fd, pending.subarray(0, count));
            pending = pending.subarray(count); remaining -= count;
          }
          if (fd !== null) fs.fchmodSync(fd, entry.mode);
        } finally { if (fd !== null) fs.closeSync(fd); }
      }
      // All restored files belong to the unprivileged factory user.
      if (destination && process.getuid?.() === 0) fs.lchownSync(destination, 1000, 1000);
    }
    for (const kind of manifest.volumes) if (!directories.has(kind)) fail();
    while (!done) { if (pending.length) fail(); await fill(); }
    if (pending.length) fail();
    await finished;
    for (const [directory, mode] of modes.reverse()) fs.chmodSync(directory, mode);
    return manifest;
  } catch { source.destroy(); gunzip.destroy(); await finished.catch(() => {}); fail(); }
}

export const archiveScript = `(${archiveWorker.toString()})(process.argv.slice(1)).catch(() => { process.stderr.write('The factory archive operation failed.\\n'); process.exitCode = 1; });`;

export async function readBackup(file) {
  try { return await archiveWorker(['check', '{}', file]); }
  catch { throw new Error('The factory backup is invalid or cannot be read.'); }
}
