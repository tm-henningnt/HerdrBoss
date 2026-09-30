# Plan: bootstrap a new project end to end

Status: planned on 2026-09-30. Plan only. Build nothing until the Boss says go. Source: task PN1 from the Owner.

## Goal

The Owner asks: is there a tool that bootstraps a new project end to end? This plan answers the question and designs `herdr-boss project new`.

## 1. The answer

No. Each piece exists. No command ties the pieces together. The Owner now runs about ten commands by hand and edits several files. The table shows each piece, the exact command or code, and what is missing.

| Piece | What exists | Where | What is missing |
| --- | --- | --- | --- |
| Kit file, AGENTS.md stub, SessionStart hook | `herdr-boss kit install [--no-hook]` writes `docs/orchestration/herdr-boss.md`, adds the marked stub to `AGENTS.md`, and adds the hook to `.claude/settings.json`. It needs a Git repository. | `commandKit()` in `src/kit/cli.js`; `installKit()` in `src/kit/agents-check.js`; stub in `kit/templates/agents-stub.md` | It writes only the stub. It writes no project part of AGENTS.md, no README, and no `.gitignore`. It finds the repository with `findGitRoot()`, so it fails in a plain folder. |
| Project memory | Template `kit/templates/project-memory.md`. | `kit/templates/` | Nothing copies it to `docs/orchestration/memory.md`. The Owner copies it by hand. |
| Project config | `.herdr-boss.json` is optional. `loadProjectConfig()` fills defaults and derives the slug from the folder name in lower case. | `src/kit/config.js` | Nothing writes the file. |
| Registration | The first `herdr-boss publish <slug> <file>` calls `recordProjectRepo()`. It stores `{ slug, repo, remote }` in `project-repos.json` and runs `syncHarness({ codexOnly: true })`. | `case 'publish'` in `src/cli.js`; `recordProjectRepo()` in `src/harness.js` | A publish needs a Git repository and a status file. It has no first-status template. A dashboard project with no repository cannot register. |
| Status | `writeProject()` validates and stores `projects/<slug>.json`. The field `workspace` links the status to a Herdr workspace. | `src/projects.js`; `docs/project-status.md` | Nothing writes a first status with a first task. |
| Codex writable roots | `herdr-boss harness sync [--dry-run] [--codex-only]` adds `<repo>/.git` of each registered repository. It prints the Claude `autoMode` differences. It never edits Claude settings. | `syncHarness()`, `syncCodex()`, `claudeLines()` in `src/harness.js` | The Claude lines stay a manual step for the Owner. |
| Policy share | `herdr-boss policy set FILE`. Each workspace that Herdr lists gets a default share of `100 / projects`. A saved entry in `policy.projects.<slug>` sets share, mode, and excluded kinds and models. `borrowIdle` lends the slots of an idle project. | `case 'policy'` in `src/cli.js`; `deriveControl()` and `validatePolicy()` in `src/control.js` | No command adds one project entry. The Owner edits the whole policy file. The shares must total at most 100. |
| Project browser | `herdr-boss browser request <slug> [--reserve]` leases a port from the pool `project-browsers` and assigns a profile. `--reserve` assigns and does not launch. | `requestBrowser()` in `src/browser-pool.js` | The caller check needs a pane in the project workspace or the Boss pane. |
| Orchestrator pane | `prepareHandoff()` creates a tab with `herdr tab create --workspace W --label 'Orchestrator Next' --cwd DIR`, starts the agent with `herdr agent start NAME --kind K --pane P -- ARGS`, and sends a prompt with `deliverPrompt()`. `activateHandoff()` renames the pane to `orch` and the agent to `<slug>-orch` (`stableOrchestratorName()`). | `src/handoff.js` | Handover needs a source pane and an existing workspace. Nothing creates a workspace. Nothing starts a first orchestrator. |
| The /goal | `captureGoal()` picks the status goal, then the transcript goal, then `defaultOrchestratorGoal` of the policy (H2). For a Claude successor the engine sends `/goal TEXT` and checks that the pane shows it (`goalShown()`). Other kinds get the goal in the prompt. | `captureGoal()` in `src/handoff.js`; `goalDelivery` in `src/engine.js` (about line 1667) | The path works on a handoff record only. A first orchestrator has no record. |
| Model and harness | `orchestratorLadder` in the policy lists kind, model, and effort in order. `handoffTarget()` validates a target against the allow-lists. | `src/control.js`; `handoffTarget()` in `src/handoff.js` | No command uses the ladder to choose the first orchestrator. |
| Owner question | `herdr-boss say --action decide TEXT`. The caller must be a pane labeled `boss` or `orch`. | `docs/cli.md` (Owner messages) | A plain terminal cannot post. `project new` runs there. |
| Folder, `git init`, first commit, GitHub remote, Herdr workspace | Herdr has `herdr workspace create --cwd PATH --label TEXT`. `gh repo create` exists on this machine (gh 2.101). | Herdr CLI; `gh` | Herdr Boss calls none of them. `src/kit/gh.js` wraps only issue commands. |

