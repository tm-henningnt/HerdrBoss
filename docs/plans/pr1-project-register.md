# PR1 design note: the project register

Status: design only. This note holds no product code. The build starts after the Owner answers the Decisions table in section 13.

Wireframe: [pr1-project-register-wireframe.html](pr1-project-register-wireframe.html). The wireframe shows the Projects page, the Allocation effect, and the Fleet rows at 1280 px and 393 px, in light and dark.

All project names in this note and in the wireframe are invented (`acme-web`, `orchard-api`). They are not real projects.

## Terms

Each term has one meaning in this note.

- **Register**: the list of all projects that the Owner tracks, with one record for each project.
- **Open**: a project that has a Herdr workspace, a project lead pane, and a browser reservation.
- **Parked**: a project that has no workspace, no pane, no browser reservation, and no lease. All state stays.
- **Archived**: a parked project that the Owner hides from the default list. Nothing auto-opens it.
- **Pin**: a mark on an open project. A pinned project is one of the projects in focus.
- **Cap**: the maximum number of open projects.
- **Park**: change a project from open to parked.
- **Pause**: the existing policy mode `paused`. A paused project keeps its panes. Park closes them.
- **Triage label**: the GitHub label that marks an issue as ready for an agent. The default is `ready-for-agent`.

## 1. Facts today

Herdr Boss has no register. It has four partial sources:

| Source | Holds | Gap |
|---|---|---|
| `project-repos.json` in the data dir | `{ slug, repo, remote }` for each project that published once or ran `project new`. | No title, group, state, or priority. |
| `policy.json`, entry for the slug | Share of the worker limit, models, mode (`paused`, idle). | It controls resources. It does not say whether the project is wanted now. |
| `projects/<slug>.json` | The status that the project lead publishes: goal, tasks, `updated`. | Only projects that published. |
| Herdr workspaces | The workspace and panes of an open project. | Herdr has no state for "not wanted now" (section 7). |

`project check SLUG` reads a project and lists missing items. `project check SLUG --fix STEP` repairs one item. The steps are `folder`, `files`, `kit`, `commit`, `remote`, `labels`, `policy`, `register`, `status`, `workspace`, `harness`, and `ci`.

Idle and paused projects already lend their base slots to busy projects (see [settings.md](../reference/settings.md), Allocation). A project that is not working blocks no resource. It still adds a row to the Overview, the Allocation view, and the Herdr sidebar. The register removes that noise.

## 2. The register record

### 2.1 Storage

- File: `project-register.json` in the data dir. Mode `0600`. The file never goes into a repository, because it names private clients and groups.
- The reader and the writer use `src/data-file-safety.js`, like the other data files.
- The file holds one object: `{ "version": 1, "projects": [ ... ] }`.
- The register never stores a secret, a token, a password, or a remote URL with credentials. The writer refuses a value that matches `src/secret-scan.js`.
- `project-repos.json` stays the source of the repository path for the agent app. The register copies `repo` and `remote` at import and at `project register edit`. A repair command `project register sync` copies them again.

### 2.2 Fields

| Field | Type | Set by | Meaning |
|---|---|---|---|
| `slug` | string, matches `SLUG` | import or `register add` | Key. One record for one slug. |
| `title` | string, up to 80 characters | Owner | Display name. Default: the status `project` field, then the slug. |
| `group` | string, up to 40 characters | Owner | Client or area. Free text, with a pick list of the groups in use. |
| `repo` | absolute path or empty | import | Local main checkout. Empty for a project that exists only as a remote. |
| `remote` | `owner/name` or URL without credentials | import | GitHub repository. |
| `factory` | `mac`, `win1`, `win2`, or another registered factory name | Owner | The factory that runs the project. Default: the local factory. |
| `state` | `open`, `parked`, `archived` | commands | Section 3. |
| `pinned` | boolean | Owner | Focus mark. Only an open project can be pinned. |
| `priority` | `high`, `normal`, `low` | Owner | Default `normal`. Used to sort, and to choose a proposal (section 6). |
| `issueSource` | `{ repo, label }` or empty | Owner | GitHub repository and triage label. Default: `remote` and the global triage label. |
| `autoOpen` | `off` or `on` | Owner | Per-project override for auto-open (section 6). Default `off`. |
| `lastOpenedAt` | ISO time or empty | `project open` | Written by the open command. |
| `lastActivityAt` | ISO time or empty | derived | The newest of: status `updated`, last commit time, last worker run end, last Owner Mailbox answer for the slug. A cache. The service refreshes it every 10 minutes. |
| `nextAction` | string, up to 200 characters | Owner | The Owner's note. When empty, the page shows the `ask` or the title of the status task with `frontier: current`. |
| `notes` | string, up to 2000 characters | Owner | Free text. |
| `createdAt` | ISO time | import | |

