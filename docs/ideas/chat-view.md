# Design: a chat view for Owner messages

**Status:** Design only. This document changes no code. The Owner described the idea on 2026-09-28.

## Purpose

The Mailbox is the action inbox for items that need an answer, an approval, or a decision. The Owner also wants a normal conversation view. A chat view shows the Owner messages and the agent replies in one thread per chat. The chat view is a second way to read and write the same records.

One chat exists for the Owner and the Boss. One chat exists for the Owner and each project orchestrator. Workers have no chat. The Owner reaches a worker through its orchestrator.

## Data

### What exists

The message store is `src/messages.js`. It writes one JSON record per line to `messages.jsonl`. A record holds `id`, `at`, `thread`, `from`, `to`, `kind`, `text`, `action`, `replyTo`, `status`, `sentAt`, `error`, `relayedAt`, `attempts`, `readAt`, `closedAt`, and `title`.

A thread is `boss` or a project slug. A chat maps to exactly one thread.

`replyTo` links records into a conversation. `groupMessagesByConversation` walks the `replyTo` chain inside one thread. The conversation ID is the root record ID. `/api/mailbox?thread=<thread>&conversation=<id>` returns one conversation.

Owner sends write `from: "owner"` with the kind `message`, `nudge`, or `status-request`. An Owner record has a delivery state: `queued`, `sent`, `failed`, or `relayed`. The store holds 200 records per thread and deletes older records after 30 days.

Agent records write `to: "owner"` with the kind `reply` or `report`. Those records are mailbox items. A mailbox item has `readAt`, `closedAt`, and an action: `answer`, `approve`, `decide`, or `read`.

### Gaps

The chat view needs four things that do not exist.

1. **A thread list.** No endpoint returns all chats with the last message. The client must fetch each thread with `/api/messages?thread=`.
2. **Per-chat unread counts.** `mailboxCounts` counts open mailbox items only. It does not count unread agent messages per thread. It does not count Owner messages.
3. **Older messages on demand.** `/api/messages?thread=` returns the last 200 records. It has no `before` cursor. The client cannot load an older page.
4. **A message event on the stream.** `/api/events` sends only `event: state`. The state holds mailbox counts, not messages. A new message does not reach an open page. The client must re-fetch the thread.

Read state exists for mailbox items only. An Owner bubble shows its delivery state. An agent bubble shows a read mark when the Owner opened it in the Mailbox.

## Views

### Phone chat list

```
┌─────────────────────────────────┐
│ Chats                     New + │
├─────────────────────────────────┤
│ Boss                      09:41 │
│ The release is ready.    (3) ●  │
├─────────────────────────────────┤
│ HerdrBoss                 09:12 │
│ Task V81 is done.               │
├─────────────────────────────────┤
│ Qlik                    Mon 18  │
│ Send the next task.      (1) ●  │
└─────────────────────────────────┘
```

### Phone chat

```
┌─────────────────────────────────┐
│ ‹  Boss                     ⋯   │
├─────────────────────────────────┤
│                                 │
│               ┌───────────────┐ │
│               │ Please finish │ │
│               │ V81.          │ │
│               │ Delivered 09:40│ │
│               └───────────────┘ │
│ ┌───────────────┐               │
│ │ V81 is done.  │               │
│ │ 09:41         │               │
│ └───────────────┘               │
│ ┌───────────────┐               │
│ │ Approve the   │               │
│ │ release?      │               │
│ │ [Approve]     │               │
│ │ [Decline]     │               │
│ └───────────────┘               │
├─────────────────────────────────┤
│ [ Message…                 ] Send│
│ Enter sends · Shift+Enter line  │
└─────────────────────────────────┘
```

### Desktop

