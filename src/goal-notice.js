// The Mailbox item that tells the Owner why `goal set` could not put the goal on a pane.
// The text names the project, the pane id, and the reason. It never holds pane text.
import { DATA_DIR } from './config.js';
import { appendMessage, readMessages, validThread } from './messages.js';

export const NOTICE_INTERVAL_MS = 60 * 60 * 1000;

const TAILS = {
  input: (pane) => ({ middle: `the input box of pane ${pane} holds unsent text.`, tail: ' Send or clear it, then press Set goal again.' }),
  dialog: (pane) => ({ middle: `a dialog is on screen in pane ${pane}.`, tail: ' Answer it, then press Set goal again.' }),
  working: (pane) => ({ middle: `the agent of pane ${pane} kept working.`, tail: ' Press Set goal again when it is idle.' }),
};

// Add one item for the blocker. At most one item for each project and blocker in one hour.
// Returns the record, or null when no item was added.
export function postGoalNotice({ slug, pane, blocker, dir = DATA_DIR, now = Date.now }) {
  const make = TAILS[blocker];
  if (!make) return null;
  const { tail } = make('');
  const who = slug ?? `pane ${pane}`;
  const head = `Goal not set on ${who}: `;
  const text = `${head}${make(pane).middle}${make(pane).tail}`;
  const thread = slug && validThread(slug) ? slug : 'boss';
  const at = now();
  // Another pane of the same project still counts as the same notice: match the head and the tail, not the pane id.
  const recent = readMessages({ dir }).some((record) => record.thread === thread && record.action === 'answer'
    && typeof record.text === 'string' && record.text.startsWith(head) && record.text.endsWith(tail)
    && at - Date.parse(record.at) < NOTICE_INTERVAL_MS && Date.parse(record.at) <= at + 1000);
  if (recent) return null;
  return appendMessage({ thread, from: 'boss', to: 'owner', kind: 'reply', text, action: 'answer', replyTo: null, status: 'new' }, { dir, now: at });
}
