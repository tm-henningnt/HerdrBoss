# Dashboard reference

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

The list has two folders. **Open** holds the packs that wait for answers. **Done** holds the submitted and the expired packs. Each row shows the project avatar, the pack title, the version, the time of the last change, the project name, and the count `N of M items answered`. An open row also shows the progress bar. A row with **N changed** has items that changed after the Owner answered them. Those items count as open. A done row shows the verdict chip: **Accepted**, **Accepted with changes**, **Denied**, or **Expired**.

### Progress bar

The bar shows the item states in a fixed order: Accepted, Note only, Needs live check, Denied, and Open. Accepted also counts a choice and a rating. The segments use the status colors `--ok`, `--info`, `--warn`, and `--crit`, and `--line` for Open. A gap of 2 px separates the segments. The Denied segment has stripes, so it differs from Needs live check without color. The bar has a text alternative with each count. On the section list, a legend under the bar names each state with its count.

### Section list

Each section is a fold with its title, its state chip, and its count of answered items. A section that is accepted and fully viewed starts folded. The page keeps each fold as the Owner sets it across a refresh. Each item row shows a type icon, the title, the state chip, and the viewed mark. A viewed and answered row is short and faded. **Changed** marks an item whose content changed after the answer. The item shows no verdict and no viewed mark, and it counts as open. A section with a changed item shows **Changed**. A section is **Accepted** only when all its items are accepted. The item shows `Was: Accepted on DATE`. **Keep** restores the earlier verdict. An answer to the item replaces the mark. The item number stands at the left of the title. A title wraps to two lines, and the tooltip shows the full title. On a screen of 900 px or wider, the sections are in a column at the left, and the state chips of the items show their icon only. The word stays in the tooltip and for screen readers. Drag the handle at the right edge of the column to change its width. The width is at least 200 px and at most half of the window. Focus the handle and press the left or right arrow key to change the width by 16 px. Press Home to reset the width to 300 px. **Hide the sections column** collapses the column to a thin rail. The button on the rail shows the column again. The browser remembers the width and the collapse state. Below 900 px the column has no handle and no collapse button.

### Summary header, badges, and filter

The summary header is one compact row at the top of a pack page. It shows the item total, the agent-verified count, and the needs-you count. It shows the unmarked count only when that count is above 0. It also shows the design pass result (`passed`, `issues`, or `not-run`) with the reviewer name and the note. The row wraps on a phone. A pack without `verifiedBy` marks and without a design pass shows no row.

Under the summary row, a small note shows the judge pass that ran on the pack. It shows the text of the `judgePass` field of the manifest, or `no judge pass` when the pack has none.

Each item row and each item view shows a badge. The badge has an icon and a word: `agent-verified`, `needs-you`, or `unmarked`. The column of the sections shows the icon only when it is narrower than 340 px. The word stays as the accessible name and the tooltip.

An agent-verified item that lists evidence shows the evidence images under the heading **Agent evidence**. A grid opens an image in the same zoom stage as an image item. The item view also shows the two-line description, the numbered steps, the expected result, and the link to the app. The link opens in a new tab.

The **Needs you** filter is a toggle chip above the sections. It shows the count of needs-you items. When it is on, the column shows only the needs-you items. A section heading stays when it still has an item. The next and previous item keys skip the hidden items. The open item stays visible. The filter is off by default. The browser keeps the choice for each pack in `localStorage`. The summary list below the sections is not filtered.

At 200 px the column wraps each row. The title takes its own line, with at most two lines. The item number stays. The thumb, the badge, and the checkbox move to a second line. The drag handle has a visible width of 8 px and a hit area of 24 px.

### Summary and submit

The summary follows the sections. It lists the items by state: Denied, Needs live check, Note only, Accepted, Changed since accepted, and Open last. The Owner's note shows under its item. An open item has **Review now**. An open item that changed after the answer shows `changed in this version`. Above the list, `N items have no decision` warns about the open items. The pack note field saves the note 600 ms after the last key, and at once when the field loses the focus. The verdict choice has **Accept pack**, **Accept with changes**, and **Deny pack**. The page selects the proposed verdict and marks it **Proposed**. A pack with no denied item, no open item, and no live item gets **Accept pack**. A pack with only denied items gets **Deny pack**. Any other pack gets **Accept with changes**. The page sets the proposal when it first shows a pack version. A later answer does not move the selection. A new version sets a new proposal. **Submit review** is in the bar at the bottom edge. If items are open, a dialog lists their titles and asks `N items are still open: submit anyway, or answer them first`. Select **Submit anyway** or **Answer them first**. Select **Cancel** or press **Escape** to close the dialog. **Submit anyway** still asks you to confirm the selected verdict. The button stays disabled while the request runs. It is also disabled while changes wait in the autosave queue. It then shows `Waiting for N changes to save`. After the submit, the page shows the summary as read-only: the verdict, the pack note, every decision and note, and the delivery state of the result. The result lists the IDs of open items. The delivery state is **Queued**, **Delivered**, **Retrying**, or **Failed**, with the attempts and the reason. When the service stored the result but did not queue the message, **Queue again** queues it. A second submit of the same version shows the first result.

An open item in a submitted pack links to the next pack in the same planner session that has that item. If no such pack exists, the page says to ask the planner to reopen the item. Run `herdr-boss review reopen SLUG PACK ITEM` to open one unanswered or changed item. A planner pane can reopen only a pack whose `manifest.session` matches its session. The project orchestrator pane and a plain terminal can also reopen an item. The other items stay locked. The item locks again after the Owner saves an answer. Herdr Boss sends the planner session pane a short message with the pack, item ID, and saved answer. Add `--carry-open` to a planner publish to copy open items from the most recently submitted pack in the same session, excluding the pack being published. Herdr Boss keeps item IDs, links, saved notes, and pins. It does not copy an item ID that is already in the new pack.

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

