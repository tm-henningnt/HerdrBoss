# Browsers reference

## Project browsers

Each project can have one persistent Chrome profile. Request it with `herdr-boss browser request SLUG`, or open it from the Browsers page. Herdr Boss assigns a port from 9223 to 9299.

The service closes a project browser after `browser.idleCloseMinutes` with no other CDP client or open agent tab. The default is 20 minutes. Set it from 1 to 1440 minutes, or set it to 0 to turn off idle close. It closes only a browser that Herdr Boss started and matched to the project's port and profile. It keeps the Chrome profile. A later browser request can launch the browser again.

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
| not responding | Chrome runs with the project port and profile. `GET /json/version` does not answer, or two CDP probes in a row failed while that endpoint did not answer. |
| closed | You used `herdr-boss browser close`. Herdr Boss clears the not-responding notice and does not report the deliberate close as offline. A new browser request clears this state. |
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

One failed probe changes nothing. Two failed probes in a row mark the browser `not responding`. One successful probe clears the mark. The service sends no not-responding notice while `GET /json/version` answers. A deliberate close clears the notice and marks the browser `closed`. The engine state and `GET /api/browser-sessions` show `closed`, `notResponding`, `probeAt` (time of the last probe), and `probeReason`. The reason is one of these phrases:

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

#### Sign in to a web app

1. Open the large view of the project browser.
2. Enter the address of the sign-in page in the sign-in field. The address must use http or https. It must not hold a user name or a password.
3. Select **Open sign-in tab**. Herdr Boss starts the project browser if it is not running, opens the address in a new tab, and turns on **Control browser**.
4. Click the image and type. Use **Tab**, **Enter**, and **Select all**. A key with Control, Meta, or Alt goes to the page.
5. Paste the password and the one-time code into the masked text field. Select **Send text**.

The sign-in route and each input with `signIn: true` accept only the owner. The owner is the dashboard page with the header `x-herdr-boss-caller: page` on loopback, or a page with a login session. The access token alone is not enough. On loopback, any local process can send the header, so any local process counts as the owner for this route. Input without `signIn` is open to project agents, because `herdr-boss browser` uses it. Herdr Boss does not log, store, or echo the typed text.

The login stays in the project browser profile in `browser-profiles/SLUG`. A restart of the browser does not change the profile folder.

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

Agent commands and tab rules are in [the browser service](../../kit/browser-service.md).

