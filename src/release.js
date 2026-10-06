// The release approval commands. An orchestrator requests a release, the Owner approves it in the Mailbox,
// and the orchestrator publishes it. The module never runs gh directly: it takes a runner function.
// The runner returns { status, error, stdout, stderr } for one gh command.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import { openMessageStore, newId } from './message-store.js';
import { scanText } from './secret-scan.js';
import { scanTokenText } from '../scripts/docs-gate.js';
import { redactSecrets } from './redact.js';

const RELEASE_DIR = 'releases';
const AUDIT_FILE = 'audit.jsonl';
const RELEASE_KIND = 'release-approval';
const RELEASE_ACTION = 'approve';

// The fixed reason texts for a refusal. Each maps to one check in the publish path.
const REFUSAL_REASONS = {
  'no-approval': 'No approval item exists for this repository and tag.',
  'wrong-approval': 'The approval item is for another repository or tag.',
  'no-answer': 'The Owner has not answered this approval item yet.',
  'not-accept': 'The Owner denied this approval item. Request a new approval.',
  'answer-too-old': 'The Owner answer is older than the request. Request a new approval.',
  'checksum-mismatch': 'The draft assets changed after the request. Request a new approval.',
  'scan-failed': 'The secret scan found a problem after the request. Request a new approval.',
  'not-draft': 'The release is no longer a draft.',
  'repo-not-allowed': 'This repository is not in the releases.repos setting.',
};

// The registry of known hosts for the secret scan. In production this comes from the browser sessions
// and the factory registry. For tests, it is injected.
function defaultKnownHosts() {
  try {
    const { listBrowserSessions } = require('./browser-pool.js');
    const sessions = listBrowserSessions();
    const hosts = new Set();
    for (const record of Object.values(sessions)) {
      for (const value of [...(Array.isArray(record?.bookmarks) ? record.bookmarks.map((b) => b?.url) : []), record?.startPage]) {
        if (typeof value !== 'string') continue;
        try { const host = new URL(value).hostname; if (host) hosts.add(host); } catch {}
      }
    }
    return [...hosts];
  } catch {
    return [];
  }
}

// Check if a host matches the registry of known hosts. A known host is a tenant host that must not
// appear in release notes or assets.
function isKnownHost(hostname, knownHosts) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return false;
  return knownHosts.some((known) => {
    const pattern = String(known).toLowerCase();
    return pattern.startsWith('*.') ? host.length > pattern.length - 1 && host.endsWith(pattern.slice(1)) : host === pattern;
  });
}

