# UP1 design note: keep agents and tools up to date

Status: design only. This note holds no product code. Step 2 starts after the Owner accepts the decisions in the last section.

Scope: the inventory of tools on the Mac and in the factories, the update policies, the Fleet Updates card, and the commands `herdr-boss tools check` and `herdr-boss tools bump`.

## Terms

Each term has one meaning in this note.

- **Tool**: a program that Herdr Boss or a worker runs. The tools are listed in section 1.
- **Pin**: a value in `factory/pins.json`. It is a version, an image tag with a digest, or the apt version string of `chromium`. A SHA-256 hash exists only for the five artifacts that the image downloads directly (see section 4).
- **Installed**: the version that a running host or image reports.
- **Latest**: the newest stable version at the upstream source named in section 1.
- **Late**: the number of days since the release date of the first version newer than the installed version.
- **Canary**: the factory `win1`. It receives a bump first.
- **Bump**: change a pin in `factory/pins.json` and roll the change out to a factory.
- **Upgrade**: change a tool on the Mac. The word applies to the Mac only.
- **Roll back**: return a factory to its previous image. A **rollback** is the act of that return.
- **Promote**: build the image of a verified bump on each other factory and run `factory update --tier image` there.
- **Drain**: wait until no worker runs in a factory.
- **Change set**: all pin changes that one `tools bump` branch holds.

## Facts and gaps

All values below were read on 2026-10-06. No secret was read.

- The Mac tools report their version with `--version`. Versions of the latest release come from the public sources in section 1.
- The factory image installs the harness CLIs with `npm install -g` at an exact version. Source: `factory/Dockerfile`.
- The image sets `DISABLE_AUTOUPDATER=1` and `OPENCODE_DISABLE_AUTOUPDATE=true`. A harness in a factory changes only with an image rebuild. Source: `factory/Dockerfile`.
- `docs/specs/factories.md` lists a canary factory and automatic promotion as out of scope for the factory plan. UP1 adds them.
- `pi` is not in `pins.json` and not in the image. `codexbar` is not in `pins.json` yet. The Owner task says it will be.

Four facts are not verified. Step 2, slice 1 verifies them before it writes code.

- How each Mac tool was installed (brew, npm, or its own installer) and whether it updates itself. Only `herdr`, `gh`, `node`, and `opencode` are known to have a brew formula.
- Whether the Mac `claude` and `codex` read a setting that turns their update check off.
- Which of the two `opencode` lines is current. The Mac runs v2.0.20 from brew. The npm package `opencode-ai` and the image pin are on 1.x. The check must not compare the two lines.
- The exact name of the checksum file of each upstream release, for the tools that publish one. Section 4 gives the fallback.

## 1. Inventory

### Where each tool runs

| Tool | Mac | Factory image | Factory home volume |
|---|---|---|---|
| claude | yes | yes (npm) | login only |
| codex | yes | yes (npm) | login only |
| opencode | yes | yes (npm) | login only |
| pi | yes | no | no |
| herdr | yes | yes (binary) | no |
| codexbar | yes | planned (Linux CLI) | no |
| gh | yes | yes (binary) | login only |
| node | yes | yes (tarball) | no |
| s6-overlay | no | yes (tarball) | no |
| chromium | no | yes (apt) | no |

The home volume holds logins and settings. It holds no tool binary. A tool changes only with an image rebuild (tier `image`).

### Versions and sources

The Installed column is the Mac value. The Pinned column is the value in `factory/pins.json`.

