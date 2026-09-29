# Design: M1 Mailbox and Chat polish, phone first

**Status:** Plan only. This document changes no code. The build follows in the tasks in [Build tasks](#build-tasks).

**Mockup:** [m1-mailbox-chat-mockup.html](m1-mailbox-chat-mockup.html). Open the file through a local HTTP server. The index lists each state as a link. At 760 px and less, the phone layout shows. Above 760 px, the desktop layout shows. The query parameters select one state: `page=mail|chat`, `open=1`, `item=approve`, `select=1`, `drawer=1`, `kbd=1`, `scrolled=1`, `theme=light|dark`.

## Goal

The Owner uses the Mailbox and the Chat mostly on a phone. Both pages work badly there and waste space. This plan does four things:

1. It makes the Chat a full-screen messenger view on the phone and two full-height panes on the desktop.
2. It makes the Mailbox a dense Gmail-style list with folders, a full-screen thread view, a slim action bar, and bulk select.
3. It stops the jump to the top on each automatic refresh.
4. It renders Markdown safely in both pages, with a small renderer in this repository.

Mode: Operate. The Owner completes a task: read, answer, approve, decide, or dismiss. Scan speed and native phone conventions come before expression.

## Fixed decisions

These decisions come from `docs/orchestration/memory.md` (the two M1 lines). This plan does not reopen them.

- The phone Chat is a full-screen app view: `100dvh`, safe-area insets, a slim top bar with Back, the avatar, and the name. The message list fills the space. The composer is pinned above the keyboard. No page header, no menu bar, and no card frames show. Bubbles are compact and grouped. The chat list has one dense row per chat.
- The desktop Chat has two panes that fill the window.
- The Mailbox has the folders Needs you, Inbox, Reports and updates, and Done. It has a dense list with one row per thread, a full-screen thread view on the phone with Back, and a slim action bar with answer, approve, decide, dismiss, and mark read. It has bulk select and fills the viewport height.
- The check covers 390 px, 430 px, and desktop, in light and dark, and with the phone keyboard open.
- Claude Opus 5.5 builds M1. The Impeccable skill shapes and critiques the pages.

## What exists now

The line numbers refer to the `main` tree at commit `dfd3aa7`.

| Area | Now | Problem |
|---|---|---|
| Render loop | `render()` (`public/app.js:3674`) builds the whole page as one string. It sets `$app.innerHTML` when the string changes. | Each change replaces every element. Inner scroll positions, focus, and open states are lost. |
| Refresh | `setInterval(refreshExtras, 30000)` (`public/app.js:4716`) clears `lastRender` and calls `loadMailbox()` and `render()`. `setInterval(render, 10000)` also runs. Each `state` event calls `render()`, and a changed mailbox count calls `loadMailbox()`. | The Mailbox list, the Mailbox thread, and the Chat list jump to the top every 30 seconds. |
| Chat scroll | `chatCaptureView()` and `chatRestoreView()` (`public/app.js:2451`) keep the message scroll and the draft. | The chat list scroll is not kept. The restore runs after a full replacement, so the page flickers on slow phones. |
| Mailbox drafts | `mailDrafts` and `mailRestoreDrafts()` (`public/app.js:1985`) put the typed text back after each render. | The caret position, the scroll in the text area, and the conversation scroll are lost. |
| Page frame | The global header `.top` and `main` padding show on every page (`public/style.css:41`, `:53`). | On the phone, 60 px of header and 64 px of padding show above and below each page. |
| Mailbox layout | Three framed cards: folders, list, and reading pane (`.mailbox-layout`, `public/style.css:978`). The phone shows the folders as a 2×2 grid of framed links above the list (`:1046`). A page intro with a heading, a description, and New message shows at the top (`public/app.js:1809`). | The folder grid and the intro use about 200 px before the first row. The reading pane has `max-height: 72vh`, and the phone conversation has `max-height: 42dvh`, so a long report reads in a small box. |
| Mailbox rows | One row for each item, not for each conversation. Three lines: meta, pill, and headline (`mailItem`, `public/app.js:1748`). | Rows are tall. The same conversation can show more than once. |
| Mailbox folders | `needs-you`, `updates`, `sent`, and `done`. The server accepts only these four (`src/server.js:571`). | The Owner asks for Inbox, and for Reports and updates as the name of Updates. |
| Bulk select | Only in Needs you, with Dismiss selected (`public/app.js:1797`). | No mark read. No select in other folders. |
| Actions | A form with a text area in each open item inside the thread (`mailActions`, `public/app.js:1716`). Each send asks `confirm()`. | The actions scroll away with the text. The native confirm box is slow on a phone. |
| Chat layout | Two framed panes. The phone panel is `height: min(78dvh, 720px)` under the global header (`public/style.css:1148`). | The composer does not follow the keyboard. The page header and the frame use space. |
| Chat bubbles | Plain text (`esc(text)`). The avatar shows on the first bubble of a run. The state shows as text: `delivered 07:44`. | No Markdown. No day separators. No unread marker. The state text is long. |
| Markdown | `markdownHtml()` (`public/app.js:1511`) handles headings, flat lists, fenced code, inline code, bold, and italic. Only reports use it. | No tables, nested lists, quotes, rules, links, or task lists. The test report shows its tables as raw pipes. |
| Tests | Tests read `public/app.js` as text and extract functions with a regular expression (`test/mailbox.test.js:121`). | New pure logic needs its own module so that the tests can import it. |

## References and the behaviors copied

Each behavior names its reference and the reason for Herdr Boss.

### Gmail mobile (Android and iOS) for the phone Mailbox

| Behavior copied | Reason |
|---|---|
| A slim top bar with the menu button, the folder name, and one action. The folders are in a drawer that opens from the menu button. The drawer also holds the other pages. | It removes the 2×2 folder grid and the global header from the phone. The list starts 52 px below the top of the screen. |
| One row for each conversation, with the avatar, the sender, the message count, the time, the subject, and the preview. An unread row shows the sender and the subject in bold. | The Owner scans the sender and the subject first. The count shows that a conversation has more than one message. |
| A tap on the avatar selects the row. The top bar then changes into a selection bar with the count, Mark read, Dismiss, and More. | Bulk select needs no extra column on a narrow screen. The Owner sees the selection mode at once. |
| A floating New button at the bottom right. | The thumb reaches it. It replaces the New message button of the page intro. |
| The thread opens full screen with Back, and the actions are icons in the top bar: mark unread, dismiss, and More. | The report text gets the full width and height. |
| The newest message is expanded. Older messages in the thread show as one line each. | A long conversation starts at the part that needs the Owner. |
| An Undo snackbar after Dismiss and Mark read. | One tap is enough, because Undo recovers a mistake. It replaces `confirm()` for these two actions. |

### Gmail web for the desktop Mailbox

| Behavior copied | Reason |
|---|---|
| A folder rail at the left with the Compose button at the top and a count for each folder. | The folders are always visible, and switching takes one click. |
| A one-line row: check box, avatar, sender, subject and preview, and time. The row is 40 px high. | About 15 rows fit in 800 px. The Owner sees the whole Needs you folder at once. |
| A list toolbar with Select all, Mark read, Dismiss, and the range (`1–6 of 9`). | Bulk actions sit in one known place. |
| The reading pane opens at the right of the list, and the list keeps the selection (the vertical split mode). | The Owner works down Needs you without Back after each item. |
| Keyboard keys: `j` and `k` move, `o` or Enter opens, `x` selects, `e` dismisses, `r` replies, `u` goes back to the list, and `Shift+i` marks read. | The desktop Owner works fast with the keys that Gmail users know. |

### Messenger for the Chat shell and bubbles

| Behavior copied | Reason |
|---|---|
| The phone chat is the whole screen: a top bar with Back, the avatar, the name, and a status line. No other page chrome shows. | The Owner request names this. The messages get all the height. |
| A run of messages from one sender forms a group. The inner corners are tight (5 px). The outer corners and the last corner are round (18 px). One avatar shows at the bottom of an agent group. | The eye reads a group as one turn. The page needs less avatar noise and less space. |
| The chat list row: a 52 px avatar with a presence dot, the name, the last message, the time, and an unread badge. An unread row is bold. | This is the dense chat list the Owner asks for. The presence dot shows whether the orchestrator works now. |
| The Send button is dimmed until the field holds text. | It shows that an empty message cannot be sent. |
| The desktop has two panes: the list at the left and the open chat at the right. The most recent chat opens by default. | No empty area shows on the desktop. |

### WhatsApp for the thread details

| Behavior copied | Reason |
|---|---|
| A sticky day chip (`Yesterday`, `Today`, `Mon 28 Sep`) at the top of each day. | The Owner reads across night reports and needs the day. The time on each bubble can then show only `07:41`. |
| The time and the state marks sit inside the bubble at the bottom right. | The bubble needs no separate meta line, so each bubble is one line shorter. |
| A bar that reads `2 unread messages` above the first unread message when the chat opens. | The Owner finds the place to start reading. |
| A round button that jumps to the newest message, with a count of new messages. It shows only when the Owner scrolled up. | A new message never moves the reading position. The button replaces the `N new messages` pill. |

### Signal for the delivery state and the keyboard

| Behavior copied | Reason |
|---|---|
| State marks on Owner bubbles: a clock for `queued`, one check for `sent` (delivered to the pane), two checks for `relayed` (by the Boss), and two accent checks for `replied`. A failed send shows a red alert mark and Retry. | The four existing delivery states fit in four small marks. The long `delivered 07:44` text goes away. |
| The composer stays at the bottom of the visual viewport. When the keyboard opens, the list keeps the newest message in view. | The Owner sees the last message while typing. |
| On a phone, Enter makes a new line and the Send button sends. On a desktop, Enter sends and Shift+Enter makes a new line. | A phone keyboard has no Shift+Enter habit. The desktop keeps the existing rule. |

### Not copied

- Reactions, typing indicators, voice notes, and stories. The agents cannot use them.
- Gmail labels and categories. The four folders are the fixed set.
- Swipe to archive. A swipe conflicts with the browser Back gesture on iOS. The avatar tap and the action bar do the same work.

## Design

### The app view on the phone

On `/mailbox` and `/chat`, at 760 px and less, the body gets the class `app-view`. In this mode:

- The global header `.top` and the `main` padding do not show.
- The page is one column of fixed height: `height: var(--app-h, 100dvh)`. The script sets `--app-h` from `visualViewport.height`, and sets it again on each `visualViewport` `resize` and `scroll` event. The page itself does not scroll. Only the list or the thread scrolls.
- The top bar is 52 px high plus `env(safe-area-inset-top)`. The bottom bar or the composer adds `env(safe-area-inset-bottom)`. The side paddings use `max(<padding>, env(safe-area-inset-left|right))`.
- The viewport meta gets `interactive-widget=resizes-content`. Chrome on Android then resizes the layout viewport when the keyboard opens. iOS Safari uses the `--app-h` path.
- The menu button in the list bar opens a drawer. The drawer holds the folders (Mailbox only) and the links to all pages. A dot on the menu button shows unread items in the other page (Chat or Mailbox). The top-bar icons for chat, updates, and needs you move into the drawer as counts.

The Night banner (`nightBanner`) shows as a 28 px strip under the top bar in the app view. It must stay visible, because it tells the Owner that the night watch runs.

### Mailbox

**Folders.** The folders are Needs you, Inbox, Reports and updates, and Done. Sent stays below a divider, because a new message goes there and the Owner needs its delivery state.

- Needs you: open items with the action answer, approve, or decide. This is the existing `needsYou`.
- Inbox: all open mail items, newest first. The list shows two sections: Needs you first, then Reports and updates. This follows the Gmail "Important first" inbox type.
- Reports and updates: the existing `updates`. Only the label changes. The key stays `updates`, so old links keep working.
- Done: the existing `done`.

The default folder rule stays: Needs you when it has items, else the stored folder.

**Rows.** One row for each conversation (`conversationId`). The row shows the newest item of the conversation in the folder, and the count when the conversation has more than one item.

- Phone: two lines, 68 px. Line 1: sender, count, and time. Line 2: an action tag (Approve, Decide, Answer, Report), the subject, and the preview after a dash. An accent dot at the right marks an unread row. The time of an unread row is accent and bold.
- Desktop: one line, 40 px. Check box, 28 px avatar, sender (140 to 200 px), tag, subject, preview, time, and dot.

**Thread view.** On the phone, the thread replaces the list. The top bar has Back, mark unread, dismiss, and More. The subject shows as a 19 px heading at the top of the scroll area. Each message shows the avatar, the sender, `to you · report` or `to you · asks for approval`, and the time. Older messages collapse to one line. The body renders Markdown with the full width. A report whose first heading equals the title drops that heading.

**Action bar.** The action bar stays at the bottom of the thread. Its content depends on the open item:

| Item | Action bar |
|---|---|
| approve | Approve (primary), Decline, Reply, and a Dismiss icon |
| decide with choices | One button for each choice (the bar scrolls sideways), Reply, and a Dismiss icon |
| answer | Answer (primary), and a Dismiss icon |
| read, report, or update | Reply (primary), Mark done, and a Dismiss icon |
| closed | The answer line: `Approved 07:44 · delivered`. No buttons. |

Reply and Answer open the composer in place of the action bar. The composer is the same pill field and Send button as the Chat. It sits above the keyboard. Approve, Decline, and a choice send at once and show an Undo snackbar for 5 seconds. The request goes to the server when the 5 seconds end. `Mark done` calls the existing dismiss endpoint. The action bar shows it as Mark done for a read item, because a dismissed update moves to Done.

**Bulk select.** On the phone, a tap on an avatar or a long press on a row starts the selection mode. On the desktop, the check box column and `x` do the same. The selection bar has Mark read, Dismiss, and More. Dismiss applies only to open items. The bar shows `Dismiss 2 of 3` when the selection holds items that cannot be dismissed. Select all selects the rows of the current folder.

**Desktop.** The global header stays. The page fills the rest of the window: `height: calc(100dvh - <header height>)`. The rail is 240 px, and the list is 420 px when a thread is open. When no thread is open, the list takes the full width, as in Gmail. No card frames show. 1 px lines divide the panes.

### Chat

**List.** The phone list bar has the menu button, the title Chats, and New message. Each row is 72 px: a 52 px avatar with a presence dot, the name, the last message, the time, and a badge. The badge is filled for unread messages. It is an accent ring when the newest unread message asks for an action. A last message from the Owner starts with its delivery mark.

The presence dot and the status line come from the state: `state.control.projects[slug].orch.status` for a project, and the `boss` pane status for the Boss. Green means `working`. Gray means `idle` or `done`. No dot shows when the pane is missing.

**Thread.** The top bar has Back (phone only), the 32 px avatar, the name, the status line (`Working · pane boss`), and an Open in Mailbox icon. The log fills the rest. It holds:

- Day chips, sticky at the top of the log.
- Groups: consecutive messages from one sender with less than 5 minutes between them.
- Bubbles with Markdown text. Short Markdown (a paragraph, a list, inline code) renders inside the bubble. A table or a code block wider than the bubble scrolls sideways in its own box.
- Action bubbles: the question text, then the option buttons (Approve, Reject, Later, or the choices). This keeps the existing `chatActionCard` behavior.
- Report chips: a one-line card with a document icon, the title, and `Report · open in Mailbox`.
- The unread bar, at the first unread message when the chat opens. It stays until the Owner leaves the chat.
- The jump button, when the Owner scrolled more than one screen up.

The composer is a pill field that grows to 6 lines, and a round Send button. The hint `Enter sends` shows only on the desktop, below the field, in 11 px.

**Desktop.** The global header stays. Two panes fill the rest of the window: the list at 340 px and the thread. Without `?thread=`, the most recent chat opens. Bubbles are at most `min(68%, 620px)` wide.

### Visual rules

- The existing tokens stay: `--bg`, `--panel`, `--panel-2`, `--line`, `--text`, `--muted`, `--accent`, and the dark set. No new color is added. The Owner bubble uses `color-mix(in srgb, var(--accent) 14%, var(--panel))`, as now.
- Icons are inline SVG with one stroke width (1.8) at 22 px. No emoji and no Unicode glyphs stand in for icons.
- Times and counts use `var(--mono)` with tabular numbers.
- Tap targets are at least 40 px, and 44 px in bars.
- `::selection`, the caret, the focus ring, and the scroll bar take the accent and line colors.
- Replace the 3 px colored left borders on `.mail-answer` and `.chat-report` with the report chip and a plain answer line. A colored side stripe is a banned pattern in the design rules.
- Motion: the thread slides in from the right on the phone (200 ms, ease-out) and back out on Back. The jump button fades. `prefers-reduced-motion` turns both off.

## Bug A: the jump to the top on each refresh

### Cause

`render()` rebuilds the whole page string and assigns it to `$app.innerHTML`. `refreshExtras()` runs every 30 seconds and clears `lastRender` first, so the page is always replaced. A replaced scroll container starts at the top. A replaced text area loses its caret. The Chat restores its message scroll after the replacement, but not its list scroll.

### Design

1. **Mounted views.** The Mailbox and the Chat build their shell once: the bars, the scroll containers, and the composer. A later `render()` does not assign `$app.innerHTML` on these routes. It calls `mailboxUpdate(state)` or `chatUpdate(state)`. These functions patch the regions. The shell is built again only when the route changes, the folder changes, or the open thread changes.
2. **Keyed rows.** Each list row and each bubble has `data-key`: the conversation ID for a Mailbox row, the thread for a Chat row, and the message ID for a bubble. A new module `public/keyed-list.js` exports two functions:
   - `planKeyedPatch(oldKeys, newItems)` is pure. It returns the keys to remove, the keys to insert with their position, the keys to move, and the keys whose HTML changed. The tests import it.
   - `applyKeyedPatch(container, items, { key, html })` uses the plan on the DOM. A row whose HTML did not change keeps its node. A changed row gets a new node in the same place. A moved row moves with `insertBefore`.
3. **Scroll anchor.** Before a patch, the function records the first visible row key and its offset from the top of the scroll container. After the patch, it sets `scrollTop` so that the same row has the same offset. iOS Safari has no `overflow-anchor`, so the page does this itself. The Chat log keeps the bottom when the Owner is at the bottom.
4. **Pause.** A patch that removes or moves rows waits while the Owner acts. The page records the time of the last `input`, `scroll`, `touchstart`, `pointerdown`, and `keydown` event in the pane. A pure function `shouldDefer({ lastInputAt, lastScrollAt, pointerDown, selectionActive, now })` returns true for 1500 ms after input or scroll, while a pointer is down, and while the Owner has text selected. The page then applies the queued state once, at the first quiet moment. A patch that only changes the text of a row, or appends a bubble at the end, runs at once, because it does not move the reading position.
5. **State outside the DOM.** The open thread is in the URL (`?thread=` and `?conversation=`), so a reload keeps it. The selection stays in `mailSelected`. The drafts stay in `mailDrafts`, `mailbox.replyDraft`, and `chat.draft`. They are also saved in `sessionStorage` behind `try`/`catch`, so a reload keeps the typed text.
6. **Fewer refreshes.** `refreshExtras()` stops clearing `lastRender` on these two routes. It calls `loadMailbox()` only when the mailbox counts changed. The `setInterval(render, 10000)` updates only the `updated` text on these routes.

## Bug B: safe Markdown in the Mailbox and the Chat

### Renderer

A new module `public/markdown.js` exports `renderMarkdown(source, { headingOffset })`. It has no dependencies and no DOM use, so the Node tests import it directly. `app.js` imports it. It replaces `markdownHtml()`.

Block syntax:

- ATX headings `#` to `######`. They render as `h3` to `h6` inside a message (a heading offset of 2), with the sizes from the mockup.
- Paragraphs. A single line break inside a paragraph is a space. Two spaces or `\` at the end of a line is a hard break.
- Unordered lists (`-`, `*`, `+`) and ordered lists (`1.`, `1)`, with the start number). A list nests when a line is indented by 2 or more spaces more than its parent marker. A lazy continuation line joins the item.
- Task list items `- [ ]` and `- [x]`. They render as disabled check boxes with an `aria-label`.
- GFM tables: a header row, a delimiter row with the `:---`, `:---:`, and `---:` alignment, and body rows. A `\|` is a literal pipe. The table sits in `<div class="md-table" role="region" tabindex="0" aria-label="Table">`, which scrolls sideways.
- Fenced code blocks with ``` or ~~~, with an optional language word. The language word becomes `class="language-<word>"` after a `[a-z0-9-]` check.
- Block quotes with `>`. They can nest and can hold lists.
- Thematic breaks: `---`, `***`, or `___` alone on a line.

