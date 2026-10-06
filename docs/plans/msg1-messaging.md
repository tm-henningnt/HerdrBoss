# MSG1: the messaging map and the rules

Status: design only. This note holds no product code. The slices MSG2, MSG3, and MSG4 start after the Owner accepts the rules in section 3.

Scope: the message paths of Herdr Boss, the dashboard surfaces (Chat, Mailbox, the Messages panel), the CLI texts, the live update, and the menu.

## Terms

Each term has one meaning in this note.

- **Thread**: the storage thread. A thread is `boss` or a project slug. Source: `validThread` (`src/messages.js:35`).
- **Conversation**: a thread plus a chain of `replyTo` links. Source: `groupMessagesByConversation` (`src/messages.js:233`).
- **Kind**: the value of the stored `kind` field of a record, for example `message`, `reply`, `report`, or `review`.
- **Channel**: where a record shows. One of `chat`, `mail`, or `both`.
- **Mailbox item**: a record that the Mailbox shows. Source: `isMailboxItem` (`src/messages.js:122`).
- **Message panel**: the dialog "Messages · NAME" of the Agents page and a project page. Source: `messageDialog` and `openMessages` (`public/app.js:3252`, `public/app.js:3318`).
- **Pane**: one terminal pane of Herdr.

## 1. The message map

The message store holds one record for each stored path. Source of the record shape: `src/message-store.js:189` and `src/message-store.js:307`. The default fields are `id`, `at`, `thread`, `from`, `to`, `kind`, `text`, `action`, `replyTo`, `status`, `sentAt`, `error`, `relayedAt`, and `relayedBy`.

Every cell below is verified in the code, unless the cell says `unverified`.

