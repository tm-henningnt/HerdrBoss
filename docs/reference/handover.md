# Handover reference

## Orchestrator handover

When an orchestrator's quota comes near its reserve, Herdr Boss recommends a successor. The Boss pane uses the same handover path by its `boss` label. Its quota notice goes to the Owner. The Boss workspace stays out of project shares and project notices.

1. Plan the handover on the project page, or run `herdr-boss handoff plan`.
2. Prepare the successor. It starts in a new tab and only reads and reports.
3. Inspect the successor's response.
4. Confirm activation. For a project, the successor pane gets the label `orch`, and the old pane gets `orch previous`. For the Boss, the successor pane gets `boss`, and the old pane gets `boss previous`.

Without `--model`, plan and prepare use the target kind's default model in `kit/models.json`. The policy's `preferredModels` value does not replace this default. The result shows `modelSource: "default"`; a model passed with `--model` shows `modelSource: "flag"`. The model `claude-opus-5-5` and its aliases `opus`, `opus-5-5`, and `claude-opus` need the Owner's approval. Handoff uses the same case folding and bracket-suffix removal as worker start. Ask the Owner, then run `handoff plan` or `handoff prepare` with `--force`. A forced Opus prepare sends the Boss the same one-line alert as a forced Opus worker start.

Run `herdr-boss handoff cancel ID` to cancel a prepared handoff. The command marks it expired with reason `cancelled` and prints one line. It leaves the pane open when it is the source pane, its agent does not match the target kind, or its label is `orch` or `boss`. It closes an eligible successor only when its agent is idle or done; add `--force` to close a working or unsettled agent. It re-reads the record before saving so a concurrent activation or expiry is not overwritten. It refuses a handoff that is already active or expired. A cancelled handoff does not create the 30-minute expiry Mailbox item.

Activation checks that the successor agent is settled and ready. The handoff record keeps the activation time, the source pane ID, and the successor pane ID. At activation, Herdr Boss re-owns the locks, leases, and waiting suite runs of the old pane to the new pane in the same project workspace, so the new orchestrator can see and release them.

Herdr Boss activates a prepared automatic successor when all of these are true:

- The source orchestrator pane is `idle` or `done`. A running worker does not block activation. It keeps the project active.
- The successor pane is `idle` or `done`.
- The project is not held or stood down, and the pane is not the Boss pane.
- The successor model is not weaker than the source model.

An orchestrator that finished its turn and waits at a gate is `idle` or `done`, so it can hand over. While a prepared automatic context successor waits, the Overview shows `handover waits:` and the reason. A successor without a ready signal shows `successor not ready:` and the cause: the prepare prompt failed or stalled, the pane is absent, the pane runs another agent, the pane works, the pane has not started its state read, real text is still in its input box, the engine sent Enter and is waiting for new start evidence, or the 120-second readiness wait is not over. For automatic context records, the engine state gives the same reason in `handoverWaits`, by handoff ID.

The engine checks readiness for every prepared successor, including a manual successor when automatic handover is off. It marks the successor ready when the pane is idle or done, the prepare prompt had no error, and at least 120 seconds passed after the prompt. The engine must have seen the pane work after the prompt, or it must have evidence that the successor started. For a Claude successor, positive context usage in its session transcript is evidence. The Claude screen must also show its input prompt. A blank pane or a trust dialog is not ready. An empty input prompt with a recap and a status line can be ready. A fresh Claude pane has zero context usage. Other harnesses have no usable context signal, so the idle time is enough. A working successor is never ready. Real unsent text in the input box blocks readiness. A dim SGR 2 suggestion after the prompt mark is empty input. When the engine finds real unsent text, it sends one Enter key. It then waits at least 20 seconds and reads the screen again. While the text is still unsent, it sends Enter again after each wait, at most 3 retries. After the last retry it sends the Boss one notice. Unsent text includes a long prompt that wraps over many lines, a prompt whose first line scrolled off the pane, and a dim `[Pasted text #N]` placeholder. A dialog with numbered choices and a blank pane get no Enter. For Claude, it requires new start evidence after Enter. For another harness, a fresh idle check is enough. The engine reads the transcript tail at most once every 30 seconds while the file stays unchanged. It reads the pane input at most once every 15 seconds. Readiness sets `readyAt` only. Activate a manual successor with `herdr-boss handoff activate ID --confirmed`.

