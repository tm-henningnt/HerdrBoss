# Fleet help

The head office reads each registered factory every 30 seconds. A factory outage keeps its last good summary and shows its age. The health cell becomes red and shows the reason. Last seen shows the last successful poll. Shared account quota uses the highest reading for each account and lane. It does not add repeated readings. A factory with no account record for a harness shows its own reading with the label `this factory only` and the tooltip `no account key`. That row stays out of the shared total. Spend shows USD by day, role, and harness.

The Fleet page keeps valid factory rows when another row is invalid. It shows up to three diagnostics in the registry error line. If more rows fail, the line adds `(N more)`. Each diagnostic names the safe row name, field path, and reason. It does not show row values or unknown property names. It shows `<unknown field>` for an unknown property. Doctor and `factory list` also print row diagnostics. The poller rejects the whole registry only when the JSON is unreadable, `schema` or `contractVersion` is wrong, `factories` is not an array, or factory names repeat. It ignores host records and other top-level fields. Factory read-modify-write commands keep rejected row data and normalize legacy image build times to whole seconds before inspection. A change that conflicts with a rejected row by name, factory ID, or port stops and names that row. Factory writers store new image build times to whole seconds.

Each fleet total shows a short coverage line. The line gives the as-of age, the count of reporting factories, and the names of the factories that are not fresh. Open Coverage detail under the totals to read the reason for each factory and the selected spend days.

Use factory connect NAME on the host tool machine to connect a registered container factory. Run it again to resume. Use factory connect --check NAME for one check with name, state, and age only. The command reuses a matching Tailscale Serve forward. If Serve needs Owner rights, it prints the masked error and two Owner command choices, then exits 3. Run one choice in the WSL Owner terminal. The dashboard access rule stays in force.

Each Fleet Mailbox link opens the factory that owns the item. Answer there. Open Fleet settings to change the name, dashboard base URL, polling, title sharing, or account scopes. Each field has its label above it. Each field uses the full width of the form. Credentials and account identities use private provisioning through the fleet command. They have no dashboard field.

The Fleet header shows the factory count, the poll time, and the head office holder. Select Add a host to open the Add a host page. Its target is at least 44 by 44 pixels at every width.

A quota lane badge and a project phase badge use a neutral background and the normal text colour. They stay readable in the light theme and in the dark theme.

Each alert shows the fix in words. Select **Fix** to show the fix. A fix can be a command or an instruction in words. Its copy button copies the displayed fix. A container login fix is the exact command. A native login fix is an instruction in words, for example `Sign in claude in a terminal on this Mac.`. A host action on a factory card, for example **Factory update**, opens a confirm sheet with the exact command, **Confirm copy**, and **Cancel**. The sheet reports success only after the copy reaches the clipboard. If the browser refuses the copy or has no clipboard, the sheet stays open and selects the command for a manual copy. The dashboard never runs a host command.

A container factory card shows one line about the Claude usage helper. The line reads `Claude usage helper: installed, last reading AGE ago` or `Claude usage helper: not installed, REASON`. AGE is in seconds below 60, then in minutes, hours, or days, for example `45s`, `12 min`, `2 h`, or `1 d`. REASON is one of: setting off, a statusLine from the Owner exists, the settings file is unreadable, no reading yet. A card without the line comes from a factory that does not report the helper. Fix a reason with the setting `factories.claudeUsageHelper` in the Settings of that factory, or run `herdr-boss factory update NAME --tier service` on the host tool machine.

A verified Owner wait shows `Waiting for you: STEP` in its factory card, below the comparison. The step is `login-HARNESS`. The factory adds the step only after its own check reads the login as expired. The line shows how long the factory waits. A container factory shows `herdr-boss factory login NAME HARNESS` with a copy button. A native factory shows the instruction in words. The page runs no wait command. An absent Boss is not a wait. A wait with no known fix, for example an unsupported step or a login reading of `unknown`, shows the step without a fix. It shows no command. When the wait age is not available, the line shows `waiting time unknown`.

