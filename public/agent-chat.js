// The read-only view of the agent messages: the Agents tab of the Chat page and the Messages section of a project page.
// The module has no DOM use, so the Node tests import it directly. The caller passes esc, markdown, and time.

export const AGENT_PAGE_LIMIT = 50;
export const AGENT_DIRECTORY_LIMIT = 200;
const ROLE_LABEL = { boss: 'Boss', orch: 'Orchestrator', worker: 'Worker', unknown: 'Unknown' };

// The same rule as addressKey in src/agent-messages.js.
export function addressKey(address) {
  if (!address) return 'unknown:unknown';
  if (address.role === 'boss') return 'boss';
  if (address.role === 'orch') return `orch:${address.project || 'unknown'}`;
  if (address.role === 'worker') return `worker:${address.name || address.pane || 'unknown'}`;
  return `unknown:${address.name || address.pane || address.project || 'unknown'}`;
}

// A pair key has two address keys that a plus sign joins. A part holds a role and a name or project.
export function addressFromKey(part) {
  if (part === 'boss') return { role: 'boss' };
  const index = String(part).indexOf(':');
  const role = index < 0 ? 'unknown' : part.slice(0, index);
  const value = index < 0 ? part : part.slice(index + 1);
  if (role === 'orch') return { role, project: value };
  if (role === 'worker') return { role, name: value };
  return { role: 'unknown', name: value };
}

// One label for one end: the role first, then the name, then the project.
export function addressLabel(address) {
  const role = ROLE_LABEL[address?.role] || ROLE_LABEL.unknown;
  const parts = [];
  if (address?.name && address.role !== 'boss') parts.push(address.name);
  if (address?.project && address.role !== 'boss' && !(address.role === 'orch' && address.name === address.project)) parts.push(address.project);
  return parts.length ? `${role} ${parts[0]}${parts[1] ? ` (${parts[1]})` : ''}` : role;
}

// The messages of the directory give the full address of each end. The pair key is the fallback.
export function buildDirectory(records) {
  const directory = new Map();
  for (const record of records || []) {
    if (!record?.pairKey || directory.has(record.pairKey)) continue;
    directory.set(record.pairKey, { from: record.from, to: record.to, project: record.from?.project || record.to?.project || null });
  }
  return directory;
}

// The two ends of a pair, in the order of the pair key.
export function pairEnds(pairKey, directory) {
  const known = directory?.get(pairKey);
  return String(pairKey).split('+').map((part) => {
    const fallback = addressFromKey(part);
    const full = [known?.from, known?.to].find((address) => address && addressKey(address) === part);
    return full || fallback;
  });
}

export function pairProject(pairKey, directory) {
  const known = directory?.get(pairKey)?.project;
  if (known) return known;
  return pairEnds(pairKey, directory).find((address) => address.role === 'orch')?.project || null;
}

export const pairTitle = (pairKey, directory) => pairEnds(pairKey, directory).map(addressLabel).join(' and ');

// The query string of the three read routes. An empty value is left out.
export function agentQuery({ project, pair, q, before, limit } = {}) {
  const params = new URLSearchParams();
  if (project) params.set('project', project);
  if (pair) params.set('pair', pair);
  if (q && String(q).trim()) params.set('q', String(q).trim());
  if (before) params.set('before', before);
  if (limit) params.set('limit', String(limit));
  const text = params.toString();
  return text ? `?${text}` : '';
}

// The page address of the Agents tab. An empty value is left out.
export function agentsUrl({ project, pair, q } = {}) {
  const params = new URLSearchParams({ tab: 'agents' });
  if (project) params.set('project', project);
  if (pair) params.set('pair', pair);
  if (q && String(q).trim()) params.set('q', String(q).trim());
  return `/chat?${params}`;
}

// A search keeps the pairs that hold a matching message. The caller reads the matching messages with the same q and project.
export function filterPairs(pairs, matching) {
  if (!matching) return pairs || [];
  const keys = new Set((matching || []).map((record) => record.pairKey));
  return (pairs || []).filter((pair) => keys.has(pair.pairKey));
}

export function projectOptions(pairs, directory) {
  return [...new Set((pairs || []).map((pair) => pairProject(pair.pairKey, directory)).filter(Boolean))].sort();
}

// The API gives the newest message first. The conversation shows the newest at the bottom.
export const conversationOrder = (records) => [...(records || [])].reverse();