If a prepared project successor is idle or done and still unready 10 minutes after its prompt, Herdr Boss sends one prompt to the pane labeled `boss`. This notice covers project records only. A record with a failed prepare prompt gets no notice. The prompt names the handoff ID and the successor pane. It gives the commands to inspect the pane and activate the successor by hand. If the Boss pane is absent or the prompt fails, Herdr Boss retries every 5 minutes, up to 3 failures. It logs one error when it stops retrying. Herdr Boss records a successful notice, so a service restart sends no second notice.

A project successor that is still not ready 30 minutes after preparation expires. This rule applies to manual and automatic handovers. Herdr Boss sends one prompt to the Boss for that handover. The prompt names the handoff ID, the pane, and the project, and says `expired after 30 minutes unready`. This expiry creates no Owner Mailbox item. A recorded Mailbox notice from an earlier version counts as delivered. Herdr Boss also skips the notice for a record that expired more than 1 hour ago. The pane-close checks still run for those records. Herdr Boss closes the successor pane only when the pane runs the expected agent, is idle, and is not the source pane or in use by another handover. It keeps a pane that works. If the Boss prompt or the pane close fails, Herdr Boss retries that action every 5 minutes, up to 3 failures. It logs one error when it stops retrying. A ready context successor can wait up to 24 hours for activation. Another ready automatic successor can wait up to 2 hours if its source provider is no longer near its limit.

After activation, Herdr Boss finishes the handover. It waits until the successor answers the activation prompt, or until 15 minutes pass with the old pane idle. It then renames the successor tab from `Orchestrator Next` to `Orchestrator`. The rename does not wait for the old pane. Herdr Boss then closes the old pane. The status `done` counts as idle, because a `done` pane finished its turn. Herdr Boss never closes the old pane while that pane works, is blocked, or was settled for less than 60 seconds. A running worker does not keep the old pane open. It also keeps a pane whose label is not `orch previous`. The Owner closes the old Boss pane by hand; this early close applies only to project orchestrators. It retries on each tick, and it sends one line to the Boss when the old pane is still open after 60 minutes. The line names each reason. The Overview shows `closing old orchestrator at HH:MM` on the new orchestrator until the pane is closed. Herdr Boss also closes the tab of a successor that expired or was replaced without activation.

Activation labels the old pane as previous. If the early close did not run, Herdr Boss closes that pane after 120 minutes from activation when the handoff, the previous-role label, and the successor-role label are still confirmed. A newer handover does not cancel this retirement. Herdr Boss marks the older handover as superseded when the new handover starts from its successor pane and has the same role. The engine also marks older records on each active tick. It follows a chain of superseded records to the current successor before it closes a pane. Unavailable pane data defers retirement until a later tick. The current successor gets one notice after retirement.

At activation, Herdr Boss prompts the previous agent first. The prompt tells it that it no longer owns orchestration. It asks for a concise final summary for the successor. It tells the agent to answer each later request only with the successor pane ID. A Boss handover uses Boss and Owner wording. This prompt is best effort. If it fails, the engine sends it again later.

If the Owner closed the source pane before activation, Herdr Boss skips the source label and the previous-agent prompt. The record keeps `activation.sourceMissing: true`. The successor prompt says that the source pane was closed and does not ask for a final summary.

Herdr Boss then prompts the successor. The prompt gives its own pane ID, the previous pane ID, and how Herdr Boss built its session. It tells the successor to read the previous agent's final summary when it is available, to take over the current work, and to use its own pane ID in worker briefs, reports, and messages.

Herdr Boss then prompts each running worker of the project, once for each handoff. A running worker is a worker with a run record that has no `finishedAt` and a live agent pane. The prompt is one line: `Your orchestrator is now <slug>-orch (pane <new pane>). Send WORKER REPORT and WORKER QUESTION there.` Herdr Boss skips a worker whose pane is gone. A failed prompt is logged and does not fail the activation. Herdr Boss makes one attempt for each worker and handoff. It does not prompt a worker again after a failed prompt. The record field `workerPrompts` keeps the result for each worker. Herdr Boss saves the record before it sends each prompt. A Boss handover prompts no worker.

After activation, the engine sends handover notices:

- A project handover notifies each agent worker in the project workspace and the active pane labeled `boss` in any workspace.
- A Boss handover notifies each agent in the Boss workspace and sends the Owner a Herdr notification with the new Boss pane ID.