| Tool | Installed (Mac) | Pinned | Latest on 2026-10-06 | Source of truth for latest | License |
|---|---|---|---|---|---|
| claude | 2.1.291 | 2.1.288 | 2.1.292 (`latest`), 2.1.285 (`stable`) | `npm view @anthropic-ai/claude-code dist-tags` | Proprietary (npm field: "SEE LICENSE IN README.md") |
| codex | 0.160.1 | 0.160.0 | 0.160.1 | `npm view @openai/codex version` | Apache-2.0 |
| opencode | 2.0.20 (brew) | 1.18.34 | 1.18.35 on npm and GitHub | `gh api repos/sst/opencode/releases/latest` and `npm view opencode-ai version` | MIT |
| pi | 1.0.0 | not pinned | 1.0.4 | `npm view @earendil-works/pi-coding-agent version` | MIT |
| herdr | 0.9.3 | 0.9.3 | 0.9.3 | `gh api repos/ogulcancelik/herdr/releases/latest` | Apache-2.0 |
| codexbar | 0.72.0 | not pinned | 0.72.0 | `gh api repos/steipete/CodexBar/releases/latest` | MIT |
| gh | 2.102.0 | 2.102.0 | 2.102.0 | `gh api repos/cli/cli/releases/latest` | MIT |
| node | 26.10.0 | 26.10.0 | 26.10.0 | `gh api repos/nodejs/node/releases/latest` | MIT |
| s6-overlay | n/a | 3.2.3.2 | 3.2.3.2 | `gh api repos/just-containers/s6-overlay/releases/latest` | ISC |
| chromium | n/a | 154.0.8037.92-1~deb13u1 (apt version string, no hash) | not checked | `apt-cache policy chromium` inside the image, and the Debian security tracker | BSD-3-Clause |
| base image (debian) | n/a | `debian:trixie-slim` at digest `sha256:a99cfc51...1b20a` | digest not checked | `docker buildx imagetools inspect debian:trixie-slim` (registry digest), and the Debian security tracker | Debian free software licenses (per package) |
| buildkit | n/a | `moby/buildkit:buildx-stable-1` (rolling tag, no digest) | v0.33.1 released 2026-09-30 | `gh api repos/moby/buildkit/releases/latest`, and the registry digest of the pinned tag | Apache-2.0 |

Observations:

- The `claude` `stable` tag (2.1.285) is older than the pin (2.1.288). The `latest` tag (2.1.292) is newer. The policy in section 2 must say which tag the check follows.
- `codex` and `opencode` on the Mac are one or more versions ahead of the pins, or on another release line. The Updates card shows the Mac and the pin as separate columns.
- The `buildkit` pin is a rolling tag. `tools check` cannot read a version from it. It compares the registry digest of the tag with the last digest that it recorded, and it shows the release tag as information only.
- The latest release of a GitHub tool is the `releases/latest` entry. It excludes drafts and pre-releases.
- `herdr` assets include `herdr-macos-aarch64`. `codexbar` assets include `CodexBarCLI-v<version>-linux-<arch>.tar.gz` and a `.sha256` file for each archive.

### How each tool updates itself

| Tool | Mac | Factory |
|---|---|---|
| claude | Not verified (gap 2) | Off (`DISABLE_AUTOUPDATER=1`) |
| codex | Not verified (gap 2) | Off in practice: the binary sits in a root-owned npm prefix and nothing writes it |
| opencode | brew formula, so `brew upgrade`. Its own update check: not verified | Off (`OPENCODE_DISABLE_AUTOUPDATE=true`) |
| pi | Not verified (gap 1) | Not installed |
| herdr | brew formula | Not self-updating |
| codexbar | Not verified (gap 1) | Not self-updating |
| gh | brew formula | No self-update |
| node | brew formula | No self-update |

The Mac column is the weakest part of the inventory. `tools check` reads the Installed value from `--version` and never assumes a mechanism.

## 2. Policy options

Each policy has two options. The recommendation is marked. Each policy has one accept item and one deny item for the Owner pack.

### P1: harness CLIs (claude, codex, opencode, pi)

- **Option A (recommended):** Track the latest stable release. A bump goes to the canary first. "Stable" means the `stable` dist-tag for `claude`, the `latest` tag for the others. A bump for a version less than 3 days old waits. A bump never moves a pin to an older version. When the followed tag is older than the pin, the check keeps the pin and shows the row as `ok`. Today this applies to `claude`: the `stable` tag (2.1.285) is older than the pin (2.1.288).
- **Option B:** Pin each harness and bump only by a reviewed change on request. No weekly check of the harnesses.

Reason for A: a harness changes its flags and its login format often. A stale harness fails against its provider. The canary run catches a break before the other factories receive it.