Two facts from the code shape the design:

1. Herdr Boss maps a workspace to a project in two ways (`workspaceProjects()` in `src/control.js`). The published status field `workspace` wins. Without it, the slug is the workspace label in lower case with non-alphanumeric characters replaced by `-`. The workspace label must therefore equal the slug, or the status must set `workspace`.
2. Nothing on the machine defines the `Owner group` folder. `~/Projects` holds group folders and `.herdr-wt`. Each project lives in one group folder. No code reads a group. See open question Q1.

## 2. The design

### Command

```
herdr-boss project new <slug> [--path DIR] [--group NAME] [--name NAME]
  [--remote gh|URL|none] [--visibility private|public] [--org OWNER]
  [--kind claude|codex] [--goal TEXT] [--dry-run] [--resume]
herdr-boss project check <slug> [--fix STEP]...
```

`--group` and `--name` are additions to the requested signature. The path default is `<projectsRoot>/<group>/<name>`. `name` defaults to the slug. `--path` replaces the whole default. `--remote` defaults to `none`. `--visibility` defaults to `private`. `--kind` defaults to the first kind of `orchestratorLadder`. `--goal` defaults to `defaultOrchestratorGoal`.

### Steps

Each step has a name. The state file records the name when the step finishes (section 3).

1. `validate`. The slug must match `SLUG` in `src/projects.js`. The slug must not exist in `projects/` or in `project-repos.json`. The path must not exist, or must be an empty folder. The path must be outside the Herdr Boss repository and outside `~/.herdr-boss`. The command runs `git`, `gh`, and `herdr` checks: `gh auth status` for a remote, `herdr workspace list` for the label.
2. `folder`. Run `mkdir -p PATH`. Run `git init -b main`.
3. `files`. Write these files, each only when it does not exist:
   - `AGENTS.md`: a short project part, then the kit stub. The project part holds the project name, the roles (Boss pane `boss`, orchestrator pane `orch`), the safety rules for a repository, and pointers to `PRODUCT.md` and `docs/`. It has no Owner text.
   - `docs/orchestration/memory.md`: a copy of `kit/templates/project-memory.md` with the title `<Name> project memory`.
   - `.herdr-boss.json`: `{ "slug": "<slug>" }`.
   - `.gitignore`: `node_modules/`, `.DS_Store`, `.orchestration/`, `.worker/`.
   - `README.md`: the project name and one line for the goal.
   - `docs/ideas/.gitkeep`.
