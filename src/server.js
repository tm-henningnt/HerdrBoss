import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from './engine.js';
import { PROJECTS_DIR, DATA_DIR } from './config.js';
import { writeProject, listProjects } from './projects.js';
import { loadModels } from './kit/config.js';
import { loadPolicy, savePolicy } from './control.js';
import { recordUsage, usageSummary } from './usage.js';
import { requestBrowser, listBrowserSessions, browserStatus } from './browser-pool.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8' };

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function allowedRequest(req) {
  const host = req.headers.host || '';
  const hostname = host.replace(/:\d+$/, '').toLowerCase();
  if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname) && !hostname.endsWith('.ts.net')) return false;
  const origin = req.headers.origin;
  if (origin && new URL(origin).host.toLowerCase() !== host.toLowerCase()) return false;
  return req.headers['sec-fetch-site'] !== 'cross-site';
}

async function jsonBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Content-Type must be application/json.');
  return JSON.parse(await readBody(req));
}

export function serve(cfg) {
  const engine = new Engine(cfg);
  const clients = new Set();

  const broadcast = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  };
  engine.on('state', (s) => broadcast('state', s));

  // Push project edits to clients without waiting for the next tick.
  let debounce;
  fs.watch(PROJECTS_DIR, () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (!engine.state) return;
      engine.state.projects = listProjects();
      broadcast('state', engine.state);
    }, 300);
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (!allowedRequest(req)) return send(res, 403, { error: 'This local control plane requires a local or Tailscale host and a same-origin request.' });
      if (p === '/api/state') return send(res, 200, engine.state || {});
      if (p === '/api/models' && req.method === 'GET') return send(res, 200, loadModels().kinds);
      if (p === '/api/policy' && req.method === 'GET') return send(res, 200, loadPolicy());
      if (p === '/api/policy' && req.method === 'PUT') {
        const errors = savePolicy(await jsonBody(req), loadModels());
        if (errors.length) return send(res, 400, { ok: false, errors });
        const state = await engine.tick();
        return send(res, 200, { ok: true, policy: loadPolicy(), control: state.control });
      }
      if (p === '/api/usage' && req.method === 'GET') return send(res, 200, usageSummary());
      if (p === '/api/usage' && req.method === 'POST') {
        const result = recordUsage(await jsonBody(req));
        return send(res, result.errors.length ? 400 : 200, { ok: !result.errors.length, ...result });
      }
      if (p === '/api/browser-sessions' && req.method === 'GET') {
        const sessions = await Promise.all(Object.values(listBrowserSessions()).map(browserStatus));
        return send(res, 200, sessions);
      }
      if (p === '/api/browser-sessions/request' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (!engine.state?.control?.projects?.[body.project]) return send(res, 400, { error: 'Unknown open project.' });
        return send(res, 200, await requestBrowser(body.project, { launch: body.launch !== false }));
      }
      if (p === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`retry: 3000\n\n`);
        if (engine.state) res.write(`event: state\ndata: ${JSON.stringify(engine.state)}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => { clearInterval(ping); clients.delete(res); });
        return;
      }
      if (p === '/api/tick' && req.method === 'POST') return send(res, 200, await engine.tick());
      if (p === '/api/projects' && req.method === 'GET') return send(res, 200, listProjects());
      const pm = /^\/api\/projects\/([^/]+)$/.exec(p);
      if (pm && (req.method === 'PUT' || req.method === 'POST')) {
        let data;
        try { data = await jsonBody(req); } catch (e) { return send(res, 400, { ok: false, errors: [`invalid JSON: ${e.message}`] }); }
        const errors = writeProject(pm[1], data);
        return send(res, errors.length ? 400 : 200, { ok: !errors.length, errors });
      }
      if (pm && req.method === 'DELETE') {
        try { fs.unlinkSync(path.join(PROJECTS_DIR, `${pm[1]}.json`)); } catch {}
        return send(res, 200, { ok: true });
      }
      if (p === '/bulletin.md') return send(res, 200, fs.readFileSync(path.join(DATA_DIR, 'bulletin.md')), TYPES['.md']);
      if (p === '/docs/project-status.md') return send(res, 200, fs.readFileSync(path.join(DOCS, 'project-status.md')), TYPES['.md']);

      // Static files. Unknown paths return the app shell for client routing.
      const file = path.join(PUBLIC, path.normalize(p === '/' ? '/index.html' : p).replace(/^(\.\.[/\\])+/, ''));
      if (file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
      }
      if (req.method === 'GET' && !p.startsWith('/api/')) return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'index.html')), TYPES['.html']);
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, e instanceof SyntaxError || e.message.includes('Content-Type') ? 400 : 500, { error: e.message });
    }
  });

  server.listen(cfg.port, cfg.host, () => {
    console.log(`herdr-boss: http://${cfg.host}:${cfg.port} (push ${engine.push ? 'on' : 'off'})`);
  });

  const loop = async () => {
    try { await engine.tick(); } catch (e) { engine.log('error', `tick failed: ${e.message}`); console.error(e); }
    setTimeout(loop, cfg.tickSeconds * 1000);
  };
  loop();
  return { server, engine };
}