The Owner edits the fields `title`, `group`, `factory`, `pinned`, `priority`, `issueSource`, `autoOpen`, `nextAction`, and `notes`. The commands change `state`, `lastOpenedAt`, and `lastActivityAt`.

### 2.3 Import

`project register import` reads the three sources and writes one record for each slug that the register lacks. It never changes an existing record.

1. Read `project-repos.json`: `slug`, `repo`, `remote`.
2. Read the policy entries: slugs that have no row yet.
3. Read `projects/*.json`: `title` from `project`, `lastActivityAt` from `updated`.
4. Ask Herdr for the open workspaces. A project with a workspace gets `state: open`. Every other project gets `state: parked`.
5. Print one line for each new record and a count. `--dry-run` prints the same lines and writes nothing.

Import uses the factory name of the local factory. The Owner changes it for a project that another factory runs.

### 2.4 The 50 projects that Herdr does not know

Many projects exist only as folders. `project scan DIR` lists the Git repositories under `DIR` (default depth 2) and proposes a record for each one that the register lacks. It reads `git remote get-url origin` and the folder name. It writes nothing unless `--add` is set. It prints no remote URL that holds credentials. Section 13, row D9 asks where these folders are.

## 3. States and transitions

```
 (import / scan / add)
          |
          v
      parked <----- park ------ open
          |  \                    ^
          |   \-- archive --> archived
          |                      |
          +-------- open --------+  (unarchive first: archived -> parked)
```

| From | To | Command | Condition |
|---|---|---|---|
| none | parked | `register add`, `import`, `scan --add` | Slug is valid and new. |
| parked | open | `project open SLUG` | Section 4. |
| open | parked | `project park SLUG` | Section 5. |
| parked | archived | `project archive SLUG` | Always allowed. |
| archived | parked | `project unarchive SLUG` | Always allowed. |

An archived project cannot open. The Owner unarchives it first. This prevents an accidental open from a bulk select.

## 4. Open: parked to open

`herdr-boss project open SLUG [--dry-run] [--start]` and the **Open** button run the same code.

The command runs the steps of `project check --fix` in a fixed order. It runs only the steps that the check reports as missing, and it never runs a step twice.

1. Take the project lock, so two opens or an open and a park cannot run together. A second caller exits with a message.
2. Refuse if the state is `archived`, if the project has a transfer lock, or if the cap forbids it (section 6.2). `--force` overrides only the cap.
3. Run `project check SLUG`. Print the result.
4. Fix `folder` and `kit`. The kit is current and the SessionStart hook is present.
5. Fix `policy` and `register`. The policy entry and the repository row exist.
6. Fix `workspace`. The command creates the Herdr workspace and starts the project lead in the pane `orch`. This step uses model quota, so `open` runs it only with `--start`. The button sets `--start`.
7. The project lead starts fresh. Its first prompt tells it to read `docs/orchestration/herdr-boss.md`, `docs/orchestration/memory.md`, and the published status `projects/SLUG.json`. These are the same inputs as the fresh-start bootstrap in [handover.md](../reference/handover.md). The previous conversation is not restored.
8. Fix `harness` (the check step for the agent app). The step reserves the project browser (`browser request SLUG --reserve`). It starts no browser.
9. Serve ports are not leased at open. The project lead or a worker leases a port on demand with `lease acquire serve-ports`.
10. Set `state: open` and `lastOpenedAt`. Write the audit line (section 9).
11. Print the next action of the project.

