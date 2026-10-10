# Browsers help

Addresses, tab titles, and bookmark names mask outside hosts. Output removes query strings and fragments, bearer values, tokens, and JWT strings. A command error also masks an outside host inside a URL and an app UUID. Enter a complete address to navigate or change a start page. Bookmarks open through their stored index.

One persistent Chrome per project. It starts headless. Agents drive it; you can watch and help.

Each card shows the leased port and the CDP address `http://127.0.0.1:PORT` of the project, with a link to its row on the Allocation page.

## Start and manage

**Open headless** starts the browser by default. **Open visible** appears only when **Allow visible project browsers** is on in Settings. That switch is off by default. Visible mode needs the Owner's setting. **Manage** restarts the browser in headless mode, or in visible mode when the setting allows it. It can also close the browser or set the window size for the next launch. A legacy visible browser changes to headless on the next service tick only when its recorded process ID shows that Herdr Boss started it. Herdr Boss keeps a browser running when it did not start it.

Herdr Boss warns once in the dashboard and bulletin when a project browser is visible or a worker or project lead starts Chrome outside `herdr-boss browser`. Each warning names the project and the fix command.

## Independent browser launches

The list shows the last 50 recorded independent launches, newest first. Each row shows the time, browser PID, first observed pane, launcher kind, and project. Herdr Boss keeps the first association when a process becomes an orphan. The event log also holds the observed process start identity. A process with the same PID and start identity gets one audit row. A reused PID with a new start identity gets a new row. The launcher kind is `perf-harness`, `agent-browser`, `playwright`, or `unknown`. Herdr Boss checks ancestor command names only. The attribution fields hold no raw arguments, URLs, environment values, or profile paths. Older rows can have no PID or pane and an unknown launcher kind. Run `herdr-boss browser audit [PROJECT]` to read the list at a terminal. Add a project slug to filter the list. This command changes no file.

## States

**ready**: Chrome runs with the project profile and answers on its debugging port. **not responding**: Chrome runs with the project profile, but its debugging port does not answer within 2 seconds, or two checks in a row failed during a quiet period. A responsive debugging endpoint suppresses the notice. A failed check does not count while a browser command runs, or during the next 20 seconds. A check opens a blank background tab, runs `1+1` in it, and closes it, at most once a minute. The check opens and closes that tab through the same browser command queue as every other tab open. It never counts as Owner or agent activity. When a close fails, the service closes the leftover probe tab on a later tick after the tab is older than 2 minutes. It closes at most 20 such tabs in one tick. It sweeps only a tab that the service itself tagged as a probe. It never closes a tab of the Owner or of a worker. A connected CDP client doubles the step limit to 6 seconds and the total limit to 16 seconds. The card shows the reason and a **Restart** button. Restart uses headless mode when visible mode is disabled. Visible mode needs the Owner's setting. It reopens saved web pages and blank tabs in a separate window for each tab. Restore drops query strings and fragments. A page that needs them reopens at its path. It also drops path parameters. It skips login and callback pages and sign-in hosts. Tab IDs change. A saved address can be older than the current page. It waits up to 30 seconds for a browser command to finish. It also waits for other CDP clients to disconnect. It refuses if a command or a client remains, or if the client count is unknown. An idle client can prevent a restart. It blocks new browser commands during the restart. For one week after the first health notice, the event log records the probe reason and the browser process state. These records contain no page URLs or titles. Herdr Boss migrates an old visible browser only when the recorded process ID shows that it started the browser. It never stops a browser that it did not start. The preview is not available when Chrome does not respond. Use **Manage** to close it. If Chrome does not accept the close command, Herdr Boss sends SIGTERM to that Chrome process only. **closed**: you used **Close browser**. A new browser request clears this state. **offline**: no Chrome runs with the project profile and it was not deliberately closed. **port conflict**: another process uses the port.

## Preview

**One tab** shows the selected tab with its address bar. **All tabs** shows every tab in one grid, without controls; select a tile to focus it. **Live** refreshes at the chosen interval. Without **Live**, the preview shows the last capture; **Refresh** takes a new one.

## Tabs

**Agent** marks a tab an agent uses. Screenshots never change a page. Navigation and input on an agent tab ask for confirmation first. **Hidden** marks a tab that is not visible; some web apps do not draw there. **New tab** opens a page of your own. Each tab row has a **Close tab** control. Before it closes a tab that an agent holds, the page asks you to confirm. It also warns you before it closes the last tab. A close never stops the browser.

## Address box

The first focus of the address box selects all its text. A second click places a cursor where you select it.

## Bookmarks

A project keeps at most 30 bookmarks. A bookmark name has at most 60 characters. A bookmark URL must use http or https and must not hold a user name or a password. **Add current page** saves the selected tab. **Open** loads a bookmark in the current tab; **New tab** opens it in a new tab. **Rename**, the arrows, and **Delete** change the list; Delete asks you to confirm. **Start page** opens in the first tab of the next launch. **Save** stores the start page; a blank value clears it.

## Control

Select the screenshot to open the large view. The large view shows a still image of the last capture. Turn on **Control browser** or **Live** to refresh it at the chosen interval. Turn on **Control browser**, then click the image and type. Paste long text or a password into the masked field. To sign in to a web app, enter its address in the sign-in field and select **Open sign-in tab**. Click the image, then type or paste the password and the one-time code. The sign-in route accepts the dashboard page on this computer or a page with a login session. On this computer, any local process counts as the owner for this route. Input without the sign-in flag stays open to project agents. The login stays in the project browser profile. On a phone the large view is full screen and the image fills the height. The text field and key controls appear only while **Control browser** is on.

Each project keeps its bookmarks in a closed dropdown. Select **Bookmarks N** to open it. Use **Filter bookmarks** to find a name or address. Select the summary again to close the list. **Open** loads a bookmark in the current tab. **New tab** opens it in another tab.

Turn on **Show tenant hosts** in Settings to show full hosts in project browser URLs on this dashboard. The browser page must send a same-origin signal. A process on this machine can still forge the headers. Use this setting only on the Owner's own machine. Other browser output stays masked.
