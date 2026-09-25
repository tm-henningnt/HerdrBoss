import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Engine } from './engine.js';
import { PROJECTS_DIR, DATA_DIR } from './config.js';
import { writeProject, listProjects } from './projects.js';
import { loadModels } from './kit/config.js';
import { loadPolicy, savePolicy } from './control.js';
import { recordUsage, usageSummary } from './usage.js';
import { requestBrowser, listBrowserSessions, browserStatus, setBrowserWindowSize, closeBrowser, restartBrowser } from './browser-pool.js';
import { listBrowserTabs, browserScreenshot, browserNavigate, browserNavigationState, browserHistoryAction, browserClick, browserInsertText, browserKey, browserNewTab, tabAttached } from './browser-preview.js';
import { listHandoffs } from './handoff.js';
import { roamgateAvailable, roamgateUrl } from './roamgate.js';
import { createAccessControl, loginPage } from './access.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8' };
const execFileAsync = promisify(execFile);

async function handoffCommand(args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [fileURLToPath(new URL('./cli.js', import.meta.url)), 'handoff', ...args], {
      timeout: 180000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PATH: `${path.join(os.homedir(), '.local/bin')}:${process.env.PATH || ''}` },
    });
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(String(error.stderr || error.message).trim().slice(0, 800));
  }
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
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

function allowedRequest(req, pathname) {
  const host = req.headers.host || '';
  const hostname = host.replace(/:\d+$/, '').toLowerCase();
  const localAddresses = Object.values(os.networkInterfaces()).flat().filter(Boolean).map((iface) => iface.address.toLowerCase());
  if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname) && !hostname.endsWith('.ts.net') && !localAddresses.includes(hostname.replace(/^\[|\]$/g, ''))) return false;
  const origin = req.headers.origin;
  if (origin === 'null') {
    if (pathname !== '/login' || req.method !== 'POST' || !['same-origin', 'none', undefined].includes(req.headers['sec-fetch-site'])) return false;
  } else if (origin) {
    try { if (new URL(origin).host.toLowerCase() !== host.toLowerCase()) return false; }
    catch { return false; }
  }
  return req.headers['sec-fetch-site'] !== 'cross-site' || (req.method === 'GET' && !pathname.startsWith('/api/') && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document');
}

// Dashboard control of a tab that an agent holds needs explicit confirmation. Agent CLI commands do not pass through here.
async function attachedGuard(body) {
  if (body.confirmAttached === true) return null;
  try { if (await tabAttached(body.project, body.tab)) return { error: 'An agent is using this tab. Navigation or input can disturb its work. Confirm to continue, or open a new tab.', attached: true }; }
  catch {}
  return null;
}

async function jsonBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Content-Type must be application/json.');
  return JSON.parse(await readBody(req));
}

