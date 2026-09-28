# Model lanes

Use the machine allow-list in [`models.json`](models.json) as the source of truth.

This file describes observed task fit. It does not grant permission to use a model.

Check the bulletin and the live allow-list before every dispatch.

## Cost order

The observed order from lower to higher cost is:

1. Free `opencode/` models, including Muse Spark and Mimo.
2. `opencode-go/deepseek-v4.1-flash`.
3. Codex `gpt-6-luna`.
4. Claude `claude-opus-5-5` and Codex Sol.
5. Codex Astra.

Treat this order as a routing hint.

Prefer an unmetered model for bounded, well-specified work while a metered provider is ahead of pace. Reserve metered models for work that needs judgment. Read the unmetered lane in `herdr-boss lanes`; a worker-start refusal or least-over notice lists your project's unmetered alternatives first.

Provider quota, task fit, availability, and review effort affect the real cost.

## Task lanes

| Kind and model | Best fit | Limits |
| --- | --- | --- |
| `claude`, `claude-opus-5-5` | Visual judgment, browser work, hosted review, and product coherence. | Reserve it for judgment while its lane is ahead of pace; use it for implementation when it has headroom. |
| `codex`, `gpt-6-luna` | Core seams, algorithms, cross-cutting changes, and takeovers. | Review root causes and pixel claims. Long sessions can stop without a final report. |
| `pi`, `opencode-go/deepseek-v4.1-flash` | Economical research and fully specified mechanical work. | Shared Go quota can stop every worker on that provider. Pin the model and verify results. |
| `pi`, `opencode-go/muse-spark-1.3-contributor` | Cheap bounded implementation, docs, copy, and read-only diagnosis. | Source records disagree on its success rate. Keep the task atomic and inspect every path. |
| `pi`, `opencode-go/space-bunny-free` | Bounded audits and review-only work. | Evidence is limited. Verify each finding at its source. |
| `opencode`, free `opencode/` models | Exact one-file changes with a clear gate. | Use only small, mechanical briefs. Permission prompts and provider overload can stop work. |

Free `opencode/` models recorded in the source include:

- `opencode/big-pickle`
- `opencode/ling-3.0-flash-fin-free`
- `opencode/mimo-v2.6-flash-free`
- `opencode/muse-spark-1.2-contributor-free`
- `opencode/muse-spark-1.3-contributor-free`
- `opencode/nemotron-3-ultra-free`
- `opencode/nemotron-3.5-lightning-free`
- `opencode/space-bunny-free`

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