Inline syntax:

- Code spans with one or more backticks. The content is not parsed further.
- `**bold**`, `__bold__`, `*italic*`, `_italic_`, and `~~strike~~`. An underscore inside a word is text (`snake_case`).
- Links `[text](url)` and `[text](url "title")`, autolinks `<https://…>`, and bare `https://` URLs.
- Backslash escapes for the ASCII punctuation characters.

### Safety

The renderer builds HTML only from its own tokens. Each text piece passes through one `esc()` function that replaces `&`, `<`, `>`, `"`, and `'`. The renderer never passes source text through as HTML.

- Raw HTML in the source shows as text. `<b>x</b>` shows the six characters.
- A link URL must start with `http:`, `https:`, `mailto:`, `/`, or `#`, after the renderer removes control characters and decodes entities. Any other URL, for example `javascript:`, `data:`, `vbscript:`, or `JaVaScRiPt&colon;`, renders the link text without a link.
- An external link gets `target="_blank" rel="noopener noreferrer"` and a small external-link icon. A link to `/` stays in the page.
- The renderer writes only these elements: `p br strong em del code pre h3 h4 h5 h6 ul ol li input blockquote hr table thead tbody tr th td div a span svg use`. It writes only these attributes: `href target rel title class role tabindex aria-label type disabled checked start style` (`style` only as `text-align` on table cells).
- Defense in depth: in the browser, `sanitizeRendered(fragment)` walks the parsed fragment once and removes any element or attribute that is not on the list. A test proves that the renderer output already passes, so the walk removes nothing on valid input.
- Limits: at most 200 KB of input and a nesting depth of 8. Deeper content renders as text. The parser runs in linear time on the tests with 10,000 nested brackets and 10,000 asterisks.