| Path | Stored record | CLI answer text | Where it shows in the GUI | What a reply does | Verified |
| --- | --- | --- | --- | --- | --- |
| Owner message from a dashboard surface (Chat composer, Mailbox composer, Messages panel). | `thread` boss or slug; `from` owner; `to` boss or orchid slug; `kind` `message`; `action` null; `replyTo` null; `status` queued. Source: `validateOwnerSend` (`src/messages.js:57`), route `POST /api/messages` (`src/server.js:1125`). | None. | Chat bubble (`chatRecords`, `src/messages.js:148`); Mailbox conversation pane (`loadMailboxConversation`, `public/app.js:3751`); Messages panel (`loadMessages`, `public/app.js:3293`). | A later Owner send with `replyTo` names this record. The channel stays chat. | yes |
| Owner nudge (`kind` `nudge`) and status request (`kind` `status-request`). | Same as the Owner message, with the fixed text of `NUDGES` or `STATUS_REQUEST_TEXT`. Source: `validateOwnerSend` (`src/messages.js:69`). | None. | Same three surfaces. | Same as the Owner message. | yes |
| Owner question to an agent in a terminal. | No record. The text goes to the pane as a Herdr prompt. | None. | The terminal only. | The agent answers in the terminal, or with `say`. | yes |
| Agent answer in chat: `herdr-boss say "TEXT"` from a boss or orch pane. | `thread` boss or slug; `from` boss or orch; `to` owner; `kind` `reply`; `action` null; `replyTo` null; `status` new. Source: `sayMessage` (`src/messages.js:627`). | `Message m-… is in the <thread> thread for the Owner.` (`src/cli.js:361`). | Chat bubble; Mailbox only when the action asks for the Owner; Messages panel. | An Owner send with `replyTo` answers it. It stays in chat. | yes |
| `herdr-boss say --reply-to ID "TEXT"`. | As above, with `replyTo` set. Source: `sayMessage` (`src/messages.js:645`). | As above. | As above. | The record links to the parent. The channel follows the parent. | yes |
| `herdr-boss say --action decide\|approve\|answer "TEXT"`. | As above, with `action` set. Source: `sayMessage` (`src/messages.js:645`). | As above. | Chat bubble and Mailbox card: `messageChannel` returns `both` (`src/messages.js:129`). | The Owner send closes the item and shows the answer on it. | yes |
| `herdr-boss mail post FILE --action read` from the boss pane. | `thread` boss; `from` boss; `to` owner; `kind` `report`; `title`; `action` `read`; `status` new. Source: `postReport` (`src/messages.js:649`). | `Report m-… is in the boss thread for the Owner.` (`src/cli.js:380`). | Chat bubble; Mailbox folder "Reports and updates". Source: `mailboxView` (`src/messages.js:297`). | An Owner send answers it and marks it read. | yes |
| `herdr-boss mail post FILE --action decide\|approve\|answer`. | As above, with that action. | As above. | Chat bubble and Mailbox folder "Needs you". Source: `mailboxFolders` (`src/messages.js:328`). | An Owner send answers it and closes the item. | yes |
| `herdr-boss mail close ID… --note TEXT` from the boss pane. | The record keeps its `kind`. The call sets `closedAt`, `readAt`, `closedBy` boss, and `closeNote`. Source: `closeMailboxItems` (`src/messages.js:407`). | `Closed N Owner mailbox item(s) as answered through the Boss.` (`src/cli.js:372`). | The item moves to Mailbox "Done". | No reply. | yes |
| Mailbox mark read, dismiss, or keep open. | The record keeps its `kind`. The call sets `readAt`, `closedAt`, `dismissed`, or `closeSuggestionDismissedAt`. Source: `markMailboxRead` (`src/messages.js:437`), `dismissMailboxItems` (`src/messages.js:465`), `keepMailboxItemsOpen` (`src/messages.js:494`). | None. | Mailbox folders. Source: routes `POST /api/messages/read`, `/dismiss`, `/keep-open` (`src/server.js:1136`). | No reply. | yes |
| Orchestrator to Boss. | No record for a normal message. The text goes to the boss pane as a Herdr prompt. The `herdr-boss tell TARGET TEXT` path stores `kind` `agent` in a separate store. Source: `tellAgent` (`src/agent-messages.js:618`). | `Agent message m-… was delivered.` (`src/cli.js:352`). | The Agents tab of the Chat (`http://127.0.0.1:4477/chat?tab=agents`) and the Messages section of a project page. Source: `agentMessagesHtml` (`public/agent-chat.js:135`). | No reply through the store. | yes |
| Boss to Owner. | The `mail post` path (kind `report`) or the `say` path from the boss pane (kind `reply`). | As the two rows above. | As the two rows above. | As the two rows above. | yes |
| Review pack publish: `herdr-boss review publish SLUG FOLDER`. | `thread` slug; `from` orch or boss; `to` owner; `kind` `review`; `action` `decide`; `review` `{slug, pack, version}`; `title`; `status` new. Source: `postReview` (`src/messages.js:696`). | `Mailbox item m-… asks the Owner to decide.` (`src/review-cli.js:340`). | Chat card and Mailbox "Needs you". Source: `reviewOpenLinkHtml` (`public/review.js`). | The Owner submits the review. `closeSubmittedReview` closes the item and `postReviewResult` queues the result. | yes |
| Review submit delivery: `postReviewResult`. | `thread` slug; `from` owner; `to` orch; `kind` `review-result`; `replyTo` the review item; `status` queued. Source: `postReviewResult` (`src/messages.js:726`). | None. | No Mailbox item. `deliverQueued` sends it to the planner or orch pane as a prompt. Source: `deliverQueued` (`src/messages.js:558`). | No reply. | yes |
| Review item reopen answer: `postReviewAnswer`. | `thread` slug; `from` owner; `to` orch; `kind` `review-answer`; `status` queued. Source: `postReviewAnswer` (`src/messages.js:747`). | None. | No Mailbox item. Delivered as a prompt. | No reply. | yes |
| Goal notice after a failed `goal set`. | `thread` slug or boss; `from` boss; `to` owner; `kind` `reply`; `action` `answer`; `status` new. Source: `postGoalNotice` (`src/goal-notice.js:30`). | None. | Chat and Mailbox "Needs you". | The Owner answers or closes it. | yes |
| Kit updated notice. | No record. The engine formats the notice and sends a prompt to each orch pane and the boss pane. Source: `src/engine.js:3262` and `src/engine.js:3293`. | None. | No GUI surface. | No reply through the store. | yes |
| Resource notices (lock, lease, browser health, handover). | No record. The engine sends a prompt with `promptService`. Source: `src/engine.js:744`, `src/engine.js:1069`, `src/engine.js:1957`, `src/engine.js:2782`. | None. | No GUI surface. | No reply through the store. | yes |