export function serve(cfg, { readOnlyPreview = false, createEngine = (config, options) => new Engine(config, options) } = {}) {
  const access = createAccessControl(cfg.access.tokenFile, { sessionDays: cfg.access.sessionDays });
  const engine = readOnlyPreview ? createEngine(cfg, { push: false, act: false }) : createEngine(cfg);
  const clients = new Set();
  let closed = false;
  let timer;
  let tickPromise;
  let debounce;

  const broadcast = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  };
  engine.on('state', (s) => broadcast('state', s));

  // Push project edits to clients without waiting for the next tick.
  const projectsWatcher = fs.watch(PROJECTS_DIR, () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (!engine.state) return;
      engine.state.projects = listProjects();
      broadcast('state', engine.state);
    }, 300);
  });
  projectsWatcher.on('error', (error) => {
    if (!closed) engine.log('error', `Project watcher failed: ${error.message}`);
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (!allowedRequest(req, p)) return send(res, 403, { error: 'This control plane requires a local interface or Tailscale host and a same-origin request.' });
      if (readOnlyPreview && p.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method)) {
        return send(res, 403, { error: 'This read-only preview does not allow changes.' });
      }
      if (p === '/login' && req.method === 'GET') return send(res, 200, loginPage(), 'text/html; charset=utf-8');
      if (p === '/login' && req.method === 'POST') {
        const body = await readBody(req, 4096);
        const result = access.login(req, new URLSearchParams(body).get('token'));
        if (!result.ok) return send(res, result.limited ? 429 : 401, loginPage('invalid'), 'text/html; charset=utf-8');
        res.writeHead(303, { location: '/', 'set-cookie': result.cookie, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        return res.end();
      }
      if (!access.authorized(req, res)) {
        if (req.method === 'GET' && !p.startsWith('/api/') && (req.headers.accept || '').includes('text/html')) {
          res.writeHead(303, { location: '/login', 'cache-control': 'no-store' });
          return res.end();
        }
        return send(res, 401, { error: 'Access token required.' });
      }
      if (p === '/api/state') return send(res, 200, engine.state || {});
      if (p === '/api/roamgate' && req.method === 'GET') return send(res, 200, { available: await roamgateAvailable(cfg) });
      if (p === '/roamgate' && req.method === 'GET') {
        if (!(await roamgateAvailable(cfg))) return send(res, 503, { error: 'Roamgate is unavailable.' });
        res.writeHead(302, { location: roamgateUrl(req.headers.host, cfg), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        return res.end();
      }
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
      if (p === '/api/browser-sessions/tabs' && req.method === 'GET') {
        const project = url.searchParams.get('project');
        if (!engine.state?.control?.projects?.[project]) return send(res, 404, { error: 'Unknown open project.' });
        try { return send(res, 200, await listBrowserTabs(project)); }
        catch (e) { return send(res, 409, { error: e.message }); }
      }
      if (p === '/api/browser-sessions/screenshot' && req.method === 'GET') {
        const project = url.searchParams.get('project');
        if (!engine.state?.control?.projects?.[project]) return send(res, 404, { error: 'Unknown open project.' });
        try { return send(res, 200, await browserScreenshot(project, url.searchParams.get('tab')), 'image/jpeg'); }
        catch (e) { return send(res, 409, { error: e.message }); }
      }
      if (p === '/api/browser-sessions/navigation' && req.method === 'GET') {
        const project = url.searchParams.get('project');
        if (!engine.state?.control?.projects?.[project]) return send(res, 404, { error: 'Unknown open project.' });
        try { return send(res, 200, await browserNavigationState(project, url.searchParams.get('tab'))); }
        catch (e) { return send(res, 409, { error: e.message }); }
      }
      if (p === '/api/browser-sessions/window-size' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (!engine.state?.control?.projects?.[body.project]) return send(res, 404, { error: 'Unknown open project.' });
        try { return send(res, 200, setBrowserWindowSize(body.project, body.width, body.height)); }
        catch (e) { return send(res, 400, { error: e.message }); }
      }
      if (p === '/api/browser-sessions/navigate' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (!engine.state?.control?.projects?.[body.project]) return send(res, 404, { error: 'Unknown open project.' });
        const guard = await attachedGuard(body);
        if (guard) return send(res, 409, guard);
        try { return send(res, 200, await browserNavigate(body.project, body.tab, body.url)); }
        catch (e) { return send(res, 409, { error: e.message }); }
      }
      if (p === '/api/browser-sessions/history' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (!engine.state?.control?.projects?.[body.project]) return send(res, 404, { error: 'Unknown open project.' });
        const guard = await attachedGuard(body);
        if (guard) return send(res, 409, guard);
        try { return send(res, 200, await browserHistoryAction(body.project, body.tab, body.action)); }
        catch (e) { return send(res, 409, { error: e.message }); }
      }
      if (p === '/api/browser-sessions/input' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (!engine.state?.control?.projects?.[body.project]) return send(res, 404, { error: 'Unknown open project.' });
        const guard = await attachedGuard(body);
        if (guard) return send(res, 409, guard);
        try {
          if (body.type === 'click') return send(res, 200, await browserClick(body.project, body.tab, body.x, body.y));
          if (body.type === 'text') return send(res, 200, await browserInsertText(body.project, body.tab, body.text));
          if (body.type === 'key') return send(res, 200, await browserKey(body.project, body.tab, body.key));
          return send(res, 400, { error: 'Unknown browser input type.' });
        } catch (e) { return send(res, 409, { error: e.message }); }
      }
      if (p === '/api/browser-sessions/new-tab' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (!engine.state?.control?.projects?.[body.project]) return send(res, 404, { error: 'Unknown open project.' });
        try { return send(res, 200, await browserNewTab(body.project)); }
        catch (e) { return send(res, 409, { error: e.message }); }
      }
      if (p === '/api/browser-sessions/close' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (!engine.state?.control?.projects?.[body.project]) return send(res, 404, { error: 'Unknown open project.' });
        try { return send(res, 200, await closeBrowser(body.project)); }
        catch (e) { return send(res, 409, { error: e.message }); }
      }
      if (p === '/api/browser-sessions/restart' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (!engine.state?.control?.projects?.[body.project]) return send(res, 404, { error: 'Unknown open project.' });
        try { return send(res, 200, await restartBrowser(body.project, body.headless, { restorePage: body.restorePage !== false, tabId: body.tab || null })); }
        catch (e) { return send(res, 409, { error: e.message }); }
      }
      if (p === '/api/browser-sessions/request' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (!engine.state?.control?.projects?.[body.project]) return send(res, 400, { error: 'Unknown open project.' });
        if (body.headless != null && typeof body.headless !== 'boolean') return send(res, 400, { error: 'headless must be boolean.' });
        try { return send(res, 200, await requestBrowser(body.project, { launch: body.launch !== false, headless: body.headless ?? null })); }
        catch (e) { return send(res, 409, { error: e.message }); }
      }
      if (p === '/api/handoffs' && req.method === 'GET') return send(res, 200, listHandoffs());
      if (p === '/api/handoffs/output' && req.method === 'GET') {
        const item = listHandoffs().find((x) => x.id === url.searchParams.get('id'));
        if (!item) return send(res, 404, { error: 'Handover not found.' });
        const { stdout } = await execFileAsync('herdr', ['agent', 'read', item.newPane, '--lines', '90', '--format', 'text'], { timeout: 15000, maxBuffer: 1024 * 1024 });
        return send(res, 200, { id: item.id, output: stdout.slice(-16000) });
      }
      if (p === '/api/handoffs/plan' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (!engine.state?.control?.projects?.[body.project]?.orch || engine.state.control.projects[body.project].orch.pane !== body.pane) return send(res, 400, { error: 'Unknown current orchestrator pane.' });
        if (!['codex', 'claude', 'opencode', 'pi'].includes(body.to) || !['migrate', 'fresh'].includes(body.mode) || typeof body.model !== 'string') return send(res, 400, { error: 'Choose a target harness, model, and handover mode.' });
        return send(res, 200, await handoffCommand(['plan', body.pane, '--to', body.to, '--model', body.model, '--mode', body.mode, ...(body.effort ? ['--effort', body.effort] : [])]));
      }
      if (p === '/api/handoffs/prepare' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (!engine.state?.control?.projects?.[body.project]?.orch || engine.state.control.projects[body.project].orch.pane !== body.pane) return send(res, 400, { error: 'Unknown current orchestrator pane.' });
        if (!['codex', 'claude', 'opencode', 'pi'].includes(body.to) || !['migrate', 'fresh'].includes(body.mode) || typeof body.model !== 'string') return send(res, 400, { error: 'Choose a target harness, model, and handover mode.' });
        if (listHandoffs().some((x) => x.sourcePane === body.pane && ['prepared', 'preparing', 'needs-inspection'].includes(x.status))) return send(res, 409, { error: 'A successor exists for this orchestrator. Inspect it before preparing another.' });
        return send(res, 200, await handoffCommand(['prepare', body.pane, '--to', body.to, '--model', body.model, '--mode', body.mode, ...(body.effort ? ['--effort', body.effort] : [])]));
      }
      if (p === '/api/handoffs/activate' && req.method === 'POST') {
        const body = await jsonBody(req);
        const item = listHandoffs().find((x) => x.id === body.id && x.status === 'prepared');
        if (!item || body.confirmed !== true) return send(res, 400, { error: 'Review the prepared successor and confirm activation.' });
        return send(res, 200, await handoffCommand(['activate', item.id, '--confirmed']));
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
      send(res, e instanceof SyntaxError || e.message.includes('Content-Type') || p.startsWith('/api/handoffs/') ? 400 : 500, { error: e.message });
    }
  });

  server.listen(cfg.port, cfg.host, () => {
    console.log(`herdr-boss: http://${cfg.host}:${cfg.port} (push ${engine.push ? 'on' : 'off'})`);
  });

  server.on('close', () => {
    closed = true;
    clearTimeout(timer);
    clearTimeout(debounce);
    projectsWatcher.close();
  });
  const loop = async () => {
    try {
      tickPromise = engine.tick();
      await tickPromise;
    } catch (e) { engine.log('error', `tick failed: ${e.message}`); console.error(e); }
    finally { tickPromise = null; }
    if (!closed) timer = setTimeout(loop, cfg.tickSeconds * 1000);
  };
  loop();
  const close = async () => {
    for (const client of clients) client.end();
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    if (tickPromise) await tickPromise.catch(() => {});
  };
  return { server, engine, close };
}
