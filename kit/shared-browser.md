# Shared signed-in browser

The Chrome instance on CDP port `9222` is shared by several projects.

Treat its window, process, profile, and existing tabs as shared infrastructure.

## Before using CDP

Check that you are inside Herdr before using Herdr controls.

Probe the endpoint:

```sh
curl -s http://127.0.0.1:9222/json/version
curl -s http://127.0.0.1:9222/json/list
```

Read the tab list before browser automation.

Open a new tab for your task.

Use only a tab that you opened or that the orchestrator assigned to you.

Pin the tab ID or debugger WebSocket URL in every browser command.

Never use the active or focused tab as an implicit target.

Check the tab list again before closing your own tab.

Confirm that the tab ID still belongs to your task.

Set each CDP command timeout near 25 seconds.

## Keep shared state alive

Never close the shared Chrome window.

Never kill its process.

Never run `agent-browser close` on a session attached to this Chrome.

Never close, navigate, or reload a tab that another project owns.

Never print cookies, tokens, profile contents, or other credentials.

Leave the shared browser open when your task ends.

## Probe before recovery

Treat one unresponsive tab as a possible renderer failure.

Read the current tab list and note which tabs still respond.

Open a fresh `about:blank` tab and run a trivial evaluation against its pinned ID.

If the fresh tab responds, wait and retry the affected tab later.

If the fresh tab also fails, report the evidence to the orchestrator.

Probe `/json/version`, `/json/list`, and a fresh tab before any restart is considered.

Do not restart Chrome or attempt sign-in recovery yourself.

Send the probe results to the orchestrator and wait for its recovery decision.