- Accept item: "P1: Track the latest stable harness release. Bump the canary first."
- Deny item: "P1: Pin the harnesses. Bump only on request."

### P2: infrastructure (herdr, s6-overlay, node, gh, codexbar, chromium)

- **Option A (recommended):** Pin each tool and verify each downloaded artifact with a SHA-256 hash. A bump is a reviewed change that `tools bump` prepares on a branch. The Owner merges it.
- **Option B:** Treat these tools as P1: latest stable, canary first, no review.

Reason for A: a change in `herdr`, `s6-overlay`, or `node` changes the base of every worker. A person must read the release notes before the bump.

- Accept item: "P2: Pin the infrastructure tools. Verify each download by hash. Bump by a reviewed branch."
- Deny item: "P2: Bump the infrastructure tools like the harnesses."

### P3: security releases

- **Option A (recommended):** A release that fixes a security issue is flagged first. The flag shows in the Updates card and in one Mailbox item. The release skips the 3-day wait of P1. It still goes to the canary first.
- **Option B:** No separate rule. A security release follows P1 or P2.

The source of a security flag is one of: a GitHub security advisory of the upstream repository (`gh api repos/<owner>/<repo>/security-advisories`), the word "security" or a CVE id in the release notes, or the Debian security tracker for `chromium`. The check never decides a fix is a security release without one of these. When a source is unclear, the card shows "unknown" and not "no".

- Accept item: "P3: Flag security releases first. Skip the waiting time."
- Deny item: "P3: Treat a security release like any other release."

### P4: rollout order and drain

- **Option A (recommended):**
  1. The check runs weekly.
  2. The canary (`win1`) gets a bump first. It runs the smoke project and the reader checks (`factory/smoke-test.sh` and the factory reader checks).
  3. The Owner promotes with one click to the other factories.
  4. The tool never updates a factory while a worker runs in it. It drains or waits.
  5. The previous image stays for rollback.
- **Option B:** Roll a bump out to all factories at the same time after the smoke test passes.

Reason for A: the factories hold live work. One verified run on the canary costs one day and removes the fleet-wide failure.

- Accept item: "P4: Weekly check. Canary first. One-click promote. Drain before an update. Keep the previous image."
- Deny item: "P4: Roll a bump out to all factories together."

### P5: the Mac tools

- **Option A (recommended):** Show the outdated Mac tools. Never run `brew upgrade`, `npm update`, or an installer without the Owner's click. The click runs one command for one tool and shows its output.
- **Option B:** Show only. The Owner types every upgrade command.

Reason for A: the Mac is the head office. An upgrade of `node`, `herdr`, or `claude` on the Mac can stop the running orchestrators.

- Accept item: "P5: Show outdated Mac tools. Upgrade only after a click, one tool at a time."
- Deny item: "P5: Show outdated Mac tools. Never run an upgrade command."

### P6: notices

- **Option A (recommended):** One Mailbox item (kind read) per week, only when a tool is more than 14 days late or a security release exists. One item per change set. A new release of a tool already in an open item updates that item.
- **Option B:** No Mailbox item. The Updates card and `doctor` show the state.

- Accept item: "P6: One weekly Mailbox item, only when a tool is more than 14 days late or a security release exists."
- Deny item: "P6: No Mailbox item for tool updates."

## 3. Where the state shows

### Fleet Updates card

One table with one row for each tool. Columns:

| Column | Content |
|---|---|
| Tool | Name |
| Installed | Mac version and, in a second line, the version in each factory |
| Pinned | Value in `pins.json`, or "none" |
| Latest | Version at the upstream source |
| Age | Days since the release date of the first newer version. Empty when the tool is current |
| Risk | `ok`, `late` (more than 14 days), `security`, or `unknown` |

A row shows an action. For a factory tool the action is "Bump" (P2) or "Promote" (P4). For a Mac tool the action is "Upgrade" with a confirm step (P5).

The rows in the wireframes are examples. They are not the current values.

Desktop wireframe (1280 px):

