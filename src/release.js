// The release approval commands. An orchestrator requests a release, the Owner answers the Mailbox item,
// and the orchestrator publishes it. The module never runs gh directly: it takes a runner function
// run(args) that returns { status, error, stdout, stderr } for one gh command.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import { openMessageStore } from './message-store.js';
import { scanText } from './secret-scan.js';
import { scanTokenText } from '../scripts/docs-gate.js';
import { redactSecrets } from './redact.js';
import { listBrowserSessions } from './browser-pool.js';
import { getResultRecord } from './review-store.js';

const AUDIT_FILE = path.join('releases', 'audit.jsonl');
const MAX_SCAN_BYTES = 20 * 1024 * 1024;
const MAX_CANCEL_REASON = 500;
const APPROVED = /^\s*(approved|approve|accepted|accept|yes)\b/i;
const REJECTED = /^\s*(rejected|reject|denied|deny|no)\b/i;

// The fixed texts of a refusal. Each maps to one check in the publish path.
export const REFUSALS = {
  'repo-not-allowed': 'This repository is not in the releases.repos setting. Add it in Settings → Advanced → Service settings → Releases.',
  'no-approval': 'No approval item exists for this repository and tag.',
  'wrong-approval': 'The approval item is for another repository or tag.',
  'closed': 'The approval item is closed. Request a new approval.',
  'no-answer': 'The Owner has not answered this approval item yet.',
  'not-accept': 'The Owner denied this approval item. Request a new approval.',
  'answer-too-old': 'The Owner answer is older than the request. Request a new approval.',
  'checksum-mismatch': 'The draft assets changed after the request. Request a new approval.',
  'scan-failed': 'The secret scan found a problem after the request. Request a new approval.',
  'not-draft': 'The release is no longer a draft.',
};

const refuse = (code, extra = {}) => ({ ok: false, code, reason: REFUSALS[code], published: false, ...extra });
const failureDetail = (result) => (result.error ? redactSecrets(result.error.message) : redactSecrets(`${result.stderr}${result.stdout}`).trim().split('\n').slice(0, 3).join(' ')) || 'no message';

// The hosts that the browser sessions of this machine know. A known host in a release is a tenant host.
export function knownHostsFromSessions(sessions = listBrowserSessions()) {
  const hosts = new Set();
  for (const record of Object.values(sessions || {})) {
    const urls = [...(Array.isArray(record?.bookmarks) ? record.bookmarks.map((entry) => entry?.url) : []), record?.startPage];
    for (const value of urls) {
      if (typeof value !== 'string') continue;
      try { const host = new URL(value).hostname; if (host) hosts.add(host); } catch {}
    }
  }
  return [...hosts];
}

function hostKnown(hostname, knownHosts) {
  const host = String(hostname || '').toLowerCase();
  return !!host && knownHosts.some((known) => {
    const pattern = String(known).toLowerCase();
    return pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern;
  });
}

// The Qlik Engine writes the path of its own inline table source into an exported .qvf: /home/engine/<uuid>.inline.
// The path belongs to the Engine and holds no user path. Only this exact pattern passes, and only for a .qvf asset.
// The qvf stores the path with a one-byte length prefix. The path is 56 characters, so the prefix byte is '8' (0x38).
// Only that prefix may touch the path; any other word character before it still fails.
const ENGINE_INLINE_PATH = /(?:(?<![A-Za-z0-9._/-])|(?<=8))\/home\/engine\/[0-9a-fA-F-]{36}\.inline(?![A-Za-z0-9._/-])/g;