What the Owner sees after open: the project is in the Overview and on the board again. Its Mailbox items were never hidden. Its Herdr workspace is in the sidebar.

Failure: a failed step leaves the state `parked`. The command prints the failed step and the `--fix` command that repairs it. A second `project open SLUG` continues, because each step is idempotent.

## 5. Park: open to parked

`herdr-boss project park SLUG [--dry-run] [--prepare]` and the **Park** button run the same code. The park checks have no override.

A park is not a pause. A pause keeps the panes. A park closes them.

### 5.1 Checks

The command runs all checks and prints one line for each. It stops with exit code 1 if one check fails. It changes nothing before every check passes.

| Id | Passes when | Source |
|---|---|---|
| `workers` | No worker of the project has a live run record, and no pane of the workspace holds an agent with status `working`. | `runs/` folder, `herdr agent list` |
| `prompt` | No pane of the workspace waits for a permission prompt or an answer (agent status `blocked`). | `herdr agent list` |
| `git` | The main checkout has no uncommitted change, and no commit that is not on the upstream. | `git status --porcelain`, `git log @{u}..` |
| `locks` | The project holds no lock lane ticket, no `full-suite` lock, and no lease in any pool. | `lock list`, `lease list` |
| `status` | The status is published, and its `updated` time is later than the last commit and the last worker end. | `projects/SLUG.json` |
| `memory` | `docs/orchestration/memory.md` has no uncommitted change, and its last commit is not older than the last worker end. | `git log -1` |
| `owner` | No status task has `waitingOn: owner` with a `mailboxId` that is still unanswered and blocks. | status, Mailbox |

A Mailbox item that does not block stays in the Mailbox. It stays visible after the park. Its card shows the chip `parked`.

### 5.2 Prepare

`--prepare` and the button **Prepare and park** do this first, when `git`, `status`, or `memory` fails:

1. Send the project lead one prompt, without `--wait`: commit and push with its own rules, update `memory.md`, run `herdr-boss publish SLUG FILE --sync`.
2. Wait up to 10 minutes for the project lead to become idle. The wait is the same as `goal set`.
3. Run all checks again.
4. If a check still fails, stop and print it. If the wait ends, add one Mailbox item with the reason.

`--prepare` never sends a prompt to a pane that has a running worker or a pending prompt.

### 5.3 Close

After all checks pass:

1. Take the project lock.
2. Write the audit line `park-start`.
3. Release the browser reservation (`browser release SLUG`). It refuses while the project Chrome runs, so the command first stops the Chrome that this project started. It never stops a browser that it did not start.
4. Release each remaining lease of the project.
5. Close the Herdr workspace with `herdr workspace close <id>`. This closes its panes.
6. Set `state: parked` and `pinned: false`.
7. Write the audit line `park-done`.

All state stays: the repository, the policy entry, the published status, the Mailbox items, the review packs, and the data files.

Failure: if step 3 or 4 fails, the project stays open and the command prints the cause. If step 5 fails after step 3 and step 4, the state stays `open` and a second `project park SLUG` finishes the close.

The Boss workspace is not in the register. No command in this note closes it.

## 6. Auto rules

All auto rules are off by default. Each rule is a Setting in the Settings page, in a new group **Project register**. The setting key is in the table. The docs list each setting with the standard columns of [settings.md](../reference/settings.md): default, unit, range, effect of a higher value, effect of a lower value, and how to apply it.

| Setting | Key | Default | Range |
|---|---|---|---|
| Auto-park idle projects | `register.autoPark.enabled` | Off | On or off |
| Idle hours before auto-park | `register.autoPark.idleHours` | 24 | 1 to 720 |
| Cap on open projects | `register.cap` | 3 | 1 to 20 |
| Pinned projects count toward the cap | `register.capCountsPinned` | On | On or off |
| Auto-open from triage | `register.triage.enabled` | Off | On or off |
| Triage label | `register.triage.label` | `ready-for-agent` | A GitHub label name |
| Triage poll interval | `register.triage.pollMinutes` | 30 | 5 to 1440 |
| First auto-open mode | `register.triage.mode` | `mailbox` | `mailbox` or `automatic` |