Note: the Chat page shows a record with the `channel` mail or both as a bubble today. Source: `chatRecords` keeps every record that is not an agent record and not a mail answer (`src/messages.js:148`). The Chat bubble render is `chatBubble` (`public/app.js:4335`).

## 2. The inconsistencies

An independent reader of the code finds these problems. Each problem names the evidence.

1. **One word, two meanings.** The CLI prints "the `<thread>` thread" (`src/cli.js:361`, `src/cli.js:380`). The word "thread" then names the storage thread (`boss` or a slug) and a conversation at the same time. The Owner expects a Mailbox item in the Mailbox.
2. **The same record shows with two kinds.** A `reply` record with `--action decide` is a chat bubble on the Chat page and a Mailbox card on the Mailbox page. Source: `messageChannel` returns `both` (`src/messages.js:129`), `chatRecords` keeps it (`src/messages.js:148`), and `mailboxView` lists it (`src/messages.js:297`). A `report` also shows in the Chat. The Owner sees the record move between surfaces during one conversation.
3. **A reply does not keep the kind of the message it answers.** `sayMessage` always stores `kind: 'reply'` (`src/messages.js:645`). `validateOwnerSend` always stores `kind: 'message'` (`src/messages.js:83`). The channel is derived later, not stored. The answer to a Mailbox item is a `message`; the item is a `report` or `review`.
4. **Two sources for one count.** The top-bar Chat icon reads `state.mailbox.chatUnread` (`mailboxCounts`, `src/messages.js:216`). The Chat list row reads `unread` from `/api/chats`, which subtracts the mail unread of the thread (`src/server.js:596`). The two numbers can differ.
5. **The Mailbox list needs a reload or an action.** The Mailbox list updates on a `state` event only when the route is `/mailbox` and the counts string changed (`public/app.js:9278`). The open conversation does not refresh on a new message. The Messages panel polls every 10 s (`public/app.js:3326`). The Chat is live through the `message` event (`public/app.js:9281`).
6. **Two menus on a phone.** The header shows `#nav-menu` and `#primary-nav` (`public/index.html:23`, `public/index.html:30`, `public/style.css:751`). The Mailbox and Chat pages also render an app drawer with its own button (`appMenuButton`, `appDrawer`, `public/app.js:3586`, `public/app.js:3593`). The drawer page list is `[/, /board, /reviews, /agents, /projects, /browsers, /allocation, /analytics]` (`public/app.js:3594`). It has no Fleet, no Settings, and no Docs. The desktop header has them (`public/app.js:153`, `public/app.js:159`).
7. **The send state is not the same on the two surfaces.** The Chat shows an optimistic local bubble and a retry (`chat.pending`, `public/app.js:4533`). The Mailbox waits for `POST /api/messages` and then reloads (`mailSend`, `public/app.js:3850`). There is no optimistic Mailbox state and no sent, delivered, or failed badge on the bubble.
8. **The delivery state has two names.** The Mailbox shows `queued`, `delivered`, `failed`, and `relayed by the Boss` (`mailDeliveryState`, `public/app.js:3217`). The Chat bubble shows `queued` or a local pending state (`chatBubble`, `public/app.js:4335`). The agent-message view shows `recorded` or `failed` (`public/agent-chat.js:135`).

