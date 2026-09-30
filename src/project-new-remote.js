// Step `remote` of `herdr-boss project new`: the Git remote `origin`.
// Creating a repository is an Owner decision. The step posts a decide item to the Mailbox as `boss`, returns `waiting`,
// and creates the repository only after an Owner answer that clearly picks a choice. The step never pushes.
// The step never reads, prints, or stores a token. Every line of gh and git output passes through redact().
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { stripRemoteCredentials } from './harness.js';
import { appendMessage, closeMailboxItems, readMessages } from './messages.js';

const CHOICE_PRIVATE = 'Create private';
const CHOICE_PUBLIC = 'Create public';
const CHOICE_DECLINE = 'Do not create';
const GH_LOGIN_PLACEHOLDER = '<gh login>';
const TIMEOUT_MS = 60_000;
export const ORG_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export class RemoteError extends Error {}
const refuse = (message) => { throw new RemoteError(message); };

// Remove the text that can hold a credential: tokens, URL user information, and bearer values.
export function redact(text) {
  return String(text ?? '')
    .replace(/\b(?:gh[posur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[redacted]')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1');
}

const WIZARD_CLOSE_NOTE = 'answered in the wizard';

// The decision of the wizard: the Owner chose the visibility in the dashboard. Only the dashboard routes send it.
// A public choice needs confirmPublic: true, which the wizard sends after the Owner typed the word public.
export function checkDecision(decision) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) refuse('The decision must be an object.');
  const { visibility, source, confirmPublic } = decision;
  if (source !== 'wizard') refuse('The decision source must be wizard.');
  if (!['private', 'public'].includes(visibility)) refuse('The decision visibility must be private or public.');
  if (visibility === 'public' && confirmPublic !== true) refuse('A public repository needs confirmPublic true. Type the word public to confirm it.');
  return { visibility, source };
}

const NO_CREDENTIALS = 'The remote URL must not hold credentials. Remove the user name and the password from the URL.';

// A remote URL is https, ssh, or git, or the scp form user@host:path. It holds no credential. The message never holds the URL.
export function validateRemoteUrl(value) {
  const url = typeof value === 'string' ? value.trim() : '';
  const invalid = 'The remote URL must be a https, ssh, or git URL, or user@host:path.';
  if (!url || /[\s\0]/.test(url)) refuse(invalid);
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(url) && !url.includes('://')) return url;
  const match = /^(https|ssh|git):\/\/(?:([^/@]*)@)?([^/@]+)\/\S*$/.exec(url);
  if (!match) refuse(invalid);
  const [, scheme, userinfo] = match;
  if (userinfo !== undefined && (scheme !== 'ssh' || userinfo.includes(':'))) refuse(NO_CREDENTIALS);
  return url;
}