Each remote factory card shows `Attach: attached` or `Attach: not attached` in its header. Attached means that Herdr on the Mac has an SSH machine for this factory. Select the copy button in the card to copy `herdr-boss factory attach NAME`. Run the command in a Mac terminal. Run `herdr-boss factory attach NAME --undo` to detach. The page shows no address or key.
Run factory login NAME claude, factory login NAME codex, or factory login NAME opencode in an Owner terminal. The command checks login and prepares the first-run state. For OpenCode it runs the login, then checks the credential list. It trusts the Boss folder, the work folder, and the registered project folders. It keeps other settings and credential files. Run factory boss start NAME to start the Boss. That command also prepares the first-run state before a start. If a startup dialog remains, the error names the dialog and pane ID. It includes masked pane text and prompt errors. Inspect that pane before you retry.

## Sign in to a factory dashboard

1. In an Owner terminal on the Mac, run `herdr-boss factory token NAME`.
2. Type the exact factory name when the command asks.
3. Select the printed token text and copy it. Paste it into the factory dashboard.

The command reads the configured `access.tokenFile` in the factory.
It requires TTYs on stdin and stdout.
It refuses `--json` and other output options.
It has no clipboard option.
Keep the token out of panes, chats, logs, and reports.

Run `herdr-boss factory token NAME --rotate` to sign out all devices.
Type the exact factory name.
The command writes a new token with mode `0600` and removes sessions.
It restarts only the dashboard service and waits for the new process and `/api/health`.
It then prints the token once at the Owner terminal.
The verified Boss pane may rotate, but it receives no token.
Its result shows only the factory name, the time, and `signed out all devices`.
Other Herdr panes are refused.
The caller checks prevent accidents and pane leaks.
A process of the same user can already read the token file.
If rotation stops, follow [the recovery steps](../guide/factory.md#recover-an-incomplete-token-rotation).
The factory guide also gives the manual fallback when the command is unavailable.

## Factory shares

At the head office, set one slider for each factory in an account scope. Use whole percentages from 0 to 100. The shares of one account must total at most 100. Select Save factory shares. The plan saves before delivery. A pending factory keeps its last accepted share. The next successful poll retries delivery.

The factory share is a local pacing ceiling above the project allocation. Project shares stay in the local policy. At the ceiling, new workers for that account stop. Ignore usage limit mode and --force cannot bypass it. Each factory keeps its last accepted share when the head office is offline or the service restarts. Until the first guidance arrives, its profile ceiling is 100. Quota readings measure the shared account. They do not measure the use of one factory.

## Nudge a factory Boss

Open Nudge a factory Boss. Choose a factory in an account scope. Write a nudge of 1 to 500 characters. Select Send nudge. The nudge reaches the pane labeled boss as an agent message. If delivery is pending, select Send nudge again with the same text. A repeated nudge does not send twice at the same epoch. Secret masking applies before delivery and storage.

The guidance credential can set shares and send nudges only. It cannot change policy, start or stop workers, or read message text. The factory refuses guidance from an older head office epoch. A read-only preview refuses shares and nudges.

Send guidance credentials only over HTTPS. HTTP is permitted only for a loopback target. The sender refuses other HTTP targets before it sends the credential.

The factory refuses an epoch more than 1000 above its highest stored guidance or role epoch. To recover from an incorrect epoch or holder, rotate the guide credential at the receiving factory. Rotation resets both stored epochs and holders, except on the factory that holds the head office role. It clears the nudge IDs of the old term and keeps the last accepted shares. Import the new credential at the head office through private provisioning.

If a fleet share file is invalid, the pacing view shows the problem and the service logs one warning. The local policy still loads with factory shares unset. A metered worker start refuses a failed share check. Unmetered worker starts do not read factory shares. Repair the fleet files to clear the problem.

## Head office role

The Head office panel shows the factory that holds the head office role and the epoch of its term. Only the holder polls the other factories and sends factory shares and nudges. A factory that sees a higher epoch stops both.

The panel also lists a factory that was never told of a move. Turn off head office polling on that factory. Keep head office polling off on every factory until it takes the role. A factory with polling on and no role record counts as the holder.

Move the role on the factory that takes it. Run `herdr-boss hub promote` in an Owner terminal. The command refuses when a registered factory cannot be reached. Run it with `--force` to continue without that factory. The new holder gets the factory list and the factory shares from the former holder, or keeps its own copy. It never receives host addresses. A factory on an unknown host stays out of its registry. See the move runbook in the factory chapter of the user guide.
