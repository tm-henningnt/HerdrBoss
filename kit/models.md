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

Provider quota, task fit, availability, and review effort affect the real cost.

## Task lanes

| Kind and model | Best fit | Limits |
| --- | --- | --- |
| `claude`, `claude-opus-5-5` | Visual judgment, browser work, hosted review, and product coherence. | Quota is scarce. Reserve it for work that needs judgment. |
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

Prefer DeepSeek for substantial mechanical work when both DeepSeek and Muse Spark are available.

Use Muse Spark only for narrow, bounded work when its model fits the task.

## Harness rules

### Pi

Pin a Pi worker to one allowed model.

Disable extensions that can start unpinned subagents.

Keep the Herdr state reporter enabled.

Use this launch shape when you start Pi outside the kit command:

```sh
pi --model <model> --models <same-model> --no-extensions -e ~/.pi/agent/extensions/herdr-agent-state.ts
```

Do not let model cycling select an unapproved model.

### OpenCode

Put the brief and report inside the worker worktree.

Run free `opencode/` models in the OpenCode harness.

Read a new pane after startup and handle any permission prompt.

Wait for the input box before sending the first prompt.

Confirm the worker leaves `idle` after you send the prompt.

Limit a shared cheap model to two active workers.

### Codex

Confirm the first prompt started work.

Review visual claims against the actual capture.

Start a fresh session when a long session nears its context limit.

### Agent names

Use lowercase names that match the Herdr name limit.

Give each worker a unique name.

Check [the orchestration skill](skills/herdr-orchestrator/SKILL.md) for dispatch and review steps.