## 3. The rules

The Owner asked for five rules. Each rule below gives the rule, the exact code changes, the migration need, and the test.

### Rule (a): one conversation, one thread, one channel

**Rule.** A conversation has one thread and one channel. A reply stays in the thread and the channel of the message it answers. The channel rule: a terminal answer stays in the terminal, a chat message stays in chat, and the Mailbox takes only a delayed answer or a message that the Owner requests there.

**Code changes.**

- `src/messages.js`, new function `channelFor(record, byId)`: return `record.channel` when the field exists. Otherwise return the channel of the parent record when `replyTo` names a parent in the same thread. Otherwise derive the channel from `kind` and `action` with the current rule of `messageChannel` (`src/messages.js:129`).
- `src/messages.js`, `sayMessage` (`src/messages.js:627`): read the parent record when `replyTo` is set. Set `channel: parent ? channelFor(parent, byId) : 'chat'` on the new record. Keep `kind: 'reply'`.
- `src/messages.js`, `validateOwnerSend` (`src/messages.js:57`): set `channel: parent ? channelFor(parent, byId) : 'chat'` in `fields`. Keep `kind: 'message'`.
- `src/messages.js`, `postReport` (`src/messages.js:649`) and `postReview` (`src/messages.js:696`): set `channel: 'mail'`.
- `src/messages.js`, `messageChannel` (`src/messages.js:129`): return `record.channel` when it exists. Keep the current rule as the fallback, so old records read the same way.
- `src/messages.js`, `isMailRecord` (`src/messages.js:191`) and `mailboxCounts` (`src/messages.js:211`): read `messageChannel`, so one function decides the channel.
- `src/goal-notice.js:30`: set `channel: 'mail'` and `action: 'answer'`.

**Migration.** Stored records have no `channel` field. The fallback in `messageChannel` reads them with the current rule, so no rewrite is necessary. A rewrite is optional. If the project chooses a rewrite, copy the message store file first: `cp "$DATA_DIR/messages.jsonl" "$DATA_DIR/messages.jsonl.bak-$(date +%s)"`. For the SQLite backend, copy the SQLite file in the same way. The rewrite adds `channel` only. It never changes `kind`, `at`, or `id`.

**Test.** New `test/messaging-channel.test.js`. Post a `report` with `action: 'decide'`. Assert `messageChannel(item) === 'mail'`. Send an Owner answer with `replyTo` the item. Assert the answer has `channel: 'mail'` and `isMailAnswer(answer, byId) === true`. Send an Owner chat message with no `replyTo`. Assert `channel: 'chat'`.

### Rule (b): a message never changes kind after it is stored

**Rule.** The store writes `kind` and `channel` once. No later call changes either field.

**Code changes.**

- `src/message-store.js`, the JSON `update` (`src/message-store.js:189`) and the SQLite `update` (`src/message-store.js:307`): throw a `TypeError` when `patch.kind` or `patch.channel` differs from the stored value.
- `src/message-store.js`, `mutate`: after `fn(records)`, compare `kind` and `channel` of each record with the value before the call. Throw the same `TypeError` on a difference.
- `src/messages.js`, `updateMessage` (`src/messages.js:46`): document the rule in one line.

**Migration.** None. The change refuses a new write. It does not touch a stored record.

**Test.** New tests in `test/message-store.test.js`. Append a record. Call `update(id, { kind: 'other' })`. Assert the call throws and the stored kind is the same. Repeat for `channel`. Call `mutate` with a `kind` change. Assert the call throws.

### Rule (c): a request for a decision, an approval, or an answer is always a Mailbox item, and it also shows as a card in the thread

