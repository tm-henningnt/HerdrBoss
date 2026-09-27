# HerdrBoss agent instructions

HerdrBoss is the resource supervisor, shared dashboard, and orchestration kit for all Herdr projects on this machine. Read [PRODUCT.md](PRODUCT.md) for its purpose and [docs/user-guide.md](docs/user-guide.md) for how it works.

## Roles

- The **Boss** runs in the pane labeled `boss` in the `Boss` workspace. It supervises all projects, talks to the Owner, and tells other orchestrators about kit changes.
- The **HerdrBoss orchestrator** runs in the pane labeled `orch` in the `HerdrBoss` workspace. It develops this repository through workers.
- The orchestrator reports finished work, kit changes, and questions to the Boss pane with `herdr agent prompt <boss-pane> "..."`, without `--wait`. The Boss decides when to tell the other projects.

The HerdrBoss orchestrator maintains the Herdr Boss kit, its skills, and its templates. Other orchestrators do not edit them. They send change requests to the Boss, which decides whether to relay them here.

Decide implementation, product, and design details, naming, thresholds, test design, scope inside this project, and review findings yourself. Before you escalate, check `docs/orchestration/memory.md` for an Owner decision that already answers the question. Report to the Boss only when a task is merged and live, or when you are blocked, in one or two lines.

## Safety rules

- This repository is public: https://github.com/tm-henningnt/HerdrBoss. Before each commit, read the full diff for secrets, tokens, local file contents, and details from other projects: client names, tenant URLs, app IDs, and business data. Do not commit such content.
- Push `main` yourself after the release steps. Before each push, read the full diff for tokens, secrets, local paths with private content, and client or tenant names from other projects. Push one change set at a time, and only when the 5-minute load average is under 30.
- The launchd service runs from the `main` working tree of this checkout. A change on `main` goes live for every project at the next restart.
- Never stop, close, or restart a browser that another project uses. Never touch the Chrome on port 9222.
- Never print a secret to a pane or a report. The default token and all session files are stored in `~/.config/herdr-boss/`; an explicit `access.tokenFile` path stays configured. Agents must not read the private directory. Use temporary `HOME` and `HERDR_BOSS_DIR` fixtures for credential tests.

## Build and test

- `npm test` runs all tests, two test files at a time. There are no dependencies to install.
- Run `node --check <file>` for each changed JavaScript file.
- For the dashboard, check the change in the project browser: run `herdr-boss browser request herdrboss`, open a tab with `herdr-boss browser tab new herdrboss http://127.0.0.1:4477/<page>`, and capture it with `herdr-boss browser screenshot herdrboss --tab <id>`. Close your tab when you are done.
- For the phone layout, run `herdr-boss browser size herdrboss 393 852`, then `herdr-boss browser restart herdrboss --headless --no-restore`. Set the size back to 1280 by 800 when you are done.
- For a dashboard preview, use `HERDR_BOSS_DIR="$(mktemp -d)" HERDR_BOSS_PORT=4478 npm start -- --read-only-preview`. Choose an unused local port if 4478 is busy.
- Loopback requests need no login. Do not change `~/.herdr-boss/` data files in a test; use a temporary directory with `HERDR_BOSS_DIR`.

## Integrate and release

1. Review each worker diff, and run `npm test` in the worker worktree.
2. Merge the branch into `main`.
3. Run `npm test` on `main`.
4. Restart the service: `launchctl kickstart -k gui/$(id -u)/no.tallmaker.herdr-boss`.
5. Check that it serves: `curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:4477/api/state` must print `200` within 30 seconds.
6. If the check fails, revert the merge, restart again, and tell the Boss.
7. Push `main` with the checks in the safety rules.

## Documentation

- Write documentation in ASD-STE100 Simplified Technical English: one idea per sentence, active voice, the imperative for instructions, one term for one concept.
- Keep the README short. Put commands in `docs/cli.md`, concepts in `docs/user-guide.md`, and page help in the dashboard help panel (`HELP` in `public/app.js`).
- Update the docs and the page help in the same change as the behavior.

## Work source

The Boss gives tasks to the orchestrator. The project status file (`herdr-boss publish herdrboss <file>`) is the backlog and the progress record. Publish it at each task boundary. There is no issue tracker for this project yet.

<!-- herdr-boss:begin v=c25faaa26a71 -->
## Herdr Boss orchestration