```
Updates                                          checked 2026-10-06 08:00   [Check now]
-----------------------------------------------------------------------------------------
Tool       Installed            Pinned   Latest   Age   Risk       Action
claude     2.1.291 | win1 2.1.288 2.1.288  2.1.292   4 d   ok         [Bump]
codex      0.160.1 | win1 0.160.0 0.160.0  0.160.1   2 d   ok         [Bump]
opencode   2.0.20  | win1 1.18.34 1.18.34  1.18.35   0 d   ok         [Bump]
pi         1.0.0                  none     1.0.4    12 d  ok         [Upgrade]
herdr      0.9.3   | win1 0.9.3   0.9.3    0.9.3    -     ok
node       26.10.0 | win1 26.10.0 26.10.0  26.10.0   -     ok
-----------------------------------------------------------------------------------------
Canary win1: bump set "2026-10-06-a" smoke passed        [Promote to win2]  [Roll back]
```

Phone wireframe (393 px). Each tool is one card. The columns become labeled lines. The action stays at the bottom of the card.

```
Updates          [Check now]
checked 2026-10-06 08:00
+----------------------------+
| claude          ok         |
| Installed  2.1.291         |
| Pinned     2.1.288         |
| Latest     2.1.292  (4 d)  |
| [Bump]                     |
+----------------------------+
| pi              ok         |
| Installed  1.0.0           |
| Pinned     none            |
| Latest     1.0.4  (12 d)   |
| [Upgrade]                  |
+----------------------------+
| Canary win1                |
| set 2026-10-06-a           |
| smoke passed               |
| [Promote to win2]          |
| [Roll back]                |
+----------------------------+
```

### Other places

- **Factory card badge**: the factory card shows `updates 2` when its image tag differs from the tag of the pins on `main`, and `security` when a security release is open. A click opens the Updates card filtered to that factory.
- **`herdr-boss doctor`**: one line for each tool that is `late` or has a `security` release. The line names the tool, the Installed and Latest values, and the age. `doctor` exits with 0 or 4 only (`src/doctor.js:321`). A `security` item is a failed check and makes the exit code 4. A `late` item is a note and leaves the exit code at 0.
- **Mailbox**: see P6.

## 4. Mechanics

### `herdr-boss tools check`

- Read-only. It reads the installed version, `pins.json`, and the upstream source for each tool.
- It writes `~/.herdr-boss/tools-state.json` with the result and the check time. The Updates card reads this file.
- It sends no secret. Calls to GitHub use the existing `gh` login. Calls to npm are anonymous. The output never prints a token or a header value.
- A failed upstream call marks that tool `unknown` and keeps the previous Latest value. It never marks a tool `ok` by default.
- The weekly run is a scheduled job of the service. `tools check --now` runs it by hand.

### `herdr-boss tools bump TOOL`

1. Refuse when the working tree is not clean or the tool is not in `pins.json`.
2. Create the branch `tools/<tool>-<version>`.
3. Download each artifact of the new version.
4. Take the hash from the release checksum file. When the release has none, compute the hash after the download and record it.
5. Write the new version in `factory/pins.json`. Write the hash for each artifact that has one (see the hash rule).
6. Print a diff and the release notes URL. Do not commit and do not merge.

The Owner or the orchestrator reviews and merges the branch. A merge to `main` does not roll anything out.

### Hash rule

Today `pins.json` holds a SHA-256 hash only for the artifacts that the image downloads directly: `s6-overlay`, `node`, `gh`, and `herdr` (the `sha256` map, lines 21 to 31). The Dockerfile checks each of them. The npm harnesses, `codexbar`, `chromium`, the base image, and `buildkit` have no hash today. `chromium` pins the apt version string. The base image pins a digest.

Step 2 adds the following. None of it exists now.

- A schema bump of `pins.json` (`schema` 2) that holds the hash and the mark of each pinned artifact.
- A hash for the npm harnesses. The value is `dist.integrity` from the registry metadata.
- A hash for the `codexbar` Linux CLI archive, when it enters `pins.json`.
- The rule: a download whose hash differs from the pin is refused and the build stops.
- The marks. A hash that `tools bump` computed after a download is marked `computed`. A hash from a release checksum file is marked `published`. The review shows the mark.

### Rollout

