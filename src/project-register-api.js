import { appendAudit, readRegister, SLUG, withRegisterLock, writeRegister } from './project-register.js';

const VIEW_FIELDS = Object.freeze([
  'slug', 'title', 'group', 'clientTag', 'factory', 'state', 'pinned', 'priority',
  'lastOpenedAt', 'lastActivityAt', 'nextAction', 'createdAt', 'issueSource', 'autoOpen',
]);
const LIFECYCLE_ACTIONS = new Set(['open', 'park', 'archive', 'unarchive']);
const PAGE_ACTIONS = new Set([...LIFECYCLE_ACTIONS, 'pin', 'unpin', 'add']);

function publicRecord(record) {
  return Object.fromEntries(VIEW_FIELDS.filter((field) => Object.hasOwn(record, field)).map((field) => [field, record[field]]));
}

function decodeSlug(pathname) {
  const match = /^\/api\/project-register\/([^/]+)\/action$/.exec(pathname);
  if (!match) return null;
  try {
    const slug = decodeURIComponent(match[1]);
    return SLUG.test(slug) ? slug : false;
  } catch {
    return false;
  }
}

function decodeTriageItem(pathname) {
  const match = /^\/api\/project-register\/triage\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  try {
    const itemId = decodeURIComponent(match[1]);
    return /^m-[a-z0-9]+-[a-f0-9]{8}$/.test(itemId) ? itemId : false;
  } catch {
    return false;
  }
}

function errorResponse(status, error) {
  return { status, body: { ok: false, error } };
}

function setPinned(slug, pinned, dataDir, now) {
  return withRegisterLock(dataDir, () => {
    const register = readRegister(dataDir);
    const record = register.projects.find((item) => item.slug === slug);
    if (!record) return errorResponse(404, 'The project is not in the register.');
    if (record.state !== 'open') return errorResponse(409, 'Only an open project can be pinned.');
    if (record.pinned === pinned) return { status: 200, body: { ok: true, action: pinned ? 'pin' : 'unpin', slug, pinned } };
    if (pinned && register.projects.filter((item) => item.state === 'open' && item.pinned).length >= 3) {
      return errorResponse(409, 'The page supports up to three pinned projects.');
    }
    const previousPinned = record.pinned;
    record.pinned = pinned;
    writeRegister(register, dataDir);
    try {
      appendAudit(slug, 'register-edit', dataDir, { at: new Date(now()).toISOString(), by: 'owner-page' });
    } catch {
      record.pinned = previousPinned;
      try {
        writeRegister(register, dataDir);
      } catch {
        return errorResponse(500, 'The project pin could not be audited or rolled back. Check the project register before retrying.');
      }
      return errorResponse(500, 'The project change could not be audited.');
    }
    return { status: 200, body: { ok: true, action: pinned ? 'pin' : 'unpin', slug, pinned } };
  });
}

// Keep the Projects page API narrow. It never sends repository paths, remotes, or notes to the browser.
export function createProjectRegisterApi({ dataDir, readOnly = false, runLifecycle = async () => 0, runTriageDecision = null,
  policyProjects = () => [], runRegisterAdd = async () => 1, getOnboarding = () => null, openCount = () => null, cap = 3, now = Date.now } = {}) {
  if (!dataDir) throw new TypeError('A project register data directory is required.');

  return {
    async handle(method, pathname, body) {
      if (method === 'GET' && pathname === '/api/project-register') {
        const register = readRegister(dataDir);
        const known = new Set(register.projects.map((record) => record.slug));
        const registered = [];
        for (const record of register.projects) {
          const onboarding = await getOnboarding(record.slug);
          registered.push({ ...publicRecord(record), ...(onboarding ? { onboarding } : {}) });
        }
        const policyOnly = [...new Set(policyProjects().filter((slug) => SLUG.test(slug) && !known.has(slug)))].map((slug) => ({
          slug, title: slug, state: 'policy-only', registered: false, inPolicy: true,
        }));
        return { status: 200, body: { projects: [...registered, ...policyOnly], readOnly, openCount: openCount(), cap } };
      }
      const itemId = decodeTriageItem(pathname);
      if (itemId !== null) {
        if (itemId === false) return errorResponse(400, 'The project triage item is not valid.');
        if (method !== 'POST') return errorResponse(405, 'Use POST for a triage decision.');
        if (readOnly) return errorResponse(403, 'The read-only preview does not allow triage decisions.');
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !['accept', 'deny'].includes(body.decision)) {
          return errorResponse(400, 'Choose Accept or Deny.');
        }
        if (typeof runTriageDecision !== 'function') return errorResponse(503, 'Project triage decisions are unavailable.');
        try {
          const result = await runTriageDecision(itemId, body.decision);
          if (result.status !== 200) return errorResponse(result.status || 409, result.error || 'The project triage decision failed.');
          return { status: 200, body: { ok: true, decision: result.decision, slug: result.slug } };
        } catch {
          return errorResponse(409, 'The project triage decision failed.');
        }
      }
      const slug = decodeSlug(pathname);
      if (slug === null) return null;
      if (slug === false) return errorResponse(400, 'The project slug is not valid.');
      if (method !== 'POST') return errorResponse(405, 'Use POST for a project action.');
      if (readOnly) return errorResponse(403, 'The read-only preview does not allow project actions.');
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.action !== 'string') {
        return errorResponse(400, 'Give one project action.');
      }
      const action = body.action;
      if (!PAGE_ACTIONS.has(action)) return errorResponse(400, 'The project action is not supported.');
      if (action === 'add') {
        if (!policyProjects().includes(slug)) return errorResponse(404, 'The project is not in policy.');
        try {
          const code = await runRegisterAdd(slug);
          if (code !== undefined && code !== 0) return errorResponse(409, 'The project could not be added to the register.');
          return { status: 200, body: { ok: true, action: 'add', slug } };
        } catch {
          return errorResponse(409, 'The project could not be added to the register.');
        }
      }
      if (action === 'pin' || action === 'unpin') return setPinned(slug, action === 'pin', dataDir, now);

      try {
        const args = [slug, ...(action === 'open' ? ['--start'] : [])];
        const code = await runLifecycle(action, args);
        if (code !== undefined && code !== 0) return errorResponse(409, `The project could not ${action}. Check the project before trying again.`);
        return { status: 200, body: { ok: true, action, slug } };
      } catch {
        return errorResponse(409, `The project could not ${action}. Check the project before trying again.`);
      }
    },
  };
}