Agent prompts need push to be on. A prompt goes only to an idle or done agent pane. A successful notice is recorded and is not sent again. A recipient that is unavailable or fails stays eligible, and the engine tries it again after one minute.

Herdr Boss sends handover notices only for active records. A superseded record sends no new notice. Herdr Boss records the Boss notice once for each handover. A change to the Boss pane does not send the notice again. Herdr Boss also treats an earlier notice key for a Boss pane as delivered.

Preparation waits up to 90 seconds for the new pane's foreground shell and a prompt or a stable screen before Herdr Boss starts the agent. Ordinary `worker start` keeps its 20-second readiness wait. If agent start reports `agent_pane_busy`, Herdr Boss checks shell readiness again and retries once. If the pane shows an interactive question, answer it in a shell once, then retry `handoff prepare`. The new tab disables update prompts and automatic updates. Each active engine tick expires a `prepared`, `preparing`, or `needs-inspection` record when a successful current pane list does not contain its successor pane. `handoff prepare` repeats this check before retrying. A failed pane list keeps the record active. A missing successor pane is not closed. The 30-minute timeout for a project successor that is not ready uses the separate rule above.

If a `needs-inspection` record still has a pane in the current Herdr pane list, repeat `handoff prepare` for the same source pane, target kind, and mode. Herdr Boss waits for that pane to become ready and starts the successor there. It keeps the existing handoff record and pane. If the pane does not become ready, the record stays `needs-inspection` and the command reports the readiness error. If a successful current pane list proves that the pane is absent, the record expires and prepare can create a new successor.

