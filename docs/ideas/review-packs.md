# Design: hosted review packs

**Status:** Plan only. This document changes no code. The build follows the tasks in [Build tasks](#build-tasks).

**Mockup:** [review-packs-mockup.html](review-packs-mockup.html). Open the file through a local HTTP server. It has eight screens with the anchors `#f1` to `#f8`: the pack list, the section list, the item viewer with an image pair, the item viewer with text and a choice, the summary, an imported HTML page, the Mailbox item, and the desktop split view. At 760 px and less, the phone screens fill the width, one below the other. The desktop split view shows at 900 px and wider. The query parameter `theme=light|dark` sets the theme. All names and content are invented.

## Goal

A project sends the Owner a review pack: a set of visual and written evidence with one question for each item. The Owner reads the whole pack in the Herdr Boss site, answers each item, and submits one result. The result goes back to the project orchestrator as structured data and closes the decide item in the Mailbox.

The design is general. It has no field, word, or rule for one kind of product. A pack can review a web app, an API, a CLI, a document, a design, a data pipeline, a mobile app, or a marketing site. The examples in this document and in the mockup are a checkout flow redesign, an orders API reference, and a landing page redesign. The Impeccable surface class is Operate. The Owner completes a task: read, decide, write notes, and submit. Scan speed, native phone gestures, and no lost input come before expression.

## Fixed decisions

These decisions come from the Owner request through the Boss. This plan does not reopen them.

- The Owner reads the whole pack, with all images, pairs, galleries, and tables, inside the site. The Owner leaves the site only to operate a live product.
- The Owner can accept, deny, and write a note for each item, and write a note for the whole pack. The summary screen lists all decisions.
- The result goes to the orchestrator as a Mailbox message with a Markdown summary and a command that fetches the JSON result. The submit closes the decide item.
- The pack format has no product-specific fields. Items have a type from a small open set. A project can add a custom type through a renderer name. An unknown renderer shows the item as Markdown.
- The questions are generic: accept, deny, note, needs live check, and an optional rating or choice between alternatives. Section and pack states come from the item decisions.
- `herdr-boss review publish` takes any folder that has a valid manifest. `herdr-boss review import` takes any folder of HTML files or one HTML file.
- The kit gets a generic review pack section in the worker brief template and in the orchestrator skill.

## What exists now

| Area | Now | Use for review packs |
|---|---|---|
| Routes and auth | `src/server.js` handles each route in one `http.createServer` callback. `access.authorized()` (`src/access.js:69`) accepts loopback, a bearer token, or a session cookie. `allowedRequest()` (`src/server.js:117`) refuses a cross-site request, except a top-level document navigation. | Add the `/api/reviews` routes behind the same two checks. Add one raw file route with its own checks (see [Legacy HTML packs](#legacy-html-packs)). |
| Read-only preview | `src/server.js:232` refuses each `/api/` method other than `GET` and `HEAD`. | The new routes inherit the rule. The preview shows packs and refuses decisions. |
| Response headers | `send()` (`src/server.js:56`) sets `nosniff`, `X-Frame-Options: DENY`, `no-referrer`, and `no-store`. | Pack assets use `send()`. Only the raw route replaces `X-Frame-Options` with a `frame-ancestors 'self'` policy. |
| Binary upload checks | The avatar route reads at most 512 KB with `readBytes()` and decides the format from the magic bytes (`avatarFormat()`, `src/server.js:87`). SVG is refused. | Pack files use the same magic-byte rule and the same SVG refusal. |
| Messages | `src/messages.js`: `isMailboxItem()` accepts `reply` and `report` records to the Owner. `messageChannel()` puts a `report` in the Mailbox. `closeMailboxItem()` closes one item. `deliverQueued()` sends queued Owner records to the `orch` pane. | Add the record kind `review` (mail, action `decide`) and the Owner kind `review-result`. Reuse the delivery queue, the retry count, and the close. |
| Message store | `src/message-store.js` keeps records for 30 days. Each change rewrites `messages.jsonl`, or deletes and inserts all rows in SQLite (`replaceSqliteRecords()`). | Too costly for one write per tap, and the 30-day rule would cut an open pack. Store the decisions in new SQLite tables. See [Storage](#storage). |
| SQLite | `src/sqlite-store.js` opens `herdr-boss.db` with WAL, mode 0600, and numbered migrations. `serve()` requires `node:sqlite`. | Add migration 2 with the review tables. SQLite is always present, so no JSON fallback is necessary. |
| Secret scan | `scanText(file, text)` in `src/secret-scan.js` returns the secret classes of one text. `scanStaged()` treats a file over 2 MB or with a NUL byte as unscanned. | Run `scanText()` on each text file of a pack. Refuse a text file over 2 MB. |
| Secret refusal | `refuseSecret()` in `src/messages.js` refuses text that looks like a token, a key, or a password. | Run it on the pack title, the item titles, and the Owner notes before the result goes to a pane. |
| Markdown | `public/markdown.js` has no DOM use. `renderMarkdown()` escapes all source text and has no `img` tag. `safeUrl()` accepts `http`, `https`, `mailto`, and local paths. There is no server copy. | The client renders item text with `renderMarkdown()`. The server imports the same file to check the size limit (`MAX_INPUT`, 200 KB). Images are item fields, never inline Markdown. |
| Mailbox UI | `public/app.js` shows `decide` items in Needs you with choice buttons. `public/keyed.js` keeps DOM nodes across refreshes. The M1 design ([mailbox-chat-polish.md](mailbox-chat-polish.md)) gives the app view, the Gmail keys, and the Undo snackbar. | A `review` item shows **Open review** instead of the answer form. The reviewer pages use the same app view, keys, and keyed refresh. |

## References and the behaviors copied

| Reference | Behavior copied | Reason |
|---|---|---|
| GitHub pull request review | A **Viewed** check box on each file, and a count `12 / 31 viewed` at the top. | The Owner sees what is left. A viewed item folds in the section list. |
| GitHub pull request review | Inline comments collect as pending until the reviewer submits. The submit dialog has a summary note and a choice: **Approve**, **Request changes**, or **Comment**. | One result goes to the orchestrator, not one message for each note. The three verdicts map to the pack states. |
| GitHub pull request review | A re-push marks files that changed since the last review. | Versioning keeps the decision on an unchanged item and flags a changed item. |
| Figma comments | A note can pin to a point on an image. The pin is a numbered circle. A tap on a pin opens its note. | Visual feedback needs a place: "this button", "this row". The pin stores x and y as fractions of the image size. |
| Linear and Notion inline comments | A note attaches to a selected text range in a document. The range shows a light highlight. | Notes on a Markdown or table item point to a line, not only to the whole item. |
| Gmail keyboard flow | `j` and `k` move, `e` finishes the current row and moves to the next, `u` goes back to the list, and `?` shows the shortcut help. | The M1 Mailbox uses the same keys. The Owner learns one key set for the site. |
| Claude artifact review (the Owner's favorite) | Each block of the document has inline **Accept** and **Note** controls in the reading flow, not in a side form. A decision shows as a small state chip on the block. | The Owner decides while reading. There is no jump to a separate form. |
| iOS Photos | Swipe left and right between items, pinch to zoom, double tap to zoom to 2×, and swipe down to close the viewer. | Native gestures on the phone. No new gesture to learn. |

Not copied: GitHub suggested changes (the Owner does not edit files), Figma multi-user presence (one Owner), Linear issue creation from a comment (the orchestrator decides the follow-up), and Gmail swipe to archive (it conflicts with the item swipe).

## The pack format

A pack is a folder. The folder holds `manifest.json` and the files that it names. All paths in the manifest are relative to the folder.

```
checkout-redesign/
  manifest.json
  intro.md
  img/cart-light.png  img/cart-dark.png  img/pay-before.png  img/pay-after.png
  media/checkout.mp4
  data/errors.csv
  diff/validation.diff
```

### Manifest example

```json
{
  "schema": "herdr-boss.review-pack/1",
  "id": "checkout-redesign",
  "title": "Checkout flow redesign",
  "summary": "intro.md",
  "live": [{ "label": "Staging checkout", "url": "https://staging.example.test/checkout" }],
  "sections": [
    { "id": "cart", "title": "Cart", "summary": "The cart page in both themes.", "items": [
        { "id": "cart-themes", "title": "Cart, light and dark", "type": "image-pair", "variant": "theme",
          "a": { "src": "img/cart-light.png", "label": "Light" }, "b": { "src": "img/cart-dark.png", "label": "Dark" },
          "ask": ["accept", "deny", "note"] },
        { "id": "pay-button", "title": "Pay button position", "type": "image-pair", "variant": "before-after",
          "a": { "src": "img/pay-before.png", "label": "Before" }, "b": { "src": "img/pay-after.png", "label": "After" },
          "ask": ["choice", "note"], "choices": [{ "id": "a", "label": "Keep before" }, { "id": "b", "label": "Use after" }] },
        { "id": "flow-video", "title": "Full checkout, 40 s", "type": "video", "src": "media/checkout.mp4", "ask": ["accept", "deny", "live"] }
    ] },
    { "id": "errors", "title": "Error handling", "items": [
        { "id": "error-copy", "title": "Error messages", "type": "table", "src": "data/errors.csv", "ask": ["accept", "deny", "note"] },
        { "id": "validation", "title": "Card validation change", "type": "diff", "src": "diff/validation.diff", "ask": ["accept", "deny", "note"] },
        { "id": "a11y", "title": "Accessibility checks", "type": "checklist", "ask": ["accept", "note"],
          "entries": [{ "id": "focus", "text": "Focus order follows the form" }, { "id": "labels", "text": "Each field has a label" }] }
    ] }
  ]
}
```

### Item types

Each item has `id`, `title`, `type`, and `ask`. It can have `body`: Markdown text, or a path to a `.md` file. The body shows under the evidence.

| Type | Fields | Viewer |
|---|---|---|
| `image` | `src`, `alt` | One image with pinch zoom and pins. |
| `image-pair` | `variant` (`theme`, `before-after`, or `compare`), `a` and `b` with `src` and `label` | A segmented toggle between A and B. On a wide screen, a side-by-side view and a slider view. |
| `gallery` | `images`: 2 to 60 entries with `src`, `alt`, and `caption` | A strip of thumbnails. A tap opens one image in the zoom viewer. |
| `video` | `src` (MP4 or WebM), `poster` | The native `<video>` player with controls. No autoplay. |
| `markdown` | `text` or `body` | Safe Markdown with `renderMarkdown()`. Notes attach to a text range. |
| `table` | `src` (CSV) or `columns` and `rows` | A table with a sticky header. It scrolls sideways inside its box on the phone. |
| `diff` | `src` (unified diff) | Changed lines in the diff colors. Notes attach to a line. |
| `file` | `src`, `language` | A code or text file in the mono font with line numbers. |
| `link` | `url`, `label` | A card with the host name and **Open live**. The item is the way to reach a live product. |
| `checklist` | `entries` with `id` and `text` | Check boxes that the Owner ticks. The result lists the unticked entries. |
| `page` | `src` (HTML) | The sandboxed frame of [Legacy HTML packs](#legacy-html-packs). Only the importer writes this type. |

A project adds a custom type with `"type": "custom"` and `"renderer": "<name>"`. The name is a slug. Herdr Boss has no custom renderers in the first build. An unknown renderer, and an unknown type, show the item `body` as Markdown with the line "Herdr Boss has no viewer for NAME. It shows the text." The answer controls stay the same.

### Item review metadata

An item may use these fields in addition to its type fields:

| Field | Meaning |
|---|---|
| `description` | Two non-empty lines: what the item shows and why it matters. At most 2000 characters. |
| `steps` | A list of 1 to 30 exact actions. Each action has at most 500 characters. |
| `expected` | A non-empty result of at most 2000 characters. |
| `link` | An HTTPS URL to the app and sheet, or HTTP for a loopback or `.test` host. |
| `verifiedBy` | `agent-verified` or `needs-you`. |
| `evidence` | Up to 60 image file references used by image, image-pair, or gallery items. An agent-verified item needs at least one. |

A pack may have `session` and `round`. `session` is a planner session ID, a slug of at most 64 characters. `round` is a whole number from 1 to 9999 and needs `session`. The pack header in the viewer shows `Session <id> · round <n>`. See [Planner sessions](#planner-sessions).

A pack may have `designPass: { reviewer, result, note }`. The reviewer is non-empty and has at most 200 characters. The result is `passed`, `issues`, or `not-run`. The optional note has at most 2000 characters. The reviewer runs the pass before the pack ships and reports the result.

### Questions

`ask` lists the questions of the item. The default is `["accept", "deny", "note"]`.

| Value | Control | Result field |
|---|---|---|
| `accept` | **Accept** | `decision: "accept"` |
| `deny` | **Deny** | `decision: "deny"` |
| `note` | **Note**, a text field of at most 2000 characters. Pins and text ranges attach to a note. | `note`, `pins` |
| `live` | **Needs live check**, with the item `liveUrl` or the pack `live` links | `live: "pending"` or `"done"` |
| `choice` | One button for each entry in `choices` (2 to 6) | `choice: "<id>"` |
| `rating` | 1 to `rating.max` (3 to 10) stars | `rating: <n>` |

Each choice may have `recommended: true`. At most one choice of an item has it. The viewer shows the badge **Recommended** on that choice. The Owner can pick any choice.

Every item also has the built-in answer **Ask later**. It needs no entry in `ask`. It stores the decision `skip`. The item stays open and moves to the end of the pack. The section list shows the chip **Ask later**. The result lists the item as `open` with `skipped: true`. A decision, a choice, a rating, or a live check on the item removes the mark. A new version that changes the item removes it too.

An item is **answered** when it has a decision, a choice, or a rating, or when its `ask` holds only `note` and the note is not empty. A **Needs live check** item stays open until the Owner sets it to done or decides the item.

The section state comes from its items: **Denied** when one item is denied, **Needs live check** when one item waits for a live check, **Accepted** when all items are answered and none is denied, and **Open** otherwise. The pack state uses the same rule over all items. The submit screen proposes a verdict from the pack state: **Approve** for Accepted, **Request changes** for Denied, and **Comment** for the other states. The Owner can change the verdict.

### Validation rules

`src/review-pack.js` (new) validates a folder and returns all errors at once, as `writeProject()` does.

1. `manifest.json` exists, is at most 1 MB, and holds one JSON object. `schema` is `herdr-boss.review-pack/1`.
2. `id` matches `SLUG` from `src/projects.js`. Section and item IDs are slugs of at most 64 characters. Each item ID is unique in the pack and is not `summary`, because the summary route uses that name.
3. `title` is 1 to 200 characters (`TITLE_MAX`). Each text field passes `refuseSecret()`. When set, item guidance fields and `designPass` have the types and limits in [Item review metadata](#item-review-metadata).
4. The pack has 1 to 40 sections and 1 to 400 items. A section has at most 100 items.
5. `type` is a known type or `custom`. Each type has its required fields. `ask` holds only the six known values, each at most once. `choices` has 2 to 6 entries.
6. Each path is relative, has no `..` part, no leading `/`, no backslash, and no NUL. It resolves inside the folder after `fs.realpathSync()`. A symbolic link that points outside the folder is an error.
7. Each named file exists. Each file in the folder is named in the manifest, or the command warns and does not copy it.
8. A URL (`live`, `liveUrl`, an item `link`, or a `link` item URL) passes `safeUrl()` and uses `https`, or `http` for a loopback or `.test` host.
9. The limits in [Limits](#limits) hold.

## Publish

```sh
herdr-boss review publish <slug> <folder> [--note TEXT]
```

1. The command verifies the caller with `verifyMessageCaller()`: the pane label is `orch` or `boss`, or `planner` with an active planner session. The slug must be the project of the caller workspace, as for `say`. A worker does not publish. It builds the folder and names it in its report.
2. It validates the folder. On an error it prints each rule that failed and stops.
3. It scans each text file (`.md`, `.csv`, `.diff`, `.patch`, `.txt`, `.json`, `.html`, `.css`, and source files) with `scanText()`. A finding names the file and the class, never the value. A finding stops the publish. It refuses a file name that matches `ENV_FILE`.
4. It checks each image and video by its magic bytes. PNG, JPEG, WebP, GIF, MP4, and WebM pass. SVG, HTML outside a `page` item, and every other binary type are refused. It reads the image size from the header and refuses an image above 40 megapixels or above 16,384 px on one side.
5. It copies the files into the data directory, computes the content hashes, and writes the new version in one SQLite transaction. See [Versioning](#versioning).
6. It appends one Mailbox record and prints the review URL.

The Mailbox record uses the existing fields:

```json
{ "thread": "shop", "from": "orch", "to": "owner", "kind": "review", "action": "decide", "status": "new",
  "title": "Review: Checkout flow redesign (v2)", "text": "31 items in 4 sections. 5 items changed since v1.\n\n[Open review](/reviews/shop/checkout-redesign)",
  "review": { "slug": "shop", "pack": "checkout-redesign", "version": 2 } }
```

`isMailboxItem()` accepts the kind `review`. `messageChannel()` returns `mail` for it. A new version of an open pack closes the older Mailbox record with `closedBy: "review"` and appends a new one. The Owner sees one open item for each pack. A project can generate a pack with a small script, or ask an agent to write the folder. The format needs no build tool.

## Import of existing HTML packs

```sh
herdr-boss review import <slug> <folder-or-file.html> [--id ID] [--title TEXT]
```

The importer writes a manifest into a temporary folder, copies the files, and runs the publish steps. It makes one section for each HTML file, in the order of the links in `index.html`, then by name. Each section has one `page` item with the whole page. It also adds one `image` item for each `<img>` with a local `src`, with the `alt` text as the title. The Owner can then answer each image in the native viewer and read the page in the frame. The importer prints the external URLs that the pages use. The frame blocks them.

### Legacy HTML packs

A `page` item shows the HTML in an iframe. The page can hold scripts. The frame isolates them from the dashboard.

- The iframe has `sandbox="allow-scripts"`. It has no `allow-same-origin`, so the page runs in an opaque origin. It cannot read the dashboard cookie, the DOM of the parent, or local storage. It has no `allow-forms`, `allow-popups`, `allow-top-navigation`, `allow-modals`, or `allow-downloads`.
- The iframe has `referrerpolicy="no-referrer"`, `loading="lazy"`, and `allow=""` (no camera, microphone, or other feature).
- The server serves the page files only on `GET /review-raw/<token>/<path>`. The route runs before `allowedRequest()`, because a request from an opaque origin is cross-site and has no cookie. The route checks the host with the same host list, accepts only `GET` and `HEAD`, and accepts only a token that the dashboard got from `POST /api/reviews/:slug/:pack/raw-token`. The token is 32 random bytes, it names one pack version, and it expires after 30 minutes. The server keeps the tokens in memory only.
- Each raw response has this header:

```
Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline';
  style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self'; font-src 'self' data:;
  connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'
```

  The `sandbox` directive also applies when a user opens the raw URL in a tab. `connect-src 'none'` and `default-src 'none'` stop all network use outside the pack files. The raw route has no `X-Frame-Options: DENY`, and it keeps `nosniff`, `no-referrer`, and `no-store`.
- The server appends one script tag to each served HTML page: `<script src="/review-raw/<token>/__hb-bridge.js"></script>`. The bridge is a file in `public/`. It is the only way that the parent learns about the page.

### The frame protocol

All messages are JSON objects with `hb: 1` and a `type`. The parent accepts a message only when `event.source` is the frame window, the object has the known shape, and each string is at most 200 characters. The page scripts can send the same messages, so the parent treats each message as untrusted layout data. The parent sends nothing secret to the frame and uses the target origin `*`, because an opaque origin has no name.

| Direction | Type | Fields | Effect |
|---|---|---|---|
| frame → parent | `ready` | `title`, `height`, `anchors`: at most 500 of `{ id, kind: "heading" or "image", text, top }` | The parent builds the page outline and sets the frame height. |
| frame → parent | `pick` | `anchor` or `null`, `x`, `y` (fractions of the document), `text` (the selected text, at most 200 characters) | The parent opens a note with a pin at that point. |
| frame → parent | `scroll` | `top` (fraction) | The parent shows the pins that are in view. |
| frame → parent | `open` | `url` | A click on an external link. The parent checks it with `safeUrl()` and shows **Open live link** with the host name. |
| parent → frame | `pins` | `[{ n, x, y }]` | The bridge draws numbered pins over the page. |
| parent → frame | `goto` | `anchor` or `y` | The bridge scrolls to a note. |
| parent → frame | `place` | `on: true or false` | While `on` is true, the next tap sends `pick` and does not reach the page. |

What the frame cannot support:

- Pages that load data or fonts from the network, or that post a form. The CSP blocks them. The importer lists the URLs.
- Local storage, cookies, and IndexedDB. The opaque origin throws on access.
- Pop-ups, downloads, printing, and `alert()`.
- A per-block Accept in the page itself. Decisions attach to the whole page item and to the image items that the importer made. A note pins to a point or to an anchor.
- A stable pin after a layout change. A pin stores the anchor ID and the fraction. When the anchor is gone, the pin uses the fraction.

## The reviewer UI

The routes are `/reviews` (the pack list), `/reviews/<slug>/<pack>` (the section list), `/reviews/<slug>/<pack>/<item>` (the item viewer), and `/reviews/<slug>/<pack>/summary`. The pages use the phone app view of M1 at 760 px and less. The mockup shows each screen.

### Pack list

One row for each pack: the project avatar, the pack title, the version, the time, and a progress bar with the count `18 / 31`. The folders are **Open** and **Done**. The Mailbox item and the list open the same page. A Done pack shows its verdict chip.

### Section list

The top bar has Back, the pack title, and a menu with **Live links**, **Shortcuts**, and **Delete pack**. Under the bar, one progress bar shows the item states. The list has one block for each section with the section title, its state chip, and one row for each item. An item row holds a thumbnail or a type icon, the title, the **Viewed** check box, and a state chip. A viewed and answered item shows as one short line. A changed item shows **Changed**. A sticky bar at the bottom holds **Review summary** with the count of open items.

### Item viewer

The item fills the screen. The top bar holds Back, `7 / 31`, the section name, and the **Viewed** check box. The evidence takes the space between the top bar and the answer bar.

- **Images.** Pinch to zoom from 1× to 8×. Double tap zooms to 2× at the tap point, and again to fit. Pan inside the zoomed image. A first-time hint "Pinch to zoom · double tap for 2×" shows under the image for 3 seconds. On the desktop, the wheel with Ctrl zooms, and `z` toggles fit and 100 %.
- **Pairs.** A segmented toggle `Light | Dark` (or the two labels of the item) sits at the top of the image. The zoom and the pan stay the same on a toggle, so the Owner compares one spot. `t` toggles on the desktop. The desktop also has **Side by side** and **Slider**.
- **Swipe.** A horizontal swipe on an image at 1× moves to the next or the previous item. At a zoom above 1×, the swipe pans. A swipe down at 1× goes back to the section list.
- **Pins.** Tap **Note**, then tap the image. A numbered pin appears, and the note field opens with the pin number.
- **Answer bar.** A slim bar at the bottom above the safe area: **Deny**, **Note**, **Live**, and **Accept**, only for the questions in `ask`. Choice and rating controls show in the bar in place of Accept and Deny. After Accept or Deny, the viewer moves to the next open item after 400 ms, and an Undo snackbar shows for 5 seconds.

### Keyboard (desktop)

| Keys | Action |
|---|---|
| `j` / `k`, `J` / `K` | Next or previous item; next or previous section |
| `a`, `d`, `l`, `n` | Accept, Deny, Needs live check, open the note field |
| `1` to `6` | Choose an alternative or a rating |
| `e`, `v` | Mark viewed and go to the next item; toggle Viewed |
| `t`, `z` | Toggle the pair; toggle fit and 100 % |
| `s`, `u` or `Esc`, `?` | Open the summary; back to the section list; show the shortcut help |

The keys do nothing while focus is in a text field, except `Esc`, which leaves the field.

### Desktop split view

Above 1100 px, the page has three columns: the section list (280 px), the item viewer, and a note rail (320 px) with all notes of the pack in order. A click on a note selects its item and its pin. From 761 to 1100 px, the note rail folds into a drawer.

### Progress

A single stacked bar shows the item states in a fixed order: Accepted, Note only, Needs live check, Denied, and Open. The Accepted segment also counts a choice or a rating, because the Owner took an offered option. Each segment has a 2 px gap. The Denied segment has a hatch texture, so it differs from Needs live check without color. The legend under the bar names each state with its count. The segments use the incumbent status tokens `--ok`, `--info`, `--warn`, and `--crit`, and `--line` for Open. The dataviz palette validator gave these results for this order:

- Light: the CVD separation passes (worst 8.1). The Needs live check and Denied pair has a normal-vision distance of 14.5, under the floor of 15.
- Dark: the CVD separation and the normal-vision distance pass. The dark tokens are lighter than the validator band, and `--info` has a chroma under 0.1.
- Green beside red fails the CVD check (4.4). The order keeps them apart.

The hatch, the 2 px gap, and the labels carry the weak pairs. The build keeps the incumbent tokens and does not add new colors.

### Summary and submit

The summary screen shows the stacked bar, then one block for each state with the items and their notes. Open items show first, with **Review now**. The pack note field follows. The verdict choice has **Approve**, **Request changes**, and **Comment**, with the proposed verdict selected. **Submit review** asks no confirmation. It shows Undo for 10 seconds before the server sends the result to the pane. A submit with open items is allowed. The result lists them as open.

### Autosave and offline

- Each change sends `PUT` at once. The client does not wait for a save button. The field state shows **Saved**, **Saving**, or **Not saved: retrying**.
- A failed request goes into a queue in `localStorage` under one key for each pack. The queue keeps the last change of each field. It retries after 2, 5, 15, and 30 seconds, then every 30 seconds, and at each `online` event. A pill above the answer bar shows `3 changes waiting`.
- Each change carries `opId` and the item `rev`. The server applies a change only when `rev` matches, then increments `rev`. On a mismatch it returns 409 with the stored state. The client keeps the server state and shows "Changed on another device".
- The submit waits until the queue is empty.

## Storage

The review state goes into SQLite, in `herdr-boss.db`, through migration 2 in `src/sqlite-store.js`. The message store keeps only the Mailbox record and the result message.

Reasons: the message store rewrites the whole file or table for each change, so one write for each tap on 400 items is too costly. The message store deletes records after 30 days, but an open pack must stay until its review ends. The per-item `rev` needs one row for each item.

| Table | Columns |
|---|---|
| `review_packs` | `slug`, `pack`, `title`, `current_version`, `state` (`open`, `submitted`, `expired`), `mail_id`, `created_at`, `closed_at` |
| `review_versions` | `slug`, `pack`, `version`, `manifest` (JSON text), `bytes`, `files`, `published_at`, `published_by` |
| `review_items` | `slug`, `pack`, `version`, `item`, `section`, `hash`, `position` |
| `review_answers` | `slug`, `pack`, `item`, `decision`, `choice`, `rating`, `live`, `viewed`, `note`, `pins` (JSON), `checks` (JSON), `hash` (the item hash at answer time), `rev`, `updated_at` |
| `review_results` | `slug`, `pack`, `version`, `verdict`, `note`, `result` (JSON text), `submitted_at`, `message_id` |

The files go to `<data dir>/review-packs/<slug>/<pack>/v<version>/`. The folders have mode 0700 and the files mode 0600, as the avatars.

### Retention and deletion

- A submitted pack keeps its files and answers for 30 days after the submit, the same time as the message store. Then the engine tick deletes the folder and the rows. It keeps the `review_results` row for 180 days.
- A pack keeps its newest 3 versions. The publish of a fourth version deletes the files of the oldest.
- An open pack with no change for 60 days expires. The tick closes its Mailbox item with `closedBy: "review"` and sends a notice to the orchestrator.
- The Owner deletes a pack in the menu, or the orchestrator runs `herdr-boss review delete <slug> <pack>`. Both delete the files, the rows, and the raw tokens, and close the Mailbox item.

## API

All routes use the existing auth and the same-origin check. The read-only preview allows `GET` and `HEAD` only.

| Route | Action |
|---|---|
| `GET /api/reviews?state=open\|done` | The pack list with progress counts. |
| `GET /api/reviews/:slug/:pack` | The current version: manifest, item states, answers, and progress. `?version=N` selects an older version. |
| `GET /api/reviews/:slug/:pack/files/:version/*` | One pack file. The type comes from the magic bytes. Headers: `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Content-Disposition: inline`, and `Accept-Ranges: bytes` for video. |
| `PUT /api/reviews/:slug/:pack/items/:item` | Change one answer: `{ decision, choice, rating, live, viewed, note, pins, checks, rev, opId }`. Only the given fields change. |
| `PUT /api/reviews/:slug/:pack/note` | The pack note. |
| `POST /api/reviews/:slug/:pack/submit` | `{ verdict, note }`. Writes the result, queues the Owner message, and closes the Mailbox item. A second submit of the same version returns 409. |
| `POST /api/reviews/:slug/:pack/raw-token` | A frame token for `page` items. |
| `DELETE /api/reviews/:slug/:pack` | Delete the pack. |
| `GET /review-raw/:token/*` | A file of a `page` item, with the sandbox CSP. |

The server pushes a `review` event on `/api/events` after each change, so a second device updates.

## The result

### JSON

```json
{
  "schema": "herdr-boss.review-result/1",
  "slug": "shop", "pack": "checkout-redesign", "version": 2,
  "submittedAt": "2026-10-02T08:14:00.000Z",
  "verdict": "request-changes",
  "note": "Good direction. Fix the dark cart before the next pack.",
  "counts": { "items": 31, "accepted": 24, "denied": 2, "live": 1, "noteOnly": 1, "open": 3 },
  "sections": [{ "id": "cart", "state": "denied" }],
  "items": [
    { "id": "cart-themes", "section": "cart", "hash": "sha256:9f…", "state": "denied", "decision": "deny",
      "note": "The total is hard to read in dark.", "pins": [{ "n": 1, "src": "b", "x": 0.72, "y": 0.41 }] },
    { "id": "pay-button", "section": "cart", "state": "answered", "choice": "b" },
    { "id": "flow-video", "section": "cart", "state": "live", "live": "pending" }
  ]
}
```

`state` is `accepted`, `denied`, `answered`, `note`, `live`, or `open`. An item that was removed in this version is not in the list.

### Markdown summary and delivery

The submit appends one Owner record: `{ thread: slug, from: "owner", to: "orch", kind: "review-result", replyTo: <mail id>, status: "queued" }`. `deliverQueued()` sends it with the other Owner messages and the same retries. `ownerPromptText()` gets one case for the kind:

```
[owner] Review result for checkout-redesign v2: Request changes. 24 accepted, 2 denied, 1 live check, 3 open.
Denied: cart-themes (The total is hard to read in dark.), refund-copy.
Fetch the full result: herdr-boss review result shop checkout-redesign --json
```

The prompt text is at most 1500 characters. It lists the denied items and their notes first, then cuts with "… N more". The full Markdown summary is in `herdr-boss review result <slug> <pack>`, and the JSON is in `--json`. The submit calls `closeMailboxItem()` on the review record. The Owner record counts toward the limit of 10 Owner messages a minute.

The orchestrator records the verdict and the note in its memory file when they hold a decision, and plans the follow-up. It can publish a new version of the same pack.

## Planner sessions

A planner session lets one agent pane run review rounds with the Owner. The agent publishes a pack with options, the Owner answers, and the result goes back to that pane.

- The registry is the file `planner-sessions.json` in the data folder. A record has the session ID, the project slug, the pane ID, the kind, the input path, and the start time. It also has the round counter and the end time.
- `herdr-boss plan start KIND PROJECT --input PATH --pane PANE` creates a record and labels the pane `planner`. `herdr-boss worker start --planner` does the same for the new worker pane. `plan list` and `plan end ID` read and close records. `docs/cli.md` has the details.
- A pane with an active session can run `review publish` and `review check`. `publish` works only for the project of the session.
- `review publish` from a planner pane sets `session` and `round` in the manifest. The round counts the publishes of the session. The Mailbox item of the pack names the session and the pane.
- The result of such a pack goes as one message to the planner pane, not to the orch pane. The message lists the pack note, each choice with its label and note, and each skipped item. It has at most 4000 characters, and no secret. The message uses the existing path: the key is the pack and the version, and the delivery retries are the same. When the session has ended, the message goes to the orch pane.
- The result JSON has `session` and `round`. A choice has `choiceLabel`. A skipped item has `skipped: true`.

## Versioning

- A publish with an existing `id` makes version N+1. The pack keeps its Mailbox thread and its answers.
- The item hash is SHA-256 over the canonical JSON of the item (sorted keys, without `id`) and the bytes of each file that the item names.
- An answer on an item with the same hash stays as it is.
- An answer on an item with a new hash stays, but the item shows **Changed since your answer** and counts as open until the Owner answers again. The earlier answer shows as a faded line.
- A new item is open. A removed item shows in the summary under **Removed in vN** with its last answer.
- When a new version arrives during a review, a banner shows "Version 3 is ready. 4 items changed. Switch". The answers carry over at the switch.

## Permissions

Each route needs the dashboard access: loopback, the bearer token, or a session cookie. The Owner is the holder of that access. Only the orchestrator or the Boss pane publishes or deletes through the CLI, with `verifyMessageCaller()`. No CLI command changes an answer or submits. The read-only preview allows `GET` and `HEAD` only, and its answer bar shows disabled with "Read-only preview". The raw route accepts only a short-lived token for one version.

## Limits

| Limit | Value | Reason |
|---|---|---|
| Pack version total | 128 MB | The largest known pack is about 11 MB of images. A short video fits. |
| One file | 32 MB | One screencast of a few minutes. |
| Files in a version | 1000 | A known HTML pack has about 145 pages with their images. |
| Text file | 2 MB | `scanText()` needs the whole text. |
| Markdown text | 200 KB | `MAX_INPUT` of `renderMarkdown()`. |
| Image | 40 megapixels, 16,384 px on a side | Stops an image bomb before a browser decodes it. |
| All packs in the data directory | 2 GB | Publish refuses above it and names the oldest submitted packs. |
| Open packs for a project | 5 | Keeps the Mailbox short. |

## Safety rules

- No pack script runs outside the sandboxed frame. The native viewer renders only data: images, video, escaped text, and Markdown through `renderMarkdown()`.
- Pack files are served with `nosniff` and `default-src 'none'; sandbox`. An HTML file outside a `page` item is refused at publish.
- Every path is checked at publish and at serve time. The serve path joins the version folder with the relative path, resolves it, and refuses a result outside the folder.
- The magic bytes decide the type. The extension and the declared type prove nothing.
- The image size limit applies at publish. The viewer also sets `decoding="async"` and loads only the current, the previous, and the next image.
- The frame has no network. The Owner opens a live URL only with a tap on **Open live**. It opens in a new tab with `rel="noopener noreferrer"`.
- The secret scan runs on every text file and every text field. The Owner notes pass `refuseSecret()` before they reach a pane.

## What the Owner sees

1. The Needs-action icon shows 1. The Mailbox has the item "Review: Landing page redesign (v1)" from the project with the landing page, with the action tag **Decide** and the line "18 items in 3 sections".
2. The Owner taps the item. The thread shows the intro text and **Open review**. The Owner taps it.
3. The section list shows three sections: Hero, Pricing, and Footer. The progress bar is empty: 0 / 18.
4. The Owner taps the first item, "Hero, light and dark". The screenshot fills the screen with a `Light | Dark` toggle. A hint says "Pinch to zoom · double tap for 2×". The Owner zooms on the headline and toggles to Dark at the same spot.
5. The contrast in dark is low. The Owner taps **Note**, taps the headline, and types "Headline gray is too faint in dark." Pin 1 appears. The field shows **Saved**. The Owner taps **Deny**. The viewer moves to the next item.
6. The Owner accepts six items in a row with one tap each. On the pricing table, the Owner chooses alternative B.
7. The item "Sign-up form" says **Needs live check** and has **Open live**. The Owner opens the staging site in a new tab, tries the form, comes back, and taps **Accept**. The live state changes to done.
8. The phone loses the network in a lift. Two answers show **Not saved: retrying** and the pill says `2 changes waiting`. Outside the lift, the pill disappears.
9. The Owner taps **Review summary**. The bar shows 15 accepted, 1 denied, 1 note only, and 1 open. The Owner reviews the open item, writes the pack note "Fix the dark hero, then ship.", keeps the proposed verdict **Request changes**, and taps **Submit review**.
10. The Mailbox item moves to Done with the chip **Changes requested**. The orchestrator pane gets the prompt with the verdict, the denied item, and the fetch command. Later a Mailbox item "Review: Landing page redesign (v2)" arrives. Its section list marks one item **Changed** and keeps the 16 other answers.

## Kit text

Two kit files get a review pack section. The task RP12 adds them with a kit `CHANGES.md` entry: `Impact: useful`, `Summary: Add the review pack section to the orchestrator skill and the worker brief template.`

### `kit/skills/herdr-orchestrator/SKILL.md`

Add this subsection after `### Human gates and parking`, before `## Resume from an unknown state`:

```markdown
### Review packs

- Make a review pack when the Owner must see visual or written evidence to decide: a UI change, a document, a design, an API reference, or a data result. Do not make a pack for a question that one Mailbox line answers.
- Write a folder with `manifest.json`. Put one question in each item. Use the item types `image`, `image-pair`, `gallery`, `video`, `markdown`, `table`, `diff`, `file`, `link`, and `checklist`. Use `ask` to name the questions: `accept`, `deny`, `note`, `live`, `choice`, and `rating`.
- Include the evidence that the Owner needs and nothing more: light and dark pairs for a UI, before and after pairs for a change, the exact text for a document, and a `link` item with `live` for each item that the Owner must operate.
- Keep secrets, tokens, and private data out of the pack. The publish command scans each text file and stops on a finding.
- Publish with `herdr-boss review publish <slug> <folder>`. Import an existing HTML folder with `herdr-boss review import <slug> <folder>`.
- Do not wait for the result. Continue independent work. The result arrives as an `[owner]` prompt with the verdict and a fetch command.
- Read the result with `herdr-boss review result <slug> <pack> --json`. Plan a fix for each denied item and each note. Record an Owner decision from the pack note in `docs/orchestration/memory.md`.
- Publish a new version with the same pack `id` after the fixes. Unchanged items keep their answers.
```

### `kit/templates/worker-brief.md`

Add this section after `## Image budget`, before `## Gates on a shared machine`. The orchestrator deletes the section from a brief with no review pack task.

```markdown
## Review pack

When the task asks for a review pack, write it to `.worker/review-pack/`. Do not publish it. The orchestrator publishes it.

Write `manifest.json` with `"schema": "herdr-boss.review-pack/1"`, an `id`, a `title`, and sections of items. Give each item an `id`, a `title`, a `type`, and `ask`.

Include one item for each thing that the Owner must decide. Add light and dark images for a visual change. Add before and after images for a changed screen. Add the exact text for a document change. Add a `link` item for each live check.

Use only invented or public sample data. Do not add secrets, tokens, or private names.

Check the folder with `herdr-boss review check .worker/review-pack`. Name the folder in the report.
```

`herdr-boss review check <folder>` is the validation step of publish without the copy. Any pane can run it.

## Build tasks

Write a failing regression test before each behavior change. Run only the changed test files with `--test-concurrency=2`. Run the full suite once in the integration worktree, as `AGENTS.md` says.

| Task | Change | Files | Tests | Docs | Size |
|---|---|---|---|---|---|
| RP2 | Manifest validator, file checks (paths, magic bytes, image size, limits), and `scanText()` per file. No I/O outside the folder. | `src/review-pack.js` (new) | `test/review-pack.test.js`: each rule, a `..` path, a symbolic link out of the folder, an SVG, a 50-megapixel PNG header, a secret in a `.md`, an unknown type falls back, `ask` defaults | none yet | M |
| RP3 | SQLite migration 2 and the store: publish a version, hashes, answer upsert with `rev`, carry-over, derived states, retention sweep. | `src/sqlite-store.js`, `src/review-store.js` (new) | `test/review-store.test.js`: `rev` conflict gives 409 data, unchanged hash keeps the answer, changed hash marks stale, keep 3 versions, 30-day sweep, derived section and pack states | none yet | M |
| RP4 | CLI `review check`, `review publish`, `review import`, `review result`, `review delete`, `review list`. Mailbox kind `review`. | `src/cli.js`, `src/messages.js`, `src/review-import.js` (new) | `test/review-cli.test.js`: caller checks, slug of the caller workspace, the Mailbox record, a new version closes the old record, the importer makes a section per page and an item per local image, external URLs listed | `docs/cli.md` | M |
| RP5 | API routes and file serving with headers and ranges. | `src/server.js` | `test/review-api.test.js`: auth, same-origin, preview refuses writes, traversal on the file route, content type from magic bytes, 409 on `rev`, submit twice | `docs/user-guide.md` (API) | M |
| RP6 | Pack list and section list, progress bar, Mailbox **Open review**. | `public/app.js`, `public/review.js` (new), `public/style.css` | `test/review-view.test.js` (pure render functions), browser check 390 px and 1280 px, light and dark | `HELP` in `public/app.js`, `docs/user-guide.md` | M |
| RP7 | Item viewer: all item types, image pair toggle, zoom and pan, swipe, pins, answer bar, keys, shortcut help. | `public/review.js`, `public/review-zoom.js` (new), `public/style.css` | `test/review-view.test.js` (key map, next open item, pin math), browser check with the phone keyboard open | `HELP`, `docs/user-guide.md` | L |
| RP8 | Autosave, offline queue, `rev` conflict handling, `review` event. | `public/review-sync.js` (new), `src/server.js` | `test/review-sync.test.js` (queue merge, backoff, 409 path) | `docs/user-guide.md` | M |
| RP9 | Summary, submit, result JSON and Markdown, `review-result` delivery, Mailbox close. | `src/review-store.js`, `src/messages.js`, `public/review.js` | `test/review-result.test.js`: prompt text cut at 1500, denied first, delivery retry, close, rate limit | `docs/user-guide.md`, `docs/cli.md` | M |
| RP10 | Legacy `page` items: raw token route, CSP, bridge script, overlay pins. | `src/server.js`, `public/review-bridge.js` (new), `public/review.js` | `test/review-raw.test.js`: token expiry, wrong version, CSP header, no `X-Frame-Options`, host check, `POST` refused; browser check in Chrome and Safari that the pack images and the bridge load under `'self'` in the opaque origin (else name the host in each source), that a page `fetch()` fails, and that a pin lands | `docs/user-guide.md` | L |
| RP11 | Retention tick, expiry notice, quota refusal, delete. | `src/engine.js`, `src/review-store.js` | `test/review-store.test.js` (expiry, quota) | `docs/user-guide.md` | S |
| RP12 | Kit review pack text and kit `CHANGES.md` entry. | `kit/skills/herdr-orchestrator/SKILL.md`, `kit/templates/worker-brief.md`, `kit/CHANGES.md` | `test/kit-locks-and-updates.test.js` (template renders), `herdr-boss check agents` | the kit files | S |

### Order

1. RP2, then RP3. They have no UI and no route. RP4 and RP5 follow in parallel; only RP4 changes `src/messages.js`.
2. RP6, RP7, and RP8 in this order, because they share `public/review.js`. RP9 follows RP5 and RP8.
3. RP10 and RP11 after RP9, in parallel. RP12 last, after RP9 is live, so that the kit names working commands.

### Tasks that need the Owner

- RP6 and RP7: the Owner checks the list, the viewer, the zoom, and the swipe on the phone. This is the `owner` evidence tier.
- RP9: the Owner submits one real pack and confirms that the result reached the orchestrator.
- RP10: the Owner confirms that the imported view of one real HTML pack is good enough, and names what is missing.
- Open questions 1 and 2 below.

## Open questions

1. **Answers from loopback.** The dashboard accepts loopback requests with no login. An agent on the machine could call the answer routes. The Mailbox has the same gap today.
   - A: Keep the Mailbox rule. The kit forbids agents to answer.
   - B: Require a session cookie for the review write routes, also on loopback. The dashboard on loopback would then need a login once.
   - Recommendation: A for the first build, the same as the Mailbox. Record B as a follow-up for both pages together.
2. **Video in the first build.** Video adds range requests and 32 MB files.
   - A: Include `video` in RP5 and RP7.
   - B: Accept the type but show it as a `link` until a later task.
   - Recommendation: A. A screencast is the best evidence for a flow, and the native player needs no code.
3. **Custom renderers.** A project can name a renderer, but Herdr Boss ships none.
   - A: No custom renderers. The Markdown fallback stays.
   - B: A renderer registry in `public/review-renderers/` that the HerdrBoss orchestrator reviews.
   - Recommendation: A until a project asks for one. The fallback keeps each pack readable.
4. **The importer item split.** The importer makes one item for each local image.
   - A: As designed.
   - B: One item for each page only.
   - Recommendation: A. The Owner can then answer each image in the native viewer.