4. `kit`. Call `installKit(root)`. It writes the kit file, completes the `AGENTS.md` stub, and adds the hook. Then run the first commit: `git add -A`, `git commit -m "Set up the project"`. The command reads the staged diff for secrets first (section 3).
5. `remote`. See "Remote step" below. The step is `skipped` for `none`.
6. `policy`. Add `policy.projects.<slug>` with `mode: auto`, the default share, and empty exclusion lists. Save with `savePolicy()`. The lending rule stays global: `borrowIdle` is unchanged. Rebalance the shares so that the total stays at most 100 (`validatePolicy()` refuses a larger total). The command prints the shares before and after.
7. `register`. Call `recordProjectRepo(slug, root, remote)`. Call `writeProject()` with the first status (below).
8. `workspace`. See "Workspace and orchestrator" below.
9. `harness`. Run `syncHarness({ codexOnly: true })`. Run `claudeLines()` and print the differences. Run `requestBrowser(slug, { reserve: true })`. A Codex root or a browser port that cannot be set is a warning. It does not fail the command.
10. `check`. Run `project check <slug>` and print the result.

### First status

The status file that step 7 writes:

```json
{
  "project": "<Name>",
  "workspace": "<workspace id>",
  "summary": "Project created. Set-up is open.",
  "goal": "<goal text, at most 1000 characters>",
  "status": "on-track",
  "tasks": [{ "id": "P1", "title": "Set up the project", "status": "todo", "frontier": "current" }]
}
```

`workspace` is set after step 8. Step 7 runs `writeProject()` again with the field. `capDoneTasks()` and `validateProject()` need no change. The Owner `goal` reaches the orchestrator through `captureGoal()` (source `status`).

### Remote step

A remote is an Owner decision: visibility, organization, and name.

1. `--remote none`: skip the step. Record `remote: none`.
2. `--remote URL`: run `git remote add origin URL`. Check with `git ls-remote origin` and print the result. Do not create anything. Do not push. The command strips credentials with `stripRemoteCredentials()` before it records the URL.
3. `--remote gh`: the command needs an Owner answer. It posts a Mailbox item with `--action decide`. The text names the repository (`<org>/<name>`), the visibility, and the exact command that runs on yes: `gh repo create <org>/<name> --private --source . --remote origin`. The command exits with code 3 and the message `waiting for the Owner`. `project new <slug> --resume` reads the answer and continues.
4. A public repository needs an explicit answer that contains the word `public`. The default is private. A yes for a private repository never creates a public one.
5. After the create, push `main` with `herdr-boss push origin main`. This is the machine push path. It takes the machine-wide lock when a pre-push hook exists. The first push is the second Owner-visible act, so the decide item names it.

`say` accepts only a pane labeled `boss` or `orch` (`docs/cli.md`). A plain terminal has no such pane. The command therefore writes the item through the message store (`openMessageStore({ dir })`) as the sender `boss`, in the `boss` thread, and prints the item ID. The Boss pane can also run it. See open question Q5.

### Workspace and orchestrator

1. Run `herdr workspace create --cwd PATH --label <slug> --no-focus`. The label equals the slug, so `workspaceProjects()` maps it. Keep the returned workspace ID and root pane ID.
2. Pick kind and model: `--kind` if set, else the first entry of `orchestratorLadder` that `handoffTarget()` accepts. Refuse a kind that the policy disables.
3. Rename the pane: `herdr pane rename <pane> orch`.
4. Start the agent: `herdr agent start <slug>-orch --kind K --pane P -- <launchArgs>`. `launchArgs` come from `handoffTarget()`. A Codex orchestrator also gets `codexShellEnvArgs()` (`successorAgentArgs()` in `src/handoff.js`). The name `<slug>-orch` is the stable name that `check kit` verifies.
5. Deliver the goal. A Claude orchestrator gets `/goal TEXT` as a separate prompt. Check that the pane shows it with `goalShown()`. Other kinds get the goal inside the first prompt. This is the same rule as `goalDelivery` in `activateHandoff()`.
6. Send the first prompt with `deliverPrompt()`: read `AGENTS.md`, `docs/orchestration/memory.md`, and `docs/orchestration/herdr-boss.md`. Then start task P1. The prompt names the slug, the pane ID, and the Boss pane. See open question Q4 for the decision to send it without a check.
7. Post an information item to the Owner: the project, the pane, the workspace, and the first task.

