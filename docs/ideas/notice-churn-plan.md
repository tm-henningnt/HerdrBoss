# Plan: fewer notices and less kit churn

Status: planned on 2026-09-29, during the stand-down. Build at resume, after the re-entrant lock fix. Source: the Boss design at `~/.herdr-boss/scratch/boss/notice-churn-design-2026-09-29.md`, for an Owner request.

## Goal

Orchestrators get a kit notice only for a change that they must act on. Other kit changes arrive as a digest at a natural moment. Info notices come in one batch per pane, at most every 2 hours, and never while the pane works.

## Tasks, in build order

| Task | What | Main files | Size |
| --- | --- | --- | --- |
| N1 | Compute the kit revision only from the files that `kit install` writes: the kit file, the templates, the skill and its reference files, and `kit/models.json`. A merge of service, dashboard, or website code does not move it. | `src/kit/agents-check.js` (`projectKit()`, `kitRevision()`), `test/kit-config-worktrees.test.js` | S |
| N2 | An impact level for each kit change: `required`, `useful`, or `none`, from a `Kit-Impact:` commit trailer or `kit/CHANGES.md`. Keep a list of changes between revisions. | `src/kit/agents-check.js`, `kit/CHANGES.md` (new), `test/kit-config-worktrees.test.js` | M |
| N3 | Send the "Kit updated" notice only for `required`. Add `herdr-boss kit update [--quiet]`: print the digest since the project's revision, then install. | `src/kit-notice.js`, `src/kit/cli.js`, `test/kit-notice.test.js` | M |
| N4 | Pull at natural moments: `worker start`, `publish`, and `handoff` print one line when the project is behind. The SessionStart hook stub runs `herdr-boss kit update --quiet`. | `src/kit/workers.js`, `src/cli.js`, `src/handoff.js`, `src/kit/agents-check.js` (hook stub) | M |
| N5 | `check kit` reports `current`, `behind (useful only)`, and `behind (required)`. Only `behind (required)` fails. The dashboard shows `behind (useful only)` muted, and one reminder goes out after 2 hours behind on a required change while the pane works. | `src/kit/cli.js`, `public/app.js`, `src/engine.js` | S |
| N6 | One info digest per pane: batch info-level notices of all kinds, at most once every 2 hours, and none while the pane is `working`. Warn and higher still arrive at once. | `src/engine.js`, `test/notice-noise.test.js` | M |

## Rules for the build

- Merge each task in the integration worktree, and move `main` forward only with `git merge --ff-only`.
- N1 gives most of the saving. Release it alone first, and measure the notices for a day.
- The kit rule "send every kit change to all orchestrators" (Owner, 2026-09-27) is replaced by this design. Record the replacement in `memory.md` when N3 is live.
- Give each task to Codex or a free model. The Claude quota hold applies until its reset.
