// The phone bars of the Mailbox. On a phone the actions of the open item and of a selection sit in a bar at the bottom edge, in reach of the thumb.
// The module has no DOM use, so the Node tests import it directly.

const OPEN_ACTIONS = new Set(['answer', 'approve', 'decide']);

// The open answer, approve, or decide item of the last agent message. The bar holds its actions, so the thread shows no Reply form.
// An older open item keeps its form in its message. The rule is the same as mailReplyFormShown in app.js.
export function mailBarItem(records, find) {
  const lastAgent = [...records].reverse().find((record) => ['boss', 'orch'].includes(record.from) && record.to === 'owner');
  const item = lastAgent ? find(lastAgent.id) : null;
  return item && !item.closedAt && OPEN_ACTIONS.has(item.action) ? item : null;
}

// helpers: esc, icon(name), busy, draft (the typed text of the item), status, and noteOpen.
export function mailActionBarHtml(item, helpers) {
  const { esc, icon, busy = false, draft = '', status = '', noteOpen = false } = helpers;
  const id = esc(item.id);
  const off = busy ? ' disabled' : '';
  const choices = item.action === 'decide' && item.choices?.length ? item.choices : null;
  const dismiss = `<button type="button" class="app-icon-button mail-bar-icon" data-mail-dismiss="${id}" aria-label="Dismiss" title="Dismiss without an answer"${off}>${icon('archive')}</button>`;
  const send = `<button type="submit" class="mail-bar-send" aria-label="Send"${off}>${icon('send')}</button>`;
  const field = (label, max, required, placeholder) => `<label class="visually-hidden" for="mail-text-${id}">${label}</label><textarea id="mail-text-${id}" data-mail-draft="${id}" maxlength="${max}" rows="1"${required ? ' required' : ''} placeholder="${placeholder}">${esc(draft)}</textarea>`;
  const note = (label) => `<button type="button" class="app-icon-button mail-bar-icon" data-mail-note="${id}" aria-label="${label}" title="${label}"${off}>${icon('pencil')}</button>`;
  const noteShown = noteOpen || Boolean(draft);
  let rows;
  if (item.action === 'approve') {
    rows = `${noteShown ? `<div class="mail-bar-row mail-bar-compose">${field('Note (optional)', 1700, false, 'Note (optional)')}</div>` : ''}`
      + `<div class="mail-bar-row"><button type="submit" class="mail-bar-primary" data-mail-verdict="Approved."${off}>Approve</button><button type="submit" class="mail-decline" data-mail-verdict="Rejected."${off}>Reject</button>${noteShown ? '' : note('Add a note')}${dismiss}</div>`;
  } else if (choices) {
    const buttons = choices.map((choice) => `<button type="button" data-mail-choice="${esc(choice)}" data-mail-item="${id}"${off}>${esc(choice)}</button>`).join('');
    rows = `<div class="mail-bar-row"><div class="mail-bar-choices" role="group" aria-label="Choices">${buttons}</div>${noteShown ? '' : note('Write another answer or a note')}${dismiss}</div>`
      + (noteShown ? `<div class="mail-bar-row mail-bar-compose">${field('Other answer, or a note for the choice', 1700, false, 'Other answer or note…')}${send}</div>` : '');
  } else {
    const label = item.action === 'decide' ? 'Decision' : 'Answer';
    rows = `<div class="mail-bar-row mail-bar-compose">${dismiss}${field(label, 2000, true, `${label}…`)}${send}</div>`;
  }
  return `<form class="mail-action-bar" data-key="mail-bar:${id}" data-mail-form="${id}" aria-label="Actions">${rows}<p class="mail-status" role="status">${esc(status)}</p></form>`;
}

// The selection bar replaces the New button while rows of Needs you are selected.
export function mailSelectionBarHtml({ selected, total, busy = false, esc, icon }) {
  const all = total > 0 && selected >= total;
  return `<div class="mail-action-bar mail-select-bar" data-key="mail-select-bar" role="region" aria-label="Selection">`
    + `<div class="mail-bar-row"><button type="button" class="app-icon-button mail-bar-icon" data-mail-select-clear aria-label="Clear the selection">${icon('close')}</button>`
    + `<span class="mail-select-count" aria-live="polite"><span class="num">${esc(String(selected))}</span> selected</span>`
    + `<label class="mail-bar-all"><input type="checkbox" data-mail-select-all aria-label="Select all Needs-you items"${all ? ' checked' : ''}><span aria-hidden="true">All</span></label>`
    + `<button type="button" class="mail-bar-primary" data-mail-dismiss-selected${busy ? ' disabled' : ''}>Dismiss ${esc(String(selected))}</button></div></div>`;
}