The image tag is the SHA-256 of `factory/pins.json` (`src/factory-core.js:13`). `factory update` has no image flag. It computes the tag from the `pins.json` of the checkout that runs it, and it refuses when the image is missing (`src/factory-update.js:556-558`).

Steps for one factory:

1. Run `herdr-boss factory build <factory>`. It builds the image for the current `pins.json` on that factory.
2. Run `herdr-boss factory update <factory> --tier image`.

The update follows the window rules in `docs/specs/factories.md`. It refuses while a worker works, a suite or push holds the lock, or a handover is prepared. FT15 provides the command. Step 2 adds a `--wait` mode that drains and retries.

#### How the canary gets a different image

Two factories on one `pins.json` get one tag. The canary needs the new tag while the other factories keep the old one. There are three options.

- **Option 1 (recommended): per-factory rollout from `main`.** The bump branch is reviewed and merged to `main`. The merge rolls nothing out. Then the Owner or the tool runs steps 1 and 2 on `win1` only. The other factories keep their old image, because `update` runs only for a named factory. A factory card shows the badge `updates` while its image tag differs from the tag of `main`. If the canary fails, revert the merge and roll `win1` back. This option needs no change to the tag rule or to `factory update`.
- **Option 2: image flag.** Add `--pins <file>` to `factory build` and `factory update`, so the canary runs the branch `pins.json` before the merge. This option changes the tag rule and the command, and the stored `pinsHash` must follow the file.
- **Option 3: canary checkout.** `win1` runs a checkout of the bump branch. This breaks `factory update --tier service`, which merges `main` fast-forward only.

Reason for option 1: it uses the existing commands and the existing per-factory state. The cost is one revert commit when a canary fails.

#### Promote

Promote means: for each other factory the Owner selects, run `factory build <factory>`, then `factory update <factory> --tier image`. The tool runs one factory at a time and stops at the first failure. `herdr-boss factory promote <set>` is the one-click action of the card.

A change set is promoted only after the canary passes the smoke project and the reader checks. The result is stored with the set.

#### Health check and rollback

- A backup runs before the update.
- After the restart, one clean tick must pass and `/api/health` must answer within 30 seconds (`src/factory-update.js:371-377,409`). If not, the update rolls back.
- Step 2 requirement: the host keeps the previous image until the next successful update. The current code does not guarantee this. Step 2 checks it and adds it when it is missing.

### Mac tools

- `tools check` lists the outdated Mac tools. It runs no upgrade.
- The Upgrade action in the card shows the exact command (for example `brew upgrade herdr`), asks for a confirm, runs it once, and shows the output. It refuses when a worker runs on the Mac and the tool is `herdr`, `node`, or a harness that a running worker uses.

## 5. Step 2 slices

Step 2 builds on `opencode-go` and `pi`, with a fake upstream and a fake transport. Each slice runs a docs gate.

1. Verify the four gaps in "Facts and gaps".
2. `tools check` with a fake upstream, the state file, and `doctor` lines.
3. Updates card, factory badge, and phone layout.
4. `tools bump` with a fake download and the hash rule.
5. Mailbox rule (P6) with the one-item-per-change-set test.
6. `factory update --tier image` drain mode, canary run, `factory promote`, and the previous-image requirement.
7. Mac Upgrade action with the confirm step.

## Decisions for the Owner

The Owner answers each item with Accept or Deny. A denied item names the option to build instead.

| Id | Accept item | Deny item |
|---|---|---|
| P1 | Track the latest stable harness release. Bump the canary first. | Pin the harnesses. Bump only on request. |
| P2 | Pin the infrastructure tools with a hash. Bump by a reviewed branch. | Update the infrastructure tools like the harnesses. |
| P3 | Flag security releases first. Skip the waiting time. | Treat a security release like any other release. |
| P4 | Weekly check. Canary first. One-click promote. Drain before an update. Keep the previous version. | Roll a bump out to all factories together. |
| P5 | Show outdated Mac tools. Upgrade only after a click, one tool at a time. | Show outdated Mac tools. Never run an upgrade command. |
| P6 | One weekly Mailbox item, only when a tool is more than 14 days late or a security release exists. | No Mailbox item for tool updates. |
