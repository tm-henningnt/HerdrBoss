# Project browser service

Each project has its own persistent Chrome profile and debugging port. Ask the orchestrator for the project slug, then request its browser with `herdr-boss browser request <slug>`. Read the tab list before acting:

```sh
herdr-boss browser tabs <slug>
herdr-boss browser tab new <slug> [url]
herdr-boss browser tab close <slug> --tab <id>
herdr-boss browser screenshot <slug> --tab <id> [--out DIR]
herdr-boss browser navigate <slug> https://example.com --tab <id>
herdr-boss browser click <slug> 42% 65% --tab <id>
printf '%s' "$TEXT" | herdr-boss browser text <slug> --stdin --tab <id>
herdr-boss browser key <slug> Tab --tab <id>
```

Give each browser worker its own tab. Open it with `browser tab new`, which prints the tab ID. The tab opens in its own background window. In a headless browser, a tab that shares a window with other tabs becomes hidden, and some web apps, such as the Qlik client, draw nothing in a hidden page. `browser tabs` shows `visibility` for each tab; check that it is `visible` before a capture. When a tab is hidden, open a new tab with `browser tab new` and use it instead. A driver that holds its own DevTools session can also call `Emulation.setFocusEmulationEnabled` with `enabled: true`; this lasts only while that session stays connected. When the worker is done, the orchestrator closes the tab with `browser tab close`. It refuses a tab that an agent is still attached to.

The screenshot command prints a private JPEG path. It writes the file under `$TMPDIR` when that variable is set. Otherwise, it uses a safe temporary directory. Pass `--out DIR` to select another directory; this overrides `$TMPDIR`. Inspect the file with an image-capable tool. Percentages for `click` refer to the screenshot from its top-left corner. If several pages are open, specify a tab ID for each command. `text` reads standard input so its contents do not appear in the command line. Do not put passwords or token-bearing URLs in shell arguments, reports, or logs; have the Owner enter credentials through the dashboard.

A script that drives the browser over CDP must end when its task ends. A process that exits closes its DevTools connection; the project browser keeps running. Do not keep a script alive to "protect" the browser, and do not leave a script running in the background. Stop every script that a worker started before the worker reports.

Browser navigation and input affect the same page other agents may use. Coordinate tab ownership with your orchestrator. Work only in the tab that your orchestrator assigned to you. Do not navigate, close, or send input to another agent's tab. `browser tabs` does not show the owner of a tab, so ask your orchestrator when you are not sure. The Owner can take screenshots of your tab from the dashboard at any time; this does not change the page. Do not restart or close a project browser while another agent is using it. The dashboard at `/browsers` provides live previews and human controls. `browser restart <slug> --headless|--visible` reopens the current page by default; add `--no-restore` to start blank. Reopening a page does not guarantee its login persists: the website or identity provider controls session lifetime.

Port 9222 is reserved for an optional legacy shared browser. Only use it when explicitly assigned; see [shared-browser.md](shared-browser.md).
