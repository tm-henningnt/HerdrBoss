# Model lanes

Use the machine allow-list in [`models.json`](models.json) as the source of truth.

This file describes observed task fit. It does not grant permission to use a model.

Check the bulletin and the live allow-list before every dispatch.

## Cost order

The observed order from lower to higher cost is:

1. Free `opencode/` models, including Muse Spark and Mimo.
2. `opencode-go/deepseek-v4.1-flash`.
3. Codex `gpt-6-luna`.
4. Claude `claude-sonnet-5-5`.
5. Claude `claude-opus-5-5` and Codex `gpt-6.1-sol`.
6. Codex Astra.

Treat this order as a routing hint.

Use an unmetered model first for every bounded, well-specified task: implementation, tests, docs, audits, and data checks. Do this whatever the pace of the metered lanes. A metered lane with pacing turned off is still a finite weekly quota. Use metered models for work that needs judgment, and when the unmetered lanes fail. Read the unmetered lane in `herdr-boss lanes` and the bulletin **Use now** line, which lists the unmetered lane first.

Provider quota, task fit, availability, and review effort affect the real cost.

## Codex prices

Prices are in USD per million tokens. Source: the vendor announcement of `gpt-6.1-sol`.

| Model | Input | Output | Cached input |
| --- | ---: | ---: | ---: |
| `gpt-6-astra` | 10 | 50 | 1 |
| `gpt-6.1-sol` | 2 | 10 | 0.10 |
| `gpt-6-luna` | 0.10 | 0.50 | 0.01 |

`gpt-6-luna` costs about 20 times less than `gpt-6.1-sol` in input. Use `gpt-6-luna` for routine Codex work. Use `gpt-6.1-sol` for tougher coding, where a result close to `gpt-6-astra` matters. In the vendor test, `gpt-6.1-sol` matches `gpt-6-astra` on complex coding at about one fifth of the cost.

In the vendor test, a model failed to report a broken search tool in these cases: `gpt-6-astra` 1.5%, `gpt-6.1-sol` 2.8%, `gpt-6-luna` 28.7%. `gpt-6-luna` often guesses and does not say that a tool failed. The worker brief for `gpt-6-luna` therefore tells the worker to report a failing tool, a missing file, or missing evidence, and never to give a best guess. Verify each `gpt-6-luna` claim at the source.

`gpt-6.1-sol` is a trial candidate for review passes and diff reviews that go to `claude-opus-5-5` now. Measure it with the Analytics scorecard before you move review work. The ultrafast variants need the Pro tier at 500 USD per month and are not in use.

## Task lanes

| Kind and model | Best fit | Limits |
| --- | --- | --- |
| `claude`, `claude-sonnet-5-5` | The default Claude worker: implementation, review, and browser checks. | Use it when an unmetered model is not enough for the task. |
| `claude`, `claude-opus-5-5` | The hardest judgment work, and orchestrators. | Reserve it for work that `claude-sonnet-5-5` cannot do well. `worker start` refuses `claude-opus-5-5`, and its aliases `opus` and `claude-opus`, without `--force`. Ask the Owner first. |
| `codex`, `gpt-6-luna` | The default Codex worker for routine work: bounded implementation, tests, docs, and review fixes. | Review root causes and pixel claims. Long sessions can stop without a final report. |
| `codex`, `gpt-6.1-sol` (trial) | Tougher programming tasks: cross-cutting fixes, algorithms, takeovers, and tasks where `gpt-6-luna` needed rework. Cost effective and close to Astra level. | Trial until the Analytics scorecard has about 10 runs for this model. Record `--model-result` for every run with `worker collect --record`, so rework and time can be compared with `gpt-6-luna`. |
| `pi`, `opencode-go/deepseek-v4.1-flash` | Economical research and fully specified mechanical work. | Shared Go quota can stop every worker on that provider. Pin the model and verify results. |
| `pi`, `opencode-go/muse-spark-1.3-contributor` | Cheap bounded implementation, docs, copy, and read-only diagnosis. | Source records disagree on its success rate. Keep the task atomic and inspect every path. |
| `pi`, `opencode-go/space-bunny-free` and `opencode-go/longcat-2.5-preview-free` (unmetered) | Bounded, well-specified implementation, tests, docs, audits, and data checks. | Evidence is limited. Verify the full diff and each finding at its source. |
| `opencode`, free `opencode/` models (unmetered) | Bounded, well-specified implementation, tests, docs, audits, and data checks. | Give an exact brief and a clear gate. Verify the full diff. Permission prompts and provider overload can stop work; then move the task to another lane. |

