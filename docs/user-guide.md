# User guide

This guide tells how Herdr Boss works and how to set it up. For commands and options, see [cli.md](cli.md). The dashboard has a **Help** panel on each page.

## Requirements

Use Node.js 26.10 or later. Herdr Boss uses the built-in `node:sqlite` module.

## How it works

Every 30 seconds, Herdr Boss reads Herdr workspaces and agents, machine load and memory, and automation browsers and their owner panes. Every 5 minutes, it reads subscription quotas with `codexbar usage --format json`.

The quota read runs beside the 30-second cycle. A slow `codexbar` does not delay the other reads. A later cycle applies the result. Only one quota read runs at a time. Herdr Boss stops `codexbar` after 240 seconds.

When a quota read fails, Herdr Boss keeps the last good quotas. The dashboard shows the error only when no quotas are younger than 15 minutes. The error text tells the cause:

- `codexbar timed out after 240 s`: the read took longer than 240 seconds.
- `codexbar exited with code N`: `codexbar` failed. The text adds the first line of its error output when there is one.

`codexbar` returns one row for each provider. When the probe for one provider fails, `codexbar` exits with code 1 but still returns the good rows. Herdr Boss keeps these rows. Then it reads each failed provider again one time with `codexbar usage --format json --provider NAME`. This retry also stops after 240 seconds. Herdr Boss uses the retry row when it has no error.

When the retry also fails, Herdr Boss keeps the last good row of that provider for 60 minutes. It marks this row as stale and adds the new error. The bulletin quota table shows the row as "Claude quota from HH:MM (probe failed)". The rules line is "Quota data for Claude is from HH:MM; the last probe failed." The dashboard shows the same text on the provider card. Pacing, quota notices, and provider lanes use a stale row as data. Automatic handover does not use a stale row. After 60 minutes, Herdr Boss removes the row and keeps only the error. The bulletin then says "Quota data unavailable for Claude".

At start, Herdr Boss loads the saved quotas from `state.json` when they are younger than 15 minutes. The dashboard shows "Quotas from HH:MM" for these saved quotas until the first new read succeeds. Automatic handover does not use saved quotas.

Then it applies its rules and writes these files to `~/.herdr-boss/`:

