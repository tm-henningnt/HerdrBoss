# Something went wrong

This chapter lists the common problems and the first thing to do for each. Words in *italics* are in the [glossary](../glossary.md). Each section has the same parts: what you see, what you do, and what you should see after.

WARNING: Never paste a token, a key, or a password into a chat to get help. Never print a file from `~/.config/herdr-boss/`.

## The usage reading failed

You see "unknown" or an error in place of a *usage limit* on the dashboard.

What you do:

1. Run `herdr-boss logs`. Look for lines about `codexbar`.
2. Open CodexBar. Set the Claude usage source to **Auto**. Do not use **CLI**, because it is slow.
3. Wait 5 minutes. Herdr Boss reads the usage limits every 5 minutes.

What you should see: a percentage for each *provider*. If a Claude reading times out at about 30 seconds, the source is still **CLI**. [harness-setup.md](../harness-setup.md) explains how to read `quota-probe-history.jsonl`.

If it does not work: sign in to the agent app again. An unknown reading stays unknown. Herdr Boss never guesses a usage limit.

## An agent waits for permission

You see an agent that stops and asks you a question in its pane, again and again.

What you do:

1. Run `herdr-boss harness check`. It lists each missing setting.
2. Run `herdr-boss harness sync`. It adds the safe settings and prints the Claude lines that are missing.
3. Add the Claude lines yourself. Only you edit the Claude settings file. The steps are in [harness-setup.md](../harness-setup.md).
4. Start a new session of the agent app.

What you should see: no missing line in `harness check`. The agent does routine work with no question. The Analytics page shows how often each agent app was denied.

If it does not work: answer the question in the pane when it is safe. Never tell an agent to work around a denial. Ask the Boss in the Chat.

## A worker stopped

You see a worker that does not move, or a task in the lane "Stuck" on the Board.

What you do:

1. Run `herdr-boss worker list`. It shows each unfinished run and the status of its agent.
2. Open the Agents page. Find the worker.
3. Ask the project lead in the Chat what the worker does. The project lead decides to wait, to send the task again, or to start a new worker.

What you should see: the project lead reports the state. A worker that stopped early has a report with `stoppedEarly: true`. The task leaves the lane "Stuck" when work continues.

If it does not work: check your usage limits. A limit that is used up stops new work. See [Limit the cost](cost.md).

## A host is unreachable

You see `host-unreachable` for a factory, or a red health cell on the Fleet page.

What you do:

1. Check that the host is on and that Tailscale shows it as connected.
2. Run `herdr-boss factory ssh <host> -- uptime`.
3. On a Windows host, wait 5 minutes. The repeating boot task starts WSL again when it stopped without a reboot.
4. Run `herdr-boss factory connect --check <name>`.

What you should see: the host answers and the Fleet page shows a green health cell. The Fleet page keeps the last good summary and its age during an outage.

If it does not work: continue work on another host. Do not call a container stopped or unhealthy while the host cannot answer. Do not restart an unrelated service. Check the host steps in [Add a factory](factory.md).

## The dashboard does not load

You see an empty page, a timeout, or an error in the browser.

What you do:

1. Run `herdr-boss doctor`. Read the line for the *service*.
2. Run `herdr-boss logs`.
3. Run `herdr-boss install` to start the service again.
4. Run `curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:4477/api/state`.

What you should see: the number `200` and the *Overview* in the browser.

If it does not work:

- On a phone, check Tailscale first. See [Use it from your phone](phone.md).
- If the form refuses your token, copy the token again.
- If the browser names a host that is not allowed, add the name in Settings, under Advanced, in the Service settings.

## A project browser is stuck

You see the label **Not responding** on a browser card on the Browsers page.

What you do:

1. Open the Browsers page.
2. Select **Restart** on the card of the project.
3. If it stays stuck, select **Close browser**. The profile stays.

In a terminal, run `herdr-boss browser restart <project> --headless`, or `herdr-boss browser close <project>`.

What you should see: the label goes away. Saved pages open again. Never stop a browser that another project uses.

If it does not work: ask the project lead of the project to run the command. Only a pane in that project or the Boss can change its browser.

## The usage reading is missing on Linux

You use Linux and the dashboard shows no usage limit for an agent app.

What you do:

1. Know that CodexBar does not exist on Linux. Herdr Boss reads usage limits with it on a Mac.
2. Run `herdr-boss doctor`. Read the line for CodexBar. It is optional.
3. Work without the reading, or use the agent app limits that the app itself shows.

What you should see: the usage limit of OpenCode Go shows as unknown, with the reason `no usage reader in this factory`. The Codex usage limit shows a reading, or an unknown reading with a Codex reason. The Claude usage limit shows a reading while a Claude session runs in the factory. Otherwise it shows `no Claude session has reported usage yet`. Herdr Boss does not treat this as a failure. It sends no Boss warning and takes no back-off. Everything else works.

If it does not work: the Linux usage reader is open work. [linux-usage-reader.md](../ideas/linux-usage-reader.md) lists the options.