Free `opencode/` models recorded in the source include:

- `opencode/big-pickle`
- `opencode/ling-3.0-flash-fin-free`
- `opencode/mimo-v2.6-flash-free`
- `opencode/muse-spark-1.2-contributor-free`
- `opencode/nemotron-3-ultra-free`
- `opencode/nemotron-3.5-lightning-free`
- `opencode/space-bunny-free`

## Removed until a trial passes

- `opencode/muse-spark-1.3-contributor-free` — removed 2026-09-29; every call failed.

This list is descriptive only. `models.json` decides which models workers may use.

Free `opencode/` models run only in the OpenCode harness. The Pi allow-list holds only `opencode-go/` models.

Herdr Boss hides a Pi model that `pi --list-models` does not list. Confirm a worker start before you rely on a model.

Prefer DeepSeek for substantial mechanical work when both DeepSeek and Muse Spark are available.

Use Muse Spark only for narrow, bounded work when its model fits the task.

## Harness rules

### Claude

Start Claude workers with `--permission-mode auto`. The worker then uses the auto-mode classifier with the Owner's `autoMode` rules, like the orchestrators. Without it, a worker runs in the default mode and can stop on a permission dialog, also for a read-only command in its own worktree.

### Pi

Pin a Pi worker to one allowed model.

Disable extensions that can start unpinned subagents.

Keep the Herdr state reporter enabled.

Keep the Herdr guard enabled. `~/.pi/agent/extensions/herdr-guard.ts` blocks file tools outside the worktree, the temporary directories, and `~/.herdr-boss`. It blocks `git push`, `git reset --hard`, `git clean`, `git branch -D`, `git worktree remove`, `rm -rf` outside the temporary directories, `sudo`, `launchctl`, the private Herdr Boss directory, and credential files. It never asks. A blocked call returns a reason to the worker.

`--no-approve` stops Pi from loading project-local settings, resources, and packages in a worker.

Use this launch shape when you start Pi outside the kit command:

```sh
pi --model <model> --models <same-model> --no-extensions -e ~/.pi/agent/extensions/herdr-agent-state.ts -e ~/.pi/agent/extensions/herdr-guard.ts --no-approve
```

Do not let model cycling select an unapproved model.

Read the bulletin before you choose a Pi model. Pi lists only the models that it can use. Herdr Boss runs `pi --list-models` and hides each Pi model that it does not list. `worker start` refuses such a model, and `--force` does not bypass the refusal. A missing provider means that Pi has no credential for it.

### OpenCode

Put the brief and report inside the worker worktree.

Run free `opencode/` models in the OpenCode harness.

The OpenCode free-usage limit applies to every free model of the harness. After a `Free usage exceeded` failure, Herdr Boss closes the whole `opencode` free lane until the retry time. Without a retry time on the screen, the lane closes for 1 hour. Do not start another free `opencode` worker while the bulletin shows the lane exhausted.

Start OpenCode workers with `--agent worker`. The `worker` agent in `~/.config/opencode/opencode.json` never asks for permission. It allows routine work and denies risky actions and directories outside the worktree, the temporary directories, and `~/.herdr-boss`. A denied call returns an error to the worker.

Read a new pane after startup. If a permission prompt still appears, report it to the Boss.

Wait for the input box before sending the first prompt.

Confirm the worker leaves `idle` after you send the prompt.

Limit a shared cheap model to two active workers.

### Codex

Do not give Codex a task that launches its own Chromium: Playwright, performance replays, or galleries. The Codex sandbox refuses the Chromium Mach port (`MachPortRendezvousServer`, error 1100). Give these tasks to a `claude`, `opencode`, or `pi` worker. A Codex worker can use the `herdr-boss browser` commands on its project browser, because Herdr Boss launches that browser outside the sandbox. `worker start --kind codex` prints a warning when the brief mentions other browser work.

A Codex tool shell can run under a shared app-server daemon. That shell then has the daemon environment, not the environment of the worker pane. `worker start --kind codex` passes the Herdr variables of the new pane to the agent explicitly, with `-c shell_environment_policy.set.<NAME>="<value>"`. Outside Herdr, the Owner's own Codex use does not change.

Confirm the first prompt started work.

Review visual claims against the actual capture.

Start a fresh session when a long session nears its context limit.

### Agent names

Use lowercase names that match the Herdr name limit.

Give each worker a unique name.

Check [the orchestration skill](skills/herdr-orchestrator/SKILL.md) for dispatch and review steps.