**Rule.** A record with the action `decide`, `approve`, or `answer` is always a Mailbox item. The same record shows as a card inside its thread. The Owner then sees one history in both places.

**Code changes.**

- `src/messages.js`, `isMailboxItem` (`src/messages.js:122`): keep the current kind list. Add the rule that a record with a needs-you action and `to: 'owner'` is a Mailbox item, also when the kind is `message` or `reply`.
- `src/messages.js`, new `needsYouChannel(record)`: return `'both'` for a record that `isMailboxItem` accepts and that has a needs-you action. `messageChannel` returns this value before the `kind` rule.
- `src/messages.js`, `chatRecords` (`src/messages.js:148`): keep the record in the thread list. The client render marks it as a card.
- `public/app.js`, `chatBubble` (`public/app.js:4335`): render a record with `channel` `mail` or `both` as a card. The card shows the action, the text, a link to `/mailbox?folder=needs-you&item=<id>`, and the answer when one exists. Reuse `reviewOpenLinkHtml` for a review card.
- `public/mail-bar.js`, `mailBarItem` (`public/mail-bar.js:10`): no change. The card in the thread uses the same item.

**Migration.** No field change. The Mailbox already lists these records (`mailboxView`, `src/messages.js:297`). The change adds the card to the Chat render only. No store rewrite.

**Test.** Extend `test/mail-answer.test.js`. Post a review item. Assert that `mailboxFolders(records).needsYou` holds it and that `chatRecords(records)` holds it. Extend the view test in `test/agent-chat-view.test.js` or `test/chat-focus.test.js`: assert the rendered HTML of the Chat holds a card with the item ID and the Mailbox link.

### Rule (d): a reply to a Mailbox item shows on the item and in the thread

**Rule.** An Owner answer to a Mailbox item shows on the Mailbox item. The same answer shows in the thread as an answer to the item card.

**Code changes.**

- `src/messages.js`, `withMailAnswers` (`src/messages.js:180`): keep the current behavior. Call it from the Chat page path, not only the Mailbox path. Source: the Chat path uses `chatThreadPage` (`src/messages.js:167`) without `withMailAnswers`.
- `src/server.js`, the `/api/chats/:thread` route (near `src/server.js:637`): wrap the page with `withMailAnswers(page, records)`.
- `public/app.js`, `chatBubble`: when the record has `answer`, show the answer under the card.
- `src/messages.js`, `mailboxView` (`src/messages.js:297`): keep the `answer` field.

**Migration.** None. The answer record already exists. This rule changes where the render reads it.

**Test.** Extend `test/mail-answer.test.js`. Post a review item. Send an Owner answer with `replyTo` the item. Assert that `withMailAnswers([item], records)[0].answer.text` holds the answer text, and that `mailboxView(records).needsYou[0].answer` holds the same text.

### Rule (e): the CLI output names the place

**Rule.** The CLI names the place of the new record. Examples: "posted as a Mailbox item (decide)" and "sent in chat".

**Code changes.**

- `src/messages.js`, new `placeText(record)`: return one of these strings:
  - `Posted as a Mailbox item (${action})` for a record with a needs-you action.
  - `Posted as a Mailbox item (read)` for a Mailbox information item.
  - `Sent in chat` for every other record.
- `src/cli.js`, the `say` branch (`src/cli.js:361`): print `Message m-… ${placeText(record)} in the ${record.thread} thread for the Owner.` → replace with the exact table in section 4.
- `src/cli.js`, the `mail post` branch (`src/cli.js:380`): same.
- `src/cli.js`, the `mail close` branch (`src/cli.js:372`): name the Mailbox.
- `src/cli.js`, the `messages relay` branch (`src/cli.js:306`): name chat.

**Migration.** None. This rule changes text only.

**Test.** New `test/messaging-cli-text.test.js`. Run each command with a temporary `HERDR_BOSS_DIR` and a fake Herdr runner. Assert the exact output line.

## 4. The CLI output texts