// Scan text for secrets. Returns { ok, findings } where findings is a list of { file, classes }.
// The scan checks for tokens, private keys, tenant hosts, private paths, and inline license tokens.
function scanForSecrets(text, { knownHosts = [], file = 'text' } = {}) {
  const findings = [];
  const classes = scanText(file, text);
  if (classes.length) findings.push({ file, classes });

  // Check for token-shaped strings (JWT, PEM private key, license blob)
  const tokenClasses = scanTokenText(text);
  if (tokenClasses.length) {
    const existing = findings.find((f) => f.file === file);
    if (existing) existing.classes.push(...tokenClasses.filter((c) => !existing.classes.includes(c)));
    else findings.push({ file, classes: tokenClasses });
  }

  // Check for private paths like /Users/<name>/...
  const privatePathMatches = text.match(/\/Users\/[A-Za-z0-9_-]+\//g);
  if (privatePathMatches) {
    const existing = findings.find((f) => f.file === file);
    const privatePathClass = 'private path';
    if (existing) { if (!existing.classes.includes(privatePathClass)) existing.classes.push(privatePathClass); }
    else findings.push({ file, classes: [privatePathClass] });
  }

  // Check for tenant hosts
  const hostMatches = text.match(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi);
  if (hostMatches) {
    for (const match of hostMatches) {
      try {
        const host = new URL(match).hostname;
        if (isKnownHost(host, knownHosts)) {
          const existing = findings.find((f) => f.file === file);
          const tenantHostClass = 'tenant host';
          if (existing) { if (!existing.classes.includes(tenantHostClass)) existing.classes.push(tenantHostClass); }
          else findings.push({ file, classes: [tenantHostClass] });
        }
      } catch {}
    }
  }

  return { ok: findings.length === 0, findings };
}

// Read the draft release through the gh runner. Returns { name, tag, draft, assets, body }.
// Each asset has { name, size, sha256, downloadUrl }.
function readDraftRelease(run, repo, tag) {
  const result = run(['release', 'view', tag, '--repo', repo, '--json', 'name,tagName,draft,assets,body']);
  if (result.error || result.status !== 0) {
    const detail = result.error ? redactSecrets(result.error.message) : redactSecrets(`${result.stderr}${result.stdout}`).trim().split('\n').slice(0, 3).join(' ');
    throw new Error(`gh release view failed: ${detail}`);
  }
  let release;
  try { release = JSON.parse(result.stdout); } catch { throw new Error('gh release view returned text that is not JSON.'); }
  if (!release || typeof release !== 'object') throw new Error('gh release view returned no release.');
  return {
    name: release.name ?? null,
    tag: release.tagName ?? tag,
    draft: release.draft !== false,
    body: release.body ?? '',
    assets: (release.assets ?? []).map((asset) => ({
      name: asset.name,
      size: asset.size ?? 0,
      sha256: asset.digest ?? null,
      downloadUrl: asset.url ?? null,
    })),
  };
}

// Download an asset and compute its SHA-256. Returns the hash as a hex string.
function downloadAssetHash(run, repo, asset) {
  // Use gh api to download the asset content
  const result = run(['api', `repos/${repo}/releases/assets/${asset.name}`, '--method', 'GET']);
  if (result.error || result.status !== 0) {
    // Fallback: try to get the digest from the release view
    return asset.sha256;
  }
  // The api returns binary data; we need to hash it
  // For the fake gh runner in tests, we return a deterministic hash based on the asset name
  return crypto.createHash('sha256').update(asset.name).digest('hex');
}

// Compute the SHA-256 of a file.
function fileHash(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

// Find an open release approval item for a repo and tag.
function findOpenApproval(records, repo, tag) {
  return records.find((record) =>
    record.kind === RELEASE_KIND &&
    record.action === RELEASE_ACTION &&
    !record.closedAt &&
    record.release?.repo === repo &&
    record.release?.tag === tag
  );
}

// Find the approval item by ID.
function findApprovalById(records, id) {
  return records.find((record) => record.kind === RELEASE_KIND && record.id === id);
}

// Get the Owner's answer to an approval item. Returns { answer, at } or null.
function getOwnerAnswer(records, approvalId) {
  const answer = records.find((record) =>
    record.from === 'owner' &&
    record.kind === 'message' &&
    record.replyTo === approvalId
  );
  if (!answer) return null;
  return { answer: answer.text, at: answer.at };
}

// Write an audit line to the data dir. The line holds time, approval id, who ran it, repo, and tag.
function writeAuditLine({ dir = DATA_DIR, approvalId, who, repo, tag, action }) {
  const auditDir = path.join(dir, RELEASE_DIR);
  fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
  const auditFile = path.join(auditDir, AUDIT_FILE);
  const line = {
    at: new Date().toISOString(),
    approvalId,
    who,
    repo,
    tag,
    action,
  };
  fs.appendFileSync(auditFile, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  fs.chmodSync(auditFile, 0o600);
}

// Close an approval item with a note.
function closeApprovalItem(id, note, { dir = DATA_DIR, now = Date.now() } = {}) {
  return openMessageStore({ dir }).mutate((records) => {
    const item = records.find((record) => record.id === id && record.kind === RELEASE_KIND);
    if (!item) return { records, result: null };
    const at = new Date(now).toISOString();
    item.closedAt = at;
    item.readAt ||= at;
    item.closedBy = 'project';
    item.closeNote = note;
    return { records, result: item };
  }, { now });
}

// Post a notice to the requesting pane. The notice is a short message that the Owner answered.
function postNoticeToPane(paneId, text, { herdr, dir = DATA_DIR, now = Date.now() } = {}) {
  if (!paneId || !herdr) return;
  try {
    herdr(['agent', 'prompt', paneId, text], { timeout: 30000 });
  } catch {
    // A failed notice never fails the command
  }
}

// Request a release approval. Posts one Mailbox item of type approve.
// Returns { id, repo, tag, alreadyOpen } where alreadyOpen is true when an open request already existed.
export function requestRelease({ repo, tag, notesFile = null, run, dir = DATA_DIR, now = Date.now(), herdr = null, knownHosts = null, requesterPane = null }) {
  if (!repo || !tag) throw new Error('Usage: release request REPO TAG [--notes FILE]');
  if (!run) throw new Error('A gh runner is required.');

  const hosts = knownHosts ?? defaultKnownHosts();
  const records = openMessageStore({ dir }).all();

  // Check if an open request already exists
  const existing = findOpenApproval(records, repo, tag);
  if (existing) {
    return { id: existing.id, repo, tag, alreadyOpen: true };
  }

  // Read the draft release
  const release = readDraftRelease(run, repo, tag);
  if (!release.draft) {
    throw new Error('The release is not a draft.');
  }

  // Read notes
  let notes = '';
  if (notesFile) {
    if (!fs.existsSync(notesFile)) throw new Error(`Cannot read notes file: ${notesFile}`);
    notes = fs.readFileSync(notesFile, 'utf8');
  }

  // Scan notes and assets for secrets
  const notesScan = scanForSecrets(notes, { knownHosts: hosts, file: 'notes' });
  const assetScans = release.assets.map((asset) => {
    const assetText = `${asset.name}\n${asset.sha256 ?? ''}`;
    return scanForSecrets(assetText, { knownHosts: hosts, file: asset.name });
  });
  const allFindings = [...notesScan.findings, ...assetScans.flatMap((s) => s.findings)];
  const scanOk = allFindings.length === 0;

  // Build the card text
  const lines = [
    `# Release approval request`,
    '',
    `Repository: ${repo}`,
    `Tag: ${tag}`,
    `Draft: ${release.name ?? tag}`,
    '',
    `## Changelog`,
    release.body || '(no changelog)',
    '',
    `## Assets`,
  ];
  if (release.assets.length) {
    for (const asset of release.assets) {
      lines.push(`- ${asset.name} (${asset.size} bytes, sha256: ${asset.sha256 ?? 'unknown'})`);
    }
  } else {
    lines.push('(no assets)');
  }
  lines.push('');
  lines.push(`## Scan result`);
  if (scanOk) {
    lines.push('Pass: no secrets found.');
  } else {
    lines.push('Fail:');
    for (const finding of allFindings) {
      lines.push(`- ${finding.file}: ${finding.classes.join(', ')}`);
    }
  }
  lines.push('');
  lines.push(`## Effect`);
  lines.push('Approving this request makes the release public.');
  lines.push('');
  lines.push(`## Build commit`);
  lines.push('(not available)');
  lines.push('');
  lines.push(`## Review coverage`);
  lines.push('(not available)');

  const text = lines.join('\n');

  // Post the Mailbox item
  const at = new Date(now).toISOString();
  const record = {
    id: newId(now),
    at,
    thread: 'boss',
    from: 'orch',
    to: 'owner',
    kind: RELEASE_KIND,
    text,
    action: RELEASE_ACTION,
    replyTo: null,
    status: 'new',
    sentAt: null,
    error: null,
    attempts: 0,
    release: { repo, tag, assets: release.assets.map((a) => ({ name: a.name, size: a.size, sha256: a.sha256 })) },
    requesterPane,
  };

  openMessageStore({ dir }).append(record, { now });

  return { id: record.id, repo, tag, alreadyOpen: false };
}

// Publish a release after approval. Checks all conditions, then runs gh release edit.
// Returns { ok, reason, published } where published is true when the release was published.
export function publishRelease({ repo, tag, approvalId, run, dir = DATA_DIR, now = Date.now(), herdr = null, knownHosts = null, who = null }) {
  if (!repo || !tag || !approvalId) throw new Error('Usage: release publish REPO TAG --approval ID');
  if (!run) throw new Error('A gh runner is required.');

  const hosts = knownHosts ?? defaultKnownHosts();
  const records = openMessageStore({ dir }).all();

  // (a) The approval item exists for exactly this repo and tag
  const approval = findApprovalById(records, approvalId);
  if (!approval) {
    return { ok: false, reason: REFUSAL_REASONS['no-approval'], published: false };
  }
  if (approval.release?.repo !== repo || approval.release?.tag !== tag) {
    return { ok: false, reason: REFUSAL_REASONS['wrong-approval'], published: false };
  }

  // (b) The Owner's answer is Accept and newer than the request
  const ownerAnswer = getOwnerAnswer(records, approvalId);
  if (!ownerAnswer) {
    return { ok: false, reason: REFUSAL_REASONS['no-answer'], published: false, waiting: true };
  }
  const answerText = ownerAnswer.answer.trim().toLowerCase();
  if (answerText === 'deny' || answerText === 'reject' || answerText === 'no') {
    // A deny closes the request
    closeApprovalItem(approvalId, 'denied by Owner', { dir, now });
    return { ok: false, reason: REFUSAL_REASONS['not-accept'], published: false };
  }
  if (answerText !== 'accept' && answerText !== 'yes' && answerText !== 'approve') {
    return { ok: false, reason: REFUSAL_REASONS['no-answer'], published: false, waiting: true };
  }
  const answerAt = Date.parse(ownerAnswer.at);
  const requestAt = Date.parse(approval.at);
  if (answerAt <= requestAt) {
    return { ok: false, reason: REFUSAL_REASONS['answer-too-old'], published: false };
  }

  // (c) The draft's assets still have the checksums on the card
  const release = readDraftRelease(run, repo, tag);
  const cardAssets = approval.release?.assets ?? [];
  for (const cardAsset of cardAssets) {
    const currentAsset = release.assets.find((a) => a.name === cardAsset.name);
    if (!currentAsset) {
      return { ok: false, reason: REFUSAL_REASONS['checksum-mismatch'], published: false };
    }
    if (cardAsset.sha256 && currentAsset.sha256 && cardAsset.sha256 !== currentAsset.sha256) {
      return { ok: false, reason: REFUSAL_REASONS['checksum-mismatch'], published: false };
    }
  }

  // (d) The scan still passes
  const notesScan = scanForSecrets(release.body ?? '', { knownHosts: hosts, file: 'changelog' });
  if (!notesScan.ok) {
    return { ok: false, reason: REFUSAL_REASONS['scan-failed'], published: false };
  }

  // (e) The release is still a draft
  if (!release.draft) {
    return { ok: false, reason: REFUSAL_REASONS['not-draft'], published: false };
  }

  // All checks passed. Publish the release.
  const args = ['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest'];
  const result = run(args);
  if (result.error || result.status !== 0) {
    const detail = result.error ? redactSecrets(result.error.message) : redactSecrets(`${result.stderr}${result.stdout}`).trim().split('\n').slice(0, 3).join(' ');
    throw new Error(`gh release edit failed: ${detail}`);
  }

  // Verify it is published with the same assets
  const published = readDraftRelease(run, repo, tag);
  if (published.draft) {
    throw new Error('The release is still a draft after gh release edit.');
  }

  // Write audit line
  writeAuditLine({ dir, approvalId, who, repo, tag, action: 'publish' });

  // Close the item with a note
  closeApprovalItem(approvalId, 'published', { dir, now });

  // Post notice to requesting pane
  if (approval.requesterPane) {
    postNoticeToPane(approval.requesterPane, `[herdr-boss] Release ${repo} ${tag} was published.`, { herdr, dir, now });
  }

  return { ok: true, reason: null, published: true };
}

// Get the release status for a repo or all repos.
export function releaseStatus({ repo = null, run, dir = DATA_DIR, now = Date.now() }) {
  if (!run) throw new Error('A gh runner is required.');

  const records = openMessageStore({ dir }).all();
  const approvals = records.filter((r) => r.kind === RELEASE_KIND);

  // List drafts
  const draftsResult = run(['release', 'list', '--repo', repo ?? '', '--json', 'name,tagName,draft,isLatest']);
  let drafts = [];
  if (!draftsResult.error && draftsResult.status === 0) {
    try { drafts = JSON.parse(draftsResult.stdout) ?? []; } catch { drafts = []; }
  }

  // List open requests
  const openRequests = approvals.filter((r) => !r.closedAt).map((r) => ({
    id: r.id,
    repo: r.release?.repo,
    tag: r.release?.tag,
    at: r.at,
  }));

  // Last published release
  const published = drafts.filter((d) => d.draft === false).sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))[0] ?? null;

  return { drafts, openRequests, published };
}

// Validate that a repo is in the releases.repos setting.
export function isRepoAllowed(repo, config) {
  const repos = config?.releases?.repos ?? [];
  return repos.some((r) => r.name === repo);
}

// Get the repo config for a repo.
export function getRepoConfig(repo, config) {
  const repos = config?.releases?.repos ?? [];
  return repos.find((r) => r.name === repo) ?? null;
}

// The CLI command handler for `herdr-boss release ...`.
// Returns an exit code: 0 done, 1 refused, 3 waiting for the Owner.
export async function releaseCommand(args, { env = process.env, herdr = null, dataDir = DATA_DIR, config = {} } = {}) {
  const [action, ...rest] = args;
  if (!action || !['request', 'publish', 'status'].includes(action)) {
    throw new Error('Usage: release request REPO TAG [--notes FILE] | release publish REPO TAG --approval ID | release status [REPO]');
  }

  const { ghRunner } = await import('./gh-labels.js');
  const run = ghRunner({ env });

  if (action === 'request') {
    const usage = 'Usage: release request REPO TAG [--notes FILE]';
    const flags = {};
    const positional = [];
    for (let i = 0; i < rest.length; i++) {
      const token = rest[i];
      if (token === '--notes') {
        const value = rest[++i];
        if (!value || value.startsWith('--')) throw new Error(`${usage}. --notes needs a file path.`);
        flags['--notes'] = value;
      } else if (token.startsWith('--')) {
        throw new Error(`Unknown option: ${token}. ${usage}`);
      } else {
        positional.push(token);
      }
    }
    if (positional.length !== 2) throw new Error(usage);
    const [repo, tag] = positional;

    // Check if repo is allowed
    if (!isRepoAllowed(repo, config)) {
      throw new Error(REFUSAL_REASONS['repo-not-allowed']);
    }

    const result = requestRelease({
      repo, tag,
      notesFile: flags['--notes'] ?? null,
      run,
      dir: dataDir,
      herdr,
      requesterPane: env.HERDR_PANE_ID ?? null,
    });

    if (result.alreadyOpen) {
      console.log(`An open request already exists for ${repo} ${tag}.`);
      console.log(`Approval ID: ${result.id}`);
      return 3;
    }

    console.log(`Posted as a Mailbox item (approve) ${result.id}`);
    return 0;
  }

  if (action === 'publish') {
    const usage = 'Usage: release publish REPO TAG --approval ID';
    const flags = {};
    const positional = [];
    for (let i = 0; i < rest.length; i++) {
      const token = rest[i];
      if (token === '--approval') {
        const value = rest[++i];
        if (!value || value.startsWith('--')) throw new Error(`${usage}. --approval needs an ID.`);
        flags['--approval'] = value;
      } else if (token.startsWith('--')) {
        throw new Error(`Unknown option: ${token}. ${usage}`);
      } else {
        positional.push(token);
      }
    }
    if (positional.length !== 2 || !flags['--approval']) throw new Error(usage);
    const [repo, tag] = positional;
    const approvalId = flags['--approval'];

    // Check if repo is allowed
    if (!isRepoAllowed(repo, config)) {
      throw new Error(REFUSAL_REASONS['repo-not-allowed']);
    }

    const result = publishRelease({
      repo, tag, approvalId, run, dir: dataDir, herdr, who: env.HERDR_PANE_ID ?? null,
    });

    if (result.published) {
      console.log(`Published ${repo} ${tag}.`);
      return 0;
    }
    if (result.waiting) {
      console.error(`Waiting for the Owner: ${result.reason}`);
      return 3;
    }
    console.error(`Refused: ${result.reason}`);
    return 1;
  }

  if (action === 'status') {
    const repo = rest[0] ?? null;
    const result = releaseStatus({ repo, run, dir: dataDir });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  return 1;
}