// An older page goes above the messages that the page shows. A message ID shows once.
export function mergeOlder(current, olderNewestFirst) {
  const seen = new Set(current.map((record) => record.id));
  return [...conversationOrder(olderNewestFirst).filter((record) => !seen.has(record.id)), ...current];
}

// A refresh reads the newest page. The messages of older pages that the page already shows stay. The order is oldest first.
export function mergeNewest(current, newestFirstPage) {
  const byId = new Map(current.map((record) => [record.id, record]));
  for (const record of newestFirstPage || []) byId.set(record.id, record);
  const time = (record) => Date.parse(record.createdAt || record.at) || 0;
  return [...byId.values()].sort((left, right) => time(left) - time(right) || left.id.localeCompare(right.id));
}

// The list row of one pair. The row has no unread badge: an agent message is never unread.
export function agentPairRowHtml(pair, { esc, time, directory, open = false, href = null, project = '' }) {
  const ends = pairEnds(pair.pairKey, directory);
  const detail = pairProject(pair.pairKey, directory);
  const count = `${pair.count} message${pair.count === 1 ? '' : 's'}`;
  const label = `Open the conversation of ${pairTitle(pair.pairKey, directory)}. ${count}.`;
  const attributes = `class="chat-row agent-row" type="button" data-agent-open="${esc(pair.pairKey)}"${open ? ' aria-current="true"' : ''} aria-label="${esc(label)}"`;
  const body = `<span class="chat-main"><span class="chat-line-one"><span class="chat-name">${esc(addressLabel(ends[0]))}</span><span class="chat-time">${esc(time(pair.lastAt))}</span></span>`
    + `<span class="chat-line-one agent-second"><span class="chat-name">${esc(addressLabel(ends[1]))}</span></span>`
    + `<span class="chat-line-two"><span class="chat-preview">${esc(count)}${detail && !project ? ` · ${esc(detail)}` : ''}</span></span></span>`;
  if (href) return `<li class="chat-item" data-key="agent:${esc(pair.pairKey)}"><a class="chat-row agent-row" href="${esc(href)}" aria-label="${esc(label)}">${body}</a></li>`;
  return `<li class="chat-item" data-key="agent:${esc(pair.pairKey)}"><button ${attributes}>${body}</button></li>`;
}

// One message. The sender and the receiver are visible, so the section of a project and the conversation read the same.
export function agentBubbleHtml(record, { esc, markdown, clock, firstEnd = null, showEnds = false }) {
  const sender = addressLabel(record.from);
  const receiver = addressLabel(record.to);
  const side = firstEnd && addressKey(record.from) !== firstEnd ? ' from-owner' : ' from-agent';
  const badges = [];
  if (record.agentKind) badges.push(`<span class="agent-kind">${esc(record.agentKind)}</span>`);
  if (record.status === 'failed') badges.push('<span class="chat-state fail agent-status">failed</span>');
  else if (record.status === 'recorded') badges.push('<span class="chat-state agent-status">recorded</span>');
  const label = `${sender} to ${receiver}${record.agentKind ? `, ${record.agentKind}` : ''}${record.status === 'failed' || record.status === 'recorded' ? `, ${record.status}` : ''}. ${record.text}`;
  const head = showEnds ? `<p class="agent-ends">${esc(sender)} → ${esc(receiver)}</p>` : `<p class="agent-ends">${esc(sender)}</p>`;
  return `<li class="chat-bubble agent-bubble${side} run-start" data-key="agentmsg:${esc(record.id)}" data-agent-message="${esc(record.id)}" aria-label="${esc(label.length > 300 ? `${label.slice(0, 300)}…` : label)}">`
    + `${head}<div class="chat-bubble-text md">${markdown(record.text)}</div>`
    + `<p class="chat-bubble-meta"><span class="chat-bubble-time">${esc(clock(record.createdAt || record.at))}</span>${badges.length ? ` ${badges.join(' ')}` : ''}</p></li>`;
}

// The conversation of one pair, or the last messages of a project.
export function agentMessagesHtml(records, { emptyText = 'No messages.', firstEnd = null, showEnds = false, ...deps }) {
  if (!records.length) return `<p class="chat-empty">${deps.esc(emptyText)}</p>`;
  return `<ol class="chat-bubbles agent-bubbles" role="log" aria-label="Agent messages">${records.map((record) => agentBubbleHtml(record, { ...deps, firstEnd, showEnds })).join('')}</ol>`;
}