The item viewer shows one item. On a screen of 899 px or less it fills the screen. On a screen of 900 px or wider it fills the pane at the right of the sections. The top bar holds Back, the item title, `Item N of M` with the section name, and the **Viewed** toggle. The evidence and the item text are below the top bar. Above 900 px, the answer controls sit in a sticky column at the right of the evidence and stay in view as the item scrolls. At 900 px and below, the answer bar stays at the bottom edge.

| Type | Viewer |
|---|---|
| `image` | The image at the fit size in a stage. Pins show over it. |
| `image-pair` | Both images in one stage. The `a` image is the before image, and the `b` image is the after image. **Toggle** shows one image, and the toggle at the top uses the two labels of the manifest. **Slider** shows the `a` image at the left of a split line and the `b` image at the right. The range under the stage moves the line. The zoom and the pan stay the same when you change the image. |
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
- A choice shows one option card for each alternative. A card has a radio mark, the label, the consequence text, and the key number. The recommended choice has the badge **Recommended**. The selected card has a thick border, a tinted background, and a filled radio mark. The pack sets the consequence text in the optional `consequence` field of the choice (at most 300 characters). The text wraps and is never cut. A phone shows one column of cards. A window wider than 1100 px shows two columns. A rating shows one star for each step.
- **Ask later** and the note field are below the choices.

Drag the handle at the left edge of the answer area to change its width. The handle shows above 900 px only. The width is at least 280 px and at most 60 % of the window. Press the left or right arrow key on the handle for a step of 16 px. Double-click the handle or press Home to reset the width to 400 px. The browser remembers the width. On a phone the area is full width below the evidence and has no handle.

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

When a value stays outside, the dashboard names it and the reason. The audit and its gap list are in [gui-settings-audit.md](../ideas/gui-settings-audit.md).

## New project setup

The command `herdr-boss project new` builds a new project in steps. See `docs/cli.md`, section New project flow.

With `--remote gh`, the step `remote` asks you before it creates a GitHub repository. The question is a decide item in the Mailbox. The dashboard wizard is the exception: your choice in the wizard is the decision, and it posts no item. The default is a private repository. A public repository needs `--visibility public` and an answer that contains the word `public`. The command exits with code 3 and waits. Answer the item, then run the same command with `--resume`. The step never pushes.

When the remote is a GitHub repository, `project new` adds three workflow templates under `.github/workflows/`. The files run a quick check for pull requests, a changed-files verify for pushes to `main`, and the full gate by manual request or on a published release. Replace each placeholder `run:` command with a command for the project. Run `herdr-boss project check <slug>` to read the `ci` item. Run `herdr-boss project check <slug> --fix ci` to copy missing templates. This command keeps files that already exist.

The steps `policy`, `register`, and `status` put the new project into Herdr Boss:

1. `policy` gives the project a share of 10 percent. The other projects give up part of their share, so the total stays at most 100. When the previous total was 100, the scaled shares add up to exactly 90 by the largest remainder method, and no share of 1 or more falls below 1. Each project keeps its mode and its exclusions. You see the shares before and after the change.
2. `register` records the project folder in `project-repos.json`. The dashboard and the engine then read the repository of the project.
3. `status` publishes the first status. It holds one task, `Set up the project`. The project appears on the dashboard with this task.

The step `workspace` starts the first orchestrator. It runs only when you give `--start`, because the orchestrator uses model quota:

1. `workspace` creates a Herdr workspace with the label of the slug. The root pane gets the label `orch`.
2. The step starts the agent `<slug>-orch`. It uses `--kind` when you give it. Otherwise it uses the first usable entry of the orchestrator ladder in Settings.
3. The step watches the new pane for a folder trust prompt. See the paragraph below.
4. The step gives the agent your goal, or the **Default orchestrator goal** from Settings. By default, Claude and Codex get the goal as plain text in the first prompt. Turn on `goals.autoCommand` in Allocation to send `/goal` to Claude instead.
5. The step sends the first prompt. The agent reads `AGENTS.md`, the project memory, and the kit file. Then it starts the task `Set up the project`.

The Owner accepts the trust prompt. Herdr Boss only tells the Owner where it is. Claude Code and Codex show a folder trust prompt in a new folder. Herdr Boss reads only the pane that this run created, every 2 seconds, for 3 minutes. When the pane shows the known prompt for exactly the project folder, Herdr Boss posts one item to the Mailbox. The item names the pane and links to the Agents page. Open the Agents page, choose the pane, and press Enter on the option that trusts the folder. Herdr Boss never presses a key in a pane for this. If the agent is neither ready nor working after 3 minutes and the prompt was not seen, Herdr Boss posts one item that says the pane may wait for input. Claude Code and Codex have a known prompt. Pi and OpenCode show no folder trust prompt, so Herdr Boss does not watch them.

The step `harness` prepares the machine for the project:

1. It adds the project to the Codex `writable_roots`. It writes a backup of the Codex config first.
2. It prints the Claude autoMode lines that are missing. Add them to `~/.claude/settings.json` yourself. Herdr Boss never edits that file. The step detail says `needs Owner action` when a line is missing.
3. It reserves a browser port for the project. It starts no browser.

Run the command again with `--resume --start` after a failure. The run uses the workspace and the pane that it created. It sends no message twice.

Run `herdr-boss project check <slug>` at any time. It reads the project and prints `ok` or `missing:` for each part, including the CI workflows when they exist. It changes nothing. Each missing part names a fix. Run `herdr-boss project check <slug> --fix STEP` to run that one step again. The command then prints the check again. The exit code is 0 when all parts are present and 4 when a part is missing.

Each step changes nothing when its result already exists. A run that stops at a failed step continues at that step on the next run. After the change, check the shares on the Allocation page.

### New project wizard

