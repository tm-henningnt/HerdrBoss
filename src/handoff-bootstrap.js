// The generated sections of the handover bootstrap prompt. Each section is bounded in size, so a long
// policy text, a large roster, or a busy Mailbox cannot fill the prompt of the successor.
// The K27 cap stays: the bootstrap still tells the successor to read only the memory file, the published
// project status, and the open items in it. The sections add generated context, not new sources.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { BOSS_RULES_MAX, loadPolicy } from './control.js';
import { listProjects } from './projects.js';
import { mailboxFolders, readMessages } from './messages.js';

// The most characters of each generated section. A section over its cap ends with the truncation marker.
export const SECTION_LIMITS = { bossRules: BOSS_RULES_MAX, paneMap: 1400, openItems: 1800 };
export const TRUNCATION_MARKER = '[truncated]';
export const DECISION_WINDOW_MS = 48 * 60 * 60 * 1000;
// The date prefix of a memory file line that records an Owner decision.
const DECISION_LINE = /^\s*[-*]?\s*(\d{4}-\d{2}-\d{2})\s*:\s*(.+)$/;
const ORCHESTRATOR_SUFFIX = '-orch';
// The Boss memory file is private. A Boss handover reads no project memory file, so it gets no decisions.
export const BOSS_DECISIONS_OMITTED = 'The Boss memory file is private. A Boss handover generates no Owner decisions.';

