# Project browser service

Each project has its own persistent Chrome profile and debugging port. Ask the orchestrator for the project slug, then request its browser with `herdr-boss browser request <slug>`. Read the tab list before acting:

```sh
herdr-boss browser tabs <slug>
herdr-boss browser screenshot <slug> --tab <id>
herdr-boss browser navigate <slug> https://example.com --tab <id>
herdr-boss browser click <slug> 42% 65% --tab <id>
printf '%s' "$TEXT" | herdr-boss browser text <slug> --stdin --tab <id>
herdr-boss browser key <slug> Tab --tab <id>
```

The screenshot command prints a private JPEG path; inspect that file with an image-capable tool. Percentages for `click` refer to the screenshot from its top-left corner. If several pages are open, specify a tab ID for each command. `text` reads standard input so its contents do not appear in the command line. Do not put passwords or token-bearing URLs in shell arguments, reports, or logs; have the Owner enter credentials through the dashboard.

Browser navigation and input affect the same page other agents may use. Coordinate tab ownership with your orchestrator. Work only in the tab that your orchestrator assigned to you. Do not navigate, close, or send input to another agent's tab. `browser tabs` does not show the owner of a tab, so ask your orchestrator when you are not sure. The Owner can take screenshots of your tab from the dashboard at any time; this does not change the page. Do not restart or close a project browser while another agent is using it. The dashboard at `/browsers` provides live previews and human controls. `browser restart <slug> --headless|--visible` reopens the current page by default; add `--no-restore` to start blank. Reopening a page does not guarantee its login persists: the website or identity provider controls session lifetime.

Port 9222 is reserved for an optional legacy shared browser. Only use it when explicitly assigned; see [shared-browser.md](shared-browser.md).
