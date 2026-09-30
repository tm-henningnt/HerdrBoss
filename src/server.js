import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Engine } from './engine.js';
import { ownerReleaseLease, withResourcePoolMutation } from './leases.js';
import { PROJECTS_DIR, DATA_DIR, DEFAULT_SESSION_FILE, PRIVATE_ACCESS_DIR, assertPreviewDataDir, writeServiceSettings, applyServiceSettings, serviceSettingsView, validateResourcePools, writeResourcePools } from './config.js';
import { writeProject, listProjects } from './projects.js';
import { loadModels } from './kit/config.js';
import { loadPolicy, savePolicy } from './control.js';
import { recordUsage, usageSummary } from './usage.js';
import { spendSummary, clampSpendDays, loadPrices, defaultPrices, readPriceOverrides, writePriceOverrides, COST_LABEL } from './spend.js';
import { readDenials, denialSummary } from './denials.js';
import { summarizeHours, clampSummaryDays } from './machine-samples.js';
import { analyticsSummary } from './analytics.js';
import { buildWatchRecord, clearNight, readNight, writeNight } from './night.js';
import { effectiveRoutines, rememberChoice, resetRoutine, saveRoutine } from './watch-routines.js';
import { withProbeState } from './browser-probe.js';
import { requestBrowser, listBrowserSessions, browserStatus, setBrowserWindowSize, closeBrowser, restartBrowser, listBookmarks, addBookmark, renameBookmark, moveBookmark, removeBookmark, setStartPage } from './browser-pool.js';
import { listBrowserTabs, browserScreenshot, browserNavigate, browserNavigationState, browserHistoryAction, browserClick, browserInsertText, browserKey, browserNewTab, browserCloseTab, tabAttached } from './browser-preview.js';
import { listHandoffs } from './handoff.js';
import { roamgateAvailable, roamgateUrl } from './roamgate.js';
import { createAccessControl, loginPage } from './access.js';
import { appendMessage, chatSummaries, isMailAnswer, isMailRecord, messagesById, chatThreadPage, closeMailboxItem, closeResolvedOnPublish, dismissMailboxItems, keepMailboxItemsOpen, groupMessagesByConversation, listThread, mailboxCounts, mailboxFolders, mailboxView, markMailboxRead, messageChannel, messagesWithReplyState, readMessages, validThread, validateOwnerSend, withMailAnswers } from './messages.js';
import { assertSqliteAvailable } from './sqlite-store.js';
import { openMessageStore } from './message-store.js';
import { BODY_LIMIT as PROJECT_NEW_BODY_LIMIT, createProjectNewApi } from './project-new-api.js';
import { createReviewApi } from './review-api.js';

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