### Test fixture

The Owner test file `~/.herdr-boss/scratch/boss/night-report-2026-09-29.md` holds client project names and must not enter this public repository. Task T1 adds `test/fixtures/night-report.md`. That file has the same structure: an `h1`, `h2` sections, bold lead words, inline code, a nested ordered list with a bullet list inside, two tables with a numeric column, an en dash, and a path in code. It uses the names Atlas, Harbor, Ledger, and HerdrBoss. The Owner file is used only for a manual check in the dashboard preview.

## Build tasks

Each task is one worker branch. The worker writes the regression test first, runs it on the current code, and records the failure. Each worker runs only the changed test files with `node --test --test-concurrency=2 <files>`. The orchestrator runs the full suite at integration.

Order: T0, then T1 and T2 in parallel, then T3, T4, and T5, then T6 and T7. T1 and T2 fix the two bugs, so they go live first.

### T0: preview seed data

- Files: `test/fixtures/m1-seed.js` (new), `docs/cli.md` (one line).
- Work: a script that writes about 60 messages into `$HERDR_BOSS_DIR`: 4 threads, all actions, closed and open items, reports with the fixture Markdown, Owner messages in each delivery state, two days of timestamps, and 40 items in one folder, so the lists scroll. The script refuses to run when `HERDR_BOSS_DIR` is not set or points at `~/.herdr-boss`.
- Tests: `test/m1-seed.test.js` runs the script in a temporary folder and checks the folder counts through `mailboxFolders()`. It also checks that the refusal works.
- Check: start the preview with the seed and open `/mailbox` and `/chat` once.

