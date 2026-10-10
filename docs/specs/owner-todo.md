# Owner to-do list (OT1)

The Mailbox stores each Owner ask as a `todo` record. Use the existing message store. Do not create a second store. The To do view lists all open items, including Boss items. Sort by priority, then by the oldest creation time. The header badge counts open items.

## Record

Keep `id`, `kind`, `thread`, `from`, `to`, `text` and `at` for the message contract. Add `project`, `key`, `title`, `why`, `steps`, `expectedResult`, `howToAnswer`, `blocks`, `type`, `priority`, `poster`, `state`, `createdAt`, `updatedAt`, `postedAt`, `snoozedUntil`, `closedAt` and `ownerActions`. The poster holds the verified role, pane and workspace. `postedAt` holds the post times in the current rate window. Each saved Owner action holds its action, time, reason, decision and snooze time.

The file has one nonempty section for each heading: Title, Why, Steps, Expected result, How to answer, and What it blocks. A Type section is required. A Priority section is optional. The command options override priority and blocked work. The file cannot choose a project or a poster. A review pack can be a link in Steps.

## Types and states

Use five types: `decide` for Accept or Deny, `do` for steps, `check` for a checklist, `grant` for permission, and `read` for information. A grant item names what to grant. It never holds a credential value. Refuse secrets and hosts other than reserved example hosts. Use placeholders for private hosts.

Use five states: `open`, `done`, `blocked`, `snoozed` and `cancelled`. Done and an answer close an item. An answer is Accept, Deny, or a nonempty answer text. Accept and Deny apply only to a decide item. Blocked requires a reason. Snooze requires a future time. The item becomes open when that time passes. Not now requires a reason and cancels the item. Keep inactive items available in the To do view. The Owner can reopen a blocked or snoozed item. Keep unresolved items past the normal message retention limit. Keep terminal items for 30 days after closure.

## Posting rules

The Boss and an orchestrator can run `herdr-boss todo post FILE`. The service verifies the caller with the shared caller check. An orchestrator posts only for its workspace project. The Boss posts for `boss`.

The key combines the verified project with the title. Normalize case and spaces in the title. A duplicate updates the open item. Keep its id and creation time. Accept at most 10 posts per project per minute. Count duplicate updates too. Check the key and the rate limit in one message-store mutation.

## Slices

Slice (a) builds validation, direct posting, storage, count, sorting, the To do view and Owner actions. `todoOwnerActionRecorded` is the notice seam. It sends no notice in this slice. The dashboard uses the existing access and preview guards.

Slice (b) builds notice delivery to the poster, poster cancellation, replies with `say --reply-to`, and migration of existing asks. These paths are implemented. Slice (c) builds the daily digest, weekly summary, kit rules and agent checks. Browser checks at 1280 and 393 px, in dark and light themes, remain an orchestrator gate.

## Action notices

`todoOwnerActionRecorded(event)` queues the summary of a saved Owner action. Each saved action has an id and a notice id. The action and its default notice are saved in one store mutation. A replay uses the saved notice id. It does not send a second notice after notice retention. Each action advances `updatedAt`, even within the same millisecond. A repeated GUI request with the old version is refused.

Use the existing Owner message queue for delivery. A `todo-notice` record names the saved poster pane, workspace and role. Deliver only to that pane with those same values. Do not redirect it to a successor. Give only the title, action, reason, answer, and Snooze time. Mask secrets and private hosts. Do not quote the item body. Keep notices out of Chat.

A missing or unavailable pane leaves the notice pending. Retry delivery on a later tick when the pane can receive it. A failed prompt gets one retry. Pending notices survive message retention. Reopen sends no notice. Poster cancellation sends no Owner action notice.

## Cancellation and replies

`todo cancel KEY [--note TEXT]` uses the same caller check as posting. Permit only the verified poster project to cancel an open item. Save `closedBy: poster` and `cancelNote`. Show the state and note in the inactive list.

The Owner can answer in the GUI or through the existing `/api/messages` reply path. A reply whose parent is a To do item records an answer, closes the item, and queues its notice. Save the reply and action together. Reuse `clientId` to recognize a repeated reply. Refuse a new reply to a closed item. The CLI `say --reply-to ITEMID TEXT` uses this path from an Owner terminal outside an agent pane. Other `say` replies keep the shared caller check. Phone forms use the same action path for answers, Snooze, and Not now.

## Mailbox migration

The verified Boss runs `todo migrate`. Import open Mailbox items with action answer, approve, or decide that have no Owner reply. Use the project and normalized title key. Keep an existing To do item, including a terminal item. Keep the source creation time. Mask secrets and private hosts in imported text. Resolve the poster from saved metadata or the current project pane. An unknown pane leaves later notices pending.

Close each source item with `closedBy: todo` and its `todoId`. Keep the source kind unchanged. Print the number of new To do records. A repeat import creates none for the same keys. Do not read memory files. The Boss posts those asks later with `todo post`.