// The classes of secret in one text, and the allowed paths that the scan counted. A class name never holds the value.
export function scanReleaseDetailed(text, { knownHosts = [], file = 'text' } = {}) {
  const classes = new Set([...scanText(file, text), ...scanTokenText(text)]);
  const allowed = [];
  let pathText = text;
  if (/\.qvf$/i.test(String(file))) {
    const count = (text.match(ENGINE_INLINE_PATH) ?? []).length;
    if (count) { allowed.push(`qvf engine inline paths: ${count}, allowed`); pathText = text.replace(ENGINE_INLINE_PATH, ''); }
  }
  if (/\/(?:Users|home)\/[A-Za-z0-9._-]+\//.test(pathText)) classes.add('private path');
  for (const match of text.match(/https?:\/\/[A-Za-z0-9.-]+/g) ?? []) {
    try { if (hostKnown(new URL(match).hostname, knownHosts)) classes.add('tenant host'); } catch {}
  }
  return { classes: [...classes], allowed };
}

export function scanRelease(text, options = {}) {
  return scanReleaseDetailed(text, options).classes;
}

export function repoConfig(repo, config) {
  return (config?.releases?.repos ?? []).find((entry) => entry.name === repo) ?? null;
}

// Read a release through gh. Each asset has { name, size, digest }.
function readRelease(run, repo, tag) {
  const result = run(['release', 'view', tag, '--repo', repo, '--json', 'name,tagName,isDraft,body,assets,targetCommitish,url']);
  if (result.error || result.status !== 0) throw new Error(`gh release view failed: ${failureDetail(result)}`);
  let data;
  try { data = JSON.parse(result.stdout); } catch { throw new Error('gh release view returned text that is not JSON.'); }
  if (!data || typeof data !== 'object') throw new Error('gh release view returned no release.');
  return {
    name: data.name ?? null, tag: data.tagName ?? tag, draft: data.isDraft !== false, body: data.body ?? '',
    commit: data.targetCommitish ?? null, url: data.url ?? null,
    assets: (data.assets ?? []).map((asset) => ({ name: asset.name, size: asset.size ?? 0, digest: String(asset.digest ?? '').replace(/^sha256:/, '') || null })),
  };
}

// Download each asset into a temporary folder, hash it, and scan its text.
// Returns [{ name, size, sha256, listedSha256, classes }]. A scan class never holds a value.
function inspectAssets(run, repo, tag, release, knownHosts) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-release-'));
  try {
    const files = new Map();
    for (const asset of release.assets) {
      const result = run(['release', 'download', tag, '--repo', repo, '--pattern', asset.name, '--dir', tmp, '--clobber']);
      const file = path.join(tmp, asset.name);
      if (result.error || result.status !== 0 || !fs.existsSync(file)) throw new Error(`gh release download ${asset.name} failed: ${failureDetail(result)}`);
      files.set(asset.name, file);
    }
    return release.assets.map((asset) => {
      const file = files.get(asset.name);
      const content = fs.readFileSync(file);
      const sha256 = crypto.createHash('sha256').update(content).digest('hex');
      const classes = [];
      let allowed = [];
      if (content.length > MAX_SCAN_BYTES) classes.push('too large to scan');
      else {
        const scan = scanReleaseDetailed(content.toString('latin1'), { knownHosts, file: asset.name });
        classes.push(...scan.classes);
        allowed = scan.allowed;
      }
      const sidecar = files.get(`${asset.name}.sha256`);
      const listed = asset.digest ?? (sidecar ? fs.readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0].toLowerCase() : null);
      if (listed && listed !== sha256) classes.push('checksum differs from the listed checksum');
      return { name: asset.name, size: content.length, sha256, listedSha256: listed, classes, allowed };
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const scanFindings = (notes, assets) => [
  ...(notes.length ? [{ file: 'notes', classes: notes }] : []),
  ...assets.filter((asset) => asset.classes.length).map((asset) => ({ file: asset.name, classes: asset.classes })),
];

const records = (dir) => openMessageStore({ dir }).all();
// An Owner answer through the dashboard sets closedAt only, so that close still counts as an open request.
const settled = (record) => record.closedBy === 'project' || record.closeNote === 'published' || record.closeNote === 'denied by the Owner' || record.closeNote === 'superseded';
const isRelease = (record) => record.kind === 'report' && record.release && record.action === 'approve';
const sameTarget = (record, repo, tag) => record.release.repo === repo && record.release.tag === tag;

function readNotes(notesFile) {
  if (!notesFile) return '';
  try { return fs.readFileSync(notesFile, 'utf8'); } catch { throw new Error(`Cannot read notes file: ${notesFile}`); }
}

function sameReleaseAssets(stored, current) {
  if (!Array.isArray(stored) || stored.length !== current.length) return false;
  const shape = (assets) => assets.map(({ name, size, sha256 }) => ({ name, size, sha256 }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return JSON.stringify(shape(stored)) === JSON.stringify(shape(current));
}

// The Owner answers an approve item with a message that has replyTo set. The newest answer counts.
function ownerAnswer(all, approval) {
  const answers = all.filter((record) => record.from === 'owner' && record.kind === 'message' && record.replyTo === approval.id);
  const latest = answers[answers.length - 1];
  if (!latest) return null;
  const verdict = APPROVED.test(latest.text) ? 'accept' : REJECTED.test(latest.text) ? 'deny' : 'other';
  return { verdict, at: latest.at };
}

function packCoverage({ dir, slug, pack }) {
  if (!pack) return 'No review pack named. Use --pack to name one.';
  try {
    const result = getResultRecord({ dir, slug, pack });
    if (!result) return `Pack ${pack}: no Owner answer yet.`;
    return `Pack ${pack} version ${result.version}: ${result.verdict ?? 'answered'}${result.submittedAt ? ` at ${result.submittedAt}` : ''}.`;
  } catch {
    return `Pack ${pack}: the review store has no record.`;
  }
}

function cardText({ repo, tag, release, notes, assets, findings, latest, coverage }) {
  const lines = [
    '# Release approval request', '',
    `Repository: ${repo}`, `Tag: ${tag}`, `Draft: ${release.url ?? release.name ?? tag}`, '',
    '## Changelog', redactSecrets(notes || release.body || '(no changelog)'), '',
    '## Assets',
  ];
  if (assets.length) for (const asset of assets) lines.push(`- ${asset.name}: ${asset.size} bytes, sha256 ${asset.sha256}`);
  else lines.push('(no assets)');
  lines.push('', '## Scan result');
  if (findings.length) { lines.push('Fail:'); for (const finding of findings) lines.push(`- ${finding.file}: ${finding.classes.join(', ')}`); }
  else lines.push('Pass: no secrets found.');
  for (const asset of assets) for (const note of asset.allowed ?? []) lines.push(`- ${asset.name}: ${note}`);
  lines.push('', '## Build commit', release.commit ?? '(not available)', '', '## Review coverage', coverage, '', '## Effect',
    `Approve makes the release public${latest ? ' and marks it as the latest release' : ' and does not mark it as the latest release'}.`);
  return lines.join('\n');
}

// Request a release approval. Posts one Mailbox item of action approve.
// Returns { id, repo, tag, alreadyOpen, scanOk }.
export function requestRelease({ repo, tag, notesFile = null, pack = null, latest = true, run, dir = DATA_DIR, now = Date.now(), knownHosts = null, requesterPane = null, config = null }) {
  if (!repo || !tag) throw new Error('Usage: release request REPO TAG [--notes FILE] [--pack PACK] [--not-latest]');
  if (typeof run !== 'function') throw new Error('A gh runner is required.');
  const entry = config ? repoConfig(repo, config) : { project: 'boss' };
  if (!entry) throw new Error(REFUSALS['repo-not-allowed']);

  const open = records(dir).find((record) => isRelease(record) && !settled(record) && sameTarget(record, repo, tag));

  const hosts = knownHosts ?? knownHostsFromSessions();
  let release;
  let currentAssets = null;
  try {
    release = readRelease(run, repo, tag);
    if (open) currentAssets = inspectAssets(run, repo, tag, release, hosts);
  } catch (error) {
    if (open) return { id: open.id, repo, tag, alreadyOpen: true, scanOk: null };
    throw error;
  }
  if (open) {
    const notes = readNotes(notesFile);
    const changelog = notes || release.body || '';
    const notesSourceMatches = typeof open.release.notesFromFile === 'boolean'
      && open.release.notesFromFile === Boolean(notesFile);
    const notesDiffer = notesSourceMatches && typeof open.release.notesSha256 === 'string'
      && open.release.notesSha256 !== crypto.createHash('sha256').update(changelog).digest('hex');
    const assetsDiffer = !sameReleaseAssets(open.release.assets, currentAssets);
    return { id: open.id, repo, tag, alreadyOpen: true, stale: notesDiffer || assetsDiffer, scanOk: null };
  }
  if (!release.draft) throw new Error(REFUSALS['not-draft']);
  const notes = readNotes(notesFile);
  const assets = inspectAssets(run, repo, tag, release, hosts);
  const findings = scanFindings(scanRelease(`${notes}\n${release.body}`, { knownHosts: hosts, file: 'notes' }), assets);
  const text = cardText({ repo, tag, release, notes, assets, findings, latest, coverage: packCoverage({ dir, slug: entry.project, pack }) });

  const record = openMessageStore({ dir }).append({
    thread: entry.project, from: 'orch', to: 'owner', kind: 'report', title: `Release approval: ${repo} ${tag}`, text, action: 'approve',
    status: 'new', requesterPane,
    release: {
      repo, tag, latest, commit: release.commit, notesFromFile: Boolean(notesFile),
      notesSha256: crypto.createHash('sha256').update(notes || release.body || '').digest('hex'),
      assets: assets.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
    },
  }, { now });
  return { id: record.id, repo, tag, alreadyOpen: false, scanOk: findings.length === 0 };
}

function writeAudit({ dir, approvalId, who, repo, tag, now, action = 'publish', reason = undefined }) {
  const file = path.join(dir, AUDIT_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const entry = { at: new Date(now).toISOString(), approvalId, who, repo, tag, action };
  if (reason !== undefined) entry.reason = reason;
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function closeItem(id, note, { dir, now }) {
  const at = new Date(now).toISOString();
  return openMessageStore({ dir }).mutate((all) => {
    const item = all.find((record) => record.id === id);
    if (item && !settled(item)) Object.assign(item, { closedAt: item.closedAt || at, closedBy: 'project', closeNote: note, readAt: item.readAt || at });
    return { records: all, result: item ?? null };
  }, { now });
}

// Settle a request when its requester needs to replace it. The caller is checked again here so the
// command cannot cancel another orchestrator's request.
export function cancelRelease({ repo, tag, reason = '', dir = DATA_DIR, now = Date.now(), who = null, role = null }) {
  if (!repo || !tag) throw new Error('Usage: release cancel REPO TAG [--reason TEXT]');
  if (!['boss', 'orch'].includes(role) || !who) {
    return { ok: false, reason: 'Only the requesting orchestrator pane or the Boss can cancel this release request.' };
  }
  const all = records(dir);
  const approval = all.find((record) => isRelease(record) && !settled(record) && sameTarget(record, repo, tag));
  if (!approval) return { ok: false, reason: `No open release request exists for ${repo} ${tag}.` };
  if (role !== 'boss' && approval.requesterPane !== who) {
    return { ok: false, reason: 'Only the requesting orchestrator pane or the Boss can cancel this release request.' };
  }
  if (ownerAnswer(all, approval)?.verdict === 'accept') {
    return { ok: false, reason: 'The Owner has answered Approve. Run release publish or wait for an Owner denial to settle this request.' };
  }
  const boundedReason = redactSecrets(String(reason).trim()).slice(0, MAX_CANCEL_REASON);
  openMessageStore({ dir }).update(approval.id, { supersededReason: boundedReason }, { now });
  closeItem(approval.id, 'superseded', { dir, now });
  writeAudit({ dir, approvalId: approval.id, who, repo, tag, now, action: 'cancel', reason: boundedReason });
  return { ok: true, approvalId: approval.id, repo, tag };
}

// Publish a release. Every check must pass before gh release edit runs.
// Returns { ok, code, reason, published, waiting }.
export function publishRelease({ repo, tag, approvalId, run, dir = DATA_DIR, now = Date.now(), knownHosts = null, who = null, config = null }) {
  if (!repo || !tag || !approvalId) throw new Error('Usage: release publish REPO TAG --approval ID');
  if (typeof run !== 'function') throw new Error('A gh runner is required.');
  if (config && !repoConfig(repo, config)) return refuse('repo-not-allowed');

  const all = records(dir);
  const approval = all.find((record) => record.id === approvalId && isRelease(record));
  if (!approval) return refuse('no-approval');
  if (!sameTarget(approval, repo, tag)) return refuse('wrong-approval');
  if (settled(approval)) return refuse('closed');
  const answer = ownerAnswer(all, approval);
  if (!answer || answer.verdict === 'other') return refuse('no-answer', { waiting: true });
  if (answer.verdict === 'deny') { closeItem(approvalId, 'denied by the Owner', { dir, now }); return refuse('not-accept'); }
  if (Date.parse(answer.at) <= Date.parse(approval.at)) return refuse('answer-too-old');

  const release = readRelease(run, repo, tag);
  if (!release.draft) return refuse('not-draft');
  const hosts = knownHosts ?? knownHostsFromSessions();
  const assets = inspectAssets(run, repo, tag, release, hosts);
  const card = approval.release.assets ?? [];
  const same = card.length === assets.length && card.every((entry) => assets.some((asset) => asset.name === entry.name && asset.sha256 === entry.sha256 && asset.size === entry.size));
  if (!same) return refuse('checksum-mismatch');
  if (scanFindings(scanRelease(release.body, { knownHosts: hosts, file: 'notes' }), assets).length) return refuse('scan-failed');

  const edit = run(['release', 'edit', tag, '--repo', repo, '--draft=false', approval.release.latest === false ? '--latest=false' : '--latest']);
  if (edit.error || edit.status !== 0) throw new Error(`gh release edit failed: ${failureDetail(edit)}`);
  const after = readRelease(run, repo, tag);
  const names = after.assets.map((asset) => asset.name).sort().join('\n');
  if (after.draft) throw new Error('The release is still a draft after gh release edit.');
  if (names !== card.map((entry) => entry.name).sort().join('\n')) throw new Error('The published release has other assets than the card.');

  writeAudit({ dir, approvalId, who, repo, tag, now });
  closeItem(approvalId, 'published', { dir, now });
  return { ok: true, code: null, reason: null, published: true };
}

// The drafts and the last published release of the allowed repositories, and the open requests.
export function releaseStatus({ repo = null, run, dir = DATA_DIR, config = null }) {
  if (typeof run !== 'function') throw new Error('A gh runner is required.');
  const names = repo ? [repo] : (config?.releases?.repos ?? []).map((entry) => entry.name);
  const rows = [];
  for (const name of names) {
    const result = run(['release', 'list', '--repo', name, '--json', 'tagName,name,isDraft,isLatest,publishedAt', '--limit', '30']);
    let list = [];
    if (!result.error && result.status === 0) { try { list = JSON.parse(result.stdout) ?? []; } catch {} }
    const published = list.filter((entry) => !entry.isDraft).sort((a, b) => String(b.publishedAt ?? '').localeCompare(String(a.publishedAt ?? '')))[0] ?? null;
    rows.push({ repo: name, drafts: list.filter((entry) => entry.isDraft).map((entry) => entry.tagName), lastPublished: published ? { tag: published.tagName, publishedAt: published.publishedAt ?? null } : null, readable: !result.error && result.status === 0 });
  }
  const openRequests = records(dir).filter((record) => isRelease(record) && !settled(record) && (!repo || record.release.repo === repo))
    .map((record) => ({ id: record.id, repo: record.release.repo, tag: record.release.tag, at: record.at }));
  return { repos: rows, openRequests };
}

// When the Owner answers a release approval, tell the requesting pane once. A deny closes the item.
// `record` is the new Owner message. Nothing polls: the message store calls this on each append.
export function noticeReleaseAnswer(record, { dir = DATA_DIR, herdr, now = Date.now() } = {}) {
  if (record?.from !== 'owner' || record.kind !== 'message' || !record.replyTo) return null;
  const store = openMessageStore({ dir });
  const approval = store.all().find((item) => item.id === record.replyTo && isRelease(item));
  if (!approval || settled(approval) || approval.answerNoticeAt) return null;
  const verdict = APPROVED.test(record.text) ? 'accepted' : REJECTED.test(record.text) ? 'denied' : null;
  if (!verdict) return null;
  store.update(approval.id, { answerNoticeAt: new Date(now).toISOString() }, { now });
  if (verdict === 'denied') closeItem(approval.id, 'denied by the Owner', { dir, now });
  const { repo, tag } = approval.release;
  if (approval.requesterPane && typeof herdr === 'function') {
    const next = verdict === 'accepted' ? `Run: herdr-boss release publish ${repo} ${tag} --approval ${approval.id}` : 'Request a new approval after you change the draft.';
    try { herdr(['agent', 'prompt', approval.requesterPane, `[herdr-boss] The Owner ${verdict} the release ${repo} ${tag}. ${next}`]); } catch {}
  }
  return { id: approval.id, verdict };
}

// Watch the message store for Owner answers. Returns the function that stops the watch.
export function watchReleaseAnswers(store, options = {}) {
  return store.onChange((event) => {
    if (event.type === 'append') { try { noticeReleaseAnswer(event.record, options); } catch {} }
  });
}

const USAGE = 'Usage: release request REPO TAG [--notes FILE] [--pack PACK] [--not-latest] | release cancel REPO TAG [--reason TEXT] | release publish REPO TAG --approval ID | release status [REPO]';

function parseArgs(args, valueFlags, boolFlags = []) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (valueFlags.includes(token)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${token} needs a value. ${USAGE}`);
      flags[token] = value;
    } else if (boolFlags.includes(token)) flags[token] = true;
    else if (token.startsWith('--')) throw new Error(`Unknown option: ${token}. ${USAGE}`);
    else positional.push(token);
  }
  return { flags, positional };
}

// The handler of `herdr-boss release ...`. It returns the exit code: 0 done, 1 refused, 3 waiting for the Owner.
export async function releaseCommand(args, { env = process.env, dataDir = DATA_DIR, config = {}, run = null, herdr = null, out = console.log, err = console.error } = {}) {
  const [action, ...rest] = args;
  if (!['request', 'cancel', 'publish', 'status'].includes(action)) throw new Error(USAGE);
  try {
    if (action === 'status') {
      if (!run) { const { ghRunner } = await import('./gh-labels.js'); run = ghRunner({ env }); }
      const { positional } = parseArgs(rest, []);
      if (positional.length > 1) throw new Error(USAGE);
      out(JSON.stringify(releaseStatus({ repo: positional[0] ?? null, run, dir: dataDir, config }), null, 2));
      return 0;
    }
    if (action === 'cancel') {
      const { flags, positional } = parseArgs(rest, ['--reason']);
      if (positional.length !== 2) throw new Error(USAGE);
      const [{ verifyMessageCaller }, { createHerdrRunner }] = await Promise.all([import('./messages.js'), import('./kit/workers.js')]);
      const caller = verifyMessageCaller(env, herdr ?? createHerdrRunner(), 'release cancel');
      const [repo, tag] = positional;
      const result = cancelRelease({ repo, tag, reason: flags['--reason'] ?? '', dir: dataDir, now: Date.now(), who: caller.paneId, role: caller.role });
      if (result.ok) { out(`Cancelled release request ${result.approvalId} for ${repo} ${tag}.`); return 0; }
      err(`Refused: ${result.reason}`);
      return 1;
    }
    if (!run) { const { ghRunner } = await import('./gh-labels.js'); run = ghRunner({ env }); }
    if (action === 'request') {
      const { flags, positional } = parseArgs(rest, ['--notes', '--pack'], ['--not-latest']);
      if (positional.length !== 2) throw new Error(USAGE);
      const [repo, tag] = positional;
      const result = requestRelease({ repo, tag, notesFile: flags['--notes'] ?? null, pack: flags['--pack'] ?? null, latest: !flags['--not-latest'], run, dir: dataDir, config, requesterPane: env.HERDR_PANE_ID ?? null });
      if (result.stale) out(`The open request ${result.id} shows older notes; run release cancel ${repo} ${tag}, then request again.`);
      else out(result.alreadyOpen ? `An open request exists for ${repo} ${tag}: ${result.id}` : `Posted approval ${result.id} for ${repo} ${tag}.`);
      if (result.scanOk === false) out('The secret scan failed. The card shows the classes. Publish will refuse until the draft is clean and a new request exists.');
      return 0;
    }
    const { flags, positional } = parseArgs(rest, ['--approval']);
    if (positional.length !== 2 || !flags['--approval']) throw new Error(USAGE);
    const [repo, tag] = positional;
    const result = publishRelease({ repo, tag, approvalId: flags['--approval'], run, dir: dataDir, config, who: env.HERDR_PANE_ID ?? null });
    if (result.published) { out(`Published ${repo} ${tag}.`); return 0; }
    err(`${result.waiting ? 'Waiting for the Owner' : 'Refused'}: ${result.reason}`);
    return result.waiting ? 3 : 1;
  } catch (error) {
    err(`Refused: ${redactSecrets(error.message)}`);
    return 1;
  }
}