### T1: the Markdown renderer

- Files: `public/markdown.js` (new), `public/app.js` (`messageBody`, `chatBubble`, the import, and the removal of `markdownHtml`), `public/style.css` (`.md` rules from the mockup), `test/markdown.test.js` (new), `test/fixtures/night-report.md` (new).
- Tests: one test for each block and inline rule. The fixture renders to the expected HTML snapshot. A safety corpus of at least 30 cases: `javascript:` in all cases and with entities, `data:`, raw tags, `onerror=`, a quote in a URL, a quote in a title, nested brackets, an unclosed fence, an unclosed table, 10,000 nested `[`, and 10,000 `*`. The allowlist test parses the output with a small tag and attribute scanner and fails on any name that is not on the list.
- Regression first: the fixture test fails now, because `markdownHtml()` renders the table as text and flattens the nested list.
- Check: the preview at 390 px and desktop, light and dark, with the fixture report open in the Mailbox and a Markdown chat bubble. The table scrolls sideways at 390 px.

### T2: keyed updates and the kept position

- Files: `public/keyed-list.js` (new), `public/app.js` (`render`, `refreshExtras`, the Mailbox and Chat update paths), `test/keyed-list.test.js` (new), `test/server.test.js` (source assertions).
- Tests: `planKeyedPatch` for insert, remove, move, change, and no change. The scroll anchor math as a pure function: `anchorScrollTop({ before, after })`. `shouldDefer` for typing, scrolling, a pointer down, and a text selection. A source test that `render()` does not assign `$app.innerHTML` on `/mailbox` and `/chat` after the first mount. That test fails now.
- Check: at 390 px, scroll the seeded Mailbox list to the middle, open a thread, type text, and wait for two `state` events (about 30 seconds, through `herdr-boss wait` or a background wait). Take a screenshot before and after. The list position, the open thread, the text, and the caret must stay.