### 6.1 Auto-park

The service checks every open project each tick when `register.autoPark.enabled` is on. A project is idle when its `lastActivityAt` is older than `idleHours`. Then the service runs the park checks of section 5.1.

- If all checks pass, the service parks the project and writes the audit line with `by: auto`.
- If a check fails, the service parks nothing. It does not send a prompt. It records the failed check on the page row (`park blocked: git`).
- A pinned project is never auto-parked.
- The service does not run `--prepare`. Only the Owner asks for a prepare.

### 6.2 Cap

`register.cap` limits the number of open projects. A pinned project counts when `register.capCountsPinned` is on.

- `project open` at the cap exits with code 1 and lists the open projects. The Owner parks one, or uses `--force`.
- The **Open** button at the cap shows the list of open projects, each with a **Park** button.
- The cap never closes a project. It only refuses a new open.
- The pin is a focus mark. The page shows pinned projects first, in a strip of 1 to 3 cards. A fourth pin is refused with a message.

### 6.3 Auto-open from triage

A scheduler reads the issues that the Owner triaged and proposes work. The scheduler is the Boss of a factory, or the service when the factory has no Boss. See section 8.

For each registered project with `issueSource`, every `pollMinutes`:

1. Run `gh issue list --repo REPO --label LABEL --state open --json number,title --limit 100`. The call is read-only.
2. Count the issues. Ignore a project whose state is `open` or `archived`.
3. Sort the projects that have issues by `priority`, then by the oldest issue.
4. For the first project, if a slot is free (cap not reached), propose to open it.

In mode `mailbox`, the proposal is one Mailbox item: `Open project acme-web? 3 ready issues`. The item has the buttons **Accept** and **Deny**.

- **Accept** runs `project open acme-web --start`.
- **Deny** closes the item. The scheduler does not propose the same project again for 24 hours.
- The scheduler never posts a second open item for the same project while one is unanswered.

The mode `automatic` is a per-project override: the record field `autoOpen: on`. Only then does the scheduler open the project without Accept. The Owner turns it on for one project at a time. The global setting `register.triage.mode: automatic` is not offered in the first version.

The scheduler uses `gh` with the login of the Owner on that host. It never prints a token. If `gh` is not signed in, it posts one Mailbox item with the sign-in command, and it stops. It does not retry until the Owner answers.

## 7. Herdr clutter

Herdr (`herdr workspace --help`) gives these commands for a workspace: `list`, `create`, `get`, `focus`, `rename`, `report-metadata`, `close`. The default configuration has only a sidebar collapse for the whole sidebar (`sidebar_start_collapsed`).

| Herdr offer | Hides one workspace? | Use |
|---|---|---|
| `workspace close` | Yes. The workspace and its panes leave the sidebar. | Used by park. |
| `workspace rename` | No. | Not used. |
| `workspace report-metadata` | No. It sets display-only tokens. | Not used to hide. |
| sidebar collapse | No. It collapses the whole sidebar. | Not used. |
| per-workspace hide or collapse | Not offered. | Not available. |

Herdr has no least destructive option other than close. The design uses `workspace close` and keeps everything outside Herdr:

- What close removes: the shell panes and the agent conversation of the project lead.
- What stays: the repository, `docs/orchestration/memory.md`, the published status, the Mailbox, the policy entry, and the review packs.
- The next open starts a fresh project lead from those files (section 4, step 7).

Rules for close:

1. Never close a workspace with a running worker. Check `workers` (section 5.1).
2. Never close a workspace with an unanswered permission prompt or a pane that waits for input. Check `prompt`.
3. Never close the Boss workspace.
4. Close the workspace by the id that the register or `project-repos.json` records. Never match by label alone.

Open question for Herdr: a per-workspace hide in the sidebar would let Herdr Boss keep the panes. Until then, park closes.

## 8. Factories