The table below gives the old text and the new text for each command that posts or replies. `<T>` is the thread. `<id>` is the record ID. `<action>` is the action of the record.

| Command | Old text | New text |
| --- | --- | --- |
| `say "TEXT"` (chat) | `Message <id> is in the <T> thread for the Owner.` | `Message <id> sent in chat on the <T> thread.` |
| `say --action <a> "TEXT"` | `Message <id> is in the <T> thread for the Owner.` | `Message <id> posted as a Mailbox item (<a>) on the <T> thread.` |
| `say --reply-to <p> "TEXT"` | `Message <id> is in the <T> thread for the Owner.` | `Message <id> answered <p> in the <T> thread.` |
| `mail post FILE --action read` | `Report <id> is in the boss thread for the Owner.` | `Report <id> posted as a Mailbox item (read) on the boss thread.` |
| `mail post FILE --action <a>` | `Report <id> is in the boss thread for the Owner.` | `Report <id> posted as a Mailbox item (<a>) on the boss thread.` |
| `mail close <id>… --note TEXT` | `Closed <N> Owner mailbox item(s) as answered through the Boss.` | `Closed <N> Mailbox item(s) as answered through the Boss.` |
| `messages relay <id>… --by boss` | `Relayed <N> queued Owner message(s).` | `Relayed <N> queued chat message(s).` |
| `review publish` | `Mailbox item <id> asks the Owner to decide.` | No change. This text already names the place. |
| `tell TARGET TEXT` | `Agent message <id> was delivered.` | No change. This text names the agent-message store. |

## 5. The slices

Each slice fits one worker. The file lists below keep MSG2 and MSG3 apart.

### MSG2: live updates

**Owned files.**

- `public/mail-live.js` (new): the one live-update client. It opens one `EventSource('/api/events')`, applies a `state` event and a `message` event, and exposes `subscribe(handler)`.
- `public/app.js`: replace the `connect` function (`public/app.js:9268`), the polling `setInterval(refreshExtras, 30000)` line (`public/app.js:9329`), and the Messages-panel poll (`public/app.js:3326`) with imports of `public/mail-live.js`. Keep the edits at these three sites only.
- `src/server.js`: extend `refreshMailbox` (`src/server.js:358`) so a `message` event also pushes the new record to the clients. Add one counter source to the `state` event.
- `src/messages.js`: one function `mailboxCounts` stays the only count source (`src/messages.js:211`).

**Design.** One mechanism: server-sent events. The service sends `state` and `message`. The client sends no poll for the Mailbox list, the open conversation, the Chat list, the badges, or the counts. One count source: `mailboxCounts`. The top bar, the page header, and each list read that number. A reconnect after sleep or a network change refreshes everything: on `EventSource` `open` after a close, the client runs one full read of `/api/state`, `/api/mailbox`, and `/api/chats`.

**Send state.** The client adds the record to the list with a local `pending` flag. The client then replaces the record with the server record and one of the states `sent`, `delivered`, or `failed`. `failed` shows the reason and a `Retry` button.

**Test.** New `test/messaging-live.test.js` for the server event. Extend `test/mailbox-refresh.test.js`: post a record from the CLI into a temporary store. Assert that the served `state` event carries the new count. Assert that the open conversation read returns the new record. The browser check of the 3-second rule is in MSG4.

### MSG3: one menu

**Owned files.**

- `public/menu.js` (new): the one navigation component. It holds the page list, the logo button, the open state, and the drawer.
- `public/index.html`: one menu host. Remove the second host.
- `public/style.css`: the menu rules at `public/style.css:751` to `public/style.css:755` and `public/style.css:1902` to `public/style.css:2054`.
- `public/app.js`: replace `appMenuButton` (`public/app.js:3586`), `appDrawer` (`public/app.js:3593`), and `setNavMenu` (`public/app.js:162`) with an import of `public/menu.js`. Keep the edits at these three sites only.

