# API reference

## Chat API

Open Chat with `?vvdebug=1` on an iPhone, then send a screenshot to the Boss.

Use `GET /api/chats` to list the Boss chat and project chats with an orchestrator pane. The response gives each chat a title, a last message, and an unread count. A chat without messages has a `null` last message. The last message and each chat record have a `channel` field. The unread count leaves out a mail report.

Use `GET /api/chats/<thread>?limit=<n>&before=<id>` to read a chat. Set `limit` to an integer from 1 to 100. The default is 50. Set `before` to a message ID to read older messages. The response sets `more` to `true` when older messages remain. Each record has a `channel` field of `chat`, `both`, or `mail`.

Use `POST /api/chats/<thread>/read` to mark the unread chat records to the Owner as read. It does not mark a mail report read. The read-only preview refuses this request.

Use `POST /api/messages` to send an Owner message. Read `GET /api/events` to receive each message change as a `message` event.

## Pictures in Chat and Mailbox

Send an Owner picture through Chat or Mailbox. An agent can send a picture with `herdr-boss say --image FILE "TEXT"`. A Boss report can include a local Markdown image with `mail post`. The agent receives each Owner picture as an `Attachment: <path>` line. It reads that file with its image tool.

Use JPEG, PNG, WebP, GIF, HEIC or HEIF files. Each file must be at most 10 MB. A message accepts up to 6 pictures. The `say` command accepts up to 3. The service allows 30 upload attempts a minute. External image URLs show as alt text and cause no image request.

Herdr Boss removes EXIF and other metadata from JPEG, PNG, WebP and GIF uploads before it stores them. JPEG ICC color profiles stay. HEIC and HEIF keep their metadata, including any location data. They download as files.

Set **Picture retention days** under **Pictures** on Settings. The default is 30 days. The range is 1 to 365. The hourly sweep deletes expired pictures. An upload left unlinked for one hour is deleted. Deleting or dismissing a message deletes its pictures. A deleted picture cannot be recovered.

## Review pack API

A review pack is a set of evidence with one question for each item. The routes below read packs, serve pack files, and store the Owner answers. `src/review-api.js` handles them. `src/review-store.js` keeps the data. A project publishes packs. The Owner answers them.

### Item guidance and summary

Each review item can describe what the Owner should inspect. Use `description` for two non-empty lines: what the item shows, then why it matters. The field can have up to 2000 characters. Use `steps` for 1 to 30 exact actions. Each step can have up to 500 characters. Use `expected` for a non-empty result of up to 2000 characters. Use `link` for the app and sheet URL. The URL must use HTTPS. HTTP works only for loopback and `.test` hosts.

Set `verifiedBy` to `agent-verified` when an agent ran the interaction check, or to `needs-you` when the item needs a human decision. An agent-verified item still needs the Owner to confirm or reject the evidence, so it gets **Accept** and **Deny**. Herdr Boss adds `accept` and `deny` to the `ask` of an agent-verified item that lacks them, unless the item asks for a choice, a rating, or a live check. An item with `accept` or `deny` in `ask` gets the other one. The validator warns when a title, a description, an expected result, a step, or a body is only a file name. A Markdown item with `text` set to one `.md` path reads that file. An item whose `ask` holds only `note` is information. It is never open and never blocks the submit. Set `evidence` to up to 60 image file references from image, image-pair, or gallery items. An agent-verified item needs at least one evidence image. A missing evidence image produces a warning. An evidence reference that does not name an image item is an error.

A pack can set `designPass` to an object with a non-empty reviewer name of up to 200 characters, a result (`passed`, `issues`, or `not-run`), and an optional note of up to 2000 characters. `review check` warns when the design pass is missing or has result `not-run`.

A pack can carry `judgePass`, one line of 1 to 200 characters that names the independent judge pass that ran on the pack, for example the model and the date. The `review publish` command sets it from `--judge-pass TEXT` and stores it on the manifest of the version. The pack page shows the text, or `no judge pass` when the field is absent. `review publish` refuses a pack with no `judgePass` record, with exit code 1. The message names the record and the flag.