Steps 1 to 7 must not run twice. The state file holds the workspace ID and the pane ID. `--resume` reads them and checks with `herdr pane get`.

### `project check <slug>`

`project check` is read-only. It prints one line for each item and exits with code 1 when any item is missing. `--fix STEP` runs the named step again. It runs no other step.

| Item | Check |
| --- | --- |
| folder | The path exists and is a Git repository on `main`. |
| files | `AGENTS.md`, `docs/orchestration/memory.md`, `.herdr-boss.json`, `.gitignore`, `README.md` exist. |
| kit | `installedKitRevision(root)` equals `kitRevision()`. `checkAgentsFile()` reports no error. The hook is in `.claude/settings.json`. |
| commit | `git rev-parse HEAD` succeeds. |
| remote | `origin` exists, or the state file records `none`. |
| policy | `policy.projects.<slug>` exists. |
| register | `project-repos.json` and `projects/<slug>.json` hold the slug. |
| workspace | `herdr workspace list` shows the label. The status `workspace` field matches. |
| orchestrator | A pane in that workspace has the label `orch` and the agent name `<slug>-orch`. |
| harness | `syncCodex` reports nothing to add. |
| browser | `browser list` shows a lease for the slug. |

`check kit` in `src/kit/cli.js` already checks the agent name. `project check` reuses its helper.

### GUI wizard

The Projects page (`public/app.js`, `/projects`) gets a `New project` button. The wizard has four steps: name and place, remote, orchestrator, review. The review step shows the dry-run output. `Create` runs the command through a new route. The route needs a token and is refused in the read-only preview (`readOnlyPreview` in `src/server.js`, line 232).

| Route | Action |
| --- | --- |
| `POST /api/projects/new/plan` | Runs the dry run and returns the steps. |
| `POST /api/projects/new` | Starts the flow in the service. Returns the flow ID. |
| `GET /api/projects/new/<id>` | Returns the state file: each step and its status. |
| `POST /api/projects/new/<id>/resume` | Resumes after an Owner answer. |

The page shows each step with a status and the Mailbox item for a remote question. Loopback needs no login. The wizard has no field for a token. All flow code lives in `src/project-new.js`. The CLI and the routes call it. The wizard adds no rule of its own.

## 3. Safety rules

1. No secret in a file. The generator writes only fixed text and the inputs. Before the first commit, scan the staged diff with the patterns of `redactContext()` in `src/handoff.js` and stop on a match. `AGENTS.md` says the repository can be public.
2. Ask before a remote or a credential. `gh` uses its own stored login. Herdr Boss never reads, passes, or stores a token. The command never runs `gh auth login`. It prints the exact command for the Owner to run with `!`.
3. `--dry-run` prints each step and the exact command or file it would run or write. It runs no `mkdir`, no `git`, no `gh`, no `herdr`, and writes no file, no policy entry, and no state file. It reads only.
4. Refuse an existing non-empty folder. Refuse a folder that is already a Git repository. Refuse a slug that is registered. The flag `--adopt` is not part of this plan. See open question Q6.
5. Every step is idempotent. A step first tests whether its result exists and then does nothing. A file that exists is never overwritten. `AGENTS.md` and the kit stub use `installKit()`, which already keeps other text.
6. Record progress in `flows/<slug>.json` in the data dir (`~/.herdr-boss/flows/`), mode 0600, written with a temp file and a rename. The record holds the inputs, each step name, its status (`done`, `skipped`, `failed`, `waiting`), the time, and the IDs (workspace, pane, Mailbox item). It holds no secret and no token. The repository holds no state.
7. `--resume` continues at the first step that is not `done` or `skipped`. A step that changed state before a crash must check its result before it repeats.
8. No public repository without an explicit Owner answer that contains `public`. `--visibility public` in the command line alone does not create one. It only puts `public` in the question.
9. Never print a token. Redact `gh` and `git` output through the same patterns. Print the status code and a header name, never a header value. A remote URL prints without credentials.
10. The command runs no test suite and starts no worker. It does not stop, close, or restart a browser. It never touches a folder outside the new project, the data dir, and the Codex config that `harness sync` already backs up.
11. A failure leaves the created folder in place. The command prints the state and the fix. It never deletes a folder. The Owner deletes it.
12. Refuse to run from a worker pane. Accept the Boss pane, a plain terminal (the Owner), and the dashboard. Use the caller check of `verifyBrowserCaller()` in `src/cli.js` as the model.