// The Owner choice in a reply: 'private', 'public', 'decline', or null when the reply does not clearly pick a choice.
// The rule is conservative. A negation or a hedge word next to a choice, or in a reply that is not a plain decline, gives null.
// A public repository needs the word public and is possible only when the item offered it.
export function classifyAnswer(text, { offerPublic = false } = {}) {
  const answer = String(text ?? '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!answer) return null;
  if (/\b(?:maybe|but|not sure|unsure|later|wait|however|hmm|think|yet)\b/.test(answer)) return null;
  const negated = /\b(?:not|isn't|isnt|no|never|without|don't|dont|do not|cannot|can't|cant|nope|nei|decline|cancel)\b/.test(answer);
  if (negated) return /^(?:no|nope|nei|decline|cancel|(?:do not|don't|dont) create(?: it| this)?)(?: thanks| please)?$/.test(answer) ? 'decline' : null;
  const hasPrivate = /\bprivate\b/.test(answer);
  const hasPublic = /\bpublic\b/.test(answer);
  if (hasPrivate && hasPublic) return null;
  if (hasPublic) return offerPublic ? 'public' : null;
  if (hasPrivate) return 'private';
  if (/^(?:yes|yep|yeah|ok|okay|ja|approve|approved|go ahead|do it|create it)\b/.test(answer)) return offerPublic ? null : 'private';
  return null;
}

// Find the command in the PATH of the given environment, so a test can put a fake gh first.
function findCommand(command, env) {
  for (const dir of String(env?.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, command);
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch {}
  }
  return command;
}

export function run(command, args, { cwd, env, timeout = TIMEOUT_MS } = {}) {
  const result = spawnSync(findCommand(command, env), args, { cwd, env, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: result.status, error: result.error, stdout: result.stdout || '', stderr: result.stderr || '' };
}

export const ghEnv = (context) => ({ ...process.env, ...(context.env || {}), GH_PROMPT_DISABLED: '1', NO_COLOR: '1' });
export const gitEnv = (context) => ({ ...process.env, ...(context.env || {}), GIT_TERMINAL_PROMPT: '0' });
export const originUrl = (inputs, context) => {
  const result = run('git', ['config', '--get', 'remote.origin.url'], { cwd: inputs.path, env: gitEnv(context) });
  return result.status === 0 ? result.stdout.trim() : null;
};
const shown = (url) => redact(stripRemoteCredentials(url));

// The visibility of the flow: a saved or a new wizard decision, else the option.
const chosenVisibility = (context) => context.decision?.visibility ?? context.ids?.remoteDecision?.visibility;

function checkOptions(context) {
  const remote = context.remote ?? 'none';
  const visibility = chosenVisibility(context) ?? context.visibility ?? 'private';
  if (!['private', 'public'].includes(visibility)) refuse('The visibility must be private or public.');
  if (remote !== 'gh' && remote !== 'none') validateRemoteUrl(remote);
  if (context.org !== undefined && context.org !== null && !ORG_NAME.test(String(context.org))) refuse('The organization must be an organization or user name: letters, digits, and hyphens, and it must not start with a hyphen.');
  return { remote, visibility, org: context.org || null };
}

const repoName = (org, inputs) => `${org || GH_LOGIN_PLACEHOLDER}/${inputs.slug}`;
const createArgs = (repo, visibility, inputs) => ['repo', 'create', repo, `--${visibility}`, '--source', inputs.path, '--remote', 'origin'];

// The text of the dry run.
export function describeRemote(inputs, context) {
  const { remote, visibility, org } = checkOptions(context);
  if (remote === 'none') return 'skipped: --remote none';
  if (remote !== 'gh') return `run git remote add origin ${shown(remote)}, then git ls-remote origin; push nothing`;
  if (chosenVisibility(context)) return `run gh repo create ${repoName(org, inputs)} --${visibility} --source ${inputs.path} --remote origin without a decide item, because the wizard chose ${visibility}; push nothing`;
  return `post a decide item for ${repoName(org, inputs)} (${visibility}), exit with code 3, and after a clear Owner answer run gh repo create ${repoName(org, inputs)} --${visibility} --source ${inputs.path} --remote origin; push nothing`;
}

function decisionText(inputs, { repo, visibility, org }) {
  const offerPublic = visibility === 'public';
  return [
    `Decision: create the GitHub repository ${repo}?`,
    '',
    `Project: ${inputs.slug}. Visibility: ${visibility}${offerPublic ? '' : ' (default)'}.`,
    org ? `The organization is ${org}.` : 'The organization is the account of the gh login.',
    `On yes, Herdr Boss runs: gh repo create ${repo} --${offerPublic ? 'private or --public' : 'private'} --source ${inputs.path} --remote origin`,
    'Herdr Boss creates nothing until you answer. Herdr Boss does not push.',
    offerPublic ? 'A public repository needs an answer that contains the word public.' : 'Herdr Boss creates a private repository only.',
    '',
    '### Choices',
    '',
    `- ${CHOICE_PRIVATE}`,
    ...(offerPublic ? [`- ${CHOICE_PUBLIC}`] : []),
    `- ${CHOICE_DECLINE}`,
  ].join('\n');
}

// The latest Owner reply to the item that clearly picks a choice, or null.
function readAnswer(ask, context) {
  const replies = readMessages({ dir: context.dataDir }).filter((record) => record.from === 'owner' && record.replyTo === ask.id);
  // Only the newest reply counts. An unclear newest reply keeps the flow waiting.
  const newest = replies[replies.length - 1];
  return newest ? classifyAnswer(newest.text, { offerPublic: ask.visibility === 'public' }) : null;
}

function postLoginItem(repo, context) {
  if (context.ids.remoteLoginItem) return;
  const text = [
    `Herdr Boss cannot create the GitHub repository ${repo}: the gh command has no login.`,
    'Run `gh auth login` in a terminal. Then answer here. The flow continues with `herdr-boss project new ... --resume`.',
    'Herdr Boss never reads or stores the gh token.',
  ].join('\n');
  const record = appendMessage({ thread: 'boss', from: 'boss', to: 'owner', kind: 'reply', text, action: 'answer', replyTo: null, status: 'new' }, { dir: context.dataDir });
  context.remember({ remoteLoginItem: record.id });
}

function ghLogin(inputs, context) {
  const status = run('gh', ['auth', 'status'], { cwd: inputs.path, env: ghEnv(context) });
  if (status.error?.code === 'ENOENT') {
    postLoginItem(repoName(context.org, inputs), context);
    refuse('The gh command is not installed. Install GitHub CLI and run `gh auth login`, then run the flow again with --resume.');
  }
  if (status.status !== 0) {
    postLoginItem(repoName(context.org, inputs), context);
    refuse('The gh command is not logged in. Run `gh auth login` in a terminal, then run the flow again with --resume.');
  }
  if (context.org) return context.org;
  const user = run('gh', ['api', 'user', '--jq', '.login'], { cwd: inputs.path, env: ghEnv(context) });
  const login = user.stdout.trim();
  if (user.status !== 0 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) refuse(`The gh login name could not be read. ${redact(user.stderr).trim().slice(0, 300)}`.trim());
  return login;
}

function verifyOrigin(inputs, context) {
  const check = run('git', ['ls-remote', 'origin'], { cwd: inputs.path, env: gitEnv(context) });
  if (check.status !== 0) refuse(`git ls-remote origin failed. ${redact(check.stderr).trim().slice(0, 300)}`.trim());
}

function addUrlRemote(inputs, context, url) {
  const existing = originUrl(inputs, context);
  if (existing !== null) {
    if (stripRemoteCredentials(existing) === url) return `origin already is ${shown(url)}`;
    refuse(`The remote origin is ${shown(existing)}. It is not the requested remote ${shown(url)}. Remove it or change --remote.`);
  }
  const add = run('git', ['remote', 'add', 'origin', url], { cwd: inputs.path, env: gitEnv(context) });
  if (add.status !== 0) refuse(`git remote add origin failed. ${redact(add.stderr).trim().slice(0, 300)}`.trim());
  try { verifyOrigin(inputs, context); } catch (error) {
    run('git', ['remote', 'remove', 'origin'], { cwd: inputs.path, env: gitEnv(context) });
    throw error;
  }
  return `added origin ${shown(url)} and checked it with git ls-remote origin. Nothing was pushed`;
}

function ghRemote(inputs, context, { visibility, org }) {
  const existing = originUrl(inputs, context);
  const tail = new RegExp(`[/:]${org ? `${org.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/` : '[^/:]+/'}${inputs.slug}(?:\\.git)?/?$`, 'i');
  if (existing !== null) {
    if (tail.test(stripRemoteCredentials(existing))) return `origin already is ${shown(existing)}`;
    refuse(`The remote origin is ${shown(existing)}. It is not ${repoName(org, inputs)}. Remove it or change --remote.`);
  }
  if (context.ids.remoteCreated) refuse(`The state says ${context.ids.remoteCreated} was created, but the remote origin is missing. Run git remote add origin URL in ${inputs.path}, then run the flow again with --resume.`);

  let ask = context.ids.remoteAsk;
  // A wizard decision is the Owner choice. It needs no item, and an open item is closed.
  if (context.decision) context.remember({ remoteDecision: { ...checkDecision(context.decision), at: new Date().toISOString() } });
  const decided = context.ids.remoteDecision;
  if (decided) {
    if (ask && !ask.closed) {
      closeMailboxItems([ask.id], WIZARD_CLOSE_NOTE, { by: 'boss', dir: context.dataDir });
      context.remember({ remoteAsk: { ...ask, closed: true } });
    }
    return createRepository(inputs, context, decided.visibility);
  }
  if (!ask) {
    const repo = repoName(org, inputs);
    const record = appendMessage({ thread: 'boss', from: 'boss', to: 'owner', kind: 'reply', text: decisionText(inputs, { repo, visibility, org }), action: 'decide', replyTo: null, status: 'new' }, { dir: context.dataDir });
    ask = { id: record.id, repo, visibility };
    context.remember({ remoteAsk: ask });
  } else if (ask.visibility !== visibility) {
    refuse(`The Owner question ${ask.id} asked for ${ask.visibility}. Run the flow again with --visibility ${ask.visibility}, or remove the state file.`);
  }
  const answer = readAnswer(ask, context);
  if (!answer) return { status: 'waiting', detail: `waiting for an Owner decision: mailbox item ${ask.id}` };
  if (answer === 'decline') return { status: 'skipped', detail: 'skipped: Owner declined' };

  return createRepository(inputs, context, answer);
}

function createRepository(inputs, context, visibility) {
  const owner = ghLogin(inputs, context);
  const repo = `${owner}/${inputs.slug}`;
  const created = run('gh', createArgs(repo, visibility, inputs), { cwd: inputs.path, env: ghEnv(context) });
  if (created.status !== 0) {
    const message = redact(`${created.stderr}${created.stdout}`).trim().split('\n').slice(0, 3).join(' ').slice(0, 400);
    refuse(`gh repo create ${repo} failed: ${message || 'no message'}`);
  }
  context.remember({ remoteCreated: repo });
  verifyOrigin(inputs, context);
  return `created the ${visibility} repository ${repo}, added origin ${shown(originUrl(inputs, context) || '')}, and checked it with git ls-remote origin. Nothing was pushed`;
}

export function remoteStep(inputs, context) {
  const options = checkOptions(context);
  if (options.remote === 'none') return { status: 'skipped', detail: 'skipped: --remote none' };
  if (options.remote !== 'gh') return addUrlRemote(inputs, context, options.remote.trim());
  return ghRemote(inputs, context, options);
}