- Use the Herdr Boss orchestrator skill when you coordinate workers or resume an unknown project state.
- Read `docs/orchestration/memory.md` at start and at resume, before you choose work.
- Run `herdr-boss kit-path` to find the shared kit repository. Use its path for the files below.
- Read `kit/skills/herdr-orchestrator/SKILL.md` there.
- Read `kit/models.md` before selecting a worker kind or model.
- Run `herdr-boss models` and `herdr-boss lanes` for the current models and lanes. Never copy model lists or harness facts into project files.
- Read `~/.herdr-boss/bulletin.md` before each worker dispatch.
- Follow its worker cap, project share, and provider pacing rules. Use an authorized override only when needed.
- Read `kit/browser-service.md` for project browser commands. Read `kit/shared-browser.md` only if an optional legacy shared browser is explicitly assigned.
- Keep the orchestrator pane labeled `orch`.
- Use `herdr-boss worker start` to start workers.
- Use lowercase, unique worker names.
- Give every worker one bounded task and exact allowed paths.
- Keep Git branches, worktrees, commits, and merges under orchestrator control.
- Wait on workers or events. Do not poll panes in a tight loop.
- Treat `working`, `blocked`, `idle`, `done`, and `unknown` as distinct states.
- Require `.worker/report.md`, `.worker/report.json`, and a `WORKER REPORT` message.
- Inspect each worker diff and run acceptance commands independently.
- Keep evidence tiers separate. Local checks do not prove hosted or Owner acceptance.
- Publish project status through Herdr Boss. Do not build a separate project dashboard.
- Use `herdr-boss browser request <project-slug>` for a dedicated browser. Keep its recorded profile and port.
- Use only this project's browser unless the Owner explicitly assigns a legacy shared session.
- Coordinate tab ownership with the orchestrator before sending browser input.
- Record measured worker usage in `.worker/report.json` and run `herdr-boss worker collect --record` after review.
- Prepare a successor with `herdr-boss handoff plan` and `handoff prepare` when the orchestrator's quota is at risk.
- Keep project-specific rules in this file: product direction, issue sources, acceptance gates, release policy, and browser procedures.
- Keep project terminology, data, and architecture decisions in `AGENTS.md`. Keep Owner decisions, holds, freezes, dated evidence, and pane facts in `docs/orchestration/memory.md`.
- The Boss runs in the pane labeled `boss`. Find it with `herdr pane list`. Never write its pane ID into a file.
- Settle implementation, design details, naming, thresholds, test design, project scope, and review findings within project rules and memory. Do not ask the Boss about them.
- Decide product and design details yourself. Before you escalate, check `docs/orchestration/memory.md` and the issue history for an Owner decision that already answers the question.
- Ask the Boss only about a conflict between projects or a change that affects another project.
- Do not edit the Herdr Boss kit or its skills from another project. Send the change request to the Boss. The Boss decides whether to relay it to the HerdrBoss orchestrator.
- Ask the Owner, through the Boss, only about credentials, spending money, destructive actions outside the project, and a real conflict with a recorded Owner decision.
- Report to the Boss only when a task is merged and live or when blocked. Use one or two lines. Run `herdr agent prompt <boss-pane> "..."` without `--wait`.
- Do not message another project's orchestrator. The Boss relays messages between projects.
- Decide and run your own pushes, deployments, and releases. Nobody approves them. Before each push, read the full diff for secrets, private local paths, and other-project client or tenant names. Push one change set at a time, with the 5-minute load under 30. Send a deployment that spends money to the Owner through the Boss.
- Record an Owner request typed into your pane as an Owner decision in `docs/orchestration/memory.md`.
- The kit and the Boss take precedence over conflicting project text. Report a conflict to the Boss.
- List processes with `pgrep -l`, `ps -o pid,ppid,etime,comm`, or `herdr-boss worktree prune`.
- Do not print full process command lines or environments. Do not use `pgrep -fl`, `ps aux`, `ps -ef`, `ps e`, or `ps -E` with the output printed. Use `pgrep -f` only to match a pattern, never to print.
- Treat a secret that reaches a transcript as disclosed. Report it to the orchestrator, who reports it to the Boss.
- Use `docs/orchestrator-instructions.md` to find this section and its installation notes.
<!-- herdr-boss:end -->