## 4. Build tasks

Write a failing regression test before each behavior change. Run only the changed test files with `--test-concurrency=2`. Run the full suite once in the integration worktree.

| Task | Change | Files | Tests | Docs | Size |
| --- | --- | --- | --- | --- | --- |
| PN-a | Flow module: input validation, the step list, the state file, `--dry-run`, `--resume`. Steps `validate`, `folder`, `files`. Templates for the project part of AGENTS.md and the README. | `src/project-new.js` (new), `kit/templates/agents-project.md` (new), `kit/templates/readme.md` (new) | `test/project-new.test.js`: slug and path refusal, non-empty folder refusal, dry run writes nothing, files are not overwritten, a second run changes nothing, state file mode 0600 | `docs/cli.md` | M |
| PN-b | Steps `kit` and first commit, with the staged-diff secret scan. | `src/project-new.js`, `src/kit/agents-check.js` (export a `--root` variant if needed) | Fixture with a token in a file stops the commit; the kit file and the hook exist after the step | `docs/cli.md` | S |
| PN-c | Steps `policy` and `register`, and the first status. Add `addProjectPolicy(slug)` that rebalances shares. | `src/control.js`, `src/project-new.js` | `test/control.test.js`: entry added, total stays at most 100, existing entries keep mode and exclusions; register test with a temporary `HERDR_BOSS_DIR` | `docs/cli.md`, `docs/user-guide.md` | M |
| PN-d | Step `workspace`: workspace, pane label, agent start, `/goal` delivery, first prompt. Reuse `handoffTarget()`, `deliverPrompt()`, `goalShown()`. Extract the `goalDelivery` rule from `activateHandoff()` into one function that both callers use. | `src/project-new.js`, `src/handoff.js`, `src/goal.js` | Fake Herdr runner: order of calls, label `orch`, name `<slug>-orch`, `/goal` for Claude, goal in the prompt for Codex, a rerun creates no second workspace | `docs/cli.md`, `docs/user-guide.md` | L |
| PN-e | Step `remote` and the Owner decision: `gh` wrapper, decide item through the message store, exit code 3 and `--resume`, the `public` rule. Add `gh repo create` and `git ls-remote` helpers with output redaction. | `src/kit/gh.js`, `src/project-new.js` | Fake `gh`: private default, public needs `public` in the answer, no call before the answer, credentials never printed, `none` skips | `docs/cli.md`, `docs/harness-setup.md` (gh login note) | L |
| PN-f | Step `harness` and `project check`, with `--fix STEP`. Reuse `check kit` name logic. | `src/project-new.js`, `src/kit/cli.js` or `src/cli.js` (dispatch) | One test for each check item: missing and present; `--fix` runs one step only | `docs/cli.md` | M |
| PN-g | CLI dispatch: `project new`, `project check`, flags, exit codes, caller check. | `src/cli.js` | Usage errors; a worker pane is refused | `docs/cli.md`, README (one line) | S |
| PN-h | Routes for plan, start, status, resume. Reuse the flow module. Refuse in the read-only preview. | `src/server.js` | `test/server.test.js`: routes, preview refusal, status shape | `docs/user-guide.md` | M |
| PN-i | GUI wizard on the Projects page and the `HELP` text. Check in the project browser at 1280 and 393 px. | `public/app.js`, `public/style.css` | Page serves; browser check with a temporary data dir | `HELP` in `public/app.js`, `docs/user-guide.md` | L |