```
┌──────────────┬────────────────────────────────────────┐
│ Chats        │ ‹ Boss                                 │
│ ──────────── │ ────────────────────────────────────── │
│ Boss      ●3 │         ┌────────────────────────────┐ │
│ HerdrBoss    │         │ Please finish V81.         │ │
│ Qlik         │         │ Delivered 09:40            │ │
│              │         └────────────────────────────┘ │
│              │ ┌────────────────────────────┐         │
│              │ │ V81 is done. 09:41 · read  │         │
│              │ └────────────────────────────┘         │
│              │ ┌────────────────────────────┐         │
│              │ │ Approve the release?       │         │
│              │ │ [Approve] [Decline]        │         │
│              │ └────────────────────────────┘         │
│              ├────────────────────────────────────────┤
│              │ [ Message…                       ] Send│
└──────────────┴────────────────────────────────────────┘
```

The file `chat-view-mockup.html` shows all three views in one static page. It uses the dashboard tokens by name. It holds no script.

## Behavior

### Sending

The composer is a text area. Enter sends the message. Shift+Enter inserts a new line. A send calls `POST /api/messages` with `{ thread, kind: "message", text }`. The page adds a local `queued` bubble. The response replaces it with the stored record. The composer keeps the focus. The page clears the draft after a success.

### Delivery

The engine delivers a queued Owner message on a tick. `deliverQueued` in `src/messages.js` finds the target pane. The Boss chat uses the pane labeled `boss`. A project chat uses the pane labeled `orch` in that project workspace. The engine sends the prompt when the pane is `idle`, `done`, or `working`. One pane takes one prompt per tick. On success the record becomes `sent` with `sentAt`. The bubble shows `Delivered HH:MM`.

### Failed delivery

A failed send sets `failed` with a short `error` and an `attempts` count. The engine retries on later ticks. It stops after 4 attempts. The bubble uses the critical color and shows the reason and the retry state. The Owner can resend the text as a new message.

### Scrollback

The conversation opens at the newest message. A scroll to the top loads older records. The client asks for records before the oldest loaded `at` value, then keeps the scroll position. The retention rule sets the floor.

### Inline action buttons

An agent reply with the action `answer`, `approve`, or `decide` is a mailbox item. The chat shows it as a bubble with its buttons. An answer shows a text field and Send. An approve shows Approve and Decline. A decide shows buttons for the `Choices` list, then an answer field. A send uses `POST /api/messages` with `replyTo` set to the item ID, and the server closes the item. The Mailbox and the chat then show the same state.

### Accessibility

The conversation is a list with `role="log"` and `aria-live="polite"`. The page announces a new message once. Each bubble shows the sender and the time in text. The composer has a label. Enter sends and Shift+Enter makes a new line. After a send the focus stays in the composer. The back control is a button with the label `Back to chats`. Each action button names its item.

### Themes

The view uses the CSS tokens from `public/style.css`: `--bg`, `--panel`, `--panel-2`, `--line`, `--text`, `--muted`, `--accent`, `--crit`, `--ok`. The Owner bubble uses `color-mix(in srgb, var(--accent) 12%, var(--panel))`. The agent bubble uses `var(--panel-2)`. The dark theme follows `prefers-color-scheme` and the `data-theme` attribute. Do not hard-code a color.

## Task split

| # | Task | Files | Size |
| --- | --- | --- | --- |
| 1 | Add a chat list with the last message and a per-thread unread count. | `src/messages.js`, `src/server.js`, `test/messages.test.js` | M |
| 2 | Add a `before` cursor and a `message` SSE event on send and delivery. | `src/messages.js`, `src/server.js`, `src/engine.js`, `test/server.test.js` | M |
| 3 | Add the Chat page, the list, the nav entry, and the route. | `public/app.js`, `public/style.css`, `public/index.html` | M |
| 4 | Add the conversation view: bubbles, the delivery state, and scrollback. | `public/app.js`, `public/style.css` | L |
| 5 | Add the composer with Enter, Shift+Enter, and a local queued bubble. | `public/app.js`, `public/style.css` | S |
| 6 | Add the inline mailbox action cards, with one write path. | `public/app.js`, `public/style.css` | M |
| 7 | Add the accessibility pass, the tests, and the page help. | `public/app.js`, `test/messages.test.js`, `docs/user-guide.md` | S |

Build in this order. Tasks 1 and 2 unblock the client work. Tasks 3 and 4 give a readable chat. Task 5 makes it writable. Task 6 adds the Owner actions.