- The register record has a `factory` field. A factory Boss may run the triage watcher for the projects of that factory.
- Each factory keeps its own register in its own data dir. A factory does not read another register.
- Head office view: each factory adds two numbers to its fleet summary: `projects.open` and `projects.parked`. It adds no slug and no title, because the fleet summary is an allow-listed document (see [factories.md](../specs/factories.md)).
- The Fleet page shows one row for each factory with `open 2 · parked 14 · cap 3`.
- The Fleet page opens the register of a factory only on that factory. A link goes to that factory's Projects page.
- Transfer of a project between factories stays with ticket 20 (`project transfer`). The register does not move a record. After a transfer, the source sets `state: archived` and the target adds a record.

## 9. Safety

- The register stores no secret. The writer refuses a value that matches the secret scan.
- The register file and the audit file stay in the data dir. They are never committed. Docs, tests, fixtures, and this note use only invented projects.
- Every park and open writes one line to `project-audit.jsonl` in the data dir, mode `0600`. A line is `{ at, slug, action, by, result, failedCheck, dryRun }`. `action` is `open`, `park`, `archive`, `unarchive`, `register-add`, or `register-edit`. `by` is `owner-cli`, `owner-page`, `auto-park`, or `auto-open`. The line holds no path and no remote.
- Every command that changes state accepts `--dry-run`. A dry run prints each step and each check and changes nothing. It writes no audit line and takes no lock.
- The Projects page buttons call the same API routes as the commands. The read-only preview shows the page and disables all buttons.
- A worker pane cannot run `project open`, `project park`, or `register` commands. This is the pane check of `project new`.

## 10. Resource effect

A parked project has no worker slots, no browser, no port, and no lease.

- The Allocation view counts only open projects in **Project shares**. A parked project is not a row in the bar.
- The stored share of a parked project stays in `policy.json`. It is not counted until the project opens again.
- The effective share of an open project is its stored share divided by the sum of the stored shares of the open projects, times 100.
- Example, with invented numbers. Four projects have shares 30, 30, 20, and 20. When two park, the open projects `acme-web` (30) and `orchard-api` (20) hold 60 percent and 40 percent of the worker limit.
- Idle lending still applies among the open projects.
- The Allocation view shows a line below the bar: `14 parked projects use no slots.` A **Show parked** link lists them with their stored share.

This needs one code change in the share computation: skip a project whose register state is not `open`. A project that has no register record counts as open, so the change is safe before the import.

## 11. Dashboard

### 11.1 Projects page

The existing Projects page keeps its **New project** button. The register adds these parts above and below the list (see the wireframe):

- A toolbar with: a search field, a **Group** filter, a **State** filter, a **Sort** menu (last activity, priority, title), and the buttons **Open**, **Park**, **Archive** for the selected rows.
- A focus strip with the pinned projects, 1 to 3 cards. Each card shows title, group, next action, and the age of the last activity.
- A list of open projects. Each row has a checkbox, a pin, title, group, factory, priority, next action, last activity, and a row action **Park**.
- A fold **Parked (47)**. It is collapsed by default. It shows the count and the groups. An open fold shows the parked rows, with the row action **Open**.
- A fold **Archived (6)**. It is collapsed by default and hidden when it is empty.
- The page remembers the filters and the folds per browser.
- On a phone (393 px), a row becomes a card with the title, the group chip, and the next action. The toolbar becomes a search field and a **Filter** sheet. The bulk actions move to a bar at the bottom while rows are selected.

A bulk **Park** of several projects runs the park checks for each one. The page shows a result for each project and parks only those that pass.

### 11.2 Settings and help

- The group **Project register** in Settings holds the settings of section 6. Each setting has help text in `public/setting-help.js`.
- The `HELP` text of the Projects page covers the register, the fold, the pin, the cap, open, and park.

### 11.3 Commands

