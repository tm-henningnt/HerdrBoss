# Project browser service

Each project has its own persistent Chrome profile and debugging port. Ask the orchestrator for the project slug, then request its browser with `herdr-boss browser request <slug>`. Read the tab list before acting:

Herdr Boss masks outside hosts in browser command output. Do not paste real URLs into reports. Use `--full` only when the Owner needs the real address.

Herdr Boss decides browser ownership by the Herdr workspace. Any pane in a project's workspace can change that project's browser, also an unlabeled pane and a worker. The Boss pane and every pane in the Boss workspace can change any project browser. This rule covers browser requests, size changes, close, release, restart, tab changes, page navigation and input, and bookmark changes. A refusal names the pane's workspace and the browser's project. A plain terminal outside Herdr skips the check with a warning.

Run each `herdr-boss browser` command as a plain command: no environment prefix such as `HERDR_ENV=1`, no wrapper, and no full path. The Codex allow rule matches only the plain command, and a sandboxed browser command fails with `spawn EPERM`.

```sh
herdr-boss browser tabs <slug>
herdr-boss browser tab new <slug> [url]
herdr-boss browser tab close <slug> --tab <id>
herdr-boss browser screenshot <slug> --tab <id> [--out DIR]
herdr-boss browser viewport <slug> --tab <id> <width>x<height> [--scale N] [--mobile]
herdr-boss browser viewport <slug> --tab <id> --reset
herdr-boss browser navigate <slug> https://example.com --tab <id>
herdr-boss browser click <slug> 42% 65% --tab <id>
herdr-boss browser drag <slug> 20% 60% 80% 60% --tab <id> [--steps N]
printf '%s' "$TEXT" | herdr-boss browser text <slug> --stdin --tab <id>
herdr-boss browser key <slug> Tab --tab <id>
```

Give each browser worker its own tab. Open it with `browser tab new`, which prints the tab ID. The tab opens in its own background window. In a headless browser, a tab that shares a window with other tabs becomes hidden, and some web apps, such as the Qlik client, draw nothing in a hidden page. `browser tabs` shows `visibility` for each tab; check that it is `visible` before a capture. When a tab is hidden, open a new tab with `browser tab new` and use it instead. A driver that holds its own DevTools session can also call `Emulation.setFocusEmulationEnabled` with `enabled: true`; this lasts only while that session stays connected. When the worker is done, the orchestrator closes the tab with `browser tab close`. It refuses a tab that an agent is still attached to. Pass `--force` to close a tab while an agent is attached, after the worker is done. A Codex worker with the Chrome DevTools MCP uses one tab only: its own tab from `browser tab new`.

The screenshot command prints a private JPEG path. It writes the file under `$TMPDIR` when that variable is set. Otherwise, it uses a safe temporary directory. Pass `--out DIR` to select another directory; this overrides `$TMPDIR`. Inspect the file with an image-capable tool. Percentages for `click` and `drag` refer to the screenshot from its top-left corner. `drag` presses at the first position, moves to the second in `--steps` steps, and releases. It does not move HTML5 files. If several pages are open, specify a tab ID for each command. `text` reads standard input so its contents do not appear in the command line. Do not put passwords or token-bearing URLs in shell arguments, reports, or logs; have the Owner enter credentials through the dashboard.

Set an exact page size with `browser viewport`. Width can be 200 to 3840 pixels. Height can be 150 to 2160 pixels. Scale can be 0.5 to 4 and defaults to 1. Add `--mobile` to enable the mobile viewport. The command sets the real window size, so every CDP client sees it. It falls back to emulation and says so. Headless Chrome keeps a window at least 500 px wide. For a narrower size, the command uses emulation, which only herdr-boss sessions see. The size stays active until you reset it, close the tab, or restart the browser. Run `browser screenshot` to capture the page at that size. The `browser size` command sets the window size for the next launch.

A script that drives the browser over CDP must end when its task ends. A process that exits closes its DevTools connection; the project browser keeps running. Do not keep a script alive to "protect" the browser, and do not leave a script running in the background. Stop every script that a worker started before the worker reports.

Browser navigation and input affect the same page other agents may use. Coordinate tab ownership with your orchestrator. Work only in the tab that your orchestrator assigned to you. Do not navigate, close, or send input to another agent's tab. `browser tabs` does not show the owner of a tab, so ask your orchestrator when you are not sure. The Owner can take screenshots of your tab from the dashboard at any time; this does not change the page. Do not restart or close a project browser while another agent is using it. The dashboard at `/browsers` provides live previews and human controls. `browser restart <slug> --headless|--visible` reopens the current page by default; add `--no-restore` to start blank. Reopening a page does not guarantee its login persists: the website or identity provider controls session lifetime.

A project browser is "not responding" when its Chrome process runs with the project port and profile, but `GET /json/version` on the port does not answer within 2 seconds. The bulletin and the Browsers page show this state. Do not use a "not responding" browser. Tab, screenshot, and input commands fail for it. Tell your orchestrator. The Owner restarts or closes it on the Browsers page. An orchestrator can run `herdr-boss browser restart <slug> --headless|--visible` or `herdr-boss browser close <slug>` for its own project only. When the browser does not respond or does not accept the close command, Herdr Boss sends SIGTERM to the Chrome main process for that port and profile. It waits up to 8 seconds and never sends SIGKILL. A restart of a "not responding" browser does not reopen the current page. Do not send signals to Chrome yourself.

## Browser choice for checks

- For dashboard and web checks, prefer the project browser. Run `herdr-boss browser request <slug>`, then use `browser tabs`, `browser tab new`, and `browser screenshot`.
- `playwright-cli` and `agent-browser` are also permitted. Close their sessions when you are done.
- Google Chrome leaves a code-sign clone when it does not exit cleanly. Herdr Boss removes orphaned clones every 10 minutes. The clones share disk blocks with the Chrome app, so they use little real space.
- Close Chrome with `herdr-boss browser close <slug>` or the CDP command `Browser.close`. Never send a signal to Chrome yourself.

Use only the browser of your project. Herdr Boss never stops a browser that it did not start.
