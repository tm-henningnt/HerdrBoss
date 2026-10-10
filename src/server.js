import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Engine, standDownPlan } from './engine.js';
import { initializeLifecyclePort } from './kit/lifecycle.js';
import { checkMachineTools } from './collect.js';
import { ownerReleaseLease, withResourcePoolMutation, readLeases, leasePools, publicPool, hasIdleRule, tcpListeningAsync } from './leases.js';
import { PROJECTS_DIR, DATA_DIR, DEFAULT_SESSION_FILE, PRIVATE_ACCESS_DIR, assertPreviewDataDir, assertLiveDataDir, hostAllowedByList, writeServiceSettings, applyServiceSettings, serviceSettingsView, validateResourcePools, writeResourcePools } from './config.js';
import { writeProject, listProjects, SLUG } from './projects.js';
import { importProjectRegister, readRegister } from './project-register.js';
import { loadModels } from './kit/config.js';
import { backupPolicyFile, loadPolicy, removePolicyProjectDraft, savePolicy, policyShareGuard } from './control.js';
import { recordUsage, usageSummary } from './usage.js';
import { spendSummary, clampSpendDays, loadPrices, defaultPrices, readPriceOverrides, writePriceOverrides, COST_LABEL } from './spend.js';
import { readDenials, denialSummary } from './denials.js';
import { summarizeHours, clampSummaryDays, latestMachineSample } from './machine-samples.js';
import { analyticsSummary } from './analytics.js';
import { buildWatchRecord, clearNight, readNight, readStandDown, writeNight, writeStandDown } from './night.js';
import { effectiveRoutines, rememberChoice, resetRoutine, saveRoutine } from './watch-routines.js';
import { withProbeState } from './browser-probe.js';
import { maskDeep, maskBrowserState, maskBrowserText } from './browser-url-mask.js';
import { requestBrowser, listBrowserSessions, browserStatus, setBrowserWindowSize, closeBrowser, restartBrowser, listBookmarks, addBookmark, renameBookmark, moveBookmark, removeBookmark, setStartPage, bookmarkUrl } from './browser-pool.js';
import { listBrowserTabs, browserScreenshot, browserNavigate, browserNavigationState, browserHistoryAction, browserClick, browserInsertText, browserKey, browserNewTab, browserCloseTab, tabAttached } from './browser-preview.js';
import { listHandoffs } from './handoff.js';
import { watchReleaseAnswers } from './release.js';
import { createHerdrRunner } from './kit/workers.js';
import { roamgateAvailable, roamgateUrl } from './roamgate.js';
import { createAccessControl, loginPage } from './access.js';
import { createRotatingLog } from './server-log.js';
import { createHealth } from './health.js';
import { readServiceVersion } from './service-version.js';
import { createFleetPoller } from './fleet-poller.js';
import { readFleetFile } from './fleet-store.js';
import { createFleetReadAccess, createFleetGuideAccess } from './fleet-access.js';
import { createFleetGuidance } from './fleet-guidance.js';
import { createFleetShares } from './fleet-shares.js';
import { createFleetRole } from './fleet-role.js';
import { createFleetSettings } from './fleet-settings.js';
import { createProjectTransfer } from './project-transfer.js';
import { readProjectTransferLock } from './project-transfer-locks.js';
import { buildFleetSummary, fleetSpend } from './fleet-summary.js';
import { buildFleetRollup } from './fleet-rollup.js';
import { readFleetLogins } from './fleet-login.js';
import { appendMessage, chatSummaries, isMailAnswer, isMailRecord, messagesById, chatThreadPage, closeMailboxItem, closeResolvedOnPublish, dismissMailboxItems, keepMailboxItemsOpen, groupMessagesByConversation, listThread, mailboxCounts, mailboxFolders, mailboxView, markMailboxRead, messageChannel, messagesWithReplyState, readMessages, validOwnerClientId, validThread, validateOwnerSend, ownerSendMatches, withMailAnswers } from './messages.js';
import { assertSqliteAvailable } from './sqlite-store.js';
import { openMessageStore } from './message-store.js';
import { listAgentPairs, readAgentMessages, readAgentMetadata } from './agent-messages.js';
import { BODY_LIMIT as PROJECT_NEW_BODY_LIMIT, createProjectNewApi } from './project-new-api.js';
import { createProjectRegisterApi } from './project-register-api.js';
import { projectRegisterCommand } from './project-register-cli.js';
import { checkProject } from './project-new-check.js';
import { decideProjectRegisterTriage } from './project-register-triage.js';
import { BODY_LIMIT as HOST_GUIDE_BODY_LIMIT, createHostGuideApi } from './host-guide.js';
import { createGoalApi } from './goal-api.js';
import { createReviewApi } from './review-api.js';
import { handleModelsApi } from './api/models.js';
import { createRawRoute } from './review-raw.js';
import * as reviewStore from './review-store.js';
import { attachState } from './factory-store.js';
import { createDocsSite, IMAGE_TYPES as DOC_IMAGE_TYPES } from './docs-site.js';
import { ATTACHMENT_ID, ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES, UPLOAD_LIMIT_PER_MINUTE, readAttachment, storeAttachment } from './attachments.js';
import { postTodo, actOnTodo, cancelTodo, replyToTodo, migrateTodo } from './owner-todo.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const defaultDocsSite = createDocsSite({ root: path.dirname(DOCS) });
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
  if (res.browserOutput && !Buffer.isBuffer(body)) {
    const options = typeof res.browserOutput === 'object' ? res.browserOutput : {};
    body = maskDeep(body, options);
  }
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
        chunks.length = 0;
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

async function readBody(req, limit = 1024 * 1024, raw = false) {
  const bytes = await readBytes(req, limit);
  return raw ? bytes : bytes.toString('utf8');
}

// The host list of the control plane: a loopback name, a Tailscale name, or an address of this machine.
// The allowedHosts setting adds host names to this rule. The default list is empty.
function allowedHost(req, extraHosts = []) {
  const hostname = (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  const localAddresses = Object.values(os.networkInterfaces()).flat().filter(Boolean).map((iface) => iface.address.toLowerCase());
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname) || hostname.endsWith('.ts.net') || localAddresses.includes(hostname.replace(/^\[|\]$/g, '')) || hostAllowedByList(hostname, extraHosts);
}

function allowedRequest(req, pathname, extraHosts = []) {
  const host = req.headers.host || '';
  if (!allowedHost(req, extraHosts)) return false;
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
async function attachedGuard(body, checkAttached = tabAttached) {
  if (body.confirmAttached === true) return null;
  try { if (await checkAttached(body.project, body.tab)) return { error: 'An agent is using this tab. Navigation or input can disturb its work. Confirm to continue, or open a new tab.', attached: true }; }
  catch {}
  return null;
}

// The body of a project-new POST route: a JSON object of at most 16 KB. A bad body has a status code for the route.
async function projectNewBody(req, limit = PROJECT_NEW_BODY_LIMIT) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw Object.assign(new Error('Content-Type must be application/json.'), { statusCode: 400 });
  const bytes = await readBytes(req, limit);
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw Object.assign(new Error('The body is not valid JSON.'), { statusCode: 400 }); }
}

async function jsonBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Content-Type must be application/json.');
  return JSON.parse(await readBody(req));
}

function queryLimit(url, max, label, fallback = 100) {
  const value = url.searchParams.get('limit');
  const limit = value === null ? fallback : Number(value);
  if ((value !== null && !/^\d+$/.test(value)) || !Number.isInteger(limit) || limit < 1 || limit > max) {
    return { error: `The ${label} limit must be an integer from 1 to ${max}.` };
  }
  return { limit };
}

function validQueryTime(value) {
  if (value === null) return true;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  const date = value.slice(0, 10);
  const dayStart = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(Date.parse(value)) && Number.isFinite(dayStart) && new Date(dayStart).toISOString().slice(0, 10) === date;
}

const MACHINE_HOURS_CACHE_MS = 60000;

const PREVIEW_DEFAULT_HOST = '127.0.0.1';
// The guide credential permits only these routes. A peer factory uses them for guidance, the head office role, handover, and project transfer.
const FLEET_GUIDE_ROUTES = ['POST /api/fleet/guidance', 'POST /api/fleet/role', 'GET /api/fleet/role', 'GET /api/fleet/handover', 'POST /api/fleet/transfer', 'GET /api/fleet/transfer'];

// A preview bind address is an IP address or a host name. An empty value is refused.
export function assertPreviewHost(host) {
  const value = typeof host === 'string' ? host.trim() : '';
  const hostname = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
  if (!value || !(net.isIP(value) || hostname.test(value))) {
    throw new Error('--host needs an IP address or a host name, for example --host 127.0.0.1.');
  }
  return value;
}

