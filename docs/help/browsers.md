# Browsers help

Addresses, tab titles, and bookmark names mask outside hosts. Output removes query strings and fragments, bearer values, tokens, and JWT strings. A command error also masks an outside host inside a URL and an app UUID. Enter a complete address to navigate or change a start page. Bookmarks open through their stored index.

One persistent Chrome per project. Agents drive it; you can watch and help.

Each card shows the leased port and the CDP address `http://127.0.0.1:PORT` of the project, with a link to its row on the Allocation page.

## Start and manage

**Open visible** or **Open headless** starts the browser. **Manage** restarts it in the other mode, closes it, or sets the window size for the next launch.

## States

**ready**: Chrome runs with the project profile and answers on its debugging port. **not responding**: Chrome runs with the project profile, but its debugging port does not answer within 2 seconds, or two checks in a row failed during a quiet period. A responsive debugging endpoint suppresses the notice. A failed check does not count while a browser command runs, or during the next 20 seconds. A check opens a blank background tab, runs `1+1` in it, and closes it, at most once a minute. A connected CDP client doubles the step limit to 6 seconds and the total limit to 16 seconds. The card shows the reason and a **Restart** button. Restart keeps the current mode. It reopens saved web pages and blank tabs in a separate window for each tab. Restore drops query strings and fragments. A page that needs them reopens at its path. It also drops path parameters. It skips login and callback pages and sign-in hosts. Tab IDs change. A saved address can be older than the current page. It waits up to 30 seconds for a browser command to finish. It also waits for other CDP clients to disconnect. It refuses if a command or a client remains, or if the client count is unknown. An idle client can prevent a restart. It blocks new browser commands during the restart. For one week after the first health notice, the event log records the probe reason and the browser process state. These records contain no page URLs or titles. Herdr Boss never restarts a browser by itself. The preview is not available. Use **Manage** to restart or close it. If Chrome does not accept the close command, Herdr Boss sends SIGTERM to that Chrome process only. **closed**: you used **Close browser**. A new browser request clears this state. **offline**: no Chrome runs with the project profile and it was not deliberately closed. **port conflict**: another process uses the port.

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