### Order

1. PN-a, then PN-b. They touch files only. The Owner can use them with `--remote none` and no orchestrator.
2. PN-c and PN-g next. PN-g needs PN-a.
3. PN-d after PN-c. It needs the workspace ID for the status.
4. PN-e and PN-f. They are independent of each other. PN-e needs PN-a.
5. PN-h after PN-d, PN-e, and PN-f. PN-i last.

PN-a, PN-b, and PN-c share `src/project-new.js`. Run them in sequence. PN-d and PN-e can run in parallel after PN-c, if a worker keeps its steps in a separate function block.

### Tasks that need the Owner

| Task | Owner input | Why |
| --- | --- | --- |
| PN-e | The GitHub organization, the visibility, and the repository name, at each run | Creating a remote is an Owner decision. |
| PN-e | A `gh auth login` on the machine, if it is missing | A credential. The Owner runs it. |
| PN-e | A live test that creates one repository | It uses the Owner GitHub account. Use a private test repository, and delete it by hand. |
| PN-d | A live check that starts a real orchestrator | It spends model quota. |
| PN-i | The wizard scope (Q3) | A product decision. |

No task spends money except the live orchestrator start. All other tests use fake runners and temporary directories.

## 5. Open questions

Each question lists options and a recommendation. The Boss or the Owner decides.

**Q1. Where does the `Owner group` folder default come from?** Nothing in the code defines it.
- A. A required `--group` with no default. The command refuses without `--group` or `--path`.
- B. A Settings value `projects.defaultGroup` and `projects.root`, with the Settings and dashboard pair that `AGENTS.md` requires.
- C. Derive the group from the current folder.
- Recommendation: A in PN-a. Add B later if the Owner creates projects often. C fails when the command runs from a worktree.

**Q2. Which visibility and organization?**
- A. Private by default. Organization from `--org`, else the `gh` login.
- B. A Settings default for the organization.
- Recommendation: A. It follows the safety rule. The decide item always names the organization.

**Q3. What does the GUI wizard cover?**
- A. Full flow, including the remote question.
- B. Only `--remote none` and the orchestrator. The remote question stays in the Mailbox.
- Recommendation: A. The wizard adds no rule. The Mailbox item is the same in both cases.

**Q4. Does the first prompt go out automatically?**
- A. Yes, after the `/goal`. The orchestrator reads the files and starts P1.
- B. No. The command starts the agent and posts a Mailbox item. The Owner or the Boss sends the first prompt.
- C. Yes with `--start`, off by default.
- Recommendation: C for the first release. An automatic start spends quota and the Boss may want to review `AGENTS.md` first. Change the default to A when the Owner agrees.

**Q5. How does the flow ask the Owner from a plain terminal?**
- A. Write the item through the message store as the sender `boss`.
- B. Allow `say` from a plain terminal for the Owner.
- C. Ask on standard input in the terminal, and post the Mailbox item only from the dashboard.
- Recommendation: A. It keeps the Mailbox as the one place for Owner decisions. B changes the caller rule of `say`. C fails in the wizard.

**Q6. May the command adopt an existing repository?**
- A. No. New projects only. Existing projects use `kit install` and `publish`.
- B. Yes with `--adopt`: skip the folder and file steps that exist, run the rest.
- Recommendation: A now. `project check --fix` covers most of B later.

**Q7. Which projects does the share change?**
- A. Split the new share from the existing entries so that the total stays at most 100.
- B. Give the new project a small fixed share (for example 10) and scale the others down.
- C. Leave existing shares. Refuse when the total would exceed 100. Tell the Owner.
- Recommendation: B. It never changes a project that the Owner set to a large value by more than the new share. Print the before and after values.

**Q8. Which harness for the first orchestrator?**
- A. The first usable entry of `orchestratorLadder`.
- B. `--kind` required.
- Recommendation: A, with `--kind` as an override. The ladder is the Owner setting for this choice.