**Design.** One component for every page. The page list holds every section, including Fleet, Settings, and Docs. On a phone the menu button is the HerdrBoss logo with `aria-label="Menu"`, a tap target of at least 44 px, and an open state (`aria-expanded`). The hamburger glyph is the alternative. The recommendation is the logo. On a desktop the regular navigation stays.

**Test.** New `test/menu-single.test.js`. Render each page with the view functions and assert that the HTML holds exactly one menu host (`[data-app-drawer]` or `#primary-nav`, not both). Assert that the menu links hold Fleet, Settings, and Docs. The test fails when a page renders a second menu.

### MSG4: close-out

**Owned files.**

- `docs/user-guide.md`, `docs/cli.md`, and the `HELP` object in `public/app.js`.
- The browser check at 1280 by 800 and 393 by 852, light and dark, with captures.

**Test.** The independent judge pass on the two slices. The screenshots and the docs gate result go into the report.

### File ownership summary

| File | MSG1 | MSG2 | MSG3 | MSG4 |
| --- | --- | --- | --- | --- |
| `docs/plans/msg1-messaging.md` | owner | read | read | read |
| `public/mail-live.js` | — | owner | — | — |
| `public/menu.js` | — | — | owner | — |
| `public/app.js` | — | three sites | three sites | — |
| `src/server.js` | — | owner | — | — |
| `src/messages.js` | — | owner | — | — |
| `src/cli.js` | — | — | — | — (MSG1 rule (e) is a later slice) |
| `public/index.html`, `public/style.css` | — | — | owner | — |
| `docs/user-guide.md`, `docs/cli.md`, `HELP` | — | — | — | owner |

MSG2 and MSG3 share `public/app.js`. Each slice touches three named sites only. A merge conflict is possible at an import line. The orchestrator resolves it. To remove the conflict, MSG3 lands first and MSG2 rebases on it.

## 6. Migration and rollback

1. Before any rewrite of the message store, copy the store file. For the JSON backend the file is `messages.jsonl`. For the SQLite backend the file is the SQLite database. Source: `messagesFile` (`src/message-store.js:18`), `openSqliteStore` (`src/sqlite-store.js`).
2. The `channel` field is additive. The read path falls back to the current rule for a record without the field. Therefore the slices can land without a rewrite.
3. A rewrite is a separate, optional job. It writes a new file and renames it. It never changes `kind`, `at`, `id`, or `text`.
4. A rollback restores the copied file. The service then reads the old records with the same fallback.
5. The rule (b) guard refuses a new write. It does not repair an old record. No old record changed kind before this design, so no repair is necessary. This claim is `unverified`: see section 7.

## 7. Unverified facts

These facts are not verified in this design pass. MSG2 or MSG4 verifies each one.

1. The service pushes a `message` event for every append. Source: `messageStore.onChange` (`src/server.js:353`). The client applies it to the Chat only (`onChatMessage`, `public/app.js:4580`). The Mailbox path is unverified in a running browser.
2. The three-second live rule needs a browser check. No browser check ran in this design pass.
3. The set of stored records that ever changed `kind` after `at`. The `update` call can patch `kind` today. No production audit ran. The guard of rule (b) needs a pre-check on a copy of a real store before the release.
4. The phone layout of the one menu. The CSS move is designed only. MSG3 verifies it in the browser.
5. The `channel` field name. It is a proposal. The Owner pack asks for the decision.

## 8. Source list

- `src/messages.js`
- `src/message-store.js`
- `src/server.js`
- `src/cli.js`
- `src/agent-messages.js`
- `src/goal-notice.js`
- `src/review-cli.js`
- `src/review-api.js`
- `public/app.js`
- `public/mail-bar.js`
- `public/agent-chat.js`
- `public/index.html`
- `public/style.css`
- `docs/cli.md`
- `docs/user-guide.md`
