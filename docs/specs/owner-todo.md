# Owner to-do list (OT1)

The Mailbox stores each Owner ask as a `todo` record. Use the existing message store. Do not create a second store. The To do view lists all open items, including Boss items. Sort by priority, then by the oldest creation time. The header badge counts open items.

## Record

Keep `id`, `kind`, `thread`, `from`, `to`, `text` and `at` for the message contract. Add `project`, `key`, `title`, `why`, `steps`, `expectedResult`, `howToAnswer`, `blocks`, `type`, `priority`, `poster`, `state`, `createdAt`, `updatedAt`, `postedAt`, `snoozedUntil`, `closedAt` and `ownerActions`. The poster holds the verified role, pane and workspace. `postedAt` holds the post times in the current rate window. Each saved Owner action holds its action, time, reason, decision and snooze time.

The file has one nonempty section for each heading: Title, Why, Steps, Expected result, How to answer, and What it blocks. A Type section is required. A Priority section is optional. The command options override priority and blocked work. The file cannot choose a project or a poster. A review pack can be a link in Steps.

## Types and states

Use five types: `decide` for Accept or Deny, `do` for steps, `check` for a checklist, `grant` for permission, and `read` for information. A grant item names what to grant. It never holds a credential value. Refuse secrets and hosts other than reserved example hosts. Use placeholders for private hosts.

Use five states: `open`, `done`, `blocked`, `snoozed` and `cancelled`. Done and an answer close an item. Blocked requires a reason. Snooze requires a future time. The item becomes open when that time passes. Not now requires a reason and cancels the item. Keep inactive items available in the To do view. The Owner can reopen a blocked or snoozed item. Keep unresolved items past the normal message retention limit. Keep terminal items for 30 days after closure.

## Posting rules

The Boss and an orchestrator can run `herdr-boss todo post FILE`. The service verifies the caller with the shared caller check. An orchestrator posts only for its workspace project. The Boss posts for `boss`.

The key combines the verified project with the title. Normalize case and spaces in the title. A duplicate updates the open item. Keep its id and creation time. Accept at most 10 posts per project per minute. Count duplicate updates too. Check the key and the rate limit in one message-store mutation.

## Slices

Slice (a) builds validation, direct posting, storage, count, sorting, the To do view and Owner actions. `todoOwnerActionRecorded` is the notice seam. It sends no notice in this slice. The dashboard uses the existing access and preview guards.

Slice (b) builds notice delivery to the poster, poster cancellation, replies with `say --reply-to`, and migration of existing asks. Slice (c) builds the daily digest, weekly summary, kit rules and agent checks. Browser checks at 1280 and 393 px, in dark and light themes, remain an orchestrator gate for slice (a).