Migration moves the conversation history with [session-migrate](https://github.com/xhluca/session-migrate). It does not move credentials, hooks, or runtime settings. If migration is unavailable or transfer fails, Herdr Boss prepares a fresh successor and records the reason.

A migrated session must fit the context window of the target model. The plan converts the session into a temporary directory, measures its `.jsonl` files, and deletes the directory. It estimates one token for each 4 bytes. The session fits when the estimate is at most 60% of the target window. The limit leaves space for the successor's own work. When the session does not fit, the plan marks migration as unavailable and names the estimate and the limit. The project page then shows `Migration unavailable:` with that text. Preparation uses fresh mode and records the same text as the reason. The successor prompt at activation includes the reason. When the measurement fails twice, or when the target model has no window, migration stays available and the plan shows a warning.

The window of a model is in `kit/models.json`. The `contextTokens` field of a kind gives the window in tokens for all models of that kind. The `contextTokensByModel` object gives the window for one model and overrides `contextTokens`. Both fields are optional. Each value must be a positive integer.

Herdr Boss copies the optional Owner goal from the latest published project status into the handoff record and successor prompt. The goal must be a non-empty string of at most 1000 characters. An invalid published goal is omitted, and preparation continues without it. It does not assign a project goal to a Boss handoff. For a fresh successor, Herdr Boss captures at most 200 recent lines and stores at most 20,000 characters from the source pane. Both caps include the truncation marker. It redacts likely credentials. If the recent read fails, it tries the visible pane. If both reads fail, the record says that context is unavailable. The prompt labels this snapshot as historical context. The successor only reads and reports until activation.

**Automatic handover** is off by default. Turn it on in Allocation, and rank the successor choices under **Orchestrator succession**. Herdr Boss then prepares a successor at the reserve, waits for it to run `herdr-boss handoff ready`, and activates it at the set quota level (98% by default). An automatic successor that was not needed expires two hours after preparation when its source provider is no longer near its limit.

Herdr Boss recommends the first succession choice that can start, preferring a non-Opus choice when one is eligible. The dashboard and the automatic handover use the same choice. Herdr Boss skips a choice in these conditions:

- The choice uses the harness or the provider of the current orchestrator.
- The harness or the model is not allowed, or the project excludes it.
- The metered provider of the model is near its limit or exhausted.
- The unmetered model is exhausted until its retry time.
- The choice is a Pi model that the last good `pi --list-models` result does not list. Without a good result, Herdr Boss does not skip a Pi model.

If Opus is the only eligible choice, automatic handover does not prepare it. The engine sends the Boss one notice for that handover key. The notice says that Owner approval is needed and gives the `herdr-boss handoff prepare PANE --to claude --model claude-opus-5-5 --force` command.

The Owner can approve Opus starts for workers once. Turn on **Allow Opus without --force** in Settings, then select **Apply policy**. The policy key is `opus.allowWithoutForce`. Then `herdr-boss worker start` starts a Claude Opus worker without `--force`. **Running Opus workers at most** (`opus.maxConcurrent`, default 2) limits the Opus workers that run at the same time. A start at the limit fails with a message that names the setting. `--force` skips the limit. The setting does not change the handover rules above.

When no choice can start, Herdr Boss recommends no successor. The automatic handover then logs that no alternative provider is eligible.

The automatic handover never touches the Boss. It prepares and activates no Boss successor, and it activates no prepared Boss record. The Owner does each Boss handover by hand. The Boss project page keeps its successor recommendation.

The Overview lists only handover records in the state `prepared`, `preparing`, or `needs-inspection`. It lists a record only when the source pane and the successor pane are still in Herdr. It shows no recommendation without a record, and no Boss recommendation. Plan a handover without a record on the project page.

The automatic handover prepares a successor only for a project that works now. A project qualifies when its allocation reports a running worker, or when a pane in its workspace runs an agent in a `working` state. A workspace with no working agent and no running worker waits. A stopped orchestrator in a workspace with a working worker stays eligible.

The automatic handover also skips a project that the Owner holds. A project is held when its published status is `paused`, `stood down`, or `on hold`, or when its published summary says that it is paused or stood down. A status or summary in another case, spacing, or hyphen variant counts as the same word. A summary that reports the state of another project, or of one task, does not hold its own project. An allocation mode of `paused` holds the project.

The automatic handover activates a prepared successor only when the successor model is not weaker than the source model. The tiers follow the cost order in `kit/models.md`, from the free models up to Codex Astra. A model the kit does not rank has no tier. When either model has no tier, or the successor is weaker, Herdr Boss leaves the record prepared and logs one line that names the reason. The Owner then runs `herdr-boss handoff activate ID --confirmed` when the weaker model is the right choice.

The automatic handover has a second trigger, the context size. It runs only when `autoHandover` is on. Set the limit in Settings as **Hand over at context tokens**, or in `policy.json` as `autoHandoverContextTokens`. The default is 300000 tokens. The value is an integer from 50000 to 2000000. Herdr Boss compares the token count with this value. It does not use a percent of the model window. For example, 280000 tokens is 28% of a 1M window and stays below the default limit. The log line of a prepared handover names the token count and the limit.

Set a second limit as **Force handover at context tokens**, or in `policy.json` as `autoHandoverForceContextTokens`. Its default is 400000 tokens. It must be higher than `autoHandoverContextTokens`. Above this limit, Herdr Boss asks the Claude project lead to write and commit `docs/orchestration/memory.md`. It sends this prompt once. Herdr Boss waits for a later commit that changes this file. It checks the repository on each engine tick for up to 20 minutes. It prepares a fresh successor after it finds the commit. If it finds no commit within 20 minutes, it prepares the successor and sets `memoryUpdateStatus: "not-updated"` in the handoff record. This successor cannot activate yet. Herdr Boss keeps checking for a later memory commit. When it finds one, it records `memoryUpdateStatus: "committed"` and the commit id. The Owner cannot activate the successor before that commit.

When an old policy has `autoHandoverContextTokens` at or above 400000 and has no `autoHandoverForceContextTokens`, Herdr Boss adjusts the pair when it loads the policy. It sets the force limit to the next 10000-token step. If the old normal limit is 2000000, it lowers that limit to 1990000 and keeps the force limit at 2000000. Save the policy to keep the adjusted values.

A handover carries the Owner goal to the successor as plain text by default. Set the goal for an orchestrator with no goal in Settings as **Default orchestrator goal**, or in `policy.json` as `defaultOrchestratorGoal`. The value is one line of at most 4000 characters. An empty value turns the default off. The handover record and the project page show the goal as one collapsed line. Turn on **Automatic Claude goal command** in Allocation, or set `goals.autoCommand` to `true`, to send `/goal` to Claude after activation. This setting also controls new-project setup. It does not change manual **Set goal** or `herdr-boss goal set`. A prepared successor prompt always gives the goal as plain text. It never sends a `/goal` command before activation.

A task boundary starts the check. A boundary is one of these events:

- A task in the published project status changes to `done`.
- The orchestrator pane goes from `working` to `idle` or `done` after a new publish.

At a boundary, Herdr Boss reads the context size of the orchestrator. When the size is above the normal limit, Herdr Boss prepares a fresh successor from `docs/orchestration/memory.md`. Above the higher limit, it also starts the memory update flow described above. The successor has the same harness and the same model as the source. The successor reports ready with `herdr-boss handoff ready`. If the successor does not report, Herdr Boss applies the automatic ready rule above after 120 seconds. The record then shows `readyNote: auto: successor idle`. Herdr Boss activates the successor when the source pane is `idle` or `done`. If the source pane works, Herdr Boss waits. Above the higher limit, Herdr Boss may prepare while the source works, but it cannot activate until the memory commit is verified and the source is idle or done.

Herdr Boss reads the context size only for a Claude orchestrator. It takes the last main-thread assistant message in the session transcript in `~/.claude/projects/`. The size is the sum of `input_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens` of that message. For another harness, or when the transcript is missing, the context size is unavailable. Herdr Boss then logs one line and starts no context handover.

When a Claude orchestrator reaches 400000 tokens and no prepared handover is ready, Herdr Boss raises a warning with the key `context:<project>`. The title gives the rounded size, for example `Context at 400K tokens: handover not ready`. The warning stays active while the context is at least 400000 tokens and no handover is ready. Herdr Boss sends the warning no more than once in 60 minutes. It clears when the context falls below 400000 tokens or a handover activates.

Herdr Boss watches a pane from its first tick. A pane that Herdr Boss sees for the first time is unarmed: a task that was already done, or a pane that was already idle, is not a boundary. An idle orchestrator whose project has no running worker and no working agent waits. The check runs after work starts again and the next boundary arrives.

The context trigger uses the same rules as the quota trigger. It skips the Boss, a held project, and a project that does not work. It activates no successor with a weaker or unranked model tier. It prepares no second successor while a record for the same pane is `prepared`, `preparing`, or `needs-inspection`. Turn off **Automatic handover** to stop both context triggers.

### Set the goal of a running orchestrator

Use **Set goal** to give a running orchestrator a new `/goal`. A `/goal` that arrives while the agent works is queued as plain text and does not run. Herdr Boss therefore waits until the pane is idle.

1. Open the project page or the Agents page. Find the orchestrator of the project.
2. Select **Set goal**. A dialog opens with the text field. The field starts with the **Default orchestrator goal** from Settings. Edit the text if you need to. The limit is 2000 characters.
3. Read the warning. The command waits until the pane of the orchestrator is idle. The wait can take up to 10 minutes.
4. Select **Set goal** in the dialog. The dialog closes and the status line under the goal shows the progress.

The status line shows `Waiting for an idle pane`, `Sending the command`, `Checking that the pane shows the goal`, `Goal active`, or `Goal not set` with the reason. The line above it shows the current goal in one collapsed line. Select it to read the whole goal.

Herdr Boss sends nothing while the agent works, a dialog is open, or the input box holds typed text. A dim suggestion in the input box does not block the command. The status line shows the current reason: `the agent works`, `a dialog is on screen`, `the input box holds unsent text`, `the pane is not an orchestrator`, or `the pane is gone`. Herdr Boss never clears or edits the input box.

The wait ends after 10 minutes for `the agent works`, and after 2 minutes for `the input box holds unsent text` and `a dialog is on screen`. The job then fails with `Goal not set` and the reason. Herdr Boss adds one Mailbox item that asks you to send or clear the draft, or answer the dialog. It adds at most one item for each project and reason in one hour. Select **Set goal** again after you act. If the pane does not show the goal after 3 tries, the job fails with `sent but not shown`. Look at the pane.

**Cancel** in the status line stops a job that still waits. After a restart of the service, a job that was running shows `Interrupted`. Select **Set goal** to start it again. If the session expired, the line shows `Sign in again`.

Herdr Boss allows **Set goal** for a project that is paused or stood down. You can prepare the goal before the project runs again.

Herdr Boss counts the goal as active only when its text is new on the screen after the send, and the pane shows the goal confirmation or is idle with an empty input line. A goal that is only typed or queued in the input line does not count. An old identical `/goal` in the scrollback does not count.

The command line does the same: `herdr-boss goal set <project|pane> [--text TEXT] [--dry-run]`. See `docs/cli.md`.