function bound(text, limit) {
  const value = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - TRUNCATION_MARKER.length - 1).trimEnd()}${TRUNCATION_MARKER}`;
}

function section(title, body) {
  const text = bound(body, SECTION_LIMITS[keyOf(title)]);
  return text ? { title, body: text, text: `${title}:\n${text}\nEnd ${title}.` } : null;
}

const keyOf = (title) => ({ 'Boss rules': 'bossRules', 'Pane map': 'paneMap', 'Open items': 'openItems' })[title];

// The standing rules from the policy field `bossRules`. They are data for the successor, not a new source.
export function bossRulesSection(rules) {
  return section('Boss rules', String(rules ?? '').trim());
}

const agentName = (agent) => agent?.name ?? agent?.agent_name ?? null;
const agentPane = (agent) => agent?.pane_id ?? agent?.paneId ?? agent?.pane ?? null;

// The pane of each registered project and of the Boss, from the agent roster and the project registry.
// A project with no live pane is listed as missing, so the successor never guesses a pane ID.
export function paneMapSection({ agents = [], projects = [] } = {}) {
  const panes = new Map();
  for (const agent of Array.isArray(agents) ? agents : []) {
    const name = agentName(agent);
    if (typeof name !== 'string') continue;
    if (name !== 'boss' && !name.endsWith(ORCHESTRATOR_SUFFIX)) continue;
    const pane = agentPane(agent);
    if (typeof pane === 'string' && pane) panes.set(name, pane);
  }
  const lines = [`- Boss: ${panes.get('boss') || 'no live pane'}`];
  for (const project of Array.isArray(projects) ? projects : []) {
    const slug = typeof project === 'string' ? project : project?.slug;
    if (typeof slug !== 'string' || !slug) continue;
    lines.push(`- ${slug}: ${panes.get(`${slug.toLowerCase()}${ORCHESTRATOR_SUFFIX}`) || 'no live pane'}`);
  }
  return section('Pane map', lines.join('\n'));
}

const list = (title, rows) => `${title} (${rows.length}):\n${rows.join('\n')}`;

// The open Mailbox items of this project, the published tasks that wait on a Mailbox item, and the Owner
// decisions of the last 48 hours in the memory file.
export function openItemsSection({ items = [], tasks = [], decisions = [], decisionsOmitted = null } = {}) {
  const rows = [];
  const mail = (Array.isArray(items) ? items : []).filter((item) => item && typeof item.id === 'string' && item.id);
  rows.push(mail.length
    ? list('Mailbox items that are open', mail.map((item) => `- ${item.id} [${item.needsAction ? item.action || 'approve' : 'read'}]: ${item.title || '(no title)'}`))
    : 'Mailbox items that are open (0): none.');
  const linked = (Array.isArray(tasks) ? tasks : []).filter((task) => task && typeof task.mailboxId === 'string' && task.mailboxId);
  rows.push(linked.length
    ? list('Tasks with a Mailbox item', linked.map((task) => `- ${task.id || task.title}: ${task.title} (mailboxId ${task.mailboxId})`))
    : 'Tasks with a Mailbox item (0): none.');
  const recent = (Array.isArray(decisions) ? decisions : []).filter((entry) => entry && entry.text);
  if (decisionsOmitted) rows.push(decisionsOmitted);
  else rows.push(recent.length
    ? list('Owner decisions of the last 48 hours', recent.map((entry) => `- ${entry.date}: ${entry.text}`))
    : 'Owner decisions of the last 48 hours (0): none.');
  return section('Open items', rows.join('\n'));
}

// Every generated section of the bootstrap prompt, in a fixed order. A section with no content is dropped.
export function bootstrapSections(input = {}) {
  const sections = [bossRulesSection(input.bossRules), paneMapSection(input), openItemsSection(input)].filter(Boolean);
  return { sections, text: sections.map((entry) => entry.text).join('\n') };
}

// The Owner decisions in a memory file: the lines that start with a date, inside the last 48 hours.
// A line has a date, not a time. The window counts from the start of that date, so a decision of today
// and one of yesterday stay in and a decision of an earlier day stays out.
export function ownerDecisionsFrom(memory, { now = Date.now(), windowMs = DECISION_WINDOW_MS } = {}) {
  if (typeof memory !== 'string' || !memory) return [];
  const decisions = [];
  for (const line of memory.split('\n')) {
    const match = DECISION_LINE.exec(line);
    if (!match) continue;
    const at = Date.parse(`${match[1]}T00:00:00.000Z`);
    if (!Number.isFinite(at) || at < now - windowMs || at > now) continue;
    decisions.push({ date: match[1], text: match[2].trim() });
  }
  return decisions;
}

// The memory file of a project handover. It is a repository file, never the private Boss memory file.
export const projectMemoryFile = (cwd) => path.join(cwd, 'docs', 'orchestration', 'memory.md');

function recentOwnerDecisions(file, now) {
  try { return ownerDecisionsFrom(fs.readFileSync(file, 'utf8'), { now }); }
  catch { return []; }
}

const threadOf = (item) => (item.boss || item.label === 'boss' ? 'boss' : item.project);
const isBoss = (item) => threadOf(item) === 'boss';

// The generated sections for a handover. Every read is best effort: a missing roster, Mailbox, or memory
// file gives a shorter section, never a failed preparation.
export function handoverBootstrapText(item, { now = Date.now(), dataDir = DATA_DIR, agents = [] } = {}) {
  const boss = isBoss(item);
  let registry = [];
  try { registry = listProjects(); } catch { registry = []; }
  const projects = registry.map((entry) => ({ slug: entry.slug }));
  let items = [];
  try {
    const view = mailboxFolders(readMessages({ dir: dataDir }));
    items = view.inbox.filter((entry) => entry.thread === threadOf(item))
      .map((entry) => ({ id: entry.id, title: (entry.text || '').split('\n')[0].slice(0, 160), action: entry.action, needsAction: entry.action !== 'read' }));
  } catch { items = []; }
  const tasks = (registry.find((entry) => entry.slug === threadOf(item))?.tasks || [])
    .filter((task) => task && task.status !== 'done' && typeof task.mailboxId === 'string' && task.mailboxId);
  let bossRules = '';
  try { bossRules = loadPolicy().bossRules || ''; } catch { bossRules = ''; }
  return bootstrapSections({
    bossRules,
    agents,
    projects,
    items,
    tasks,
    decisions: boss ? [] : recentOwnerDecisions(projectMemoryFile(item.cwd), now),
    decisionsOmitted: boss ? BOSS_DECISIONS_OMITTED : null,
  }).text;
}

