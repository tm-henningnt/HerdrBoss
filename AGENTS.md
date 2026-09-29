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
- Push `main` yourself after the release steps. Before each push, read the full diff for tokens, secrets, local paths with private content, and client or tenant names from other projects. Push with `herdr-boss push origin main`. It takes the machine-wide `full-suite` lock when a pre-push hook exists. Run each full test suite with `herdr-boss suite -- npm test`.
- The launchd service runs from the `main` working tree of this checkout. A change on `main` goes live for every project at the next restart.
- Never stop, close, or restart a browser that another project uses. Herdr Boss never stops a browser that it did not start.
- Never print a secret to a pane or a report. The default token and all session files are stored in `~/.config/herdr-boss/`; an explicit `access.tokenFile` path stays configured. Agents must not read the private directory. Use temporary `HOME` and `HERDR_BOSS_DIR` fixtures for credential tests.

## Build and test

- `npm test` runs all tests, two test files at a time. There are no dependencies to install.
- Run `node --check <file>` for each changed JavaScript file.
- For the dashboard, check the change in the project browser: run `herdr-boss browser request herdrboss`, open a tab with `herdr-boss browser tab new herdrboss http://127.0.0.1:4477/<page>`, and capture it with `herdr-boss browser screenshot herdrboss --tab <id>`. Close your tab when you are done.
- For the phone layout, run `herdr-boss browser size herdrboss 393 852`, then `herdr-boss browser restart herdrboss --headless --no-restore`. Set the size back to 1280 by 800 when you are done.
- For a dashboard preview, use `HOME="$(mktemp -d)" HERDR_BOSS_DIR="$(mktemp -d)" HERDR_BOSS_PORT=4478 npm start -- --read-only-preview`. Choose an unused local port if 4478 is busy.
- Loopback requests need no login. Do not change `~/.herdr-boss/` data files in a test; use a temporary directory with `HERDR_BOSS_DIR`.

## Integrate and release

1. Review each worker diff. A worker runs only the changed test files, as the worker brief says. Do not run the full suite in the worker worktree.
2. Merge the branch in a separate integration worktree, never in the `main` checkout. The CLI and the dashboard run straight from `main`, so a conflict marker there breaks `herdr-boss` for every project. Resolve conflicts in the integration worktree. Run the full suite there once: `herdr-boss suite -- npm test`. Then move `main` forward with `git merge --ff-only`.
3. On `main`, run `herdr-boss suite --reuse -- npm test`. The command reuses the pass of the same tree and runs no second suite.
4. Restart the service: `launchctl kickstart -k gui/$(id -u)/no.tallmaker.herdr-boss`.
5. Check that it serves: `curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:4477/api/state` must print `200` within 30 seconds.
6. If the check fails, revert the merge, restart again, and tell the Boss.
7. Push `main` with `herdr-boss push origin main`, after the diff check in the safety rules.

## Documentation

- Write documentation in ASD-STE100 Simplified Technical English: one idea per sentence, active voice, the imperative for instructions, one term for one concept.
- Keep the README short. Put commands in `docs/cli.md`, concepts in `docs/user-guide.md`, and page help in the dashboard help panel (`HELP` in `public/app.js`).
- Update the docs and the page help in the same change as the behavior.
- Make each setting and each resource that Herdr Boss manages visible and settable in the dashboard. Keep an item outside only for a recorded reason, for example a secret, the access token file, or a Claude setting that agents must not edit.

## Work source

The Boss gives tasks to the orchestrator. The project status file (`herdr-boss publish herdrboss <file>`) is the backlog and the progress record. Publish it at each task boundary. There is no issue tracker for this project yet.

<!-- herdr-boss:begin v=7051a6b2b5a3 -->
## Herdr Boss

- Read `docs/orchestration/herdr-boss.md` and `docs/orchestration/memory.md` at start, at resume, and on each `Kit updated` notice.
- Use and respect the Herdr Boss kit, `[herdr-boss]` notices, and Boss messages. Report problems with them to the Boss.
- Decide implementation, product, and design details and your own pushes yourself.
- Ask the Owner, through the Boss, only about credentials, spending money, destructive actions outside the project, and a conflict with a recorded Owner decision.
- Open no selection dialogs. Decide, or report that you are blocked.
- The kit file and the Owner decisions in `memory.md` are the operating rules of this project. Report a conflict with them to the Boss. Do not work around them.
<!-- herdr-boss:end -->
