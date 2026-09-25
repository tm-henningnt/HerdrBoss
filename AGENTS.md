# HerdrBoss agent instructions

HerdrBoss is the resource supervisor, shared dashboard, and orchestration kit for all Herdr projects on this machine. Read [PRODUCT.md](PRODUCT.md) for its purpose and [docs/user-guide.md](docs/user-guide.md) for how it works.

## Roles

- The **Boss** runs in the pane labeled `boss` in the `Boss` workspace. It supervises all projects, talks to the Owner, and tells other orchestrators about kit changes.
- The **HerdrBoss orchestrator** runs in the pane labeled `orch` in the `HerdrBoss` workspace. It develops this repository through workers.
- The orchestrator reports finished work, kit changes, and questions to the Boss pane with `herdr agent prompt <boss-pane> "..."`, without `--wait`. The Boss decides when to tell the other projects.

## Safety rules

- This repository is public: https://github.com/tm-henningnt/HerdrBoss. Before each commit, read the full diff for secrets, tokens, local file contents, and details from other projects: client names, tenant URLs, app IDs, and business data. Do not commit such content.
- Do not push. The Boss asks the Owner and pushes.
- The launchd service runs from the `main` working tree of this checkout. A change on `main` goes live for every project at the next restart.
- Never stop, close, or restart a browser that another project uses. Never touch the Chrome on port 9222.
- Never print a secret to a pane or a report. Read `~/.herdr-boss/access-token` only when a check needs it, and do not print its value.

## Build and test

- `npm test` runs all tests, two test files at a time. There are no dependencies to install.
- Run `node --check <file>` for each changed JavaScript file.
- For the dashboard, check the change in a browser of your own: `playwright-cli -s=<name> open http://127.0.0.1:4477/<page>`. Add `--device="iPhone 15"` for the phone layout. Close the session when you are done.
- For a dashboard preview, use `HERDR_BOSS_DIR="$(mktemp -d)" HERDR_BOSS_PORT=4478 npm start -- --read-only-preview`. Choose an unused local port if 4478 is busy.
- Loopback requests need no login. Do not change `~/.herdr-boss/` data files in a test; use a temporary directory with `HERDR_BOSS_DIR`.

## Integrate and release

1. Review each worker diff, and run `npm test` in the worker worktree.
2. Merge the branch into `main`.
3. Run `npm test` on `main`.
4. Restart the service: `launchctl kickstart -k gui/$(id -u)/no.tallmaker.herdr-boss`.
5. Check that it serves: `curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:4477/api/state` must print `200` within 30 seconds.
6. If the check fails, revert the merge, restart again, and tell the Boss.

## Documentation

- Write documentation in ASD-STE100 Simplified Technical English: one idea per sentence, active voice, the imperative for instructions, one term for one concept.
- Keep the README short. Put commands in `docs/cli.md`, concepts in `docs/user-guide.md`, and page help in the dashboard help panel (`HELP` in `public/app.js`).
- Update the docs and the page help in the same change as the behavior.

## Work source

The Boss gives tasks to the orchestrator. The project status file (`herdr-boss publish herdrboss <file>`) is the backlog and the progress record. Publish it at each task boundary. There is no issue tracker for this project yet.

## Herdr Boss orchestration

- Use the Herdr Boss orchestrator skill when you coordinate workers or resume an unknown project state.
- Run `herdr-boss kit-path` to find the shared kit repository. Use its path for the files below.
- Read `kit/skills/herdr-orchestrator/SKILL.md` there.
- Read `kit/models.md` before selecting a worker kind or model.
- Use `kit/models.json` as the source of truth for the model allow-list.
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
- Keep evidence tiers separate. Local checks do not prove Owner acceptance.
- Publish project status through Herdr Boss. Do not build a separate project dashboard.
- Use `herdr-boss browser request herdrboss` for this project's browser. Keep its recorded profile and port.
- Use only this project's browser unless the Owner explicitly assigns another.
- Coordinate tab ownership before sending browser input.
- Record measured worker usage in `.worker/report.json` and run `herdr-boss worker collect --record` after review.
- Prepare a successor with `herdr-boss handoff plan` and `handoff prepare` when the orchestrator's quota is at risk.