The pack response includes a server-computed `summary` object. It has `total`, `agentVerified`, `needsYou`, `unmarked`, and `designPass`. The first four fields are counts. `designPass` is the result string, or `not-run` when no design pass is set. Each returned item also includes its `description`, `steps`, `expected`, `link`, `verifiedBy`, and `evidence` fields when set.

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
| `GET /api/reviews?state=open` | The packs with progress counts. `state` is `open` (default) or `done`. Another value gets `400`. `stale` is the number of items that changed after the Owner answered them. `counts.changed` is the number of those items that had a verdict. `counts.open` includes them. |
| `GET /api/reviews/<slug>/<pack>` | The current version: manifest, files, item states, answers, and progress. `?version=<n>` selects an older version. A submitted version also has `verdict`, `submittedAt`, and `delivery`. An unknown pack or version gets `404`. |
| `GET /api/reviews/<slug>/<pack>/files/<version>/<path>` | One pack file. `<path>` is the file path from the manifest. |
| `POST /api/reviews/<slug>/<pack>/raw-token` | A token for the frame of a `page` item: `{ token, expiresAt }`. `?version=<n>` selects a version. See [Legacy HTML pages](dashboard.md#legacy-html-pages). |

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
| `PUT /api/reviews/<slug>/<pack>/items/<item>` | `rev` and any of `decision`, `choice`, `rating`, `live`, `viewed`, `note`, `pins`, `checks`, `opId`, `keep` | `200` with the saved answer. |
| `PUT /api/reviews/<slug>/<pack>/note` | `note`, `rev` | `200` with `note` and the new `rev`. |
| `POST /api/reviews/<slug>/<pack>/submit` | `verdict` (`accept`, `accept-with-changes`, or `deny`), optional `note` | `200` with the result and `delivery`. |

A new pack version compares the content hash of each item with the hash of its answer. The hash covers the text, the evidence, and the files of the item. When the hash is different, the item state is `changed`. The answer shows no verdict, and `answer.previous` holds the earlier verdict and its time in `at`. An item with no earlier verdict stays `open`. `keep: true` restores the earlier verdict of a `changed` item. The server refuses `keep` for an item that did not change, and for an earlier verdict that does not fit the changed item. A new answer to the item replaces the mark. A section state is computed from its items and is never stored. A section with a `changed` item is `changed`.

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

- **JSON.** The schema is `herdr-boss.review-result/1`. It holds the pack ID, the slug, the title, the version, the submit time, the verdict, the pack note, the state of each section, and one entry for each item. An item entry has the state, the decision, the choice, the rating, the live check, the note, the pins, `stale` for an item that changed after the answer, and `was` for an item in the state `changed`. `was` holds the earlier verdict and its time. The JSON has at most 256 KB. A longer result first shortens the notes, then leaves out items. The field `truncated` names the cut.
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

## HTTP API

The dashboard uses these routes. A request from another host needs the access token.

| Method and path | Result |
|---|---|
| `GET /api/state`, `GET /api/events` | The snapshot, and a server-sent event stream of snapshots. |
| `GET /api/health` | The health body of the factory contract: version, kit revision, tick age, Herdr reachability, and clock offset. See Health route. |
| `GET`, `PUT /api/policy` | Read or replace the policy. |
| `GET /api/models` | The model allow-list. |
| `GET`, `POST /api/usage` | Read usage, or record an event. |
| `GET /api/machine-hours?days=N` | The machine samples of the last N days (1 to 14, default 14) by local hour of day: overload minutes, idle-wait minutes, swap peak, lowest free memory, holder kinds, and coverage. |
| `GET /api/analytics` | Analytics figures, including `actionsMinutes` for weekly GitHub Actions minutes and `agentCommunication` for the last 7 local days. The service uses its GitHub token. It skips repositories that the token cannot read. The service keeps the result for 60 seconds. |
| `GET /api/spend?days=N` | The token use and cost per day, role, and harness for the last N days (1 to 90, default 7), the cost label `API-price equivalent`, the models with `unconfirmed` prices, the harness log status, and the unread log bytes. |
| `GET`, `PUT /api/settings/prices` | Read the price table and the override, or replace the override. See Token use and spend by role. |
| `GET /api/denials` | The denial counts of the last 7 days by harness, model, and cause, the harness totals, and the trend of each cause. |
| `GET /api/projects`, `PUT`, `DELETE /api/projects/SLUG` | Read, write, or delete project status. The GET route returns current task state, `computedState`, `publishedState`, `source`, `boardDiverged`, `unplanned`, `sync`, and status age fields. `GET /api/projects/SLUG` returns one project. `GET /api/state` returns the same project fields. |
| `GET /api/handoffs`, `GET /api/handoffs/output?id=ID` | Handover records, and a successor's pane output. |
| `POST /api/handoffs/plan`, `/prepare`, `/activate` | The handover steps. Activation needs `confirmed: true`. |
| `GET`, `POST /api/browser-sessions...` | Browser list, request, tabs, screenshot, navigation, input, sign-in, new tab, tab close, close, restart, and bookmarks. Input to an agent tab returns 409 unless the body has `confirmAttached: true`. Tab close returns 409 for a tab that an agent holds unless the body has `force: true`. `POST /api/browser-sessions/sign-in` with `{ project, url }` starts the project browser, opens the URL in a new tab, and returns the tab ID. It and each input with `signIn: true` return 403 unless the request is from the owner page: the header `x-herdr-boss-caller: page` on loopback, or a login session. `GET /api/browser-sessions/bookmarks?project=SLUG` reads the bookmarks and the start page. `POST /api/browser-sessions/bookmarks` changes them with `{ project, action }`. |
| `POST /api/leases/release` | Release a lease: `{ pool, item, project }`. Returns 409 when the lease changed. |
| `GET /api/pools` | List the pools. A `portEnv` entry shows `set`, never the value. |
| `PUT /api/pools` | Create, update, or remove a config pool: `{ action, pool }`. A `portEnv` value of `null` keeps the stored value. An empty string clears it. The answer shows `set` flags only. Returns 409 when a holder uses a port that the change drops. |
| `GET /api/messages?thread=THREAD` | The records of one thread, oldest first, at most 200. |
| `POST /api/attachments` | Upload raw picture bytes. Set `Content-Type` to `image/jpeg`, `image/png`, `image/webp`, `image/gif`, `image/heic`, or `image/heif`. Set `X-Filename` to the URL-encoded file name. The limit is 10 MB. The answer has the attachment ID and metadata. |
| `GET /attachments/ID` | Read a picture by its attachment ID. A remote request needs login. HEIC and HEIF pictures download as files. |
| `POST /api/messages` | Queue an Owner message: `{ thread, kind, text, attachments }`. `kind` is `message`, `nudge`, or `status-request`. `attachments` is an optional list of up to 6 uploaded IDs. A message can have pictures and no text. Returns 400 for invalid input, 404 for an unknown thread or picture, and 429 above 10 sends a minute. |
| `POST /api/tick` | Collect now. |
| `GET`, `POST`, `DELETE /api/avatars/SLUG` | Read, store, or remove the image of one avatar. The slug is `boss` or a project slug. `POST` takes the image as the body, at most 512 KB, and accepts only a PNG, JPEG, or WebP file. It returns 415 for any other format and 413 for a larger body. A read-only preview refuses the two write routes. |
| `GET /bulletin.md` | The current bulletin. |