The Projects page has the button **New project**. The button opens a panel on a wide screen and a full-screen sheet on a phone. The panel shows one step at a time.

1. **Name.** Enter the slug. Enter a name if it must differ from the slug.
2. **Folder.** Check the suggested group folder from the `projectRoot` setting. Enter another group folder or an exact path if required.
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

Herdr Boss keeps the shared orchestration rules in a kit file in each project repository: `docs/orchestration/herdr-boss.md`. Only Herdr Boss writes this file. Its first line is `<!-- herdr-boss kit v=<revision> -->`. The revision is the first 12 hex characters of the SHA-256 of the relative file names and contents in `kit/templates/`, `kit/skills/herdr-orchestrator/SKILL.md`, its reference files, and `kit/models.json`. Service, dashboard, and website changes do not change this revision. The project `AGENTS.md` holds a short stub between `<!-- herdr-boss:begin v=<hash> -->` and `<!-- herdr-boss:end -->`. The stub tells the orchestrator to read the kit file and `docs/orchestration/memory.md` at start and at resume. `herdr-boss kit install` writes the kit file and the stub. `herdr-boss kit update` runs the same install, prints the kit changes since the installed kit revision, and prints the current kit file. The digest names the impact and the summary of each change, oldest first. It reads the installed revision from the version line of the project kit file. When the change log does not know that revision, the digest lists every known change. `--quiet` prints the digest and the summary line only, and prints nothing when the kit is current and no file changes. The install writes a file only when its content changes, so a session start on a current project changes no file. Commit a changed kit file, stub, or hook with the next orchestrator commit. Do not make a separate commit. The command always installs, also when the digest has no change. It also adds a Claude `SessionStart` hook to `.claude/settings.json`. At each session start the hook runs `herdr-boss kit update --quiet`, then prints both files. `herdr-boss worker start` and `herdr-boss publish` refresh the kit files of the project when the disk copy is behind on a `required` change. They commit nothing, and they skip a file that has hand edits with a warning. `herdr-boss publish` also sets `kitRevision` in the status from the kit file on disk. `herdr-boss handoff plan|prepare` prints one line when the project kit is behind for a `required` or `useful` change. A required change tells the orchestrator to run `herdr-boss kit update`. A useful-only change says the update is optional to act on now and tells the orchestrator to run `herdr-boss kit update` at the next task boundary. `herdr-boss check agents` finds a missing, old, or hand-edited kit file or stub. It also finds stale orchestration text outside the stub, such as fixed pane IDs, dated lines, copied model lists, and text that sends pushes or product decisions to the Boss. `herdr-boss publish` and `herdr-boss worker start` run the same check and warn. The project page shows the counts from the last `publish`. The published `kitRevision` follows the kit file on disk at each `publish`. The project page shows the published revision, the revision on disk, and the current revision. It shows a warning with the number of required changes when the published revision is behind. The kit file also holds the working rules for context and cost. An orchestrator uses subagents for diff reviews, long report reads, log searches, and code surveys, and keeps the main thread for decisions. It takes back only findings with file and line evidence and verifies a finding at the source before it acts. It uses a cheaper subagent model where the task allows, and Opus only for hard judgment. After a dispatch the orchestrator ends its turn and waits for the `WORKER REPORT` message. The service warns about a stall, a block, and a missing report. As a backup only, the orchestrator runs at most one check every 20 to 30 minutes while a worker runs with no report. The check is `herdr-boss worker list` and the pane status line. Each worker brief tells the worker to report back through Herdr when done and to send a `WORKER QUESTION` when blocked. `herdr-boss check kit` lists the published revision, the number of required changes behind, the revision on disk, and the state of each project: `current`, `behind (useful only)`, `behind (required)`, or `not published`. Only `behind (required)` and `not published` fail the check. The project page shows a project that is `behind (useful only)` as a muted line. It shows a warning for `behind (required)`. A revision that `kit/CHANGES.md` does not list counts as `behind (required)`. The bulletin shows the current kit revision in its header. The commands are in [cli.md](../cli.md).

## Orchestrators

Herdr Boss finds an orchestrator by its pane label `orch`. Tab names do not matter. An orchestrator can label its own pane:

```sh
herdr pane rename "$HERDR_PANE_ID" orch
```

The label stays when the agent in the pane restarts. The pane with the label `boss` is the Herdr Boss orchestrator itself.

`herdr-boss worker start` puts each worker in a pane of a worker tab in the workspace of the orchestrator. The worker tabs have the labels `Workers`, `Workers 2`, `Workers 3`, and so on. A worker tab holds at most 3 worker panes, so each pane stays wide enough to read. A new worker uses the first worker tab with a free slot and splits from the newest pane in that tab. When all worker tabs are full, the worker creates the tab with the lowest free label and uses its root pane. Set `workerPanesPerTab` in `.herdr-boss.json` to an integer from 1 to 6 to change the limit. Each worker gets a worktree in `<worktreeRoot>/<repo>/<name>`. The service default is `~/Projects/.herdr-wt`. A project can set another place in `.herdr-boss.json`. Herdr Boss does not move an existing worktree. An older worktree in a sibling folder `<repo>-wt-<name>` stays in use until `worktree prune` removes it. Read a worker dialog with `herdr agent read <name> --source recent-unwrapped`. This source joins wrapped lines, so a narrow pane still shows the complete dialog.

Orchestration needs settings in each agent harness: Claude `autoMode`, Codex `writable_roots` and rules, the OpenCode `worker` agent, and the Pi guard. [harness-setup.md](../harness-setup.md) gives each setting and its risk. The first `publish` of a slug registers the project repository and adds its `.git` to the Codex writable roots. The service worktree root is one more Codex writable root. Its default is `~/Projects/.herdr-wt`. `herdr-boss harness sync` adds it. Run `herdr-boss harness check` when a harness refuses routine work.