function handoffSourceMatches(state, body) {
  const project = state?.control?.projects?.[body.project];
  if (project?.orch?.pane === body.pane) return true;
  const boss = state?.control?.bossHandoff;
  const pane = state?.herdr?.panes?.find((item) => item.id === body.pane);
  return body.project === 'Boss' && boss?.pane === body.pane && pane?.label === 'boss' && pane.workspace === boss.workspace;
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// The Owner's own avatar image. A PNG, JPEG, or WebP file of at most 512 KB. SVG and other formats are refused.
const AVATARS_DIR = path.join(DATA_DIR, 'avatars');
const AVATAR_MAX_BYTES = 512 * 1024;
const AVATAR_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
const AVATAR_DECLARED = [...Object.values(AVATAR_TYPES), 'application/octet-stream'];

function readBytes(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; let refused = false; const chunks = [];
    req.on('data', (chunk) => {
      // Keep reading so the answer reaches the client. A refused body never reaches the disk.
      if (refused) return;
      size += chunk.length;
      if (size > limit) {
        refused = true;
        reject(Object.assign(new Error(`The body is larger than ${limit} bytes.`), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!refused) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

// The magic bytes decide the format. A content type alone proves nothing.
function avatarFormat(buffer) {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG)) return '.png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp';
  return null;
}

// An avatar belongs to the Boss or to a project slug: lower-case letters, digits, and hyphens only.
function validAvatarSlug(slug) {
  return slug === 'boss' || /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug);
}

function avatarFile(slug) {
  for (const ext of Object.keys(AVATAR_TYPES)) {
    const file = path.join(AVATARS_DIR, `${slug}${ext}`);
    if (fs.existsSync(file)) return { file, ext };
  }
  return null;
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

function loopbackRequest(req) {
  const host = (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  return ['127.0.0.1', 'localhost', '[::1]'].includes(host)
    && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
}

// Dashboard control of a tab that an agent holds needs explicit confirmation. Agent CLI commands do not pass through here.
async function attachedGuard(body) {
  if (body.confirmAttached === true) return null;
  try { if (await tabAttached(body.project, body.tab)) return { error: 'An agent is using this tab. Navigation or input can disturb its work. Confirm to continue, or open a new tab.', attached: true }; }
  catch {}
  return null;
}

// The body of a project-new POST route: a JSON object of at most 16 KB. A bad body has a status code for the route.
async function projectNewBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw Object.assign(new Error('Content-Type must be application/json.'), { statusCode: 400 });
  const bytes = await readBytes(req, PROJECT_NEW_BODY_LIMIT);
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw Object.assign(new Error('The body is not valid JSON.'), { statusCode: 400 }); }
}

async function jsonBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Content-Type must be application/json.');
  return JSON.parse(await readBody(req));
}

const MACHINE_HOURS_CACHE_MS = 60000;

const PREVIEW_DEFAULT_HOST = '127.0.0.1';

// A preview bind address is an IP address or a host name. An empty value is refused.
export function assertPreviewHost(host) {
  const value = typeof host === 'string' ? host.trim() : '';
  const hostname = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
  if (!value || !(net.isIP(value) || hostname.test(value))) {
    throw new Error('--host needs an IP address or a host name, for example --host 127.0.0.1.');
  }
  return value;
}

export function serve(cfg, { readOnlyPreview = false, previewHost, createEngine = (config, options) => new Engine(config, options), closeTab = browserCloseTab, projectNew = {} } = {}) {
  const machineHoursCache = new Map();
  let analyticsCache = null;
  // A direct serve() call must refuse an unsafe preview before the access token, the watcher, or a tick writes a file.
  if (readOnlyPreview) assertPreviewDataDir();
  if (previewHost !== undefined && !readOnlyPreview) throw new Error('previewHost (--host) is valid only together with --read-only-preview.');
  // The preview has no login. It binds loopback unless the caller names another address. The main service keeps cfg.host.
  const bindHost = readOnlyPreview ? (previewHost === undefined ? PREVIEW_DEFAULT_HOST : assertPreviewHost(previewHost)) : cfg.host;
  assertSqliteAvailable();
  openMessageStore({ dir: DATA_DIR, backend: cfg.store?.messages });
  const access = readOnlyPreview ? null : createAccessControl(cfg.access.tokenFile, {
    sessionFile: DEFAULT_SESSION_FILE,
    sessionDays: cfg.access.sessionDays,
    privateDirectory: PRIVATE_ACCESS_DIR,
  });
  const engine = readOnlyPreview ? createEngine(cfg, { push: false, act: false }) : createEngine(cfg);
  const messageStore = openMessageStore({ dir: DATA_DIR });
  const projectNewApi = createProjectNewApi({ dataDir: DATA_DIR, log: (level, text) => engine.log(level, text), ...projectNew });
  const reviewApi = createReviewApi({ dataDir: DATA_DIR });
  const clients = new Set();
  let closed = false;
  let timer;
  let tickPromise;
  let debounce;

  // The Chat page ignores a record with mailAnswer set. The service knows the parent record, and the page may not.
  const annotateMessage = (data) => {
    const record = data?.record;
    if (!record || record.from !== 'owner' || !record.replyTo) return data;
    const parent = readMessages().find((item) => item.id === record.replyTo);
    return isMailAnswer(record, messagesById(parent ? [parent] : [])) ? { ...data, record: { ...record, mailAnswer: true } } : data;
  };
  const broadcast = (event, data) => {
    if (event === 'message') data = annotateMessage(data);
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  };
  engine.on('state', (s) => broadcast('state', s));
  engine.on('message', (event) => broadcast('message', event));
  const stopMessageWatch = messageStore.onChange((event) => {
    if (typeof engine.observeMessageChange === 'function') engine.observeMessageChange(event);
    else broadcast('message', event);
  });

  // The unread count must follow a read or an answer at once, not at the next tick.
  const refreshMailbox = (records = readMessages(), push = false) => {
    const mailbox = mailboxCounts(records);
    if (engine.state) {
      const changed = JSON.stringify(engine.state.mailbox) !== JSON.stringify(mailbox);
      engine.state.mailbox = mailbox;
      if (push && changed) broadcast('state', engine.state);
    }
    return mailbox;
  };

  // Add the derived task state to a project list. An engine without the method leaves the list as it is.
  const decorateProjects = (list) => (typeof engine.decorateProjects === 'function' ? engine.decorateProjects(list) : list);

  // Push project edits to clients without waiting for the next tick.
  const projectsWatcher = fs.watch(PROJECTS_DIR, () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (!engine.state) return;
      engine.state.projects = decorateProjects(listProjects());
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
      if (readOnlyPreview && !loopbackRequest(req)) return send(res, 403, { error: 'The read-only preview accepts only local requests.' });
      if (!allowedRequest(req, p)) return send(res, 403, { error: 'This control plane requires a local interface or Tailscale host and a same-origin request.' });
      // The project-new GET routes show local paths, so the preview refuses them too.
      const projectNewRoute = p === '/api/project-new' || p.startsWith('/api/project-new/');
      if (readOnlyPreview && p.startsWith('/api/') && (projectNewRoute || !['GET', 'HEAD'].includes(req.method))) {
        return send(res, 403, { error: 'This read-only preview does not allow changes.' });
      }
      if (!readOnlyPreview && p === '/login' && req.method === 'GET') return send(res, 200, loginPage(), 'text/html; charset=utf-8');
      if (!readOnlyPreview && p === '/login' && req.method === 'POST') {
        const body = await readBody(req, 4096);
        const result = access.login(req, new URLSearchParams(body).get('token'));
        if (!result.ok) return send(res, result.limited ? 429 : 401, loginPage('invalid'), 'text/html; charset=utf-8');
        res.writeHead(303, { location: '/', 'set-cookie': result.cookie, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        return res.end();
      }
      if (!readOnlyPreview && !access.authorized(req, res)) {
        if (req.method === 'GET' && !p.startsWith('/api/') && (req.headers.accept || '').includes('text/html')) {
          res.writeHead(303, { location: '/login', 'cache-control': 'no-store' });
          return res.end();
        }
        return send(res, 401, { error: 'Access token required.' });
      }
      if (projectNewRoute) {
        const routed = await projectNewApi.handle(req.method, p, () => projectNewBody(req));
        return send(res, routed.status, routed.body);
      }
      // The review routes sit behind the same checks. The read-only preview guard above already refuses each change.
      if (p === '/api/reviews' || p.startsWith('/api/reviews/')) return await reviewApi.handle(req, res, url);
      if (p === '/api/state') {
        if (engine.state) refreshMailbox();
        return send(res, 200, engine.state || {});
      }
      if (p === '/api/chats' && req.method === 'GET') {
        const projects = engine.state?.control?.projects || {};
        const writable = new Map([['boss', { title: 'Boss' }]]);
        for (const [thread, project] of Object.entries(projects)) {
          if (project?.orch?.pane) writable.set(thread, { title: String(project.project || project.title || thread) });
        }
        const stored = new Map(chatSummaries(messageStore.all()).map((chat) => [chat.thread, chat]));
        const mailUnreadByThread = new Map();
        for (const item of messageStore.all()) {
          if (item.to !== 'owner' || item.readAt || messageChannel(item) !== 'mail') continue;
          mailUnreadByThread.set(item.thread, (mailUnreadByThread.get(item.thread) ?? 0) + 1);
        }
        const chats = [...writable].map(([thread, { title }]) => {
          const chat = stored.get(thread);
          const record = chat?.last;
          // A mail report is not chat unread. The Mailbox keeps its own counts.
          const unread = Math.max(0, (chat?.unreadForOwner ?? 0) - (mailUnreadByThread.get(thread) ?? 0));
          return {
            thread,
            title,
            last: record ? {
              id: record.id,
              at: record.at,
              from: record.from,
              channel: messageChannel(record),
              title: record.title ?? null,
              text: String(record.text ?? '').slice(0, 120),
              status: record.status ?? null,
            } : null,
            unread,
          };
        }).sort((left, right) => {
          if (!left.last) return right.last ? 1 : left.thread.localeCompare(right.thread);
          if (!right.last) return -1;
          return Date.parse(right.last.at) - Date.parse(left.last.at) || left.thread.localeCompare(right.thread);
        });
        return send(res, 200, chats);
      }
      const chatRead = /^\/api\/chats\/([^/]+)\/read$/.exec(p);
      if (chatRead && req.method === 'POST') {
        const thread = chatRead[1];
        if (!validThread(thread)) return send(res, 400, { error: 'Choose a thread: boss or a project slug.' });
        const projects = engine.state?.control?.projects || {};
        if (thread !== 'boss' && !projects[thread]?.orch?.pane) return send(res, 404, { error: `No open project uses the thread ${thread}.` });
        const now = Date.now();
        const updated = messageStore.mutate((records) => {
          let count = 0;
          for (const record of records) {
            if (record.thread === thread && record.to === 'owner' && !record.readAt && messageChannel(record) !== 'mail') {
              record.readAt = new Date(now).toISOString();
              count += 1;
            }
          }
          return { records, result: count };
        }, { now });
        return send(res, 200, { ok: true, updated });
      }
      const chatPath = /^\/api\/chats\/([^/]+)$/.exec(p);
      if (chatPath && req.method === 'GET') {
        const thread = chatPath[1];
        if (!validThread(thread)) return send(res, 400, { error: 'Choose a thread: boss or a project slug.' });
        const projects = engine.state?.control?.projects || {};
        if (thread !== 'boss' && !projects[thread]?.orch?.pane) return send(res, 404, { error: `No open project uses the thread ${thread}.` });
        const limitText = url.searchParams.get('limit');
        const limit = limitText === null ? 50 : Number(limitText);
        if ((limitText !== null && !/^\d+$/.test(limitText)) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
          return send(res, 400, { error: 'The message limit must be an integer from 1 to 100.' });
        }
        const before = url.searchParams.get('before');
        if (before === '') return send(res, 400, { error: 'before must be a message ID.' });
        const everything = messageStore.all();
        const page = chatThreadPage(everything, thread, { before, limit: limit + 1 });
        const more = page.length > limit;
        const messages = withMailAnswers(messagesWithReplyState(more ? page.slice(1) : page, everything), everything)
          .map((record) => ({ ...record, channel: messageChannel(record) }));
        return send(res, 200, { thread, messages, more });
      }
      if (p === '/api/leases/release' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (typeof body.pool !== 'string' || !body.pool || typeof body.item !== 'string' || !body.item || typeof body.project !== 'string' || !body.project) {
          return send(res, 400, { error: 'pool, item, and project are required.' });
        }
        const released = ownerReleaseLease(body.pool, body.item, { expectedProject: body.project, dataDir: DATA_DIR });
        return send(res, 200, { ok: true, released });
      }
      if (p === '/api/pools' && req.method === 'PUT') {
        const body = await jsonBody(req);
        if (!body || !['create', 'update', 'remove'].includes(body.action)) return send(res, 400, { error: 'action must be create, update, or remove.' });
        const pool = body.pool;
        if (!pool || typeof pool !== 'object' || Array.isArray(pool) || typeof pool.name !== 'string' || !pool.name) {
          return send(res, 400, { error: 'pool.name is required.' });
        }
        if (pool.name === 'project-browsers') return send(res, 400, { error: 'project-browsers is a built-in pool and cannot be changed.' });

        let candidate = null;
        if (body.action !== 'remove') {
          const checkedPool = validateResourcePools([pool]);
          if (checkedPool.errors.length) return send(res, 400, { error: checkedPool.errors.join(' '), errors: checkedPool.errors });
          candidate = checkedPool.pools[0];
          const protectedItems = candidate.items.filter((item) => /^\d+$/.test(item) && Number(item) >= 9222 && Number(item) <= 9299);
          if (protectedItems.length) return send(res, 400, { error: `Items from 9222 to 9299 are reserved for project browsers: ${protectedItems.join(', ')}.` });
        }

        const changed = withResourcePoolMutation((leases) => {
          const configFile = path.join(DATA_DIR, 'config.json');
          let config;
          try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); }
          catch (error) {
            if (error.code === 'ENOENT') config = {};
            else return { status: 409, error: `Cannot read config.json: ${error.message}` };
          }
          if (!config || typeof config !== 'object' || Array.isArray(config)) return { status: 409, error: 'config.json must hold a JSON object.' };
          const currentPools = config.resourcePools ?? [];
          if (!Array.isArray(currentPools)) return { status: 409, error: 'config.json resourcePools must be an array.' };
          const index = currentPools.findIndex((item) => item?.name === pool.name);
          if (body.action === 'create' && index !== -1) return { status: 409, error: `Resource pool ${pool.name} already exists.` };
          if (body.action !== 'create' && index === -1) return { status: 404, error: `Resource pool ${pool.name} does not exist.` };

          let nextPools;
          if (body.action === 'create') nextPools = [...currentPools, pool];
          else if (body.action === 'update') nextPools = currentPools.map((item, itemIndex) => itemIndex === index ? pool : item);
          else nextPools = currentPools.filter((_, itemIndex) => itemIndex !== index);

          const checked = validateResourcePools(nextPools);
          if (checked.errors.length) return { status: 400, error: checked.errors.join(' '), errors: checked.errors };

          const held = leases.find((lease) => lease.pool === pool.name && (
            body.action === 'remove' || !candidate.items.includes(lease.item)
          ));
          if (held) {
            const holder = { pool: held.pool, item: held.item, project: held.project, pane: held.pane || null, worker: held.worker || null };
            const location = [held.pane && `pane ${held.pane}`, held.worker && `worker ${held.worker}`].filter(Boolean).join(', ');
            return { status: 409, error: `Resource pool ${pool.name} cannot be ${body.action === 'remove' ? 'removed' : 'updated'} while item ${held.item} is held by project ${held.project}${location ? ` (${location})` : ''}.`, holder };
          }

          writeResourcePools(nextPools);
          return { status: 200, pools: checked.pools };
        });
        if (changed.status !== 200) return send(res, changed.status, { error: changed.error, ...(changed.errors ? { errors: changed.errors } : {}), ...(changed.holder ? { holder: changed.holder } : {}) });
        engine.setResourcePools(changed.pools);
        return send(res, 200, { ok: true, pools: changed.pools });
      }
      if (p === '/api/roamgate' && req.method === 'GET') return send(res, 200, { available: await roamgateAvailable(cfg) });
      if (p === '/roamgate' && req.method === 'GET') {
        if (!(await roamgateAvailable(cfg))) return send(res, 503, { error: 'Roamgate is unavailable.' });
        res.writeHead(302, { location: roamgateUrl(req.headers.host, cfg), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        return res.end();
      }
      if (p === '/api/models' && req.method === 'GET') return send(res, 200, loadModels().kinds);
      if (p === '/api/settings' && req.method === 'PUT') {
        let body;
        try { body = await jsonBody(req); }
        catch (error) { return send(res, 400, { ok: false, error: error.message }); }
        if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body, 'changes')) {
          return send(res, 400, { ok: false, error: 'changes must be an object of setting names and values.' });
        }
        let changes;
        try { changes = writeServiceSettings(body.changes, { dataDir: DATA_DIR }); }
        catch (error) { return send(res, error.code === 'DATA_NOT_WRITABLE' ? 500 : 400, { ok: false, error: error.message }); }
        applyServiceSettings(cfg, changes);
        if (engine.cfg !== cfg) applyServiceSettings(engine.cfg, changes);
        const settings = serviceSettingsView(engine.cfg);
        if (engine.state) {
          engine.state.serviceSettings = settings;
          engine.state.quotaThresholds = {
            warnPercent: engine.cfg.quota?.warnPercent ?? 90,
            criticalPercent: engine.cfg.quota?.criticalPercent ?? 98,
          };
          broadcast('state', engine.state);
        }
        return send(res, 200, { ok: true, settings });
      }
      if (p === '/api/settings/prices' && req.method === 'GET') {
        return send(res, 200, { unit: 'USD per million tokens', costLabel: COST_LABEL, prices: loadPrices(DATA_DIR), defaults: defaultPrices(), overrides: readPriceOverrides(DATA_DIR) });
      }
      if (p === '/api/settings/prices' && req.method === 'PUT') {
        let body;
        try { body = await jsonBody(req); }
        catch (error) { return send(res, 400, { ok: false, error: error.message }); }
        try { writePriceOverrides(body, { dataDir: DATA_DIR }); }
        catch (error) { return send(res, error.code === 'EACCES' || error.code === 'EROFS' ? 500 : 400, { ok: false, error: error.message }); }
        return send(res, 200, { ok: true, unit: 'USD per million tokens', costLabel: COST_LABEL, prices: loadPrices(DATA_DIR), defaults: defaultPrices(), overrides: readPriceOverrides(DATA_DIR) });
      }
      if (p === '/api/policy' && req.method === 'GET') return send(res, 200, loadPolicy());
      if (p === '/api/policy' && req.method === 'PUT') {
        const notes = [];
        const errors = savePolicy(await jsonBody(req), loadModels(), { quotas: engine.state?.quotas || [], now: Date.now(), notes });
        if (errors.length) return send(res, 400, { ok: false, errors });
        const state = await engine.tick();
        return send(res, 200, { ok: true, policy: loadPolicy(), control: state.control, notes });
      }
      // The watch uses the same functions as the CLI. The routes stay under the read-only preview guard and the access control.
      // The old /api/night paths stay as aliases of /api/watch.
      const watchPath = p.replace(/^\/api\/night(?=\/|$)/, '/api/watch');
      // The routine routes edit the machine-level override in the data directory. They never change a kit file.
      const routineRoute = /^\/api\/watch\/routines(?:\/([^/]+))?$/.exec(watchPath);
      if (routineRoute) {
        let id = null;
        try { id = routineRoute[1] ? decodeURIComponent(routineRoute[1]) : null; } catch { return send(res, 400, { error: 'The routine id is not valid.' }); }
        const options = { dataDir: DATA_DIR, kitRoot: engine.kitRoot };
        if (!id && req.method === 'GET') return send(res, 200, { routines: effectiveRoutines(options) });
        if (id && req.method === 'PUT') {
          let routine;
          try { routine = saveRoutine(id, await jsonBody(req), options); } catch (error) { return send(res, 400, { error: error.message }); }
          await engine.tick();
          return send(res, 200, { ok: true, routine });
        }
        if (id && req.method === 'DELETE') {
          let removed;
          try { removed = resetRoutine(id, options); } catch (error) { return send(res, 400, { error: error.message }); }
          await engine.tick();
          return send(res, 200, { ok: true, removed, routines: effectiveRoutines(options) });
        }
      }
      if (watchPath === '/api/watch/stop' && req.method === 'POST') {
        clearNight({ dataDir: DATA_DIR });
        const state = await engine.tick();
        return send(res, 200, { ok: true, night: state?.night ?? { active: false } });
      }
      if (watchPath === '/api/watch/start' && req.method === 'POST') {
        const body = await jsonBody(req);
        let built;
        try {
          built = buildWatchRecord({
            until: body.until,
            untilCancelled: body.untilCancelled === true,
            report: body.report,
            retro: body.retro,
            by: 'dashboard',
            quietHours: typeof body.quietHours === 'boolean' ? body.quietHours : cfg.watch?.quietHours === true,
            routines: body.routines,
            adhoc: body.adhoc,
            kitRoot: engine.kitRoot,
          });
        } catch (error) { return send(res, 400, { error: error.message }); }
        writeNight(built.record, { dataDir: DATA_DIR });
        // The choice of this watch is the default of the next watch.
        if (built.choice) rememberChoice(built.choice, { dataDir: DATA_DIR, kitRoot: engine.kitRoot });
        const state = await engine.tick();
        return send(res, 200, { ok: true, warning: built.warning, night: state?.night ?? readNight({ dataDir: DATA_DIR }) });
      }
      if (watchPath === '/api/watch' && req.method === 'GET') return send(res, 200, readNight({ dataDir: DATA_DIR }));
      if (p === '/api/denials' && req.method === 'GET') return send(res, 200, denialSummary(readDenials(DATA_DIR), Date.now(), { pendingBytes: engine.memory?.denialScan?.pendingBytes || 0 }));
      if (p === '/api/machine-hours' && req.method === 'GET') {
        // The route parses up to two 3 MB files, so the result is kept for 60 seconds for each window.
        const days = clampSummaryDays(url.searchParams.get('days'));
        const hit = machineHoursCache.get(days);
        if (hit && Date.now() - hit.at < MACHINE_HOURS_CACHE_MS) return send(res, 200, hit.body);
        const body = summarizeHours({ dataDir: DATA_DIR, days });
        machineHoursCache.set(days, { at: Date.now(), body });
        return send(res, 200, body);
      }
      if (p === '/api/analytics' && req.method === 'GET') {
        // Aggregate figures for the Analytics charts. The route reads the tail of the event log and the samples, so it keeps the result for 60 seconds.
        if (analyticsCache && Date.now() - analyticsCache.at < MACHINE_HOURS_CACHE_MS) return send(res, 200, analyticsCache.body);
        analyticsCache = { at: Date.now(), body: analyticsSummary({ dataDir: DATA_DIR }) };
        return send(res, 200, analyticsCache.body);
      }
      if (p === '/api/spend' && req.method === 'GET') return send(res, 200, spendSummary({ dataDir: DATA_DIR, days: clampSpendDays(url.searchParams.get('days')) }));
      if (p === '/api/usage' && req.method === 'GET') return send(res, 200, usageSummary());
      if (p === '/api/usage' && req.method === 'POST') {
        const result = recordUsage(await jsonBody(req));
        return send(res, result.errors.length ? 400 : 200, { ok: !result.errors.length, ...result });
      }
      if (p === '/api/browser-sessions' && req.method === 'GET') {
        const sessions = await Promise.all(Object.values(listBrowserSessions()).map(browserStatus));
        // The CDP probe state comes from the last engine tick.
        return send(res, 200, withProbeState(sessions, engine.state?.managedBrowsers));
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
      if (p === '/api/browser-sessions/bookmarks' && req.method === 'GET') {
        const project = url.searchParams.get('project');
        if (!engine.state?.control?.projects?.[project]) return send(res, 404, { error: 'Unknown open project.' });
        try { return send(res, 200, listBookmarks(project)); }
        catch (e) { return send(res, 400, { error: e.message }); }
      }
      if (p === '/api/browser-sessions/bookmarks' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (!engine.state?.control?.projects?.[body.project]) return send(res, 404, { error: 'Unknown open project.' });
        try {
          if (body.action === 'add') return send(res, 200, addBookmark(body.project, { name: body.name, url: body.url }));
          if (body.action === 'rename') return send(res, 200, renameBookmark(body.project, body.index, body.name));
          if (body.action === 'move') return send(res, 200, moveBookmark(body.project, body.index, body.to));
          if (body.action === 'remove') return send(res, 200, removeBookmark(body.project, body.index));
          if (body.action === 'start') return send(res, 200, setStartPage(body.project, body.url ?? null));
          return send(res, 400, { error: 'Unknown bookmark action.' });
        } catch (e) { return send(res, 400, { error: e.message }); }
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
      if (p === '/api/browser-sessions/tab-close' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (!engine.state?.control?.projects?.[body.project]) return send(res, 404, { error: 'Unknown open project.' });
        if (typeof body.tabId !== 'string' || !body.tabId) return send(res, 400, { error: 'tabId is required.' });
        try { return send(res, 200, await closeTab(body.project, body.tabId, { force: body.force === true })); }
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
      if (p === '/api/messages' && req.method === 'GET') {
        const thread = url.searchParams.get('thread');
        if (!validThread(thread)) return send(res, 400, { error: 'Choose a thread: boss or a project slug.' });
        const records = readMessages();
        return send(res, 200, messagesWithReplyState(listThread(thread), records));
      }
      if (p === '/api/messages' && req.method === 'POST') {
        const knownThreads = new Set(['boss', ...Object.keys(engine.state?.control?.projects || {})]);
        const result = validateOwnerSend(await jsonBody(req), { knownThreads, records: readMessages(), now: Date.now() });
        if (result.error) return send(res, result.status, { error: result.error });
        const message = appendMessage(result.fields);
        // Only a mail item closes. An Owner message that names a plain chat reply leaves that reply as it is.
        if (message.replyTo && isMailRecord(readMessages().find((item) => item.id === message.replyTo))) closeMailboxItem(message.replyTo);
        engine.log('message', `Queued Owner ${message.kind} ${message.id} for ${message.thread}`, { id: message.id, thread: message.thread, kind: message.kind, replyTo: message.replyTo });
        const mailbox = refreshMailbox(readMessages(), true);
        return send(res, 200, { ok: true, message, mailbox });
      }
      if (p === '/api/messages/read' && req.method === 'POST') {
        const result = markMailboxRead(await jsonBody(req));
        if (result.error) return send(res, result.status, { error: result.error });
        return send(res, 200, { ...result, mailbox: refreshMailbox(readMessages(), true) });
      }
      if (p === '/api/messages/dismiss' && req.method === 'POST') {
        const result = dismissMailboxItems(await jsonBody(req));
        if (result.error) return send(res, result.status, { error: result.error });
        return send(res, 200, { ...result, mailbox: refreshMailbox(readMessages(), true) });
      }
      if (p === '/api/messages/keep-open' && req.method === 'POST') {
        const result = keepMailboxItemsOpen(await jsonBody(req));
        if (result.error) return send(res, result.status, { error: result.error });
        return send(res, 200, { ...result, mailbox: refreshMailbox(readMessages(), true) });
      }
      if (p === '/api/mailbox' && req.method === 'GET') {
        const records = readMessages();
        const folder = url.searchParams.get('folder');
        const thread = url.searchParams.get('thread');
        if (folder != null && !['needs-you', 'inbox', 'updates', 'sent', 'done'].includes(folder)) return send(res, 400, { error: 'Choose a mailbox folder: needs-you, inbox, updates, sent, or done.' });
        if (thread != null) {
          if (!validThread(thread)) return send(res, 400, { error: 'Choose a thread: boss or a project slug.' });
          const conversationId = url.searchParams.get('conversation');
          if (conversationId != null) {
            const group = groupMessagesByConversation(records.filter((record) => record.thread === thread)).find((item) => item.id === conversationId);
            if (!group) return send(res, 404, { error: 'This conversation is no longer in the mailbox.' });
            const messages = messagesWithReplyState(group.records.slice(-200), records).map((record) => ({ ...record, conversationId: group.id }));
            return send(res, 200, { thread, conversationId: group.id, messages });
          }
          const conversations = groupMessagesByConversation(records.filter((record) => record.thread === thread));
          return send(res, 200, conversations.map((group) => ({
            id: group.id,
            thread: group.thread,
            latestAt: group.latestAt,
            messages: messagesWithReplyState(group.records.slice(-200), records).map((record) => ({ ...record, conversationId: group.id })),
          })));
        }
        if (folder != null) {
          const folders = mailboxFolders(records);
          const items = folders[folder === 'needs-you' ? 'needsYou' : folder];
          return send(res, 200, { ...folders, folder, items, mailbox: refreshMailbox(records) });
        }
        return send(res, 200, { ...mailboxView(records), mailbox: refreshMailbox(records) });
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
        if (!handoffSourceMatches(engine.state, body)) return send(res, 400, { error: 'Unknown current orchestrator pane.' });
        if (!['codex', 'claude', 'opencode', 'pi'].includes(body.to) || !['migrate', 'fresh'].includes(body.mode) || typeof body.model !== 'string') return send(res, 400, { error: 'Choose a target harness, model, and handover mode.' });
        return send(res, 200, await handoffCommand(['plan', body.pane, '--to', body.to, '--model', body.model, '--mode', body.mode, ...(body.effort ? ['--effort', body.effort] : [])]));
      }
      if (p === '/api/handoffs/prepare' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (!handoffSourceMatches(engine.state, body)) return send(res, 400, { error: 'Unknown current orchestrator pane.' });
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
      const avatar = /^\/api\/avatars\/([^/]+)$/.exec(p);
      if (avatar) {
        const slug = avatar[1];
        if (!validAvatarSlug(slug)) return send(res, 400, { error: 'Choose boss or a project slug of lower-case letters, digits, and hyphens.' });
        if (req.method === 'GET') {
          const found = avatarFile(slug);
          if (!found) return send(res, 404, { error: 'No image is stored for this avatar. The page uses the generated one.' });
          return send(res, 200, fs.readFileSync(found.file), AVATAR_TYPES[found.ext]);
        }
        const known = slug === 'boss' || Boolean(engine.state?.control?.projects?.[slug]);
        if (req.method === 'POST') {
          if (!known) return send(res, 404, { error: 'No open project uses this slug.' });
          const declared = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
          if (declared && !AVATAR_DECLARED.includes(declared)) return send(res, 415, { error: 'Send a PNG, JPEG, or WebP image. SVG and other formats are refused.' });
          const body = await readBytes(req, AVATAR_MAX_BYTES);
          const ext = avatarFormat(body);
          if (!ext) return send(res, 415, { error: 'The file is not a PNG, JPEG, or WebP image. SVG and other formats are refused.' });
          fs.mkdirSync(AVATARS_DIR, { recursive: true, mode: 0o700 });
          for (const old of Object.keys(AVATAR_TYPES)) fs.rmSync(path.join(AVATARS_DIR, `${slug}${old}`), { force: true });
          const file = path.join(AVATARS_DIR, `${slug}${ext}`);
          fs.writeFileSync(file, body, { mode: 0o600 });
          fs.chmodSync(file, 0o600);
          engine.log('message', `The Owner stored a ${ext.slice(1).toUpperCase()} avatar image for ${slug}`);
          return send(res, 200, { ok: true, slug, type: AVATAR_TYPES[ext] });
        }
        if (req.method === 'DELETE') {
          const found = avatarFile(slug);
          if (!found) return send(res, 404, { error: 'No image is stored for this avatar. The page uses the generated one.' });
          fs.rmSync(found.file, { force: true });
          engine.log('message', `The Owner removed the avatar image of ${slug}`);
          return send(res, 200, { ok: true, slug, generated: true });
        }
      }
      if (p === '/api/projects' && req.method === 'GET') return send(res, 200, decorateProjects(listProjects()));
      const pm = /^\/api\/projects\/([^/]+)$/.exec(p);
      if (pm && (req.method === 'PUT' || req.method === 'POST')) {
        let data;
        try { data = await jsonBody(req); } catch (e) { return send(res, 400, { ok: false, errors: [`invalid JSON: ${e.message}`] }); }
        const submitted = structuredClone(data);
        const errors = writeProject(pm[1], data);
        if (!errors.length) {
          closeResolvedOnPublish(pm[1], submitted, { log: (line) => engine.log('message', line) });
          refreshMailbox(readMessages(), true);
        }
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
      const code = Number.isInteger(e.statusCode) ? e.statusCode : e instanceof SyntaxError || e.message.includes('Content-Type') || p.startsWith('/api/handoffs/') ? 400 : 500;
      send(res, code, { error: e.message });
    }
  });

  server.listen(cfg.port, bindHost, () => {
    console.log(`herdr-boss: http://${bindHost}:${cfg.port} (push ${engine.push ? 'on' : 'off'})`);
  });

  server.on('close', () => {
    closed = true;
    clearTimeout(timer);
    clearTimeout(debounce);
    projectsWatcher.close();
    stopMessageWatch();
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
    stopMessageWatch();
  };
  return { server, engine, close };
}