export function serve(cfg, { readOnlyPreview = false, previewHost, liveDataDir, createEngine = (config, options) => new Engine(config, options), rawTokens, closeTab = browserCloseTab, browserActions = {}, projectNew = {}, goalSet = {}, machineTools = {}, health = createHealth(), readVersion = readServiceVersion, fleet = {}, docsSite = defaultDocsSite, hostGuide = {}, todoHerdr = createHerdrRunner() } = {}) {
  initializeLifecyclePort();
  const browser = { browserStatus, listBrowserTabs, browserScreenshot, browserNavigate, browserNavigationState, browserHistoryAction, browserClick, browserInsertText, browserKey, browserNewTab, requestBrowser, tabAttached, ...browserActions };
  let uploads = [];
  const machineHoursCache = new Map();
  let analyticsCache = null;
  // Check a direct serve() call before credentials, the watcher, or a tick writes a file.
  if (readOnlyPreview) assertPreviewDataDir();
  else assertLiveDataDir(liveDataDir);
  if (previewHost !== undefined && !readOnlyPreview) throw new Error('previewHost (--host) is valid only together with --read-only-preview.');
  // The preview has no login. It binds loopback unless the caller names another address. The main service keeps cfg.host.
  const bindHost = readOnlyPreview ? (previewHost === undefined ? PREVIEW_DEFAULT_HOST : assertPreviewHost(previewHost)) : cfg.host;
  const fleetSettings = createFleetSettings({ dir: DATA_DIR, cfg });
  const fleetReadAccess = createFleetReadAccess({ privateDir: fleet.privateDir || PRIVATE_ACCESS_DIR, now: fleet.now });
  const fleetGuideAccess = createFleetGuideAccess({ privateDir: fleet.privateDir || PRIVATE_ACCESS_DIR, dir: DATA_DIR, now: fleet.now });
  assertSqliteAvailable();
  openMessageStore({ dir: DATA_DIR, backend: cfg.store?.messages });
  const access = readOnlyPreview ? null : createAccessControl(cfg.access.tokenFile, {
    sessionFile: DEFAULT_SESSION_FILE,
    sessionDays: cfg.access.sessionDays,
    privateDirectory: PRIVATE_ACCESS_DIR,
  });
  const engine = readOnlyPreview ? createEngine(cfg, { push: false, act: false }) : createEngine(cfg);
  // Register import and onboarding checks read synchronous snapshots. The engine runner returns CLI replies.
  const readRegisterHerdr = async () => {
    const commands = ['workspace', 'pane', 'agent'];
    const replies = await Promise.all(commands.map(async (command) => {
      try {
        const output = await engine.herdrRunner('herdr', [command, 'list']);
        const data = typeof output === 'string' ? JSON.parse(output) : output;
        return data?.error ? null : data?.result ?? data;
      } catch { return null; }
    }));
    return ([command, action, flag, workspace]) => {
      const reply = replies[commands.indexOf(command)];
      if (command === 'pane' && action === 'list' && flag === '--workspace') {
        const panes = Array.isArray(reply) ? reply : reply?.panes || [];
        return { panes: panes.filter((pane) => (pane.workspace_id ?? pane.workspaceId ?? pane.workspace) === workspace) };
      }
      return reply;
    };
  };
  const serviceVersion = readVersion();
  const fleetGuidance = createFleetGuidance({ dir: DATA_DIR, settings: fleetSettings.read, now: fleet.now,
    deliver: async (text) => {
      const herdr = engine.state?.herdr;
      const boss = herdr?.panes?.find((pane) => pane.label === 'boss' && pane.agent);
      if (!boss || typeof engine.promptService !== 'function') throw new Error('boss-unavailable');
      await engine.promptService(boss.id, text, { herdr, messages: [{ text, kind: 'nudge' }] });
    } });
  const projectTransfer = createProjectTransfer({ role: 'target', dataDir: DATA_DIR,
    privateDir: fleet.privateDir || PRIVATE_ACCESS_DIR, settings: fleetSettings.read,
    registryFile: fleet.registryFile, fetchImpl: fleet.fetchImpl, config: cfg, ...fleet.projectTransfer });
  const fleetShares = createFleetShares({ dir: DATA_DIR, privateDir: fleet.privateDir || PRIVATE_ACCESS_DIR,
    settings: fleetSettings.read, receiver: fleetGuidance, registryFile: fleet.registryFile, fetchImpl: fleet.fetchImpl, now: fleet.now });
  const fleetRole = createFleetRole({ dir: DATA_DIR, privateDir: fleet.privateDir || PRIVATE_ACCESS_DIR, settings: fleetSettings.read,
    registryFile: fleet.registryFile, fetchImpl: fleet.fetchImpl, now: fleet.now });
  // The tool check runs beside the first tick. Its warnings are logged when they arrive.
  if (!readOnlyPreview) {
    checkMachineTools(machineTools).then((warnings) => {
      for (const warning of warnings) { engine.log('warn', warning); console.warn(`herdr-boss: ${warning}`); }
    }).catch((e) => engine.log('error', `machine tool check failed: ${e.message}`));
  }
  const messageStore = openMessageStore({ dir: DATA_DIR });
  const projectNewApi = createProjectNewApi({ dataDir: DATA_DIR, log: (level, text) => engine.log(level, text), ...projectNew });
  const runRegisterLifecycle = async (action, args) => {
    const { projectLifecycleCommand } = await import('./project-lifecycle.js');
    return projectLifecycleCommand(action, args, {
      env: {},
      herdr: (herdrArgs, options) => engine.herdrRunner('herdr', herdrArgs, options),
      dataDir: DATA_DIR,
      registerSettings: { cap: engine.cfg?.register?.cap ?? cfg.register?.cap ?? 3, capCountsPinned: engine.cfg?.register?.capCountsPinned ?? cfg.register?.capCountsPinned ?? false },
      auditBy: 'owner-page',
      log: () => {},
    });
  };
  const projectRegisterApi = createProjectRegisterApi({
    dataDir: DATA_DIR,
    readOnly: readOnlyPreview,
    runLifecycle: runRegisterLifecycle,
    policyProjects: () => Object.keys(loadPolicy().projects || {}),
    runRegisterAdd: (slug) => projectRegisterCommand(['add', slug], {
      env: {}, herdr: (args, options) => engine.herdrRunner('herdr', args, options), dataDir: DATA_DIR, log: () => {},
    }),
    openCount: () => readRegister(DATA_DIR).projects.filter((record) => ['open', 'parking'].includes(record.state)).length,
    cap: engine.cfg?.register?.cap ?? cfg.register?.cap ?? 3,
    getOnboarding: async (slug) => {
      if (readOnlyPreview || typeof engine.herdrRunner !== 'function') return null;
      try {
        const check = checkProject(slug, { dataDir: DATA_DIR, home: os.homedir(), requireWorkspace: true,
          herdr: await readRegisterHerdr() });
        const good = (name) => check.items.some((item) => item.name === name && item.ok);
        return { kitInstalled: good('kit'), workspace: good('workspace'), orchestrator: good('orchestrator') };
      } catch { return null; }
    },
    runTriageDecision: (itemId, decision) => decideProjectRegisterTriage({
      dataDir: DATA_DIR, itemId, decision, runLifecycle: runRegisterLifecycle,
    }),
  });
  const hostGuideApi = createHostGuideApi({ dataDir: DATA_DIR, ...hostGuide });
  // The goal routes use the Herdr runner of the engine. A test replaces run.
  const goalApi = createGoalApi({
    run: async (args, options) => {
      const out = await engine.herdrRunner('herdr', args, options);
      if (args[1] === 'read' || typeof out !== 'string') return out;
      try { return JSON.parse(out); } catch { return out; }
    },
    control: () => engine.state?.control || {},
    policy: () => loadPolicy(),
    dataDir: DATA_DIR,
    log: (level, text) => engine.log(level, text),
    ...goalSet,
  });
  const clients = new Set();
  // The server log goes to standard output and to service.log in the data directory. The file rotates by size.
  // launchd writes standard output to server.log, so the rotating file is a separate file.
  const logFile = createRotatingLog({ file: path.join(DATA_DIR, 'service.log'), maxBytes: () => (cfg.log?.maxMegabytes ?? 10) * 1024 * 1024, keepFiles: () => cfg.log?.keepFiles ?? 2 });
  const serverLog = (text, isError = false) => {
    (isError ? console.error : console.log)(text);
    logFile.write(`${new Date().toISOString()} ${text}`);
  };
  // The review pages update a second device through `review` events: ids and numbers only, never content.
  const reviewApi = createReviewApi({ dataDir: DATA_DIR, onChange: (event) => broadcast('review', event) });
  // The raw route serves legacy HTML pages to a sandboxed frame. Its tokens stay in memory. See src/review-raw.js.
  const reviewRaw = createRawRoute({ dataDir: DATA_DIR, hostAllowed: (req) => allowedHost(req, cfg.allowedHosts), tokens: rawTokens });
  const localFleetSummary = async () => {
    const healthBody = await health(engine);
    if (healthBody.error) throw new Error('Factory health is unavailable.');
    // Only a factory container reports the helper. A native factory never reads a Claude settings file for it.
    const claudeHelper = await (async () => {
      try {
        const { isInsideContainer } = await import('./factory-core.js');
        if (!isInsideContainer()) return undefined;
        return (await import('./factory-claude-helper.js')).claudeHelperState({ home: os.homedir() });
      } catch { return undefined; }
    })();
    return buildFleetSummary({ settings: fleetSettings.read(), state: engine.state, health: healthBody, serviceVersion, claudeHelper,
      ownerItems: readMessages(), logins: await readFleetLogins(), machineSample: latestMachineSample(), spend: fleetSpend(spendSummary({ days: 7 })),
      reviewPacks: (reviewStore.packHeads({ dir: DATA_DIR }).length ? reviewStore.listPacks({ dir: DATA_DIR }) : []).map((pack) => ({ id: `${pack.slug}-${pack.pack}`.slice(0, 64), waitingItems: pack.counts.open || 0 })) });
  };
  const fleetPoller = createFleetPoller({ dir: DATA_DIR, localSummary: localFleetSummary,
    enabled: () => !readOnlyPreview && fleetSettings.read().headOffice && fleetRole.holds(),
    onSummary: async (record) => { await fleetRole.retry(record); await fleetShares.retry(record); },
    credentials: () => readFleetFile(path.join(fleet.privateDir || PRIVATE_ACCESS_DIR, 'fleet-remotes.json'), {}), ...fleet });
  const fleetClock = fleet.now || Date.now;
  const FLEET_ROUTE_POLL_MS = 30000;
  let lastRoutePoll = 0;
  let closed = false;
  let timer;
  let tickPromise;
  let debounce;
  let policyDebounce;
  let registerImport = Promise.resolve();
  const importRegister = () => {
    if (readOnlyPreview || typeof engine.herdrRunner !== 'function') return Promise.resolve();
    registerImport = registerImport.catch(() => {}).then(async () => {
      if (closed) return;
      const herdr = await readRegisterHerdr();
      if (closed) return;
      return importProjectRegister({
        dataDir: DATA_DIR,
        herdr,
        log: (line) => engine.log('register', line),
        warn: (line) => engine.log('warning', line),
      });
    });
    return registerImport;
  };
  const refreshRegister = async () => {
    try { await importRegister(); } catch (error) { engine.log('error', `project register import failed: ${error.message}`); }
  };

  // The Chat page ignores a record with mailAnswer set. The service knows the parent record, and the page may not.
  const annotateMessage = (data) => {
    const record = data?.record;
    if (!record || record.from !== 'owner' || !record.replyTo) return data;
    const parent = readMessages().find((item) => item.id === record.replyTo);
    return isMailAnswer(record, messagesById(parent ? [parent] : [])) ? { ...data, record: { ...record, mailAnswer: true } } : data;
  };
  const dashboardState = (data) => {
    const register = readRegister(DATA_DIR).projects;
    const policy = loadPolicy();
    const slugs = new Set([...Object.keys(policy.projects || {}), ...Object.keys(data.control?.projects || {}), ...register.map((record) => record.slug)]);
    const projectTransfers = [...slugs].flatMap((slug) => {
      try {
        const lock = readProjectTransferLock(slug, { dataDir: DATA_DIR });
        if (!lock) return [];
        const factory = /^[a-z0-9][a-z0-9-]{0,63}$/.test(lock.peerFactoryId) ? lock.peerFactoryId : null;
        return [{ slug, side: lock.side, factory }];
      } catch {
        // Keep an unreadable lock visible. Never expose the lock record or its error text.
        return [{ slug, side: null, factory: null }];
      }
    });
    return {
      ...data,
      version: serviceVersion,
      projectTransfers,
      ...(Array.isArray(engine.dashboardManagedBrowsers) ? { managedBrowsers: engine.dashboardManagedBrowsers } : {}),
      projectRegisterSlugs: register.map(({ slug }) => slug),
      projectRegister: register.map((record) => ({
        slug: record.slug, title: record.title, group: record.group, clientTag: record.clientTag,
        state: record.state, pinned: record.pinned, priority: record.priority,
        share: policy.projects?.[record.slug]?.share ?? 0,
      })),
    };
  };
  const pageRequest = (req, { eventSource = false, url } = {}) => {
    if (!eventSource || req.headers['x-herdr-boss-caller'] === 'page' || url?.searchParams.get('caller') !== 'page') return req;
    const marked = Object.create(req);
    marked.headers = { ...req.headers, 'x-herdr-boss-caller': 'page' };
    return marked;
  };
  const hasSameOriginBrowserSignal = (req) => {
    if (req.headers['sec-fetch-site'] === 'same-origin') return true;
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (typeof origin !== 'string' || typeof host !== 'string') return false;
    try {
      const scheme = req.socket?.encrypted ? 'https' : 'http';
      const dashboardOrigin = new URL(`${scheme}://${host}`).origin;
      const parsedOrigin = new URL(origin);
      return parsedOrigin.origin === dashboardOrigin
        && parsedOrigin.origin === origin
        && parsedOrigin.pathname === '/'
        && !parsedOrigin.search
        && !parsedOrigin.hash;
    } catch { return false; }
  };
  const tenantHostsVisible = (req, options) => {
    if (cfg.browser?.showTenantHosts !== true || !hasSameOriginBrowserSignal(req)) return false;
    const marked = pageRequest(req, options);
    return access ? access.owner(marked) : loopbackRequest(req) && marked.headers['x-herdr-boss-caller'] === 'page';
  };
  const broadcast = (event, data) => {
    if (event === 'message') data = annotateMessage(data);
    if (event === 'event') data = maskDeep(data);
    if (event === 'state') {
      const state = dashboardState(data);
      for (const res of clients) {
        const full = res.tenantHostsVisible?.() === true;
        res.write(`event: state\ndata: ${JSON.stringify(maskBrowserState(state, { full }))}\n\n`);
      }
      return;
    }
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  };
  // A publish runs in the CLI process. At each state push, the service compares the current version and the state of
  // each pack with the last push and sends one `review` event for each change. The first push only records them.
  let reviewHeads = null;
  const pushReviewHeads = () => {
    let heads;
    try { heads = reviewStore.packHeads({ dir: DATA_DIR }); } catch { return; }
    const next = new Map(heads.map((head) => [`${head.slug}/${head.pack}`, head]));
    if (reviewHeads) {
      for (const [key, head] of next) {
        const before = reviewHeads.get(key);
        if (!before || before.version !== head.version || before.state !== head.state) broadcast('review', { slug: head.slug, pack: head.pack, version: head.version, state: head.state });
      }
    }
    reviewHeads = next;
  };
  // Error and guard events also reach the server log. Other events stay in events.jsonl.
  engine.on('event', (event) => { if (['error', 'guard'].includes(event?.type)) serverLog(`${event.type}: ${event.text}`, event.type === 'error'); });
  engine.on('state', (s) => { broadcast('state', s); pushReviewHeads(); });
  engine.on('message', (event) => broadcast('message', event));
  const stopMessageWatch = messageStore.onChange((event) => {
    if (event.record?.kind === 'agent') return;
    if (typeof engine.observeMessageChange === 'function') engine.observeMessageChange(event);
    else broadcast('message', event);
  });

  // A release approval that the Owner answers sends one notice to the requesting pane. Nothing polls.
  const stopReleaseWatch = readOnlyPreview ? () => {} : watchReleaseAnswers(messageStore, { dir: DATA_DIR, herdr: createHerdrRunner() });

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
    debounce = setTimeout(async () => {
      if (closed || !engine.state) return;
      await refreshRegister();
      if (closed) return;
      engine.state.projects = decorateProjects(listProjects());
      broadcast('state', engine.state);
    }, 300);
  });
  projectsWatcher.on('error', (error) => {
    if (!closed) engine.log('error', `Project watcher failed: ${error.message}`);
  });
  const policyWatcher = fs.watch(DATA_DIR, (_event, filename) => {
    if (String(filename || '') !== 'policy.json') return;
    clearTimeout(policyDebounce);
    policyDebounce = setTimeout(async () => {
      if (closed) return;
      await refreshRegister();
      if (closed) return;
      void engine.tick();
    }, 300);
  });
  policyWatcher.on('error', (error) => {
    if (!closed) engine.log('error', `Policy watcher failed: ${error.message}`);
  });

  // The one policy save path of the page routes. The Allocation page and the stand-down buttons both call it, so
  // every change reaches the policy change log. It returns { status, body } for the caller to send.
  // confirmed and allowSum belong to the request, not to the policy. The caller header is a label and proves no identity.
  const applyPolicyDraft = async (draft, req, { confirmed = false, allowSum = false } = {}) => {
    const notes = [];
    const options = { quotas: engine.state?.quotas || [], now: Date.now(), notes, caller: req.headers['x-herdr-boss-caller'] === 'page' ? 'page' : 'unknown' };
    const errors = savePolicy(draft, loadModels(), { ...options, dryRun: true });
    if (errors.length) return { status: 400, body: { ok: false, errors } };
    const refusal = policyShareGuard(loadPolicy(), draft, { confirmed: confirmed === true, allowSum: allowSum === true });
    if (refusal) return { status: refusal.status, body: { ok: false, error: refusal.error, changed: refusal.changed, sum: refusal.sum } };
    savePolicy(draft, loadModels(), options);
    await refreshRegister();
    const state = await engine.tick();
    return { status: 200, body: { ok: true, policy: loadPolicy(), control: state?.control, notes } };
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const isBrowserOutput = p === '/api/browser-sessions' || p.startsWith('/api/browser-sessions/');
    res.browserOutput = isBrowserOutput ? { full: tenantHostsVisible(req) } : false;
    try {
      if (readOnlyPreview && !loopbackRequest(req)) return send(res, 403, { error: 'The read-only preview accepts only local requests.' });
      const fleetRead = fleetReadAccess.check(req);
      if (fleetRead.present && (!fleetRead.authorized || req.method !== 'GET' || !['/api/fleet/summary', '/api/health'].includes(p))) {
        return send(res, 403, { error: 'The fleetRead credential permits only GET summary and health.' });
      }
      const fleetGuide = fleetGuideAccess.check(req);
      if (fleetGuide.present && (!fleetGuide.authorized || !FLEET_GUIDE_ROUTES.includes(`${req.method} ${p}`))) {
        return send(res, 403, { error: 'The fleetGuide credential permits only guidance, role, handover, and transfer routes.' });
      }
      if (!fleetGuide.authorized && FLEET_GUIDE_ROUTES.includes(`${req.method} ${p}`)) return send(res, 401, { error: 'A fleetGuide credential is required.' });
      // The raw route runs before allowedRequest(): a request from the opaque origin of the frame is cross-site and has no cookie.
      // The route checks the host list and the token itself.
      // It tests the path as sent: the URL parser would fold a `..` part away and hide it from the route.
      if (req.url.startsWith('/review-raw/')) return reviewRaw.handle(req, res);
      if (!allowedRequest(req, p, cfg.allowedHosts)) return send(res, 403, { error: 'This control plane requires a local interface or Tailscale host and a same-origin request.' });
      // The project-new GET routes show local paths, so the preview refuses them too.
      const projectNewRoute = p === '/api/project-new' || p.startsWith('/api/project-new/');
      // The host guide holds the values that the user typed about a host, so the preview refuses its GET routes too.
      const hostGuideRoute = p === '/api/host-guide' || p.startsWith('/api/host-guide/');
      if (readOnlyPreview && p.startsWith('/api/') && (projectNewRoute || hostGuideRoute || !['GET', 'HEAD'].includes(req.method))) {
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
      if (!readOnlyPreview && !fleetRead.authorized && !fleetGuide.authorized && !access.authorized(req, res)) {
        if (req.method === 'GET' && !p.startsWith('/api/') && (req.headers.accept || '').includes('text/html')) {
          res.writeHead(303, { location: '/login', 'cache-control': 'no-store' });
          return res.end();
        }
        return send(res, 401, { error: 'Access token required.' });
      }
      // Check the raw route too: URL normalization must not hide traversal behind the app shell.
      if (p === '/attachments' || req.url.startsWith('/attachments/') || p.startsWith('/attachments/')) {
        const route = req.url.split('?')[0];
        const id = route.slice('/attachments/'.length);
        if (req.method !== 'GET' || !ATTACHMENT_ID.test(id)) return send(res, 404, { error: 'Attachment not found.' });
        const attachment = readAttachment(id);
        const download = ['image/heic', 'image/heif'].includes(attachment.type);
        res.writeHead(200, {
          'content-type': attachment.type, 'content-length': attachment.size,
          'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=3600',
          'content-security-policy': "default-src 'none'; sandbox",
          'content-disposition': download ? `attachment; filename="${attachment.name.replace(/[^\x20-\x7e]/g, '_')}"` : 'inline',
        });
        return res.end(attachment.bytes);
      }
      if (p === '/api/attachments' && req.method === 'POST') {
        const now = Date.now(); uploads = uploads.filter((at) => at > now - 60000);
        if (uploads.length >= UPLOAD_LIMIT_PER_MINUTE) return send(res, 429, { error: 'Herdr Boss accepts at most 30 picture uploads a minute.' });
        uploads.push(now);
        const declaredLength = Number(req.headers['content-length']);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_ATTACHMENT_BYTES) {
          req.resume();
          return send(res, 413, { error: 'The picture exceeds the 10 MB limit.' });
        }
        const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (!Object.hasOwn(ATTACHMENT_TYPES, type)) return send(res, 415, { error: 'Send a JPEG, PNG, WebP, GIF, HEIC or HEIF picture.' });
        let name;
        try { name = decodeURIComponent(req.headers['x-filename'] || ''); }
        catch { return send(res, 400, { error: 'X-Filename must be URL-encoded.' }); }
        if (name.length > 120) return send(res, 400, { error: 'X-Filename must be at most 120 characters.' });
        const attachment = storeAttachment(await readBody(req, MAX_ATTACHMENT_BYTES, true), { type, name, now });
        engine.log('attachment', `Stored picture ${attachment.id}`, { id: attachment.id, type: attachment.type, size: attachment.size });
        return send(res, 200, attachment);
      }
      if (handleModelsApi(req, res, { pathname: p, send, loadModels })) return;
      if (p.startsWith('/api/goal/')) {
        const routed = await goalApi.handle(req.method, p, () => projectNewBody(req));
        return send(res, routed.status, routed.body);
      }
      if (projectNewRoute) {
        const routed = await projectNewApi.handle(req.method, p, () => projectNewBody(req));
        return send(res, routed.status, routed.body);
      }
      if (p === '/api/project-register' || p.startsWith('/api/project-register/')) {
        let body;
        if (req.method === 'POST') {
          try { body = await jsonBody(req); }
          catch (error) { return send(res, 400, { ok: false, error: error.message }); }
        }
        const routed = await projectRegisterApi.handle(req.method, p, body);
        if (routed) return send(res, routed.status, routed.body);
      }
      // A change of the host guide and each check are actions: only the owner may run them.
      if (hostGuideRoute) {
        const routed = await hostGuideApi.handle(req.method, p, () => projectNewBody(req, HOST_GUIDE_BODY_LIMIT), { owner: access.owner(req) });
        return send(res, routed ? routed.status : 404, routed ? routed.body : { error: 'not found' });
      }
      // The review routes sit behind the same checks. The read-only preview guard above already refuses each change.
      const rawToken = /^\/api\/reviews\/([^/]+)\/([^/]+)\/raw-token$/.exec(p);
      if (rawToken) return reviewRaw.issue(req, res, ...rawToken.slice(1, 3).map((part) => { try { return decodeURIComponent(part); } catch { return ''; } }), url);
      if (p === '/api/reviews' || p.startsWith('/api/reviews/')) return await reviewApi.handle(req, res, url);
      if (p === '/api/fleet/settings' && req.method === 'GET') return send(res, 200, fleetSettings.view());
      if (p === '/api/fleet/guidance' && req.method === 'POST') {
        try { return send(res, 200, await fleetGuidance.accept(await jsonBody(req))); }
        catch (error) { return send(res, error.status || 400, { error: error.status ? error.message : 'The guidance could not be accepted.' }); }
      }
      if (p === '/api/fleet/role' && req.method === 'GET') {
        try { return send(res, 200, fleetRole.view()); }
        catch { return send(res, 503, { error: 'The head office role cannot be read.' }); }
      }
      if (p === '/api/fleet/role' && req.method === 'POST') {
        try { return send(res, 200, fleetRole.accept(await jsonBody(req))); }
        catch (error) { return send(res, error.status || 400, { error: error.status ? error.message : 'The role record could not be accepted.' }); }
      }
      if (p === '/api/fleet/handover' && req.method === 'GET') {
        try { return send(res, 200, fleetRole.handover()); }
        catch (error) { return send(res, error.status || 503, { error: error.status ? error.message : 'The handover cannot be read.' }); }
      }
      if (p === '/api/fleet/transfer' && req.method === 'POST') {
        const result = await projectTransfer.submit(await jsonBody(req));
        return send(res, result.status, result.body);
      }
      if (p === '/api/fleet/transfer' && req.method === 'GET') {
        const result = projectTransfer.jobStatus(url.searchParams.get('slug'), url.searchParams.get('jobId'));
        return send(res, result.status, result.body);
      }
      if (p === '/api/fleet/shares' && req.method === 'GET') {
        try { return send(res, 200, fleetShares.view()); }
        catch { return send(res, 200, { accounts: [], deliveries: [], error: 'The factory shares could not be read.' }); }
      }
      if ((p === '/api/fleet/shares' && req.method === 'PUT') || (p === '/api/fleet/nudge' && req.method === 'POST')) {
        try { return send(res, 200, await (p.endsWith('/shares') ? fleetShares.save(await jsonBody(req)) : fleetShares.nudge(await jsonBody(req)))); }
        catch (error) { return send(res, error.status || 400, { error: error.status ? error.message : 'The fleet guidance could not be sent.' }); }
      }
      if (p === '/api/fleet/settings' && req.method === 'PUT') {
        try { fleetSettings.write(await jsonBody(req)); return send(res, 200, fleetSettings.view()); }
        catch { return send(res, 400, { error: 'The fleet settings are invalid.' }); }
      }
      if (p === '/api/fleet/summary' && req.method === 'GET') return send(res, 200, await localFleetSummary());
      if (p === '/api/fleet' && req.method === 'GET') {
        // An empty view starts a poll at most once in 30 seconds.
        if (!fleetPoller.view().factories.length && (fleetClock() - lastRoutePoll >= FLEET_ROUTE_POLL_MS || lastRoutePoll === 0)) { lastRoutePoll = fleetClock(); await fleetPoller.poll(); }
        const view = fleetPoller.view();
        const factories = view.factories.map((row) => (row.remote ? { ...row, attach: attachState(process.env, row.name) } : row));
        let role = null;
        try { role = fleetRole.view(); } catch { /* The page shows no role when the settings are invalid. */ }
        // The rollup is one add-only field. Its failure must not fail the route, and its error must carry no stack or path.
        let rollup = null, rollupError = null;
        try { rollup = buildFleetRollup(factories, { now: fleetClock, role }); }
        catch { rollupError = 'The fleet rollup is unavailable.'; }
        return send(res, 200, { ...view, role, rollup, ...(rollupError ? { rollupError } : {}), factories });
      }
      if (p === '/api/health' && req.method === 'GET') {
        const body = await health(engine);
        return send(res, body.error ? 503 : 200, body);
      }
      if (p === '/api/quota-plan/codex' && req.method === 'GET') {
        if (engine.state?.quotas?.some((row) => row.provider === 'codex' && !row.error)) {
          try { engine.quotaPlanService.replan({ provider: 'codex', quotas: engine.state.quotas, now: Date.now() }); }
          catch { /* Return the last saved plan when a current reading cannot make a new one. */ }
        }
        return send(res, 200, engine.quotaPlanService.get({ provider: 'codex', now: Date.now() }));
      }
      if (p === '/api/quota-plan/codex/announce' && req.method === 'POST') {
        if (!access?.owner(req)) return send(res, 403, { error: 'Only the Owner can announce a Codex reset.' });
        let body;
        try { body = await jsonBody(req); }
        catch (error) { return send(res, 400, { error: error.message }); }
        const extra = Object.keys(body || {}).find((key) => !['at', 'kind', 'refund', 'refundPercent'].includes(key));
        if (extra !== undefined) return send(res, 400, { error: `Unknown field: ${extra.slice(0, 40)}.` });
        try {
          const result = engine.quotaPlanService.announce({
            provider: 'codex', at: body.at, kind: body.kind ?? 'full',
            refundPercent: body.refundPercent ?? body.refund ?? 0,
            quotas: engine.state?.quotas || [], now: Date.now(),
          });
          if (engine.state) {
            engine.state.quotaPlanSummary = engine.quotaPlanService.summary({ now: Date.now() });
            broadcast('state', engine.state);
          }
          return send(res, 200, { ok: true, announcement: { id: result.id, at: result.at, kind: result.kind, ...(result.kind === 'partial' ? { refundPercent: result.refundPercent } : {}) }, plan: result.plan });
        } catch (error) { return send(res, 400, { error: error.message }); }
      }
      if (p === '/api/state') {
        if (engine.state) {
          refreshMailbox();
          if (typeof engine.decorateProjects === 'function') engine.state.projects = decorateProjects(listProjects());
        }
        return send(res, 200, maskBrowserState(dashboardState(engine.state || {}), { full: tenantHostsVisible(req) }));
      }
      if (p === '/api/worker-brief' && req.method === 'GET') {
        const brief = typeof engine.readWorkerBrief === 'function' ? engine.readWorkerBrief(url.searchParams.get('project'), url.searchParams.get('name')) : null;
        return brief ? send(res, 200, brief) : send(res, 404, { error: 'No brief is stored for this worker.' });
      }
      if (p === '/api/chats' && req.method === 'GET') {
        const projects = engine.state?.control?.projects || {};
        const writable = new Map([['boss', { title: 'Boss' }]]);
        for (const [thread, project] of Object.entries(projects)) {
          if (project?.orch?.pane) writable.set(thread, { title: String(project.project || project.title || thread) });
        }
        const records = messageStore.all();
        const byId = messagesById(records);
        const stored = new Map(chatSummaries(records).map((chat) => [chat.thread, chat]));
        const mailUnreadByThread = new Map();
        for (const item of records) {
          if (item.to !== 'owner' || item.readAt || messageChannel(item, byId) !== 'mail') continue;
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
              channel: messageChannel(record, byId),
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
          const byId = messagesById(records);
          let count = 0;
          for (const record of records) {
            if (record.thread === thread && record.to === 'owner' && !record.readAt && messageChannel(record, byId) !== 'mail') {
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
        const byId = messagesById(everything);
        const page = chatThreadPage(everything, thread, { before, limit: limit + 1 });
        const more = page.length > limit;
        const messages = withMailAnswers(messagesWithReplyState(more ? page.slice(1) : page, everything), everything)
          .map((record) => ({ ...record, channel: messageChannel(record, byId) }));
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
      if (p === '/api/pools' && req.method === 'GET') {
        const { pools, errors } = leasePools(engine.cfg ?? cfg);
        return send(res, 200, { pools: pools.map(publicPool), errors });
      }
      if (p === '/api/pools' && req.method === 'PUT') {
        const body = await jsonBody(req);
        if (!body || !['create', 'update', 'remove'].includes(body.action)) return send(res, 400, { error: 'action must be create, update, or remove.' });
        const pool = body.pool;
        if (!pool || typeof pool !== 'object' || Array.isArray(pool) || typeof pool.name !== 'string' || !pool.name) {
          return send(res, 400, { error: 'pool.name is required.' });
        }
        if (pool.name === 'project-browsers') return send(res, 400, { error: 'project-browsers is a built-in pool and cannot be changed.' });

        // Probe the ports that holders lease now, before the lock. The check below needs to know which of them have a listener.
        const listening = new Map();
        try {
          await Promise.all(readLeases(DATA_DIR).leases.filter((lease) => lease.pool === pool.name)
            .map(async (lease) => { listening.set(lease.item, await tcpListeningAsync(lease.item)); }));
        } catch {}
        const dashboardPort = server.address()?.port ?? cfg.port;

        const changed = withResourcePoolMutation((leases, { dropLeases }) => {
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
          const stored = index === -1 ? null : currentPools[index];

          // A port value of null keeps the stored value of the same variable and ports. An empty string clears it.
          let next = pool;
          if (body.action !== 'remove') {
            const missing = [];
            let portEnv;
            if (pool.portEnv && typeof pool.portEnv === 'object' && !Array.isArray(pool.portEnv)) {
              portEnv = {};
              for (const [name, entries] of Object.entries(pool.portEnv)) {
                if (!entries || typeof entries !== 'object' || Array.isArray(entries)) { portEnv[name] = entries; continue; }
                portEnv[name] = {};
                for (const [spec, value] of Object.entries(entries)) {
                  if (value === '') continue;
                  if (value === null) {
                    const kept = stored?.portEnv?.[name]?.[spec];
                    if (typeof kept === 'string') portEnv[name][spec] = kept;
                    else missing.push(`${name} ${spec}`);
                  } else portEnv[name][spec] = value;
                }
                if (!Object.keys(portEnv[name]).length) delete portEnv[name];
              }
              if (!Object.keys(portEnv).length) portEnv = undefined;
            } else portEnv = pool.portEnv;
            if (missing.length) return { status: 400, error: `No stored value to keep for ${missing.join(', ')}. Enter a value.` };
            next = { ...pool };
            if (portEnv === undefined) delete next.portEnv; else next.portEnv = portEnv;
          }

          let candidate = null;
          if (body.action !== 'remove') {
            const checkedPool = validateResourcePools([next], { dashboardPort });
            if (checkedPool.errors.length) return { status: 400, error: checkedPool.errors.join(' '), errors: checkedPool.errors };
            candidate = checkedPool.pools[0];
            const protectedItems = candidate.items.filter((item) => /^\d+$/.test(item) && Number(item) >= 9222 && Number(item) <= 9299);
            if (protectedItems.length) return { status: 400, error: `Items from 9222 to 9299 are reserved for project browsers: ${protectedItems.join(', ')}.` };
          }

          let nextPools;
          if (body.action === 'create') nextPools = [...currentPools, next];
          else if (body.action === 'update') nextPools = currentPools.map((item, itemIndex) => itemIndex === index ? next : item);
          else nextPools = currentPools.filter((_, itemIndex) => itemIndex !== index);

          const checked = validateResourcePools(nextPools, { dashboardPort });
          if (checked.errors.length) return { status: 400, error: checked.errors.join(' '), errors: checked.errors };

          // A port that a holder still uses stays in the pool. A lease that is unbound and has had no listener for idleMinutes does not count.
          const oldPool = validateResourcePools(stored ? [stored] : []).pools[0];
          const idleMs = (oldPool?.idleMinutes ?? 20) * 60000;
          const dropped = [];
          for (const held of leases.filter((lease) => lease.pool === pool.name && (body.action === 'remove' || !candidate.items.includes(lease.item)))) {
            const idleSince = Date.parse(held.idleSince ?? held.at);
            const idle = oldPool && hasIdleRule(oldPool) && held.pid == null && listening.get(held.item) === false
              && Number.isFinite(idleSince) && Date.now() - idleSince >= idleMs;
            if (idle) { dropped.push(held); continue; }
            const holder = { pool: held.pool, item: held.item, project: held.project, pane: held.pane || null, worker: held.worker || null };
            const location = [held.pane && `pane ${held.pane}`, held.worker && `worker ${held.worker}`].filter(Boolean).join(', ');
            return { status: 409, error: `Resource pool ${pool.name} cannot be ${body.action === 'remove' ? 'removed' : 'updated'} while item ${held.item} is held by project ${held.project}${location ? ` (${location})` : ''}.`, holder };
          }

          writeResourcePools(nextPools);
          if (dropped.length) dropLeases((lease) => dropped.includes(lease));
          return { status: 200, pools: checked.pools };
        });
        if (changed.status !== 200) return send(res, changed.status, { error: changed.error, ...(changed.errors ? { errors: changed.errors } : {}), ...(changed.holder ? { holder: changed.holder } : {}) });
        engine.setResourcePools(changed.pools);
        return send(res, 200, { ok: true, pools: changed.pools.map(publicPool) });
      }
      if (p === '/api/roamgate' && req.method === 'GET') return send(res, 200, { available: await roamgateAvailable(cfg) });
      if (p === '/roamgate' && req.method === 'GET') {
        if (!(await roamgateAvailable(cfg))) return send(res, 503, { error: 'Roamgate is unavailable.' });
        res.writeHead(302, { location: roamgateUrl(req.headers.host, cfg), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        return res.end();
      }
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
        if (Object.keys(changes).some((setting) => setting.startsWith('quotaPlan.')) && engine.quotaPlanService) {
          engine.quotaPlanService.configure(engine.cfg.quotaPlan);
          if (engine.state?.quotas?.some((row) => row.provider === 'codex' && !row.error)) {
            try { engine.quotaPlanService.replan({ provider: 'codex', quotas: engine.state.quotas, now: Date.now(), force: true }); }
            catch { /* The next quota tick can make a fresh plan. */ }
          }
        }
        analyticsCache = null;
        const settings = serviceSettingsView(engine.cfg);
        if (engine.state) {
          engine.state.serviceSettings = settings;
          engine.state.quotaThresholds = {
            warnPercent: engine.cfg.quota?.warnPercent ?? 90,
            criticalPercent: engine.cfg.quota?.criticalPercent ?? 98,
          };
          if (engine.quotaPlanService) engine.state.quotaPlanSummary = engine.quotaPlanService.summary({ now: Date.now() });
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
      const removePolicyMatch = /^\/api\/policy\/projects\/([^/]+)$/.exec(p);
      if (removePolicyMatch && req.method === 'DELETE') {
        let slug;
        try { slug = decodeURIComponent(removePolicyMatch[1]); } catch { return send(res, 400, { ok: false, error: 'The project slug is not valid.' }); }
        if (!SLUG.test(slug)) return send(res, 400, { ok: false, error: 'The project slug is not valid.' });
        const saved = loadPolicy();
        if (!Object.hasOwn(saved.projects || {}, slug)) return send(res, 404, { ok: false, error: 'The project is not in policy.' });
        const next = removePolicyProjectDraft(saved, slug);
        const validation = savePolicy(next, loadModels(), { dryRun: true });
        if (validation.length) return send(res, 400, { ok: false, errors: validation });
        const refusal = policyShareGuard(saved, next, { confirmed: true, allowSum: true });
        if (refusal) return send(res, refusal.status, { ok: false, error: refusal.error });
        try { backupPolicyFile(path.join(DATA_DIR, 'policy.json'), DATA_DIR); }
        catch (error) { return send(res, 500, { ok: false, error: `The policy backup could not be written: ${error.message}` }); }
        const result = await applyPolicyDraft(next, req, { confirmed: true, allowSum: true });
        return send(res, result.status, result.status === 200 ? { ...result.body, backupCreated: true } : result.body);
      }
      if (p === '/api/policy' && req.method === 'PUT') {
        const body = await jsonBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { ok: false, error: 'The body must be a JSON object.' });
        const { confirmed, allowSum, ...draft } = body;
        const result = await applyPolicyDraft(draft, req, { confirmed, allowSum });
        return send(res, result.status, result.body);
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
      // The stand-down buttons of the Watch page. They park the idle project orchestrators with the policy mode
      // paused and undo it. Every mode change goes through the same policy save path as the Allocation page.
      if ((watchPath === '/api/watch/standdown' || watchPath === '/api/watch/standdown/undo') && req.method === 'POST') {
        const undo = watchPath === '/api/watch/standdown/undo';
        // The plan reads the panes and the modes of the last tick. A tick first, so the plan sees the state now.
        await engine.tick();
        const standDown = readStandDown({ dataDir: DATA_DIR });
        const previous = standDown?.projects || {};
        const policy = loadPolicy();
        const draft = { ...policy, projects: { ...(policy.projects || {}) } };
        const changed = [];
        let result = {};
        let parked = [];
        if (undo) {
          // Only a project that is still paused returns to its own mode.
          for (const [slug, mode] of Object.entries(previous)) {
            if ((draft.projects[slug]?.mode ?? 'auto') !== 'paused') continue;
            changed.push(slug);
          }
          result = { restored: changed.sort() };
        } else {
          const plan = standDownPlan(engine.state?.control, engine.state?.herdr);
          parked = plan.parked;
          changed.push(...plan.parked.map((item) => item.slug));
          result = { paused: changed.sort(), skipped: plan.skipped };
        }
        if (changed.length) {
          // A project that has no saved share takes a share from the derived weights, so the saved shares keep
          // adding up to 100. The mode of a project that is already in the mark stays the mode of the first press.
          const weight = (slug) => Number.isInteger(engine.state?.control?.projects?.[slug]?.share) ? engine.state.control.projects[slug].share : 1;
          const entries = {};
          const open = [];
          for (const slug of changed) {
            const saved = draft.projects[slug] || {};
            const derived = engine.state?.control?.projects?.[slug] || {};
            const share = Number.isInteger(saved.share) ? saved.share : Number.isInteger(derived.share) ? derived.share : null;
            entries[slug] = {
              share,
              mode: undo ? previous[slug] : 'paused',
              excludedKinds: Array.isArray(saved.excludedKinds) ? saved.excludedKinds : Array.isArray(derived.excludedKinds) ? derived.excludedKinds : [],
              excludedModels: Array.isArray(saved.excludedModels) ? saved.excludedModels : Array.isArray(derived.excludedModels) ? derived.excludedModels : [],
            };
            if (share === null) open.push(slug);
          }
          // Share what the other projects leave. A project that already has a saved share keeps it, so only the
          // projects without a share take a part of what is left.
          const rest = Math.max(0, 100 - [...new Set([...Object.keys(draft.projects), ...changed])].reduce((sum, slug) => {
            const share = entries[slug]?.share ?? draft.projects[slug]?.share;
            return sum + (Number.isInteger(share) ? share : 0);
          }, 0));
          // A floor for each project, then one more for each project with the largest remainder.
          const total = open.reduce((sum, slug) => sum + weight(slug), 0);
          open.sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));
          const remainders = [];
          for (const slug of open) {
            const exact = total ? rest * weight(slug) / total : 0;
            entries[slug].share = Math.floor(exact);
            remainders.push([slug, exact - Math.floor(exact)]);
          }
          // What the floors leave over goes one by one to the projects with the largest remainder.
          let left = rest - open.reduce((sum, slug) => sum + entries[slug].share, 0);
          remainders.sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
          for (const [slug] of remainders) if (left-- > 0) entries[slug].share += 1;
          Object.assign(draft.projects, entries);
          // The route changes no share of the Owner. The share guard asks its questions for a change that the
          // Owner made on purpose, so the route passes the two confirmations of the Allocation page.
          const saved = await applyPolicyDraft(draft, req, { confirmed: true, allowSum: true });
          // A refused write leaves the stored mark and the stored policy as they are.
          if (saved.status !== 200) return send(res, saved.status, saved.body);
        }
        // The mark is written after the policy save. A second press keeps the mode of every project of the mark and
        // adds the projects of this press. The undo clears the mark, also when it restored nothing.
        if (undo) writeStandDown(null, { dataDir: DATA_DIR });
        else if (changed.length) writeStandDown({ at: new Date().toISOString(), projects: { ...Object.fromEntries(parked.map((item) => [item.slug, item.mode])), ...previous } }, { dataDir: DATA_DIR });
        const state = await engine.tick();
        return send(res, 200, { ok: true, night: state?.night ?? readNight({ dataDir: DATA_DIR }), ...result });
      }
      if (p === '/api/denials' && req.method === 'GET') return send(res, 200, denialSummary(readDenials(DATA_DIR), Date.now(), { pendingBytes: engine.memory?.denialScan?.pendingBytes || 0 }));
      if (p === '/api/machine-hours' && req.method === 'GET') {
        // The route parses up to two 3 MB files, so the result is kept for 60 seconds for each window.
        const days = clampSummaryDays(url.searchParams.get('days'));
        const hit = machineHoursCache.get(days);
        if (hit && Date.now() - hit.at < MACHINE_HOURS_CACHE_MS) return send(res, 200, hit.body);
        const body = { ...summarizeHours({ dataDir: DATA_DIR, days }), minFreeGb: Number.isSafeInteger(cfg.worktrees?.minFreeGb) ? cfg.worktrees.minFreeGb : 8 };
        machineHoursCache.set(days, { at: Date.now(), body });
        return send(res, 200, body);
      }
      if (p === '/api/analytics' && req.method === 'GET') {
        // Aggregate figures for the Analytics charts. The route reads the tail of the event log and the samples, so it keeps the result for 60 seconds.
        if (analyticsCache && Date.now() - analyticsCache.at < MACHINE_HOURS_CACHE_MS) return send(res, 200, analyticsCache.body);
        analyticsCache = { at: Date.now(), body: analyticsSummary({ dataDir: DATA_DIR, actionsMinutesEnabled: cfg.analytics?.actionsMinutes !== false }) };
        return send(res, 200, analyticsCache.body);
      }
      if (p === '/api/spend' && req.method === 'GET') return send(res, 200, spendSummary({ dataDir: DATA_DIR, days: clampSpendDays(url.searchParams.get('days')) }));
      if (p === '/api/usage' && req.method === 'GET') return send(res, 200, usageSummary());
      if (p === '/api/usage' && req.method === 'POST') {
        const result = recordUsage(await jsonBody(req));
        return send(res, result.errors.length ? 400 : 200, { ok: !result.errors.length, ...result });
      }
      if (p === '/api/browser-sessions' && req.method === 'GET') {
        const sessions = await Promise.all(Object.values(listBrowserSessions()).map(browser.browserStatus));
        // The CDP probe state comes from the last engine tick.
        return send(res, 200, withProbeState(sessions, engine.state?.managedBrowsers));
      }
      if (p === '/api/browser-sessions/tabs' && req.method === 'GET') {
        const project = url.searchParams.get('project');
        if (!engine.state?.control?.projects?.[project]) return send(res, 404, { error: 'Unknown open project.' });
        try { return send(res, 200, await browser.listBrowserTabs(project)); }
        catch (e) { return send(res, 409, { error: e.message }); }
      }
      if (p === '/api/browser-sessions/screenshot' && req.method === 'GET') {
        const project = url.searchParams.get('project');
        if (!engine.state?.control?.projects?.[project]) return send(res, 404, { error: 'Unknown open project.' });
        try { return send(res, 200, await browser.browserScreenshot(project, url.searchParams.get('tab')), 'image/jpeg'); }
        catch (e) { return send(res, 409, { error: e.message }); }
      }
      if (p === '/api/browser-sessions/navigation' && req.method === 'GET') {
        const project = url.searchParams.get('project');
        if (!engine.state?.control?.projects?.[project]) return send(res, 404, { error: 'Unknown open project.' });
        try { return send(res, 200, await browser.browserNavigationState(project, url.searchParams.get('tab'))); }
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
          if (body.action === 'add-current') {
            const tabs = await browser.listBrowserTabs(body.project);
            const tab = body.tab ? tabs.find((entry) => entry.id === body.tab) : tabs.length === 1 ? tabs[0] : null;
            if (!tab) throw new Error('Select an open tab to bookmark.');
            const name = maskBrowserText(tab.title || tab.url, { full: true }).slice(0, 60);
            return send(res, 200, addBookmark(body.project, { name, url: tab.url }));
          }
          if (body.action === 'open') {
            const index = Number(body.index);
            const bookmark = Number.isInteger(index) && index >= 0 ? listBookmarks(body.project).bookmarks[index] : null;
            if (!bookmark) throw new Error('Bookmark index is out of range.');
            if (body.newTab === true) return send(res, 200, await browser.browserNewTab(body.project, bookmark.url));
            const guard = await attachedGuard(body, browser.tabAttached);
            if (guard) return send(res, 409, guard);
            return send(res, 200, await browser.browserNavigate(body.project, body.tab, bookmark.url));
          }
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
        const guard = await attachedGuard(body, browser.tabAttached);
        if (guard) return send(res, 409, guard);
        try { return send(res, 200, await browser.browserNavigate(body.project, body.tab, body.url)); }
        catch (e) { return send(res, 409, { error: e.message }); }
      }
      if (p === '/api/browser-sessions/history' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (!engine.state?.control?.projects?.[body.project]) return send(res, 404, { error: 'Unknown open project.' });
        const guard = await attachedGuard(body, browser.tabAttached);
        if (guard) return send(res, 409, guard);
        try { return send(res, 200, await browser.browserHistoryAction(body.project, body.tab, body.action)); }
        catch (e) { return send(res, 409, { error: e.message }); }
      }
      // The sign-in task types a password and a one-time code into a signed-in browser. Only the owner may use it.
      const signInDenied = () => !readOnlyPreview && !access.owner(req);
      if (p === '/api/browser-sessions/sign-in' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (signInDenied()) return send(res, 403, { error: 'Only the owner can use browser sign-in.' });
        if (!engine.state?.control?.projects?.[body.project]) return send(res, 404, { error: 'Unknown open project.' });
        // The bookmark validator allows http and https only and refuses a user name or a password in the address.
        let target;
        try { target = bookmarkUrl(body.url); } catch { return send(res, 400, { error: 'Enter an http or https address without a user name or a password.' }); }
        try {
          await browser.requestBrowser(body.project, { headless: true });
          const tab = await browser.browserNewTab(body.project, target);
          return send(res, 200, { ok: true, tab: tab.id });
        } catch (e) { return send(res, 409, { error: e.message }); }
      }
      if (p === '/api/browser-sessions/input' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (body.signIn === true && signInDenied()) return send(res, 403, { error: 'Only the owner can use browser sign-in.' });
        if (!engine.state?.control?.projects?.[body.project]) return send(res, 404, { error: 'Unknown open project.' });
        const guard = await attachedGuard(body, browser.tabAttached);
        if (guard) return send(res, 409, guard);
        try {
          if (body.type === 'click') return send(res, 200, await browser.browserClick(body.project, body.tab, body.x, body.y));
          if (body.type === 'text') return send(res, 200, await browser.browserInsertText(body.project, body.tab, body.text));
          if (body.type === 'key') return send(res, 200, await browser.browserKey(body.project, body.tab, body.key, {}, body.modifiers ?? []));
          return send(res, 400, { error: 'Unknown browser input type.' });
        } catch (e) {
          // A protocol error can repeat the typed text. Remove it before the error leaves the server.
          const message = typeof body.text === 'string' && body.text ? e.message.split(body.text).join('<redacted>') : e.message;
          return send(res, 409, { error: message });
        }
      }
      if (p === '/api/browser-sessions/new-tab' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (!engine.state?.control?.projects?.[body.project]) return send(res, 404, { error: 'Unknown open project.' });
        try { return send(res, 200, await browser.browserNewTab(body.project)); }
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
      if (p === '/api/todo/post' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['text', 'caller', 'priority', 'blocks'].includes(key))) return send(res, 400, { error: 'Send text, caller, and optional priority and blocks. The caller decides the project.' });
        try {
          const item = postTodo(body.text, { priority: body.priority, blocks: body.blocks }, { env: body.caller || {}, herdr: todoHerdr, control: engine.state?.control, store: messageStore });
          return send(res, 200, { ok: true, item, mailbox: refreshMailbox(readMessages(), true) });
        } catch (error) { return send(res, error.status || 400, { error: error.message }); }
      }
      if (p === '/api/todo/migrate' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'caller')) return send(res, 400, { error: 'Send only the verified caller for migration.' });
        try {
          const result = migrateTodo({}, { env: body.caller || {}, herdr: todoHerdr, control: engine.state?.control, store: messageStore });
          return send(res, 200, { ...result, mailbox: refreshMailbox(readMessages(), true) });
        } catch (error) { return send(res, error.status || 400, { error: error.message }); }
      }
      if (p === '/api/todo/cancel' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['key', 'note', 'caller'].includes(key))) return send(res, 400, { error: 'Send an item key, caller, and optional note.' });
        try {
          const result = cancelTodo(body.key, body.note, { env: body.caller || {}, herdr: todoHerdr, control: engine.state?.control, store: messageStore });
          return send(res, 200, { ...result, mailbox: refreshMailbox(readMessages(), true) });
        } catch (error) { return send(res, error.status || 400, { error: error.message }); }
      }
      if (p === '/api/todo/action' && req.method === 'POST') {
        const body = await jsonBody(req);
        try {
          const result = actOnTodo(body, { store: messageStore });
          return send(res, 200, { ...result, mailbox: refreshMailbox(readMessages(), true) });
        } catch (error) { return send(res, error.status || 400, { error: error.message }); }
      }
      if (p === '/api/messages' && req.method === 'GET') {
        const thread = url.searchParams.get('thread');
        if (!validThread(thread)) return send(res, 400, { error: 'Choose a thread: boss or a project slug.' });
        const records = readMessages();
        return send(res, 200, messagesWithReplyState(listThread(thread), records));
      }
      if (p === '/api/messages' && req.method === 'POST') {
        const knownThreads = new Set(['boss', ...Object.keys(engine.state?.control?.projects || {})]);
        const body = await jsonBody(req);
        if (body?.clientId !== undefined && !validOwnerClientId(body.clientId)) return send(res, 400, { error: 'clientId must be 1 to 128 letters, numbers, or . _ : - characters.' });
        const records = readMessages();
        const existing = body?.clientId ? records.find((record) => record.from === 'owner' && record.clientId === body.clientId) : null;
        if (existing) {
          if (!ownerSendMatches(existing, body)) return send(res, 409, { error: 'This clientId already belongs to a different message.' });
          const reply = existing.replyTo ? records.find((record) => record.id === existing.replyTo) : null;
          if (reply && !reply.closedAt && isMailRecord(reply)) closeMailboxItem(reply.id);
          const mailbox = refreshMailbox(readMessages(), true);
          return send(res, 200, { ok: true, message: existing, mailbox });
        }
        const result = validateOwnerSend(body, { knownThreads, records, now: Date.now() });
        if (result.error) return send(res, result.status, { error: result.error });
        let message;
        const parent = records.find((item) => item.id === result.fields.replyTo && item.kind === 'todo');
        if (parent) {
          try { message = replyToTodo(result.fields, { store: messageStore }).message; }
          catch (error) { return send(res, error.status || 400, { error: error.message }); }
        } else message = appendMessage(result.fields);
        // Only a mail item closes. An Owner message that names a plain chat reply leaves that reply as it is.
        if (message.replyTo && isMailRecord(readMessages().find((item) => item.id === message.replyTo))) closeMailboxItem(message.replyTo);
        engine.log('message', `${parent ? 'Saved Owner To do answer' : `Queued Owner ${message.kind}`} ${message.id} for ${message.thread}`, { id: message.id, thread: message.thread, kind: message.kind, replyTo: message.replyTo });
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
      if (p === '/api/agent-messages' && req.method === 'GET') {
        const project = url.searchParams.get('project');
        const pair = url.searchParams.get('pair');
        const before = url.searchParams.get('before');
        const limitResult = queryLimit(url, 200, 'agent message');
        if (project !== null && !SLUG.test(project)) return send(res, 400, { error: 'project must be a project slug.' });
        if (pair === '') return send(res, 400, { error: 'pair must be a pair key.' });
        if (before === '') return send(res, 400, { error: 'before must be a message ID.' });
        if (limitResult.error) return send(res, 400, { error: limitResult.error });
        return send(res, 200, readAgentMessages({
          dir: DATA_DIR, project, pair, q: url.searchParams.get('q'), limit: limitResult.limit, before,
        }));
      }
      if (p === '/api/agent-pairs' && req.method === 'GET') {
        const project = url.searchParams.get('project');
        if (project !== null && !SLUG.test(project)) return send(res, 400, { error: 'project must be a project slug.' });
        return send(res, 200, listAgentPairs({ dir: DATA_DIR, project }));
      }
      if (p === '/api/agent-meta' && req.method === 'GET') {
        const project = url.searchParams.get('project');
        const since = url.searchParams.get('since');
        const until = url.searchParams.get('until');
        const limitResult = queryLimit(url, 500, 'agent metadata');
        if (project !== null && !SLUG.test(project)) return send(res, 400, { error: 'project must be a project slug.' });
        if (!validQueryTime(since) || !validQueryTime(until)) return send(res, 400, { error: 'since and until must be ISO timestamps.' });
        if (since && until && Date.parse(since) > Date.parse(until)) return send(res, 400, { error: 'since must be before until.' });
        if (limitResult.error) return send(res, 400, { error: limitResult.error });
        return send(res, 200, readAgentMetadata({ dir: DATA_DIR, project, since, until, limit: limitResult.limit }));
      }
      if (p === '/api/mailbox' && req.method === 'GET') {
        const records = readMessages();
        const folder = url.searchParams.get('folder');
        const thread = url.searchParams.get('thread');
        if (folder != null && !['todo', 'needs-you', 'inbox', 'updates', 'sent', 'done'].includes(folder)) return send(res, 400, { error: 'Choose a mailbox folder: todo, needs-you, inbox, updates, sent, or done.' });
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
        res.tenantHostsVisible = () => tenantHostsVisible(req, { eventSource: true, url });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`retry: 3000\n\n`);
        if (engine.state) {
          const full = res.tenantHostsVisible();
          res.write(`event: state\ndata: ${JSON.stringify(maskBrowserState(dashboardState(engine.state), { full }))}\n\n`);
        }
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
      if (pm && req.method === 'GET') {
        let slug;
        try { slug = decodeURIComponent(pm[1]); } catch { return send(res, 400, { error: 'The slug is not valid.' }); }
        const found = decorateProjects(listProjects()).find((project) => project?.slug === slug);
        return found ? send(res, 200, found) : send(res, 404, { error: 'No project has this slug.' });
      }
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

      // The Docs section. The routes read only README.md and docs/. The page itself is an app shell route.
      if (req.method === 'GET' && (p === '/api/docs/tree' || p === '/api/docs/page' || p.startsWith('/api/docs/help/'))) {
        let answer;
        if (p === '/api/docs/tree') answer = docsSite.tree();
        else if (p === '/api/docs/page') answer = docsSite.page(url.searchParams.get('path') ?? '');
        else { try { answer = docsSite.help(decodeURIComponent(p.slice('/api/docs/help/'.length))); } catch { answer = docsSite.help(''); } }
        return send(res, answer.status, answer.body);
      }
      if (req.method === 'GET' && p.startsWith('/docs/') && Object.hasOwn(DOC_IMAGE_TYPES, path.extname(p).toLowerCase())) {
        let name = '';
        try { name = decodeURIComponent(p.slice('/docs/'.length)); } catch { /* The name stays empty and the route answers 404. */ }
        const image = docsSite.image(name);
        if (image.status !== 200) return send(res, image.status, image.body);
        res.writeHead(200, { 'content-type': image.type, 'content-length': image.bytes.length, 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=300', 'content-security-policy': "default-src 'none'; sandbox" });
        return res.end(image.bytes);
      }

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
    serverLog(`herdr-boss: http://${bindHost}:${cfg.port} (push ${engine.push ? 'on' : 'off'})`);
  });

  server.on('close', () => {
    closed = true;
    void fleetPoller.stop();
    clearTimeout(timer);
    clearTimeout(debounce);
    clearTimeout(policyDebounce);
    projectsWatcher.close();
    policyWatcher.close();
    stopMessageWatch();
    stopReleaseWatch();
  });
  const loop = async () => {
    try {
      if (closed) return;
      tickPromise = engine.tick();
      await tickPromise;
    } catch (e) { engine.log('error', `tick failed: ${e.message}`); serverLog(maskBrowserText(e.stack || e.message), true); }
    finally { tickPromise = null; }
    if (!closed) timer = setTimeout(loop, cfg.tickSeconds * 1000);
  };
  void refreshRegister().then(loop);
  fleetPoller.start();
  const close = async () => {
    await fleetPoller.stop();
    for (const client of clients) client.end();
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    if (tickPromise) await tickPromise.catch(() => {});
    await registerImport.catch(() => {});
    stopMessageWatch();
    stopReleaseWatch();
  };
  return { server, engine, close };
}