| Command | Purpose |
|---|---|
| `project register list [--state S] [--group G] [--json]` | List records. |
| `project register add SLUG [--title T --group G --repo PATH ...]` | Add a record. |
| `project register edit SLUG [--field value ...]` | Change the Owner fields. |
| `project register import [--dry-run]` | Section 2.3. |
| `project register sync [--dry-run]` | Copy `repo` and `remote` from `project-repos.json`. |
| `project scan DIR [--depth N] [--add] [--dry-run]` | Section 2.4. |
| `project open SLUG [--start] [--force] [--dry-run]` | Section 4. |
| `project park SLUG [--prepare] [--dry-run]` | Section 5. |
| `project archive SLUG`, `project unarchive SLUG` | Section 3. |
| `project pin SLUG`, `project unpin SLUG` | Section 6.2. |

## 12. Slices for the build

The build starts after the Owner answers the Decisions table. Each slice has its own worker, its own tests with fake projects, and its own docs change. The slice order is the dependency order. S3, S4, S6, and S7 can run in parallel when their dependencies are done.

| Slice | Content | Worker kind | Depends on |
|---|---|---|---|
| S1 | Register store, schema, import, `register list/add/edit/sync`, `project scan`, audit file. | opencode-go | none |
| S2 | `project open`, `project park`, `archive`, `unarchive`, `--dry-run`, park checks, `--prepare`. Fake Herdr and fake `gh` in tests. | Codex | S1 |
| S3 | Projects page: toolbar, focus strip, folds, bulk select, open and park buttons, phone layout. | opencode-go | S1, S2 API |
| S4 | Settings group **Project register**, auto-park, cap, pin. | opencode-go | S2 |
| S5 | Triage watcher, Mailbox proposal with Accept and Deny, per-project `autoOpen`. Fake `gh`. | Codex | S4 |
| S6 | Allocation: skip parked projects in the share computation and show the effect. | opencode-go | S1 |
| S7 | Fleet: fleet summary counts and the factory rows. | opencode-go | S1 |
| S8 | Docs gate: user guide chapter "Working on 3 of 50 projects", CLI reference, settings reference, page help. | opencode-go | S2 to S7 |
| S9 | Review of each slice. | Sonnet | each slice |

Constraints: at most 2 Sonnet workers run at once. Opus runs only as the final judge of a pack. Codex use stays near 14 points a day, so S2 and S5 are the only Codex slices. The license rule and the host rule apply to every slice.

## 13. Decisions for the Owner

Each row is one decision. Write `accept` or `deny` for each row. A `deny` ends that part of the build, or the Owner gives another value in the note column.

| Id | Decision | Recommendation | Accept | Deny |
|---|---|---|---|---|
| D1 | Default cap on open projects is 3. A pinned project counts toward the cap. | Accept. | [ ] | [ ] |
| D2 | Auto-park idle hours default is 24, and auto-park is off by default. | Accept. | [ ] | [ ] |
| D3 | The triage label name is `ready-for-agent`, as in the `triage` label preset. | Accept. | [ ] | [ ] |
| D4 | The first auto-open mode is Mailbox with Accept. No auto-open without Accept, unless the Owner sets `autoOpen: on` for one project. | Accept. | [ ] | [ ] |
| D5 | Groups are by client first. A project that has no client uses an area name as its group. | Accept. | [ ] | [ ] |
| D6 | The register is one file in the data dir, `project-register.json`, with mode `0600`. It is never in a repository. | Accept. | [ ] | [ ] |
| D7 | Park uses `herdr workspace close`, because Herdr offers no per-workspace hide. The next open starts a fresh project lead from `memory.md` and the published status. | Accept. | [ ] | [ ] |
| D8 | Park has no override for its checks. `--prepare` asks the project lead to commit, push, update memory, and publish first. | Accept. | [ ] | [ ] |
| D9 | `project scan DIR` is built to list the Git repositories in a folder. The Owner names the folders to scan. | Accept, and name the folders. | [ ] | [ ] |
| D10 | An archived project cannot open until it is unarchived. | Accept. | [ ] | [ ] |
| D11 | The Allocation view counts only open projects. Parked projects keep their stored share but use no slots. | Accept. | [ ] | [ ] |
| D12 | Each factory keeps its own register. The fleet summary carries only the counts `open` and `parked`. | Accept. | [ ] | [ ] |
| D13 | The build order and workers of section 12. | Accept. | [ ] | [ ] |