To add the shared rules to a project, follow [orchestrator-instructions.md](../orchestrator-instructions.md). The shared process is in [the orchestrator skill](../../kit/skills/herdr-orchestrator/SKILL.md).

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
- What memory do the agent, browser, and test processes use?
- When do the machine load and the lock waits slow work down?
- How many GitHub Actions minutes does each repository use each week?
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
- **Codex quota plan**: the actual line uses quota history for the selected window. The fast and slow lines show planned use. The shaded area shows the range between both plans. Flags mark quota windows, credit apply times, and expiry times. **Details** lists exact window and credit times. A note under the title shows the plan mode, the points that actual use is ahead of or behind the plan, and the projection at the burn of the last 24 hours. The card shows an empty state when the window has no history.
- **Model scorecard**: one bar for each of the 8 models with the most runs. The bar shows the share of first-time, rework, failed, and not judged runs. The right column shows the runs and the median time. Details also holds the recorded work by project and provider and the recent runs.
- **Denials**: one stacked bar for each day. The range is 3 days by default. The buttons select 7 or 30 days, and the browser remembers the choice. The switch selects one harness or all harnesses. See [Denials per day](locks.md#denials-per-day).
- **Lock wait and hold by project**: one stacked bar for each day of the last 7 days. The lower part is hold time. The upper parts show wait time in the long and short lanes. The chart shows the median wait for each lane. A second chart shows long and short lane wait and hold for each hour of the last 24 hours. Hourly buckets use UTC. A lock's hold time counts in the hour when it is released. The switch selects one project by its slug or all projects. **Details** shows each day's wait by lane, each hour's wait and hold by lane, and the wait, hold, runs, and timeouts for each project. A row without a lane counts as long. A run that reused a suite pass, and a suite run inside a push, add no time. The charts use the last 2 MB of `lock-ledger.jsonl`. The card also shows full-suite slot capacity from saved policy and machine-wide slot use from the latest usable machine sample. A sample older than three minutes shows unknown use. The project filter does not change the machine scope of slot use. The prediction table shows each project and kind. Predictions use the same last 10 qualifying releases within 14 days as admission, including the rotated ledger. Fewer than three releases shows unknown. The historical short-job baseline is a follow-up.
- **Memory by class**: stacked bars for each hour of the last 24 hours. Each bar is the mean of the samples of that hour. See [Memory by class](locks.md#memory-by-class).
- **Machine load and lock waits**: lines for the 5-minute load as a percent of the cores, the memory in use, and the swap in use, over the last 24 hours in columns of 10 minutes. A shaded column had a lock holder. The strip under the lines shows the minutes in which a suite request waited.
- **Machine overload and idle waiting by hour**: see [Machine samples](locks.md#machine-samples).
- **GitHub Actions minutes**: stacked bars show estimated minutes per registered GitHub repository for each of the last 12 ISO weeks. Figures are estimated from run times. **Details** shows this week, last week, and this week's run count. The service uses its GitHub token. It skips a repository when the token cannot read it. The page hides the card when no repository is available. Set `analytics.actionsMinutes` to `false` in Settings to stop these API calls.
- **Notices per pane**: stacked bars for each day of the last 7 days. The five panes with the most notices have their own color. The other panes share one gray.
- **Policy changes**: a list of the last writes of `policy.json`, newest first. A row shows the time, the caller kind, and the changed keys with the old and the new value. A row has at least 44 px height on a phone. **Details** holds one table row for each changed key of the last 100 writes. The section shows an empty state until the first write. See [Policy changes](settings.md#policy-changes).

The charts use one color set for light mode and one for dark mode. The set passes the dataviz palette validator. The charts show no client name or path. They show harness, model, cause, lock kind, and pane ID only. The policy keys, lock chart, and Agent communication section can name projects by their slug. Agent communication also shows task IDs and agent names. On a screen up to 1180 px wide the charts are in one column. On a phone each chart scrolls sideways inside its own box.

The Codex quota plan card has a reset form. Enter a future time within 30 days. Choose **Full** or **Partial**. For a partial reset, enter refund points from 0 to 100. Only the Owner can save an announcement. Herdr Boss uses the announced reset to calculate a new plan.

The route `/api/analytics` gives the Actions minutes, agent communication figures, notice counts, machine timeline, memory by class, daily and hourly lock wait and hold, denial counts, harness change markers, and policy changes. It reads the last 2 MB of `events.jsonl` and `lock-ledger.jsonl`, machine and memory samples from the last 25 hours, `denials.json`, `harness-changes.jsonl`, `policy-changes.jsonl`, and `agent-message-meta.jsonl`. It reads Actions minutes from `actions-minutes.json`. The route keeps its result for 60 seconds. The quota plan route also gives the selected window key and matching quota history for the plan chart. The response holds numbers, lock kinds, pane IDs, marker labels, and policy keys with scalar values.

### GitHub Actions minutes

The service refreshes the figures at most once every 6 hours. It keeps at most 12 ISO weeks. The service uses its GitHub token to read registered repository remotes. It does not use the token of the browser or the Owner's session. A repository that the token cannot read does not appear. The service reads at most 5 pages of 100 runs for each repository. It stops when a page contains runs older than the 12-week window. A full fifth page before the window cutoff sets `truncated: true`. The card says older weeks may be incomplete. The service estimates each completed run from its start and update times. It rounds each run up to a whole minute. If no repository can be read, the API returns `available: false` and the page hides the card without an error.

Set `analytics.actionsMinutes` to `false` in Settings to stop the API calls. The default is `true`. The `/api/analytics` field `actionsMinutes` has `available`, `estimated`, `truncated`, `weeks`, `repos`, and `updatedAt`. The `estimated` field is `true` when the service returns data. Each repository has weekly `minutes`, `runs`, and runner-type series when the run response gives a runner type. A full fifth page sets the `truncated` field to `true`.

### Agent communication

The **Agent communication** section uses metadata from `/api/analytics`. It shows the last 7 local days. It has no message text.

- **Messages per project and day** shows one stacked bar for each day. Each message kind has one colour. Select **Message project** to show one project or all projects. The title shows the number and share of reminders for that selection. **Details** lists the counts by project, day, and kind.
- **Response time** shows the median and p90 time for each orchestrator and for each worker kind and model. The p90 value has at least 90% of measured times at or below it. Each row shows message and response counts. Unknown kind or model stays `unknown`. An unanswered row adds no time sample.
- **Nudges per task** shows the 10 tasks with the most nudges. The project and task ID identify a task. A nudge without a task ID shows **Task not known** in Details.

Each table shows at most 200 rows. The figures include all metadata rows in the time window. Failed deliveries add no traffic or response sample. The message project filter changes the daily bars only. The response and nudge figures use all projects.

The service stores each delivered notice with sender role `service`. A prompt to an idle orchestrator with ready work is a nudge. Status, kit, idle-worker, resource, and handover notices are reminders. Watch routines are tasks. Agent messages use the text and metadata retention settings in Settings.

The engine records the first idle or done transition after delivery, or the first delivered `tell` from the target. It uses the earlier time. An agent that was idle at delivery must become active before idle counts. A fresh pane snapshot is required for an idle response. The check runs at each engine tick. It records one response per message. After 24 hours, an unanswered message stays without a response.

The stored watch retro and watch report include one compact line of communication figures. The line covers messages since the watch started. It gives the message, nudge, reminder, and response counts, the reminder share, and the median and p90 response times.

### Activity log

The last section of the page is the activity log. It lists prompts sent to orchestrators, notices, handovers, errors, and stopped processes, newest first. The first line tells whether Herdr Boss sends notices to orchestrators.

- Filter by kind, project, level, and time range. The level is the severity of a notice, or `error` for an error event.
- Type in the search box to match the text, the kind, the pane, or the project.
- **Details** holds the raw log: all kept events without filters, one line each.

The log shows the events that the state keeps: the last 60. The old address `/logs` opens this section. The old address `/logs#guidance` opens the guidance section of the Overview.

## Project status pages

Orchestrators do not build dashboards. They publish a status file. Herdr Boss shows it on `/projects/SLUG`. The page shows a board of the tasks. With the optional work structure fields, the page also shows progress, the current frontier, a dependency graph, groups, specs, and all work. See [project-status.md](../project-status.md).

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

Herdr Boss also computes the state of each task from facts, so the board is correct when the orchestrator does not publish. Git is the strongest fact. A commit on the base branch that names the task ID in an explicit form makes the task done. The card shows the short commit ID. The forms are a merge commit with the ID in the merged branch name, the ID in parentheses such as `(#68)`, `Closes`, `Fixes` or `Resolves` before the ID, and for an ID that is not only digits the prefix `BD2a:`. `refs #12` and `WIP for #12` do not count. A commit that names a worker name or a worker branch of the task counts too. The ID of a task with only digits needs a `#`. The next facts are the worker records, then the issue tracker through `gh issue list` (read-only, cached for 10 minutes), where a closed issue makes the task done. The service reads `git log` of each project every minute. A project without a repository path uses the published state.

`GET /api/projects/SLUG` returns `computedState`, `publishedState` and `source` for each task. A task diverges when its computed state differs from its published state. The project has `boardDiverged` for the number of diverged tasks. A Doing task with no live worker and no commit for 3 hours is stuck. `stuck` holds the reason and the age. The board shows a stuck task in the Stuck lane. The overlay never writes the status file of the orchestrator. See [board.md](../board.md) for the rules and the cache.

The project data has `publishedAt` and age in minutes. `publishedAt` uses the newer of the status file modification time and its recorded publish time. `publishedAgeMin` is the age of that time. `phaseAgeMin` uses `phaseUpdated` or the newest `tasks[].updated` time. `summaryAgeMin` uses `summaryUpdated`. When a status has no time for one field, that age equals `publishedAgeMin`.

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

`boardStaleReason` names the cause. While a worker runs or the orchestrator works, Herdr Boss sends a status notice when `statusStale.level` is `warn`. The notice says `Status published N min ago. Publish the current plan with herdr-boss publish <slug> <file>.` It sends at most one notice per hour for each project. `herdr-boss publish` refuses a status in which a task has an active worker but is not `doing`. Use `--force` to publish anyway. The commands are in [cli.md](../cli.md).

### Board

The board shows each task in one column of the flow. The column comes from the effective state, `state`. A status without `state` gets the same rules in the page.

| Column | Tasks |
|---|---|
| Blocked | A task that waits on a task that is not done, on the Owner, on the Boss, or on an external item. |
| Ready | A task whose dependencies are all done. |
| Doing | A task with a live worker, or a task published as `doing`. |
| Stuck | A Doing task with no live worker and no commit for 3 hours. The lane shows only while a task is stuck. The card shows the reason and the time of the last activity. |
| Review | A task whose worker finished or was collected and whose branch is not merged. |
| Done | The last 10 done tasks by `updated`. **Show all N done** shows the rest. |

Each card with a computed fact shows an **auto** badge and the fact: the short commit ID, the worker name, or the issue number. When the published state differs from the computed state, the card shows both states and the fact, for example `published: doing, computed: done, merged abc1234 3 hours ago`. A line above the board gives the number of cards that differ from git and their IDs. When a project has a divergence for more than 30 minutes, Herdr Boss sends the orchestrator one line in the info digest, at most once in each 2-hour interval, and none while a worker runs and the orchestrator had no turn since the last line. When the divergence lasts 3 hours, it sends the Boss one notice. Run `herdr-boss publish SLUG FILE --sync` to set the card states from the facts. The rules are in [board.md](../board.md).

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

The Settings page has editable rows for `workers.paneCloseDelayMinutes`, `workers.uncollectedNoticeMinutes`, and `browser.idleCloseMinutes`. Their help text gives the default, range, effect, and apply time.

A field that the file sets has a **config** tag. The other fields use the default value. The `setup` command shows as `set` or `not set`. A `worktreeRoot` path in the home folder shows as `~`. A project with an invalid `.herdr-boss.json` shows the read error in place of the fields.

The engine reads the config at each service start and every 10 minutes. Change a field in `.herdr-boss.json` in the repository. The card changes after the next read.

### Needs your decision

A task can name the party that holds it with `waitingOn`: `owner`, `boss`, `task`, or `external`. The project page shows a **Needs your decision** card first in the Now section. The group lists each open task that waits on the Owner with its ID, title, ask, and a link to its Mailbox conversation. Each project card shows the count. The Overview shows the total with a link to each group.

A task that waits on other tasks shows **waiting on #ID** in place of the plain **Blocked** label. A task that waits on the Boss or an external party shows that party and the ask. The orchestrator sets `ask` when it waits on the Owner or the Boss, and sets `mailboxId` to the ID of the Mailbox item. See [project-status.md](../project-status.md).

### Graph view

The dependency graph draws the open tasks and the done tasks that block them directly. Clear **Open work only** to draw every task. A task without links sits in the first column, after the linked tasks. Each box names its task ID and its state. A box on the critical path says **path**, and an orange line joins the path. Select a box to select its task. The issue link is on the card.

Use the toolbar above the graph:

- **Fit** shows the whole graph in the panel. Until you zoom or pan, the graph fits the panel. A wide graph starts at its left edge at 85% zoom, so the text stays readable.
- **−** and **+** zoom out and in. **100%** shows the graph at its natural size.
- **Full size** fills the window. Select **Close** or press Escape to return.

Press Ctrl or Cmd and turn the mouse wheel to zoom around the pointer. A plain wheel scrolls the page. Drag the background with the mouse to pan. A drag on a task box does not pan. The page remembers the zoom and the pan of each project during the session.

On a phone, the graph has its natural size and scrolls sideways in its own box. Only **Full size** shows in the toolbar.

For a visual check, add `?theme=light` or `?theme=dark` to a dashboard address. The page then uses that theme and ignores the system setting.

The project page shows `status published N min ago`. The badge is amber when the server marks the status stale. The Projects list shows `Status stale: <age>` when a stale status has been marked. The mark stays until the orchestrator publishes again. See [Rules and notices](settings.md#rules-and-notices) for the stale rule.

## Agents page

The `/agents` page has two views. The switch at the top of the page selects the **Chart** view or the **List** view. Chart is the default. The URL holds the view as `?view=chart` or `?view=list`. The browser keeps the last choice in its local storage. If the browser cannot store the choice, the page opens Chart at the next load. A link to the old `/organization` route opens the Chart view.

### Chart view

The Chart view shows the organization as a chart. The chart has four levels:

1. The **Owner** node shows **At the Mac** or **Away**. The value comes from the machine idle time.
2. The **Boss** node shows the pane labeled `boss`, its harness, state, quota use, and handover state. It also shows the avatar of the Boss. The workers in the Boss workspace are below it.
3. Each **project** node shows the orchestrator pane, harness, and state. It also shows the avatar of the project, the current task, the worker slots in use against the slots and share, and the handover state. The nodes use the project order.
4. Each **worker** node shows the title of its work, the agent name, harness, the **Doing now** line, and the task ID. See [Workers in the List view](#workers-in-the-list-view).

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
- The chart shows no secrets. The only pane text on the page is the masked **Doing now** line of a worker. Message text shows only in the Messages panel.

### List view

The List view has two parts. The **Workers** table comes first. Below it, one section for each Herdr workspace shows the orchestrator of the workspace, live from Herdr.

### Workers in the List view

The **Workers** table has one row for each worker. A worker that has no run record, for example a pane that the Owner started by hand, also has a row. On a desktop, the rows form a dense table. On a phone, each row is one card. Select a row to open it.

A row shows these values:

- **Work**: the title of the work. The title is the first line of the task text that the orchestrator gave to `worker start`. A worker without task text uses the first heading of its `.worker/brief.md`. When the worker has a task ID, the row also shows the title of that card from the published status.
- **Project**, **Agent**, and **Runs**: the project, the harness and model, and how long the worker runs. A finished worker shows the time between its start and its end.
- **State**: Working, Blocked, Idle, or for a finished worker Collected, Merged, Failed, or Abandoned.
- **Doing now**: one plain line. See [The Doing now line](#the-doing-now-line).

The **Project** list and the state buttons above the table filter the rows. The state buttons are **All**, **Working**, **Waiting** (idle or blocked), and **Finished**. The filter applies to the open tab only. A reload clears it.

The table shows every live worker and the 50 newest finished workers. Older finished workers are not listed. A finished row shows only values that `worker start` and `worker collect` saved in the run record, so the table reads no file for it. A worker pane without a run record shows its pane label. An idle worker whose state did not change for more than 2 hours shows the mark `Idle over 2h`.

#### The Doing now line

Herdr Boss reads the visible screen of each working or blocked worker pane in the background. The read runs every 30 seconds for all panes together. A request from the browser never starts a read. Herdr Boss removes the terminal codes and finds the last action that the agent took. Examples:

- `Running tests in test/factory`
- `Editing src/render.ts`
- `Waiting for the lock`
- `Writing the report`

When the screen shows no action, the line reads `Working (no output for N minutes)`. N counts from the last change of the screen. An idle worker shows `Idle for N minutes`.

Herdr Boss masks secrets in the line before it goes into the dashboard state. The line holds no more than 140 characters.

A finished worker shows the result and the report summary instead. The result is one of these values:

| Result | Meaning |
|---|---|
| Merged | The branch is in the base branch. |
| Collected, not merged | The worker passed `worker collect` with outcome `done`. The branch is not merged. |
| Needs rework | The run ended with outcome `partial` or `failed`, or the report says that the worker stopped early. |
| Abandoned | The agent is gone and the run has no usable report. |

The report summary is the first paragraph of `.worker/report.md`. `worker collect` saves it as `reportSummary` in the run record, so it stays readable after the worktree is removed.

#### The brief panel

An open row shows the scope (the allowed paths), the report path, and the brief of the worker. The panel renders the brief as read-only Markdown. It shows the first 25 lines. Select **Show all** to see the rest, and select the button again to go back to 25 lines.

`worker start` saves a copy of the brief in the run record as `briefCopy`, with the SHA-256 hash of the masked text. The copy keeps its text for 30 days after the run ends. Then Herdr Boss removes the text and keeps the hash. While the copy exists, the panel shows the copy. Without a copy, the panel reads `.worker/brief.md` from the worktree. After the worktree and the copy are gone, the panel says that the brief is no longer available.

Herdr Boss masks secrets and the home folder path in the brief before it stores or shows the brief. The page loads the brief with `GET /api/worker-brief?project=<slug>&name=<worker>` when the row opens. The dashboard state holds no brief text. The same access rules apply as for the rest of the API.

#### Orchestrator focus

The orchestrator section of each workspace shows a **Focus** line. The line holds the phase and the cards on **Doing** from the published status of the project. When no card is on Doing, the line says `No card on Doing`.

### Workspaces in the List view

Each workspace section shows the orchestrator of the workspace, its mode, and its goal, live from Herdr. The workers of the workspace are in the **Workers** table.

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

Layout on a narrow screen (up to 500 px wide):

- The page does not scroll sideways. A long path, address, token, link, or inline code wraps.
- A table and a code block scroll sideways in their own box. A table shows a shadow above the table at each edge that has more columns. The shadow follows the scroll position. A table cell keeps a long path or address whole, so the table box scrolls.
- Headings, list indents, and code use a smaller size. A bubble uses up to 94 percent of the width.

### Copy buttons

`public/copy.js` holds the copy code. One click listener on the page covers each button.

- A fenced code block has a copy icon in a strip above the code, at the right. The strip keeps the icon and the label **Copied** off the code lines. The icon has the label `Copy code` and a tap target of 44 px. It copies the source of the block, without the fence and without line numbers. A tab in the source stays a tab, while the block shows four spaces.
- Each message in the message panel, the Mailbox, and the Chat has a **Copy** action next to its time. It copies the text of the message as Markdown source.
- A copy icon sits right after the folder path in the New project wizard, the connection address and the profile path of a browser, and the file name of a file or diff in a review pack. The icon of a file or diff copies the lines of the item without the line numbers. A diff keeps its `+`, `-`, and context markers, so the copy is the source diff. **Copied** shows to the right of the icon.
- The page copies with `navigator.clipboard` when the browser allows it. Otherwise the page selects a hidden text field with a font size of 16 px, runs `document.execCommand('copy')`, and gives the focus back to the element that had it. The code follows the rules for iPhone Safari: the copy runs in the click handler. Both ways are tested in a desktop Chrome browser. A test on an iPhone and in the home-screen web app has not been done yet.
- The button shows **Copied** for 1.5 seconds. The label of a message button changes from **Copy** to **Copied** in the same width, so the line does not move. The button has an `aria-label` and takes the keyboard focus.

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

An orchestrator or the Boss replies with `herdr-boss say --reply-to ID "TEXT"`. The Boss can post a longer Markdown report with `herdr-boss mail post --to owner FILE`, for example a morning handback. The Boss can close open Mailbox items as answered through the Boss with `herdr-boss mail close ID... --note TEXT`. It records the note and sends no message. A reply and a report have the status `new`. Set `--action answer`, `--action approve`, or `--action decide` only when the Owner must act. Everything else is information; omit `--action`. See [the CLI reference](../cli.md#owner-messages) for the caller checks and the limits.

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

Select a row to open its conversation. The conversation shows Owner and agent messages in time order. The answer of the Owner to an item is in the conversation of that item, with its time and its delivery state. Each message and each report shows as safe Markdown, with the same renderer as the message panel and the Chat. See [Markdown in messages](#markdown-in-messages). A picture shows as a thumbnail. Select it to open the full picture. HEIC and HEIF pictures show as file links. Select **Download** to save one. Opening an item sets `readAt` on the record. On a desktop the conversation opens at the right of the list, and the list keeps its position. On a phone the conversation fills the screen. Select the Back arrow to return to the list.

### Answer an item

| Action | Controls | Text sent |
|---|---|---|
| `answer` | A text field and **Send**. | The typed text. |
| `approve` | **Approve**, **Reject**, and an optional note. | `Approved.` or `Rejected.`, then the note. |
| `decide` | A text field and **Send**. Choice buttons when the text has a Markdown list under a `Choices` heading. | `Choice: CHOICE`, then the note. Or the typed text. |
| Pictures | **Attach a picture**. | Up to 6 pictures, at most 10 MB each. |

Select **Attach a picture** to choose pictures from your device. The picker can offer the camera and the photo library. Herdr Boss accepts JPEG, PNG, WebP, GIF, HEIC, and HEIF. It refuses a file that is too large or has an unsupported type before upload. Remove a picture from the strip to leave it out. You can send pictures with text or without text. The page asks for a confirmation before each send or dismissal. The answer is an Owner message to the thread of the item, with `replyTo` set to the item ID. It uses the same delivery rules and rate limit as a message from the Agents page. The service then sets `closedAt` on the item, and the item moves to **Done**. A closed item refuses a second answer with HTTP 409.

Select **New message** to start a thread with the Boss or a project that has an `orch` pane. Type a message or attach a picture, then confirm the send. The page applies the same send limit and safety gates as other Owner messages. It opens the new thread in **Sent**. Use the reply box at the bottom of a conversation to reply to its last open agent message. When that message is an open answer, approve, or decide item, the item form replaces the reply box. You can attach pictures to a reply. The page asks you to confirm each reply.

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

Select a row to open the chat. The conversation shows the messages in time order. An Owner message sits on the right. An agent message sits on the left. The avatar of the agent shows at the first message of each run of messages from that agent. It does not show again inside the same run. Each bubble shows the text as safe Markdown, the sender, and the time. A wide table or code block scrolls sideways inside the bubble. Pictures show as thumbnails with a fixed size. Select a thumbnail to open the full picture. HEIC and HEIF pictures show as file links. Select **Download** to save one. An Owner bubble also shows the delivery state from the record: `queued`, `delivered`, `relayed`, or `failed` with the reason.

Opening a chat calls `POST /api/chats/<thread>/read`. It marks each chat record to the Owner as read. A mail report keeps its own read state. The page stops the count for that chat. A read-only preview refuses the read, so the count stays.

Scroll up to read older messages. The page asks for the page before the oldest message while the service sets `more` to `true`. The page keeps your reading position. The 30-day retention of the store sets the oldest message that the page can show.

A new message goes at the bottom. The page scrolls down only when you already read the newest message. Otherwise the page keeps your position.

While you read older messages, a round arrow-down button shows at the bottom right of the message list, above the composer. Its name is `Jump to the newest message`. A small badge on the button shows the count of new messages. The badge shows `99+` above 99. Select the button, or press Enter on it, to scroll to the newest message. The badge clears. The button hides when the list is at the bottom. When the system setting `prefers-reduced-motion` is on, the page jumps without animation. On a phone, the touch target is 44 px wide.

### Composer

Select **Attach a picture** to choose pictures from your device. The picker can offer the camera and the photo library. Attach up to 6 pictures. Each picture can be at most 10 MB. Herdr Boss accepts JPEG, PNG, WebP, GIF, HEIC, and HEIF. It refuses a file that is too large or has an unsupported type before upload. Remove a picture from the strip to leave it out. Select the round send button or press Enter to send the message. You can send pictures without text. Select Shift and press Enter to make a new line. The text area grows with the text, up to 6 lines. The composer hides the scroll bar until the text is longer than 6 lines. A message holds at most 2000 characters. The service accepts at most 10 Owner messages a minute. The focus stays in the text area after a send.

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

### Agents tab

The Chat page has two tabs: **Owner** and **Agents**. **Owner** is the conversation of the Owner. **Agents** shows the messages that agents send to each other. Select **Agents** to open `/chat?tab=agents`.

The Agents tab is read-only. It has no field to send a message and no control to delete one. Agent messages never show in the Owner chats or in the Mailbox. They never count as unread, and the tab shows no unread badge.

Send an agent message with `herdr-boss tell`. The prompt process has a 25-second limit by default. Set **Agent prompt timeout** on Settings to change the limit. Exit code 0 means delivered. Exit code 75 means the pane could not take the prompt. Exit code 76 means typed but not submitted. Recovery retries Enter once only for matching input. It clears only its own unsubmitted text and checks the result. A different or unreadable input stays unchanged. For a long prompt, write a file in the worktree or scratch folder. Send one short line that names its absolute path. See [Agent messages](../cli.md#agent-messages).

The list shows one row for each agent pair. A pair is two agents that exchange messages. The row shows the two agent labels, the number of messages, and the time of the last message. A label has the role, the name, and the project, for example `Worker build (alpha)`. The newest activity comes first. The page reads the rows from `GET /api/agent-pairs`.

Select a row to open the pair. The conversation shows the messages in time order. The newest message is at the bottom. The first agent of the pair is on the left. The second agent is on the right. Each message shows the text as formatted Markdown, the time, and the kind of the message when the record has one: `task`, `nudge`, `report`, `reminder`, `reply`, or `other`. A message with the status `failed` or `recorded` shows that status as a badge. A `failed` message did not reach the pane. A `recorded` message is stored and has no delivery result. Worker reports show as `recorded` messages.

Select **Load older** to read the page before the oldest message. The page uses the `before` parameter of `GET /api/agent-messages`. It keeps your reading position.

Type text in the search box and press Enter to search the message text. The list then shows only the pairs that hold a match. An open pair shows only its matching messages. Select the project filter to show one project. The address keeps the filter, the search text, and the open pair: `/chat?tab=agents&project=SLUG&pair=KEY&q=TEXT`.

The page refreshes with the other extras every 30 seconds. It keeps the scroll position. It scrolls down only when you already read the newest message.

The service keeps the message text for 14 days and the metadata rows for 180 days. A row of metadata has no text. The Agents tab shows only messages that still have text. After 14 days a pair disappears from the tab. Set `agentMessages.retentionDays` and `agentMessages.metaRetentionDays` under **Pictures** on Settings to change the periods. The metadata is available with `GET /api/agent-meta`.

On a phone the Agents tab has two steps. The list fills the screen. Select a pair to open the conversation. Select **Back** to return to the list. **Escape** does the same on a keyboard. The arrow keys, **Home**, and **End** move the focus between the rows.

### Messages section

Each project page has a **Messages** section. It is closed by default. The header shows the number of pairs and messages of that project. The body shows up to 5 pairs and the last 5 messages of the project. The rows and the messages look like the rows and the messages of the Agents tab. Select a pair to open it in the Agents tab. Select **Open all in the Agents tab** to open the tab with the project filter set. The section is read-only and uses the same routes with the `project` parameter.

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