### T3: the phone app view and the Mailbox list

- Files: `public/index.html` (the viewport meta), `public/app.js` (`mailboxView`, `mailItem`, the drawer, the app view class, the `--app-h` handler), `public/style.css`, `src/messages.js` and `src/server.js` (the `inbox` folder), `test/mailbox.test.js`.
- Tests: `mailboxFolders()` returns `inbox` as the open items, newest first. `/api/mailbox?folder=inbox` answers 200. The folder label for `updates` is `Reports and updates`. The row grouping by `conversationId` as a pure function in `public/mail-rows.js` (new), tested for count and newest item. `resolveMailboxFolder` accepts `inbox`.
- Check: 390 px and 430 px, light and dark: the list, the drawer, and the empty folder. Desktop: the rail and the full-width list. No empty area shows below the list container at any size.

### T4: the Mailbox thread, the action bar, and bulk select

- Files: `public/app.js` (`mailConversationView`, `mailActions`, the selection mode, the snackbar, the desktop keys), `public/style.css`, `test/mailbox.test.js`.
- Tests: the action bar content for each action as a pure function `mailActionBar(item)`. The Undo queue as a pure function: a send waits 5 seconds and Undo cancels it. The bulk Dismiss count excludes closed items. The keys map to actions.
- Check: 390 px: the approve thread, the report thread, the composer with the keyboard (see [Keyboard check](#keyboard-check)), and the selection bar. Desktop: the split view, and the keys `j`, `k`, `x`, and `e`.

### T5: the Chat

- Files: `public/app.js` (`chatView`, `chatRow`, `chatConversationView`, `chatBubble`), `public/chat-log.js` (new, pure grouping), `public/style.css`, `test/chat-log.test.js` (new), `test/server.test.js` (source assertions that change with the markup).
- Tests: `groupLog(records, { now, gapMs, firstUnreadId })` returns day chips, groups, and the unread bar in the right places, across midnight and in the local time zone. The state mark for each delivery state. The presence from a project state and from the Boss pane.
- Check: 390 px and 430 px, light and dark: the list, the thread, the keyboard, the scrolled state with the jump button. Desktop: two panes, the default open chat.

### T6: the desktop layouts and the page help

- Files: `public/style.css`, `public/app.js` (`HELP.mailbox`, `HELP.chat`), `docs/user-guide.md` (the Mailbox and Chat page sections), `docs/cli.md` if a command changes.
- Tests: the source assertions for the help text.
- Check: 1280 × 800 and 1680 × 1050, light and dark, for both pages. The panes reach the bottom of the window.

### T7: the Impeccable critique and fixes

- Files: as the findings need.
- Work: run the Impeccable critique at 390 px and desktop, in light and dark, on the built pages. Fix the P0 and P1 findings. Record the P2 and P3 findings in the report.
- Check: the full screenshot matrix below, once.

## Checks

### Screenshot matrix

Use the preview with the T0 seed: `mkdir -p "$TMPDIR/herdr-boss" && node test/fixtures/m1-seed.js && HOME="$(mktemp -d)" HERDR_BOSS_DIR="$TMPDIR/herdr-boss" HERDR_BOSS_PORT=4478 npm start -- --read-only-preview`. Use an unused port if 4478 is busy.

| State | 390 × 844 | 430 × 932 | 1280 × 800 |
|---|---|---|---|
| Mailbox list, light | yes | yes | yes |
| Mailbox list, dark | yes | | yes |
| Mailbox thread with report, light and dark | yes | | yes |
| Mailbox approve with keyboard | yes | | |
| Mailbox selection bar | yes | | yes |
| Chat list, light and dark | yes | yes | |
| Chat thread, light and dark | yes | | yes |
| Chat thread with keyboard | yes | yes | |

For each state:

1. Run `herdr-boss browser request herdrboss`.
2. Run `herdr-boss browser tab new herdrboss http://127.0.0.1:<port>/<page>`.
3. Run `herdr-boss browser viewport herdrboss --tab <id> <width>x<height>`.
4. Run `herdr-boss browser screenshot herdrboss --tab <id>`.
5. Run `herdr-boss browser viewport herdrboss --tab <id> --reset` before `herdr-boss browser tab close herdrboss --tab <id>`.

The dark theme follows `prefers-color-scheme`. The preview page reads `?theme=dark` and sets `data-theme` for a check only. T3 adds this parameter.

### Keyboard check

A desktop browser cannot open a phone keyboard. The check uses the geometry that a keyboard makes:

1. Set the viewport to `390x553`. A keyboard of 291 px leaves this visual viewport on a 390 × 844 phone.
2. Click the composer, so that it has focus.
3. Take a screenshot. The composer must touch the bottom of the viewport. The top bar must show. The newest message must show above the composer.

A unit test covers `appHeight({ visualHeight, offsetTop, innerHeight })`. The real iOS Safari and Android Chrome keyboard behavior is Owner-tier evidence. The report of T5 must mark it unverified until the Owner checks it on a phone.

## Impeccable critique of the mockup

⚠️ DEGRADED: single-context. The worker brief forbids starting another agent, so Assessment A and Assessment B ran in one context, in that order.

Target: `docs/ideas/m1-mailbox-chat-mockup.html`. Evidence: 8 screenshots in the project browser (390 × 844, 430 × 932, and 1280 × 800, light and dark), and the detector.

**Detector:** `impeccable detect --json docs/ideas/m1-mailbox-chat-mockup.html` exit 0, no findings. The live overlay was not injected. The brief allows only the thin `herdr-boss browser` commands.

### Design health score

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 3 | Presence, delivery marks, and unread markers show. The refresh state (live or paused while typing) has no mark. |
| 2 | Match with the real world | 3 | Mail and chat conventions match. "Mark done" and "Dismiss" are two words for one server action. |
| 3 | User control and freedom | 3 | Back, Undo, and Escape exist. Undo covers only 5 seconds. |
| 4 | Consistency and standards | 3 | One composer, one icon set, and one avatar set in both pages. The phone and desktop Mailbox actions sit in different places. |
| 5 | Error prevention | 3 | Dismiss excludes closed items. An approve sends after one tap, and only Undo protects it. |
| 6 | Recognition rather than recall | 3 | Tags name the action on each row. The desktop keys need the help panel. |
| 7 | Flexibility and efficiency | 3 | Keys and bulk actions exist. No search. |
| 8 | Aesthetic and minimalist design | 3 | No frames, dense rows, one accent. The phone row cuts the subject short at 390 px. |
| 9 | Error recovery | 2 | Retry exists for a failed chat send. The mockup shows no failed state in the Mailbox. |
| 10 | Help and documentation | 2 | The page help moves into the drawer. The mockup does not show where Help is on the phone. |
| **Total** | | **28/40** | Good. |

### Design specificity

The design uses two strong product facts: the agent presence line (`Working · pane boss`) and the four delivery marks that map to the real queue states. The Needs you section at the top of Inbox matches the job of the Owner. The chat list and bubbles are close to a generic messenger. This is by request, because the Owner asked for a Messenger look.

### What works

- The phone Mailbox list starts 52 px from the top, and about 11 rows of 68 px fit on a 390 × 844 screen. The current page uses about 200 px for the intro and the folder grid before the first row.
- The report reads at full width. The table has its own sideways scroll box, and the page does not scroll sideways.
- The composer and the action bar stay at the bottom edge, so the thumb reaches every action.

### Priority issues

1. **[P1] The phone row cuts the subject short.** At 390 px the subject gets about 190 px after the tag, and the preview gets almost none. Fix: drop the preview on the phone when the subject passes 60% of the line, and move the tag after the sender on line 1. Command: `/impeccable layout`.
2. **[P1] An approve sends after one tap.** Undo is the only guard. On a phone a mistaken tap is common. Fix: keep the 5-second Undo, and show the snackbar with the item title. Make Decline a secondary button with a check step: the first tap turns it into "Tap again to decline". Command: `/impeccable harden`.
3. **[P2] Two words for one action.** "Mark done" and "Dismiss" both call dismiss. Fix: use "Done" for the action bar and the selection bar in all folders. Keep the API name. Update the page help. Command: `/impeccable clarify`.
4. **[P2] The paused refresh is not visible.** While the Owner types, list changes wait. A new Needs you item can wait for minutes while the Owner writes a long answer. Fix: show a small `1 new` chip in the list bar while an update waits. A tap applies it. Command: `/impeccable harden`.
5. **[P3] Help has no place on the phone.** Fix: add Help as the last drawer item. Command: `/impeccable onboard`.

### Persona red flags

- **The Owner on a phone at 07:30, one hand:** The drawer button is at the top left, out of thumb reach. The FAB and the action bar are in reach. This is acceptable, because folder changes are rare.
- **The Owner at the desk, many items:** No search, and no filter by project. With 40 open items, the Owner scrolls. Search is out of M1 scope. Record it as a follow-up.
- **A screen reader user:** The mockup rows are `li` elements with no button. The build must keep the existing `button` rows, the `aria-current` state, and the arrow key navigation of the chat list.

### Minor observations

- The day chip in dark theme has little contrast against the log. Use `--panel-2` with a 1 px `--line` ring.
- The desktop chat log is wide at 1680 px. Center the log at `max-width: 880px`.
- The drawer page links have no icons. This is by choice, because the product has no icon set for pages.

Questions skipped: the project rules forbid selection dialogs. The orchestrator decides.

## Open decisions for the orchestrator

1. **Undo in place of confirm.** This plan replaces `confirm()` with an Undo snackbar for approve, decline, choice, dismiss, and mark read. A send from the composer needs no confirmation. This changes the behavior the Owner knows. The critique finding 2 adds a second tap for Decline.
2. **Inbox on the server.** This plan adds `inbox` to `mailboxFolders()` and to the server folder check. The alternative is a client-only merge. The server path keeps one rule for the counts and the list.
3. **Markdown for Owner messages.** This plan renders Markdown in all bubbles, also in Owner bubbles. The Owner can paste lists.
4. **Search.** Out of M1 scope.

## Risks

- A keyed patch keeps old nodes. A handler bound to a replaced node can leak. Keep the delegated `document` handlers of the current code, and bind no handler to a row.
- The phone app view hides the global header. The Night banner, the live dot, and the top-bar counts must stay reachable through the bar and the drawer.
- The tests read `public/app.js` as text. Markup changes break existing source assertions in `test/server.test.js` and `test/mailbox.test.js`. Each task updates them in the same change.
- The real phone keyboard is not in the browser check. See [Keyboard check](#keyboard-check).