| File | Content |
|---|---|
| `bulletin.md` | The rules that orchestrators must obey now. Orchestrators read it before each dispatch. |
| `rules.json` | The same rules for scripts. `worker start` reads it. |
| `state.json` | The full snapshot that the dashboard shows. |
| `events.jsonl` | Prompts, notifications, handovers, and stopped processes. |
| `policy.json` | The resource policy that you set on the Settings and Allocation pages. |
| `policy-changes.jsonl` | The change log of policy writes. One line for each write that changes a value. Keeps the last 500 lines and at most 256 KB. Mode `0600`. See [Policy changes](#policy-changes). |
| `locks/` | Private project lock records. Each Git repository has a separate directory. |
| `lock-ledger.jsonl` | The lock ledger. One line for each lock acquire, release, and failed acquire. Rotates at 5 MB to `lock-ledger.1.jsonl`. |

`herdr-boss scratch <slug>` creates `~/.herdr-boss/scratch/<slug>/` for the orchestrator files of a project. Herdr Boss does not delete this folder.

Herdr Boss is a script. It uses no LLM and no tokens.

## Dashboard preview

A read-only preview binds `127.0.0.1` and accepts loopback requests only. The option `--host <address>` sets another bind address. Use it only with `--read-only-preview`. The main service is not affected: it keeps the configured `host`. It has no login page. It never reads, creates, or changes token or session files.

Put seed data only into a temporary data directory. Never write seed data or test data into `~/.herdr-boss`. Run the preview with `--read-only-preview` on its own port. `scripts/seed-preview.js` writes invented Mailbox and Chat messages into `HERDR_BOSS_DIR`. It refuses the live data directory, a directory inside it, and a symlink to it, with the message `Refusing to write test data into the live data dir.` Each seed or fixture helper calls `assertTempDataDir(dir)` from `src/data-dir-guard.js` before it writes. `openMessageStore` takes an options object such as `{ dir }`. It throws a `TypeError` for a string.

## Chat API

Use `GET /api/chats` to list the Boss chat and project chats with an orchestrator pane. The response gives each chat a title, a last message, and an unread count. A chat without messages has a `null` last message. The last message and each chat record have a `channel` field. The unread count leaves out a mail report.

Use `GET /api/chats/<thread>?limit=<n>&before=<id>` to read a chat. Set `limit` to an integer from 1 to 100. The default is 50. Set `before` to a message ID to read older messages. The response sets `more` to `true` when older messages remain. Each record has a `channel` field of `chat`, `both`, or `mail`.

Use `POST /api/chats/<thread>/read` to mark the unread chat records to the Owner as read. It does not mark a mail report read. The read-only preview refuses this request.

Use `POST /api/messages` to send an Owner message. Read `GET /api/events` to receive each message change as a `message` event.

## Review pack API

A review pack is a set of evidence with one question for each item. The routes below read packs, serve pack files, and store the Owner answers. `src/review-api.js` handles them. `src/review-store.js` keeps the data. A project publishes packs. The Owner answers them.

### Access

The routes sit behind the same checks as the other `/api/` routes, in this order: host check, same-origin check, access check, read-only preview check, then the route.

- A loopback request needs no login. Any other address needs the bearer token or a session cookie. Without them the answer is `401`.
- A request with a foreign `Origin` header, or with `Sec-Fetch-Site: cross-site`, gets `403`. This applies to each method, and to file reads.
- A request with a body needs `Content-Type: application/json`. Other types get `400`.
- The read-only preview serves `GET` and `HEAD`. It answers each other method with `403`.

The read-only preview serves `GET` of packs only from its own temporary data directory. It binds loopback by default.

Only the Owner answers a review pack. The server cannot tell the Owner from an agent on a loopback request. This is the same rule as for the Mailbox. Do not give the dashboard token to an agent. The kit forbids an agent to call an answer route.

### Read routes

| Route | Answer |
|---|---|
| `GET /api/reviews?state=open` | The packs with progress counts. `state` is `open` (default) or `done`. Another value gets `400`. `stale` is the number of items that changed after the Owner answered them. |
| `GET /api/reviews/<slug>/<pack>` | The current version: manifest, files, item states, answers, and progress. `?version=<n>` selects an older version. A submitted version also has `verdict`, `submittedAt`, and `delivery`. An unknown pack or version gets `404`. |
| `GET /api/reviews/<slug>/<pack>/files/<version>/<path>` | One pack file. `<path>` is the file path from the manifest. |
| `POST /api/reviews/<slug>/<pack>/raw-token` | A token for the frame of a `page` item: `{ token, expiresAt }`. `?version=<n>` selects a version. See [Legacy HTML pages](#legacy-html-pages). |

A slug, a pack ID, and an item ID match `[a-z0-9][a-z0-9-]*` and have at most 64 characters. A version is a whole number of 1 or more.

### File route

The route serves a file only when its path equals a stored file of that version. It never joins the request path to a folder. A path with an empty part, a `.` or `..` part, a backslash, or a NUL character gets `400`. A path that names no stored file gets `404`. A stored file that is a symbolic link is not served.

The content type comes from the first bytes of the stored file. The file name and the extension have no effect.

| Bytes | Content type |
|---|---|
| PNG, JPEG, GIF, WebP | `image/png`, `image/jpeg`, `image/gif`, `image/webp` |
| MP4, WebM | `video/mp4`, `video/webm` |
| Text | `text/plain; charset=utf-8` |
| SVG, HTML, other binary | Not served. The answer is `415`. |

Each file response has these headers:

- `X-Content-Type-Options: nosniff`
- `Content-Security-Policy: default-src 'none'; sandbox`
- `Cross-Origin-Resource-Policy: same-origin`
- `Content-Disposition: inline`
- `ETag`: the SHA-256 of the file in quotation marks
- `Cache-Control: private, no-cache`

A request with a matching `If-None-Match` gets `304` with no body. A video response also has `Accept-Ranges: bytes`. A video request with one `Range: bytes=<first>-<last>`, `bytes=<first>-`, or `bytes=-<count>` gets `206` and a `Content-Range` header. A range that starts after the end of the file gets `416` and `Content-Range: bytes */<size>`. A request with several ranges or another unit gets the whole file. Other file types ignore `Range`.

### Answer routes

| Route | Body | Answer |
|---|---|---|
| `PUT /api/reviews/<slug>/<pack>/items/<item>` | `rev` and any of `decision`, `choice`, `rating`, `live`, `viewed`, `note`, `pins`, `checks`, `opId` | `200` with the saved answer. |
| `PUT /api/reviews/<slug>/<pack>/note` | `note`, `rev` | `200` with `note` and the new `rev`. |
| `POST /api/reviews/<slug>/<pack>/submit` | `verdict` (`accept`, `accept-with-changes`, or `deny`), optional `note` | `200` with the result and `delivery`. |

`rev` is the revision that the client last saw. Use `0` for an item with no answer. The server changes only the fields in the body. It accepts the change only when `rev` equals the stored revision. A stale `rev` gets `409` with `conflict: true` and `current`, the stored answer or the stored note. A retry with the same `opId` gets `200` and `duplicate: true`.

The page gives each item change a new `opId`. It sends the same `opId` again when it retries the change. The note route has no `opId`. When a retried note gets `409` and `current.note` is the sent text, the page counts the note as saved.

The submit route stores the result of the current version and closes the pack. It also queues the result for the orchestrator and closes the Mailbox item. A second submit of the same version gets `409` with `conflict: "submitted"`, the first result, and `delivery`. The second submit queues no second message. It repairs a step that failed the first time. A pack takes at most 3 submits in one minute. The fourth gets `429` and a `Retry-After` header. A body that is not valid does not count. A submitted or expired pack takes no answer: the answer route gets `409`.

The routes give these other errors:

- `400`: a body that is not a JSON object, an unknown field, or a field that the item does not allow.
- `404`: an unknown pack.
- `405`: a wrong method, with an `Allow` header.
- `413`: a body over 64 KB for an item, or over 16 KB for a note or a submit.

An error text never holds an absolute path.

### Review result and delivery

A submit stores the result with the pack, in the table `review_results`. The result has two forms. Both forms hold ids, states, and the Owner's notes. They hold no file content and no image.

- **JSON.** The schema is `herdr-boss.review-result/1`. It holds the pack ID, the slug, the title, the version, the submit time, the verdict, the pack note, the state of each section, and one entry for each item. An item entry has the state, the decision, the choice, the rating, the live check, the note, the pins, and `stale` for an item that changed after the answer. The JSON has at most 256 KB. A longer result first shortens the notes, then leaves out items. The field `truncated` names the cut.
- **Markdown.** The summary starts with the counts. Then it lists the denied items and the items that need a live check, with the Owner's notes quoted. The notes, the accepted items, and the open items follow. The Markdown has at most 64 KB. A longer summary ends with `Cut: the summary is longer than 64 KB.`

The verdict is `accept` (**Accept pack**), `accept-with-changes` (**Accept with changes**), or `deny` (**Deny pack**). The summary screen proposes one from the counts. The Owner chooses the verdict.

After a successful submit, the service queues one Owner message of the kind `review-result` to the thread of the project. The message is in the Mailbox thread of the pack. The existing delivery sends it to the pane labeled `orch` of the project, with the same retries as the other Owner messages. The message is keyed by the pack ID and the version, so a version has one message. The text has at most 1500 characters:

```
[owner] Review of <pack title> v<version>: <verdict>. Denied: N, needs live check: N, notes: N, accepted: N, open: N.
Denied: <item>: <note>
Needs live check: <item>: <note>
Fetch the full result: herdr-boss review result <pack id> --version <version> --format json|md
```

Each line except the last has at most 200 characters. A note is one line: a line break or a control character becomes a space, so a note cannot add a line to the prompt. The service removes a token or a password from a note before it queues the message. A list that does not fit ends with `… N more`.

The delivery state is `queued`, `sent`, or `failed`. A failed message is sent again at each tick until it has 4 attempts. `delivery` in the API has `status`, `attempts`, `error`, and `retry`. The Reviews page and the Mailbox thread show the state.

The submit closes the Mailbox item of that version with `closedBy: "owner"` and the note `review submitted`. A second close changes nothing.

### Live review events

The service sends a `review` event on `/api/events` after each saved answer, each saved pack note, and each submit. It also sends one when a pack gets a new version or a new state. The service finds a new version at the next state push, because a publish runs in the CLI process. The event holds ids and numbers only. It never holds an answer, a note text, or a file name.

| Change | Event data |
|---|---|
| An answer | `{ slug, pack, version, item, rev }` |
| The pack note | `{ slug, pack, version, note: true, rev }` |
| A submit | `{ slug, pack, version, state: "submitted" }` |
| A new version or state | `{ slug, pack, version, state }` |

A retry with a known `opId` sends no event. The review page loads the pack again when an event names a `rev` that is newer than the page has. The page also loads the open pack again every 30 seconds.

## Reviews page

The **Reviews** page shows the review packs that projects send to the Owner. The menu entry is after **Board**. The page is an app view, as the Mailbox: on a screen of 760 px or less it fills the screen, and the menu button at the top left opens the drawer.

Herdr Boss deletes a closed pack 30 days after it closes. An open pack expires after 60 days without a change. Herdr Boss keeps each result for 180 days. It keeps the newest 3 versions. The review pack quota is 2 GiB. Run `herdr-boss review delete <slug> <pack>` to delete a pack.

### Routes

| Route | Page |
|---|---|
| `/reviews` | The pack list. `?folder=done` opens the Done folder. |
| `/reviews/<slug>/<pack>` | The section list of one pack, with the summary and the submit form. |
| `/reviews/<slug>/<pack>/<item>` | The item viewer of one item. |
| `/reviews/<slug>/<pack>#item=<item>` | The section list with the row of that item marked and in view. Back from an item page uses this address. |

`/reviews/<slug>/<pack>/summary` opens the section list. An address with a part that is not a slug shows **Review not found**.

### Pack list

The list has two folders. **Open** holds the packs that wait for answers. **Done** holds the submitted and the expired packs. Each row shows the project avatar, the pack title, the version, the time of the last change, the project name, and the count `N of M items answered`. An open row also shows the progress bar. A row with **N changed** has items that changed after the Owner answered them. A done row shows the verdict chip: **Accepted**, **Accepted with changes**, **Denied**, or **Expired**.

### Progress bar

The bar shows the item states in a fixed order: Accepted, Note only, Needs live check, Denied, and Open. Accepted also counts a choice and a rating. The segments use the status colors `--ok`, `--info`, `--warn`, and `--crit`, and `--line` for Open. A gap of 2 px separates the segments. The Denied segment has stripes, so it differs from Needs live check without color. The bar has a text alternative with each count. On the section list, a legend under the bar names each state with its count.

### Section list

Each section is a fold with its title, its state chip, and its count of answered items. A section that is accepted and fully viewed starts folded. The page keeps each fold as the Owner sets it across a refresh. Each item row shows a type icon, the title, the state chip, and the viewed mark. A viewed and answered row is short and faded. **Changed** marks an item that changed after the answer. The item then counts as open. On a screen of 900 px or wider, the sections are in a column at the left, and the state chips of the items show their icon only. The word stays in the tooltip and for screen readers.

### Summary and submit

The summary follows the sections. It lists the items by state: Denied, Needs live check, Note only, Accepted, and Open last. The Owner's note shows under its item. An open item has **Review now**. An open item that changed after the answer shows `changed in this version`. Above the list, `N items have no decision` warns about the open items. The pack note field saves the note 600 ms after the last key, and at once when the field loses the focus. The verdict choice has **Accept pack**, **Accept with changes**, and **Deny pack**. The page selects the proposed verdict and marks it **Proposed**. A pack with no denied item, no open item, and no live item gets **Accept pack**. A pack with only denied items gets **Deny pack**. Any other pack gets **Accept with changes**. The page sets the proposal when it first shows a pack version. A later answer does not move the selection. A new version sets a new proposal. **Submit review** is in the bar at the bottom edge. It asks for a confirm that names the pack, the version, the verdict, and the count of each state. Then it sends the verdict and the pack note. The button stays disabled while the request runs. It is also disabled while changes wait in the autosave queue. It then shows `Waiting for N changes to save`. A submit with open items is allowed. After the submit, the page shows the summary as read-only: the verdict, the pack note, every decision and note, and the delivery state of the result. The delivery state is **Queued**, **Delivered**, **Retrying**, or **Failed**, with the attempts and the reason. When the service stored the result but did not queue the message, **Queue again** queues it. A second submit of the same version shows the first result.

A failed request shows its reason in plain words under the field or in the bottom bar. The page keeps the sentence of the API when the answer has one. Otherwise it shows one of these sentences:

| Cause | Sentence |
|---|---|
| No connection | `The service is not reachable. It may be restarting. Try again in a moment.` |
| `401` | `Sign in again.` |
| `403` | `The service refused the request.` |
| `413` | `The text is too large.` |
| `429` | `Too many requests. Wait a minute and try again.` |
| `500` and higher | `The service reported an error.` |
| Other | `The request failed.` |
 The read-only preview shows the packs. It refuses each note with `Not saved. The service refused the request.` and each submit with `Not sent. The service refused the request.`

### Item viewer

The item viewer shows one item. On a screen of 899 px or less it fills the screen. On a screen of 900 px or wider it fills the pane at the right of the sections. The top bar holds Back, the item title, `Item N of M` with the section name, and the **Viewed** toggle. The answer bar is at the bottom edge. The evidence and the item text are between the two bars.

| Type | Viewer |
|---|---|
| `image` | The image at the fit size in a stage. Pins show over it. |
| `image-pair` | Both images in one stage. **Toggle** shows one image, and the toggle at the top uses the two labels of the manifest. **Slider** shows A at the left and B at the right of a split line. The range under the stage moves the line. The zoom and the pan stay the same when you change the image. |
| `gallery` | A grid of the images. Select an image to open it in the stage. **All images** goes back to the grid. The arrows show the previous and the next image. |
| `video` | The native player with controls and the poster. The player does not start by itself. The file route serves ranges. |
| `markdown` | The text through the Markdown renderer. Raw HTML shows as text. An external link opens in a new tab and has an arrow mark. A table scrolls sideways in its own box. |
| `table` | The rows of the manifest or of the CSV file. The header stays at the top. The box scrolls sideways and down. The viewer shows at most 2000 rows and names the count of the others. |
| `diff` | The lines of the unified diff in the mono font, with the old and the new line number. Added lines have a `+` mark and a green background. Removed lines have a `−` mark and a red background. |
| `file` | The lines of the file in the mono font, with line numbers. The viewer shows at most 5000 lines. |
| `link` | A card with the label, the host name, and **Open (opens in a new tab)**. The link opens the URL in a new tab with `rel="noopener noreferrer"`. The live check control is next to it. |
| `checklist` | One row for each entry. Select a row to tick or untick the entry. |
| `page` | The HTML page in a sandboxed frame. See [Legacy HTML pages](#legacy-html-pages). Only the importer makes this type. |
| Other | The item text as Markdown, under the line `Herdr Boss has no viewer for NAME. It shows the text.` |

The item text of the manifest `body` shows under the evidence. A text file loads when the item opens. A file that does not load shows `The text could not load.` and the reason.

### Zoom, pins, and swipe

- Pinch to zoom from 1× to 8×. Double tap to zoom to 2× at the tap point. Double tap again to go back to the fit size.
- Drag to pan a zoomed image. The pan stops at the edges of the image.
- Hold Ctrl and turn the wheel to zoom. Press `+` or `-` to zoom one step. Press `z` to toggle the fit size and 100 %. At 100 %, one image pixel uses one screen pixel. The fit button under the stage does the same.
- The hint `Pinch to zoom · double tap for 2×` shows for 3 seconds on the first image. It does not show again in the same browser.
- Select **Add pin**, then tap the image. A numbered pin appears, and the note field of the pin gets the focus. An item takes at most 20 pins. The store keeps each pin as fractions of the image, from 0 to 1. A pin of a pair keeps its side, `a` or `b`. A pin of a gallery keeps the file name of its image. Each pin note has at most 200 characters.
- Swipe left for the next item and right for the previous item. On a pair in the toggle view, a swipe shows the other image first. On an open gallery image, a swipe shows the next or the previous image first. A swipe on a zoomed image pans the image.

### Legacy HTML pages

A `page` item shows an imported HTML page in a frame. The page is untrusted. It can hold scripts. The frame isolates the page from the dashboard.

1. The item gets a token from `POST /api/reviews/<slug>/<pack>/raw-token`. The token is 32 random bytes in hex. It names one pack version and expires after 30 minutes. The server keeps the tokens in memory. It keeps at most 200 live tokens and drops the oldest token at the limit. The answer is `{ token, expiresAt }`. The route needs the normal access checks. The read-only preview refuses it.
2. The frame loads `/review-raw/<token>/<path>`. The route accepts `GET` and `HEAD` only. Each other method gets `405`.
3. The route runs before the same-origin check, because the frame has an opaque origin and sends no cookie. It checks the host with the host list of the other routes. The token is the only credential.
4. The route serves only a file that the manifest of the token version names. It refuses a path with `..`, a backslash, or a NUL character. It refuses a symbolic link and a file outside the version folder.
5. Each refusal gets the same `404` body. The response does not show why the route refused the request.

The frame has `sandbox="allow-scripts"`, `referrerpolicy="no-referrer"`, `loading="lazy"`, and `allow=""`. It has no `allow-same-origin`. The page cannot read the dashboard cookie, the DOM of the dashboard, or local storage. The page can still navigate its own frame to an outside address. The frame holds no cookie or storage.

Each response of the raw route has this header. The `sandbox` directive also applies when you open the raw URL in a tab.

```
Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self'; font-src 'self' data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'
```

The response also has `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `Cache-Control: no-store`. It has no `X-Frame-Options` header.

The server appends `<script src="/review-raw/<token>/__hb-bridge.js"></script>` to each HTML page. The file is `public/review-bridge.js`. The bridge sends four messages to the dashboard and handles three:

| Direction | Message | Effect |
|---|---|---|
| Frame to dashboard | `ready` | The title, the page height, and at most 500 anchors (headings and images). The dashboard builds **Page outline** and sets the frame height. |
| Frame to dashboard | `pick` | A tap of the pin tool: the anchor, the point as fractions of the page, and the selected text. The dashboard adds a pin and opens its note. |
| Frame to dashboard | `scroll` | The scroll position. The dashboard shows **In view** with the numbers of the pins in the visible part. |
| Frame to dashboard | `open` | A click on an external link. The dashboard shows **Open live link** with the host name. |
| Dashboard to frame | `pins`, `goto`, `place` | The bridge draws the numbered pins, scrolls to an anchor, and turns the pin tool on or off. |

The dashboard accepts a message only from the frame window with `hb` 1, a known type, a valid shape, and strings of at most 200 characters. A page script can send the same messages. The dashboard ignores a `pick` message while the pin tool is off. It shows all page text as text. It opens an `open` URL only when it is an `http` or `https` URL. The link opens in a new tab with `rel="noopener noreferrer"`.

The frame height is the page height, between 240 and 720 px. A taller page scrolls inside the frame. **Page outline** lists the anchors. Select an entry to scroll the frame to it. If the page does not answer within 10 seconds, the viewer shows **Try again**. **Try again** gets a new token. The viewer also gets a new token when the old token expires.

The frame cannot support these items:

- A page that loads data or fonts from the network, or that posts a form. The CSP blocks them. The importer lists the URLs.
- Local storage, cookies, and IndexedDB. The opaque origin throws an error on access.
- Pop-ups, downloads, printing, and `alert()`.
- **Accept** for one block of the page. A decision belongs to the whole page item and to the image items that the importer made. A note pins to a point.
- Links to other pages of the pack. The bridge blocks them. The pack has one item for each page.
- A stable pin after a layout change. A pin stores the anchor ID and the fractions of the page. The bridge places the pin at the fractions.

### Answer bar

The answer bar shows only the questions in `ask` of the item:

- **Deny** and **Accept** set the decision. Select the pressed button again to clear the decision.
- **Note** opens the note field. The field grows with the text and has at most 2000 characters. The page saves the note 600 ms after the last key, and when the field loses the focus.
- **Live** marks the item **Needs live check**. The live row under the evidence has the live links of the item, or else the live links of the pack. Each link opens in a new tab. Select **Checked** after the check. Select **Live** again to clear the mark.
- A choice shows one button for each alternative. A rating shows one star for each step.

The page marks an item **Viewed** when the item stays open and visible for 1.5 seconds. The time does not count while the browser tab is hidden. The **Viewed** toggle in the top bar sets or clears the mark.

A second tap on the same button within 400 ms is ignored, so a double tap on **Accept** does not clear the decision. A button with a running save shows busy and keeps the focus. A save never moves a button and never takes the focus.

### Autosave and offline

Each change saves by itself. There is no Save button. `public/review-sync.js` holds the autosave queue.

- A decision, a choice, a rating, a live check, a check box, a pin, and the Viewed mark go into the queue at once. A typed note and a pin note go in 600 ms after the last key. They go in at once when the field loses the focus, when you move to another item, and when the page is hidden.
- The queue keeps one patch for each item. A new change of the same item merges into the patch that waits, and the last value of each field wins.
- The queue sends one write at a time, in the order of the first change. Each item write has the `rev` of the item and an `opId`. A retry sends the same `opId`, so a retry after a lost answer does not apply the change twice.

The line under the item and the pill above the answer bar show the save state. The pill also shows the count of waiting changes. The bar with **Submit review** has the same pill. A section row shows a short state for an item with an unsaved change.

| State | Meaning |
|---|---|
| `Saved` | The server stored the change. |
| `Saving...` | The change is in the queue or on its way. |
| `Offline, will save when back` | The service was not reachable. The queue tries again by itself. |
| `Not saved` with **Retry** | The service answered `429` or `500` and higher. The queue tries again by itself. **Retry** tries at once. |
| `Sign in again` | The service answered `401`. The queue stops until you sign in and return to the page. |
| `Not saved.` and the reason | The service refused the change with `400`, `403`, or `413`. The page stops this change. The other changes still save. Select **Retry** to send it again or **Discard** to forget it. |
| `Changed in the new version. Not saved.` | A new pack version changed the item while the change waited. The page does not send the change. Select **Discard**, or answer the item again. |

A change that was not saved stays in the count until you select **Retry** or **Discard**, or answer the item again. The pill then shows `N changes were not saved`, and **Submit review** shows the same text and stays disabled. A change for a submitted, expired, or deleted pack has **Discard** only.

After a failure, the queue tries again after 2, 4, 8, and 16 seconds, then every 30 seconds. It also tries at once when the browser is online again and when the page gets the focus. The queue keeps the waiting changes in `localStorage` under `herdr-boss.review-queue:<slug>/<pack>:v<version>`. The key holds only the patches, the `opId` values, the `rev` values, and the item hashes. A reload restores the queue and shows the waiting changes. When the queue is larger than 200 KB, or the browser has no storage or refuses it, the queue stays in the page only. The pill then asks you to keep the page open.

Two tabs of one pack share one storage key. Each tab sends only its own changes. When a tab writes the key, it keeps the stored changes of the other tabs. A change leaves the key when the tab that owns it saves, stops, or merges it. A tab counts the waiting changes of the other tabs in the pill and in the submit lock, and updates the count at each `storage` event. **Retry** in the pill takes over the waiting changes of another tab, for example of a closed tab, and sends them. A reload also takes them over. A second send of the same change is safe: an item write carries its `opId`, and a note retry that meets its own text counts as saved.

The queue stores a change as sent before the request starts. A reload after a lost answer sends the change again with the same `opId`. A new edit of the same item then waits behind it and gets the `rev` of the saved change.

Before the queue sends a change that waited offline or that a reload restored, it reads the pack. It also reads the pack once when an item write gets `400`, because a new version can have replaced the item. On the same version, the queue stops the change with the server sentence. On a newer version, it applies the hash rule below. A pack that is submitted, expired, or deleted gets no write, and the page says why. When the pack has a newer version, the queue keeps a change only for an item with the same hash. The other changes show `Changed in the new version. Not saved.` The pack note moves to the new version.

When another device changed the answer first, the server answers `409`. For a change that did not wait, the item shows the other answer and two buttons. **Keep mine** sends your change again with the `rev` of the other answer. **Use theirs** keeps the other answer and drops your drafts. For changes that waited offline, the pack page asks once. It lists all items with a conflict and has **Keep mine** and **Use theirs** for all of them. A pack note conflict shows the other note under the note field with the same two buttons. When the `409` does not include the stored answer, the queue loads the pack again to get it. When that load fails, the page shows `The answer changed on another device, and the page could not load it. Reload the page.` The read-only preview refuses each change with `Not saved. The service refused the request.`

The **Previous**, **Next open**, and **Next** links under the item move between the items. After a move by a key or a swipe, the focus goes to the item heading. A submitted pack shows its answers and disables the controls.

### Keys

On the pack list and the section list:

| Key | Action |
|---|---|
| `j`, `k` | Next or previous row |
| `J`, `K` | Next or previous section |
| `u`, `Esc` | Back: from a pack to the list |
| `s` | Go to the summary and the pack note |
| `?` | Open the page help |

In the item viewer:

| Key | Action |
|---|---|
| `j` or `→`, `k` or `←` | Next or previous item |
| `J`, `K` | First item of the next or the previous section |
| `n` | Next open item |
| `a`, `d`, `l` | Accept, Deny, Needs live check |
| `c` | Open the note field |
| `p` | Start or stop pin mode |
| `1` to `6` | Choose an alternative, or give a rating |
| `v` | Toggle Viewed |
| `e` | Mark Viewed and go to the next item |
| `t` | Toggle the two images of a pair |
| `z`, `+`, `-` | Toggle fit and 100 %, zoom in, zoom out |
| `s` | Go to the summary |
| `u`, `Esc` | Back: close pin mode, close a gallery image, or go to the section list |
| `?` | Open the page help |

The keys do nothing while the focus is in a text field, except `Esc`, which leaves the field. The arrow keys keep their own action in a video, a range, and a box that scrolls sideways.

### Mailbox entry

A Mailbox item of the kind `review` has **Open review** in place of the answer form. On a phone the link is in the bar at the bottom edge. The submit of the review closes the item. The closed item shows `Review submitted`, the delivery state of the result, and **Open review**. **Open review** on a closed item opens the submitted summary as read-only. The Mailbox thread of the pack shows the result message with its delivery state.

## What the dashboard manages

Every setting and every resource that Herdr Boss manages is visible and settable in the dashboard, unless a good reason keeps it outside. These are the good reasons:

- A secret, such as a token or a credential.
- The access token file, and a session file.
- A Claude setting that agents must not edit.
- A code contract that must not move, such as the `orch` pane label or the built-in browser port range.
- A resource that another project or process owns, such as a shared browser that Herdr Boss did not start.
- A repository file that a release changes, such as the kit catalog or the kit template.

When a value stays outside, the dashboard names it and the reason. The audit and its gap list are in [gui-settings-audit.md](ideas/gui-settings-audit.md).

## New project setup

The command `herdr-boss project new` builds a new project in steps. See `docs/cli.md`, section New project flow.

With `--remote gh`, the step `remote` asks you before it creates a GitHub repository. The question is a decide item in the Mailbox. The dashboard wizard is the exception: your choice in the wizard is the decision, and it posts no item. The default is a private repository. A public repository needs `--visibility public` and an answer that contains the word `public`. The command exits with code 3 and waits. Answer the item, then run the same command with `--resume`. The step never pushes.

The steps `policy`, `register`, and `status` put the new project into Herdr Boss:

1. `policy` gives the project a share of 10 percent. The other projects give up part of their share, so the total stays at most 100. When the previous total was 100, the scaled shares add up to exactly 90 by the largest remainder method, and no share of 1 or more falls below 1. Each project keeps its mode and its exclusions. You see the shares before and after the change.
2. `register` records the project folder in `project-repos.json`. The dashboard and the engine then read the repository of the project.
3. `status` publishes the first status. It holds one task, `Set up the project`. The project appears on the dashboard with this task.

The step `workspace` starts the first orchestrator. It runs only when you give `--start`, because the orchestrator uses model quota:

1. `workspace` creates a Herdr workspace with the label of the slug. The root pane gets the label `orch`.
2. The step starts the agent `<slug>-orch`. It uses `--kind` when you give it. Otherwise it uses the first usable entry of the orchestrator ladder in Settings.
3. The step watches the new pane for a folder trust prompt. See the paragraph below.
4. The step gives the agent your goal, or the **Default orchestrator goal** from Settings. A Claude agent gets `/goal`. A Codex agent gets the goal in the first prompt.
5. The step sends the first prompt. The agent reads `AGENTS.md`, the project memory, and the kit file. Then it starts the task `Set up the project`.

The Owner accepts the trust prompt. Herdr Boss only tells the Owner where it is. Claude Code and Codex show a folder trust prompt in a new folder. Herdr Boss reads only the pane that this run created, every 2 seconds, for 3 minutes. When the pane shows the known prompt for exactly the project folder, Herdr Boss posts one item to the Mailbox. The item names the pane and links to the Agents page. Open the Agents page, choose the pane, and press Enter on the option that trusts the folder. Herdr Boss never presses a key in a pane for this. If the agent is neither ready nor working after 3 minutes and the prompt was not seen, Herdr Boss posts one item that says the pane may wait for input. Claude Code and Codex have a known prompt. Pi and OpenCode show no folder trust prompt, so Herdr Boss does not watch them.

The step `harness` prepares the machine for the project:

1. It adds the project to the Codex `writable_roots`. It writes a backup of the Codex config first.
2. It prints the Claude autoMode lines that are missing. Add them to `~/.claude/settings.json` yourself. Herdr Boss never edits that file. The step detail says `needs Owner action` when a line is missing.
3. It reserves a browser port for the project. It starts no browser.

Run the command again with `--resume --start` after a failure. The run uses the workspace and the pane that it created. It sends no message twice.

Run `herdr-boss project check <slug>` at any time. It reads the project and prints `ok` or `missing:` for each part: the folder, `AGENTS.md`, the kit, the first commit, the remote, the policy entry, the registration, the status, the workspace, the Codex roots, and the browser reservation. It changes nothing. Each missing part names a fix. Run `herdr-boss project check <slug> --fix STEP` to run that one step again. The command then prints the check again. The exit code is 0 when all parts are present and 4 when a part is missing.

Each step changes nothing when its result already exists. A run that stops at a failed step continues at that step on the next run. After the change, check the shares on the Allocation page.

### New project wizard

The Projects page has the button **New project**. The button opens a panel on a wide screen and a full-screen sheet on a phone. The panel shows one step at a time.

1. **Name.** Enter the slug. Enter a name if it must differ from the slug.
2. **Folder.** Enter a group folder or an exact path. Herdr Boss has no default folder.
3. **Remote.** Choose a new GitHub repository, no remote, or an existing URL. The default is a private GitHub repository. The choice of the visibility is your decision. Herdr Boss creates the repository at once and posts no Mailbox item. A public repository shows a warning and a confirmation field. Type the word `public` in the field. The button **Next** stays disabled until the word matches.
4. **Orchestrator.** Choose the kind, enter an optional goal of at most 1000 characters, and set the tick box **Start the orchestrator**. The tick box is on by default.
5. **Review.** The panel calls the plan route and lists the steps that the run will do. It also lists each error. Select **Create project** to start the run.

Press Enter to go to the next step. Press Escape to close the panel. The panel asks first when the form has content.

The wizard sends the visibility that you chose as a decision. The flow creates the GitHub repository with that visibility and does not push. The flow posts no decide item. The state file records the choice in `ids.remoteDecision` as `visibility`, `source`, and `at`.

A public repository means that anyone on the internet can read all files and the full history. Do not put secrets, client names, or private data in it. If someone copies it, making it private later does not undo that. The wizard sends `confirmPublic: true` only after you typed `public`. The draft does not keep the typed word.

A flow that already posted a decide item, for example from the command line, waits for an answer. Select **Resume** after you answer the item in the Mailbox. When the wizard sends a decision to such a flow, the flow uses the decision and closes the open item with the note `answered in the wizard`.

The progress view reads the status route every 2 seconds. It stops when the run is done, failed, waiting, or interrupted. It also stops on a sign-in error (401) or a refusal (403). After a network error it retries after 2, 4, and 8 seconds. After 10 failures in a row it stops and shows **Resume** and **Check**. Each step shows its state and its detail. **Resume** continues the run. **Check** shows the project check.

The browser saves the form in local storage. The saved draft holds no repository URL. Select **Start a new form** in the progress view to clear the draft.

The read-only preview does not allow a new project. The panel shows a message in place of the form.

### Project setup API

The dashboard wizard uses these routes. They run the same flow as `herdr-boss project new`. There is no second implementation.

The routes are for the Owner. They sit behind the dashboard access control: a loopback request needs no login, and any other address needs the token. The server has no way to tell the Owner from the Boss or a worker on a loopback request. Do not give the dashboard token to an agent.

The read-only preview refuses every route with the message `This read-only preview does not allow changes.` This includes the GET routes, because they show local paths.

- `POST /api/project-new/plan` runs the dry run. The body has `slug`, `name`, `group` or `path`, `remote`, `visibility`, `org`, `kind`, `goal`, `start`, and `decision`. The response lists each step with a `would ...` text and gives the resolved `path`. The route writes nothing.
- `POST /api/project-new` starts the flow with the same body. The flow runs in a separate process, so the dashboard stays responsive. The response is `202` with the `slug`, the `state` `running`, and the `url` of the status route. The flow sends the first prompt to the model only when the body has `start: true`.
- `GET /api/project-new/<slug>` returns the status. The field `state` is `running`, `waiting`, `failed`, `interrupted`, `done`, or `idle`. Each step has a `name`, a `status`, and a `detail`. The field `exitCode` is `null` while the flow runs, `0` when it is done, `1` when a step failed, `1` also when the run was interrupted, and `3` when it waits for an Owner decision.
- `POST /api/project-new/<slug>/resume` continues the flow at the first step that is not finished. The body can be empty. It can set `remote`, `visibility`, `org`, `kind`, `start`, and `decision`. Any value that the body leaves out comes from the first request.
- `GET /api/project-new/<slug>/check` returns the read-only project check: `ok` and a list of items with `name`, `ok`, and `detail`.

The field `decision` is `{ "visibility": "private" | "public", "confirmPublic": true, "source": "wizard" }`. It is for the Owner behind the dashboard token. It needs `remote: gh`, and `visibility` must match when the body has both. With a decision, the step `remote` creates the repository and posts no decide item. The value `public` needs `confirmPublic: true`. Without it the route answers `400`. A request without `decision` works as the command line does: the flow posts a decide item. The command line never accepts a decision.

A flow with `remote: gh` and no decision waits at the step `remote`. The status then has `state: waiting` and `waiting: { reason: "waiting for an Owner decision", item: <message id> }`. Answer the decide item in the Mailbox. Then call the resume route.

The routes refuse a request with these status codes:

- `400`: the body is not a JSON object, the content type is not `application/json`, a field is unknown or has the wrong type, or the flow module refuses the inputs. A remote URL with a credential is refused.
- `403`: the preview refuses the request.
- `404`: the slug has no flow state, or the route does not exist.
- `405`: the method does not fit the route.
- `409`: a run of the same slug is running.
- `500`: an unexpected error. The message has no credential and no absolute path, and the server logs the error.
- `413`: the body is larger than 16 KB.
- `429`: 2 runs already run. Try again when one ends.

A run writes the marker file `flows/<slug>.running` and removes it when the run ends. After a restart of the service, a marker without a running flow gives the state `interrupted`. Call the resume route to continue. The server keeps the 20 newest finished runs in memory. The state file answers for older runs.

A response never holds a token, and never holds an absolute path outside the project path of the request. A path outside the project appears as `<path>`. A crash of the flow process sets the first unfinished step to `failed` in the state file `flows/<slug>.json`.

## Project memory

Store project memory in `docs/orchestration/memory.md`. Commit this file with the project repository.

Store Boss memory in `~/.herdr-boss/boss-memory.md`. Keep this file private and never commit it.

Start the Boss agent with `~/.herdr-boss` as its working folder, not a project repository. Claude Code keeps one memory folder per working folder. A Boss that starts in the HerdrBoss repository shares its Claude memory with the HerdrBoss orchestrator, so each one reads the other's notes.

Use these five sections in this order:

- `## Owner decisions in force`: Record one line per decision. Include the date (YYYY-MM-DD) and the source.
- `## Holds and freezes`: Record one line per hold. Include its start date, scope, and the condition that lifts it. Delete the line when the hold is lifted.
- `## Standing rules`: Record project rules that are not in `AGENTS.md` yet.
- `## Roles and panes`: Record facts that stay true for longer than one session.
- `## Evidence`: Record pointers to files, commits, or reports. Do not copy evidence into the file.

Keep current state only. Delete a line when a decision is superseded. Git keeps history.

Never store secrets, tokens, or credentials. In a public repository, do not store client names, tenant URLs, or details of other projects.

## Kit block in AGENTS.md

Herdr Boss keeps the shared orchestration rules in a kit file in each project repository: `docs/orchestration/herdr-boss.md`. Only Herdr Boss writes this file. Its first line is `<!-- herdr-boss kit v=<revision> -->`. The revision is the first 12 hex characters of the SHA-256 of the relative file names and contents in `kit/templates/`, `kit/skills/herdr-orchestrator/SKILL.md`, its reference files, and `kit/models.json`. Service, dashboard, and website changes do not change this revision. The project `AGENTS.md` holds a short stub between `<!-- herdr-boss:begin v=<hash> -->` and `<!-- herdr-boss:end -->`. The stub tells the orchestrator to read the kit file and `docs/orchestration/memory.md` at start and at resume. `herdr-boss kit install` writes the kit file and the stub. `herdr-boss kit update` runs the same install, prints the kit changes since the installed kit revision, and prints the current kit file. The digest names the impact and the summary of each change, oldest first. It reads the installed revision from the version line of the project kit file. When the change log does not know that revision, the digest lists every known change. `--quiet` prints the digest and the summary line only, and prints nothing when the kit is current and no file changes. The install writes a file only when its content changes, so a session start on a current project changes no file. Commit a changed kit file, stub, or hook with the next orchestrator commit. Do not make a separate commit. The command always installs, also when the digest has no change. It also adds a Claude `SessionStart` hook to `.claude/settings.json`. At each session start the hook runs `herdr-boss kit update --quiet`, then prints both files. `herdr-boss worker start`, `herdr-boss publish`, and `herdr-boss handoff plan|prepare` print one line when the project kit is behind for a `required` or `useful` change. The line tells the orchestrator to run `herdr-boss kit update`. `herdr-boss check agents` finds a missing, old, or hand-edited kit file or stub. It also finds stale orchestration text outside the stub, such as fixed pane IDs, dated lines, copied model lists, and text that sends pushes or product decisions to the Boss. `herdr-boss publish` and `herdr-boss worker start` run the same check and warn. The project page shows the counts from the last `publish`. The orchestrator publishes the kit revision that it loaded as `kitRevision`. The project page shows that revision and the current revision, and a warning when they are different. The kit file also holds the working rules for context and cost. An orchestrator uses subagents for diff reviews, long report reads, log searches, and code surveys, and keeps the main thread for decisions. It takes back only findings with file and line evidence and verifies a finding at the source before it acts. It uses a cheaper subagent model where the task allows, and Opus only for hard judgment. After a dispatch the orchestrator ends its turn and waits for the `WORKER REPORT` message. The service warns about a stall, a block, and a missing report. As a backup only, the orchestrator runs at most one check every 20 to 30 minutes while a worker runs with no report. The check is `herdr-boss worker list` and the pane status line. Each worker brief tells the worker to report back through Herdr when done and to send a `WORKER QUESTION` when blocked. `herdr-boss check kit` lists the loaded revision and the state of each project: `current`, `behind (useful only)`, `behind (required)`, or `not published`. Only `behind (required)` and `not published` fail the check. The project page shows a project that is `behind (useful only)` as a muted line. It shows a warning for `behind (required)`. A revision that `kit/CHANGES.md` does not list counts as `behind (required)`. The bulletin shows the current kit revision in its header. The commands are in [cli.md](cli.md).

## Orchestrators

Herdr Boss finds an orchestrator by its pane label `orch`. Tab names do not matter. An orchestrator can label its own pane:

```sh
herdr pane rename "$HERDR_PANE_ID" orch
```

The label stays when the agent in the pane restarts. The pane with the label `boss` is the Herdr Boss orchestrator itself.

`herdr-boss worker start` puts each worker in a pane of a worker tab in the workspace of the orchestrator. The worker tabs have the labels `Workers`, `Workers 2`, `Workers 3`, and so on. A worker tab holds at most 3 worker panes, so each pane stays wide enough to read. A new worker uses the first worker tab with a free slot and splits from the newest pane in that tab. When all worker tabs are full, the worker creates the tab with the lowest free label and uses its root pane. Set `workerPanesPerTab` in `.herdr-boss.json` to an integer from 1 to 6 to change the limit. Each worker gets a worktree in `~/Projects/.herdr-wt/<repo>/<name>`. A project can set another place in `.herdr-boss.json`. Herdr Boss does not move an existing worktree. An older worktree in a sibling folder `<repo>-wt-<name>` stays in use until `worktree prune` removes it. Read a worker dialog with `herdr agent read <name> --source recent-unwrapped`. This source joins wrapped lines, so a narrow pane still shows the complete dialog.

Orchestration needs settings in each agent harness: Claude `autoMode`, Codex `writable_roots` and rules, the OpenCode `worker` agent, and the Pi guard. [harness-setup.md](harness-setup.md) gives each setting and its risk. The first `publish` of a slug registers the project repository and adds its `.git` to the Codex writable roots. The parent folder `~/Projects/.herdr-wt` of all worker worktrees is one more Codex writable root. `herdr-boss harness sync` adds it. Run `herdr-boss harness check` when a harness refuses routine work.

To add the shared rules to a project, follow [orchestrator-instructions.md](orchestrator-instructions.md). The shared process is in [the orchestrator skill](../kit/skills/herdr-orchestrator/SKILL.md).

## Rules and notices

| Condition | Action |
|---|---|
| A quota window reaches the critical percentage in `config.json` | Critical notice in the bulletin only. The bulletin tells orchestrators to avoid that kind. |
| A quota window reaches the warning percentage in `config.json` | Warning notice in the bulletin only. |
| A quota window that had a warning resets below the warning percentage in `config.json` | `Quota restriction cleared` notice in the bulletin only. |
| A live quota window is at 100% or more | The provider lane is exhausted until the latest reset among its exhausted windows. `worker start` refuses it unless you use `--force`. |
| A window has a use of at least the minimum use, and its use is more than the pace tolerance above the goal-adjusted pace | The provider lane is "ahead of pace". `worker start` refuses it. |
| Free memory is below 15% | Warning notice. |
| Active machine CPU limit or enabled 5-minute load backstop is exceeded | Stop new workers and full test suites. `worker start` refuses the dispatch, including with `--force`. |
| An idle worker still owns an automation browser after 30 minutes | Notice to that project. |
| A worker is idle for more than 2 hours | Notice to that project. Parked workers and prepared successors are skipped. |
| An `agent-browser` daemon has no parent, no children, and is older than 2 hours | Herdr Boss stops the daemon. It never stops a browser. |
| A parent-PID-1 process has its current working directory in a missing worktree | Notice that project's `orch` workspace. Do not notify the Boss workspace. |
| A non-orchestrator worker stays blocked for more than 5 minutes | Notice its project orchestrator with the worker name and pane ID. |
| A worker pane with an unfinished run stays idle or done for 10 minutes without `.worker/report.json` in its worktree | One warning to its project orchestrator for that idle period. |
| An `orch` pane stays `idle` or `done` for the configured idle minutes while its published status has an actionable task | Notice that project with the task ID and title. When the project has a free effective slot, name the first lane from **Use now**. |
| The service starts, and the checked-out branch has new commits that change `kit/`, `src/kit/`, or `docs/orchestrator-instructions.md`, and at least one of those changes has impact `required` | One `Kit updated` digest to each project orchestrator, at most once in `machine.kitDigestMinutes` minutes, with the kit revision and the subjects of the required changes that the pane has not received, newest first. Do not notify the Boss workspace or a project that is paused, held, or stood down. |
| A worker is working, first appears idle or done, or changes into either state | Herdr Boss reads only the last 8 visible pane lines. A known provider error marks the worker failed and sends the orchestrator its name, pane ID, and fixed error label. |
| A worker writes `.worker/report.json` or `.worker/<name>/report.json` after its pane first appears, and its pane shows no `herdr agent prompt` command with `WORKER REPORT <name>` within 2 minutes | One notice per report file path. A rewrite of the same file sends no new notice. A worker that sends its `WORKER REPORT` prompt causes no notice. |
| A managed project browser starts and responds | `browser is ready` notice in the bulletin only. |
| A published project status is stale: it is old while workers ran or commits landed, or an active worker runs a task that is not `doing` | One `info` notice to that project's `orch` pane for each stale status. The bulletin shows `Status stale since <time>.` in the project section. See [Live task state](#live-task-state). |

The no-report watchdog starts its timer when a worker first appears idle or done. A change between these two states does not reset the timer. The warning goes to that project's `orch` pane. Herdr Boss sends it once in the idle period. A working pane resets the period. An existing `report.json` prevents the warning.

The failure labels are `API Error`, `401`, `429`, `Connection lost`, `usage limit`, `rate limit`, `overloaded`, and `Free usage exceeded`. Matching ignores letter case and ignores each line whose trimmed text starts with `Tip:`. The matcher requires error forms for `401` (`401 Unauthorized`, `HTTP 401`, or `status 401`) and `usage limit` (`usage limit reached`, `usage limit exceeded`, or `hit your usage limit`). Herdr Boss stores and sends only the matched label and a parsed retry time. It does not store or forward pane output. Herdr Boss reads a working pane on every engine tick, so a failure is found while the worker still works. A matched worker shows the failed status in the snapshot even when Herdr reports it working. The engine then does not count it as running, so its slot becomes free. A failure found in a working pane clears when a later read shows no known failure. A failure found on an idle or done pane clears when that pane starts working and a later read shows no known failure. Any failed status clears when a different worker uses the pane. A later failure creates a new notice. A valid free-usage retry time exhausts the matching unmetered model until that time. The unmetered lane lists it separately from available models. A `Free usage exceeded` failure of an `opencode` worker with an unmetered model also exhausts the whole `opencode` free lane. This closes every unmetered model of the `opencode` harness. The lane uses the parsed retry time. Without a parsed retry time, the lane closes for 1 hour after the failure, and the lane shows that the reset time is unknown. A later absolute retry time in the same pane extends the exhaustion to that time. Herdr Boss measures a relative retry time from the first observation of the failure.

An idle-orchestrator nudge reads the published project status file. Herdr Boss sends it only when the project mode is `auto` or `active`. It skips the `idle` and `paused` modes and the Boss workspace. The `orch` pane must be `idle` or `done` for at least the configured idle minutes. No other worker in that workspace may be `working`, `blocked`, or `failed`.

A task is actionable when its status is `todo`, `doing`, or `review` and every ID in its `blockedBy` list is `done` in the same project. An unknown blocker stays unresolved. A task with status `blocked` is never actionable. Herdr Boss picks one actionable task: current frontier first, then a task without a frontier value, then next frontier. Status-file order decides a tie.

A task in a group with `"held": true` is not actionable. The nudge then names the next actionable task outside the held group, or sends no notice.

The notice names the task ID and title. Resume an idle or done worker on that task, or start suitable work yourself. Check **Use now** when the project has a free effective slot. If it lists a lane, start ready work on that lane's harness. The notice uses one key per project and task, so the normal notice cooldown limits repeats. A different next task gets a new key and can prompt again.

A notice is a prompt to an `orch` pane. Herdr Boss normally sends it only when that agent is `idle` or `done`, and no more than the configured cooldown per alert and pane. It sends it sooner only when the severity increases. An immediate notice with severity `warn` or `critical` also goes to a `working` orchestrator. Worker failure notices are of this type. An immediate `info` notice, for example a worker report notice, waits until the orchestrator is `idle` or `done`. A notice for all orchestrators goes only to projects with a worker that is `working` or `blocked`.

Some notices are in the bulletin only and are never sent as a prompt. These are the quota notices at 90% and 98%, the `Quota restriction cleared` notice, and the `browser is ready` notice. The alert source marks each of them with `prompt: false`. Worker failure, blocked-worker, kit, handover, disk, and machine-limit notices are sent as prompts.

Herdr Boss sends the `info` notices of one pane as one digest. All `info` notices of all kinds use the digest. A pane gets at most one digest in 2 hours. Herdr Boss sends no digest while the pane status is `working`. The digest waits until the status is `idle` or `done`. The first digest goes out as soon as the pane is settled. Other `info` notices for that pane wait. The digest sends all waiting `info` notices together, one line each. It shows at most 8 of these lines, then one `and N more` line. The bulletin lists all notices. Kit notices are not part of this digest. See the kit digest below. The 2-hour limit does not apply to `warn` and `critical` notices. They arrive at once. A `warn` or `critical` prompt inside the 2 hours does not include the waiting `info` notices.

A notice with severity `warn` and a key that starts with `machine:` or `browser:` joins the digest with the `info` notices. It waits for the same 2-hour interval. It goes out in the same prompt as the `info` notices, one line each. The keys that use this path are `machine:swap`, `machine:mem`, `machine:load`, and `browser:managed-down`. The digest lists each key once, with its newest text. A key that is no longer active is not listed. The notice cooldown still decides when a digest sends the same key again. A notice with severity `critical` keeps its own path and goes out at once. An `immediate` notice keeps its own path, so `browser:managed-unresponsive` goes out at once. A key that starts with `machine:disk:` keeps its own path and goes out at once.

Herdr does not show a draft or an open dialog in a pane. Herdr Boss does not detect them. An agent that waits for input has the status `blocked`, and Herdr Boss sends it no prompt except an immediate `warn` or `critical` notice.

The kit notice goes to every project orchestrator, also when the project has no active workers. The Boss workspace and the workspace of a paused, held, or stood-down project do not get it. The kit reminder skips such a project too, and its 2-hour clock starts again when the hold ends. A project is paused when its published `status` is `paused`, or when its allocation mode is `paused`. The kit notice uses the same rule as the handover skip. Herdr Boss finds the workspace of a paused project by the published `workspace` id, by the allocation, by a workspace label that equals the project slug or name, or by an orchestrator pane that runs in the project repository. Each kit notice path uses this one rule. A change that arrived during the hold stays pending. The orchestrator gets it in one digest when the hold ends, if the change is not older than 7 days. Older changes reach the project through the kit reminder. When the engine starts, it reads Git once in the directory that the service runs from. It runs no timers and no model calls. It stores the last notified commit and the current kit revision as `kitNotice` in `memory.json`. On the first start, it stores `HEAD` and sends nothing. When Git fails, or the stored commit is not an ancestor of `HEAD`, it stores `HEAD`, sends nothing, and logs one `kit` event. The engine keeps each required change as pending, also over a restart, until a pane receives it. A pane gets at most one kit digest in the number of minutes in `machine.kitDigestMinutes` (default 120, range 10 to 1440). The first kit digest of a pane goes out at once. A change that arrives inside the interval waits and joins the next digest. The digest lists all pending changes that the pane has not received. Herdr Boss sends no kit digest while the pane is `working`. It sends the digest when the pane is `idle` or `done`. The kit digest has its own interval and does not use the 2-hour interval of the `info` digest. A change stays pending for 7 days. The read-only preview does not read Git and does not send or store the notice.

The engine sends the notice only when at least one new kit change has impact `required`. A change with impact `useful` or `none` sends no notice, and a mixed batch names only the required changes. The impact comes from the `Kit-Impact:` trailer of the commit message. When a commit has no usable trailer, the engine reads the impact from the matching entry in `kit/CHANGES.md`. It uses the entry only when the number of entries after the stored revision equals the number of commits that changed an installed kit asset. Otherwise the change has impact `useful`. Only a trailer or a change log entry sets `required`. A stored notice from an older release has no revision, so its first batch has impact `useful` unless a trailer says otherwise.

Each commit that changes `kit/`, `src/kit/`, or `docs/orchestrator-instructions.md` must carry a `Kit-Impact: required`, `Kit-Impact: useful`, or `Kit-Impact: none` trailer, or must change `kit/CHANGES.md`. Put the trailer in the last block of the commit message. `test/kit-impact-trailer.test.js` reads the Git log and fails for a commit after the base commit `9679bcd` that has neither. Use `required` only when a project must run `herdr-boss kit update` to keep working.

The notice text is `[herdr-boss] Kit revision <revision> (<n> change(s)): <subjects>. Run herdr-boss kit update and continue. The command prints the current kit file.` It names at most 10 subjects, then `and N more`. The revision in the notice is the kit revision of the directory that the service runs from. When you get a kit notice, run `herdr-boss kit update`. The command installs the kit as `herdr-boss kit install` does, prints the digest of the kit changes since the installed kit revision, and prints the current kit file. Do not read the kit file again. Publish the new `kitRevision`. A project that stays `behind (required)` for 2 hours gets one reminder while its orchestrator works. The service starts the 2 hours when it first sees the project behind on a required change. The clock stops when the project catches up or is behind on useful changes only. The reminder text is `[herdr-boss] Your kit is behind on a required change. Run herdr-boss kit update and continue. Kit revision now <revision>.` The reminder shows no desktop notification, and an idle orchestrator does not get it. You get a desktop notification once for each warning.

The notice cooldown is saved as `machine.alertCooldownSeconds` in `policy.json`. Its default is 21600 seconds (6 hours). The legacy top-level `alertCooldownSeconds` value in `config.json` is unused.

A published project status is stale when both conditions are true:

- Its `updated` time is more than `staleStatusMinutes` old. The default is 120 minutes. Set it in `config.json`.
- After the `updated` time, a worker of the project was `working` in the last 2 hours, or new commits landed on the project repository.

A paused project is never stale. Herdr Boss finds the repository in `project-repos.json`. A project without a repository record uses only the worker condition. Herdr Boss runs `git -C <repo> rev-parse HEAD` and `git -C <repo> log -1 --format=%cI` at most once every 10 minutes for each project. New commits landed when the HEAD commit time is after `updated`, or when `HEAD` changed after `updated`.

The stale notice text is `Your published status is <age> old while <workers ran | new commits landed>. Run herdr-boss publish <slug> <file> with the current plan and progress.` The notice uses one key for each project and `updated` time. Herdr Boss sends it once, with the idle gate and the 2-hour `info` limit. A new publish ends the stale status. When the new status becomes stale, Herdr Boss sends a new notice.

`HERDR_BOSS_PUSH=0` turns off prompts for one run.

### Current guidance

The Overview shows the current guidance in a collapsed section under the page header. The section header shows one summary line, for example `Use now: free models, codex · Claude ahead of pace · 1 warning`. The line holds these parts:

- `Watch on` or `Watch until HH:MM` while a watch runs.
- The Use now lanes, in the order of the bulletin Use now line. `free models` is the open unmetered lane.
- Each metered lane that is ahead of pace, near exhaustion, or exhausted.
- The number of critical rules, warnings, and advice lines.

Select the header to open the section. It shows the watch line, one chip for each quota lane with its state and use, and the same rules as the bulletin. The browser remembers the open or closed state in its local storage. The Analytics page has the activity log.

The Overview shows its sections in this order:

1. The current guidance.
2. **Needs your decision**, when a task waits on the Owner. See [Needs your decision](#needs-your-decision).
3. **Needs attention**: the warnings and critical alerts. **Details** opens the current guidance at its rules. **Adjust policy** opens the Allocation page.
4. **Project continuity**: the prepared handovers that wait for review. When no handover waits, the section is one line under **Needs attention**, and **Needs attention** uses the full width.
5. The projects, the subscriptions, and the machine health.

## Watch

The watch says that the Owner is away. The Boss acts for the Owner until the end time of the watch, or until the Owner cancels it.

The state lives in the file `watch.json` in the data directory. The file is beside `policy.json` and `rules.json`. Its mode is `0600`. Herdr Boss reads the file once per engine tick and writes the result to `snap.night`. Herdr Boss also reads the old file name `night.json` when `watch.json` is missing.

The stored record holds these keys:

| Key | Meaning |
|---|---|
| `active` | The watch runs. |
| `since` | The ISO time at which the watch started. |
| `until` | The ISO time at which the watch ends. It is `null` for a watch until cancelled. |
| `untilCancelled` | The watch runs until the Owner stops it. |
| `reportAt` | The ISO time for the next report. It defaults to `until`. A watch until cancelled has no `reportAt` unless a daily report is set. |
| `reportDaily` | The local `HH:MM` time of a daily report. It applies to a watch until cancelled. |
| `retroAt` | The optional ISO time for the retro. |
| `by` | Who started the watch. |
| `quietHours` | Quiet hours are on. The default is `false`. |
| `noticeStartAt` | The ISO time of the start notice, for each pane that got it. |
| `noticeStopAt` | The ISO time of the end notice, for each pane that got it. |
| `reportSentAt`, `retroSentAt` | The ISO time when each report was posted. |
| `standDown` | The last stand-down of the Owner: `{ at, projects }`. Each project in `projects` is a slug and the policy mode it had before the stand-down. |

A state whose `until` time has passed reads as not active. The file stays, so the engine can read its own marks. A missing or unreadable file reads as not active. The read view of an active state is `{ active, since, until, untilCancelled, reportAt, reportDaily, by, quietHours }`. The read view of any other state is `{ active: false }`. A stored stand-down mark adds a `standDown` key to the read view. See [Stand down](#stand-down).

An active watch state also makes the Owner away. The machine limits are the same away limits as for an idle Owner. The watch changes no machine limit.

Set these worker caps in `config.json`. The old keys `night.maxWorkers`, `night.maxWorkersByLane`, and `night.quietHours` still work. A key under `watch` wins over the same key under `night`.

| Setting | Meaning | Value |
|---|---|---|
| `watch.maxWorkers` | Maximum number of working agents during the watch. | Use `null` to keep the day value. Otherwise, set an integer from 1 to 40. |
| `watch.maxWorkersByLane` | Maximum number of working agents in each provider lane during the watch. | Set `unmetered`, `codex`, `claude`, or `opencodego` to `null` or an integer from 1 to 40. Omit a lane to keep its day value. |

The watch caps apply only while the watch is active. Project shares and idle slot lending still apply under the global cap. The machine CPU and load guard limits still block worker starts during the watch.

The bulletin then shows one line under **Rules now**: `Watch until Wed 08:00 (Owner away). Work as normal; the Boss handles judgment calls.` A watch until cancelled shows `Watch until cancelled`. The time is the local end time. When `quietHours` is true, the bulletin also shows `Quiet hours: on.`

The watch worker caps also appear in the bulletin and in **Settings**. Set them there or edit `config.json`.

Quiet hours are optional and are off by default. Set `watch.quietHours` in `config.json` to choose the default for new watches. Run `herdr-boss watch start --quiet-hours` to turn them on. Run `herdr-boss watch start --no-quiet-hours` to turn them off. A value sent from the dashboard also overrides the default.

Quiet hours hold three service actions:

- Herdr Boss queues desktop notifications. It shows them once when the watch ends.
- Herdr Boss waits to release an expired manual `full-suite` lock. It still takes over a lock with a dead holder.
- Herdr Boss waits to reclaim a lease only when its TTL expires. It still reclaims a lease for a gone pane or a finished worker.

Herdr Boss starts no browser restarts of its own. A person or an agent can still request a browser restart during quiet hours.

Quiet hours do not hold pushes, deploys, gates, quota rules, worker starts, nudges, or reports. Herdr Boss writes every alert and event to `events.jsonl`.

### Watch notices

The engine sends one start notice to each orchestrator pane and to the Boss pane. It sends the notice as a direct prompt, so a working orchestrator also receives it. The notice is not a resource notice. It does not use the idle gate and it does not use the 2-hour `info` limit.

The start notice reads: `[herdr-boss] Watch until Wed 08:00. The Owner is away; the Boss acts for the Owner. Work as normal. Escalate to the Boss.` The time is the local `until` time of the stored state. A watch until cancelled reads `[herdr-boss] Watch until cancelled.` at the start.

The engine sends one end notice when the watch ends. The end notice reads: `[herdr-boss] Watch ended. The Owner rules apply again.` A pane gets the end notice only when it got the start notice.

The engine stores the send time of each notice in the record, under `noticeStartAt` or `noticeStopAt`, with the pane as the key. A restart reads those marks and sends no notice twice. A pane that joins during the watch gets the start notice at the next tick. A mark from before the `since` time belongs to an earlier watch, so it does not keep a notice from going out.

A failed send stores no mark. The next tick sends the notice again. A pane that no longer exists gets no end notice.

A stop clears the file. The engine then keeps the last active record in its own memory and sends the end notice from it.

### Watch in the dashboard

The top bar has a watch symbol, an eye, next to the chat, mail, and needs-action icons. The page has no banner, so the layout does not move when a watch starts.

- With no watch, the symbol is faded.
- While a watch runs, the symbol is clear. On a wide screen it has a small label: `until 08:00`, or `on` for a watch until cancelled. On a phone it is the icon only.
- Select the symbol to open a popover. Press `Esc` to close it. The popover shows the end time and the mode, and it has **Stop**. The page asks you to confirm a stop. A watch until cancelled also has **Stop**. With no watch, the popover links to the Agents page.

The **Agents** page has a **Watch** box at the top. The box header shows the watch state: `No watch runs` or `On watch until 08:00`. When no watch runs, the box is closed. Select the header to open it. While a watch runs, the box is open. The browser remembers the open or closed state in its local storage. The link in the popover and the link on the **Settings** page open the box. When no watch runs, the box has these controls:

- A date and time picker for the end time. The default is the next 07:30: today at 07:30 before 07:30, and tomorrow at 07:30 otherwise.
- The length of the watch in hours, next to the picker. A warning shows above 48 hours.
- **Until I cancel**. The watch then has no end time.
- **Daily report** with a time, by default 07:30. It shows only with **Until I cancel**. A watch until cancelled sends no report unless you select it.
- **Quiet hours**.
- **Start**. The button stays off while the end time is not in the future.

While a watch runs, the box has **Stop the watch**.

The dashboard uses these routes. They use the same functions as `herdr-boss watch start` and `herdr-boss watch stop`, and they keep the same time checks. The old paths `/api/night/start`, `/api/night/stop`, and `/api/night` still work.

| Route | Body | Answer |
|---|---|---|
| `POST /api/watch/start` | `{ "until": "2026-09-30T07:30:00+02:00", "quietHours": false }` or `{ "untilCancelled": true, "report": "07:30" }` | `200` with the new watch state, and a `warning` above 48 hours. |
| `POST /api/watch/stop` | `{}` | `200` with the new watch state. |
| `POST /api/watch/standdown` | `{}` | `200` with `paused` and `skipped`. |
| `POST /api/watch/standdown/undo` | `{}` | `200` with `restored`. |
| `GET /api/watch` | none | `200` with the watch state. |

See [Stand down](#stand-down) for the stand-down routes.

`until` is `HH:MM` local time, `YYYY-MM-DD HH:MM` local time, or an ISO time. An `HH:MM` value means the next such time. The end time must be in the future. A watch has no maximum length. A refused time answers `400` and keeps the stored state. A blank value uses the next 07:30. Do not send `until` with `untilCancelled`. The routes need the same access as the other dashboard write routes. The read-only preview refuses them. The start route records `by` as `dashboard`.

### Stand down

The stand-down parks the idle project orchestrators before the Owner goes offline. A stand-down changes the policy mode of a project to `paused`. It cancels no goal and starts no watch. The goal stays set in the pane, and the project resumes when the mode returns.

A paused project is skipped by the idle-orchestrator nudge, the kit reminder, and slot lending. A paused project lends all its slots.

The **Agents** page has a card **Stand down** under the **Watch** box. It has two buttons:

- **Stand down projects**. The card lists each parked project. It lists each project it left alone with its reason.
- **Resume projects**. The button shows only while a stand-down waits to be undone. The buttons use no confirm dialog. The card shows the last result.

The reasons are `worker running`, `orchestrator working`, and `already paused`. The facts are the same as the idle-orchestrator nudge: the orchestrator pane of the project and the worker panes of its workspace. The Boss workspace is never changed. A project with a reason is not parked. Select **Stand down projects** again later to park it.

The undo returns each project to the mode it had before. It restores only a project that is still paused. A project that the Owner changed in the meantime keeps its own mode. The undo clears the mark, also when it restored nothing.

Every mode change goes through the same save path as the Allocation page. The policy change log records it. See [Policy changes](#policy-changes). A project with no saved share takes a part of the shares that the other projects leave, so the saved shares keep adding up to 100. A stand-down changes no share of the Owner, so it asks for no share confirmation.

The routes are:

| Route | Body | Answer |
|---|---|---|
| `POST /api/watch/standdown` | `{}` | `200` with `{ paused: [slug], skipped: [{ slug, reason }] }`. |
| `POST /api/watch/standdown/undo` | `{}` | `200` with `{ restored: [slug] }`. |

Herdr Boss stores the time of the stand-down and the mode of each changed project in `watch.json`, under `standDown`. A second press keeps the mode of every project of the mark and adds the projects of that press. The route writes the mark after the policy save. A refused write, with the answers `400` and `409`, leaves the mark and the policy as they are. A watch start and a watch stop keep the mark, in the dashboard and in `herdr-boss watch`. The undo clears it. The read-only preview refuses both routes.

### Timed reports

Use `--report HH:MM` to set the report time. The default is the `--until` time. Use `--retro HH:MM` to set an optional retro time. Each time can also be `YYYY-MM-DD HH:MM` or an ISO timestamp. Each time must be in the future.

At each time, the service posts one report to the Owner in the Boss thread. A service restart does not post the same report again. A report does not wait for running tasks to finish.

A watch until cancelled has no report time unless you set one. Use `--report HH:MM` or the **Daily report** control. The service then posts one report every day at that time. The default time in the dashboard is 07:30.

Each report lists the tasks marked done since the watch started. It lists running tasks with their start times, and blocked tasks with the item they wait for. It also lists the worker count, each metered lane's share of recorded work time, and the notices and alerts raised during the watch. The report has at most 60 lines.

The report and its sent time stay in the message store and `watch.json`. The service keeps these records when the end time passes, so a late engine tick can still post the report.

### Watch routines

A routine is a prompt that the service sends to the Boss pane while a watch runs. The service owns the routines. A restart of the Boss pane does not stop them.

The kit holds the default routines as the files `kit/watch/*.md`. Each file starts with a front matter block: `title`, `model` (a model hint), and one schedule. `every: N` runs the routine every N minutes. `beforeEnd: HH:MM` runs it once, that long before the end of the watch. The rest of the file is the prompt text. The defaults are `Hourly check`, `Morning retrospective`, and `Morning summary and report`.

The Owner edits a routine in **Settings**, in the section **Watch routines**. The edit is saved in `watch-routines.json` in the data directory. It is a machine-level override. It never changes the kit file. **Reset to the kit text** removes the override. The Owner can also add a routine of their own.

The Watch box on the Agents page has a box for each routine, its schedule, and a text area for instructions for this watch. The box keeps the last choice of routines and schedules as the default of the next watch.

When a watch starts, the service arms the routines that are on and stores the instructions. A routine that runs before the end has no run in a watch until cancelled.

At each run time the service sends one prompt to the pane labeled `boss`: the routine text, then the instructions. The service sends the prompt only when the Boss pane is idle. If the Boss is busy, the service tries again at each tick until the next run is due. Then it skips the run and logs it. The service sends at most one routine per tick.

The service writes the state of each routine to `watch.json`. A restart repeats no routine. The Agents page shows the next run and the last run of each routine. The log has one line for each sent, waiting, and skipped run.

The start notice to the orchestrators and the Boss carries the instructions in one line.

## Quota lanes

`herdr-boss lanes` and the bulletin section "Provider lanes" show each metered provider:

- **open**: use it. A lane that is above its expected use but inside the pace tolerance shows as `on pace`, with its use, its expected use, and the tolerance.
- **ahead of pace**: a live window has a use of at least the minimum use, and its use is more than the pace tolerance above its goal-adjusted expected use. The lane shows when it is back on pace if it is not used.
- **trickle**: a window longer than 7 days is ahead of pace. The lane shows the daily allowance and today's use. You can start workers while today's use is below the allowance.
- **near exhaustion**: the quota is inside the reserve. Only `--force` can use it.
- **exhausted**: a live window is at 100% or more. The lane shows its label and reset time. Only `--force` can use it.

A provider is open only when every live, measured window is on pace and no live window is exhausted. Extra windows, such as a model-only window, do not count. A short window of 7 days or less still closes a trickle lane when it is ahead of pace. An exhausted or near-exhaustion window also closes the lane.

The bulletin and `herdr-boss lanes` show a **Use now** line before the metered lane details. The line lists open providers below pace first, from most room to least. It lists trickle providers with allowance left next, then other open providers. Each item gives a short reason. If no metered provider can take work, use an unmetered model or wait.

Herdr Boss gives a trickle lane a daily allowance. With a goal end in the future, it divides the gap to the goal percent by the days left to that end. After the goal end, it divides the unused quota percent by the days left to reset. Without a goal end, it divides the gap to the goal percent by the days left to reset. The goal percent defaults to 100%. It counts today's use from the first quota record after 00:00 UTC. After a reset, it starts from the first record after that reset. With no record for today, it counts 0% use.

The bulletin and `herdr-boss lanes` show the allowance, today's use, and the goal. The Overview quota card shows the goal in each window row. It also shows the goal in the trickle footer. Each goal uses the form `goal: 100% by Thu 8 Oct`. The text shows the time for a one-off end within 48 hours. `worker start` allows a trickle lane below its allowance. At or above the allowance, it refuses until 00:00 UTC. Use `--force` to bypass this refusal. Automatic handover can use a trickle lane below its allowance.

When several windows are ahead of pace, the lane names the worst one: the window with the most use above its goal-adjusted expected use. A window without an expected value ranks by its used percentage. When several windows are exhausted, the lane shows the one with the latest reset.

The **pace tolerance** is the number of percentage points that a window may be above its expected use and stay on pace. The default is 5. A window is ahead of pace only when its use is more than the tolerance above the expected use. A window at exactly the tolerance is on pace. A tolerance of 0 gives the strict rule. The **minimum use** is the used percent below which a window is never ahead of pace. The default is 30. A minimum use of 0 gives no minimum. A window below the minimum use is never ahead of pace. A window at or above the minimum use that will not last to its reset is ahead of pace at any tolerance, unless a timed goal end is still in the future. Set `paceTolerancePoints` (0 to 50) and `paceMinUsePercent` (0 to 100) in Settings under Provider quotas. The reserve and near-exhaustion rules do not use them.

A **quota pacing goal** is the most percent of a window that you want to use by its end. A goal without a separate end reaches its percent at reset. Herdr Boss scales the measured expected-use pace by `goal / 100` for this form. A timed goal rises from the live window start to its percent at the configured end. The line stays at that percent until reset. An unset goal means 100%, which preserves the normal pace. When a timed goal end passes, Herdr Boss uses the reset forecast to decide if a long window is ahead of pace. A goal does not change the reserve or near-exhaustion rules, which use the actual used percentage. A goal has no effect on a provider in `ignore` mode. A window whose reset time has passed starts fresh; usage does not carry across a reset.

Choose a one-off local date and time, or choose a recurring number of whole hours before reset. Herdr Boss stores a one-off time as an ISO timestamp. It deletes that whole goal when the time passes or the quota window resets. It keeps a recurring offset for later windows. A goal end must be after now, after the current window start, and no later than its reset. Runs-out advice compares the current rate with the goal percent and the goal end. The advice names the goal end when the rate reaches the goal percent before that end. `herdr-boss lanes` and the bulletin show the goal and its end while the provider is open or restricted. The Settings page shows the reset of each window in local time, for example `Sat 3 Oct, 06:58`.

The same output has one **unmetered** lane. It lists every permitted unmetered model that can start, by project and harness, after global and project exclusions. An unmetered model has no metered provider route. The lane leaves out three kinds of closed models and reports each one on a separate line with its reason:

- A model with an active free-usage retry. The line shows its retry time.
- A Pi model that Pi cannot use. Herdr Boss runs `pi --list-models` at most once every 15 minutes. Pi lists only the models that it can use. A Pi model is unavailable when the last good result does not list it. When Pi lists no row for the provider of the model, the line states that Pi has no credential for that provider. A failed run, or output without a header row, keeps the last good result. Without a good result, Herdr Boss does not hide a Pi model.
- Every unmetered model of a harness whose free lane is exhausted. The line shows the retry time, and `(reset time unknown)` when Herdr Boss uses the 1-hour default.

The lane is closed when it leaves out a model and no unmetered model remains. The bulletin, `herdr-boss lanes`, and the worker-start refusal text use the same data. They never offer a closed model as an alternative. The unmetered lane never changes least-over selection, avoid-provider rules, quota warnings, or quota accounting.

`worker start` refuses a Pi model that the last good `pi --list-models` result does not list. `--force` does not bypass this refusal, because such a worker cannot run. `worker start` also refuses an unmetered model of a harness whose free lane is exhausted. Use `--force` only for an authorized override.

When every metered provider is ahead of pace, `worker start` allows the least-over provider. A refusal or warning names the current project's unmetered alternatives first, then the least-over metered provider. A window whose reset time has passed shows "reset, not yet measured" until the next reading.

## Settings and allocation

### Setting help and page order

Each setting on the Settings page and on the Allocation page has an **i** button. A setting that repeats for each harness, provider, routine, or project has one **i** button on the section or group header. Its rows have no button. The pages show no other explanation text, except one line where a change can lock the Owner out or lose data, and the status and error lines. Select the button, or focus it and press Enter or Space, to open a popup. The popup shows what the setting does, its default, its unit, its range, the effect of a higher and a lower value, and how the change takes effect. On a desktop, hold the pointer over the button to show the same popup. Press Escape to close it. A popup stays open when the page refreshes.

The Help panel of the Settings page has a guide to each group of settings: what the group controls, what it affects, which changes are safe, and if a restart is needed. The text of the popups, the guide, and the settings reference in `docs/cli.md` comes from one file, `public/setting-help.js`. A test fails when a setting has no explanation.

The Settings page lists the most used groups first: Harnesses, Provider quotas, Machine, Watch routines, and Resource pools. The **Advanced** section holds Avatars, Token prices, Service settings, and Harness readiness. It is closed at first. The page remembers in this browser if you opened it.

The Advanced section opens by itself while a harness readiness row is not `ok` or a service settings save shows an error. Its header then shows how many items need attention.

The Settings page has one section for each harness. A harness section holds the harness availability, the preferred model, and one row for each model. Provider quota modes, quota pacing goals, and machine limits are below the harness sections. Settings shows the warning and critical quota percentages from `config.json`. The dashboard uses these values to color quota levels.

The **Service settings** table shows the values that the service uses. Each row shows whether the value comes from `config.json` or a default. The table groups rows under Machine, Quota, Status, Workers, Watch, Browsers, and Service. Set values with inputs, then select **Save** for that group. Herdr Boss writes only those values to `config.json` and applies them at once. Keep the quota warning below the critical value. The `tickSeconds` and `quotaSeconds` rows apply at once. The `tickSeconds` range is 5 to 300 seconds. The `quotaSeconds` range is 30 to 3600 seconds. The `alertCooldownSeconds` row is read-only. It is an unused legacy value. Set the notice cooldown in the Machine group. The `push` row is a switch. Herdr Boss reads `push` at service start, so the row shows `restart required`. The environment variable `HERDR_BOSS_PUSH=0` overrides the saved value. The `port`, `host`, `providerKinds`, and `orchestratorLabel` rows stay read-only. A wrong port or host can lock the Owner out of the dashboard. Provider kinds and the orchestrator label are structural. Change them in `config.json` and restart the service. The table does not show access or Roamgate settings.

### Resource pools on the Settings page

The **Resource pools** panel on the Settings page holds the same pools as the Allocation page. Each pool row shows the name, the ports, the split, the idle minutes, the wait seconds, the lease TTL, the environment variable, and the values by port. A line under the row names each variable that holds a value and the ports it covers. The row never shows a value. Select **Edit** to change the pool. Select **Remove**, then confirm the name, to remove it. Select **Add pool** to create a pool. The editor, the save, and the remove dialog are the same as on the Allocation page. See [Port leases](#port-leases) for the rules of a pool.

### Avatars

The Settings page has an **Avatars** section. It has one row for the Boss and one row for each project. A row shows the avatar, an **Upload image** control, and a **Reset** control. The image is a PNG, JPEG, or WebP file of at most 512 KB. See [Avatars](#avatars) for the rules, the storage, and the routes.

The **Harness readiness** table shows the status of each harness entry that orchestration needs. Each row shows the status, the area, and the item. The status is `ok`, `missing`, or `bad`. The table is read-only. It shows no file path and no setting value. Herdr Boss reads these entries at each service start and then every 10 minutes. Run `herdr-boss harness sync` to see the changes to make.

The model catalog is `kit/models.json`. The local policy can add model strings to one harness. Herdr Boss merges these extra models into the allow-list of that harness in worker start, handoff plan and prepare, the lanes and the bulletin, Settings, Allocation, and `herdr-boss models`. An extra model uses the launch arguments and effort rules of its harness.

Free `opencode/` models run only in the `opencode` harness. The Pi allow-list holds only `opencode-go/` models. Herdr Boss uses the `pi --list-models` result to hide a Pi model that Pi cannot use.

The Machine section saves its settings in `policy.json`. The machine guard is on by default. It is active only when it is on and its pause has expired. When it is off or paused, CPU and load thresholds do not warn or block worker starts. Memory and disk warnings stay on. Herdr Boss still shows measured CPU, load, and free disk space, the configured thresholds, and whether the Owner is present. Disk space uses the filesystem that contains the configured Herdr Boss data directory. GB means 2³⁰ bytes. The default disk warning starts below 20 GB free. The default critical alert starts below 5 GB free. Free percent is information only and displays to one decimal place. Disk worktree counts exclude the `boss` pane and the Boss workspace. Each Git repository is counted once and its notice goes to its project `orch` pane. Notices include linked and prunable worktree counts and the safe prune command. A notice sends when the disk level changes, including after recovery.

Herdr Boss reads Owner idle time from macOS `IOHIDSystem`. The default away time is 10 minutes. Missing or invalid idle data means the Owner is present. CPU is total sampled process CPU, including other processes, divided by core count. The default CPU limits are 70% while present and 95% while away. Set the away CPU limit to blank to disable it. The default 5-minute load backstops are 3 times the core count while present and 8 times while away. Set a load backstop to blank to disable it. The load average stays visible when a backstop is disabled.

Use the switch in Settings or the Overview machine summary to turn the guard on or off. Choose a duration and select **Pause guard** to pause it. The guard becomes active again when the pause expires. Select **Resume guard** to end a pause early. Settings changes stay in a draft until you select **Apply policy**. Overview guard actions save to the current policy at once. They preserve other unsaved Settings changes. `herdr-boss lanes`, the bulletin, and worker-start output show whether the guard is active, off, or paused.

When Herdr Boss loads an older policy without `machine.guardEnabled`, it checks the saved thresholds. It turns the guard off and restores the default thresholds only for the exact old off tuple: present CPU 100, away CPU blank, and both load backstops blank. It keeps the saved Owner-away time and alert cooldown. For every other old policy, it turns the guard on and keeps the saved thresholds.

The swap warning uses three settings in the Machine section: `machine.swapWarnPercent` (default 80), `machine.swapRefusePercent` (default 95), and `machine.swapMinUsedGB` (default 2). A percent is a whole number from 1 to 100, or blank to turn the rule off. The GB value is a number from 0 to 1024. Herdr Boss computes the swap percent as swap used divided by swap total. The swap total on macOS grows with use, so the warning also needs at least `swapMinUsedGB` of swap in use.

The engine raises the alert `machine:swap` with severity `warn` and the title `Swap high: N% used` when the last 3 samples are at or above `swapWarnPercent` and each has at least `swapMinUsedGB` in use. The engine takes one sample at each tick, which is every 30 seconds by default. The alert clears when swap is more than 5 points below `swapWarnPercent`, or below the GB floor. The alert does not depend on the machine guard. It stays on when the guard is off or paused. The alert never blocks a worker start or a suite. The notice cooldown applies to it.

The alert text is advice. It gives the swap percent and the GB in use. It says that macOS swap grows on demand, so a high figure alone does not mean the machine is short of memory. It says whether the swap refusal is on or off. It gives the browser rule: use at most 1 browser worker at a time while swap is above the warning level, and up to 3 otherwise. It says that one worker at a time is fine, and it asks the reader to close finished workers and their browsers. When the machine samples show it, the text ends with one line such as "Swap was above the warning level in hours 14 to 17 on 3 of the last 7 days." The line uses local hours of the day and aggregate counts only. It names an hour only when that hour was high on at least 2 days, or on 1 day when only 1 day has data.

The swap refusal is off by default. Turn it on with the switch "Refuse new work at high swap" in the Machine section. When the switch is on and swap is at or above `swapRefusePercent` with at least `swapMinUsedGB` in use, an orchestrator or a worker cannot run `worker start`, `herdr-boss suite`, or `herdr-boss push` with a pre-push hook. The message shows the swap percent and the GB in use. A blank `swapRefusePercent` switches the refusal off.

Work that the Owner or the Boss starts is never refused. Rules older than 3 minutes never refuse. To override, add `--force-swap` to `worker start`, or set `HERDR_BOSS_FORCE_SWAP=1` for `suite` and `push`. `--force` does not override the refusal. `suite --reuse` returns 0 when it reuses a passing tree.

Policy settings take precedence over legacy `config.json` values. The old `machine.loadWarnFactor` field does not control machine guards. The legacy top-level `alertCooldownSeconds` field is unused. Notice delivery reads `machine.alertCooldownSeconds`.

Clear the **Available** box of a harness to disable that harness for every project. Choose a preferred model for a harness. Worker start and handoff use it when you omit an explicit model. An empty choice uses the harness default.

Each model row has a box and a provider route. Clear the box to disable the model in that harness for every project. A model can be in more than one harness. Each harness keeps its own box and its own route for the model, so a change in one harness does not change another harness.

To add a model, type its string in the harness section and select **Add model**. A model string has 1 to 128 characters. It starts with a letter or a digit. It holds only letters, digits, dots (`.`), underscores (`_`), slashes (`/`), and hyphens (`-`). The server refuses whitespace and shell or control characters. A new model shows the **local** tag and starts unmetered. Select **Remove** to delete a local model. Remove also deletes its route, its disabled entry, its preferred-model choice, and its orchestrator succession choices.

Choose **Manage pace** to apply quota pacing for worker dispatch. Choose **Ignore quota** to stop quota pacing and pace warnings for worker dispatch. Handover risk and automatic handover still use live quota windows in every provider mode. A live window at 100% or more still exhausts the provider until its reset. Worker start refuses an exhausted provider unless you use `--force`.

Set a **quota pacing goal** for each measured window. The field shows the provider and the window label, such as `Codex Weekly goal %`. A blank field means 100%. Enter a whole percentage from 0 through 100. Select the end type and enter its value when needed. Use your local date and time for a one-off end. Enter a positive whole number of hours for a recurring end. The page checks the current time and the live window before it saves. An invalid end shows an error and keeps your draft. `pacingGoals` in `policy.json` stores the value by provider and by the window key (`primary`, `secondary`, or `tertiary`). Old integer values stay valid. Clearing the field removes that goal and restores 100%.

Choose a provider to route a model to its quota. Choose **Unmetered** to store `null`.

The provider choices depend on the harness:

| Harness | Provider choices |
| --- | --- |
| `codex` | Codex, Unmetered |
| `claude` | Claude, Unmetered |
| `opencode`, `pi` | Claude, Codex, OpenCode Go, Unmetered |

Codex uses OpenAI subscription models, and Claude uses Anthropic subscription models. The server refuses a `harnessRoutes` entry that sends a Codex model to Claude or OpenCode Go, or a Claude model to Codex or OpenCode Go. The error names the harness, the model, and the permitted choices, for example `harnessRoutes: codex/gpt-6-luna cannot use claude. Choose codex or null (unmetered).` The same rule applies to a legacy `modelProviders` route that a Codex or Claude harness inherits:

- **Load:** an incompatible legacy route never stops a policy from loading. Herdr Boss keeps the raw `modelProviders` value. It treats the model as Unmetered in that harness when no `harnessRoutes` entry overrides the route. Worker start, handoff, lanes, the bulletin, and usage records all use this unmetered result. The service log shows one warning for each such route. `policy show` and the API list these routes in the derived `ignoredRoutes` field. Herdr Boss does not store `ignoredRoutes`.
- **Settings:** the row shows **Ignored** and a note that names the ignored provider. Choose a provider in the row to store a compatible route in `harnessRoutes` for that harness. The page cannot restore the incompatible route.
- **Save:** Apply policy and `policy set` refuse a policy in which an available Codex or Claude harness inherits an incompatible legacy route without an override. The error names the harness, the model, and the permitted choices, for example `modelProviders: codex/gpt-6.1-sol inherits claude. Choose codex or null (unmetered) in harnessRoutes.codex.` A harness that is not available does not block a save. Herdr Boss finds the provider of a model in a harness in this order:

1. The route of that harness and model in `harnessRoutes`.
2. The route of the model in `modelProviders`, for all harnesses.
3. The harness rule: `codex` and `claude` use their own provider quotas.
4. The prefix rule: an `opencode-go/` model uses the OpenCode Go quota.
5. Otherwise, the model is unmetered.

`policy.json` stores the model settings in these fields:

| Field | Shape | Meaning |
| --- | --- | --- |
| `extraModels` | `{ "pi": ["vendor/model"] }` | Local model strings for each harness. |
| `disabledModels` | `{ "opencode": ["vendor/model"] }` | Models that one harness does not use. |
| `harnessRoutes` | `{ "pi": { "vendor/model": null } }` | The provider route of a model in one harness. |
| `excludedModels` | `["vendor/model"]` | Models that no harness uses. |
| `modelProviders` | `{ "vendor/model": "codex" }` | The route of a model in every harness without its own route. |

Apply policy and `policy set` remove references to models that the catalog no longer allows, and repeated entries. They prune `modelProviders`, `harnessRoutes`, `disabledModels`, `extraModels`, `excludedModels`, `preferredModels`, and project `excludedModels`. Settings shows one note after the save. The note names each removed model and the field that held it. A malformed value still stops the save and shows an error.

Old policy files can omit all of these fields and `preferredModels` and `pacingGoals`. Herdr Boss keeps `excludedModels` and `modelProviders` values. When you enable a model in one harness and `excludedModels` lists it, Settings removes it from `excludedModels` and adds it to `disabledModels` for each other harness that lists it.

Both pages keep policy edits in a draft. Select **Apply policy** to save the draft. A rejected save shows the server error and keeps the draft.

The Allocation page sets the global worker limit, workspace project status, project shares and exclusions, and orchestrator succession. The project share is advisory. `worker start` enforces the global limit and the disabled harnesses and models.

### Policy changes

Herdr Boss guards the project shares. A write of the policy that changes 3 or more project shares needs a confirmation. A write that leaves the shares at a total other than 100 needs a second confirmation. A write that changes no share needs neither.

`PUT /api/policy` refuses such a write with status 409. The error names each changed project with its old and new share and tells how to confirm. Add `"confirmed": true` to the request body to confirm a change of 3 or more shares. Add `"allowSum": true` to save a total other than 100. The two flags are separate. The server does not store them in the policy.

The Allocation page shows a dialog before it saves 3 or more changed shares, and sends `confirmed: true` after you confirm. When the total is not 100, it shows a second dialog and sends `allowSum: true` after you confirm. The Settings page saves the whole policy without a share change and needs no flag.

`herdr-boss policy set FILE` applies the same rule. Add `--confirmed` and `--allow-sum` for the two confirmations. The `project new` policy step is an internal write. It keeps the previous total of the shares, so the guard does not block it.

Every write that changes a value adds one line to `policy-changes.jsonl` in the data directory. A line holds the time (`at`), the caller kind (`caller`), and the changed keys (`changes`). A key is the dotted path of a changed value, for example `projects.herdrboss.share` or `machine.swapWarnPercent`. Each change holds the old and the new value. A list or an object shows `changed`. A string has at most 80 characters. The log shows `changed` for a key that has a token, secret, password, credential, API key, or authorization part anywhere in its dotted path. A key has at most 120 characters. A write that changes nothing adds no line.

The caller kind is `page`, `cli`, `project-new`, or `unknown`. The Allocation page and the other pages send the header `x-herdr-boss-caller: page`. The CLI sets `cli`. The `project new` policy step sets `project-new`. A write without a marker, and any other value, has the kind `unknown`. The engine writes the policy when it migrates workspace labels or clears an expired one-off pacing goal. These writes have the kind `unknown`. A client sets the header, so the caller kind is a label and not authentication. It does not prove who wrote.

The file keeps the last 500 lines and at most 256 KB. Herdr Boss trims it on each write and creates it with mode `0600`. A reader skips a line that is not valid and never fails. A line that is appended during a trim can be lost. The log is for diagnosis, not for audit. The Analytics page shows the last 100 entries in the section **Policy changes**.

Set `imageBudget` in `.herdr-boss.json` to a positive integer to set the project's screenshot budget in each worker brief. The default is 10 screenshots. The project setting overrides the kit default. Worker start appends any missing budget or copied input details when a project brief template omits those slots. Use `worker start --copy PATH` to copy a regular repository file into the worker's `.worker/inputs/` directory before the agent starts. Repeat `--copy` for each file. The command preserves repository subdirectories and refuses paths outside the repository.

The Analytics page shows a **Model scorecard** chart. Its Details table has one row for each harness and model over the last 30 days. Each row shows the runs, the first-time, rework, and failed counts, the rework rate (rework plus failed, divided by the runs), and the median run duration. The table sorts by runs. The orchestrator records the model outcome at review time with `worker collect --record --model-result first-time|rework|failed` and, for rework or failure, `--model-reason TEXT`. The orchestrator's values win over the report's `modelOutcome`. When neither is given, the result is derived: `failed` when `--outcome failed` or `--gate-failed`, `rework` when `--rework` is more than 0, otherwise `first-time`.

### Token use and spend by role

The service reads the session logs of Claude Code, Codex, Pi, and OpenCode every 5 minutes. It keeps one number for each day: the token use, split by role and by harness. A day is the local calendar day of the machine, the same day as on the machine hours. The roles are `boss`, `orchestrator`, `worker`, and `other`. The Boss and the HerdrBoss orchestrator share one Claude transcript folder, so the session ID decides between them. Read the numbers with `herdr-boss spend [--days N]` or `GET /api/spend?days=N`. The Analytics page does not show them yet.

The service reads only counts: input, output, cache read, and cache write tokens, and the model name. It never reads or keeps message text or commands. The saved scan state keeps only the role, the worker and project names for matching, and one-way hashes of the folder and the session ID. It keeps no path and no raw session ID. The token total of a day is input plus output plus cache read plus cache write. A Codex input count that includes cached input is split, so the cached tokens count once.

The service finds the role of a session in this order:

1. The session ID of a live pane. The pane label `boss` gives `boss`. An orchestrator pane gives `orchestrator`. Any other agent pane gives `worker`.
   The handover records also give `boss`. A record of a Boss handover names the session that the Boss left and the session that took over. Both sessions are `boss`, also after the pane label changed.
2. The working folder inside the worker worktree folder, or inside a `<repo>-wt-<name>` folder. It gives `worker`.
3. A working folder that only Boss panes, or only orchestrator panes, used. It gives that role.
4. The working folder of a registered project repository. It gives `orchestrator`.
5. Otherwise the role is `other`.

The cost uses two sources. Pi and OpenCode log a cost for each message, and Herdr Boss keeps that cost. Claude and Codex logs hold no cost, so Herdr Boss multiplies the tokens by the price of the model.

The cost is in USD and carries the label `API-price equivalent`. The prices are the API list prices. The Owner is on a subscription and is not billed per token, so the number shows what the same tokens cost at API prices. The label appears in `herdr-boss spend`, in `GET /api/spend` (`costLabel`), and in this guide.

The price table is `src/spend-prices.json`, in USD per million tokens. It holds the Codex prices from `kit/models.md` and the Claude API prices for `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-4-5`, `claude-fable-5-1`, and the removed models `claude-opus-5` and `claude-sonnet-5`. Each Claude entry has the columns `input`, `output`, `cacheRead`, `cacheWrite` (5 minute), and `cacheWrite1h`, a `source`, and a `date`. A model without a price is `unpriced`. The summary shows its tokens as `unpriced` and leaves them out of the cost. The next summary prices the stored history again.

A Claude transcript can split a cache write into a 5 minute part and a 1 hour part (`cache_creation`). Herdr Boss prices the 1 hour part at `cacheWrite1h`. A cache write with no split is 5 minute. The token totals do not change.

An entry can list `unconfirmed` figures. The cache figures of `claude-opus-5-5` are `unconfirmed`: the cache read of 0.20 does not match 0.1 times the input price (0.40). Herdr Boss uses the listed figure. `herdr-boss spend` names each model with an `unconfirmed` figure that it used, and `GET /api/spend` lists them in `unconfirmedPrices`.

To change a price, write an override file. `GET /api/settings/prices` returns the price table, the default table (`defaults`), the source and date of each entry, and the current override. `PUT /api/settings/prices` replaces the override with `{"models": {"claude/claude-opus-5-5": {"cacheRead": 0.4}}}`. An empty `models` object removes the override. The route accepts only models that the table lists and the fields `input`, `output`, `cacheRead`, `cacheWrite`, and `cacheWrite1h`. Each value is a number from 0 to 1000. The server rejects other input with status 400 and keeps the old file. The file is `spend-prices.override.json` in the data directory. An overridden figure is no longer `unconfirmed`. The **Token prices** section of the Settings page edits the same override. It lists each model with the five price columns, the source and date, and the `unconfirmed` marks. Select **Save prices** to save. The page shows a server error when a value is rejected. Select **Reset to defaults** to remove the override.

A scan reads at most 16 MB of new log bytes, one chunk at a time, and lets the service work between chunks. The saved byte offset of each file lets the next scan continue. A log file older than 35 days is read only when the scan state already knows it, so a resumed old file continues from its offset. A Claude message that the transcript repeats counts once, by message ID and request ID, over the last 128 messages of a file. A line longer than 4 MB is skipped. A broken line is counted and skipped. A file that shrinks is read again from the start. If a harness log has lines but none holds usage counts, the harness status is `unavailable`, and Herdr Boss does not guess. OpenCode counts come from the token columns of its database. Claude subagent transcripts in the `subagents` folders are not read.

A worker run record in `usage.jsonl` has null token fields until a log matches it. The scan matches a record to one worker log by harness, project, worker name, and start time. It takes the log whose first message is closest to the run start, and it never gives one log to two records. It then fills `inputTokens` (input plus cache write), `outputTokens`, `cachedTokens` (cache read), and `cost`, and sets `tokenSource` to `measured`. `cost` stays null when a model has no price. A record with no matching log 24 hours after the run ends gets `tokenSource` `unavailable`. The model scorecard and `usage summary` use the filled values.

Set `artifactChecks` in `.herdr-boss.json` to check generated files during worker collection. Each rule has an `artifacts` glob and a `sources` glob. For example, use `docs/gallery/**/*.png` for artifacts and `extensions/**/src/**` for sources. The patterns are repository-relative POSIX paths. `*` matches within one path segment. `**` matches zero or more path segments. Herdr Boss rejects absolute paths, parent traversal, backslashes, empty patterns, and malformed rules.

Use the workspace switches above the project shares to include or exclude a live workspace. An excluded workspace stays visible on Agents with the marker **Not a project**. It does not appear on Projects or Overview. It has no project share or worker slots. Herdr Boss stores excluded workspace labels. It resolves a saved Herdr ID to its current label when possible. A workspace with a pane labelled `boss` is excluded automatically while that pane is present. Herdr Boss removes the legacy `policy.projects.boss` entry and redistributes other project shares in the same proportions.

Each project has two share values:

- The **set share** is the share in the policy draft. The bar widths show the set share. Drag a boundary or use the arrow keys to change it.
- The **effective share** is the number of worker slots that the project has now, divided by the applied maximum of working agents. The **effective slots** are that number of slots. These values come from the applied policy. They change only after you select **Apply policy**.

The line **Total** next to the bar shows the sum of the set shares, for example `Total 99 of 100`. When the sum is below 100, the button **Distribute the remaining N** adds the remainder to the largest share. Herdr Boss adds it only when you select the button. A sum above 100 shows a warning and blocks **Apply policy**.

A project that the policy holds but the project list does not shows the line `not in the project list` with its saved share. The share is read-only, counts in the total, and no save changes it.

The form always shows the shares that the policy holds, also when their sum is not 100. A project that has no share in the policy shows the marker `default, not saved`. Its default is a part of the room that the saved shares leave. Herdr Boss writes the default only when you change that share or confirm the dialog of **Apply policy**.

**Apply policy** shows a dialog before it saves in these cases:

- The form changes more than one share and you moved more than one boundary.
- The total changes by more than 5 points.
- A project has a default share that you did not change.

The dialog lists the old and the new share of every project. A move of one boundary between two neighbors saves without a dialog.

When the policy changes on the server, for example when `project new` adds a project, the form reloads if it has no unsaved edit. If it has an unsaved edit, the page shows `The policy changed on the server. Reload the shares?` Select **Reload the shares** to discard the edit and load the saved shares.

A bar segment shows its set share and its effective slots, for example `30% · 2`. A narrow segment shows only the set share or no label. Its tooltip shows all values.

An idle project is faded in the bar and in its row. A paused project is faded and striped.

The **base slots** of a project are its set share of the global worker limit. A project always keeps its own base slots unless it is idle or paused. When **Borrow idle shares** (`borrowIdle`) is on, the projects with unused slots give capacity to the projects that use all their slots:

- An idle or paused project lends all its base slots. Its effective slots are 0 plus any borrowed slots.
- Another project keeps all its base slots. It offers its unused slots, the base slots minus its running workers, to the borrowers. The offered slots stay in its own effective slots.
- A project is a borrower when it is not idle and its running workers are equal to or more than its base slots. Herdr Boss adds the lent slots and the offered slots, and gives the sum to the borrowers by share.
- When no project is a borrower, no project lends or offers slots.


The **Locks** panel on the Agents and Allocation pages shows the machine lock lanes. The long lane has one slot. The short lane has `locks.slots - 1` slots. Each lane shows its holders, queue, and predicted durations. A holder row also shows its project, pane, kind, slot, age, time left, and state. A short job that uses the long slot is marked as borrowed. The panel shows the machine guard limits. A manual lock expires after 60 minutes. A command lock ends when its command ends. Herdr Boss takes over a stale lock. A history line shows the median hold time, median wait time, and median wait by lane for the last 7 days. Before the first lock change, it shows **No lock history yet.** A re-entrant suite under a push is not part of the medians. You cannot release a lock from this panel.

The `full-suite` machine lock uses one long lane and a short lane. The long lane holds at most one job. The short lane holds up to `slots - 1` jobs. With one slot, all jobs use the long lane. Each lane follows its own ticket order. A short job can use a free long slot only when no long job waits. A long job never uses a short slot. A suite that runs under a push keeps the push lane. A push that reuses a passed tree takes no lock.

Herdr Boss predicts a job from the median hold time of the last 10 releases for the same project, kind, and lock name in the last 14 days. It ignores takeovers, re-entrant lines, and reused pushes. A key with fewer than three releases has an unknown prediction and uses the long lane. A job uses the short lane when its predicted time is at or below the **Short job limit** setting. This setting defaults to 6 minutes.

The **Locks** group on Settings sets the machine lock slots, the short job limit, and the machine guard. The default is 2 slots. Before a short job starts beside a long holder, the guard checks the latest machine sample against its load, swap, and free-memory limits. A missing sample or one older than three minutes passes. A short job stays in its queue when a limit fails. The wait line names the failed limit and its measured value. The guard does not delay a long job and does not run when no long job holds. The default limits are 231 percent load, 96 percent swap, and 40 percent free memory. Enter a whole number in each guard field. A blank field is invalid and shows a field error. A typed zero is valid. Select **Apply policy** to apply capacity and guard changes to the next admission attempt, including queued jobs. A queued ticket keeps its prediction and short-limit classification.

Below the policy settings, the **Resource leases** panel shows each resource pool. The head of a pool shows the count of held and free items, the lease TTL, and the reclaim rule. A row for each item shows the state (Held, Idle, or Free), the holder project, the pane or worker, the lease age, the server, the listener, the idle minutes, and the time left. The server is the bound process ID, or `unbound`. The listener is `yes` when the port accepts a connection and `no` when it does not. A lease with no listener is idle and has a muted style. The idle minutes count from the last time that the port had a listener. **borrowed** marks an item of another project's split. The built-in pool `project-browsers` lists only its held ports and the count of free ports. A free item that a process listens on shows a warning row in the state **Unleased**, with the PID and the process name in the pane or worker column, the owner project, and the age. An unleased listener has no Release button: no project holds it. An invalid pool shows an error line. Select **Release** to give a lease back. The page names the pool, the item, the holder project, and the pane or worker, and asks you to confirm. The release removes the lease only while the holder project is still the project that the page shows. Otherwise the page reports that the lease changed, and you reload the page. A release never stops a process. A project browser that runs keeps its lease, so its **Release** button is disabled until you close the browser on the Browsers page.

Select **Add pool** to create a pool. Enter ports, ranges such as `8000-8009`, or items. Separate them with commas or lines. To add ports later, add a range such as `8005-8009`. Enter the project split as JSON. Set the environment variable, lease TTL, reclaim check, grace period, idle minutes, and the wait default. Add a value by port to hand a worker a variable that matches its port, for example a client ID. The value is stored in the private config file on this machine only. The page shows `set`, never the value. Select **Change** to replace a value. An empty value clears it. Keep ports 9222 to 9299 out of custom pools. Select **Edit** to change a config pool. Select **Remove**, then confirm the pool name, to remove it. A held item blocks removal and any update that drops it. A lease that is unbound and has had no listener for the idle minutes does not block: the save releases it. Herdr Boss saves the change to `config.json` and applies it at once. The built-in `project-browsers` pool has no edit or remove controls. The read-only preview refuses pool changes.

The Settings page has the same pools editor. See [Resource pools](#resource-pools-on-the-settings-page).

`worker start` prints one allocation line for the project: the running workers, the effective slots, the borrowed, lent, or free count, the global use, and the 5-minute load. When the project uses all its effective slots, `worker start` also prints an advisory notice. The notice does not stop the start.

## Orchestrator handover

When an orchestrator's quota comes near its reserve, Herdr Boss recommends a successor. The Boss pane uses the same handover path by its `boss` label. Its quota notice goes to the Owner. The Boss workspace stays out of project shares and project notices.

1. Plan the handover on the project page, or run `herdr-boss handoff plan`.
2. Prepare the successor. It starts in a new tab and only reads and reports.
3. Inspect the successor's response.
4. Confirm activation. For a project, the successor pane gets the label `orch`, and the old pane gets `orch previous`. For the Boss, the successor pane gets `boss`, and the old pane gets `boss previous`.

Without `--model`, plan and prepare use the target kind's default model in `kit/models.json`. The policy's `preferredModels` value does not replace this default. The result shows `modelSource: "default"`; a model passed with `--model` shows `modelSource: "flag"`. The model `claude-opus-5-5` and its aliases `opus`, `opus-5-5`, and `claude-opus` need the Owner's approval. Handoff uses the same case folding and bracket-suffix removal as worker start. Ask the Owner, then run `handoff plan` or `handoff prepare` with `--force`. A forced Opus prepare sends the Boss the same one-line alert as a forced Opus worker start.

Run `herdr-boss handoff cancel ID` to cancel a prepared handoff. The command marks it expired with reason `cancelled` and prints one line. It leaves the pane open when it is the source pane, its agent does not match the target kind, or its label is `orch` or `boss`. It closes an eligible successor only when its agent is idle or done; add `--force` to close a working or unsettled agent. It re-reads the record before saving so a concurrent activation or expiry is not overwritten. It refuses a handoff that is already active or expired. A cancelled handoff does not create the 30-minute expiry Mailbox item.

Activation checks that the successor agent is settled and ready. The handoff record keeps the activation time, the source pane ID, and the successor pane ID.

Herdr Boss activates a prepared automatic successor when all of these are true:

- The source orchestrator pane is `idle` or `done`. A running worker does not block activation. It keeps the project active.
- The successor pane is `idle` or `done`.
- The project is not held or stood down, and the pane is not the Boss pane.
- The successor model is not weaker than the source model.

An orchestrator that finished its turn and waits at a gate is `idle` or `done`, so it can hand over. While a prepared automatic context successor waits, the Overview shows `handover waits:` and the reason. A successor without a ready signal shows `successor not ready:` and the cause: the prepare prompt failed or stalled, the pane is absent, the pane runs another agent, the pane works, the pane has not started its state read, real text is still in its input box, the engine sent Enter and is waiting for new start evidence, or the 120-second readiness wait is not over. For automatic context records, the engine state gives the same reason in `handoverWaits`, by handoff ID.

The engine checks readiness for every prepared successor, including a manual successor when automatic handover is off. It marks the successor ready when the pane is idle or done, the prepare prompt had no error, and at least 120 seconds passed after the prompt. The engine must have seen the pane work after the prompt, or it must have evidence that the successor started. For a Claude successor, positive context usage in its session transcript is evidence. The Claude screen must also show its input prompt. A blank pane or a trust dialog is not ready. An empty input prompt with a recap and a status line can be ready. A fresh Claude pane has zero context usage. Other harnesses have no usable context signal, so the idle time is enough. A working successor is never ready. Real unsent text in the input box blocks readiness. A dim SGR 2 suggestion after the prompt mark is empty input. When the engine finds real unsent text, it sends one Enter key. It then waits at least 20 seconds before it checks readiness again. For Claude, it requires new start evidence after Enter. For another harness, a fresh idle check is enough. The engine reads the transcript tail at most once every 30 seconds while the file stays unchanged. It reads the pane input at most once every 15 seconds. Readiness sets `readyAt` only. Activate a manual successor with `herdr-boss handoff activate ID --confirmed`.

If a prepared project successor is idle or done and still unready 10 minutes after its prompt, Herdr Boss sends one prompt to the pane labeled `boss`. This notice covers project records only. A record with a failed prepare prompt gets no notice. The prompt names the handoff ID and the successor pane. It gives the commands to inspect the pane and activate the successor by hand. If the Boss pane is absent or the prompt fails, Herdr Boss retries every 5 minutes, up to 3 failures. It logs one error when it stops retrying. Herdr Boss records a successful notice, so a service restart sends no second notice.

A project successor that is still not ready 30 minutes after preparation expires. This rule applies to manual and automatic handovers. Herdr Boss sends one prompt to the Boss for that handover. The prompt names the handoff ID, the pane, and the project, and says `expired after 30 minutes unready`. This expiry creates no Owner Mailbox item. A recorded Mailbox notice from an earlier version counts as delivered. Herdr Boss also skips the notice for a record that expired more than 1 hour ago. The pane-close checks still run for those records. Herdr Boss closes the successor pane only when the pane runs the expected agent, is idle, and is not the source pane or in use by another handover. It keeps a pane that works. If the Boss prompt or the pane close fails, Herdr Boss retries that action every 5 minutes, up to 3 failures. It logs one error when it stops retrying. A ready context successor can wait up to 24 hours for activation. Another ready automatic successor can wait up to 2 hours if its source provider is no longer near its limit.

After activation, Herdr Boss finishes the handover. It waits until the successor answers the activation prompt, or until 15 minutes pass with the old pane idle. It then renames the successor tab from `Orchestrator Next` to `Orchestrator`. The rename does not wait for the old pane. Herdr Boss then closes the old pane. The status `done` counts as idle, because a `done` pane finished its turn. Herdr Boss never closes the old pane while that pane works, is blocked, or was settled for less than 60 seconds. A running worker does not keep the old pane open. It also keeps a pane whose label is not `orch previous`. The Owner closes the old Boss pane by hand; this early close applies only to project orchestrators. It retries on each tick, and it sends one line to the Boss when the old pane is still open after 60 minutes. The line names each reason. The Overview shows `closing old orchestrator at HH:MM` on the new orchestrator until the pane is closed. Herdr Boss also closes the tab of a successor that expired or was replaced without activation.

Activation labels the old pane as previous. If the early close did not run, Herdr Boss closes that pane after 120 minutes from activation when the handoff, the previous-role label, and the successor-role label are still confirmed. A newer handover does not cancel this retirement. Herdr Boss marks the older handover as superseded when the new handover starts from its successor pane and has the same role. The engine also marks older records on each active tick. It follows a chain of superseded records to the current successor before it closes a pane. Unavailable pane data defers retirement until a later tick. The current successor gets one notice after retirement.

At activation, Herdr Boss prompts the previous agent first. The prompt tells it that it no longer owns orchestration. It asks for a concise final summary for the successor. It tells the agent to answer each later request only with the successor pane ID. A Boss handover uses Boss and Owner wording. This prompt is best effort. If it fails, the engine sends it again later.

If the Owner closed the source pane before activation, Herdr Boss skips the source label and the previous-agent prompt. The record keeps `activation.sourceMissing: true`. The successor prompt says that the source pane was closed and does not ask for a final summary.

Herdr Boss then prompts the successor. The prompt gives its own pane ID, the previous pane ID, and how Herdr Boss built its session. It tells the successor to read the previous agent's final summary when it is available, to take over the current work, and to use its own pane ID in worker briefs, reports, and messages.

Herdr Boss then prompts each running worker of the project, once for each handoff. A running worker is a worker with a run record that has no `finishedAt` and a live agent pane. The prompt is one line: `Your orchestrator is now <slug>-orch (pane <new pane>). Send WORKER REPORT and WORKER QUESTION there.` Herdr Boss skips a worker whose pane is gone. A failed prompt is logged and does not fail the activation. Herdr Boss makes one attempt for each worker and handoff. It does not prompt a worker again after a failed prompt. The record field `workerPrompts` keeps the result for each worker. Herdr Boss saves the record before it sends each prompt. A Boss handover prompts no worker.

After activation, the engine sends handover notices:

- A project handover notifies each agent worker in the project workspace and the active pane labeled `boss` in any workspace.
- A Boss handover notifies each agent in the Boss workspace and sends the Owner a Herdr notification with the new Boss pane ID.

Agent prompts need push to be on. A prompt goes only to an idle or done agent pane. A successful notice is recorded and is not sent again. A recipient that is unavailable or fails stays eligible, and the engine tries it again after one minute.

Herdr Boss sends handover notices only for active records. A superseded record sends no new notice. Herdr Boss records the Boss notice once for each handover. A change to the Boss pane does not send the notice again. Herdr Boss also treats an earlier notice key for a Boss pane as delivered.

Preparation waits up to 90 seconds for the new pane's foreground shell and a prompt or a stable screen before Herdr Boss starts the agent. Ordinary `worker start` keeps its 20-second readiness wait. If agent start reports `agent_pane_busy`, Herdr Boss checks shell readiness again and retries once. If the pane shows an interactive question, answer it in a shell once, then retry `handoff prepare`. The new tab disables update prompts and automatic updates. Each active engine tick expires a `prepared`, `preparing`, or `needs-inspection` record when a successful current pane list does not contain its successor pane. `handoff prepare` repeats this check before retrying. A failed pane list keeps the record active. A missing successor pane is not closed. The 30-minute timeout for a project successor that is not ready uses the separate rule above.

If a `needs-inspection` record still has a pane in the current Herdr pane list, repeat `handoff prepare` for the same source pane, target kind, and mode. Herdr Boss waits for that pane to become ready and starts the successor there. It keeps the existing handoff record and pane. If the pane does not become ready, the record stays `needs-inspection` and the command reports the readiness error. If a successful current pane list proves that the pane is absent, the record expires and prepare can create a new successor.

Migration moves the conversation history with [session-migrate](https://github.com/xhluca/session-migrate). It does not move credentials, hooks, or runtime settings. If migration is unavailable or transfer fails, Herdr Boss prepares a fresh successor and records the reason.

A migrated session must fit the context window of the target model. The plan converts the session into a temporary directory, measures its `.jsonl` files, and deletes the directory. It estimates one token for each 4 bytes. The session fits when the estimate is at most 60% of the target window. The limit leaves space for the successor's own work. When the session does not fit, the plan marks migration as unavailable and names the estimate and the limit. The project page then shows `Migration unavailable:` with that text. Preparation uses fresh mode and records the same text as the reason. The successor prompt at activation includes the reason. When the measurement fails twice, or when the target model has no window, migration stays available and the plan shows a warning.

The window of a model is in `kit/models.json`. The `contextTokens` field of a kind gives the window in tokens for all models of that kind. The `contextTokensByModel` object gives the window for one model and overrides `contextTokens`. Both fields are optional. Each value must be a positive integer.

Herdr Boss copies the optional Owner goal from the latest published project status into the handoff record and successor prompt. The goal must be a non-empty string of at most 1000 characters. An invalid published goal is omitted, and preparation continues without it. It does not assign a project goal to a Boss handoff. For a fresh successor, Herdr Boss captures at most 200 recent lines and stores at most 20,000 characters from the source pane. Both caps include the truncation marker. It redacts likely credentials. If the recent read fails, it tries the visible pane. If both reads fail, the record says that context is unavailable. The prompt labels this snapshot as historical context. The successor only reads and reports until activation.

**Automatic handover** is off by default. Turn it on in Allocation, and rank the successor choices under **Orchestrator succession**. Herdr Boss then prepares a successor at the reserve, waits for it to run `herdr-boss handoff ready`, and activates it at the set quota level (98% by default). An automatic successor that was not needed expires two hours after preparation when its source provider is no longer near its limit.

Herdr Boss recommends the first succession choice that can start, preferring a non-Opus choice when one is eligible. The dashboard and the automatic handover use the same choice. Herdr Boss skips a choice in these conditions:

- The choice uses the harness or the provider of the current orchestrator.
- The harness or the model is not allowed, or the project excludes it.
- The metered provider of the model is near its limit or exhausted.
- The unmetered model is exhausted until its retry time.
- The harness free lane is exhausted, and the model is unmetered. The choice becomes available again at the retry time of the lane.
- The choice is a Pi model that the last good `pi --list-models` result does not list. Without a good result, Herdr Boss does not skip a Pi model.

If Opus is the only eligible choice, automatic handover does not prepare it. The engine sends the Boss one notice for that handover key. The notice says that Owner approval is needed and gives the `herdr-boss handoff prepare PANE --to claude --model claude-opus-5-5 --force` command.

When no choice can start, Herdr Boss recommends no successor. The automatic handover then logs that no alternative provider is eligible.

The automatic handover never touches the Boss. It prepares and activates no Boss successor, and it activates no prepared Boss record. The Owner does each Boss handover by hand. The Boss project page keeps its successor recommendation.

The Overview lists only handover records in the state `prepared`, `preparing`, or `needs-inspection`. It lists a record only when the source pane and the successor pane are still in Herdr. It shows no recommendation without a record, and no Boss recommendation. Plan a handover without a record on the project page.

The automatic handover prepares a successor only for a project that works now. A project qualifies when its allocation reports a running worker, or when a pane in its workspace runs an agent in a `working` state. A workspace with no working agent and no running worker waits. A stopped orchestrator in a workspace with a working worker stays eligible.

The automatic handover also skips a project that the Owner holds. A project is held when its published status is `paused`, `stood down`, or `on hold`, or when its published summary says that it is paused or stood down. A status or summary in another case, spacing, or hyphen variant counts as the same word. A summary that reports the state of another project, or of one task, does not hold its own project. An allocation mode of `paused` holds the project.

The automatic handover activates a prepared successor only when the successor model is not weaker than the source model. The tiers follow the cost order in `kit/models.md`, from the free models up to Codex Astra. A model the kit does not rank has no tier. When either model has no tier, or the successor is weaker, Herdr Boss leaves the record prepared and logs one line that names the reason. The Owner then runs `herdr-boss handoff activate ID --confirmed` when the weaker model is the right choice.

The automatic handover has a second trigger, the context size. It runs only when `autoHandover` is on. Set the limit in Settings as **Hand over at context tokens**, or in `policy.json` as `autoHandoverContextTokens`. The default is 300000 tokens. The value is an integer from 50000 to 2000000.

A handover carries the Owner goal to the successor. Set the goal for an orchestrator with no goal in Settings as **Default orchestrator goal**, or in `policy.json` as `defaultOrchestratorGoal`. The value is one line of at most 4000 characters. An empty value turns the default off. The handover record and the project page show the goal as one collapsed line.

A task boundary starts the check. A boundary is one of these events:

- A task in the published project status changes to `done`.
- The orchestrator pane goes from `working` to `idle` or `done` after a new publish.

At a boundary, Herdr Boss reads the context size of the orchestrator. When the size is above the limit, Herdr Boss prepares a fresh successor from `docs/orchestration/memory.md`. The successor has the same harness and the same model as the source. The successor reports ready with `herdr-boss handoff ready`. If the successor does not report, Herdr Boss applies the automatic ready rule above after 120 seconds. The record then shows `readyNote: auto: successor idle`. Herdr Boss activates the successor when the source pane is `idle` or `done`. If the source pane works, Herdr Boss waits.

Herdr Boss reads the context size only for a Claude orchestrator. It takes the last main-thread assistant message in the session transcript in `~/.claude/projects/`. The size is the sum of `input_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens` of that message. For another harness, or when the transcript is missing, the context size is unavailable. Herdr Boss then logs one line and starts no context handover.

When a Claude orchestrator reaches 400000 tokens and no prepared handover is ready, Herdr Boss raises a warning with the key `context:<project>`. The title gives the rounded size, for example `Context at 400K tokens: handover not ready`. The warning stays active while the context is at least 400000 tokens and no handover is ready. Herdr Boss sends the warning no more than once in 60 minutes. It clears when the context falls below 400000 tokens or a handover activates.

Herdr Boss watches a pane from its first tick. A pane that Herdr Boss sees for the first time is unarmed: a task that was already done, or a pane that was already idle, is not a boundary. An idle orchestrator whose project has no running worker and no working agent waits. The check runs after work starts again and the next boundary arrives.

The context trigger uses the same rules as the quota trigger. It skips the Boss, a held project, and a project that does not work. It activates no successor with a weaker or unranked model tier. It prepares no second successor while a record for the same pane is `prepared`, `preparing`, or `needs-inspection`.

### Set the goal of a running orchestrator

Use **Set goal** to give a running orchestrator a new `/goal`. A `/goal` that arrives while the agent works is queued as plain text and does not run. Herdr Boss therefore waits until the pane is idle.

1. Open the project page or the Agents page. Find the orchestrator of the project.
2. Select **Set goal**. A dialog opens with the text field. The field starts with the **Default orchestrator goal** from Settings. Edit the text if you need to. The limit is 2000 characters.
3. Read the warning. The command waits until the pane of the orchestrator is idle. The wait can take up to 10 minutes.
4. Select **Set goal** in the dialog. The dialog closes and the status line under the goal shows the progress.

The status line shows `Waiting for an idle pane`, `Sending the command`, `Checking that the pane shows the goal`, `Goal active`, or `Goal not set` with the reason. The line above it shows the current goal in one collapsed line. Select it to read the whole goal.

Herdr Boss sends nothing while the agent works, a dialog is open, or the input box holds typed text. A dim suggestion in the input box does not block the command. The status line shows the current reason: `the agent works`, `a dialog is on screen`, `the input box holds unsent text`, `the pane is not an orchestrator`, or `the pane is gone`. Herdr Boss never clears or edits the input box.

The wait ends after 10 minutes for `the agent works`, and after 2 minutes for `the input box holds unsent text` and `a dialog is on screen`. The job then fails with `Goal not set` and the reason. Herdr Boss adds one Mailbox item that asks you to send or clear the draft, or answer the dialog. It adds at most one item for each project and reason in one hour. Select **Set goal** again after you act. If the pane does not show the goal after 3 tries, the job fails with `sent but not shown`. Look at the pane.

**Cancel** in the status line stops a job that still waits. After a restart of the service, a job that was running shows `Interrupted`. Select **Set goal** to start it again. If the session expired, the line shows `Sign in again`.

Herdr Boss allows **Set goal** for a project that is paused or stood down. You can prepare the goal before the project runs again.

Herdr Boss counts the goal as active only when its text is new on the screen after the send, and the pane shows the goal confirmation or is idle with an empty input line. A goal that is only typed or queued in the input line does not count. An old identical `/goal` in the scrollback does not count.

The command line does the same: `herdr-boss goal set <project|pane> [--text TEXT] [--dry-run]`. See `docs/cli.md`.

## Project browsers

Each project can have one persistent Chrome profile. Request it with `herdr-boss browser request SLUG`, or open it from the Browsers page. Herdr Boss assigns a port from 9223 to 9299.

- Give each worker its own tab. `browser tab new` opens a tab in its own window, so it stays visible in a headless browser.
- A website or identity provider decides how long a login lasts. Sign in through the dashboard when a login is needed.
- Herdr Boss never stops a browser that it did not start. Each project uses only its own browser.

### Port leases

Each project browser port is a lease in the built-in resource pool `project-browsers`. The pool has the ports 9223 to 9299. Port 9222 is not in the pool, and no pool leases it.

- The holder of the lease is the project. The lease has no pane, no worker, and no TTL.
- `browser request` leases the recorded port of the project. When the project has no record, it leases the lowest free port. It skips a port that the record of another project uses and a port that has a listener.
- When another project holds the recorded port, `browser request` leases a new port and writes it to the record.
- `browser close` keeps the lease.
- `herdr-boss browser release SLUG` removes the lease. It refuses while the project Chrome runs. The record stays.
- `browser-sessions.json` keeps the profile, the window size, the headless mode, the PID, the code-sign clone, the bookmarks, and the start page of each project. The lease keeps only the port.

Herdr Boss reclaims a project browser lease when no Chrome process has the port flag and the profile path of the project on two service ticks in a row. A "not responding" browser still has its process, so Herdr Boss does not reclaim its lease. When the process list fails on a tick, that tick does not count. A reclaim closes no browser and changes no record. The next `browser request` leases the recorded port again when it is free.

The Browsers page shows the leased port and the CDP address `http://127.0.0.1:PORT` on each browser card, with a link to the lease row on the Allocation page. The card shows the lease even when the leased port differs from the recorded port. Release the lease on the Allocation page. A project browser that runs keeps its lease until you close the browser.

At its first acting tick, the service writes one lease for each browser record, with the recorded port. It logs one `lease` event for each project. It does this one time for each data directory, and it changes no port.

### Browser states

Herdr Boss shows one state for each project browser:

| State | Meaning |
|---|---|
| ready | Chrome runs with the project port and profile. `GET /json/version` on the port returns HTTP 200 with JSON within 2 seconds. |
| not responding | Chrome runs with the project port and profile, and one of two conditions holds. Either `GET /json/version` does not answer within 2 seconds, or two CDP probes in a row failed. |
| offline | No Chrome process runs with the project port and profile. |
| port conflict | Another process uses the port. Herdr Boss does not touch it. |

A "not responding" browser shows the label **Not responding**, the reason, and a **Restart** button on its card. It also shows **Restart** and **Close browser** under **Manage**. It has no preview. The bulletin shows the same state and the reason for agents.

#### CDP probe

`GET /json/version` can answer while the browser serves no tab. The service therefore runs a CDP probe on each project browser that Herdr Boss started. The probe has four steps:

1. Send `Browser.getVersion`.
2. Send `Target.getTargets`.
3. Open a blank background tab with `Target.createTarget` and `background: true`.
4. Run `Runtime.evaluate` with `1+1` in that tab. The result must be `2`.

Each step has a limit of 3 seconds. The four steps together have a limit of 8 seconds. The cleanup adds up to 6 seconds: 2 seconds to wait for a late `createTarget` answer, 2 seconds for `Target.closeTarget`, and 2 seconds for the HTTP close. A probe therefore takes at most 14 seconds. The probe always closes the blank tab, also after a failure or a timeout. It also closes a socket that opens after a timeout. The probe never navigates, captures, focuses, or closes another tab.

The probe records the ID of its blank tab. `browser tabs`, the preview grid, and the tab counts hide that tab. Herdr Boss drops a record when the tab closes, or after 10 minutes. When the blank tab does not close, the service writes one `browser` event to the log: `The probe tab ID on port PORT did not close.`

The service runs at most one probe for each browser in 60 seconds. It never runs two probes of one browser at the same time. It runs no probe for a closed browser, for a browser that Herdr Boss did not start, for a browser that started less than 120 seconds ago, or in the read-only preview.

One failed probe changes nothing. Two failed probes in a row mark the browser `not responding`. One successful probe clears the mark. The engine state and `GET /api/browser-sessions` show `notResponding`, `probeAt` (time of the last probe), and `probeReason`. The reason is one of these phrases:

| Reason | Meaning |
|---|---|
| `getVersion timed out` or `getVersion failed` | The browser control socket did not answer, or refused the connection. |
| `getTargets timed out` or `getTargets failed` | The browser did not list its tabs. |
| `createTarget timed out` or `createTarget failed` | The browser did not open the blank tab. |
| `evaluate did not return` or `evaluate failed` | The blank tab did not run the script. |
| `evaluate returned a wrong value` | The script result was not `2`. |

When a browser turns `not responding`, the service sends one notice to the orchestrator of the project: `Your project browser is not responding. Run herdr-boss browser restart SLUG --headless, then continue.` The notice names the current mode of the browser (`--headless` or `--visible`). The notice ends when the browser answers again. A later change to `not responding` sends a new notice.

Herdr Boss never restarts a browser by itself. The **Restart** button on the card calls the route `POST /api/browser-sessions/restart` in the current mode, without reopening the current page. It exists only for a browser that Herdr Boss started. The CLI command `herdr-boss browser restart` keeps its rule: only a pane of the project or the Boss can run it.

To recover a "not responding" browser, use **Restart** or **Close browser** on the Browsers page. The CLI commands are `herdr-boss browser restart SLUG --headless|--visible` and `herdr-boss browser close SLUG`. A restart of a "not responding" browser does not reopen the current page. A restart also skips the page restore when the browser cannot list its pages.

Close works as follows:

1. Herdr Boss sends the CDP command `Browser.close` to a responsive browser.
2. If the browser is not responding, or `Browser.close` fails, Herdr Boss sends SIGTERM to the Chrome main process. This process has both `--remote-debugging-port=PORT` and `--user-data-dir=PROFILE` and no `--type=` flag.
3. Herdr Boss waits up to 8 seconds for the process to exit.
4. If the process does not exit, the close fails with a "did not exit" error. Herdr Boss never sends SIGKILL. Inspect the process before you relaunch the browser.
5. After a SIGTERM close, Herdr Boss deletes the code-sign clone of that launch. The next section describes the clone.

Herdr Boss never sends a signal to a process that does not match both the port and the profile.

### Chrome code-sign clones

Google Chrome on macOS copies its app bundle to a code-sign clone of about 720 MB at each launch. The clones are in `$(getconf DARWIN_USER_TEMP_DIR)/../X/com.google.Chrome.code_sign_clone/`. Each clone is a folder `code_sign_clone.XXXXXX`. Chrome deletes its clone only at a clean shutdown with the CDP command `Browser.close`. A signal, a crash, or `playwright-cli close` leaves the clone on the disk.

- At a launch, Herdr Boss records the new clone folder in the session as `codeSignClone`. It records `null` when no new clone or more than one new clone appears.
- After a SIGTERM close, Herdr Boss deletes the recorded clone. After a `Browser.close`, Chrome deletes the clone.
- Every 10 minutes, the service deletes orphaned clones. The dashboard preview does not delete clones.

A clone is orphaned when all these conditions are true:

- It is a real folder, not a symbolic link, directly in the clone folder. Its name matches `code_sign_clone.` followed by letters and digits.
- It was created more than 1 hour ago.
- No running Google Chrome main process started within 5 seconds of the clone creation time. This rule keeps the clone of each running Chrome.

Herdr Boss reads the process list with `ps -axo pid=,lstart=,comm=`. If the read fails, it deletes nothing. The sweep never sends a signal to a process. Each sweep that deletes clones adds one event with the count and the freed space. The freed space is the change in free disk space, because a clone shares disk blocks with the app. Set `browsers.sweepCodeSignClones` to `false` to stop the sweep. Run `herdr-boss browser sweep-clones --dry-run` to list the orphaned clones.

Herdr Boss uses the clone folder only when `HOME` is the home folder of the account. A process with a temporary `HOME`, such as a test, finds no clone folder.

On the Browsers page, **Show preview** captures a screenshot of the selected tab. The preview shows a still image until the next capture. **Live** refreshes it at the interval that you select.

Select the screenshot to open the large view. The large view shows the last capture as a still image. Turn on **Control browser** to refresh the large view at the selected interval and to send clicks and keys. Turn off **Control browser** to stop that refresh. **Live** continues to refresh while it is on. The status shows **Live** while a refresh repeats and **Captured** at other times. In **All tabs** mode, **Control browser** is not available.

### Address box and tab close

The first focus of the address box selects all its text. The first click and the first tap also select all its text. A second click places a normal cursor. The box uses one flag for each focus, so it does not select all again while it keeps the focus.

Each tab row in the one-tab list and each tile in the All tabs grid has a **Close tab** control. The control removes one tab. It never stops the browser process, and the browser keeps running.

Before it closes a tab that an agent holds, the page asks the Owner to confirm: "Tab <title> belongs to <agent>. Close it anyway?" Only after Yes does the page send `force: true`. Before it closes the last tab, the page warns the Owner that the browser keeps running with no page.

The page uses `POST /api/browser-sessions/tab-close` with the body `{ project, tabId }`, and the optional field `force`. The route refuses an unknown project and a missing tab. The read-only preview refuses every change. The CLI command is `herdr-boss browser tab close SLUG --tab ID`.

### Bookmarks and the start page

Each browser card has a **Bookmarks** list. The list holds at most 30 bookmarks for the project. A bookmark name has at most 60 characters. A bookmark URL must use `http` or `https`. It must not hold a user name or a password. Herdr Boss refuses such a URL with "Bookmarks must not hold credentials."

- **Add current page** saves the URL and title of the selected tab. When the browser has one tab, it uses that tab.
- **Open** loads the bookmark in the current tab. **New tab** opens the bookmark in a new tab of its own window.
- **Rename** shows a small form in the row. The arrows move the bookmark up or down. **Delete** asks the Owner to confirm.
- **Start page** is the page that opens in the first tab of the next launch. **Save** stores it. A blank value clears it. A running browser does not change.

The page uses `GET /api/browser-sessions/bookmarks?project=SLUG` and `POST /api/browser-sessions/bookmarks` with `{ project, action }`. The action is `add`, `rename`, `move`, `remove`, or `start`. The route refuses an unknown open project, a bad URL, and a bad index. The read-only preview refuses every change. The CLI commands are `herdr-boss browser bookmarks SLUG list|add NAME URL|rm INDEX|open INDEX [--new-tab]|start URL|none`.

The bookmarks and the start page stay in the project record in `browser-sessions.json`. Herdr Boss never stores them in a repository.

Agent commands and tab rules are in [the browser service](../kit/browser-service.md).

## Board page

The Board page, `/board`, shows the tasks of all projects on one kanban. It uses the same task states and colors as the board on each project page. See [Live task state](#live-task-state). A project shows on the Board when it publishes at least one task.

### Columns

| Column | Tasks |
|---|---|
| Blocked | A task that waits on a task that is not done, on the Owner, on the Boss, or on an external item. |
| Ready | A task whose dependencies are all done. |
| Doing | A task with a live worker, or a task published as `doing`. The longest-running worker comes first. |
| Review | A task whose worker finished or was collected and whose branch is not merged. |
| Done · 24 h | The tasks with an `updated` time in the last 24 hours, newest first. A done task without a valid `updated` time does not show. |

Blocked, Ready, and Review keep the project order and, in a project, the order of the project board.

### Cards

A card shows the project name and avatar, the task ID, the title, and the worker with its model. A Doing card also shows the elapsed time. A Blocked card shows what the task waits on: the ID and the title of each open blocker, or the Owner, the Boss, or an external item with the `ask`. A card on the critical path of its project shows **path**.

Select a card to open `/projects/SLUG?task=ID`. The project page selects the task, shows its card on the board, and centers it in the dependency graph. Select a blocker to open that task the same way. Select the project name to open the project page. On a phone the project name on a card is not a link. Use the project chips to show one project.

### Summary strip

The strip at the top shows the number of tasks in each column. The counts use the project, kind, and search filters. Select a count to show only that column. Select it again to show all columns. **Needs the Owner** shows the number of open Mailbox items that need the Owner. Select it to open the Mailbox at **Needs you**.

Each project has one bar. The bar shows the tasks of the project in each state, in the column colors, on one scale for all projects. Select a bar to show only that project. Select it again to show all projects.

### Filters and grouping

| Control | Effect |
|---|---|
| Search | Shows the tasks whose project, ID, title, ask, worker name, or model holds each search word. Press `/` to go to the search. |
| Project | Shows one project. |
| Kind | Shows the tasks that wait for the Owner, the tasks with a worker, or the tasks of one worker harness or one model. |
| State | Shows one column. |
| By project | Shows one swimlane for each project. Select the swimlane title to close or open it. |
| One board | Shows all projects in one set of columns. |
| Clear filters | Removes the search and all filters. |

The page stores the grouping, the filters, and the closed swimlanes in the browser, in `localStorage` under `herdr-boss.board`. It does not store the search.

### Refresh

The page updates in place with a keyed patch, the same as the project page. A refresh keeps the scroll position, the focus, and the search text. When a refresh moves a card to another column, the focus moves with the card.

### Phone

On a screen up to 760 px wide, the Board shows one column at a time. A tab bar shows each column with its count. Select a tab or swipe sideways to change the column. The first column with work opens, in the order Doing, Ready, Blocked, Review, Done. A row of project chips replaces the swimlanes and the project filter. Select a chip to show one project. Select **All** to show all projects. The grouping switch, the state filter, and the per-project bars do not show on a phone.

## Analytics page

The Analytics page (`/analytics`) shows figures and charts. It answers these questions:

- What does the fleet cost each day, by role and by harness?
- Does the quota use of each lane stay at or below its expected pace?
- How often is each model right the first time?
- Which causes of denials and permission prompts occur, for which harness?
- When do the machine load and the lock waits slow work down?
- How many notices does each pane get?
- Who changed the policy, and which keys changed?

### Headline strip

The strip at the top has six tiles. Each tile shows one figure, a detail line, and a change where the data has one.

- **Claude spend a day**: the mean Claude spend of the last 7 days, split by role, with the change on the 7 days before.
- **Quota against pace**: the lane with the most use above its pace line, in percentage points.
- **Denials this week**: the 7-day count. The trend compares the last 24 hours with the 6-day mean.
- **Notices per pane a day**: the 7-day mean for each pane that got a notice, and the value of today.
- **Lock wait and hold**: the median wait and the median hold of the lock acquires in the last 7 days.
- **First-time success**: the first-time runs divided by the judged runs of the last 30 days.

### Charts

Each chart has a title that tells what to read from it, a scope line, a legend, and an axis. Hover, focus, or touch a column, a cell, or a row to read its values in a tooltip. **Details** under each chart opens the table of the same figures. The page remembers the open Details until the page reloads.

- **Spend**: stacked bars for each day of the last 14 days. The switch splits the bars by role or by harness. The source is `/api/spend`. The USD figure is the API-price equivalent. The Owner pays a subscription, not these amounts. When no model in the window has a price, the chart shows tokens.
- **Quota**: one solid line for the use of each lane and one dashed line for its expected pace, in the weekly window, one column for each hour. The source is the quota trend of `/api/usage`.
- **Model scorecard**: one bar for each of the 8 models with the most runs. The bar shows the share of first-time, rework, failed, and not judged runs. The right column shows the runs and the median time. Details also holds the recorded work by project and provider and the recent runs.
- **Denials**: one stacked bar for each day. The range is 3 days by default. The buttons select 7 or 30 days, and the browser remembers the choice. The switch selects one harness or all harnesses. See [Denials per day](#denials-per-day).
- **Lock wait and hold by project**: one stacked bar for each day of the last 7 days. The lower part is hold time. The upper parts show wait time in the long and short lanes. The chart shows the median wait for each lane. The switch selects one project by its slug or all projects. **Details** shows each day's wait by lane and lists the wait, hold, runs, and timeouts for each project. A row without a lane counts as long. A run that reused a suite pass, and a suite run inside a push, add no time. The chart source is the last 2 MB of `lock-ledger.jsonl`. The card also shows full-suite slot capacity from saved policy and machine-wide slot use from the latest usable machine sample. A sample older than three minutes shows unknown use. The project filter does not change the machine scope of slot use. The prediction table shows each project and kind. Predictions use the same last 10 qualifying releases within 14 days as admission, including the rotated ledger. Fewer than three releases shows unknown. The historical short-job baseline is a follow-up.
- **Machine load and lock waits**: lines for the 5-minute load as a percent of the cores, the memory in use, and the swap in use, over the last 24 hours in columns of 10 minutes. A shaded column had a lock holder. The strip under the lines shows the minutes in which a suite request waited.
- **Machine overload and idle waiting by hour**: see [Machine samples](#machine-samples).
- **Notices per pane**: stacked bars for each day of the last 7 days. The five panes with the most notices have their own color. The other panes share one gray.
- **Policy changes**: a list of the last writes of `policy.json`, newest first. A row shows the time, the caller kind, and the changed keys with the old and the new value. A row has at least 44 px height on a phone. **Details** holds one table row for each changed key of the last 100 writes. The section shows an empty state until the first write. See [Policy changes](#policy-changes).

The charts use one color set for light mode and one for dark mode. The set passes the dataviz palette validator. The charts show no client name or path. They show harness, model, cause, lock kind, and pane ID only. Two sections are the exception: the keys of Policy changes and the lock chart name projects by their slug. On a screen up to 1180 px wide the charts are in one column. On a phone each chart scrolls sideways inside its own box.

The route `/api/analytics` gives the notice counts, the machine timeline, the wait and hold of the locks for each project and day, the denial counts of the last 30 days for each day, the harness change markers of those days, and the last 100 policy changes. It reads the last 2 MB of `events.jsonl` and of `lock-ledger.jsonl`, the machine samples of the last 25 hours, `denials.json`, `harness-changes.jsonl`, and `policy-changes.jsonl`. It keeps the result for 60 seconds. The result holds numbers, lock kinds, pane IDs, the marker labels, and the policy change keys with scalar values.

### Activity log

The last section of the page is the activity log. It lists prompts sent to orchestrators, notices, handovers, errors, and stopped processes, newest first. The first line tells whether Herdr Boss sends notices to orchestrators.

- Filter by kind, project, level, and time range. The level is the severity of a notice, or `error` for an error event.
- Type in the search box to match the text, the kind, the pane, or the project.
- **Details** holds the raw log: all kept events without filters, one line each.

The log shows the events that the state keeps: the last 60. The old address `/logs` opens this section. The old address `/logs#guidance` opens the guidance section of the Overview.

## Project status pages

Orchestrators do not build dashboards. They publish a status file. Herdr Boss shows it on `/projects/SLUG`. The page shows a board of the tasks. With the optional work structure fields, the page also shows progress, the current frontier, a dependency graph, groups, specs, and all work. See [project-status.md](project-status.md).

### Page order

The project page puts the sections in the order of use:

1. The header: the name, the Owner goal, the summary, the phases, and the updated time.
2. **Now**: what needs the Owner or can act now.
3. The plan and progress: metrics, overall progress and the frontier, the board, the dependency graph, groups, specs, and human gates and risks.
4. History: all work, notes, and links.
5. **Details**: settings and reference information, in closed cards.

### Now

The first line of the Now section is the orchestrator line. It shows the harness, the pane, and the state of the orchestrator. Select it to open the handover form. When a handover is needed or prepared, the full **Project continuity** section replaces the line.

Below the line, small cards sit in a grid of one, two, or three columns:

- **Needs your decision**: the open tasks that wait on the Owner.
- **Status issues**: status file errors, a stale status (the age, or the reason when a live worker runs a task that is not doing), a stale board, AGENTS.md drift, and a required kit update.
- **Running now**: the used and total worker slots, and each worker with its harness, state, elapsed time, and task.
- **Waiting to merge**: the tasks in Review, and uncommitted changes from the published `git` field. The card also shows `N unpushed commits` and `M unmerged branches` when the count is above 0. Herdr Boss reads both counts from the project repository at most once a minute. Unpushed commits are the commits of the current branch that are not on its upstream. A branch without an upstream has 0. Unmerged branches are the local branches that are not merged into the base branch. The base branch itself does not count. Herdr Boss shows a count only as a number. If git does not answer, the count does not show.
- **Next task**: the first Ready task in board order, the number of other Ready tasks, and the number of blocked tasks.

A card without content does not show. Select a task in a card to select it on the board and in the graph.

### Project details

The **Details** section is the last section of the project page. It holds closed cards: **Files and kit**, **Worker config**, **Agents and panes**, and **Browser and leases**. The card header shows a short summary, for example the kit state or the number of agents. On a desktop the cards sit two to a row. The browser remembers the open or closed state of each card for each project in its local storage.

**Browser and leases** shows the project browser port and state and the resource leases of the project. It is read-only. Use the Browsers page and the Allocation page to change them.

Publish at task boundaries: a task starts, a task ends, a blocker appears, or a blocker clears. `herdr-boss publish` keeps the newest 30 done tasks in the stored status. It counts the older done tasks in `doneCount`. The orchestrator keeps its own file unchanged. The project data holds `doneCount`. The overall progress on the project page adds `doneCount` to the done tasks and to all tasks.

### Live task state

The published status file holds the plan. The worker run records hold what happens. Herdr Boss overlays the run records on the published tasks, so the state of a task does not wait for a publish. The service reads the run records of each registered project every 15 seconds. A worker links to a task through `taskId` in its run record. Start each worker with `worker start --task-id ID`. `--issue N` works as an alias for a numeric task ID. A live worker without a task ID, or with an ID missing from the status, appears in `unplanned`. Without either flag, `worker start` prints `No --task-id: the project board shows this worker as Unplanned work.` and continues. It suggests one task when at least two lower-case words match its ID or title, or when the task text contains an exact ID. With `--task-file`, it matches the file name. A dry run prints the same warning and suggestion.

The project data shows the current status, task states, and agents. `GET /api/projects` refreshes the project data from the latest engine snapshot. It rereads worker run records at least every 15 seconds. The request does not start a process to collect agents. `GET /api/state` returns the same project fields.

The project data has `publishedAt` and age in minutes. `publishedAgeMin` is the age of the status file. `phaseAgeMin` uses `phaseUpdated` or the newest `tasks[].updated` time. `summaryAgeMin` uses `summaryUpdated`. When a status has no time for one field, that age equals `publishedAgeMin`.

Each live worker that has no task ID, or whose task ID is missing from the status, appears in `unplanned`. Each item shows its name, kind, model, start time, age, and pane. It does not show the worker brief or path.

The `sync` object compares working agents with Doing cards. `agentsWorking` counts the working agents in the project's workspace, including the orchestrator. `liveWorkers` counts live worker runs. `doingCards` counts tasks whose effective state is `doing`. `unplanned` and `noWorker` count their matching fields. `mismatches` adds the task mismatch count, unplanned workers, and no-worker cards. `inSync` is false when agents work but no card is Doing, or when an unplanned worker or a no-worker card exists. `text` gives these counts on one line.

The project page shows `status published N min ago`. The badge is amber when `statusStale.level` is `warn`. The phase and summary lines show the age of their data. The sync line uses `sync.text` and is amber when `sync.inSync` is false. The page refreshes from live state events. It keeps the scroll position, focus, and open Board column.

A task with published status `doing` stays in Doing when it has no run record. After 30 minutes, it has `noWorker: true` and `noWorkerSinceMin`. A task whose workers failed or went away still returns to Ready or Blocked. `statusStale.level` is `warn` when the status is more than 30 minutes old and a worker run or the orchestrator is active. It is `ok` when the status is 30 minutes old or less, or when neither is active. Project data and the status notice use this shared freshness rule.

Each task gets one effective state, `state`:

1. A published `done` task stays `done`.
2. A worker whose branch is merged makes the task `done`. A branch counts as merged, also for a worker that was not collected, when its run record has `mergedAt`. A branch also counts as merged when the run record has `baseCommit`, the branch has at least one commit beyond the base commit and its tip is in the base branch. A branch with no new commit, a deleted branch, and the base branch itself do not count. The orchestrator publishes `done` for such a task.
3. A live worker makes the task `doing`. The source is `live from worker NAME`. A worker is live when its run record has no `finishedAt` and no `collectedAt`, and its pane is in the pane list.
4. A collected worker with outcome `done` whose branch is not merged makes the task `review`. A recorded `worker collect` sets `collectedAt`, `finishedAt`, and the outcome. `worker collect --no-record` sets none of these fields. A collected run with outcome `done` has phase `review`. A collected run with any other outcome has phase `failed`. A collected run never has phase `abandoned`.
5. A finished worker with no collect record makes the task `review`. The source is `finished, not collected (worker NAME)`. The task stays in Review while it waits for the orchestrator. It does not return to `ready`.
   A worker is finished when all of these are true: its pane is gone, its run record has no `finishedAt` and no `collectedAt`, and `report.json` says the work is done.
   The worker is merged, not finished, when its branch is merged. Herdr Boss checks the merge only for a worker with a done report.
6. A worker whose pane is gone and whose report says `stoppedEarly: true`, or a status or outcome of `blocked`, `failed`, or `partial`, is failed.
   A worker whose pane is gone, without a usable report, `finishedAt`, or `collectedAt`, is abandoned.
   A failed, partial, or abandoned worker gives no state. When the task is published as `doing` and all its workers failed or are gone, the task is open again: it is `ready`, or `blocked` when a dependency is not done. Any other published status applies.
7. A task that is `todo`, `ready`, or `blocked` without `waitingOn` has the state `blocked` while a task in `blockedBy` is not done. `blockers` names these tasks. A `blockedBy` ID that is not in the status counts as not done. A published `waitingOn` also gives `blocked`, and the reason names the Owner, the Boss, a task, or an external item. A dependency never changes a `done` task, a `doing` task, or a `review` task.
8. The same task has the state `ready` when all its dependencies are done.

When more than one worker runs on a task, the latest live worker decides first. Without a live worker, the latest finished, collected, or merged worker decides. Herdr Boss ignores a finished, collected, or abandoned run that is older than 14 days.

The service checks at most 5 branches for a merge in each read of the run records and keeps each answer. A merged answer stays. A not-merged answer is used again for 60 seconds.

The board is stale, `boardStale: true`, when one of these is true:

- An active worker runs a task that is not `doing` in the published status, more than 5 minutes after the worker started. A task that is not in the status also counts. A worker is active when its agent status is `working` or `blocked`, it is not parked, and it has no `report.json`. An idle worker, a parked worker, and a worker that reported done wait for the orchestrator.
- The published status is older than `staleStatusMinutes` (default 120 minutes), a worker worked after the publish and within the last 2 hours, or new commits landed after the publish.

`boardStaleReason` names the cause. While a worker runs or the orchestrator works, Herdr Boss sends a status notice when `statusStale.level` is `warn`. The notice says `Status published N min ago. Publish the current plan with herdr-boss publish <slug> <file>.` It sends at most one notice per hour for each project. `herdr-boss publish` refuses a status in which a task has an active worker but is not `doing`. Use `--force` to publish anyway. The commands are in [cli.md](cli.md).

### Board

The board shows each task in one column of the flow. The column comes from the effective state, `state`. A status without `state` gets the same rules in the page.

| Column | Tasks |
|---|---|
| Blocked | A task that waits on a task that is not done, on the Owner, on the Boss, or on an external item. |
| Ready | A task whose dependencies are all done. |
| Doing | A task with a live worker, or a task published as `doing`. |
| Review | A task whose worker finished or was collected and whose branch is not merged. |
| Done | The last 10 done tasks by `updated`. **Show all N done** shows the rest. |

Each card shows the task ID, the title, what the task waits on, and the worker. A Blocked card names each open blocker. The blocker ID is a link that selects that task. A blocker that is not in the status shows as **ID (outside)**. A Blocked card always shows a reason. When `waitingOn` is `task` and no blocker is open, the card says **a task that the status does not name**. When the status gives no reason, the card says **a reason that the status does not state**. A wait on the Owner links to the Mailbox conversation when the task has `mailboxId`. A Doing card shows the worker, the model, the elapsed time, and the source, for example `live from worker NAME`. A task with `noWorker: true` shows an amber **No worker** badge. A Review card shows the worker and the source.

The Doing column also shows one **Unplanned work** card for each live worker without a matching task. Each card shows the worker name, kind, model, and age.

Ready sorts by priority. The tasks on the critical path come first, then the tasks in the published group order, then the tasks in the published order. Doing puts the longest-running worker first.

When `boardStale` is true, the board shows a **stale** mark and `boardStaleReason`.

The next milestone is the first group in `groups[]` that has an open task. The critical path is the longest chain of open tasks that ends in that milestone. Without groups, the chain can end in any open task. When two chains have the same length, the chain whose last task comes first in the status wins. A card on the path shows **critical path**.

The board and the dependency graph use the same states and the same colors. Each state has a label next to its color. The colors pass a check for color-vision separation in the light and the dark theme.

Select a card title to select the task. The card gets a ring. The graph marks the task and its dependency chain: all tasks that it waits on and all tasks that wait on it. The other tasks fade. Select a graph box to select its task and go to its card. Select the selected task again to clear the selection.

The page updates the board and the graph in place. A refresh keeps the selection, the scroll position, the phone column, and the graph zoom. The page matches each card and each graph box by its task ID. When a refresh moves a card to another column, the focus moves with the card.

On a phone, the board shows one column at a time. A tab bar above the board shows each column with its count. Select a tab or swipe sideways to change the column. The first column with work opens, in the order Doing, Ready, Blocked, Review, Done. The board section is open by default.

A link to `/projects/SLUG#board` or `/projects/SLUG#dependencies` opens the page at that section. A link to `/projects/SLUG?task=ID` opens the page with that task selected, shows its card on the board, and centers it in the graph. The page then removes `task` from the address. A link to a published project opens it also when its workspace is closed.

### Files

The **Files and kit** card in Details is read-only. It names three paths:

- The project memory file: `<repository>/docs/orchestration/memory.md`.
- The installed kit file: `<repository>/docs/orchestration/herdr-boss.md`.
- The Boss memory file: `~/.herdr-boss/boss-memory.md`.

The card shows the kit revision in the project status file next to the current kit revision. A required kit update also shows in the Now section. The home folder shows as `~`. The page shows paths only. It never shows the contents of a memory or kit file.

### Worker config

The **Worker config** card in Details is read-only. It shows the non-secret fields that Herdr Boss read from `.herdr-boss.json` in the project repository:

- `slug`, `baseBranch`, `worktreeRoot`, and `worktreeName`.
- `evidenceTiers`, `allowedModels`, `workerPanesPerTab`, and `imageBudget`.
- `setup`, `setupTimeoutSeconds`, `agentStartTimeoutMs`, and `testThreadsFlag`.

A field that the file sets has a **config** tag. The other fields use the default value. The `setup` command shows as `set` or `not set`. A `worktreeRoot` path in the home folder shows as `~`. A project with an invalid `.herdr-boss.json` shows the read error in place of the fields.

The engine reads the config at each service start and every 10 minutes. Change a field in `.herdr-boss.json` in the repository. The card changes after the next read.

### Needs your decision

A task can name the party that holds it with `waitingOn`: `owner`, `boss`, `task`, or `external`. The project page shows a **Needs your decision** card first in the Now section. The group lists each open task that waits on the Owner with its ID, title, ask, and a link to its Mailbox conversation. Each project card shows the count. The Overview shows the total with a link to each group.

A task that waits on other tasks shows **waiting on #ID** in place of the plain **Blocked** label. A task that waits on the Boss or an external party shows that party and the ask. The orchestrator sets `ask` when it waits on the Owner or the Boss, and sets `mailboxId` to the ID of the Mailbox item. See [project-status.md](project-status.md).

### Graph view

The dependency graph draws the open tasks and the done tasks that block them directly. Clear **Open work only** to draw every task. A task without links sits in the first column, after the linked tasks. Each box names its task ID and its state. A box on the critical path says **path**, and an orange line joins the path. Select a box to select its task. The issue link is on the card.

Use the toolbar above the graph:

- **Fit** shows the whole graph in the panel. Until you zoom or pan, the graph fits the panel. A wide graph starts at its left edge at 85% zoom, so the text stays readable.
- **−** and **+** zoom out and in. **100%** shows the graph at its natural size.
- **Full size** fills the window. Select **Close** or press Escape to return.

Press Ctrl or Cmd and turn the mouse wheel to zoom around the pointer. A plain wheel scrolls the page. Drag the background with the mouse to pan. A drag on a task box does not pan. The page remembers the zoom and the pan of each project during the session.

On a phone, the graph has its natural size and scrolls sideways in its own box. Only **Full size** shows in the toolbar.

For a visual check, add `?theme=light` or `?theme=dark` to a dashboard address. The page then uses that theme and ignores the system setting.

The project page shows `status published N min ago`. The badge is amber when the server marks the status stale. The Projects list shows `Status stale: <age>` when a stale status has been marked. The mark stays until the orchestrator publishes again. See [Rules and notices](#rules-and-notices) for the stale rule.

## Agents page

The `/agents` page has two views. The switch at the top of the page selects the **Chart** view or the **List** view. Chart is the default. The URL holds the view as `?view=chart` or `?view=list`. The browser keeps the last choice in its local storage. If the browser cannot store the choice, the page opens Chart at the next load. A link to the old `/organization` route opens the Chart view.

### Chart view

The Chart view shows the organization as a chart. The chart has four levels:

1. The **Owner** node shows **At the Mac** or **Away**. The value comes from the machine idle time.
2. The **Boss** node shows the pane labeled `boss`, its harness, state, quota use, and handover state. It also shows the avatar of the Boss. The workers in the Boss workspace are below it.
3. Each **project** node shows the orchestrator pane, harness, and state. It also shows the avatar of the project, the current task, the worker slots in use against the slots and share, and the handover state. The nodes use the project order.
4. Each **worker** node shows the agent name, harness, state, and task ID.

Select **Details** on a node to show its recorded values. Select **Messages** on the Boss node or on a project node to open its thread. The page cannot change resources. See [Owner messages](#owner-messages).

### Chart style

The switch at the top of the page selects the **Plain** or the **Cards** style. Plain is the default. The browser keeps the choice in its local storage. If the browser cannot store the choice, the page uses Plain at the next load.

In the Cards style, each agent node is a card with a harness mark: Claude, Codex, OpenCode, Pi, or a question mark for an unknown harness. A Codex or Claude node shows a thin bar with the quota use. The card border shows the state:

- **working**: a slow pulse on the border.
- **blocked**: the warning color and a warning icon.
- **failed**: the error color.
- **idle** or **done**: a dimmed card.

In the Cards style, a new event draws a short line with a moving dot between two nodes for about 1 second:

- An Owner message event (type `message`) draws a line from the Owner to the Boss or to the project orchestrator.
- A worker report notice (type `push`, title "Worker NAME wrote its report", sent only when the worker sent no `WORKER REPORT` prompt) draws a line from the worker to its orchestrator.

The page reads only the events that the state already holds. It does not poll for more. At the first view of the page, it shows no old events. When the system asks for reduced motion (`prefers-reduced-motion: reduce`), the page shows a 1-second highlight on the two nodes and no movement.

### Phone layout

At phone width, the chart has one column in both styles. Each worker list shows a count button, for example **Show 3 workers**. Select it to expand the workers. Select **Hide 3 workers** to collapse them. The buttons on the page and in the Messages panel are at least 44 px high. The Messages panel fills the screen.

The page uses only the state that the dashboard already loads. These limits apply:

- The page shows **Not reported** when the state does not hold a value.
- Herdr Boss does not receive the model of a running agent. The page does not use a preferred model as the model of an agent.
- The current task is the first published task with status `doing`. The worker task is the open published task whose `worker` field names that agent. The page does not read a task from a pane title.
- Quota use shows only for a Codex or Claude harness, because each of these harnesses uses only its own subscription.
- A **reserve** node shows a prepared successor only when a prepared handoff record names the current orchestrator or Boss pane as its source and the successor pane is live. A recommended successor does not show as a reserve.
- A workspace marked not a project has no project node. The Boss workspace shows as the Boss node.
- The chart shows no pane output and no secrets. Message text shows only in the Messages panel.

### List view

The List view shows every Herdr workspace with its orchestrator and workers, live from Herdr.

A status dot shows working, blocked, failed, idle, or done. Failed means that the last visible worker output matched a known provider error, including **Free usage exceeded**. Herdr Boss reads only the last eight visible lines: on every tick while a worker is working, and when a worker first appears idle or done or changes into either state. A worker can show failed while Herdr still reports it working; the engine then does not count it as a running worker. The failed status clears when a later read shows no known failure, or when a different worker uses the pane. Herdr Boss sends the matched error label, worker name, and pane ID to the project orchestrator. Blocked workers get a notice after five minutes. Idle and done agents are ready for input; they have not always finished their task. Rows with the **orch** or **boss** label are orchestrators.

An orchestrator that stays idle gets a nudge when its published status still has an actionable task: status **todo**, **doing**, or **review** with every task in its **blocked by** list done. The project must be in **auto** or **active** mode, no other worker in that workspace may work, be blocked, or have failed, and the idle period must reach the configured idle minutes. The notice names the task ID and title. Resume an idle or done worker on that task, or start suitable work. One key per project and task keeps the normal notice cooldown in charge; a different next task prompts again.

## Owner messages

The Owner can send a message to the Boss or to a project orchestrator from the Agents page. The Boss and the orchestrators reply with `herdr-boss say`. Workers get no messages from the Owner. Send a worker request to its orchestrator.

### Threads

Each node has one thread. The thread `boss` holds the messages between the Owner and the Boss. The thread of a project has the project slug as its name. A thread holds the messages in both directions, oldest first. Messages to an orchestrator go directly to it. The Boss can read each thread with `herdr-boss messages THREAD`.

### Send a message

1. Open the Agents page.
2. Select **Messages** on the Boss node or on a project node.
3. Type a message of 1 to 2000 characters, and select **Send**. Or select a nudge button or **Ask for status**.
4. Confirm the send in the browser dialog.

The nudge buttons send one of these fixed texts: "Continue.", "Use your free worker slots.", or "Pause after the current task." **Ask for status** sends "Send a short status report with herdr-boss say, and publish your status file."

The panel reads the thread again every 10 seconds while it is open. The page shows each message and each report as safe Markdown. See [Markdown in messages](#markdown-in-messages).

### Markdown in messages

The message panel, the Mailbox, and the Chat show message text as Markdown. The renderer is `public/markdown.js`. It has no dependencies. The page shows these parts:

- Headings `#` to `######`. A heading shows one level smaller in a message, so `#` shows as a third-level heading.
- Paragraphs. A single line break is a space. Two spaces or `\` at the end of a line make a line break.
- Bold (`**text**`), italic (`*text*`), strikethrough (`~~text~~`), and inline code (`` `code` ``). An underscore inside a word is text, for example `snake_case`.
- Bullet lists, numbered lists, and task lists (`- [ ]` and `- [x]`). Indent a line by 2 or more spaces to nest a list.
- Tables with a header row and an alignment row. A table scrolls sideways in its own box. A column that holds only numbers is right-aligned.
- Fenced code blocks with three backticks or three tildes. A code block scrolls sideways.
- Block quotes with `>`, and horizontal rules with `---`.
- Links `[text](url)`, `<url>`, and bare `https://` addresses. An external link opens in a new tab.

These safety rules apply:

- Raw HTML shows as text. The page runs no script from a message.
- A link must use `http:`, `https:`, `mailto:`, a local path that starts with `/`, or `#`. The page shows other links, for example `javascript:` or `data:`, as text without a link.
- The page removes each element and attribute that is not on the renderer allowlist.
- The renderer reads at most 200 KB of a message. Nesting deeper than 8 levels shows as text.

### Delivery

A new Owner message has the status `queued`. The service sends queued messages on its acting ticks. These rules apply:

- The service sends only to the pane labeled `boss` for the `boss` thread, or to the `orch` pane of the project.
- The service sends when the agent is `working`, `idle`, or `done`.
- A blocked, unknown, or missing pane keeps the message queued. A message waits if the pane has no agent or its label does not match.
- The service sends at most one message to a pane in one tick. A pane that got a resource notice in the same tick waits for the next tick.
- The prompt is `[owner] TEXT (Reply with: herdr-boss say --reply-to ID "<answer>")`. An answer to a mailbox item has this form: `[owner] Answer to ITEM-ID (ITEM-TITLE): ANSWER`. The quoted question follows. Each line starts with `> `. The quote has at most 400 characters, cut on a character boundary, and holds no control character. A line separator in the question becomes a line break inside the quote. The reply hint is the last line. The title of a report is its title. The title of a reply is its first line. If the question is no longer in the store, the prompt is `[owner] Answer to ITEM-ID: ANSWER (Reply with: ...)`. The Boss thread uses the same form.
- After delivery, the status is `sent` and `sentAt` holds the time. The thread shows `delivered HH:MM`.
- After a Herdr error, the status is `failed` with a short error. The service tries again on later ticks, up to 3 more times.
- The thread and Mailbox show `queued`, `delivered HH:MM`, `failed: REASON`, or `relayed by the Boss HH:MM`.
- They add `replied HH:MM` when a reply names the Owner message ID in `replyTo`.
- The Boss can mark queued messages as relayed with `herdr-boss messages relay ID... --by boss`. Only the `boss` pane can run this command. It sets `status` to `relayed`, and records `relayedAt` and `relayedBy`. The service never sends a relayed message.
- The service writes one `message` event to `events.jsonl` for each send or failure. The event holds the message ID, the thread, the kind, and the pane. It does not hold the text.

A read-only preview shows the threads. It refuses a send with HTTP 403 and delivers nothing.

### Answers stay in the Mailbox

A conversation that starts in the Mailbox stays in the Mailbox. An Owner message with `replyTo` set is an answer to a mail item when its parent record is in the same thread and is on the mail channel (`mail` or `both`). The page shows it in the conversation of that item, below the question, with the time and the delivery state. The Chat does not list it. The Chat shows no row, no unread count, and no preview for it. The rule uses `replyTo`, not the thread name. An Owner message that names a plain chat reply stays in the Chat, and it does not close that reply. An Owner message whose parent record is no longer in the store also stays in the Chat.

The rule applies when the page reads the records. A migration is not needed. An answer that an earlier version filed as a chat message shows in the Mailbox conversation after the update. The stored records do not change.

### Replies and reports

An orchestrator or the Boss replies with `herdr-boss say --reply-to ID "TEXT"`. The Boss can post a longer Markdown report with `herdr-boss mail post --to owner FILE`, for example a morning handback. The Boss can close open Mailbox items as answered through the Boss with `herdr-boss mail close ID... --note TEXT`. It records the note and sends no message. A reply and a report have the status `new`. Set `--action answer`, `--action approve`, or `--action decide` only when the Owner must act. Everything else is information; omit `--action`. See [the CLI reference](cli.md#owner-messages) for the caller checks and the limits.

### Store

By default, the service keeps messages in `messages.jsonl` in the data directory. The default backend is `json`. To use SQLite, set this value in `config.json`:

```json
{
  "store": {
    "messages": "sqlite"
  }
}
```

When the SQLite message table is empty, Herdr Boss imports records from `messages.jsonl`. It keeps that file. The database is `herdr-boss.db`. It uses write-ahead logging and mode 0600 for the database and its WAL files. With SQLite, Herdr Boss checks the database when it starts. If the check fails, restore a backup or import the JSON file again. Use `herdr-boss store import messages` to import once. Use `herdr-boss store export messages` to write JSONL for a downgrade. Each command prints the number of records.

The review packs and the SQLite message store share one database schema. Each schema change is a migration. A migration that adds a column first checks that the column is missing, so a repeated run is safe. A migration that is pending on the live database runs only from the main checkout, the source tree of the service. The main checkout is the root with a `.git` directory. A linked worktree has a `.git` file. Another source tree, such as a worker worktree, stops with the error `This source tree cannot migrate the live database. Run it from the main checkout or use a temporary HERDR_BOSS_DIR.` Such a tree can still read a database that is at the schema version of its code. A temporary data directory migrates from any source tree.

Each line in `messages.jsonl` is one JSON record with these fields:

| Field | Value |
|---|---|
| `id` | The message ID, for example `m-mg3k2x1a-1f2e3d4c`. |
| `at` | The time of the record. |
| `thread` | `boss` or a project slug. |
| `from`, `to` | `owner`, `boss`, or `orch`. |
| `kind` | `message`, `nudge`, `status-request`, `reply`, or `report`. |
| `text` | The message text. A report holds the Markdown text. |
| `title` | The report title. Only a report has it. |
| `action` | `answer`, `approve`, `decide`, `read`, or `null`. |
| `replyTo` | The ID of the message that a reply answers, or `null`. |
| `status` | `queued`, `sent`, `failed`, or `relayed` for an Owner message. `new` for a reply or a report. |
| `sentAt`, `error`, `attempts` | The delivery time, the last delivery error, and the number of send attempts of an Owner message. |
| `relayedAt`, `relayedBy` | The relay time and the role that relayed the message. Both fields are set by the Boss relay command. |
| `readAt` | The time that the Owner opened a mailbox item. A new item does not have this field. |
| `closedAt`, `dismissed` | The close time and whether the Owner dismissed the item without an answer. |
| `closedBy`, `closeNote` | The party that closed an item without an Owner answer, and its note. `closedBy` is `boss` (the Boss's note), `project` (`resolved by the project`), or `owner` (`answered elsewhere`). |
| `closeSuggestionDismissedAt` | The time that the Owner selected **Keep open** on the close suggestion. The suggestion does not show again for this item. |
| `repliedAt` | The API view adds the time of the first reply that names this Owner message ID. It is not stored on the message. |

The JSON backend appends each new record as one line. It rewrites a changed file through a temporary file and a rename. Each write deletes records that are older than 30 days. A lock file `messages.jsonl.lock` keeps writers from writing at the same time. The SQLite backend stores each record as JSON text in one database row. It uses a transaction for each change and keeps the same 30-day retention and message order.

### Limits and safety

- Only a loopback request or an authenticated remote session can send. The same-origin check of the other `POST` routes applies.
- The service accepts at most 10 Owner messages a minute across all threads. It refuses more with HTTP 429.
- `say`, `mail post`, and `mail close` refuse text that looks like a token, a key, or a password.

## Mailbox

The Mailbox page at `/mailbox` is the inbox of the Owner. It lists replies from `herdr-boss say`, reports from `herdr-boss mail post`, and messages that the Owner sent. The page fills the window. On a phone it is a full-screen app view. See [Phone app view](#phone-app-view).

### Folders

The folders are **Needs you**, **Inbox**, **Reports and updates**, and **Done**. **Sent** is below a divider. On a desktop the folder rail is on the left, with **New message** at the top. On a phone the folders are in the menu drawer. Each folder shows its count. The folder pane shows a read-only line with the limits: the retention and the send limit. The folder pane shows on a desktop. The page keeps the selected folder in the address and in browser storage. When Needs you has open items, it is the default folder. When it has no items and you have selected another folder before, the page restores that folder. Otherwise, Needs you is the default folder.

- **Needs you** shows open items with action `answer`, `approve`, or `decide`, newest first. When this folder is empty, the page shows “Nothing needs you.” and a link to the Inbox.
- **Inbox** shows the open Needs-you items and the unread information items, newest first. The list has two sections: Needs you first, then Reports and updates. A read information item is not in the Inbox. `GET /api/mailbox?folder=inbox` returns the items.
- **Reports and updates** shows unread items with action `read` or no action. The folder key stays `updates`, so `/mailbox?folder=updates` links keep working. Opening an item, or marking it read, sets `readAt` and `closedAt` together, and the item moves to Done. An existing `closedAt` stays. The view also lists an old read information item without `closedAt` as Done. The count shows the unread items. A read `decide`, `approve`, or `answer` item stays in Needs you until you answer or dismiss it.
- **Done** shows read information items, closed or dismissed items, and messages that the Boss relayed.
- **Sent** shows Owner messages. Each row shows the recipient, the delivery state, and the time of a reply, when one exists.

### Rows

The list has one row for each conversation. A conversation is one thread and one `replyTo` chain. The row shows the newest item of the conversation in the folder. On a phone the row has two lines. Line 1 holds the avatar, the project name or `Boss`, the message count when the conversation has more than one item, and the action tag: **Approve**, **Answer**, **Decide**, or **Report**. Line 2 holds the subject and a one-line preview. The time and an unread dot sit on the right. An unread row shows the name, the subject, and the time in bold. On a wide desktop list without an open conversation, each row is one 44 px line. The time is `HH:MM` for today, `Yesterday`, a weekday for the last 6 days, or the day and the month.

Select a row to open its conversation. The conversation shows Owner and agent messages in time order. The answer of the Owner to an item is in the conversation of that item, with its time and its delivery state. Each message and each report shows as safe Markdown, with the same renderer as the message panel and the Chat. See [Markdown in messages](#markdown-in-messages). Opening an item sets `readAt` on the record. On a desktop the conversation opens at the right of the list, and the list keeps its position. On a phone the conversation fills the screen. Select the Back arrow to return to the list.

### Answer an item

| Action | Controls | Text sent |
|---|---|---|
| `answer` | A text field and **Send**. | The typed text. |
| `approve` | **Approve**, **Reject**, and an optional note. | `Approved.` or `Rejected.`, then the note. |
| `decide` | A text field and **Send**. Choice buttons when the text has a Markdown list under a `Choices` heading. | `Choice: CHOICE`, then the note. Or the typed text. |

The page asks for a confirmation before each send or dismissal. The answer is an Owner message to the thread of the item, with `replyTo` set to the item ID. It uses the same delivery rules and rate limit as a message from the Agents page. The service then sets `closedAt` on the item, and the item moves to **Done**. A closed item refuses a second answer with HTTP 409.

Select **New message** to start a thread with the Boss or a project that has an `orch` pane. Type a message and confirm the send. The page applies the same send limit and safety gates as other Owner messages. It opens the new thread in **Sent**. Use the reply box at the bottom of a conversation to reply to its last open agent message. When that message is an open answer, approve, or decide item, the item form replaces the reply box. The page asks you to confirm each reply.

### Close an item without an answer

An open Needs-you item closes in three ways without an Owner answer in the Mailbox.

1. The project closes it. Herdr Boss closes a linked item only through its linked task (`mailboxId`). It closes the item when that task is done or no longer waits on the Owner. It also checks the previous status and closes the item when that task is absent from a new status that has at least one task. A status with no tasks closes no items. An item that no task links to stays open, at no age. Each item that the Boss posts stays open until you answer it or someone closes it. Herdr Boss does not close review items, Boss-thread items, items from the Boss, or items that are already closed. The project sets `closedBy: project` and uses the note `resolved by the project`. Only a publish for the project that owns the item closes it. A failed Mailbox update does not fail the publish.
2. The Owner closes it. Select **Close as answered elsewhere** on the item. The button is in the conversation, in the list row (check-mark button), and in the bar at the bottom edge on a phone. The item gets `closedBy: owner` and the note `answered elsewhere`. It moves to **Done** and shows `Closed as answered elsewhere`. The page asks for no confirmation and sends no message.
3. The page suggests it. When you write a chat message to the same thread after the item arrived, the item shows **Close this item?** with two buttons: **Close as answered elsewhere** and **Keep open**. **Keep open** stores `closeSuggestionDismissedAt` on the item, so the suggestion stays away on every device. The suggestion does not show for a closed or answered item.

Select one or more checkboxes under **Needs you**, then select **Dismiss selected**. On a phone, select **Dismiss N** in the selection bar. A check box selects all items of its conversation. Select **Dismiss** on one item to dismiss it alone. Dismissal sets `closedAt`, `readAt`, and `dismissed: true`. It sends no message. You cannot dismiss an item that is already closed or does not need action.

The choices are the list items under a Markdown heading with the text `Choices`, for example `## Choices`. The list ends at the first line that is not a list item. The page shows at most 10 choices.

### Automatic refresh

The page reads new data every 30 seconds and on each state event. It changes only the parts of the page that changed. Each row, conversation, chat, and bubble has a key (`data-key`), and `public/keyed.js` keeps the DOM node of each key. The page keeps the open conversation, the selection, the typed text, the focus, and the caret. It keeps the scroll position of the list and of the conversation. A new folder or a new conversation starts at the top.

The refresh waits while you type or scroll. It runs 3 seconds after your last input or scroll. The Chat page uses the same rule.

### Unread count and the top-bar icons

The `needsYouUnread` count is the open Needs-you items that the Owner has not opened. The number comes from `needsYouUnread` in the `mailbox` field in `/api/state`.

The top bar shows three icons on a desktop and on a phone. Each icon has a count. The menu has no Mailbox entry and no Chat entry. The icons open the Chat and the Mailbox. The icon of the open page has `aria-current="page"` and a mark: Chat on the Chat, Updates on the Mailbox folder Updates, and Needs action on the Mailbox folder Needs you. On a phone the Mailbox, the Chat, and the Reviews hide the top bar. Their slim bar shows the same three icons at the right of the page title, with the same counts, faded state, names, and current mark. The icons open the Chat and the Mailbox in one tap. Each icon is 44 px wide and 44 px high on a phone. Four targets of 44 px fit in a width of 320 px.

| Icon | Count | Field in `mailbox` | Link |
|---|---|---|---|
| Chat | chat records to the Owner with no `readAt` | `chatUnread` | `/chat` |
| Mail | unread mail records | `mailUnread` | `/mailbox?folder=updates` |
| Needs action | open action items | `needsAction` | `/mailbox?folder=needs-you` |

An icon with nothing to show is faded. It has opacity 0.35 and no badge. An icon with something to show has opacity 1 and a badge with the count. Its `aria-label` holds the count. The Needs-action icon uses the warning color. It is the most visible of the three.

### API

| Route | Action |
|---|---|
| `GET /api/messages?thread=THREAD` | Return the thread. Owner messages include delivery fields and `repliedAt`. |
| `GET /api/mailbox` | Return `{ needsYou, updates, done, mailbox }`. Each item has the record fields, `action`, `choices`, `ownerMessage`, and `answer`. |
| `GET /api/mailbox?folder=FOLDER` | Return the folder lists, unread Updates count, delivery state, and mailbox counts. `FOLDER` is `needs-you`, `updates`, `sent`, or `done`. |
| `GET /api/mailbox?thread=THREAD` | Return the conversations in a Boss or project thread. |
| `GET /api/mailbox?thread=THREAD&conversation=ID` | Return the messages in one conversation, oldest first. |
| `POST /api/messages/read` | Set `readAt` on the items in `{ "ids": [...] }`, 1 to 200 IDs. Add `"close": true` to close items with the action `read`. |
| `POST /api/messages/dismiss` | Dismiss 1 to 200 open Needs-you items in `{ "ids": [...] }`. It sends no Owner message. Add `"answeredElsewhere": true` to close the items with `closedBy: owner` and the note `answered elsewhere`. |
| `POST /api/messages/keep-open` | Set `closeSuggestionDismissedAt` on the items in `{ "ids": [...] }`, 1 to 200 IDs. |
| `POST /api/messages` with `replyTo` | Send an answer to an open item of the same thread, and close the item. |

Both mailbox `POST` routes have the same gates as `POST /api/messages`: a loopback request or an authenticated remote session, and a same-origin request. A read-only preview refuses them with HTTP 403. The 30-day retention of the store applies to the mailbox items.

## Avatars

The Boss and each project have an avatar. The page shows the avatar in the Chat list, in the Chat header, next to the first message of each run of messages from the other party, in each Mailbox row, and on the orchestrator cards of the Agents chart. The avatar is decoration. It is `aria-hidden`, and the name of the party stays as text.

### Generated avatar

`avatarSvg(slug, { title, size })` in `public/app.js` builds the avatar as an inline SVG. The page uses the sizes 20, 28, and 36 px.

- A hash of the slug picks one hue of a fixed palette of 12 hues. The same slug always gets the same hue. The palette has no pure white and no pure black.
- The initials come from the project display name, the same name that Settings shows. The chat title and then the slug are the fallbacks. The page takes the first two letters of the first two words. A camel-case name starts a new word, so `AlphaBeta` gives `AB` and `HerdrBoss` gives `HB`. Every page uses this one title, so one project has one avatar in the Chat, the Mailbox, the Agents chart, and Settings.
- The initials take white or a dark color, whichever has the better contrast on the circle. Every hue of the palette reaches the WCAG AA contrast of 4.5 with that color.
- The slug `boss` gets a fixed crown in the accent color, not initials.

### Image of the Owner

The Owner can use an own image for the Boss and for each project. The page uses the image when one is stored, and the generated avatar otherwise.

- The Settings page has an **Avatars** section. It has one row for the Boss and one row for each project. **Upload image** stores an image. **Reset** removes it.
- An image is a PNG, JPEG, or WebP file of at most 512 KB. The service checks the magic bytes, not only the content type. It refuses SVG and every other format. An SVG file can carry a script.
- The service stores the file as `<data dir>/avatars/<slug>.<ext>` with mode `0600`. A new image replaces the file of that slug. A removed image puts the generated avatar back.
- The write routes are dashboard write routes. A read-only preview refuses an upload and a remove with HTTP 403.
- Herdr Boss calls no image API. It stores no key.

## Phone app view

On a screen up to 760 px wide, the Mailbox and the Chat are app views. The page header, the menu bar, and the page padding do not show. The page has the height of the visual viewport. The page itself does not scroll. Only the list, the conversation, or the chat log scrolls.

- The top bar is 52 px high, plus the top safe-area inset. It holds the menu button and the page title with its count. In a conversation it holds the Back arrow, the avatar, and the name.
- The menu button opens a drawer. The drawer holds the Mailbox folders on the Mailbox, the links to the pages, and **Help**. The drawer has no Mailbox entry and no Chat entry. A dot on the menu button shows unread items on the other page.
- The Mailbox list has a floating **New** button at the bottom right.
- In a Mailbox conversation, the actions of the open item sit in a bar at the bottom edge, above the bottom safe-area inset. The bar holds the item actions from [Answer an item](#answer-an-item):
  - Each bar has a last row with **Close as answered elsewhere**. The button has a 44 px target.
  - An approval: **Approve**, **Reject**, a note button, and a **Dismiss** button. The note button opens the note field above the buttons.
  - A decision with choices: one button for each choice, then a note button and **Dismiss**. The choice buttons wrap onto more rows, so each choice stays in view. The note button opens a field for another answer or a note, with **Send**.
  - An answer, or a decision without choices: **Dismiss**, the answer field, and **Send** in one row.
- The item that the bar holds is the open item of the last agent message. An older open item keeps its form in its message. A conversation without an open item shows the reply field and **Send** in one row at the same place.
- In **Needs you**, select one or more check boxes to start the selection. A selection bar then replaces the **New** button at the bottom edge. It shows the count, **Clear the selection**, **All**, and **Dismiss N**.
- On a phone the conversation replaces the list. Its title in the top bar is the page heading (`h1`). On a desktop the list title is the `h1` and the conversation title is an `h2`.
- When the phone keyboard opens, the visual viewport gets smaller. The page sets `--app-h` from `visualViewport.height`, so the composer, the reply field, and the action bar stay above the keyboard. The viewport meta has `interactive-widget=resizes-content` for Chrome on Android.
- Buttons and fields keep a touch target of at least 44 px and a font size of 16 px.

A check can force a theme with `?theme=light` or `?theme=dark` in the page address.

## Chat page

The Chat page at `/chat` is the conversation view of the Owner. One chat holds the messages between the Owner and the Boss. One chat holds the messages between the Owner and a project orchestrator. A worker has no chat. Use the Mailbox for items that need an answer, an approval, or a decision. Use the Chat for a normal conversation. Both pages read the same message records. An answer to a Mailbox item shows only in the Mailbox.

The page has no large heading. On a desktop the chat list and the open chat are two panes that fill the window below the page header. Above the conversation there is one slim bar. It holds the avatar of the chat, the chat name, and a link to the Mailbox. On a phone the bar also holds the Back arrow. See [Phone app view](#phone-app-view).

The initials come from the project display name. The slug is the fallback. Every page uses that one name, so one project has the same avatar in the Chat list, the Chat header, the bubbles, the Mailbox, the Agents chart, and Settings.

### Channels

`messageChannel(record)` in `src/messages.js` gives each record one channel.

| Channel | Records | Where it shows |
|---|---|---|
| `chat` | a `say` reply with the action `read` or with no action, and every Owner message, nudge, and status request | Chat only |
| `both` | a `say` reply with the action `answer`, `approve`, or `decide` | Chat, and Mailbox **Needs you** while the item is open |
| `mail` | a report from `herdr-boss mail post` | Mailbox **Updates**, and one short line in Chat |

`mailboxView()`, `mailboxFolders()`, and `mailboxCounts()` use only `mail` and `both` records. A plain chat reply never shows in Mailbox Updates.

An Owner answer to a mailbox item is not a chat record. `isMailAnswer(record, byId)` is true when an Owner record has `replyTo` and its parent is a mail record of the same thread. `chatRecords()` leaves these records out of the chat list, the chat thread, and the chat counts. A chat message from the Owner has no `replyTo` and stays in the Chat. The service sets `mailAnswer: true` on the message event of a mail answer, so the page can ignore it.

A plain chat message from an agent asks nothing and creates no Mailbox item. An agent that needs an answer, an approval, or a decision runs `herdr-boss say --action answer|approve|decide "TEXT"`. The Chat then shows the item as a card, and the Mailbox shows it in **Needs you**.

A chat message that needs an action shows in Chat with its card or its link. Its action item shows in Mailbox **Needs you**. A mail report shows in Chat as one short line: `Report: TITLE · Open in Mailbox`.

### Layout

The Chat is compact, in the style of a phone messenger.

- A bubble has 6 to 8 px of padding and a width of at most 75%. It has no card frame. The time is 11 px and sits in the corner of the bubble.
- The composer is one line. It grows to 6 lines. The send button is a round button of 36 px. Its touch area is 44 px on a phone. The composer hides the scroll bar until the text is longer than 6 lines.
- A chat list row is 72 px high, with a 52 px avatar. The first line holds the title and the time. The second line holds the last message and the unread badge. An unread row is bold.
- A run of bubbles from one sender forms a group. The inner corners of a group are tight. A short chat sits at the bottom of the log, next to the composer.
- The theme sets the colors. The page keeps its contrast in the light theme and in the dark theme.

### List

Each row shows the chat title and the time on the first line. The second line shows the last message on one line and the unread badge. The last message is cut with an ellipsis. Each row starts with the avatar of that chat. A mail report shows as `Report: TITLE`. The chat with the newest last message comes first. A chat with no message comes after a chat with a message. The menu badge shows the total unread count of all chats. A mail report does not count as chat unread.

The page reads `GET /api/chats`. It follows the `message` event on `GET /api/events`. It never reloads the page.

The automatic refresh keeps the scroll position of the chat list and of the conversation. It waits 3 seconds after your last input or scroll. See [Automatic refresh](#automatic-refresh).

### Conversation

Select a row to open the chat. The conversation shows the messages in time order. An Owner message sits on the right. An agent message sits on the left. The avatar of the agent shows at the first message of each run of messages from that agent. It does not show again inside the same run. Each bubble shows the text as safe Markdown, the sender, and the time. A wide table or code block scrolls sideways inside the bubble. An Owner bubble also shows the delivery state from the record: `queued`, `delivered`, `relayed`, or `failed` with the reason.

Opening a chat calls `POST /api/chats/<thread>/read`. It marks each chat record to the Owner as read. A mail report keeps its own read state. The page stops the count for that chat. A read-only preview refuses the read, so the count stays.

Scroll up to read older messages. The page asks for the page before the oldest message while the service sets `more` to `true`. The page keeps your reading position. The 30-day retention of the store sets the oldest message that the page can show.

A new message goes at the bottom. The page scrolls down only when you already read the newest message. Otherwise the page keeps your position.

While you read older messages, a round arrow-down button shows at the bottom right of the message list, above the composer. Its name is `Jump to the newest message`. A small badge on the button shows the count of new messages. The badge shows `99+` above 99. Select the button, or press Enter on it, to scroll to the newest message. The badge clears. The button hides when the list is at the bottom. When the system setting `prefers-reduced-motion` is on, the page jumps without animation. On a phone, the touch target is 44 px wide.

### Composer

Select the round send button or press Enter to send the message. Select Shift and press Enter to make a new line. The text area grows with the text, up to 6 lines. The composer hides the scroll bar until the text is longer than 6 lines. A message holds at most 2000 characters. The service accepts at most 10 Owner messages a minute. The focus stays in the text area after a send.

The page adds a `queued` bubble at once. The stored record replaces the bubble. A refused send marks the bubble `failed` and shows **Retry**. Select **Retry** to send the same text again. `POST /api/messages` is the only write path of the page.

### Action cards

A message from an agent that asks the Owner for a decision shows as a normal bubble with one small button per option. The card has no frame of its own. The bubble holds a short question line, and the page drops the choice list from the text because the buttons hold the choices.

The page shows a card for a real choice only:

- An approval shows **Approve** and **Reject**. It also shows **Later**.
- A decision shows one button for each choice. A decision with the choices `Yes` and `No` shows those two buttons.
- An answer shows a one-line text field and a small **Send** button.

**Later** only collapses the card. The page writes nothing. The Mailbox item stays open.

A decision without a Markdown list under a `Choices` heading is not a real choice. It shows as a plain bubble with the **Open in Mailbox** link. A message with the action `read` also shows as a plain bubble.

The page finds the choices with the same rule as the Mailbox.

The card uses the same send route as the Mailbox. It calls `POST /api/messages` with `replyTo` set to the item ID. The server closes the item. The bubble then shows the result, for example `Approved 22:05`. A closed item shows as a normal bubble with the result of the answer that closed it. The message event then refreshes the chat and the Mailbox.

Every card keeps an **Open in Mailbox** link. A read-only preview refuses the send and shows the reason in the card.

### Keyboard and screen readers

- The chat list holds one button per chat. The arrow keys, **Home**, and **End** move the focus between the rows. Enter opens a chat.
- The focus goes to the message field when a chat opens. The focus goes to the list row of the open chat when you select **Back** or press Escape.
- Escape returns from an open chat to the list.
- The message list has `role="log"` and `aria-live="polite"`. A screen reader reads each new message once.
- Each bubble has a name with the sender, the time, the text, and the state.
- The text of the chat view reaches the WCAG AA contrast in the light theme and in the dark theme.

### Phone

On a phone, the list fills the page. Select a chat to open it full screen. Select **Back** to return to the list. The chat thread stays in the page address, so the browser Back button also returns to the list. The buttons are at least 44 px high.

## Phone and home screen

The dashboard adapts to a phone and to a home-screen web app.

- On a screen up to 760 px wide, the header is one row: the Herdr Boss mark, a menu button with the current page name, the watch symbol, the three top-bar icons, and **Help**. On a screen below 375 px the icons move to a second row. The page name in the menu button shortens before the header wraps. Select an icon to open the Chat or that Mailbox folder. Select the menu button to open the page menu. The menu closes after you choose a page and when you press Escape.
- On a phone the header does not show the update time. A warning line under the header shows that the page lost its connection to the service.
- On a phone, the long sections of a project page start collapsed. Select a section title to open it. The browser remembers each open section for that project in its local storage. The Now section, overall progress, the current frontier, and the board stay open.
- Project cards become compact. They show the name, mode, status line, and task bar.
- Tables show stacked rows with a label for each value. The page does not scroll sideways at 393 px. The project table on the Overview shows one short block for each project, without labels: the name and workers on the first line, the orchestrator and the policy on the second line, and the published status on the third line.
- On a screen up to 760 px wide, a link that acts as a button, such as **Details** or **Project details**, is at least 44 px high.
- On a screen up to 760 px wide, each text field, number field, select, and text area uses a font size of 16 px. This stops iOS Safari from zooming the page when you select a field. Pinch zoom stays on.
- On a screen up to 760 px wide, each button, select, text field, checkbox with its label, and menu link is at least 44 px high.
- The page does not scroll sideways at any width from 320 px. A wide table or code block scrolls inside its own box.
- A fixed bar, such as the **Apply policy** bar, moves up when the on-screen keyboard opens.
- The expanded browser view fills the screen. One compact toolbar holds the controls. The address field and **Go** use the full width of one row. **Back**, **Forward**, and **Home** share the next row. The text field and key controls appear only while **Control browser** is on. The screenshot fills the rest of the height, in portrait and landscape.
- The dashboard sets the home-screen web app meta tags. To add the dashboard to a phone home screen, open it in Safari, open the Share menu, and select **Add to Home Screen**.

### Check the phone layout

The static checks in `test/phone-layout.test.js` run in `npm test`. They check the viewport meta, the 16 px field size, the 44 px target size (also for class rules that set a smaller height), the dynamic viewport units, and the scroll boxes. They do not open a browser.

`npm run check:phone` runs `test/phone-check.mjs`. The script needs the project browser. It starts a read-only preview, opens each page, the Help panel, the menu, the new-message form of the Mailbox, an open message, and an open chat at 320, 375, 390, and 430 px, and fails when a page is wider than the screen or a field has a font size under 16 px. At 375 px and wider it also fails when the header is more than one row high (above 64 px). It prints a warning for each target under 44 px. Add `--strict-targets` to fail on those too. Add `--base URL` to check a running dashboard. A state that needs data, such as an open message, is skipped when the dashboard has none. Add `--only /mailbox,/chat` to check some pages.

## Configuration

Put overrides in `~/.herdr-boss/config.json`, then restart the service.

```json
{
  "port": 4477,
  "host": "0.0.0.0",
  "push": true,
  "access": { "tokenFile": "/Users/you/.config/herdr-boss/access-token", "sessionDays": 30 },
  "quota": { "warnPercent": 90, "criticalPercent": 98 },
  "machine": { "memFreeWarnPercent": 15, "loadWarnFactor": 2 },
  "browsers": { "reapOrphanDaemons": true, "orphanDaemonMinAgeSeconds": 7200, "staleOwnedMinutes": 30, "sweepCodeSignClones": true },
  "workers": { "staleIdleMinutes": 120 },
  "roamgate": { "port": 8787, "tokenFile": "/Users/you/.config/roamgate/auth-token" },
  "providerKinds": { "claude": ["claude"], "codex": ["codex"], "opencodego": ["opencode", "pi"] },
  "resourcePools": [
    { "name": "serve-ports", "range": "8000-8004", "split": { "herdrboss": ["8000", "8001"] }, "env": "HERDR_SERVE_PORT", "ttlMinutes": 240, "check": "tcp", "graceMinutes": 10 }
  ]
}
```

## Remote access

The server listens on all local interfaces. Requests from `127.0.0.1` need no login.

1. Open `http://<LAN-or-Tailscale-IP>:4477` on the other device.
2. Enter the token from `~/.config/herdr-boss/access-token`. Herdr Boss creates this file on first start. The directory has mode `0700`. The token and session files have mode `0600`.

The session lasts 30 days and renews while the device uses the dashboard. It survives a service restart. Set `access.sessionDays` to change the length. The server stores only hashes of session IDs and the token fingerprint in `~/.config/herdr-boss/sessions.json`, even when you set a custom `access.tokenFile` path. A new token signs every device out. Herdr Boss moves existing default credential files from `~/.herdr-boss/` on first start. An explicit `access.tokenFile` path remains in use. The login form lets a password manager, such as the iPhone keychain, save the token. API clients can send `Authorization: Bearer <token>` instead.

- Tailscale encrypts traffic between tailnet devices. LAN access uses plain HTTP; use it only on a trusted network.
- Set `host` to `127.0.0.1` to turn off remote access.
- To change the token, write a new token to the token file and restart the service.

When Roamgate runs and its token file exists, the header shows a **Roamgate** link. Herdr Boss reads that token only when you open the link.

## Usage records

When a `report.md` line starts with `Status: done` and the next character is whitespace, punctuation, or the end of the line, collection checks each configured artifact rule. It accepts lines such as `Status: done.` and `Status: done — checks complete`. It ignores `Status: doneish`, `Status: done-partial`, `Status: partial`, and `Status: failed`. Collection warns when the newest source file is newer than the oldest artifact file, or when matching sources have no matching artifacts. It prints each warning and includes it in the `artifactWarnings` summary field. The warning does not change the independent gate result. The orchestrator decides whether the gate passed.

`worker collect --record` records one usage event per worker run before merge. An unknown tool-call count stays `null`, and the ledger accepts `null` as unknown. If an older kit reports a ledger entry with `null` as invalid, install a HerdrBoss kit version that accepts `null`, then run `herdr-boss ledger check` again. This check reads the ledger. Do not replace `null` with `0` or edit the ledger entry. After a successful collection, Herdr Boss prints a reminder to merge the branch and then run `herdr-boss worktree prune --apply`. Collection does not remove a worktree. `herdr-boss usage record FILE` adds measured events. The Analytics page shows recorded usage and its coverage. Quota percentages are global per provider. They are not project token counts.

## Denials and permission prompts

Every 15 minutes, the service reads the Claude, Codex, OpenCode, and Pi logs for denials. The scan runs beside the engine tick, only when the engine acts. Two scans never run at the same time. The dashboard preview does not scan. One scan reads at most 20 MB in total. It continues from the saved byte offset of each file. A file with a new inode or a smaller size starts again at byte 0. The offsets are in `memory.json` under `denialScan`.

Herdr Boss keeps only counts in `denials.json` in the data folder, with mode 0600. Each record has the UTC day, the harness, the cause, the project, the model, and the count. The model comes from session metadata. Herdr Boss uses `unknown` when the model is missing. The file keeps 30 days. It holds no message text, command, argument, or path. What each harness counts is in [the harness setup](harness-setup.md#denial-counts).

Herdr Boss maps each record to a project by its working folder. A folder inside a registered repository belongs to that project. A worker worktree inside `~/Projects/.herdr-wt/<repo>/` or inside a sibling `<repo>-wt-<name>` also belongs to that project. The registered repositories are in `project-repos.json`. All other folders count as `other`.

The Analytics page shows the chart **Denials and permission prompts**: one stacked bar for each day, for one harness or for all harnesses. See [Denials per day](#denials-per-day). Its Details hold these tables:

- A table of the days in the chart, with the refused and approved counts, the total, and the harness changes in the window.
- A table of the last 7 days by cause and project, with the outcome of each cause and a count for each day.
- A small table of counts by harness, model, and cause. It shows the top 10 rows, then the number of extra rows.
- A total for each harness, on the harness switch.
- A trend arrow. It compares the last 24 hours with the mean of the 6 days before them.
- A read-only line with the limits: the scan interval, the bytes for one scan, the days kept, and the rise rule.

The last 24 hours are the count of today (UTC) and the part of yesterday inside the window. A cause rises when its last 24 hours are above 2 times its 6-day mean and above 10 events. Then the page and the Owner section of the bulletin show "Discuss this trend with the Boss." Herdr Boss sends no pane prompt and adds no project rule for a denial trend.

The first scans read the older logs at 20 MB for each scan. While more than 1 MB of logs is unread, the counts of older days are not complete. Then the page shows the unread size, and neither the page nor the bulletin shows the note.

### Denials per day

The chart shows the events for each day. A day is a UTC day, the same day as in `denials.json`. Each bar has two parts. The legend gives the total of each part for the range.

- **Blocked or refused** (solid): a classifier refusal (`classifier:`), a sandbox error (`sandbox:`), a Herdr guard block (`guard:`), an OpenCode permission denial (`permission:<type>`), and an OpenCode prompt that got no answer in 10 minutes (`permission:unanswered:`).
- **Escalation approved by a rule** (outlined, lighter fill, same color): a Codex escalation request (`escalation:request`). An approved escalation is friction, not a failure.

The scan does not keep the reply to an OpenCode prompt that was answered (`permission:asked:`). A cause with no known outcome counts as refused. The Details of the chart show the number of such events.

The range is 3 days by default. The buttons on the chart select 7 or 30 days. The browser remembers the choice in its local storage. The server sends the last 30 days in `/api/analytics`, and the page cuts the range.

#### Harness change markers

A marker shows the day on which a harness fix went in. It is a thin vertical line with a small flag at the top. Hover, focus, or touch the flag to read the date, the harness, and the label. The arrow keys move between the bars and the flags. The Details of the chart list each marker. When the switch selects one harness, the chart shows only the markers of that harness.

The markers come from `harness-changes.jsonl` in the data directory. Each line is one JSON object with these fields:

| Field | Meaning |
|---|---|
| `date` | Required. A real day in the form `YYYY-MM-DD`. |
| `harness` | Required. One of `claude`, `codex`, `opencode`, `pi`. |
| `label` | Required. Text of 1 to 80 characters, with no control character and no bidi or zero-width format character. |

Example line: `{"date":"2026-01-05","harness":"codex","label":"Escalation rule added"}`.

Add a line with `herdr-boss harness change <harness> <label> [--date YYYY-MM-DD]`. Only the pane labeled `boss`, a pane labeled `orch`, and a plain terminal can run the command. A worker pane is refused. The default date is today in local time. The reader skips a line that is not valid JSON or has a bad field. It reads the last 64 KB of the file and keeps the last 200 lines. It never stops the page. The chart shows the markers that fall inside the last 30 days.

## Resource leases

A resource pool is a set of scarce items that several projects share, for example local serve ports. A project leases one item, uses it, and releases it. Herdr Boss keeps the leases in `leases.json` in its data directory, with mode `0600`. Each change holds the mutation lock of the machine locks.

Lease a shared resource with `herdr-boss lease acquire POOL` or `worker start --lease POOL`. Never pick a port from a pool by hand. The commands are in [Resource leases](cli.md#resource-leases).

Define each pool in `resourcePools` in `~/.herdr-boss/config.json`:

| Key | Meaning |
|---|---|
| `name` | Required. A slug of lowercase letters, digits, and hyphens. |
| `items` or `range` | Required. Use exactly one. `items` is an array of strings. `range` is `"LOW-HIGH"`, a single number, or a comma-separated list of both, for example `"8000-8004,8010"`. |
| `split` | Optional. Project slugs to item lists. Each item must be in the pool and in one list only. A project takes its own items first. |
| `env` | Required. The variable that `worker start --lease` sets in the worker pane. |
| `ttlMinutes` | The lease time. The default is 240. |
| `check` | `"tcp"` or `null`. `"tcp"` means that each item is a local port. The default is `null`. |
| `graceMinutes` | Kept for older configs. It has no effect on reclaims. |
| `idleMinutes` | The minutes that a leased port can have no listener before Herdr Boss reclaims the lease. A whole number from 1 to 240. The default is 20. |
| `waitSeconds` | The seconds that `lease acquire` waits for a free item when `--wait` is not set. A whole number from 0 to 3600. The default is 0, which means no wait. |
| `portEnv` | Optional. Environment variables with a value for each port: `{ "VARIABLE": { "8005-8009": "value" } }`. A key is a port, a range, or a list of both, and each port must be in the pool. A value is a string of 1 to 200 characters with no whitespace. A lease hands the worker the value of its port. A port without an entry gets no variable. Keep this key in the private config file only. |

A pool is a ports pool when all items are numbers and the pool has `check: "tcp"` or a port from 1024 up. A ports pool holds at most 100 ports from 1024 to 65535 with no duplicate. It cannot hold the dashboard port. The idle rule and the `portEnv` values apply to a ports pool.

The pool `project-browsers` is built in. Herdr Boss adds it to the config pools. Do not define a config pool with this name: it is an error. See [Port leases](#port-leases).

Herdr Boss validates the pools when it loads the config. An invalid pool list gives no config pools. The built-in pool stays. The lease commands then fail and name each error, and the bulletin shows each error. Do not put a secret in a pool. An unknown key is an error.

Herdr Boss reclaims a lease on each service tick and before each `lease acquire` or `lease release`. It reclaims a lease when one of these conditions is true:

- The pane of the lease is not in a successful Herdr pane list.
- The run record of the worker has `finishedAt`.
- The time `expiresAt` of the lease is in the past.
- The pool is `project-browsers`, and no matching Chrome process runs on two ticks in a row. This rule is the only rule for this pool.

A lease of a ports pool also ends in these cases:

- The lease has a bound server process (`--pid` or `lease bind`), and that process is gone. Herdr Boss releases the lease within one tick. A process with a different start time than the bound one counts as gone, so a reused process ID does not keep a lease.
- The port has no listener for `idleMinutes` (default 20). Herdr Boss probes `127.0.0.1` on the port with a connect timeout of 300 ms. A refused connection means no listener. The idle time starts at the first tick that finds no listener. A listener resets it. This rule covers an unbound lease that no server ever binds, and a bound server that lives but does not answer.

A port with a listener and a living bound process is never reclaimed by the idle rule. The holder of an idle lease gets one notice: `Your lease of port N in pool serve-ports was reclaimed after 20 minutes without a listener. Start serve-live again to take a port.` A holder that takes a lease keeps it until its TTL only while its server answers on the port. `lease acquire` never gives out an item that a live holder has.

Take a port before the server starts, start the server, then bind the lease to the server process with `lease bind POOL PORT --pid PID`. A caller that knows the PID at once uses `lease acquire POOL --pid PID`. See [Resource leases](cli.md#resource-leases).

A port can also be in use without any lease. Each tick probes every free item of a pool with an idle rule. A listener on a free item is an unleased listener. It has no lease, so no project holds it and the idle reclaim does not apply. The Allocation page shows one warning row for it with the port, the PID, the process name, the owner project, and the age. The head of the pool counts them as `listening with no lease`. Herdr Boss finds the owner from the working directory of the process and the project registry, and reads no command line and no environment. The registry path and the worktree folder of a project both count, so a server in a worker worktree has an owner. When two paths hold the directory, the longer path wins.

An unleased listener with a known owner gives one notice to the orchestrator of that project after 10 minutes. The notice tells the orchestrator to take the lease and to bind the PID of the server. Herdr Boss never takes the lease itself. An unleased listener with an unknown owner gives no notice, because no project can act on it. Resolve it by hand: find the process with `lsof -nP -iTCP:<port> -sTCP:LISTEN`, then either bind the lease of that project or stop the process.

`lease acquire` gives out a port that nothing listens on before a port with a listener and no lease. The list comes from the last tick, so it can be a tick old. `--prefer PORT` gives out that port even when a process listens on it.

A pool can hand a value to each port, for example a client ID, in `portEnv`. `worker start --lease` sets the variable in the worker pane. `lease acquire --env-file FILE` writes it to a file that the shell sources. No command, log, event, report, API answer, or page shows the value. `lease list` shows `set` or `not set`. Herdr Boss logs one `lease` event for each reclaimed lease, with the pool, the item, the project, and the reason. When the holder pane is still alive, for example after the TTL, the engine sends it one notice. The bulletin has a `Resource leases` section with one line for each pool. The line shows each item with its holder, its age, and `borrowed`, or `free`. The line of `project-browsers` shows only the leased ports and the number of free ports.

## Project locks and worktree cleanup

Use a project lock when one task must finish before another task starts in the same Git repository. Run the commands from a verified `orch` or `boss` pane:

```sh
herdr-boss lock acquire release-review
herdr-boss lock list
herdr-boss lock release release-review
```

All linked worktrees of one repository share its locks. The `full-suite` lock is machine-wide. All repositories on this machine share it, and `lock list` shows its scope as `machine`. Herdr Boss keeps lock files in a private `locks` directory under its data directory. A lock records its name, owner pane, PID, kind, safe acquire command, and acquisition time. A `suite` or `push` lock uses that command's PID. Herdr Boss marks it stale when that process exits, even if its pane stays open. A manual `full-suite` lock uses the pane shell PID and expires after 60 minutes. The next acquire takes over an expired lock, and the engine warns the former holder. Release a lock from its owner pane. When exactly one live record belongs to the pane, no selector is needed. With several live records in that pane, use `lock release NAME --slot N` for a short slot or `lock release NAME --slot long` for the long slot. Automatic suite and push cleanup selects the exact record that the command acquired. A token-based push re-entry release is a no-op, including with either slot selector. The outer push owner can still release its exact acquired record. Another pane can release it only after the owner PID has exited, the owner pane has closed, or a manual `full-suite` lock has expired. Use `--wait SECONDS` to wait for an active lock. Enter a whole non-negative number. Herdr Boss takes over a stale lock and prints its previous pane and PID.

Herdr Boss writes the lock ledger, `lock-ledger.jsonl`, in its data directory. The file is append-only JSONL. Each acquire adds one `acquire` line. It holds the time, lock name, project, kind (`suite`, `push`, or `manual`), holder pane, tree hash when the checkout is clean, and `waitMs`. Each release adds one `release` line with the same fields and `holdMs`. A takeover of a stale lock adds a `release` line with `takeover: true`. A busy acquire adds a `busy` line, and an acquire whose wait ends first (exit code 75) adds a `timeout` line. Both have `waitMs`. A re-entrant suite under a push adds lines with `reentrant: true`. Its release line holds the time that the suite ran. The medians skip re-entrant lines, `busy` lines, `timeout` lines, and the hold time of takeover lines. When the file passes 5 MB, Herdr Boss renames it to `lock-ledger.1.jsonl` and replaces the older rotated file. It starts a new `lock-ledger.jsonl`. The dashboard reads only the current file. The ledger never blocks a lock change.

At startup, the process can use legacy defaults for a missing, invalid, or partial policy. On a retry, a missing, invalid, or partial policy cannot widen admission. The waiting process keeps its last validated settings. It waits until a complete valid lock policy returns, even if a slot becomes free. A complete lock policy has slot capacity, the short job limit, and all guard fields.

A capacity or guard change applies at each admission attempt, including a queued job. A queued ticket keeps its prediction, short-limit classification, and sequence. A short-limit change classifies new tickets. With one slot, all tickets use the exclusive long lane. After a capacity reduction, every existing holder still counts. New jobs wait until total capacity and slot capacity allow admission. The guard identifies a long job by its lane. A short job that borrows the long slot does not activate the guard. The guard reads the newest sample at or before the current time. A future sample cannot hide a current sample. A missing usable sample or one older than three minutes passes.

A new manual queue ticket uses the PID of the waiting CLI process. The acquired manual holder uses the pane shell PID. A canceled new waiter becomes stale when its CLI process exits.

The Locks panel and `lock list` queue data show effective admission capacity separately from saved capacity. During legacy exclusivity, effective capacity is one slot and queue positions follow global FIFO order. The short lane has no admission capacity until the eligible legacy records drain.

A holder or queue ticket without a `lane` field is a legacy record. A legacy ticket constrains admission only while its PID and pane are live and it is younger than 30 minutes. The constant `LEGACY_TICKET_TTL_MS` sets this limit. Herdr Boss excludes an older ticket from the queue display. The next admission removes it. This limit releases a canceled old manual waiter whose shell PID stays live. A live legacy holder still requires exclusive admission as before. While a live legacy holder or an eligible legacy ticket exists, admission uses one exclusive long slot and one global FIFO queue. No short second job starts. Existing holders finish before another job starts. Normal lane admission returns after the eligible legacy records drain. A suite hook can re-enter a legacy push with its live token. Old code cannot read a new short-slot record. An old hook cannot re-enter a push in that short slot. This old-code limit is accepted. Do not treat the long record filename as full protocol compatibility.

Herdr Boss publishes the queue sequence with an atomic rename. If a legacy writer left an invalid sequence, the next guarded write starts above the highest live ticket sequence. A valid sequence also remains a lower bound.

Run a full test suite with `herdr-boss suite -- <command>`, and push with `herdr-boss push <args>`. Never take the full-suite lock with a bare lock acquire for a suite. Use `lock acquire` and `lock release` for other lock names. A short job can wait in the short lane when the machine guard reaches a configured limit.

```sh
herdr-boss suite -- npm test
herdr-boss push origin main
```

`herdr-boss push` takes the lock only when a pre-push hook exists and no suite pass covers the tree. When the last hook run of the repository has a pass for the clean tree, the push takes no lock and skips the queue. It releases the lock also when the push fails, and it returns the exit code of `git push`.

A suite pass matches only when the repository, the tree hash, the command, the Node version, and the hash of each lockfile in the repository root are the same. Herdr Boss hashes `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`, `Cargo.lock`, `poetry.lock`, `uv.lock`, `Pipfile.lock`, `Gemfile.lock`, `composer.lock`, and `go.sum` when they exist. The tree hash covers a tracked lockfile. The lockfile hash also covers an ignored lockfile. A tree with no lockfile has the same key as before.

### Machine samples

The engine writes one machine sample line for each UTC minute into `machine-samples.jsonl` in the data directory. The file uses mode 0600. It is append-only JSONL. The engine writes no line when it cannot read the machine or when actions are off. A tick that comes late leaves a gap. The engine does not fill a gap. A write error never stops or slows a tick.

Each line has these keys:

- `at`: the sample time, cut to the whole minute, as a UTC ISO string.
- `l1`, `l5`, `l15`: the 1, 5, and 15 minute load.
- `cpus`: the core count.
- `cpu`: the summed CPU of all processes, in percent of all cores.
- `memFree`, `memGB`: the free memory in percent, and the total memory.
- `swapMB`, `swapTotalMB`: the swap in use and the swap total.
- `holders`: the kinds (`suite`, `push`, `manual`) of the live `full-suite` lock holders.
- `waiters`, `waiterKinds`: the number and the kinds of the tickets in the `full-suite` queue.

A key has the value `null` when the collector cannot read it. A line holds no project name, pane id, path, or command.

When the file passes 3 MB, the engine renames it to `machine-samples.1.jsonl` and replaces the older rotated file. Two files hold about 18 days.

Two definitions classify a sample:

- An overload minute has swap above 90 percent with at least 1 GB in use, or a 5-minute load above 3 times the cores.
- An idle-wait minute has at least one waiter in the `full-suite` queue while `cpu` is below 50.

`GET /api/machine-hours?days=N` returns the samples of the last N days, grouped by the local hour of the day. `days` is a whole number from 1 to 14. A missing or invalid value gives 14. The route reads both sample files, skips a line that does not parse, and allows GET in the read-only preview.

The response has these keys:

- `days`, `daysWithData`: the window, and the number of local dates that hold a sample.
- `hours`: 24 rows. Each row has `hour` (0 to 23), `samples`, `overloadMin`, `idleWaitMin`, `swapPeakPct`, `memFreeMin`, and `holderKinds`.
- `totals`: `samples`, `overloadMin`, and `idleWaitMin` over all hours.
- `coverage`: `samples` divided by `days` times 1440.

`overloadMin` and `idleWaitMin` count samples, and one sample is one minute. A minute without a sample is missing data. It is not a quiet minute. `swapPeakPct` and `memFreeMin` are the highest swap percent and the lowest free memory of the hour, or `null`. `holderKinds` counts the samples for each holder kind. The response holds no project name, pane id, or path.

The route keeps its result for 60 seconds for each value of `days`. The summary counts a repeated minute once.

The **Analytics** page shows the hours in the block **Machine overload and idle waiting by hour**. The chart has two bars for each local hour of the day. The bars show the mean minutes per day of overload and of idle waiting, from 0 to 60. The chart title gives the two daily means. A tooltip on hover, focus, or touch gives the values of one hour. A hatched bar marks an hour with fewer than 10 samples. A note shows when `coverage` is below 0.5. The details element under the chart holds the same 24 rows as a table. On a phone the chart scrolls sideways inside its own box.

Before it removes a worktree, `herdr-boss worktree prune --apply` checks for processes whose current working directory is inside that worktree. It reports parent-PID-1 processes in missing or prunable worktree paths. Stop those processes before cleanup. Herdr Boss removes no worktrees if it cannot scan process directories. It also keeps worktrees that are dirty, unmerged, primary, used by a live pane, or uninspectable. Herdr Boss sends a notice about a parent-PID-1 process in a removed worktree only to that repository's `orch` workspace.

Before it removes a worktree, `worktree prune --apply` copies the worker reports `report.md`, `report.json`, and `brief.md` to `.orchestration/reports/<worker name>/` in the main checkout. It never overwrites an archived file. If the folder already holds a report, it writes the new reports to `<worker name>-<UTC time>`. If the copy fails, it keeps the worktree. Use `--no-archive` to skip the copy.

## HTTP API

The dashboard uses these routes. A request from another host needs the access token.

| Method and path | Result |
|---|---|
| `GET /api/state`, `GET /api/events` | The snapshot, and a server-sent event stream of snapshots. |
| `GET`, `PUT /api/policy` | Read or replace the policy. |
| `GET /api/models` | The model allow-list. |
| `GET`, `POST /api/usage` | Read usage, or record an event. |
| `GET /api/machine-hours?days=N` | The machine samples of the last N days (1 to 14, default 14) by local hour of day: overload minutes, idle-wait minutes, swap peak, lowest free memory, holder kinds, and coverage. |
| `GET /api/analytics` | The notice counts for each pane and local day of the last 7 days, and the machine timeline of the last 24 hours in columns of 10 minutes. Numbers, lock kinds, and pane IDs only. The service keeps the result for 60 seconds. |
| `GET /api/spend?days=N` | The token use and cost per day, role, and harness for the last N days (1 to 90, default 7), the cost label `API-price equivalent`, the models with `unconfirmed` prices, the harness log status, and the unread log bytes. |
| `GET`, `PUT /api/settings/prices` | Read the price table and the override, or replace the override. See Token use and spend by role. |
| `GET /api/denials` | The denial counts of the last 7 days by harness, model, and cause, the harness totals, and the trend of each cause. |
| `GET /api/projects`, `PUT`, `DELETE /api/projects/SLUG` | Read, write, or delete project status. The GET route returns current task state, `unplanned`, `sync`, and status age fields. `GET /api/state` returns the same project fields. |
| `GET /api/handoffs`, `GET /api/handoffs/output?id=ID` | Handover records, and a successor's pane output. |
| `POST /api/handoffs/plan`, `/prepare`, `/activate` | The handover steps. Activation needs `confirmed: true`. |
| `GET`, `POST /api/browser-sessions...` | Browser list, request, tabs, screenshot, navigation, input, new tab, tab close, close, restart, and bookmarks. Input to an agent tab returns 409 unless the body has `confirmAttached: true`. Tab close returns 409 for a tab that an agent holds unless the body has `force: true`. `GET /api/browser-sessions/bookmarks?project=SLUG` reads the bookmarks and the start page. `POST /api/browser-sessions/bookmarks` changes them with `{ project, action }`. |
| `POST /api/leases/release` | Release a lease: `{ pool, item, project }`. Returns 409 when the lease changed. |
| `GET /api/pools` | List the pools. A `portEnv` entry shows `set`, never the value. |
| `PUT /api/pools` | Create, update, or remove a config pool: `{ action, pool }`. A `portEnv` value of `null` keeps the stored value. An empty string clears it. The answer shows `set` flags only. Returns 409 when a holder uses a port that the change drops. |
| `GET /api/messages?thread=THREAD` | The records of one thread, oldest first, at most 200. |
| `POST /api/messages` | Queue an Owner message: `{ thread, kind, text }`. `kind` is `message`, `nudge`, or `status-request`. Returns 400 for invalid input, 404 for an unknown thread, and 429 above 10 sends a minute. |
| `POST /api/tick` | Collect now. |
| `GET`, `POST`, `DELETE /api/avatars/SLUG` | Read, store, or remove the image of one avatar. The slug is `boss` or a project slug. `POST` takes the image as the body, at most 512 KB, and accepts only a PNG, JPEG, or WebP file. It returns 415 for any other format and 413 for a larger body. A read-only preview refuses the two write routes. |
| `GET /bulletin.md` | The current bulletin. |
