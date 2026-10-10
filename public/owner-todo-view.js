// The Mailbox To do rows. All action drafts stay with the client during a refresh.
export function todoListHtml(items, history, { drafts, status, busy }, { esc, markdownBlock, projects, now = Date.now() }) {
  const row = (item) => {
    const id = esc(item.id);
    const draft = drafts[item.id];
    const off = busy ? ' disabled' : '';
    const closed = ['done', 'cancelled'].includes(item.state);
    const last = item.ownerActions?.at(-1);
    const project = item.project === 'boss' ? 'Boss' : projects?.[item.project]?.label || item.project;
    const ageMs = Math.max(0, now - Date.parse(item.createdAt || item.at));
    const age = ageMs < 60000 ? 'now' : ageMs < 3600000 ? `${Math.floor(ageMs / 60000)}m` : ageMs < 86400000 ? `${Math.floor(ageMs / 3600000)}h` : `${Math.floor(ageMs / 86400000)}d`;
    const action = (key, label) => `<button type="button" data-todo-id="${id}" data-todo-action="${key}"${off}>${label}</button>`;
    const reasonId = `todo-reason-${id}`;
    const timeId = `todo-until-${id}`;
    const answerId = `todo-answer-${id}`;
    let form = '';
    if (draft && !closed) {
      const reasonLabel = draft.action === 'answer' ? 'Answer or note' : 'Reason';
      const textAnswer = draft.action === 'answer' && item.type !== 'decide';
      const field = textAnswer
        ? `<label for="${answerId}">Answer</label><textarea id="${answerId}" data-todo-answer="${id}" maxlength="2000" rows="3" required${off}>${esc(draft.answer || '')}</textarea>`
        : draft.action === 'snooze'
        ? `<label for="${timeId}">Snooze until</label><input id="${timeId}" type="datetime-local" data-todo-until="${id}" value="${esc(draft.until || '')}" required${off}>`
        : `<label for="${reasonId}">${reasonLabel}</label><textarea id="${reasonId}" data-todo-reason="${id}" maxlength="2000" rows="3"${draft.action === 'answer' ? '' : ' required'}${off}>${esc(draft.reason || '')}</textarea>`;
      const submit = textAnswer ? `<button type="submit"${off}>Save Answer</button>` : draft.action === 'answer'
        ? `<button type="submit" data-todo-decision="accept"${off}>Accept</button><button type="submit" data-todo-decision="deny"${off}>Deny</button><button type="submit"${off}>Save Answer</button>`
        : `<button type="submit"${off}>${{ blocked: 'Save Blocked', snooze: 'Snooze', 'not-now': 'Save Not now' }[draft.action]}</button>`;
      form = `<form class="todo-action-form" data-key="todo-form:${id}" data-todo-form="${id}" aria-label="${esc(draft.action)}">${field}<div class="todo-actions">${submit}<button type="button" data-todo-cancel="${id}"${off}>Cancel</button></div></form>`;
    }
    const saved = item.closedBy === 'poster' ? `<p class="todo-saved">cancelled${item.cancelNote ? ` · ${esc(item.cancelNote)}` : ''}</p>`
      : last ? `<p class="todo-saved">${esc(last.decision || item.state)}${last.answer ? ` · ${esc(last.answer)}` : ''}${last.reason ? ` · ${esc(last.reason)}` : ''}${item.snoozedUntil ? ` · until ${esc(new Date(item.snoozedUntil).toLocaleString())}` : ''}</p>` : '';
    const buttons = closed ? '' : item.state === 'open'
      ? `${action('answer', 'Answer')}${action('done', item.type === 'read' ? 'Mark read' : 'Done')}${action('blocked', 'Blocked')}${action('snooze', 'Snooze')}${action('not-now', 'Not now')}`
      : action('reopen', 'Reopen');
    return `<li class="todo-row" data-key="todo:${id}"><div class="todo-meta"><span>${esc(project)}</span><span class="todo-type">${esc(item.type)}</span><span>${esc(item.priority)}</span><time datetime="${esc(item.createdAt || item.at)}" title="${esc(item.createdAt || item.at)}">${age}</time></div>`
      + `<h2 class="todo-title">${esc(item.title)}</h2><p class="todo-blocks"><strong>Blocks:</strong> ${esc(item.blocks)}</p><p class="todo-poster">Asked by ${esc(item.poster?.role || item.from)}${item.poster?.pane ? ` · ${esc(item.poster.pane)}` : ''}</p>`
      + `<details class="todo-details" data-key="todo-details:${id}"><summary>Why and steps</summary><h3>Why</h3>${markdownBlock(item.why, 'todo-copy')}<h3>Steps</h3>${markdownBlock(item.steps, 'todo-copy')}<h3>Expected result</h3>${markdownBlock(item.expectedResult, 'todo-copy')}<h3>How to answer</h3>${markdownBlock(item.howToAnswer, 'todo-copy')}</details>`
      + `${saved}<div class="todo-actions" role="group" aria-label="Actions for ${esc(item.title)}">${buttons}</div>${form}<p class="todo-status" role="status"${status[item.id] ? '' : ' hidden'}>${esc(status[item.id] || '')}</p></li>`;
  };
  const open = items.length ? `<ol class="todo-list">${items.map(row).join('')}</ol>` : '<div class="mail-empty"><p>No open To do items.</p><p>Owner actions from the Boss and project leads appear here.</p></div>';
  return open + (history.length ? `<details class="todo-history" data-key="todo-history"><summary>Blocked, snoozed and closed · ${history.length}</summary><ol class="todo-list">${history.map(row).join('')}</ol></details>` : '');
}
